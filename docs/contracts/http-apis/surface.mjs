// What an HTTP API's v1 promises, as data (the http-apis contract, README.md beside this file): the
// operations an OpenAPI document offers, each with its scope, its path parameters and the request fields
// it reads; how a live document compares with the promise; and the headers a deprecated operation
// answers with. Pure: the core's test, the API kit and anyone else compare with the same rules.

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const METHODS = ["get", "post", "put", "patch", "delete"];

// { "GET /me": { scope, params: [names], fields: [names] } }, from an OpenAPI 3 document. The scope is
// what the operation's description says ("Scope: design:read."), as the core writes it.
export function surfaceOf(doc) {
    const out = {};
    for (const [path, item] of Object.entries(isPlain(doc?.paths) ? doc.paths : {})) {
        for (const m of METHODS) {
            const op = item?.[m];
            if (!isPlain(op)) continue;
            const scope = /Scope: ([^.\s]+(?:\s*\|\s*[^.\s]+)*)\./.exec(op.description ?? "")?.[1] ?? null;
            const params = (op.parameters ?? []).filter((p) => p?.in === "path").map((p) => p.name).sort();
            const schema = op.requestBody?.content?.["application/json"]?.schema;
            const fields = Object.keys(isPlain(schema?.properties) ? schema.properties : {}).sort();
            out[`${m.toUpperCase()} ${path}`] = { scope, params, fields };
        }
    }
    return out;
}

// What changed between the promise and a live surface. Breaking (never in a minor version, and in v1
// never at all: v1 keeps what it promised, v2 may drop it): an operation gone, its scope changed, a path
// parameter changed, a request field no longer read. Not yet promised: an operation or a field the live
// API has and the contract does not (a minor version adds it, to the contract and its changelog first).
export function compareSurface(promised, live) {
    const breaking = [];
    const unpromised = [];
    for (const [key, p] of Object.entries(promised)) {
        const l = live[key];
        if (!l) { breaking.push(`${key} is gone`); continue; }
        if ((p.scope ?? null) !== (l.scope ?? null)) breaking.push(`${key}: its scope is ${l.scope ?? "none"}, not ${p.scope ?? "none"}`);
        if (p.params.join() !== l.params.join()) breaking.push(`${key}: its path parameters are ${l.params.join(", ") || "none"}, not ${p.params.join(", ") || "none"}`);
        for (const f of p.fields) if (!l.fields.includes(f)) breaking.push(`${key}: it no longer reads ${f}`);
        for (const f of l.fields) if (!p.fields.includes(f)) unpromised.push(`${key}: reads ${f}, which the contract does not list`);
    }
    for (const key of Object.keys(live)) if (!promised[key]) unpromised.push(`${key} is not in the contract`);
    return { breaking, unpromised };
}

// The operation a request is, by the document's path templates: "GET /changes/{id}" for GET /changes/1f…
export function operationOf(method, path, doc) {
    for (const template of Object.keys(isPlain(doc?.paths) ? doc.paths : {})) {
        const re = new RegExp(`^${template.split(/\{[^}]+\}/).map((part) => part.replace(/[.*+?^$()|[\]\\]/g, "\\$&")).join("[^/]+")}$`);
        if (re.test(path) && isPlain(doc.paths[template]?.[method.toLowerCase()])) return `${method.toUpperCase()} ${template}`;
    }
    return null;
}

// The headers a deprecated operation (or a designed service) answers with: when it was deprecated
// (RFC 9745 Deprecation, a date as @seconds), when it goes (RFC 8594 Sunset, an HTTP date), and where to
// go instead and read why (Link: successor-version, deprecation). `notice`: { since, sunset, successor?, docs? }.
export function deprecationHeaders(notice) {
    if (!isPlain(notice) || !notice.since) return {};
    const since = Date.parse(notice.since);
    const sunset = notice.sunset ? Date.parse(notice.sunset) : NaN;
    const links = [notice.successor ? `<${notice.successor}>; rel="successor-version"` : null, notice.docs ? `<${notice.docs}>; rel="deprecation"` : null].filter(Boolean);
    return {
        ...(Number.isFinite(since) ? { deprecation: `@${Math.floor(since / 1000)}` } : {}),
        ...(Number.isFinite(sunset) ? { sunset: new Date(sunset).toUTCString() } : {}),
        ...(links.length ? { link: links.join(", ") } : {}),
    };
}

// Whether a notice is one a contract may give: a since date, a sunset at least `minDays` after it.
export function noticeProblem(notice, { minDays = 0 } = {}) {
    if (!isPlain(notice)) return "a notice is { since, sunset, successor?, note? }";
    const since = Date.parse(notice.since);
    const sunset = Date.parse(notice.sunset);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(notice.since ?? "")) || !Number.isFinite(since)) return "since is the date it was deprecated (YYYY-MM-DD)";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(notice.sunset ?? "")) || !Number.isFinite(sunset)) return "sunset is the date after which it may change or go (YYYY-MM-DD)";
    if ((sunset - since) / 86_400_000 < minDays) return `sunset is at least ${minDays} days after since: callers are given that long`;
    return null;
}
