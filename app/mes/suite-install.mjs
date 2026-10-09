// Installing suites from the suites registry (DESIGN.md §29.7): `opencore-mes suite …` (cli.mjs). A suite
// is an npm package, `@opencore-suites/<name>`, served to a plant whose licence covers it; it is unpacked
// as suites/<name>/ (the folder the loader reads, suites.mjs), its own dependencies installed inside it.
// The community edition knows no suite by name: the name is the person's.
//
// What an installation ran is kept (§29.5): a suite replaced or removed moves to suites/.versions/
// <name>@<version>, never deleted, and `use` brings a kept version back. Its designs and its tables are
// the plant's and stay whatever happens to its folder. A folder that is a link (a repository linked in
// development) is never touched.
//
// The registry and the plant's licence token live in <work>/.npmrc (the work folder, .local/suites, kept
// out of git), read by npm as that folder's project settings, so the person's own npm settings (a proxy,
// a CA) still apply. `from` installs a package file instead (a plant with no way out: the tarball
// downloaded from the store elsewhere and carried in).
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const SCOPE = "@opencore-suites";
export const REGISTRY = "https://suites.opencoremes.com/";
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const KEPT = ".versions";

const npm = (args, cwd) => run(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" } });
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const fail = (message) => { throw Object.assign(new Error(message), { person: true }); };
// Versions in order, numerically part by part (1.10.0 after 1.9.0; 1.0.0-2, a second copy, after 1.0.0).
const byVersion = (a, b) => { const x = a.split(/[.-]/), y = b.split(/[.-]/); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (Number(x[i]) || 0) - (Number(y[i]) || 0) || String(x[i] ?? "").localeCompare(String(y[i] ?? "")); if (d) return d; } return 0; };

// What npm's refusal means for the person: thrown in words, or as it came when it is none of these.
function explain(error, { name, range = "latest", registry }) {
    const text = String(error.stderr ?? error.message);
    if (/E401|E403/.test(text)) fail(`The suites registry refused: your licence does not cover ${name}, or no licence token is set. Sign in with \`opencore-mes suite login\`, or ask whoever holds your plant's account at the suites store.`);
    if (/E404|ETARGET/.test(text)) fail(`There is no suite ${name}${range === "latest" ? "" : ` ${range}`} on the suites registry.`);
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/.test(text)) fail(`The suites registry (${registry}) cannot be reached from here. A plant with no way out installs a package file: opencore-mes suite install ${name} --from <file>.tgz`);
    throw error;
}

// The work folder npm runs in: its package.json makes its .npmrc the project's settings.
async function workFolder(work, registry) {
    await mkdir(work, { recursive: true });
    if (!existsSync(path.join(work, "package.json"))) await writeFile(path.join(work, "package.json"), '{ "private": true, "description": "OpenCore MES: the work folder of `opencore-mes suite`" }\n');
    const rc = path.join(work, ".npmrc");
    const lines = existsSync(rc) ? readFileSync(rc, "utf8").split("\n").filter((l) => l && !l.startsWith(`${SCOPE}:registry=`)) : [];
    await writeFile(rc, [`${SCOPE}:registry=${registry}`, ...lines].join("\n") + "\n", { mode: 0o600 });
    return rc;
}

// The plant's licence token for the registry, kept in the work folder's .npmrc (mode 0600).
export async function login({ work, registry = REGISTRY, token }) {
    if (!/^[\w.~+/=-]{16,}$/.test(token ?? "")) fail("That is not a licence token: copy it whole from your account at the suites store.");
    const rc = await workFolder(work, registry);
    const host = new URL(registry);
    const key = `//${host.host}${host.pathname.replace(/\/?$/, "/")}:_authToken=`;
    const lines = readFileSync(rc, "utf8").split("\n").filter((l) => l && !l.startsWith(key));
    await writeFile(rc, [...lines, `${key}${token}`].join("\n") + "\n", { mode: 0o600 });
    return { registry, file: rc };
}

// What is installed in `dir`: [{ name, version, linked, kept: [versions] }], by name.
export function installed(dir) {
    if (!existsSync(dir)) return [];
    const kept = existsSync(path.join(dir, KEPT)) ? readdirSync(path.join(dir, KEPT)) : [];
    const keptOf = (name) => kept.filter((k) => k.startsWith(`${name}@`)).map((k) => k.slice(name.length + 1)).sort(byVersion);
    const here = readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()) && existsSync(path.join(dir, e.name, "suite.mjs"))).map((e) => e.name);
    const names = [...new Set([...here, ...kept.map((k) => k.slice(0, k.lastIndexOf("@")))])].sort();
    return names.map((name) => ({ name, version: here.includes(name) ? readJson(path.join(dir, name, "package.json"))?.version ?? null : null, linked: isLink(path.join(dir, name)), kept: keptOf(name) }));
}

// Moves suites/<name> aside to .versions/<name>@<version> (a second copy of a version gets -2, -3, …).
async function keep(dir, name) {
    const home = path.join(dir, name);
    if (!existsSync(home)) return null;
    if (isLink(home)) fail(`suites/${name} is a link to a repository (development): it is left alone. Remove the link first to install a package in its place.`);
    const version = readJson(path.join(home, "package.json"))?.version ?? "unknown";
    await mkdir(path.join(dir, KEPT), { recursive: true });
    let to = path.join(dir, KEPT, `${name}@${version}`);
    for (let n = 2; existsSync(to); n++) to = path.join(dir, KEPT, `${name}@${version}-${n}`);
    await rename(home, to);
    return { version, kept: path.relative(dir, to) };
}

// Installs `name` (a version or range, or the newest the licence covers) or the package file `from`:
// → { name, version, replaced?: { version, kept } }. Nothing in suites/ changes until it is unpacked,
// checked and its dependencies installed.
export async function install({ dir, work, registry = REGISTRY, name, range = "latest", from = null }) {
    if (!NAME.test(name ?? "")) fail(`"${name}" is not a suite's name: lower case letters, digits and -.`);
    await workFolder(work, registry);
    const stage = await mkdtemp(path.join(work, "stage-"));
    try {
        let packed;
        try {
            const { stdout } = await npm(["pack", from ? path.resolve(from) : `${SCOPE}/${name}@${range}`, "--json", "--pack-destination", stage], work);
            [packed] = JSON.parse(stdout);
        } catch (error) {
            explain(error, { name, range, registry });
        }
        await run("tar", ["-xzf", path.join(stage, packed.filename), "-C", stage]);
        const pkg = path.join(stage, "package");
        const json = readJson(path.join(pkg, "package.json"));
        if (!existsSync(path.join(pkg, "suite.mjs"))) fail(`${packed.filename} is not a suite: it has no suite.mjs.`);
        if (json?.name !== `${SCOPE}/${name}`) fail(`${packed.filename} is ${json?.name ?? "unnamed"}, not ${SCOPE}/${name}.`);
        if (Object.keys(json.dependencies ?? {}).length) {
            // Its own dependencies, inside it, with the work folder's settings (a suite may depend on another
            // suite's package); no install scripts: a suite runs nothing at install.
            await copyFile(path.join(work, ".npmrc"), path.join(pkg, ".npmrc"));
            try { await npm(["install", "--omit=dev", "--ignore-scripts", "--no-package-lock"], pkg); } finally { await rm(path.join(pkg, ".npmrc"), { force: true }); }
        }
        await mkdir(dir, { recursive: true });
        const replaced = await keep(dir, name);
        await rename(pkg, path.join(dir, name));
        return { name, version: json.version, ...(replaced ? { replaced } : {}) };
    } finally {
        await rm(stage, { recursive: true, force: true });
    }
}

// The newest version the registry has for each installed suite (links left out): [{ name, version, newest,
// refused? (why it could not be asked) }].
export async function outdated({ dir, work, registry = REGISTRY }) {
    await workFolder(work, registry);
    const out = [];
    for (const s of installed(dir).filter((s) => s.version && !s.linked)) {
        // One the licence no longer covers is said, and the others still checked: what is installed stays.
        try {
            const { stdout } = await npm(["view", `${SCOPE}/${s.name}`, "version"], work);
            out.push({ name: s.name, version: s.version, newest: stdout.trim() });
        } catch (error) {
            try { explain(error, { name: s.name, registry }); } catch (said) { if (!said.person) throw said; out.push({ name: s.name, version: s.version, newest: null, refused: said.message }); }
        }
    }
    return out;
}

// Newer versions on the registry, asked now and then (§29.7): where the plant has signed in to it (a licence token
// in the work folder), soon after the start and then once a day, so the people who look after the installation
// see in About and in the designer that a suite has a newer version (a marketplace's API changed, a fix) and update
// it when they choose (opencore-mes suite update). Nothing is installed by itself. `check` asks the registry
// (outdated); a test hands its own. → { list() → [{ name, version, newest }] newer only, at(), ask(), stop() }.
export function watchUpdates({ dir, work, registry = REGISTRY, everyMs = 86_400_000, firstMs = 60_000, check = () => outdated({ dir, work, registry }), log = console } = {}) {
    let found = [];
    let at = null;
    let timer = null;
    const signedIn = () => { try { return /:_authToken=\S/.test(readFileSync(path.join(work, ".npmrc"), "utf8")); } catch { return false; } };
    async function ask() {
        if (!signedIn()) return found;
        try {
            found = (await check()).filter((s) => s.version && s.newest && byVersion(s.newest, s.version) > 0).map(({ name, version, newest }) => ({ name, version, newest }));
            at = new Date().toISOString();
        } catch (error) { log.error?.(`suites: newer versions not asked (${error.message})`); }
        return found;
    }
    const tick = () => { ask().finally(() => { timer = setTimeout(tick, everyMs); timer.unref?.(); }); };
    if (firstMs !== null) { timer = setTimeout(tick, firstMs); timer.unref?.(); }
    return { list: () => found, at: () => at, ask, stop: () => clearTimeout(timer) };
}

// Removes suites/<name>: kept in .versions, never deleted → { version, kept }.
export async function remove({ dir, name }) {
    if (!NAME.test(name ?? "") || !existsSync(path.join(dir, name))) fail(`No suite ${name} is installed.`);
    return keep(dir, name);
}

// Brings back a kept version (the newest kept, unless one is named), keeping the one installed in its place.
export async function use({ dir, name, version = null }) {
    const s = installed(dir).find((x) => x.name === name);
    const pick = version ?? s?.kept.at(-1);
    if (!s || !pick || !s.kept.includes(pick)) fail(`No kept version${version ? ` ${version}` : ""} of ${name}${s?.kept.length ? `: kept are ${s.kept.join(", ")}` : ""}.`);
    const from = path.join(dir, KEPT, `${name}@${pick}`);
    const replaced = await keep(dir, name);
    await rename(from, path.join(dir, name));
    return { name, version: readJson(path.join(dir, name, "package.json"))?.version ?? pick, ...(replaced ? { replaced } : {}) };
}
