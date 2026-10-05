// An AI agent working in the designer over the REST API (/ai/v1), end to end: it reads the contract
// and the catalog, drafts a new object with a rule script, tests the script in the sandbox, simulates
// access, validates, and checks it cannot submit or approve. What a person then sees is a change
// request in design, marked as drafted with AI.
//
//   BASE=http://127.0.0.1:9090 DATABASE_URL=postgres:///openmes_poc node app/mes/test/ai-agent.mjs
// It issues itself a token for Dana (the designer) with read and draft scopes, and revokes it at the end.
import pg from "pg";
import { fromPg } from "../../../src/server/db.js";
import { createTokens } from "../server/ai-api.js";

const BASE = process.env.BASE ?? "http://127.0.0.1:9090";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const tokens = createTokens(fromPg(pool));
const issued = await tokens.issue("dana", { name: "ai-agent test", agent: "test agent" });
const steps = [];
const api = async (method, path, body, { token = issued.token, raw } = {}) => {
    const res = await fetch(`${BASE}/ai/v1${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", "x-ai-agent": "claude-opus-5-5 (test)" },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
};
const step = (name, ok, detail) => { steps.push({ step: name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) }); };

try {
    const doc = await (await fetch(`${BASE}/ai/v1/openapi.json`)).json();
    step("discover the API (openapi.json, no token needed)", doc.openapi === "3.1.0", `${Object.keys(doc.paths).length} paths`);
    step("refused without a token", (await api("GET", "/catalog", undefined, { token: null })).status === 401);
    const me = await api("GET", "/me");
    step("who am I", me.body?.user?.id === "dana", me.body?.scopes);
    const contract = await api("GET", "/contract");
    step("read the contract", contract.status === 200 && contract.body.fieldTypes.includes("enum"));
    const catalog = await api("GET", "/catalog");
    step("read the catalog", catalog.status === 200, catalog.body.objects.map((o) => o.definition.object));

    // Start a new object, and draft it.
    const object = `incoming_check_${Date.now() % 100000}`;
    const started = await api("POST", "/changes", { object, label: "Incoming check" });
    step("start a change for a new object", started.status === 200 && started.body.id, started.body);
    const id = started.body.id;
    const script = `// Moisture above the limit fails the check; the limit is 0.20 % unless the check says otherwise.
export default function ${object}_moisture(ctx) {
  if (ctx.event.kind === "change" && !ctx.event.changed.includes("moisture")) return ctx;
  if (ctx.data.moisture == null) return ctx;
  if (ctx.data.moisture < 0 || ctx.data.moisture > 5) {
    throw Object.assign(new Error("Moisture is a percentage between 0 and 5."), { field: "moisture" });
  }
  const limit = ctx.data.limit ?? 0.2;
  ctx.data.result = ctx.data.moisture > limit ? "fail" : "pass";
  return ctx;
}`;
    const definition = {
        object, label: "Incoming check", area: "Quality", description: "A check of an incoming material lot before use.", titleField: "reference",
        fields: {
            reference: { label: "Reference", type: "string", required: true },
            supplier_lot: { label: "Supplier lot", type: "string", required: true },
            moisture: { label: "Moisture %", type: "decimal" },
            limit: { label: "Limit %", type: "decimal" },
            result: { label: "Result", type: "enum", values: ["pending", "pass", "fail"], computed: true },
        },
        states: { initial: "open", list: ["open", "checked", "closed"], transitions: [
            { action: "check", label: "Mark checked", from: ["open"], to: "checked" },
            { action: "close", label: "Close", from: ["checked"], to: "closed" },
        ] },
        roles: ["inspector", "viewer"],
        stewards: { object: ["quality"] },
        policies: [
            { id: "check-read", roles: ["inspector", "viewer"], record: { read: true }, fields: { "*": "read" } },
            { id: "check-edit", roles: ["inspector"], record: { create: true }, when: { eq: [{ record: "state" }, "open"] }, fields: { reference: "write", supplier_lot: "write", moisture: "write", limit: "write" }, actions: { check: "allow" } },
            { id: "check-close", roles: ["inspector"], actions: { close: "allow" } },
        ],
        list: { columns: ["reference", "supplier_lot", "moisture", "result"] },
        form: { sections: [{ label: "Check", fields: ["reference", "supplier_lot", "moisture", "limit", "result"] }] },
        rules: [{ script: `${object}_moisture`, writes: ["result"] }],
    };
    const saved = await api("PUT", `/changes/${id}`, { reason: "Quality wants incoming material checked for moisture before use.", definitions: { [object]: definition }, scripts: { [`${object}_moisture`]: script } });
    step("save the draft (definition + script)", saved.status === 200, saved.body.problems);

    // Check the work before a person sees it.
    const tested = await api("POST", `/scripts/${object}_moisture/test`, { source: script, tests: [
        { name: "over the limit fails", ctx: { event: { kind: "change", changed: ["moisture"] }, data: { moisture: 0.3 } }, writes: ["result"], expect: { data: { result: "fail" } } },
        { name: "under a custom limit passes", ctx: { event: { kind: "change", changed: ["moisture"] }, data: { moisture: 0.3, limit: 0.5 } }, writes: ["result"], expect: { data: { result: "pass" } } },
        { name: "out of range is refused on the field", ctx: { event: { kind: "change", changed: ["moisture"] }, data: { moisture: 9 } }, throws: { field: "moisture", message: "between 0 and 5" } },
        { name: "other changes are disregarded", ctx: { event: { kind: "change", changed: ["reference"] }, data: { moisture: 0.9 } }, writes: ["result"], expect: { data: {} } },
    ] });
    step("test the script in the sandbox", tested.body?.failed === 0 && tested.body?.passed === 4, tested.body?.results?.map((r) => `${r.name}: ${r.passed ? "pass" : "FAIL"}`));
    const broken = await api("POST", `/scripts/${object}_moisture/test`, { source: script.replace("ctx.data.result =", "ctx.data.results ="), tests: [{ name: "undeclared write", ctx: { event: { kind: "change", changed: ["moisture"] }, data: { moisture: 0.3 } }, writes: ["result"], expect: { data: { result: "fail" } } }] });
    step("a mistake is caught by the tests (undeclared write)", broken.body?.failed === 1 && broken.body.results[0].outcome === "fault", broken.body?.results?.[0]?.error?.detail);
    const sim = await api("POST", "/access/simulate", { definition, roles: ["viewer"], record: { state: "open" }, explain: { field: "moisture" } });
    step("simulate access: a viewer cannot write moisture", sim.body?.fields?.moisture === "r" && sim.body.explain.decision === "deny", sim.body?.why?.moisture);
    const pipe = await api("POST", "/pipe/run", { definition, scripts: { [`${object}_moisture`]: script }, ctx: { event: { kind: "save", changed: ["moisture"] }, data: { reference: "IC-1", supplier_lot: "S-9", moisture: 0.1 } } });
    step("run the whole pipe on a save", pipe.body?.ok && pipe.body.data.result === "pass", pipe.body?.trace);

    const change = await api("GET", `/changes/${id}`);
    step("the change validates, with its approvers", change.body?.problems?.length === 0, change.body?.route?.map((r) => `${r.department}: ${r.because.join(", ")}`));
    step("the change records what the AI drafted", change.body?.aiEdits?.length >= 2, change.body?.aiEdits?.map((e) => `${e.via.agent}: ${e.elements.slice(0, 3).join(", ")}…`));

    // What it may not do.
    step("it cannot submit without the submit scope", (await api("POST", `/changes/${id}/submit`)).status === 403);
    step("there is no approve endpoint at all", (await api("POST", `/changes/${id}/approve`, {})).status === 404);
    step("bad JSON is refused", (await api("PUT", `/changes/${id}`, undefined, { raw: "{nope" })).status === 400);
    step("a person finds it in the designer, in design", change.body?.state === "design", `/design/c/${id}`);
    // A dry run by an AI reads as its person only: not as a draft service role nobody has approved.
    const asRole = await api("POST", "/dry-run", { kind: "service", name: "peek_lots", source: 'export default async function peek_lots(ctx) { return { lots: await ctx.records.list("lot") }; }', service: { name: "peek_lots", label: "Peek", runAs: "service", roles: { lot: ["quality"] }, uses: { objects: { lot: ["read"] } }, callers: { users: [], groups: [] }, stewards: ["quality"] }, run: { input: {} } });
    step("its dry run as a draft service role is refused: it runs as its person", asRole.status === 403 && asRole.body?.code === "dryrun.identity", asRole);
    // A token is its person's, never more: someone the designer is not shared with reads nothing through one.
    const outsider = await tokens.issue("olga", { name: "ai-agent test (no designer)", agent: "test agent" });
    const refusedAll = await Promise.all([api("GET", "/catalog", undefined, { token: outsider.token }), api("GET", "/objects/lot", undefined, { token: outsider.token }), api("GET", "/scripts/lot_round_qty", undefined, { token: outsider.token })]);
    await tokens.revoke("olga", outsider.id);
    step("a token whose person has no part in the designer is refused everything", refusedAll.every((r) => r.status === 403 && r.body?.code === "design.unshared"), refusedAll.map((r) => [r.status, r.body]));
} finally {
    const [row] = await pool.query("SELECT id FROM mes.api_tokens WHERE name = 'ai-agent test' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1").then((r) => r.rows);
    if (row) await tokens.revoke("dana", row.id);
    const after = await api("GET", "/me");
    step("a revoked token is refused", after.status === 401);
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
console.log(JSON.stringify(steps, null, 1));
console.log(failed.length ? `\n${failed.length} step(s) FAILED` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
