// The sandbox (§5.11) and scenarios (§5.9), end to end:
//   1. Dana changes Move in: a lot over 1000 kg is refused. She opens a sandbox on the change with a
//      real lot and a real machine picked, and a heavy lot given: the draft is what runs there.
//   2. Move in on the real lot, as Olga: it runs, in the sandbox; the live lot and machine are as
//      they were, and the live audit says only that Dana opened a sandbox.
//   3. The given lot: refused by the draft's new check, in its words.
//   4. Every kind of step: an action, an edit, a create (named for later steps), a screen; a reset
//      gives fresh copies again.
//   5. A record nobody may see is not copied; a step as nobody is refused.
//   6. The fitness test: the change without a scenario fails it; with the run saved as one, it
//      passes; a scenario that expects what does not happen fails it, saying what happened.
//   7. Closed: its database is gone.
//   8. Saved selections: the records kept under a name (Save as), listed with their dates, saved over,
//      renamed, a name taken refused, records that are not a selection refused, another designer's not
//      seen and not touched, deleted; a record found by a search over every object.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/sandbox.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "../../../src/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const isPlainV = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const canon = (v) => JSON.stringify(v, (k, x) => (isPlainV(x) ? Object.fromEntries(Object.keys(x).sort().map((n) => [n, x[n]])) : x));
const tag = `${Date.now() % 100000}`;
let app = null;

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of ["dana", "olga", "erp", "sam", "eli"]) {
        sessions[user] = `sx-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const key = () => `sx-${randomBytes(8).toString("hex")}`;

    // ---- 1. a change of Move in, and a sandbox on it ----
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1002'");
    const lot = (await call("sam", "records.create", { object: "lot", data: { lot_no: `SX-${tag}`, item: "PP-BLK-10", work_order: wo.id, qty: 300, uom: "kg" }, key: key() })).id;
    const machine = (await call("sam", "records.create", { object: "machine", data: { machine_id: `SX-M-${tag}`, name: "Sandbox press", kind: "press", capacity: 1 }, key: key() })).id;
    const { id } = await call("dana", "design.start", { transaction: "move_in" });
    const change = await call("dana", "design.change", { id, as: "dana" });
    const body = change.content.transactions.move_in;
    const heavy = { that: { le: [{ lookup: "lot.qty" }, 1000] }, message: `Over 1000 kg: too heavy for this press (${tag}).`, field: "lot" };
    const draft = { ...body, require: [...body.require, heavy] };
    await call("dana", "design.save", { id, seen: change.draft_rev, reason: "Heavy lots stay off the presses.", transactions: { move_in: draft } });
    const records = {
        lot: { object: "lot", id: lot, where: { state: ["created", "in_process"] } },
        press: { object: "machine", id: machine, where: { state: ["idle"] } },
        big: { object: "lot", data: { lot_no: `SX-BIG-${tag}`, item: "PP-BLK-10", work_order: "@wo", qty: 5000, uom: "kg" }, state: "created" },
        wo: { object: "work_order", id: wo.id },
        press2: { object: "machine", data: { machine_id: `SX-M2-${tag}`, name: "Second press", kind: "press", capacity: 1 } },
    };
    const opened = await call("dana", "sandbox.open", { id, records });
    step("a sandbox on the change: the lot and the press copied from live, the work order too, a heavy lot given", opened.open && opened.records.lot?.id === lot && opened.records.press?.state === "idle" && opened.records.big?.state === "created" && opened.copied >= 3, opened);

    // ---- 2. Move in, as Olga, in the sandbox ----
    const run = await call("dana", "sandbox.run", { id, step: { as: "olga", do: { transaction: "move_in", input: { lot: "@lot", machine: "@press" } } } });
    step("Move in on the real lot, as Olga: it runs in the sandbox (the lot at the machine, the press loaded)", run.ok && run.states.lot === "at_machine" && run.states.press === "loaded" && run.data.lot.machine === machine, run);
    const [liveLot] = await db.query("SELECT state, data FROM mes.records WHERE id = $1", [lot]);
    const [liveMachine] = await db.query("SELECT state FROM mes.records WHERE id = $1", [machine]);
    const audits = await db.query("SELECT action FROM mes.audit_log WHERE record_id = $1 OR (object = '$change' AND record_id = $2) ORDER BY seq", [lot, id]);
    step("…the live lot and press are as they were, and the live audit says only that Dana opened a sandbox", liveLot.state === "created" && !liveLot.data.machine && liveMachine.state === "idle" && audits.some((a) => a.action === "sandbox:open") && !audits.some((a) => a.action.startsWith("action:move_in")), { liveLot, liveMachine, audits: audits.map((a) => a.action) });

    // ---- 3. the draft's new check ----
    const big = await call("dana", "sandbox.run", { id, step: { as: "olga", do: { transaction: "move_in", input: { lot: "@big", machine: "@press2" } } } });
    step("the given heavy lot: refused by the draft's new check, in its words", !big.ok && JSON.stringify([big.error, big.fields]).includes(`too heavy for this press (${tag})`), big);

    // ---- 4. every kind of step; a reset ----
    const edited = await call("dana", "sandbox.run", { id, step: { as: "sam", do: { update: "@big", data: { qty: 800 } } } });
    const held = await call("dana", "sandbox.run", { id, step: { as: "sam", do: { action: "hold", record: "@big" } } });
    const made = await call("dana", "sandbox.run", { id, step: { as: "olga", do: { create: "deviation", data: { title: `Heavy lot ${tag}`, lot: "@big", severity: "minor" }, key: "dev" } } });
    const screen = await call("dana", "sandbox.run", { id, step: { as: "olga", do: { screen: "work_centre", arg: "@press" } } });
    step("an action, an edit, a create named for later steps, a screen: each in the sandbox", held.ok && held.states.big === "on_hold" && edited.ok && edited.data.big.qty === 800 && made.ok && made.states.dev === "open" && screen.ok && screen.result?.blocks?.[0]?.record?.state === "loaded", { held: held.error ?? held.states, edited: edited.error, made: made.error ?? made.states, screen: screen.error });
    const reset = await call("dana", "sandbox.reset", { id });
    step("a reset: fresh copies again (the lot back as it is live, the press idle)", reset.records.lot.state === "created" && reset.records.press.state === "idle", reset.records);

    // ---- 5. what nobody may see, nobody ----
    const noRole = await call("dana", "sandbox.run", { id, step: { as: "nobody", do: { transaction: "move_in", input: { lot: "@lot", machine: "@press" } } } });
    const erpOpen = await call("erp", "sandbox.open", { id, records: {} });
    step("a step as nobody is refused; a person with no design role opens no sandbox", noRole.status === 400 && /nobody here/.test(noRole.error) && erpOpen.status === 403, { noRole, erpOpen });

    // ---- 6. the fitness test ----
    const unfit = await call("dana", "design.fitness", { id });
    const scenarioCheck = (r) => r.checks?.find((c) => c.id === "scenarios");
    step("the change without a scenario fails the fitness test, saying what to do", unfit.passed === false && scenarioCheck(unfit)?.status === "fail" && /carries a scenario/.test(scenarioCheck(unfit).items.join()), scenarioCheck(unfit));
    const scenario = {
        name: "a light lot onto an idle press; a heavy one refused",
        records,
        steps: [
            { as: "olga", do: { transaction: "move_in", input: { lot: "@lot", machine: "@press" } }, expect: { ok: true, states: { lot: "at_machine", press: "loaded" } } },
            { as: "olga", do: { transaction: "move_in", input: { lot: "@big", machine: "@press2" } }, expect: { ok: false, error: "too heavy" } },
        ],
    };
    let fresh = await call("dana", "design.change", { id, as: "dana" });
    await call("dana", "design.save", { id, seen: fresh.draft_rev, transactions: { move_in: { ...draft, scenarios: [scenario] } } });
    const fit = await call("dana", "design.fitness", { id });
    step("…with the run saved as a scenario, kept in the transaction, it passes (on fresh copies of the real lot)", scenarioCheck(fit)?.status === "pass" && scenarioCheck(fit).runs?.[0]?.passed, scenarioCheck(fit));
    fresh = await call("dana", "design.change", { id, as: "dana" });
    const wrong = { ...scenario, name: "expects the impossible", steps: [{ ...scenario.steps[0], expect: { ok: true, states: { press: "running" } } }] };
    await call("dana", "design.save", { id, seen: fresh.draft_rev, transactions: { move_in: { ...draft, scenarios: [scenario, wrong] } } });
    const bad = await call("dana", "design.fitness", { id });
    step("…a scenario expecting what does not happen fails it, saying what happened", scenarioCheck(bad)?.status === "fail" && /press is loaded, expected running/.test(scenarioCheck(bad).items.join()), scenarioCheck(bad));
    const shape = await call("dana", "design.check", { transactions: { move_in: { ...draft, scenarios: [{ name: "x", records: { a: { object: "nope" } }, steps: [{ do: { transaction: "move_in", input: { lot: "@b" } } }] }] } } });
    const named = (shape.problems ?? []).map((p) => p.message).join("\n");
    step("a scenario's mistakes are named: an object that is not one, a key that names nothing", /"nope" is not an object/.test(named) && /"@b" names no record/.test(named), shape.problems);

    // ---- 7. closed ----
    const before = await db.query("SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'openmes_test_sbx\\_%' AND datname <> 'openmes_test_sbxt'");
    await call("dana", "sandbox.close", { id });
    const after = await db.query("SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'openmes_test_sbx\\_%' AND datname <> 'openmes_test_sbxt'");
    const gone = await call("dana", "sandbox.run", { id, step: { do: { transaction: "move_in", input: {} } } });
    step("closed: its database is dropped, and a step says to open it again", before[0].n >= 1 && after[0].n === before[0].n - 1 && gone.status === 404 && /open it again/.test(gone.error), { before, after, gone });
    // Opened twice at once (a double click): one sandbox, one database; closed, none.
    const count = async () => (await db.query("SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'openmes_test_sbx\\_%' AND datname <> 'openmes_test_sbxt'"))[0].n;
    const none = await count();
    const both = await Promise.all([call("dana", "sandbox.open", { id, records: {} }), call("dana", "sandbox.open", { id, records: {} })]);
    const one = await count();
    await call("dana", "sandbox.close", { id });
    step("a sandbox opened twice at once is one sandbox: nothing is left behind when it is closed", both.every((r) => r.open) && one === none + 1 && (await count()) === none, { none, one, after: await count() });
    await call("dana", "design.withdraw", { id });

    // ---- 8. saved selections ----
    const NAME = `Press and lots ${tag} 2026-10-03`;
    const savedAs = await call("dana", "sandbox.selection.save", { name: NAME, records });
    let mineList = await call("dana", "sandbox.selections", { as: "dana" });
    const kept = mineList.find((x) => x.id === savedAs.id);
    step("Save as: the records kept under a name, listed with their count and dates, the newest first",
        savedAs.id && kept?.name === NAME && kept.count === Object.keys(records).length && canon(kept.records) === canon(records) && kept.created_at && kept.updated_at && mineList[0].id === savedAs.id, { savedAs, kept });
    const fewer = { lot: records.lot, press: records.press };
    const overSaved = await call("dana", "sandbox.selection.save", { id: savedAs.id, records: fewer });
    const renamed = await call("dana", "sandbox.selection.rename", { id: savedAs.id, name: `Two records ${tag} 2026-10-04` });
    mineList = await call("dana", "sandbox.selections", { as: "dana" });
    const after2 = mineList.find((x) => x.id === savedAs.id);
    step("Save over it, then rename it (a date in the name): one selection, its records and name changed",
        !overSaved.error && !renamed.error && after2?.count === 2 && after2.name === `Two records ${tag} 2026-10-04` && mineList.filter((x) => x.id === savedAs.id).length === 1, { overSaved, renamed, after2 });
    const second = await call("dana", "sandbox.selection.save", { name: `Second ${tag}`, records: fewer });
    const takenName = await call("dana", "sandbox.selection.rename", { id: second.id, name: `Two records ${tag} 2026-10-04` });
    const badKey = await call("dana", "sandbox.selection.save", { name: `Bad ${tag}`, records: { "Not a key": { object: "lot" } } });
    const noName = await call("dana", "sandbox.selection.save", { name: "  ", records: fewer });
    step("refused in words: a name taken among one's own, a key that is not one, no name",
        takenName.status === 409 && /already/.test(takenName.error) && badKey.status === 400 && /a key is lower case/.test(badKey.error) && noName.status === 400 && /Name the selection/.test(noName.error), { takenName, badKey, noName });
    const elis = await call("eli", "sandbox.selections", { as: "eli" });
    const eliDel = await call("eli", "sandbox.selection.delete", { id: savedAs.id });
    step("another designer's selections are theirs: not listed, and not deleted", !elis.some?.((x) => x.id === savedAs.id) && eliDel.status === 404, { elis: elis.length ?? elis, eliDel });
    const gone8 = await call("dana", "sandbox.selection.delete", { id: savedAs.id });
    await call("dana", "sandbox.selection.delete", { id: second.id });
    mineList = await call("dana", "sandbox.selections", { as: "dana" });
    step("Delete: gone from the list", gone8.deleted === savedAs.id && !mineList.some((x) => [savedAs.id, second.id].includes(x.id)), mineList);
    const [aLot] = await db.query("SELECT data->>'lot_no' AS no FROM mes.records WHERE id = $1", [lot]);
    const found = await call("dana", "records.search", { q: aLot.no });
    step("a record found by a search over every object: the lot by its number, with its object and state, to add to the selection", found.some?.((h) => h.id === lot && h.object === "lot" && h.title === aLot.no && typeof h.state === "string"), found);
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
