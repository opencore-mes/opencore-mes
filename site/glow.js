// The landing page's own script (index.html), nothing else: no requests, no storage, nothing from elsewhere.

// The phone's menu (details.menu) opens without a script; a section picked, or a tap elsewhere, closes it.
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
