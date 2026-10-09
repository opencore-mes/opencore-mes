// Embedding (DESIGN.md §37, docs/contracts/embedding): a page of another site the plant names
// (EMBED_ORIGINS) may show OpenCore MES in a frame beside its own content, a course or a work
// instruction, and talk to it by window messages. It hears where the person is (`ready`, `location`)
// and may ask that something on the page be outlined by the words a person sees on it (`outline`),
// never by the page's markup: what this module matches is a button's, link's, tab's, field's or
// heading's visible name, so nothing outside the core depends on how a page is built (§31). It can
// read nothing else and do nothing else: no click, no typing, no record. A message from any other
// origin, or from a window that is not this page's parent, is ignored; one to the parent is sent to
// each allowed origin by name, so the browser delivers it only to the one that is there.
//
//   { EmbedBridge: {} }   in the shell, beside the guide: draws the outlines (the guide's marks)
//
// Message: { protocol: "opencore-mes.embed", version: "1.0", type, …fields } (schema.json).

export const PROTOCOL = "opencore-mes.embed";
export const VERSION = "1.0";
export const KINDS = ["any", "button", "link", "tab", "field", "heading"];
const SELECTORS = {
    button: "button, [role=button], input[type=button], input[type=submit], summary",
    link: "a[href], [role=link]",
    tab: "[role=tab], .tab",
    field: "label",
    heading: "h1, h2, h3, h4",
};
SELECTORS.any = [SELECTORS.button, SELECTORS.link, SELECTORS.tab, SELECTORS.field, SELECTORS.heading, "[role=menuitem], [role=option], legend, th"].join(", ");

// A name as a person reads it: spaces as one, no trailing ":", "*" or "…", any case.
export const normal = (s) => String(s ?? "").replace(/\s+/g, " ").trim().replace(/[\s:*…]+$/u, "").toLowerCase();

// A message from the embedding page, checked: its shape, or null. Only what the contract names passes.
export function readMessage(data) {
    if (!data || typeof data !== "object" || data.protocol !== PROTOCOL || typeof data.type !== "string") return null;
    if (String(data.version ?? "").split(".")[0] !== VERSION.split(".")[0]) return null;
    if (data.type === "hello" || data.type === "clear") return { type: data.type };
    if (data.type === "outline") {
        const label = typeof data.label === "string" ? data.label.trim() : "";
        const kind = data.kind === undefined ? "any" : data.kind;
        if (!label || label.length > 200 || !KINDS.includes(kind)) return null;
        return { type: "outline", label, kind };
    }
    return null;
}

export const message = (type, fields = {}) => ({ protocol: PROTOCOL, version: VERSION, type, ...fields });

// The allowed origins, from the setting: each an origin exactly (scheme, host, port), nothing more.
export function parseOrigins(text) {
    const out = [];
    for (const item of String(text ?? "").split(/[\s,]+/).filter(Boolean)) {
        let url;
        try { url = new URL(item); } catch { throw new Error(`EMBED_ORIGINS: "${item}" is not an address; give each site as https://host (or http://127.0.0.1:port on this machine).`); }
        const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
        if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`EMBED_ORIGINS: "${item}" must be https (http only for this machine).`);
        if (url.origin !== item.replace(/\/$/, "")) throw new Error(`EMBED_ORIGINS: "${item}" must be an origin only (https://host[:port]), with no path, query or user.`);
        if (!out.includes(url.origin)) out.push(url.origin);
    }
    return out;
}

// The visible name of an element: its aria-label, else the text a person sees, else a title or value.
function nameOf(el) {
    return normal(el.getAttribute("aria-label") || el.innerText || el.textContent || el.getAttribute("title") || el.value || el.getAttribute("placeholder") || "");
}
// What to outline for a match: a field's label stands for the whole field (its label and its control).
const boxOf = (el) => (el.tagName === "LABEL" ? el.parentElement ?? el : el);

// The elements on the page named `label`, of a kind: exact names first; else names that begin with it.
function find(label, kind) {
    const want = normal(label);
    const seen = [...document.querySelectorAll(SELECTORS[kind] ?? SELECTORS.any)].filter((el) => !el.closest(".guide-dock, .guide-marks") && el.getClientRects().length);
    const named = seen.map((el) => ({ el, name: nameOf(el) }));
    let hits = named.filter((x) => x.name === want);
    if (!hits.length) hits = named.filter((x) => x.name.startsWith(want));
    return [...new Set(hits.map((x) => boxOf(x.el)))].slice(0, 40);
}
const rects = (els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left) - 3, y: Math.round(r.top) - 3, w: Math.round(r.width) + 6, h: Math.round(r.height) + 6 }; });

export function registerEmbed(juris) {
    juris.registerComponent("EmbedBridge", (_, api) => {
        const origins = api.getState("embed", null) ?? [];
        if (!api.isServer && origins.length && window.parent !== window) {
            const send = (type, fields) => { for (const o of origins) { try { window.parent.postMessage(message(type, fields), o); } catch { /* not that origin */ } } };
            const here = () => ({ path: `${location.pathname}${location.search}`, title: document.title });
            const ready = () => {
                const me = api.peek("me");
                send("ready", { viewer: me ? { id: me.id, name: me.name } : null, instance: api.peek("instance") ?? null, ...here() });
            };
            let asked = null;
            let follow = null;
            let count = 0;
            // The outlines drawn again; the embedding page told again when how many there are changes.
            const draw = (reveal) => {
                if (!asked) return;
                const els = find(asked.label, asked.kind);
                if (reveal) els[0]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
                api.setValue("ui.embedMarks", rects(els));
                if (!reveal && els.length !== count) send("outlined", { label: asked.label, found: els.length });
                count = els.length;
                return els.length;
            };
            const stop = () => { asked = null; clearInterval(follow); follow = null; api.setValue("ui.embedMarks", []); };
            const onMessage = (event) => {
                if (event.source !== window.parent || !origins.includes(event.origin)) return;
                const m = readMessage(event.data);
                if (!m) return;
                if (m.type === "hello") return ready();
                if (m.type === "clear") return stop();
                stop();
                asked = m;
                count = 0;
                send("outlined", { label: m.label, found: draw(true) });
                // What it names may come a moment later (a tab loading, a dialog opening): looked for again.
                follow = setInterval(() => draw(false), 500);
            };
            const reflow = () => draw(false);
            window.addEventListener("message", onMessage);
            window.addEventListener("scroll", reflow, true);
            window.addEventListener("resize", reflow);
            // Where the person is, each time it changes (after the page has its title).
            const stopRoute = api.bindState(() => api.getState("$route.path"), () => { stop(); setTimeout(() => send("location", here()), 0); });
            setTimeout(ready, 0);
            api.onCleanup(() => { stop(); stopRoute(); window.removeEventListener("message", onMessage); window.removeEventListener("scroll", reflow, true); window.removeEventListener("resize", reflow); });
        }
        return { div: { className: "guide-marks", "aria-hidden": "true", children: () => (api.getState("ui.embedMarks", []) ?? []).map((m, i) => ({ div: { key: `e${i}`, className: "guide-mark", style: `left:${m.x}px;top:${m.y}px;width:${m.w}px;height:${m.h}px` } })) } };
    });
}
