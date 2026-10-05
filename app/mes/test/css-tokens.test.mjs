// The colour tokens (app.css): every one a value in each scheme. A token defined as itself
// (`--ok-soft: var(--ok-soft)`) is invalid, and whatever it colours falls back to black.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../client/app.css", import.meta.url), "utf8");

test("no token is defined as itself", () => {
    const loops = [...css.matchAll(/(--[a-z0-9-]+)\s*:\s*var\(\s*(--[a-z0-9-]+)\s*[,)]/g)].filter(([, a, b]) => a === b).map(([line]) => line);
    assert.deepEqual(loops, []);
});

test("the soft tones the flow canvas and notices use are defined for the light scheme", () => {
    const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
    for (const t of ["--ok-soft", "--warn-soft", "--warn-ink", "--accent-soft", "--danger-soft"]) assert.match(root, new RegExp(`${t}:\\s*#[0-9a-f]{6};`), t);
});
