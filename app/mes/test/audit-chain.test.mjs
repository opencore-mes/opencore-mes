// The audit trail's chains (DESIGN.md §7.3): a transaction's entries held until it commits, then linked, all
// of them, on one chain, whichever head no one else holds. A stand-in database that records each statement,
// so what is locked, and when, is seen without one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendAudit, flushAudit, deferAudit, sha256, canonical } from "../server/audit.js";

const ZERO = "0".repeat(64);
const AT = "2026-10-09T02:00:00.000Z";
// Sixteen heads, an audit log, and every statement in the order it was sent, by transaction.
function standIn() {
    // held: heads another transaction holds (skipped by SKIP LOCKED); took: the head each lock statement got.
    const state = { heads: Object.fromEntries(Array.from({ length: 16 }, (_, c) => [c, ZERO])), log: [], sent: [], txs: 0, held: new Set(), took: [] };
    const tx = (n) => ({
        query: async (sql, params = []) => {
            const flat = sql.replace(/\s+/g, " ").trim();
            state.sent.push({ tx: n, sql: flat });
            if (/count\(\*\)::int AS n FROM mes\.audit_head/.test(flat)) return [{ n: 16 }];
            if (/FROM mes\.audit_head ORDER BY random\(\) LIMIT 1 FOR UPDATE SKIP LOCKED/.test(flat)) {
                const free = Object.keys(state.heads).map(Number).filter((c) => !state.held.has(c));
                if (!free.length) return [];
                const c = free[Math.floor(Math.random() * free.length)];
                state.took.push({ skip: true, c });
                return [{ chain: c, hash: state.heads[c] }];
            }
            if (/FROM mes\.audit_head WHERE chain = \$1 FOR UPDATE/.test(flat)) { state.took.push({ skip: false, c: params[0] }); return [{ chain: params[0], hash: state.heads[params[0]] }]; }
            if (/clock_timestamp/.test(flat)) return [{ at: AT }];
            if (/^INSERT INTO mes\.audit_log/.test(flat)) {
                for (let i = 0; i < params.length; i += 13) state.log.push({ seq: state.log.length + 1, actor: params[i + 1], object: params[i + 2], record_id: params[i + 3], action: params[i + 5], prev_hash: params[i + 10], hash: params[i + 11], chain: params[i + 12] });
                return [];
            }
            if (/^UPDATE mes\.audit_head/.test(flat)) { state.heads[params[0]] = params[1]; return []; }
            return [];
        },
    });
    const db = {
        query: tx(0).query,
        // Like Juris's: BEGIN, the function, COMMIT; what it throws rolls the log back.
        async transaction(fn) {
            const n = ++state.txs;
            const mark = state.log.length, heads = { ...state.heads };
            state.sent.push({ tx: n, sql: "BEGIN" });
            try { const out = await fn(tx(n)); state.sent.push({ tx: n, sql: "COMMIT" }); return out; }
            catch (error) { state.log.length = mark; state.heads = heads; state.sent.push({ tx: n, sql: "ROLLBACK" }); throw error; }
        },
    };
    return { db, state };
}
const LOT = "11111111-1111-4111-8111-111111111111", MACHINE = "22222222-2222-4222-8222-222222222222";

test("a transaction's entries wait, and are chained in one go just before it commits: the heads are locked only then", async () => {
    const { db, state } = standIn();
    deferAudit(db);
    await db.transaction(async (tx) => {
        assert.equal(await appendAudit(tx, { actor: "olga", object: "lot", recordId: LOT, action: "update", after: { qty: 1 } }), null, "it waits");
        await tx.query("UPDATE mes.records SET data = $1 WHERE id = $2", ["{}", "x"]);
        await appendAudit(tx, { actor: "olga", object: "machine", recordId: MACHINE, action: "load", after: {} });
        await tx.query("SELECT 1 /* more of the transaction's own work */");
    });
    const full = state.sent.filter((s) => s.tx === 1 && !/count\(\*\)/.test(s.sql)).map((s) => s.sql);
    const lock = full.findIndex((s) => s.includes("FOR UPDATE"));
    assert.ok(lock > full.findIndex((s) => s.startsWith("SELECT 1")), "locked after all the transaction's own work");
    const after = full.slice(lock).map((s) => s.split(" ").slice(0, 3).join(" "));
    assert.equal(after[0], "SELECT chain, hash");
    assert.equal(full.filter((s) => s.includes("FOR UPDATE")).length, 1, "one head, once");
    assert.equal(after[1], "SELECT clock_timestamp() AS");
    assert.equal(after[2], "INSERT INTO mes.audit_log");
    assert.deepEqual(after.slice(3, -1), ["UPDATE mes.audit_head SET"], "then the one head it moved");
    assert.equal(after.at(-1), "COMMIT");
    assert.deepEqual(state.log.map((e) => e.action), ["update", "load"], "in the order they were made, one statement");
});

test("each chain is linked as the one chain was: each entry follows the one before it on its chain, hashed as before (with its chain, but chain 0's)", async () => {
    const { db, state } = standIn();
    deferAudit(db);
    const ids = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`);
    for (const id of ids) await db.transaction(async (tx) => { await appendAudit(tx, { actor: "a", object: "lot", recordId: id, action: "one" }); await appendAudit(tx, { actor: "a", object: "lot", recordId: id, action: "two" }); });
    const prev = Object.fromEntries(Object.keys(state.heads).map((c) => [c, ZERO]));
    for (const e of state.log) {
        assert.equal(e.prev_hash, prev[e.chain], `entry ${e.seq} follows its chain's last`);
        const row = { at: AT, actor: e.actor, object: "lot", record_id: e.record_id, def_version: null, action: e.action, before: null, after: null, rules: null, ...(e.chain ? { chain: e.chain } : {}) };
        assert.equal(e.hash, sha256(e.prev_hash + canonical(row)));
        prev[e.chain] = e.hash;
    }
    for (const [c, h] of Object.entries(state.heads)) assert.equal(h, prev[c], `head ${c} is its chain's last entry`);
    assert.ok(new Set(state.log.map((e) => e.chain)).size >= 8, "different records' entries are spread over the chains");
});

test("a transaction's entries all go on one chain, a head no one else holds; with every head held, it waits for one", async () => {
    const { db, state } = standIn();
    deferAudit(db);
    state.held = new Set(Array.from({ length: 15 }, (_, c) => c));
    await db.transaction(async (tx) => {
        await appendAudit(tx, { actor: "olga", object: "lot", recordId: LOT, action: "track_in" });
        await appendAudit(tx, { actor: "olga", object: "$transaction", action: "run:track_in" });
        await appendAudit(tx, { actor: "olga", object: "machine", recordId: MACHINE, action: "start" });
    });
    assert.deepEqual(state.log.map((e) => e.chain), [15, 15, 15], "all three on the one head nobody else held");
    state.held = new Set(Array.from({ length: 16 }, (_, c) => c));
    await db.transaction(async (tx) => appendAudit(tx, { actor: "sam", object: "lot", recordId: LOT, action: "track_out" }));
    assert.deepEqual(state.took.map((t) => t.skip), [true, false], "every head held: it asks for one and waits for it");
    assert.equal(state.log[3].prev_hash, state.heads[state.log[3].chain] === state.log[3].hash ? state.log.filter((e) => e.chain === state.log[3].chain && e.seq < 4).at(-1)?.hash ?? ZERO : null, "linked to its chain's last");
});

test("a transaction that fails writes none of its entries; a plain client's entry is chained at once", async () => {
    const { db, state } = standIn();
    deferAudit(db);
    await assert.rejects(db.transaction(async (tx) => { await appendAudit(tx, { actor: "a", object: "lot", recordId: LOT, action: "lost" }); throw new Error("refused"); }));
    assert.equal(state.log.length, 0);
    assert.ok(!state.sent.some((s) => s.sql.includes("FOR UPDATE")), "no head was locked for it");
    const plain = { query: db.query };
    assert.match(await appendAudit(plain, { actor: "seed", object: "lot", recordId: LOT, action: "now" }), /^[0-9a-f]{64}$/);
    assert.equal(state.log.length, 1);
});

test("what a statement in the transaction must see is chained when asked (flushAudit), and the rest at the commit", async () => {
    const { db, state } = standIn();
    deferAudit(db);
    await db.transaction(async (tx) => {
        await appendAudit(tx, { actor: "a", object: "$integrity", recordId: LOT, action: "first" });
        await flushAudit(tx);
        assert.equal(state.log.length, 1, "chained when asked");
        await appendAudit(tx, { actor: "a", object: "$integrity", recordId: LOT, action: "second" });
    });
    assert.deepEqual(state.log.map((e) => e.action), ["first", "second"]);
    assert.equal(state.log[1].prev_hash, state.log[0].hash, "the same record: the same chain");
});

test("a database is wrapped once, however many apps are made on it", async () => {
    const { db, state } = standIn();
    deferAudit(db);
    deferAudit(db);
    await db.transaction(async (tx) => appendAudit(tx, { actor: "a", object: "lot", recordId: LOT, action: "once" }));
    assert.equal(state.sent.filter((s) => s.sql.includes("FOR UPDATE")).length, 1);
    assert.equal(state.log.length, 1);
});
