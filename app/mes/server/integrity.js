// The data integrity review (DESIGN.md §7.7, COMPLIANCE.md G16): a record, a published design or the people
// and roles changed outside the platform (a hand edit in the database, a stolen credential, a script run by
// hand) is found, named, and closed only with a non-conformance report under signature.
//
//   sealOfRecord(object, row)        the record's seal: an HMAC-SHA256 under INTEGRITY_KEY of its canonical form
//   sealOfBody(kind, name, body)     a published design's (or the access's) seal
//   integrityKey()                   the key (32 bytes) or null (then a plain SHA-256: careless edits found,
//                                    deliberate ones not; the review page says so)
//
// The seal covers what a write through the platform sets: object, id, row version, type, state, data, and who
// archived it (the archive's moment is the database's clock, unknown before the statement: left out). Every
// platform write of a record writes its seal in the same statement and into its audit entry (`after.$seal`), so
// the scan can tell a row changed by hand (its seal no longer matches), a row added by hand (no seal), a row
// removed by hand (its creation audited, the row gone) and an old row put back (a valid seal, but not the last
// audited one).
import { createHmac, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonical, appendAudit, flushAudit } from "./audit.js";
import { fail } from "@opencore-mes/juris-kit/errors.js";

let cached;
export function integrityKey(env = process.env) {
    if (env === process.env && cached !== undefined) return cached;
    const text = (env.INTEGRITY_KEY || (env.INTEGRITY_KEY_FILE ? readFileSync(env.INTEGRITY_KEY_FILE, "utf8") : "")).trim();
    if (text && !/^[0-9a-f]{64}$/i.test(text)) throw new Error("INTEGRITY_KEY is 64 hex characters (32 bytes): make one with `openssl rand -hex 32`, kept outside the database and its backups.");
    const key = text ? Buffer.from(text, "hex") : null;
    if (env === process.env) cached = key;
    return key;
}
// Which key the seals are made with, without saying it: a key changed under the seals is told apart from tampering.
export const keyId = (key = integrityKey()) => (key ? createHmac("sha256", key).update("opencore-mes integrity key").digest("hex").slice(0, 16) : "none");
const digest = (text, key) => (key ? createHmac("sha256", key).update(text).digest("hex") : createHash("sha256").update(text).digest("hex"));
// What JSON keeps of a value (an undefined field is no field, as the database stores it).
const asStored = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

export function sealOfRecord(object, row, key = integrityKey()) {
    const form = {
        object, id: row.id, row_version: Number(row.row_version), type: row.type ?? null, state: row.state,
        data: asStored(row.data ?? {}), archived_by: row.archived_by ?? null,
    };
    return digest(`record\n${canonical(form)}`, key);
}
export const sealOfBody = (kind, name, body, key = integrityKey()) => digest(`${kind}\n${name}\n${canonical(asStored(body))}`, key);

// ---- the platform's own writes that are not one record at a time ----
// A design's execution converting stored values (design.js multipleConversion), the people synced from People &
// departments, an erasure: said so for the transaction (the tripwire lets them by), then each row resealed.
export const platformWrites = (tx) => tx.query("SELECT set_config('mes.integrity_reseal', 'on', true)");
export async function resealRecords(tx, object, ids, key = integrityKey()) {
    const out = new Map();
    if (!ids?.length) return out;
    await platformWrites(tx);
    for (const row of await tx.query("SELECT id, row_version, type, state, data, archived_by FROM mes.records WHERE object = $1 AND id = ANY($2)", [object, ids])) {
        const seal = sealOfRecord(object, row, key);
        await tx.query("UPDATE mes.records SET seal = $3 WHERE object = $1 AND id = $2", [object, row.id, seal]);
        out.set(row.id, seal);
    }
    return out;
}

// ---- designs and access ----
// Each published design and script by its kind and name; the people, groups, departments, their approvers and
// every role given, as one ('access'), with the organization's settings. → Map("kind:name" → { kind, name, version, seal })
const DESIGN_TABLES = ["services", "connections", "transactions", "screens", "flows", "layouts", "queries", "elements"];
export async function designSeals(q, key = integrityKey()) {
    const out = new Map();
    const put = (kind, name, version, body) => out.set(`${kind}:${name}`, { kind, name, version, seal: sealOfBody(kind, name, body, key) });
    for (const r of await q.query("SELECT object, version, body FROM mes.definitions WHERE status = 'published'")) put("definitions", r.object, r.version, r.body);
    for (const r of await q.query("SELECT name, version, source, tests FROM mes.scripts WHERE status = 'published'")) put("scripts", r.name, r.version, { source: r.source, tests: r.tests ?? [] });
    for (const t of DESIGN_TABLES) {
        const exists = (await q.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`mes.${t}`]))[0]?.ok;
        if (exists) for (const r of await q.query(`SELECT name, version, body FROM mes.${t} WHERE status = 'published'`)) put(t, r.name, r.version, r.body);
    }
    const access = {
        users: await q.query("SELECT id, name, active FROM mes.users ORDER BY id"),
        groups: await q.query("SELECT id, name, kind FROM mes.groups ORDER BY id"),
        members: await q.query("SELECT group_id, user_id FROM mes.group_members ORDER BY group_id, user_id"),
        reps: await q.query("SELECT group_id, user_id, step FROM mes.department_reps ORDER BY group_id, user_id"),
        roles: await q.query("SELECT subject_kind, subject_id, object, role FROM mes.assignments ORDER BY subject_kind, subject_id, object, role"),
        organization: (await q.query("SELECT version, body FROM mes.organization WHERE status = 'published'"))[0] ?? null,
    };
    put(...ACCESS.split(":"), access.organization?.version ?? null, access);
    return out;
}
// Kept as they are now: what the platform has just done (a change executed, a guest given roles, a migration).
// `only`: the "kind:name"s it changed (ACCESS for people and roles); the rest keep the seals they had, so a hand
// edit to another design in the meantime is still found. Without it, everything (the baseline's re-key only).
export const ACCESS = "access:people and roles";
export async function sealDesigns(q, key = integrityKey(), only = null) {
    const now = await designSeals(q, key);
    const keys = only ? [...new Set(only)] : [...now.keys()];
    for (const k of keys) {
        const d = now.get(k);
        if (d) await q.query(`INSERT INTO mes.integrity_seals (kind, name, version, seal) VALUES ($1, $2, $3, $4)
                       ON CONFLICT (kind, name) DO UPDATE SET version = $3, seal = $4, sealed_at = now()`, [d.kind, d.name, d.version, d.seal]);
        else await q.query("DELETE FROM mes.integrity_seals WHERE (kind || ':' || name) = $1", [k]);
    }
    if (!only) await q.query("DELETE FROM mes.integrity_seals WHERE NOT ((kind || ':' || name) = ANY($1))", [keys]);
    return keys.length;
}

// The baseline (§7.7): what is there and was never sealed, sealed as it stands; nothing already sealed is
// touched, so taking it again hides no change. Inside `tx`. `tripwire: true` also counts the tripwire read up to
// now (a fresh database's seeding: the platform's own, not a finding). Under a key other than the one the seals
// were made with (one set, or changed), everything is sealed again as it stands, and the audit trail's seals
// count from here (a re-key: signed by a reviewer who knows why the key changed).
export async function sealEverything(tx, by, { tripwire = false } = {}, key = integrityKey()) {
    let records = 0;
    const [st] = await tx.query("SELECT key_id FROM mes.integrity_state WHERE id");
    const rekey = Boolean(st?.key_id) && st.key_id !== keyId(key);
    await platformWrites(tx);
    let after = ["", "00000000-0000-0000-0000-000000000000"];
    for (;;) {
        const rows = await tx.query(`SELECT object, id, row_version, type, state, data, archived_by FROM mes.records WHERE ${rekey ? "true" : "seal IS NULL"} AND (object, id) > ($1, $2::uuid) ORDER BY object, id LIMIT 2000`, after);
        for (const r of rows) await tx.query("UPDATE mes.records SET seal = $3 WHERE object = $1 AND id = $2", [r.object, r.id, sealOfRecord(r.object, r, key)]);
        records += rows.length;
        if (rows.length < 2000) break;
        after = [rows[rows.length - 1].object, rows[rows.length - 1].id];
    }
    const now = await designSeals(tx, key);
    // (A fresh database's seeding is the platform's own throughout: its designs sealed as they now are.)
    if (rekey || tripwire) await tx.query("DELETE FROM mes.integrity_seals");
    const kept = new Set((await tx.query("SELECT kind || ':' || name AS k FROM mes.integrity_seals")).map((r) => r.k));
    for (const [k, d] of now) if (!kept.has(k)) await tx.query("INSERT INTO mes.integrity_seals (kind, name, version, seal) VALUES ($1, $2, $3, $4)", [d.kind, d.name, d.version, d.seal]);
    // Where the new key starts is the trail's last entry, this transaction's own included (§7.7).
    if (rekey) await flushAudit(tx);
    await tx.query(
        `UPDATE mes.integrity_state SET baseline_at = COALESCE(baseline_at, now()), baseline_by = COALESCE(baseline_by, $1), key_id = $2,
         key_from_seq = CASE WHEN $3 THEN (SELECT COALESCE(max(seq), 0) FROM mes.audit_log) ELSE key_from_seq END
         ${tripwire ? ", tripwire_seq = (SELECT COALESCE(max(seq), 0) FROM mes.integrity_tripwire)" : ""} WHERE id`, [by, keyId(key), rekey]);
    return { records, rekey };
}

export const REVIEWER = "reviewer";
const ACCESS_TABLES = new Set(["users", "groups", "group_members", "department_reps", "assignments", "organization"]);
// A design row as the tripwire kept it, shortened for the reviewer (a body is long; what changed is in its versions).
const shortRow = (row) => (row ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "string" && v.length > 400 ? `${v.slice(0, 400)}…` : isPlain(v) || Array.isArray(v) ? (JSON.stringify(v).length > 400 ? "(a body: see its versions)" : v) : v])) : null);
export const SCAN_EVERY_MS = 15 * 60_000;
const BATCH = 2000;
const FULL_EVERY_MS = () => Math.max(1, Number(process.env.INTEGRITY_FULL_HOURS ?? 168)) * 3600_000;
const REPORT_KEYS = ["what", "why", "decision", "action", "finding"];
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);

// createIntegrity({ store, records, signatures, events, log }) → { services, touches, queries, scan, state }
export function createIntegrity({ store, records = null, signatures = null, events = null, log = console }) {
    const { db } = store;
    let lastState = null;
    // Who asks: from their session for a call, the reader the live query names (`as`) for the page's live query.
    const reviewer = async (self, as) => {
        const user = records ? await records.internals.requireViewer(self, as) : await store.userForSession(self?.sessionId);
        if (!user) fail("Sign in first.", { status: 401 });
        if (!(await store.rolesFor(user.id, "integrity")).includes(REVIEWER)) fail("The data integrity review is for integrity reviewers: People & departments gives that role (Roles, Integrity).", { status: 403 });
        return user;
    };

    // A finding, kept once while it is open. Another write the tripwire caught to the same thing adds to its detail
    // (`seen`); the scan finding the same change again by its seal adds nothing.
    async function found(q, { kind, object, ref, problem, detail }) {
        const [row] = await q.query(
            `INSERT INTO mes.integrity_findings (kind, object, ref, problem, detail) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (kind, object, ref, problem) WHERE state = 'open'
             DO UPDATE SET detail = CASE WHEN $5::jsonb ? 'op'
                 THEN COALESCE(mes.integrity_findings.detail, '{}'::jsonb) || jsonb_build_object('seen', COALESCE(mes.integrity_findings.detail->'seen', '[]'::jsonb) || jsonb_build_array($5::jsonb))
                 ELSE mes.integrity_findings.detail END
             RETURNING (xmax = 0) AS fresh`,
            [kind, object, String(ref), problem, JSON.stringify(detail ?? {})]);
        return row?.fresh === true;
    }
    // What a hand edit changed, field by field; a sensitive field (§6.10) as the marker, never its value.
    async function changesOf(object, before, after) {
        const def = (await store.definition(object))?.body;
        const sensitive = (f) => def?.fields?.[f]?.sensitive === true;
        const out = [];
        for (const k of ["state", "type", "row_version", "archived_by"]) if (JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null)) out.push({ field: k, before: before?.[k] ?? null, after: after?.[k] ?? null });
        const a = before?.data ?? {};
        const b = after?.data ?? {};
        for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (JSON.stringify(a[f] ?? null) === JSON.stringify(b[f] ?? null)) continue;
            out.push(sensitive(f) ? { field: f, sensitive: true } : { field: f, label: def?.fields?.[f]?.label ?? f, before: a[f] ?? null, after: b[f] ?? null });
        }
        return out;
    }

    // One scan: the tripwire since the last, the records (those written since the last scan, or all in a full
    // pass), records removed (a full pass), designs and access (each time: a few hundred, cheap).
    async function scan({ full = null } = {}) {
        const key = integrityKey();
        const [st] = await db.query("SELECT * FROM mes.integrity_state WHERE id");
        const startedAt = new Date();
        const isFull = full ?? (!st.last_full_at || startedAt - new Date(st.last_full_at) > FULL_EVERY_MS());
        const baseline = Boolean(st.baseline_at);
        // Sealed under another key (or none): every seal would read as changed. Nothing is compared until a
        // reviewer signs the re-key (the baseline); the tripwire still keeps who wrote around the platform.
        const keyChanged = Boolean(st.key_id) && st.key_id !== keyId(key);
        let fresh = 0;
        let checked = 0;
        const note = (wasNew) => { if (wasNew) fresh++; };
        // 1. The tripwire: who wrote around the platform, and from where.
        const trips = await db.query("SELECT * FROM mes.integrity_tripwire WHERE seq > $1 ORDER BY seq LIMIT 5000", [st.tripwire_seq ?? 0]);
        const named = new Map();
        for (const t of trips) {
            // A design's or an access table's row (its own tripwire): the table, the row's key, what changed.
            if (!t.record_id) {
                const kind = ACCESS_TABLES.has(t.object) ? "access" : "design";
                note(await found(db, { kind, object: t.object, ref: t.ref ?? "", problem: "changed", detail: { by: t.db_user, from: t.client_addr, app: t.app_name, at: iso(t.at), op: t.op, table: t.object, before: shortRow(t.old_row), after: shortRow(t.new_row) } }));
                continue;
            }
            const problem = t.op === "DELETE" ? "removed" : t.op === "INSERT" ? "unsealed" : "changed";
            note(await found(db, { kind: "record", object: t.object, ref: t.record_id, problem, detail: { by: t.db_user, from: t.client_addr, app: t.app_name, at: iso(t.at), op: t.op, changes: await changesOf(t.object, t.old_row, t.new_row) } }));
            if (t.op !== "DELETE") (named.get(t.object) ?? named.set(t.object, new Set()).get(t.object)).add(t.record_id);
        }
        const tripTo = trips.length ? Number(trips[trips.length - 1].seq) : Number(st.tripwire_seq ?? 0);
        if (keyChanged) {
            await db.query("UPDATE mes.integrity_state SET last_scan_at = $1, tripwire_seq = $2 WHERE id", [startedAt, tripTo]);
            const [{ n }] = await db.query("SELECT count(*)::int AS n FROM mes.integrity_findings WHERE state = 'open'");
            log.warn?.("integrity: the seals were made with another key (INTEGRITY_KEY): nothing compared until a reviewer takes the baseline again");
            if (fresh) events?.emit?.("integrity.violation", { severity: "critical", message: `The data integrity review found ${fresh} new change(s) made outside the platform: ${n} open. Review them under Design, Data integrity.`, details: { fresh, open: n } });
            lastState = { open: n, at: startedAt.toISOString(), full: false, keyed: Boolean(key), keyChanged: true, baseline };
            return { fresh, open: n, checked: 0, full: false, keyChanged: true };
        }
        // 2. Records: each one's seal against its contents, and against its last audited seal.
        const checkRows = async (rows) => {
            checked += rows.length;
            const ids = rows.filter((r) => r.seal).map((r) => r.id);
            const audited = new Map((ids.length ? await db.query(
                `SELECT DISTINCT ON (record_id) record_id, after->>'$seal' AS seal FROM mes.audit_log
                 WHERE record_id = ANY($1) AND after ? '$seal' AND seq > $2 ORDER BY record_id, seq DESC`, [ids, st.key_from_seq ?? 0]) : []).map((r) => [r.record_id, r.seal]));
            for (const r of rows) {
                if (!r.seal) { if (baseline) note(await found(db, { kind: "record", object: r.object, ref: r.id, problem: "unsealed", detail: { updated_at: iso(r.updated_at), updated_by: r.updated_by } })); continue; }
                if (sealOfRecord(r.object, r, key) !== r.seal) { note(await found(db, { kind: "record", object: r.object, ref: r.id, problem: "changed", detail: { row_version: Number(r.row_version), updated_at: iso(r.updated_at), updated_by: r.updated_by } })); continue; }
                const last = audited.get(r.id);
                if (last && last !== r.seal) note(await found(db, { kind: "record", object: r.object, ref: r.id, problem: "replaced", detail: { row_version: Number(r.row_version), note: "an earlier version of the record, its seal valid, is not the last one the audit trail kept" } }));
            }
        };
        const COLS = "object, id, row_version, type, state, data, archived_by, seal, updated_at, updated_by";
        if (isFull) {
            let after = ["", "00000000-0000-0000-0000-000000000000"];
            for (;;) {
                const rows = await db.query(`SELECT ${COLS} FROM mes.records WHERE (object, id) > ($1, $2::uuid) ORDER BY object, id LIMIT ${BATCH}`, after);
                await checkRows(rows);
                if (rows.length < BATCH) break;
                after = [rows[rows.length - 1].object, rows[rows.length - 1].id];
            }
            // Removed: created through the platform, gone without it.
            for (const g of await db.query(
                `SELECT a.object, a.record_id, a.actor, a.at FROM mes.audit_log a
                 WHERE a.action = 'create' AND a.record_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM mes.records r WHERE r.object = a.object AND r.id = a.record_id)
                   -- (a removal reported already, open or closed with its report, is not found again)
                   AND NOT EXISTS (SELECT 1 FROM mes.integrity_findings f WHERE f.kind = 'record' AND f.object = a.object AND f.ref = a.record_id::text AND f.problem = 'removed') LIMIT 1000`)) {
                note(await found(db, { kind: "record", object: g.object, ref: g.record_id, problem: "removed", detail: { created_by: g.actor, created_at: iso(g.at) } }));
            }
        } else {
            const since = st.last_scan_at ?? new Date(0);
            await checkRows(await db.query(`SELECT ${COLS} FROM mes.records WHERE updated_at > $1::timestamptz - interval '1 minute' LIMIT 50000`, [since]));
            for (const [object, ids] of named) await checkRows(await db.query(`SELECT ${COLS} FROM mes.records WHERE object = $1 AND id = ANY($2)`, [object, [...ids]]));
        }
        // 3. Designs and access.
        const now = await designSeals(db, key);
        const kept = new Map((await db.query("SELECT kind, name, version, seal, sealed_at FROM mes.integrity_seals")).map((r) => [`${r.kind}:${r.name}`, r]));
        for (const [k, d] of now) {
            const was = kept.get(k);
            const kind = d.kind === "access" ? "access" : "design";
            if (!was) { if (baseline) note(await found(db, { kind, object: d.kind, ref: d.name, problem: "unsealed", detail: { version: d.version } })); continue; }
            if (was.seal !== d.seal) note(await found(db, { kind, object: d.kind, ref: d.name, problem: "changed", detail: { version: d.version, sealed_version: was.version, sealed_at: iso(was.sealed_at) } }));
        }
        for (const [k, was] of kept) if (!now.has(k)) note(await found(db, { kind: was.kind === "access" ? "access" : "design", object: was.kind, ref: was.name, problem: "removed", detail: { version: was.version, sealed_at: iso(was.sealed_at) } }));
        await db.query(`UPDATE mes.integrity_state SET last_scan_at = $1, tripwire_seq = $2, scanned = $3${isFull ? ", last_full_at = $1" : ""} WHERE id`, [startedAt, tripTo, checked]);
        const [{ n }] = await db.query("SELECT count(*)::int AS n FROM mes.integrity_findings WHERE state = 'open'");
        if (fresh) events?.emit?.("integrity.violation", { severity: "critical", message: `The data integrity review found ${fresh} new change(s) made outside the platform: ${n} open. Review them under Design, Data integrity.`, details: { fresh, open: n } });
        lastState = { open: n, at: startedAt.toISOString(), full: isFull, keyed: Boolean(key), baseline };
        return { fresh, open: n, checked, full: isFull };
    }

    // The baseline: what is there now and was never sealed, sealed as it stands (records, designs, access).
    // Nothing already sealed is touched, so taking it again hides no change.
    async function takeBaseline(by) {
        return db.transaction((tx) => sealEverything(tx, by));
    }

    async function settings() {
        const [row] = await db.query("SELECT body FROM mes.organization WHERE status = 'published'");
        return isPlain(row?.body?.integrity) ? row.body.integrity : {};
    }

    const services = {
        // What a reviewer reads (a live query): where the review stands, what is open, what was closed, the reviews signed.
        async "integrity.report"({ as } = {}) {
            await reviewer(this, as);
            const [st] = await db.query("SELECT * FROM mes.integrity_state WHERE id");
            const open = await db.query("SELECT * FROM mes.integrity_findings WHERE state = 'open' ORDER BY found_at DESC LIMIT 200");
            const closed = await db.query("SELECT * FROM mes.integrity_findings WHERE state = 'closed' ORDER BY closed_at DESC LIMIT 20");
            const reviews = await db.query("SELECT * FROM mes.integrity_reviews ORDER BY at DESC LIMIT 10");
            const [{ n: openCount }] = await db.query("SELECT count(*)::int AS n FROM mes.integrity_findings WHERE state = 'open'");
            const title = async (f) => {
                if (f.kind !== "record") return f.ref;
                const def = await store.definition(f.object);
                const tf = def?.body?.titleField;
                const [r] = await db.query("SELECT data FROM mes.records WHERE object = $1 AND id = $2", [f.object, f.ref]).catch(() => []);
                if (r) return tf && r.data?.[tf] !== undefined ? String(r.data[tf]) : f.ref;
                // Gone: what the audit trail last kept of it.
                const [a] = tf ? await db.query("SELECT after FROM mes.audit_log WHERE record_id = $1 AND after ? $2 ORDER BY seq DESC LIMIT 1", [f.ref, tf]).catch(() => []) : [];
                return a?.after?.[tf] !== undefined ? String(a.after[tf]) : f.ref;
            };
            const shape = async (f) => ({ id: f.id, kind: f.kind, object: f.object, objectLabel: f.kind === "record" ? (await store.definition(f.object))?.body?.label ?? f.object : f.object, ref: f.ref, title: await title(f), problem: f.problem, detail: f.detail ?? {}, state: f.state, foundAt: iso(f.found_at), closedAt: iso(f.closed_at), closedBy: f.closed_by, report: f.report ?? null });
            const s = await settings();
            return {
                keyed: Boolean(integrityKey()), keyChanged: Boolean(st.key_id) && st.key_id !== keyId(), baselineAt: iso(st.baseline_at), baselineBy: st.baseline_by, lastScanAt: iso(st.last_scan_at), lastFullAt: iso(st.last_full_at), scanned: st.scanned,
                openCount, open: await Promise.all(open.map(shape)), closed: await Promise.all(closed.map(shape)),
                reviews: await Promise.all(reviews.map(async (r) => ({ name: (await store.user(r.by).catch(() => null))?.name ?? r.by, id: Number(r.id), from: iso(r.from_at), to: iso(r.to_at), note: r.note, open: r.open, closed: r.closed, by: r.by, at: iso(r.at), signature: r.signature }))),
                reportObject: typeof s.reportObject === "string" ? s.reportObject : null,
            };
        },
        async "integrity.scan"({ full = false } = {}) {
            const user = await reviewer(this);
            const r = await scan({ full: Boolean(full) });
            await db.transaction(async (tx) => { await appendAudit(tx, { actor: user.id, object: "$integrity", action: "scan", after: r }); });
            return r;
        },
        async "integrity.baseline"({ signature } = {}) {
            const user = await reviewer(this);
            const proof = signatures ? await signatures.signOne(this, user, "the data integrity baseline", signature) : null;
            const r = await takeBaseline(user.id);
            await db.transaction(async (tx) => { await appendAudit(tx, { actor: user.id, object: "$integrity", action: "baseline", after: { ...r, ...(proof ? { printedName: proof.printedName, method: proof.method } : {}) } }); });
            return r;
        },
        // A finding closed with its non-conformance report (§7.7): what happened, why, what was decided (accepted
        // as it is, or corrected through the platform), what was done; under signature. Accepted: its present state
        // sealed. Corrected: it must already be (a write through the platform seals it). The organization's report
        // object, if it names one, gets a record of it through the record services.
        async "integrity.close"({ id, report, signature, key } = {}) {
            const user = await reviewer(this);
            const r = isPlain(report) ? report : {};
            const fields = {};
            for (const k of ["what", "why", "action"]) if (typeof r[k] !== "string" || r[k].trim().length < 5) fields[k] = "Say it in a few words (at least 5 characters).";
            if (!["accepted", "corrected"].includes(r.decision)) fields.decision = "Accepted as it is, or corrected through the platform.";
            if (Object.keys(fields).length) fail("The non-conformance report needs attention.", { fields, code: "integrity.report" });
            const [f] = await db.query("SELECT * FROM mes.integrity_findings WHERE id = $1", [id]);
            if (!f) fail("No such finding.", { status: 404 });
            if (f.state !== "open") fail("This finding is closed already.", { status: 409 });
            if (f.problem === "removed" && r.decision === "corrected") fail("A record or design removed by hand cannot be corrected here: put it back from a backup through IT, or accept its removal.", { fields: { decision: "Accepted only." } });
            const proof = signatures ? await signatures.signOne(this, user, `the non-conformance report of finding ${id}`, signature) : null;
            const keyNow = integrityKey();
            // Corrected: the present state is one the platform wrote (its seal is good).
            if (r.decision === "corrected") {
                if (f.kind === "record") {
                    const [row] = await db.query("SELECT object, id, row_version, type, state, data, archived_by, seal FROM mes.records WHERE object = $1 AND id = $2", [f.object, f.ref]);
                    if (!row?.seal || sealOfRecord(row.object, row, keyNow) !== row.seal) fail("It is not corrected yet: change it through its form or a transaction (its policies and rules decide), then close this as corrected. Or accept it as it is.", { fields: { decision: "Not corrected yet." } });
                } else {
                    const now = (await designSeals(db, keyNow)).get(`${f.object}:${f.ref}`);
                    const [kept] = await db.query("SELECT seal FROM mes.integrity_seals WHERE kind = $1 AND name = $2", [f.object, f.ref]);
                    if (!now || !kept || now.seal !== kept.seal) fail("It is not corrected yet: change it through a change request (executed, it is sealed again), then close this as corrected. Or accept it as it is.", { fields: { decision: "Not corrected yet." } });
                }
            }
            // The plant's own non-conformance report, when its organization names where they live.
            const s = await settings();
            let raised = null;
            if (typeof s.reportObject === "string" && s.reportObject && records) {
                const map = isPlain(s.fields) ? s.fields : {};
                const values = { what: r.what.trim(), why: r.why.trim(), decision: r.decision, action: r.action.trim(), finding: `${f.problem} ${f.kind} ${f.object} ${f.ref}` };
                const data = { ...(isPlain(s.values) ? s.values : {}), ...Object.fromEntries(Object.entries(map).filter(([, v]) => REPORT_KEYS.includes(v)).map(([field, v]) => [field, values[v]])) };
                const made = await records.services["records.create"].call(this, { object: s.reportObject, data, key: typeof key === "string" ? `${key}:ncr` : undefined });
                raised = { object: s.reportObject, id: made?.id ?? null };
            }
            await db.transaction(async (tx) => {
                if (r.decision === "accepted" && f.problem !== "removed") {
                    if (f.kind === "record") {
                        const sealed = await resealRecords(tx, f.object, [f.ref], keyNow);
                        const seal = sealed.get(f.ref);
                        if (seal) await appendAudit(tx, { actor: user.id, object: f.object, recordId: f.ref, action: "integrity:accept", after: { finding: f.id, problem: f.problem, $seal: seal } });
                    } else await sealDesigns(tx, keyNow, [`${f.object}:${f.ref}`]);
                } else if (r.decision === "accepted" && f.kind !== "record") await sealDesigns(tx, keyNow, [`${f.object}:${f.ref}`]);
                const kept = { what: r.what.trim(), why: r.why.trim(), decision: r.decision, action: r.action.trim(), by: user.id, name: user.name, ...(proof ? { printedName: proof.printedName, method: proof.method } : {}), ...(raised ? { raised } : {}) };
                await tx.query("UPDATE mes.integrity_findings SET state = 'closed', closed_at = now(), closed_by = $2, report = $3 WHERE id = $1", [f.id, user.id, JSON.stringify(kept)]);
                await appendAudit(tx, { actor: user.id, object: "$integrity", action: "close", after: { finding: f.id, kind: f.kind, object: f.object, ref: f.ref, problem: f.problem, ...kept } });
            });
            return { ok: true, raised };
        },
        // The periodic review (EU GMP Annex 11 §11): a period reviewed, signed, with what was found and done in it.
        async "integrity.review"({ from, to, note, signature } = {}) {
            const user = await reviewer(this);
            const f = Date.parse(from);
            const t = Date.parse(to);
            if (!Number.isFinite(f) || !Number.isFinite(t) || t < f) fail("Give the period reviewed: from, then to.", { fields: { from: "A date.", to: "After from." } });
            if (typeof note !== "string" || note.trim().length < 5) fail("Say what was reviewed and found, in a few words.", { fields: { note: "Required." } });
            const proof = signatures ? await signatures.signOne(this, user, "a periodic data integrity review", signature) : null;
            const [{ open }] = await db.query("SELECT count(*)::int AS open FROM mes.integrity_findings WHERE found_at BETWEEN $1 AND $2 AND state = 'open'", [new Date(f), new Date(t)]);
            const [{ closed }] = await db.query("SELECT count(*)::int AS closed FROM mes.integrity_findings WHERE found_at BETWEEN $1 AND $2 AND state = 'closed'", [new Date(f), new Date(t)]);
            const sig = proof ? { printedName: proof.printedName, method: proof.method } : null;
            await db.transaction(async (tx) => {
                await tx.query("INSERT INTO mes.integrity_reviews (from_at, to_at, note, open, closed, by, signature) VALUES ($1, $2, $3, $4, $5, $6, $7)", [new Date(f), new Date(t), note.trim(), open, closed, user.id, sig ? JSON.stringify(sig) : null]);
                await appendAudit(tx, { actor: user.id, object: "$integrity", action: "review", after: { from: new Date(f).toISOString(), to: new Date(t).toISOString(), note: note.trim(), open, closed, ...(sig ?? {}) } });
            });
            return { ok: true, open, closed };
        },
    };
    const touches = Object.fromEntries(["integrity.scan", "integrity.baseline", "integrity.close", "integrity.review"].map((n) => [n, [{ name: "integrity.report" }]]));
    return { services, touches, queries: ["integrity.report"], scan, takeBaseline, state: () => lastState };
}
