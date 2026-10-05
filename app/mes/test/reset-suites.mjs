// A reset with the suites' design packs (reset.mjs --blank --suites, what the public demo runs every
// night), end to end with the open fixture (test/fixtures/suites/hello):
//   1. The pack's extension of the built-in Person is applied once Person is published: its field is
//      there, marked as the suite's, in a form section of its own.
//   2. Its sample on a record it does not make (Olga's Person, found and set) is loaded, through the
//      record services, and audited as the seed's designer.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/reset-suites.mjs
// It resets a database of its own beside that one (its name + "_suites"), leaving that one as it is.
import pg from "pg";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromPg } from "../../../src/server/db.js";

const base = process.env.DATABASE_URL ?? "postgres:///openmes_test";
const url = `${base}_suites`;
if (!/test/i.test(url)) { console.error(`refused: ${url} does not look like a test database`); process.exit(1); }
const reset = await new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../db/reset.mjs", import.meta.url)), "--blank", "--suites"], {
        env: { ...process.env, DATABASE_URL: url, SUITES_DIR: fileURLToPath(new URL("./fixtures/suites/", import.meta.url)) }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
});

const pool = new pg.Pool({ connectionString: url });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
try {
    step("the reset ran, with the hello suite's pack", reset.code === 0 && /suite hello: Hello designs 1\.0\.0 seeded/.test(reset.out), reset.out);
    const [person] = await db.query("SELECT body FROM mes.definitions WHERE object = 'person' AND status = 'published'");
    const field = person?.body.fields.hello_nickname;
    step("its extension of the built-in Person is applied: the field, marked as the suite's, in a section of its own",
        person?.body.builtIn === true && field?.type === "string" && field.suite === "hello" && person.body.form.sections.some((s) => s.label === "Hello" && s.fields.includes("hello_nickname")), person?.body);
    const [olga] = await db.query("SELECT id, data FROM mes.records WHERE object = 'person' AND data->>'user' = 'olga'");
    const audited = olga ? await db.query("SELECT actor, action FROM mes.audit_log WHERE object = 'person' AND record_id = $1 ORDER BY seq", [olga.id]) : [];
    step("its sample on Olga's Person is loaded through the record services, as the seed's designer, audited",
        olga?.data.hello_nickname === "Ollie" && olga.data.name === "Olga Ortiz" && audited.some((a) => a.action === "update" && a.actor !== "platform:organization"), { olga: olga?.data, audited });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
