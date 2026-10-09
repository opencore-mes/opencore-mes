// Rebuilds the state intervals (analytics, §22) from the audit trail: for a database made before
// they existed, or to check that the live ones agree with the trail. Idempotent.
//   DATABASE_URL=postgres:///openmes_poc node app/mes/db/rebuild-intervals.mjs [object]
import pg from "pg";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { rebuildIntervals } from "../server/analytics.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const only = process.argv[2] ?? null;
const definitions = (await db.query("SELECT body FROM mes.definitions WHERE status = 'published' ORDER BY object")).map((r) => r.body);
const written = await rebuildIntervals(db, definitions, { only });
console.log(`state intervals rebuilt${only ? ` for ${only}` : ""}: ${written} stay(s) for ${definitions.filter((d) => !only || d.object === only).length} object(s)`);
await pool.end();
