// The site served locally as Caddy serves it (ops/demo/Caddyfile): /design is design.html, and the same
// Content-Security-Policy, so what is checked here is what opencoremes.com will do. For a look, never deployed.
//
//   node site/src/serve.mjs [port]      http://127.0.0.1:9180
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 9180);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".webp": "image/webp" };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (path.includes("..") || path.startsWith("/src")) { res.writeHead(404); return res.end(); }
    for (const p of [path === "/" ? "/index.html" : path, `${path}.html`]) {
        try {
            const body = await readFile(ROOT + p);
            res.writeHead(200, { "content-type": TYPES[extname(p)] ?? "application/octet-stream", "content-security-policy": CSP });
            return res.end(body);
        } catch { /* the next way to read it */ }
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
}).listen(PORT, "127.0.0.1", () => console.log(`site on http://127.0.0.1:${PORT}`));
