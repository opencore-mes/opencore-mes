// The integration monitor (DESIGN.md §15.3): what the plant's integration is doing now. The nodes and
// what each does; every schedule, with its next run, its last runs and their outcome, and pause,
// resume and run now; the web services outside systems call in; the connections services call out;
// the record triggers and their queue. Read from the server every 10 s while the page is open. Every
// time is shown in the plant's time zone, whatever the viewer's.
import { titleTab } from "./shell.js";
import { plant } from "./format.js";
import { icon } from "./icons.js";

let plantTz;
const when = (iso) => (iso ? plant().dateTime(iso, { seconds: true }) : "—");
const badge = (text, tone) => ({ span: { className: `badge ${tone}`, textContent: text } });
const TONE = { done: "s-executed", called: "s-executed", ok: "s-executed", running: "s-review", pending: "s-review", retry: "s-review", rejected: "s-rejected", failed: "s-rejected", dead: "s-rejected" };
const table = (heads, rows, empty) => (rows.length
    ? { table: { className: "grid", children: [{ thead: { children: [{ tr: { children: heads.map((h) => ({ th: h })) } }] } }, { tbody: { children: rows } }] } }
    : { p: { className: "muted small", textContent: empty } });
const counts = (parts) => parts.filter(([, n]) => n).map(([label, n]) => `${n} ${label}`).join(" · ") || "—";

export function registerIntegrationMonitor(juris) {
    juris.registerComponent("IntegrationMonitor", (props, api) => {
        const [data, setData] = api.useState("data", null);
        const [error, setError] = api.useState("error", null);
        const [busy, setBusy] = api.useState("busy", null);
        const load = () => api.call("integration.monitor").then((d) => { plantTz = d.plantTz; setData(d); setError(null); }, (e) => setError(e.message));
        if (!api.isServer) {
            api.onMount(() => {
                titleTab(api, "/design/integration", "Integration monitor");
                load();
                const every = setInterval(load, 10_000);
                return () => clearInterval(every);
            });
        }
        const act = (name, service) => {
            setBusy(`${name}:${service}`);
            api.call(`integration.schedule.${name}`, { name: service }).then(load, (e) => setError(e.message)).finally(() => setBusy(null));
        };
        return {
            div: {
                className: "view monitor",
                children: [
                    {
                        div: {
                            className: "view-head",
                            children: [
                                { h1: "Integration monitor" },
                                { span: { className: "muted", textContent: () => (data() ? `As of ${when(data().now)}, from node ${data().node}. Times are in the plant's time zone, ${data().plantTz}.` : "") } },
                                { span: { className: "spacer" } },
                                { button: { type: "button", className: "btn", textContent: "Refresh", onclick: load } },
                            ],
                        },
                    },
                    { p: { className: "error", textContent: () => error() ?? "" } },
                    () => {
                        const d = data();
                        if (!d) return { p: { className: "muted", textContent: "Loading…" } };
                        return {
                            div: {
                                children: [
                                    d.warnings.length ? { div: { className: "db-banner down", role: "alert", children: d.warnings.map((w, i) => ({ div: { key: i, className: "icon-text", children: [icon("warning"), { span: w }] } })) } } : { span: {} },

                                    { h2: "Nodes" },
                                    table(["Node", "Tags", "Plans schedules", "Runs the outbox", "Build", "Started", "Last seen"], d.nodes.map((n) => ({ tr: { key: n.name, children: [
                                        { td: { children: [{ strong: n.name }, { span: " " }, badge(n.alive ? "alive" : "gone", n.alive ? "s-executed" : "s-rejected")] } },
                                        { td: n.tags.join(", ") || "—" },
                                        { td: n.scheduler ? "yes" : "no" },
                                        { td: n.outbox ? "yes" : "no" },
                                        { td: n.build ?? "—" },
                                        { td: when(n.started_at) },
                                        { td: when(n.last_seen) },
                                    ] } })), "No node has reported itself yet."),

                                    { h2: "Schedules" },
                                    table(["Service", "When", "Runs on", "Next run", "Last run", "Totals", "Queued", ""], d.schedules.map((s) => ({ tr: { key: s.service, children: [
                                        { td: { children: [{ strong: s.label }, { div: { className: "muted small", textContent: `${s.service} v${s.version}` } }] } },
                                        { td: { children: s.when.map((w, i) => ({ div: { key: i, children: [w.needs ? { span: { className: "error", textContent: w.text } } : { span: w.text },{ div: { className: "muted small", textContent: `missed: ${w.missed} · overlap: ${w.overlap}` } }] } })) } },
                                        { td: { children: [{ span: s.runOn ? `nodes tagged ${s.runOn}` : "any node" }, s.reachable ? { span: {} } : { div: { className: "error small", textContent: "no live node has this tag" } }] } },
                                        { td: s.paused ? { children: [badge("paused", "s-review"), { div: { className: "muted small", textContent: `by ${s.pausedBy} · ${when(s.pausedAt)}` } }] } : when(s.nextRunAt) },
                                        { td: s.lastState ? { children: [badge(s.lastState, TONE[s.lastState] ?? ""), { span: ` ${when(s.lastRunAt)}` }, s.lastError ? { div: { className: "error small", textContent: s.lastError } } : { span: {} }] } : "never" },
                                        { td: counts([["ok", s.totals.ok], ["failed", s.totals.failed], ["missed", s.totals.missed], ["skipped", s.totals.skipped]]) },
                                        { td: counts([["waiting", s.queue.pending], ["running", s.queue.running], ["to retry", s.queue.retry], ["dead", s.queue.dead]]) },
                                        { td: { className: "actions-cell", children: [
                                            { button: { type: "button", className: "btn ghost", disabled: () => busy() !== null, textContent: s.paused ? "Resume" : "Pause", onclick: () => act(s.paused ? "resume" : "pause", s.service) } },
                                            { button: { type: "button", className: "btn ghost", disabled: () => busy() !== null, textContent: "Run now", onclick: () => act("runNow", s.service) } },
                                            { details: { children: [{ summary: `Last ${s.runs.length} runs` }, table(["#", "Due", "State", "Tries", "Done", "Error"], s.runs.map((r) => ({ tr: { key: r.id, children: [
                                                { td: String(r.id) },
                                                { td: `${when(r.scheduledAt)}${r.manual ? " (run now)" : ""}${r.page > 1 ? ` · page ${r.page}` : ""}` },
                                                { td: { children: [badge(r.state, TONE[r.state] ?? "")] } },
                                                { td: String(r.attempts) },
                                                { td: when(r.doneAt) },
                                                { td: r.error ?? "" },
                                            ] } })), "No runs yet.")] } },
                                        ] } },
                                    ] } })), "No published service has a schedule."),

                                    { h2: "Inbound: web services outside systems call" },
                                    table(["Service", "Address", "Callers", "Last 24 h", "Last call"], d.inbound.map((s) => ({ tr: { key: s.service, children: [
                                        { td: { children: [{ strong: s.label }, { div: { className: "muted small", textContent: s.service } }] } },
                                        { td: { children: [{ code: `POST ${s.path}` }] } },
                                        { td: [...(s.callers.users ?? []), ...(s.callers.groups ?? []).map((g) => `group ${g}`)].join(", ") || "nobody yet" },
                                        { td: counts([["ok", s.calls24h.called], ["refused", s.calls24h.rejected], ["failed", s.calls24h.failed]]) },
                                        { td: s.last ? { children: [badge(s.last.outcome, TONE[s.last.outcome] ?? ""), { span: ` ${when(s.last.at)} by ${s.last.by}` }, s.last.error ? { div: { className: "error small", textContent: s.last.error } } : { span: {} }] } : "none in 24 h" },
                                    ] } })), "No published web service."),

                                    { h2: "Outbound: connections services call" },
                                    table(["Connection", "Address", "Used by", "Last 24 h", "Average", "Last request"], d.outbound.map((c) => ({ tr: { key: c.connection, children: [
                                        { td: { children: [{ strong: c.label }, { div: { className: "muted small", textContent: c.connection } }] } },
                                        { td: { children: [{ code: c.baseUrl }, { div: { className: "muted small", textContent: c.allow.join(", ") } }] } },
                                        { td: c.usedBy.join(", ") || "—" },
                                        { td: counts([["ok", c.requests24h.ok], ["failed", c.requests24h.failed], ["unreachable", c.requests24h.unreachable]]) },
                                        { td: c.avgMs === null ? "—" : `${c.avgMs} ms` },
                                        { td: c.last ? `${when(c.last.at)} · ${c.last.method} ${c.last.path} → ${c.last.status ?? "unreachable"} (${c.last.service})` : "none in 24 h" },
                                    ] } })), "No published connection."),

                                    { h2: "Record triggers" },
                                    table(["Service", "On", "Runs on", "Queued", "Last 24 h", "Last done"], d.triggers.map((t) => ({ tr: { key: t.service, children: [
                                        { td: { children: [{ strong: t.label }, { div: { className: "muted small", textContent: t.service } }] } },
                                        { td: t.on.join(", ") },
                                        { td: { children: [{ span: t.runOn ? `nodes tagged ${t.runOn}` : "any node" }, t.reachable ? { span: {} } : { div: { className: "error small", textContent: "no live node has this tag" } }] } },
                                        { td: counts([["waiting", t.queue.pending], ["running", t.queue.running], ["to retry", t.queue.retry], ["dead", t.queue.dead]]) },
                                        { td: counts([["done", t.queue.done], ["refused", t.queue.rejected]]) },
                                        { td: when(t.queue.lastDone) },
                                    ] } })), "No published service reacts to record events."),
                                ],
                            },
                        };
                    },
                ],
            },
        };
    });
}
