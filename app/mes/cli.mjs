#!/usr/bin/env node
// The `opencore-mes` command, for OpenCore MES installed from npm (@opencore-mes/server): a plant folder
// holds what an installation keeps (its settings in .env, its suites, its event log), and the package
// holds the code, written to by nothing. In a checkout, the npm scripts do the same (package.json).
//
//   npx @opencore-mes/server init [folder]   a plant folder: .env (settings, commented), suites/, .local/
//   opencore-mes start                       the server, with the folder's .env (from inside the folder)
//   opencore-mes db migrate                  the database brought up to date (the server does it at start)
//   opencore-mes db reset --yes              the database made again from the seed: everything in it lost
//   opencore-mes token <user> "<name>"       a token for an integration user (§15.2)
//   opencore-mes password <user> --url <site>  a one-time link to set a person's password (§8.2)
//   opencore-mes version
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(APP, "../..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const [command, ...rest] = process.argv.slice(2);
const plant = process.cwd();

// What the server reads, from the plant folder: its .env, its suites, its event log.
const run = (script, args = []) => new Promise((resolve) => {
    const env = { ...process.env, SUITES_DIR: process.env.SUITES_DIR ?? path.join(plant, "suites"), EVENT_LOG_DIR: process.env.EVENT_LOG_DIR ?? path.join(plant, ".local", "events") };
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
`;

const usage = `OpenCore MES ${pkg.version}

  opencore-mes init [folder]          make a plant folder: .env, suites/, .local/
  opencore-mes start                  start the server (from inside the plant folder)
  opencore-mes db migrate             bring the database up to date
  opencore-mes db reset --yes         make the database again from the seed (everything in it is lost)
  opencore-mes token <user> "<name>"  a token for an integration user
  opencore-mes password <user> --url <site>   a one-time link to set a person's password
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
} else if (command === "version" || command === "--version" || command === "-v") {
    console.log(pkg.version);
} else {
    console.log(usage);
    process.exitCode = command && !["help", "--help", "-h"].includes(command) ? 2 : 0;
}
