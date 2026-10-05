// A model file (§24.1), end to end, between two installations with a database each:
//   1. The source: a small model taken live through the lifecycle (a kiln and its loads, a rule, a
//      transaction with a scenario, a screen, roles), its records made, and its scenario changed to
//      pick records of the plant.
//   2. Export: one file, as the designer who asks may read: the designs, the roles departments hold,
//      the records of the objects not asked for empty; the scenario's picked records written as given
//      ones. Someone the designer is not shared with exports nothing.
//   3. The target, with nothing modelled: the preview says what is new, and that the records wait.
//      Only a designer starts the change; it holds every design; a second start is refused.
//   4. Reviewed and approved there, the designs are live, the same as at the source, and the trail
//      says which file they came from. The file again changes nothing.
//   5. Its records: previewed, then loaded through the record services as the person; references
//      found by key; each in its object's first state; loading again adds nothing.
//   6. An object exported empty brings no records; a file that is not a model file is refused in words.
//   7. An AI, through its person's token: the designs as a file (never the records), a preview, and a
//      change only with the draft scope.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/model-file.mjs
// It resets two databases of its own beside that one (its name + "_model_src", "_model"), leaving that one as it is.
import pg from "pg";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fromPg } from "../../../src/server/db.js";
import { createApp } from "../app.mjs";
import { loadSuites } from "../suites.mjs";
import { canonical } from "../server/audit.js";

const base = process.env.DATABASE_URL ?? "postgres:///openmes_test";
if (!/test/i.test(base)) { console.error(`refused: ${base} does not look like a test database`); process.exit(1); }
const tool = (url) => new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../db/reset.mjs", import.meta.url)), "--blank"], { env: { ...process.env, DATABASE_URL: url, SEED_SUITES: "", SEED_VOLUME: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
});
const resets = [await tool(`${base}_model_src`), await tool(`${base}_model`)];

const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const people = ["olga", "sam", "quinn", "dana", "eli", "vera", "ivan", "ines"];
// One installation: its database, its server, a session for each person.
async function site(url, suites = []) {
    const pool = new pg.Pool({ connectionString: url });
    const db = fromPg(pool);
    const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, suites });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of people) {
        sessions[user] = `mf-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const get = (user, path) => fetch(`${mes}${path}`, { headers: { cookie: `mes_session=${sessions[user]}` } });
    const post = async (user, path, body) => {
        const res = await fetch(`${mes}${path}`, { method: "POST", headers: { "content-type": "application/octet-stream", origin: mes, cookie: `mes_session=${sessions[user]}` }, body });
        return { status: res.status, ...(await res.json()) };
    };
    // Submitted, reviewed, approved by everyone it reaches.
    const approve = async (id) => {
        const submitted = await call("dana", "design.submit", { id });
        const reviewed = await call("vera", "design.review", { id, decision: "pass" });
        let state = null;
        for (let round = 0; round < 4 && state !== "executed"; round++) {
            for (const user of people) {
                const seen = await call(user, "design.change", { id, as: user });
                for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
            }
        }
        return { state, submitted, reviewed };
    };
    return { db, pool, app, mes, call, get, post, approve, close: async () => { await app.close?.(); await pool.end(); } };
}
let source = null;
let target = null;

try {
    step("two installations of their own, with people and nothing modelled", resets.every((r) => r.code === 0), resets.map((r) => r.out));
    const suites = await loadSuites({ dir: fileURLToPath(new URL("./fixtures/packs/", import.meta.url)) });
    const { KILN, LOAD, FIRE, SCREEN } = await import("./fixtures/packs/kiln/suite.mjs");
    const t = KILN.replace("kiln_t", "");
    source = await site(`${base}_model_src`, suites);
    target = await site(`${base}_model`);

    // ---- 1. the source ----
    const started = await source.call("dana", "design.fromPack", { suite: "kiln" });
    const draft = (await source.call("dana", "design.change", { id: started.id, as: "dana" })).content;
    // Both objects let an import make their records, found by their own number.
    const saved = await source.call("dana", "design.save", { id: started.id, definitions: {
        [KILN]: { ...draft.definitions[KILN], transfer: { import: { create: true, update: true, key: "kiln_id" } } },
        [LOAD]: { ...draft.definitions[LOAD], transfer: { import: { create: true, update: true, key: "load_no" } } },
    } });
    const first = await source.approve(started.id);
    const samples = await source.call("sam", "design.samples", { suite: "kiln" });
    step("the source's model is live through its own lifecycle, with its records", first.state === "executed" && samples.made >= 3, { saved, first, samples });
    // The designer reads the plant's kilns and loads too (a role of her own, set here as the seed sets roles).
    for (const object of [KILN, LOAD]) await source.db.query("INSERT INTO mes.assignments (subject_kind, subject_id, object, role) VALUES ('user', 'dana', $1, 'operator')", [object]);
    // Its scenario picks records of this plant: the load by its number, the kiln by its own.
    const second = await source.call("dana", "design.start", { transaction: FIRE });
    const fire = (await source.call("dana", "design.change", { id: second.id, as: "dana" })).content.transactions[FIRE];
    const picked = { ...fire, description: "The load is fired in its kiln, once.", scenarios: [{ ...fire.scenarios[0], records: { load: { object: LOAD, where: { load_no: [`L1-${t}`] } }, kiln: { object: KILN, where: { kiln_id: [`K1-${t}`] } } } }] };
    const savedPicked = await source.call("dana", "design.save", { id: second.id, reason: "The scenario runs on a load of the plant.", transactions: { [FIRE]: picked } });
    const again = await source.approve(second.id);
    step("its scenario now picks a load and a kiln of the plant, and passes there", again.state === "executed", { second, savedPicked, again });

    // ---- 2. export ----
    const notShared = await source.get("olga", "/model-file/export");
    const objects = await source.call("dana", "model.objects", { as: "dana" });
    const res = await source.get("dana", "/model-file/export");
    const bytes = Buffer.from(await res.arrayBuffer());
    const file = JSON.parse(bytes.toString("utf8"));
    const names = (kind) => (file.designs?.[kind] ?? []).map((b) => b.name ?? b.object);
    const tableOf = (f, object) => (f.records ?? []).find((x) => x.object === object);
    step("someone the designer is not shared with exports nothing; the designer is told each object's records", notShared.status === 403 && objects.find?.((o) => o.object === KILN)?.records === 1 && objects.find((o) => o.object === LOAD)?.records === 2, { status: notShared.status, objects });
    step("one file: the designs, the roles departments hold, the records of both objects, where it came from",
        res.status === 200 && /attachment; filename="opencoremes-model-/.test(res.headers.get("content-disposition") ?? "") && file.format === "opencore-mes-model" && file.version === 1
        && names("definitions").includes(KILN) && names("definitions").includes(LOAD) && names("transactions").includes(FIRE) && names("screens").includes(SCREEN) && Object.keys(file.designs.scripts).some((n) => n.startsWith("kiln_pieces")) && Object.keys(file.designs.tests).length === 1
        && file.designs.roles?.[KILN]?.operator?.includes("group:production") && tableOf(file, KILN)?.rows.length === 2 && tableOf(file, LOAD)?.rows.length === 3 && file.about.by === "dana" && file.about.versions.transactions[FIRE] === 2 && !file.about.empty.length,
        { status: res.status, about: file.about, designs: Object.fromEntries(Object.entries(file.designs ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : Object.keys(v)])), records: (file.records ?? []).map((x) => [x.name, x.rows.length]) });
    const carried = file.designs.transactions.find((b) => b.name === FIRE)?.scenarios?.[0]?.records ?? {};
    step("the scenario's picked records are written as given ones: the load and its kiln by their keys, each naming the other",
        carried.load?.data?.load_no === `L1-${t}` && carried.load.data.kiln === "@kiln" && carried.load.state === "loaded" && carried.kiln?.data?.kiln_id === `K1-${t}` && carried.kiln.data.first_load === "@load" && Object.keys(carried).length === 2 && !file.about.notes.length,
        { carried, notes: file.about.notes });
    const [exported] = await source.db.query("SELECT actor, after FROM mes.audit_log WHERE object = '$model' AND action = 'model:export' ORDER BY seq DESC LIMIT 1");
    step("the export is in the source's audit trail: who, how many designs, how many records", exported?.actor === "dana" && exported.after.records?.[LOAD] === 2, exported);
    const emptyRes = await source.get("dana", `/model-file/export?empty=${LOAD}`);
    const emptyFile = JSON.parse(await emptyRes.text());
    const noRecords = Buffer.from(await (await source.get("dana", "/model-file/export?records=0")).arrayBuffer());

    // ---- 3. the target: previewed, started ----
    const preview = await target.post("dana", "/model-file/preview", bytes);
    step("the target's preview: every design new, nothing wrong with them, the roles they bring, and the records waiting for the change",
        preview.status === 200 && preview.designs.new === 5 && preview.designs.changed === 0 && preview.designs.problems.length === 0 && preview.designs.roles.length === 2 && preview.records.length === 2 && preview.records.every((r) => r.live === false && /once the change has executed/.test(r.waits ?? "")) && preview.hash?.length === 64,
        preview);
    const notDesigner = await target.post("vera", "/model-file/start", bytes);
    const notSigned = await fetch(`${target.mes}/model-file/preview`, { method: "POST", headers: { origin: target.mes }, body: bytes });
    const early = await target.post("sam", "/model-file/records", bytes);
    step("only a designer starts the change; nobody signed out sees a preview; its records do not load before its objects are live", notDesigner.status === 403 && notSigned.status === 401 && early.status >= 400, { notDesigner, notSigned: notSigned.status, early });
    const begun = await target.post("dana", "/model-file/start", bytes);
    const change = await target.call("dana", "design.change", { id: begun.id, as: "dana" });
    const c = change.content ?? {};
    const [startedBy] = await target.db.query("SELECT after FROM mes.audit_log WHERE object = '$change' AND record_id = $1 AND action = 'change:start'", [begun.id]);
    step("one change holds every design and the roles; its first audit entry names the file by its hash and where it came from",
        begun.status === 200 && Object.keys(c.definitions ?? {}).sort().join() === [KILN, LOAD].sort().join() && c.transactions?.[FIRE] && c.screens?.[SCREEN] && Object.keys(c.scripts ?? {}).length === 1 && Object.keys(c.tests ?? {}).length === 1 && c.organization?.roles?.[KILN]?.operator?.includes("group:production")
        && /^Model from /.test(change.title) && startedBy?.after.modelFile === preview.hash && startedBy.after.versions?.transactions?.[FIRE] === 2,
        { begun, title: change.title, content: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Object.keys(v ?? {})])), startedBy });
    const twice = await target.post("dana", "/model-file/start", bytes);
    step("a second start is refused, naming the open change", twice.status === 409 && /Model from/.test(twice.error ?? ""), twice);

    // ---- 4. approved: live, the same as at the source ----
    const landed = await target.approve(begun.id);
    const bodies = async (s) => Object.fromEntries(await Promise.all([["definitions", "object", "body"], ["transactions", "name", "body"], ["screens", "name", "body"], ["scripts", "name", "source"]].map(async ([table, key, col]) =>
        [table, Object.fromEntries((await s.db.query(`SELECT ${key} AS k, ${col} AS v FROM mes.${table} WHERE status = 'published' AND ${key} LIKE 'kiln_%' ORDER BY ${key}`)).map((r) => [r.k, r.v]))])));
    const [here, there] = [await bodies(target), await bodies(source)];
    // The picked records are given ones here: that is the one difference, and it is the file's.
    there.transactions[FIRE] = { ...there.transactions[FIRE], scenarios: file.designs.transactions.find((b) => b.name === FIRE).scenarios };
    step("submitted (its scenario passes on the records it gives), reviewed, approved: every design is live, the same as at the source",
        landed.submitted.ok && landed.state === "executed" && canonical(here) === canonical(there) && Object.keys(here.definitions).length === 2,
        { landed, here: Object.fromEntries(Object.entries(here).map(([k, v]) => [k, Object.keys(v)])), same: Object.fromEntries(Object.keys(here).map((k) => [k, canonical(here[k]) === canonical(there[k])])) });
    const after = await target.post("dana", "/model-file/preview", bytes);
    const nothing = await target.post("dana", "/model-file/start", bytes);
    step("the same file again changes nothing: every design is the same, and no change is started", after.designs.new === 0 && after.designs.changed === 0 && after.designs.same >= 5 && after.records.every((r) => r.live && !r.waits) && nothing.status === 409 && nothing.code === "design.same", { after: after.designs, records: after.records, nothing });

    // ---- 5. its records ----
    const dry = await target.post("sam", "/model-file/records", bytes);
    const counts = (r, object) => r.models?.find((m) => m.object === object)?.counts;
    const [{ n: none }] = await target.db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = ANY($1)", [[KILN, LOAD]]);
    const applied = await target.post("sam", "/model-file/records?apply=1", bytes);
    const rows = await target.db.query("SELECT object, id, state, data, created_by FROM mes.records WHERE object = ANY($1) AND archived_at IS NULL", [[KILN, LOAD]]);
    const kiln = rows.find((r) => r.object === KILN);
    const loads = rows.filter((r) => r.object === LOAD);
    step("previewed, nothing written; then loaded as the person: the kiln and its two loads, each load's kiln found by its number",
        counts(dry, KILN)?.create === 1 && counts(dry, LOAD)?.create === 2 && none === 0 && counts(applied, KILN)?.create === 1 && counts(applied, LOAD)?.create === 2 && kiln?.data.kiln_id === `K1-${t}` && kiln.created_by === "sam" && loads.length === 2 && loads.every((l) => l.data.kiln === kiln.id)
        // …and the reference that goes round, set once both were there: the kiln's first load.
        && kiln.data.first_load === loads.find((l) => l.data.load_no === `L1-${t}`)?.id && applied.models.find((m) => m.object === KILN)?.linked === 1 && (dry.warnings ?? []).some((w) => /go round/.test(w)),
        { dry: dry.models?.map((m) => [m.object, m.counts]) ?? dry, applied: applied.models?.map((m) => [m.object, m.counts, m.rows?.filter((r) => r.action === "refused")]) ?? applied, rows });
    step("each record is in its object's first state, and the load says so: a state changes by its actions, not by an import", loads.every((l) => l.state === "loaded") && kiln?.state === "idle" && JSON.stringify(applied).includes("state changes by its actions"), { states: rows.map((r) => r.state) });
    const repeat = await target.post("sam", "/model-file/records?apply=1", bytes);
    const [{ n: still }] = await target.db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = ANY($1) AND archived_at IS NULL", [[KILN, LOAD]]);
    step("loading the same file again adds nothing", still === 3 && !counts(repeat, KILN)?.create && !counts(repeat, LOAD)?.create, { repeat: repeat.models?.map((m) => [m.object, m.counts]) ?? repeat, still });

    // ---- 6. empty; not a model file ----
    const emptyLoad = await target.post("sam", "/model-file/records", noRecords);
    step("an object exported empty brings its design and no records; a file with every object empty has no records to load",
        emptyRes.status === 200 && !tableOf(emptyFile, LOAD) && tableOf(emptyFile, KILN)?.rows.length === 2 && emptyFile.about.empty.join() === LOAD && emptyFile.designs.definitions.some((d) => d.object === LOAD) && emptyLoad.status === 409 && emptyLoad.code === "model.empty",
        { empty: emptyFile.about.empty, tables: (emptyFile.records ?? []).map((x) => x.name), emptyLoad });
    const notJson = await target.post("dana", "/model-file/preview", Buffer.from("PK\u0003\u0004 a workbook"));
    const notModel = await target.post("dana", "/model-file/preview", Buffer.from(JSON.stringify({ hello: "world" })));
    const newer = await target.post("dana", "/model-file/start", Buffer.from(JSON.stringify({ ...file, version: 2 })));
    const broken = await target.post("dana", "/model-file/start", Buffer.from(JSON.stringify({ ...file, designs: { ...file.designs, transactions: [{ label: "No name" }] } })));
    step("what is not a model file, one of another version, and one whose designs are not shaped as designs are refused in words, and nothing starts",
        notJson.status === 400 && /not JSON/.test(notJson.error) && notModel.status === 422 && /not a model file/.test(notModel.error) && newer.status === 422 && /version 2/.test(newer.error) && broken.status === 422 && /transactions/.test(broken.error),
        { notJson, notModel, newer, broken });

    // ---- 7. an AI, as its person ----
    const issued = await source.call("dana", "ai.token.create", { name: "model file test", scopes: ["design:read"] });
    const ai = async (s, token, method, path, body) => {
        const res = await fetch(`${s.mes}/ai/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-ai-agent": "test agent" }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
    };
    const aiFile = await ai(source, issued.token, "GET", "/model");
    const there2 = await target.call("dana", "ai.token.create", { name: "model file test", scopes: ["design:read", "design:draft"] });
    const aiPreview = await ai(target, there2.token, "POST", "/model/preview", { file: aiFile.body });
    const readOnly = await target.call("dana", "ai.token.create", { name: "model file reader", scopes: ["design:read"] });
    const aiRefused = await ai(target, readOnly.token, "POST", "/model/changes", { file: aiFile.body });
    const aiSame = await ai(target, there2.token, "POST", "/model/changes", { file: aiFile.body });
    step("an AI exports the designs as its person, never the records; previews a file; starts a change only with the draft scope (here everything is live already)",
        aiFile.status === 200 && aiFile.body.format === "opencore-mes-model" && aiFile.body.records.length === 0 && aiFile.body.designs.transactions.some((b) => b.name === FIRE)
        && aiPreview.status === 200 && aiPreview.body.designs.new === 0 && aiRefused.status === 403 && aiRefused.body.code === "scope.missing" && aiSame.status === 409 && aiSame.body.code === "design.same",
        { aiFile: aiFile.status, records: aiFile.body.records?.length, aiPreview: aiPreview.body.designs ?? aiPreview.body, aiRefused, aiSame });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await source?.close().catch(() => {});
    await target?.close().catch(() => {});
}

for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok || s.detail === undefined ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
const failed = steps.filter((s) => !s.ok).length;
console.log(failed ? `\n${failed} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
