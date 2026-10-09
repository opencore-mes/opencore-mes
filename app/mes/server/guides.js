// UI guides (DESIGN.md §33): what a panel's "?" opens, docked over the navigator. A guide written by
// hand is a file of the release (app/mes/guides/<key>.html): the core's own words about the core's own
// screens, read once and kept. The browser draws it through an allowlist of tags (client/guide.js),
// never as HTML; the guides of a plant's own forms are made in the browser from their designs.
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fail } from "@opencore-mes/juris-kit/errors.js";

const DIR = fileURLToPath(new URL("../guides/", import.meta.url));
const KEY = /^[a-z][a-z0-9-]{0,40}$/;

export function createGuides({ records, dir = DIR }) {
    const x = records.internals;
    const cache = new Map();
    async function load(key) {
        if (!cache.has(key)) {
            const names = new Set((await readdir(dir)).filter((n) => n.endsWith(".html")).map((n) => n.slice(0, -5)));
            cache.set(key, names.has(key) ? await readFile(`${dir}${key}.html`, "utf8") : null);
        }
        return cache.get(key);
    }
    const services = {
        // One guide: { key, html }, for anyone signed in.
        async "guides.get"({ key } = {}) {
            await x.requireViewer(this);
            const html = typeof key === "string" && KEY.test(key) ? await load(key) : null;
            if (html === null) fail("There is no guide for this page yet.", { status: 404 });
            return { key, html };
        },
    };
    return { services, touches: { "guides.get": [] } };
}
