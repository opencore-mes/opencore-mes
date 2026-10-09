// Installing suites (suite-install.mjs, DESIGN.md §29.7), offline: the hello fixture packed as the suites
// registry would serve it, installed from its package file into a plant folder outside the application,
// replaced, rolled back and removed, every version kept; then loaded from there (suites.mjs), its browser
// module mounted from outside the application's folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as suites from "../suite-install.mjs";
import { loadSuites, ROOT } from "../suites.mjs";

const run = promisify(execFile);
const HELLO = fileURLToPath(new URL("./fixtures/suites/hello/", import.meta.url));

// The hello fixture as a package file, `@opencore-suites/<name>@<version>`.
async function pack(tmp, version, name = "@opencore-suites/hello") {
    const src = path.join(tmp, `src-${version}`);
    await cp(HELLO, src, { recursive: true });
    await writeFile(path.join(src, "package.json"), JSON.stringify({ name, version, type: "module" }));
    const { stdout } = await run("npm", ["pack", "--json", "--pack-destination", tmp], { cwd: src });
    return path.join(tmp, JSON.parse(stdout)[0].filename);
}

test("a suite installed from its package file, replaced, brought back and removed: every version kept", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "suite-install-"));
    const plant = { dir: path.join(tmp, "plant", "suites"), work: path.join(tmp, "plant", ".local", "suites"), registry: "http://127.0.0.1:9/" };
    try {
        const v1 = await pack(tmp, "1.0.0");
        const v2 = await pack(tmp, "1.10.0");
        const v9 = await pack(tmp, "1.9.0");

        const first = await suites.install({ ...plant, name: "hello", from: v1 });
        assert.deepEqual(first, { name: "hello", version: "1.0.0" });
        assert.ok((await stat(path.join(plant.dir, "hello", "suite.mjs"))).isFile());
        assert.match(await readFile(path.join(plant.work, ".npmrc"), "utf8"), /^@opencore-suites:registry=http:\/\/127\.0\.0\.1:9\/$/m, "the scope goes to the suites registry, nothing else");

        // Loaded from the plant folder, outside the application: its browser module at the suite's URL.
        assert.ok(!plant.dir.startsWith(ROOT));
        const [hello] = await loadSuites({ dir: plant.dir });
        assert.equal(hello.clientUrl, "/suites/hello/client/index.js");
        assert.equal(hello.clientHome, path.join(plant.dir, "hello", "client"));

        const second = await suites.install({ ...plant, name: "hello", from: v2 });
        assert.deepEqual(second.replaced, { version: "1.0.0", kept: ".versions/hello@1.0.0" });
        await suites.install({ ...plant, name: "hello", from: v9 });
        assert.deepEqual(suites.installed(plant.dir), [{ name: "hello", version: "1.9.0", linked: false, kept: ["1.0.0", "1.10.0"] }], "kept versions in numeric order");
        assert.equal((await loadSuites({ dir: plant.dir })).length, 1, ".versions is not a suite");

        const back = await suites.use({ ...plant, name: "hello" });
        assert.equal(back.version, "1.10.0", "the newest kept, unless one is named");
        assert.equal((await suites.use({ ...plant, name: "hello", version: "1.0.0" })).version, "1.0.0");
        await assert.rejects(suites.use({ ...plant, name: "hello", version: "2.0.0" }), /No kept version 2\.0\.0 of hello: kept are/);

        const gone = await suites.remove({ ...plant, name: "hello" });
        assert.equal(gone.version, "1.0.0");
        assert.deepEqual(suites.installed(plant.dir), [{ name: "hello", version: null, linked: false, kept: ["1.0.0", "1.9.0", "1.10.0"] }], "nothing deleted");
        assert.deepEqual(await loadSuites({ dir: plant.dir }), []);
        await suites.install({ ...plant, name: "hello", from: v1 });
        await suites.remove({ ...plant, name: "hello" });
        assert.deepEqual(suites.installed(plant.dir)[0].kept, ["1.0.0", "1.0.0-2", "1.9.0", "1.10.0"], "a second copy of a version is kept beside the first");
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }
});

test("refused: a package that is not the suite named, a name that is not a suite's, a linked folder, a bad token", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "suite-install-"));
    const plant = { dir: path.join(tmp, "plant", "suites"), work: path.join(tmp, "plant", ".local", "suites"), registry: "http://127.0.0.1:9/" };
    try {
        const other = await pack(tmp, "1.0.0", "@opencore-suites/other");
        await assert.rejects(suites.install({ ...plant, name: "hello", from: other }), /is @opencore-suites\/other, not @opencore-suites\/hello/);
        await assert.rejects(suites.install({ ...plant, name: "Hello!", from: other }), /not a suite's name/);
        assert.deepEqual(suites.installed(plant.dir), [], "nothing changed in suites/");

        await mkdir(plant.dir, { recursive: true });
        await symlink(HELLO, path.join(plant.dir, "hello"));
        await assert.rejects(suites.install({ ...plant, name: "hello", from: await pack(tmp, "2.0.0") }), /is a link to a repository/);
        assert.deepEqual(suites.installed(plant.dir), [{ name: "hello", version: null, linked: true, kept: [] }]);

        await assert.rejects(suites.login({ ...plant, token: "short" }), /not a licence token/);
        const { file } = await suites.login({ ...plant, token: "lic_0123456789abcdef0123" });
        const rc = await readFile(file, "utf8");
        assert.match(rc, /^\/\/127\.0\.0\.1:9\/:_authToken=lic_0123456789abcdef0123$/m);
        assert.equal((await stat(file)).mode & 0o777, 0o600, "the token file is the plant's alone");
        await suites.login({ ...plant, token: "lic_fedcba9876543210fedc" });
        assert.equal((await readFile(file, "utf8")).match(/_authToken=/g).length, 1, "a new token replaces the old");
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }
});

test("newer versions are asked only where the plant has signed in to the registry, and only newer ones said", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "suite-updates-"));
    const work = path.join(tmp, "plant", ".local", "suites");
    let asked = 0;
    const check = async () => { asked++; return [{ name: "hello", version: "1.9.0", newest: "1.10.0" }, { name: "same", version: "2.0.0", newest: "2.0.0" }, { name: "older", version: "3.1.0", newest: "3.0.9" }, { name: "refused", version: "1.0.0", newest: null, refused: "not covered" }]; };
    try {
        const w = suites.watchUpdates({ dir: path.join(tmp, "plant", "suites"), work, check, firstMs: null, log: {} });
        assert.deepEqual(await w.ask(), [], "not signed in: nothing asked");
        assert.equal(asked, 0);
        await suites.login({ work, registry: "http://127.0.0.1:9/", token: "ocs_0123456789abcdef0123" });
        assert.deepEqual(await w.ask(), [{ name: "hello", version: "1.9.0", newest: "1.10.0" }], "1.10.0 is newer than 1.9.0; the same, an older, a refused one are not said");
        assert.equal(asked, 1);
        assert.deepEqual(w.list(), [{ name: "hello", version: "1.9.0", newest: "1.10.0" }]);
        assert.ok(w.at());
        w.stop();
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }
});
