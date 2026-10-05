// What a suite adds through the core's generic extension points (§30.11), on the hello fixture
// (test/fixtures/suites/hello), and how each behaves once the suite is gone:
//   1. Script capabilities: a service whose design allows it (`uses.suites`) reaches the suite as
//      ctx.<suite>, and only what it names. A dry run and the fitness test act on nothing: they get
//      what the suite says a dry run answers, and report the call. Called for real, the call is in
//      the service's audit entry.
//   2. A design that names a suite that is not installed, or something it does not give, is told so.
//   3. With the suite removed, the published service is still there and still callable: the call is
//      refused in words when its script asks the suite, audited, and nothing else stops.
//   4. Transaction step kinds: a step of the suite's is checked with the design, shown before the run,
//      planned with the other steps and applied inside the run, all or nothing; what cannot be taken
//      back comes last. In a sandbox it runs and reaches nothing outside. With the suite removed, the
//      transaction refuses to run, in words, and every other one runs.
//   5. Screen block kinds: a block of the suite's is checked with the screen, read through the suite as
//      the viewer, and drawn by the suite's component. With the suite removed the block says what it
//      needs, and the screen's other blocks are drawn.
//   6. Design elements of a suite's own kind: started, checked by the platform and by the suite, routed
//      to their stewards, approved, versioned and published like the core's; read by the suite. With
//      the suite removed they stay published and listed, saying what they need, and a change that
//      holds one cannot be submitted.
//   7. Kinds of schedule: a service whose schedule comes from the suite's kind is checked with the
//      design (the suite's own check too), previewed through the server, and once live is run by the
//      scheduler at the times the suite gives, on a clock the test moves; the monitor reads it in the
//      suite's words. A kind whose times cannot be read gives none, and nothing else stops. With the
//      suite removed the service stays published, the scheduler plans nothing for it, and the monitor
//      and a change to it say which suite it needs.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/suite-extensions.mjs   (after a reset)
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
const tag = `${Date.now() % 100000}`;
const WAVE = `hello_wave_t${tag}`;
const TAG = `hello_tag_t${tag}`;
const BOARD = `hello_board_t${tag}`;
const CARD = `hello_card_t${tag}`;
const TICK = `hello_tick_t${tag}`;
const STUCK = `hello_stuck_t${tag}`;
const people = ["olga", "sam", "quinn", "dana", "eli", "vera", "ivan", "ines"];
let app = null;
let bare = null;
let timed = null;
// The scheduler's clock, which the test moves (createApp `now`); a schedule every N seconds.
let clock = Date.now();
const N = 10;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, ms = 10_000) => { const end = Date.now() + ms; let v = await fn(); while (!v && Date.now() < end) { await sleep(100); v = await fn(); } return v; };
const iso = (ms) => new Date(ms).toISOString();

// One server on the database, with or without the suite; a session for each person. `extra`: what
// else it is started with (its scheduler, on the test's clock).
async function serve(suites, extra = {}) {
    const made = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, suites, ...extra });
    const { url: mes } = await made.listen({ port: 0 });
    const sessions = {};
    for (const user of people) {
        sessions[user] = `sx-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields, problems: body.problems };
    };
    const page = async (user, path) => { const res = await fetch(`${mes}${path}`, { headers: { cookie: `mes_session=${sessions[user]}` } }); return { status: res.status, html: await res.text() }; };
    return { app: made, call, page };
}

try {
    const suites = await loadSuites({ dir: fileURLToPath(new URL("./fixtures/suites/", import.meta.url)) });
    await migrate(db, { log: {}, suites });
    const first = await serve(suites);
    app = first.app;
    const { call } = first;

    // ---- 1. a service that reaches the suite ----
    const source = `// Waves to someone through the hello suite, and says how many notes there are.
export default async function ${WAVE}(ctx) {
  const waved = await ctx.hello.wave({ to: ctx.input.to });
  ctx.output = { waved: waved.waved, note: waved.note, notes: await ctx.hello.count() };
  return ctx;
}`;
    const body = {
        name: WAVE, label: "Wave", description: "Waves to someone.",
        input: { to: { label: "To", type: "string", required: true } },
        http: { enabled: false }, callers: { users: ["olga"], groups: [] }, on: [], runAs: "caller",
        uses: { connections: [], objects: {}, suites: { hello: ["wave", "count"] } }, stewards: ["production"],
    };
    const home = await call("dana", "design.home", { as: "dana" });
    step("the designer is told what the installed suite gives a service", JSON.stringify(home.suiteCapabilities) === JSON.stringify({ hello: ["wave", "count"] }), home.suiteCapabilities);
    const { id: change } = await call("dana", "design.start", { service: WAVE, label: "Wave" });
    const saved = await call("dana", "design.save", { id: change, reason: "A wave, through the hello suite.", services: { [WAVE]: body }, scripts: { [WAVE]: source },
        tests: { [WAVE]: [{ name: "waves", run: { input: { to: "Quinn" } }, expect: { ok: true, output: { waved: "Quinn", note: null } } }] } });
    const [{ n: before }] = await db.query("SELECT count(*)::int AS n FROM mes.hello_notes");
    const dry = await call("dana", "design.dryRun", { kind: "service", name: WAVE, source, service: body, run: { input: { to: "Quinn" } } });
    const [{ n: afterDry }] = await db.query("SELECT count(*)::int AS n FROM mes.hello_notes");
    step("a dry run asks the suite nothing for real: it gets what the suite says a dry run answers, and reports what it would have asked",
        saved.problems?.length === 0 && dry.ok && dry.output?.waved === "Quinn" && dry.output.note === null && dry.output.notes === null && afterDry === before
        && dry.suites?.length === 2 && dry.suites[0].suite === "hello" && dry.suites[0].call === "wave" && dry.suites[0].simulated === true,
        { saved, dry });

    // ---- 2. what is not there is said ----
    const notGiven = await call("dana", "design.save", { id: change, services: { [WAVE]: { ...body, uses: { ...body.uses, suites: { hello: ["wave", "shout"], nowhere: ["x"] } } } } });
    const words = (notGiven.problems ?? []).map((p) => p.message).join(" | ");
    step("a design that names what the suite does not give, or a suite that is not installed, is told so", /gives a service no "shout"/.test(words) && /nowhere suite, which is not installed here/.test(words), notGiven.problems);
    const unlisted = await call("dana", "design.dryRun", { kind: "service", name: WAVE, source, service: { ...body, uses: { ...body.uses, suites: { hello: ["wave"] } } }, run: { input: { to: "Quinn" } } });
    step("the script reaches only what its design names: one it does not is not there to call", unlisted.ok === false && /count/.test(unlisted.error?.message ?? ""), unlisted);
    await call("dana", "design.save", { id: change, services: { [WAVE]: body } });

    // ---- published; called for real ----
    const submitted = await call("dana", "design.submit", { id: change });
    await call("vera", "design.review", { id: change, decision: "pass" });
    let state = null;
    for (let round = 0; round < 4 && state !== "executed"; round++) {
        for (const user of people) {
            const seen = await call(user, "design.change", { id: change, as: user });
            for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id: change, department, decision: "approve", meaning: "Approved" })).state ?? state;
        }
    }
    const called = await call("olga", "integration.call", { name: WAVE, input: { to: "Quinn" } });
    const [note] = await db.query("SELECT text, by_user FROM mes.hello_notes ORDER BY id DESC LIMIT 1");
    const [entry] = await db.query("SELECT action, after FROM mes.audit_log WHERE object = '$service' AND action LIKE $1 ORDER BY seq DESC LIMIT 1", [`%:${WAVE}`]);
    step("published (its test case passed as a dry run) and called: the suite acts, as the caller, and the call is in the service's audit entry",
        submitted.ok && state === "executed" && called.output?.waved === "Quinn" && Number.isInteger(called.output.note) && note?.text === `${WAVE} waved to Quinn` && note.by_user === "olga"
        && entry?.action === `called:${WAVE}` && entry.after.calls?.some((c) => c.suite === "hello" && c.call === "wave" && !c.error),
        { submitted, state, called, note, entry });
    const danaInbox = await call("dana", "inbox.mine", { as: "dana" });
    const eliInbox = await call("eli", "inbox.mine", { as: "eli" });
    const olgaInbox = await call("olga", "inbox.mine", { as: "olga" });
    const helloAlerts = (danaInbox.items ?? []).filter((i) => i.kind === "alert");
    step("a suite's alerts reach the people they are for, beside their name (one without a link left out); a suite whose alerts fail leaves the inbox working",
        helloAlerts.length === 1 && helloAlerts[0].suite === "hello" && helloAlerts[0].id === "hello:welcome" && helloAlerts[0].link === "/design" && helloAlerts[0].what === "An alert from the hello suite" && danaInbox.count === danaInbox.items.length &&
        Array.isArray(eliInbox.items) && !eliInbox.items.some((i) => i.kind === "alert") && !(olgaInbox.items ?? []).some((i) => i.kind === "alert"),
        { danaInbox, eliInbox, olgaInbox });
    const refused = await call("olga", "integration.call", { name: WAVE, input: { to: " " } });
    step("the suite's own refusal reaches the caller in its words", refused.status === 422 && /whom to wave to/.test(refused.error ?? ""), refused);

    // ---- 4. a transaction with the suite's steps ----
    const home2 = await call("dana", "design.home", { as: "dana" });
    step("the designer is told the suite's step kinds, and which cannot be taken back", home2.suiteSteps?.["hello.note"]?.label === "Leave a note" && home2.suiteSteps["hello.bell"]?.irreversible === true && home2.suiteSteps["hello.note"].required.join() === "text", home2.suiteSteps);
    const { id: txChange } = await call("dana", "design.start", { transaction: TAG, label: "Tag a lot" });
    const txBase = (await call("dana", "design.change", { id: txChange, as: "dana" })).content.transactions[TAG];
    const tx = {
        ...txBase, label: "Tag a lot", description: "A deviation on the lot, a note of it, and the bell.",
        inputs: { lot: { label: "Lot", type: "ref", to: "lot", required: true }, words: { label: "Words", type: "string", required: true }, times: { label: "Rings", type: "decimal" } },
        steps: [
            { create: "deviation", set: { title: { input: "words" }, lot: { input: "lot" }, severity: "minor", description: "Tagged." } },
            { step: "hello.note", text: { input: "words" } },
            { step: "hello.bell", times: { input: "times" } },
        ],
        confirm: true, callers: { users: [], groups: ["production"] }, stewards: ["production"],
        scenarios: [{
            name: "a lot tagged",
            records: { wo: { object: "work_order", where: { wo_no: ["WO-1002"] } }, lot: { object: "lot", data: { lot_no: `SX${tag}`, item: "PP-BLK-10", work_order: "@wo", qty: 5, uom: "kg" } } },
            steps: [{ as: "olga", do: { transaction: TAG, input: { lot: "@lot", words: "Hi", times: 2 } }, expect: { ok: true, created: { deviation: 1 } } }],
        }],
    };
    const wrongTx = await call("dana", "design.save", { id: txChange, reason: "A tag, with the hello suite's steps.", transactions: { [TAG]: { ...tx, steps: [
        { step: "hello.bell", times: 1 }, tx.steps[0], { step: "hello.note", words: "x" }, { step: "hello.note", text: "x".repeat(81) }, { step: "nowhere.thing" }, { step: "hello.note", text: "ok", on: "lot" },
    ] } } });
    const txWords = (wrongTx.problems ?? []).map((p) => p.message).join(" | ");
    step("its steps are checked: what cannot be taken back comes last, a setting it lacks, one it needs, the suite's own check, a suite that is not here, and no record of its own",
        /cannot be taken back, so it comes after every step/.test(txWords) && /has no setting "words"/.test(txWords) && /"text" is needed/.test(txWords) && /at most 80 characters/.test(txWords) && /needs the nowhere suite/.test(txWords) && /writes no record itself/.test(txWords),
        wrongTx.problems);
    const txSaved = await call("dana", "design.save", { id: txChange, transactions: { [TAG]: tx } });
    const txSubmitted = await call("dana", "design.submit", { id: txChange });
    await call("vera", "design.review", { id: txChange, decision: "pass" });
    let txState = null;
    for (let round = 0; round < 4 && txState !== "executed"; round++) {
        for (const user of people) {
            const seen = await call(user, "design.change", { id: txChange, as: user });
            for (const department of seen.can?.approveFor ?? []) txState = (await call(user, "design.approve", { id: txChange, department, decision: "approve", meaning: "Approved" })).state ?? txState;
        }
    }
    step("its scenario passes in a sandbox, where the suite's steps run and reach nothing outside; reviewed and approved, it is live", txSaved.problems?.length === 0 && txSubmitted.ok && txState === "executed", { txSaved: txSaved.problems, txSubmitted, txState });
    const { rows: lots } = await call("olga", "records.list", { object: "lot", as: "olga" });
    const lot = lots[0];
    const counts = async () => ({
        notes: (await db.query("SELECT count(*)::int AS n FROM mes.hello_notes WHERE text = $1", [`Tag ${tag}`]))[0].n,
        deviations: (await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = 'deviation' AND data->>'title' = $1", [`Tag ${tag}`]))[0].n,
    });
    const shown = await call("olga", "transactions.preview", { name: TAG, input: { lot: lot.id, words: `Tag ${tag}`, times: 2 } });
    step("before it runs, the person is shown the suite's steps with what will change; nothing has happened", shown.also?.map((a) => a.label).join() === "Leave a note,Ring the bell" && shown.changes?.length === 1 && (await counts()).notes === 0, shown);
    const tooMany = await call("olga", "transactions.run", { name: TAG, input: { lot: lot.id, words: `Tag ${tag}`, times: 5 }, key: `sx-${randomBytes(6).toString("hex")}` });
    const afterRefusal = await counts();
    step("refused by the last step, nothing of the run is kept: no deviation, no note", tooMany.status >= 400 && /three times at most/.test(tooMany.error ?? "") && afterRefusal.notes === 0 && afterRefusal.deviations === 0, { tooMany, afterRefusal });
    const blank = await call("olga", "transactions.run", { name: TAG, input: { lot: lot.id, words: "   x".slice(0, 3), times: 1 }, key: `sx-${randomBytes(6).toString("hex")}` });
    const ran = await call("olga", "transactions.run", { name: TAG, input: { lot: lot.id, words: `Tag ${tag}`, times: 2 }, key: `sx-${randomBytes(6).toString("hex")}` });
    const afterRun = await counts();
    const [ranAudit] = await db.query("SELECT after FROM mes.audit_log WHERE object = '$transaction' AND action = $1 ORDER BY seq DESC LIMIT 1", [`run:${TAG}`]);
    step("run: the deviation and the note are made together, the bell rings, and the run's audit entry says what the suite's steps did",
        blank.status >= 400 && ran.ok && afterRun.notes === 1 && afterRun.deviations === 1 && ran.also?.length === 2 && ran.also[1].detail?.rang === 2
        && ranAudit?.after.also?.some((a) => a.kind === "hello.note" && Number.isInteger(a.detail?.note)) && ranAudit.after.also.some((a) => a.kind === "hello.bell" && a.detail.rang === 2),
        { blank, ran, afterRun, ranAudit });

    // ---- 5. a screen with the suite's block ----
    step("the designer is told the suite's block kinds", home2.suiteBlocks?.["hello.notes"]?.label === "Hello notes" && home2.suiteBlocks["hello.notes"].required.join() === "greeting", home2.suiteBlocks);
    const { id: scChange } = await call("dana", "design.start", { screen: BOARD, label: "Hello board" });
    const board = {
        name: BOARD, label: "Hello board", description: "Notes, and a word.", params: {},
        blocks: [{ block: "text", text: `Plain words ${tag}`, width: 12 }, { block: "hello.notes", title: "Notes", greeting: "Good day", limit: 3, width: 12 }],
        callers: { users: [], groups: ["production"] }, stewards: ["production"],
    };
    const wrongBoard = await call("dana", "design.save", { id: scChange, reason: "A board with the hello suite's block.", screens: { [BOARD]: { ...board, blocks: [board.blocks[0], { block: "hello.notes", limit: 50, colour: "red" }, { block: "nowhere.thing" }] } } });
    const boardWords = (wrongBoard.problems ?? []).map((p) => p.message).join(" | ");
    step("its blocks are checked: a setting it needs, one it lacks, the suite's own check, and a suite that is not here",
        /"greeting" is needed/.test(boardWords) && /has no setting "colour"/.test(boardWords) && /limit is 1 to 20/.test(boardWords) && /needs the nowhere suite/.test(boardWords), wrongBoard.problems);
    const boardSaved = await call("dana", "design.save", { id: scChange, screens: { [BOARD]: board } });
    const boardSubmitted = await call("dana", "design.submit", { id: scChange });
    await call("vera", "design.review", { id: scChange, decision: "pass" });
    let scState = null;
    for (let round = 0; round < 4 && scState !== "executed"; round++) {
        for (const user of people) {
            const seen = await call(user, "design.change", { id: scChange, as: user });
            for (const department of seen.can?.approveFor ?? []) scState = (await call(user, "design.approve", { id: scChange, department, decision: "approve", meaning: "Approved" })).state ?? scState;
        }
    }
    const boardData = await call("olga", "screens.data", { name: BOARD, arg: null, as: "olga" });
    const boardPage = await first.page("olga", `/s/${BOARD}`);
    step("live, the block is read through the suite as whoever looks, and drawn by the suite's own component on the page",
        boardSaved.problems?.length === 0 && boardSubmitted.ok && scState === "executed" && /^Good day, Olga/.test(boardData.blocks?.[1]?.greeting ?? "") && boardData.blocks[1].notes?.some((n) => n.text === `Tag ${tag}`)
        && boardPage.status === 200 && boardPage.html.includes("hello-block-greeting") && boardPage.html.includes(`Tag ${tag}`) && boardPage.html.includes(`Plain words ${tag}`),
        { boardSaved: boardSaved.problems, boardSubmitted, scState, boardData, page: boardPage.status });

    // ---- 6. a design element of the suite's own kind ----
    step("the designer is told the suite's kinds of design element", home2.suiteElements?.["hello.card"]?.label === "Greeting card", home2.suiteElements);
    const noKind = await call("dana", "design.start", { element: CARD });
    const notHere = await call("dana", "design.start", { element: CARD, kind: "nowhere.thing" });
    const { id: cardChange } = await call("dana", "design.start", { element: CARD, kind: "hello.card", label: "Welcome card" });
    const cardDraft = (await call("dana", "design.change", { id: cardChange, as: "dana" })).content.elements[CARD];
    step("a new one says its kind, of an installed suite; it starts as its kind's template, with the starter's department as steward",
        noKind.status >= 400 && /says its kind/.test(noKind.error ?? "") && notHere.status === 409 && /nowhere suite, which is not installed here/.test(notHere.error ?? "")
        && cardDraft?.kind === "hello.card" && cardDraft.label === "Welcome card" && cardDraft.to === "everyone" && cardDraft.stewards?.length === 1, { noKind, notHere, cardDraft });
    const badCard = await call("dana", "design.save", { id: cardChange, reason: "A card for the floor.", elements: { [CARD]: { ...cardDraft, to: " ", message: "x".repeat(61), stewards: ["nowhere"] } } });
    const cardWords = (badCard.problems ?? []).map((p) => p.message).join(" | ");
    step("checked by the platform (its stewards are departments) and by the suite (its own rules)", /"nowhere" is not a department/.test(cardWords) && /whom the card is to/.test(cardWords) && /at most 60 characters/.test(cardWords), badCard.problems);
    const card = { ...cardDraft, to: "the night shift", message: "Welcome", stewards: ["production"] };
    const cardSaved = await call("dana", "design.save", { id: cardChange, elements: { [CARD]: card } });
    const cardSeen = await call("dana", "design.change", { id: cardChange, as: "dana" });
    const cardSubmitted = await call("dana", "design.submit", { id: cardChange });
    await call("vera", "design.review", { id: cardChange, decision: "pass" });
    let cardState = null;
    const signers = [];
    for (let round = 0; round < 4 && cardState !== "executed"; round++) {
        for (const user of people) {
            const seen = await call(user, "design.change", { id: cardChange, as: user });
            for (const department of seen.can?.approveFor ?? []) { cardState = (await call(user, "design.approve", { id: cardChange, department, decision: "approve", meaning: "Approved" })).state ?? cardState; signers.push(department); }
        }
    }
    const cards = await call("olga", "hello.cards", { as: "olga" });
    const home3 = await call("dana", "design.home", { as: "dana" });
    const listed = home3.elements?.find((e) => e.name === CARD);
    const [stored] = await db.query("SELECT version, status, body FROM mes.elements WHERE name = $1", [CARD]);
    step("routed to its stewards, approved and executed like any element: published at version 1, listed in the designer, and read by the suite",
        cardSaved.problems?.length === 0 && cardSeen.route?.some((r) => r.department === "production") && cardSubmitted.ok && cardState === "executed" && signers.join() === "production"
        && stored?.version === 1 && stored.status === "published" && listed?.kindLabel === "Greeting card" && !listed.needs && cards.some((c) => c.name === CARD && c.to === "the night shift" && c.version === 1),
        { cardSaved: cardSaved.problems, route: cardSeen.route, cardSubmitted, cardState, signers, stored, listed, cards });
    // A second version, started while the suite is here and still open when it goes.
    const { id: cardChange2 } = await call("dana", "design.start", { element: CARD });
    const edited2 = await call("dana", "design.save", { id: cardChange2, reason: "A warmer word.", elements: { [CARD]: { ...card, message: "A warm welcome" } } });
    step("a change to it starts from what is live; its kind stays what it is", edited2.problems?.length === 0 && (await call("dana", "design.save", { id: cardChange2, elements: { [CARD]: { ...card, kind: "hello.other" } } })).problems?.some((p) => /stays a hello.card/.test(p.message)), edited2);
    await call("dana", "design.save", { id: cardChange2, elements: { [CARD]: { ...card, message: "A warm welcome" } } });

    // ---- 7. a kind of schedule the suite adds ----
    const kind = home2.suiteSchedules?.["hello.every_n_seconds"];
    step("the designer is told the suite's kinds of schedule: label, settings, which are needed",
        kind?.label === "Every so many seconds" && kind.suite === "hello" && kind.config?.seconds === "number" && kind.required?.join() === "seconds" && home2.suiteSchedules["hello.broken"]?.label === "A calendar that cannot be read", home2.suiteSchedules);
    const tickSource = (name) => `// Says when it was due.
export default async function ${name}(ctx) {
  ctx.output = { due: ctx.event?.scheduledAt ?? null };
  return ctx;
}`;
    const tickBody = (name, schedule) => ({
        name, label: `Tick ${name}`, description: "Runs at the times the hello suite gives.", input: {}, http: { enabled: false }, callers: { users: [], groups: [] },
        on: [{ schedule, missed: "last", overlap: "skip" }], runAs: "service", roles: {}, uses: { connections: [], objects: {} }, stewards: ["production"],
    });
    const tickScripts = { [TICK]: tickSource(TICK), [STUCK]: tickSource(STUCK) };
    const tickTests = { [TICK]: [{ name: "runs", run: { input: {} }, expect: { ok: true } }], [STUCK]: [{ name: "runs", run: { input: {} }, expect: { ok: true } }] };
    const { id: schChange } = await call("dana", "design.start", { service: TICK, label: "Tick" });
    const wrongSch = await call("dana", "design.save", { id: schChange, reason: "Ticks on the hello suite's clock.", scripts: tickScripts, tests: tickTests, services: { [TICK]: { ...tickBody(TICK, null), on: [
        { schedule: { from: "hello.every_n_seconds", seconds: 2 } }, { schedule: { from: "hello.every_n_seconds" } }, { schedule: { from: "nowhere.calendar" } },
        { schedule: { from: "hello.every_n_seconds", seconds: N, every: { minutes: 5 } } }, { schedule: { from: "hello.every_n_seconds", seconds: N, colour: "red" } },
    ] } } });
    const schWords = (wrongSch.problems ?? []).map((p) => p.message).join(" | ");
    step("its schedules are checked: the suite's own check of a setting, one it needs, one it lacks, no clock beside it, and a suite that is not here",
        /Trigger 1 \(Every so many seconds\): seconds is a whole number, 5 to 3600/.test(schWords) && /"seconds" is needed/.test(schWords) && /needs the nowhere suite, which is not installed here/.test(schWords)
        && /no every, at, between or days/.test(schWords) && /no setting "colour"/.test(schWords), wrongSch.problems);
    const preview = await call("dana", "integration.scheduleRuns", { trigger: { schedule: { from: "hello.every_n_seconds", seconds: N } } });
    const stuckPreview = await call("dana", "integration.scheduleRuns", { trigger: { schedule: { from: "hello.broken" } } });
    const missingPreview = await call("dana", "integration.scheduleRuns", { trigger: { schedule: { from: "nowhere.calendar" } } });
    const badPreview = await call("dana", "integration.scheduleRuns", { trigger: { schedule: { from: "hello.every_n_seconds", seconds: 2 } } });
    const notDesigner = await call("olga", "integration.scheduleRuns", { trigger: { schedule: { from: "hello.every_n_seconds", seconds: N } } });
    step("its next runs are previewed through the server, which asks the suite: five, N seconds apart; none from a kind that cannot give them; the suite's own check and a suite not here are said; for designers only",
        preview.runs?.length === 5 && preview.runs.every((r, k) => Date.parse(r) % (N * 1000) === 0 && Date.parse(r) > Date.now() - 1000 && (k === 0 || Date.parse(r) - Date.parse(preview.runs[k - 1]) === N * 1000))
        && preview.text === `every ${N} s, counted from the epoch` && stuckPreview.runs?.length === 0 && stuckPreview.problems?.length === 0
        && /needs the nowhere suite/.test(missingPreview.problems?.join(" ") ?? "") && badPreview.runs?.length === 0 && /5 to 3600/.test(badPreview.problems?.join(" ") ?? "") && notDesigner.status === 403,
        { preview, stuckPreview, missingPreview, badPreview, notDesigner });
    const schSaved = await call("dana", "design.save", { id: schChange, scripts: tickScripts, tests: tickTests, services: { [TICK]: tickBody(TICK, { from: "hello.every_n_seconds", seconds: N }), [STUCK]: tickBody(STUCK, { from: "hello.broken" }) } });
    const schSubmitted = await call("dana", "design.submit", { id: schChange });
    await call("vera", "design.review", { id: schChange, decision: "pass" });
    let schState = null;
    for (let round = 0; round < 4 && schState !== "executed"; round++) {
        for (const user of people) {
            const seen = await call(user, "design.change", { id: schChange, as: user });
            for (const department of seen.can?.approveFor ?? []) schState = (await call(user, "design.approve", { id: schChange, department, decision: "approve", meaning: "Approved" })).state ?? schState;
        }
    }
    step("checked, submitted, reviewed and approved like any service: live", schSaved.problems?.length === 0 && schSubmitted.ok && schState === "executed", { schSaved: schSaved.problems, schSubmitted, schState });
    // The scheduler, on the test's clock: a second past a time due, so the next is N seconds on.
    clock = Math.floor(Date.now() / (N * 1000)) * N * 1000 + 1000;
    const b1 = clock - 1000 + N * 1000;
    timed = await serve(suites, { schedulerEveryMs: 100, outboxEveryMs: 100, now: () => clock });
    const outbox = (name) => db.query("SELECT scheduled_at, state, result FROM mes.integration_outbox WHERE service = $1 ORDER BY scheduled_at", [name]);
    const seenFirst = await until(async () => (await db.query("SELECT last_planned_at FROM mes.schedule_state WHERE service = $1", [TICK]))[0]?.last_planned_at);
    clock = b1 + 1000;
    const once = await until(async () => { const rows = await outbox(TICK); return rows.length === 1 && rows[0].state === "done" ? rows : null; });
    clock = b1 + 2 * N * 1000 + 1000;
    const thrice = await until(async () => { const rows = await outbox(TICK); return rows.length === 3 && rows.every((r) => r.state === "done") ? rows : null; });
    const [tickState] = await db.query("SELECT runs_ok, last_output FROM mes.schedule_state WHERE service = $1", [TICK]);
    const stuckRows = await outbox(STUCK);
    const [stuckState] = await db.query("SELECT last_planned_at FROM mes.schedule_state WHERE service = $1", [STUCK]);
    step("live, the scheduler runs it at the times the suite gives, once each, each run told its own time: first seen, planned from then on; then each multiple of N seconds as the clock reaches it",
        seenFirst && once && thrice && thrice.map((r) => new Date(r.scheduled_at).getTime()).join() === [b1, b1 + N * 1000, b1 + 2 * N * 1000].join() && thrice.every((r) => r.result?.due === iso(new Date(r.scheduled_at).getTime())) && tickState?.runs_ok === 3,
        { seenFirst, once: once?.map((r) => r.scheduled_at), thrice: thrice?.map((r) => r.scheduled_at), expected: [b1, b1 + N * 1000, b1 + 2 * N * 1000].map(iso), tickState });
    step("a kind whose times the suite cannot read gives none: nothing is planned for it, and the scheduler goes on with the rest", stuckRows.length === 0 && stuckState && new Date(stuckState.last_planned_at).getTime() === clock, { stuckRows, stuckState });
    const monitor = await timed.call("dana", "integration.monitor", {});
    const tickSeen = monitor.schedules?.find((x) => x.service === TICK);
    const stuckSeen = monitor.schedules?.find((x) => x.service === STUCK);
    step("the monitor reads it in the suite's words, with the next run the suite gives; the one it cannot work out has no next run",
        tickSeen?.when?.[0]?.text === `every ${N} s, counted from the epoch` && tickSeen.nextRunAt === iso(b1 + 3 * N * 1000) && tickSeen.totals.ok === 3 && tickSeen.needs?.length === 0
        && stuckSeen?.when?.[0]?.text === "A calendar that cannot be read" && stuckSeen.nextRunAt === null,
        { tickSeen, stuckSeen });
    await timed.app.close?.();
    timed = null;

    // ---- 3. the suite removed ----
    await app.close?.();
    app = null;
    const gone = await serve([], { schedulerEveryMs: 100, outboxEveryMs: 100, now: () => clock });
    bare = gone.app;
    const still = await gone.call("dana", "design.home", { as: "dana" });
    const without = await gone.call("olga", "integration.call", { name: WAVE, input: { to: "Quinn" } });
    const [lost] = await db.query("SELECT action, after FROM mes.audit_log WHERE object = '$service' AND action LIKE $1 ORDER BY seq DESC LIMIT 1", [`%:${WAVE}`]);
    const other = await gone.call("olga", "records.list", { object: "lot", as: "olga" });
    step("with the suite removed the service is still published and still called: it is refused in words where its script asks the suite, audited, and nothing else stops",
        still.services?.some((s) => s.name === WAVE) && Object.keys(still.suiteCapabilities ?? {}).length === 0 && without.status === 409 && without.code === "suite.missing" && /hello suite is not installed here/.test(without.error ?? "")
        && lost?.action === `rejected:${WAVE}` && lost.after.calls?.some((c) => c.suite === "hello" && /not installed/.test(c.error ?? "")) && Array.isArray(other.rows),
        { services: still.services?.map((s) => s.name), without, lost, other: other.error });
    const txGone = await gone.call("olga", "transactions.run", { name: TAG, input: { lot: lot.id, words: `Tag ${tag}`, times: 1 }, key: `sx-${randomBytes(6).toString("hex")}` });
    const txOther = await gone.call("olga", "transactions.list", { as: "olga" });
    const stillOne = await counts();
    step("its transaction is still published and listed, and refuses to run, in words, writing nothing; every other transaction is there to run",
        txGone.status >= 400 && /needs the hello suite, which is not installed here/.test(txGone.error ?? "") && stillOne.deviations === 1 && Array.isArray(txOther) && txOther.some((x) => x.name === TAG) && txOther.some((x) => x.name === "move_in"),
        { txGone, listed: Array.isArray(txOther) ? txOther.map((x) => x.name) : txOther });
    const boardGone = await gone.call("olga", "screens.data", { name: BOARD, arg: null, as: "olga" });
    const pageGone = await gone.page("olga", `/s/${BOARD}`);
    step("its screen still opens: the suite's block says what it needs, and the screen's other blocks are drawn",
        boardGone.blocks?.[1]?.$needs === "hello" && !boardGone.blocks[0].error && pageGone.status === 200 && pageGone.html.includes("needs the hello suite, which is not installed here") && pageGone.html.includes(`Plain words ${tag}`) && !pageGone.html.includes("hello-block-greeting"),
        { boardGone, page: pageGone.status });
    const cardGone = still.elements?.find((e) => e.name === CARD);
    const startGone = await gone.call("dana", "design.start", { element: CARD, kind: "hello.card" });
    const submitGone = await gone.call("dana", "design.submit", { id: cardChange2 });
    const heldBack = await gone.call("dana", "design.change", { id: cardChange2, as: "dana" });
    const [kept] = await db.query("SELECT version, status FROM mes.elements WHERE name = $1 AND status = 'published'", [CARD]);
    step("its design element stays published and listed, saying what it needs; a change that holds it cannot be submitted, and says why",
        cardGone?.needs === "hello" && cardGone.version === 1 && kept?.version === 1 && submitGone.status >= 400 && heldBack.state === "design" && heldBack.problems?.some((p) => /hello suite, which is not installed here/.test(p.message)),
        { cardGone, startGone, submitGone, problems: heldBack.problems });
    // Its kind of schedule: the service stays published; the scheduler goes over it and plans nothing.
    clock = b1 + 5 * N * 1000 + 1000;
    const overIt = await until(async () => { const [st] = await db.query("SELECT last_planned_at FROM mes.schedule_state WHERE service = $1", [TICK]); return st && new Date(st.last_planned_at).getTime() === clock ? st : null; });
    const keptRows = await outbox(TICK);
    const monitorGone = await gone.call("dana", "integration.monitor", {});
    const tickGone = monitorGone.schedules?.find((x) => x.service === TICK);
    const { id: tickLater } = await gone.call("dana", "design.start", { service: TICK });
    const tickEdited = await gone.call("dana", "design.save", { id: tickLater, reason: "x", services: { [TICK]: { ...tickBody(TICK, { from: "hello.every_n_seconds", seconds: N }), description: "Ticks, once the suite is back." } } });
    await gone.call("dana", "design.withdraw", { id: tickLater });
    step("its scheduled service stays published and listed; the scheduler goes over it and plans nothing; the monitor, and a change to it, say which suite it needs",
        still.services?.some((x) => x.name === TICK) && Object.keys(still.suiteSchedules ?? {}).length === 0 && overIt && keptRows.length === 3
        && tickGone?.needs?.join() === "hello" && tickGone.when?.[0]?.needs === "hello" && /needs the hello suite, which is not installed here/.test(tickGone.when[0].text) && tickGone.nextRunAt === null
        && (tickEdited.problems ?? []).some((p) => /needs the hello suite, which is not installed here/.test(p.message)),
        { overIt, keptRows: keptRows.length, tickGone, problems: tickEdited.problems });
    const { id: later } = await gone.call("dana", "design.start", { service: WAVE });
    const edited = await gone.call("dana", "design.save", { id: later, reason: "x", services: { [WAVE]: { ...body, description: "Waves, once the suite is back." } } });
    await gone.call("dana", "design.withdraw", { id: later });
    step("a change to it then says what it needs, in words", (edited.problems ?? []).some((p) => /hello suite, which is not installed here/.test(p.message)), edited.problems);
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close?.().catch(() => {});
    await timed?.app?.close?.().catch(() => {});
    await bare?.close?.().catch(() => {});
    await pool.end();
}

for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok || s.detail === undefined ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
const failed = steps.filter((s) => !s.ok).length;
console.log(failed ? `\n${failed} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
