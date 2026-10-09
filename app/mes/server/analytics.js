// Analytics, phase 1 (DESIGN.md §22): state intervals and what they answer.
//
// A state interval is one stay of a record in a state: when it entered, when it left, who moved it
// and by which action. The write services (services.js) write them in the transaction of every
// create, transition, archive and restore, so they never disagree with the records. Archiving closes
// the current stay (an archived record spends no time in a state); restoring opens a new one.
// Records written before intervals existed get theirs rebuilt from the audit trail, which holds every
// transition with its time (`rebuildIntervals`).
//
// An object's design may name dimensions (`analytics.dimensions`): fields copied into each interval
// when it opens, so a report groups by the value the record had then, not today's, and never joins
// into JSONB.
//
// The services answer, for one object and a period:
//   analytics.timeline   one record's stays, in order
//   analytics.states     for each state: records in it now (and how long they have been), and the
//                        stays that ended in the period (count, average, median, 90th percentile)
//   analytics.leadTime   the time from a record's first entry into one state to its first entry into
//                        another after it, for records that reached the second in the period; by a
//                        dimension if asked; with the slowest records
//   analytics.entries    records entering a state per day, week or month (lots released per day)
//
// Who may see (O50 is open): a person holding a role on the object; a dimension only if they may read
// that field in every state.
import { fail } from "@opencore-mes/juris-kit/errors.js";
import { accessSql } from "./record-sql.js";
import { decide, mask } from "./policy.js";
import { isSensitive } from "../client/definition.js";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,47}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_MS = 86_400_000;
const MAX_PERIOD_DAYS = 400;
const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
const num = (v) => (v === null || v === undefined ? null : Number(v));

// ---- writing intervals (inside a record write's transaction) ------------------------------------

// The dimensions an interval copies from the record's data: plain values only, and never a sensitive
// field's (§6.10; a design cannot name one, and one made sensitive since is no longer copied).
export function dimsOf(definition, data) {
    const out = {};
    for (const name of definition?.analytics?.dimensions ?? []) {
        if (isSensitive(definition, name)) continue;
        const v = data?.[name];
        if (v !== undefined && v !== null && typeof v !== "object") out[name] = v;
    }
    return out;
}

export async function openInterval(tx, { object, recordId, state, by, action, dims = {} }) {
    await tx.query(
        `INSERT INTO mes.state_intervals (object, record_id, state, entered_at, entered_by, enter_action, dims)
         VALUES ($1, $2, $3, clock_timestamp(), $4, $5, $6)`,
        [object, recordId, state, by, action, JSON.stringify(dims)],
    );
}

export async function closeInterval(tx, { object, recordId, by, action }) {
    await tx.query(
        `UPDATE mes.state_intervals SET left_at = clock_timestamp(), left_by = $3, leave_action = $4
         WHERE object = $1 AND record_id = $2 AND left_at IS NULL`,
        [object, recordId, by, action],
    );
}

// ---- rebuilding them from the audit trail -------------------------------------------------------

// One record's intervals from its audit rows, oldest first ({ at, actor, action, before, after }).
// The record's data is replayed as it went (create, then each update), so the dimensions are the
// values it had when each stay began. Pure: tested without a database.
export function intervalsFromAudit(rows, dimensions = []) {
    const out = [];
    let open = null;
    let state = null;
    let data = {};
    const dims = () => Object.fromEntries(dimensions.filter((d) => data[d] !== undefined && data[d] !== null && typeof data[d] !== "object").map((d) => [d, data[d]]));
    const start = (at, by, action) => { open = { state, entered_at: at, entered_by: by, enter_action: action, left_at: null, left_by: null, leave_action: null, dims: dims() }; out.push(open); };
    const end = (at, by, action) => { if (open) Object.assign(open, { left_at: at, left_by: by, leave_action: action }); open = null; };
    for (const r of rows) {
        const at = iso(r.at);
        if (r.action === "create") {
            const { state: s, ...rest } = r.after ?? {};
            data = { ...rest };
            state = s ?? null;
            if (state) start(at, r.actor, "create");
        } else if (r.action === "update") {
            data = { ...data, ...(r.after ?? {}) };
        } else if (r.action.startsWith("transition:")) {
            end(at, r.actor, r.action.slice(11));
            state = r.after?.state ?? state;
            start(at, r.actor, r.action.slice(11));
        } else if (r.action === "archive") {
            end(at, r.actor, "archive");
        } else if (r.action === "restore") {
            if (!open && state) start(at, r.actor, "restore");
        }
    }
    return out;
}

// Rebuilds every object's intervals (or one object's) from the audit trail, in one transaction. A
// record with no audit history is given one open stay from its creation, in its state.
export async function rebuildIntervals(db, definitions, { only = null } = {}) {
    let written = 0;
    // Its own transaction, or the caller's (a migration's) when given one.
    const inTransaction = typeof db.transaction === "function" ? (fn) => db.transaction(fn) : (fn) => fn(db);
    await inTransaction(async (tx) => {
        for (const def of definitions) {
            const object = def.object;
            if (only && only !== object) continue;
            await tx.query("DELETE FROM mes.state_intervals WHERE object = $1", [object]);
            const rows = await tx.query(
                `SELECT record_id, at, actor, action, before, after FROM mes.audit_log
                 WHERE object = $1 AND record_id IS NOT NULL
                   AND (action IN ('create', 'update', 'archive', 'restore') OR action LIKE 'transition:%')
                 ORDER BY seq`,
                [object],
            );
            const byRecord = new Map();
            for (const r of rows) byRecord.set(r.record_id, [...(byRecord.get(r.record_id) ?? []), r]);
            const intervals = [];
            for (const [recordId, history] of byRecord) for (const i of intervalsFromAudit(history, def.analytics?.dimensions ?? [])) intervals.push({ object, record_id: recordId, ...i });
            if (intervals.length) {
                await tx.query(
                    `INSERT INTO mes.state_intervals (object, record_id, state, entered_at, entered_by, enter_action, left_at, left_by, leave_action, dims)
                     SELECT object, record_id, state, entered_at, entered_by, enter_action, left_at, left_by, leave_action, dims
                     FROM jsonb_to_recordset($1::jsonb) AS x(object text, record_id uuid, state text, entered_at timestamptz, entered_by text, enter_action text,
                                                               left_at timestamptz, left_by text, leave_action text, dims jsonb)`,
                    [JSON.stringify(intervals)],
                );
            }
            // Records the audit trail says nothing about: one open stay, from their creation.
            const bare = await tx.query(
                `INSERT INTO mes.state_intervals (object, record_id, state, entered_at, entered_by, enter_action, dims)
                 SELECT r.object, r.id, r.state, r.created_at, r.created_by, 'create', '{}'::jsonb FROM mes.records r
                 WHERE r.object = $1 AND r.archived_at IS NULL
                   AND NOT EXISTS (SELECT 1 FROM mes.state_intervals i WHERE i.object = r.object AND i.record_id = r.id)
                 RETURNING record_id`,
                [object],
            );
            written += intervals.length + bare.length;
        }
    });
    return written;
}

// ---- the services ---------------------------------------------------------------------------

export function createAnalytics({ store, plantTz = "UTC", certificationsOf = async () => [] }) {
    const { db } = store;
    const read = (sql, params) => store.read(sql, params);

    // Who is asking, their roles on the object, and its definition; refused unless they hold one.
    async function viewer(self, object) {
        const user = await store.userForSession(self?.sessionId);
        if (!user) fail("Sign in first.", { status: 401 });
        if (typeof object !== "string" || !IDENTIFIER.test(object)) fail("Unknown object.", { status: 404 });
        const def = await store.definition(object);
        const roles = def ? await store.rolesFor(user.id, object) : [];
        if (!def || !roles.length) fail("Unknown object.", { status: 404 });
        // The actor as the record services know them (their departments too: a policy may read them).
        const actor = { id: user.id, name: user.name, roles, departments: await store.departmentsOf(user.id), certifications: await certificationsOf(user.id) };
        // The records the object's access reserves from them (§9.9) are in no figure: a count of them is
        // not theirs to read either. (Other records count whatever their policies, §22.6, O50.)
        const reserved = accessSql(def.body, actor, "r");
        const only = reserved === "true" ? "" : ` AND record_id IN (SELECT r.id FROM mes.records r WHERE r.object = $1 AND ${reserved ?? "false"})`;
        return { user, actor, def: def.body, only };
    }
    // A dimension the viewer may group by: one the design names, readable to them in every state.
    function dimension(v, by) {
        if (by === undefined || by === null || by === "") return null;
        if (!(v.def.analytics?.dimensions ?? []).includes(by)) fail(`"${by}" is not one of ${v.def.label}'s analytics dimensions (${(v.def.analytics?.dimensions ?? []).join(", ") || "none"}).`, { fields: { by: "Not a dimension." } });
        const hidden = (v.def.states?.list ?? []).some((state) => !decide(v.def, v.actor, { state }).fields[by]);
        if (hidden) fail(`You may not read ${v.def.fields[by]?.label ?? by} in every state, so you cannot group by it.`, { status: 403, fields: { by: "Not readable to you everywhere." } });
        return by;
    }
    function state(v, name, what) {
        if (!(v.def.states?.list ?? []).includes(name)) fail(`${what}: "${name ?? ""}" is not a state of ${v.def.label}.`, { fields: { [what]: "Not a state." } });
        return name;
    }
    function period({ from, to } = {}) {
        const end = to ? Date.parse(to) : Date.now();
        const start = from ? Date.parse(from) : end - 30 * DAY_MS;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) fail("The period is from a date to a later one.", { fields: { from: "Check the dates." } });
        if (end - start > MAX_PERIOD_DAYS * DAY_MS) fail(`At most ${MAX_PERIOD_DAYS} days at a time.`, { fields: { from: "Too long." } });
        return [new Date(start).toISOString(), new Date(end).toISOString()];
    }
    const stats = (r) => ({ count: Number(r.count), avg: num(r.avg), p50: num(r.p50), p90: num(r.p90), min: num(r.min), max: num(r.max) });
    const STATS = `count(*) AS count, avg(secs) AS avg, percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) AS p50,
                   percentile_cont(0.9) WITHIN GROUP (ORDER BY secs) AS p90, min(secs) AS min, max(secs) AS max`;

    const services = {
        async "analytics.timeline"({ object, id } = {}) {
            const v = await viewer(this, object);
            if (typeof id !== "string" || !UUID.test(id)) fail("Not found.", { status: 404 });
            const [row] = await read("SELECT * FROM mes.records WHERE object = $1 AND id = $2", [object, id]);
            if (!row || !decide(v.def, v.actor, { ...row.data, id: row.id, state: row.state, type: row.type }).read) fail("Not found.", { status: 404 });
            const stays = await read(
                `SELECT state, entered_at, left_at, entered_by, left_by, enter_action, leave_action,
                        extract(epoch FROM coalesce(left_at, clock_timestamp()) - entered_at) AS secs
                 FROM mes.state_intervals WHERE object = $1 AND record_id = $2 ORDER BY entered_at, id`,
                [object, id],
            );
            return stays.map((s) => ({ ...s, entered_at: iso(s.entered_at), left_at: iso(s.left_at), secs: num(s.secs), open: s.left_at === null }));
        },

        async "analytics.states"({ object, from, to, by } = {}) {
            const v = await viewer(this, object);
            const dim = dimension(v, by);
            const [start, end] = period({ from, to });
            const group = dim ? ", dims->>$4" : "";
            const params = dim ? [object, start, end, dim] : [object, start, end];
            const done = await read(
                `SELECT state${dim ? ", dims->>$4 AS value" : ""}, ${STATS} FROM (
                   SELECT state, dims, extract(epoch FROM left_at - entered_at) AS secs FROM mes.state_intervals
                   WHERE object = $1 AND left_at >= $2 AND left_at < $3${v.only}) s
                 GROUP BY state${group}`,
                params,
            );
            const now = await read(
                `SELECT state${dim ? ", dims->>$2 AS value" : ""}, count(*) AS count, avg(extract(epoch FROM clock_timestamp() - entered_at)) AS age,
                        max(extract(epoch FROM clock_timestamp() - entered_at)) AS oldest
                 FROM mes.state_intervals WHERE object = $1 AND left_at IS NULL${v.only} GROUP BY state${dim ? ", dims->>$2" : ""}`,
                dim ? [object, dim] : [object],
            );
            return {
                object, from: start, to: end, by: dim, states: v.def.states.list,
                now: now.map((r) => ({ state: r.state, ...(dim ? { value: r.value } : {}), count: Number(r.count), avgAge: num(r.age), oldest: num(r.oldest) })),
                stays: done.map((r) => ({ state: r.state, ...(dim ? { value: r.value } : {}), ...stats(r) })),
            };
        },

        async "analytics.leadTime"({ object, fromState, toState, from, to, by } = {}) {
            const v = await viewer(this, object);
            state(v, fromState, "fromState");
            state(v, toState, "toState");
            if (fromState === toState) fail("Pick two different states.", { fields: { toState: "The same state." } });
            const dim = dimension(v, by);
            const [start, end] = period({ from, to });
            const title = v.def.titleField;
            const params = [object, fromState, toState, start, end, ...(dim ? [dim] : [])];
            const base = `
                WITH a AS (SELECT record_id, min(entered_at) AS t0 FROM mes.state_intervals WHERE object = $1 AND state = $2${v.only} GROUP BY record_id),
                     b AS (SELECT i.record_id, min(i.entered_at) AS t1 FROM mes.state_intervals i JOIN a ON a.record_id = i.record_id
                           WHERE i.object = $1 AND i.state = $3 AND i.entered_at >= a.t0 GROUP BY i.record_id),
                     d AS (SELECT a.record_id, extract(epoch FROM b.t1 - a.t0) AS secs, b.t1,
                                  (SELECT dims FROM mes.state_intervals x WHERE x.object = $1 AND x.record_id = a.record_id AND x.state = $2 AND x.entered_at = a.t0 LIMIT 1) AS dims
                           FROM a JOIN b ON b.record_id = a.record_id WHERE b.t1 >= $4 AND b.t1 < $5)`;
            const [all] = await read(`${base} SELECT ${STATS} FROM d`, params.slice(0, 5));
            const groups = dim ? await read(`${base} SELECT dims->>$6 AS value, ${STATS} FROM d GROUP BY 1 ORDER BY 1`, params) : [];
            // The slowest the viewer may read: each is a record's id and title, so it is shown as their
            // policies show the record itself (the figures above are of all of them, §22: open, O50).
            const candidates = await read(
                `${base} SELECT d.secs, d.t1, r.* FROM d JOIN mes.records r ON r.object = $1 AND r.id = d.record_id ORDER BY d.secs DESC LIMIT 100`,
                params.slice(0, 5),
            );
            const slowest = [];
            for (const r of candidates) {
                const seen = mask(v.def, v.actor, r);
                if (seen) slowest.push({ record_id: r.id, secs: r.secs, t1: r.t1, title: title ? seen[title] ?? null : null });
                if (slowest.length === 5) break;
            }
            return {
                object, fromState, toState, from: start, to: end, by: dim,
                all: stats(all),
                groups: groups.map((r) => ({ value: r.value, ...stats(r) })),
                slowest: slowest.map((r) => ({ id: r.record_id, title: r.title, secs: num(r.secs), reachedAt: iso(r.t1) })),
            };
        },

        async "analytics.entries"({ object, state: into, bucket = "day", from, to, by } = {}) {
            const v = await viewer(this, object);
            state(v, into, "state");
            if (!["day", "week", "month"].includes(bucket)) fail("A bucket is a day, a week or a month.", { fields: { bucket: "day, week or month" } });
            const dim = dimension(v, by);
            const [start, end] = period({ from, to });
            // Buckets in the plant's time zone; a restore is not an entry.
            const params = [object, into, start, end, bucket, plantTz, ...(dim ? [dim] : [])];
            const rows = await read(
                `SELECT to_char(date_trunc($5, entered_at AT TIME ZONE $6), 'YYYY-MM-DD') AS bucket${dim ? ", dims->>$7 AS value" : ""}, count(*) AS count
                 FROM mes.state_intervals WHERE object = $1 AND state = $2 AND entered_at >= $3 AND entered_at < $4
                   AND enter_action IS DISTINCT FROM 'restore'${v.only}
                 GROUP BY 1${dim ? ", 2" : ""} ORDER BY 1`,
                params,
            );
            return { object, state: into, bucket, from: start, to: end, by: dim, plantTz, rows: rows.map((r) => ({ bucket: r.bucket, ...(dim ? { value: r.value } : {}), count: Number(r.count) })) };
        },
    };
    const touches = Object.fromEntries(Object.keys(services).map((n) => [n, []]));
    return { services, touches };
}
