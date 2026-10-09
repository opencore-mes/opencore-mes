// The audit trail (DESIGN.md §7.3): append-only (a trigger refuses UPDATE and DELETE), hash-chained,
// time-stamped by the database clock, written in the same transaction as the change it records.
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

// Canonical JSON: keys sorted, so the hash of a row does not depend on key order.
export function canonical(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// Appends one entry inside `tx`. A chain's head is locked, so writers of that chain form one line. In a
// transaction of a database `deferAudit` has wrapped (the app's), the entry waits there and the whole
// transaction's entries are chained just before it commits (flushAudit): the head is held for those few
// statements and the commit, not for everything the transaction does after its first entry, so writers no
// longer wait on each other's work. The chain, its order (that of the commits) and what each entry says are
// the same; an entry is time-stamped as it is chained. Elsewhere (a plain client, the seed) it is chained at
// once. → its hash, once chained; null while it waits.
const waiting = new WeakMap();
export async function appendAudit(tx, entry) {
    const queue = waiting.get(tx);
    if (queue) { queue.push(entry); return null; }
    return chain(tx, [entry]);
}

// The entries `tx` holds, chained now (what a statement in the transaction reads of the trail must see them).
export async function flushAudit(tx) {
    const queue = waiting.get(tx);
    if (!queue?.length) return null;
    waiting.set(tx, []);
    return chain(tx, queue);
}

// Every transaction of `db` from now on holds its entries until just before it commits (§7.3). A database
// is wrapped once, however many apps are made on it; a transaction that fails takes its entries with it.
const DEFERRED = Symbol("audit deferred");
export function deferAudit(db) {
    if (!db || db[DEFERRED] || typeof db.transaction !== "function") return db;
    const run = db.transaction.bind(db);
    db.transaction = (fn) => run(async (tx) => {
        waiting.set(tx, []);
        const out = await fn(tx);
        await flushAudit(tx);
        return out;
    });
    db[DEFERRED] = true;
    return db;
}

// The chains (§7.3, migrate-audit-chains.sql): the trail is kept in as many as there are heads (16), so that
// writers do not wait on each other. A transaction's entries all go on one chain, whichever head no one holds
// just then (SKIP LOCKED, in no fixed order): it holds one head, never one while waiting for another (holding
// a record's chain and then a second record's had writers queue behind each other's heads), and waits only
// when every head is taken. Which chain an entry is on says nothing; its record's order is its seq (two
// writers of one record are kept apart by the record's own lock, so the later is chained after).
let chainCount = null;
async function chainsIn(tx) {
    if (chainCount === null) { const [{ n }] = await tx.query("SELECT count(*)::int AS n FROM mes.audit_head"); chainCount = Math.max(1, Number(n) || 1); }
    return chainCount;
}

// The entries chained after their chain's head, in order, written in one statement; the head moved to the last.
// (A transaction that chains twice, flushAudit then its commit, stays on the head it already holds.)
const holds = new WeakMap();
async function chain(tx, entries) {
    let [head] = holds.has(tx) ? await tx.query("SELECT chain, hash FROM mes.audit_head WHERE chain = $1 FOR UPDATE", [holds.get(tx)])
        : await tx.query("SELECT chain, hash FROM mes.audit_head ORDER BY random() LIMIT 1 FOR UPDATE SKIP LOCKED");
    if (!head) [head] = await tx.query("SELECT chain, hash FROM mes.audit_head WHERE chain = $1 FOR UPDATE", [Math.floor(Math.random() * (await chainsIn(tx)))]);
    if (!head) throw new Error("The audit trail has no chain head (migrate-audit-chains.sql).");
    const c = Number(head.chain);
    holds.set(tx, c);
    const [{ at }] = await tx.query("SELECT clock_timestamp() AS at");
    const values = [];
    const params = [];
    let prev = head.hash;
    for (const entry of entries) {
        const row = {
            at: new Date(at).toISOString(),
            actor: entry.actor,
            object: entry.object,
            record_id: entry.recordId ?? null,
            def_version: entry.defVersion ?? null,
            action: entry.action,
            before: entry.before ?? null,
            after: entry.after ?? null,
            rules: entry.rules ?? null,
            // Who a service acted for (§15.2): hashed with the rest, and only when there is someone, so
            // the rows written before it existed keep their hash.
            ...(entry.onBehalfOf ? { on_behalf_of: entry.onBehalfOf } : {}),
            // Its chain, hashed with it (an entry cannot be moved to another), but for chain 0's: the entries
            // written before there were chains keep their hash.
            ...(c ? { chain: c } : {}),
        };
        const hash = sha256(prev + canonical(row));
        const k = params.length;
        values.push(`(${Array.from({ length: 13 }, (_, i) => `$${k + i + 1}`).join(", ")})`);
        params.push(row.at, row.actor, row.object, row.record_id, row.def_version, row.action,
            row.before && JSON.stringify(row.before), row.after && JSON.stringify(row.after), row.rules && JSON.stringify(row.rules), row.on_behalf_of ?? null, prev, hash, c);
        prev = hash;
    }
    // seq follows the VALUES' order: one statement, its rows numbered as they are inserted; a chain's entries are
    // numbered while its head is held, so a chain's order is its entries' seq.
    await tx.query(
        `INSERT INTO mes.audit_log (at, actor, object, record_id, def_version, action, before, after, rules, on_behalf_of, prev_hash, hash, chain)
         VALUES ${values.join(", ")}`, params);
    await tx.query("UPDATE mes.audit_head SET hash = $2 WHERE chain = $1", [c, prev]);
    return prev;
}

const ZERO = "0".repeat(64);
const rowOf = (r) => ({
    at: new Date(r.at).toISOString(), actor: r.actor, object: r.object, record_id: r.record_id, def_version: r.def_version,
    action: r.action, before: r.before, after: r.after, rules: r.rules,
    ...(r.on_behalf_of ? { on_behalf_of: r.on_behalf_of } : {}),
    ...(Number(r.chain) ? { chain: Number(r.chain) } : {}),
});

// Recomputes each chain from `from` ({ "<chain>": { seq, hash } }: where an earlier check reached on it; the
// start by default), in batches, inside one read-only snapshot, and checks that each ends where its head says,
// so an entry taken from the end shows as well as one changed in the middle, and that no entry is on a chain
// that has no head (one nobody would check):
// { ok, checked, brokenAt, problem, last: { "<chain>": { seq, hash } } } (each chain's last entry found sound).
export async function verifyAuditFrom(db, { from = {}, batch = 2000 } = {}) {
    return db.transaction(async (tx) => {
        await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
        // A protected trail (ops/db/protect-audit.sql) is read where it is kept, not through the views the
        // application writes through, which the application could replace.
        const [{ kept }] = await tx.query("SELECT to_regclass('audit.audit_log') IS NOT NULL AS kept");
        const at = kept ? "audit" : "mes";
        const heads = await tx.query(`SELECT chain, hash FROM ${at}.audit_head ORDER BY chain`);
        const last = {};
        let checked = 0;
        const broken = (seq, problem) => ({ ok: false, checked, brokenAt: Number(seq), problem, last });
        const [stray] = await tx.query(`SELECT seq, chain FROM ${at}.audit_log WHERE chain < 0 OR chain > $1 ORDER BY seq LIMIT 1`, [heads.length - 1]);
        if (stray) return broken(stray.seq, `entry ${stray.seq} is on chain ${stray.chain}, which has no head (it was added outside the trail)`);
        for (const head of heads) {
            const c = Number(head.chain);
            const start = from[c] ?? from[String(c)] ?? { seq: 0, hash: ZERO };
            let prev = start.hash;
            last[c] = { seq: Number(start.seq), hash: start.hash };
            for (;;) {
                const rows = await tx.query(`SELECT * FROM ${at}.audit_log WHERE chain = $1 AND seq > $2 ORDER BY seq LIMIT $3`, [c, last[c].seq, batch]);
                for (const r of rows) {
                    checked++;
                    if (r.prev_hash !== prev) return broken(r.seq, `entry ${r.seq} does not follow the one before it on chain ${c} (an entry before it was changed or taken out)`);
                    if (r.hash !== sha256(prev + canonical(rowOf(r)))) return broken(r.seq, `entry ${r.seq} was changed after it was written`);
                    prev = r.hash;
                    last[c] = { seq: Number(r.seq), hash: r.hash };
                }
                if (rows.length < batch) break;
                // Run in the thread that answers requests (no worker: a test, a sandbox), it gives way to them between batches.
                await new Promise((resolve) => setImmediate(resolve));
            }
            if (head.hash !== last[c].hash) return broken(last[c].seq + 1, `chain ${c}'s head is not its last entry (an entry was taken from its end, or the head was changed)`);
        }
        return { ok: true, checked, brokenAt: null, problem: null, last };
    });
}

// Recomputes the chains from the start: { ok, checked, brokenAt }.
export async function verifyAudit(db) {
    const r = await verifyAuditFrom(db);
    return { ok: r.ok, checked: r.checked, brokenAt: r.brokenAt };
}

// The scheduled check (COMPLIANCE.md G3): carries on from the checkpoint (or starts again, `full`), and keeps
// what it found there. A chain's checkpoint moves only over its sound entries, so a break stays found until it
// is put right. → { ok, checked, brokenAt, problem, verifiedTo (the last entry checked, on any chain), at }.
export async function checkAudit(db, { full = false } = {}) {
    const [cp] = await db.query("SELECT seq, hash, chains FROM mes.audit_checkpoint WHERE id");
    // A checkpoint from before there were chains is chain 0's.
    const from = !cp || full ? {} : { ...(Number(cp.seq) ? { 0: { seq: Number(cp.seq), hash: cp.hash } } : {}), ...(cp.chains ?? {}) };
    const r = await verifyAuditFrom(db, { from });
    // Chains a check that found a break did not reach keep where they were.
    const kept = { ...from, ...r.last };
    const to = Math.max(0, ...Object.values(kept).map((l) => Number(l.seq)));
    const [saved] = await db.query(
        `UPDATE mes.audit_checkpoint SET seq = $1, hash = $2, chains = $8, checked = CASE WHEN $6 THEN $7 ELSE checked + $7 END, verified_at = now(), ok = $3, broken_at = $4, problem = $5 WHERE id
         RETURNING seq, verified_at`,
        [to, kept[0]?.hash ?? ZERO, r.ok, r.brokenAt, r.problem, full, r.checked, JSON.stringify(kept)]);
    return { ok: r.ok, checked: r.checked, brokenAt: r.brokenAt, problem: r.problem, verifiedTo: Number(saved?.seq ?? to), at: saved ? new Date(saved.verified_at).toISOString() : null };
}

// checkAudit in a worker thread (audit-worker.js) on its own connection to `url`: the same check, the same
// answer, while the thread that answers requests goes on answering them.
export function checkAuditInWorker(url, options = {}) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./audit-worker.js", import.meta.url), { workerData: { url, options } });
        let answered = false;
        worker.once("message", (m) => { answered = true; m.error ? reject(Object.assign(new Error(m.error.message), { code: m.error.code })) : resolve(m.result); });
        worker.once("error", (error) => { answered = true; reject(error); });
        worker.once("exit", (code) => { if (!answered) reject(new Error(`The audit check's thread stopped (exit ${code}) before it answered.`)); });
    });
}
