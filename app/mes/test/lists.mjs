// Lists and tables page by page, sorted as designed (§10.1, §26), end to end:
//   1. An object whose list is sorted by a code held as text: 60 records, codes 1 to 60. The list
//      comes 50 a page (drawn as it is scrolled), in number order (9 before 10), saying whether
//      there are more; an unsorted list reads only as far as its page needs.
//   2. The filter searches every record, on the server, not only the page shown. A column the person sorts
//      by (its head clicked) orders every record too, in the database, in place of the design's order.
//   3. Without a page, records.list still answers what pick-lists need (the 200 changed last); a reference
//      picked by typing (records.pick) searches every record by its title, 20 at most, as each may see.
//   4. A screen's table sorts the same way and holds up to its limit (1000); the page pages it.
//   5. Its New and Remove buttons: offered only to whoever may create or archive; Remove archives.
//   6. At scale: 6 000 records, read with each person's rights in the database (record-sql.js). A
//      screen's numbers, breakdowns and sorted table, a sorted list's pages and its filter, and the
//      navigator are exact over all of them (not the 5 000 changed last), and agree with policy.js
//      decide record by record: a conditional read, a hidden field, fields read only in some rows.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/lists.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { mask } from "../server/policy.js";
import { rightsSql } from "../server/record-sql.js";
import { sortRows } from "../client/sort.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const OBJ = `op_t${tag}`;

const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
const { url: mes } = await app.listen({ port: 0 });
const sessions = {};
for (const user of ["dana", "eli", "sam", "olga", "quinn"]) {
    sessions[user] = `ls-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status, body });
    return body;
};

try {
    // An object designed and approved: a list sorted by its code, which is text.
    const { id } = await call("dana", "design.start", { object: OBJ, label: "Test operations" });
    const def = { ...(await call("dana", "design.change", { id, as: "dana" })).content.definitions[OBJ] };
    def.titleField = "code";
    def.fields = { code: { label: "Code", type: "string", required: true }, note: { label: "Note", type: "string" } };
    def.list = { columns: ["code", "note"], sort: { field: "code", dir: "asc" } };
    def.form = { sections: [{ label: "Details", fields: ["code", "note"] }] };
    def.stewards = { object: ["production"] };
    def.policies = [{ ...def.policies[0], record: { read: true, create: true, archive: true } }];
    const scr = `oplist_t${tag}`;
    const screen = { name: scr, label: "Test operations", params: {}, blocks: [{ block: "table", object: OBJ, columns: ["code"], sort: { field: "code", dir: "asc" }, limit: 1000, pageSize: 25, create: true, archive: true, width: 12 }], callers: { groups: ["production", "quality"] }, stewards: ["production"] };
    const saved = await call("dana", "design.save", { id, reason: "A list to page through.", definitions: { [OBJ]: def }, screens: { [scr]: screen } });
    if (saved.problems.length) throw new Error(JSON.stringify(saved.problems));
    await call("dana", "design.submit", { id });
    await call("eli", "design.review", { id, decision: "pass" });
    const done = await call("sam", "design.approve", { id, department: "production", decision: "approve", meaning: "Approved" });
    if (done.state !== "executed") throw new Error(JSON.stringify(done));
    await db.query("INSERT INTO mes.assignments (subject_kind, subject_id, object, role) VALUES ('group', 'production', $1, 'user')", [OBJ]);
    // 60 records, made in shuffled order.
    const codes = Array.from({ length: 60 }, (_, k) => String(k + 1)).sort(() => Math.random() - 0.5);
    for (const code of codes) await db.query("INSERT INTO mes.records (object, def_version, state, data, created_by, updated_by) VALUES ($1, 1, 'active', $2, 'sam', 'sam')", [OBJ, JSON.stringify({ code, note: code.endsWith("7") ? "seven" : "" })]);

    // ---- 1. pages, in number order ----
    const p1 = await call("olga", "records.list", { object: OBJ, as: "olga", page: 1 });
    step("page 1: 50 records, codes 1 to 50 in number order (9 before 10)", p1.rows.length === 50 && p1.rows.map((r) => r.code).join() === Array.from({ length: 50 }, (_, k) => k + 1).join(), p1.rows.map((r) => r.code));
    step("…more to come, 60 in all (a sorted list counts them)", p1.page === 1 && p1.more === true && p1.total === 60 && !p1.capped, { page: p1.page, more: p1.more, total: p1.total });
    const p2 = await call("olga", "records.list", { object: OBJ, as: "olga", page: 2 });
    step("page 2: the other 10, 51 to 60", p2.rows.map((r) => r.code).join() === "51,52,53,54,55,56,57,58,59,60", p2.rows.map((r) => r.code));
    step("…and no more after it", p2.more === false);
    // The person's own order (a column's head clicked), in place of the design's, sorted by the database.
    const down = await call("olga", "records.list", { object: OBJ, as: "olga", page: 1, sort: { field: "code", dir: "desc" } });
    step("a column sorted by the person, Z to A: 60 down to 11, still in number order, the total counted", down.rows.map((r) => r.code).join() === Array.from({ length: 50 }, (_, k) => 60 - k).join() && down.total === 60, down.rows.slice(0, 5).map((r) => r.code));
    const odd = await call("olga", "records.list", { object: OBJ, as: "olga", page: 1, sort: { field: "nope", dir: "sideways" } });
    step("a sort that names no field, or no direction, is the design's order", odd.rows.map((r) => r.code).join() === p1.rows.map((r) => r.code).join(), odd.rows.slice(0, 5).map((r) => r.code));
    // Listed as changed last (no sort, no filter), a page reads only as far as it needs.
    const lots = await call("olga", "records.list", { object: "lot", as: "olga", page: 1 });
    step("an unsorted list's first page: the rows, whether there are more, and the total when it read to the end", Array.isArray(lots.rows) && lots.more === false && lots.total === lots.rows.length, { more: lots.more, total: lots.total, rows: lots.rows.length });

    // ---- 2. the filter searches every record ----
    const f = await call("olga", "records.list", { object: OBJ, as: "olga", page: 1, q: "seven" });
    step("the filter searches all 60 (6 notes say seven), on the server", f.total === 6 && f.rows.map((r) => r.code).join() === "7,17,27,37,47,57", f.rows.map((r) => r.code));

    // ---- 3. without a page ----
    const legacy = await call("olga", "records.list", { object: OBJ, as: "olga" });
    step("without a page: every record for a pick-list, no paging fields", legacy.rows.length === 60 && legacy.page === undefined);

    // ---- 4. a screen's table ----
    const s = await call("olga", "screens.data", { name: scr, arg: null, as: "olga" });
    step("the screen's table: all 60, in number order", s.blocks[0].rows.length === 60 && s.blocks[0].rows.slice(0, 12).map((r) => r.code).join() === "1,2,3,4,5,6,7,8,9,10,11,12", s.blocks[0].rows.slice(0, 12).map((r) => r.code));

    // ---- 5. a screen's own record buttons, as the viewer ----
    const t = s.blocks[0];
    step("the table offers New and, on each row, Remove, to someone who may do both", t.canCreate === true && t.rows.every((r) => r.$archive === true && Number.isInteger(r.row_version)), { canCreate: t.canCreate, row: t.rows[0] });
    const q = await call("quinn", "screens.data", { name: scr, arg: null, as: "quinn" });
    step("to someone with no role on it: no New, no Remove (and no rows)", q.blocks[0].canCreate === false && q.blocks[0].rows.length === 0, q.blocks[0]);
    const first = t.rows[0];
    await call("olga", "records.archive", { object: OBJ, id: first.id, rowVersion: first.row_version, key: `rm-${first.id}` });
    const after = await call("olga", "screens.data", { name: scr, arg: null, as: "olga" });
    step("Remove archives through the record service: the row leaves the table", after.blocks[0].rows.length === 59 && !after.blocks[0].rows.some((r) => r.id === first.id));

    // ---- 6. at scale, with each person's rights ----
    const BIG = `opx_t${tag}`;
    const { id: id2 } = await call("dana", "design.start", { object: BIG, label: "Test operations at scale" });
    const big = { ...(await call("dana", "design.change", { id: id2, as: "dana" })).content.definitions[BIG] };
    big.titleField = "code";
    big.fields = {
        code: { label: "Code", type: "string", required: true }, qty: { label: "Quantity", type: "integer" },
        owner: { label: "Owner", type: "string" }, secret: { label: "Secret", type: "string" }, op: { label: "Operation", type: "ref", to: OBJ },
    };
    big.states = { initial: "active", list: ["active", "held", "done"], transitions: [{ action: "hold", from: ["active"], to: "held" }, { action: "release", from: ["held"], to: "active" }, { action: "finish", from: ["active"], to: "done" }] };
    big.roles = ["user", "lead"];
    // Production reads everything but the secret; a lead reads the rows they own (all of them), and
    // the code and quantity of big held ones.
    big.policies = [
        { id: "all", roles: ["user"], record: { read: true, create: true }, fields: { "*": "write" }, deny: { read: ["secret"] } },
        { id: "own", roles: ["lead"], when: { eq: [{ record: "owner" }, { user: "id" }] }, record: { read: true }, fields: { "*": "read" } },
        { id: "big-held", roles: ["lead"], when: { all: [{ in: [{ record: "state" }, ["held"]] }, { gt: [{ record: "qty" }, 900] }] }, record: { read: true }, fields: { code: "read", qty: "read" } },
    ];
    big.list = { columns: ["code", "qty"], sort: { field: "qty", dir: "desc" } };
    big.form = { sections: [{ label: "Details", fields: ["code", "qty", "owner", "secret", "op"] }] };
    big.stewards = { object: ["production"] };
    const scr2 = `opxboard_t${tag}`;
    const board = {
        name: scr2, label: "Operations at scale", params: {}, callers: { groups: ["production", "quality"] }, stewards: ["production"],
        blocks: [
            { block: "kpi", title: "All", object: BIG, width: 3 },
            { block: "kpi", title: "Quantity", object: BIG, measure: { sum: "qty" }, width: 3 },
            { block: "kpi", title: "Held, average", object: BIG, where: { state: ["held"] }, measure: { avg: "qty" }, width: 3 },
            { block: "breakdown", title: "By state", object: BIG, by: "state", width: 6 },
            { block: "breakdown", title: "By secret", object: BIG, by: "secret", width: 6 },
            { block: "table", title: "Largest", object: BIG, columns: ["code", "qty"], sort: { field: "qty", dir: "desc" }, limit: 5, width: 12 },
        ],
    };
    const saved2 = await call("dana", "design.save", { id: id2, reason: "Many records, several rights.", definitions: { [BIG]: big }, screens: { [scr2]: board } });
    if (saved2.problems.length) throw new Error(JSON.stringify(saved2.problems));
    await call("dana", "design.submit", { id: id2 });
    await call("eli", "design.review", { id: id2, decision: "pass" });
    const done2 = await call("sam", "design.approve", { id: id2, department: "production", decision: "approve", meaning: "Approved" });
    if (done2.state !== "executed") throw new Error(JSON.stringify(done2));
    await db.query("INSERT INTO mes.assignments (subject_kind, subject_id, object, role) VALUES ('group', 'production', $1, 'user'), ('user', 'quinn', $1, 'lead')", [BIG]);
    // 6 000 records, one a minute back from now: X-6000 is the oldest. It names an operation whose
    // code is found nowhere else.
    await db.query(
        `INSERT INTO mes.records (object, def_version, state, data, created_by, updated_by, created_at, updated_at)
         SELECT $1, 1, CASE WHEN i % 10 = 0 THEN 'held' WHEN i % 10 = 1 THEN 'done' ELSE 'active' END,
                jsonb_build_object('code', 'X-' || i, 'qty', (i * 37) % 1000, 'owner', CASE WHEN i % 3 = 0 THEN 'quinn' ELSE 'sam' END, 'secret', CASE WHEN i % 100 = 0 THEN 'zebra' ELSE 'plain' END),
                'sam', 'sam', now() - i * interval '1 minute', now() - i * interval '1 minute'
         FROM generate_series(1, 6000) i`,
        [BIG],
    );
    const [kestrel] = await db.query("INSERT INTO mes.records (object, def_version, state, data, created_by, updated_by) VALUES ($1, 1, 'active', $2, 'sam', 'sam') RETURNING id", [OBJ, JSON.stringify({ code: "kestrel", note: "" })]);
    await db.query("UPDATE mes.records SET data = data || jsonb_build_object('op', $2::text) WHERE object = $1 AND data->>'code' = 'X-6000'", [BIG, kestrel.id]);
    const [oldest] = await db.query("SELECT id FROM mes.records WHERE object = $1 AND data->>'code' = 'X-6000'", [BIG]);

    // What each person may see, decided by policy.js row by row: the truth the database must match.
    const [bigDef] = await db.query("SELECT body FROM mes.definitions WHERE object = $1 AND status = 'published'", [BIG]);
    const all = await db.query("SELECT * FROM mes.records WHERE object = $1 AND archived_at IS NULL ORDER BY updated_at DESC, id", [BIG]);
    const actorOf = async (user) => ({ id: user, roles: (await db.query(
        `SELECT DISTINCT a.role FROM mes.assignments a LEFT JOIN mes.group_members m ON a.subject_kind = 'group' AND m.group_id = a.subject_id
         WHERE a.object = $1 AND ((a.subject_kind = 'user' AND a.subject_id = $2) OR m.user_id = $2)`, [BIG, user])).map((r) => r.role) });
    const truth = {};
    for (const user of ["olga", "quinn"]) {
        const actor = { ...(await actorOf(user)), departments: [] };
        truth[user] = all.map((row) => mask(bigDef.body, actor, row)).filter(Boolean);
    }
    const sumOf = (rows) => rows.reduce((a, r) => a + (typeof r.qty === "number" ? r.qty : 0), 0);
    const countBy = (rows, get) => { const m = {}; for (const r of rows) { const k = get(r); if (k !== undefined) m[k] = (m[k] ?? 0) + 1; } return m; };
    const groupsOf = (b) => Object.fromEntries(b.groups.map((g) => [g.key, g.value]));
    const ids = (rows) => rows.map((r) => r.id).join();

    const so = (await call("olga", "screens.data", { name: scr2, arg: null, as: "olga" })).blocks;
    step("a number counts all 6 000, not the 5 000 changed last", so[0].value === 6000 && truth.olga.length === 6000, so[0]);
    step("a sum adds every record's quantity", so[1].value === sumOf(truth.olga), { got: so[1].value, want: sumOf(truth.olga) });
    const held = truth.olga.filter((r) => r.state === "held");
    step("an average over the held ones, all of them", so[2].value === Math.round((sumOf(held) / held.length) * 1000) / 1000 && so[2].of === held.length, { got: so[2], want: sumOf(held) / held.length });
    step("a breakdown by state, exact", JSON.stringify(groupsOf(so[3])) === JSON.stringify({ active: 4800, done: 600, held: 600 }), so[3].groups); // a tie: the one changed last first
    step("a breakdown by a field the viewer may not read: no groups", so[4].groups.length === 0, so[4].groups);
    const top = sortRows(truth.olga, (r) => r.qty, "desc").slice(0, 5);
    step("a sorted table keeps the first 5 of all 6 000", ids(so[5].rows) === ids(top) && so[5].rows.every((r) => r.qty === 999), so[5].rows.map((r) => [r.code, r.qty]));

    const sq = (await call("quinn", "screens.data", { name: scr2, arg: null, as: "quinn" })).blocks;
    step("with conditional rights, a number counts what this person may read (their own, and big held ones)", sq[0].value === truth.quinn.length && truth.quinn.length > 2000 && truth.quinn.length < 6000, { got: sq[0].value, want: truth.quinn.length });
    step("…and a sum only the quantities they may read", sq[1].value === sumOf(truth.quinn), { got: sq[1].value, want: sumOf(truth.quinn) });
    step("…a breakdown by state of those", Object.keys(groupsOf(sq[3])).length === Object.keys(countBy(truth.quinn, (r) => r.state)).length && Object.entries(countBy(truth.quinn, (r) => r.state)).every(([k, n]) => groupsOf(sq[3])[k] === n), { got: sq[3].groups, want: countBy(truth.quinn, (r) => r.state) });
    step("…by the secret, only in the rows where they may read it", Object.entries(countBy(truth.quinn, (r) => r.secret)).every(([k, n]) => groupsOf(sq[4])[k] === n) && sq[4].groups.length === Object.keys(countBy(truth.quinn, (r) => r.secret)).length, { got: sq[4].groups, want: countBy(truth.quinn, (r) => r.secret) });

    const sorted = sortRows(truth.olga, (r) => r.qty, "desc");
    const l1 = await call("olga", "records.list", { object: BIG, as: "olga", page: 1 });
    step("a sorted list's page 1: the largest 50 of all, and the total", ids(l1.rows) === ids(sorted.slice(0, 50)) && l1.total === 6000 && l1.more === true && !l1.capped, { total: l1.total, more: l1.more });
    const l120 = await call("olga", "records.list", { object: BIG, as: "olga", page: 120 });
    step("…its last page, 120: the smallest, and no more", ids(l120.rows) === ids(sorted.slice(5950)) && l120.more === false, { rows: l120.rows.length, more: l120.more });
    const up = await call("olga", "records.list", { object: BIG, as: "olga", page: 1, sort: { field: "qty", dir: "asc" } });
    step("the person's order over all 6 000: the smallest first, as each may read them", up.total === 6000 && up.rows.every((r, k) => k === 0 || up.rows[k - 1].qty <= r.qty) && up.rows[0].qty === Math.min(...truth.olga.map((r) => r.qty)), up.rows.slice(0, 5).map((r) => r.qty));
    const old = await call("olga", "records.list", { object: BIG, as: "olga", page: 1, q: "x-6000" });
    step("the filter finds the oldest record, by its code", old.total === 1 && old.rows[0]?.id === oldest.id, old.rows.map((r) => r.code));
    const viaRef = await call("olga", "records.list", { object: BIG, as: "olga", page: 1, q: "kestrel" });
    step("…and by the title of the record it names", viaRef.total === 1 && viaRef.rows[0]?.id === oldest.id, viaRef.rows.map((r) => r.code));
    const hidden = await call("olga", "records.list", { object: BIG, as: "olga", page: 1, q: "zebra" });
    const quinnZebra = await call("quinn", "records.list", { object: BIG, as: "quinn", page: 1, q: "zebra" });
    step("a field the viewer may not read matches nothing; one who may read it finds it", hidden.rows.length === 0 && hidden.total === 0 && quinnZebra.total === truth.quinn.filter((r) => r.secret === "zebra").length && quinnZebra.total > 0, { olga: hidden.total, quinn: quinnZebra.total });
    // A filter by fields (what a service's ctx.records.list asks): among every record, never on a hidden field.
    const byCode = await call("olga", "records.list", { object: BIG, as: "olga", where: { code: "X-6000" } });
    const bySecret = await call("olga", "records.list", { object: BIG, as: "olga", where: { secret: "zebra" } });
    const quinnSecret = await call("quinn", "records.list", { object: BIG, as: "quinn", where: { secret: "zebra" } });
    step("records.list by fields finds the oldest of 6 000 (not only the 200 changed last), and never filters on a field the person may not read",
        byCode.rows.length === 1 && byCode.rows[0].id === oldest.id && bySecret.rows.length === 0 && quinnSecret.rows.length === truth.quinn.filter((r) => r.secret === "zebra").length && quinnSecret.rows.length > 0,
        { byCode: byCode.rows.length, bySecret: bySecret.rows.length, quinn: quinnSecret.rows.length });
    const nav = await call("olga", "records.search", { q: "X-6000" });
    step("the navigator finds the oldest record too", nav.some((h) => h.id === oldest.id), nav.map((h) => h.title));
    // A reference picked by typing (records.pick): nothing for nothing typed; then at most 20 matches by the
    // title, those it begins first and the shortest first; the oldest of 6 000 found by its code; and only
    // what the person may see.
    const none = await call("olga", "records.pick", { object: BIG, q: "  ", as: "olga" });
    const x1 = await call("olga", "records.pick", { object: BIG, q: "x-1", as: "olga" });
    const x6000 = await call("olga", "records.pick", { object: BIG, q: "X-6000", as: "olga" });
    step("a reference picked by typing: nothing until something is typed; at most 20 matches, those it begins and the shortest first (X-1 before X-10), saying there are more",
        none.rows.length === 0 && x1.rows.length === 20 && x1.more === true && x1.rows[0].title === "X-1" && x1.rows.slice(1, 11).every((r) => r.title.length === 4) && x1.rows.every((r) => r.title.toLowerCase().includes("x-1")),
        { none: none.rows.length, x1: x1.rows.map((r) => r.title), more: x1.more });
    const quinnPick = await call("quinn", "records.pick", { object: BIG, q: "X-", as: "quinn" });
    const seenByQuinn = new Set(truth.quinn.map((r) => r.id));
    step("…the oldest of 6 000 found by its code (not only the 200 changed last), and only records the person may see",
        x6000.rows.length === 1 && x6000.rows[0].id === oldest.id && x6000.more === false && quinnPick.rows.length === 20 && quinnPick.rows.every((r) => seenByQuinn.has(r.id)),
        { x6000: x6000.rows, quinn: quinnPick.rows.filter((r) => !seenByQuinn.has(r.id)).length });

    // The rights as SQL, against policy.js on every record and every field.
    let mismatches = 0;
    for (const user of ["olga", "quinn"]) {
        const actor = { ...(await actorOf(user)), departments: [] };
        const rights = rightsSql(bigDef.body, actor);
        const names = Object.keys(bigDef.body.fields);
        const got = await db.query(`SELECT r.id, ${rights.read} AS read, ${names.map((n) => `(${rights.read} AND ${rights.field(n)}) AS "${n}"`).join(", ")} FROM mes.records r WHERE r.object = $1`, [BIG]);
        const want = new Map(truth[user].map((r) => [r.id, r]));
        for (const g of got) {
            const w = want.get(g.id);
            if (Boolean(g.read) !== Boolean(w)) mismatches++;
            else if (w) for (const n of names) if (Boolean(g[n]) !== Boolean(w.$perm.fields[n])) mismatches++;
        }
    }
    step("the rights compiled to SQL agree with policy.js on every record and field, for both", mismatches === 0, { mismatches });
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
