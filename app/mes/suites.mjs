// Suites (DESIGN.md §29): products built on OpenCore MES and installed beside it, each in a folder of its
// own under suites/ (its package unpacked there, or in development a link to its repository). Having
// the folder is having the suite: nothing is configured, and the community edition knows no suite by
// name. A suite reaches the platform only through what it is handed (app.mjs suiteContext, app.js
// withSuites), never by importing the platform's files, so the two can be versioned apart.
//
// suites/<name>/suite.mjs, its default export:
//   { name: "<name>" (the folder's), label, version,
//     migrations: [{ name, file: new URL("./db/x.sql", import.meta.url) }],   run after the platform's
//     register(ctx) → { services, touches, queries, handlers, jobs, inbox },   the server's part
//                     (inbox(user) → [{ id, title, what?, link }]: alerts for that person, beside their name)
//     client: "client/index.js",                                              its browser module
//     designs: { label, version, definitions, transactions, screens, … } }    a design pack (server/packs.js)
// and beside it, if it has one, integration.json: its set-up guide (§29.8, guideProblems below), shown in
// the designer and on the suites store.
// Service and query names start with the suite's name, "<name with _ for ->.": they cannot shadow
// the platform's or another suite's.
//
// Its browser module (client/index.js): export nav ([{ group, label, to, words }], for the
// navigator), routes(kit) (its pages; kit: app.js withSuites) and register(juris, kit) (its components).
import { readdir, access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packProblems, packFiles } from "./server/packs.js";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// Where suites are installed: SUITES_DIR (an installation from npm keeps them in its plant folder), else
// suites/ beside the app (a checkout).
export const SUITES_DIR = process.env.SUITES_DIR ? path.resolve(process.env.SUITES_DIR) : path.join(ROOT, "suites");
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
export const servicePrefix = (name) => `${name.replace(/-/g, "_")}.`;

// The suites installed in `dir`: [{ name, label, version, migrations, register, client, clientUrl,
// clientDir (its URL path), clientHome (its folder on disk), nav, designs }], in name order. A folder
// without suite.mjs is not a suite and is left alone (a dot-folder, such as .versions, never is); a suite
// that breaks its contract stops the start, naming what is wrong.
export async function loadSuites({ dir = SUITES_DIR } = {}) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
    const out = [];
    for (const entry of entries.filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = entry.name;
        const home = path.join(dir, name);
        const file = path.join(home, "suite.mjs");
        try { await access(file); } catch { continue; }
        const where = `suite ${name} (${path.relative(ROOT, home)})`;
        if (!NAME.test(name)) throw new Error(`${where}: a suite's folder is named with lower case letters, digits and -`);
        const suite = (await import(pathToFileURL(file).href)).default;
        if (!suite || typeof suite !== "object") throw new Error(`${where}: suite.mjs exports the suite as its default`);
        if (suite.name !== name) throw new Error(`${where}: its name is "${suite.name}", not its folder's`);
        if (suite.register !== undefined && typeof suite.register !== "function") throw new Error(`${where}: register is a function`);
        for (const m of suite.migrations ?? []) if (typeof m?.name !== "string" || !(m.file instanceof URL)) throw new Error(`${where}: a migration is { name, file: a file: URL }`);
        if (suite.designs !== undefined) { const problems = packProblems(suite.designs); if (problems.length) throw new Error(`${where}: ${problems.join("; ")}`); }
        // Its pack's files (§35.4), read now: one missing, or of a kind the file store does not keep, stops the start.
        const files = suite.designs ? await packFiles(suite.designs, `${where}: designs`) : [];
        // Its set-up guide (§29.8): read now, a broken one stops the start like a broken pack.
        let guide = null;
        try { guide = JSON.parse(await readFile(path.join(home, "integration.json"), "utf8")); } catch (error) {
            if (error.code !== "ENOENT") throw new Error(`${where}: integration.json is not JSON (${error.message})`);
        }
        if (guide) { const problems = guideProblems(guide); if (problems.length) throw new Error(`${where}: integration.json: ${problems.join("; ")}`); }
        let client = null;
        let clientDir = null;
        let clientHome = null;
        if (suite.client !== undefined) {
            if (typeof suite.client !== "string" || !/^[\w-]+(?:\/[\w-]+)*\.js$/.test(suite.client)) throw new Error(`${where}: client is the path of its browser module, e.g. "client/index.js"`);
            client = await import(pathToFileURL(path.join(home, suite.client)).href);
            // Served at /suites/<name>/<its folder in the suite>/ wherever the suite is installed (beside
            // the app in a checkout, in the plant folder for an npm installation, outside the package):
            // the URL is the suite's, so its relative imports hold for the browser as for the server.
            const sub = path.posix.dirname(suite.client);
            clientDir = sub === "." ? `suites/${name}` : `suites/${name}/${sub}`;
            clientHome = path.join(home, sub);
        }
        out.push({
            name, label: suite.label ?? name, version: String(suite.version ?? "0"),
            migrations: suite.migrations ?? [], register: suite.register ?? null,
            client, clientDir, clientHome, clientUrl: client ? `/${clientDir}/${path.basename(suite.client)}` : null,
            nav: Array.isArray(client?.nav) ? client.nav : [],
            // `$files`: its files as read (packs.js packFiles), kept in the file store with its designs.
            designs: suite.designs ? { ...suite.designs, $files: files } : null,
            guide,
        });
    }
    return out;
}

// A suite's set-up guide (§29.8): { title, intro?, steps: [{ title, who?, text, items?: [text], commands?: [text] }] },
// plain text throughout (drawn as text, never as markup). What is wrong with it, in words.
export function guideProblems(guide) {
    const out = [];
    const text = (v, max) => typeof v === "string" && v.trim() !== "" && v.length <= max;
    const texts = (v, max) => v === undefined || (Array.isArray(v) && v.length <= 30 && v.every((x) => text(x, max)));
    if (!guide || typeof guide !== "object" || Array.isArray(guide)) return ["it is an object: { title, intro, steps }"];
    if (!text(guide.title, 200)) out.push("title is a text of up to 200 characters");
    if (guide.intro !== undefined && !text(guide.intro, 2000)) out.push("intro is a text of up to 2000 characters");
    if (!Array.isArray(guide.steps) || !guide.steps.length || guide.steps.length > 40) return [...out, "steps is a list of 1 to 40 steps"];
    guide.steps.forEach((st, i) => {
        const at = `step ${i + 1}`;
        if (!st || typeof st !== "object" || Array.isArray(st)) return out.push(`${at} is an object: { title, who, text, items, commands }`);
        if (!text(st.title, 200)) out.push(`${at}: title is a text of up to 200 characters`);
        if (st.who !== undefined && !text(st.who, 60)) out.push(`${at}: who is a text of up to 60 characters (a department or a role)`);
        if (!text(st.text, 4000)) out.push(`${at}: text is a text of up to 4000 characters`);
        if (!texts(st.items, 1000)) out.push(`${at}: items is a list of up to 30 texts`);
        if (!texts(st.commands, 1000)) out.push(`${at}: commands is a list of up to 30 texts`);
        for (const k of Object.keys(st)) if (!["title", "who", "text", "items", "commands"].includes(k)) out.push(`${at}: "${k}" is not part of a step`);
    });
    return out;
}
