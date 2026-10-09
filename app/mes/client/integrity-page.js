// The data integrity review (DESIGN.md §7.7, COMPLIANCE.md G16): for whoever People & departments makes an
// integrity reviewer. What the scan found written around the platform (a record changed, added, removed or put
// back by hand in the database; a design, or people and roles, changed there), who wrote it and from where when
// the tripwire saw it; each finding closed with its non-conformance report, signed: accepted as it is (sealed
// again), or corrected through the platform first. Nothing is restored from here. The baseline, the scans,
// and the periodic review signed for a period.
import { icon } from "./icons.js";
import { plant } from "./format.js";
import { titleTab } from "./shell.js";
import { confirmDialog } from "./dialog.js";
import { signDialog } from "./sign.js";

const I = "integrity";
const PROBLEM = {
    record: { changed: "Changed in the database", unsealed: "Added in the database, or never sealed", replaced: "An earlier version put back", removed: "Removed in the database" },
    design: { changed: "Changed in the database", unsealed: "Published without a change", removed: "Removed in the database" },
    access: { changed: "Changed in the database", unsealed: "Not sealed", removed: "Removed in the database" },
};
const KIND = { record: "Record", design: "Design", access: "People and roles" };
// What a design's or an access table's row is, in words (the tripwire names the table and the row's key).
const TABLE = {
    users: "person", groups: "group", group_members: "group member", department_reps: "approver", assignments: "role given", organization: "organization's settings, version",
    definitions: "object", scripts: "script", services: "service", connections: "connection", transactions: "transaction", screens: "screen", flows: "flow", layouts: "report layout", queries: "named query", elements: "element",
};
const roleRow = (ref) => { const [kind, who, object, role] = String(ref).split(":"); return `${role} on ${object}, to ${kind === "group" ? "the group " : ""}${who}`; };
const whatOf = (f) => {
    if (f.kind === "record") return `${f.objectLabel} ${f.title}`;
    if (f.object === "access") return "people, groups and roles, as a whole";
    if (f.object === "assignments") return `${TABLE.assignments}: ${roleRow(f.ref)}`;
    const [name, version] = String(f.ref).split(":");
    return `${TABLE[f.object] ?? f.object} ${name}${version ? ` (version ${version})` : ""}`;
};
const OP = { INSERT: "a row added", UPDATE: "a row changed", DELETE: "a row deleted" };
const DECISION = { accepted: "Accepted as it is", corrected: "Corrected through the platform" };
const shown = (v) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
const day = (iso) => (iso ? plant().dateTime(iso) : "—");

export function registerIntegrityPage(juris, { args }) {
    juris.registerComponent("IntegrityPage", (props, api) => {
        const as = api.getState("me.id", null, { track: false });
        if (!api.isServer) {
            api.live(`${I}.report`, "integrity.report", args.design(as));
            titleTab(api, "/design/integrity", "Data integrity");
        }
        const said = (ok, words) => api.setValue(`${I}.said`, { ok, words });
        const busy = (on) => api.setValue(`${I}.busy`, on);
        const scan = (full) => {
            busy(true);
            api.call("integrity.scan", { full }).then((r) => said(true, `${r.full ? "Full scan" : "Scan"}: ${plant().number(r.checked)} record(s) checked, ${r.fresh} new finding(s), ${r.open} open.${r.keyChanged ? " Nothing compared: the key changed (below)." : ""}`), (e) => said(false, e.message)).finally(() => busy(false));
        };
        const baseline = async (rekey) => {
            const signature = await signDialog(api, {
                title: rekey ? "Seal everything again with this key?" : "Take the baseline?",
                message: rekey
                    ? "The seals were made with another key. Everything is sealed again as it stands now, so whatever was changed by hand before is no longer found: sign only once you know why the key changed and the scans before it were clean."
                    : "What was never sealed (records, designs, people and roles) is sealed as it stands now; from then on a change made outside the platform is found. Nothing sealed already is touched. Your signature means you have reviewed it as it stands.",
                confirm: "Sign",
                danger: rekey,
            });
            if (signature === null) return;
            busy(true);
            api.call("integrity.baseline", { signature }).then((r) => said(true, `${r.rekey ? "Sealed again" : "Baseline taken"}: ${plant().number(r.records)} record(s) sealed.`), (e) => said(false, e.message)).finally(() => busy(false));
        };
        const close = async (f) => {
            const F = `${I}.form.${f.id}`;
            const report = { what: api.peek(`${F}.what`) ?? "", why: api.peek(`${F}.why`) ?? "", decision: api.peek(`${F}.decision`) ?? "", action: api.peek(`${F}.action`) ?? "" };
            const signature = await signDialog(api, {
                title: "Sign the non-conformance report?",
                message: `${DECISION[report.decision] ?? "Your decision"}. Your signature closes this finding with your report; it is recorded with your name, the time and its meaning.`,
                confirm: "Close (sign)",
            });
            if (signature === null) return;
            api.setValue(`${F}.errors`, null);
            api.call("integrity.close", { id: f.id, report, signature }).then((r) => {
                api.setValue(`${I}.open`, null);
                said(true, `Closed${r.raised ? `; a report raised in ${r.raised.object}` : ""}.`);
            }, (e) => { api.setValue(`${F}.errors`, e.fields ?? null); said(false, e.message); });
        };
        const review = async () => {
            const from = api.peek(`${I}.rv.from`) ?? "";
            const to = api.peek(`${I}.rv.to`) ?? "";
            const note = api.peek(`${I}.rv.note`) ?? "";
            if (!from || !to || !note.trim()) { said(false, "Give the period (from, to) and what was reviewed."); return; }
            const signature = await signDialog(api, { title: "Sign the periodic review?", message: `From ${plant().date(from)} to ${plant().date(to)}. Your signature means you reviewed the data integrity findings of this period.`, confirm: "Sign" });
            if (signature === null) return;
            api.call("integrity.review", { from, to: `${to}T23:59:59.999Z`, note, signature }).then((r) => { api.setValue(`${I}.rv`, {}); said(true, `Review signed: ${r.open} open and ${r.closed} closed in the period.`); }, (e) => said(false, e.message));
        };
        const scanAll = async () => {
            if (await confirmDialog(api, { title: "Scan every record now?", message: "A full scan reads every record and checks its seal, and finds records removed by hand. On a large plant it takes a while; the schedule runs one every week.", confirm: "Scan everything" })) scan(true);
        };

        const field = (F, name, label, hint, errors) => ({ label: { className: "integrity-field", children: [
            { span: label },
            { textarea: { rows: 2, value: () => api.getState(`${F}.${name}`, "") ?? "", oninput: (e) => api.setValue(`${F}.${name}`, e.target.value), placeholder: hint, "aria-invalid": errors?.[name] ? "true" : "false" } },
            errors?.[name] ? { span: { className: "field-error", textContent: errors[name] } } : { span: {} },
        ] } });
        const changes = (list) => ({ table: { className: "grid integrity-changes", children: [
            { thead: { children: [{ tr: { children: [{ th: "Field" }, { th: "Before" }, { th: "After" }] } }] } },
            { tbody: { children: list.map((c, k) => ({ tr: { key: `${c.field}-${k}`, children: [{ td: c.label ?? c.field }, ...(c.sensitive ? [{ td: { colSpan: 2, className: "muted", textContent: "sensitive: not shown" } }] : [{ td: shown(c.before) }, { td: shown(c.after) }])] } })) } },
        ] } });
        const detail = (f) => {
            const d = f.detail ?? {};
            const out = [];
            if (d.by) out.push({ p: { className: "small", children: [{ strong: "Written by " }, { span: `the database user ${d.by}${d.from ? ` from ${d.from}` : ""}${d.app ? ` (${d.app})` : ""}, ${day(d.at)}${d.op ? `: ${OP[d.op] ?? d.op}` : ""}` }] } });
            else if (f.kind === "record" && f.problem !== "removed") out.push({ p: { className: "small muted", textContent: `Not seen by the tripwire (it was off, or passed by): the seal no longer matches. Last written through the platform by ${d.updated_by ?? "—"}, ${day(d.updated_at)}.` } });
            if (f.problem === "removed" && d.created_by) out.push({ p: { className: "small", textContent: `Made through the platform by ${d.created_by}, ${day(d.created_at)}; no longer in the database.` } });
            if (f.problem === "replaced") out.push({ p: { className: "small", textContent: "Its seal is a real one, of an earlier version: the record was put back as it was (a row copied back, a restore of part of the database)." } });
            if (Array.isArray(d.changes) && d.changes.length) out.push(changes(d.changes));
            if (d.table) out.push({ p: { className: "small muted", textContent: `In the database: the table mes.${d.table}, row ${f.ref}.` } });
            if (f.object === "access") out.push({ p: { className: "small muted", textContent: "People, groups, departments' approvers, roles given or the organization's settings no longer match what the platform last wrote; a finding beside this one names the row when the database caught it." } });
            if (Array.isArray(d.seen) && d.seen.length) out.push({ p: { className: "small muted", textContent: `Written around the platform ${d.seen.length} more time(s) since: last by ${d.seen[d.seen.length - 1].by}, ${day(d.seen[d.seen.length - 1].at)}.` } });
            return out;
        };
        const openRow = (f) => {
            const F = `${I}.form.${f.id}`;
            const expanded = () => api.getState(`${I}.open`, null) === f.id;
            return { li: { key: f.id, className: "integrity-finding", children: [
                { div: { className: "integrity-finding-head", children: [
                    { span: { className: "integrity-badge", children: [icon("warning"), { span: PROBLEM[f.kind]?.[f.problem] ?? f.problem }] } },
                    { strong: `${KIND[f.kind] ?? f.kind}: ${whatOf(f)}` },
                    { span: { className: "muted small", textContent: `found ${day(f.foundAt)}` } },
                    { span: { className: "spacer" } },
                    { button: { type: "button", className: "btn small", textContent: () => (expanded() ? "Hide" : "Review"), "aria-expanded": () => String(expanded()), onclick: () => api.setValue(`${I}.open`, expanded() ? null : f.id) } },
                ] } },
                () => {
                    if (!expanded()) return { div: {} };
                    const errors = api.getState(`${F}.errors`, null);
                    const decision = api.getState(`${F}.decision`, "");
                    return { div: { className: "integrity-finding-body", children: [
                        ...detail(f),
                        { h4: "Non-conformance report" },
                        field(F, "what", "What happened", "What was changed, as far as you know", errors),
                        field(F, "why", "Why", "The cause: who did it and why, or what is known", errors),
                        { fieldset: { className: "integrity-decision", children: [
                            { legend: "Decision" },
                            ...["accepted", "corrected"].filter((k) => !(k === "corrected" && f.problem === "removed")).map((k) => ({ label: { key: k, children: [
                                { input: { type: "radio", name: `decision-${f.id}`, value: k, checked: decision === k, onchange: () => api.setValue(`${F}.decision`, k) } },
                                { span: DECISION[k] },
                            ] } })),
                            { p: { className: "muted small", textContent: decision === "corrected" ? (f.kind === "record" ? "Put it right first through its form or a transaction (its rules and policies decide); then close it here." : "Put it right first through a change request; executed, it is sealed again.") : decision === "accepted" ? "What is there now is sealed as it stands: the change is kept, with this report." : "Accepted keeps what is there; corrected means it was put right through the platform." } },
                            errors?.decision ? { span: { className: "field-error", textContent: errors.decision } } : { span: {} },
                        ] } },
                        field(F, "action", "Action taken", "What was done, and what stops it happening again", errors),
                        { div: { className: "integrity-actions", children: [{ button: { type: "button", className: "btn primary", textContent: "Close with this report", onclick: () => close(f) } }] } },
                    ] } };
                },
            ] } };
        };

        return { div: { className: "view integrity", children: [
            { div: { className: "view-head", children: [{ h1: "Data integrity" }, { span: { className: "muted", textContent: "Changes made to records, designs, people or roles outside the platform, in the database itself; each one closed with a signed non-conformance report." } }] } },
            () => {
                const s = api.getState(`${I}.said`, null);
                return s ? { p: { className: `login-note${s.ok ? "" : " refused"}`, role: s.ok ? "status" : "alert", children: [icon(s.ok ? "check" : "warning"), { span: s.words }] } } : { span: {} };
            },
            () => {
                const r = api.getState(`${I}.report`, null);
                if (!r) return { p: { className: "muted", textContent: "Reading…" } };
                if (r.error) return { p: { className: "error", textContent: r.error } };
                const working = api.getState(`${I}.busy`, false);
                return { div: { className: "integrity-body", children: [
                    !r.keyed ? { p: { className: "integrity-warn", role: "note", children: [icon("warning"), { span: "No integrity key is set (INTEGRITY_KEY): the seals are plain digests, which anyone who can write the database can make again. Changes are still found; ask IT to set the key, then seal everything again here." }] } } : { span: {} },
                    r.keyChanged ? { p: { className: "integrity-warn", role: "alert", children: [icon("warning"), { span: "The seals were made with another key: nothing is compared until a reviewer seals everything again with this one (the tripwire still keeps who writes around the platform)." }] } } : { span: {} },
                    { section: { className: "panel", children: [
                        { div: { className: "integrity-head", children: [
                            { h3: "Where it stands" },
                            { span: { className: "spacer" } },
                            { button: { type: "button", className: "btn small", disabled: working, children: [icon("scan"), { span: "Scan now" }], onclick: () => scan(false) } },
                            { button: { type: "button", className: "btn ghost small", disabled: working, textContent: "Full scan", onclick: scanAll } },
                            !r.baselineAt || r.keyChanged ? { button: { type: "button", className: `btn small${r.keyChanged ? " danger" : " primary"}`, disabled: working, textContent: r.keyChanged ? "Seal again (sign)" : "Take the baseline (sign)", onclick: () => baseline(r.keyChanged) } } : { span: {} },
                        ] } },
                        { dl: { className: "integrity-facts", children: [
                            { dt: "Baseline" }, { dd: r.baselineAt ? `${day(r.baselineAt)}, by ${r.baselineBy}` : "Not taken: only the tripwire finds changes until it is." },
                            { dt: "Last scan" }, { dd: r.lastScanAt ? `${day(r.lastScanAt)} (${plant().number(r.scanned)} record(s) checked)` : "None yet: the instance that schedules runs one every 15 minutes." },
                            { dt: "Last full scan" }, { dd: r.lastFullAt ? day(r.lastFullAt) : "None yet: one a week." },
                            { dt: "Reports" }, { dd: r.reportObject ? `Kept here and in the audit trail; each closed finding also raises a record in ${r.reportObject} (People & departments, Integrity).` : "Kept here and in the audit trail. People & departments, Integrity, can also raise each one as a record of your own object." },
                        ] } },
                    ] } },
                    { section: { className: "panel", children: [
                        { h3: `Open findings (${plant().number(r.openCount)})` },
                        r.open.length ? { ul: { className: "integrity-list", children: r.open.map(openRow) } } : { p: { className: "muted", textContent: r.lastScanAt ? "Nothing found: every record, design, person and role is as the platform wrote it." : "Not scanned yet: Scan now, or wait for the schedule." } },
                        r.openCount > r.open.length ? { p: { className: "muted small", textContent: `The ${r.open.length} newest shown; close them to see the rest.` } } : { span: {} },
                    ] } },
                    { section: { className: "panel", children: [
                        { h3: "Closed lately" },
                        r.closed.length ? { ul: { className: "integrity-list", children: r.closed.map((f) => ({ li: { key: f.id, className: "integrity-closed", children: [
                            { div: { children: [{ strong: `${KIND[f.kind] ?? f.kind}: ${whatOf(f)}` }, { span: { className: "muted small", textContent: ` · ${PROBLEM[f.kind]?.[f.problem] ?? f.problem}` } }] } },
                            { div: { className: "small", textContent: `${DECISION[f.report?.decision] ?? ""} by ${f.report?.printedName ?? f.report?.name ?? f.closedBy}, ${day(f.closedAt)}: ${f.report?.action ?? ""}` } },
                        ] } })) } } : { p: { className: "muted small", textContent: "None yet." } },
                    ] } },
                    { section: { className: "panel", children: [
                        { h3: "Periodic review" },
                        { p: { className: "muted small", textContent: "Sign that the findings of a period were reviewed (EU GMP Annex 11 asks it; the plant's own procedure says how often)." } },
                        { div: { className: "integrity-review", children: [
                            { label: { children: [{ span: "From" }, { input: { type: "date", "aria-label": "Reviewed from", value: () => api.getState(`${I}.rv.from`, "") ?? "", onchange: (e) => api.setValue(`${I}.rv.from`, e.target.value) } }] } },
                            { label: { children: [{ span: "To" }, { input: { type: "date", "aria-label": "Reviewed to", value: () => api.getState(`${I}.rv.to`, "") ?? "", onchange: (e) => api.setValue(`${I}.rv.to`, e.target.value) } }] } },
                            { label: { className: "grow", children: [{ span: "What was reviewed and found" }, { input: { type: "text", "aria-label": "What was reviewed and found", value: () => api.getState(`${I}.rv.note`, "") ?? "", oninput: (e) => api.setValue(`${I}.rv.note`, e.target.value) } }] } },
                            { button: { type: "button", className: "btn", textContent: "Sign the review", onclick: review } },
                        ] } },
                        r.reviews.length ? { ul: { className: "integrity-list", children: r.reviews.map((v) => ({ li: { key: v.id, className: "small", textContent: `${plant().date(v.from.slice(0, 10))} to ${plant().date(v.to.slice(0, 10))}: ${v.note} (${v.open} open, ${v.closed} closed) · ${v.signature?.printedName ?? v.name ?? v.by}, ${day(v.at)}` } })) } } : { span: {} },
                    ] } },
                ] } };
            },
        ] } };
    });
}
