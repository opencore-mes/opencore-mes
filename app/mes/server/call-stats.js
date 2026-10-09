// The platform's calls, measured (DESIGN.md §38.1), as sql-stats.js measures its statements: every call of a
// service the platform serves (records.update, a live query), and of each design that answers a call (a
// service, a transaction, its preview, a named query) by its own name and by how it was called: from a page,
// a live query, over the web (/svc/v1), by an AI's token, a service's script, a route, a trigger, a schedule, a
// screen's table, a reference's choices, a plan. Counted per hour, instance, kind, name and channel: calls,
// how many answered, were refused and failed, total and slowest time, the times in fixed buckets (so a
// percentile adds up across instances and hours), who called (at most CALLERS each, the rest as "others") and
// why each refusal was (its code, a stable identifier: never its words, which may name a record). No input,
// no value: they are records' data. Counted in memory, written to mes.call_stats once a minute by each instance
// (`flush`), kept KEEP_DAYS (more than the 30 days a change's callers are looked for, http-apis).
//
// A design's statements are put down to it (`within`: sql-stats' source), as "transaction:fab_move_in",
// so the Database area says which statements a design sends, and how much of its time they are.
//
//   const calls = createCallStats({ within })      within: sql-stats' (source, fn) → fn's result
//   calls.measure({ kind, name, channel, who? }, fn)  runs fn, counted; anything it calls is inside it
//   calls.note({ who })                           what the calls running now learn (who it is for)
//   calls.outcome({ status, code })              how the innermost ended, when it answers rather than throws (the web)
//   calls.flush(db, instance)                     writes what was counted
import { AsyncLocalStorage } from "node:async_hooks";
import { CALL_KIND } from "@opencore-mes/juris-kit/live-protocol.js";

export const KINDS = ["platform", "service", "transaction", "preview", "query"];
// The upper bounds of the time buckets, in ms; the last holds everything slower.
export const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, Infinity];
const MAX_KEYS = 2000;    // kind, name and channel kept per hour, per instance; beyond, one "other"
const CALLERS = 50;       // callers kept per key and hour; beyond, "others"
const CODES = 20;         // refusal codes kept per key and hour; beyond, "other"
export const KEEP_DAYS = 35;

const hourOf = (ms) => new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString();
export const bucketOf = (ms) => BUCKETS.findIndex((b) => ms <= b);

// How a platform service was called, from its call's `this` (the Juris kernel's kind): a page's own call
// (an AI's when its token stands for the person), a live query, a page drawn on the server; one service
// calling another inside the server says its own origin.
export function channelOf(self) {
    const kind = self?.[CALL_KIND];
    if (kind === "direct") return self?.apiUser ? "ai" : "page";
    if (kind === "live") return "live";
    if (kind === "preload") return "page";
    if (self?.origin?.http) return "web";
    if (Array.isArray(self?.origin?.chain) && self.origin.chain.length) return "service";
    if (String(self?.user?.id ?? "").startsWith("flow:")) return "route";
    return "internal";
}

// The outcome of a call that threw: refused (the caller's to read: a 4xx, a ServiceError) or failed.
export const refusedBy = (error) => {
    const status = Number(error?.status);
    return Number.isInteger(status) ? status >= 400 && status < 500 : error?.expose === true && !error?.fault;
};

// A percentile from bucket counts: the upper bound of the bucket it falls in (Infinity: past the last).
export function percentile(buckets, p) {
    const total = (buckets ?? []).reduce((a, b) => a + Number(b), 0);
    if (!total) return null;
    let seen = 0;
    for (const [i, n] of buckets.entries()) { seen += Number(n); if (seen >= total * p) return BUCKETS[i]; }
    return Infinity;
}

export function createCallStats({ within = (source, fn) => fn(), now = () => Date.now() } = {}) {
    const context = new AsyncLocalStorage();
    let counts = new Map();
    const take = (kind, name, channel) => {
        const hour = hourOf(now());
        let id = `${hour}|${kind}|${name}|${channel}`;
        if (counts.size >= MAX_KEYS && !counts.has(id)) id = `${hour}|${kind}|other|${channel}`;
        let c = counts.get(id);
        if (!c) {
            const [, , n] = id.split("|");
            counts.set(id, (c = { hour, kind, name: n, channel, calls: 0, ok: 0, refused: 0, failed: 0, ms: 0, max: 0, buckets: BUCKETS.map(() => 0), callers: new Map(), codes: new Map() }));
        }
        return c;
    };
    const bump = (map, key, cap, rest) => { const k = map.has(key) || map.size < cap ? key : rest; map.set(k, (map.get(k) ?? 0) + 1); };

    // Runs fn with its call counted. A design's statements are put down to it (`kind:name`); a platform
    // service's are already put down to its own name by whoever measures it (app.mjs).
    function measure({ kind, name, channel = "internal", who = null }, fn) {
        if (!KINDS.includes(kind) || typeof name !== "string" || !name) return fn();
        const note = { who, status: null, code: null, parent: context.getStore() ?? null };
        const began = performance.now();
        const run = () => context.run(note, () => (kind === "platform" ? fn() : within(`${kind}:${name}`, fn)));
        const done = (error) => {
            const ms = performance.now() - began;
            const c = take(kind, name, channel);
            c.calls += 1;
            c.ms += ms;
            if (ms > c.max) c.max = ms;
            c.buckets[bucketOf(ms)] += 1;
            // What it answered (the web: a status, not a throw) or what it threw.
            const said = !error && Number.isInteger(note.status) && note.status >= 400 ? { status: note.status, code: note.code, expose: true } : error;
            if (!said) c.ok += 1;
            else if (refusedBy(said)) { c.refused += 1; bump(c.codes, String(said.code ?? said.status ?? "refused").slice(0, 60), CODES, "other"); }
            else c.failed += 1;
            if (note.who) bump(c.callers, String(note.who).slice(0, 120), CALLERS, "others");
        };
        let out;
        try { out = run(); } catch (error) { done(error); throw error; }
        if (out && typeof out.then === "function") return out.then((v) => { done(null); return v; }, (e) => { done(e); throw e; });
        done(null);
        return out;
    }
    // Who the calls running now are for, once it is known (the person a session names, a token's): told to the
    // innermost and every call around it that does not know yet.
    function note({ who } = {}) {
        for (let n = context.getStore(); n; n = n.parent) if (who && !n.who) n.who = who;
    }
    function outcome({ status, code = null } = {}) {
        const n = context.getStore();
        if (n && Number.isInteger(status)) { n.status = status; n.code = code; }
    }
    // Written as each hour's sums (added to what other instances and earlier flushes wrote), then cleared.
    async function flush(db, instance = "local") {
        if (!counts.size) return 0;
        const taken = counts;
        counts = new Map();
        const merge = (col) => `(SELECT jsonb_object_agg(k, COALESCE((mes.call_stats.${col}->>k)::bigint, 0) + COALESCE((EXCLUDED.${col}->>k)::bigint, 0)) FROM (SELECT jsonb_object_keys(mes.call_stats.${col} || EXCLUDED.${col}) AS k) x)`;
        return within("call-stats", async () => {
            for (const c of taken.values()) {
                await db.query(
                    `INSERT INTO mes.call_stats (hour, kind, name, channel, instance, calls, ok, refused, failed, total_ms, max_ms, buckets, callers, codes)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                     ON CONFLICT (hour, kind, name, channel, instance) DO UPDATE SET calls = mes.call_stats.calls + EXCLUDED.calls, ok = mes.call_stats.ok + EXCLUDED.ok,
                       refused = mes.call_stats.refused + EXCLUDED.refused, failed = mes.call_stats.failed + EXCLUDED.failed, total_ms = mes.call_stats.total_ms + EXCLUDED.total_ms,
                       max_ms = GREATEST(mes.call_stats.max_ms, EXCLUDED.max_ms),
                       buckets = (SELECT array_agg(COALESCE(a, 0) + COALESCE(b, 0) ORDER BY i) FROM unnest(mes.call_stats.buckets, EXCLUDED.buckets) WITH ORDINALITY AS u(a, b, i)),
                       callers = ${merge("callers")}, codes = ${merge("codes")}`,
                    [c.hour, c.kind, c.name, c.channel, instance, c.calls, c.ok, c.refused, c.failed, c.ms, c.max, c.buckets, JSON.stringify(Object.fromEntries(c.callers)), JSON.stringify(Object.fromEntries(c.codes))]);
            }
            await db.query(`DELETE FROM mes.call_stats WHERE hour < now() - interval '${KEEP_DAYS} days'`);
            return taken.size;
        });
    }
    // What this instance has counted and not yet written (tests, and the area's "this hour, not yet written").
    const pending = () => [...counts.values()].map((c) => ({ ...c, buckets: [...c.buckets], callers: Object.fromEntries(c.callers), codes: Object.fromEntries(c.codes) }));
    return { measure, note, outcome, flush, pending };
}
