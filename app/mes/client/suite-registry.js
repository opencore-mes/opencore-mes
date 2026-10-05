// What the installed suites (§29) add to the platform's own pages, gathered once from their browser
// modules (app.js withSuites), for the pages that draw them: a suite's part of an object's design (its
// check and its tab in the object editor). Kept here, apart from app.js, so the designer can read it
// without importing the router.
export const suiteDesigns = { object: {} }; // suite → { label, validate(body, part, known), component }
// The screen block kinds they add (§30.11): "<suite>.<kind>" → { component }, drawn with { b, data }.
export const suiteBlocks = {};
// Their kinds of design element (§30.11): "<suite>.<kind>" → { label, component }, the editor of what
// the kind adds (given { id, name, body, ops, ro }).
export const suiteElements = {};

export function useSuites(modules) {
    for (const m of modules) {
        const name = m.suite;
        const object = m.designs?.object;
        if (typeof name === "string" && object) suiteDesigns.object[name] = object;
        if (typeof name === "string") for (const [kind, spec] of Object.entries(m.blocks ?? {})) if (kind.startsWith(`${name}.`) && typeof spec?.component === "string") suiteBlocks[kind] = spec;
        if (typeof name === "string") for (const [kind, spec] of Object.entries(m.elements ?? {})) if (kind.startsWith(`${name}.`)) suiteElements[kind] = spec;
    }
}

// The checks of the suites' parts, as validateDefinition takes them (known.suiteDesigns).
export const suiteChecks = () => Object.fromEntries(Object.entries(suiteDesigns.object).map(([name, d]) => [name, d.validate ?? (() => [])]));
