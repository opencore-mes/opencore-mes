// Calls counted (DESIGN.md §38.1, call-stats.js) and designs published over HTTP (web-publish.js), without a
// database: what a call counts as, its time buckets and percentiles, who it was for, how a web answer counts;
// what a design's `http` may say, and what a change would break for its callers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCallStats, percentile, bucketOf, channelOf, BUCKETS } from "../server/call-stats.js";
import { webProblems, webNames, breaking, WEB_TAKES, WEB_CALLERS } from "../client/web-publish.js";
import { CALL_KIND } from "@opencore-mes/juris-kit/live-protocol.js";

test("a call is counted under its kind, name and way in: answered, refused (a 4xx, by its code) or failed, and who it was for", async () => {
    const sources = [];
    const calls = createCallStats({ within: (source, fn) => { sources.push(source); return fn(); } });
    await calls.measure({ kind: "transaction", name: "move_in", channel: "page" }, async () => { calls.note({ who: "olga" }); return 1; });
    await assert.rejects(calls.measure({ kind: "transaction", name: "move_in", channel: "page" }, async () => { throw Object.assign(new Error("The machine is down."), { status: 422, code: "transaction.refused" }); }));
    await assert.rejects(calls.measure({ kind: "transaction", name: "move_in", channel: "page" }, async () => { throw new Error("driver"); }));
    // Over the web it answers rather than throws: the status it answered with is what it counts as.
    await calls.measure({ kind: "transaction", name: "move_in", channel: "web", who: "erp (token ERP)" }, async () => { calls.outcome({ status: 403, code: "scope.missing" }); });
    const [page, webbed] = [calls.pending().find((c) => c.channel === "page"), calls.pending().find((c) => c.channel === "web")];
    assert.deepEqual([page.calls, page.ok, page.refused, page.failed], [3, 1, 1, 1]);
    assert.deepEqual(page.codes, { "transaction.refused": 1 });
    assert.deepEqual(page.callers, { olga: 1 });
    assert.deepEqual([webbed.refused, webbed.codes, webbed.callers], [1, { "scope.missing": 1 }, { "erp (token ERP)": 1 }]);
    assert.ok(sources.every((s) => s === "transaction:move_in"), "a design's statements are put down to it");
    assert.equal(page.buckets.reduce((a, b) => a + b, 0), 3);
});

test("who a call is for reaches every call around it that does not know yet; a platform service's statements are its own", async () => {
    const sources = [];
    const calls = createCallStats({ within: (source, fn) => { sources.push(source); return fn(); } });
    await calls.measure({ kind: "platform", name: "transactions.run", channel: "page" }, () => calls.measure({ kind: "transaction", name: "track_in", channel: "page" }, async () => calls.note({ who: "sam" })));
    assert.deepEqual(calls.pending().map((c) => `${c.kind}:${Object.keys(c.callers).join()}`).sort(), ["platform:sam", "transaction:sam"]);
    assert.deepEqual(sources, ["transaction:track_in"]);
});

test("time buckets and percentiles: the upper bound of the bucket a share of calls falls in", () => {
    assert.equal(bucketOf(3), 0);
    assert.equal(bucketOf(30), 3);
    assert.equal(bucketOf(99999), BUCKETS.length - 1);
    const b = BUCKETS.map(() => 0);
    b[bucketOf(4)] = 90; b[bucketOf(400)] = 10;
    assert.equal(percentile(b, 0.5), 5);
    assert.equal(percentile(b, 0.95), 500);
    assert.equal(percentile(BUCKETS.map(() => 0), 0.5), null);
});

test("how a platform service was called, from its call", () => {
    assert.equal(channelOf({ [CALL_KIND]: "direct" }), "page");
    assert.equal(channelOf({ [CALL_KIND]: "direct", apiUser: { id: "dana" } }), "ai");
    assert.equal(channelOf({ [CALL_KIND]: "live" }), "live");
    assert.equal(channelOf({ [CALL_KIND]: "internal", origin: { http: "ERP" } }), "web");
    assert.equal(channelOf({ [CALL_KIND]: "internal", origin: { chain: ["erp_in"] } }), "service");
    assert.equal(channelOf({ [CALL_KIND]: "internal", user: { id: "flow:molding_route" } }), "route");
});

test("published over HTTP: one name among the three kinds; a query names who may read it; what a change would break", () => {
    const web = webNames({ service: { erp_in: { http: { enabled: true } } }, transaction: { move_in: { http: { enabled: true } }, track_in: {} }, query: { move_in: { http: { enabled: true } } } });
    assert.deepEqual(web, { erp_in: ["service"], move_in: ["transaction", "query"] });
    const w = (kind, body, known = { web }) => { const out = []; webProblems(kind, body, known, (path, m) => out.push(m)); return out.join("\n"); };
    assert.match(w("query", { name: "move_in", http: { enabled: true, callers: { users: ["erp"] } } }), /published over HTTP as a transaction already/);
    assert.match(w("query", { name: "lots", http: { enabled: true } }), /Name who may read it over HTTP/);
    assert.match(w("query", { name: "lots", http: { enabled: true, callers: { users: ["nobody"] } } }, { web, users: ["erp"] }), /"nobody" is not a user/);
    assert.match(w("transaction", { name: "x", http: { enabled: true, callers: {} } }), /no "callers": it says enabled/);
    assert.equal(w("transaction", { name: "x", http: { enabled: false } }), "");
    const q = { http: { enabled: true, callers: { users: ["erp"] } }, params: { state: { type: "string" } } };
    assert.deepEqual(breaking(q, { ...q, params: { state: { type: "string", required: true } }, http: { enabled: true, callers: {} } }, { takes: WEB_TAKES.query, callers: WEB_CALLERS.query, noun: "parameter" }),
        ["parameter state would be required", "user erp would no longer be among its callers"]);
    // A transaction's callers send what it does not fill in itself.
    assert.deepEqual(Object.keys(WEB_TAKES.transaction({ inputs: { lot: { type: "ref" }, machine: { type: "ref", from: "lot.machine" } } })), ["lot"]);
});
