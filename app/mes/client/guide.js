// UI guides (DESIGN.md §33): a "?" at the top left of a panel opens its guide, docked on the left over
// the navigator. A guide says what each thing on the panel is and how to use it (a checkbox, a
// drop-down, a scan field, the canvas, a button); hovering or focusing one of its items outlines the
// elements it is about on the panel itself.
//
//   { GuideToggle: { guide: "flow-designer", scope: "[data-guide-scope='…']" } }   a guide of the release
//   { GuideToggle: { title, make: () => ({ intro, sections }) } }                  one made from a design
//
// A guide of the release is HTML (app/mes/guides/<key>.html, the service guides.get), drawn here
// through an allowlist of tags and attributes, never as HTML: an element with data-highlight="<CSS
// selector>" is an item, outlining what the selector finds in the panel. A made one is data:
// { intro, sections: [{ title, items: [{ label, words, highlight }] }] } (formGuide: a form's fields,
// each with what its control is and how it is used).
import { icon } from "./icons.js";
import { normalizeForm } from "./form-layout.js";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const TAGS = new Set(["article", "section", "header", "h2", "h3", "h4", "p", "ul", "ol", "li", "dl", "dt", "dd", "strong", "em", "b", "i", "code", "kbd", "br", "span", "div", "a", "table", "thead", "tbody", "tr", "th", "td", "small"]);
const SAFE_HREF = /^(https?:\/\/|\/(?!\/)|#)/i;
// Never drawn, not even as text.
const DROP = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math"]);

// A parsed guide (DOM nodes, or anything shaped like them) as layout data: allowed tags kept, the rest
// unwrapped to their text, attributes only data-highlight and a safe href. `item(node, children)` draws
// an element that points at something.
export function guideLayout(node, item) {
    if (!node) return null;
    if (node.nodeType === 3) return node.textContent ? { span: { textContent: node.textContent } } : null;
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return null;
    const tag = String(node.tagName ?? "").toLowerCase();
    if (DROP.has(tag)) return null;
    const children = [...(node.childNodes ?? [])].map((c) => guideLayout(c, item)).filter(Boolean);
    if (!TAGS.has(tag)) return children.length === 1 ? children[0] : { span: { children } };
    if (tag === "br") return { br: {} };
    const props = { children };
    if (tag === "a") {
        const href = node.getAttribute?.("href") ?? "";
        if (SAFE_HREF.test(href)) Object.assign(props, { href, ...(/^https?:/i.test(href) ? { target: "_blank", rel: "noopener" } : {}) });
    }
    const highlight = node.getAttribute?.("data-highlight");
    return highlight ? item(tag, highlight, children) : { [tag]: props };
}

// What each control is, and how it is used: the words a form's guide gives for a field's widget.
const WIDGET_WORDS = {
    select: (f) => (f.type === "ref" ? `A drop-down: open it and pick the ${String(f.to ?? "record").replace(/_/g, " ")}.` : `A drop-down: open it and pick one${values(f)}.`),
    radio: (f) => `Radio buttons: pick exactly one${values(f)}.`,
    buttons: (f) => `Buttons: press the one that applies${values(f)}.`,
    checkboxes: (f) => `Checkboxes: tick every one that applies${values(f)}.`,
    multiselect: (f) => `A list: hold Ctrl (⌘ on a Mac) and click to pick several${values(f)}.`,
    chips: (f) => `Chips: tap each that applies${values(f)}.`,
    checkbox: () => "A checkbox: ticked means yes, empty means no.",
    toggle: () => "A switch: on means yes, off means no.",
    yesno: () => "Yes or No: pick one.",
    search: (f) => `A search box: type part of the ${String(f.to ?? "record").replace(/_/g, " ")}'s name and pick it from the list.`,
    scan: (f) => `A scan field: scan the ${String(f.to ?? "record").replace(/_/g, " ")}'s barcode, or type its label and press Enter.`,
    number: (f) => `A number box: type the number${f.type === "integer" ? " (whole numbers)" : ""}.`,
    stepper: () => "A number with − and +: type it, or step it down and up.",
    textarea: () => "A text box: write as much as is needed.",
    date: () => "A date: type it in the plant's format, or pick it on the calendar.",
    table: () => "A table: one line per entry. Add a row for another; the × removes one.",
    input: () => "A text field: type it.",
};
function values(f) {
    const v = Array.isArray(f.values) ? f.values : [];
    return v.length && v.length <= 8 ? ` (${v.map((x) => String(x).replace(/_/g, " ")).join(", ")})` : "";
}
const fieldTarget = (name) => `[data-guide="field:${name}"]`;

// A form's guide, made from its design (an object's, or a transaction's inputs as one): its fields in
// the order the form shows them, each with its control's words, required or not, its help.
export function formGuide(def, { intro = "", lead = [] } = {}) {
    if (!isPlain(def) || !isPlain(def.fields)) return { intro, sections: lead };
    const form = normalizeForm(def);
    const sections = [...lead];
    const kinds = new Map();
    for (const tab of form.tabs) for (const section of tab.sections) {
        const items = section.fields.map((e) => {
            const f = def.fields[e.field] ?? {};
            const widget = f.type === "rows" ? "table" : e.widget;
            const sample = { boolean: "input[type=checkbox]", enum: widget === "select" ? "select" : null, rows: "table", text: "textarea", date: "input" }[f.type] ?? null;
            if (!kinds.has(widget)) kinds.set(widget, { widget, field: f, name: e.field, sample });
            const words = [(WIDGET_WORDS[widget] ?? WIDGET_WORDS.input)(f)];
            if (f.required) words.push("Required: marked *.");
            if (f.from) words.push(`Filled in for you from ${String(f.from).replace(".", "'s ").replace(/_/g, " ")}.`);
            if (e.help) words.push(e.help);
            return { label: f.label ?? e.field, words: words.join(" "), highlight: fieldTarget(e.field) };
        });
        if (items.length) sections.push({ title: [tab.label, section.label].filter((t, i, a) => t && a.indexOf(t) === i).join(" · ") || "Fields", items });
    }
    // Each kind of control once, outlining every field drawn with it.
    const controls = [...kinds.values()].map((k) => ({
        label: { select: "Drop-down", radio: "Radio buttons", buttons: "Buttons", checkboxes: "Checkboxes", multiselect: "Multi-select list", chips: "Chips", checkbox: "Checkbox", toggle: "Switch", yesno: "Yes / No", search: "Search box", scan: "Scan field", number: "Number box", stepper: "Number with − +", textarea: "Text box", date: "Date", table: "Table", input: "Text field" }[k.widget] ?? k.widget,
        words: (WIDGET_WORDS[k.widget] ?? WIDGET_WORDS.input)({ ...k.field, to: "record", values: [] }),
        highlight: [...form.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields))].filter((e) => (def.fields[e.field]?.type === "rows" ? "table" : e.widget) === k.widget).map((e) => fieldTarget(e.field)).join(", "),
    }));
    if (controls.length) sections.push({ title: "The controls on this form", items: controls });
    sections.push({ title: "Messages", items: [
        { label: "A field's message", words: "Said in red under the field: what is wrong, and what to do. Changing the field clears it.", highlight: ".field-error:not(:empty)" },
        { label: "Locked", words: "A field you may read but not change here, saying why; Why? says which policy decides.", highlight: ".field.locked" },
    ] });
    return { intro, sections };
}

// The outlines of what an item points at, inside the panel the guide is for; `reveal` scrolls the
// first into view (pointing at it), not when following a scroll.
function marksOf(scope, selector, reveal = true) {
    let found = [];
    try {
        const root = (scope && document.querySelector(scope)) || document.querySelector(".work") || document.body;
        found = [...root.querySelectorAll(selector)].filter((el) => !el.closest(".guide-dock") && el.getClientRects().length);
    } catch { return []; }
    if (reveal) found[0]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    return found.slice(0, 40).map((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left) - 3, y: Math.round(r.top) - 3, w: Math.round(r.width) + 6, h: Math.round(r.height) + 6 }; });
}

export function registerGuides(juris) {
    // The "?" of a panel: opens its guide, or closes it.
    juris.registerComponent("GuideToggle", ({ guide = null, scope = ".work", title = "", make = null }, api) => {
        const key = guide ?? `made:${title}`;
        const on = () => api.getState("ui.guide.key", null) === key;
        const toggle = () => {
            if (on()) { api.setValue("ui.guide", null); return; }
            api.setValue("ui.guide", { key, file: guide, scope, title, made: make ? make() : null });
        };
        return { button: { type: "button", className: "btn ghost guide-toggle", classList: { on }, title: "What is on this page, and how to use it", "aria-label": "Guide to this page", "aria-pressed": () => String(on()), onclick: toggle, children: [icon("help")] } };
    });

    // The guide open, docked over the navigator; the outlines of what its hovered item points at.
    juris.registerComponent("GuideDock", (_, api) => {
        if (!api.isServer) {
            // Another page closes it; Esc too.
            const stop = api.bindState(() => api.getState("$route.path"), () => api.setValue("ui.guide", null));
            const esc = (e) => { if (e.key === "Escape" && api.peek("ui.guide")) api.setValue("ui.guide", null); };
            // The outlines follow the page as it scrolls or resizes (the first scroll is often their own).
            const clear = () => { const at = api.peek("ui.guidePointing"); if (at) api.setValue("ui.guideMarks", marksOf(api.peek("ui.guide.scope"), at, false)); };
            document.addEventListener("keydown", esc);
            window.addEventListener("scroll", clear, true);
            window.addEventListener("resize", clear);
            api.onCleanup(() => { stop(); document.removeEventListener("keydown", esc); window.removeEventListener("scroll", clear, true); window.removeEventListener("resize", clear); });
            // A guide of the release: fetched once, kept for the visit.
            const stopLoad = api.bindState(() => api.getState("ui.guide.file", null), (file) => {
                if (!file || api.peek(`guides.${file}`) !== undefined) return;
                api.setValue(`guides.${file}`, { loading: true });
                api.call("guides.get", { key: file }).then((g) => api.setValue(`guides.${file}`, { html: g.html }), (e) => api.setValue(`guides.${file}`, { error: e.message }));
            });
            api.onCleanup(stopLoad);
        }
        const point = (selector, on) => api.batch(() => {
            api.setValue("ui.guidePointing", on ? selector : null);
            api.setValue("ui.guideMarks", on ? marksOf(api.peek("ui.guide.scope"), selector) : []);
        });
        const item = (tag, selector, children) => ({
            [tag]: {
                className: "guide-item", tabindex: 0, "data-points": selector,
                onmouseenter: () => point(selector, true), onmouseleave: () => point(selector, false),
                onfocus: () => point(selector, true), onblur: () => point(selector, false),
                children,
            },
        });
        const body = () => {
            const g = api.getState("ui.guide", null);
            if (!g) return { span: {} };
            if (g.made) return { div: { className: "guide-body", children: [
                g.made.intro ? { p: { textContent: g.made.intro } } : { span: {} },
                ...g.made.sections.map((s, i) => ({ section: { key: `s${i}`, children: [{ h3: s.title }, { dl: { children: s.items.flatMap((it, k) => [
                    item("dt", it.highlight, [{ span: { textContent: it.label } }]),
                    { dd: { key: `d${k}`, textContent: it.words } },
                ]) } }] } })),
            ] } };
            const loaded = api.getState(`guides.${g.file}`, null);
            if (!loaded || loaded.loading) return { p: { className: "muted", textContent: "Loading the guide…" } };
            if (loaded.error) return { p: { className: "error", textContent: loaded.error } };
            const doc = new DOMParser().parseFromString(loaded.html, "text/html");
            const article = doc.querySelector("article") ?? doc.body;
            return { div: { className: "guide-body", children: [guideLayout(article, item)].filter(Boolean) } };
        };
        const titleOf = () => {
            const g = api.getState("ui.guide", null);
            if (!g) return "";
            if (g.title) return g.title;
            const html = api.getState(`guides.${g.file}.html`, "");
            return (/data-title="([^"]*)"/.exec(html ?? "")?.[1]) ?? "Guide";
        };
        return {
            div: {
                className: "guide-layer",
                children: [
                    { aside: {
                        className: "guide-dock panel", hidden: () => !api.getState("ui.guide", null), role: "complementary", "aria-label": "Guide",
                        children: [
                            { header: { className: "guide-head", children: [
                                icon("help"),
                                { strong: { textContent: titleOf } },
                                { button: { type: "button", className: "btn ghost small", title: "Close the guide (Esc)", "aria-label": "Close the guide", onclick: () => api.setValue("ui.guide", null), children: [icon("x")] } },
                            ] } },
                            { p: { className: "muted small guide-hint", textContent: "Point at an item: it is outlined on the page." } },
                            () => body(),
                        ],
                    } },
                    { div: { className: "guide-marks", "aria-hidden": "true", children: () => (api.getState("ui.guideMarks", []) ?? []).map((m, i) => ({ div: { key: `m${i}`, className: "guide-mark", style: `left:${m.x}px;top:${m.y}px;width:${m.w}px;height:${m.h}px` } })) } },
                ],
            },
        };
    });
}
