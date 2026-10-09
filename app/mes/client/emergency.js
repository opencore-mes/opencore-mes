// Emergency changes (DESIGN.md §5.7): what the server and the designer both work out, nothing drawn.
// A change the plant cannot wait for (a line down, someone who must have access now) is submitted as an
// emergency, with a reason: it skips review, one signature executes it, and it is reviewed afterwards
// by the normal route (a reviewer, then each department it touches confirms or flags it) within a set
// number of days. The stages are not skipped, only put after execution.

// The organization's word on emergencies (§27, `emergency` in its settings): allowed unless it says
// not, and how many days the review afterwards may take (3 unless it says, from 1 to 30).
export function emergencyPolicy(settings) {
    const e = settings?.emergency;
    const days = Number(e?.reviewDays);
    return { allowed: e?.allowed !== false, reviewDays: Number.isInteger(days) && days >= 1 && days <= 30 ? days : 3 };
}

// When the review afterwards is due: `days` after execution. → ISO moment.
export const emergencyDue = (executedAt, days) => new Date(new Date(executedAt).getTime() + days * 86_400_000).toISOString();

// Stages: approval (waiting for its one signature) → review (executed, to be reviewed afterwards) →
// confirm (each department confirms or flags it) → confirmed | flagged.
export const OPEN_STAGES = ["review", "confirm"];

// Whether the review afterwards is still to be done, and whether it is late, at `now` (ms or a Date).
export function emergencyOpen(em, now = Date.now()) {
    const open = Boolean(em) && OPEN_STAGES.includes(em.stage);
    return { open, overdue: open && Boolean(em.due) && new Date(em.due).getTime() < new Date(now).getTime() };
}

// The stage after a department's decision: flagged at the first flag; confirmed once every department
// on the route has confirmed; else still confirm. `decisions`: { department: { decision } }.
export function stageAfter(route, decisions) {
    const all = Object.values(decisions ?? {});
    if (all.some((d) => d?.decision === "flag")) return "flagged";
    const departments = (route ?? []).map((r) => r.department);
    return departments.length && departments.every((d) => decisions?.[d]?.decision === "confirm") ? "confirmed" : "confirm";
}

// Who may confirm or flag it for a department: one of its approvers (any step), never one of its
// authors, never whoever reviewed it afterwards (as a reviewer never approves, §5.6). Whoever gave it its
// emergency signature may confirm it for their department, now with its review before them: the
// department decides once, as on the normal route, and a department with one approver still can.
export const confirmersOf = (approvers, { authors = [], reviewer = null } = {}) =>
    [...new Set(approvers ?? [])].filter((u) => !authors.includes(u) && u !== reviewer);

// The stage in a few words, for a badge or a list. Overdue as the server has said it (`overdue`, once
// its job has flagged it), else by the clock.
export function emergencyWords(em, now = Date.now()) {
    if (!em) return "";
    const overdue = em.overdue !== undefined ? Boolean(em.overdue) && OPEN_STAGES.includes(em.stage) : emergencyOpen(em, now).overdue;
    const words = {
        approval: "emergency: waiting for one signature",
        review: "emergency, awaiting review",
        confirm: "emergency, awaiting confirmation",
        confirmed: "emergency, reviewed afterwards",
        flagged: "emergency, flagged",
    }[em.stage] ?? "emergency";
    return overdue ? `${words} (overdue)` : words;
}
