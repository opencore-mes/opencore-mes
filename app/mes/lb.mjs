// A sticky load balancer for the proof of concept: in front of several OpenCore MES instances, it keeps
// each browser on one of them, because a Juris live stream and the subscribe calls that feed it must
// reach the same process (Juris README, "One worker per instance, behind a sticky balancer").
//
//   LB_PORT=3400 BACKENDS=127.0.0.1:3401,127.0.0.1:3402,127.0.0.1:3403 node app/mes/lb.mjs
//
// HTTPS: TLS_CERT and TLS_KEY (PEM files) make it answer over HTTPS. That is what tablets and phones
// on the network need to install the app and use its offline page (browsers allow a service worker
// only over HTTPS or on localhost), and what production's Secure session cookie needs. One instance
// behind it works too: BACKENDS=127.0.0.1:9090.
//
// A new browser is placed on the next healthy instance and given a `mes_node` cookie naming it; later
// requests follow the cookie. An instance that fails its /healthz is skipped, and a browser pinned to
// it is moved (its page reconnects its live stream there, as after any restart). Streams are piped
// through unbuffered. In production this is HAProxy, nginx or the cloud balancer, with the same rule.
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.LB_PORT ?? 3400);
const backends = (process.env.BACKENDS ?? "127.0.0.1:3401,127.0.0.1:3402").split(",").map((hostPort, i) => {
    const [host, port] = hostPort.split(":");
    return { name: `n${i + 1}`, host, port: Number(port), healthy: true, requests: 0 };
});
const COOKIE = "mes_node";
let next = 0;

const cookieOf = (req) => (req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === COOKIE)?.[1];
const pick = () => {
    for (let tries = 0; tries < backends.length; tries++) {
        const b = backends[next++ % backends.length];
        if (b.healthy) return b;
    }
    return null;
};

// Health: every second, each instance's /healthz.
setInterval(() => {
    for (const b of backends) {
        const req = http.get({ host: b.host, port: b.port, path: "/healthz", timeout: 800 }, (res) => {
            b.healthy = res.statusCode === 200;
            res.resume();
        });
        req.on("error", () => { b.healthy = false; });
        req.on("timeout", () => { req.destroy(); b.healthy = false; });
    }
}, 1000).unref();

const tls = process.env.TLS_CERT && process.env.TLS_KEY ? { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) } : null;
const handle = (req, res) => {
    if (req.url === "/lb/status") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify(backends.map(({ name, host, port, healthy, requests }) => ({ name, at: `${host}:${port}`, healthy, requests }))));
    }
    const pinned = backends.find((b) => b.name === cookieOf(req) && b.healthy);
    const backend = pinned ?? pick();
    if (!backend) { res.writeHead(503, { "content-type": "text/plain" }); return res.end("No instance is available."); }
    backend.requests += 1;
    const upstream = http.request(
        { host: backend.host, port: backend.port, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-for": [req.headers["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", "), "x-forwarded-proto": tls ? "https" : "http" } },
        (answer) => {
            const headers = { ...answer.headers };
            if (!pinned) {
                const set = [].concat(headers["set-cookie"] ?? []);
                // Secure over HTTPS (G7): the browser sends it back only over HTTPS.
                set.push(`${COOKIE}=${backend.name}; Path=/; HttpOnly; SameSite=Lax${tls ? "; Secure" : ""}`);
                headers["set-cookie"] = set;
            }
            res.writeHead(answer.statusCode, answer.statusMessage, headers);
            answer.pipe(res);
        },
    );
    let gone = false;
    upstream.on("error", () => {
        // The browser left and the request to the instance was dropped with it: the instance is well.
        if (gone) return;
        backend.healthy = false;
        if (!res.headersSent) { res.writeHead(502, { "content-type": "text/plain" }); res.end("The instance did not answer; try again."); } else res.destroy();
    });
    // The browser went away (a closed tab, a dropped stream): so does the upstream request.
    res.on("close", () => { if (!res.writableEnded) { gone = true; upstream.destroy(); } });
    req.pipe(upstream);
};
const server = tls ? https.createServer(tls, handle) : http.createServer(handle);
server.keepAliveTimeout = 65_000;
// Every IPv4 address by default, as the instances (server.mjs); HOST=127.0.0.1 for this machine only.
const HOST = process.env.HOST ?? "0.0.0.0";
server.listen(PORT, HOST, () => console.log(`OpenCore MES load balancer on ${tls ? "https" : "http"}://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}${HOST === "0.0.0.0" ? " (and every address of this machine)" : ""} → ${backends.map((b) => `${b.name}=${b.host}:${b.port}`).join(", ")}`));
