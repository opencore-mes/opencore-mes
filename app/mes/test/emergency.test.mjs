// Emergency changes (emergency.js, DESIGN.md §5.7): what the organization allows, when the review
// afterwards is due and late, the stage after each department's decision, and who may confirm it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emergencyPolicy, emergencyDue, emergencyOpen, stageAfter, confirmersOf, emergencyWords } from "../client/emergency.js";

test("allowed unless the organization says not; reviewed within 3 days unless it says, from 1 to 30", () => {
    assert.deepEqual(emergencyPolicy({}), { allowed: true, reviewDays: 3 });
    assert.deepEqual(emergencyPolicy(null), { allowed: true, reviewDays: 3 });
    assert.deepEqual(emergencyPolicy({ emergency: { allowed: false } }), { allowed: false, reviewDays: 3 });
    assert.deepEqual(emergencyPolicy({ emergency: { reviewDays: 7 } }), { allowed: true, reviewDays: 7 });
    // Nonsense falls back to the default, never to "no review".
    for (const reviewDays of [0, -1, 31, 2.5, "soon", null]) assert.equal(emergencyPolicy({ emergency: { reviewDays } }).reviewDays, 3, String(reviewDays));
});

test("due the set number of days after execution; open and late until reviewed and confirmed", () => {
    const due = emergencyDue("2026-10-06T08:00:00.000Z", 3);
    assert.equal(due, "2026-10-09T08:00:00.000Z");
    const em = { stage: "review", due };
    assert.deepEqual(emergencyOpen(em, Date.parse("2026-10-08T08:00:00Z")), { open: true, overdue: false });
    assert.deepEqual(emergencyOpen(em, Date.parse("2026-10-09T08:00:01Z")), { open: true, overdue: true });
    assert.deepEqual(emergencyOpen({ ...em, stage: "confirm" }, Date.parse("2026-10-10T00:00:00Z")), { open: true, overdue: true });
    // Waiting for its signature, confirmed or flagged: nothing is due.
    for (const stage of ["approval", "confirmed", "flagged"]) assert.deepEqual(emergencyOpen({ ...em, stage }, Date.parse("2026-11-01T00:00:00Z")), { open: false, overdue: false });
    assert.deepEqual(emergencyOpen(null), { open: false, overdue: false });
});

test("each department confirms; one flag flags it; every department confirmed closes it", () => {
    const route = [{ department: "production" }, { department: "quality" }];
    assert.equal(stageAfter(route, {}), "confirm");
    assert.equal(stageAfter(route, { production: { decision: "confirm" } }), "confirm");
    assert.equal(stageAfter(route, { production: { decision: "confirm" }, quality: { decision: "confirm" } }), "confirmed");
    assert.equal(stageAfter(route, { production: { decision: "flag" } }), "flagged");
    assert.equal(stageAfter(route, { production: { decision: "confirm" }, quality: { decision: "flag" } }), "flagged");
    // A route with nobody on it is never confirmed by default.
    assert.equal(stageAfter([], {}), "confirm");
});

test("whoever confirms is not an author nor the reviewer afterwards; the emergency signer may, review in hand", () => {
    assert.deepEqual(confirmersOf(["sam", "dana", "eli", "quinn", "sam"], { authors: ["dana"], reviewer: "eli" }), ["sam", "quinn"]);
    assert.deepEqual(confirmersOf(["dana"], { authors: ["dana"] }), []);
    assert.deepEqual(confirmersOf(null), []);
});

test("the stage in words, overdue said", () => {
    assert.equal(emergencyWords({ stage: "approval" }), "emergency: waiting for one signature");
    assert.equal(emergencyWords({ stage: "review", due: "2026-10-09T08:00:00.000Z" }, Date.parse("2026-10-08T00:00:00Z")), "emergency, awaiting review");
    assert.equal(emergencyWords({ stage: "confirm", due: "2026-10-09T08:00:00.000Z" }, Date.parse("2026-10-10T00:00:00Z")), "emergency, awaiting confirmation (overdue)");
    assert.equal(emergencyWords({ stage: "flagged" }), "emergency, flagged");
    assert.equal(emergencyWords(null), "");
});
