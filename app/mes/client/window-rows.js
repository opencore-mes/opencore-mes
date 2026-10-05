// A list's rows, however many (CLAUDE.md, every list): fifteen at first, and fifteen more only when the
// person scrolls (or wheels, or swipes) to the end of what they have reached, never to fill the screen
// by itself. Of what is reached, only a window is drawn: the rows in view and fifteen either side, at
// least thirty, a spacer standing for the rest above and below, so however far the person scrolls (and
// back), the page holds a few dozen rows and the browser's memory stays flat. The last row says how
// many there are, with a button for whoever cannot scroll (or prefers not to).
//
//   windowRows({ key, count, row: (i) => ({ tr: {...} }), tag = "tbody", columns, className })
//   → a tbody (windowTable puts it in a table with its head), or, tag: "div", a div of the rows `row`
//   gives. It scrolls with what holds it: the open tab (the one area that scrolls), or the page where there
//   are no tabs. `key` changes when the list does (another search): it starts again from fifteen.
export const START = 15;     // reached at first (and drawn on the server)
export const STEP = 15;      // more reached, each time the person scrolls to the end of what is reached
export const BUFFER = 15;    // rows drawn beyond those in view, above and below
export const KEEP = 30;      // drawn at least, once that many are reached
const MARGIN = 120;          // px: the end counts as reached this close to the bottom of the screen

export const windowRows = ({ key, ...props }) => ({ WindowRows: { key, id: `win-${String(key).replace(/[^a-zA-Z0-9_-]/g, "-")}`, ...props } });
// A table of a window of rows, its head kept in view as the tab scrolls.
//   windowTable({ key, head: ["Id", "Name"], count, row, className }) → div.win-box > table
export const windowTable = ({ key, head = [], className = "", ...props }) => ({
    div: {
        className: "win-box",
        children: [{ table: { className: `grid ${className}`.trim(), children: [
            head.length ? { thead: { children: [{ tr: { children: head.map((h) => ({ th: h })) } }] } } : { span: {} },
            windowRows({ key, columns: Math.max(1, head.length), ...props }),
        ] } }],
    },
});

// What is reached and drawn after the person scrolled. `top`: px of the list above the screen's top
// (negative while it starts lower down); rows `height` px each. → { reached, from, to } (drawn: from..to-1)
export function afterScroll({ count, reached, top, height, viewport, step = STEP, buffer = BUFFER, keep = KEEP, margin = MARGIN }) {
    const seen = Math.max(0, top);
    const firstInView = Math.floor(seen / height);
    const lastInView = Math.ceil((seen + viewport) / height);
    // The end of what is reached is in view (near enough): fifteen more.
    let next = Math.min(count, reached);
    if (next < count && (seen + viewport + margin) / height >= next) next = Math.min(count, next + step);
    let from = Math.max(0, firstInView - buffer);
    const to = Math.min(next, Math.max(lastInView + buffer, from + keep));
    from = Math.max(0, Math.min(from, to - keep));
    return { reached: next, from, to };
}

export function registerWindowRows(juris) {
    juris.registerComponent("WindowRows", ({ id, count = 0, row, tag = "tbody", columns = 1, className = "" }, api) => {
        const [span, setSpan] = api.useState("span", { reached: Math.min(count, START), from: 0, to: Math.min(count, START) });
        let height = 36;
        const more = () => {
            const { reached, from } = span();
            if (reached >= count) return;
            const next = Math.min(count, reached + STEP);
            setSpan({ reached: next, from: Math.max(from, next - KEEP - BUFFER), to: next });
        };
        if (!api.isServer) {
            api.onMount(() => {
                const list = globalThis.document?.getElementById(id);
                if (!list) return undefined;
                // The list scrolls with what holds it: the tab it is in (the one area that scrolls), a panel
                // that scrolls itself (.win-scroll: the top bar's person switch), or the page where there
                // are neither (the sign-in page).
                const box = list.closest(".tabbody, .win-scroll");
                const page = !box;
                const target = page ? globalThis : box;
                let pending = null;
                const update = () => {
                    pending = null;
                    const drawn = list.querySelectorAll(":scope > [data-row]");
                    if (!drawn.length) return;
                    // The rows' height, from those drawn (they may wrap): the spacers are drawn by it.
                    if (drawn.length > 1) { const h = (drawn[drawn.length - 1].getBoundingClientRect().bottom - drawn[0].getBoundingClientRect().top) / drawn.length; if (h > 4) height = h; }
                    // How far the rows are scrolled up past the top of what shows them, and how much it shows.
                    const top = (page ? 0 : box.getBoundingClientRect().top) - list.getBoundingClientRect().top;
                    const now = span();
                    const next = afterScroll({ count, reached: now.reached, top, height, viewport: (page ? globalThis.innerHeight : box.clientHeight) || 600 });
                    if (next.from !== now.from || next.to !== now.to || next.reached !== now.reached) setSpan(next);
                };
                // Only what the person does there moves it: a scroll, or a wheel or swipe down when there is
                // nothing left to scroll.
                const later = () => { if (!pending) pending = setTimeout(update, 16); };
                const down = (e) => { if (e.type !== "wheel" || e.deltaY > 0) later(); };
                target.addEventListener("scroll", later, { passive: true });
                target.addEventListener("wheel", down, { passive: true });
                target.addEventListener("touchmove", later, { passive: true });
                return () => {
                    clearTimeout(pending);
                    target.removeEventListener("scroll", later);
                    target.removeEventListener("wheel", down);
                    target.removeEventListener("touchmove", later);
                };
            });
        }
        const table = tag === "tbody";
        const cell = (key, attrs, children) => (table ? { tr: { key, ...attrs, children: [{ td: { colSpan: columns, children } }] } } : { div: { key, ...attrs, children } });
        return {
            [tag]: {
                id, className,
                children: () => {
                    const { reached, from, to } = span();
                    const rows = [];
                    for (let i = from; i < Math.min(to, count); i++) {
                        const r = row(i);
                        const root = r && Object.keys(r)[0];
                        if (root) r[root]["data-row"] = String(i);
                        rows.push(r);
                    }
                    // Rows reached but not drawn, above and below: spacers of their height keep the scroll
                    // where it is.
                    const spacer = (key, n) => (table
                        ? { tr: { key, className: "win-spacer", "aria-hidden": "true", children: [{ td: { colSpan: columns, style: `height:${Math.round(n * height)}px` } }] } }
                        : { div: { key, className: "win-spacer", "aria-hidden": "true", style: `height:${Math.round(n * height)}px` } });
                    const end = reached < count
                        ? cell("more", { className: "win-more" }, [{ span: { className: "muted small", textContent: `${reached} of ${count}: scroll for more ` } }, { button: { type: "button", className: "linkish", textContent: "show more", onclick: more } }])
                        : (table ? { tr: { key: "more", className: "win-spacer", children: [{ td: { colSpan: columns } }] } } : { span: { key: "more" } });
                    return [spacer("above", from), ...rows, spacer("below", Math.max(0, reached - to)), end];
                },
            },
        };
    });
}
