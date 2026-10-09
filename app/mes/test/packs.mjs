// Design packs (§29.6), end to end with a fixture suite that is only designs (test/fixtures/packs/kiln):
//   1. Offered: the designer's home lists it, everything in it new, the roles it suggests that are
//      missing (a group that does not exist left out), its sample records.
//   2. Only a designer starts a change from it; the change holds every element and the roles; a second
//      start is refused, naming the open change.
//   3. Reviewed and approved like any change: live, and the home says so.
//   4. Its samples, through the record services as Sam: created, the action taken, a cycle closed
//      ({ ref, set }), audited as Sam; loading again adds nothing.
//   5. What it designed works: an input filled in from one filled in before it (the load's kiln, then
//      that kiln's first load); the button only where its condition holds; a screen with tabs.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/packs.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { loadSuites } from "../suites.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
let app = null;

try {
    const suites = await loadSuites({ dir: fileURLToPath(new URL("./fixtures/packs/", import.meta.url)) });
    const { KILN, LOAD, FIRE, SCREEN, GUIDE, CERT } = await import("./fixtures/packs/kiln/suite.mjs");
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, suites });
    const { url: mes } = await app.listen({ port: 0 });
    const people = ["olga", "sam", "quinn", "dana", "eli", "vera", "ivan", "ines"];
    const sessions = {};
    for (const user of people) {
        sessions[user] = `pk-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const key = () => `pk-${randomBytes(8).toString("hex")}`;

    // ---- 1. offered ----
    const home = await call("dana", "design.home", { as: "dana" });
    const pack = home.packs?.find((p) => p.suite === "kiln");
    step("offered on the designer's home: 5 new (2 objects, a script, a transaction, a screen), 2 roles (not the group that does not exist), 3 samples, a certification to list", pack && pack.counts.new === 5 && pack.counts.changed === 0 && pack.roles === 2 && pack.samples === 3 && pack.from === "Kiln" && pack.certifications === 1, pack);

    // ---- 2. a change from it ----
    const notHers = await call("olga", "design.fromPack", { suite: "kiln" });
    step("only a designer starts a change from it", notHers.status === 403, notHers);
    const started = await call("dana", "design.fromPack", { suite: "kiln" });
    const change = await call("dana", "design.change", { id: started.id, as: "dana" });
    const c = change.content ?? {};
    step("the change holds every element, the roles and the certification it suggests, titled with the pack's name and version", Object.keys(c.definitions ?? {}).sort().join() === [KILN, LOAD].sort().join() && c.transactions?.[FIRE] && c.screens?.[SCREEN] && Object.keys(c.scripts ?? {}).length === 1 && c.organization?.roles?.[KILN]?.operator?.includes("group:production") && !c.organization.roles[KILN].operator.includes("group:nowhere") && change.title === "Kiln designs 1.0.0" && !change.problems?.length && c.organization?.certifications?.[CERT]?.name === "Kiln firing", { title: change.title, problems: change.problems, kinds: Object.keys(c) });
    const again = await call("dana", "design.fromPack", { suite: "kiln" });
    step("a second start is refused, naming the open change", again.status === 409 && /Kiln designs 1\.0\.0/.test(again.error), again);

    // ---- 3. reviewed and approved ----
    const submitted = await call("dana", "design.submit", { id: started.id });
    await call("vera", "design.review", { id: started.id, decision: "pass" });
    let state = null;
    for (let round = 0; round < 4 && state !== "executed"; round++) {
        for (const user of people) {
            const seen = await call(user, "design.change", { id: started.id, as: user });
            for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id: started.id, department, decision: "approve", meaning: "Approved" })).state ?? state;
        }
    }
    const after = (await call("dana", "design.home", { as: "dana" })).packs.find((p) => p.suite === "kiln");
    step("submitted, reviewed, approved by everyone it reaches: live, and the home says all of it is live", submitted.ok && state === "executed" && after.counts.same === 5 && after.counts.new === 0 && after.roles === 0 && after.certifications === 0 && !after.open.length, { submitted, state, after });

    // ---- 4. samples ----
    const notShared = await call("olga", "design.samples", { suite: "kiln" });
    step("someone the designer is not shared with loads no samples", notShared.status === 403 || /not shared/.test(notShared.error ?? notShared.message ?? ""), notShared);
    const loaded = await call("sam", "design.samples", { suite: "kiln" });
    const kilns = await db.query(`SELECT id, state, data, created_by FROM mes.records WHERE object = $1`, [KILN]);
    const loads = await db.query(`SELECT id, state, data, created_by FROM mes.records WHERE object = $1 ORDER BY data->>'load_no'`, [LOAD]);
    step("samples through the record services as Sam: created, the action taken, the cycle closed", loaded.made === 3 && kilns.length === 1 && loads.length === 2 && loads.every((l) => l.created_by === "sam" && l.data.kiln === kilns[0].id) && loads[1].state === "fired" && kilns[0].data.first_load === loads[0].id, { loaded, kilns, loads });
    const twice = await call("sam", "design.samples", { suite: "kiln" });
    step("loading again adds nothing", twice.made === 0 && twice.there === 3, twice);
    const audited = await db.query("SELECT count(*)::int AS n FROM mes.audit_log WHERE object IN ($1, $2) AND actor = 'sam'", [KILN, LOAD]);
    step("…audited as Sam", audited[0].n >= 5, audited);

    // ---- 5. what it designed works ----
    const preview = await call("olga", "transactions.preview", { name: FIRE, input: { load: loads[0].id } });
    const noted = preview.changes?.find((ch) => ch.object === LOAD)?.fields?.note?.to;
    step("an input filled in from one filled in before it: the load's kiln, then that kiln's first load, read by a step", preview.status === undefined && noted === loads[0].data.load_no, preview);
    const screen = await call("olga", "screens.data", { name: SCREEN, as: "olga" });
    const row = screen.blocks?.[0]?.rows?.find((r) => r.id === loads[0].id);
    step("a screen's table carries what its row button's condition reads (pieces), unshown", row && row.pieces === 12 && !screen.blocks[0].fields.pieces, screen.blocks?.[0]);
    // The file the pack brings (§35.4): kept in the file store when the change was started, by the suite, and
    // shown by the screen's guide with its two steps on one page.
    const [kept] = await db.query("SELECT type, name, created_by FROM mes.blobs WHERE sha256 = $1", [GUIDE]);
    const guide = screen.blocks?.[3];
    step("the guide the pack brings is in the file store, kept by the suite under its name, and the screen shows it with its steps",
        kept?.type === "application/pdf" && kept.name === "Firing guide.pdf" && kept.created_by === "suite:kiln" && guide?.src === `/blob/${GUIDE}` && guide.steps?.map((x) => `${x.n}:${x.at}`).join() === "1:1,2:1", { kept, guide });
    const wrongTab = await call("dana", "design.check", { screens: { [SCREEN]: { name: SCREEN, label: "x", blocks: [{ block: "text", text: "x", tab: "" }], callers: { users: [], groups: [] }, stewards: ["production"] } } });
    step("a tab that is not a label is named", JSON.stringify(wrongTab).includes("a tab is a label"), wrongTab);
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
