// Built-in objects and locks (DESIGN.md §6.7), shared by the server (publishing, validation, the record
// services' guard) and the designer (what it shows locked, and why).
//
// A built-in object is one the platform itself needs, published in every installation by the platform
// (migrate.mjs, ensureBuiltIns), and then the plant's like any other: designers add fields, states,
// rules, policies and screens through the change lifecycle. Person is one: one record per person in
// People & departments, kept in step with it as an organization change executes. What the platform
// relies on is locked.
//
// A lock keeps part of an object as something relies on it: the platform (core), or an installed suite.
// Locks are never stored in the design (a designer could edit them away): they are worked out each time
// a design is checked, from the platform's code and from the suites installed now, so removing a suite
// lifts its locks and what it locked stays, an ordinary part of the plant's design.
//
//   { by: "core" | "suite", owner: "<who, in words>", why: "<what relies on it>",
//     keep: true,                       the object cannot be retired
//     fields: { name: { type, to?, values?, required?, multiple? } },   cannot be removed, retyped, made
//                                       optional, or lose a choice (values may be added)
//     managed: [field],                 core only: written by the platform alone (People & departments)
//     platformRecords: true,            core only: records made and archived by the platform alone
//     titleField: "name",               stays the title
//     states: [state], transitions: [action], rules: [script], policies: [policy id] }   still there
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

// Person: everyone in People & departments, one record each, made, renamed and made inactive there.
export const PERSON = {
    object: "person", label: "Person", area: "Organization", builtIn: true,
    description: "Everyone who signs in: one record per person in People & departments, kept in step with it. Who they are (their sign-in id, name, whether active) is People & departments' own; add what else the plant keeps about them (a badge, a shift, skills, certifications) here.",
    titleField: "name",
    // A badge scanned is its sign-in id: a person picked by scanning is found by it too (§10.4).
    scanBy: ["user"],
    fields: {
        user: { label: "Sign-in id", type: "string", required: true },
        name: { label: "Name", type: "string", required: true },
        active: { label: "Active", type: "boolean" },
    },
    states: { initial: "active", list: ["active"], transitions: [] },
    roles: ["viewer", "editor"],
    stewards: { object: ["$governance"] },
    policies: [
        { id: "person-read", roles: ["viewer", "editor"], record: { read: true }, fields: { "*": "read" } },
        // What the plant adds; People & departments' own fields stay the platform's (managed).
        { id: "person-edit", roles: ["editor"], fields: { "*": "write" } },
    ],
    // Search first: nobody wants a plant's people listed by default.
    list: { columns: ["name", "user", "active"], sort: { field: "name", dir: "asc" }, searchFirst: true },
    form: { sections: [{ label: "Person", fields: ["name", "user", "active"] }] },
    rules: [],
};

// Desktop: a computer on the floor, known by the address its browser comes from, and the page it opens
// when someone signs in there (§6.8): a screen or a transaction, filled, as the work centre's own. One
// record per desktop, the plant's to keep (a form, the list, an Excel import keyed by the address);
// the platform only reads them, at sign-in (server/desktops.js).
export const DESKTOP = {
    object: "desktop", label: "Desktop", area: "Organization", builtIn: true,
    description: "A computer on the floor and the page it opens at sign-in: its address (the IP address its browser comes from), and the screen or the transaction that desktop is for. Whoever signs in there lands on that page, filled; they can restore the usual view, and go anywhere else from it.",
    titleField: "name",
    fields: {
        name: { label: "Name", type: "string", required: true },
        address: { label: "Address", type: "string", required: true },
        opens: { label: "Opens", type: "enum", values: ["screen", "transaction"], required: true },
        page: { label: "Screen or transaction", type: "string", required: true },
        opened_with: { label: "Opened with", type: "string" },
        note: { label: "Note", type: "text" },
    },
    states: { initial: "active", list: ["active"], transitions: [] },
    roles: ["viewer", "editor"],
    stewards: { object: ["$governance"] },
    policies: [
        { id: "desktop-read", roles: ["viewer", "editor"], record: { read: true }, fields: { "*": "read" } },
        { id: "desktop-edit", roles: ["editor"], record: { create: true, archive: true }, fields: { "*": "write" } },
    ],
    list: { columns: ["name", "address", "opens", "page"], sort: { field: "name", dir: "asc" } },
    form: { sections: [{ label: "Desktop", fields: [
        { field: "name", help: "What the plant calls it: Press 3 terminal, Packing bench A." },
        { field: "address", help: "The IP address its browser comes from, as the server sees it: 10.20.3.41 (or an IPv6 address)." },
        "opens",
        { field: "page", help: "Its name, as in the designer: work_centre, move_in." },
        { field: "opened_with", help: "For a screen opened on a record (a machine's work centre): that record's id. Leave empty otherwise." },
        "note",
    ] }] },
    // The loader: a workbook of desktops, each row found again by its address.
    transfer: { import: { create: true, update: true, key: "address" } },
    // Its address is an IP address, kept in one spelling; its page's name is a design's name.
    rules: [{ script: "desktop_address", writes: ["address"] }],
};

// The rule scripts the platform publishes with its built-in objects (migrate.mjs ensureBuiltIns): the
// plant's from then on, like any script, changed through the lifecycle.
export const BUILT_IN_SCRIPTS = {
    report_kept: `// A report's author is who made it, and stays so; what it holds is a report's blocks.
export default function report_kept(ctx) {
  if (ctx.event.kind === "change") return ctx;
  var was = ctx.record && ctx.record.owner;
  if (was && ctx.data.owner !== was) {
    throw Object.assign(new Error("A report stays its author's: it cannot be given to someone else."), { field: "owner" });
  }
  if (!was && ctx.data.owner !== ctx.user.id) {
    throw Object.assign(new Error("A report is its maker's: its author is you."), { field: "owner" });
  }
  var spec = null;
  try { spec = JSON.parse(String(ctx.data.spec)); } catch (e) { spec = null; }
  if (!spec || typeof spec !== "object" || !Array.isArray(spec.blocks) || !spec.blocks.length) {
    throw Object.assign(new Error("What a report holds is its blocks: change it on the AI Report page."), { field: "spec" });
  }
  return ctx;
}`,
    desktop_address: `// A desktop's address is an IP address, kept in one spelling: so it is found at sign-in, and
// found again by an import. Its page is named as a design is.
export default function desktop_address(ctx) {
  if (ctx.event.kind === "change" && !ctx.event.changed.includes("address") && !ctx.event.changed.includes("page")) return ctx;
  var page = ctx.data.page == null ? "" : String(ctx.data.page).trim();
  if (page && !/^[a-z][a-z0-9_]{0,47}$/.test(page)) {
    throw Object.assign(new Error("Give the screen's or the transaction's name as the designer has it: work_centre, move_in."), { field: "page" });
  }
  var a = String(ctx.data.address == null ? "" : ctx.data.address).trim().toLowerCase().replace(/^\\[|\\]$/g, "").replace(/%.*$/, "");
  if (!a) return ctx;
  var mapped = /^::ffff:(\\d{1,3}(?:\\.\\d{1,3}){3})$/.exec(a);
  if (mapped) a = mapped[1];
  var v4 = /^\\d{1,3}(\\.\\d{1,3}){3}$/.test(a) && a.split(".").every(function (n) { return Number(n) <= 255; });
  var v6 = /^[0-9a-f:]{2,39}$/.test(a) && a.indexOf(":") >= 0;
  if (!v4 && !v6) {
    throw Object.assign(new Error("An address is an IP address, as the server sees this desktop: 10.20.3.41."), { field: "address" });
  }
  ctx.data.address = v4 ? a.split(".").map(Number).join(".") : a;
  return ctx;
}`,
};

// An address as it is compared: trimmed, lower case, an IPv4 address written as IPv6 (::ffff:10.0.0.5)
// read as the IPv4 one, a zone (%eth0) and brackets dropped. → the address, or null when it is not one.
export function desktopAddress(text) {
    let a = String(text ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
    if (mapped) a = mapped[1];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) return a.split(".").every((n) => Number(n) <= 255) ? a.split(".").map(Number).join(".") : null;
    return /^[0-9a-f:]{2,39}$/.test(a) && a.includes(":") ? a : null;
}
// The page a desktop's record names, as an address of the app: /s/<screen>[/<record>] or /t/<transaction>.
export function desktopPath(data) {
    const name = String(data?.page ?? "").trim();
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(name)) return null;
    const arg = String(data?.opened_with ?? "").trim();
    if (arg && !/^[A-Za-z0-9_-]{1,64}$/.test(arg)) return null;
    if (data?.opens === "screen") return arg ? `/s/${name}/${arg}` : `/s/${name}`;
    if (data?.opens === "transaction") return arg ? `/t/${name}/${arg}` : `/t/${name}`;
    return null;
}

// Report: what a person keeps of the plant's queryable data (§34): a title and blocks (words, figures,
// charts, tables), each block naming the query it draws. One record per report, its author's to
// change and to share; a shared one is read by whoever holds a role here, and its queries run as
// whoever opens it, so nobody reads through a report what their policies hide. Made on the Reports
// page, by hand or with the analytics copilot.
export const REPORT = {
    object: "report", label: "AI report", area: "Data", builtIn: true,
    description: "A report on the plant's data: words, figures, charts and tables, each drawn from a query. Its author keeps it and may share it; opened, its queries run as whoever opens it.",
    titleField: "title",
    fields: {
        title: { label: "Title", type: "string", required: true },
        description: { label: "Description", type: "text" },
        owner: { label: "Author", type: "string", required: true },
        shared: { label: "Shared", type: "boolean" },
        // What its author files it under, to find it again: words, with commas between them (§34.8).
        tags: { label: "Tags", type: "string" },
        spec: { label: "What it holds", type: "text", required: true, max: 60000 },
    },
    states: { initial: "kept", list: ["kept"], transitions: [] },
    roles: ["author", "reader"],
    stewards: { object: ["$governance"] },
    policies: [
        // Its author's own: made, read, changed, shared, and taken out of use by them alone.
        { id: "report-own", roles: ["author"], when: { eq: [{ record: "owner" }, { user: "id" }] }, record: { read: true, create: true, archive: true }, fields: { "*": "write" } },
        // Shared: read by everyone who holds a role here.
        { id: "report-shared", roles: ["author", "reader"], when: { eq: [{ record: "shared" }, true] }, record: { read: true }, fields: { "*": "read" } },
    ],
    list: { columns: ["title", "tags", "owner", "shared"], sort: { field: "title", dir: "asc" } },
    form: { sections: [{ label: "AI report", fields: ["title", "description", "tags", "owner", "shared", { field: "spec", help: "Its blocks, as the AI Report page keeps them (JSON). Change a report there." }] }] },
    // Its author is who made it, and stays so; what it holds is a report.
    rules: [{ script: "report_kept", writes: ["owner"] }],
};

// Certification (§27.9): who holds which of the certifications People & departments recognizes, from when
// and until when. What a person holds, active and in date, is what their access reads (user.certifications):
// a record whose object's access requires a certification (§9.9) is shown, and changed, only to those who
// hold it. Kept by the plant's own process, as its policies and approvals (§28) say: a form, an Excel
// import, a training suite, a learning system over the HTTP API.
export const CERTIFICATION = {
    object: "certification", label: "Certification", area: "Organization", builtIn: true,
    description: "Who holds which certification, from when and until when: one record per certificate. The certifications themselves (ITAR, a cleanroom grade) are listed in People & departments. Someone whose certification is active and in date sees what an object's access reserves to it; revoked, or out of date, they no longer do.",
    titleField: "kind",
    fields: {
        person: { label: "Person", type: "ref", to: "person", required: true },
        kind: { label: "Certification", type: "string", required: true },
        valid_from: { label: "Valid from", type: "date" },
        valid_until: { label: "Valid until", type: "date" },
        number: { label: "Certificate number", type: "string" },
        note: { label: "Note", type: "text" },
    },
    states: {
        initial: "active", list: ["active", "revoked"], tones: { active: "ok", revoked: "danger" },
        transitions: [{ action: "revoke", label: "Revoke", from: ["active"], to: "revoked" }, { action: "reinstate", label: "Reinstate", from: ["revoked"], to: "active" }],
    },
    roles: ["viewer", "editor"],
    stewards: { object: ["$governance"] },
    policies: [
        { id: "certification-read", roles: ["viewer", "editor"], record: { read: true }, fields: { "*": "read" } },
        { id: "certification-keep", roles: ["editor"], record: { create: true, archive: true }, fields: { "*": "write" }, actions: { revoke: "allow", reinstate: "allow" } },
    ],
    list: { columns: ["person", "kind", "valid_from", "valid_until", "number"], sort: { field: "valid_until", dir: "asc" } },
    form: { sections: [{ label: "Certification", fields: [
        "person",
        { field: "kind", help: "One of the certifications People & departments lists, by its id: itar, cleanroom_iso5." },
        { field: "valid_from", help: "Empty: from when it is recorded." },
        { field: "valid_until", help: "Empty: until it is revoked. From the day after, it no longer counts." },
        "number", "note",
    ] }] },
    rules: [],
};

export const BUILT_INS = [PERSON, DESKTOP, REPORT, CERTIFICATION];
// A report's tags as they are kept: words with commas between them, each trimmed and in lower case,
// none twice, at most ten of at most thirty characters. → the text kept ("daily, wirebond"), or null.
export const REPORT_TAGS = { most: 10, length: 30 };
export function reportTags(given) {
    const words = (Array.isArray(given) ? given : String(given ?? "").split(",")).map((t) => String(t).trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean);
    return [...new Set(words)];
}
export const reportTagsText = (given) => reportTags(given).join(", ") || null;
export function reportTagsProblem(given) {
    const tags = reportTags(given);
    if (tags.length > REPORT_TAGS.most) return `At most ${REPORT_TAGS.most} tags.`;
    const long = tags.find((t) => t.length > REPORT_TAGS.length);
    return long ? `A tag is at most ${REPORT_TAGS.length} characters: "${long.slice(0, 40)}".` : null;
}
// Who holds a built-in at first, in an installation that had no say yet: the role given to those who
// design (the designer role), when the platform first brings the object and nobody holds a role on it.
// Without it the object is live and in nobody's navigator. Roles after that are People & departments'.
// (`of`: the holders of another role instead: a report's first authors are the analysts, §23.)
export const BUILT_IN_FIRST_ROLES = { desktop: "editor", report: { role: "author", of: ["query", "analyst"] }, certification: "editor" };
const MANAGED_WHY = "People & departments keeps it: change it there, through its change request.";

// The platform's own locks, per object.
export const CORE_LOCKS = {
    person: [{
        by: "core", owner: "the platform", why: "Sign-in and approvals read it: one record per person in People & departments.",
        keep: true, platformRecords: true, titleField: "name",
        fields: Object.fromEntries(Object.entries(PERSON.fields).map(([k, f]) => [k, { type: f.type, ...(f.required ? { required: true } : {}) }])),
        managed: Object.keys(PERSON.fields),
        states: ["active"],
    }],
    desktop: [{
        by: "core", owner: "the platform", why: "Sign-in reads it: the page a desktop opens, found by its address.",
        keep: true, titleField: "name",
        fields: Object.fromEntries(["address", "opens", "page", "opened_with"].map((k) => [k, { type: DESKTOP.fields[k].type, ...(DESKTOP.fields[k].required ? { required: true } : {}), ...(DESKTOP.fields[k].values ? { values: DESKTOP.fields[k].values } : {}) }])),
        states: ["active"], rules: ["desktop_address"],
    }],
    certification: [{
        by: "core", owner: "the platform", why: "Access reads it: what a person holds, active and in date, opens what an object reserves to it (§9.9).",
        keep: true,
        fields: Object.fromEntries(["person", "kind", "valid_from", "valid_until"].map((k) => [k, { type: CERTIFICATION.fields[k].type, ...(CERTIFICATION.fields[k].to ? { to: CERTIFICATION.fields[k].to } : {}), ...(CERTIFICATION.fields[k].required ? { required: true } : {}) }])),
        states: ["active", "revoked"], transitions: ["revoke", "reinstate"],
    }],
    report: [{
        by: "core", owner: "the platform", why: "The AI Report page reads it: a report's author, whether it is shared, and what it holds.",
        keep: true, titleField: "title",
        fields: Object.fromEntries(["title", "owner", "shared", "tags", "spec"].map((k) => [k, { type: REPORT.fields[k].type, ...(REPORT.fields[k].required ? { required: true } : {}) }])),
        states: ["kept"], rules: ["report_kept"], policies: ["report-own", "report-shared"],
    }],
};
export const managedWhy = () => MANAGED_WHY;
// Who holds a lock, in words: "the platform", "the Semiconductor suite" (a label that says suite already, as it is).
export const holderWords = (lock) => (lock.by === "core" ? lock.owner : /\bsuite$/i.test(lock.owner) ? `the ${lock.owner}` : `the ${lock.owner} suite`);

// A suite's locks, from its design pack: { object: { fields: [names], states, transitions, rules,
// policies, keep, why } }, each field's reference taken from the pack's own definition of the object
// (or its extension of one). → { object: [lock] }
export function suiteLocks(suite, pack) {
    const out = {};
    const defs = Object.fromEntries(list(pack?.definitions).map((d) => [d.object, d]));
    for (const [object, spec] of Object.entries(isPlain(pack?.locks) ? pack.locks : {})) {
        const source = defs[object] ?? (isPlain(pack?.extends?.[object]) ? pack.extends[object] : null);
        const fields = {};
        for (const name of list(spec.fields)) {
            const f = source?.fields?.[name];
            if (!f) continue;
            fields[name] = { type: f.type, ...(f.to ? { to: f.to } : {}), ...(Array.isArray(f.values) ? { values: [...f.values] } : {}), ...(f.required ? { required: true } : {}), ...(f.multiple ? { multiple: true } : {}) };
        }
        (out[object] ??= []).push({
            by: "suite", owner: suite.label ?? suite.name, suite: suite.name, why: typeof spec.why === "string" ? spec.why : `The ${suite.label ?? suite.name} suite relies on it.`,
            ...(spec.keep ? { keep: true } : {}), fields,
            states: list(spec.states), transitions: list(spec.transitions), rules: list(spec.rules), policies: list(spec.policies),
        });
    }
    return out;
}

// Core and suite locks together: { object: [lock] }.
export function mergeLocks(...sets) {
    const out = {};
    for (const set of sets) for (const [object, locks] of Object.entries(set ?? {})) (out[object] ??= []).push(...list(locks));
    return out;
}

// The locks as they hold now: a part is kept once it is live (a suite installed, its pack not yet
// approved, keeps nothing of what it would add), and an object only once it is. `live`: object → body.
export function liveLocks(locks, live = {}) {
    const out = {};
    for (const [object, set] of Object.entries(locks ?? {})) {
        const body = live[object];
        if (!body) continue;
        const has = { fields: (n) => Object.hasOwn(body.fields ?? {}, n), states: (n) => list(body.states?.list).includes(n), transitions: (n) => list(body.states?.transitions).some((t) => t?.action === n), rules: (n) => list(body.rules).some((r) => r?.script === n), policies: (n) => list(body.policies).some((p) => p?.id === n) };
        out[object] = list(set).map((l) => ({
            ...l,
            fields: Object.fromEntries(Object.entries(l.fields ?? {}).filter(([n]) => has.fields(n))),
            ...Object.fromEntries(["states", "transitions", "rules", "policies"].map((k) => [k, list(l[k]).filter(has[k])])),
        }));
    }
    return out;
}

// What a definition breaks of the locks on it. → [{ path, message }]
export function lockProblems(body, locks = []) {
    const problems = [];
    if (!isPlain(body)) return problems;
    for (const lock of list(locks)) {
        const by = `locked by ${holderWords(lock)}`;
        const say = (path, what) => problems.push({ path, message: `${what}: it is ${by}. ${lock.why}` });
        for (const [name, ref] of Object.entries(lock.fields ?? {})) {
            const f = body.fields?.[name];
            if (!isPlain(f)) { say(`fields.${name}`, `Field "${name}" cannot be removed`); continue; }
            if (f.type !== ref.type) say(`fields.${name}.type`, `Field "${name}" stays a ${ref.type}`);
            else if (ref.to && f.to !== ref.to) say(`fields.${name}.to`, `Field "${name}" still refers to ${ref.to}`);
            if (ref.values) { const missing = ref.values.filter((v) => !list(f.values).includes(v)); if (missing.length) say(`fields.${name}.values`, `Field "${name}" keeps its choices ${missing.join(", ")} (more may be added)`); }
            if (ref.required && !f.required) say(`fields.${name}.required`, `Field "${name}" stays required`);
            if (ref.multiple !== undefined && Boolean(f.multiple) !== Boolean(ref.multiple)) say(`fields.${name}.multiple`, `Field "${name}" ${ref.multiple ? "keeps holding several values" : "keeps holding one value"}`);
        }
        if (lock.titleField && body.titleField !== lock.titleField) say("titleField", `The title stays "${lock.titleField}"`);
        for (const s of list(lock.states)) if (!list(body.states?.list).includes(s)) say("states.list", `State "${s}" cannot be removed`);
        for (const a of list(lock.transitions)) if (!list(body.states?.transitions).some((t) => t?.action === a)) say("states.transitions", `Action "${a}" cannot be removed`);
        for (const r of list(lock.rules)) if (!list(body.rules).some((x) => x?.script === r)) say("rules", `Rule ${r} cannot be removed`);
        for (const p of list(lock.policies)) if (!list(body.policies).some((x) => x?.id === p)) say("policies", `Policy ${p} cannot be removed`);
        // What the platform alone writes and makes: no policy hands it to a person.
        for (const [i, p] of list(body.policies).entries()) {
            for (const name of list(lock.managed)) if (p?.fields?.[name] === "write") say(`policies.${i}`, `Policy ${p.id ?? i} cannot let anyone write "${name}" (${MANAGED_WHY})`);
            if (lock.platformRecords && (p?.record?.create || p?.record?.archive)) say(`policies.${i}`, `Policy ${p.id ?? i} cannot let anyone make or archive a record here: the platform makes one per person`);
        }
        // Nor does a rule the plant adds set them.
        for (const [i, r] of list(body.rules).entries()) for (const name of list(lock.managed)) if (list(r?.writes).includes(name)) say(`rules.${i}`, `Rule ${r.script ?? i} cannot set "${name}" (${MANAGED_WHY})`);
    }
    return problems;
}

// Why an object cannot be retired: its keeping locks, in words. → [message]
export const keptBy = (locks = []) => list(locks).filter((l) => l.keep).map((l) => (l.by === "core" ? `the platform needs it (${l.why})` : `${holderWords(l)} relies on it`));

// What the platform alone writes on an object, and whether it alone makes its records.
export function managedOf(object) {
    const core = CORE_LOCKS[object] ?? [];
    return { fields: core.flatMap((l) => list(l.managed)), platformRecords: core.some((l) => l.platformRecords) };
}

// What two installed suites would fight over, in words: the same prefix, the same field added to the
// same object, or the same part locked as two different things. → [message] (none: they live together)
export function suiteClashes(suites) {
    const out = [];
    const prefixes = new Map();
    const added = new Map();
    const locked = new Map();
    for (const { name, label, pack } of suites) {
        if (pack?.prefix) {
            if (prefixes.has(pack.prefix)) out.push(`${prefixes.get(pack.prefix)} and ${name} both name their designs "${pack.prefix}…"`);
            else prefixes.set(pack.prefix, name);
        }
        for (const [object, ext] of Object.entries(isPlain(pack?.extends) ? pack.extends : {})) {
            for (const field of Object.keys(ext?.fields ?? {})) {
                const at = `${object}.${field}`;
                if (added.has(at)) out.push(`${added.get(at)} and ${name} both add ${at}`);
                else added.set(at, name);
            }
        }
        for (const [object, locks] of Object.entries(suiteLocks({ name, label }, pack))) {
            for (const lock of locks) {
                for (const [field, ref] of Object.entries(lock.fields ?? {})) {
                    const at = `${object}.${field}`;
                    const before = locked.get(at);
                    if (before && JSON.stringify(before.ref) !== JSON.stringify(ref)) out.push(`${before.suite} and ${name} lock ${at} as different things (${before.ref.type} and ${ref.type})`);
                    else if (!before) locked.set(at, { suite: name, ref });
                }
            }
        }
    }
    return out;
}
