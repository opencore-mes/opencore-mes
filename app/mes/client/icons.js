// The icons (DESIGN.md §10.7): SVG, as data. Each is a few path strings on a 24×24 grid, drawn with
// the text's own colour (currentColor) at the text's size (1em), so an icon follows light and dark,
// a disabled button, a coloured chip, without a stylesheet of its own. No emoji, no symbol font: those
// draw differently on every system and some not at all. A suite (§29) brings its own the same way.
//
//   icon("bell")                              decorative: hidden from screen readers
//   icon("lock", { label: "Read only" })      meaningful on its own: named for screen readers
//   withIcon("check", "Approved")             an icon and its words, as one inline group
//
// The icons are drawn here; see the README for their names. Filled ones (a star chosen, a dot) say so.

const S = (d) => ({ d });                    // a stroked path
const F = (d) => ({ d, fill: true });       // a filled path
const C = (cx, cy, r, fill = false) => ({ circle: { cx, cy, r }, fill });

export const ICONS = {
    bell: [S("M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"), S("M10.3 21a1.94 1.94 0 0 0 3.4 0")],
    calendar: [S("M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"), S("M16 2v4M8 2v4M3 10h18")],
    archive: [S("M3 3h18v5H3z"), S("M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"), S("M10 12h4")],
    users: [C(9, 7, 4), S("M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"), S("M16 3.13a4 4 0 0 1 0 7.75"), S("M22 21v-2a4 4 0 0 0-3-3.87")],
    lock: [S("M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z"), S("M7 11V7a5 5 0 0 1 10 0v4")],
    more: [C(5, 12, 1.6, true), C(12, 12, 1.6, true), C(19, 12, 1.6, true)],
    copy: [S("M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z"), S("M16 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3")],
    hourglass: [S("M5 2h14M5 22h14"), S("M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4a2 2 0 0 0 .6-1.4V2"), S("M7 22v-4.2a2 2 0 0 1 .6-1.4L12 12l4.4 4.4a2 2 0 0 1 .6 1.4V22")],
    check: [S("M20 6 9 17l-5-5")],
    x: [S("M18 6 6 18M6 6l12 12")],
    trash: [S("M3 6h18"), S("M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"), S("M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"), S("M10 11v6M14 11v6")],
    pencil: [S("M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"), S("M15 5l4 4")],
    sparkle: [F("M12 2.5l1.9 6.6 6.6 1.9-6.6 1.9L12 19.5l-1.9-6.6L3.5 11l6.6-1.9z"), F("M19 15.5l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7z")],
    arrowUp: [S("M12 19V5M5 12l7-7 7 7")],
    arrowDown: [S("M12 5v14M19 12l-7 7-7-7")],
    arrowRight: [S("M5 12h14M12 5l7 7-7 7")],
    chevronLeft: [S("M15 18l-6-6 6-6")],
    chevronRight: [S("M9 18l6-6-6-6")],
    chevronDown: [S("M6 9l6 6 6-6")],
    star: [S("M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z")],
    starFilled: [F("M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z")],
    dot: [C(12, 12, 5, true)],
    circle: [C(12, 12, 5)],
    warning: [S("M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"), S("M12 9v4M12 17h.01")],
    info: [C(12, 12, 10), S("M12 16v-4M12 8h.01")],
    undo: [S("M9 14 4 9l5-5"), S("M4 9h10.5a5.5 5.5 0 0 1 0 11H11")],
    refresh: [S("M21 12a9 9 0 1 1-2.6-6.4"), S("M21 3v6h-6")],
    // A file attached (§34.10): a paper clip; a document.
    attach: [S("M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9")],
    file: [S("M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"), S("M14 3v6h6")],
    scan: [S("M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"), S("M7 8v8M10 8v8M14 8v8M17 8v8")],
    split: [S("M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"), S("M12 3v18")],
    play: [F("M7 4.5v15l12-7.5z")],
    camera: [S("M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"), C(12, 13, 3)],
    upload: [S("M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"), S("M17 8l-5-5-5 5M12 3v12")],
    // Sign out: out of the door.
    logout: [S("M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"), S("M16 17l5-5-5-5M21 12H9")],
    minus: [S("M5 12h14")],
    chart: [S("M4 20V10M10 20V4M16 20v-7M22 20H2")],
    database: [S("M4 6c0-1.66 3.58-3 8-3s8 1.34 8 3-3.58 3-8 3-8-1.34-8-3z"), S("M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6"), S("M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6")],
    sun: [C(12, 12, 4), S("M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4")],
    moon: [S("M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z")],
    monitor: [S("M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"), S("M8 20h8M12 16v4")],
    maximize: [S("M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3")],
    minimize: [S("M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3")],
    plus: [S("M12 5v14M5 12h14")],
    // The Flow designer's node kinds (§32.7): a step, a branch, a person's choice, a form, a template
    // inside another, the end.
    steps: [S("M5 6l6 6-6 6M13 6l6 6-6 6")],
    branch: [C(6, 5, 2), C(6, 19, 2), C(18, 7, 2), S("M6 7v10"), S("M18 9c0 4-3 6-7 6H8")],
    personChoice: [C(9, 7, 4), S("M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"), S("M16 11l2 2 4-4")],
    form: [S("M9 3h6v3H9z"), S("M8 4.5H6a2 2 0 0 0-2 2V20a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6.5a2 2 0 0 0-2-2h-2"), S("M8 12h8M8 16h5")],
    subflow: [S("M4 3h11a1 1 0 0 1 1 1v6"), S("M3 4v10a1 1 0 0 0 1 1h4"), S("M10 10h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z")],
    flag: [S("M5 22V3"), S("M5 4h13l-3 4.5 3 4.5H5")],
    // A panel's guide (§33).
    help: [C(12, 12, 10), S("M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"), S("M12 17h.01")],
    // A report layout (§34.5): places on a page.
    layout: [S("M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"), S("M3 9h18"), S("M12 9v12")],
};

const ATTRS = { viewBox: "0 0 24 24", width: "1em", height: "1em", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", focusable: "false" };

// An icon, as a Juris node. `label`: what it means when nothing beside it says (a lone button's
// icon, an indicator); without one it is decoration, hidden from screen readers.
export function icon(name, { label = null, className = "" } = {}) {
    const parts = ICONS[name] ?? ICONS.info;
    return {
        svg: {
            ...ATTRS,
            className: `icon icon-${name}${className ? ` ${className}` : ""}`,
            ...(label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" }),
            children: [
                ...(label ? [{ title: label }] : []),
                ...parts.map((p) => (p.circle
                    ? { circle: { ...p.circle, ...(p.fill ? { fill: "currentColor", stroke: "none" } : {}) } }
                    : { path: { d: p.d, ...(p.fill ? { fill: "currentColor", stroke: "none" } : {}) } })),
            ],
        },
    };
}

// An icon and its words, as one inline group: [icon] Approved.
export const withIcon = (name, text, { className = "" } = {}) => ({ span: { className: `icon-text${className ? ` ${className}` : ""}`, children: [icon(name), { span: text }] } });
