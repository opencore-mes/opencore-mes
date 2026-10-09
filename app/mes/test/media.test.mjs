// Files on records and screens (DESIGN.md §35.4): what the store keeps by its bytes, a range of a file, a file
// field's and a media block's checks, and links in the words a screen shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileType, videoType, rangeOf, acceptedTypes, limitOf, MP4, WEBM, PDF } from "../server/blobs.js";
import { validateDefinition, validateScreen } from "../client/definition.js";
import { richText, linkTarget } from "../client/rich-text.js";
import { acceptAttr, acceptWords, kindOf } from "../client/media.js";
import { parseSteps, pageSteps, timeSteps, stepAt, secondsOf, timeWords, intoOf } from "../client/media-steps.js";

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(32)]);
const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  "), Buffer.alloc(32)]);
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from("webm"), Buffer.alloc(32)]);
const mkv = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x88]), Buffer.from("matroska"), Buffer.alloc(32)]);

test("a video is what its bytes say: MP4 by its ftyp box (not QuickTime's), WebM by its header; nothing else", () => {
    assert.equal(videoType(mp4), MP4);
    assert.equal(videoType(webm), WEBM);
    assert.equal(videoType(mov), null);
    assert.equal(videoType(mkv), null);
    assert.equal(fileType(mp4), MP4);
    assert.equal(fileType(Buffer.from("%PDF-1.4\n")), PDF);
    assert.equal(fileType(Buffer.from("<html><script>")), null);
    assert.equal(limitOf(MP4), 100_000_000);
    assert.equal(limitOf("image/png"), 5_000_000);
    assert.equal(limitOf(PDF), 10_000_000);
    assert.deepEqual(acceptedTypes(), ["image/png", "image/jpeg", "image/webp", PDF, MP4, WEBM]);
    assert.deepEqual(acceptedTypes(["pdf"]), [PDF]);
});

test("a range of bytes: from-to, from the start, the last n; one that cannot be served", () => {
    assert.deepEqual(rangeOf("bytes=0-99", 1000), { start: 0, end: 99 });
    assert.deepEqual(rangeOf("bytes=900-", 1000), { start: 900, end: 999 });
    assert.deepEqual(rangeOf("bytes=-100", 1000), { start: 900, end: 999 });
    assert.deepEqual(rangeOf("bytes=990-5000", 1000), { start: 990, end: 999 });
    assert.equal(rangeOf("bytes=1000-", 1000), "bad");
    assert.equal(rangeOf("bytes=5-1", 1000), "bad");
    assert.equal(rangeOf(undefined, 1000), null);
    assert.equal(rangeOf("bytes=0-1,5-9", 1000), null);
});

test("a file field: the kinds it takes; never sensitive or erasable; it may be derived", () => {
    const body = (field) => ({ object: "step", label: "Step", area: "Production", fields: { name: { type: "string" }, ...field }, states: { initial: "open", list: ["open"], transitions: [] }, roles: ["user"], policies: [] });
    const words = (b) => validateDefinition(b, { objects: ["step", "operation"] }).filter((p) => p.path.startsWith("fields.")).map((p) => p.message).join("\n");
    assert.equal(words(body({ instruction: { type: "file", accept: ["pdf", "video"] } })), "");
    assert.match(words(body({ instruction: { type: "file", accept: ["word"] } })), /accept lists kinds of file: picture, pdf, video, spreadsheet/);
    assert.match(words(body({ instruction: { type: "string", accept: ["pdf"] } })), /only a file field says what it accepts/);
    assert.match(words(body({ instruction: { type: "file", sensitive: true } })), /a file \(it is served by its name\) cannot be sensitive/);
    assert.match(words(body({ instruction: { type: "file", erasable: true } })), /a file cannot be erased yet/);
    assert.equal(words(body({ operation: { type: "ref", to: "operation" }, instruction: { type: "file", from: "operation.instruction" } })), "");
});

test("a media block: a record's file or picture field, or a file of the screen's own; its height", () => {
    const known = { objects: { lot: { fields: { name: { type: "string" }, instruction: { type: "file" }, photo: { type: "image" } }, actions: [] } }, transactions: {}, screens: [] };
    const screen = (b) => ({ name: "s", label: "S", params: { lot: { type: "ref", to: "lot" } }, blocks: [{ block: "media", ...b }], callers: { users: [], groups: [] }, stewards: ["production"] });
    const words = (b) => validateScreen(screen(b), known).filter((p) => p.path.startsWith("blocks.")).map((p) => p.message).join("\n");
    const BLOB = "a".repeat(64);
    assert.equal(words({ object: "lot", of: { param: "lot" }, field: "instruction" }), "");
    assert.equal(words({ object: "lot", of: { param: "lot" }, field: "photo", height: 600 }), "");
    assert.equal(words({ file: BLOB, name: "Torque guide" }), "");
    assert.match(words({ object: "lot", of: { param: "lot" }, field: "name" }), /names a file or picture field of lot \(instruction, photo\)/);
    assert.match(words({ file: "nope" }), /a 64-character name/);
    assert.match(words({ file: BLOB, object: "lot" }), /not both/);
    assert.match(words({}), /upload a file, or name the object/);
    assert.match(words({ file: BLOB, height: 50 }), /160 to 1600 pixels/);
});

test("links in words: an https address or a page of this site; anything else stays text", () => {
    assert.deepEqual(linkTarget("https://plant.example/wi/7"), { href: "https://plant.example/wi/7", external: true });
    assert.deepEqual(linkTarget("/s/work_centre"), { href: "/s/work_centre", external: false });
    for (const bad of ["javascript:alert(1)", "//evil.example", "http://plain.example", "data:text/html,x"]) assert.equal(linkTarget(bad), null, bad);
    const [p] = richText("See [the torque guide](https://plant.example/t) and [here](javascript:alert(1)).");
    const kids = p.p.children;
    assert.ok(kids.some((k) => k.a?.href === "https://plant.example/t" && k.a.target === "_blank" && k.a.textContent === "the torque guide"));
    assert.ok(!kids.some((k) => k.a?.href?.startsWith("javascript")));
    assert.ok(kids.some((k) => k.span?.textContent?.includes("[here](javascript:alert(1)")));
});

test("the browser's side: what a file picker offers, in words; a type's kind", () => {
    assert.match(acceptAttr(["pdf", "video"]), /application\/pdf,\.pdf,video\/mp4,video\/webm,\.mp4,\.webm/);
    assert.equal(acceptWords(["pdf", "video"]), "a PDF or a video (MP4, WebM)");
    assert.equal(acceptWords(), "a picture, a PDF or a video (MP4, WebM)");
    assert.equal(kindOf("video/webm"), "video");
    assert.equal(kindOf("text/html"), null);
});

test("a guide's steps: a page or a time, then its words; what cannot be read is named by its line", () => {
    const { steps, problems } = parseSteps("1 Remove the cover\n\n3 Torque crosswise\n0:45 Clean the seal\n1:02:03 End");
    assert.deepEqual(problems, []);
    assert.deepEqual(steps.map((s) => [s.at, s.time, s.label]), [[1, false, "Remove the cover"], [3, false, "Torque crosswise"], [45, true, "Clean the seal"], [3723, true, "End"]]);
    assert.deepEqual(pageSteps(steps).map((s) => [s.n, s.page, s.label]), [[1, 1, "Remove the cover"], [2, 3, "Torque crosswise"]]);
    assert.deepEqual(timeSteps(parseSteps("0:30 b\n0:10 a").steps).map((s) => s.start), [10, 30]);
    assert.match(parseSteps("Remove the cover\n2 ok\n1:75 bad").problems.join("\n"), /line 1, "Remove the cover": start it with a page \(3\) or a time \(0:45\)[\s\S]*line 3/);
    assert.equal(secondsOf("1:75"), null);
    assert.equal(timeWords(3723), "1:02:03");
    assert.equal(timeWords(45), "0:45");
    assert.equal(stepAt([1, 3, 7], 4), 1);
    assert.equal(stepAt([1, 3, 7], 0), -1);
    assert.equal(stepAt([10, 30], 29.98), 1);
});

test("a media block's steps: written in it for its own file, from a text field of the record for a record's", () => {
    const known = { objects: { lot: { fields: { name: { type: "string" }, instruction: { type: "file" }, notes: { type: "text" }, secret: { type: "text", sensitive: true }, qty: { type: "integer" } }, actions: [] } }, transactions: {}, screens: [] };
    const screen = (b) => ({ name: "s", label: "S", params: { lot: { type: "ref", to: "lot" } }, blocks: [{ block: "media", ...b }], callers: { users: [], groups: [] }, stewards: ["production"] });
    const words = (b) => validateScreen(screen(b), known).filter((p) => p.path.startsWith("blocks.")).map((p) => p.message).join("\n");
    const BLOB = "a".repeat(64);
    assert.equal(words({ file: BLOB, steps: "1 Remove\n2 Clean" }), "");
    assert.equal(words({ object: "lot", of: { param: "lot" }, field: "instruction", stepsField: "notes", pauseAtSteps: false }), "");
    assert.match(words({ object: "lot", of: { param: "lot" }, field: "instruction", stepsField: "qty" }), /its steps come from a text field of lot: "qty" is none/);
    assert.match(words({ object: "lot", of: { param: "lot" }, field: "instruction", stepsField: "secret" }), /secret is sensitive/);
    assert.match(words({ file: BLOB, stepsField: "notes" }), /a file of its own takes its steps here/);
    assert.match(words({ file: BLOB, steps: "Remove the cover" }), /start it with a page/);
    assert.match(words({ file: BLOB, pauseAtSteps: "yes" }), /pauseAtSteps is true or false/);
});

test("how a step is done: a tag at its end, naming the input or the screen where it takes one", () => {
    const { steps, problems } = parseSteps("1 Remove the cover\n2 Torque crosswise #value:torque\n3 The seal #photo\n4 The report #file:report\n5 Pump down #device\n6 Etch #screen:etch_station\n7 Released #wait\n8 Part #2 too");
    assert.deepEqual(problems, []);
    assert.deepEqual(steps.map((s) => [s.n, s.needs, s.into ?? null]), [[1, "click", null], [2, "value", "torque"], [3, "photo", null], [4, "file", "report"], [5, "device", null], [6, "screen", "etch_station"], [7, "wait", null], [8, "click", null]]);
    assert.equal(steps[7].label, "Part #2 too");
    assert.equal(intoOf(steps[2], { evidence: "picture" }), "picture");
    assert.equal(intoOf(steps[3], { evidence: "picture" }), "report");
    assert.equal(intoOf(steps[0], { evidence: "picture" }), null);
    const bad = parseSteps("1 Torque #value\n2 Look #glance\n3 Go #click:x\n4 #photo").problems.join("\n");
    assert.match(bad, /line 1: #value names the input/);
    assert.match(bad, /line 2: #glance is not how a step is done/);
    assert.match(bad, /line 3: #click names nothing after it/);
    assert.match(bad, /line 4: say what the step is/);
});

test("a guide's steps marked done: its transaction, the input taking the step's number, its log; each step's input", () => {
    const inputs = { lot: { type: "ref", to: "lot" }, step: { type: "integer" }, torque: { type: "decimal" }, picture: { type: "image" }, note: { type: "string" }, report: { type: "file" } };
    const known = {
        objects: { lot: { fields: { name: { type: "string" }, instruction: { type: "file" } }, actions: [] }, step_done: { fields: { lot: { type: "ref", to: "lot" }, step: { type: "integer" }, label: { type: "string" } }, actions: [] } },
        transactions: { mark_step: { label: "Mark step", inputs }, verified: { label: "V", inputs, verified: true } }, screens: ["etch_station"],
        flowInfo: { lot_route: { kind: "route", object: "lot", guided: 2 }, ocap: { kind: "plan", object: "lot", guided: 0 }, bare: { kind: "route", object: "lot", guided: 0 } },
    };
    const screen = (b) => ({ name: "s", label: "S", params: { lot: { type: "ref", to: "lot" } }, blocks: [{ block: "media", object: "lot", of: { param: "lot" }, field: "instruction", ...b }], callers: { users: [], groups: [] }, stewards: ["production"] });
    const words = (b) => validateScreen(screen(b), known).filter((p) => p.path.startsWith("blocks.")).map((p) => p.message).join("\n");
    const done = { transaction: "mark_step", step: "step", fills: { lot: { param: "lot" } }, evidence: "picture", log: { object: "step_done", where: { lot: { param: "lot" } }, step: "step" }, gate: true };
    const BLOB = { file: "a".repeat(64), object: undefined, of: undefined, field: undefined };
    assert.equal(words({ done }), "");
    assert.equal(words({ ...BLOB, steps: "1 Open\n2 Torque #value:torque\n3 Seal #photo\n4 Report #file:report\n5 Etch #screen:etch_station", done }), "");
    assert.match(words({ done: { ...done, transaction: "nope" } }), /"nope" is not a transaction/);
    // One a second person verifies is marked with them beside the operator (§7.4).
    assert.equal(words({ done: { ...done, transaction: "verified" } }), "");
    assert.match(words({ done: { ...done, step: "note" } }), /takes the step's number: make it a whole number/);
    assert.match(words({ done: { ...done, evidence: "note" } }), /evidence names a picture or file input/);
    assert.match(words({ done: { ...done, log: { object: "step_done", step: "step" } } }), /log.where says whose steps they are/);
    assert.match(words({ done: { ...done, log: { ...done.log, step: "label" } } }), /log.step names the number field/);
    assert.match(words({ done: { ...done, fills: { nope: 1 } } }), /mark_step has no input "nope"/);
    assert.match(words({ done: { ...done, gate: "yes" } }), /gate is true or false/);
    assert.match(words({ done: { ...done, extra: 1 } }), /it has no "extra"/);
    const { evidence, ...noEvidence } = done;
    assert.match(words({ ...BLOB, steps: "1 Seal #photo", done: noEvidence }), /step 1, "Seal" is done with a photo: name the input it goes in/);
    assert.match(words({ ...BLOB, steps: "1 Torque #value:picture", done }), /picture takes a picture: a value typed or scanned goes in/);
    assert.match(words({ ...BLOB, steps: "1 Torque #value:step", done }), /step takes the step's number/);
    assert.match(words({ ...BLOB, steps: "1 Seal #photo:note", done }), /note is not a picture or file input/);
    assert.match(words({ ...BLOB, steps: "1 Etch #screen:nope", done }), /"nope" is not a screen/);
    // Or the steps are a route's: its sequences placed in the guide.
    assert.equal(words({ route: { flow: "lot_route", of: { param: "lot" } } }), "");
    assert.match(words({ route: { flow: "ocap", of: { param: "lot" } } }), /ocap is a plan: a guide follows a route/);
    assert.match(words({ route: { flow: "bare", of: { param: "lot" } } }), /none of bare's sequences says where it is in the guide/);
    assert.match(words({ route: { flow: "lot_route" } }), /route.of says whose way it is/);
    assert.match(words({ route: { flow: "lot_route", of: { param: "lot" } }, stepsField: "name" }), /its steps are the route's/);
    assert.match(words({ route: { flow: "lot_route", of: { param: "lot" } }, done }), /follows a route is done as the route goes on/);
});
