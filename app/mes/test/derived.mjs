// Derived fields (DESIGN.md §6.11), end to end over HTTP on the seed:
//   1. Products and lots, live; records made before any field is derived.
//   2. A change derives the lot's control from its product (a path) and whether it is military (an
//      expression), and a wafer's from its lot and its lot's product (two hops): executing it fills the
//      lots made before, as the platform, sealed, one audit row.
//   3. A wafer made: its derived fields worked out; a value given for one is not the writer's to say.
//   4. The product reclassified: its lots and their wafers follow in the same write, each audited
//      ("derive", naming the product), sealed, a version on; the lot's list moves with it.
//   5. A lot moved to another product: its own write works its control out again.
//   6. What a design check refuses: a path that does not go, a loop.
//   7. The query view has the derived column, as any field.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/derived.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { sealOfRecord } from "../server/integrity.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
let app = null;
const people = ["dana", "eli", "vera", "sam", "quinn"];

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of people) {
        sessions[user] = `dv-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? (body && typeof body === "object" && !Array.isArray(body) ? { ok: true, ...body } : { ok: true, value: body }) : { ok: false, status: res.status, ...body };
    };
    const key = () => `dv-${randomBytes(6).toString("hex")}`;
    const approveAll = async (id) => {
        const submitted = await call("dana", "design.submit", { id });
        if (!submitted.ok) return { state: null, submitted };
        await call("vera", "design.review", { id, decision: "pass" });
        let state = null;
        for (let round = 0; round < 3 && state !== "executed"; round++) for (const user of people) {
            const seen = await call(user, "design.change", { id, as: user });
            for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
        }
        return { state };
    };
    const change = async (definitions, reason) => {
        const first = Object.keys(definitions)[0];
        const started = await call("dana", "design.start", { object: first, label: definitions[first].label });
        const seen = await call("dana", "design.change", { id: started.id, as: "dana" });
        const saved = await call("dana", "design.save", { id: started.id, seen: seen.draft_rev, reason, definitions });
        await app.store?.forget?.();
        return { id: started.id, saved };
    };
    const row = async (object, id) => (await db.query("SELECT * FROM mes.records WHERE object = $1 AND id = $2", [object, id]))[0];
    const sealed = (object, r) => r && r.seal === sealOfRecord(object, r);

    const [PRODUCT, LOT, WAFER] = ["product", "lot", "wafer"].map((x) => `dv_${x}_t${tag}`);
    const open = (object) => [{ id: `${object}-all`, roles: ["user"], record: { read: true, create: true }, fields: { "*": "write" } }];
    const object = (name, label, fields, titleField) => ({ object: name, label, area: "Production", titleField, fields, states: { initial: "open", list: ["open"], transitions: [] }, roles: ["user"], stewards: { object: ["production"] }, policies: open(name), rules: [] });
    const productDef = object(PRODUCT, `Derived product ${tag}`, { code: { label: "Code", type: "string" }, control: { label: "Control", type: "enum", values: ["none", "military"] } }, "code");
    const lotPlain = object(LOT, `Derived lot ${tag}`, { lot_id: { label: "Lot", type: "string" }, product: { label: "Product", type: "ref", to: PRODUCT } }, "lot_id");

    // ---- 1. live, with records ----
    // Who holds the objects' roles is the organization's to say (§27); here the test's people hold them.
    const holdRoles = (objects) => db.query("INSERT INTO mes.assignments (object, role, subject_kind, subject_id) SELECT o, 'user', 'user', u FROM unnest($1::text[]) o, unnest($2::text[]) u ON CONFLICT DO NOTHING", [objects, ["sam", "eli", "quinn"]]);
    const one = await change({ [PRODUCT]: productDef, [LOT]: lotPlain }, "Products and lots.");
    const oneDone = await approveAll(one.id);
    await holdRoles([PRODUCT, LOT, WAFER]);
    const make = (o, data) => call("sam", "records.create", { object: o, data, key: key() });
    const p1 = await make(PRODUCT, { code: `CIV-${tag}`, control: "none" });
    const p2 = await make(PRODUCT, { code: `MIL-${tag}`, control: "military" });
    const l1 = await make(LOT, { lot_id: `L1-${tag}`, product: p1.id });
    const l2 = await make(LOT, { lot_id: `L2-${tag}`, product: p2.id });
    const l3 = await make(LOT, { lot_id: `L3-${tag}` });
    step("products and lots live, and records made before any field is derived", !one.saved.problems?.length && oneDone.state === "executed" && p1.ok && p2.ok && l1.ok && l2.ok && l3.ok, { problems: one.saved.problems, oneDone, p1, l1 });

    // ---- 2. derived, filled at execution ----
    const lotDerived = { ...lotPlain, fields: { ...lotPlain.fields,
        control: { label: "Control", type: "string", from: "product.control" },
        military: { label: "Military", type: "boolean", from: { eq: [{ record: "product.control" }, "military"] } } } };
    const waferDef = object(WAFER, `Derived wafer ${tag}`, { mark: { label: "Mark", type: "string" }, lot: { label: "Lot", type: "ref", to: LOT },
        control: { label: "Control", type: "string", from: "lot.control" }, product_code: { label: "Product", type: "string", from: "lot.product.code" } }, "mark");
    const two = await change({ [LOT]: lotDerived, [WAFER]: waferDef }, "The lot's control comes from its product; a wafer's from its lot.");
    const twoDone = await approveAll(two.id);
    const [r1, r2, r3] = [await row(LOT, l1.id), await row(LOT, l2.id), await row(LOT, l3.id)];
    const [platform] = await db.query("SELECT actor, after FROM mes.audit_log WHERE object = $1 AND action = 'derive' AND record_id IS NULL ORDER BY seq DESC LIMIT 1", [LOT]);
    step("a change derives the lot's control (a path) and military (an expression): executing it fills the lots made before, as the platform, sealed, one audit row",
        twoDone.state === "executed" && r1.data.control === "none" && r1.data.military === false && r2.data.control === "military" && r2.data.military === true && (r3.data.control ?? null) === null &&
        sealed(LOT, r1) && sealed(LOT, r2) && platform?.actor === "platform" && platform.after.records >= 2,
        { problems: two.saved.problems, twoDone, r1: r1?.data, r2: r2?.data, platform });

    // ---- 3. a wafer ----
    const w1 = await make(WAFER, { mark: `W1-${tag}`, lot: l2.id, control: "none" });
    const w1row = await row(WAFER, w1.id);
    step("a wafer made: its control from its lot, its product's code through two references; the control it was given is not the writer's to say",
        w1.ok && w1row.data.control === "military" && w1row.data.product_code === `MIL-${tag}` && w1.$perm?.fields?.control === "r", { w1, data: w1row?.data });
    const typed = await call("sam", "records.update", { object: WAFER, id: w1.id, rowVersion: w1.row_version, data: { control: "none" }, key: key() });
    step("…and changing it is not a change: nothing is written", typed.ok && Number((await row(WAFER, w1.id)).row_version) === Number(w1.row_version), typed);

    // ---- 4. reclassified ----
    const before = { l2: await row(LOT, l2.id), w1: await row(WAFER, w1.id) };
    const reclass = await call("eli", "records.update", { object: PRODUCT, id: p2.id, rowVersion: p2.row_version, data: { control: "none" }, key: key() });
    const after = { l2: await row(LOT, l2.id), w1: await row(WAFER, w1.id) };
    const trail = await db.query("SELECT object, record_id, actor, before, after FROM mes.audit_log WHERE action = 'derive' AND record_id = ANY($1::uuid[]) ORDER BY seq", [[l2.id, w1.id]]);
    step("the product reclassified: its lot and the lot's wafer follow in the same write, each audited as the writer's (\"derive\", naming what it follows), sealed, a version on",
        reclass.ok && after.l2.data.control === "none" && after.l2.data.military === false && after.w1.data.control === "none" &&
        Number(after.l2.row_version) === Number(before.l2.row_version) + 1 && Number(after.w1.row_version) === Number(before.w1.row_version) + 1 &&
        sealed(LOT, after.l2) && sealed(WAFER, after.w1) &&
        trail.some((t) => t.record_id === l2.id && t.actor === "eli" && t.after.$from?.id === p2.id && t.before.control === "military" && t.after.control === "none") &&
        trail.some((t) => t.record_id === w1.id && t.after.$from?.id === l2.id),
        { reclass, l2: after.l2?.data, w1: after.w1?.data, trail });
    const list = await call("sam", "records.list", { object: LOT, as: "sam", q: `L2-${tag}` });
    step("the lot's list says so", list.ok && list.rows?.find((r) => r.id === l2.id)?.control === "none", { rows: list.rows });

    // ---- 5. moved to another product ----
    const r1now = await row(LOT, l1.id);
    const moved = await call("sam", "records.update", { object: LOT, id: l1.id, rowVersion: Number(r1now.row_version), data: { product: p2.id }, key: key() });
    await call("eli", "records.update", { object: PRODUCT, id: p2.id, rowVersion: Number((await row(PRODUCT, p2.id)).row_version), data: { control: "military" }, key: key() });
    const l1now = await row(LOT, l1.id);
    step("a lot moved to another product: its own write works its control out again, and it follows that product from then on",
        moved.ok && moved.control === "none" && l1now.data.control === "military" && l1now.data.military === true, { moved, data: l1now?.data });

    // ---- 6. refused at the check ----
    const badLot = { ...lotDerived, fields: { ...lotDerived.fields, where: { label: "Where", type: "string", from: "product.site" } } };
    const loopA = `dv_loopa_t${tag}`, loopB = `dv_loopb_t${tag}`;
    const loopDefs = {
        [loopA]: object(loopA, `Loop A ${tag}`, { name: { label: "Name", type: "string" }, b: { label: "B", type: "ref", to: loopB }, x: { label: "X", type: "string", from: "b.y" } }, "name"),
        [loopB]: object(loopB, `Loop B ${tag}`, { name: { label: "Name", type: "string" }, a: { label: "A", type: "ref", to: loopA }, y: { label: "Y", type: "string", from: "a.x" } }, "name"),
    };
    const three = await change({ [LOT]: badLot, ...loopDefs }, "Wrong on purpose.");
    const words = (three.saved.problems ?? []).map((p) => p.message).join("\n");
    step("a design check refuses a path that does not go, and a loop, in words", /product\.site does not go/.test(words) && /would never settle/.test(words), three.saved.problems);
    await call("dana", "design.withdraw", { id: three.id });

    // ---- 7. the query view ----
    await call("dana", "query.schema", {});
    const view = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'q' AND table_name = $1`, [LOT]);
    step("the lot's query view has the derived columns, as any field", view.some((c) => c.column_name === "control") && view.some((c) => c.column_name === "military"), view.map((c) => c.column_name));
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
