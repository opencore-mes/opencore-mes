#!/usr/bin/env node
// The `opencore-mes` command, for OpenCore MES installed from npm (@opencore-mes/server): a plant folder
// holds what an installation keeps (its settings in .env, its suites, its event log), and the package
// holds the code, written to by nothing. In a checkout, the npm scripts do the same (package.json).
//
//   npx @opencore-mes/server init [folder]   a plant folder: .env (settings, commented), suites/, .local/
//   opencore-mes start                       the server, with the folder's .env (from inside the folder)
//   opencore-mes db migrate                  the database brought up to date (the server does it at start)
//   opencore-mes db reset --yes              the database made again from the seed: everything in it lost
//   opencore-mes db reset --yes --empty      a plant's own new installation, nobody in it
//   opencore-mes admin <id> "<name>"         its first administrator (db/admin.mjs), who sets the rest up
//   opencore-mes token <user> "<name>"       a token for an integration user (§15.2)
//   opencore-mes password <user> --url <site>  a one-time link to set a person's password (§8.2)
//   opencore-mes suite login | install <name>[@version] [--from <file>] | list | update [<name>]
//                      | remove <name> | use <name>[@version]   suites from the suites registry (§29.7)
//   opencore-mes version
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import * as suites from "./suite-install.mjs";

const APP = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(APP, "../..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const [command, ...rest] = process.argv.slice(2);
const plant = process.cwd();

// What the server reads, from the plant folder: its .env, its suites, its event log.
const run = (script, args = []) => new Promise((resolve) => {
    const env = { ...process.env, SUITES_DIR: process.env.SUITES_DIR ?? readEnv().SUITES_DIR ?? path.join(plant, "suites"), EVENT_LOG_DIR: process.env.EVENT_LOG_DIR ?? path.join(plant, ".local", "events") };
    const child = spawn(process.execPath, [`--env-file-if-exists=${path.join(plant, ".env")}`, path.join(APP, script), ...args], { cwd: plant, env, stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    child.on("exit", (code, signal) => resolve(signal ? 1 : code ?? 0));
});

const ENV = `# OpenCore MES: this installation's settings (app/mes/server.mjs lists them all). Never commit this file.
# The database (PostgreSQL); the local socket by default.
DATABASE_URL=postgres:///opencore_mes
# Where it listens.
PORT=9090
HOST=127.0.0.1
# Production: a snapshot of the pages, Secure cookies, no sign-in picker. Leave it out to try it.
# PROD=1
# BUILD=1
# Sign-in: single sign-on, the plant's directory, or passwords of its own (with a second factor).
# OIDC_ISSUER=https://login.example.com
# OIDC_CLIENT_ID=opencore-mes
# LDAP_URL=ldaps://dc.example.local:636
# The designer's copilot (Claude): leave it out for none.
# AI_PROVIDER=anthropic
# ANTHROPIC_API_KEY=
# The plant's time zone, for schedules that name none.
# PLANT_TZ=Europe/Paris
# A new plant set up by its engineers: until People & departments ends setup, a designer's change executes on
# their signature, without review or approval (each marked and audited). Before the first start only.
# SETUP=1
# Suites: installed with \`opencore-mes suite install <name>\` into suites/, from the suites store's registry
# unless another is named (a mirror inside the plant).
# SUITES_REGISTRY=https://suites.opencoremes.com/
`;

const usage = `OpenCore MES ${pkg.version}

  opencore-mes init [folder]          make a plant folder: .env, suites/, .local/
  opencore-mes start                  start the server (from inside the plant folder)
  opencore-mes db migrate             bring the database up to date
  opencore-mes db reset --yes         make the database again from the seed (everything in it is lost)
  opencore-mes db reset --yes --empty   a plant's own new installation: nobody in it yet
  opencore-mes admin <id> "<name>"    the first administrator of an empty installation (opens setup)
  opencore-mes token <user> "<name>"  a token for an integration user
  opencore-mes password <user> --url <site>   a one-time link to set a person's password
  opencore-mes suite login            set this plant's licence token for the suites registry
  opencore-mes suite install <name>[@version] [--from <file>.tgz]   install or replace a suite
  opencore-mes suite list             the suites installed, and the versions kept
  opencore-mes suite update [<name>]  install the newest version of each suite (or one)
  opencore-mes suite remove <name>    remove a suite (kept, with its designs and tables)
  opencore-mes suite use <name>[@version]   bring back a kept version
  opencore-mes version

Settings are the plant folder's .env (app/mes/server.mjs lists them). Docs: https://github.com/opencore-mes/opencore-mes`;

if (command === "init") {
    const dir = path.resolve(rest[0] ?? ".");
    mkdirSync(path.join(dir, "suites"), { recursive: true });
    mkdirSync(path.join(dir, ".local", "events"), { recursive: true });
    if (existsSync(path.join(dir, ".env"))) console.log(`${path.join(dir, ".env")} is there already: left as it is.`);
    else writeFileSync(path.join(dir, ".env"), ENV, { mode: 0o600 });
    if (!existsSync(path.join(dir, ".gitignore"))) writeFileSync(path.join(dir, ".gitignore"), ".env\n.local/\nnode_modules/\n");
    console.log(`A plant folder at ${dir}:\n  .env       its settings (the database: ${/DATABASE_URL=(.*)/.exec(readFileSync(path.join(dir, ".env"), "utf8"))?.[1] ?? "?"})\n  suites/    the suites it runs, each a folder\n  .local/    what it writes (its event log)\nNext, in it: opencore-mes db reset --yes, then opencore-mes start`);
} else if (command === "start") {
    process.exitCode = await run("server.mjs", rest);
} else if (command === "db" && rest[0] === "migrate") {
    process.exitCode = await run("db/migrate.mjs", rest.slice(1));
} else if (command === "db" && rest[0] === "reset") {
    if (!rest.includes("--yes")) {
        console.error("db reset makes the database again from the seed: everything in it is lost. Say so: opencore-mes db reset --yes");
        process.exitCode = 2;
    } else process.exitCode = await run("db/reset.mjs", rest.slice(1).filter((a) => a !== "--yes"));
} else if (command === "token") {
    process.exitCode = await run("db/token.mjs", rest);
} else if (command === "password") {
    process.exitCode = await run("db/password.mjs", rest);
} else if (command === "admin") {
    process.exitCode = await run("db/admin.mjs", rest);
} else if (command === "suite") {
    process.exitCode = await suite(rest);
} else if (command === "version" || command === "--version" || command === "-v") {
    console.log(pkg.version);
} else {
    console.log(usage);
    process.exitCode = command && !["help", "--help", "-h"].includes(command) ? 2 : 0;
}

// `opencore-mes suite …` (suite-install.mjs): suites in the plant folder's suites/ (SUITES_DIR), from the
// registry SUITES_REGISTRY names (the suites store's unless set), npm working in .local/suites.
async function suite([sub, ...args]) {
    const env = { ...readEnv(), ...process.env };
    const where = { dir: path.resolve(env.SUITES_DIR ?? path.join(plant, "suites")), work: path.join(plant, ".local", "suites"), registry: env.SUITES_REGISTRY ?? suites.REGISTRY };
    const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
    const restart = "Restart OpenCore MES to load it (opencore-mes start, or the service that runs it).";
    try {
        if (sub === "login") {
            const token = flag("token") ?? await hidden(`Licence token for ${where.registry} (from your account at the suites store): `);
            const { file } = await suites.login({ ...where, token: token.trim() });
            console.log(`Signed in to ${where.registry}: the token is kept in ${path.relative(plant, file)} (this plant only).`);
        } else if (sub === "install") {
            const from = flag("from");
            const [name, range] = (args[0] ?? "").split("@");
            const done = await suites.install({ ...where, name, range: range || "latest", from });
            console.log(`${done.name} ${done.version} installed in ${path.relative(plant, path.join(where.dir, done.name)) || "."}${done.replaced ? `; ${done.replaced.version} kept in ${done.replaced.kept}` : ""}. ${restart}`);
        } else if (sub === "list" || sub === undefined) {
            const list = suites.installed(where.dir);
            if (!list.length) console.log(`No suite is installed in ${where.dir}. Install one: opencore-mes suite install <name>`);
            for (const s of list) console.log(`${s.name.padEnd(20)} ${s.linked ? "linked (development)" : s.version ?? "removed"}${s.kept.length ? `   kept: ${s.kept.join(", ")}` : ""}`);
        } else if (sub === "update") {
            const list = (await suites.outdated(where)).filter((s) => !args[0] || s.name === args[0]);
            if (args[0] && !list.length) throw Object.assign(new Error(`No suite ${args[0]} is installed from the registry.`), { person: true });
            let any = false;
            for (const s of list) {
                if (s.refused) { console.log(`${s.name} ${s.version}: not updated. ${s.refused} It stays installed as it is.`); continue; }
                if (s.newest === s.version) { console.log(`${s.name} ${s.version}: the newest`); continue; }
                const done = await suites.install({ ...where, name: s.name, range: s.newest });
                console.log(`${s.name} ${s.version} → ${done.version}; ${done.replaced.version} kept in ${done.replaced.kept}`);
                any = true;
            }
            if (any) console.log(restart);
        } else if (sub === "remove") {
            const done = await suites.remove({ ...where, name: args[0] });
            console.log(`${args[0]} ${done.version} removed: kept in ${done.kept}. Its designs and tables stay; what needs it says so until it is back. ${restart.replace("load it", "let it go")}`);
        } else if (sub === "use") {
            const [name, version] = (args[0] ?? "").split("@");
            const done = await suites.use({ ...where, name, version: version || null });
            console.log(`${name} ${done.version} is back${done.replaced ? `; ${done.replaced.version} kept in ${done.replaced.kept}` : ""}. ${restart}`);
        } else {
            console.log(usage);
            return 2;
        }
        return 0;
    } catch (error) {
        if (!error.person) throw error;
        console.error(error.message);
        return 1;
    }
}

// The plant folder's .env, as settings (only what the suite commands read from it).
function readEnv() {
    try {
        return Object.fromEntries(readFileSync(path.join(plant, ".env"), "utf8").split("\n").map((l) => /^\s*(SUITES_DIR|SUITES_REGISTRY)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^(["'])(.*)\1$/, "$2")]));
    } catch { return {}; }
}

// A prompt whose answer is not echoed (a token typed or pasted).
function hidden(question) {
    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        rl._writeToOutput = (text) => { if (text.startsWith(question)) process.stdout.write(question); };
        rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
    });
}
