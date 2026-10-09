// UI guides (§33) without a browser: a guide drawn through the allowlist (tags kept, others unwrapped,
// scripts dropped, no attribute but data-highlight and a safe href), and a form's guide made from its
// design (each field's control in words, required, filled in for you; each kind of control once).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { guideLayout, formGuide } from "../client/guide.js";

// Just enough of the DOM: elements and text.
const el = (tag, attrs = {}, ...children) => ({ nodeType: 1, tagName: tag.toUpperCase(), childNodes: children.map((c) => (typeof c === "string" ? { nodeType: 3, textContent: c } : c)), getAttribute: (n) => attrs[n] ?? null });
const item = (tag, selector, children) => ({ [tag]: { item: selector, children } });

test("a guide is drawn through the allowlist: tags kept, unknown ones unwrapped, scripts gone, only safe links", () => {
    const out = guideLayout(el("article", {}, el("p", { onclick: "alert(1)", class: "x" }, "Hello ", el("strong", {}, "you")), el("marquee", {}, "unwrapped"), el("script", {}, "alert(1)"), el("a", { href: "javascript:alert(1)" }, "bad"), el("a", { href: "https://example.com" }, "good"), el("dt", { "data-highlight": ".flow-palette" }, "Add")), item);
    const text = JSON.stringify(out);
    assert.ok(out.article);
    assert.ok(!/alert|onclick|class/.test(text), text);
    assert.match(text, /"strong"/);
    assert.match(text, /unwrapped/);
    assert.ok(!/marquee|script/.test(text));
    const links = out.article.children.filter((c) => c.a);
    assert.equal(links[0].a.href, undefined);
    assert.equal(links[1].a.href, "https://example.com");
    assert.equal(links[1].a.rel, "noopener");
    assert.deepEqual(out.article.children.find((c) => c.dt).dt.item, ".flow-palette");
});

test("a form's guide: each field's control in words, required and filled in said, each control once", () => {
    const def = {
        label: "Move in",
        fields: {
            lot: { label: "Lot", type: "ref", to: "lot", required: true },
            machine: { label: "Machine", type: "ref", to: "machine", from: "lot.machine" },
            ok: { label: "Checked", type: "boolean" },
            grade: { label: "Grade", type: "enum", values: ["a", "b"] },
            note: { label: "Note", type: "text" },
            readings: { label: "Readings", type: "rows", fields: { value: { type: "decimal" } } },
        },
        form: { sections: [{ label: "Move in", fields: [{ field: "lot", widget: "scan" }, "machine", "ok", { field: "grade", widget: "radio" }, "note", "readings"] }] },
    };
    const g = formGuide(def, { intro: "Hi" });
    const fields = g.sections.find((s) => s.title === "Move in").items;
    assert.equal(fields.length, 6);
    assert.match(fields[0].words, /A scan field: scan the lot's barcode.*Required: marked \*/);
    assert.equal(fields[0].highlight, '[data-guide="field:lot"]');
    assert.match(fields[1].words, /A search box: type at least 2 letters of the machine's name, then pick it from the matches.*Filled in for you from lot's machine/);
    assert.match(fields[2].words, /A checkbox: ticked means yes/);
    assert.match(fields[3].words, /Radio buttons: pick exactly one \(a, b\)/);
    assert.match(fields[4].words, /A text box/);
    assert.match(fields[5].words, /A table: one line per entry/);
    const controls = g.sections.find((s) => s.title === "The controls on this form").items;
    assert.deepEqual(controls.map((c) => c.label), ["Scan field", "Search box", "Checkbox", "Radio buttons", "Text box", "Table"]);
    assert.match(controls[0].words, /the record's barcode/);
});

test("the guides of the release: each an article with a title, its items pointing at something", () => {
    const dir = new URL("../guides/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".html"));
    assert.ok(files.length >= 3);
    for (const f of files) {
        const html = readFileSync(new URL(f, dir), "utf8");
        assert.match(html, /<article data-title="[^"]+">/, f);
        assert.ok((html.match(/data-highlight="[^"]+"/g) ?? []).length >= 5, f);
        assert.ok(!/<script|on[a-z]+=/i.test(html), f);
    }
});
