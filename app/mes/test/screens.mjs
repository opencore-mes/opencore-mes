// Screens (§26), end to end, against a running server. The two seed screens are definitions (standing
// in for approved changes); step 5 designs a third through the change lifecycle.
//   1. Who may open what: Olga (production) has both; Vera has neither, and gets nothing.
//   2. The work centre asks for its machine; a machine that does not exist or is not visible is refused.
//      Each design says whether its page may fill the window (maximize), and the page is told.
//   3. Opened on a press of its own: the machine, the counts and the three tables follow the transactions run on it.
//   4. Each viewer reads with their own rights: a number counts only what they may read.
//   5. Dana designs "Quality board" (lots on hold, scrap by reason) for Quality and ERP: checked,
//      previewed with her rights, routed, reviewed, approved, executed; Quinn opens it; ERP, with no
//      role on machines, sees its machine block empty.
//   5b. A review that would leave a department with nobody to approve is refused; a review can be
//      taken back before anyone signs.
//   6. An AI drafts a screen over the REST API and is told what is wrong.
//   7. A desk worked all day (§26.10): one tab (needs a parameter); with nothing scanned, the runs of its
//      transactions from the audit trail, newest first, as the viewer may read them; mine, only theirs; a form
//      the viewer may not send left out.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/screens.mjs   (after a reset)
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
for (const user of ["olga", "sam", "vera", "dana", "eli", "quinn", "erp"]) {
    sessions[user] = `sc-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status, body });
    return body;
};
const key = () => `sc-${randomBytes(8).toString("hex")}`;
const byTitle = async (object, field, value) => (await db.query("SELECT id FROM mes.records WHERE object = $1 AND data->>$2 = $3", [object, field, value]))[0]?.id;

try {
    // Its own machine, so what other tests left on M-101 does not matter (Sam keeps machines).
    const press = (await call("sam", "records.create", { object: "machine", data: { machine_id: `SC-M-${tag}`, name: "Test press", kind: "press", capacity: 1 }, key: key() })).id;
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1002'");
    const lot = (await call("sam", "records.create", { object: "lot", data: { lot_no: `SC-${tag}`, item: "PP-BLK-10", work_order: wo.id, qty: 80, uom: "kg" }, key: key() })).id;

    // ---- 1. who ----
    const olga = await call("olga", "screens.list", { as: "olga" });
    step("an operator has the work centre and the shop floor", ["shop_floor", "work_centre"].every((n) => olga.some((s) => s.name === n)) && olga.find((s) => s.name === "work_centre").param === "machine", olga);
    step("a viewer has none, and a screen is null for her", (await call("vera", "screens.list", { as: "vera" })).length === 0 && (await call("vera", "screens.get", { name: "work_centre", as: "vera" })) === null && (await call("vera", "screens.data", { name: "work_centre", arg: press, as: "vera" })) === null);

    // ---- 2. the parameter ----
    const def = await call("olga", "screens.get", { name: "work_centre", as: "olga" });
    step("its definition: a machine to scan, seven blocks", def.params.machine?.widget === "scan" && def.blocks.length === 7, def);
    const shopFloor = await call("olga", "screens.get", { name: "shop_floor", as: "olga" });
    const moveIn = await call("olga", "transactions.get", { name: "move_in", as: "olga" });
    step("filling the window, as each design says: the work centre and Move in offer a button, the shop floor opens filled", def.maximize === "toggle" && shopFloor.maximize === "start" && moveIn.maximize === "toggle", { workCentre: def.maximize, shopFloor: shopFloor.maximize, moveIn: moveIn.maximize });
    step("opened without a machine, it asks for one", (await call("olga", "screens.data", { name: "work_centre", arg: null, as: "olga" })).need === "machine");
    const bad = await call("olga", "screens.data", { name: "work_centre", arg: "00000000-0000-0000-0000-000000000000", as: "olga" });
    step("a machine that is not there is refused, in words", bad.need === "machine" && /No machine that you can see/.test(bad.error), bad);

    // ---- 3. the blocks follow the work ----
    const at = async () => call("olga", "screens.data", { name: "work_centre", arg: press, as: "olga" });
    let d = await at();
    step("the machine block: the press, idle", d.param.title === `SC-M-${tag}` && d.blocks[0].record.machine_id === `SC-M-${tag}` && d.blocks[0].record.state === "idle", d.blocks[0]);
    step("nothing on it yet", d.blocks[1].value === 0 && d.blocks[3].rows.length === 0 && d.blocks[4].rows.length === 0);
    await call("olga", "transactions.run", { name: "move_in", input: { lot, machine: press }, key: key() });
    d = await at();
    step("moved in: one lot on it, waiting to start; the machine loaded", d.blocks[1].value === 1 && d.blocks[4].rows.some((r) => r.id === lot && r.lot_no === `SC-${tag}`) && d.blocks[0].record.state === "loaded", d.blocks);
    step("a table carries only its columns (and the row's id, state and title)", Object.keys(d.blocks[4].rows[0]).sort().join(",") === ["$title", "$titles", "id", "item", "lot_no", "qty", "state", "uom"].sort().join(","), Object.keys(d.blocks[4].rows[0]));
    await call("olga", "transactions.run", { name: "track_in", input: { lot }, key: key() });
    await call("olga", "transactions.run", { name: "track_out", input: { lot, good_qty: 75, scrap_qty: 5, scrap_reason: "dimension" }, key: key() });
    d = await at();
    step("tracked in and out: the lot in \"Done: take off\", the scrap counted today", d.blocks[5].rows.some((r) => r.id === lot && r.scrap_qty === 5) && d.blocks[3].rows.length === 0 && d.blocks[2].value >= 5, d.blocks);
    const floor = await call("quinn", "screens.data", { name: "shop_floor", as: "quinn" });
    step("the shop floor (Quality may open it): machines by state, the lot at its press by the press's title", floor.blocks[0].groups.some((g) => g.key === "loaded") && floor.blocks[3].rows.some((r) => r.id === lot && r.$titles.machine === `SC-M-${tag}`), floor.blocks);

    // ---- 4. rights ----
    await call("olga", "transactions.run", { name: "move_out", input: { lot }, key: key() });
    const scrap = floor.blocks[4].groups.find((g) => g.key === "dimension")?.value;
    step("scrap this week, by reason: counted from what the viewer may read", scrap >= 5, floor.blocks[4]);

    // ---- 5. a designer's screen ----
    const NAME = `quality_board_t${tag}`;
    const { id } = await call("dana", "design.start", { screen: NAME, label: "Quality board" });
    const board = {
        name: NAME, label: "Quality board", description: "What Quality watches.", params: {},
        blocks: [
            { block: "kpi", title: "On hold", label: "lots", object: "lot", where: { state: ["on_hold"] }, measure: "count", width: 4 },
            { block: "breakdown", title: "Machines", object: "machine", by: "state", measure: "count", width: 4 },
            { block: "breakdown", title: "Scrap by reason (30 days)", object: "lot", by: "scrap_reason", measure: { sum: "scrap_qty" }, since: "30d", width: 4 },
            { block: "table", title: "Lots on hold", object: "lot", where: { state: ["on_hold"] }, columns: ["lot_no", "item", "disposition"], width: 12 },
        ],
        callers: { users: ["erp"], groups: ["quality"] }, stewards: ["quality"],
    };
    const wrong = await call("dana", "design.save", { id, reason: "Quality's view of the floor.", screens: { [NAME]: { ...board, blocks: [...board.blocks, { block: "table", object: "lot", columns: ["colour"], rowActions: ["track_in", "nope"] }, { block: "kpi", object: "lot", measure: { sum: "item" } }] } } });
    const words = wrong.problems.map((p) => p.message).join("\n");
    step("mistakes named: a field, a transaction, a measure", /lot has no field "colour"/.test(words) && /"nope" is not a transaction/.test(words) && /the measure is "count", or \{ sum/.test(words), wrong.problems);
    const saved = await call("dana", "design.save", { id, screens: { [NAME]: board } });
    step("fixed: no problems", saved.problems.length === 0, saved.problems);
    const preview = await call("dana", "screens.preview", { screen: board });
    step("previewed with Dana's own rights, before anyone approves it", preview.data?.blocks?.length === 4 && preview.data.blocks[1].groups.length > 0, preview);
    await call("dana", "design.submit", { id });
    const change = await call("dana", "design.change", { id, as: "dana" });
    step("routed to its stewards only (a screen writes nothing)", change.route.map((r) => r.department).join(",") === "quality", change.route);
    await call("eli", "design.review", { id, decision: "pass" });
    const done = await call("quinn", "design.approve", { id, department: "quality", decision: "approve", meaning: "Approved" });
    step("approved and executed", done.state === "executed", done);
    const q = await call("quinn", "screens.data", { name: NAME, as: "quinn" });
    step("Quinn opens it: machines by state", q.blocks[1].groups.length > 0, q.blocks);
    const e = await call("erp", "screens.data", { name: NAME, as: "erp" });
    step("ERP opens it too, but has no role on machines: that block is empty, the lots are there", e.blocks[1].groups.length === 0 && Array.isArray(e.blocks[3].rows), e.blocks);

    // ---- 5b. nobody left to approve ----
    // A new screen is stewarded by its author's department: Engineering, whose representatives are
    // Dana (the author) and Eli. If Eli reviewed it, nobody could approve it.
    const LONE = `lone_t${tag}`;
    const lone = await call("dana", "design.start", { screen: LONE, label: "Lone" });
    const loneBody = { ...(await call("dana", "design.change", { id: lone.id, as: "dana" })).content.screens[LONE], callers: { groups: ["engineering"] } };
    await call("dana", "design.save", { id: lone.id, reason: "A note for Engineering.", screens: { [LONE]: loneBody } });
    const before = (await call("dana", "design.change", { id: lone.id, as: "dana" })).reviewing;
    step("before submission, the author is told Eli's review would leave nobody to approve, and who may review instead", before?.strands.some((x) => x.reviewer === "eli" && x.where.join() === "engineering") && before.fine.includes("vera") && !before.fine.includes("eli") && !before.fine.includes("dana"), before);
    await call("dana", "design.submit", { id: lone.id });
    const waiting = (await call("eli", "design.approvals", { as: "eli" })).changes.find((c) => c.id === lone.id);
    step("the approvals list does not offer it to Eli to review", waiting && !waiting.reviewableBy.includes("eli") && waiting.reviewableBy.includes("vera") && waiting.mine === false, waiting);
    const eliReview = await call("eli", "design.review", { id: lone.id, decision: "pass" }).then(() => null, (e) => e);
    step("a review that would leave nobody to approve is refused, naming only who may review instead", eliReview?.status === 409 && /nobody can approve it for engineering/.test(eliReview.message) && /Ask [a-z, ]*vera/.test(eliReview.message) && !/Ask [^.]*\bdana\b/.test(eliReview.message), eliReview?.message);
    await call("vera", "design.review", { id: lone.id, decision: "pass" });
    const asDana = await call("dana", "design.change", { id: lone.id, as: "dana" });
    step("in approval, the author is told why she cannot sign, and who can", asDana.whyNot.some((w) => w.department === "engineering" && w.reason === "author") && asDana.approvers.engineering.join() === "eli", asDana);
    const asVera = await call("vera", "design.change", { id: lone.id, as: "vera" });
    step("the reviewer may take the review back while nobody has signed", asVera.can.retractReview === true);
    await call("vera", "design.retractReview", { id: lone.id });
    step("…and the change is in review again", (await call("dana", "design.change", { id: lone.id, as: "dana" })).state === "review");
    await call("vera", "design.review", { id: lone.id, decision: "pass" });
    step("reviewed again, Eli approves it: executed", (await call("eli", "design.approve", { id: lone.id, department: "engineering", decision: "approve", meaning: "Approved" })).state === "executed");

    // ---- 5b. what a block offers, by condition (§26.9) ----
    const STATION = `station_t${tag}`;
    const st = await call("dana", "design.start", { screen: STATION, label: "Station" });
    const station = {
        name: STATION, label: "Station", description: "One machine, and what may be done at it now.",
        params: { machine: { label: "Machine", type: "ref", to: "machine", required: true } },
        blocks: [
            { block: "record", title: "Machine", object: "machine", of: { param: "machine" }, show: ["machine_id", "state"], width: 6 },
            { block: "kpi", title: "Lots on it", label: "lots", object: "lot", where: { machine: { param: "machine" } }, measure: "count", width: 6, showWhen: { gt: [{ count: { object: "lot", where: { machine: { param: "machine" } } } }, 0] } },
            { block: "transaction", name: "move_in", tab: "Move in", fills: { machine: { param: "machine" } }, enableWhen: { eq: [{ lookup: "machine.state" }, "idle"] }, disabledBecause: "This machine already has a lot on it." },
            { block: "text", tab: "For Quality", text: "Check the first piece.", showWhen: { contains: [{ user: "departments" }, "quality"] } },
            { block: "text", tab: "Help", text: "Scan the lot, then confirm." },
        ],
        callers: { users: [], groups: ["production", "quality"] }, stewards: ["production"],
    };
    const wrongWhen = await call("dana", "design.save", { id: st.id, reason: "A station offers what may be done now.", screens: { [STATION]: { ...station, blocks: [
        { ...station.blocks[0], showWhen: { eq: [{ lookup: "machine.colour" }, "red"] } },
        { ...station.blocks[1], showWhen: { eq: [{ record: "state" }, "idle"] } },
        { ...station.blocks[2], enableWhen: { bogus: [1, 2] } },
        { ...station.blocks[4], disabledBecause: "Never." },
    ] } } });
    const whenWords = wrongWhen.problems.map((p) => p.message).join("\n");
    step("a block's condition is checked as it is designed: a field the record has not, a scope a screen has not, an operator there is not, a reason with nothing to disable",
        /machine has no field "colour"/.test(whenWords) && /a block's condition reads param, lookup or user/.test(whenWords) && /unknown operator "bogus"/.test(whenWords) && /nothing ever disables it/.test(whenWords), wrongWhen.problems);
    const okWhen = await call("dana", "design.save", { id: st.id, screens: { [STATION]: station } });
    await call("dana", "design.submit", { id: st.id });
    await call("eli", "design.review", { id: st.id, decision: "pass" });
    const stLive = await call("sam", "design.approve", { id: st.id, department: "production", decision: "approve", meaning: "Approved" });
    const free = (await call("sam", "records.create", { object: "machine", data: { machine_id: `ST-M-${tag}`, name: "Station press", kind: "press", capacity: 1 }, key: key() })).id;
    const lot2 = (await call("sam", "records.create", { object: "lot", data: { lot_no: `ST-${tag}`, item: "PP-BLK-10", work_order: wo.id, qty: 10, uom: "kg" }, key: key() })).id;
    const stationFor = (who) => call(who, "screens.data", { name: STATION, arg: free, as: who });
    const pageOf = async (who) => (await fetch(`${mes}/s/${STATION}/${free}`, { headers: { cookie: `mes_session=${sessions[who]}` } })).text();
    const [idleOlga, idleQuinn, idlePage] = [await stationFor("olga"), await stationFor("quinn"), await pageOf("olga")];
    step("at an idle machine: Move in is enabled; the count of lots is not shown (there are none) and nothing of it is sent; Quality's tab is there for Quality only",
        okWhen.problems.length === 0 && stLive.state === "executed" && !idleOlga.blocks[2].$off && JSON.stringify(idleOlga.blocks[1]) === '{"$off":"hidden"}' && idleOlga.blocks[3].$off === "hidden" && !idleQuinn.blocks[3].$off
        && !idlePage.includes("tab-disabled") && !idlePage.includes('data-key="For Quality"') && idlePage.includes('data-key="Help"') && idlePage.includes('data-key="Move in"'),
        { olga: idleOlga.blocks.map((b) => b.$off ?? "shown"), quinn: idleQuinn.blocks.map((b) => b.$off ?? "shown"), saved: okWhen.problems, stLive });
    await call("olga", "transactions.run", { name: "move_in", input: { lot: lot2, machine: free }, key: key() });
    const [busy, busyPage] = [await stationFor("olga"), await pageOf("olga")];
    step("with a lot on it: Move in is greyed, saying why, on the block and on its tab; the count is shown now",
        busy.blocks[2].$off === "disabled" && busy.blocks[2].$why === "This machine already has a lot on it." && busy.blocks[1].value === 1 && !busy.blocks[1].$off
        && /class="design-tab tab-disabled"[^>]*title="This machine already has a lot on it\."[^>]*aria-disabled="true"/.test(busyPage) && busyPage.includes("block-off") && /<fieldset[^>]*class="block-body"[^>]*disabled/.test(busyPage),
        { blocks: busy.blocks.map((b) => [b.$off ?? "shown", b.$why ?? null]), tab: /tab-disabled/.test(busyPage), off: busyPage.includes("block-off") });
    const stillDecides = await fetch(`${mes}/api/transactions.run`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions.olga}` }, body: JSON.stringify([{ name: "move_in", input: { lot, machine: free }, key: key() }]) });
    step("…and it is the transaction that decides, as before: sent anyway, a second Move in is refused by its own requirement", stillDecides.status >= 400, stillDecides.status);

    // ---- 6. an AI drafts one ----
    const issued = await createTokens(db).issue("dana", { name: "screens test", agent: "test agent" });
    const ai = async (method, path, body) => {
        const res = await fetch(`${mes}/ai/v1${path}`, { method, headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
    };
    const contract = await ai("GET", "/contract");
    step("the AI reads how a screen is drawn", /blocks/.test(contract.body.screens?.shape ?? ""), contract.body.screens);
    const AIS = `ai_board_t${tag}`;
    const started = await ai("POST", "/changes", { screen: AIS, label: "AI board" });
    const draft = await ai("PUT", `/changes/${started.body.id}`, { reason: "A board.", screens: { [AIS]: { name: AIS, label: "AI board", blocks: [{ block: "gallery", object: "lot" }], callers: { groups: ["production"] }, stewards: ["production"] } } });
    step("…and is told a block it invented does not exist", draft.body.problems?.some((p) => /the block is one of record, table, kpi, breakdown, chart, transaction, text/.test(p.message)), draft.body);
    await call("dana", "design.withdraw", { id: started.body.id });
    await db.query("UPDATE mes.api_tokens SET revoked_at = now() WHERE id = $1", [issued.id]);

    // ---- 7. a desk worked all day (§26.10): one tab, and what was done there ----
    const DESK = `desk_t${tag}`;
    const dk = await call("dana", "design.start", { screen: DESK, label: "Press desk" });
    const desk = {
        name: DESK, label: "Press desk", description: "A press scanned, and what was done at the presses lately.",
        params: { machine: { label: "Machine", type: "ref", to: "machine", required: false, widget: "scan" } }, oneTab: true,
        blocks: [
            { block: "record", title: "Machine", object: "machine", of: { param: "machine" }, show: ["machine_id", "state"], showWhen: { not: { is_null: { param: "machine" } } }, width: 12 },
            { block: "runs", title: "Done here", transactions: ["move_in", "track_in", "track_out", "move_out"], limit: 10, showWhen: { is_null: { param: "machine" } }, width: 12 },
            { block: "runs", title: "Mine", transactions: ["move_in"], mine: true, width: 12 },
            { block: "transaction", title: "Move in", name: "move_in", fills: { machine: { param: "machine" } }, width: 12 },
        ],
        callers: { users: [], groups: ["production", "quality"] }, stewards: ["production"],
    };
    const wrongDesk = await call("dana", "design.save", { id: dk.id, reason: "A press desk.", screens: { [DESK]: { ...desk, params: {}, blocks: [{ block: "runs", transactions: [], limit: 1 }, { block: "runs", transactions: ["no_such_tx"] }, { block: "plan" }] } } });
    const deskWords = wrongDesk.problems.map((p) => p.message).join("\n");
    const okDesk = await call("dana", "design.save", { id: dk.id, screens: { [DESK]: desk } });
    await call("dana", "design.submit", { id: dk.id });
    await call("eli", "design.review", { id: dk.id, decision: "pass" });
    const deskLive = await call("sam", "design.approve", { id: dk.id, department: "production", decision: "approve", meaning: "Approved" });
    step("a desk's settings checked as designed: one tab needs a parameter; a runs block names transactions that exist, and lists 5 to 200; a plan block says whose plan",
        /One tab is for a screen opened on a record/.test(deskWords) && /name the transactions whose runs it lists/.test(deskWords) && /lists 5 to 200 runs/.test(deskWords) && /"no_such_tx" is not a transaction/.test(deskWords) && /"of" says which record's plan/.test(deskWords)
        && okDesk.problems.length === 0 && deskLive.state === "executed", { deskWords, problems: okDesk.problems, deskLive: deskLive.state });
    const deskDef = await call("olga", "screens.get", { name: DESK, as: "olga" });
    const idleDesk = await call("olga", "screens.data", { name: DESK, arg: null, as: "olga" });
    const deskDone = idleDesk.blocks?.[1]?.rows ?? [];
    const mineRows = idleDesk.blocks?.[2]?.rows ?? [];
    const olgaName = (await db.query("SELECT name FROM mes.users WHERE id = 'olga'"))[0].name;
    step("nothing scanned: the record is not shown, and what was done lately is, newest first, each run with who, which, its records, their state's way; mine: only the viewer's",
        deskDef.oneTab === true && idleDesk.blocks[0].$off === "hidden" && deskDone.length >= 4 && deskDone.length <= 10 && deskDone.every((r, k) => k === 0 || r.seq < deskDone[k - 1].seq)
        && deskDone.every((r) => r.who && r.transaction && r.records.length) && deskDone.some((r) => r.records.some((x) => x.object === "lot" && x.to)) && mineRows.length >= 1 && mineRows.every((r) => r.who === olgaName),
        { oneTab: deskDef.oneTab, first: idleDesk.blocks?.[0], done: deskDone.slice(0, 2), mine: mineRows.length });
    // Two kinds of people at one desk: each sees only the forms they may send (Quality is not among Move in's callers).
    const [olgaForms, quinnForms] = [await call("olga", "screens.data", { name: DESK, arg: press, as: "olga" }), await call("quinn", "screens.data", { name: DESK, arg: press, as: "quinn" })];
    step("a form the viewer may not send is left out of the screen: Olga (production) has Move in, Quinn (quality) has not, nothing of it sent",
        !olgaForms.blocks?.[3]?.$off && JSON.stringify(quinnForms.blocks?.[3]) === '{"$off":"hidden"}', { olga: olgaForms.blocks?.[3], quinn: quinnForms.blocks?.[3] });
} catch (error) {
    step("the test ran to the end", false, { error: error.message, body: error.body });
} finally {
    await app.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
