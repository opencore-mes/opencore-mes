// Sign-in (§8.2), end to end against a running server, with a stand-in for the plant's identity provider
// (OpenID Connect) and for its directory (LDAP):
//   1. The sign-in page offers what is turned on, and no picker in production: a sign-in without a
//      password is refused, and a form from another site is.
//   2. A one-time link sets a password: too short, or not twice the same, is said; used once, it is spent.
//   3. A password signs in; five wrong ones lock the sign-in id for a while, the right one included.
//   4. Someone without a password here signs in through the directory; one the directory knows but
//      People & departments does not is refused, and an empty password never reaches the directory.
//   5. Single sign-on: authorization code with PKCE, the ID token checked; a callback in another browser,
//      a token for another client, and a person not in People & departments are refused.
//   6. A person changes their own password: their other sessions end. Every step is in the audit trail.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/auth.mjs   (after a reset)
import pg from "pg";
import http from "node:http";
import net from "node:net";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { fromPg } from "../../../src/server/db.js";
import { createApp } from "../app.mjs";
import { issuePasswordLink, berRead, LOCK_AFTER } from "../server/sign-in.js";
import { verifyAudit } from "../server/audit.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
let app = null, idp = null, ldap = null;
const started = new Date();

// ---- the plant's directory: binds as uid=<id>,ou=people,dc=test ----
const DIRECTORY = { "uid=eli,ou=people,dc=test": "eli's directory password", "uid=zed,ou=people,dc=test": "zed's directory password" };
const binds = [];
ldap = net.createServer((socket) => {
    let data = Buffer.alloc(0);
    socket.on("data", (chunk) => {
        data = Buffer.concat([data, chunk]);
        const msg = berRead(data);
        if (!msg) return;
        const id = berRead(data, msg.start), op = berRead(data, id.end);
        if (op.tag !== 0x60) { data = data.subarray(msg.end); return; } // an unbind
        const version = berRead(data, op.start), dn = berRead(data, version.end), pw = berRead(data, dn.end);
        const name = data.toString("utf8", dn.start, dn.end), password = data.toString("utf8", pw.start, pw.end);
        binds.push({ name, empty: !password });
        const code = DIRECTORY[name] && DIRECTORY[name] === password ? 0 : 49;
        // BindResponse: resultCode, matchedDN "", diagnosticMessage "".
        socket.write(Buffer.from([0x30, 0x0c, 0x02, 0x01, data[id.start], 0x61, 0x07, 0x0a, 0x01, code, 0x04, 0x00, 0x04, 0x00]));
        data = data.subarray(msg.end);
    });
    socket.on("error", () => {});
});
await new Promise((r) => ldap.listen(0, "127.0.0.1", r));

// ---- the plant's identity provider ----
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
const codes = new Map();
let nextUser = "dana", nextAudience = "mes";
idp = http.createServer(async (req, res) => {
    const u = new URL(req.url, issuer);
    const json = (body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (u.pathname === "/.well-known/openid-configuration") return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    if (u.pathname === "/jwks") return json({ keys: [jwk] });
    if (u.pathname === "/authorize") {
        // Signed in at the provider already: straight back with a code.
        const code = randomBytes(12).toString("hex");
        codes.set(code, { user: nextUser, aud: nextAudience, nonce: u.searchParams.get("nonce"), challenge: u.searchParams.get("code_challenge"), method: u.searchParams.get("code_challenge_method"), redirect: u.searchParams.get("redirect_uri"), client: u.searchParams.get("client_id") });
        res.writeHead(302, { location: `${u.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(u.searchParams.get("state"))}` });
        return res.end();
    }
    if (u.pathname === "/token" && req.method === "POST") {
        let body = "";
        for await (const c of req) body += c;
        const form = new URLSearchParams(body);
        const grant = codes.get(form.get("code"));
        codes.delete(form.get("code"));
        const basic = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
        const verifier = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (!grant || basic !== "mes:idp-secret" || grant.method !== "S256" || verifier !== grant.challenge || form.get("redirect_uri") !== grant.redirect) return json({ error: "invalid_grant" }, 400);
        const now = Math.floor(Date.now() / 1000);
        const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
        const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: grant.aud, sub: `sub-${grant.user}`, preferred_username: grant.user, nonce: grant.nonce, iat: now, exp: now + 300 })).toString("base64url");
        const sig = sign("sha256", Buffer.from(`${head}.${claims}`), privateKey).toString("base64url");
        return json({ id_token: `${head}.${claims}.${sig}`, access_token: "x", token_type: "Bearer" });
    }
    res.writeHead(404).end();
});
await new Promise((r) => idp.listen(0, "127.0.0.1", r));
const issuer = `http://127.0.0.1:${idp.address().port}`;

try {
    app = await createApp({
        db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, secure: false,
        signIn: { picker: false, passwords: true, ldap: { url: `ldap://127.0.0.1:${ldap.address().port}`, userDn: "uid={user},ou=people,dc=test", label: "the plant directory" }, sso: { issuer, clientId: "mes", clientSecret: "idp-secret", label: "Plant SSO" } },
    });
    const { url: mes } = await app.listen({ port: 0 });
    const cookieOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("mes_session=") && c !== "mes_session=") ?? null;
    const post = (path, fields, { cookie, origin = mes } = {}) => fetch(`${mes}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString() });
    const call = async (name, args, cookie) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify([args ?? {}]) });
        return res.ok ? res.json() : { status: res.status };
    };
    const where = (res) => res.headers.get("location") ?? "";
    await db.query("DELETE FROM mes.credentials WHERE user_id IN ('olga', 'eli', 'sam')");
    await db.query("DELETE FROM mes.sign_in_failures");

    // ---- 1. what is offered ----
    const methods = await call("auth.methods");
    const users = await call("auth.users");
    const page = await (await fetch(`${mes}/login`)).text();
    step("the sign-in page offers single sign-on, the directory and passwords, and no picker in production",
        methods.sso === "Plant SSO" && methods.directory === "the plant directory" && methods.password && !methods.picker && Array.isArray(users) && users.length === 0 && /Sign in with Plant SSO/.test(page) && /name="password"/.test(page), { methods, users, page: page.length });
    const picked = await post("/login", { user: "olga" });
    const foreign = await post("/login", { user: "olga", password: "whatever" }, { origin: "https://elsewhere.example" });
    step("a sign-in without a password is refused, and so is a form from another site", picked.status === 303 && where(picked).startsWith("/login?e=wrong") && !cookieOf(picked) && foreign.status === 403, { picked: where(picked), foreign: foreign.status });

    // ---- 2. a password set through a one-time link ----
    const { token, path } = await issuePasswordLink(db, "olga", { by: "it:test" });
    const setPage = await fetch(`${mes}${path}`);
    const setHtml = await setPage.text();
    const short = await post("/password", { token, next: "short", again: "short" });
    const twice = await post("/password", { token, next: "a long new password one", again: "a long new password two" });
    const OLGA = "correct horse battery staple";
    const set = await post("/password", { token, next: OLGA, again: OLGA });
    const again = await post("/password", { token, next: `${OLGA}!`, again: `${OLGA}!` });
    step("a one-time link sets a password: too short and not the same twice are said, and once used it is spent",
        setPage.status === 200 && /Set your password/.test(setHtml) && where(short).includes("e=short") && where(twice).includes("e=again") && where(set) === "/login?m=password" && where(again) === "/password?e=link", { status: setPage.status, short: where(short), twice: where(twice), set: where(set), again: where(again) });

    // ---- 3. a password, and lockout ----
    const olgaIn = await post("/login", { user: "Olga", password: OLGA });
    const olga = cookieOf(olgaIn);
    const account = await call("auth.account", {}, olga);
    step("Olga signs in with her password (her sign-in id in any case)", olgaIn.status === 303 && where(olgaIn) === "/" && olga && account.id === "olga" && account.password === true, { at: where(olgaIn), account });
    const tries = [];
    for (let i = 0; i < LOCK_AFTER; i++) tries.push(where(await post("/login", { user: "sam", password: `wrong ${i}` })));
    const lockedOut = await post("/login", { user: "sam", password: "anything at all" });
    step(`${LOCK_AFTER} wrong passwords lock the sign-in id: the next try is refused as locked, whatever it is`,
        tries.slice(0, -1).every((t) => t.includes("e=wrong")) && tries.at(-1).includes("e=locked") && where(lockedOut).includes("e=locked") && !cookieOf(lockedOut), { tries, after: where(lockedOut) });

    // Tries sent at once are counted one after another: the lock one of them sets is not lifted by
    // those already on their way (it used to be, so a burst of six never left a lock standing).
    const burst = await Promise.all(Array.from({ length: LOCK_AFTER + 3 }, (_, i) => post("/login", { user: "burst", password: `wrong ${i}` })));
    const afterBurst = await post("/login", { user: "burst", password: "anything at all" });
    step("wrong passwords sent at once lock the id as well: none signs in, and the lock stands after them",
        burst.every((r) => !cookieOf(r) && /e=(wrong|locked)/.test(where(r))) && where(afterBurst).includes("e=locked"), { burst: burst.map(where), after: where(afterBurst) });
    const away = await Promise.all(["/\t/evil.example/x", "/\\evil.example/x", "//evil.example/x"].map((to) => fetch(`${mes}/login/sso?to=${encodeURIComponent(to)}`, { redirect: "manual" })));
    const kept = await db.query("SELECT return_to FROM mes.oidc_states ORDER BY expires_at DESC LIMIT 3");
    step("single sign-on comes back to a page of this site only: a location the browser would read as another host is dropped",
        away.every((r) => r.status === 303 || r.status === 302) && kept.length === 3 && kept.every((k) => k.return_to === "/"), { kept });

    // ---- 4. the plant's directory ----
    const eliIn = await post("/login", { user: "eli", password: DIRECTORY["uid=eli,ou=people,dc=test"] });
    const eliWrong = await post("/login", { user: "eli", password: "not it" });
    const zed = await post("/login", { user: "zed", password: DIRECTORY["uid=zed,ou=people,dc=test"] });
    const before = binds.length;
    const empty = await post("/login", { user: "eli", password: "" });
    step("Eli signs in through the directory; a wrong password there is wrong here",
        cookieOf(eliIn) && where(eliIn) === "/" && where(eliWrong).includes("e=wrong") && binds.some((b) => b.name === "uid=eli,ou=people,dc=test"), { eli: where(eliIn), wrong: where(eliWrong) });
    step("one the directory knows but People & departments does not is refused, by name; an empty password never reaches the directory",
        where(zed).includes("e=unknown") && where(zed).includes("u=zed") && !cookieOf(zed) && where(empty).includes("e=wrong") && binds.length === before && !binds.some((b) => b.empty), { zed: where(zed), empty: where(empty), binds });

    // ---- 5. single sign-on ----
    const sso = async ({ user = "dana", aud = "mes", keepCookie = true } = {}) => {
        nextUser = user; nextAudience = aud;
        const go = await fetch(`${mes}/login/sso`, { redirect: "manual" });
        const state = (go.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("mes_session_sso="));
        const at = await fetch(where(go), { redirect: "manual" });
        const back = await fetch(where(at), { redirect: "manual", headers: keepCookie && state ? { cookie: state } : {} });
        return { go, at, back, authorize: new URL(where(go)) };
    };
    const dana = await sso();
    const danaCookie = cookieOf(dana.back);
    const danaAccount = await call("auth.account", {}, danaCookie);
    step("Dana signs in through single sign-on: a code with PKCE (S256), the ID token's signature and nonce checked",
        dana.authorize.origin === issuer && dana.authorize.searchParams.get("code_challenge_method") === "S256" && dana.authorize.searchParams.get("nonce") && where(dana.back) === "/" && danaAccount.id === "dana", { authorize: dana.authorize.href, back: where(dana.back), account: danaAccount });
    const elsewhere = await sso({ keepCookie: false });
    const otherClient = await sso({ aud: "someone-else" });
    const stranger = await sso({ user: "zed" });
    step("refused: a callback in another browser, a token for another client, someone not in People & departments",
        where(elsewhere.back).includes("e=expired") && where(otherClient.back).includes("e=provider") && where(stranger.back).includes("e=unknown") && ![elsewhere, otherClient, stranger].some((x) => cookieOf(x.back)),
        { elsewhere: where(elsewhere.back), otherClient: where(otherClient.back), stranger: where(stranger.back) });

    // ---- 6. a person's own password, sign-out, the trail ----
    const olgaElsewhere = cookieOf(await post("/login", { user: "olga", password: OLGA }));
    const wrongCurrent = await post("/password", { current: "not my password", next: "a brand new passphrase", again: "a brand new passphrase" }, { cookie: olga });
    const changed = await post("/password", { current: OLGA, next: "a brand new passphrase", again: "a brand new passphrase" }, { cookie: olga });
    const stillHere = await call("auth.account", {}, olga);
    const gone = await call("auth.account", {}, olgaElsewhere);
    const eliOwn = await post("/password", { current: "x", next: "a brand new passphrase", again: "a brand new passphrase" }, { cookie: cookieOf(eliIn) });
    step("Olga changes her password: a wrong current one is said; her other session ends, this one stays; Eli has none here to change",
        where(wrongCurrent).includes("e=current") && where(changed) === "/password?m=changed" && stillHere.id === "olga" && gone.status === 401 && where(eliOwn).includes("e=none"), { wrongCurrent: where(wrongCurrent), changed: where(changed), stillHere, gone, eli: where(eliOwn) });
    const out = await post("/logout", {}, { cookie: danaCookie });
    const trail = await db.query("SELECT actor, action, after FROM mes.audit_log WHERE object = '$auth' AND at >= $1 ORDER BY seq", [started]);
    const has = (actor, action, test = () => true) => trail.some((t) => t.actor === actor && t.action === action && test(t.after ?? {}));
    step("every step is in the audit trail: links, passwords set, sign-ins by each way, refusals and why, sign-out",
        where(out) === "/login" && has("it:test", "password link") && has("olga", "password set", (a) => a.by === "link") && has("olga", "password set", (a) => a.by === "themselves")
        && has("olga", "sign-in", (a) => a.method === "password") && has("eli", "sign-in", (a) => a.method === "directory") && has("dana", "sign-in", (a) => a.method === "sso")
        && has("sam", "sign-in refused", (a) => a.reason === "locked") && has("zed", "sign-in refused", (a) => a.reason === "unknown") && has("dana", "sign-out"), trail);
    const chain = await verifyAudit(db);
    step("…and the trail's chain still holds", chain.ok, chain);
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close();
    idp?.close();
    ldap?.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
