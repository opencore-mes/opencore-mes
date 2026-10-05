// Excel import and export (DESIGN.md §24): export models (with the records they refer to) to a
// workbook; import a workbook of any number of models, previewed first, then applied.
import { titleTab } from "./shell.js";
import { askDialog, confirmDialog } from "./dialog.js";
import { icon } from "./icons.js";

// "approval": a row whose change waits for approval (§28): applied, it becomes a request.
const ACTIONS = { create: "created", update: "updated", approval: "sent for approval", unchanged: "unchanged", refused: "refused" };
const WILL = { create: "to create", update: "to update", approval: "to wait for approval", unchanged: "unchanged", refused: "refused" };

export function registerTransfer(juris) {
    juris.registerComponent("TransferPage", (props, api) => {
        const [models, setModels] = api.useState("models", null);
        const [chosen, setChosen] = api.useState("chosen", []);
        const [related, setRelated] = api.useState("related", true);
        const [file, setFile] = api.useState("file", null);          // { name, size }
        const [result, setResult] = api.useState("result", null);
        const [error, setError] = api.useState("error", null);
        const [busy, setBusy] = api.useState("busy", false);
        let bytes = null; // the chosen file's contents, kept out of state

        if (!api.isServer) {
            api.onMount(() => {
                titleTab(api, "/transfer", "Import / export");
                api.call("transfer.models").then(setModels, (e) => setError(e.message));
            });
        }
        const send = async (apply, reason = "") => {
            if (!bytes) return;
            setBusy(true);
            setError(null);
            try {
                const answer = await fetch(`/transfer/import?apply=${apply ? 1 : 0}${reason ? `&reason=${encodeURIComponent(reason)}` : ""}`, { method: "POST", headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, body: bytes });
                const body = await answer.json();
                if (!answer.ok) throw new Error(body.error ?? `The import failed (${answer.status}).`);
                setResult(body);
            } catch (e) {
                setError(e.message);
            } finally {
                setBusy(false);
            }
        };
        const pick = async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            bytes = await f.arrayBuffer();
            setFile({ name: f.name, size: f.size });
            setResult(null);
            send(false);
        };
        const exportUrl = () => `/transfer/export.xlsx?objects=${encodeURIComponent(chosen().join(","))}&related=${related() ? 1 : 0}`;

        return {
            div: {
                className: "view transfer",
                children: [
                    { div: { className: "view-head", children: [{ h1: "Import / export" }, { span: { className: "muted", textContent: "Excel workbooks: a tab per model. Imports go through the same rights, rules and audit as the forms." } }] } },
                    { p: { className: "error", role: "alert", textContent: () => error() ?? "" } },
                    {
                        div: {
                            className: "transfer-grid",
                            children: [
                                // ---- export ----
                                {
                                    section: {
                                        className: "panel",
                                        children: [
                                            { h2: "Export" },
                                            () => {
                                                const list = models();
                                                if (!list) return { p: { className: "muted", textContent: "Loading…" } };
                                                return {
                                                    div: {
                                                        className: "checks-col",
                                                        children: list.map((m) => ({
                                                            label: {
                                                                key: m.object,
                                                                className: m.export ? "" : "muted",
                                                                children: [
                                                                    { input: { type: "checkbox", disabled: !m.export, checked: () => chosen().includes(m.object), onchange: (e) => setChosen(e.target.checked ? [...chosen(), m.object] : chosen().filter((o) => o !== m.object)) } },
                                                                    { span: ` ${m.label}` },
                                                                    { span: { className: "muted small", textContent: m.export ? (m.refers.length ? ` · refers to ${m.refers.join(", ")}` : "") : " · its design does not allow export" } },
                                                                ],
                                                            },
                                                        })),
                                                    },
                                                };
                                            },
                                            { label: { className: "small", children: [{ input: { type: "checkbox", checked: () => related(), onchange: (e) => setRelated(e.target.checked) } }, { span: " Include the records they refer to, each model in its own tab" }] } },
                                            () => (chosen().length
                                                ? { a: { className: "btn primary", href: exportUrl(), download: "", textContent: `Download ${chosen().length} model(s)` } }
                                                : { button: { type: "button", className: "btn primary", disabled: true, textContent: "Choose models to export" } }),
                                        ],
                                    },
                                },
                                // ---- import ----
                                {
                                    section: {
                                        className: "panel",
                                        children: [
                                            { h2: "Import" },
                                            { p: { className: "muted small", textContent: "Each tab is named after its model (lot, work_order…); the first row names the fields. Several models may come in one file: they load in order, work orders before the lots that refer to them. A row exported from a record someone has changed since is refused, not written over (empty its row_version cell to write over it). Nothing changes until you apply." } },
                                            { input: { type: "file", accept: ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", onchange: pick } },
                                            () => (file() ? { p: { className: "small", textContent: `${file().name} · ${Math.round(file().size / 1024)} KB` } } : { span: {} }),
                                            () => (busy() ? { p: { className: "muted", textContent: "Checking…" } } : { span: {} }),
                                        ],
                                    },
                                },
                            ],
                        },
                    },
                    () => {
                        const r = result();
                        if (!r) return { span: {} };
                        const words = r.applied ? ACTIONS : WILL;
                        const refused = r.models.reduce((n, m) => n + m.counts.refused, 0);
                        const changes = r.models.reduce((n, m) => n + m.counts.create + m.counts.update, 0);
                        const waits = r.models.reduce((n, m) => n + (m.counts.approval ?? 0), 0);
                        // A model changed since the file was exported (§24): applied only once the person says so.
                        const moved = r.models.filter((m) => m.model);
                        // Rows that wait for approval need a reason, asked once for the whole import.
                        const apply = async () => {
                            if (moved.length && !(await confirmDialog(api, { title: "Apply to a changed model?", message: `${moved.map((m) => m.label).join(", ")} changed since this file was exported (see the preview). Each row is checked against the model in use; check that the file's values still mean what they meant.`, confirm: "Apply anyway" }))) return;
                            let reason = "";
                            if (waits) {
                                reason = await askDialog(api, { title: "Send for approval", message: `${waits} row(s) of this import change what waits for approval: each becomes a change request, applied once its stewards sign. Say why.`, label: "Why", required: true, multiline: true, confirm: "Apply" });
                                if (reason === null) return;
                            }
                            send(true, reason);
                        };
                        return {
                            div: {
                                className: "import-result",
                                children: [
                                    { h2: r.applied ? "Applied" : "Preview: nothing has changed yet" },
                                    r.warnings.length ? { ul: { className: "muted small", children: r.warnings.map((w, i) => ({ li: { key: i, textContent: w } })) } } : { span: {} },
                                    ...r.models.map((m) => ({
                                        section: {
                                            key: m.object,
                                            className: "panel",
                                            children: [
                                                { h3: m.label },
                                                { p: { className: "muted small", textContent: `Matched by ${m.key}. Its design allows import to ${[m.create && "create", m.update && "update"].filter(Boolean).join(" and ") || "do nothing"}.` } },
                                                { p: { textContent: Object.entries(m.counts).map(([k, n]) => `${n} ${words[k]}`).join(" · ") } },
                                                ...(m.model ? [{ p: { key: "model", className: "import-model", children: [icon("warning"), { span: { textContent: m.model.message } }] } }] : []),
                                                ...m.warnings.filter((w) => w !== m.model?.message).map((w, i) => ({ p: { key: `w${i}`, className: "muted small", textContent: w } })),
                                                m.rows.length ? {
                                                    table: {
                                                        className: "grid",
                                                        children: [
                                                            { thead: { children: [{ tr: { children: ["Row", "", "Details"].map((h) => ({ th: h })) } }] } },
                                                            { tbody: { children: m.rows.map((row) => ({ tr: { key: row.row, children: [
                                                                { td: String(row.row) },
                                                                { td: { children: [{ span: { className: `badge ${row.action === "refused" ? "s-rejected" : row.action === "approval" ? "s-review" : "s-executed"}`, textContent: words[row.action] ?? row.action } }] } },
                                                                { td: [row.message, row.fields && (Array.isArray(row.fields) ? `fields: ${row.fields.join(", ")}` : Object.entries(row.fields).map(([k, v]) => `${k}: ${v}`).join("; ")), row.note].filter(Boolean).join(" · ") },
                                                            ] } })) } },
                                                        ],
                                                    },
                                                } : { span: {} },
                                            ],
                                        },
                                    })),
                                    r.applied
                                        ? { p: { className: "notice", textContent: `Done: ${changes} record(s) written${waits ? `, ${waits} sent for approval (Approvals)` : ""}${refused ? `, ${refused} row(s) refused (see above)` : ""}. Applying the same file again changes nothing twice.` } }
                                        : { div: { className: "query-bar", children: [
                                            { button: { type: "button", className: "btn primary", disabled: () => busy() || changes + waits === 0, textContent: changes + waits ? `Apply ${changes + waits} change(s)${waits ? ` (${waits} to wait for approval)` : ""}` : "Nothing to apply", onclick: apply } },
                                            refused ? { span: { className: "muted small", textContent: `${refused} row(s) will be left out; fix them in the file and choose it again to include them.` } } : { span: {} },
                                        ] } },
                                ],
                            },
                        };
                    },
                ],
            },
        };
    });
}
