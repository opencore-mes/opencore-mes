// Named queries (§23.1) and a plan's dropdown drawn from one (§32.6), with a node's script setting the context
// variable the list reads, end to end over HTTP on the seed's machines and deviations:
//   1. Dana designs a query, the machines of a kind (:kind): its mistakes named (a parameter not declared,
//      one declared and never used); tried as her (two presses), as Ivan (who reads no machine: none), and
//      without its required value (refused, in words).
//   2. In the same change, a plan on deviations: its start's script, written as a node script, sets the
//      context variable `kind` (an oven for a critical deviation, a press otherwise); its input screen asks
//      for a tool from the query, its parameter bound to that variable, the machine's id kept, its number and
//      name shown. Its mistakes named (a query that does not exist, a required parameter not bound, a
//      parameter read from something else than the context or the user).
//   3. The fitness test runs the query's tests as the submitter; a broken one fails it, naming the column.
//      Approved, executed: the query is published, versioned, listed and viewed.
//   4. A major deviation: the plan waits at Pick a tool; Quinn's dropdown lists the two presses, as
//      "M-101 · Press 1". A critical one: the oven only. A value not on the list is refused; one on it is
//      kept in the context, and the plan ends.
//   5. The AI's contract names queries; its catalog lists the live one.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/named-queries.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { contract } from "../server/design-tools.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const Q = `machines_of_kind_t${tag}`;
const PLAN = `pick_tool_t${tag}`;
const HOOK = `pick_tool_t${tag}_enter`;
let app = null;
try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    const { url: mes } = await app.listen({ port: 0 });
    const people = ["dana", "vera", "eli", "quinn", "olga", "sam", "ivan", "ines"];
    const sessions = {};
    for (const user of people) {
        sessions[user] = `nq-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? (body && typeof body === "object" && !Array.isArray(body) ? { ok: true, ...body } : { ok: true, value: body }) : { ok: false, status: res.status, ...body };
    };
    const key = () => `nq-${randomBytes(6).toString("hex")}`;

    // ---- 1. the query ----
    const sql = "SELECT id, machine_id, name, kind FROM machine WHERE kind = :kind ORDER BY machine_id";
    const query = { name: Q, label: "Machines of a kind", description: "The machines of one kind, for a plan that picks one.", sql, params: { kind: { type: "string", label: "Kind", required: true } }, limit: 50, tests: [{ name: "presses", params: { kind: "press" } }, { name: "ovens", params: { kind: "oven" } }], stewards: ["engineering"] };
    const { id } = await call("dana", "design.start", { query: Q, label: "Machines of a kind" });
    const ch = await call("dana", "design.change", { id, as: "dana" });
    const started = ch.content?.queries?.[Q];
    const bad = await call("dana", "design.save", { id, seen: ch.draft_rev, reason: "Plans pick a tool of the right kind.", queries: { [Q]: { ...query, sql: "SELECT id FROM machine WHERE kind = :kind AND capacity > :size", params: { kind: { type: "string" }, line: { type: "integer" } } } } });
    const messages = (r) => (r.problems ?? []).map((p) => p.message).join("\n");
    step("a new query starts from its template, in a change; its mistakes are named: a parameter used and not declared, one declared and never used",
        started?.sql && started.stewards?.length && /:size is used but not declared/.test(messages(bad)) && /line is declared but the SELECT never uses :line/.test(messages(bad)), { started, problems: bad.problems });
    const asDana = await call("dana", "query.named", { sql, params: query.params, values: { kind: "press" } });
    const asIvan = await call("ivan", "query.named", { sql, params: query.params, values: { kind: "press" } });
    const missing = await call("dana", "query.named", { sql, params: query.params, values: {} });
    // (Other suites may have made presses and ovens of their own: the seed's are among them.)
    const presses = (asDana.rows ?? []).map((r) => `${r[1]} · ${r[2]}`);
    step("tried in the designer, as whoever tries it: Dana reads the presses (the seed's two among them), Ivan (no role on machines) none; without its required value it is refused, in words",
        asDana.ok && asDana.rows?.length >= 2 && asDana.rows.every((r) => r[3] === "press") && ["M-101", "M-102"].every((m) => asDana.rows.some((r) => r[1] === m)) && asDana.columns?.join() === "id,machine_id,name,kind" && asIvan.ok && asIvan.rows?.length === 0 && missing.status === 400 && /Kind is required/.test(missing.error), { asDana, asIvan, missing });

    // ---- 2. the plan, its node script and its dropdown ----
    const hook = `// On entering the start: the kind of tool a deviation needs, for the list after.
export default function ${HOOK}(ctx) {
  ctx.context.kind = ctx.context.deviation.severity === "critical" ? "oven" : "press";
  return ctx;
}`;
    const plan = {
        name: PLAN, label: "Pick a tool", kind: "plan", participants: { deviation: { object: "deviation", as: "subject" } }, context: { kind: "press" },
        nodes: {
            start: { kind: "start", label: "Deviation raised", when: { in: [{ context: "deviation.severity" }, ["major", "critical"]] }, onEnter: HOOK },
            pick: { kind: "input_screen", label: "Pick a tool", for: { users: [], groups: ["quality"] }, fields: [{ name: "tool", label: "Tool", type: "query", query: Q, value: "id", display: ["machine_id", "name"], params: { kind: { context: "kind" } }, required: true }] },
            done: { kind: "end", label: "Tool picked", outcome: "picked" },
        },
        edges: [{ from: "start", to: "pick" }, { from: "pick", to: "done" }], stewards: ["quality"],
        scenarios: [{ name: "a major deviation waits for a tool", records: {}, steps: [{ as: "quinn", do: { create: "deviation", data: { title: "Burr", severity: "major" }, key: "dev" }, expect: { ok: true, node: { dev: "pick" } } }] }],
    };
    const hookTests = [{ name: "a critical deviation needs an oven", run: { event: { kind: "enter", node: "start", label: "Deviation raised", flow: PLAN }, context: { deviation: { severity: "critical" } }, writes: [] }, expect: { output: { context: { kind: "oven" } } } }];
    const field = (patch) => ({ ...plan, nodes: { ...plan.nodes, pick: { ...plan.nodes.pick, fields: [{ ...plan.nodes.pick.fields[0], ...patch }] } } });
    let rev = (await call("dana", "design.change", { id, as: "dana" })).draft_rev;
    const wrong = await call("dana", "design.save", { id, seen: rev, queries: { [Q]: query }, flows: { [PLAN]: field({ query: "no_such_query" }) }, scripts: { [HOOK]: hook }, tests: { [HOOK]: hookTests } });
    rev = wrong.draft_rev ?? (await call("dana", "design.change", { id, as: "dana" })).draft_rev;
    const twoFields = { ...plan, nodes: { ...plan.nodes, pick: { ...plan.nodes.pick, fields: [{ ...plan.nodes.pick.fields[0], params: { kind: { record: "kind" } } }, { ...plan.nodes.pick.fields[0], name: "spare", label: "Spare tool", params: {} }] } } };
    const unbound = await call("dana", "design.save", { id, seen: rev, flows: { [PLAN]: twoFields } });
    rev = unbound.draft_rev ?? (await call("dana", "design.change", { id, as: "dana" })).draft_rev;
    step("the plan's dropdown is checked: a query that does not exist; a parameter read from something else than the context or the user; a required one not bound",
        /"no_such_query" is not a query/.test(messages(wrong)) && /kind reads record/.test(messages(unbound)) && /needs Kind: bind it/.test(messages(unbound)), { wrong: wrong.problems, unbound: unbound.problems });
    const saved = await call("dana", "design.save", { id, seen: rev, flows: { [PLAN]: plan } });
    step("the query, the plan and its node script together: no problems", saved.ok && !saved.problems?.length, saved.problems);

    // ---- 3. fitness, approval, execution ----
    const fit = await call("dana", "design.fitness", { id });
    const qcheck = fit.checks?.find((c) => c.id === "queries");
    const tcheck = fit.checks?.find((c) => c.id === "tests");
    step("the fitness test runs the query's tests as the submitter, and the node script's test case", fit.passed && qcheck?.status === "pass" && /2 test run/.test(qcheck.summary) && tcheck?.status === "pass", { passed: fit.passed, checks: fit.checks?.map((c) => [c.id, c.status, c.summary, c.items]) });
    // A broken query fails it, naming the column; the plan's columns are checked against what the query gives.
    const { id: brokenId } = await call("dana", "design.start", { query: `${Q}_broken` });
    const bc = await call("dana", "design.change", { id: brokenId, as: "dana" });
    await call("dana", "design.save", { id: brokenId, seen: bc.draft_rev, reason: "x", queries: { [`${Q}_broken`]: { ...query, name: `${Q}_broken`, sql: "SELECT id, nope FROM machine WHERE kind = :kind" } } });
    const brokenFit = await call("dana", "design.fitness", { id: brokenId });
    const brokenCheck = brokenFit.checks?.find((c) => c.id === "queries");
    await call("dana", "design.withdraw", { id: brokenId });
    step("…a query that does not run fails it, in the database's own words, naming the column", !brokenFit.passed && brokenCheck?.status === "fail" && brokenCheck.items.some((m) => /nope/.test(m)), brokenCheck);
    await call("dana", "design.submit", { id });
    await call("vera", "design.review", { id, decision: "pass" });
    let state = null;
    for (let round = 0; round < 4 && state !== "executed"; round++) for (const user of people) {
        const seen = await call(user, "design.change", { id, as: user });
        for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
    }
    const [published] = await db.query("SELECT version, status, body FROM mes.queries WHERE name = $1", [Q]);
    const home = await call("dana", "design.home", { as: "dana" });
    const view = await call("eli", "design.view", { kind: "query", name: Q, as: "eli" });
    step("approved by its stewards and executed: published as version 1, on the designer's home with its parameters, viewed as it is live",
        state === "executed" && published?.version === 1 && published.status === "published" && published.body.sql === sql && home.queries?.some((q) => q.name === Q && q.params?.kind?.required) && view.content?.queries?.[Q]?.label === "Machines of a kind",
        { state, published, view: view.content?.queries ?? view });

    // ---- 4. the plan running ----
    const planOf = async (devId) => (await db.query("SELECT * FROM mes.flow_runs WHERE subject_id = $1 AND flow = $2", [devId, PLAN]))[0] ?? null;
    const major = await call("quinn", "records.create", { object: "deviation", data: { title: `Burr ${tag}`, severity: "major" }, key: key() });
    const run = await planOf(major.id);
    const task = await call("quinn", "flows.task", { run: run?.id, as: "quinn" });
    const options = task.fields?.[0]?.options ?? [];
    step("a major deviation: the node script set kind to press; Quinn's dropdown lists the presses, each its number and name",
        run?.node === "pick" && run.context.kind === "press" && task.fields?.[0]?.type === "query" && options.length === presses.length && options.some((o) => o.label === "M-101 · Press 1") && options.every((o) => presses.includes(o.label) && typeof o.value === "string"), { run, field: task.fields?.[0] });
    const critical = await call("quinn", "records.create", { object: "deviation", data: { title: `Fire ${tag}`, severity: "critical" }, key: key() });
    const runC = await planOf(critical.id);
    const taskC = await call("quinn", "flows.task", { run: runC?.id, as: "quinn" });
    const ovens = taskC.fields?.[0]?.options ?? [];
    step("a critical one: the script set kind to oven, and the list follows: ovens only, the curing oven among them", runC?.context.kind === "oven" && ovens.some((o) => o.label === "OV-1 · Curing oven") && !ovens.some((o) => presses.includes(o.label)), { runC, ovens });
    const notOnList = await call("quinn", "flows.act", { run: run.id, values: { tool: ovens[0]?.value } });
    const picked = await call("quinn", "flows.act", { run: run.id, values: { tool: options[1].value } });
    const after = await planOf(major.id);
    step("a value not on the person's list is refused, in words; one on it is kept in the context, and the plan ends",
        notOnList.status === 400 && /Tool: choose one of the list/.test(notOnList.fields?.tool ?? "") && picked.ok && after.state === "ended" && after.context.tool === options[1].value, { notOnList, picked, after });

    // ---- 5. the AI ----
    const c = contract();
    const catalog = await call("dana", "design.home", { as: "dana" });
    step("the AI's contract describes named queries and the dropdown drawn from one", /SELECT over the query views/.test(c.queries?.summary ?? "") && /type 'query'/.test(c.flows?.nodes ?? "") && catalog.queries?.length >= 1, { queries: c.queries });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close?.().catch(() => {});
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
