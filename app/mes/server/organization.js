// The organization (DESIGN.md §5.6, §8) as one design element: people, departments (members and
// approval steps), groups, role assignments, governance and standing approvers. It lives in the
// tables everything already reads (users, groups, group_members, department_reps, assignments), plus
// mes.organization for what has no table (governance, standing approvers, step labels, who reads every
// record). A change
// carries a whole snapshot; executing it writes the tables to match, in the change's transaction.

import { appendAudit } from "./audit.js";

const sorted = (list) => [...new Set(list)].sort();

// The published settings: { version, governance, standing, steps: { department: [labels] } }.
export async function organizationSettings(q) {
    const [row] = await q.query("SELECT version, body FROM mes.organization WHERE status = 'published'");
    return row ? { version: row.version, ...row.body } : { version: null, governance: "engineering", standing: {}, steps: {} };
}

// A department's approval steps, in order: [{ step, label, approvers: [users] }].
export async function stepsOf(q, department, settings = null) {
    const labels = (settings ?? (await organizationSettings(q))).steps?.[department] ?? [];
    const reps = await q.query("SELECT step, user_id FROM mes.department_reps WHERE group_id = $1 ORDER BY step, user_id", [department]);
    const byStep = new Map();
    for (const r of reps) (byStep.get(r.step) ?? byStep.set(r.step, []).get(r.step)).push(r.user_id);
    return [...byStep].sort(([a], [b]) => a - b).map(([step, approvers], i, all) => ({ step, label: labels[step - 1] ?? (all.length === 1 ? "Approver" : `Step ${step}`), approvers }));
}

// The organization as it is now, as the snapshot a change edits.
export async function organizationSnapshot(q) {
    const settings = await organizationSettings(q);
    const users = await q.query("SELECT id, name, active FROM mes.users ORDER BY id");
    const groups = await q.query("SELECT id, name, kind FROM mes.groups ORDER BY id");
    const members = await q.query("SELECT group_id, user_id FROM mes.group_members ORDER BY user_id");
    const assignments = await q.query("SELECT subject_kind, subject_id, object, role FROM mes.assignments ORDER BY object, role, subject_kind, subject_id");
    const org = { version: settings.version, governance: settings.governance, standing: settings.standing ?? {}, formats: settings.formats ?? {}, theme: settings.theme ?? {}, readers: settings.readers ?? [], users: {}, departments: {}, groups: {}, roles: {} };
    for (const u of users) org.users[u.id] = { name: u.name, active: u.active };
    for (const g of groups) {
        const m = members.filter((x) => x.group_id === g.id).map((x) => x.user_id);
        if (g.kind === "department") org.departments[g.id] = { name: g.name, members: m, approval: (await stepsOf(q, g.id, settings)).map(({ label, approvers }) => ({ label, approvers })) };
        else org.groups[g.id] = { name: g.name, members: m };
    }
    for (const a of assignments) ((org.roles[a.object] ??= {})[a.role] ??= []).push(`${a.subject_kind}:${a.subject_id}`);
    return org;
}

// Writes an approved snapshot to the tables (the change's transaction). People are never deleted
// (the audit trail names them): one left out is made inactive.
export async function applyOrganization(tx, org, version) {
    const now = await organizationSnapshot(tx);
    for (const [id, u] of Object.entries(org.users ?? {})) {
        await tx.query("INSERT INTO mes.users (id, name, active) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = $2, active = $3", [id, u.name, u.active !== false]);
    }
    for (const id of Object.keys(now.users)) if (!org.users?.[id]) await tx.query("UPDATE mes.users SET active = false WHERE id = $1", [id]);
    const groups = { ...Object.fromEntries(Object.entries(org.departments ?? {}).map(([id, d]) => [id, { ...d, kind: "department" }])), ...Object.fromEntries(Object.entries(org.groups ?? {}).map(([id, g]) => [id, { ...g, kind: "group" }])) };
    for (const [id, g] of Object.entries(groups)) {
        await tx.query("INSERT INTO mes.groups (id, name, kind) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = $2, kind = $3", [id, g.name, g.kind]);
        await tx.query("DELETE FROM mes.group_members WHERE group_id = $1", [id]);
        for (const m of sorted(g.members ?? [])) await tx.query("INSERT INTO mes.group_members (group_id, user_id) VALUES ($1, $2)", [id, m]);
    }
    // A plain group left out loses its members (it may still be named in history); departments stay.
    for (const id of Object.keys(now.groups)) if (!groups[id]) await tx.query("DELETE FROM mes.group_members WHERE group_id = $1", [id]);
    await tx.query("DELETE FROM mes.department_reps");
    for (const [id, d] of Object.entries(org.departments ?? {})) {
        for (const [k, st] of (d.approval ?? []).entries()) for (const a of sorted(st.approvers ?? [])) await tx.query("INSERT INTO mes.department_reps (group_id, user_id, step) VALUES ($1, $2, $3)", [id, a, k + 1]);
    }
    await tx.query("DELETE FROM mes.assignments");
    for (const [object, roles] of Object.entries(org.roles ?? {})) {
        for (const [role, subjects] of Object.entries(roles ?? {})) {
            for (const s of sorted(subjects ?? [])) {
                const [kind, sid] = s.split(":");
                await tx.query("INSERT INTO mes.assignments (subject_kind, subject_id, object, role) VALUES ($1, $2, $3, $4)", [kind, sid, object, role]);
            }
        }
    }
    const steps = Object.fromEntries(Object.entries(org.departments ?? {}).map(([id, d]) => [id, (d.approval ?? []).map((st) => st.label)]));
    await tx.query("UPDATE mes.organization SET status = 'superseded' WHERE status = 'published'");
    await tx.query("INSERT INTO mes.organization (version, status, body) VALUES ($1, 'published', $2)", [version, JSON.stringify({ governance: org.governance, standing: org.standing ?? {}, steps, formats: org.formats ?? {}, theme: org.theme ?? {}, readers: [...new Set(org.readers ?? [])].sort() })]);
    await syncPeople(tx);
}

// The built-in Person object (builtins.js): one record per person, kept in step with the people here,
// in the same transaction as the change that moved them: made for someone new, renamed, made inactive;
// never deleted (the audit trail names them). Written as the platform, audited, its other fields (what
// the plant added) left as they are. Nothing when Person is not the built-in one (a plant's own
// "person" object, made before the platform had one). → how many records it made or changed.
export async function syncPeople(tx, { actor = "platform:organization" } = {}) {
    const [def] = await tx.query("SELECT version, body FROM mes.definitions WHERE object = 'person' AND status = 'published'");
    if (!def?.body?.builtIn) return 0;
    const users = await tx.query("SELECT id, name, active FROM mes.users ORDER BY id");
    const byUser = new Map((await tx.query("SELECT id, data, state FROM mes.records WHERE object = 'person'")).map((r) => [r.data?.user, r]));
    let n = 0;
    for (const u of users) {
        const want = { user: u.id, name: u.name, active: u.active };
        const have = byUser.get(u.id);
        if (!have) {
            const state = def.body.states?.initial ?? "active";
            const [row] = await tx.query("INSERT INTO mes.records (object, def_version, state, data, created_by, updated_by) VALUES ('person', $1, $2, $3, $4, $4) RETURNING id", [def.version, state, JSON.stringify(want), actor]);
            await appendAudit(tx, { actor, object: "person", recordId: row.id, defVersion: def.version, action: "create", after: { ...want, state } });
            n++;
        } else if (have.data?.name !== u.name || have.data?.active !== u.active) {
            const [row] = await tx.query("UPDATE mes.records SET data = data || $2::jsonb, row_version = row_version + 1, updated_at = now(), updated_by = $3 WHERE object = 'person' AND id = $1 RETURNING data, state", [have.id, JSON.stringify(want), actor]);
            await appendAudit(tx, { actor, object: "person", recordId: have.id, defVersion: def.version, action: "update", after: { ...row.data, state: row.state } });
            n++;
        }
    }
    return n;
}

// The snapshot without what a change does not carry (its version).
export const draftOf = ({ version, ...org }) => org;
