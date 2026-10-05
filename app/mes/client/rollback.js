// Rolling a change back (DESIGN.md §5.14), in the designer. On a change that has executed: what
// rolling it back would do, and the button that has the platform draft the change that does it. On
// that change: what it rolls back, what it puts back, retires and keeps, and what it left alone. A
// rollback is a change like any other on the record, with one difference: it is what was live before,
// reviewed and approved then, so it is not reviewed again and one approval executes it.
import { icon } from "./icons.js";
import { confirmDialog } from "./dialog.js";

const lines = (plan) => [
    ...plan.restores.map((x) => `${x.what}: back to how it was at version ${x.to}${x.undoesLater ? " (this also undoes the changes made to it since)" : ""}`),
    ...plan.retires.map((x) => `${x.what}: retired (that change created it)`),
    ...plan.republishes.map((x) => `${x.what}: published again (that change retired it)`),
    ...(plan.keeps ?? []).map((x) => `${x.what}: ${x.records} record(s) hold a value in it; kept, unseen, and shown again if the field returns`),
];
const left = (plan) => plan.skipped.map((x) => `${x.what} ${x.why}`);

export function registerRollback(juris) {
    juris.registerComponent("RollbackPanel", ({ id }, api) => {
        const P = `rollback.${id}`;
        const start = async () => {
            api.batch(() => { api.setValue(`${P}.busy`, true); api.setValue(`${P}.error`, null); });
            try {
                const plan = await api.call("design.rollbackPlan", { id });
                const does = lines(plan);
                const changedSince = plan.skipped.filter((x) => x.changed);
                if (!does.length && !changedSince.length) { api.setValue(`${P}.error`, `There is nothing to roll back: ${left(plan).join("; ") || "it changed nothing that is still live"}.`); return; }
                let includeChanged = false;
                if (changedSince.length) {
                    includeChanged = await confirmDialog(api, { title: "Changed again since", message: `${changedSince.map((x) => `${x.what} ${x.why}`).join(". ")}.\n\nRoll ${changedSince.length === 1 ? "it" : "them"} back too, undoing those later changes as well? Choose Cancel to leave ${changedSince.length === 1 ? "it" : "them"} as ${changedSince.length === 1 ? "it is" : "they are"}.`, confirm: "Roll back too", danger: true });
                    if (!includeChanged && !does.length) { api.setValue(`${P}.error`, "Nothing else is left to roll back."); return; }
                }
                const final = includeChanged ? await api.call("design.rollbackPlan", { id, includeChanged: true }) : plan;
                if (!(await confirmDialog(api, { title: "Roll this change back?", message: `A new change is drafted that puts back what this one changed:\n\n${(includeChanged ? lines(final) : does).map((l) => `• ${l}`).join("\n")}\n\nIt is tried in a sandbox at once. Nothing is live until you submit it and one approver signs it.`, confirm: "Draft the rollback" }))) return;
                const made = await api.call("design.rollback", { id, includeChanged });
                api.navigate(`/design/c/${made.id}`);
            } catch (e) {
                api.setValue(`${P}.error`, e.message);
            } finally {
                api.setValue(`${P}.busy`, false);
            }
        };
        return { div: { className: "rollback-panel", children: () => {
            const c = api.getState(`dc.${id}`, null);
            if (!c || String(id).startsWith("view-")) return [];
            const out = [];
            // A change that rolls another back: what it does, and how it is approved.
            if (c.rollback) {
                const r = c.rollback;
                out.push({ h4: { key: "h", className: "icon-text", children: [icon("refresh"), { span: "A rollback" }] } });
                out.push({ p: { key: "of", className: "small", children: [{ span: "It rolls back " }, { Link: { to: `/design/c/${r.of}`, textContent: r.title ?? "a change" } }, { span: "." }] } });
                out.push({ ul: { key: "does", className: "small rollback-lines", children: lines(r).map((l, k) => ({ li: { key: k, textContent: l } })) } });
                if (r.skipped?.length) out.push({ p: { key: "left", className: "muted small", textContent: `Left as it is: ${left(r).join("; ")}.` } });
                out.push({ p: { key: "how", className: `small ${r.pure ? "" : "rollback-edited"}`, textContent: r.pure
                    ? "It is what was live before, reviewed and approved then: it is not reviewed again, and one approval executes it (not its author's). It is tried in a sandbox first: a conflict with anything changed since stops it."
                    : "It was edited since the platform drafted it, so it is a change like any other: reviewed, and approved by every department it touches." } });
            }
            // A change that has executed: rolled back by a designer.
            if (c.rolledBackBy?.length) out.push({ p: { key: "by", className: "small", children: [{ span: "Rolled back by " }, ...c.rolledBackBy.flatMap((x, k) => [k ? { span: ", " } : { span: {} }, { Link: { to: `/design/c/${x.id}`, textContent: `${x.title} (${x.state})` } }])] } });
            if (c.can?.rollback && !(c.rolledBackBy ?? []).some((x) => ["design", "review", "approval", "executed"].includes(x.state))) {
                out.push({ button: { key: "go", type: "button", className: "btn", disabled: api.getState(`${P}.busy`, false), onclick: start, children: [icon("refresh"), { span: api.getState(`${P}.busy`, false) ? "Working it out…" : "Roll back this change" }] } });
                out.push({ p: { key: "hint", className: "muted small", textContent: "Drafts a change that puts back what this one changed. It needs one approval." } });
            }
            const error = api.getState(`${P}.error`, null);
            if (error) out.push({ p: { key: "err", className: "error small", role: "alert", textContent: error } });
            return out;
        } } };
    });
}
