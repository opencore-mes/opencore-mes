// Built-in objects and locks (builtins.js): what a lock keeps, whose it is, and what several suites
// installed together would fight over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PERSON, CORE_LOCKS, lockProblems, suiteLocks, suiteClashes, keptBy, managedOf, holderWords } from "../client/builtins.js";
import { extendedBody, packProblems } from "../server/packs.js";

const clone = (v) => JSON.parse(JSON.stringify(v));
const messages = (problems) => problems.map((p) => p.message).join("\n");

test("Person as built in breaks none of the platform's locks; what does is named", () => {
    assert.deepEqual(lockProblems(PERSON, CORE_LOCKS.person), []);
    const broken = clone(PERSON);
    broken.fields.name.required = false;
    broken.policies.push({ id: "p", roles: ["editor"], fields: { active: "write" }, record: { archive: true } });
    const words = messages(lockProblems(broken, CORE_LOCKS.person));
    assert.match(words, /Field "name" stays required: it is locked by the platform/);
    assert.match(words, /cannot let anyone write "active"/);
    assert.match(words, /cannot let anyone make or archive a record here/);
    assert.deepEqual(managedOf("person"), { fields: ["user", "name", "active"], platformRecords: true });
    assert.equal(keptBy(CORE_LOCKS.person).length, 1);
});

test("a suite's locks: taken from its own definition, or from what it adds to another's object", () => {
    const pack = {
        prefix: "semi_",
        definitions: [{ object: "semi_lot", fields: { operation: { type: "enum", values: ["a", "b"], required: true } } }],
        extends: { person: { fields: { semi_certified_for: { type: "enum", values: ["x", "y"], multiple: true } } } },
        locks: { semi_lot: { fields: ["operation"], states: ["waiting"], keep: true }, person: { fields: ["semi_certified_for"], why: "Track in checks it." } },
    };
    const locks = suiteLocks({ name: "semiconductor", label: "Semiconductor" }, pack);
    assert.deepEqual(locks.semi_lot[0].fields.operation, { type: "enum", values: ["a", "b"], required: true });
    assert.equal(holderWords(locks.person[0]), "the Semiconductor suite");
    assert.equal(holderWords({ by: "suite", owner: "Hello suite" }), "the Hello suite");
    // Choices may be added, not taken away; one value or several stays as it was.
    const lot = { object: "semi_lot", fields: { operation: { type: "enum", values: ["a", "b", "c"], required: true } }, states: { list: ["waiting"] } };
    assert.deepEqual(lockProblems(lot, locks.semi_lot), []);
    lot.fields.operation.values = ["a"];
    assert.match(messages(lockProblems(lot, locks.semi_lot)), /keeps its choices b \(more may be added\): it is locked by the Semiconductor suite/);
    const person = { object: "person", fields: { semi_certified_for: { type: "enum", values: ["x", "y"] } } };
    assert.match(messages(lockProblems(person, locks.person)), /keeps holding several values/);
    assert.match(keptBy(locks.semi_lot)[0], /the Semiconductor suite relies on it/);
});

test("several suites together: one prefix each, a field added once, a part locked as one thing", () => {
    const a = { name: "a", label: "A", pack: { prefix: "x_", extends: { person: { fields: { x_one: { type: "string" } } } } } };
    const b = { name: "b", label: "B", pack: { prefix: "x_", extends: { person: { fields: { x_one: { type: "string" } } } } } };
    const words = suiteClashes([a, b]).join("\n");
    assert.match(words, /a and b both name their designs "x_…"/);
    assert.match(words, /a and b both add person.x_one/);
    const c = { name: "c", label: "C", pack: { prefix: "c_", definitions: [{ object: "lot", fields: { qty: { type: "integer" } } }], locks: { lot: { fields: ["qty"] } } } };
    const d = { name: "d", label: "D", pack: { prefix: "d_", definitions: [{ object: "lot", fields: { qty: { type: "decimal" } } }], locks: { lot: { fields: ["qty"] } } } };
    assert.match(suiteClashes([c, d]).join("\n"), /c and d lock lot.qty as different things \(integer and decimal\)/);
    assert.deepEqual(suiteClashes([a, c]), []);
});

test("a pack's extension: its fields named with its prefix, put into the live object, marked as the suite's", () => {
    const pack = { label: "P", version: "1", prefix: "p_", extends: { person: { fields: { nick: { type: "string" } } } } };
    assert.match(packProblems(pack).join("\n"), /starts with its prefix \("p_…"\)/);
    assert.match(packProblems({ label: "P", version: "1", extends: { person: { fields: { p_a: { type: "string" } } } } }).join("\n"), /names its prefix/);
    const body = extendedBody(clone(PERSON), { fields: { p_nick: { label: "Nick", type: "string" } } }, { suite: "p", label: "P" });
    assert.equal(body.fields.p_nick.suite, "p");
    assert.ok(body.fields.name && body.builtIn);
    assert.deepEqual(body.form.sections.at(-1), { label: "P", fields: ["p_nick"] });
    assert.deepEqual(lockProblems(body, CORE_LOCKS.person), []);
});

test("a lock keeps a part only once it is live: a suite's pack not yet approved keeps nothing", async () => {
    const locks = { person: [{ by: "suite", owner: "Hello", fields: { hello_nickname: { type: "string" } }, states: ["active", "away"], keep: true }], hello_thing: [{ by: "suite", owner: "Hello", keep: true }] };
    const live = { person: { fields: { name: { type: "string" } }, states: { list: ["active"] } } };
    const now = (await import("../client/builtins.js")).liveLocks(locks, live);
    assert.deepEqual(now.person[0].fields, {});
    assert.deepEqual(now.person[0].states, ["active"]);
    assert.equal(now.hello_thing, undefined);
    live.person.fields.hello_nickname = { type: "string" };
    assert.deepEqual((await import("../client/builtins.js")).liveLocks(locks, live).person[0].fields, { hello_nickname: { type: "string" } });
});

// ---- Desktop (§6.8) ----
import { DESKTOP, BUILT_IN_SCRIPTS, CORE_LOCKS as LOCKS, desktopAddress, desktopPath } from "../client/builtins.js";
import { validateDefinition as checkDefinition } from "../client/definition.js";
import { scriptBody } from "../client/pipe.js";

test("Desktop: the built-in is a valid design, its rule script is published with it, and what sign-in reads is locked", () => {
    assert.deepEqual(checkDefinition(DESKTOP, { objects: ["desktop"], scripts: ["desktop_address"], departments: ["$governance"], locks: LOCKS }), []);
    assert.doesNotThrow(() => scriptBody("desktop_address", BUILT_IN_SCRIPTS.desktop_address));
    assert.deepEqual(DESKTOP.rules.map((r) => r.script).filter((name) => !BUILT_IN_SCRIPTS[name]), [], "every rule of a built-in has its script");
    const without = { ...DESKTOP, fields: Object.fromEntries(Object.entries(DESKTOP.fields).filter(([k]) => k !== "page")), form: { sections: [{ label: "Desktop", fields: ["name", "address", "opens"] }] } };
    assert.ok(checkDefinition(without, { objects: ["desktop"], scripts: ["desktop_address"], departments: ["$governance"], locks: LOCKS }).some((p) => /page/.test(p.message)));
    assert.equal(DESKTOP.transfer.import.key, "address", "the loader finds a desktop by its address");
});

test("Desktop: an address is compared as an address; a record names a page of the app, or nothing", () => {
    assert.deepEqual(["10.20.3.41", " ::FFFF:10.20.3.41 ", "[fe80::1%eth0]", "010.001.1.1", "2001:DB8::1"].map(desktopAddress), ["10.20.3.41", "10.20.3.41", "fe80::1", "10.1.1.1", "2001:db8::1"]);
    for (const not of ["300.1.1.1", "10.1.1", "press3", "", null, undefined, "10.1.1.1/24", "http://10.1.1.1"]) assert.equal(desktopAddress(not), null, String(not));
    assert.equal(desktopPath({ opens: "screen", page: "work_centre" }), "/s/work_centre");
    assert.equal(desktopPath({ opens: "screen", page: "work_centre", opened_with: "8c24e6ff-d8bb-4aab-bbb4-64f619927b70" }), "/s/work_centre/8c24e6ff-d8bb-4aab-bbb4-64f619927b70");
    assert.equal(desktopPath({ opens: "transaction", page: " move_in " }), "/t/move_in");
    for (const not of [{ opens: "screen", page: "../admin" }, { opens: "screen", page: "x", opened_with: "a/b" }, { opens: "screen", page: "x", opened_with: "a.b" }, { opens: "page", page: "x" }, { opens: "screen" }, {}, null]) assert.equal(desktopPath(not), null, JSON.stringify(not));
});

// A badge scanned is a sign-in id (§10.4): Person scans by it; what an object may scan by besides its title, checked.
test("Person is found by a scan of its sign-in id; scanBy names text or whole-number fields, never a sensitive one", async () => {
    const { PERSON } = await import("../client/builtins.js");
    const { validateDefinition } = await import("../client/definition.js");
    assert.deepEqual(PERSON.scanBy, ["user"]);
    const base = { object: "t_badge", label: "B", area: "X", titleField: "name", fields: { name: { label: "Name", type: "string", required: true }, badge: { label: "Badge", type: "string" }, secret: { label: "S", type: "string", sensitive: true }, born: { label: "Born", type: "date" } }, states: { initial: "a", list: ["a"], transitions: [] }, roles: ["r"], stewards: { object: ["production"] }, policies: [] };
    const words = (scanBy) => validateDefinition({ ...base, scanBy }, { objects: ["t_badge"], departments: ["production"] }).filter((p) => p.path === "scanBy").map((p) => p.message).join("\n");
    assert.equal(words(["badge"]), "");
    assert.match(words(["secret", "born", "nope"]), /"secret": a scan finds records by a text or whole-number field that is not sensitive[\s\S]*"born"[\s\S]*"nope"/);
    assert.match(words(["a", "b", "c", "d"]), /at most 3 fields/);
});

