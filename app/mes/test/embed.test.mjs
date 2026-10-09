// Embedding (§37, client/embed.js): the allowed origins as the setting gives them, and the messages an
// embedding page may send, as the contract writes them (docs/contracts/embedding/schema.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseOrigins, readMessage, message, normal, PROTOCOL, VERSION, KINDS } from "../client/embed.js";

const schema = JSON.parse(readFileSync(new URL("../../../docs/contracts/embedding/schema.json", import.meta.url), "utf8"));

test("EMBED_ORIGINS: origins only, https (http on this machine), each once", () => {
    assert.deepEqual(parseOrigins(""), []);
    assert.deepEqual(parseOrigins("https://a.example.com, https://b.example.com:8443 https://a.example.com/"), ["https://a.example.com", "https://b.example.com:8443"]);
    assert.deepEqual(parseOrigins("http://127.0.0.1:9400,http://localhost:9400"), ["http://127.0.0.1:9400", "http://localhost:9400"]);
    assert.throws(() => parseOrigins("http://a.example.com"), /must be https/);
    assert.throws(() => parseOrigins("https://a.example.com/course"), /origin only/);
    assert.throws(() => parseOrigins("https://user@a.example.com"), /origin only/);
    assert.throws(() => parseOrigins("a.example.com"), /not an address/);
});

test("the messages an embedding page may send, and nothing else", () => {
    const m = (type, fields = {}) => ({ protocol: PROTOCOL, version: VERSION, type, ...fields });
    assert.deepEqual(readMessage(m("hello")), { type: "hello" });
    assert.deepEqual(readMessage(m("clear")), { type: "clear" });
    assert.deepEqual(readMessage(m("outline", { label: "  Submit for review " })), { type: "outline", label: "Submit for review", kind: "any" });
    assert.deepEqual(readMessage(m("outline", { label: "Fields", kind: "tab" })), { type: "outline", label: "Fields", kind: "tab" });
    assert.deepEqual(readMessage({ ...m("hello"), version: "1.4" }), { type: "hello" }, "a later minor version is read");
    for (const bad of [null, "hello", {}, { ...m("hello"), protocol: "other" }, { ...m("hello"), version: "2.0" }, m("click", { label: "Save" }), m("outline"), m("outline", { label: "" }), m("outline", { label: "x".repeat(201) }), m("outline", { label: "Save", kind: "script" }), m("outline", { label: 5 })]) {
        assert.equal(readMessage(bad), null, JSON.stringify(bad));
    }
});

test("the contract and the code agree: protocol, version, kinds, messages", () => {
    assert.deepEqual(schema["x-contract"], { name: "embedding", version: VERSION });
    assert.equal(schema["x-protocol"], PROTOCOL);
    assert.deepEqual(schema.$defs.kind.enum, KINDS);
    assert.deepEqual(Object.keys(schema["x-messages"].in).sort(), ["clear", "hello", "outline"]);
    assert.deepEqual(Object.keys(schema["x-messages"].out).sort(), ["location", "outlined", "ready"]);
    assert.deepEqual(message("location", { path: "/", title: "Home" }), { protocol: PROTOCOL, version: VERSION, type: "location", path: "/", title: "Home" });
});

test("a name as a person reads it", () => {
    assert.equal(normal("  Why this\n change: "), "why this change");
    assert.equal(normal("Quantity *"), "quantity");
    assert.equal(normal("Loading…"), "loading");
});
