// A person's own sign-in, and its administration (DESIGN.md §8.2):
//   their account    what the password page shows: their password and when it expires, their signing
//                    password, their second factor; the second factor set up (an authenticator app, its
//                    recovery codes shown once), its codes renewed, taken off where the plant allows
//   activity         the browser says when the person did something (a click, a key, at most once a
//                    minute), and a page they open says it too: a session idle longer than the plant
//                    allows ends (polling, live updates and presence never count)
//   administration   for whoever holds the sign-in administrator role (People & departments, `auth`):
//                    find a person and see their sign-in (password, its age, second factor, a lock,
//                    sessions, last sign-in), issue a one-time link to set a password, take off a second
//                    factor (a lost phone), lift a lock, end their sessions; and what the sign-in trail
//                    says needs a look (ids locked, wrong passwords spread over many ids). Each audited.
import { fail } from "../../../src/errors.js";
import { sessionKey } from "./store.js";
import { audit, policyOf, expiresAt, expiredAt, lockedUntil, clearFailures, issuePasswordLink, newTotpSecret, otpauthUri, recoveryCodes, codeHash, totpStep, checkSecondFactor, signInAlerts, SPRAY, ID_PATTERN, LINK_HOURS } from "./sign-in.js";

export const ADMIN_ROLE = "administrator";
const iso = (t) => (t instanceof Date ? t.toISOString() : t ?? null);

export function createAccount({ store, signIn = {} }) {
    const { db } = store;
    const policy = policyOf(signIn);
    const me = async (self) => {
        const user = await store.userForSession(self?.sessionId);
        if (!user) fail("Sign in first.", { status: 401 });
        return user;
    };
    const admin = async (self) => {
        const user = await me(self);
        if (!(await store.rolesFor(user.id, "auth")).includes(ADMIN_ROLE)) fail("Sign-in administration is for those People & departments makes sign-in administrators.", { status: 403 });
        return user;
    };
    // Whether a person signs in with a password (theirs here, or the directory's): what a second factor is for.
    const signsWithPassword = async (userId) => Boolean(signIn.ldap) || (signIn.passwords && (await db.query("SELECT 1 FROM mes.credentials WHERE user_id = $1", [userId])).length > 0);
    const mfaOf = async (userId) => (await db.query("SELECT enabled_at FROM mes.mfa WHERE user_id = $1", [userId]))[0] ?? null;

    const services = {
        // The person signed in: their password and signing password, when each expires, their second factor.
        async "auth.account"() {
            const user = await me(this);
            const [own] = signIn.passwords ? await db.query("SELECT set_at FROM mes.credentials WHERE user_id = $1", [user.id]) : [];
            const [signing] = own ? [] : await db.query("SELECT set_at FROM mes.signing_credentials WHERE user_id = $1", [user.id]);
            const mfa = await mfaOf(user.id);
            const codesLeft = mfa?.enabled_at ? (await db.query("SELECT count(*)::int AS n FROM mes.mfa_recovery WHERE user_id = $1 AND used_at IS NULL", [user.id]))[0].n : 0;
            return {
                id: user.id, password: Boolean(own), setAt: iso(own?.set_at), expiresAt: iso(expiresAt(own?.set_at, policy)), expired: Boolean(expiredAt(own?.set_at, policy)),
                sso: Boolean(signIn.sso), signing: Boolean(signing), signingSetAt: iso(signing?.set_at), signingExpiresAt: iso(expiresAt(signing?.set_at, policy)), signingExpired: Boolean(expiredAt(signing?.set_at, policy)),
                picker: Boolean(signIn.picker),
                mfa: { policy: policy.mfa, enabled: Boolean(mfa?.enabled_at), since: iso(mfa?.enabled_at), codesLeft, applies: policy.mfa !== "off" && (await signsWithPassword(user.id)) },
                maxDays: policy.maxDays, history: policy.history, idleMinutes: policy.idleMinutes, signWithPassword: policy.signWithPassword,
            };
        },
        // The person did something (a click, a key): their session's idle clock starts again. A session
        // already idle past the limit stays ended.
        async "auth.active"() {
            if (!this?.sessionId) return { ok: false };
            const [row] = await db.query("UPDATE mes.sessions SET last_seen = now() WHERE id = $1 AND expires_at > now() AND ($2::int = 0 OR last_seen > now() - make_interval(mins => $2::int)) RETURNING id", [sessionKey(this.sessionId), policy.idleMinutes]);
            return { ok: Boolean(row) };
        },

        // ---- their second factor ----
        // Setting it up: a new key and recovery codes, shown once; nothing changes until a code confirms it.
        async "auth.mfa.start"() {
            const user = await me(this);
            if (policy.mfa === "off") fail("A second factor is not used on this installation.", { status: 409 });
            if (!(await signsWithPassword(user.id))) fail("You sign in through single sign-on: your second factor is your identity provider's.", { status: 409 });
            const secret = newTotpSecret();
            const codes = recoveryCodes();
            await db.transaction(async (tx) => {
                // An authenticator already on stays on until the new one is confirmed: kept beside it.
                const [had] = await tx.query("SELECT enabled_at FROM mes.mfa WHERE user_id = $1", [user.id]);
                if (had?.enabled_at) fail("Your authenticator is set up already: take it off first, or renew your recovery codes.", { status: 409 });
                await tx.query("INSERT INTO mes.mfa (user_id, secret) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET secret = $2, enabled_at = NULL, last_step = 0", [user.id, secret]);
                await tx.query("DELETE FROM mes.mfa_recovery WHERE user_id = $1", [user.id]);
                for (const c of codes) await tx.query("INSERT INTO mes.mfa_recovery (user_id, code_hash) VALUES ($1, $2)", [user.id, codeHash(c)]);
            });
            return { secret, uri: otpauthUri(secret, user.id), codes };
        },
        async "auth.mfa.confirm"({ code } = {}) {
            const user = await me(this);
            const [m] = await db.query("SELECT secret FROM mes.mfa WHERE user_id = $1 AND enabled_at IS NULL", [user.id]);
            if (!m) fail("Start setting up your authenticator first.", { status: 409 });
            const step = totpStep(m.secret, code);
            if (step === null) fail("That code is not the one your authenticator shows now: check its clock, and type the 6 digits it shows.", { fields: { code: "Not this code." } });
            await db.query("UPDATE mes.mfa SET enabled_at = now(), last_step = $2 WHERE user_id = $1", [user.id, step]);
            await audit(db, user.id, "second factor set", { by: "themselves", at: "account" });
            return { ok: true };
        },
        // Taken off by the person (with a code from it), where the plant does not require one.
        async "auth.mfa.off"({ code } = {}) {
            const user = await me(this);
            if (policy.mfa === "required") fail("A second factor is required here: it can be replaced, not taken off. A sign-in administrator resets it for a lost phone.", { status: 409 });
            if (!(await checkSecondFactor(db, user.id, code))) fail("Type a code from your authenticator, or a recovery code.", { fields: { code: "Not this code." } });
            await db.query("DELETE FROM mes.mfa_recovery WHERE user_id = $1", [user.id]);
            await db.query("DELETE FROM mes.mfa WHERE user_id = $1", [user.id]);
            await audit(db, user.id, "second factor removed", { by: "themselves" });
            return { ok: true };
        },
        // New recovery codes (the old ones void), with a code from the authenticator.
        async "auth.mfa.codes"({ code } = {}) {
            const user = await me(this);
            if (!(await mfaOf(user.id))?.enabled_at) fail("Set up your authenticator first.", { status: 409 });
            if (!(await checkSecondFactor(db, user.id, code))) fail("Type a code from your authenticator.", { fields: { code: "Not this code." } });
            const codes = recoveryCodes();
            await db.transaction(async (tx) => {
                await tx.query("DELETE FROM mes.mfa_recovery WHERE user_id = $1", [user.id]);
                for (const c of codes) await tx.query("INSERT INTO mes.mfa_recovery (user_id, code_hash) VALUES ($1, $2)", [user.id, codeHash(c)]);
            });
            await audit(db, user.id, "recovery codes renewed", {});
            return { codes };
        },

        // ---- administration ----
        // People, found by id or name (30 at most), with their sign-in as it stands.
        async "auth.admin.people"({ q = "" } = {}) {
            await admin(this);
            const text = String(q ?? "").trim().slice(0, 60);
            const rows = await db.query(
                `SELECT u.id, u.name, u.active, c.set_at AS password_set, s.set_at AS signing_set, m.enabled_at AS mfa, f.locked_until, f.failures,
                        (SELECT count(*)::int FROM mes.sessions x WHERE x.user_id = u.id AND x.expires_at > now()) AS sessions,
                        (SELECT max(at) FROM mes.audit_log a WHERE a.object = '$auth' AND a.action = 'sign-in' AND a.actor = u.id) AS last_sign_in
                 FROM mes.users u LEFT JOIN mes.credentials c ON c.user_id = u.id LEFT JOIN mes.signing_credentials s ON s.user_id = u.id
                 LEFT JOIN mes.mfa m ON m.user_id = u.id AND m.enabled_at IS NOT NULL LEFT JOIN mes.sign_in_failures f ON f.user_id = u.id
                 WHERE $1 = '' OR u.id ILIKE '%' || $1 || '%' OR u.name ILIKE '%' || $1 || '%'
                 ORDER BY (f.locked_until > now()) IS TRUE DESC, u.name LIMIT 30`, [text]);
            return rows.map((r) => ({
                id: r.id, name: r.name, active: r.active, password: Boolean(r.password_set), passwordSetAt: iso(r.password_set), passwordExpired: Boolean(expiredAt(r.password_set, policy)),
                signing: Boolean(r.signing_set), signingExpired: Boolean(expiredAt(r.signing_set, policy)), mfa: Boolean(r.mfa), lockedUntil: r.locked_until && new Date(r.locked_until) > new Date() ? iso(r.locked_until) : null,
                sessions: r.sessions, lastSignIn: iso(r.last_sign_in),
            }));
        },
        // A one-time link to set a password (a new person, a forgotten password), shown once to hand over.
        async "auth.admin.link"({ id, hours = LINK_HOURS } = {}) {
            const by = await admin(this);
            if (!signIn.passwords) fail("This installation signs people in through single sign-on or the directory: there is no password here to set.", { status: 409 });
            if (typeof id !== "string" || !ID_PATTERN.test(id)) fail("Pick the person.", { fields: { id: "Required." } });
            if (!Number.isInteger(hours) || hours < 1 || hours > 168) fail("A link lasts 1 to 168 hours.", { fields: { hours: "1 to 168." } });
            try { return { ...(await issuePasswordLink(db, id, { by: by.id, hours })), hours }; } catch (error) { fail(error.message, { status: 404 }); }
        },
        // A second factor taken off (a lost phone): the person sets up a new one at their next sign-in.
        async "auth.admin.resetMfa"({ id, reason } = {}) {
            const by = await admin(this);
            if (typeof reason !== "string" || !reason.trim()) fail("Say why (a lost phone, a new one).", { fields: { reason: "Required." } });
            const gone = await db.query("DELETE FROM mes.mfa WHERE user_id = $1 RETURNING user_id", [String(id ?? "")]);
            await db.query("DELETE FROM mes.mfa_recovery WHERE user_id = $1", [String(id ?? "")]);
            if (!gone.length) fail("They have no second factor set up.", { status: 404 });
            await audit(db, by.id, "second factor reset", { user: id, reason: reason.trim().slice(0, 300) });
            return { ok: true };
        },
        async "auth.admin.unlock"({ id } = {}) {
            const by = await admin(this);
            if (!(await lockedUntil(db, String(id ?? "")))) fail("That sign-in id is not locked.", { status: 404 });
            await clearFailures(db, String(id));
            await audit(db, by.id, "sign-in unlocked", { user: id });
            return { ok: true };
        },
        async "auth.admin.endSessions"({ id } = {}) {
            const by = await admin(this);
            const ended = await db.query("DELETE FROM mes.sessions WHERE user_id = $1 RETURNING user_id", [String(id ?? "")]);
            await audit(db, by.id, "sessions ended", { user: id, count: ended.length });
            return { ended: ended.length };
        },
        // What the trail says needs a look: ids locked in the last day, wrong passwords spread over many ids.
        async "auth.admin.alerts"() {
            await admin(this);
            const a = await signInAlerts(db);
            return { locks: a.locks.map((l) => ({ id: l.actor, at: iso(l.at), times: l.n })), spray: a.spray ? { ids: a.spray.ids, at: iso(a.spray.at) } : null };
        },
    };
    // The inbox of a sign-in administrator: what needs a look (G9).
    async function inboxOf(user) {
        if (!(await store.rolesFor(user.id, "auth")).includes(ADMIN_ROLE)) return [];
        const a = await signInAlerts(db);
        return [
            ...(a.spray ? [{ kind: "alert", id: "auth:spray", title: `Wrong passwords on ${a.spray.ids} sign-in ids in ${SPRAY.minutes} minutes`, what: "Someone may be trying common passwords on everyone.", link: "/design/sign-in" }] : []),
            ...a.locks.map((l) => ({ kind: "alert", id: `auth:locked:${l.actor}`, title: `${l.actor}: locked after wrong passwords`, what: `${l.n > 1 ? `${l.n} times` : "Once"} in the last day.`, link: `/design/sign-in?q=${encodeURIComponent(l.actor)}` })),
        ];
    }
    const touches = { "auth.account": [], "auth.active": [], "auth.mfa.start": [{ name: "auth.account" }], "auth.mfa.confirm": [{ name: "auth.account" }], "auth.mfa.off": [{ name: "auth.account" }], "auth.mfa.codes": [{ name: "auth.account" }], "auth.admin.people": [], "auth.admin.link": [], "auth.admin.resetMfa": [{ name: "inbox.mine" }], "auth.admin.unlock": [{ name: "inbox.mine" }], "auth.admin.endSessions": [], "auth.admin.alerts": [] };
    return { services, touches, inboxOf, policy };
}
