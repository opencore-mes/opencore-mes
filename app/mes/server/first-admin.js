// The first administrator of a plant's own installation (DESIGN.md §27.1a): an empty installation
// (`reset.mjs --empty`) has nobody, so nobody could sign in or start the change that adds people. IT names
// the first person from the server's console (`opencore-mes admin`, db/admin.mjs): a designer and reviewer
// and the sign-in administrator, member and approver of the first department, which is the organization's
// governance. Refused once anybody is in People & departments: from then on people are added only through
// a change, as everything else is. As the platform, in one transaction, audited with who ran it.
// It opens setup (§5.15) too: alone, they could get nothing reviewed and approved (an author never reviews
// or approves their own change, so the normal path needs two more people); in setup their changes execute on
// their own signature until People & departments ends it, once others can review and approve.
import { appendAudit } from "./audit.js";
import { syncPeople } from "./organization.js";
import { platformWrites, sealDesigns, ACCESS } from "./integrity.js";
import { setupRefusal } from "./setup.js";
import { IDENTIFIER, PERSON_ID } from "../client/definition.js";

// What they hold: change the system (and review, until there is someone else), and look after sign-ins.
export const FIRST_ROLES = [["design", "designer"], ["design", "reviewer"], ["auth", "administrator"]];

const refuse = (message) => { throw Object.assign(new Error(message), { refused: true }); };

// → { user, department, version, setup }; throws with `refused` for what IT must put right.
export async function nameFirstAdministrator(db, { id, name, department = "engineering", departmentName = null, by }) {
    const who = String(id ?? "").trim().toLowerCase();
    const called = String(name ?? "").trim();
    const dept = String(department ?? "").trim().toLowerCase();
    if (!PERSON_ID.test(who)) refuse(`"${id ?? ""}" is not a sign-in id: lower case letters, digits, _ and -, starting with a letter or a digit (an employee number such as 104523 is one; the id your directory or identity provider knows them by, if they sign in through it).`);
    if (!called) refuse("Give their name as people should read it: opencore-mes admin <id> \"<Full name>\".");
    if (!IDENTIFIER.test(dept)) refuse(`"${department}" is not a department id: lower case letters, digits and _.`);
    const deptName = String(departmentName ?? "").trim() || dept.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    return db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('mes.first-admin'))");
        const [{ n }] = await tx.query("SELECT count(*)::int AS n FROM mes.users");
        if (n) refuse(`People & departments has ${n} ${n === 1 ? "person" : "people"} already: the first administrator is named on an empty installation only. Add people there, through a change (Design → People & departments); if nobody can change the system any more, see db/recover-designer.mjs.`);
        await platformWrites(tx);
        await tx.query("INSERT INTO mes.users (id, name, active) VALUES ($1, $2, true)", [who, called]);
        await tx.query("INSERT INTO mes.groups (id, name, kind) VALUES ($1, $2, 'department') ON CONFLICT (id) DO NOTHING", [dept, deptName]);
        await tx.query("INSERT INTO mes.group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [dept, who]);
        await tx.query("INSERT INTO mes.department_reps (group_id, user_id, step) VALUES ($1, $2, 1) ON CONFLICT DO NOTHING", [dept, who]);
        for (const [object, role] of FIRST_ROLES) await tx.query("INSERT INTO mes.assignments (subject_kind, subject_id, object, role) VALUES ('user', $1, $2, $3) ON CONFLICT DO NOTHING", [who, object, role]);
        // The organization: its governance is this department; setup opened too when IT asked for it.
        const [live] = await tx.query("SELECT version, body FROM mes.organization WHERE status = 'published' FOR UPDATE");
        const opening = !(await setupRefusal(tx));
        const body = { ...(live?.body ?? {}), governance: dept, ...(opening ? { setup: { open: true } } : {}) };
        const version = (live?.version ?? 0) + 1;
        if (live) await tx.query("UPDATE mes.organization SET status = 'superseded' WHERE status = 'published'");
        await tx.query("INSERT INTO mes.organization (version, status, body) VALUES ($1, 'published', $2)", [version, JSON.stringify(body)]);
        // The platform's built-in objects (Person…) were stewarded, when published, by a governance there was not
        // yet: by this department now. The same version (nothing is recorded on them yet), so no change is needed.
        for (const d of await tx.query("SELECT object, version, body FROM mes.definitions WHERE status = 'published' AND (body->>'builtIn')::boolean")) {
            const stewards = d.body.stewards?.object ?? [];
            if (stewards.length && stewards.every((s) => s === dept)) continue;
            const [{ exists }] = await tx.query("SELECT bool_and(EXISTS (SELECT 1 FROM mes.groups g WHERE g.id = s)) AS exists FROM unnest($1::text[]) AS s", [stewards]);
            if (stewards.length && exists) continue;
            await tx.query("UPDATE mes.definitions SET body = jsonb_set(body, '{stewards,object}', $3::jsonb) WHERE object = $1 AND version = $2", [d.object, d.version, JSON.stringify([dept])]);
        }
        await syncPeople(tx, { actor: by });
        await appendAudit(tx, { actor: by, object: "$organization", recordId: null, defVersion: version, action: "admin:first", after: { user: who, name: called, department: dept, governance: dept, roles: FIRST_ROLES.map(([o, r]) => `${o}:${r}`), version } });
        if (opening) await appendAudit(tx, { actor: by, object: "$organization", recordId: null, defVersion: version, action: "setup:opened", after: { version, how: "opencore-mes admin, on an empty installation: a designer's change executes on their signature until the organization ends it" } });
        // What the platform just wrote, sealed as it is (§7.7): people and roles, and the built-ins it re-stewarded.
        const builtIns = (await tx.query("SELECT object FROM mes.definitions WHERE status = 'published' AND (body->>'builtIn')::boolean")).map((r) => `definitions:${r.object}`);
        await sealDesigns(tx, undefined, [ACCESS, ...builtIns]);
        return { user: who, name: called, department: dept, departmentName: (await tx.query("SELECT name FROM mes.groups WHERE id = $1", [dept]))[0]?.name ?? deptName, version, setup: opening };
    });
}
