// Signatures by two people (§7.4, Part 11 §11.50, §11.70, §11.200), end to end against a running server:
//   1. A transaction verified by a second person is designed (a verifier naming nobody, or a department
//      that is not, is refused in words), its scenario run in a sandbox with the verifier it names, approved.
//   2. Run with nobody beside the operator: refused. A second person signs in beside them with their
//      password (a wrong one refused, a third refused: two at most); one who may not verify is refused.
//   3. Quality signs in beside them: a wrong password, either one, refuses the run and writes nothing, and
//      counts towards that person's lock; both right, it runs, and the audit entry keeps both signatures.
//   4. Five wrong ones lock the verifier: the right one is refused too.
//   5. One who signs in through single sign-on sets a signing password and signs in beside with it; one
//      with a password of their own has none to set.
//   6. The first signing out ends both. A development instance (the picker) asks for no password, and who
//      verifies is checked all the same.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/dual-sign.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "../../../src/server/db.js";
import { createApp } from "../app.mjs";
import { hashPassword, LOCK_AFTER } from "../server/sign-in.js";
import { sessionKey } from "../server/store.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const NAME = `dual_move_${tag}`;
const PW = { olga: "olga's long password 1", quinn: "quinn's long password 2", sam: "sam's long password 3" };

const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, signIn: { passwords: true } });
const { url: mes } = await app.listen({ port: 0 });
let devApp = null;
const sessions = {};
const people = ["olga", "sam", "vera", "dana", "eli", "quinn", "ivan", "ines"];
for (const user of people) {
    sessions[user] = `ds-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const callAt = (base) => async (user, name, args) => {
    const res = await fetch(`${base}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status, body });
    return body;
};
const call = callAt(mes);
const attempt = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, status: error.status, message: error.message, fields: error.body?.fields, code: error.body?.code }));
const key = () => `ds-${randomBytes(8).toString("hex")}`;
const byTitle = async (object, field, value) => (await db.query(`SELECT id FROM mes.records WHERE object = $1 AND data->>$2 = $3`, [object, field, value]))[0]?.id;
const failures = async (id) => (await db.query("SELECT failures, locked_until FROM mes.sign_in_failures WHERE user_id = $1", [id]))[0] ?? { failures: 0, locked_until: null };

try {
    for (const [id, pw] of Object.entries(PW)) await db.query("INSERT INTO mes.credentials (user_id, hash) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET hash = $2", [id, await hashPassword(pw)]);
    await db.query("DELETE FROM mes.credentials WHERE user_id = 'vera'");
    await db.query("DELETE FROM mes.sign_in_failures WHERE user_id = ANY($1)", [Object.keys(PW)]);
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1002'");
    const newLot = async (no) => (await call("sam", "records.create", { object: "lot", data: { lot_no: `${no}-${tag}`, item: "PP-BLK-10", work_order: wo.id, qty: 50, uom: "kg" }, key: key() })).id;
    const lotState = async (id) => (await db.query("SELECT state FROM mes.records WHERE id = $1", [id]))[0]?.state;
    const press1 = await byTitle("machine", "machine_id", "M-101"), press2 = await byTitle("machine", "machine_id", "M-102");
    const scenarioLot = await newLot("DS-SC");

    // ---- 1. designed, its scenario verified in a sandbox, approved ----
    // Starting a lot, verified by Quality.
    const body = {
        name: NAME, label: `Start a lot, verified ${tag}`, description: "Starts a lot; Quality verifies it.",
        inputs: { lot: { label: "Lot", type: "ref", to: "lot", required: true } }, require: [], steps: [{ on: "lot", action: "start" }],
        confirm: true, callers: { users: [], groups: ["production"] }, stewards: ["production"],
        signature: { meaning: "Performed", verifier: { meaning: "Verified", departments: ["quality"] } },
        scenarios: [{ name: "verified by Quality", records: { lot: { object: "lot", where: { lot_no: `DS-SC-${tag}` } } },
            steps: [{ as: "olga", do: { transaction: NAME, input: { lot: "@lot" }, sign: { meaning: "Performed", agree: true, verifier: "quinn" } }, expect: { ok: true, states: { lot: "in_process" } } }] }],
    };
    const { id: change } = await call("dana", "design.start", { transaction: NAME, label: body.label });
    const nobody = await call("dana", "design.save", { id: change, reason: "Moving in is verified by Quality.", transactions: { [NAME]: { ...body, signature: { meaning: "Performed", verifier: { meaning: "Verified" } } } } });
    const nowhere = await call("dana", "design.save", { id: change, reason: "Moving in is verified by Quality.", transactions: { [NAME]: { ...body, signature: { meaning: "Performed", verifier: { meaning: "Verified", departments: ["nowhere"] } } } } });
    const saved = await call("dana", "design.save", { id: change, reason: "Moving in is verified by Quality.", transactions: { [NAME]: body } });
    const words = (r) => (r.problems ?? []).map((p) => p.message).join(" | ");
    const submitted = await attempt(call("dana", "design.submit", { id: change }));
    await attempt(call("vera", "design.review", { id: change, decision: "pass" }));
    let state = null;
    for (let round = 0; round < 4 && state !== "executed"; round++) for (const user of people) {
        const seen = await call(user, "design.change", { id: change, as: user }).catch(() => null);
        for (const department of seen?.can?.approveFor ?? []) state = (await call(user, "design.approve", { id: change, department, decision: "approve", meaning: "Approved" })).state ?? state;
    }
    step("a transaction a second person verifies is designed: a verifier naming nobody, or a department that is not, is refused in words; its scenario runs in a sandbox with the verifier it names (no password there); approved and live",
        /Say who may verify it/.test(words(nobody)) && /"nowhere" is not a department/.test(words(nowhere)) && !(saved.problems ?? []).length && submitted.ok && state === "executed",
        { nobody: words(nobody), nowhere: words(nowhere), saved: saved.problems, submitted, state });

    // ---- 2. nobody beside; a second person signs in; one who may not verify ----
    const lot1 = await newLot("DS-1");
    const sign = (extra = {}) => ({ meaning: "Performed", agree: true, password: PW.olga, secondPassword: PW.quinn, ...extra });
    const run = (lot, _machine, signature, as = "olga") => attempt(call(as, "transactions.run", { name: NAME, input: { lot }, key: key(), signature }));
    const alone = await run(lot1, press1, sign());
    const wrongJoin = await attempt(call("olga", "auth.second.join", { id: "sam", password: "not sam's password at all" }));
    const ghostJoin = await attempt(call("olga", "auth.second.join", { id: "nobody_here", password: "whatever it is here" }));
    const selfJoin = await attempt(call("olga", "auth.second.join", { id: "olga", password: PW.olga }));
    const samJoin = await attempt(call("olga", "auth.second.join", { id: "sam", password: PW.sam }));
    const third = await attempt(call("olga", "auth.second.join", { id: "quinn", password: PW.quinn }));
    const notQuality = await run(lot1, press1, sign({ secondPassword: PW.sam }));
    const left = await call("olga", "auth.second.leave", {});
    step("with nobody beside the operator, the run is refused: a second person signs in first; a wrong password, an unknown id, oneself are refused (alike for the first two); Sam signs in beside; a third is refused (two at most); Sam may not verify it (not Quality); Sam signs out",
        !alone.ok && alone.code === "transaction.verifier" && /needs a second person to verify it/.test(alone.message) &&
        !wrongJoin.ok && !ghostJoin.ok && wrongJoin.message === ghostJoin.message && /do not match/.test(wrongJoin.message) && !selfJoin.ok && /someone else/.test(selfJoin.message) &&
        samJoin.ok && samJoin.value.second.id === "sam" && !third.ok && /two at most/.test(third.message) &&
        !notQuality.ok && /Sam Lee may not verify .*department quality/.test(notQuality.message) && left.second === null,
        { alone, wrongJoin, ghostJoin, selfJoin, samJoin, third, notQuality, left });

    // ---- 3. Quality beside: wrong passwords refuse and write nothing; both right, it runs ----
    const qJoin = await call("olga", "auth.second.join", { id: "quinn", password: PW.quinn });
    const before = await failures("olga");
    const badMine = await run(lot1, press1, sign({ password: "olga's wrong password!" }));
    const afterMine = await failures("olga");
    const badTheirs = await run(lot1, press1, sign({ secondPassword: "quinn's wrong password" }));
    const noPw = await run(lot1, press1, sign({ password: "" }));
    const untouched = await lotState(lot1);
    const ok = await run(lot1, press1, sign());
    const [entry] = await db.query("SELECT actor, after FROM mes.audit_log WHERE object = '$transaction' AND action = $1 ORDER BY seq DESC LIMIT 1", [`run:${NAME}`]);
    const [joined] = await db.query("SELECT actor, after FROM mes.audit_log WHERE object = '$auth' AND action = 'second sign-in' AND actor = 'quinn' ORDER BY seq DESC LIMIT 1");
    const sig = entry?.after?.signature;
    step("Quality signs in beside: the operator's wrong password, or the verifier's, or none, refuses the run in words and writes nothing (a wrong one counts towards that person's lock); both right, it runs; its audit entry keeps both signatures, their names and meanings, with passwords; the second sign-in is audited",
        qJoin.second.id === "quinn" && !badMine.ok && /Your signature: the password is wrong/.test(badMine.message) && afterMine.failures === before.failures + 1 &&
        !badTheirs.ok && /Quinn Park's signature: the password is wrong/.test(badTheirs.message) && !noPw.ok && /enter the password/.test(noPw.message) && untouched === "created" &&
        ok.ok && (await lotState(lot1)) === "in_process" && sig?.by?.id === "olga" && sig.meaning === "Performed" && sig.verifier?.id === "quinn" && sig.verifier.meaning === "Verified" && sig.passwords === true && joined?.after?.beside === "olga" && (await failures("olga")).failures === 0,
        { badMine, afterMine, badTheirs, noPw, untouched, ok, sig, joined });

    // ---- 4. five wrong ones lock the verifier ----
    const lot2 = await newLot("DS-2");
    for (let i = 0; i < LOCK_AFTER; i++) await run(lot2, press2, sign({ secondPassword: `wrong ${i} for quinn here` }));
    const locked = await run(lot2, press2, sign());
    const lockRow = await failures("quinn");
    step(`${LOCK_AFTER} wrong passwords lock the verifier: the right one is refused too, in words, and nothing is written`,
        !locked.ok && /too many wrong passwords/.test(locked.message) && lockRow.locked_until && (await lotState(lot2)) === "created", { locked, lockRow });
    await db.query("DELETE FROM mes.sign_in_failures WHERE user_id = 'quinn'");
    await call("olga", "auth.second.leave", {});

    // ---- 5. a signing password, for one who signs in through single sign-on ----
    const short = await attempt(call("vera", "auth.signingPassword", { next: "short", again: "short" }));
    const set = await call("vera", "auth.signingPassword", { next: "a signing password to keep", again: "a signing password to keep" });
    const noCurrent = await attempt(call("vera", "auth.signingPassword", { next: "another long one for vera", again: "another long one for vera" }));
    const olgaHasOwn = await attempt(call("olga", "auth.signingPassword", { next: "olga does not need this", again: "olga does not need this" }));
    const veraWrong = await attempt(call("olga", "auth.second.join", { id: "vera", password: "not vera's signing pw" }));
    const veraJoin = await attempt(call("olga", "auth.second.join", { id: "vera", password: "a signing password to keep" }));
    const account = await call("vera", "auth.account", {});
    step("one with no password of their own sets a signing password (too short refused; changing it needs the current one); one with their own has none to set; they sign in beside with it, a wrong one refused",
        !short.ok && /at least 12/.test(short.message) && set.ok && !noCurrent.ok && /current signing password is wrong/.test(noCurrent.message) && !olgaHasOwn.ok && olgaHasOwn.status === 409 &&
        !veraWrong.ok && veraJoin.ok && veraJoin.value.second.id === "vera" && account.signing === true && account.password === false,
        { short, set, noCurrent, olgaHasOwn, veraWrong, veraJoin, account });

    // ---- 6. the first signs out, both are out; a development instance asks for no password ----
    const out = await fetch(`${mes}/logout`, { method: "POST", redirect: "manual", headers: { cookie: `mes_session=${sessions.olga}`, origin: mes, "content-type": "application/x-www-form-urlencoded" }, body: "" });
    const [gone] = await db.query("SELECT 1 FROM mes.sessions WHERE id = $1", [sessionKey(sessions.olga)]);
    sessions.olga = `ds-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, 'olga', now() + interval '1 hour')", [sessions.olga]);
    devApp = await createApp({ db, dev: true, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    const { url: dev } = await devApp.listen({ port: 0 });
    const devCall = callAt(dev);
    const lot3 = await newLot("DS-3");
    const devSam = await attempt(devCall("olga", "auth.second.join", { id: "sam" }));
    const devNot = await attempt(devCall("olga", "transactions.run", { name: NAME, input: { lot: lot3 }, key: key(), signature: { meaning: "Performed", agree: true } }));
    await devCall("olga", "auth.second.leave", {});
    const devQ = await attempt(devCall("olga", "auth.second.join", { id: "quinn" }));
    const devRun = await attempt(devCall("olga", "transactions.run", { name: NAME, input: { lot: lot3 }, key: key(), signature: { meaning: "Performed", agree: true } }));
    const [devEntry] = await db.query("SELECT after FROM mes.audit_log WHERE object = '$transaction' AND action = $1 ORDER BY seq DESC LIMIT 1", [`run:${NAME}`]);
    step("the first signing out ends the session, and the second with it; a development instance (the picker) asks for no password: Sam beside may not verify it, Quinn may, and the entry says no password was asked",
        out.status === 303 && !gone && devSam.ok && !devNot.ok && /may not verify/.test(devNot.message) && devQ.ok && devRun.ok && devEntry?.after?.signature?.verifier?.id === "quinn" && devEntry.after.signature.passwords === false,
        { out: out.status, gone, devSam, devNot, devQ, devRun, devSig: devEntry?.after?.signature });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await db.query("DELETE FROM mes.credentials WHERE user_id = ANY($1)", [Object.keys(PW)]).catch(() => {});
    await db.query("DELETE FROM mes.signing_credentials WHERE user_id = 'vera'").catch(() => {});
    await db.query("DELETE FROM mes.sign_in_failures WHERE user_id = ANY($1)", [[...Object.keys(PW), "vera"]]).catch(() => {});
    await app.close?.().catch(() => {});
    await devApp?.close?.().catch(() => {});
    await pool.end();
}
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok || s.detail === undefined ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
const failed = steps.filter((s) => !s.ok).length;
console.log(failed ? `\n${failed} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
