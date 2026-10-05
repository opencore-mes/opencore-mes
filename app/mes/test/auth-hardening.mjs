// Sign-in hardened (§8.2, §7.4: Part 11 §11.200 and §11.300; SOC 2 CC6.1, ISO 27001 A.8.5), end to end
// against running servers and the SSO simulator (app/mes/sso-sim.mjs), with a browser's cookies:
//   1. Sessions are kept by the SHA-256 of their id: the database never holds what the browser does.
//   2. A password may not repeat one of the last few; one past its age must be changed at sign-in.
//   3. A second factor (an authenticator app): set up from the account, asked after the password, good
//      once per code; a recovery code signs in once. Where the plant requires one, a sign-in without it
//      sets it up first.
//   4. A session idle past the limit ends; activity keeps it, and does not bring back one ended.
//   5. Tokens expire, and issuing and revoking one is in the audit trail.
//   6. Lockouts: in the event log, and in a sign-in administrator's inbox and page; wrong passwords over
//      many ids are told. The administrator issues a link, takes off a second factor, lifts a lock, ends
//      sessions; someone else may not.
//   7. Signatures: a transaction signed by one asks the signer's password; a change approval does too,
//      or a fresh single sign-on made just before (only by that person, once, for a few minutes).
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/auth-hardening.mjs   (after a reset)
import pg from "pg";
import { createHash, randomBytes } from "node:crypto";
import { fromPg } from "../../../src/server/db.js";
import { createApp } from "../app.mjs";
import { hashPassword, hotp, timeStep, LOCK_AFTER, SPRAY } from "../server/sign-in.js";
import { startSsoSimulator } from "../sso-sim.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const sha = (t) => createHash("sha256").update(t).digest("hex");
// (Never containing the sign-in id, which a password may not.)
const PW = (who, n = 1) => `quiet harbour ${n} ${tag} ${[...who].reverse().join("")}`;
let sim = null, strict = null, plain = null, required = null;
const events = [];

// ---- a browser: cookies per host, redirects followed by hand ----
function browser() {
    const jar = new Map();
    const cookiesFor = (url) => [...(jar.get(new URL(url).host) ?? new Map())].map(([k, v]) => `${k}=${v}`).join("; ");
    const keep = (url, res) => {
        const host = new URL(url).host;
        if (!jar.has(host)) jar.set(host, new Map());
        for (const c of res.headers.getSetCookie?.() ?? []) {
            const [pair, ...attrs] = c.split(";");
            const [k, ...v] = pair.trim().split("=");
            if (attrs.some((a) => /max-age=0\b/i.test(a.trim()))) jar.get(host).delete(k); else jar.get(host).set(k, v.join("="));
        }
    };
    const go = async (url, { method = "GET", form = null } = {}) => {
        const res = await fetch(url, { method, redirect: "manual", headers: { cookie: cookiesFor(url), origin: new URL(url).origin, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined });
        keep(url, res);
        const location = res.headers.get("location");
        return { status: res.status, location: location ? new URL(location, url).href : null, text: await res.text() };
    };
    return {
        jar, go,
        cookie: (host, name) => jar.get(host)?.get(name) ?? null,
        // Every redirect followed, stopping when a page answers (or `until` says the URL is far enough).
        async follow(url, opts = {}, until = () => false) { let r = await go(url, opts); let n = 0; while (r.location && !until(r.location) && n++ < 10) r = await go(r.location); return r; },
        api: async (base, name, args = {}) => {
            const res = await fetch(`${base}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: cookiesFor(base) }, body: JSON.stringify([args]) });
            const body = await res.json().catch(() => ({}));
            return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
        },
    };
}
const hidden = (html) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"')]));
const codeNow = (secret) => hotp(secret, timeStep());
const codeNext = (secret) => hotp(secret, timeStep() + 1);

try {
    const users = ["olga", "sam", "quinn", "dana", "eli", "vera", "ivan", "ines", "iris"].map((id) => ({ id, name: id }));
    sim = await startSsoSimulator({ port: 0, users, password: `sso ${tag}` });
    const policy = { passwords: true, sso: { issuer: sim.issuer, clientId: "open-mes" }, signWithPassword: true, passwordMaxDays: 90, passwordHistory: 3, mfa: "optional", idleMinutes: 30 };
    const fakeEvents = { emit: (kind, e) => events.push({ kind, ...e }), flush: async () => 0, state: () => ({}), start() {}, stop() {} };
    // (Plain HTTP here: the callback single sign-on returns to is this server's own, http.)
    strict = await createApp({ db, dev: false, secure: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, signIn: policy, events: fakeEvents });
    const S = (await strict.listen({ port: 0 })).url;
    plain = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, signIn: { passwords: true } });
    const P = (await plain.listen({ port: 0 })).url;
    required = await createApp({ db, dev: false, secure: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, signIn: { ...policy, mfa: "required" } });
    const R = (await required.listen({ port: 0 })).url;
    const host = new URL(S).host;
    for (const id of ["olga", "eli", "ivan", "sam", "quinn", "ines", "iris"]) {
        await db.query("INSERT INTO mes.credentials (user_id, hash) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET hash = $2, set_at = now()", [id, await hashPassword(PW(id))]);
        await db.query("DELETE FROM mes.password_history WHERE user_id = $1; ", [id]).catch(() => {});
    }
    // Dana and Vera sign in through single sign-on only.
    await db.query("DELETE FROM mes.credentials WHERE user_id = ANY($1)", [["dana", "vera"]]);
    await db.query("DELETE FROM mes.mfa WHERE user_id = ANY($1)", [users.map((u) => u.id)]);
    await db.query("DELETE FROM mes.sign_in_failures");
    const signIn = async (base, id, password, b = browser()) => ({ b, r: await b.go(`${base}/login`, { method: "POST", form: { user: id, password } }) });

    // ---- 1. sessions hashed ----
    const { b: olga, r: olgaIn } = await signIn(S, "olga", PW("olga"));
    const sid = olga.cookie(host, "mes_session");
    const [row] = await db.query("SELECT id FROM mes.sessions WHERE id = $1", [sha(sid)]);
    const [raw] = await db.query("SELECT id FROM mes.sessions WHERE id = $1", [sid]);
    const me = await olga.api(S, "auth.account");
    step("a session is kept by the SHA-256 of its id: the database never holds what the browser does, and the browser's id still signs it in",
        olgaIn.status === 303 && sid && row && !raw && me.id === "olga", { olgaIn, sid: Boolean(sid), row, raw, me });

    // ---- 2. password history and age ----
    const same = await olga.go(`${S}/password`, { method: "POST", form: { current: PW("olga"), next: PW("olga"), again: PW("olga") } });
    const changed = await olga.go(`${S}/password`, { method: "POST", form: { current: PW("olga"), next: PW("olga", 2), again: PW("olga", 2) } });
    const back = await olga.go(`${S}/password`, { method: "POST", form: { current: PW("olga", 2), next: PW("olga"), again: PW("olga") } });
    step("a new password may not be the one in use, nor one of the last few; a new one is taken", /e=reused/.test(same.location ?? "") && /m=changed/.test(changed.location ?? "") && /e=reused/.test(back.location ?? ""), { same: same.location, changed: changed.location, back: back.location });
    await db.query("UPDATE mes.credentials SET set_at = now() - interval '100 days' WHERE user_id = 'olga'");
    const { b: aged, r: agedIn } = await signIn(S, "olga", PW("olga", 2));
    const noSessionYet = !aged.cookie(host, "mes_session");
    const agedReuse = await aged.go(`${S}/login/expired`, { method: "POST", form: { next: PW("olga", 2), again: PW("olga", 2) } });
    const agedNew = await aged.go(`${S}/login/expired`, { method: "POST", form: { next: PW("olga", 3), again: PW("olga", 3) } });
    const agedMe = await aged.api(S, "auth.account");
    step("a password past its age must be changed at sign-in, not to one used before; then the sign-in completes",
        /step=expired/.test(agedIn.location ?? "") && noSessionYet && /step=expired&e=reused/.test(agedReuse.location ?? "") && agedNew.status === 303 && agedMe.id === "olga" && agedMe.expired === false,
        { agedIn: agedIn.location, agedReuse: agedReuse.location, agedNew: agedNew.location, agedMe });

    // ---- 3. a second factor ----
    const setup = await aged.api(S, "auth.mfa.start");
    const badConfirm = await aged.api(S, "auth.mfa.confirm", { code: "000000" });
    const goodConfirm = await aged.api(S, "auth.mfa.confirm", { code: codeNow(setup.secret) });
    const { b: two, r: twoIn } = await signIn(S, "olga", PW("olga", 3));
    const wrongCode = await two.go(`${S}/login/code`, { method: "POST", form: { code: "123456" } });
    const used = await two.go(`${S}/login/code`, { method: "POST", form: { code: codeNow(setup.secret) } });
    const nextCode = await two.go(`${S}/login/code`, { method: "POST", form: { code: codeNext(setup.secret) } });
    const { b: rec } = await signIn(S, "olga", PW("olga", 3));
    const byRecovery = await rec.go(`${S}/login/code`, { method: "POST", form: { code: setup.codes[0] } });
    const { b: rec2 } = await signIn(S, "olga", PW("olga", 3));
    const recoveryAgain = await rec2.go(`${S}/login/code`, { method: "POST", form: { code: setup.codes[0] } });
    step("an authenticator set up from the account (a wrong code refused); a password sign-in then asks its code: a wrong one refused, a code taken once (the one confirming it no longer works), a recovery code good once",
        setup.secret && setup.codes?.length === 10 && badConfirm.status >= 400 && goodConfirm.ok && /step=code/.test(twoIn.location ?? "") && /e=code/.test(wrongCode.location ?? "")
        && /e=code/.test(used.location ?? "") && nextCode.status === 303 && !/login/.test(nextCode.location ?? "") && two.cookie(host, "mes_session") && byRecovery.status === 303 && rec.cookie(host, "mes_session") && /e=code/.test(recoveryAgain.location ?? ""),
        { twoIn: twoIn.location, wrongCode: wrongCode.location, used: used.location, nextCode: nextCode.location, byRecovery: byRecovery.location, recoveryAgain: recoveryAgain.location });
    const { b: enrol, r: enrolIn } = await signIn(R, "eli", PW("eli"));
    const shown = await enrol.go(`${R}/login/enroll`);
    const secret = JSON.parse(shown.text).secret;
    const enrolled = await enrol.go(`${R}/login/enroll`, { method: "POST", form: { code: codeNow(secret) } });
    const [eliMfa] = await db.query("SELECT enabled_at FROM mes.mfa WHERE user_id = 'eli'");
    step("where the plant requires a second factor, a sign-in without one sets it up first (its key and recovery codes shown), then completes",
        /step=enroll/.test(enrolIn.location ?? "") && secret && JSON.parse(shown.text).codes.length === 10 && enrolled.status === 303 && enrol.cookie(new URL(R).host, "mes_session") && eliMfa?.enabled_at,
        { enrolIn: enrolIn.location, shown: shown.status, enrolled: enrolled.location });

    // ---- 4. idle ----
    const idleSid = two.cookie(host, "mes_session");
    const active = await two.api(S, "auth.active");
    await db.query("UPDATE mes.sessions SET last_seen = now() - interval '31 minutes' WHERE id = $1", [sha(idleSid)]);
    const idleCall = await two.api(S, "auth.account");
    const revived = await two.api(S, "auth.active");
    const idleAgain = await two.api(S, "auth.account");
    step("a session idle past the plant's limit ends; activity keeps one going, and does not bring back one ended", active.ok && idleCall.status === 401 && revived.ok === false && idleAgain.status === 401, { active, idleCall, revived, idleAgain });

    // ---- 5. tokens ----
    const { b: iris } = await signIn(S, "iris", PW("iris"));
    const issued = await iris.api(S, "ai.token.create", { name: `test ${tag}`, agent: "Claude", scopes: ["design:read"], days: 30 });
    const meOk = await fetch(`${S}/ai/v1/me`, { headers: { authorization: `Bearer ${issued.token}` } });
    await db.query("UPDATE mes.api_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1", [issued.id]);
    const meGone = await fetch(`${S}/ai/v1/me`, { headers: { authorization: `Bearer ${issued.token}` } });
    const revoked = await iris.api(S, "ai.token.revoke", { id: issued.id });
    const [issuedAudit] = await db.query("SELECT actor, after FROM mes.audit_log WHERE object = '$auth' AND action = 'token issued' AND after->>'token' = $1", [issued.id]);
    const [revokedAudit] = await db.query("SELECT actor FROM mes.audit_log WHERE object = '$auth' AND action = 'token revoked' AND after->>'token' = $1", [issued.id]);
    const days = (new Date(issued.expires_at) - Date.now()) / 86400_000;
    step("a token lasts the days asked (and answers nobody once they are past); issuing and revoking it are in the audit trail",
        Math.abs(days - 30) < 0.1 && meOk.status === 200 && meGone.status === 401 && revoked.ok && issuedAudit?.actor === "iris" && issuedAudit.after.scopes?.[0] === "design:read" && revokedAudit?.actor === "iris",
        { days, meOk: meOk.status, meGone: meGone.status, issuedAudit, revokedAudit });

    // ---- 6. lockouts, alerts, administration ----
    const sprayFrom = new Date();
    for (let i = 0; i < LOCK_AFTER; i++) await signIn(S, "ivan", "wrong password");
    const lockedEvent = events.find((e) => e.kind === "auth.locked" && e.details?.user === "ivan");
    for (let i = 0; i < SPRAY.ids; i++) await signIn(S, `nobody${i}x${tag}`, "Summer2026!");
    const alerts = await iris.api(S, "auth.admin.alerts");
    const inbox = await iris.api(S, "inbox.mine", { as: "iris" });
    const { b: quinnB } = await signIn(S, "quinn", PW("quinn"));
    const notAdmin = await quinnB.api(S, "auth.admin.people", { q: "ivan" });
    const people = await iris.api(S, "auth.admin.people", { q: "ivan" });
    const unlocked = await iris.api(S, "auth.admin.unlock", { id: "ivan" });
    const { b: ivanB, r: ivanIn } = await signIn(S, "ivan", PW("ivan"));
    void ivanB;
    const link = await iris.api(S, "auth.admin.link", { id: "sam", hours: 24 });
    const [linkAudit] = await db.query("SELECT actor FROM mes.audit_log WHERE object = '$auth' AND action = 'password link' AND after->>'user' = 'sam' ORDER BY seq DESC LIMIT 1");
    const noReason = await iris.api(S, "auth.admin.resetMfa", { id: "olga" });
    const reset = await iris.api(S, "auth.admin.resetMfa", { id: "olga", reason: "A lost phone." });
    const [olgaMfa] = await db.query("SELECT 1 FROM mes.mfa WHERE user_id = 'olga'");
    const ended = await iris.api(S, "auth.admin.endSessions", { id: "olga" });
    const olgaAfter = await rec.api(S, "auth.account");
    step("a lockout is in the event log; a sign-in administrator's page and inbox tell it, and wrong passwords over many ids; who is not one may not look",
        lockedEvent?.severity === "warning" && alerts.locks?.some((l) => l.id === "ivan") && alerts.spray?.ids >= SPRAY.ids && inbox.items?.some((x) => x.id === "auth:locked:ivan") && inbox.items.some((x) => x.id === "auth:spray")
        && notAdmin.status === 403 && people[0]?.id === "ivan" && people[0].lockedUntil, { lockedEvent, alerts, inbox: inbox.items?.map((x) => x.id), notAdmin, people: people[0], sprayFrom });
    step("the administrator lifts the lock (ivan signs in), issues a password link (audited by them), takes off a second factor with a reason, and ends someone's sessions",
        unlocked.ok && ivanIn.status === 303 && !/login/.test(ivanIn.location ?? "") && /^\/password\?token=/.test(link.path ?? "") && linkAudit?.actor === "iris" && noReason.status >= 400 && reset.ok && !olgaMfa && ended.ended >= 1 && olgaAfter.status === 401,
        { unlocked, ivanIn: ivanIn.location, link, linkAudit, noReason, reset, ended, olgaAfter });

    // ---- 7. signatures ----
    // A signed transaction (one signer) and a change to approve, designed on the plain instance.
    const NAME = `signed_start_${tag}`;
    const sess = {};
    for (const u of ["dana", "vera", "eli", "sam", "quinn", "ivan", "ines", "olga", "iris"]) {
        sess[u] = `ah-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sess[u], u]);
    }
    const as = (base) => async (u, name, args) => { const res = await fetch(`${base}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sess[u]}` }, body: JSON.stringify([args]) }); const body = await res.json().catch(() => ({})); return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields }; };
    const onPlain = as(P), onStrict = as(S);
    const body = {
        name: NAME, label: `Start a lot, signed ${tag}`, description: "Starts a lot, signed by the operator.",
        inputs: { lot: { label: "Lot", type: "ref", to: "lot", required: true } }, require: [], steps: [{ on: "lot", action: "start" }],
        confirm: true, callers: { users: [], groups: ["production"] }, stewards: ["production"], signature: { meaning: "Performed" },
        scenarios: [{ name: "a lot started, signed", records: { lot: { object: "lot", where: { lot_no: `AH-SC-${tag}` } } }, steps: [{ as: "olga", do: { transaction: NAME, input: { lot: "@lot" }, sign: { meaning: "Performed", agree: true } }, expect: { ok: true, states: { lot: "in_process" } } }] }],
    };
    const [wo0] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1002'");
    await onPlain("sam", "records.create", { object: "lot", data: { lot_no: `AH-SC-${tag}`, item: "PP-BLK-10", work_order: wo0.id, qty: 10, uom: "kg" }, key: `ah-${tag}-sc` });
    const approveAll = async (call, id, sign = () => ({})) => {
        let state = null;
        for (let round = 0; round < 4 && state !== "executed"; round++) for (const u of Object.keys(sess)) {
            const seen = await call(u, "design.change", { id, as: u });
            for (const department of seen?.can?.approveFor ?? []) { const r = await call(u, "design.approve", { id, department, decision: "approve", meaning: "Approved", signature: sign(u) }); state = r.state ?? state; }
        }
        return state;
    };
    const { id: first } = await onPlain("dana", "design.start", { transaction: NAME, label: body.label });
    await onPlain("dana", "design.save", { id: first, reason: "A lot started is signed.", transactions: { [NAME]: body } });
    await onPlain("dana", "design.submit", { id: first });
    await onPlain("vera", "design.review", { id: first, decision: "pass" });
    const firstState = await approveAll(onPlain, first);
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1002'");
    const lot = (await onPlain("sam", "records.create", { object: "lot", data: { lot_no: `AH-${tag}`, item: "PP-BLK-10", work_order: wo.id, qty: 10, uom: "kg" }, key: `ah-${tag}-lot` })).id;
    const noPw = await onStrict("olga", "transactions.run", { name: NAME, input: { lot }, key: `ah-${tag}-1`, signature: { meaning: "Performed", agree: true } });
    const wrongPw = await onStrict("olga", "transactions.run", { name: NAME, input: { lot }, key: `ah-${tag}-2`, signature: { meaning: "Performed", agree: true, password: "not it" } });
    const signedRun = await onStrict("olga", "transactions.run", { name: NAME, input: { lot }, key: `ah-${tag}-3`, signature: { meaning: "Performed", agree: true, password: PW("olga", 3) } });
    const [runAudit] = await db.query("SELECT after FROM mes.audit_log WHERE object = '$transaction' AND action = $1 ORDER BY seq DESC LIMIT 1", [`run:${NAME}`]);
    step("a transaction signed by one asks the signer's password: none, or a wrong one, refuses it in words; the right one runs it, the run's audit keeping who signed and how",
        firstState === "executed" && noPw.status >= 400 && /enter the password/.test(noPw.error ?? "") && /password is wrong/.test(wrongPw.error ?? "") && signedRun.ok && runAudit?.after.signature?.by?.id === "olga" && runAudit.after.signature.method === "password",
        { firstState, noPw, wrongPw, signedRun, signature: runAudit?.after.signature });

    // A change approved on the strict instance: a password, or a fresh single sign-on.
    const { id: second } = await onPlain("dana", "design.start", { transaction: NAME });
    await onPlain("dana", "design.save", { id: second, reason: "Its label, clearer.", transactions: { [NAME]: { ...body, label: `Start a lot, signed by its operator ${tag}` } } });
    await onPlain("dana", "design.submit", { id: second });
    await onPlain("iris", "design.review", { id: second, decision: "pass" });
    const waiting = [];
    for (const u of Object.keys(sess)) { const seen = await onStrict(u, "design.change", { id: second, as: u }); for (const d of seen?.can?.approveFor ?? []) waiting.push({ u, d }); }
    const signer = waiting[0];
    const unsigned = await onStrict(signer.u, "design.approve", { id: second, department: signer.d, decision: "approve", meaning: "Approved" });
    // The approver signs in through the simulator (no password of theirs here), then signs in again there
    // for this approval.
    await db.query("DELETE FROM mes.credentials WHERE user_id = $1", [signer.u]);
    const ssoB = browser();
    const ssoIn = await ssoB.follow(`${S}/login/sso`);
    const signInPage = await ssoB.go(`${sim.issuer}/authorize`, { method: "POST", form: { ...hidden(ssoIn.text), username: signer.u, password: `sso ${tag}` } });
    const ssoSession = await ssoB.follow(signInPage.location);
    const again = await ssoB.follow(`${S}/login/sso/again?who=me`);
    const fresh = again.text.includes('name="username"');
    const someoneElse = await ssoB.go(`${sim.issuer}/authorize`, { method: "POST", form: { ...hidden(again.text), username: "vera", password: `sso ${tag}` } });
    const elseDone = await ssoB.follow(someoneElse.location);
    const again2 = await ssoB.follow(`${S}/login/sso/again?who=me`);
    const asThem = await ssoB.go(`${sim.issuer}/authorize`, { method: "POST", form: { ...hidden(again2.text), username: signer.u, password: `sso ${tag}` } });
    const themDone = await ssoB.follow(asThem.location);
    const [reauth] = await db.query("SELECT user_id FROM mes.session_reauth WHERE session_id = $1", [sha(ssoB.cookie(host, "mes_session") ?? "")]);
    step("a fresh single sign-on for a signature: the provider asks again whatever it remembers (prompt=login); signing in there as someone else is refused; as themselves, it is kept for this session and person",
        ssoSession.status === 200 && ssoB.cookie(host, "mes_session") && fresh && /data-ok="0"/.test(elseDone.text) && new RegExp(`not ${signer.u}`).test(elseDone.text) && /data-ok="1"/.test(themDone.text) && reauth?.user_id === signer.u && sim.calls.some((c) => c.query.prompt === "login" && c.query.max_age === "0"),
        { ssoSession: ssoSession.status, fresh, elseDone: elseDone.text.slice(-200), themDone: themDone.text.slice(-200), reauth });
    const ssoApproved = await ssoB.api(S, "design.approve", { id: second, department: signer.d, decision: "approve", meaning: "Approved", signature: { sso: true } });
    const [approvedAudit] = await db.query("SELECT after FROM mes.audit_log WHERE action = 'change:approve' AND actor = $1 ORDER BY seq DESC LIMIT 1", [signer.u]);
    // Spent: the next signature asks for another.
    const lot2 = (await onPlain("sam", "records.create", { object: "lot", data: { lot_no: `AH2-${tag}`, item: "PP-BLK-10", work_order: wo.id, qty: 10, uom: "kg" }, key: `ah-${tag}-lot2` })).id;
    const spent = await ssoB.api(S, "transactions.run", { name: NAME, input: { lot: lot2 }, key: `ah-${tag}-4`, signature: { meaning: "Performed", agree: true, sso: true } });
    step("a change approval asks the signer to prove who they are: without it refused; with a fresh single sign-on, signed (its printed name and how kept in the trail); spent by that signature, the next one asks again",
        /enter the password/i.test(unsigned.error ?? "") && !ssoApproved.error && approvedAudit?.after.printedName && approvedAudit.after.method === "sso"
        && spent.status >= 400 && /sign in again with single sign-on first/.test(spent.error ?? ""),
        { unsigned, signer, ssoApproved, approvedAudit: approvedAudit?.after, spent });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    for (const a of [strict, plain, required]) await a?.close?.().catch(() => {});
    await sim?.stop().catch(() => {});
    await pool.end();
}
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok || s.detail === undefined ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
const failed = steps.filter((s) => !s.ok).length;
console.log(failed ? `\n${failed} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
