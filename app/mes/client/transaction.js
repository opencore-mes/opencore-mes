// A transaction's screen (DESIGN.md §25): its inputs, laid out as its design says (form-layout.js,
// drawn by the record form's own FormBody), the records they name, then what will change, and the
// run. Everything on it comes from the transaction's definition; nothing here knows what it does.
//   /t/<name>          start empty (the navigator's Transactions group)
//   /t/<name>/<id>     opened from a record: that record fills the input its design names
// It is also a screen's block (§26), `embedded`: inputs the screen fills (`prefill`) are shown locked,
// and it loads in the browser only (a screen's preload cannot know which transactions it holds).
import { formGuide } from "./guide.js";
import { titleTab, deskHome, homeFill } from "./shell.js";
import { formController } from "./records.js";
import { plant } from "./format.js";
import { icon } from "./icons.js";
import { freshSignOn } from "./sign.js";
import { stateBadgeClass } from "./theme.js";
import { keyFlow, focusFirst, focusError, controlFor } from "./keyboard.js";
import { driveInputFlow } from "./input-flow-driver.js";

// The id of a transaction form's root, for a screen to put the cursor in it (keyboard.js).
export const transactionRootId = (name, slot = null, from = null) => `tx-${name}${slot ? `-${slot}` : from ? `-${from}` : ""}`.replace(/[^a-zA-Z0-9_-]/g, "-");

// An input as the form draws it: a field, read-only when it is filled in from another record.
const asFields = (inputs) => Object.fromEntries(Object.entries(inputs ?? {}).map(([k, s]) => [k, {
    label: s.label ?? k, type: s.type, required: Boolean(s.required), values: s.values, to: s.to,
    ...(s.multiple ? { multiple: true } : {}), ...(s.requiredWhen !== undefined ? { requiredWhen: s.requiredWhen } : {}),
    ...(s.type === "rows" ? { fields: s.fields ?? {}, min: s.min, max: s.max } : {}),
    ...(s.options ? { options: s.options } : {}),
}]));
const words = (v) => String(v ?? "").replace(/_/g, " ");
const shown = (v) => (v === null || v === undefined || v === "" ? "—" : Array.isArray(v) ? v.join(", ") : typeof v === "number" ? plant().number(v) : String(v));

export function registerTransactionScreen(juris, { args }) {
    // `onDone(result)`: told when a run succeeds (a screen closes its row's form and says so). `active`:
    // whether it is in view (a screen's tab); once it is not, what the last check said is cleared.
    juris.registerComponent("TransactionScreen", ({ name, from = null, embedded = false, prefill = null, slot = null, onDone = null, active = null, driven = false }, api) => {
        const as = api.getState("me.id", null, { track: false });
        const T = `tx.${name}`;
        const defPath = `${T}.def`;
        const where = slot ? `.${slot}` : from ? `.${from}` : "";
        const formDef = `${T}${where}.formDef`;
        const permPath = `${T}${where}.perm`;
        const f = `f.tx.${name}${where}`;
        const filled = prefill ?? {};
        if (embedded && api.isServer) return { p: { className: "muted", textContent: "Loading…" } };
        api.live(defPath, "transactions.get", args.transaction(name, as));
        const form = formController(api, { object: null, f, defPath: formDef, record: () => ({}) });
        const derivedStops = [];
        const rootId = transactionRootId(name, slot, from);
        const rootEl = () => globalThis.document?.getElementById(rootId);
        // Taken from the keyboard. With an input flow (§32.13, input-flow-driver.js): its asks in turn, as it
        // says. Without one (keyboard.js): Enter from input to input and on to Check and Confirm, Esc back;
        // the cursor starts in the first input still empty (on its own page, or a screen's tab as it comes
        // into view), goes to Confirm once checked, back to the first input once done, and to what the check
        // refused. A screen with an input flow of its own walks this form itself (`driven`).
        if (!api.isServer && !driven) {
            api.onMount(() => {
                const later = (fn) => setTimeout(() => fn(rootEl()), 0);
                let mode = null;
                let hidden = false; // loaded on a screen's tab out of view
                const defaults = () => {
                    const stopKeys = keyFlow(rootEl, {
                        primary: () => rootEl()?.querySelector(".form-foot .tx-check, .form-foot .tx-run"),
                        back: () => { if (!api.peek(`${f}.preview`)) return false; api.setValue(`${f}.preview`, null); return true; },
                    });
                    const watches = [
                        api.bindState(() => Boolean(api.getState(`${f}.preview`, null)), (on) => { if (on) later((r) => { const sign = r?.querySelector(".tx-sign input"); (sign && !sign.checked ? sign : r?.querySelector(".form-foot .tx-run"))?.focus(); }); }),
                        api.bindState(() => Boolean(api.getState(`${f}.done`, null)), (on) => { if (on) later((r) => focusFirst(r, { force: true })); }),
                        api.bindState(() => Object.keys(api.getState(`${f}.serverErrors`, {}) ?? {}).length, (n) => { if (n) later((r) => focusError(r)); }),
                    ];
                    return { stop: () => { stopKeys(); for (const w of watches) w(); }, show: (force) => later((r) => focusFirst(r, { force })) };
                };
                const flowed = (flow) => {
                    const d = api.peek(defPath);
                    const drv = driveInputFlow(api, {
                        flow, state: `${f}.flow`, rootOf: rootEl,
                        targets: (input) => {
                            const spec = d?.inputs?.[input];
                            if (!spec) return null;
                            return {
                                control: () => controlFor(rootEl(), `${f}.${input}`),
                                filled: () => { const v = api.peek(`${f}.data.${input}`); return v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length); },
                                value: () => api.peek(`${f}.data.${input}`) ?? null,
                                set: (v) => change(input, v),
                                object: spec.type === "ref" ? spec.to : null,
                            };
                        },
                        forms: { [name]: { primary: () => rootEl()?.querySelector(".form-foot .tx-check, .form-foot .tx-run"), confirm: () => rootEl()?.querySelector(".form-foot .tx-run"), preview: `${f}.preview`, done: `${f}.done`, errors: `${f}.serverErrors`, signs: Boolean(d?.signature) } },
                        scope: () => ({ param: {}, user: { id: api.peek("me.id") } }),
                    });
                    return { stop: drv.stop, show: (force) => (force || !drv.at() ? drv.resume() : null) };
                };
                // Its input flow, or none, as the transaction's version says.
                const stopMode = api.bindState(() => `${api.getState(`${defPath}.version`, 0)}:${api.getState(`${defPath}.inputFlow.version`, 0)}`, () => {
                    const d = api.peek(defPath);
                    if (!d) return;
                    mode?.stop();
                    mode = d.inputFlow ? flowed(d.inputFlow) : defaults();
                    if (api.peek(formDef) && (!active || active())) mode.show(false);
                });
                // Drawn, it takes the cursor if nobody else has it; a screen's tab switched to (by a click, or
                // Alt and its number) hands it the cursor.
                const stopShown = api.bindState(() => `${Boolean(api.getState(formDef, null))}:${!active || Boolean(active())}`, (now) => {
                    const [loaded, shown] = now.split(":").map((x) => x === "true");
                    if (!loaded) return;
                    if (shown && mode) mode.show(hidden);
                    hidden = !shown;
                });
                return () => { stopMode(); stopShown(); mode?.stop(); };
            });
        }

        // The form's definition and rights follow the transaction's version; a record it was opened
        // from fills its input; an input "from" another follows that record.
        const stop = api.bindState(() => api.getState(`${defPath}.version`), () => {
            const d = api.peek(defPath);
            if (!d) return;
            api.batch(() => {
                api.setValue(formDef, { object: null, transaction: d.name, label: d.label, fields: asFields(d.inputs), form: d.form ?? undefined });
                api.setValue(permPath, {
                    fields: Object.fromEntries(Object.entries(d.inputs).map(([k, s]) => [k, s.from || Object.hasOwn(filled, k) ? "r" : "w"])),
                    why: Object.fromEntries(Object.entries(d.inputs).filter(([k, s]) => s.from || Object.hasOwn(filled, k)).map(([k, s]) => [k, s.from ? "derived" : "screen"])),
                });
                if (from && d.appearsOn?.fills && !api.peek(`${f}.data.${d.appearsOn.fills}`)) api.setValue(`${f}.data.${d.appearsOn.fills}`, from);
                for (const [k, v] of Object.entries(filled)) if (Object.hasOwn(d.inputs, k)) api.setValue(`${f}.data.${k}`, v);
            });
            if (!embedded) titleTab(api, from ? `/t/${name}/${from}` : `/t/${name}`, d.label);
            if (api.isServer) return;
            while (derivedStops.length) derivedStops.pop()();
            for (const [k, s] of Object.entries(d.inputs)) {
                if (!s.from) continue;
                const [source, field] = s.from.split(".");
                const sourceTo = d.inputs[source]?.to;
                derivedStops.push(api.bindState(() => api.getState(`${f}.data.${source}`, null), (id) => {
                    if (!id) { api.setValue(`${f}.data.${k}`, null); return; }
                    api.call("records.get", { object: sourceTo, id, as }).then((r) => api.setValue(`${f}.data.${k}`, r?.[field] ?? null), () => api.setValue(`${f}.data.${k}`, null));
                }));
            }
        });
        // What the last check said is about the inputs as they were: left behind (the form closed, the
        // page or the screen's tab left), it is cleared, so nobody comes back to red borders for inputs
        // that may have changed since. What was typed stays.
        const forget = () => api.batch(() => { api.setValue(`${f}.serverErrors`, {}); api.setValue(`${f}.scan`, {}); api.setValue(`${f}.preview`, null); });
        const stopActive = active ? api.bindState(() => Boolean(active()), (on) => { if (!on) forget(); }) : () => {};
        api.onCleanup(() => { stop(); stopActive(); forget(); while (derivedStops.length) derivedStops.pop()(); });

        // Any edit makes the last preview, the last result and every error the last check gave old news:
        // a transaction's checks are about its inputs together (a machine refused may be fixed by
        // picking another lot), so one edit clears them all.
        const change = (field, value) => {
            api.batch(() => { api.setValue(`${f}.preview`, null); api.setValue(`${f}.done`, null); api.setValue(`${f}.serverErrors`, {}); });
            form.change(field, value);
        };
        // Clear: every input empty again but what the screen or the record fills in, and no messages.
        const clear = () => {
            const d = api.peek(defPath);
            api.batch(() => {
                api.setValue(`${f}.data`, { ...filled, ...(from && d?.appearsOn?.fills ? { [d.appearsOn.fills]: from } : {}) });
                api.setValue(`${f}.serverErrors`, {});
                api.setValue(`${f}.scan`, {});
                api.setValue(`${f}.ruleErrors`, {});
                api.setValue(`${f}.preview`, null);
                api.setValue(`${f}.done`, null);
                api.setValue(`${f}.sign`, false);
                api.setValue(`${f}.dirty`, false);
            });
        };
        // Anything to clear: each leaf read by name (a write to one wakes it, never its ancestors).
        const anything = () => {
            const data = api.getState(`${f}.data`, {}) ?? {};
            const keep = { ...filled, ...(from ? { [api.peek(`${defPath}.appearsOn.fills`)]: from } : {}) };
            const derived = api.peek(`${defPath}.inputs`) ?? {};
            return Object.entries(data).some(([k, v]) => !derived[k]?.from && v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length) && keep[k] !== v)
                || Object.keys(api.getState(`${f}.serverErrors`, {}) ?? {}).length > 0 || Object.keys(api.peek(`${defPath}.inputs`) ?? {}).some((k) => api.getState(`${f}.scan.${k}.miss`, null)) || Boolean(api.getState(`${f}.done`, null));
        };
        const input = () => {
            const d = api.peek(defPath);
            const data = api.peek(`${f}.data`) ?? {};
            return Object.fromEntries(Object.keys(d?.inputs ?? {}).filter((k) => !d.inputs[k].from && data[k] !== null && data[k] !== undefined && data[k] !== "").map((k) => [k, data[k]]));
        };
        const shownErrors = (error) => {
            const fields = error?.fields && typeof error.fields === "object" ? error.fields : {};
            api.setValue(`${f}.serverErrors`, { ...Object.fromEntries(Object.entries(fields).filter(([k, v]) => typeof v === "string" && !k.includes("."))), _form: error?.message ?? "It could not be checked." });
        };
        const check = async () => {
            api.batch(() => { api.setValue(`${f}.checking`, true); api.setValue(`${f}.serverErrors`, {}); api.setValue(`${f}.done`, null); });
            try {
                api.setValue(`${f}.preview`, await api.call("transactions.preview", { name, input: input() }));
            } catch (error) {
                shownErrors(error);
            } finally {
                api.setValue(`${f}.checking`, false);
            }
        };
        const run = () => {
            const d = api.peek(defPath);
            // Verified by a second person (§7.4), or signed by one where the plant asks a password: each signer's
            // password, or their fresh single sign-on, goes with the run and leaves the page at once.
            const proofs = d.signature?.verifier || api.peek("signing.password")
                ? { ...(api.peek(`${f}.sso1`) ? { sso: true } : { password: api.peek(`${f}.pw1`) ?? "" }), ...(d.signature?.verifier ? (api.peek(`${f}.sso2`) ? { secondSso: true } : { secondPassword: api.peek(`${f}.pw2`) ?? "" }) : {}) }
                : {};
            const signature = d.signature ? { meaning: d.signature.meaning, agree: Boolean(api.peek(`${f}.sign`)), ...proofs } : undefined;
            if (d.signature) api.batch(() => { for (const k of ["pw1", "pw2"]) api.setValue(`${f}.${k}`, ""); for (const k of ["sso1", "sso2"]) api.setValue(`${f}.${k}`, false); });
            return form.submit((key) => api.call("transactions.run", { name, input: input(), key, ...(signature ? { signature } : {}) }), (result) => {
                api.batch(() => {
                    api.setValue(`${f}.done`, result);
                    api.setValue(`${f}.preview`, null);
                    api.setValue(`${f}.sign`, false);
                    api.setValue(`${f}.dirty`, false);
                    // Ready for the next one: every input empty again (a derived one follows), but what the screen fills.
                    api.setValue(`${f}.data`, { ...filled });
                });
                onDone?.(result);
            });
        };

        const changeList = (changes) => ({
            ul: {
                className: "tx-changes",
                children: changes.map((c, i) => ({
                    li: {
                        key: c.id ?? `new-${c.object}-${i}`,
                        children: [
                            c.id ? { Link: { to: `/o/${c.object}/${c.id}`, className: "tx-record", textContent: `${c.label} ${c.title}` } } : { strong: { className: "tx-record", textContent: `${c.label} ${c.title}` } },
                            c.created ? { span: { className: "tx-state", children: [{ span: { className: "badge tone-info", textContent: "new" } }, icon("arrowRight"), { span: { className: stateBadgeClass(c.state.to, c.state.tones), textContent: words(c.state.to) } }] } } : c.state ? { span: { className: "tx-state", children: [{ span: { className: stateBadgeClass(c.state.from, c.state.tones), textContent: words(c.state.from) } }, icon("arrowRight"), { span: { className: stateBadgeClass(c.state.to, c.state.tones), textContent: words(c.state.to) } }] } } : { span: {} },
                            ...Object.entries(c.fields).map(([k, v]) => ({ div: { key: k, className: "tx-field small", textContent: c.created ? `${v.label}: ${shown(v.to)}` : `${v.label}: ${shown(v.from)} → ${shown(v.to)}` } })),
                        ],
                    },
                })),
            },
        });

        // Pop-ups over this transaction (§26.7), asked again as its inputs are filled in: each input read by
        // name (a write to one wakes it, never the inputs above it).
        const filledIn = () => Object.fromEntries(Object.keys(api.getState(`${defPath}.inputs`, {}) ?? {}).map((k) => [k, api.getState(`${f}.data.${k}`, null)]));
        return {
            div: {
                id: rootId,
                className: embedded ? "transaction embedded" : "view transaction",
                children: [
                    embedded ? { span: {} } : { PopupWatch: { key: `pw-t-${name}-${from ?? ""}`, target: `transaction:${name}`, values: filledIn } },
                    () => {
                        const d = api.getState(defPath);
                        if (d === null) return { div: { children: [{ h1: "Not available" }, { p: { className: "muted", textContent: "This transaction does not exist, or you may not run it." } }] } };
                        if (!d) return { p: { className: "muted", textContent: "Loading…" } };
                        if (embedded) return d.description ? { p: { className: "muted small", textContent: d.description } } : { span: {} };
                        return {
                            div: {
                                className: "record-head",
                                children: [
                                    { div: { className: "title", children: [{ GuideToggle: { key: `guide-t-${name}`, title: `${d.label}: this transaction`, make: () => formGuide(api.peek(formDef), { intro: `${d.description ? `${d.description} ` : ""}Fill it in, check it, and confirm: everything it changes is done at once, or nothing.`, lead: [{ title: "Running it", items: [
                                        { label: "Check", words: "Checks what you entered and shows what will change, before anything does.", highlight: ".tx-check" },
                                        { label: "Confirm", words: "Makes the change. If the design asks for it, you sign first (your name and its meaning).", highlight: ".tx-run" },
                                        { label: "Clear", words: "Empties the form and its messages.", highlight: ".btn.ghost[title^='Empty']" },
                                    ] }] }) } }, { span: { className: "kind", textContent: "Transaction" } }, { h1: d.label }] } },
                                    // Its design may let it fill the window (a kiosk at a machine).
                                    // So may this desktop's own page (§6.8): opened filled at each sign-in.
                                    d.maximize || deskHome(api, from ? `/t/${name}/${from}` : `/t/${name}`) ? { MaximizeToggle: { key: `max-${name}`, path: from ? `/t/${name}/${from}` : `/t/${name}`, ...homeFill(api, from ? `/t/${name}/${from}` : `/t/${name}`, d.maximize, `t.${name}`) } } : { span: {} },
                                    d.description ? { p: { className: "muted", textContent: d.description } } : { span: {} },
                                ],
                            },
                        };
                    },
                    // Its input flow's step (§32.13): what it asks for now, or what stopped it.
                    () => {
                        const error = api.getState(`${f}.flow.error`, null);
                        const prompt = api.getState(`${f}.flow.prompt`, null);
                        if (!error && !prompt) return { span: {} };
                        return { p: { className: `flow-prompt${error ? " bad" : ""}`, role: "status", "aria-live": "polite", children: [icon(error ? "warning" : "scan"), { span: error ?? prompt }] } };
                    },
                    () => (api.getState(formDef) ? { FormBody: { f, defPath: formDef, permPath, onChange: change, onCommit: form.commit, onWhy: null } } : { span: {} }),
                    // What will change, once checked; the person confirms exactly this.
                    () => {
                        const p = api.getState(`${f}.preview`, null);
                        if (!p) return { span: {} };
                        return { section: { className: "tx-preview panel", children: [{ h3: "What will change" }, changeList(p.changes), ...(p.also ?? []).map((a) => ({ p: { key: `also-${a.step}`, className: "small", textContent: `Then: ${a.label}.` } })), { p: { className: "muted small", textContent: "Nothing has changed yet. All of it happens together, or none of it." } }] } };
                    },
                    () => {
                        const done = api.getState(`${f}.done`, null);
                        if (!done) return { span: {} };
                        return { section: { className: "tx-done panel", role: "status", children: [{ h3: { className: "icon-text", children: [icon("check"), { span: `${done.label}: done` }] } }, changeList(done.changes)] } };
                    },
                    () => {
                        const d = api.getState(defPath);
                        if (!d) return { span: {} };
                        const previewed = Boolean(api.getState(`${f}.preview`, null));
                        const saving = api.getState(`${f}.saving`, false);
                        const checking = api.getState(`${f}.checking`, false);
                        const needsSign = Boolean(d.signature);
                        // Read where it is drawn, not here: ticking it redraws the box alone, not the passwords beside it.
                        const signed = () => api.getState(`${f}.sign`, false);
                        // A second person verifies it (§7.4): the one signed in beside them; both re-enter their
                        // passwords (none on a development or demo instance, where anyone is anyone).
                        const verifier = d.signature?.verifier ?? null;
                        const second = api.getState("me.second", null);
                        const noPasswords = api.getState("picker", false);
                        // Signed by one, where the plant asks each signer to prove who they are (§7.4).
                        const asksOne = !verifier && !noPasswords && api.getState("signing.password", false);
                        const proved = (n) => api.getState(`${f}.sso${n}`, false) || Boolean(api.getState(`${f}.pw${n}`, ""));
                        const passwordsIn = () => noPasswords || (proved(1) && proved(2));
                        const runButton = { button: { type: "button", className: "btn primary tx-run", disabled: () => saving || form.blocked() || (needsSign && !api.getState(`${f}.sign`, false)) || (verifier && (!api.getState("me.second", null) || !passwordsIn())) || (asksOne && !proved(1)), textContent: saving ? "Running…" : previewed || !d.confirm ? `Confirm ${d.label}` : d.label, onclick: run } };
                        // A signer's password, or (single sign-on) a fresh sign-in at the provider instead.
                        const pw = (key, label, who = "me") => {
                            const n = key.slice(-1);
                            return { div: { className: "tx-pw-row", children: [
                                () => (api.getState(`${f}.sso${n}`, false)
                                    ? { p: { className: "small tx-pw-sso", children: [icon("check"), { span: ` ${who === "second" ? "They" : "You"} signed in again with single sign-on.` }] } }
                                    : { label: { className: "tx-pw", children: [{ span: label }, { input: { type: "password", autocomplete: "off", "aria-label": label, value: () => api.getState(`${f}.${key}`, ""), oninput: (e) => api.setValue(`${f}.${key}`, e.target.value) } }] } }),
                                api.getState("signing.sso", false) ? { button: { type: "button", className: "btn small", textContent: "Sign in again with single sign-on", onclick: async () => { if (await freshSignOn(who)) api.batch(() => { api.setValue(`${f}.sso${n}`, true); api.setValue(`${f}.${key}`, ""); }); } } } : { span: {} },
                            ] } };
                        };
                        const signArea = !needsSign || !(previewed || !d.confirm) ? { span: {} } : !verifier
                            ? (asksOne
                                ? { div: { className: "tx-sign tx-sign-two", children: [{ label: { children: [{ input: { type: "checkbox", checked: signed, onchange: (e) => api.setValue(`${f}.sign`, e.target.checked) } }, { span: ` I sign this electronically: “${d.signature.meaning}”, as ${api.peek("me.name")}` }] } }, pw("pw1", "Your password")] } }
                                : { label: { className: "tx-sign", children: [{ input: { type: "checkbox", checked: signed, onchange: (e) => api.setValue(`${f}.sign`, e.target.checked) } }, { span: ` I sign this electronically: “${d.signature.meaning}”, as ${api.peek("me.name")}` }] } })
                            : !second
                                ? { div: { className: "tx-sign tx-sign-two", children: [{ p: { className: "small", children: [icon("users"), { span: ` A second person verifies this (“${verifier.meaning}”): they sign in beside you first.` }] } }, { button: { type: "button", className: "btn", textContent: "Add a second person", onclick: (e) => { e.stopPropagation(); api.setValue("ui.second.open", true); setTimeout(() => document.querySelector(".second-panel input")?.focus(), 0); } } }] } }
                                : { div: { className: "tx-sign tx-sign-two", children: [
                                    { label: { children: [{ input: { type: "checkbox", checked: signed, onchange: (e) => api.setValue(`${f}.sign`, e.target.checked) } }, { span: ` I sign this electronically: “${d.signature.meaning}”, as ${api.peek("me.name")}` }] } },
                                    noPasswords ? { span: {} } : pw("pw1", "Your password"),
                                    { p: { className: "small", textContent: `Verified by ${second.name}: “${verifier.meaning}”` } },
                                    noPasswords ? { p: { className: "muted small", textContent: "No passwords on a development or demo instance: who signs is checked all the same." } } : pw("pw2", `${second.name}'s password`, "second"),
                                ] } };
                        return {
                            div: {
                                className: "form-foot",
                                children: [
                                    signArea,
                                    d.confirm && !previewed
                                        ? { button: { type: "button", className: "btn primary tx-check", disabled: checking || saving || form.blocked(), textContent: checking ? "Checking…" : `Check ${d.label}`, onclick: check } }
                                        : runButton,
                                    previewed ? { button: { type: "button", className: "btn ghost", textContent: "Change something", onclick: () => api.setValue(`${f}.preview`, null) } } : { span: {} },
                                    { button: { type: "button", className: "btn ghost", hidden: () => !anything(), disabled: saving, title: "Empty the form and its messages", textContent: "Clear", onclick: clear } },
                                    { SendAgain: { f, form } },
                                    from && !embedded ? { Link: { to: `/o/${d.appearsOn?.object}/${from}`, className: "btn ghost", textContent: "Back to the record" } } : { span: {} },
                                ],
                            },
                        };
                    },
                ],
            },
        };
    });
}
