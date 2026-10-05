// A drawing's zoom (canvas-zoom.js): steps that come back where they were, its bounds, and the point
// under the pointer kept in place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ZOOM, clampZoom, stepZoom, scrollAround } from "../client/canvas-zoom.js";

test("steps from 100% by a quarter, in and out again back where it was, within its bounds", () => {
    assert.equal(stepZoom(1, 1), 1.25);
    assert.equal(stepZoom(1.25, -1), 1);
    assert.equal(stepZoom(1, -1), 0.8);
    // From a fitted width between steps: to the next step each way, never stuck where it is.
    assert.equal(stepZoom(0.9, 1), 1);
    assert.equal(stepZoom(0.9, -1), 0.8);
    let z = 1;
    for (let i = 0; i < 20; i++) z = stepZoom(z, 1);
    assert.equal(z, ZOOM.max);
    for (let i = 0; i < 40; i++) z = stepZoom(z, -1);
    assert.equal(z, ZOOM.min);
    assert.equal(clampZoom(9), ZOOM.max);
    assert.equal(clampZoom(0.01), ZOOM.min);
});

test("the point under the pointer stays there: the panel scrolls with the drawing's growth", () => {
    // Pointer 100px into a panel scrolled 200px; twice the size: that drawing point (300) is now at 600.
    assert.deepEqual(scrollAround({ left: 200, top: 0, x: 100, y: 50, ratio: 2 }), { left: 500, top: 50 });
    // Smaller again: back, and never scrolled before the drawing's start.
    assert.deepEqual(scrollAround({ left: 500, top: 50, x: 100, y: 50, ratio: 0.5 }), { left: 200, top: 0 });
    assert.deepEqual(scrollAround({ left: 0, top: 0, x: 10, y: 10, ratio: 0.5 }), { left: 0, top: 0 });
});
