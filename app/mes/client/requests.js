// Approval of record changes (DESIGN.md §28), in the browser: why a change is asked for (before it is
// sent), what waits on a record (a banner on its form), a request's own page, and the section of the
// approvals list. Which changes wait, and for whom, is each object's design (definition.js
// needsApproval, recordRoute); the server decides.
import { needsApproval } from "./definition.js";
import { confirmDialog, askDialog } from "./dialog.js";
import { signDialog } from "./sign.js";
import { titleTab } from "./shell.js";
import { plant } from "./format.js";
import { icon } from "./icons.js";

const ago = (at) => {
    if (!at) return "";
    const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
    return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
// A value of a field the reader's policies hide: the request says that it waits, not what it holds (§28).
const HIDDEN = "hidden from you";
const shown = (type, value, title) => {
    if (value === undefined || value === null || value === "") return "—";
    if (type === "ref") return title ?? "(not visible to you)";
    if (Array.isArray(value)) return value.join(", ") || "—";
    if (type === "boolean") return value ? "yes" : "no";
    if (type === "decimal" || type === "integer") return plant().number(value);
    if (type === "date") return plant().date(value);
    return String(value);
};
const whatOf = (r) => (r.op === "create" ? `New ${String(r.label).toLowerCase()}${r.title ? ` ${r.title}` : ""}` : r.op === "action" ? `${r.actionLabel ?? r.action} ${r.label} ${r.title ?? ""}` : `Change to ${r.label} ${r.title ?? ""}`).trim();
const STATE_WORDS = { pending: "Waiting for approval", applied: "Approved and applied", rejected: "Rejected", void: "Void: not applied", withdrawn: "Withdrawn" };

// Before a change is sent: when its object's design says it waits for approval, ask why. → the reason,
// "" when it does not wait, or null when the person cancelled.
export async function reasonFor(api, def, spec, what) {
    if (!needsApproval(def, spec)) return "";
    const why = await askDialog(api, {
        title: "Send for approval",
        message: `${what} waits for approval by the stewards before it takes effect; until then the record stays as it is. Say why.`,
        label: "Why", required: true, multiline: true, confirm: "Send for approval",
    });
    return why === null ? null : why.trim();
}
// After: the words for a change that now waits.
export const sentWords = (req) => `Sent for approval by ${req.route.join(", ")}. It takes effect once they sign.`;

// The departments' progress, as chips (the approvals list's).
function chips(r) {
    return r.departments.map((d) => {
        if (d.status === "approved") return { span: { key: d.department, className: "appr-chip approved", children: [icon("check"), { span: `${d.department}${d.by ? ` (${d.by})` : ""}` }] } };
        if (d.status === "rejected") return { span: { key: d.department, className: "appr-chip rejected", title: d.note ?? "", children: [icon("x"), { span: `${d.department}${d.by ? ` (${d.by})` : ""}` }] } };
        if (d.status !== "pending") return { span: { key: d.department, className: "appr-chip after", textContent: d.department } };
        const step = d.of > 1 ? ` · ${d.step} (${d.stepNo} of ${d.of})` : "";
        return { span: { key: d.department, className: `appr-chip pending${d.mine ? " mine" : ""}`, textContent: `${d.department}${step}: ${d.mine ? "yours" : `waiting for ${d.waitingFor?.join(" or ") || "nobody"}`}` } };
    });
}

// A request, drawn: what it asks, why, who has signed, and what this person may do. `full`: its page.
function card(api, r, { full = false, busyPath }) {
    const busy = () => api.getState(busyPath, false);
    const note = `${busyPath}.note`;
    const run = async (fn) => {
        api.batch(() => { api.setValue(busyPath, true); api.setValue(note, null); });
        try { await fn(); } catch (error) { api.setValue(note, error?.message ?? "It could not be done."); } finally { api.setValue(busyPath, false); }
    };
    // Each approval is a signature (§7.4): where the plant asks it, the signer proves who they are (sign.js).
    const approve = (department) => run(async () => {
        const st = r.can.approveSteps?.[department];
        const signature = await signDialog(api, { title: `Approve for ${department}${st && st.of > 1 ? ` as ${st.label}` : ""}?`, message: `${whatOf(r)}. Your signature means you approve this change; it is recorded with your name and the time.${r.current ? "" : " The record changed after this was asked for: once every department signs, it will be void, not applied."}`, confirm: "Approve (sign)" });
        if (signature) await api.call("requests.approve", { id: r.id, department, decision: "approve", meaning: "Approved", signature });
    });
    const reject = (department) => run(async () => {
        const why = await askDialog(api, { title: `Reject for ${department}?`, message: `${whatOf(r)}. Nothing is changed; ${r.requested_by} is told why.`, label: "Why", required: true, multiline: true, confirm: api.getState("signing.password", false) ? "Next: sign" : "Reject (sign)", danger: true });
        if (!why) return;
        const signature = api.getState("signing.password", false) ? await signDialog(api, { title: `Reject for ${department}?`, message: "Your signature means you reject this change. Enter your password to sign.", confirm: "Reject (sign)", danger: true }) : {};
        if (signature) await api.call("requests.approve", { id: r.id, department, decision: "reject", meaning: "Rejected", note: why, signature });
    });
    const withdraw = () => run(async () => {
        if (await confirmDialog(api, { title: "Withdraw this change?", message: "It stops waiting, and nothing is changed.", confirm: "Withdraw" })) await api.call("requests.withdraw", { id: r.id });
    });
    const rows = r.op === "edit"
        ? r.changes.map((c) => ({ tr: { key: c.field, children: [{ td: c.label }, { td: { className: "muted", textContent: c.hidden ? HIDDEN : shown(c.type, c.before, c.beforeTitle) } }, { td: { children: [icon("arrowRight")] } }, { td: { className: c.hidden ? "muted" : "req-after", textContent: c.hidden ? HIDDEN : shown(c.type, c.after, c.afterTitle) } }] } }))
        : r.changes.map((c) => ({ tr: { key: c.field, children: [{ td: c.label }, { td: { className: c.hidden ? "muted" : "req-after", colSpan: 3, textContent: c.hidden ? HIDDEN : shown(c.type, c.after, c.afterTitle) } }] } }));
    return {
        div: {
            className: `req-card state-${r.state}${r.mine ? " mine" : ""}`,
            children: [
                { div: { className: "req-head", children: [
                    { strong: { className: "icon-text", children: [r.state === "pending" ? icon("hourglass") : { span: {} }, { span: STATE_WORDS[r.state] ?? r.state }] } },
                    { span: { className: "muted", textContent: ` · ${whatOf(r)}` } },
                    full || r.state !== "pending" ? { span: {} } : { Link: { to: `/request/${r.id}`, className: "req-open small", textContent: "Open" } },
                ] } },
                r.op === "action" ? { p: { textContent: `${r.actionLabel ?? r.action}: ${String(r.recordState ?? "").replace(/_/g, " ")} → ${String(r.to ?? "").replace(/_/g, " ")}` } } : { span: {} },
                rows.length ? { table: { className: "req-changes", children: [{ tbody: { children: rows } }] } } : { span: {} },
                { p: { className: "small", children: [{ span: { className: "muted", textContent: `Asked by ${r.requested_by} ${ago(r.requested_at)}: ` } }, { span: { className: "req-why", textContent: `“${r.reason}”` } }] } },
                { div: { className: "req-route", children: chips(r) } },
                r.state === "pending" && !r.current ? { p: { className: "error small", textContent: "The record changed after this was asked for: once every department signs, it is void, not applied. Its requester asks again." } } : { span: {} },
                r.outcome ? { p: { className: r.state === "applied" ? "notice small" : "error small", textContent: r.outcome } } : { span: {} },
                full ? { div: { className: "req-signed small muted", children: r.departments.flatMap((d) => d.signed.map((s) => ({ div: { key: `${d.department}-${s.step}`, textContent: `${d.department} step ${s.step}: ${s.decision === "approve" ? "approved" : "rejected"} by ${s.by} (${s.meaning}) ${ago(s.at)}${s.note ? ` — “${s.note}”` : ""}` } }))) } } : { span: {} },
                {
                    div: {
                        className: "req-buttons",
                        children: [
                            ...r.can.approveFor.flatMap((d) => [
                                { button: { key: `a-${d}`, type: "button", className: "btn primary", disabled: busy, textContent: `Approve for ${d}${r.can.approveSteps?.[d]?.of > 1 ? ` as ${r.can.approveSteps[d].label}` : ""}`, onclick: () => approve(d) } },
                                { button: { key: `r-${d}`, type: "button", className: "btn", disabled: busy, textContent: `Reject for ${d}`, onclick: () => reject(d) } },
                            ]),
                            r.can.withdraw ? { button: { key: "w", type: "button", className: "btn ghost", disabled: busy, textContent: "Withdraw", onclick: withdraw } } : { span: {} },
                            { span: { className: "error small", textContent: () => api.getState(note, "") ?? "" } },
                        ],
                    },
                },
            ],
        },
    };
}

export function registerRequests(juris, { args }) {
    // What waits on one record, on its form.
    juris.registerComponent("RequestBanner", ({ object, id }, api) => {
        const as = api.getState("me.id", null, { track: false });
        const path = `rq.rec.${object}.${id}`;
        api.live(path, "requests.ofRecord", args.recordRequest(object, id, as));
        return () => {
            const r = api.getState(path, null);
            return r ? card(api, r, { busyPath: `rq.busy.${r.id}` }) : { span: {} };
        };
    });

    // One request, on its own page: a new record's (which has no form yet), or any linked to.
    juris.registerComponent("RequestPage", ({ id }, api) => {
        const as = api.getState("me.id", null, { track: false });
        const path = `rq.one.${id}`;
        api.live(path, "requests.get", args.request(id, as));
        if (!api.isServer) titleTab(api, `/request/${id}`, "Change request");
        return {
            div: {
                className: "view request",
                children: [() => {
                    const r = api.getState(path, undefined);
                    if (r === undefined) return { p: { className: "muted", textContent: "Loading…" } };
                    if (!r) return { p: { className: "muted", textContent: "This change does not exist, or it is not shared with you." } };
                    return { div: { children: [
                        { div: { className: "view-head", children: [{ h1: whatOf(r) }, r.record_id ? { Link: { to: `/o/${r.object}/${r.record_id}`, className: "btn ghost", textContent: `Open the ${String(r.label).toLowerCase()}` } } : { span: {} }] } },
                        card(api, r, { full: true, busyPath: `rq.busy.${r.id}` }),
                    ] } };
                }],
            },
        };
    });

    // The approvals list's section: every change to a record waiting that this person may see, theirs
    // to sign first; and the last of theirs decided.
    juris.registerComponent("RecordRequests", ({ onlyMine }, api) => {
        const as = api.getState("me.id", null, { track: false });
        api.live("rq.list", "requests.list", args.requests(as));
        return () => {
            const list = api.getState("rq.list", null);
            if (!list) return { p: { className: "muted", textContent: "Loading…" } };
            const pending = list.pending.filter((r) => !onlyMine() || r.mine);
            return {
                div: {
                    className: "req-list",
                    children: [
                        pending.length ? { div: { children: pending.map((r) => ({ div: { key: r.id, children: [card(api, r, { busyPath: `rq.busy.${r.id}` })] } })) } } : { p: { className: "muted", textContent: onlyMine() ? "No change to a record waits for you." : "No change to a record is waiting." } },
                        list.decided.length ? { details: { className: "req-decided", children: [{ summary: `Decided lately (${list.decided.length})` }, ...list.decided.map((r) => ({ div: { key: r.id, children: [card(api, r, { busyPath: `rq.busy.${r.id}` })] } }))] } } : { span: {} },
                    ],
                },
            };
        };
    });
}
