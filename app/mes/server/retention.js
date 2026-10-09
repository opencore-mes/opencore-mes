// Data retention and erasure (DESIGN.md §27.8; COMPLIANCE.md G11):
//   the purge     on the instance that schedules, every few hours: what is past the plant's period is
//                 removed, kind by kind (client/retention.js RETENTION_KINDS), a bounded number of rows
//                 per run, all in one transaction with its summary in the audit trail (counts per kind,
//                 never contents) and, once committed, in the event log. Records and the audit trail
//                 are never removed: their period is counted only.
//   the report    for privacy officers (People & departments, `privacy`): the periods in force, what would
//                 go now ("what would go"), and the last runs; and the purge run now.
//   erasure       records.erase: a person's personal data taken out of one record, only the fields its
//                 object's design marks erasable, each replaced by a tombstone ("[erased]", or emptied);
//                 the record, its state and its history stay. The audit entry says which fields were
//                 erased, by whom and why, never what they held. Not a record change through the
//                 object's policies and rule pipe: a legal obligation the object's own rules (a released
//                 lot is locked) must not refuse, so it is a role of its own, every use audited.
import { fail } from "@opencore-mes/juris-kit/errors.js";
import { appendAudit } from "./audit.js";
import { organizationSettings } from "./organization.js";
import { managedOf } from "../client/builtins.js";
import { RETENTION_KINDS, KIND, periodsOf, cutoffOf, periodWords, erasableFields, tombstoneOf, isErased } from "../client/retention.js";
import { platformWrites, resealRecords } from "./integrity.js";

export const OFFICER = "officer";
export const PURGE_ACTOR = "platform:retention";
export const RUN_EVERY_MS = 6 * 60 * 60_000;
// One run removes at most this many rows of a kind (each table of it), so a first run on a plant with
// years behind it does not hold its transaction for long; the next run goes on.
export const MOST_PER_RUN = 50_000;
// "What would go" counts up to this, then says "more than".
export const COUNT_CAP = 100_000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (t) => (t instanceof Date ? t.toISOString() : t ?? null);

// What each kind is in the database: its tables (alias t), and what of them is past the cutoff ($1).
// Only the kinds the platform purges are deleted; records and the audit trail are counted.
const TABLES = {
    records: [{ table: "mes.records", where: "t.archived_at IS NOT NULL AND t.archived_at < $1" }],
    audit: [{ table: "mes.audit_log", where: "t.at < $1" }],
    // Each instance's last event stays, so its numbering goes on after a restart (event-log.js).
    events: [{ table: "mes.event_log", where: "t.at < $1 AND t.seq < (SELECT max(y.seq) FROM mes.event_log y WHERE y.instance = t.instance)" }],
    // One under way is never taken from under its copilot.
    conversations: [
        { table: "mes.copilot_conversations", where: "t.updated_at < $1 AND NOT t.running" },
        { table: "mes.analyst_conversations", where: "t.updated_at < $1 AND NOT t.running" },
    ],
    // A kept prompt with a schedule is in use, however long between its runs.
    saved: [
        { table: "mes.sandbox_selections", where: "t.updated_at < $1" },
        { table: "mes.report_prompts", where: "greatest(t.updated_at, coalesce(t.last_at, t.updated_at)) < $1 AND t.next_at IS NULL AND NOT t.running" },
    ],
    sign_in: [
        { table: "mes.sessions", where: "t.expires_at < $1" },
        { table: "mes.password_tokens", where: "coalesce(t.used_at, t.expires_at) < $1" },
        { table: "mes.sign_in_pending", where: "t.expires_at < $1" },
        { table: "mes.oidc_states", where: "t.expires_at < $1" },
        { table: "mes.session_reauth", where: "t.at < $1" },
    ],
    integration: [{ table: "mes.integration_outbox", where: "t.state IN ('done', 'rejected', 'dead') AND coalesce(t.done_at, t.created_at) < $1" }],
    answers: [{ table: "mes.idempotency", where: "t.at < $1" }],
};

// The periods in force, from the published organization.
export async function periodsNow(q) {
    return periodsOf((await organizationSettings(q)).retention);
}

// What is past each kind's period now: { kind: { count, capped } } (count 0 for a kind kept forever).
export async function pastPeriods(q, periods, now = Date.now()) {
    const out = {};
    for (const k of RETENTION_KINDS) {
        const cutoff = cutoffOf(periods[k.key], now);
        let count = 0;
        let capped = false;
        if (cutoff) {
            for (const { table, where } of TABLES[k.key]) {
                const [row] = await q.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM ${table} t WHERE ${where} LIMIT ${COUNT_CAP + 1}) x`, [cutoff]);
                count += row.n;
                if (row.n > COUNT_CAP) capped = true;
            }
        }
        out[k.key] = { count: Math.min(count, COUNT_CAP), capped: capped || count > COUNT_CAP };
    }
    return out;
}

// One run of the purge, in one transaction: → { skipped } when another is under way, else the run's row
// ({ id, at, by, periods, counts, more }). `by`: platform:retention, or the person who ran it now.
export async function purge(db, { by = PURGE_ACTOR, instance = null, events = null, now = Date.now(), most = MOST_PER_RUN } = {}) {
    const result = await db.transaction(async (tx) => {
        const [lock] = await tx.query("SELECT pg_try_advisory_xact_lock(hashtext('mes.retention')) AS ok");
        if (!lock.ok) return { skipped: true };
        const periods = await periodsNow(tx);
        // The event log's copy lets this transaction, and only it, delete what is past a year (§7.6).
        await tx.query("SET LOCAL mes.retention_purge = 'on'");
        const counts = {};
        const failed = [];
        let more = false;
        for (const k of RETENTION_KINDS.filter((x) => x.purged)) {
            const cutoff = cutoffOf(periods[k.key], now);
            if (!cutoff) continue;
            // A kind that cannot be purged (a table refusing it) is named in the run, and the others go on.
            await tx.query("SAVEPOINT retention_kind");
            try {
                let n = 0;
                for (const { table, where } of TABLES[k.key]) {
                    const gone = await tx.query(`DELETE FROM ${table} WHERE ctid IN (SELECT t.ctid FROM ${table} t WHERE ${where} LIMIT ${most}) RETURNING 1`, [cutoff]);
                    n += gone.length;
                    if (gone.length === most) more = true;
                }
                await tx.query("RELEASE SAVEPOINT retention_kind");
                if (n) counts[k.key] = n;
            } catch (error) {
                await tx.query("ROLLBACK TO SAVEPOINT retention_kind");
                failed.push(`${k.label}: ${error.message}`);
            }
        }
        const error = failed.length ? `Not purged: ${failed.join("; ")}.`.slice(0, 1000) : null;
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        // A run that removed nothing is kept a week (the report's "last checked"); one that did, as long
        // as the event log (its summary is in the audit trail as well).
        await tx.query("DELETE FROM mes.retention_runs WHERE at < now() - interval '7 days' AND counts = '{}'::jsonb AND by = $1", [PURGE_ACTOR]);
        const [run] = await tx.query("INSERT INTO mes.retention_runs (by, instance, periods, counts, more, error) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, at, by, periods, counts, more, error", [by, instance, JSON.stringify(periods), JSON.stringify(counts), more, error]);
        // In the audit trail when it removed something, a kind failed, or a person ran it: in numbers.
        if (total || error || by !== PURGE_ACTOR) await appendAudit(tx, { actor: by, object: "$retention", action: "purge", after: { run: Number(run.id), counts, periods, ...(more ? { more: true } : {}), ...(error ? { error } : {}) } });
        return { ...run, id: Number(run.id), at: iso(run.at), total };
    });
    if (!result.skipped && (result.total || result.error || by !== PURGE_ACTOR)) {
        events?.emit?.("retention.purged", { severity: result.error ? "error" : "info", message: `${result.total ? `Retention removed ${summary(result.counts)}${result.more ? "; more next run" : ""}.` : "Retention found nothing past its period."}${result.error ? ` ${result.error}` : ""}`, details: { run: result.id, by, counts: result.counts, ...(result.more ? { more: true } : {}), ...(result.error ? { error: result.error } : {}) } });
    }
    return result;
}

// "AI conversations 12, Integration runs 3".
export const summary = (counts) => Object.entries(counts ?? {}).map(([k, n]) => `${KIND[k]?.label ?? k} ${n}`).join(", ") || "nothing";

export function createRetention({ store, records, events = null, instance = null }) {
    const { db } = store;
    const officer = async (self) => {
        const user = await store.userForSession(self?.sessionId);
        if (!user) fail("Sign in first.", { status: 401 });
        if (!(await store.rolesFor(user.id, "privacy")).includes(OFFICER)) fail("Data retention and erasure are for those People & departments makes privacy officers (Roles, Privacy).", { status: 403 });
        return user;
    };
    const definitionOf = async (object) => {
        const def = await store.definition(object);
        if (!def) fail("Unknown object.", { status: 404 });
        return def;
    };

    const services = {
        // The periods in force, what is past them now, and the last runs.
        async "retention.report"() {
            await officer(this);
            const settings = await organizationSettings(db);
            const periods = periodsOf(settings.retention);
            const past = await pastPeriods(db, periods);
            const runs = await db.query("SELECT id, at, by, counts, more, error FROM mes.retention_runs ORDER BY at DESC, id DESC LIMIT 20");
            return {
                version: settings.version,
                kinds: RETENTION_KINDS.map((k) => ({ key: k.key, label: k.label, what: k.what, purged: k.purged, days: periods[k.key], words: periodWords(periods[k.key]), set: settings.retention?.[k.key] !== undefined, cutoff: cutoffOf(periods[k.key]), ...past[k.key] })),
                runs: runs.map((r) => ({ id: Number(r.id), at: iso(r.at), by: r.by, counts: r.counts, more: r.more, error: r.error })),
                every: RUN_EVERY_MS,
            };
        },
        // The purge, now, as the officer: the same run the schedule makes, in the audit trail by them.
        async "retention.run"() {
            const user = await officer(this);
            const run = await purge(db, { by: user.id, instance, events });
            if (run.skipped) fail("A purge is under way already: look again in a minute.", { status: 409 });
            return run;
        },
        // Finding the record to erase: the objects with fields marked erasable, or that object's records
        // whose title or an erasable field holds what is typed (or whose id it is), 20 at most.
        async "retention.find"({ object, q = "" } = {}) {
            await officer(this);
            if (object === undefined || object === null || object === "") {
                const defs = (await store.allDefinitions()).filter(Boolean);
                return { objects: defs.map((d) => ({ object: d.body.object, label: d.body.label ?? d.body.object, fields: erasableFields(d.body).map((f) => ({ name: f, label: d.body.fields[f]?.label ?? f })) })).filter((o) => o.fields.length) };
            }
            const def = await definitionOf(object);
            const fields = erasableFields(def.body);
            const text = String(q ?? "").trim().slice(0, 80);
            if (!text) return { rows: [] };
            const searched = [...new Set([def.body.titleField, ...fields].filter(Boolean))];
            const rows = await db.query(
                `SELECT id, data, archived_at FROM mes.records
                 WHERE object = $1 AND (id::text = $2 OR EXISTS (SELECT 1 FROM unnest($3::text[]) f WHERE data->>f ILIKE '%' || $4 || '%'))
                 ORDER BY updated_at DESC LIMIT 20`,
                [object, ID.test(text) ? text.toLowerCase() : "", searched, text.replace(/[%_\\]/g, (c) => `\\${c}`)],
            );
            return {
                rows: rows.map((r) => ({
                    id: r.id, title: def.body.titleField ? String(r.data?.[def.body.titleField] ?? r.id) : r.id, archived: Boolean(r.archived_at),
                    // Which personal fields still hold something (never what).
                    holding: fields.filter((f) => !isErased(def.body.fields[f], r.data?.[f])),
                })),
            };
        },
        // A person's personal data out of one record (§27.8): the fields named (by default every erasable
        // one), each replaced by its tombstone, in one transaction with its audit entry. Requests to change
        // the record (§28) lose the same values; one still waiting is void. Answers kept for retries that
        // carry the record are dropped. Earlier audit entries keep what they recorded, inside the audit
        // trail's period (append-only, §7.3): what the law keeps for its own obligations (GDPR art. 17(3)).
        async "records.erase"({ object, id, fields, reason, key } = {}) {
            const user = await officer(this);
            if (typeof reason !== "string" || !reason.trim()) fail("Say why (the request it answers, its reference).", { fields: { reason: "Required." } });
            if (typeof id !== "string" || !ID.test(id)) fail("Not found.", { status: 404 });
            const def = await definitionOf(object);
            const label = def.body.label ?? object;
            const erasable = erasableFields(def.body);
            if (!erasable.length) fail(`Nothing on a ${label.toLowerCase()} is marked as personal data to erase: its design says which fields are (a field's "erasable"), through a change approved by their stewards.`, { status: 409 });
            if (fields !== undefined && !(Array.isArray(fields) && fields.length && fields.every((f) => typeof f === "string"))) fail("Name the fields to erase, or none for every erasable one.");
            const wanted = fields === undefined ? erasable : [...new Set(fields)];
            const not = wanted.filter((f) => !erasable.includes(f));
            if (not.length) fail(`${not.join(", ")}: not marked as personal data to erase on ${label}.`, { fields: Object.fromEntries(not.map((f) => [f, "Not erasable."])) });
            const kept = def.body.builtIn ? wanted.filter((f) => managedOf(object).fields.includes(f)) : [];
            if (kept.length) fail(`${kept.join(", ")}: People & departments keeps it: rename or deactivate the person there, through its change request.`, { status: 409 });
            const done = await records.internals.remembered(key, user);
            if (done !== undefined) return done;
            const words = reason.trim().slice(0, 500);
            return db.transaction(async (tx) => {
                const [row] = await tx.query("SELECT id, data, row_version FROM mes.records WHERE object = $1 AND id = $2 FOR UPDATE", [object, id]);
                if (!row) fail("Not found.", { status: 404 });
                const erased = wanted.filter((f) => !isErased(def.body.fields[f], row.data?.[f]));
                let rowVersion = Number(row.row_version);
                if (erased.length) {
                    const patch = Object.fromEntries(erased.map((f) => [f, tombstoneOf(def.body.fields[f])]));
                    // The platform's own write (§7.7), sealed after.
                    await platformWrites(tx);
                    const [updated] = await tx.query("UPDATE mes.records SET data = data || $3::jsonb, row_version = row_version + 1, updated_at = now(), updated_by = $4 WHERE object = $1 AND id = $2 RETURNING row_version", [object, id, JSON.stringify(patch), user.id]);
                    rowVersion = Number(updated.row_version);
                    const seal = (await resealRecords(tx, object, [id])).get(id);
                    // The same values asked for in a request to change it, whatever became of the request.
                    for (const r of await tx.query("SELECT id, data, state FROM mes.record_requests WHERE object = $1 AND record_id = $2", [object, id])) {
                        const held = erased.filter((f) => Object.hasOwn(r.data ?? {}, f));
                        if (!held.length && r.state !== "pending") continue;
                        await tx.query(
                            `UPDATE mes.record_requests SET data = data || $2::jsonb,
                                    state = CASE WHEN state = 'pending' THEN 'void' ELSE state END,
                                    outcome = CASE WHEN state = 'pending' THEN $3 ELSE outcome END,
                                    decided_at = CASE WHEN state = 'pending' THEN now() ELSE decided_at END
                             WHERE id = $1`,
                            [r.id, JSON.stringify(Object.fromEntries(held.map((f) => [f, patch[f]]))), "The record's personal data was erased meanwhile, so this was not applied: ask again if it is still needed."],
                        );
                    }
                    await tx.query("DELETE FROM mes.idempotency WHERE result->>'id' = $1", [id]);
                    await appendAudit(tx, { actor: user.id, object, recordId: id, defVersion: def.version, action: "erase", after: { erased, reason: words, $seal: seal } });
                }
                const result = { object, id, erased, already: wanted.filter((f) => !erased.includes(f)), row_version: rowVersion };
                await records.internals.remember(tx, key, user, result);
                return result;
            });
        },
    };
    // `retention.*` are read when asked (the page asks again after a run); an erasure changes a record.
    const touches = {
        "retention.report": [], "retention.run": [], "retention.find": [],
        "records.erase": (args, result) => [...records.recordTargets(args, result), { name: "requests.list" }],
    };
    return { services, touches, purge: (options = {}) => purge(db, { instance, events, ...options }) };
}
