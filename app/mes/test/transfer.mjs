// Excel import and export (DESIGN.md §24), end to end against the database:
//   1. Export lots with the records they refer to: a lot tab, a work order tab with exactly the
//      orders referred to, references written as order numbers, an _about tab.
//   2. Import a workbook of two models: a new work order and new lots that refer to it by number.
//      The preview changes nothing and says what would happen; applying creates them, work orders
//      first, the lots pointing at the new order.
//   3. The models' controls: lots may not be updated (a changed lot is refused), work orders may.
//   4. Rules and rights apply per row: a quantity over the order's limit is refused by the lot's rule.
//   5. Applying the same file twice changes nothing twice. A model whose design forbids export.
//   6. The record as the file saw it: each row carries its row_version; a record changed since the
//      export is refused, not written over; emptying the cell writes over it on purpose.
//   7. The model as the file saw it: a tab exported from another version of its model is reported,
//      with how its fields changed; one exported from the model in use is not.
//
//   DATABASE_URL=postgres:///openmes_poc node app/mes/test/transfer.mjs
import pg from "pg";
import { fromPg } from "../../../src/server/db.js";
import { createStore } from "../server/store.js";
import { createServices } from "../server/services.js";
import { createTransfer } from "../server/transfer.js";
import { CALL_KIND } from "../../../src/live-protocol.js";
import { writeXlsx, readXlsx } from "../server/xlsx.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const store = createStore(db);
const records = createServices({ store });
const transfer = createTransfer({ store, records: records.services });
const made = [];
try {
    const sam = await store.user("sam");
    // ---- 1. export ----
    const { buffer, models } = await transfer.exportWorkbook(sam, ["lot"], { related: true });
    const sheets = readXlsx(buffer);
    const lotTab = sheets.find((s) => s.name === "lot");
    const woTab = sheets.find((s) => s.name === "work_order");
    const col = (tab, name) => tab.rows[0].indexOf(name);
    const referred = new Set(lotTab.rows.slice(1).map((r) => r[col(lotTab, "work_order")]));
    step("export: the lots, and in their own tab exactly the work orders they refer to, as order numbers", sheets[0].name === "_about" && lotTab.rows.length >= 4 && woTab && woTab.rows.length - 1 === referred.size && [...referred].every((n) => /^WO-/.test(n)), { tabs: sheets.map((s) => s.name), models, referred: [...referred] });

    // ---- 2. a workbook of two models ----
    const wo = `WO-T${tag}`;
    const book = writeXlsx([
        { name: "lot", rows: [["lot_no", "item", "work_order", "qty", "uom"], [`T${tag}-1`, "PA66-NAT-25", wo, 100, "kg"], [`T${tag}-2`, "PA66-NAT-25", wo, 5000, "kg"], ["4711", "PA66-NAT-25", "WO-1001", 999, "kg"]] },
        { name: "work_order", rows: [["wo_no", "item", "qty", "line", "due"], [wo, "PA66-NAT-25", 500, "L2", "2026-12-01"], ["WO-1002", "PP-BLK-10", 900, "L1", "2026-10-22"]] },
        { name: "notes", rows: [["anything"]] },
    ]);
    const before = (await db.query("SELECT count(*)::int AS n FROM mes.records"))[0].n;
    const preview = await transfer.importWorkbook(sam, book, { apply: false });
    const after = (await db.query("SELECT count(*)::int AS n FROM mes.records"))[0].n;
    const pLot = preview.models.find((m) => m.object === "lot");
    const pWo = preview.models.find((m) => m.object === "work_order");
    step("preview: nothing changes; work orders first; a new order and its lots to create, checked on apply", after === before && preview.models[0].object === "work_order" && pWo.counts.create === 1 && pLot.counts.create === 2 && pLot.rows.some((r) => /this import creates/.test(r.note ?? "")) && preview.warnings.some((w) => /"notes" is not a model/.test(w)), { counts: preview.models.map((m) => [m.object, m.counts]), warnings: preview.warnings });

    // ---- 3–4. apply: controls, rules ----
    const applied = await transfer.importWorkbook(sam, book, { apply: true });
    const aLot = applied.models.find((m) => m.object === "lot");
    const aWo = applied.models.find((m) => m.object === "work_order");
    const [newWo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = $1", [wo]);
    const newLots = await db.query("SELECT data FROM mes.records WHERE object = 'lot' AND data->>'lot_no' LIKE $1", [`T${tag}-%`]);
    made.push(...(await db.query("SELECT id FROM mes.records WHERE (object = 'work_order' AND data->>'wo_no' = $1) OR (object = 'lot' AND data->>'lot_no' LIKE $2)", [wo, `T${tag}-%`])).map((r) => r.id));
    step("apply: the new work order, then the lot that refers to it by number", aWo.counts.create === 1 && newWo && newLots.length === 1 && newLots[0].data.work_order === newWo.id, { lots: newLots.length });
    const over = aLot.rows.find((r) => r.row === 3);
    step("the lot's own rule refuses a quantity 10 times the order's: the row is refused in the rule's words", over?.action === "refused" && /At most/.test(over.message), over);
    const existing = aLot.rows.find((r) => r.row === 4);
    step("lots may not be updated by import (the model's controls): an existing lot is refused, untouched", existing?.action === "refused" && /updating Lot records by import is not allowed/.test(existing.message), existing);
    const updatedWo = aWo.rows.find((r) => r.row === 3);
    const [wo2] = await db.query("SELECT data->>'qty' AS qty FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1002'");
    step("work orders may be updated, matched by number: only the changed field is written", updatedWo?.action === "update" && updatedWo.fields.join() === "qty" && Number(wo2.qty) === 900, updatedWo);
    const [audit] = await db.query("SELECT count(*)::int AS n FROM mes.audit_log WHERE actor = 'sam' AND object = 'work_order' AND action = 'update' AND after->>'qty' = '900'");
    step("…audited as the person who imported", audit.n >= 1);

    // ---- 5. again, and a forbidden export ----
    const again = await transfer.importWorkbook(sam, book, { apply: true });
    const total = (await db.query("SELECT count(*)::int AS n FROM mes.records WHERE (object = 'work_order' AND data->>'wo_no' = $1) OR (object = 'lot' AND data->>'lot_no' LIKE $2)", [wo, `T${tag}-%`]))[0].n;
    step("the same file applied twice creates nothing twice", total === 2, { again: again.models.map((m) => [m.object, m.counts]) });
    const olga = await store.user("olga");
    const noImport = await transfer.importWorkbook(olga, writeXlsx([{ name: "deviation", rows: [["title", "severity"], ["x", "minor"]] }]), { apply: false });
    step("a model whose design does not allow import: every row refused, saying so", noImport.models[0].counts.refused === 1 && /may not be imported/.test(noImport.models[0].rows[0].message), noImport.models[0].rows[0]);
    const [dev] = await db.query("SELECT version, body FROM mes.definitions WHERE object = 'deviation' AND status = 'published'");
    await db.query("UPDATE mes.definitions SET body = jsonb_set(body, '{transfer}', '{\"export\": false}') WHERE object = 'deviation' AND version = $1", [dev.version]);
    store.forget?.();
    const refused = await transfer.exportWorkbook(olga, ["deviation"]).then(() => null, (e) => e.message);
    await db.query("UPDATE mes.definitions SET body = $2 WHERE object = 'deviation' AND version = $1", [dev.version, JSON.stringify(dev.body)]);
    store.forget?.();
    step("a model whose design forbids export: refused, saying why", /may not be exported/.test(refused ?? ""), refused);

    // ---- 6. the record as the file saw it ----
    const exportOrders = async () => readXlsx((await transfer.exportWorkbook(sam, ["work_order"], { related: false })).buffer);
    const orders = await exportOrders();
    const woSheet = orders.find((s) => s.name === "work_order");
    const at = (name) => woSheet.rows[0].indexOf(name);
    const line = woSheet.rows.find((r) => r[at("wo_no")] === "WO-1002");
    const [rec] = await db.query("SELECT id, row_version FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1002'");
    step("export: each row carries its record's row_version", at("row_version") === 2 && line?.[at("row_version")] === Number(rec.row_version), { header: woSheet.rows[0], line });
    const fresh = await transfer.importWorkbook(sam, writeXlsx(orders), { apply: false });
    const freshWo = fresh.models.find((m) => m.object === "work_order");
    step("…imported back as it was: every row unchanged, nothing reported about the model", freshWo.counts.unchanged === woSheet.rows.length - 1 && !freshWo.model && !freshWo.warnings.some((w) => /exported from version/.test(w)), { counts: freshWo.counts, warnings: freshWo.warnings });
    // Someone changes the order after the export; the file, applied, would put the old quantity back.
    await records.services["records.update"].call({ [CALL_KIND]: "internal", reason: "test", user: sam }, { object: "work_order", id: rec.id, rowVersion: Number(rec.row_version), data: { qty: 950 } });
    const stale = await transfer.importWorkbook(sam, writeXlsx(orders), { apply: true });
    const staleRow = stale.models.find((m) => m.object === "work_order").rows.find((r) => r.action === "refused");
    const [kept] = await db.query("SELECT data->>'qty' AS qty FROM mes.records WHERE id = $1", [rec.id]);
    step("a record changed since the export is refused, saying so and how to write over it; the change stays", /changed since this file was exported/.test(staleRow?.message ?? "") && /empty its row_version cell/.test(staleRow.message) && staleRow.fields?.join() === "qty" && Number(kept.qty) === 950, staleRow);
    line[at("row_version")] = null;
    const overwrite = await transfer.importWorkbook(sam, writeXlsx(orders), { apply: true });
    const overWo = overwrite.models.find((m) => m.object === "work_order");
    const [back] = await db.query("SELECT data->>'qty' AS qty FROM mes.records WHERE id = $1", [rec.id]);
    step("…with its row_version cell emptied, the row writes over it on purpose", overWo.counts.update === 1 && Number(back.qty) === 900, overWo.counts);
    const twice = await transfer.importWorkbook(sam, writeXlsx(orders), { apply: true });
    step("…and that file applied again changes nothing twice", twice.models.find((m) => m.object === "work_order").counts.refused === 0, twice.models.find((m) => m.object === "work_order").counts);

    // ---- 7. the model as the file saw it ----
    const older = await exportOrders();
    const aboutTab = older.find((s) => s.name === "_about");
    const modelRow = aboutTab.rows.find((r) => r[0] === "work_order" && Number.isInteger(r[2]));
    const inUse = modelRow[2];
    modelRow[2] = inUse - 1;
    const qtyRow = aboutTab.rows.find((r) => r[0] === "work_order" && r[1] === "qty");
    qtyRow[2] = "Quantity (lb)";
    const moved = (await transfer.importWorkbook(sam, writeXlsx(older), { apply: false })).models.find((m) => m.object === "work_order");
    step("a tab exported from another version of its model is reported, with how its fields changed", moved.model?.exported === inUse - 1 && moved.model.inUse === inUse && moved.model.changes.some((c) => /qty was labelled "Quantity \(lb\)"/.test(c)) && moved.warnings.includes(moved.model.message), moved.model);
} catch (error) {
    step("unexpected", false, { message: error.message, stack: error.stack?.split("\n").slice(0, 4) });
} finally {
    if (made.length) {
        await db.query("DELETE FROM mes.state_intervals WHERE record_id = ANY($1::uuid[])", [made]);
        await db.query("DELETE FROM mes.records WHERE id = ANY($1::uuid[])", [made]);
    }
    await db.query("DELETE FROM mes.idempotency WHERE key LIKE 'imp-%'");
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
console.log(JSON.stringify(steps, null, 1));
console.log(failed.length ? `\n${failed.length} step(s) FAILED` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
