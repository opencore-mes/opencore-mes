// Secrets the server must read back, sealed at rest (COMPLIANCE.md G12): the authenticators' TOTP secrets, which
// a copy of the database (a backup, a stolen disk, a reader of mes.mfa) would otherwise hand over, with them
// every second factor. Sealed with AES-256-GCM under SEAL_KEY (64 hex characters) or the file SEAL_KEY_FILE
// names, kept outside the database and its backups. Without a key, values are kept as they are (development, a
// plant that has not set one), and values kept before a key was set still open: `node app/mes/db/seal-secrets.mjs`
// seals them.
//
//   sealSecret(text) → "seal1:<base64 iv|tag|ciphertext>", or the text itself without a key
//   openSecret(stored) → the text; a sealed value without the key throws, saying so
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const PREFIX = "seal1:";
let cached;
export function sealKey(env = process.env) {
    if (env === process.env && cached !== undefined) return cached;
    const text = env.SEAL_KEY || (env.SEAL_KEY_FILE ? readFileSync(env.SEAL_KEY_FILE, "utf8") : "");
    const hex = text.trim();
    if (hex && !/^[0-9a-f]{64}$/i.test(hex)) throw new Error("SEAL_KEY is 64 hex characters (32 bytes): make one with `openssl rand -hex 32`.");
    const key = hex ? Buffer.from(hex, "hex") : null;
    if (env === process.env) cached = key;
    return key;
}
export const isSealed = (stored) => typeof stored === "string" && stored.startsWith(PREFIX);

export function sealSecret(text, key = sealKey()) {
    if (!key) return text;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function openSecret(stored, key = sealKey()) {
    if (!isSealed(stored)) return stored;
    if (!key) throw new Error("A sealed secret was read, and this server has no SEAL_KEY: give it the key it was sealed with.");
    const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    try {
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
        throw new Error("A sealed secret does not open with this server's SEAL_KEY: it was sealed with another key.");
    }
}
