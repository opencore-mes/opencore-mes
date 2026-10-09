// Signatures by two people (DESIGN.md §7.4, Part 11 §11.50, §11.70, §11.200): a second person signed in
// beside the first at a station, at most two, until either signs out; a transaction that needs a
// verifier is signed by both, each re-entering their password at every submit. A password is checked
// as at sign-in: their own here, else their signing password (for those who sign in through single
// sign-on), else the plant's directory; wrong ones count towards the same lock. A development or demo
// instance (the picker: anyone as anyone) and a sandbox ask for no password; who signs is checked all
// the same.
//
// Where the plant's policy asks it (`signWithPassword`, Part 11 §11.200), every signature does: a
// transaction signed by one, a change approved, a record change approved. The signer proves who they
// are with their password, or with a fresh sign-in at the identity provider (`{ sso: true }`: one made
// in this session, for this person, in the last few minutes, spent by this signature).
import { ID_PATTERN, signInIdOf, signInSettings, audit, clearFailures, countFailure, hashPassword, ldapBind, lockedUntil, passwordProblem, spendDecoy, verifyPassword, policyOf, expiredAt, reused, remember } from "./sign-in.js";
import { fail } from "@opencore-mes/juris-kit/errors.js";
import { sessionKey } from "./store.js";

// How long a fresh sign-in at the provider stays good for the signature it was made for.
export const REAUTH_MINUTES = 5;

export function createSignatures({ store, signIn = {}, sandbox = false }) {
    const { db } = store;
    const noPasswords = Boolean(signIn.picker || sandbox);
    const policy = policyOf(signIn);
    // Whether a signature asks its signer to prove who they are (the plant's policy; never a picker or a sandbox).
    const asksProof = policy.signWithPassword && !noPasswords;

    // Is this their password? → { ok } or { ok: false, reason: "locked" | "wrong" | "directory" }.
    async function checkPassword(userId, password, what) {
        if (await lockedUntil(db, userId)) return { ok: false, reason: "locked" };
        if (typeof password !== "string" || !password) return { ok: false, reason: "wrong", empty: true };
        const [own] = signIn.passwords ? await db.query("SELECT hash, set_at FROM mes.credentials WHERE user_id = $1", [userId]) : [];
        const [signing] = own ? [] : await db.query("SELECT hash, set_at FROM mes.signing_credentials WHERE user_id = $1", [userId]);
        let ok = false, method = own ? "password" : signing ? "signing password" : signIn.ldap ? "directory" : "none";
        if (own) ok = await verifyPassword(password, own.hash);
        else if (signing) ok = await verifyPassword(password, signing.hash);
        else if (signIn.ldap) {
            const bound = await ldapBind(signIn.ldap, userId, password);
            if (bound.reason === "directory") { await audit(db, userId, "signature refused", { what, method, reason: "directory" }); return { ok: false, reason: "directory" }; }
            ok = bound.ok;
        } else ok = await spendDecoy(password);
        if (!ok) {
            const locked = await countFailure(db, userId);
            await audit(db, userId, "signature refused", { what, method, reason: locked ? "locked" : "wrong" });
            return { ok: false, reason: locked ? "locked" : "wrong" };
        }
        if (await lockedUntil(db, userId)) return { ok: false, reason: "locked" };
        await clearFailures(db, userId);
        // A password past the plant's limit signs nothing until it is changed (Part 11 §11.300).
        if (expiredAt((own ?? signing)?.set_at, policy)) { await audit(db, userId, "signature refused", { what, method, reason: "expired" }); return { ok: false, reason: "expired", method }; }
        return { ok: true, method };
    }
    // A fresh sign-in at the provider, made in this session for this person: spent by this signature.
    async function freshSignIn(self, userId, what) {
        const [row] = self?.sessionId ? await db.query("DELETE FROM mes.session_reauth WHERE session_id = $1 AND user_id = $2 RETURNING at > now() - make_interval(mins => $3) AS fresh", [sessionKey(self.sessionId), userId, REAUTH_MINUTES]) : [];
        if (!row?.fresh) { await audit(db, userId, "signature refused", { what, method: "sso", reason: row ? "stale" : "none" }); return { ok: false, reason: row ? "stale" : "nosso" }; }
        return { ok: true, method: "sso" };
    }
    // One signer proving who they are, with what the page sent: { password } or { sso: true }. → { ok, method } or the refusal.
    const prove = (self, userId, given, what) => (given?.sso === true ? freshSignIn(self, userId, what) : checkPassword(userId, given?.password, what));
    const refusedWords = (who, r) => (r.reason === "locked" ? `${who}: too many wrong passwords. Try again in 15 minutes.`
        : r.reason === "directory" ? "The plant's directory did not answer: try again, or ask IT."
        : r.reason === "expired" ? `${who}: the ${r.method === "signing password" ? "signing password" : "password"} has expired. Set a new one on the password page (your name, top right), then sign again.`
        : r.reason === "nosso" ? `${who}: sign in again with single sign-on first, then sign.`
        : r.reason === "stale" ? `${who}: that single sign-on was more than ${REAUTH_MINUTES} minutes ago. Sign in again, then sign.`
        : r.empty ? `${who}: enter the password.` : `${who}: the password is wrong.`);

    const sessionUser = async (self) => {
        const user = await store.userForSession(self?.sessionId);
        if (!user) fail("Sign in first.", { status: 401 });
        return user;
    };

    // Who may verify, as a design names them: a member of one of its departments, or holding one of its
    // roles ("<object>.<role>").
    async function mayVerify(userId, verifier) {
        const depts = Array.isArray(verifier?.departments) ? verifier.departments : [];
        if (depts.length && (await db.query("SELECT 1 FROM mes.group_members WHERE user_id = $1 AND group_id = ANY($2) LIMIT 1", [userId, depts])).length) return true;
        for (const r of Array.isArray(verifier?.roles) ? verifier.roles : []) {
            const [object, role] = String(r).split(".");
            if (object && role && (await store.rolesFor(userId, object)).includes(role)) return true;
        }
        return false;
    }
    const whoWords = (verifier) => [...(verifier?.departments ?? []).map((d) => `department ${d}`), ...(verifier?.roles ?? []).map((r) => `role ${r}`)].join(" or ");

    // The signatures of a run of a transaction whose design names a verifier, checked: the person running
    // it re-enters their password, the second person signed in beside them (in a sandbox, the one the
    // scenario names) may verify it and re-enters theirs. → what the run's audit entry keeps.
    async function signRun(self, user, body, signature) {
        const v = body.signature.verifier;
        if (!noPasswords && !self?.sessionId) fail(`${body.label} is signed by two people at a screen, each with their password: it cannot be run from here.`, { status: 403, code: "transaction.signature" });
        let second = null;
        if (sandbox && typeof signature?.verifier === "string") second = await store.user(signature.verifier);
        else second = (await store.userForSession(self?.sessionId))?.second ?? null;
        if (!second) fail(`${body.label} needs a second person to verify it (“${v.meaning}”): add a second person (beside your name at the top), then submit again.`, { fields: { _verifier: "A second person signs in first." }, code: "transaction.verifier" });
        if (second.id === user.id) fail("The second person is someone else.", { fields: { _verifier: "Someone else." }, code: "transaction.verifier" });
        if (!(await mayVerify(second.id, v))) fail(`${second.name} may not verify ${body.label}: it is verified by someone of ${whoWords(v)}.`, { fields: { _verifier: "Not one who may verify this." }, code: "transaction.verifier" });
        let methods = null;
        if (!noPasswords) {
            const mine = await prove(self, user.id, { password: signature?.password, sso: signature?.sso }, `transaction ${body.label}`);
            if (!mine.ok) fail(refusedWords("Your signature", mine), { fields: { _password: mine.reason === "locked" ? "Locked for 15 minutes." : "Check your password." }, code: "transaction.signature" });
            const theirs = await prove(self, second.id, { password: signature?.secondPassword, sso: signature?.secondSso }, `verifying ${body.label}`);
            if (!theirs.ok) fail(refusedWords(`${second.name}'s signature`, theirs), { fields: { _secondPassword: theirs.reason === "locked" ? "Locked for 15 minutes." : "Check the password." }, code: "transaction.signature" });
            methods = { by: mine.method, verifier: theirs.method };
        }
        return { meaning: body.signature.meaning, by: { id: user.id, name: user.name }, verifier: { id: second.id, name: second.name, meaning: v.meaning }, passwords: !noPasswords, ...(methods ? { methods } : {}) };
    }
    // A signature by one (a transaction signed by one, a change or a record change approved), where the
    // plant asks its signer to prove who they are: in their own session, with their password or a fresh
    // single sign-on. → what the audit keeps of it, or null where nothing is asked.
    async function signOne(self, user, what, proof) {
        if (!asksProof) return null;
        if (!self?.sessionId) fail(`Signing ${what} asks for your password, at a screen: it cannot be done from here.`, { status: 403, code: "signature.session" });
        const r = await prove(self, user.id, proof, what);
        if (!r.ok) fail(refusedWords("Your signature", r), { fields: { _password: r.reason === "locked" ? "Locked for 15 minutes." : r.reason === "nosso" || r.reason === "stale" ? "Sign in again first." : "Check your password." }, code: "signature.refused" });
        await audit(db, user.id, "signed", { what, method: r.method });
        return { printedName: user.name, method: r.method };
    }

    const services = {
        // A second person signs in beside the one signed in (two at most): their sign-in id and password.
        async "auth.second.join"({ id, password } = {}) {
            const user = await sessionUser(this);
            if (user.second) fail(`${user.second.name} is signed in beside you already: two at most. They sign out first.`, { status: 409, code: "second.full" });
            const who = signInIdOf(id, (await signInSettings(db)).domains);
            if (!ID_PATTERN.test(who)) fail("Enter their sign-in id.", { fields: { id: "Required." } });
            if (who === user.id) fail("The second person is someone else.", { fields: { id: "Someone else." } });
            const second = await store.user(who);
            if (!noPasswords) {
                const r = await checkPassword(who, password, "second sign-in");
                // Wrong id or wrong password, said alike (as at sign-in): nothing tells which ids exist.
                if (!r.ok) fail(r.reason === "locked" ? "Too many wrong passwords: try again in 15 minutes." : r.reason === "directory" ? "The plant's directory did not answer: try again, or ask IT." : "That sign-in id and password do not match.", { fields: { password: "Check them." }, code: "second.refused" });
            }
            if (!second) fail("That person is not in People & departments, or has left.", { fields: { id: "Not someone here." }, code: "second.refused" });
            const done = await db.query("UPDATE mes.sessions SET second_user_id = $2, second_since = now() WHERE id = $1 AND second_user_id IS NULL RETURNING id", [sessionKey(this.sessionId), second.id]);
            if (!done.length) fail("Someone signed in beside you meanwhile: two at most.", { status: 409, code: "second.full" });
            await audit(db, second.id, "second sign-in", { beside: user.id, passwords: !noPasswords });
            return { second: { id: second.id, name: second.name } };
        },
        // The second person signs out; the first stays signed in.
        async "auth.second.leave"() {
            const user = await sessionUser(this);
            if (!user.second) return { second: null };
            await db.query("UPDATE mes.sessions SET second_user_id = NULL, second_since = NULL WHERE id = $1", [sessionKey(this.sessionId)]);
            await audit(db, user.second.id, "second sign-out", { beside: user.id });
            return { second: null };
        },
        // A signing password, for one with no password of their own here (single sign-on): set, or changed
        // with the current one.
        async "auth.signingPassword"({ current, next, again } = {}) {
            const user = await sessionUser(this);
            const [own] = signIn.passwords ? await db.query("SELECT 1 FROM mes.credentials WHERE user_id = $1", [user.id]) : [];
            if (own) fail("You sign with your own password: there is no signing password to set.", { status: 409 });
            const [had] = await db.query("SELECT hash FROM mes.signing_credentials WHERE user_id = $1", [user.id]);
            if (had) {
                if (await lockedUntil(db, user.id)) fail("Too many wrong passwords: try again in 15 minutes.", { fields: { current: "Locked." } });
                if (!(await verifyPassword(String(current ?? ""), had.hash))) {
                    const locked = await countFailure(db, user.id);
                    await audit(db, user.id, "signing password refused", { reason: locked ? "locked" : "wrong" });
                    fail(locked ? "Too many wrong passwords: try again in 15 minutes." : "Your current signing password is wrong.", { fields: { current: "Check it." } });
                }
            }
            if (next !== again) fail("The two new passwords are not the same.", { fields: { again: "Not the same." } });
            const weak = passwordProblem(String(next ?? ""), user.id);
            if (weak) fail({ short: "A password has at least 12 characters.", long: "A password has at most 256 characters.", id: "A password cannot contain your sign-in id." }[weak] ?? "Choose another password.", { fields: { next: "Choose another." } });
            if (await reused(db, user.id, "signing", String(next), policy, had?.hash)) fail(`Choose a signing password you have not used before (the last ${policy.history} are remembered).`, { fields: { next: "Used before." } });
            const hash = await hashPassword(next);
            await db.transaction(async (tx) => {
                await tx.query("INSERT INTO mes.signing_credentials (user_id, hash) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET hash = $2, set_at = now()", [user.id, hash]);
                await remember(tx, user.id, "signing", had?.hash, policy);
            });
            await clearFailures(db, user.id);
            await audit(db, user.id, "signing password set", { by: "themselves" });
            return { ok: true };
        },
    };
    const touches = { "auth.second.join": [], "auth.second.leave": [], "auth.signingPassword": [{ name: "auth.account" }] };
    return { services, touches, signRun, signOne, noPasswords, asksProof };
}
