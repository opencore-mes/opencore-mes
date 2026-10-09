// The database's schema, empty: the platform's tables (schema.sql, integration.sql, fitness.sql) and
// the change bus's outbox in the public schema (Juris pg-outbox.js). reset.mjs loads it before the
// seed; a sandbox's template (server/sandbox.js) loads it alone.
import { readFile } from "node:fs/promises";
import { SCHEMA as BUS_SCHEMA } from "@opencore-mes/juris-kit/server/bus/pg-outbox.js";

export async function loadSchema(pool) {
    for (const file of ["schema.sql", "integration.sql", "fitness.sql"]) await pool.query(await readFile(new URL(`./${file}`, import.meta.url), "utf8"));
    await pool.query("SET search_path = public; DROP TABLE IF EXISTS change_events CASCADE; DROP FUNCTION IF EXISTS change_events_notify() CASCADE;");
    await pool.query(BUS_SCHEMA);
}
