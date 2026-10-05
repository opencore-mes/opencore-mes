// The write database's state as this page knows it (server/db-gate.js), at `sys.db`:
//   "up"     (or unset) nothing known to be wrong
//   "down"   a call was refused because the database is unreachable: saving is blocked, and the
//            page asks `status.db` every few seconds until it answers "up"
//   "back"   it answered again: changes that were not saved can be saved now (for a short while,
//            then "up")
import { icon } from "./icons.js";
const POLL_MS = 3000;
const BACK_MS = 15000;
const REFUSED = new Set(["db.unavailable", "db.unknown"]);
let polling = null;

export const dbDown = (api) => api.getState("sys.db", "up") === "down";

// Told of every failed call: a refusal because the database is unreachable marks it down.
export function noteFailure(api, error) {
    if (!REFUSED.has(error?.code) || api.isServer) return;
    if (api.peek("sys.db") !== "down") api.setValue("sys.db", "down");
    if (polling) return;
    const tick = async () => {
        try {
            const { state } = await api.call("status.db");
            if (state === "up") {
                polling = null;
                api.setValue("sys.db", "back");
                setTimeout(() => { if (api.peek("sys.db") === "back") api.setValue("sys.db", "up"); }, BACK_MS);
                return;
            }
        } catch {
            // The server itself did not answer: ask again.
        }
        polling = setTimeout(tick, POLL_MS);
    };
    polling = setTimeout(tick, POLL_MS);
}

// Whether a failed call's outcome is unknown: the database stopped answering during COMMIT, the
// request timed out, or no answer came at all. Sending it again with the same key finds out.
export const outcomeUnknown = (error) => error?.code === "db.unknown" || error?.code === "request.timeout" || error?.status === undefined;

export const NO_ANSWER = "The server did not answer, so it is not known whether your change was saved. Send it again: the same change is never saved twice.";

export function registerDbStatus(juris) {
    juris.registerComponent("DbBanner", (props, api) => () => {
        const state = api.getState("sys.db", "up");
        if (state === "down") return { div: { className: "db-banner down", role: "alert", children: [icon("warning"), { span: "The database is unavailable. Nothing can be saved until it is back. Keep your screens open: what you typed stays here." }] } };
        if (state === "back") return { div: { className: "db-banner back", role: "status", children: [icon("check"), { span: "The database is back. Save again any change that was not saved." }] } };
        return { span: {} };
    });
}
