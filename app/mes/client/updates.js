// Staying on the server's version (DESIGN.md §14). The page knows the build that rendered it (the
// `mes-build` meta); the server says its own at /version. They are compared when the live stream
// comes back (a restarted server reconnects it), when the tab is shown again, when the network
// returns, and every minute. When they differ the page reloads by itself, at once if nothing is being
// edited; otherwise a banner says so, and it reloads the moment the edits are saved or discarded, so
// nobody loses what they typed.
//
// It also registers the service worker (pwa/sw.js), which makes the app installable and shows a page
// of its own when the server cannot be reached. Browsers allow one only over HTTPS or on localhost,
// and development (a build named dev-…) has its own reload, so it is left out there.
import { confirmDialog } from "./dialog.js";
import { icon } from "./icons.js";

const CHECK_MS = 60_000;
const SETTLE_MS = 2_000;

const builtWith = () => globalThis.document?.querySelector('meta[name="mes-build"]')?.content ?? null;

// Is anything being edited, saved or sent again? A record form (f.<object>.<id>), a new record
// (f.<object>.new), or a designer's change (dz.<id>).
export function editing(api) {
    const forms = api.peek("f") ?? {};
    for (const object of Object.values(forms)) {
        for (const form of Object.values(object ?? {})) {
            if (form && (form.dirty || form.saving || form.unknown)) return true;
        }
    }
    for (const change of Object.values(api.peek("dz") ?? {})) if (change?.dirty || change?.busy) return true;
    return false;
}

export function registerUpdates(juris) {
    juris.registerComponent("UpdateBanner", (props, api) => {
        if (!api.isServer) {
            api.onMount(() => {
                const mine = builtWith();
                let waiting = null;
                let timer = null;
                const reload = () => { if (waiting) globalThis.location.reload(); };
                const settle = () => {
                    if (!waiting) return;
                    if (!editing(api)) { reload(); return; }
                    api.setValue("sys.update", waiting);
                    timer = setTimeout(settle, SETTLE_MS);
                };
                const check = async () => {
                    if (!mine || waiting) return;
                    try {
                        const answer = await fetch("/version", { cache: "no-store" });
                        const { build } = await answer.json();
                        if (build && build !== mine) {
                            waiting = build;
                            navigator.serviceWorker?.getRegistration?.().then((r) => r?.update()).catch(() => {});
                            settle();
                        }
                    } catch {
                        // The server is not answering: the database banner and the live badge say so.
                    }
                };
                const onShow = () => { if (document.visibilityState === "visible") check(); };
                const every = setInterval(check, CHECK_MS);
                document.addEventListener("visibilitychange", onShow);
                globalThis.addEventListener("online", check);
                // A new live stream: the server may be a new one. (bindState runs once at once: skipped.)
                let first = true;
                const stop = api.bindState(() => api.getState("$live.generation", 0), () => { if (first) { first = false; return; } check(); });
                if ("serviceWorker" in navigator && mine && !mine.startsWith("dev-") && globalThis.isSecureContext) {
                    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((e) => console.warn("OpenCore MES: the service worker did not register", e));
                }
                return () => {
                    clearInterval(every);
                    clearTimeout(timer);
                    stop();
                    document.removeEventListener("visibilitychange", onShow);
                    globalThis.removeEventListener("online", check);
                };
            });
        }
        return () => {
            if (!api.getState("sys.update", null)) return { span: {} };
            return {
                div: {
                    className: "db-banner back update-banner", role: "status",
                    children: [
                        icon("refresh"), { span: "A new version of OpenCore MES is ready. It loads by itself once your changes are saved or discarded." },
                        { button: { type: "button", className: "btn ghost", textContent: "Reload now", onclick: async () => { if (!editing(api) || (await confirmDialog(api, { title: "Reload now?", message: "Changes you have not saved will be lost.", confirm: "Reload", danger: true }))) globalThis.location.reload(); } } },
                    ],
                },
            };
        };
    });
}
