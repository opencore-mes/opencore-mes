// The service worker (DESIGN.md §14): it makes OpenCore MES installable, and answers with a page of its
// own when the server cannot be reached. It never keeps live data: the API, the live streams, the
// web services, sign-in and /version always go to the network, so nothing it serves can be stale.
//   pages     the network first; when it fails, /offline.html, which reloads by itself once the
//             server answers again
//   files     whose URL carries the build's version (?v=…) are the same bytes for as long as the URL
//             lives, so they are kept and served from here, and a new build brings new URLs
//   the rest  the network, as if there were no service worker
// A new version of this file takes over at once (skipWaiting, clients.claim); the page reloads itself
// when the server's build changes (client/updates.js).
const CACHE = "mes-files-v1";
const OFFLINE = "/offline.html";
const KEEP = 400; // versioned files kept at most, oldest dropped first

self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, "/icons/icon.svg", "/icons/icon-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) if (key.startsWith("mes-") && key !== CACHE) await caches.delete(key);
        await self.clients.claim();
    })());
});

const NETWORK_ONLY = /^\/(api|svc|ai|version|healthz|login|logout|__reload)(\/|$)/;

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || NETWORK_ONLY.test(url.pathname)) return;
    if (request.mode === "navigate") {
        event.respondWith(fetch(request).catch(async () => (await caches.match(OFFLINE)) ?? Response.error()));
        return;
    }
    if (url.searchParams.has("v")) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE);
            const hit = await cache.match(request);
            if (hit) return hit;
            const answer = await fetch(request);
            // Kept only when the server says these bytes are this version's for good: during a roll, an
            // instance of the other build answers a ?v= it does not know with must-revalidate, and
            // keeping that would pin the wrong bytes under this version's address.
            if (answer.ok && /\bimmutable\b/.test(answer.headers.get("cache-control") ?? "")) {
                await cache.put(request, answer.clone());
                const keys = await cache.keys();
                for (const old of keys.slice(0, Math.max(0, keys.length - KEEP))) await cache.delete(old);
            }
            return answer;
        })());
    }
});
