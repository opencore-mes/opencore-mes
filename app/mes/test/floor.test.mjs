// A floor layout (DESIGN.md §35): what is wrong with one, what a status may be, its colours, where a
// record's picture may be, and what a picture is by its first bytes.
import test from "node:test";
import assert from "node:assert/strict";
import { floorProblems, statusValues, statusFields, pictureFields, colourOf, FLOOR_COLOURS, MAX_PLACES } from "../client/floor.js";
import { validateScreen, validateDefinition } from "../client/definition.js";
import { imageType } from "../server/blobs.js";

const blob = "a".repeat(64);
const objects = {
    tool: { titleField: "tool_id", states: ["idle", "running", "down"], tones: { down: "danger" }, fields: { tool_id: { type: "string" }, mode: { type: "enum", values: ["auto", "manual"] }, locked: { type: "boolean" }, note: { type: "text" }, model: { type: "ref", to: "tool_model" }, photo: { type: "image" } } },
    tool_model: { titleField: "name", states: ["in_use"], fields: { name: { type: "string" }, image: { type: "image" } } },
    note: { states: ["kept"], fields: { text: { type: "text" } } },
};
const place = { of: "T-1", x: 0.1, y: 0.2, w: 0.08, ix: 0.8, iy: 0.1 };
const floor = { block: "floor", object: "tool", status: "state", colours: { running: "ok", idle: "c1" }, image: { blob, w: 1600, h: 900 }, picture: "model.image", places: [place, { ...place, of: "T-2", x: 0.3 }] };

test("a floor that can be drawn has no problems", () => {
    assert.deepEqual(floorProblems(floor, objects.tool, objects), []);
    assert.deepEqual(floorProblems({ ...floor, status: "mode", picture: "photo", colours: {} }, objects.tool, objects), []);
    assert.deepEqual(floorProblems({ ...floor, picture: undefined, places: [] }, objects.tool, objects), []);
});

test("what is wrong with a floor is said", () => {
    const words = (b, def = objects.tool) => floorProblems(b, def, objects).join("\n");
    assert.match(words({ ...floor, image: undefined }), /upload the picture of the floor/);
    assert.match(words({ ...floor, image: { blob, w: 0, h: 10 } }), /how large it is/);
    assert.match(words({ ...floor, status: "colour" }), /tool has no field "colour"/);
    assert.match(words({ ...floor, status: "note" }), /not a field a status can be read from/);
    assert.match(words({ ...floor, colours: { running: "#00ff00" } }), /the legend's colour for "running" is one of/);
    assert.match(words({ ...floor, picture: "note" }), /"note" is not an image field of tool/);
    assert.match(words({ ...floor, picture: "model.name" }), /or of what it refers to/);
    assert.match(words({ ...floor, picture: "../x" }), /an image field, or one through a reference/);
    assert.match(words({ ...floor, places: [place, place] }), /"T-1" is placed twice/);
    assert.match(words({ ...floor, places: [{ ...place, x: 1.4 }] }), /fractions between 0 and 1/);
    assert.match(words({ ...floor, places: [{ ...place, id: "x" }] }), /a place has no "id"/);
    assert.match(words({ ...floor, places: Array.from({ length: MAX_PLACES + 1 }, (_, i) => ({ ...place, of: `T-${i}` })) }), /at most 200 places/);
    assert.match(words({ ...floor, object: "note" }, objects.note), /no title field/);
});

test("a status is the state or a short field; its values are listed for the legend", () => {
    assert.deepEqual(statusFields(objects.tool), ["state", "tool_id", "mode", "locked"]);
    assert.deepEqual(statusValues(objects.tool, "state"), ["idle", "running", "down"]);
    assert.deepEqual(statusValues({ states: { list: ["a", "b"] } }, "state"), ["a", "b"]);
    assert.deepEqual(statusValues(objects.tool, "mode"), ["auto", "manual"]);
    assert.deepEqual(statusValues(objects.tool, "locked"), ["true", "false"]);
    assert.deepEqual(statusValues(objects.tool, "tool_id"), []);
});

test("a value's colour is the legend's, else its state's tone, else grey; a design names a colour, never a number", () => {
    assert.equal(colourOf(floor.colours, objects.tool.tones, "running"), "ok");
    assert.equal(colourOf(floor.colours, objects.tool.tones, "down"), "danger");
    assert.equal(colourOf(floor.colours, objects.tool.tones, "unheard_of"), "neutral");
    assert.equal(colourOf({ running: "red" }, {}, "running"), "neutral");
    assert.equal(colourOf({}, {}, null), "neutral");
    assert.ok(FLOOR_COLOURS.every((c) => /^[a-z0-9]+$/.test(c)));
});

test("a record's picture is an image field of it, or of what it refers to", () => {
    assert.deepEqual(pictureFields(objects.tool, objects).map((p) => p.path), ["model.image", "photo"]);
    assert.deepEqual(pictureFields(objects.note, objects), []);
});

test("a screen takes a floor block, checked with the rest; an object takes an image field", () => {
    const screen = { name: "line_status", label: "Line status", params: {}, blocks: [floor], callers: { users: ["sam"], groups: [] }, stewards: ["production"] };
    const known = { objects, transactions: {}, users: ["sam"], groups: [], departments: ["production"] };
    assert.deepEqual(validateScreen(screen, known), []);
    assert.match(validateScreen({ ...screen, blocks: [{ ...floor, object: "furnace" }] }, known)[0].message, /"furnace" is not an object/);
    assert.match(validateScreen({ ...screen, blocks: [{ ...floor, status: "colour" }] }, known)[0].message, /Block 1: tool has no field "colour"/);
    const def = { object: "tool_model", label: "Tool model", area: "Production", titleField: "name", fields: { name: { label: "Name", type: "string", required: true }, image: { label: "Picture", type: "image" } }, states: { initial: "in_use", list: ["in_use"], transitions: [] }, roles: ["editor"], stewards: { object: ["production"] }, policies: [{ id: "all", roles: ["editor"], record: { read: true, create: true }, fields: { "*": "write" } }] };
    assert.deepEqual(validateDefinition(def, { objects: ["tool_model"], scripts: [], departments: ["production"] }).map((p) => p.message), []);
});

test("a picture is what its first bytes say: PNG, JPEG or WebP, nothing that could run", () => {
    assert.equal(imageType(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")), "image/png");
    assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])), "image/jpeg");
    assert.equal(imageType(Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")])), "image/webp");
    assert.equal(imageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")), null);
    assert.equal(imageType(Buffer.from("<!doctype html><html></html>")), null);
    assert.equal(imageType(Buffer.from("GIF89a..........")), null);
    assert.equal(imageType(Buffer.alloc(3)), null);
});
