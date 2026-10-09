// The Database area (DESIGN.md §38), end to end against a running server:
//   1. Ivan (IT) is made a database administrator in People & departments (a change, approved).
//   2. The platform's statements are counted as they run: a list's statement says which service sent it,
//      and no value given with a statement is kept (a word typed in a filter is in none).
//   3. Only a database administrator opens the area; a statement's plan is read without running it.
//   4. An index is built from a description, at once, in the background (CONCURRENTLY), with why, in the audit
//      trail; one the server cannot write (a field that does not exist) is refused in words.
//   5. Only an index built here is dropped here: the platform's own is refused; the one built is dropped, audited.
//   6. Without an AI set up, asking for proposals says so.
//   7. With one (a stand-in here), its proposals are descriptions the server checks and writes as statements,
//      for the statements it names that exist; one it cannot write is refused; nothing is built.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/database.mjs   (after a reset)
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
for (const user of ["dana", "vera", "eli", "sam", "olga", "quinn", "ivan", "ines"]) {
    sessions[user] = `db-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status, body });
    return body;
};
const refused = (p) => p.then(() => null, (e) => e);
// A change through its lifecycle: everyone who may sign the step in front of them signs it, until it executes.
const approveAll = async (id) => {
    let state = null;
    for (let round = 0; round < 5 && state !== "executed"; round++) for (const u of Object.keys(sessions)) {
        const seen = await call(u, "design.change", { id, as: u }).catch(() => null);
        for (const department of seen?.can?.approveFor ?? []) state = (await call(u, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
    }
    return state;
};

try {
    // ---- 1. a database administrator, made in People & departments ----
    const change = await call("dana", "design.start", { organization: true });
    const org = (await call("dana", "design.change", { id: change.id, as: "dana" })).content.organization;
    org.roles = { ...(org.roles ?? {}), database: { administrator: ["user:ivan"] } };
    await call("dana", "design.save", { id: change.id, reason: "Ivan tunes the database.", organization: org });
    await call("dana", "design.submit", { id: change.id });
    await call("vera", "design.review", { id: change.id, decision: "pass" });
    step("Ivan (IT) is made a database administrator, through a change to People & departments", (await approveAll(change.id)) === "executed");

    // ---- 2. statements counted as they run, values never kept ----
    const SECRET = `zq${tag}secret`;
    await call("olga", "records.list", { object: "lot", as: "olga", page: 1, q: SECRET });
    await call("olga", "records.list", { object: "lot", as: "olga", page: 1 });
    const o = await call("ivan", "database.overview", { hours: 1 });
    const fromList = o.statements.filter((s) => s.sources["records.list"]);
    step("the statements a list sent are counted, each said to come from records.list, with calls and time",
        fromList.length > 0 && fromList.every((s) => s.calls > 0 && s.totalMs >= 0) && o.totals.calls > 0, { n: fromList.length, sources: o.statements.slice(0, 5).map((s) => s.sources) });
    step("…and no value given with a statement is kept: the word typed in the filter is in none of them",
        !JSON.stringify(o.statements).includes(SECRET), o.statements.find((s) => JSON.stringify(s).includes(SECRET)));
    step("the tables and every index are read, each index with its size and how often it is used",
        o.tables.some((t) => t.name === "records") && o.indexes.some((i) => i.name === "records_updated" && i.table === "records" && typeof i.bytes === "number"), { tables: o.tables.length, indexes: o.indexes.length });

    // ---- 3. the area is the administrators' alone; a plan is read without running anything ----
    const notHers = await refused(call("olga", "database.overview", {}));
    step("someone not made a database administrator does not open it, and is told who does", notHers?.status === 403 && /database administrators/.test(notHers.message), notHers?.message);
    const big = [...fromList].sort((a, b) => b.totalMs - a.totalMs)[0];
    const detail = await call("ivan", "database.statement", { key: big.key });
    step("a statement opened: its text with $1… where its values go, and its plan, for any values",
        /\$1/.test(detail.sample) && typeof detail.plan.text === "string" && /Scan|Index|Limit|Sort/.test(detail.plan.text), { sample: detail.sample?.slice(0, 200), plan: detail.plan });

    // ---- 4. an index built from a description, with why, in the background ----
    const bad = await refused(call("ivan", "database.createIndex", { spec: { table: "records", object: "lot", keys: [{ field: "no_such_field" }] }, why: "x" }));
    step("an index the server cannot write is refused in words", bad?.status === 400 && /is not a field of Lot/.test(bad.message), bad?.message);
    const noWhy = await refused(call("ivan", "database.createIndex", { spec: { table: "records", object: "lot", keys: [{ field: "lot_no" }] } }));
    step("…and one without a why is asked for it", /Say why/.test(noWhy?.message ?? ""), noWhy?.message);
    const built = await call("ivan", "database.createIndex", { spec: { table: "records", object: "lot", keys: [{ field: "lot_no" }], inUse: true }, why: `Lots are found by number (${tag}).`, statements: [big.key] });
    let state = built.state;
    for (let i = 0; i < 50 && state === "building"; i++) { await new Promise((r) => setTimeout(r, 200)); state = (await db.query("SELECT state FROM mes.db_indexes WHERE name = $1", [built.name]))[0]?.state; }
    const [inDb] = await db.query("SELECT indexdef FROM pg_indexes WHERE schemaname = 'mes' AND indexname = $1", [built.name]);
    const [audited] = await db.query("SELECT actor, after FROM mes.audit_log WHERE object = '$database' AND action = 'index:build' ORDER BY seq DESC LIMIT 1");
    step("built at once from its description, concurrently, on the lots' partition, for those in use, and in the audit trail with who and why",
        state === "ready" && /CREATE INDEX mesx_lot_\w+ ON mes\.records_lot [\s\S]*data ->> 'lot_no'[\s\S]*WHERE \(archived_at IS NULL\)/.test(inDb?.indexdef ?? "") && audited?.actor === "ivan" && audited.after.why.includes(tag),
        { state, inDb, audited });
    const listed = (await call("ivan", "database.overview", { hours: 1 })).indexes.find((i) => i.name === built.name);
    step("…and listed among the indexes as built here: by Ivan, why, ready", listed?.built?.state === "ready" && listed.built.by === "ivan" && listed.built.why.includes(tag), listed);

    // ---- 5. only an index built here is dropped here ----
    const platform = await refused(call("ivan", "database.dropIndex", { name: "records_updated", why: "x" }));
    step("the platform's own index is never dropped here (its migrations keep it)", platform?.status === 403 && /Only an index built in this area/.test(platform.message), platform?.message);
    await call("ivan", "database.dropIndex", { name: built.name, why: "Not needed after all." });
    const [gone] = await db.query("SELECT 1 FROM pg_indexes WHERE schemaname = 'mes' AND indexname = $1", [built.name]);
    const [dropAudit] = await db.query("SELECT actor FROM mes.audit_log WHERE object = '$database' AND action = 'index:drop' ORDER BY seq DESC LIMIT 1");
    step("the one built here is dropped, concurrently, and that is in the audit trail too", !gone && dropAudit?.actor === "ivan", { gone, dropAudit });

    // ---- 6. no AI set up: said so ----
    const noAi = await refused(call("ivan", "database.propose", {}));
    step("without an AI set up, asking for proposals says so (the rest of the area needs none)", noAi?.status === 409 && /No AI is set up/.test(noAi.message), noAi?.message);

    // ---- 7. the AI proposes (a stand-in here): the server checks each and writes its statement ----
    let asked = "";
    const stand = { complete: async ({ messages }) => { asked = messages[0].content[0].text; return { content: [{ type: "tool_use", id: "t1", name: "propose_indexes", input: {
        summary: "Lots are read by number.",
        proposals: [
            { table: "records", object: "lot", keys: [{ field: "lot_no" }], inUse: true, why: "The lot list filters by number.", statements: [big.key, "not-a-key"] },
            { table: "records", object: "lot", keys: [{ field: "lot_no); DROP TABLE mes.records; --" }], why: "x" },
        ] } }] }; } };
    const withAi = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, ai: stand });
    const { url: aiUrl } = await withAi.listen({ port: 0 });
    try {
        const res = await fetch(`${aiUrl}/api/database.propose`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions.ivan}` }, body: JSON.stringify([{ hours: 1 }]) });
        const p = await res.json();
        const [ok, no] = p.proposals ?? [];
        step("the AI is given the statements, their plans, the tables, the indexes and the objects, never a value",
            /STATEMENTS/.test(asked) && /PLANS:/.test(asked) && /INDEXES:/.test(asked) && /OBJECTS/.test(asked) && !asked.includes(SECRET), asked.slice(0, 300));
        step("…its proposal is written as a statement by the server, for the statements it names that exist; one it cannot write is refused, never run",
            /^CREATE INDEX CONCURRENTLY IF NOT EXISTS mesx_lot_\w+ ON mes\."records_lot"/.test(ok?.sql ?? "") && ok.statements.join() === big.key && ok.estimate?.available === false
            && /is not a field of Lot/.test(no?.refused ?? "") && !no.sql && (await db.query("SELECT count(*)::int AS n FROM mes.db_indexes WHERE state <> 'dropped'"))[0].n === 0, p);
    } finally {
        await withAi.close();
    }

    // Put back: Ivan no longer a database administrator.
    const back = await call("dana", "design.start", { organization: true });
    const org2 = (await call("dana", "design.change", { id: back.id, as: "dana" })).content.organization;
    delete org2.roles.database;
    await call("dana", "design.save", { id: back.id, reason: "Back as it was.", organization: org2 });
    await call("dana", "design.submit", { id: back.id });
    await call("vera", "design.review", { id: back.id, decision: "pass" });
    step("put back: Ivan is no longer a database administrator", (await approveAll(back.id)) === "executed");
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
