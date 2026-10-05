// The installable app and staying on the server's version (DESIGN.md §14), against a running server:
// the manifest, the service worker (its scope header), the offline page and the icons are served from
// the root with their types; every page names its build and links the manifest; /version says the
// server's build.
//
//   DATABASE_URL=postgres:///openmes_poc node app/mes/test/pwa.mjs
import pg from "pg";
import { fromPg } from "../../../src/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const app = await createApp({ db: fromPg(pool), dev: false, build: "pwa-test-7", outboxEveryMs: 0, schedulerEveryMs: 0 });
const { url } = await app.listen({ port: 0 });
try {
    await pool.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ('pwa-test', 'sam', now() + interval '10 minutes') ON CONFLICT DO NOTHING");
    const get = async (path) => { const r = await fetch(`${url}${path}`, { headers: { cookie: "mes_session=pwa-test" } }); return { status: r.status, type: r.headers.get("content-type"), headers: r.headers, text: await r.text() }; };
    const manifest = await get("/manifest.webmanifest");
    const m = JSON.parse(manifest.text);
    step("the manifest: an installable, standalone app with its icons", manifest.status === 200 && manifest.type.startsWith("application/manifest+json") && m.display === "standalone" && m.start_url === "/" && m.icons.some((i) => i.purpose === "maskable"), { type: manifest.type });
    const icons = await Promise.all(m.icons.map((i) => get(i.src)));
    step("every icon the manifest names is served, with its type", icons.every((r, k) => r.status === 200 && r.type === m.icons[k].type), icons.map((r) => r.status));
    const sw = await get("/sw.js");
    step("the service worker, from the root, allowed the whole site, never kept stale", sw.status === 200 && sw.type.startsWith("text/javascript") && sw.headers.get("service-worker-allowed") === "/" && /no-cache/.test(sw.headers.get("cache-control") ?? ""), { cache: sw.headers.get("cache-control") });
    step("…and it never answers the API, live streams, sign-in or /version from a cache", /NETWORK_ONLY = \/\^\\\/\(api\|svc\|ai\|version\|healthz\|login\|logout/.test(sw.text));
    const offline = await get("/offline.html");
    step("the offline page, which comes back by itself when the server answers", offline.status === 200 && offline.type.startsWith("text/html") && /fetch\("\/version"/.test(offline.text));
    const page = await get("/");
    step("every page names the build that wrote it, and links the manifest and icons", /<meta name="mes-build" content="pwa-test-7">/.test(page.text) && /rel="manifest" href="\/manifest.webmanifest"/.test(page.text) && /rel="apple-touch-icon"/.test(page.text), page.text.match(/<meta name="mes-build"[^>]*>/)?.[0]);
    const version = JSON.parse((await get("/version")).text);
    step("/version says the same build, which is what a page compares", version.build === "pwa-test-7", version);
} catch (error) {
    step("unexpected", false, { message: error.message });
} finally {
    await app.close();
    await pool.query("DELETE FROM mes.sessions WHERE id = encode(sha256(convert_to('pwa-test', 'UTF8')), 'hex')");
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
console.log(JSON.stringify(steps, null, 1));
console.log(failed.length ? `\n${failed.length} step(s) FAILED` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
