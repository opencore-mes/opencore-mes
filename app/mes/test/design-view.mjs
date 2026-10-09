// Viewing a live design without a change (§5.1), end to end:
//   1. Dana views the Lot object: what is live, its rule scripts with their test cases, every right
//      a change has turned off; no change request is made by it.
//   2. Vera (a reviewer) views it too; the ERP user, with no design role, may not.
//   3. A transaction and a screen are viewed alike; a name that is not live is null; a kind that
//      is not one is refused.
//   4. What a design relies on (Move in: the lot, the machine), shown beside it when asked (`with`).
//   5. Once Dana starts a change of the Lot, the view names it (and offers no second one).
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/design-view.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
let app = null;

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of ["erp", "dana", "vera"]) {
        sessions[user] = `dv-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status };
    };
    const changes = async () => (await db.query("SELECT count(*)::int AS n FROM mes.change_requests"))[0].n;

    // ---- 1. the Lot, live ----
    const before = await changes();
    const [lot] = await db.query("SELECT version, body FROM mes.definitions WHERE object = 'lot' AND status = 'published'");
    const view = await call("dana", "design.view", { kind: "object", name: "lot", as: "dana" });
    const rules = (lot.body.rules ?? []).map((r) => r.script);
    step("the Lot as it is live: its body, its version, its rule scripts with their test cases", view.id === "view-object-lot" && view.view.version === lot.version && JSON.stringify(view.content.definitions.lot) === JSON.stringify(lot.body) && rules.every((s) => typeof view.content.scripts[s] === "string" && Array.isArray(view.content.tests[s])), { id: view.id, scripts: Object.keys(view.content?.scripts ?? {}) });
    step("…what is live is what it shows (no differences), and every right a change has is off", JSON.stringify(view.live.definitions.lot) === JSON.stringify(view.content.definitions.lot) && Object.values(view.can).every((v) => v === false || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Object.keys(v).length)) && view.view.mayChange === true, view.can);
    step("…and viewing it makes no change request", (await changes()) === before);

    // ---- 2. who may ----
    const vera = await call("vera", "design.view", { kind: "object", name: "lot", as: "vera" });
    const erp = await call("erp", "design.view", { kind: "object", name: "lot", as: "erp" });
    step("Vera, a reviewer, views it (and may not change it); the ERP user, with no design role, may not view it", vera.view?.version === lot.version && vera.view.mayChange === false && erp.status === 403, { vera: vera.view, erp: erp.status ?? "viewed" });

    // ---- 3. other kinds ----
    const tx = await call("dana", "design.view", { kind: "transaction", name: "move_in", as: "dana" });
    const sc = await call("dana", "design.view", { kind: "screen", name: "work_centre", as: "dana" });
    const none = await call("dana", "design.view", { kind: "object", name: "nope", as: "dana" });
    const odd = await call("dana", "design.view", { kind: "table", name: "lot", as: "dana" });
    step("a transaction and a screen alike; a name that is not live is null; a kind that is not one is refused", tx.content?.transactions?.move_in?.name === "move_in" && sc.content?.screens?.work_centre?.name === "work_centre" && none === null && odd.status === 400, { tx: tx.id, sc: sc.id, none, odd });

    // ---- 4. what it relies on, shown beside it ----
    const plain = await call("dana", "design.view", { kind: "transaction", name: "move_in", as: "dana" });
    const withLot = await call("dana", "design.view", { kind: "transaction", name: "move_in", with: ["lot", "machine", "deviation"], as: "dana" });
    const [lotDef] = await db.query("SELECT body FROM mes.definitions WHERE object = 'lot' AND status = 'published'");
    step("Move in relies on the lot and the machine; ticked, they are shown beside it with their rule scripts (an object it does not rely on is not)", plain.view.uses.map((u) => u.object).join() === "lot,machine" && !Object.keys(plain.content.definitions).length && withLot.view.with.join() === "lot,machine" && Object.keys(withLot.content.definitions).join() === "lot,machine" && (lotDef.body.rules ?? []).every((r) => typeof withLot.content.scripts[r.script] === "string") && withLot.updated_at !== plain.updated_at, { uses: plain.view.uses, with: withLot.view?.with, defs: Object.keys(withLot.content?.definitions ?? {}) });
    const deviation = await call("dana", "design.view", { kind: "object", name: "deviation", with: ["lot"], as: "dana" });
    step("an object relies on what its references name: the deviation on the lot, shown after it", deviation.view.uses.map((u) => u.object).join() === "lot" && Object.keys(deviation.content.definitions).join() === "deviation,lot", deviation.view);

    // ---- 5. a change of it ----
    const started = await call("dana", "design.start", { object: "lot" });
    const after = await call("dana", "design.view", { kind: "object", name: "lot", as: "dana" });
    step("once a change of the Lot is open, the view names it and offers no second one", after.view.open.some((c) => c.id === started.id) && after.view.mayChange === false, after.view);
    await call("dana", "design.withdraw", { id: started.id });
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
