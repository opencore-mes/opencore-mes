import { noDefault } from "./select.js";
// Dialogs (DESIGN.md §10.6): one modal at a time, drawn by a single host in the shell from state
// (`ui.dialog`), so any screen can ask for a confirmation or a value and await the answer:
//
//   if (await confirmDialog(api, { title: "Archive lot 4711?", message: "…", confirm: "Archive", danger: true })) …
//   const why = await askDialog(api, { title: "Reject for Quality", label: "Why?", required: true, multiline: true });
//                                     // → the value, or null when cancelled
//
// A real modal: the page behind is covered (a click on it cancels), focus moves into it and stays
// there (Tab cycles), Esc cancels, Enter confirms (Ctrl/⌘ + Enter in a text box), and focus returns to
// where it was. Text is drawn as text; nothing a caller passes is markup.
//
// askDialog's field: { type: "text" | "number" | "date" | "enum", multiline, values (enum), label,
// placeholder, required, value (the starting value), check: (value) → words when it is not right }.

const pending = new Map(); // dialog id → resolve
const checks = new Map();  // dialog id → check(value): kept out of state, which holds data only
const signOns = new Map(); // dialog id → freshSignOn(): a sign dialog's single sign-on (sign.js)
let counter = 0;

function open(api, { check = null, ...spec }) {
    if (api.isServer) return Promise.resolve(spec.kind === "confirm" ? false : null);
    // A second dialog while one is open answers the first as cancelled: one question at a time.
    const current = api.peek("ui.dialog");
    if (current) finish(api, current.id, current.kind === "confirm" ? false : null);
    const id = `d${++counter}`;
    const opener = globalThis.document?.activeElement ?? null;
    if (typeof check === "function") checks.set(id, check);
    return new Promise((resolve) => {
        pending.set(id, (answer) => {
            resolve(answer);
            // Focus goes back to what opened it, if it is still on the page.
            if (opener?.isConnected) setTimeout(() => opener.focus?.(), 0);
        });
        api.setValue("ui.dialog", { ...spec, id, value: spec.field?.value ?? (spec.field?.type === "enum" ? "" : ""), error: null });
    });
}
function finish(api, id, answer) {
    const resolve = pending.get(id);
    pending.delete(id);
    checks.delete(id);
    signOns.delete(id);
    if (api.peek("ui.dialog")?.id === id) api.setValue("ui.dialog", null);
    resolve?.(answer);
}

// → true (confirmed) or false (cancelled).
export const confirmDialog = (api, { title, message = "", confirm = "OK", cancel = "Cancel", danger = false } = {}) =>
    open(api, { kind: "confirm", title, message, confirm, cancel, danger });

// → the value entered, or null when cancelled.
export const askDialog = (api, { title, message = "", label = "", placeholder = "", required = false, multiline = false, type = "text", values = null, value = "", check = null, confirm = "OK", cancel = "Cancel", danger = false } = {}) =>
    open(api, { kind: "ask", title, message, confirm, cancel, danger, field: { label, placeholder, required, multiline, type, values, value }, check });

// A signature (sign.js signDialog): its question; where the plant asks it (`asks`), the signer's
// password, or (`sso`) a fresh single sign-on. → { password } | { sso: true } | {} (nothing asked), or
// null when cancelled.
export const signDialog = (api, { title, message = "", confirm = "Sign", danger = false, asks = false, sso = false, freshSignOn = null } = {}) => {
    const answer = open(api, { kind: asks ? "sign" : "confirm", title, message, confirm, cancel: "Cancel", danger, sso, ...(asks ? { field: { label: "Your password", type: "password", required: false, value: "" } } : {}) });
    const id = api.peek("ui.dialog")?.id;
    if (id && freshSignOn) signOns.set(id, freshSignOn);
    return answer.then((v) => (v === false || v === null ? null : asks ? v : {}));
};

export function registerDialog(juris) {
    juris.registerComponent("DialogHost", (props, api) => () => {
        const d = api.getState("ui.dialog", null);
        if (!d || api.isServer) return { span: {} };
        const panelId = `dialog-${d.id}`;
        const inputId = `${panelId}-value`;
        const valueOf = () => {
            const raw = api.peek("ui.dialog.value");
            if (d.field?.type === "number") return raw === "" || raw === null ? null : Number(raw);
            return typeof raw === "string" ? raw.trim() : raw;
        };
        const accept = () => {
            if (d.kind === "confirm") return finish(api, d.id, true);
            // A signature: the password typed (a single sign-on answers by its own button).
            if (d.kind === "sign") {
                const pw = String(api.peek("ui.dialog.value") ?? "");
                if (!pw) return api.setValue("ui.dialog.error", d.sso ? "Enter your password, or sign in again with single sign-on." : "Enter your password.");
                return finish(api, d.id, { password: pw });
            }
            const value = valueOf();
            const empty = value === null || value === "" || (typeof value === "number" && Number.isNaN(value));
            if (d.field.required && empty) return api.setValue("ui.dialog.error", "This is required.");
            if (d.field.type === "number" && !empty && !Number.isFinite(value)) return api.setValue("ui.dialog.error", "A number.");
            const check = checks.get(d.id);
            const words = check && !empty ? check(value) : null;
            if (words) return api.setValue("ui.dialog.error", words);
            finish(api, d.id, empty ? null : value);
        };
        const cancel = () => finish(api, d.id, d.kind === "confirm" ? false : null);
        // Focus into the dialog once it is drawn: the input, or the confirm button.
        setTimeout(() => {
            const panel = globalThis.document?.getElementById(panelId);
            if (panel && !panel.contains(globalThis.document.activeElement)) (panel.querySelector("input, textarea, select") ?? panel.querySelector(".dialog-confirm"))?.focus();
        }, 0);
        const keys = (e) => {
            if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
            if (e.key === "Enter" && (e.target.tagName !== "TEXTAREA" || e.metaKey || e.ctrlKey) && e.target.tagName !== "BUTTON") { e.preventDefault(); accept(); return; }
            if (e.key === "Tab") {
                // Focus stays inside: Tab from the last control goes to the first, Shift+Tab the other way.
                const panel = globalThis.document.getElementById(panelId);
                const items = [...panel.querySelectorAll("input, textarea, select, button")].filter((x) => !x.disabled);
                if (!items.length) return;
                const first = items[0];
                const last = items.at(-1);
                if (e.shiftKey && globalThis.document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && globalThis.document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        };
        const f = d.field;
        const control = !f ? { span: {} } : f.type === "enum"
            ? { select: { id: inputId, onchange: (e) => api.setValue("ui.dialog.value", e.target.value), children: noDefault([{ option: { value: "", textContent: "—" } }, ...(f.values ?? []).map((v) => ({ option: { value: v, selected: d.value === v, textContent: v } }))]) } }
            : f.multiline
                ? { textarea: { id: inputId, rows: 4, placeholder: f.placeholder, value: () => api.getState("ui.dialog.value", "") ?? "", oninput: (e) => { api.setValue("ui.dialog.value", e.target.value); api.setValue("ui.dialog.error", null); } } }
                : { input: { id: inputId, type: f.type === "number" ? "number" : f.type === "date" ? "date" : f.type === "password" ? "password" : "text", step: f.type === "number" ? "any" : undefined, placeholder: f.placeholder, autocomplete: f.type === "password" ? "current-password" : "off", value: () => String(api.getState("ui.dialog.value", "") ?? ""), oninput: (e) => { api.setValue("ui.dialog.value", e.target.value); api.setValue("ui.dialog.error", null); } } };
        return {
            div: {
                className: "dialog-backdrop",
                // A click on the dim area outside the panel cancels, as Esc does.
                onmousedown: (e) => { if (e.target === e.currentTarget) cancel(); },
                children: [{
                    div: {
                        id: panelId, className: `dialog-panel${d.danger ? " danger" : ""}`, role: d.kind === "confirm" || d.kind === "sign" ? "alertdialog" : "dialog", "aria-modal": "true", "aria-labelledby": `${panelId}-title`, "aria-describedby": d.message ? `${panelId}-message` : undefined,
                        onkeydown: keys,
                        children: [
                            { h2: { id: `${panelId}-title`, className: "dialog-title", textContent: d.title ?? "" } },
                            d.message ? { p: { id: `${panelId}-message`, className: "dialog-message", textContent: d.message } } : { span: {} },
                            f ? { label: { className: "dialog-field", htmlFor: inputId, children: [f.label ? { span: `${f.label}${f.required ? " *" : ""}` } : { span: {} }, control] } } : { span: {} },
                            // A fresh single sign-on instead of the password (sign.js): its own small window.
                            d.kind === "sign" && d.sso ? { div: { className: "dialog-sso", children: [
                                { span: { className: "muted small", textContent: "or" } },
                                { button: { type: "button", className: "btn", textContent: "Sign in again with single sign-on", onclick: async () => {
                                    api.setValue("ui.dialog.error", null);
                                    const ok = await signOns.get(d.id)?.();
                                    if (ok) finish(api, d.id, { sso: true }); else api.setValue("ui.dialog.error", "Single sign-on did not complete: try again, or enter your password.");
                                } } },
                            ] } } : { span: {} },
                            { p: { className: "field-error", role: "alert", textContent: () => api.getState("ui.dialog.error", "") ?? "" } },
                            { div: { className: "dialog-buttons", children: [
                                { button: { type: "button", className: "btn ghost dialog-cancel", textContent: d.cancel, onclick: cancel } },
                                { button: { type: "button", className: `btn primary dialog-confirm${d.danger ? " danger" : ""}`, textContent: d.confirm, onclick: accept } },
                            ] } },
                        ],
                    },
                }],
            },
        };
    });
}
