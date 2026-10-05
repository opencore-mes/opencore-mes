// A model file (DESIGN.md §24.1): the whole model to another installation, as one file, and from one.
// Export: every published design, and the records of each object unless it is asked for empty.
// Import: previewed first; its designs start one change request (reviewed and approved like any); its
// records are loaded once that change has executed, through the record services, as the person.
import { titleTab } from "./shell.js";
import { askDialog } from "./dialog.js";
import { icon } from "./icons.js";
import { windowRows } from "./window-rows.js";
import { plant } from "./format.js";

const KIND_WORDS = { definitions: "object", scripts: "script", connections: "connection", services: "service", transactions: "transaction", screens: "screen", flows: "flow template", layouts: "report layout", elements: "design element" };
const WILL = { create: "to create", update: "to update", approval: "to wait for approval", unchanged: "unchanged", refused: "refused" };
const DID = { create: "created", update: "updated", approval: "sent for approval", unchanged: "unchanged", refused: "refused" };

export function registerModelFile(juris) {
    juris.registerComponent("ModelFilePage", (props, api) => {
        const [objects, setObjects] = api.useState("objects", null);
        const [empty, setEmpty] = api.useState("empty", []);        // objects exported without their records
        const [file, setFile] = api.useState("file", null);          // { name, size }
        const [preview, setPreview] = api.useState("preview", null);
        const [loaded, setLoaded] = api.useState("loaded", null);    // its records: a preview of the load, or the load
        const [error, setError] = api.useState("error", null);
        const [busy, setBusy] = api.useState("busy", false);
        let bytes = null; // the chosen file's contents, kept out of state

        if (!api.isServer) {
            api.onMount(() => {
                titleTab(api, "/design/model", "Model file");
                api.call("model.objects", { as: api.getState("me.id", null) }).then(setObjects, (e) => setError(e.message));
            });
        }
        const post = async (path) => {
            const answer = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: bytes });
            const body = await answer.json().catch(() => ({}));
            if (!answer.ok) throw new Error(body.error ?? `The request failed (${answer.status}).`);
            return body;
        };
        const working = async (what) => {
            setBusy(true);
            setError(null);
            try { await what(); } catch (e) { setError(e.message); } finally { setBusy(false); }
        };
        const pick = async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            bytes = await f.arrayBuffer();
            api.batch(() => { setFile({ name: f.name, size: f.size }); setPreview(null); setLoaded(null); });
            working(async () => setPreview(await post("/model-file/preview")));
        };
        const start = () => working(async () => { const made = await post("/model-file/start"); api.navigate(`/design/c/${made.id}`); });
        const load = (apply) => working(async () => {
            let reason = "";
            const waits = apply ? (loaded()?.models ?? []).reduce((n, m) => n + (m.counts.approval ?? 0), 0) : 0;
            if (waits) {
                reason = await askDialog(api, { title: "Send for approval", message: `${waits} record(s) of this file change what waits for approval: each becomes a request, applied once its stewards sign. Say why.`, label: "Why", required: true, multiline: true, confirm: "Load" });
                if (reason === null) return;
            }
            setLoaded(await post(`/model-file/records?apply=${apply ? 1 : 0}${reason ? `&reason=${encodeURIComponent(reason)}` : ""}`));
        });
        const exportable = () => (objects() ?? []).filter((o) => !o.emptyBecause && o.records);
        const exportUrl = () => `/model-file/export${empty().length ? `?empty=${encodeURIComponent(empty().join(","))}` : ""}`;
        const count = (n) => plant().number(n);

        // ---- export: which objects go with their records ----
        const objectRow = (o) => ({
            label: {
                className: o.emptyBecause || !o.records ? "muted" : "",
                children: [
                    { input: { type: "checkbox", disabled: Boolean(o.emptyBecause) || !o.records, checked: () => !o.emptyBecause && o.records > 0 && !empty().includes(o.object), "aria-label": `${o.label}: with its records`, onchange: (e) => setEmpty(e.target.checked ? empty().filter((x) => x !== o.object) : [...empty(), o.object]) } },
                    { span: ` ${o.label}` },
                    { span: { className: "muted small", textContent: o.emptyBecause ? ` · empty: ${o.emptyBecause}` : o.records ? ` · ${count(o.records)} record(s)` : " · no records" } },
                ],
            },
        });
        const exportPanel = {
            section: {
                className: "panel",
                children: [
                    { h2: "Export" },
                    { p: { className: "muted small", textContent: "One file with every published design: objects, rules, services and connections, transactions, screens, flow templates, report layouts, and the roles departments hold. Ticked, an object goes with its records as you may read them; unticked, it goes empty. Secrets, people, history and the audit trail are not in it." } },
                    () => {
                        const list = objects();
                        if (!list) return { p: { className: "muted", textContent: "Loading…" } };
                        return { div: { children: [
                            { div: { className: "query-bar", children: [
                                { button: { type: "button", className: "btn small", textContent: "All with records", disabled: () => !empty().length, onclick: () => setEmpty([]) } },
                                { button: { type: "button", className: "btn small", textContent: "All empty", disabled: () => empty().length === exportable().length, onclick: () => setEmpty(exportable().map((o) => o.object)) } },
                            ] } },
                            windowRows({ key: `model-objects-${list.length}`, tag: "div", className: "checks-col", count: list.length, row: (i) => objectRow(list[i]) }),
                        ] } };
                    },
                    () => {
                        const withRecords = exportable().filter((o) => !empty().includes(o.object));
                        const total = withRecords.reduce((n, o) => n + o.records, 0);
                        return { p: { className: "small", textContent: objects() ? `${objects().length} object(s); ${withRecords.length} with records (${count(total)} in all), the rest empty.` : "" } };
                    },
                    () => ({ a: { className: "btn primary", href: exportUrl(), download: "", textContent: "Export model" } }),
                ],
            },
        };

        // ---- import ----
        const importPanel = {
            section: {
                className: "panel",
                children: [
                    { h2: "Import" },
                    { p: { className: "muted small", textContent: "Choose a model file exported from another installation. It is checked first and nothing changes: its designs then start one change request, reviewed and approved here like any other; its records are loaded once that change has executed." } },
                    { input: { type: "file", accept: ".json,application/json", "aria-label": "A model file", onchange: pick } },
                    () => (file() ? { p: { className: "small", textContent: `${file().name} · ${count(Math.max(1, Math.round(file().size / 1024)))} KB` } } : { span: {} }),
                    () => (busy() ? { p: { className: "muted", textContent: "Working…" } } : { span: {} }),
                ],
            },
        };
        const previewOf = () => {
            const p = preview();
            if (!p) return { span: {} };
            const d = p.designs;
            const todo = d.new + d.changed + d.roles.length;
            const from = p.about?.from ?? {};
            const ready = p.records.filter((r) => r.live && !r.waits);
            return {
                div: {
                    className: "import-result",
                    children: [
                        { h2: "What this file would do here: nothing has changed yet" },
                        { p: { className: "muted small", textContent: `Exported ${p.about?.exportedAt ? plant().dateTime(p.about.exportedAt) : "at an unknown time"}${from.site ? ` from ${from.site}` : ""}${p.about?.by ? ` by ${p.about.by}` : ""}.` } },
                        {
                            section: {
                                className: "panel",
                                children: [
                                    { h3: "Its designs" },
                                    { p: { textContent: `${d.new} new · ${d.changed} changed · ${d.same} the same as live${d.roles.length ? ` · ${d.roles.length} role(s) to give` : ""}` } },
                                    d.elements.length ? windowRows({ key: `model-elements-${p.hash}`, tag: "ul", className: "small", count: d.elements.length, row: (i) => ({ li: { children: [{ span: { className: `badge ${d.elements[i].status === "new" ? "s-executed" : "s-review"}`, textContent: d.elements[i].status } }, { span: ` ${KIND_WORDS[d.elements[i].kind] ?? d.elements[i].kind} ${d.elements[i].label}` }] } }) }) : { span: {} },
                                    ...(d.problems.length ? [
                                        { p: { key: "problems", className: "import-model", children: [icon("warning"), { span: { textContent: `${d.problems.length} thing(s) to put right in the change before it can be submitted:` } }] } },
                                        windowRows({ key: `model-problems-${p.hash}`, tag: "ul", className: "muted small", count: d.problems.length, row: (i) => ({ li: { textContent: [d.problems[i].path, d.problems[i].message].filter(Boolean).join(": ") } }) }),
                                    ] : []),
                                    ...p.needs.map((n, i) => ({ p: { key: `need-${i}`, className: "import-model", children: [icon("warning"), { span: { textContent: n.words } }] } })),
                                    ...(p.about?.notes ?? []).map((n, i) => ({ p: { key: `note-${i}`, className: "muted small", textContent: n } })),
                                    todo
                                        ? { div: { className: "query-bar", children: [{ button: { type: "button", className: "btn primary", disabled: () => busy(), textContent: `Start a change from it (${d.new + d.changed} design(s))`, onclick: start } }, { span: { className: "muted small", textContent: "Nothing is live until it is reviewed and approved." } }] } }
                                        : { p: { className: "notice", textContent: "Every design in this file is live here already." } },
                                ],
                            },
                        },
                        {
                            section: {
                                className: "panel",
                                children: [
                                    { h3: "Its records" },
                                    p.records.length
                                        ? windowRows({ key: `model-records-${p.hash}`, tag: "ul", className: "small", count: p.records.length, row: (i) => { const r = p.records[i]; return { li: { textContent: `${r.label}: ${count(r.rows)} record(s)${r.waits ? `, ${r.waits}.` : ""}` } }; } })
                                        : { p: { className: "muted small", textContent: "None: every object was exported empty." } },
                                    ...((p.about?.left ?? []).map((l) => ({ p: { key: `left-${l.object}`, className: "muted small", textContent: `${l.object} was left empty: ${l.why}.` } }))),
                                    ready.length && !loaded()
                                        ? { div: { className: "query-bar", children: [{ button: { type: "button", className: "btn", disabled: () => busy(), textContent: "Check its records", onclick: () => load(false) } }, { span: { className: "muted small", textContent: "Each is checked as at a form, as you: nothing is written yet. A record arrives in its object's first state." } }] } }
                                        : { span: {} },
                                ],
                            },
                        },
                    ],
                },
            };
        };
        const loadedOf = () => {
            const r = loaded();
            if (!r) return { span: {} };
            const words = r.applied ? DID : WILL;
            const changes = r.models.reduce((n, m) => n + m.counts.create + m.counts.update + (m.counts.approval ?? 0), 0);
            const refused = r.models.reduce((n, m) => n + m.counts.refused, 0);
            return {
                div: {
                    className: "import-result",
                    children: [
                        { h2: r.applied ? "Its records: loaded" : "Its records: checked, nothing written yet" },
                        (r.warnings ?? []).length ? { ul: { className: "muted small", children: r.warnings.map((w, i) => ({ li: { key: i, textContent: w } })) } } : { span: {} },
                        ...r.models.map((m) => ({
                            section: {
                                key: m.object, className: "panel",
                                children: [
                                    { h3: m.label },
                                    { p: { textContent: `${Object.entries(m.counts).map(([k, n]) => `${count(n)} ${words[k]}`).join(" · ")}${m.linked ? ` · ${count(m.linked)} reference(s) set afterwards` : ""}` } },
                                    ...(m.warnings ?? []).map((w, i) => ({ p: { key: `w${i}`, className: "muted small", textContent: w } })),
                                    (m.rows ?? []).length ? windowRows({ key: `model-refused-${m.object}-${m.rows.length}`, tag: "ul", className: "small", count: m.rows.length, row: (i) => ({ li: { textContent: `Row ${m.rows[i].row}: ${[m.rows[i].message, m.rows[i].fields && Object.entries(m.rows[i].fields).map(([k, v]) => `${k}: ${v}`).join("; ")].filter(Boolean).join(" ")}` } }) }) : { span: {} },
                                    m.moreRefused ? { p: { className: "muted small", textContent: `…and ${count(m.moreRefused)} more refused row(s).` } } : { span: {} },
                                ],
                            },
                        })),
                        r.applied
                            ? { p: { className: "notice", textContent: `Done: ${count(changes)} record(s) written or sent for approval${refused ? `, ${count(refused)} refused (above)` : ""}. Loading the same file again adds nothing.` } }
                            : { div: { className: "query-bar", children: [
                                { button: { type: "button", className: "btn primary", disabled: () => busy() || !changes, textContent: changes ? `Load ${count(changes)} record(s)` : "Nothing to load", onclick: () => load(true) } },
                                refused ? { span: { className: "muted small", textContent: `${count(refused)} row(s) would be left out.` } } : { span: {} },
                            ] } },
                    ],
                },
            };
        };

        return {
            div: {
                className: "view transfer model-file",
                children: [
                    { div: { className: "view-head", children: [{ h1: "Model file" }, { span: { className: "muted", textContent: "The whole model to another installation, or from one: designs through review and approval, records through the same rights, rules and audit as the forms." } }] } },
                    { p: { className: "error", role: "alert", textContent: () => error() ?? "" } },
                    { div: { className: "transfer-grid", children: [exportPanel, importPanel] } },
                    previewOf,
                    loadedOf,
                ],
            },
        };
    });
}
