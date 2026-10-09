// Transactions (DESIGN.md §25): a screen that changes several records as one. What a transaction is
// (its inputs and form, its checks, its steps) is a definition, designed and approved like an object
// (definition.js validateTransaction); nothing here knows what a lot or a machine is.
//
// A run, all or nothing:
//   1. who may run it: its callers (deny by default);
//   2. the inputs, checked against their types; a reference must name a record the person can see,
//      and an input "from" another (the lot's machine) is filled in from that record;
//   3. the checks (`require`), on the records as they are;
//   4. each step planned, in order, through the target object's own policies (the person's roles,
//      with `via` naming this transaction), rule pipe and validation, on the record as the earlier
//      steps leave it; nothing is written yet. A refusal names the record and says why;
//   5. one database transaction: every record the inputs name locked, in one order, and found
//      unchanged since step 4; the checks and each step's `when` worked out again under the lock
//      (a capacity count cannot be passed twice); every step written, with its audit row, its
//      analytics and its triggers; the run itself audited; the answer kept under the idempotency key.
// A preview is steps 1 to 4: what would change, with nothing written.
//
// A step changes a record an input names (`on`: `set`, then `action`), or creates one (`create`: an
// object, `set` its fields), once or once per row of a rows input (`forEach`, read as { row }): a
// sample's readings, a lot's wafers. Or it changes the records it finds (`find`: { object, where, limit }, `as`
// a name): those of an object whose fields equal what the run works out, that the person may read, in use, the
// oldest first; each set and acted on as an input's record is, locked with them, and found again under the
// lock (another one matching since is a stale run). The steps after it read what it found as
// { found: "<as>.count" } and { found: "<as>.first.<field>" }. A created record goes through its object's policies, rule pipe and
// validation like any other (records.internals planCreate), as the person, in the same run.
import { ServiceError, fail } from "@opencore-mes/juris-kit/errors.js";
import { evaluate, countsOf } from "../client/expr.js";
import { validate } from "./services.js";
import { appendAudit } from "./audit.js";
import { channelOf } from "./call-stats.js";
import { mask } from "./policy.js";
import { recordWhere } from "./record-where.js";
import { derivedOrder, hiddenValue, isSensitive, trimValues } from "../client/definition.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const refused = (message, extra = {}) => new ServiceError(message, { status: 422, code: "transaction.refused", ...extra });

// How many records of an object in use have fields equal to `where` (a list: any of its values).
async function countRecords(q, { object, where }) {
    const w = recordWhere(object, where);
    if (!w) return 0;
    const [{ n }] = await q.query(`SELECT count(*)::int AS n FROM mes.records WHERE ${w.sql}`, w.params);
    return n;
}

// The input flow a transaction or a screen names (§32.13), as the browser walks it: its steps and wires.
// → { inputFlow } or {} (none, or not an input flow)
export async function inputFlowOf(store, name) {
    if (typeof name !== "string") return {};
    const f = (await store.flows()).get(name);
    return f?.body?.kind === "input" ? { inputFlow: { name, version: f.version, label: f.body.label, nodes: f.body.nodes ?? {}, edges: f.body.edges ?? [] } } : {};
}

export function createTransactions({ store, records, log = console, outbound = true, signatures = null }) {
    const { db } = store;
    const x = records.internals;
    // The step kinds the installed suites add (§30.11): "<suite>.<kind>" → { label, config, required,
    // irreversible, plan(values, info) → planned, apply(tx, planned, info) → detail }. A step of one,
    // `{ step: "<suite>.<kind>", <setting>: <value or expression>, when? }`, has its settings worked out
    // with the transaction's scope, is planned with the rest (no effect yet; it may refuse, in words),
    // and applied inside the run's database transaction, in its place among the steps: if it throws,
    // nothing of the run is kept. What it cannot take back (`irreversible`: a command sent to a
    // machine) comes after every step that can still refuse, so it is sent only once the rest held.
    // `info`: { user, transaction, run, outbound }; where `outbound` is false (a sandbox, a public
    // demo) it acts on nothing outside the database.
    let stepKinds = () => ({});
    const STEP_KEYS = ["step", "when", "label"];
    // Flows (§32, flows.js), once they exist: what a traveler's node allows and gives its transactions
    // ({ node }), and what moves a traveler on once a run has committed.
    let flows = null;
    // The named queries (query.js): a reference input's choices from one are checked on a run (§23.1).
    let query = null;

    async function mayCall(t, user) {
        const callers = t.body.callers ?? {};
        // A service acting as its own role (§15.2, `service:<name>`): only if the callers name it.
        if (String(user.id).startsWith("service:")) return (callers.services ?? []).includes(String(user.id).slice(8));
        // A route running it on its traveler (§32.15, `flow:<name>`): only if the callers name the route.
        if (String(user.id).startsWith("flow:")) return (callers.flows ?? []).includes(String(user.id).slice(5));
        if ((callers.users ?? []).includes(user.id)) return true;
        if (!(callers.groups ?? []).length) return false;
        const groups = await db.query("SELECT group_id FROM mes.group_members WHERE user_id = $1", [user.id]);
        return groups.some((g) => callers.groups.includes(g.group_id));
    }
    async function load(name) {
        const t = typeof name === "string" ? (await store.transactions()).get(name) : null;
        if (!t) fail("No such transaction.", { status: 404 });
        return t;
    }
    async function callable(self, name, as) {
        const user = await x.requireViewer(self, as);
        const t = await load(name);
        if (!(await mayCall(t, user))) {
            const c = t.body.callers ?? {};
            fail(`${String(user.id).startsWith("service:") ? `The service ${String(user.id).slice(8)} may` : "You may"} not run ${t.body.label}: it is for ${[...(c.users ?? []), ...(c.groups ?? []).map((g) => `group ${g}`), ...(c.services ?? []).map((sv) => `the service ${sv}`)].join(", ") || "nobody yet"}. Its stewards (${(t.body.stewards ?? []).join(", ") || "none"}) approve who may.`, { status: 403, code: "transaction.denied" });
        }
        return { user, t };
    }
    // A call made from a service's script (integration.js): its context names the chain of services.
    const fromService = (self) => Array.isArray(self?.origin?.chain) && self.origin.chain.length > 0;
    const signedForService = (t) => { if (t.body.signature) fail(`${t.body.label} is signed by the person running it: a service does not run it.`, { status: 403, code: "transaction.signed" }); };
    // What the screen needs: never its checks or steps (they are the server's to work out). Its input flow
    // (§32.10) comes with it, as published.
    const publicOf = (t) => ({
        name: t.body.name, version: t.version, label: t.body.label, description: t.body.description ?? "",
        inputs: t.body.inputs, form: t.body.form ?? null, appearsOn: t.body.appearsOn ?? null,
        confirm: t.body.confirm !== false, signature: t.body.signature ?? null, maximize: t.body.maximize ?? null,
    });

    // The counts an expression needs, counted (in `q`, the transaction's own once it is open).
    async function withCounts(q, exprs, scope) {
        const counts = {};
        for (const spec of exprs.flatMap((e) => countsOf(e, scope))) if (!(spec.key in counts)) counts[spec.key] = await countRecords(q, spec);
        return { ...scope, counts };
    }
    const conditions = (body) => [...(body.require ?? []).map((r) => r.that), ...(body.steps ?? []).map((st) => st.when).filter((w) => w !== undefined), ...(body.steps ?? []).flatMap((st) => Object.values(st.set ?? {})), ...(body.steps ?? []).filter((st) => st.step !== undefined).flatMap((st) => Object.entries(st).filter(([k]) => !["step", "when", "label"].includes(k)).map(([, e]) => e))];

    // The built-in Person record of who acts (builtins.js): its fields, for a condition to read; {} when none.
    async function personOf(userId) {
        const [row] = await db.query("SELECT r.data FROM mes.records r JOIN mes.definitions d ON d.object = 'person' AND d.status = 'published' AND (d.body->>'builtIn')::boolean WHERE r.object = 'person' AND r.data->>'user' = $1 AND r.archived_at IS NULL LIMIT 1", [userId]);
        return row?.data ?? {};
    }

    // One field of a record an input names, as this person reads it (null: empty, or hidden from them).
    async function seenField(user, row, field) {
        if (!row) return null;
        const def = await store.definition(row.object);
        const seen = def ? mask(def.body, await x.actorFor(user, row.object), x.rowOut(row)) : null;
        return seen?.[field] ?? null;
    }

    // The inputs: typed, references checked, derived ones filled in. → { values, picked, scope }
    async function inputsOf(user, body, input) {
        const specs = body.inputs ?? {};
        const values = {};
        // What was typed, trimmed (§11.1a): only spaces is nothing.
        const given = trimValues(specs, isPlain(input) ? input : {});
        for (const [k, spec] of Object.entries(specs)) if (spec.from === undefined && given[k] !== undefined && given[k] !== "") values[k] = given[k];
        // Rows: the ones with something in them (an empty last row of a table is not a reading).
        for (const [k, spec] of Object.entries(specs)) {
            if (spec.type === "rows" && Array.isArray(values[k])) values[k] = values[k].filter((r) => isPlain(r) && Object.values(r).some((v) => v !== null && v !== undefined && v !== ""));
        }
        const problems = {};
        const picked = {}; // input -> the database row it names
        const pick = async (k, spec, id) => {
            if (typeof id !== "string" || !UUID.test(id)) return;
            const def = await store.definition(spec.to);
            const row = def ? await x.loadRow(db, spec.to, id) : null;
            const visible = row && mask(def.body, await x.actorFor(user, spec.to), x.rowOut(row));
            if (!visible) { problems[k] = `No ${def?.body.label?.toLowerCase() ?? spec.to} that you can see.`; return; }
            if (row.archived_at) { problems[k] = `${x.nounOf(def, row)} is archived.`; return; }
            picked[k] = row;
        };
        for (const [k, spec] of Object.entries(specs)) if (spec.type === "ref" && spec.from === undefined && values[k] !== undefined) await pick(k, spec, values[k]);
        // Filled in, each after the one it is filled in from (the product's route, then its first step).
        for (const k of derivedOrder(specs).order) {
            const spec = specs[k];
            const [source, field] = spec.from.split(".");
            // A value copied (the lot's units): as the person reads it, never a field hidden from them.
            if (spec.type !== "ref") { const v = await seenField(user, picked[source], field); if (v !== null) values[k] = v; continue; }
            const id = picked[source]?.data?.[field] ?? null;
            if (id) { values[k] = id; await pick(k, spec, id); }
        }
        // Types, required, requiredWhen: the field rules, over the inputs. A derived input that is
        // empty says which record lacks it ("Lot 4713 has no machine.").
        const invalid = validate({ fields: specs }, values) ?? {};
        for (const [k, m] of Object.entries(invalid)) {
            const [source, field] = String(specs[k]?.from ?? "").split(".");
            const src = picked[source];
            const srcDef = src ? await store.definition(src.object) : null;
            problems[k] ??= src && srcDef ? `${x.nounOf(srcDef, src)} has no ${(srcDef.body.fields[field]?.label ?? field).toLowerCase()}.` : m;
        }
        if (Object.keys(problems).length) fail("Some inputs need attention.", { fields: problems, code: "transaction.input" });
        const scope = {
            input: values,
            lookup: Object.fromEntries(Object.entries(picked).map(([k, row]) => [k, x.recordOf(row)])),
            // Who runs it, and the certifications they hold today (§27.9): a step only a certified person does
            // (the CNC router, the spray booth) is a condition on { user: "certifications" }. A service acting as
            // its own identity holds those its design names (§9.9).
            user: { id: user.id, name: user.name, certifications: user.certifications ?? await x.certificationsOf(user.id), departments: await store.departmentsOf(user.id) },
            // Who runs it, as the built-in Person has them: read for the decision, whatever their roles on Person.
            person: await personOf(user.id),
        };
        return { values, picked, scope };
    }

    // A reference input whose choices come from a named query (§23.1): what was entered is one the query gives this
    // person, its parameters read over the inputs, the records they name, the person and the route step; asked of
    // the query by the record's id. A refusal is said on that input.
    async function choicesHold(user, body, given) {
        if (!query) return;
        const problems = {};
        for (const [k, spec] of Object.entries(body.inputs ?? {})) {
            const src = spec?.options;
            const value = given.values[k];
            if (spec?.type !== "ref" || typeof src?.query !== "string" || typeof value !== "string" || !value) continue;
            const q = (await store.queries()).get(src.query)?.body;
            if (!q) { problems[k] = `Its choices come from the query ${src.query}, which is not there: ask whoever designs ${body.label}.`; continue; }
            const values = Object.fromEntries(Object.entries(src.params ?? {}).map(([p, e]) => [p, evaluate(e, given.scope)]));
            const has = await query.hasId(user, q, values, value, { channel: "choices" });
            if (!has.ok) problems[k] = has.problem ? `Fill in what its choices depend on first: ${has.problem}` : `That ${String(spec.label ?? k).toLowerCase()} is not one of its choices (${q.label ?? src.query}): pick one from the list.`;
        }
        if (Object.keys(problems).length) fail("Some inputs need attention.", { fields: problems, code: "transaction.input" });
    }

    // The checks, on `scope` (with its counts). A failing one refuses the run, on its input if it names one.
    function check(body, scope) {
        for (const r of body.require ?? []) {
            if (evaluate(r.that, scope) === true) continue;
            throw refused(r.message, r.field ? { fields: { [r.field]: r.message } } : {});
        }
    }

    // Every step, planned: [{ step, skipped } | plan]. `as` is the person, with `via` this transaction.
    async function planSteps(self, as, body, t, { values, picked, scope }) {
        const plans = [];
        const now = new Map(); // record id -> the row as the steps so far leave it
        // …and, for records a suite's step writes that no input names, the row before any step (§30.11), so what
        // the run changes lists them too.
        const before = new Map();
        const found = []; // [{ step, ids, rows }]: what each find step found, to lock and to find again
        for (const [i, st] of (body.steps ?? []).entries()) {
            if (st.when !== undefined && evaluate(st.when, scope) !== true) { plans.push({ step: i, skipped: true }); continue; }
            if (st.find !== undefined) {
                const def = await x.definitionOf(st.find.object);
                const rows = await findRows(db, as, def, st.find, scope);
                scope.found = { ...(scope.found ?? {}), [st.as]: { count: rows.length, first: rows[0] ? x.recordOf(rows[0]) : null } };
                found.push({ step: i, ids: rows.map((r) => r.id), rows });
                for (const hit of rows) {
                    let row = now.get(hit.id) ?? hit;
                    try {
                        if (st.set) {
                            const data = {};
                            for (const [f, e] of Object.entries(st.set)) { const v = evaluate(e, scope); if (v !== undefined) data[f] = v; }
                            const p = await x.planUpdate(self, as, def, row, data);
                            if (p) { plans.push({ ...p, step: i }); row = p.after; }
                        }
                        if (st.action) { const p = await x.planAction(self, as, def, row, st.action); plans.push({ ...p, step: i }); row = p.after; }
                    } catch (error) {
                        if (!error?.expose && !(error instanceof ServiceError)) throw error;
                        throw new ServiceError(`${x.nounOf(def, row)}: ${error.message}`, { status: error.status ?? 422, code: error.code ?? "transaction.refused" });
                    }
                    if (!now.has(hit.id) && !Object.values(picked).some((r) => r?.id === hit.id)) before.set(hit.id, hit);
                    now.set(hit.id, row);
                }
                continue;
            }
            if (st.step !== undefined) {
                const spec = stepKinds()[st.step];
                // Its suite is gone: this transaction says so and does nothing; every other one runs.
                if (!spec) throw refused(`Step ${i + 1} of ${body.label} needs the ${String(st.step).split(".")[0]} suite, which is not installed here: it cannot run until the suite is back. Ask IT.`, { code: "suite.missing" });
                const settings = Object.fromEntries(Object.entries(st).filter(([k]) => !STEP_KEYS.includes(k)).map(([k, e]) => [k, evaluate(e, scope)]));
                // `now`: the records as the steps before it leave them (id → row), so a step that writes one plans
                // on what it will be by then, and leaves it there for the steps after it (§30.11).
                const rows = {
                    get: (id) => now.get(id),
                    set: (id, row, was) => { if (was && !now.has(id) && !Object.values(picked).some((r) => r?.id === id)) before.set(id, was); now.set(id, row); },
                };
                const info = { user: { id: as.id, name: as.name }, transaction: body.name, outbound: outbound && !self?.dryRun, now: rows };
                let planned;
                try {
                    planned = spec.plan ? await spec.plan(settings, info) : settings;
                } catch (error) {
                    if (!error?.expose && !(error instanceof ServiceError)) throw error;
                    throw new ServiceError(`${spec.label ?? st.step}: ${error.message}`, { status: error.status ?? 422, code: error.code ?? "transaction.refused", ...(error.fields ? { fields: error.fields } : {}) });
                }
                plans.push({ op: "suite", step: i, kind: st.step, label: st.label ?? spec.label ?? st.step, planned: planned ?? settings });
                continue;
            }
            if (st.create !== undefined) {
                const def = await x.definitionOf(st.create);
                const rows = st.forEach !== undefined ? (Array.isArray(values[st.forEach]) ? values[st.forEach] : []) : [null];
                for (const [j, item] of rows.entries()) {
                    const data = {};
                    for (const [f, e] of Object.entries(st.set ?? {})) {
                        const v = evaluate(e, item ? { ...scope, row: item } : scope);
                        if (v !== undefined && v !== null) data[f] = v;
                    }
                    try {
                        plans.push({ ...(await x.planCreate(self, as, def, data)), step: i });
                    } catch (error) {
                        if (!error?.expose && !(error instanceof ServiceError)) throw error;
                        const where = `${def.body.label}${st.forEach !== undefined ? `, row ${j + 1}` : ""}`;
                        throw new ServiceError(`${where}: ${error.message}`, { status: error.status ?? 422, code: error.code ?? "transaction.refused", fields: { [st.forEach ?? Object.keys(body.inputs)[0]]: `${where}: ${Object.values(error.fields ?? {})[0] ?? error.message}` } });
                    }
                }
                continue;
            }
            const id = values[st.on];
            const spec = body.inputs[st.on];
            const def = await x.definitionOf(spec.to);
            let row = now.get(id) ?? picked[st.on];
            if (!row) throw refused(`Step ${i + 1}: nothing to ${st.action ?? "change"}: "${st.on}" is empty.`);
            // Which input a field's value came from, so a refusal lands on what the person typed.
            const fromInput = Object.fromEntries(Object.entries(st.set ?? {}).filter(([, e]) => isPlain(e) && typeof e.input === "string").map(([f, e]) => [f, e.input]));
            try {
                if (st.set) {
                    const data = {};
                    for (const [f, e] of Object.entries(st.set)) {
                        const v = evaluate(e, scope);
                        if (v !== undefined) data[f] = v;
                    }
                    const p = await x.planUpdate(self, as, def, row, data);
                    if (p) { plans.push({ ...p, step: i }); row = p.after; }
                }
                if (st.action) {
                    const p = await x.planAction(self, as, def, row, st.action);
                    plans.push({ ...p, step: i });
                    row = p.after;
                }
            } catch (error) {
                if (!error?.expose && !(error instanceof ServiceError)) throw error;
                // "Lot 4713: …", on the input the value came from, or the input naming the record.
                const fields = Object.fromEntries(Object.entries(error.fields ?? {}).map(([f, m]) => [fromInput[f] ?? st.on, `${x.nounOf(def, row)}: ${m}`]));
                throw new ServiceError(`${x.nounOf(def, row)}: ${error.message}`, { status: error.status ?? 422, code: error.code ?? "transaction.refused", fields: Object.keys(fields).length ? fields : { [st.on]: `${x.nounOf(def, row)}: ${error.message}` } });
            }
            now.set(id, row);
        }
        now.before = before;
        return { plans, now, found };
    }

    // The records a find step finds: its object's in use whose fields equal its `where` worked out on `scope`,
    // those `as` may read, the oldest first, at most its limit (20; up to 100). A value that comes out unknown (a
    // lookup of an empty reference) finds nothing: never every record with that field empty, which a null said
    // in the design does mean.
    async function findRows(q, as, def, spec, scope) {
        const where = {};
        for (const [k, e] of Object.entries(isPlain(spec.where) ? spec.where : {})) {
            const v = evaluate(e, scope);
            if (v === undefined || (v === null && e !== null)) return [];
            where[k] = v;
        }
        const w = recordWhere(def.body.object, where);
        if (!w) return [];
        const rows = await q.query(`SELECT * FROM mes.records WHERE ${w.sql} ORDER BY created_at, id LIMIT 500`, w.params);
        const actor = await x.actorFor(as, def.body.object);
        return rows.filter((r) => mask(def.body, actor, x.rowOut(r))).slice(0, Math.max(1, Math.min(100, Number.isInteger(spec.limit) ? spec.limit : 20)));
    }

    // What the run changes, record by record, for the person to confirm and for the audit; the records
    // it creates last (`created`: their ids once written).
    async function changesOf(user, body, picked, now, plans = [], created = []) {
        const out = [];
        // A sensitive field (§6.10): that it changed, never its value (this goes to the page and the audit).
        const shown = (def, f, v) => (isSensitive(def.body, f) && v !== null && v !== undefined && v !== "" ? hiddenValue() : v);
        // A reference is shown by its record's title ("M-101"), not its id: on a record made as on one changed.
        const titleOf = async (def, field, id) => {
            if (def.body.fields[field]?.type !== "ref" || typeof id !== "string") return undefined;
            const target = await store.definition(def.body.fields[field].to);
            const row = target ? await x.loadRow(db, target.body.object, id) : null;
            return row ? row.data[target.body.titleField] ?? null : null;
        };
        for (const [k, plan] of plans.filter((q) => q.op === "create").entries()) {
            const def = plan.def;
            const fields = Object.keys(plan.final).filter((f) => def.body.fields[f] && plan.final[f] !== null && plan.final[f] !== undefined && plan.final[f] !== "");
            const titles = {};
            for (const f of fields) titles[f] = await titleOf(def, f, plan.final[f]);
            out.push({
                object: def.body.object, label: def.body.label, id: created[k] ?? null, created: true,
                title: plan.final[def.body.titleField] ?? `new ${def.body.label.toLowerCase()}`,
                state: { from: null, to: def.body.states.initial, tones: def.body.states.tones ?? {} },
                fields: Object.fromEntries(fields.map((f) => [f, { label: def.body.fields[f].label ?? f, type: def.body.fields[f].type, from: null, to: shown(def, f, titles[f] ?? plan.final[f]) }])),
            });
        }
        for (const [id, after] of now) {
            const before = Object.values(picked).find((r) => r?.id === id) ?? now.before?.get(id);
            if (!before) continue;
            const def = await store.definition(before.object);
            const fields = Object.keys(def.body.fields).filter((f) => !same(before.data[f], after.data[f]));
            const titles = {};
            for (const f of fields) titles[f] = { from: await titleOf(def, f, before.data[f]), to: await titleOf(def, f, after.data[f]) };
            out.push({
                object: before.object, label: def.body.label, id, title: before.data[def.body.titleField] ?? id.slice(0, 8),
                state: before.state === after.state ? null : { from: before.state, to: after.state, tones: def.body.states.tones ?? {} },
                fields: Object.fromEntries(fields.map((f) => [f, { label: def.body.fields[f].label ?? f, type: def.body.fields[f].type, from: shown(def, f, titles[f].from ?? before.data[f] ?? null), to: shown(def, f, titles[f].to ?? after.data[f] ?? null) }])),
            });
        }
        return out;
    }

    async function prepare(self, name, input) {
        const { user, t } = await callable(self, name);
        return prepareWith(self, user, t, input);
    }
    async function prepareWith(self, user, t, input) {
        const name = t.body.name;
        const body = t.body;
        const given = await inputsOf(user, body, input);
        // A traveler on a route: offered here only where its node offers it, on a resource of that node;
        // its node's settings read as { node: "…" }.
        if (flows) {
            const gate = await flows.gate({ name, picked: given.picked });
            if (gate.problem) fail(gate.problem.message, { fields: { [gate.problem.field]: gate.problem.message }, code: "transaction.flow" });
            given.scope.node = gate.node ?? {};
            given.flowAt = gate.at ?? {};
        }
        await choicesHold(user, body, given);
        const scope = await withCounts(db, conditions(body), given.scope);
        check(body, scope);
        const as = { ...user, via: name };
        const { plans, now, found } = await planSteps(self, as, body, t, { ...given, scope });
        return { user, t, body, given, scope, as, plans, now, found };
    }

    // The inputs as a run's audit entry keeps them: a sensitive one (§6.10) as the marker.
    const auditInput = (body, input) => (isPlain(input) ? Object.fromEntries(Object.entries(input).map(([k, v]) => [k, body.inputs?.[k]?.sensitive === true && v !== null && v !== undefined && v !== "" ? hiddenValue() : v])) : input);
    // A refusal of the run itself (a check, a step), audited like any refused write (§12.5).
    // How a run came, when over the web (§25.7): the token's name, for the change that would break its callers.
    const viaOf = (self) => (self?.origin?.http ? { via: { http: String(self.origin.http) } } : {});
    async function auditRefusal(user, t, input, error, self = null) {
        await db.transaction((tx) => appendAudit(tx, { actor: user.id, object: "$transaction", action: `rejected:${t.body.name}`, after: { transaction: t.body.name, version: t.version, input: auditInput(t.body, input), ...viaOf(self), refusal: { message: error.message, ...(error.fields ? { fields: error.fields } : {}) } } })).catch((e) => log.error("transaction refusal not audited", e));
    }

    const services = {
        // The transactions this person may run, for the navigator and the records they appear on.
        async "transactions.list"({ as } = {}) {
            const user = await x.requireViewer(this, as);
            const out = [];
            for (const t of (await store.transactions()).values()) {
                if (await mayCall(t, user)) out.push({ name: t.body.name, label: t.body.label, description: t.body.description ?? "", appearsOn: t.body.appearsOn ?? null });
            }
            return out.sort((a, b) => a.label.localeCompare(b.label));
        },
        // The screen's definition; null for one that does not exist or that this person may not run
        // (the page says so; running it is refused all the same).
        async "transactions.get"({ name, as } = {}) {
            const user = await x.requireViewer(this, as);
            const t = typeof name === "string" ? (await store.transactions()).get(name) : null;
            return t && (await mayCall(t, user)) ? { ...publicOf(t), ...(await inputFlowOf(store, t.body.inputFlow)) } : null;
        },
        // What running it would change, with nothing written.
        async "transactions.preview"({ name, input } = {}) {
            const p = await prepare(this, name, input);
            return { name, label: p.body.label, changes: await changesOf(p.user, p.body, p.given.picked, p.now, p.plans), skipped: p.plans.filter((q) => q.skipped).map((q) => q.step), also: p.plans.filter((q) => q.op === "suite").map((q) => ({ step: q.step, kind: q.kind, label: q.label })) };
        },
        async "transactions.run"({ name, input, key, signature } = {}) {
            // From a service's script (§15.2): never one a person signs, whoever the service acts as (said
            // before who may run it: no change to its callers would let a service run it).
            if (fromService(this)) signedForService(await load(name));
            // Over the web (§25.7): never one a person signs, whatever its design said when it was published.
            if (this?.origin?.http && (await load(name)).body.signature) fail("It is signed by the person running it: an outside system does not run it.", { status: 403, code: "transaction.signed" });
            const { user, t } = await callable(this, name);
            const done = await x.remembered(key, user);
            if (done !== undefined) return done;
            const body = t.body;
            // A route runs one on its traveler as itself (§32.15): never one a person signs.
            if (String(user.id).startsWith("flow:") && body.signature) fail(`${body.label} is signed by the person running it: a route does not run it.`, { status: 403, code: "transaction.signed" });
            // An electronic signature, where the design asks for one (§7.4): its meaning, stated.
            if (body.signature && !(isPlain(signature) && signature.meaning === body.signature.meaning && signature.agree === true)) {
                fail(`${body.label} is signed: confirm "${body.signature.meaning}".`, { fields: { _signature: "Required." }, code: "transaction.signature" });
            }
            // Verified by a second person (§7.4, Part 11 §11.200): the one signed in beside them may verify
            // it, and both re-enter their passwords; checked before anything is read or written.
            // Signed by one, where the plant asks every signer to prove who they are (§7.4): their password, or a fresh sign-on.
            const signed = body.signature?.verifier ? await (signatures?.signRun ?? (() => fail("Signatures by two people are not set up here.", { status: 501 })))(this, user, body, signature)
                : body.signature && signatures?.asksProof ? await signatures.signOne(this, user, `transaction ${body.label}`, { password: signature?.password, sso: signature?.sso }).then((r) => ({ meaning: body.signature.meaning, by: { id: user.id, name: user.name }, method: r.method }))
                : null;
            let p;
            try {
                p = await prepare(this, name, input);
            } catch (error) {
                if (error?.code !== "transaction.input" && error?.status !== 401 && error?.status !== 404) await auditRefusal(user, t, input, error, this);
                throw error;
            }
            const run = crypto.randomUUID();
            const changes = await changesOf(user, body, p.given.picked, p.now, p.plans);
            try {
                const outcome = await db.transaction(async (tx) => {
                    // Every record the inputs name, locked in one order (two runs never wait on each
                    // other crosswise), and unchanged since it was checked.
                    // …the records its find steps found too.
                    const rows = [...new Map([...Object.values(p.given.picked), ...p.found.flatMap((f) => f.rows)].map((r) => [r.id, r])).values()].sort((a, b) => a.id.localeCompare(b.id));
                    // Locked to be written only where a step writes it (its `on`, a find step's action or set); a record
                    // it only reads (the open shift every move names, a product) is kept from changing until the commit,
                    // which keeps its checks true, without one run waiting on another for it. A step of a suite's kind
                    // may write what it is given: with one, everything is locked to be written.
                    const suiteStep = (body.steps ?? []).some((st) => st?.step !== undefined);
                    const written = new Set((body.steps ?? []).filter((st) => st?.on !== undefined).map((st) => p.given.picked[st.on]?.id).filter(Boolean));
                    for (const f of p.found) { const st = body.steps[f.step]; if (st.action !== undefined || st.set !== undefined) for (const r of f.rows) written.add(r.id); }
                    for (const row of rows) {
                        const locked = await x.loadRow(tx, row.object, row.id, suiteStep || written.has(row.id) ? true : "share");
                        if (!locked || Number(locked.row_version) !== Number(row.row_version)) {
                            const def = await store.definition(row.object);
                            fail(`${x.nounOf(def, row)} changed while this was being entered. Check it and run it again.`, { status: 409, code: "stale" });
                        }
                    }
                    // What each find step finds, found again: one more (or one fewer) matching since is a stale run.
                    for (const f of p.found) {
                        const st = body.steps[f.step];
                        const again = await findRows(tx, p.as, await x.definitionOf(st.find.object), st.find, p.scope);
                        if (again.map((r) => r.id).join() !== f.ids.join()) fail("What this finds changed while it was being entered. Run it again.", { status: 409, code: "stale" });
                    }
                    // The checks and the steps' conditions again, now that nothing they read can move.
                    const scope = { ...(await withCounts(tx, conditions(body), p.given.scope)), ...(p.scope.found ? { found: p.scope.found } : {}) };
                    check(body, scope);
                    for (const [i, st] of (body.steps ?? []).entries()) {
                        if (st.when === undefined) continue;
                        const skipped = p.plans.some((q) => q.step === i && q.skipped);
                        if ((evaluate(st.when, scope) === true) === skipped) fail("Something this depends on changed while it was being entered. Run it again.", { status: 409, code: "stale" });
                    }
                    const as = { ...p.as, onBehalfOf: `transaction:${name}:${run}` };
                    const created = [];
                    const also = []; // what the suites' steps did, for the run's audit entry
                    for (const plan of p.plans) {
                        if (plan.skipped) continue;
                        if (plan.op === "suite") {
                            const spec = stepKinds()[plan.kind];
                            if (!spec) fail(`${plan.label} needs the ${plan.kind.split(".")[0]} suite, which is not installed here.`, { status: 409, code: "suite.missing" });
                            also.push({ step: plan.step, kind: plan.kind, detail: (await spec.apply?.(tx, plan.planned, { user: { id: user.id, name: user.name }, transaction: name, run, outbound })) ?? null });
                        } else if (plan.op === "create") created.push((await x.applyCreate(tx, this, as, plan)).id);
                        else if (plan.op === "update") await x.applyUpdate(tx, this, as, plan);
                        else await x.applyAction(tx, this, as, plan);
                    }
                    // The records it created, with their ids now that they exist.
                    const all = created.length ? await changesOf(user, body, p.given.picked, p.now, p.plans, created) : changes;
                    changes.splice(0, changes.length, ...all);
                    const touched = changes.map((c) => ({ object: c.object, id: c.id }));
                    // …and those its suites' steps wrote through the record services (§30.11: their detail's
                    // `records`), so what lists them is refreshed and a route sees them, as for its own.
                    for (const a of also) for (const r of Array.isArray(a.detail?.records) ? a.detail.records : []) if (typeof r?.object === "string" && typeof r?.id === "string" && !touched.some((t) => t.id === r.id)) touched.push({ object: r.object, id: r.id });
                    await appendAudit(tx, {
                        actor: user.id, object: "$transaction", recordId: run, action: `run:${name}`,
                        after: { transaction: name, version: t.version, input: auditInput(body, p.given.values), records: changes, ...viaOf(this), ...(also.length ? { also } : {}), ...(signed ? { signature: signed } : body.signature ? { signature: { meaning: body.signature.meaning } } : {}) },
                    });
                    const result = { ok: true, run, transaction: name, label: body.label, changes, records: touched, ...(also.length ? { also } : {}) };
                    await x.remember(tx, key, user, result);
                    return result;
                });
                // Committed: the travelers it made start their routes, those it took on move on (§32.5).
                if (flows) await flows.afterRun({ name, run, user, at: p.given.flowAt ?? {}, records: outcome.records, created: outcome.changes.filter((c) => c.created).map((c) => ({ object: c.object, id: c.id })) }).catch((e) => log.error("flows after a run", e));
                return outcome;
            } catch (error) {
                if (error?.code !== "stale" && error?.code !== "db.unavailable" && error?.code !== "db.unknown" && (error?.expose || error instanceof ServiceError)) await auditRefusal(user, t, input, error, this);
                throw error;
            }
        },
    };

    // What a pop-up over this transaction reads (§26.7): the scope its checks read (its inputs, the
    // records they name, the person), from what is filled in so far. Lenient where a run is strict: an
    // input not filled yet, or naming a record the person cannot see, is simply absent; a pop-up only
    // shows, and decides nothing. Null for a transaction that is not published.
    async function scopeFor(user, name, given = {}) {
        const t = (await store.transactions()).get(name);
        if (!t) return null;
        const specs = t.body.inputs ?? {};
        const values = {};
        const picked = {};
        const pick = async (k, spec, id) => {
            if (typeof id !== "string" || !UUID.test(id)) return;
            const def = await store.definition(spec.to);
            const row = def ? await x.loadRow(db, spec.to, id) : null;
            if (!row || row.archived_at || !mask(def.body, await x.actorFor(user, spec.to), x.rowOut(row))) return;
            values[k] = id;
            picked[k] = row;
        };
        for (const [k, spec] of Object.entries(specs)) {
            if (spec.from !== undefined) continue;
            if (spec.type === "ref") await pick(k, spec, given?.[k]);
            else if (given?.[k] !== undefined && given[k] !== null && given[k] !== "") values[k] = given[k];
        }
        for (const k of derivedOrder(specs).order) {
            const [source, field] = specs[k].from.split(".");
            if (specs[k].type !== "ref") { const v = await seenField(user, picked[source], field); if (v !== null) values[k] = v; continue; }
            await pick(k, specs[k], picked[source]?.data?.[field] ?? null);
        }
        return { input: values, lookup: Object.fromEntries(Object.entries(picked).map(([k, row]) => [k, x.recordOf(row)])), user: { id: user.id, name: user.name, certifications: user.certifications ?? await x.certificationsOf(user.id), departments: await store.departmentsOf(user.id) }, person: await personOf(user.id) };
    }

    // A transaction planned for a service's dry run (integration.js), as drafted in a change when it is
    // (`draft`), else as published: its callers, its checks and its steps, nothing written. → { changes }
    async function planFor(self, name, input, draft = null) {
        const user = await x.requireViewer(self);
        const t = draft ? { body: draft, version: "draft" } : await load(name);
        if (fromService(self)) signedForService(t);
        if (!(await mayCall(t, user))) {
            const c = t.body.callers ?? {};
            fail(`The service ${String(user.id).replace(/^service:/, "")} may not run ${t.body.label}: it is for ${[...(c.users ?? []), ...(c.groups ?? []).map((g) => `group ${g}`), ...(c.services ?? []).map((sv) => `the service ${sv}`)].join(", ") || "nobody yet"}. Its stewards (${(t.body.stewards ?? []).join(", ") || "none"}) approve who may.`, { status: 403, code: "transaction.denied" });
        }
        const p = await prepareWith(self, user, t, input);
        return { changes: await changesOf(p.user, p.body, p.given.picked, p.now, p.plans) };
    }

    // Each run and preview counted by the transaction's own name and how it came (call-stats.js, §38.1): its
    // screen, the web, a service's script, a route; its statements put down to it.
    let calls = null;
    for (const [svc, kind] of [["transactions.run", "transaction"], ["transactions.preview", "preview"]]) {
        const fn = services[svc];
        services[svc] = function (args = {}) {
            // Over the web the request is counted where it arrives (integration.js), once.
            return calls && !this?.origin?.http && /^[a-z][a-z0-9_]{0,62}$/.test(String(args?.name ?? "")) ? calls.measure({ kind, name: args.name, channel: channelOf(this) }, () => fn.call(this, args)) : fn.call(this, args);
        };
    }

    // A run changes the records it wrote: every page showing them follows.
    const touches = {
        "transactions.list": [],
        "transactions.get": [],
        "transactions.preview": [],
        "transactions.run": (args, result) => [...(result?.records ?? []).flatMap(({ object, id }) => [{ name: "records.list", where: { object } }, { name: "records.get", where: { object, id } }]), ...(result?.records?.length ? [{ name: "screens.data" }, { name: "popups.for" }, { name: "flows.runOf" }, { name: "flows.plansOf" }, { name: "flows.task" }, { name: "inbox.mine" }] : [])],
    };
    // `counted`: the counts an expression needs, for a pop-up's condition (screens.js); `mayRun`: whether the person is
    // among a transaction's callers (a screen leaves out a form they could not send).
    return { services, touches, queries: ["transactions.list", "transactions.get"], scopeFor, planFor, counted: (exprs, scope) => withCounts(db, exprs, scope),
        mayRun: async (name, user) => { const t = (await store.transactions()).get(name); return Boolean(t && (await mayCall(t, user))); }, useFlows(f) { flows = f; }, useQuery(q) { query = q; }, useSuiteSteps(fn) { stepKinds = fn; }, useCallStats(c) { calls = c; } };
}
