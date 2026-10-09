// Transactions and named queries as web services, and every call counted (DESIGN.md §25.7, §23.3, §38.1;
// docs/contracts/http-apis 1.3), end to end on the seed's model:
//   1. Dana designs a transaction and a named query published over HTTP. What may not be published is named:
//      a signed transaction, a query nobody may read, a name another kind publishes already.
//   2. Approved; OpenAPI describes them for Olga's token (transaction:run, query:run).
//   3. The transaction over HTTP: a lot by its title; its preview writes nothing; the run, once per key; a lot
//      that is not there named on its input; a token without the scope, or the wrong method, refused.
//   4. The query over HTTP: a page of its rows as objects, the next page, its parameters typed and checked;
//      Sam (not among its web callers) refused.
//   5. The same transaction from Olga's screen: both ways in counted apart, under its own name, with who
//      called, why refusals were, and the statements it sent (the Database area).
//   6. A change taking an input from the transaction is refused at the fitness test, naming Olga's token.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/web-designs.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { createTokens } from "../server/ai-api.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;

const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
const { url: mes } = await app.listen({ port: 0 });
const sessions = {};
for (const user of ["dana", "vera", "eli", "sam", "olga", "quinn", "ivan", "ines"]) {
    sessions[user] = `wd-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
};
const approveAll = async (id) => {
    let state = null;
    for (let round = 0; round < 5 && state !== "executed"; round++) for (const u of Object.keys(sessions)) {
        const seen = await call(u, "design.change", { id, as: u });
        for (const department of seen?.can?.approveFor ?? []) state = (await call(u, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
    }
    return state;
};
const words = (r) => (r?.problems ?? []).map((p) => p.message).join("\n");
// The web, as an outside system calls it.
const web = async (token, method, path, { body, headers = {} } = {}) => {
    const res = await fetch(`${mes}/svc/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
};

try {
    // ---- 1. the design ----
    const TX = `web_note_t${tag}`;
    const Q = `lots_state_w${tag}`;
    const [lotDef] = await db.query("SELECT body FROM mes.definitions WHERE object = 'lot' AND status = 'published'");
    const lot = {
        ...lotDef.body,
        fields: { ...lotDef.body.fields, [`web_note_${tag}`]: { label: "Note from the web", type: "string" } },
        policies: [...lotDef.body.policies, { id: `wd-${tag}`, roles: ["operator"], via: [TX], fields: { [`web_note_${tag}`]: "write" } }],
    };
    const tx = {
        name: TX, label: "Note a lot", description: "A lot's note, from the ERP or the screen.",
        inputs: { lot: { label: "Lot", type: "ref", to: "lot", required: true }, note: { label: "Note", type: "string", required: true } },
        appearsOn: { object: "lot", states: ["created", "in_process"], fills: "lot" }, require: [],
        steps: [{ on: "lot", set: { [`web_note_${tag}`]: { input: "note" } } }],
        confirm: false, callers: { users: ["olga"], groups: [] }, stewards: ["production"], http: { enabled: true },
        scenarios: [{ name: "a note", records: { wo: { object: "work_order", where: { wo_no: ["WO-1001"] } }, lot: { object: "lot", data: { lot_no: `WDS-${tag}`, item: "PA66-NAT-25", work_order: "@wo", qty: 10, uom: "kg" } } }, steps: [{ as: "olga", do: { transaction: TX, input: { lot: "@lot", note: "hello" } }, expect: { ok: true } }] }],
    };
    const q = { name: Q, label: "Lots in a state (web)", description: "", sql: "SELECT id, lot_no, state, qty\nFROM lot\nWHERE state = :state\nORDER BY lot_no", params: { state: { type: "string", label: "State", required: true } }, limit: 200, tests: [{ name: "created", params: { state: "created" } }], stewards: ["production"], http: { enabled: true, callers: { users: ["olga"], groups: [] } } };
    const { id } = await call("dana", "design.start", { transaction: TX, label: "Note a lot" });
    const fresh = await call("dana", "design.change", { id, as: "dana" });
    const wrong = await call("dana", "design.save", { id, seen: fresh.draft_rev, reason: "The ERP notes lots.", definitions: { lot }, transactions: { [TX]: { ...tx, signature: { meaning: "Performed" } } },
        queries: { [Q]: { ...q, http: { enabled: true } }, [TX]: { ...q, name: TX } } });
    step("what may not be published over HTTP is named: a signed transaction, a query nobody may read, a name a transaction publishes already",
        /an outside system may not run it over HTTP/.test(words(wrong)) && new RegExp(`${Q}: Name who may read it over HTTP`).test(words(wrong)) && new RegExp(`${TX} is published over HTTP as a transaction already`).test(words(wrong)), wrong.error ?? words(wrong));
    const saved = await call("dana", "design.save", { id, seen: wrong.draft_rev ?? fresh.draft_rev, reason: "The ERP notes lots.", definitions: { lot }, transactions: { [TX]: tx }, queries: { [Q]: q, [TX]: null } });
    const submitted = await call("dana", "design.submit", { id });
    await call("vera", "design.review", { id, decision: "pass" });
    step("the transaction and the query, published over HTTP, are approved and executed", !saved.problems?.length && !submitted.error && (await approveAll(id)) === "executed", { problems: words(saved), submitted: submitted.error });

    // ---- 2. described for Olga's token ----
    const tokens = createTokens(db);
    const olga = (await tokens.issue("olga", { name: `ERP ${tag}`, agent: "erp", scopes: ["transaction:run", "query:run"] })).token;
    const olgaSvc = (await tokens.issue("olga", { name: `Svc ${tag}`, agent: "erp", scopes: ["service:call"] })).token;
    const sam = (await tokens.issue("sam", { name: `BI ${tag}`, agent: "bi", scopes: ["query:run"] })).token;
    const doc = await web(olga, "GET", "/openapi.json");
    const paths = doc.json?.paths ?? {};
    step("OpenAPI describes them for Olga's token: the run, its preview (a lot by id or title), the query's parameters and paging",
        doc.status === 200 && paths[`/${TX}`]?.post && paths[`/${TX}/preview`]?.post && /record's id, or its title/.test(paths[`/${TX}`].post.requestBody.content["application/json"].schema.properties.lot.description)
        && paths[`/${Q}`]?.get?.parameters?.some((p) => p.name === "state" && p.required) && paths[`/${Q}`].get.parameters.some((p) => p.name === "offset") && /qty/.test(paths[`/${Q}`].get.description), Object.keys(paths));

    // ---- 3. the transaction over HTTP ----
    const [l4713] = await db.query("SELECT id, data FROM mes.records WHERE object = 'lot' AND data->>'lot_no' = '4713'");
    const noteOf = async () => (await db.query("SELECT data->>$1 AS n FROM mes.records WHERE id = $2", [`web_note_${tag}`, l4713.id]))[0].n;
    const preview = await web(olga, "POST", `/${TX}/preview`, { body: { lot: "4713", note: "from ERP" } });
    step("its preview: the lot by its title, what it would change, and nothing written", preview.status === 200 && preview.json?.changes?.length === 1 && preview.json.changes[0].id === l4713.id && (await noteOf()) === null, preview.json);
    const key = `erp-${tag}-0001`;
    const ran = await web(olga, "POST", `/${TX}`, { body: { lot: "4713", note: "from ERP" }, headers: { "idempotency-key": key } });
    const again = await web(olga, "POST", `/${TX}`, { body: { lot: "4713", note: "from ERP" }, headers: { "idempotency-key": key } });
    const runs = await db.query("SELECT after FROM mes.audit_log WHERE object = '$transaction' AND action = $1", [`run:${TX}`]);
    step("run over HTTP: written as Olga, its audit naming the web and her token; the same key again answers the first run, not a second",
        ran.status === 200 && ran.json?.ok && (await noteOf()) === "from ERP" && again.status === 200 && again.json?.run === ran.json.run && runs.length === 1 && runs[0].after.via?.http === `ERP ${tag}` && ran.headers.get("api-version") === "1.3", { ran: ran.json, again: again.json, runs: runs.length });
    const missing = await web(olga, "POST", `/${TX}`, { body: { lot: "NO-SUCH", note: "x" } });
    const extra = await web(olga, "POST", `/${TX}`, { body: { lot: "4713", note: "x", colour: "red" } });
    const empty = await web(olga, "POST", `/${TX}`, { body: { lot: "4713" } });
    step("a lot that is not there, an input it does not have, a required one missing: 400, each on its input, nothing run",
        missing.status === 400 && /No Lot "NO-SUCH"/.test(missing.json?.fields?.lot ?? "") && extra.status === 400 && /has no input colour/.test(extra.json?.fields?.colour ?? "") && empty.status === 400 && empty.json?.fields?.note && (await noteOf()) === "from ERP", { missing: missing.json, extra: extra.json, empty: empty.json });
    const noScope = await web(olgaSvc, "POST", `/${TX}`, { body: { lot: "4713", note: "y" } });
    const wrongWay = await web(olga, "GET", `/${TX}`);
    step("a token without transaction:run is refused (scope.missing); a GET is the wrong way in (405, Allow: POST)",
        noScope.status === 403 && noScope.json?.code === "scope.missing" && wrongWay.status === 405 && wrongWay.headers.get("allow") === "POST", { noScope: noScope.json, wrongWay: wrongWay.status });

    // ---- 4. the query over HTTP ----
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1001'");
    for (const n of ["A", "B"]) await call("olga", "records.create", { object: "lot", data: { lot_no: `WD${n}-${tag}`, item: "PA66-NAT-25", work_order: wo.id, qty: 5, uom: "kg" } });
    const all = await web(olga, "GET", `/${Q}?state=created`);
    const first = await web(olga, "GET", `/${Q}?state=created&limit=1&sort=lot_no&dir=desc`);
    const second = await web(olga, "GET", `/${Q}?state=created&limit=1&sort=lot_no&dir=desc&offset=${first.json?.next}`);
    step("read over HTTP: its rows as objects by column, as Olga may read them; a page at a time, the next from the answer",
        all.status === 200 && all.json.columns.join() === "id,lot_no,state,qty" && all.json.rows.some((r) => r.lot_no === "4713" && typeof r.qty === "number") && all.json.next === null
        && first.json?.rows?.length === 1 && first.json.next === 1 && second.json?.rows?.length === 1 && second.json.rows[0].lot_no < first.json.rows[0].lot_no, { all: all.json, first: first.json, second: second.json });
    const noState = await web(olga, "GET", `/${Q}`);
    const bogus = await web(olga, "GET", `/${Q}?state=created&colour=red&limit=0`);
    const posted = await web(olga, "POST", `/${Q}`, { body: {} });
    const notHis = await web(sam, "GET", `/${Q}?state=created`);
    step("its parameters checked (a required one missing, one it has not, a bad limit: 400 on each); a POST refused (405); Sam, not among its web callers, refused",
        noState.status === 400 && /required/.test(noState.json?.error ?? "") && bogus.status === 400 && bogus.json?.fields?.colour && bogus.json.fields.limit && posted.status === 405 && posted.headers.get("allow") === "GET"
        && notHis.status === 403 && notHis.json?.code === "query.denied", { noState: noState.json, bogus: bogus.json, posted: posted.status, notHis: notHis.json });

    // ---- 5. the same transaction from Olga's screen, and every call counted ----
    const [lB] = await db.query("SELECT id FROM mes.records WHERE object = 'lot' AND data->>'lot_no' = $1", [`WDB-${tag}`]);
    const fromScreen = await call("olga", "transactions.run", { name: TX, input: { lot: lB.id, note: "from the screen" } });
    const change = await call("dana", "design.start", { organization: true });
    const org = (await call("dana", "design.change", { id: change.id, as: "dana" })).content.organization;
    org.roles = { ...(org.roles ?? {}), database: { administrator: ["user:ivan"] } };
    await call("dana", "design.save", { id: change.id, reason: "Ivan reads the calls.", organization: org });
    await call("dana", "design.submit", { id: change.id });
    await call("vera", "design.review", { id: change.id, decision: "pass" });
    await approveAll(change.id);
    const o = await call("ivan", "database.overview", { hours: 1 });
    const txCalls = o.calls?.find((c) => c.kind === "transaction" && c.name === TX);
    const qCalls = o.calls?.find((c) => c.kind === "query" && c.name === Q);
    step("its calls counted under its own name, the web and the screen apart, refusals apart; the query's reads over the web too",
        !fromScreen.error && txCalls?.channels?.web >= 4 && txCalls.channels.page === 1 && txCalls.refused >= 2 && o.calls.some((c) => c.kind === "preview" && c.name === TX && c.channels.web === 1)
        && qCalls?.channels?.web >= 3 && o.calls.some((c) => c.kind === "platform" && c.name === "records.list" || c.kind === "platform"), { txCalls, qCalls });
    const one = await call("ivan", "database.call", { kind: "transaction", name: TX, hours: 1 });
    step("one opened: by way in, who called (Olga by her token, and at her screen), why refused (by code, never a value), and the statements it sent",
        one.channels?.some((c) => c.channel === "web") && one.callers?.some((c) => c.key === `olga (token ERP ${tag})`) && one.callers.some((c) => c.key === "olga") && one.codes?.some((c) => c.key === "transaction.input")
        && !JSON.stringify(one).includes("NO-SUCH") && one.source === `transaction:${TX}` && one.statements?.length > 0, { channels: one.channels, callers: one.callers, codes: one.codes, statements: one.statements?.length });

    // ---- 6. a change that would break Olga's token ----
    const { id: id2 } = await call("dana", "design.start", { transaction: TX });
    const narrower = { ...tx, inputs: { lot: tx.inputs.lot }, steps: [{ on: "lot", set: { [`web_note_${tag}`]: "fixed" } }], scenarios: [{ ...tx.scenarios[0], steps: [{ ...tx.scenarios[0].steps[0], do: { transaction: TX, input: { lot: "@lot" } } }] }] };
    const s2 = await call("dana", "design.save", { id: id2, reason: "No note any more.", transactions: { [TX]: narrower } });
    const r2 = await call("dana", "design.submit", { id: id2 });
    const [fit] = await db.query("SELECT fitness FROM mes.change_requests WHERE id = $1", [id2]);
    const callers = fit?.fitness?.checks?.find((c) => c.id === "callers");
    step("a change taking its note away is refused at the fitness test, naming Olga's token and its calls",
        !s2.problems?.length && r2.code === "design.unfit" && callers?.status === "fail" && new RegExp(`transaction ${TX} would break its callers, olga \\(token ERP ${tag}: 1 call`).test(callers.items.join(" ")) && /input note would be gone/.test(callers.items.join(" ")), { s2: words(s2), r2, callers });
    await call("dana", "design.withdraw", { id: id2, reason: "Test done." });

    // Put back: Ivan no longer a database administrator.
    const back = await call("dana", "design.start", { organization: true });
    const org2 = (await call("dana", "design.change", { id: back.id, as: "dana" })).content.organization;
    delete org2.roles.database;
    await call("dana", "design.save", { id: back.id, reason: "Back as it was.", organization: org2 });
    await call("dana", "design.submit", { id: back.id });
    await call("vera", "design.review", { id: back.id, decision: "pass" });
    step("put back: Ivan is no longer a database administrator", (await approveAll(back.id)) === "executed");
} catch (error) {
    step("the test ran to the end", false, { error: error.message, stack: error.stack });
} finally {
    await app.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail, null, 1)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
