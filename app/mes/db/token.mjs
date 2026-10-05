// Issues a token for an integration user (§15.2), which an outside system (ERP, a LIMS) sends as
// `Authorization: Bearer mes_…` to call the web services at /svc/v1/. It is printed once; only its
// hash is kept. Which services the user may call is the services' design (their callers), approved
// like any change; the token only says who is calling.
//
//   node app/mes/db/token.mjs erp "ERP production" [--days 365]
//   DATABASE_URL  default postgres:///openmes_poc
// It lasts --days (90 by default, at most 365): issue the next one before it ends. Issuing it is in the
// audit trail, by the operating system's user who ran this.
import pg from "pg";
import { fromPg } from "../../../src/server/db.js";
import { createTokens } from "../server/ai-api.js";

const args = process.argv.slice(2);
const at = args.indexOf("--days");
const days = at >= 0 ? Number(args.splice(at, 2)[1]) : 90;
const [user, name] = args;
if (!user || !name || !Number.isInteger(days)) {
    console.error('usage: node app/mes/db/token.mjs <user> "<token name>" [--days 1..365]');
    process.exit(2);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
try {
    const [known] = await pool.query("SELECT id FROM mes.users WHERE id = $1 AND active", [user]).then((r) => r.rows);
    if (!known) throw new Error(`no active user ${user}`);
    const issued = await createTokens(fromPg(pool)).issue(user, { name, agent: "integration", scopes: ["service:call"], days, by: `os:${process.env.USER ?? "unknown"}` });
    console.log(`token for ${user} (${issued.name}), scope service:call, until ${issued.expires_at.toISOString().slice(0, 10)} — shown once:\n${issued.token}`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    await pool.end();
}
