// Lists and forms for any object, drawn from its definition (DESIGN.md §10): the screens are compiled
// from data, never passed through, and every value from a record is drawn as text or as a value.
import { uploadPicture, pictureUrl, PICTURE_TYPES } from "./picture.js";
import { noDefault } from "./select.js";
import { formGuide } from "./guide.js";
import { titleTab, retab } from "./shell.js";
import { rulesFor } from "./rules-client.js";
import { dbDown, noteFailure, outcomeUnknown, NO_ANSWER } from "./db-status.js";
import { normalizeForm } from "./form-layout.js";
import { evaluate, referencesOf } from "./expr.js";
import { confirmDialog, askDialog } from "./dialog.js";
import { reasonFor, sentWords } from "./requests.js";
import { needsApproval, recordRoute, isHidden, lengthOf } from "./definition.js";
import { plant, noun as nounOf } from "./format.js";
import { icon } from "./icons.js";
import { stateBadgeClass } from "./theme.js";
import { useRunMap, routeMaps } from "./flow-picture.js";

// A text box that grows with what is typed (its layout's maxRows), up to its largest height (app.css .grows).
const grow = (el) => { if (!el?.classList?.contains("grows")) return; el.style.height = "auto"; el.style.height = `${el.scrollHeight + 2}px`; };
const REASONS = {
    state: "not in this state",
    role: "not your role",
    condition: "a condition does not hold",
    deny: "locked by a rule",
    archived: "archived",
    transaction: "changed through a transaction",
    derived: "filled in for you",
    screen: "set by this screen",
    managed: "kept in People & departments",
};

// Where a derived field (§6.11) comes from, in words: "kept from Product → control" (a path), or
// "worked out from its references" (an expression).
function derivedWords(def, derived) {
    if (typeof derived !== "string") return "worked out from its references";
    const [head, ...rest] = derived.split(".");
    return `kept from ${[def.fields?.[head]?.label ?? head, ...rest.map((p) => p.replace(/_/g, " "))].join(" → ")}`;
}

// What a form holds that its object's design says waits for approval (§28): the fields changed (a new
// record: the fields filled in) and whether they wait, read leaf by leaf so the form follows each edit.
// → { changed: [names], spec, waits } (waits false: a plain save).
function pendingOf(api, f, def, rec) {
    if (!def?.approval) return { changed: [], waits: false };
    // In the form's order (its tabs and sections), then any field it does not lay out.
    const laid = normalizeForm(def).tabs.flatMap((t) => t.sections.flatMap((sec) => sec.fields.map((e) => e.field)));
    const names = [...new Set([...laid, ...Object.keys(def.fields)])];
    const value = (n) => api.getState(`${f}.data.${n}`, null);
    const blank = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
    const changed = rec
        ? names.filter((n) => JSON.stringify(value(n) ?? null) !== JSON.stringify(baseOf(api, f, rec, n) ?? null))
        : names.filter((n) => !blank(value(n)));
    // The record's value that says who approves (§28.3a), as it is and as edited.
    const by = def.approval?.by?.field;
    const asked = by ? { [by]: value(by) } : null;
    const spec = rec ? { op: "edit", state: rec.state, changed, now: rec, asked } : { op: "create", changed, asked };
    return { changed, spec, waits: changed.length > 0 && needsApproval(def, spec) };
}

// A history row about a change that waited for approval (§28), in words.
const requestWords = (r) => {
    const a = r.after ?? {};
    const kind = r.action.slice("request:".length);
    if (kind === "edit" || kind === "create" || kind === "action" || kind === "archive" || kind === "restore") return `${kind === "create" ? "New record" : kind === "action" ? `${a.action}` : kind === "archive" ? "Archiving" : kind === "restore" ? "Restoring" : "Change"} sent for approval by ${(a.route ?? []).join(", ")}`;
    if (kind === "approve") return `Approved for ${a.department}${a.step && a.step !== "Approver" ? ` (${a.step})` : ""}`;
    if (kind === "reject") return `Rejected for ${a.department}`;
    return { applied: "Approved change applied", void: "Approved change void: not applied", rejected: "Change rejected", withdrawn: "Change withdrawn" }[kind] ?? r.action;
};
// A value in the history: a sensitive one (§6.10) as hidden; the audit trail never holds it.
const historyValue = (v) => (v === undefined || v === null || v === "" ? "—" : isHidden(v) ? "hidden" : v);
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

// What a form's field held when it was read: a sensitive one (§6.10) shown on this page, its value as
// shown (`${f}.shown`); otherwise the record's, its marker for one not shown.
const baseOf = (api, f, rec, name) => {
    const shown = api.peek(`${f}.shown`);
    return shown && Object.hasOwn(shown, name) ? shown[name] : rec?.[name];
};
const HIDDEN_WORDS = "Hidden: sensitive";
// The form's sensitive fields are drawn hidden or shown by what its data holds: told to look again
// whenever that changes as a whole (read, shown, saved, discarded), never on each key typed.
const rehide = (api, f) => api.setValue(`${f}.shownAt`, (api.peek(`${f}.shownAt`) ?? 0) + 1);

// A list (one state, no actions): its records have no lifecycle, so no state is shown.
export const isList = (def) => (def?.states?.list?.length ?? 0) <= 1 && !(def?.states?.transitions ?? []).length;

function display(def, row, name) {
    const field = def?.fields?.[name];
    const value = row?.[name];
    if (value === undefined || value === null || value === "") return "—";
    if (isHidden(value)) return HIDDEN_WORDS;
    if (field?.type === "ref") return row.$titles?.[name] ?? "(not visible to you)";
    if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
    if (field?.type === "boolean") return value ? "yes" : "no";
    if (field?.type === "decimal" || field?.type === "integer") return plant().number(value);
    if (field?.type === "date") return plant().date(value);
    if (field?.type === "image") return "picture";
    if (field?.type === "file") return "file";
    return String(value);
}

const pickData = (def, record) => {
    const out = {};
    if (!def || !record) return out;
    for (const name of Object.keys(def.fields)) if (record[name] !== undefined) out[name] = record[name];
    return out;
};

function parseInput(field, raw) {
    if (field.type === "decimal" || field.type === "integer") {
        if (raw === "") return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : raw;
    }
    if (field.type === "boolean") return raw === "true";
    return raw === "" ? null : raw;
}

// One field's input, drawn with its widget (form-layout.js WIDGETS). Every widget writes through
// onChange (as typed) and onCommit (a finished edit), as the plain input always did.
function control(api, { id, f, name, field, entry, disabled, value, onChange, onCommit, record = null, form = null }) {
    // A reference whose choices come from a named query (§23.1): searched among the query's rows, whatever its widget.
    if (field.type === "ref" && field.options?.query && entry.widget !== "scan") {
        const source = form?.transaction ? { transaction: form.transaction, name } : { object: form?.object, name };
        return { RefSearch: { id, f, name, to: field.to, noun: field.label, disabled, placeholder: entry.placeholder ?? "Pick one of its choices…", minChars: 0, source, onPick: (v) => { onChange(name, v); onCommit(name); } } };
    }
    const set = (v) => { onChange(name, v); onCommit(name); };
    const choice = (v) => (Array.isArray(value(name)) ? value(name) : []).includes(v);
    const toggle = (v, on) => {
        const now = Array.isArray(api.peek(`${f}.data.${name}`)) ? [...api.peek(`${f}.data.${name}`)] : [];
        set(on ? [...new Set([...now, v])] : now.filter((x) => x !== v));
    };
    switch (entry.widget) {
        case "radio":
            return { div: { id, className: "choice-list", role: "radiogroup", children: field.values.map((v) => ({ label: { key: v, children: [{ input: { type: "radio", name: id, disabled, checked: () => value(name) === v, onchange: () => set(v) } }, { span: ` ${v}` }] } })) } };
        case "buttons":
            return { div: { id, className: "choice-buttons", children: field.values.map((v) => ({ button: { key: v, type: "button", disabled, classList: { on: () => value(name) === v }, textContent: v, onclick: () => set(value(name) === v ? null : v) } })) } };
        case "checkboxes":
            return { div: { id, className: "choice-list", children: field.values.map((v) => ({ label: { key: v, children: [{ input: { type: "checkbox", disabled, checked: () => choice(v), onchange: (e) => toggle(v, e.target.checked) } }, { span: ` ${v}` }] } })) } };
        case "chips":
            return { div: { id, className: "choice-buttons chips", children: field.values.map((v) => ({ button: { key: v, type: "button", disabled, classList: { on: () => choice(v) }, textContent: v, onclick: () => toggle(v, !choice(v)) } })) } };
        case "multiselect":
            return { select: { id, multiple: true, size: Math.min(6, field.values.length), disabled, onchange: (e) => set([...e.target.selectedOptions].map((o) => o.value)), children: field.values.map((v) => ({ option: { key: v, value: v, textContent: v, selected: () => choice(v) } })) } };
        case "checkbox":
        case "toggle":
            return { label: { className: `check-control ${entry.widget}`, children: [{ input: { id, type: "checkbox", disabled, checked: () => value(name) === true, onchange: (e) => set(e.target.checked) } }, { span: { className: "track" } }] } };
        case "yesno":
            return { div: { id, className: "choice-list inline", role: "radiogroup", children: [[true, "Yes"], [false, "No"]].map(([v, l]) => ({ label: { key: l, children: [{ input: { type: "radio", name: id, disabled, checked: () => value(name) === v, onchange: () => set(v) } }, { span: ` ${l}` }] } })) } };
        case "search":
            return { RefSearch: { id, f, name, to: field.to, noun: field.label, disabled, placeholder: entry.placeholder, minChars: entry.minChars, onPick: (v) => set(v) } };
        case "scan":
            return { ScanField: { id, f, name, to: field.to, noun: field.label, disabled, placeholder: entry.placeholder, onPick: (v) => set(v) } };
        case "stepper": {
            const step = field.type === "integer" ? 1 : 1;
            const bump = (d) => { const n = Number(api.peek(`${f}.data.${name}`) ?? 0); set(Math.round((n + d) * 1000) / 1000); };
            return { div: { className: "stepper", children: [
                { button: { type: "button", disabled, title: "Less", "aria-label": "Less", children: [icon("minus")], onclick: () => bump(-step) } },
                { input: { id, type: "number", step: field.type === "decimal" ? "any" : undefined, disabled, value: () => (value(name) ?? "").toString(), oninput: (e) => onChange(name, parseInput(field, e.target.value)), onchange: () => onCommit(name) } },
                { button: { type: "button", disabled, title: "More", "aria-label": "More", children: [icon("plus")], onclick: () => bump(step) } },
            ] } };
        }
        default:
            break;
    }
    if (field.type === "rows") return { RowsField: { id, f, name, field, disabled, onSet: (v) => set(v) } };
    if (field.type === "enum") {
        return { select: { id, disabled, onchange: (e) => set(e.target.value || null), children: noDefault([{ option: { value: "", textContent: "—" } }, ...field.values.map((v) => ({ option: { value: v, textContent: v, selected: () => value(name) === v } }))]) } };
    }
    if (field.type === "ref") return { RefField: { id, f, name, to: field.to, disabled, onPick: (v) => set(v) } };
    // A picture (§35): shown, and uploaded to the picture store by whoever may write the field.
    if (field.type === "image") return { ImageField: { id, f, name, disabled, onPick: (v) => set(v) } };
    // A file (§35.4): shown small (or here, on asking), uploaded, replaced or taken off; read through its record once saved.
    if (field.type === "file") return { FileField: { id, f, name, field, record, disabled, onPick: (v) => set(v) } };
    // A date, written and typed the plant's way (§27.6), kept as YYYY-MM-DD.
    if (field.type === "date") return { DateField: { id, f, name, disabled, onPick: (v) => set(v) } };
    // A long text: as high as its layout's rows at least, growing with what is typed up to maxRows, then
    // scrolling; no longer than the field allows (lengthOf), the count shown under it once it nears that.
    if (field.type === "text") return { div: { className: "text-box", children: [{ textarea: { id, rows: entry.rows ?? 3, maxLength: lengthOf(field), placeholder: entry.placeholder ?? "", disabled,
        className: entry.maxRows ? "grows" : "", style: entry.maxRows ? { "--max-rows": String(entry.maxRows), "--rows": String(entry.rows ?? 3) } : undefined,
        value: () => value(name) ?? "", oninput: (e) => { grow(e.target); onChange(name, parseInput(field, e.target.value)); }, onfocus: (e) => grow(e.target), onchange: (e) => { if (typeof e.target.value === "string" && e.target.value && !e.target.value.trim()) onChange(name, parseInput(field, "")); onCommit(name); } } }, { span: { className: "small muted text-count", textContent: () => { const n = String(value(name) ?? "").length; return n >= lengthOf(field) * 0.8 ? `${n} / ${lengthOf(field)}` : ""; } } }] } };
    const type = { decimal: "number", integer: "number", date: "date" }[field.type] ?? "text";
    return { input: { id, type, step: field.type === "decimal" ? "any" : undefined, maxLength: type === "text" ? lengthOf(field) : undefined, placeholder: entry.placeholder ?? "", disabled, value: () => (value(name) ?? "").toString(), oninput: (e) => onChange(name, parseInput(field, e.target.value)), onchange: (e) => { if (typeof e.target.value === "string" && e.target.value !== e.target.value.trim()) onChange(name, parseInput(field, e.target.value.trim())); onCommit(name); } } };
}

// The record page's guide, before its fields (§33): its head, its buttons, where it is on a route.
const recordLead = () => [{ title: "The record", items: [
    { label: "Its name and state", words: "Which record this is, and the state it is in now (its colour says how it stands).", highlight: ".record-head .title" },
    { label: "Live", words: "Shown while what you see follows every change as it is made, by anyone.", highlight: ".record-head .live-badge, .record-head .live" },
    { label: "Its buttons", words: "The actions you may take on it now, and the transactions that appear on it in this state. One missing? The … button says why.", highlight: ".record-head .actions" },
    { label: "Where it is on its route", words: "The flow template it goes along, the step it is at, and its way there. Stopped: why, and what to do.", highlight: ".flow-position-box:not(.none) .flow-position" },
    { label: "Show the route", words: "The route as it was designed, with this record's way on it: the steps it went through filled in, the wires it took marked, where it is now outlined, a step set by hand shown off route. Point at a step for when it was there; click a sub flow to open its own map, and the line above it to go back up.", highlight: ".flow-position-box:not(.none) .flow-map-toggle, .flow-position-box .flow-run-map" },
    { label: "Details, timeline, history", words: "Its fields; its states over time; every change made to it, by whom and when.", highlight: ".subtabs" },
] }];

export function registerRecords(juris, { args }) {
    // A sensitive field's value (§6.10): "Hidden: sensitive" and Show, which asks why and then shows it
    // here while this stays on the page (records.reveal records each showing, with who and why). With
    // `onShown(value)` the caller takes it instead (a form, to edit it). Used by lists, forms, screens.
    juris.registerComponent("SensitiveValue", ({ object, id, field, label = field, type = "string", onShown = null }, api) => {
        // Kept by the record and field it is of, never by the component's place on the page (a list's
        // rows move, and a value must never be drawn on another record's row), and gone with it.
        const path = `sv.${object}.${id}.${field}`;
        const value = () => api.getState(path, undefined);
        const setValue = (v) => api.setValue(path, v);
        api.onCleanup(() => api.deleteState(path));
        const [busy, setBusy] = api.useState("busy", false);
        const [error, setError] = api.useState("error", "");
        const show = async (e) => {
            e?.preventDefault?.();
            e?.stopPropagation?.();
            const reason = await askDialog(api, {
                title: `Show ${label}?`,
                message: `${label} is sensitive. Say why you need to see it: who saw it, when and why is recorded. It is shown on this page only, until you leave it.`,
                label: "Why", required: true, multiline: true, confirm: "Show",
                check: (v) => (String(v ?? "").trim().length < 4 ? "Say why, in a few words." : null),
            });
            if (reason === null) return;
            setBusy(true);
            setError("");
            try {
                const out = await api.call("records.reveal", { object, id, field, reason });
                if (onShown) onShown(out?.value ?? null);
                else setValue(out?.value ?? null);
            } catch (failure) {
                noteFailure(api, failure);
                setError(failure?.message ?? "It could not be shown.");
            } finally {
                setBusy(false);
            }
        };
        return {
            span: {
                className: "sensitive-value",
                children: () => (value() !== undefined
                    ? [{ span: { key: "v", textContent: display({ fields: { [field]: { type } } }, { [field]: value() }, field) } }]
                    : [
                        { span: { key: "h", className: "muted icon-text", children: [icon("lock"), { span: HIDDEN_WORDS }] } },
                        { button: { key: "b", type: "button", className: "linkish", textContent: () => (busy() ? "Showing…" : "Show"), disabled: () => busy(), title: `Show ${label}: you will be asked why`, onclick: show } },
                        { span: { key: "e", className: "field-error", textContent: () => error() } },
                    ]),
            },
        };
    });

    // A date field (§27.6): typed in the plant's format (DD.MM.YYYY, MM/DD/YYYY, …) or as YYYY-MM-DD,
    // or chosen on the browser's calendar (📅); stored as YYYY-MM-DD. What does not read as a real
    // date in that format is said so, and kept as typed until it does.
    juris.registerComponent("DateField", ({ id, f, name, disabled, onPick }, api) => {
        const [typed, setTyped] = api.useState("typed", null);
        const [bad, setBad] = api.useState("bad", false);
        const pattern = () => plant().datePattern;
        const stored = () => api.getState(`${f}.data.${name}`, null);
        const commit = (text) => {
            const t = String(text ?? "").trim();
            if (!t) { api.batch(() => { setTyped(null); setBad(false); }); onPick(null); return; }
            const iso = plant().parseDate(t);
            if (!iso) { setBad(true); return; }
            api.batch(() => { setTyped(null); setBad(false); });
            onPick(iso);
        };
        return {
            span: {
                className: "date-field",
                children: [
                    { input: { id, type: "text", inputmode: "numeric", autocomplete: "off", disabled, placeholder: pattern(), title: `Typed as ${pattern()}`, classList: { invalid: () => bad() }, value: () => typed() ?? (stored() ? plant().date(stored()) : ""), oninput: (e) => setTyped(e.target.value), onchange: (e) => commit(e.target.value) } },
                    { input: { type: "date", className: "date-native", tabindex: "-1", "aria-hidden": "true", disabled, value: () => stored() ?? "", onchange: (e) => { api.batch(() => { setTyped(null); setBad(false); }); onPick(e.target.value || null); } } },
                    { button: { type: "button", className: "date-pick", disabled, title: "Choose on a calendar", "aria-label": "Choose on a calendar", children: [icon("calendar")], onclick: (e) => { const native = e.currentTarget.parentElement.querySelector(".date-native"); try { native.showPicker(); } catch { native.focus(); } } } },
                    { span: { className: "date-hint", role: "alert", textContent: () => (bad() ? `Write it ${pattern()}.` : "") } },
                ],
            },
        };
    });

    // A picture field (§35): the picture, and for whoever may write it, a file to put in its place.
    juris.registerComponent("ImageField", ({ id, f, name, disabled, onPick }, api) => {
        const [busy, setBusy] = api.useState("busy", false);
        const [error, setError] = api.useState("error", null);
        const off = () => (typeof disabled === "function" ? disabled() : Boolean(disabled));
        const stored = () => api.getState(`${f}.data.${name}`, null);
        const choose = async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            api.batch(() => { setBusy(true); setError(null); });
            try { onPick((await uploadPicture(file)).blob); } catch (err) { setError(err.message); } finally { setBusy(false); }
        };
        return {
            div: {
                className: "image-field",
                children: [
                    () => (pictureUrl(stored()) ? { img: { className: "image-field-shown", src: pictureUrl(stored()), alt: "", loading: "lazy" } } : { span: { className: "muted small", textContent: "No picture." } }),
                    () => (off() ? { span: {} } : { span: { className: "image-field-buttons", children: [
                        { label: { className: "btn", children: [{ span: busy() ? "Uploading…" : stored() ? "Replace…" : "Upload…" }, { input: { id, type: "file", accept: PICTURE_TYPES.join(","), className: "visually-hidden", disabled: busy(), onchange: choose } }] } },
                        stored() ? { button: { type: "button", className: "btn ghost", textContent: "Remove", onclick: () => onPick(null) } } : { span: {} },
                    ] } }),
                    { span: { className: "error small", role: "alert", textContent: () => error() ?? "" } },
                ],
            },
        };
    });

    // ---- the list of one object ----
    juris.registerComponent("ObjectList", ({ object }, api) => {
        const as = api.getState("me.id", null, { track: false });
        const defPath = `d.${object}.def`;
        api.live(defPath, "defs.get", args.def(object, as));
        const [query, setQuery] = api.useState("q", "");
        // The filter reaches the server a moment after typing stops. The list grows as it is scrolled:
        // one live page of 50 after another (`loaded`), each its own part of the table; a new filter
        // starts again from the first (`gen` keeps the pages of one filter apart from the next's).
        const [asked, setAsked] = api.useState("asked", "");
        const [loaded, setLoaded] = api.useState("loaded", 1);
        const [gen, setGen] = api.useState("gen", 0);
        const pathOf = (k) => `d.${object}.list.g${gen()}.p${k}`;
        // A new filter or order asks again from page 1, but the answer it replaces stays on screen until
        // the new one arrives, then they swap at once: no empty table, no button or count that blinks out
        // and back at every pause in typing. `was`: the generation shown meanwhile.
        const [was, setWas] = api.useState("was", 0);
        const prevOf = (k) => `d.${object}.list.g${was()}.p${k}`;
        const arrived = () => api.getState(`${pathOf(1)}.rows`, null) !== null;
        const shownOf = (k) => (arrived() ? pathOf(k) : prevOf(k));
        const [wasAsked, setWasAsked] = api.useState("wasAsked", "");
        const again = () => { setWas(gen()); setLoaded(1); setGen(gen() + 1); };
        let timer = null;
        const typed = (text) => { setQuery(text); clearTimeout(timer); timer = setTimeout(() => api.batch(() => { setWasAsked(asked()); setAsked(text.trim()); again(); }), 300); };
        api.onCleanup(() => clearTimeout(timer));
        const [showArchived, setShowArchived] = api.useState("archived", false);
        // The person's own order (a column's head clicked: ascending, descending, then the design's again),
        // remembered in this browser per list; the database sorts it, over every record (records.list).
        const sortKey = `mes.sort.${object}`;
        const remembered = (() => { try { const v = JSON.parse(globalThis.localStorage?.getItem(sortKey) ?? "null"); return v && typeof v.field === "string" ? v : null; } catch { return null; } })();
        const [sortBy, setSortBy] = api.useState("sort", api.isServer ? null : remembered);
        const sortOn = (field) => {
            const now = sortBy();
            const next = now?.field !== field ? { field, dir: "asc" } : now.dir === "asc" ? { field, dir: "desc" } : null;
            try { if (next) globalThis.localStorage?.setItem(sortKey, JSON.stringify(next)); else globalThis.localStorage?.removeItem(sortKey); } catch { /* private window: not remembered */ }
            api.batch(() => { setWasAsked(asked()); setSortBy(next); again(); });
        };
        // A column's head: a button that sorts by it (not a sensitive field, a picture or a file), its arrow
        // saying how the list is sorted now (the person's order, else the design's).
        const sortHead = (def, field, label) => {
            const f = def.fields?.[field];
            const can = field === "state" || (f && !f.sensitive && !["image", "file"].includes(f.type));
            if (!can) return { th: label };
            const now = sortBy() ?? (def.list?.sort?.field ? { field: def.list.sort.field, dir: def.list.sort.dir ?? "asc" } : null);
            const on = now?.field === field;
            return { th: { key: field, "aria-sort": on ? (now.dir === "desc" ? "descending" : "ascending") : "none", children: [{ button: {
                type: "button", className: `sort-head${on ? " on" : ""}`,
                title: on ? (now.dir === "asc" ? `Sorted by ${label}, A to Z (lowest first): click for Z to A` : `Sorted by ${label}, Z to A (highest first): click for the list's own order`) : `Sort by ${label}`,
                onclick: () => sortOn(field),
                children: [{ span: label }, on ? icon(now.dir === "desc" ? "arrowDown" : "arrowUp", { className: "sort-arrow" }) : icon("arrowDown", { className: "sort-arrow idle" })],
            } }] } };
        };
        // Search first (the design's list.searchFirst): nothing until something is typed, except where
        // lists are simple (development, the demo, test instances).
        const searchFirst = (def) => Boolean(def?.list?.searchFirst) && !asked() && !api.getState("simpleLists", false);
        if (!api.isServer) {
            const stop = api.bindState(() => api.getState(`${defPath}.label`), (label) => titleTab(api, `/o/${object}`, label));
            api.onCleanup(stop);
        }
        return {
            div: {
                className: "view",
                children: [
                    {
                        div: {
                            className: "view-head",
                            children: [
                                { h1: () => api.getState(`${defPath}.label`, object) },
                                () => ({ LiveBadge: { key: `lb${arrived() ? gen() : was()}`, path: shownOf(1) } }),
                                { p: { className: "muted view-about", textContent: () => api.getState(`${defPath}.description`, "") } },
                            ],
                        },
                    },
                    // The list's own bar, under what it is: find first (where the eye starts), what it shows, then
                    // what can be done with it, the new record last and most visible.
                    {
                        div: {
                            className: "list-bar",
                            children: [
                                { input: { type: "search", className: "filter", placeholder: () => { const n = nounOf(api.getState(`${defPath}.label`, object) ?? object); return `Find ${/^[aeiou]/i.test(n) ? "an" : "a"} ${n}…`; }, "aria-label": "Find in this list", value: () => query(), oninput: (e) => typed(e.target.value) } },
                                { label: { className: "muted small", children: [{ input: { type: "checkbox", checked: () => showArchived(), onchange: (e) => setShowArchived(e.target.checked) } }, { span: " Show archived" }] } },
                                { span: { className: "spacer" } },
                                { Link: { to: `/o/${object}/analytics`, className: "btn ghost", textContent: "Analytics" } },
                                // Excel (§24): this model and the records it refers to, as the file's own download.
                                { a: { href: `/transfer/export.xlsx?objects=${object}&related=1`, download: "", className: "btn ghost", textContent: "Export" } },
                                () => (api.getState(`${shownOf(1)}.canCreate`, false) ? { Link: { to: `/o/${object}/new`, className: "btn primary", textContent: "New" } } : { span: {} }),
                            ],
                        },
                    },
                    // The table: its head, then each page loaded so far.
                    () => {
                        const def = api.getState(defPath);
                        if (!def) return { p: { className: "muted", textContent: "Loading…" } };
                        // Search first: say plainly that the list waits for a search, and what to type (an empty page reads as "none").
                        if (searchFirst(def)) {
                            const noun = nounOf(def.label ?? object);
                            return { div: { className: "search-first", role: "status", children: [
                                icon("info"),
                                { div: { children: [
                                    { strong: `Search to see ${noun} records.` },
                                    { p: `Type in Filter, above, any part of a value in its columns${(def.list?.columns ?? []).length ? ` (${def.list.columns.map((c) => def.fields?.[c]?.label ?? c).join(", ")})` : ""}. This list waits for a search, so that it stays quick when there are thousands of them.` },
                                ] } },
                            ] } };
                        }
                        const plain = isList(def);
                        const columns = def.list.columns;
                        const g = gen();
                        return {
                            table: {
                                className: "grid",
                                children: [
                                    { thead: { children: [{ tr: { children: [...columns.map((c) => sortHead(def, c, def.fields[c]?.label ?? c)), ...(plain ? [] : [sortHead(def, "state", "State")])] } }] } },
                                    ...Array.from({ length: loaded() }, (_, k) => ({ ListPage: { key: `g${g}p${k + 1}`, object, defPath, page: k + 1, q: asked(), sort: sortBy(), pathOf: (j) => `d.${object}.list.g${g}.p${j}`, stand: k === 0 && g > 0 ? prevOf : null } })),
                                ],
                            },
                        };
                    },
                    // How many, and more as the bottom comes into view.
                    () => {
                        if (searchFirst(api.getState(defPath))) return { span: {} };
                        // Until the new answer arrives, the count of what is on screen (the one it replaces).
                        const at = arrived() ? pathOf : prevOf;
                        const last = at(loaded());
                        const more = api.getState(`${last}.more`, false);
                        const total = api.getState(`${at(1)}.total`, null);
                        const shown = Array.from({ length: loaded() }, (_, k) => (api.getState(`${at(k + 1)}.rows.length`, 0) ?? 0)).reduce((a, b) => a + b, 0);
                        const capped = api.getState(`${at(1)}.capped`, false);
                        const text = `${total !== null && total !== undefined ? `${shown} of ${total}` : `${shown}${more ? "+" : ""}`} ${(arrived() ? asked() : wasAsked()) ? `matching “${arrived() ? asked() : wasAsked()}”` : "records"}${capped && !more ? " (the 5 000 changed last: filter to find older ones)" : ""}`;
                        return {
                            div: { className: "pager", children: [
                                { span: { className: "muted small", textContent: text } },
                                more ? { AutoMore: { key: `more-${gen()}-${loaded()}`, id: `more-${object}`, label: "Load more", onMore: () => setLoaded(loaded() + 1) } } : { span: {} },
                            ] },
                        };
                    },
                    // Archived records: a list of their own, loaded only when asked for.
                    () => (showArchived() ? { ArchivedList: { key: "archived", object, defPath, query } } : { span: {} }),
                ],
            },
        };
    });

    // One page of an object's list (records.list with `page`): its rows, as a part of the table. A
    // row that moved up to an earlier page since (it changed) is shown there, not twice.
    // `stand` (page 1 of a new filter or order): where the answer it replaces is, shown dimmed until its own arrives.
    // Fine-grained (§10.1): each record of the answer is kept under its own id (`d.rec.<object>.<id>`), written
    // leaf by leaf (assign: only what differs is written, so only its readers wake); the page draws its
    // records' ids, in order, and redraws only when they change (a row moved, came or went: keyed, so moved,
    // not drawn again); each row reads its own record and each cell its one field. A value that changes
    // rewrites its cell alone, wherever the record moved in the list.
    juris.registerComponent("ListPage", ({ object, defPath, page, q, sort = null, pathOf, stand = null }, api) => {
        const as = api.getState("me.id", null, { track: false });
        const path = pathOf(page);
        api.live(path, "records.list", args.listPage(object, as, page, q, sort));
        // The ids in order, beside the answer, not in it: the live layer writes each answer over its path
        // whole (assign deletes what the answer does not have).
        const orderOf = (p) => p.replace(".list.", ".listOrder.");
        const take = () => {
            const rows = api.peek(`${path}.rows`);
            if (!Array.isArray(rows)) return;
            api.batch(() => {
                for (const r of rows) api.assign(recordPath(object, r.id), r);
                api.assign(orderOf(path), rows.map((r) => r.id).join(","));
            });
        };
        take();
        if (!api.isServer) api.onCleanup(api.bindState(() => api.getState(`${path}.stamp`), take));
        return {
            tbody: {
                className: () => (stand && api.getState(orderOf(path), null) === null ? "refreshing" : ""),
                children: () => {
                    // A row moving between pages is shown once, on the page it is on now.
                    const own = api.getState(orderOf(path), null);
                    const order = own ?? (stand ? api.getState(orderOf(stand(1)), null) : null);
                    for (let j = 1; j < page; j++) api.getState(orderOf(pathOf(j)));
                    const def = api.peek(defPath);
                    if (!def || order === null) return page === 1 ? [{ tr: { key: "loading", children: [{ td: { className: "muted", textContent: "Loading…" } }] } }] : [];
                    const earlier = new Set();
                    for (let j = 1; j < page; j++) for (const id of String(api.peek(orderOf(pathOf(j))) ?? "").split(",")) if (id) earlier.add(id);
                    const mine = order.split(",").filter((id) => id && !earlier.has(id));
                    if (page === 1 && !mine.length) return [{ tr: { key: "none", children: [{ td: { colSpan: def.list.columns.length + (isList(def) ? 0 : 1), className: "muted", textContent: q ? `Nothing matches “${q}”.` : "No records you can see." } }] } }];
                    return mine.map((id) => ({ ListRow: { key: id, object, defPath, id } }));
                },
            },
        };
    });

    // One row of an object's list, reading its own record (ListPage): each cell its field, the state badge
    // the state, so a change rewrites only what changed.
    juris.registerComponent("ListRow", ({ object, defPath, id }, api) => {
        const rec = recordPath(object, id);
        const def = api.peek(defPath);
        const columns = def?.list?.columns ?? [];
        const cell = (c, first) => ({ td: { children: () => {
            const value = api.getState(`${rec}.${c}`);
            if (def.fields?.[c]?.type === "ref") api.getState(`${rec}.$titles.${c}`);
            const row = api.peek(rec) ?? {};
            if (isHidden(value)) return [{ SensitiveValue: { object, id, field: c, label: def.fields?.[c]?.label ?? c, type: def.fields?.[c]?.type ?? "string" } }];
            return [first ? { Link: { to: `/o/${object}/${id}`, textContent: display(def, row, c) } } : { span: { textContent: display(def, row, c) } }];
        } } });
        return {
            tr: {
                className: "row",
                onclick: () => api.navigate(`/o/${object}/${id}`),
                children: [
                    ...columns.map((c, i) => cell(c, i === 0)),
                    ...(isList(def) ? [] : [{ td: { children: [{ span: {
                        className: () => stateBadgeClass(api.getState(`${rec}.state`, ""), def.states?.tones),
                        textContent: () => String(api.getState(`${rec}.state`, "")).replace(/_/g, " "),
                    } }] } }]),
                ],
            },
        };
    });

    // Asks for more when it scrolls into view (and is a button for whoever prefers to press it).
    juris.registerComponent("AutoMore", ({ id, label = "Load more", onMore }, api) => {
        if (!api.isServer) {
            api.onMount(() => {
                const el = globalThis.document?.getElementById(id);
                if (!el || !globalThis.IntersectionObserver) return undefined;
                let asked = false;
                const io = new IntersectionObserver((entries) => { if (!asked && entries.some((e) => e.isIntersecting)) { asked = true; onMore(); } }, { rootMargin: "200px" });
                io.observe(el);
                return () => io.disconnect();
            });
        }
        return { button: { id, type: "button", className: "btn ghost auto-more", textContent: label, onclick: () => onMore() } };
    });

    juris.registerComponent("ArchivedList", ({ object, defPath, query }, api) => {
        const as = api.getState("me.id", null, { track: false });
        const path = `d.${object}.archived`;
        api.live(path, "records.list", args.list(object, as, true));
        return {
            div: {
                className: "archived",
                children: [
                    { h3: "Archived" },
                    () => {
                        api.getState(`${path}.stamp`);
                        return grid(api, object, api.getState(defPath), api.peek(`${path}.rows`) ?? [], query(), "No archived records you can see.");
                    },
                ],
            },
        };
    });

    // ---- one record ----
    juris.registerComponent("RecordForm", ({ object, id }, api) => {
        const as = api.getState("me.id", null, { track: false });
        const defPath = `d.${object}.def`;
        const recPath = `d.${object}.rec.${id}`;
        const f = `f.${object}.${id}`;
        api.live(defPath, "defs.get", args.def(object, as));
        api.live(recPath, "records.get", args.record(object, id, as));

        // The edit buffer follows the record while nothing is being edited (a live change from someone
        // else arrives here); once edited, it is the user's until they save or discard.
        // Juris wakes a reader only for the path it read, never for a leaf below it, so this follows
        // the record's row_version (every write moves it) and the definition's version.
        const stop = api.bindState(
            () => [api.getState(`${recPath}.row_version`), api.getState(`${defPath}.version`)],
            () => {
                const rec = api.peek(recPath);
                const def = api.peek(defPath);
                if (!rec || !def) return;
                // A sensitive value shown here (§6.10) is hidden again once the record moves on: it may
                // have changed, and the page keeps nothing it was not asked for.
                if (!api.peek(`${f}.dirty`)) api.batch(() => { api.deleteState(`${f}.shown`); api.setValue(`${f}.data`, pickData(def, rec)); rehide(api, f); });
                titleTab(api, `/o/${object}/${id}`, rec.$title ?? def.label);
            },
        );
        api.onCleanup(stop);
        // Leaving the page: what was shown of its sensitive fields goes with it (a form left with unsaved
        // changes keeps them, as it keeps every edit).
        api.onCleanup(() => {
            if (api.peek(`${f}.dirty`)) return;
            api.deleteState(`${f}.shown`);
            const def = api.peek(defPath);
            const rec = api.peek(recPath);
            if (def && rec) api.batch(() => { api.setValue(`${f}.data`, pickData(def, rec)); rehide(api, f); });
        });

        const form = formController(api, { object, f, defPath, record: () => api.peek(recPath) });

        // Presence: say this record is open here (and whether it is being edited), every 15 s and
        // whenever editing starts or stops; the banner shows everyone else who has it open.
        api.live(`pres.${object}.${id}`, "presence.get", args.presence(object, id, as));
        if (!api.isServer) {
            const say = () => api.call("presence.join", { object, id, editing: Boolean(api.peek(`${f}.dirty`)) }).catch(() => {});
            api.onMount(() => {
                say();
                const beat = setInterval(say, 15_000);
                const stopEditing = api.bindState(() => Boolean(api.getState(`${f}.dirty`, false)), () => say());
                const bye = () => { navigator.sendBeacon?.("/api/presence.leave", new Blob([JSON.stringify([{ object, id }])], { type: "application/json" })); };
                window.addEventListener("pagehide", bye);
                return () => {
                    clearInterval(beat);
                    stopEditing();
                    window.removeEventListener("pagehide", bye);
                    api.call("presence.leave", { object, id }).catch(() => {});
                };
            });
        }

        const save = async () => {
            const rec = api.peek(recPath);
            const def = api.peek(defPath);
            const data = api.peek(`${f}.data`) ?? {};
            // Against what was read (a sensitive value as shown); a marker is never sent back as a value.
            const changed = Object.fromEntries(Object.keys(def.fields).filter((n) => !isHidden(data[n]) && JSON.stringify(data[n]) !== JSON.stringify(baseOf(api, f, rec, n))).map((n) => [n, data[n] ?? null]));
            // A change its object's design says waits for approval (§28): summed up on the form (Changes
            // to submit for approval), with why, and submitted from there.
            const waits = needsApproval(def, { op: "edit", state: rec.state, changed: Object.keys(changed) });
            const reason = waits ? String(api.peek(`${f}.reason`) ?? "").trim() : "";
            if (waits && !reason) return api.setValue(`${f}.serverErrors`, { _form: "Say why, in the summary of changes, before submitting them for approval." });
            await form.submit((key) => api.call("records.update", { object, id, rowVersion: rec.row_version, data: changed, key, ...(reason ? { reason } : {}) }), (saved) => {
                api.batch(() => {
                    api.setValue(`${f}.dirty`, false);
                    api.setValue(`${f}.reason`, "");
                    // Waiting: the form shows the record as it is; the banner, what waits.
                    api.setValue(`${f}.data`, pickData(def, saved.$request ? api.peek(recPath) : saved));
                    api.deleteState(`${f}.shown`);
                    rehide(api, f);
                    api.setValue(`${f}.notice`, saved.$request ? sentWords(saved.$request) : "Saved.");
                });
            });
        };
        const discard = () => api.batch(() => {
            api.deleteState(`${f}.shown`);
            api.setValue(`${f}.dirty`, false);
            api.setValue(`${f}.reason`, "");
            api.setValue(`${f}.data`, pickData(api.peek(defPath), api.peek(recPath)));
            rehide(api, f);
            api.setValue(`${f}.ruleErrors`, {});
            api.setValue(`${f}.serverErrors`, {});
            api.setValue(`${f}.notice`, null);
        });
        const act = async (action) => {
            if (api.peek(`${f}.dirty`)) return api.setValue(`${f}.serverErrors`, { _form: "Save or discard your changes first." });
            const clean = await form.check({ kind: "action", action });
            if (!clean) return;
            const rec = api.peek(recPath);
            const def = api.peek(defPath);
            const label = def.states.transitions.find((t) => t.action === action)?.label ?? action;
            const reason = await reasonFor(api, def, { op: "action", state: rec.state, action, now: rec }, label);
            if (reason === null) return;
            await form.submit((key) => api.call("records.action", { object, id, action, rowVersion: rec.row_version, key, ...(reason ? { reason } : {}) }), (done) => api.setValue(`${f}.notice`, done?.$request ? sentWords(done.$request) : `Done: ${action}.`));
        };

        // Archive or restore: the pipe runs here first (advice, event.kind "archive" or "restore"),
        // then the server runs it again and decides.
        const archive = async (restore) => {
            if (api.peek(`${f}.dirty`)) return api.setValue(`${f}.serverErrors`, { _form: "Save or discard your changes first." });
            const kind = restore ? "restore" : "archive";
            const clean = await form.check({ kind });
            if (!clean) return;
            const rec = api.peek(recPath);
            const def = api.peek(defPath);
            // Waiting for approval (§28: the design may say archiving and restoring wait), asked why instead.
            const waits = needsApproval(def, { op: kind, state: rec.state });
            if (!waits && !restore && !(await confirmDialog(api, { title: `Archive ${rec?.$title ?? "this record"}?`, message: "It leaves the lists and becomes read-only until it is restored. Nothing is deleted.", confirm: "Archive", danger: true }))) return;
            const reason = waits ? await reasonFor(api, def, { op: kind, state: rec.state, now: rec }, restore ? "Restoring it" : "Archiving it (it leaves the lists and becomes read-only; nothing is deleted)") : "";
            if (reason === null) return;
            await form.submit((key) => api.call(`records.${kind}`, { object, id, rowVersion: rec.row_version, key, ...(reason ? { reason } : {}) }), (done) => api.setValue(`${f}.notice`, done?.$request ? sentWords(done.$request) : restore ? "Restored." : "Archived."));
        };

        const tab = () => api.getState(`${f}.tab`, "details");
        const setTab = (name) => () => api.setValue(`${f}.tab`, name);
        const why = (target) => {
            api.setValue(`${f}.whyTarget`, target);
            api.setValue(`${f}.tab`, "why");
        };

        return {
            div: {
                className: "view record",
                children: [
                    () => {
                        api.getState(`${recPath}.row_version`);
                        const rec = api.getState(recPath);
                        const def = api.getState(defPath);
                        if (rec === null) return { div: { children: [{ h1: "Not found" }, { p: { className: "muted", textContent: "This record does not exist, or it is not shared with you." } }] } };
                        if (!rec || !def) return { p: { className: "muted", textContent: "Loading…" } };
                        return {
                            div: {
                                className: "record-head",
                                children: [
                                    { div: { className: "title", children: [{ GuideToggle: { key: `guide-${object}`, title: `${def.label}: this record`, make: () => formGuide(api.peek(defPath), { intro: `A ${nounOf(def.label)} record: what it is now, what you may do with it, and each of its fields.`, lead: recordLead() }) } }, { span: { className: "kind", textContent: def.label } }, { h1: () => api.getState(`${recPath}.$title`, "") }, isList(def) ? { span: {} } : { span: { className: () => stateBadgeClass(api.getState(`${recPath}.state`), def.states?.tones), textContent: () => String(api.getState(`${recPath}.state`, "")).replace(/_/g, " ") } }] } },
                                    { LiveBadge: { path: recPath } },
                                    { ActionBar: { object, defPath, recPath, onAction: act, onArchive: archive, onWhy: (target) => why(target), blocked: form.held } },
                                ],
                            },
                        };
                    },
                    { Presence: { path: `pres.${object}.${id}` } },
                    { FlowPosition: { object, id } },
                    { RecordPlans: { object, id } },
                    { RequestBanner: { object, id } },
                    () => {
                        const at = api.getState(`${recPath}.archived_at`, null);
                        if (!at) return { span: {} };
                        const by = api.getState(`${recPath}.archived_by`, null);
                        return { div: { className: "presence archived-note", role: "status", children: [icon("archive"), { span: `Archived ${plant().dateTime(at)}${by ? ` by ${by}` : ""}. It is read-only until it is restored.` }] } };
                    },
                    {
                        nav: {
                            className: "subtabs",
                            children: ["details", "timeline", "history", "why"].map((name) => ({
                                button: { type: "button", className: "subtab", classList: { active: () => tab() === name }, onclick: setTab(name), textContent: { details: "Details", timeline: "Timeline", history: "History", why: "Why?" }[name] },
                            })),
                        },
                    },
                    () => {
                        const which = tab();
                        if (which === "history") return { HistoryPanel: { key: "history", object, id } };
                        if (which === "timeline") return { RecordTimeline: { key: "timeline", object, id } };
                        if (which === "why") return { WhyPanel: { key: "why", object, id, f, defPath, recPath } };
                        return {
                            div: {
                                key: "details",
                                children: [
                                    { FormBody: { f, defPath, permPath: `${recPath}.$perm`, onChange: form.change, onCommit: form.commit, onWhy: (field) => why({ field }), approvalState: () => api.getState(`${recPath}.state`, null) } },
                                    { ChangeSummary: { f, defPath, recPath, object, id } },
                                    {
                                        div: {
                                            className: "form-foot",
                                            children: [
                                                () => {
                                                    // Controlled (§28): what it sends waits for approval, so it says so.
                                                    api.getState(`${recPath}.row_version`);
                                                    const p = pendingOf(api, f, api.getState(defPath, null), api.peek(recPath));
                                                    const reasonGiven = () => String(api.getState(`${f}.reason`, "") ?? "").trim().length > 0;
                                                    const waiting = () => Boolean(api.getState(`rq.rec.${object}.${id}`, null));
                                                    return { button: { type: "button", className: "btn primary", textContent: () => (api.getState(`${f}.saving`, false) ? (p.waits ? "Submitting…" : "Saving…") : p.waits ? "Submit for approval" : "Save"), disabled: () => !api.getState(`${f}.dirty`, false) || api.getState(`${f}.saving`, false) || form.blocked() || (p.waits && (!reasonGiven() || waiting())), onclick: save } };
                                                },
                                                { button: { type: "button", className: "btn ghost", textContent: "Discard", disabled: () => !api.getState(`${f}.dirty`, false) || form.unknown(), onclick: discard } },
                                                { SendAgain: { f, form } },
                                                { span: { className: "notice", textContent: () => api.getState(`${f}.notice`, "") ?? "" } },
                                            ],
                                        },
                                    },
                                ],
                            },
                        };
                    },
                ],
            },
        };
    });

    // Whether what a live path shows is current (Juris api.liveState): nothing when it is; otherwise
    // a plain warning, so data that stopped following the server never passes for the latest.
    juris.registerComponent("LiveBadge", ({ path }, api) => () => {
        const state = api.liveState(path);
        if (!state || state === "live") return { span: {} };
        const text = {
            pending: "Updating…",
            offline: "Offline: what you see may be out of date.",
            failed: `Not current: ${api.liveMessage(path) ?? "the latest could not be loaded"}.`,
        }[state] ?? state;
        return { span: { className: `live-badge icon-text ${state}`, role: "status", children: [state === "pending" ? { span: {} } : icon("warning"), { span: text }] } };
    });

    // Others with this record open: a warning, stronger when one of them is editing it.
    juris.registerComponent("Presence", ({ path, noun = "record" }, api) => () => {
        // Read leaf by leaf: someone starting to edit changes one leaf, which wakes only its readers.
        const count = api.getState(`${path}.length`, 0) ?? 0;
        const others = Array.from({ length: count }, (_, i) => ({ name: api.getState(`${path}.${i}.name`), editing: api.getState(`${path}.${i}.editing`, false) }));
        if (!others.length) return { span: {} };
        const editing = others.filter((o) => o.editing);
        const names = (list) => list.map((o) => o.name).join(", ");
        const textFor = editing.length
            ? `${names(editing)} ${editing.length > 1 ? "are" : "is"} editing this ${noun} now. If you both save, the second save is refused and must be redone.${others.length > editing.length ? ` Also viewing: ${names(others.filter((o) => !o.editing))}.` : ""}`
            : `${names(others)} ${others.length > 1 ? "are" : "is"} also viewing this ${noun}.`;
        return { div: { className: "presence", classList: { editing: editing.length > 0 }, role: "status", children: [icon(editing.length ? "pencil" : "users"), { span: textFor }] } };
    });

    // ---- a new record ----
    juris.registerComponent("RecordNew", ({ object }, api) => {
        const as = api.getState("me.id", null, { track: false });
        const defPath = `d.${object}.def`;
        const listPath = `d.${object}.list`;
        const f = `f.${object}.new`;
        api.live(defPath, "defs.get", args.def(object, as));
        api.live(listPath, "records.list", args.list(object, as));
        if (!api.isServer) {
            const stop = api.bindState(() => api.getState(`${defPath}.label`), (label) => label && titleTab(api, `/o/${object}/new`, `New ${nounOf(label)}`));
            api.onCleanup(stop);
        }
        const form = formController(api, { object, f, defPath, record: () => ({}) });
        const create = async () => {
            const data = Object.fromEntries(Object.entries(api.peek(`${f}.data`) ?? {}).filter(([, v]) => v !== null && v !== ""));
            const waits = needsApproval(api.peek(defPath), { op: "create" });
            const reason = waits ? String(api.peek(`${f}.reason`) ?? "").trim() : "";
            if (waits && !reason) return api.setValue(`${f}.serverErrors`, { _form: "Say why, in the summary below, before submitting it for approval." });
            await form.submit((key) => api.call("records.create", { object, data, key, ...(reason ? { reason } : {}) }), (created) => {
                api.batch(() => {
                    api.setValue(`${f}.dirty`, false);
                    api.setValue(`${f}.data`, {});
                });
                // Waiting (§28): it exists once approved; its request's page shows how far it is.
                if (created.$request) {
                    retab(api, `/o/${object}/new`, `/request/${created.$request.id}`, "Change request");
                    api.navigate(`/request/${created.$request.id}`, { replace: true });
                    return;
                }
                const path = `/o/${object}/${created.id}`;
                retab(api, `/o/${object}/new`, path, created[api.peek(defPath)?.titleField] ?? "New");
                api.navigate(path, { replace: true });
            });
        };
        return {
            div: {
                className: "view record",
                children: [
                    { div: { className: "record-head", children: [{ div: { className: "title", children: [{ span: { className: "kind", textContent: () => api.getState(`${defPath}.label`, "") } }, { h1: "New" }] } }] } },
                    () => (api.getState(`${listPath}.canCreate`, true) ? { span: {} } : { p: { className: "error", textContent: "You cannot create these." } }),
                    { FormBody: { f, defPath, permPath: `${listPath}.createPerm`, onChange: form.change, onCommit: form.commit, onWhy: null } },
                    { ChangeSummary: { f, defPath, recPath: null, object } },
                    {
                        div: {
                            className: "form-foot",
                            children: [
                                () => {
                                    const waits = needsApproval(api.getState(defPath, null), { op: "create" });
                                    const reasonGiven = () => String(api.getState(`${f}.reason`, "") ?? "").trim().length > 0;
                                    return { button: { type: "button", className: "btn primary", textContent: () => (api.getState(`${f}.saving`, false) ? (waits ? "Submitting…" : "Creating…") : waits ? "Submit for approval" : "Create"), disabled: () => api.getState(`${f}.saving`, false) || form.blocked() || (waits && !reasonGiven()), onclick: create } };
                                },
                                { SendAgain: { f, form } },
                                { span: { className: "notice", textContent: () => api.getState(`${f}.notice`, "") ?? "" } },
                            ],
                        },
                    },
                ],
            },
        };
    });

    // ---- the fields, drawn from the definition's layout (form-layout.js); values bound one by one ----
    // Tabs, sections (collapsible if the designer says), a 12-column grid, each field drawn with its
    // widget. `show` and `enable` are re-evaluated as the data they read changes; a field a policy
    // locks stays locked whatever `enable` says. `preview` draws it for the designer, inputs disabled.
    // Controlled records (§28): on the form, everything it would submit for approval, as the person edits
    // (each field: as it is → as edited; a new record: what is filled in), who approves it, and why.
    // The form's button submits it once they are sure; nothing changes until it is approved.
    juris.registerComponent("ChangeSummary", ({ f, defPath, recPath = null, object, id = null }, api) => {
        const as = api.getState("me.id", null, { track: false });
        // A reference's title, fetched once per record named (the form holds only its id).
        const titleOf = (to, rid) => {
            if (typeof rid !== "string") return null;
            const known = api.getState(`${f}.refTitles.${rid}`, undefined);
            if (known === undefined && !api.isServer) {
                api.setValue(`${f}.refTitles.${rid}`, null);
                api.call("records.get", { object: to, id: rid, as }).then((r) => api.setValue(`${f}.refTitles.${rid}`, r?.$title ?? "(not visible to you)"), () => api.setValue(`${f}.refTitles.${rid}`, "(not visible to you)"));
            }
            return known ?? "…";
        };
        const shown = (field, v, rec) => {
            if (v === undefined || v === null || v === "") return "—";
            if (isHidden(v)) return HIDDEN_WORDS;
            if (field.type === "ref") return rec && rec[field.name] === v && rec.$titles?.[field.name] ? rec.$titles[field.name] : titleOf(field.to, v);
            if (Array.isArray(v)) return v.join(", ") || "—";
            if (field.type === "boolean") return v ? "yes" : "no";
            if (field.type === "decimal" || field.type === "integer") return plant().number(v);
            if (field.type === "date") return plant().date(v);
            return String(v);
        };
        return () => {
            const def = api.getState(defPath, null);
            if (recPath) api.getState(`${recPath}.row_version`);
            const rec = recPath ? api.peek(recPath) : null;
            if (!def?.approval || (recPath && !rec)) return { span: {} };
            const p = pendingOf(api, f, def, rec);
            if (!p.waits) return { span: {} };
            const route = recordRoute(def, p.spec).map((r) => r.department);
            const controlled = (n) => (rec ? needsApproval(def, { op: "edit", state: rec.state, changed: [n] }) : true);
            const waiting = id ? api.getState(`rq.rec.${object}.${id}`, null) : null;
            const rows = p.changed.map((n) => {
                const field = { ...def.fields[n], name: n };
                const after = api.getState(`${f}.data.${n}`, null);
                return {
                    tr: {
                        key: n,
                        children: [
                            { td: { className: "cs-field", textContent: field.label ?? n } },
                            ...(rec ? [{ td: { className: "muted", textContent: shown(field, baseOf(api, f, rec, n), rec) } }, { td: { className: "muted", children: [icon("arrowRight")] } }] : []),
                            { td: { className: "cs-after", textContent: shown(field, after, null) } },
                            rec ? { td: { children: [{ span: { className: controlled(n) ? "approval-tag" : "muted small", textContent: controlled(n) ? "needs approval" : "goes with it" } }] } } : { td: {} },
                        ],
                    },
                };
            });
            return {
                section: {
                    className: "change-summary", "aria-label": "Changes to submit for approval",
                    children: [
                        { div: { className: "cs-head", children: [{ strong: rec ? `Changes to submit for approval (${p.changed.length})` : `A new ${nounOf(def.label)} to submit for approval` }, { span: { className: "muted small", textContent: ` · approved by ${route.join(", ") || "its stewards"}` } }] } },
                        { p: { className: "muted small", textContent: rec ? "Nothing changes until they approve. Check each change; the ones marked “goes with it” are sent with the others and decided together." : "It is created once they approve." } },
                        { table: { className: "cs-table", children: [{ tbody: { children: rows } }] } },
                        waiting ? { p: { className: "error small", textContent: "A change to this record already waits for approval (above): it is decided or withdrawn before another is submitted." } } : { span: {} },
                        {
                            label: {
                                className: "cs-why",
                                children: [
                                    { span: "Why *" },
                                    { textarea: { rows: 2, placeholder: rec ? "What these changes are for (the approvers read it)" : `What this ${nounOf(def.label)} is for (the approvers read it)`, value: () => api.getState(`${f}.reason`, "") ?? "", oninput: (e) => api.setValue(`${f}.reason`, e.target.value), disabled: () => api.getState(`${f}.saving`, false) } },
                                ],
                            },
                        },
                    ],
                },
            };
        };
    });

    juris.registerComponent("FormBody", ({ f, defPath, permPath, onChange, onCommit, onWhy, preview = false, approvalState = null }, api) => () => {
        const def = api.getState(defPath);
        if (!def) return { p: { className: "muted", textContent: "Loading…" } };
        const form = normalizeForm(def);
        const errorFor = (name) => {
            const server = api.getState(`${f}.serverErrors.${name}`, null);
            if (server) return server;
            const rules = api.getState(`${f}.ruleErrors`, {});
            return Object.values(rules).find((e) => e.field === name)?.message ?? null;
        };
        const level = (name) => (permPath ? api.getState(`${permPath}.fields.${name}`, null) : "w");
        const reason = (name) => api.getState(`${permPath}.why.${name}`, "role");
        const value = (name) => api.getState(`${f}.data.${name}`, null);
        // A condition over the form, reading (and so following) only the leaves it names.
        const holds = (expr, otherwise = true) => {
            if (expr === undefined) return otherwise;
            const data = {};
            const record = {};
            for (const ref of referencesOf(expr)) {
                const top = String(ref.path).split(".")[0];
                if (ref.scope === "data") data[top] = api.getState(`${f}.data.${top}`, null);
                if (ref.scope === "record") record[top] = api.getState(`${f}.data.${top}`, null) ?? (permPath ? api.getState(`${permPath.replace(/\.\$perm$/, "")}.${top}`, null) : null);
            }
            return evaluate(expr, { data, record: { ...data, ...record }, user: { id: api.peek("me.id") } }) === true;
        };
        const tab = () => Math.min(api.getState(`${f}.formTab`, 0) ?? 0, form.tabs.length - 1);
        const fieldView = (entry) => {
            const name = entry.field;
            const field = def.fields[name];
            const id = `${f}.${name}`.replace(/[^a-zA-Z0-9_-]/g, "-");
            return () => {
                if (!holds(entry.show)) return { span: { key: name } };
                const writable = level(name) === "w" && holds(entry.enable) && !preview;
                const disabled = () => !writable || api.getState(`${f}.saving`, false) || api.getState(`${f}.unknown`, false);
                const required = field.required || holds(field.requiredWhen, false);
                return {
                    div: {
                        key: name,
                        className: `field w-${entry.width}`,
                        // What a form's guide points at (§33).
                        "data-guide": `field:${name}`,
                        classList: { locked: () => level(name) !== "w", invalid: () => Boolean(errorFor(name)) },
                        children: [
                            {
                                label: {
                                    htmlFor: id,
                                    children: [
                                        { span: `${field.label}${required ? " *" : ""}` },
                                        // A field whose changes wait for approval here (§28): said before it is edited.
                                        () => (approvalState && !preview && writable && needsApproval(def, { op: "edit", state: approvalState(), changed: [name] })
                                            ? { span: { className: "approval-tag", title: `A change to ${field.label} waits for approval by ${recordRoute(def, { op: "edit", state: approvalState(), changed: [name], now: permPath ? api.peek(String(permPath).replace(/\.\$perm$/, "")) ?? null : null }).map((r) => r.department).join(", ")}`, textContent: "needs approval" } }
                                            : { span: {} }),
                                    ],
                                },
                            },
                            // A sensitive field (§6.10): hidden until shown (records.reveal), then its control.
                            () => {
                                api.getState(`${f}.shownAt`, 0);
                                const rec = permPath ? api.peek(permPath.replace(/\.\$perm$/, "")) : null;
                                if (!isHidden(api.peek(`${f}.data.${name}`)) || !rec?.id) return control(api, { id, f, name, field, entry, disabled, value, onChange, onCommit, record: rec?.id ? { object: def.object, id: rec.id, value: rec[name] ?? null } : null, form: { object: def.object, transaction: def.transaction ?? null } });
                                return { SensitiveValue: { key: `sv-${name}`, object: def.object, id: rec.id, field: name, label: field.label ?? name, type: field.type, onShown: (v) => api.batch(() => {
                                    api.setValue(`${f}.shown.${name}`, v ?? null);
                                    api.setValue(`${f}.data.${name}`, v ?? null);
                                    rehide(api, f);
                                }) } };
                            },
                            entry.help ? { div: { className: "field-help", textContent: entry.help } } : { span: {} },
                            () => (level(name) !== "w" && !preview
                                ? { div: { className: "lock", children: [
                                    { span: { className: "icon-text", children: [icon("lock"), { span: `${level(name) ? "read only" : "hidden"}: ${reason(name) === "derived" && field.derived ? derivedWords(def, field.derived) : REASONS[reason(name)] ?? reason(name)}` }] } },
                                    onWhy ? { button: { type: "button", className: "linkish", textContent: "Why?", onclick: () => onWhy(name) } } : { span: {} },
                                ] } }
                                : { span: {} }),
                            { div: { className: "field-error", textContent: () => errorFor(name) ?? "" } },
                        ],
                    },
                };
            };
        };
        const sectionView = (section, i) => {
            const grid = { div: { className: "grid12", children: section.fields.map(fieldView) } };
            return section.collapsible
                ? { details: { key: `${i}-${section.label}`, className: "section", open: !section.collapsed, children: [{ summary: section.label }, grid] } }
                : { fieldset: { key: `${i}-${section.label}`, className: "section", children: [{ legend: section.label }, grid] } };
        };
        // A tab whose fields hold an error says so, so an error on another tab is not missed.
        const tabHasError = (t) => t.sections.some((s) => s.fields.some((e) => errorFor(e.field)));
        return {
            div: {
                className: "form",
                children: [
                    { p: { className: "error form-error", hidden: () => !errorFor("_form"), textContent: () => errorFor("_form") ?? "" } },
                    form.tabs.length > 1 ? {
                        nav: {
                            className: "form-tabs",
                            children: form.tabs.map((t, k) => ({
                                button: { key: k, type: "button", className: "form-tab", classList: { active: () => tab() === k, "has-error": () => tabHasError(t) }, textContent: t.label, onclick: () => api.setValue(`${f}.formTab`, k) },
                            })),
                        },
                    } : { span: {} },
                    () => ({ div: { key: `tab-${tab()}`, children: form.tabs[tab()].sections.map(sectionView) } }),
                ],
            },
        };
    });

    // A reference by searching (§10.4): type some letters of the record's title (its lot number, a tool's
    // id) and pick among the matches. Nothing is asked of the server until `minChars` letters are typed
    // (the field's layout says how many; 2 if it does not), and then only the matches, at most 20, as the
    // person may see them (records.pick): a plant's thousands of lots are never sent to fill a list.
    juris.registerComponent("RefSearch", ({ id, f, name, to, noun = null, disabled, placeholder, minChars = 2, source = null, onPick }, api) => {
        // From a query (§23.1): its choices, listed at once (a query's are few), narrowed as typed.
        const least = source ? 0 : Number.isInteger(minChars) && minChars >= 1 && minChars <= 6 ? minChars : 2;
        const S = `${f}.pick.${name}`;
        const typed = () => api.getState(`${S}.typed`, null);
        const found = () => api.getState(`${S}.found`, null);
        const [title, setTitle] = api.useState("title", null);
        const as = api.getState("me.id", null, { track: false });
        const what = String(noun ?? to.replace(/_/g, " ")).toLowerCase();
        let timer = null;
        let asked = 0;
        if (!api.isServer) {
            // The current value's title, whoever set it (a pick, the record the screen was opened from).
            const stop = api.bindState(() => api.getState(`${f}.data.${name}`, null), (value) => {
                if (!value) { setTitle(null); return; }
                const hit = (found()?.rows ?? []).find((o) => o.id === value);
                if (hit) { setTitle(hit.title); return; }
                api.call("records.get", { object: to, id: value, as }).then((r) => setTitle(r?.$title ?? "(not visible to you)"), () => setTitle(null));
            });
            api.onCleanup(() => { stop(); clearTimeout(timer); });
        }
        const search = (text) => {
            api.batch(() => { api.setValue(`${S}.typed`, text); api.setValue(`${S}.open`, true); api.setValue(`${S}.at`, -1); });
            clearTimeout(timer);
            const q = text.trim();
            // A suggestion picked (it fills the whole title in): taken at once, nothing asked again.
            const exact = (found()?.rows ?? []).find((o) => o.title.toLowerCase() === q.toLowerCase());
            if (exact && q.length >= least) { commit(q); return; }
            if (q.length < least) { api.setValue(`${S}.found`, null); return; }
            const mine = ++asked;
            timer = setTimeout(() => {
                (source ? api.call("records.choices", { ...source, values: api.peek(`${f}.data`) ?? {}, q, as }) : api.call("records.pick", { object: to, q, as })).then((r) => { if (mine === asked) api.setValue(`${S}.found`, { q, ...r }); }, () => { if (mine === asked) api.setValue(`${S}.found`, { q, rows: [], more: false, failed: true }); });
            }, 220);
        };
        const commit = (text) => {
            const q = String(text ?? "").trim();
            if (!q) { api.batch(() => { api.setValue(`${S}.typed`, null); api.setValue(`${S}.found`, null); }); onPick(null); return; }
            const hit = (found()?.rows ?? []).find((o) => o.title.toLowerCase() === q.toLowerCase());
            if (hit) { api.batch(() => { api.setValue(`${S}.typed`, null); setTitle(hit.title); }); onPick(hit.id); }
        };
        const listId = `${id}-options`;
        // Its suggestions, drawn by the page under the field (not the browser's datalist, which some browsers, kiosks
        // and embedded ones among them, draw elsewhere on the screen): open while typing finds some; the arrows move,
        // Enter or a click picks, Escape closes.
        const open = () => api.getState(`${S}.open`, false);
        const at = () => api.getState(`${S}.at`, -1);
        const shown = () => {
            const t = typed();
            const r = found();
            if (!open() || t === null || !r?.rows?.length) return [];
            return r.rows.some((o) => o.title.toLowerCase() === t.trim().toLowerCase()) ? [] : r.rows;
        };
        const close = () => api.batch(() => { api.setValue(`${S}.open`, false); api.setValue(`${S}.at`, -1); });
        const pick = (o, el) => {
            api.batch(() => { api.setValue(`${S}.typed`, null); setTitle(o.title); });
            close();
            onPick(o.id);
            el?.dispatchEvent(new CustomEvent("mes-advance", { bubbles: true }));
        };
        const hint = () => {
            const t = typed();
            if (t === null) return "";
            const q = t.trim();
            if (!q) return "";
            if (q.length < least) return `Type ${least - q.length} more ${least - q.length === 1 ? "letter" : "letters"} to search.`;
            const r = found();
            if (!r || r.q !== q) return "Searching…";
            if (r.failed) return "The search did not answer: try again.";
            if (!r.rows.length) return `No ${what} "${q}" that you can see.`;
            if (r.rows.some((o) => o.title.toLowerCase() === q.toLowerCase())) return "";
            return `${r.rows.length}${r.more ? "+" : ""} found: pick one${r.more ? ", or type more to narrow them" : ""}.`;
        };
        return {
            span: {
                className: "ref-search",
                children: [
                    { input: { id, disabled, type: "search", role: "combobox", "aria-autocomplete": "list", "aria-controls": listId, "aria-expanded": () => String(shown().length > 0), "aria-activedescendant": () => (at() >= 0 && shown()[at()] ? `${listId}-${at()}` : ""), onblur: () => setTimeout(close, 150), placeholder: placeholder ?? `Type ${least} or more letters to search…`, autocomplete: "off", value: () => typed() ?? title() ?? "", oninput: (e) => search(e.target.value), onchange: (e) => commit(e.target.value),
                        // A label or an id typed and Enter (a scanner's, a badge's sign-in id): the record it names, by its title or
                        // the fields its design scans by (records.lookup), picked, and the form told to move on. Held until then; not
                        // found, it stays, the hint saying what was found. (Choices from a query are picked from its own rows.)
                        onkeydown: (e) => {
                            const list = shown();
                            if (list.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                                e.preventDefault();
                                api.setValue(`${S}.at`, (at() + (e.key === "ArrowDown" ? 1 : list.length - 1 + (at() < 0 ? 1 : 0))) % list.length);
                                return;
                            }
                            if (e.key === "Escape" && list.length) { e.preventDefault(); e.stopPropagation(); close(); return; }
                            if (e.key !== "Enter") return;
                            // One moved to with the arrows: that one.
                            if (list.length && at() >= 0 && list[at()]) { e.preventDefault(); e.stopPropagation(); pick(list[at()], e.target); return; }
                            const q = e.target.value.trim();
                            const rows = found()?.rows ?? [];
                            if (!q || q === title() || rows.some((o) => o.title.toLowerCase() === q.toLowerCase())) return;
                            const el = e.target;
                            // One suggestion beginning with what was scanned ("T-J750-01" for "T-J750-01 · Bay 1"): that one.
                            const starts = rows.filter((o) => o.title.toLowerCase().startsWith(q.toLowerCase()));
                            if (starts.length === 1) {
                                e.preventDefault();
                                e.stopPropagation();
                                api.batch(() => { api.setValue(`${S}.typed`, null); setTitle(starts[0].title); });
                                onPick(starts[0].id);
                                el.dispatchEvent(new CustomEvent("mes-advance", { bubbles: true }));
                                return;
                            }
                            if (source) return;
                            e.preventDefault();
                            e.stopPropagation();
                            api.call("records.lookup", { object: to, key: q }).then((hit) => {
                                if (!hit) return;
                                api.batch(() => { api.setValue(`${S}.typed`, null); setTitle(hit.title); });
                                onPick(hit.id);
                                el.dispatchEvent(new CustomEvent("mes-advance", { bubbles: true }));
                            }, () => {});
                        },
                        // From a query: its choices fetched as the field is entered, for the form as it is filled now.
                        onfocus: () => { if (source) api.call("records.choices", { ...source, values: api.peek(`${f}.data`) ?? {}, q: "", as }).then((r) => api.setValue(`${S}.found`, { q: "", ...r }), () => {}); } } },
                    () => {
                        const list = shown();
                        return list.length
                            ? { ul: { id: listId, className: "ref-options", role: "listbox", children: list.map((o, k) => ({ li: {
                                key: o.id, id: `${listId}-${k}`, role: "option", "aria-selected": () => String(at() === k), classList: { active: () => at() === k },
                                // Picked on the press, before the field loses the cursor (and the list with it).
                                onmousedown: (e) => { e.preventDefault(); pick(o, globalThis.document?.getElementById(id)); },
                                children: [{ span: { className: "ref-option-title", textContent: o.title } }, { span: { className: "muted small", textContent: String(o.state ?? "").replace(/_/g, " ") } }],
                            } })) } }
                            : { span: {} };
                    },
                    { div: { className: () => `small ${/^No |did not/.test(hint()) ? "field-error" : "muted"}`, hidden: () => !hint(), textContent: () => hint() } },
                ],
            },
        };
    });

    // A reference by its label, as a scanner types it and presses Enter ("4711", "M-101"): the record
    // whose title field reads that, if the user may see it. Typing works the same.
    // Where a record is on its route (§32.5): the route, the node, its way there; stopped, why. Nothing for
    // a record on no route. **Show the route** draws the route with its way on it (§32.7).
    juris.registerComponent("FlowPosition", ({ object, id }, api) => {
        const as = api.getState("me.id", null, { track: false });
        const P = `flowrun.${object}.${id}`;
        api.live(P, "flows.runOf", args.record(object, id, as));
        const map = useRunMap(api, "route");
        return {
            div: {
                className: () => `flow-position-box${api.getState(P, null) ? "" : " none"}`,
                children: [
                    { div: {
                        className: () => `flow-position${api.getState(`${P}.state`, "") === "stopped" ? " stopped" : ""}`,
                        children: [
                            { div: { className: "flow-position-text", children: [
                                // (A sub route says which routes it runs inside: Back-end route › Rework ·.)
                                { span: { className: "muted small", textContent: () => { const r = api.getState(P, null); return r ? `${[...(r.inside ?? [])].reverse().map((x) => `${x.label} › `).join("")}${r.label} · ` : ""; } } },
                                { strong: { textContent: () => { const r = api.getState(P, null); return !r ? "" : r.state === "ended" ? `ended: ${r.outcome ?? ""}` : `at ${r.nodeLabel}`; } } },
                                { span: { className: "muted small flow-way", textContent: () => { const r = api.getState(P, null); return r ? ` · ${r.steps.map((s) => s.label).join(" → ")}` : ""; } } },
                                { div: { className: "error small", textContent: () => (api.getState(`${P}.state`, "") === "stopped" ? `Stopped: ${api.getState(`${P}.reason`, "")}` : "") } },
                            ] } },
                            { button: { type: "button", className: "btn ghost small flow-map-toggle", hidden: () => !api.getState(`${P}.map`, null), "aria-expanded": () => String(map.open()), onclick: map.toggle, children: [icon("branch"), { span: { textContent: () => (map.open() ? "Hide the route" : "Show the route") } }] } },
                        ],
                    } },
                    () => { const r = api.getState(P, null); return map.open() && r?.map ? routeMaps(api, r, { view: `ui.routeView.${object}.${id}`, key: `route-${id}` }) : { span: {} }; },
                ],
            },
        };
    });

    juris.registerComponent("ScanField", ({ id, f, name, to, noun = null, disabled, placeholder, onPick }, api) => {
        // What was typed and not found, and why, kept in the form's state (`${f}.scan`): the form clears it
        // with the rest of its messages (Clear, or left behind).
        const S = `${f}.scan.${name}`;
        const typed = () => api.getState(`${S}.typed`, null);
        const setTyped = (v) => api.setValue(`${S}.typed`, v);
        const miss = () => api.getState(`${S}.miss`, null);
        const setMiss = (v) => api.setValue(`${S}.miss`, v);
        const [title, setTitle] = api.useState("title", null);
        const as = api.getState("me.id", null, { track: false });
        if (!api.isServer) {
            // The current value's title, whoever set it (a scan, the record the screen was opened from).
            const stop = api.bindState(() => api.getState(`${f}.data.${name}`, null), (value) => {
                if (!value) { setTitle(null); return; }
                api.call("records.get", { object: to, id: value, as }).then((r) => setTitle(r?.$title ?? "(not visible to you)"), () => setTitle(null));
            });
            api.onCleanup(stop);
        }
        // → whether the field now holds a record (what a scan's Enter moves on with, keyboard.js).
        const resolve = async (text) => {
            const wanted = String(text ?? "").trim();
            // Leaving the field after Enter fires its change again for the same text: looked up already.
            // (Looking it up again would put a miss back after Clear, which that very leaving preceded.)
            if (wanted && wanted === typed()) return false;
            setMiss(null);
            if (!wanted) { setTyped(null); onPick(null); return false; }
            if (wanted === title()) { setTyped(null); return true; }
            const hit = await api.call("records.lookup", { object: to, key: wanted }).catch(() => null);
            // Not found: the field is empty (not still the record scanned before), and says so in its own words.
            if (hit) { setTyped(null); setTitle(hit.title); onPick(hit.id); return true; }
            onPick(null); setTyped(wanted); setMiss(`No ${String(noun ?? to.replace(/_/g, " ")).toLowerCase()} "${wanted}" that you can see.`);
            return false;
        };
        return {
            span: {
                className: "scan-field",
                children: [
                    icon("scan", { className: "scan-icon" }),
                    { input: { id, disabled, autocomplete: "off", inputMode: "text", placeholder: placeholder ?? "Scan or type the label", value: () => typed() ?? title() ?? "",
                        // Enter finds the record, then (found) says so, for a form taken from the keyboard to move on.
                        onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); const el = e.target; resolve(el.value).then((found) => { if (found) el.dispatchEvent(new CustomEvent("mes-advance", { bubbles: true })); }); } },
                        // Left (a click elsewhere, or an input flow moving on by another key): found, it says so too.
                        onchange: (e) => { const el = e.target; resolve(el.value).then((found) => { if (found) el.dispatchEvent(new CustomEvent("mes-resolved", { bubbles: true })); }); } } },
                    { div: { className: "field-error", hidden: () => !miss(), textContent: () => miss() ?? "" } },
                ],
            },
        };
    });

    // A table of rows (§25.1): a sample's readings, a lot's wafers. One line per row, its fields as
    // columns; as many empty lines as it asks for at least (min) to start with, more on request (to
    // max). A line left empty is not a row: the server takes only lines with something in them.
    juris.registerComponent("RowsField", ({ id, f, name, field, disabled, onSet }, api) => {
        const cols = Object.entries(field.fields ?? {});
        const least = Math.max(1, field.min ?? 1);
        const rows = () => { const v = api.getState(`${f}.data.${name}`, null); return Array.isArray(v) ? v : []; };
        const [extra, setExtra] = api.useState("extra", 0);
        const lines = () => Math.max(least, rows().length) + extra();
        // `disabled` may be a reactive value (a form that is sending): read it where it is used.
        const off = () => (typeof disabled === "function" ? Boolean(disabled()) : Boolean(disabled));
        const parse = (spec, raw) => {
            if (raw === "" || raw === null || raw === undefined) return null;
            if (spec.type === "integer") { const n = Number(raw); return Number.isInteger(n) ? n : raw; }
            if (spec.type === "decimal") { const n = Number(String(raw).replace(",", ".")); return Number.isFinite(n) ? n : raw; }
            return raw;
        };
        const setCell = (i, c, v) => {
            const next = rows().map((r) => ({ ...r }));
            while (next.length <= i) next.push({});
            next[i] = { ...next[i], [c]: v };
            onSet(next);
        };
        const remove = (i) => { if (i < rows().length) onSet(rows().filter((_, k) => k !== i)); else setExtra(Math.max(0, extra() - 1)); };
        const cell = (i, c, spec) => {
            const value = () => rows()[i]?.[c];
            if (spec.type === "enum") return { select: { disabled, "aria-label": `${spec.label ?? c}, row ${i + 1}`, onchange: (e) => setCell(i, c, e.target.value || null), children: noDefault([{ option: { value: "", textContent: "—" } }, ...(spec.values ?? []).map((v) => ({ option: { key: v, value: v, textContent: v, selected: () => value() === v } }))]) } };
            if (spec.type === "boolean") return { input: { type: "checkbox", disabled, "aria-label": `${spec.label ?? c}, row ${i + 1}`, checked: () => value() === true, onchange: (e) => setCell(i, c, e.target.checked) } };
            const type = spec.type === "integer" || spec.type === "decimal" ? "number" : spec.type === "date" ? "date" : "text";
            return { input: { type, step: spec.type === "decimal" ? "any" : undefined, disabled, "aria-label": `${spec.label ?? c}, row ${i + 1}`, value: () => (value() ?? "").toString(), onchange: (e) => setCell(i, c, parse(spec, e.target.value)) } };
        };
        return {
            div: {
                id, className: "rows-field",
                children: [
                    { div: { className: "grid-scroll", children: [{ table: { className: "grid rows-table", children: [
                        { thead: { children: [{ tr: { children: [{ th: "#" }, ...cols.map(([c, spec]) => ({ th: `${spec.label ?? c}${spec.required ? " *" : ""}` })), { th: "" }] } }] } },
                        { tbody: { children: () => Array.from({ length: lines() }, (_, i) => ({ tr: { key: `r${i}`, children: [
                            { td: { className: "muted small", textContent: String(i + 1) } },
                            ...cols.map(([c, spec]) => ({ td: { key: c, children: [cell(i, c, spec)] } })),
                            { td: { children: [off() || lines() <= least ? { span: { className: "rows-none" } } : { button: { type: "button", className: "mini", title: `Remove row ${i + 1}`, "aria-label": `Remove row ${i + 1}`, children: [icon("x")], onclick: () => remove(i) } }] } },
                        ] } })) } },
                    ] } }] } },
                    { button: { type: "button", className: "btn ghost small", hidden: () => off() || (field.max !== undefined && lines() >= field.max), children: [icon("plus"), { span: " Add a row" }], onclick: () => setExtra(extra() + 1) } },
                    { p: { className: "muted small", textContent: field.min ? `At least ${field.min} ${field.min === 1 ? "row" : "rows"}${field.max ? `, at most ${field.max}` : ""}.` : field.max ? `At most ${field.max} rows.` : "" } },
                ],
            },
        };
    });

    juris.registerComponent("RefField", ({ id, f, name, to, disabled, onPick }, api) => {
        const [options, setOptions] = api.useState("options", null);
        const current = () => api.getState(`${f}.data.${name}`, null);
        const as = api.getState("me.id", null, { track: false });
        if (!api.isServer) {
            api.onMount(() => {
                api.call("records.list", { object: to, as }).then((list) => setOptions(list.rows.map((r) => ({ id: r.id, title: r.$title ?? r.id.slice(0, 8), state: r.state }))), () => setOptions([]));
            });
        }
        return {
            select: {
                id, disabled,
                onchange: (e) => onPick(e.target.value || null),
                children: noDefault(() => {
                    const list = options() ?? [];
                    const have = current();
                    const known = list.some((o) => o.id === have);
                    return [
                        { option: { key: "", value: "", textContent: "—" } },
                        ...(have && !known ? [{ option: { key: have, value: have, selected: true, textContent: options() === null ? "…" : "(not visible to you)" } }] : []),
                        ...list.map((o) => ({ option: { key: o.id, value: o.id, selected: () => current() === o.id, textContent: `${o.title} · ${o.state.replace(/_/g, " ")}` } })),
                    ];
                }),
            },
        };
    });

    // A submission whose outcome is unknown, sent again exactly as it was, with the same key.
    juris.registerComponent("SendAgain", ({ f, form }, api) => () => (api.getState(`${f}.unknown`, false)
        ? { button: { type: "button", className: "btn primary", textContent: () => (api.getState(`${f}.saving`, false) ? "Sending…" : "Send again"), disabled: () => api.getState(`${f}.saving`, false) || dbDown(api), onclick: () => form.resend() } }
        : { span: {} }));

    juris.registerComponent("ActionBar", ({ defPath, recPath, onAction, onArchive, onWhy, blocked = () => false }, api) => ({
        div: {
            className: "actions",
            children: () => {
                api.getState(`${recPath}.row_version`);
                api.getState(`${defPath}.version`);
                const def = api.peek(defPath);
                const perm = api.peek(`${recPath}.$perm`);
                if (!def || !perm) return [];
                const seen = new Set();
                const out = [];
                for (const t of def.states.transitions) {
                    if (seen.has(t.action)) continue;
                    seen.add(t.action);
                    if (perm.actions.includes(t.action)) out.push({ button: { key: t.action, type: "button", className: "btn", textContent: t.label, disabled: () => blocked(), onclick: () => onAction(t.action) } });
                }
                const archived = Boolean(api.peek(`${recPath}.archived_at`));
                // The transactions this record appears on in its state (§25), for the person who may run them;
                // on a route under way, those the route offers only where it is (§32.5).
                const rec = api.peek(recPath);
                const run = api.getState(`flowrun.${def.object}.${rec.id}`, null);
                const placed = run && run.state !== "ended" ? run : null;
                for (const t of api.getState("nav.transactions", []) ?? []) {
                    if (archived || t.appearsOn?.object !== def.object || (t.appearsOn.states?.length && !t.appearsOn.states.includes(rec.state))) continue;
                    if (placed && (placed.routed ?? []).includes(t.name) && !(placed.state === "running" && placed.offers.includes(t.name))) continue;
                    if (t.appearsOn.when !== undefined && evaluate(t.appearsOn.when, { record: rec, user: { id: api.peek("me.id") } }) !== true) continue;
                    out.push({ Link: { key: `t-${t.name}`, to: `/t/${t.name}/${rec.id}`, className: "btn tx-btn icon-text", title: t.description, children: [{ span: t.label }, icon("arrowRight")] } });
                }
                if (perm.archive) out.push({ button: { key: "archive", type: "button", className: "btn ghost", textContent: archived ? "Restore" : "Archive", disabled: () => blocked(), onclick: () => onArchive(archived) } });
                // "Why?" for the first action missing here, else for archiving when that is missing.
                const missing = def.states.transitions.find((t) => !perm.actions.includes(t.action))?.action;
                // (An object with no actions at all, whose records this person may archive, misses nothing:
                // there is nothing to ask why about. A kept report, a desktop.)
                const first = def.states.transitions[0]?.action;
                const target = missing ? { action: missing } : !perm.archive ? { archive: true } : first ? { action: first } : null;
                if (target) out.push({ button: { key: "?", type: "button", className: "btn ghost", title: "Why is an action missing?", "aria-label": "Why is an action missing?", children: [icon("more")], onclick: () => onWhy(target) } });
                return out;
            },
        },
    }));

    // ---- transparency (§9.7) ----
    juris.registerComponent("WhyPanel", ({ object, id, f, defPath, recPath }, api) => {
        const load = () => {
            const target = api.peek(`${f}.whyTarget`);
            if (!target || api.isServer) return;
            api.setValue(`${f}.why`, { loading: true });
            api.call("access.explain", { object, id, ...target }).then(
                (trace) => api.setValue(`${f}.why`, trace),
                (error) => api.setValue(`${f}.why`, { error: error.message }),
            );
        };
        if (!api.isServer) {
            const stop = api.bindState(() => JSON.stringify(api.getState(`${f}.whyTarget`, null)), () => load());
            api.onCleanup(stop);
        }
        const options = () => {
            const def = api.getState(defPath);
            if (!def) return [];
            const actions = [...new Set(def.states.transitions.map((t) => t.action))];
            return [
                ...Object.entries(def.fields).map(([name, field]) => ({ value: `field:${name}`, label: `Change ${field.label}` })),
                ...actions.map((a) => ({ value: `action:${a}`, label: `Action: ${def.states.transitions.find((t) => t.action === a).label}` })),
                { value: "archive:", label: "Archive or restore" },
            ];
        };
        const selected = () => {
            const t = api.getState(`${f}.whyTarget`, null);
            return t ? (t.archive ? "archive:" : t.field ? `field:${t.field}` : `action:${t.action}`) : "";
        };
        return {
            div: {
                className: "why",
                children: [
                    {
                        label: {
                            className: "why-pick",
                            children: [
                                { span: "Why can't I…" },
                                {
                                    select: {
                                        onchange: (e) => {
                                            const [kind, name] = e.target.value.split(":");
                                            api.setValue(`${f}.whyTarget`, kind === "archive" ? { archive: true } : kind === "field" ? { field: name } : { action: name });
                                        },
                                        children: noDefault(() => [{ option: { key: "", value: "", textContent: "pick a field or an action" } }, ...options().map((o) => ({ option: { key: o.value, value: o.value, selected: () => selected() === o.value, textContent: o.label } }))]),
                                    },
                                },
                            ],
                        },
                    },
                    () => {
                        const trace = api.getState(`${f}.why`, null);
                        if (!trace) return { p: { className: "muted", textContent: "Pick what you want to do. The answer is read from the system's own decision, not guessed." } };
                        if (trace.loading) return { p: { className: "muted", textContent: "Asking…" } };
                        if (trace.error) return { p: { className: "error", textContent: trace.error } };
                        return {
                            div: {
                                className: "why-answer",
                                children: [
                                    { p: { className: `verdict ${trace.decision}`, textContent: summary(trace) } },
                                    { h4: "Because" },
                                    {
                                        ul: {
                                            children: trace.because.map((b, i) => ({
                                                li: {
                                                    key: i,
                                                    children: [
                                                        { span: { className: "src", textContent: b.source } },
                                                        { span: { textContent: b.detail ?? `rule ${b.rule}: roles ${b.roles}; condition ${b.condition}${b.effect === "deny" ? " (deny)" : ""}` } },
                                                    ],
                                                },
                                            })),
                                        },
                                    },
                                    trace.remedies.length ? { h4: "What you can do" } : { span: {} },
                                    trace.remedies.length ? { ul: { children: trace.remedies.map((r, i) => ({ li: { key: i, textContent: r.detail } })) } } : { span: {} },
                                    { details: { children: [{ summary: "The decision trace" }, { pre: { textContent: JSON.stringify(trace, null, 2) } }] } },
                                ],
                            },
                        };
                    },
                ],
            },
        };
    });

    // A record's history (§10.10), in words: one entry per transaction or flow run (its writes together), by
    // what made it (Track in · Wade Tanaka; Entered Oxidation, CMOS route), each field by its label. What the
    // design leaves unsaid is counted, and Show every change lists it.
    juris.registerComponent("HistoryPanel", ({ object, id }, api) => {
        const [rows, setRows] = api.useState("rows", null);
        const [every, setEvery] = api.useState("every", false);
        const load = (all) => { setRows(null); api.call("records.history", { object, id, ...(all ? { every: true } : {}) }).then(setRows, () => setRows([])); };
        if (!api.isServer) api.onMount(() => load(false));
        const words = (v) => String(v ?? "").replace(/_/g, " ");
        const diffOf = (r) => Object.keys({ ...(r.before ?? {}), ...(r.after ?? {}) }).filter((k) => k !== "state")
            .map((k) => `${r.labels?.[k] ?? words(k)}: ${historyValue(r.before?.[k])} → ${historyValue(r.after?.[k])}`);
        const stateOf = (r) => (r.after && Object.hasOwn(r.after, "state") && r.before?.state !== r.after.state ? `${words(r.before?.state ?? "new")} → ${words(r.after.state)}` : null);
        // Newest first; a run's writes (a transaction's update and its transition) told as one.
        const grouped = (list) => {
            const out = [];
            for (const r of list) {
                const last = out[out.length - 1];
                if (last && r.via?.run && last.via?.run === r.via.run && !r.step && !last.step && !r.action.startsWith("request:")) last.parts.push(r);
                else out.push({ ...r, parts: [r] });
            }
            return out;
        };
        const headOf = (g) => {
            if (g.action.startsWith("request:")) return requestWords(g);
            if (g.action === "read:sensitive") return `Shown: ${g.after?.label ?? g.after?.field}`;
            if (g.step) return `Entered ${g.step.label} (${g.step.route})`;
            const made = g.parts.some((p) => p.action === "create");
            if (g.via) return `${g.via.label}${made ? ": made" : ""}`;
            if (made) return "Made";
            const t = g.parts.find((p) => p.action.startsWith("transition:"));
            if (t) return words(t.action.slice("transition:".length));
            return { update: "Changed", archive: "Archived", restore: "Restored" }[g.action] ?? words(g.action);
        };
        return {
            div: {
                className: "history",
                children: () => {
                    const list = rows();
                    if (list === null) return [{ p: { className: "muted", textContent: "Loading the audit trail…" } }];
                    const omitted = list.reduce((n, r) => n + (r.omitted ?? 0), 0);
                    const toggle = omitted || every()
                        ? [{ label: { key: "every", className: "small history-every", children: [{ input: { type: "checkbox", checked: () => every(), onchange: (e) => { setEvery(e.target.checked); load(e.target.checked); } } }, { span: every() ? " Every change (the design says fewer)" : ` Show every change (${omitted} more not said here)` }] } }]
                        : [];
                    if (!list.length) return [...toggle, { p: { key: "none", className: "muted", textContent: "No history." } }];
                    return [...toggle, ...grouped(list).map((g) => {
                        const request = g.action.startsWith("request:");
                        const lines = request
                            ? [[g.after?.values && Object.entries(g.after.values).map(([k, v]) => `${g.labels?.[k] ?? words(k)} → ${historyValue(v)}`).join(" · "), g.after?.reason && `“${g.after.reason}”`, g.after?.note && `“${g.after.note}”`, g.after?.outcome].filter(Boolean).join(" · ")]
                            : g.action === "read:sensitive" ? [`“${g.after?.reason ?? ""}”`]
                                : [g.parts.map(stateOf).find(Boolean) && `State: ${g.parts.map(stateOf).find(Boolean)}`, ...g.parts.flatMap(diffOf)].filter(Boolean);
                        return {
                            div: {
                                key: g.seq,
                                className: "event",
                                children: [
                                    { div: { className: "when", textContent: `${plant().dateTime(g.at, { seconds: true })} · ${g.actorName ?? g.actor}` } },
                                    { div: { className: "what", textContent: headOf(g) } },
                                    { div: { className: "diff", textContent: lines.join(" · ") } },
                                    g.parts.some((p) => p.rules?.length) ? { div: { className: "rules small muted", textContent: `rules: ${[...new Set(g.parts.flatMap((p) => p.rules ?? []).map((t) => `${t.script} ${t.outcome}`))].join(", ")}` } } : { span: {} },
                                ],
                            },
                        };
                    })];
                },
            },
        };
    });
}

// One cell of a list: the first links to the record; a sensitive value (§6.10) is hidden, with Show.
function cellOf(object, def, row, c, first) {
    if (isHidden(row[c])) return { td: { children: [{ SensitiveValue: { object, id: row.id, field: c, label: def.fields[c]?.label ?? c, type: def.fields[c]?.type ?? "string" } }] } };
    return { td: first ? { children: [{ Link: { to: `/o/${object}/${row.id}`, textContent: display(def, row, c) } }] } : display(def, row, c) };
}

// Where a list keeps one record by its id (ListPage, ListRow).
const recordPath = (object, id) => `d.rec.${object}.${id}`;

// A list of records as a table: the definition's columns and the state.
function grid(api, object, def, all, query, empty = "No records you can see.") {
    if (!def) return { p: { className: "muted", textContent: "Loading…" } };
    const columns = def.list.columns;
    const plain = isList(def);
    const q = query.trim().toLowerCase();
    const rows = all.filter((row) => !q || [row.state, ...columns.map((c) => display(def, row, c))].join(" ").toLowerCase().includes(q));
    return {
        table: {
            className: "grid",
            children: [
                { thead: { children: [{ tr: { children: [...columns.map((c) => ({ th: def.fields[c]?.label ?? c })), ...(plain ? [] : [{ th: "State" }])] } }] } },
                {
                    tbody: {
                        children: rows.length ? rows.map((row) => ({
                            tr: {
                                key: row.id,
                                className: "row",
                                onclick: () => api.navigate(`/o/${object}/${row.id}`),
                                children: [
                                    ...columns.map((c, i) => cellOf(object, def, row, c, i === 0)),
                                    ...(plain ? [] : [{ td: { children: [{ span: { className: stateBadgeClass(row.state, def.states?.tones), textContent: row.state.replace(/_/g, " ") } }] } }]),
                                ],
                            },
                        })) : [{ tr: { key: "none", children: [{ td: { colSpan: columns.length + (plain ? 0 : 1), className: "muted", textContent: q ? "Nothing matches the filter." : empty } }] } }],
                    },
                },
            ],
        },
    };
}

// A plain sentence from a decision trace; the AI assistant will phrase it better, from the same trace.
function summary(trace) {
    const what = trace.target.archive ? "archive or restore this record" : trace.target.action ? `take the action '${trace.target.action}'` : `change '${trace.target.field}'`;
    if (trace.decision === "allow") return `You may ${what}.`;
    const state = trace.because.find((b) => b.source === "archive") ?? trace.because.find((b) => b.source === "state");
    const rule = trace.because.find((b) => b.source === "rule");
    const policy = trace.because.find((b) => b.source === "policy" && b.roles?.startsWith("matched"));
    const reason = state?.detail ?? (policy ? `your role's rule ${policy.rule} does not apply: ${policy.condition.replace(/^fails: /, "")}` : "no rule gives your roles this right");
    return `You cannot ${what}: ${reason}.${rule ? ` Also, ${rule.detail}.` : ""}`;
}

// The form's behaviour: the rule pipe on every change (advice), and a submit that shows the server's
// answer on the fields it names.
// `object` null: a form with no rule pipe of its own (a transaction's inputs, §25).
export function formController(api, { object, f, defPath, record }) {
    let latest = 0;
    const runner = api.isServer || !object ? null : rulesFor(api, object);
    const ctxFor = (event) => ({
        event: { object, action: null, changed: [], source: "user", prev: {}, ...event },
        user: { id: api.peek("me.id") },
        record: { ...(record() ?? {}), $perm: undefined, $titles: undefined },
        data: api.peek(`${f}.data`) ?? {},
        now: new Date().toISOString(),
    });
    // Runs the pipe; applies its errors, and its writes (all of them when `commit`, else all but the
    // field being typed, so a value is never rewritten under the user's cursor). True when clean.
    const run = async (event, { commit = false } = {}) => {
        if (!runner) return true;
        const mine = ++latest;
        const def = api.peek(defPath);
        let out;
        try {
            out = await runner.run(def?.rules ?? [], ctxFor(event));
        } catch {
            return true; // the rules could not run here: the server decides at save
        }
        if (mine !== latest) return true; // a newer change is being checked
        api.batch(() => {
            const errors = { ...(api.peek(`${f}.ruleErrors`) ?? {}) };
            for (const t of out.trace) if (t.outcome === "passed") delete errors[t.script];
            if (out.error) errors[out.error.script] = { field: out.error.field ?? "_form", message: out.error.message };
            api.setValue(`${f}.ruleErrors`, errors);
            const data = api.peek(`${f}.data`) ?? {};
            for (const [name, value] of Object.entries(out.ctx.data ?? {})) {
                if (!commit && event.changed?.includes(name)) continue;
                if (JSON.stringify(data[name]) !== JSON.stringify(value)) api.setValue(`${f}.data.${name}`, value);
            }
        });
        return !out.error;
    };
    // A submission whose outcome is unknown: { send, key, onDone }, until it gets a definite answer.
    let retry = null;
    async function attempt(send, key, onDone) {
        api.batch(() => {
            api.setValue(`${f}.saving`, true);
            api.setValue(`${f}.serverErrors`, {});
            api.setValue(`${f}.notice`, null);
        });
        let result;
        try {
            result = await send(key);
        } catch (error) {
            noteFailure(api, error);
            const unknown = outcomeUnknown(error);
            retry = unknown ? { send, key, onDone } : null;
            api.batch(() => {
                api.setValue(`${f}.saving`, false);
                api.setValue(`${f}.unknown`, unknown);
                const fields = error?.fields && typeof error.fields === "object" ? error.fields : {};
                const clean = Object.fromEntries(Object.entries(fields).filter(([k, v]) => typeof v === "string" && !k.includes(".") && k !== "__proto__"));
                const words = unknown && error?.code !== "db.unknown" ? NO_ANSWER : (error?.message ?? "The request failed.");
                api.setValue(`${f}.serverErrors`, { ...clean, _form: words });
            });
            return;
        }
        retry = null;
        api.batch(() => {
            api.setValue(`${f}.saving`, false);
            api.setValue(`${f}.unknown`, false);
        });
        onDone(result);
    }
    return {
        change(name, value) {
            const prev = api.peek(`${f}.data.${name}`);
            api.batch(() => {
                api.setValue(`${f}.data.${name}`, value);
                api.setValue(`${f}.dirty`, true);
                api.setValue(`${f}.notice`, null);
                api.deleteState(`${f}.serverErrors.${name}`);
                api.deleteState(`${f}.serverErrors._form`);
            });
            run({ kind: "change", changed: [name], prev: { [name]: prev ?? null } });
        },
        commit(name) {
            run({ kind: "change", changed: [name], prev: {} }, { commit: true });
        },
        check: (event) => run(event, { commit: true }),
        // Nothing new may be sent while the database is down or a submission's outcome is unknown.
        held: () => dbDown(api) || api.getState(`${f}.unknown`, false),
        blocked: () => Object.keys(api.getState(`${f}.ruleErrors`, {})).length > 0 || dbDown(api) || api.getState(`${f}.unknown`, false),
        unknown: () => api.getState(`${f}.unknown`, false),
        // `send(key)` makes the call. One key per submission: sent again (resend) it is the same key,
        // so the server answers the first result if the first attempt was saved after all.
        async submit(send, onDone) {
            if (retry) return;
            await attempt(send, newKey(), onDone);
        },
        async resend() {
            if (retry) await attempt(retry.send, retry.key, retry.onDone);
        },
    };
}
