// Attachments (§34.10) without a database: what the file store keeps, by its bytes; what a page may send;
// how a model is given each kind; a report's media block. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileType, imageType, PDF, CSV, XLSX } from "../server/blobs.js";
import { attachmentsProblem, createAttachments, MAX_ATTACHMENTS } from "../server/attachments.js";
import { writeXlsx } from "../server/xlsx.js";
import { reportProblems } from "../client/report.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("the store keeps a file by what its bytes are, never by what the browser says", () => {
    assert.equal(fileType(PNG), "image/png");
    assert.equal(fileType(Buffer.from("%PDF-1.7\n…")), PDF);
    assert.equal(fileType(writeXlsx([{ name: "S", rows: [["a"], [1]] }])), XLSX);
    assert.equal(fileType(Buffer.from("lot,qty\nA,3\nB,4\n")), CSV);
    assert.equal(fileType(Buffer.from("a;b\n1;2\n")), CSV);
    assert.equal(fileType(Buffer.from("<html><script>alert(1)</script></html>")), null);
    assert.equal(fileType(Buffer.from("just words, then\nmore words")), null); // a line without a separator
    assert.equal(fileType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])), null); // a zip that is no workbook
    assert.equal(fileType(Buffer.from("a,b\u0000c\n")), null);
    assert.equal(imageType(Buffer.from("%PDF-1.7 trailing")), null); // a PDF is never a picture
});

test("what a page may attach: at most five files kept here, each once", () => {
    const h = (c) => c.repeat(64);
    assert.equal(attachmentsProblem(undefined), null);
    assert.equal(attachmentsProblem([{ blob: h("a"), name: "x.png" }]), null);
    assert.match(attachmentsProblem(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({ blob: h(String(i)) }))), /at most 5 files/);
    assert.match(attachmentsProblem([{ blob: "nope" }]), /a file kept here/);
    assert.match(attachmentsProblem([{ blob: h("a") }, { blob: h("a") }]), /attached twice/);
    assert.match(attachmentsProblem([{ blob: h("a"), name: "x".repeat(201) }]), /at most 200 characters/);
});

test("a model is given each kind as it reads it; the conversation keeps only names", async () => {
    const kept = new Map([["a".repeat(64), { type: "image/png", bytes: PNG }], ["b".repeat(64), { type: PDF, bytes: Buffer.from("%PDF-1.4 x") }], ["c".repeat(64), { type: CSV, bytes: Buffer.from("x,y\n1,2\n") }], ["d".repeat(64), { type: XLSX, bytes: writeXlsx([{ name: "Limits", rows: [["p", "max"], ["force", 60]] }]) }]]);
    const blobs = { about: async (names) => new Map(names.filter((n) => kept.has(n)).map((n) => [n, { type: kept.get(n).type, size: kept.get(n).bytes.length }])), bytesOf: async (n) => kept.get(n) ?? null };
    const att = createAttachments({ blobs });
    const { list } = await att.checked([...kept.keys()].map((blob, i) => ({ blob, name: `f${i}` })));
    const message = { role: "user", content: [{ type: "text", text: "Look." }, ...att.blocks(list)] };
    assert.ok(!JSON.stringify(message).includes(PNG.toString("base64"))); // only names
    const [m] = await att.expand([message]);
    const types = m.content.map((b) => b.type);
    assert.deepEqual(types.filter((t) => t !== "text"), ["image", "document"]);
    assert.equal(m.content.find((b) => b.type === "image").source.data, PNG.toString("base64"));
    assert.ok(m.content.some((b) => b.type === "text" && b.text.includes("x,y\n1,2")));
    assert.ok(m.content.some((b) => b.type === "text" && /Sheet "Limits":\np,max\nforce,60/.test(b.text)));
    assert.match((await att.checked([{ blob: "e".repeat(64), name: "gone.pdf" }])).problem, /not a file kept here/);
});

test("a report's media block: a file kept here, by its name, with no query", () => {
    const one = (b) => reportProblems({ title: "x", blocks: [b] }).map((p) => p.message).join(" | ");
    assert.equal(one({ block: "media", blob: "a".repeat(64), caption: "The defect", title: "Photo" }), "");
    assert.match(one({ block: "media", blob: "../etc/passwd" }), /blob names a file kept here/);
    assert.match(one({ block: "media", blob: "a".repeat(64), query: { sql: "SELECT 1" } }), /a media block has no query/);
    assert.match(one({ block: "media", blob: "a".repeat(64), caption: "x".repeat(501) }), /caption is at most 500/);
});
