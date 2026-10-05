// The database upgrades itself (db/migrate.mjs), against the test database:
//   1. Up to date: nothing runs.
//   2. A database from before a migration (its table gone, its record gone): the migration runs, and
//      its first-time step with it.
//   3. A migration whose file changed (its checksum differs): it runs again, its first-time step not.
//   4. Two instances starting at once: each migration runs once.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/migrate.mjs
import pg from "pg";
import { fromPg } from "../../../src/server/db.js";
import { migrate } from "../db/migrate.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const quiet = { info() {} };
try {
    await migrate(db, { log: quiet });
    const idle = await migrate(db, { log: quiet });
    step("up to date: nothing runs", idle.length === 0, idle);

    // A database from before queries existed.
    await db.query("DELETE FROM mes.assignments WHERE object = 'query'");
    // The views built on it go with it; the next query rebuilds them (mes.query_views forgotten).
    await db.query("DROP TABLE mes.query_context CASCADE");
    await db.query("DELETE FROM mes.query_views");
    await db.query("DELETE FROM mes.schema_migrations WHERE name = 'queries'");
    const upgraded = await migrate(db, { log: quiet });
    const [{ exists }] = await db.query("SELECT to_regclass('mes.query_context') IS NOT NULL AS exists");
    const analysts = (await db.query("SELECT subject_id FROM mes.assignments WHERE object = 'query' ORDER BY subject_id")).map((r) => r.subject_id);
    step("a database from before a migration: it runs, with its first-time step (analysts: the designers and reviewers)", upgraded.length === 1 && upgraded[0].action === "applied" && exists && analysts.join() === "dana,eli,ines,iris,ivan,quinn,sam,vera", { upgraded, analysts });

    // A migration file changed since it ran.
    await db.query("UPDATE mes.schema_migrations SET checksum = 'old' WHERE name = 'integration'");
    await db.query("DELETE FROM mes.assignments WHERE object = 'query' AND subject_id = 'vera'");
    const changed = await migrate(db, { log: quiet });
    const [{ vera }] = await db.query("SELECT count(*)::int AS vera FROM mes.assignments WHERE object = 'query' AND subject_id = 'vera'");
    step("a changed migration runs again; a first-time step does not", changed.length === 1 && changed[0].name === "integration" && changed[0].action === "re-applied" && vera === 0, changed);
    await db.query("INSERT INTO mes.assignments (subject_kind, subject_id, object, role) VALUES ('user', 'vera', 'query', 'analyst') ON CONFLICT DO NOTHING");

    // Two instances at once.
    await db.query("UPDATE mes.schema_migrations SET checksum = 'old' WHERE name IN ('archive', 'event-log')");
    const [a, b] = await Promise.all([migrate(db, { log: quiet }), migrate(db, { log: quiet })]);
    step("two instances starting at once: each migration runs once", a.length + b.length === 2, { a, b });
} catch (error) {
    step("unexpected", false, { message: error.message });
} finally {
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
console.log(JSON.stringify(steps, null, 1));
console.log(failed.length ? `\n${failed.length} step(s) FAILED` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
