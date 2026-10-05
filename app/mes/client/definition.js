// What the designer and the change lifecycle know about a definition (DESIGN.md §5, §6), the same in
// the browser (continuous checks while designing) and on the server (the gate at submit):
//
//   validateDefinition(body, known)      → problems [{ path, message }]
//   footprint(published, draft)          → the elements a change touches, each with its stewards
//   routeOf(elements)                    → the departments that must approve, and why
//   validateService / validateConnection / integrationFootprint: the same for services and connections
//   validateTransaction / transactionFootprint: the same for transactions (§25)
//
// It imports only pure modules (expressions, schedules, layouts, formats), so a browser can load it.
import { referencesOf, countNodesOf, explain as explainExpression } from "./expr.js";
import { isSchedule, scheduleProblems, SUITE_KIND } from "./schedule.js";
import { layoutProblems, expressionProblems } from "./form-layout.js";
import { formatsProblems } from "./format.js";
import { TONES, themeProblems } from "./theme.js";
import { BUILT_INS, lockProblems, keptBy } from "./builtins.js";
import { floorProblems } from "./floor.js";
import { chartProblems, chartOf, CHART_KEYS } from "./charts.js";
import { INPUT_FLOW_NODES, inputFlowExprProblems, inputFlowNodeProblems, inputFlowUseProblems } from "./input-flow.js";

export const IDENTIFIER = /^[a-z][a-z0-9_]{0,47}$/;
// "image" (§35): a picture, kept as its name in the picture store (the SHA-256 of its bytes).
export const FIELD_TYPES = ["string", "text", "integer", "decimal", "boolean", "date", "enum", "ref", "image"];
export const BLOB_NAME = /^[0-9a-f]{64}$/;
// Names a field may not have: the record's own columns, and every Object.prototype name (the live
// diff and the state paths mishandle them, §6.2).
export const RESERVED = new Set(["id", "object", "state", "type", "version", "row_version", "def_version", "archived_at", "archived_by", "created_at", "created_by", "updated_at", "updated_by", ...Object.getOwnPropertyNames(Object.prototype), "__proto__", "prototype"]);

const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);

// ---- approval of record changes (§28) ----
// An object's design may say that changes to its records, made outside a transaction (a form, a list,
// an import), wait for approval:
//   approval: { edit?: true | { fields?: [names], states?: [states] },   values; only these fields,
//               create?: true,                                            only in these states
//               actions?: true | [actions] }
// A transaction (§25) is the approved way to change them: its steps never wait. Nor do designed
// services (§15), approved like it.
function approvalProblems(body, fields, states, actions) {
    const a = body.approval;
    if (a === undefined) return [];
    if (!isPlain(a)) return ["Approval is { edit, create, actions }."];
    const out = [];
    for (const key of Object.keys(a)) if (!["edit", "create", "actions"].includes(key)) out.push(`Approval: "${key}" is not edit, create or actions.`);
    if (a.edit !== undefined && a.edit !== true) {
        if (!isPlain(a.edit)) out.push("Approval of edits is true (every edit) or { fields, states }.");
        else {
            for (const f of list(a.edit.fields)) if (!Object.hasOwn(fields, f)) out.push(`Approval of edits: "${f}" is not a field.`);
            for (const st of list(a.edit.states)) if (!states.includes(st)) out.push(`Approval of edits: "${st}" is not a state.`);
            for (const k of Object.keys(a.edit)) if (!["fields", "states"].includes(k)) out.push(`Approval of edits: "${k}" is not fields or states.`);
        }
    }
    if (a.create !== undefined && typeof a.create !== "boolean") out.push("Approval of new records is true or false.");
    if (a.actions !== undefined && a.actions !== true) {
        if (!Array.isArray(a.actions)) out.push("Approval of actions is true (every action) or a list of actions.");
        else for (const act of a.actions) if (!actions.has(act)) out.push(`Approval of actions: "${act}" is not an action.`);
    }
    return out;
}

// Whether a change needs approval: { op: "create" | "edit" | "action", state, changed: [fields], action }.
export function needsApproval(body, { op, state = null, changed = [], action = null } = {}) {
    const a = body?.approval;
    if (!isPlain(a)) return false;
    if (op === "create") return a.create === true;
    if (op === "action") return a.actions === true || (Array.isArray(a.actions) && a.actions.includes(action));
    if (op !== "edit" || !a.edit || !changed.length) return false;
    if (a.edit === true) return true;
    const only = list(a.edit.fields);
    const inStates = list(a.edit.states);
    return (!only.length || changed.some((f) => only.includes(f))) && (!inStates.length || inStates.includes(state));
}

// Who approves a change to a record (§28): the stewards of what it changes, as stewardship resolves
// (§5.6): a field's own stewards, else those of the state the record is in, else the object's; an
// action's transition's, else its target state's, else the object's; a new record's fields in its
// initial state. → [{ department, because: ["field:qty", …] }], sorted.
export function recordRoute(body, { op, state = null, changed = [], action = null } = {}) {
    const stewards = body?.stewards ?? {};
    const pick = (...levels) => levels.map((l) => list(l)).find((l) => l.length) ?? [];
    const out = new Map();
    const push = (depts, because) => { for (const d of depts) (out.get(d) ?? out.set(d, new Set()).get(d)).add(because); };
    if (op === "action") {
        const to = list(body?.states?.transitions).find((t) => t.action === action && list(t.from).includes(state))?.to;
        push(pick(stewards.transitions?.[action], stewards.states?.[to], stewards.object), `action:${action}`);
    } else {
        const at = op === "create" ? body?.states?.initial : state;
        for (const f of changed) push(pick(stewards.fields?.[f], stewards.states?.[at], stewards.object), `field:${f}`);
        if (!changed.length) push(pick(stewards.states?.[at], stewards.object), op === "create" ? "create" : "edit");
    }
    return [...out].map(([department, because]) => ({ department, because: [...because].sort() })).sort((a, b) => a.department.localeCompare(b.department));
}

// The scripts a definition's suites' parts name ({ script: "name" } anywhere in them, §29.4): tested as
// a suite runs them (input in, output out), and approved by the object's stewards.
export function suiteScripts(body) {
    const out = new Set();
    const walk = (v) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (isPlain(v)) for (const [k, x] of Object.entries(v)) { if (k === "script" && typeof x === "string" && x) out.add(x); else walk(x); }
    };
    walk(body?.suites);
    return [...out].sort();
}

// Why a field may not be called `to` in `body`, or null. For a new field and for a rename.
export function fieldNameProblem(body, to) {
    if (!IDENTIFIER.test(to ?? "")) return "A field's name is lower case letters, digits and _, starting with a letter.";
    if (RESERVED.has(to)) return `"${to}" is reserved (the record's own columns use it).`;
    if (Object.hasOwn(body?.fields ?? {}, to)) return `"${to}" exists already.`;
    return null;
}

// Renames a field of a draft definition in place, and every place the definition names it: the title
// field, the list, the form, the policies (their fields, denials, conditions), the hints, analytics,
// import, the rules' writes, the stewards, and every condition that reads it ({ record | data: name },
// a count of this object's records by it). Only a field that is not published yet is renamed (the
// designer offers nothing else): a published one's records hold their values under its name.
// What other elements (scripts, transactions, screens) say about it, the checks then name.
export function renameField(body, from, to) {
    const rename = (v) => (v === from ? to : v);
    const renameKeys = (obj, key = (k) => rename(k)) => (isPlain(obj) ? Object.fromEntries(Object.entries(obj).map(([k, v]) => [key(k), v])) : obj);
    const refs = (node) => {
        if (Array.isArray(node)) return node.map(refs);
        if (!isPlain(node)) return node;
        const keys = Object.keys(node);
        if (keys.length === 1 && (keys[0] === "record" || keys[0] === "data") && typeof node[keys[0]] === "string") {
            const [head, ...rest] = node[keys[0]].split(".");
            return { [keys[0]]: [rename(head), ...rest].join(".") };
        }
        if (isPlain(node.count) && node.count.object === body.object) return { ...node, count: { ...node.count, where: renameKeys(node.count.where) } };
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, refs(v)]));
    };
    body.fields = renameKeys(body.fields);
    for (const f of Object.values(body.fields)) if (f?.requiredWhen !== undefined) f.requiredWhen = refs(f.requiredWhen);
    body.titleField = rename(body.titleField);
    if (body.list) {
        if (Array.isArray(body.list.columns)) body.list.columns = body.list.columns.map(rename);
        if (isPlain(body.list.sort)) body.list.sort = { ...body.list.sort, field: rename(body.list.sort.field) };
    }
    const entry = (e) => (typeof e === "string" ? rename(e) : isPlain(e) ? refs({ ...e, field: rename(e.field) }) : e);
    const section = (sec) => (isPlain(sec) ? { ...sec, fields: list(sec.fields).map(entry) } : sec);
    if (isPlain(body.form)) {
        if (Array.isArray(body.form.sections)) body.form = { ...body.form, sections: body.form.sections.map(section) };
        if (Array.isArray(body.form.tabs)) body.form = { ...body.form, tabs: body.form.tabs.map((t) => (isPlain(t) ? { ...t, sections: list(t.sections).map(section) } : t)) };
    }
    body.policies = list(body.policies).map((p) => (isPlain(p) ? {
        ...p,
        ...(p.fields ? { fields: renameKeys(p.fields) } : {}),
        ...(isPlain(p.deny) ? { deny: { ...p.deny, ...(p.deny.fields ? { fields: list(p.deny.fields).map(rename) } : {}), ...(p.deny.read ? { read: list(p.deny.read).map(rename) } : {}) } } : {}),
        ...(p.when !== undefined ? { when: refs(p.when) } : {}),
    } : p));
    if (isPlain(body.hints)) body.hints = renameKeys(body.hints, (k) => k.replace(/^([a-z_]+):(.+)$/, (m, verb, name) => `${verb}:${rename(name)}`));
    if (Array.isArray(body.analytics?.dimensions)) body.analytics = { ...body.analytics, dimensions: body.analytics.dimensions.map(rename) };
    if (body.transfer?.import?.key !== undefined) body.transfer = { ...body.transfer, import: { ...body.transfer.import, key: rename(body.transfer.import.key) } };
    if (body.flow?.step !== undefined) body.flow = { ...body.flow, step: rename(body.flow.step) };
    body.rules = list(body.rules).map((r) => (isPlain(r) ? { ...r, ...(r.writes ? { writes: list(r.writes).map(rename) } : {}), ...(r.when !== undefined ? { when: refs(r.when) } : {}) } : r));
    if (isPlain(body.stewards?.fields)) body.stewards = { ...body.stewards, fields: renameKeys(body.stewards.fields) };
    return body;
}

// known: { objects: [names], scripts: [names], departments: [ids], compile(name, source) → throws }
export function validateDefinition(body, known = {}) {
    const problems = [];
    const add = (path, message) => problems.push({ path, message });
    if (!isPlain(body)) return [{ path: "", message: "A definition is an object." }];
    if (typeof body.object !== "string" || !IDENTIFIER.test(body.object) || RESERVED.has(body.object)) add("object", "The object's name is lower case letters, digits and _, starting with a letter.");
    if (typeof body.label !== "string" || !body.label.trim()) add("label", "Give the object a label.");
    if (typeof body.area !== "string" || !body.area.trim()) add("area", "Say which area it belongs to (Production, Quality, …).");
    // Whether the platform keeps an object (its people, §27) is the platform's to say, not a design's.
    // (A plant's own object that happens to carry a built-in's name, made before the platform had one,
    // stays its own: what is live says which it is, when the caller knows it.)
    const kept = known.live !== undefined ? Boolean(known.live?.builtIn) : BUILT_INS.some((b) => b.object === body.object);
    if (Boolean(body.builtIn) !== kept || (body.builtIn !== undefined && body.builtIn !== true)) add("builtIn", kept ? `"${body.object}" is kept by the platform: builtIn stays true.` : "Only an object the platform keeps is builtIn.");

    const fields = isPlain(body.fields) ? body.fields : {};
    const names = Object.keys(fields);
    if (!names.length) add("fields", "An object has at least one field.");
    for (const [name, field] of Object.entries(fields)) {
        const at = `fields.${name}`;
        if (!IDENTIFIER.test(name)) add(at, `"${name}": a field's name is lower case letters, digits and _, starting with a letter.`);
        else if (RESERVED.has(name)) add(at, `"${name}" is reserved; choose another name.`);
        if (!isPlain(field)) { add(at, "A field is an object."); continue; }
        if (!FIELD_TYPES.includes(field.type)) add(`${at}.type`, `"${name}": the type is one of ${FIELD_TYPES.join(", ")}.`);
        if (field.type === "enum" && (!Array.isArray(field.values) || !field.values.length || !field.values.every((v) => typeof v === "string" && v))) add(`${at}.values`, `"${name}": list the values it may take.`);
        if (field.type === "enum" && Array.isArray(field.values) && new Set(field.values).size !== field.values.length) add(`${at}.values`, `"${name}": a value is listed twice.`);
        for (const k of ["label", "help"]) if (field[k] !== undefined && field[k] !== null && typeof field[k] !== "string") add(`${at}.${k}`, `"${name}": its ${k} is text.`);
        if (field.type === "ref" && !(known.objects ?? []).includes(field.to)) add(`${at}.to`, `"${name}": refers to "${field.to ?? ""}", which is not an object.`);
        // Several values (§10.4): a choice field only, holding a list of its values.
        if (field.multiple !== undefined && typeof field.multiple !== "boolean") add(`${at}.multiple`, `"${name}": multiple is true or false.`);
        if (field.multiple && field.type !== "enum") add(`${at}.multiple`, `"${name}": only a choice field (enum) may hold several values.`);
        if (field.requiredWhen !== undefined) for (const m of expressionProblems(field.requiredWhen, fields)) add(`${at}.requiredWhen`, `"${name}" required when: ${m}`);
    }
    if (body.titleField !== undefined && !Object.hasOwn(fields, body.titleField)) add("titleField", `The title field "${body.titleField}" is not a field.`);
    // What the platform or an installed suite relies on (builtins.js): `known.locks`, worked out from them.
    for (const p of lockProblems(body, known.locks?.[body.object])) add(p.path, p.message);

    // States and transitions.
    const states = list(body.states?.list);
    if (!states.length) add("states.list", "An object has at least one state.");
    for (const state of states) if (!IDENTIFIER.test(state)) add("states.list", `"${state}": a state's name is lower case letters, digits and _.`);
    if (new Set(states).size !== states.length) add("states.list", "A state is listed twice.");
    if (!states.includes(body.states?.initial)) add("states.initial", `The initial state "${body.states?.initial ?? ""}" is not in the list.`);
    // Each state's tone (§10.8): what it means, which the theme colours (on_hold: warn).
    if (body.states?.tones !== undefined) {
        if (!isPlain(body.states.tones)) add("states.tones", "Tones are { state: tone }.");
        else for (const [state, tone] of Object.entries(body.states.tones)) {
            if (!states.includes(state)) add("states.tones", `Tone of "${state}": not a state in the list.`);
            else if (!TONES.includes(tone)) add("states.tones", `Tone of ${state}: one of ${TONES.join(", ")}, not "${tone}".`);
        }
    }
    const actions = new Set();
    for (const [i, t] of list(body.states?.transitions).entries()) {
        const at = `states.transitions.${i}`;
        if (!IDENTIFIER.test(t?.action ?? "")) add(at, `Transition ${i + 1}: an action's name is lower case letters, digits and _.`);
        actions.add(t?.action);
        if (!list(t?.from).length || !list(t?.from).every((s) => states.includes(s))) add(at, `Transition "${t?.action}": every "from" state must be in the list.`);
        if (!states.includes(t?.to)) add(at, `Transition "${t?.action}": "to" must be a state in the list.`);
    }

    // Roles and policies.
    const roles = list(body.roles);
    if (!roles.length) add("roles", "Declare at least one role.");
    for (const role of roles) if (!IDENTIFIER.test(role)) add("roles", `"${role}": a role's name is lower case letters, digits and _.`);
    const ids = new Set();
    for (const [i, rule] of list(body.policies).entries()) {
        const at = `policies.${i}`;
        const name = rule?.id ?? `#${i + 1}`;
        if (typeof rule?.id !== "string" || !rule.id) add(at, `Policy ${i + 1} needs an id.`);
        else if (ids.has(rule.id)) add(at, `Two policies are called "${rule.id}".`);
        ids.add(rule?.id);
        // Which one is not, and which there are: "designer" and "reviewer" are roles on the designer, not on an object.
        if (!list(rule?.roles).length) add(`${at}.roles`, `Policy "${name}": name the roles it is for (of this object's: ${roles.join(", ") || "it has none yet"}).`);
        else if (!list(rule.roles).every((r) => roles.includes(r))) add(`${at}.roles`, `Policy "${name}": its roles must be roles of this object. ${list(rule.roles).filter((r) => !roles.includes(r)).map((r) => `"${r}"`).join(", ")} ${list(rule.roles).filter((r) => !roles.includes(r)).length === 1 ? "is" : "are"} not (it has ${roles.join(", ") || "none yet"}): take ${list(rule.roles).filter((r) => !roles.includes(r)).length === 1 ? "it" : "them"} out of the policy, or add ${list(rule.roles).filter((r) => !roles.includes(r)).length === 1 ? "it" : "them"} to the object's roles.`);
        // The shapes the policy engine reads (policy.js): anything else would grant or deny by accident
        // (a deny list written as one name is read letter by letter, and hides nothing).
        if (!isPlain(rule)) { add(at, `Policy ${i + 1} is an object.`); continue; }
        for (const k of ["record", "fields", "actions", "deny"]) if (rule[k] !== undefined && !isPlain(rule[k])) add(`${at}.${k}`, `Policy "${name}": ${k} is an object.`);
        for (const k of ["fields", "read", "actions"]) if (isPlain(rule.deny) && rule.deny[k] !== undefined && !(Array.isArray(rule.deny[k]) && rule.deny[k].every((v) => typeof v === "string"))) add(`${at}.deny`, `Policy "${name}": deny.${k} is a list of names.`);
        for (const [k, v] of Object.entries(isPlain(rule.record) ? rule.record : {})) if (!["read", "create", "archive"].includes(k) || typeof v !== "boolean") add(`${at}.record`, `Policy "${name}": record grants read, create and archive, each true or false.`);
        for (const [action, verdict] of Object.entries(isPlain(rule.actions) ? rule.actions : {})) if (verdict !== "allow") add(`${at}.actions`, `Policy "${name}": "${action}" is "allow" (to refuse it, list it under deny.actions).`);
        for (const [field, level] of Object.entries(isPlain(rule?.fields) ? rule.fields : {})) {
            if (field !== "*" && !Object.hasOwn(fields, field)) add(`${at}.fields`, `Policy "${name}": "${field}" is not a field.`);
            if (level !== "read" && level !== "write") add(`${at}.fields`, `Policy "${name}": "${field}" is "read" or "write".`);
        }
        for (const action of Object.keys(isPlain(rule?.actions) ? rule.actions : {})) if (!actions.has(action)) add(`${at}.actions`, `Policy "${name}": "${action}" is not an action.`);
        for (const field of [...list(rule?.deny?.fields), ...list(rule?.deny?.read)]) if (!Object.hasOwn(fields, field)) add(`${at}.deny`, `Policy "${name}": "${field}" is not a field.`);
        for (const action of list(rule?.deny?.actions)) if (!actions.has(action)) add(`${at}.deny`, `Policy "${name}": "${action}" is not an action.`);
        // Only through these transactions (§25): a grant that no form uses on its own.
        if (rule?.via !== undefined) {
            if (!Array.isArray(rule.via) || !rule.via.length || !rule.via.every((t) => typeof t === "string" && IDENTIFIER.test(t))) add(`${at}.via`, `Policy "${name}": via lists the transactions it applies through.`);
            else if (known.transactions) for (const t of rule.via) if (!known.transactions.includes(t)) add(`${at}.via`, `Policy "${name}": "${t}" is not a transaction.`);
        }
        if (rule?.when !== undefined) {
            try {
                for (const ref of referencesOf(rule.when)) {
                    if (ref.scope === "record" && !["state", "type", "id"].includes(ref.path) && !Object.hasOwn(fields, String(ref.path).split(".")[0])) add(`${at}.when`, `Policy "${name}": its condition reads record.${ref.path}, which is not a field.`);
                    if (ref.scope !== "record" && ref.scope !== "user") add(`${at}.when`, `Policy "${name}": a condition reads the record or the user.`);
                }
                // Worked out once on nothing: an operator the language does not have, or one given the
                // wrong shape, is said here, not when the first person opens a record (policy.js decide).
                explainExpression(rule.when, { user: { id: "", roles: [] }, record: {} });
            } catch (error) {
                add(`${at}.when`, `Policy "${name}": ${error.message}`);
            }
        }
    }

    // Flows (§32): whether its records take part, and as what; a traveler's step field (the sequence it
    // is at: a route marks it, and a write that moves it moves the route).
    if (body.flow !== undefined) {
        if (!isPlain(body.flow) || !list(body.flow.as).length || !list(body.flow.as).every((r) => FLOW_ROLES.includes(r))) add("flow", `flow is { as: [${FLOW_ROLES.join(", ")}] }: how its records may take part in flows.`);
        else if (body.flow.step !== undefined) {
            const f = body.flow.step;
            if (!list(body.flow.as).includes("traveler")) add("flow.step", "Only a traveler has a step on a route.");
            else if (!Object.hasOwn(fields, f)) add("flow.step", `flow.step names the field that holds the step a traveler is at: "${f ?? ""}" is not a field.`);
            else if (!["string", "enum"].includes(fields[f].type) || fields[f].multiple) add("flow.step", `"${f}" holds a step's name: a text or a choice field of one value.`);
        }
        for (const k of Object.keys(body.flow ?? {})) if (!["as", "step"].includes(k)) add("flow", `flow.${k} is not part of how an object takes part in flows (as, step).`);
    }

    // Analytics (§22): the fields copied into each stay in a state, to group reports by.
    const dimensions = body.analytics?.dimensions;
    if (dimensions !== undefined) {
        if (!Array.isArray(dimensions) || dimensions.length > 5) add("analytics.dimensions", "Analytics dimensions are a list of at most 5 fields.");
        for (const d of list(dimensions)) {
            if (!Object.hasOwn(fields, d)) add("analytics.dimensions", `Analytics dimension "${d}" is not a field.`);
            else if (fields[d]?.type === "text") add("analytics.dimensions", `Analytics dimension "${d}" is long text; group by a short field.`);
            else if (fields[d]?.multiple) add("analytics.dimensions", `Analytics dimension "${d}" holds several values; group by a field that holds one.`);
        }
    }

    // Excel import and export (§24): whether the model may be exported, and what an import may do.
    const transfer = body.transfer;
    if (transfer !== undefined) {
        if (!isPlain(transfer)) add("transfer", "transfer is { export, import: { create, update, key } }.");
        else {
            if (transfer.export !== undefined && typeof transfer.export !== "boolean") add("transfer.export", "export is true or false.");
            const imp = transfer.import;
            if (imp !== undefined && imp !== null) {
                if (!isPlain(imp)) add("transfer.import", "import is { create, update, key }.");
                else {
                    for (const k of ["create", "update"]) if (imp[k] !== undefined && typeof imp[k] !== "boolean") add(`transfer.import.${k}`, `import.${k} is true or false.`);
                    if (imp.key !== undefined && imp.key !== null) {
                        if (!Object.hasOwn(fields, imp.key)) add("transfer.import.key", `Import key "${imp.key}" is not a field.`);
                        else if (!["string", "integer", "enum"].includes(fields[imp.key]?.type) || fields[imp.key]?.multiple) add("transfer.import.key", `Import key "${imp.key}" must be a short field (string, integer or enum, one value) that names one record.`);
                    }
                    if (imp.update && !imp.key) add("transfer.import.key", "Updating by import needs a key field that names one record (e.g. the lot number).");
                }
            }
        }
    }

    // The rule pipe (§12).
    for (const [i, entry] of list(body.rules).entries()) {
        const at = `rules.${i}`;
        if (!(known.scripts ?? []).includes(entry?.script)) add(at, `Rule ${i + 1}: there is no script "${entry?.script ?? ""}".`);
        for (const field of list(entry?.writes)) if (!Object.hasOwn(fields, field)) add(at, `Rule "${entry?.script}": it writes "${field}", which is not a field.`);
    }

    // Approval of record changes (§28): which changes made outside a transaction wait for the
    // stewards of what they change.
    for (const p of approvalProblems(body, fields, states, actions)) add("approval", p);

    // Suites' parts of the design (§29.4): each checked by its suite; the scripts they name exist.
    if (body.suites !== undefined) {
        if (!isPlain(body.suites)) add("suites", "The suites' parts are { suite: its part }.");
        else {
            for (const [suite, part] of Object.entries(body.suites)) {
                const check = known.suiteDesigns?.[suite];
                // What a removed suite left stays, inert, and works again once it is reinstalled (§29.5,
                // §30.11): the object can still be changed, as long as that part is as it is live.
                if (known.suiteDesigns && !check && known.live?.suites && Object.hasOwn(known.live.suites, suite) && same(known.live.suites[suite], part)) continue;
                if (known.suiteDesigns && !check) { add(`suites.${suite}`, `"${suite}" is not an installed suite: install it, or remove its part of the design.`); continue; }
                for (const message of check?.(body, part, known) ?? []) add(`suites.${suite}`, message);
            }
            for (const name of suiteScripts(body)) if (known.scripts && !known.scripts.includes(name)) add("suites", `A suite's part names the script "${name}", which does not exist.`);
        }
    }

    // Screens: the form (tabs, sections, widths, widgets, presentation rules: form-layout.js) and the
    // list draw only fields that exist.
    for (const p of layoutProblems(body)) add(p.path, p.message);
    for (const field of list(body.list?.columns)) if (!Object.hasOwn(fields, field)) add("list.columns", `List column "${field}" is not a field.`);
    if (body.list?.searchFirst !== undefined && typeof body.list.searchFirst !== "boolean") add("list.searchFirst", "Search first is true or false.");
    if (body.list?.sort !== undefined && (!isPlain(body.list.sort) || !Object.hasOwn(fields, body.list.sort.field) || !["asc", "desc"].includes(body.list.sort.dir ?? "asc"))) add("list.sort", "The list's sort is { field, dir: asc | desc } on a field.");

    // Stewards (§5.6): someone answers for every object.
    const departments = known.departments ?? [];
    const stewards = body.stewards ?? {};
    if (!list(stewards.object).length) add("stewards.object", "Name at least one department that stewards this object.");
    for (const dept of stewardDepartments(stewards)) if (departments.length && !departments.includes(dept)) add("stewards", `"${dept}" is not a department.`);
    return problems;
}

// A script's own problems: its name, and that it compiles (known.compile throws with the reason).
export function validateScript(name, source, compile) {
    if (!IDENTIFIER.test(name)) return [{ path: `scripts.${name}`, message: `"${name}": a script's name is lower case letters, digits and _.` }];
    // A script imports nothing: on the server import() is refused when it runs (script-worker.mjs); in
    // the browser's rule worker it would fetch and run code from anywhere, the record's data in its
    // address. Refused where it is written, so a reviewer never has to spot it.
    if (typeof source === "string" && /\bimport\s*(\(|\.\s*meta\b)/.test(source)) return [{ path: `scripts.${name}`, message: `${name}.js: a script imports nothing: take out import(…) (in a comment or a text as well: write it another way).` }];
    try {
        compile(name, source);
        return [];
    } catch (error) {
        return [{ path: `scripts.${name}`, message: `${name}.js: ${error.message}` }];
    }
}

function stewardDepartments(stewards) {
    const out = new Set(list(stewards?.object));
    for (const key of ["fields", "states", "transitions", "policies", "screens"]) for (const depts of Object.values(stewards?.[key] ?? {})) for (const d of list(depts)) out.add(d);
    return [...out];
}

// ---- footprint and route (§5.6) ---------------------------------------------------------------

// Equal as data, whatever the order of an object's keys (a draft read back from jsonb has its keys
// in the database's order, not the order it was built in).
const stable = (v) => (Array.isArray(v) ? v.map(stable) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v);
const same = (a, b) => JSON.stringify(stable(a ?? null)) === JSON.stringify(stable(b ?? null));
const byKey = (items, key) => Object.fromEntries(list(items).map((item) => [item?.[key], item]));

// The stewards of one element, most specific first, falling back to the object's; for a change to
// stewardship itself, both the old and the new stewards answer (§5.6).
function stewardsOf(stewards, kind, name) {
    const specific = { field: "fields", state: "states", transition: "transitions", policy: "policies", screen: "screens" }[kind];
    const own = specific ? list(stewards?.[specific]?.[name]) : [];
    return own.length ? own : list(stewards?.object);
}

// The elements a change to one object touches: [{ element, change: "added"|"changed"|"removed", stewards }].
export function footprint(published, draft) {
    const before = published ?? {};
    const after = draft ?? {};
    const old = before.stewards ?? {};
    const now = after.stewards ?? {};
    // Something added answers to its new stewards, something removed to its old ones, and something
    // changed to both.
    const answer = (kind, name, extra, change) => [...new Set([
        ...(change !== "added" ? stewardsOf(old, kind, name) : []),
        ...(change !== "removed" ? stewardsOf(now, kind, name) : []),
        ...(extra ?? []),
    ])].filter(Boolean).sort();
    const out = [];
    const push = (element, a, b, kind, name, extra) => {
        if (same(a, b)) return;
        const change = a === undefined ? "added" : b === undefined ? "removed" : "changed";
        out.push({ element, change, stewards: answer(kind, name, extra, change) });
    };
    if (!published) {
        out.push({ element: `object:${after.object}`, change: "added", stewards: answer("object", undefined, [], "added") });
        return out;
    }
    for (const key of ["label", "area", "description", "titleField", "hints", "analytics", "transfer", "approval", "suites"]) push(`object.${key}`, before[key], after[key], "object");
    for (const name of new Set([...Object.keys(before.fields ?? {}), ...Object.keys(after.fields ?? {})])) push(`field:${name}`, before.fields?.[name], after.fields?.[name], "field", name);
    for (const state of new Set([...list(before.states?.list), ...list(after.states?.list)])) push(`state:${state}`, list(before.states?.list).includes(state) || undefined, list(after.states?.list).includes(state) || undefined, "state", state);
    push("states.initial", before.states?.initial, after.states?.initial, "object");
    push("states.tones", before.states?.tones, after.states?.tones, "object");
    const tBefore = byKey(before.states?.transitions, "action");
    const tAfter = byKey(after.states?.transitions, "action");
    for (const action of new Set([...Object.keys(tBefore), ...Object.keys(tAfter)])) {
        const to = [tBefore[action]?.to, tAfter[action]?.to].filter(Boolean);
        push(`transition:${action}`, tBefore[action], tAfter[action], "transition", action, to.flatMap((s) => stewardsOf(now, "state", s)));
    }
    push("roles", before.roles, after.roles, "object");
    const pBefore = byKey(before.policies, "id");
    const pAfter = byKey(after.policies, "id");
    for (const id of new Set([...Object.keys(pBefore), ...Object.keys(pAfter)])) {
        // A policy also answers to the stewards of what it grants and of the states its condition names.
        const touched = [pBefore[id], pAfter[id]].filter(Boolean);
        const extra = [];
        for (const rule of touched) {
            for (const field of Object.keys(rule.fields ?? {})) if (field !== "*") extra.push(...stewardsOf(now, "field", field));
            const text = JSON.stringify(rule.when ?? null);
            for (const state of list(after.states?.list)) if (text.includes(`"${state}"`)) extra.push(...stewardsOf(now, "state", state));
        }
        push(`policy:${id}`, pBefore[id], pAfter[id], "policy", id, extra);
    }
    push("rules", before.rules, after.rules, "object", undefined, list(after.rules).flatMap((r) => list(r.writes).flatMap((f) => stewardsOf(now, "field", f))));
    push("form", before.form, after.form, "screen", "form");
    push("list", before.list, after.list, "screen", "list");
    if (!same(before.stewards, after.stewards)) out.push({ element: "stewards", change: "changed", stewards: [...new Set([...stewardDepartments(old), ...stewardDepartments(now)])].sort() });
    // Whatever else a definition carries (whether it takes part in flows, whether the platform keeps
    // it, a key this list does not know yet): changed, it answers to the object's stewards. Nothing in
    // a definition goes live without being in the footprint.
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) if (!FOOTPRINT_KEYS.has(key)) push(`object.${key}`, before[key], after[key], "object");
    for (const key of new Set([...Object.keys(before.states ?? {}), ...Object.keys(after.states ?? {})])) if (!["list", "initial", "tones", "transitions"].includes(key)) push(`states.${key}`, before.states?.[key], after.states?.[key], "object");
    return out;
}
// A definition's keys the footprint reads by name, above.
const FOOTPRINT_KEYS = new Set(["object", "label", "area", "description", "titleField", "hints", "analytics", "transfer", "approval", "suites", "fields", "states", "roles", "policies", "rules", "form", "list", "stewards"]);

// A script's footprint: the stewards of every object whose pipe uses it, and of the fields it writes;
// a service's script, the service's own (and what the service reaches).
export function scriptFootprint(name, before, after, definitions, services = {}, context = {}) {
    if (before === after) return [];
    // An object uses it in its rule pipe, or in a suite's part of its design (§29.4).
    const users = definitions.filter((def) => list(def.rules).some((r) => r.script === name) || suiteScripts(def).includes(name));
    const stewards = new Set();
    if (services[name]) for (const d of integrationFootprint("service", name, undefined, services[name], context)[0].stewards) stewards.add(d);
    // A flow runs it at a node (onEnter, onExit), as the template: the template's stewards answer.
    const flows = Object.entries(isPlain(context.flows) ? context.flows : {}).filter(([, f]) => Object.values(isPlain(f?.nodes) ? f.nodes : {}).some((n) => n?.onEnter === name || n?.onExit === name));
    for (const [, f] of flows) for (const d of list(f.stewards)) stewards.add(d);
    for (const def of users) {
        for (const d of list(def.stewards?.object)) stewards.add(d);
        for (const entry of list(def.rules).filter((r) => r.script === name)) for (const f of list(entry.writes)) for (const d of stewardsOf(def.stewards, "field", f)) stewards.add(d);
    }
    return [{ element: `script:${name}`, change: before === undefined ? "added" : "changed", stewards: [...stewards].sort(), usedBy: [...users.map((d) => d.object), ...(services[name] ? [`service:${name}`] : []), ...flows.map(([f]) => `flow:${f}`)] }];
}

// The departments that must approve, each with the elements that require it.
export function routeOf(elements) {
    const route = {};
    for (const e of elements) for (const dept of e.stewards) (route[dept] ??= []).push(e.element);
    return Object.entries(route).sort(([a], [b]) => a.localeCompare(b)).map(([department, because]) => ({ department, because }));
}

// ---- services and connections (§15.2): integration as design elements ----------------------------
//
// A connection is an outside system the plant talks to (ERP, a LIMS, a label printer's API): where it
// is, how the MES proves who it is (a named secret, whose value is never part of a design), and the
// only requests a service may send it. A service is a script and who may set it off: a caller over
// HTTP (a web service), a person in the UI, or a record event (a trigger). Both are changed the way
// an object is: design → review → approval → execution, approved by their stewards.

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
// A node tag a service's runs may be kept to (`runOn`): nodes say theirs (NODE_TAGS).
export const NODE_TAG = /^[a-z][a-z0-9_-]{0,31}$/;
export const AUTH_KINDS = ["none", "bearer", "header", "basic"];
// The record events a service's trigger may name, besides transition:<action>.
export const RECORD_EVENTS = ["create", "update", "archive", "restore"];
// "archive" is archiving and restoring (records.archive / records.restore).
export const SERVICE_OPS = ["read", "create", "update", "action", "archive"];
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(["host", "cookie", "content-length", "transfer-encoding", "connection"]);
const ALLOWED_PATH = /^\/[A-Za-z0-9._~\-/{}:%]*(\*)?$/;

// Does `pattern` ("/orders/*", "/confirmations") allow `path`? A trailing * is a prefix; nothing else is.
export function pathAllowed(pattern, path) {
    if (typeof pattern !== "string" || typeof path !== "string") return false;
    return pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
}

const departmentsProblem = (stewards, known, add) => {
    if (!list(stewards).length) add("stewards", "Name at least one department that stewards it.");
    for (const d of list(stewards)) if ((known.departments ?? []).length && !known.departments.includes(d)) add("stewards", `"${d}" is not a department.`);
};

export function validateConnection(body, known = {}) {
    const problems = [];
    const add = (path, message) => problems.push({ path, message });
    if (!isPlain(body)) return [{ path: "", message: "A connection is an object." }];
    if (!IDENTIFIER.test(body.name ?? "")) add("name", "A connection's name is lower case letters, digits and _.");
    if (!(typeof body.label === "string" && body.label.trim())) add("label", "Give the connection a label.");
    let base = null;
    try { base = new URL(body.baseUrl); } catch { /* reported below */ }
    if (!base || !["http:", "https:"].includes(base.protocol)) add("baseUrl", "The base URL is an http:// or https:// address.");
    else if (base.username || base.password || base.search || base.hash) add("baseUrl", "The base URL carries no user, password, query or fragment: credentials go in a secret.");
    const auth = isPlain(body.auth) ? body.auth : { kind: "none" };
    if (!AUTH_KINDS.includes(auth.kind)) add("auth.kind", `Authentication is one of ${AUTH_KINDS.join(", ")}.`);
    if (auth.kind !== "none" && !IDENTIFIER.test(auth.secret ?? "")) add("auth.secret", "Name the secret that holds the credential (lower case, digits, _); its value is set on the server, never in a design.");
    if (auth.kind === "header" && (!HEADER_NAME.test(auth.header ?? "") || FORBIDDEN_HEADERS.has(String(auth.header).toLowerCase()))) add("auth.header", "Name the header that carries the credential (e.g. X-API-Key).");
    const allow = list(body.allow);
    if (!allow.length) add("allow", "List the requests a service may send (method and path); nothing else is allowed.");
    for (const [i, a] of allow.entries()) {
        if (!HTTP_METHODS.includes(a?.method)) add(`allow.${i}`, `Request ${i + 1}: the method is one of ${HTTP_METHODS.join(", ")}.`);
        if (typeof a?.path !== "string" || !ALLOWED_PATH.test(a.path) || a.path.includes("..") || a.path.includes("//")) add(`allow.${i}`, `Request ${i + 1}: a path starts with /, and may end with * to allow what follows.`);
    }
    if (body.timeoutMs !== undefined && !(Number.isInteger(body.timeoutMs) && body.timeoutMs >= 100 && body.timeoutMs <= 30000)) add("timeoutMs", "The timeout is 100 to 30 000 ms.");
    departmentsProblem(body.stewards, known, add);
    return problems;
}

// Who a service acts as (§15.2): "service", its own identity service:<name> holding the roles its
// design grants (`roles`); "caller", whoever set it off; or a user's id.
export const RUN_AS = ["service", "caller"];
export const serviceIdentity = (body) => body?.runAs ?? "service";

// known: { objects: { name: { actions: [..], roles: [..] } }, connections: [names], scripts: [names], users: [ids], groups: [ids], departments: [ids],
//          suiteCapabilities?, suiteSchedules?: { "<suite>.<kind>": { label, config, required } } }
// What a change to a web service would break for its callers (docs/contracts/http-apis), in words: it no
// longer answers over HTTP; an input is gone, changes type, becomes required or loses a value; a new
// required input; a caller taken off. `live` and `draft` are the service as published and as drafted.
export function breakingForCallers(live, draft) {
    if (!live?.http?.enabled) return [];
    if (!draft?.http?.enabled) return ["it would no longer answer over HTTP"];
    const out = [];
    const a = isPlain(live.input) ? live.input : {};
    const b = isPlain(draft.input) ? draft.input : {};
    for (const [field, was] of Object.entries(a)) {
        const now = b[field];
        if (!now) { out.push(`input ${field} would be gone`); continue; }
        if (now.type !== was.type) out.push(`input ${field} would be ${now.type}, not ${was.type}`);
        if (now.required && !was.required) out.push(`input ${field} would be required`);
        if (was.type === "enum" && now.type === "enum") for (const v of list(was.values)) if (!list(now.values).includes(v)) out.push(`input ${field} would no longer take "${v}"`);
    }
    for (const [field, now] of Object.entries(b)) if (!a[field] && now?.required) out.push(`a new input ${field} would be required`);
    for (const kind of ["users", "groups"]) for (const who of list(live.callers?.[kind])) if (!list(draft.callers?.[kind]).includes(who)) out.push(`${kind === "users" ? "user" : "group"} ${who} would no longer be among its callers`);
    return out;
}

export function validateService(body, known = {}) {
    const problems = [];
    const add = (path, message) => problems.push({ path, message });
    if (!isPlain(body)) return [{ path: "", message: "A service is an object." }];
    const name = body.name ?? "";
    if (!IDENTIFIER.test(name)) add("name", "A service's name is lower case letters, digits and _.");
    if (!(typeof body.label === "string" && body.label.trim())) add("label", "Give the service a label.");
    if (!(known.scripts ?? []).includes(name)) add("script", `Write its script, ${name}.js: a service's script is named as the service.`);
    const objects = known.objects ?? {};
    for (const [field, spec] of Object.entries(isPlain(body.input) ? body.input : {})) {
        if (!IDENTIFIER.test(field) || RESERVED.has(field)) add(`input.${field}`, `"${field}": an input's name is lower case letters, digits and _.`);
        if (!FIELD_TYPES.includes(spec?.type)) add(`input.${field}`, `"${field}": the type is one of ${FIELD_TYPES.join(", ")}.`);
        if (spec?.type === "enum" && !(list(spec.values).length && list(spec.values).every((v) => typeof v === "string" && v))) add(`input.${field}`, `"${field}": list the values it may take.`);
        if (spec?.type === "ref" && !Object.hasOwn(objects, spec.to)) add(`input.${field}`, `"${field}": refers to "${spec.to ?? ""}", which is not an object.`);
    }
    // A web service deprecated: its callers' notice (docs/contracts/http-apis): since when, the date after
    // which it may change or go, the service to use instead. Every call is answered with Deprecation,
    // Sunset and Link headers until then.
    if (body.deprecated !== undefined && body.deprecated !== null) {
        const d = body.deprecated;
        const date = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v));
        if (!isPlain(d)) add("deprecated", "Deprecated is { since, sunset, successor?, note? }.");
        else {
            if (!body.http?.enabled) add("deprecated", "Only a web service is deprecated: its callers are the ones told.");
            if (!date(d.since)) add("deprecated.since", "Since: the date it is deprecated from (YYYY-MM-DD).");
            if (!date(d.sunset)) add("deprecated.sunset", "Sunset: the date after which it may change or go (YYYY-MM-DD).");
            else if (date(d.since) && Date.parse(d.sunset) <= Date.parse(d.since)) add("deprecated.sunset", "Sunset comes after since: that time is its callers' notice.");
            if (d.successor !== undefined && d.successor !== "" && (!IDENTIFIER.test(String(d.successor)) || d.successor === name)) add("deprecated.successor", "Successor: the web service its callers move to (another service's name).");
            if (d.note !== undefined && !(typeof d.note === "string" && d.note.length <= 500)) add("deprecated.note", "A note is words for the callers, 500 characters at most.");
            for (const k of Object.keys(d)) if (!["since", "sunset", "successor", "note"].includes(k)) add("deprecated", `Deprecated: "${k}" is not since, sunset, successor or note.`);
        }
    }
    const callers = isPlain(body.callers) ? body.callers : {};
    for (const u of list(callers.users)) if (!(known.users ?? []).includes(u)) add("callers.users", `"${u}" is not a user.`);
    for (const g of list(callers.groups)) if (!(known.groups ?? []).includes(g)) add("callers.groups", `"${g}" is not a group.`);
    for (const [i, t] of list(body.on).entries()) {
        // A schedule (schedule.js): the clock sets it off, or a kind of schedule an installed suite adds
        // (`known.suiteSchedules`, §30.11; left out, the server's check decides whether it is there).
        if (isSchedule(t)) {
            for (const message of scheduleProblems(t, known)) add(`on.${i}`, `Trigger ${i + 1} (schedule): ${message}`);
            continue;
        }
        const def = objects[t?.object];
        if (!def) { add(`on.${i}`, `Trigger ${i + 1}: "${t?.object ?? ""}" is not an object.`); continue; }
        const event = String(t?.event ?? "");
        const ok = RECORD_EVENTS.includes(event) || (event.startsWith("transition:") && list(def.actions).includes(event.slice(11)));
        if (!ok) add(`on.${i}`, `Trigger ${i + 1}: the event is ${RECORD_EVENTS.join(", ")}, or transition:<action> of ${t.object} (${list(def.actions).join(", ")}).`);
    }
    const identity = serviceIdentity(body);
    if (!RUN_AS.includes(identity) && !(known.users ?? []).includes(identity)) add("runAs", `It runs as its own service role, as its caller, or as a user; "${identity}" is none of them.`);
    if (identity === "caller" && list(body.on).length) add("runAs", "A record event or a schedule has no caller: a service with triggers runs as its own service role or as a user.");
    if (body.runOn !== undefined && body.runOn !== null && (typeof body.runOn !== "string" || !NODE_TAG.test(body.runOn))) add("runOn", "runOn names a node tag: lower case letters, digits, _ and -.");
    // Its service role: roles each object declares.
    const roles = isPlain(body.roles) ? body.roles : {};
    for (const [object, granted] of Object.entries(roles)) {
        if (!Object.hasOwn(objects, object)) { add("roles", `Service role: "${object}" is not an object.`); continue; }
        for (const role of list(granted)) if (!list(objects[object].roles).includes(role)) add("roles", `Service role: ${object} has no role "${role}" (${list(objects[object].roles).join(", ")}).`);
    }
    if (identity === "service") {
        for (const object of Object.keys(isPlain(body.uses?.objects) ? body.uses.objects : {})) {
            if (Object.hasOwn(objects, object) && !list(roles[object]).length) add("roles", `It reaches ${object}, but its service role holds no role on ${object}: grant one (Identity), or it can do nothing there.`);
        }
    }
    const uses = isPlain(body.uses) ? body.uses : {};
    for (const c of list(uses.connections)) if (!(known.connections ?? []).includes(c)) add("uses.connections", `"${c}" is not a connection.`);
    for (const [object, ops] of Object.entries(isPlain(uses.objects) ? uses.objects : {})) {
        if (!Object.hasOwn(objects, object)) add("uses.objects", `"${object}" is not an object.`);
        if (!list(ops).length || !list(ops).every((op) => SERVICE_OPS.includes(op))) add("uses.objects", `${object}: what it may do is some of ${SERVICE_OPS.join(", ")}.`);
    }
    // The transactions it may run (§15.2, §25): its script's ctx.transactions.run, each through the
    // transaction's own checks, steps and audit, as the service's identity. A transaction a person signs
    // is never one a service runs; one run as the service's own role names the service among its callers.
    // (`known.transactions`: name → { label, callers, signed }, as they will be once the change executes.)
    if (uses.transactions !== undefined && !(Array.isArray(uses.transactions) && uses.transactions.every((t) => typeof t === "string" && IDENTIFIER.test(t)))) add("uses.transactions", "uses.transactions lists the transactions it may run, by name.");
    for (const t of list(uses.transactions)) {
        if (!isPlain(known.transactions)) continue;
        const tx = known.transactions[t];
        if (!tx) { add("uses.transactions", `"${t}" is not a transaction.`); continue; }
        if (tx.signed) add("uses.transactions", `${tx.label ?? t} is signed by the person running it: a service never runs it.`);
        else if (identity === "service" && !list(tx.callers?.services).includes(name)) add("uses.transactions", `It runs ${tx.label ?? t} as its own service role, and ${tx.label ?? t}'s callers do not name it: add ${name} to that transaction's callers (Services), which its stewards approve.`);
    }
    // What it may ask of an installed suite (§30.11): { suite: [capabilities] }, its script's ctx.<suite>.
    // (`known.suiteCapabilities`: suite → the names it gives; left out, the server's check decides.)
    if (uses.suites !== undefined && !isPlain(uses.suites)) add("uses.suites", "uses.suites is { suite: [what it may ask of it] }.");
    for (const [suite, names] of Object.entries(isPlain(uses.suites) ? uses.suites : {})) {
        if (!Array.isArray(names) || !names.length || !names.every((n) => typeof n === "string" && IDENTIFIER.test(n))) { add("uses.suites", `${suite}: list what the service may ask of it, by name.`); continue; }
        if (!isPlain(known.suiteCapabilities)) continue;
        const given = known.suiteCapabilities[suite];
        if (!given) add("uses.suites", `It uses the ${suite} suite, which is not installed here: install it, or take ${suite} out of what the service may touch.`);
        else for (const n of names.filter((x) => !given.includes(x))) add("uses.suites", `The ${suite} suite gives a service no "${n}" (it gives ${given.join(", ") || "nothing"}).`);
    }
    departmentsProblem(body.stewards, known, add);
    return problems;
}

// A service's or a connection's footprint (§5.6), by the same rules as an object's: something added
// answers to its new stewards, something removed to its old ones, something changed to both. A
// service also answers to the stewards of what it reaches: of every object it may write or reacts
// to, of every connection it may use, and of every transaction it may run. Whoever stewards the lot approves what may write lots and
// what a lot's release sets off; whoever stewards the ERP connection approves who talks to ERP.
//   context: { objects: { name: definition body }, connections: { name: body }, transactions: { name: body } } (live and drafted)
export function integrationFootprint(kind, name, before, after, context = {}) {
    if (same(before, after)) return [];
    const objectStewards = (object) => list(context.objects?.[object]?.stewards?.object);
    const connectionStewards = (c) => list(context.connections?.[c]?.stewards);
    const transactionStewards = (t) => list(context.transactions?.[t]?.stewards);
    const reach = (body) => {
        if (kind !== "service" || !body) return [];
        const writes = Object.entries(body.uses?.objects ?? {}).filter(([, ops]) => list(ops).some((op) => op !== "read")).map(([o]) => o);
        const triggers = list(body.on).filter((t) => !isSchedule(t)).map((t) => t?.object);
        const granted = Object.keys(isPlain(body.roles) ? body.roles : {});
        return [...writes, ...triggers, ...granted].flatMap(objectStewards).concat(list(body.uses?.connections).flatMap(connectionStewards), list(body.uses?.transactions).flatMap(transactionStewards));
    };
    const answer = (change, extra = []) => [...new Set([
        ...(change !== "added" ? list(before?.stewards) : []),
        ...(change !== "removed" ? list(after?.stewards) : []),
        ...extra,
    ])].filter(Boolean).sort();
    const element = `${kind}:${name}`;
    if (!before) return [{ element, change: "added", stewards: answer("added", reach(after)) }];
    if (!after) return [{ element, change: "removed", stewards: answer("removed", reach(before)) }];
    const out = [];
    const keys = kind === "service"
        ? ["label", "description", "input", "http", "deprecated", "callers", "on", "runAs", "runOn", "roles", "uses", "stewards"]
        : ["label", "baseUrl", "auth", "allow", "timeoutMs", "stewards"];
    for (const key of keys) {
        if (same(before[key], after[key])) continue;
        // What it reaches answers for a change to what it reaches; a role granted or taken away on an
        // object, to that object's stewards.
        const extra = key === "uses" || key === "on" ? [...reach(before), ...reach(after)]
            : key === "roles" ? [...new Set([...Object.keys(before.roles ?? {}), ...Object.keys(after.roles ?? {})])].filter((o) => !same(before.roles?.[o], after.roles?.[o])).flatMap(objectStewards)
                : [];
        out.push({ element: `${element}.${key}`, change: "changed", stewards: answer("changed", extra) });
    }
    return out;
}

// A new service's script: the rule-script contract, with what a service may reach on its context.
export const SERVICE_TEMPLATE = (name) => `// What this service does, in one line.
// ctx.input: what the caller sent · ctx.event: the record event, or { kind: "schedule", scheduledAt, previous } · ctx.user: who it acts as
// ctx.records.get/list/create/update/action/archive/restore(object, …): as ctx.user, through policy and the rule pipe
// ctx.http(connection, { method, path, query, body }) → { status, ok, body }: only what the connection allows
// ctx.transactions.run(name, input, { key }) → { run, changes, records }: a transaction it may run (uses.transactions), all or nothing
export default async function ${name}(ctx) {
  // throw Object.assign(new Error("Say what is wrong."), { field: "some_input" });
  ctx.output = { ok: true };
  return ctx;
}`;

// ---- transactions (§25): a screen that changes several records as one ---------------------------
//
// A transaction is a definition: what a person enters (inputs, laid out as a form), the checks it must
// pass, and its steps, each a write to a record one of its inputs names, through that object's own
// state machine, policies, rule pipe and audit. It runs all or nothing, in one database transaction.
// Nothing in the platform knows what a lot or a machine is: move-in, track-in, track-out and move-out
// are transactions a designer draws, like any object.
//
//   { name, label, description,
//     inputs: { name: { label, type, required?, values?, to?, multiple?, requiredWhen?, from?: "lot.machine" } },
//     form: { sections | tabs } (form-layout.js, over the inputs),
//     appearsOn?: { object, states?: [...], fills: <ref input> }   (a button on that object's records),
//     require: [{ that: <expression>, message, field?: <input> }],
//     steps: [{ on: <ref input>, set?: { field: <expression> }, action?: <transition>, when?: <expression> }],
//     confirm?: true (shows what will change before it runs; the default), signature?: { meaning,
//       verifier?: { meaning, departments?: [ids], roles?: ["<object>.<role>"] } } (§7.4: a second person
//       signed in beside the one running it, of one of those departments or roles, verifies it; both
//       re-enter their passwords at every submit),
//     maximize?: "toggle" | "start" (its screen may fill the window, see MAXIMIZE),
//     callers: { users, groups, services?: the services whose scripts may run it }, stewards: [departments] }
//
// Expressions read { input }, { lookup: "machine.state" } (the record an input names), { user } and
// { count: { object, where } }; they are worked out on the records as they were before any step.

// What a transaction's expression may read: its inputs, the records they name, the user, and counts.
function transactionExprProblems(expr, body, known) {
    const inputs = isPlain(body.inputs) ? body.inputs : {};
    const objects = known.objects ?? {};
    const out = [];
    try {
        for (const ref of referencesOf(expr)) {
            const [head, field, ...more] = String(ref.path).split(".");
            if (ref.scope === "user") continue;
            // Who runs it, as the built-in Person has them (a certification the plant keeps there).
            if (ref.scope === "person") { if (field !== undefined || !Object.hasOwn(objects.person?.fields ?? {}, head)) { if (!Object.hasOwn(objects.person?.fields ?? {}, head)) out.push(`it reads person.${ref.path}, but Person has no field "${head}".`); else out.push(`person reads one field: "${ref.path}" goes deeper.`); } continue; }
            // A row of a rows input: inside some/every, or in a step that runs once per row (forEach).
            if (ref.scope === "row") { if (!Object.values(inputs).some((sp) => sp?.type === "rows" && Object.hasOwn(sp.fields ?? {}, head))) out.push(`it reads row.${ref.path}, which no rows input has.`); continue; }
            if (ref.scope === "input") { if (!Object.hasOwn(inputs, head)) out.push(`it reads input.${ref.path}, which is not an input.`); continue; }
            // A setting of the route node its traveler is at (§32): whatever that node says; empty off a route.
            if (ref.scope === "node") continue;
            if (ref.scope === "lookup") {
                const spec = inputs[head];
                if (!spec || spec.type !== "ref") { out.push(`it looks up "${head}", which is not a reference input.`); continue; }
                const fields = objects[spec.to]?.fields ?? {};
                if (field !== undefined && !["state", "type", "id"].includes(field) && !Object.hasOwn(fields, field)) out.push(`${spec.to} has no field "${field}".`);
                if (more.length) out.push(`lookup reads one field of a record: "${ref.path}" goes deeper.`);
                continue;
            }
            out.push(`it reads ${ref.scope}, but a transaction's condition reads input, lookup, row, node, user or person.`);
        }
        for (const c of countNodesOf(expr)) {
            if (!Object.hasOwn(objects, c?.object)) { out.push(`it counts "${c?.object ?? ""}", which is not an object.`); continue; }
            for (const k of Object.keys(isPlain(c.where) ? c.where : {})) if (!["state", "type", "id"].includes(k) && !Object.hasOwn(objects[c.object].fields ?? {}, k)) out.push(`it counts ${c.object} by "${k}", which is not a field.`);
        }
    } catch (error) {
        out.push(error.message);
    }
    return out;
}

// known: { objects: { name: { fields: { name: field }, actions: [..], states: [..], transitions: [{ action, from, to }] } },
//          users: [ids], groups: [ids], departments: [ids] }
// How a transaction's or a screen's page may fill the window (§25.1, §26.1): "toggle" puts a button on
// it that sets the navigator, the top bar and the tabs aside (a kiosk at a machine), "start" opens it so,
// the same button bringing them back. Left out: no button. It changes how the page is shown, nothing else.
export const MAXIMIZE = ["toggle", "start"];
function maximizeProblem(body, add) {
    if (body.maximize !== undefined && body.maximize !== null && !MAXIMIZE.includes(body.maximize)) add("maximize", 'maximize is "toggle" (a button that fills the window with it), "start" (it opens so), or left out.');
}

export function validateTransaction(body, known = {}) {
    const problems = [];
    const add = (path, message) => problems.push({ path, message });
    if (!isPlain(body)) return [{ path: "", message: "A transaction is an object." }];
    if (!IDENTIFIER.test(body.name ?? "")) add("name", "A transaction's name is lower case letters, digits and _.");
    if (!(typeof body.label === "string" && body.label.trim())) add("label", "Give the transaction a label.");
    const objects = known.objects ?? {};
    const inputs = isPlain(body.inputs) ? body.inputs : {};
    if (!Object.keys(inputs).length) add("inputs", "A transaction has at least one input.");
    for (const [name, spec] of Object.entries(inputs)) {
        const at = `inputs.${name}`;
        if (!IDENTIFIER.test(name) || RESERVED.has(name)) add(at, `"${name}": an input's name is lower case letters, digits and _.`);
        if (!isPlain(spec)) { add(at, `"${name}": an input is an object.`); continue; }
        // A table of rows (readings, wafers): its own fields, plain values only, and how many rows.
        if (spec.type === "rows") {
            const cols = isPlain(spec.fields) ? spec.fields : {};
            if (!Object.keys(cols).length) add(at, `"${name}": rows have at least one field (fields: { value: { type: "decimal" } }).`);
            for (const [c, cs] of Object.entries(cols)) {
                if (!IDENTIFIER.test(c) || RESERVED.has(c)) add(at, `"${name}.${c}": a field's name is lower case letters, digits and _.`);
                else if (!isPlain(cs) || !["string", "integer", "decimal", "boolean", "date", "enum"].includes(cs.type)) add(at, `"${name}.${c}": a row's field is a string, integer, decimal, boolean, date or enum.`);
                else if (cs.type === "enum" && !(list(cs.values).length && list(cs.values).every((v) => typeof v === "string" && v))) add(at, `"${name}.${c}": list the values it may take.`);
            }
            for (const k of ["min", "max"]) if (spec[k] !== undefined && !(Number.isInteger(spec[k]) && spec[k] >= 0 && spec[k] <= 1000)) add(at, `"${name}": ${k} is a whole number of rows, 0 to 1000.`);
            if (Number.isInteger(spec.min) && Number.isInteger(spec.max) && spec.min > spec.max) add(at, `"${name}": at least ${spec.min} rows, and at most ${spec.max}?`);
            continue;
        }
        if (!FIELD_TYPES.includes(spec.type)) add(at, `"${name}": the type is one of ${FIELD_TYPES.join(", ")}, or rows.`);
        if (spec.type === "enum" && !(list(spec.values).length && list(spec.values).every((v) => typeof v === "string" && v))) add(at, `"${name}": list the values it may take.`);
        if (spec.type === "ref" && !Object.hasOwn(objects, spec.to)) add(at, `"${name}": refers to "${spec.to ?? ""}", which is not an object.`);
        if (spec.multiple && spec.type !== "enum") add(at, `"${name}": only a choice (enum) may hold several values.`);
        if (spec.requiredWhen !== undefined) for (const m of expressionProblems(spec.requiredWhen, inputs)) add(at, `"${name}" required when: ${m}`);
        // Filled in from a record another input names: "lot.machine", the lot's machine, or "lot.qty", its
        // units (a value, copied as the person reads it). That input may
        // itself be filled in (the product's route, then the route's first step), but not in a circle.
        if (spec.from !== undefined) {
            const [source, field, ...rest] = String(spec.from).split(".");
            const src = inputs[source];
            const target = src ? objects[src.to]?.fields?.[field] : null;
            if (!src || src.type !== "ref" || rest.length) add(at, `"${name}": from is "<a reference input>.<its field>", e.g. "lot.machine".`);
            else if (derivedOrder(inputs).circular.includes(name)) add(at, `"${name}": it is filled in from "${source}", which is filled in, in the end, from "${name}": one of them is entered.`);
            else if (!target) add(at, `"${name}": ${src.to} has no field "${field}".`);
            // A reference follows that record (the lot's machine); any other type copies its value (the
            // lot's units), shown read only, as the person reads it.
            else if (spec.type === "ref" ? target.type !== "ref" || target.to !== spec.to : target.type !== spec.type) add(at, spec.type === "ref" || target.type === "ref" ? `"${name}": ${src.to}.${field} ${target.type === "ref" ? `refers to ${target.to}; this input must be a reference to the same` : `is a ${target.type}; this input must be one too`}.` : `"${name}": ${src.to}.${field} is a ${target.type}; this input must be one too.`);
        }
    }
    for (const p of layoutProblems({ fields: inputs, form: body.form })) add(p.path, p.message);
    const refInputs = Object.entries(inputs).filter(([, s]) => s?.type === "ref").map(([n]) => n);

    const where = body.appearsOn;
    if (where !== undefined && where !== null) {
        const def = objects[where?.object];
        if (!isPlain(where) || !def) add("appearsOn", `appearsOn names an object: "${where?.object ?? ""}" is not one.`);
        else {
            for (const st of list(where.states)) if (!list(def.states).includes(st)) add("appearsOn.states", `${where.object} has no state "${st}".`);
            if (!refInputs.includes(where.fills) || inputs[where.fills]?.to !== where.object || inputs[where.fills]?.from !== undefined) add("appearsOn.fills", `appearsOn.fills is the input the record fills in: a reference to ${where.object} that is entered, not derived.`);
            // Only on the records a condition holds for: a lot at a measuring step gets "Track out (SPC)".
            if (where.when !== undefined) for (const m of expressionProblems(where.when, def.fields ?? {})) add("appearsOn.when", `appearsOn when: ${m.replace("a form's condition reads data, record or user", "it reads the record or the user")}`);
        }
    }

    for (const m of scenarioProblems(body, known)) add("scenarios", m);

    for (const [i, r] of list(body.require).entries()) {
        const at = `require.${i}`;
        if (!isPlain(r) || r.that === undefined) { add(at, `Check ${i + 1}: { that: <condition>, message }.`); continue; }
        for (const m of transactionExprProblems(r.that, body, known)) add(at, `Check ${i + 1}: ${m}`);
        if (typeof r.message !== "string" || !r.message.trim() || r.message.length > 300) add(at, `Check ${i + 1}: say in words what is wrong when it fails (at most 300 characters).`);
        if (r.field !== undefined && !Object.hasOwn(inputs, r.field)) add(at, `Check ${i + 1}: "${r.field}" is not an input.`);
    }

    const steps = list(body.steps);
    if (!steps.length) add("steps", "A transaction has at least one step.");
    for (const [i, st] of steps.entries()) {
        const at = `steps.${i}`;
        if (!isPlain(st)) { add(at, `Step ${i + 1} is an object.`); continue; }
        // A step of a kind an installed suite adds (§30.11): { step: "<suite>.<kind>", <setting>: value, when? }.
        if (st.step !== undefined) {
            const spec = isPlain(known.suiteSteps) ? known.suiteSteps[st.step] : undefined;
            if (typeof st.step !== "string" || !/^[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9_]{0,47}$/.test(st.step)) { add(at, `Step ${i + 1}: a suite's step is named "<suite>.<kind>".`); continue; }
            if (st.on !== undefined || st.create !== undefined || st.set !== undefined || st.action !== undefined) add(at, `Step ${i + 1}: a "${st.step}" step writes no record itself: it names no "on", "create", "set" or action.`);
            const settings = Object.entries(st).filter(([k]) => !["step", "when", "label"].includes(k));
            if (isPlain(known.suiteSteps) && !spec) add(at, `Step ${i + 1}: a "${st.step}" step needs the ${st.step.split(".")[0]} suite, which is not installed here.`);
            if (spec) {
                for (const k of list(spec.required)) if (st[k] === undefined || st[k] === null || st[k] === "") add(at, `Step ${i + 1} (${spec.label ?? st.step}): "${k}" is needed.`);
                // (A kind whose config has "*" takes settings of names it decides: a command's parameters.)
                if (!Object.hasOwn(spec.config ?? {}, "*")) for (const [k] of settings) if (!Object.hasOwn(spec.config ?? {}, k)) add(at, `Step ${i + 1} (${spec.label ?? st.step}): it has no setting "${k}" (${Object.keys(spec.config ?? {}).join(", ") || "none"}).`);
                // What cannot be taken back comes last: every step after it could still refuse.
                if (spec.irreversible && steps.slice(i + 1).some((later) => !(isPlain(later) && known.suiteSteps[later.step]?.irreversible))) add(at, `Step ${i + 1} (${spec.label ?? st.step}) cannot be taken back, so it comes after every step that can still refuse: move it to the end.`);
            }
            for (const [k, e] of settings) for (const m of transactionExprProblems(e, body, known)) add(at, `Step ${i + 1}, ${k}: ${m}`);
            if (st.when !== undefined) for (const m of transactionExprProblems(st.when, body, known)) add(at, `Step ${i + 1} when: ${m}`);
            continue;
        }
        // A step that creates a record (§25.1): of an object, its fields set; once, or once per row.
        if (st.create !== undefined) {
            const def = objects[st.create];
            if (!def) { add(at, `Step ${i + 1}: "${st.create}" is not an object.`); continue; }
            if (st.on !== undefined || st.action !== undefined) add(at, `Step ${i + 1}: a step that creates a record names no "on" and takes no action.`);
            if (st.forEach !== undefined && inputs[st.forEach]?.type !== "rows") add(at, `Step ${i + 1}: forEach names a rows input.`);
            if (!isPlain(st.set) || !Object.keys(st.set).length) add(at, `Step ${i + 1}: set the new ${st.create}'s fields: { field: value }.`);
            for (const [f, e] of Object.entries(isPlain(st.set) ? st.set : {})) {
                if (!Object.hasOwn(def.fields ?? {}, f)) add(at, `Step ${i + 1}: ${st.create} has no field "${f}".`);
                for (const m of transactionExprProblems(e, body, known)) add(at, `Step ${i + 1}, ${f}: ${m}`);
                if (st.forEach === undefined && referencesOf(e).some((r) => r.scope === "row")) add(at, `Step ${i + 1}, ${f}: it reads a row, but the step does not run once per row (forEach).`);
            }
            if (st.when !== undefined) for (const m of transactionExprProblems(st.when, body, known)) add(at, `Step ${i + 1} when: ${m}`);
            continue;
        }
        if (!refInputs.includes(st.on)) { add(at, `Step ${i + 1}: "on" names a reference input (${refInputs.join(", ") || "none yet"}).`); continue; }
        const object = inputs[st.on].to;
        const def = objects[object];
        if (!def) continue;
        if (st.set === undefined && st.action === undefined) add(at, `Step ${i + 1}: it sets fields, takes an action, or both.`);
        if (st.set !== undefined) {
            if (!isPlain(st.set) || !Object.keys(st.set).length) add(at, `Step ${i + 1}: set is { field: value }.`);
            for (const [f, e] of Object.entries(isPlain(st.set) ? st.set : {})) {
                if (!Object.hasOwn(def.fields ?? {}, f)) add(at, `Step ${i + 1}: ${object} has no field "${f}".`);
                for (const m of transactionExprProblems(e, body, known)) add(at, `Step ${i + 1}, ${f}: ${m}`);
            }
        }
        if (st.action !== undefined && !list(def.actions).includes(st.action)) add(at, `Step ${i + 1}: ${object} has no action "${st.action}" (${list(def.actions).join(", ")}).`);
        if (st.when !== undefined) for (const m of transactionExprProblems(st.when, body, known)) add(at, `Step ${i + 1} when: ${m}`);
    }

    if (body.confirm !== undefined && typeof body.confirm !== "boolean") add("confirm", "confirm is true or false.");
    // How it is filled from the keyboard (§32.13): an input flow asking for its inputs, by name.
    if (body.inputFlow !== undefined && body.inputFlow !== null) {
        for (const m of inputFlowUseProblems(body.inputFlow, known, {
            targets: (input, how) => (!Object.hasOwn(inputs, input) ? `${input.includes(".") || input === "param" ? "a transaction's input flow names its inputs alone" : `"${input}" is not an input of this transaction`} (${Object.keys(inputs).join(", ")}).` : how === "ask" && inputs[input]?.from ? `${input} is filled in from ${inputs[input].from}: nobody types it.` : null),
            runs: (t) => (t && t !== body.name ? `a transaction's input flow runs that transaction, not ${t}.` : null),
        })) add("inputFlow", m);
    }
    maximizeProblem(body, add);
    if (!list(body.callers?.users).length && !list(body.callers?.groups).length && !list(body.callers?.services).length) add("callers", "Nobody may run it yet: name who may (Callers tab).");
    if (body.signature !== undefined && body.signature !== null && !(isPlain(body.signature) && typeof body.signature.meaning === "string" && body.signature.meaning.trim() && body.signature.meaning.length <= 100)) add("signature", "A signature states its meaning (e.g. \"Performed\"), at most 100 characters.");
    // A second person who verifies it (§7.4): what their signature means, and who may give it.
    const verifier = isPlain(body.signature) ? body.signature.verifier : undefined;
    if (verifier !== undefined && verifier !== null) {
        if (!isPlain(verifier)) add("signature.verifier", "A verifier is { meaning, departments, roles }.");
        else {
            if (!(typeof verifier.meaning === "string" && verifier.meaning.trim() && verifier.meaning.length <= 100)) add("signature.verifier.meaning", "The verifier's signature states its meaning (e.g. \"Verified\"), at most 100 characters.");
            const depts = list(verifier.departments), roles = list(verifier.roles);
            if (!depts.length && !roles.length) add("signature.verifier", "Say who may verify it: a department or a role.");
            for (const d of depts) if (Array.isArray(known.departments) && !known.departments.includes(d)) add("signature.verifier.departments", `"${d}" is not a department.`);
            for (const r of roles) {
                const [object, role, more] = String(r).split(".");
                if (!object || !role || more !== undefined) add("signature.verifier.roles", `"${r}": a role is "<object>.<role>" (e.g. "lot.supervisor").`);
                else if (objects[object] && Array.isArray(objects[object].roles) && !objects[object].roles.includes(role)) add("signature.verifier.roles", `"${r}": ${object} has no role "${role}".`);
                else if (Object.keys(objects).length && !objects[object]) add("signature.verifier.roles", `"${r}": "${object}" is not an object.`);
            }
            for (const k of Object.keys(verifier)) if (!["meaning", "departments", "roles"].includes(k)) add("signature.verifier", `"${k}" is not meaning, departments or roles.`);
        }
    }
    const callers = isPlain(body.callers) ? body.callers : {};
    for (const u of list(callers.users)) if (!(known.users ?? []).includes(u)) add("callers.users", `"${u}" is not a user.`);
    for (const g of list(callers.groups)) if (!(known.groups ?? []).includes(g)) add("callers.groups", `"${g}" is not a group.`);
    // Services that may run it (§15.2): as their own service role, from their scripts. A signature is a
    // person's: a signed transaction names no service.
    if (callers.services !== undefined && !(Array.isArray(callers.services) && callers.services.every((x) => typeof x === "string" && IDENTIFIER.test(x)))) add("callers.services", "callers.services lists the services that may run it, by name.");
    for (const sv of list(callers.services)) if (Array.isArray(known.services) && !known.services.includes(sv)) add("callers.services", `"${sv}" is not a service.`);
    if (list(callers.services).length && body.signature) add("callers.services", "It is signed by the person running it: a service may not run it. Take the services out of its callers, or the signature off.");
    // A service that runs it as its own role (`known.runBy`: transaction → services) keeps needing it.
    for (const sv of list(known.runBy?.[body.name]).filter((x) => !list(callers.services).includes(x))) add("callers.services", `The service ${sv} runs it (what it may touch names it): keep ${sv} among its callers, or take the transaction out of ${sv}'s design in this change.`);
    departmentsProblem(body.stewards, known, add);
    return problems;
}

// The inputs filled in from others ("from"), in an order where each comes after the one it is filled in
// from (a design's inputs are stored as JSON, whose keys keep no order); those in a circle, apart.
export function derivedOrder(inputs) {
    const derived = Object.entries(isPlain(inputs) ? inputs : {}).filter(([, s]) => isPlain(s) && typeof s.from === "string").map(([k, s]) => [k, s.from.split(".")[0]]);
    const order = [];
    let left = derived;
    while (left.length) {
        const ready = left.filter(([, source]) => !left.some(([k]) => k === source));
        if (!ready.length) break;
        order.push(...ready.map(([k]) => k));
        left = left.filter((d) => !ready.includes(d));
    }
    return { order, circular: left.map(([k]) => k) };
}

export const TRANSACTION_KEYS = ["label", "description", "inputs", "form", "appearsOn", "require", "steps", "scenarios", "confirm", "signature", "maximize", "inputFlow", "callers", "stewards"];

// A transaction's scenarios (§5.11, sandbox.js): what is wrong with their shape, in words. Each runs
// in a sandbox; its records are picked ({ object, id?, where? }) or given ({ object, data, state? });
// its steps do one thing each, as someone, and say what they expect.
const STEP_KINDS = ["transaction", "action", "update", "create", "service", "screen", "act"];
// `of`: "transaction" (each scenario runs it) or "flow" (each expects a node of the template, §32.8).
export function scenarioProblems(body, known = {}, of = "transaction") {
    const out = [];
    const list = body?.scenarios;
    if (list === undefined) return out;
    if (!Array.isArray(list) || list.length > 20) return ["scenarios is a list of at most 20."];
    const objects = known.objects ?? {};
    list.forEach((sc, i) => {
        const at = `Scenario ${i + 1}${sc?.name ? ` "${sc.name}"` : ""}`;
        if (!isPlain(sc)) { out.push(`${at}: { name, records, steps }.`); return; }
        if (typeof sc.name !== "string" || !sc.name.trim() || sc.name.length > 120) out.push(`${at}: give it a name (at most 120 characters).`);
        if (list.findIndex((x) => x?.name === sc.name) !== i) out.push(`${at}: two scenarios have this name.`);
        const keys = new Set();
        for (const [k, r] of Object.entries(isPlain(sc.records) ? sc.records : {})) {
            keys.add(k);
            if (!IDENTIFIER.test(k)) out.push(`${at}: "${k}": a record's key is lower case letters, digits and _.`);
            if (!isPlain(r) || !Object.hasOwn(objects, r.object)) { out.push(`${at}: ${k}: "${r?.object ?? ""}" is not an object.`); continue; }
            if (r.data !== undefined && !isPlain(r.data)) out.push(`${at}: ${k}: data is { field: value }.`);
            if (r.where !== undefined && !isPlain(r.where)) out.push(`${at}: ${k}: where is { field: [values] }.`);
            if (r.state !== undefined && !list_(objects[r.object].states).includes(r.state)) out.push(`${at}: ${k}: ${r.object} has no state "${r.state}".`);
        }
        if (sc.records !== undefined && !isPlain(sc.records)) out.push(`${at}: records is { key: { object, … } }.`);
        const steps = Array.isArray(sc.steps) ? sc.steps : [];
        if (!steps.length || steps.length > 50) out.push(`${at}: one to 50 steps.`);
        for (const st of steps) if (isPlain(st?.do) && typeof st.do.create === "string" && typeof st.do.key === "string") keys.add(st.do.key);
        const refs = (v) => (typeof v === "string" && v.startsWith("@") ? [v.slice(1)] : Array.isArray(v) ? v.flatMap(refs) : isPlain(v) ? Object.values(v).flatMap(refs) : []);
        steps.forEach((st, j) => {
            const where = `${at}, step ${j + 1}`;
            const kinds = isPlain(st?.do) ? STEP_KINDS.filter((kind) => st.do[kind] !== undefined) : [];
            if (kinds.length !== 1) { out.push(`${where}: it does one of ${STEP_KINDS.join(", ")}.`); return; }
            if (st.as !== undefined && (typeof st.as !== "string" || (known.users && !known.users.includes(st.as)))) out.push(`${where}: "${st.as}" is nobody here.`);
            for (const k of refs(st.do)) if (!keys.has(k)) out.push(`${where}: "@${k}" names no record of the scenario.`);
            if (st.do.act !== undefined && (!isPlain(st.do.act) || typeof st.do.act.record !== "string" || (st.do.act.action !== undefined && !["acknowledge", "retry", "time_up"].includes(st.do.act.action)))) out.push(`${where}: act is { record: "@key", plan?, action?: acknowledge | retry | time_up, choice?, values? }.`);
            if (st.expect !== undefined) {
                if (!isPlain(st.expect)) out.push(`${where}: expect is { ok, error, states, fields, created, node }.`);
                else for (const k of Object.keys({ ...(st.expect.states ?? {}), ...(st.expect.fields ?? {}), ...(isPlain(st.expect.node) ? st.expect.node : {}) })) if (!keys.has(k)) out.push(`${where}: it expects something of "${k}", which is no record of the scenario.`);
                if (of === "flow" && isPlain(st.expect.node)) for (const [k, n] of Object.entries(st.expect.node)) if (isPlain(body.nodes) && !Object.hasOwn(body.nodes, n)) out.push(`${where}: "${n}" (expected of ${k}) is no node of this template.`);
            }
        });
        if (of === "transaction" && body.name && !steps.some((st) => st?.do?.transaction === body.name)) out.push(`${at}: none of its steps runs ${body.name}.`);
        if (of === "flow" && !steps.some((st) => isPlain(st?.expect?.node))) out.push(`${at}: none of its steps expects a node of this template (expect.node).`);
    });
    return out;
}
const list_ = (v) => (Array.isArray(v) ? v : []);

// A transaction's footprint (§5.6), by the rules above; it also answers to the stewards of what its
// steps write: of each object, of each field it sets and of each transition it takes.
//   context: { objects: { name: definition body } } (live and drafted)
export function transactionFootprint(name, before, after, context = {}) {
    if (same(before, after)) return [];
    const reach = (body) => {
        if (!body) return [];
        const inputs = isPlain(body.inputs) ? body.inputs : {};
        return list(body.steps).flatMap((st) => {
            // A record it creates answers to that object's stewards.
            if (st?.create !== undefined) return list(context.objects?.[st.create]?.stewards?.object);
            const def = context.objects?.[inputs[st?.on]?.to];
            if (!def) return [];
            return [
                ...list(def.stewards?.object),
                ...Object.keys(isPlain(st.set) ? st.set : {}).flatMap((f) => stewardsOf(def.stewards, "field", f)),
                ...(st.action ? stewardsOf(def.stewards, "transition", st.action) : []),
            ];
        });
    };
    const answer = (change, extra = []) => [...new Set([
        ...(change !== "added" ? list(before?.stewards) : []),
        ...(change !== "removed" ? list(after?.stewards) : []),
        ...extra,
    ])].filter(Boolean).sort();
    const element = `transaction:${name}`;
    if (!before) return [{ element, change: "added", stewards: answer("added", reach(after)) }];
    if (!after) return [{ element, change: "removed", stewards: answer("removed", reach(before)) }];
    const out = [];
    for (const key of TRANSACTION_KEYS) {
        if (same(before[key], after[key])) continue;
        out.push({ element: `${element}.${key}`, change: "changed", stewards: answer("changed", key === "steps" || key === "inputs" ? [...reach(before), ...reach(after)] : []) });
    }
    return out;
}

// ---- screens (§26): pages composed of fixed building blocks ------------------------------------
//
// A screen is a definition: its parameter (what it is opened with: a machine), and its blocks, each a
// building block from a fixed list, never code. Every block reads with the viewer's own rights, so a
// screen shows no more than that person's forms would.
//
//   { name, label, description,
//     params: { machine: { label, type: "ref", to: "machine", required?, widget?: "scan" | "select",
//               where?: { field | "state": [values] } (only such records open it: a die saw's screen, die saws) } }  (at most one),
//     blocks: [ { block, title?, width?: 3–12, tab?: a label (blocks naming one share a tab; the rest show above the tabs),
//                 showWhen?: <condition> (not drawn, and not read, unless it holds),
//                 enableWhen?: <condition> (drawn, greyed and unusable unless it holds), disabledBecause?: why, in words;
//                   a tab none of whose blocks is shown is not there, one none of whose shown blocks is enabled is greyed (§26.9),
//                 record:      object, of: <expression, a record id>, show: [fields]
//                 table:       object, where, columns: [fields], sort?: { field, dir }, limit?: 1–1000 (200), pageSize?: 5–200 (25 drawn at a time, more as scrolled), rowActions?: [transactions],
//                              create?: a New button, archive?: a Remove (archive) button on each row — the object's own, through its policies
//                 kpi:         object, where, measure: "count" | { sum | avg | min | max: field }, since?: today | 7d | 30d, label
//                 breakdown:   object, where, by: field | "state", measure
//                 transaction: name, fills?: { input: <expression> }
//                 text:        text } ],
//     maximize?: "toggle" | "start" (the page may fill the window, see MAXIMIZE),
//     callers: { users, groups }, stewards: [departments] }
//
// `where` is { field | "state" | "type": <expression> | [values] }; expressions read { param } and { user }.
// ---- a design element of a kind a suite adds (§30.11) ----
// { name, kind: "<suite>.<kind>", label, description?, stewards: [departments], …the kind's own }.
// The core checks what every element has; the suite checks the rest (known.suiteElements: kind →
// { label }, the installed ones; the server runs the suite's own check). With its suite removed it
// stays published and listed, as it is; a change that holds it waits for the suite.
// (SUITE_KIND, "<suite>.<kind>": schedule.js, which a suite's kind of schedule is named by too.)
export { SUITE_KIND };
export function validateSuiteElement(body, known = {}) {
    const problems = [];
    const add = (path, message) => problems.push({ path, message });
    if (!isPlain(body)) return [{ path: "", message: "A design element is an object." }];
    if (typeof body.name !== "string" || !IDENTIFIER.test(body.name)) add("name", "Its name is lower case letters, digits and _, starting with a letter.");
    if (typeof body.kind !== "string" || !SUITE_KIND.test(body.kind)) add("kind", 'Its kind is "<suite>.<kind>", as the suite names it.');
    else if (isPlain(known.suiteElements) && !known.suiteElements[body.kind]) add("kind", `It is a "${body.kind}", of the ${body.kind.split(".")[0]} suite, which is not installed here: it stays as it is, and this change waits until the suite is back.`);
    if (typeof body.label !== "string" || !body.label.trim() || body.label.length > 100) add("label", "Give it a label, at most 100 characters.");
    if (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 1000)) add("description", "The description is text, at most 1000 characters.");
    const stewards = list(body.stewards);
    if (!stewards.length) add("stewards", "Name its stewards: the departments that approve a change to it.");
    for (const d of stewards) if (Array.isArray(known.departments) && !known.departments.includes(d)) add("stewards", `"${d}" is not a department.`);
    return problems;
}
// Who answers for a change to one: its stewards, before and after.
export function suiteElementFootprint(name, before, after) {
    if (same(before, after)) return [];
    const of = (b) => list(b?.stewards);
    const answer = [...new Set([...of(before), ...of(after)])].filter(Boolean).sort();
    const element = `element:${name}`;
    if (!before) return [{ element, change: "added", stewards: of(after).slice().sort() }];
    if (!after) return [{ element, change: "removed", stewards: of(before).slice().sort() }];
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !same(before[k], after[k])).map((k) => ({ element: `${element}.${k}`, change: "changed", stewards: answer }));
}

export const BLOCKS = ["record", "table", "kpi", "breakdown", "chart", "transaction", "text", "button", "floor"];
// What every block may carry, a suite's included (its own settings are its kind's `config`).
export const SUITE_BLOCK_KEYS = ["block", "title", "width", "tab", "showWhen", "enableWhen", "disabledBecause"];
export const MEASURES = ["sum", "avg", "min", "max"];
export const SINCE = ["today", "7d", "30d"];
export const SCREEN_KEYS = ["label", "description", "params", "blocks", "maximize", "popup", "inputFlow", "callers", "stewards"];

function screenExprProblems(expr, params) {
    try {
        const out = [];
        for (const ref of referencesOf(expr)) {
            if (ref.scope === "user") continue;
            if (ref.scope === "param") { if (!Object.hasOwn(params, String(ref.path))) out.push(`it reads param.${ref.path}, which is not a parameter.`); continue; }
            out.push(`it reads ${ref.scope}, but a screen reads param or user.`);
        }
        return out;
    } catch (error) {
        return [error.message];
    }
}

// What is wrong with a block's condition (showWhen, enableWhen, §26.9). It reads what the screen has:
// its parameter ({ param }), the record it was opened with ({ lookup: "<param>.<field>" }, as the viewer
// may read it), who is looking ({ user }: id, name, departments), and counts of records ({ count }).
function blockCondProblems(expr, params, objects) {
    try {
        const out = [];
        for (const ref of referencesOf(expr)) {
            if (ref.scope === "user") continue;
            if (ref.scope === "param") { if (!Object.hasOwn(params, String(ref.path))) out.push(`it reads param.${ref.path}, which is not a parameter.`); continue; }
            if (ref.scope === "lookup") {
                const [of, field, ...rest] = String(ref.path).split(".");
                const spec = params[of];
                if (!spec) out.push(`it reads ${ref.path}, and ${of} is not the screen's parameter.`);
                else if (spec.type !== "ref") out.push(`it reads ${ref.path}, and ${of} is not a record (its parameter is a ${spec.type}).`);
                else if (!field || rest.length) out.push(`it reads ${ref.path}: name one field of the record, ${of}.<field>.`);
                else if (field !== "state" && field !== "id" && !Object.hasOwn(objects[spec.to]?.fields ?? {}, field)) out.push(`it reads ${ref.path}, and ${spec.to} has no field "${field}".`);
                continue;
            }
            out.push(`it reads ${ref.scope}, but a block's condition reads param, lookup or user.`);
        }
        for (const c of countNodesOf(expr)) {
            if (!isPlain(c) || !Object.hasOwn(objects, c.object)) { out.push(`it counts "${c?.object ?? ""}", which is not an object.`); continue; }
            for (const k of Object.keys(isPlain(c.where) ? c.where : {})) if (k !== "state" && k !== "type" && !Object.hasOwn(objects[c.object].fields ?? {}, k)) out.push(`it counts ${c.object} by "${k}", which is not a field of it.`);
        }
        // Worked out once on nothing: an operator the language does not have is said here.
        explainExpression(expr, { param: {}, user: { id: "", departments: [] }, lookup: {}, counts: {} });
        return out;
    } catch (error) {
        return [error.message];
    }
}

// known: { objects: { name: { fields, states } }, transactions: { name: { inputs, appearsOn } }, users, groups, departments }
export function validateScreen(body, known = {}) {
    const problems = [];
    const add = (path, message) => problems.push({ path, message });
    if (!isPlain(body)) return [{ path: "", message: "A screen is an object." }];
    if (!IDENTIFIER.test(body.name ?? "")) add("name", "A screen's name is lower case letters, digits and _.");
    if (!(typeof body.label === "string" && body.label.trim())) add("label", "Give the screen a label.");
    maximizeProblem(body, add);
    // How it is filled from the keyboard (§32.13): an input flow asking for its parameter ("param") and
    // its transaction blocks' inputs ("<transaction>.<input>"; the input alone when it has one block).
    if (body.inputFlow !== undefined && body.inputFlow !== null) {
        const forms = list(body.blocks).filter((b) => b?.block === "transaction" && typeof b.name === "string").map((b) => b.name);
        const inputsOf = (t) => known.transactions?.[t]?.inputs ?? null;
        for (const m of inputFlowUseProblems(body.inputFlow, known, {
            targets: (input, how) => {
                if (input === "param") return Object.keys(isPlain(body.params) ? body.params : {}).length ? (how === "fill" ? "the parameter is what the screen is opened with: it is asked for, not filled." : null) : "the screen has no parameter.";
                const [t, field] = input.includes(".") ? input.split(".") : [forms.length === 1 ? forms[0] : null, input];
                if (!t) return forms.length ? `the screen has several transactions (${forms.join(", ")}): name which, "<transaction>.${input}".` : "the screen has no transaction block.";
                if (!forms.includes(t)) return `${t} is not a transaction block of this screen${forms.length ? ` (${forms.join(", ")})` : ""}.`;
                const ins = inputsOf(t);
                if (ins && !Object.hasOwn(ins, field)) return `${t} has no input "${field}" (${Object.keys(ins).join(", ")}).`;
                if (ins && how === "ask" && ins[field]?.from) return `${t}.${field} is filled in from ${ins[field].from}: nobody types it.`;
                return null;
            },
            runs: (t) => (t ? (forms.includes(t) ? null : `${t} is not a transaction block of this screen.`) : forms.length === 1 ? null : forms.length ? `the screen has several transactions (${forms.join(", ")}): say which it runs.` : "the screen has no transaction block to run."),
        })) add("inputFlow", m);
    }
    const objects = known.objects ?? {};
    const transactions = known.transactions ?? {};
    const params = isPlain(body.params) ? body.params : {};
    if (Object.keys(params).length > 1) add("params", "A screen has at most one parameter (what it is opened with).");
    for (const [name, spec] of Object.entries(params)) {
        if (!IDENTIFIER.test(name)) add(`params.${name}`, `"${name}": a parameter's name is lower case letters, digits and _.`);
        if (!isPlain(spec) || !["ref", "string", "enum", "date"].includes(spec.type)) { add(`params.${name}`, `"${name}": a parameter is a ref, string, enum or date.`); continue; }
        if (spec.type === "ref" && !Object.hasOwn(objects, spec.to)) add(`params.${name}`, `"${name}": refers to "${spec.to ?? ""}", which is not an object.`);
        if (spec.type === "enum" && !list(spec.values).length) add(`params.${name}`, `"${name}": list the values it may take.`);
        if (spec.widget !== undefined && !["scan", "select"].includes(spec.widget)) add(`params.${name}`, `"${name}": it is picked with scan or select.`);
        // Which records it opens with: fields equal to plain values (literal, not expressions).
        if (spec.where !== undefined) {
            const fields = objects[spec.to]?.fields ?? {};
            if (spec.type !== "ref" || !isPlain(spec.where)) add(`params.${name}`, `"${name}": where is { field: [values] }, for a reference.`);
            else for (const [f, v] of Object.entries(spec.where)) {
                if (f !== "state" && !Object.hasOwn(fields, f)) add(`params.${name}`, `"${name}": ${spec.to} has no field "${f}".`);
                if (!list(v).length || !list(v).every((x) => ["string", "number", "boolean"].includes(typeof x))) add(`params.${name}`, `"${name}": where ${f} is a value or a list of values.`);
            }
        }
    }
    const blocks = list(body.blocks);
    if (!blocks.length) add("blocks", "A screen has at least one block.");
    if (blocks.length > 20) add("blocks", "A screen has at most 20 blocks.");
    const fieldsOf = (object) => objects[object]?.fields ?? {};
    const isField = (object, f) => f === "state" || Object.hasOwn(fieldsOf(object), f);
    for (const [i, b] of blocks.entries()) {
        const at = `blocks.${i}`;
        const name = `Block ${i + 1}${b?.title ? ` (${b.title})` : ""}`;
        // A block of a kind an installed suite adds (§30.11): "<suite>.<kind>", its settings its own.
        const suiteKind = isPlain(b) && typeof b.block === "string" && /^[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9_]{0,47}$/.test(b.block);
        if (!isPlain(b) || (!BLOCKS.includes(b.block) && !suiteKind)) { add(at, `${name}: the block is one of ${BLOCKS.join(", ")}${Object.keys(known.suiteBlocks ?? {}).length ? `, or a suite's (${Object.keys(known.suiteBlocks).join(", ")})` : ""}.`); continue; }
        if (b.width !== undefined && !(Number.isInteger(b.width) && b.width >= 3 && b.width <= 12)) add(at, `${name}: width is 3 to 12 (of a 12-column row).`);
        if (b.tab !== undefined && !(typeof b.tab === "string" && b.tab.trim() && b.tab.length <= 40)) add(at, `${name}: a tab is a label of at most 40 characters.`);
        if (b.title !== undefined && (typeof b.title !== "string" || b.title.length > 100)) add(at, `${name}: the title is text, at most 100 characters.`);
        // When it is shown, and when it may be used (§26.9): conditions on what the screen has.
        for (const [k, words] of [["showWhen", "shown when"], ["enableWhen", "enabled when"]]) {
            if (b[k] !== undefined) for (const m of blockCondProblems(b[k], params, objects)) add(at, `${name}, ${words}: ${m}`);
        }
        if (b.disabledBecause !== undefined) {
            if (typeof b.disabledBecause !== "string" || !b.disabledBecause.trim() || b.disabledBecause.length > 200) add(at, `${name}: why it is disabled is text, at most 200 characters.`);
            else if (b.enableWhen === undefined) add(at, `${name}: it says why it is disabled, but nothing ever disables it: give "enabled when", or take the reason out.`);
        }
        if (suiteKind) {
            const spec = isPlain(known.suiteBlocks) ? known.suiteBlocks[b.block] : undefined;
            if (isPlain(known.suiteBlocks) && !spec) add(at, `${name}: a "${b.block}" block needs the ${b.block.split(".")[0]} suite, which is not installed here.`);
            if (spec) {
                for (const k of list(spec.required)) if (b[k] === undefined || b[k] === null || b[k] === "") add(at, `${name} (${spec.label ?? b.block}): "${k}" is needed.`);
                for (const k of Object.keys(b)) if (!SUITE_BLOCK_KEYS.includes(k) && !Object.hasOwn(spec.config ?? {}, k)) add(at, `${name} (${spec.label ?? b.block}): it has no setting "${k}" (${Object.keys(spec.config ?? {}).join(", ") || "none"}).`);
            }
            continue;
        }
        const needsObject = ["record", "table", "kpi", "breakdown", "floor"].includes(b.block);
        if (needsObject && !Object.hasOwn(objects, b.object)) { add(at, `${name}: "${b.object ?? ""}" is not an object.`); continue; }
        if (b.where !== undefined) {
            if (!isPlain(b.where)) add(at, `${name}: where is { field: value }.`);
            for (const [k, v] of Object.entries(isPlain(b.where) ? b.where : {})) {
                if (k !== "type" && !isField(b.object, k)) add(at, `${name}: ${b.object} has no field "${k}".`);
                for (const m of screenExprProblems(v, params)) add(at, `${name}, where ${k}: ${m}`);
            }
        }
        const numeric = (f) => ["integer", "decimal"].includes(fieldsOf(b.object)[f]?.type);
        const measureOk = (m) => m === "count" || (isPlain(m) && Object.keys(m).length === 1 && MEASURES.includes(Object.keys(m)[0]) && numeric(Object.values(m)[0]));
        switch (b.block) {
            // A floor layout (§35): records where they stand, each with its state as it is now.
            case "floor":
                for (const m of floorProblems(b, objects[b.object], objects)) add(at, `${name}: ${m}`);
                break;
            case "record":
                if (b.of === undefined) add(at, `${name}: "of" says which record (e.g. {"param": "machine"}).`);
                else for (const m of screenExprProblems(b.of, params)) add(at, `${name}: ${m}`);
                for (const f of list(b.show)) if (!isField(b.object, f)) add(at, `${name}: ${b.object} has no field "${f}".`);
                break;
            case "table":
                if (!list(b.columns).length) add(at, `${name}: list the columns.`);
                for (const f of list(b.columns)) if (!isField(b.object, f)) add(at, `${name}: ${b.object} has no field "${f}".`);
                if (b.sort !== undefined && !(isPlain(b.sort) && isField(b.object, b.sort.field) && ["asc", "desc"].includes(b.sort.dir ?? "asc"))) add(at, `${name}: sort is { field, dir: asc | desc }.`);
                if (b.limit !== undefined && !(Number.isInteger(b.limit) && b.limit >= 1 && b.limit <= 1000)) add(at, `${name}: limit is 1 to 1000 rows.`);
                if (b.pageSize !== undefined && !(Number.isInteger(b.pageSize) && b.pageSize >= 5 && b.pageSize <= 200)) add(at, `${name}: a page is 5 to 200 rows.`);
                // The object's own record buttons, as a form has them: through its policies, as the viewer.
                for (const k of ["create", "archive"]) if (b[k] !== undefined && typeof b[k] !== "boolean") add(at, `${name}: ${k} is true or false.`);
                for (const t of list(b.rowActions)) {
                    const tx = transactions[t];
                    if (!tx) add(at, `${name}: "${t}" is not a transaction.`);
                    else if (tx.appearsOn?.object !== b.object) add(at, `${name}: ${t} does not appear on ${b.object} records (its appearsOn), so a row cannot start it.`);
                }
                // What its row buttons fill in besides the row (the screen's machine on Move in).
                for (const [k, v] of Object.entries(isPlain(b.fills) ? b.fills : {})) {
                    if (!list(b.rowActions).some((t) => Object.hasOwn(transactions[t]?.inputs ?? {}, k) && transactions[t].inputs[k].from === undefined)) add(at, `${name}: no row button's transaction has an entered input "${k}" to fill.`);
                    for (const m of screenExprProblems(v, params)) add(at, `${name}, ${k}: ${m}`);
                }
                if (b.fills !== undefined && !isPlain(b.fills)) add(at, `${name}: fills is { input: expression }.`);
                break;
            case "kpi":
                if (!(typeof b.label === "string" && b.label.trim()) && !(typeof b.title === "string" && b.title.trim())) add(at, `${name}: give the number a label.`);
                if (!measureOk(b.measure ?? "count")) add(at, `${name}: the measure is "count", or { sum | avg | min | max: a number field }.`);
                if (b.since !== undefined && !SINCE.includes(b.since)) add(at, `${name}: since is ${SINCE.join(", ")}.`);
                break;
            case "breakdown":
                if (!isField(b.object, b.by)) add(at, `${name}: by names a field of ${b.object}, or state.`);
                else if (b.by !== "state" && ["text", "decimal", "integer", "date"].includes(fieldsOf(b.object)[b.by]?.type)) add(at, `${name}: group by a short field (a choice, a reference, text of a few words, or state).`);
                if (!measureOk(b.measure ?? "count")) add(at, `${name}: the measure is "count", or { sum | avg | min | max: a number field }.`);
                break;
            case "transaction": {
                const tx = transactions[b.name];
                if (!tx) { add(at, `${name}: "${b.name ?? ""}" is not a transaction.`); break; }
                for (const [k, v] of Object.entries(isPlain(b.fills) ? b.fills : {})) {
                    if (!Object.hasOwn(tx.inputs ?? {}, k)) add(at, `${name}: ${b.name} has no input "${k}".`);
                    for (const m of screenExprProblems(v, params)) add(at, `${name}, ${k}: ${m}`);
                }
                if (b.closeOnDone !== undefined && typeof b.closeOnDone !== "boolean") add(at, `${name}: closeOnDone is true or false.`);
                break;
            }
            // A button that opens a screen as a dialog (§26.6), opened with `with` (its parameter).
            case "button":
                if (!IDENTIFIER.test(b.opens ?? "") || (known.screens && !known.screens.includes(b.opens))) add(at, `${name}: "${b.opens ?? ""}" is not a screen.`);
                if (b.label !== undefined && (typeof b.label !== "string" || !b.label.trim() || b.label.length > 60)) add(at, `${name}: a button's label, at most 60 characters.`);
                if (b.with !== undefined) for (const m of screenExprProblems(b.with, params)) add(at, `${name}, with: ${m}`);
                break;
            case "text":
                if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 2000) add(at, `${name}: the text, at most 2000 characters.`);
                break;
            // A chart (§34.9): a query, run as the viewer over the views of the Queries page, drawn as its
            // spec says. A JSON query's where may name the screen's parameter ({"param": "machine"}).
            case "chart": {
                const q = b.query;
                const sql = isPlain(q) && typeof q.sql === "string" && q.sql.trim();
                const jq = isPlain(q) && isPlain(q.json);
                if (!sql && !jq) add(at, `${name}: its query is { sql: "SELECT …" } or { json: { from, select, … } }.`);
                else if (sql && jq) add(at, `${name}: its query is SQL or JSON, not both.`);
                else if (sql && q.sql.length > 20_000) add(at, `${name}: a query is at most 20 000 characters.`);
                else if (sql && /\{\s*"?param"?\s*:/.test(q.sql)) add(at, `${name}: only a JSON query names the screen's parameter.`);
                for (const m of chartProblems(chartOf(b))) add(at, `${name}: ${m}`);
                for (const k of Object.keys(b)) if (![...SUITE_BLOCK_KEYS, "query", ...Object.keys(CHART_KEYS)].includes(k)) add(at, `${name}: a chart block has no "${k}".`);
                break;
            }
            default:
        }
    }
    // A pop-up (§26.7): the pages it opens over, for whom, while what holds, opened with what.
    if (body.popup !== undefined && body.popup !== null) {
        const p = body.popup;
        if (!isPlain(p)) add("popup", "A pop-up is { on, for, while, with? }.");
        else {
            const on = list(p.on);
            if (!on.length) add("popup.on", "Name the pages it opens over: transaction:<name>, screen:<name>, or * for every page.");
            for (const target of on) {
                const m = /^(?:(transaction|screen):([a-z][a-z0-9_]*)|(\*))$/.exec(String(target));
                if (!m) add("popup.on", `"${target}": a page is transaction:<name>, screen:<name> or *.`);
                else if (m[1] === "transaction" && !transactions[m[2]]) add("popup.on", `"${m[2]}" is not a transaction.`);
                else if (m[1] === "screen" && known.screens && !known.screens.includes(m[2]) && m[2] !== body.name) add("popup.on", `"${m[2]}" is not a screen.`);
            }
            const who = isPlain(p.for) ? p.for : {};
            if (!list(who.users).length && !list(who.groups).length) add("popup.for", "Name whom it opens for (users or groups).");
            for (const u of list(who.users)) if (!(known.users ?? []).includes(u)) add("popup.for", `"${u}" is not a user.`);
            for (const g of list(who.groups)) if (!(known.groups ?? []).includes(g)) add("popup.for", `"${g}" is not a group.`);
            if (p.while === undefined) add("popup.while", "Say while what it opens (a condition).");
            for (const [key, e] of [["while", p.while], ["with", p.with]]) {
                if (e === undefined) continue;
                try {
                    for (const ref of referencesOf(e)) if (!["input", "lookup", "param", "user"].includes(ref.scope)) add(`popup.${key}`, `It reads ${ref.scope}; a pop-up reads input, lookup, param, user and counts.`);
                } catch (error) {
                    add(`popup.${key}`, error.message);
                }
            }
        }
    }
    const callers = isPlain(body.callers) ? body.callers : {};
    // Deny by default: a screen nobody may open would be published for no one.
    if (!list(callers.users).length && !list(callers.groups).length) add("callers", "Nobody may open it yet: name who may (Callers tab).");
    for (const u of list(callers.users)) if (!(known.users ?? []).includes(u)) add("callers.users", `"${u}" is not a user.`);
    for (const g of list(callers.groups)) if (!(known.groups ?? []).includes(g)) add("callers.groups", `"${g}" is not a group.`);
    departmentsProblem(body.stewards, known, add);
    return problems;
}

// A screen's footprint: its stewards. It writes nothing (a transaction it shows is approved as one),
// and what it reads is each viewer's own rights.
export function screenFootprint(name, before, after) {
    if (same(before, after)) return [];
    const answer = (change) => [...new Set([...(change !== "added" ? list(before?.stewards) : []), ...(change !== "removed" ? list(after?.stewards) : [])])].filter(Boolean).sort();
    const element = `screen:${name}`;
    if (!before) return [{ element, change: "added", stewards: answer("added") }];
    if (!after) return [{ element, change: "removed", stewards: answer("removed") }];
    return SCREEN_KEYS.filter((k) => !same(before[k], after[k])).map((k) => ({ element: `${element}.${k}`, change: "changed", stewards: answer("changed") }));
}

// ---- the organization (§5.6, §8): people, departments, approval steps, roles, standing approvers ----
//
// One design element for the whole plant, changed through change requests like everything else:
//   { governance: <department>,                  approves what no one else stewards, and new departments and people
//     standing: { connection: [departments], … }, who approves every element of a kind, whoever stewards it
//     users: { id: { name, active } },
//     departments: { id: { name, members: [users], approval: [{ label, approvers: [users] }, …] } },   steps in order
//     groups: { id: { name, members: [users] } },
//     roles: { object: { role: ["user:olga", "group:production"] } } }   including the pseudo-objects design and query
export const STANDING_KINDS = ["object", "script", "service", "connection", "transaction", "screen", "layout", "organization"];
// (`auth`: who administers sign-in, §8.2: issues password links, resets a second factor, lifts a lock.)
export const PSEUDO_ROLES = { design: ["designer", "reviewer"], query: ["analyst"], auth: ["administrator"] };
// Who reads every record (§27.7): the organization's `readers`, people and groups ("user:iris",
// "group:it"), who take this role on every object, the designer's and the query page's aside: it reads
// every record and every field (but one a policy hides), and writes nothing. Approved by governance.
export const READ_ALL_ROLE = "$reader";

// The kind of element a footprint entry is about ("service:erp_in.uses" → service; "field:qty" → object).
export function kindOfElement(element) {
    const head = String(element).split(/[:.]/)[0];
    if (["script", "service", "connection", "transaction", "screen", "layout"].includes(head)) return head;
    if (["department", "person", "group", "roles", "standing", "governance"].includes(head)) return "organization";
    return "object";
}
// Standing approvers join every element of their kinds, whoever stewards it.
export function applyStanding(elements, standing = {}) {
    return elements.map((e) => {
        const extra = standing[kindOfElement(e.element)] ?? [];
        return extra.length ? { ...e, stewards: [...new Set([...e.stewards, ...extra])].sort() } : e;
    });
}

// known: { objects: { name: { roles: [..] } }, liveDepartments: [ids], liveRoles: the roles as they are now }
export function validateOrganization(org, known = {}) {
    const problems = [];
    const add = (path, message) => problems.push({ path, message });
    if (!isPlain(org)) return [{ path: "", message: "The organization is an object." }];
    const users = isPlain(org.users) ? org.users : {};
    const departments = isPlain(org.departments) ? org.departments : {};
    const groups = isPlain(org.groups) ? org.groups : {};
    const active = (u) => isPlain(users[u]) && users[u].active !== false;
    for (const [id, u] of Object.entries(users)) {
        if (!IDENTIFIER.test(id)) add(`users.${id}`, `"${id}": a person's id is lower case letters, digits and _.`);
        if (!isPlain(u) || !String(u.name ?? "").trim()) add(`users.${id}`, `${id}: give the person a name.`);
    }
    for (const id of known.liveDepartments ?? []) if (!departments[id]) add(`departments.${id}`, `Department ${id} cannot be removed (its approvals and stewardship are history); rename it, or leave it with no one.`);
    for (const [id, d] of Object.entries(departments)) {
        const at = `departments.${id}`;
        if (!IDENTIFIER.test(id)) add(at, `"${id}": a department's id is lower case letters, digits and _.`);
        if (!isPlain(d) || !String(d.name ?? "").trim()) { add(at, `${id}: give the department a name.`); continue; }
        for (const m of list(d.members)) if (!active(m)) add(at, `${d.name}: member "${m}" is not an active person.`);
        const steps = list(d.approval);
        if (!steps.length) add(at, `${d.name}: it approves in at least one step, with at least one approver.`);
        const seen = new Set();
        for (const [k, st] of steps.entries()) {
            const name = `${d.name}, step ${k + 1}${st?.label ? ` (${st.label})` : ""}`;
            if (!isPlain(st) || !String(st.label ?? "").trim()) add(at, `${name}: give the step a label (e.g. Manager).`);
            if (!list(st?.approvers).length) add(at, `${name}: name at least one approver.`);
            for (const a of list(st?.approvers)) {
                if (!active(a)) add(at, `${name}: approver "${a}" is not an active person.`);
                // An approver signs for the department: they belong to it.
                else if (!list(d.members).includes(a)) add(at, `${name}: ${users[a]?.name ?? a} approves for ${d.name} but is not a member of it.`);
                if (seen.has(a)) add(at, `${d.name}: ${a} approves in two steps; each step is signed by someone else.`);
                seen.add(a);
            }
        }
    }
    for (const [id, g] of Object.entries(groups)) {
        if (Object.hasOwn(departments, id)) add(`groups.${id}`, `"${id}" is both a department and a group.`);
        if (!IDENTIFIER.test(id) || !isPlain(g) || !String(g.name ?? "").trim()) add(`groups.${id}`, `Group "${id}": an id (lower case) and a name.`);
        for (const m of list(g?.members)) if (!active(m)) add(`groups.${id}`, `Group ${g?.name ?? id}: member "${m}" is not an active person.`);
    }
    if (!Object.hasOwn(departments, org.governance)) add("governance", "Name the governance department: it approves what nobody else stewards.");
    // Who reads every record: people and groups that exist.
    if (org.readers !== undefined && !Array.isArray(org.readers)) add("readers", "Who reads every record is a list of people and groups.");
    for (const s of list(org.readers)) {
        const [kind, sid] = String(s).split(":");
        if (kind === "user" ? !active(sid) : kind === "group" ? !(Object.hasOwn(departments, sid) || Object.hasOwn(groups, sid)) : true) add("readers", `Reads every record: "${s}" is not an active person (user:<id>) or a department or group (group:<id>).`);
    }
    // How the plant writes dates, times and numbers (§27.6, format.js).
    for (const p of formatsProblems(org.formats)) add("formats", p);
    // How the plant's pages look, and whether each person picks light or dark (§10.8, theme.js).
    for (const p of themeProblems(org.theme)) add("theme", p);
    for (const [kind, depts] of Object.entries(isPlain(org.standing) ? org.standing : {})) {
        if (!STANDING_KINDS.includes(kind)) add("standing", `Standing approvers are per kind: ${STANDING_KINDS.join(", ")}; not "${kind}".`);
        for (const d of list(depts)) if (!Object.hasOwn(departments, d)) add("standing", `Standing approvers for ${kind}: "${d}" is not a department.`);
    }
    // Someone must always be able to change the system, this included: only a designer starts a change
    // (People & departments too), and someone else reviews it. Without them nothing could be changed
    // again, the fix included.
    const holders = (role) => {
        const out = new Set();
        for (const s of list(org.roles?.design?.[role])) {
            const [kind, sid] = String(s).split(":");
            if (kind === "user" && active(sid)) out.add(sid);
            if (kind === "group") for (const m of list((departments[sid] ?? groups[sid])?.members)) if (active(m)) out.add(m);
        }
        return out;
    };
    const designers = holders("designer");
    const reviewers = new Set([...designers, ...holders("reviewer")]);
    if (!designers.size) add("roles.design", "Someone active must remain a designer: only a designer starts a change, this one's undoing included.");
    else if (reviewers.size < 2) add("roles.design", `Someone besides ${[...designers].map((u) => users[u]?.name ?? u).join(", ")} must be able to review (a reviewer or another designer): an author never reviews their own change, so none could be reviewed.`);
    const objects = known.objects ?? {};
    for (const [object, roles] of Object.entries(isPlain(org.roles) ? org.roles : {})) {
        const declared = PSEUDO_ROLES[object] ?? objects[object]?.roles;
        // Roles already in place, and not changed here, are not this change's to answer for (an
        // object not published yet, say): only what the change changes is checked.
        if (known.liveRoles && same(known.liveRoles[object], roles)) continue;
        if (!declared) { add(`roles.${object}`, `Roles on "${object}": it is not an object.`); continue; }
        for (const [role, subjects] of Object.entries(isPlain(roles) ? roles : {})) {
            if (!declared.includes(role)) add(`roles.${object}`, `${object} has no role "${role}" (${declared.join(", ")}).`);
            for (const s of list(subjects)) {
                const [kind, sid] = String(s).split(":");
                const ok = kind === "user" ? active(sid) : kind === "group" ? Object.hasOwn(departments, sid) || Object.hasOwn(groups, sid) : false;
                if (!ok) add(`roles.${object}`, `${object} ${role}: "${s}" is not an active user:… or a group:… (a department or a group).`);
            }
        }
    }
    return problems;
}

// Who approves a change to the organization (§5.6): a department's changes, the department itself
// (as it approves now) and governance; people, governance and the departments they join or leave; a
// role on an object, that object's stewards; the standing approvers and governance, governance and
// the departments they add or drop.   context: { objects: { name: definition body } }
export function organizationFootprint(before, after, context = {}) {
    if (!after || same(before, after)) return [];
    // Only a department that exists now can approve: one this change creates is approved into being by
    // governance (as it is now), and approves from the next change on. Otherwise it would have to sign
    // its own creation, with nobody yet to sign for it.
    const exists = (d) => !before || Object.hasOwn(before.departments ?? {}, d);
    const gov = [before?.governance && exists(before.governance) ? before.governance : after.governance].filter(Boolean);
    const out = [];
    // `fromDraft`: departments named by the draft itself (a department's own, members', standing), which
    // may not exist yet; an object's stewards are the object's, and exist.
    const push = (element, a, b, stewards, fromDraft = true) => { if (!same(a, b)) out.push({ element, change: a === undefined ? "added" : b === undefined ? "removed" : "changed", stewards: [...new Set([...gov, ...(fromDraft ? stewards.filter(exists) : stewards)])].filter(Boolean).sort() }); };
    // Who is in which department, worked out once (asked per person, it is a pass over every member).
    const membership = (org) => { const m = new Map(); for (const [id, d] of Object.entries(org?.departments ?? {})) for (const u of list(d.members)) m.set(u, [...(m.get(u) ?? []), id]); return m; };
    const [was, now] = [membership(before), membership(after)];
    const depts = (org, u) => (org === before ? was : now).get(u) ?? [];
    for (const id of new Set([...Object.keys(before?.departments ?? {}), ...Object.keys(after.departments ?? {})])) push(`department:${id}`, before?.departments?.[id], after.departments?.[id], before?.departments?.[id] ? [id] : []);
    for (const id of new Set([...Object.keys(before?.users ?? {}), ...Object.keys(after.users ?? {})])) push(`person:${id}`, before?.users?.[id], after.users?.[id], [...depts(before, id), ...depts(after, id)]);
    for (const id of new Set([...Object.keys(before?.groups ?? {}), ...Object.keys(after.groups ?? {})])) push(`group:${id}`, before?.groups?.[id], after.groups?.[id], []);
    for (const o of new Set([...Object.keys(before?.roles ?? {}), ...Object.keys(after.roles ?? {})])) push(`roles:${o}`, before?.roles?.[o], after.roles?.[o], PSEUDO_ROLES[o] ? [] : list(context.objects?.[o]?.stewards?.object), false);
    const std = (org) => Object.values(org?.standing ?? {}).flat();
    push("standing", before?.standing ?? {}, after.standing ?? {}, [...std(before), ...std(after)].filter((d) => !std(before).includes(d) || !std(after).includes(d)));
    push("governance", before?.governance, after.governance, [before?.governance].filter(Boolean));
    // How the plant writes dates, times and numbers: governance approves it.
    push("formats", before?.formats ?? {}, after.formats ?? {}, []);
    push("theme", before?.theme ?? {}, after.theme ?? {}, []);
    // Who reads every record: governance approves it.
    push("readers", [...list(before?.readers)].sort(), [...list(after.readers)].sort(), []);
    return out;
}

// ---- retiring a design (§5.10): out of use, kept with its history ------------------------------
//
// A change may retire published elements: content.retire = { definitions: [objects], scripts,
// services, connections, transactions, screens }. Nothing still in use may be retired: whatever uses it
// is named, and is changed (or retired) first, or in the same change. An object is retired only
// when none of its records is in use (archived ones stay, read-only).
export const RETIRE_KINDS = ["definitions", "scripts", "services", "connections", "transactions", "screens"];
const NOUN = { definitions: "object", scripts: "script", services: "service", connections: "connection", transactions: "transaction", screens: "screen" };

//   world: { definitions, services, connections, transactions, screens: { name: body } } as they will
//          be (live and drafted), published: { kind: [names] }, recordsInUse: { object: n }
export function retireProblems(retire, world = {}, { published = {}, recordsInUse = {}, drafted = {} } = {}) {
    const problems = [];
    if (!isPlain(retire)) return problems;
    const add = (message) => problems.push({ path: "retire", message });
    const gone = (kind, name) => list(retire[kind]).includes(name);
    const each = (kind) => Object.entries(world[kind] ?? {}).filter(([n, b]) => b && !gone(kind, n));
    for (const kind of Object.keys(retire)) if (!RETIRE_KINDS.includes(kind)) add(`"${kind}" cannot be retired.`);
    for (const kind of RETIRE_KINDS) {
        for (const name of list(retire[kind])) {
            const noun = `${NOUN[kind]} ${name}`;
            if (!list(published[kind]).includes(name)) { add(`${noun} is not published, so there is nothing to retire.`); continue; }
            if (list(drafted[kind]).includes(name)) add(`${noun} is both changed and retired in this change: do one.`);
            const uses = [];
            if (kind === "definitions") {
                for (const why of keptBy(world.locks?.[name])) add(`${noun} cannot be retired: ${why}.`);
                if (recordsInUse[name]) add(`${noun}: ${recordsInUse[name]} record(s) are still in use: archive them first.`);
                for (const [o, d] of each("definitions")) for (const [f, x] of Object.entries(d.fields ?? {})) if (x?.type === "ref" && x.to === name) uses.push(`${o}.${f} refers to it`);
                for (const [t, b] of each("transactions")) if (Object.values(b.inputs ?? {}).some((i) => i?.to === name)) uses.push(`transaction ${t} works on it`);
                for (const [sc, b] of each("screens")) if (list(b.blocks).some((x) => x?.object === name) || Object.values(b.params ?? {}).some((p) => p?.to === name)) uses.push(`screen ${sc} shows it`);
                for (const [sv, b] of each("services")) if (b.uses?.objects?.[name] || list(b.on).some((t) => t?.object === name) || b.roles?.[name]) uses.push(`service ${sv} reaches it`);
            }
            if (kind === "scripts") {
                for (const [o, d] of each("definitions")) if (list(d.rules).some((r) => r?.script === name)) uses.push(`object ${o}'s rules run it`);
                if (world.services?.[name] && !gone("services", name)) uses.push(`it is service ${name}'s script: retire the service`);
            }
            if (kind === "connections") for (const [sv, b] of each("services")) if (list(b.uses?.connections).includes(name)) uses.push(`service ${sv} uses it`);
            if (kind === "transactions") {
                for (const [sc, b] of each("screens")) if (list(b.blocks).some((x) => (x?.block === "transaction" && x.name === name) || list(x?.rowActions).includes(name))) uses.push(`screen ${sc} offers it`);
                for (const [o, d] of each("definitions")) for (const p of list(d.policies)) if (list(p?.via).includes(name)) uses.push(`${o}'s policy ${p.id} applies through it`);
            }
            if (uses.length) add(`${noun} is still used: ${uses.join("; ")}. Change or retire those first (in this change, or before).`);
        }
    }
    return problems;
}

// Who approves retiring: the element's own stewards (and, through the route, the standing approvers).
export function retireFootprint(retire, live = {}) {
    const out = [];
    for (const kind of RETIRE_KINDS) {
        for (const name of list(retire?.[kind])) {
            const body = live[kind]?.[name];
            const stewards = kind === "definitions" ? list(body?.stewards?.object) : list(body?.stewards);
            out.push({ element: `${kind === "definitions" ? "object" : NOUN[kind]}:${name}`, change: "removed", stewards: [...new Set(stewards)].sort() });
        }
    }
    return out;
}

// Who holds which role, through what (§27): a person's own assignments and those of every department
// or group they belong to. → { user: { "object:role": ["directly" | "through <group>"] } }
export function effectiveRoles(org) {
    const out = {};
    const users = org?.users ?? {};
    for (const u of Object.keys(users)) if (users[u]?.active !== false) out[u] = {};
    // From each subject to whom it reaches (a person, or a group's members), not from each person to
    // every subject: with a plant's people, that is a pass over them, not one per person.
    const groups = { ...(org?.groups ?? {}), ...(org?.departments ?? {}) };
    const give = (s, key) => {
        if (s.startsWith("user:")) { const u = s.slice(5); if (out[u]) (out[u][key] ??= []).push("directly"); return; }
        if (!s.startsWith("group:")) return;
        const g = s.slice(6);
        for (const u of list(groups[g]?.members)) if (out[u]) (out[u][key] ??= []).push(`through ${g}`);
    };
    for (const [object, roles] of Object.entries(org?.roles ?? {})) for (const [role, subjects] of Object.entries(roles ?? {})) for (const s of list(subjects)) give(s, `${object}:${role}`);
    for (const s of list(org?.readers)) give(s, "all records:read");
    return out;
}
// What a change to the organization does to each person's roles: [{ user, name, gained: [{ role, via }],
// lost: [{ role, via }] }] (a role still held some other way is neither).
export function roleChanges(before, after) {
    const a = effectiveRoles(before);
    const b = effectiveRoles(after);
    const out = [];
    for (const u of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const was = a[u] ?? {};
        const now = b[u] ?? {};
        const lost = Object.keys(was).filter((r) => !now[r]).map((role) => ({ role, via: was[role].join(", ") }));
        const gained = Object.keys(now).filter((r) => !was[r]).map((role) => ({ role, via: now[role].join(", ") }));
        if (lost.length || gained.length) out.push({ user: u, name: after?.users?.[u]?.name ?? before?.users?.[u]?.name ?? u, gained, lost });
    }
    return out.sort((x, y) => x.name.localeCompare(y.name));
}

// ---- flow templates (§32): routes and out-of-control action plans ----
//
// The Flow designer draws a flow template (content.flows): its nodes, wired to one another. A run of it
// (a lot's way along a route, a plan set off once) carries its context, which its decisions read.
//
//   { name, label, description, kind: "route" | "plan",
//     participants: { key: { object, as: "traveler" | "resource" | "subject" | "reference", from?: "<key>.<ref field>" } },
//     context?: { name: initial value }               the run's own values, besides its records
//     ends?: { when: expression }                     a route's run ends once this holds after a step (merged, scrapped)
//     nodes: { id: { kind, label, onEnter?: script, onExit?: script, … } }:
//       start            { when?: expression }        where a run begins (a route: a traveler made where `when` holds)
//       sequence         { offers: [transactions], leaves: [transactions], resource?: { field: [values] },
//                          settings?: { key: value } (read by its transactions as { node: "key" }), state?, screen? }
//                        a route's step: entering it marks the traveler's step field (and its state, if
//                        given); it leaves on one of `leaves`, or on any write that moves the step field
//       auto_decision    {}                           its wires' conditions, tried in order; the last may have none
//       manual_decision  { message?, for: { users, groups } }    a person picks one of its wires (their labels)
//       wait             { message, seconds, mode: auto | acknowledge | retry, for? }   auto goes on when the time
//                        is up; acknowledge waits for someone; retry also offers a way back (its `retry` wire)
//       input_screen     { message?, for, fields: [{ name, label, type, values?, required? }] }   into the context, in that order
//       sub_flow         { flow, pass?: { name: expression }, returns?: { name: "<its context name>" } }
//       end              { outcome? }
//       <suite>.<kind>   a suite's own (`flowNodes`), behaving as the core kind it extends, its settings its own
//     edges: [{ from, to, when?: expression (from an auto decision), label?: words (a manual decision's
//              choice), retry?: true (a wait's way back) }],
//     layout?: { id: { x, y } }, roles?: { object: [roles] } (what the template's own identity may do: mark a
//     step and a state, its scripts' writes), stewards: [departments] }
// Conditions read the context: { context: "lot.state" }, { context: "product.yield_limit" }, { context: "retries" }.
// A node's scripts are rule scripts (§12): ctx { event: { kind: "enter" | "exit", node, flow }, context, writes: [] }
// in, the same out; what they put in `writes` ({ record: <participant>, action } or { record, set: { field: value } })
// is written after, as the template, through the record services.
export const FLOW_ROLES = ["traveler", "resource", "subject", "reference"];
export const FLOW_NODE_KINDS = ["start", "sequence", "auto_decision", "manual_decision", "wait", "input_screen", "sub_flow", "ask", "fill", "run", "end"];
// What a template of each kind draws (its palette).
// An input flow (§32.13, input-flow.js): how a transaction or a screen is filled from the keyboard.
export const FLOW_KINDS_OF = { route: ["start", "sequence", "auto_decision", "sub_flow", "end"], plan: ["start", "wait", "auto_decision", "manual_decision", "input_screen", "sub_flow", "end"], input: INPUT_FLOW_NODES };
export const FLOW_KIND_WORDS = { route: "route", plan: "plan", input: "input flow" };
export const FLOW_NODE_WORDS = { start: "Start", sequence: "Sequence", auto_decision: "Auto decision", manual_decision: "Manual decision", wait: "Wait", input_screen: "Input screen", sub_flow: "Sub flow", ask: "Ask", fill: "Fill", run: "Run", end: "End" };
// The kinds a suite's node kind may extend (the start is the core's own).
export const FLOW_EXTENDABLE = FLOW_NODE_KINDS.filter((k) => k !== "start");
export const WAIT_MODES = ["auto", "acknowledge", "retry"];
export const INPUT_TYPES = ["string", "integer", "decimal", "boolean", "enum", "file", "image", "link"];
// asSub (a route, §32.14): it runs only inside another route, as its sub flow; it takes up no traveler by itself.
export const FLOW_KEYS = ["label", "description", "kind", "participants", "context", "ends", "nodes", "edges", "layout", "roles", "scenarios", "stewards", "asSub"];
export const FLOW_TEMPLATE = (name, label, stewards) => ({
    name, label: label?.trim() || name.replace(/_/g, " "), description: "", kind: "route", participants: {}, context: {},
    nodes: { start: { kind: "start", label: "Start" }, first: { kind: "sequence", label: "First step", offers: [], leaves: [] }, done: { kind: "end", label: "Done" } },
    edges: [{ from: "start", to: "first" }, { from: "first", to: "done" }],
    layout: { start: { x: 40, y: 60 }, first: { x: 240, y: 60 }, done: { x: 440, y: 60 } }, roles: {}, stewards,
});

// A new design started as a copy of another of its kind (an object, a service, a connection, a
// transaction, a screen, a flow template): all of it, under its new name and label; its scenarios
// that ran the original (a transaction's steps, a plan they answer) run the copy. Plain data in,
// plain data out, so the designer and the server agree. Scripts are copied with copyScript.
export const COPYABLE = ["object", "service", "connection", "transaction", "screen", "flow", "layout"];
export function copyDesign(kind, body, { name, label } = {}) {
    const copy = JSON.parse(JSON.stringify(body ?? {}));
    const from = kind === "object" ? copy.object : copy.name;
    if (kind === "object") copy.object = name; else copy.name = name;
    copy.label = label?.trim() || `${copy.label ?? from} (copy)`;
    for (const sc of Array.isArray(copy.scenarios) ? copy.scenarios : []) {
        for (const st of Array.isArray(sc?.steps) ? sc.steps : []) {
            if (kind === "transaction" && st?.do?.transaction === from) st.do.transaction = name;
            if (kind === "flow" && st?.do?.act?.plan === from) st.do.act.plan = name;
        }
    }
    return copy;
}
// A script copied for a copy (a service's own, an object's rule): its function named after the copy.
export const copyScript = (source, from, name) => String(source ?? "").replace(new RegExp(`(export\\s+default\\s+(?:async\\s+)?function\\s+)${from}\\b`), `$1${name}`);
// The name a copied object's rule script takes: the original's with the object's name swapped, or the
// copy's name before it.
export const copiedScriptName = (script, from, name) => (script.includes(from) ? script.split(from).join(name) : `${name}_${script}`);

// The core kind a node behaves as: its own, or the one a suite's kind extends.
export const flowKindOf = (node, flowNodes = {}) => (FLOW_NODE_KINDS.includes(node?.kind) ? node.kind : FLOW_NODE_KINDS.includes(flowNodes[node?.kind]?.extends) ? flowNodes[node.kind].extends : null);
// Where a run begins: its start node.
// Whether it sets off on its own (a route; a plan whose start has a condition or a due date): such a
// template carries scenarios, its evidence (§32.8). A plan with neither runs only as another's sub
// flow, tried through it.
export const flowSetsOff = (body) => {
    if (body?.kind === "route") return body.asSub !== true;
    const start = body?.kind === "plan" ? body.nodes?.[Object.entries(isPlain(body.nodes) ? body.nodes : {}).find(([, n]) => n?.kind === "start")?.[0]] : null;
    return Boolean(start && (start.when !== undefined || start.due !== undefined));
};
export const flowStartOf = (body) => Object.entries(isPlain(body?.nodes) ? body.nodes : {}).find(([, n]) => n?.kind === "start")?.[0] ?? null;
// The names a run's context holds besides its records: its initial values, what its input screens
// collect, what its sub flows return.
export function flowContextNames(body) {
    const nodes = Object.values(isPlain(body?.nodes) ? body.nodes : {});
    return [...new Set([
        // A plan's: the route its records are on, where it was set off ({ flow, label, step, step_label }).
        ...(body?.kind === "plan" ? ["route"] : []),
        ...Object.keys(isPlain(body?.context) ? body.context : {}),
        ...nodes.filter((n) => n?.kind === "input_screen").flatMap((n) => list(n.fields).map((f) => f?.name).filter((x) => typeof x === "string")),
        ...nodes.filter((n) => n?.kind === "sub_flow").flatMap((n) => Object.keys(isPlain(n.returns) ? n.returns : {})),
    ])];
}

// What is wrong with a condition of a template: it reads the context only, its records' fields (or their
// state) and its values.
function flowExprProblems(expr, participants, objects, names) {
    try {
        const out = [];
        for (const ref of referencesOf(expr)) {
            if (ref.scope !== "context") { out.push(`it reads ${ref.scope}, but a flow's condition reads its context: {"context": "lot.state"}.`); continue; }
            const [key, field] = String(ref.path).split(".");
            const p = participants[key];
            if (!p && !names.includes(key)) out.push(`it reads ${ref.path}, but "${key}" is neither a record of the flow nor a value of its context.`);
            else if (p && field && !["state", "id", "type"].includes(field) && !Object.hasOwn(objects[p.object]?.fields ?? {}, field)) out.push(`it reads ${ref.path}, but ${p.object} has no field "${field}".`);
        }
        return out;
    } catch (error) {
        return [error.message];
    }
}
const PLAIN_VALUE = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);

// Problems with a template, each naming the node or wire concerned (their path). `known`: objects (with
// their `flow` opt-in, fields, states, transitions, roles), transactions ({ inputs, appearsOn }), screens,
// scripts, flows (the other templates' names), users, groups, departments, and flowNodes (the installed
// suites' node kinds).
export function validateFlow(body, known = {}) {
    const problems = [];
    const add = (path, message) => problems.push({ path, message });
    if (!isPlain(body)) return [{ path: "", message: "A flow template is an object." }];
    if (!IDENTIFIER.test(body.name ?? "")) add("name", "A flow template's name is lower case letters, digits and _.");
    if (!(typeof body.label === "string" && body.label.trim())) add("label", "Give the flow template a label.");
    if (!["route", "plan", "input"].includes(body.kind)) add("kind", 'A flow template is a route (a traveler goes through it), a plan (an OCAP: an event sets it off) or an input flow (how a transaction or a screen is filled from the keyboard): kind "route", "plan" or "input".');
    // An input flow names no records and keeps no context: it walks a form's inputs.
    if (body.kind === "input" && Object.keys(isPlain(body.participants) ? body.participants : {}).length) add("participants", "An input flow takes no records part: it asks for a form's inputs.");
    if (body.kind === "input" && Object.keys(isPlain(body.context) ? body.context : {}).length) add("context", "An input flow keeps no context: its conditions read the form's inputs.");
    for (const k of Object.keys(body)) if (k !== "name" && !FLOW_KEYS.includes(k)) add(k, `"${k}" is not part of a flow template.`);
    const objects = known.objects ?? {};
    const transactions = known.transactions ?? {};
    const flowNodes = known.flowNodes ?? {};
    const palette = FLOW_KINDS_OF[body.kind] ?? FLOW_NODE_KINDS;

    // Its records: objects that opted in, as what they opted in to.
    const participants = isPlain(body.participants) ? body.participants : {};
    for (const [key, p] of Object.entries(participants)) {
        const at = `participants.${key}`;
        if (!IDENTIFIER.test(key)) add(at, `"${key}": a record's name in the flow is lower case letters, digits and _.`);
        if (!isPlain(p) || !Object.hasOwn(objects, p.object)) { add(at, `${key}: "${p?.object ?? ""}" is not an object.`); continue; }
        if (!FLOW_ROLES.includes(p.as)) { add(at, `${key}: it takes part as one of ${FLOW_ROLES.join(", ")}.`); continue; }
        if (!list(objects[p.object].flow?.as).includes(p.as)) add(at, `${key}: ${p.object} does not take part in flows as a ${p.as}: its design says so first (Flows, on the object's General tab).`);
        if (p.from !== undefined) {
            const [source, field, ...rest] = String(p.from).split(".");
            const src = participants[source];
            const target = src ? objects[src.object]?.fields?.[field] : null;
            if (!src || rest.length || !target || target.type !== "ref" || target.to !== p.object) add(at, `${key}: from is "<a record of the flow>.<its reference to ${p.object}>", e.g. "lot.product".`);
        }
    }
    const byRole = (role) => Object.entries(participants).filter(([, p]) => p?.as === role).map(([k]) => k);
    if (body.kind === "route" && byRole("traveler").length !== 1) add("participants", "A route has one traveler: the record that goes through it (a lot).");
    if (body.asSub !== undefined && (body.kind !== "route" || typeof body.asSub !== "boolean")) add("asSub", "asSub is true or false, on a route: it runs only inside another route.");
    if (body.kind === "route" && byRole("resource").length > 1) add("participants", "A route has at most one kind of resource (where the work is done).");
    if (body.kind === "plan" && byRole("subject").length !== 1) add("participants", "A plan has one subject: the record whose event sets it off.");
    const traveler = participants[byRole("traveler")[0]];
    const resource = participants[byRole("resource")[0]];
    const stepField = traveler ? objects[traveler.object]?.flow?.step : null;
    const stepSpec = stepField ? objects[traveler.object]?.fields?.[stepField] : null;

    // Its context: plain values, named apart from its records.
    if (body.context !== undefined && !isPlain(body.context)) add("context", "context is { name: an initial value }.");
    for (const [k, v] of Object.entries(isPlain(body.context) ? body.context : {})) {
        if (!IDENTIFIER.test(k)) add("context", `"${k}": a context value's name is lower case letters, digits and _.`);
        else if (participants[k]) add("context", `"${k}" is a record of the flow already: name the value otherwise.`);
        if (!PLAIN_VALUE(v)) add("context", `${k}: its initial value is a text, a number, true or false.`);
    }
    const names = flowContextNames(body);
    const exprProblems = body.kind === "input" ? inputFlowExprProblems : (e) => flowExprProblems(e, participants, objects, names);
    const script = (at, name, which, v) => {
        if (v === undefined) return;
        if (typeof v !== "string" || !IDENTIFIER.test(v)) add(at, `${name}: ${which} names a script.`);
        else if (known.scripts && !list(known.scripts).includes(v)) add(at, `${name}: ${which} "${v}" is not a script.`);
    };
    const people = (at, name, n, what) => { if (!list(n.for?.users).length && !list(n.for?.groups).length) add(at, `${name}: say who ${what} (users or groups).`); };

    // Its nodes.
    const nodes = isPlain(body.nodes) ? body.nodes : {};
    const ids = Object.keys(nodes);
    if (!ids.length) add("nodes", "A flow template has nodes: its start, and where it ends.");
    if (ids.length > 200) add("nodes", "A flow template has at most 200 nodes.");
    const starts = ids.filter((id) => nodes[id]?.kind === "start");
    if (ids.length && starts.length !== 1) add("nodes", starts.length ? "A flow template has one start." : "A flow template begins at a start node: add one.");
    for (const [id, n] of Object.entries(nodes)) {
        const at = `nodes.${id}`;
        const name = `${n?.label ?? id}`;
        if (!IDENTIFIER.test(id)) add(at, `"${id}": a node's name is lower case letters, digits and _.`);
        if (!isPlain(n)) { add(at, `${id}: a node is { kind, label, … }.`); continue; }
        if (!(typeof n.label === "string" && n.label.trim())) add(at, `${id}: give the node a label.`);
        const kind = flowKindOf(n, flowNodes);
        if (!kind) {
            const suite = String(n.kind ?? "").includes(".") ? String(n.kind).split(".")[0] : null;
            add(at, suite ? `${name}: a "${n.kind}" node needs the ${suite} suite, which is not installed here.` : `${name}: a node is one of ${FLOW_NODE_KINDS.join(", ")}${Object.keys(flowNodes).length ? `, or ${Object.keys(flowNodes).join(", ")}` : ""}.`);
            continue;
        }
        const an = (w) => `${/^[aeiou]/i.test(w) ? "an" : "a"} ${w}`;
        if (!palette.includes(kind)) add(at, `${name}: ${an(FLOW_NODE_WORDS[kind].toLowerCase())} belongs to ${Object.entries(FLOW_KINDS_OF).filter(([, ks]) => ks.includes(kind)).map(([k]) => an(FLOW_KIND_WORDS[k])).join(" or ")}, not ${an(FLOW_KIND_WORDS[body.kind] ?? body.kind)}.`);
        if (body.kind === "input") inputFlowNodeProblems(id, n, add);
        script(at, name, "onEnter", n.onEnter);
        script(at, name, "onExit", n.onExit);
        // A suite's kind: its settings, by the shape it declares.
        const spec = flowNodes[n.kind];
        if (spec) for (const [k, type] of Object.entries(spec.config ?? {})) {
            const v = n.settings?.[k];
            if (v === undefined || v === null || v === "") { if (spec.required?.includes(k)) add(at, `${name}: its ${k} is required.`); continue; }
            const ok = { string: typeof v === "string", integer: Number.isInteger(v), decimal: typeof v === "number" && Number.isFinite(v), boolean: typeof v === "boolean" }[type] ?? true;
            if (!ok) add(at, `${name}: its ${k} is a ${type}.`);
        }
        if (kind === "start" && n.when !== undefined) for (const m of exprProblems(n.when)) add(at, `${name}, starts when: ${m}`);
        // A plan's start (§32.5a): set off again once its last run for the record has ended, and on a date
        // of its subject's (a due date: when it arrives, the scheduler sets it off with no write).
        if (kind === "start" && n.again !== undefined && (n.again !== true || body.kind !== "plan")) add(at, `${name}: again: true lets a plan set off again for a record once its last run there has ended; a route's start has no such setting.`);
        if (kind === "start" && n.due !== undefined) {
            const subject = participants[byRole("subject")[0]];
            const spec = subject ? objects[subject.object]?.fields?.[n.due] : null;
            if (body.kind !== "plan") add(at, `${name}: due is a plan's: a route starts when a traveler is made.`);
            else if (typeof n.due !== "string" || !subject || spec?.type !== "date") add(at, `${name}: due names a date field of the subject${subject ? ` (${subject.object}: ${Object.entries(objects[subject.object]?.fields ?? {}).filter(([, f]) => f?.type === "date").map(([k]) => k).join(", ") || "it has none"})` : ""}.`);
        }
        if (kind === "sequence") {
            const offers = list(n.offers);
            for (const t of offers) {
                if (!transactions[t]) add(at, `${name}: "${t}" is not a transaction.`);
                else if (traveler && transactions[t].appearsOn?.object !== traveler.object) add(at, `${name}: ${t} does not appear on ${traveler.object} records (its appearsOn), so a traveler cannot be offered it.`);
            }
            for (const t of list(n.leaves)) if (!offers.includes(t)) add(at, `${name}: it leaves on ${t}, which it does not offer.`);
            if (n.resource !== undefined) {
                if (!resource) add(at, `${name}: it names a resource, but the flow has none (a participant as a resource).`);
                else if (!isPlain(n.resource)) add(at, `${name}: resource is { field: [values] }.`);
                else for (const [f, v] of Object.entries(n.resource)) {
                    if (f !== "state" && !Object.hasOwn(objects[resource.object]?.fields ?? {}, f)) add(at, `${name}: ${resource.object} has no field "${f}".`);
                    if (!list(v).length && !["string", "number", "boolean"].includes(typeof v)) add(at, `${name}: resource ${f} is a value or a list of values.`);
                }
            }
            if (n.settings !== undefined && (!isPlain(n.settings) || !Object.entries(n.settings).every(([k, v]) => IDENTIFIER.test(k) && ["string", "number", "boolean"].includes(typeof v)))) add(at, `${name}: settings are { name: a plain value }.`);
            if (n.screen !== undefined && known.screens && !known.screens.includes(n.screen)) add(at, `${name}: "${n.screen}" is not a screen.`);
            if (n.state !== undefined && traveler && !list(objects[traveler.object]?.states).includes(n.state)) add(at, `${name}: ${traveler.object} has no state "${n.state}".`);
            if (traveler && !stepField) add(at, `${name}: a sequence marks the traveler's step, and ${traveler.object} names no step field (Flows, on its General tab).`);
            // Entering it marks the traveler's step field with its name: a choice field must offer it.
            if (stepSpec?.type === "enum" && !list(stepSpec.values).includes(id)) add(at, `${name}: ${traveler.object}.${stepField} holds the traveler's step, and "${id}" is not one of its values: name the node after one, or add it to the field.`);
        }
        if (kind === "manual_decision") people(at, name, n, "decides");
        if (kind === "wait") {
            if (typeof n.message !== "string" || !n.message.trim()) add(at, `${name}: say what it shows while it waits (message).`);
            if (!Number.isInteger(n.seconds) || n.seconds < 1) add(at, `${name}: how long it waits, in whole seconds (seconds).`);
            if (!WAIT_MODES.includes(n.mode)) add(at, `${name}: when the time is up it goes on by itself (auto), waits for someone (acknowledge), or also offers a way back (retry).`);
            if (n.mode === "acknowledge" || n.mode === "retry") people(at, name, n, "acknowledges it");
        }
        if (kind === "input_screen") {
            people(at, name, n, "fills it in");
            // A list, in the order the screen shows them (an object's keys would be stored sorted).
            if (n.fields !== undefined && !Array.isArray(n.fields)) add(at, `${name}: fields is a list: [{ name, label, type }].`);
            const fields = list(n.fields);
            if (!fields.length) add(at, `${name}: list what it collects (fields).`);
            const seen = new Set();
            for (const spec of fields) {
                const f = spec?.name;
                if (!IDENTIFIER.test(f ?? "")) add(at, `${name}: "${f ?? ""}": a field's name is lower case letters, digits and _.`);
                else if (participants[f]) add(at, `${name}: "${f}" is a record of the flow already: name the field otherwise.`);
                else if (seen.has(f)) add(at, `${name}: two fields are named "${f}".`);
                seen.add(f);
                if (!isPlain(spec) || !INPUT_TYPES.includes(spec.type)) add(at, `${name}: ${f} is one of ${INPUT_TYPES.join(", ")}.`);
                else if (spec.type === "enum" && !(list(spec.values).length && list(spec.values).every((v) => typeof v === "string" && v))) add(at, `${name}: ${f}: list the values it may take.`);
            }
        }
        if (kind === "sub_flow") {
            if (typeof n.flow !== "string" || !n.flow) add(at, `${name}: name the flow template it runs (flow).`);
            else if (n.flow === body.name) add(at, `${name}: a template does not run itself.`);
            else if (known.flows && !list(known.flows).includes(n.flow)) add(at, `${name}: "${n.flow}" is not a flow template.`);
            // A plan runs plans, a route runs routes (§32.14), about the same kind of record.
            else if (isPlain(known.flowInfo?.[n.flow]) && known.flowInfo[n.flow].kind !== body.kind) add(at, `${name}: ${n.flow} is ${known.flowInfo[n.flow].kind === "route" ? "a route" : known.flowInfo[n.flow].kind === "plan" ? "a plan" : "an input flow"}: a ${body.kind} runs another ${body.kind}.`);
            else if (isPlain(known.flowInfo?.[n.flow]) && body.kind === "route" && known.flowInfo[n.flow].object !== participants[byRole("traveler")[0]]?.object) add(at, `${name}: ${n.flow} is a route for ${known.flowInfo[n.flow].object ?? "nothing"} records, and this one for ${participants[byRole("traveler")[0]]?.object ?? "none"}: a sub route takes the same traveler through.`);
            else if (isPlain(known.subFlows)) {
                // Nor through others: a sub flow whose own sub flows lead back here would run without end.
                const path = subFlowPath(n.flow, body.name, { ...known.subFlows, [body.name]: subFlowsOf(body) });
                if (path) add(at, `${name}: ${[body.name, ...path].join(" → ")} runs ${body.name} again, without end: break the circle.`);
            }
            for (const [k, e] of Object.entries(isPlain(n.pass) ? n.pass : {})) for (const m of exprProblems(e)) add(at, `${name}, passes ${k}: ${m}`);
            for (const [k, v] of Object.entries(isPlain(n.returns) ? n.returns : {})) if (!IDENTIFIER.test(k) || typeof v !== "string" || !v) add(at, `${name}: returns is { name here: "its name in the sub flow's context" }.`);
        }
    }

    // Its end condition.
    if (body.ends !== undefined) {
        if (!isPlain(body.ends) || body.ends.when === undefined) add("ends", "ends is { when: expression }.");
        else for (const m of exprProblems(body.ends.when)) add("ends", `Ends when: ${m}`);
    }

    // Its wires, and what they leave out.
    const edges = list(body.edges);
    const out = {};
    edges.forEach((e, i) => {
        const at = `edges.${i}`;
        if (!isPlain(e) || !nodes[e.from] || !nodes[e.to]) { add(at, `Wire ${i + 1}: from and to are nodes of the template.`); return; }
        (out[e.from] ??= []).push(e);
        const fromKind = flowKindOf(nodes[e.from], flowNodes);
        const where = `Wire ${i + 1} (${nodes[e.from].label ?? e.from} → ${nodes[e.to].label ?? e.to})`;
        if (fromKind === "end") add(at, `${where}: nothing leaves an end.`);
        if (nodes[e.to]?.kind === "start") add(at, `${where}: nothing leads back to the start.`);
        if (e.when !== undefined) {
            if (fromKind !== "auto_decision") add(at, `${where}: only an auto decision's wires have conditions; put one between.`);
            for (const m of exprProblems(e.when)) add(at, `${where}: ${m}`);
        }
        if (e.label !== undefined && (typeof e.label !== "string" || !e.label.trim())) add(at, `${where}: its label is words.`);
        if (e.retry !== undefined && (e.retry !== true || fromKind !== "wait" || nodes[e.from].mode !== "retry")) add(at, `${where}: only a wait that offers a retry has a way back (retry: true).`);
    });
    for (const [id, n] of Object.entries(nodes)) {
        const kind = flowKindOf(n, flowNodes);
        if (!kind || kind === "end") continue;
        const at = `nodes.${id}`;
        const name = n.label ?? id;
        const wires = list(out[id]);
        const onward = wires.filter((e) => !e.retry);
        if (!onward.length) { add(at, `${name}: nothing leaves it: wire where it goes next.`); continue; }
        if (kind === "auto_decision") {
            onward.forEach((e, k) => { if (e.when === undefined && k < onward.length - 1) add(at, `${name}: a wire with no condition is taken always, so the ones after it never are: make it the last (otherwise).`); });
        } else if (kind === "manual_decision") {
            for (const e of onward) if (!(typeof e.label === "string" && e.label.trim())) add(at, `${name}: give each of its wires a label: the choice the person sees.`);
            const labels = onward.map((e) => e.label);
            if (new Set(labels).size !== labels.length) add(at, `${name}: two of its choices read the same.`);
        } else if (onward.length > 1) add(at, `${name}: it goes on by one wire; branch with a decision after it.`);
        if (kind === "wait" && n.mode === "retry" && wires.filter((e) => e.retry).length !== 1) add(at, `${name}: wire its way back once (a wire marked retry).`);
    }
    if (starts.length === 1) {
        const seen = new Set(starts);
        const queue = [...starts];
        while (queue.length) for (const e of list(out[queue.shift()])) if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
        for (const id of ids) if (!seen.has(id)) add(`nodes.${id}`, `${nodes[id]?.label ?? id}: no way leads to it from the start.`);
    }

    // What its own identity may do (mark a step and a state, its scripts' writes): roles the objects declare.
    for (const [o, roles] of Object.entries(isPlain(body.roles) ? body.roles : {})) {
        if (!objects[o]) add("roles", `roles: "${o}" is not an object.`);
        else for (const r of list(roles)) if (!list(objects[o].roles).includes(r)) add("roles", `roles: ${o} has no role "${r}".`);
    }
    if (body.layout !== undefined && !(isPlain(body.layout) && Object.values(body.layout).every((p) => isPlain(p) && Number.isFinite(p.x) && Number.isFinite(p.y)))) add("layout", "layout is { node: { x, y } }.");
    // Its evidence (§32.8): scenarios, each walking a record through it and expecting the node reached.
    for (const m of scenarioProblems(body, known, "flow")) add("scenarios", m);
    if (!list(body.stewards).length) add("stewards", "Name the departments that steward this flow template.");
    else if (known.departments) for (const d of list(body.stewards)) if (!known.departments.includes(d)) add("stewards", `"${d}" is not a department.`);
    return problems;
}

// Who approves a template: its stewards, the stewards of the transactions it offers (they answer for
// what is done at its steps), and of the objects its own identity may write (a step, a state, its
// scripts' writes).
export function flowFootprint(name, before, after, context = {}) {
    if (same(before, after)) return [];
    const reach = (body) => {
        if (!body) return [];
        return [
            ...Object.values(isPlain(body.nodes) ? body.nodes : {}).flatMap((n) => list(n?.offers).flatMap((t) => list(context.transactions?.[t]?.stewards))),
            ...Object.keys(isPlain(body.roles) ? body.roles : {}).flatMap((o) => list(context.objects?.[o]?.stewards?.object)),
        ];
    };
    const answer = (change, extra = []) => [...new Set([...(change !== "added" ? list(before?.stewards) : []), ...(change !== "removed" ? list(after?.stewards) : []), ...extra])].filter(Boolean).sort();
    const element = `flow:${name}`;
    if (!before) return [{ element, change: "added", stewards: answer("added", reach(after)) }];
    if (!after) return [{ element, change: "removed", stewards: answer("removed", reach(before)) }];
    return FLOW_KEYS.filter((k) => !same(before[k], after[k])).map((k) => ({ element: `${element}.${k}`, change: "changed", stewards: answer("changed", ["nodes", "roles"].includes(k) ? [...reach(before), ...reach(after)] : []) }));
}

// Tidy (and the AI's layout_flow): left to right by distance from the start, a node's branches below
// one another.
export function tidyLayout(body) {
    const nodes = Object.keys(body.nodes ?? {});
    const depth = {};
    const start = flowStartOf(body) ?? nodes[0];
    if (start) { depth[start] = 0; const queue = [start]; while (queue.length) { const at = queue.shift(); for (const e of body.edges ?? []) if (e.from === at && !e.retry && depth[e.to] === undefined) { depth[e.to] = depth[at] + 1; queue.push(e.to); } } }
    let far = Math.max(0, ...Object.values(depth));
    for (const id of nodes) if (depth[id] === undefined) depth[id] = ++far;
    const rows = {};
    const layout = {};
    for (const id of nodes) { const d = depth[id]; rows[d] = (rows[d] ?? 0) + 1; layout[id] = { x: 40 + d * 240, y: 40 + (rows[d] - 1) * 110 }; }
    return layout;
}

// The templates a template runs as sub flows (§32.5a), by name.
export const subFlowsOf = (body) => [...new Set(Object.values(isPlain(body?.nodes) ? body.nodes : {}).filter((n) => n?.kind === "sub_flow" && typeof n.flow === "string" && n.flow).map((n) => n.flow))];
// The way from template `from` to template `to` through sub flows, as names ([from, …, to]), or null.
// `graph`: { name: [the names it runs] }, the published templates' and the change's.
export function subFlowPath(from, to, graph) {
    const seen = new Set();
    const walk = (at, path) => {
        if (at === to) return path;
        if (seen.has(at)) return null;
        seen.add(at);
        for (const next of list(graph?.[at])) { const found = walk(next, [...path, next]); if (found) return found; }
        return null;
    };
    return walk(from, [from]);
}

// A template as a run's page draws it (§32.7): its nodes (each by the core kind it behaves as, a suite's
// kind by its own label), its wires (a condition only as being there) and where each node sits. What it
// leaves out (scripts, settings, conditions, roles) stays with the design, for those who may read it.
export function flowMapOf(body, flowNodes = {}) {
    const nodes = isPlain(body?.nodes) ? body.nodes : {};
    return {
        kind: body?.kind ?? "route", label: body?.label ?? "",
        nodes: Object.fromEntries(Object.entries(nodes).map(([id, n]) => [id, {
            kind: flowKindOf(n, flowNodes) ?? "missing", label: String(n?.label ?? id),
            words: flowNodes[n?.kind]?.label ?? FLOW_NODE_WORDS[n?.kind] ?? String(n?.kind ?? ""), hooks: Boolean(n?.onEnter || n?.onExit),
        }])),
        edges: list(body?.edges).filter((e) => isPlain(e) && nodes[e.from] && nodes[e.to]).map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: String(e.label) } : {}), ...(e.retry ? { retry: true } : {}), ...(e.when !== undefined ? { cond: true } : {}) })),
        layout: isPlain(body?.layout) ? body.layout : {},
    };
}

// A run's way over its template (§32.7): how often it entered each node, how often it took each wire
// (by its index), and the moves no wire leads by (a route's step set by hand, off route).
export function flowWalk(body, steps) {
    const edges = list(body?.edges);
    const visits = {};
    const taken = {};
    const off = [];
    const way = list(steps).map((s) => s?.node).filter((n) => typeof n === "string");
    way.forEach((node, i) => {
        visits[node] = (visits[node] ?? 0) + 1;
        if (!i) return;
        const from = way[i - 1];
        const at = edges.findIndex((e) => e?.from === from && e?.to === node);
        if (at < 0) off.push({ from, to: node });
        else taken[at] = (taken[at] ?? 0) + 1;
    });
    return { visits, taken, off };
}

// A template walked in plain words (§32.10): for the designer and the reviewers, and the AI's explain_flow.
// `labels`: transactions' and objects' labels by name, where known.
export function explainFlow(body, labels = {}) {
    if (!isPlain(body)) return "";
    const nodes = isPlain(body.nodes) ? body.nodes : {};
    const label = (id) => nodes[id]?.label ?? id;
    // A condition in words: "lot.scrap_qty > 5", "lot.state is merged or scrapped".
    const SYM = { eq: "is", ne: "is not", lt: "<", le: "≤", gt: ">", ge: "≥" };
    const words = (e) => {
        if (e === undefined) return "";
        if (!isPlain(e)) return Array.isArray(e) ? e.map(words).join(" or ") : JSON.stringify(e);
        const [op, a] = Object.entries(e)[0] ?? [];
        if (["context", "lookup", "input", "record", "node", "row", "param", "user"].includes(op)) return String(a);
        if (SYM[op] && Array.isArray(a)) return `${words(a[0])} ${SYM[op]} ${words(a[1])}`;
        if (op === "in" && Array.isArray(a)) return `${words(a[0])} is ${list(a[1]).map((x) => JSON.stringify(x)).join(" or ")}`;
        if (op === "all" || op === "any") return list(a).map(words).join(op === "all" ? " and " : " or ");
        if (op === "not") return `not (${words(a)})`;
        return JSON.stringify(e);
    };
    const tx = (t) => labels.transactions?.[t] ?? t;
    const lines = [];
    const parts = Object.entries(isPlain(body.participants) ? body.participants : {}).map(([k, p]) => `${k} (${labels.objects?.[p?.object] ?? p?.object}, ${p?.as}${p?.from ? `, from ${p.from}` : ""})`);
    lines.push(`${body.label ?? body.name} is ${body.kind === "plan" ? "a plan (OCAP), set off by an event" : body.kind === "input" ? "an input flow: how a transaction or a screen is filled from the keyboard" : "a route"}${parts.length ? ` over ${parts.join(", ")}` : ""}.`);
    const values = Object.entries(isPlain(body.context) ? body.context : {});
    if (values.length) lines.push(`Its context starts with ${values.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")}.`);
    const seen = new Set();
    const order = [];
    const walk = (id) => { if (!id || seen.has(id) || !nodes[id]) return; seen.add(id); order.push(id); for (const e of list(body.edges).filter((x) => x?.from === id)) walk(e.to); };
    walk(flowStartOf(body));
    for (const id of Object.keys(nodes)) walk(id);
    for (const id of order) {
        const n = nodes[id];
        const next = list(body.edges).filter((e) => e?.from === id).map((e) => `${label(e.to)}${e.retry ? " (retry)" : e.label ? ` on "${e.label}"` : e.when !== undefined ? ` if ${words(e.when)}` : ""}`);
        const kind = n?.kind;
        let what = `${label(id)}`;
        if (kind === "start") what += `: the start${n.when !== undefined ? `, for runs where ${words(n.when)}` : ""}${n.due ? `, set off when the subject's ${n.due} arrives` : ""}${n.again ? ", again once the last run has ended" : ""}`;
        else if (kind === "sequence" || Array.isArray(n?.offers)) what += `: a step${n.state ? ` (marked ${n.state})` : ""}; ${list(n?.offers).map(tx).join(", ") || "nothing"} done here${isPlain(n?.resource) ? ` on resources where ${words(n.resource)}` : ""}; it leaves on ${[...list(n?.leaves).map(tx), "a move of its step"].join(" or ")}`;
        else if (kind === "auto_decision") what += ": decided at once, on the context";
        else if (kind === "manual_decision") what += `: ${list(n?.for?.groups).join(", ") || list(n?.for?.users).join(", ") || "someone"} chooses`;
        else if (kind === "wait") what += `: shows "${n.message ?? ""}" for ${n.seconds ?? "?"} s, then ${n.mode === "auto" ? "goes on" : n.mode === "retry" ? "waits for someone, who may also retry" : "waits for someone to acknowledge it"}`;
        else if (kind === "input_screen") what += `: ${list(n?.for?.groups).join(", ") || "someone"} enters ${list(n?.fields).map((f) => f?.label ?? f?.name).join(", ") || "nothing"}`;
        else if (kind === "sub_flow") what += `: runs ${n.flow ?? "?"}${Object.keys(n?.returns ?? {}).length ? `, taking back ${Object.keys(n.returns).join(", ")}` : ""}`;
        else if (kind === "ask") what += `: the cursor to ${n.input ?? "?"}${n.prompt ? ` ("${n.prompt}")` : ""}, on by ${n.advance === "key" ? `the ${n.key ?? "?"} key` : n.advance === "auto" ? `itself once complete${Number.isInteger(n.length) ? ` (${n.length} characters)` : ""}${n.pattern ? ` (matching ${n.pattern})` : ""}` : { tab: "Tab", enter_or_tab: "Enter or Tab" }[n.advance] ?? "Enter"}${n.skipIfFilled === false ? ", even when filled" : ", passed over when filled"}${n.onError === "go" ? ", on even with an error" : ", staying while it shows an error"}`;
        else if (kind === "fill") what += `: fills ${n.input ?? "?"} with ${words(n.value)}`;
        else if (kind === "run") what += `: ${n.transaction ? `${tx(n.transaction)}'s ` : "the form's "}Check, then ${n.confirm === "auto" ? "confirmed at once" : "Enter on Confirm"}`;
        else if (kind === "end" && body.kind === "input") what += n?.then === "stop" ? ": stops" : ": back to the start, for the next one";
        else if (kind === "end") what += `: the end${n?.outcome ? ` (${n.outcome})` : ""}`;
        else what += ` (${kind})`;
        const hooks = [n?.onEnter ? `on entering, ${n.onEnter}` : "", n?.onExit ? `on leaving, ${n.onExit}` : ""].filter(Boolean);
        if (hooks.length) what += ` (${hooks.join("; ")})`;
        lines.push(`${what}${kind === "end" ? "." : `; then ${next.length ? next.join(", else ") : "nowhere"}.`}`);
    }
    if (body.ends?.when !== undefined) lines.push(`A run ends early when ${words(body.ends.when)}.`);
    return lines.join("\n");
}
