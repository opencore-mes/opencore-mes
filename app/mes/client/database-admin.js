// The Database area (DESIGN.md §38): for whoever People & departments makes a database administrator. What
// people and systems ask of the platform (every call of a web service, a transaction, a named query and the
// platform's own services, by how it came: a page, the web, a route…, §38.1), what the platform asks of the database (every statement it sent, counted per hour: how often, how long, from
// which service), a statement's plan, the tables and their indexes (how often each is used), the AI's
// proposals for indexes with their estimate, and what an index built here did (its statements' time before
// and after). An index is built or dropped here at once, with why, in the audit trail; only one built here is
// dropped here.
import { icon, withIcon } from "./icons.js";
import { plant } from "./format.js";
import { titleTab } from "./shell.js";
import { askDialog, confirmDialog } from "./dialog.js";
import { windowRows } from "./window-rows.js";
import { editorPanel } from "./editor-kit.js";
import { sortRows } from "./sort.js";
import { noDefault } from "./select.js";

const A = "dbx";
const ms = (v) => (v === null || v === undefined ? "—" : v >= 1000 ? `${plant().number(Math.round(v / 100) / 10)} s` : `${plant().number(Math.round(v * 100) / 100)} ms`);
const count = (v) => (v === null || v === undefined ? "—" : plant().number(v));
const bytes = (b) => (b === null || b === undefined ? "—" : b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} kB` : `${b} B`);
const topSource = (sources) => Object.entries(sources ?? {}).sort((a, b) => b[1] - a[1]).map(([k]) => k)[0] ?? "—";
// What each kind of call and each way in is called, in words.
const KIND_WORDS = { platform: "platform", service: "web service", transaction: "transaction", preview: "preview", query: "named query" };
const CHANNEL_WORDS = { page: "a page", live: "a live list", web: "the web", ai: "an AI", service: "a service", route: "a route", trigger: "a trigger", schedule: "a schedule", screen: "a screen's table", choices: "choices", plan: "a plan", test: "the fitness test", internal: "the server" };
const channelsWords = (ch) => Object.entries(ch ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${CHANNEL_WORDS[k] ?? k} ${count(v)}`).join(" · ");
const upTo = (v) => (v === null || v === undefined ? "> 10 s" : `≤ ${ms(v)}`);
const keysWords = (spec) => (spec?.keys ?? []).map((k) => (k.field ? k.field : `${k.column}${k.desc ? " desc" : ""}`)).join(", ");

export function registerDatabaseAdmin(juris) {
    juris.registerComponent("DatabaseAdmin", (props, api) => {
        const load = () => {
            api.setValue(`${A}.loading`, true);
            return api.call("database.overview", { hours: api.peek(`${A}.hours`) ?? 24 })
                .then((o) => api.batch(() => { api.setValue(`${A}.o`, o); api.setValue(`${A}.error`, null); api.setValue(`${A}.loading`, false); }),
                    (e) => api.batch(() => { api.setValue(`${A}.error`, e.message); api.setValue(`${A}.loading`, false); }));
        };
        if (!api.isServer) api.onMount(() => { titleTab(api, "/design/database", "Database"); load(); });
        const said = (ok, words) => api.setValue(`${A}.said`, { ok, words });

        // A list's head that sorts it (in the browser: the area holds at most 500 statements and the tables
        // and indexes of one database).
        const sortedBy = (list) => api.getState(`${A}.sort.${list}`, null);
        const head = (list, cols) => cols.map(([key, label]) => {
            if (!key) return { th: label };
            const now = sortedBy(list);
            const on = now?.key === key;
            return { th: { "aria-sort": on ? (now.dir === "desc" ? "descending" : "ascending") : "none", children: [{ button: { type: "button", className: `sort-head${on ? " on" : ""}`, title: `Sort by ${label}`,
                onclick: () => api.setValue(`${A}.sort.${list}`, !on ? { key, dir: "desc" } : now.dir === "desc" ? { key, dir: "asc" } : null),
                children: [{ span: label }, icon(on && now.dir === "asc" ? "arrowUp" : "arrowDown", { className: `sort-arrow${on ? "" : " idle"}` })] } }] } };
        });
        const sorted = (list, rows, get) => { const s = sortedBy(list); return s ? sortRows(rows, (r) => get(r, s.key), s.dir) : rows; };
        // A table drawn a window at a time, its head sorting it.
        const table = (list, cols, rows, get, row, className = "") => {
            const ordered = sorted(list, rows, get);
            return { div: { className: "win-box dbx-list", children: [{ table: { className: `grid ${className}`.trim(), children: [
                { thead: { children: [{ tr: { children: head(list, cols) } }] } },
                windowRows({ key: `dbx-${list}-${rows.length}-${JSON.stringify(sortedBy(list))}`, columns: cols.length, count: rows.length, row: (i) => row(ordered[i]) }),
            ] } }] } };
        };

        // Every call, by name: the designs that answer one (web services, transactions, their previews, named
        // queries) and, asked for, the platform's own services; who calls how often, how long, refused or failed.
        const callsPanel = () => {
            const o = api.getState(`${A}.o`, null);
            if (!o) return { span: {} };
            const which = api.getState(`${A}.callKind`, "designs");
            const q = String(api.getState(`${A}.cq`, "") ?? "").trim().toLowerCase();
            const rows = (o.calls ?? []).filter((c) => (which === "all" || (which === "platform" ? c.kind === "platform" : c.kind !== "platform")) && (!q || c.name.toLowerCase().includes(q) || Object.keys(c.channels ?? {}).some((k) => (CHANNEL_WORDS[k] ?? k).includes(q))));
            return { section: { className: "panel", "aria-label": "Calls", children: [
                { h3: { className: "icon-text", children: [icon("play"), { span: "Calls" }] } },
                { p: { className: "muted small", textContent: `What people and systems asked of the platform in the last ${o.hours} hour(s), every instance's, slowest in all first: each web service, transaction and named query by its own name, however it was called (a page, the web, a route, a screen's table…), and the platform's own services. No input or value is kept. Click one for its callers, why it was refused and the statements it sent.` } },
                { div: { className: "list-bar", children: [
                    { input: { type: "search", className: "filter", placeholder: "Find a call: a name, a way in (the web)", "aria-label": "Find a call", value: () => api.getState(`${A}.cq`, "") ?? "", oninput: (e) => api.setValue(`${A}.cq`, e.target.value) } },
                    { select: { "aria-label": "Which calls", onchange: (e) => api.setValue(`${A}.callKind`, e.target.value), children: noDefault([["designs", "Designs"], ["platform", "The platform's services"], ["all", "Every call"]].map(([v, l]) => ({ option: { value: v, selected: which === v, textContent: l } }))) } },
                ] } },
                rows.length ? table("calls", [["name", "Name"], ["kind", "Kind"], ["calls", "Calls"], ["meanMs", "Mean"], ["p95", "95% within"], ["maxMs", "Slowest"], ["refused", "Refused"], ["failed", "Failed"], ["from", "From"]], rows,
                    (c, k) => (k === "from" ? Object.keys(c.channels ?? {}).length : k === "p95" ? c.p95 ?? Infinity : c[k]),
                    (c) => ({ tr: { key: `${c.kind}:${c.name}`, className: "row", onclick: () => openCall(c), children: [
                        { td: { children: [{ code: c.name }] } }, { td: { className: "small", textContent: KIND_WORDS[c.kind] ?? c.kind } },
                        { td: { className: "num", textContent: count(c.calls) } }, { td: { className: "num", textContent: ms(c.meanMs) } }, { td: { className: "num", textContent: upTo(c.p95) } }, { td: { className: "num", textContent: ms(c.maxMs) } },
                        { td: { className: `num${c.refused ? " dbx-unused" : ""}`, textContent: count(c.refused) } }, { td: { className: `num${c.failed ? " dbx-refused" : ""}`, textContent: count(c.failed) } },
                        { td: { className: "small", textContent: channelsWords(c.channels) } },
                    ] } }), "dbx-calls") : { p: { className: "muted", textContent: q ? `No call has "${q}" in it.` : which === "designs" ? "No web service, transaction or named query was called in this time." : "Nothing counted yet: the platform writes what it counted once a minute." } },
            ] } };
        };
        const openCall = (c) => {
            api.setValue(`${A}.open`, { kind: "call", c, detail: null });
            api.call("database.call", { kind: c.kind, name: c.name, hours: api.peek(`${A}.hours`) ?? 24 }).then((d) => api.setValue(`${A}.open.detail`, d), (e) => api.setValue(`${A}.open.detail`, { error: e.message }));
        };

        const statementsPanel = () => {
            const o = api.getState(`${A}.o`, null);
            if (!o) return { span: {} };
            const q = String(api.getState(`${A}.q`, "") ?? "").trim().toLowerCase();
            const rows = (o.statements ?? []).filter((s) => !q || s.text.toLowerCase().includes(q) || Object.keys(s.sources ?? {}).some((k) => k.toLowerCase().includes(q)));
            return { section: { className: "panel", "aria-label": "Statements", children: [
                { h3: { className: "icon-text", children: [icon("database"), { span: "Statements" }] } },
                { p: { className: "muted small", textContent: `What the platform sent the database in the last ${o.hours} hour(s), every instance's, slowest in all first: ${count(o.totals.statements)} statements, ${count(o.totals.calls)} calls, ${ms(o.totals.totalMs)} in all. Their values are never kept; click one for its text, who sent it and its plan.` } },
                { input: { type: "search", className: "filter", placeholder: "Find a statement: a table, a word, a service", "aria-label": "Find a statement", value: () => api.getState(`${A}.q`, "") ?? "", oninput: (e) => api.setValue(`${A}.q`, e.target.value) } },
                rows.length ? table("statements", [["text", "Statement"], ["calls", "Calls"], ["meanMs", "Mean"], ["maxMs", "Slowest"], ["totalMs", "In all"], ["rows", "Rows"], ["source", "Mostly from"]], rows,
                    (s, k) => (k === "source" ? topSource(s.sources) : s[k]),
                    (s) => ({ tr: { key: s.key, className: "row", onclick: () => openStatement(s), children: [
                        { td: { className: "dbx-sql", title: s.text, children: [{ code: s.text.slice(0, 160) }] } },
                        { td: { className: "num", textContent: count(s.calls) } }, { td: { className: "num", textContent: ms(s.meanMs) } }, { td: { className: "num", textContent: ms(s.maxMs) } },
                        { td: { className: "num", textContent: ms(s.totalMs) } }, { td: { className: "num", textContent: count(s.rows) } }, { td: { className: "small", textContent: topSource(s.sources) } },
                    ] } }), "dbx-statements") : { p: { className: "muted", textContent: q ? `No statement has "${q}" in it.` : "Nothing counted yet: the platform writes what it counted once a minute." } },
            ] } };
        };
        const openStatement = (s) => {
            api.setValue(`${A}.open`, { kind: "statement", s, detail: null });
            api.call("database.statement", { key: s.key }).then((d) => api.setValue(`${A}.open.detail`, d), (e) => api.setValue(`${A}.open.detail`, { plan: { error: e.message }, hours: [] }));
        };

        const proposalsPanel = () => {
            const o = api.getState(`${A}.o`, null);
            if (!o) return { span: {} };
            const p = api.getState(`${A}.proposals`, null);
            const asking = api.getState(`${A}.asking`, false);
            const ask = () => {
                api.batch(() => { api.setValue(`${A}.asking`, true); api.setValue(`${A}.proposals`, null); });
                api.call("database.propose", { hours: o.hours }).then((r) => api.batch(() => { api.setValue(`${A}.proposals`, r); api.setValue(`${A}.asking`, false); }),
                    (e) => api.batch(() => { said(false, e.message); api.setValue(`${A}.asking`, false); }));
            };
            const build = async (x) => {
                const why = await askDialog(api, { title: `Build ${x.name}`, message: `${x.sql}\n\nBuilt at once, without stopping writes to the table. Kept with the index and in the audit trail: why.`, label: "Why", value: x.why, required: true, multiline: true, confirm: "Build" });
                if (why === null) return;
                api.call("database.createIndex", { spec: x.spec, why, statements: x.statements }).then((r) => { said(true, `${r.name} is being built; it shows as ready below when it is.`); load(); }, (e) => said(false, e.message));
            };
            return { section: { className: "panel", "aria-label": "Proposals", children: [
                { h3: { className: "icon-text", children: [icon("sparkle"), { span: "Indexes the AI proposes" }] } },
                { p: { className: "muted small", textContent: o.installed.ai
                    ? `The AI reads the slowest statements, their plans, the tables and the indexes, and proposes indexes as a description; the server writes each statement, with the expressions the platform's queries use. It never builds one: you do.${o.installed.hypopg ? " Each is tried as a hypothetical index first (HypoPG): its statements' plan cost now, and with it." : " With HypoPG installed, each would be tried as a hypothetical index first; without it, an index's effect is measured once it is built (below, under Indexes)."}`
                    : "No AI is set up for this plant (AI_PROVIDER, app/mes/README.md): the statements, plans and indexes are here to read without one." } },
                o.installed.ai ? { button: { type: "button", className: "btn", disabled: asking, onclick: ask, children: [withIcon("sparkle", asking ? "Reading the statements…" : "Ask the AI for indexes")] } } : { span: {} },
                p ? { p: { className: "dbx-summary", textContent: p.summary || "No summary." } } : { span: {} },
                ...(p?.proposals ?? []).map((x, i) => ({ div: { key: `p${i}`, className: "tx-card dbx-proposal", children: [
                    { div: { className: "dbx-proposal-head", children: [{ strong: x.spec.object ? `${x.spec.object}: ${keysWords(x.spec)}` : `${x.spec.table}: ${keysWords(x.spec)}` }, x.spec.inUse ? { span: { className: "muted small", textContent: " · records in use" } } : { span: {} }] } },
                    { p: { className: "small", textContent: x.why } },
                    x.refused ? { p: { className: "dbx-refused small", textContent: `Not built: ${x.refused}` } } : { pre: { className: "dbx-pre", textContent: x.sql } },
                    x.estimate?.available && x.estimate.statements?.length ? { ul: { className: "small dbx-estimate", children: x.estimate.statements.map((e) => ({ li: { key: e.key, textContent: `Statement ${e.key}: plan cost ${e.before ?? "?"} now, ${e.after ?? "?"} with it${e.before && e.after ? ` (${Math.round((1 - e.after / e.before) * 100)}% less)` : ""}` } })) } } : { span: {} },
                    x.statements?.length ? { p: { className: "muted small", textContent: `For ${x.statements.length} statement(s): ${x.statements.join(", ")}` } } : { span: {} },
                    x.refused ? { span: {} } : { div: { children: [{ button: { type: "button", className: "btn primary", onclick: () => build(x), textContent: "Build it" } }] } },
                ] } })),
                p && !p.proposals?.length ? { p: { className: "muted", textContent: "No index proposed." } } : { span: {} },
            ] } };
        };

        const indexesPanel = () => {
            const o = api.getState(`${A}.o`, null);
            if (!o) return { span: {} };
            const drop = async (x) => {
                const why = await askDialog(api, { title: `Drop ${x.name}`, message: "Dropped at once, without stopping writes to the table. Kept in the audit trail: why.", label: "Why", required: true, multiline: true, confirm: "Drop", danger: true });
                if (why === null) return;
                api.call("database.dropIndex", { name: x.name, why }).then(() => { said(true, `${x.name} is dropped.`); load(); }, (e) => said(false, e.message));
            };
            const effect = (x) => {
                api.setValue(`${A}.open`, { kind: "effect", x, detail: null });
                api.call("database.effect", { name: x.name }).then((d) => api.setValue(`${A}.open.detail`, d), (e) => api.setValue(`${A}.open.detail`, { error: e.message }));
            };
            const stateOf = (x) => (x.built ? `${x.built.state}${x.built.by ? ` · ${x.built.by}` : ""}` : x.primary ? "primary key" : x.unique ? "unique" : "platform");
            return { section: { className: "panel", "aria-label": "Indexes", children: [
                { h3: { className: "icon-text", children: [icon("steps"), { span: "Indexes" }] } },
                { p: { className: "muted small", textContent: "Every index of the platform's tables: its size, and how often the database used it since its statistics were last reset. One never used costs every write to its table and serves nothing. Only those built here are dropped here; the platform's own are kept by its migrations." } },
                table("indexes", [["name", "Index"], ["table", "Table"], ["bytes", "Size"], ["scans", "Used"], ["state", "Made"], [null, ""]], o.indexes ?? [],
                    (x, k) => (k === "state" ? stateOf(x) : x[k]),
                    (x) => ({ tr: { key: x.name, children: [
                        { td: { className: "dbx-sql", title: x.definition, children: [{ strong: x.name }, { div: { className: "muted small", children: [{ code: (x.definition ?? "").replace(/^CREATE (UNIQUE )?INDEX \S+ /, "").slice(0, 140) }] } }] } },
                        { td: { textContent: x.table ?? "—" } }, { td: { className: "num", textContent: bytes(x.bytes) } },
                        { td: { className: `num${x.scans === 0 && !x.primary ? " dbx-unused" : ""}`, textContent: count(x.scans) } },
                        { td: { className: "small", title: x.built?.why ?? "", textContent: x.valid === false && !x.built ? "invalid" : stateOf(x) } },
                        { td: { className: "dbx-actions", children: x.built && x.built.state !== "dropped" ? [
                            x.built.state === "ready" ? { button: { type: "button", className: "btn ghost small", onclick: () => effect(x), textContent: "Effect" } } : { span: {} },
                            { button: { type: "button", className: "btn ghost field-remove", title: `Drop ${x.name}`, "aria-label": `Drop ${x.name}`, onclick: () => drop(x), children: [icon("trash")] } },
                        ] : [] } },
                    ] } }), "dbx-indexes"),
            ] } };
        };

        const tablesPanel = () => {
            const o = api.getState(`${A}.o`, null);
            if (!o) return { span: {} };
            return { section: { className: "panel", "aria-label": "Tables", children: [
                { h3: { className: "icon-text", children: [icon("layout"), { span: "Tables" }] } },
                { p: { className: "muted small", textContent: "The platform's tables: rows, size with their indexes, and how the database read them: whole (a scan of every row) or through an index." } },
                table("tables", [["name", "Table"], ["rows", "Rows"], ["bytes", "Size"], ["seqScans", "Read whole"], ["indexScans", "By an index"], ["dead", "Dead rows"]], o.tables ?? [], (t, k) => t[k],
                    (t) => ({ tr: { key: t.name, children: [{ td: { textContent: t.name } }, { td: { className: "num", textContent: count(t.rows) } }, { td: { className: "num", textContent: bytes(t.bytes) } },
                        { td: { className: "num", textContent: count(t.seqScans) } }, { td: { className: "num", textContent: count(t.indexScans) } }, { td: { className: "num", textContent: count(t.dead) } }] } }), "dbx-tables"),
            ] } };
        };

        const pgssPanel = () => {
            const o = api.getState(`${A}.o`, null);
            if (!o) return { span: {} };
            return { section: { className: "panel", "aria-label": "The database's own statistics", children: [
                { h3: { className: "icon-text", children: [icon("chart"), { span: "The database's own statistics" }] } },
                o.pgss ? { p: { className: "muted small", textContent: "pg_stat_statements: every statement the database ran, from any client (the platform, a report tool, a person at psql), since its statistics were last reset." } }
                    : { p: { className: "muted small", textContent: "pg_stat_statements is not installed in this database: the statements above are the platform's own count. To add the database's, IT names it in shared_preload_libraries, restarts PostgreSQL, and runs CREATE EXTENSION pg_stat_statements (app/mes/README.md)." } },
                o.pgss ? table("pgss", [["text", "Statement"], ["calls", "Calls"], ["meanMs", "Mean"], ["totalMs", "In all"], ["rows", "Rows"], ["read", "Blocks read"]], o.pgss, (s, k) => s[k],
                    (s) => ({ tr: { key: s.id, children: [{ td: { className: "dbx-sql", title: s.text, children: [{ code: s.text.slice(0, 160) }] } }, { td: { className: "num", textContent: count(s.calls) } }, { td: { className: "num", textContent: ms(s.meanMs) } },
                        { td: { className: "num", textContent: ms(s.totalMs) } }, { td: { className: "num", textContent: count(s.rows) } }, { td: { className: "num", textContent: count(s.read) } }] } }), "dbx-pgss") : { span: {} },
            ] } };
        };

        // A statement opened, or an index's effect, in a panel over the page.
        const opened = () => {
            const x = api.getState(`${A}.open`, null);
            if (!x) return { span: {} };
            const close = () => api.setValue(`${A}.open`, null);
            const d = x.detail;
            if (x.kind === "call") {
                const c = x.c;
                // The last 48 hours, all ways in together: a bar an hour (an hour without calls, none), as high as its
                // calls, the part refused or failed in the warning tone.
                const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
                const hours = Array.from({ length: 48 }, (_, i) => ({ hour: new Date(now - (47 - i) * 3_600_000).toISOString(), calls: 0, ms: 0, bad: 0 }));
                for (const r of d?.series ?? []) { const h = hours.find((y) => Date.parse(y.hour) === Date.parse(r.hour)); if (h) { h.calls += r.calls; h.ms += r.meanMs * r.calls; h.bad += r.refused + r.failed; } }
                const top = Math.max(1, ...hours.map((h) => h.calls));
                const list = (items, words) => (items?.length ? { ul: { className: "small dbx-list-plain", children: items.map((i) => ({ li: { key: i.key, textContent: `${words(i.key)}: ${count(i.n)}` } })) } } : { p: { className: "muted small", textContent: "None." } });
                return editorPanel(api, { id: "dbx-call", title: c.name, subtitle: [{ span: `${KIND_WORDS[c.kind] ?? c.kind} · ${count(c.calls)} calls · mean ${ms(c.meanMs)} · 95% within ${upTo(c.p95)} · slowest ${ms(c.maxMs)} · ${count(c.refused)} refused · ${count(c.failed)} failed` }], close, children: !d ? [{ p: { className: "muted small", textContent: "Counting…" } }] : d.error ? [{ p: { className: "dbx-refused small", textContent: d.error } }] : [
                    { strong: { className: "small", textContent: "By way in" } },
                    { table: { className: "grid", children: [
                        { thead: { children: [{ tr: { children: [{ th: "From" }, { th: "Calls" }, { th: "Mean" }, { th: "95% within" }, { th: "Slowest" }, { th: "Refused" }, { th: "Failed" }] } }] } },
                        { tbody: { children: (d.channels ?? []).map((r) => ({ tr: { key: r.channel, children: [{ td: { textContent: CHANNEL_WORDS[r.channel] ?? r.channel } }, { td: { className: "num", textContent: count(r.calls) } }, { td: { className: "num", textContent: ms(r.meanMs) } }, { td: { className: "num", textContent: upTo(r.p95) } }, { td: { className: "num", textContent: ms(r.maxMs) } }, { td: { className: "num", textContent: count(r.refused) } }, { td: { className: "num", textContent: count(r.failed) } }] } })) } },
                    ] } },
                    { strong: { className: "small", textContent: "The last 48 hours, an hour a bar" } },
                    hours.some((h) => h.calls) ? { div: { className: "dbx-bars", role: "img", "aria-label": `Calls per hour over the last 48 hours, at most ${count(top)} in an hour`, children: hours.map((h) => ({ span: { key: h.hour, className: "dbx-bar", style: { height: h.calls ? `${Math.max(4, Math.round((h.calls / top) * 100))}%` : "0" },
                        title: h.calls ? `${plant().dateTime?.(h.hour) ?? h.hour}: ${count(h.calls)} calls, mean ${ms(h.ms / h.calls)}${h.bad ? `, ${count(h.bad)} refused or failed` : ""}` : "",
                        children: [{ span: { className: "dbx-bar-bad", style: { height: h.calls ? `${Math.round((h.bad / h.calls) * 100)}%` : "0" } } }] } })) } } : { p: { className: "muted small", textContent: "Nothing in the last 48 hours." } },
                    { strong: { className: "small", textContent: "Who called" } },
                    list(d.callers, (k) => k),
                    { strong: { className: "small", textContent: "Why it was refused" } },
                    list(d.codes, (k) => k),
                    { strong: { className: "small", textContent: "The statements it sent" } },
                    d.statements?.length ? { table: { className: "grid", children: [
                        { thead: { children: [{ tr: { children: [{ th: "Statement" }, { th: "Sent" }, { th: "Mean" }, { th: "About" }] } }] } },
                        { tbody: { children: d.statements.map((st) => ({ tr: { key: st.key, className: "row", onclick: () => openStatement({ key: st.key, text: st.text, calls: st.calls, meanMs: st.meanMs, maxMs: null, errors: null, replica: null, sources: { [d.source]: st.calls } }), children: [
                            { td: { className: "dbx-sql", title: st.text, children: [{ code: st.text.slice(0, 120) }] } }, { td: { className: "num", textContent: count(st.calls) } }, { td: { className: "num", textContent: ms(st.meanMs) } }, { td: { className: "num", textContent: ms(st.totalMs) } },
                        ] } })) } },
                    ] } } : { p: { className: "muted small", textContent: "None counted for it in this time." } },
                ] });
            }
            if (x.kind === "statement") {
                const s = x.s;
                return editorPanel(api, { id: "dbx-statement", title: `Statement ${s.key}`, subtitle: [{ span: `${count(s.calls)} calls · mean ${ms(s.meanMs)} · slowest ${ms(s.maxMs)} · ${count(s.errors)} failed · ${count(s.replica)} from the replica` }], close, children: [
                    { pre: { className: "dbx-pre", textContent: d?.sample ?? s.text } },
                    { div: { className: "small", children: [{ strong: "Sent by: " }, { span: Object.entries(s.sources ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${count(v)})`).join(", ") || "—" }] } },
                    d?.hours?.length ? { div: { className: "small muted", textContent: `Last 48 hours, mean per hour: ${d.hours.map((h) => `${plant().time?.(h.hour) ?? h.hour.slice(11, 16)} ${ms(h.meanMs)}`).slice(-12).join(" · ")}` } } : { span: {} },
                    { strong: { className: "small", textContent: "Its plan, for any values (nothing run)" } },
                    !d ? { p: { className: "muted small", textContent: "Planning…" } } : d.plan?.error ? { p: { className: "dbx-refused small", textContent: d.plan.error } } : { pre: { className: "dbx-pre", textContent: d.plan?.text ?? "" } },
                ] });
            }
            return editorPanel(api, { id: "dbx-effect", title: `What ${x.x.name} did`, subtitle: [{ span: x.x.built?.why ?? "" }], close, children: [
                !d ? { p: { className: "muted small", textContent: "Counting…" } } : d.error ? { p: { className: "dbx-refused small", textContent: d.error } }
                    : d.statements?.length ? { table: { className: "grid", children: [
                        { thead: { children: [{ tr: { children: [{ th: "Statement" }, { th: "Mean before" }, { th: "Calls before" }, { th: "Mean since" }, { th: "Calls since" }] } }] } },
                        { tbody: { children: d.statements.map((e) => ({ tr: { key: e.key, children: [{ td: { children: [{ code: e.key }] } }, { td: { className: "num", textContent: ms(e.before) } }, { td: { className: "num", textContent: count(e.beforeCalls) } }, { td: { className: "num", textContent: ms(e.after) } }, { td: { className: "num", textContent: count(e.afterCalls) } }] } })) } },
                    ] } } : { p: { className: "muted small", textContent: "No statements were named for it, or none ran in the hours before and since." } },
            ] });
        };

        return { div: { className: "view dbx", children: [
            { div: { className: "view-head", children: [{ h1: "Database" }, { p: { className: "muted view-about", textContent: "What people and systems ask of the platform, what the platform asks of the database, how long each takes, and its indexes. For database administrators: an index is built or dropped here at once, with why, in the audit trail." } }] } },
            { div: { className: "list-bar", children: [
                { label: { className: "small", children: [{ span: "Counted over " }, { select: { "aria-label": "Over the last", onchange: (e) => { api.setValue(`${A}.hours`, Number(e.target.value)); load(); }, children: noDefault([[1, "the last hour"], [24, "the last day"], [168, "the last week"], [336, "two weeks"]].map(([h, l]) => ({ option: { value: String(h), selected: (api.peek(`${A}.hours`) ?? 24) === h, textContent: l } }))) } }] } },
                { span: { className: "spacer" } },
                () => { const o = api.getState(`${A}.o`, null); return o ? { span: { className: "muted small", textContent: `PostgreSQL ${o.version} · pg_stat_statements ${o.installed.pgStatStatements ? "on" : "off"} · HypoPG ${o.installed.hypopg ? "on" : "off"} · AI ${o.installed.ai ? "on" : "off"}` } } : { span: {} }; },
                { button: { type: "button", className: "btn ghost", disabled: () => api.getState(`${A}.loading`, false), onclick: load, children: [withIcon("refresh", "Refresh")] } },
            ] } },
            () => { const s = api.getState(`${A}.said`, null); return s ? { p: { className: `org-import-note small${s.ok ? "" : " bad"}`, role: "status", children: [{ span: s.words }, { button: { type: "button", className: "linkish", textContent: "dismiss", onclick: () => api.setValue(`${A}.said`, null) } }] } } : { span: {} }; },
            () => { const e = api.getState(`${A}.error`, null); return e ? { p: { className: "dbx-refused", role: "alert", textContent: e } } : { span: {} }; },
            () => (api.getState(`${A}.o`, null) ? { span: {} } : api.getState(`${A}.error`, null) ? { span: {} } : { p: { className: "muted", textContent: "Reading the database…" } }),
            callsPanel, statementsPanel, proposalsPanel, indexesPanel, tablesPanel, pgssPanel, opened,
        ] } };
    });
}
