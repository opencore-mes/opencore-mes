// Flow templates at run time (DESIGN.md §32.5): a route's runs. A run is one traveler's way through one
// version of a route template, with its context (the template's initial values, and what its scripts
// put there); its position is here (mes.flow_runs, mes.flow_steps). The traveler's step field shows the
// sequence it is at: the route marks it on entering one, and a write that moves it moves the route.
//
//   start      a traveler made (by its form, a transaction, an import, a pack's samples) where a route's
//              start holds: its run begins at the sequence its step field already names (a lot made
//              part-way, a split's child), else at the start
//   gate       before a transaction is checked: on a traveler under way, one the route offers anywhere
//              runs only where the traveler's sequence offers it, on a resource that sequence allows; and
//              its expressions read that sequence's settings as { node: "…" }
//   afterRun   once a transaction has committed (never inside it: what a route then does cannot undo the
//   afterWrite operator's work), and after any other write to a traveler (a form, an import): the
//              travelers it made start; a run whose `ends` holds ends; one whose step field was moved
//              follows it there, off its wires if need be, audited so; one left on a sequence's `leaves`
//              goes on by its wire, through auto decisions, to the next sequence or an end
// A route's `everySequence` (§32.15) runs a designed transaction on its traveler, as the route, each time the
// traveler enters any of its steps (onEnter, once the step field names it) or leaves one (onExit, the step field
// still naming the one it leaves): what to do at every step, said once on the route, never in each transaction
// that ends a step. The transaction's callers name the route; it appears on the traveler's object.
// Each node's onEnter and onExit scripts run as it is entered and left: rule scripts, the context in and
// out, their writes made after, as the template's own identity, through the record services, so the
// objects' own lifecycles (transitions, policies, rule pipes) decide. Something that goes wrong on the
// way (a write refused, no wire that holds, a suite's node with the suite gone) stops the run there,
// saying why; the traveler's own record is untouched by it, and moving its step sets it going again.
//
// Plans (an OCAP, §32.5): a run of a plan starts when a record of its subject is made or written where
// its start's condition holds, or when a date of the subject its start names (`due`) arrives, checked by
// the scheduler (a plan whose start has neither runs only as a sub flow); once per template and record,
// or again once the last run has ended when its start says `again`. One runs at a time per template and
// record (a unique index): two instances setting the same one off start it once. Its context also holds the route the subject's records are on (`route`: the template and
// the step, where it was set off). It waits at a wait (its time: on by itself when `auto`, else for
// someone to acknowledge or retry), a manual decision (someone picks a wire) and an input screen
// (someone fills it in: its values into the context, its files and images kept with the run), each
// in the inbox of the people it is for, and at a sub flow, whose own run (a child) hands its values
// back when it ends.
import { CALL_KIND } from "@opencore-mes/juris-kit/live-protocol.js";
import { fail, ServiceError } from "@opencore-mes/juris-kit/errors.js";
import { evaluate } from "../client/expr.js";
import { fileTypeOf } from "../client/input-flow.js";
import { flowKindOf, flowStartOf, flowMapOf, derivedOrder } from "../client/definition.js";
import { optionsOf } from "../client/query-def.js";
import { appendAudit } from "./audit.js";
import { mask } from "./policy.js";
import { runServiceScript, RULES_UNAVAILABLE } from "./rules.js";
import { createHash } from "node:crypto";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const travelerOf = (body) => Object.entries(body?.participants ?? {}).find(([, p]) => p?.as === "traveler") ?? null;
const resourceOf = (body) => Object.entries(body?.participants ?? {}).find(([, p]) => p?.as === "resource") ?? null;
const subjectOf = (body) => Object.entries(body?.participants ?? {}).find(([, p]) => p?.as === "subject") ?? null;
// The record a run is about: a route's traveler, a plan's subject.
const headOf = (body) => (body?.kind === "plan" ? subjectOf(body) : travelerOf(body));
const WAITS = ["wait", "manual_decision", "input_screen", "sub_flow"];
const FILE_LIMIT = 5 * 1024 * 1024;
const holds = (expr, scope) => { try { return evaluate(expr, scope) === true; } catch { return false; } };
// A participant's "from" read as an input's (derivedOrder): the order they can be filled in.
const fromOrder = (participants) => derivedOrder(Object.fromEntries(Object.entries(participants ?? {}).map(([k, p]) => [k, p?.from ? { from: p.from } : {}]))).order;
const initialOf = (body) => (isPlain(body?.context) ? { ...body.context } : {});
const plain = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);
// Where a traveler waits: a sequence (a suite's kind extending one too).
const waitsAt = (n, flowNodes) => flowKindOf(n, flowNodes) === "sequence";
// How deep sub flows may run inside one another (a plan, its sub flow, theirs, …).
const MAX_NESTED = 5;
const startNode = (body) => flowStartOf(body);

// Runs taken up where travelers already are (a database seeded with lots part-way, a sandbox's copies,
// a route published over lots already on the line): each traveler with no route under way, whose step
// field names a sequence of the route and for which its start holds, starts there, no node entered
// again. → how many.
export async function adoptRuns(db, { flows, definitions, only = null }) {
    let n = 0;
    for (const [name, f] of flows) {
        if (f.body?.kind !== "route" || f.body.asSub === true || (only && !only.includes(name))) continue;
        const traveler = travelerOf(f.body);
        const field = traveler ? definitions[traveler[1].object]?.flow?.step : null;
        const sequences = Object.entries(f.body.nodes ?? {}).filter(([, x]) => x?.kind === "sequence" || String(x?.kind).includes(".")).map(([id]) => id);
        if (!field || !sequences.length) continue;
        const when = f.body.nodes?.[startNode(f.body)]?.when;
        const rows = await db.query(
            `SELECT r.id, r.state, r.data FROM mes.records r WHERE r.object = $1 AND r.archived_at IS NULL AND r.data->>$2 = ANY($3::text[])
               AND NOT EXISTS (SELECT 1 FROM mes.flow_runs fr WHERE fr.subject_id = r.id AND fr.kind = 'route' AND fr.state <> 'ended')`,
            [traveler[1].object, field, sequences]);
        for (const r of rows) {
            // Its context as the route's conditions read it: the traveler, those filled in from it, its values.
            const context = { ...initialOf(f.body), [traveler[0]]: { ...r.data, id: r.id, state: r.state } };
            for (const key of fromOrder(f.body.participants)) {
                const [source, ref] = f.body.participants[key].from.split(".");
                const id = context[source]?.[ref];
                const [row] = typeof id === "string" && UUID.test(id) ? await db.query("SELECT id, state, data FROM mes.records WHERE id = $1 AND object = $2", [id, f.body.participants[key].object]) : [];
                if (row) context[key] = { ...row.data, id: row.id, state: row.state };
            }
            // Only one this route would have started (another route's lot is left to it); one that has
            // ended its way already (shipped, merged) is left out.
            if (when !== undefined && !holds(when, { context })) continue;
            if (f.body.ends?.when !== undefined && holds(f.body.ends.when, { context })) continue;
            const [run] = await db.query("INSERT INTO mes.flow_runs (flow, version, kind, subject_object, subject_id, participants, context, node, state) VALUES ($1, $2, 'route', $3, $4, $5, $6, $7, 'running') RETURNING id",
                [name, f.version, traveler[1].object, r.id, JSON.stringify({ [traveler[0]]: r.id }), JSON.stringify(initialOf(f.body)), r.data[field]]);
            await db.query("INSERT INTO mes.flow_steps (run_id, seq, node, by, via) VALUES ($1, 1, $2, 'platform', 'taken up where it was')", [run.id, r.data[field]]);
            n++;
        }
    }
    return n;
}

// Today in the plant (YYYY-MM-DD): what a due date is compared with.
const todayIn = (tz) => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); } catch { return new Date().toISOString().slice(0, 10); } };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createFlows({ store, records, design, query = null, sandbox = false, plantTz = "UTC", log = console }) {
    let invalidate = async () => {};
    const { db } = store;
    const x = records.internals;
    const versions = new Map(); // `${name}@${version}` -> body (a version never changes)
    async function flowAt(name, version) {
        const k = `${name}@${version}`;
        if (!versions.has(k)) {
            const [row] = await db.query("SELECT version, body FROM mes.flows WHERE name = $1 AND version = $2", [name, version]);
            if (!row) return null;
            versions.set(k, { version: row.version, body: row.body });
        }
        return versions.get(k);
    }
    // Its own identity: `flow:<name>`, holding the roles its design grants, acting for its run.
    // A plan acts on its participants whatever their access requires (§9.9): it is the plant's own
    // automation, and shows nothing to anyone (what it asks a person, it asks through their own access).
    const identity = (f, run) => ({ id: `flow:${f.body.name}`, name: `${f.body.label} (flow)`, serviceRoles: isPlain(f.body.roles) ? f.body.roles : {}, unrestricted: true, onBehalfOf: `flow:${f.body.name}:${run.id}` });
    const as = (actor) => ({ [CALL_KIND]: "internal", reason: `flow ${actor.id}`, user: actor });
    // The route run a traveler is in now: the innermost. A route whose sub flow runs another route waits
    // there while that one's run (its child) is under way; the traveler is at a step of the child (§32.14).
    const activeRun = async (id) => {
        const rows = await db.query("SELECT * FROM mes.flow_runs WHERE subject_id = $1 AND kind = 'route' AND state <> 'ended'", [id]);
        return rows.find((r) => !rows.some((c) => c.parent_id === r.id)) ?? null;
    };
    // That run and the routes it runs inside, innermost first: [{ run, f }].
    async function chainOf(run) {
        const chain = [];
        for (let r = run; r && chain.length <= MAX_NESTED + 1; r = r.parent_id ? (await db.query("SELECT * FROM mes.flow_runs WHERE id = $1 AND kind = 'route' AND state <> 'ended'", [r.parent_id]))[0] : null) {
            const f = await flowAt(r.flow, r.version);
            if (!f) break;
            chain.push({ run: r, f });
        }
        return chain;
    }
    // Whether a transaction is offered anywhere in a traveler's whole way: the routes of its chain as their
    // runs' versions have them, and the sub routes they run (as published), however deep, each read once.
    async function offeredIn(chain, name) {
        const published = await store.flows();
        const seen = new Set();
        const queue = chain.map((l) => l.f.body);
        while (queue.length && seen.size <= 200) {
            const body = queue.shift();
            if (!body || seen.has(body.name)) continue;
            seen.add(body.name);
            const nodes = Object.values(body.nodes ?? {});
            if (nodes.some((m) => (m?.offers ?? []).includes(name))) return true;
            for (const m of nodes) if (m?.kind === "sub_flow" && typeof m.flow === "string" && !seen.has(m.flow)) queue.push(published.get(m.flow)?.body);
        }
        return false;
    }
    const stepFieldOf = async (object) => (await store.definition(object))?.body.flow?.step ?? null;
    // A traveler's whole way through its route, for its page (§32.14): the run at the top and every sub
    // route's run under it, ended or not, each with its own way and map, its parent, and the parent's sub
    // flow node that ran it (`at`: the last time that node was entered before the run began, so a node
    // entered twice names the run of each time); and, for a sub flow it has not reached, the sub route as
    // it is published now (`subMaps`, by name), so the page opens that one too, nothing walked on it.
    async function routeTreeOf(run) {
        const [top] = await db.query(
            `WITH RECURSIVE up(id, parent_id, depth) AS (SELECT id, parent_id, 0 FROM mes.flow_runs WHERE id = $1
               UNION ALL SELECT r.id, r.parent_id, up.depth + 1 FROM mes.flow_runs r JOIN up ON r.id = up.parent_id WHERE up.depth < $2)
             SELECT id FROM up WHERE parent_id IS NULL`, [run.id, MAX_NESTED + 1]);
        if (!top) return { routes: [], subMaps: {} };
        const rows = await db.query(
            `WITH RECURSIVE down(id, depth) AS (SELECT id, 0 FROM mes.flow_runs WHERE id = $1
               UNION ALL SELECT r.id, down.depth + 1 FROM mes.flow_runs r JOIN down ON r.parent_id = down.id WHERE r.kind = 'route' AND down.depth < $2)
             SELECT r.* FROM mes.flow_runs r JOIN down USING (id) ORDER BY r.started_at, r.id`, [top.id, MAX_NESTED + 1]);
        const allSteps = await db.query("SELECT run_id, seq, node, at, by, via FROM mes.flow_steps WHERE run_id = ANY($1) ORDER BY run_id, seq", [rows.map((r) => r.id)]);
        const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);
        const flowNodes = design.flowNodes();
        const routes = [];
        for (const r of rows) {
            const rf = await flowAt(r.flow, r.version);
            const steps = allSteps.filter((s) => s.run_id === r.id).map(({ run_id, ...s }) => ({ ...s, label: rf?.body.nodes?.[s.node]?.label ?? s.node, offRoute: String(s.via ?? "").startsWith("off route"), at: iso(s.at) }));
            routes.push({ id: r.id, parent: r.parent_id, flow: r.flow, label: rf?.body.label ?? r.flow, version: r.version, state: r.state, outcome: r.outcome, reason: r.reason,
                node: r.node, nodeLabel: rf?.body.nodes?.[r.node]?.label ?? r.node, startedAt: iso(r.started_at), steps, body: rf?.body ?? null, map: rf ? flowMapOf(rf.body, flowNodes) : null });
        }
        for (const r of routes) {
            const p = routes.find((q) => q.id === r.parent);
            const ran = (p?.steps ?? []).filter((s) => s.at <= r.startedAt && p.body?.nodes?.[s.node]?.flow === r.flow && flowKindOf(p.body.nodes[s.node], flowNodes) === "sub_flow");
            r.at = ran.at(-1)?.node ?? null;
        }
        // The sub routes not reached yet, as published now, and theirs in turn (never in a circle: the
        // designer refuses one, and a name is read once).
        const subMaps = {};
        const published = await store.flows();
        const pending = routes.flatMap((r) => Object.values(r.body?.nodes ?? {}));
        while (pending.length) {
            const n = pending.pop();
            if (flowKindOf(n, flowNodes) !== "sub_flow" || typeof n.flow !== "string" || n.flow in subMaps) continue;
            const sf = published.get(n.flow);
            subMaps[n.flow] = sf?.body.kind === "route" ? flowMapOf(sf.body, flowNodes) : null;
            if (sf) pending.push(...Object.values(sf.body.nodes ?? {}));
        }
        return { routes: routes.map(({ body, ...r }) => r), subMaps };
    }

    // The run's records by name: the traveler (a plan's subject), then those filled in from it.
    async function idsOf(f, travelerId) {
        const traveler = headOf(f.body);
        const ids = { [traveler[0]]: travelerId };
        for (const key of fromOrder(f.body.participants)) {
            const [source, field] = f.body.participants[key].from.split(".");
            const src = f.body.participants[source];
            const row = ids[source] ? await x.loadRow(db, src.object, ids[source]) : null;
            const value = row?.data?.[field];
            if (typeof value === "string" && UUID.test(value)) ids[key] = value;
        }
        return ids;
    }
    // Its context as its conditions and scripts read it: its values, and its records as they are now.
    async function contextOf(f, run, travelerId = run?.subject_id) {
        const context = { ...initialOf(f.body), ...(isPlain(run?.context) ? run.context : {}) };
        const ids = await idsOf(f, travelerId);
        for (const [key, id] of Object.entries(ids)) {
            const row = await x.loadRow(db, f.body.participants[key].object, id);
            if (row) context[key] = x.recordOf(row);
        }
        // A plan: the route its records are on, where it was set off (the first of them on one).
        if (f.body.kind === "plan" && context.route === undefined) {
            for (const id of Object.values(ids)) {
                const r = await activeRun(id);
                const fr = r && (await flowAt(r.flow, r.version));
                if (fr) { context.route = { flow: r.flow, label: fr.body.label, step: r.node, step_label: fr.body.nodes?.[r.node]?.label ?? r.node }; break; }
            }
        }
        return context;
    }
    const nounOf = async (object, id) => {
        const def = await store.definition(object);
        const row = def ? await x.loadRow(db, object, id) : null;
        return row ? x.nounOf(def, row) : object;
    };

    // Its way: a node entered, audited under the template's version.
    async function note(run, f, node, by, via) {
        await db.transaction(async (tx) => {
            const [{ seq }] = await tx.query("SELECT coalesce(max(seq), 0) + 1 AS seq FROM mes.flow_steps WHERE run_id = $1", [run.id]);
            await tx.query("INSERT INTO mes.flow_steps (run_id, seq, node, by, via) VALUES ($1, $2, $3, $4, $5)", [run.id, seq, node, by, via]);
            await tx.query("UPDATE mes.flow_runs SET node = $2, state = 'running', reason = NULL, waiting = NULL, due_at = NULL, updated_at = now() WHERE id = $1", [run.id, node]);
            await appendAudit(tx, { actor: by, object: "$flow", recordId: run.id, defVersion: f.version, action: `node:${f.body.name}`, after: { flow: f.body.name, version: f.version, traveler: run.subject_id, node, via } });
        });
        Object.assign(run, { node, state: "running", reason: null, waiting: null, due_at: null });
    }
    // Waiting at a node: for whom, for what; a wait's time.
    async function waitAt(run, waiting, dueAt = null) {
        await db.query("UPDATE mes.flow_runs SET waiting = $2, due_at = $3, updated_at = now() WHERE id = $1", [run.id, JSON.stringify(waiting), dueAt]);
        Object.assign(run, { waiting, due_at: dueAt });
    }
    async function stop(run, f, reason) {
        await db.transaction(async (tx) => {
            await tx.query("UPDATE mes.flow_runs SET state = 'stopped', reason = $2, updated_at = now() WHERE id = $1", [run.id, reason]);
            await appendAudit(tx, { actor: `flow:${f.body.name}`, object: "$flow", recordId: run.id, defVersion: f.version, action: `stopped:${f.body.name}`, after: { node: run.node, reason } });
        });
        Object.assign(run, { state: "stopped", reason });
    }
    // `resume: false`: a sub route left behind (the traveler was moved out of it, or the route it runs
    // inside has ended): its parent is not sent on by it.
    async function end(run, f, outcome, { resume = true } = {}) {
        await db.transaction(async (tx) => {
            await tx.query("UPDATE mes.flow_runs SET state = 'ended', outcome = $2, ended_at = now(), updated_at = now() WHERE id = $1", [run.id, outcome]);
            await appendAudit(tx, { actor: `flow:${f.body.name}`, object: "$flow", recordId: run.id, defVersion: f.version, action: `ended:${f.body.name}`, after: { node: run.node, outcome } });
        });
        Object.assign(run, { state: "ended", outcome });
        if (run.parent_id && resume) await resumeParent(run, f);
    }
    // A sub flow's run ended: its parent takes back what it returns, and goes on.
    async function resumeParent(child, cf) {
        const [p] = await db.query("SELECT * FROM mes.flow_runs WHERE id = $1 AND state = 'running'", [child.parent_id]);
        const fp = p && (await flowAt(p.flow, p.version));
        const n = fp?.body.nodes?.[p.node];
        if (!n || p.waiting?.child !== child.id) return;
        const back = Object.fromEntries(Object.entries(isPlain(n.returns) ? n.returns : {}).map(([mine, theirs]) => [mine, child.context?.[theirs] ?? null]).filter(([, v]) => plain(v) || isPlain(v)));
        if (Object.keys(back).length) {
            p.context = { ...(isPlain(p.context) ? p.context : {}), ...back };
            await db.query("UPDATE mes.flow_runs SET context = $2 WHERE id = $1", [p.id, JSON.stringify(p.context)]);
        }
        await leave(fp, p, { by: `flow:${cf.body.name}`, via: `${cf.body.label} ended (${child.outcome ?? "ended"})` });
    }
    // A sub flow entered: its template's run, a child of this one, its context passed in.
    async function startChild(f, run, id, n, by) {
        // Not among the flows this instance knows: read again before saying so. An instance that did
        // not hear of the change that published it (no bus, or not yet) would otherwise stop the run
        // for a plan that is live (as a node's script is read again, forgetScripts).
        let cf = (await store.flows()).get(n.flow);
        if (!cf) { store.forgetFlows(); cf = (await store.flows()).get(n.flow); }
        // A plan runs plans; a route runs routes (§32.14): the traveler goes through the sub route's steps
        // and comes back to this one's next.
        const what = f.body.kind === "route" ? "route" : "plan";
        if (!cf || cf.body.kind !== f.body.kind) return stop(run, f, `${n.label}: no ${what} "${n.flow}" is published.`);
        const [mine, theirs] = [headOf(f.body), headOf(cf.body)];
        if (!theirs || theirs[1].object !== mine?.[1].object) return stop(run, f, `${n.label}: ${cf.body.label} is about a ${theirs?.[1].object ?? "nothing"}, and this ${what} about a ${mine?.[1].object}.`);
        // Never a circle, nor too deep: the designer refuses a circle of sub flows, but two changes each
        // sound alone can make one once both are live; this run and the runs above it say which.
        const above = await db.query(
            `WITH RECURSIVE up(id, flow, parent_id) AS (SELECT id, flow, parent_id FROM mes.flow_runs WHERE id = $1
               UNION ALL SELECT r.id, r.flow, r.parent_id FROM mes.flow_runs r JOIN up ON r.id = up.parent_id) SELECT flow FROM up`, [run.id]);
        const chain = above.map((r) => r.flow).reverse();
        if (chain.includes(cf.body.name)) return stop(run, f, `${n.label}: ${[...chain, cf.body.name].join(" → ")} would run ${cf.body.label} again, without end. Break the circle in the designer.`);
        if (chain.length >= MAX_NESTED) return stop(run, f, `${n.label}: sub flows nested ${chain.length} deep; at most ${MAX_NESTED}.`);
        const context = await contextOf(f, run);
        const passed = Object.fromEntries(Object.entries(isPlain(n.pass) ? n.pass : {}).map(([k, e]) => { try { return [k, evaluate(e, { context }) ?? null]; } catch { return [k, null]; } }).filter(([, v]) => plain(v)));
        const [child] = await db.query("INSERT INTO mes.flow_runs (flow, version, kind, subject_object, subject_id, participants, context, state, parent_id) VALUES ($1, $2, $8, $3, $4, $5, $6, 'running', $7) RETURNING *",
            [cf.body.name, cf.version, run.subject_object, run.subject_id, JSON.stringify(await idsOf(cf, run.subject_id)), JSON.stringify({ ...initialOf(cf.body), ...passed }), run.id, cf.body.kind]);
        await waitAt(run, { kind: "sub_flow", child: child.id, flow: cf.body.name });
        const first = startNode(cf.body);
        if (!first) return stop(child, cf, `${cf.body.label} has no start.`);
        await enter(cf, child, first, { by, via: `${f.body.label}: ${n.label}` });
        return null;
    }

    // One write, as the template, through the record services: an action, or fields set.
    // What a route does by itself (a step's script, its writes, its every-step transaction) is done again, a few
    // times, when it was refused only for the moment: no connection free in time (db.busy), the database away
    // (db.unavailable), the rules' runner not answering. A refusal that decided something (a rule, a policy, a
    // check) stops the run as before; one whose outcome is not known (db.unknown) is never done twice.
    const passing = (e) => e?.code === "db.busy" || e?.code === "db.unavailable" || e?.message === RULES_UNAVAILABLE;
    async function again(work) {
        for (let attempt = 0; ; attempt++) {
            try { return await work(); } catch (error) {
                if (!passing(error) || attempt >= 5) throw error;
                await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt + Math.random() * 200));
            }
        }
    }
    async function write(f, run, w, key = null) { return again(() => writeOnce(f, run, w, key)); }
    async function writeOnce(f, run, { record, action, set, create, data }, key = null) {
        // A record of its own making (§32.5a): a preventive work order when its plan comes due, a follow-up
        // check. Made as the template, through the record services, holding the roles its design gives it
        // on that object (its `roles`), so the object's policies decide; once per run and write (`key`).
        if (create !== undefined) return records.services["records.create"].call(as(identity(f, run)), { object: create, data, ...(key ? { key } : {}) });
        const ids = await idsOf(f, run.subject_id);
        const p = f.body.participants?.[record];
        if (!p) throw new Error(`"${record}" is no record of the flow`);
        if (!ids[record]) throw new Error(`its ${record} is empty`);
        const row = await x.loadRow(db, p.object, ids[record]);
        if (!row) throw new Error(`its ${record} is gone`);
        const self = as(identity(f, run));
        if (action !== undefined) return records.services["records.action"].call(self, { object: p.object, id: row.id, action, rowVersion: Number(row.row_version) });
        return records.services["records.update"].call(self, { object: p.object, id: row.id, rowVersion: Number(row.row_version), data: set ?? {} });
    }
    // A node's onEnter or onExit script: the context in, the context and its writes out. Its values are
    // kept on the run; its writes made, in order.
    async function hook(f, run, id, which) {
        const n = f.body.nodes?.[id];
        const name = n?.[which];
        if (!name) return;
        let script = (await store.scripts()).get(name);
        // An instance off the change bus has not heard of a change executed elsewhere (its scheduler
        // taking a wait on): read them again once before giving up.
        if (!script) { store.forgetScripts(); script = (await store.scripts()).get(name); }
        if (!script) throw new Error(`its ${which} script ${name} is not published`);
        const context = await contextOf(f, run);
        // `now` as every script has it (§12: `Date` is replaced by ctx.now), and as the script editor's
        // test run gives it. `lookup(object, idOrTitle)` reads one record as the template, with the roles
        // its design gives it (a backend rule's lookup, §12.4): a route's draw skips a wafer that is gone.
        // A record it may not see, or none, is null.
        const self = as(identity(f, run));
        const lookup = async (object, key) => {
            if (typeof object !== "string" || typeof key !== "string" || !key || key.length > 200) return null;
            try {
                const id = UUID.test(key) ? key : (await records.services["records.lookup"].call(self, { object, key }))?.id;
                return id ? await records.services["records.get"].call(self, { object, id }) : null;
            } catch (e) {
                if (e instanceof ServiceError) return null;
                throw e;
            }
        };
        const out = await again(() => runServiceScript({ name, version: script.version, source: script.source, ctx: { event: { kind: which === "onEnter" ? "enter" : "exit", node: id, label: n.label, flow: f.body.name }, context, writes: [], now: new Date().toISOString(), lookup }, deadlineMs: 5000 }));
        const keys = new Set(Object.keys(f.body.participants ?? {}));
        const values = Object.fromEntries(Object.entries(isPlain(out?.context) ? out.context : {}).filter(([k, v]) => !keys.has(k) && plain(v)));
        if (Object.keys(values).length) {
            run.context = { ...(isPlain(run.context) ? run.context : {}), ...values };
            await db.query("UPDATE mes.flow_runs SET context = $2, updated_at = now() WHERE id = $1", [run.id, JSON.stringify(run.context)]);
        }
        // Each write keyed by the run, which visit of the run this is, the node (hashed: a key is at most 100
        // characters, and a node's name up to 48) and its place among the script's writes: the same write
        // done again (a retry) is made once, and one on a later visit to the node (a rework loop) is made anew.
        const [{ visit }] = await db.query("SELECT count(*)::int AS visit FROM mes.flow_steps WHERE run_id = $1", [run.id]);
        const node = createHash("sha256").update(String(id)).digest("hex").slice(0, 12);
        let nth = 0;
        for (const w of Array.isArray(out?.writes) ? out.writes : []) {
            const made = isPlain(w) && typeof w.create === "string" && isPlain(w.data);
            if (!made && (!isPlain(w) || typeof w.record !== "string" || (w.action === undefined && !isPlain(w.set)))) throw new Error(`${name} asked for a write that is not { record, action }, { record, set } or { create, data }`);
            await write(f, run, w, `flow-${run.id}-${visit}-${node}-${which}-${nth++}`);
        }
    }
    // The route's transaction for every step (everySequence.onEnter / onExit), run on its traveler as the route,
    // through the transaction like anyone's run: its callers (the route named), its checks, steps and audit.
    let transactions = null;
    async function everySequence(f, run, which) {
        const name = isPlain(f.body.everySequence?.[which]) ? f.body.everySequence[which].run : null;
        if (!name) return;
        if (!transactions) throw new Error("transactions are not available here");
        const t = (await store.transactions()).get(name);
        if (!t) throw new Error(`its ${which === "onEnter" ? "entering" : "leaving"} transaction ${name} is not published`);
        const traveler = travelerOf(f.body);
        const fills = t.body.appearsOn?.object === traveler?.[1].object ? t.body.appearsOn.fills : null;
        if (!fills) throw new Error(`${t.body.label} does not appear on its traveler's records, so the route cannot run it on one`);
        // (A request key is at most 100 characters: the run and its step, which may have a long name, are in the run's audit, not the key.)
        // One key for its tries: a retry after a passing refusal is the same request, made once.
        const key = `flow-${which}-${crypto.randomUUID()}`;
        await again(() => transactions["transactions.run"].call(as(identity(f, run)), { name, input: { [fills]: run.subject_id }, key }));
    }
    // A sequence entered: the traveler's step field says so, and its state is the sequence's, if it names one.
    async function mark(f, run, id, n) {
        const traveler = travelerOf(f.body);
        const def = await store.definition(traveler[1].object);
        const field = def?.body.flow?.step;
        const row = await x.loadRow(db, traveler[1].object, run.subject_id);
        if (!row) throw new Error("the traveler is gone");
        if (field && row.data?.[field] !== id) await write(f, run, { record: traveler[0], set: { [field]: id } });
        if (n.state && row.state !== n.state) {
            const t = (def.body.states?.transitions ?? []).find((tr) => tr.to === n.state && (tr.from ?? []).includes(row.state));
            if (!t) throw new Error(`no action of ${def.body.label ?? traveler[1].object} takes it from ${row.state} to ${n.state}`);
            await write(f, run, { record: traveler[0], action: t.action });
        }
    }
    // The wire out of `from` to take: an auto decision's first that holds; anything else's one.
    async function nextOf(f, run, from, kind) {
        const wires = (f.body.edges ?? []).filter((e) => e.from === from && !e.retry);
        if (kind !== "auto_decision") return wires[0]?.to ?? null;
        const context = await contextOf(f, run);
        return wires.find((e) => e.when === undefined || holds(e.when, { context }))?.to ?? null;
    }

    // Enters a node, and goes on through starts and auto decisions to where the traveler waits.
    async function enter(f, run, node, { by, via }) {
        const flowNodes = design.flowNodes();
        for (let entered = 0; ; entered++) {
            if (entered > 100) return stop(run, f, "It went through more than 100 nodes without stopping at one: decisions in a loop.");
            const n = f.body.nodes?.[node];
            if (!n) return stop(run, f, `"${node}" is no node of ${f.body.label} version ${f.version}.`);
            await note(run, f, node, by, via);
            const kind = flowKindOf(n, flowNodes);
            if (!kind) return stop(run, f, `${n.label} needs the ${String(n.kind).split(".")[0]} suite, which is not installed.`);
            if (kind === "sequence" && f.body.kind !== "route") return stop(run, f, `${n.label}: a sequence is a route's step, not a plan's.`);
            if (WAITS.includes(kind) && f.body.kind !== "plan" && !(kind === "sub_flow" && f.body.kind === "route")) return stop(run, f, `${n.label}: a ${kind.replace(/_/g, " ")} runs in a plan (OCAP), not on a route.`);
            try {
                if (kind === "sequence") await mark(f, run, node, n);
                await hook(f, run, node, "onEnter");
                if (kind === "sequence") await everySequence(f, run, "onEnter");
            } catch (error) {
                return stop(run, f, `${n.label}: ${error.message}`);
            }
            if (kind === "sequence") return null;
            if (kind === "end") return end(run, f, n.outcome ?? n.label);
            const people = { users: Array.isArray(n.for?.users) ? n.for.users : [], groups: Array.isArray(n.for?.groups) ? n.for.groups : [] };
            if (kind === "wait") return waitAt(run, { kind, mode: n.mode ?? "auto", for: people, seconds: n.seconds }, new Date(Date.now() + 1000 * (Number(n.seconds) || 0)));
            if (kind === "manual_decision" || kind === "input_screen") return waitAt(run, { kind, for: people });
            if (kind === "sub_flow") return startChild(f, run, node, n, by);
            try {
                await hook(f, run, node, "onExit");
            } catch (error) {
                return stop(run, f, `${n.label}: ${error.message}`);
            }
            const next = await nextOf(f, run, node, kind);
            if (!next) return stop(run, f, `No way leads on from ${n.label}: none of its wires holds.`);
            [node, by, via] = [next, `flow:${f.body.name}`, n.label];
        }
    }
    // Leaves the sequence the traveler is at (its onExit), by its wire or to `to`.
    async function leave(f, run, { to = null, by, via }) {
        const n = f.body.nodes?.[run.node];
        if (run.state === "running" && n) {
            try {
                await hook(f, run, run.node, "onExit");
                if (flowKindOf(n, design.flowNodes()) === "sequence") await everySequence(f, run, "onExit");
            } catch (error) {
                return stop(run, f, `${n.label}: ${error.message}`);
            }
        }
        const next = to ?? (await nextOf(f, run, run.node, flowKindOf(n, design.flowNodes())));
        if (!next) return stop(run, f, `No way leads on from ${n?.label ?? run.node}${via ? ` after ${via}` : ""}: it has no wire.`);
        return enter(f, run, next, { by, via });
    }

    // A traveler made: the route whose start holds takes it up.
    async function start({ object, id, user }) {
        if (!id || (await activeRun(id))) return;
        const field = await stepFieldOf(object);
        for (const f of (await store.flows()).values()) {
            const traveler = travelerOf(f.body);
            const first = startNode(f.body);
            // One that runs only inside another route takes up no traveler by itself (§32.14).
            if (f.body.kind !== "route" || f.body.asSub === true || traveler?.[1].object !== object || !first) continue;
            const context = await contextOf(f, null, id);
            if (f.body.nodes[first].when !== undefined && !holds(f.body.nodes[first].when, { context })) continue;
            const at = field ? context[traveler[0]]?.[field] : null;
            const partWay = at && waitsAt(f.body.nodes?.[at], design.flowNodes());
            const [run] = await db.query("INSERT INTO mes.flow_runs (flow, version, kind, subject_object, subject_id, participants, context, state) VALUES ($1, $2, 'route', $3, $4, $5, $6, 'running') RETURNING *",
                [f.body.name, f.version, object, id, JSON.stringify({ [traveler[0]]: id }), JSON.stringify(initialOf(f.body))]);
            await enter(f, run, partWay ? at : first, { by: user?.id ?? "platform", via: partWay ? "started where it was" : "started" });
            return;
        }
    }

    // A record of a plan's subject made or written (or its due date arrived, `only` that plan): each plan
    // whose start holds sets off, once for it (again, once the last has ended, if its start says so).
    async function startPlans({ object, id, user, only = null, via = "set off" }) {
        if (!id) return;
        for (const f of (await store.flows()).values()) {
            if (only && f.body.name !== only) continue;
            const subject = subjectOf(f.body);
            const first = startNode(f.body);
            const start = f.body.nodes?.[first];
            if (f.body.kind !== "plan" || subject?.[1].object !== object || !first || (start?.when === undefined && start?.due === undefined)) continue;
            if ((await db.query(`SELECT 1 FROM mes.flow_runs WHERE flow = $1 AND subject_id = $2 AND kind = 'plan' AND parent_id IS NULL${start.again === true ? " AND state <> 'ended'" : ""} LIMIT 1`, [f.body.name, id])).length) continue;
            const context = await contextOf(f, null, id);
            if (start.when !== undefined && !holds(start.when, { context })) continue;
            if (start.due !== undefined) {
                const date = context[subject[0]]?.[start.due];
                if (typeof date !== "string" || !DATE.test(date) || date > todayIn(plantTz)) continue;
            }
            const [run] = await db.query("INSERT INTO mes.flow_runs (flow, version, kind, subject_object, subject_id, participants, context, state) VALUES ($1, $2, 'plan', $3, $4, $5, $6, 'running') ON CONFLICT DO NOTHING RETURNING *",
                [f.body.name, f.version, object, id, JSON.stringify(await idsOf(f, id)), JSON.stringify({ ...initialOf(f.body), ...(context.route ? { route: context.route } : {}) })]);
            if (run) await enter(f, run, first, { by: user?.id ?? "platform", via });
        }
    }
    // Plans set off by a date (their start's `due`): the subject's records whose date has arrived and that
    // have no run in the way, set off as by a write. At most once a minute, a thousand records a plan.
    let duesAt = 0;
    async function dues(now = new Date()) {
        if (now.getTime() - duesAt < 60_000) return 0;
        duesAt = now.getTime();
        let n = 0;
        for (const f of (await store.flows()).values()) {
            const first = startNode(f.body);
            const start = f.body.nodes?.[first];
            const subject = subjectOf(f.body);
            if (f.body.kind !== "plan" || typeof start?.due !== "string" || !subject) continue;
            // Read in pages, on from the last one read: the thousand oldest whose condition never
            // holds (a plan with a `when`) are passed over each time, not read again and again while
            // the records due after them never start.
            let after = null;
            for (let page = 0; page < 20; page++) {
                const ids = await db.query(
                    `SELECT r.id, r.data->>$2 AS due FROM mes.records r WHERE r.object = $1 AND r.archived_at IS NULL AND r.data->>$2 ~ '^\\d{4}-\\d{2}-\\d{2}$' AND r.data->>$2 <= $3
                       AND NOT EXISTS (SELECT 1 FROM mes.flow_runs fr WHERE fr.flow = $4 AND fr.subject_id = r.id AND fr.kind = 'plan' AND fr.parent_id IS NULL${start.again === true ? " AND fr.state <> 'ended'" : ""})
                       ${after ? "AND (r.data->>$2, r.id) > ($5, $6::uuid)" : ""}
                     ORDER BY r.data->>$2, r.id LIMIT 1000`, [subject[1].object, start.due, todayIn(plantTz), f.body.name, ...(after ? [after.due, after.id] : [])]);
                for (const { id } of ids) {
                    await startPlans({ object: subject[1].object, id, user: { id: "platform" }, only: f.body.name, via: `${start.due} arrived` }).catch((e) => log.error?.("flows: a due date", e));
                    n++;
                }
                if (ids.length < 1000) break;
                after = ids.at(-1);
            }
        }
        return n;
    }

    // Before a transaction is checked: may it run here, on these records? And the sequence's settings.
    // `at` says where each traveler was when it was let through: what afterRun then leaves.
    async function gate({ name, picked }) {
        let node = null;
        const at = {};
        for (const [key, row] of Object.entries(picked)) {
            const run = await activeRun(row.id);
            if (!run) continue;
            at[row.id] = run.node;
            const f = await flowAt(run.flow, run.version);
            if (!f) continue;
            const n = f.body.nodes?.[run.node];
            node ??= n ? { ...(isPlain(n.settings) ? n.settings : {}), name: run.node, label: n.label } : null;
            // Only what the route offers somewhere is the route's to place; the rest runs as before.
            // Somewhere: anywhere in the whole way the traveler is on (§32.14): the outermost route it is
            // in, and every sub route that one runs, entered or not. A transaction one sub route offers is
            // refused on the route's own steps and in its other sub routes, not let through there.
            const chain = await chainOf(run);
            if (!(await offeredIn(chain, name))) continue;
            const t = (await store.transactions()).get(name);
            const what = t?.body.label ?? name;
            const noun = await nounOf(row.object, row.id);
            if (run.state === "stopped") return { problem: { field: key, message: `${noun} is stopped at ${n?.label ?? run.node} (${f.body.label}): ${run.reason}` } };
            if (!(n?.offers ?? []).includes(name)) return { problem: { field: key, message: `${noun} is at ${n?.label ?? run.node} (${f.body.label}), where ${what} is not done.` } };
            const resource = resourceOf(f.body);
            if (resource && isPlain(n.resource)) {
                // A record read off another of the resource's (a test cell's tester, from: "equipment.tester")
                // is that one's part: the route places the one it is read off, not it.
                const partOf = (k) => { const from = t?.body.inputs?.[k]?.from; return typeof from === "string" && picked[from.split(".")[0]]?.object === resource[1].object; };
                for (const [k, r] of Object.entries(picked)) {
                    if (r.object !== resource[1].object || partOf(k)) continue;
                    const off = Object.entries(n.resource).find(([field, v]) => ![].concat(v).map(String).includes(String(field === "state" ? r.state : r.data?.[field])));
                    if (off) {
                        const def = await store.definition(r.object);
                        return { problem: { field: k, message: `${x.nounOf(def, r)} is not where ${n.label} is done: its ${(def?.body.fields?.[off[0]]?.label ?? off[0]).toLowerCase()} is ${off[0] === "state" ? r.state : r.data?.[off[0]] ?? "empty"}.` } };
                    }
                }
            }
        }
        return { node, at };
    }

    // After a write to a traveler: ended, moved by its step field, or left on a sequence's `leaves`.
    async function moved(id, { name = null, user, expected = undefined }) {
        const run = await activeRun(id);
        if (!run) return;
        const f = await flowAt(run.flow, run.version);
        if (!f) return;
        const by = user?.id ?? "platform";
        const context = await contextOf(f, run);
        // Ended: this route, or one it runs inside (the outermost that says so: a lot scrapped part-way
        // through a sub route ends the whole way). The sub routes under it end with it, sending nobody on.
        const chain = await chainOf(run);
        for (const link of [...chain].reverse()) {
            if (link.f.body.ends?.when === undefined || !holds(link.f.body.ends.when, { context: link.run.id === run.id ? context : await contextOf(link.f, link.run) })) continue;
            for (const below of chain.slice(0, chain.indexOf(link))) await end(below.run, below.f, `ended with ${link.f.body.label}`, { resume: false });
            return end(link.run, link.f, "ended");
        }
        // Its step field moved (by the transaction, a form, an import, an equipment event): the route
        // follows it, by its wire if one leads there, else off its wires, audited so (§32.5).
        const traveler = travelerOf(f.body);
        const field = await stepFieldOf(traveler[1].object);
        const at = field ? context[traveler[0]]?.[field] : null;
        // Moved: it names another step than the last one the route marked (a run stopped on a decision
        // after it has not moved by that).
        const flowNodes = design.flowNodes();
        const way = await db.query("SELECT node FROM mes.flow_steps WHERE run_id = $1 ORDER BY seq DESC", [run.id]);
        const marked = way.map((w) => w.node).find((node) => waitsAt(f.body.nodes?.[node], flowNodes)) ?? null;
        if (field && (at ?? null) !== null && at !== marked && at !== run.node) {
            if (!waitsAt(f.body.nodes?.[at], flowNodes)) {
                // A step of a route this one runs inside: the traveler was taken out of the sub route. It
                // ends there, and the route above goes to that step, off its wires, audited so.
                const up = chain.slice(1).find((l) => waitsAt(l.f.body.nodes?.[at], flowNodes));
                if (!up) return stop(run, f, `Its ${field} was set to "${at}", which is no step of ${f.body.label}.`);
                for (const below of chain.slice(0, chain.indexOf(up))) await end(below.run, below.f, `left for ${up.f.body.nodes[at].label ?? at} (${up.f.body.label})`, { resume: false });
                return leave(up.f, up.run, { to: at, by, via: `off route: ${name ?? `${field} set to ${at}`}` });
            }
            const onWire = (f.body.edges ?? []).some((e) => e.from === run.node && e.to === at);
            return leave(f, run, { to: at, by, via: `${onWire ? "" : "off route: "}${name ?? `${field} set to ${at}`}` });
        }
        if (run.state !== "running" || !name) return;
        const n = f.body.nodes?.[run.node];
        // Left only from the step the transaction was let through at: the same transaction run twice at
        // once (the first still on its way out of the step) must not carry the traveler past the next
        // step as well, its work there never done.
        if (expected !== undefined && expected !== run.node) return;
        if ((n?.leaves ?? []).includes(name)) return leave(f, run, { by, via: name });
    }

    // Once a transaction has committed: travelers made start; those it wrote move.
    async function afterRun({ name, user, records: touched = [], created = [], at = {} }) {
        const made = new Set(created.map((c) => c.id));
        for (const c of created) { await start({ object: c.object, id: c.id, user }); await startPlans({ object: c.object, id: c.id, user }); }
        for (const r of touched) if (r.id && !made.has(r.id)) {
            try {
                await moved(r.id, { name, user, expected: at[r.id] });
            } catch (error) {
                // The transaction is committed and cannot be undone by this: the traveler is stopped
                // where it is, saying so, for someone to look at, rather than left as if it still ran.
                log.error?.("flows: moving a traveler on", error);
                const run = await activeRun(r.id).catch(() => null);
                const f = run ? await flowAt(run.flow, run.version).catch(() => null) : null;
                if (run && f && run.state === "running") await stop(run, f, `It could not be moved on after ${name}: the server failed there (the event log has it). Its record is as the transaction left it.`).catch((e) => log.error?.("flows: stopping a traveler", e));
            }
            await startPlans({ object: r.object, id: r.id, user });
        }
    }
    // Any other write to a record (its form, an import, a script): a traveler moved follows. The
    // template's own writes are its own doing, already followed.
    async function afterWrite({ object, id, user }) {
        if (String(user?.id ?? "").startsWith("flow:")) return;
        await moved(id, { user });
        await startPlans({ object, id, user });
    }
    // A record made by its form, an import, a pack's samples: routes and plans it starts.
    async function afterCreate(made) {
        await start(made);
        await startPlans(made);
    }

    // Who a waiting node is for: its users, and the members of its groups.
    const groupsOf = async (userId) => (await db.query("SELECT group_id FROM mes.group_members WHERE user_id = $1", [userId])).map((r) => r.group_id);
    async function isFor(waiting, userId) {
        const people = waiting?.for ?? {};
        if ((people.users ?? []).includes(userId)) return true;
        const mine = await groupsOf(userId);
        return (people.groups ?? []).some((g) => mine.includes(g));
    }
    // What a person may act on now: the plans waiting for them (the bell's tasks).
    async function tasksFor(userId) {
        const mine = await groupsOf(userId);
        const rows = await db.query(
            `SELECT id, flow, version, node, waiting, due_at FROM mes.flow_runs WHERE state = 'running' AND kind = 'plan' AND waiting IS NOT NULL
               AND waiting->>'kind' <> 'sub_flow' AND NOT (waiting->>'kind' = 'wait' AND waiting->>'mode' = 'auto')
               AND (waiting->'for'->'users' ? $1 OR waiting->'for'->'groups' ?| $2::text[]) ORDER BY updated_at`, [userId, mine]);
        const out = [];
        for (const r of rows) {
            const f = await flowAt(r.flow, r.version);
            out.push({ kind: "task", id: r.id, title: `${f?.body.label ?? r.flow}: ${f?.body.nodes?.[r.node]?.label ?? r.node}`, link: `/f/${r.id}` });
        }
        return out;
    }
    // What an input screen's values must be: each field's type, its choices, required; files and
    // images as { name, type, data (base64) }, kept with the run; links as http(s) addresses.
    // An input screen's field drawn from a named query (§32.6): its options, worked out by running the query
    // as `user` with its parameters read from the run's context as it is now. → { options, problem? }
    async function choicesFor(f, run, spec, user) {
        const label = spec.label ?? spec.name;
        const body = query ? (await store.queries()).get(spec.query)?.body : null;
        if (!body) return { options: [], problem: `its list (the query ${spec.query}) is not published: ask whoever designed this plan.` };
        const context = await contextOf(f, run);
        const scope = { context, user: { id: user.id, name: user.name } };
        const values = {};
        for (const [p, expr] of Object.entries(isPlain(spec.params) ? spec.params : {})) {
            const v = evaluate(expr, scope);
            values[p] = isPlain(v) && typeof v.id === "string" ? v.id : v;
        }
        try {
            const { options, missing } = optionsOf(spec, await query.runNamed(user, body, values, { channel: "plan" }));
            if (missing.length) return { options: [], problem: `the query ${spec.query} has no column ${missing.join(", ")}: ask whoever designed this plan.` };
            return { options };
        } catch (error) {
            if (!(error instanceof ServiceError)) throw error;
            return { options: [], problem: `${label}'s list could not be read: ${error.message}` };
        }
    }
    async function collect(run, node, n, values, user, f) {
        const fields = Array.isArray(n.fields) ? n.fields.filter((spec) => isPlain(spec) && typeof spec.name === "string") : [];
        const given = isPlain(values) ? values : {};
        const problems = {};
        const out = {};
        for (const spec of fields) {
            const k = spec.name;
            // What was typed, trimmed (§11.1a): only spaces is nothing.
            const v = typeof given[k] === "string" ? given[k].trim() : given[k];
            const empty = v === undefined || v === null || v === "";
            if (empty) { if (spec.required) problems[k] = `${spec.label ?? k} is required.`; continue; }
            if (spec.type === "string") out[k] = String(v).slice(0, 4000);
            else if (spec.type === "integer" || spec.type === "decimal") {
                const num = Number(v);
                if (!Number.isFinite(num) || (spec.type === "integer" && !Number.isInteger(num))) problems[k] = `${spec.label ?? k} is a ${spec.type === "integer" ? "whole number" : "number"}.`;
                else out[k] = num;
            } else if (spec.type === "boolean") out[k] = v === true || v === "true";
            else if (spec.type === "enum") { if (!(spec.values ?? []).includes(v)) problems[k] = `${spec.label ?? k} is one of ${(spec.values ?? []).join(", ")}.`; else out[k] = v; }
            // From a named query: one of the options it gives the person submitting, now (never a value sent
            // that is not on their list).
            else if (spec.type === "query") {
                const { options, problem } = await choicesFor(f, run, spec, user);
                const hit = options.find((o) => String(o.value) === String(v));
                if (!hit) problems[k] = problem ? `${spec.label ?? k}: ${problem}` : `${spec.label ?? k}: choose one of the list (it may have changed: look again).`;
                else out[k] = hit.value;
            }
            else if (spec.type === "link") { if (!/^https?:\/\/\S+$/i.test(String(v))) problems[k] = `${spec.label ?? k} is a web address (https://…).`; else out[k] = String(v); }
            else if (spec.type === "file" || spec.type === "image") {
                const bytes = isPlain(v) && typeof v.data === "string" ? Buffer.from(v.data, "base64") : null;
                const type = fileTypeOf(v?.type);
                if (!bytes || !bytes.length) problems[k] = `${spec.label ?? k}: attach a ${spec.type}.`;
                else if (bytes.length > FILE_LIMIT) problems[k] = `${spec.label ?? k} is over ${FILE_LIMIT / 1024 / 1024} MB.`;
                else if (spec.type === "image" && !/^image\/(png|jpeg|gif|webp)$/.test(type)) problems[k] = `${spec.label ?? k} is an image (PNG, JPEG, GIF or WebP).`;
                else out[k] = { bytes, name: String(v.name ?? k).slice(0, 200), type };
            }
        }
        if (Object.keys(problems).length) fail("Some fields need attention.", { fields: problems, code: "flow.input" });
        for (const [k, v] of Object.entries(out)) {
            if (!v?.bytes) continue;
            const [file] = await db.query("INSERT INTO mes.flow_files (run_id, node, field, name, type, size, data, by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id", [run.id, node, k, v.name, v.type, v.bytes.length, v.bytes, user.id]);
            out[k] = { file: file.id, name: v.name, type: v.type, size: v.bytes.length };
        }
        return out;
    }
    // A wait whose time is up, with nobody to wait for: on by its wire. Each instance's scheduler
    // calls it; claiming the run (its due_at) keeps it to one of them.
    async function tick(now = new Date()) {
        const arrived = await dues(now).catch((e) => { log.error?.("flows: due dates", e); return 0; });
// Claimed by moving its time on, not by clearing it: if this process stops before the run has
        // gone on (a deploy, a database error), the wait comes due again; cleared, nobody could move it.
                const due = await db.query(
            `UPDATE mes.flow_runs SET due_at = now() + interval '2 minutes' WHERE state = 'running' AND kind = 'plan' AND due_at <= $1
               AND waiting->>'kind' = 'wait' AND waiting->>'mode' = 'auto' RETURNING *`, [now]);
        // What is published is read again before a wait goes on by itself: the timer runs on every
        // instance, and this one may not have heard of the latest change.
        if (due.length) store.forgetFlows();
        for (const r of due) {
            const f = await flowAt(r.flow, r.version);
            if (f) await leave(f, r, { by: `flow:${f.body.name}`, via: "its time was up" }).catch((e) => log.error?.("flows: a wait's time", e));
        }
        if (due.length || arrived) await invalidate([{ name: "flows.task" }, { name: "flows.plansOf" }, { name: "inbox.mine" }, { name: "records.get" }, { name: "records.list" }]);
        return due.length;
    }

    // A route published (or published again): the travelers already there take it up.
    async function adopt(names) {
        const definitions = Object.fromEntries((await store.allDefinitions()).filter(Boolean).map((d) => [d.body.object, d.body]));
        return adoptRuns(db, { flows: await store.flows(), definitions, only: names });
    }

    const runRow = async (id) => (typeof id === "string" && UUID.test(id) ? (await db.query("SELECT * FROM mes.flow_runs WHERE id = $1", [id]))[0] ?? null : null);
    // May this person see a run: they read its subject's object, or it waits for them.
    // (Reading its record, not only holding a role on its object: a policy that hides the record from
    // them hides where it is on its route and who did what to it, too.)
    async function maySee(user, run) {
        if (run.waiting && (await isFor(run.waiting, user.id))) return true;
        const def = await store.definition(run.subject_object);
        const row = def ? await x.loadRow(db, run.subject_object, run.subject_id) : null;
        return Boolean(row && mask(def.body, await x.actorFor(user, run.subject_object), x.rowOut(row)));
    }
    const services = {
        // A person acts on a plan waiting for them (§32.5): acknowledges or retries a wait, picks a
        // manual decision's choice, or fills an input screen in. Then it goes on.
        async "flows.act"({ run: runId, action, choice, values } = {}) {
            const user = await x.requireViewer(this);
            const run = await runRow(runId);
            if (!run) fail("No such plan.", { status: 404 });
            const f = await flowAt(run.flow, run.version);
            const n = f?.body.nodes?.[run.node];
            const w = run.waiting;
            if (run.state !== "running" || !w || !n || w.kind === "sub_flow" || (w.kind === "wait" && w.mode === "auto")) fail("This plan is not waiting for anyone now.", { status: 409, code: "flow.not-waiting" });
            if (!(await isFor(w, user.id))) fail(`This is for ${[...(w.for?.groups ?? []), ...(w.for?.users ?? [])].join(", ") || "nobody"}, not you.`, { status: 403, code: "flow.not-yours" });
            const wires = (f.body.edges ?? []).filter((e) => e.from === run.node);
            // One at a time: two of a group, or one click twice, would each read the wait and each leave
            // it, the node's exit and the next one's entry run twice. The wait is claimed for this call
            // (a claim nobody finished, the process gone mid-way, lapses), and given back if it refuses.
            const [mine] = await db.query(
                `UPDATE mes.flow_runs SET waiting = jsonb_set(waiting, '{acting}', to_jsonb(now()))
                  WHERE id = $1 AND state = 'running' AND node = $2 AND waiting IS NOT NULL
                    AND (waiting->>'acting' IS NULL OR (waiting->>'acting')::timestamptz < now() - interval '30 seconds') RETURNING id`, [run.id, run.node]);
            if (!mine) fail("Someone has just acted on this step: look at the plan as it is now.", { status: 409, code: "flow.not-waiting" });
            try { return await acted(); } catch (error) {
                await db.query("UPDATE mes.flow_runs SET waiting = waiting - 'acting' WHERE id = $1 AND node = $2 AND state = 'running' AND waiting IS NOT NULL", [run.id, run.node]).catch(() => {});
                throw error;
            }
            async function acted() {
            let to = null;
            let what = "";
            if (w.kind === "wait") {
                if (action === "retry") { if (w.mode !== "retry") fail("This wait has no way back."); to = wires.find((e) => e.retry)?.to; what = "retry"; }
                else if (action === "acknowledge") { to = wires.find((e) => !e.retry)?.to; what = "acknowledged"; }
                else fail("Acknowledge it, or retry.");
            } else if (w.kind === "manual_decision") {
                const wire = wires.find((e) => e.label === choice);
                if (!wire) fail(`Pick one of: ${wires.map((e) => e.label).join(", ")}.`, { fields: { choice: "Pick one." } });
                to = wire.to;
                what = choice;
            } else if (w.kind === "input_screen") {
                const got = await collect(run, run.node, n, values, user, f);
                run.context = { ...(isPlain(run.context) ? run.context : {}), ...got };
                await db.query("UPDATE mes.flow_runs SET context = $2 WHERE id = $1", [run.id, JSON.stringify(run.context)]);
                to = wires.find((e) => !e.retry)?.to;
                what = Object.keys(got).join(", ") || "nothing";
            }
            if (!to) fail("No wire leads on from here.");
            await db.transaction((tx) => appendAudit(tx, { actor: user.id, object: "$flow", recordId: run.id, defVersion: f.version, action: `act:${f.body.name}`, after: { node: run.node, kind: w.kind, what } }));
            await leave(f, run, { to, by: user.id, via: `${n.label}: ${what}` });
            return { ok: true, run: run.id, node: run.node, state: run.state };
            }
        },
        // One plan's run, for its page (§32.7): where it is, what it waits for, who may act, its way.
        async "flows.task"({ run: runId, as: viewer } = {}) {
            const user = await x.requireViewer(this, viewer);
            const run = await runRow(runId);
            if (!run || !(await maySee(user, run))) return null;
            const f = await flowAt(run.flow, run.version);
            const n = f?.body.nodes?.[run.node] ?? {};
            const steps = await db.query("SELECT seq, node, at, by, via FROM mes.flow_steps WHERE run_id = $1 ORDER BY seq", [run.id]);
            const label = (id) => f?.body.nodes?.[id]?.label ?? id;
            const keys = new Set(Object.keys(f?.body.participants ?? {}));
            const files = await db.query("SELECT id, node, field, name, type, size, by, at FROM mes.flow_files WHERE run_id = $1 ORDER BY at", [run.id]);
            const children = await db.query("SELECT id, flow, state, node FROM mes.flow_runs WHERE parent_id = $1 ORDER BY started_at", [run.id]);
            const parent = run.parent_id ? (await db.query("SELECT id, flow FROM mes.flow_runs WHERE id = $1", [run.parent_id]))[0] : null;
            const def = await store.definition(run.subject_object);
            const subjectRow = def ? await x.loadRow(db, run.subject_object, run.subject_id) : null;
            // Its record's own state, as the person may read it: beside the plan's, so a repair in progress
            // is not read as its tool running.
            const seen = subjectRow ? mask(def.body, await x.actorFor(user, run.subject_object), x.rowOut(subjectRow)) : null;
            const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);
            return {
                id: run.id, flow: run.flow, label: f?.body.label ?? run.flow, description: f?.body.description ?? "", kind: run.kind, version: run.version,
                state: run.state, reason: run.reason, outcome: run.outcome, node: run.node, nodeLabel: label(run.node), nodeKind: n.kind ?? null,
                message: n.message ?? "", waiting: run.waiting ?? null, dueAt: iso(run.due_at), mayAct: Boolean(run.waiting && run.state === "running" && (await isFor(run.waiting, user.id))),
                choices: run.waiting?.kind === "manual_decision" ? (f.body.edges ?? []).filter((e) => e.from === run.node).map((e) => e.label) : [],
                fields: run.waiting?.kind === "input_screen" ? await Promise.all((Array.isArray(n.fields) ? n.fields : []).map(async (spec) => ({
                    name: spec.name, label: spec.label ?? spec.name, type: spec.type, values: spec.values ?? [], required: Boolean(spec.required),
                    // A list from a named query, as this person may read it (§32.6).
                    ...(spec.type === "query" ? await choicesFor(f, run, spec, user) : {}),
                }))) : [],
                context: Object.fromEntries(Object.entries(run.context ?? {}).filter(([k]) => !keys.has(k))),
                subject: subjectRow ? { object: run.subject_object, id: run.subject_id, label: def.body.label, title: x.nounOf(def, { data: seen ?? {} }), state: seen?.state ?? null, tone: seen ? def.body.states?.tones?.[seen.state] ?? null : null } : null,
                steps: steps.map((st) => ({ ...st, label: label(st.node), at: iso(st.at) })),
                files: files.map((fl) => ({ ...fl, at: iso(fl.at) })),
                children: await Promise.all(children.map(async (c) => ({ id: c.id, label: (await store.flows()).get(c.flow)?.body.label ?? c.flow, state: c.state }))),
                parent: parent ? { id: parent.id, label: (await store.flows()).get(parent.flow)?.body.label ?? parent.flow } : null,
                startedAt: iso(run.started_at), endedAt: iso(run.ended_at),
                // The template as this run's version draws it, for its way shown on it (§32.7).
                map: f ? flowMapOf(f.body, design.flowNodes()) : null,
            };
        },
        // The plans a record took part in, for its page: what set them off, where they are.
        async "flows.plansOf"({ object, id, as: viewer } = {}) {
            const user = await x.requireViewer(this, viewer);
            if (typeof id !== "string" || !UUID.test(id)) return [];
            // The record itself, not only a role on its object: a policy that hides it hides its plans (maySee).
            const def = await store.definition(object);
            const row = def ? await x.loadRow(db, object, id) : null;
            if (!row || !mask(def.body, await x.actorFor(user, object), x.rowOut(row))) return [];
            const rows = await db.query(
                `SELECT r.id, r.flow, r.version, r.node, r.state, r.outcome, r.waiting, r.started_at FROM mes.flow_runs r
                  WHERE r.kind = 'plan' AND r.parent_id IS NULL AND (r.subject_id = $1 OR EXISTS (SELECT 1 FROM jsonb_each_text(r.participants) p WHERE p.value = $1::text))
                  ORDER BY r.started_at DESC LIMIT 20`, [id]);
            return Promise.all(rows.map(async (r) => {
                const f = await flowAt(r.flow, r.version);
                return { id: r.id, label: f?.body.label ?? r.flow, state: r.state, outcome: r.outcome, nodeLabel: f?.body.nodes?.[r.node]?.label ?? r.node, waitingFor: r.waiting && r.state === "running" ? [...(r.waiting.for?.groups ?? []), ...(r.waiting.for?.users ?? [])] : [], startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : r.started_at };
            }));
        },
        // In a sandbox only (a scenario's { act: { action: "time_up" } }, §32.8): a wait's time passes.
        ...(sandbox ? {
            async "flows.timeUp"({ run: runId } = {}) {
                await x.requireViewer(this);
                const run = await runRow(runId);
                if (!run || run.state !== "running" || run.waiting?.kind !== "wait") fail("That plan is not at a wait.", { status: 409 });
                await db.query("UPDATE mes.flow_runs SET due_at = now() - interval '1 second' WHERE id = $1", [run.id]);
                if (run.waiting.mode === "auto") await tick(new Date());
                return { ok: true };
            },
        } : {}),
        // A file or an image an input screen collected, for whoever may see its run.
        async "flows.file"({ id } = {}) {
            const user = await x.requireViewer(this);
            const [file] = typeof id === "string" && UUID.test(id) ? await db.query("SELECT * FROM mes.flow_files WHERE id = $1", [id]) : [];
            const run = file ? await runRow(file.run_id) : null;
            if (!file || !run || !(await maySee(user, run))) fail("No such file.", { status: 404 });
            return { name: file.name, type: fileTypeOf(file.type), size: file.size, data: Buffer.from(file.data).toString("base64") };
        },
        // Where a record is on its route, and its way there, for its page (§32.7).
        async "flows.runOf"({ object, id, as: viewer } = {}) {
            const user = await x.requireViewer(this, viewer);
            if (typeof id !== "string" || !UUID.test(id)) return null;
            const def = await store.definition(object);
            const row = def ? await x.loadRow(db, object, id) : null;
            // (The record itself, not only a role on its object: maySee.)
            if (!row || !mask(def.body, await x.actorFor(user, object), x.rowOut(row))) return null;
            // The route it is in now: the innermost, with the routes that one runs inside (§32.14); else its last.
            const [run] = [await activeRun(id)].filter(Boolean).concat(await db.query("SELECT * FROM mes.flow_runs WHERE subject_id = $1 ORDER BY (state <> 'ended') DESC, (parent_id IS NULL) DESC, started_at DESC LIMIT 1", [id]));
            if (!run) return null;
            const f = await flowAt(run.flow, run.version);
            const chain = run.state !== "ended" && run.kind === "route" ? await chainOf(run) : [];
            const steps = await db.query("SELECT seq, node, at, by, via FROM mes.flow_steps WHERE run_id = $1 ORDER BY seq", [run.id]);
            const label = (n) => f?.body.nodes?.[n]?.label ?? n;
            const tree = run.kind === "route" ? await routeTreeOf(run) : { routes: [], subMaps: {} };
            return {
                id: run.id, ...tree,
                flow: run.flow, label: f?.body.label ?? run.flow, version: run.version, state: run.state, reason: run.reason, outcome: run.outcome,
                node: run.node, nodeLabel: label(run.node), offers: f?.body.nodes?.[run.node]?.offers ?? [], context: run.context ?? {},
                // What the route offers anywhere: on the record's page, those appear only where it is (§32.5).
                routed: [...new Set((chain.length ? chain.map((l) => l.f) : [f]).flatMap((t) => Object.values(t?.body.nodes ?? {}).flatMap((n) => (Array.isArray(n?.offers) ? n.offers : []))))],
                // The routes it runs inside, innermost first: each waiting at the sub flow that runs this one.
                inside: chain.slice(1).map((l) => ({ flow: l.run.flow, label: l.f.body.label, node: l.run.node, nodeLabel: l.f.body.nodes?.[l.run.node]?.label ?? l.run.node })),
                steps: steps.map((s) => ({ ...s, label: label(s.node), offRoute: String(s.via ?? "").startsWith("off route"), at: s.at instanceof Date ? s.at.toISOString() : s.at })),
                map: f ? flowMapOf(f.body, design.flowNodes()) : null,
            };
        },
    };
    const touches = {
        "flows.act": (args) => [{ name: "flows.task" }, { name: "flows.plansOf" }, { name: "flows.runOf" }, { name: "inbox.mine" }, { name: "records.get" }, { name: "records.list" }, { name: "screens.data" }],
        "flows.file": [],
        ...(sandbox ? { "flows.timeUp": [{ name: "flows.task" }, { name: "flows.plansOf" }, { name: "inbox.mine" }] } : {}),
    };
    return { useTransactions: (services) => { transactions = services; }, services, touches, queries: ["flows.runOf", "flows.task", "flows.plansOf"], start, startPlans, gate, afterRun, afterWrite, afterCreate, adopt, tick, dues, tasksFor, useInvalidate: (fn) => { invalidate = fn; } };
}
