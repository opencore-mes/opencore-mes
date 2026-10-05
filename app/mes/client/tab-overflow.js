// Tab bars that never scroll and never wrap: the tabs that fit are drawn whole, the rest are in a
// "more" dropdown at the bar's end, and the open tab is always among those drawn. One rule for every tab bar: the shell's open tabs, the designer's tabs, an editor's and a
// record's sub-tabs, a form's tabs.
//
// Browser only, started once (boot.js). It adds one element of its own to a bar that overflows (the
// "more" control, kept at the bar's end) and marks the tabs that are out (`data-overflow`, which the
// stylesheet hides); a mark the renderer drops is put back at the next measure. It follows what is drawn (a MutationObserver) and the bar's
// width (a ResizeObserver).
const BARS = ".tabs, .design-tabs, .subtabs, .form-tabs";
const tabsOf = (bar) => [...bar.querySelectorAll(":scope > button, :scope > a, :scope > .tab-list > .tab")].filter((el) => !el.classList.contains("tab-more-btn"));
const isOpen = (tab) => tab.classList.contains("active") || tab.getAttribute("aria-selected") === "true";
// A tab's words for the dropdown: its label, and its count beside it ("Objects (17)"), without the
// marks drawn on it (a close button, a dot).
function wordsOf(tab) {
    const copy = (tab.querySelector(".tab-link") ?? tab).cloneNode(true);
    const count = copy.querySelector(".tab-count, .tab-diff")?.textContent.trim();
    for (const el of copy.querySelectorAll(".tab-count, .tab-diff, .tab-open, .tab-close, svg")) el.remove();
    const label = copy.textContent.replace(/\s+/g, " ").trim();
    return count ? `${label} (${count})` : label;
}
const go = (tab) => (tab.querySelector(".tab-link") ?? tab).click();

let menu = null; // the open dropdown, one at a time: { el, bar }
function closeMenu() {
    if (!menu) return;
    menu.el.remove();
    menu.bar.querySelector(":scope > .tab-more .tab-more-btn")?.setAttribute("aria-expanded", "false");
    menu = null;
}
function openMenu(bar, button, hidden) {
    closeMenu();
    const el = document.createElement("div");
    el.className = "tab-more-menu";
    el.setAttribute("role", "menu");
    for (const tab of hidden) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "tab-more-item";
        item.setAttribute("role", "menuitem");
        item.textContent = wordsOf(tab);
        item.addEventListener("click", () => { closeMenu(); go(tab); });
        el.append(item);
    }
    document.body.append(el);
    const at = button.getBoundingClientRect();
    el.style.top = `${Math.round(at.bottom + 4)}px`;
    el.style.left = `${Math.round(Math.max(8, Math.min(at.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 8)))}px`;
    button.setAttribute("aria-expanded", "true");
    menu = { el, bar };
    el.querySelector("button")?.focus();
}

// Whole tabs only: a tab is drawn in full or it is in the dropdown, never cut by the bar's edge. The
// tabs are kept from the first, in their order, for as long as they fit beside the "more" control; the
// open tab is kept whatever its place. Nothing is scrolled.
const OUT = "data-overflow";
const outOfSight = (bar) => tabsOf(bar).filter((tab) => tab.hasAttribute(OUT));
const mark = (tab, out) => { if (out !== tab.hasAttribute(OUT)) { if (out) tab.setAttribute(OUT, ""); else tab.removeAttribute(OUT); } };

function fit(bar) {
    const tabs = tabsOf(bar);
    let more = bar.querySelector(":scope > .tab-more");
    if (bar.scrollLeft) bar.scrollLeft = 0;
    // Measured with every tab drawn (nothing is painted between this and the marks below).
    const was = tabs.map((tab) => tab.hasAttribute(OUT));
    for (const tab of tabs) tab.removeAttribute(OUT);
    const style = getComputedStyle(bar);
    const holder = tabs[0]?.parentElement ?? bar;
    const gap = parseFloat(getComputedStyle(holder).columnGap) || 0;
    const room = bar.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const widths = tabs.map((tab) => tab.getBoundingClientRect().width);
    const all = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, tabs.length - 1);
    if (tabs.length < 2 || all <= room + 0.5) {
        if (more) { if (menu?.bar === bar) closeMenu(); more.remove(); }
        return;
    }
    if (!more) {
        more = document.createElement("span");
        more.className = "tab-more";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "tab-more-btn";
        button.setAttribute("aria-haspopup", "menu");
        button.setAttribute("aria-expanded", "false");
        button.addEventListener("click", (e) => {
            e.stopPropagation();
            if (menu?.bar === bar) closeMenu(); else openMenu(bar, button, outOfSight(bar));
        });
        more.append(button);
    }
    // Kept last, whatever the renderer drew after it.
    if (bar.lastElementChild !== more) bar.append(more);
    const button = more.firstElementChild;
    // Its room is taken for as many digits as there are tabs, so the count never moves a tab out.
    const widest = `${"8".repeat(String(tabs.length).length)} more`;
    if (button.textContent !== widest) button.textContent = widest;
    const left = room - more.getBoundingClientRect().width - gap;
    const open = tabs.findIndex(isOpen);
    let used = open >= 0 ? widths[open] : 0;
    const keep = new Set(open >= 0 ? [open] : []);
    for (let i = 0; i < tabs.length; i++) {
        if (i === open) continue;
        if (used + gap + widths[i] > left) break;
        used += gap + widths[i];
        keep.add(i);
    }
    tabs.forEach((tab, i) => mark(tab, !keep.has(i)));
    const words = `${tabs.length - keep.size} more`;
    if (button.textContent !== words) button.textContent = words;
    // The dropdown, if it is open, follows what is now out of sight.
    if (menu?.bar === bar && was.some((w, i) => w !== !keep.has(i))) closeMenu();
}

let queued = false;
let observer = null;
const fitAll = () => {
    queued = false;
    for (const bar of document.querySelectorAll(BARS)) { watch(bar); fit(bar); }
    if (menu && !document.body.contains(menu.bar)) closeMenu();
    // What this pass changed itself (its marks, its control) is not a reason to measure again.
    observer?.takeRecords();
};
// (A timer, not an animation frame: a frame never comes while the page is not being painted, and
// the bars must be right the moment it is.)
const soon = () => { if (!queued) { queued = true; setTimeout(fitAll, 30); } };
const widths = typeof ResizeObserver === "function" ? new ResizeObserver(soon) : null;
const watched = new WeakSet();
function watch(bar) {
    if (watched.has(bar) || !widths) return;
    watched.add(bar);
    widths.observe(bar);
}

let started = false;
export function startTabOverflow() {
    if (started || typeof document === "undefined") return;
    started = true;
    observer = new MutationObserver(soon);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "aria-selected", OUT], characterData: true });
    window.addEventListener("resize", soon);
    document.addEventListener("click", (e) => { if (menu && !e.target.closest?.(".tab-more-menu")) closeMenu(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menu) { const bar = menu.bar; closeMenu(); bar.querySelector(":scope > .tab-more .tab-more-btn")?.focus(); } });
    document.fonts?.ready?.then(soon);
    soon();
}
