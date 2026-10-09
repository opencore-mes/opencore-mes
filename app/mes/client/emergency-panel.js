// An emergency change (DESIGN.md §5.7), in the designer: beside the change, why it could not wait, who
// gave it its one signature, by when it is to be reviewed afterwards (and whether that is overdue), the
// review and each department's confirmation or flag so far, and what this person may do now. A
// flagged one points at rolling it back (rollback.js, §5.14).
import { icon } from "./icons.js";
import { askDialog } from "./dialog.js";
import { signDialog } from "./sign.js";
import { plant } from "./format.js";
import { emergencyWords } from "./emergency.js";

export function registerEmergency(juris) {
    juris.registerComponent("EmergencyPanel", ({ id }, api) => {
        const P = `emergency.${id}`;
        const run = async (done, fn) => {
            api.batch(() => { api.setValue(`${P}.busy`, true); api.setValue(`${P}.error`, null); api.setValue(`${P}.notice`, null); });
            try {
                const r = await fn();
                if (r) api.setValue(`${P}.notice`, typeof done === "function" ? done(r) : done);
            } catch (e) {
                api.setValue(`${P}.error`, e.message);
            } finally {
                api.setValue(`${P}.busy`, false);
            }
        };
        const flagNote = (title, message) => askDialog(api, { title, message, label: "What is wrong with it?", required: true, multiline: true, confirm: "Flag it", danger: true });
        const review = async (decision) => {
            const note = decision === "flag" ? await flagNote("Flag this emergency change", "It stays live. Its author, its departments and the audit trail read your note, and a designer may roll it back.") : "";
            if (note === null) return;
            await run(decision === "pass" ? "Reviewed: its departments now confirm it or flag it." : "Flagged. A designer may roll it back.", () => api.call("design.emergencyReview", { id, decision, note }));
        };
        const confirm = async (department, decision) => {
            const note = decision === "flag" ? await flagNote(`Flag it for ${department}`, "It stays live. Its author, its reviewer and the audit trail read your note, and a designer may roll it back.") : "";
            if (note === null) return;
            // A confirmation is a signature (§7.4): where the plant asks it, the signer proves who they are.
            const signature = api.getState("signing.password", false)
                ? await signDialog(api, { title: `${decision === "confirm" ? "Confirm" : "Flag"} for ${department}?`, message: `Your signature means you ${decision === "confirm" ? "confirm" : "flag"} this emergency change for ${department}, after it went live; it is recorded with your name, the time and its meaning. Enter your password to sign.`, confirm: decision === "confirm" ? "Confirm (sign)" : "Flag (sign)", danger: decision === "flag" })
                : {};
            if (signature === null) return;
            await run((r) => (r.stage === "confirmed" ? "Confirmed: every department has, and the emergency is closed." : r.stage === "flagged" ? "Flagged. A designer may roll it back." : `Confirmed for ${department}.`), () => api.call("design.emergencyConfirm", { id, department, decision, note, signature }));
        };
        return { div: { className: "emergency-panel", children: () => {
            const c = api.getState(`dc.${id}`, null);
            const em = c?.emergency;
            if (!em || String(id).startsWith("view-")) return [];
            const busy = api.getState(`${P}.busy`, false);
            const out = [];
            out.push({ h4: { key: "h", className: "icon-text", children: [icon("warning"), { span: `An emergency change` }, { span: { className: `badge s-emergency${em.overdue ? " overdue" : ""}`, textContent: emergencyWords(em) } }] } });
            out.push({ p: { key: "why", className: "small", textContent: `Why it could not wait (${em.by}): ${em.reason}` } });
            if (c.state === "approval") out.push({ p: { key: "how", className: "small", textContent: `It skips review: one signature, by an approver of any department below (not its author), executes it at once. It is then reviewed afterwards, within ${em.reviewDays} day(s): a reviewer, then each department confirms it or flags it.` } });
            if (em.approved) out.push({ p: { key: "signed", className: "small", textContent: `Signed by ${em.approved.user} for ${em.approved.department}, live since ${plant().dateTime(em.executedAt)}.` } });
            if (em.open) out.push({ p: { key: "due", className: `small ${em.overdue ? "error" : "muted"}`, textContent: em.overdue ? `Its review afterwards was due by ${plant().dateTime(em.due)}, and is overdue.` : `To be reviewed afterwards by ${plant().dateTime(em.due)}.` } });
            if (em.review) out.push({ p: { key: "review", className: "small", textContent: `Reviewed afterwards by ${em.review.reviewer}: ${em.review.decision === "pass" ? "passed to its departments" : "flagged"}${em.review.note ? `: ${em.review.note}` : "."}` } });
            const decided = Object.entries(em.departments ?? {});
            if (decided.length) out.push({ ul: { key: "deps", className: "small", children: decided.map(([d, x]) => ({ li: { key: d, className: "icon-text", children: [icon(x.decision === "confirm" ? "check" : "flag"), { span: `${d}: ${x.decision === "confirm" ? "confirmed" : "flagged"} by ${x.user}${x.note ? `: ${x.note}` : ""}` }] } })) } });
            if (em.stage === "review") out.push({ p: { key: "who", className: "muted small", textContent: em.reviewableBy?.length ? `May review it: ${em.reviewableBy.join(", ")}.` : "Nobody may review it yet: its departments need approvers who neither wrote nor signed it (People & departments)." } });
            if (em.stage === "confirm") for (const [d, users] of Object.entries(em.confirmers ?? {})) if (!(c.can?.confirmFor ?? []).includes(d)) out.push({ p: { key: `w-${d}`, className: "muted small", textContent: `${d}: ${users.length ? `waiting for ${users.join(" or ")}` : "nobody may confirm it: its approvers wrote or reviewed it"}.` } });
            if (c.can?.afterReview) {
                const allowed = (em.reviewableBy ?? []).includes(api.peek("me.id"));
                if (!allowed) out.push({ p: { key: "strand", className: "small review-warn", textContent: "If you review it, some department would have nobody left to confirm it; ask someone else to review it." } });
                out.push({ div: { key: "rv", className: "actions", children: [
                    { button: { type: "button", className: "btn primary", disabled: busy || !allowed, textContent: "Pass review afterwards", onclick: () => review("pass") } },
                    { button: { type: "button", className: "btn", disabled: busy, children: [icon("flag"), { span: "Flag it" }], onclick: () => review("flag") } },
                ] } });
            }
            for (const d of c.can?.confirmFor ?? []) out.push({ div: { key: `c-${d}`, className: "actions", children: [
                { button: { type: "button", className: "btn primary", disabled: busy, textContent: `Confirm for ${d} (sign)`, onclick: () => confirm(d, "confirm") } },
                { button: { type: "button", className: "btn", disabled: busy, children: [icon("flag"), { span: `Flag for ${d}` }], onclick: () => confirm(d, "flag") } },
            ] } });
            if (em.stage === "flagged") out.push({ p: { key: "flagged", className: "small error", textContent: `Flagged by ${em.flagged?.by ?? "a reviewer"}${em.flagged?.department ? ` for ${em.flagged.department}` : ""}: ${em.flagged?.note ?? ""} It is still live: a designer may roll it back below, and one approval executes the rollback.` } });
            const error = api.getState(`${P}.error`, null);
            if (error) out.push({ p: { key: "err", className: "error small", role: "alert", textContent: error } });
            const notice = api.getState(`${P}.notice`, null);
            if (notice) out.push({ p: { key: "ok", className: "notice small", textContent: notice } });
            return out;
        } } };
    });
}
