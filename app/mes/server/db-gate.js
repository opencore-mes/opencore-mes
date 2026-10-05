// The write database's gate: what a call does while the database is unreachable.
//
// A save is one transaction (the record, its audit row, its trigger rows, its idempotency row), so
// an outage never half-saves anything. What the gate adds is the caller's side:
//   - Refuse at once, in words. The first call that finds the database unreachable marks it down;
//     from then on every call is refused immediately (503, code "db.unavailable") instead of waiting
//     for the pool's connect timeout. A probe, the only thing that touches the database meanwhile,
//     marks it up again.
//   - Say when the outcome is unknown. A transaction whose COMMIT was sent but never answered may or
//     may not have committed: that refusal says so (code "db.unknown"). Sending the same request
//     again with the same idempotency key finds out, and never saves twice.
//
//   const gate = gateDb(fromPg(pool), { probeMs, log, onDown(error), onUp({ downForMs, refused }) })
//   gate.query / gate.transaction   the adapter's own, gated
//   gate.state()                    { state: "up" | "down", since, refused }
//   gate.stop()                     stops the probe
//
// Only an unreachable database opens the gate. A statement that fails (a constraint, a timeout, a
// syntax error) is the caller's to handle, and goes through as it came.

const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "57P01", "57P02", "57P03"]);
const UNREACHABLE_WORDS = /timeout exceeded when trying to connect|connection terminated|terminating connection|connection error|connection is closed|server closed the connection|the database system is (starting up|shutting down|in recovery mode)/i;

// Is this error the database being unreachable, rather than a statement failing?
export function unreachable(error) {
    if (!error || typeof error !== "object") return false;
    const code = String(error.code ?? "");
    if (UNREACHABLE_CODES.has(code) || code.startsWith("08")) return true;
    return UNREACHABLE_WORDS.test(String(error.message ?? "")) || (error.cause !== undefined && unreachable(error.cause));
}

export const UNAVAILABLE = "The database is unavailable, so nothing can be saved right now. Your change is not saved: keep this screen open and save again once it is back.";
export const UNKNOWN = "The database stopped answering while your change was being saved, so it is not known whether it was saved. Send it again once the database is back: the same change is never saved twice.";

// The pool's own words for "no connection came free in time": the database may be unreachable, or
// only busy (every connection held by a slow statement). Which, a connection of its own says.
const POOL_WAIT = /timeout exceeded when trying to connect/i;
export const BUSY = "The server is busy with other requests just now. Your change is not saved: try again in a moment.";

const refusal = (unknown) => Object.assign(new Error(unknown ? UNKNOWN : UNAVAILABLE), { expose: true, status: 503, code: unknown ? "db.unknown" : "db.unavailable", retry: true });

// `onDown` and `onUp` are told when it goes down and comes back (event-log.js watchDb logs them).
// `reaches()` asks the database on a connection of its own, outside the pool (true: it answers). Given
// it, a call that only waited too long for a pooled connection is refused alone ("db.busy") while the
// database answers, and the gate stays open: ten slow statements are not an outage.
export function gateDb(db, { probeMs = 2000, log = console, onDown = null, onUp = null, reaches = null } = {}) {
    let since = null;   // when it went down; null while up
    let refused = 0;
    let timer = null;

    function probe() {
        timer = setTimeout(async () => {
            try {
                await db.query("SELECT 1");
                const downForMs = Date.now() - since;
                log.warn?.(`database: back after ${Math.round(downForMs / 1000)} s (${refused} call(s) refused meanwhile)`);
                since = null;
                timer = null;
                try { onUp?.({ downForMs, refused }); } catch (error) { log.error?.("database: onUp", error); }
            } catch {
                probe();
            }
        }, probeMs);
        timer.unref?.();
    }
    function down(error) {
        if (since !== null) return;
        since = Date.now();
        refused = 0;
        log.warn?.(`database: unreachable (${error?.code ?? error?.message ?? error}); refusing calls until it answers again`);
        try { onDown?.(error); } catch (e) { log.error?.("database: onDown", e); }
        probe();
    }
    function refuse(unknown = false) {
        refused += 1;
        throw refusal(unknown);
    }
    // Whether this failure is the database gone, rather than its pool full.
    async function gone(error) {
        if (!reaches || !POOL_WAIT.test(String(error?.message ?? ""))) return true;
        try { return !(await reaches()); } catch { return true; }
    }
    const busy = () => { throw Object.assign(new Error(BUSY), { expose: true, status: 503, code: "db.busy", retry: true }); };

    return {
        async query(sql, params) {
            if (since !== null) refuse();
            try {
                return await db.query(sql, params);
            } catch (error) {
                if (!unreachable(error)) throw error;
                if (!(await gone(error))) return busy();
                down(error);
                return refuse();
            }
        },
        async transaction(fn) {
            if (since !== null) refuse();
            // Whether the transaction's work is done and only COMMIT remains: a loss past this point
            // leaves the outcome unknown.
            let committing = false;
            try {
                return await db.transaction(async (tx) => {
                    const out = await fn(tx);
                    committing = true;
                    return out;
                });
            } catch (error) {
                if (!unreachable(error)) throw error;
                // A pool wait is before the transaction began: nothing was sent, so nothing is unknown.
                if (!committing && !(await gone(error))) return busy();
                down(error);
                return refuse(committing);
            }
        },
        state: () => ({ state: since === null ? "up" : "down", since: since === null ? null : new Date(since).toISOString(), refused }),
        stop() { clearTimeout(timer); timer = null; },
    };
}
