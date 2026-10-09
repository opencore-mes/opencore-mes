// Issues a token for an integration user (§15.2), which an outside system (ERP, a LIMS) sends as
// `Authorization: Bearer mes_…` to call the web services at /svc/v1/. It is printed once; only its
// hash is kept. Which services the user may call is the services' design (their callers), approved
// like any change; the token only says who is calling.
//
//   node app/mes/db/token.mjs erp "ERP production" [--days 365] [--scope design:read …] [--quiet]
//   DATABASE_URL  default postgres:///openmes_poc
// It lasts --days (90 by default, at most 365): issue the next one before it ends. Issuing it is in the
// audit trail, by the operating system's user who ran this. --scope (again for several) gives it other
// scopes than service:call: transaction:run to run the transactions published over HTTP, query:run to read
// the named queries published over HTTP (read only: the token for a BI tool), design:read for a reader of the
// designs through /ai/v1 (a course checking a learner's change, §37). --quiet prints the token alone, for a script that keeps it where its reader is.
import pg from "pg";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createTokens, SCOPES } from "../server/ai-api.js";

const args = process.argv.slice(2);
const take = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args.splice(at, 2)[1] : undefined; };
const days = Number(take("--days") ?? 90);
const scopes = [];
for (let s = take("--scope"); s !== undefined; s = take("--scope")) scopes.push(s);
const quiet = args.includes("--quiet") ? (args.splice(args.indexOf("--quiet"), 1), true) : false;
const [user, name] = args;
if (!user || !name || !Number.isInteger(days) || !scopes.every((s) => SCOPES.includes(s))) {
    console.error(`usage: node app/mes/db/token.mjs <user> "<token name>" [--days 1..365] [--scope ${SCOPES.join("|")} …] [--quiet]`);
    process.exit(2);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
try {
    const [known] = await pool.query("SELECT id FROM mes.users WHERE id = $1 AND active", [user]).then((r) => r.rows);
    if (!known) throw new Error(`no active user ${user}`);
    const issued = await createTokens(fromPg(pool)).issue(user, { name, agent: "integration", scopes: scopes.length ? scopes : ["service:call"], days, by: `os:${process.env.USER ?? "unknown"}` });
    if (quiet) console.log(issued.token);
    else console.log(`token for ${user} (${issued.name}), scope ${issued.scopes.join(", ")}, until ${issued.expires_at.toISOString().slice(0, 10)} — shown once:\n${issued.token}`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    await pool.end();
}
