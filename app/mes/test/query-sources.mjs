// Named queries as the source of a reference's choices and of a screen's table, kept in line with what uses
// them (DESIGN.md §23.1, §26), end to end on the seed's model:
//   1. Dana designs, in one change: a query of the machines of a kind, another of the lots in a state; a lot's
//      field (its press) whose choices are the first's, a transaction whose machine input's are too, and a
//      screen whose table is the second's rows. What they name of a query that it does not give is named.
//   2. Approved and executed.
//   3. The lot's field offers presses only; a save naming an oven is refused on the field, a press is kept.
//   4. The transaction's input likewise: an oven refused, a press run.
//   5. The screen's table: the query's rows, its columns, each row's record for its buttons.
//   6. A change that drops a column of the query the screen shows names the screen, though it is not in the
//      change; Align brings it in, without the column, and nothing is left to say.
//   7. A change that takes from an object a field a query reads names the query.
//   8. A query's panel says its columns and where it is used.
//   9. A chart reads a named query: checked as designed, its rows drawn, named among the query's users.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/query-sources.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;

const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
const { url: mes } = await app.listen({ port: 0 });
const sessions = {};
for (const user of ["dana", "vera", "eli", "sam", "olga", "quinn", "ivan", "ines"]) {
    sessions[user] = `qs-${randomBytes(8).toString("hex")}`;
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

try {
    // ---- 1. the design ----
    const KINDS = `machines_kind_t${tag}`;
    const WAITING = `lots_state_t${tag}`;
    const PICK = `pick_press_t${tag}`;
    const SCREEN = `lots_q_t${tag}`;
    const kinds = { name: KINDS, label: "Machines of a kind", description: "", sql: "SELECT id, machine_id, name, kind\nFROM machine\nWHERE kind = :kind\nORDER BY machine_id", params: { kind: { type: "string", label: "Kind", required: true } }, limit: 200, tests: [{ name: "presses", params: { kind: "press" } }], stewards: ["production"] };
    const waiting = { name: WAITING, label: "Lots in a state", description: "", sql: "SELECT id, lot_no, qty, state\nFROM lot\nWHERE state = :state\nORDER BY lot_no", params: { state: { type: "string", label: "State", required: true } }, limit: 200, tests: [{ name: "created", params: { state: "created" } }], stewards: ["production"] };
    const [lotDef] = await db.query("SELECT body FROM mes.definitions WHERE object = 'lot' AND status = 'published'");
    const lot = {
        ...lotDef.body,
        fields: { ...lotDef.body.fields, press: { label: "Press", type: "ref", to: "machine", options: { query: KINDS, display: ["machine_id", "name"], params: { kind: "press" } } } },
        policies: lotDef.body.policies.map((p) => (p.id === "lot-production-edit" ? { ...p, fields: { ...p.fields, press: "write" } } : p)),
    };
    const pick = {
        name: PICK, label: "Put on a press", description: "A lot's press, from the machines of its kind.",
        inputs: { lot: { label: "Lot", type: "ref", to: "lot", required: true }, kind: { label: "Kind", type: "enum", values: ["press", "oven"], required: true }, machine: { label: "Machine", type: "ref", to: "machine", required: true, options: { query: KINDS, display: ["machine_id"], params: { kind: { input: "kind" } } } } },
        appearsOn: { object: "lot", states: ["created", "in_process"], fills: "lot" }, require: [],
        steps: [{ on: "lot", set: { note_press: { input: "machine" } } }],
        confirm: false, callers: { users: ["olga"], groups: [] }, stewards: ["production"],
        scenarios: [{ name: "a press", records: { wo: { object: "work_order", where: { wo_no: ["WO-1001"] } }, lot: { object: "lot", data: { lot_no: `QSS-${tag}`, item: "PA66-NAT-25", work_order: "@wo", qty: 10, uom: "kg" } }, m: { object: "machine", where: { machine_id: ["M-101"] } } }, steps: [{ as: "olga", do: { transaction: PICK, input: { lot: "@lot", kind: "press", machine: "@m" } }, expect: { ok: true } }] }],
    };
    // (The step writes a field of its own, so the lot's press field keeps its own check out of this.)
    lot.fields.note_press = { label: "Noted press", type: "ref", to: "machine" };
    lot.policies = [...lot.policies, { id: `qs-${tag}`, roles: ["operator"], via: [PICK], fields: { note_press: "write" } }];
    const screen = {
        name: SCREEN, label: "Lots waiting (query)", description: "", params: {},
        blocks: [{ block: "table", title: "Waiting", query: WAITING, params: { state: "created" }, columns: ["lot_no", "qty"], object: "lot", rowActions: [PICK], width: 12 }],
        callers: { users: [], groups: ["production"] }, stewards: ["production"],
    };
    const { id } = await call("dana", "design.start", { query: KINDS, label: "Machines of a kind" });
    const fresh = await call("dana", "design.change", { id, as: "dana" });
    const wrong = await call("dana", "design.save", { id, seen: fresh.draft_rev, reason: "Choices from a query.", queries: { [KINDS]: kinds, [WAITING]: waiting }, definitions: { lot: { ...lot, fields: { ...lot.fields, press: { ...lot.fields.press, options: { ...lot.fields.press.options, display: ["machine_id", "nope"] } } } } }, transactions: { [PICK]: pick }, screens: { [SCREEN]: { ...screen, blocks: [{ ...screen.blocks[0], columns: ["lot_no", "missing_col"] }] } } });
    step("what a design names of a query that it does not give is named: a field's display column, a table's column",
        /"nope", which machines_kind_t\d+ does not give/.test(words(wrong)) && /"missing_col", which lots_state_t\d+ does not give/.test(words(wrong)), wrong.error ?? words(wrong));
    const saved = await call("dana", "design.save", { id, seen: wrong.draft_rev ?? fresh.draft_rev, reason: "Choices from a query.", queries: { [KINDS]: kinds, [WAITING]: waiting }, definitions: { lot }, transactions: { [PICK]: pick }, screens: { [SCREEN]: screen } });
    const submitted = await call("dana", "design.submit", { id });
    await call("vera", "design.review", { id, decision: "pass" });
    step("the queries, the lot's field, the transaction and the screen are approved and executed", !saved.problems?.length && !submitted.error && (await approveAll(id)) === "executed", { problems: saved.problems, submitted: submitted.error });

    // ---- 3. the lot's field: presses only ----
    const ids = Object.fromEntries((await db.query("SELECT data->>'machine_id' AS m, id FROM mes.records WHERE object = 'machine'")).map((r) => [r.m, r.id]));
    const choices = await call("olga", "records.choices", { object: "lot", name: "press", values: {}, as: "olga" });
    // (Earlier suites may have made presses of their own: every choice is a press, both of the seed's among them.)
    const presses = new Set((await db.query("SELECT id FROM mes.records WHERE object = 'machine' AND data->>'kind' = 'press' AND archived_at IS NULL")).map((r) => r.id));
    step("the lot's press offers the query's rows, presses only, each by its display columns",
        choices.rows?.length >= 2 && choices.rows.every((r) => presses.has(r.id) && / · /.test(r.title)) && choices.rows.some((r) => r.title === "M-101 · Press 1") && !choices.rows.some((r) => r.id === ids["OV-1"]), choices);
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1001'");
    const base = { lot_no: `QS-${tag}`, item: "PA66-NAT-25", work_order: wo.id, qty: 10, uom: "kg" };
    const oven = await call("olga", "records.create", { object: "lot", data: { ...base, press: ids["OV-1"] } });
    step("a lot saved with an oven as its press is refused, on the field, in words", /not one of its choices/.test(oven.fields?.press ?? ""), oven);
    const made = await call("olga", "records.create", { object: "lot", data: { ...base, press: ids["M-101"] } });
    step("…and with a press, kept", made.id && made.press === ids["M-101"], made);

    // ---- 4. the transaction's input likewise ----
    const ran1 = await call("olga", "transactions.run", { name: PICK, input: { lot: made.id, kind: "press", machine: ids["OV-1"] } });
    step("a run whose machine is not one of its choices (an oven, presses asked) is refused on the input", /not one of its choices/.test(ran1.fields?.machine ?? ""), ran1);
    const txChoices = await call("olga", "records.choices", { transaction: PICK, name: "machine", values: { kind: "oven" }, as: "olga" });
    const ran2 = await call("olga", "transactions.run", { name: PICK, input: { lot: made.id, kind: "press", machine: ids["M-102"] } });
    step("its choices follow its other inputs (an oven asked: the oven), and a press runs", txChoices.rows?.length === 1 && txChoices.rows[0].id === ids["OV-1"] && !ran2.error, { txChoices, ran2 });

    // ---- 5. the screen's table ----
    const data = await call("olga", "screens.data", { name: SCREEN, as: "olga" });
    const block = data.blocks?.[0] ?? data.data?.[0];
    const t = block?.data ?? block;
    step("the screen's table: the query's rows, its columns, each row its record for its buttons",
        Array.isArray(t?.columns) && t.columns.join() === "lot_no,qty" && t.object === "lot" && t.rows.length >= 1 && t.rows.some((r) => r.id === made.id && r.state === "created" && r.cells[0] === `QS-${tag}`), JSON.stringify(data).slice(0, 600));

    // ---- 6. a column taken from the query: the screen is named, then aligned ----
    const { id: id2 } = await call("dana", "design.start", { query: WAITING, label: "Lots in a state" });
    const narrower = { ...waiting, sql: "SELECT id, lot_no, state\nFROM lot\nWHERE state = :state\nORDER BY lot_no" };
    const s2 = await call("dana", "design.save", { id: id2, reason: "No quantity.", queries: { [WAITING]: narrower } });
    step("a change taking a column from a query names the live screen that shows it, though it is not in the change", /Lots waiting \(query\) \(not in this change\), table "Waiting": its columns uses "qty"/.test(words(s2)) && s2.problems.some((p) => p.align?.kind === "screen" && p.align.name === SCREEN), words(s2));
    const aligned = await call("dana", "design.align", { id: id2 });
    const after = await call("dana", "design.change", { id: id2, as: "dana" });
    step("Align brings the screen into the change without the column, and nothing is left to say",
        aligned.brought?.some((b) => b.kind === "screen" && b.name === SCREEN) && after.content?.screens?.[SCREEN]?.blocks?.[0]?.columns?.join() === "lot_no" && !(aligned.problems ?? []).length, { aligned, cols: after.content?.screens?.[SCREEN]?.blocks?.[0] });
    await call("dana", "design.withdraw", { id: id2, reason: "Test done." });

    // ---- 7. a field a query reads, taken from its object ----
    const [mDef] = await db.query("SELECT body FROM mes.definitions WHERE object = 'machine' AND status = 'published'");
    const { id: id3 } = await call("dana", "design.start", { object: "machine" });
    const { kind: _gone, ...fields } = mDef.body.fields;
    const s3 = await call("dana", "design.save", { id: id3, reason: "No kind.", definitions: { machine: { ...mDef.body, fields, form: { sections: [{ label: "Machine", fields: ["machine_id", "name", "capacity"] }] }, list: { columns: ["machine_id", "name"] } } } });
    step("a change taking from an object a field a query reads names the query", new RegExp(`Query Machines of a kind \\(not in this change\\) reads machine.kind, which this change takes away`).test(words(s3)), words(s3).slice(0, 800));
    await call("dana", "design.withdraw", { id: id3, reason: "Test done." });

    // ---- 8. a query's panel: its columns, where it is used ----
    const panel = await call("dana", "design.queryColumns", { query: KINDS, as: "dana" });
    step("a query's panel says its columns and where it is used (the lot's field, the transaction's input)",
        panel.columns?.join() === "id,machine_id,name,kind" && panel.usedBy?.some((u) => u.kind === "object" && u.name === "lot") && panel.usedBy?.some((u) => u.kind === "transaction" && u.name === PICK), panel);

    // ---- 9. a chart from a named query ----
    const COUNT = `machines_count_t${tag}`;
    const CHARTS = `machines_chart_t${tag}`;
    const counted = { name: COUNT, label: "Machines by kind", description: "", sql: "SELECT kind, count(*) AS machines\nFROM machine\nWHERE archived_at IS NULL AND (kind = :kind OR :kind IS NULL)\nGROUP BY kind\nORDER BY kind", params: { kind: { type: "string", label: "Kind" } }, limit: 50, tests: [{ name: "all", params: {} }], stewards: ["production"] };
    const charted = { name: CHARTS, label: "Machines charted", description: "", params: {},
        blocks: [{ block: "chart", title: "By kind", chart: "bar", query: { named: COUNT }, x: "kind", y: ["machines"], width: 12 }],
        callers: { users: [], groups: ["production"] }, stewards: ["production"] };
    const { id: id4 } = await call("dana", "design.start", { query: COUNT, label: "Machines by kind" });
    const wrongChart = await call("dana", "design.save", { id: id4, reason: "A chart over a named query.", queries: { [COUNT]: counted }, screens: { [CHARTS]: { ...charted, blocks: [{ ...charted.blocks[0], query: { named: COUNT, params: { colour: "red" } } }, { ...charted.blocks[0], query: { named: `nope_t${tag}` } }] } } });
    const okChart = await call("dana", "design.save", { id: id4, queries: { [COUNT]: counted }, screens: { [CHARTS]: charted } });
    const chartSubmitted = await call("dana", "design.submit", { id: id4 });
    await call("vera", "design.review", { id: id4, decision: "pass" });
    const chartLive = await approveAll(id4);
    const chartData = await call("olga", "screens.data", { name: CHARTS, as: "olga" });
    const ch = chartData?.blocks?.[0];
    const chartPanel = await call("dana", "design.queryColumns", { query: COUNT, as: "dana" });
    step("a chart reads a named query (§23.1): its parameters and its name checked as designed; its rows drawn; the query's panel names the chart among its users",
        /has no parameter "colour"/.test(words(wrongChart)) && new RegExp(`"nope_t${tag}" is not a named query`).test(words(wrongChart)) && !okChart.problems?.length && chartLive === "executed"
        && ch?.columns?.join() === "kind,machines" && ch.rows.some((r) => r[0] === "press" && Number(r[1]) >= 1) && chartPanel.usedBy?.some((u) => u.kind === "screen" && u.name === CHARTS && /chart/.test(u.at)),
        { wrong: words(wrongChart), ok: okChart.problems, chartSubmitted, chartLive, ch, chartData, usedBy: chartPanel?.usedBy });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
