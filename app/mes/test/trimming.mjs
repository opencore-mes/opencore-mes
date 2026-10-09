// What a person typed, trimmed wherever it enters (§11.1a), end to end over HTTP on the seed:
//   1. A lot made with spaces around its number, item, unit and work order: kept without them.
//   2. A required field given only spaces is refused, as empty, in words.
//   3. Found by its number with spaces around what is searched.
//   4. A machine made with spaces; a transaction (Move in) given record ids with spaces around them: run.
//   5. A plan's input screen: a text with spaces kept without them; only spaces refused as empty.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/trimming.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
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
    const sessions = {};
    for (const user of ["sam", "olga", "quinn"]) {
        sessions[user] = `tr-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? (body && typeof body === "object" && !Array.isArray(body) ? { ok: true, ...body } : { ok: true, value: body }) : { ok: false, status: res.status, ...body };
    };
    const key = () => `tr-${randomBytes(6).toString("hex")}`;

    // ---- 1. a record ----
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1001'");
    const made = await call("sam", "records.create", { object: "lot", data: { lot_no: `  TR-${tag} `, item: "  PA66-NAT-25\t", work_order: ` ${wo.id} `, qty: 10, uom: " kg " }, key: key() });
    const [row] = await db.query("SELECT data FROM mes.records WHERE object = 'lot' AND id = $1", [made.id]);
    step("a lot made with spaces around its number, item, unit and work order: kept without them",
        made.ok && row?.data.lot_no === `TR-${tag}` && row.data.item === "PA66-NAT-25" && row.data.uom === "kg" && row.data.work_order === wo.id, { made, data: row?.data });

    // ---- 2. only spaces is empty ----
    const blank = await call("sam", "records.update", { object: "lot", id: made.id, rowVersion: made.row_version, data: { item: "    " }, key: key() });
    step("a required field given only spaces is refused, as empty, in words", blank.status === 400 && /item/i.test(JSON.stringify(blank.fields ?? {})), blank);

    // ---- 3. search ----
    const found = await call("sam", "records.list", { object: "lot", as: "sam", q: `   TR-${tag}  ` });
    step("found by its number with spaces around what is searched", found.ok && found.rows?.some((r) => r.id === made.id), { rows: found.rows?.length });

    // ---- 4. a transaction ----
    // On a press of its own (made with spaces too), so the seed's machines stay free for the suites after.
    const press = await call("sam", "records.create", { object: "machine", data: { machine_id: ` TR-M-${tag} `, name: "  Trim press ", kind: " press", capacity: 1 }, key: key() });
    const moved = press.ok ? await call("olga", "transactions.run", { name: "move_in", input: { lot: `  ${made.id} `, machine: ` ${press.id}  ` }, key: key() }) : null;
    step("a machine made with spaces, and a transaction given record ids with spaces around them: both kept and run (Move in)",
        press.ok && press.machine_id === `TR-M-${tag}` && press.kind === "press" && moved?.ok, { press, moved });

    // ---- 5. a plan's input screen ----
    // On the lot made above: the plan holds its lot, and the seed's lots are other suites' to count.
    const dev = await call("quinn", "records.create", { object: "deviation", data: { title: `Trim ${tag}`, lot: made.id, severity: "major" }, key: key() });
    const [plan] = await db.query("SELECT id FROM mes.flow_runs WHERE subject_id = $1 AND flow = 'deviation_response'", [dev.id]);
    const spaces = await call("quinn", "flows.act", { run: plan?.id, values: { action: "    ", quarantined: true } });
    const kept = await call("quinn", "flows.act", { run: plan?.id, values: { action: "  Lot quarantined in cage 3  ", quarantined: true } });
    const [after] = await db.query("SELECT context FROM mes.flow_runs WHERE id = $1", [plan?.id]);
    step("a plan's input screen: only spaces is refused as empty; a text with spaces around it is kept without them",
        spaces.status === 400 && spaces.fields?.action && kept.ok && after?.context.action === "Lot quarantined in cage 3", { spaces, kept, context: after?.context });
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
