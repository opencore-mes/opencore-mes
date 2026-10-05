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
// sample's readings, a lot's wafers. A created record goes through its object's policies, rule pipe and
// validation like any other (records.internals planCreate), as the person, in the same run.
import { ServiceError, fail } from "../../../src/errors.js";
import { evaluate, countsOf } from "../client/expr.js";
import { validate } from "./services.js";
import { appendAudit } from "./audit.js";
import { mask } from "./policy.js";
import { recordWhere } from "./record-where.js";
import { derivedOrder } from "../client/definition.js";

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

    async function mayCall(t, user) {
        const callers = t.body.callers ?? {};
        // A service acting as its own role (§15.2, `service:<name>`): only if the callers name it.
        if (String(user.id).startsWith("service:")) return (callers.services ?? []).includes(String(user.id).slice(8));
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
        for (const [k, spec] of Object.entries(specs)) if (spec.from === undefined && input?.[k] !== undefined && input[k] !== "") values[k] = input[k];
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
            user: { id: user.id, name: user.name },
            // Who runs it, as the built-in Person has them: read for the decision, whatever their roles on Person.
            person: await personOf(user.id),
        };
        return { values, picked, scope };
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
        for (const [i, st] of (body.steps ?? []).entries()) {
            if (st.when !== undefined && evaluate(st.when, scope) !== true) { plans.push({ step: i, skipped: true }); continue; }
            if (st.step !== undefined) {
                const spec = stepKinds()[st.step];
                // Its suite is gone: this transaction says so and does nothing; every other one runs.
                if (!spec) throw refused(`Step ${i + 1} of ${body.label} needs the ${String(st.step).split(".")[0]} suite, which is not installed here: it cannot run until the suite is back. Ask IT.`, { code: "suite.missing" });
                const settings = Object.fromEntries(Object.entries(st).filter(([k]) => !STEP_KEYS.includes(k)).map(([k, e]) => [k, evaluate(e, scope)]));
                const info = { user: { id: as.id, name: as.name }, transaction: body.name, outbound: outbound && !self?.dryRun };
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
        return { plans, now };
    }

    // What the run changes, record by record, for the person to confirm and for the audit; the records
    // it creates last (`created`: their ids once written).
    async function changesOf(user, body, picked, now, plans = [], created = []) {
        const out = [];
        for (const [k, plan] of plans.filter((q) => q.op === "create").entries()) {
            const def = plan.def;
            const fields = Object.keys(plan.final).filter((f) => def.body.fields[f] && plan.final[f] !== null && plan.final[f] !== undefined && plan.final[f] !== "");
            out.push({
                object: def.body.object, label: def.body.label, id: created[k] ?? null, created: true,
                title: plan.final[def.body.titleField] ?? `new ${def.body.label.toLowerCase()}`,
                state: { from: null, to: def.body.states.initial, tones: def.body.states.tones ?? {} },
                fields: Object.fromEntries(fields.map((f) => [f, { label: def.body.fields[f].label ?? f, type: def.body.fields[f].type, from: null, to: plan.final[f] }])),
            });
        }
        for (const [id, after] of now) {
            const before = Object.values(picked).find((r) => r.id === id);
            const def = await store.definition(before.object);
            const fields = Object.keys(def.body.fields).filter((f) => !same(before.data[f], after.data[f]));
            // A reference is shown by its record's title ("M-101"), not its id.
            const titleOf = async (field, id) => {
                if (def.body.fields[field].type !== "ref" || typeof id !== "string") return undefined;
                const target = await store.definition(def.body.fields[field].to);
                const row = target ? await x.loadRow(db, target.body.object, id) : null;
                return row ? row.data[target.body.titleField] ?? null : null;
            };
            const titles = {};
            for (const f of fields) titles[f] = { from: await titleOf(f, before.data[f]), to: await titleOf(f, after.data[f]) };
            out.push({
                object: before.object, label: def.body.label, id, title: before.data[def.body.titleField] ?? id.slice(0, 8),
                state: before.state === after.state ? null : { from: before.state, to: after.state, tones: def.body.states.tones ?? {} },
                fields: Object.fromEntries(fields.map((f) => [f, { label: def.body.fields[f].label ?? f, type: def.body.fields[f].type, from: titles[f].from ?? before.data[f] ?? null, to: titles[f].to ?? after.data[f] ?? null }])),
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
        const scope = await withCounts(db, conditions(body), given.scope);
        check(body, scope);
        const as = { ...user, via: name };
        const { plans, now } = await planSteps(self, as, body, t, { ...given, scope });
        return { user, t, body, given, scope, as, plans, now };
    }

    // A refusal of the run itself (a check, a step), audited like any refused write (§12.5).
    async function auditRefusal(user, t, input, error) {
        await db.transaction((tx) => appendAudit(tx, { actor: user.id, object: "$transaction", action: `rejected:${t.body.name}`, after: { transaction: t.body.name, version: t.version, input, refusal: { message: error.message, ...(error.fields ? { fields: error.fields } : {}) } } })).catch((e) => log.error("transaction refusal not audited", e));
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
            const { user, t } = await callable(this, name);
            const done = await x.remembered(key, user);
            if (done !== undefined) return done;
            const body = t.body;
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
                if (error?.code !== "transaction.input" && error?.status !== 401 && error?.status !== 404) await auditRefusal(user, t, input, error);
                throw error;
            }
            const run = crypto.randomUUID();
            const changes = await changesOf(user, body, p.given.picked, p.now, p.plans);
            try {
                const outcome = await db.transaction(async (tx) => {
                    // Every record the inputs name, locked in one order (two runs never wait on each
                    // other crosswise), and unchanged since it was checked.
                    const rows = [...new Map(Object.values(p.given.picked).map((r) => [r.id, r])).values()].sort((a, b) => a.id.localeCompare(b.id));
                    for (const row of rows) {
                        const locked = await x.loadRow(tx, row.object, row.id, true);
                        if (!locked || Number(locked.row_version) !== Number(row.row_version)) {
                            const def = await store.definition(row.object);
                            fail(`${x.nounOf(def, row)} changed while this was being entered. Check it and run it again.`, { status: 409, code: "stale" });
                        }
                    }
                    // The checks and the steps' conditions again, now that nothing they read can move.
                    const scope = await withCounts(tx, conditions(body), p.given.scope);
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
                    await appendAudit(tx, {
                        actor: user.id, object: "$transaction", recordId: run, action: `run:${name}`,
                        after: { transaction: name, version: t.version, input: p.given.values, records: changes, ...(also.length ? { also } : {}), ...(signed ? { signature: signed } : body.signature ? { signature: { meaning: body.signature.meaning } } : {}) },
                    });
                    const result = { ok: true, run, transaction: name, label: body.label, changes, records: touched, ...(also.length ? { also } : {}) };
                    await x.remember(tx, key, user, result);
                    return result;
                });
                // Committed: the travelers it made start their routes, those it took on move on (§32.5).
                if (flows) await flows.afterRun({ name, run, user, at: p.given.flowAt ?? {}, records: outcome.records, created: outcome.changes.filter((c) => c.created).map((c) => ({ object: c.object, id: c.id })) }).catch((e) => log.error("flows after a run", e));
                return outcome;
            } catch (error) {
                if (error?.code !== "stale" && error?.code !== "db.unavailable" && error?.code !== "db.unknown" && (error?.expose || error instanceof ServiceError)) await auditRefusal(user, t, input, error);
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
        return { input: values, lookup: Object.fromEntries(Object.entries(picked).map(([k, row]) => [k, x.recordOf(row)])), user: { id: user.id, name: user.name }, person: await personOf(user.id) };
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

    // A run changes the records it wrote: every page showing them follows.
    const touches = {
        "transactions.list": [],
        "transactions.get": [],
        "transactions.preview": [],
        "transactions.run": (args, result) => [...(result?.records ?? []).flatMap(({ object, id }) => [{ name: "records.list", where: { object } }, { name: "records.get", where: { object, id } }]), ...(result?.records?.length ? [{ name: "screens.data" }, { name: "popups.for" }, { name: "flows.runOf" }, { name: "flows.plansOf" }, { name: "flows.task" }, { name: "inbox.mine" }] : [])],
    };
    // `counted`: the counts an expression needs, for a pop-up's condition (screens.js).
    return { services, touches, queries: ["transactions.list", "transactions.get"], scopeFor, planFor, counted: (exprs, scope) => withCounts(db, exprs, scope), useFlows(f) { flows = f; }, useSuiteSteps(fn) { stepKinds = fn; } };
}
