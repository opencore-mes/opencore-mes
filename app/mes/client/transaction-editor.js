// The designer's editor for a transaction (DESIGN.md §25), beside the object, service and connection
// editors, in the same windows on the same working copy (`${w}.tx.<name>`). A transaction is changed
// as an object is: a draft in a change request, checked as it is typed, approved by its stewards and
// by the stewards of what its steps write, and live once executed.
import { inputFlowSummary } from "./input-flow.js";
import { noDefault } from "./select.js";
import { pickMany, tagsInput } from "./pick.js";
import { validateTransaction, transactionFootprint, FIELD_TYPES, IDENTIFIER } from "./definition.js";
import { changesOf, countByTab, statusMaps } from "./compare.js";
import { elementOps, jsonOf, deprecation } from "./integration-editor.js";
import { W, text, labelled, check, draftDefinitions } from "./editor-kit.js";
import { icon, withIcon } from "./icons.js";
import { exprField, objectEntries, scope } from "./expr-builder.js";
import { confirmRemove } from "./dialog.js";
import { querySourceEditor, queriesKnown } from "./query-source.js";

export const TRANSACTION_VIEWS = [["copilot", "Copilot", "sparkle"], ["changes", "Changes"], ["general", "General"], ["inputs", "Inputs"], ["layout", "Layout"], ["checks", "Checks"], ["steps", "Steps"], ["scenarios", "Scenarios"], ["callers", "Callers"], ["try", "Try it"], ["stewards", "Stewards"], ["json", "JSON"]];

const hint = (words) => ({ p: { className: "muted small", textContent: words } });
const toggleIn = (list, value, on) => {
    const set = new Set(list ?? []);
    if (on) set.add(value); else set.delete(value);
    return [...set];
};
const checks = (ctx, items, current, onToggle) => ({
    div: {
        className: "checks",
        children: items.map(({ value, label }) => ({ label: { key: value, children: [{ input: { type: "checkbox", disabled: ctx.ro, checked: (current ?? []).includes(value), onchange: (e) => onToggle(value, e.target.checked) } }, { span: ` ${label ?? value}` }] } })),
    },
});
const json = (v) => (v === undefined ? "" : JSON.stringify(v));
const parsed = (textValue) => { try { return { ok: true, value: textValue.trim() ? JSON.parse(textValue) : undefined }; } catch { return { ok: false }; } };

// The objects a transaction may name, as they will be once this change executes: each one's fields,
// states, transitions and stewards (the object drafted in this change, if any, as drafted).
export function transactionKnown(api, w) {
    const home = api.peek("design.home") ?? {};
    const objects = Object.fromEntries((home.objects ?? []).map((o) => [o.object, { label: o.label, fields: o.fields ?? {}, actions: o.actions ?? [], states: o.states ?? [], transitions: o.transitions ?? [], titleField: o.titleField, tones: o.tones ?? {}, stewards: o.stewardship ?? { object: o.stewards ?? [] }, roles: o.roles ?? [], ...(o.approval ? { approval: o.approval } : {}) }]));
    for (const [object, body] of Object.entries(draftDefinitions(api, w))) {
        if (body) objects[object] = { label: body.label, fields: body.fields ?? {}, actions: (body.states?.transitions ?? []).map((t) => t.action), states: body.states?.list ?? [], transitions: body.states?.transitions ?? [], titleField: body.titleField, tones: body.states?.tones ?? {}, stewards: body.stewards ?? {}, roles: body.roles ?? [], ...(body.approval ? { approval: body.approval } : {}) };
    }
    // The input flows it may name (§32.13), the change's drafts over what is live.
    const inputFlows = Object.fromEntries((home.flows ?? []).filter((f) => f.kind === "input").map((f) => [f.name, f.summary ?? inputFlowSummary(null)]));
    for (const [n, b] of Object.entries(api.peek(`${w}.fl`) ?? {})) if (b?.kind === "input") inputFlows[n] = inputFlowSummary(b);
    // The services there will be (a transaction's callers may name them), and the transactions each runs
    // as its own service role (§15.2): their callers must keep naming them.
    const serviceBodies = Object.entries(api.peek(`${w}.sv`) ?? {});
    const services = [...new Set([...(home.services ?? []).map((sv) => sv.name), ...serviceBodies.map(([n]) => n)])];
    const runBy = {};
    const drafted = new Set(serviceBodies.map(([n]) => n));
    for (const sv of home.services ?? []) if (!drafted.has(sv.name)) for (const t of sv.runs ?? []) (runBy[t] ??= []).push(sv.name);
    for (const [sv, b] of serviceBodies) if (b && (b.runAs ?? "service") === "service") for (const t of b.uses?.transactions ?? []) (runBy[t] ??= []).push(sv);
    // The named queries there will be (§23.1): a reference input's choices may come from one.
    return { queries: queriesKnown(api, w), objects, users: (home.users ?? []).map((u) => u.id), groups: (home.groups ?? []).map((g) => g.id), departments: (home.departments ?? []).map((d) => d.id), inputFlows, suiteSteps: home.suiteSteps ?? {}, services, runBy };
}

export function transactionProblems(api, id) {
    const w = W(id);
    const known = transactionKnown(api, w);
    const out = [];
    for (const [name, body] of Object.entries(api.peek(`${w}.tx`) ?? {})) for (const p of validateTransaction(body, known)) out.push({ ...p, message: `${name}: ${p.message}` });
    return out;
}

// The footprint of the change's transactions, against what is live (for the route panel).
export function transactionElements(api, id, change) {
    const w = W(id);
    const known = transactionKnown(api, w);
    const context = { objects: known.objects };
    const out = [];
    for (const [name, body] of Object.entries(api.peek(`${w}.tx`) ?? {})) out.push(...transactionFootprint(name, change.live.transactions?.[name] ?? undefined, body, context));
    return out;
}

// ---- the tabs ----
function generalTab(ctx) {
    const { api, body, ops, ro, name } = ctx;
    const known = transactionKnown(api, ctx.w);
    const where = body.appearsOn ?? null;
    const target = where ? known.objects[where.object] : null;
    const fillable = Object.entries(body.inputs ?? {}).filter(([, s]) => s.type === "ref" && !s.from && (!where || s.to === where.object)).map(([k]) => k);
    const published = (api.peek("design.home.transactions") ?? []).some((t) => t.name === name);
    return {
        div: {
            className: "ed-grid",
            children: [
                labelled("Name", { input: { type: "text", value: body.name, disabled: true } }, `Fixed once created; its screen is /t/${name}.`),
                labelled("Label", text(ctx, "label"), "What the button and the screen say (Move in)."),
                labelled("Description", text(ctx, "description", { multiline: true }), "One line under the title: what it does."),
                labelled("Appears on", {
                    select: {
                        disabled: ro,
                        onchange: (e) => ops.edit((b) => {
                            if (!e.target.value) { delete b.appearsOn; return; }
                            const fills = Object.entries(b.inputs ?? {}).find(([, s]) => s.type === "ref" && !s.from && s.to === e.target.value)?.[0];
                            b.appearsOn = { object: e.target.value, states: [], ...(fills ? { fills } : {}) };
                        }),
                        children: noDefault([{ option: { value: "", selected: !where, textContent: "only in the navigator" } }, ...Object.entries(known.objects).map(([o, d]) => ({ option: { value: o, selected: where?.object === o, textContent: `records of ${d.label ?? o}` } }))]),
                    },
                }, "A button on those records opens it with the record filled in."),
                where && target ? labelled("…while they are", checks(ctx, (target.states ?? []).map((s) => ({ value: s, label: s.replace(/_/g, " ") })), where.states, (v, on) => ops.edit((b) => { b.appearsOn.states = toggleIn(b.appearsOn.states, v, on); })), "None ticked: in every state.") : { span: {} },
                where && target ? labelled("…only when", condition(ctx, "appearsOn.when", where.when, (v) => ops.set("appearsOn.when", v, true), "always", { scopes: { record: scope(`the ${String(target.label ?? where.object).toLowerCase()}`, objectEntries(target)) } }), "A condition on the record, read as {\"record\": \"field\"}: the button shows only where it holds.") : { span: {} },
                where ? labelled("…filling in", { select: { disabled: ro, onchange: (e) => ops.edit((b) => { b.appearsOn.fills = e.target.value; }), children: noDefault([{ option: { value: "", textContent: "—" } }, ...fillable.map((k) => ({ option: { value: k, selected: where.fills === k, textContent: `${body.inputs[k].label ?? k} (${k})` } }))]) } }, "The input the record goes into.") : { span: {} },
                labelled("Confirm first", check(ctx, "confirm", "show what will change, and ask to confirm, before it runs"), "Recommended. Off: it runs as soon as the button is pressed."),
                labelled("Electronic signature", {
                    input: { type: "text", disabled: ro, placeholder: "none (e.g. Performed)", value: body.signature?.meaning ?? "", onchange: (e) => ops.edit((b) => { const m = e.target.value.trim(); if (m) b.signature = { ...(b.signature ?? {}), meaning: m }; else delete b.signature; }) },
                }, "Its meaning: the person signs it as they confirm (Part 11), recorded with the run."),
                body.signature ? labelled("Verified by a second person", { label: { children: [{ input: { type: "checkbox", disabled: ro, checked: Boolean(body.signature.verifier), onchange: (e) => ops.edit((b) => { if (e.target.checked) b.signature.verifier = { meaning: "", departments: [] }; else delete b.signature.verifier; }) } }, { span: " a second person, signed in beside the one running it, verifies it; both re-enter their passwords at every submit" }] } }, "Two signatures at most: the one who runs it, and the one who verifies.") : { span: {} },
                body.signature?.verifier ? labelled("…their signature means", { input: { type: "text", disabled: ro, placeholder: "e.g. Verified", value: body.signature.verifier.meaning ?? "", onchange: (e) => ops.edit((b) => { b.signature.verifier.meaning = e.target.value.trim(); }) } }, "What the second person signs to.") : { span: {} },
                body.signature?.verifier ? labelled("…who may verify: departments", checks(ctx, known.departments.map((d) => ({ value: d, label: d })), body.signature.verifier.departments ?? [], (v, on) => ops.edit((b) => { b.signature.verifier.departments = toggleIn(b.signature.verifier.departments, v, on); if (!b.signature.verifier.departments.length) delete b.signature.verifier.departments; })), "Anyone in one of them, other than the one running it.") : { span: {} },
                body.signature?.verifier ? labelled("…or roles", tagsInput({ key: `${ctx.w}.vroles.${ctx.name}`, readOnly: ro, placeholder: "Add a role (object.role)…", value: body.signature.verifier.roles ?? [],
                    // A role of an object: object.role, from those the objects declare.
                    options: (api.peek("design.home")?.objects ?? []).flatMap((o) => (o.roles ?? []).map((r) => ({ value: `${o.object}.${r}`, label: `${o.object}.${r}`, hint: o.label ?? "" }))),
                    create: (t) => (/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(t) ? t : { error: `“${t}”: a role is object.role, e.g. lot.supervisor` }),
                    onChange: (r) => ops.edit((b) => { if (r.length) b.signature.verifier.roles = r; else delete b.signature.verifier.roles; }) }), "Roles on objects, \"<object>.<role>\": anyone holding one may verify.") : { span: {} },
                labelled("Fill the window", maximizeSelect(ctx), "A Maximize button on its screen sets the navigator, the top bar and the tabs aside: a tablet at a machine. Each device remembers the person's choice."),
                labelled("Input flow", inputFlowSelect(ctx), "How it is filled from the keyboard or a scanner: which input next, what moves on (Enter, Tab, a key, or by itself), decisions on what was entered, and back to the start for the next one. Drawn in the Flow designer (a flow template of kind input)."),
                published ? { p: { children: [{ Link: { to: `/t/${name}`, className: "btn", textContent: "Open its screen (the published version)" } }] } } : { span: {} },
            ],
        },
    };
}

function inputsTab(ctx) {
    const { api, w, body, ops, ro, id } = ctx;
    const known = transactionKnown(api, w);
    const inputs = body.inputs ?? {};
    // Where an input may be filled in from: another reference input's field, a reference to the same
    // object (the lot's machine), or for any other type a field of that type, its value copied and shown
    // (the lot's units); entered or filled in itself, not in a circle.
    const sourcesFor = (k, spec) => Object.entries(inputs)
        .filter(([other, s]) => other !== k && s.type === "ref")
        .flatMap(([other, s]) => Object.entries(known.objects[s.to]?.fields ?? {}).filter(([, f]) => (spec.type === "ref" ? f.type === "ref" && f.to === spec.to : f.type === spec.type)).map(([field, f]) => ({ value: `${other}.${field}`, label: `${s.label ?? other}'s ${(f.label ?? field).toLowerCase()}` })));
    return {
        div: {
            children: [
                hint("What the person enters or scans. A reference input names a record (a lot, a machine); one filled in from another record (the lot's machine) is shown, not typed. Lay them out on the Layout tab; set when one is required there too."),
                {
                    table: {
                        className: "grid ed-table",
                        children: [
                            { thead: { children: [{ tr: { children: ["Input", "Label", "Type", "Required", "Refers to / values", "Filled in from", ""].map((h) => ({ th: h })) } }] } },
                            {
                                tbody: {
                                    children: Object.entries(inputs).map(([k, spec]) => ({
                                        tr: {
                                            key: k,
                                            className: ctx.diff?.fields?.[k] ? `diff-${ctx.diff.fields[k]}` : "",
                                            children: [
                                                { td: { children: [{ code: k }] } },
                                                { td: { children: [text(ctx, `inputs.${k}.label`)] } },
                                                { td: { children: [{ select: { disabled: ro, onchange: (e) => ops.edit((b) => { const s = b.inputs[k]; s.type = e.target.value; if (s.type !== "ref") delete s.to; delete s.from; if (s.type !== "enum") { delete s.values; delete s.multiple; } if (s.type === "ref") s.to ??= Object.keys(known.objects)[0]; if (s.type === "enum") s.values ??= ["a", "b"]; if (s.type === "rows") { s.fields ??= { value: { label: "Value", type: "decimal", required: true } }; s.min ??= 1; } else { delete s.fields; delete s.min; delete s.max; } }), children: noDefault([...FIELD_TYPES, "rows"].map((t) => ({ option: { value: t, selected: spec.type === t, textContent: t === "rows" ? "rows (a table)" : t } }))) } }] } },
                                                { td: { children: [check(ctx, `inputs.${k}.required`, "")] } },
                                                {
                                                    td: {
                                                        children: [spec.type === "ref"
                                                            ? { select: { disabled: ro, onchange: (e) => ops.edit((b) => { b.inputs[k].to = e.target.value; delete b.inputs[k].from; }), children: noDefault(Object.entries(known.objects).map(([o, d]) => ({ option: { value: o, selected: spec.to === o, textContent: d.label ?? o } }))) } }
                                                            : spec.type === "enum"
                                                                ? { div: { children: [
                                                                    tagsInput({ key: `${ctx.w}.ivals.${ctx.name}.${k}`, readOnly: ro, placeholder: "Add a value…", value: spec.values ?? [], onChange: (next) => ops.set(`inputs.${k}.values`, next, true) }),
                                                                    check(ctx, `inputs.${k}.multiple`, "Multiple select"),
                                                                ] } }
                                                                : spec.type === "rows"
                                                                    ? { div: { className: "tx-rows-spec", children: [
                                                                        tagsInput({ key: `${ctx.w}.rowf.${ctx.name}.${k}`, readOnly: ro, placeholder: "Add a field (name:type)…", value: Object.entries(spec.fields ?? {}).map(([c, cs]) => `${c}:${cs.type}`),
                                                                            // Each row's fields, as name:type (string unless said): the type one of ROW_TYPES.
                                                                            create: (t) => { const [n, ty = "string"] = t.split(":").map((x) => x.trim()); return /^[a-z][a-z0-9_]*$/.test(n) && ROW_TYPES.includes(ty) ? `${n}:${ty}` : { error: `“${t}”: name:type, the type one of ${ROW_TYPES.join(", ")}` }; },
                                                                            onChange: (next) => ops.edit((b) => { b.inputs[k].fields = rowFields(next.join(","), b.inputs[k].fields); }) }),
                                                                        { span: { className: "small", children: [{ span: "at least " }, { input: { type: "number", min: 0, max: 1000, disabled: ro, className: "tiny", value: String(spec.min ?? ""), onchange: (e) => ops.edit((b) => { const n = parseInt(e.target.value, 10); if (Number.isInteger(n)) b.inputs[k].min = n; else delete b.inputs[k].min; }) } }, { span: " at most " }, { input: { type: "number", min: 0, max: 1000, disabled: ro, className: "tiny", value: String(spec.max ?? ""), onchange: (e) => ops.edit((b) => { const n = parseInt(e.target.value, 10); if (Number.isInteger(n)) b.inputs[k].max = n; else delete b.inputs[k].max; }) } }, { span: " rows" }] } },
                                                                    ] } }
                                                                    : { span: { className: "muted", textContent: "—" } }],
                                                    },
                                                },
                                                { td: { children: [spec.type !== "rows" ? { select: { disabled: ro, onchange: (e) => ops.edit((b) => { if (e.target.value) b.inputs[k].from = e.target.value; else delete b.inputs[k].from; }), children: noDefault([{ option: { value: "", textContent: "entered" } }, ...sourcesFor(k, spec).map((o) => ({ option: { value: o.value, selected: spec.from === o.value, textContent: o.label } }))]) } } : { span: { className: "muted", textContent: "entered" } }] } },
                                                { td: { children: ro() ? [] : [{ button: { type: "button", className: "btn ghost", textContent: "Remove", onclick: confirmRemove(ctx.api, `input ${k}`, () => ops.edit((b) => { delete b.inputs[k]; }) )} }] } },
                                            ],
                                        },
                                    })),
                                },
                            },
                        ],
                    },
                },
                ro() ? { span: {} } : addRow(ctx, "New input (e.g. good_qty)", (k) => ops.edit((b) => { (b.inputs ??= {})[k] ??= { label: k.replace(/_/g, " "), type: "string" }; })),
                // A reference input's choices from a named query (§23.1): the machines of the kind entered, the lots on
                // hold; in place of every record of its object. One a record is filled in from takes none.
                ...Object.entries(inputs).filter(([, spec]) => spec.type === "ref" && spec.from === undefined).map(([k, spec]) => ({ details: { key: `qsrc-${k}`, className: "tx-input-choices", open: Boolean(spec.options), children: [
                    { summary: { textContent: `Choices of ${spec.label ?? k}${spec.options?.query ? `: from ${spec.options.query}` : ""}` } },
                    querySourceEditor(api, {
                        w, id, key: `${w}.qsrc.${ctx.name}.${k}`, readOnly: ro(), value: spec.options ?? null, kind: "choices", noun: String(known.objects[spec.to]?.label ?? spec.to ?? "record").toLowerCase(),
                        scopes: 'its inputs ({"input": "kind"}), the records they name ({"lookup": "lot.product"}), the person ({"user": "id"}) and the route step ({"node": "area"})',
                        onChange: (src) => ops.edit((b) => { if (src) b.inputs[k].options = src; else delete b.inputs[k].options; }),
                    }),
                ] } })),
            ],
        },
    };
}

function addRow(ctx, placeholder, onAdd) {
    const path = `${ctx.w}.adding.tx.${ctx.name}.${placeholder.length}`;
    return {
        div: {
            className: "add-row",
            children: [
                { input: { type: "text", placeholder, value: () => ctx.api.getState(path, "") ?? "", oninput: (e) => ctx.api.setValue(path, e.target.value.trim().toLowerCase()) } },
                { button: { type: "button", className: "btn", textContent: "Add", disabled: () => !IDENTIFIER.test(ctx.api.getState(path, "") ?? ""), onclick: () => { onAdd(ctx.api.peek(path)); ctx.api.setValue(path, ""); } } },
            ],
        },
    };
}

// What route steps offering this transaction set in their settings ({ node: "parameter" }): from the live
// routes (the designer's home), and those drafted in this change, which come first.
function stepSettings(ctx) {
    const types = {};
    const add = (k, t) => { types[k] = types[k] === "string" || t === "string" ? "string" : "number"; };
    for (const body of Object.values(ctx.api.peek(`${ctx.w}.fl`) ?? {})) for (const n of Object.values(body?.nodes ?? {})) {
        if (!(n?.offers ?? []).includes(ctx.name) || !n.settings || typeof n.settings !== "object") continue;
        for (const [k, v] of Object.entries(n.settings)) add(k, typeof v === "number" ? "number" : "string");
    }
    const drafted = new Set(Object.keys(ctx.api.peek(`${ctx.w}.fl`) ?? {}));
    for (const f of ctx.api.getState("design.home.flows", []) ?? []) if (!drafted.has(f.name)) for (const [k, t] of Object.entries(f.txSettings?.[ctx.name] ?? {})) add(k, t);
    return Object.entries(types).map(([path, type]) => ({ path, label: `the step's ${path.replace(/_/g, " ")}`, type }));
}

// An expression typed as JSON on one line: applied whenever it parses; marked while it does not.
// What a transaction's checks and steps read (§25, §9.2a): its inputs, the fields of the records they name
// (lookup), the person running it and their Person record, a route step's settings, a table input's rows, and
// counts of records. Its "appears on … only when": the record the button is on.
function txSpec(ctx) {
    const known = transactionKnown(ctx.api, ctx.w);
    const inputs = Object.entries(ctx.body.inputs ?? {});
    const typeOf = (sp) => (sp?.multiple ? "list" : sp?.type === "ref" ? "ref" : sp?.type ?? "string");
    const certIds = Object.keys(ctx.api.getState("design.home.organization.certifications", {}) ?? {});
    return { scopes: {
        input: scope("what is entered", inputs.map(([n, sp]) => ({ path: n, label: sp?.label ?? n, type: typeOf(sp), ...(Array.isArray(sp?.values) ? { values: sp.values } : {}) }))),
        lookup: scope("the records entered", inputs.filter(([, sp]) => sp?.type === "ref").flatMap(([n, sp]) => objectEntries(known.objects?.[sp.to], { prefix: `${n}.`, label: sp?.label ?? n }))),
        // …and the certifications they hold today (§27.9): a step only a certified person does.
        user: scope("the person", [{ path: "id", label: "the person (sign-in id)", type: "string" }, ...(certIds.length ? [{ path: "certifications", label: "their certifications", type: "list", values: certIds }] : [])]),
        person: scope("their Person record", objectEntries(known.objects?.person).filter((e) => e.path !== "id" && e.path !== "state")),
        // The settings the route steps that offer it give it (live, and drafted in this change): a check that
        // the step says what to measure, a limit read off it.
        node: scope("the route step's settings", stepSettings(ctx)),
        row: scope("a row of a table input", []),
    }, count: Object.keys(known.objects ?? {}) };
}
const condition = (ctx, path, stored, apply, empty, spec) => exprField({ key: `${ctx.w}.txexpr.${ctx.name}.${path}`, readOnly: ctx.ro, empty, value: () => stored, onChange: apply, spec: spec ?? txSpec(ctx) });

function exprInput(ctx, path, stored, apply, placeholder = "") {
    const draft = `${ctx.w}.exprText.${ctx.name}.${path}`;
    const current = () => ctx.api.getState(draft, null) ?? json(stored);
    return {
        input: {
            type: "text", className: () => `expr-input${parsed(current()).ok ? "" : " bad"}`, disabled: ctx.ro, placeholder, spellcheck: false,
            value: current,
            oninput: (e) => {
                ctx.api.setValue(draft, e.target.value);
                const p = parsed(e.target.value);
                if (p.ok) apply(p.value);
            },
        },
    };
}

const EXAMPLES = 'Conditions read {"input": "qty"}, {"lookup": "machine.state"} (a field of the record an input names), {"user": "id"} and {"count": {"object": "lot", "where": {"machine": {"input": "machine"}, "state": ["processing"]}}}; with eq ne lt le gt ge, in, contains, all, any, not, is_null, add, sub, mul, div, and some / every over a rows input ({"some": [{"input": "readings"}, {"gt": [{"row": "value"}, 1.5]}]}). They read the records as they were before any step.';

function checksTab(ctx) {
    const { body, ops, ro } = ctx;
    const inputs = Object.keys(body.inputs ?? {});
    const require = body.require ?? [];
    return {
        div: {
            children: [
                hint("What must hold before anything changes. Each is checked again, under lock, the moment it runs, so two people never both pass a capacity check. A failing check refuses the run with its words, on the input it names."),
                hint(EXAMPLES),
                ...require.map((r, i) => ({
                    fieldset: {
                        key: `req-${i}`,
                        className: `tx-card ${ctx.changedAt?.(`require:${i}`) ?? ""}`,
                        children: [
                            { legend: { children: [{ strong: `Check ${i + 1}` }, ro() ? { span: {} } : { button: { type: "button", className: "linkish", textContent: "remove", onclick: confirmRemove(ctx.api, `check ${i + 1}`, () => ops.edit((b) => { b.require.splice(i, 1); }) )} }] } },
                            labelled("Must hold", condition(ctx, `require.${i}.that`, r.that, (v) => ops.set(`require.${i}.that`, v, true), "nothing yet: build the check")),
                            labelled("Otherwise, say", text(ctx, `require.${i}.message`, { placeholder: "The machine is down." })),
                            labelled("On the input", { select: { disabled: ro, onchange: (e) => ops.edit((b) => { if (e.target.value) b.require[i].field = e.target.value; else delete b.require[i].field; }), children: noDefault([{ option: { value: "", textContent: "the whole form" } }, ...inputs.map((k) => ({ option: { value: k, selected: r.field === k, textContent: k } }))]) } }),
                        ],
                    },
                })),
                ro() ? { span: {} } : { button: { type: "button", className: "btn", textContent: "Add check", onclick: () => ops.edit((b) => { (b.require ??= []).push({ that: { ne: [{ input: inputs[0] ?? "x" }, null] }, message: "Say what is wrong." }); }) } },
            ],
        },
    };
}

// A rows input's fields from "value:decimal, note:string", keeping the labels and requirements of
// fields that stay.
const ROW_TYPES = ["string", "integer", "decimal", "boolean", "date"];
function rowFields(text, before = {}) {
    const out = {};
    for (const part of String(text).split(",").map((p) => p.trim()).filter(Boolean)) {
        const [name, type = "string"] = part.split(":").map((x) => x.trim());
        if (!/^[a-z][a-z0-9_]*$/.test(name)) continue;
        out[name] = { ...(before?.[name] ?? { label: name.replace(/_/g, " ") }), type: ROW_TYPES.includes(type) ? type : "string" };
    }
    return out;
}

// A step that creates a record (§25.1): of which object, once or once per row, and its fields.
function createStepCard(ctx, st, i, count, known, move) {
    const { ops, ro, body } = ctx;
    const target = known.objects[st.create];
    const fields = Object.keys(target?.fields ?? {});
    const unset = fields.filter((f) => !Object.hasOwn(st.set ?? {}, f));
    const rowsInputs = Object.entries(body.inputs ?? {}).filter(([, s]) => s.type === "rows");
    return {
        fieldset: {
            key: `step-${i}`,
            className: `tx-card ${ctx.changedAt?.(`step:${i}`) ?? ""}`,
            children: [
                { legend: { children: [
                    { strong: `Step ${i + 1}: creates a record` },
                    ro() || i === 0 ? { span: {} } : { button: { type: "button", className: "mini", title: "Earlier", "aria-label": "Earlier", children: [icon("arrowUp")], onclick: () => move(i, -1) } },
                    ro() || i === count - 1 ? { span: {} } : { button: { type: "button", className: "mini", title: "Later", "aria-label": "Later", children: [icon("arrowDown")], onclick: () => move(i, 1) } },
                    ro() ? { span: {} } : { button: { type: "button", className: "linkish", textContent: "remove", onclick: confirmRemove(ctx.api, `step ${i + 1}`, () => ops.edit((b) => { b.steps.splice(i, 1); }) )} },
                ] } },
                { div: { className: "ed-row", children: [
                    labelled("Creates a", { select: { disabled: ro, onchange: (e) => ops.edit((b) => { b.steps[i] = { create: e.target.value, set: {}, ...(st.forEach ? { forEach: st.forEach } : {}) }; }), children: noDefault(Object.entries(known.objects).map(([o, d]) => ({ option: { value: o, selected: st.create === o, textContent: d.label ?? o } }))) } }),
                    labelled("How many", { select: { disabled: ro, onchange: (e) => ops.edit((b) => { if (e.target.value) b.steps[i].forEach = e.target.value; else delete b.steps[i].forEach; }), children: noDefault([{ option: { value: "", textContent: "one" } }, ...rowsInputs.map(([k, s]) => ({ option: { value: k, selected: st.forEach === k, textContent: `one per row of ${s.label ?? k}` } }))]) } }, st.forEach ? 'Its fields read the row as {"row": "field"}.' : "Through its object's own policies, rules and validation, as the person."),
                ] } },
                { div: { className: "tx-sets", children: [
                    { strong: { className: "small", textContent: "Sets" } },
                    ...Object.entries(st.set ?? {}).map(([f, e]) => ({ div: { key: f, className: "tx-set", children: [
                        { code: f }, { span: " = " },
                        exprInput(ctx, `steps.${i}.set.${f}`, e, (v) => ops.set(`steps.${i}.set.${f}`, v === undefined ? null : v, false), st.forEach ? '{"row": "value"}' : '{"input": "lot"}'),
                        ro() ? { span: {} } : { button: { type: "button", className: "mini", title: "Don't set it", "aria-label": "Don't set it", children: [icon("x")], onclick: () => ops.edit((b) => { delete b.steps[i].set[f]; }) } },
                    ] } })),
                    ro() || !unset.length ? { span: {} } : { select: { className: "mini-select", onchange: (e) => { const f = e.target.value; if (!f) return; ops.edit((b) => { b.steps[i].set = { ...(b.steps[i].set ?? {}), [f]: null }; }); }, children: noDefault([{ option: { value: "", textContent: "+ set a field" } }, ...unset.map((f) => ({ option: { value: f, textContent: target.fields[f]?.label ?? f } }))]) } },
                ] } },
                labelled("Only when", condition(ctx, `steps.${i}.when`, st.when, (v) => ops.set(`steps.${i}.when`, v, true), "always")),
            ],
        },
    };
}

// A step on the records it finds (§25.1): of which object, where its fields equal what the run works out, how many
// at most, what it does to each (sets, an action, or nothing), and the name the steps after it read it by.
function findStepCard(ctx, st, i, count, known, move) {
    const { ops, ro } = ctx;
    const find = st.find ?? {};
    const target = known.objects[find.object];
    const fields = Object.keys(target?.fields ?? {});
    const whereFree = [...fields, "state"].filter((f) => !Object.hasOwn(find.where ?? {}, f));
    const unset = fields.filter((f) => !Object.hasOwn(st.set ?? {}, f));
    const head = { legend: { children: [
        { strong: `Step ${i + 1}: finds records` },
        ro() || i === 0 ? { span: {} } : { button: { type: "button", className: "mini", title: "Earlier", "aria-label": "Earlier", children: [icon("arrowUp")], onclick: () => move(i, -1) } },
        ro() || i === count - 1 ? { span: {} } : { button: { type: "button", className: "mini", title: "Later", "aria-label": "Later", children: [icon("arrowDown")], onclick: () => move(i, 1) } },
        ro() ? { span: {} } : { button: { type: "button", className: "linkish", textContent: "remove", onclick: confirmRemove(ctx.api, `step ${i + 1}`, () => ops.edit((b) => { b.steps.splice(i, 1); }) )} },
    ] } };
    const pairs = (key, values, free, placeholder, words) => ({ div: { className: "tx-sets", children: [
        { strong: { className: "small", textContent: words } },
        ...Object.entries(values ?? {}).map(([f, e]) => ({ div: { key: f, className: "tx-set", children: [
            { code: f }, { span: " = " },
            exprInput(ctx, `steps.${i}.${key}.${f}`, e, (v) => ops.set(`steps.${i}.${key}.${f}`, v === undefined ? null : v, false), placeholder),
            ro() ? { span: {} } : { button: { type: "button", className: "mini", title: "Take it out", "aria-label": `Take ${f} out`, children: [icon("x")], onclick: () => ops.edit((b) => { const at = key === "find.where" ? b.steps[i].find.where : b.steps[i].set; delete at[f]; if (key === "set" && !Object.keys(at).length) delete b.steps[i].set; }) } },
        ] } })),
        ro() || !free.length ? { span: {} } : { select: { className: "mini-select", "aria-label": `Add to ${words.toLowerCase()}`, onchange: (e) => { const f = e.target.value; if (!f) return; ops.edit((b) => { if (key === "find.where") b.steps[i].find.where = { ...(b.steps[i].find.where ?? {}), [f]: null }; else b.steps[i].set = { ...(b.steps[i].set ?? {}), [f]: null }; }); },
            children: noDefault([{ option: { value: "", textContent: "+ a field…" } }, ...free.map((f) => ({ option: { value: f, textContent: target?.fields?.[f]?.label ?? f } }))]) } },
    ] } });
    return {
        fieldset: {
            key: `step-${i}`,
            className: `tx-card ${ctx.changedAt?.(`step:${i}`) ?? ""}`,
            children: [
                head,
                hint(`It finds the records of an object whose fields equal what you say (an input, a field of a record an input names, a route step's setting, or null for one left empty), that the person running it may read, in use, the oldest first. The steps after it read what it found as found.${st.as || "name"}.count and found.${st.as || "name"}.first.<field>; it may also change each.`),
                { div: { className: "ed-row", children: [
                    labelled("Finds records of", { select: { disabled: ro, onchange: (e) => ops.edit((b) => { b.steps[i] = { find: { object: e.target.value, where: {} }, as: b.steps[i].as ?? "found" }; }), children: noDefault(Object.entries(known.objects).map(([o, d]) => ({ option: { value: o, selected: o === find.object, textContent: d.label ?? o } }))) } }),
                    labelled("Named", { input: { type: "text", disabled: ro, value: st.as ?? "", placeholder: "holds", onchange: (e) => ops.set(`steps.${i}.as`, e.target.value.trim(), true) } }, "How the steps after it read it."),
                    labelled("At most", { input: { type: "number", min: 1, max: 100, disabled: ro, value: find.limit ?? 20, onchange: (e) => ops.edit((b) => { const v = Math.floor(Number(e.target.value)); if (!v || v === 20) delete b.steps[i].find.limit; else b.steps[i].find.limit = Math.max(1, Math.min(100, v)); }) } }, "records changed"),
                ] } },
                pairs("find.where", find.where, whereFree, '{"input": "lot"}', "Where"),
                target ? labelled("Then takes the action on each", { select: { disabled: ro, onchange: (e) => ops.edit((b) => { if (e.target.value) b.steps[i].action = e.target.value; else delete b.steps[i].action; }), children: noDefault([{ option: { value: "", textContent: "— none" } }, ...(target.actions ?? []).map((a) => ({ option: { value: a, selected: a === st.action, textContent: a } }))]) } }) : { span: {} },
                target ? pairs("set", st.set, unset, '{"input": "reason"}', "Sets on each") : { span: {} },
                labelled("Only when", condition(ctx, `steps.${i}.when`, st.when, (v) => ops.set(`steps.${i}.when`, v, true), "always")),
            ],
        },
    };
}

// A step of a kind a suite adds (§30.11): its settings, each a value or an expression; one whose
// suite is not installed is shown as it is, to be taken out or kept until the suite is back.
function suiteStepCard(ctx, st, i, count, known, move) {
    const { ops, ro } = ctx;
    const spec = known.suiteSteps?.[st.step] ?? null;
    const suite = String(st.step).split(".")[0];
    const keys = [...new Set([...Object.keys(spec?.config ?? {}), ...Object.keys(st).filter((k) => !["step", "when", "label"].includes(k))])];
    return {
        fieldset: {
            key: `step-${i}`,
            className: `tx-card ${ctx.changedAt?.(`step:${i}`) ?? ""}`,
            children: [
                { legend: { children: [
                    { strong: `Step ${i + 1}: ${spec?.label ?? st.step}` },
                    ro() || i === 0 ? { span: {} } : { button: { type: "button", className: "mini", title: "Earlier", "aria-label": "Earlier", children: [icon("arrowUp")], onclick: () => move(i, -1) } },
                    ro() || i === count - 1 ? { span: {} } : { button: { type: "button", className: "mini", title: "Later", "aria-label": "Later", children: [icon("arrowDown")], onclick: () => move(i, 1) } },
                    ro() ? { span: {} } : { button: { type: "button", className: "linkish", textContent: "remove", onclick: confirmRemove(ctx.api, `step ${i + 1}`, () => ops.edit((b) => { b.steps.splice(i, 1); }) )} },
                ] } },
                hint(spec
                    ? `A step of the ${suite} suite.${spec.irreversible ? " What it does cannot be taken back, so it comes last: it is done only once every other step held." : ""}`
                    : `This step needs the ${suite} suite, which is not installed here: the transaction cannot run until it is back.`),
                ...keys.map((k) => labelled(`${k}${(spec?.required ?? []).includes(k) ? " (needed)" : ""}`, exprInput(ctx, `steps.${i}.${k}`, st[k], (v) => ops.set(`steps.${i}.${k}`, v === undefined ? null : v, false), '{"input": "lot"}'))),
                labelled("Only when", condition(ctx, `steps.${i}.when`, st.when, (v) => ops.set(`steps.${i}.when`, v, true), "always")),
            ],
        },
    };
}

function stepsTab(ctx) {
    const { api, w, body, ops, ro } = ctx;
    const known = transactionKnown(api, w);
    const refs = Object.entries(body.inputs ?? {}).filter(([, s]) => s.type === "ref");
    const steps = body.steps ?? [];
    const move = (i, d) => ops.edit((b) => { const [x] = b.steps.splice(i, 1); b.steps.splice(i + d, 0, x); });
    return {
        div: {
            children: [
                hint(`Each step writes one record an input names, through that object's own state machine, policies, rule pipe and audit, as the person running it. The object's policies grant it only with "Only through transactions: ${ctx.name}" (Roles & policies), so its form never offers the same change on its own. The steps run in order, all or nothing.`),
                hint(EXAMPLES),
                ...steps.map((st, i) => {
                    if (st.step !== undefined) return suiteStepCard(ctx, st, i, steps.length, known, move);
                    if (st.create !== undefined) return createStepCard(ctx, st, i, steps.length, known, move);
                    if (st.find !== undefined) return findStepCard(ctx, st, i, steps.length, known, move);
                    const target = known.objects[body.inputs?.[st.on]?.to];
                    const fields = Object.keys(target?.fields ?? {});
                    const unset = fields.filter((f) => !Object.hasOwn(st.set ?? {}, f));
                    return {
                        fieldset: {
                            key: `step-${i}`,
                            className: `tx-card ${ctx.changedAt?.(`step:${i}`) ?? ""}`,
                            children: [
                                { legend: { children: [
                                    { strong: `Step ${i + 1}` },
                                    ro() || i === 0 ? { span: {} } : { button: { type: "button", className: "mini", title: "Earlier", "aria-label": "Earlier", children: [icon("arrowUp")], onclick: () => move(i, -1) } },
                                    ro() || i === steps.length - 1 ? { span: {} } : { button: { type: "button", className: "mini", title: "Later", "aria-label": "Later", children: [icon("arrowDown")], onclick: () => move(i, 1) } },
                                    ro() ? { span: {} } : { button: { type: "button", className: "linkish", textContent: "remove", onclick: confirmRemove(ctx.api, `step ${i + 1}`, () => ops.edit((b) => { b.steps.splice(i, 1); }) )} },
                                ] } },
                                { div: { className: "ed-row", children: [
                                    labelled("On the record in", { select: { disabled: ro, onchange: (e) => ops.edit((b) => { b.steps[i] = { on: e.target.value }; }), children: noDefault([{ option: { value: "", textContent: "—" } }, ...refs.map(([k, s]) => ({ option: { value: k, selected: st.on === k, textContent: `${s.label ?? k} (${known.objects[s.to]?.label ?? s.to})` } }))]) } }),
                                    labelled("then takes the action", { select: { disabled: () => ro() || !target, onchange: (e) => ops.edit((b) => { if (e.target.value) b.steps[i].action = e.target.value; else delete b.steps[i].action; }), children: noDefault([{ option: { value: "", textContent: "none (only sets fields)" } }, ...(target?.transitions ?? []).filter((t, k, all) => all.findIndex((x) => x.action === t.action) === k).map((t) => ({ option: { value: t.action, selected: st.action === t.action, textContent: `${t.label ?? t.action}: ${t.from.join(", ")} → ${t.to}` } }))]) } }),
                                ] } },
                                target ? {
                                    div: {
                                        className: "tx-sets",
                                        children: [
                                            { strong: { className: "small", textContent: "Sets" } },
                                            ...Object.entries(st.set ?? {}).map(([f, e]) => ({
                                                div: { key: f, className: "tx-set", children: [
                                                    { code: f }, { span: " = " },
                                                    exprInput(ctx, `steps.${i}.set.${f}`, e, (v) => ops.set(`steps.${i}.set.${f}`, v === undefined ? null : v, false), '{"input": "machine"}'),
                                                    ro() ? { span: {} } : { button: { type: "button", className: "mini", title: "Don't set it", "aria-label": "Don't set it", children: [icon("x")], onclick: () => ops.edit((b) => { delete b.steps[i].set[f]; if (!Object.keys(b.steps[i].set).length) delete b.steps[i].set; }) } },
                                                ] },
                                            })),
                                            ro() || !unset.length ? { span: {} } : { select: { className: "mini-select", onchange: (e) => { const f = e.target.value; if (!f) return; ops.edit((b) => { b.steps[i].set = { ...(b.steps[i].set ?? {}), [f]: Object.hasOwn(b.inputs ?? {}, f) ? { input: f } : null }; }); }, children: noDefault([{ option: { value: "", textContent: "+ set a field" } }, ...unset.map((f) => ({ option: { value: f, textContent: target.fields[f].label ?? f } }))]) } },
                                        ],
                                    },
                                } : { span: {} },
                                labelled("Only when", condition(ctx, `steps.${i}.when`, st.when, (v) => ops.set(`steps.${i}.when`, v, true), "always")),
                            ],
                        },
                    };
                }),
                ro() ? { span: {} } : { button: { type: "button", className: "btn", textContent: "Add step", disabled: !refs.length, title: refs.length ? "" : "Add a reference input first", onclick: () => ops.edit((b) => { (b.steps ??= []).push({ on: refs[0][0] }); }) } },
                // The step kinds the installed suites add (§30.11).
                ...(ro() ? [] : Object.entries(known.suiteSteps ?? {}).map(([kind, spec]) => ({ button: { key: `add-${kind}`, type: "button", className: "btn", textContent: `Add: ${spec.label ?? kind}`, onclick: () => ops.edit((b) => { (b.steps ??= []).push({ step: kind }); }) } }))),
                ro() ? { span: {} } : { button: { type: "button", className: "btn", textContent: "Add a step that creates a record", onclick: () => ops.edit((b) => { (b.steps ??= []).push({ create: Object.keys(known.objects)[0] ?? "", set: {} }); }) } },
                ro() ? { span: {} } : { button: { type: "button", className: "btn", textContent: "Add a step that finds records", onclick: () => ops.edit((b) => { (b.steps ??= []).push({ find: { object: Object.keys(known.objects)[0] ?? "", where: {} }, as: `found${(b.steps ?? []).filter((x) => x?.find).length || ""}` }); }) } },
            ],
        },
    };
}

function callersTab(ctx) {
    const { api, body, ops } = ctx;
    const home = api.peek("design.home") ?? {};
    const callers = body.callers ?? {};
    return {
        div: {
            children: [
                hint("Deny by default: nobody may run it until named here. They still need, on each object a step writes, a role whose policy grants that write through this transaction."),
                { h4: "Groups" },
                checks(ctx, (home.groups ?? []).map((g) => ({ value: g.id, label: g.name })), callers.groups, (v, on) => ops.edit((b) => { b.callers = { ...(b.callers ?? {}), groups: toggleIn(b.callers?.groups, v, on) }; })),
                { h4: "Users" },
                pickMany({ key: `callers-${ctx.name}`, options: (home.users ?? []).map((u) => ({ value: u.id, label: u.name, hint: u.id })), value: callers.users ?? [], readOnly: ctx.ro, placeholder: "Add a person…", onChange: (next) => ops.edit((b) => { b.callers = { ...(b.callers ?? {}), users: next }; }) }),
                // Routes that run it on their traveler as they move it on (§32.15: a route's every step).
                { h4: "Routes" },
                body.signature ? hint("It is signed by the person running it: no route runs it.") : (() => {
                    const routes = (home.flows ?? []).filter((f) => f.kind === "route").map((f) => ({ value: f.name, label: f.label ?? f.name }));
                    return routes.length
                        ? { div: { children: [hint("A route that runs it at every step (its At every step setting) acts as itself, with the roles its design gives it."), checks(ctx, routes, callers.flows, (v, on) => ops.edit((b) => { b.callers = { ...(b.callers ?? {}), flows: toggleIn(b.callers?.flows, v, on) }; if (!b.callers.flows.length) delete b.callers.flows; }))] } }
                        : hint("No route yet.");
                })(),
                // Services whose scripts run it as their own service role (§15.2): an ERP's lot start, a
                // scheduled pull. A signed transaction is a person's to run.
                { h4: "Services" },
                body.signature ? hint("It is signed by the person running it: no service runs it.") : (() => {
                    const drafted = api.peek(`${ctx.w}.sv`) ?? {};
                    const labels = new Map([...(callers.services ?? []).map((n) => [n, n]), ...(home.services ?? []).map((sv) => [sv.name, sv.label ?? sv.name]), ...Object.entries(drafted).map(([n, b]) => [n, b?.label ?? n])]);
                    const services = [...labels.keys()].sort((a, b) => String(labels.get(a)).localeCompare(String(labels.get(b))));
                    return services.length
                        ? { div: { children: [hint("Their scripts may run it with ctx.transactions.run, acting as their own service role: they need, as people do, a role whose policy grants each write through this transaction."), checks(ctx, services.map((v) => ({ value: v, label: labels.get(v) })), callers.services, (v, on) => ops.edit((b) => { const next = toggleIn(b.callers?.services, v, on); b.callers = { ...(b.callers ?? {}) }; if (next.length) b.callers.services = next; else delete b.callers.services; }))] } }
                        : hint("No service yet.");
                })(),
                // Outside systems (§25.7, docs/contracts/http-apis): an ERP or a cell controller runs it as its token's
                // person, who must be among the users or groups above. Never one a person signs.
                { h4: "The web" },
                body.signature ? hint("It is signed by the person running it: an outside system does not run it.") : { div: { className: "ed-web", children: [
                    labelled("Published over HTTP", check(ctx, "http.enabled", `outside systems run it: POST /svc/v1/${ctx.name}`), `With an integration user's token (scope transaction:run): its person must be among the users or groups above. A reference is sent as its record's id or its title (as a scanner reads it); POST /svc/v1/${ctx.name}/preview says what it would change, writing nothing.`),
                    ...(body.http?.enabled || body.deprecated ? [deprecation(ctx)] : []),
                ] } },
            ],
        },
    };
}

function stewardsTab(ctx) {
    const { api, body, ops } = ctx;
    const depts = api.peek("design.home.departments") ?? [];
    return {
        div: {
            children: [
                hint("Its stewards approve every change to it. A change to its steps or inputs is also approved by the stewards of each object, field and transition its steps write."),
                checks(ctx, depts.map((d) => ({ value: d.id, label: d.name })), body.stewards, (v, on) => ops.edit((b) => { b.stewards = toggleIn(b.stewards, v, on); })),
            ],
        },
    };
}

// Its scenarios (§5.11): kept with each of its versions, each run by the fitness test in a sandbox on
// fresh copies of real records (or records it gives). Made in the sandbox; read, opened, removed here.
function scenariosTab(ctx) {
    const { api, body, ops, ro, id, name } = ctx;
    const list = Array.isArray(body.scenarios) ? body.scenarios : [];
    const runs = (api.peek(`dc.${id}.fitness.checks`) ?? []).find((c) => c.id === "scenarios")?.runs ?? [];
    const sandbox = (sc) => `/design/c/${id}/sandbox?tx=${encodeURIComponent(name)}${sc ? `&scenario=${encodeURIComponent(sc.name)}` : ""}`;
    // Names as people read them: a transaction's label, an object's.
    const txLabel = (n) => (n === name ? body.label : (api.peek("design.home.transactions") ?? []).find((t) => t.name === n)?.label) ?? n;
    const objLabel = (o) => (api.peek("design.home.objects") ?? []).find((x) => x.object === o)?.label ?? o;
    const describe = (st) => { const d = st?.do ?? {}; return (d.transaction && txLabel(d.transaction)) ?? (d.action ? `${d.action} ${d.record ?? ""}` : d.update !== undefined ? `edit ${d.update}` : d.create ? `make ${d.create}` : d.service ? `call ${d.service}` : d.screen ? `open ${d.screen}` : "?"); };
    return {
        div: {
            children: [
                hint("Its evidence: each scenario starts from records picked from live (or given), runs steps as someone, and says what it expects. The fitness test runs them all in a sandbox, on fresh copies; a new or changed transaction without one, or with one that fails, is not submitted. They are kept with each version."),
                String(id).startsWith("view-") ? { span: {} } : { Link: { to: sandbox(null), className: "btn primary icon-text", children: [icon("play"), { span: "Make one in the sandbox" }] } },
                list.length ? {
                    ul: {
                        className: "scenario-list",
                        children: list.map((sc, i) => {
                            const last = runs.find((r) => r.transaction === name && r.name === sc?.name);
                            return {
                                li: {
                                    key: `${i}-${sc?.name}`, className: "panel",
                                    children: [
                                        { div: { className: "sbx-step-head", children: [
                                            { strong: sc?.name ?? "(unnamed)" },
                                            last ? { span: { className: `badge ${last.passed ? "tone-ok" : "tone-danger"}`, textContent: last.passed ? "passed" : "failed" } } : { span: { className: "muted small", textContent: " not run yet" } },
                                            { span: { className: "spacer" } },
                                            String(id).startsWith("view-") ? { span: {} } : { Link: { to: sandbox(sc), className: "small", textContent: "open in the sandbox" } },
                                            ro() ? { span: {} } : { button: { type: "button", className: "linkish small", textContent: "remove", onclick: confirmRemove(ctx.api, "this scenario", () => ops.edit((b) => { b.scenarios = (b.scenarios ?? []).filter((_, k) => k !== i); if (!b.scenarios.length) delete b.scenarios; }) )} },
                                        ] } },
                                        { div: { className: "small muted", textContent: `Records: ${Object.entries(sc?.records ?? {}).map(([k, r]) => `@${k} (${objLabel(r.object)}${r.data !== undefined ? ", given" : ""})`).join(", ") || "none"}` } },
                                        { ol: { className: "small", children: (sc?.steps ?? []).map((st, j) => ({ li: { key: j, textContent: `${describe(st)}${st.as ? `, as ${st.as}` : ""} → ${st.expect?.ok === false ? `refused${st.expect.error ? ` ("${st.expect.error}")` : ""}` : "runs"}${st.expect?.states ? `; ${Object.entries(st.expect.states).map(([k, v]) => `@${k} ${String(v).replace(/_/g, " ")}`).join(", ")}` : ""}` } })) } },
                                        last && !last.passed ? { p: { className: "error small", textContent: last.detail } } : { span: {} },
                                    ],
                                },
                            };
                        }),
                    },
                } : { p: { className: "muted", textContent: "None yet." } },
            ],
        },
    };
}

function tryTab(ctx) {
    const published = (ctx.api.peek("design.home.transactions") ?? []).some((t) => t.name === ctx.name);
    return {
        div: {
            children: published
                ? [hint("Its screen runs the published version, as you: your callers' rights, the checks, and each step through the objects' policies and rule pipes. Check shows what would change without changing anything. Your draft is not what runs."), { Link: { to: `/t/${ctx.name}`, className: "btn primary", textContent: "Open its screen" } }]
                : [hint("Try it once its change is executed: only a published transaction runs. Its form is on the Layout tab.")],
        },
    };
}

// `layoutTab` is the object editor's (designer.js): the same drag-and-drop layout, over the inputs.
export function registerTransactionEditor(juris, { layoutTab }) {
    juris.registerComponent("TransactionEditor", ({ id, editable, pane = 0, name, head }, api) => {
        const w = W(id);
        const ops = elementOps(api, id, "transaction", name);
        const view = () => {
            const v = api.getState(`${w}.panes.${pane}.view`, "general");
            return TRANSACTION_VIEWS.some(([key]) => key === v) ? v : "general";
        };
        const ro = () => !api.prop(editable);
        // The layout editor edits { label, fields, form }: here the inputs are its fields.
        const asForm = (t) => ({ label: t?.label, fields: t?.inputs ?? {}, form: t?.form });
        const layoutOps = {
            ...ops,
            edit: (fn) => ops.edit((t) => {
                const v = asForm(t);
                v.fields = t.inputs ?? (t.inputs = {});
                fn(v);
                if (v.form === undefined) delete t.form; else t.form = v.form;
            }),
        };
        return {
            div: {
                className: "editor",
                children: [
                    {
                        div: {
                            className: "editor-head",
                            children: [
                                head ?? { span: {} },
                                { nav: { className: "subtabs", children: TRANSACTION_VIEWS.map(([key, label, glyph]) => ({ button: { key, type: "button", className: "subtab", classList: { active: () => view() === key }, onclick: () => api.setValue(`${w}.panes.${pane}.view`, key), children: [glyph ? icon(glyph) : { span: {} }, { span: label }, () => {
                                    api.getState(`${w}.vrev`);
                                    api.getState(`dc.${id}.updated_at`);
                                    const all = changesOf(api, id, "transaction", name);
                                    const n = key === "changes" ? all.length : countByTab(all)[key] ?? 0;
                                    return n ? { span: { className: "tab-diff", title: `${n} change(s) from the published version`, textContent: String(n) } } : { span: {} };
                                }] } })) } },
                            ],
                        },
                    },
                    () => {
                        api.getState(`${w}.rev`);
                        const body = api.peek(ops.root);
                        if (!body) return { p: { className: "muted", textContent: "Loading…" } };
                        const live = api.peek(`dc.${id}.live.transactions.${name}`) ?? null;
                        const diff = statusMaps(live ? asForm(live) : null, asForm(body));
                        const changed = new Set(changesOf(api, id, "transaction", name).map((c) => `${c.element}:${c.change}`));
                        const changedAt = (element) => (changed.has(`${element}:added`) ? "diff-added" : changed.has(`${element}:changed`) ? "diff-changed" : "");
                        const ctx = { api, w, ops, ro, body, id, kind: "transaction", name, root: ops.root, diff, changedAt };
                        switch (view()) {
                            case "copilot": return { CopilotPanel: { key: `copilot-${id}`, id } };
                            case "changes": return { ChangesView: { key: `changes-tx-${name}`, id, kind: "transaction", name, onOpen: (tab) => api.setValue(`${w}.panes.${pane}.view`, tab) } };
                            case "inputs": return inputsTab(ctx);
                            case "layout": return layoutTab({ ...ctx, body: asForm(body), ops: layoutOps, noList: true });
                            case "checks": return checksTab(ctx);
                            case "steps": return stepsTab(ctx);
                            case "callers": return callersTab(ctx);
                            case "try": return tryTab(ctx);
                            case "scenarios": return scenariosTab(ctx);
                            case "stewards": return stewardsTab(ctx);
                            case "json": return jsonOf(ctx);
                            default: return generalTab(ctx);
                        }
                    },
                ],
            },
        };
    });
}

// Whether its page may fill the window (MAXIMIZE, §25.1); the screen editor offers the same.
// Its input flow (§32.13): how it is filled from the keyboard. Input flows are drawn in the Flow designer
// (a flow template of kind input) and named here; none: Enter from input to input in the form's order.
export const inputFlowSelect = ({ api, w, ops, ro, body }) => {
    const home = api.peek("design.home") ?? {};
    const flows = [...new Set([...(home.flows ?? []).filter((f) => f.kind === "input").map((f) => f.name), ...Object.entries(api.peek(`${w}.fl`) ?? {}).filter(([, b]) => b?.kind === "input").map(([n]) => n), ...(body.inputFlow ? [body.inputFlow] : [])])].sort();
    return {
        select: {
            disabled: ro,
            onchange: (e) => ops.edit((b) => { if (e.target.value) b.inputFlow = e.target.value; else delete b.inputFlow; }),
            children: noDefault([["", "none: Enter from input to input, as the form is laid out"], ...flows.map((f) => [f, (home.flows ?? []).find((x) => x.name === f)?.label ?? f])].map(([v, l]) => ({ option: { value: v, selected: (body.inputFlow ?? "") === v, textContent: l } }))),
        },
    };
};

export const maximizeSelect = ({ ops, ro, body }) => ({
    select: {
        disabled: ro,
        onchange: (e) => ops.edit((b) => { if (e.target.value) b.maximize = e.target.value; else delete b.maximize; }),
        children: noDefault([["", "no (the usual page)"], ["toggle", "on request: a Maximize button"], ["start", "always at first: it opens maximized"]].map(([v, l]) => ({ option: { value: v, selected: (body.maximize ?? "") === v, textContent: l } }))),
    },
});

export const TRANSACTION_TEMPLATE = (name, stewards) => ({ name, label: name.replace(/_/g, " "), description: "", inputs: {}, require: [], steps: [], confirm: true, callers: { users: [], groups: [] }, stewards });
