// Themes (DESIGN.md §10.8), without a database: the plant theme's checks (its shape; never how a colour reads), the CSS it writes, the scheme
// a page is drawn in, a state's tone in a design, and the stylesheet's own rules. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { themeProblems, themeCss, schemeOf, personalChoice, stateBadgeClass } from "../client/theme.js";
import { validateDefinition } from "../client/definition.js";
import { definitions } from "../db/seed.mjs";

test("a plant theme's mistakes are named; how a colour reads is never one of them (the plant chooses)", () => {
    assert.deepEqual(themeProblems(undefined), []);
    assert.deepEqual(themeProblems({ scheme: "dark", name: "Plant 1", scope: "Lyon", colors: { light: { accent: "#1d4ed8" }, dark: { ok: "#6ee7b7" } } }), []);
    const m = themeProblems({ scheme: "dim", font: "x", name: "x".repeat(41), colors: { light: { accent: "#ffff00", pink: "#ff00ff", ok: "green" }, sepia: {} } }).join("\n");
    assert.doesNotMatch(m, /reads at|accent text/);
    for (const expected of [/scheme is "choice".*not "dim"/, /"font" is not scheme/, /name is text, at most 40/, /"pink" is not one of/, /light ok is a colour as #rrggbb, not "green"/, /for light and dark, not "sepia"/]) {
        assert.match(m, expected);
    }
});

test("the CSS it writes holds only checked colours, under the stylesheet's selectors", () => {
    assert.equal(themeCss({}), "");
    const css = themeCss({ colors: { light: { accent: "#1D4ED8", warn: "#fff;}body{display:none" }, dark: { ok: "#6ee7b7" } } });
    assert.match(css, /^:root\{--accent:#1d4ed8;--accent-soft:#[0-9a-f]{6};\}/);
    assert.ok(!css.includes("display:none") && !css.includes("--warn"), "anything but #rrggbb is never written");
    assert.match(css, /@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\)\{--ok:#6ee7b7;/);
    assert.match(css, /:root\[data-theme="dark"\]\{--ok:#6ee7b7;/);
});

test("the top bar's colours: everything in the bar drawn from the two, its text automatic when not given, its dialogs the page's", () => {
    assert.deepEqual(themeProblems({ colors: { light: { header: "#0b3d91", headerInk: "#ffffff" } } }), []);
    // Pale on pale is the plant's to choose.
    assert.deepEqual(themeProblems({ colors: { dark: { header: "#ffffff", headerInk: "#eeeeee" } } }), []);
    // A background alone is enough: its text white or dark, whichever stands out on it (white on navy, dark on yellow).
    assert.deepEqual(themeProblems({ colors: { light: { header: "#0b3d91" } } }), []);
    assert.match(themeCss({ colors: { light: { header: "#0b3d91" } } }), /\.topbar\{--panel:#0b3d91;--bg:#0b3d91;--ink:#ffffff;/);
    assert.match(themeCss({ colors: { light: { header: "#ffcc00" } } }), /--ink:#1d2230;/);
    const css = themeCss({ colors: { light: { header: "#0B3D91", headerInk: "#ffffff", accent: "#1d4ed8" }, dark: { header: "#000;}*{x" } } });
    assert.match(css, /\.topbar\{--panel:#0b3d91;--bg:#0b3d91;--ink:#ffffff;--muted:#[0-9a-f]{6};[^}]*background:#0b3d91;color:#ffffff;\}/);
    assert.ok(!css.includes("*{x") && !/data-theme="dark"\] \.topbar/.test(css), "a dark bar not #rrggbb is never written: dark keeps the light one's");
    assert.match(css, /\.topbar \[role=dialog\]\{--panel:var\(--page-panel\);[^}]*color:var\(--ink\);\}/);
    assert.match(themeCss({ colors: { dark: { header: "#101820", headerInk: "#f0f0f0" } } }), /@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\) \.topbar\{--panel:#101820;[^}]*\}\}:root\[data-theme="dark"\] \.topbar\{--panel:#101820;/);
});

test("the scheme a page is drawn in: the plant's when it decides, else the person's, else the device's", () => {
    assert.equal(schemeOf({ scheme: "dark" }, "light"), "dark");
    assert.equal(schemeOf({ scheme: "light" }, "dark"), "light");
    assert.equal(schemeOf({ scheme: "choice" }, "dark"), "dark");
    assert.equal(schemeOf({}, "light"), "light");
    assert.equal(schemeOf({}, "system"), null);
    assert.equal(schemeOf(undefined, undefined), null);
    assert.equal(personalChoice({ scheme: "dark" }), false);
    assert.equal(personalChoice({}), true);
});

test("a state's tone is part of its object's design, checked like the rest of it", () => {
    const lot = definitions.find((d) => d.object === "lot");
    assert.equal(stateBadgeClass("on_hold", lot.states.tones), "badge s-on_hold tone-warn");
    assert.equal(stateBadgeClass("created", lot.states.tones), "badge s-created");
    const known = { objects: definitions.map((d) => d.object), scripts: [], transactions: [], departments: ["production", "quality", "engineering"] };
    const bad = { ...lot, states: { ...lot.states, tones: { on_hold: "amber", nowhere: "ok" } } };
    const m = validateDefinition(bad, known).filter((p) => p.path === "states.tones").map((p) => p.message).join("\n");
    assert.match(m, /Tone of on_hold: one of neutral, info, ok, warn, danger, not "amber"/);
    assert.match(m, /Tone of "nowhere": not a state/);
});

test("the stylesheet: one set of dark tokens under both selectors, and no state's name", () => {
    const css = readFileSync(new URL("../client/app.css", import.meta.url), "utf8");
    const decls = (body) => body.split(/;\s*/).map((s) => s.trim()).filter(Boolean);
    const byDevice = decls(css.match(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\}\n\}/)[1]);
    const forced = decls(css.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/)[1]);
    assert.deepEqual(forced, byDevice, "the two dark blocks hold the same tokens");
    // A state is the plant's word (everything is a definition): the stylesheet colours tones, not states.
    for (const state of definitions.flatMap((d) => d.states.list)) assert.ok(!css.includes(`.badge.s-${state}`), `app.css names the state ${state}`);
});
