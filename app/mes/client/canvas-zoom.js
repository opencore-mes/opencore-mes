// Zooming a drawing in a scrolling panel (a flow template's canvas, a run's map; §32.7): by default the
// drawing is fitted to the panel, as it always was; − and + zoom out and in, about the panel's middle,
// Ctrl or ⌘ with the wheel (and a trackpad's pinch) about the pointer, and the percentage goes back to
// fitted. Zoomed in, a drag on the drawing's empty ground moves it. The drawing keeps its viewBox: only
// its width changes, so whatever maps the pointer into it (a node's drag) goes on working at any zoom.
// The zoom is the person's, in state at `path` (null: fitted), never the design's.
import { icon } from "./icons.js";

export const ZOOM = { min: 0.25, max: 2.5, step: 1.25 };
export const clampZoom = (z) => Math.min(ZOOM.max, Math.max(ZOOM.min, Math.round(z * 100) / 100));
// The next zoom from the one shown (`dir` 1 in, -1 out), snapped to a step from 100% so that in and
// out again comes back where it was.
export function stepZoom(shown, dir) {
    const k = Math.log(shown) / Math.log(ZOOM.step);
    // A step shown rounded (156% for 1.5625) is that step.
    const near = Math.round(k);
    const next = Math.abs(k - near) < 0.05 ? near + Math.sign(dir) : dir > 0 ? Math.floor(k) + 1 : Math.ceil(k) - 1;
    return clampZoom(ZOOM.step ** next);
}
// Where the panel scrolls to keep the drawing's point under (x, y) (the pointer, or the panel's middle,
// from the panel's top left) in place, the drawing `ratio` times as large as it was.
export const scrollAround = ({ left, top, x, y, ratio }) => ({ left: Math.max(0, (left + x) * ratio - x), top: Math.max(0, (top + y) * ratio - y) });

// Drags on the ground in progress, by panel (one at a time each, and nothing to draw).
const pans = new WeakMap();

// `width` is the drawing's own (its viewBox's); `fitStyle` its style when fitted. `pan`: "all" pointers,
// or "mouse" alone where a finger already scrolls the panel (touch-action auto).
export function canvasZoom(api, path, { width, fitStyle = "", pan = "all" }) {
    const zoom = () => { const z = api.getState(path, null); return typeof z === "number" && Number.isFinite(z) ? clampZoom(z) : null; };
    const wrapOf = (el) => el?.closest?.(".zoom-wrap") ?? null;
    // The zoom the drawing is shown at: its own, or, fitted, what the panel's width makes it.
    const shownIn = (wrap) => { const svg = wrap?.querySelector("svg"); const w = svg?.getBoundingClientRect().width; return w ? w / width : zoom() ?? 1; };
    const setAround = (wrap, z, x, y) => {
        if (!wrap) { api.setValue(path, z); return; }
        // Zoomed, the panel keeps the height it had and scrolls (fitted, it grows with the drawing): a
        // drawing growing down a growing panel would slide from under the pointer.
        if (!wrap.classList.contains("zoomed")) { wrap.style.setProperty("--zoom-h", `${wrap.offsetHeight}px`); wrap.classList.add("zoomed"); }
        const ratio = z / shownIn(wrap);
        const to = scrollAround({ left: wrap.scrollLeft, top: wrap.scrollTop, x, y, ratio });
        api.setValue(path, z);
        // The new width now (state gives it the same), so the scroll that keeps the point under the
        // pointer lands with it, however fast the wheel turns, not a frame later.
        const svg = wrap.querySelector("svg");
        if (svg) { svg.style.width = `${Math.round(width * z)}px`; svg.style.minWidth = "0"; }
        wrap.scrollLeft = to.left;
        wrap.scrollTop = to.top;
    };
    const middle = (wrap) => [wrap.clientWidth / 2, wrap.clientHeight / 2];
    // The pointer from the panel's inside top left (its border aside), as its scroll counts.
    const inside = (wrap, cx, cy) => { const r = wrap.getBoundingClientRect(); return [cx - r.left - wrap.clientLeft, cy - r.top - wrap.clientTop]; };
    const by = (e, dir) => { const wrap = e.currentTarget.closest(".zoom-box")?.querySelector(".zoom-wrap"); if (wrap) setAround(wrap, stepZoom(shownIn(wrap), dir), ...middle(wrap)); else api.setValue(path, stepZoom(zoom() ?? 1, dir)); };
    let pinchFrom = 1;
    return {
        zoomed: () => zoom() !== null,
        style: () => { const z = zoom(); return z === null ? fitStyle : `width: ${Math.round(width * z)}px; min-width: 0`; },
        // On the scrolling panel.
        wrap: {
            onwheel: (e) => {
                if (!e.ctrlKey && !e.metaKey) return;
                e.preventDefault();
                const wrap = e.currentTarget;
                const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
                setAround(wrap, clampZoom(shownIn(wrap) * Math.exp(-delta * 0.0015)), ...inside(wrap, e.clientX, e.clientY));
            },
            // Safari's pinch is a gesture, not a wheel.
            ongesturestart: (e) => { e.preventDefault(); pinchFrom = shownIn(e.currentTarget); },
            ongesturechange: (e) => {
                e.preventDefault();
                const wrap = e.currentTarget;
                setAround(wrap, clampZoom(pinchFrom * e.scale), ...(e.clientX === undefined ? middle(wrap) : inside(wrap, e.clientX, e.clientY)));
            },
            onpointerdown: (e) => {
                const wrap = wrapOf(e.target);
                // The ground alone: a node, a wire or a label is the drawing's own business.
                if (!wrap || (e.target !== wrap && e.target !== wrap.querySelector("svg")) || e.button > 0 || (pan === "mouse" && e.pointerType !== "mouse")) return;
                if (wrap.scrollWidth <= wrap.clientWidth && wrap.scrollHeight <= wrap.clientHeight) return;
                pans.set(wrap, { x: e.clientX, y: e.clientY, left: wrap.scrollLeft, top: wrap.scrollTop, id: e.pointerId });
                wrap.setPointerCapture?.(e.pointerId);
                wrap.classList.add("panning");
            },
            onpointermove: (e) => {
                const wrap = e.currentTarget;
                const p = pans.get(wrap);
                if (!p || p.id !== e.pointerId) return;
                wrap.scrollLeft = p.left - (e.clientX - p.x);
                wrap.scrollTop = p.top - (e.clientY - p.y);
            },
            onpointerup: (e) => { pans.delete(e.currentTarget); e.currentTarget.classList.remove("panning"); },
            onpointercancel: (e) => { pans.delete(e.currentTarget); e.currentTarget.classList.remove("panning"); },
        },
        // − 100% + over the panel's corner; the percentage, fitted again.
        controls: {
            div: {
                className: "zoom-controls", role: "group", "aria-label": "Zoom",
                children: [
                    { button: { type: "button", className: "btn ghost small", title: "Zoom out (or Ctrl or ⌘ and the wheel, or a pinch)", "aria-label": "Zoom out", disabled: () => zoom() !== null && zoom() <= ZOOM.min, onclick: (e) => by(e, -1), children: [icon("minus")] } },
                    { button: { type: "button", className: "btn ghost small zoom-level", title: "Fit to the panel", "aria-label": () => (zoom() === null ? "Fitted to the panel" : `Zoomed to ${Math.round(zoom() * 100)}%: fit to the panel`), onclick: (e) => { e.currentTarget.closest(".zoom-box")?.querySelector(".zoom-wrap")?.style.removeProperty("--zoom-h"); api.setValue(path, null); }, textContent: () => (zoom() === null ? "Fit" : `${Math.round(zoom() * 100)}%`) } },
                    { button: { type: "button", className: "btn ghost small", title: "Zoom in (or Ctrl or ⌘ and the wheel, or a pinch)", "aria-label": "Zoom in", disabled: () => zoom() !== null && zoom() >= ZOOM.max, onclick: (e) => by(e, 1), children: [icon("plus")] } },
                ],
            },
        },
    };
}
