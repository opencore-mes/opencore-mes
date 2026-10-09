// Data retention (DESIGN.md §27.8): for whoever People & departments makes a privacy officer. How long
// each kind of data is kept (the plant's periods, set in People & departments → Retention), what is past
// them now ("what would go" at the next purge, or past its period and kept, for records and the audit
// trail), the purge's last runs (counts, never contents), the purge run now; and a person's personal data
// erased from a record, field by field as its object's design marks them, each erasure audited.
import { icon } from "./icons.js";
import { plant } from "./format.js";
import { titleTab } from "./shell.js";
import { confirmDialog, askDialog } from "./dialog.js";
import { KIND } from "./retention.js";

const R = "retention";
const counted = (k) => (k.days === null ? "—" : `${k.capped ? "more than " : ""}${plant().number(k.count)}`);
const summary = (counts) => Object.entries(counts ?? {}).map(([k, n]) => `${KIND[k]?.label ?? k} ${plant().number(n)}`).join(", ") || "nothing past its period";

export function registerRetentionPage(juris) {
    juris.registerComponent("RetentionPage", (props, api) => {
        const load = () => api.call("retention.report").then((r) => api.setValue(`${R}.report`, r), (e) => api.setValue(`${R}.error`, e.message));
        const objects = () => api.call("retention.find", {}).then((r) => api.setValue(`${R}.objects`, r.objects), () => {});
        const find = (q) => {
            const object = api.peek(`${R}.object`);
            if (!object) return;
            api.call("retention.find", { object, q }).then((r) => api.setValue(`${R}.rows`, r.rows), (e) => api.setValue(`${R}.said`, { ok: false, words: e.message }));
        };
        let timer = null;
        if (!api.isServer) api.onMount(() => { titleTab(api, "/design/retention", "Data retention"); load(); objects(); });
        api.onCleanup(() => clearTimeout(timer));
        const typed = (text) => { api.setValue(`${R}.q`, text); clearTimeout(timer); timer = setTimeout(() => find(text), 250); };
        const said = (ok, words) => api.setValue(`${R}.said`, { ok, words });
        const runNow = async () => {
            if (!(await confirmDialog(api, { title: "Run the purge now?", message: "What is past its period is removed now, as the schedule would: counted in the audit trail and the event log, by you. It cannot be undone.", confirm: "Run it", danger: true }))) return;
            api.call("retention.run").then((r) => { said(!r.error, `Removed: ${summary(r.counts)}${r.more ? "; more at the next run" : ""}.${r.error ? ` ${r.error}` : ""}`); load(); }, (e) => said(false, e.message));
        };
        const erase = async (row) => {
            const object = api.peek(`${R}.object`);
            const o = (api.peek(`${R}.objects`) ?? []).find((x) => x.object === object);
            const names = (o?.fields ?? []).filter((f) => row.holding.includes(f.name)).map((f) => f.label).join(", ");
            const reason = await askDialog(api, { title: `Erase ${row.title}'s personal data?`, message: `${names} on this ${o?.label?.toLowerCase() ?? "record"} are replaced by "[erased]" (or emptied). The record, its state and its history stay; the audit trail says that they were erased, by you and why, never what they held. It cannot be undone.`, label: "Why (the request it answers, its reference)", required: true, multiline: true, confirm: "Erase", danger: true });
            if (!reason) return;
            api.call("records.erase", { object, id: row.id, reason }).then((r) => { said(true, r.erased.length ? `Erased from ${row.title}: ${r.erased.join(", ")}.` : "Nothing was left to erase."); find(api.peek(`${R}.q`) ?? ""); }, (e) => said(false, e.message));
        };
        return { div: { className: "view retention", children: [
            { div: { className: "view-head", children: [{ h1: "Data retention" }, { span: { className: "muted", textContent: "How long each kind of data is kept, what is past it, and a person's data erased. Everything done here is in the audit trail, by you." } }] } },
            () => {
                const s = api.getState(`${R}.said`, null);
                return s ? { p: { className: `login-note${s.ok ? "" : " refused"}`, role: s.ok ? "status" : "alert", children: [icon(s.ok ? "check" : "warning"), { span: s.words }] } } : { span: {} };
            },
            () => {
                const error = api.getState(`${R}.error`, null);
                const r = api.getState(`${R}.report`, null);
                if (error) return { p: { className: "error", textContent: error } };
                if (!r) return { p: { className: "muted", textContent: "Reading…" } };
                return { section: { className: "panel retention-periods", children: [
                    { div: { className: "retention-head", children: [
                        { h3: "Periods" },
                        { span: { className: "muted small", textContent: `People & departments, version ${r.version ?? "—"}. Changed there (Retention), through a change request approved by governance.` } },
                        { span: { className: "spacer" } },
                        { button: { type: "button", className: "btn", textContent: "Run the purge now", onclick: runNow } },
                    ] } },
                    { div: { className: "retention-scroll", children: [{ table: { className: "grid retention-table", children: [
                        { thead: { children: [{ tr: { children: [{ th: "Kind" }, { th: "Kept for" }, { th: "Past it now" }] } }] } },
                        { tbody: { children: r.kinds.map((k) => ({ tr: { key: k.key, children: [
                            { td: { children: [{ strong: k.label }, { div: { className: "muted small", textContent: k.what } }] } },
                            { td: { children: [{ span: k.words }, { div: { className: "muted small", textContent: k.set ? "set by the plant" : "the default" } }] } },
                            { td: { children: [{ span: counted(k) }, { div: { className: "muted small", textContent: k.days === null ? "kept forever" : k.purged ? `would go at the next run (before ${plant().date(k.cutoff.slice(0, 10))})` : "past its period: kept, never removed by the platform" } }] } },
                        ] } })) } },
                    ] } }] } },
                    { h3: "Last runs" },
                    r.runs.length
                        ? { ul: { className: "retention-runs", children: r.runs.map((x) => ({ li: { key: x.id, children: [
                            { strong: plant().dateTime(x.at) },
                            { span: ` · ${x.by === "platform:retention" ? "the schedule" : x.by} · ${summary(x.counts)}${x.more ? "; more at the next run" : ""}${x.error ? ` · ${x.error}` : ""}` },
                        ] } })) } }
                        : { p: { className: "muted small", textContent: `None yet: the instance that schedules runs it every ${Math.round(r.every / 3_600_000)} hours.` } },
                ] } };
            },
            { section: { className: "panel retention-erase", children: [
                { h3: "Erase a person's data from a record" },
                { p: { className: "muted small", textContent: "Only the fields an object's design marks as personal data (erasable) are erased; the record and its history stay. For a request to erase someone's data (GDPR art. 17): find each record that holds it, and erase it with the request's reference." } },
                () => {
                    const list = api.getState(`${R}.objects`, null);
                    if (!list) return { p: { className: "muted", textContent: "Reading…" } };
                    if (!list.length) return { p: { className: "muted", textContent: "No object marks a field as personal data to erase yet: a designer marks it on the object's field (erasable), through a change." } };
                    return { div: { className: "retention-find", children: [
                        { select: { "aria-label": "The object", onchange: (e) => { api.setValue(`${R}.object`, e.target.value || null); api.setValue(`${R}.rows`, null); find(api.peek(`${R}.q`) ?? ""); }, children: [{ option: { value: "", textContent: "Choose the object…" } }, ...list.map((o) => ({ option: { key: o.object, value: o.object, selected: api.peek(`${R}.object`) === o.object, textContent: `${o.label} (${o.fields.map((f) => f.label).join(", ")})` } }))] } },
                        { input: { type: "search", placeholder: "Its title, a value of a personal field, or its id", "aria-label": "Find the record", value: () => api.getState(`${R}.q`, "") ?? "", oninput: (e) => typed(e.target.value) } },
                    ] } };
                },
                () => {
                    const rows = api.getState(`${R}.rows`, null);
                    if (!api.getState(`${R}.object`, null) || !rows) return { span: {} };
                    if (!rows.length) return { p: { className: "muted", textContent: (api.getState(`${R}.q`, "") ?? "").trim() ? "Nothing matches." : "Type what to find." } };
                    return { ul: { className: "retention-rows", children: rows.map((row) => ({ li: { key: row.id, children: [
                        { div: { children: [{ strong: row.title }, { div: { className: "muted small", textContent: `${row.id}${row.archived ? " · archived" : ""} · ${row.holding.length ? `holds ${row.holding.join(", ")}` : "nothing left to erase"}` } }] } },
                        row.holding.length ? { button: { type: "button", className: "btn small", textContent: "Erase", onclick: () => erase(row) } } : { span: {} },
                    ] } })) } };
                },
            ] } },
        ] } };
    });
}
