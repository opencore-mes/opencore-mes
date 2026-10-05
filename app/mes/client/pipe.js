// The rule pipe (DESIGN.md §12): scripts run one after another, each given the context the previous
// one returned. A script rejects by throwing. The same code runs in the browser (advice, in a Web
// Worker) and on the server (the decision), each with its own way of compiling and calling a script.
//
//   runPipe({ entries, invoke, ctx, onlyClient }) → { ctx, error, trace }
//
//   entries   the object's rule list: [{ script, writes, when, committed, backendOnly }]
//   invoke    async (name, ctx) → ctx: runs one script (compiled by the caller)
//   ctx       { event, user, record, data, now, …capabilities are the invoker's to add }
//
// `error` is null, or { script, message, field, fields, fault }: `fault` true when the script failed
// by accident (a bug, a limit), whose words are not shown to the user (§12.5).
import { evaluate } from "./expr.js";

const FROZEN = ["event", "user", "record", "now"];
const FAULT_NAMES = new Set(["TypeError", "ReferenceError", "SyntaxError", "RangeError", "EvalError", "URIError", "InternalError"]);

// Name rule and file shape (§12.1): `export default [async] function <name>(ctx) { … }` and nothing
// else. Answers the function's source without the export, or throws with the reason.
export function scriptBody(name, source) {
    const match = /^\s*((?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*)export\s+default\s+((?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([\s\S]*)$/.exec(source);
    if (!match) throw new Error(`${name}: a rule script is "export default function ${name}(ctx) { … }"`);
    if (match[3] !== name) throw new Error(`${name}: the function is named "${match[3]}"; its name must be the file's name, "${name}"`);
    return match[2];
}

// Is this a fault (the script failed by accident) rather than a rejection it meant?
export function isFault(error) {
    if (error === null || typeof error !== "object") return true;
    if (error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || error.fault === true) return true;
    if (FAULT_NAMES.has(error.name)) return true;
    return typeof error.message !== "string" || !error.message;
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// The fields of `after` that differ from `before`.
function changedFields(before, after) {
    const names = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
    return [...names].filter((name) => JSON.stringify(before?.[name]) !== JSON.stringify(after?.[name]));
}

export async function runPipe({ entries, invoke, ctx: start, onlyClient = false }) {
    let ctx = clone(start);
    const trace = [];
    for (const entry of entries) {
        const kind = ctx.event.kind;
        if (entry.committed ? kind !== "committed" : kind === "committed") continue;
        if (onlyClient && entry.backendOnly) { trace.push({ script: entry.script, outcome: "skipped (backend only)" }); continue; }
        if (entry.when !== undefined && evaluate(entry.when, ctx) !== true) { trace.push({ script: entry.script, outcome: "skipped (when)" }); continue; }
        const began = Date.now();
        const before = clone(ctx);
        let after;
        try {
            after = await invoke(entry.script, clone(ctx));
            if (after === null || typeof after !== "object" || typeof after.data !== "object") {
                throw Object.assign(new Error(`${entry.script} did not return the context`), { fault: true });
            }
            after = clone(after);
        } catch (thrown) {
            const fault = isFault(thrown);
            const error = {
                script: entry.script,
                fault,
                message: fault ? `The rule \`${entry.script}\` could not run; the change was not saved.` : thrown.message,
                detail: fault ? String(thrown?.stack ?? thrown?.message ?? thrown) : undefined,
                field: fault ? undefined : thrown.field,
                fields: fault ? undefined : thrown.fields,
            };
            trace.push({ script: entry.script, outcome: fault ? "fault" : "threw", message: error.message, ms: Date.now() - began });
            return { ctx: before, error, trace };
        }
        // What stays fixed stays fixed; only declared fields of `data` may change (§12.2).
        for (const key of FROZEN) {
            if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) {
                const error = { script: entry.script, fault: true, message: `The rule \`${entry.script}\` could not run; the change was not saved.`, detail: `changed ctx.${key}, which is read-only` };
                trace.push({ script: entry.script, outcome: "fault", message: error.detail });
                return { ctx: before, error, trace };
            }
        }
        const changed = changedFields(before.data, after.data);
        const undeclared = changed.filter((field) => !(entry.writes ?? []).includes(field));
        if (undeclared.length) {
            const error = { script: entry.script, fault: true, message: `The rule \`${entry.script}\` could not run; the change was not saved.`, detail: `wrote ${undeclared.join(", ")}, which its binding does not declare` };
            trace.push({ script: entry.script, outcome: "fault", message: error.detail });
            return { ctx: before, error, trace };
        }
        trace.push({ script: entry.script, outcome: "passed", changed, ms: Date.now() - began });
        ctx = after;
    }
    return { ctx, error: null, trace };
}
