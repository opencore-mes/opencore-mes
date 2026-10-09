// Embedding (§37, docs/contracts/embedding), end to end: a plant that names no site is framed by none
// (frame-ancestors 'none', X-Frame-Options: DENY); one that names a site lets that one frame it and
// no other, keeps the embedding kit, and tells its pages which origins they may talk to.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/embed.mjs   (after a reset)
import pg from "pg";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { runEmbedKit } from "../../../docs/contracts/embedding/kit.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const apps = [];
const SITE = "https://trainings.example.com";
try {
    const start = async (embedOrigins) => { const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, signIn: { picker: true, passwords: true }, ...(embedOrigins ? { embedOrigins } : {}) }); apps.push(app); return (await app.listen({ port: 0 })).url; };
    const plain = await start(null);
    const framed = await start([SITE]);
    const page = async (url) => { const res = await fetch(`${url}/login`, { redirect: "manual" }); return { status: res.status, csp: res.headers.get("content-security-policy") ?? "", xfo: res.headers.get("x-frame-options"), html: await res.text() }; };

    const p = await page(plain);
    step("a plant naming no site: its pages may be in no frame (frame-ancestors 'none', X-Frame-Options: DENY), and say nothing of embedding",
        p.status === 200 && /frame-ancestors 'none'/.test(p.csp) && p.xfo === "DENY" && !/"embed":/.test(p.html), { status: p.status, csp: p.csp, xfo: p.xfo });
    const f = await page(framed);
    step("a plant naming a site: frame-ancestors names it alone, X-Frame-Options left out, and the page knows the origin it may talk to",
        f.status === 200 && f.csp.includes(`frame-ancestors ${SITE}`) && !/frame-ancestors[^;]*'none'/.test(f.csp) && f.xfo === null && f.html.includes(`"embed":["${SITE}"]`), { csp: f.csp, xfo: f.xfo });

    const kit = await runEmbedKit({ url: framed, origin: SITE });
    step("the embedding kit passes for the site it names", kit.ok, kit.steps.filter((s) => !s.ok));
    const other = await runEmbedKit({ url: framed, origin: "https://elsewhere.example.com" });
    step("…and fails for another site, saying which step", !other.ok && other.steps.some((s) => !s.ok && /names the origin/.test(s.name)), other.steps);
    const none = await runEmbedKit({ url: plain, origin: SITE });
    step("…and for a plant that names none (X-Frame-Options refuses the frame)", !none.ok && none.steps.some((s) => !s.ok && /X-Frame-Options/.test(s.name)), none.steps);

    const bridge = await fetch(`${framed}/app/mes/client/embed.js`);
    const code = await bridge.text();
    step("the bridge is served with the app's modules, and reads messages only from its parent at an allowed origin",
        bridge.ok && /event\.source !== window\.parent \|\| !origins\.includes\(event\.origin\)/.test(code), bridge.status);
} catch (error) {
    step("the suite ran to the end", false, error?.stack ?? String(error));
} finally {
    for (const app of apps) await app.close?.().catch(() => {});
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
