// An identity provider to try single sign-on with (DESIGN.md §8.2): a small OpenID Connect provider
// for development, training and the tests, never for production. It does what OpenCore MES asks of the
// plant's real one: discovery, its signing keys, the authorization code flow with PKCE (S256), an ID
// token signed RS256 with the person's sign-in id (preferred_username), the nonce, and when they signed
// in (auth_time, amr). It remembers a sign-in as a real provider does (a cookie), so a second sign-in
// passes straight through, unless the MES asks for a fresh one (prompt=login, or max_age=0: a signature).
// It may ask a second factor after the password (--mfa: the code is shown on its own page, it is a
// simulator), and then says so (amr: pwd, otp).
//
//   node app/mes/sso-sim.mjs [--port 9095] [--password sso-sim] [--users people.json] [--mfa] [--client open-mes]
//   npm run sso:sim
//
// Then start OpenCore MES with OIDC_ISSUER=http://127.0.0.1:9095 OIDC_CLIENT_ID=open-mes (and PICKER=0,
// to sign in through it). People are the seed's (their sign-in ids and names), each with the one
// password; --users names a JSON file of [{ id, name, password? }] instead.
//
// In a test: const sim = await startSsoSimulator({ port: 0, users }); … sim.issuer … await sim.stop().
import http from "node:http";
import { createHash, generateKeyPairSync, randomBytes, randomInt, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const formOf = async (req) => { let body = ""; for await (const c of req) { body += c; if (body.length > 16384) break; } return new URLSearchParams(body); };
const cookieOf = (req, name) => (req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === name)?.[1] ?? null;

// users: [{ id, name, password? }]; password: everyone's, where a person has none of their own.
export async function startSsoSimulator({ port = 9095, host = "127.0.0.1", users = null, password = "sso-sim", clientId = "open-mes", clientSecret = null, mfa = false, log = () => {} } = {}) {
    const people = users ?? (await import("./db/seed.mjs")).users.map((u) => ({ id: u.id, name: u.name }));
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = randomBytes(6).toString("hex");
    const jwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
    const codes = new Map();    // code → { user, nonce, challenge, redirect, authTime, amr, at }
    const sessions = new Map(); // remembered sign-ins: cookie → { user, authTime, amr }
    const pending = new Map();  // a password taken, its code still to give (--mfa): token → { user, params }
    const tokens = new Map();   // access token → user, for /userinfo
    let issuer = null;
    const SAID = new Map([["wrong", "That sign-in id or password is wrong."], ["code", "That is not the code."]]);
    const sim = { calls: [], get issuer() { return issuer; }, people, mfa };

    // (No form-action in its policy: a browser holds the redirect after a sign-in to it as well, and that
    // redirect goes back to the client, wherever it runs.)
    const page = (res, title, body, status = 200) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
        res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><body style="font:16px system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1d2230"><p style="font-size:12px;color:#b54708;border:1px solid #f0c890;padding:4px 8px;border-radius:4px">SSO simulator: for development and training, never production.</p><h1 style="font-size:22px">${esc(title)}</h1>${body}`);
        return true;
    };
    const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); return true; };
    const hidden = (params) => [...params].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
    const signInForm = (res, params, said = null) => page(res, "Sign in", `${said ? `<p role="alert" style="color:#b42318">${esc(SAID.get(said) ?? said)}</p>` : ""}<form method="post" action="/authorize">${hidden(params)}
        <p><label>Sign-in id<br><input name="username" autocomplete="username" autofocus required style="font:inherit;width:100%"></label></p>
        <p><label>Password<br><input name="password" type="password" autocomplete="current-password" required style="font:inherit;width:100%"></label></p>
        <p><button style="font:inherit">Sign in</button></p></form>
        <details><summary style="font-size:14px">Who may sign in here</summary><p style="font-size:14px">${people.map((p) => `${esc(p.id)} (${esc(p.name)})`).join(", ")}; password: ${esc(password)}, unless the people file gives one.</p></details>`);
    // A code for the client, as the person is signed in now.
    const grant = (res, params, who) => {
        const code = randomBytes(24).toString("base64url");
        codes.set(code, { user: who.user, nonce: params.get("nonce"), challenge: params.get("code_challenge"), redirect: params.get("redirect_uri"), authTime: who.authTime, amr: who.amr, at: Date.now() });
        const back = new URL(params.get("redirect_uri"));
        back.searchParams.set("code", code);
        if (params.get("state")) back.searchParams.set("state", params.get("state"));
        res.writeHead(302, { location: back.href, "cache-control": "no-store" });
        res.end();
        return true;
    };
    const remember = (res, who) => {
        const id = randomBytes(24).toString("base64url");
        sessions.set(id, who);
        res.setHeader("set-cookie", `sso_sim=${id}; HttpOnly; Path=/; SameSite=Lax; Max-Age=28800`);
    };
    // What the client asks is checked before anyone signs in: this client, a redirect it may use, PKCE.
    const badRequest = (params) => (params.get("client_id") !== clientId ? "unknown client"
        : params.get("response_type") !== "code" ? "only the authorization code flow"
        : !/^https?:\/\//.test(params.get("redirect_uri") ?? "") ? "no redirect_uri"
        : params.get("code_challenge_method") !== "S256" || !params.get("code_challenge") ? "PKCE (S256) is required" : null);

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, issuer);
        sim.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
        try {
            if (url.pathname === "/.well-known/openid-configuration") return json(res, 200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, userinfo_endpoint: `${issuer}/userinfo`, jwks_uri: `${issuer}/jwks`, end_session_endpoint: `${issuer}/logout`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"], claims_supported: ["sub", "preferred_username", "name", "auth_time", "amr", "nonce"], prompt_values_supported: ["login", "none"] });
            if (url.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
            if (url.pathname === "/authorize" && req.method === "GET") {
                const wrong = badRequest(url.searchParams);
                if (wrong) return page(res, "Refused", `<p>${esc(wrong)}</p>`, 400);
                // Remembered, and no fresh sign-in asked: straight through, as a real provider does.
                const known = sessions.get(cookieOf(req, "sso_sim"));
                const maxAge = url.searchParams.get("max_age");
                const fresh = url.searchParams.get("prompt") === "login" || (maxAge !== null && (!known || Date.now() / 1000 - known.authTime >= Number(maxAge)));
                if (known && !fresh) return grant(res, url.searchParams, known);
                if (url.searchParams.get("prompt") === "none") { const back = new URL(url.searchParams.get("redirect_uri")); back.searchParams.set("error", "login_required"); back.searchParams.set("state", url.searchParams.get("state") ?? ""); res.writeHead(302, { location: back.href }); res.end(); return true; }
                return signInForm(res, url.searchParams);
            }
            if (url.pathname === "/authorize" && req.method === "POST") {
                const form = await formOf(req);
                const params = new URLSearchParams([...form].filter(([k]) => !["username", "password", "code", "pending"].includes(k)));
                if (badRequest(params)) return page(res, "Refused", `<p>${esc(badRequest(params))}</p>`, 400);
                // The second factor's step (--mfa): the code it showed.
                if (form.get("pending")) {
                    const p = pending.get(form.get("pending"));
                    if (!p) return signInForm(res, params, "That sign-in took too long: sign in again.");
                    if (form.get("code") !== p.code) return page(res, "Your code", `<p role="alert" style="color:#b42318">That is not the code.</p>${codeForm(params, form.get("pending"), p.code)}`);
                    pending.delete(form.get("pending"));
                    const who = { user: p.user, authTime: Math.floor(Date.now() / 1000), amr: ["pwd", "otp"] };
                    remember(res, who);
                    log(`signed in ${p.user.id} (password and code)`);
                    return grant(res, params, who);
                }
                const user = people.find((p) => p.id === String(form.get("username") ?? "").trim().toLowerCase());
                if (!user || form.get("password") !== (user.password ?? password)) return signInForm(res, params, "wrong");
                if (mfa) {
                    const token = randomBytes(16).toString("base64url");
                    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
                    pending.set(token, { user, code });
                    return page(res, "Your code", codeForm(params, token, code));
                }
                const who = { user, authTime: Math.floor(Date.now() / 1000), amr: ["pwd"] };
                remember(res, who);
                log(`signed in ${user.id}`);
                return grant(res, params, who);
            }
            if (url.pathname === "/token" && req.method === "POST") {
                const form = await formOf(req);
                const basic = (req.headers.authorization ?? "").startsWith("Basic ") ? Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":").map(decodeURIComponent) : null;
                const client = basic?.[0] ?? form.get("client_id");
                if (client !== clientId) return json(res, 401, { error: "invalid_client" });
                if (clientSecret && basic?.[1] !== clientSecret && form.get("client_secret") !== clientSecret) return json(res, 401, { error: "invalid_client" });
                const c = codes.get(form.get("code"));
                codes.delete(form.get("code")); // a code is good once
                if (!c || Date.now() - c.at > 60_000 || form.get("grant_type") !== "authorization_code") return json(res, 400, { error: "invalid_grant" });
                if (c.redirect !== form.get("redirect_uri")) return json(res, 400, { error: "invalid_grant", error_description: "redirect_uri differs" });
                if (createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE verifier does not match" });
                const now = Math.floor(Date.now() / 1000);
                const header = b64({ alg: "RS256", typ: "JWT", kid });
                const payload = b64({ iss: issuer, aud: clientId, sub: `sim|${c.user.id}`, preferred_username: c.user.id, name: c.user.name, iat: now, exp: now + 300, nonce: c.nonce, auth_time: c.authTime, amr: c.amr });
                const access = randomBytes(24).toString("base64url");
                tokens.set(access, c.user);
                return json(res, 200, { token_type: "Bearer", access_token: access, expires_in: 300, id_token: `${header}.${payload}.${sign("sha256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}` });
            }
            if (url.pathname === "/userinfo") {
                const user = tokens.get(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
                return user ? json(res, 200, { sub: `sim|${user.id}`, preferred_username: user.id, name: user.name }) : json(res, 401, { error: "invalid_token" });
            }
            if (url.pathname === "/logout") {
                sessions.delete(cookieOf(req, "sso_sim"));
                res.setHeader("set-cookie", "sso_sim=; Path=/; Max-Age=0");
                return page(res, "Signed out", "<p>You are signed out of the SSO simulator.</p>");
            }
            if (url.pathname === "/") return page(res, "SSO simulator", `<p>An OpenID Connect provider for trying single sign-on.</p><ul><li>Issuer: <code>${esc(issuer)}</code></li><li>Client id: <code>${esc(clientId)}</code>${clientSecret ? " (with a secret)" : " (public, PKCE)"}</li><li>Second factor: ${mfa ? "asked" : "not asked"}</li><li>People: ${people.length}</li></ul><p><a href="/logout">Sign out of the simulator</a></p>`);
            return json(res, 404, { error: "not_found" });
        } catch (error) {
            return json(res, 500, { error: "server_error", error_description: error.message });
        }
    });
    const codeForm = (params, token, code) => `<p>A real provider would send this to your phone. The simulator shows it: <strong style="font-size:20px;letter-spacing:2px">${esc(code)}</strong></p><form method="post" action="/authorize">${hidden(params)}<input type="hidden" name="pending" value="${esc(token)}"><p><label>Code<br><input name="code" inputmode="numeric" autocomplete="one-time-code" autofocus required style="font:inherit"></label></p><p><button style="font:inherit">Continue</button></p></form>`;
    await new Promise((resolve) => server.listen(port, host, resolve));
    issuer = `http://${host}:${server.address().port}`;
    sim.stop = () => new Promise((resolve) => server.close(resolve));
    // For a test: forget remembered sign-ins (as if the person signed out at the provider).
    sim.forget = () => sessions.clear();
    return sim;
}

// Run from the command line.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const args = process.argv.slice(2);
    const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
    const usersFile = opt("users", null);
    const sim = await startSsoSimulator({
        port: Number(opt("port", 9095)), password: opt("password", "sso-sim"), clientId: opt("client", "open-mes"), clientSecret: opt("secret", null), mfa: args.includes("--mfa"),
        users: usersFile ? JSON.parse(readFileSync(usersFile, "utf8")) : null, log: (line) => console.log(`  ${line}`),
    });
    console.log(`SSO simulator (development and training only): ${sim.issuer}
  ${sim.people.length} people, password "${opt("password", "sso-sim")}"${sim.mfa ? ", a second factor asked" : ""}
  Start OpenCore MES with: OIDC_ISSUER=${sim.issuer} OIDC_CLIENT_ID=${opt("client", "open-mes")} PICKER=0`);
}
