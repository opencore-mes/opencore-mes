// The browser entry: the page imports it once idle and calls start() (Juris page contract).
import { hydrate } from "/src/client.js";
import { guard, withSuites, designerLinks } from "./app.js";
import { startTabOverflow } from "./tab-overflow.js";

// The installed suites' browser modules (§29), named in the page by the server (mes-suites), are
// imported first: their pages and components join the platform's before anything is drawn.
async function suites() {
    const named = document.querySelector('meta[name="mes-suites"]')?.content;
    const urls = named ? JSON.parse(named) : [];
    return Promise.all(urls.map((url) => import(url)));
}

export const start = async () => {
    const { routes, register } = withSuites(await suites());
    designerLinks();
    // Tab bars keep the open tab in sight and put those that do not fit in a dropdown (tab-overflow.js).
    startTabOverflow();
    return hydrate({
        routes,
        register,
        router: { guard, context: (api) => ({ viewer: api.getState("me.id", null) }) },
        // The tab's title follows what the page shows (ui.title), as the server named it at first.
        title: (juris) => {
            const text = juris.getState("ui.title", null);
            return text ? `${text} · OpenCore MES` : undefined;
        },
        expose: "mes",
    });
};
