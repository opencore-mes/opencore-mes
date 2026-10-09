// One suite taken out and put back, fresh, on a development database (SUITES.md, "Develop a suite"): what a suite's
// author does between edits to its design pack, without resetting the rest of the database. Its open changes are
// withdrawn; its records archived (the MES deletes nothing: archived, audited and resealed as the platform's, so the
// integrity review finds nothing removed) and its plans' runs stopped; its designs that differ from the pack's are published as
// their next versions, as an executed change publishes them (the live one superseded), and its groups and roles
// suggested made (a group with the seed's people its pack names, §29.6); each audited as the platform's
// (`suite:reseed`); then its samples are loaded through the record services, as a designer (design.samples), so
// its rules, policies and plans apply. Everything else in the database stays as it is.
//
// It is the suite author's tool, as a seeding reset is: never a plant's way in. It refuses a protected database (a
// plant's own, ops/db/protect-audit.sql), PROD=1, and runs only when told the database and --yes.
//
//   DATABASE_URL=postgres:///openmes_poc node app/mes/db/suite-reseed.mjs <suite> --yes [--as <designer>]
//   (then restart the instance: its caches and query views are made at start)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { loadSuites } from "../suites.mjs";
import { appendAudit } from "../server/audit.js";
import { platformWrites, resealRecords, sealDesigns, ACCESS } from "../server/integrity.js";
import { packElements, packStatus, forInstalled } from "../server/packs.js";
import { sessionKey } from "../server/store.js";

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--"));
const as = args[args.indexOf("--as") + 1] && args.includes("--as") ? args[args.indexOf("--as") + 1] : null;
const url = process.env.DATABASE_URL;
const stop = (words) => { console.error(words); process.exit(2); };
if (!name) stop("Name the suite: node app/mes/db/suite-reseed.mjs <suite> --yes");
if (!url) stop("Say which database: DATABASE_URL=postgres:///<name> (a development one). Nothing was changed.");
if (process.env.PROD === "1") stop("PROD=1: a production instance takes a suite's designs through a change, reviewed and approved. Nothing was changed.");
if (!args.includes("--yes")) stop(`This archives ${name}'s records, stops its plans' runs in ${url.split("/").pop()} and publishes its designs without review: add --yes if that is meant.`);

const installed = await loadSuites(process.env.SUITES_DIR ? { dir: process.env.SUITES_DIR } : {});
const suite = installed.find((x) => x.name === name);
if (!suite) stop(`No suite "${name}" is installed here (suites/, or SUITES_DIR).`);
if (!suite.designs) stop(`${suite.label} brings no designs: nothing to put back.`);
// As offered here: what it brings only with another suite, only where that one is installed (§29.6).
const pack = forInstalled({ ...suite.designs, name: suite.name, suite: suite.label }, installed.map((x) => x.name));

const pool = new pg.Pool({ connectionString: url });
const db = fromPg(pool);
try {
    const [{ kept }] = await db.query("SELECT to_regclass('audit.audit_log') IS NOT NULL AS kept");
    if (kept) stop("Its audit trail is protected (ops/db/protect-audit.sql): a plant's own database. Nothing was changed.");

    // What is live, as design.js published() has it, for packStatus.
    const KINDS = ["transactions", "screens", "flows", "layouts", "queries", "elements", "services", "connections"];
    const live = { definitions: {}, scripts: {} };
    for (const r of await db.query("SELECT object, version, body FROM mes.definitions WHERE status = 'published'")) live.definitions[r.object] = { version: r.version, body: r.body };
    for (const r of await db.query("SELECT name, version, source FROM mes.scripts WHERE status = 'published'")) live.scripts[r.name] = { version: r.version, source: r.source };
    for (const k of KINDS) { live[k] = {}; for (const r of await db.query(`SELECT name, version, body FROM mes.${k} WHERE status = 'published'`)) live[k][r.name] = { version: r.version, body: r.body }; }
    const elements = packElements(pack, live);
    const differ = packStatus(pack, live).filter((e) => e.status !== "same");
    const objects = (pack.definitions ?? []).map((d) => d.object);
    const flows = (pack.flows ?? []).map((f) => f.name);
    const said = { withdrawn: [], records: 0, runs: 0, published: [], groups: [], roles: 0 };

    await db.transaction(async (tx) => {
        await platformWrites(tx);
        // 1. Its open changes, withdrawn (another change would hold its designs).
        const holds = (c) => Object.entries(elements).some(([k, named]) => Object.keys(named).some((n) => c?.[k]?.[n] !== undefined));
        for (const c of await tx.query("SELECT id, title, content FROM mes.change_requests WHERE state IN ('design', 'review', 'approval') FOR UPDATE")) {
            if (!holds(c.content)) continue;
            await tx.query("UPDATE mes.change_requests SET state = 'withdrawn', updated_at = now() WHERE id = $1", [c.id]);
            await appendAudit(tx, { actor: "platform", object: "$change", recordId: c.id, action: "change:withdraw", after: { via: `suite:reseed ${name}` } });
            said.withdrawn.push(c.title);
        }
        // 2. Its plans' runs stopped, its records archived (each audited, resealed), its samples' keys forgotten so they
        //    are made afresh.
        said.runs = (await tx.query("UPDATE mes.flow_runs SET state = 'stopped', reason = $2, updated_at = now(), ended_at = now() WHERE flow = ANY($1) AND state NOT IN ('ended', 'stopped') RETURNING id", [flows, `the ${name} suite was reseeded`])).length;
        for (const object of objects) {
            const rows = await tx.query("UPDATE mes.records SET archived_at = now(), archived_by = 'platform', row_version = row_version + 1 WHERE object = $1 AND archived_at IS NULL RETURNING id, def_version", [object]);
            if (!rows.length) continue;
            // Resealed, then audited with the new seal: the last seal the audit trail keeps is the record's (§7.7).
            await resealRecords(tx, object, rows.map((r) => r.id));
            const seals = new Map((await tx.query("SELECT id, seal FROM mes.records WHERE id = ANY($1)", [rows.map((r) => r.id)])).map((r) => [r.id, r.seal]));
            for (const r of rows) await appendAudit(tx, { actor: "platform", object, recordId: r.id, defVersion: r.def_version, action: "archive", after: { via: `suite:reseed ${name}`, ...(seals.get(r.id) ? { $seal: seals.get(r.id) } : {}) } });
            said.records += rows.length;
        }
        await tx.query("DELETE FROM mes.idempotency WHERE key LIKE $1", [`sample-${name}-%`]);
        // 3. Its designs that differ, as their next versions (an object new here gets its partition).
        for (const e of differ) {
            const body = elements[e.kind][e.name];
            if (e.kind === "scripts") {
                const v = live.scripts[e.name]?.version ?? 0;
                if (v) await tx.query("UPDATE mes.scripts SET status = 'superseded' WHERE name = $1 AND version = $2", [e.name, v]);
                await tx.query("INSERT INTO mes.scripts (name, version, status, source, tests) VALUES ($1, $2, 'published', $3, $4)", [e.name, v + 1, body, JSON.stringify(pack.tests?.[e.name] ?? [])]);
            } else if (e.kind === "definitions") {
                const v = live.definitions[e.name]?.version ?? 0;
                if (v) await tx.query("UPDATE mes.definitions SET status = 'superseded' WHERE object = $1 AND version = $2", [e.name, v]);
                else await tx.query(`CREATE TABLE IF NOT EXISTS mes."records_${e.name}" PARTITION OF mes.records FOR VALUES IN ('${e.name.replace(/[^a-z0-9_]/g, "")}')`);
                await tx.query("INSERT INTO mes.definitions (object, version, status, body) VALUES ($1, $2, 'published', $3)", [e.name, v + 1, JSON.stringify(body)]);
            } else {
                const v = live[e.kind][e.name]?.version ?? 0;
                if (v) await tx.query(`UPDATE mes.${e.kind} SET status = 'superseded' WHERE name = $1 AND version = $2`, [e.name, v]);
                await tx.query(`INSERT INTO mes.${e.kind} (name, version, status, body) VALUES ($1, $2, 'published', $3)`, [e.name, v + 1, JSON.stringify(body)]);
            }
            said.published.push(`${e.kind}:${e.name}`);
        }
        // 4. Its groups (with the seed's people it names, if they are here) and the roles it suggests, if missing.
        for (const [id, g] of Object.entries(pack.groups ?? {})) {
            if ((await tx.query("SELECT 1 FROM mes.groups WHERE id = $1", [id])).length) continue;
            await tx.query("INSERT INTO mes.groups (id, name, kind) VALUES ($1, $2, 'group')", [id, g.name]);
            for (const m of g.seedMembers ?? []) if ((await tx.query("SELECT 1 FROM mes.users WHERE id = $1 AND active", [m])).length) await tx.query("INSERT INTO mes.group_members (group_id, user_id) VALUES ($1, $2)", [id, m]);
            said.groups.push(id);
        }
        for (const [object, roles] of Object.entries(pack.roles ?? {})) for (const [role, subjects] of Object.entries(roles ?? {})) for (const subject of subjects ?? []) {
            const [kind, sid] = String(subject).split(":");
            const there = kind === "group" ? (await tx.query("SELECT 1 FROM mes.groups WHERE id = $1", [sid])).length : (await tx.query("SELECT 1 FROM mes.users WHERE id = $1", [sid])).length;
            if (!there || (await tx.query("SELECT 1 FROM mes.assignments WHERE subject_kind = $1 AND subject_id = $2 AND object = $3 AND role = $4", [kind, sid, object, role])).length) continue;
            await tx.query("INSERT INTO mes.assignments (subject_kind, subject_id, object, role) VALUES ($1, $2, $3, $4)", [kind, sid, object, role]);
            said.roles += 1;
        }
        // What it published, and people and roles if it made some, sealed as it left them (§7.7), as an executed change.
        const sealed = [...differ.map((e) => `${e.kind}:${e.name}`), ...(said.groups.length || said.roles ? [ACCESS] : [])];
        if (sealed.length) await sealDesigns(tx, undefined, sealed);
        await appendAudit(tx, { actor: "platform", object: "$suites", action: "suite:reseed", after: { name, version: suite.version, ...said, note: "a suite's development reseed: its designs published without review (SUITES.md)" } });
    });
    console.log(`${suite.label} ${suite.version}: ${said.withdrawn.length} change(s) withdrawn, ${said.records} record(s) archived and ${said.runs} plan run(s) stopped, ${said.published.length} design(s) published${said.published.length ? ` (${said.published.join(", ")})` : ""}, ${said.groups.length} group(s) and ${said.roles} role(s) made`);

    // 5. Its samples, through the record services as a designer.
    if ((pack.records ?? []).length) {
        const designer = as ?? (await db.query("SELECT subject_id FROM mes.assignments WHERE subject_kind = 'user' AND object = 'design' AND role = 'designer' ORDER BY subject_id LIMIT 1"))[0]?.subject_id;
        if (!designer) stop("Nobody holds the designer role to load its samples as: --as <id>.");
        const { createApp } = await import("../app.mjs");
        const app = await createApp({ db, dev: false, build: "reseed", outboxEveryMs: 0, schedulerEveryMs: 0, suites: await loadSuites(process.env.SUITES_DIR ? { dir: process.env.SUITES_DIR } : {}) });
        const { url: at } = await app.listen({ port: 0, host: "127.0.0.1" });
        const sid = `reseed-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '10 minutes')", [sid, designer]);
        try {
            const res = await fetch(`${at}/api/design.samples`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sid}` }, body: JSON.stringify([{ suite: name }]) });
            const out = await res.json();
            if (!res.ok) throw new Error(`its samples: ${out.error}`);
            console.log(`${out.made} sample record(s) loaded as ${designer}${out.waiting?.length ? `; waiting for approval: ${out.waiting.join(", ")}` : ""}`);
        } finally {
            await db.query("DELETE FROM mes.sessions WHERE id = $1 OR id = $2", [sid, sessionKey(sid)]);
            await app.close();
        }
    }
    console.log("Restart the instance: its caches and query views are made at start.");
} finally {
    await pool.end();
}
