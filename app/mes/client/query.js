// The query console (DESIGN.md §23): a schema explorer, SQL or JSON, and the result. Everything a
// query reads is a view the viewer's policies are compiled into, so it shows what their forms would.
import { titleTab } from "./shell.js";
import { noDefault } from "./select.js";

const JSON_EXAMPLE = JSON.stringify({
    from: "lot",
    select: ["state", { count: "*", as: "lots" }, { avg: "qty", as: "avg_qty" }],
    where: { ne: [{ field: "state" }, "consumed"] },
    groupBy: ["state"],
    orderBy: [{ field: "lots", dir: "desc" }],
}, null, 2);
const ACCESS = { always: "", "in some states": "some states", never: "not readable to you" };

// A cell as text: dates as they came (ISO), objects as JSON, nothing as empty.
const cell = (v) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
// A text cell that a spreadsheet would read as a formula (=, +, -, @, a tab or a return first) is
// written with an apostrophe before it: record values are whatever people typed. Numbers are not text.
export const csvText = (t) => (/^[=+\-@\t\r]/.test(t) ? `'${t}` : t);
export const csvOf = ({ columns, rows }) => [columns, ...rows].map((r) => r.map((v) => {
    const t = typeof v === "number" ? String(v) : csvText(cell(v));
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}).join(",")).join("\r\n");

export function registerQuery(juris) {
    juris.registerComponent("QueryConsole", (props, api) => {
        const [schema, setSchema] = api.useState("schema", null);
        const [filter, setFilter] = api.useState("filter", "");
        const [mode, setMode] = api.useState("mode", "sql");
        // Empty at first: a plant's views are its own (a view's "Use sample query" starts one from it).
        const [sql, setSql] = api.useState("sql", "");
        const [json, setJson] = api.useState("json", JSON_EXAMPLE);
        const [limit, setLimit] = api.useState("limit", 1000);
        const [result, setResult] = api.useState("result", null);
        const [error, setError] = api.useState("error", null);
        const [busy, setBusy] = api.useState("busy", false);

        if (!api.isServer) {
            api.onMount(() => {
                titleTab(api, "/query", "Query");
                api.call("query.schema").then(setSchema, (e) => setError(e.message));
            });
        }
        const run = async () => {
            if (busy() || (mode() === "sql" && !sql().trim())) return;
            setBusy(true);
            setError(null);
            try {
                if (mode() === "sql") {
                    setResult(await api.call("query.sql", { sql: sql(), limit: limit() }));
                } else {
                    let query;
                    try { query = JSON.parse(json()); } catch (e) { throw new Error(`The JSON does not parse: ${e.message}`); }
                    setResult(await api.call("query.json", { query: { ...query, limit: query.limit ?? limit() } }));
                }
            } catch (e) {
                // The last run's rows are not this query's: a refused one shows none, only why.
                setResult(null);
                setError(e.message);
            } finally {
                setBusy(false);
            }
        };
        const download = () => {
            const r = result();
            if (!r) return;
            const url = URL.createObjectURL(new Blob([csvOf(r)], { type: "text/csv;charset=utf-8" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `query-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        const insert = (text) => {
            if (mode() === "sql") setSql(`${sql().replace(/\s*$/, "")} ${text}`);
            else setJson(json());
        };
        // The code editor, highlighted as SQL or JSON, with its own syntax check; Ctrl/⌘ + Enter runs.
        const editor = () => () => (mode() === "sql"
            ? { CodeEditor: { key: "sql", mode: "sql", rows: 12, label: "SQL query", value: () => sql(), onInput: (t) => setSql(t), onSubmit: run } }
            : { CodeEditor: { key: "json", mode: "json", rows: 12, label: "JSON query", value: () => json(), onInput: (t) => setJson(t), onSubmit: run } });

        return {
            div: {
                className: "view query",
                children: [
                    { div: { className: "view-head", children: [{ h1: "Query" }, { span: { className: "muted", textContent: "SQL or JSON over the plant's objects. You see exactly what your roles let you read on the forms." } }] } },
                    {
                        div: {
                            className: "query-layout",
                            children: [
                                // ---- the schema explorer ----
                                {
                                    aside: {
                                        className: "schema",
                                        children: [
                                            { input: { type: "search", className: "filter", placeholder: "Find a view or column…", value: () => filter(), oninput: (e) => setFilter(e.target.value) } },
                                            () => {
                                                const s = schema();
                                                if (!s) return { p: { className: "muted small", textContent: "Loading…" } };
                                                const f = filter().trim().toLowerCase();
                                                const views = s.views.filter((v) => !f || v.name.includes(f) || v.label.toLowerCase().includes(f) || v.columns.some((c) => c.name.includes(f)));
                                                if (!views.length) return { p: { className: "muted small", textContent: "Nothing matches." } };
                                                return {
                                                    div: {
                                                        children: views.map((v) => ({
                                                            details: {
                                                                key: v.name, open: Boolean(f),
                                                                children: [
                                                                    { summary: { children: [{ code: v.name }, { span: { className: "muted small", textContent: ` ${v.label}` } }] } },
                                                                    { div: { className: "schema-actions", children: [
                                                                        { button: { type: "button", className: "linkish", textContent: "Use sample query", onclick: () => { setMode("sql"); setSql(v.sample); } } },
                                                                        { button: { type: "button", className: "linkish", textContent: "Insert name", onclick: () => insert(v.name) } },
                                                                    ] } },
                                                                    v.states?.length && v.kind === "records" ? { div: { className: "muted small", textContent: `states: ${v.states.join(", ")}` } } : { span: {} },
                                                                    {
                                                                        ul: {
                                                                            className: "columns",
                                                                            children: v.columns.filter((c) => !f || v.name.includes(f) || c.name.includes(f)).map((c) => ({
                                                                                li: {
                                                                                    key: c.name,
                                                                                    title: [c.label, c.fieldType ? `field type ${c.fieldType}` : "", c.values ? `values: ${c.values.join(", ")}` : "", c.to ? `refers to ${c.to}` : ""].filter(Boolean).join(" · "),
                                                                                    children: [
                                                                                        { button: { type: "button", className: "linkish col", textContent: c.name, onclick: () => insert(c.name) } },
                                                                                        { span: { className: "muted small", textContent: ` ${c.type}` } },
                                                                                        ACCESS[c.access] ? { span: { className: `access ${c.access === "never" ? "never" : "some"}`, textContent: ACCESS[c.access] } } : { span: {} },
                                                                                    ],
                                                                                },
                                                                            })),
                                                                        },
                                                                    },
                                                                ],
                                                            },
                                                        })),
                                                    },
                                                };
                                            },
                                        ],
                                    },
                                },
                                // ---- the query and its result ----
                                {
                                    section: {
                                        className: "query-main",
                                        children: [
                                            {
                                                nav: {
                                                    className: "subtabs",
                                                    children: [["sql", "SQL"], ["json", "JSON"]].map(([m, l]) => ({ button: { key: m, type: "button", className: "subtab", classList: { active: () => mode() === m }, textContent: l, onclick: () => setMode(m) } })),
                                                },
                                            },
                                            () => (mode() === "json" ? { p: { className: "muted small", textContent: "{ from, select: [column | { count|sum|avg|min|max: column, as }], where: { eq|ne|lt|le|gt|ge|like|ilike: [{ field }, value] } with all, any, not, in, is_null, groupBy, orderBy: [{ field, dir }], limit }" } } : { p: { className: "muted small", textContent: "One SELECT over the views on the left (WITH is fine). Ctrl/⌘ + Enter runs it." } }),
                                            editor(),
                                            {
                                                div: {
                                                    className: "query-bar",
                                                    children: [
                                                        { button: { type: "button", className: "btn primary", disabled: () => busy() || (mode() === "sql" && !sql().trim()), textContent: () => (busy() ? "Running…" : "Run"), onclick: run } },
                                                        { label: { className: "muted small", children: [{ span: "at most " }, { select: { onchange: (e) => setLimit(Number(e.target.value)), children: noDefault([100, 1000, 5000, 10000].map((n) => ({ option: { value: n, selected: () => limit() === n, textContent: `${n} rows` } }))) } }] } },
                                                        { span: { className: "spacer" } },
                                                        { button: { type: "button", className: "btn ghost", disabled: () => !result(), textContent: "Download CSV", onclick: download } },
                                                        () => (mode() === "json" && result() ? { button: { type: "button", className: "btn ghost", textContent: "Open as SQL", onclick: () => { setSql(result().sql); setMode("sql"); } } } : { span: {} }),
                                                    ],
                                                },
                                            },
                                            { p: { className: "error", role: "alert", textContent: () => error() ?? "" } },
                                            () => {
                                                const r = result();
                                                if (!r) return { span: {} };
                                                return {
                                                    div: {
                                                        className: "query-result",
                                                        children: [
                                                            { p: { className: "muted small", textContent: `${r.rows.length} row(s)${r.truncated ? `, stopped at ${r.limit}: there are more` : ""} · ${r.ms} ms` } },
                                                            r.columns.length ? {
                                                                div: {
                                                                    className: "grid-scroll",
                                                                    children: [{
                                                                        table: {
                                                                            className: "grid",
                                                                            children: [
                                                                                { thead: { children: [{ tr: { children: r.columns.map((c) => ({ th: c })) } }] } },
                                                                                { tbody: { children: r.rows.map((row, i) => ({ tr: { key: i, children: row.map((v, k) => ({ td: { key: k, className: v === null ? "null" : "", textContent: v === null ? "null" : cell(v) } })) } })) } },
                                                                            ],
                                                                        },
                                                                    }],
                                                                },
                                                            } : { p: { className: "muted", textContent: "No columns." } },
                                                        ],
                                                    },
                                                };
                                            },
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
}
