// Designs published over HTTP (docs/contracts/http-apis, DESIGN.md §15.2, §23.3, §25.7): a web service, a
// transaction or a named query, each under its own name at /svc/v1, only where its design says so
// (`http.enabled`), approved like the rest of it. The three kinds share one set of names: an outside system
// calls one thing by one name, whatever it is. What `http` and `deprecated` may say, shared by the checks of
// the three kinds, their editors and the fitness test.
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const NAME = /^[a-z][a-z0-9_]*$/;

export const WEB_KINDS = { service: "web service", transaction: "transaction", query: "named query" };
// How an outside system calls it: a query is read, the others are called.
export const webAddress = (kind, name) => (kind === "query" ? `GET /svc/v1/${name}` : `POST /svc/v1/${name}`);
// The scope a token needs for each (ai-api.js SCOPES).
export const WEB_SCOPE = { service: "service:call", transaction: "transaction:run", query: "query:run" };

// The names published over HTTP as they will be: { name: [kinds] }. `bodies`: { service: { name: body }, … }.
export function webNames(bodies) {
    const out = {};
    for (const kind of Object.keys(WEB_KINDS)) for (const [name, b] of Object.entries(isPlain(bodies?.[kind]) ? bodies[kind] : {})) if (b?.http?.enabled === true) (out[name] ??= []).push(kind);
    return out;
}

// What a design's `http` says wrong. `known.web`: webNames of what there will be; `known.users`, `known.groups`
// for a query's callers (a service's and a transaction's are their own `callers`).
export function webProblems(kind, body, known, add) {
    const http = body?.http;
    if (http === undefined || http === null) return;
    if (!isPlain(http)) return add("http", "Its web service is { enabled: true }, or nothing.");
    const keys = kind === "query" ? ["enabled", "callers"] : ["enabled"];
    for (const k of Object.keys(http)) if (!keys.includes(k)) add("http", `Its web service has no "${k}": it says ${keys.join(" and ")}.`);
    if (http.enabled !== undefined && typeof http.enabled !== "boolean") add("http.enabled", "Published over HTTP is true or false.");
    if (http.enabled !== true) return;
    const others = list(known?.web?.[body.name]).filter((k) => k !== kind);
    if (others.length) add("http.enabled", `${body.name} is published over HTTP as a ${WEB_KINDS[others[0]]} already: outside systems call one thing by one name. Rename one of them, or take the other off the web.`);
    if (kind === "query") {
        const c = isPlain(http.callers) ? http.callers : {};
        if (http.callers !== undefined && !isPlain(http.callers)) add("http.callers", "Who may read it over HTTP is { users: [ids], groups: [ids] }.");
        for (const u of list(c.users)) if (known?.users && !known.users.includes(u)) add("http.callers.users", `"${u}" is not a user.`);
        for (const g of list(c.groups)) if (known?.groups && !known.groups.includes(g)) add("http.callers.groups", `"${g}" is not a group.`);
        if (!list(c.users).length && !list(c.groups).length) add("http.callers", "Name who may read it over HTTP (a user, a group): nobody may until then.");
    }
}

// A design published over HTTP deprecated: its callers' notice (docs/contracts/http-apis): since when, the date
// after which it may change or go, what to call instead. Every call is answered with Deprecation, Sunset and
// Link headers until then.
export function deprecationProblems(kind, body, add) {
    const d = body?.deprecated;
    if (d === undefined || d === null) return;
    const date = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v));
    if (!isPlain(d)) return add("deprecated", "Deprecated is { since, sunset, successor?, note? }.");
    if (!body.http?.enabled) add("deprecated", `Only a ${WEB_KINDS[kind]} published over HTTP is deprecated: its callers are the ones told.`);
    if (!date(d.since)) add("deprecated.since", "Since: the date it is deprecated from (YYYY-MM-DD).");
    if (!date(d.sunset)) add("deprecated.sunset", "Sunset: the date after which it may change or go (YYYY-MM-DD).");
    else if (date(d.since) && Date.parse(d.sunset) <= Date.parse(d.since)) add("deprecated.sunset", "Sunset comes after since: that time is its callers' notice.");
    if (d.successor !== undefined && d.successor !== "" && (!NAME.test(String(d.successor)) || d.successor === body.name)) add("deprecated.successor", "Successor: what its callers move to (another name published over HTTP).");
    if (d.note !== undefined && !(typeof d.note === "string" && d.note.length <= 500)) add("deprecated.note", "A note is words for the callers, 500 characters at most.");
    for (const k of Object.keys(d)) if (!["since", "sunset", "successor", "note"].includes(k)) add("deprecated", `Deprecated: "${k}" is not since, sunset, successor or note.`);
}

// What a change to a design published over HTTP would break for its callers, in words: it no longer answers
// over HTTP, a caller is taken off, and what it takes changes (an input or a parameter gone, of another type,
// required, a value taken from its list; a new required one). `live` and `draft` as published and as drafted.
// `takes(body)` → { name: { type, required?, values? } }: what a caller sends; `callers(body)` → { users, groups };
// `noun`: what each of those is called (a query's are parameters).
export function breaking(live, draft, { takes, callers, noun = "input" }) {
    if (!live?.http?.enabled) return [];
    if (!draft?.http?.enabled) return ["it would no longer answer over HTTP"];
    const out = [];
    const a = takes(live) ?? {};
    const b = takes(draft) ?? {};
    for (const [field, was] of Object.entries(a)) {
        const now = b[field];
        if (!now) { out.push(`${noun} ${field} would be gone`); continue; }
        if (now.type !== was.type) out.push(`${noun} ${field} would be ${now.type}, not ${was.type}`);
        if (now.required && !was.required) out.push(`${noun} ${field} would be required`);
        if (was.type === "enum" && now.type === "enum") for (const v of list(was.values)) if (!list(now.values).includes(v)) out.push(`${noun} ${field} would no longer take "${v}"`);
    }
    for (const [field, now] of Object.entries(b)) if (!a[field] && now?.required) out.push(`a new ${noun} ${field} would be required`);
    const was = callers(live) ?? {};
    const is = callers(draft) ?? {};
    for (const kind of ["users", "groups"]) for (const who of list(was[kind])) if (!list(is[kind]).includes(who)) out.push(`${kind === "users" ? "user" : "group"} ${who} would no longer be among its callers`);
    return out;
}
// What a caller sends each kind: a service's input, a transaction's inputs but those it fills in itself, a
// query's parameters.
export const WEB_TAKES = {
    service: (b) => (isPlain(b?.input) ? b.input : {}),
    transaction: (b) => Object.fromEntries(Object.entries(isPlain(b?.inputs) ? b.inputs : {}).filter(([, s]) => s?.from === undefined)),
    query: (b) => (isPlain(b?.params) ? b.params : {}),
};
export const WEB_CALLERS = {
    service: (b) => b?.callers,
    transaction: (b) => b?.callers,
    query: (b) => b?.http?.callers,
};
