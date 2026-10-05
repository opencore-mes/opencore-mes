// Design packs (DESIGN.md §29.6): designs a suite brings, offered to a plant's designers, never put
// live by the suite. A pack is data, the same shapes a change request carries:
//   { label, version, description,
//     definitions: [object bodies], transactions: [bodies], screens: [bodies], flows: [bodies],
//     scripts: { name: source }, tests: { script: [cases] },
//     roles: { object: { role: ["group:<id>" | "user:<id>"] } },        who gets which role, suggested
//     records: [{ key, object, data, actions? } | { ref, set } | { object, find, set }],   sample records
//                                                                       (find: a record already there, by
//                                                                       its fields: a Person by its user)
//     prefix: "semi_",                                                  its own names' start (needed to extend)
//     extends: { object: { fields: { name: field }, policies?: [policy], form?: { label } } },
//                                                                       fields it adds to an object it does not
//                                                                       bring (the built-in Person), each named
//                                                                       with its prefix, marked as the suite's
//     locks: { object: { fields?, states?, transitions?, rules?, policies?, keep?, why? } } }
//                                                                       what it relies on (builtins.js)
// A designer starts a change request from it (design.fromPack): every element that is new or differs
// from what is live, and the roles, through review and approval like any change. Once live, its
// designs are the plant's own: they work with the suite removed, because they are only designs.
// Sample records are loaded through the record services, as the person (design.samples): each is
// created, then takes its `actions` in turn; `@key` in data names a record created before it, and
// `{ ref, set }` sets fields of one created before (a cycle: a route and its first step). A record
// whose title is already there is left as it is, so loading again adds nothing.
import { fail } from "../../../src/errors.js";
import { canonical } from "./audit.js";

const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// What is wrong with a pack's shape, in words (suites.mjs stops the start with them).
export function packProblems(pack) {
    const out = [];
    if (!isPlain(pack)) return ["designs is { label, version, definitions, transactions, screens, scripts, roles, records }"];
    if (typeof pack.label !== "string" || !pack.label.trim()) out.push("designs.label: a name for the pack");
    if (typeof pack.version !== "string" || !pack.version.trim()) out.push("designs.version: its version, a string");
    for (const [kind, key] of [["definitions", "object"], ["connections", "name"], ["services", "name"], ["transactions", "name"], ["screens", "name"], ["flows", "name"], ["layouts", "name"], ["elements", "name"]]) {
        if (pack[kind] !== undefined && !(Array.isArray(pack[kind]) && pack[kind].every((b) => isPlain(b) && typeof b[key] === "string"))) out.push(`designs.${kind}: a list of bodies, each with its ${key}`);
    }
    for (const kind of ["scripts", "tests", "roles"]) if (pack[kind] !== undefined && !isPlain(pack[kind])) out.push(`designs.${kind}: an object`);
    for (const [name, source] of Object.entries(pack.scripts ?? {})) if (typeof source !== "string") out.push(`designs.scripts.${name}: its source, a string`);
    if (pack.records !== undefined && !Array.isArray(pack.records)) out.push("designs.records: a list");
    if (pack.prefix !== undefined && !(typeof pack.prefix === "string" && /^[a-z][a-z0-9]*_$/.test(pack.prefix))) out.push('designs.prefix: lower case letters and digits ending in "_" ("abc_")');
    if (pack.extends !== undefined) {
        if (!isPlain(pack.extends)) out.push("designs.extends: { object: { fields, policies?, form? } }");
        else if (typeof pack.prefix !== "string") out.push("designs.extends: a pack that extends an object names its prefix (designs.prefix), so two suites never add the same field");
        for (const [object, ext] of Object.entries(isPlain(pack.extends) ? pack.extends : {})) {
            if (!isPlain(ext) || !isPlain(ext.fields) || !Object.keys(ext.fields).length) { out.push(`designs.extends.${object}: { fields: { name: field }, policies?, form? }`); continue; }
            if ((pack.definitions ?? []).some((d) => d?.object === object)) out.push(`designs.extends.${object}: the pack brings ${object} itself: put the fields in its definition`);
            for (const name of Object.keys(ext.fields)) if (typeof pack.prefix === "string" && !name.startsWith(pack.prefix)) out.push(`designs.extends.${object}.fields.${name}: a field a suite adds to another's object starts with its prefix ("${pack.prefix}…")`);
            if (ext.policies !== undefined && !(Array.isArray(ext.policies) && ext.policies.every((p) => isPlain(p) && typeof p.id === "string" && typeof pack.prefix === "string" && p.id.startsWith(pack.prefix)))) out.push(`designs.extends.${object}.policies: a list of policies, each its id starting with the prefix`);
        }
    }
    if (pack.locks !== undefined && !(isPlain(pack.locks) && Object.values(pack.locks).every(isPlain))) out.push("designs.locks: { object: { fields?, states?, transitions?, rules?, policies?, keep?, why? } }");
    const keys = new Set();
    for (const [i, r] of (pack.records ?? []).entries()) {
        if (isPlain(r) && typeof r.ref === "string") {
            if (!keys.has(r.ref) || !isPlain(r.set)) out.push(`designs.records[${i}]: { ref, set } names a record listed before it`);
        } else if (isPlain(r) && r.find !== undefined) {
            if (typeof r.object !== "string" || !isPlain(r.find) || !Object.keys(r.find).length || !isPlain(r.set)) out.push(`designs.records[${i}]: { object, find: { field: value }, set } changes a record already there`);
        } else if (!isPlain(r) || typeof r.key !== "string" || typeof r.object !== "string" || !isPlain(r.data) || (r.actions !== undefined && !Array.isArray(r.actions))) {
            out.push(`designs.records[${i}]: { key, object, data, actions? }`);
        } else if (keys.has(r.key)) out.push(`designs.records[${i}]: the key "${r.key}" twice`);
        else keys.add(r.key);
    }
    return out;
}

// An object the pack extends, as it would be with the suite's fields: the live definition, its fields
// added (each marked `suite`, so it stays labelled if the suite is removed), its policies put in by id,
// and a form section of them. Fields the plant has already are set to the suite's, the rest left alone.
export function extendedBody(body, ext, { suite, label } = {}) {
    const out = JSON.parse(JSON.stringify(body));
    out.fields ??= {};
    for (const [name, field] of Object.entries(ext.fields ?? {})) out.fields[name] = { ...field, suite };
    out.policies = [...(out.policies ?? []).filter((p) => !(ext.policies ?? []).some((x) => x.id === p.id)), ...(ext.policies ?? [])];
    if (out.form?.sections) {
        const shown = new Set(out.form.sections.flatMap((sec) => (sec.fields ?? []).map((f) => (typeof f === "string" ? f : f?.field))));
        const missing = Object.keys(ext.fields ?? {}).filter((n) => !shown.has(n));
        if (missing.length) {
            const title = ext.form?.label ?? label ?? suite;
            const section = out.form.sections.find((sec) => sec.label === title);
            if (section) section.fields = [...(section.fields ?? []), ...missing];
            else out.form.sections.push({ label: title, fields: missing });
        }
    }
    return out;
}

// The pack's elements as a change carries them: kind → { name: body }. With `live`, the objects it
// extends too, as they would be (those not live are left: nothing to extend yet).
export function packElements(pack, live = null) {
    const extended = live ? Object.fromEntries(Object.entries(pack.extends ?? {}).filter(([object]) => live.definitions?.[object]).map(([object, ext]) => [object, extendedBody(live.definitions[object].body, ext, { suite: pack.name, label: pack.suite ?? pack.label })])) : {};
    return {
        definitions: { ...extended, ...Object.fromEntries((pack.definitions ?? []).map((b) => [b.object, b])) },
        connections: Object.fromEntries((pack.connections ?? []).map((b) => [b.name, b])),
        services: Object.fromEntries((pack.services ?? []).map((b) => [b.name, b])),
        transactions: Object.fromEntries((pack.transactions ?? []).map((b) => [b.name, b])),
        screens: Object.fromEntries((pack.screens ?? []).map((b) => [b.name, b])),
        flows: Object.fromEntries((pack.flows ?? []).map((b) => [b.name, b])),
        layouts: Object.fromEntries((pack.layouts ?? []).map((b) => [b.name, b])),
        // Design elements of the suites' own kinds (§30.11): carried as they are, whichever suite's.
        elements: Object.fromEntries((pack.elements ?? []).map((b) => [b.name, b])),
        scripts: { ...(pack.scripts ?? {}) },
    };
}

// Each element against what is live: "new", "changed" or "same". `live` is design.js published().
export function packStatus(pack, live) {
    const out = [];
    for (const [kind, named] of Object.entries(packElements(pack, live))) {
        for (const [name, body] of Object.entries(named)) {
            const current = kind === "scripts" ? live.scripts[name]?.source : live[kind][name]?.body;
            const same = current !== undefined && (kind === "scripts" ? current === body : canonical(current) === canonical(body));
            out.push({ kind, name, label: kind === "scripts" ? name : body.label ?? name, status: current === undefined ? "new" : same ? "same" : "changed" });
        }
    }
    return out;
}

// The roles it suggests that the organization lacks, of subjects that exist: [[object, role, subject]].
export function missingRoles(pack, org) {
    const out = [];
    for (const [object, roles] of Object.entries(pack.roles ?? {})) {
        for (const [role, subjects] of Object.entries(roles ?? {})) {
            for (const subject of subjects ?? []) {
                const [kind, id] = String(subject).split(":");
                const exists = kind === "group" ? Boolean(org.groups?.[id] ?? org.departments?.[id]) : kind === "user" ? Boolean(org.users?.[id]) : false;
                if (exists && !(org.roles?.[object]?.[role] ?? []).includes(subject)) out.push([object, role, subject]);
            }
        }
    }
    return out;
}

// The state a record reaches from its object's initial state by taking `actions` in turn (the seed's
// path, which writes the state directly); null when one does not apply.
export function stateAfter(body, actions = []) {
    let state = body.states.initial;
    for (const action of actions) {
        const t = (body.states.transitions ?? []).find((x) => x.action === action && (x.from ?? []).includes(state));
        if (!t) return null;
        state = t.to;
    }
    return state;
}

// `@key` in a record's data → the id created for it.
export const resolveRefs = (data, ids) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === "string" && v.startsWith("@") ? ids[v.slice(1)] ?? null : v]));

// design.samples: a pack's sample records, through the record services as the person.
export function createSamples({ store, records, packs }) {
    const call = (self, name, args) => records.services[name].call(self, args);
    return {
        async "design.samples"({ suite } = {}) {
            // Offered in the designer, to those it is shared with (the records are still written as the
            // person, by their own rights); nobody else loads a suite's samples.
            const person = await store.userForSession(this?.sessionId);
            if (!person) fail("Sign in first.", { status: 401 });
            if (!(await store.rolesFor(person.id, "design")).length) fail("The designer is not shared with you.", { status: 403 });
            const pack = packs()[suite];
            if (!pack) fail(`No suite named "${suite}" with designs is installed.`, { status: 404 });
            const ids = {};
            let made = 0;
            let there = 0;
            const waiting = [];
            for (const r of pack.records ?? []) {
                // One already there (a Person, made by the platform): found by its fields, changed as the person.
                if (r.find !== undefined) {
                    const where = Object.entries(r.find);
                    const [found] = await store.db.query(`SELECT id FROM mes.records WHERE object = $1 AND archived_at IS NULL AND ${where.map((_, i) => `data->>$${i * 2 + 2} = $${i * 2 + 3}`).join(" AND ")} LIMIT 1`, [r.object, ...where.flatMap(([k, v]) => [k, String(v)])]);
                    if (!found) continue;
                    const current = await call(this, "records.get", { object: r.object, id: found.id });
                    const set = resolveRefs(r.set, ids);
                    if (Object.entries(set).every(([k, v]) => JSON.stringify(current[k] ?? null) === JSON.stringify(v))) { there++; continue; }
                    await call(this, "records.update", { object: r.object, id: found.id, rowVersion: Number(current.row_version), data: set, key: `sample-${suite}-find-${r.object}-${found.id}-${current.row_version}` });
                    made++;
                    continue;
                }
                if (r.ref !== undefined) {
                    const target = (pack.records ?? []).find((x) => x.key === r.ref);
                    const id = ids[r.ref];
                    if (!id || !target) continue;
                    const current = await call(this, "records.get", { object: target.object, id });
                    const set = resolveRefs(r.set, ids);
                    if (Object.entries(set).every(([k, v]) => current[k] === v)) continue;
                    await call(this, "records.update", { object: target.object, id, rowVersion: Number(current.row_version), data: set, key: `sample-${suite}-${r.ref}-set-${current.row_version}` });
                    continue;
                }
                const def = await store.definition(r.object);
                if (!def) fail(`"${r.object}" is not live yet: the pack's designs are approved first, then its samples loaded.`, { status: 409 });
                const title = r.data[def.body.titleField];
                const [existing] = title === undefined ? [] : await store.db.query(`SELECT id FROM mes.records WHERE object = $1 AND data->>$2 = $3 AND archived_at IS NULL LIMIT 1`, [r.object, def.body.titleField, String(title)]);
                if (existing) { ids[r.key] = existing.id; there++; continue; }
                // Where the object's design makes a new record or an action wait for approval (§28), the
                // request says why: a sample of the suite's designs.
                const reason = `A sample of the ${pack.label ?? suite} designs.`;
                let row = await call(this, "records.create", { object: r.object, data: resolveRefs(r.data, ids), key: `sample-${suite}-${r.key}`, reason });
                if (!row?.id || row.state === undefined) { waiting.push(r.key); continue; }
                ids[r.key] = row.id;
                made++;
                for (const action of r.actions ?? []) {
                    row = await call(this, "records.action", { object: r.object, id: row.id, action, rowVersion: Number(row.row_version), key: `sample-${suite}-${r.key}-${action}`, reason });
                    if (row?.state === undefined) { waiting.push(`${r.key} ${action}`); break; }
                }
            }
            return { made, there, waiting, objects: [...new Set((pack.records ?? []).filter((r) => r.object).map((r) => r.object))] };
        },
    };
}
export const samplesTouches = {
    "design.samples": (args, result) => [...(result?.objects ?? []).map((object) => ({ name: "records.list", where: { object } })), { name: "screens.data" }, { name: "popups.for" }],
};
