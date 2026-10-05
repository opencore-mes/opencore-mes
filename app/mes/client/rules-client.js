// The page's side of the browser rule runner: one worker per object, loaded once with that object's
// published scripts, asked to run the pipe on every change. Answers are advice (§12.4); the server
// runs the same pipe again on save and decides.

const runners = new Map(); // object -> runner

// How long a pipe may take here before the page stops waiting for it: the worker is advice, and a
// rule that never ends (or a worker that never started) must not hold a button for ever.
export const RULE_WAIT_MS = 4000;

// `make` builds the worker (the tests pass their own).
export function createRunner(api, object, make = ruleWorker) {
    let seq = 0;
    const waiting = new Map(); // seq → { resolve, reject, timer }
    let worker = null;
    let ready = null;
    const settle = (id, how, value) => {
        const w = waiting.get(id);
        if (!w) return;
        waiting.delete(id);
        clearTimeout(w.timer);
        w[how](value);
    };
    // Everything waiting is told the rules could not run here (the caller lets the server decide), and
    // the next run starts a worker afresh.
    const drop = (why) => {
        try { worker?.terminate(); } catch { /* gone already */ }
        worker = null;
        ready = null;
        for (const id of [...waiting.keys()]) settle(id, "reject", new Error(why));
    };
    const start = () => {
        const w = make();
        worker = w;
        w.onmessage = ({ data }) => settle(data.seq, "resolve", data);
        w.onerror = (event) => { console.warn("OpenCore MES: the rule worker failed", event?.message); if (worker === w) drop("the rule worker failed"); };
        w.onmessageerror = () => { if (worker === w) drop("the rule worker's answer could not be read"); };
        ready = api.call("rules.scripts", { object }).then((scripts) => w.postMessage({ type: "load", scripts }));
        // A load that failed is tried again by the next run, not kept as this runner's answer for good.
        ready.catch(() => { if (worker === w) drop("the rules could not be loaded"); });
    };
    return {
        // Resolves { seq, ctx, error, trace }, or rejects when the rules could not run here in time.
        // The caller keeps only the newest answer.
        async run(entries, ctx) {
            if (!worker) start();
            const w = worker;
            await ready;
            if (worker !== w) throw new Error("the rule worker failed");
            const mine = ++seq;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { if (waiting.has(mine)) drop("the rules took too long"); }, RULE_WAIT_MS);
                waiting.set(mine, { resolve, reject, timer });
                w.postMessage({ type: "run", seq: mine, entries, ctx });
            });
        },
    };
}

// Whether this browser starts a worker that is a module (the rule worker imports the pipe): Firefox
// did not before 114, where one is started as a plain script, fails on its first import and never
// answers. Known by whether the browser reads the option at all, when the first worker is made.
// Without it the rules do not run here; the server runs them at save, as it does anyway (§12.4).
let moduleWorkers = null;
const ruleWorker = () => {
    if (moduleWorkers === false) throw new Error("this browser does not run rules beside the page");
    let asked = false;
    const worker = new Worker(new URL("./rule-worker.js", import.meta.url), { get type() { asked = true; return "module"; } });
    moduleWorkers = asked;
    if (!asked) { worker.terminate(); throw new Error("this browser does not run rules beside the page"); }
    return worker;
};
const NONE = { run: async () => { throw new Error("this browser does not run rules beside the page"); } };

export function rulesFor(api, object) {
    if (moduleWorkers === false || typeof Worker !== "function") return NONE;
    if (!runners.has(object)) runners.set(object, createRunner(api, object));
    return runners.get(object);
}
