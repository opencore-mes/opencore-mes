// A one-time link for a person to set their own password (§8.2): for someone new, or who has forgotten
// theirs. The link is printed once, here, and only its hash is kept; it works for PASSWORD_LINK_DAYS days (3 unless set; --days for another, up to 14), once, and
// replaces any earlier link for the same person. Giving it out is in the audit trail.
//
//   node app/mes/db/password.mjs <sign-in id> [--url https://mes.plant.example] [--days 1..14]
//   (how long it lasts: PASSWORD_LINK_DAYS unless --days says, 3 unless set; --hours still works)
//
// DATABASE_URL names the database (default the local openmes_poc). Whoever runs this can reach the
// database, so can already do more than this; it is IT's tool, not a page.
import os from "node:os";
import pg from "pg";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { issuePasswordLink, linkDaysOf, LINK_MAX_DAYS } from "../server/sign-in.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : fallback; };
const base = opt("url", `http://127.0.0.1:${process.env.PORT ?? 9090}`).replace(/\/$/, "");
const daysGiven = opt("days", null);
const hoursGiven = opt("hours", null);
const hours = hoursGiven !== null ? Number(hoursGiven) : Number(daysGiven ?? linkDaysOf(process.env)) * 24;
const [user] = args;
if (!user || !Number.isInteger(hours) || hours <= 0 || hours > 24 * LINK_MAX_DAYS) {
    console.error(`usage: node app/mes/db/password.mjs <sign-in id> [--url https://mes.plant.example] [--days 1..${LINK_MAX_DAYS}]`);
    process.exit(2);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
try {
    const { path } = await issuePasswordLink(fromPg(pool), user, { by: `it:${os.userInfo().username}`, hours });
    const lasts = hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? "" : "s"}` : `${hours} hours`;
    console.log(`A link for ${user} to set their password, for ${lasts}, once:\n\n  ${base}${path}\n\nGive it to them only: whoever opens it first sets the password.`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    await pool.end();
}
