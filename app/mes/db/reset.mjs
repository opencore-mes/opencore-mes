// Recreates the POC database: schema, then seed. `npm run db:reset`.
//   DATABASE_URL  default postgres:///openmes_poc (the database is created when missing)
//   --blank       people only (a training instance, `npm run training:reset`): the seeded people,
//                 departments, their approval steps and roles on the designer and the query page, and
//                 no objects, scripts, transactions, screens or records; every model is designed from
//                 nothing, through the change lifecycle. SEED_BLANK=1 is the same.
//   SEED_VOLUME   that many more records for a demo (seed.mjs volume(): lots over more work orders);
//                 none unless set.
//   SEED_GUEST    1: a public demo's guest, holding every role (guest.mjs; the demo opens as it)
//   SEED_SUITES   1 (or --suites): every installed suite's design pack too (DESIGN.md §29.6), published
//                 like the seed; its sample records loaded once it is, through the record services as
//                 the seed's designer (design.samples), so their rules run and their plans set off as
//                 in a plant (a durable takes its material's kind and life). With --blank, the
//                 people and the suites' models only, without the seed's plant (lots, machines, work
//                 orders): what the public demo runs (ops/demo/demo.env), `npm run db:reset:suites`.
//                 What a pack adds to objects it does not own (its extends: the built-in Person, say)
//                 is applied once they are published, as a change from the pack would.
//   SUITES_DIR    where the installed suites are (default suites/): a test's fixtures
import pg from "pg";
import { fromPg } from "../../../src/server/db.js";
import { appendAudit } from "../server/audit.js";
import { checkScript } from "../server/rules.js";
import { rebuildIntervals } from "../server/analytics.js";
import { migrate } from "./migrate.mjs";
import { loadSchema } from "./schema-load.mjs";
import { loadSuites } from "../suites.mjs";
import { extendedBody } from "../server/packs.js";
import * as seed from "./seed.mjs";
import { adoptRuns } from "../server/flows.js";
import { sessionKey } from "../server/store.js";

const blank = process.argv.includes("--blank") || process.env.SEED_BLANK === "1";
const withSuites = process.argv.includes("--suites") || process.env.SEED_SUITES === "1";
// The suites installed: under suites/, or SUITES_DIR (a test's fixtures).
const installed = () => loadSuites(process.env.SUITES_DIR ? { dir: process.env.SUITES_DIR } : {});
const { users, groups, representatives, stepLabels } = seed;
const { definitions, scripts, records, transactions, screens, flows: seedFlows, layouts: seedLayouts } = blank
    ? { definitions: [], scripts: {}, records: [], transactions: [], screens: [], flows: [], layouts: [] }
    : { ...seed, records: [...seed.records, ...seed.volume(Number(process.env.SEED_VOLUME ?? 0))] };
// Roles on objects that exist: blank, only those on the designer and the query page.
const modelled = new Set(seed.definitions.map((d) => d.object));
const assignments = blank ? seed.assignments.filter(([, , object]) => !modelled.has(object)) : [...seed.assignments];

// The suites' design packs (§29.6), after the core's seed: their designs and the roles they suggest
// (for the seed's groups and people); their records afterwards, through the services (below).
const tests = {};
const flows = [...seedFlows];
const layouts = [...seedLayouts];
// Design elements of the suites' own kinds (§30.11), from their packs.
const elements = [];
const sets = [];
const withSamples = [];
const extensions = [];
if (withSuites) {
    const subjects = new Set([...groups.map((g) => `group:${g.id}`), ...users.map((u) => `user:${u.id}`)]);
    for (const suite of (await installed()).filter((x) => x.designs)) {
        const pack = suite.designs;
        const key = (k) => `${suite.name}/${k}`;
        definitions.push(...(pack.definitions ?? []));
        Object.assign(scripts, pack.scripts ?? {});
        Object.assign(tests, pack.tests ?? {});
        transactions.push(...(pack.transactions ?? []));
        flows.push(...(pack.flows ?? []));
        layouts.push(...(pack.layouts ?? []));
        elements.push(...(pack.elements ?? []));
        screens.push(...(pack.screens ?? []));
        for (const [object, roles] of Object.entries(pack.roles ?? {})) {
            for (const [role, list] of Object.entries(roles)) for (const subject of list) if (subjects.has(subject)) assignments.push([...subject.split(":"), object, role]);
        }
        for (const [object, ext] of Object.entries(pack.extends ?? {})) extensions.push({ object, ext, suite: suite.name, label: pack.suite ?? pack.label });
        if ((pack.records ?? []).length) withSamples.push(suite.name);
        console.log(`suite ${suite.name}: ${pack.label} ${pack.version} seeded`);
    }
}

const url = process.env.DATABASE_URL ?? "postgres:///openmes_poc";
const name = new URL(url.replace(/^postgres:\/\/\//, "postgres://localhost/")).pathname.slice(1);

// Create the database when it is missing.
const admin = new pg.Client({ connectionString: url.replace(/\/[^/]*$/, "/postgres") });
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
if (!exists.rowCount) await admin.query(`CREATE DATABASE "${name.replace(/"/g, "")}"`);
await admin.end();

const pool = new pg.Pool({ connectionString: url });
const db = fromPg(pool);
// The schema, and the change bus's outbox (schema-load.mjs).
await loadSchema(pool);

await db.transaction(async (tx) => {
    for (const u of users) await tx.query("INSERT INTO mes.users (id, name) VALUES ($1, $2)", [u.id, u.name]);
    for (const g of groups) {
        await tx.query("INSERT INTO mes.groups (id, name, kind) VALUES ($1, $2, $3)", [g.id, g.name, g.kind]);
        for (const m of g.members) await tx.query("INSERT INTO mes.group_members (group_id, user_id) VALUES ($1, $2)", [g.id, m]);
    }
    for (const [group, user, step = 1] of representatives) await tx.query("INSERT INTO mes.department_reps (group_id, user_id, step) VALUES ($1, $2, $3)", [group, user, step]);
    for (const [kind, subject, object, role] of assignments) {
        await tx.query("INSERT INTO mes.assignments (subject_kind, subject_id, object, role) VALUES ($1, $2, $3, $4)", [kind, subject, object, role]);
    }
    for (const [scriptName, source] of Object.entries(scripts)) {
        checkScript(scriptName, source);
        await tx.query("INSERT INTO mes.scripts (name, version, status, source, tests) VALUES ($1, 1, 'published', $2, $3)", [scriptName, source, JSON.stringify(tests[scriptName] ?? [])]);
    }
    for (const def of definitions) {
        await tx.query("INSERT INTO mes.definitions (object, version, status, body) VALUES ($1, 1, 'published', $2)", [def.object, JSON.stringify(def)]);
        await tx.query(`CREATE TABLE mes."records_${def.object}" PARTITION OF mes.records FOR VALUES IN ('${def.object}')`);
    }
    const ids = {};
    for (const r of records) {
        const data = Object.fromEntries(Object.entries(r.data).map(([k, v]) => [k, typeof v === "string" && v.startsWith("@") ? ids[v.slice(1)] : v]));
        const [row] = await tx.query(
            "INSERT INTO mes.records (object, def_version, state, data, created_by, updated_by) VALUES ($1, 1, $2, $3, 'seed', 'seed') RETURNING id",
            [r.object, r.state, JSON.stringify(data)],
        );
        ids[r.key] = row.id;
        await appendAudit(tx, { actor: "seed", object: r.object, recordId: row.id, defVersion: 1, action: "create", after: { ...data, state: r.state } });
    }
    for (const { key, set } of sets) {
        const data = Object.fromEntries(Object.entries(set).map(([k, v]) => [k, typeof v === "string" && v.startsWith("@") ? ids[v.slice(1)] : v]));
        const [row] = await tx.query("UPDATE mes.records SET data = data || $2::jsonb, row_version = row_version + 1 WHERE id = $1 RETURNING object, state, data", [ids[key], JSON.stringify(data)]);
        await appendAudit(tx, { actor: "seed", object: row.object, recordId: ids[key], defVersion: 1, action: "update", after: { ...row.data, state: row.state } });
    }
});

// Analytics (§22): the seed's records' stays in their states, from the audit trail just written.
await rebuildIntervals(db, definitions);
// Every migration recorded as applied (they are safe to run again), so the server finds it up to date.
await migrate(db, { log: {}, suites: await installed() });
// What the suites add to objects they do not own (§29.6: their extends), once those are published, the
// platform's built-in ones (Person, by the migration above) among them: as a change from the pack would.
for (const { object, ext, suite, label } of extensions) {
    const [live] = await db.query("SELECT version, body FROM mes.definitions WHERE object = $1 AND status = 'published'", [object]);
    if (!live) { console.log(`suite ${suite}: ${object} is not designed here, nothing to extend`); continue; }
    await db.query("UPDATE mes.definitions SET body = $3 WHERE object = $1 AND version = $2", [object, live.version, JSON.stringify(extendedBody(live.body, ext, { suite, label }))]);
    console.log(`suite ${suite}: ${object} extended (${Object.keys(ext.fields ?? {}).join(", ")})`);
}
// Transactions (§25), once their table is there: published like any design element.
for (const t of transactions) await db.query("INSERT INTO mes.transactions (name, version, status, body) VALUES ($1, 1, 'published', $2)", [t.name, JSON.stringify(t)]);
// The organization's first version names its steps (§5.6).
await db.query("UPDATE mes.organization SET body = jsonb_set(body, '{steps}', $1::jsonb) WHERE status = 'published'", [JSON.stringify(stepLabels)]);
// …and who reads every record (§27.7).
await db.query("UPDATE mes.organization SET body = jsonb_set(body, '{readers}', $1::jsonb) WHERE status = 'published'", [JSON.stringify(seed.readers ?? [])]);
// A public demo's guest (SEED_GUEST=1, guest.mjs): every role the objects published now declare, every
// group and department; the demo opens as it (DEMO_AS=guest).
if (process.env.SEED_GUEST === "1") {
    const { addGuest } = await import("./guest.mjs");
    const g = await addGuest(db);
    console.log(`the demo's guests: ${g.roles} roles (the group Guests), approving for ${g.departments} departments`);
}
// Screens (§26), likewise.
for (const sc of screens) await db.query("INSERT INTO mes.screens (name, version, status, body) VALUES ($1, 1, 'published', $2)", [sc.name, JSON.stringify(sc)]);
// Report layouts (§34.5), likewise.
for (const l of layouts) await db.query("INSERT INTO mes.layouts (name, version, status, body) VALUES ($1, 1, 'published', $2)", [l.name, JSON.stringify(l)]);
// The suites' own design elements (§30.11), likewise.
for (const e of elements) await db.query("INSERT INTO mes.elements (name, version, status, body) VALUES ($1, 1, 'published', $2)", [e.name, JSON.stringify(e)]);
// Flows (§32), likewise; travelers seeded part-way take their routes up where they are.
for (const f of flows) await db.query("INSERT INTO mes.flows (name, version, status, body) VALUES ($1, 1, 'published', $2)", [f.name, JSON.stringify(f)]);
if (flows.length) await adoptRuns(db, { flows: new Map(flows.map((f) => [f.name, { version: 1, body: f }])), definitions: Object.fromEntries(definitions.map((d) => [d.object, d])) });

console.log(`database ${name}: schema and ${blank ? `people${withSuites ? " and the suites' models" : " only (blank)"}` : "seed"} loaded (${definitions.length} objects, ${transactions.length} transactions, ${screens.length} screens, ${records.length} records, ${users.length} users)`);
// The suites' sample records, through the record services as the seed's designer (design.samples): each
// object's rules and policies apply, the routes take their lots up, and plans set off (§29.6).
if (withSamples.length) {
    const [, designer] = seed.assignments.find(([kind, , object, role]) => kind === "user" && object === "design" && role === "designer") ?? [];
    if (!designer) throw new Error("the seed has no designer to load the suites' samples as");
    const { createApp } = await import("../app.mjs");
    const app = await createApp({ db, dev: false, build: "seed", outboxEveryMs: 0, schedulerEveryMs: 0, suites: await installed() });
    const { url: at } = await app.listen({ port: 0, host: "127.0.0.1" });
    const sid = `seed-${Date.now().toString(36)}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '10 minutes')", [sid, designer]);
    try {
        for (const suite of withSamples) {
            const res = await fetch(`${at}/api/design.samples`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sid}` }, body: JSON.stringify([{ suite }]) });
            const out = await res.json();
            if (!res.ok) throw new Error(`suite ${suite}: its samples: ${out.error}`);
            if (out.waiting?.length) throw new Error(`suite ${suite}: samples not made: ${out.waiting.join(", ")}`);
            console.log(`suite ${suite}: ${out.made} sample record(s) loaded as ${designer}`);
        }
    } finally {
        await db.query("DELETE FROM mes.sessions WHERE id = $1", [sessionKey(sid)]);
        await app.close();
    }
}
await pool.end();
