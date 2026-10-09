// Secrets sealed at rest (server/seal.js, COMPLIANCE.md G12). `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sealSecret, openSecret, isSealed, sealKey } from "../server/seal.js";

const key = randomBytes(32);
test("sealed under a key, opened with it; a value kept in the clear still opens", () => {
    const sealed = sealSecret("JBSWY3DPEHPK3PXP", key);
    assert.ok(isSealed(sealed) && !sealed.includes("JBSWY3DPEHPK3PXP"));
    assert.notEqual(sealSecret("JBSWY3DPEHPK3PXP", key), sealed); // a fresh nonce each time
    assert.equal(openSecret(sealed, key), "JBSWY3DPEHPK3PXP");
    assert.equal(openSecret("JBSWY3DPEHPK3PXP", key), "JBSWY3DPEHPK3PXP");
});
test("without a key, kept as it is; a sealed value without the key, or under another, is refused in words", () => {
    assert.equal(sealSecret("abc", null), "abc");
    const sealed = sealSecret("abc", key);
    assert.throws(() => openSecret(sealed, null), /no SEAL_KEY/);
    assert.throws(() => openSecret(sealed, randomBytes(32)), /another key/);
    const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
    assert.throws(() => openSecret(tampered, key), /another key/);
});
test("the key: 64 hex characters, or none", () => {
    assert.equal(sealKey({}), null);
    assert.equal(sealKey({ SEAL_KEY: "ab".repeat(32) }).length, 32);
    assert.throws(() => sealKey({ SEAL_KEY: "short" }), /64 hex/);
});
