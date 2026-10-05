// An object's roles and policies at a glance (DESIGN.md §9.8): for each role, over every policy that
// names it, what it may do with the records, each field and each action. A reading of the design, not
// a decision: what a person may do with one record is decided by policy.js, on that record, at that
// moment. Here a grant under a condition (a `when`, or only through transactions) is "sometimes".
//
//   policyMatrix(body) → { roles, rows: [{ kind: "record" | "field" | "action", key, label,
//                                           cells: { role: { level, sometimes, denied, by } } }] }
//   level:     "write" | "read" | "yes" | null     the most it is ever granted
//   sometimes: true when that level is granted only under a condition
//   denied:    "locked" (a deny on writing: read at most) | "hidden" (a deny on reading) |
//              "refused" (a deny on the action) | null; a deny wins over every grant
//   by:        the policies that say so, each { id, when: true if under a condition }
//
// Shared by the designer and its tests: it imports nothing.
const list = (v) => (Array.isArray(v) ? v : []);
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const conditional = (p) => p.when !== undefined || list(p.via).length > 0;
const RANK = { write: 2, read: 1, yes: 1 };

// The most a set of grants gives: [{ level, when }] → { level, sometimes }.
function most(grants) {
    if (!grants.length) return { level: null, sometimes: false };
    const top = Math.max(...grants.map((g) => RANK[g.level]));
    const level = grants.find((g) => RANK[g.level] === top).level;
    return { level, sometimes: !grants.some((g) => RANK[g.level] === top && !g.when) };
}

export function policyMatrix(body) {
    const roles = list(body?.roles);
    const policies = list(body?.policies).filter(isPlain);
    const fields = Object.keys(isPlain(body?.fields) ? body.fields : {});
    const actions = [...new Set(list(body?.states?.transitions).map((t) => t?.action).filter(Boolean))];
    const of = (role) => policies.filter((p) => list(p.roles).includes(role));
    const cell = (role, grantOf, denyOf, deniedAs) => {
        const mine = of(role);
        const grants = mine.flatMap((p) => { const level = grantOf(p); return level ? [{ level, when: conditional(p), id: p.id }] : []; });
        const denies = denyOf ? mine.filter((p) => denyOf(p)) : [];
        const { level, sometimes } = most(grants);
        return { level, sometimes, denied: denies.length ? deniedAs(denies) : null, by: [...grants.map((g) => ({ id: g.id, when: g.when })), ...denies.map((p) => ({ id: p.id, when: conditional(p), deny: true }))] };
    };
    const row = (kind, key, label, grantOf, denyOf = null, deniedAs = () => null) => ({ kind, key, label, cells: Object.fromEntries(roles.map((r) => [r, cell(r, grantOf, denyOf, deniedAs)])) });
    // A field is read only by a role that may read records at all.
    const reads = Object.fromEntries(roles.map((r) => [r, most(of(r).filter((p) => p.record?.read).map((p) => ({ level: "yes", when: conditional(p) })))]));
    const rows = [
        row("record", "read", "Read records", (p) => (p.record?.read ? "yes" : null)),
        row("record", "create", "Create records", (p) => (p.record?.create ? "yes" : null)),
        row("record", "archive", "Archive and restore", (p) => (p.record?.archive ? "yes" : null)),
        ...fields.map((f) => {
            const r = row("field", f, body.fields[f]?.label ?? f, (p) => (isPlain(p.fields) ? p.fields[f] ?? p.fields["*"] ?? null : null),
                (p) => list(p.deny?.fields).includes(f) || list(p.deny?.read).includes(f), (denies) => (denies.some((p) => list(p.deny?.read).includes(f)) ? "hidden" : "locked"));
            for (const role of roles) {
                const c = r.cells[role];
                if (!reads[role].level) { c.level = null; c.sometimes = false; }
                else if (c.level && reads[role].sometimes) c.sometimes = true;
            }
            return r;
        }),
        ...actions.map((a) => row("action", a, a.replace(/_/g, " "), (p) => (isPlain(p.actions) && p.actions[a] === "allow" ? "yes" : null), (p) => list(p.deny?.actions).includes(a), () => "refused")),
    ];
    return { roles, rows };
}

// ---- changing a grant from the grid ----
// A cell is what several policies come to, so a change is always a change to one policy. What a policy
// says itself about a subject ("" when nothing; a field's `*` is not the field's own grant):
export const grantIn = (policy, kind, key) => (kind === "record" ? (policy?.record?.[key] ? "yes" : "") : kind === "action" ? (policy?.actions?.[key] === "allow" ? "yes" : "") : policy?.fields?.[key] ?? "");
// The value after it: a field goes nothing → read → write → nothing; the rest are granted or not.
export const nextGrant = (kind, value) => (kind === "field" ? { "": "read", read: "write", write: "" }[value] ?? "" : value ? "" : "yes");
// Writes it into the policy (a draft's own copy), leaving nothing empty behind.
export function setGrant(policy, kind, key, value) {
    const part = kind === "record" ? "record" : kind === "action" ? "actions" : "fields";
    const held = isPlain(policy[part]) ? policy[part] : (policy[part] = {});
    if (!value) delete held[key];
    else held[key] = kind === "record" ? true : kind === "action" ? "allow" : value;
    return policy;
}
// The policies that name a role, each with what it says on a subject: the ones a change may go to.
//   → [{ index, id, own: it names this role alone, when: under a condition, others: [roles], value }]
export function policiesFor(body, role, kind, key) {
    return list(body?.policies).map((p, index) => ({ p, index })).filter(({ p }) => isPlain(p) && list(p.roles).includes(role))
        .map(({ p, index }) => ({ index, id: p.id, own: list(p.roles).length === 1, when: conditional(p), via: list(p.via), others: list(p.roles).filter((r) => r !== role), value: grantIn(p, kind, key), star: kind === "field" && grantIn(p, kind, key) === "" ? p.fields?.["*"] ?? "" : "" }));
}
// The one policy a quick change goes to without asking: the only one that is this role's alone and
// always applies. None, or several: the person chooses.
export function quickTarget(body, role, kind, key) {
    const own = policiesFor(body, role, kind, key).filter((x) => x.own && !x.when);
    return own.length === 1 ? own[0] : null;
}

// What a cell comes to, in a word, and the class it is coloured by.
export function cellWords(cell, kind) {
    if (cell.denied === "hidden") return { text: "hidden", tone: "deny" };
    if (cell.denied === "refused") return { text: "refused", tone: "deny" };
    const level = cell.denied === "locked" && cell.level === "write" ? "read" : cell.level;
    if (!level) return { text: cell.denied === "locked" ? "locked" : "—", tone: cell.denied ? "deny" : "none" };
    const word = level === "yes" ? (kind === "action" ? "allow" : "yes") : level;
    return { text: `${word}${cell.sometimes ? "*" : ""}${cell.denied === "locked" ? " (locked)" : ""}`, tone: cell.denied === "locked" ? "deny" : level === "write" || level === "yes" ? "write" : "read" };
}
// Why, for the cell's tooltip: the policies that say so.
export const cellWhy = (cell) => (cell.by.length ? cell.by.map((b) => `${b.deny ? "denied by" : "by"} ${b.id}${b.when ? " (under its condition)" : ""}`).join("; ") : "no policy grants it");
