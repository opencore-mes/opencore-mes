// The one application shell (DESIGN.md §10.1): a searchable object navigator with favorites on the
// left, a workspace of tabs on the right. Everyone uses it; what each person sees is their rights.
import { usePlantFormats, plant } from "./format.js";
import { icon } from "./icons.js";
import { PICKER_SHOWN, MIN_SEARCH, searchWords } from "./people-file.js";
import { windowRows } from "./window-rows.js";
import { schemeOf, PERSONAL, stateBadgeClass } from "./theme.js";

const pathKey = (path) => path.replace(/[.]/g, "_");

// Tabs and favorites are personal preferences, kept server-side (prefs.set) and written here first,
// so the screen answers at once and the live answer confirms it.
function savePrefs(api, patch) {
    for (const [key, value] of Object.entries(patch)) api.setValue(`prefs.${key}`, value);
    return api.call("prefs.set", patch).catch((error) => console.warn("OpenCore MES: preferences not saved", error));
}

// What the navigator finds and a person may star (§10.1): the objects, screens and transactions shared
// with them, and, for those who may ask for one, each report layout (§34.5: it opens the AI Report page
// with the layout picked), each as { fav, kind, to, label, title, words, area }. A favorite is an
// object's name, or "screen:<name>" / "transaction:<name>" / "layout:<name>"; one whose element is gone (retired, a suite removed, no role)
// stays in the preferences, unshown, and shows again when it is back.
export function navEntries(api) {
    return [
        ...(api.getState("nav.objects", []) ?? []).map((o) => ({ fav: o.object, kind: "Object", to: `/o/${o.object}`, label: o.label, title: o.description, area: o.area, words: `${o.label} ${o.object} ${o.description} ${o.area}` })),
        ...(api.getState("nav.screens", []) ?? []).map((x) => ({ fav: `screen:${x.name}`, kind: "Screen", to: `/s/${x.name}`, label: x.label, title: x.description, words: `${x.label} ${x.name} ${x.description} screen` })),
        ...(api.getState("nav.transactions", []) ?? []).map((t) => ({ fav: `transaction:${t.name}`, kind: "Transaction", to: `/t/${t.name}`, label: t.label, title: t.description, words: `${t.label} ${t.name} ${t.description} transaction` })),
        ...(api.getState("nav.layouts", []) ?? []).map((l) => ({ fav: `layout:${l.name}`, kind: "AI report", to: `/reports?layout=${l.name}`, label: l.label, title: l.description, words: `${l.label} ${l.name} ${l.description} ai report layout` })),
    ];
}

// A value as a search result shows it: dates and numbers in the plant's formats.
function shownValue(type, v) {
    if (Array.isArray(v)) return v.join(", ");
    if (type === "date") return plant().date(v);
    if (type === "integer" || type === "decimal") return plant().number(v);
    if (type === "boolean") return v === true || v === "true" ? "yes" : "no";
    return String(v);
}

// The tab for `path` gets `title` (a page says what it shows once it knows).
export function titleTab(api, path, text) {
    if (api.isServer || !text) return;
    api.setValue("ui.title", text);
    api.setValue(`ui.titles.${pathKey(path)}`, text);
    const tabs = api.peek("prefs.tabs") ?? [];
    const at = tabs.findIndex((t) => t.path === path);
    if (at >= 0 && tabs[at].title !== text) savePrefs(api, { tabs: tabs.map((t, i) => (i === at ? { path, title: text } : t)) });
}

// Replaces one tab's path (a new record, once it has an id).
export function retab(api, from, to, text) {
    const tabs = api.peek("prefs.tabs") ?? [];
    savePrefs(api, { tabs: tabs.map((t) => (t.path === from ? { path: to, title: text ?? t.title } : t)) });
}

const MAX_TABS = 12;
const guessTitle = (path) => {
    const parts = path.split("/").filter(Boolean);
    if (parts[0] === "o" && parts[2] === "new") return "New";
    if (parts[0] === "t") return parts[1]?.replace(/_/g, " ") ?? "Transaction";
    if (parts[0] === "s") return parts[1]?.replace(/_/g, " ") ?? "Screen";
    return parts[1] ?? "Home";
};

// On the sign-in list: what waits for this person, "2 to sign · 1 to review", each change named in
// its tooltip.
const waitingBadge = ({ sign = [], review = [] } = {}) => {
    if (!sign.length && !review.length) return { span: {} };
    const parts = [sign.length ? `${sign.length} to sign` : null, review.length ? `${review.length} to review` : null].filter(Boolean);
    const lines = [
        ...sign.map((c) => `Sign for ${c.department}${c.step ? ` (${c.step})` : ""}: ${c.title}`),
        ...review.map((c) => `Review: ${c.title}`),
    ];
    return { span: { className: `login-waiting${sign.length ? " sign" : ""}`, title: lines.join("\n"), textContent: parts.join(" · ") } };
};

// Who to switch to (the sign-in page's picker, and the top bar's on a picker instance): those picked
// lately in this browser (kept here only, a convenience), whoever has something waiting, and everyone who
// reviews or approves (auth.users); anyone else by search.
const PICKED = "mes.picker.recent";
const recentPicks = () => { try { const v = JSON.parse(globalThis.localStorage?.getItem(PICKED) ?? "[]"); return Array.isArray(v) ? v.slice(0, 10) : []; } catch { return []; } };
const rememberPick = (id) => { try { globalThis.localStorage?.setItem(PICKED, JSON.stringify([id, ...recentPicks().filter((x) => x !== id)].slice(0, 10))); } catch { /* private window: nothing kept */ } };
const askPeople = (api, text) => api.call("auth.users", { ...(searchWords(text).length ? { q: text } : {}), recent: recentPicks() });
// One person to pick: a submit button of the form it is in (POST /login, user=<id>).
const personButton = (u) => ({
    button: {
        key: u.id, type: "submit", name: "user", value: u.id, className: `btn login-user${u.recent ? " recent" : ""}`, title: (u.grants ?? []).join("\n") || "No roles", onclick: () => rememberPick(u.id),
        children: [
            { span: { className: "login-who", children: [{ span: { className: "login-name", textContent: u.name } }, waitingBadge(u.waiting)] } },
            { span: { className: "login-roles", textContent: (u.roles ?? []).join(", ") || "no roles" } },
        ],
    },
});
// What the picker says under its search box, or "".
const pickerWords = (api, find, users) => {
    const n = (users ?? []).length;
    if (find.trim() && !searchWords(find).length) return `Type at least ${MIN_SEARCH} letters.`;
    if (!find.trim() && !api.getState("simpleLists", false)) return "Those you picked lately, those with something waiting, and everyone who reviews or approves. Type a name to find anyone else.";
    if (n > PICKER_SHOWN) return `The first ${PICKER_SHOWN}: type more of a name to find someone else.`;
    if (find.trim() && users && !n) return `Nobody matches “${find.trim()}”.`;
    return "";
};


// This desktop's own page (§6.8): the one its address is mapped to, kept with the session at sign-in
// (me.home). Is `path` it?
export const deskHome = (api, path) => { const home = api.getState("me.home", null); return Boolean(home) && home === path; };
// How a page's Maximize control behaves: as its design says, or, being this desktop's own page, filled
// at each sign-in (the person restores the usual view when they want it, and it stays so until they
// sign out).
export const homeFill = (api, path, mode, remember) => (deskHome(api, path)
    ? { mode: "start", remember: `home.${remember}`, fresh: String(api.getState("me.since", "") ?? "") }
    : { mode, remember });
export function registerShell(juris, { args }) {
    // The page: the sign-in page alone, or the shell around whatever the route draws.
    // The plant's formats (§27.6) are set here first, for everything drawn below.
    juris.registerComponent("App", (props, api) => () => {
        usePlantFormats(api.getState("formats", null));
        return api.getState("$route.name") === "login" || (api.getState("$route.name") === "password" && !api.getState("me.id", null)) ? { div: { className: "login-page", children: [{ RouterView: {} }] } } : { Shell: {} };
    });

    // Why a sign-in went back to this page (auth.js `back`), in words.
    const REFUSED = {
        wrong: () => "The sign-in id or password is wrong.",
        locked: () => "Too many wrong passwords: this sign-in id is locked for 15 minutes. If you have forgotten your password, ask IT for a link to set a new one.",
        unknown: (u) => `${u ? `${u} is` : "You are"} not in People & departments, or no longer active there: ask whoever keeps People & departments to add you.`,
        directory: () => "The plant's directory did not answer: try again in a moment, or ask IT if it goes on.",
        provider: () => "Single sign-on did not complete: try again, or ask IT if it goes on.",
        expired: () => "That single sign-on took too long or was started elsewhere: start it again.",
        password: () => "This instance signs in with a password.",
        step: () => "That sign-in took too long: sign in again.",
        idle: () => "You were signed out after a while with nothing done. Sign in again.",
    };
    // A sign-in half done (§8.2): a code from their authenticator, setting one up, or a new password for
    // one that has expired. Its words when a try goes back to the step.
    const STEP_SAID = { code: "That code is not right: type the 6 digits your authenticator shows now, or a recovery code.", again: "The two new passwords are not the same.", short: "A password has at least 12 characters.", long: "A password has at most 256 characters.", id: "A password cannot contain your sign-in id.", reused: "Choose a password you have not used before." };
    juris.registerComponent("LoginStep", ({ step, to }, api) => {
        const [enroll, setEnroll] = api.useState("enroll", null);
        if (step === "enroll" && !api.isServer) api.onMount(() => { fetch("/login/enroll", { credentials: "same-origin" }).then((r) => r.json()).then(setEnroll, () => setEnroll({ error: "It could not be set up: sign in again." })); });
        const hiddenTo = { input: { type: "hidden", name: "to", value: to ?? "" } };
        const pw = (name, label) => ({ label: { children: [{ span: label }, { input: { name, type: "password", autocomplete: "new-password", required: true, minlength: 12 } }] } });
        const code = (label) => ({ label: { children: [{ span: label }, { input: { name: "code", inputmode: "numeric", autocomplete: "one-time-code", autocapitalize: "none", spellcheck: false, required: true, maxlength: 14 } }] } });
        if (step === "code") return { form: { className: "login-password", method: "post", action: "/login/code", children: [
            hiddenTo, { p: { textContent: "Your password is right. Now the code from your authenticator app." } },
            code("Code"), { button: { type: "submit", className: "btn primary", textContent: "Sign in" } },
            { p: { className: "muted small", textContent: "Lost your phone? Type one of your recovery codes instead, or ask a sign-in administrator to reset your second factor." } },
        ] } };
        if (step === "expired") return { form: { className: "login-password", method: "post", action: "/login/expired", children: [
            hiddenTo, { p: { textContent: "Your password has expired: the plant asks for a new one every so often. Choose a new one to sign in." } },
            pw("next", "New password"), pw("again", "The new password again"),
            { p: { className: "muted small", textContent: "At least 12 characters, not one you used before." } },
            { button: { type: "submit", className: "btn primary", textContent: "Change it and sign in" } },
        ] } };
        if (step === "enroll") return { div: { className: "login-enroll", children: [
            { p: { textContent: "This plant asks for a second factor: an authenticator app on your phone (Microsoft Authenticator, Google Authenticator, or any that takes a key)." } },
            () => {
                const e = enroll();
                if (!e) return { p: { className: "muted", textContent: "Setting it up…" } };
                if (e.error) return { p: { className: "login-note refused", textContent: e.error } };
                return { div: { children: [
                    { ol: { className: "login-enroll-steps", children: [
                        { li: { children: [{ span: "In the app, add an account with this key: " }, { code: { className: "login-key", textContent: e.secret.replace(/(.{4})/g, "$1 ").trim() } }, { span: " (on this phone, " }, { a: { href: e.uri, textContent: "open it in the app" } }, { span: ")." }] } },
                        { li: { children: [{ span: "Keep these recovery codes somewhere safe, apart from the phone. Each signs you in once if the phone is lost; they are shown only now:" }, { ul: { className: "login-codes", children: e.codes.map((c) => ({ li: { key: c, children: [{ code: c }] } })) } }] } },
                        { li: { textContent: "Type the code the app shows now." } },
                    ] } },
                    { form: { className: "login-password", method: "post", action: "/login/enroll", children: [hiddenTo, code("Code"), { button: { type: "submit", className: "btn primary", textContent: "Set it up and sign in" } }] } },
                ] } };
            },
        ] } };
        return { span: {} };
    });
    juris.registerComponent("Login", (props, api) => {
        const [users, setUsers] = api.useState("users", null);
        const [methods, setMethods] = api.useState("methods", null);
        api.call("auth.methods").then(setMethods, () => setMethods({ picker: true }));
        api.call("auth.users").then(setUsers, () => setUsers([]));
        const [find, setFind] = api.useState("find", "");
        const ask = (text) => askPeople(api, text).then(setUsers, () => setUsers([]));
        if (!api.isServer) api.onMount(() => { if (recentPicks().length) ask(""); });
        let timer = null;
        const typed = (text) => { setFind(text); clearTimeout(timer); timer = setTimeout(() => ask(text), 250); };
        api.onCleanup(() => clearTimeout(timer));
        const query = () => api.getState("$route.query", {}) ?? {};
        return {
            div: {
                className: "login",
                children: [
                    { h1: { children: [{ span: "OpenCore MES" }, api.getState("instance", null) === "training" ? { span: { className: "instance-tag", textContent: "TRAINING" } } : { span: {} }] } },
                    () => {
                        const q = query();
                        const said = (q.step ? STEP_SAID[q.e] : null) ?? REFUSED[q.e]?.(q.u) ?? (q.m === "password" ? "Your password is set: sign in with it." : null);
                        return said ? { p: { className: `login-note${q.e ? " refused" : ""}`, role: q.e ? "alert" : "status", children: [icon(q.e ? "warning" : "check"), { span: said }] } } : { span: {} };
                    },
                    // A step of a sign-in half done: only it, until it is done.
                    () => (["code", "expired", "enroll"].includes(query().step) ? { LoginStep: { key: query().step, step: query().step, to: query().to } } : { span: {} }),
                    () => {
                        const m = methods() ?? {};
                        if (query().step) return { span: {} };
                        return m.sso ? { a: { className: "btn primary login-sso", href: query().to ? `/login/sso?to=${encodeURIComponent(query().to)}` : "/login/sso", textContent: `Sign in with ${m.sso}` } } : { span: {} };
                    },
                    () => {
                        const m = methods() ?? {};
                        if (!m.password || query().step) return { span: {} };
                        return {
                            form: {
                                className: "login-password", method: "post", action: "/login",
                                children: [
                                    // Where they were going before signing in (app.js sends them here with `to`).
                                    { input: { type: "hidden", name: "to", value: query().to ?? "" } },
                                    m.sso ? { p: { className: "muted small login-or", textContent: "or" } } : { span: {} },
                                    { label: { children: [{ span: "Sign-in id" }, { input: { name: "user", autocomplete: "username", autocapitalize: "none", spellcheck: false, required: true, value: query().u ?? "" } }] } },
                                    { label: { children: [{ span: "Password" }, { input: { name: "password", type: "password", autocomplete: "current-password", required: true } }] } },
                                    { button: { type: "submit", className: `btn${m.sso ? "" : " primary"}`, textContent: "Sign in" } },
                                    m.directory ? { p: { className: "muted small", textContent: `Your password is ${m.directory}'s, unless IT gave you one of your own here.` } } : { span: {} },
                                ],
                            },
                        };
                    },
                    () => {
                        const m = methods() ?? {};
                        if (!m.picker || query().step) return { span: {} };
                        return {
                            form: {
                                method: "post", action: "/login",
                                children: [
                                    { input: { type: "hidden", name: "to", value: query().to ?? "" } },
                                    { p: { className: "muted", textContent: api.getState("demo", false) ? "Pick who you are." : "No password needed here: pick who you are." } },
                                    api.getState("demo", false) ? { p: { className: "demo-note small", children: [icon("info"), { span: "A public demo: anyone may sign in as anyone, what you do here is seen by other visitors, and everything is erased every night at 03:00 UTC. Do not enter real data." }] } } : { span: {} },
                                    { input: { type: "search", className: "login-find", placeholder: "Find anyone else: a name or sign-in id", "aria-label": "Find someone", autocomplete: "off", value: () => find(), oninput: (e) => typed(e.target.value), onkeydown: (e) => { if (e.key === "Enter") e.preventDefault(); } } },
                                    () => { const words = pickerWords(api, find(), users()); return words ? { p: { className: "muted small", textContent: words } } : { span: {} }; },
                                    // Fifteen at first, more as the list is scrolled (window-rows.js).
                                    () => {
                                        const list = (users() ?? []).slice(0, PICKER_SHOWN);
                                        return windowRows({ key: `pick-${find().trim()}-${list.length}-${list[0]?.id ?? ""}`, tag: "div", className: "login-users", count: list.length, row: (i) => personButton(list[i]) });
                                    },
                                ],
                            },
                        };
                    },
                ],
            },
        };
    });

    // A password of one's own (§8.2): set through a one-time link (signed out), or changed (signed in).
    const PASSWORD_SAID = {
        link: "This link has been used or has expired: ask IT for a new one.",
        again: "The two new passwords are not the same.",
        short: "A password has at least 12 characters.",
        long: "A password has at most 256 characters.",
        id: "A password cannot contain your sign-in id.",
        current: "Your current password is wrong.",
        locked: "Too many wrong passwords: try again in 15 minutes.",
        none: "You sign in through the plant's directory or single sign-on: your password is changed there.",
        reused: "Choose a password you have not used before.",
    };
    juris.registerComponent("SigningPassword", ({ has }, api) => {
        const [said, setSaid] = api.useState("said", null);
        const [hasOne, setHasOne] = api.useState("has", Boolean(has));
        const save = async (e) => {
            e.preventDefault();
            const el = e.target.elements;
            const args = { current: el.current?.value ?? "", next: el.next.value, again: el.again.value };
            for (const k of ["current", "next", "again"]) if (el[k]) el[k].value = "";
            try { await api.call("auth.signingPassword", args); setHasOne(true); setSaid({ ok: true, words: "Your signing password is set." }); } catch (error) { setSaid({ ok: false, words: error.message }); }
        };
        const field = (name, label, auto) => ({ label: { children: [{ span: label }, { input: { name, type: "password", autocomplete: auto, required: true, ...(name === "current" ? {} : { minlength: 12 }) } }] } });
        return {
            section: {
                className: "signing-password",
                children: [
                    { h2: "Your signing password" },
                    { p: { className: "muted", textContent: "You sign in through single sign-on, so you have no password here. To sign electronically where a password is asked (a transaction a second person verifies, or signing in beside someone), you use this one. It never signs you in." } },
                    () => (said() ? { p: { className: `login-note${said().ok ? "" : " refused"}`, role: said().ok ? "status" : "alert", children: [icon(said().ok ? "check" : "warning"), { span: said().words }] } } : { span: {} }),
                    () => ({ form: { className: "login-password", onsubmit: save, children: [
                        hasOne() ? field("current", "Current signing password", "current-password") : { span: {} },
                        field("next", "New signing password", "new-password"),
                        field("again", "The new signing password again", "new-password"),
                        { p: { className: "muted small", textContent: "At least 12 characters, not your sign-in password elsewhere." } },
                        { button: { type: "submit", className: "btn primary", textContent: hasOne() ? "Change signing password" : "Set signing password" } },
                    ] } }),
                ],
            },
        };
    });
    // A second factor for a password sign-in (§8.2): an authenticator app set up (its key and recovery
    // codes shown once), its recovery codes renewed, or taken off where the plant does not require one.
    juris.registerComponent("SecondFactor", ({ mfa }, api) => {
        const [state, setState] = api.useState("mfa", { ...mfa });
        const [setup, setSetup] = api.useState("setup", null);
        const [codes, setCodes] = api.useState("codes", null);
        const [said, setSaid] = api.useState("said", null);
        const refresh = () => api.call("auth.account").then((a) => setState({ ...a.mfa }), () => {});
        const start = () => api.call("auth.mfa.start").then((r) => { setSetup(r); setSaid(null); }, (e) => setSaid({ ok: false, words: e.message }));
        const codeOf = (e) => { e.preventDefault(); const el = e.target.elements.code; const v = el.value; el.value = ""; return v; };
        const confirm = (e) => { const code = codeOf(e); api.call("auth.mfa.confirm", { code }).then(() => { setSetup(null); setSaid({ ok: true, words: "Your authenticator is set up: a password sign-in now asks its code." }); refresh(); }, (er) => setSaid({ ok: false, words: er.message })); };
        const renew = (e) => { const code = codeOf(e); api.call("auth.mfa.codes", { code }).then((r) => { setCodes(r.codes); setSaid({ ok: true, words: "New recovery codes: the old ones no longer work." }); refresh(); }, (er) => setSaid({ ok: false, words: er.message })); };
        const off = (e) => { const code = codeOf(e); api.call("auth.mfa.off", { code }).then(() => { setSaid({ ok: true, words: "Your authenticator is taken off." }); refresh(); }, (er) => setSaid({ ok: false, words: er.message })); };
        const codeField = (label) => ({ label: { children: [{ span: label }, { input: { name: "code", inputmode: "numeric", autocomplete: "one-time-code", required: true, maxlength: 14 } }] } });
        const codeList = (list) => ({ ul: { className: "login-codes", children: list.map((c) => ({ li: { key: c, children: [{ code: c }] } })) } });
        return { section: { className: "second-factor", children: [
            { h2: "Second factor" },
            { p: { className: "muted", textContent: state().policy === "required" ? "This plant asks for a code from an authenticator app after your password at every sign-in." : "A code from an authenticator app after your password makes a stolen password useless on its own." } },
            () => (said() ? { p: { className: `login-note${said().ok ? "" : " refused"}`, role: said().ok ? "status" : "alert", children: [icon(said().ok ? "check" : "warning"), { span: said().words }] } } : { span: {} }),
            () => {
                if (setup()) return { div: { className: "login-enroll", children: [
                    { ol: { className: "login-enroll-steps", children: [
                        { li: { children: [{ span: "In the app, add an account with this key: " }, { code: { className: "login-key", textContent: setup().secret.replace(/(.{4})/g, "$1 ").trim() } }, { span: " (on this phone, " }, { a: { href: setup().uri, textContent: "open it in the app" } }, { span: ")." }] } },
                        { li: { children: [{ span: "Keep these recovery codes somewhere safe, apart from the phone; shown only now:" }, codeList(setup().codes)] } },
                        { li: { textContent: "Type the code the app shows now." } },
                    ] } },
                    { form: { className: "login-password", onsubmit: confirm, children: [codeField("Code"), { button: { type: "submit", className: "btn primary", textContent: "Set it up" } }] } },
                ] } };
                if (!state().enabled) return { button: { type: "button", className: "btn primary", textContent: "Set up an authenticator app", onclick: start } };
                return { div: { children: [
                    { p: { className: "small", children: [icon("check"), { span: ` Set up${state().since ? ` on ${plant().dateTime(state().since)}` : ""}. ${state().codesLeft} recovery code${state().codesLeft === 1 ? "" : "s"} left.` }] } },
                    codes() ? { div: { children: [{ p: { className: "small", textContent: "Your new recovery codes, shown only now:" } }, codeList(codes())] } } : { span: {} },
                    { form: { className: "login-password", onsubmit: renew, children: [codeField("A code from the app, to renew your recovery codes"), { button: { type: "submit", className: "btn", textContent: "New recovery codes" } }] } },
                    state().policy === "required" ? { span: {} } : { form: { className: "login-password", onsubmit: off, children: [codeField("A code from the app, to take it off"), { button: { type: "submit", className: "btn ghost", textContent: "Take it off" } }] } },
                ] } };
            },
        ] } };
    });
    juris.registerComponent("Password", (props, api) => {
        const [account, setAccount] = api.useState("account", null);
        const q = () => api.getState("$route.query", {}) ?? {};
        const token = q().token ?? null;
        if (!token && !api.isServer) api.onMount(() => { api.call("auth.account").then(setAccount, () => setAccount(null)); });
        const field = (name, label, auto) => ({ label: { children: [{ span: label }, { input: { name, type: "password", autocomplete: auto, required: true, ...(name === "current" ? {} : { minlength: 12 }) } }] } });
        return {
            div: {
                className: token ? "login" : "view narrow",
                children: [
                    { h1: token ? "Set your password" : "Your password" },
                    () => {
                        const said = PASSWORD_SAID[q().e] ?? (q().m === "changed" ? "Your password is changed. Anywhere else you were signed in, you are signed out." : null);
                        return said ? { p: { className: `login-note${q().e ? " refused" : ""}`, role: q().e ? "alert" : "status", children: [icon(q().e ? "warning" : "check"), { span: said }] } } : { span: {} };
                    },
                    // When the password expires (Part 11 §11.300), and whether it has.
                    () => {
                        const a = account();
                        if (token || !a) return { span: {} };
                        const at = a.password ? a.expiresAt : a.signing ? a.signingExpiresAt : null;
                        const gone = a.password ? a.expired : a.signingExpired;
                        if (!at) return { span: {} };
                        return { p: { className: `login-note${gone ? " refused" : ""}`, role: gone ? "alert" : "status", children: [icon(gone ? "warning" : "info"), { span: gone ? `Your ${a.password ? "password" : "signing password"} has expired: choose a new one${a.password ? "" : " to sign again"}.` : `Your ${a.password ? "password" : "signing password"} lasts until ${plant().dateTime(at)} (every ${a.maxDays} days)${a.history ? `, and a new one may not be one of your last ${a.history}` : ""}.` }] } };
                    },
                    // A signing password (§7.4), for one who signs in through single sign-on: signing a transaction
                    // verified by two people, or signing in beside someone, asks for it.
                    () => (!token && account() && !account().password && account().sso ? { SigningPassword: { has: account().signing } } : { span: {} }),
                    () => {
                        if (!token && account() && !account().password) return { p: { className: "muted", textContent: PASSWORD_SAID.none } };
                        if (!token && !account()) return { span: {} };
                        return {
                            form: {
                                className: "login-password", method: "post", action: "/password",
                                children: [
                                    token ? { input: { type: "hidden", name: "token", value: token } } : field("current", "Current password", "current-password"),
                                    field("next", "New password", "new-password"),
                                    field("again", "The new password again", "new-password"),
                                    { p: { className: "muted small", textContent: "At least 12 characters; a few words you will remember are better than a short scramble." } },
                                    { button: { type: "submit", className: "btn primary", textContent: token ? "Set password" : "Change password" } },
                                ],
                            },
                        };
                    },
                    // Their second factor, where the plant uses one and they sign in with a password.
                    () => (!token && account()?.mfa?.applies ? { SecondFactor: { key: `mfa-${account().mfa.enabled}`, mfa: account().mfa } } : { span: {} }),
                ],
            },
        };
    });

    juris.registerComponent("Shell", (props, api) => {
        const as = api.getState("me.id", null, { track: false });
        api.live("nav.objects", "defs.list", args.defs(as));
        api.live("prefs", "prefs.get", args.prefs(as));
        // The transactions this person may run (§25): the navigator lists them, records offer them.
        api.live("nav.transactions", "transactions.list", args.transactions(as));
        // The screens this person may open (§26).
        api.live("nav.screens", "screens.list", args.screens(as));
        // The report layouts this person may ask for a report on (§34.5).
        api.live("nav.layouts", "reports.layouts", args.layouts(as));
        // The idle timeout (§8.2): a click or a key is the person doing something; the server hears of it
        // at most once a minute (polling and live updates never count). Idle past the plant's limit, the
        // page signs out, saying why.
        const idleMinutes = Number(api.getState("signing.idleMinutes", 0)) || 0;
        if (!api.isServer && idleMinutes > 0) api.onMount(() => {
            let lastActive = Date.now(), lastPing = Date.now();
            const active = () => {
                lastActive = Date.now();
                if (lastActive - lastPing > 60_000) { lastPing = lastActive; api.call("auth.active").catch(() => {}); }
            };
            const idle = () => {
                if (Date.now() - lastActive < idleMinutes * 60_000) return;
                clearInterval(timer);
                fetch("/logout", { method: "POST", credentials: "same-origin", redirect: "manual" }).catch(() => {}).finally(() => globalThis.location.assign("/login?e=idle"));
            };
            for (const ev of ["pointerdown", "keydown", "wheel"]) globalThis.addEventListener(ev, active, { passive: true });
            const timer = setInterval(idle, 30_000);
            return () => { clearInterval(timer); for (const ev of ["pointerdown", "keydown", "wheel"]) globalThis.removeEventListener(ev, active); };
        });
        if (!api.isServer) {
            // The scheme the page is drawn in (§10.8): the plant's when its theme decides, else the
            // person's, at once when they pick (the server wrote the same into the page before the first
            // paint). Until their preferences have arrived, the server's choice stands.
            // (`prefs.scheme` is read by name: a write to it wakes it, never `prefs` above it.)
            const stopScheme = api.bindState(() => [api.getState("theme.scheme", "choice"), api.getState("prefs", null), api.getState("prefs.scheme", null)], ([plant, prefs, mine]) => {
                if (!prefs && plant === "choice") return;
                const scheme = schemeOf({ scheme: plant }, mine);
                if (scheme) document.documentElement.setAttribute("data-theme", scheme);
                else document.documentElement.removeAttribute("data-theme");
            });
            api.onCleanup(stopScheme);
            // The window never scrolls (the open tab does): a page opened starts at its top, as the router
            // does for the window.
            const stopTop = api.bindState(() => api.getState("$route.path"), () => { const body = globalThis.document?.querySelector(".tabbody"); if (body) body.scrollTop = 0; });
            api.onCleanup(stopTop);
            // Every page opened is a tab (§10.1).
            const stop = api.bindState(() => api.getState("$route.path"), (path) => {
                if (!path || path === "/" || path === "/login") return;
                const tabs = api.peek("prefs.tabs") ?? [];
                if (tabs.some((t) => t.path === path)) return;
                let next = [...tabs, { path, title: api.peek(`ui.titles.${pathKey(path)}`) ?? guessTitle(path) }];
                if (next.length > MAX_TABS) next = next.slice(next.length - MAX_TABS);
                savePrefs(api, { tabs: next });
            });
            api.onCleanup(stop);
        }
        return {
            div: {
                className: "shell",
                // A page that fills the window (MaximizeToggle): only the page it was filled for.
                classList: {
                    maximized: () => { const m = api.getState("ui.maximized", null); return m !== null && m === api.getState("$route.path"); },
                    // A guide open (§33): it takes the navigator's place, the page beside it, never under it.
                    guiding: () => Boolean(api.getState("ui.guide", null)),
                },
                children: [
                    { Topbar: {} },
                    { Navigator: {} },
                    { main: { className: "work", children: [{ UpdateBanner: {} }, { DbBanner: {} }, { TabBar: {} }, { section: { className: "tabbody", children: [{ RouterView: {} }] } }] } },
                    // The one dialog at a time (dialog.js): confirmations and questions from any screen.
                    { DialogHost: {} },
                    // Copy what a list shows: one button over the cell the pointer is on (copy-cell.js).
                    { CopyCell: {} },
                    // A panel's guide, docked over the navigator (§33).
                    { GuideDock: {} },
                    // A screen shown as a dialog (§26.6), and the pop-ups meant for every page (§26.7).
                    { ScreenDialogHost: {} },
                    { PopupWatch: { target: "*" } },
                ],
            },
        };
    });

    // Beside the person's name: how many things wait for them (changes to review, steps of changes and
    // of record changes to sign), live; clicked, the list of them, each a link to where it is signed.
    // Who you are, and (on a picker instance: development, the demo) anyone else in one click: those picked
    // lately, whoever has something waiting, everyone who reviews or approves, and a search. The switch stays
    // on the page it was made from. The demo has no sign-in page: this is how a visitor is someone else.
    juris.registerComponent("PersonSwitch", (props, api) => {
        const [open, setOpen] = api.useState("open", false);
        const [users, setUsers] = api.useState("users", null);
        const [find, setFind] = api.useState("find", "");
        const ask = (text) => askPeople(api, text).then(setUsers, () => setUsers([]));
        let timer = null;
        const typed = (text) => { setFind(text); clearTimeout(timer); timer = setTimeout(() => ask(text), 250); };
        api.onCleanup(() => clearTimeout(timer));
        // A demo visitor's own guest ("Guest 7F3K") is kept among this browser's picks, so it is there to come
        // back to after being someone else; other visitors' guests are not listed (app.mjs auth.users).
        if (!api.isServer) api.onMount(() => { const me = api.getState("me.id", null, { track: false }); if (api.getState("demo", false, { track: false }) && /^guest_[a-z2-9]{4,8}$/.test(String(me ?? "")) && !recentPicks().includes(me)) rememberPick(me); });
        const toggle = () => { const next = !open(); setOpen(next); if (next) { setFind(""); ask(""); setTimeout(() => globalThis.document?.querySelector(".switch-panel input[type=search]")?.focus(), 0); } };
        if (!api.isServer) {
            api.onMount(() => {
                const away = (e) => { if (open() && !e.target.closest?.(".switch")) setOpen(false); };
                const esc = (e) => { if (e.key === "Escape" && open()) { setOpen(false); document.querySelector(".switch-btn")?.focus(); } };
                document.addEventListener("click", away);
                document.addEventListener("keydown", esc);
                return () => { document.removeEventListener("click", away); document.removeEventListener("keydown", esc); };
            });
        }
        return {
            div: {
                className: "switch",
                children: [
                    { button: { type: "button", className: "switch-btn who", "aria-haspopup": "true", "aria-expanded": () => String(open()), title: "Be someone else", onclick: toggle, children: [{ span: { textContent: () => api.getState("me.name", "") } }, icon("chevronDown")] } },
                    () => {
                        if (!open()) return { span: {} };
                        const list = (users() ?? []).slice(0, PICKER_SHOWN);
                        return {
                            form: {
                                className: "switch-panel win-scroll", method: "post", action: "/login", role: "dialog", "aria-label": "Be someone else",
                                children: [
                                    { input: { type: "hidden", name: "to", value: api.getState("$route.path", "/") } },
                                    api.getState("demo", false) ? { p: { className: "demo-note small", children: [icon("info"), { span: "A public demo: you arrive as a guest of your own, who holds every role, and may be anyone else here (to review or approve a change you made, be someone else; your guest stays first in this list). What you do is seen by other visitors and erased every night at 03:00 UTC." }] } } : { span: {} },
                                    { input: { type: "search", className: "login-find", placeholder: "Find anyone: a name or sign-in id", "aria-label": "Find anyone", autocomplete: "off", value: () => find(), oninput: (e) => typed(e.target.value), onkeydown: (e) => { if (e.key === "Enter") e.preventDefault(); } } },
                                    () => { const words = pickerWords(api, find(), users()); return words ? { p: { className: "muted small", textContent: words } } : { span: {} }; },
                                    users() === null ? { p: { className: "muted small", textContent: "Loading…" } } : windowRows({ key: `switch-${find().trim()}-${list.length}-${list[0]?.id ?? ""}`, tag: "div", className: "login-users", count: list.length, row: (i) => personButton(list[i]) }),
                                    api.getState("demo", false) ? { span: {} } : { Link: { to: "/password", className: "small", onclick: () => setOpen(false), textContent: "Your password" } },
                                ],
                            },
                        };
                    },
                ],
            },
        };
    });

    // A second person signed in beside the first (§7.4): at most two, the verifier of what needs one, until
    // either signs out. Their sign-in id and password (none on a development or demo instance).
    juris.registerComponent("SecondPerson", (props, api) => {
        const open = () => api.getState("ui.second.open", false);
        const setOpen = (v) => api.setValue("ui.second.open", v);
        const said = () => api.getState("ui.second.said", null);
        if (!api.isServer) {
            api.onMount(() => {
                const away = (e) => { if (open() && !e.target.closest?.(".second")) setOpen(false); };
                const esc = (e) => { if (e.key === "Escape" && open()) { setOpen(false); document.querySelector(".second-btn")?.focus(); } };
                document.addEventListener("click", away);
                document.addEventListener("keydown", esc);
                return () => { document.removeEventListener("click", away); document.removeEventListener("keydown", esc); };
            });
        }
        const join = async (e) => {
            e.preventDefault();
            const formEl = e.target;
            const id = formEl.elements.id.value, password = formEl.elements.password?.value ?? "";
            if (formEl.elements.password) formEl.elements.password.value = "";
            try {
                const r = await api.call("auth.second.join", { id, password });
                api.batch(() => { api.setValue("me.second", r.second); api.setValue("ui.second.said", null); setOpen(false); });
            } catch (error) { api.setValue("ui.second.said", error.message); }
        };
        const leave = async () => { await api.call("auth.second.leave", {}).catch(() => {}); api.setValue("me.second", null); };
        return {
            div: {
                className: "second",
                children: [
                    () => {
                        const second = api.getState("me.second", null);
                        if (second) return { span: { className: "second-who", children: [{ span: { className: "who", title: "Signed in beside you: verifies what needs a second person", textContent: `+ ${second.name}` } }, { button: { type: "button", className: "btn ghost small second-out", title: `Sign ${second.name} out (you stay signed in)`, "aria-label": `Sign ${second.name} out`, onclick: leave, children: [icon("x"), { span: { className: "second-out-words", textContent: `Sign ${second.name.split(" ")[0]} out` } }] } }] } };
                        return { button: { type: "button", className: "second-btn", "aria-haspopup": "true", "aria-expanded": () => String(open()), title: "Add a second person: one who verifies what needs two signatures", "aria-label": "Add a second person", onclick: () => { api.setValue("ui.second.said", null); setOpen(!open()); if (open()) setTimeout(() => document.querySelector(".second-panel input")?.focus(), 0); }, children: [icon("users"), { span: { className: "second-plus", textContent: "+" } }] } };
                    },
                    () => {
                        if (!open() || api.getState("me.second", null)) return { span: {} };
                        const noPasswords = api.getState("picker", false);
                        return {
                            form: {
                                className: "second-panel", role: "dialog", "aria-label": "Add a second person", onsubmit: join,
                                children: [
                                    { strong: "A second person" },
                                    { p: { className: "muted small", textContent: "Signs in beside you to verify what needs two signatures; each of you re-enters your password when you sign. Two at most, until one of you signs out." } },
                                    { label: { children: [{ span: "Their sign-in id" }, { input: { name: "id", type: "text", autocomplete: "off", autocapitalize: "none", spellcheck: false, required: true } }] } },
                                    noPasswords ? { p: { className: "muted small", textContent: "No password on a development or demo instance." } } : { label: { children: [{ span: "Their password" }, { input: { name: "password", type: "password", autocomplete: "off", required: true } }] } },
                                    () => (said() ? { p: { className: "login-note refused small", role: "alert", children: [icon("warning"), { span: said() }] } } : { span: {} }),
                                    { button: { type: "submit", className: "btn primary", textContent: "Sign in beside me" } },
                                ],
                            },
                        };
                    },
                ],
            },
        };
    });

    juris.registerComponent("Inbox", (props, api) => {
        const as = api.getState("me.id", null, { track: false });
        api.live("inbox", "inbox.mine", args.inbox(as));
        const [open, setOpen] = api.useState("open", false);
        if (!api.isServer) {
            api.onMount(() => {
                const away = (e) => { if (open() && !e.target.closest?.(".inbox")) setOpen(false); };
                const esc = (e) => { if (e.key === "Escape" && open()) { setOpen(false); document.querySelector(".inbox-btn")?.focus(); } };
                document.addEventListener("click", away);
                document.addEventListener("keydown", esc);
                return () => { document.removeEventListener("click", away); document.removeEventListener("keydown", esc); };
            });
        }
        const count = () => api.getState("inbox.count", 0) ?? 0;
        const item = (i) => ({
            li: {
                key: `${i.kind}-${i.id}-${i.department ?? ""}`,
                children: [{
                    Link: {
                        to: i.link, className: "inbox-item", onclick: () => setOpen(false),
                        children: [
                            { span: { className: "inbox-title", textContent: i.title } },
                            { span: { className: "inbox-what muted small", textContent: i.kind === "alert" ? i.what ?? "An alert" : i.kind === "task" ? "A plan: decide, fill in, or acknowledge" : i.kind === "review" ? "Review the change" : `Sign for ${i.department}${i.step ? ` as ${i.step}` : ""}${i.record ? " · a change to a record" : ""}` } },
                        ],
                    },
                }],
            },
        });
        return {
            div: {
                className: "inbox",
                children: [
                    {
                        button: {
                            type: "button", className: "inbox-btn", "aria-haspopup": "true", "aria-expanded": () => String(open()),
                            classList: { waiting: () => count() > 0 },
                            title: () => (count() ? `${count()} waiting for you` : "Nothing waits for you"),
                            "aria-label": () => (count() ? `${count()} waiting for you` : "Nothing waits for you"),
                            onclick: () => setOpen(!open()),
                            children: [icon("bell", { className: "bell" }), () => (count() ? { span: { className: "inbox-count", textContent: String(count()) } } : { span: {} })],
                        },
                    },
                    () => {
                        if (!open()) return { span: {} };
                        const items = api.getState("inbox.items", []) ?? [];
                        const review = items.filter((i) => i.kind === "review");
                        const sign = items.filter((i) => i.kind === "sign");
                        const tasks = items.filter((i) => i.kind === "task");
                        const alerts = items.filter((i) => i.kind === "alert"); // a suite's (§29): first, they are about now
                        return {
                            div: {
                                className: "inbox-panel", role: "dialog", "aria-label": "Waiting for you",
                                children: [
                                    { div: { className: "inbox-head", children: [{ strong: "Waiting for you" }, { span: { className: "muted small", textContent: items.length ? ` ${items.length}` : "" } }] } },
                                    !items.length ? { p: { className: "muted small", textContent: "Nothing waits for you." } } : { span: {} },
                                    alerts.length ? { div: { children: [{ div: { className: "inbox-group", textContent: "Alerts" } }, { ul: { children: alerts.map(item) } }] } } : { span: {} },
                                    tasks.length ? { div: { children: [{ div: { className: "inbox-group", textContent: "Plans waiting for you" } }, { ul: { children: tasks.map(item) } }] } } : { span: {} },
                                    sign.length ? { div: { children: [{ div: { className: "inbox-group", textContent: "To sign" } }, { ul: { children: sign.map(item) } }] } } : { span: {} },
                                    review.length ? { div: { children: [{ div: { className: "inbox-group", textContent: "To review" } }, { ul: { children: review.map(item) } }] } } : { span: {} },
                                    api.getState("me.design", false) ? { div: { className: "inbox-foot", children: [{ Link: { to: "/design/approvals", onclick: () => setOpen(false), className: "icon-text", children: [{ span: "Open Approvals: everything waiting" }, icon("arrowRight")] } }] } } : { span: {} },
                                ],
                            },
                        };
                    },
                ],
            },
        };
    });

    // A screen shown as a dialog (§26.6), over the page, which stays as it was: opened by a button block,
    // or by a pop-up (§26.7). One at a time (`ui.screenDialog`: { name, arg, popup, target }); closed by
    // its ✕, Escape, a click beside it, or a transaction it holds that finishes (closeOnDone).
    juris.registerComponent("ScreenDialogHost", (props, api) => {
        const close = () => api.setValue("ui.screenDialog", null);
        if (!api.isServer) {
            api.onMount(() => {
                const esc = (e) => { if (e.key === "Escape" && api.peek("ui.screenDialog") && !document.querySelector(".dialog-backdrop")) { e.preventDefault(); close(); } };
                document.addEventListener("keydown", esc);
                return () => document.removeEventListener("keydown", esc);
            });
        }
        // One stable host whose child comes and goes: an empty placeholder of the same tag would keep
        // the dialog's nodes on screen once closed (the renderer reuses an element of the same tag).
        return {
            div: {
                className: "screen-dialog-host",
                children: () => {
                    const d = api.getState("ui.screenDialog", null);
                    if (!d) return [];
                    return [{
                        div: {
                            key: `host-${d.name}-${d.arg ?? ""}-${d.key ?? ""}`,
                            className: "screen-dialog-backdrop",
                            onclick: (e) => { if (e.target === e.currentTarget) close(); },
                            children: [{
                                div: {
                                    className: "screen-dialog", role: "dialog", "aria-modal": "true", "aria-label": d.label ?? d.name,
                                    children: [
                                        { button: { type: "button", className: "btn ghost screen-dialog-close", title: "Close", "aria-label": "Close", children: [icon("x")], onclick: close } },
                                        { ScreenView: { key: `dlg-${d.name}-${d.arg ?? ""}-${d.key ?? ""}`, name: d.name, arg: d.arg ?? null, dialog: true } },
                                    ],
                                },
                            }],
                        },
                    }];
                },
            },
        };
    });

    // The pop-ups over a page (§26.7): the screens whose condition holds here for this person, live,
    // re-asked whenever what the page holds changes (`values()`: a transaction's inputs, a screen's
    // parameter). The first is shown as a dialog and goes away by itself when its condition stops
    // holding; one the person closes stays closed on this page until they open it again.
    juris.registerComponent("PopupWatch", ({ target, values = () => ({}) }, api) => {
        if (api.isServer) return { span: { className: "popup-watch" } };
        const as = api.getState("me.id", null, { track: false });
        const path = `pop.${target.replace(/[^a-z0-9_]/gi, "_")}`;
        const closed = new Set();
        let asked = null;
        let unsubscribe = null;
        let shown = null; // the pop-up this watch has open, by name
        const stopAsk = api.bindState(() => JSON.stringify(values() ?? {}), (json) => {
            if (json === asked) return;
            asked = json;
            const next = api.live(path, "popups.for", args.popups(target, JSON.parse(json), as));
            unsubscribe?.();
            unsubscribe = next;
        });
        const stopShow = api.bindState(() => [api.getState(path, null), api.getState("ui.screenDialog", null)], ([list, open]) => {
            const holding = (list ?? []).map((p) => p.name);
            // Closed by the person while it still holds: it stays closed here.
            if (shown && !open && holding.includes(shown)) closed.add(shown);
            if (shown && (!open || open.name !== shown)) shown = null;
            // Its condition no longer holds: it goes away for everyone at once.
            if (open?.popup && open.target === target && !holding.includes(open.name)) { shown = null; api.setValue("ui.screenDialog", null); return; }
            const next = (list ?? []).find((p) => !closed.has(p.name));
            if (!open && next) { shown = next.name; api.setValue("ui.screenDialog", { ...next, popup: true, target }); }
        });
        api.onCleanup(() => {
            stopAsk();
            stopShow();
            unsubscribe?.();
            const open = api.peek("ui.screenDialog");
            if (open?.popup && open.target === target) api.setValue("ui.screenDialog", null);
        });
        return { span: { className: "popup-watch" } };
    });

    // Whether the page is live (§13, D6): a shop-floor screen must say when what it shows may be stale.
    const liveIndicator = (api) => ({
        span: {
            className: "live",
            classList: { on: () => api.isServer || api.getState("$live.connected", false) },
            title: () => (api.getState("$live.connected", false) ? "Live: changes arrive as they happen" : "Not connected: what you see may be stale"),
            children: () => (api.isServer || api.getState("$live.connected", false) ? [icon("dot"), { span: "live" }] : [icon("circle"), { span: "offline" }]),
        },
    });

    // The button that fills the window with a transaction's or a screen's page, as its design says
    // (`maximize`, §25.1, §26.1): "toggle" offers it, "start" opens the page filled. Filled, the top bar,
    // the navigator and the tabs step aside; the database and update banners stay, and beside the button
    // stay what the top bar told: who is signed in (who a signature will name) and whether the page is
    // live. It is the page `path` that is filled, so no other page ever opens so by mistake. The person's
    // choice is kept on this device per design (`remember`): a kiosk stays filled across a reload.
    // `fresh` (a desktop's own page, §6.8): a mark of this sign-in. What was chosen under another one
    // is forgotten, so the page opens filled at each sign-in and stays as the person leaves it until
    // they sign out.
    juris.registerComponent("MaximizeToggle", ({ path, mode, remember, fresh = null }, api) => {
        const key = `open-mes.maximize.${remember}`;
        const kept = () => {
            try {
                const was = localStorage.getItem(key);
                if (fresh === null || was === null) return was;
                return was.startsWith(`${fresh}|`) ? was.slice(fresh.length + 1) : null;
            } catch { return null; }
        };
        const keep = (on) => { try { localStorage.setItem(key, `${fresh === null ? "" : `${fresh}|`}${on ? "1" : "0"}`); } catch { /* not kept: this visit only */ } };
        const on = () => api.getState("ui.maximized", null) === path;
        const set = (value) => api.setValue("ui.maximized", value ? path : null);
        if (!api.isServer) {
            api.onMount(() => {
                const was = kept();
                set(was === null ? mode === "start" : was === "1");
                return () => { if (api.peek("ui.maximized") === path) set(false); };
            });
        }
        const toggle = () => { const next = !on(); set(next); keep(next); };
        return {
            div: {
                className: "maximize",
                children: [
                    { span: { className: "maximize-status", classList: { shown: on }, children: [liveIndicator(api), { span: { className: "who", textContent: () => api.getState("me.name", "") } }] } },
                    {
                        button: {
                            type: "button", className: "btn maximize-btn", "aria-pressed": () => String(on()),
                            title: () => (on() ? "Show the navigator, the top bar and the tabs again" : "Fill the window with this page"),
                            children: () => (on() ? [icon("minimize"), { span: "Restore" }] : [icon("maximize"), { span: "Maximize" }]),
                            onclick: toggle,
                        },
                    },
                ],
            },
        };
    });

    // The person's light or dark (§10.8), kept with their preferences on every device: offered only when
    // the plant's theme lets each person choose ("choice"); otherwise the plant's scheme holds for all.
    const SCHEME_WORDS = { system: "As this device is set", light: "Light", dark: "Dark" };
    const SCHEME_ICONS = { system: "monitor", light: "sun", dark: "moon" };
    juris.registerComponent("SchemePick", (props, api) => {
        const mine = () => api.getState("prefs.scheme", null) ?? "system";
        return {
            span: {
                className: "scheme-pick", role: "group", "aria-label": "Light or dark",
                classList: { hidden: () => api.getState("theme.scheme", "choice") !== "choice" },
                children: PERSONAL.map((s) => ({
                    button: {
                        key: s, type: "button", title: SCHEME_WORDS[s], "aria-label": SCHEME_WORDS[s],
                        classList: { on: () => mine() === s }, "aria-pressed": () => String(mine() === s),
                        children: [icon(SCHEME_ICONS[s])],
                        // On a phone only the current one shows (app.css): tapped, it moves to the next.
                        onclick: () => savePrefs(api, { scheme: s === mine() && window.matchMedia("(max-width: 760px)").matches ? PERSONAL[(PERSONAL.indexOf(s) + 1) % PERSONAL.length] : s }),
                    },
                })),
            },
        };
    });

    juris.registerComponent("Topbar", (props, api) => ({
        header: {
            className: () => `topbar${api.getState("me.test", false) ? " in-test" : ""}`,
            children: [
                // The test sandbox (§5.13) says so on every page: nothing done here reaches the plant.
                api.getState("me.test", false) ? { span: { className: "instance-tag test-tag", title: "The test sandbox: a copy for testing changes that are not approved yet. Nothing done here reaches the plant", textContent: "TEST SANDBOX" } } : { span: {} },
                // The plant's name and label, from its theme (§10.8).
                { Link: { to: "/", className: "brand", textContent: () => api.getState("theme.name", null) || "OpenCore MES" } },
                { span: { className: "scope", textContent: () => api.getState("theme.scope", null) || "PLT1 · POC" } },
                api.getState("instance", null) === "training" ? { span: { className: "instance-tag", title: "A training instance: its own database, separate from the plant's", textContent: "TRAINING" } } : { span: {} },
                api.getState("demo", false) ? { span: { className: "instance-tag demo-tag", title: "A public demo: you arrive as a guest of your own, who holds every role, and may be anyone else; everything here is seen by other visitors, and it is all erased every night", textContent: "PUBLIC DEMO" } } : { span: {} },
                { span: { className: "spacer" } },
                liveIndicator(api),
                { SchemePick: {} },
                // On a picker instance, who you are switches to anyone else; elsewhere, your name opens your password.
                api.getState("picker", false) ? { PersonSwitch: {} } : { Link: { to: "/password", className: "who", title: "Your password", textContent: () => api.getState("me.name", "") } },
                { SecondPerson: {} },
                { Inbox: {} },
                // The demo has no sign-in page, so nothing to sign out to: be someone else instead.
                api.getState("demo", false) ? { span: {} } : { form: { method: "post", action: "/logout", className: "logout", children: [{ button: { type: "submit", className: "btn ghost", textContent: "Sign out" } }] } },
            ],
        },
    }));

    juris.registerComponent("Navigator", (props, api) => {
        const [query, setQuery] = api.useState("q", "");
        // The same box finds records of every object the user may read (records.search), a moment
        // after typing stops; only the newest answer is shown.
        let timer = null;
        let asked = 0;
        const search = (text) => {
            setQuery(text);
            clearTimeout(timer);
            const q = text.trim();
            if (q.length < 2) return api.setValue("nav.search", null);
            api.setValue("nav.search", { q, loading: true, results: api.peek("nav.search.results") ?? [] });
            timer = setTimeout(() => {
                const mine = ++asked;
                api.call("records.search", { q }).then(
                    (results) => { if (mine === asked) api.setValue("nav.search", { q, loading: false, results }); },
                    () => { if (mine === asked) api.setValue("nav.search", { q, loading: false, results: [], failed: true }); },
                );
            }, 250);
        };
        api.onCleanup(() => clearTimeout(timer));
        // Shown by search (§10.1): with nothing typed, only what the person starred; everything else is
        // found by typing, or listed whole on asking ("Show all", not remembered).
        const [all, setAll] = api.useState("all", false);
        const favorites = () => api.getState("prefs.favorites", []);
        const toggle = (fav) => (event) => {
            event.preventDefault();
            const now = api.peek("prefs.favorites") ?? [];
            savePrefs(api, { favorites: now.includes(fav) ? now.filter((o) => o !== fav) : [...now, fav] });
        };
        const item = (e, where) => ({
            li: {
                key: `${where}-${e.fav}`,
                className: "nav-item",
                children: [
                    { Link: { to: e.to, className: "nav-link", title: e.title, textContent: e.label } },
                    {
                        button: {
                            className: "star", type: "button",
                            classList: { on: () => favorites().includes(e.fav) },
                            title: () => (favorites().includes(e.fav) ? "Remove from favorites" : "Add to favorites"),
                            "aria-label": () => `${favorites().includes(e.fav) ? "Remove" : "Add"} ${e.label} ${favorites().includes(e.fav) ? "from" : "to"} favorites`,
                            children: () => [icon(favorites().includes(e.fav) ? "starFilled" : "star")],
                            onclick: toggle(e.fav),
                        },
                    },
                ],
            },
        });
        return {
            aside: {
                className: "nav",
                children: [
                    { input: { className: "nav-search", type: "search", placeholder: "Search…", title: "Objects, screens, transactions and records", "aria-label": "Search objects, screens, transactions and records", value: () => query(), oninput: (e) => search(e.target.value) } },
                    () => {
                        const found = api.getState("nav.search", null);
                        if (!found) return { span: {} };
                        const results = found.results ?? [];
                        return {
                            section: {
                                className: "nav-group nav-results",
                                children: [
                                    { h3: found.loading ? "Records · searching…" : `Records · ${results.length ? results.length : "none"} for “${found.q}”` },
                                    {
                                        ul: {
                                            // Where each stands at a glance: its state, the first fields of its list,
                                            // and what matched when it is not the title shown.
                                            children: results.map((r) => {
                                                const details = (r.details ?? []).map((d) => `${d.label}: ${shownValue(d.type, d.value)}`);
                                                const matched = r.match && !r.match.title && r.match.field !== "State" && !(r.details ?? []).some((d) => d.label === r.match.field) ? `${r.match.field}: ${shownValue(r.match.type, r.match.value)}` : null;
                                                return {
                                                    li: {
                                                        key: `${r.object}-${r.id}`,
                                                        className: "nav-item",
                                                        children: [{
                                                            Link: {
                                                                to: `/o/${r.object}/${r.id}`, className: "nav-link result",
                                                                children: [
                                                                    { span: { key: "t", className: "r-title", children: [
                                                                        { span: { key: "n", textContent: `${r.label} ${r.title}` } },
                                                                        ...(r.list ? [] : [{ span: { key: "s", className: stateBadgeClass(r.state, { [r.state]: r.tone }), textContent: r.state.replace(/_/g, " ") } }]),
                                                                        ...(r.archived ? [{ span: { key: "a", className: "muted small", textContent: "archived" } }] : []),
                                                                    ] } },
                                                                    ...(details.length ? [{ span: { key: "d", className: "r-details muted small", textContent: details.join(" · ") } }] : []),
                                                                    ...(matched ? [{ span: { key: "m", className: "r-match muted small", textContent: `matched ${matched}` } }] : []),
                                                                ],
                                                            },
                                                        }],
                                                    },
                                                };
                                            }),
                                        },
                                    },
                                ],
                            },
                        };
                    },
                    () => {
                        const entries = navEntries(api);
                        const q = query().trim().toLowerCase();
                        const hit = (e) => !q || e.words.toLowerCase().includes(q);
                        const favs = favorites().map((fav) => entries.find((e) => e.fav === fav)).filter((e) => e && hit(e));
                        const sections = [];
                        // Show all / Show only favorites, first: it stays where it was pressed, however long
                        // the list it opens.
                        if (!q && entries.length) {
                            sections.push({
                                div: {
                                    key: "browse", className: "nav-browse",
                                    children: [
                                        ...(favs.length || all() ? [] : [{ p: { key: "hint", className: "muted small", textContent: "Search for an object, a screen, a transaction or an AI report, and star it to keep it here." } }]),
                                        { button: { key: "all", type: "button", className: "btn ghost small", textContent: all() ? "Show only favorites" : `Show all ${entries.length}`, onclick: () => setAll(!all()) } },
                                    ],
                                },
                            });
                        }
                        if (favs.length) sections.push({ section: { key: "fav", className: "nav-group", children: [{ h3: { className: "icon-text", children: [icon("starFilled"), { span: "Favorites" }] } }, { ul: { children: favs.map((e) => item(e, "fav")) } }] } });
                        // The rest: what matches the search, or everything when asked for.
                        if (q || all()) {
                            const objects = entries.filter((e) => e.kind === "Object" && hit(e));
                            for (const area of [...new Set(objects.map((e) => e.area))].sort()) {
                                sections.push({ section: { key: `a-${area}`, className: "nav-group", children: [{ h3: area }, { ul: { children: objects.filter((e) => e.area === area).map((e) => item(e, area)) } }] } });
                            }
                            // Screens (§26): designed pages. Transactions (§25): changing several records as one.
                            for (const [kind, heading] of [["Screen", "Screens"], ["Transaction", "Transactions"], ["AI report", "AI reports"]]) {
                                const found = entries.filter((e) => e.kind === kind && hit(e));
                                if (found.length) sections.push({ section: { key: kind, className: "nav-group", children: [{ h3: heading }, { ul: { children: found.map((e) => item(e, kind)) } }] } });
                            }
                        }
                        const recordHits = (api.getState("nav.search.results", null) ?? []).length;
                        // The suites' entries (§29), as data: [{ group, label, to, words }], each under its
                        // group (beside the platform's own entries when it names one of its groups).
                        const suiteNav = (api.getState("suites", []) ?? []).flatMap((x) => (x.nav ?? []).map((n, i) => ({ ...n, key: `${x.name}-${i}` })))
                            .filter((n) => !q || `${n.label} ${n.words ?? ""} ${n.group ?? ""}`.toLowerCase().includes(q));
                        const navLink = (n) => ({ li: { key: n.key, className: "nav-item", children: [{ Link: { to: n.to, className: "nav-link", textContent: n.label } }] } });
                        const dataExtra = suiteNav.filter((n) => (n.group ?? "Data") === "Data");
                        if (!q || "data query sql json schema import export excel ai report reports charts analytics copilot".includes(q) || dataExtra.length) {
                            sections.push({ section: { key: "data", className: "nav-group", children: [{ h3: "Data" }, { ul: { children: [
                                ...(api.getState("me.query", false) && (!q || "data query sql json schema".includes(q)) ? [{ li: { key: "q", className: "nav-item", children: [{ Link: { to: "/query", className: "nav-link", textContent: "Query" } }] } }] : []),
                                ...(api.getState("me.reports", false) && (!q || "data ai report reports charts analytics copilot".includes(q)) ? [{ li: { key: "r", className: "nav-item", children: [{ Link: { to: "/reports", className: "nav-link", textContent: "AI Report" } }] } }] : []),
                                ...(!q || "data import export excel".includes(q) ? [{ li: { key: "t", className: "nav-item", children: [{ Link: { to: "/transfer", className: "nav-link", textContent: "Import / export" } }] } }] : []),
                                ...dataExtra.map(navLink),
                            ] } }] } });
                        }
                        // (A suite's entry in Design joins the platform's design pages, below, for those it is shared with.)
                        for (const group of [...new Set(suiteNav.map((n) => n.group).filter((g) => g && g !== "Data" && g !== "Design"))]) {
                            sections.push({ section: { key: `suite-${group}`, className: "nav-group", children: [{ h3: group }, { ul: { children: suiteNav.filter((n) => n.group === group).map(navLink) } }] } });
                        }
                        // The design pages, each found by the words people would search it by.
                        const designs = api.getState("me.design", false);
                        const designPages = [
                            ...(designs ? [
                                { key: "d", to: "/design", label: "Designer", words: "designer design change requests objects services connections transactions screens" },
                                { key: "a", to: "/design/approvals", label: "Approvals", words: "approvals approve pending sign signature review waiting inbox" },
                                { key: "p", to: "/design/people", label: "People & departments", words: "people departments roles users employees approvers approval steps governance standing organization groups" },
                                { key: "m", to: "/design/integration", label: "Integration monitor", words: "integration monitor schedules nodes outbox triggers" },
                            ] : []),
                            // Sign-in administration (§8.2): for its administrators, designers or not.
                            ...(api.getState("me.signInAdmin", false) ? [{ key: "s", to: "/design/sign-in", label: "Sign-in administration", words: "sign-in password link reset second factor authenticator lock unlock sessions security" }] : []),
                            ...(designs ? suiteNav.filter((n) => n.group === "Design").map((n) => ({ key: n.key, to: n.to, label: n.label, words: n.words ?? "" })) : []),
                        ].filter((x) => !q || `${x.label} ${x.words}`.toLowerCase().includes(q));
                        if (designPages.length) {
                            // One marked at a time: the Designer holds every /design page (a change, a live view)
                            // but those with their own link (Approvals, People & departments, the monitor).
                            const own = designPages.filter((x) => x.to !== "/design").map((x) => x.to);
                            const designerOnly = () => api.isActive("/design") && !own.some((to) => api.isActive(to));
                            sections.push({ section: { key: "design", className: "nav-group", children: [{ h3: "Design" }, { ul: { children: designPages.map((x) => ({ li: { key: x.key, className: "nav-item", children: [{ Link: x.to === "/design" ? { to: x.to, className: "nav-link", activeClass: "nav-prefix", classList: { active: designerOnly }, textContent: x.label } : { to: x.to, className: "nav-link", textContent: x.label } }] } })) } }] } });
                        }
                        if (!sections.length && !recordHits) sections.push({ p: { key: "none", className: "muted small", textContent: q ? "Nothing matches." : "Nothing is shared with you yet." } });
                        return { div: { className: "nav-sections", children: sections } };
                    },
                ],
            },
        };
    });

    juris.registerComponent("TabBar", (props, api) => {
        const close = (path) => (event) => {
            event.preventDefault();
            event.stopPropagation();
            const tabs = api.peek("prefs.tabs") ?? [];
            const at = tabs.findIndex((t) => t.path === path);
            const next = tabs.filter((t) => t.path !== path);
            savePrefs(api, { tabs: next });
            if (api.peek("$route.path") === path) api.navigate(next[Math.min(at, next.length - 1)]?.path ?? "/");
        };
        return {
            nav: {
                className: "tabs",
                children: () => {
                    const current = api.getState("$route.path", "/");
                    let tabs = api.getState("prefs.tabs", []);
                    if (current !== "/" && !tabs.some((t) => t.path === current)) tabs = [...tabs, { path: current, title: guessTitle(current) }];
                    if (!tabs.length) return { span: { className: "tabs-empty muted small", textContent: "Open an object from the left; each one opens in a tab." } };
                    return {
                        div: {
                            className: "tab-list",
                            children: tabs.map((t) => ({
                                div: {
                                    key: t.path,
                                    className: "tab",
                                    classList: { active: () => api.getState("$route.path") === t.path },
                                    children: [
                                        { Link: { to: t.path, className: "tab-link", textContent: () => api.getState(`ui.titles.${pathKey(t.path)}`, t.title) } },
                                        { button: { type: "button", className: "tab-close", title: "Close tab", "aria-label": "Close tab", children: [icon("x")], onclick: close(t.path) } },
                                    ],
                                },
                            })),
                        },
                    };
                },
            },
        };
    });

    juris.registerComponent("Home", (props, api) => {
        if (!api.isServer) api.setValue("ui.title", "Home");
        return {
            div: {
                className: "view home",
                children: [
                    { h1: () => `Good day, ${api.getState("me.name", "")}` },
                    { p: { className: "muted", textContent: "Search the navigator for an object, a screen or a transaction. Star the ones you use; they show here and at the top of the navigator, on every device." } },
                    // This desktop's own page (§6.8): one click back to it.
                    () => { const home = api.getState("me.home", null); return home ? { p: { className: "desk-home", children: [{ span: { className: "muted", textContent: "This desktop opens " } }, { Link: { to: home, className: "icon-text", children: [icon("monitor"), { strong: api.getState("me.homeLabel", null) ?? home }] } }] } } : { span: {} }; },
                    () => {
                        const entries = navEntries(api);
                        const shown = (api.getState("prefs.favorites", []) ?? []).map((fav) => entries.find((e) => e.fav === fav)).filter(Boolean);
                        return {
                            div: {
                                className: "cards",
                                children: shown.map((e) => ({ Link: { key: e.fav, to: e.to, className: "card", children: [{ span: { className: "card-kind muted small", textContent: e.kind } }, { strong: e.label }, { span: { className: "muted small", textContent: e.title ?? "" } }] } })),
                            },
                        };
                    },
                ],
            },
        };
    });

    juris.registerComponent("NotFound", () => ({ div: { className: "view", children: [{ h1: "Not found" }, { p: "Nothing lives at this address." }] } }));
}
