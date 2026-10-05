// Approvals (DESIGN.md §5.3): every change waiting for review or approval, live, with each department
// on its route: approved (by whom), rejected, or pending (at which step, for whom). What this person
// can do now comes first. Below the changes to designs, the changes to records that wait (§28,
// requests.js).
import { titleTab } from "./shell.js";
import { icon } from "./icons.js";

const ago = (at) => {
    if (!at) return "";
    const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
    return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min` : s < 129600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
};

export function registerApprovals(juris, { args }) {
    juris.registerComponent("ApprovalsPage", (props, api) => {
        const as = api.getState("me.id", null, { track: false });
        api.live("design.approvals", "design.approvals", args.approvals(as));
        if (!api.isServer) titleTab(api, "/design/approvals", "Approvals");
        const [onlyMine, setOnlyMine] = api.useState("mine", false);
        const chip = (d) => {
            if (d.status === "after review") return { span: { key: d.department, className: "appr-chip after", textContent: `${d.department}: after review` } };
            if (d.status === "approved") return { span: { key: d.department, className: "appr-chip approved", children: [icon("check"), { span: `${d.department}${d.by ? ` (${d.by})` : ""}` }] } };
            if (d.status === "rejected") return { span: { key: d.department, className: "appr-chip rejected", children: [icon("x"), { span: `${d.department}${d.by ? ` (${d.by})` : ""}` }] } };
            const step = d.of > 1 ? ` · ${d.step} (${d.stepNo} of ${d.of})` : "";
            const who = d.waitingFor?.length ? d.waitingFor.join(" or ") : "nobody";
            return { span: { key: d.department, className: `appr-chip pending${d.mine ? " mine" : ""}`, textContent: `${d.department}${step}: ${d.mine ? "yours" : `waiting for ${who}`}` } };
        };
        return {
            div: {
                className: "view approvals",
                children: [
                    { div: { className: "view-head", children: [
                        { h1: "Approvals" },
                        { span: { className: "muted", textContent: () => {
                            const all = api.getState("design.approvals.changes", []) ?? [];
                            const mine = all.filter((c) => c.mine).length;
                            return `${all.length} change(s) waiting${mine ? `, ${mine} for you` : ""}.`;
                        } } },
                        { span: { className: "spacer" } },
                        { label: { className: "muted small", children: [{ input: { type: "checkbox", checked: () => onlyMine(), onchange: (e) => setOnlyMine(e.target.checked) } }, { span: " Only what I can do now" }] } },
                    ] } },
                    { h2: { className: "appr-section", textContent: "Changes to designs" } },
                    () => {
                        const all = api.getState("design.approvals.changes", null);
                        if (!all) return { p: { className: "muted", textContent: "Loading…" } };
                        const rows = [...all].filter((c) => !onlyMine() || c.mine).sort((a, b) => Number(b.mine) - Number(a.mine) || String(a.since).localeCompare(String(b.since)));
                        if (!rows.length) return { p: { className: "muted", textContent: onlyMine() ? "Nothing waits for you." : "Nothing is waiting for review or approval." } };
                        return {
                            table: {
                                className: "grid approvals-grid",
                                children: [
                                    { thead: { children: [{ tr: { children: ["Change", "Stage", "Departments", "Waiting", ""].map((h) => ({ th: h })) } }] } },
                                    { tbody: { children: rows.map((c) => ({
                                        tr: {
                                            key: c.id, className: c.mine ? "row mine" : "row",
                                            onclick: () => api.navigate(`/design/c/${c.id}`),
                                            children: [
                                                { td: { children: [{ Link: { to: `/design/c/${c.id}`, textContent: c.title } }, { div: { className: "muted small", textContent: `by ${c.author}` } }] } },
                                                { td: { children: [{ span: { className: `badge s-${c.state}`, textContent: c.state } }] } },
                                                { td: { children: c.state === "review"
                                                    ? [{ span: { className: `appr-chip pending${c.mine ? " mine" : ""}`, textContent: c.mine ? "review: yours" : `review: ${c.reviewableBy.join(", ") || "nobody"}` } }, ...c.departments.map(chip)]
                                                    : c.departments.map(chip) } },
                                                { td: { className: "muted small", textContent: `${ago(c.since)}${c.lastSigned ? ` · last signed ${ago(c.lastSigned)} ago` : ""}` } },
                                                { td: { children: [c.mine ? { span: { className: "badge s-review", textContent: c.state === "review" ? "review it" : "sign it" } } : { span: {} }] } },
                                            ],
                                        },
                                    })) } },
                                ],
                            },
                        };
                    },
                    { h2: { className: "appr-section", textContent: "Changes to records" } },
                    { RecordRequests: { onlyMine } },
                ],
            },
        };
    });
}
