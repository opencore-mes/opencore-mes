// Comparing a change with what is published (DESIGN.md §5.3): what reviewers and approvers read. Each
// difference belongs to the designer tab where it is edited, so the tabs can say how many they hold,
// and a Changes view lists them with the published and the proposed versions side by side.
//
//   objectChanges(before, after, scripts)  → [{ tab, element, label, change, before, after }]
//   serviceChanges(before, after, script) / connectionChanges(before, after)
//   lineDiff(a, b)                          → [{ op: " " | "+" | "-", text }]
//   fieldStatus(before, after)              → { name: "added" | "changed" }, and removed: [names]
import { normalizeForm } from "./form-layout.js";
import { W } from "./editor-kit.js";

// Equal as data, whatever the order of an object's keys (a draft read back from jsonb has its keys
// in the database's order, not the order it was built in).
const stable = (v) => (Array.isArray(v) ? v.map(stable) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v);
const same = (a, b) => JSON.stringify(stable(a ?? null)) === JSON.stringify(stable(b ?? null));
const byKey = (items, key) => Object.fromEntries((Array.isArray(items) ? items : []).map((i) => [i?.[key], i]));
const changeOf = (a, b) => (a === undefined || a === null ? "added" : b === undefined || b === null ? "removed" : "changed");

// Which tab an object's element is edited on.
export const OBJECT_TABS = { general: "General", fields: "Fields", states: "States", access: "Roles & policies", rules: "Rules", layout: "Layout", stewards: "Stewards" };

export function objectChanges(before, after, scripts = {}) {
    const out = [];
    const push = (tab, element, label, a, b) => { if (!same(a, b)) out.push({ tab, element, label, change: changeOf(a, b), before: a ?? null, after: b ?? null }); };
    if (!after) return out;
    if (!before) {
        out.push({ tab: "general", element: "object", label: `New object ${after.label ?? after.object}`, change: "added", before: null, after });
        return out;
    }
    for (const [key, label] of [["label", "Label"], ["area", "Area"], ["description", "Description"], ["titleField", "Title field"], ["hints", "Hints"], ["analytics", "Analytics dimensions"], ["transfer", "Excel import and export"]]) push("general", key, label, before[key], after[key]);
    for (const name of new Set([...Object.keys(before.fields ?? {}), ...Object.keys(after.fields ?? {})])) push("fields", `field:${name}`, `Field ${name}`, before.fields?.[name], after.fields?.[name]);
    push("states", "states.list", "States", before.states?.list, after.states?.list);
    push("states", "states.initial", "Initial state", before.states?.initial, after.states?.initial);
    push("states", "states.tones", "Tones", before.states?.tones, after.states?.tones);
    const tb = byKey(before.states?.transitions, "action");
    const ta = byKey(after.states?.transitions, "action");
    for (const action of new Set([...Object.keys(tb), ...Object.keys(ta)])) push("states", `transition:${action}`, `Transition ${action}`, tb[action], ta[action]);
    push("access", "roles", "Roles", before.roles, after.roles);
    const pb = byKey(before.policies, "id");
    const pa = byKey(after.policies, "id");
    for (const id of new Set([...Object.keys(pb), ...Object.keys(pa)])) push("access", `policy:${id}`, `Policy ${id}`, pb[id], pa[id]);
    push("rules", "rules", "Rule pipe", before.rules, after.rules);
    for (const [name, { before: a, after: b }] of Object.entries(scripts)) push("rules", `script:${name}`, `Script ${name}.js`, a, b);
    push("layout", "form", "Form layout", before.form, after.form);
    push("layout", "list", "List", before.list, after.list);
    push("stewards", "stewards", "Stewards", before.stewards, after.stewards);
    push("stewards", "approval", "Approval of record changes", before.approval, after.approval);
    // Whatever else the definition carries: shown, so that nothing goes live that a reviewer did not see.
    const named = ["object", "label", "area", "description", "titleField", "hints", "analytics", "transfer", "fields", "states", "roles", "policies", "rules", "form", "list", "stewards", "approval", "suites"];
    const words = { flow: "Part in flows", builtIn: "Kept by the platform" };
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) if (!named.includes(key)) push("general", key, words[key] ?? `Setting "${key}"`, before[key], after[key]);
    // A suite's part of the design (§29.4), on that suite's tab.
    for (const suite of new Set([...Object.keys(before.suites ?? {}), ...Object.keys(after.suites ?? {})])) push(`suite:${suite}`, `suites.${suite}`, `Suite ${suite}`, before.suites?.[suite], after.suites?.[suite]);
    return out;
}

export const SERVICE_TABS = { general: "General", input: "Input", callers: "Identity", triggers: "Triggers", reaches: "Reaches", script: "Script", stewards: "Stewards" };
export function serviceChanges(before, after, script = null) {
    const out = [];
    const push = (tab, element, label, a, b) => { if (!same(a, b)) out.push({ tab, element, label, change: changeOf(a, b), before: a ?? null, after: b ?? null }); };
    if (!after) return out;
    if (!before) return [{ tab: "general", element: "service", label: `New service ${after.label ?? after.name}`, change: "added", before: null, after }];
    for (const [key, label] of [["label", "Label"], ["description", "Description"], ["http", "Web service"]]) push("general", key, label, before[key], after[key]);
    push("input", "input", "Input", before.input, after.input);
    for (const [key, label] of [["runAs", "Runs as"], ["roles", "Service role"], ["callers", "Callers"]]) push("callers", key, label, before[key], after[key]);
    for (const [key, label] of [["on", "Triggers and schedules"], ["runOn", "Runs on nodes tagged"]]) push("triggers", key, label, before[key], after[key]);
    push("reaches", "uses", "Reaches", before.uses, after.uses);
    if (script) push("script", "script", "Script", script.before, script.after);
    push("stewards", "stewards", "Stewards", before.stewards, after.stewards);
    return out;
}

export const CONNECTION_TABS = { general: "General", auth: "Authentication", allow: "Allowed requests", stewards: "Stewards" };
export function connectionChanges(before, after) {
    const out = [];
    const push = (tab, element, label, a, b) => { if (!same(a, b)) out.push({ tab, element, label, change: changeOf(a, b), before: a ?? null, after: b ?? null }); };
    if (!after) return out;
    if (!before) return [{ tab: "general", element: "connection", label: `New connection ${after.label ?? after.name}`, change: "added", before: null, after }];
    for (const [key, label] of [["label", "Label"], ["baseUrl", "Address"], ["timeoutMs", "Timeout"]]) push("general", key, label, before[key], after[key]);
    push("auth", "auth", "Authentication", before.auth, after.auth);
    push("allow", "allow", "Allowed requests", before.allow, after.allow);
    push("stewards", "stewards", "Stewards", before.stewards, after.stewards);
    return out;
}

// A transaction (§25): each part on the tab where it is edited.
export const TRANSACTION_TABS = { general: "General", inputs: "Inputs", layout: "Layout", checks: "Checks", steps: "Steps", scenarios: "Scenarios", callers: "Callers", stewards: "Stewards" };
export function transactionChanges(before, after) {
    const out = [];
    const push = (tab, element, label, a, b) => { if (!same(a, b)) out.push({ tab, element, label, change: changeOf(a, b), before: a ?? null, after: b ?? null }); };
    if (!after) return out;
    if (!before) return [{ tab: "general", element: "transaction", label: `New transaction ${after.label ?? after.name}`, change: "added", before: null, after }];
    for (const [key, label] of [["label", "Label"], ["description", "Description"], ["appearsOn", "Appears on"], ["confirm", "Confirm first"], ["signature", "Signature"], ["maximize", "Fill the window"], ["inputFlow", "Input flow"]]) push("general", key, label, before[key], after[key]);
    for (const name of new Set([...Object.keys(before.inputs ?? {}), ...Object.keys(after.inputs ?? {})])) push("inputs", `input:${name}`, `Input ${name}`, before.inputs?.[name], after.inputs?.[name]);
    push("layout", "form", "Form layout", before.form, after.form);
    const most = (a, b) => Math.max((a ?? []).length, (b ?? []).length);
    for (let i = 0; i < most(before.require, after.require); i++) push("checks", `require:${i}`, `Check ${i + 1}`, before.require?.[i], after.require?.[i]);
    for (let i = 0; i < most(before.steps, after.steps); i++) push("steps", `step:${i}`, `Step ${i + 1}`, before.steps?.[i], after.steps?.[i]);
    for (let i = 0; i < most(before.scenarios, after.scenarios); i++) push("scenarios", `scenario:${i}`, `Scenario ${after.scenarios?.[i]?.name ?? before.scenarios?.[i]?.name ?? i + 1}`, before.scenarios?.[i], after.scenarios?.[i]);
    push("callers", "callers", "Callers", before.callers, after.callers);
    push("stewards", "stewards", "Stewards", before.stewards, after.stewards);
    return out;
}

// A flow template (§32): its nodes and wires one by one, on the tab where each is drawn.
export const FLOW_TABS = { general: "General", canvas: "Flow", context: "Context", participants: "Participants", scenarios: "Scenarios", stewards: "Stewards" };
export function flowChanges(before, after) {
    const out = [];
    const push = (tab, element, label, a, b) => { if (!same(a, b)) out.push({ tab, element, label, change: changeOf(a, b), before: a ?? null, after: b ?? null }); };
    if (!after) return out;
    if (!before) return [{ tab: "canvas", element: "flow", label: `New flow template ${after.label ?? after.name}`, change: "added", before: null, after }];
    for (const [key, label] of [["label", "Label"], ["description", "Description"], ["kind", "Kind"], ["ends", "Ends early"]]) push("general", key, label, before[key], after[key]);
    for (const k of new Set([...Object.keys(before.context ?? {}), ...Object.keys(after.context ?? {})])) push("context", `context:${k}`, `Context value ${k}`, before.context?.[k], after.context?.[k]);
    for (const k of new Set([...Object.keys(before.participants ?? {}), ...Object.keys(after.participants ?? {})])) push("participants", `participant:${k}`, `Record ${k}`, before.participants?.[k], after.participants?.[k]);
    push("participants", "roles", "What the template itself may do", before.roles, after.roles);
    for (const id of new Set([...Object.keys(before.nodes ?? {}), ...Object.keys(after.nodes ?? {})])) push("canvas", `node:${id}`, `Node ${after.nodes?.[id]?.label ?? before.nodes?.[id]?.label ?? id}`, before.nodes?.[id], after.nodes?.[id]);
    const edgeKey = (e) => `${e?.from}→${e?.to}${e?.retry ? " (retry)" : ""}`;
    const byKey = (list) => new Map((list ?? []).map((e) => [edgeKey(e), e]));
    const [b, a] = [byKey(before.edges), byKey(after.edges)];
    for (const k of new Set([...b.keys(), ...a.keys()])) push("canvas", `edge:${k}`, `Wire ${k}`, b.get(k), a.get(k));
    if (!same((before.edges ?? []).map(edgeKey), (after.edges ?? []).map(edgeKey)) && same([...b.keys()].sort(), [...a.keys()].sort())) out.push({ tab: "canvas", element: "edges", label: "The order its wires are tried in", change: "changed", before: before.edges, after: after.edges });
    const scenarioNames = new Set([...(before.scenarios ?? []), ...(after.scenarios ?? [])].map((x) => x?.name));
    for (const n of scenarioNames) push("scenarios", `scenario:${n}`, `Scenario ${n}`, (before.scenarios ?? []).find((x) => x?.name === n), (after.scenarios ?? []).find((x) => x?.name === n));
    push("stewards", "stewards", "Stewards", before.stewards, after.stewards);
    return out;
}

// A screen (§26): its blocks one by one.
export const SCREEN_TABS = { general: "General", blocks: "Blocks", popup: "Pop-up", callers: "Callers", stewards: "Stewards" };
export function screenChanges(before, after) {
    const out = [];
    const push = (tab, element, label, a, b) => { if (!same(a, b)) out.push({ tab, element, label, change: changeOf(a, b), before: a ?? null, after: b ?? null }); };
    if (!after) return out;
    if (!before) return [{ tab: "general", element: "screen", label: `New screen ${after.label ?? after.name}`, change: "added", before: null, after }];
    for (const [key, label] of [["label", "Label"], ["description", "Description"], ["params", "Opened with"], ["maximize", "Fill the window"], ["inputFlow", "Input flow"]]) push("general", key, label, before[key], after[key]);
    for (let i = 0; i < Math.max((before.blocks ?? []).length, (after.blocks ?? []).length); i++) push("blocks", `block:${i}`, `Block ${i + 1}${after.blocks?.[i]?.title ? ` (${after.blocks[i].title})` : before.blocks?.[i]?.title ? ` (${before.blocks[i].title})` : ""}`, before.blocks?.[i], after.blocks?.[i]);
    push("popup", "popup", "Pop-up", before.popup, after.popup);
    push("callers", "callers", "Callers", before.callers, after.callers);
    push("stewards", "stewards", "Stewards", before.stewards, after.stewards);
    return out;
}

// A report layout (§34.5): its blocks one by one.
export const LAYOUT_TABS = { general: "General", blocks: "Blocks", stewards: "Stewards" };
export function layoutChanges(before, after) {
    const out = [];
    const push = (tab, element, label, a, b) => { if (!same(a, b)) out.push({ tab, element, label, change: changeOf(a, b), before: a ?? null, after: b ?? null }); };
    if (!after) return out;
    if (!before) return [{ tab: "general", element: "layout", label: `New report layout ${after.label ?? after.name}`, change: "added", before: null, after }];
    for (const [key, label] of [["label", "Label"], ["description", "Description"], ["guidance", "Guidance for the copilot"], ["scope", "The line's records"], ["goal", "The line's goal"]]) push("general", key, label, before[key], after[key]);
    for (let i = 0; i < Math.max((before.blocks ?? []).length, (after.blocks ?? []).length); i++) push("blocks", `block:${i}`, `Block ${i + 1}${after.blocks?.[i]?.title ? ` (${after.blocks[i].title})` : before.blocks?.[i]?.title ? ` (${before.blocks[i].title})` : ""}`, before.blocks?.[i], after.blocks?.[i]);
    push("stewards", "stewards", "Stewards", before.stewards, after.stewards);
    return out;
}

// A design element of a suite's kind (§30.11): what every element has, and each of its own settings.
export const ELEMENT_TABS = { general: "General", design: "Design", stewards: "Stewards" };
export function suiteElementChanges(before, after) {
    const out = [];
    const push = (tab, element, label, a, b) => { if (!same(a, b)) out.push({ tab, element, label, change: changeOf(a, b), before: a ?? null, after: b ?? null }); };
    if (!after) return out;
    if (!before) return [{ tab: "general", element: "element", label: `New ${after.kind ?? "design element"} ${after.label ?? after.name}`, change: "added", before: null, after }];
    for (const [key, label] of [["label", "Label"], ["description", "Description"]]) push("general", key, label, before[key], after[key]);
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !["name", "kind", "label", "description", "stewards"].includes(k)).sort()) push("design", key, key, before[key], after[key]);
    push("stewards", "stewards", "Stewards", before.stewards, after.stewards);
    return out;
}

// People & departments (§5.6): each department, person and object's roles on its own tab.
export const ORG_TABS = { departments: "Departments", people: "People", roles: "Roles", standing: "Approvals", formats: "Formats", theme: "Theme" };
export function organizationChanges(before, after) {
    const out = [];
    const push = (tab, element, label, a, b) => { if (!same(a, b)) out.push({ tab, element, label, change: changeOf(a, b), before: a ?? null, after: b ?? null }); };
    if (!after) return out;
    const keys = (a, b) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
    push("departments", "governance", "Governance", before?.governance, after.governance);
    for (const d of keys(before?.departments, after.departments)) push("departments", `department:${d}`, `Department ${after.departments?.[d]?.name ?? before?.departments?.[d]?.name ?? d}`, before?.departments?.[d], after.departments?.[d]);
    for (const g of keys(before?.groups, after.groups)) push("departments", `group:${g}`, `Group ${g}`, before?.groups?.[g], after.groups?.[g]);
    for (const u of keys(before?.users, after.users)) push("people", `person:${u}`, `${after.users?.[u]?.name ?? before?.users?.[u]?.name ?? u}`, before?.users?.[u], after.users?.[u]);
    for (const o of keys(before?.roles, after.roles)) push("roles", `roles:${o}`, `Roles on ${o}`, before?.roles?.[o], after.roles?.[o]);
    push("standing", "standing", "Standing approvers", before?.standing ?? {}, after.standing ?? {});
    push("formats", "formats", "Dates, times and numbers", before?.formats ?? {}, after.formats ?? {});
    push("theme", "theme", "Theme", before?.theme ?? {}, after.theme ?? {});
    return out;
}

export const countByTab = (changes) => changes.reduce((out, c) => ({ ...out, [c.tab]: (out[c.tab] ?? 0) + 1 }), {});

// Line by line: what stayed, what was added, what was taken out (longest common subsequence).
export function lineDiff(a, b) {
    const lines = (v) => (v === null || v === undefined || v === "" ? [] : String(v).split("\n"));
    const x = lines(a);
    const y = lines(b);
    if (x.length * y.length > 400_000) return [...x.map((text) => ({ op: "-", text })), ...y.map((text) => ({ op: "+", text }))];
    const n = x.length;
    const m = y.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (x[i] === y[j]) { out.push({ op: " ", text: x[i] }); i++; j++; } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: "-", text: x[i++] }); else out.push({ op: "+", text: y[j++] });
    }
    while (i < n) out.push({ op: "-", text: x[i++] });
    while (j < m) out.push({ op: "+", text: y[j++] });
    return out;
}
// A value as the text the diff compares: a script as it is, anything else as indented JSON.
export const textOf = (v) => (typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v, null, 2));

// For highlighting inside a tab: which fields, policies and layout places are new or changed.
export function statusMaps(before, after) {
    const status = (a, b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k], b[k]) && b[k] !== undefined).map((k) => [k, a[k] === undefined ? "added" : "changed"]));
    const removed = (a, b) => Object.keys(a).filter((k) => b[k] === undefined);
    if (!before || !after) return { fields: {}, removedFields: [], policies: {}, removedPolicies: [], layout: {} };
    const placeOf = (def) => {
        const out = {};
        normalizeForm(def).tabs.forEach((t, ti) => t.sections.forEach((s, si) => s.fields.forEach((e, i) => { out[e.field] = { t: t.label, s: s.label, i, ...e }; })));
        return out;
    };
    const pb = byKey(before.policies, "id");
    const pa = byKey(after.policies, "id");
    return {
        fields: status(before.fields ?? {}, after.fields ?? {}),
        removedFields: removed(before.fields ?? {}, after.fields ?? {}),
        policies: status(pb, pa),
        removedPolicies: removed(pb, pa),
        layout: status(placeOf(before), placeOf(after)),
    };
}

// What differs from the published version for one element of a change, and the scripts of an
// object's pipe: [{ tab, element, label, change, before, after }] (compare.js).
export function changesOf(api, id, kind, name) {
    const w = W(id);
    const live = api.peek(`dc.${id}.live`) ?? {};
    if (kind === "object") {
        const after = name === api.peek(`${w}.object`) ? api.peek(`${w}.b`) : api.peek(`${w}.defs.${name}`) ?? null;
        const before = live.definitions?.[name] ?? null;
        const names = new Set([...(before?.rules ?? []), ...(after?.rules ?? [])].map((r) => r.script));
        const scripts = {};
        for (const n of names) {
            const draft = api.peek(`${w}.s.${n}`);
            if (draft !== undefined || live.scripts?.[n] !== undefined) scripts[n] = { before: live.scripts?.[n] ?? null, after: draft ?? live.scripts?.[n] ?? null };
        }
        return objectChanges(before, after, scripts);
    }
    if (kind === "service") return serviceChanges(live.services?.[name] ?? null, api.peek(`${w}.sv.${name}`), { before: live.scripts?.[name] ?? null, after: api.peek(`${w}.s.${name}`) ?? null });
    if (kind === "transaction") return transactionChanges(live.transactions?.[name] ?? null, api.peek(`${w}.tx.${name}`));
    if (kind === "screen") return screenChanges(live.screens?.[name] ?? null, api.peek(`${w}.sc.${name}`));
    if (kind === "flow") return flowChanges(live.flows?.[name] ?? null, api.peek(`${w}.fl.${name}`));
    if (kind === "layout") return layoutChanges(live.layouts?.[name] ?? null, api.peek(`${w}.ly.${name}`));
    if (kind === "element") return suiteElementChanges(live.elements?.[name] ?? null, api.peek(`${w}.el.${name}`));
    if (kind === "organization") return organizationChanges(live.organization ?? null, api.peek(`${w}.org`));
    return connectionChanges(live.connections?.[name] ?? null, api.peek(`${w}.cn.${name}`));
}
