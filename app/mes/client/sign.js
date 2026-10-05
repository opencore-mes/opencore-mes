// Signing (DESIGN.md §7.4, Part 11 §11.200): where the plant asks every signer to prove who they are
// (the page's `signing.password`), a signature carries their password, or a fresh sign-in at the identity
// provider made just before, in a small window (`signing.sso`): `{ password }` or `{ sso: true }`.
//
//   const proof = await signDialog(api, { title: "Approve for Quality?", message, confirm: "Approve (sign)" });
//   if (proof === null) return;               // cancelled
//   await api.call("design.approve", { …, signature: proof });   // {} where nothing is asked
import { signDialog as openSign } from "./dialog.js";

// A fresh sign-in at the provider, for the person signed in (`me`) or the one beside them (`second`):
// the provider asks them again; the window closes itself and says how it went. → true when signed in.
export function freshSignOn(who = "me") {
    return new Promise((resolve) => {
        const win = globalThis.open?.(`/login/sso/again?who=${who === "second" ? "second" : "me"}`, "mes-sign-on", "width=520,height=640");
        if (!win) { resolve(false); return; }
        let done = false;
        const finish = (ok) => { if (done) return; done = true; globalThis.removeEventListener("message", heard); clearInterval(watch); resolve(ok); };
        const heard = (e) => { if (e.origin === globalThis.location.origin && e.data && typeof e.data.mesSignedInAgain === "boolean") finish(e.data.mesSignedInAgain); };
        globalThis.addEventListener("message", heard);
        // Closed without a word (the person closed it): not signed in.
        const watch = setInterval(() => { if (win.closed) setTimeout(() => finish(false), 300); }, 500);
    });
}

// The signature's question, with what proves who signs where the plant asks it. → the proof (`{}` where
// nothing is asked), or null when cancelled.
export async function signDialog(api, { title, message = "", confirm = "Sign", danger = false } = {}) {
    const asks = Boolean(api.getState("signing.password", false));
    return openSign(api, { title, message, confirm, danger, asks, sso: asks && Boolean(api.getState("signing.sso", false)), freshSignOn });
}
