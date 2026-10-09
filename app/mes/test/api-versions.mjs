// The HTTP APIs versioned, with notice before anything they promise changes (docs/contracts/http-apis,
// DESIGN.md §31.2, §31.5, §31.6), end to end against a running server:
//   1. The API kit: /ai/v1 keeps every promised operation and offers nothing unpromised, every answer says
//      API-Version, the error envelope and statuses hold, and the /svc/v1 envelope.
//   2. A plant's web service, designed, approved and called by ERP over HTTP.
//   3. A change that would break ERP (an input gone, one made required) is refused at the fitness test,
//      naming ERP and its calls, and saying how to give notice.
//   4. Notice given: the service deprecated (since, sunset, successor). Every call is answered with
//      Deprecation, Sunset and Link headers; its OpenAPI operation says deprecated, until when and what
//      to use instead; the kit checks a call and its retry. Before the sunset, the breaking change is
//      still refused, saying when it may go through.
//   5. Its sunset passed: the breaking change goes through, the fitness test warning what callers will
//      notice. A breaking change to a web service nobody called is a warning, not a refusal.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/api-versions.mjs
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { createTokens } from "../server/ai-api.js";
import { runApiKit } from "../../../docs/contracts/http-apis/kit.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const SVC = `api_echo_t${tag}`;
const QUIET = `api_quiet_t${tag}`;
const people = ["dana", "vera", "eli", "sam", "quinn", "olga", "ivan", "ines"];

const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
const { url: mes } = await app.listen({ port: 0 });
const sessions = {};
for (const user of people) {
    sessions[user] = `av-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    return res.ok ? body : { error: body.error, status: res.status, code: body.code, problems: body.problems };
};
const approve = async (id) => {
    const submitted = await call("dana", "design.submit", { id });
    if (submitted.error) return { submitted };
    await call("vera", "design.review", { id, decision: "pass" });
    let state = null;
    for (let round = 0; round < 4 && state !== "executed"; round++) {
        for (const user of people) {
            const seen = await call(user, "design.change", { id, as: user });
            for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
        }
    }
    return { state };
};
const fitnessOf = async (id) => (await db.query("SELECT fitness FROM mes.change_requests WHERE id = $1", [id]))[0]?.fitness;
const callersCheck = async (id) => (await fitnessOf(id))?.checks?.find((c) => c.id === "callers");
// A change to a live service: opened as it is live, changed, saved.
const changeService = async (name, change, reason) => {
    const { id } = await call("dana", "design.start", { service: name });
    const opened = await call("dana", "design.change", { id, as: "dana" });
    const saved = await call("dana", "design.save", { id, reason, services: { [name]: { ...opened.content.services[name], ...change } } });
    return { id, saved };
};
const svc = async (token, name, input, headers = {}) => {
    const res = await fetch(`${mes}/svc/v1/${name}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(input) });
    return { status: res.status, body: await res.json(), headers: res.headers };
};

try {
    const tokens = createTokens(db);
    const danaToken = (await tokens.issue("dana", { name: `api kit ${tag}`, agent: "kit", scopes: ["design:read", "service:call"] })).token;
    const erpToken = (await tokens.issue("erp", { name: `ERP ${tag}`, agent: "erp", scopes: ["service:call"] })).token;

    // ---- 1. the kit ----
    const kit = await runApiKit({ url: mes, token: danaToken });
    step(`the API kit: ${kit.steps.filter((s) => !s.skipped).length} checks of /ai/v1 and /svc/v1 against the contract hold`, kit.ok, kit.steps.filter((s) => !s.ok));

    // ---- 2. a web service ERP calls ----
    const script = (name) => `// Gives back what ERP sent.
export default async function ${name}(ctx) {
  ctx.output = { lot: ctx.input.lot, qty: ctx.input.qty ?? null };
  return ctx;
}`;
    const service = (name, label) => ({ name, label, description: "Gives back what ERP sent.", input: { lot: { label: "Lot", type: "string", required: true }, qty: { label: "Quantity", type: "integer" } }, http: { enabled: true }, callers: { users: ["erp"], groups: [] }, on: [], runAs: "caller", uses: { connections: [], objects: {} }, stewards: ["production"] });
    const tests = (name) => [{ name: "a lot given back", run: { input: { lot: "L1", qty: 2 } }, expect: { ok: true, output: { lot: "L1", qty: 2 } } }];
    const { id: made } = await call("dana", "design.start", { service: SVC, label: "Echo (API test)" });
    await call("dana", "design.save", { id: made, reason: "A web service ERP calls.", services: { [SVC]: service(SVC, "Echo (API test)"), [QUIET]: service(QUIET, "Quiet (API test)") }, scripts: { [SVC]: script(SVC), [QUIET]: script(QUIET) }, tests: { [SVC]: tests(SVC), [QUIET]: tests(QUIET) } });
    const live = await approve(made);
    const first = await svc(erpToken, SVC, { lot: "L-1", qty: 3 });
    step("a plant's web service is designed, approved and called by ERP over HTTP, answered with API-Version", live.state === "executed" && first.status === 200 && first.body.output?.lot === "L-1" && first.headers.get("api-version") === "1.3" && !first.headers.get("deprecation"), { live, first: first.body });

    // ---- 3. a change that would break ERP ----
    const breaking = { input: { lot: { label: "Lot", type: "string", required: true }, qty: { label: "Quantity", type: "integer", required: true } } };
    const b1 = await changeService(SVC, { input: { lot: { label: "Lot", type: "string", required: true } } }, "Quantity is not needed.");
    const r1 = await call("dana", "design.submit", { id: b1.id });
    const c1 = await callersCheck(b1.id);
    await call("dana", "design.withdraw", { id: b1.id });
    const b2 = await changeService(SVC, breaking, "Quantity is required.");
    await call("dana", "design.submit", { id: b2.id });
    const c2 = await callersCheck(b2.id);
    await call("dana", "design.withdraw", { id: b2.id });
    step("a change that would break ERP (an input gone; one made required) is refused at the fitness test, naming ERP and its calls, and saying how to give notice",
        r1.code === "design.unfit" && c1?.status === "fail" && /would break its callers, erp \(token ERP \d+: 1 call, the last \d{4}-\d{2}-\d{2}\): input qty would be gone/.test(c1.items.join(" ")) && /mark it deprecated with a sunset/.test(c1.items.join(" ")) && c2?.status === "fail" && /input qty would be required/.test(c2.items.join(" ")),
        { r1, c1, c2 });

    // ---- 4. notice given ----
    const today = new Date().toISOString().slice(0, 10);
    const sunset = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
    const n = await changeService(SVC, { deprecated: { since: today, sunset, successor: `${SVC}_v2`, note: "Quantity becomes required." } }, "Notice to ERP: quantity will be required.");
    const noticed = await approve(n.id);
    const told = await svc(erpToken, SVC, { lot: "L-2" });
    const doc = await fetch(`${mes}/svc/v1/openapi.json`, { headers: { authorization: `Bearer ${erpToken}` } }).then((r) => r.json());
    const op = doc.paths?.[`/${SVC}`]?.post;
    const kit2 = await runApiKit({ url: mes, token: erpToken, service: SVC, input: { lot: "L-3" } });
    step("notice given: the service deprecated (since, sunset, successor); every call answers Deprecation, Sunset and Link, its OpenAPI operation says deprecated and until when, and the kit checks a call and its retry",
        noticed.state === "executed" && told.status === 200 && /^@\d+$/.test(told.headers.get("deprecation") ?? "") && told.headers.get("sunset") === new Date(sunset).toUTCString() && told.headers.get("link") === `</svc/v1/${SVC}_v2>; rel="successor-version"` && op?.deprecated === true && new RegExp(`Deprecated since ${today}; it may change or go after ${sunset}: use ${SVC}_v2`).test(op.description) && kit2.ok,
        { kit2: kit2.steps.filter((s) => !s.ok), noticed, headers: Object.fromEntries(told.headers) });
    const b3 = await changeService(SVC, breaking, "Quantity is required.");
    await call("dana", "design.submit", { id: b3.id });
    const c3 = await callersCheck(b3.id);
    await call("dana", "design.withdraw", { id: b3.id });
    step("before its sunset, the breaking change is still refused, saying when it may go through", c3?.status === "fail" && new RegExp(`It is deprecated, and its sunset is ${sunset}: change it after then`).test(c3.items.join(" ")), c3);

    // ---- 5. its sunset passed; a service nobody called ----
    const past = await changeService(SVC, { deprecated: { since: "2026-01-05", sunset: "2026-04-05", successor: `${SVC}_v2` } }, "The notice ran from January to April.");
    await approve(past.id);
    const b4 = await changeService(SVC, breaking, "Quantity is required.");
    const through = await approve(b4.id);
    const c4 = await callersCheck(b4.id);
    const b5 = await changeService(QUIET, breaking, "Quantity is required.");
    const quiet = await approve(b5.id);
    const c5 = await callersCheck(b5.id);
    step("its sunset passed, the breaking change goes through, the fitness test warning what its callers (told) will notice; a breaking change to a web service nobody called is a warning too",
        through.state === "executed" && c4?.status === "warn" && /Its callers were told \(deprecated since 2026-01-05, its sunset 2026-04-05 has passed\)/.test(c4.items.join(" ")) && quiet.state === "executed" && c5?.status === "warn" && /input qty would be required\. Nobody called it over HTTP in the last 30 days/.test(c5.items.join(" ")),
        { quiet, failing: (await fitnessOf(b5.id))?.checks?.filter((c) => c.status === "fail"), through, c4, c5 });
} catch (error) {
    step("the test ran to the end", false, error.stack ?? String(error));
} finally {
    await app.close().catch(() => {});
    await pool.end().catch(() => {});
    for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok || s.detail === undefined ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
    const failed = steps.filter((s) => !s.ok).length;
    console.log(failed ? `\n${failed} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
    process.exit(failed ? 1 : 0);
}
