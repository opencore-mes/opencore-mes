// Sign-in (DESIGN.md §8.2): who may sign in, and how. People & departments decides who is a person here;
// how they prove it is one of three ways, whichever the installation turns on (server.mjs, from the
// environment):
//   - single sign-on through the plant's identity provider (OpenID Connect: authorization code with
//     PKCE, the ID token's signature checked against the provider's keys, its issuer, audience,
//     expiry and nonce);
//   - the plant's directory (LDAP or Active Directory): a bind as the person, with the password they
//     typed, over ldaps;
//   - a password of their own, kept here (scrypt), set through a one-time link.
// Whoever the provider or directory vouches for still has to be in People & departments, and active:
// nobody is made a person by signing in. Wrong passwords lock the sign-in id for a while; every sign-in,
// refusal, sign-out and password set is in the audit trail (object "$auth").
//
// The plant's policy (server.mjs, from the environment; `policyOf`): how long a password lasts and how
// many earlier ones it may not repeat (Part 11 §11.300), whether a password sign-in asks a second factor
// (an authenticator app, RFC 6238), how long a session may sit idle, and whether a signature asks its
// signer to prove who they are again (Part 11 §11.200).
import { constants, createHash, createHmac, createPublicKey, randomBytes, scrypt as scryptCb, timingSafeEqual, verify } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { promisify } from "node:util";
import { appendAudit } from "./audit.js";
import { openSecret } from "./seal.js";

const scrypt = promisify(scryptCb);
export const LOCK_AFTER = 5;
export const LOCK_MINUTES = 15;
export const MIN_PASSWORD = 12;
export const LINK_HOURS = 72;
// A password link lasts this many days unless the plant says (PASSWORD_LINK_DAYS), and at most LINK_MAX_DAYS:
// long enough to reach someone on leave, short enough that a link forgotten in a mailbox dies.
export const LINK_DAYS = 3;
export const LINK_MAX_DAYS = 14;
export function linkDaysOf(env = {}) {
    const v = env.PASSWORD_LINK_DAYS;
    if (v === undefined || v === "") return LINK_DAYS;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > LINK_MAX_DAYS) throw new Error(`PASSWORD_LINK_DAYS is a whole number of days, 1 to ${LINK_MAX_DAYS}, not "${v}".`);
    return n;
}
// A sign-in id is what People & departments names a person by: short, plain, safe in an LDAP name.
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ---- passwords ----
// scrypt, N 2^15, r 8, p 1 (32 MiB): its parameters and salt kept in the hash, so they can grow later.
const N = 1 << 15, R = 8, P = 1, KEYLEN = 32;
export async function hashPassword(password) {
    const salt = randomBytes(16);
    const key = await scrypt(String(password).normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
    return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
export async function verifyPassword(password, stored) {
    const [kind, n, r, p, salt, key] = String(stored ?? "").split("$");
    if (kind !== "scrypt") return false;
    const want = Buffer.from(key, "base64url");
    const got = await scrypt(String(password).normalize("NFKC"), Buffer.from(salt, "base64url"), want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024 });
    return got.length === want.length && timingSafeEqual(got, want);
}
// Spent on a sign-in id that has no password, so a wrong id takes as long as a wrong password.
let decoy = null;
export const spendDecoy = async (password) => { await verifyPassword(password, await (decoy ??= hashPassword(randomBytes(16).toString("hex")))); return false; };

// What is wrong with a new password: "short", "long", "id" (it contains the sign-in id), or null.
export function passwordProblem(password, userId) {
    if (typeof password !== "string" || password.length < MIN_PASSWORD) return "short";
    if (password.length > 256) return "long";
    if (userId && password.toLowerCase().includes(String(userId).toLowerCase())) return "id";
    return null;
}

const tokenHash = (token) => createHash("sha256").update(String(token)).digest("hex");

// ---- the plant's policy ----
// { maxDays: a password's life (0 none), history: earlier passwords it may not repeat, mfa: "off" |
//   "optional" | "required" (password sign-ins), idleMinutes: a session's idle time (0 none),
//   signWithPassword: a signature asks its signer's password or a fresh single sign-on }
export const policyOf = (signIn = {}) => ({
    maxDays: Number.isInteger(signIn.passwordMaxDays) && signIn.passwordMaxDays > 0 ? signIn.passwordMaxDays : 0,
    history: Number.isInteger(signIn.passwordHistory) && signIn.passwordHistory > 0 ? Math.min(signIn.passwordHistory, 24) : 0,
    mfa: ["optional", "required"].includes(signIn.mfa) ? signIn.mfa : "off",
    idleMinutes: Number.isInteger(signIn.idleMinutes) && signIn.idleMinutes > 0 ? signIn.idleMinutes : 0,
    signWithPassword: Boolean(signIn.signWithPassword) && !signIn.picker,
});
// Has a password set at `setAt` outlived the policy? → the moment it expired, or null.
export function expiredAt(setAt, policy) {
    if (!policy.maxDays || !setAt) return null;
    const at = new Date(new Date(setAt).getTime() + policy.maxDays * 86400_000);
    return at.getTime() <= Date.now() ? at : null;
}
export const expiresAt = (setAt, policy) => (policy.maxDays && setAt ? new Date(new Date(setAt).getTime() + policy.maxDays * 86400_000) : null);
// Is `password` one of the person's last `policy.history` (of that kind)? Checked against their hashes.
export async function reused(db, userId, kind, password, policy, current = null) {
    if (!policy.history) return false;
    const rows = await db.query("SELECT hash FROM mes.password_history WHERE user_id = $1 AND kind = $2 ORDER BY set_at DESC LIMIT $3", [userId, kind, policy.history]);
    for (const h of [current, ...rows.map((r) => r.hash)].filter(Boolean)) if (await verifyPassword(password, h)) return true;
    return false;
}
// A password replaced: the one going out kept in the history (the one in use is checked as it is), the
// oldest beyond what the policy keeps let go. Nothing to keep where there was none.
export async function remember(q, userId, kind, outgoing, policy) {
    if (!outgoing || !policy.history) return;
    await q.query("INSERT INTO mes.password_history (user_id, kind, hash) VALUES ($1, $2, $3)", [userId, kind, outgoing]);
    await q.query("DELETE FROM mes.password_history WHERE user_id = $1 AND kind = $2 AND set_at < (SELECT min(set_at) FROM (SELECT set_at FROM mes.password_history WHERE user_id = $1 AND kind = $2 ORDER BY set_at DESC LIMIT $3) kept)", [userId, kind, Math.max(policy.history, 1)]);
}

// ---- a second factor: an authenticator app (TOTP, RFC 6238: HMAC-SHA1, 6 digits, 30 s) ----
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(bytes) {
    let bits = 0, value = 0, out = "";
    for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}
export function fromBase32(text) {
    let bits = 0, value = 0;
    const out = [];
    for (const ch of String(text).toUpperCase().replace(/[\s=-]/g, "")) {
        const i = B32.indexOf(ch);
        if (i < 0) throw new Error("not base32");
        value = (value << 5) | i; bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out);
}
// The code for one time step (RFC 4226 §5.3, dynamic truncation).
export function hotp(secret, counter, digits = 6) {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const mac = createHmac("sha1", fromBase32(secret)).update(msg).digest();
    const off = mac[mac.length - 1] & 15;
    const n = ((mac[off] & 127) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
    return String(n % 10 ** digits).padStart(digits, "0");
}
export const timeStep = (ms = Date.now()) => Math.floor(ms / 30_000);
// The step a code belongs to, a step either side allowed (a phone's clock a little off), and only one
// later than the last taken (a code is good once). → the step, or null.
export function totpStep(secret, code, lastStep = 0, ms = Date.now()) {
    const given = String(code ?? "").replace(/\s/g, "");
    if (!/^\d{6}$/.test(given)) return null;
    const now = timeStep(ms);
    for (const step of [now, now - 1, now + 1]) {
        if (step <= Number(lastStep)) continue;
        const want = hotp(secret, step);
        if (want.length === given.length && timingSafeEqual(Buffer.from(want), Buffer.from(given))) return step;
    }
    return null;
}
export const newTotpSecret = () => base32(randomBytes(20));
// What an authenticator app reads (a link to tap, or the key typed in): the plant's name and the person.
export const otpauthUri = (secret, userId, issuer = "OpenCore MES") => `otpauth://totp/${encodeURIComponent(`${issuer}:${userId}`)}?${new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" })}`;
// Recovery codes: ten, given once, each good once (only their SHA-256 kept). "xxxx-xxxx-xx".
export function recoveryCodes(n = 10) {
    return Array.from({ length: n }, () => { const t = base32(randomBytes(7)).toLowerCase().slice(0, 10); return `${t.slice(0, 4)}-${t.slice(4, 8)}-${t.slice(8)}`; });
}
export const codeHash = (code) => tokenHash(String(code).toLowerCase().replace(/[^a-z0-9]/g, ""));
// A code typed at sign-in or at a signature: the authenticator's (once per step), or a recovery code
// (once). → "totp" | "recovery" | null.
export async function checkSecondFactor(db, userId, code) {
    const [m] = await db.query("SELECT secret, last_step FROM mes.mfa WHERE user_id = $1 AND enabled_at IS NOT NULL", [userId]);
    if (!m) return null;
    const step = totpStep(openSecret(m.secret), code, m.last_step);
    if (step !== null) {
        // Taken by this sign-in: the same code sent twice at once is good for one of them only.
        const [took] = await db.query("UPDATE mes.mfa SET last_step = $2 WHERE user_id = $1 AND last_step < $2 RETURNING user_id", [userId, step]);
        return took ? "totp" : null;
    }
    const [used] = await db.query("UPDATE mes.mfa_recovery SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING user_id", [userId, codeHash(code)]);
    return used ? "recovery" : null;
}

// ---- a sign-in half done (a second factor, or a new password still to give): a few minutes ----
export const PENDING_MINUTES = 10;
export async function startPending(db, { userId, method, step, returnTo = "/" }) {
    const token = randomBytes(32).toString("base64url");
    await db.query("DELETE FROM mes.sign_in_pending WHERE expires_at < now() OR user_id = $1", [userId]);
    await db.query("INSERT INTO mes.sign_in_pending (token_hash, user_id, method, step, return_to, expires_at) VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))", [tokenHash(token), userId, method, step, returnTo, PENDING_MINUTES]);
    return token;
}
export async function pendingOf(db, token) {
    if (typeof token !== "string" || !token) return null;
    const [row] = await db.query("SELECT * FROM mes.sign_in_pending WHERE token_hash = $1 AND expires_at > now()", [tokenHash(token)]);
    return row ?? null;
}
export const endPending = (db, token) => db.query("DELETE FROM mes.sign_in_pending WHERE token_hash = $1", [tokenHash(token)]);

// A one-time link to set a password: the token itself is given once and only its hash kept.
export async function issuePasswordLink(db, userId, { by, hours = LINK_HOURS } = {}) {
    const [user] = await db.query("SELECT id FROM mes.users WHERE id = $1 AND active", [userId]);
    if (!user) throw new Error(`${userId} is not an active person in People & departments.`);
    const token = randomBytes(32).toString("base64url");
    await db.transaction(async (tx) => {
        // A new link replaces the person's earlier ones.
        await tx.query("UPDATE mes.password_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [userId]); // a code too
        await tx.query("INSERT INTO mes.password_tokens (token_hash, user_id, made_by, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))", [tokenHash(token), userId, by, hours]);
        await appendAudit(tx, { actor: by, object: "$auth", action: "password link", after: { user: userId, hours } });
    });
    return { token, path: `/password?token=${token}` };
}

// The sign-in id as typed (§8.2, §27): trimmed, lower case, and, where People & departments names the plant's
// domains (`signIn.domains`), with one of them dropped: PLANT\jdoe, PLANT/jdoe and jdoe@plant.local are jdoe
// (a domain it does not name is left, and the id refused as it stands). The rest of the sign-in sees jdoe.
export function signInIdOf(typed, domains = []) {
    const text = String(typed ?? "").trim();
    const ours = new Set((Array.isArray(domains) ? domains : []).map((d) => String(d).toLowerCase()));
    const slash = text.search(/[\\/]/);
    if (slash > 0 && ours.has(text.slice(0, slash).toLowerCase())) return text.slice(slash + 1).trim().toLowerCase();
    const at = text.lastIndexOf("@");
    if (at > 0 && ours.has(text.slice(at + 1).toLowerCase())) return text.slice(0, at).trim().toLowerCase();
    return text.toLowerCase();
}
// What People & departments says of the sign-in page: { idLabel, idHint, domains } (organization.js).
export async function signInSettings(db) {
    const [row] = await db.query("SELECT body->'signIn' AS s FROM mes.organization WHERE status = 'published'");
    return row?.s && typeof row.s === "object" ? row.s : {};
}

// Setup codes (§8.2): for people with no mail or computer of their own, a code on a printed slip they type
// with their sign-in id, at any station, to set their first password. Five capital letters (no I or O, read
// as 1 and 0 on paper); only a hash kept, bound to the person, so two people may hold the same letters. A
// code lasts as long as a link and replaces the person's earlier code or link; after CODE_TRIES wrong tries
// it is spent (a new one from a sign-in administrator), on top of the sign-in id's own lock.
export const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 5;
export const CODE_TRIES = 5;
export function newSetupCode() {
    // Rejection sampling: 24 does not divide 256, so bytes past 240 are drawn again (no letter favoured).
    let code = "";
    while (code.length < CODE_LENGTH) for (const b of randomBytes(8)) if (b < 240 && code.length < CODE_LENGTH) code += CODE_LETTERS[b % 24];
    return code;
}
// As typed: spaces and dashes dropped, lower case raised.
export const setupCodeOf = (typed) => String(typed ?? "").replace(/[\s-]/g, "").toUpperCase();
export const setupCodeHash = (userId, code) => tokenHash(`code:${userId}:${setupCodeOf(code)}`);
// Codes for many people at once (a whole department's slips): each a new code, their earlier codes and
// links spent, one entry in the trail naming who was given one (never the codes). → [{ id, code }]
export async function issueSetupCodes(db, userIds, { by, hours = LINK_HOURS, about = null } = {}) {
    const issued = userIds.map((id) => ({ id, code: newSetupCode() }));
    if (!issued.length) return issued;
    await db.transaction(async (tx) => {
        await tx.query("UPDATE mes.password_tokens SET used_at = now() WHERE user_id = ANY($1::text[]) AND used_at IS NULL", [userIds]);
        await tx.query(
            "INSERT INTO mes.password_tokens (token_hash, user_id, made_by, expires_at, kind) SELECT h, u, $3, now() + make_interval(hours => $4), 'code' FROM unnest($1::text[], $2::text[]) AS t(h, u)",
            [issued.map((i) => setupCodeHash(i.id, i.code)), issued.map((i) => i.id), by, hours],
        );
        await appendAudit(tx, { actor: by, object: "$auth", action: "setup codes", after: { count: issued.length, hours, ...(about ? { about } : {}), users: userIds } });
    });
    return issued;
}
// A code typed with a sign-in id: the person's live code if it is that one (→ "ok"), else a wrong try
// counted against the code ("wrong", or "spent" at the last try); "spent" too when the code they were
// given is used up or past its time (they ask for a new one), "none" when they were given none lately.
export async function checkSetupCode(db, userId, typed) {
    const [live] = await db.query("SELECT token_hash FROM mes.password_tokens WHERE user_id = $1 AND kind = 'code' AND used_at IS NULL AND expires_at > now()", [userId]);
    if (!live) return (await db.query("SELECT 1 FROM mes.password_tokens WHERE user_id = $1 AND kind = 'code' LIMIT 1", [userId])).length ? "spent" : "none";
    const given = setupCodeHash(userId, typed);
    if (given.length === live.token_hash.length && timingSafeEqual(Buffer.from(given), Buffer.from(live.token_hash))) return "ok";
    const [row] = await db.query("UPDATE mes.password_tokens SET tries = tries + 1, used_at = CASE WHEN tries + 1 >= $2 THEN now() END WHERE token_hash = $1 AND used_at IS NULL RETURNING used_at", [live.token_hash, CODE_TRIES]);
    return row?.used_at ? "spent" : "wrong";
}

// ---- the plant's directory: an LDAP simple bind ----
// Just enough BER for a BindRequest and its response (RFC 4511 §4.2): the person is who the directory
// says the name and password belong to; nothing is searched or read.
function berLength(n) {
    if (n < 0x80) return Buffer.from([n]);
    const bytes = [];
    for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const ber = (tag, content) => Buffer.concat([Buffer.from([tag]), berLength(content.length), content]);
const berInt = (n) => ber(0x02, Buffer.from([n]));
export function bindRequest(messageId, dn, password) {
    return ber(0x30, Buffer.concat([berInt(messageId), ber(0x60, Buffer.concat([berInt(3), ber(0x04, Buffer.from(dn, "utf8")), ber(0x80, Buffer.from(password, "utf8"))]))]));
}
// One element at `at`: { tag, start, end } of its content, or null while incomplete.
export function berRead(buf, at = 0) {
    if (buf.length < at + 2) return null;
    let len = buf[at + 1], start = at + 2;
    if (len & 0x80) {
        const count = len & 0x7f;
        if (count > 4 || buf.length < start + count) return null;
        len = 0;
        for (let i = 0; i < count; i++) len = len * 256 + buf[start + i];
        start += count;
    }
    return buf.length < start + len ? null : { tag: buf[at], start, end: start + len };
}
// The bind's result code: 0 success, 49 invalid credentials, …
export function bindResult(buf) {
    const msg = berRead(buf);
    if (!msg || msg.tag !== 0x30) return null;
    const id = berRead(buf, msg.start);
    const op = id && berRead(buf, id.end);
    if (!op || op.tag !== 0x61) return null;
    const code = berRead(buf, op.start);
    return code && code.tag === 0x0a ? buf.readUIntBE(code.start, code.end - code.start) : null;
}
// The DN a sign-in id binds as: the template's {user} (an AD UPN "{user}@plant.local", or
// "uid={user},ou=people,dc=plant,dc=example"). The id is plain (ID_PATTERN), so nothing needs escaping.
export const userDn = (template, userId) => template.replaceAll("{user}", userId);

export function ldapBind({ url, userDn: template, ca = null, timeoutMs = 5000 }, userId, password) {
    // An empty password is an anonymous bind, which most directories accept: never a sign-in.
    if (!password) return Promise.resolve({ ok: false, reason: "wrong" });
    const u = new URL(url);
    const secure = u.protocol === "ldaps:";
    const port = Number(u.port || (secure ? 636 : 389));
    return new Promise((resolve) => {
        let done = false;
        let data = Buffer.alloc(0);
        const finish = (result) => { if (done) return; done = true; socket.destroy(); resolve(result); };
        const socket = secure
            ? tls.connect({ host: u.hostname, port, servername: net.isIP(u.hostname) ? undefined : u.hostname, ...(ca ? { ca } : {}) })
            : net.connect({ host: u.hostname, port });
        socket.setTimeout(timeoutMs, () => finish({ ok: false, reason: "directory", detail: "the directory did not answer in time" }));
        socket.on("error", (error) => finish({ ok: false, reason: "directory", detail: error.message }));
        socket.on(secure ? "secureConnect" : "connect", () => socket.write(bindRequest(1, userDn(template, userId), password)));
        socket.on("data", (chunk) => {
            data = Buffer.concat([data, chunk]);
            if (!berRead(data)) return;
            const code = bindResult(data);
            // Unbind, politely, then close.
            socket.write(Buffer.from([0x30, 0x05, 0x02, 0x01, 0x02, 0x42, 0x00]));
            finish(code === 0 ? { ok: true } : code === 49 ? { ok: false, reason: "wrong" } : { ok: false, reason: "directory", detail: `the directory answered ${code}` });
        });
    });
}

// ---- single sign-on: OpenID Connect ----
const b64url = (buf) => Buffer.from(buf).toString("base64url");
export function createOidc({ issuer, clientId, clientSecret = null, scopes = "openid profile email", claim = "preferred_username", fetchFn = fetch }) {
    let meta = null, metaAt = 0, keys = null;
    const discover = async () => {
        if (meta && Date.now() - metaAt < 3600_000) return meta;
        const res = await fetchFn(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
        if (!res.ok) throw new Error(`the provider's configuration answered ${res.status}`);
        // Checked before it is kept: a document from another issuer must fail every time, not once.
        const got = await res.json();
        if (got.issuer !== issuer) throw new Error(`the provider calls itself ${got.issuer}, not ${issuer}`);
        meta = got;
        metaAt = Date.now();
        return meta;
    };
    const jwks = async (refresh) => {
        if (keys && !refresh) return keys;
        const res = await fetchFn((await discover()).jwks_uri);
        if (!res.ok) throw new Error(`the provider's keys answered ${res.status}`);
        keys = (await res.json()).keys ?? [];
        return keys;
    };
    // The ID token's claims once its signature, issuer, audience, time and nonce hold; else it throws.
    const verifyIdToken = async (jwt, nonce) => {
        const [h, p, s] = String(jwt).split(".");
        if (!s) throw new Error("not a signed token");
        const header = JSON.parse(Buffer.from(h, "base64url"));
        const algs = { RS256: { hash: "sha256" }, RS384: { hash: "sha384" }, RS512: { hash: "sha512" }, ES256: { hash: "sha256", dsaEncoding: "ieee-p1363" }, ES384: { hash: "sha384", dsaEncoding: "ieee-p1363" }, PS256: { hash: "sha256", pss: true } };
        const alg = algs[header.alg];
        if (!alg) throw new Error(`the token is signed with ${header.alg}, which is not accepted`);
        const pick = (set) => set.find((k) => (header.kid ? k.kid === header.kid : true) && (!k.use || k.use === "sig"));
        const jwk = pick(await jwks(false)) ?? pick(await jwks(true));
        if (!jwk) throw new Error("the token's key is not among the provider's");
        const key = createPublicKey({ key: jwk, format: "jwk" });
        const ok = verify(alg.hash, Buffer.from(`${h}.${p}`), alg.pss ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : alg.dsaEncoding ? { key, dsaEncoding: alg.dsaEncoding } : key, Buffer.from(s, "base64url"));
        if (!ok) throw new Error("the token's signature does not hold");
        const claims = JSON.parse(Buffer.from(p, "base64url"));
        const now = Date.now() / 1000;
        if (claims.iss !== issuer) throw new Error("the token is from another issuer");
        const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (!aud.includes(clientId) || (aud.length > 1 && claims.azp && claims.azp !== clientId)) throw new Error("the token is for another client");
        if (!(claims.exp > now - 60)) throw new Error("the token has expired");
        if (claims.nbf && claims.nbf > now + 60) throw new Error("the token is not valid yet");
        if (claims.nonce !== nonce) throw new Error("the token's nonce does not match this sign-in");
        return claims;
    };
    return {
        claim,
        // Where to send the browser: { url, state, verifier, nonce }.
        // `again`: { prompt: "login", maxAge: 0 } for a fresh sign-in (a signature, §7.4): the provider asks
        // the person whatever it remembers, and says when they signed in (auth_time).
        async start(redirectUri, again = null) {
            const m = await discover();
            const state = b64url(randomBytes(24)), verifier = b64url(randomBytes(32)), nonce = b64url(randomBytes(24));
            const challenge = b64url(createHash("sha256").update(verifier).digest());
            const url = new URL(m.authorization_endpoint);
            for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: scopes, state, nonce, code_challenge: challenge, code_challenge_method: "S256", ...(again ? { prompt: again.prompt ?? "login", max_age: String(again.maxAge ?? 0) } : {}) })) url.searchParams.set(k, v);
            return { url: url.href, state, verifier, nonce };
        },
        // The code exchanged for tokens, and the ID token checked: → claims.
        async finish({ code, verifier, nonce, redirectUri }) {
            const m = await discover();
            const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier, client_id: clientId });
            const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
            if (clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
            const res = await fetchFn(m.token_endpoint, { method: "POST", headers, body: form.toString() });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.id_token) throw new Error(`the provider refused the code (${body.error ?? res.status})`);
            return verifyIdToken(body.id_token, nonce);
        },
    };
}

// ---- lockout and the trail ----
export async function lockedUntil(db, id) {
    const [row] = await db.query("SELECT locked_until FROM mes.sign_in_failures WHERE user_id = $1 AND locked_until > now()", [id]);
    return row?.locked_until ?? null;
}
// A wrong password counted: the id locked once there have been LOCK_AFTER in a row. → locked?
// One statement, so tries sent at once are counted one after another (the row's lock): a lock that
// stands is never lifted or shortened by a try that was already on its way.
export async function countFailure(db, id) {
    const [row] = await db.query(
        `INSERT INTO mes.sign_in_failures AS f (user_id, failures, last_at) VALUES ($1, 1, now())
         ON CONFLICT (user_id) DO UPDATE SET
             failures = CASE WHEN f.locked_until > now() THEN f.failures
                             WHEN f.locked_until IS NOT NULL THEN 1
                             WHEN f.failures + 1 >= $2 THEN 0
                             ELSE f.failures + 1 END,
             locked_until = CASE WHEN f.locked_until > now() THEN f.locked_until
                                 WHEN f.locked_until IS NULL AND f.failures + 1 >= $2 THEN now() + make_interval(mins => $3)
                                 ELSE NULL END,
             last_at = now()
         RETURNING (locked_until > now()) AS locked`,
        [id, LOCK_AFTER, LOCK_MINUTES],
    );
    return row.locked === true;
}
export const clearFailures = (db, id) => db.query("DELETE FROM mes.sign_in_failures WHERE user_id = $1", [id]);
// What the sign-in administrators are told (G9): ids locked, and wrong passwords spread over many ids
// in a short while (someone trying a few common passwords on everyone). From the trail, the last day.
export const SPRAY = { ids: 10, minutes: 10 };
export async function signInAlerts(db) {
    const locks = await db.query(`SELECT actor, max(at) AS at, count(*)::int AS n FROM mes.audit_log WHERE object = '$auth' AND action IN ('sign-in refused', 'signature refused') AND after->>'reason' = 'locked' AND at > now() - interval '24 hours' GROUP BY actor ORDER BY max(at) DESC LIMIT 20`);
    const [spray] = await db.query(`SELECT count(DISTINCT actor)::int AS ids, max(at) AS at FROM mes.audit_log WHERE object = '$auth' AND action = 'sign-in refused' AND after->>'reason' IN ('wrong', 'locked') AND at > now() - make_interval(mins => $1)`, [SPRAY.minutes]);
    return { locks, spray: spray?.ids >= SPRAY.ids ? spray : null };
}

// One entry in the trail, in its own transaction. `who` is the person, or the id that was tried.
export const audit = (db, who, action, after) => db.transaction((tx) => appendAudit(tx, { actor: String(who ?? "unknown").slice(0, 80) || "unknown", object: "$auth", action, after }));
