// The designer (DESIGN.md §10.5): the same shell, the Design group of the navigator. Every edit is a
// change request, and a change goes design → review → approval → execution (§5). Validation, the
// footprint and the approving departments are computed as the designer types (definition.js), and
// again by the server, which decides.
import { validateDefinition, validateScript, footprint, scriptFootprint, routeOf, applyStanding, renameField, fieldNameProblem, FIELD_TYPES, IDENTIFIER, SERVICE_TEMPLATE, FLOW_TEMPLATE, FLOW_ROLES, COPYABLE, copyDesign, copyScript } from "./definition.js";
import { richText } from "./rich-text.js";
import { noDefault } from "./select.js";
import { holderWords } from "./builtins.js";
import { registerIntegrationEditor, integrationProblems, integrationElements, dryRunError } from "./integration-editor.js";
import { registerIntegrationMonitor } from "./integration-monitor.js";
import { normalizeForm, storeForm, widgetsFor, WIDGET_LABELS, minWidth } from "./form-layout.js";
import { changesOf, countByTab, lineDiff, textOf, statusMaps, OBJECT_TABS, SERVICE_TABS, CONNECTION_TABS, TRANSACTION_TABS, SCREEN_TABS, LAYOUT_TABS, ELEMENT_TABS, ORG_TABS } from "./compare.js";
import { registerOrganizationEditor, organizationProblems, organizationElements } from "./organization-editor.js";
import { registerScreenEditor, screenProblems, screenElements, SCREEN_TEMPLATE } from "./screen-editor.js";
import { registerFlowEditor, flowProblems, flowElements } from "./flow-editor.js";
import { registerTestSandbox } from "./test-sandbox.js";
import { registerRollback } from "./rollback.js";
import { policyMatrix, cellWords, cellWhy, policiesFor, quickTarget, nextGrant, setGrant } from "./policy-matrix.js";
import { registerLayoutEditor, layoutProblemsOf, layoutElements } from "./layout-editor.js";
import { registerSuiteElementEditor, elementProblemsOf, suiteElementsOf } from "./suite-element-editor.js";
import { LAYOUT_TEMPLATE } from "./report.js";
import { registerTransactionEditor, transactionProblems, transactionElements, TRANSACTION_TEMPLATE } from "./transaction-editor.js";
import { registerCodeEditor, callableProblems } from "./code-editor.js";
import { titleTab } from "./shell.js";
import { W, clone, csv, fromCsv, text, listInput, labelled, check, compileInPage, draftDefinitions, openObject } from "./editor-kit.js";
import { confirmDialog, askDialog } from "./dialog.js";
import { signDialog } from "./sign.js";
import { registerPick, pickMany } from "./pick.js";
import { suiteDesigns, suiteChecks } from "./suite-registry.js";
import { plant } from "./format.js";
import { icon, withIcon } from "./icons.js";
import { TONES, stateBadgeClass } from "./theme.js";
import { fileChips, pasteFiles } from "./attach.js";

const hint = (words) => ({ p: { className: "muted small", textContent: words } });
// A mark for an element that differs from the published version (compare.js).
const diffPill = (status) => (status ? { span: { className: `diff-pill ${status}`, textContent: status === "added" ? "new" : status } } : { span: {} });


const STEPS = ["design", "review", "approval", "executed"];
const SCRIPT_TEMPLATE = (name) => `// What this rule does, in one line.
export default function ${name}(ctx) {
  if (ctx.event.kind === "change" && !ctx.event.changed.includes("some_field")) return ctx;
  // throw Object.assign(new Error("Say what is wrong."), { field: "some_field" });
  return ctx;
}`;

// What a change's review would leave unsignable, in words (§5.6), from design.change's `reviewing`:
// { fine, strands: [{ reviewer, where }], empty }. Shown before submission, and to a reviewer before
// they pass it; `error` when it blocks (nobody could review it, or this reviewer could not).
// "5 min ago", for when a change last moved.
const ago = (at) => {
    if (!at) return "";
    const sec = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
    return sec < 90 ? "just now" : sec < 5400 ? `${Math.round(sec / 60)} min ago` : sec < 129600 ? `${Math.round(sec / 3600)} h ago` : `${Math.round(sec / 86400)} d ago`;
};

export function reviewWarnings({ fine, strands, empty }, { author, me, reviewer = false }) {
    const out = [];
    const who = (u) => (u === me ? "you" : u);
    const either = (list) => { const l = list.map(who); return l.length > 1 ? `${l.slice(0, -1).join(", ")} or ${l.at(-1)}` : l.join(""); };
    if (empty.length) out.push({ key: "rv-empty", error: true, text: `Nobody can approve it for ${empty.join(", ")}: ${empty.length > 1 ? "they have" : "it has"} no approvers. Add them in People & departments before submitting.` });
    else if (!fine.length) out.push({ key: "rv-none", error: true, text: `Nobody could review it and still leave someone to approve it for ${[...new Set(strands.flatMap((x) => x.where))].join(", ")}: its approvers there are the author and the reviewer. Add approvers there (People & departments) before submitting.` });
    else {
        // Grouped by what each would strand: "If eli reviews it, nobody can approve it for engineering".
        const groups = new Map();
        for (const x of strands) groups.set(x.where.join(", "), [...(groups.get(x.where.join(", ")) ?? []), x.reviewer]);
        for (const [where, users] of groups) {
            const self = reviewer && users.includes(me);
            const approvers = `${author === me ? "you" : "the author"} and ${self ? "you" : either(users)}`;
            out.push({ key: `rv-${where}`, error: self, text: `If ${self ? "you review" : `${either(users)} ${users.length > 1 ? "review" : "reviews"}`} it, nobody can approve it for ${where}: its approvers there are ${approvers}. Ask ${either(fine)} to review it${self ? " instead" : ""}.` });
        }
    }
    return out;
}

export function registerDesigner(juris, { args }) {
    registerIntegrationEditor(juris);
    registerTransactionEditor(juris, { layoutTab });
    registerScreenEditor(juris);
    registerFlowEditor(juris);
    registerTestSandbox(juris);
    registerRollback(juris);
    registerLayoutEditor(juris);
    registerSuiteElementEditor(juris);
    registerOrganizationEditor(juris, { args });
    registerPick(juris);

    // Who designs a change (§5.3): its author, and the co-designers the author names, who may edit and
    // submit it too (and, like the author, neither review nor approve it). Anyone else reads the draft.
    juris.registerComponent("ChangeDesigners", ({ id }, api) => {
        const C = `dc.${id}`;
        // The list as last asked for, until the change follows: a second pick builds on the first.
        const [pending, setPending] = api.useState("pending", null);
        const name = (next) => {
            setPending(next);
            api.call("design.codesigners", { id, users: next }).catch((e) => api.setValue(`${W(id)}.error`, e.message)).finally(() => setPending(null));
        };
        return () => {
            const change = api.getState(C, null);
            if (!change || change.state !== "design") return { span: {} };
            const author = change.author;
            const co = change.co_designers ?? [];
            // Who designed it and is no longer named: they still neither review nor approve it.
            const former = (change.contributors ?? []).filter((u) => u !== author && !co.includes(u));
            const me = api.getState("me.id", null);
            const mine = author === me || co.includes(me);
            const designers = (api.getState("design.home.designers", []) ?? []).filter((d) => d.id !== author);
            return {
                div: {
                    className: "change-designers",
                    children: [
                        { div: { className: "small", children: [{ strong: "Designers " }, { span: { className: "muted", textContent: `${author} (author)${co.length ? `, ${co.join(", ")}` : ""}${former.length ? `; also worked on it: ${former.join(", ")} (they neither review nor approve it)` : ""}` } }] } },
                        change.can?.codesigners
                            ? pickMany({ key: `codesigners-${id}`, options: designers.map((d) => ({ value: d.id, label: d.name, hint: d.id })), value: pending() ?? co, placeholder: "Add a co-designer…", onChange: name })
                            : { span: {} },
                        !mine ? { p: { className: "muted small change-readonly", children: [icon("lock"), { span: `Read only: this draft is ${author}'s${co.length ? ` and ${co.join(", ")}'s` : ""}. Ask ${author} to add you as a co-designer to edit it.` }] } } : { span: {} },
                    ],
                },
            };
        };
    });

    // A script a suite's part of the design names (§29.4), edited in the suite's tab: its source, the
    // compile check, a dry run on the suite's sample input, and its test cases (the fitness test runs
    // them: input in, output or refusal out). Opened from its published version, or from `template`.
    juris.registerComponent("ScriptPanel", ({ id, name, readOnly, example = {}, template = null }, api) => {
        const w = W(id);
        const ops = draftOps(api, id);
        const ro = () => Boolean(typeof readOnly === "function" ? readOnly() : readOnly);
        if (!api.isServer && api.peek(`${w}.s.${name}`) === undefined && api.peek(`${w}.viewing`)?.name !== name) {
            api.call("design.script", { name }).then((live) => {
                if (api.peek(`${w}.t.${name}`) === undefined) api.setValue(`${w}.t.${name}`, live?.tests ?? []);
                if (live) api.setValue(`${w}.viewing`, { name, source: live.source });
                else ops.setScript(name, template ?? SCRIPT_TEMPLATE(name), true);
                api.setValue(`${w}.rev`, (api.peek(`${w}.rev`) ?? 0) + 1);
            }, () => {});
        }
        const sourceOf = () => api.getState(`${w}.s.${name}`, undefined) ?? (api.getState(`${w}.viewing.name`, null) === name ? api.getState(`${w}.viewing.source`, "") : "");
        return {
            div: {
                className: "script-editor",
                children: [
                    { div: { className: "script-head", children: [{ strong: `${name}.js` }, { span: { className: "muted small", textContent: () => (api.getState(`${w}.s.${name}`, undefined) !== undefined ? " · edited in this change" : " · published version (edit to change it in this change)") } }] } },
                    { CodeEditor: { key: `ce-${name}`, mode: "js", rows: 14, label: `${name}.js`, readOnly: ro, value: sourceOf, onInput: (text) => ops.setScript(name, text) } },
                    () => {
                        const problems = validateScript(name, sourceOf(), compileInPage);
                        return { p: { className: problems.length ? "error small" : "notice small", textContent: problems.length ? problems[0].message : "Compiles; the name rule holds." } };
                    },
                    { DryRun: { key: `dry-${name}`, id, kind: "plain", name, example } },
                    { TestCases: { key: `cases-${name}`, id, name, readOnly: ro } },
                ],
            },
        };
    });
    registerIntegrationMonitor(juris);
    registerCodeEditor(juris);
    // ---- the designer's home ----
    // What is in progress comes first (the changes open now, the viewer's own first, one click away);
    // below it the designs, one tab per kind, each with its search, its New and each design's open change.
    juris.registerComponent("DesignHome", (props, api) => {
        const as = api.getState("me.id", null, { track: false });
        api.live("design.home", "design.home", args.design(as));
        if (!api.isServer) titleTab(api, "/design", "Designer");
        const [form, setForm] = api.useState("new", { object: "", label: "", from: "" });
        const [integ, setInteg] = api.useState("newInt", { kind: "", name: "", label: "", from: "" });
        const [error, setError] = api.useState("error", null);
        // `from`: a new one started as a copy of a live one of its kind, all of it under its new name.
        const start = ({ from, ...payload }) => { setError(null); return api.call("design.start", { ...payload, ...(from ? { from } : {}) }).then(
            ({ id }) => api.navigate(`/design/c/${id}`),
            (e) => setError(e.message),
        ); };
        // Beside a New form: blank, or a copy of a live one of its kind (one stable select, its options live).
        const copyOf = (kind, value, set) => ({ select: { title: `Start it blank, or as a copy of a live ${kind}`, value, onchange: (e) => set(e.target.value), children: noDefault(() => [
            { option: { value: "", textContent: "blank" } },
            ...(api.getState(`design.home.${kind === "object" ? "objects" : `${kind}s`}`, []) ?? []).map((x) => ({ option: { key: x.object ?? x.name, value: x.object ?? x.name, textContent: `a copy of ${x.label ?? x.object ?? x.name}` } })),
        ]) } });
        const failed = { span: { className: "error", textContent: () => error() ?? "" } };
        // A row's Copy: the New form above takes "a copy of" it, and the cursor waits in its name box.
        const copyRow = (kind, name) => {
            api.batch(() => {
                setError(null);
                if (kind === "object") setForm({ object: "", label: "", from: name });
                else if (kind === "service" || kind === "connection") setInteg({ kind, name: "", label: "", from: name });
                else api.setValue(`design.${{ transaction: "newTx", screen: "newScreen", flow: "newFlow", layout: "newLayout" }[kind]}`, { name: "", label: "", from: name });
            });
            if (typeof document === "undefined") return;
            setTimeout(() => {
                const input = [...document.querySelectorAll(".new-object input")].find((x) => x.offsetParent);
                input?.scrollIntoView({ behavior: "smooth", block: "center" });
                input?.focus();
            }, 0);
        };
        const copyButton = (kind, name) => (isDesigner() ? { button: { type: "button", className: "btn ghost", title: `Start a new ${kind} as a copy of this one`, textContent: "Copy", onclick: () => copyRow(kind, name) } } : { span: {} });
        const isDesigner = () => api.getState("design.home.me.roles", []).includes("designer");
        // The tab, kept while the person moves around (ui.* is the page's own state).
        // The open tab: the one picked here, else the one the address names (/design?tab=elements), else Objects.
        const tab = () => api.getState("ui.designTab", null) ?? (/^[a-z]{1,20}$/.test(api.getState("$route.query.tab", "") ?? "") ? api.getState("$route.query.tab") : "objects");
        const setTab = (t) => api.setValue("ui.designTab", t);
        const q = () => String(api.getState("ui.designQ", "") ?? "").trim().toLowerCase();
        const hit = (...texts) => !q() || texts.some((t) => String(t ?? "").toLowerCase().includes(q()));
        const OPEN = ["design", "review", "approval"];
        const openChanges = () => (api.getState("design.home.changes", []) ?? []).filter((c) => OPEN.includes(c.state));
        const touches = (c) => [...c.objects, ...c.transactions.map((n) => `${n} (transaction)`), ...c.screens.map((n) => `${n} (screen)`), ...(c.flows ?? []).map((n) => `${n} (flow)`), ...(c.layouts ?? []).map((n) => `${n} (report layout)`), ...(c.elements ?? []).map((n) => `${n} (design element)`), ...c.services.map((n) => `${n} (service)`), ...c.connections.map((n) => `${n} (connection)`), ...(c.organization ? ["people & departments"] : []), ...Object.values(c.retire ?? {}).flat().map((n) => `retire ${n}`)];
        const TABS = [
            ["objects", "Objects", () => (api.getState("design.home.objects", []) ?? []).length, (c) => c.objects.length > 0 || c.scripts.length > 0],
            ["transactions", "Transactions", () => (api.getState("design.home.transactions", []) ?? []).length, (c) => c.transactions.length > 0],
            ["screens", "Screens", () => (api.getState("design.home.screens", []) ?? []).length, (c) => c.screens.length > 0],
            ["flows", "Flows", () => (api.getState("design.home.flows", []) ?? []).length, (c) => (c.flows ?? []).length > 0],
            ["layouts", "Report layouts", () => (api.getState("design.home.layouts", []) ?? []).length, (c) => (c.layouts ?? []).length > 0],
            // Design elements of the suites' own kinds (§30.11): shown once a suite adds a kind, or one is published.
            ["elements", "From suites", () => (api.getState("design.home.elements", []) ?? []).length, (c) => (c.elements ?? []).length > 0],
            ["integration", "Services & connections", () => (api.getState("design.home.services", []) ?? []).length + (api.getState("design.home.connections", []) ?? []).length, (c) => c.services.length + c.connections.length > 0],
            ["people", "People & departments", () => Object.keys(api.getState("design.home.organization.departments", {}) ?? {}).length, (c) => c.organization],
            ["test", "Test sandbox", () => (api.getState("design.home.changes", []) ?? []).filter((c) => c.test && OPEN.includes(c.state)).length, () => false],
            ["changes", "Changes", () => openChanges().length, () => false],
        ];
        // A search over the tab's designs (name or label).
        const searchBox = (placeholder) => ({ input: { type: "search", className: "design-search", placeholder, "aria-label": placeholder, value: () => api.getState("ui.designQ", "") ?? "", oninput: (e) => api.setValue("ui.designQ", e.target.value) } });

        const inProgress = () => {
            const me = api.getState("me.id", null);
            const ours = (c) => c.author === me || (c.co_designers ?? []).includes(me);
            const list = openChanges().sort((a, b) => Number(ours(b)) - Number(ours(a)) || String(b.updated_at).localeCompare(String(a.updated_at)));
            if (!list.length) return { span: {} };
            const shown = list.slice(0, 6);
            return {
                section: {
                    className: "in-progress",
                    children: [
                        { div: { className: "in-progress-head", children: [{ strong: "In progress" }, { span: { className: "muted small", textContent: ` ${list.length} open change(s), yours first` } }, list.length > shown.length ? { button: { type: "button", className: "linkish small", children: [{ span: `All ${list.length}` }, icon("arrowRight")], onclick: () => setTab("changes") } } : { span: {} }] } },
                        {
                            div: {
                                className: "change-cards",
                                children: shown.map((c) => ({
                                    Link: {
                                        key: c.id, to: `/design/c/${c.id}`, className: `change-card${ours(c) ? " mine" : ""}`,
                                        children: [
                                            { div: { className: "change-card-top", children: [{ span: { className: `badge s-${c.state}`, textContent: c.state } }, { span: { className: "muted small", textContent: ago(c.updated_at) } }] } },
                                            { div: { className: "change-card-title", textContent: c.title } },
                                            { div: { className: "muted small change-card-what", textContent: touches(c).join(", ") || "—" } },
                                            { div: { className: "muted small", textContent: c.author === me ? "yours" : (c.co_designers ?? []).includes(me) ? `${c.author}'s, with you` : `by ${c.author}` } },
                                        ],
                                    },
                                })),
                            },
                        },
                    ],
                },
            };
        };

        // Designs the installed suites bring (§29.6): what in each is new or differs from what is live,
        // started as one change request by a designer; nothing goes live but through approval.
        // What the last pack action said: { error, text }.
        const [packNote, setPackNote] = api.useState("packNote", null);
        const setPackError = (text) => setPackNote(text ? { error: true, text } : null);
        const fromPack = (suite) => api.call("design.fromPack", { suite }).then(({ id }) => api.navigate(`/design/c/${id}`), (e) => setPackError(e.message));
        // Its sample records, once its designs are live: through the record services, as the person.
        const loadSamples = (suite) => { setPackError(null); api.call("design.samples", { suite }).then((r) => setPackNote({ error: false, text: `${r.made} sample record(s) loaded${r.there ? `, ${r.there} there already` : ""}${r.waiting.length ? `, ${r.waiting.length} waiting for approval` : ""}.` }), (e) => setPackError(e.message)); };
        const packsPanel = () => {
            const packs = api.getState("design.home.packs", []) ?? [];
            if (!packs.length) return { span: {} };
            return {
                section: {
                    className: "in-progress packs",
                    children: [
                        { div: { className: "in-progress-head", children: [{ strong: "From the suites" }, { span: { className: "muted small", textContent: " designs an installed suite brings, to start a change from" } }] } },
                        {
                            div: {
                                className: "change-cards",
                                children: packs.map((p) => ({
                                    div: {
                                        key: p.suite, className: "change-card pack-card",
                                        children: [
                                            { div: { className: "change-card-top", children: [{ span: { className: "badge", textContent: p.version } }, { span: { className: "muted small", textContent: p.from } }] } },
                                            { div: { className: "change-card-title", textContent: p.label } },
                                            { div: { className: "muted small", textContent: [p.counts.new ? `${p.counts.new} new` : "", p.counts.changed ? `${p.counts.changed} changed` : "", p.counts.same ? `${p.counts.same} live already` : "", p.roles ? `${p.roles} role(s) to give` : "", p.samples ? `${p.samples} sample records` : ""].filter(Boolean).join(" · ") } },
                                            p.open.length
                                                ? { Link: { to: `/design/c/${p.open[0].id}`, className: "small", textContent: `Open in "${p.open[0].title}" (${p.open[0].state})` } }
                                                : !(p.counts.new + p.counts.changed + p.roles) ? (p.samples ? { button: { type: "button", className: "btn small", textContent: "Load its sample records", title: "Created through the record services, as you: your roles decide what you may create.", onclick: () => loadSamples(p.suite) } } : { span: { className: "muted small", textContent: "All of it is live." } })
                                                : isDesigner() ? { button: { type: "button", className: "btn small", textContent: "Start a change from it", title: p.description, onclick: () => fromPack(p.suite) } } : { span: { className: "muted small", textContent: "A designer starts a change from it." } },
                                        ],
                                    },
                                })),
                            },
                        },
                        { p: { className: () => (packNote()?.error ? "field-error" : "muted small"), textContent: () => packNote()?.text ?? "" } },
                    ],
                },
            };
        };

        const panels = {
            objects: () => ({ div: { children: [
                () => (isDesigner() ? {
                        div: {
                            className: "new-object",
                            children: [
                                { strong: "New object" },
                                { input: { placeholder: "name (e.g. inspection)", value: () => form().object, oninput: (e) => setForm({ ...form(), object: e.target.value.trim().toLowerCase() }) } },
                                { input: { placeholder: "label (e.g. Inspection)", value: () => form().label, oninput: (e) => setForm({ ...form(), label: e.target.value }) } },
                                copyOf("object", () => form().from, (v) => setForm({ ...form(), from: v })),
                                { button: { type: "button", className: "btn primary", textContent: "Start design", disabled: () => !IDENTIFIER.test(form().object), onclick: () => start(form()) } },
                                failed,
                            ],
                        },
                    } : { p: { className: "muted", textContent: "You review and approve changes here; designing is for designers." } }),
                searchBox("Find an object"),
                    () => ({
                        table: {
                            className: "grid",
                            children: [
                                { thead: { children: [{ tr: { children: [{ th: "Object" }, { th: "Area" }, { th: "Version" }, { th: "Open change" }, { th: "" }] } }] } },
                                {
                                    tbody: {
                                        children: (api.getState("design.home.objects", []) ?? []).filter((o) => hit(o.object, o.label, o.area)).map((o) => ({
                                            tr: {
                                                key: o.object,
                                                children: [
                                                    { td: { children: [{ strong: o.label }, { span: { className: "muted small", textContent: ` ${o.object}` } }] } },
                                                    { td: o.area },
                                                    { td: `v${o.version}` },
                                                    { td: { children: o.open.length ? [{ Link: { to: `/design/c/${o.open[0]}`, textContent: "open change" } }] : [{ span: { className: "muted", textContent: "—" } }] } },
                                                    { td: { className: "row-buttons", children: [{ Link: { to: `/design/view/object/${o.object}`, className: "btn ghost", textContent: "View" } }, isDesigner() && !o.open.length ? { button: { type: "button", className: "btn", textContent: "Change", onclick: () => start({ object: o.object }) } } : { span: {} }, copyButton("object", o.object)] } },
                                                ],
                                            },
                                        })),
                                    },
                                },
                            ],
                        },
                    }),
            ].filter(Boolean) } }),
            integration: () => ({ div: { children: [
                    { p: { className: "muted small", textContent: "Web services outside systems call, services a record event sets off, and the outside systems they reach. Each is designed, reviewed and approved like an object, and live the moment its change executes." } },
                    () => (isDesigner() ? {
                        div: {
                            className: "new-object",
                            children: [
                                { select: { onchange: (e) => setInteg({ ...integ(), kind: e.target.value, from: "" }), children: noDefault([["service", "New service"], ["connection", "New connection"]].map(([v, l]) => ({ option: { key: v, value: v, selected: () => integ().kind === v, textContent: l } })), "new service or connection…") } },
                                { input: { placeholder: () => (integ().kind === "connection" ? "name (e.g. erp)" : "name (e.g. erp_work_order_in)"), value: () => integ().name, oninput: (e) => setInteg({ ...integ(), name: e.target.value.trim().toLowerCase() }) } },
                                { input: { placeholder: "label", value: () => integ().label, oninput: (e) => setInteg({ ...integ(), label: e.target.value }) } },
                                () => (integ().kind ? copyOf(integ().kind, () => integ().from, (v) => setInteg({ ...integ(), from: v })) : { span: {} }),
                                { button: { type: "button", className: "btn primary", textContent: "Start design", disabled: () => !integ().kind || !IDENTIFIER.test(integ().name), onclick: () => start({ [integ().kind]: integ().name, label: integ().label, from: integ().from }) } },
                                failed,
                            ],
                        },
                    } : { span: {} }),
                    () => {
                        const services = (api.getState("design.home.services", []) ?? []).filter((x) => hit(x.name, x.label));
                        const connections = (api.getState("design.home.connections", []) ?? []).filter((x) => hit(x.name, x.label));
                        if (!services.length && !connections.length) return { p: { className: "muted small", textContent: "None yet." } };
                        const row = (kind, key, label, detail, version, open) => ({
                            tr: {
                                key: `${kind}-${key}`,
                                children: [
                                    { td: { children: [{ strong: label }, { span: { className: "muted small", textContent: ` ${kind} · ${key}` } }] } },
                                    { td: detail },
                                    { td: `v${version}` },
                                    { td: { children: open.length ? [{ Link: { to: `/design/c/${open[0]}`, textContent: "open change" } }] : [{ span: { className: "muted", textContent: "—" } }] } },
                                    { td: { className: "row-buttons", children: [{ Link: { to: `/design/view/${kind}/${key}`, className: "btn ghost", textContent: "View" } }, isDesigner() && !open.length ? { button: { type: "button", className: "btn", textContent: "Change", onclick: () => start({ [kind]: key }) } } : { span: {} }, copyButton(kind, key)] } },
                                ],
                            },
                        });
                        return {
                            table: {
                                className: "grid",
                                children: [
                                    { thead: { children: [{ tr: { children: [{ th: "Service / connection" }, { th: "Set off by / at" }, { th: "Version" }, { th: "Open change" }, { th: "" }] } }] } },
                                    { tbody: { children: [
                                        ...services.map((sv) => row("service", sv.name, sv.label, [sv.http ? `POST /svc/v1/${sv.name}` : "", ...sv.on].filter(Boolean).join(" · ") || "—", sv.version, sv.open)),
                                        ...connections.map((c) => row("connection", c.name, c.label, c.baseUrl, c.version, c.open)),
                                    ] } },
                                ],
                            },
                        };
                    },
            ] } }),
            people: () => ({ div: { children: [
                    () => {
                        const org = api.getState("design.home.organization", null);
                        if (!org) return { span: {} };
                        const kinds = Object.entries(org.standing ?? {}).filter(([, d]) => d.length).map(([k, d]) => `${k}: ${d.join(", ")}`).join(" · ");
                        return {
                            div: {
                                children: [
                                    { p: { className: "muted small", textContent: `Departments approve what they steward, in their steps, in order. Governance: ${org.governance}. Standing approvers: ${kinds || "none"}.` } },
                                    { table: { className: "grid", children: [
                                        { thead: { children: [{ tr: { children: ["Department", "Members", "Approves in"].map((h) => ({ th: h })) } }] } },
                                        { tbody: { children: Object.entries(org.departments ?? {}).map(([d, x]) => ({ tr: { key: d, children: [
                                            { td: { children: [{ strong: x.name }, { span: { className: "muted small", textContent: ` ${d}` } }] } },
                                            { td: (x.members ?? []).join(", ") || "—" },
                                            { td: (x.approval ?? []).map((st, k) => `${k + 1}. ${st.label} (${st.approvers.join(" or ") || "nobody"})`).join(" → ") || "—" },
                                        ] } })) } },
                                    ] } },
                                    (org.open ?? []).length
                                        ? { p: { children: [{ Link: { to: `/design/c/${org.open[0]}`, textContent: "open change to people & departments" } }] } }
                                        : isDesigner() ? { button: { type: "button", className: "btn", textContent: "Change people & departments", onclick: () => start({ organization: true }) } } : { span: {} },
                                ],
                            },
                        };
                    },
            ] } }),
            transactions: () => ({ div: { children: [
                    { p: { className: "muted small", textContent: "Screens that change several records as one: move a lot onto a machine, track it in and out. Each is designed, reviewed and approved like an object; its steps go through each object's own policies and rules." } },
                    () => (isDesigner() ? {
                        div: {
                            className: "new-object",
                            children: [
                                { strong: "New transaction" },
                                { input: { placeholder: "name (e.g. move_in)", value: () => api.getState("design.newTx.name", ""), oninput: (e) => api.setValue("design.newTx.name", e.target.value.trim().toLowerCase()) } },
                                { input: { placeholder: "label (e.g. Move in)", value: () => api.getState("design.newTx.label", ""), oninput: (e) => api.setValue("design.newTx.label", e.target.value) } },
                                copyOf("transaction", () => api.getState("design.newTx.from", ""), (v) => api.setValue("design.newTx.from", v)),
                                { button: { type: "button", className: "btn primary", textContent: "Start design", disabled: () => !IDENTIFIER.test(api.getState("design.newTx.name", "") ?? ""), onclick: () => start({ transaction: api.peek("design.newTx.name"), label: api.peek("design.newTx.label") ?? "", from: api.peek("design.newTx.from") }) } },
                                failed,
                            ],
                        },
                    } : { span: {} }),
                    () => {
                        const list = (api.getState("design.home.transactions", []) ?? []).filter((t) => hit(t.name, t.label));
                        if (!list.length) return { p: { className: "muted small", textContent: "None yet." } };
                        return {
                            table: {
                                className: "grid",
                                children: [
                                    { thead: { children: [{ tr: { children: ["Transaction", "Appears on", "Steps", "Version", "Open change", ""].map((h) => ({ th: h })) } }] } },
                                    { tbody: { children: list.map((t) => ({ tr: { key: t.name, children: [
                                        { td: { children: [{ strong: t.label }, { span: { className: "muted small", textContent: ` ${t.name}` } }] } },
                                        { td: t.appearsOn ? `${t.appearsOn.object}${t.appearsOn.states?.length ? ` (${t.appearsOn.states.join(", ")})` : ""}` : "navigator" },
                                        { td: String(t.steps) },
                                        { td: `v${t.version}` },
                                        { td: { children: t.open.length ? [{ Link: { to: `/design/c/${t.open[0]}`, textContent: "open change" } }] : [{ span: { className: "muted", textContent: "—" } }] } },
                                        { td: { className: "row-buttons", children: [{ Link: { to: `/design/view/transaction/${t.name}`, className: "btn ghost", textContent: "View" } }, isDesigner() && !t.open.length ? { button: { type: "button", className: "btn", textContent: "Change", onclick: () => start({ transaction: t.name }) } } : { span: {} }, copyButton("transaction", t.name)] } },
                                    ] } })) } },
                                ],
                            },
                        };
                    },
            ] } }),
            screens: () => ({ div: { children: [
                    { p: { className: "muted small", textContent: "Pages composed of blocks: a work centre, a board. Each block reads with the viewer's own rights; designed and approved like the rest." } },
                    () => (isDesigner() ? {
                        div: {
                            className: "new-object",
                            children: [
                                { strong: "New screen" },
                                { input: { placeholder: "name (e.g. line_board)", value: () => api.getState("design.newScreen.name", ""), oninput: (e) => api.setValue("design.newScreen.name", e.target.value.trim().toLowerCase()) } },
                                { input: { placeholder: "label (e.g. Line board)", value: () => api.getState("design.newScreen.label", ""), oninput: (e) => api.setValue("design.newScreen.label", e.target.value) } },
                                copyOf("screen", () => api.getState("design.newScreen.from", ""), (v) => api.setValue("design.newScreen.from", v)),
                                { button: { type: "button", className: "btn primary", textContent: "Start design", disabled: () => !IDENTIFIER.test(api.getState("design.newScreen.name", "") ?? ""), onclick: () => start({ screen: api.peek("design.newScreen.name"), label: api.peek("design.newScreen.label") ?? "", from: api.peek("design.newScreen.from") }) } },
                                failed,
                            ],
                        },
                    } : { span: {} }),
                    () => {
                        const list = (api.getState("design.home.screens", []) ?? []).filter((x) => hit(x.name, x.label));
                        if (!list.length) return { p: { className: "muted small", textContent: "None yet." } };
                        return {
                            table: {
                                className: "grid",
                                children: [
                                    { thead: { children: [{ tr: { children: ["Screen", "Opened with", "Blocks", "Version", "Open change", ""].map((h) => ({ th: h })) } }] } },
                                    { tbody: { children: list.map((sc) => ({ tr: { key: sc.name, children: [
                                        { td: { children: [{ Link: { to: `/s/${sc.name}`, textContent: sc.label } }, { span: { className: "muted small", textContent: ` ${sc.name}` } }] } },
                                        { td: sc.param ?? "—" },
                                        { td: String(sc.blocks) },
                                        { td: `v${sc.version}` },
                                        { td: { children: sc.open.length ? [{ Link: { to: `/design/c/${sc.open[0]}`, textContent: "open change" } }] : [{ span: { className: "muted", textContent: "—" } }] } },
                                        { td: { className: "row-buttons", children: [{ Link: { to: `/design/view/screen/${sc.name}`, className: "btn ghost", textContent: "View" } }, isDesigner() && !sc.open.length ? { button: { type: "button", className: "btn", textContent: "Change", onclick: () => start({ screen: sc.name }) } } : { span: {} }, copyButton("screen", sc.name)] } },
                                    ] } })) } },
                                ],
                            },
                        };
                    },
            ] } }),
            // Flow templates (§32): routes and out-of-control action plans, drawn in the Flow designer.
            flows: () => ({ div: { children: [
                    { p: { className: "muted small", textContent: "Flow templates: routes a traveler (a lot) goes through, step by step, and plans (OCAP) an event sets off, drawn in the Flow designer and approved like the rest. Objects take part once their design says so (Flows, on their General tab)." } },
                    () => (isDesigner() ? {
                        div: {
                            className: "new-object",
                            children: [
                                { strong: "New flow template" },
                                { input: { placeholder: "name (e.g. back_end_route)", value: () => api.getState("design.newFlow.name", ""), oninput: (e) => api.setValue("design.newFlow.name", e.target.value.trim().toLowerCase()) } },
                                { input: { placeholder: "label (e.g. Back-end route)", value: () => api.getState("design.newFlow.label", ""), oninput: (e) => api.setValue("design.newFlow.label", e.target.value) } },
                                // A new one may start as a copy of a live one (one process's OCAP for another).
                                copyOf("flow", () => api.getState("design.newFlow.from", ""), (v) => api.setValue("design.newFlow.from", v)),
                                { button: { type: "button", className: "btn primary", textContent: "Start design", disabled: () => !IDENTIFIER.test(api.getState("design.newFlow.name", "") ?? ""), onclick: () => start({ flow: api.peek("design.newFlow.name"), label: api.peek("design.newFlow.label") ?? "", from: api.peek("design.newFlow.from") }) } },
                                failed,
                            ],
                        },
                    } : { span: {} }),
                    () => {
                        const list = (api.getState("design.home.flows", []) ?? []).filter((x) => hit(x.name, x.label));
                        if (!list.length) return { p: { className: "muted small", textContent: "None yet." } };
                        return {
                            table: {
                                className: "grid",
                                children: [
                                    { thead: { children: [{ tr: { children: ["Flow template", "Kind", "Nodes", "Version", "Open change", ""].map((h) => ({ th: h })) } }] } },
                                    { tbody: { children: list.map((f) => ({ tr: { key: f.name, children: [
                                        { td: { children: [{ strong: f.label }, { span: { className: "muted small", textContent: ` ${f.name}` } }] } },
                                        { td: f.kind === "plan" ? "plan (OCAP)" : "route" },
                                        { td: String(f.nodes) },
                                        { td: `v${f.version}` },
                                        { td: { children: f.open.length ? [{ Link: { to: `/design/c/${f.open[0]}`, textContent: "open change" } }] : [{ span: { className: "muted", textContent: "—" } }] } },
                                        { td: { className: "row-buttons", children: [{ Link: { to: `/design/view/flow/${f.name}`, className: "btn ghost", textContent: "View" } }, isDesigner() && !f.open.length ? { button: { type: "button", className: "btn", textContent: "Change", onclick: () => start({ flow: f.name }) } } : { span: {} }, copyButton("flow", f.name)] } },
                                    ] } })) } },
                                ],
                            },
                        };
                    },
            ] } }),
            // Design elements of a kind an installed suite adds (§30.11): designed, reviewed and approved
            // like the platform's own; one whose suite is not installed stays listed, as it is.
            elements: () => ({ div: { children: [
                    { p: { className: "muted small", textContent: "Design elements of a kind an installed suite adds. Each is changed through a change request and approved by its stewards, like everything else here. One whose suite is not installed stays as it is until the suite is back." } },
                    () => {
                        const kinds = Object.entries(api.getState("design.home.suiteElements", {}) ?? {});
                        if (!isDesigner() || !kinds.length) return { span: {} };
                        // Nothing is picked for the person: a new element's kind is theirs to say.
                        const kind = () => api.getState("design.newElement.kind", "") ?? "";
                        return {
                            div: {
                                className: "new-object",
                                children: [
                                    { strong: "New" },
                                    { select: { "aria-label": "Its kind", onchange: (e) => api.setValue("design.newElement.kind", e.target.value), children: noDefault([{ option: { key: "", value: "", selected: () => !kind(), textContent: "choose its kind" } }, ...kinds.map(([k, x]) => ({ option: { key: k, value: k, selected: () => kind() === k, textContent: x.label ?? k } }))]) } },
                                    { input: { placeholder: "name (lower case, digits, _)", value: () => api.getState("design.newElement.name", ""), oninput: (e) => api.setValue("design.newElement.name", e.target.value.trim().toLowerCase()) } },
                                    { input: { placeholder: "label", value: () => api.getState("design.newElement.label", ""), oninput: (e) => api.setValue("design.newElement.label", e.target.value) } },
                                    { button: { type: "button", className: "btn primary", textContent: "Start design", disabled: () => !kind() || !IDENTIFIER.test(api.getState("design.newElement.name", "") ?? ""), onclick: () => start({ element: api.peek("design.newElement.name"), kind: kind(), label: api.peek("design.newElement.label") ?? "" }) } },
                                    failed,
                                ],
                            },
                        };
                    },
                    () => {
                        const list = (api.getState("design.home.elements", []) ?? []).filter((x) => hit(x.name, x.label, x.kindLabel, x.kind));
                        if (!list.length) return { p: { className: "muted small", textContent: "None yet." } };
                        return {
                            table: {
                                className: "grid",
                                children: [
                                    { thead: { children: [{ tr: { children: ["Design element", "Kind", "Version", "Open change", ""].map((h) => ({ th: h })) } }] } },
                                    { tbody: { children: list.map((l) => ({ tr: { key: l.name, children: [
                                        { td: { children: [{ strong: l.label }, { span: { className: "muted small", textContent: ` ${l.name}` } }] } },
                                        { td: l.needs ? `${l.kind}: needs the ${l.needs} suite, which is not installed here` : l.kindLabel ?? l.kind },
                                        { td: `v${l.version}` },
                                        { td: { children: l.open.length ? [{ Link: { to: `/design/c/${l.open[0]}`, textContent: "open change" } }] : [{ span: { className: "muted", textContent: "—" } }] } },
                                        { td: { className: "row-buttons", children: [isDesigner() && !l.open.length && !l.needs ? { button: { type: "button", className: "btn", textContent: "Change", onclick: () => start({ element: l.name }) } } : { span: {} }] } },
                                    ] } })) } },
                                ],
                            },
                        };
                    },
            ] } }),
            // Report layouts (§34.5): how an AI report is laid out, picked by whoever asks for one.
            layouts: () => ({ div: { children: [
                    { p: { className: "muted small", textContent: "Report layouts: which blocks an AI report has, in which order and how wide, and what each is for. Whoever asks the analytics copilot for a report picks one, and the copilot fills it from what they may read. A layout holds no query and no data; it is approved like the rest." } },
                    () => (isDesigner() ? {
                        div: {
                            className: "new-object",
                            children: [
                                { strong: "New report layout" },
                                { input: { placeholder: "name (e.g. daily_report)", value: () => api.getState("design.newLayout.name", ""), oninput: (e) => api.setValue("design.newLayout.name", e.target.value.trim().toLowerCase()) } },
                                { input: { placeholder: "label (e.g. Daily report)", value: () => api.getState("design.newLayout.label", ""), oninput: (e) => api.setValue("design.newLayout.label", e.target.value) } },
                                copyOf("layout", () => api.getState("design.newLayout.from", ""), (v) => api.setValue("design.newLayout.from", v)),
                                { button: { type: "button", className: "btn primary", textContent: "Start design", disabled: () => !IDENTIFIER.test(api.getState("design.newLayout.name", "") ?? ""), onclick: () => start({ layout: api.peek("design.newLayout.name"), label: api.peek("design.newLayout.label") ?? "", from: api.peek("design.newLayout.from") }) } },
                                failed,
                            ],
                        },
                    } : { span: {} }),
                    () => {
                        const list = (api.getState("design.home.layouts", []) ?? []).filter((x) => hit(x.name, x.label));
                        if (!list.length) return { p: { className: "muted small", textContent: "None yet." } };
                        return {
                            table: {
                                className: "grid",
                                children: [
                                    { thead: { children: [{ tr: { children: ["Report layout", "Blocks", "Version", "Open change", ""].map((h) => ({ th: h })) } }] } },
                                    { tbody: { children: list.map((l) => ({ tr: { key: l.name, children: [
                                        { td: { children: [{ strong: l.label }, { span: { className: "muted small", textContent: ` ${l.name}` } }] } },
                                        { td: (l.blocks ?? []).join(", ") },
                                        { td: `v${l.version}` },
                                        { td: { children: l.open.length ? [{ Link: { to: `/design/c/${l.open[0]}`, textContent: "open change" } }] : [{ span: { className: "muted", textContent: "—" } }] } },
                                        { td: { className: "row-buttons", children: [{ Link: { to: `/design/view/layout/${l.name}`, className: "btn ghost", textContent: "View" } }, isDesigner() && !l.open.length ? { button: { type: "button", className: "btn", textContent: "Change", onclick: () => start({ layout: l.name }) } } : { span: {} }, copyButton("layout", l.name)] } },
                                    ] } })) } },
                                ],
                            },
                        };
                    },
            ] } }),
            // The test sandbox (§5.13): the changes under test together, in the order they are applied.
            test: () => ({ TestBench: { key: "testbench" } }),
            // Every change request: the open ones by default, or the viewer's, or all of them.
            changes: () => {
                const me = api.getState("me.id", null);
                const which = api.getState("ui.designChanges", "open");
                const all = api.getState("design.home.changes", []) ?? [];
                const list = all.filter((c) => (which === "open" ? OPEN.includes(c.state) : which === "mine" ? c.author === me || (c.co_designers ?? []).includes(me) : true)).filter((c) => hit(c.title, c.author, ...touches(c)));
                const waiting = all.filter((c) => c.state === "review" || c.state === "approval").length;
                return { div: { children: [
                    { div: { className: "filter-row", children: [
                        ...[["open", "Open"], ["mine", "Mine"], ["all", "All"]].map(([k, l]) => ({ button: { key: k, type: "button", className: "chip", classList: { on: which === k }, textContent: l, onclick: () => api.setValue("ui.designChanges", k) } })),
                        searchBox("Find a change"),
                        waiting ? { Link: { to: "/design/approvals", className: "small", className: "small icon-text", children: [{ span: `${waiting} waiting for review or approval` }, icon("arrowRight")] } } : { span: {} },
                    ] } },
                    list.length ? {
                        table: {
                            className: "grid",
                            children: [
                                { thead: { children: [{ tr: { children: ["Change", "Changes", "State", "Author", "Updated"].map((h) => ({ th: h })) } }] } },
                                { tbody: { children: list.map((c) => ({ tr: { key: c.id, className: "row", onclick: () => api.navigate(`/design/c/${c.id}`), children: [
                                    { td: { children: [{ Link: { to: `/design/c/${c.id}`, textContent: c.title } }] } },
                                    { td: { className: "muted small", textContent: touches(c).join(", ") || "—" } },
                                    { td: { children: [{ span: { className: `badge s-${c.state}`, textContent: c.state } }] } },
                                    { td: c.author },
                                    { td: { className: "muted small", textContent: ago(c.updated_at) } },
                                ] } })) } },
                            ],
                        },
                    } : { p: { className: "muted", textContent: which === "open" ? "No change is open." : "None." } },
                ] } };
            },
        };

        return {
            div: {
                className: "view designer",
                children: [
                    { div: { className: "view-head", children: [{ h1: "Designer" }, { span: { className: "muted", textContent: "Every change is designed, reviewed, approved, then executed by the platform." } }, { span: { className: "spacer" } }, { Link: { to: "/design/approvals", className: "btn", textContent: "Approvals" } }, { Link: { to: "/design/integration", className: "btn", textContent: "Integration monitor" } }] } },
                    inProgress,
                    packsPanel,
                    // The whole model to another installation, or from one (§24.1).
                    { p: { className: "small", children: [{ Link: { to: "/design/model", textContent: "Export or import the whole model" } }, { span: { className: "muted", textContent: " as one file, for another installation" } }] } },
                    {
                        nav: {
                            className: "design-tabs", role: "tablist",
                            children: TABS.filter(([key]) => key !== "elements" || (api.getState("design.home.elements", []) ?? []).length > 0 || Object.keys(api.getState("design.home.suiteElements", {}) ?? {}).length > 0).map(([key, label, count, inChange]) => ({
                                button: {
                                    key, type: "button", role: "tab", className: "design-tab", "aria-selected": () => String(tab() === key), classList: { active: () => tab() === key },
                                    onclick: () => { api.batch(() => { setTab(key); api.setValue("ui.designQ", ""); }); },
                                    children: [
                                        { span: label },
                                        () => ({ span: { className: "tab-count", textContent: String(count()) } }),
                                        () => (openChanges().some(inChange) ? { span: { className: "tab-open", title: "Something here has an open change", children: [icon("dot")] } } : { span: {} }),
                                    ],
                                },
                            })),
                        },
                    },
                    () => ({ div: { key: tab(), className: "design-panel", role: "tabpanel", children: [(panels[tab()] ?? panels.objects)()] } }),
                    { AiAccess: {} },
                ],
            },
        };
    });

    // ---- one change request: the editor while in design, the lifecycle throughout ----
    juris.registerComponent("ChangeView", ({ id }, api) => {
        const as = api.getState("me.id", null, { track: false });
        const C = `dc.${id}`;
        const w = W(id);
        api.live(C, "design.change", args.change(id, as));
        api.live("design.home", "design.home", args.design(as));

        // The working copy follows the change while nothing is being edited. `seen`: the draft's version
        // (draft_rev) it was loaded from, which a save names (a save made on an older copy is refused,
        // §5.3); a fitness run or a review moves the change, never that version.
        const load = () => {
                const change = api.peek(C);
                if (!change || api.peek(`${w}.dirty`)) return;
                loadWorkspace(api, w, change);
                titleTab(api, `/design/c/${id}`, change.title);
        };
        const stop = api.bindState(() => [api.getState(`${C}.updated_at`), api.getState(`${C}.state`)], load);
        api.onCleanup(stop);

        const ops = draftOps(api, id);
        const busy = () => api.getState(`${w}.busy`, false);

        // Who else has this change open (reviewers, approvers, another designer), as on a record.
        api.live(`pres.design.${id}`, "presence.get", args.presence("design", id, as));
        if (!api.isServer) {
            const say = () => api.call("presence.join", { object: "design", id, editing: Boolean(api.peek(`${w}.dirty`)) }).catch(() => {});
            api.onMount(() => {
                say();
                const beat = setInterval(say, 15_000);
                const stopEditing = api.bindState(() => Boolean(api.getState(`${w}.dirty`, false)), () => say());
                return () => { clearInterval(beat); stopEditing(); api.call("presence.leave", { object: "design", id }).catch(() => {}); };
            });
        }
        const run = async (label, fn) => {
            api.batch(() => { api.setValue(`${w}.busy`, true); api.setValue(`${w}.error`, null); api.setValue(`${w}.notice`, null); });
            let stale = false;
            try {
                const result = await fn();
                api.setValue(`${w}.notice`, typeof label === "function" ? label(result) : label);
            } catch (e) {
                api.setValue(`${w}.error`, e.message);
                stale = e.code === "design.stale";
            } finally {
                api.setValue(`${w}.busy`, false);
            }
            // A co-designer saved meanwhile: their version, on request (this copy's edits are then gone).
            if (stale && await confirmDialog(api, { title: "Load their version?", message: `${api.peek(`${w}.error`)} Your unsaved edits here are replaced by theirs.`, confirm: "Load their version", danger: true })) {
                api.batch(() => { api.setValue(`${w}.dirty`, false); api.setValue(`${w}.error`, null); });
                load();
            }
        };
        // A save of the working copy, naming the version it was loaded from; the next one names this one.
        const saveDraft = async () => {
            const result = await api.call("design.save", ops.payload());
            api.batch(() => { api.setValue(`${w}.dirty`, false); api.setValue(`${w}.seen`, result.draft_rev); api.setValue(`${w}.serverProblems`, result.problems); });
            return result;
        };
        const save = () => run("Draft saved.", saveDraft);
        const submit = () => run("Submitted for review.", async () => {
            // The reason is folded away until asked for: a submit without one opens it.
            if (!String(api.peek(`${w}.reason`) ?? "").trim()) {
                api.setValue(`${w}.whyOpen`, true);
                throw new Error("Write why this change is needed first: approvers read it.");
            }
            const result = await saveDraft();
            if (result.problems.length) throw new Error(`Fix ${result.problems.length} problem(s) first.`);
            try {
                await api.call("design.submit", { id });
            } catch (e) {
                // The report the refusal names: shown beside the change.
                if (e.code === "design.unfit") await api.call("design.fitness", { id }).catch(() => {});
                throw e;
            }
        });
        // Sending back and rejecting say why (asked for when the note is empty); withdrawing and taking a
        // review back are confirmed first (dialog.js).
        const noteOr = async (title, label, message = "") => {
            const note = String(api.peek(`${w}.note`) ?? "").trim();
            return note || askDialog(api, { title, message, label, required: true, multiline: true, confirm: title.split(" ")[0], danger: title.startsWith("Reject") });
        };
        const review = async (decision) => {
            const note = decision === "changes" ? await noteOr("Ask for changes", "What needs to change?", "The change goes back to its author, with this note.") : api.peek(`${w}.note`) ?? "";
            if (note === null) return;
            await run(decision === "pass" ? "Passed to approval." : "Sent back to design.", () => api.call("design.review", { id, decision, note }));
        };
        const approve = async (department, decision) => {
            const note = decision === "reject" ? await noteOr(`Reject for ${department}`, "Why?", "A rejection ends the change. The author and the audit trail read your reason.") : api.peek(`${w}.note`) ?? "";
            if (note === null) return;
            // An approval is a signature (§7.4): where the plant asks it, the signer proves who they are.
            const signature = api.getState("signing.password", false)
                ? await signDialog(api, { title: `${decision === "approve" ? "Approve" : "Reject"} for ${department}?`, message: `Your signature means you ${decision === "approve" ? "approve" : "reject"} this change for ${department}; it is recorded with your name, the time and its meaning. Enter your password to sign.`, confirm: decision === "approve" ? "Approve (sign)" : "Reject (sign)", danger: decision === "reject" })
                : {};
            if (signature === null) return;
            await run((r) => (r.state === "executed" ? "Approved — every department has approved, and the platform executed the change." : r.state === "failed" ? `Execution failed: ${r.error}` : decision === "approve" ? "Approved." : "Rejected."), () => api.call("design.approve", { id, department, decision, meaning: decision === "approve" ? "Approved" : "Rejected", note, signature }));
        };
        const withdraw = async () => {
            if (!(await confirmDialog(api, { title: "Withdraw this change?", message: "It stops here and is kept as history. A new change starts from what is published.", confirm: "Withdraw", danger: true }))) return;
            await run("Withdrawn.", () => api.call("design.withdraw", { id }));
        };
        const retract = async () => {
            if (!(await confirmDialog(api, { title: "Take back your review?", message: "The change goes back to review, for someone else to review.", confirm: "Take it back" }))) return;
            await run("Your review is taken back: the change is in review again, for someone else.", () => api.call("design.retractReview", { id }));
        };
        const canEdit = () => api.getState(`${C}.can.edit`, false);

        return {
            div: {
                className: "view change",
                children: [
                    () => {
                        const change = api.getState(C);
                        if (change === null) return { h1: "Not found" };
                        if (!change) return { p: { className: "muted", textContent: "Loading…" } };
                        return {
                            div: {
                                className: "change-head",
                                children: [
                                    { div: { className: "title", children: [{ GuideToggle: { key: "guide-change", guide: "designer" } }, { span: { className: "kind", textContent: "Change request" } }, { h1: () => api.getState(`${C}.title`, "") }, { span: { className: () => `badge s-${api.getState(`${C}.state`)}`, textContent: () => api.getState(`${C}.state`, "") } }] } },
                                    { Stepper: { statePath: `${C}.state` } },
                                    { p: { className: "muted small", textContent: () => {
                                        const part = (label, key) => (api.getState(`${C}.${key}`, []).length ? ` · ${label}${api.getState(`${C}.${key}`, []).join(", ")}` : "");
                                        const co = api.getState(`${C}.co_designers`, []) ?? [];
                                        return `by ${api.getState(`${C}.author`)}${co.length ? `, with ${co.join(", ")}` : ""}${part("", "objects")}${part("services: ", "services")}${part("connections: ", "connections")}${part("transactions: ", "transactions")}${part("screens: ", "screens")}${api.getState(`${C}.organization`, false) ? " · people & departments" : ""}${part("scripts: ", "scripts")}`;
                                    } } },
                                ],
                            },
                        };
                    },
                    { Presence: { path: `pres.design.${id}`, noun: "change" } },
                    {
                        div: {
                            className: () => `change-body${api.getState(`${w}.panes.length`, 1) > 1 ? " wide" : ""}`,
                            children: [
                                { section: { className: "change-main", children: [{ PaneSet: { id, editable: canEdit } }] } },
                                {
                                    aside: {
                                        className: "change-side",
                                        children: [
                                            { ChangeDesigners: { id } },
                                            // Why this change: folded until the toggle is pressed; the toggle says whether it is written.
                                            {
                                                button: {
                                                    type: "button", className: "why-toggle",
                                                    "aria-expanded": () => String(Boolean(api.getState(`${w}.whyOpen`, false))),
                                                    onclick: () => api.setValue(`${w}.whyOpen`, !api.peek(`${w}.whyOpen`)),
                                                    children: [
                                                        { span: { className: "chevron", children: () => [icon(api.getState(`${w}.whyOpen`, false) ? "chevronDown" : "chevronRight")] } },
                                                        { strong: " Why this change" },
                                                        { span: { className: () => `why-state ${String(api.getState(`${w}.reason`, "") ?? "").trim() ? "done" : "missing"}`, textContent: () => (String(api.getState(`${w}.reason`, "") ?? "").trim() ? "written" : "required to submit") } },
                                                    ],
                                                },
                                            },
                                            () => (api.getState(`${w}.whyOpen`, false)
                                                ? { textarea: { key: "why", rows: 3, placeholder: "The reason (required to submit)", disabled: () => !canEdit(), value: () => api.getState(`${w}.reason`, "") ?? "", oninput: (e) => { api.batch(() => { api.setValue(`${w}.reason`, e.target.value); api.setValue(`${w}.dirty`, true); if (/^Write why/.test(api.peek(`${w}.error`) ?? "")) api.setValue(`${w}.error`, null); }); } } }
                                                : { span: {} }),
                                            { CheckPanel: { id } },
                                            // The draft on copies of real records, nothing live written (§5.11).
                                            { Link: { to: `/design/c/${id}/sandbox`, className: "btn sbx-link icon-text", title: "Run this draft on copies of real records, in a database of its own", children: [icon("play"), { span: "Try it in a sandbox" }] } },
                                            // Under test with the other changes (§5.13), before approval is asked for.
                                            { TestPanel: { id } },
                                            // Rolled back (§5.14): by a change the platform drafts, which one approval executes.
                                            { RollbackPanel: { id } },
                                            { FitnessPanel: { id, save: () => (api.peek(`${w}.dirty`) && canEdit() ? saveDraft() : Promise.resolve()) } },
                                            { AiEdits: { id } },
                                            { RoutePanel: { id } },
                                            {
                                                div: {
                                                    className: "lifecycle",
                                                    children: () => {
                                                        const change = api.getState(C);
                                                        if (!change) return [];
                                                        const can = change.can;
                                                        const out = [];
                                                        // Who may review it and still leave someone to sign every step, before it is submitted.
                                                        const rv = change.reviewing;
                                                        const me = api.peek("me.id");
                                                        const noReviewer = Boolean(rv && !rv.fine.length);
                                                        if (can.edit) {
                                                            out.push({ button: { key: "save", type: "button", className: "btn", disabled: () => busy() || !api.getState(`${w}.dirty`, false), textContent: "Save draft", onclick: save } });
                                                            out.push({ button: { key: "submit", type: "button", className: "btn primary", disabled: () => busy() || noReviewer, textContent: "Submit for review", onclick: submit } });
                                                        }
                                                        if (rv) for (const line of reviewWarnings(rv, { author: change.author, me, reviewer: can.review })) out.push({ p: { key: line.key, className: `small ${line.error ? "error" : "review-warn"}`, textContent: line.text } });
                                                        if (can.review || can.approveFor.length) out.push({ textarea: { key: "note", rows: 2, placeholder: "Note (required when asking for changes)", value: () => api.getState(`${w}.note`, "") ?? "", oninput: (e) => api.setValue(`${w}.note`, e.target.value) } });
                                                        if (can.review && change.reviewCosts?.length && !rv?.strands.some((x) => x.reviewer === me)) {
                                                            out.push({ p: { key: "cost", className: "muted small", textContent: `If you review it, you cannot also approve it for ${change.reviewCosts.join(", ")}: another representative will have to.` } });
                                                        }
                                                        if (can.review) {
                                                            const stranding = rv?.strands.some((x) => x.reviewer === me) || noReviewer;
                                                            out.push({ button: { key: "pass", type: "button", className: "btn primary", disabled: () => busy() || stranding, textContent: "Pass review", onclick: () => review("pass") } });
                                                            out.push({ button: { key: "changes", type: "button", className: "btn", disabled: busy, textContent: "Ask for changes", onclick: () => review("changes") } });
                                                        }
                                                        for (const dept of can.approveFor) {
                                                            const st = can.approveSteps?.[dept];
                                                            out.push({ button: { key: `a-${dept}`, type: "button", className: "btn primary", disabled: busy, textContent: `Approve for ${dept}${st && st.of > 1 ? ` as ${st.label} (${st.step} of ${st.of})` : ""} (sign)`, onclick: () => approve(dept, "approve") } });
                                                            out.push({ button: { key: `r-${dept}`, type: "button", className: "btn", disabled: busy, textContent: `Reject for ${dept}`, onclick: () => approve(dept, "reject") } });
                                                        }
                                                        // In approval: why this person cannot sign, who still can, and a way out when nobody can.
                                                        const words = { author: "you wrote it", reviewer: "you reviewed it", signed: "you signed an earlier step" };
                                                        for (const w of change.whyNot ?? []) out.push({ p: { key: `why-${w.department}`, className: "muted small", textContent: `You cannot approve it for ${w.department}${w.step && w.step !== "Approver" ? ` (${w.step})` : ""}: ${words[w.reason]}, and whoever signs must be someone else.` } });
                                                        const left = change.approvers ?? {};
                                                        const stuck = Object.entries(left).filter(([, users]) => !users.length).map(([d]) => d);
                                                        for (const [d, users] of Object.entries(left)) if (users.length && !can.approveFor.includes(d)) out.push({ p: { key: `who-${d}`, className: "muted small", textContent: `${d}: waiting for ${users.join(" or ")}.` } });
                                                        if (stuck.length) {
                                                            out.push({ p: { key: "stuck", className: "error small", textContent: `Nobody can approve it for ${stuck.join(", ")}: its representatives are the author and the reviewer. ${can.retractReview ? "Take your review back, so that someone who does not represent it reviews it." : `The reviewer (${change.reviewer}) can take the review back, or the author can withdraw it.`}` } });
                                                        }
                                                        if (can.retractReview) out.push({ button: { key: "retract", type: "button", className: stuck.length ? "btn primary" : "btn ghost", disabled: busy, textContent: "Take back my review", onclick: retract } });
                                                        if (can.withdraw) out.push({ button: { key: "withdraw", type: "button", className: "btn ghost", disabled: busy, textContent: "Withdraw", onclick: withdraw } });
                                                        if (!out.length) out.push({ p: { key: "none", className: "muted small", textContent: lifecycleHint(change) } });
                                                        return out;
                                                    },
                                                },
                                            },
                                            { p: { className: "error", textContent: () => api.getState(`${w}.error`, "") ?? "" } },
                                            { p: { className: "notice", textContent: () => api.getState(`${w}.notice`, "") ?? "" } },
                                            () => (api.getState(`${C}.review_note`, null) ? { p: { className: "review-note", textContent: `Review (${api.getState(`${C}.reviewer`)}): ${api.getState(`${C}.review_note`)}` } } : { span: {} }),
                                            () => (api.getState(`${C}.outcome`, null) ? { pre: { className: "outcome small", textContent: `Outcome: ${JSON.stringify(api.getState(`${C}.outcome`))}` } } : { span: {} }),
                                        ],
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
        };
    });

    // A live design, read-only (§5.1): the editors a change has, on what is published, with no draft and
    // no change request. "Change it" starts one, as the designer's home does; an open one is linked.
    juris.registerComponent("DesignView", ({ kind, name }, api) => {
        // The objects shown beside it follow the address (?with=…): a new selection, a new subscription.
        const also = () => args.viewWith({ with: api.getState("$route.query.with", "") });
        return { div: { className: "design-view-host", children: () => [{ DesignViewBody: { key: `vb-${also().join(",")}`, kind, name, also: also() } }] } };
    });
    juris.registerComponent("DesignViewBody", ({ kind, name, also = [] }, api) => {
        const as = api.getState("me.id", null, { track: false });
        const id = `view-${kind}-${name}`;
        const C = `dc.${id}`;
        const w = W(id);
        const main = `${kind === "object" ? "object" : kind}:${name}`;
        // A window opens on the design itself, not on an object shown beside it; a flow template on its canvas.
        if (!api.peek(`${w}.panes`)) api.setValue(`${w}.panes`, [{ view: kind === "flow" ? "canvas" : "general", el: main }]);
        api.live(C, "design.view", args.designView(kind, name, as, also));
        api.live("design.home", "design.home", args.design(as));
        const stop = api.bindState(() => api.getState(`${C}.updated_at`), () => {
            const view = api.peek(C);
            if (!view) return;
            loadWorkspace(api, w, view);
            if (kind === "object") openObject(api, w, name);
            titleTab(api, `/design/view/${kind}/${name}`, view.title);
        });
        api.onCleanup(stop);
        const [error, setError] = api.useState("error", null);
        const change = () => api.call("design.start", { [kind]: name }).then(({ id: cid }) => api.navigate(`/design/c/${cid}`), (e) => setError(e.message));
        // Ticking an object shows it beside the design (the address carries it, to share or come back to).
        const toggle = (object, on) => {
            const next = on ? [...also, object] : also.filter((o) => o !== object);
            api.setValue("$route.query", { ...(api.peek("$route.query") ?? {}), with: next.join(",") || undefined });
        };
        return {
            div: {
                className: "view change design-view",
                children: [
                    () => {
                        const view = api.getState(C);
                        if (view === null) return { div: { children: [{ h1: "Not found" }, { p: { className: "muted", textContent: `No ${kind} "${name}" is live.` } }, { Link: { to: "/design", textContent: "Back to the designer" } }] } };
                        if (!view) return { p: { className: "muted", textContent: "Loading…" } };
                        const v = view.view;
                        return {
                            div: {
                                className: "change-head",
                                children: [
                                    { div: { className: "title", children: [{ GuideToggle: { key: "guide-view", guide: "designer" } }, { span: { className: "kind", textContent: `Live ${kind === "flow" ? "flow template" : kind === "layout" ? "report layout" : kind}` } }, { h1: view.title }, { span: { className: "badge s-live", textContent: `v${v.version}` } }] } },
                                    { p: { className: "muted small", textContent: `${kind} ${name} as it is live: read only, nothing is drafted. To change it, start a change.` } },
                                    v.uses?.length ? {
                                        div: {
                                            className: "view-uses",
                                            children: [
                                                { span: { className: "muted small", textContent: "Relies on (tick to show it here):" } },
                                                ...v.uses.map((u) => ({ label: { key: u.object, className: "check-chip", children: [{ input: { type: "checkbox", checked: v.with.includes(u.object), onchange: (e) => toggle(u.object, e.target.checked) } }, { span: ` ${u.label}` }] } })),
                                                v.with.length ? { span: { className: "muted small", textContent: "Pick one in a window's list, or Split to see them side by side." } } : { span: {} },
                                            ],
                                        },
                                    } : { span: {} },
                                    {
                                        div: {
                                            className: "view-actions",
                                            children: [
                                                v.open.length ? { Link: { to: `/design/c/${v.open[0].id}`, className: "btn", textContent: `Open in "${v.open[0].title}" (${v.open[0].state})` } } : { span: {} },
                                                v.mayChange ? { button: { type: "button", className: "btn primary", textContent: "Change it", onclick: change } } : { span: {} },
                                                { Link: { to: "/design", className: "btn ghost", textContent: "Designer" } },
                                            ],
                                        },
                                    },
                                    { p: { className: "error", textContent: () => error() ?? "" } },
                                ],
                            },
                        };
                    },
                    { div: { className: "change-body wide", children: [{ section: { className: "change-main", children: [{ PaneSet: { id, editable: () => false } }] } }] } },
                ],
            },
        };
    });

    juris.registerComponent("Stepper", ({ statePath }, api) => ({
        ol: {
            className: "stepper",
            children: () => {
                const state = api.getState(statePath, "design");
                const at = STEPS.indexOf(state);
                const ended = ["rejected", "withdrawn", "failed"].includes(state);
                return STEPS.map((step, i) => ({
                    li: {
                        key: step,
                        className: ended ? "step ended" : i < at ? "step done" : i === at ? "step now" : "step",
                        textContent: step === "executed" ? "execution" : step,
                    },
                }));
            },
        },
    }));

    // Problems: the page's own check as the designer types, and the server's at the last save.
    juris.registerComponent("CheckPanel", ({ id }, api) => ({
        div: {
            className: "check",
            children: () => {
                api.getState(`${W(id)}.vrev`);
                if (!api.peek(`dc.${id}`) || api.peek(`dc.${id}.state`) !== "design") return [];
                const problems = pageProblems(api, id);
                const server = api.getState(`${W(id)}.serverProblems`, []) ?? [];
                const extra = server.filter((p) => !problems.some((q) => q.message === p.message));
                const all = [...problems, ...extra];
                return [
                    { h4: { key: "h", textContent: all.length ? `${all.length} problem(s)` : "No problems" } },
                    { ul: { key: "l", className: "problems", children: all.map((p, i) => ({ li: { key: i, textContent: p.message } })) } },
                ];
            },
        },
    }));

    // The fitness test (§5.9): its latest report, and running it. Submitting runs it too, and a change
    // is submitted only when it passes; the report goes with the change to its reviewers.
    juris.registerComponent("FitnessPanel", ({ id, save }, api) => {
        const C = `dc.${id}`;
        const [busy, setBusy] = api.useState("busy", false);
        const [error, setError] = api.useState("error", null);
        const runIt = async () => {
            setBusy(true);
            setError(null);
            try { await save(); await api.call("design.fitness", { id }); } catch (e) { setError(e.message); } finally { setBusy(false); }
        };
        const ICON = { pass: "check", fail: "x", warn: "warning", info: "info" };
        return {
            div: {
                className: "fitness",
                children: () => {
                    const report = api.getState(`${C}.fitness`, null);
                    const state = api.getState(`${C}.state`, "design");
                    const current = api.getState(`${C}.fitnessCurrent`, false);
                    const out = [{ div: { key: "h", className: "fitness-head", children: [
                        { h4: report ? `Fitness: ${report.passed ? "passed" : `failed (${report.counts.fail})`}${report.counts.warn ? ` · ${report.counts.warn} warning(s)` : ""}` : "Fitness test" },
                        state === "design" ? { button: { type: "button", className: "btn", disabled: busy, textContent: () => (busy() ? "Testing…" : report ? "Run again" : "Run fitness test"), onclick: runIt } } : { span: {} },
                    ] } }];
                    if (!report) out.push({ p: { key: "n", className: "muted small", textContent: "Runs the checks, every script's test cases, the existing records under the draft, and the access changes. Submitting runs it; a failing change is not submitted." } });
                    else {
                        out.push({ p: { key: "m", className: `muted small${current || state !== "design" ? "" : " stale"}`, textContent: `${state === "design" ? (current ? "Tested this draft" : "Tested an earlier draft: run it again") : "Submitted with this report"} · ${plant().dateTime(report.at)} · by ${report.by} · ${report.ms} ms` } });
                        for (const c of report.checks) {
                            out.push({
                                details: {
                                    key: c.id, className: `fit-check ${c.status}`, open: c.status === "fail" || c.status === "warn",
                                    children: [
                                        { summary: { children: [{ span: { className: `fit-icon ${c.status}`, children: [icon(ICON[c.status])] } }, { strong: ` ${c.title}` }, { span: { className: "muted small", textContent: ` — ${c.summary}` } }] } },
                                        ...(c.items?.length ? [{ ul: { children: c.items.slice(0, 30).map((item, i) => ({ li: { key: i, textContent: item } })) } }] : []),
                                        ...(c.cases?.length && !c.items?.length ? [{ ul: { children: c.cases.map((x, i) => ({ li: { key: i, className: "icon-text", children: [icon(x.passed ? "check" : "x"), { span: `${x.script} · ${x.name}: ${x.detail}` }] } })) } }] : []),
                                    ],
                                },
                            });
                        }
                    }
                    out.push({ p: { key: "e", className: "error small", textContent: error() ?? "" } });
                    return out;
                },
            },
        };
    });

    // Who must approve: while in design, computed from the draft as it changes; afterwards, the route
    // frozen at submit, with each department's decision.
    juris.registerComponent("RoutePanel", ({ id }, api) => ({
        div: {
            className: "route",
            children: () => {
                api.getState(`${W(id)}.vrev`);
                api.getState(`dc.${id}.updated_at`);
                const change = api.peek(`dc.${id}`);
                if (!change) return [];
                let route;
                if (change.state === "design") {
                    const drafted = draftDefinitions(api, W(id));
                    const many = Object.keys(drafted).length > 1;
                    const elements = Object.entries(drafted).filter(([, body]) => body).flatMap(([object, body]) => footprint(change.live.definitions?.[object] ?? null, body).map((e) => (many && !e.element.startsWith("object:") ? { ...e, element: `${object}: ${e.element}` } : e)));
                    const defs = Object.values(drafted).filter(Boolean);
                    const integ = integrationElements(api, id, change);
                    elements.push(...integ.elements);
                    elements.push(...transactionElements(api, id, change));
                    elements.push(...screenElements(api, id, change));
                    elements.push(...flowElements(api, id, change));
                    elements.push(...layoutElements(api, id, change));
                    elements.push(...suiteElementsOf(api, id, change));
                    elements.push(...organizationElements(api, id, change));
                    for (const [name, source] of Object.entries(api.peek(`${W(id)}.s`) ?? {})) elements.push(...scriptFootprint(name, change.live.scripts?.[name] ?? undefined, source, defs, integ.services, integ.context));
                    // Standing approvers join (§5.6); each department approves in its steps.
                    const org = api.peek("design.home.organization") ?? {};
                    const withStanding = applyStanding(elements, org.standing ?? {});
                    const stepsOf = (d) => (org.departments?.[d]?.approval ?? []).map((st, k) => ({ step: k + 1, label: st.label, approvers: st.approvers, signed: null }));
                    route = routeOf(withStanding).map((r) => ({ ...r, steps: stepsOf(r.department), approval: null }));
                    if (!route.length && withStanding.length) route = [{ department: org.governance ?? "engineering", because: withStanding.map((e) => e.element), steps: stepsOf(org.governance), approval: null }];
                } else {
                    route = change.route ?? [];
                }
                return [
                    { h4: { key: "h", textContent: change.state === "design" ? "Will need approval from" : "Approvals" } },
                    route.length
                        ? { ul: { key: "l", className: "route-list", children: route.map((r) => ({ li: { key: r.department, children: [
                            { strong: r.department },
                            { span: { className: `approval icon-text ${r.approval?.decision ?? "waiting"}`, children: r.approval ? [icon(r.approval.decision === "approve" ? "check" : "x"), { span: `${r.approval.decision === "approve" ? "approved" : "rejected"}${(r.steps ?? []).length > 1 ? "" : ` by ${r.approval.user_id}`}` }] : [{ span: change.state === "design" ? "" : " · waiting" }] } },
                            // A department that approves in steps: each, in order, and who signed or may sign it.
                            // Only who is pending is named: a signed step says who signed, the current one who may
                            // sign it now, and the steps after it only their label.
                            (r.steps ?? []).length > 1 ? { ol: { className: "route-steps small", children: r.steps.map((st) => ({ li: { key: st.step, className: st.signed ? `signed ${st.signed.decision}` : r.current === st.label ? "current" : "", children: [{ span: st.label }, st.signed ? icon(st.signed.decision === "approve" ? "check" : "x") : { span: {} }, { span: `${st.signed ? ` ${st.signed.user_id}` : r.current === st.label && change.state === "approval" ? `: waiting for ${(change.approvers?.[r.department] ?? st.approvers).join(" or ") || "nobody"}` : ""}` }] } })) } } : { span: {} },
                            { div: { className: "muted small", textContent: `because: ${r.because.join(", ")}` } },
                        ] } })) } }
                        : { p: { key: "n", className: "muted small", textContent: "Nothing changed yet." } },
                ];
            },
        },
    }));

    // The form as the draft would draw it (inputs disabled: a preview, not a record).
    // What this change does to one element, against what is published: grouped by the tab where each
    // difference is edited, each shown as the published and the proposed version, line by line.
    juris.registerComponent("ChangesView", ({ id, kind, name, onOpen }, api) => () => {
        api.getState(`${W(id)}.vrev`);
        api.getState(`dc.${id}.updated_at`);
        const changes = changesOf(api, id, kind, name);
        const tabs = { object: OBJECT_TABS, service: SERVICE_TABS, connection: CONNECTION_TABS, transaction: TRANSACTION_TABS, screen: SCREEN_TABS, layout: LAYOUT_TABS, element: ELEMENT_TABS, organization: ORG_TABS }[kind];
        const live = api.peek(`dc.${id}.live`) ?? {};
        const published = kind === "object" ? live.definitions?.[name] : kind === "service" ? live.services?.[name] : kind === "transaction" ? live.transactions?.[name] : kind === "screen" ? live.screens?.[name] : kind === "layout" ? live.layouts?.[name] : kind === "organization" ? live.organization : live.connections?.[name];
        const state = api.peek(`dc.${id}.state`);
        if (!changes.length) return { p: { className: "muted", textContent: published ? "Nothing differs from the published version." : "New: nothing is published yet." } };
        const counts = { added: 0, changed: 0, removed: 0 };
        for (const c of changes) counts[c.change] += 1;
        const groups = Object.entries(tabs).map(([tab, label]) => [tab, label, changes.filter((c) => c.tab === tab)]).filter(([, , list]) => list.length);
        return {
            div: {
                className: "changes-view",
                children: [
                    { p: { className: "muted small", textContent: `${changes.length} difference(s) from the published version${published ? "" : " (new)"}: ${counts.changed} changed, ${counts.added} added, ${counts.removed} removed.${["review", "approval"].includes(state) ? " This is what you are asked to pass or approve." : ""}` } },
                    ...groups.map(([tab, label, list]) => ({
                        section: {
                            key: tab,
                            className: "changes-group",
                            children: [
                                { div: { className: "changes-head", children: [{ h4: `${label} (${list.length})` }, onOpen ? { button: { type: "button", className: "mini", textContent: `Open ${label}`, onclick: () => onOpen(tab) } } : { span: {} }] } },
                                ...list.map((c) => ({
                                    details: {
                                        key: c.element,
                                        className: `change-item diff-${c.change}`,
                                        open: list.length <= 4,
                                        children: [
                                            { summary: { children: [diffPill(c.change), { span: ` ${c.label}` }] } },
                                            {
                                                pre: {
                                                    className: "diff",
                                                    children: lineDiff(textOf(c.before), textOf(c.after)).map((l, k) => ({ div: { key: k, className: l.op === "+" ? "add" : l.op === "-" ? "del" : "", textContent: `${l.op} ${l.text}` } })),
                                                },
                                            },
                                        ],
                                    },
                                })),
                            ],
                        },
                    })),
                ],
            },
        };
    });

    // A form as the draft lays it out, drawn by the record form itself (inputs disabled), so what the
    // designer sees is what people will see.
    let previews = 0;
    juris.registerComponent("FormPreview", ({ body, tab = 0 }, api) => {
        const at = `pv.p${++previews}`;
        api.setValue(`${at}.def`, { object: body.object, label: body.label, fields: body.fields ?? {}, form: body.form, titleField: body.titleField });
        api.setValue(`${at}.f.formTab`, tab);
        return { div: { className: "preview", children: [{ FormBody: { f: `${at}.f`, defPath: `${at}.def`, permPath: null, preview: true, onChange: () => {}, onCommit: () => {}, onWhy: null } }] } };
    });

    // ---- the definition editor ----
    // AI access (§16): the tokens through which an AI (Claude, or any other) works in the designer
    // as this person, over the REST API at /ai/v1/. A token is shown once; only its hash is kept.
    juris.registerComponent("AiAccess", (props, api) => {
        const [tokens, setTokens] = api.useState("tokens", null);
        const [form, setForm] = api.useState("form", { name: "", agent: "Claude", submit: false, days: 90 });
        const [fresh, setFresh] = api.useState("fresh", null);
        const [error, setError] = api.useState("error", null);
        const load = () => api.call("ai.tokens").then(setTokens, (e) => setError(e.message));
        if (!api.isServer) api.onMount(() => { load(); });
        const create = () => {
            const scopes = ["design:read", "design:draft", ...(form().submit ? ["design:submit"] : [])];
            api.call("ai.token.create", { name: form().name, agent: form().agent, scopes, days: Number(form().days) }).then(
                (t) => { setFresh(t); setError(null); setForm({ name: "", agent: form().agent, submit: false, days: form().days }); load(); },
                (e) => setError(e.message),
            );
        };
        const revoke = (id) => api.call("ai.token.revoke", { id }).then(load, (e) => setError(e.message));
        const origin = api.isServer ? "" : location.origin;
        return {
            details: {
                className: "ai-access",
                children: [
                    { summary: { children: [{ strong: "AI access" }, { span: { className: "muted small", textContent: " — let Claude or any AI design as you, over the REST API" } }] } },
                    { p: { className: "muted small", textContent: () => `API: ${origin}/ai/v1 (description: ${origin}/ai/v1/openapi.json). An AI drafts and checks its work; review, approval and execution stay with people.` } },
                    () => (fresh() ? {
                        div: {
                            className: "fresh-token",
                            children: [
                                { strong: "Copy this token now; it is not shown again:" },
                                { code: fresh().token },
                                { p: { className: "muted small", textContent: `Use it as: Authorization: Bearer ${fresh().token.slice(0, 8)}…` } },
                                { button: { type: "button", className: "btn ghost", textContent: "Done", onclick: () => setFresh(null) } },
                            ],
                        },
                    } : { span: {} }),
                    {
                        div: {
                            className: "new-object",
                            children: [
                                { input: { placeholder: "token name (e.g. Dana's Claude Code)", value: () => form().name, oninput: (e) => setForm({ ...form(), name: e.target.value }) } },
                                { input: { placeholder: "AI (e.g. Claude)", value: () => form().agent, oninput: (e) => setForm({ ...form(), agent: e.target.value }) } },
                                { label: { children: [{ input: { type: "checkbox", checked: () => form().submit, onchange: (e) => setForm({ ...form(), submit: e.target.checked }) } }, { span: " may also submit for review" }] } },
                                // A token expires (§8.2): it answers nobody after this many days.
                                { label: { children: [{ span: "lasts " }, { select: { "aria-label": "How long the token lasts", onchange: (e) => setForm({ ...form(), days: Number(e.target.value) }), children: [[30, "30 days"], [90, "90 days"], [365, "a year"]].map(([v, l]) => ({ option: { key: v, value: v, selected: Number(form().days) === v, textContent: l } })) } }] } },
                                { button: { type: "button", className: "btn primary", textContent: "Issue token", disabled: () => !form().name.trim(), onclick: create } },
                                { span: { className: "error", textContent: () => error() ?? "" } },
                            ],
                        },
                    },
                    () => ({
                        table: {
                            className: "grid",
                            children: [
                                { thead: { children: [{ tr: { children: ["Token", "AI", "Scopes", "Last used", "Expires", ""].map((h) => ({ th: h })) } }] } },
                                {
                                    tbody: {
                                        children: (tokens() ?? []).map((t) => ({
                                            tr: {
                                                key: t.id,
                                                className: t.revoked_at ? "revoked" : "",
                                                children: [
                                                    { td: t.name },
                                                    { td: t.agent || "—" },
                                                    { td: t.scopes.join(", ") },
                                                    { td: t.revoked_at ? "revoked" : t.last_used ? plant().dateTime(t.last_used) : "never" },
                                                    { td: t.revoked_at ? "—" : !t.expires_at ? "never" : new Date(t.expires_at) <= new Date() ? "expired" : plant().dateTime(t.expires_at) },
                                                    { td: { children: [t.revoked_at ? { span: {} } : { button: { type: "button", className: "btn ghost", textContent: "Revoke", onclick: () => revoke(t.id) } }] } },
                                                ],
                                            },
                                        })),
                                    },
                                },
                            ],
                        },
                    }),
                ],
            },
        };
    });

    // What an AI drafted in this change, for its reviewers (§16.1).
    juris.registerComponent("AiEdits", ({ id }, api) => ({
        div: {
            className: "ai-edits",
            children: () => {
                api.getState(`dc.${id}.updated_at`);
                const edits = api.peek(`dc.${id}.aiEdits`) ?? [];
                if (!edits.length) return [];
                // Folded: one line saying how much an AI drafted; each edit opens on its own.
                const touched = new Set(edits.flatMap((e) => e.elements)).size;
                return [{
                    details: {
                        key: "ai", className: "ai-edits-fold",
                        children: [
                            { summary: { children: [{ strong: `Drafted with AI (${edits.length} edit${edits.length > 1 ? "s" : ""})` }, { span: { className: "muted small", textContent: ` · ${touched} element(s) · last ${plant().dateTime(edits.at(-1).at)}` } }] } },
                            { ul: { className: "ai-edit-list", children: edits.slice(-12).reverse().map((e, i) => ({ li: { key: i, children: [{ details: { children: [
                                { summary: { className: "small", textContent: `${plant().dateTime(e.at)} · ${e.via.agent} (“${e.via.token}”) · ${e.elements.length} element(s)` } },
                                { ul: { className: "ai-edit-elements small", children: e.elements.map((el, k) => ({ li: { key: k, textContent: el } })) } },
                            ] } }] } })) } },
                            edits.length > 12 ? { p: { className: "muted small", textContent: `…and ${edits.length - 12} earlier edit(s).` } } : { span: {} },
                        ],
                    },
                }];
            },
        },
    }));

    // Several windows on one change (split view): each shows any view of the same working copy, so an
    // edit in one is in the others at once. At most three, side by side.
    juris.registerComponent("PaneSet", ({ id, editable }, api) => {
        const w = W(id);
        // Reviewers and approvers start on what changed; a designer, on the model.
        if (!api.peek(`${w}.panes`)) api.setValue(`${w}.panes`, [{ view: ["review", "approval"].includes(api.peek(`dc.${id}.state`)) ? "changes" : "general" }]);
        const split = () => {
            const panes = api.peek(`${w}.panes`) ?? [];
            if (panes.length >= 3) return;
            const next = objectViews().map(([key]) => key).find((key) => !panes.some((p) => p.view === key)) ?? "preview";
            api.setValue(`${w}.panes`, [...panes, { view: panes.length === 1 ? "preview" : next }]);
        };
        return {
            div: {
                className: "paneset",
                children: [
                    {
                        div: {
                            className: "pane-bar",
                            children: [
                                { span: { className: "muted small", textContent: () => `${api.getState(`${w}.panes.length`, 1)} window(s) on this ${String(id).startsWith("view-") ? "design" : "change"}` } },
                                { span: { className: "spacer" } },
                                () => (api.prop(editable) ? { IncludeLive: { id } } : { span: {} }),
                                () => (api.prop(editable) ? { AddElement: { id } } : { span: {} }),
                                { button: { type: "button", className: "btn", children: [icon("split"), { span: "Split" }], title: "Open another window beside this one (up to 3)", disabled: () => api.getState(`${w}.panes.length`, 1) >= 3, onclick: split } },
                                // The designer filling the window (as a transaction's or a screen's page, §25.1): the
                                // navigator, the top bar and the tabs set aside for the canvas and the editors; kept per device.
                                { MaximizeToggle: { key: `max-${id}`, path: api.peek("$route.path") ?? (String(id).startsWith("view-") ? "/design" : `/design/c/${id}`), mode: "toggle", remember: "designer" } },
                            ],
                        },
                    },
                    {
                        div: {
                            className: () => `panes n${api.getState(`${w}.panes.length`, 1)}`,
                            children: () => {
                                const count = api.getState(`${w}.panes.length`, 1);
                                return Array.from({ length: count }, (_, i) => ({ PaneEditor: { key: `pane-${i}`, id, editable, pane: i } }));
                            },
                        },
                    },
                ],
            },
        };
    });

    // One window: the element of the change it shows (the object, a service, a connection), and
    // that element's editor. A change can hold several (an integration: a connection and its services).
    juris.registerComponent("PaneEditor", ({ id, editable, pane = 0 }, api) => {
        const w = W(id);
        const elements = () => {
            api.getState(`${w}.rev`);
            return [
                ...Object.keys(draftDefinitions(api, w)).map((o) => ({ key: `object:${o}`, label: `object ${o}` })),
                ...Object.keys(api.peek(`${w}.sv`) ?? {}).map((n) => ({ key: `service:${n}`, label: `service ${n}` })),
                ...Object.keys(api.peek(`${w}.cn`) ?? {}).map((n) => ({ key: `connection:${n}`, label: `connection ${n}` })),
                ...Object.keys(api.peek(`${w}.tx`) ?? {}).map((n) => ({ key: `transaction:${n}`, label: `transaction ${n}` })),
                ...Object.keys(api.peek(`${w}.sc`) ?? {}).map((n) => ({ key: `screen:${n}`, label: `screen ${n}` })),
                ...Object.keys(api.peek(`${w}.fl`) ?? {}).map((n) => ({ key: `flow:${n}`, label: `flow ${n}` })),
                ...Object.keys(api.peek(`${w}.ly`) ?? {}).map((n) => ({ key: `layout:${n}`, label: `report layout ${n}` })),
                ...Object.keys(api.peek(`${w}.el`) ?? {}).map((n) => ({ key: `element:${n}`, label: `design element ${n}` })),
                ...(api.peek(`${w}.org`) ? [{ key: "organization", label: "people & departments" }] : []),
            ];
        };
        // An object's key follows the object the editor has open (one for the whole change).
        const current = () => {
            const list = elements();
            const el = api.getState(`${w}.panes.${pane}.el`, null);
            const open = `object:${api.getState(`${w}.object`, null)}`;
            const chosen = el === "object" || el?.startsWith("object:") ? open : el;
            return list.find((e) => e.key === chosen)?.key ?? list.find((e) => e.key === open)?.key ?? list[0]?.key ?? null;
        };
        // Which of the change's elements this window shows: a row of its own above the tabs.
        const picker = () => (elements().length > 1 ? {
            label: {
                className: "el-row",
                children: [
                    { span: { className: "muted small", textContent: `This window shows (${elements().length} in this ${String(id).startsWith("view-") ? "view" : "change"})` } },
                    {
                        select: {
                            className: "el-picker", title: "What this window shows",
                            onchange: (e) => {
                                if (e.target.value.startsWith("object:")) openObject(api, w, e.target.value.slice(7));
                                api.setValue(`${w}.panes.${pane}`, { view: e.target.value.startsWith("flow:") ? "canvas" : "general", el: e.target.value });
                            },
                            children: noDefault(elements().map((e) => ({ option: { value: e.key, selected: e.key === current(), textContent: e.label } }))),
                        },
                    },
                ],
            },
        } : { span: {} });
        return {
            div: {
                className: "pane-editor",
                children: () => {
                    const el = current();
                    if (!el) return [{ p: { className: "muted", textContent: api.peek(`dc.${id}`) ? "This change holds nothing yet." : "Loading…" } }];
                    if (el.startsWith("object:")) return [{ DefinitionEditor: { key: el, id, editable, pane, head: picker() } }];
                    if (el === "organization") return [{ OrganizationEditor: { key: el, id, editable, pane, head: picker() } }];
                    const [kind, name] = el.split(":");
                    if (kind === "transaction") return [{ TransactionEditor: { key: el, id, editable, pane, name, head: picker() } }];
                    if (kind === "screen") return [{ ScreenEditor: { key: el, id, editable, pane, name, head: picker() } }];
                    if (kind === "flow") return [{ FlowEditor: { key: el, id, editable, pane, name, head: picker() } }];
                    if (kind === "layout") return [{ LayoutEditor: { key: el, id, editable, pane, name, head: picker() } }];
                    if (kind === "element") return [{ SuiteElementEditor: { key: el, id, editable, pane, name, head: picker() } }];
                    return [{ IntegrationEditor: { key: el, id, editable, pane, kind, name, head: picker() } }];
                },
            },
        };
    });

    // Brings a live design into this change (§5.12): several objects, transactions, screens, flows,
    // services and connections changed together, reviewed once and approved once by each department any
    // of them touches, executed all or nothing. Unsaved edits are saved first, so the change reloads
    // with nothing lost; the one brought in opens in the first window. One in another open change is
    // offered, marked, and refused by the server naming that change.
    juris.registerComponent("IncludeLive", ({ id }, api) => {
        const w = W(id);
        const [pick, setPick] = api.useState("pick", "");
        const KINDS = [["object", "objects", "Objects"], ["transaction", "transactions", "Transactions"], ["screen", "screens", "Screens"], ["flow", "flows", "Flow templates"], ["layout", "layouts", "Report layouts"], ["service", "services", "Services"], ["connection", "connections", "Connections"]];
        const SLOT = { transaction: "tx", screen: "sc", flow: "fl", layout: "ly", service: "sv", connection: "cn", element: "el" };
        const inHere = (kind, name) => (kind === "object" ? Object.hasOwn(draftDefinitions(api, w), name) : Object.hasOwn(api.peek(`${w}.${SLOT[kind]}`) ?? {}, name));
        const groups = () => {
            api.getState(`${w}.rev`);
            return KINDS.map(([kind, list, label]) => [kind, label, (api.getState(`design.home.${list}`, []) ?? [])
                .map((x) => ({ name: x.object ?? x.name, label: x.label ?? x.object ?? x.name, elsewhere: (x.open ?? []).some((o) => (o?.id ?? o) !== id) }))
                .filter((x) => !inHere(kind, x.name))
                .sort((a, b) => String(a.label).localeCompare(String(b.label)))]).filter(([, , l]) => l.length);
        };
        const open = (kind, name) => {
            if (kind === "object") openObject(api, w, name);
            api.setValue(`${w}.panes.0`, { view: kind === "flow" ? "canvas" : "general", el: `${kind}:${name}` });
        };
        const bring = async () => {
            const [kind, name] = String(pick()).split(":");
            if (!kind || !name) return;
            api.batch(() => { api.setValue(`${w}.busy`, true); api.setValue(`${w}.error`, null); api.setValue(`${w}.notice`, null); });
            try {
                if (api.peek(`${w}.dirty`)) {
                    const saved = await api.call("design.save", draftOps(api, id).payload());
                    api.batch(() => { api.setValue(`${w}.dirty`, false); api.setValue(`${w}.seen`, saved.draft_rev); });
                }
                const result = await api.call("design.include", { id, kind, name, seen: api.peek(`${w}.seen`) });
                setPick("");
                const label = groups().flatMap(([, , l]) => l).find((x) => x.name === name)?.label ?? name;
                api.setValue(`${w}.notice`, result.already ? `${label} is in this change already.` : `${label} is in this change, as it is live: change it here with the rest. One review, and one approval from each department any of them touches.`);
                // Opened once the change has reloaded with it (its draft_rev reached).
                if (Number(api.peek(`${w}.seen`)) >= Number(result.draft_rev)) open(kind, name);
                else {
                    const stop = api.bindState(() => api.getState(`${w}.seen`), () => { if (Number(api.peek(`${w}.seen`)) >= Number(result.draft_rev)) { stop(); open(kind, name); } });
                    setTimeout(stop, 10_000);
                }
            } catch (e) {
                api.setValue(`${w}.error`, e.message);
            } finally {
                api.setValue(`${w}.busy`, false);
            }
        };
        return () => (groups().length ? {
            span: {
                className: "add-element include-live",
                children: [
                    {
                        select: {
                            title: "A live design to change in this change too", "aria-label": "Change also",
                            onchange: (e) => setPick(e.target.value),
                            children: noDefault([
                                { option: { value: "", selected: !pick(), textContent: "Change also…" } },
                                ...groups().map(([kind, label, list]) => ({ optgroup: { key: kind, label, children: list.map((x) => ({ option: { key: `${kind}:${x.name}`, value: `${kind}:${x.name}`, selected: pick() === `${kind}:${x.name}`, textContent: `${x.label}${x.elsewhere ? " (in another change)" : ""}` } })) } })),
                            ]),
                        },
                    },
                    { button: { type: "button", className: "btn", textContent: "Bring in", title: "Its live design becomes part of this change", disabled: () => !pick() || api.getState(`${w}.busy`, false), onclick: bring } },
                ],
            },
        } : { span: {} });
    });

    // Adds a new service or connection to this change (its author, in design).
    juris.registerComponent("AddElement", ({ id }, api) => {
        const w = W(id);
        const [state, setState] = api.useState("add", { kind: "", name: "", from: "" });
        const SLOT = { service: "sv", connection: "cn", transaction: "tx", screen: "sc", flow: "fl", layout: "ly", element: "el" };
        // What a new transaction, screen or flow may be a copy of: those of its kind in this change, and the live ones.
        const sources = (kind) => {
            if (!COPYABLE.includes(kind)) return [];
            const here = Object.entries(api.getState(`${w}.${SLOT[kind]}`, {}) ?? {}).map(([n, b]) => ({ name: n, label: b?.label ?? n, here: true }));
            const live = (api.getState(`design.home.${kind}s`, []) ?? []).filter((x) => !here.some((h) => h.name === x.name)).map((x) => ({ name: x.name, label: x.label ?? x.name }));
            return [...here, ...live];
        };
        const add = async () => {
            const { kind, name, from } = state();
            const slot = SLOT[kind];
            if ((api.peek(`${w}.${slot}`) ?? {})[name] || (api.peek(`design.home.${kind}s`) ?? []).some((x) => x.name === name)) {
                api.setValue(`${w}.error`, `A ${kind} "${name}" exists already: bring it into this change with Change also, or change it from the designer's home.`);
                return;
            }
            const home = api.peek("design.home") ?? {};
            const stewards = [(home.departments ?? [])[0]?.id].filter(Boolean);
            // A copy: of the one in this change as drawn so far, or of the live one.
            let source = null;
            let sourceScript = null; // a service's own script, copied with it
            if (from && COPYABLE.includes(kind)) {
                source = (api.peek(`${w}.${slot}`) ?? {})[from] ?? null;
                sourceScript = source && kind === "service" ? api.peek(`${w}.s.${from}`) ?? null : null;
                if (!source) {
                    try {
                        const view = await api.call("design.view", { kind, name: from });
                        source = view?.content?.[`${kind}s`]?.[from] ?? null;
                        sourceScript = view?.content?.scripts?.[from] ?? null;
                    } catch (e) {
                        api.setValue(`${w}.error`, e.message);
                        return;
                    }
                }
                if (!source) {
                    api.setValue(`${w}.error`, `There is no ${kind} "${from}" to copy.`);
                    return;
                }
            }
            const body = source ? copyDesign(kind, source, { name }) : kind === "service"
                ? { name, label: name, description: "", input: {}, http: { enabled: true }, callers: { users: [], groups: [] }, on: [], runAs: "service", roles: {}, uses: { connections: [], objects: {} }, stewards }
                : kind === "transaction" ? TRANSACTION_TEMPLATE(name, stewards)
                    : kind === "screen" ? SCREEN_TEMPLATE(name, stewards)
                    : kind === "flow" ? FLOW_TEMPLATE(name, name, stewards)
                    : kind === "layout" ? LAYOUT_TEMPLATE(name, name, stewards)
                    : { name, label: name, baseUrl: "https://example.com/api", auth: { kind: "bearer", secret: name }, allow: [{ method: "GET", path: "/*" }], timeoutMs: 5000, stewards };
            api.batch(() => {
                api.setValue(`${w}.${slot}.${name}`, body);
                if (kind === "service" && api.peek(`${w}.s.${name}`) === undefined) api.setValue(`${w}.s.${name}`, sourceScript ? copyScript(sourceScript, from, name) : SERVICE_TEMPLATE(name));
                api.setValue(`${w}.dirty`, true);
                api.setValue(`${w}.rev`, (api.peek(`${w}.rev`) ?? 0) + 1);
                api.setValue(`${w}.vrev`, (api.peek(`${w}.vrev`) ?? 0) + 1);
                api.setValue(`${w}.panes.0`, { view: "general", el: `${kind}:${name}` });
            });
            setState({ kind: "", name: "", from: "" });
        };
        return {
            span: {
                className: "add-element",
                children: [
                    { select: { title: "Add to this change", onchange: (e) => setState({ ...state(), kind: e.target.value, from: "" }), children: noDefault([["service", "+ service"], ["connection", "+ connection"], ["transaction", "+ transaction"], ["screen", "+ screen"], ["flow", "+ flow template"], ["layout", "+ report layout"]].map(([v, l]) => ({ option: { key: v, value: v, selected: () => state().kind === v, textContent: l } })), "add to this change…") } },
                    { input: { placeholder: "name", value: () => state().name, oninput: (e) => setState({ ...state(), name: e.target.value.trim().toLowerCase() }) } },
                    // One stable select, its options following the kind: blank, or a copy of one of its kind.
                    { select: { title: "Start it blank, or as a copy of another", hidden: () => !COPYABLE.includes(state().kind), value: () => state().from, onchange: (e) => setState({ ...state(), from: e.target.value }), children: noDefault(() => [{ option: { value: "", textContent: "blank" } }, ...sources(state().kind).map((x) => ({ option: { key: x.name, value: x.name, textContent: `a copy of ${x.label}${x.here ? " (in this change)" : ""}` } }))]) } },
                    { button: { type: "button", className: "btn", textContent: "Add", disabled: () => !state().kind || !IDENTIFIER.test(state().name), onclick: add } },
                ],
            },
        };
    });

    juris.registerComponent("DefinitionEditor", ({ id, editable, pane = 0, head }, api) => {
        const w = W(id);
        const ops = draftOps(api, id);
        const view = () => api.getState(`${w}.panes.${pane}.view`, "general");
        const setView = (key) => api.setValue(`${w}.panes.${pane}.view`, key);
        const close = () => {
            const panes = [...(api.peek(`${w}.panes`) ?? [])];
            panes.splice(pane, 1);
            api.setValue(`${w}.panes`, panes.length ? panes : [{ view: "general" }]);
        };
        const ro = () => !api.prop(editable);
        return {
            div: {
                className: "editor",
                children: [
                    {
                        div: {
                            className: "editor-head",
                            children: [
                                head ?? { span: {} },
                                { nav: { className: "subtabs", children: objectViews().map(([key, label, glyph]) => ({ button: { key, type: "button", className: "subtab", classList: { active: () => view() === key }, onclick: () => setView(key), children: [glyph ? icon(glyph) : { span: {} }, { span: label }, () => {
                                    // How many differences from the published version this tab holds.
                                    api.getState(`${w}.vrev`);
                                    api.getState(`dc.${id}.updated_at`);
                                    const object = api.peek(`${w}.object`);
                                    const all = object ? changesOf(api, id, "object", object) : [];
                                    const n = key === "changes" ? all.length : countByTab(all)[key] ?? 0;
                                    return n ? { span: { className: "tab-diff", title: `${n} change(s) from the published version`, textContent: String(n) } } : { span: {} };
                                }] } })) } },
                                () => (api.getState(`${w}.panes.length`, 1) > 1 ? { button: { type: "button", className: "tab-close", title: "Close this window", "aria-label": "Close this window", children: [icon("x")], onclick: close } } : { span: {} }),
                            ],
                        },
                    },
                    () => {
                        api.getState(`${w}.rev`);
                        const body = api.peek(`${w}.b`);
                        if (!body) return { p: { className: "muted", textContent: "Loading…" } };
                        const which = view();
                        // What differs from the published version, to mark inside the tabs.
                        const live = api.peek(`dc.${id}.live.definitions.${api.peek(`${w}.object`)}`) ?? null;
                        const diff = statusMaps(live, body);
                        const ctx = { api, w, ops, ro, body, id, diff, live };
                        if (which === "changes") return { ChangesView: { key: `changes-${id}`, id, kind: "object", name: api.peek(`${w}.object`), onOpen: setView } };
                        if (which === "general") return generalTab(ctx);
                        if (which === "fields") return fieldsTab(ctx);
                        if (which === "states") return statesTab(ctx);
                        if (which === "access") return accessTab(ctx);
                        if (which === "rules") return rulesTab(ctx);
                        if (which === "layout") return layoutTab(ctx);
                        if (which === "preview") return { LivePreview: { id } };
                        if (which === "copilot") return { CopilotPanel: { key: `copilot-${id}`, id } };
                        if (which === "stewards") return stewardsTab(ctx);
                        // A suite's part of the design, drawn by the suite's own component.
                        if (which.startsWith("suite:")) {
                            const suite = which.slice("suite:".length);
                            const d = suiteDesigns.object[suite];
                            return d?.component ? { [d.component]: { key: `${which}-${id}`, id, w, ops, ro, body, live, suite } } : { p: { className: "muted", textContent: `The suite "${suite}" is not installed here.` } };
                        }
                        return jsonTab(ctx);
                    },
                ],
            },
        };
    });

    // The copilot (§16.3): a conversation with the configured AI inside this change. It drafts and checks
    // through the design tools as this person; the draft it saves arrives in every window like any save.
    juris.registerComponent("CopilotPanel", ({ id }, api) => {
        // A live design being viewed is not a change: the copilot drafts in one.
        if (String(id).startsWith("view-")) return { p: { className: "muted", textContent: "The copilot works inside a change: press Change it above, and ask it there." } };
        const w = W(id);
        const C = `cp.${id}`;
        // What is being typed belongs to the change, not to this panel: it survives switching tabs and
        // pages (app state) and a reload, such as the page's own on a server update (this browser's
        // storage, the viewer's convenience only; it may be unavailable).
        const keyOf = `mes.copilot.draft.${id}`;
        const stored = () => { try { return globalThis.localStorage?.getItem(keyOf) ?? ""; } catch { return ""; } };
        if (!api.isServer && api.peek(`${C}.draft`) === undefined) api.setValue(`${C}.draft`, stored());
        const draft = () => api.getState(`${C}.draft`, "") ?? "";
        const setDraft = (text) => {
            api.setValue(`${C}.draft`, text);
            try { if (text) globalThis.localStorage?.setItem(keyOf, text); else globalThis.localStorage?.removeItem(keyOf); } catch { /* storage may be off */ }
        };
        let timer = null;
        let seenSaves = 0;
        const apply = (v) => {
            api.setValue(`${C}.view`, v);
            // The copilot saved the draft: re-run this change's live views, so every window shows it.
            if (v.saves > seenSaves) { seenSaves = v.saves; api.call("copilot.refresh", { change: id }).catch(() => {}); }
        };
        const poll = () => {
            clearTimeout(timer);
            api.call("copilot.get", { change: id }).then((v) => {
                apply(v);
                if (v.running) timer = setTimeout(poll, 700);
            }, () => { timer = setTimeout(poll, 2000); });
        };
        if (!api.isServer) {
            api.onMount(() => {
                api.call("copilot.status").then((st) => api.setValue(`${C}.status`, st), () => {});
                api.call("copilot.get", { change: id }).then((v) => { seenSaves = v.saves; api.setValue(`${C}.view`, v); if (v.running) poll(); }, () => {});
                return () => clearTimeout(timer);
            });
        }
        const send = async () => {
            const text = draft().trim();
            if (!text) return;
            api.setValue(`${C}.error`, null);
            try {
                // The person's unsaved edits are saved first, so the AI works on what they see.
                if (api.peek(`${w}.dirty`)) {
                    const saved = await api.call("design.save", draftOps(api, id).payload());
                    api.batch(() => { api.setValue(`${w}.dirty`, false); api.setValue(`${w}.seen`, saved.draft_rev); });
                }
                setDraft("");
                const files = (api.peek(`${C}.files`) ?? []).map(({ blob, name }) => ({ blob, name }));
                apply(await api.call("copilot.send", { change: id, text, ...(files.length ? { attachments: files } : {}) }));
                api.setValue(`${C}.files`, []);
                poll();
            } catch (e) {
                api.setValue(`${C}.error`, e.message);
            }
        };
        // A new conversation: the one kept with this change is deleted, so it is asked first.
        const reset = async () => {
            if ((api.peek(`${C}.view.transcript`) ?? []).length && !(await confirmDialog(api, { title: "Start a new conversation?", message: "The conversation kept with this change is deleted; the draft stays as it is.", confirm: "Start anew", danger: true }))) return;
            api.call("copilot.reset", { change: id }).then(() => api.setValue(`${C}.view`, { transcript: [], running: false, saves: 0 }), (e) => api.setValue(`${C}.error`, e.message));
        };
        const canEdit = () => api.getState(`dc.${id}.can.edit`, false);
        return {
            div: {
                className: "copilot",
                children: [
                    () => {
                        const st = api.getState(`${C}.status`, null);
                        if (!st) return { p: { className: "muted small", textContent: "…" } };
                        if (!st.configured) return { p: { className: "copilot-off", textContent: st.hint } };
                        return { p: { className: "muted small", textContent: `${st.provider === "anthropic" ? "Claude" : st.provider} · ${st.model}. It drafts and checks through the design tools as you; you submit, others review and approve.${canEdit() ? "" : " This change is not open for your edits, so it can read and explain but not save."}` } };
                    },
                    // Kept with the change: it picks up here, any time.
                    () => {
                        const v = api.getState(`${C}.view`, null);
                        if (!v?.transcript?.length || !v.started_at) return { span: {} };
                        return { p: { className: "muted small icon-text", children: [icon("archive"), { span: `Kept with this change: started ${plant().dateTime(v.started_at)}, last ${plant().dateTime(v.updated_at)}. It picks up here, any time.` }] } };
                    },
                    {
                        div: {
                            id: `copilot-log-${id}`,
                            className: "copilot-log",
                            children: () => {
                                const v = api.getState(`${C}.view`, null);
                                const items = v?.transcript ?? [];
                                // The newest message in view once it is drawn.
                                if (!api.isServer) setTimeout(() => { const el = globalThis.document?.getElementById(`copilot-log-${id}`); if (el) el.scrollTop = el.scrollHeight; }, 0);
                                const out = items.map((m, i) => (m.role === "tool"
                                    ? { div: { key: i, className: `cp-tool icon-text ${m.ok ? "ok" : "bad"}`, children: [icon(m.ok ? "check" : "x"), { span: `${m.name.replace(/_/g, " ")} — ${m.text}` }] } }
                                    : m.role === "assistant" ? { div: { key: i, className: "cp-msg assistant", children: richText(m.text) } }
                                    : m.files?.length ? { div: { key: i, className: `cp-msg ${m.role}`, children: [{ div: m.text }, fileChips(m.files)] } }
                                    : { div: { key: i, className: `cp-msg ${m.role}`, textContent: m.text } }));
                                if (v?.running) out.push({ div: { key: "working", className: "cp-working", textContent: `Working… (step ${v.step || 1})` } });
                                if (!items.length && !v?.running) out.push({ p: { key: "empty", className: "muted small", textContent: "Ask for a change (\"add a moisture field that Quality can edit while on hold, with a rule that it is between 0 and 5\"), or ask a question about the model." } });
                                return out;
                            },
                        },
                    },
                    {
                        div: {
                            className: "copilot-input",
                            children: [
                                { AttachFiles: { key: `copilot-files-${id}`, path: `${C}.files`, disabled: () => Boolean(api.getState(`${C}.view.running`, false)) } },
                                { textarea: { ...pasteFiles(api, `${C}.files`), rows: 3, placeholder: "Ask the copilot…", value: () => draft(), disabled: () => Boolean(api.getState(`${C}.view.running`, false)), oninput: (e) => setDraft(e.target.value), onkeydown: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } } } },
                                { div: { className: "copilot-buttons", children: [
                                    { button: { type: "button", className: "btn primary", textContent: "Send", disabled: () => !draft().trim() || Boolean(api.getState(`${C}.view.running`, false)) || !api.getState(`${C}.status.configured`, false), onclick: send } },
                                    { button: { type: "button", className: "btn ghost", textContent: "New conversation", disabled: () => Boolean(api.getState(`${C}.view.running`, false)), onclick: reset } },
                                    { span: { className: "error small", textContent: () => api.getState(`${C}.error`, "") ?? "" } },
                                ] } },
                            ],
                        },
                    },
                ],
            },
        };
    });

    // The form as the draft draws it, redrawn on every edit in any window.
    juris.registerComponent("LivePreview", ({ id }, api) => ({
        div: {
            className: "live-preview",
            children: () => {
                api.getState(`${W(id)}.vrev`);
                const body = api.peek(`${W(id)}.b`);
                if (!body) return [];
                return [
                    { p: { key: "h", className: "muted small", textContent: `How a ${body.label} form looks ${String(id).startsWith("view-") ? "as it is live" : "with this draft"} (inputs disabled).` } },
                    { FormPreview: { key: `p-${api.peek(`${W(id)}.vrev`)}`, body: clone(body) } },
                ];
            },
        },
    }));
}

const VIEWS = [["copilot", "Copilot", "sparkle"], ["changes", "Changes"], ["general", "General"], ["fields", "Fields"], ["states", "States"], ["access", "Roles & policies"], ["rules", "Rules"], ["layout", "Layout"], ["preview", "Preview"], ["stewards", "Stewards"], ["json", "JSON"]];
// The object editor's tabs: the platform's, then a tab per installed suite with a part of an object's
// design (§29.4, suite-registry.js), before the JSON.
const objectViews = () => [...VIEWS.slice(0, -1), ...Object.entries(suiteDesigns.object).map(([name, d]) => [`suite:${name}`, d.label ?? name]), VIEWS.at(-1)];

// ---- the working copy ----
// A change's content (or a live design's, design.view) into the editors' working copy. The object open
// in the editor stays open when the change moves on; the others wait in .defs.
function loadWorkspace(api, w, change) {
    // The object open in the editor stays open when the change moves on; the others wait in .defs.
    const was = api.peek(`${w}.object`);
    const object = change.objects.includes(was) ? was : change.objects[0] ?? null;
    api.batch(() => {
        api.setValue(`${w}.object`, object);
        api.setValue(`${w}.defs`, clone(change.content.definitions ?? {}));
        api.setValue(`${w}.b`, clone(change.content.definitions?.[object] ?? null));
        api.setValue(`${w}.s`, clone(change.content.scripts ?? {}));
        api.setValue(`${w}.sv`, clone(change.content.services ?? {}));
        api.setValue(`${w}.cn`, clone(change.content.connections ?? {}));
        api.setValue(`${w}.tx`, clone(change.content.transactions ?? {}));
        api.setValue(`${w}.sc`, clone(change.content.screens ?? {}));
        api.setValue(`${w}.fl`, clone(change.content.flows ?? {}));
        api.setValue(`${w}.ly`, clone(change.content.layouts ?? {}));
        api.setValue(`${w}.el`, clone(change.content.elements ?? {}));
        api.setValue(`${w}.org`, change.content.organization ? clone(change.content.organization) : null);
        api.setValue(`${w}.t`, clone(change.content.tests ?? {}));
        api.setValue(`${w}.casesRev`, (api.peek(`${w}.casesRev`) ?? 0) + 1);
        api.setValue(`${w}.title`, change.title);
        api.setValue(`${w}.reason`, change.reason);
        api.setValue(`${w}.seen`, change.draft_rev);
        api.setValue(`${w}.rev`, (api.peek(`${w}.rev`) ?? 0) + 1);
        api.setValue(`${w}.vrev`, (api.peek(`${w}.vrev`) ?? 0) + 1);
    });
}

function draftOps(api, id) {
    const w = W(id);
    const bump = (key) => api.setValue(`${w}.${key}`, (api.peek(`${w}.${key}`) ?? 0) + 1);
    const touched = (structural) => {
        api.setValue(`${w}.dirty`, true);
        bump("vrev");
        if (structural) bump("rev");
    };
    return {
        // A leaf edit: the input keeps its node; only the checks re-run.
        set(path, value, structural = false) {
            api.setValue(`${w}.b.${path}`, value);
            touched(structural);
        },
        // A change of shape (add, remove, retype): the editor redraws.
        edit(fn) {
            const copy = clone(api.peek(`${w}.b`));
            fn(copy);
            api.setValue(`${w}.b`, copy);
            touched(true);
        },
        setScript(name, source, structural = false) {
            api.setValue(`${w}.s.${name}`, source);
            touched(structural);
        },
        payload() {
            const drafted = draftDefinitions(api, w);
            return {
                id, title: api.peek(`${w}.title`), reason: api.peek(`${w}.reason`) ?? "", seen: api.peek(`${w}.seen`) ?? undefined,
                ...(Object.keys(drafted).length ? { definitions: clone(drafted) } : {}),
                scripts: clone(api.peek(`${w}.s`) ?? {}),
                services: clone(api.peek(`${w}.sv`) ?? {}),
                connections: clone(api.peek(`${w}.cn`) ?? {}),
                transactions: clone(api.peek(`${w}.tx`) ?? {}),
                screens: clone(api.peek(`${w}.sc`) ?? {}),
                flows: clone(api.peek(`${w}.fl`) ?? {}),
                layouts: clone(api.peek(`${w}.ly`) ?? {}),
                elements: clone(api.peek(`${w}.el`) ?? {}),
                ...(api.peek(`${w}.org`) ? { organization: clone(api.peek(`${w}.org`)) } : {}),
                tests: clone(api.peek(`${w}.t`) ?? {}),
            };
        },
    };
}

function pageProblems(api, id) {
    const w = W(id);
    const drafted = draftDefinitions(api, w);
    const home = api.peek("design.home") ?? {};
    const scripts = api.peek(`${w}.s`) ?? {};
    const known = {
        objects: [...new Set([...(home.objects ?? []).map((o) => o.object), ...Object.keys(drafted)])],
        scripts: [...new Set([...(home.scripts ?? []).map((s) => s.name), ...Object.keys(scripts)])],
        departments: (home.departments ?? []).map((d) => d.id),
        transactions: [...new Set([...(home.transactions ?? []).map((t) => t.name), ...Object.keys(api.peek(`${w}.tx`) ?? {})])],
        suiteDesigns: suiteChecks(),
        // What the platform and the installed suites lock, as it holds now (builtins.js).
        locks: home.locks ?? {},
    };
    const many = Object.keys(drafted).length > 1;
    const problems = Object.entries(drafted).filter(([, body]) => body).flatMap(([object, body]) => validateDefinition(body, known).map((p) => (many ? { ...p, message: `${object}: ${p.message}` } : p)));
    for (const [name, source] of Object.entries(scripts)) problems.push(...validateScript(name, source, compileInPage));
    problems.push(...integrationProblems(api, id));
    problems.push(...transactionProblems(api, id));
    problems.push(...screenProblems(api, id));
    problems.push(...flowProblems(api, id));
    problems.push(...layoutProblemsOf(api, id));
    problems.push(...elementProblemsOf(api, id));
    problems.push(...organizationProblems(api, id));
    return problems;
}

function lifecycleHint(change) {
    switch (change.state) {
        case "design": return "In design: its author edits and submits it.";
        case "review": return "In review: a reviewer other than the author passes it or asks for changes.";
        case "approval": return "Awaiting approval from the departments listed above.";
        case "executed": return `Executed by the platform ${plant().dateTime(change.executed_at)}.`;
        default: return `This change is ${change.state}.`;
    }
}

// ---- the editor's tabs; every input is bound to one leaf of the working copy ----

// Renames the object open in the editor (never published): the draft saved first if edited, then
// renamed on the server with what the change says about it, and the editor reloaded under the new name.
// The editor follows the new name at once, so a reload of the change that arrives before the answer
// opens it under the new name, and a save before that reload sends it under the new name only.
async function renameObject({ api, w, ops, id, body }, to, box) {
    const from = body.object;
    if (!to || to === from) { box.value = from; return; }
    try {
        if (api.peek(`${w}.dirty`)) {
            const saved = await api.call("design.save", ops.payload());
            api.batch(() => { api.setValue(`${w}.dirty`, false); api.setValue(`${w}.seen`, saved.draft_rev); });
        }
        api.setValue(`${w}.object`, to);
        const renamed = await api.call("design.renameObject", { id, from, to });
        const rekey = (all) => Object.fromEntries(Object.entries(all ?? {}).map(([k, v]) => (k === from ? [to, v && { ...v, object: to }] : [k, v])));
        api.batch(() => {
            api.setValue(`${w}.defs`, rekey(api.peek(`${w}.defs`)));
            const open = api.peek(`${w}.b`);
            if (open?.object === from) api.setValue(`${w}.b`, { ...open, object: to });
            api.setValue(`${w}.seen`, renamed.draft_rev);
        });
    } catch (e) {
        api.setValue(`${w}.object`, from);
        box.value = from;
        api.setValue(`${w}.error`, e.message);
    }
}

function generalTab(ctx) {
    const { body } = ctx;
    return {
        div: {
            className: "ed-grid",
            children: [
                // The name: changed until a version is approved (§6.2); after that records carry it.
                ctx.live || ctx.ro()
                    ? labelled("Name", { input: { type: "text", value: body.object, disabled: true } }, ctx.live ? "Fixed: a version is approved, and its records carry the name. Change the label." : "Changed by its author and co-designers.")
                    : labelled("Name", { input: { type: "text", value: body.object, onchange: (e) => renameObject(ctx, e.target.value.trim().toLowerCase(), e.target) } }, "Lower case letters, digits and _. Changeable until the first version is approved; then fixed."),
                labelled("Label", text(ctx, "label")),
                labelled("Area", text(ctx, "area", { structural: true }), "Where it sits in the navigator."),
                labelled("Description", text(ctx, "description", { multiline: true })),
                labelled("Title field", {
                    select: {
                        disabled: ctx.ro,
                        onchange: (e) => ctx.ops.set("titleField", e.target.value, true),
                        children: noDefault(Object.keys(body.fields).map((f) => ({ option: { value: f, selected: body.titleField === f, textContent: f } }))),
                    },
                }, "Names a record in lists, tabs and search."),
                labelled("Analytics dimensions", {
                    input: {
                        type: "text", disabled: ctx.ro, placeholder: "e.g. item, line",
                        value: (body.analytics?.dimensions ?? []).join(", "),
                        onchange: (e) => ctx.ops.edit((b) => {
                            const dims = e.target.value.split(",").map((v) => v.trim()).filter(Boolean);
                            if (dims.length) b.analytics = { ...(b.analytics ?? {}), dimensions: dims };
                            else delete b.analytics;
                        }),
                    },
                }, "Fields copied into each stay in a state, to group analytics by (at most 5). A report groups by the value a record had then."),
                transferControls(ctx),
                flowControls(ctx),
            ],
        },
    };
}

// Flows (§32): whether this object's records take part in flow templates, as what, and (a traveler) its
// step field: the sequence it is at, marked by the route, and moving the route when it is written. A
// template names only objects that opted in, as what they opted in to.
const FLOW_ROLE_WORDS = { traveler: "a traveler: goes through a route (a lot)", resource: "a resource: where a route's work is done (a tool)", subject: "a subject: its events may set a plan off", reference: "a reference: a flow may read it (a product)" };
function flowControls(ctx) {
    const { body } = ctx;
    const as = body.flow?.as ?? [];
    const textFields = Object.entries(body.fields ?? {}).filter(([, f]) => ["string", "enum"].includes(f.type) && !f.multiple);
    const setAs = (role, on) => ctx.ops.edit((b) => {
        const next = new Set(b.flow?.as ?? []);
        if (on) next.add(role); else next.delete(role);
        if (!next.size) delete b.flow;
        else b.flow = { ...(b.flow ?? {}), as: FLOW_ROLES.filter((r) => next.has(r)) };
        if (b.flow && !next.has("traveler")) delete b.flow.step;
    });
    return labelled("Flows", {
        div: { children: [
            { div: { className: "checks", children: FLOW_ROLES.map((r) => ({ label: { key: r, children: [{ input: { type: "checkbox", disabled: ctx.ro, checked: as.includes(r), onchange: (e) => setAs(r, e.target.checked) } }, { span: ` ${FLOW_ROLE_WORDS[r]}` }] } })) } },
            as.includes("traveler") ? labelled("Its step field", {
                select: { disabled: ctx.ro, onchange: (e) => ctx.ops.edit((b) => { if (e.target.value) b.flow.step = e.target.value; else delete b.flow.step; }), children: noDefault([{ option: { value: "", textContent: "no field" } }, ...textFields.map(([f, x]) => ({ option: { value: f, selected: body.flow?.step === f, textContent: x.label ?? f } }))]) },
            }, "The sequence it is at: a route marks it on entering one (as the template: its policies must let the template write it), and a write that moves it (a move, a form, an import) moves the route there.") : { span: {} },
        ] },
    }, "How its records may take part in flows (routes, OCAP). None ticked: they take no part.");
}

// Excel import and export (§24): what a file may do to this model's records. Deny by default; a
// change here is reviewed and approved like any other.
function transferControls(ctx) {
    const { body } = ctx;
    const t = body.transfer ?? {};
    const imp = t.import ?? {};
    const keyFields = Object.entries(body.fields).filter(([, f]) => ["string", "integer", "enum"].includes(f.type)).map(([n]) => n);
    const edit = (fn) => ctx.ops.edit((b) => {
        const next = { export: b.transfer?.export, import: { ...(b.transfer?.import ?? {}) } };
        fn(next);
        const importOn = next.import.create || next.import.update;
        const clean = { ...(next.export === false ? { export: false } : {}), ...(importOn ? { import: next.import } : {}) };
        if (Object.keys(clean).length) b.transfer = clean; else delete b.transfer;
    });
    const box = (checked, label, onchange) => ({ label: { children: [{ input: { type: "checkbox", disabled: ctx.ro, checked, onchange: (e) => onchange(e.target.checked) } }, { span: ` ${label}` }] } });
    return labelled("Excel import and export", {
        div: {
            className: "transfer-controls",
            children: [
                box(t.export !== false, "May be exported", (on) => edit((n) => { n.export = on ? undefined : false; })),
                box(Boolean(imp.create), "Import may create new records", (on) => edit((n) => { n.import.create = on; if (on && !n.import.key) n.import.key = body.titleField; })),
                box(Boolean(imp.update), "Import may update (override) existing records", (on) => edit((n) => { n.import.update = on; if (on && !n.import.key) n.import.key = body.titleField; })),
                {
                    label: {
                        className: "inline", children: [
                            { span: "Rows matched by " },
                            { select: { disabled: ctx.ro, onchange: (e) => edit((n) => { n.import.key = e.target.value || undefined; }), children: noDefault([["", "record id"], ...keyFields.map((f) => [f, f])].map(([v, l]) => ({ option: { value: v, selected: (imp.key ?? "") === v, textContent: l } }))) } },
                        ],
                    },
                },
            ],
        },
    }, "Import goes through the same policies and rules as the forms. Updating needs a field that names one record.");
}

// What the platform and the installed suites lock on this object (builtins.js), in words: who, and why.
const locksOf = (api, object) => api.peek(`design.home.locks.${object}`) ?? [];
const lockWords = (l) => `Locked by ${holderWords(l)}: ${l.why}`;
function locksNote(api, body) {
    const locks = locksOf(api, body.object);
    if (!locks.length && !body.builtIn) return { span: {} };
    return { div: { className: "locks-note", children: [
        icon("lock"),
        { div: { children: [
            body.builtIn ? { p: { children: [{ strong: "Built in. " }, { span: "The platform publishes it in every installation; add what the plant needs, and change it like any other design." }] } } : { span: {} },
            ...locks.map((l, i) => ({ p: { key: `l${i}`, className: "small", textContent: `${lockWords(l)}${Object.keys(l.fields ?? {}).length ? ` Fields: ${Object.keys(l.fields).join(", ")}.` : ""}${l.managed?.length ? ` Kept in People & departments: ${l.managed.join(", ")}.` : ""}${l.keep ? " It cannot be retired." : ""}` } })),
        ] } },
    ] } };
}

function fieldsTab(ctx) {
    const { api, w, ops, ro, body } = ctx;
    const objects = (api.peek("design.home.objects") ?? []).map((o) => o.object);
    // A field something relies on: kept, its type fixed (its lock in the row says by whom).
    const lockOn = (name) => locksOf(api, body.object).find((l) => l.fields?.[name]);
    // A field a suite added: its suite named, said so when it is no longer installed (what it left stays, inert).
    const suiteOf = (suite) => { const pack = (api.peek("design.home.packs") ?? []).find((p) => p.suite === suite); return pack ? `Added by ${holderWords({ by: "suite", owner: pack.from ?? suite })}` : `Added by ${holderWords({ by: "suite", owner: suite })} (not installed now)`; };
    return {
        div: {
            children: [
                locksNote(api, body),
                {
                    table: {
                        className: "grid ed-table",
                        children: [
                            { thead: { children: [{ tr: { children: ["Name", "Label", "Type", "Required", "Values / refers to", ""].map((h) => ({ th: h })) } }] } },
                            {
                                tbody: {
                                    children: [...Object.entries(body.fields).map(([name, field]) => ({
                                        tr: {
                                            key: name,
                                            className: ctx.diff?.fields?.[name] ? `diff-${ctx.diff.fields[name]}` : "",
                                            children: [
                                                { td: { children: [fieldName(ctx, name), diffPill(ctx.diff?.fields?.[name]), lockOn(name) ? { span: { className: "field-lock", title: lockWords(lockOn(name)), "aria-label": lockWords(lockOn(name)), children: [icon("lock")] } } : { span: {} }, field.suite ? { div: { className: "muted small", textContent: suiteOf(field.suite) } } : { span: {} }] } },
                                                { td: { children: [text(ctx, `fields.${name}.label`)] } },
                                                {
                                                    td: {
                                                        children: [{
                                                            select: {
                                                                disabled: () => ro() || Boolean(lockOn(name)),
                                                                title: lockOn(name) ? lockWords(lockOn(name)) : undefined,
                                                                onchange: (e) => ops.edit((b) => {
                                                                    const f = b.fields[name];
                                                                    f.type = e.target.value;
                                                                    if (f.type !== "enum") { delete f.values; delete f.multiple; } else f.values ??= ["a", "b"];
                                                                    if (f.type !== "ref") delete f.to; else f.to ??= objects[0];
                                                                }),
                                                                children: noDefault(FIELD_TYPES.map((t) => ({ option: { value: t, selected: field.type === t, textContent: t } }))),
                                                            },
                                                        }],
                                                    },
                                                },
                                                { td: { children: [{ input: { type: "checkbox", disabled: ro, checked: () => Boolean(api.getState(`${w}.b.fields.${name}.required`, false)), onchange: (e) => ops.set(`fields.${name}.required`, e.target.checked) } }] } },
                                                {
                                                    td: {
                                                        children: [field.type === "enum" ? { div: { className: "values-cell", children: [
                                                            listInput(ctx, `fields.${name}.values`, "a, b, c"),
                                                            // Several values: a list of them, drawn as checkboxes, a multi-select or chips (Layout).
                                                            { label: { className: "small", title: "Stored values are converted when the change executes", children: [{ input: { type: "checkbox", disabled: ro, checked: Boolean(field.multiple), onchange: (e) => ops.edit((b) => { if (e.target.checked) b.fields[name].multiple = true; else delete b.fields[name].multiple; }) } }, { span: " several values" }] } },
                                                        ] } }
                                                            : field.type === "ref" ? { select: { disabled: ro, onchange: (e) => ops.set(`fields.${name}.to`, e.target.value, true), children: noDefault(objects.map((o) => ({ option: { value: o, selected: field.to === o, textContent: o } }))) } }
                                                                : { span: { className: "muted", textContent: "—" } }],
                                                    },
                                                },
                                                { td: { children: [ro() ? { span: {} } : lockOn(name) ? { span: { className: "muted small icon-text", title: lockWords(lockOn(name)), children: [icon("lock"), { span: "kept" }] } } : { button: { type: "button", className: "btn ghost", title: "Remove the field", textContent: "Remove", onclick: () => ops.edit((b) => { delete b.fields[name]; }) } }] } },
                                            ],
                                        },
                                    })), ...(ctx.diff?.removedFields ?? []).map((name) => ({ tr: { key: `removed-${name}`, className: "diff-removed", children: [{ td: { children: [{ code: name }, diffPill("removed")] } }, { td: { colSpan: 5, className: "muted small", textContent: "Removed by this change" } }] } }))],
                                },
                            },
                        ],
                    },
                },
                ro() ? { span: {} } : addRow(ctx, "New field name (e.g. batch_size)", (name, b) => {
                    if (b.fields[name]) return `"${name}" exists already.`;
                    b.fields[name] = { label: name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), type: "string" };
                    // Placed at the end of the form's last section (Layout moves it).
                    const form = normalizeForm(b);
                    const lastTab = form.tabs[form.tabs.length - 1];
                    if (!lastTab.sections.length) lastTab.sections.push({ label: "Details", fields: [] });
                    lastTab.sections[lastTab.sections.length - 1].fields.push({ field: name });
                    b.form = storeForm(form, b);
                    return null;
                }),
            ],
        },
    };
}

// A field's name: renamed (everywhere the object names it) until it is published; after that its
// records hold their values under it, so it stays, and the label is what people see.
function fieldName({ api, ops, ro, body, live }, name) {
    if (ro()) return { code: name };
    if (live?.fields?.[name]) return { code: { className: "field-name locked", title: "Published: its records keep their values under this name, so it stays. Change the label (what people see); for another name, add a field and remove this one.", textContent: name } };
    const rename = async () => {
        const to = await askDialog(api, {
            title: `Rename the field "${name}"`,
            message: "Everything in this object that names it follows: the form, the list, the title field, policies, conditions, hints, analytics and import. Scripts, transactions and screens that read it are named by the checks.",
            label: "New name", value: name, required: true, confirm: "Rename",
            check: (v) => (v.trim() === name ? null : fieldNameProblem(body, v.trim())),
        });
        if (to && to.trim() !== name) ops.edit((b) => { renameField(b, name, to.trim()); });
    };
    return { button: { type: "button", className: "field-name", title: "Rename the field (it is not published yet)", onclick: rename, children: [{ code: name }, icon("pencil", { className: "pencil" })] } };
}

// A text box and an Add button that change the definition's shape.
function addRow({ api, w, ops }, placeholder, add) {
    const path = `${w}.adding.${placeholder.length}`;
    return {
        div: {
            className: "add-row",
            children: [
                { input: { type: "text", placeholder, value: () => api.getState(path, "") ?? "", oninput: (e) => api.setValue(path, e.target.value.trim().toLowerCase()) } },
                {
                    button: {
                        type: "button", className: "btn", textContent: "Add",
                        disabled: () => !IDENTIFIER.test(api.getState(path, "") ?? ""),
                        onclick: () => {
                            const name = api.peek(path);
                            let refused = null;
                            ops.edit((b) => { refused = add(name, b); });
                            api.setValue(path, "");
                            if (refused) api.setValue(`${w}.error`, refused);
                        },
                    },
                },
            ],
        },
    };
}

function statesTab(ctx) {
    const { api, w, ops, ro, body } = ctx;
    const states = body.states.list;
    const plain = states.length <= 1 && !(body.states.transitions ?? []).length;
    return {
        div: {
            children: [
                plain ? { p: { className: "notice small", textContent: `A list: its records have no lifecycle (they stay "${states[0] ?? "active"}", and no state is shown on them), like departments or operations. To give it one, list its states in order (e.g. active, obsolete) and add the transitions between them.` } } : { span: {} },
                { div: { className: "ed-grid", children: [
                    // Cleared, it stays a list (its one state); the initial state follows the list.
                    labelled("States", {
                        input: {
                            type: "text", disabled: ro, placeholder: "none: a list", value: csv(states),
                            onchange: (e) => ops.edit((b) => {
                                const list = fromCsv(e.target.value);
                                const keep = b.states.initial || b.states.list?.[0] || "active";
                                b.states.list = list.length ? list : [keep];
                                if (!b.states.list.includes(b.states.initial)) b.states.initial = b.states.list[0];
                                if (!list.length) b.states.transitions = [];
                            }),
                        },
                    }, plain ? "Empty keeps it a list. In order; renaming one that records are in needs a migration." : "In order; renaming one that records are in needs a migration. Empty makes it a list."),
                    labelled("Initial state", { select: { disabled: ro, onchange: (e) => ops.set("states.initial", e.target.value, true), children: noDefault(states.map((s) => ({ option: { value: s, selected: body.states.initial === s, textContent: s } }))) } }),
                ] } },
                // What each state means, which the plant's theme colours (§10.8): never a colour itself.
                plain ? { span: {} } : { h4: "Tones (how each state shows)" },
                plain ? { span: {} } : {
                    div: { className: "ed-grid", children: states.map((st) => labelled(st.replace(/_/g, " "), {
                        span: { className: "theme-color", children: [
                            { select: { disabled: ro, onchange: (e) => ops.edit((b) => {
                                const tones = { ...(b.states.tones ?? {}) };
                                if (e.target.value) tones[st] = e.target.value; else delete tones[st];
                                if (Object.keys(tones).length) b.states.tones = tones; else delete b.states.tones;
                            }), children: noDefault([["", "plain"], ...TONES.map((t) => [t, t])].map(([v, l]) => ({ option: { value: v, selected: (body.states.tones?.[st] ?? "") === v, textContent: l } }))) } },
                            { span: { className: stateBadgeClass(st, body.states.tones), textContent: st.replace(/_/g, " ") } },
                        ] },
                    })) },
                },
                { h4: "Transitions (the object's actions)" },
                {
                    table: {
                        className: "grid ed-table",
                        children: [
                            { thead: { children: [{ tr: { children: ["Action", "Label", "From", "To", ""].map((h) => ({ th: h })) } }] } },
                            {
                                tbody: {
                                    children: body.states.transitions.map((t, i) => ({
                                        tr: {
                                            key: `${i}-${t.action}`,
                                            children: [
                                                { td: { children: [{ code: t.action }] } },
                                                { td: { children: [text(ctx, `states.transitions.${i}.label`)] } },
                                                { td: { children: [listInput(ctx, `states.transitions.${i}.from`)] } },
                                                { td: { children: [{ select: { disabled: ro, onchange: (e) => ops.set(`states.transitions.${i}.to`, e.target.value, true), children: noDefault(states.map((s) => ({ option: { value: s, selected: t.to === s, textContent: s } }))) } }] } },
                                                { td: { children: [ro() ? { span: {} } : { button: { type: "button", className: "btn ghost", textContent: "Remove", onclick: () => ops.edit((b) => { b.states.transitions.splice(i, 1); }) } }] } },
                                            ],
                                        },
                                    })),
                                },
                            },
                        ],
                    },
                },
                ro() ? { span: {} } : addRow(ctx, "New action (e.g. approve)", (name, b) => {
                    if (b.states.transitions.some((t) => t.action === name)) return `"${name}" exists already.`;
                    b.states.transitions.push({ action: name, label: name.replace(/^./, (c) => c.toUpperCase()), from: [b.states.initial], to: b.states.list[b.states.list.length - 1] });
                    return null;
                }),
            ],
        },
    };
}

// The object's roles and policies at a glance (§9.8): roles across, what each may do with the records,
// each field and each action down, coloured by what it comes to over every policy. A cell says which
// policies make it so; a click on a role's name shows only the policies that name it.
function accessOverview(ctx) {
    const { api, w, body, ops, ro } = ctx;
    const m = policyMatrix(body);
    if (!m.roles.length) return { span: {} };
    const only = api.getState(`${w}.policyRole`, null);
    // The cell chosen: a click chooses it, and what makes it so is set out under the grid, each policy
    // with its own grant to change. A double click (or Enter) changes it at once where there is no
    // doubt which policy to change: the one that is this role's alone and always applies.
    const sel = api.getState(`${w}.policyCell`, null);
    const choose = (role, kind, key) => api.setValue(`${w}.policyCell`, { role, kind, key });
    const change = (index, kind, key, value) => ops.edit((b) => { setGrant(b.policies[index], kind, key, value); });
    const quick = (role, kind, key) => {
        choose(role, kind, key);
        if (ro()) return;
        const target = quickTarget(body, role, kind, key);
        if (target) change(target.index, kind, key, nextGrant(kind, target.value));
    };
    const alone = (role, kind, key) => ops.edit((b) => {
        let id = `${role}_only`;
        for (let n = 2; b.policies.some((p) => p?.id === id); n++) id = `${role}_only_${n}`;
        b.policies.push(setGrant({ id, roles: [role], record: {}, fields: {} }, kind, key, nextGrant(kind, "")));
    });
    const KINDS = [["record", "Records"], ["field", "Fields"], ["action", "Actions"]];
    const head = { tr: { children: [{ th: { scope: "col", className: "pm-corner", textContent: "What" } }, ...m.roles.map((r) => ({ th: { key: r, scope: "col", children: [{ button: { type: "button", className: `pm-role${only === r ? " on" : ""}`, title: only === r ? "Show every policy again" : `Show only the policies for ${r}`, "aria-pressed": only === r ? "true" : "false", textContent: r, onclick: () => api.setValue(`${w}.policyRole`, only === r ? null : r) } }] } }))] } };
    const section = ([kind, label]) => {
        const rows = m.rows.filter((r) => r.kind === kind);
        if (!rows.length) return [];
        return [
            { tr: { key: `h-${kind}`, className: "pm-group", children: [{ th: { colSpan: m.roles.length + 1, scope: "colgroup", textContent: label } }] } },
            ...rows.map((r) => ({ tr: { key: `${kind}-${r.key}`, children: [
                { th: { scope: "row", children: [{ span: r.label }, kind === "field" && r.label !== r.key ? { span: { className: "muted small", textContent: ` ${r.key}` } } : { span: {} }] } },
                ...m.roles.map((role) => {
                    const c = r.cells[role];
                    const said = cellWords(c, kind);
                    const chosen = sel && sel.role === role && sel.kind === kind && sel.key === r.key;
                    return { td: { key: role, className: `pm-cell pm-${said.tone}${c.sometimes && said.tone !== "none" ? " pm-sometimes" : ""}${chosen ? " pm-chosen" : ""}`, children: [{ button: {
                        type: "button", className: "pm-btn", "aria-pressed": chosen ? "true" : "false",
                        title: `${role} · ${r.label}: ${said.text.replace("*", " (only under a condition)")}. ${cellWhy(c)}.${ro() ? "" : " Click to see and change its policies; double click to change it at once."}`,
                        textContent: said.text, onclick: () => choose(role, kind, r.key), ondblclick: () => quick(role, kind, r.key), onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); quick(role, kind, r.key); } },
                    } }] } };
                }),
            ] } })),
        ];
    };
    return { details: { className: "pm", open: api.getState(`${w}.policyOverview`, true), ontoggle: (e) => api.setValue(`${w}.policyOverview`, e.target.open), children: [
        { summary: { children: [{ strong: "Overview" }, { span: { className: "muted small", textContent: ` what each role may do, over every policy (${body.policies.length})` } }] } },
        { div: { className: "pm-box", children: [{ table: { className: "pm-table", children: [{ thead: { children: [head] } }, { tbody: { children: KINDS.flatMap(section) } }] } }] } },
        // The chosen cell: which policies make it so, each with its own grant, changed here.
        (() => {
            const row = sel && m.rows.find((r) => r.kind === sel.kind && r.key === sel.key);
            if (!row || !m.roles.includes(sel.role)) return { span: {} };
            const { role, kind, key } = sel;
            const mine = policiesFor(body, role, kind, key);
            const said = cellWords(row.cells[role], kind);
            const words = (v) => (v === "yes" ? (kind === "action" ? "allow" : "yes") : v || "—");
            return { div: { className: "pm-edit", children: [
                { p: { className: "pm-edit-head", children: [{ strong: `${role} · ${row.label}` }, { span: { className: `pm-cell pm-${said.tone}`, textContent: said.text } }, { span: { className: "muted small", textContent: mine.length ? " comes from these policies. Change one:" : " no policy names this role yet." } }, { button: { type: "button", className: "linkish", textContent: "close", onclick: () => api.setValue(`${w}.policyCell`, null) } }] } },
                ...mine.map((x) => ({ div: { key: x.id, className: "pm-edit-row", children: [
                    { button: { type: "button", disabled: ro, className: `grant-tile pm-${x.value === "write" || x.value === "yes" ? "write" : x.value === "read" ? "read" : "none"}`, title: `In ${x.id}: ${words(x.value)}. Click for ${words(nextGrant(kind, x.value))}.`, onclick: () => change(x.index, kind, key, nextGrant(kind, x.value)), children: [{ span: { className: "grant-name", textContent: x.id } }, { span: { className: "grant-level", textContent: words(x.value) } }] } },
                    { span: { className: "small", children: [
                        x.when ? { span: { className: "muted", textContent: x.via.length ? `only through ${x.via.join(", ")}. ` : "under its condition. " } } : { span: {} },
                        x.star ? { span: { className: "muted", textContent: `Its "every other field" gives ${x.star}. ` } } : { span: {} },
                        x.others.length ? { span: { className: "pm-shared", textContent: `Shared: a change here is also for ${x.others.join(", ")}.` } } : { span: { className: "muted", textContent: `For ${role} alone.` } },
                    ] } },
                ] } })),
                row.cells[role].denied ? { p: { className: "small pm-shared", textContent: `A deny applies (${row.cells[role].denied}) and wins over these grants: change it in its policy below (Deny).` } } : { span: {} },
                ro() ? { span: {} } : { p: { className: "small", children: [{ button: { type: "button", className: "btn", textContent: `Grant it in a new policy for ${role} alone`, onclick: () => alone(role, kind, key) } }, { span: { className: "muted", textContent: " A double click on a cell changes it at once when one policy is that role's alone and always applies; otherwise choose here." } }] } },
            ] } };
        })(),
        { p: { className: "pm-legend small", children: [
            { span: { className: "pm-cell pm-write", textContent: "write / yes / allow" } }, { span: { className: "pm-cell pm-read", textContent: "read" } }, { span: { className: "pm-cell pm-none", textContent: "— not granted" } }, { span: { className: "pm-cell pm-deny", textContent: "denied: locked, hidden, refused" } }, { span: { className: "pm-cell pm-write pm-sometimes", textContent: "* only under a condition" } },
            { span: { className: "muted", textContent: ro() ? " Click a cell to see which policies make it so; click a role to show only its policies." : " Click a cell to see and change its policies; double click to change it at once; click a role to show only its policies." } },
        ] } },
    ] } };
}

function accessTab(ctx) {
    const { api, w, ops, ro, body } = ctx;
    const actions = [...new Set(body.states.transitions.map((t) => t.action))];
    const fieldNames = ["*", ...Object.keys(body.fields)];
    return {
        div: {
            children: [
                labelled("Roles", listInput(ctx, "roles", "operator, supervisor, quality"), "Declared by this object; users and groups are assigned to them."),
                { p: { className: "muted small", textContent: "Deny is the default: a policy grants reading, writing and actions to its roles while its condition holds." } },
                accessOverview(ctx),
                (() => { const only = api.getState(`${w}.policyRole`, null); return only ? { p: { className: "small", children: [{ span: `Showing the policies for ${only} (${body.policies.filter((p) => (p?.roles ?? []).includes(only)).length} of ${body.policies.length}). ` }, { button: { type: "button", className: "linkish", textContent: "Show all", onclick: () => api.setValue(`${w}.policyRole`, null) } }] } } : { span: {} }; })(),
                ...(ctx.diff?.removedPolicies ?? []).map((pid) => ({ p: { key: `removed-${pid}`, className: "diff-removed-line", textContent: `Policy ${pid}: removed by this change` } })),
                ...body.policies.map((rule, i) => ({
                    fieldset: {
                        key: `${i}-${rule.id}`,
                        hidden: (() => { const only = api.getState(`${w}.policyRole`, null); return Boolean(only) && !(rule?.roles ?? []).includes(only); })(),
                        className: `policy ${ctx.diff?.policies?.[rule.id] ? `diff-${ctx.diff.policies[rule.id]}` : ""}`,
                        children: [
                            { legend: { children: [{ code: rule.id }, diffPill(ctx.diff?.policies?.[rule.id]), ro() ? { span: {} } : { button: { type: "button", className: "linkish", textContent: "remove", onclick: () => ops.edit((b) => { b.policies.splice(i, 1); }) } }] } },
                            { div: { className: "ed-grid", children: [
                                labelled("Roles", listInput(ctx, `policies.${i}.roles`)),
                                // The condition, in the highlighted JSON editor. What is typed is kept as text, and
                                // applied whenever it parses, so the caret never jumps while typing.
                                labelled("Condition (JSON, empty = always)", {
                                    CodeEditor: {
                                        key: `cond-${rule.id}`, mode: "json", rows: 3, label: `Condition of ${rule.id}`, readOnly: ro,
                                        value: () => api.getState(`${w}.condText.${rule.id}`, null) ?? (rule.when === undefined ? "" : JSON.stringify(rule.when, null, 2)),
                                        onInput: (text) => {
                                            api.setValue(`${w}.condText.${rule.id}`, text);
                                            if (!text.trim()) { ops.set(`policies.${i}.when`, undefined, false); return; }
                                            try { ops.set(`policies.${i}.when`, JSON.parse(text), false); } catch { /* the editor marks it */ }
                                        },
                                    },
                                }, 'e.g. {"in": [{"record": "state"}, ["created", "in_process"]]}'),
                                // Only through these transactions (§25): a grant no form offers on its own.
                                labelled("Only through transactions", {
                                    input: {
                                        type: "text", disabled: ro, placeholder: "any write (empty)", value: (rule.via ?? []).join(", "),
                                        onchange: (e) => { const list = fromCsv(e.target.value); ops.set(`policies.${i}.via`, list.length ? list : undefined, true); },
                                    },
                                }, "Names of transactions, e.g. move_in: this policy then grants only to writes made through them."),
                            ] } },
                            { div: { className: "checks", children: [
                                check(ctx, `policies.${i}.record.read`, "may read records"),
                                check(ctx, `policies.${i}.record.create`, "may create records"),
                                check(ctx, `policies.${i}.record.archive`, "may archive and restore records"),
                            ] } },
                            // What it grants on each field, as tiles coloured like the overview: a click goes from
                            // nothing to read to write and round again. They wrap, so every field is in sight
                            // however many the object has. `*` is every field the policy does not name.
                            { div: { className: "grant-part", children: [
                                { span: { className: "muted small", textContent: "Fields (click: — → read → write):" } },
                                { div: { className: "grant-grid", role: "group", "aria-label": `What ${rule.id} grants on each field`, children: fieldNames.map((f) => {
                                    const level = rule.fields?.[f] ?? "";
                                    const next = { "": "read", read: "write", write: "" }[level];
                                    const label = f === "*" ? "every other field" : body.fields[f]?.label ?? f;
                                    return { button: {
                                        key: f, type: "button", disabled: ro, className: `grant-tile pm-${level || "none"}`,
                                        title: `${f === "*" ? "Every field this policy does not name" : `${label} (${f})`}: ${level || "not granted"}. Click for ${next || "not granted"}.`,
                                        onclick: () => ops.edit((b) => { const g = (b.policies[i].fields ??= {}); if (next) g[f] = next; else delete g[f]; }),
                                        children: [{ span: { className: "grant-name", textContent: f === "*" ? "* every other field" : f } }, { span: { className: "grant-level", textContent: level || "—" } }],
                                    } };
                                }) } },
                            ] } },
                            // The actions it allows (the object's transitions, States tab): a click allows or takes back.
                            actions.length ? { div: { className: "grant-part", children: [
                                { span: { className: "muted small", textContent: "Actions allowed (click):" } },
                                { div: { className: "grant-grid", role: "group", "aria-label": `The actions ${rule.id} allows`, children: actions.map((a) => {
                                    const on = rule.actions?.[a] === "allow";
                                    return { button: {
                                        key: a, type: "button", disabled: ro, "aria-pressed": on ? "true" : "false", className: `grant-tile pm-${on ? "write" : "none"}`,
                                        title: `${a}: ${on ? "allowed" : "not allowed"}. Click to ${on ? "take it back" : "allow it"}.`,
                                        onclick: () => ops.edit((b) => { const acts = (b.policies[i].actions ??= {}); if (on) delete acts[a]; else acts[a] = "allow"; }),
                                        children: [{ span: { className: "grant-name", textContent: a } }, { span: { className: "grant-level", textContent: on ? "allow" : "—" } }],
                                    } };
                                }) } },
                            ] } } : { span: {} },
                            labelled("Deny writing these fields (a lock that wins over any grant)", listInput(ctx, `policies.${i}.deny.fields`)),
                        ],
                    },
                })),
                ro() ? { span: {} } : addRow(ctx, "New policy id (e.g. lot_quality_edit)", (name, b) => {
                    if (b.policies.some((p) => p.id === name)) return `"${name}" exists already.`;
                    b.policies.push({ id: name, roles: [b.roles[0]].filter(Boolean), record: { read: true }, fields: { "*": "read" } });
                    return null;
                }),
            ],
        },
    };
}


function rulesTab(ctx) {
    const { api, w, ops, ro, body } = ctx;
    const home = api.peek("design.home") ?? {};
    const drafted = api.peek(`${w}.s`) ?? {};
    const scripts = [...new Set([...(home.scripts ?? []).map((s) => s.name), ...Object.keys(drafted)])].sort();
    const editing = api.peek(`${w}.script`);
    const openScript = async (name) => {
        if (!(name in (api.peek(`${w}.s`) ?? {}))) {
            const live = await api.call("design.script", { name });
            if (api.peek(`${w}.t.${name}`) === undefined) api.setValue(`${w}.t.${name}`, live?.tests ?? []);
            ops.setScript(name, live?.source ?? SCRIPT_TEMPLATE(name), true);
            api.setValue(`${w}.dirty`, false); // opening is not a change until the text is
            if (live) {
                const s = { ...(api.peek(`${w}.s`) ?? {}) };
                delete s[name];
                api.setValue(`${w}.s`, s);
                api.setValue(`${w}.viewing`, { name, source: live.source });
            }
        }
        api.setValue(`${w}.script`, name);
        api.setValue(`${w}.rev`, (api.peek(`${w}.rev`) ?? 0) + 1);
    };
    const sourceOf = (name) => (api.peek(`${w}.s`) ?? {})[name] ?? (api.peek(`${w}.viewing`)?.name === name ? api.peek(`${w}.viewing`).source : "");
    return {
        div: {
            children: [
                { p: { className: "muted small", textContent: "The pipe runs on every change of state, in order. Each script takes the context and returns it, or throws to reject. One file per rule; its name is its function's." } },
                {
                    table: {
                        className: "grid ed-table",
                        children: [
                            { thead: { children: [{ tr: { children: ["#", "Script", "May write", "Backend only", "After commit", ""].map((h) => ({ th: h })) } }] } },
                            {
                                tbody: {
                                    children: (body.rules ?? []).map((entry, i) => ({
                                        tr: {
                                            key: `${i}-${entry.script}`,
                                            children: [
                                                { td: String(i + 1) },
                                                { td: { children: [{ button: { type: "button", className: "linkish", textContent: `${entry.script}.js`, onclick: () => openScript(entry.script) } }, entry.script in drafted ? { span: { className: "badge s-review", textContent: "edited" } } : { span: {} }] } },
                                                { td: { children: [listInput(ctx, `rules.${i}.writes`, "fields")] } },
                                                { td: { children: [check(ctx, `rules.${i}.backendOnly`, "")] } },
                                                { td: { children: [check(ctx, `rules.${i}.committed`, "")] } },
                                                {
                                                    td: {
                                                        children: ro() ? [] : [
                                                            { button: { type: "button", className: "btn ghost", title: "Earlier", "aria-label": "Earlier", children: [icon("arrowUp")], disabled: i === 0, onclick: () => ops.edit((b) => { [b.rules[i - 1], b.rules[i]] = [b.rules[i], b.rules[i - 1]]; }) } },
                                                            { button: { type: "button", className: "btn ghost", textContent: "Remove", onclick: () => ops.edit((b) => { b.rules.splice(i, 1); }) } },
                                                        ],
                                                    },
                                                },
                                            ],
                                        },
                                    })),
                                },
                            },
                        ],
                    },
                },
                ro() ? { span: {} } : {
                    div: {
                        className: "add-row",
                        children: [
                            { select: { onchange: (e) => api.setValue(`${w}.pick`, e.target.value), children: noDefault([{ option: { value: "", textContent: "add a published script…" } }, ...scripts.map((s) => ({ option: { value: s, textContent: s } }))]) } },
                            { button: { type: "button", className: "btn", textContent: "Add to pipe", onclick: () => { const s = api.peek(`${w}.pick`); if (s) ops.edit((b) => { (b.rules ??= []).push({ script: s }); }); } } },
                        ],
                    },
                },
                ro() ? { span: {} } : addRow(ctx, "New script name (e.g. lot_check_moisture)", (name, b) => {
                    if (scripts.includes(name)) return `A script "${name}" exists already; add it to the pipe instead.`;
                    api.setValue(`${w}.s.${name}`, SCRIPT_TEMPLATE(name));
                    (b.rules ??= []).push({ script: name });
                    api.setValue(`${w}.script`, name);
                    return null;
                }),
                editing ? {
                    div: {
                        className: "script-editor",
                        children: [
                            { div: { className: "script-head", children: [{ strong: `${editing}.js` }, { span: { className: "muted small", textContent: editing in drafted ? " · edited in this change" : " · published version (edit to change it in this change)" } }] } },
                            {
                                CodeEditor: {
                                    key: `ce-${editing}`, mode: "js", rows: 16, label: `${editing}.js`, readOnly: ro,
                                    value: () => api.getState(`${w}.s.${editing}`, undefined) ?? sourceOf(editing),
                                    onInput: (text) => ops.setScript(editing, text),
                                    lint: (t) => callableProblems(t, "rule"), runError: dryRunError(api, w, editing),
                                },
                            },
                            (() => {
                                const problems = validateScript(editing, sourceOf(editing), compileInPage);
                                return { p: { className: problems.length ? "error small" : "notice small", textContent: problems.length ? problems[0].message : "Compiles; the name rule holds." } };
                            })(),
                            { DryRun: { key: `dry-${editing}`, id: ctx.id, kind: "rule", name: editing, writes: (body.rules ?? []).find((r) => r.script === editing)?.writes ?? [] } },
                            { TestCases: { key: `cases-${editing}`, id: ctx.id, name: editing, readOnly: ro } },
                        ],
                    },
                } : { span: {} },
            ],
        },
    };
}

function layoutTab(ctx) {
    const { api, w, body, ops, ro } = ctx;
    const form = normalizeForm(body);
    const fields = body.fields ?? {};
    const tabAt = Math.min(api.getState(`${w}.layoutTab`, 0) ?? 0, form.tabs.length - 1);
    const selected = api.getState(`${w}.layoutSel`, null);
    const editForm = (fn) => ops.edit((b) => { const m = normalizeForm(b); fn(m, b); b.form = storeForm(m, b); });
    const where = (m, name) => {
        for (const [t, tab] of m.tabs.entries()) for (const [s, section] of tab.sections.entries()) { const i = section.fields.findIndex((e) => e.field === name); if (i >= 0) return { t, s, i }; }
        return null;
    };
    // Moves a field (placed or not) into tab t, section s, before position `before` (or last).
    const move = (name, t, s, before = null) => editForm((m) => {
        const at = where(m, name);
        let entry = { field: name };
        if (at) {
            [entry] = m.tabs[at.t].sections[at.s].fields.splice(at.i, 1);
            if (at.t === t && at.s === s && before !== null && at.i < before) before -= 1;
        }
        const list = m.tabs[t].sections[s].fields;
        list.splice(before === null ? list.length : Math.max(0, Math.min(before, list.length)), 0, entry);
    });
    const unplace = (name) => editForm((m) => { const at = where(m, name); if (at) m.tabs[at.t].sections[at.s].fields.splice(at.i, 1); });
    const placed = new Set(form.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields.map((e) => e.field))));
    const unplaced = Object.keys(fields).filter((f) => !placed.has(f));
    const sections = form.tabs.flatMap((t, ti) => t.sections.map((s, si) => ({ t: ti, s: si, label: `${form.tabs.length > 1 ? `${t.label} › ` : ""}${s.label || `section ${si + 1}`}` })));
    const drag = (name) => ({ draggable: !ro(), ondragstart: (e) => { e.dataTransfer.setData("text/plain", name); e.dataTransfer.effectAllowed = "move"; } });
    const dropOn = (onDrop) => ({ ondragover: (e) => { if (!ro()) { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.add("drop-here"); } }, ondragleave: (e) => e.currentTarget.classList.remove("drop-here"), ondrop: (e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove("drop-here"); const name = e.dataTransfer.getData("text/plain"); if (fields[name]) onDrop(name); } });
    // A small button: words, or an icon (its title then says what it does), or both ([icon, words]).
    const small = (label, onclick, title = label, off = false) => ({ button: { type: "button", className: "mini", disabled: off ? true : ro, title: typeof title === "string" ? title : undefined, ...(typeof label === "string" ? { textContent: label } : { children: Array.isArray(label) ? label : [label], ...(typeof title === "string" ? { "aria-label": title } : {}) }), onclick: (e) => { e.stopPropagation(); onclick(); } } });

    // ---- the list ----
    const columns = body.list?.columns ?? [];
    const setColumns = (next) => ops.edit((b) => { b.list = { ...(b.list ?? {}), columns: next }; });
    const listEditor = {
        div: {
            className: "lay-list",
            children: [
                { h4: "List" },
                { div: { className: "chip-row", children: [
                    ...columns.map((c, k) => ({ span: { key: c, className: "lay-chip", children: [
                        { span: fields[c]?.label ?? c },
                        k > 0 ? small(icon("chevronLeft"), () => setColumns(columns.map((x, j) => (j === k - 1 ? c : j === k ? columns[k - 1] : x))), "Earlier") : { span: {} },
                        k < columns.length - 1 ? small(icon("chevronRight"), () => setColumns(columns.map((x, j) => (j === k + 1 ? c : j === k ? columns[k + 1] : x))), "Later") : { span: {} },
                        small(icon("x"), () => setColumns(columns.filter((x) => x !== c)), "Remove the column"),
                    ] } })),
                    ro() ? { span: {} } : { select: { className: "mini-select", onchange: (e) => { if (e.target.value) setColumns([...columns, e.target.value]); }, children: noDefault([["", "+ column"], ...Object.keys(fields).filter((f) => !columns.includes(f)).map((f) => [f, fields[f].label ?? f])].map(([v, l]) => ({ option: { value: v, textContent: l } }))) } },
                ] } },
                { label: { className: "inline small", children: [{ span: "Sorted by " },
                    { select: { disabled: ro, onchange: (e) => ops.edit((b) => { if (e.target.value) b.list = { ...(b.list ?? {}), sort: { field: e.target.value, dir: b.list?.sort?.dir ?? "asc" } }; else if (b.list) delete b.list.sort; }), children: noDefault([["", "last changed first"], ...Object.keys(fields).map((f) => [f, fields[f].label ?? f])].map(([v, l]) => ({ option: { value: v, selected: (body.list?.sort?.field ?? "") === v, textContent: l } }))) } },
                    body.list?.sort ? { select: { disabled: ro, onchange: (e) => ops.edit((b) => { b.list.sort.dir = e.target.value; }), children: noDefault([["asc", "ascending"], ["desc", "descending"]].map(([v, l]) => ({ option: { value: v, selected: body.list.sort.dir === v, textContent: l } }))) } } : { span: {} },
                ] } },
                { label: { className: "inline small", title: "For an object with too many records to browse (people, say): its list shows nobody until something is typed. Development, the demo and test instances list them anyway.", children: [
                    { input: { type: "checkbox", disabled: ro, checked: body.list?.searchFirst === true, onchange: (e) => ops.edit((b) => { b.list = { ...(b.list ?? {}) }; if (e.target.checked) b.list.searchFirst = true; else delete b.list.searchFirst; }) } },
                    { span: " Search first: the list starts empty, with a search box" },
                ] } },
            ],
        },
    };

    // ---- the form: tabs, sections, cards ----
    const tabBar = {
        div: {
            className: "lay-tabs",
            children: [
                ...form.tabs.map((tab, k) => ({ button: { key: k, type: "button", className: "form-tab", classList: { active: k === tabAt }, textContent: tab.label || `Tab ${k + 1}`, onclick: () => api.setValue(`${w}.layoutTab`, k) } })),
                ro() ? { span: {} } : { button: { type: "button", className: "mini", textContent: "+ tab", onclick: () => { editForm((m) => { if (m.tabs.length === 1 && !m.tabs[0].label) m.tabs[0].label = body.label ?? "Details"; m.tabs.push({ label: `Tab ${m.tabs.length + 1}`, sections: [{ label: "New section", fields: [] }] }); }); api.setValue(`${w}.layoutTab`, form.tabs.length); } } },
            ],
        },
    };
    const tab = form.tabs[tabAt];
    const tabHead = form.tabs.length > 1 ? {
        div: { className: "lay-tab-head", children: [
            { input: { type: "text", disabled: ro, value: tab.label, placeholder: "Tab label", onchange: (e) => editForm((m) => { m.tabs[tabAt].label = e.target.value; }) } },
            tabAt > 0 ? small([icon("chevronLeft"), { span: "move" }], () => { editForm((m) => { const [x] = m.tabs.splice(tabAt, 1); m.tabs.splice(tabAt - 1, 0, x); }); api.setValue(`${w}.layoutTab`, tabAt - 1); }) : { span: {} },
            tabAt < form.tabs.length - 1 ? small([{ span: "move" }, icon("chevronRight")], () => { editForm((m) => { const [x] = m.tabs.splice(tabAt, 1); m.tabs.splice(tabAt + 1, 0, x); }); api.setValue(`${w}.layoutTab`, tabAt + 1); }) : { span: {} },
            small("Remove tab", () => { editForm((m) => { m.tabs.splice(tabAt, 1); }); api.setValue(`${w}.layoutTab`, 0); }, "Its fields go to the tray below"),
        ] },
    } : { span: {} };
    const card = (entry, t, s, i) => {
        const f = fields[entry.field];
        return {
            div: {
                key: entry.field,
                className: `lay-card w-${entry.width} ${ctx.diff?.layout?.[entry.field] ? `diff-${ctx.diff.layout[entry.field]}` : ""}`,
                classList: { selected: selected === entry.field },
                ...drag(entry.field),
                ...dropOn((name) => move(name, t, s, i)),
                onclick: () => api.setValue(`${w}.layoutSel`, selected === entry.field ? null : entry.field),
                children: [
                    { div: { className: "lay-card-head", children: [{ strong: f.label ?? entry.field }, { span: { className: "muted small", textContent: ` ${entry.field}` } }] } },
                    { div: { className: "muted small", textContent: `${WIDGET_LABELS[entry.widget] ?? entry.widget} · ${entry.width}/12${entry.show ? " · shown when…" : ""}${entry.enable ? " · enabled when…" : ""}${f.requiredWhen ? " · required when…" : ""}` } },
                    ro() ? { span: {} } : { div: { className: "lay-card-tools", children: [
                        i > 0 ? small(icon("chevronLeft"), () => move(entry.field, t, s, i - 1), "Earlier") : { span: {} },
                        small(icon("chevronRight"), () => move(entry.field, t, s, i + 2), "Later"),
                        small(icon("minus"), () => editForm((m) => { const x = m.tabs[t].sections[s].fields[i]; x.width = Math.max(minWidth(x.widget), x.width - 1); }), entry.width <= minWidth(entry.widget) ? `As narrow as a field drawn as ${WIDGET_LABELS[entry.widget]} goes (${minWidth(entry.widget)} of 12)` : "Narrower", entry.width <= minWidth(entry.widget)),
                        small("+", () => editForm((m) => { const x = m.tabs[t].sections[s].fields[i]; x.width = Math.min(12, x.width + 1); }), entry.width >= 12 ? "The whole row already" : "Wider", entry.width >= 12),
                    ] } },
                ],
            },
        };
    };
    const sectionCard = (section, s) => ({
        div: {
            key: `${tabAt}-${s}`,
            className: "lay-section",
            children: [
                { div: { className: "lay-section-head", children: [
                    { input: { type: "text", disabled: ro, value: section.label, placeholder: "Section label", onchange: (e) => editForm((m) => { m.tabs[tabAt].sections[s].label = e.target.value; }) } },
                    { label: { className: "small", children: [{ input: { type: "checkbox", disabled: ro, checked: section.collapsible, onchange: (e) => editForm((m) => { m.tabs[tabAt].sections[s].collapsible = e.target.checked; }) } }, { span: " can fold" }] } },
                    section.collapsible ? { label: { className: "small", children: [{ input: { type: "checkbox", disabled: ro, checked: section.collapsed, onchange: (e) => editForm((m) => { m.tabs[tabAt].sections[s].collapsed = e.target.checked; }) } }, { span: " folded at first" }] } } : { span: {} },
                    s > 0 ? small(icon("arrowUp"), () => editForm((m) => { const x = m.tabs[tabAt].sections; [x[s - 1], x[s]] = [x[s], x[s - 1]]; }), "Move up") : { span: {} },
                    s < tab.sections.length - 1 ? small(icon("arrowDown"), () => editForm((m) => { const x = m.tabs[tabAt].sections; [x[s + 1], x[s]] = [x[s], x[s + 1]]; }), "Move down") : { span: {} },
                    form.tabs.length > 1 ? { select: { className: "mini-select", disabled: ro, onchange: (e) => { const to = Number(e.target.value); if (to !== tabAt) editForm((m) => { const [x] = m.tabs[tabAt].sections.splice(s, 1); m.tabs[to].sections.push(x); }); }, children: noDefault(form.tabs.map((t, k) => ({ option: { value: k, selected: k === tabAt, textContent: k === tabAt ? "on this tab" : `→ ${t.label}` } }))) } } : { span: {} },
                    small("Remove", () => editForm((m) => { m.tabs[tabAt].sections.splice(s, 1); }), "Remove the section; its fields go to the tray"),
                ] } },
                { div: { className: "grid12 lay-grid", ...dropOn((name) => move(name, tabAt, s)), children: section.fields.length ? section.fields.map((e, i) => card(e, tabAt, s, i)) : [{ div: { key: "empty", className: "lay-empty w-12", textContent: "Drop fields here" } }] } },
            ],
        },
    });
    const tray = {
        div: {
            className: "lay-tray",
            ...dropOn((name) => unplace(name)),
            children: [
                { h4: "Not on the form" },
                unplaced.length ? { div: { className: "chip-row", children: unplaced.map((name) => ({ span: { key: name, className: "lay-chip", ...drag(name), children: [
                    { span: fields[name].label ?? name },
                    ro() ? { span: {} } : { select: { className: "mini-select", onchange: (e) => { const [t, s] = e.target.value.split(":").map(Number); if (e.target.value) move(name, t, s); }, children: noDefault([{ option: { value: "", textContent: "place in…" } }, ...sections.map((x) => ({ option: { value: `${x.t}:${x.s}`, textContent: x.label } }))]) } },
                ] } })) } } : { p: { className: "muted small", textContent: "Every field is on the form. Drag one here to take it off." } },
            ],
        },
    };

    // ---- the selected field: its presentation, and its rules ----
    const inspector = () => {
        if (!selected || !fields[selected]) return { p: { className: "muted small", textContent: "Select a field to set its width, how it is drawn, its help text, and when it is shown, enabled or required." } };
        const at = where(form, selected);
        if (!at) return { span: {} };
        const entry = form.tabs[at.t].sections[at.s].fields[at.i];
        const f = fields[selected];
        const setEntry = (k, v) => editForm((m) => {
            const x = where(m, selected);
            const e = m.tabs[x.t].sections[x.s].fields[x.i];
            if (v === undefined || v === "") delete e[k]; else e[k] = v;
            if (k === "widget") e.width = Math.max(minWidth(e.widget), e.width);  // a wider widget needs the room
        });
        const ruleEditor = (kind, label, stored, apply) => {
            const draftPath = `${w}.ruleText.${selected}.${kind}`;
            const text = () => api.getState(draftPath, null) ?? (stored === undefined ? "" : JSON.stringify(stored, null, 2));
            const pending = () => { const t = api.getState(draftPath, null); return t !== null && t !== (stored === undefined ? "" : JSON.stringify(stored, null, 2)); };
            return {
                div: { className: "lay-rule", children: [
                    { div: { className: "lay-rule-head", children: [{ strong: label }, () => (pending() ? { span: { className: "muted small", textContent: " not applied yet" } } : { span: {} }), { span: { className: "spacer" } },
                        ro() ? { span: {} } : { button: { type: "button", className: "mini", disabled: () => !pending(), textContent: "Apply", onclick: () => {
                            const t = api.peek(draftPath) ?? "";
                            let value;
                            if (t.trim()) { try { value = JSON.parse(t); } catch { api.setValue(`${w}.error`, `${label}: the condition is not valid JSON.`); return; } }
                            api.setValue(draftPath, null);
                            apply(value);
                        } } }] } },
                    { CodeEditor: { key: `${selected}-${kind}`, mode: "json", rows: 3, label, readOnly: ro, value: text, onInput: (t) => api.setValue(draftPath, t) } },
                ] },
            };
        };
        return {
            div: {
                className: "lay-inspector",
                children: [
                    { h4: `${f.label ?? selected} (${selected})` },
                    { div: { className: "ed-row", children: [
                        labelled("Width", { select: { disabled: ro, onchange: (e) => setEntry("width", Number(e.target.value)), children: noDefault(Array.from({ length: 13 - minWidth(entry.widget) }, (_, k) => k + minWidth(entry.widget)).map((n) => ({ option: { value: n, selected: entry.width === n, textContent: `${n} of 12${n === 12 ? " (whole row)" : n === 6 ? " (half)" : n === 4 ? " (a third)" : n === 3 ? " (a quarter)" : ""}` } }))) } }),
                        labelled("Drawn as", { select: { disabled: ro, onchange: (e) => setEntry("widget", e.target.value), children: noDefault(widgetsFor(f).map((x) => ({ option: { value: x, selected: entry.widget === x, textContent: WIDGET_LABELS[x] } }))) } }, f.type === "enum" && !f.multiple ? "Several values: tick it on the Fields tab." : ""),
                        f.type === "text" ? labelled("Rows", { input: { type: "number", min: 2, max: 20, disabled: ro, value: entry.rows ?? 3, onchange: (e) => setEntry("rows", Number(e.target.value)) } }) : { span: {} },
                        labelled("Help text", { input: { type: "text", disabled: ro, value: entry.help ?? "", placeholder: "Shown under the field", onchange: (e) => setEntry("help", e.target.value.trim()) } }),
                        labelled("Placeholder", { input: { type: "text", disabled: ro, value: entry.placeholder ?? "", placeholder: "Shown while empty", onchange: (e) => setEntry("placeholder", e.target.value.trim()) } }),
                    ] } },
                    hint('Conditions read the form as it is being filled: {"eq": [{"data": "disposition"}, "rework"]}, {"contains": [{"data": "defects"}, "dent"]}, {"in": [{"record": "state"}, ["created", "in_process"]]}. Empty: always. They only change what is shown; what a person may read or write is the policies\' to say.'),
                    ruleEditor("show", "Shown when", entry.show, (v) => setEntry("show", v)),
                    ruleEditor("enable", "Enabled when", entry.enable, (v) => setEntry("enable", v)),
                    ruleEditor("required", "Required when (checked by the server too)", f.requiredWhen, (v) => ops.edit((b) => { if (v === undefined) delete b.fields[selected].requiredWhen; else b.fields[selected].requiredWhen = v; })),
                    ro() ? { span: {} } : { button: { type: "button", className: "btn ghost", textContent: "Take it off the form", onclick: () => { unplace(selected); api.setValue(`${w}.layoutSel`, null); } } },
                ],
            },
        };
    };

    return {
        div: {
            className: "layout-editor",
            children: [
                ...(ctx.noList ? [] : [listEditor]),
                { h4: "Form" },
                hint("Drag a field to move it, within a section or to another; or use the arrow and minus and plus buttons. Click a field to set how it is drawn and when it is shown. Widths are of a 12-column row; on narrow screens fields take the whole row."),
                tabBar,
                tabHead,
                ...tab.sections.map(sectionCard),
                ro() ? { span: {} } : { button: { type: "button", className: "btn", textContent: "Add section", onclick: () => editForm((m) => { m.tabs[tabAt].sections.push({ label: "New section", fields: [] }); }) } },
                tray,
                inspector(),
                { h4: "Preview" },
                { FormPreview: { key: `lp-${api.peek(`${w}.vrev`) ?? 0}-${tabAt}`, body: clone(body), tab: tabAt } },
            ],
        },
    };
}

function stewardsTab(ctx) {
    const { api, w, ops, ro, body } = ctx;
    const depts = (api.peek("design.home.departments") ?? []).map((d) => d.id);
    const pick = (path, current) => ({
        div: {
            className: "checks",
            children: depts.map((d) => ({
                label: {
                    key: d,
                    children: [{
                        input: {
                            type: "checkbox", disabled: ro, checked: (current ?? []).includes(d),
                            onchange: (e) => ops.edit((b) => {
                                const parts = path.split(".");
                                let at = b;
                                for (const p of parts.slice(0, -1)) at = at[p] ??= {};
                                const last = parts[parts.length - 1];
                                const now = new Set(at[last] ?? []);
                                if (e.target.checked) now.add(d); else now.delete(d);
                                if (now.size) at[last] = [...now]; else delete at[last];
                            }),
                        },
                    }, { span: ` ${d}` }],
                },
            })),
        },
    });
    const s = body.stewards ?? {};
    return {
        div: {
            children: [
                { p: { className: "muted small", textContent: "Stewards approve changes to what they steward. A field, state or transition with none of its own is stewarded by the object's." } },
                labelled("The object", pick("stewards.object", s.object)),
                { h4: "Fields" },
                ...Object.keys(body.fields).map((f) => ({ div: { key: `f-${f}`, className: "steward-row", children: [{ code: f }, pick(`stewards.fields.${f}`, s.fields?.[f])] } })),
                { h4: "States" },
                ...body.states.list.map((st) => ({ div: { key: `s-${st}`, className: "steward-row", children: [{ code: st }, pick(`stewards.states.${st}`, s.states?.[st])] } })),
                approvalSection(ctx),
            ],
        },
    };
}

// Approval of record changes (§28): which changes to this object's records, made outside a
// transaction, wait until their stewards (above) approve them.
function approvalSection({ ops, ro, body }) {
    const a = body.approval ?? {};
    const set = (fn) => ops.edit((b) => {
        const next = { ...(b.approval ?? {}) };
        fn(next);
        for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === false) delete next[k];
        if (Object.keys(next).length) b.approval = next; else delete b.approval;
    });
    const box = (checked, text, onchange, key = text) => ({ label: { key, children: [{ input: { type: "checkbox", disabled: ro, checked, onchange: (e) => onchange(e.target.checked) } }, { span: ` ${text}` }] } });
    // A narrowing list (fields, states, actions): none ticked means all.
    const narrow = (list, chosen, toggle) => ({ div: { className: "checks", children: list.map((name) => box(chosen.includes(name), name, (on) => toggle(name, on), name)) } });
    const editOnly = (key) => (a.edit && a.edit !== true ? a.edit[key] ?? [] : []);
    const toggleEdit = (key) => (name, on) => set((n) => {
        const e = n.edit && n.edit !== true ? { ...n.edit } : {};
        const chosen = new Set(e[key] ?? []);
        if (on) chosen.add(name); else chosen.delete(name);
        if (chosen.size) e[key] = [...chosen]; else delete e[key];
        n.edit = Object.keys(e).length ? e : true;
    });
    const actions = [...new Set(body.states.transitions.map((t) => t.action))];
    const actionsOnly = Array.isArray(a.actions) ? a.actions : [];
    const toggleAction = (name, on) => set((n) => {
        const chosen = new Set(Array.isArray(n.actions) ? n.actions : []);
        if (on) chosen.add(name); else chosen.delete(name);
        n.actions = chosen.size ? [...chosen] : true;
    });
    return {
        div: {
            className: "approval-settings",
            children: [
                { h4: "Approval of record changes" },
                { p: { className: "muted small", textContent: "Changes to records made outside a transaction (on a form, in a list, by an Excel import) can wait until the stewards above approve them, each department in its own steps, never by the person who asked. A transaction is the approved way to change records: it never waits." } },
                box(Boolean(a.edit), "Changing values waits for approval", (on) => set((n) => { n.edit = on ? true : undefined; })),
                a.edit ? { div: { className: "approval-narrow", children: [
                    labelled("Only these fields (none ticked: any field)", narrow(Object.keys(body.fields), editOnly("fields"), toggleEdit("fields"))),
                    labelled("Only in these states (none ticked: any state)", narrow(body.states.list, editOnly("states"), toggleEdit("states"))),
                ] } } : { span: {} },
                box(a.create === true, "A new record waits for approval", (on) => set((n) => { n.create = on || undefined; })),
                actions.length ? box(Boolean(a.actions), "Actions wait for approval", (on) => set((n) => { n.actions = on ? true : undefined; })) : { span: {} },
                a.actions ? { div: { className: "approval-narrow", children: [labelled("Only these actions (none ticked: any action)", narrow(actions, actionsOnly, toggleAction))] } } : { span: {} },
            ],
        },
    };
}

function jsonTab({ api, w, ops, ro }) {
    return {
        div: {
            children: [
                { p: { className: "muted small", textContent: "The whole definition as JSON, for integrators. Apply to replace the draft; every check runs on it as on any other edit." } },
                {
                    CodeEditor: {
                        mode: "json", rows: 28, label: "The definition as JSON", readOnly: ro,
                        value: () => { api.getState(`${w}.vrev`); return api.getState(`${w}.json`, null) ?? JSON.stringify(api.peek(`${w}.b`), null, 2); },
                        onInput: (text) => api.setValue(`${w}.json`, text),
                    },
                },
                ro() ? { span: {} } : {
                    button: {
                        type: "button", className: "btn", textContent: "Apply JSON",
                        onclick: () => {
                            const raw = api.peek(`${w}.json`);
                            if (!raw) return;
                            try {
                                const parsed = JSON.parse(raw);
                                if (parsed.object !== api.peek(`${w}.object`)) throw new Error(`the name must stay "${api.peek(`${w}.object`)}"`);
                                ops.edit((b) => { for (const k of Object.keys(b)) delete b[k]; Object.assign(b, parsed); });
                                api.setValue(`${w}.json`, null);
                            } catch (e) {
                                api.setValue(`${w}.error`, `JSON: ${e.message}`);
                            }
                        },
                    },
                },
            ],
        },
    };
}
