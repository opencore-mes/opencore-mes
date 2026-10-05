// The browser's rule runner (DESIGN.md §12.4): the object's pipe, run on every change of the form's
// state, as advice. A dedicated worker, so scripts never touch the page; its network is taken away
// before any script is loaded; its clock is fixed per run, as the server's is.
import { runPipe, scriptBody } from "./pipe.js";

for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches", "BroadcastChannel", "Worker", "SharedWorker", "WebTransport", "RTCPeerConnection"]) {
    for (let target = self; target; target = Object.getPrototypeOf(target)) {
        try { if (Object.hasOwn(target, name)) delete target[name]; } catch { /* not configurable */ }
    }
    try { Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false }); } catch { /* already gone */ }
}

let now = Date.now();
const RealDate = Date;
self.Date = class Date extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
};
Math.random = undefined;

const compiled = new Map();
const backendOnly = () => { throw Object.assign(new Error("runs at the backend"), { fault: true, backendOnly: true }); };

self.onmessage = async ({ data: message }) => {
    if (message.type === "load") {
        compiled.clear();
        for (const [name, { source }] of Object.entries(message.scripts)) {
            try {
                // Functions made from approved script text, in this worker only.
                compiled.set(name, new Function(`"use strict"; return (${scriptBody(name, source)});`)());
            } catch (error) {
                console.warn(`OpenCore MES: rule ${name} did not load in the browser`, error);
            }
        }
        return;
    }
    if (message.type === "run") {
        now = RealDate.parse(message.ctx.now);
        const invoke = async (name, ctx) => {
            const fn = compiled.get(name);
            if (!fn) return ctx; // not loaded here: the backend decides
            return fn({ ...ctx, lookup: backendOnly, query: backendOnly });
        };
        const out = await runPipe({ entries: message.entries, invoke, ctx: message.ctx, onlyClient: true });
        // A script that needed the backend is not an error here: it runs when the change is saved.
        if (out.error?.fault && /runs at the backend/.test(out.error.detail ?? "")) out.error = null;
        self.postMessage({ type: "result", seq: message.seq, ...out });
    }
};
