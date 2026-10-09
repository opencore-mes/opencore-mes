// Suites removed and installed again keep their data (DESIGN.md §29.5, §30.11): every suite installed here
// (suites/, whatever it holds: the pipeline names none) and the open `hello` fixture, on the test database the
// suites' own tests have just filled:
//   1. Installed: each started with the platform; a note written through the fixture's service.
//   2. Removed: the platform started without any of them. Not a row or a column of any table is gone; their tables are
//      still there; their records still read.
//   3. Installed again, every migration file of theirs run again (as a version that changed them would): not a
//      row of any table is gone, and each suite works again with what it had (the fixture's note is there).
//   4. Once more, the same: a second reinstall is no different from the first.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/suite-reinstall.mjs   (after the suites' tests)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { loadSuites } from "../suites.mjs";
import { migrate } from "../db/migrate.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
// What the platform itself rightly forgets as it runs (sign-ins that ended, who is looking at what now), and the
// record of migrations this test clears on purpose: every other table only ever grows here.
const PASSING = new Set(["sessions", "presence", "schema_migrations"]);

// Every table of the platform's schema and how many rows it holds; records by object.
async function snapshot() {
    const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'mes' AND table_type = 'BASE TABLE' ORDER BY table_name")).map((r) => r.table_name);
    const counts = {};
    for (const t of tables) {
        try { counts[t] = Number((await db.query(`SELECT count(*)::bigint AS n FROM mes."${t}"`))[0].n); } catch { /* a table the application may not read (the audit's own guard): not counted */ }
    }
    const records = Object.fromEntries((await db.query("SELECT object, count(*)::int AS n FROM mes.records GROUP BY object")).map((r) => [r.object, r.n]));
    // A column dropped is data lost too, however many rows are left.
    const columns = (await db.query("SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'mes'")).map((r) => r.c);
    return { counts, records, columns };
}
// What was lost between two snapshots: tables gone, rows gone, records gone.
function lost(before, after) {
    const out = [];
    for (const [t, n] of Object.entries(before.counts)) {
        if (PASSING.has(t)) continue;
        if (!(t in after.counts)) out.push(`table ${t} is gone`);
        else if (after.counts[t] < n) out.push(`${t}: ${n} rows, now ${after.counts[t]}`);
    }
    for (const [o, n] of Object.entries(before.records)) if ((after.records[o] ?? 0) < n) out.push(`records of ${o}: ${n}, now ${after.records[o] ?? 0}`);
    for (const c of before.columns) if (!after.columns.includes(c) && !PASSING.has(c.split(".")[0])) out.push(`column ${c} is gone`);
    return out;
}
// As the server starts (server.mjs): its migrations and the installed suites', then the application.
const start = async (suites) => {
    await migrate(db, { log: {}, suites });
    const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, suites });
    const { url } = await app.listen({ port: 0 });
    return { app, url };
};

let running = null;
try {
    const fixture = await loadSuites({ dir: fileURLToPath(new URL("./fixtures/suites/", import.meta.url)) });
    const installed = await loadSuites();
    const all = [...installed, ...fixture.filter((f) => !installed.some((x) => x.name === f.name))];
    const names = all.map((x) => x.name);
    const session = `reinstall-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, 'olga', now() + interval '1 hour')", [session]);
    const call = async (url, name, args = {}) => {
        const res = await fetch(`${url}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${session}` }, body: JSON.stringify([args]) });
        return { ok: res.ok, body: await res.json() };
    };

    // ---- 1. installed ----
    running = await start(all);
    const text = `Kept through a reinstall ${randomBytes(4).toString("hex")}`;
    const added = await call(running.url, "hello.add", { text });
    await running.app.close(); running = null;
    const installedAt = await snapshot();
    const own = (await db.query("SELECT name FROM mes.schema_migrations")).map((r) => r.name).filter((n) => names.some((s) => n.startsWith(`${s}:`)));
    step(`installed: ${names.join(", ")}, their migrations recorded (${own.length}), a note written through the fixture's service`, added.ok && own.length >= all.filter((x) => x.migrations.length).length, { added, own });

    // ---- 2. removed ----
    running = await start([]);
    await running.app.close(); running = null;
    const removedAt = await snapshot();
    const goneOnRemove = lost(installedAt, removedAt);
    step("removed (the platform started without them): no table and no row of any is gone, their records still there", !goneOnRemove.length, goneOnRemove);

    // ---- 3, 4. installed again, every migration file run again ----
    for (const round of ["installed again", "and once more"]) {
        const before = await snapshot();
        await db.query("DELETE FROM mes.schema_migrations WHERE " + names.map((_, i) => `name LIKE $${i + 1}`).join(" OR "), names.map((n) => `${n}:%`));
        running = await start(all);
        const notes = await db.query("SELECT text FROM mes.hello_notes WHERE text = $1", [text]);
        await running.app.close(); running = null;
        const rerun = (await db.query("SELECT name FROM mes.schema_migrations")).map((r) => r.name).filter((n) => names.some((s) => n.startsWith(`${s}:`)));
        const gone = lost(before, await snapshot());
        step(`${round}, every migration file of theirs run again (${rerun.length}): no table and no row of any is gone, and the fixture's note is there`,
            !gone.length && rerun.length === own.length && notes.length === 1, { gone, rerun, notes });
    }
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await running?.app.close().catch(() => {});
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
