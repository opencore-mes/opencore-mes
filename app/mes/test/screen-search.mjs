// A screen parameter's search (DESIGN.md §26.1), end to end on the seed's lots:
//   1. A screen opened with a lot may say search, with fields shown beside each; a search on a list picked from,
//      or showing a reference or a field the lot has not, is named.
//   2. Part of a title typed: how many lots hold it, counted by state as Olga may read them, and a first page,
//      those it begins first, each with its fields; one state's alone; the next page; a % typed is a %.
//   3. The parameter's where narrows it; someone who may read no lot finds none.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/screen-search.mjs   (after a reset)
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
for (const user of ["dana", "olga", "ivan"]) {
    sessions[user] = `ss-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    return res.ok ? body : { error: body.error, status: res.status };
};
const words = (r) => (r?.problems ?? []).map((p) => p.message).join("\n");

try {
    // ---- 1. the design ----
    const S = `find_lot_t${tag}`;
    const screen = (param) => ({ name: S, label: "Find a lot", description: "", params: { lot: param }, blocks: [{ block: "record", title: "Lot", object: "lot", of: { param: "lot" }, show: ["lot_no", "state"], width: 12 }], callers: { users: [], groups: ["production"] }, stewards: ["production"] });
    const { id } = await call("dana", "design.start", { screen: S, label: "Find a lot" });
    const fresh = await call("dana", "design.change", { id, as: "dana" });
    const wrong = await call("dana", "design.save", { id, seen: fresh.draft_rev, reason: "Lots found by part of their number.", screens: { [S]: screen({ label: "Lot", type: "ref", to: "lot", widget: "select", search: { show: ["work_order", "nope"] } }) } });
    const right = await call("dana", "design.save", { id, seen: wrong.draft_rev, screens: { [S]: screen({ label: "Lot", type: "ref", to: "lot", widget: "scan", search: { show: ["item", "qty"] } }) } });
    step("a screen's lot may search, showing fields beside each; a search on a list picked from is named",
        /search is true or \{ show: \[fields\] \}, for a reference that is scanned or typed/.test(words(wrong)) && !right.problems?.length, { wrong: words(wrong), right: words(right) });
    const refShown = await call("dana", "design.save", { id, seen: right.draft_rev, screens: { [S]: screen({ label: "Lot", type: "ref", to: "lot", widget: "scan", search: { show: ["work_order", "nope"] } }) } });
    step("…and a reference, or a field the lot has not, shown beside each, is named",
        /work_order is not shown in a search/.test(words(refShown)) && /lot has no field "nope" to show/.test(words(refShown)), words(refShown));
    await call("dana", "design.withdraw", { id, reason: "Checked." });

    // ---- 2. part of a title ----
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1001'");
    const made = [];
    for (let i = 1; i <= 35; i++) made.push(await call("olga", "records.create", { object: "lot", data: { lot_no: `SR${tag}-${String(i).padStart(2, "0")}`, item: i % 2 ? "PA66-NAT-25" : "PA66-BLK-25", work_order: wo.id, qty: i, uom: "kg" } }));
    // Three of them started, so the counts have two states.
    const released = [];
    for (const r of made.slice(0, 3)) released.push(await call("olga", "records.action", { object: "lot", id: r.id, action: "start", rowVersion: r.$rowVersion ?? r.row_version ?? 1 }));
    const q = `sr${tag}-`;
    const first = await call("olga", "records.matching", { object: "lot", q, show: ["item", "qty", "work_order"], limit: 20, as: "olga" });
    const states = Object.fromEntries((first.states ?? []).map((x) => [x.state, x.n]));
    const sum = (first.states ?? []).reduce((a, x) => a + x.n, 0);
    step("part of a lot number: how many hold it, counted by state, a first page each with the fields asked (never a reference)",
        first.total === 35 && sum === 35 && states.created === 32 && states.in_process === 3 && first.rows.length === 20 && first.more === true && first.rows.every((r) => r.title.toLowerCase().includes(q) && typeof r.item === "string" && typeof r.qty === "number" && !("work_order" in r)) && first.labels?.title === "Lot no." && first.labels?.qty === "Quantity",
        { total: first.total, states, rows: first.rows?.length, more: first.more, sample: first.rows?.[0], labels: first.labels });
    const next = await call("olga", "records.matching", { object: "lot", q, offset: 20, limit: 20, as: "olga" });
    step("…the next page, the rest, none twice", next.rows?.length === 15 && next.more === false && !next.rows.some((r) => first.rows.some((x) => x.id === r.id)), { rows: next.rows?.length, more: next.more });
    const someState = first.states?.[0]?.state;
    const one = await call("olga", "records.matching", { object: "lot", q, state: someState, limit: 50, as: "olga" });
    step("…one state's alone, the counts still every state's", one.rows?.length === states[someState] && one.rows.every((r) => r.state === someState) && one.total === 35, { someState, rows: one.rows?.length, released });
    const pct = await call("olga", "records.matching", { object: "lot", q: "%", as: "olga" });
    step("a % typed is a %, not every lot", pct.total === 0, pct);

    // ---- 3. narrowed ----
    const narrowed = await call("olga", "records.matching", { object: "lot", q, where: { item: ["PA66-BLK-25"] }, limit: 50, as: "olga" });
    step("the parameter's where narrows it: only the black lots", narrowed.total === 17 && narrowed.rows.every((r) => r.id && made.some((m) => m.id === r.id)), { total: narrowed.total });
    const none = await call("ivan", "records.matching", { object: "lot", q, as: "ivan" });
    step("someone who may read no lot finds none", (none.total ?? 0) === 0 || none.status === 403, none);
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
