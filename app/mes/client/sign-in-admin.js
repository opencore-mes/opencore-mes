// Sign-in administration (DESIGN.md §8.2): for whoever People & departments makes a sign-in administrator.
// What needs a look (ids locked in the last day, wrong passwords spread over many ids), then a person
// found by name or sign-in id, with their sign-in as it stands, and what may be done for them: a one-time
// link to set a password (shown once, to hand over), their second factor taken off (a lost phone), a lock
// lifted, their sessions ended. Each is in the audit trail, by whoever did it. And setup codes (five letters
// for a printed slip) for everyone who has no password here and has never signed in, a department at a
// time, downloaded as a file for slips or a mail merge.
import { icon } from "./icons.js";
import { plant } from "./format.js";
import { titleTab } from "./shell.js";
import { confirmDialog, askDialog } from "./dialog.js";
import { windowTable } from "./window-rows.js";
import { setupCodesCsv } from "./people-file.js";

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
            const hours = await askDialog(api, { title: `A password link for ${p.name}`, message: "A one-time link to set a password: shown once here, for you to hand over yourself (in person, or a message only they read). It replaces any earlier link of theirs.", label: "It lasts (days, 1 to 14)", type: "number", value: String(api.getState("signing.linkDays", 3) ?? 3), required: true, confirm: "Make the link" });
            if (hours === null) return;
            const days = Number(hours);
            api.call("auth.admin.link", { id: p.id, days }).then((r) => { api.setValue(`${A}.code`, null); api.setValue(`${A}.link`, { name: p.name, url: `${globalThis.location.origin}${r.path}`, hours: r.hours }); done(`A link for ${p.name}, good for ${r.days} day${r.days === 1 ? "" : "s"}.`); }, failed);
        };
        // Setup codes (§8.2): how many would get one, then the codes made and downloaded.
        const where = () => `${globalThis.location.origin}/password?setup=1`;
        const counted = () => {
            const c = api.peek(`${A}.codes`) ?? {};
            api.setValue(`${A}.codes.count`, null);
            api.call("auth.admin.setupCodes", { department: c.department || null, count: true }).then((r) => api.setValue(`${A}.codes.count`, r.count), failed);
        };
        const daysOf = (text) => Number(String(text ?? "").trim());
        const makeCodes = async () => {
            const c = api.peek(`${A}.codes`) ?? {};
            const dept = (api.peek(`${A}.departments`) ?? []).find((d) => d.id === c.department);
            const n = c.count ?? 0;
            const days = daysOf(c.days ?? api.getState("signing.linkDays", 3));
            if (!(await confirmDialog(api, { title: `Setup codes for ${n} ${n === 1 ? "person" : "people"}?`, message: `Each of them${dept ? ` in ${dept.name}` : ""} who has no password here and has never signed in gets a new code, good for ${days} day${days === 1 ? "" : "s"}, downloaded as a file for printed slips or a mail merge. A code or link they were given before stops working. The file holds the codes: print the slips, hand each to its person, then delete the file.`, confirm: "Make the codes and download" }))) return;
            api.call("auth.admin.setupCodes", { department: c.department || null, days }).then((r) => {
                const url = URL.createObjectURL(new Blob([setupCodesCsv(r.people, { expires: plant().dateTime(r.expiresAt), address: where() })], { type: "text/csv;charset=utf-8" }));
                const a = document.createElement("a");
                a.href = url;
                a.download = `setup-codes-${c.department || "everyone"}-${new Date().toISOString().slice(0, 10)}.csv`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                done(`${r.people.length} setup code${r.people.length === 1 ? "" : "s"}, good until ${plant().dateTime(r.expiresAt)}: downloaded as ${a.download}.`);
                counted();
            }, failed);
        };
        if (!api.isServer) api.onMount(() => { api.call("auth.admin.departments").then((d) => api.setValue(`${A}.departments`, d), () => {}); counted(); });
        const code = async (p) => {
            const days = await askDialog(api, { title: `A setup code for ${p.name}`, message: "Five letters they type with their sign-in id to set a password, at any station: shown once here, for you to hand over yourself (on paper, or in person). It replaces any earlier code or link of theirs.", label: "It lasts (days, 1 to 14)", type: "number", value: String(api.getState("signing.linkDays", 3) ?? 3), required: true, confirm: "Make the code" });
            if (days === null) return;
            api.call("auth.admin.setupCodes", { id: p.id, days: daysOf(days) }).then((r) => { api.setValue(`${A}.link`, null); api.setValue(`${A}.code`, { name: p.name, id: p.id, code: r.people[0].code, expiresAt: r.expiresAt }); done(`A setup code for ${p.name}, good until ${plant().dateTime(r.expiresAt)}.`); }, failed);
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
            () => {
                const c = api.getState(`${A}.code`, null);
                return c ? { section: { className: "panel signin-link", children: [
                    { p: { textContent: `${c.name}'s setup code, good until ${plant().dateTime(c.expiresAt)}, once. Write it down now: it is not shown again.` } },
                    { p: { className: "signin-code", children: [{ span: { className: "muted small", textContent: `Sign-in id ${c.id}, code ` } }, { code: { textContent: c.code } }] } },
                    { p: { className: "muted small", textContent: `They open ${where()} (or "I have a setup code" on the sign-in page), type both, and choose their password.` } },
                    { div: { className: "row-actions", children: [{ button: { type: "button", className: "btn ghost", textContent: "Done", onclick: () => api.setValue(`${A}.code`, null) } }] } },
                ] } } : { span: {} };
            },
            { section: { className: "panel signin-codes", children: [
                { h3: { className: "icon-text", children: [icon("lock"), { span: "Setup codes for people with no password yet" }] } },
                { p: { className: "muted small", textContent: "For people just added who have no mail or computer of their own: each gets five letters on a printed slip, and types them with their sign-in id at any station to choose a password. Only those who have no password here and have never signed in get one." } },
                { div: { className: "signin-codes-form", children: [
                    { label: { children: [{ span: "Who" }, { select: { "aria-label": "Department", onchange: (e) => { api.setValue(`${A}.codes.department`, e.target.value); counted(); }, children: () => [
                        { option: { key: "", value: "", textContent: "Everyone" } },
                        ...(api.getState(`${A}.departments`, []) ?? []).map((d) => ({ option: { key: d.id, value: d.id, textContent: d.name, selected: d.id === api.peek(`${A}.codes.department`) } })),
                    ] } }] } },
                    { label: { children: [{ span: "Good for (days)" }, { input: { type: "number", min: 1, max: 14, value: String(api.getState("signing.linkDays", 3) ?? 3), oninput: (e) => api.setValue(`${A}.codes.days`, e.target.value) } }] } },
                    () => {
                        const n = api.getState(`${A}.codes.count`, null);
                        return { div: { className: "signin-codes-go", children: [
                            { span: { className: "small", textContent: n === null ? "Counting…" : n ? `${n} ${n === 1 ? "person has" : "people have"} no password here and ${n === 1 ? "has" : "have"} never signed in.` : "Everyone here has a password or has signed in." } },
                            { button: { type: "button", className: "btn", disabled: !n, children: [icon("arrowDown"), { span: "Make codes and download" }], onclick: makeCodes } },
                        ] } };
                    },
                ] } },
            ] } },
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
                                p.active ? { button: { type: "button", className: "btn small", textContent: "Setup code", onclick: () => code(p) } } : { span: {} },
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
