// The sign-in id as the plant calls it (§8.2): a label and hint of its own, and its domains dropped from what
// is typed (PLANT\jdoe, PLANT/jdoe, jdoe@plant.local are jdoe). `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInIdOf } from "../server/sign-in.js";
import { signInProblems, kindOfElement } from "../client/definition.js";

test("a domain the plant names is dropped from the id typed, any case; another is left", () => {
    const domains = ["PLANT", "plant.local"];
    assert.equal(signInIdOf("PLANT\\JDoe", domains), "jdoe");
    assert.equal(signInIdOf(" plant/jdoe ", domains), "jdoe");
    assert.equal(signInIdOf("JDoe@Plant.Local", domains), "jdoe");
    assert.equal(signInIdOf("jdoe", domains), "jdoe");
    assert.equal(signInIdOf("OTHER\\jdoe", domains), "other\\jdoe");
    assert.equal(signInIdOf("jdoe@other.com", domains), "jdoe@other.com");
    // No domains named: nothing is dropped.
    assert.equal(signInIdOf("PLANT\\jdoe"), "plant\\jdoe");
});

test("the sign-in settings: any label and hint, domains as domains", () => {
    assert.deepEqual(signInProblems(undefined), []);
    assert.deepEqual(signInProblems({ idLabel: "Windows user name", idHint: "PLANT\\username", domains: ["PLANT", "plant.local"] }), []);
    assert.deepEqual(signInProblems({ idLabel: "Badge number" }), []);
    assert.match(signInProblems({ idLabel: "x".repeat(41) })[0], /at most 40/);
    assert.match(signInProblems({ idHint: "x".repeat(61) })[0], /at most 60/);
    assert.match(signInProblems({ domains: ["plant_local"] })[0], /is not a domain/);
    assert.match(signInProblems({ domains: "PLANT" })[0], /a list/);
    assert.match(signInProblems({ label: "x" })[0], /not "label"/);
    assert.equal(kindOfElement("signIn"), "organization");
});
