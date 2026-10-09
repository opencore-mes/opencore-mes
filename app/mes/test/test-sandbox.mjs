// The test sandbox (§5.13), end to end against a running server:
//   1. Two changes by different people, each in design: an object (Dana's) and a screen that shows
//      it (Eli's). Alone, the screen is invalid: its object is not live.
//   2. Each is put under test by its author; someone else may not. They are applied in order: the
//      screen first cannot be applied (its object is not there yet); the order set right (the
//      execution flow), both are applied, and the screen shows the object: the changes see each other.
//   3. People enter as themselves, with the same roles; the test sandbox says what it is on every
//      page; a record made there is in the test database, not the live one, and is kept when the test
//      sandbox is built again.
//   4. Each change says what it was tested with; nothing is live: both still wait for approval.
//   5. A change taken out is gone from the test sandbox at its next build.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/test-sandbox.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
let app = null;

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of ["dana", "iris", "sam", "olga", "eli"]) {
        sessions[user] = `ts-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const callAt = (base) => async (user, name, args) => {
        const res = await fetch(`${base}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args ?? {}]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const call = callAt(mes);
    const key = () => `ts-${randomBytes(8).toString("hex")}`;
    await db.query("UPDATE mes.change_requests SET test = NULL WHERE test IS NOT NULL");

    // ---- 1. two changes, by two people ----
    const OBJ = `gauge_t${tag}`;
    const SCREEN = `gauges_t${tag}`;
    const a = await call("dana", "design.start", { object: OBJ, label: "Gauge" });
    const def = (await call("dana", "design.change", { id: a.id, as: "dana" })).content.definitions[OBJ];
    const gauge = { ...def, titleField: "name", fields: { name: { label: "Name", type: "string", required: true } }, roles: ["keeper"], policies: [{ id: "all", roles: ["keeper"], record: { read: true, create: true }, fields: { "*": "write" } }], stewards: { object: ["production"] } };
    await call("dana", "design.save", { id: a.id, reason: "Gauges, kept by Production.", definitions: { [OBJ]: gauge } });
    const org = await call("dana", "design.start", { organization: true });
    const orgBody = (await call("dana", "design.change", { id: org.id, as: "dana" })).content.organization;
    const b = await call("iris", "design.start", { screen: SCREEN, label: "Gauges" });
    const screenDraft = (await call("iris", "design.change", { id: b.id, as: "iris" })).content.screens[SCREEN];
    const screen = { ...screenDraft, blocks: [{ block: "table", title: "Gauges", object: OBJ, columns: ["name"], create: true, width: 12 }], callers: { users: ["sam", "olga"], groups: [] }, stewards: ["production"] };
    const alone = await call("iris", "design.save", { id: b.id, reason: "A board of the gauges.", screens: { [SCREEN]: screen } });
    step("two changes in design, by two people: Dana's object, and Iris's screen showing it; alone, the screen is not valid (its object is not live)",
        a.id && b.id && alone.problems?.some((p) => new RegExp(`"${OBJ}" is not an object`).test(p.message)), { a, b, alone: alone.problems ?? alone });
    // The role on the new object, for the people who will try it: Dana's second change (people & departments).
    const withRole = { ...orgBody, roles: { ...orgBody.roles, [OBJ]: { keeper: ["user:sam"] } } };
    const orgSaved = await call("dana", "design.save", { id: org.id, reason: "Sam keeps gauges.", organization: withRole });

    // ---- 2. under test, in order ----
    const notMine = await call("iris", "test.add", { id: a.id });
    const addB = await call("iris", "test.add", { id: b.id });
    const addA = await call("dana", "test.add", { id: a.id });
    const addOrg = await call("dana", "test.add", { id: org.id });
    const first = await call("dana", "test.build");
    const of = (state, id) => state.changes?.find((c) => c.id === id);
    step("each is put under test by its own author (not by someone else), in the order they were added; built so, the screen cannot be applied: its object comes after it",
        notMine.status === 409 && addB.changes?.length === 1 && addA.changes?.map((c) => c.id).join() === [b.id, a.id].join() && first.changes?.length === 3 && of(first, b.id)?.applied?.ok === false && of(first, a.id)?.applied?.ok === true,
        { notMine, order: addOrg.changes?.map((c) => c.title), first: first.changes?.map((c) => [c.title, c.applied]) ?? first, orgSaved: orgSaved.problems ?? orgSaved });
    const reordered = await call("dana", "test.order", { ids: [a.id, org.id, b.id] });
    const notDesigner = await call("olga", "test.order", { ids: [b.id, a.id, org.id] });
    const second = await call("dana", "test.build");
    step("the order set right (the execution flow: the object, its roles, then the screen), all three are applied; someone who does not design sets no order",
        reordered.changes?.map((c) => c.id).join() === [a.id, org.id, b.id].join() && notDesigner.status >= 400 && second.changes?.every((c) => c.applied?.ok === true) && second.stale === false,
        { reordered: reordered.changes?.map((c) => c.title) ?? reordered, notDesigner: notDesigner.status, second: second.changes?.map((c) => [c.title, c.applied]) ?? second });

    // ---- 3. people enter, as themselves ----
    const entered = await call("sam", "test.enter");
    const testUrl = entered.url ?? `http://127.0.0.1:${entered.port}`;
    const inTest = callAt(testUrl);
    const page = await fetch(`${testUrl}/s/${SCREEN}`, { headers: { cookie: `mes_session=${sessions.sam}` } });
    const html = await page.text();
    const board = await inTest("sam", "screens.data", { name: SCREEN, arg: null, as: "sam" });
    const livePage = await call("sam", "screens.data", { name: SCREEN, arg: null, as: "sam" });
    step("Sam enters the test sandbox as himself, with the same session: the screen of one change shows the object of the other, the page says it is the test sandbox; in the live system neither is there",
        entered.port > 0 && page.status === 200 && /TEST SANDBOX/.test(html) && board?.blocks?.[0]?.object === OBJ && Array.isArray(board.blocks[0].rows) && board.blocks[0].canCreate === true && !livePage?.blocks,
        { entered, page: page.status, banner: /TEST SANDBOX/.test(html), board: board?.blocks?.[0] ?? board, live: livePage });
    const made = await inTest("sam", "records.create", { object: OBJ, data: { name: `G-${tag}` }, key: key() });
    const olgaIn = await call("olga", "test.enter");
    const olgas = await inTest("olga", "records.create", { object: OBJ, data: { name: "Not hers" }, key: key() });
    const [{ n: liveRows }] = await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = $1", [OBJ]).catch(() => [{ n: 0 }]);
    const [liveDef] = await db.query("SELECT 1 FROM mes.definitions WHERE object = $1", [OBJ]);
    step("the same roles apply there: Sam, given the role in a change under test, makes a gauge; Olga, who has no role on it, may not; the record is in the test database only, and the object is still not live",
        made.id && made.name === `G-${tag}` && olgaIn.port === entered.port && olgas.status === 403 && liveRows === 0 && !liveDef, { made: made.error ?? made.id, olgas: olgas.status, liveRows, liveDef });
    // A change saved again: the test sandbox is stale, and built again when next entered; its records kept.
    await call("iris", "design.save", { id: b.id, reason: "A board of the gauges.", screens: { [SCREEN]: { ...screen, description: "Every gauge." } } });
    const stale = await call("dana", "test.state");
    const again = await call("sam", "test.enter");
    const kept = await callAt(again.url ?? `http://127.0.0.1:${again.port}`)("sam", "records.list", { object: OBJ, as: "sam" });
    const after = await call("dana", "test.state");
    step("a change saved again makes the test sandbox stale; entered again it is built again from the changes as they are now, and the records made there are kept",
        stale.stale === true && of(stale, b.id)?.applied === null && after.stale === false && kept.rows?.some((r) => r.name === `G-${tag}`), { stale: stale.stale, after: after.stale, kept: kept.rows?.map((r) => r.name) ?? kept });

    // ---- 4. what each was tested with; nothing is live ----
    const seenA = await call("dana", "design.change", { id: a.id, as: "dana" });
    const seenB = await call("iris", "design.change", { id: b.id, as: "iris" });
    const lastA = seenA.tested?.at(-1);
    const lastB = seenB.tested?.at(-1);
    const trail = await db.query("SELECT action FROM mes.audit_log WHERE object = '$change' AND record_id = $1 ORDER BY seq", [a.id]);
    step("each change says what it was tested with, each time: the first build, where the screen could not be applied, and the last, with the other two; both are still in design, waiting for approval; putting one under test is in the audit trail",
        seenB.tested?.[0]?.ok === false && /not an object|could not|is not/.test(seenB.tested[0].error ?? "") && lastB?.ok === true && lastB.with.map((w) => w.id).sort().join() === [a.id, org.id].sort().join() && lastA?.ok === true && lastA.with.some((w) => w.id === b.id && w.title === seenB.title)
        && seenA.state === "design" && seenB.state === "design" && seenA.test?.order === 1 && trail.some((t) => t.action === "change:test-add"),
        { firstB: seenB.tested?.[0], lastB, lastA, states: [seenA.state, seenB.state], trail: trail.map((t) => t.action) });

    // ---- 5. taken out ----
    const out = await call("iris", "test.remove", { id: b.id });
    const rebuilt = await call("dana", "test.build");
    const gone = await callAt(`http://127.0.0.1:${(await call("sam", "test.enter")).port}`)("sam", "screens.data", { name: SCREEN, arg: null, as: "sam" });
    const trailB = await db.query("SELECT action FROM mes.audit_log WHERE object = '$change' AND record_id = $1 ORDER BY seq", [b.id]);
    step("a change taken out is gone from the test sandbox at its next build, the others stay; taking it out is in the audit trail",
        out.changes?.length === 2 && rebuilt.changes?.length === 2 && rebuilt.changes.every((c) => c.applied?.ok) && !gone?.blocks && trailB.some((t) => t.action === "change:test-remove"), { out: out.changes?.length, rebuilt: rebuilt.changes?.map((c) => [c.title, c.applied]), gone });
    for (const id of [a.id, org.id, b.id]) await call(id === b.id ? "iris" : "dana", "design.withdraw", { id });
    const empty = await call("dana", "test.state");
    const noEntry = await call("sam", "test.enter");
    step("withdrawn changes are no longer under test; with nothing under test there is nothing to enter", empty.changes?.length === 0 && noEntry.status === 409 && noEntry.code === "test.empty", { empty, noEntry });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close?.();
    await pool.end();
}

for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok || s.detail === undefined ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
const failed = steps.filter((s) => !s.ok);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
