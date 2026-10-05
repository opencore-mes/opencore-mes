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
// Service and query names start with the suite's name, "<name with _ for ->.": they cannot shadow
// the platform's or another suite's.
//
// Its browser module (client/index.js): export nav ([{ group, label, to, words }], for the
// navigator), routes(kit) (its pages; kit: app.js withSuites) and register(juris, kit) (its components).
import { readdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packProblems } from "./server/packs.js";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const SUITES_DIR = path.join(ROOT, "suites");
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
export const servicePrefix = (name) => `${name.replace(/-/g, "_")}.`;

// The suites installed in `dir`: [{ name, label, version, migrations, register, client, clientUrl,
// clientDir, nav, designs }], in name order. A folder without suite.mjs is not a suite and is left alone; a
// suite that breaks its contract stops the start, naming what is wrong.
export async function loadSuites({ dir = SUITES_DIR } = {}) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
    const out = [];
    for (const entry of entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name))) {
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
        let client = null;
        let clientDir = null;
        if (suite.client !== undefined) {
            if (typeof suite.client !== "string" || !/^[\w-]+(?:\/[\w-]+)*\.js$/.test(suite.client)) throw new Error(`${where}: client is the path of its browser module, e.g. "client/index.js"`);
            client = await import(pathToFileURL(path.join(home, suite.client)).href);
            // Served at the same path below the root as on disk, so its relative imports hold for both.
            clientDir = path.relative(ROOT, path.join(home, path.dirname(suite.client))).split(path.sep).join("/");
            if (clientDir.startsWith("..")) throw new Error(`${where}: it is outside the application's folder`);
        }
        out.push({
            name, label: suite.label ?? name, version: String(suite.version ?? "0"),
            migrations: suite.migrations ?? [], register: suite.register ?? null,
            client, clientDir, clientUrl: client ? `/${clientDir}/${path.basename(suite.client)}` : null,
            nav: Array.isArray(client?.nav) ? client.nav : [],
            designs: suite.designs ?? null,
        });
    }
    return out;
}
