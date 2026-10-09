// OpenCore MES, the same on both sides: the routes, the page titles, the route guard and the components.
// The server renders with it; the browser boots with it (Juris README, "Your first app").
import { registerShell } from "./shell.js";
import { registerRecords } from "./records.js";
import { registerGuides } from "./guide.js";
import { registerEmbed } from "./embed.js";
import { registerFlowTask } from "./flow-task.js";
import { registerDesigner } from "./designer.js";
import { registerDbStatus } from "./db-status.js";
import { registerAnalytics } from "./analytics.js";
import { registerQuery } from "./query.js";
import { registerReports } from "./reports.js";
import { registerSignInAdmin } from "./sign-in-admin.js";
import { registerDatabaseAdmin } from "./database-admin.js";
import { registerRetentionPage } from "./retention-page.js";
import { registerIntegrityPage } from "./integrity-page.js";
import { registerSuiteGuide } from "./suite-guide.js";
import { registerChartView } from "./chart-view.js";
import { registerAttach } from "./attach.js";
import { registerUpdates } from "./updates.js";
import { registerTransfer } from "./transfer.js";
import { registerModelFile } from "./model-file.js";
import { registerTransactionScreen } from "./transaction.js";
import { registerScreens } from "./screen.js";
import { registerMedia, registerStepDone } from "./media.js";
import { registerDialog } from "./dialog.js";
import { registerWindowRows, windowTable, windowRows } from "./window-rows.js";
import { registerCopyCell } from "./copy-cell.js";
import { registerApprovals } from "./approvals.js";
import { registerRequests } from "./requests.js";
import { registerSandbox } from "./sandbox.js";
import { titleTab } from "./shell.js";
import { confirmDialog, askDialog } from "./dialog.js";
import { useSuites } from "./suite-registry.js";
import { plant, noun } from "./format.js";
import { icon } from "./icons.js";

// Every live call's arguments, built in one place so a preload and the component that makes the call
// pass the same object, key for key, in the same order (Juris keys a call by name + JSON of its args).
export const args = {
    defs: (as) => ({ as }),
    def: (object, as) => ({ object, as }),
    list: (object, as, archived = false) => (archived ? { object, as, archived: true } : { object, as }),
    // An object's list, a page at a time, filtered by what was typed (§10.1).
    listPage: (object, as, page = 1, q = "", sort = null) => ({ object, as, page, ...(q ? { q } : {}), ...(sort ? { sort } : {}) }),
    record: (object, id, as) => ({ object, id, as }),
    prefs: (as) => ({ as }),
    design: (as) => ({ as }),
    change: (id, as) => ({ id, as }),
    suiteGuide: (suite, as) => ({ suite, as }),
    designView: (kind, name, as, also = []) => ({ kind, name, as, ...(also.length ? { with: also } : {}) }),
    // ?with=lot,machine: the objects shown beside a viewed design, in order, without repeats.
    viewWith: (query) => [...new Set(String(query?.with ?? "").split(",").map((s) => s.trim()).filter(Boolean))],
    organization: (as) => ({ as }),
    approvals: (as) => ({ as }),
    presence: (object, id, as) => ({ object, id, as }),
    transactions: (as) => ({ as }),
    transaction: (name, as) => ({ name, as }),
    screens: (as) => ({ as }),
    layouts: (as) => ({ as }),
    screen: (name, as) => ({ name, as }),
    screenData: (name, arg, as) => ({ name, arg, as }),
    // The pop-ups open over a page (§26.7): a transaction's with its inputs, a screen's with its parameter.
    popups: (target, values, as) => ({ target, values, as }),
    // Approval of record changes (§28): what waits on a record, one request, the list.
    recordRequest: (object, id, as) => ({ object, id, as }),
    request: (id, as) => ({ id, as }),
    requests: (as) => ({ as }),
    // What waits for the viewer, beside their name.
    inbox: (as) => ({ as }),
    // One run of a plan (§32.7).
    flowTask: (run, as) => ({ run, as }),
};

// What every page of the shell needs: the navigator's objects and transactions, and the user's preferences.
const shell = (viewer) => (viewer ? [["defs.list", args.defs(viewer)], ["prefs.get", args.prefs(viewer)], ["transactions.list", args.transactions(viewer)], ["screens.list", args.screens(viewer)], ["reports.layouts", args.layouts(viewer)], ["inbox.mine", args.inbox(viewer)]] : []);
// A transaction's screen (§25): opened empty, or from a record that fills one of its inputs.
const transactionRoute = (path, name) => ({
    path, name, component: "TransactionScreen",
    props: (params) => ({ key: `tx-${params.name}-${params.from ?? ""}`, name: params.name, from: params.from ?? null }),
    preload: ({ params, viewer }) => (viewer ? [["transactions.get", args.transaction(params.name, viewer)], ...shell(viewer)] : []),
    head: { title: "Transaction", titleFrom: (t) => t?.label ?? "Transaction" },
});
// A screen (§26): opened as it is, or with its parameter's value (a machine's id).
const screenRoute = (path, name) => ({
    path, name, component: "ScreenView",
    props: (params) => ({ key: `scr-${params.name}-${params.arg ?? ""}`, name: params.name, arg: params.arg ?? null }),
    preload: ({ params, viewer }) => (viewer ? [["screens.get", args.screen(params.name, viewer)], ["screens.data", args.screenData(params.name, params.arg ?? null, viewer)], ...shell(viewer)] : []),
    head: { title: "Screen", titleFrom: (s) => s?.label ?? "Screen" },
});

export const routes = [
    { path: "/login", name: "login", component: "Login", preload: () => [["auth.methods"], ["auth.users"]], head: { title: "Sign in" } },
    // A password set through a one-time link (signed out), or changed (signed in), §8.2.
    { path: "/password", name: "password", component: "Password", preload: ({ viewer }) => (viewer ? shell(viewer) : []), head: { title: "Password" } },
    { path: "/", name: "home", component: "Home", preload: ({ viewer }) => shell(viewer), head: { title: "Home" } },
    {
        path: "/o/:object/new", name: "new", component: "RecordNew",
        props: (params) => ({ key: `new-${params.object}`, object: params.object }),
        preload: ({ params, viewer }) => (viewer ? [["defs.get", args.def(params.object, viewer)], ["records.list", args.list(params.object, viewer)], ...shell(viewer)] : []),
        head: { title: "New", titleFrom: (def) => `New ${noun(def.label)}` },
    },
    // Before the record's route, so "analytics" is not read as a record id. Its numbers load in the
    // browser; the page preloads the definition for its title.
    {
        path: "/o/:object/analytics", name: "analytics", component: "ObjectAnalytics",
        props: (params) => ({ key: `analytics-${params.object}`, object: params.object }),
        preload: ({ params, viewer }) => (viewer ? [["defs.get", args.def(params.object, viewer)], ...shell(viewer)] : []),
        head: { title: "Analytics", titleFrom: (def) => `${def.label} · analytics` },
    },
    {
        path: "/o/:object/:id", name: "record", component: "RecordForm",
        props: (params) => ({ key: `rec-${params.object}-${params.id}`, object: params.object, id: params.id }),
        preload: ({ params, viewer }) => (viewer ? [["records.get", args.record(params.object, params.id, viewer)], ["defs.get", args.def(params.object, viewer)], ["presence.get", args.presence(params.object, params.id, viewer)], ["requests.ofRecord", args.recordRequest(params.object, params.id, viewer)], ["flows.runOf", args.record(params.object, params.id, viewer)], ["flows.plansOf", args.record(params.object, params.id, viewer)], ...shell(viewer)] : []),
        head: { title: "Record", titleFrom: (record) => record.$title },
    },
    {
        path: "/o/:object", name: "list", component: "ObjectList",
        props: (params) => ({ key: `list-${params.object}`, object: params.object }),
        preload: ({ params, viewer }) => (viewer ? [["defs.get", args.def(params.object, viewer)], ["records.list", args.listPage(params.object, viewer, 1)], ...shell(viewer)] : []),
        head: { title: "List", titleFrom: (def) => def.label },
    },
    // The query console loads its schema and results in the browser: it preloads only the shell.
    // Import / export loads in the browser: it preloads only the shell.
    transactionRoute("/t/:name/:from", "transaction-from"),
    transactionRoute("/t/:name", "transaction"),
    screenRoute("/s/:name/:arg", "screen-with"),
    screenRoute("/s/:name", "screen"),
    { path: "/transfer", name: "transfer", component: "TransferPage", preload: ({ viewer }) => shell(viewer), head: { title: "Import / export" } },
    { path: "/query", name: "query", component: "QueryConsole", preload: ({ viewer }) => shell(viewer), head: { title: "Query" } },
    // Reports and the analytics copilot (§34): the kept reports; a report's own page, drawn for its viewer.
    { path: "/reports", name: "reports", component: "ReportsPage", preload: ({ viewer }) => shell(viewer), head: { title: "AI Report" } },
    {
        path: "/r/:id", name: "report", component: "ReportPage",
        props: (params) => ({ key: `report-${params.id}`, id: params.id }),
        preload: ({ viewer }) => shell(viewer), head: { title: "Report" },
    },
    { path: "/design", name: "design", component: "DesignHome", preload: ({ viewer }) => (viewer ? [["design.home", args.design(viewer)], ...shell(viewer)] : []), head: { title: "Designer" } },
    // People & departments (§27), as they are live; changed through a change request.
    // Every change waiting for review or approval, and which departments are still to sign (§5.3).
    { path: "/design/approvals", name: "approvals", component: "ApprovalsPage", preload: ({ viewer }) => (viewer ? [["design.approvals", args.approvals(viewer)], ["requests.list", args.requests(viewer)], ...shell(viewer)] : []), head: { title: "Approvals" } },
    {
        path: "/request/:id", name: "request", component: "RequestPage",
        props: (params) => ({ key: `request-${params.id}`, id: params.id }),
        preload: ({ params, viewer }) => (viewer ? [["requests.get", args.request(params.id, viewer)], ...shell(viewer)] : []),
        head: { title: "Change request" },
    },
    {
        path: "/f/:run", name: "flowTask", component: "FlowTask",
        props: (params) => ({ key: `flow-${params.run}`, run: params.run }),
        preload: ({ params, viewer }) => (viewer ? [["flows.task", args.flowTask(params.run, viewer)], ...shell(viewer)] : []),
        head: { title: "Plan", titleFrom: (t) => (t ? `${t.label}: ${t.nodeLabel}` : "Plan") },
    },
    // The installed suites' designs, samples and guides (§29.6, §29.8): their own page, out of the designer's way.
    { path: "/design/suites", name: "suites", component: "SuitesPage", preload: ({ viewer }) => (viewer ? [["design.home", args.design(viewer)], ...shell(viewer)] : []), head: { title: "Suites" } },
    { path: "/design/people", name: "people", component: "PeoplePage", preload: ({ viewer }) => (viewer ? [["design.organization", args.organization(viewer)], ["design.home", args.design(viewer)], ...shell(viewer)] : []), head: { title: "People & departments" } },
    // Client-loaded (it refreshes itself), so it preloads only the shell.
    { path: "/design/model", name: "modelFile", component: "ModelFilePage", preload: ({ viewer }) => shell(viewer), head: { title: "Model file" } },
    { path: "/design/integration", name: "integration", component: "IntegrationMonitor", preload: ({ viewer }) => shell(viewer), head: { title: "Integration monitor" } },
    // Sign-in administration (§8.2): client-loaded, for its administrators.
    { path: "/design/sign-in", name: "signInAdmin", component: "SignInAdmin", preload: ({ viewer }) => shell(viewer), head: { title: "Sign-in administration" } },
    // The Database area (§38): client-loaded, for its administrators.
    { path: "/design/database", name: "databaseAdmin", component: "DatabaseAdmin", preload: ({ viewer }) => shell(viewer), head: { title: "Database" } },
    // Data retention (§27.8): client-loaded, for privacy officers.
    { path: "/design/retention", name: "retention", component: "RetentionPage", preload: ({ viewer }) => shell(viewer), head: { title: "Data retention" } },
    // The data integrity review (§7.7): client-loaded, for integrity reviewers.
    { path: "/design/integrity", name: "integrity", component: "IntegrityPage", preload: ({ viewer }) => shell(viewer), head: { title: "Data integrity" } },
    // An installed suite's set-up guide (§29.8).
    {
        path: "/design/suites/:suite/guide", name: "suiteGuide", component: "SuiteGuidePage",
        props: (params) => ({ key: `guide-${params.suite}`, suite: params.suite }),
        preload: ({ params, viewer }) => (viewer ? [["design.suiteGuide", args.suiteGuide(params.suite, viewer)], ...shell(viewer)] : []),
        head: { title: "Set-up guide", titleFrom: (g) => g?.title },
    },
    // A change's sandbox (§5.11): its draft on copies of real records, nothing live written.
    {
        path: "/design/c/:id/sandbox", name: "sandbox", component: "SandboxView",
        props: (params) => ({ key: `sandbox-${params.id}`, id: params.id }),
        preload: ({ params, viewer }) => (viewer ? [["design.change", args.change(params.id, viewer)], ["design.home", args.design(viewer)], ["sandbox.selections", args.design(viewer)], ...shell(viewer)] : []),
        head: { title: "Sandbox", titleFrom: (change) => (change?.title ? `Sandbox: ${change.title}` : "Sandbox") },
    },
    {
        path: "/design/c/:id", name: "change", component: "ChangeView",
        props: (params) => ({ key: `change-${params.id}`, id: params.id }),
        preload: ({ params, viewer }) => (viewer ? [["design.change", args.change(params.id, viewer)], ["design.home", args.design(viewer)], ["presence.get", args.presence("design", params.id, viewer)], ...shell(viewer)] : []),
        head: { title: "Change request", titleFrom: (change) => change.title },
    },
    // A live design, read-only, without a change (§5.1): the same editors, nothing written.
    {
        path: "/design/view/:kind/:name", name: "designView", component: "DesignView",
        props: (params) => ({ key: `view-${params.kind}-${params.name}`, kind: params.kind, name: params.name }),
        preload: ({ params, query, viewer }) => (viewer ? [["design.view", args.designView(params.kind, params.name, viewer, args.viewWith(query))], ["design.home", args.design(viewer)], ...shell(viewer)] : []),
        head: { title: "Design", titleFrom: (view) => view?.title },
    },
    { path: "*", name: "missing", component: "NotFound", preload: ({ viewer }) => shell(viewer), head: { title: "Not found" } },
];

export const title = { suffix: " · OpenCore MES", fallback: "OpenCore MES" };

// Who may open a route, one pure function on both sides (Juris router `guard`).
export function guard(to, ctx) {
    const signedIn = Boolean(ctx?.viewer);
    // Signed out: to the sign-in, saying where they were going (the demo, which has no sign-in page,
    // signs them in and takes them there).
    if (!signedIn && to.name !== "login" && !(to.name === "password" && (to.query?.token || to.query?.setup === "1"))) return to.path && to.path !== "/" ? `/login?to=${encodeURIComponent(to.path)}` : "/login";
    if (signedIn && to.name === "login") return "/";
    return undefined;
}
export const designPath = (path) => typeof path === "string" && (path === "/design" || path.startsWith("/design/"));
// The designer's editors parse a script by building a function they never call, which only a page
// loaded as a designer page may do (its policy alone allows it: app.mjs). A link into the designer
// from a page that may not is followed by the browser itself, so the designer is loaded afresh,
// under its own policy. (Reached any other way, its editors say nothing of a script's syntax, and
// the server says at save.) `at` is where this document was loaded; → the address to load, or null.
export function freshLoadFor(href, at, mayBuild) {
    let to;
    try { to = new URL(href, "http://x.invalid"); } catch { return null; }
    if (to.origin !== "http://x.invalid" || !designPath(to.pathname) || designPath(at) || mayBuild()) return null;
    return `${to.pathname}${to.search}${to.hash}`;
}
export function designerLinks(doc = document, win = window) {
    const at = win.location.pathname;
    let building = null;
    const mayBuild = () => {
        if (building === null) { try { new Function(""); building = true; } catch { building = false; } }
        return building;
    };
    doc.addEventListener("click", (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const link = event.target?.closest?.("a[href]");
        if (!link || (link.target && link.target !== "_self")) return;
        const href = link.getAttribute("href");
        const to = href?.startsWith("/") ? freshLoadFor(href, at, mayBuild) : null;
        if (!to) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        win.location.assign(to);
    }, true);
}

// The platform's pages and components with every installed suite's (§29, app/mes/suites.mjs): a suite's
// browser module gives routes(kit) and register(juris, kit), and is handed `kit`, what the platform
// lends a suite's pages, so it imports none of the platform's files: the live-call arguments and the
// shell's preload (`args`, `shell(viewer)`), the tab title (`titleTab`), the dialogs, and the plant's
// formats (`format()`: date, dateTime, number, parseDate, §27.6), and its icons (`icon(name)`, SVG). Its routes come
// before the catch-all.
// A page keeps what it shows under a state path made of its address's parts (d.<object>.rec.<id>): a
// part with a dot in it would be read as several, and a name every object carries ("constructor",
// "__proto__") as something that is already there. Such an address names nothing, so its part is given
// to the page as "_", which no design or record is called: the page says it was not found.
const INHERITED = new Set([...Object.getOwnPropertyNames(Object.prototype), "__proto__", "prototype"]);
export const safePart = (v) => (typeof v !== "string" || (!v.includes(".") && !v.includes("*") && !INHERITED.has(v)) ? v : "_");
const safeParts = (route) => (typeof route.props !== "function" ? route : { ...route, props: (params, ...rest) => route.props(Object.fromEntries(Object.entries(params ?? {}).map(([k, v]) => [k, safePart(v)])), ...rest) });

export function withSuites(modules = []) {
    // What a suite's browser module may use of the app's: a list of any length is drawn as every list is (CLAUDE.md).
    const kit = { args, shell, titleTab, confirmDialog, askDialog, format: plant, icon, windowTable, windowRows };
    useSuites(modules);
    const extra = modules.flatMap((m) => (typeof m.routes === "function" ? m.routes(kit) : []));
    const at = routes.findIndex((r) => r.path === "*");
    return {
        routes: [...routes.slice(0, at), ...extra, ...routes.slice(at)].map(safeParts),
        register(juris) {
            register(juris);
            for (const m of modules) m.register?.(juris, kit);
        },
    };
}

export function register(juris) {
    registerShell(juris, { args });
    registerChartView(juris);
    registerAttach(juris);
    registerRecords(juris, { args });
    registerGuides(juris);
    registerEmbed(juris);
    registerFlowTask(juris, { args });
    registerDesigner(juris, { args });
    registerDbStatus(juris);
    registerAnalytics(juris, { args });
    registerQuery(juris);
    registerReports(juris);
    registerSignInAdmin(juris);
    registerDatabaseAdmin(juris);
    registerRetentionPage(juris);
    registerIntegrityPage(juris, { args });
    registerSuiteGuide(juris, { args });
    registerUpdates(juris);
    registerTransfer(juris);
    registerModelFile(juris);
    registerTransactionScreen(juris, { args });
    registerScreens(juris, { args });
    registerMedia(juris);
    registerStepDone(juris);
    registerDialog(juris);
    registerWindowRows(juris);
    registerCopyCell(juris);
    registerApprovals(juris, { args });
    registerRequests(juris, { args });
    registerSandbox(juris, { args });
}
