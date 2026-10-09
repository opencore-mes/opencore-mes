// The audit trail out of the application's reach (ops/db/protect-audit.sql, COMPLIANCE.md G3), end to end, on a
// database of its own (the shared test database stays as it is): made, owned by a stand-in for the application's
// role as a plant's is, then protected by the administrator's script. As the application, every write still
// reaches the trail (a record changed over HTTP, an entry appended by hand), the migrations run clean at start,
// and the chain verifies; and nothing written can be changed, deleted, truncated, dropped or have its trigger
// switched off; a reset is refused. The application replacing the view it writes through changes nothing the check reads.
//
// It needs a superuser (to make the role and act as it): without one (the demo server's pipeline) it says so and
// passes.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/audit-protect.mjs
import pg from "pg";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { appendAudit, checkAudit } from "../server/audit.js";
import { migrate } from "../db/migrate.mjs";
import { createApp } from "../app.mjs";

const run = promisify(execFile);
const base = process.env.DATABASE_URL ?? "postgres:///openmes_test";
const urlOf = (name) => { const u = new URL(base); u.pathname = `/${name}`; return u.toString(); };
const NAME = `${new URL(base).pathname.slice(1)}_protect`;
const APP = "openmes_test_app";
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const refused = (p) => p.then(() => ({ refused: false }), (e) => ({ refused: true, message: e.message }));

const admin = new pg.Pool({ connectionString: base, max: 1 });
let made = false, owner = null, appPool = null, app = null;
try {
    const [me] = (await admin.query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")).rows;
    if (!me?.rolsuper) {
        step("skipped: this connection is not a superuser, needed to make the application's stand-in role (the pipeline on a developer's machine and in CI runs it)", true);
    } else {
        if (!/test/.test(NAME)) throw new Error(`refusing ${NAME}: not a test database`);
        await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
        await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP}') THEN CREATE ROLE ${APP} NOLOGIN; END IF; END $$`);
        await admin.query(`CREATE DATABASE ${NAME}`);
        made = true;
        const r = await run(process.execPath, [fileURLToPath(new URL("../db/reset.mjs", import.meta.url))], { env: { ...process.env, DATABASE_URL: urlOf(NAME) } });
        step("a database of its own, made and seeded", /./.test(r.stdout + r.stderr));

        // Owned by the application's role, as a plant's database is: the schema and everything in it.
        owner = new pg.Pool({ connectionString: urlOf(NAME), max: 1 });
        await owner.query(`ALTER DATABASE ${NAME} OWNER TO ${APP}`);
        await owner.query(`DO $$ DECLARE o record; BEGIN
            FOR o IN SELECT nspname FROM pg_namespace WHERE nspname IN ('mes', 'q') LOOP EXECUTE format('ALTER SCHEMA %I OWNER TO ${APP}', o.nspname); END LOOP;
            FOR o IN SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('mes', 'q') AND c.relkind IN ('r', 'v', 'S', 'p', 'm') AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i'))) LOOP
                EXECUTE format('ALTER %s %I.%I OWNER TO ${APP}', CASE o.relkind WHEN 'v' THEN 'VIEW' WHEN 'S' THEN 'SEQUENCE' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END, o.nspname, o.relname);
            END LOOP;
            FOR o IN SELECT p.oid::regprocedure AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'mes' LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO ${APP}', o.f); END LOOP;
        END $$`);

        // Unprotected, the application could switch the trigger off: what the script is for.
        appPool = new pg.Pool({ connectionString: urlOf(NAME), options: `-c role=${APP}`, max: 4 });
        const asApp = fromPg(appPool);
        await asApp.query("ALTER TABLE mes.audit_log DISABLE TRIGGER audit_no_update");
        await asApp.query("ALTER TABLE mes.audit_log ENABLE TRIGGER audit_no_update");
        step("unprotected, the application's role could switch the trail's trigger off", true);

        // The administrator's script, as psql would run it (its \ commands and :"app" taken as psql takes them).
        const script = readFileSync(fileURLToPath(new URL("../../../ops/db/protect-audit.sql", import.meta.url)), "utf8")
            .split("\n").filter((l) => !/^\\/.test(l)).join("\n").replaceAll(':"app"', `"${APP}"`);
        await owner.query(script);
        await owner.query(script);
        step("the script runs, and runs again", true);

        // As the application: everything as before.
        const before = (await owner.query("SELECT count(*)::int AS n FROM audit.audit_log")).rows[0].n;
        await asApp.transaction((tx) => appendAudit(tx, { actor: "test", object: "$test", action: "protected append" }));
        const out = await migrate(asApp, { log: {} }).then(() => null, (e) => e.message);
        step("as the application, the migrations run clean at start", out === null, out);
        app = await createApp({ db: asApp, dev: false, build: "test", outboxEveryMs: 0 });
        const { url } = await app.listen({ port: 0 });
        const session = `ap-${randomBytes(8).toString("hex")}`;
        await asApp.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, 'sam', now() + interval '1 hour')", [session]);
        const [wo] = await asApp.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1001'");
        const res = await fetch(`${url}/api/records.create`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${session}` }, body: JSON.stringify([{ object: "lot", data: { lot_no: `AP${Date.now() % 100000}`, item: "PA66-NAT-25", work_order: wo.id, qty: 10, uom: "kg" }, key: session }]) });
        const lot = await res.json();
        const [entry] = (await owner.query("SELECT actor, action FROM audit.audit_log WHERE record_id = $1", [lot.id])).rows;
        const after = (await owner.query("SELECT count(*)::int AS n FROM audit.audit_log")).rows[0].n;
        step("as the application, a record made over HTTP and an entry appended by hand both reach the protected trail",
            res.ok && entry?.actor === "sam" && after >= before + 2, { status: res.status, lot, entry, before, after });
        const again = await run(process.execPath, [fileURLToPath(new URL("../db/reset.mjs", import.meta.url))], { env: { ...process.env, DATABASE_URL: urlOf(NAME) } }).then(() => ({ code: 0 }), (e) => ({ code: e.code, err: e.stderr }));
        step("a reset of the protected database is refused, and changes nothing", again.code === 2 && /is protected/.test(again.err), again);
        const sound = await checkAudit(asApp, { full: true });
        step("the chain verifies, read where it is kept", sound.ok && sound.checked === after, sound);

        // …and nothing written can be changed.
        const tries = {
            "update an entry": "UPDATE mes.audit_log SET actor = 'x' WHERE seq = 1",
            "delete an entry": "DELETE FROM mes.audit_log WHERE seq = 1",
            "update the table itself": "UPDATE audit.audit_log SET actor = 'x' WHERE seq = 1",
            "truncate": "TRUNCATE audit.audit_log",
            "switch the trigger off": "ALTER TABLE audit.audit_log DISABLE TRIGGER audit_no_update",
            "drop the table": "DROP TABLE audit.audit_log CASCADE",
            "replace the trigger's function": "CREATE OR REPLACE FUNCTION audit.audit_is_append_only() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql",
            "drop the schema": "DROP SCHEMA audit CASCADE",
        };
        const results = {};
        for (const [what, sql] of Object.entries(tries)) results[what] = await refused(asApp.query(sql));
        step("as the application, none of these is possible: " + Object.keys(tries).join(", "), Object.values(results).every((r) => r.refused), results);

        // The application replacing the view it writes through: its own entries go elsewhere; the trail is untouched.
        await asApp.query("DROP VIEW mes.audit_log");
        await asApp.query("CREATE TABLE mes.audit_log AS SELECT * FROM audit.audit_log WHERE false");
        const still = await checkAudit(asApp, { full: true });
        step("the view replaced by the application, the check still reads the trail itself, whole and sound", still.ok && still.checked === after, still);
    }
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close?.().catch(() => {});
    await appPool?.end().catch(() => {});
    await owner?.end().catch(() => {});
    if (made) {
        await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`).catch(() => {});
        await admin.query(`DROP OWNED BY ${APP}`).catch(() => {});
        await admin.query(`DROP ROLE IF EXISTS ${APP}`).catch(() => {});
    }
    await admin.end();
}
const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
