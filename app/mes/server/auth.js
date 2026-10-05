// Sign-in (DESIGN.md §8.2): the HTTP side. How a person proves who they are is sign-in.js (single
// sign-on, the plant's directory, a password of their own); a development or demo instance may also
// offer the picker (anyone as anyone). The session is an opaque id in an HttpOnly cookie, stored
// server-side, resolved on every request and never memoised.
import { createHash, randomBytes } from "node:crypto";
import { ID_PATTERN, audit, clearFailures, countFailure, createOidc, hashPassword, ldapBind, lockedUntil, passwordProblem, spendDecoy, verifyPassword, policyOf, expiredAt, reused, remember, startPending, pendingOf, endPending, checkSecondFactor, newTotpSecret, otpauthUri, recoveryCodes, codeHash, totpStep, PENDING_MINUTES } from "./sign-in.js";
import { parseCookies, serializeCookie, appendSetCookie, readBody, onThisSite, clientIp } from "../../../src/server/http.js";
import { sessionKey } from "./store.js";

// The cookie's name: mes_session, or the instance's own (createApp sessionCookie), since a browser
// sends a host's cookies to every port on it: two instances on one machine (a training one beside
// development) would otherwise sign each other's users out.
let SESSION_COOKIE = "mes_session";
export const setSessionCookie = (name) => { if (name) SESSION_COOKIE = name; };
const SESSION_HOURS = 12;

// The cookie header that carries a session, for a call this process makes to an app of its own (a sandbox).
export const sessionCookieFor = (id) => `${SESSION_COOKIE}=${id}`;
export const sessionIdOf = (req) => parseCookies(req.headers.cookie ?? "")[SESSION_COOKIE] ?? null;

// A form posted from this site only: its Origin (or Referer) must name the host it was sent to.
function sameSite(req) {
    const from = req.headers.origin ?? req.headers.referer;
    if (!from) return false;
    try { return new URL(from).host === req.headers.host; } catch { return false; }
}

function json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
    return true;
}
// The small window a fresh single sign-on ran in (§7.4): it says how it went, tells the page that
// opened it, and closes. Its one script is allowed by its hash, nothing else.
const DONE_SCRIPT = "try{window.opener&&window.opener.postMessage({mesSignedInAgain:document.body.dataset.ok==='1'},location.origin)}catch(e){}setTimeout(function(){window.close()},1200);";
const DONE_HASH = createHash("sha256").update(DONE_SCRIPT).digest("base64");
function donePage(res, ok, words) {
    const safe = String(words).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": `default-src 'none'; script-src 'sha256-${DONE_HASH}'; style-src 'unsafe-inline'; frame-ancestors 'none'` });
    res.end(`<!doctype html><meta charset="utf-8"><title>Signed in again</title><body data-ok="${ok ? "1" : "0"}" style="font:16px system-ui;padding:24px"><p>${safe}</p><script>${DONE_SCRIPT}</script>`);
    return true;
}
function redirect(res, location, cookie) {
    if (cookie) appendSetCookie(res, cookie);
    res.writeHead(303, { location, "cache-control": "no-store" });
    res.end();
    return true;
}

// How this instance signs people in (createApp `signIn`, from the environment in server.mjs):
//   { picker, passwords, ldap: { url, userDn, label, ca }, sso: { issuer, clientId, clientSecret,
//     redirectUri, claim, label, scopes } }
// What the sign-in page offers, with nothing secret in it (the service auth.methods).
export const methodsOf = (signIn) => ({
    picker: Boolean(signIn?.picker),
    password: Boolean(signIn?.passwords || signIn?.ldap),
    directory: signIn?.ldap ? (signIn.ldap.label ?? "the plant's directory") : null,
    sso: signIn?.sso ? (signIn.sso.label ?? "Single sign-on") : null,
});

const back = (code, extra = {}) => `/login?${new URLSearchParams({ e: code, ...extra })}`;
const formOf = async (req) => {
    const body = await readBody(req, { limit: 4096 });
    return new URLSearchParams(body ? body.toString("utf8") : "");
};

// The kernel's `handlers`: POST /login, POST /logout, POST /password, GET /login/sso and its callback.
// `homeFor(user, address)` (desktops.js) says the page the desktop at that address opens, or null;
// `trustProxy` how the address is read behind proxies (http.js clientIp).
// `events` (event-log.js): a sign-in id locked is logged there too, for whatever watches the log (G9).
export function authHandler({ store, secure, signIn = {}, fetchFn = fetch, homeFor = async () => null, trustProxy = false, events = null }) {
    const db = store.db;
    const sso = signIn.sso ? createOidc({ ...signIn.sso, fetchFn }) : null;
    const policy = policyOf(signIn);
    const SSO_COOKIE = () => `${SESSION_COOKIE}_sso`;
    // A sign-in half done (a code, setting up the authenticator, a new password): its token, in a
    // cookie only the sign-in page's posts carry.
    const PENDING_COOKIE = () => `${SESSION_COOKIE}_pending`;
    const pendingCookie = (token) => serializeCookie(PENDING_COOKIE(), token ?? "", { secure, maxAge: token ? PENDING_MINUTES * 60 : 0, path: "/login" });
    // `req` says where the sign-in comes from: the desktop there may have a page of its own (§6.8), kept
    // with the session and opened unless the person was on their way somewhere (`location`).
    const startSession = async (req, res, user, method, location = "/") => {
        const id = randomBytes(32).toString("base64url");
        // (A desktop whose page is not live, or not this person's to open, is named in the entry all the same.)
        const home = await homeFor(user, clientIp(req, { trustProxy })).catch(() => null);
        // Sessions that ended (expired, or idle past the plant's limit) are swept as new ones start.
        await db.query("DELETE FROM mes.sessions WHERE expires_at < now() OR ($1::int > 0 AND last_seen < now() - make_interval(mins => $1::int))", [policy.idleMinutes]);
        // (Kept by its SHA-256: the database's trigger hashes the id; the browser alone holds it.)
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at, home, home_label) VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)", [id, user.id, SESSION_HOURS, home?.path ?? null, home?.path ? home.label ?? null : null]);
        await clearFailures(db, user.id);
        await audit(db, user.id, "sign-in", { method, ...(home ? { desktop: home.desktop, ...(home.path ? { opens: home.path } : {}) } : {}) });
        return redirect(res, location === "/" && home?.path ? home.path : location, serializeCookie(SESSION_COOKIE, id, { secure, maxAge: SESSION_HOURS * 3600 }));
    };
    const refuse = async (res, who, method, reason, extra) => {
        await audit(db, who, "sign-in refused", { method, reason });
        if (reason === "locked") events?.emit?.("auth.locked", { severity: "warning", message: `Sign-in id ${String(who ?? "?").slice(0, 80)} is locked after wrong passwords.`, details: { user: String(who ?? "").slice(0, 80), method } });
        return redirect(res, back(reason, extra));
    };
    // Where they were going (`to`, a page of this site), kept across a refusal so the next try still leads there.
    const going = (location) => (location && location !== "/" ? { to: location } : {});
    const redirectUri = (req) => signIn.sso.redirectUri ?? `${secure ? "https" : "http"}://${req.headers.host}/login/sso/callback`;

    // A sign-in id and password: their own password if they have one here, else the plant's directory.
    const byPassword = async (req, res, given, password, location = "/") => {
        const id = String(given ?? "").trim().toLowerCase();
        if (!ID_PATTERN.test(id) || !password) return refuse(res, id, "password", "wrong", going(location));
        if (await lockedUntil(db, id)) return refuse(res, id, "password", "locked", going(location));
        const user = await store.user(id);
        const [own] = signIn.passwords ? await db.query("SELECT hash FROM mes.credentials WHERE user_id = $1", [id]) : [];
        let method = "password", ok = false;
        if (own) ok = await verifyPassword(password, own.hash);
        else if (signIn.ldap) {
            method = "directory";
            const bound = await ldapBind(signIn.ldap, id, password);
            if (bound.reason === "directory") {
                await audit(db, id, "sign-in refused", { method, reason: "directory", detail: bound.detail });
                return redirect(res, back("directory", going(location)));
            }
            ok = bound.ok;
        } else ok = await spendDecoy(password);
        if (!ok) {
            const locked = await countFailure(db, id);
            return refuse(res, id, method, locked ? "locked" : "wrong", going(location));
        }
        // The directory vouches for them, but People & departments has not added them (or they left).
        if (!user) return refuse(res, id, method, "unknown", { u: id, ...going(location) });
        // Asked again: tries sent at once all passed the first check, and the lock one of them set
        // holds for the right password among them too.
        if (await lockedUntil(db, id)) return refuse(res, id, method, "locked", going(location));
        return nextStep(req, res, user, method, location);
    };
    // After the password: a new one where it has expired (their own, here: the directory's are the
    // directory's), then the second factor where the plant asks one, then the session.
    async function nextStep(req, res, user, method, location, after = null) {
        if (method === "password" && after !== "expired" && policy.maxDays) {
            const [own] = await db.query("SELECT set_at FROM mes.credentials WHERE user_id = $1", [user.id]);
            if (own && expiredAt(own.set_at, policy)) return pending(res, user, method, "expired", location);
        }
        if (policy.mfa !== "off" && after !== "code" && after !== "enroll") {
            const [m] = await db.query("SELECT enabled_at FROM mes.mfa WHERE user_id = $1", [user.id]);
            if (m?.enabled_at) return pending(res, user, method, "code", location);
            if (policy.mfa === "required") return pending(res, user, method, "enroll", location);
        }
        appendSetCookie(res, pendingCookie(null));
        return startSession(req, res, user, method, location);
    }
    async function pending(res, user, method, step, location) {
        const token = await startPending(db, { userId: user.id, method, step, returnTo: location });
        await audit(db, user.id, "sign-in step", { method, step });
        return redirect(res, `/login?${new URLSearchParams({ step, ...going(location) })}`, pendingCookie(token));
    }
    const pendingFrom = async (req, step) => {
        const row = await pendingOf(db, parseCookies(req.headers.cookie ?? "")[PENDING_COOKIE()]);
        return row && row.step === step ? row : null;
    };
    // The page's next try at a step: back to it, saying why.
    const again = (res, step, code, location) => redirect(res, `/login?${new URLSearchParams({ step, e: code, ...going(location) })}`);

    // The person a demo opens as (signIn.as, or the first who designs, by name; else the first person):
    // a public demo has no sign-in page, anyone switches to anyone from the top bar.
    const demoPerson = async () => {
        if (signIn.as) { const named = await store.user(signIn.as); if (named) return named; }
        const [designer] = await db.query(
            `SELECT u.id, u.name FROM mes.users u WHERE u.active AND u.id IN (
                SELECT subject_id FROM mes.assignments WHERE object = 'design' AND role = 'designer' AND subject_kind = 'user'
                UNION SELECT m.user_id FROM mes.assignments a JOIN mes.group_members m ON a.subject_kind = 'group' AND m.group_id = a.subject_id WHERE a.object = 'design' AND a.role = 'designer')
             ORDER BY u.name LIMIT 1`,
        );
        return designer ?? (await db.query("SELECT id, name FROM mes.users WHERE active ORDER BY name LIMIT 1"))[0] ?? null;
    };
    // Where to go after a switch: a page of this site (`to`), else home. The browser's own reading of
    // the location decides (onThisSite): "/<TAB>/elsewhere.example" passes any prefix check and leaves.
    const backTo = (to) => (onThisSite(to) && !to.startsWith("/login") ? to : "/");

    // A public demo that gives each visitor a guest of their own (signIn.guests === "session", guest.mjs):
    // made as they arrive, within limits, since a crawler that keeps no cookie arrives again at every
    // link; past them (an address's share of the hour, the hour's, the day's), the shared demo person.
    const limits = { perAddress: 20, perHour: 300, total: 3000, ...(signIn.guestLimits ?? {}) };
    const madeLately = new Map(); // address → [times]
    let hour = [];
    const sessionGuest = async (req) => {
        if (signIn.guests !== "session") return null;
        const now = Date.now();
        const address = clientIp(req, { trustProxy }) ?? "?";
        hour = hour.filter((t) => now - t < 3_600_000);
        const mine = (madeLately.get(address) ?? []).filter((t) => now - t < 3_600_000);
        if (mine.length >= limits.perAddress || hour.length >= limits.perHour) return null;
        const [{ n }] = await db.query("SELECT count(*)::int AS n FROM mes.users WHERE left(id, 6) = 'guest_'");
        if (n >= limits.total) return null;
        const [group] = await db.query("SELECT 1 FROM mes.groups WHERE id = 'guests'");
        if (!group) return null;
        const { addSessionGuest } = await import("../db/guest.mjs");
        const user = await addSessionGuest(db);
        madeLately.set(address, [...mine, now]);
        if (madeLately.size > 10_000) madeLately.delete(madeLately.keys().next().value);
        hour.push(now);
        return user;
    };

    return async (req, res, url) => {
        const path = url.pathname;
        // The demo has no sign-in page: whoever arrives without a session is a guest of their own, or the
        // demo person.
        if (signIn.auto && req.method === "GET" && path === "/login") {
            const guest = await sessionGuest(req).catch((error) => { events?.emit?.("demo.guest_failed", { severity: "warning", message: `A visitor's guest could not be made (${error.message}); they are the demo person.` }); return null; });
            const person = guest ?? (await demoPerson());
            if (person) return startSession(req, res, person, guest ? "demo guest" : "demo", backTo(url.searchParams.get("to")));
        }
        if (sso && req.method === "GET" && path === "/login/sso") {
            const go = await sso.start(redirectUri(req)).catch((error) => ({ error }));
            if (go.error) { await audit(db, null, "sign-in refused", { method: "sso", reason: "provider", detail: go.error.message }); return redirect(res, back("provider")); }
            await db.query("DELETE FROM mes.oidc_states WHERE expires_at < now()");
            const returnTo = backTo(url.searchParams.get("to"));
            await db.query("INSERT INTO mes.oidc_states (state, verifier, nonce, return_to, expires_at) VALUES ($1, $2, $3, $4, now() + interval '10 minutes')", [createHash("sha256").update(go.state).digest("hex"), go.verifier, go.nonce, returnTo]);
            // The state in a cookie as well: the callback must come back to the browser that set off.
            return redirect(res, go.url, serializeCookie(SSO_COOKIE(), go.state, { secure, maxAge: 600, sameSite: "Lax", path: "/login/sso" }));
        }
        if (sso && req.method === "GET" && path === "/login/sso/callback") {
            const state = url.searchParams.get("state") ?? "";
            const mine = parseCookies(req.headers.cookie ?? "")[SSO_COOKIE()];
            appendSetCookie(res, serializeCookie(SSO_COOKIE(), "", { secure, maxAge: 0, path: "/login/sso" }));
            const [row] = state && mine === state ? await db.query("DELETE FROM mes.oidc_states WHERE state = $1 AND expires_at > now() RETURNING verifier, nonce, return_to, purpose, reauth_session, reauth_user, started_at", [createHash("sha256").update(state).digest("hex")]) : [];
            if (!row) return refuse(res, null, "sso", "expired");
            if (row.purpose === "reauth") return reauthenticated(req, res, url, row);
            if (url.searchParams.get("error")) return refuse(res, null, "sso", "provider");
            let claims;
            try {
                claims = await sso.finish({ code: url.searchParams.get("code") ?? "", verifier: row.verifier, nonce: row.nonce, redirectUri: redirectUri(req) });
            } catch (error) {
                await audit(db, null, "sign-in refused", { method: "sso", reason: "provider", detail: error.message });
                return redirect(res, back("provider"));
            }
            const id = String(claims[sso.claim] ?? "").trim().toLowerCase();
            const user = ID_PATTERN.test(id) ? await store.user(id) : null;
            if (!user) return refuse(res, id || claims.sub, "sso", "unknown", { u: id || String(claims.sub ?? "") });
            return startSession(req, res, user, "sso", row.return_to);
        }
        // Setting up the authenticator, at a sign-in that asks it (step "enroll"): its key and recovery
        // codes, made now and shown once (the key, again, until it is confirmed with a code).
        if (req.method === "GET" && path === "/login/enroll") {
            const row = await pendingFrom(req, "enroll");
            if (!row) return json(res, 409, { error: "This sign-in has expired: sign in again." });
            const secret = newTotpSecret();
            const codes = recoveryCodes();
            await db.transaction(async (tx) => {
                await tx.query("INSERT INTO mes.mfa (user_id, secret) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET secret = $2, enabled_at = NULL, last_step = 0", [row.user_id, secret]);
                await tx.query("DELETE FROM mes.mfa_recovery WHERE user_id = $1", [row.user_id]);
                for (const c of codes) await tx.query("INSERT INTO mes.mfa_recovery (user_id, code_hash) VALUES ($1, $2)", [row.user_id, codeHash(c)]);
            });
            return json(res, 200, { user: row.user_id, secret, uri: otpauthUri(secret, row.user_id), codes });
        }
        // A fresh sign-in at the identity provider, for one signature (§7.4): the person signed in (`me`),
        // or the one beside them (`second`), asked again whatever the provider remembers (prompt=login,
        // max_age=0). Opened in a small window by the page; it closes when done.
        if (sso && req.method === "GET" && path === "/login/sso/again") {
            const sid = sessionIdOf(req);
            const user = sid ? await store.userForSession(sid) : null;
            const who = url.searchParams.get("who") === "second" ? user?.second?.id : user?.id;
            if (!user || !who) return donePage(res, false, "Sign in first.");
            const go = await sso.start(redirectUri(req), { prompt: "login", maxAge: 0 }).catch((error) => ({ error }));
            if (go.error) return donePage(res, false, "Single sign-on is not reachable: try again, or ask IT.");
            await db.query("INSERT INTO mes.oidc_states (state, verifier, nonce, return_to, expires_at, purpose, reauth_session, reauth_user) VALUES ($1, $2, $3, '/login/sso/done', now() + interval '10 minutes', 'reauth', $4, $5)", [createHash("sha256").update(go.state).digest("hex"), go.verifier, go.nonce, sessionKey(sid), who]);
            return redirect(res, go.url, serializeCookie(SSO_COOKIE(), go.state, { secure, maxAge: 600, sameSite: "Lax", path: "/login/sso" }));
        }
        if (req.method !== "POST" || !["/login", "/logout", "/password", "/login/code", "/login/expired", "/login/enroll"].includes(path)) return false; // GET /login is the page
        if (!sameSite(req)) { res.writeHead(403, { "content-type": "text/plain" }); res.end("Forbidden."); return true; }
        if (path === "/logout") {
            const id = sessionIdOf(req);
            const user = id ? await store.userForSession(id) : null;
            if (id) await db.query("DELETE FROM mes.sessions WHERE id = $1", [sessionKey(id)]);
            if (user) await audit(db, user.id, "sign-out", {});
            return redirect(res, "/login", serializeCookie(SESSION_COOKIE, "", { secure, maxAge: 0 }));
        }
        const form = await formOf(req);
        if (path === "/password") return setPassword(req, res, form);
        if (path === "/login/code") return byCode(req, res, form);
        if (path === "/login/expired") return newPassword(req, res, form);
        if (path === "/login/enroll") return enrolled(req, res, form);
        if (form.has("password")) return byPassword(req, res, form.get("user"), form.get("password"), backTo(form.get("to")));
        // The picker: a development or demo instance only. A switch from the top bar stays on its page.
        if (!signIn.picker) return redirect(res, back("wrong"));
        const user = await store.user(form.get("user"));
        if (!user) return redirect(res, "/login");
        const was = sessionIdOf(req);
        if (was) await db.query("DELETE FROM mes.sessions WHERE id = $1", [sessionKey(was)]);
        return startSession(req, res, user, "picker", backTo(form.get("to")));
    };

    // The second factor at sign-in: a code from their authenticator, or a recovery code.
    async function byCode(req, res, form) {
        const row = await pendingFrom(req, "code");
        if (!row) return redirect(res, back("step"));
        if (await lockedUntil(db, row.user_id)) { await endPending(db, parseCookies(req.headers.cookie ?? "")[PENDING_COOKIE()]); return refuse(res, row.user_id, row.method, "locked"); }
        const how = await checkSecondFactor(db, row.user_id, form.get("code"));
        if (!how) {
            const locked = await countFailure(db, row.user_id);
            await audit(db, row.user_id, "sign-in refused", { method: row.method, reason: locked ? "locked" : "code" });
            if (locked) { await endPending(db, parseCookies(req.headers.cookie ?? "")[PENDING_COOKIE()]); return redirect(res, back("locked")); }
            return again(res, "code", "code", row.return_to);
        }
        const user = await store.user(row.user_id);
        await endPending(db, parseCookies(req.headers.cookie ?? "")[PENDING_COOKIE()]);
        if (!user) return refuse(res, row.user_id, row.method, "unknown");
        if (how === "recovery") await audit(db, user.id, "recovery code used", {});
        return nextStep(req, res, user, `${row.method}+${how}`, row.return_to, "code");
    }
    // The authenticator set up at a sign-in that requires it: confirmed with its first code.
    async function enrolled(req, res, form) {
        const row = await pendingFrom(req, "enroll");
        if (!row) return redirect(res, back("step"));
        const [m] = await db.query("SELECT secret FROM mes.mfa WHERE user_id = $1 AND enabled_at IS NULL", [row.user_id]);
        const step = m ? totpStep(m.secret, form.get("code")) : null;
        if (step === null) { await countFailure(db, row.user_id); return again(res, "enroll", "code", row.return_to); }
        await db.query("UPDATE mes.mfa SET enabled_at = now(), last_step = $2 WHERE user_id = $1", [row.user_id, step]);
        await audit(db, row.user_id, "second factor set", { by: "themselves", at: "sign-in" });
        const user = await store.user(row.user_id);
        await endPending(db, parseCookies(req.headers.cookie ?? "")[PENDING_COOKIE()]);
        if (!user) return refuse(res, row.user_id, row.method, "unknown");
        return nextStep(req, res, user, `${row.method}+totp`, row.return_to, "enroll");
    }
    // An expired password changed at sign-in: the new one twice, not one of the last few.
    async function newPassword(req, res, form) {
        const row = await pendingFrom(req, "expired");
        if (!row) return redirect(res, back("step"));
        const next = form.get("next") ?? "", twice = form.get("again") ?? "";
        if (next !== twice) return again(res, "expired", "again", row.return_to);
        const weak = passwordProblem(next, row.user_id);
        if (weak) return again(res, "expired", weak, row.return_to);
        const [own] = await db.query("SELECT hash FROM mes.credentials WHERE user_id = $1", [row.user_id]);
        if (await reused(db, row.user_id, "password", next, policy, own?.hash)) return again(res, "expired", "reused", row.return_to);
        const hash = await hashPassword(next);
        await db.transaction(async (tx) => {
            await tx.query("UPDATE mes.credentials SET hash = $2, set_at = now() WHERE user_id = $1", [row.user_id, hash]);
            await remember(tx, row.user_id, "password", own?.hash, policy);
            await tx.query("DELETE FROM mes.sessions WHERE user_id = $1", [row.user_id]);
        });
        await audit(db, row.user_id, "password set", { by: "themselves", because: "expired" });
        const user = await store.user(row.user_id);
        await endPending(db, parseCookies(req.headers.cookie ?? "")[PENDING_COOKIE()]);
        if (!user) return refuse(res, row.user_id, row.method, "unknown");
        return nextStep(req, res, user, row.method, row.return_to, "expired");
    }
    // A fresh sign-in at the provider, for a signature: the person it was for, signed in now (the
    // token's auth_time after the request was made). Kept for that session and person, for a few
    // minutes, until a signature spends it.
    async function reauthenticated(req, res, url, row) {
        if (url.searchParams.get("error")) return donePage(res, false, "Single sign-on did not complete.");
        let claims;
        try {
            claims = await sso.finish({ code: url.searchParams.get("code") ?? "", verifier: row.verifier, nonce: row.nonce, redirectUri: redirectUri(req) });
        } catch (error) {
            await audit(db, row.reauth_user, "signature refused", { method: "sso", reason: "provider", detail: error.message });
            return donePage(res, false, "Single sign-on did not complete: try again, or ask IT.");
        }
        const id = String(claims[sso.claim] ?? "").trim().toLowerCase();
        const fresh = Number.isFinite(claims.auth_time) && claims.auth_time * 1000 >= new Date(row.started_at).getTime() - 60_000;
        if (id !== row.reauth_user || !fresh) {
            await audit(db, row.reauth_user, "signature refused", { method: "sso", reason: id !== row.reauth_user ? "someone else" : "not fresh", as: id || null });
            return donePage(res, false, id !== row.reauth_user ? `You signed in as ${id || "someone else"}, not ${row.reauth_user}.` : "The provider did not ask you to sign in again: ask IT.");
        }
        await db.query("INSERT INTO mes.session_reauth (session_id, user_id, at) VALUES ($1, $2, now()) ON CONFLICT (session_id, user_id) DO UPDATE SET at = now()", [row.reauth_session, id]);
        await audit(db, id, "signed in again", { method: "sso", for: "signature" });
        return donePage(res, true, "Signed in again: you may sign.");
    }

    // A password set through a one-time link, or changed by the person signed in.
    async function setPassword(req, res, form) {
        if (!signIn.passwords) return redirect(res, "/login");
        const token = form.get("token");
        const next = form.get("next") ?? "", again = form.get("again") ?? "";
        const page = (code) => redirect(res, `/password?${new URLSearchParams(token ? { token, e: code } : { e: code })}`);
        if (token) {
            const [link] = await db.query("SELECT user_id FROM mes.password_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()", [createHash("sha256").update(token).digest("hex")]);
            if (!link) return redirect(res, "/password?e=link");
            if (next !== again) return page("again");
            const weak = passwordProblem(next, link.user_id);
            if (weak) return page(weak);
            const [had] = await db.query("SELECT hash FROM mes.credentials WHERE user_id = $1", [link.user_id]);
            if (await reused(db, link.user_id, "password", next, policy, had?.hash)) return page("reused");
            const hash = await hashPassword(next);
            const set = await db.transaction(async (tx) => {
                // Spent, whatever else happens: a link sets one password.
                const [spent] = await tx.query("UPDATE mes.password_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL RETURNING user_id", [createHash("sha256").update(token).digest("hex")]);
                if (!spent) return false;
                await tx.query("INSERT INTO mes.credentials (user_id, hash, set_at) VALUES ($1, $2, now()) ON CONFLICT (user_id) DO UPDATE SET hash = $2, set_at = now()", [spent.user_id, hash]);
                await remember(tx, spent.user_id, "password", had?.hash, policy);
                // Whoever was signed in as them is not any more.
                await tx.query("DELETE FROM mes.sessions WHERE user_id = $1", [spent.user_id]);
                await tx.query("DELETE FROM mes.sign_in_failures WHERE user_id = $1", [spent.user_id]);
                return true;
            });
            // Spent by another request in between (the form sent twice): no password was set by this one.
            if (!set) return redirect(res, "/password?e=link");
            await audit(db, link.user_id, "password set", { by: "link" });
            return redirect(res, "/login?m=password");
        }
        const sid = sessionIdOf(req);
        const user = await store.userForSession(sid);
        if (!user) return redirect(res, "/login");
        const [own] = await db.query("SELECT hash FROM mes.credentials WHERE user_id = $1", [user.id]);
        if (!own) return page("none");
        if (await lockedUntil(db, user.id)) return page("locked");
        if (!(await verifyPassword(form.get("current") ?? "", own.hash))) {
            const locked = await countFailure(db, user.id);
            await audit(db, user.id, "password refused", { reason: locked ? "locked" : "wrong" });
            return page(locked ? "locked" : "current");
        }
        if (await lockedUntil(db, user.id)) return page("locked");
        if (next !== again) return page("again");
        const weak = passwordProblem(next, user.id);
        if (weak) return page(weak);
        if (await reused(db, user.id, "password", next, policy, own.hash)) return page("reused");
        const hash = await hashPassword(next);
        await db.transaction(async (tx) => {
            await tx.query("UPDATE mes.credentials SET hash = $2, set_at = now() WHERE user_id = $1", [user.id, hash]);
            await remember(tx, user.id, "password", own.hash, policy);
        });
        // Their other sessions end; this one stays.
        await db.query("DELETE FROM mes.sessions WHERE user_id = $1 AND id <> $2", [user.id, sessionKey(sid)]);
        await clearFailures(db, user.id);
        await audit(db, user.id, "password set", { by: "themselves" });
        return redirect(res, "/password?m=changed");
    }
}
