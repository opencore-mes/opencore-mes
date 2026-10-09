// The test pipeline: every automated check of Juris and the MES, in order, against a test database
// of its own, with one answer at the end. Developers run it before pushing; CI runs it on every push.
//
//   npm run test:all            syntax, unit tests, then the end-to-end suites against a fresh database
//   npm run test:all -- --full  and a short load test
//   npm run test:all -- --quick syntax and unit tests only (no database)
//
//   TEST_DATABASE_URL   the database it resets and uses (default postgres:///openmes_test). It is
//                       dropped and made again on every run, so its name must contain "test": the
//                       pipeline refuses to reset anything else (your development database is safe).
//
// Stages stop at the first failure (the rest are reported as skipped), and a failed stage prints the
// end of its output. What stays manual: the replica and cluster checks (test/stale.mjs,
// test/cluster.mjs), which need a replica and several instances (app/mes/README.md).
import { spawn } from "node:child_process";
import { readdir, mkdtemp, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = new Set(process.argv.slice(2));
const QUICK = args.has("--quick");
const FULL = args.has("--full");
const DB = process.env.TEST_DATABASE_URL ?? "postgres:///openmes_test";
const dbName = new URL(DB.replace(/^postgres:\/\/\//, "postgres://localhost/")).pathname.slice(1);
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);

// Runs a command: { code, out } (stdout and stderr together), or rejects past `timeoutMs`.
function run(cmd, argv, { env = {}, timeoutMs = 300_000 } = {}) {
    return new Promise((resolve) => {
        const child = spawn(cmd, argv, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { out += d; });
        const timer = setTimeout(() => { out += `\n(timed out after ${timeoutMs / 1000} s)`; child.kill("SIGKILL"); }, timeoutMs);
        child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
    });
}

async function files(dir, test) {
    const out = [];
    for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "node_modules") out.push(...(await files(rel, test))); } else if (test(entry.name)) out.push(rel);
    }
    return out;
}

// A server of the pipeline's own on the test database, for the suites that call one over HTTP. Its
// trigger worker is off (OUTBOX=0), so a suite that runs triggers is the only instance claiming them.
async function startServer() {
    // Its event log in a directory of its own, never beside a development server's (one process per
    // instance name and directory).
    const events = await mkdtemp(path.join(os.tmpdir(), "opencore-mes-pipeline-events-"));
    const child = spawn(process.execPath, ["app/mes/server.mjs"], {
        cwd: ROOT, env: { ...process.env, HOST: "127.0.0.1", EVENT_LOG_DIR: events, DATABASE_URL: DB, PORT: "0", PROD: "1", BUILD: "pipeline", OUTBOX: "0", AI_PROVIDER: "", ANTHROPIC_API_KEY: "", BUS: "", REPLICA_URL: "" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the server did not start:\n${out}`)), 20_000);
        const hear = (d) => {
            out += d;
            const m = /listening on (http:\/\/\S+)/.exec(out);
            if (m) { clearTimeout(timer); resolve(m[1]); }
        };
        child.stdout.on("data", hear);
        child.stderr.on("data", hear);
        child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`the server exited (${code}):\n${out}`)); });
    });
    child.removeAllListeners("exit");
    return { url, stop: () => new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); }) };
}

// Each stage: { name, needs: "db" | "server" | null, run() → { ok, detail?, out? } }.
const node = (...argv) => run(process.execPath, argv);
const passedLine = (out) => /all \d+ steps passed/.exec(out)?.[0] ?? null;
const nodeTest = (out) => {
    const pass = /ℹ pass (\d+)/.exec(out)?.[1];
    const fail = /ℹ fail (\d+)/.exec(out)?.[1];
    return pass === undefined ? null : `${pass} passed${Number(fail) ? `, ${fail} failed` : ""}`;
};
const script = (file, env = {}) => async (ctx) => {
    const r = await run(process.execPath, [file], { env: { DATABASE_URL: DB, ...(ctx.server ? { BASE: ctx.server.url } : {}), ...env } });
    return { ok: r.code === 0 && Boolean(passedLine(r.out)), detail: passedLine(r.out) ?? `exit ${r.code}`, out: r.out };
};

// The suites installed under suites/ (DESIGN.md §29): each one's own tests run too, its unit tests
// (test/*.test.mjs) with the platform's and its end-to-end scripts (test/*.mjs) after the platform's,
// against the same test database. The pipeline knows no suite by name.
const installed = [];
for (const entry of await readdir(path.join(ROOT, "suites"), { withFileTypes: true }).catch(() => [])) {
    const dir = path.join("suites", entry.name);
    if (!(await access(path.join(ROOT, dir, "suite.mjs")).then(() => true, () => false))) continue;
    const tests = (await readdir(path.join(ROOT, dir, "test")).catch(() => [])).filter((n) => n.endsWith(".mjs")).sort();
    installed.push({ name: entry.name, unit: tests.filter((n) => n.endsWith(".test.mjs")).map((n) => path.join(dir, "test", n)), e2e: tests.filter((n) => !n.endsWith(".test.mjs")).map((n) => path.join(dir, "test", n)) });
}

const stages = [
    {
        name: "syntax", needs: null,
        async run() {
            const all = [...(await files("app", (n) => /\.(m?js)$/.test(n))), ...(await files("tests", (n) => n.endsWith(".mjs")))];
            const bad = [];
            for (let i = 0; i < all.length; i += 16) {
                const batch = all.slice(i, i + 16);
                const results = await Promise.all(batch.map((f) => node("--check", f).then((r) => ({ f, r }))));
                for (const { f, r } of results) if (r.code !== 0) bad.push(`${f}\n${r.out.trim()}`);
            }
            return { ok: !bad.length, detail: `${all.length} files${bad.length ? `, ${bad.length} with errors` : ""}`, out: bad.join("\n\n") };
        },
    },
    {
        name: "mes unit", needs: null,
        async run() {
            const r = await node("--test", ...(await files("app/mes/test", (n) => n.endsWith(".test.mjs"))));
            return { ok: r.code === 0, detail: nodeTest(r.out) ?? `exit ${r.code}`, out: r.out };
        },
    },
    ...installed.filter((x) => x.unit.length).map((x) => ({
        name: `suite ${x.name}: unit`, needs: null,
        async run() {
            const r = await node("--test", ...x.unit);
            return { ok: r.code === 0, detail: nodeTest(r.out) ?? `exit ${r.code}`, out: r.out };
        },
    })),
    {
        name: `database (${dbName}, reset)`, needs: "db",
        async run() {
            if (!/test/i.test(dbName)) return { ok: false, detail: `refused: "${dbName}" does not look like a test database (its name must contain "test")` };
            const r = await run(process.execPath, ["app/mes/db/reset.mjs"], { env: { DATABASE_URL: DB } });
            return { ok: r.code === 0, detail: r.code === 0 ? "schema and seed loaded" : `exit ${r.code}`, out: r.out };
        },
    },
    { name: "ai design api (e2e)", needs: "server", run: script("app/mes/test/ai-agent.mjs") },
    { name: "copilot loop (e2e)", needs: "db", run: script("app/mes/test/copilot-agent.mjs") },
    { name: "services & connections (e2e)", needs: "db", run: script("app/mes/test/integration.mjs") },
    { name: "the HTTP APIs' contract: versions, the API kit, notice before a change (e2e)", needs: "db", run: script("app/mes/test/api-versions.mjs") },
    { name: "a service runs a transaction (e2e)", needs: "db", run: script("app/mes/test/service-transactions.mjs") },
    { name: "archive & restore (e2e)", needs: "db", run: script("app/mes/test/archive.mjs") },
    { name: "what a person typed, trimmed wherever it enters (e2e)", needs: "db", run: script("app/mes/test/trimming.mjs") },
    { name: "sensitive fields: masked, shown with a reason, audited (e2e)", needs: "db", run: script("app/mes/test/sensitive.mjs") },
    { name: "derived fields: through references, kept in step, audited (e2e)", needs: "db", run: script("app/mes/test/derived.mjs") },
    { name: "certifications: what an object's access requires, everywhere it is read (e2e)", needs: "db", run: script("app/mes/test/restricted.mjs") },
    { name: "files on records and screens: video, PDF in the page, read through the record (e2e)", needs: "db", run: script("app/mes/test/media.mjs") },
    { name: "a guide's steps done: a click, a value, a photo, the equipment; a guide following a route (e2e)", needs: "db", run: script("app/mes/test/guide-steps.mjs") },
    { name: "database outage (e2e)", needs: "db", run: script("app/mes/test/outage.mjs") },
    { name: "scheduler (e2e)", needs: "db", run: script("app/mes/test/scheduler.mjs") },
    { name: "analytics (e2e)", needs: "db", run: script("app/mes/test/analytics.mjs") },
    { name: "queries (e2e)", needs: "db", run: script("app/mes/test/query.mjs") },
    { name: "installable app (e2e)", needs: "db", run: script("app/mes/test/pwa.mjs") },
    { name: "database upgrades (e2e)", needs: "db", run: script("app/mes/test/migrate.mjs") },
    { name: "excel import / export (e2e)", needs: "db", run: script("app/mes/test/transfer.mjs") },
    { name: "forms: several values, requiredWhen (e2e)", needs: "db", run: script("app/mes/test/forms.mjs") },
    { name: "transactions (e2e)", needs: "db", run: script("app/mes/test/transactions.mjs") },
    { name: "signatures by two people (e2e)", needs: "db", run: script("app/mes/test/dual-sign.mjs") },
    { name: "screens (e2e)", needs: "db", run: script("app/mes/test/screens.mjs") },
    { name: "approval of record changes (e2e)", needs: "db", run: script("app/mes/test/record-approval.mjs") },
    { name: "people & departments (e2e)", needs: "db", run: script("app/mes/test/organization.mjs") },
    { name: "a desktop's page at sign-in (e2e)", needs: "db", run: script("app/mes/test/desktops.mjs") },
    { name: "reports and the analytics copilot (e2e)", needs: "db", run: script("app/mes/test/reports.mjs") },
    { name: "charts: every kind, in reports and screens (e2e)", needs: "db", run: script("app/mes/test/charts.mjs") },
    { name: "kept prompts, schedules, a summary of reports (e2e)", needs: "db", run: script("app/mes/test/report-prompts.mjs") },
    { name: "the same report each run, a layout made from a report (e2e)", needs: "db", run: script("app/mes/test/report-pinned.mjs") },
    { name: "floor layouts, pictures, image fields (e2e)", needs: "db", run: script("app/mes/test/floor.mjs") },
    { name: "attachments: copilots, kept prompts, a report's media (e2e)", needs: "db", run: script("app/mes/test/attachments.mjs") },
    { name: "the test sandbox: changes under test together (e2e)", needs: "db", run: script("app/mes/test/test-sandbox.mjs") },
    { name: "rolling a change back (e2e)", needs: "db", run: script("app/mes/test/rollback.mjs") },
    { name: "emergency changes: one signature, reviewed afterwards, overdue and flagged (e2e)", needs: "db", run: script("app/mes/test/emergency.mjs") },
    { name: "setup: changes on their designer's signature until it ends, opened at install or by governance (e2e)", needs: "db", run: script("app/mes/test/setup.mjs") },
    { name: "the first administrator of an empty installation (e2e)", needs: "db", run: script("app/mes/test/first-admin.mjs") },
    { name: "approval levels: full, one approval, none (e2e)", needs: "db", run: script("app/mes/test/approval-levels.mjs") },
    { name: "setup codes, the move to the directory, the sign-in id as the plant calls it (e2e)", needs: "db", run: script("app/mes/test/setup-codes.mjs") },
    { name: "the built-in Person, locks (e2e)", needs: "db", run: script("app/mes/test/people.mjs") },
    { name: "sign-in: passwords, directory, single sign-on (e2e)", needs: "db", run: script("app/mes/test/auth.mjs") },
    { name: "sign-in hardened: sessions, password age, second factor, signatures, SSO simulator (e2e)", needs: "db", run: script("app/mes/test/auth-hardening.mjs") },
    { name: "retiring designs (e2e)", needs: "db", run: script("app/mes/test/retire.mjs") },
    { name: "lists page by page (e2e)", needs: "db", run: script("app/mes/test/lists.mjs") },
    { name: "the Database area: statements, plans, indexes built and dropped (e2e)", needs: "db", run: script("app/mes/test/database.mjs") },
    { name: "records a step finds, and a route's transaction at every step (e2e)", needs: "db", run: script("app/mes/test/every-step.mjs") },
    { name: "the use cases book against the designer's checks (e2e)", needs: "db", run: script("app/mes/test/usecases.mjs") },
    { name: "what a transaction's run locks: written records, and those it only reads (e2e)", needs: "db", run: script("app/mes/test/transaction-locks.mjs") },
    { name: "named queries as a reference's choices and a screen's table, kept in line (e2e)", needs: "db", run: script("app/mes/test/query-sources.mjs") },
    { name: "transactions and named queries as web services, every call counted (e2e)", needs: "db", run: script("app/mes/test/web-designs.mjs") },
    { name: "the navigator: by search, favorites (e2e)", needs: "db", run: script("app/mes/test/navigator.mjs") },
    { name: "dates, times and numbers (e2e)", needs: "db", run: script("app/mes/test/formats.mjs") },
    { name: "co-designers and object names (e2e)", needs: "db", run: script("app/mes/test/codesign.mjs") },
    { name: "public demo mode (e2e)", needs: "db", run: script("app/mes/test/demo.mjs") },
    { name: "themes: light, dark, the plant's (e2e)", needs: "db", run: script("app/mes/test/themes.mjs") },
    { name: "pop-ups and dialogs (e2e)", needs: "db", run: script("app/mes/test/popups.mjs") },
    { name: "transactions that create records, rows (e2e)", needs: "db", run: script("app/mes/test/create-steps.mjs") },
    { name: "design packs, screen tabs (e2e)", needs: "db", run: script("app/mes/test/packs.mjs") },
    { name: "viewing a live design (e2e)", needs: "db", run: script("app/mes/test/design-view.mjs") },
    { name: "the sandbox and scenarios (e2e)", needs: "db", run: script("app/mes/test/sandbox.mjs") },
    { name: "flows: routes (e2e)", needs: "db", run: script("app/mes/test/flows.mjs") },
    { name: "named queries: designed, tried, a plan's dropdown from one, a node script setting its context (e2e)", needs: "db", run: script("app/mes/test/named-queries.mjs") },
    { name: "UI guides (e2e)", needs: "db", run: script("app/mes/test/guides.mjs") },
    { name: "embedding: framed by the sites a plant names (e2e)", needs: "db", run: script("app/mes/test/embed.mjs") },
    { name: "data retention: periods, the purge, erasure (e2e)", needs: "db", run: script("app/mes/test/retention.mjs") },
    { name: "the audit chain verified: from a checkpoint, breaks found and reported (e2e)", needs: "db", run: script("app/mes/test/audit-verify.mjs") },
    { name: "the audit trail out of the application's reach: protected, still written, never changed (e2e)", needs: "db", run: script("app/mes/test/audit-protect.mjs") },
    { name: "suites: the extension point (e2e)", needs: "db", run: script("app/mes/test/suites.mjs") },
    { name: "suites: capabilities, steps, blocks, elements and schedules, and their removal (e2e)", needs: "db", run: script("app/mes/test/suite-extensions.mjs") },
    ...installed.flatMap((x) => x.e2e.map((file) => ({ name: `suite ${x.name}: ${path.basename(file, ".mjs")} (e2e)`, needs: "db", run: script(file) }))),
    // After the suites' own tests have filled their tables: removed and installed again, nothing of theirs is lost.
    { name: "suites removed and installed again keep their data (e2e)", needs: "db", run: script("app/mes/test/suite-reinstall.mjs") },
    { name: "blank training instance (e2e)", needs: "db", run: script("app/mes/test/blank.mjs") },
    { name: "a reset with the suites' packs (e2e)", needs: "db", run: script("app/mes/test/reset-suites.mjs") },
    { name: "input flows: keyboard entry, designed (e2e)", needs: "db", run: script("app/mes/test/input-flows.mjs") },
    { name: "several designs in one change (e2e)", needs: "db", run: script("app/mes/test/batch-changes.mjs") },
    { name: "a model file: export, import as a change, its records (e2e)", needs: "db", run: script("app/mes/test/model-file.mjs") },
    { name: "a screen parameter's search: part of a title, counted by state (e2e)", needs: "db", run: script("app/mes/test/screen-search.mjs") },
    { name: "who is at the screen: a badge's sign-in id, a check reading departments, Person grown by it once (e2e)", needs: "db", run: script("app/mes/test/scan-departments.mjs") },
    // Last of the database's suites: what the ones before wrote by hand to set their scenes, it accepts first.
    { name: "data integrity: seals, the tripwire, findings, non-conformance reports (e2e)", needs: "db", run: script("app/mes/test/integrity.mjs") },
    ...(FULL ? [{
        name: "load (50/s for 8 s)", needs: "server",
        async run(ctx) {
            const r = await run(process.execPath, ["app/mes/test/load.mjs", "50", "8", "30", "4"], { env: { DATABASE_URL: DB, BASE: ctx.server.url } });
            let report = null;
            try { report = JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1)); } catch { /* reported below */ }
            if (!report) return { ok: false, detail: "no report", out: r.out };
            const errors = Object.entries(report.statuses ?? {}).filter(([s]) => Number(s) >= 500).reduce((n, [, c]) => n + c, 0);
            const p95 = Number(report.latencyMs?.p95);
            return { ok: r.code === 0 && errors === 0 && p95 < 1000, detail: `${report.achievedPerSecond}/s, p95 ${report.latencyMs?.p95} ms, ${errors} server error(s)`, out: r.out };
        },
    }] : []),
].filter((s) => !QUICK || s.needs === null);

// ---- run ----
console.log(paint("1", `OpenCore MES test pipeline${QUICK ? " (quick)" : FULL ? " (full)" : ""}`) + paint("2", `  ·  node ${process.version}${QUICK ? "" : `  ·  ${dbName}`}`));
const started = Date.now();
const ctx = { server: null };
const results = [];
let failed = false;
try {
    for (const stage of stages) {
        if (failed) { results.push({ name: stage.name, state: "skipped" }); console.log(`  ${paint("2", "–")} ${stage.name} ${paint("2", "skipped")}`); continue; }
        const t = Date.now();
        let outcome;
        try {
            if (stage.needs === "server" && !ctx.server) ctx.server = await startServer();
            outcome = await stage.run(ctx);
        } catch (error) {
            outcome = { ok: false, detail: error.message.split("\n")[0], out: String(error.stack ?? error) };
        }
        const secs = ((Date.now() - t) / 1000).toFixed(1);
        results.push({ name: stage.name, state: outcome.ok ? "passed" : "failed", detail: outcome.detail, secs });
        console.log(`  ${outcome.ok ? paint("32", "✓") : paint("31", "✗")} ${stage.name.padEnd(34)} ${paint("2", `${String(outcome.detail ?? "").padEnd(34)} ${secs} s`)}`);
        if (!outcome.ok) {
            failed = true;
            const tail = String(outcome.out ?? "").trim().split("\n").slice(-40).join("\n");
            if (tail) console.log(paint("2", tail.replace(/^/gm, "      ")));
        }
    }
} finally {
    await ctx.server?.stop();
}
const total = ((Date.now() - started) / 1000).toFixed(1);
console.log(failed
    ? paint("31", `\nFAILED in ${total} s: ${results.find((r) => r.state === "failed").name}`)
    : paint("32", `\nall ${results.length} stages passed in ${total} s`));
process.exit(failed ? 1 : 0);
