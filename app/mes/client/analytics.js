// Analytics, phase 1 (DESIGN.md §22): a record's timeline through its states, and an object's
// analytics page: records in each state now, time spent in each state, lead time between two states,
// and entries into a state per day, week or month. Charts are drawn by the chart view (§34.9).
import { titleTab } from "./shell.js";
import { noDefault } from "./select.js";
import { plant } from "./format.js";

// "3 d 4 h", "2 h 05 min", "45 min", "12 s".
export function formatDuration(secs) {
    if (secs === null || secs === undefined || !Number.isFinite(secs)) return "—";
    const s = Math.max(0, Math.round(secs));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${d} d ${h} h`;
    if (h) return `${h} h ${String(m).padStart(2, "0")} min`;
    if (m) return `${m} min`;
    return `${s} s`;
}

const words = (id) => String(id ?? "").replace(/_/g, " ");
const when = (iso) => (iso ? plant().dateTime(iso) : "—");
const PALETTE = ["#4f6bed", "#e8a33d", "#3aa37a", "#b5566e", "#7b6bd6", "#3a9bb5", "#8a8f98"];
const colorOf = (states, state) => PALETTE[Math.max(0, states.indexOf(state)) % PALETTE.length];

// A chart (§34.9), drawn by the chart view: its spec and rows as a query would answer them.
const chartOf = (key, spec, columns, rows, title, height) => ({ ChartView: { key: `${key}-${rows.length}-${rows.map((r) => r.join(":")).join("|").length}`, spec, data: { columns, rows }, title, height } });
const across = (n) => Math.max(120, 40 + n * 28); // horizontal bars: a row each

const table = (heads, rows, empty) => (rows.length
    ? { table: { className: "grid", children: [{ thead: { children: [{ tr: { children: heads.map((h) => ({ th: h })) } }] } }, { tbody: { children: rows } }] } }
    : { p: { className: "muted small", textContent: empty } });

export function registerAnalytics(juris, { args }) {
    // ---- one record's stays in its states ----
    juris.registerComponent("RecordTimeline", ({ object, id }, api) => {
        const [stays, setStays] = api.useState("stays", null);
        const [error, setError] = api.useState("error", null);
        if (!api.isServer) api.onMount(() => { api.call("analytics.timeline", { object, id }).then(setStays, (e) => setError(e.message)); });
        return {
            div: {
                className: "timeline",
                children: () => {
                    if (error()) return [{ p: { className: "error", textContent: error() } }];
                    const list = stays();
                    if (list === null) return [{ p: { className: "muted", textContent: "Loading…" } }];
                    if (!list.length) return [{ p: { className: "muted", textContent: "No stays recorded yet." } }];
                    const states = [...new Set(list.map((s) => s.state))];
                    const total = list.reduce((n, s) => n + s.secs, 0) || 1;
                    let x = 0;
                    return [
                        {
                            svg: {
                                className: "chart strip", viewBox: "0 0 600 28", width: "100%", preserveAspectRatio: "none", role: "img",
                                children: list.map((s, k) => {
                                    const w = (s.secs / total) * 600;
                                    const rect = { rect: { key: k, x, y: 0, width: Math.max(1, w), height: 28, fill: colorOf(states, s.state) }, };
                                    x += w;
                                    return rect;
                                }),
                            },
                        },
                        table(["State", "Entered", "By", "Left", "By", "Time in state"], list.map((s, k) => ({ tr: { key: k, children: [
                            { td: { children: [{ span: { className: "swatch", children: [{ svg: { viewBox: "0 0 10 10", width: 10, height: 10, children: [{ rect: { x: 0, y: 0, width: 10, height: 10, rx: 2, fill: colorOf(states, s.state) } }] } }] } }, { span: ` ${words(s.state)}` }] } },
                            { td: `${when(s.entered_at)} (${s.enter_action})` },
                            { td: s.entered_by },
                            { td: s.open ? "still in it" : `${when(s.left_at)} (${s.leave_action})` },
                            { td: s.left_by ?? "" },
                            { td: `${formatDuration(s.secs)}${s.open ? " so far" : ""}` },
                        ] } })), ""),
                    ];
                },
            },
        };
    });

    // ---- an object's analytics ----
    juris.registerComponent("ObjectAnalytics", ({ object }, api) => {
        const as = api.getState("me.id", null, { track: false });
        const defPath = `d.${object}.def`;
        api.live(defPath, "defs.get", args.def(object, as));
        const [days, setDays] = api.useState("days", 30);
        const [by, setBy] = api.useState("by", "");
        const [lead, setLead] = api.useState("lead", null);       // { fromState, toState }
        const [into, setInto] = api.useState("into", null);
        const [bucket, setBucket] = api.useState("bucket", "day");
        const [data, setData] = api.useState("data", null);
        const [error, setError] = api.useState("error", null);
        const [dims, setDims] = api.useState("dims", []);

        const load = async () => {
            const def = api.peek(defPath);
            if (!def) return;
            const states = def.states.list;
            const to = new Date();
            const from = new Date(to.getTime() - days() * 86_400_000);
            const period = { from: from.toISOString(), to: to.toISOString(), ...(by() ? { by: by() } : {}) };
            setError(null);
            try {
                const states_ = await api.call("analytics.states", { object, ...period });
                // Until the viewer picks, the furthest state that has anything in the period (so the
                // first view is not empty because nothing is consumed yet).
                const seen = new Set([...states_.stays, ...states_.now].map((r) => r.state));
                const furthest = [...states].reverse().find((s) => s !== def.states.initial && seen.has(s)) ?? states.find((s) => s !== def.states.initial) ?? states.at(-1);
                const pair = lead() ?? { fromState: def.states.initial, toState: furthest };
                const target = into() ?? furthest;
                const [leadTime, entries] = await Promise.all([
                    pair.fromState && pair.toState && pair.fromState !== pair.toState ? api.call("analytics.leadTime", { object, ...pair, ...period }) : null,
                    api.call("analytics.entries", { object, state: target, bucket: bucket(), from: period.from, to: period.to }),
                ]);
                setData({ states: states_, leadTime, entries, pair, target });
            } catch (e) {
                setError(e.message);
            }
        };
        if (!api.isServer) {
            api.onMount(() => {
                const stop = api.bindState(() => api.getState(`${defPath}.version`), (v) => {
                    if (v === undefined) return;
                    const def = api.peek(defPath);
                    titleTab(api, `/o/${object}/analytics`, `${def.label} · analytics`);
                    setDims(def.analytics?.dimensions ?? []);
                    load();
                });
                return stop;
            });
        }
        const select = (value, options, onchange) => ({ select: { onchange, children: noDefault(options.map(([v, l]) => ({ option: { value: v, selected: String(value) === String(v), textContent: l } }))) } });

        return {
            div: {
                className: "view analytics",
                children: [
                    {
                        div: {
                            className: "view-head",
                            children: [
                                { h1: () => `${api.getState(`${defPath}.label`, object)} · analytics` },
                                { Link: { to: `/o/${object}`, className: "btn ghost", textContent: "Back to the list" } },
                                { span: { className: "spacer" } },
                                { label: { className: "muted small", children: [{ span: "Period " }, select(days(), [[7, "last 7 days"], [30, "last 30 days"], [90, "last 90 days"], [365, "last year"]], (e) => { setDays(Number(e.target.value)); load(); })] } },
                                () => (dims().length ? { label: { className: "muted small", children: [{ span: " By " }, select(by(), [["", "—"], ...dims().map((d) => [d, d])], (e) => { setBy(e.target.value); load(); })] } } : { span: {} }),
                                { button: { type: "button", className: "btn", textContent: "Refresh", onclick: load } },
                            ],
                        },
                    },
                    { p: { className: "error", textContent: () => error() ?? "" } },
                    () => {
                        const d = data();
                        const def = api.getState(defPath);
                        if (!d || !def) return { p: { className: "muted", textContent: "Loading…" } };
                        const states = def.states.list;
                        const grouped = Boolean(d.states.by);
                        const valueCol = grouped ? [d.states.by] : [];
                        const stateOptions = states.map((s) => [s, words(s)]);
                        return {
                            div: {
                                children: [
                                    { h2: "Now" },
                                    { p: { className: "muted small", textContent: "Records in each state right now, and how long they have been there. Archived records are not counted." } },
                                    grouped
                                        ? table(["State", ...valueCol, "Records", "Average age", "Oldest"], d.states.now.map((r, k) => ({ tr: { key: k, children: [{ td: words(r.state) }, { td: r.value ?? "—" }, { td: String(r.count) }, { td: formatDuration(r.avgAge) }, { td: formatDuration(r.oldest) }] } })), "No records.")
                                        : chartOf("an-now", { chart: "bar", x: "state", y: ["records"], horizontal: true, labels: true }, ["state", "records"], states.map((s) => [words(s), d.states.now.find((x) => x.state === s)?.count ?? 0]), "Records in each state now", across(states.length)),

                                    { h2: "Time in each state" },
                                    { p: { className: "muted small", textContent: "Stays that ended in the period: how long records spent in each state." } },
                                    table(["State", ...valueCol, "Stays", "Average", "Median", "90th percentile", "Longest"], [...d.states.stays]
                                        .sort((a, b) => states.indexOf(a.state) - states.indexOf(b.state))
                                        .map((r, k) => ({ tr: { key: k, children: [{ td: words(r.state) }, ...(grouped ? [{ td: r.value ?? "—" }] : []), { td: String(r.count) }, { td: formatDuration(r.avg) }, { td: formatDuration(r.p50) }, { td: formatDuration(r.p90) }, { td: formatDuration(r.max) }] } })), "No stay ended in the period."),

                                    { h2: "Lead time" },
                                    {
                                        div: {
                                            className: "controls",
                                            children: [
                                                { span: "From first entering " },
                                                select(d.pair.fromState, stateOptions, (e) => { setLead({ ...d.pair, fromState: e.target.value }); load(); }),
                                                { span: " to first reaching " },
                                                select(d.pair.toState, stateOptions, (e) => { setLead({ ...d.pair, toState: e.target.value }); load(); }),
                                            ],
                                        },
                                    },
                                    !d.leadTime ? { p: { className: "muted small", textContent: "Pick two different states." } } : {
                                        div: {
                                            children: [
                                                table(["", "Records", "Average", "Median", "90th percentile", "Shortest", "Longest"], [
                                                    { tr: { key: "all", children: [{ td: { children: [{ strong: "All" }] } }, { td: String(d.leadTime.all.count) }, { td: formatDuration(d.leadTime.all.avg) }, { td: formatDuration(d.leadTime.all.p50) }, { td: formatDuration(d.leadTime.all.p90) }, { td: formatDuration(d.leadTime.all.min) }, { td: formatDuration(d.leadTime.all.max) }] } },
                                                    ...d.leadTime.groups.map((g, k) => ({ tr: { key: k, children: [{ td: `${d.leadTime.by}: ${g.value ?? "—"}` }, { td: String(g.count) }, { td: formatDuration(g.avg) }, { td: formatDuration(g.p50) }, { td: formatDuration(g.p90) }, { td: formatDuration(g.min) }, { td: formatDuration(g.max) }] } })),
                                                ], ""),
                                                d.leadTime.groups.length ? chartOf("an-lead", { chart: "bar", x: "group", y: ["median_hours"], horizontal: true, labels: true, unit: "h" }, ["group", "median_hours"], d.leadTime.groups.map((g) => [String(g.value ?? "—"), g.p50 === null || g.p50 === undefined ? null : Math.round((g.p50 / 3600) * 10) / 10]), "Median lead time", across(d.leadTime.groups.length)) : { span: {} },
                                                d.leadTime.slowest.length ? { h4: "Slowest" } : { span: {} },
                                                d.leadTime.slowest.length ? { ul: { children: d.leadTime.slowest.map((r) => ({ li: { key: r.id, children: [{ Link: { to: `/o/${object}/${r.id}`, textContent: r.title ?? r.id.slice(0, 8) } }, { span: ` · ${formatDuration(r.secs)} · reached ${words(d.pair.toState)} ${when(r.reachedAt)}` }] } })) } } : { span: {} },
                                                d.leadTime.all.count ? { span: {} } : { p: { className: "muted small", textContent: `No record reached ${words(d.pair.toState)} after ${words(d.pair.fromState)} in the period.` } },
                                            ],
                                        },
                                    },

                                    { h2: "Entries" },
                                    {
                                        div: {
                                            className: "controls",
                                            children: [
                                                { span: "Records entering " },
                                                select(d.target, stateOptions, (e) => { setInto(e.target.value); load(); }),
                                                { span: " per " },
                                                select(bucket(), [["day", "day"], ["week", "week"], ["month", "month"]], (e) => { setBucket(e.target.value); load(); }),
                                                { span: { className: "muted small", textContent: ` (${d.entries.plantTz})` } },
                                            ],
                                        },
                                    },
                                    d.entries.rows.length ? chartOf("an-entries", { chart: "bar", x: "period", y: ["entries"] }, ["period", "entries"], fillBuckets(d.entries).map((b) => [b.label, b.value]), `Entries into ${words(d.target)}`, 220) : { p: { className: "muted small", textContent: `No record entered ${words(d.target)} in the period.` } },
                                ],
                            },
                        };
                    },
                ],
            },
        };
    });
}

// Every bucket of the period, with the empty ones at 0, so a quiet day shows as one.
function fillBuckets({ rows, from, to, bucket }) {
    const counts = new Map(rows.map((r) => [r.bucket, r.count]));
    if (bucket !== "day") return rows.map((r) => ({ label: r.bucket, value: r.count }));
    const out = [];
    for (let t = Date.parse(from.slice(0, 10)); t <= Date.parse(to); t += 86_400_000) {
        const key = new Date(t).toISOString().slice(0, 10);
        out.push({ label: key, value: counts.get(key) ?? 0 });
    }
    return out;
}
