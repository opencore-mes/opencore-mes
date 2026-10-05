// Lists drawn a few rows at a time (window-rows.js): fifteen reached at first, fifteen more only as the
// person scrolls to the end of them; of what is reached, the rows in view and fifteen either side drawn,
// at least thirty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { afterScroll, START, STEP, BUFFER, KEEP } from "../client/window-rows.js";

const at = (reached, top, count = 30000) => afterScroll({ count, reached, top, height: 40, viewport: 800 });

test("fifteen at first; fifteen more only when the end of them comes into view", () => {
    assert.deepEqual([START, STEP, BUFFER, KEEP], [15, 15, 15, 30]);
    // 15 rows are 600 px, the screen 800: their end is in view, but nothing moves until the person
    // scrolls (the component asks only then); asked, fifteen more.
    assert.deepEqual(at(15, 0), { reached: 30, from: 0, to: 30 });
    // Thirty reached and the end well below the screen: nothing more.
    assert.deepEqual(at(60, 0), { reached: 60, from: 0, to: 35 });
    // Never past the end.
    assert.deepEqual(at(15, 0, 20), { reached: 20, from: 0, to: 20 });
});

test("however far scrolled, a window of what is in view and fifteen either side is drawn", () => {
    // Row 1000 at the top of the screen, 3000 reached: rows 985 to 1035 drawn (20 in view, 15 either side).
    assert.deepEqual(at(3000, 40000), { reached: 3000, from: 985, to: 1035 });
    // Back at the top: the rows below are let go again.
    assert.deepEqual(at(3000, 0), { reached: 3000, from: 0, to: 35 });
    // At least thirty, when the window would be smaller (a tall screen of few rows near the end).
    const end = afterScroll({ count: 100, reached: 100, top: 3960, height: 40, viewport: 40 });
    assert.equal(end.to - end.from, KEEP);
    assert.equal(end.to, 100);
});
