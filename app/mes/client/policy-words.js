// A policy in words (§9): what it lets its roles do, said beside its name, since the name decides nothing
// (desktop-edit may grant only reading); what to look at (roles that may write but read nowhere, a name
// that says the opposite of what it grants); and the starting points a policy may be set to at once.
//
//   grantsWords(rule, { fieldLabel, conditionWords }) → "editor may create records, archive and restore them and write every field."
//   togetherWords(rule, policies, { fieldLabel })     → ["With desktop-read as well, editor may read records, …"]
//   policyAdvice(rule, policies)      → [{ tone: "warn" | "note", words }]
//   PRESETS                           → [{ key, label, title, apply(rule) }]
const list = (v) => (Array.isArray(v) ? v : []);
const joined = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
// `*` is every field the policy does not name: "every other field" once it names any (here or in another list).
const fieldList = (names, fieldLabel, namesAny = false) => {
    const named = names.filter((f) => f !== "*").map(fieldLabel);
    const all = names.includes("*") ? [...named, named.length || namesAny ? "every other field" : "every field"] : named;
    return all.length > 6 ? `${all.length} fields` : joined(all);
};

// What one grant (a policy, or several merged) lets do: its parts in words.
function partsOf(g, fieldLabel) {
    const rec = g?.record ?? {};
    const fields = Object.entries(g?.fields ?? {});
    const writes = fields.filter(([, l]) => l === "write").map(([f]) => f);
    const reads = fields.filter(([, l]) => l === "read").map(([f]) => f);
    const actions = Object.entries(g?.actions ?? {}).filter(([, v]) => v === "allow").map(([a]) => a);
    const parts = [];
    if (rec.read) parts.push("read records");
    if (rec.create) parts.push("create records");
    if (rec.archive) parts.push(rec.create ? "archive and restore them" : "archive and restore records");
    const namesAny = fields.some(([f]) => f !== "*");
    if (writes.length) parts.push(`write ${fieldList(writes, fieldLabel, namesAny)}`);
    if (reads.length) parts.push(`read ${fieldList(reads, fieldLabel, namesAny)}`);
    if (actions.length) parts.push(actions.length > 6 ? `take ${actions.length} actions` : `take the action${actions.length === 1 ? "" : "s"} ${joined(actions)}`);
    return parts;
}

// The policy as it stands, in one statement: who, what, under which condition (in words when `conditionWords`
// is given), through which transactions, and what it never lets them write.
export function grantsWords(rule, { fieldLabel = (f) => f, conditionWords = null } = {}) {
    const roles = list(rule?.roles);
    const who = roles.length ? joined(roles) : "its roles";
    const parts = partsOf(rule, fieldLabel);
    const deny = list(rule?.deny?.fields);
    // A lock alone (a policy that only denies): what it keeps them from, whatever else grants it.
    if (!parts.length && deny.length) return `${who} may never write ${fieldList(deny, fieldLabel)}${rule?.when !== undefined ? ` while ${conditionWords ? conditionWords(rule.when) : "its condition holds"}` : ""}, whatever else grants it.`;
    if (!parts.length) return `Grants ${who} nothing yet: tick above what ${roles.length === 1 ? "it" : "they"} may do.`;
    const limits = [];
    if (rule?.when !== undefined) limits.push(`only while ${conditionWords ? conditionWords(rule.when) : "its condition holds"}`);
    if (list(rule?.via).length) limits.push(`only through ${list(rule.via).length === 1 ? "the transaction" : "the transactions"} ${joined(list(rule.via))}`);
    return `${who} may ${joined(parts)}${limits.length ? `, ${limits.join(", ")}` : ""}.${deny.length ? ` Never writes ${fieldList(deny, fieldLabel)}, whatever else grants it.` : ""}`;
}

// What each of its roles may do once its other policies are counted too: the levels of every policy for the
// role merged (a field's level is the one it names, else `*`'s; the highest wins), a deny anywhere winning.
// A role with no other policy has nothing more to say. → ["With desktop-read as well, editor may …"]
const LEVEL = { "": 0, read: 1, write: 2 };
export function togetherWords(rule, policies = [], { fieldLabel = (f) => f } = {}) {
    const out = [];
    for (const role of list(rule?.roles).slice(0, 4)) {
        const others = list(policies).filter((p) => p !== rule && list(p?.roles).includes(role));
        if (!others.length) continue;
        const all = [rule, ...others];
        const names = [...new Set(all.flatMap((p) => Object.keys(p?.fields ?? {})))];
        const levelOf = (p, f) => p?.fields?.[f] ?? (f === "*" ? "" : p?.fields?.["*"] ?? "");
        const merged = { record: {}, fields: {}, actions: {} };
        for (const k of ["read", "create", "archive"]) if (all.some((p) => p?.record?.[k])) merged.record[k] = true;
        for (const f of new Set(["*", ...names])) {
            const level = all.map((p) => levelOf(p, f)).reduce((a, b) => (LEVEL[b] > LEVEL[a] ? b : a), "");
            if (level) merged.fields[f] = level;
        }
        // A named field at the same level as every other field says nothing more.
        for (const f of Object.keys(merged.fields)) if (f !== "*" && merged.fields[f] === (merged.fields["*"] ?? "")) delete merged.fields[f];
        for (const p of all) for (const [a, v] of Object.entries(p?.actions ?? {})) if (v === "allow") merged.actions[a] = "allow";
        const parts = partsOf(merged, fieldLabel);
        if (!parts.length) continue;
        const conditional = all.some((p) => p?.when !== undefined || list(p?.via).length);
        // A lock that always holds is said as it is; one under a condition, as such.
        const always = [...new Set(all.filter((p) => p?.when === undefined).flatMap((p) => list(p?.deny?.fields)))];
        const sometimes = [...new Set(all.filter((p) => p?.when !== undefined).flatMap((p) => list(p?.deny?.fields)))].filter((f) => !always.includes(f));
        const named = others.length <= 2 ? joined(others.map((p) => p.id)) : `${others[0].id} and ${others.length - 1} other policies`;
        out.push(`With ${named} as well, ${role} may ${joined(parts)}${conditional ? " (some of it only under a condition or through a transaction)" : ""}.${always.length ? ` Never writes ${fieldList(always, fieldLabel)}.` : ""}${sometimes.length ? ` Never writes ${fieldList(sometimes, fieldLabel)} while a lock's condition holds.` : ""}`);
    }
    return out;
}

const changes = (rule) => Boolean(rule?.record?.create || rule?.record?.archive || Object.values(rule?.fields ?? {}).includes("write") || Object.values(rule?.actions ?? {}).includes("allow"));
const NAME_READS = /(^|[-_])(read|reads|view|viewer|views|readonly|read_only|see)($|[-_])/i;
const NAME_WRITES = /(^|[-_])(edit|editor|edits|write|writer|update|change|manage)($|[-_])/i;

export function policyAdvice(rule, policies = []) {
    const out = [];
    const roles = list(rule?.roles);
    if (changes(rule) && !rule?.record?.read) {
        // Reading records is the door to changing one: a role that reads through no policy is warned (where
        // reading comes from another policy, the summary's "with … as well" says so).
        const blind = roles.filter((r) => !list(policies).some((p) => p !== rule && list(p?.roles).includes(r) && p?.record?.read));
        if (blind.length) out.push({ tone: "warn", words: `${joined(blind)} may change records, but no policy lets ${blind.length === 1 ? "it" : "them"} read records: they cannot open one to change it. Tick “may read records”, here or in another of their policies.` });
    }
    const id = String(rule?.id ?? "");
    if (NAME_READS.test(id) && changes(rule)) out.push({ tone: "warn", words: `Its name says reading, but it lets ${joined(roles) || "its roles"} change records. A name decides nothing: what is ticked above does. Rename it, or change what it grants.` });
    else if (NAME_WRITES.test(id) && !changes(rule)) out.push({ tone: "warn", words: `Its name says editing, but it lets ${joined(roles) || "its roles"} change nothing. A name decides nothing: what is ticked above does. Rename it, or change what it grants.` });
    return out;
}

// Starting points: what is ticked is set at once, and may be changed after. Its roles, condition, transactions
// and denied fields stay as they are; so do its actions, but for Nothing.
export const PRESETS = [
    { key: "read", label: "Read only", title: "May read records and every field; nothing else", apply: (r) => { r.record = { read: true }; r.fields = { "*": "read" }; } },
    { key: "edit", label: "Read and edit", title: "May read and create records and write every field; its actions as they are", apply: (r) => { r.record = { ...(r.record ?? {}), read: true, create: true }; r.fields = { "*": "write" }; } },
    { key: "none", label: "Nothing", title: "Takes everything back: no records, no fields, no actions", apply: (r) => { r.record = {}; r.fields = {}; delete r.actions; } },
];
// A policy's id: what rename takes (the ids in use: lot_quality_edit, desktop-read).
export const POLICY_ID = /^[a-z][a-z0-9_-]{0,47}$/;
