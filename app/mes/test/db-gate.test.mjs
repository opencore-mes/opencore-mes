// The write database's gate (server/db-gate.js), without a database. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateDb, unreachable } from "../server/db-gate.js";

const quiet = { warn() {} };
const lost = (code = "ECONNREFUSED") => Object.assign(new Error(`connect ${code}`), { code });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An adapter that fails as told, and counts what reached it.
function fake() {
    const state = { down: false, commitLost: false, calls: 0 };
    return {
        state,
        async query() {
            state.calls += 1;
            if (state.down) throw lost();
            return [{ ok: 1 }];
        },
        async transaction(fn) {
            state.calls += 1;
            if (state.down) throw lost();
            const out = await fn({ query: async () => { if (state.down) throw lost("ECONNRESET"); return []; } });
            if (state.commitLost) throw lost("ECONNRESET");
            return out;
        },
    };
}

test("only an unreachable database opens the gate", () => {
    for (const e of [lost(), lost("ETIMEDOUT"), { code: "57P01" }, { code: "08006" }, new Error("timeout exceeded when trying to connect"), new Error("Connection terminated unexpectedly")]) assert.equal(unreachable(e), true, String(e.code ?? e.message));
    for (const e of [{ code: "23505" }, { code: "57014" }, new Error("syntax error"), null]) assert.equal(unreachable(e), false, String(e?.code ?? e?.message));
});

test("unreachable: refused in words, then at once without touching the database", async () => {
    const db = fake();
    const gate = gateDb(db, { probeMs: 60_000, log: quiet });
    db.state.down = true;
    await assert.rejects(gate.query("SELECT 1"), (e) => e.status === 503 && e.code === "db.unavailable" && e.expose === true && /not saved/.test(e.message));
    const reached = db.state.calls;
    await assert.rejects(gate.transaction(async () => 1), (e) => e.code === "db.unavailable");
    assert.equal(db.state.calls, reached, "refused at the gate");
    assert.equal(gate.state().state, "down");
    gate.stop();
});

test("the probe notices it is back", async () => {
    const db = fake();
    const gate = gateDb(db, { probeMs: 10, log: quiet });
    db.state.down = true;
    await assert.rejects(gate.query("SELECT 1"));
    db.state.down = false;
    for (let i = 0; i < 50 && gate.state().state === "down"; i++) await sleep(10);
    assert.equal(gate.state().state, "up");
    assert.deepEqual(await gate.query("SELECT 1"), [{ ok: 1 }]);
    gate.stop();
});

test("lost before COMMIT: not saved; lost at COMMIT: unknown", async () => {
    const db = fake();
    const before = gateDb(db, { probeMs: 60_000, log: quiet });
    await assert.rejects(before.transaction(async (tx) => { db.state.down = true; await tx.query("INSERT …"); }), (e) => e.code === "db.unavailable");
    before.stop();
    const db2 = fake();
    const at = gateDb(db2, { probeMs: 60_000, log: quiet });
    db2.state.commitLost = true;
    await assert.rejects(at.transaction(async () => "done"), (e) => e.code === "db.unknown" && e.status === 503 && /not known whether/.test(e.message));
    at.stop();
});

test("a statement that fails is the caller's: it goes through, and the gate stays open", async () => {
    const gate = gateDb({ query: async () => { throw Object.assign(new Error("duplicate key"), { code: "23505" }); }, transaction: async (fn) => fn({}) }, { log: quiet });
    await assert.rejects(gate.query("INSERT …"), (e) => e.code === "23505");
    await assert.rejects(gate.transaction(async () => { throw Object.assign(new Error("Pick a lot."), { expose: true, status: 400 }); }), (e) => e.message === "Pick a lot.");
    assert.equal(gate.state().state, "up");
});

test("a full pool is not an outage: while the database answers on a connection of its own, the call alone is refused as busy", async () => {
    const wait = () => new Error("timeout exceeded when trying to connect");
    let answers = true;
    const full = { async query() { throw wait(); }, async transaction() { throw wait(); } };
    const downs = [];
    const gate = gateDb(full, { log: quiet, probeMs: 10_000, reaches: async () => answers, onDown: (e) => downs.push(e) });
    for (const call of [() => gate.query("SELECT 1"), () => gate.transaction(async () => 1)]) {
        await assert.rejects(call(), (e) => e.code === "db.busy" && e.status === 503 && e.retry === true && e.expose === true);
    }
    assert.equal(gate.state().state, "up");
    assert.equal(downs.length, 0);
    // The same words with the database not answering: an outage, as before.
    answers = false;
    await assert.rejects(gate.query("SELECT 1"), (e) => e.code === "db.unavailable");
    assert.equal(gate.state().state, "down");
    gate.stop();
    // Without a way to ask, a pool wait reads as unreachable (as it always did).
    const plain = gateDb(full, { log: quiet, probeMs: 10_000 });
    await assert.rejects(plain.query("SELECT 1"), (e) => e.code === "db.unavailable");
    plain.stop();
});
