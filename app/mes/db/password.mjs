// A one-time link for a person to set their own password (§8.2): for someone new, or who has forgotten
// theirs. The link is printed once, here, and only its hash is kept; it works for 72 hours, once, and
// replaces any earlier link for the same person. Giving it out is in the audit trail.
//
//   node app/mes/db/password.mjs <sign-in id> [--url https://mes.plant.example] [--hours 72]
//
// DATABASE_URL names the database (default the local openmes_poc). Whoever runs this can reach the
// database, so can already do more than this; it is IT's tool, not a page.
import os from "node:os";
import pg from "pg";
import { fromPg } from "../../../src/server/db.js";
import { issuePasswordLink, LINK_HOURS } from "../server/sign-in.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : fallback; };
const base = opt("url", `http://127.0.0.1:${process.env.PORT ?? 9090}`).replace(/\/$/, "");
const hours = Number(opt("hours", LINK_HOURS));
const [user] = args;
if (!user || !Number.isFinite(hours) || hours <= 0 || hours > 24 * 14) {
    console.error("usage: node app/mes/db/password.mjs <sign-in id> [--url https://mes.plant.example] [--hours 1..336]");
    process.exit(2);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
try {
    const { path } = await issuePasswordLink(fromPg(pool), user, { by: `it:${os.userInfo().username}`, hours });
    console.log(`A link for ${user} to set their password, for ${hours} hours, once:\n\n  ${base}${path}\n\nGive it to them only: whoever opens it first sets the password.`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    await pool.end();
}
