// Approval of record changes (DESIGN.md §28). An object's design may say that changes to its records
// made outside a transaction (a form, a list, an Excel import) wait for approval: some fields, in some
// states; new records; some actions (definition.js needsApproval). Such a change is checked like the
// write it asks for (services.js), then kept here as a request, with why, instead of being written.
//
// Who signs: the stewards of what it changes (definition.js recordRoute), each department in its own
// approval steps (§27.3), never the requester, never one person in two steps. A rejection ends it.
// When the last department signs, it is applied as its requester, with every check a direct change
// runs (rights, rule pipe, validation), on the record as it was asked about: if the record changed
// meanwhile (a transaction ran, someone else edited it), or the checks no longer pass, it is void and
// says why, and nothing is written. One request waits per record at a time. Nothing here knows what
// a lot is: which changes wait, and for whom, is each object's design.
import { ServiceError, fail } from "../../../src/errors.js";
import { CALL_KIND } from "../../../src/live-protocol.js";
import { appendAudit } from "./audit.js";
import { decide, mask } from "./policy.js";
import { recordRoute } from "../client/definition.js";
import { organizationSettings, stepsOf } from "./organization.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
const either = (list) => (list.length > 1 ? `${list.slice(0, -1).join(", ")} or ${list.at(-1)}` : list.join(""));

export function createRecordRequests({ store, records, log = console }) {
    const { db } = store;
    const x = records.internals;
    // Signatures (§7.4): who proves who they are at an approval, where the plant asks it (app.mjs sets it).
    let signatures = null;

    const summaryOf = (r) => ({
        id: r.id, object: r.object, record_id: r.record_id, op: r.op, action: r.action, state: r.state,
        requested_by: r.requested_by, reason: r.reason, route: (r.route ?? []).map((d) => d.department),
        requested_at: iso(r.requested_at), decided_at: iso(r.decided_at), outcome: r.outcome ?? null,
    });

    // A department's signatures on one request, step by step: who may sign its current step (never the
    // requester, never someone who signed an earlier step of it).
    async function progressOf(q, req, department, approvals, settings) {
        const mine = approvals.filter((a) => a.department === department);
        const signers = mine.map((a) => a.user_id);
        const steps = (await stepsOf(q, department, settings)).map((st) => ({
            ...st, signed: mine.find((a) => a.step === st.step) ?? null,
            eligible: st.approvers.filter((u) => u !== req.requested_by && !signers.includes(u)),
        }));
        const rejected = mine.find((a) => a.decision === "reject") ?? null;
        const current = rejected ? null : steps.find((st) => !st.signed) ?? null;
        return { steps, current, done: !rejected && !current && steps.length > 0, rejected };
    }
    const approvalsOf = (q, id) => q.query("SELECT department, step, user_id, decision, meaning, note, at FROM mes.record_request_approvals WHERE request_id = $1 ORDER BY at", [id]);
    // The departments on a route whose approval nobody but the requester could sign (a step with no
    // one else): asked, it could never be approved, so it is refused at once.
    async function unsignable(route, requester) {
        const settings = await organizationSettings(db);
        const out = [];
        for (const r of route) {
            const steps = await stepsOf(db, r.department, settings);
            if (!steps.length || steps.some((st) => !st.approvers.some((u) => u !== requester))) out.push(r.department);
        }
        return out;
    }

    // ---- asking: services.js, for a change that waits ----
    async function request(self, user, { op, def, row = null, data = {}, changed = [], action = null, reason, key }) {
        const object = def.body.object;
        const route = recordRoute(def.body, { op, state: row?.state ?? null, changed, action });
        const why = typeof reason === "string" ? reason.trim() : "";
        if (!route.length) fail(`Nobody stewards this change to ${def.body.label}: its design names no stewards.`, { status: 409, code: "record.no_approver" });
        if (!why) fail(`This change waits for approval by ${route.map((r) => r.department).join(", ")}: say why.`, { status: 400, code: "record.reason", fields: { reason: "Say why." } });
        if (why.length > 2000) fail("Say why in at most 2000 characters.", { fields: { reason: "At most 2000 characters." } });
        const stuck = await unsignable(route, user.id);
        if (stuck.length) fail(`Nobody but you could approve it for ${stuck.join(", ")}, and nobody approves their own change: ask someone else to make it, or give ${stuck.length > 1 ? "those departments" : "that department"} another approver (People & departments).`, { status: 409, code: "record.no_approver" });
        try {
            return await db.transaction(async (tx) => {
                if (row) {
                    const locked = await x.loadRow(tx, object, row.id, true);
                    if (!locked || Number(locked.row_version) !== Number(row.row_version)) fail(x.STALE, { status: 409, code: "stale" });
                    const [waiting] = await tx.query("SELECT requested_by FROM mes.record_requests WHERE object = $1 AND record_id = $2 AND state = 'pending'", [object, row.id]);
                    if (waiting) fail(`A change to ${x.nounOf(def, row)} already waits for approval (asked by ${waiting.requested_by}): it is decided or withdrawn first.`, { status: 409, code: "record.pending" });
                }
                const [req] = await tx.query(
                    `INSERT INTO mes.record_requests (object, record_id, op, action, data, base_version, def_version, requested_by, reason, route)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
                    [object, row?.id ?? null, op, action, JSON.stringify(data), row ? Number(row.row_version) : null, def.version, user.id, why, JSON.stringify(route)],
                );
                await appendAudit(tx, { actor: user.id, object, recordId: row?.id ?? null, defVersion: def.version, action: `request:${op}`, after: { request: req.id, ...(op === "action" ? { action } : { values: data }), reason: why, route: route.map((r) => r.department) } });
                const result = { $request: summaryOf(req) };
                await x.remember(tx, key, user, result);
                return result;
            });
        } catch (error) {
            // Two asked at once: the second finds the first.
            if (error?.code === "23505") fail(`A change to this ${def.body.label.toLowerCase()} already waits for approval: it is decided or withdrawn first.`, { status: 409, code: "record.pending" });
            throw error;
        }
    }

    // ---- deciding ----
    // Once every department has signed: applied as the requester, or void. Safe to run again.
    async function settle(id) {
        const [req] = await db.query("SELECT * FROM mes.record_requests WHERE id = $1", [id]);
        if (!req || req.state !== "pending") return req;
        const approvals = await approvalsOf(db, id);
        const settings = await organizationSettings(db);
        for (const r of req.route) if (!(await progressOf(db, req, r.department, approvals, settings)).done) return req;
        const voided = (why) => db.transaction(async (tx) => closeAs(tx, req, "void", why));
        const def = await store.definition(req.object);
        if (!def) return voided("Its object is no longer in use.");
        const user = await store.user(req.requested_by);
        if (!user) return voided(`${req.requested_by} is no longer active.`);
        const self = { [CALL_KIND]: "internal", reason: `approved change ${id}`, user };
        let plan;
        try {
            if (req.op === "create") plan = await x.planCreate(self, user, def, req.data);
            else {
                const row = await x.loadRow(db, req.object, req.record_id);
                if (!row) return voided("The record is gone.");
                if (Number(row.row_version) !== Number(req.base_version)) return voided("The record changed after this was asked for, so it was not applied: ask again on the record as it is now.");
                plan = req.op === "edit" ? await x.planUpdate(self, user, def, row, req.data) : await x.planAction(self, user, def, row, req.action);
                if (!plan) return voided("It changes nothing any more.");
            }
        } catch (error) {
            if (error instanceof ServiceError) return voided(`It no longer passes the checks: ${error.message}`);
            throw error;
        }
        return db.transaction(async (tx) => {
            const [locked] = await tx.query("SELECT * FROM mes.record_requests WHERE id = $1 FOR UPDATE", [id]);
            if (locked.state !== "pending") return locked;
            let recordId = req.record_id;
            if (req.op === "create") recordId = (await x.applyCreate(tx, self, user, plan)).id;
            else {
                const row = await x.loadRow(tx, req.object, req.record_id, true);
                if (!row || Number(row.row_version) !== Number(req.base_version)) return closeAs(tx, req, "void", "The record changed after this was asked for, so it was not applied: ask again on the record as it is now.");
                await (req.op === "edit" ? x.applyUpdate(tx, self, user, plan) : x.applyAction(tx, self, user, plan));
            }
            return closeAs(tx, { ...req, record_id: recordId }, "applied", null, approvals);
        });
    }
    async function closeAs(tx, req, state, outcome, approvals = []) {
        const [row] = await tx.query("UPDATE mes.record_requests SET state = $2, outcome = $3, record_id = $4, decided_at = now() WHERE id = $1 RETURNING *", [req.id, state, outcome, req.record_id]);
        await appendAudit(tx, { actor: "platform", object: req.object, recordId: req.record_id, defVersion: req.def_version, action: `request:${state}`, after: { request: req.id, ...(outcome ? { outcome } : {}), ...(approvals.length ? { signed: approvals.map((a) => ({ department: a.department, step: a.step, by: a.user_id })) } : {}) } });
        return row;
    }

    // ---- reading ----
    // Whether `user` may see a request: its requester, anyone who approves for a department on its
    // route, or anyone who may read the record (a new one: anyone with a role on its object).
    // Who asked, and who approves for a department on its route: they see all of what is asked.
    async function involved(req, user) {
        if (req.requested_by === user.id) return true;
        const settings = await organizationSettings(db);
        for (const r of req.route) if ((await stepsOf(db, r.department, settings)).some((st) => st.approvers.includes(user.id))) return true;
        return false;
    }
    async function maySee(req, user, def) {
        if (await involved(req, user)) return true;
        if (!def) return false;
        const actor = await x.actorFor(user, req.object);
        if (!req.record_id) return actor.roles.length > 0;
        const row = await x.loadRow(db, req.object, req.record_id);
        return Boolean(row && mask(def.body, actor, x.rowOut(row)));
    }
    // What a request asks, for someone who may see it: each value changed (as it is now → as asked),
    // the action, the departments' progress and what this person may do.
    async function detail(req, user) {
        const def = await store.definition(req.object);
        const approvals = await approvalsOf(db, req.id);
        const settings = await organizationSettings(db);
        const row = req.record_id ? await x.loadRow(db, req.object, req.record_id) : null;
        const fields = def?.body.fields ?? {};
        const labelOf = (n) => fields[n]?.label ?? n;
        // Values titled as the viewer may see them (a reference: its record's title).
        const titled = async (values) => (def ? (await x.withTitles(def.body, user, [values]))[0].$titles ?? {} : {});
        const asked = req.data ?? {};
        const now = row?.data ?? {};
        const [askedTitles, nowTitles] = [await titled(asked), await titled(now)];
        // Anyone else who may read the record sees the values of the fields they may read on it, as in
        // its history: a field a policy hides from them is named, its values are not (§9, §28).
        let readable = () => true;
        if (def && !(await involved(req, user))) {
            const seen = decide(def.body, await x.actorFor(user, req.object), row ? x.recordOf(row) : { ...asked, state: def.body.states.initial });
            readable = (n) => seen.read && Boolean(seen.fields[n]);
        }
        const changes = req.op === "action" ? [] : Object.keys(asked).map((n) => (readable(n)
            ? { field: n, label: labelOf(n), type: fields[n]?.type ?? "string", before: req.op === "edit" ? now[n] ?? null : null, after: asked[n] ?? null, beforeTitle: nowTitles[n] ?? null, afterTitle: askedTitles[n] ?? null }
            : { field: n, label: labelOf(n), type: fields[n]?.type ?? "string", before: null, after: null, beforeTitle: null, afterTitle: null, hidden: true }));
        const titleField = def?.body.titleField;
        const transition = req.op === "action" ? def?.body.states.transitions.find((t) => t.action === req.action && (!row || t.from.includes(row.state))) : null;
        const departments = [];
        const can = { approveFor: [], approveSteps: {}, withdraw: req.state === "pending" && req.requested_by === user.id };
        for (const r of req.route) {
            const p = await progressOf(db, req, r.department, approvals, settings);
            const last = p.steps.filter((st) => st.signed).at(-1)?.signed ?? null;
            const mine = req.state === "pending" && Boolean(p.current?.eligible.includes(user.id));
            if (mine) { can.approveFor.push(r.department); can.approveSteps[r.department] = { step: p.current.step, label: p.current.label, of: p.steps.length }; }
            departments.push({
                department: r.department, because: r.because,
                status: p.rejected ? "rejected" : p.done ? "approved" : req.state === "pending" ? "pending" : "not signed",
                ...(p.rejected ? { by: p.rejected.user_id, note: p.rejected.note } : p.done ? { by: last?.user_id ?? null } : {}),
                ...(p.current && req.state === "pending" ? { step: p.current.label, stepNo: p.steps.indexOf(p.current) + 1, of: p.steps.length, waitingFor: p.current.eligible, mine } : {}),
                signed: approvals.filter((a) => a.department === r.department).map((a) => ({ step: a.step, by: a.user_id, decision: a.decision, meaning: a.meaning, note: a.note, at: iso(a.at) })),
            });
        }
        return {
            ...summaryOf(req), label: def?.body.label ?? req.object,
            title: row ? (readable(titleField) ? now[titleField] : null) ?? row.id.slice(0, 8) : (readable(titleField) ? asked[titleField] : null) ?? null,
            recordState: row?.state ?? null, current: row ? Number(row.row_version) === Number(req.base_version) : true,
            changes, ...(transition ? { actionLabel: transition.label ?? transition.action, to: transition.to } : {}),
            departments, can, mine: can.approveFor.length > 0,
        };
    }

    // Per person, the requests whose current step they may sign (the sign-in list, §27).
    async function waitingFor() {
        const settings = await organizationSettings(db);
        const out = {};
        for (const req of await db.query("SELECT * FROM mes.record_requests WHERE state = 'pending' ORDER BY requested_at")) {
            const approvals = await approvalsOf(db, req.id);
            const def = await store.definition(req.object);
            // Named by its record's title (a new record's, as asked): "Change to Lot 4712".
            const row = req.record_id ? await x.loadRow(db, req.object, req.record_id) : null;
            const name = (row?.data ?? req.data ?? {})[def?.body.titleField] ?? "";
            const action = def?.body.states.transitions.find((t) => t.action === req.action)?.label ?? req.action;
            const title = `${req.op === "create" ? "New" : req.op === "action" ? action : "Change to"} ${def?.body.label ?? req.object}${name ? ` ${name}` : ""}`;
            for (const r of req.route) {
                const p = await progressOf(db, req, r.department, approvals, settings);
                for (const u of p.current?.eligible ?? []) (out[u] ??= { review: [], sign: [] }).sign.push({ id: req.id, title, department: r.department, step: p.steps.length > 1 ? p.current.label : null, record: true });
            }
        }
        return out;
    }

    async function load(q, id, lock = false) {
        if (typeof id !== "string" || !UUID.test(id)) fail("Not found.", { status: 404 });
        const [req] = await q.query(`SELECT * FROM mes.record_requests WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
        if (!req) fail("Not found.", { status: 404 });
        return req;
    }

    const services = {
        // The change waiting on one record, if any, for someone who may read the record.
        async "requests.ofRecord"({ object, id, as } = {}) {
            const user = await x.requireViewer(this, as);
            if (typeof id !== "string" || !UUID.test(id)) return null;
            const [req] = await db.query("SELECT * FROM mes.record_requests WHERE object = $1 AND record_id = $2 AND state = 'pending'", [object, id]);
            return req && (await maySee(req, user, await store.definition(object))) ? detail(req, user) : null;
        },
        async "requests.get"({ id, as } = {}) {
            const user = await x.requireViewer(this, as);
            const req = await load(db, id);
            if (!(await maySee(req, user, await store.definition(req.object)))) fail("Not found.", { status: 404 });
            return detail(req, user);
        },
        // Every change waiting that this person may see, what they may sign first; with the last 20
        // decided of theirs (asked or signed).
        async "requests.list"({ as } = {}) {
            const user = await x.requireViewer(this, as);
            const out = [];
            for (const req of await db.query("SELECT * FROM mes.record_requests WHERE state = 'pending' ORDER BY requested_at")) {
                if (await maySee(req, user, await store.definition(req.object))) out.push(await detail(req, user));
            }
            const decided = await db.query(
                `SELECT r.* FROM mes.record_requests r WHERE r.state <> 'pending' AND (r.requested_by = $1 OR EXISTS (SELECT 1 FROM mes.record_request_approvals a WHERE a.request_id = r.id AND a.user_id = $1))
                 ORDER BY r.decided_at DESC NULLS LAST LIMIT 20`, [user.id]);
            return { me: user.id, pending: out.sort((a, b) => Number(b.mine) - Number(a.mine)), decided: await Promise.all(decided.map((r) => detail(r, user))) };
        },

        // A department's signature on its current step: approve, or reject (with why). The last one
        // applies it.
        // `signature`: { password } or { sso: true }, where the plant asks every signer to prove who they
        // are (§7.4): checked before anything is written.
        async "requests.approve"({ id, department, decision, meaning, note, signature } = {}) {
            const user = await x.requireViewer(this);
            if (decision !== "approve" && decision !== "reject") fail("Approve or reject.");
            if (typeof meaning !== "string" || !meaning.trim()) fail("A signature states its meaning.", { fields: { meaning: "Required." } });
            if (meaning.length > 200) fail("A signature's meaning is at most 200 characters.", { fields: { meaning: "Too long." } });
            // The note as it is kept, in the request and in the trail alike.
            note = typeof note === "string" ? note.trim().slice(0, 2000) : "";
            if (decision === "reject" && !note) fail("Say why it is rejected.", { fields: { note: "Required." } });
            const proof = signatures ? await signatures.signOne(this, user, `record change ${id} for ${department}`, signature) : null;
            const signed = await db.transaction(async (tx) => {
                const req = await load(tx, id, true);
                if (req.state !== "pending") fail(`This change is ${req.state === "applied" ? "already applied" : `already ${req.state}`}.`, { status: 409 });
                if (!req.route.some((r) => r.department === department)) fail(`${department} is not asked to approve this change.`);
                const settings = await organizationSettings(tx);
                const p = await progressOf(tx, req, department, await approvalsOf(tx, id), settings);
                if (!p.current) fail(`${department} has already decided.`, { status: 409 });
                if (!p.current.eligible.includes(user.id)) {
                    const at = p.steps.length > 1 ? ` at its step "${p.current.label}" (${p.steps.indexOf(p.current) + 1} of ${p.steps.length})` : "";
                    const why = user.id === req.requested_by ? "you asked for this change, and nobody approves their own" : p.steps.some((st) => st.signed?.user_id === user.id) ? "you signed an earlier step, and each step is signed by someone else" : `${p.current.eligible.length ? `${either(p.current.eligible)} signs it` : "nobody may sign it"}`;
                    fail(`You cannot sign for ${department}${at}: ${why}.`, { status: 403, code: "request.not_yours" });
                }
                await tx.query("INSERT INTO mes.record_request_approvals (request_id, department, step, user_id, decision, meaning, note) VALUES ($1, $2, $3, $4, $5, $6, $7)", [id, department, p.current.step, user.id, decision, meaning.trim(), note || null]);
                await appendAudit(tx, { actor: user.id, object: req.object, recordId: req.record_id, defVersion: req.def_version, action: `request:${decision}`, after: { request: id, department, step: p.current.label, meaning: meaning.trim(), ...(note ? { note } : {}), ...(proof ? { printedName: proof.printedName, method: proof.method } : {}) } });
                if (decision === "reject") return closeAs(tx, req, "rejected", `Rejected for ${department} by ${user.id}: ${note}`);
                return req;
            });
            const after = decision === "approve" ? await settle(id) : signed;
            return { request: summaryOf(after) };
        },
        // Its requester takes it back while it waits.
        async "requests.withdraw"({ id } = {}) {
            const user = await x.requireViewer(this);
            const done = await db.transaction(async (tx) => {
                const req = await load(tx, id, true);
                if (req.requested_by !== user.id) fail("Only whoever asked for a change withdraws it.", { status: 403 });
                if (req.state !== "pending") fail(`This change is already ${req.state}.`, { status: 409 });
                const [row] = await tx.query("UPDATE mes.record_requests SET state = 'withdrawn', decided_at = now() WHERE id = $1 RETURNING *", [id]);
                await appendAudit(tx, { actor: user.id, object: req.object, recordId: req.record_id, defVersion: req.def_version, action: "request:withdrawn", after: { request: id } });
                return row;
            });
            return { request: summaryOf(done) };
        },
    };

    // A decision changes the request, its record (once applied) and the lists.
    const decided = (args, result) => {
        const r = result?.request;
        if (!r) return [];
        return [
            { name: "requests.get", where: { id: r.id } }, { name: "requests.list" }, { name: "inbox.mine" },
            { name: "requests.ofRecord", where: { object: r.object, id: r.record_id } },
            { name: "records.get", where: { object: r.object, id: r.record_id } }, { name: "records.list", where: { object: r.object } },
            { name: "screens.data" }, { name: "records.history", where: { object: r.object, id: r.record_id } },
        ];
    };
    const touches = { "requests.ofRecord": [], "requests.get": [], "requests.list": [], "requests.approve": decided, "requests.withdraw": decided };
    return { services, touches, request, settle, waitingFor, queries: ["requests.ofRecord", "requests.get", "requests.list"], useSignatures(given) { signatures = given; } };
}
