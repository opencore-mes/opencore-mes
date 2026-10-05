// Sign-in administration (DESIGN.md §8.2): for whoever People & departments makes a sign-in administrator.
// What needs a look (ids locked in the last day, wrong passwords spread over many ids), then a person
// found by name or sign-in id, with their sign-in as it stands, and what may be done for them: a one-time
// link to set a password (shown once, to hand over), their second factor taken off (a lost phone), a lock
// lifted, their sessions ended. Each is in the audit trail, by whoever did it.
import { icon } from "./icons.js";
import { plant } from "./format.js";
import { titleTab } from "./shell.js";
import { confirmDialog, askDialog } from "./dialog.js";
import { windowTable } from "./window-rows.js";

const A = "signin.admin";
const when = (at) => (at ? plant().dateTime(at) : "never");

export function registerSignInAdmin(juris) {
    juris.registerComponent("SignInAdmin", (props, api) => {
        const q0 = String(api.getState("$route.query.q", "") ?? "");
        const load = (q) => api.call("auth.admin.people", { q }).then((rows) => api.setValue(`${A}.rows`, rows), (e) => api.setValue(`${A}.error`, e.message));
        const alerts = () => api.call("auth.admin.alerts").then((a) => api.setValue(`${A}.alerts`, a), () => {});
        let timer = null;
        if (!api.isServer) api.onMount(() => { titleTab(api, "/design/sign-in", "Sign-in administration"); api.setValue(`${A}.q`, q0); load(q0); alerts(); });
        api.onCleanup(() => clearTimeout(timer));
        const typed = (text) => { api.setValue(`${A}.q`, text); clearTimeout(timer); timer = setTimeout(() => load(text), 250); };
        const done = (words) => { api.setValue(`${A}.said`, { ok: true, words }); load(api.peek(`${A}.q`) ?? ""); alerts(); };
        const failed = (e) => api.setValue(`${A}.said`, { ok: false, words: e.message });
        const link = async (p) => {
            const hours = await askDialog(api, { title: `A password link for ${p.name}`, message: "A one-time link to set a password: shown once here, for you to hand over yourself (in person, or a message only they read). It replaces any earlier link of theirs.", label: "It lasts (hours)", type: "number", value: "72", required: true, confirm: "Make the link" });
            if (hours === null) return;
            api.call("auth.admin.link", { id: p.id, hours: Number(hours) }).then((r) => { api.setValue(`${A}.link`, { name: p.name, url: `${globalThis.location.origin}${r.path}`, hours: r.hours }); done(`A link for ${p.name}, good for ${r.hours} hours.`); }, failed);
        };
        const resetMfa = async (p) => {
            const reason = await askDialog(api, { title: `Take off ${p.name}'s second factor?`, message: "They sign in with their password alone until they set up a new authenticator (at their next sign-in, where the plant requires one). Do this only once you are sure it is them asking.", label: "Why (a lost phone, a new one)", required: true, confirm: "Take it off", danger: true });
            if (reason) api.call("auth.admin.resetMfa", { id: p.id, reason }).then(() => done(`${p.name}'s second factor is taken off.`), failed);
        };
        const unlock = (p) => api.call("auth.admin.unlock", { id: p.id }).then(() => done(`${p.id} may try to sign in again.`), failed);
        const end = async (p) => {
            if (await confirmDialog(api, { title: `End ${p.name}'s sessions?`, message: `They are signed out everywhere (${p.sessions} session${p.sessions === 1 ? "" : "s"}), and sign in again.`, confirm: "End them", danger: true })) api.call("auth.admin.endSessions", { id: p.id }).then((r) => done(`${r.ended} session${r.ended === 1 ? "" : "s"} ended.`), failed);
        };
        const status = (p) => [
            p.lockedUntil ? `locked until ${plant().time(p.lockedUntil)}` : null,
            p.password ? (p.passwordExpired ? "password expired" : `password since ${plant().dateTime(p.passwordSetAt)}`) : p.signing ? (p.signingExpired ? "signing password expired" : "signing password") : "no password here",
            p.mfa ? "second factor" : null,
            p.active ? null : "left",
        ].filter(Boolean).join(" · ");
        return { div: { className: "view signin-admin", children: [
            { div: { className: "view-head", children: [{ h1: "Sign-in administration" }, { span: { className: "muted", textContent: "Password links, second factors, locks and sessions. Everything done here is in the audit trail, by you." } }] } },
            () => {
                const a = api.getState(`${A}.alerts`, null);
                if (!a || (!a.spray && !a.locks.length)) return { p: { className: "muted small", children: [icon("check"), { span: " Nothing in the sign-in trail needs a look (the last day)." }] } };
                return { section: { className: "panel signin-alerts", children: [
                    { h3: { className: "icon-text", children: [icon("warning"), { span: "Needs a look" }] } },
                    a.spray ? { p: { className: "field-error", textContent: `Wrong passwords on ${a.spray.ids} sign-in ids within minutes (last at ${when(a.spray.at)}): someone may be trying common passwords on everyone. Tell IT security.` } } : { span: {} },
                    { ul: { children: a.locks.map((l) => ({ li: { key: l.id, children: [{ strong: l.id }, { span: ` locked after wrong passwords${l.times > 1 ? ` (${l.times} times)` : ""}, last at ${when(l.at)} ` }, { button: { type: "button", className: "linkish", textContent: "find", onclick: () => typed(l.id) } }] } })) } },
                ] } };
            },
            () => {
                const s = api.getState(`${A}.said`, null);
                return s ? { p: { className: `login-note${s.ok ? "" : " refused"}`, role: s.ok ? "status" : "alert", children: [icon(s.ok ? "check" : "warning"), { span: s.words }] } } : { span: {} };
            },
            () => {
                const l = api.getState(`${A}.link`, null);
                return l ? { section: { className: "panel signin-link", children: [
                    { p: { textContent: `${l.name}'s link (good for ${l.hours} hours, once). Copy it now: it is not shown again.` } },
                    { input: { type: "text", readOnly: true, value: l.url, "aria-label": "The password link", onfocus: (e) => e.target.select() } },
                    { div: { className: "row-actions", children: [
                        { button: { type: "button", className: "btn", textContent: "Copy", onclick: () => globalThis.navigator?.clipboard?.writeText(l.url).then(() => api.setValue(`${A}.said`, { ok: true, words: "Copied." }), () => {}) } },
                        { button: { type: "button", className: "btn ghost", textContent: "Done", onclick: () => api.setValue(`${A}.link`, null) } },
                    ] } },
                ] } } : { span: {} };
            },
            { input: { type: "search", className: "signin-find", placeholder: "Find a person: a name or sign-in id", "aria-label": "Find a person", value: () => api.getState(`${A}.q`, "") ?? "", oninput: (e) => typed(e.target.value) } },
            () => {
                const rows = api.getState(`${A}.rows`, null);
                const error = api.getState(`${A}.error`, null);
                if (error) return { p: { className: "error", textContent: error } };
                if (!rows) return { p: { className: "muted", textContent: "Reading…" } };
                if (!rows.length) return { p: { className: "muted", textContent: "Nobody matches." } };
                return windowTable({
                    key: `signin-${api.peek(`${A}.q`) ?? ""}-${rows.length}`, className: "signin-people", head: ["Person", "Sign-in", "Last sign-in", ""], count: rows.length,
                    row: (i) => {
                        const p = rows[i];
                        return { tr: { key: p.id, className: p.lockedUntil ? "signin-locked" : "", children: [
                            { td: { children: [{ strong: p.name }, { div: { className: "muted small", textContent: p.id } }] } },
                            { td: { className: "small", textContent: status(p) } },
                            { td: { className: "small", textContent: `${when(p.lastSignIn)}${p.sessions ? ` · ${p.sessions} session${p.sessions === 1 ? "" : "s"}` : ""}` } },
                            { td: { className: "signin-actions", children: [
                                p.active ? { button: { type: "button", className: "btn small", textContent: "Password link", onclick: () => link(p) } } : { span: {} },
                                p.mfa ? { button: { type: "button", className: "btn small", textContent: "Reset second factor", onclick: () => resetMfa(p) } } : { span: {} },
                                p.lockedUntil ? { button: { type: "button", className: "btn small", textContent: "Unlock", onclick: () => unlock(p) } } : { span: {} },
                                p.sessions ? { button: { type: "button", className: "btn ghost small", textContent: "End sessions", onclick: () => end(p) } } : { span: {} },
                            ] } },
                        ] } };
                    },
                });
            },
        ] } };
    });
}
