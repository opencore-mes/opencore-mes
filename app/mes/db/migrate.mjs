// The database upgrades itself (DESIGN.md §7): every migration below runs at every server start, in
// order, under one lock, so several instances never run one twice. Each is recorded with the checksum
// of its file: a new one runs, and one whose file changed runs again. So a migration must be safe to
// run again (IF NOT EXISTS, ON CONFLICT, CREATE OR REPLACE), and a change to the database is made by
// editing or adding a file here, never by hand.
//
// A migration may have a step after its SQL, in JavaScript: filling what the SQL made (state intervals
// rebuilt from the audit trail), run the first time only.
//
//   node app/mes/db/migrate.mjs          DATABASE_URL, default postgres:///openmes_poc
//   import { migrate } from "./db/migrate.mjs"; await migrate(db)   what the server does at start
//
// A new database is made by `npm run db:reset` (schema.sql and the seed), which migrates it too.
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { rebuildIntervals } from "../server/analytics.js";
import { appendAudit } from "../server/audit.js";
import { syncPeople } from "../server/organization.js";
import { BUILT_INS, BUILT_IN_SCRIPTS, BUILT_IN_FIRST_ROLES } from "../client/builtins.js";
import { sealDesigns, platformWrites, ACCESS } from "../server/integrity.js";

const here = (file) => new URL(file, import.meta.url);

// In the order they came; each safe to run again.
export const MIGRATIONS = [
    { name: "ai-design-api", file: "migrate-ai.sql" },
    { name: "integration", file: "integration.sql" },
    { name: "fitness", file: "fitness.sql" },
    { name: "archive", file: "migrate-archive.sql" },
    { name: "event-log", file: "migrate-events.sql" },
    {
        name: "analytics-intervals", file: "migrate-analytics.sql",
        // The stays of the records already there, from the audit trail.
        async first(tx) {
            const defs = (await tx.query("SELECT body FROM mes.definitions WHERE status = 'published'")).map((r) => r.body);
            return `${await rebuildIntervals(tx, defs)} stay(s) rebuilt`;
        },
    },
    {
        name: "queries", file: "migrate-query.sql",
        // Who may query at first: the people who design and review. Later grants are role
        // assignments like any other.
        async first(tx) {
            const rows = await tx.query(
                `INSERT INTO mes.assignments (subject_kind, subject_id, object, role)
                 SELECT DISTINCT subject_kind, subject_id, 'query', 'analyst' FROM mes.assignments
                 WHERE object = 'design' AND role IN ('designer', 'reviewer')
                 ON CONFLICT DO NOTHING RETURNING subject_id`,
            );
            return `analyst role given to ${rows.map((r) => r.subject_id).join(", ") || "nobody new"}`;
        },
    },    // Transactions (§25) as design elements: their table. What they are is designed, not migrated.
    { name: "transactions", file: "migrate-transactions.sql" },
    // Screens (§26) as design elements: their table.
    { name: "screens", file: "migrate-screens.sql" },
    // Retiring a design (§5.10): a status of its own.
    { name: "retire", file: "migrate-retire.sql" },
    {
        name: "organization", file: "migrate-organization.sql",
        // Its first published version: the governance department as it was (engineering), no standing
        // approvers, every department in one step.
        async first(tx) {
            const [had] = await tx.query("SELECT 1 FROM mes.organization LIMIT 1");
            if (had) return null;
            const [gov] = await tx.query("SELECT id FROM mes.groups WHERE kind = 'department' ORDER BY (id = 'engineering') DESC, id LIMIT 1");
            await tx.query("INSERT INTO mes.organization (version, status, body) VALUES (1, 'published', $1)", [JSON.stringify({ governance: gov?.id ?? null, standing: {}, steps: {} })]);
            return `governance: ${gov?.id ?? "none"}`;
        },
    },
    // Approval of record changes (§28): requests and their signatures.
    { name: "record-approval", file: "migrate-record-approval.sql" },
    // Co-designers (§5.3): who else may edit a draft, and who saved it last.
    { name: "co-designers", file: "migrate-co-designers.sql" },
    // Flows (§32): routes and plans as a design element, their runs and their way.
    { name: "flow-templates", file: "migrate-flows.sql" },
    { name: "flow-plans", file: "migrate-flow-plans.sql" },
    // Reading records at scale: indexes for lists, screens and search, and the order they sort in.
    { name: "record-indexes", file: "migrate-record-indexes.sql" },
    // Plans that set off again, and on a date: one run at a time per template and record (§32.5a).
    { name: "flow-again", file: "migrate-flow-again.sql" },
    { name: "sandbox-selections", file: "migrate-sandbox-selections.sql" },
    { name: "copilot-conversations", file: "migrate-copilot-conversations.sql" },
    { name: "sign-in", file: "migrate-sign-in.sql" },
    { name: "people-indexes", file: "migrate-people-indexes.sql" },
    // The audit trail and the event log refuse TRUNCATE, as they refuse UPDATE and DELETE.
    { name: "append-only-truncate", file: "migrate-append-only-truncate.sql" },
    // A request key is unique per person, not across everyone.
    { name: "idempotency-per-user", file: "migrate-idempotency-per-user.sql" },
    // The page a session's desktop opens (§6.8).
    { name: "session-home", file: "migrate-session-home.sql" },
    // The analytics copilot's conversations (§34).
    { name: "analyst-conversations", file: "migrate-analyst.sql" },
    // Report layouts (§34.5), a design element.
    { name: "report-layouts", file: "migrate-report-layouts.sql" },
    // Kept prompts of the analytics copilot, and their schedules (§34.7).
    { name: "report-prompts", file: "migrate-report-prompts.sql" },
    // Design elements of a kind a suite adds (§30.11).
    { name: "suite-elements", file: "migrate-suite-elements.sql" },
    // Routes inside routes (§32.14): one top route per traveler; its sub routes' runs are its children.
    { name: "sub-routes", file: "migrate-sub-routes.sql" },
    // The test sandbox (§5.13): changes under test together, and what each was tested with.
    { name: "test-sandbox", file: "migrate-test-sandbox.sql" },
    // Rolling a change back (§5.14).
    { name: "rollback", file: "migrate-rollback.sql" },
    // Pictures (§35): image fields, floor layouts.
    { name: "blobs", file: "migrate-blobs.sql" },
    // A second person signed in beside the first, and signing passwords (§7.4).
    { name: "dual-sign", file: "migrate-dual-sign.sql" },
    // Attachments (§34.10): documents beside pictures; a kept prompt's attachments.
    { name: "attachments", file: "migrate-attachments.sql" },
    // A kept prompt pinned to a report: its queries run again each time (§34.11).
    { name: "prompt-fixed", file: "migrate-prompt-fixed.sql" },
    // Sign-in hardened (§8.2, §7.4): sessions hashed and idle, re-authentication at signatures, password
    // ageing and history, a second factor, tokens that expire.
    { name: "auth-hardening", file: "migrate-auth-hardening.sql" },
    // The audit chain verified on a schedule, from where it was last checked (§7.3, COMPLIANCE.md G3).
    { name: "audit-verify", file: "migrate-audit-verify.sql" },
    // Emergency changes (§5.7, COMPLIANCE.md G15): one signature executes it; reviewed afterwards within a set time.
    { name: "emergency", file: "migrate-emergency.sql" },
    // Data retention (§27.8, COMPLIANCE.md G11): the purge's runs, its indexes, the event log's copy purged past a year.
    { name: "retention", file: "migrate-retention.sql" },
    // Named queries (§23.1): a SELECT over the query views, designed and approved like a screen.
    { name: "named-queries", file: "migrate-named-queries.sql" },
    // Setup (§5.15): a change executed on its designer's signature while the plant is set up.
    { name: "setup", file: "migrate-setup.sql" },
    // Approval levels (§5.16): the level a change was submitted under.
    { name: "approval-levels", file: "migrate-approval-levels.sql" },
    // A kept prompt's run by the clock (§34.7): tried again after a stop or a failure, and said when late.
    { name: "report-retries", file: "migrate-report-retries.sql" },
    { name: "certifications", file: "migrate-certifications.sql" },
    { name: "files", file: "migrate-files.sql" },
    // Setup codes (§8.2): five letters on a printed slip, to set a first password.
    { name: "setup-codes", file: "migrate-setup-codes.sql" },
    // Every suite version an installation has run, and what it gave designs (§29.5, §29.10).
    { name: "suite-versions", file: "migrate-suite-versions.sql" },
    {
        name: "integrity", file: "migrate-integrity.sql",
        // The data integrity review (§7.7, COMPLIANCE.md G16): its first reviewers are those who review designs.
        // Its baseline is taken by one of them, signed (a new database's by the reset).
        async first(tx) {
            const rows = await tx.query(
                `INSERT INTO mes.assignments (subject_kind, subject_id, object, role)
                 SELECT DISTINCT subject_kind, subject_id, 'integrity', 'reviewer' FROM mes.assignments
                 WHERE object = 'design' AND role = 'reviewer'
                 ON CONFLICT DO NOTHING RETURNING subject_id`,
            );
            return `integrity reviewer role given to ${rows.map((r) => r.subject_id).join(", ") || "nobody new"}`;
        },
    },
    { name: "mail", file: "migrate-mail.sql" },
    { name: "database", file: "migrate-database.sql" },
    { name: "audit-chains", file: "migrate-audit-chains.sql" },
    { name: "call-stats", file: "migrate-call-stats.sql" },
];

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// Runs what is new or changed: [{ name, action: "applied" | "re-applied", note }] (none when up to date).
// `suites` (app/mes/suites.mjs): each installed suite's own migrations run after the platform's, named
// "<suite>:<name>", their files given as file: URLs.
export async function migrate(db, { log = console, suites = [] } = {}) {
    const all = [...MIGRATIONS, ...suites.flatMap((s) => (s.migrations ?? []).map((m) => ({ ...m, name: `${s.name}:${m.name}` })))];
    const [ready] = await db.query("SELECT to_regclass('mes.records') IS NOT NULL AS ok");
    if (!ready?.ok) throw new Error("This database has no OpenCore MES schema: make it with `npm run db:reset` first.");
    const done = [];
    await db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('mes.migrations'))");
        // The platform's own writes (built-ins, first roles): let by the integrity tripwire (§7.7).
        await platformWrites(tx);
        await tx.query(`CREATE TABLE IF NOT EXISTS mes.schema_migrations (
            name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
        const applied = new Map((await tx.query("SELECT name, checksum FROM mes.schema_migrations")).map((r) => [r.name, r.checksum]));
        for (const m of all) {
            const sql = await readFile(m.file instanceof URL ? m.file : here(m.file), "utf8");
            const checksum = sha256(sql);
            const before = applied.get(m.name);
            if (before === checksum) continue;
            await tx.query(sql);
            // Transactions kept in plain SQL: a file's own SET or search_path ends here.
            await tx.query("SET LOCAL search_path TO DEFAULT");
            const note = before === undefined && m.first ? await m.first(tx) : null;
            await tx.query(
                `INSERT INTO mes.schema_migrations (name, checksum) VALUES ($1, $2)
                 ON CONFLICT (name) DO UPDATE SET checksum = $2, applied_at = now()`,
                [m.name, checksum],
            );
            done.push({ name: m.name, action: before === undefined ? "applied" : "re-applied", ...(note ? { note } : {}) });
        }
        done.push(...(await ensureBuiltIns(tx)));
        // What the platform published or granted just now, sealed (§7.7); nothing else is (a hand edit stays found).
        const changed = new Set();
        for (const d of done) {
            if (d.action !== "applied") continue;
            if (d.name.startsWith("built-in-roles:") || ((d.name === "queries" || d.name === "integrity" || d.name === "organization") && d.note)) changed.add(ACCESS);
            const built = BUILT_INS.find((b) => `built-in:${b.object}` === d.name);
            if (built) for (const k of [`definitions:${built.object}`, ...(built.rules ?? []).map((r) => `scripts:${r.script}`)]) changed.add(k);
        }
        const [sealing] = await tx.query("SELECT to_regclass('mes.integrity_seals') IS NOT NULL AS ok");
        if (changed.size && sealing?.ok) await sealDesigns(tx, undefined, [...changed]);
    });
    for (const d of done) log.info?.(`database: ${d.action} ${d.name}${d.note ? ` (${d.note})` : ""}`);
    return done;
}

// A built-in the platform has since given a field (a report's tags), or a setting (GROWN: Person's scanBy, its
// sign-in id scanned off a badge): the live definition gets it, as a new version published by the platform,
// with everything the plant made of the object kept as it is (its own fields, policies, form, rules). Only
// added, never changed or taken away; a field of that name, or a setting, the plant already has stays the
// plant's. The form's first section shows a new field.
const GROWN = ["scanBy"];
async function growBuiltIn(tx, builtIn) {
    const [live] = await tx.query("SELECT version, body FROM mes.definitions WHERE object = $1 AND status = 'published' FOR UPDATE", [builtIn.object]);
    if (!live?.body?.builtIn) return [];
    const added = Object.keys(builtIn.fields).filter((f) => !Object.hasOwn(live.body.fields ?? {}, f));
    // Given once (marked done): a plant that takes it away later keeps it away.
    const given = new Set((await tx.query("SELECT name FROM mes.schema_migrations WHERE name LIKE $1", [`built-in-grown:${builtIn.object}:%`])).map((r) => r.name.split(":").pop()));
    const settings = GROWN.filter((k) => builtIn[k] !== undefined && !Object.hasOwn(live.body, k) && !given.has(k));
    if (!added.length && !settings.length) return [];
    const body = JSON.parse(JSON.stringify(live.body));
    for (const f of added) body.fields[f] = builtIn.fields[f];
    for (const k of settings) {
        body[k] = JSON.parse(JSON.stringify(builtIn[k]));
        await tx.query("INSERT INTO mes.schema_migrations (name, checksum) VALUES ($1, 'once') ON CONFLICT DO NOTHING", [`built-in-grown:${builtIn.object}:${k}`]);
    }
    const section = body.form?.sections?.[0];
    if (section && Array.isArray(section.fields)) {
        const shown = new Set((body.form.sections ?? []).flatMap((s) => (s.fields ?? []).map((e) => (typeof e === "string" ? e : e?.field))));
        section.fields.push(...added.filter((f) => !shown.has(f)));
    }
    const [{ v }] = await tx.query("SELECT coalesce(max(version), 0) + 1 AS v FROM mes.definitions WHERE object = $1", [builtIn.object]);
    await tx.query("UPDATE mes.definitions SET status = 'superseded' WHERE object = $1 AND version = $2", [builtIn.object, live.version]);
    await tx.query("INSERT INTO mes.definitions (object, version, status, body) VALUES ($1, $2, 'published', $3)", [builtIn.object, v, JSON.stringify(body)]);
    await appendAudit(tx, { actor: "platform", object: builtIn.object, recordId: null, defVersion: v, action: "publish:built-in", after: { object: builtIn.object, version: v, added, ...(settings.length ? { settings } : {}) } });
    return [{ name: `built-in:${builtIn.object}`, action: "applied", note: `the platform added ${[...added, ...settings].join(", ")} (version ${v})` }];
}

// The platform's built-in objects (builtins.js), published in every installation the first time it
// meets them, stewarded by governance, as the platform; then kept in step (Person: one record per
// person). A plant's own object of the same name, made before, is left alone, and said so.
export async function ensureBuiltIns(tx) {
    const done = [];
    for (const builtIn of BUILT_INS) {
        const [have] = await tx.query("SELECT body FROM mes.definitions WHERE object = $1 ORDER BY version DESC LIMIT 1", [builtIn.object]);
        if (have) {
            if (!have.body?.builtIn) done.push({ name: `built-in:${builtIn.object}`, action: "skipped", note: `this plant has its own "${builtIn.object}" object` });
            else done.push(...(await growBuiltIn(tx, builtIn)));
            continue;
        }
        const [org] = await tx.query("SELECT body->>'governance' AS governance FROM mes.organization WHERE status = 'published'");
        const body = { ...builtIn, stewards: { object: [org?.governance ?? "engineering"] } };
        // Its rule scripts come with it (a script of that name already here, the plant's own, is kept).
        for (const rule of builtIn.rules ?? []) {
            const source = BUILT_IN_SCRIPTS[rule.script];
            if (source) await tx.query("INSERT INTO mes.scripts (name, version, status, source, tests) SELECT $1, 1, 'published', $2, '[]' WHERE NOT EXISTS (SELECT 1 FROM mes.scripts WHERE name = $1)", [rule.script, source]);
        }
        await tx.query("INSERT INTO mes.definitions (object, version, status, body) VALUES ($1, 1, 'published', $2)", [builtIn.object, JSON.stringify(body)]);
        await tx.query(`CREATE TABLE IF NOT EXISTS mes."records_${builtIn.object}" PARTITION OF mes.records FOR VALUES IN ('${builtIn.object}')`);
        await appendAudit(tx, { actor: "platform", object: builtIn.object, recordId: null, defVersion: 1, action: "publish:built-in", after: { object: builtIn.object, version: 1 } });
        done.push({ name: `built-in:${builtIn.object}`, action: "applied" });
    }
    // Its first holders, once (BUILT_IN_FIRST_ROLES): the designers, where nobody holds a role on it yet.
    for (const [object, first] of Object.entries(BUILT_IN_FIRST_ROLES)) {
        const role = typeof first === "string" ? first : first.role;
        const [like, likeRole] = typeof first === "string" ? ["design", "designer"] : first.of;
        const mark = `built-in-roles:${object}`;
        const [seen] = await tx.query("SELECT 1 FROM mes.schema_migrations WHERE name = $1", [mark]);
        if (seen) continue;
        const [live] = await tx.query("SELECT body FROM mes.definitions WHERE object = $1 AND status = 'published'", [object]);
        const [held] = await tx.query("SELECT 1 FROM mes.assignments WHERE object = $1 LIMIT 1", [object]);
        let given = [];
        // (Those who hold another role, `of`, are given theirs whoever else holds one already.)
        if (live?.body?.builtIn && (!held || typeof first !== "string")) {
            given = await tx.query(
                `INSERT INTO mes.assignments (subject_kind, subject_id, object, role)
                 SELECT DISTINCT subject_kind, subject_id, $1, $2 FROM mes.assignments WHERE object = $3 AND role = $4
                 ON CONFLICT DO NOTHING RETURNING subject_kind, subject_id`, [object, role, like, likeRole]);
            if (given.length) await appendAudit(tx, { actor: "platform", object, recordId: null, defVersion: null, action: "roles:built-in", after: { role, to: given.map((g) => `${g.subject_kind}:${g.subject_id}`) } });
        }
        await tx.query("INSERT INTO mes.schema_migrations (name, checksum) VALUES ($1, 'once') ON CONFLICT DO NOTHING", [mark]);
        if (given.length) done.push({ name: mark, action: "applied", note: `${role} given to ${given.map((g) => g.subject_id).join(", ")}` });
    }
    const people = await syncPeople(tx, { actor: "platform" });
    if (people) done.push({ name: "built-in:person records", action: "applied", note: `${people} kept in step` });
    return done;
}

// Run directly: migrate DATABASE_URL.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    const { default: pg } = await import("pg");
    const { fromPg } = await import("@opencore-mes/juris-kit/server/db.js");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
    try {
        const done = await migrate(fromPg(pool), { log: console });
        if (!done.length) console.log("database: up to date");
    } finally {
        await pool.end();
    }
}
