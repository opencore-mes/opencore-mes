// The policy engine (DESIGN.md §9): deny by default, grants unioned across matching rules, an explicit
// deny wins, write implies read. One evaluator decides, and the same evaluator, tracing, explains
// (§9.7), so an explanation never drifts from the decision.
//
// A rule, from an object's definition:
//   { id, roles: [...], when: <expression>, record: { read, create, archive }, fields: { name|"*": "read"|"write" },
//     actions: { name: "allow" }, deny: { fields: [...] (no write), read: [...] (hidden), actions: [...] },
//     via: [transaction names] }
//
// A rule with `via` applies only to a write made through one of those transactions (§25): the user's
// `via` names the transaction running. So "a lot moves onto a machine only through Move in" is a
// policy like any other, and a lot's form never offers the transition on its own.
//
// An archived record (`archived_at` set) is read-only: no field may be written and no action taken,
// whatever the rules grant (reason "archived"). Archiving and restoring it take `record.archive`.
import { explain as explainExpression } from "../client/expr.js";
import { READ_ALL_ROLE } from "../client/definition.js";
import { managedOf } from "../client/builtins.js";

// Who reads every record (§27.7) holds READ_ALL_ROLE on every object: as if each object had this rule.
// It reads every record and every field, but one any of the object's own rules hides (deny.read), and
// grants no write, no action and no archiving.
// A deny list as the names in it: anything that is not a list denies nothing by name (a string would be
// read letter by letter); definition.js refuses such a design.
const names = (value) => (Array.isArray(value) ? value : []);
export const readAllRule = (definition) => ({
    id: "read-all", roles: [READ_ALL_ROLE], record: { read: true }, fields: { "*": "read" },
    deny: { read: [...new Set((definition.policies ?? []).flatMap((r) => names(r.deny?.read)))] },
});
const rulesFor = (definition, user) => [...(definition.policies ?? []), ...((user.roles ?? []).includes(READ_ALL_ROLE) ? [readAllRule(definition)] : [])];

const SYSTEM_FIELDS = ["id", "state", "type", "def_version", "row_version", "updated_at", "updated_by", "created_at", "created_by", "archived_at", "archived_by"];

// The scopes a condition reads: the record's own columns and its data fields side by side.
const scopesFor = (user, record) => ({ user, record });

function ruleMatches(rule, user, record) {
    const roles = (rule.roles ?? []).filter((role) => user.roles.includes(role));
    const condition = rule.when === undefined ? { value: true, text: "always", refs: [] } : explainExpression(rule.when, scopesFor(user, record));
    const viaOk = rule.via === undefined || (Array.isArray(rule.via) && rule.via.includes(user.via));
    return { roles, rolesMatch: roles.length > 0, condition, viaOk, applies: roles.length > 0 && condition.value === true && viaOk };
}
// The transactions through which a rule granting `grants` applies, for a refusal's words.
const viaOf = (definition, grants) => [...new Set((definition.policies ?? []).filter((r) => Array.isArray(r.via) && grants(r)).flatMap((r) => r.via))];

// The transitions the state machine allows from `state`.
export function transitionsFrom(definition, state) {
    return (definition.states?.transitions ?? []).filter((t) => t.from.includes(state));
}

// The decision for one user on one record (a would-be record for create): what they may read and
// write, which actions they may take, and a short reason code for everything they may not (§9.7).
export function decide(definition, user, record) {
    const fieldNames = Object.keys(definition.fields);
    const grants = { read: false, create: false, archive: false, fields: {}, actions: new Set() };
    const denied = { fields: new Set(), actions: new Set(), read: new Set() };
    const evaluations = rulesFor(definition, user).map((rule) => ({ rule, ...ruleMatches(rule, user, record) }));
    for (const { rule, applies } of evaluations) {
        if (!applies) continue;
        if (rule.record?.read) grants.read = true;
        if (rule.record?.create) grants.create = true;
        if (rule.record?.archive) grants.archive = true;
        for (const [field, level] of Object.entries(rule.fields ?? {})) {
            const targets = field === "*" ? fieldNames : [field];
            for (const name of targets) {
                if (level === "write" || grants.fields[name] === undefined) grants.fields[name] = level === "write" ? "w" : (grants.fields[name] ?? "r");
            }
        }
        for (const [action, verdict] of Object.entries(rule.actions ?? {})) if (verdict === "allow") grants.actions.add(action);
        for (const field of names(rule.deny?.fields)) denied.fields.add(field);
        for (const field of names(rule.deny?.read)) denied.read.add(field);
        for (const action of names(rule.deny?.actions)) denied.actions.add(action);
    }

    // Field rights, and why not.
    const archived = Boolean(record.archived_at);
    const managed = new Set(definition.builtIn ? managedOf(definition.object).fields : []);
    const fields = {};
    const why = {};
    for (const name of fieldNames) {
        let level = grants.read ? (grants.fields[name] ?? null) : null;
        // A denied field keeps what reading was granted (a lock); `deny.read` hides it.
        if (denied.fields.has(name) && level === "w") level = "r";
        if (denied.read.has(name)) level = null;
        // An archived record is read-only: restore it to change it.
        if (archived && level === "w") { level = "r"; why[name] = "archived"; }
        // What the platform alone keeps on a built-in object (builtins.js): read only, whatever the grants.
        if (level === "w" && managed.has(name)) { level = "r"; why[name] = "managed"; }
        fields[name] = level;
        if (level !== "w" && !why[name]) why[name] = denied.fields.has(name) ? "deny" : reasonFor(evaluations, (rule) => grantsField(rule, name, "write"));
    }

    // Actions: the state machine first, then the rules.
    const possible = new Set(transitionsFrom(definition, record.state).map((t) => t.action));
    const actions = [];
    for (const transition of definition.states?.transitions ?? []) {
        const action = transition.action;
        if (actions.includes(action)) continue;
        if (archived) { why[`action:${action}`] = "archived"; continue; }
        if (!possible.has(action)) { why[`action:${action}`] = "state"; continue; }
        if (denied.actions.has(action)) { why[`action:${action}`] = "deny"; continue; }
        if (grants.read && grants.actions.has(action)) actions.push(action);
        else why[`action:${action}`] = reasonFor(evaluations, (rule) => rule.actions?.[action] === "allow");
    }

    // Archiving (and restoring): a right of its own, on a record the user may read.
    const archive = grants.read && grants.archive;
    if (!archive) why["record:archive"] = reasonFor(evaluations, (rule) => rule.record?.archive === true);
    return { read: grants.read, create: grants.create, archive, fields, actions, why, evaluations };
}

// Why an action is refused, in words built from the definition as it is now (its transitions, their
// labels and from-states, the record's title and state), so the words follow the model when the
// model changes (§9.7). A rule script that relies on the platform's refusal needs none of its own.
const words = (id) => String(id ?? "").replace(/_/g, " ");
const either = (list) => (list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} or ${list.at(-1)}`);
// `through` (optional) names the transactions that take this action, when the caller knows them.
export function actionRefusal(definition, user, record, action, decision = decide(definition, user, record), through = null) {
    const transitions = (definition.states?.transitions ?? []).filter((t) => t.action === action);
    const title = record[definition.titleField];
    const noun = `${definition.label ?? definition.object}${title ? ` ${title}` : ""}`;
    if (!transitions.length) return `${definition.label ?? definition.object} has no action "${action}".`;
    const label = transitions[0].label ?? action;
    switch (decision.why[`action:${action}`]) {
        case "state": {
            const from = [...new Set(transitions.flatMap((t) => t.from))];
            return `${noun} is ${words(record.state)}; ${label} is possible only from ${either(from.map(words))}.`;
        }
        case "deny": return `${label} is denied on ${noun} while it is ${words(record.state)}.`;
        case "archived": return `${noun} is archived; restore it before you ${label.toLowerCase()} it.`;
        case "role": return `None of your roles on ${definition.label ?? definition.object} (${(user.roles ?? []).join(", ") || "none"}) may ${label.toLowerCase()} it.`;
        case "condition": return `${label} is not allowed on ${noun} as it is now: ask why for the conditions that apply.`;
        case "transaction": return `${label} is done through the ${either(through?.length ? through : viaOf(definition, (r) => r.actions?.[action] === "allow").map(words))} transaction: start it from there.`;
        default: return `You cannot ${label.toLowerCase()} ${noun} now.`;
    }
}

// Why archiving (or restoring) is refused, in the same words as an action's refusal.
export function archiveRefusal(definition, user, record, restore = false, decision = decide(definition, user, record)) {
    const title = record[definition.titleField];
    const noun = `${definition.label ?? definition.object}${title ? ` ${title}` : ""}`;
    const verb = restore ? "restore" : "archive";
    switch (decision.why["record:archive"]) {
        case "role": return `None of your roles on ${definition.label ?? definition.object} (${(user.roles ?? []).join(", ") || "none"}) may ${verb} it.`;
        case "state": return `${noun} cannot be ${verb}d while it is ${words(record.state)}.`;
        case "condition": return `${noun} cannot be ${verb}d as it is now: ask why for the conditions that apply.`;
        default: return `You cannot ${verb} ${noun} now.`;
    }
}

const grantsField = (rule, name, level) => {
    const given = rule.fields?.[name] ?? rule.fields?.["*"];
    return level === "write" ? given === "write" : given === "read" || given === "write";
};

// Why a grant is missing: no rule of the user's roles ever grants it ("role"), or one does but its
// condition does not hold for this record ("state" when the condition is only about the state,
// "condition" otherwise).
function reasonFor(evaluations, grants) {
    const relevant = evaluations.filter(({ rule }) => grants(rule));
    const roleMatches = relevant.filter((e) => e.rolesMatch);
    if (!roleMatches.length) return "role";
    // Granted only through a transaction, and this is not one.
    const mine = roleMatches.filter((e) => e.viaOk);
    if (!mine.length) return "transaction";
    const onlyState = mine.every((e) => e.condition.refs.every((ref) => ref.scope === "record" && ref.path === "state"));
    return onlyState ? "state" : "condition";
}

// The record as this user may see it: readable fields only, the system columns, and $perm.
export function mask(definition, user, row) {
    const record = { ...row.data, id: row.id, state: row.state, type: row.type, archived_at: row.archived_at ?? null };
    const decision = decide(definition, user, record);
    if (!decision.read) return null;
    const out = {};
    for (const name of SYSTEM_FIELDS) if (row[name] !== undefined) out[name] = row[name];
    for (const [name, level] of Object.entries(decision.fields)) if (level && row.data[name] !== undefined) out[name] = row.data[name];
    out.$perm = { fields: decision.fields, actions: decision.actions, archive: decision.archive, why: decision.why };
    return out;
}

// ---- explain (§9.7) ---------------------------------------------------------------------------
// The decision trace for one target: { field, op: "write" }, { action } or { archive: true } (archive
// or restore). What the user may not read is never shown: a condition that read such a field is
// summarised.
export function explainDecision(definition, user, record, target) {
    const decision = decide(definition, user, record);
    const readable = new Set(Object.entries(decision.fields).filter(([, level]) => level).map(([name]) => name));
    const visible = (condition) => condition.refs.every((ref) => ref.scope !== "record" || ["state", "type", "id"].includes(ref.path) || readable.has(ref.path));
    const conditionText = (condition) => (visible(condition) ? condition.text : "a condition on data you do not have access to");
    const label = target.archive ? "archiving" : target.action ? `action '${target.action}'` : `field '${target.field}' (${target.op ?? "write"})`;
    const because = [];
    const remedies = [];
    const archived = Boolean(record.archived_at);
    if (archived && !target.archive && !(target.field && target.op === "read")) {
        because.push({ source: "archive", detail: `the record was archived${record.archived_by ? ` by ${record.archived_by}` : ""}; it is read-only until it is restored` });
    }

    let allowed;
    if (target.archive) {
        allowed = decision.archive;
    } else if (target.action) {
        allowed = decision.actions.includes(target.action);
        const from = (definition.states?.transitions ?? []).filter((t) => t.action === target.action);
        if (!from.some((t) => t.from.includes(record.state))) {
            because.push({ source: "state", detail: `the record is in state '${record.state}'; '${target.action}' is possible only from ${from.flatMap((t) => t.from).map((s) => `'${s}'`).join(", ") || "no state"}` });
        }
    } else {
        const level = decision.fields[target.field];
        allowed = (target.op ?? "write") === "read" ? Boolean(level) : level === "w";
    }

    const grantsTarget = (rule) => (target.archive ? rule.record?.archive === true : target.action ? rule.actions?.[target.action] === "allow" : grantsField(rule, target.field, target.op ?? "write"));
    for (const { rule, roles, rolesMatch, condition, viaOk } of decision.evaluations) {
        const denies = target.archive ? false : target.action ? names(rule.deny?.actions).includes(target.action) : names(rule.deny?.fields).includes(target.field);
        if (!grantsTarget(rule) && !denies) continue;
        because.push({
            source: "policy",
            rule: rule.id,
            roles: rolesMatch ? `matched (${roles.join(", ")})` : `not held (needs ${rule.roles.join(" or ")})`,
            condition: `${condition.value ? "holds" : "fails"}: ${conditionText(condition)}`,
            ...(rule.via ? { via: `only through the ${rule.via.join(" or ")} transaction${viaOk ? "" : ", which this is not"}` } : {}),
            effect: denies ? "deny" : "grant",
            applies: rolesMatch && condition.value === true && viaOk,
        });
        if (!rolesMatch && condition.value === true && !denies && !(archived && !target.archive)) remedies.push({ kind: "role", detail: `a user with role ${rule.roles.join(" or ")} on '${definition.object}' may do this in this state` });
        if (rolesMatch && condition.value === true && !viaOk && !denies && !(archived && !target.archive)) remedies.push({ kind: "transaction", detail: `use the ${rule.via.join(" or ")} transaction`, transactions: rule.via });
    }
    if (!because.some((b) => b.source === "policy")) because.push({ source: "policy", detail: `no rule grants ${label} to anyone` });
    if (!allowed && archived && !target.archive) {
        remedies.push({ kind: "archive", detail: decision.archive ? "restore the record, then try again" : "ask someone who may archive this record to restore it" });
    }
    if (!allowed && !remedies.length) {
        const hint = definition.hints?.[target.archive ? "record:archive" : target.action ? `action:${target.action}` : `${target.op ?? "write"}:${target.field}`];
        if (hint) remedies.push({ kind: "process", detail: hint });
        else remedies.push({ kind: "role", detail: `no role may do this while the record is in state '${record.state}'` });
    }
    return {
        decision: allowed ? "allow" : "deny",
        target: { object: definition.object, id: record.id ?? null, ...target },
        user: { id: user.id, roles: user.roles },
        because,
        remedies: allowed ? [] : remedies,
    };
}
