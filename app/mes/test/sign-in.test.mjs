// Sign-in's own parts (sign-in.js): passwords, what a new one must be, the LDAP bind on the wire, and an
// ID token checked against the provider's keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { hashPassword, verifyPassword, passwordProblem, bindRequest, bindResult, berRead, userDn, createOidc, ID_PATTERN } from "../server/sign-in.js";

test("a password is kept as scrypt with its salt, and only the same password matches", async () => {
    const a = await hashPassword("correct horse battery staple");
    const b = await hashPassword("correct horse battery staple");
    assert.match(a, /^scrypt\$32768\$8\$1\$/);
    assert.notEqual(a, b);
    assert.equal(await verifyPassword("correct horse battery staple", a), true);
    assert.equal(await verifyPassword("correct horse battery stapl", a), false);
    assert.equal(await verifyPassword("anything", "not a hash"), false);
});

test("a new password: long enough, without the sign-in id", () => {
    assert.equal(passwordProblem("short", "olga"), "short");
    assert.equal(passwordProblem("x".repeat(257), "olga"), "long");
    assert.equal(passwordProblem("OLGA-is-my-password", "olga"), "id");
    assert.equal(passwordProblem("a few words to remember", "olga"), null);
});

test("a sign-in id is plain: nothing in it can change the name the directory binds", () => {
    for (const ok of ["olga", "o.ortiz", "ortiz_o-2"]) assert.ok(ID_PATTERN.test(ok), ok);
    for (const bad of ["", "olga,ou=admins", "*", "a b", "(uid=*)", ".olga", "x".repeat(65)]) assert.ok(!ID_PATTERN.test(bad), bad);
    assert.equal(userDn("uid={user},ou=people,dc=plant", "olga"), "uid=olga,ou=people,dc=plant");
    assert.equal(userDn("{user}@plant.local", "olga"), "olga@plant.local");
});

test("the BindRequest is BER as RFC 4511 has it; the response's result code is read", () => {
    const req = bindRequest(1, "uid=olga,dc=x", "pw");
    const msg = berRead(req);
    assert.equal(msg.tag, 0x30);
    assert.equal(msg.end, req.length);
    const id = berRead(req, msg.start), op = berRead(req, id.end);
    assert.equal(op.tag, 0x60);
    const version = berRead(req, op.start), dn = berRead(req, version.end), pw = berRead(req, dn.end);
    assert.equal(req[version.start], 3);
    assert.equal(req.toString("utf8", dn.start, dn.end), "uid=olga,dc=x");
    assert.equal(pw.tag, 0x80);
    assert.equal(req.toString("utf8", pw.start, pw.end), "pw");
    // A long name takes a long-form length.
    const long = bindRequest(2, `uid=${"a".repeat(300)}`, "pw");
    assert.equal(berRead(long).end, long.length);
    assert.equal(bindResult(Buffer.from([0x30, 0x0c, 0x02, 0x01, 0x01, 0x61, 0x07, 0x0a, 0x01, 0x00, 0x04, 0x00, 0x04, 0x00])), 0);
    assert.equal(bindResult(Buffer.from([0x30, 0x0c, 0x02, 0x01, 0x01, 0x61, 0x07, 0x0a, 0x01, 49, 0x04, 0x00, 0x04, 0x00])), 49);
    assert.equal(berRead(Buffer.from([0x30, 0x0c, 0x02])), null);
});

test("an ID token holds only when signed by the provider's key, for this client, in time, with this nonce", async () => {
    const issuer = "https://idp.example";
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
    let token = null;
    const fetchFn = async (url) => {
        const body = url.endsWith("openid-configuration") ? { issuer, authorization_endpoint: `${issuer}/a`, token_endpoint: `${issuer}/t`, jwks_uri: `${issuer}/k` }
            : url.endsWith("/k") ? { keys: [jwk] } : { id_token: token };
        return { ok: true, status: 200, json: async () => body };
    };
    const now = Math.floor(Date.now() / 1000);
    const jwt = (claims, key = privateKey, alg = "RS256") => {
        const h = Buffer.from(JSON.stringify({ alg, kid: "k1" })).toString("base64url");
        const p = Buffer.from(JSON.stringify({ iss: issuer, aud: "mes", nonce: "n1", exp: now + 60, preferred_username: "olga", ...claims })).toString("base64url");
        return `${h}.${p}.${sign("sha256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
    };
    const oidc = createOidc({ issuer, clientId: "mes", fetchFn });
    const start = await oidc.start("https://mes/cb");
    assert.match(start.url, /code_challenge_method=S256/);
    const finish = (t) => { token = t; return oidc.finish({ code: "c", verifier: "v", nonce: "n1", redirectUri: "https://mes/cb" }); };
    assert.equal((await finish(jwt({}))).preferred_username, "olga");
    await assert.rejects(finish(jwt({}, other)), /signature/);
    await assert.rejects(finish(jwt({ aud: "else" })), /another client/);
    await assert.rejects(finish(jwt({ iss: "https://evil" })), /another issuer/);
    await assert.rejects(finish(jwt({ exp: now - 600 })), /expired/);
    await assert.rejects(finish(jwt({ nonce: "n2" })), /nonce/);
    await assert.rejects(finish(jwt({}, privateKey, "none")), /not accepted/);
});

test("a provider's configuration from another issuer is refused every time, not only the first", async () => {
    let fetched = 0;
    const fetchFn = async () => { fetched++; return { ok: true, status: 200, json: async () => ({ issuer: "https://evil.example", authorization_endpoint: "https://evil.example/a" }) }; };
    const oidc = createOidc({ issuer: "https://idp.example", clientId: "mes", fetchFn });
    await assert.rejects(oidc.start("https://mes/cb"), /calls itself/);
    await assert.rejects(oidc.start("https://mes/cb"), /calls itself/);
    assert.equal(fetched, 2);
});

// ---- sign-in hardened (§8.2): the plant's policy, an authenticator app (RFC 6238), the session key ----
import { policyOf, expiredAt, expiresAt, base32, fromBase32, hotp, totpStep, timeStep, otpauthUri, recoveryCodes, codeHash } from "../server/sign-in.js";
import { sessionKey } from "../server/store.js";
test("the plant's policy: read with care, nothing of it on a picker instance", () => {
    assert.deepEqual(policyOf({}), { maxDays: 0, history: 0, mfa: "off", idleMinutes: 0, signWithPassword: false });
    assert.deepEqual(policyOf({ passwordMaxDays: 90, passwordHistory: 50, mfa: "required", idleMinutes: 30, signWithPassword: true }), { maxDays: 90, history: 24, mfa: "required", idleMinutes: 30, signWithPassword: true });
    assert.equal(policyOf({ signWithPassword: true, picker: true }).signWithPassword, false);
    assert.equal(policyOf({ mfa: "sometimes" }).mfa, "off");
    const p = policyOf({ passwordMaxDays: 90 });
    const old = new Date(Date.now() - 91 * 86400_000), recent = new Date(Date.now() - 10 * 86400_000);
    assert.ok(expiredAt(old, p));
    assert.equal(expiredAt(recent, p), null);
    assert.equal(Math.round((expiresAt(recent, p) - Date.now()) / 86400_000), 80);
    assert.equal(expiredAt(old, policyOf({})), null);
});
test("an authenticator's codes are RFC 6238's (HMAC-SHA1, 30 s), good once, a step either side", () => {
    const secret = base32(Buffer.from("12345678901234567890"));
    assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    assert.deepEqual(fromBase32(secret), Buffer.from("12345678901234567890"));
    // RFC 6238 appendix B (SHA-1, 8 digits) and RFC 4226 appendix D (counter 0, 6 digits).
    assert.equal(hotp(secret, Math.floor(59 / 30), 8), "94287082");
    assert.equal(hotp(secret, Math.floor(1111111109 / 30), 8), "07081804");
    assert.equal(hotp(secret, Math.floor(20000000000 / 30), 8), "65353130");
    assert.equal(hotp(secret, 0), "755224");
    const at = 1_800_000_000_000, step = timeStep(at);
    assert.equal(totpStep(secret, hotp(secret, step), 0, at), step);
    assert.equal(totpStep(secret, hotp(secret, step - 1), 0, at), step - 1);
    assert.equal(totpStep(secret, hotp(secret, step - 2), 0, at), null);
    assert.equal(totpStep(secret, hotp(secret, step), step, at), null);       // taken already
    // Spaces in a typed code are ignored.
    assert.equal(totpStep(secret, hotp(secret, step).replace(/(\d{3})/, "$1 "), 0, at), step);
    assert.equal(totpStep(secret, "abcdef", 0, at), null);
    assert.match(otpauthUri(secret, "olga"), /^otpauth:\/\/totp\/OpenCore%20MES%3Aolga\?secret=GEZDG.*&issuer=OpenCore\+MES/);
    const codes = recoveryCodes();
    assert.equal(new Set(codes).size, 10);
    assert.ok(codes.every((c) => /^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{2}$/.test(c)));
    assert.equal(codeHash(codes[0].toUpperCase().replace(/-/g, " ")), codeHash(codes[0]));
});
test("a session is kept by the SHA-256 of its id, as the database's trigger keeps it", () => {
    assert.equal(sessionKey("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.match(sessionKey("x"), /^[0-9a-f]{64}$/);
});
