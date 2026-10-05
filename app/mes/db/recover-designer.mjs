// Emergency recovery when nobody is left who can change the system (DESIGN.md §27.1): no active
// designer, so no change can be started, the one that would fix it included; or a designer with
// nobody else to review, so none can be reviewed. People & departments refuses such a change now;
// this is for an installation that got there anyway (before that check, or by editing the database).
// It gives the roles on the console, outside the lifecycle, and records them in the audit trail with
// who ran it and why. It refuses while the system can still be changed: then the fix is a change.
//
//   node app/mes/db/recover-designer.mjs dana --reviewer vera "Design roles removed by change f9b64f28"
//   npm run training -- --recover-designer dana --reviewer vera "…"    (the training instance)
//   DATABASE_URL  default postgres:///openmes_poc
// --reviewer is needed only when nobody besides the designer could review.
//
// Then the designer starts a change to People & departments that puts the roles right; the reviewer
// reviews it, and it is approved like any other.
import os from "node:os";
import pg from "pg";
import { fromPg } from "../../../src/server/db.js";
import { appendAudit } from "../server/audit.js";

const args = process.argv.slice(2);
const at = args.indexOf("--reviewer");
const reviewer = at >= 0 ? args[at + 1] : null;
const [user, reason] = args.filter((_, k) => at < 0 || (k !== at && k !== at + 1));
if (!user || !String(reason ?? "").trim() || (at >= 0 && !reviewer)) {
    console.error('usage: node app/mes/db/recover-designer.mjs <designer> [--reviewer <user>] "<why>"');
    process.exit(2);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
// The active people holding a role on the designer, directly or through a group.
const holders = (tx, roles) => tx.query(
    `SELECT DISTINCT u.id FROM mes.assignments a
     JOIN mes.users u ON u.active AND ((a.subject_kind = 'user' AND u.id = a.subject_id)
         OR (a.subject_kind = 'group' AND u.id IN (SELECT user_id FROM mes.group_members WHERE group_id = a.subject_id)))
     WHERE a.object = 'design' AND a.role = ANY($1) ORDER BY u.id`, [roles]).then((rows) => rows.map((r) => r.id));
try {
    await db.transaction(async (tx) => {
        const designers = await holders(tx, ["designer"]);
        const able = await holders(tx, ["designer", "reviewer"]);
        if (designers.length && able.length >= 2) throw new Error(`The system can still be changed (designers: ${designers.join(", ")}; reviewers: ${able.filter((u) => !designers.includes(u)).join(", ") || "the other designers"}): change People & departments through the designer instead.`);
        for (const id of [user, reviewer].filter(Boolean)) {
            const [known] = await tx.query("SELECT 1 FROM mes.users WHERE id = $1 AND active", [id]);
            if (!known) throw new Error(`No active person "${id}".`);
        }
        if (reviewer === user) throw new Error("The reviewer is someone other than the designer: an author never reviews their own change.");
        const after = new Set([...able, user, ...(reviewer ? [reviewer] : [])]);
        if (after.size < 2) throw new Error(`Nobody besides ${user} could review: name one with --reviewer <user>.`);
        const given = [];
        if (!designers.includes(user)) given.push([user, "designer"]);
        if (reviewer && !able.includes(reviewer)) given.push([reviewer, "reviewer"]);
        for (const [id, role] of given) {
            await tx.query("INSERT INTO mes.assignments (subject_kind, subject_id, object, role) VALUES ('user', $1, 'design', $2) ON CONFLICT DO NOTHING", [id, role]);
            await appendAudit(tx, { actor: "console", object: "$organization", action: "recovery:design-role", after: { user: id, role: `design:${role}`, reason: reason.trim(), by: os.userInfo().username, host: os.hostname() } });
        }
        console.log(`${given.map(([id, role]) => `${id} is a ${role}`).join("; ") || "Nothing to give"}, recorded in the audit trail. Next: as ${user}, change People & departments to put the roles right${reviewer ? `; ${reviewer} reviews it` : ""}, and it is approved like any change.`);
    });
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    await pool.end();
}
