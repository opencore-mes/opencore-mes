// The site's own script (every page), nothing else: no requests, no storage, nothing from elsewhere.

// The menu (details.menu) opens without a script; a section picked, or a tap elsewhere, closes it.
addEventListener("click", (e) => {
    const menu = document.querySelector("details.menu[open]");
    if (menu && (e.target.closest("a") || !menu.contains(e.target))) menu.open = false;
});

// The pointer light (body::before, a card's ::before): where the pointer is, as CSS variables, at most once
// a frame. Not for touch screens (no pointer to follow) nor for anyone who asked for less motion.
(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !matchMedia("(pointer: fine)").matches) return;
    const root = document.documentElement;
    let frame = 0, x = 0, y = 0, target = null;
    addEventListener("pointermove", (e) => {
        x = e.clientX; y = e.clientY; target = e.target;
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            root.style.setProperty("--mx", `${x}px`);
            root.style.setProperty("--my", `${y}px`);
            const card = target instanceof Element ? target.closest(".card, .edition, .stat") : null;
            if (!card) return;
            const r = card.getBoundingClientRect();
            card.style.setProperty("--cx", `${x - r.left}px`);
            card.style.setProperty("--cy", `${y - r.top}px`);
        });
    }, { passive: true });
    // Gone from the page: the light with it.
    document.documentElement.addEventListener("pointerleave", () => root.style.setProperty("--my", "-40%"));
})();

// Blocks rise into place as they come into view (.reveal in index.html). Only those below the fold when the page
// opens are hidden, so nothing on screen flashes; each is shown once it is reached, those reached together one
// after another; then the marks go, and a card's own hover is its own again. Nothing for anyone who asked for
// less motion, nor where the browser cannot tell what is in view.
(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    const BLOCKS = "main :is(h2, .eyebrow, .sub, .in-demo, .card, .stat, .edition, .shot, .mock, .screens, .rule-mock, .fl-mock, .cta, .stats, .live-points > li, .checks > li, .points > li, .grid3 > *)";
    const fold = innerHeight;
    const all = [...document.querySelectorAll(BLOCKS)];
    // A block inside another that rises does not rise twice.
    const blocks = all.filter((el) => !all.some((o) => o !== el && o.contains(el)) && el.getBoundingClientRect().top > fold * 0.92);
    const settle = (el) => { el.classList.remove("reveal", "in"); el.style.removeProperty("--rd"); };
    const seen = new IntersectionObserver((entries) => {
        const reached = entries.filter((e) => e.isIntersecting).map((e) => e.target)
            .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        reached.forEach((el, i) => {
            seen.unobserve(el);
            el.style.setProperty("--rd", `${Math.min(i, 6) * 80}ms`);
            requestAnimationFrame(() => el.classList.add("in"));
            el.addEventListener("transitionend", (e) => { if (e.target === el && e.propertyName === "transform") settle(el); }, { once: false });
            setTimeout(() => settle(el), 1600 + Math.min(i, 6) * 80); // whatever happens to the transition
        });
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.06 });
    for (const el of blocks) { el.classList.add("reveal"); seen.observe(el); }
})();

