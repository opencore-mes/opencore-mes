// The first administrator of a plant's own, empty installation (DESIGN.md §27.1a; server/first-admin.js):
// a designer and reviewer and the sign-in administrator, in the first department, which governs. Refused
// once anybody is in People & departments. A one-time link to set their password is printed (unless they
// sign in through the plant's directory or identity provider: --no-password).
//
//   node app/mes/db/admin.mjs <sign-in id> "<Full name>" [--department <id>] [--department-name "<Name>"]
//                             [--no-password] [--days 1..14] [--url https://mes.plant.example]
//   opencore-mes admin …      the same, from a plant folder
//
// It opens setup too (§5.15): alone, they could get no change reviewed and approved; in setup their changes
// execute on their own signature until People & departments ends it, once others can review and approve.
// DATABASE_URL names the database (default the local openmes_poc). Whoever runs this can reach the
// database; it is IT's tool, not a page.
import os from "node:os";
import pg from "pg";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { nameFirstAdministrator } from "../server/first-admin.js";
import { issuePasswordLink, linkDaysOf, LINK_MAX_DAYS } from "../server/sign-in.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : fallback; };
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args.splice(i, 1), true) : false; };
const base = opt("url", `http://127.0.0.1:${process.env.PORT ?? 9090}`).replace(/\/$/, "");
const department = opt("department", "engineering");
const departmentName = opt("department-name", null);
const noPassword = flag("no-password");
const days = Number(opt("days", linkDaysOf(process.env)));
const [id, name] = args;
if (!id || !name || !Number.isInteger(days) || days < 1 || days > LINK_MAX_DAYS) {
    console.error('usage: opencore-mes admin <sign-in id> "<Full name>" [--department <id>] [--department-name "<Name>"] [--no-password] [--days 1..14] [--url https://mes.plant.example]');
    process.exit(2);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
try {
    const by = `it:${os.userInfo().username}`;
    const made = await nameFirstAdministrator(db, { id, name, department, departmentName, by });
    console.log(`${made.name} (${made.user}) is the first administrator: designer and reviewer, sign-in administrator, approver for ${made.departmentName}, which governs the organization.`);
    if (made.setup) console.log("Setup is open: their changes execute on their own signature, without review or approval, until People & departments ends it, once others can review and approve.");
    if (!noPassword) {
        const { path } = await issuePasswordLink(db, made.user, { by, hours: days * 24 });
        console.log(`\nA link for them to set their password, for ${days} day${days === 1 ? "" : "s"}, once:\n\n  ${base}${path}\n\nGive it to them only: whoever opens it first sets the password.`);
    } else console.log("They sign in through the plant's directory or identity provider, as their id says.");
} catch (error) {
    console.error(error.refused ? error.message : error.stack ?? error.message);
    process.exitCode = 1;
} finally {
    await pool.end();
}
