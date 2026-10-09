// How long a password link lasts (§8.2): the plant's PASSWORD_LINK_DAYS, 1 to 14 days, 3 unless set. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkDaysOf, LINK_DAYS, LINK_MAX_DAYS } from "../server/sign-in.js";

test("the plant's default for a password link, in days", () => {
    assert.equal(linkDaysOf({}), LINK_DAYS);
    assert.equal(LINK_DAYS, 3);
    assert.equal(linkDaysOf({ PASSWORD_LINK_DAYS: "7" }), 7);
    assert.equal(linkDaysOf({ PASSWORD_LINK_DAYS: String(LINK_MAX_DAYS) }), 14);
    for (const bad of ["0", "15", "2.5", "a week"]) assert.throws(() => linkDaysOf({ PASSWORD_LINK_DAYS: bad }), /PASSWORD_LINK_DAYS is a whole number of days, 1 to 14/, bad);
});
