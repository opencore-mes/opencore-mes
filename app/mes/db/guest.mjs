// A public demo's guests (DESIGN.md §6.9): the people visitors arrive as, holding every role there is, so a
// link from the landing page opens any screen, record or design with nothing refused.
//
// The roles are the group Guests' (every role every published object declares, the designer's, the
// reviewer's, the query page's and sign-in administration; not the privacy officer's nor the integrity reviewer's), so a guest is a person in that group, in every
// department, and among each department's approvers (the first step):
//   - addGuest(db): the group, made again by the demo's nightly reset (SEED_GUEST=1), and the shared guest
//     ("guest"), whom the demo opens as (DEMO_AS=guest) when it gives no visitor a guest of their own;
//   - addSessionGuest(db): a guest of one visitor's own ("Guest 7F3K"), made as they arrive (the demo's
//     DEMO_GUESTS=session, auth.js): what they do is theirs in the audit trail, the designer and the inbox,
//     and two visitors may review and approve each other's changes.
// The platform's rules still hold: nobody reviews or approves their own change, a guest included, and every
// write goes through the services as the guest. Both are safe to run again.
import { randomBytes } from "node:crypto";
import { PSEUDO_ROLES } from "../client/definition.js";
import { syncPeople } from "../server/organization.js";
import { appendAudit } from "../server/audit.js";
import { sealDesigns, platformWrites, ACCESS } from "../server/integrity.js";

export const GUEST = { id: "guest", name: "Guest" };
export const GUESTS_GROUP = "guests";
// A visitor's own guest: "guest_" and a code (letters and digits no one misreads; a person's id is lower
// case), named "Guest" and the code in capitals.
export const SESSION_GUEST = /^guest_[a-z2-9]{4,8}$/;
const CODE = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// A person in the group Guests, in every department and first among its approvers.
async function joinGuests(tx, id) {
    await tx.query("INSERT INTO mes.group_members (group_id, user_id) SELECT g.id, $1 FROM mes.groups g WHERE g.id = $2 OR g.kind = 'department' ON CONFLICT DO NOTHING", [id, GUESTS_GROUP]);
    await tx.query("INSERT INTO mes.department_reps (group_id, user_id, step) SELECT g.id, $1, 1 FROM mes.groups g WHERE g.kind = 'department' ON CONFLICT DO NOTHING", [id]);
}

// Every role there is, to the group Guests: what it lacks is given (→ { grants, given: [[object, role]] }). All
// but the privacy officer's (§27.8): erasure passes over the objects' policies and the purge removes data, which
// one visitor must not do to what every visitor sees. Nor the integrity reviewer's (§7.7): closing a finding
// accepts a change made outside the platform, which is for the plant's own quality people.
const NOT_FOR_GUESTS = new Set(["privacy", "integrity"]);
async function grantAll(tx) {
    const grants = Object.entries(PSEUDO_ROLES).filter(([object]) => !NOT_FOR_GUESTS.has(object)).flatMap(([object, roles]) => roles.map((role) => [object, role]));
    for (const { object, roles } of await tx.query("SELECT object, body->'roles' AS roles FROM mes.definitions WHERE status = 'published'")) {
        for (const role of Array.isArray(roles) ? roles : []) if (typeof role === "string") grants.push([object, role]);
    }
    const given = [];
    for (const [object, role] of grants) {
        const [row] = await tx.query("INSERT INTO mes.assignments (subject_kind, subject_id, object, role) VALUES ('group', $1, $2, $3) ON CONFLICT DO NOTHING RETURNING id", [GUESTS_GROUP, object, role]);
        if (row) given.push([object, role]);
    }
    return { grants, given };
}

export async function addGuest(db, { id = GUEST.id, name = GUEST.name } = {}) {
    return db.transaction(async (tx) => {
        await platformWrites(tx);
        await tx.query("INSERT INTO mes.groups (id, name, kind) VALUES ($1, 'Guests (the demo''s visitors)', 'group') ON CONFLICT (id) DO NOTHING", [GUESTS_GROUP]);
        const { grants, given: newly } = await grantAll(tx);
        const given = newly.length;
        await tx.query("INSERT INTO mes.users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = $2, active = true", [id, name]);
        await joinGuests(tx, id);
        const [{ n: departments }] = await tx.query("SELECT count(*)::int AS n FROM mes.groups WHERE kind = 'department'");
        await appendAudit(tx, { actor: "seed", object: "$organization", recordId: null, defVersion: null, action: "demo:guest", after: { user: id, group: GUESTS_GROUP, roles: grants.length, departments } });
        await syncPeople(tx, { actor: "seed" });
        // The platform's own grant: people and roles sealed as they now are (§7.7).
        await sealDesigns(tx, undefined, [ACCESS]);
        return { roles: grants.length, given, departments };
    });
}

// After a change is executed on a training plant (DEMO_GUESTS_FOLLOW=1, app.mjs): an object it made live, or a role it added, is the
// group Guests' too, so a visitor keeps holding every role there is (a learner's copy of Lot opens for them
// at once). Nothing when the demo has no group Guests. Audited as the platform's, as the reset's grant is.
export async function keepGuestsWhole(db) {
    return db.transaction(async (tx) => {
        const [group] = await tx.query("SELECT 1 FROM mes.groups WHERE id = $1", [GUESTS_GROUP]);
        if (!group) return [];
        await platformWrites(tx);
        const { given } = await grantAll(tx);
        if (given.length) await sealDesigns(tx, undefined, [ACCESS]);
        if (given.length) await appendAudit(tx, { actor: "platform:demo", object: "$organization", recordId: null, defVersion: null, action: "demo:guest roles", after: { group: GUESTS_GROUP, given } });
        return given;
    });
}

// A visitor's own guest, made as they arrive: → { id, name }. The group Guests must be there (addGuest).
export async function addSessionGuest(db) {
    return db.transaction(async (tx) => {
        await platformWrites(tx);
        for (let attempt = 0; attempt < 5; attempt++) {
            const code = [...randomBytes(4)].map((b) => CODE[b % CODE.length]).join("");
            const user = { id: `guest_${code.toLowerCase()}`, name: `Guest ${code}` };
            const [made] = await tx.query("INSERT INTO mes.users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id", [user.id, user.name]);
            if (!made) continue;
            await joinGuests(tx, user.id);
            await syncPeople(tx, { actor: "platform:demo" });
            await sealDesigns(tx, undefined, [ACCESS]);
            return user;
        }
        throw new Error("no free guest code");
    });
}
