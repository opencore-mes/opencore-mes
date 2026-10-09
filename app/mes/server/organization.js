// The organization (DESIGN.md §5.6, §8) as one design element: people, departments (members and
// approval steps), groups, role assignments, governance and standing approvers. It lives in the
// tables everything already reads (users, groups, group_members, department_reps, assignments), plus
// mes.organization for what has no table (governance, standing approvers, step labels, who reads every
// record, how long each kind of data is kept). A change
// carries a whole snapshot; executing it writes the tables to match, in the change's transaction.

import { appendAudit } from "./audit.js";
import { resealRecords, platformWrites } from "./integrity.js";

const sorted = (list) => [...new Set(list)].sort();

// The published settings: { version, governance, standing, steps: { department: [labels] } }.
// Setup (§5.15): kept once the organization has said it either way (an installation that never opened it has none).
const isPlainSetup = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && typeof v.open === "boolean";
// What the sign-in page calls the id people type, its hint, and the plant's domains a typed id may carry
// (§8.2): only what is set, or nothing.
const signInOf = (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const out = {};
    if (typeof v.idLabel === "string" && v.idLabel.trim()) out.idLabel = v.idLabel.trim();
    if (typeof v.idHint === "string" && v.idHint.trim()) out.idHint = v.idHint.trim();
    if (Array.isArray(v.domains) && v.domains.length) out.domains = [...new Set(v.domains.map((d) => String(d).trim()).filter(Boolean))];
    return Object.keys(out).length ? out : null;
};
// Whether the plant is being set up now: a designer's change executes on their signature alone.
export const setupOpen = (settings) => settings?.setup?.open === true;
// How much approval a change needs (§5.16): "full" (review, then each department; the default), "one" (one
// approver of a department it touches signs, and it executes), "none" (its designer signs, and it executes).
export const APPROVAL_LEVELS = ["full", "one", "none"];
export const approvalLevel = (settings) => (APPROVAL_LEVELS.includes(settings?.approval?.level) ? settings.approval.level : "full");

export async function organizationSettings(q) {
    const [row] = await q.query("SELECT version, body FROM mes.organization WHERE status = 'published'");
    return row ? { version: row.version, ...row.body } : { version: null, governance: "engineering", standing: {}, steps: {} };
}

// A department's approval steps, in order: [{ step, label, approvers: [users] }]. A group (§28.3a: named by an
// object's approval by value) approves in one step that any of its active members signs.
export async function stepsOf(q, department, settings = null) {
    const labels = (settings ?? (await organizationSettings(q))).steps?.[department] ?? [];
    const reps = await q.query("SELECT step, user_id FROM mes.department_reps WHERE group_id = $1 ORDER BY step, user_id", [department]);
    if (!reps.length) {
        const [g] = await q.query("SELECT kind FROM mes.groups WHERE id = $1", [department]);
        if (g?.kind === "group") {
            const members = (await q.query("SELECT m.user_id FROM mes.group_members m JOIN mes.users u ON u.id = m.user_id AND u.active WHERE m.group_id = $1 ORDER BY m.user_id", [department])).map((r) => r.user_id);
            return members.length ? [{ step: 1, label: "A member", approvers: members }] : [];
        }
    }
    const byStep = new Map();
    for (const r of reps) (byStep.get(r.step) ?? byStep.set(r.step, []).get(r.step)).push(r.user_id);
    return [...byStep].sort(([a], [b]) => a - b).map(([step, approvers], i, all) => ({ step, label: labels[step - 1] ?? (all.length === 1 ? "Approver" : `Step ${step}`), approvers }));
}

// The certifications the plant recognizes (§27.9), as published: each its name and what it is for.
const certificationsOf = (all) => Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)).map(([id, c]) => [id, { name: String(c?.name ?? id).trim(), ...(c?.description ? { description: String(c.description).trim() } : {}) }]));

// The organization as it is now, as the snapshot a change edits.
export async function organizationSnapshot(q) {
    const settings = await organizationSettings(q);
    const users = await q.query("SELECT id, name, active FROM mes.users ORDER BY id");
    const groups = await q.query("SELECT id, name, kind FROM mes.groups ORDER BY id");
    const members = await q.query("SELECT group_id, user_id FROM mes.group_members ORDER BY user_id");
    const assignments = await q.query("SELECT subject_kind, subject_id, object, role FROM mes.assignments ORDER BY object, role, subject_kind, subject_id");
    const org = { version: settings.version, governance: settings.governance, standing: settings.standing ?? {}, formats: settings.formats ?? {}, theme: settings.theme ?? {}, retention: settings.retention ?? {}, emergency: settings.emergency ?? {}, ...(settings.integrity ? { integrity: settings.integrity } : {}), ...(settings.setup ? { setup: settings.setup } : {}), ...(settings.approval ? { approval: settings.approval } : {}), ...(settings.signIn ? { signIn: settings.signIn } : {}), readers: settings.readers ?? [], certifications: settings.certifications ?? {}, users: {}, departments: {}, groups: {}, roles: {} };
    for (const u of users) org.users[u.id] = { name: u.name, active: u.active };
    for (const g of groups) {
        const m = members.filter((x) => x.group_id === g.id).map((x) => x.user_id);
        if (g.kind === "department") org.departments[g.id] = { name: g.name, ...(settings.emails?.[g.id] ? { email: settings.emails[g.id] } : {}), members: m, approval: (await stepsOf(q, g.id, settings)).map(({ label, approvers }) => ({ label, approvers })) };
        else org.groups[g.id] = { name: g.name, ...(settings.emails?.[g.id] ? { email: settings.emails[g.id] } : {}), members: m };
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
    // Each department's and group's mailbox (§28.6), kept with the steps' labels: no table has a place for it.
    const emails = Object.fromEntries(Object.entries({ ...(org.groups ?? {}), ...(org.departments ?? {}) }).filter(([, d]) => typeof d.email === "string" && d.email.trim()).map(([id, d]) => [id, d.email.trim()]));
    await tx.query("UPDATE mes.organization SET status = 'superseded' WHERE status = 'published'");
    await tx.query("INSERT INTO mes.organization (version, status, body) VALUES ($1, 'published', $2)", [version, JSON.stringify({ governance: org.governance, standing: org.standing ?? {}, steps, ...(Object.keys(emails).length ? { emails } : {}), formats: org.formats ?? {}, theme: org.theme ?? {}, retention: org.retention ?? {}, emergency: org.emergency ?? {}, ...(org.integrity && Object.keys(org.integrity).length ? { integrity: org.integrity } : {}), ...(isPlainSetup(org.setup) ? { setup: { open: org.setup.open === true } } : {}), ...(org.approval && ["full", "one", "none"].includes(org.approval.level) ? { approval: { level: org.approval.level } } : {}), ...(signInOf(org.signIn) ? { signIn: signInOf(org.signIn) } : {}), readers: [...new Set(org.readers ?? [])].sort(), ...(org.certifications && Object.keys(org.certifications).length ? { certifications: certificationsOf(org.certifications) } : {}) })]);
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
    // The platform's own writes (§7.7): the tripwire lets them by; each is sealed below.
    if (users.some((u) => { const h = byUser.get(u.id); return !h || h.data?.name !== u.name || h.data?.active !== u.active; })) await platformWrites(tx);
    for (const u of users) {
        const want = { user: u.id, name: u.name, active: u.active };
        const have = byUser.get(u.id);
        if (!have) {
            const state = def.body.states?.initial ?? "active";
            const [row] = await tx.query("INSERT INTO mes.records (object, def_version, state, data, created_by, updated_by) VALUES ('person', $1, $2, $3, $4, $4) RETURNING id", [def.version, state, JSON.stringify(want), actor]);
            // Sealed as the platform's own write (§7.7), in the same transaction.
            const seal = (await resealRecords(tx, "person", [row.id])).get(row.id);
            await appendAudit(tx, { actor, object: "person", recordId: row.id, defVersion: def.version, action: "create", after: { ...want, state, $seal: seal } });
            n++;
        } else if (have.data?.name !== u.name || have.data?.active !== u.active) {
            const [row] = await tx.query("UPDATE mes.records SET data = data || $2::jsonb, row_version = row_version + 1, updated_at = now(), updated_by = $3 WHERE object = 'person' AND id = $1 RETURNING data, state", [have.id, JSON.stringify(want), actor]);
            const seal = (await resealRecords(tx, "person", [have.id])).get(have.id);
            await appendAudit(tx, { actor, object: "person", recordId: have.id, defVersion: def.version, action: "update", after: { ...row.data, state: row.state, $seal: seal } });
            n++;
        }
    }
    return n;
}

// The snapshot without what a change does not carry (its version).
export const draftOf = ({ version, ...org }) => org;
