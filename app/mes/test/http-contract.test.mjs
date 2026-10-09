// The HTTP APIs' contract (docs/contracts/http-apis, DESIGN.md §31.2, §31.5), without a database: what
// /ai/v1 offers is what the contract promises, no more and no less; a removal or a changed scope is
// caught; deprecation headers and their note once a day; and what a change to a web service would break
// for its callers. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openapi } from "../server/ai-api.js";
import { apiContract, httpContract } from "../server/api-contract.js";
import { surfaceOf, compareSurface, operationOf, deprecationHeaders, noticeProblem } from "../../../docs/contracts/http-apis/surface.mjs";
import { breakingForCallers, validateService } from "../client/definition.js";

test("/ai/v1 offers exactly what the contract promises", () => {
    const promised = httpContract()["x-apis"]["/ai/v1"].surface;
    const { breaking, unpromised } = compareSurface(promised, surfaceOf(openapi("")));
    assert.deepEqual(breaking, [], "nothing promised is gone or changed (v1 never loses it: that is v2)");
    assert.deepEqual(unpromised, [], "anything new is written into the contract (schema.json) and its changelog first");
    assert.equal(httpContract()["x-contract"].version, "1.3");
});

test("a removal, a changed scope, a field no longer read, and an addition are each told apart", () => {
    const promised = { "GET /me": { scope: "any", params: [], fields: [] }, "POST /validate": { scope: "design:read", params: [], fields: ["definitions", "scripts"] }, "GET /gone": { scope: "design:read", params: [], fields: [] } };
    const live = { "GET /me": { scope: "design:read", params: [], fields: [] }, "POST /validate": { scope: "design:read", params: [], fields: ["definitions", "flows"] }, "GET /new": { scope: "design:read", params: [], fields: [] } };
    const { breaking, unpromised } = compareSurface(promised, live);
    assert.deepEqual(breaking, ["GET /me: its scope is design:read, not any", "POST /validate: it no longer reads scripts", "GET /gone is gone"]);
    assert.deepEqual(unpromised, ["POST /validate: reads flows, which the contract does not list", "GET /new is not in the contract"]);
});

test("each request is one operation of the document", () => {
    const doc = openapi("");
    assert.equal(operationOf("GET", "/changes/0b48c785-a875-4818-9c54-953ba13adff5", doc), "GET /changes/{id}");
    assert.equal(operationOf("POST", "/changes/0b48c785-a875-4818-9c54-953ba13adff5/submit", doc), "POST /changes/{id}/submit");
    assert.equal(operationOf("GET", "/contracts/http-apis", doc), "GET /contracts/{name}");
    assert.equal(operationOf("DELETE", "/changes", doc), null);
});

test("a deprecated operation's headers (RFC 9745, RFC 8594), and its use noted once a day per caller", () => {
    assert.deepEqual(deprecationHeaders({ since: "2026-10-06", sunset: "2027-04-06", successor: "/ai/v2/catalog", docs: "https://opencoremes.com/contracts/http-apis" }), {
        deprecation: "@1791244800", sunset: "Tue, 06 Apr 2027 00:00:00 GMT",
        link: '</ai/v2/catalog>; rel="successor-version", <https://opencoremes.com/contracts/http-apis>; rel="deprecation"',
    });
    const noted = [];
    let now = Date.parse("2026-10-07T08:00:00Z");
    const schema = { "x-contract": { version: "1.3" }, "x-deprecated": { "/ai/v1": { "GET /catalog": { since: "2026-10-06", sunset: "2027-04-06" } } } };
    const c = apiContract({ schema, onDeprecatedUse: (...a) => noted.push(a), now: () => now });
    assert.deepEqual(c.headers("/ai/v1", "GET /me"), { "api-version": "1.3" });
    assert.equal(c.headers("/ai/v1", "GET /catalog").sunset, "Tue, 06 Apr 2027 00:00:00 GMT");
    c.used("/ai/v1", "GET /catalog", "dana");
    c.used("/ai/v1", "GET /catalog", "dana");
    c.used("/ai/v1", "GET /catalog", "eli");
    c.used("/ai/v1", "GET /me", "dana");
    now += 86_400_000;
    c.used("/ai/v1", "GET /catalog", "dana");
    assert.deepEqual(noted.map(([, op, who]) => `${op} ${who}`), ["GET /catalog dana", "GET /catalog eli", "GET /catalog dana"]);
    assert.equal(noticeProblem({ since: "2026-10-06", sunset: "2026-12-01" }, { minDays: 180 }), "sunset is at least 180 days after since: callers are given that long");
    assert.equal(noticeProblem({ since: "2026-10-06", sunset: "2027-04-06" }, { minDays: 180 }), null);
});

test("what a change to a web service would break for its callers", () => {
    const live = { http: { enabled: true }, input: { lot: { type: "string", required: true }, qty: { type: "integer" }, grade: { type: "enum", values: ["A", "B"] } }, callers: { users: ["erp", "lims"], groups: [] } };
    assert.deepEqual(breakingForCallers(live, { ...live, input: { lot: { type: "string", required: true }, qty: { type: "decimal", required: true }, grade: { type: "enum", values: ["A"] }, site: { type: "string", required: true } }, callers: { users: ["erp"], groups: [] } }), [
        "input qty would be decimal, not integer", "input qty would be required", 'input grade would no longer take "B"', "a new input site would be required", "user lims would no longer be among its callers",
    ]);
    assert.deepEqual(breakingForCallers(live, { ...live, input: { ...live.input, note: { type: "string" } }, deprecated: { since: "2026-10-06", sunset: "2027-04-06" } }), [], "an optional input added, a notice given: nothing breaks");
    assert.deepEqual(breakingForCallers(live, { ...live, http: { enabled: false } }), ["it would no longer answer over HTTP"]);
    assert.deepEqual(breakingForCallers({ ...live, http: { enabled: false } }, {}), [], "not a web service: no callers over HTTP");
});

test("a web service's notice is checked as designed", () => {
    const base = { name: "echo", label: "Echo", http: { enabled: true }, input: {}, callers: { users: [], groups: [] }, on: [], runAs: "caller", uses: {} };
    const messages = (d, extra = {}) => validateService({ ...base, ...extra, deprecated: d }, { scripts: ["echo"] }).filter((p) => p.path.startsWith("deprecated")).map((p) => p.message);
    assert.deepEqual(messages({ since: "2026-10-06", sunset: "2027-04-06", successor: "echo_v2", note: "Quantity becomes required." }), []);
    assert.deepEqual(messages({ since: "2026-10-06", sunset: "2026-10-01" }), ["Sunset comes after since: that time is its callers' notice."]);
    assert.deepEqual(messages({ since: "soon", sunset: "2027-04-06", successor: "echo" }), ["Since: the date it is deprecated from (YYYY-MM-DD).", "Successor: what its callers move to (another name published over HTTP)."]);
    assert.deepEqual(messages({ since: "2026-10-06", sunset: "2027-04-06" }, { http: { enabled: false } }), ["Only a web service published over HTTP is deprecated: its callers are the ones told."]);
});
