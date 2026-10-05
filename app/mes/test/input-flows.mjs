// Input flows (§32.13), end to end against a running server:
//   1. A designer draws an input flow (a flow template of kind input) and a transaction that names it,
//      in one change, approved like any other; the transaction's form gets the flow with it.
//   2. What does not fit is refused, by name: a step of a route in an input flow, a key no keyboard
//      sends, an ask for an input the transaction does not have or nobody types, a run of another.
//   3. The AI reads it in the contract, and walks it with sample values: what it asks, fills and runs.
//   4. Flows set off on their own (routes, plans) leave an input flow alone: no runs.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/input-flows.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "../../../src/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
let app = null;

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    const { url: mes } = await app.listen({ port: 0 });
    const people = ["olga", "sam", "quinn", "dana", "eli", "vera", "ivan", "ines", "iris"];
    const sessions = {};
    for (const user of people) {
        sessions[user] = `if-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status };
    };
    const approveAll = async (id) => {
        const submitted = await call("dana", "design.submit", { id });
        if (submitted.error) return { error: submitted.error };
        await call("vera", "design.review", { id, decision: "pass" });
        let state = null;
        for (let round = 0; round < 4 && state !== "executed"; round++) for (const user of people) {
            const seen = await call(user, "design.change", { id, as: user });
            for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
        }
        return { state };
    };

    // ---- 1. an input flow, and a transaction naming it ----
    const FLOW = `scan_in_t${tag}`;
    // The seed's Move in (its objects' policies let it write as itself), now named by the flow.
    const TX = "move_in";
    const [moveIn] = await db.query("SELECT body FROM mes.transactions WHERE name = 'move_in' AND status = 'published'");
    const inputFlow = {
        name: FLOW, label: "Scan to move in", description: "", kind: "input", participants: {}, context: {}, roles: {}, stewards: ["production"],
        nodes: {
            start: { kind: "start", label: "Start" },
            lot: { kind: "ask", label: "Scan the lot", input: "lot", prompt: "Scan the lot" },
            machine: { kind: "ask", label: "Scan the machine", input: "machine", advance: "key", key: "F2" },
            run: { kind: "run", label: "Move it in", confirm: "auto" },
            next: { kind: "end", label: "Next lot", then: "repeat" },
        },
        edges: [{ from: "start", to: "lot" }, { from: "lot", to: "machine" }, { from: "machine", to: "run" }, { from: "run", to: "next" }],
        layout: { start: { x: 40, y: 60 }, lot: { x: 240, y: 60 }, machine: { x: 440, y: 60 }, run: { x: 640, y: 60 }, next: { x: 840, y: 60 } },
    };
    const scanTx = { ...moveIn.body, inputFlow: FLOW };
    const { id } = await call("dana", "design.start", { flow: FLOW, label: "Scan to move in" });
    const opened = await call("dana", "design.change", { id, as: "dana" });
    const saved = await call("dana", "design.save", { id, seen: opened.draft_rev, reason: "Scanning at the presses, no mouse.", flows: { [FLOW]: inputFlow }, transactions: { [TX]: scanTx } });
    const done = await approveAll(id);
    const def = await call("olga", "transactions.get", { name: TX, as: "olga" });
    step("an input flow and a transaction naming it, in one change: no problems, approved, and the form gets the flow with it",
        !saved.problems?.length && done.state === "executed" && def?.inputFlow?.name === FLOW && def.inputFlow.nodes.machine.key === "F2" && def.inputFlow.edges.length === 4,
        { problems: saved.problems, done, inputFlow: def?.inputFlow });
    const home = await call("dana", "design.home", { as: "dana" });
    step("the designer's home lists it as an input flow, with what it asks for and runs",
        home.flows?.some((f) => f.name === FLOW && f.kind === "input" && f.summary?.asks.map((a) => a.input).join() === "lot,machine" && f.summary.runs.length === 1), home.flows?.find((f) => f.name === FLOW));

    // ---- 2. refused, by name ----
    const { id: badId } = await call("dana", "design.start", { flow: FLOW });
    const bad = await call("dana", "design.change", { id: badId, as: "dana" });
    const broken = JSON.parse(JSON.stringify(inputFlow));
    broken.nodes.step = { kind: "sequence", label: "A route's step", offers: [], leaves: [] };
    broken.edges = [...broken.edges.filter((e) => e.from !== "machine"), { from: "machine", to: "step" }, { from: "step", to: "run" }];
    broken.nodes.machine.key = "m";
    const otherTx = { ...scanTx, inputFlow: FLOW };
    const brokenFlowTx = JSON.parse(JSON.stringify(broken));
    brokenFlowTx.nodes.lot.input = "tool";
    const refused = await call("dana", "design.save", { id: badId, seen: bad.draft_rev, reason: "Broken.", flows: { [FLOW]: brokenFlowTx }, transactions: { [TX]: otherTx } });
    const words = (refused.problems ?? []).map((p) => p.message).join("\n");
    await call("dana", "design.withdraw", { id: badId });
    step("refused, by name: a route's step in an input flow, a key no keyboard sends, an ask for an input the transaction does not have",
        /a sequence belongs to a route, not an input flow/.test(words) && /F1 to F12, or one character that is not a letter or a digit/.test(words) && new RegExp(`${FLOW} asks for tool: "tool" is not an input of this transaction`).test(words), refused.problems);

    // ---- 3. the AI ----
    const { createTokens } = await import("../server/ai-api.js");
    const issued = await createTokens(db).issue("dana", { name: "input flows test", agent: "test agent" });
    const ai = async (method, path, body) => {
        const res = await fetch(`${mes}/ai/v1${path}`, { method, headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json", "x-ai-agent": "test agent" }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
    };
    const contract = await ai("GET", "/contract");
    step("the AI's contract describes input flows: their steps, what moves on, and how transactions and screens name one",
        /kind 'input'/.test(contract.body?.flows?.input ?? "") && /advance/.test(contract.body.flows.input) && /inputFlow/.test(contract.body.transactions?.shape ?? "") && /inputFlow/.test(contract.body.screens?.shape ?? ""), Object.keys(contract.body ?? {}));
    const walked = await ai("POST", "/flows/walk", { name: FLOW, values: { input: { lot: "L1", machine: "M1" } } });
    const half = await ai("POST", "/flows/walk", { name: FLOW, values: { input: { lot: "L1" } } });
    const route = (await db.query("SELECT name FROM mes.flows WHERE status = 'published' AND body->>'kind' = 'route' LIMIT 1"))[0]?.name;
    const notInput = route ? await ai("POST", "/flows/walk", { name: route }) : { status: 400 };
    const path = (walked.body?.steps ?? []).map((s) => (s.ask ? `ask ${s.ask}` : s.run ? "run" : s.end ? `end ${s.end}` : s.error ?? "?")).join(" → ");
    step("…and walks one with sample values: asks lot then machine (on F2), runs, repeats; it waits at an ask with no value; a route is not one",
        walked.status === 200 && path === "ask lot → ask machine → run → end repeat" && walked.body.steps[1].movesOnBy === "F2" && /input flow/.test(walked.body.words)
        && half.body?.steps?.at(-1)?.waits === true && half.body.steps.at(-1).ask === "machine" && notInput.status >= 400, { path, half: half.body, notInput });
    const explained = await ai("POST", "/flows/explain", { name: FLOW });
    step("explain_flow says it in words", /Scan the machine: the cursor to machine, on by the F2 key/.test(JSON.stringify(explained.body)), explained.body);

    // ---- 4. never run as a route or a plan ----
    const [{ n: runs }] = await db.query("SELECT count(*)::int AS n FROM mes.flow_runs WHERE flow = $1", [FLOW]);
    step("an input flow sets nothing off on its own: no runs", runs === 0, { runs });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
