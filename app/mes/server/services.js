// The generic services (DESIGN.md §11): a fixed set, with the object as data in the arguments. Every
// read is filtered by the policy engine; every write goes through one shape (§11.4): who, idempotency,
// row version, rights, the rule pipe, validation, the write, the audit row. Archiving and restoring
// a record are writes too, in the same shape, with the object's whole rule pipe.
//
// Who is calling (Juris "who is calling"): a request's context carries the session id and is resolved
// on every call, never memoised; a preload or a live re-run carries the viewer as an argument (`as`),
// which the server chose (preload) or `authorize` matched to the session (live).
import { fail } from "../../../src/errors.js";
import { callKind } from "../../../src/live-protocol.js";
import { decide, mask, explainDecision, actionRefusal, archiveRefusal } from "./policy.js";
import { runRules } from "./rules.js";
import { PERSONAL } from "../client/theme.js";
import { appendAudit, sha256 } from "./audit.js";
import { openInterval, closeInterval, dimsOf } from "./analytics.js";
import { evaluate } from "../client/expr.js";
import { sortRows } from "../client/sort.js";
import { needsApproval, BLOB_NAME } from "../client/definition.js";
import { managedOf, managedWhy } from "../client/builtins.js";
import { rightsSql, orderSql, searchSql, titleSql } from "./record-sql.js";
import { createTitles, UUID as ID } from "./titles.js";
import { containment, recordWhere } from "./record-where.js";
import { column } from "./query.js";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,47}$/;
const STALE = "Someone changed this record since you opened it. Reload it and try again.";
// An object's list, page by page (§10.1): records looked at to sort and filter, at most; rows a page.
const LIST_SCAN = 5000; // rows read when the viewer's rights do not compile to SQL (record-sql.js)
const LIST_PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// ---- validation against the definition (§11.4) ------------------------------------------------
// `record` ({ state, … }) is what a field's `requiredWhen` may read beside the data.
// A date that exists (2026-02-31 does not, and would break the object's query view when cast).
const realDate = (value) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return false;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    d.setUTCFullYear(Number(m[1]));
    return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};
// Text the database keeps: no U+0000, no lone surrogate (jsonb refuses both, with no field to say).
const storable = (value) => !value.includes("\u0000") && value.isWellFormed();
export function validate(definition, data, record = {}) {
    const fields = {};
    for (const [name, field] of Object.entries(definition.fields)) {
        const value = data[name];
        const empty = value === undefined || value === null || value === "" || ((field.multiple || field.type === "rows") && Array.isArray(value) && !value.length);
        // A table of rows (a transaction's readings, §25.1): each row checked against its own fields,
        // and as many rows as it asks for.
        if (field.type === "rows") {
            const rows = Array.isArray(value) ? value : [];
            const least = field.min ?? (field.required ? 1 : 0);
            if (!empty && !Array.isArray(value)) { fields[name] = "A list of rows."; continue; }
            if (rows.length < least) { fields[name] = `${field.label ?? name}: at least ${least} ${least === 1 ? "row" : "rows"}${rows.length ? `, not ${rows.length}` : ""}.`; continue; }
            if (field.max !== undefined && rows.length > field.max) { fields[name] = `${field.label ?? name}: at most ${field.max} rows.`; continue; }
            for (const [i, row] of rows.entries()) {
                const invalid = isPlain(row) ? validate({ fields: field.fields ?? {} }, row) : { _: "A row is a set of values." };
                if (invalid) { fields[name] = `Row ${i + 1}: ${Object.entries(invalid).map(([k, m]) => `${field.fields?.[k]?.label ?? k}: ${m}`).join("; ")}`; break; }
            }
            continue;
        }
        if (empty) {
            // Required always, or when its condition holds on this data (§10.4): the form shows it, and
            // this is what decides.
            const when = field.requiredWhen !== undefined && evaluate(field.requiredWhen, { data, record: { ...data, ...record } }) === true;
            if (field.required || when) fields[name] = `${field.label ?? name} is required${when && !field.required ? " here" : ""}.`;
            continue;
        }
        if (field.multiple) {
            if (!Array.isArray(value) || !value.every((v) => field.values?.includes(v))) fields[name] = `Some of: ${field.values.join(", ")}.`;
            else if (new Set(value).size !== value.length) fields[name] = "Each value once.";
            continue;
        }
        switch (field.type) {
            // A whole number the database's own type holds: 1e300 is an integer here and breaks every
            // sorted list and query of its object there.
            case "integer": if (!Number.isSafeInteger(value)) fields[name] = "A whole number."; break;
            case "decimal": if (typeof value !== "number" || !Number.isFinite(value)) fields[name] = "A number."; break;
            case "boolean": if (typeof value !== "boolean") fields[name] = "Yes or no."; break;
            case "date": if (typeof value !== "string" || !realDate(value)) fields[name] = "A date (YYYY-MM-DD)."; break;
            case "enum": if (!field.values.includes(value)) fields[name] = `One of: ${field.values.join(", ")}.`; break;
            case "ref": if (typeof value !== "string" || !UUID.test(value)) fields[name] = "Pick a record."; break;
            // A picture (§35), by its name in the picture store.
            case "image": if (typeof value !== "string" || !BLOB_NAME.test(value)) fields[name] = "Upload a picture (PNG, JPEG or WebP)."; break;
            default:
                if (typeof value !== "string" || value.length > (field.max ?? 500)) fields[name] = `Text, at most ${field.max ?? 500} characters.`;
                else if (!storable(value)) fields[name] = "It holds a character that cannot be kept (a null character or half a character).";
        }
    }
    return Object.keys(fields).length ? fields : null;
}

// Only the definition's own fields, as given.
function pickFields(definition, data) {
    const out = {};
    if (!isPlain(data)) return out;
    for (const name of Object.keys(definition.fields)) if (Object.hasOwn(data, name)) out[name] = data[name];
    return out;
}

const changedBetween = (before, after) => Object.keys(after).filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]));
const iso = (value) => (value instanceof Date ? value.toISOString() : value);
const rowOut = (row) => ({ ...row, created_at: iso(row.created_at), updated_at: iso(row.updated_at), archived_at: iso(row.archived_at ?? null), row_version: Number(row.row_version) });

// What the browser needs to draw an object: never its policies (§9.7: rights travel as $perm).
function publicDefinition({ version, body }) {
    return {
        object: body.object,
        version,
        label: body.label,
        area: body.area,
        description: body.description ?? "",
        titleField: body.titleField,
        fields: Object.fromEntries(Object.entries(body.fields).map(([name, f]) => [name, {
            label: f.label ?? name, type: f.type, required: Boolean(f.required), values: f.values, to: f.to, computed: Boolean(f.computed),
            ...(f.multiple ? { multiple: true } : {}), ...(f.requiredWhen !== undefined ? { requiredWhen: f.requiredWhen } : {}),
        }])),
        states: { initial: body.states.initial, list: body.states.list, tones: body.states.tones ?? {}, transitions: body.states.transitions.map(({ action, from, to, label }) => ({ action, from, to, label: label ?? action })) },
        list: body.list ?? { columns: Object.keys(body.fields).slice(0, 5) },
        form: body.form ?? { sections: [{ label: "Details", fields: Object.keys(body.fields) }] },
        rules: (body.rules ?? []).map(({ script, writes, when, backendOnly, committed }) => ({ script, writes: writes ?? [], when, backendOnly: Boolean(backendOnly), committed: Boolean(committed) })),
        analytics: { dimensions: body.analytics?.dimensions ?? [] },
        // Which changes wait for approval (§28), and its stewards (who approve them): the form sums up
        // what it would send, and for whom, before it is submitted.
        ...(body.approval ? { approval: body.approval, stewards: body.stewards ?? {} } : {}),
    };
}

// `triggers` (integration.js createTriggers) writes, in a record write's own transaction, what that
// write sets off (§15.2); without it nothing is.
export function createServices({ store, triggers = null, log = console }) {
    // Told of each record made through records.create once it has committed (flows.js starts routes).
    let afterCreate = null;
    let afterWrite = null;
    const { db } = store;
    // Approval of record changes (§28, record-requests.js), bound once it exists: a change its object's
    // design says waits for approval becomes a request instead of a write.
    let approvals = null;
    // Who waits for approval: a person changing a record directly (the browser, an Excel import). A
    // transaction's steps (§25) and a designed service (§15) are approved ways of changing records, and
    // an approved request is applied as its requester: none of them asks again.
    const asPerson = (self) => callKind(self) === "direct" || (callKind(self) === "internal" && self?.asPerson === true);
    const reader = { query: (sql, params) => store.read(sql, params) }; // may be a replica (routing.js)

    // ---- who is calling ----
    async function viewerOf(self, as) {
        const kind = callKind(self);
        if (kind === "preload" || kind === "live") return store.user(as);
        if (kind === "direct") return store.userForSession(self?.sessionId);
        if (kind === "internal") return self.user ?? null;
        return null;
    }
    async function requireViewer(self, as) {
        const user = await viewerOf(self, as);
        if (!user) fail("Sign in first.", { status: 401 });
        return user;
    }
    // A person's roles are their assignments; a service's own identity (§15.2) holds exactly the roles
    // its design grants it (`serviceRoles`, { object: [roles] }), and acts on behalf of someone.
    // `via` names the transaction a write comes through (§25): policies with `via` apply only then.
    async function actorFor(user, object) {
        const via = user.via ? { via: user.via } : {};
        if (user.serviceRoles) return { id: user.id, name: user.name, roles: user.serviceRoles[object] ?? [], departments: [], serviceRoles: user.serviceRoles, onBehalfOf: user.onBehalfOf ?? null, ...via };
        return { id: user.id, name: user.name, roles: await store.rolesFor(user.id, object), departments: await store.departmentsOf(user.id), ...(user.onBehalfOf ? { onBehalfOf: user.onBehalfOf } : {}), ...via };
    }
    async function definitionOf(object) {
        if (typeof object !== "string" || !IDENTIFIER.test(object)) fail("Unknown object.", { status: 404 });
        const def = await store.definition(object);
        if (!def) fail("Unknown object.", { status: 404 });
        return def;
    }
    async function loadRow(q, object, id, lock = false) {
        if (typeof id !== "string" || !UUID.test(id)) return null;
        const [row] = await q.query(`SELECT * FROM mes.records WHERE object = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`, [object, id]);
        return row ?? null;
    }
    const recordOf = (row) => ({ ...row.data, id: row.id, state: row.state, type: row.type, archived_at: iso(row.archived_at ?? null), archived_by: row.archived_by ?? null });
    const nounOf = (def, row) => `${def.body.label ?? def.body.object}${row.data?.[def.body.titleField] ? ` ${row.data[def.body.titleField]}` : ""}`;

    // The titles of referenced records, for display ($titles: { field: "WO-1001" }), each read with the
    // user's own rights: a record they may not read is not named.
    async function withTitles(definition, user, masked) {
        const refs = Object.entries(definition.fields).filter(([, f]) => f.type === "ref");
        if (!refs.length || !masked.length) return masked;
        const wanted = new Map(); // target object -> ids
        for (const [name, field] of refs) {
            const ids = wanted.get(field.to) ?? new Set();
            for (const r of masked) if (typeof r[name] === "string" && UUID.test(r[name])) ids.add(r[name]);
            wanted.set(field.to, ids);
        }
        const titles = new Map(); // target object -> id -> title
        for (const [object, ids] of wanted) {
            const target = await store.definition(object);
            if (!target || !ids.size) continue;
            const actor = await actorFor(user, object);
            const rows = await reader.query("SELECT * FROM mes.records WHERE object = $1 AND id = ANY($2::uuid[])", [object, [...ids]]);
            const named = new Map();
            for (const row of rows) {
                const seen = mask(target.body, actor, rowOut(row));
                if (seen) named.set(row.id, seen[target.body.titleField] ?? row.id.slice(0, 8));
            }
            titles.set(object, named);
        }
        return masked.map((r) => {
            const $titles = {};
            for (const [name, field] of refs) if (r[name]) $titles[name] = titles.get(field.to)?.get(r[name]) ?? null;
            return { ...r, $titles };
        });
    }

    // A read capability for rule scripts: with the user's own rights (§12.4). By its id, or by its title
    // field's value as a label reads it (a hold code "SPC", a lot "LOT1235AB-C"): the newest in use.
    const lookupFor = (user) => async (object, id) => {
        const def = await store.definition(object);
        if (!def) return null;
        const actor = await actorFor(user, object);
        let row = typeof id === "string" && UUID.test(id) ? await loadRow(db, object, id) : null;
        if (!row && typeof id === "string" && id && id.length <= 200 && def.body.titleField) {
            [row] = await db.query("SELECT * FROM mes.records WHERE object = $1 AND data->>$2 = $3 AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1", [object, def.body.titleField, id]);
        }
        return row ? mask(def.body, actor, rowOut(row)) : null;
    };

    // ---- idempotency (§11.1) ----
    async function remembered(key, user) {
        if (key === undefined) return undefined;
        if (typeof key !== "string" || key.length < 8 || key.length > 100) fail("A bad request key.");
        // The person's own keys only: someone else's use of the same text is nothing to this request.
        const [row] = await db.query("SELECT result FROM mes.idempotency WHERE key = $1 AND user_id = $2", [key, user.id]);
        return row ? row.result : undefined;
    }
    const remember = (tx, key, user, result) => (key === undefined ? null : tx.query("INSERT INTO mes.idempotency (key, user_id, result) VALUES ($1, $2, $3)", [key, user.id, JSON.stringify(result)]));

    // The pipe, as a write runs it; a rejection or fault becomes the caller's refusal (§12.5).
    async function pipe(def, actor, { kind, action = null, record, data, changed }) {
        const outcome = await runRules({
            definition: def.body,
            scripts: await store.scripts(),
            ctx: { event: { kind, object: def.body.object, action, changed, source: "user", prev: {} }, user: actor, record, data, now: new Date().toISOString() },
            lookup: lookupFor(actor),
        });
        return outcome;
    }
    async function refuseByRule(def, actor, outcome, recordId, what, dryRun = false) {
        const { error, trace } = outcome;
        if (error.fault) log.error(`rule fault in ${error.script}: ${error.detail}`);
        const scripts = await store.scripts();
        // A dry run's refusal is the dry run's answer, not something the person tried: not audited.
        if (dryRun) fail(error.message, { fields: error.fields ?? (error.field ? { [error.field]: error.message } : undefined), code: error.fault ? "rule.fault" : "rule.rejected" });
        // Rejected writes are audited too (§12.5), in their own transaction: the write's was rolled back.
        // The row also answers "why can't I?" later, on whichever instance is asked.
        const rejection = { script: error.script, version: scripts.get(error.script)?.version ?? null, message: error.message };
        await db.transaction((tx) => appendAudit(tx, { actor: actor.id, onBehalfOf: actor.onBehalfOf, object: def.body.object, recordId, defVersion: def.version, action: `rejected:${what}`, after: { rejection }, rules: trace }));
        const fields = error.fields ?? (error.field ? { [error.field]: error.message } : undefined);
        fail(error.message, { fields, code: error.fault ? "rule.fault" : "rule.rejected" });
    }

    function checkWritable(decision, names) {
        const refused = {};
        for (const name of names) if (decision.fields[name] !== "w") refused[name] = `You cannot change this field (${decision.why[name] ?? "role"}).`;
        if (Object.keys(refused).length) fail("You cannot change some of these fields.", { status: 403, fields: refused, code: "policy.denied" });
    }

    // records.archive (archive true) and records.restore (false), as the caller (`this`).
    // A built-in object's part the platform alone keeps (builtins.js): its records made and archived by
    // the platform, its managed fields written by it alone (Person: People & departments' own), whoever
    // asks and whatever their policies say.
    function guardManaged(def, op, given = {}, row = null) {
        if (!def.body.builtIn) return;
        const managed = managedOf(def.body.object);
        const label = def.body.label ?? def.body.object;
        if (managed.platformRecords && (op === "create" || op === "archive")) fail(`A ${label.toLowerCase()} record is made and archived by the platform: ${managedWhy()}`, { status: 403, code: "managed" });
        const touched = managed.fields.filter((f) => Object.hasOwn(given, f) && (row ? JSON.stringify(row.data?.[f] ?? null) !== JSON.stringify(given[f] ?? null) : true));
        if (touched.length) fail(`${touched.map((f) => def.body.fields[f]?.label ?? f).join(", ")}: ${managedWhy()}`, { status: 403, code: "managed", fields: Object.fromEntries(touched.map((f) => [f, managedWhy()])) });
    }

    async function setArchived({ object, id, rowVersion, key } = {}, archive) {
        const kind = archive ? "archive" : "restore";
        const user = await requireViewer(this);
        const def = await definitionOf(object);
        guardManaged(def, kind);
        const done = await remembered(key, user);
        if (done !== undefined) return done;
        const actor = await actorFor(user, object);
        const row = await loadRow(db, object, id);
        if (!row) fail("Not found.", { status: 404 });
        if (Number(row.row_version) !== rowVersion) fail(STALE, { status: 409, code: "stale" });
        const record = recordOf(row);
        const decision = decide(def.body, actor, record);
        if (!decision.read) fail("Not found.", { status: 404 });
        if (Boolean(row.archived_at) === archive) fail(`${nounOf(def, row)} is ${archive ? "already archived" : "not archived"}.`, { status: 409, code: archive ? "record.archived" : "record.not_archived" });
        if (!decision.archive) fail(archiveRefusal(def.body, actor, record, !archive, decision), { status: 403, code: "policy.denied" });
        const outcome = await pipe(def, actor, { kind, record, data: { ...row.data }, changed: [] });
        if (outcome.error) await refuseByRule(def, actor, outcome, id, kind, this?.dryRun);
        const stamp = archive ? { archived_at: new Date().toISOString(), archived_by: user.id } : { archived_at: null, archived_by: null };
        if (this?.dryRun) return { ...mask(def.body, actor, rowOut({ ...row, ...stamp, row_version: Number(row.row_version) + 1 })), $dryRun: true };
        return db.transaction(async (tx) => {
            const locked = await loadRow(tx, object, id, true);
            if (!locked || Number(locked.row_version) !== rowVersion) fail(STALE, { status: 409, code: "stale" });
            const [updated] = await tx.query(
                `UPDATE mes.records SET archived_at = CASE WHEN $3 THEN now() END, archived_by = CASE WHEN $3 THEN $4 END,
                        row_version = row_version + 1, updated_at = now(), updated_by = $4
                 WHERE object = $1 AND id = $2 RETURNING *`,
                [object, id, archive, user.id],
            );
            await appendAudit(tx, {
                actor: user.id, onBehalfOf: user.onBehalfOf, object, recordId: id, defVersion: def.version, action: kind,
                before: { archived_at: iso(row.archived_at ?? null), archived_by: row.archived_by ?? null },
                after: { archived_at: iso(updated.archived_at ?? null), archived_by: updated.archived_by ?? null },
                rules: outcome.trace,
            });
            // An archived record spends no time in a state: archiving ends its stay, restoring begins one.
            if (archive) await closeInterval(tx, { object, recordId: id, by: user.id, action: "archive" });
            else await openInterval(tx, { object, recordId: id, state: updated.state, by: user.id, action: "restore", dims: dimsOf(def.body, updated.data) });
            await triggers?.enqueue(tx, { object, event: kind, id, by: user.id, origin: this?.origin });
            const result = mask(def.body, actor, rowOut(updated));
            await remember(tx, key, user, result);
            return result;
        });
    }

    // The labels of the published transactions with a step that takes `action` on `object`.
    async function transactionsTaking(object, action) {
        const out = [];
        for (const t of (await store.transactions?.())?.values() ?? []) {
            if ((t.body.steps ?? []).some((st) => st.action === action && t.body.inputs?.[st.on]?.to === object)) out.push(t.body.label);
        }
        return out.length ? out : null;
    }

    // ---- one write, planned, then applied (§11.4) ----
    // Planning checks a write on the record as it stands (`row`, which a transaction may have moved
    // on already in its earlier steps): the rights, the rule pipe, validation. It runs outside any
    // database transaction (the pipe's lookups need connections of their own). Applying writes it,
    // with its audit row, its analytics and its triggers, inside the caller's transaction, on a row
    // the caller has locked and found unchanged. records.update and records.action each plan and
    // apply one write; a transaction (transactions.js) plans all its steps, then applies them in one.
    // A reference newly set names a record of the object it refers to, one the writer may read: any
    // well-formed id used to be kept (another object's, a record hidden from them, one that is not).
    // → { field: message } or null. An object no longer there (retired, its suite removed) is not checked.
    // An image field holds a picture: what it names is kept, and is one (the store keeps documents too, §35).
    async function notPictures(def, data, names) {
        const named = names.filter((n) => def.body.fields?.[n]?.type === "image" && typeof data[n] === "string" && data[n]);
        if (!named.length) return null;
        const kinds = new Map((await reader.query("SELECT sha256, type FROM mes.blobs WHERE sha256 = ANY($1)", [named.map((n) => data[n])])).map((r) => [r.sha256, r.type]));
        const bad = Object.fromEntries(named.filter((n) => !String(kinds.get(data[n]) ?? "").startsWith("image/")).map((n) => [n, "Upload a picture (PNG, JPEG or WebP)."]));
        return Object.keys(bad).length ? bad : null;
    }
    async function strayRefs(def, user, final, names) {
        const out = {};
        for (const name of names) {
            const field = def.body.fields[name];
            const value = final[name];
            if (field?.type !== "ref" || typeof value !== "string" || !value) continue;
            const to = await store.definition(field.to);
            if (!to) continue;
            const target = await loadRow(db, field.to, value);
            if (!target || !mask(to.body, await actorFor(user, field.to), rowOut(target))) out[name] = `No ${String(to.body.label ?? field.to).toLowerCase()} you can see with that id.`;
        }
        return Object.keys(out).length ? out : null;
    }
    async function planUpdate(self, user, def, row, given) {
        const actor = await actorFor(user, def.body.object);
        const record = recordOf(row);
        const decision = decide(def.body, actor, record);
        if (!decision.read) fail("Not found.", { status: 404 });
        if (row.archived_at) fail(`${nounOf(def, row)} is archived; restore it to change it.`, { status: 409, code: "record.archived" });
        const proposed = { ...row.data, ...given };
        const changed = changedBetween(row.data, proposed);
        if (!changed.length) return null;
        checkWritable(decision, changed);
        const outcome = await pipe(def, actor, { kind: "save", record, data: proposed, changed });
        if (outcome.error) await refuseByRule(def, actor, outcome, row.id, "update", self?.dryRun);
        const final = pickFields(def.body, outcome.ctx.data);
        checkWritable(decision, changedBetween(proposed, final).filter((name) => !def.body.fields[name].computed));
        const invalid = validate(def.body, final, { state: row.state, type: row.type }) ?? (await strayRefs(def, user, final, changedBetween(row.data, final))) ?? (await notPictures(def, final, changedBetween(row.data, final)));
        if (invalid) fail("Some fields need attention.", { fields: invalid });
        return { op: "update", def, actor, row, final, trace: outcome.trace, after: { ...row, data: final } };
    }
    async function applyUpdate(tx, self, user, plan) {
        const { def, row, final } = plan;
        const object = def.body.object;
        const [updated] = await tx.query(
            `UPDATE mes.records SET data = $3, def_version = $5, row_version = row_version + 1, updated_at = now(), updated_by = $4
             WHERE object = $1 AND id = $2 RETURNING *`,
            [object, row.id, JSON.stringify(final), user.id, def.version],
        );
        const touched = changedBetween(row.data, final);
        await appendAudit(tx, {
            actor: user.id, onBehalfOf: user.onBehalfOf, object, recordId: row.id, defVersion: def.version, action: "update",
            before: Object.fromEntries(touched.map((n) => [n, row.data[n] ?? null])), after: Object.fromEntries(touched.map((n) => [n, final[n] ?? null])), rules: plan.trace,
        });
        await triggers?.enqueue(tx, { object, event: "update", id: row.id, by: user.id, origin: self?.origin });
        return updated;
    }
    async function planAction(self, user, def, row, action) {
        const actor = await actorFor(user, def.body.object);
        const record = recordOf(row);
        const decision = decide(def.body, actor, record);
        if (!decision.read) fail("Not found.", { status: 404 });
        if (!decision.actions.includes(action)) {
            const why = decision.why[`action:${action}`];
            // Granted only through a transaction: name the ones whose steps take this action (§25).
            const through = why === "transaction" ? await transactionsTaking(def.body.object, action) : null;
            fail(actionRefusal(def.body, actor, record, action, decision, through), { status: why === "archived" ? 409 : 403, code: why === "state" ? "transition.unavailable" : why === "archived" ? "record.archived" : "policy.denied", ...(through ? { transactions: through } : {}) });
        }
        const transition = def.body.states.transitions.find((t) => t.action === action && t.from.includes(row.state));
        const outcome = await pipe(def, actor, { kind: "action", action, record, data: { ...row.data }, changed: [] });
        if (outcome.error) await refuseByRule(def, actor, outcome, row.id, `action:${action}`, self?.dryRun);
        return { op: "action", def, actor, row, action, transition, trace: outcome.trace, after: { ...row, state: transition.to } };
    }
    async function applyAction(tx, self, user, plan) {
        const { def, row, action, transition } = plan;
        const object = def.body.object;
        const [updated] = await tx.query(
            `UPDATE mes.records SET state = $3, def_version = $5, row_version = row_version + 1, updated_at = now(), updated_by = $4
             WHERE object = $1 AND id = $2 RETURNING *`,
            [object, row.id, transition.to, user.id, def.version],
        );
        await appendAudit(tx, { actor: user.id, onBehalfOf: user.onBehalfOf, object, recordId: row.id, defVersion: def.version, action: `transition:${action}`, before: { state: row.state }, after: { state: transition.to }, rules: plan.trace });
        // Analytics (§22): the stay in the old state ends, one in the new state begins.
        await closeInterval(tx, { object, recordId: row.id, by: user.id, action });
        await openInterval(tx, { object, recordId: row.id, state: transition.to, by: user.id, action, dims: dimsOf(def.body, row.data) });
        await triggers?.enqueue(tx, { object, event: `transition:${action}`, id: row.id, by: user.id, origin: self?.origin });
        return updated;
    }

    async function planCreate(self, user, def, data) {
        const object = def.body.object;
        const actor = await actorFor(user, object);
        const given = pickFields(def.body, data);
        const initial = { ...given, state: def.body.states.initial };
        const decision = decide(def.body, actor, initial);
        if (!decision.create) fail(`You cannot create a ${def.body.label}.`, { status: 403, code: "policy.denied" });
        checkWritable(decision, Object.keys(given));
        const outcome = await pipe(def, actor, { kind: "save", record: {}, data: given, changed: Object.keys(given) });
        if (outcome.error) await refuseByRule(def, actor, outcome, null, "create", self?.dryRun);
        const final = pickFields(def.body, outcome.ctx.data);
        const byPipe = changedBetween(given, final).filter((name) => !def.body.fields[name].computed);
        checkWritable(decision, byPipe);
        const invalid = validate(def.body, final, { state: def.body.states.initial }) ?? (await strayRefs(def, user, final, Object.keys(final))) ?? (await notPictures(def, final, Object.keys(final)));
        if (invalid) fail("Some fields need attention.", { fields: invalid });
        return { op: "create", def, actor, given, final, trace: outcome.trace };
    }
    async function applyCreate(tx, self, user, plan) {
        const { def, final } = plan;
        const object = def.body.object;
        const [row] = await tx.query(
            `INSERT INTO mes.records (object, def_version, type, state, data, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
            [object, def.version, final.type ?? null, def.body.states.initial, JSON.stringify(final), user.id],
        );
        await appendAudit(tx, { actor: user.id, onBehalfOf: user.onBehalfOf, object, recordId: row.id, defVersion: def.version, action: "create", after: { ...final, state: row.state }, rules: plan.trace });
        await openInterval(tx, { object, recordId: row.id, state: row.state, by: user.id, action: "create", dims: dimsOf(def.body, final) });
        await triggers?.enqueue(tx, { object, event: "create", id: row.id, by: user.id, origin: self?.origin });
        return row;
    }
    // A change that waits for approval (§28): checked like the write it asks for (above), then kept as a
    // request; a dry run (an import's preview) says it would wait.
    async function asRequest(self, user, key, spec) {
        if (self?.dryRun) return { $dryRun: true, $approval: true };
        return approvals.request(self, user, { ...spec, key });
    }

    const services = {
        // ---- metadata ----
        async "defs.list"({ as } = {}) {
            const user = await requireViewer(this, as);
            const out = [];
            for (const def of await store.allDefinitions()) {
                const roles = await store.rolesFor(user.id, def.body.object);
                if (!roles.length) continue; // deny by default: an object nobody gave you is not listed
                out.push({ object: def.body.object, label: def.body.label, area: def.body.area, description: def.body.description ?? "" });
            }
            return out;
        },
        async "defs.get"({ object, as } = {}) {
            const user = await requireViewer(this, as);
            const def = await definitionOf(object);
            if (!(await store.rolesFor(user.id, object)).length) fail("Unknown object.", { status: 404 });
            return publicDefinition(def);
        },

        // ---- reads ----
        // The records in use (`archived: true`: the archived ones). Without `page`: the 200 changed last
        // (what a pick-list and the New form need). With `page` (the object's list, §10.1, drawn as the
        // person scrolls): 50 a page, and whether there are `more`; as they changed last, or sorted by a
        // field (list.sort, sort.js), and filtered by `q` over what the user may read (a reference by
        // its title). The database pages, sorts and filters over every record, the person's rights
        // compiled in (record-sql.js); page 1 of a sorted or filtered list also says the `total`.
        // With `where` (fields equal to values, as a service's ctx.records.list asks): the 200 changed last
        // among every record in use that matches, found in the database.
        async "records.list"({ object, as, archived = false, page, q = "", where: equal = undefined } = {}) {
            const user = await requireViewer(this, as);
            const def = await definitionOf(object);
            const actor = await actorFor(user, object);
            const creating = decide(def.body, actor, { state: def.body.states.initial });
            // What a new record may be given, for the "New" form (the server checks again on create).
            const createPerm = creating.create ? { fields: creating.fields, why: creating.why } : null;
            const where = `object = $1 AND archived_at IS ${archived === true ? "NOT NULL" : "NULL"}`;
            const seen = (rows) => rows.map((row) => mask(def.body, actor, rowOut(row))).filter(Boolean);
            const titled = async (rows) => (await withTitles(def.body, user, rows)).map((r) => ({ ...r, $title: r[def.body.titleField] ?? null }));
            const rights = rightsSql(def.body, actor);
            const mine = rights ? `${where} AND ${rights.read}` : where;
            let rowsOut;
            let more = {};
            if (isPlain(equal) && Object.keys(equal).length) {
                const w = recordWhere(object, equal);
                if (!w) fail("where names fields: lower case letters, digits and _.");
                // Only on fields the person may read: a hidden field's value is never probed by a filter.
                const fieldsOf = Object.keys(equal).filter((k) => !["state", "type", "id"].includes(k));
                const readable = rights ? fieldsOf.map((k) => (def.body.fields[k] ? rights.field(k) : "false")).map((c) => ` AND ${c}`).join("") : "";
                const rows = await reader.query(`SELECT r.* FROM mes.records r WHERE ${w.sql}${rights ? ` AND ${rights.read}` : ""}${readable} ORDER BY r.updated_at DESC, r.id LIMIT 200`, w.params);
                rowsOut = await titled(seen(rows).filter((r) => fieldsOf.every((k) => r.$perm.fields[k])));
            } else if (!(Number.isInteger(page) && page >= 1 && page <= 1_000_000)) {
                rowsOut = await titled(seen(await reader.query(`SELECT r.* FROM mes.records r WHERE ${mine} ORDER BY r.updated_at DESC, r.id LIMIT 200`, [object])));
            } else {
                const needle = typeof q === "string" ? q.trim().toLowerCase() : "";
                const sort = def.body.list?.sort?.field && (def.body.list.sort.field === "state" || def.body.fields[def.body.list.sort.field]) ? def.body.list.sort : null;
                const upTo = page * LIST_PAGE;
                if (rights) {
                    const params = [object];
                    const param = (v) => `$${params.push(v)}`;
                    let filter = "";
                    if (needle) {
                        // A reference matches by its title: the records it may name whose title, as this
                        // person reads it, holds the words (at most 2 000 of each object).
                        const refs = {};
                        for (const [name, f] of Object.entries(def.body.fields)) {
                            if (f.type !== "ref" || rights.field(name) === "false") continue;
                            const target = await store.definition(f.to);
                            const tr = target && rightsSql(target.body, await actorFor(user, f.to), "t");
                            if (!tr) continue;
                            const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
                            // The title is in the record's JSON text (the trigram index finds it there), or
                            // is the start of its id when it has none the person may read.
                            const quick = /["\\\u0000-\u001f]/.test(needle) ? "" : /^[0-9a-f-]{1,8}$/.test(needle) ? `(t.data::text ILIKE $2 OR left(t.id::text, 8) ILIKE $2) AND ` : "t.data::text ILIKE $2 AND ";
                            refs[name] = (await reader.query(`SELECT t.id::text AS id FROM mes.records t WHERE t.object = $1 AND ${quick}${tr.read} AND ${titleSql(target.body, tr, "t")} ILIKE $2 LIMIT 2000`, [f.to, like])).map((r) => r.id);
                        }
                        filter = ` AND ${searchSql(def.body, rights, needle, param, { refs })}`;
                    }
                    // A reference sorts by its title, as the person reads it.
                    let order = "r.updated_at DESC, r.id";
                    if (sort) {
                        const f = def.body.fields[sort.field];
                        const target = f?.type === "ref" ? await store.definition(f.to) : null;
                        const tr = target && rightsSql(target.body, await actorFor(user, f.to), "t");
                        order = orderSql(def.body, rights, sort, tr ? `(SELECT ${titleSql(target.body, tr, "t")} FROM mes.records t WHERE t.object = ${param(f.to)} AND t.id = ${column(sort.field, f)} AND ${tr.read})` : null);
                    }
                    const rows = await reader.query(`SELECT r.* FROM mes.records r WHERE ${mine}${filter} ORDER BY ${order} LIMIT ${LIST_PAGE + 1} OFFSET ${upTo - LIST_PAGE}`, params);
                    rowsOut = await titled(seen(rows.slice(0, LIST_PAGE)));
                    const hasMore = rows.length > LIST_PAGE;
                    // How many in all: counted once, on page 1 of a sorted or filtered list (the pager reads it
                    // there); otherwise known once the last page is reached.
                    let total = hasMore ? null : upTo - LIST_PAGE + rows.length;
                    if (hasMore && page === 1 && (needle || sort)) total = Number((await reader.query(`SELECT count(*) AS n FROM mes.records r WHERE ${mine}${filter}`, params))[0].n);
                    more = { page, size: LIST_PAGE, more: hasMore, total, capped: false };
                } else if (!needle && !sort) {
                    // Changed last first: read in growing steps until the page is full (and one more
                    // row says whether there are more), never more than needed.
                    let limit = Math.min(LIST_SCAN, Math.max(100, (upTo + 1) * 2));
                    let visible;
                    let exhausted;
                    for (;;) {
                        const rows = await reader.query(`SELECT * FROM mes.records WHERE ${where} ORDER BY updated_at DESC, id LIMIT ${limit}`, [object]);
                        visible = seen(rows);
                        exhausted = rows.length < limit;
                        if (visible.length > upTo || exhausted || limit >= LIST_SCAN) break;
                        limit = Math.min(LIST_SCAN, limit * 4);
                    }
                    rowsOut = await titled(visible.slice(upTo - LIST_PAGE, upTo));
                    more = { page, size: LIST_PAGE, more: visible.length > upTo, total: exhausted ? visible.length : null, capped: !exhausted && visible.length <= upTo };
                } else {
                    const rows = await reader.query(`SELECT * FROM mes.records WHERE ${where} ORDER BY updated_at DESC LIMIT ${LIST_SCAN}`, [object]);
                    let all = await titled(seen(rows));
                    // Filter on what the user may read: field values (a reference by its title) and the state.
                    if (needle) all = all.filter((r) => [r.state, ...Object.keys(def.body.fields).map((f) => (def.body.fields[f].type === "ref" ? r.$titles?.[f] : r[f]))].some((v) => v !== undefined && v !== null && String(Array.isArray(v) ? v.join(", ") : v).toLowerCase().includes(needle)));
                    if (sort) all = sortRows(all, (r) => (sort.field === "state" ? r.state : def.body.fields[sort.field]?.type === "ref" ? r.$titles?.[sort.field] : r[sort.field]), sort.dir ?? "asc");
                    rowsOut = all.slice(upTo - LIST_PAGE, upTo);
                    more = { page, size: LIST_PAGE, more: all.length > upTo, total: all.length, capped: rows.length >= LIST_SCAN };
                }
            }
            // One leaf that moves whenever any row does: a reader of the list follows it (Juris wakes
            // readers of the path written, not of its parents).
            const stamp = sha256(`${more.page ?? ""}/${more.total ?? ""}/${more.more ?? ""}|${rowsOut.map((r) => `${r.id}:${r.row_version}:${r.state}`).join("|")}`).slice(0, 16);
            return { rows: rowsOut, stamp, canCreate: creating.create, createPerm, ...more };
        },
        async "records.get"({ object, id, as } = {}) {
            const user = await requireViewer(this, as);
            const def = await definitionOf(object);
            const actor = await actorFor(user, object);
            const row = await loadRow(reader, object, id);
            const masked = row ? mask(def.body, actor, rowOut(row)) : null;
            return masked ? { ...(await withTitles(def.body, user, [masked]))[0], $title: masked[def.body.titleField] ?? null } : null;
        },
        // A record by its title field's value, as a scanner reads it off a label ("4711"): the newest one
        // in use the user may see, or null.
        async "records.lookup"({ object, key } = {}) {
            const user = await requireViewer(this);
            const def = await definitionOf(object);
            const text = typeof key === "string" ? key.trim() : "";
            if (!text || text.length > 200 || !def.body.titleField) return null;
            const actor = await actorFor(user, object);
            const params = [object, def.body.titleField, text];
            const quick = containment(def.body.titleField, [text], (v) => `$${params.push(v)}`);
            const rights = rightsSql(def.body, actor);
            const rows = await reader.query(`SELECT r.* FROM mes.records r WHERE object = $1 AND data->>$2 = $3 AND archived_at IS NULL${quick ? ` AND ${quick}` : ""}${rights ? ` AND ${rights.read}` : ""} ORDER BY updated_at DESC LIMIT 5`, params);
            for (const row of rows) {
                const seen = mask(def.body, actor, rowOut(row));
                // Found by its title, so only for who may read the title: else this would say whether a
                // hidden title is the text asked for.
                if (seen && seen.$perm.fields[def.body.titleField]) return { id: row.id, title: seen[def.body.titleField] ?? text, state: row.state };
            }
            return null;
        },
        async "records.history"({ object, id } = {}) {
            const user = await requireViewer(this);
            const def = await definitionOf(object);
            const actor = await actorFor(user, object);
            const row = await loadRow(reader, object, id);
            const masked = row && mask(def.body, actor, rowOut(row));
            if (!masked) fail("Not found.", { status: 404 });
            const readable = new Set(Object.entries(masked.$perm.fields).filter(([, level]) => level).map(([name]) => name));
            const only = (values) => values && Object.fromEntries(Object.entries(values).filter(([name]) => readable.has(name) || ["state", "archived_at", "archived_by"].includes(name)));
            const rows = await reader.query("SELECT seq, at, actor, action, before, after, rules FROM mes.audit_log WHERE object = $1 AND record_id = $2 ORDER BY seq DESC LIMIT 100", [object, id]);
            // A change waiting for approval (§28): what was asked (the values this person may read), why,
            // and each signature and outcome.
            const asked = (a) => a && { ...Object.fromEntries(["request", "action", "reason", "route", "department", "step", "meaning", "note", "outcome", "signed"].filter((k) => a[k] !== undefined).map((k) => [k, a[k]])), ...(a.values ? { values: only(a.values) } : {}) };
            const out = rows.map((r) => ({ seq: Number(r.seq), at: iso(r.at), actor: r.actor, action: r.action, before: only(r.before), after: r.action.startsWith("request:") ? asked(r.after) : only(r.after), rules: r.rules }));
            // A reference by what people call it, never its id (§34.9): as this person may read it.
            const ids = out.flatMap((r) => [r.before, r.after, r.after?.values].flatMap((v) => (v ? Object.values(v) : []))).filter((v) => typeof v === "string" && ID.test(v));
            if (!ids.length) return out;
            const names = await createTitles({ store, records: { internals } }).titlesOf(user, ids);
            const shown = (v) => v && Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" && ID.test(x) ? names.get(x.toLowerCase()) ?? "—" : k === "values" ? shown(x) : x]));
            return out.map((r) => ({ ...r, before: shown(r.before), after: shown(r.after) }));
        },

        // Search across every object the user may read (§10.1). A hit counts only on a field the
        // user may read, so a search never reveals what a hidden field holds. Each hit says where it
        // stands at a glance: its state (with its tone, when it has a lifecycle), and the first fields of
        // its object's list the person may read (a reference by its title), typed for the page to show
        // in the plant's formats; and what matched, when it is not the title already shown.
        async "records.search"({ q } = {}) {
            const user = await requireViewer(this);
            const text = typeof q === "string" ? q.trim() : "";
            if (text.length < 2 || text.length > 100) return [];
            const needle = text.toLowerCase();
            const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
            const out = [];
            for (const def of await store.allDefinitions()) {
                const object = def.body.object;
                if (!(await store.rolesFor(user.id, object)).length) continue;
                const actor = await actorFor(user, object);
                // In the database, the person's rights compiled in (record-sql.js): only what they may
                // read matches. Otherwise, any value matches, and the rows are decided here.
                const rights = rightsSql(def.body, actor);
                const params = [object];
                const rows = rights
                    ? await reader.query(`SELECT r.* FROM mes.records r WHERE object = $1 AND ${rights.read} AND ${searchSql(def.body, rights, text, (v) => `$${params.push(v)}`, { joiner: "," })} ORDER BY updated_at DESC LIMIT 25`, params)
                    : await reader.query(
                        `SELECT * FROM mes.records WHERE object = $1
                         AND (EXISTS (SELECT 1 FROM jsonb_each_text(data) v WHERE v.value ILIKE $2) OR state ILIKE $2)
                         ORDER BY updated_at DESC LIMIT 25`,
                        [object, like],
                    );
                const hits = [];
                for (const row of rows) {
                    const seen = mask(def.body, actor, rowOut(row));
                    if (!seen) continue;
                    const readable = Object.keys(def.body.fields).filter((name) => seen.$perm.fields[name]);
                    const field = readable.find((name) => String(seen[name] ?? "").toLowerCase().includes(needle));
                    if (!field && !seen.state.toLowerCase().includes(needle)) continue;
                    hits.push({ seen, row, field });
                    if (hits.length >= 8) break;
                }
                if (!hits.length) continue;
                const titled = await withTitles(def.body, user, hits.map((h) => h.seen));
                const states = def.body.states ?? {};
                const lifecycle = (states.list?.length ?? 0) > 1 || (states.transitions ?? []).length > 0;
                const columns = (def.body.list?.columns ?? Object.keys(def.body.fields).slice(0, 5)).filter((c) => c !== def.body.titleField && def.body.fields[c]);
                hits.forEach(({ seen, row, field }, i) => {
                    const details = [];
                    for (const c of columns) {
                        const v = seen[c];
                        if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
                        const f = def.body.fields[c];
                        details.push({ label: f.label ?? c, type: f.type, value: f.type === "ref" ? titled[i].$titles?.[c] ?? null : v });
                        if (details.length >= 3) break;
                    }
                    out.push({
                        object, label: def.body.label, id: row.id, title: seen[def.body.titleField] ?? row.id.slice(0, 8), state: seen.state, archived: Boolean(row.archived_at),
                        ...(lifecycle ? { tone: states.tones?.[seen.state] ?? null } : { tone: null, list: true }),
                        details: details.filter((d) => d.value !== null),
                        match: field ? { field: def.body.fields[field].label ?? field, value: String(seen[field]), type: def.body.fields[field].type, title: field === def.body.titleField } : { field: "State", value: seen.state, title: false },
                    });
                });
            }
            return out;
        },

        // ---- writes (§11.4) ----
        // `reason`: why, when the change waits for approval (§28); asked for then, and only then.
        async "records.create"({ object, data, key, reason } = {}) {
            const user = await requireViewer(this);
            const def = await definitionOf(object);
            const done = await remembered(key, user);
            if (done !== undefined) return done;
            guardManaged(def, "create", data ?? {});
            const plan = await planCreate(this, user, def, data);
            if (approvals && asPerson(this) && needsApproval(def.body, { op: "create" })) return asRequest(this, user, key, { op: "create", def, data: plan.given, changed: Object.keys(plan.given).filter((n) => plan.given[n] !== null && plan.given[n] !== ""), reason });
            // A dry run (§15.2): every check above ran, the rule pipe included; nothing is written.
            if (this?.dryRun) return { ...plan.final, id: crypto.randomUUID(), state: def.body.states.initial, row_version: 1, $dryRun: true };
            const created = await db.transaction(async (tx) => {
                const row = await applyCreate(tx, this, user, plan);
                const result = mask(def.body, plan.actor, rowOut(row));
                await remember(tx, key, user, result);
                return { result, id: row.id };
            });
            // Committed: a traveler made by its form starts its route (§32.5).
            if (afterCreate) await afterCreate({ object, id: created.id, user }).catch((e) => log.error?.("after a create", e));
            return created.result;
        },

        // A write holds its transaction only to lock the row, confirm nobody changed it since the
        // checks ran (row_version), and write. Everything slow or that needs a connection of its own
        // (the rule pipe and its lookups, the audit of a refusal) runs before, on the row as read: a
        // transaction that waited on a second connection from the same pool deadlocked the pool
        // under load (more writes in flight than connections, each holding one and waiting for one).
        async "records.update"({ object, id, rowVersion, data, key, reason } = {}) {
            const user = await requireViewer(this);
            const def = await definitionOf(object);
            const done = await remembered(key, user);
            if (done !== undefined) return done;
            const given = pickFields(def.body, data);
            const row = await loadRow(db, object, id);
            if (!row) fail("Not found.", { status: 404 });
            if (Number(row.row_version) !== rowVersion) fail(STALE, { status: 409, code: "stale" });
            guardManaged(def, "update", given, row);
            const plan = await planUpdate(this, user, def, row, given);
            if (!plan) return mask(def.body, await actorFor(user, object), rowOut(row));
            // What the person changed (not what the rule pipe then set): what waits, if it must.
            const asked = changedBetween(row.data, { ...row.data, ...given });
            if (approvals && asPerson(this) && needsApproval(def.body, { op: "edit", state: row.state, changed: asked })) return asRequest(this, user, key, { op: "edit", def, row, data: Object.fromEntries(asked.map((n) => [n, given[n]])), changed: asked, reason });
            if (this?.dryRun) return { ...mask(def.body, plan.actor, rowOut({ ...row, data: plan.final, row_version: Number(row.row_version) + 1 })), $dryRun: true };
            const result = await db.transaction(async (tx) => {
                const locked = await loadRow(tx, object, id, true);
                if (!locked || Number(locked.row_version) !== rowVersion) fail(STALE, { status: 409, code: "stale" });
                const updated = await applyUpdate(tx, this, user, plan);
                const result = mask(def.body, plan.actor, rowOut(updated));
                await remember(tx, key, user, result);
                return result;
            });
            // Committed: a traveler whose step was moved by hand moves its route (§32.5).
            if (afterWrite) await afterWrite({ object, id, user }).catch((e) => log.error?.("after a write", e));
            return result;
        },

        async "records.action"({ object, id, action, rowVersion, key, reason } = {}) {
            const user = await requireViewer(this);
            const def = await definitionOf(object);
            const done = await remembered(key, user);
            if (done !== undefined) return done;
            const row = await loadRow(db, object, id);
            if (!row) fail("Not found.", { status: 404 });
            if (Number(row.row_version) !== rowVersion) fail(STALE, { status: 409, code: "stale" });
            const plan = await planAction(this, user, def, row, action);
            if (approvals && asPerson(this) && needsApproval(def.body, { op: "action", state: row.state, action })) return asRequest(this, user, key, { op: "action", def, row, action, reason });
            if (this?.dryRun) return { ...mask(def.body, plan.actor, rowOut({ ...row, state: plan.transition.to, row_version: Number(row.row_version) + 1 })), $dryRun: true };
            const result = await db.transaction(async (tx) => {
                const locked = await loadRow(tx, object, id, true);
                if (!locked || Number(locked.row_version) !== rowVersion) fail(STALE, { status: 409, code: "stale" });
                const updated = await applyAction(tx, this, user, plan);
                const result = mask(def.body, plan.actor, rowOut(updated));
                await remember(tx, key, user, result);
                return result;
            });
            if (afterWrite) await afterWrite({ object, id, user }).catch((e) => log.error?.("after a write", e));
            return result;
        },

        // Archiving takes a record out of use without deleting it (Part 11): out of the lists,
        // read-only, kept with its audit trail. Restoring puts it back. Both are writes in the
        // shape above, and the object's rule pipe runs on them as on an action (event.kind
        // "archive" or "restore", nothing changed): a script throws to refuse. As with an action,
        // the pipe decides whether, not what: fields its scripts would set are not written.
        async "records.archive"(args = {}) { return setArchived.call(this, args, true); },
        async "records.restore"(args = {}) { return setArchived.call(this, args, false); },

        // ---- transparency (§9.7) ----
        async "access.explain"({ object, id, field, action, op, archive } = {}) {
            const user = await requireViewer(this);
            const def = await definitionOf(object);
            const actor = await actorFor(user, object);
            const row = id ? await loadRow(reader, object, id) : null;
            // A record named but not found (or not an id at all) is not "a new one".
            if (id && !row) fail("Not found.", { status: 404 });
            const record = row ? recordOf(row) : { state: def.body.states.initial };
            if (row && !decide(def.body, actor, record).read) fail("Not found.", { status: 404 });
            if (field !== undefined && !Object.hasOwn(def.body.fields, field)) fail("Unknown field.");
            if (action !== undefined && !def.body.states.transitions.some((t) => t.action === action)) fail("Unknown action.");
            if ([field, action, archive === true ? true : undefined].filter((t) => t !== undefined).length !== 1) fail("Say one field, one action, or archive.");
            const target = archive === true ? { archive: true } : action !== undefined ? { action } : { field, op: op === "read" ? "read" : "write" };
            const trace = explainDecision(def.body, actor, record, target);
            // The user's last refused change to this record in the past 10 minutes, from the audit trail.
            const [refused] = await db.query(
                `SELECT after FROM mes.audit_log WHERE actor = $1 AND object = $2 AND record_id IS NOT DISTINCT FROM $3::uuid
                 AND action LIKE 'rejected:%' AND at > now() - interval '10 minutes' ORDER BY seq DESC LIMIT 1`,
                [user.id, object, id ?? null],
            );
            const rejection = refused?.after?.rejection;
            if (rejection) {
                trace.because.push({ source: "rule", detail: `rule \`${rejection.script}\` (v${rejection.version}) refused your last change: ${rejection.message}` });
            }
            return trace;
        },

        // The published scripts of an object's pipe, for the browser's advice run (§12.4).
        async "rules.scripts"({ object } = {}) {
            const user = await requireViewer(this);
            const def = await definitionOf(object);
            if (!(await store.rolesFor(user.id, object)).length) fail("Unknown object.", { status: 404 });
            const scripts = await store.scripts();
            const out = {};
            for (const entry of def.body.rules ?? []) {
                if (entry.backendOnly || entry.committed) continue;
                const script = scripts.get(entry.script);
                if (script) out[entry.script] = { version: script.version, source: script.source };
            }
            return out;
        },

        // ---- personal preferences (§10.1): not design changes ----
        async "prefs.get"({ as } = {}) {
            const user = await requireViewer(this, as);
            const [row] = await reader.query("SELECT prefs FROM mes.user_prefs WHERE user_id = $1", [user.id]);
            return { favorites: [], tabs: [], ...(row?.prefs ?? {}) };
        },
        async "prefs.set"({ favorites, tabs, scheme } = {}) {
            const user = await requireViewer(this);
            const next = {};
            // Light, dark, or the device's own (§10.8); the plant's theme may decide for everyone instead.
            if (scheme !== undefined) {
                if (!PERSONAL.includes(scheme)) fail(`A colour scheme is ${PERSONAL.join(", ")}.`);
                next.scheme = scheme;
            }
            if (favorites !== undefined) {
                // An object by its name; a screen or a transaction as "screen:<name>", "transaction:<name>" (§10.1).
                const okFav = (f) => typeof f === "string" && IDENTIFIER.test(f.replace(/^(screen|transaction|layout):/, ""));
                if (!Array.isArray(favorites) || favorites.length > 100 || !favorites.every(okFav)) fail("Favorites are objects by name, and screens, transactions and report layouts as screen:<name>, transaction:<name> or layout:<name>, at most 100.");
                next.favorites = [...new Set(favorites)];
            }
            if (tabs !== undefined) {
                const okTab = (t) => isPlain(t) && typeof t.path === "string" && t.path.startsWith("/") && !t.path.startsWith("//") && t.path.length < 300 && typeof t.title === "string" && t.title.length < 200;
                if (!Array.isArray(tabs) || tabs.length > 20 || !tabs.every(okTab)) fail("Tabs are { path, title }, at most 20.");
                next.tabs = tabs.map(({ path, title }) => ({ path, title }));
            }
            await db.query(
                `INSERT INTO mes.user_prefs (user_id, prefs) VALUES ($1, $2)
                 ON CONFLICT (user_id) DO UPDATE SET prefs = mes.user_prefs.prefs || EXCLUDED.prefs`,
                [user.id, JSON.stringify(next)],
            );
            return { ok: true };
        },
    };

    // What each service changes (Juris live.touches): targets are data, so they would cross a bus.
    // A screen (§26) may show any object's records: every write re-runs the open screens.
    // A change that waits for approval (§28) shows on its record and on the approvals list instead.
    const recordTargets = ({ object, id } = {}, result) => [
        { name: "records.list", where: { object } },
        { name: "records.get", where: { object, id: id ?? result?.id } },
        { name: "screens.data" },
        { name: "popups.for" },
        { name: "flows.runOf" }, { name: "flows.plansOf" }, { name: "flows.task" }, { name: "inbox.mine" },
        // A write to a record a request waits on makes that request void (its base moved): its banner says so.
        { name: "requests.ofRecord", where: { object, id: id ?? result?.id ?? null } },
        ...(result?.$request ? [{ name: "requests.list" }, { name: "inbox.mine" }] : []),
    ];
    const touches = {
        "records.create": recordTargets,
        "records.update": recordTargets,
        "records.action": recordTargets,
        "records.archive": recordTargets,
        "records.restore": recordTargets,
        "prefs.set": async function () {
            const user = await store.userForSession(this?.sessionId);
            return user ? [{ name: "prefs.get", where: { as: user.id } }] : [];
        },
        "records.history": [],
        "records.lookup": [],
        "records.search": [],
        "access.explain": [],
        "rules.scripts": [],
    };

    // A live subscription names its viewer (`as`); only that viewer's own session may hold it.
    async function authorize(name, [args], info) {
        const user = await store.userForSession(this?.sessionId);
        return Boolean(user && isPlain(args) && args.as === user.id);
    }

    // What a transaction (transactions.js) builds on: the same checks and writes as the services above.
    const internals = { requireViewer, definitionOf, loadRow, recordOf, rowOut, actorFor, nounOf, withTitles, reader, planUpdate, applyUpdate, planAction, applyAction, planCreate, applyCreate, remembered, remember, pickFields, STALE };
    return { services, touches, recordTargets, authorize, internals, useApprovals: (a) => { approvals = a; }, useAfterCreate: (fn) => { afterCreate = fn; }, useAfterWrite: (fn) => { afterWrite = fn; }, queries: ["defs.list", "defs.get", "records.list", "records.get", "prefs.get"] };
}
