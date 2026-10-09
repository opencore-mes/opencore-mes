// Who is at the screen (DESIGN.md §10.4, §9.2, §25.1), end to end on the seed:
//   1. A badge scanned is a sign-in id: Person is found by it (scanBy), as by a name; a sign-in id nobody has finds none.
//   2. A transaction's check reads the person's departments: a hold for one's own department runs; for another's,
//      refused in its words.
//   3. An installation from before Person scanned by sign-in id gets it once, at start, as a new version by the
//      platform; a plant that takes it away later keeps it away.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/scan-departments.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { migrate } from "../db/migrate.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const quiet = { info() {}, warn() {}, error() {} };

const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
const { url: mes } = await app.listen({ port: 0 });
const sessions = {};
for (const user of ["dana", "vera", "eli", "sam", "olga", "quinn", "ivan", "ines"]) {
    sessions[user] = `sd-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    return res.ok ? body : { error: body.error, status: res.status, fields: body.fields };
};
const approveAll = async (id) => {
    let state = null;
    for (let round = 0; round < 5 && state !== "executed"; round++) for (const u of Object.keys(sessions)) {
        const seen = await call(u, "design.change", { id, as: u });
        for (const department of seen?.can?.approveFor ?? []) state = (await call(u, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
    }
    return state;
};
const personDef = async () => (await db.query("SELECT version, body FROM mes.definitions WHERE object = 'person' AND status = 'published'"))[0];

try {
    // ---- 1. a badge ----
    const byId = await call("olga", "records.lookup", { object: "person", key: "quinn" });
    const byName = await call("olga", "records.lookup", { object: "person", key: "Quinn Park" });
    const nobody = await call("olga", "records.lookup", { object: "person", key: `nobody-${tag}` });
    step("a badge scanned is a sign-in id: Person found by it, as by a name; one nobody has finds none",
        byId?.id && byId.id === byName?.id && byId.title === "Quinn Park" && nobody === null, { byId, byName, nobody });

    // ---- 2. a check reading the person's departments ----
    const TX = `own_hold_t${tag}`;
    const tx = {
        name: TX, label: "Hold for a department", description: "",
        inputs: { lot: { label: "Lot", type: "ref", to: "lot", required: true }, dept: { label: "For", type: "enum", values: ["production", "quality"], required: true } },
        require: [{ that: { in: [{ input: "dept" }, { user: "departments" }] }, message: "Only that department's people hold for it.", field: "dept" }],
        steps: [{ on: "lot", action: "hold" }], confirm: false, callers: { users: [], groups: ["production"] }, stewards: ["production"],
        scenarios: [
            { name: "for her own", records: { wo: { object: "work_order", where: { wo_no: ["WO-1001"] } }, lot: { object: "lot", data: { lot_no: `SDS-${tag}`, item: "PA66-NAT-25", work_order: "@wo", qty: 5, uom: "kg" } } }, steps: [{ as: "olga", do: { transaction: TX, input: { lot: "@lot", dept: "production" } }, expect: { ok: true } }] },
            { name: "for another", records: { wo: { object: "work_order", where: { wo_no: ["WO-1001"] } }, lot: { object: "lot", data: { lot_no: `SDS2-${tag}`, item: "PA66-NAT-25", work_order: "@wo", qty: 5, uom: "kg" } } }, steps: [{ as: "olga", do: { transaction: TX, input: { lot: "@lot", dept: "quality" } }, expect: { ok: false } }] },
        ],
    };
    const { id } = await call("dana", "design.start", { transaction: TX, label: "Hold for a department" });
    const fresh = await call("dana", "design.change", { id, as: "dana" });
    const saved = await call("dana", "design.save", { id, seen: fresh.draft_rev, reason: "Each department holds for itself.", transactions: { [TX]: tx } });
    const submitted = await call("dana", "design.submit", { id });
    await call("vera", "design.review", { id, decision: "pass" });
    const state = await approveAll(id);
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1001'");
    const lotA = await call("olga", "records.create", { object: "lot", data: { lot_no: `SD-${tag}`, item: "PA66-NAT-25", work_order: wo.id, qty: 5, uom: "kg" } });
    const theirs = await call("olga", "transactions.run", { name: TX, input: { lot: lotA.id, dept: "quality" }, key: `sd-${tag}-1` });
    const own = await call("olga", "transactions.run", { name: TX, input: { lot: lotA.id, dept: "production" }, key: `sd-${tag}-2` });
    step("a transaction's check reads the person's departments: its scenarios pass the fitness test; another department's refused in its words, her own held",
        !saved.problems?.length && !submitted.error && state === "executed" && /Only that department's people/.test(theirs.fields?.dept ?? theirs.error ?? "") && own.ok,
        { problems: saved.problems, submitted, state, theirs, own });

    // ---- 3. an installation from before ----
    const before = await personDef();
    const { scanBy, ...without } = before.body;
    await db.query("UPDATE mes.definitions SET body = $2 WHERE object = 'person' AND version = $1", [before.version, JSON.stringify(without)]);
    await db.query("DELETE FROM mes.schema_migrations WHERE name LIKE 'built-in-grown:person:%'");
    await migrate(db, { log: quiet });
    const grown = await personDef();
    const audit = (await db.query("SELECT after FROM mes.audit_log WHERE object = 'person' AND action = 'publish:built-in' ORDER BY seq DESC LIMIT 1"))[0];
    // The plant takes it away (through its own change, here as if one did), and a later start leaves it away.
    await db.query("UPDATE mes.definitions SET body = $2 WHERE object = 'person' AND version = $1", [grown.version, JSON.stringify({ ...grown.body, scanBy: undefined })]);
    await migrate(db, { log: quiet });
    const left = await personDef();
    // As it was, for the suites after.
    await db.query("UPDATE mes.definitions SET body = $2 WHERE object = 'person' AND version = $1", [left.version, JSON.stringify({ ...left.body, scanBy: ["user"] })]);
    step("an installation from before gets Person's scan by sign-in id once, at start, as a new version by the platform; taken away later, it stays away",
        !before.body.scanBy === false && grown.version === before.version + 1 && JSON.stringify(grown.body.scanBy) === '["user"]' && JSON.stringify(audit?.after?.settings) === '["scanBy"]' && left.version === grown.version && left.body.scanBy === undefined,
        { before: before.version, grown: { version: grown.version, scanBy: grown.body.scanBy }, audit: audit?.after, left: { version: left.version, scanBy: left.body.scanBy } });
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
