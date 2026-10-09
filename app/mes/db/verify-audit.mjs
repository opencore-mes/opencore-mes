// Verifies the audit trail's hash chain (§7.3, COMPLIANCE.md G3), from where the last check reached, or from
// the first entry with --full: each entry follows the one before it, none changed since it was written, and the
// chain ends where its head says. Prints what it found; exits 1 on a break. The scheduled check (every quarter
// of an hour, /healthz `audit`) does the same; this is the one to run by hand, or for an auditor.
//
//   node app/mes/db/verify-audit.mjs [--full]
//   DATABASE_URL  default postgres:///openmes_poc
import pg from "pg";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { checkAudit } from "../server/audit.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
try {
    const r = await checkAudit(fromPg(pool), { full: process.argv.includes("--full") });
    if (r.ok) console.log(`audit trail sound: ${r.checked} entr${r.checked === 1 ? "y" : "ies"} checked, verified up to entry ${r.verifiedTo} (${r.at})`);
    else console.log(`audit trail BROKEN at entry ${r.brokenAt}: ${r.problem} (sound up to entry ${r.verifiedTo})`);
    process.exitCode = r.ok ? 0 : 1;
} catch (error) {
    console.error(error.message);
    process.exitCode = 2;
} finally {
    await pool.end();
}
