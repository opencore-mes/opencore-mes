// Retiring designs (§5.10), and taking elements out of a draft, end to end against a running server:
//   1. Retiring what is still used is refused, naming each use: Move in (the Work centre offers it;
//      the lot's and the machine's policies apply through it); the deviation object (its records are
//      in use).
//   2. The Shop floor screen, used by nothing: retired through the lifecycle (routed to its stewards,
//      reviewed, approved, executed). It leaves the navigator; its version stays, marked retired.
//   3. Published again under the same name: the next version, not a clash.
//   4. A draft's element is taken out of the change (null), and a change that retires one thing may
//      not also change it.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/retire.mjs   (after a reset)
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
for (const user of ["dana", "eli", "vera", "sam", "quinn", "olga", "ivan", "ines"]) {
    sessions[user] = `rt-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status, body });
    return body;
};

try {
    // ---- 1. still used ----
    const tx = await call("dana", "design.start", { retire: { kind: "transactions", name: "move_in" } });
    let change = await call("dana", "design.change", { id: tx.id, as: "dana" });
    const words = change.problems.map((p) => p.message).join("\n");
    step("retiring Move in is refused: the screen that offers it and the policies that apply through it are named", /transaction move_in is still used/.test(words) && /screen work_centre offers it/.test(words) && /lot's policy lot-machine-moves applies through it/.test(words) && /machine's policy machine-lot-moves applies through it/.test(words), change.problems);
    step("…the change says what it retires, as published", change.retire?.transactions?.includes("move_in") && change.live.retire.transactions.move_in.version === 1, change.retire);
    await call("dana", "design.withdraw", { id: tx.id });
    const dev = await call("dana", "design.start", { retire: { kind: "definitions", name: "deviation" } });
    change = await call("dana", "design.change", { id: dev.id, as: "dana" });
    step("retiring an object with records in use is refused: archive them first", change.problems.some((p) => /object deviation: \d+ record\(s\) are still in use: archive them first/.test(p.message)), change.problems);
    await call("dana", "design.withdraw", { id: dev.id });

    // ---- 2. retire the Shop floor ----
    const sf = await call("dana", "design.start", { retire: { kind: "screens", name: "shop_floor" } });
    await call("dana", "design.save", { id: sf.id, reason: "The board moves to the new line view." });
    change = await call("dana", "design.change", { id: sf.id, as: "dana" });
    step("used by nothing: no problems; routed to its stewards", change.problems.length === 0 && change.route.map((r) => r.department).join() === "production", { problems: change.problems, route: change.route });
    await call("dana", "design.submit", { id: sf.id });
    await call("eli", "design.review", { id: sf.id, decision: "pass" });
    const done = await call("sam", "design.approve", { id: sf.id, department: "production", decision: "approve", meaning: "Approved" });
    step("approved and executed: retired", done.state === "executed" && done.outcome.retired?.screens?.[0] === "shop_floor v1", done);
    step("it leaves the navigator, and opens for nobody", !(await call("olga", "screens.list", { as: "olga" })).some((s) => s.name === "shop_floor") && (await call("olga", "screens.get", { name: "shop_floor", as: "olga" })) === null);
    const [kept] = await db.query("SELECT version, status FROM mes.screens WHERE name = 'shop_floor'");
    step("its version stays, marked retired", kept.version === 1 && kept.status === "retired", kept);

    // ---- 3. back again ----
    const again = await call("dana", "design.start", { screen: "shop_floor", label: "Shop floor" });
    const body = { ...(await call("dana", "design.change", { id: again.id, as: "dana" })).content.screens.shop_floor, blocks: [{ block: "breakdown", title: "Machines", object: "machine", by: "state", measure: "count", width: 12 }], callers: { groups: ["production"] }, stewards: ["production"] };
    await call("dana", "design.save", { id: again.id, reason: "Back, smaller.", screens: { shop_floor: body } });
    await call("dana", "design.submit", { id: again.id });
    await call("eli", "design.review", { id: again.id, decision: "pass" });
    const back = await call("sam", "design.approve", { id: again.id, department: "production", decision: "approve", meaning: "Approved" });
    step("published again under the same name: version 2", back.state === "executed" && back.outcome.screens?.shop_floor === 2, back);
    step("…and it opens again", (await call("olga", "screens.get", { name: "shop_floor", as: "olga" }))?.version === 2);

    // ---- 4. out of a draft ----
    const draft = await call("dana", "design.start", { screen: `tmp_t${tag}`, label: "Tmp" });
    await call("dana", "design.save", { id: draft.id, reason: "x", transactions: { [`tmp_tx_t${tag}`]: { name: `tmp_tx_t${tag}`, label: "Tmp", inputs: {}, require: [], steps: [], callers: { groups: [] }, stewards: ["production"] } }, definitions: { work_order: (await db.query("SELECT body FROM mes.definitions WHERE object = 'work_order' AND status = 'published'"))[0].body } });
    await call("dana", "design.save", { id: draft.id, transactions: { [`tmp_tx_t${tag}`]: null }, definitions: { work_order: null } });
    change = await call("dana", "design.change", { id: draft.id, as: "dana" });
    step("an element taken out of a draft (null): gone from the change, the rest stays", !change.content.transactions[`tmp_tx_t${tag}`] && !change.content.definitions.work_order && change.content.screens[`tmp_t${tag}`], change.content);
    await call("dana", "design.save", { id: draft.id, retire: { screens: ["work_centre"] }, screens: { work_centre: (await db.query("SELECT body FROM mes.screens WHERE name = 'work_centre' AND status = 'published'"))[0].body } });
    change = await call("dana", "design.change", { id: draft.id, as: "dana" });
    step("retiring and changing one element in the same change is refused", change.problems.some((p) => /screen work_centre is both changed and retired/.test(p.message)), change.problems);
    await call("dana", "design.withdraw", { id: draft.id });

    // ---- 5. what a signed change relies on, retired before its last signature (§5.3) ----
    const BY = { production: "sam", quality: "quinn", engineering: "eli" };
    const toApproval = async (id) => { await call("dana", "design.submit", { id }); await call("vera", "design.review", { id, decision: "pass" }); };
    const signAll = async (id) => {
        let last = null;
        for (const r of (await call("dana", "design.change", { id, as: "dana" })).route) last = await call(BY[r.department], "design.approve", { id, department: r.department, decision: "approve", meaning: "Approved" });
        return last;
    };
    const TMP = `tmp_obj_t${tag}`;
    const made = await call("dana", "design.start", { object: TMP, label: "Tmp object" });
    const tmpBody = (await call("dana", "design.change", { id: made.id, as: "dana" })).content.definitions[TMP];
    await call("dana", "design.save", { id: made.id, reason: "An object for a screen to show.", definitions: { [TMP]: { ...tmpBody, stewards: { object: ["production"] } } } });
    await toApproval(made.id);
    const tmpLive = await signAll(made.id);
    const relying = await call("dana", "design.start", { screen: `tmp_scr_t${tag}`, label: "Tmp board" });
    const scr = (await call("dana", "design.change", { id: relying.id, as: "dana" })).content.screens[`tmp_scr_t${tag}`];
    await call("dana", "design.save", { id: relying.id, reason: "A board of the tmp objects.", screens: { [`tmp_scr_t${tag}`]: { ...scr, blocks: [{ block: "breakdown", title: "Tmp", object: TMP, by: "state", measure: "count", width: 12 }], callers: { groups: ["production"] }, stewards: ["production"] } } });
    const fine = (await call("dana", "design.change", { id: relying.id, as: "dana" })).problems;
    await toApproval(relying.id);
    const gone = await call("dana", "design.start", { retire: { kind: "definitions", name: TMP } });
    await call("dana", "design.save", { id: gone.id, reason: "Not needed after all." });
    await toApproval(gone.id);
    const retired = await signAll(gone.id);
    const late = await signAll(relying.id);
    const [stays] = await db.query("SELECT count(*)::int AS n FROM mes.screens WHERE name = $1", [`tmp_scr_t${tag}`]);
    step("a change whose object was retired after it was reviewed does not go live at its last signature: it fails, saying what it relied on changed",
        tmpLive?.state === "executed" && fine.length === 0 && retired?.state === "executed" && late?.state === "failed" && /no longer passes the checks/.test(late.error) && stays.n === 0, { tmpLive, fine, retired, late, stays });

    // ---- 6. a department that came to answer for it after it was submitted, and never signed ----
    const everyone = async (id) => {
        let state = null;
        for (let round = 0; round < 4 && !["executed", "failed", "rejected"].includes(state); round++) for (const user of ["eli", "sam", "quinn", "ivan", "ines", "vera"]) {
            const seen = await call(user, "design.change", { id, as: user });
            for (const department of seen.can?.approveFor ?? []) { const r = await call(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" }); state = r.state ?? state; if (r.error) state = "failed"; if (r.state === "failed") return r; }
        }
        return { state };
    };
    const standing = async (value, reason) => {
        const org = await call("dana", "design.start", { organization: true });
        const now = (await call("dana", "design.change", { id: org.id, as: "dana" })).content.organization;
        await call("dana", "design.save", { id: org.id, reason, organization: { ...now, standing: value(now.standing ?? {}) } });
        await toApproval(org.id);
        return everyone(org.id);
    };
    const board = await call("dana", "design.start", { screen: "shop_floor" });
    const boardBody = (await call("dana", "design.change", { id: board.id, as: "dana" })).content.screens.shop_floor;
    await call("dana", "design.save", { id: board.id, reason: "A clearer title.", screens: { shop_floor: { ...boardBody, blocks: boardBody.blocks.map((b, i) => (i ? b : { ...b, title: "Machines by state" })) } } });
    await toApproval(board.id);
    const routeThen = (await call("dana", "design.change", { id: board.id, as: "dana" })).route.map((r) => r.department);
    const added = await standing((st) => ({ ...st, screen: ["quality"] }), "Quality signs every screen from now on.");
    const unsigned = await everyone(board.id);
    const [boardNow] = await db.query("SELECT version FROM mes.screens WHERE name = 'shop_floor' AND status = 'published'");
    step("a change that came to answer to a department after it was submitted does not go live on the signatures it has: it fails, naming who never signed",
        !routeThen.includes("quality") && added.state === "executed" && unsigned.state === "failed" && /answer to quality as well, who never signed it/.test(unsigned.error ?? "") && boardNow.version === 2,
        { routeThen, added, unsigned, boardNow });
    const undone = await standing((st) => { const { screen, ...rest } = st; return rest; }, "Back as it was.");
    step("…and the standing approver is taken off again, for the suites after this one", undone.state === "executed", undone);
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
