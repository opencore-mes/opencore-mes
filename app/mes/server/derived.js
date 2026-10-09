// Derived fields (DESIGN.md §6.11): a field whose value the platform keeps, from a reference path
// (`from: "product.control"`, as many hops as the references go: `lot.product.control`), or from an
// expression over the record and such paths (`from: { "eq": [{ "record": "product.control" }, "military"] }`).
// Nobody writes one: it is worked out at every write of its record, and again, in the same database
// transaction, when a record it reads through changes, so a lot's `control` follows its product's the
// moment the product is reclassified. Everything else (lists, queries, conditions, policies, the access
// a record requires, §9.9) reads it as the record's own field, in the browser and in SQL alike.
//
// A path's hops: [{ object, field }] from the derived field's own object, each `field` a single
// reference but the last, which is the value read (a field, or `state`).
import { referencesOf, evaluate } from "../client/expr.js";
import { isDerived } from "../client/definition.js";

export { isDerived };

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The derived fields of a definition, in declaration order: [[name, field]].
export const derivedOf = (body) => Object.entries(body?.fields ?? {}).filter(([, f]) => f?.from !== undefined);

// The paths a derived field reads: its own (a path), or those its expression reads through a reference.
export function pathsOf(body, field) {
    if (typeof field.from === "string") return [field.from];
    return [...new Set(referencesOf(field.from).filter((r) => r.scope === "record" && throughRef(body, r.path)).map((r) => String(r.path)))];
}
const throughRef = (body, path) => String(path).includes(".") && body.fields?.[String(path).split(".")[0]]?.type === "ref";

// A path's hops, against the definitions (`defOf(object)` → body or null); null when it does not go.
export function hopsOf(body, path, defOf) {
    const parts = String(path).split(".");
    const hops = [];
    let at = body;
    for (const [k, part] of parts.entries()) {
        if (!at) return null;
        const last = k === parts.length - 1;
        if (last) {
            if (part !== "state" && !at.fields?.[part]) return null;
            hops.push({ object: at.object, field: part });
            return hops;
        }
        const f = at.fields?.[part];
        if (f?.type !== "ref" || f.multiple) return null;
        hops.push({ object: at.object, field: part });
        at = defOf(f.to);
    }
    return null;
}

// What a path reads for one record's data: the value at its end, or undefined where a reference on the
// way is empty or names no record. `load(object, id)` → { data, state } or null (cached by the caller).
async function follow(body, data, path, defOf, load) {
    const hops = hopsOf(body, path, defOf);
    if (!hops || hops.length < 2) return undefined;
    let values = data;
    let state;
    for (const [k, hop] of hops.entries()) {
        if (k === hops.length - 1) return hop.field === "state" ? state : values?.[hop.field];
        const id = values?.[hop.field];
        if (typeof id !== "string" || !UUID.test(id)) return undefined;
        const target = await load(hops[k + 1].object, id);
        if (!target) return undefined;
        values = target.data;
        state = target.state;
    }
    return undefined;
}

// A loader over a query runner, caching what it has read for one write (or one batch).
export function loaderOf(q) {
    const cache = new Map();
    return async (object, id) => {
        if (!object) return null;
        const key = `${object}:${id}`;
        if (!cache.has(key)) {
            const [row] = await q.query("SELECT data, state FROM mes.records WHERE object = $1 AND id = $2", [object, id]);
            cache.set(key, row ? { data: row.data ?? {}, state: row.state } : null);
        }
        return cache.get(key);
    };
}

// `data` with its derived fields worked out, in declaration order (one may read an earlier one).
// Empty when what it reads is empty: null, never undefined, so a cleared value is stored as cleared.
export async function withDerived(body, data, defOf, load) {
    const out = { ...data };
    for (const [name, field] of derivedOf(body)) {
        let value;
        if (typeof field.from === "string") value = await follow(body, out, field.from, defOf, load);
        else {
            // The record as the expression sees it: each reference it reads through, an object of the
            // values found along its paths (product → { control: "military" }).
            const scope = { ...out };
            for (const path of pathsOf(body, field)) {
                const [head, ...rest] = path.split(".");
                const v = await follow(body, out, path, defOf, load);
                let node = (scope[head] = isPlain(scope[head]) ? scope[head] : {});
                for (const [i, part] of rest.entries()) {
                    if (i === rest.length - 1) node[part] = v;
                    else node = node[part] = isPlain(node[part]) ? node[part] : {};
                }
            }
            try { value = evaluate(field.from, { record: scope }); } catch { value = undefined; }
        }
        out[name] = value === undefined ? null : value;
    }
    return out;
}

// Which derived fields read through which records: for every published object with derived fields,
// each of its paths' hops. → [{ object, field (the derived one), hops }].
const depsKept = new WeakMap();
export function dependencies(defs) {
    if (depsKept.has(defs)) return depsKept.get(defs);
    const found = dependenciesOf(defs);
    depsKept.set(defs, found);
    return found;
}
function dependenciesOf(defs) {
    const defOf = (o) => defs.get(o) ?? null;
    const out = [];
    for (const body of defs.values()) {
        for (const [name, field] of derivedOf(body)) {
            for (const path of pathsOf(body, field)) {
                const hops = hopsOf(body, path, defOf);
                if (hops && hops.length > 1) out.push({ object: body.object, field: name, hops });
            }
        }
    }
    return out;
}

// The objects whose derived fields read through records of `object`, directly or further along: what a
// write to `object` may change besides itself (a mutation's touches).
export function dependentObjects(defs, object) {
    const deps = dependencies(defs);
    const seen = new Set();
    const queue = [object];
    while (queue.length) {
        const at = queue.shift();
        for (const d of deps) if (!seen.has(d.object) && d.hops.slice(1).some((h) => h.object === at)) { seen.add(d.object); queue.push(d.object); }
    }
    seen.delete(object);
    return [...seen];
}

// The records of `d.object` whose derived field `d` reads through record `id` of `object` (its fields
// `changed` among those on the path): walked back from that hop, one reference at a time.
async function affected(q, d, object, id, changed) {
    const ids = new Set();
    for (let k = 1; k < d.hops.length; k++) {
        const hop = d.hops[k];
        if (hop.object !== object || !changed.includes(hop.field)) continue;
        let at = [id];
        for (let j = k - 1; j >= 0 && at.length; j--) {
            const h = d.hops[j];
            at = (await q.query(`SELECT id::text FROM mes.records WHERE object = $1 AND archived_at IS NULL AND data->>$2 = ANY($3::text[])`, [h.object, h.field, at])).map((r) => r.id);
        }
        for (const x of at) ids.add(x);
    }
    return [...ids];
}

// After a write to record `id` of `object` changed `changed` (field names, `state` for an action):
// each record whose derived fields read through it, worked out again and written where they moved, by
// `write(object, row, data, moved, from)` (the caller's: sealed, audited; `from` is the record it follows),
// then what reads through those, in turn.
// Never more than `depth` hops of records deep; a record is visited once per write.
export async function refreshDependents(q, defs, object, id, changed, write, { depth = 6, seen = new Set() } = {}) {
    if (!changed.length || depth <= 0) return [];
    const defOf = (o) => defs.get(o) ?? null;
    const load = loaderOf(q);
    const done = [];
    const deps = dependencies(defs).filter((d) => d.hops.slice(1).some((h) => h.object === object && changed.includes(h.field)));
    const byObject = new Map();
    for (const d of deps) for (const rid of await affected(q, d, object, id, changed)) {
        const set = byObject.get(d.object) ?? new Set();
        set.add(rid);
        byObject.set(d.object, set);
    }
    for (const [o, ids] of byObject) {
        const body = defOf(o);
        for (const rid of ids) {
            if (seen.has(`${o}:${rid}`)) continue;
            seen.add(`${o}:${rid}`);
            const [row] = await q.query("SELECT * FROM mes.records WHERE object = $1 AND id = $2 FOR UPDATE", [o, rid]);
            if (!row || row.archived_at) continue;
            const next = await withDerived(body, row.data ?? {}, defOf, load);
            const moved = derivedOf(body).map(([n]) => n).filter((n) => JSON.stringify(row.data?.[n] ?? null) !== JSON.stringify(next[n] ?? null));
            if (!moved.length) continue;
            await write(o, row, next, moved, { object, id });
            done.push({ object: o, id: rid, fields: moved });
            done.push(...(await refreshDependents(q, defs, o, rid, moved, write, { depth: depth - 1, seen })));
        }
    }
    return done;
}

// What a design check says of one object's derived fields (definition.js validates their shape; this
// needs the other objects): each path must go, by single references, to a field or a state, never to a
// sensitive field (its value would be read under this object's policies), and the field's type must
// take what it reads. → [{ path, message }].
export function derivedProblems(body, defOf) {
    const out = [];
    for (const [name, field] of derivedOf(body)) {
        const at = `fields.${name}.from`;
        for (const path of pathsOf(body, field)) {
            const hops = hopsOf(body, path, defOf);
            if (hops && hops.length < 2) { out.push({ path: at, message: `"${name}": ${path} is this object's own; a derived field reads through a reference (product.control).` }); continue; }
            if (!hops) { out.push({ path: at, message: `"${name}": ${path} does not go: each step but the last is a reference (one record) to an object that has the next field.` }); continue; }
            const end = hops.at(-1);
            const target = defOf(end.object);
            const tf = end.field === "state" ? { type: "string" } : target?.fields?.[end.field];
            if (tf?.sensitive) out.push({ path: at, message: `"${name}": ${path} is sensitive on ${target.label ?? end.object}; it cannot be copied where its own protection does not go.` });
            if (typeof field.from === "string" && tf) {
                const same = tf.type === field.type || (["integer", "decimal"].includes(tf.type) && ["integer", "decimal"].includes(field.type)) || (field.type === "string" && ["enum", "string", "text", "date"].includes(tf.type));
                if (!same) out.push({ path: `fields.${name}.type`, message: `"${name}" is ${field.type}, and ${path} is ${tf.type}: give it the type it reads.` });
                if (field.type === "ref" && tf.type === "ref" && tf.to !== field.to) out.push({ path: `fields.${name}.to`, message: `"${name}" refers to ${field.to}, and ${path} to ${tf.to}.` });
                if (Boolean(tf.multiple) !== Boolean(field.multiple)) out.push({ path: `fields.${name}.multiple`, message: `"${name}" ${field.multiple ? "holds several values" : "holds one value"}, and ${path} ${tf.multiple ? "several" : "one"}.` });
            }
        }
    }
    return out;
}

// A derived field that reads, along some path, what is derived from it (a lot's from its product's,
// the product's from the lot's): it would never settle. → [{ object, field, cycle: ["lot.x", …] }].
export function derivedCycles(defs) {
    const defOf = (o) => defs.get(o) ?? null;
    const edges = new Map();
    for (const body of defs.values()) {
        for (const [name, field] of derivedOf(body)) {
            const to = new Set();
            for (const path of pathsOf(body, field)) for (const h of hopsOf(body, path, defOf) ?? []) to.add(`${h.object}.${h.field}`);
            // An expression's own fields too (one derived field reading another of its record).
            if (typeof field.from !== "string") for (const r of referencesOf(field.from)) if (r.scope === "record" && !String(r.path).includes(".")) to.add(`${body.object}.${r.path}`);
            edges.set(`${body.object}.${name}`, to);
        }
    }
    const out = [];
    const walk = (node, trail) => {
        for (const next of edges.get(node) ?? []) {
            if (next === trail[0]) { out.push({ cycle: [...trail, next] }); continue; }
            if (!trail.includes(next) && edges.has(next) && trail.length < 12) walk(next, [...trail, next]);
        }
    };
    for (const start of edges.keys()) walk(start, [start]);
    const seen = new Set();
    return out.filter((c) => { const key = [...c.cycle.slice(0, -1)].sort().join(); if (seen.has(key)) return false; seen.add(key); return true; })
        .map((c) => { const [object, field] = c.cycle[0].split("."); return { object, field, cycle: c.cycle }; });
}

// Which objects' derived values a change moves: those whose derived fields it adds or changes, then
// the objects that read through them (in that order, so what is read is worked out first).
export function changedDerived(before, after) {
    const out = [];
    for (const [object, body] of after) {
        const was = before.get(object);
        const now = JSON.stringify(derivedOf(body).map(([n, f]) => [n, f.from, f.type]));
        if (derivedOf(body).length && JSON.stringify(derivedOf(was).map(([n, f]) => [n, f.from, f.type])) !== now) out.push(object);
    }
    const wanted = new Set(out);
    for (const o of out) for (const d of dependentObjects(after, o)) wanted.add(d);
    // Each after the objects it reads through (a cycle is refused at the check, derivedCycles).
    const reads = new Map([...wanted].map((o) => [o, new Set(dependencies(after).filter((d) => d.object === o).flatMap((d) => d.hops.slice(1).map((h) => h.object)).filter((x) => x !== o && wanted.has(x)))]));
    const order = [];
    while (order.length < wanted.size) {
        const next = [...wanted].find((o) => !order.includes(o) && [...reads.get(o)].every((x) => order.includes(x))) ?? [...wanted].find((o) => !order.includes(o));
        order.push(next);
    }
    return order;
}

// Every record in use of `object` with its derived fields worked out again, in batches, as the platform
// writes over many records (§7.7): `seal(ids)` reseals what moved (the caller's: let by the tripwire).
// → how many records moved.
export async function recomputeAll(tx, bodies, object, seal, { batch = 500 } = {}) {
    const body = bodies.get(object);
    if (!body || !derivedOf(body).length) return 0;
    const defOf = (o) => bodies.get(o) ?? null;
    const load = loaderOf(tx);
    const names = derivedOf(body).map(([n]) => n);
    let after = "00000000-0000-0000-0000-000000000000";
    let moved = 0;
    for (;;) {
        const rows = await tx.query("SELECT id, data FROM mes.records WHERE object = $1 AND archived_at IS NULL AND id > $2 ORDER BY id LIMIT $3", [object, after, batch]);
        if (!rows.length) return moved;
        const ids = [];
        for (const row of rows) {
            const next = await withDerived(body, row.data ?? {}, defOf, load);
            if (names.some((n) => JSON.stringify(row.data?.[n] ?? null) !== JSON.stringify(next[n] ?? null))) {
                await tx.query("UPDATE mes.records SET data = $3 WHERE object = $1 AND id = $2", [object, row.id, JSON.stringify(next)]);
                ids.push(row.id);
            }
        }
        if (ids.length) await seal(ids);
        moved += ids.length;
        after = rows.at(-1).id;
    }
}
