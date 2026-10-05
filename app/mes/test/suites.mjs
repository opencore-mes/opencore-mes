// Suites (§29), the extension point, end to end with an open fixture (test/fixtures/suites/hello):
//   1. Found and checked: its migration runs with the platform's, named after it.
//   2. Its server part: a live query and a write named after it, as the person, audited.
//   3. Its browser part: its page rendered by the server, its navigator entry and its module and
//      stylesheet named in every page, and served.
//   4. The contract holds: a service not named after its suite stops the start.
//   5. Its part of an object's design (§29.4): checked by the suite, a suite that is not installed
//      named; a script it names, with test cases the fitness test runs (input in, output out);
//      approved by the object's stewards; once live, the suite runs the script as approved.
//   6. Its design pack extends the built-in Person and locks what it adds (builtins.js): before the pack
//      is approved its lock keeps nothing; the pack's change carries Person as it would be (the field
//      marked as the suite's); approved and live, the lock keeps the field, shown to the designer;
//      removing it is refused, naming the suite; two suites with one prefix stop the start; with the
//      suite removed its lock is lifted and the field stays.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/suites.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fromPg } from "../../../src/server/db.js";
import { createApp } from "../app.mjs";
import { loadSuites } from "../suites.mjs";
import { migrate } from "../db/migrate.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
let app = null;

try {
    // ---- 1. found, migrated ----
    const suites = await loadSuites({ dir: fileURLToPath(new URL("./fixtures/suites/", import.meta.url)) });
    const hello = suites[0];
    step("found: the hello suite, its browser module served beside its files", suites.length === 1 && hello.name === "hello" && hello.version === "1.0.0" && hello.clientUrl === "/app/mes/test/fixtures/suites/hello/client/index.js" && hello.nav[0]?.to === "/hello", suites);
    await db.query("DROP TABLE IF EXISTS mes.hello_notes; DELETE FROM mes.schema_migrations WHERE name LIKE 'hello:%'");
    const done = await migrate(db, { log: {}, suites });
    step("its migration runs with the platform's, named after it", done.some((d) => d.name === "hello:notes" && d.action === "applied") && (await db.query("SELECT to_regclass('mes.hello_notes') AS t"))[0].t, done);
    step("…once", !(await migrate(db, { log: {}, suites })).some((d) => d.name === "hello:notes"));

    // ---- 2. its server part ----
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, suites });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of ["olga", "dana", "vera", "sam", "eli", "quinn", "ivan", "ines", "iris"]) {
        sessions[user] = `suite-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const session = sessions.olga;
    const callAs = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status };
    };
    const call = async (name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${session}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status };
    };
    const empty = await call("hello.add", { text: " " });
    step("its write checks what it is given", empty.status === 400 && /Say something/.test(empty.error), empty);
    const added = await call("hello.add", { text: "First shift started" });
    const notes = await call("hello.notes", { as: "olga" });
    step("its write and its live query, as the person", added.by_user === "olga" && notes.some((n) => n.text === "First shift started"), { added, notes });
    const [audited] = await db.query("SELECT actor, action FROM mes.audit_log WHERE object = '$hello' ORDER BY seq DESC LIMIT 1");
    step("audited in the platform's audit trail", audited?.actor === "olga" && audited.action === "hello:add", audited);

    // ---- 3. its browser part ----
    const page = await (await fetch(`${mes}/hello`, { headers: { cookie: `mes_session=${session}` } })).text();
    step("its page, rendered by the server with its data", page.includes("Hello notes") && page.includes("First shift started (olga)"), page.slice(0, 400));
    const named = JSON.parse(page.match(/<meta name="mes-suites" content="([^"]*)">/)?.[1].replace(/&quot;/g, '"') ?? "[]");
    step("its module named in the page, for the browser to import first", named.length === 1 && named[0].startsWith("/app/mes/test/fixtures/suites/hello/client/index.js"), named);
    step("its stylesheet linked, and its navigator entry in the page's state", /hello\/client\/hello\.css/.test(page) && page.includes("Hello notes") && /"nav":\[\{"group":"Data","label":"Hello notes"/.test(page));
    const served = await fetch(`${mes}${named[0]}`);
    step("its module served", served.ok && (await served.text()).includes("HelloPage"));
    const home = await (await fetch(`${mes}/`, { headers: { cookie: `mes_session=${session}` } })).text();
    step("the platform's own pages are as they were", home.includes("OpenCore MES") && !home.includes("Not found"));

    // ---- 5. its part of an object's design ----
    const ch = await callAs("dana", "design.start", { object: "machine" });
    const machine = (await callAs("dana", "design.change", { id: ch.id, as: "dana" })).content.definitions.machine;
    const save = (part, extra = {}) => callAs("dana", "design.save", { id: ch.id, reason: "Machines greet.", definitions: { machine: { ...machine, suites: part } }, ...extra });
    const blank = await save({ hello: { greeting: " " } });
    step("the suite checks its part: a greeting is said", blank.problems?.some((p) => /Hello on Machine: say the greeting/.test(p.message)), blank.problems);
    const other = await save({ other: {} });
    step("a part of a suite that is not installed is named", other.problems?.some((p) => /"other" is not an installed suite/.test(p.message)), other.problems);
    const noScript = await save({ hello: { greeting: "good morning", script: "hello_shout" } });
    step("a script it names must exist", noScript.problems?.some((p) => /names the script "hello_shout", which does not exist/.test(p.message)), noScript.problems);
    const source = "// Shouts the greeting.\nexport default function hello_shout(ctx) {\n    return { ...ctx, text: String(ctx.text).toUpperCase() };\n}\n";
    const wrongCase = await save({ hello: { greeting: "good morning", script: "hello_shout" } }, { scripts: { hello_shout: source }, tests: { hello_shout: [{ name: "shouts", run: { text: "hi" }, expect: { output: { text: "hi" } } }] } });
    const fitWrong = await callAs("dana", "design.fitness", { id: ch.id });
    const testsWrong = fitWrong.checks?.find((c) => c.id === "tests");
    step("its test cases run in the fitness test as the suite runs it (input in, output out): a wrong expectation fails", wrongCase.problems?.length === 0 && testsWrong?.status === "fail" && /does not hold/.test(testsWrong.items.join(" ")), { problems: wrongCase.problems, testsWrong });
    await save({ hello: { greeting: "good morning", script: "hello_shout" } }, { scripts: { hello_shout: source }, tests: { hello_shout: [{ name: "shouts", run: { text: "hi" }, expect: { output: { text: "HI" } } }] } });
    const routed = await callAs("dana", "design.change", { id: ch.id, as: "dana" });
    step("approved by the object's stewards (its part, and the script it names)", routed.route.map((r) => r.department).join() === "production" && routed.footprint.some((e) => e.element === "object.suites") && routed.footprint.some((e) => e.element === "script:hello_shout" && e.stewards.join() === "production"), routed.footprint);
    const submitted = await callAs("dana", "design.submit", { id: ch.id });
    await callAs("vera", "design.review", { id: ch.id, decision: "pass" });
    const live = await callAs("sam", "design.approve", { id: ch.id, department: "production", decision: "approve", meaning: "Approved" });
    step("its cases pass; submitted, reviewed, approved: live", submitted.ok && live.state === "executed", { submitted, live });
    step("the suite runs the script as approved", (await call("hello.greet", { object: "machine" })) === "GOOD MORNING");

    // ---- 4. the contract ----
    const misnamed = { ...hello, name: "hello", register: () => ({ services: { "records.drop": async () => null } }) };
    const refused = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, suites: [misnamed] }).then(() => null, (e) => e.message);
    step("a service not named after its suite stops the start", /"records.drop" is not named after it/.test(refused ?? ""), refused);

    // ---- 6. its pack: a field on the built-in Person, locked ----
    const approveAll = async (id) => {
        const submitted = await callAs("dana", "design.submit", { id });
        if (submitted.error) return submitted;
        await callAs("vera", "design.review", { id, decision: "pass" });
        let state = null;
        for (let round = 0; round < 4 && state !== "executed"; round++) {
            for (const user of Object.keys(sessions)) {
                const seen = await callAs(user, "design.change", { id, as: user });
                for (const department of seen.can?.approveFor ?? []) state = (await callAs(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
            }
        }
        return { state };
    };
    const home6 = await callAs("dana", "design.home", { as: "dana" });
    step("before its pack is approved, its lock on Person keeps nothing: the nickname is not live yet", home6.locks?.person?.some((l) => l.by === "suite" && l.suite === "hello" && !Object.keys(l.fields ?? {}).length), home6.locks?.person);
    const packCh = await callAs("dana", "design.fromPack", { suite: "hello" });
    const packChange = await callAs("dana", "design.change", { id: packCh.id, as: "dana" });
    const extended = packChange.content?.definitions?.person;
    step("its change carries Person as it would be: the live definition, the nickname added (marked as the suite's), a form section for it",
        extended?.builtIn === true && extended.fields.name && extended.fields.hello_nickname?.suite === "hello" && extended.form.sections.some((sec) => sec.label === "Hello" && sec.fields.includes("hello_nickname")) && !packChange.problems?.length, { problems: packChange.problems, fields: extended && Object.keys(extended.fields) });
    const packDone = await approveAll(packCh.id);
    const [personLive] = await db.query("SELECT body FROM mes.definitions WHERE object = 'person' AND status = 'published'");
    const home7 = await callAs("dana", "design.home", { as: "dana" });
    step("…approved and live: Person has the nickname, and the Hello suite's lock keeps it, saying why, for the designer to see",
        packDone.state === "executed" && personLive.body.fields.hello_nickname?.suite === "hello" && home7.locks?.person?.some((l) => l.suite === "hello" && l.fields?.hello_nickname?.type === "string" && /nickname/.test(l.why)), { packDone, locks: home7.locks?.person });
    const dropCh = await callAs("dana", "design.start", { object: "person" });
    const dropBody = (await callAs("dana", "design.change", { id: dropCh.id, as: "dana" })).content.definitions.person;
    delete dropBody.fields.hello_nickname;
    for (const sec of dropBody.form.sections) sec.fields = sec.fields.filter((f) => f !== "hello_nickname");
    dropBody.form.sections = dropBody.form.sections.filter((sec) => sec.fields.length);
    const dropped = await callAs("dana", "design.save", { id: dropCh.id, reason: "No nicknames.", definitions: { person: dropBody } });
    step("removing the nickname is refused while the suite is installed, naming it", dropped.problems?.some((p) => /Field "hello_nickname" cannot be removed: it is locked by the Hello suite\. Hello greets people by their nickname\./.test(p.message)), dropped.problems);
    const twin = { ...hello, name: "hello2", label: "Hello twin", register: () => ({}) };
    const clashed = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, suites: [hello, twin] }).then((a) => a.close().then(() => null), (e) => e.message);
    step("two suites naming their designs alike stop the start, naming both", /hello and hello2 both name their designs "hello_…"/.test(clashed ?? ""), clashed);
    // The suite removed: its lock lifted, its field still there and still labelled as the suite's.
    const without = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, suites: [] });
    const { url: bare } = await without.listen({ port: 0 });
    const bareCall = async (name, args) => (await (await fetch(`${bare}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions.dana}` }, body: JSON.stringify([args]) })).json());
    const bareHome = await bareCall("design.home", { as: "dana" });
    const droppedNow = await bareCall("design.save", { id: dropCh.id, seen: (await bareCall("design.change", { id: dropCh.id, as: "dana" })).draft_rev, definitions: { person: dropBody } });
    await without.close();
    step("with the suite removed, its lock is lifted (only the platform's is left), and removing the nickname is no longer refused",
        bareHome.locks?.person?.every((l) => l.by === "core") && !droppedNow.problems?.some((p) => /hello_nickname/.test(p.message)), { locks: bareHome.locks?.person, problems: droppedNow.problems });
    await callAs("dana", "design.withdraw", { id: dropCh.id });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close();
    await db.query("DROP TABLE IF EXISTS mes.hello_notes; DELETE FROM mes.schema_migrations WHERE name LIKE 'hello:%'").catch(() => {});
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
