// UI guides (§33), end to end: the guides of the release served to anyone signed in, by key; an
// unknown key or one that reaches out of the guides' folder refused in words; nobody signed in, none.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/guides.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
let app = null;

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    const { url: mes } = await app.listen({ port: 0 });
    const sid = `gd-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, 'olga', now() + interval '1 hour')", [sid]);
    const call = async (name, args, cookie = `mes_session=${sid}`) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status };
    };
    const keys = readdirSync(new URL("../guides/", import.meta.url)).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5));
    const all = await Promise.all(keys.map((key) => call("guides.get", { key })));
    step(`every guide of the release served to an operator (${keys.join(", ")})`, all.every((g, i) => g.key === keys[i] && /<article data-title=/.test(g.html)), all.map((g) => g.error ?? g.key));
    const unknown = await call("guides.get", { key: "no-such-page" });
    step("an unknown guide is refused, in words", unknown.status === 404 && /no guide for this page yet/.test(unknown.error), unknown);
    const out = await Promise.all(["../app", "..%2Fapp", "flow-designer.html", "/etc/passwd", "Flow-Designer"].map((key) => call("guides.get", { key })));
    step("a key that reaches out of the guides' folder, or is not a guide's name, is refused", out.every((r) => r.status === 404), out);
    const anon = await call("guides.get", { key: keys[0] }, null);
    step("nobody signed in: no guide", anon.status >= 400 && !anon.html, anon);
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
