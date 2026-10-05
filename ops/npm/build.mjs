#!/usr/bin/env node
// The npm packages made from this repository, staged and packed into .local/npm/ (kept out of git); it
// never publishes: `npm publish` is a person's step, once the tarballs are checked (ops/npm/README.md).
//
//   node ops/npm/build.mjs [--only juris,server,...] [--to .local/npm]
//
//   juris                            the framework (src/), on its own
//   @opencore-mes/server             the application, runnable: the `opencore-mes` command (app/mes/cli.mjs)
//                                    and everything it imports (app/mes, src, docs/contracts), with the
//                                    chart library copied in, since a package's files are all it may serve
//   @opencore-mes/equipment-adapter  the equipment-adapter contract and its conformance kit (§31)
//   @opencore-mes/http-apis          the HTTP APIs' contract and its kit (§31)
//
// Only what git tracks or would track goes in (as for the public tree), never a private file, a suite or
// a test; each package carries LICENSE and NOTICE.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const OUT = path.resolve(ROOT, arg("to") ?? ".local/npm");
const only = arg("only")?.split(",");
const root = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const tracked = git(["ls-files", "-co", "--exclude-standard", "-z"]).split("\0").filter((f) => f && existsSync(path.join(ROOT, f)));
const PRIVATE = /(^|\/)(DESIGN|INVENTION_DISCLOSURE|SUITES|CLAUDE(\.local)?)\.md$|(^|\/)\.env$|^suites\/|^\.local\/|^\.claude\//;
const under = (...dirs) => tracked.filter((f) => dirs.some((d) => f === d || f.startsWith(`${d}/`)));

const REPO = "https://github.com/opencore-mes/opencore-mes";
const common = (directory) => ({
    license: "Apache-2.0",
    author: "Resti Guay",
    repository: { type: "git", url: `git+${REPO}.git`, ...(directory ? { directory } : {}) },
    bugs: { url: `${REPO}/issues` },
    type: "module",
    engines: root.engines,
});
// A contract's package README: how to get it, then the contract itself (its README.md, which names paths
// in the repository: here they are the package's root).
const contractReadme = (name, usage, dir) => `# ${name}\n\nThe published contract, its machine-readable schema and its conformance kit, as a package of their own (OpenCore MES, ${REPO}).\n\n\`\`\`bash\nnpm install --save-dev ${name}\nnpx ${usage}\n\`\`\`\n\nPaths below under \`${dir}/\` are this package's root.\n\n---\n\n${readFileSync(path.join(ROOT, dir, "README.md"), "utf8")}`;

const PACKAGES = {
    juris: {
        name: "juris",
        version: "0.91.0",
        files: under("src").map((f) => [f, f.slice("src/".length)]),
        json: {
            description: "A framework for server-rendered web apps whose pages stay live: no build step, no runtime dependency",
            keywords: ["framework", "server-rendering", "live-queries", "reactive", "no-build"],
            homepage: "https://jurisjs.com",
            ...common("src"),
            main: "./juris.js",
            exports: { ".": "./juris.js", "./*": "./*" },
        },
    },
    server: {
        name: "@opencore-mes/server",
        version: "0.1.0",
        files: [
            ...under("app/mes", "src", "docs/contracts").filter((f) => !f.startsWith("app/mes/test/")).map((f) => [f, f]),
            ...["ops/script-runner-sandbox.sh", "ops/script-runner-sandbox.apparmor"].map((f) => [f, f]),
            // The chart library (§34.9), served from the package (app.mjs ECHARTS), with its licence.
            ["node_modules/echarts/dist/echarts.esm.min.mjs", "app/mes/vendor/echarts.esm.min.mjs"],
            ["node_modules/echarts/LICENSE", "app/mes/vendor/echarts.LICENSE"],
            ["node_modules/echarts/NOTICE", "app/mes/vendor/echarts.NOTICE"],
        ],
        readme: readFileSync(path.join(ROOT, "ops/npm/server.README.md"), "utf8"),
        json: {
            description: "OpenCore MES, the community edition: a low-code MES for advanced manufacturing, runnable (the opencore-mes command)",
            keywords: ["mes", "manufacturing", "low-code", "semiconductor", "traceability", "part-11", "secs-gem"],
            homepage: "https://opencoremes.com",
            ...common(),
            bin: { "opencore-mes": "app/mes/cli.mjs" },
            // echarts is copied in (above), so it is no dependency here.
            dependencies: Object.fromEntries(Object.entries(root.dependencies).filter(([n]) => n !== "echarts")),
        },
    },
    "equipment-adapter": {
        name: "@opencore-mes/equipment-adapter",
        version: "1.0.0",
        files: under("docs/contracts/equipment-adapter").map((f) => [f, f.slice("docs/contracts/equipment-adapter/".length)]),
        readme: contractReadme("@opencore-mes/equipment-adapter", "equipment-adapter-kit path/to/fixture.mjs", "docs/contracts/equipment-adapter"),
        json: {
            description: "The OpenCore MES equipment-adapter contract (1.0): its specification, schema, conformance kit and a reference adapter",
            keywords: ["opencore-mes", "equipment", "adapter", "secs-gem", "opc-ua", "mqtt", "conformance"],
            homepage: `${REPO}/tree/main/docs/contracts/equipment-adapter`,
            ...common("docs/contracts/equipment-adapter"),
            exports: { ".": "./kit.mjs", "./kit.mjs": "./kit.mjs", "./schema.json": "./schema.json", "./reference/*": "./reference/*" },
            bin: { "equipment-adapter-kit": "kit.mjs" },
        },
    },
    "http-apis": {
        name: "@opencore-mes/http-apis",
        version: "1.0.0",
        files: under("docs/contracts/http-apis").map((f) => [f, f.slice("docs/contracts/http-apis/".length)]),
        readme: contractReadme("@opencore-mes/http-apis", "http-apis-kit --url http://127.0.0.1:9090 --token <token>", "docs/contracts/http-apis"),
        json: {
            description: "The OpenCore MES HTTP APIs' contract (1.0, /ai/v1 and /svc/v1): its specification, OpenAPI schema, surface and kit",
            keywords: ["opencore-mes", "openapi", "api", "contract", "conformance"],
            homepage: `${REPO}/tree/main/docs/contracts/http-apis`,
            ...common("docs/contracts/http-apis"),
            exports: { ".": "./kit.mjs", "./kit.mjs": "./kit.mjs", "./surface.mjs": "./surface.mjs", "./schema.json": "./schema.json" },
            bin: { "http-apis-kit": "kit.mjs" },
        },
    },
};

mkdirSync(OUT, { recursive: true });
let failed = false;
for (const [key, p] of Object.entries(PACKAGES)) {
    if (only && !only.includes(key)) continue;
    const bad = p.files.filter(([from]) => PRIVATE.test(from));
    const missing = p.files.filter(([from]) => !existsSync(path.join(ROOT, from)));
    if (bad.length || missing.length) {
        console.error(`✗ ${p.name}: ${bad.map(([f]) => `${f} is private`).concat(missing.map(([f]) => `${f} is missing${f.startsWith("node_modules/") ? " (npm ci)" : ""}`)).join("; ")}`);
        failed = true;
        continue;
    }
    const stage = path.join(OUT, key);
    rmSync(stage, { recursive: true, force: true });
    for (const [from, to] of [...p.files, ["LICENSE", "LICENSE"], ["NOTICE", "NOTICE"]]) {
        const dest = path.join(stage, to);
        mkdirSync(path.dirname(dest), { recursive: true });
        copyFileSync(path.join(ROOT, from), dest);
        chmodSync(dest, statSync(path.join(ROOT, from)).mode & 0o777);
    }
    if (p.readme) writeFileSync(path.join(stage, "README.md"), p.readme);
    writeFileSync(path.join(stage, "package.json"), `${JSON.stringify({ name: p.name, version: p.version, ...p.json }, null, 2)}\n`);
    const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", OUT], { cwd: stage, encoding: "utf8" }));
    console.log(`✓ ${p.name}@${p.version}: ${packed.entryCount} files, ${(packed.size / 1024).toFixed(0)} kB → ${path.relative(ROOT, path.join(OUT, packed.filename))}`);
}
if (failed) process.exit(1);
console.log(`\nNothing is published. To publish, a person checks the tarballs, then, in each folder of ${path.relative(ROOT, OUT)}/: npm publish --access public`);
