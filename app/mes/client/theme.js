// Themes (DESIGN.md §10.8): how the plant's pages look, as data, shared by the browser (the Theme tab's
// preview and checks, the person's choice) and the server (the check of a change, the page's head).
//
//   The plant's theme (People & departments → Theme, approved like the formats, §27.6):
//     { scheme: "choice" | "light" | "dark", name, scope, colors: { light: {…}, dark: {…} } }
//     scheme   "choice" lets each person pick light or dark (or follow their system); "light" or "dark"
//              is the plant's, for everyone, and nobody is offered a choice (a shop floor's screens)
//     name     the top bar's name (OpenCore MES when not given); scope, the label beside it
//     colors   per scheme, any of accent, ok, warn, danger, as #rrggbb; each one's soft background is
//              worked out from it, and every one is checked for contrast before it can be approved
//   A person's choice (prefs.scheme): "system" (the default), "light" or "dark".
//
// A tone is how a value is coloured, by meaning, never by a colour: a state's tone (on_hold: warn) is
// part of its object's design (states.tones), and the theme decides what each tone looks like.

export const TONES = ["neutral", "info", "ok", "warn", "danger"];
export const SCHEMES = ["choice", "light", "dark"];
export const PERSONAL = ["system", "light", "dark"];
export const THEME_COLORS = ["accent", "ok", "warn", "danger"];

// The defaults (app.css's tokens), for the checks and the Theme tab's preview.
export const DEFAULTS = {
    light: { bg: "#f6f7f9", panel: "#ffffff", ink: "#1d2230", onFill: "#ffffff", accent: "#2b303a", ok: "#067647", warn: "#b54708", danger: "#b42318" },
    dark: { bg: "#12151c", panel: "#1a1e27", ink: "#e6e8ee", onFill: "#12151c", accent: "#d5d9e0", ok: "#5dd39e", warn: "#f5b76b", danger: "#ff8a7a" },
};
const SOFT = { light: 0.12, dark: 0.18 };   // how much of a colour its soft background holds
const AA = 4.5;                             // WCAG 2 AA, normal text

const HEX = /^#[0-9a-f]{6}$/i;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

// `t` of `a` over `b`.
export const mix = (a, b, t) => toHex(rgb(a).map((v, i) => v * t + rgb(b)[i] * (1 - t)));

// WCAG 2 contrast ratio of two colours, 1 to 21.
export function contrast(a, b) {
    const lum = (hex) => {
        const [r, g, bl] = rgb(hex).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

// A colour's soft background, in a scheme (a badge's, a notice's).
export const soft = (scheme, color) => mix(color, DEFAULTS[scheme].panel, SOFT[scheme]);

// The checks a colour must pass, in a scheme: as text on a panel, as a badge's text on its soft
// background, and (the accent and the strong tones, which fill buttons and counts) behind their text.
export function colorChecks(scheme, name, color) {
    const d = DEFAULTS[scheme];
    return [
        { what: `${name} text on a panel`, ratio: contrast(color, d.panel) },
        { what: `${name} on its own soft background`, ratio: contrast(color, soft(scheme, color)) },
        { what: `text on the ${name} fill`, ratio: contrast(d.onFill, color) },
    ].map((c) => ({ ...c, ok: c.ratio >= AA }));
}

// A plant theme's problems, in words: [string].
export function themeProblems(theme) {
    if (theme === undefined || theme === null) return [];
    if (!isPlain(theme)) return ["A theme is { scheme, name, scope, colors }."];
    const out = [];
    for (const k of Object.keys(theme)) if (!["scheme", "name", "scope", "colors"].includes(k)) out.push(`Theme: "${k}" is not scheme, name, scope or colors.`);
    if (theme.scheme !== undefined && !SCHEMES.includes(theme.scheme)) out.push(`Theme: the scheme is "choice" (each person picks), "light" or "dark", not "${theme.scheme}".`);
    for (const k of ["name", "scope"]) {
        if (theme[k] !== undefined && (typeof theme[k] !== "string" || theme[k].length > 40)) out.push(`Theme: the ${k} is text, at most 40 characters.`);
    }
    if (theme.colors === undefined) return out;
    if (!isPlain(theme.colors)) return [...out, "Theme: colors are { light: { accent, ok, warn, danger }, dark: { … } }."];
    for (const [scheme, colors] of Object.entries(theme.colors)) {
        if (!["light", "dark"].includes(scheme)) { out.push(`Theme: colors are for light and dark, not "${scheme}".`); continue; }
        if (!isPlain(colors)) { out.push(`Theme: the ${scheme} colors are { accent, ok, warn, danger }.`); continue; }
        for (const [name, color] of Object.entries(colors)) {
            if (!THEME_COLORS.includes(name)) { out.push(`Theme: "${name}" is not one of ${THEME_COLORS.join(", ")}.`); continue; }
            if (typeof color !== "string" || !HEX.test(color)) { out.push(`Theme: ${scheme} ${name} is a colour as #rrggbb, not "${color}".`); continue; }
            for (const c of colorChecks(scheme, name, color)) {
                if (!c.ok) out.push(`Theme: in ${scheme}, ${c.what} reads at ${c.ratio.toFixed(1)}:1, below the ${AA}:1 people need to read it; choose a ${scheme === "light" ? "darker" : "lighter"} ${name}.`);
            }
        }
    }
    return out;
}

// The scheme a page is drawn in: the plant's when it decides, else the person's; null to follow the
// device (the stylesheet's own prefers-color-scheme).
export function schemeOf(theme, personal) {
    if (theme?.scheme === "light" || theme?.scheme === "dark") return theme.scheme;
    return personal === "light" || personal === "dark" ? personal : null;
}
export const personalChoice = (theme) => !(theme?.scheme === "light" || theme?.scheme === "dark");

// The plant's colours as the stylesheet's tokens: a light block, and the dark one under the same two
// selectors app.css uses (the device in dark, not forced light; or forced dark). Only colours that pass
// the shape check are written, so nothing but #rrggbb ever reaches the page's CSS.
export function themeCss(theme) {
    const block = (scheme) => Object.entries(theme?.colors?.[scheme] ?? {})
        .filter(([name, color]) => THEME_COLORS.includes(name) && typeof color === "string" && HEX.test(color))
        .map(([name, color]) => `--${name}:${color.toLowerCase()};--${name}-soft:${soft(scheme, color)};`).join("");
    const light = block("light");
    const dark = block("dark");
    return [
        light ? `:root{${light}}` : "",
        dark ? `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}:root[data-theme="dark"]{${dark}}` : "",
    ].join("");
}

// A state's tone in an object's design, or "" (the badge's own look).
export const toneOf = (tones, state) => (isPlain(tones) && TONES.includes(tones[state]) ? tones[state] : "");
// A state as a badge: its tone's colours when its design gives one.
export const stateBadgeClass = (state, tones) => `badge s-${state}${toneOf(tones, state) ? ` tone-${toneOf(tones, state)}` : ""}`;
