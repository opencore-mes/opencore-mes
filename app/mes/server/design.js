// The designer's services and the change lifecycle (DESIGN.md §5): design → review → approval →
// execution. Nothing here publishes a definition or a script except `execute`, which runs only for a
// change whose every required department has approved the exact content that was reviewed.
import { inputFlowSummary } from "../client/input-flow.js";
import { validateReportLayout, reportLayoutFootprint, LAYOUT_TEMPLATE } from "../client/report.js";
import { validateSuiteElement, suiteElementFootprint, SUITE_KIND } from "../client/definition.js";
import { fail } from "../../../src/errors.js";
import { callKind } from "../../../src/live-protocol.js";
import { validateDefinition, validateScript, validateService, validateConnection, validateTransaction, validateScreen, validateOrganization, organizationFootprint, applyStanding, retireProblems, retireFootprint, RETIRE_KINDS, footprint, scriptFootprint, integrationFootprint, transactionFootprint, screenFootprint, routeOf, IDENTIFIER, SERVICE_TEMPLATE, validateFlow, flowFootprint, FLOW_TEMPLATE, subFlowsOf, COPYABLE, copyDesign, copyScript, copiedScriptName } from "../client/definition.js";
import { isSuiteSchedule, suiteSettings } from "../client/schedule.js";
import { checkScript } from "./rules.js";
import { appendAudit, canonical, sha256 } from "./audit.js";
import { organizationSettings, organizationSnapshot, applyOrganization, stepsOf, draftOf } from "./organization.js";
import { packElements, packStatus, missingRoles } from "./packs.js";
import { CORE_LOCKS, mergeLocks, suiteLocks, liveLocks } from "../client/builtins.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPEN = ["design", "review", "approval"];
// What may be viewed without a change (design.view): the kind in the URL → where it is published.
const VIEW_KINDS = { object: "definitions", transaction: "transactions", screen: "screens", service: "services", connection: "connections", flow: "flows", layout: "layouts", element: "elements" };
// The objects a design relies on, by name, in the order met: an object's references, a transaction's
// inputs, created records and where it appears, a screen's parameter and blocks, a service's objects.
function reliesOn(K, body) {
    const out = [];
    const add = (o) => { if (typeof o === "string" && o && !out.includes(o)) out.push(o); };
    if (K === "definitions") for (const f of Object.values(body.fields ?? {})) if (f?.type === "ref") add(f.to);
    if (K === "transactions") {
        add(body.appearsOn?.object);
        for (const s of Object.values(body.inputs ?? {})) if (s?.type === "ref") add(s.to);
        for (const st of body.steps ?? []) add(st?.create);
    }
    if (K === "screens") {
        for (const p of Object.values(body.params ?? {})) if (p?.type === "ref") add(p.to);
        for (const b of body.blocks ?? []) add(b?.object);
    }
    if (K === "services") { for (const o of Object.keys(body.uses?.objects ?? {})) add(o); for (const t of body.on ?? []) add(t?.object); }
    if (K === "flows") for (const p of Object.values(body.participants ?? {})) add(p?.object);
    if (K === "layouts") { add(body.scope?.object); for (const b of body.blocks ?? []) add(b?.scope?.object); }
    return out;
}
// Governance, which approves a change nobody else stewards (§5.6), is the organization's to name.
const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// A change that is only a change to people & departments (the organization), nothing else in it.
const orgOnly = (content) => Object.entries(content ?? {}).every(([k, v]) => k === "organization" || !isPlain(v) || !Object.keys(v).length);
// A design's name: an identifier, and none of the names every object carries ("constructor",
// "toString"): looked up among the live designs, one of those answered a function, not "no such design".
const INHERITED = new Set([...Object.getOwnPropertyNames(Object.prototype), "__proto__", "prototype"]);
const named = (name) => typeof name === "string" && IDENTIFIER.test(name) && !INHERITED.has(name);

const iso = (value) => (value instanceof Date ? value.toISOString() : value);
// What a change may carry: objects' definitions, scripts, (§15.2) services and connections, (§5.9)
// each script's test cases, which the fitness test runs and which are published with it, (§25)
// transactions, and (§26) screens.
// (`elements`: design elements of a kind an installed suite adds, §30.11: one table for all of them.)
const KINDS = ["definitions", "scripts", "services", "connections", "tests", "transactions", "screens", "flows", "layouts", "elements"];
// The named design elements besides objects and scripts, as a change carries them and as published.
const ELEMENTS = ["connections", "services", "transactions", "screens", "flows", "layouts", "elements"];
// The organization (§5.6) is one document, not a map of named elements: carried when a change has it.
// So is what a change retires (§5.10): { kind: [names] }.
const withKinds = (value) => ({ ...Object.fromEntries(KINDS.map((k) => [k, { ...(value?.[k] ?? {}) }])), ...(value?.organization ? { organization: value.organization } : {}), ...(value?.retire ? { retire: value.retire } : {}), ...(value?.keeps ? { keeps: value.keeps } : {}) });

// The statement that turns a field's stored values into lists (toMultiple) or back into one value.
export const multipleConversion = (toMultiple) => (toMultiple
    ? `UPDATE mes.records SET data = jsonb_set(data, ARRAY[$2], jsonb_build_array(data->$2)), row_version = row_version + 1
       WHERE object = $1 AND data ? $2 AND jsonb_typeof(data->$2) NOT IN ('array', 'null') RETURNING id`
    : `UPDATE mes.records SET data = CASE WHEN jsonb_array_length(data->$2) = 0 THEN data - $2 ELSE jsonb_set(data, ARRAY[$2], data->$2->0) END, row_version = row_version + 1
       WHERE object = $1 AND jsonb_typeof(data->$2) = 'array' RETURNING id`);

// A new transaction (§25): nothing to enter, check or do yet, and nobody may run it (deny by default).
const TRANSACTION_TEMPLATE = (name, label, stewards) => ({
    name, label: label?.trim() || name, description: "",
    inputs: {}, require: [], steps: [], confirm: true,
    callers: { users: [], groups: [] }, stewards,
});

// A new screen (§26): a note to replace, and nobody may open it yet.
const SCREEN_TEMPLATE = (name, label, stewards) => ({
    name, label: label?.trim() || name, description: "", params: {},
    blocks: [{ block: "text", text: "Add blocks: tables, numbers, records, transactions.", width: 12 }],
    callers: { users: [], groups: [] }, stewards,
});

// `plantTz` is the plant's time zone: the designer shows a schedule's next runs in it.
export function createDesign({ store, log = console, plantTz = "UTC" }) {
    const { db } = store;
    // The fitness test (fitness.js), bound once what it runs on exists: (change row, user) → report.
    let fitness = null;
    // The installed suites' checks of their parts of a design (§29.4): suite → check(body, part, known).
    let suiteDesigns = {};
    // The installed suites' design packs (§29.6): suite → { suite (its label), label, version, … }.
    let suitePacks = {};
    // The installed suites' flow node kinds (§32.9): "<suite>.<kind>" → { label, extends, config, validate }.
    let suiteFlowNodes = {};
    // What else the installed suites add (§30.11), by name, for the checks and the designer:
    // capabilities (suite → what a service's script may ask of it), transaction step kinds and screen
    // block kinds ("<suite>.<kind>" → { label, config, required, validate }), and kinds of design element
    // of their own (`elements`: "<suite>.<kind>" → { label, validate(body, known), template(name), shared }),
    // and kinds of schedule a service may run on (`schedules`: "<suite>.<kind>" → { label, config, required,
    // validate(settings, known), runs, describe }).
    let suiteExtensions = { capabilities: {}, steps: {}, blocks: {}, elements: {}, schedules: {} };
    // Signatures (§7.4): who proves who they are at an approval, where the plant asks it (app.mjs sets it).
    let signatures = null;
    // What the platform and the installed suites lock (builtins.js): object → [lock], worked out from them, never stored.
    let allLocks = mergeLocks(CORE_LOCKS);
    let onFlows = null;

    async function viewerOf(self, as) {
        const kind = callKind(self);
        if (kind === "preload" || kind === "live") return store.user(as);
        // The AI design API (ai-api.js) calls as the token's person, with `via` naming the AI.
        if (kind === "direct" && self?.apiUser) return self.apiUser;
        if (kind === "direct") return store.userForSession(self?.sessionId);
        return null;
    }
    // What an AI changed in a draft, recorded on the change for its reviewers (§16.1).
    function aiEdit(self, before, after) {
        if (!self?.via) return null;
        const elements = [];
        for (const [object, body] of Object.entries(after.definitions ?? {})) {
            for (const e of footprint(before.definitions?.[object] ?? null, body)) elements.push(`${object}: ${e.element}`);
        }
        for (const [name, source] of Object.entries(after.scripts ?? {})) if (before.scripts?.[name] !== source) elements.push(`script: ${name}`);
        for (const kind of ["services", "connections", "tests", "transactions", "screens", "flows", "layouts", "elements"]) {
            for (const [name, body] of Object.entries(after[kind] ?? {})) if (JSON.stringify(before[kind]?.[name] ?? null) !== JSON.stringify(body)) elements.push(`${kind === "tests" ? "tests" : kind.slice(0, -1)}: ${name}`);
        }
        return elements.length ? { at: new Date().toISOString(), via: self.via, elements } : null;
    }
    // A person's part in the designer: their roles on it (designer, reviewer), and "approver" for
    // anyone who approves for a department (People & departments, §27), who opens the designer to read
    // and sign what waits for them without being given a role on it.
    async function designRolesOf(userId) {
        const roles = await store.rolesFor(userId, "design");
        const [rep] = await db.query("SELECT 1 FROM mes.department_reps r JOIN mes.users u ON u.id = r.user_id AND u.active WHERE r.user_id = $1 LIMIT 1", [userId]);
        return rep && !roles.includes("approver") ? [...roles, "approver"] : roles;
    }
    async function designUser(self, as) {
        const user = await viewerOf(self, as);
        if (!user) fail("Sign in first.", { status: 401 });
        const roles = await designRolesOf(user.id);
        if (!roles.length) fail("The designer is not shared with you.", { status: 403 });
        return { ...user, designRoles: roles, departments: await store.departmentsOf(user.id), reps: await repsOf(user.id) };
    }
    const repsOf = async (userId) => (await db.query("SELECT group_id FROM mes.department_reps WHERE user_id = $1 ORDER BY group_id", [userId])).map((r) => r.group_id);
    const governance = async (q = db) => (await organizationSettings(q)).governance ?? "engineering";
    // A change's authors (§5.3): who started it, and the co-designers they named. Each may edit it while
    // it is in design; none of them reviews or approves it.
    const authorsOf = (row) => [...new Set([row.author, ...(row.co_designers ?? []), ...(row.contributors ?? [])])];
    // Who may edit and submit it now: its author and the co-designers named now. Everyone who ever
    // designed it (`contributors`: named once, or saved it) stays an author above, so taking a
    // co-designer off the list never makes them its reviewer or approver.
    const editorsOf = (row) => [row.author, ...(row.co_designers ?? [])];
    // Saving makes the person one who designed it, for good (contributors), and every save of the draft
    // is audited with the version it made, so the change's history says who edited it and when, not
    // only who saved it last.
    const CONTRIBUTE = "ARRAY(SELECT DISTINCT u FROM unnest(contributors || ARRAY[$7::text]) AS u ORDER BY u)";
    const saved = (tx, id, userId, rev, extra = {}) => audit(tx, userId, id, "change:save", { draft_rev: rev, ...extra });
    // Why this person may not review or approve it, in words.
    const designedBy = (row, userId, act) => (row.author === userId
        ? `An author does not ${act} their own change.`
        : (row.co_designers ?? []).includes(userId)
            ? `A co-designer does not ${act} a change they designed.`
            : `You designed part of this change (as a co-designer, or by saving it), so you do not ${act} it.`);
    // A department's approval of one change, step by step (§5.6): each step is signed by one of its
    // approvers, never one of its authors, never the reviewer, never someone who signed an earlier step.
    //   → { steps: [{ step, label, approvers, signed, eligible }], current, done, rejected }
    async function progressOf(q, row, department, approvals, settings) {
        const authors = authorsOf(row);
        const mine = approvals.filter((a) => a.department === department);
        const signers = mine.map((a) => a.user_id);
        const steps = (await stepsOf(q, department, settings)).map((st) => ({
            ...st, signed: mine.find((a) => a.step === st.step) ?? null,
            eligible: st.approvers.filter((u) => !authors.includes(u) && u !== row.reviewer && !signers.includes(u)),
        }));
        const rejected = mine.find((a) => a.decision === "reject") ?? null;
        const current = rejected ? null : steps.find((st) => !st.signed) ?? null;
        return { steps, current, done: !rejected && !current && steps.length > 0, rejected };
    }
    // Who may review a change and still leave every step of its route signable, in words.
    async function reviewersInstead(q, row, not) {
        const authors = authorsOf(row);
        const candidates = (await q.query("SELECT DISTINCT a.subject_id FROM mes.assignments a JOIN mes.users u ON u.id = a.subject_id AND u.active WHERE a.object = 'design' AND a.subject_kind = 'user' AND a.role IN ('reviewer', 'designer') AND a.subject_id <> $1 AND NOT (a.subject_id = ANY($2)) ORDER BY a.subject_id", [not, authors])).map((r) => r.subject_id);
        const fine = [];
        for (const u of candidates) if (!(await unsignable(row.route, { authors, reviewer: u })).length) fine.push(u);
        return fine.length ? `Ask ${fine.join(" or ")} to review it instead.` : "Nobody else could review it without the same problem: its departments need more approvers (People & departments), or the author withdraws it.";
    }
    // Who could review a change on this route, worked out before anyone does (§5.6): those whose review
    // leaves someone to sign every step (`fine`), those whose review would not (`strands`: each with the
    // steps nobody could then sign), and the departments nobody can approve for whoever reviews (`empty`).
    // `authors`: the change's author and co-designers, none of whom reviews or approves it.
    async function reviewOptions(route, authors) {
        const candidates = (await db.query("SELECT DISTINCT a.subject_id FROM mes.assignments a JOIN mes.users u ON u.id = a.subject_id AND u.active WHERE a.object = 'design' AND a.subject_kind = 'user' AND a.role IN ('reviewer', 'designer') AND NOT (a.subject_id = ANY($1)) ORDER BY a.subject_id", [authors])).map((r) => r.subject_id);
        const fine = [], strands = [];
        let empty = [];
        for (const u of candidates) {
            const stuck = await unsignable(route, { authors, reviewer: u });
            empty = stuck.filter((x) => x.none).map((x) => x.where);
            const where = stuck.filter((x) => !x.none).map((x) => x.where);
            if (!stuck.length) fine.push(u); else if (where.length) strands.push({ reviewer: u, where });
        }
        if (!candidates.length) empty = (await unsignable(route, { authors, reviewer: null })).filter((x) => x.none).map((x) => x.where);
        return { fine, strands, empty };
    }
    // What waits for whom (§5.3): per person, the changes they may review now, and those whose current
    // step of a department they may sign now (the next approvers). For the sign-in list.
    //   → { [userId]: { review: [{ id, title }], sign: [{ id, title, department, step }] } }
    async function waitingFor() {
        const settings = await organizationSettings(db);
        const out = {};
        const of = (u) => (out[u] ??= { review: [], sign: [] });
        for (const row of await db.query("SELECT * FROM mes.change_requests WHERE state IN ('review', 'approval') ORDER BY submitted_at")) {
            if (row.state === "review") {
                for (const u of (await reviewOptions(row.route, authorsOf(row))).fine) of(u).review.push({ id: row.id, title: row.title });
                continue;
            }
            const approvals = await db.query("SELECT department, step, user_id, decision FROM mes.approvals WHERE change_id = $1", [row.id]);
            for (const r of row.route ?? []) {
                const p = await progressOf(db, row, r.department, approvals, settings);
                for (const u of p.current?.eligible ?? []) of(u).sign.push({ id: row.id, title: row.title, department: r.department, step: p.steps.length > 1 ? p.current.label : null });
            }
        }
        return out;
    }
    // The steps of a route that nobody could sign if `reviewer` reviewed it: ["engineering (Approver)"].
    async function unsignable(route, { authors, reviewer }) {
        const settings = await organizationSettings(db);
        const out = [];
        for (const r of route ?? []) {
            const steps = await stepsOf(db, r.department, settings);
            if (!steps.length) { out.push({ where: r.department, none: true }); continue; }
            for (const st of steps) if (!st.approvers.some((u) => !authors.includes(u) && u !== reviewer)) out.push({ where: steps.length > 1 ? `${r.department} (${st.label})` : r.department, department: r.department, none: false });
        }
        return out;
    }

    async function departments() {
        return (await db.query("SELECT id, name FROM mes.groups WHERE kind = 'department' ORDER BY id"));
    }
    // The department whose name is the area's, else the author's own, else governance.
    async function stewardForArea(area, user) {
        const match = (await departments()).find((d) => d.name.toLowerCase() === String(area).toLowerCase());
        return match?.id ?? user.departments[0] ?? (await governance());
    }
    async function published() {
        const defs = await db.query("SELECT object, version, body FROM mes.definitions WHERE status = 'published' ORDER BY object");
        const scripts = await db.query("SELECT name, version, source, tests FROM mes.scripts WHERE status = 'published' ORDER BY name");
        const named = async (table) => Object.fromEntries((await db.query(`SELECT name, version, body FROM mes.${table} WHERE status = 'published' ORDER BY name`)).map((r) => [r.name, { version: r.version, body: r.body }]));
        return {
            definitions: Object.fromEntries(defs.map((d) => [d.object, { version: d.version, body: d.body }])),
            scripts: Object.fromEntries(scripts.map((s) => [s.name, { version: s.version, source: s.source, tests: s.tests ?? [] }])),
            services: await named("services"),
            connections: await named("connections"),
            transactions: await named("transactions"),
            screens: await named("screens"),
            flows: await named("flows"),
            layouts: await named("layouts"),
            elements: await named("elements"),
            organization: await organizationSnapshot(db),
        };
    }
    async function loadChange(q, id, lock = false) {
        if (typeof id !== "string" || !UUID.test(id)) fail("Not found.", { status: 404 });
        const [row] = await q.query(`SELECT * FROM mes.change_requests WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
        if (!row) fail("Not found.", { status: 404 });
        return row;
    }

    // Everything a change's content must pass, against what is live plus the change itself.
    async function problemsOf(content) {
        const live = await published();
        // The locks that hold now: on what is live (builtins.js).
        const locks = liveLocks(allLocks, Object.fromEntries(Object.entries(live.definitions).map(([k, v]) => [k, v.body])));
        const objects = [...new Set([...Object.keys(live.definitions), ...Object.keys(content.definitions ?? {})])];
        const scripts = [...new Set([...Object.keys(live.scripts), ...Object.keys(content.scripts ?? {})])];
        // A change to the organization names the departments there will be.
        const depts = content.organization ? Object.keys(content.organization.departments ?? {}) : (await departments()).map((d) => d.id);
        const transactions = [...new Set([...Object.keys(live.transactions), ...Object.keys(content.transactions ?? {})])];
        const problems = [];
        for (const [object, body] of Object.entries(content.definitions ?? {})) {
            if (body?.object !== object) problems.push({ path: `${object}.object`, message: `The definition's name must stay "${object}".` });
            for (const p of validateDefinition(body, { objects, scripts, departments: depts, transactions, suiteDesigns, locks, live: live.definitions[object]?.body ?? null })) problems.push({ ...p, path: `${object}.${p.path}` });
            // §6.4: a field removed or retyped while records hold it needs a migration, which the POC has not.
            const before = live.definitions[object]?.body;
            if (before) {
                for (const [name, field] of Object.entries(before.fields)) {
                    const gone = !body.fields?.[name];
                    const retyped = !gone && body.fields[name].type !== field.type;
                    if (!gone && !retyped) continue;
                    const [{ n }] = await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = $1 AND data ? $2", [object, name]);
                    // A rollback (§5.14) takes back a field its change added: what records hold in it is kept
                    // as it is, unseen, and shown again if the field returns (`keeps`, part of what is
                    // approved). A field retyped is not so: its values would be read as what they are not.
                    if (n && gone && (content.keeps?.[object] ?? []).includes(name)) continue;
                    if (n) problems.push({ path: `${object}.fields.${name}`, message: `"${name}" is ${gone ? "removed" : "retyped"}, but ${n} record(s) hold it: that needs a data migration (not in the POC yet).` });
                }
                for (const state of before.states.list) {
                    if (body.states?.list?.includes(state)) continue;
                    const [{ n }] = await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = $1 AND state = $2", [object, state]);
                    if (n) problems.push({ path: `${object}.states.list`, message: `State "${state}" is removed, but ${n} record(s) are in it.` });
                }
            }
        }
        for (const [name, source] of Object.entries(content.scripts ?? {})) problems.push(...validateScript(name, source, checkScript));
        // Services and connections (§15.2), against the objects, scripts, connections, users and
        // groups there will be once this change executes.
        if (Object.keys(content.services ?? {}).length || Object.keys(content.connections ?? {}).length) {
            const known = await integrationKnown(live, content);
            for (const [name, body] of Object.entries(content.connections ?? {})) {
                if (body?.name !== name) problems.push({ path: `connections.${name}.name`, message: `The connection's name must stay "${name}".` });
                for (const p of validateConnection(body, known)) problems.push({ ...p, path: `connections.${name}.${p.path}`, message: `${name}: ${p.message}` });
            }
            for (const [name, body] of Object.entries(content.services ?? {})) {
                if (body?.name !== name) problems.push({ path: `services.${name}.name`, message: `The service's name must stay "${name}".` });
                for (const p of validateService(body, known)) problems.push({ ...p, path: `services.${name}.${p.path}`, message: `${name}: ${p.message}` });
                // A suite's own check of the settings of its kind of schedule (§30.11), where it is installed.
                for (const [i, t] of (Array.isArray(body?.on) ? body.on : []).entries()) {
                    const spec = isSuiteSchedule(t) ? suiteExtensions.schedules[t.schedule.from] : null;
                    for (const m of spec ? await suiteScheduleCheck(t, known) : []) problems.push({ path: `services.${name}.on.${i}`, message: `${name}: Trigger ${i + 1} (${spec.label ?? t.schedule.from}): ${m}` });
                }
            }
        }
        // The organization (§5.6, §8): its people, departments, steps and roles, against the objects there will be.
        if (content.organization) {
            const defs = { ...Object.fromEntries(Object.entries(live.definitions).map(([k, v]) => [k, v.body])), ...(content.definitions ?? {}) };
            for (const p of validateOrganization(content.organization, { objects: Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, { roles: d?.roles ?? [] }])), liveDepartments: Object.keys(live.organization.departments), liveRoles: live.organization.roles })) problems.push({ ...p, path: `organization.${p.path}`, message: `Organization: ${p.message}` });
        }
        // Retiring (§5.10): nothing still in use; an object only once none of its records is.
        if (content.retire) {
            const bodies = (kind) => ({ ...Object.fromEntries(Object.entries(live[kind] ?? {}).map(([k, v]) => [k, v.body ?? v.source])), ...(content[kind] ?? {}) });
            const world = { ...Object.fromEntries(["definitions", "services", "connections", "transactions", "screens"].map((k) => [k, bodies(k)])), locks };
            const recordsInUse = {};
            for (const o of content.retire.definitions ?? []) recordsInUse[o] = (await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = $1 AND archived_at IS NULL", [o]))[0].n;
            const publishedNames = Object.fromEntries(RETIRE_KINDS.map((k) => [k, Object.keys(live[k] ?? {})]));
            const drafted = Object.fromEntries(RETIRE_KINDS.map((k) => [k, Object.keys(content[k] ?? {})]));
            problems.push(...retireProblems(content.retire, world, { published: publishedNames, recordsInUse, drafted }));
        }
        // Flows (§32), against the objects, transactions and screens there will be, and the suites' node kinds.
        if (Object.keys(content.flows ?? {}).length) {
            // What each template runs as sub flows, the change's drafts over what is live: a circle through them is refused.
            const subFlows = Object.fromEntries([...Object.entries(live.flows ?? {}).map(([n, f]) => [n, subFlowsOf(f.body)]), ...Object.entries(content.flows ?? {}).map(([n, b]) => [n, subFlowsOf(b)])]);
            const known = { ...(await integrationKnown(live, content)), flowNodes: suiteFlowNodes, flows: [...new Set([...Object.keys(live.flows ?? {}), ...Object.keys(content.flows ?? {})])], subFlows,
                // What each template is and whose records it takes through (a sub flow runs one of its own kind, §32.14).
                flowInfo: Object.fromEntries(Object.entries({ ...Object.fromEntries(Object.entries(live.flows ?? {}).map(([n, f]) => [n, f.body])), ...(content.flows ?? {}) }).map(([n, b]) => [n, { kind: b?.kind ?? null, object: Object.values(b?.participants ?? {}).find((p) => p?.as === (b?.kind === "plan" ? "subject" : "traveler"))?.object ?? null }])) };
            for (const [name, body] of Object.entries(content.flows ?? {})) {
                if (body?.name !== name) problems.push({ path: `flows.${name}.name`, message: `The flow template's name must stay "${name}".` });
                for (const p of validateFlow(body, known)) problems.push({ ...p, path: `flows.${name}.${p.path}`, message: `${name}: ${p.message}` });
                // A suite's own nodes, checked by the suite (§32.9).
                for (const [id, n] of Object.entries(body?.nodes ?? {})) {
                    const check = suiteFlowNodes[n?.kind]?.validate;
                    if (check) for (const m of check(n.settings ?? {}, known) ?? []) problems.push({ path: `flows.${name}.nodes.${id}`, message: `${name}: ${n.label ?? id}: ${m}` });
                }
            }
        }
        // Screens (§26), against the objects and transactions there will be.
        if (Object.keys(content.screens ?? {}).length) {
            const known = await integrationKnown(live, content);
            for (const [name, body] of Object.entries(content.screens ?? {})) {
                if (body?.name !== name) problems.push({ path: `screens.${name}.name`, message: `The screen's name must stay "${name}".` });
                for (const p of validateScreen(body, known)) problems.push({ ...p, path: `screens.${name}.${p.path}`, message: `${name}: ${p.message}` });
                // A suite's own check of its blocks (§30.11), where it is installed.
                for (const [i, b] of (Array.isArray(body?.blocks) ? body.blocks : []).entries()) {
                    const check = suiteExtensions.blocks[b?.block]?.validate;
                    if (check) for (const m of check(b, known) ?? []) problems.push({ path: `screens.${name}.blocks.${i}`, message: `${name}: block ${i + 1}: ${m}` });
                }
            }
        }
        // Design elements of a suite's kind (§30.11): what every element has, then the suite's own check
        // of its kind, where it is installed; one whose suite is not here holds the change, and says so.
        for (const [name, body] of Object.entries(content.elements ?? {})) {
            if (body?.name !== name) problems.push({ path: `elements.${name}.name`, message: `The element's name must stay "${name}".` });
            const before = live.elements[name]?.body;
            if (before && before.kind !== body?.kind) problems.push({ path: `elements.${name}.kind`, message: `${name}: it stays a ${before.kind}.` });
            const known = { departments: Object.keys(live.organization.departments ?? {}), suiteElements: suiteExtensions.elements };
            for (const p of validateSuiteElement(body, known)) problems.push({ ...p, path: `elements.${name}.${p.path}`, message: `${name}: ${p.message}` });
            const check = suiteExtensions.elements[body?.kind]?.validate;
            // Besides the elements there will be: the live ones (what the change does to them, for a check
            // that keeps what is done, a day gone), and the services scheduled by its suite's schedule
            // kinds, as they will be (a change to the element must not strand a schedule that names it).
            const suite = String(body?.kind).split(".")[0];
            const services = { ...Object.fromEntries(Object.entries(live.services ?? {}).map(([k, v]) => [k, v.body])), ...(content.services ?? {}) };
            const scheduled = Object.entries(services).flatMap(([service, sb]) => (Array.isArray(sb?.on) ? sb.on : []).filter((t) => isSuiteSchedule(t) && String(t.schedule.from).startsWith(`${suite}.`)).map((t) => ({ service, label: sb.label ?? service, schedule: t.schedule })));
            if (check) for (const m of (await check(body, { ...(await integrationKnown(live, content)), elements: { ...Object.fromEntries(Object.entries(live.elements).map(([k, v]) => [k, v.body])), ...(content.elements ?? {}) }, live: Object.fromEntries(Object.entries(live.elements).map(([k, v]) => [k, v.body])), scheduled })) ?? []) problems.push({ path: `elements.${name}`, message: `${name}: ${m}` });
        }
        // Report layouts (§34.5): what they are, departments that exist, and (§34.6) the objects an
        // assist block's records are of, as they will be.
        for (const [name, body] of Object.entries(content.layouts ?? {})) {
            if (body?.name !== name) problems.push({ path: `layouts.${name}.name`, message: `The report layout's name must stay "${name}".` });
            const objects = Object.fromEntries(Object.entries({ ...Object.fromEntries(Object.entries(live.definitions).map(([k, v]) => [k, v.body])), ...(content.definitions ?? {}) }).filter(([o, d]) => d && !(content.retire?.definitions ?? []).includes(o)).map(([o, d]) => [o, { titleField: d.titleField ?? null, fields: d.fields ?? {} }]));
            for (const p of validateReportLayout(body, { departments: Object.keys(live.organization.departments ?? {}), objects })) problems.push({ ...p, path: `layouts.${name}.${p.path}`, message: `${name}: ${p.message}` });
        }
        // Transactions (§25), against the objects (their fields, states and transitions) there will be.
        if (Object.keys(content.transactions ?? {}).length) {
            const known = await integrationKnown(live, content);
            for (const [name, body] of Object.entries(content.transactions ?? {})) {
                if (body?.name !== name) problems.push({ path: `transactions.${name}.name`, message: `The transaction's name must stay "${name}".` });
                for (const p of validateTransaction(body, known)) problems.push({ ...p, path: `transactions.${name}.${p.path}`, message: `${name}: ${p.message}` });
                // A suite's own check of its steps (§30.11), where it is installed.
                for (const [i, st] of (Array.isArray(body?.steps) ? body.steps : []).entries()) {
                    const check = suiteExtensions.steps[st?.step]?.validate;
                    if (check) for (const m of check(st, known) ?? []) problems.push({ path: `transactions.${name}.steps.${i}`, message: `${name}: step ${i + 1}: ${m}` });
                }
            }
        }
        return problems;
    }
    // What the suite's own check says of a schedule from its kind (§30.11): [words]. A check that fails
    // is said as that, never taken for a pass.
    async function suiteScheduleCheck(t, known) {
        const spec = suiteExtensions.schedules[t?.schedule?.from];
        if (typeof spec?.validate !== "function") return [];
        try {
            const said = await spec.validate(suiteSettings(t), known);
            return Array.isArray(said) ? said.map(String) : [];
        } catch (error) {
            log.error?.(`suite schedule ${t.schedule.from}: its check failed`, error);
            return [`the ${spec.suite} suite could not check it (${error?.message ?? "error"}): ask IT.`];
        }
    }
    async function integrationKnown(live, content) {
        const defs = { ...Object.fromEntries(Object.entries(live.definitions).map(([k, v]) => [k, v.body])), ...(content.definitions ?? {}) };
        return {
            objects: Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, { actions: (d?.states?.transitions ?? []).map((t) => t.action), roles: d?.roles ?? [], fields: d?.fields ?? {}, states: d?.states?.list ?? [], transitions: d?.states?.transitions ?? [], titleField: d?.titleField ?? null, stewards: d?.stewards ?? {}, ...(d?.flow ? { flow: d.flow } : {}) }])),
            scripts: [...new Set([...Object.keys(live.scripts), ...Object.keys(content.scripts ?? {})])],
            connections: [...new Set([...Object.keys(live.connections), ...Object.keys(content.connections ?? {})])],
            // People, groups and departments as they will be: a change to the organization's draft, or now.
            users: content.organization ? Object.entries(content.organization.users ?? {}).filter(([, u]) => u.active !== false).map(([id]) => id) : (await db.query("SELECT id FROM mes.users WHERE active")).map((u) => u.id),
            groups: content.organization ? [...Object.keys(content.organization.departments ?? {}), ...Object.keys(content.organization.groups ?? {})] : (await db.query("SELECT id FROM mes.groups")).map((g) => g.id),
            departments: content.organization ? Object.keys(content.organization.departments ?? {}) : (await departments()).map((d) => d.id),
            // What a screen may show and start (§26): each transaction's inputs and where it appears.
            // Which services may run each, and whether a person signs it (§15.2): a service's check reads them.
            transactions: Object.fromEntries(Object.entries({ ...Object.fromEntries(Object.entries(live.transactions ?? {}).map(([k, v]) => [k, v.body])), ...(content.transactions ?? {}) }).map(([k, t]) => [k, { label: t?.label ?? k, inputs: t?.inputs ?? {}, appearsOn: t?.appearsOn ?? null, callers: { services: t?.callers?.services ?? [] }, signed: Boolean(t?.signature) }])),
            // The services there will be: a transaction's callers may name them; and which of them, as their
            // own service role, run each transaction (its callers must keep naming them).
            services: [...new Set([...Object.keys(live.services ?? {}), ...Object.keys(content.services ?? {})])],
            runBy: Object.entries({ ...Object.fromEntries(Object.entries(live.services ?? {}).map(([k, v]) => [k, v.body])), ...(content.services ?? {}) }).reduce((out, [sv, b]) => {
                if (b && (b.runAs ?? "service") === "service") for (const t of Array.isArray(b.uses?.transactions) ? b.uses.transactions : []) (out[t] ??= []).push(sv);
                return out;
            }, {}),
            // What the installed suites add (§30.11): a design that names one that is not here is told so.
            suiteCapabilities: suiteExtensions.capabilities, suiteSteps: suiteExtensions.steps, suiteBlocks: suiteExtensions.blocks, suiteSchedules: suiteExtensions.schedules,
            // The suites' own design elements there will be (§30.11), for a suite's check of a step or a block.
            elements: { ...Object.fromEntries(Object.entries(live.elements ?? {}).map(([k, v]) => [k, v.body])), ...(content.elements ?? {}) },
            // The screens a button may open and a pop-up may open over (§26.6, §26.7).
            screens: [...new Set([...Object.keys(live.screens ?? {}), ...Object.keys(content.screens ?? {})])],
            // The input flows a transaction or a screen may name (§32.13): what each asks for, fills and runs.
            inputFlows: Object.fromEntries(Object.entries({ ...Object.fromEntries(Object.entries(live.flows ?? {}).map(([k, v]) => [k, v.body])), ...(content.flows ?? {}) }).filter(([, b]) => b?.kind === "input").map(([k, b]) => [k, inputFlowSummary(b)])),
        };
    }

    // The footprint and route of a change's content (§5.6).
    async function routeFor(content) {
        const live = await published();
        const elements = [];
        // A change to several objects says whose element each is ("machine: object.label").
        const many = Object.keys(content.definitions ?? {}).length > 1;
        for (const [object, body] of Object.entries(content.definitions ?? {})) {
            for (const e of footprint(live.definitions[object]?.body ?? null, body)) elements.push({ ...e, object, ...(many && !e.element.startsWith("object:") ? { element: `${object}: ${e.element}` } : {}) });
        }
        const objects = { ...Object.fromEntries(Object.entries(live.definitions).map(([k, v]) => [k, v.body])), ...(content.definitions ?? {}) };
        const merged = Object.values(objects);
        const bodies = (kind) => ({ ...Object.fromEntries(Object.entries(live[kind]).map(([k, v]) => [k, v.body])), ...(content[kind] ?? {}) });
        const context = { objects, connections: bodies("connections"), transactions: bodies("transactions") };
        for (const kind of ["connections", "services"]) {
            for (const [name, body] of Object.entries(content[kind] ?? {})) elements.push(...integrationFootprint(kind.slice(0, -1), name, live[kind][name]?.body, body, context));
        }
        for (const [name, body] of Object.entries(content.transactions ?? {})) elements.push(...transactionFootprint(name, live.transactions[name]?.body, body, context));
        for (const [name, body] of Object.entries(content.screens ?? {})) elements.push(...screenFootprint(name, live.screens[name]?.body, body));
        for (const [name, body] of Object.entries(content.flows ?? {})) elements.push(...flowFootprint(name, live.flows[name]?.body, body, { ...context, transactions: bodies("transactions") }));
        for (const [name, body] of Object.entries(content.layouts ?? {})) elements.push(...reportLayoutFootprint(name, live.layouts[name]?.body, body));
        for (const [name, body] of Object.entries(content.elements ?? {})) elements.push(...suiteElementFootprint(name, live.elements[name]?.body, body));
        if (content.organization) elements.push(...organizationFootprint(draftOf(live.organization), content.organization, context));
        if (content.retire) elements.push(...retireFootprint(content.retire, Object.fromEntries(RETIRE_KINDS.map((k) => [k, Object.fromEntries(Object.entries(live[k] ?? {}).map(([n, v]) => [n, v.body ?? v]))]))));
        for (const [name, source] of Object.entries(content.scripts ?? {})) elements.push(...scriptFootprint(name, live.scripts[name]?.source, source, merged, bodies("services"), { ...context, flows: bodies("flows") }));
        // Standing approvers (§5.6): the departments that approve every element of a kind, whoever stewards it.
        // An element nobody stewards answers to governance: beside elements that have stewards as much
        // as alone (it used to ride along, approved by nobody, whenever anything else in the change
        // had a steward).
        const governance = live.organization.governance ?? "engineering";
        const withStanding = applyStanding(elements, live.organization.standing ?? {}).map((e) => (Array.isArray(e.stewards) && e.stewards.length ? e : { ...e, stewards: [governance] }));
        return { elements: withStanding, route: routeOf(withStanding) };
    }

    // What rolling `orig` back comes to (§5.14): the content and base of the change that does it, and
    // the plan in words. For each design `orig` published (its outcome): as it was before (the version
    // before the one it published), while that version is still the one live; one it created is
    // retired; one it retired is published again. A design changed again since is left alone, unless
    // asked for (`includeChanged`): putting it back undoes the later change too.
    const NOUNS = { definitions: "object", scripts: "script", services: "service", connections: "connection", transactions: "transaction", screens: "screen", flows: "flow template", layouts: "report layout", elements: "design element" };
    async function rollbackOf(orig, { includeChanged = false } = {}) {
        if (orig.state !== "executed") fail("Only a change that has executed is rolled back: one still open is withdrawn or sent back to design.", { status: 409 });
        const live = await published();
        const content = {};
        const base = {};
        const plan = { of: orig.id, title: orig.title, restores: [], retires: [], republishes: [], keeps: [], skipped: [] };
        const keyOf = (kind) => (kind === "definitions" ? "object" : "name");
        const put = (kind, name, value, at) => { (content[kind] ??= {})[name] = value; (base[kind] ??= {})[name] = at; };
        for (const kind of ["definitions", "scripts", ...ELEMENTS]) {
            for (const [name, version] of Object.entries(orig.outcome?.[kind] ?? {})) {
                const what = `${NOUNS[kind]} ${name}`;
                const now = live[kind]?.[name] ?? null;
                if (!now) { plan.skipped.push({ what, why: "is not live any more (retired since)" }); continue; }
                const changed = now.version !== version;
                if (changed && !includeChanged) { plan.skipped.push({ what, why: `was changed again since (it is at version ${now.version}): rolling it back would undo that too`, changed: true }); continue; }
                // (A version before that was retired: that change published the name again, so it is one it
                // created, and is retired again, not given the retired version's body as a new one.)
                const [earlier] = await db.query(`SELECT * FROM mes.${kind} WHERE ${keyOf(kind)} = $1 AND version < $2 ORDER BY version DESC LIMIT 1`, [name, version]);
                const before = earlier?.status === "retired" ? null : earlier;
                if (before) {
                    if (kind === "scripts") { put("scripts", name, before.source, now.version); (content.tests ??= {})[name] = before.tests ?? []; }
                    else put(kind, name, before.body, now.version);
                    // The fields it takes back that records hold: their values are kept, unseen.
                    if (kind === "definitions") {
                        for (const field of Object.keys(now.body.fields ?? {}).filter((f) => !before.body.fields?.[f])) {
                            const [{ n }] = await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = $1 AND data ? $2", [name, field]);
                            if (!n) continue;
                            ((content.keeps ??= {})[name] ??= []).push(field);
                            plan.keeps.push({ what: `${name}.${field}`, records: n });
                        }
                    }
                    plan.restores.push({ what, from: now.version, to: before.version, ...(changed ? { undoesLater: true } : {}) });
                } else if (RETIRE_KINDS.includes(kind)) {
                    ((content.retire ??= {})[kind] ??= []).push(name);
                    ((base.retire ??= {})[kind] ??= {})[name] = now.version;
                    plan.retires.push({ what, version: now.version });
                } else plan.skipped.push({ what, why: `was created by that change, and a ${NOUNS[kind]} cannot be retired yet: change it, or leave it unused` });
            }
        }
        // What it retired is published again, as it was.
        for (const [kind, list] of Object.entries(orig.outcome?.retired ?? {})) {
            for (const entry of list ?? []) {
                const name = String(entry).replace(/ v\d+$/, "");
                const what = `${NOUNS[kind] ?? kind} ${name}`;
                if (live[kind]?.[name]) { plan.skipped.push({ what, why: "is live again already" }); continue; }
                const [was] = await db.query(`SELECT * FROM mes.${kind} WHERE ${keyOf(kind)} = $1 AND status = 'retired' ORDER BY version DESC LIMIT 1`, [name]);
                if (!was) { plan.skipped.push({ what, why: "its retired version was not found" }); continue; }
                if (kind === "scripts") { put("scripts", name, was.source, null); (content.tests ??= {})[name] = was.tests ?? []; }
                else put(kind, name, was.body, null);
                plan.republishes.push({ what, version: was.version });
            }
        }
        if (orig.outcome?.organization !== undefined) plan.skipped.push({ what: "people & departments", why: "are not rolled back by this: put them back in a change of their own (People & departments)" });
        return { content, base, plan };
    }

    // A pack (packs.js: a suite's, §29.6, or a model file's, §24.1) as one change request: everything in
    // it that is new or differs from what is live, with its scripts' test cases and the roles it
    // suggests. `from` says where it came from, in the change's first audit entry.
    async function changeFromPack(self, user, pack, { title, reason, from = {} }) {
        const live = await published();
        const status = packStatus(pack, live);
        const elements = packElements(pack, live);
        const content = withKinds({});
        const base = withKinds({});
        for (const e of status.filter((x) => x.status !== "same")) {
            content[e.kind][e.name] = elements[e.kind][e.name];
            base[e.kind][e.name] = e.kind === "scripts" ? live.scripts[e.name]?.version ?? null : live[e.kind][e.name]?.version ?? null;
            if (e.kind === "scripts" && pack.tests?.[e.name]) content.tests[e.name] = pack.tests[e.name];
        }
        const roles = missingRoles(pack, live.organization);
        if (!status.some((e) => e.status !== "same") && !roles.length) fail(`Everything in ${title} is live already.`, { status: 409, code: "design.same" });
        // One open change per element: a pack that would take one from another change is refused, naming it.
        const kinds = Object.keys(elements);
        const [busy] = await db.query(`SELECT id, title FROM mes.change_requests WHERE state = ANY($1) AND (${kinds.map((k, i) => `content->'${k}' ?| $${i + 2}`).join(" OR ")}${roles.length ? " OR content ? 'organization'" : ""}) LIMIT 1`, [OPEN, ...kinds.map((k) => Object.keys(content[k]))]);
        if (busy) fail(`"${busy.title}" is open and holds part of this (or people & departments): finish or withdraw it first.`, { status: 409, code: "design.busy" });
        if (roles.length) {
            const org = draftOf(live.organization);
            for (const [object, role, subject] of roles) ((org.roles[object] ??= {})[role] ??= []).push(subject);
            content.organization = org;
            base.organization = live.organization.version;
        }
        return db.transaction(async (tx) => {
            const [row] = await tx.query("INSERT INTO mes.change_requests (title, state, author, content, base, reason) VALUES ($1, 'design', $2, $3, $4, $5) RETURNING id",
                [String(title).slice(0, 200), user.id, JSON.stringify(content), JSON.stringify(base), String(reason).slice(0, 2000)]);
            await audit(tx, user.id, row.id, "change:start", { ...from, elements: status.filter((e) => e.status !== "same").map((e) => `${e.kind}:${e.name}`), roles: roles.length, ...(self?.via ? { via: self.via } : {}) });
            return { id: row.id, existing: false };
        });
    }
    // What a pack would change here, nothing written: each element new, changed or same, the roles it
    // would add, and what the designs it brings fail of the checks a change must pass.
    async function packPreview(pack) {
        const live = await published();
        const status = packStatus(pack, live);
        const elements = packElements(pack, live);
        const content = withKinds({});
        for (const e of status.filter((x) => x.status !== "same")) {
            content[e.kind][e.name] = elements[e.kind][e.name];
            if (e.kind === "scripts" && pack.tests?.[e.name]) content.tests[e.name] = pack.tests[e.name];
        }
        const problems = status.some((e) => e.status !== "same") ? await problemsOf(content) : [];
        return { elements: status, roles: missingRoles(pack, live.organization).map(([object, role, subject]) => ({ object, role, subject })), problems };
    }

    const summary = (row) => ({
        id: row.id, title: row.title, state: row.state, author: row.author, co_designers: row.co_designers ?? [], contributors: row.contributors ?? [], updated_by: row.updated_by ?? null, draft_rev: Number(row.draft_rev ?? 0),
        objects: Object.keys(row.content?.definitions ?? {}), scripts: Object.keys(row.content?.scripts ?? {}),
        services: Object.keys(row.content?.services ?? {}), connections: Object.keys(row.content?.connections ?? {}), transactions: Object.keys(row.content?.transactions ?? {}), screens: Object.keys(row.content?.screens ?? {}), flows: Object.keys(row.content?.flows ?? {}), layouts: Object.keys(row.content?.layouts ?? {}), elements: Object.keys(row.content?.elements ?? {}), organization: Boolean(row.content?.organization), retire: row.content?.retire ?? null,
        updated_at: iso(row.updated_at), submitted_at: iso(row.submitted_at), executed_at: iso(row.executed_at),
        // Under test in the test sandbox (§5.13): its place in the order; and how its last build there went.
        test: row.test ?? null, lastTest: (row.tested ?? []).at(-1) ?? null,
        // A change that rolls another back (§5.14).
        rollbackOf: row.rollback?.of ?? null,
    });
    // A rollback as the platform drafted it: what was live before, unchanged since (§5.14). Edited, it
    // is a change like any other, reviewed and approved in full.
    // (And on the versions it was drafted on, `on`: a design taken out and put in again after it moved on
    // holds the same content on a later base, and would undo that later change unasked and unsaid.)
    const pureRollback = (row) => Boolean(row.rollback?.hash) && sha256(canonical(row.content)) === row.rollback.hash && (!row.rollback.on || sha256(canonical(row.base ?? {})) === row.rollback.on);

    async function audit(q, actor, id, action, after) {
        await appendAudit(q, { actor, object: "$change", recordId: id, action, after });
    }

    // Execution (§5.3): by the platform, in one transaction, only for the approved content, and only
    // if nothing it was drafted against has moved since.
    async function execute(tx, row) {
        if (sha256(canonical(row.content)) !== row.content_hash) throw new Error("the content does not match what was approved");
        const outcome = { definitions: {}, scripts: {}, services: {}, connections: {}, transactions: {}, screens: {}, flows: {}, layouts: {}, elements: {} };
        // The organization first: departments and people exist before anything names them.
        if (row.content.organization) {
            const [live] = await tx.query("SELECT version FROM mes.organization WHERE status = 'published' FOR UPDATE");
            if ((live?.version ?? null) !== (row.base.organization ?? null)) throw new Error(`the organization changed since this was drafted (v${live?.version})`);
            await applyOrganization(tx, row.content.organization, (live?.version ?? 0) + 1);
            outcome.organization = (live?.version ?? 0) + 1;
        }
        for (const [name, source] of Object.entries(row.content.scripts ?? {})) {
            const [live] = await tx.query("SELECT version FROM mes.scripts WHERE name = $1 AND status = 'published' FOR UPDATE", [name]);
            if ((live?.version ?? null) !== (row.base.scripts?.[name] ?? null)) throw new Error(`script ${name} changed since this was drafted (v${live?.version})`);
            const version = (await tx.query("SELECT coalesce(max(version), 0) AS v FROM mes.scripts WHERE name = $1", [name]))[0].v + 1;
            if (live) await tx.query("UPDATE mes.scripts SET status = 'superseded' WHERE name = $1 AND version = $2", [name, live.version]);
            // Its test cases are published with it: the change's, or, when it carried none, the ones it had.
            const [had] = live ? await tx.query("SELECT tests FROM mes.scripts WHERE name = $1 AND version = $2", [name, live.version]) : [];
            const tests = row.content.tests?.[name] ?? had?.tests ?? [];
            await tx.query("INSERT INTO mes.scripts (name, version, status, source, tests) VALUES ($1, $2, 'published', $3, $4)", [name, version, source, JSON.stringify(tests)]);
            outcome.scripts[name] = version;
        }
        for (const [object, body] of Object.entries(row.content.definitions ?? {})) {
            const [live] = await tx.query("SELECT version, body FROM mes.definitions WHERE object = $1 AND status = 'published' FOR UPDATE", [object]);
            if ((live?.version ?? null) !== (row.base.definitions?.[object] ?? null)) throw new Error(`${object} changed since this was drafted (v${live?.version})`);
            // Brought into the change and left as it was (§5.12): checked above, not published again.
            if (live && canonical(live.body) === canonical(body)) { (outcome.unchanged ??= {}).definitions = [...(outcome.unchanged.definitions ?? []), object]; continue; }
            // After the latest version, a retired one included (§5.10).
            const version = (await tx.query("SELECT coalesce(max(version), 0) AS v FROM mes.definitions WHERE object = $1", [object]))[0].v + 1;
            if (live) await tx.query("UPDATE mes.definitions SET status = 'superseded' WHERE object = $1 AND version = $2", [object, live.version]);
            else {
                if (!named(object)) throw new Error(`bad object name ${object}`);
                // A retired object published again keeps its partition (its archived records).
                await tx.query(`CREATE TABLE IF NOT EXISTS mes."records_${object}" PARTITION OF mes.records FOR VALUES IN ('${object}')`);
                // The author's departments get nothing automatically: roles are assigned by a change too.
            }
            await tx.query("INSERT INTO mes.definitions (object, version, status, body) VALUES ($1, $2, 'published', $3)", [object, version, JSON.stringify(body)]);
            outcome.definitions[object] = version;
            // A choice field that now holds several values, or one again (§10.4): its stored values
            // follow, in the same transaction ("kg" becomes ["kg"]; ["kg", "l"] keeps "kg").
            for (const [name, field] of Object.entries(live ? body.fields ?? {} : {})) {
                const was = live.body.fields?.[name];
                if (!was || field.type !== "enum" || Boolean(was.multiple) === Boolean(field.multiple)) continue;
                const converted = await tx.query(multipleConversion(field.multiple), [object, name]);
                if (converted.length) await appendAudit(tx, { actor: "platform", object, defVersion: version, action: `convert:${name}`, after: { field: name, to: field.multiple ? "several values" : "one value", records: converted.length, change: row.id } });
            }
        }
        // Connections before the services that use them, and transactions after the objects they
        // write; all are live the moment this commits.
        for (const kind of ELEMENTS) {
            for (const [name, body] of Object.entries(row.content[kind] ?? {})) {
                const [live] = await tx.query(`SELECT version, body FROM mes.${kind} WHERE name = $1 AND status = 'published' FOR UPDATE`, [name]);
                if ((live?.version ?? null) !== (row.base[kind]?.[name] ?? null)) throw new Error(`${kind.slice(0, -1)} ${name} changed since this was drafted (v${live?.version})`);
                if (live && canonical(live.body) === canonical(body)) { (outcome.unchanged ??= {})[kind] = [...(outcome.unchanged[kind] ?? []), name]; continue; }
                const version = (await tx.query(`SELECT coalesce(max(version), 0) AS v FROM mes.${kind} WHERE name = $1`, [name]))[0].v + 1;
                if (live) await tx.query(`UPDATE mes.${kind} SET status = 'superseded' WHERE name = $1 AND version = $2`, [name, live.version]);
                await tx.query(`INSERT INTO mes.${kind} (name, version, status, body) VALUES ($1, $2, 'published', $3)`, [name, version, JSON.stringify(body)]);
                outcome[kind][name] = version;
            }
        }
        // Retiring (§5.10): the published version is marked retired, never deleted; a service's
        // script goes with it. Refused if it moved since, or (an object) if records came into use.
        if (row.content.retire) {
            outcome.retired = {};
            for (const kind of RETIRE_KINDS) {
                const table = kind;
                const key = kind === "definitions" ? "object" : "name";
                for (const name of row.content.retire[kind] ?? []) {
                    const [live] = await tx.query(`SELECT version FROM mes.${table} WHERE ${key} = $1 AND status = 'published' FOR UPDATE`, [name]);
                    if (!live || live.version !== row.base.retire?.[kind]?.[name]) throw new Error(`${kind.slice(0, -1)} ${name} changed since this was drafted`);
                    if (kind === "definitions") {
                        const [{ n }] = await tx.query("SELECT count(*)::int AS n FROM mes.records WHERE object = $1 AND archived_at IS NULL", [name]);
                        if (n) throw new Error(`object ${name} has ${n} record(s) in use`);
                    }
                    await tx.query(`UPDATE mes.${table} SET status = 'retired' WHERE ${key} = $1 AND version = $2`, [name, live.version]);
                    if (kind === "services") await tx.query("UPDATE mes.scripts SET status = 'retired' WHERE name = $1 AND status = 'published'", [name]);
                    (outcome.retired[kind] ??= []).push(`${name} v${live.version}`);
                }
            }
        }
        return outcome;
    }

    // A change for one service or connection: its live body as the draft, or a new one. A new
    // service comes with its script (the same name) and nobody among its callers: deny by default.
    // `draft`: a new report layout's body to start from (a layout made from a report, §34.11): only a
    // new one, never over a live layout or another change's draft.
    async function startIntegration(user, kind, name, label, from, elementKind = null, draft = null) {
        const noun = kind.slice(0, -1);
        if (typeof name !== "string" || !named(name)) fail(`A ${noun}'s name is lower case letters, digits and _, starting with a letter.`, { fields: { [noun]: "Letters, digits and _." } });
        const live = await published();
        const current = live[kind][name];
        if (draft !== null) {
            if (kind !== "layouts" || !isPlain(draft) || JSON.stringify(draft).length > 50000) fail("Only a new report layout starts from a body of its own.", { fields: { draft: "A report layout." } });
            if (from !== undefined && from !== null && from !== "") fail("A layout starts from a body or as a copy, not both.", { fields: { from: "Not both." } });
            const [taken] = current ? [true] : await db.query(`SELECT id FROM mes.change_requests WHERE state = ANY($1) AND content->'layouts' ? $2`, [OPEN, name]);
            if (taken) fail(`A report layout "${name}" exists already, or is drafted in a change: name the new one something else.`, { fields: { layout: "Taken." }, code: "design.taken" });
        }
        // A copy of another (`from`): a new one, its body the live one's under the new name.
        const source = from === undefined || from === null || from === "" ? null : live[kind][from];
        if (from !== undefined && from !== null && from !== "") {
            if (!COPYABLE.includes(noun)) fail(`A ${noun} is not started as a copy of another.`, { fields: { from: "Not copied." } });
            if (!source) fail(`There is no live ${noun} "${from}" to copy: copy one that is live (a design still in a change is copied there, with Add to this change).`, { fields: { from: "Not live." } });
            if (current) fail(`A ${noun} "${name}" exists already: name the copy something new.`, { fields: { [noun]: "Taken." } });
        }
        const [open] = await db.query(`SELECT id FROM mes.change_requests WHERE state = ANY($1) AND content->'${kind}' ? $2`, [OPEN, name]);
        if (open) {
            if (source) fail(`A change already drafts a ${noun} "${name}": name the copy something new.`, { fields: { [noun]: "Taken." } });
            return { id: open.id, existing: true };
        }
        const stewards = [user.departments[0] ?? (await governance())];
        const body = draft ? { ...LAYOUT_TEMPLATE(name, label, stewards), ...draft, name, label: (typeof label === "string" && label.trim()) || draft.label || name, stewards } : source ? copyDesign(noun, source.body, { name, label }) : current?.body ?? (kind === "services"
            ? { name, label: label?.trim() || name, description: "", input: {}, http: { enabled: true }, callers: { users: [], groups: [] }, on: [], runAs: "service", roles: {}, uses: { connections: [], objects: {} }, stewards }
            : kind === "transactions" ? TRANSACTION_TEMPLATE(name, label, stewards)
                : kind === "screens" ? SCREEN_TEMPLATE(name, label, stewards)
                : kind === "flows" ? FLOW_TEMPLATE(name, label, stewards)
                : kind === "layouts" ? LAYOUT_TEMPLATE(name, label, stewards)
                // A suite's element (§30.11): what every element has, and what its kind starts with.
                : kind === "elements" ? { name, kind: elementKind, label: label?.trim() || name.replace(/_/g, " "), description: "", stewards, ...(suiteExtensions.elements[elementKind]?.template?.(name) ?? {}) }
                : { name, label: label?.trim() || name, baseUrl: "https://example.com/api", auth: { kind: "bearer", secret: name }, allow: [{ method: "GET", path: "/*" }], timeoutMs: 5000, stewards });
        const content = withKinds({ [kind]: { [name]: body } });
        const base = withKinds({ [kind]: { [name]: current?.version ?? null } });
        if (kind === "services") {
            // A copied service brings its script, its function named after the copy, and its test cases.
            const script = source ? live.scripts[from] : live.scripts[name];
            content.scripts[name] = source ? copyScript(script?.source ?? SERVICE_TEMPLATE(name), from, name) : script?.source ?? SERVICE_TEMPLATE(name);
            base.scripts[name] = source ? null : script?.version ?? null;
            content.tests[name] = script?.tests ?? [];
        }
        return db.transaction(async (tx) => {
            const [row] = await tx.query(
                "INSERT INTO mes.change_requests (title, state, author, content, base) VALUES ($1, 'design', $2, $3, $4) RETURNING id",
                [current ? `Change ${noun} ${current.body.label}` : source ? `New ${noun}: ${body.label}, a copy of ${source.body.label ?? from}` : `New ${noun}: ${body.label}`, user.id, JSON.stringify(content), JSON.stringify(base)],
            );
            await audit(tx, user.id, row.id, "change:start", { [noun]: name, ...(source ? { from } : {}), ...(this?.via ? { via: this.via } : {}) });
            if (this?.via) await tx.query("UPDATE mes.change_requests SET ai_edits = $2 WHERE id = $1", [row.id, JSON.stringify([{ at: new Date().toISOString(), via: this.via, elements: [`started: ${noun} ${name}`] }])]);
            return { id: row.id, existing: false };
        });
    }

    const services = {
        // What the designer lists: every object, published or drafted, and the user's design rights.
        async "design.home"({ as } = {}) {
            const user = await designUser(this, as);
            const live = await published();
            const changes = await db.query("SELECT * FROM mes.change_requests ORDER BY updated_at DESC LIMIT 100");
            return {
                me: { id: user.id, roles: user.designRoles, reps: user.reps },
                plantTz,
                // What the platform and the installed suites lock, as it holds now, for the designer to show and check (builtins.js).
                locks: liveLocks(allLocks, Object.fromEntries(Object.entries(live.definitions).map(([k, v]) => [k, v.body]))),
                // What a transaction's editor offers: each object's fields, states and transitions.
                objects: Object.entries(live.definitions).map(([object, d]) => ({ object, label: d.body.label, area: d.body.area, version: d.version, actions: (d.body.states?.transitions ?? []).map((t) => t.action), roles: d.body.roles ?? [], stewards: d.body.stewards?.object ?? [], stewardship: d.body.stewards ?? {}, titleField: d.body.titleField, tones: d.body.states?.tones ?? {}, ...(d.body.flow ? { flow: d.body.flow } : {}), fields: Object.fromEntries(Object.entries(d.body.fields ?? {}).map(([k, f]) => [k, { label: f.label ?? k, type: f.type, ...(f.to ? { to: f.to } : {}), ...(f.values ? { values: f.values } : {}), ...(f.multiple ? { multiple: true } : {}) }])), states: d.body.states?.list ?? [], transitions: (d.body.states?.transitions ?? []).map(({ action, label, from, to }) => ({ action, label: label ?? action, from, to })), open: changes.filter((c) => OPEN.includes(c.state) && c.content.definitions?.[object]).map((c) => c.id) })),
                scripts: Object.entries(live.scripts).map(([name, s]) => ({ name, version: s.version })),
                // Services and connections (§15.2), each with its open change, like an object.
                services: Object.entries(live.services).map(([name, s]) => ({ name, label: s.body.label, version: s.version, stewards: s.body.stewards ?? [], http: Boolean(s.body.http?.enabled), runs: (s.body.runAs ?? "service") === "service" ? s.body.uses?.transactions ?? [] : [], on: (s.body.on ?? []).map((t) => `${t.object} ${t.event}`), open: changes.filter((c) => OPEN.includes(c.state) && c.content.services?.[name]).map((c) => c.id) })),
                connections: Object.entries(live.connections).map(([name, c]) => ({ name, label: c.body.label, version: c.version, baseUrl: c.body.baseUrl, stewards: c.body.stewards ?? [], open: changes.filter((ch) => OPEN.includes(ch.state) && ch.content.connections?.[name]).map((ch) => ch.id) })),
                // Transactions (§25), each with its open change.
                transactions: Object.entries(live.transactions).map(([name, t]) => ({ name, label: t.body.label, version: t.version, appearsOn: t.body.appearsOn ?? null, inputs: t.body.inputs ?? {}, steps: (t.body.steps ?? []).length, stewards: t.body.stewards ?? [], services: t.body.callers?.services ?? [], signed: Boolean(t.body.signature), open: changes.filter((ch) => OPEN.includes(ch.state) && ch.content.transactions?.[name]).map((ch) => ch.id) })),
                // Flows (§32), each with its open change; the node kinds the installed suites add.
                flows: Object.entries(live.flows).map(([name, f]) => ({ name, label: f.body.label, kind: f.body.kind, version: f.version, ...(f.body.kind === "input" ? { summary: inputFlowSummary(f.body) } : {}), nodes: Object.keys(f.body.nodes ?? {}).length, subFlows: subFlowsOf(f.body), asSub: f.body.asSub === true, object: Object.values(f.body.participants ?? {}).find((p) => p?.as === (f.body.kind === "plan" ? "subject" : "traveler"))?.object ?? null, stewards: f.body.stewards ?? [], open: changes.filter((ch) => OPEN.includes(ch.state) && ch.content.flows?.[name]).map((ch) => ch.id) })),
                // What else the suites add (§30.11): what a service may ask of each, their step and block kinds.
                suiteCapabilities: suiteExtensions.capabilities,
                suiteSteps: Object.fromEntries(Object.entries(suiteExtensions.steps).map(([k, x]) => [k, { label: x.label, suite: x.suite, config: x.config ?? {}, required: x.required ?? [], irreversible: Boolean(x.irreversible) }])),
                suiteBlocks: Object.fromEntries(Object.entries(suiteExtensions.blocks).map(([k, x]) => [k, { label: x.label, suite: x.suite, config: x.config ?? {}, required: x.required ?? [] }])),
                // Kinds of schedule a service may run on (§30.11): the browser checks a schedule's shape
                // against them; the server works out its times (integration.scheduleRuns).
                suiteSchedules: Object.fromEntries(Object.entries(suiteExtensions.schedules).map(([k, x]) => [k, { label: x.label ?? k, suite: x.suite, config: x.config ?? {}, required: x.required ?? [] }])),
                flowNodes: Object.fromEntries(Object.entries(suiteFlowNodes).map(([k, n]) => [k, { label: n.label, extends: n.extends, config: n.config ?? {}, required: n.required ?? [], palette: n.palette ?? null }])),
                // The suites' own design elements (§30.11), each with its open change; one whose suite is
                // not installed is listed as it is, saying what it needs. And the kinds a new one may be.
                elements: Object.entries(live.elements).map(([name, e]) => ({ name, label: e.body.label, kind: e.body.kind, kindLabel: suiteExtensions.elements[e.body.kind]?.label ?? null, ...(suiteExtensions.elements[e.body.kind] ? {} : { needs: String(e.body.kind).split(".")[0] }), version: e.version, stewards: e.body.stewards ?? [], open: changes.filter((ch) => OPEN.includes(ch.state) && ch.content.elements?.[name]).map((ch) => ch.id),
                    // (One of a kind others are checked against, `shared` by its suite: its body too, so the
                    // designer checks them as they are typed.)
                    ...(suiteExtensions.elements[e.body.kind]?.shared ? { body: e.body } : {}) })),
                suiteElements: Object.fromEntries(Object.entries(suiteExtensions.elements).map(([k, x]) => [k, { label: x.label, suite: x.suite, ...(typeof x.contract === "string" ? { contract: x.contract } : {}) }])),
                // Report layouts (§34.5), each with its open change.
                layouts: Object.entries(live.layouts).map(([name, l]) => ({ name, label: l.body.label, description: l.body.description ?? "", version: l.version, blocks: (l.body.blocks ?? []).map((b) => b.block), stewards: l.body.stewards ?? [], open: changes.filter((ch) => OPEN.includes(ch.state) && ch.content.layouts?.[name]).map((ch) => ch.id) })),
                // Screens (§26), each with its open change.
                screens: Object.entries(live.screens).map(([name, sc]) => ({ name, label: sc.body.label, version: sc.version, param: Object.keys(sc.body.params ?? {})[0] ?? null, blocks: (sc.body.blocks ?? []).length, stewards: sc.body.stewards ?? [], open: changes.filter((ch) => OPEN.includes(ch.state) && ch.content.screens?.[name]).map((ch) => ch.id) })),
                users: await db.query("SELECT id, name FROM mes.users WHERE active ORDER BY id"),
                // Who may be named a co-designer: the active designers (§5.3).
                designers: (await db.query("SELECT DISTINCT u.id, u.name FROM mes.assignments a JOIN mes.users u ON u.id = a.subject_id AND u.active WHERE a.object = 'design' AND a.subject_kind = 'user' AND a.role = 'designer' ORDER BY u.id")),
                // People & departments (§5.6): governance, standing approvers, each department's steps, and its open change.
                organization: { ...(({ version, governance, standing, departments }) => ({ version, governance, standing, departments: Object.fromEntries(Object.entries(departments).map(([k, d]) => [k, { name: d.name, members: d.members, approval: d.approval }])) }))(live.organization), open: changes.filter((c) => OPEN.includes(c.state) && c.content.organization).map((c) => c.id) },
                groups: await db.query("SELECT id, name FROM mes.groups ORDER BY id"),
                departments: await departments(),
                changes: changes.map(summary),
                // Designs the installed suites bring (§29.6): what in each is new or differs from what is
                // live, the roles it suggests that are missing, and the open changes holding any of it.
                packs: Object.entries(suitePacks).map(([suite, pack]) => {
                    const elements = packStatus(pack, live);
                    const names = elements.map((e) => [e.kind, e.name]);
                    return {
                        suite, from: pack.suite, label: pack.label, version: pack.version, description: pack.description ?? "",
                        counts: Object.fromEntries(["new", "changed", "same"].map((k) => [k, elements.filter((e) => e.status === k).length])),
                        elements, roles: missingRoles(pack, live.organization).length,
                        samples: (pack.records ?? []).filter((r) => r.key !== undefined).length,
                        open: changes.filter((c) => OPEN.includes(c.state) && names.some(([k, n]) => c.content[k]?.[n] !== undefined)).map((c) => ({ id: c.id, title: c.title, state: c.state })),
                    };
                }),
            };
        },

        // Start a change from a suite's design pack (§29.6): everything in it that is new or differs from
        // what is live, with its scripts' test cases and the roles it suggests, as one change request
        // the person designs on from there. Nothing goes live but through review and approval.
        async "design.fromPack"({ suite } = {}) {
            const user = await designUser(this);
            if (!user.designRoles.includes("designer")) fail("Only a designer starts a change.", { status: 403 });
            const pack = suitePacks[suite];
            if (!pack) fail(`No suite named "${suite}" with designs is installed.`, { status: 404 });
            return changeFromPack(this, user, pack, { title: `${pack.label} ${pack.version}`, reason: `From the ${pack.suite} suite's designs, version ${pack.version}. ${pack.description ?? ""}`.trim(), from: { pack: suite, version: pack.version } });
        },

        // One change request, with its live footprint, route, problems and approvals.
        async "design.change"({ id, as } = {}) {
            const user = await designUser(this, as);
            const row = await loadChange(db, id);
            const approvals = await db.query("SELECT department, step, user_id, decision, meaning, note, at FROM mes.approvals WHERE change_id = $1 ORDER BY at", [id]);
            const live = await published();
            const { elements, route } = row.state === "design" ? await routeFor(row.content) : { elements: row.footprint ?? [], route: row.route ?? [] };
            // Each department's approval, step by step; in approval, who may sign each department's
            // current step, and why this person may not.
            const settings = await organizationSettings(db);
            const progress = Object.fromEntries(await Promise.all(route.map(async (r) => [r.department, await progressOf(db, row, r.department, approvals, settings)])));
            const waiting = row.state === "approval" ? route.filter((r) => progress[r.department].current) : [];
            const left = Object.fromEntries(waiting.map((r) => [r.department, progress[r.department].current.eligible]));
            const reasonFor = (p) => (authorsOf(row).includes(user.id) ? "author" : row.reviewer === user.id ? "reviewer" : p.steps.some((st) => st.signed?.user_id === user.id) ? "signed" : null);
            const whyNot = waiting.filter((r) => progress[r.department].current.approvers.includes(user.id)).map((r) => ({ department: r.department, step: progress[r.department].current.label, reason: reasonFor(progress[r.department]) })).filter((x) => x.reason);
            return {
                ...summary(row),
                reason: row.reason,
                content: row.content,
                base: row.base,
                live: {
                    definitions: Object.fromEntries(Object.keys(row.content.definitions ?? {}).map((o) => [o, live.definitions[o]?.body ?? null])),
                    scripts: Object.fromEntries(Object.keys(row.content.scripts ?? {}).map((s) => [s, live.scripts[s]?.source ?? null])),
                    services: Object.fromEntries(Object.keys(row.content.services ?? {}).map((n) => [n, live.services[n]?.body ?? null])),
                    connections: Object.fromEntries(Object.keys(row.content.connections ?? {}).map((n) => [n, live.connections[n]?.body ?? null])),
                    transactions: Object.fromEntries(Object.keys(row.content.transactions ?? {}).map((n) => [n, live.transactions[n]?.body ?? null])),
                    ...(row.content.organization ? { organization: draftOf(live.organization) } : {}),
                    // What it retires, as published now: each one's version and label.
                    ...(row.content.retire ? { retire: Object.fromEntries(Object.entries(row.content.retire).map(([k, names]) => [k, Object.fromEntries(names.map((n) => [n, live[k]?.[n] ? { version: live[k][n].version, label: live[k][n].body?.label ?? n } : null]))])) } : {}),
                    screens: Object.fromEntries(Object.keys(row.content.screens ?? {}).map((n) => [n, live.screens[n]?.body ?? null])),
                    flows: Object.fromEntries(Object.keys(row.content.flows ?? {}).map((n) => [n, live.flows[n]?.body ?? null])),
                    layouts: Object.fromEntries(Object.keys(row.content.layouts ?? {}).map((n) => [n, live.layouts[n]?.body ?? null])),
                    elements: Object.fromEntries(Object.keys(row.content.elements ?? {}).map((n) => [n, live.elements[n]?.body ?? null])),
                },
                problems: row.state === "design" ? await problemsOf(row.content) : [],
                footprint: elements,
                route: route.map((r) => {
                    const p = progress[r.department];
                    return {
                        ...r,
                        steps: p.steps.map(({ step, label, approvers, signed }) => ({ step, label, approvers, signed })),
                        current: p.current?.label ?? null,
                        // The department's decision: its rejection, or the last step's approval once all are signed.
                        approval: p.rejected ?? (p.done ? p.steps.at(-1).signed : null),
                    };
                }),
                reviewer: row.reviewer, review_note: row.review_note, outcome: row.outcome,
                approvers: left, whyNot,
                aiEdits: row.ai_edits ?? [],
                // The latest fitness test (§5.9), and whether it tested the content as it is now.
                fitness: row.fitness ?? null,
                // The test sandbox (§5.13): whether it is under test, and what it was tested with, each time.
                test: row.test ?? null, tested: row.tested ?? [],
                // Rolling back (§5.14): what this change rolls back, and whether it is still exactly that
                // (then one approval executes it); the changes that roll this one back.
                rollback: row.rollback ? { ...row.rollback, pure: pureRollback(row) } : null,
                rolledBackBy: await db.query("SELECT id, title, state FROM mes.change_requests WHERE rollback->>'of' = $1 ORDER BY created_at", [id]),
                fitnessCurrent: Boolean(row.fitness && row.fitness.hash === sha256(canonical(row.content))),
                // Before and during review: who may review it and still leave someone to sign every step.
                reviewing: ["design", "review"].includes(row.state) ? await reviewOptions(route, authorsOf(row)) : null,
                reviewCosts: row.state === "review" ? (row.route ?? []).map((r) => r.department).filter((d) => user.reps.includes(d)) : [],
                can: {
                    // The author and the co-designers they named edit and submit it; others read it.
                    edit: row.state === "design" && editorsOf(row).includes(user.id),
                    submit: row.state === "design" && editorsOf(row).includes(user.id),
                    withdraw: OPEN.includes(row.state) && row.author === user.id,
                    // Rolled back by a designer, once it has executed (§5.14).
                    rollback: row.state === "executed" && user.designRoles.includes("designer"),
                    codesigners: row.state === "design" && row.author === user.id,
                    review: row.state === "review" && !authorsOf(row).includes(user.id) && user.designRoles.some((r) => r === "reviewer" || r === "designer"),
                    // A review may be taken back until someone has signed: the change goes back to review.
                    retractReview: row.state === "approval" && row.reviewer === user.id && !approvals.length,
                    // The departments whose current step this person may sign.
                    approveFor: waiting.filter((r) => progress[r.department].current.eligible.includes(user.id)).map((r) => r.department),
                    approveSteps: Object.fromEntries(waiting.filter((r) => progress[r.department].current.eligible.includes(user.id)).map((r) => [r.department, { step: progress[r.department].current.step, label: progress[r.department].current.label, of: progress[r.department].steps.length }])),
                },
            };
        },

        // A live design, to read (§5.1): the published element in a change's shape, with everything a
        // change may do turned off, so the designer's editors draw it read-only. Nothing is written: no
        // draft, no change request. An object comes with its rule scripts, a service with its script,
        // each with its test cases. Null when nothing by that name is published.
        async "design.view"({ kind, name, with: also = [], as } = {}) {
            const user = await designUser(this, as);
            const K = VIEW_KINDS[kind];
            if (!K) fail(`Viewing takes a kind: ${Object.keys(VIEW_KINDS).join(", ")}.`);
            const live = await published();
            const current = typeof name === "string" ? live[K][name] : null;
            if (!current) return null;
            const content = withKinds({ [K]: { [name]: current.body } });
            // The objects it relies on that are live, and those asked to be shown beside it (`with`).
            const uses = reliesOn(K, current.body).filter((o) => o !== name || K !== "definitions").filter((o) => live.definitions[o]);
            const shown = (Array.isArray(also) ? also : []).filter((o) => uses.includes(o));
            for (const o of shown) content.definitions[o] = live.definitions[o].body;
            const scripts = [...(K === "services" ? [name] : []), ...Object.values(content.definitions).flatMap((d) => (d.rules ?? []).map((r) => r?.script).filter(Boolean))];
            for (const s of scripts) if (live.scripts[s]) { content.scripts[s] = live.scripts[s].source; content.tests[s] = live.scripts[s].tests ?? []; }
            const open = await db.query(`SELECT id, title, state FROM mes.change_requests WHERE state = ANY($1) AND content->'${K}' ? $2 ORDER BY updated_at DESC`, [OPEN, name]);
            const none = { definitions: {}, scripts: {}, services: {}, connections: {}, transactions: {}, screens: {}, flows: {}, layouts: {}, elements: {} };
            return {
                id: `view-${kind}-${name}`,
                view: { kind, name, version: current.version, open, mayChange: user.designRoles.includes("designer") && !open.length, uses: uses.map((o) => ({ object: o, label: live.definitions[o].body.label ?? o, version: live.definitions[o].version })), with: shown },
                title: current.body.label ?? name, state: "live", author: null, co_designers: [], contributors: [], updated_by: null, draft_rev: 0,
                objects: Object.keys(content.definitions), scripts: Object.keys(content.scripts), services: Object.keys(content.services), connections: Object.keys(content.connections),
                transactions: Object.keys(content.transactions), screens: Object.keys(content.screens), organization: false, retire: null,
                // What the editors reload on: the version, and what is shown beside it.
                updated_at: `v${current.version}${shown.length ? `+${shown.join(",")}` : ""}`, submitted_at: null, executed_at: null,
                reason: "", content, base: {},
                // What is live is what it shows: no differences to mark.
                live: { ...none, ...Object.fromEntries(Object.entries(content).filter(([k]) => k !== "tests")) },
                problems: [], footprint: [], route: [], reviewer: null, review_note: null, outcome: null, approvers: {}, whyNot: [], aiEdits: [],
                fitness: null, fitnessCurrent: false, reviewing: null, reviewCosts: [],
                can: { edit: false, submit: false, withdraw: false, codesigners: false, review: false, retractReview: false, approveFor: [], approveSteps: {} },
            };
        },

        // Start a change: a new object, or an edit of a live one (its current version as the draft).
        // `service` or `connection` instead of `object` starts one for a service or a connection (§15.2),
        // `transaction` for a transaction (§25).
        async "design.start"({ object, label, service, connection, transaction, screen, flow, layout, element, kind: elementKind, organization, retire, from, draft } = {}) {
            const user = await designUser(this);
            if (!user.designRoles.includes("designer")) fail("Only a designer starts a change.", { status: 403 });
            if (from !== undefined && from !== null && from !== "" && (retire || organization)) fail("Retiring, or a change to people & departments, is not started as a copy.", { fields: { from: "Not copied." } });
            // Retiring a published element (§5.10): { kind, name }, kind one of RETIRE_KINDS.
            if (retire) {
                const { kind, name } = retire;
                if (!RETIRE_KINDS.includes(kind) || typeof name !== "string" || !named(name)) fail("Retire { kind, name }: a published object, script, service, connection, transaction or screen.");
                const live = await published();
                const current = live[kind]?.[name];
                if (!current) fail(`There is no published ${kind.slice(0, -1)} "${name}".`, { status: 404 });
                const [open] = await db.query(`SELECT id FROM mes.change_requests WHERE state = ANY($1) AND (content->'${kind}' ? $2 OR content->'retire'->'${kind}' ? $2)`, [OPEN, name]);
                if (open) return { id: open.id, existing: true };
                const label = current.body?.label ?? name;
                return db.transaction(async (tx) => {
                    const [row] = await tx.query("INSERT INTO mes.change_requests (title, state, author, content, base) VALUES ($1, 'design', $2, $3, $4) RETURNING id",
                        [`Retire ${kind === "definitions" ? "object" : kind.slice(0, -1)} ${label}`, user.id, JSON.stringify({ ...withKinds({}), retire: { [kind]: [name] } }), JSON.stringify({ ...withKinds({}), retire: { [kind]: { [name]: current.version } } })]);
                    await audit(tx, user.id, row.id, "change:start", { retire: { [kind]: name }, ...(this?.via ? { via: this.via } : {}) });
                    return { id: row.id, existing: false };
                });
            }
            // People & departments (§5.6, §8): the organization as it is, as the draft; one open change at a time.
            if (organization) {
                // An open change of its own is continued. Another that carries a part of it (a suite's pack,
                // its roles) holds it too: a second draft would be overwritten when either executes, so
                // none is started, and the person is told which holds it, never taken into that one.
                const [open] = await db.query("SELECT id, state, title, author, content FROM mes.change_requests WHERE state = ANY($1) AND content ? 'organization' ORDER BY created_at LIMIT 1", [OPEN]);
                if (open && orgOnly(open.content)) return { id: open.id, existing: true };
                if (open) fail(`“${open.title}” (${open.state}, by ${open.author}) also changes people & departments (the roles it gives), and they are in one open change at a time. Once it is executed or withdrawn, a change can start here.`, { status: 409, code: "organization.held" });
                const snapshot = await organizationSnapshot(db);
                return db.transaction(async (tx) => {
                    const [row] = await tx.query("INSERT INTO mes.change_requests (title, state, author, content, base) VALUES ($1, 'design', $2, $3, $4) RETURNING id",
                        ["Change people & departments", user.id, JSON.stringify({ ...withKinds({}), organization: draftOf(snapshot) }), JSON.stringify({ ...withKinds({}), organization: snapshot.version })]);
                    await audit(tx, user.id, row.id, "change:start", { organization: true, ...(this?.via ? { via: this.via } : {}) });
                    return { id: row.id, existing: false };
                });
            }
            // A suite's element (§30.11): `element` its name; a new one says its kind, of an installed suite.
            if (element !== undefined) {
                const current = (await published()).elements[element];
                const of = current?.body.kind ?? elementKind;
                if (typeof of !== "string" || !SUITE_KIND.test(of)) fail('A new design element says its kind: "<suite>.<kind>".', { fields: { kind: "Required." } });
                if (!suiteExtensions.elements[of]) fail(`A ${of} needs the ${of.split(".")[0]} suite, which is not installed here: it is changed once the suite is back.`, { status: 409, code: "suite.missing" });
                return startIntegration.call(this, user, "elements", element, label, from, of);
            }
            if (service !== undefined || connection !== undefined || transaction !== undefined || screen !== undefined || flow !== undefined || layout !== undefined) {
                const kind = service !== undefined ? "services" : connection !== undefined ? "connections" : transaction !== undefined ? "transactions" : screen !== undefined ? "screens" : flow !== undefined ? "flows" : "layouts";
                return startIntegration.call(this, user, kind, service ?? connection ?? transaction ?? screen ?? flow ?? layout, label, from, null, draft ?? null);
            }
            if (typeof object !== "string" || !named(object)) fail("An object's name is lower case letters, digits and _, starting with a letter.", { fields: { object: "Letters, digits and _." } });
            const live = await published();
            const current = live.definitions[object];
            // A copy of another (`from`): a new object, all of the live one's design under the new name, its
            // rule scripts copied too, each under a name of its own (an object's rules are its own, §12).
            const copying = from !== undefined && from !== null && from !== "";
            const source = copying ? live.definitions[from] : null;
            if (copying && !source) fail(`There is no live object "${from}" to copy.`, { fields: { from: "Not live." } });
            if (copying && current) fail(`An object "${object}" exists already: name the copy something new.`, { fields: { object: "Taken." } });
            const [open] = await db.query("SELECT id FROM mes.change_requests WHERE state = ANY($1) AND content->'definitions' ? $2", [OPEN, object]);
            if (open && copying) fail(`A change already drafts an object "${object}": name the copy something new.`, { fields: { object: "Taken." } });
            if (open) return { id: open.id, existing: true };
            const copiedScripts = {};
            const copied = source ? copyDesign("object", source.body, { name: object, label }) : null;
            if (copied) {
                const [drafted] = await db.query("SELECT coalesce(jsonb_agg(k), '[]') AS names FROM mes.change_requests, jsonb_object_keys(content->'scripts') k WHERE state = ANY($1)", [OPEN]);
                const taken = (n) => Boolean(live.scripts[n]) || (drafted?.names ?? []).includes(n) || Boolean(copiedScripts[n]);
                for (const rule of Array.isArray(copied.rules) ? copied.rules : []) {
                    const old = rule?.script;
                    if (typeof old !== "string" || !live.scripts[old]) continue;
                    let next = copiedScriptName(old, from, object);
                    if (taken(next)) next = `${object}_${old}`;
                    if (taken(next) || !named(next)) fail(`The copy's rule script ${next} exists already: name the copy something else.`, { fields: { object: "Taken." } });
                    copiedScripts[next] = { source: copyScript(live.scripts[old].source, old, next), tests: live.scripts[old].tests ?? [] };
                    rule.script = next;
                }
            }
            const body = copied ?? current?.body ?? {
                object, label: label?.trim() || object, area: "Production", description: "", titleField: "name",
                fields: { name: { label: "Name", type: "string", required: true } },
                // A list to begin with (one state, no actions); states are added when it has a lifecycle.
                states: { initial: "active", list: ["active"], transitions: [] },
                // Stewarded by the department of its area (Production, Quality, …), not by its author's.
                roles: ["user"], stewards: { object: [await stewardForArea("Production", user)] },
                policies: [{ id: `${object}-all`, roles: ["user"], record: { read: true, create: true }, fields: { "*": "write" } }],
                list: { columns: ["name"] }, form: { sections: [{ label: "Details", fields: ["name"] }] }, rules: [],
            };
            return db.transaction(async (tx) => {
                const [row] = await tx.query(
                    `INSERT INTO mes.change_requests (title, state, author, content, base) VALUES ($1, 'design', $2, $3, $4) RETURNING id`,
                    [current ? `Change ${current.body.label}` : source ? `New object: ${body.label}, a copy of ${source.body.label ?? from}` : `New object: ${body.label}`, user.id,
                        JSON.stringify({ definitions: { [object]: body }, scripts: Object.fromEntries(Object.entries(copiedScripts).map(([n, x]) => [n, x.source])), ...(source ? { tests: Object.fromEntries(Object.entries(copiedScripts).map(([n, x]) => [n, x.tests])) } : {}) }),
                        JSON.stringify({ definitions: { [object]: current?.version ?? null }, scripts: Object.fromEntries(Object.keys(copiedScripts).map((n) => [n, null])) })],
                );
                await audit(tx, user.id, row.id, "change:start", { object, ...(source ? { from } : {}), ...(this?.via ? { via: this.via } : {}) });
                if (this?.via) await tx.query("UPDATE mes.change_requests SET ai_edits = $2 WHERE id = $1", [row.id, JSON.stringify([{ at: new Date().toISOString(), via: this.via, elements: [`started: ${object}`] }])]);
                return { id: row.id, existing: false };
            });
        },

        // A live design brought into a change in design (§5.12): several objects, transactions, screens,
        // flows, services and connections changed together, reviewed once and approved once by every
        // department any of them touches (the route is the union of their footprints), executed all or
        // nothing. Its live body becomes its draft, at the version live now (its base: executing refuses
        // it if that moved meanwhile, §5.3). A design is in one open change at a time, as `design.start`
        // keeps it: one already in another is refused, naming it. An object's rule scripts follow when
        // edited, as in any change.
        async "design.include"({ id, kind, name, seen } = {}) {
            const user = await designUser(this);
            const key = VIEW_KINDS[kind];
            if (!key) fail(`Bring in a live ${Object.keys(VIEW_KINDS).join(", ")} (kind).`, { fields: { kind: "Unknown." } });
            if (typeof name !== "string" || !named(name)) fail("Name the design: lower case letters, digits and _.", { fields: { name: "Letters, digits and _." } });
            const live = await published();
            const current = live[key]?.[name];
            const what = `${kind} ${current?.body?.label ?? name}`;
            if (!current) fail(`There is no live ${kind} "${name}": a new one is made with Add to this change.`, { status: 404, fields: { name: "Not live." } });
            return db.transaction(async (tx) => {
                const row = await loadChange(tx, id, true);
                if (row.state !== "design") fail("This change is no longer in design: send it back to design to add to it.", { status: 409 });
                if (!editorsOf(row).includes(user.id)) fail(`Only its author (${row.author})${row.co_designers?.length ? ` and co-designers (${row.co_designers.join(", ")})` : ""} add to this change.`, { status: 403 });
                if (seen !== undefined && seen !== null && Number(seen) !== Number(row.draft_rev ?? 0)) fail(`${row.updated_by && row.updated_by !== user.id ? row.updated_by : "Someone"} saved this draft since you opened it. Load their version, then add it again.`, { status: 409, code: "design.stale" });
                const content = withKinds(row.content);
                if (content[key][name] !== undefined) return { ok: true, already: true, draft_rev: row.draft_rev };
                const [other] = await tx.query(`SELECT id, title, author FROM mes.change_requests WHERE id <> $1 AND state = ANY($2) AND (content->'${key}' ? $3 OR content->'retire'->'${key}' ? $3) LIMIT 1`, [id, OPEN, name]);
                if (other) fail(`${what} is already in the open change "${other.title}" (${other.author}): finish or withdraw that one, or make this edit there.`, { status: 409, code: "design.taken", fields: { name: "In another change." } });
                const base = withKinds(row.base);
                content[key][name] = JSON.parse(JSON.stringify(current.body));
                base[key][name] = current.version;
                // A service comes with its script, as when a change starts on it.
                if (key === "services" && content.scripts[name] === undefined) {
                    content.scripts[name] = live.scripts[name]?.source ?? SERVICE_TEMPLATE(name);
                    base.scripts[name] = live.scripts[name]?.version ?? null;
                }
                const label = current.body?.label ?? name;
                // The title says what it holds while it is still the one it was given: "Change Lot, Machine".
                const title = /^Change /.test(row.title) && row.title.length + label.length < 190 ? `${row.title}, ${label}` : row.title;
                // Nothing drafted yet (it is as live), so no AI edit marked: the audit says who brought it in, and how.
                const [written] = await tx.query(
                    `UPDATE mes.change_requests SET title = $2, reason = $3, content = $4, base = $5, updated_at = now(), updated_by = $7, ai_edits = ai_edits || $6::jsonb,
                            draft_rev = draft_rev + 1, contributors = ${CONTRIBUTE} WHERE id = $1 RETURNING draft_rev`,
                    [id, title, row.reason, JSON.stringify(content), JSON.stringify(base), "[]", user.id]);
                await audit(tx, user.id, id, "change:include", { [kind]: name, version: current.version, draft_rev: written.draft_rev, ...(this?.via ? { via: this.via } : {}) });
                return { ok: true, kind, name, version: current.version, draft_rev: written.draft_rev, problems: await problemsOf(content) };
            });
        },

        // Save the draft (design stage only, author only). Scripts ride along in the same change.
        // `seen`: the draft's draft_rev as the editor loaded it; a save made on an older copy is refused.
        // draft_rev moves with the content only (a save, a rename), never with a fitness run, a review or
        // a signature, so those never make an editor's copy look stale.
        async "design.save"({ id, title, reason, definitions, scripts, services, connections, tests, transactions, screens, flows, layouts, elements, organization, retire, seen } = {}) {
            const user = await designUser(this);
            return db.transaction(async (tx) => {
                const row = await loadChange(tx, id, true);
                if (row.state !== "design") fail("This change is no longer in design: send it back to design to edit it.", { status: 409 });
                if (!editorsOf(row).includes(user.id)) fail(`Only its author (${row.author})${row.co_designers?.length ? ` and co-designers (${row.co_designers.join(", ")})` : ""} edit this change: ask ${row.author} to add you as a co-designer.`, { status: 403, code: "design.not_yours" });
                // Saved by someone else since this copy was loaded (`seen`): refused, so neither undoes the other.
                if (seen !== undefined && seen !== null && Number(seen) !== Number(row.draft_rev ?? 0)) fail(`${row.updated_by && row.updated_by !== user.id ? row.updated_by : "Someone"} saved this draft since you opened it. Load their version, then make your edits again.`, { status: 409, code: "design.stale" });
                const content = withKinds(row.content);
                const base = withKinds(row.base);
                const live = await published();
                if (definitions !== undefined) {
                    if (!isPlain(definitions)) fail("Definitions are { object: body }.");
                    for (const [object, body] of Object.entries(definitions)) {
                        // null takes an object out of this change (it stays as it is published).
                        if (body === null && named(object)) { delete content.definitions[object]; delete base.definitions[object]; continue; }
                        if (!named(object) || !isPlain(body)) fail(`A bad definition for "${object}".`);
                        content.definitions[object] = body;
                        if (!(object in base.definitions)) base.definitions[object] = live.definitions[object]?.version ?? null;
                    }
                }
                if (scripts !== undefined) {
                    if (!isPlain(scripts)) fail("Scripts are { name: source }.");
                    for (const [name, source] of Object.entries(scripts)) {
                        if (!named(name)) fail(`"${name}": a script's name is lower case letters, digits and _.`);
                        if (source === null) { delete content.scripts[name]; delete base.scripts[name]; continue; }
                        if (typeof source !== "string" || source.length > 20000) fail(`${name}.js: at most 20 000 characters.`);
                        content.scripts[name] = source;
                        if (!(name in base.scripts)) base.scripts[name] = live.scripts[name]?.version ?? null;
                    }
                }
                for (const [kind, given] of [["services", services], ["connections", connections], ["transactions", transactions], ["screens", screens], ["flows", flows], ["layouts", layouts], ["elements", elements]]) {
                    if (given === undefined) continue;
                    if (!isPlain(given)) fail(`${kind[0].toUpperCase()}${kind.slice(1)} are { name: body }.`);
                    for (const [name, body] of Object.entries(given)) {
                        if (!named(name)) fail(`"${name}": a name is lower case letters, digits and _.`);
                        if (body === null) { delete content[kind][name]; delete base[kind][name]; continue; }
                        if (!isPlain(body) || JSON.stringify(body).length > 50000) fail(`A bad ${kind.slice(0, -1)} "${name}".`);
                        content[kind][name] = body;
                        if (!(name in base[kind])) base[kind][name] = live[kind][name]?.version ?? null;
                    }
                }
                // What it retires (§5.10): { kind: [names] }, each at the version live now; null or empty: nothing.
                if (retire !== undefined) {
                    if (retire === null || (isPlain(retire) && !Object.values(retire).some((l) => Array.isArray(l) && l.length))) { delete content.retire; delete base.retire; } else {
                        if (!isPlain(retire) || !Object.entries(retire).every(([k, l]) => RETIRE_KINDS.includes(k) && Array.isArray(l) && l.every((n) => typeof n === "string" && named(n)))) fail(`Retire is { ${RETIRE_KINDS.join(" | ")}: [names] }.`);
                        content.retire = Object.fromEntries(Object.entries(retire).filter(([, l]) => l.length));
                        base.retire = Object.fromEntries(Object.entries(content.retire).map(([k, names]) => [k, Object.fromEntries(names.map((n) => [n, base.retire?.[k]?.[n] ?? live[k]?.[n]?.version ?? null]))]));
                    }
                }
                // The organization: the whole of it, as it is to be (people, departments, steps, roles, standing).
                if (organization !== undefined) {
                    if (organization === null) { delete content.organization; delete base.organization; } else {
                        if (!isPlain(organization)) fail("The organization is { users, departments, groups, roles, standing, governance }.");
                        // A plant's people fit (30K are about 2 MB); the request's own limit is 8 MB.
                        if (JSON.stringify(organization).length > 7_000_000) fail("People & departments is larger than 7 MB: about 100,000 people. Split what you are importing into smaller changes, or ask IT about the limit.");
                        content.organization = organization;
                        if (base.organization === undefined) base.organization = (await organizationSettings(tx)).version;
                    }
                }
                if (tests !== undefined) {
                    if (!isPlain(tests)) fail("Tests are { script: [test cases] }.");
                    for (const [name, cases] of Object.entries(tests)) {
                        if (!named(name)) fail(`"${name}": a script's name is lower case letters, digits and _.`);
                        if (cases === null) { delete content.tests[name]; continue; }
                        if (!Array.isArray(cases) || cases.length > 100 || !cases.every(isPlain) || JSON.stringify(cases).length > 100000) fail(`${name}: test cases are a list of at most 100 { name, run, expect }.`);
                        content.tests[name] = cases;
                    }
                }
                // A design is in one open change at a time, however it came into this one (as starting a
                // change on it and bringing it in already have it): two changes holding it would each be
                // reviewed and signed, and the second would fail at its last signature.
                const was = withKinds(row.content);
                for (const kind of ["definitions", "scripts", "services", "connections", "transactions", "screens", "flows", "layouts", "elements"]) {
                    for (const name of Object.keys(content[kind] ?? {})) {
                        if (was[kind]?.[name] !== undefined) continue;
                        const [other] = await tx.query(`SELECT title, author FROM mes.change_requests WHERE id <> $1 AND state = ANY($2) AND (content->'${kind}' ? $3 OR content->'retire'->'${kind}' ? $3) LIMIT 1`, [id, OPEN, name]);
                        if (other) fail(`${kind === "definitions" ? "object" : kind.slice(0, -1)} ${name} is already in the open change "${other.title}" (${other.author}): finish or withdraw that one, or make this edit there.`, { status: 409, code: "design.taken" });
                    }
                }
                const edit = aiEdit(this, row.content, content);
                const [written] = await tx.query(
                    `UPDATE mes.change_requests SET title = $2, reason = $3, content = $4, base = $5, updated_at = now(), updated_by = $7, ai_edits = ai_edits || $6::jsonb,
                            draft_rev = draft_rev + 1, contributors = ${CONTRIBUTE} WHERE id = $1 RETURNING updated_at, draft_rev`,
                    [id, typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : row.title, typeof reason === "string" ? reason.slice(0, 2000) : row.reason, JSON.stringify(content), JSON.stringify(base), JSON.stringify(edit ? [edit] : []), user.id],
                );
                if (edit) await audit(tx, user.id, id, "change:ai-edit", edit);
                await saved(tx, id, user.id, written.draft_rev);
                return { ok: true, problems: await problemsOf(content), updated_at: iso(written.updated_at), draft_rev: written.draft_rev };
            });
        },

        // Design → review: the content is frozen and hashed; the footprint and the route are fixed.
        async "design.submit"({ id } = {}) {
            const user = await designUser(this);
            const draft = await loadChange(db, id);
            if (draft.state !== "design" || !editorsOf(draft).includes(user.id)) fail("Only its author and co-designers submit a change in design.", { status: 409 });
            if (!draft.reason.trim()) fail("Say why: a change needs a reason.", { fields: { reason: "Required." } });
            const problems = await problemsOf(draft.content);
            if (problems.length) fail(`Fix ${problems.length} problem(s) before submitting.`, { code: "design.invalid" });
            // The fitness test (§5.9) of exactly what is submitted: it runs scripts and reads records,
            // so before the transaction; the transaction then refuses content that moved meanwhile.
            const report = fitness ? await fitness(draft, user) : null;
            if (report) await db.query("UPDATE mes.change_requests SET fitness = $2, updated_at = now() WHERE id = $1", [id, JSON.stringify(report)]);
            if (report && !report.passed) fail(`The fitness test failed: ${report.counts.fail} check(s). See the fitness report.`, { status: 409, code: "design.unfit" });
            return db.transaction(async (tx) => {
                const row = await loadChange(tx, id, true);
                if (row.state !== "design" || !editorsOf(row).includes(user.id)) fail("Only its author and co-designers submit a change in design.", { status: 409 });
                const hash = sha256(canonical(row.content));
                if (report && report.hash !== hash) fail("The draft changed while it was tested; submit again.", { status: 409 });
                const { elements, route } = await routeFor(row.content);
                if (!elements.length) fail("This change changes nothing.");
                // Submitted, it could never be approved: say so now, not after someone reviews it.
                // A rollback as drafted (§5.14) is what was live before, reviewed and approved then: it is
                // not reviewed again, and goes straight to approval, where one signature executes it.
                const rolling = pureRollback(row);
                const options = rolling ? { fine: ["no review"], empty: [], strands: [] } : await reviewOptions(route, authorsOf(row));
                if (!options.fine.length) fail(`Nobody could review it and still leave someone to approve it${options.empty.length ? ` for ${options.empty.join(", ")} (no approvers)` : options.strands.length ? ` for ${[...new Set(options.strands.flatMap((x) => x.where))].join(", ")}` : ""}. Add approvers to ${options.empty.length || options.strands.length ? "those departments" : "its departments"} (People & departments) first.`, { status: 409, code: "design.no_approver" });
                await tx.query(
                    "UPDATE mes.change_requests SET state = $5, content_hash = $2, footprint = $3, route = $4, submitted_at = now(), updated_at = now(), reviewer = NULL, review_note = NULL WHERE id = $1",
                    [id, hash, JSON.stringify(elements), JSON.stringify(route), rolling ? "approval" : "review"],
                );
                await audit(tx, user.id, id, "change:submit", { hash, route: route.map((r) => r.department), ...(rolling ? { rollback: row.rollback.of, review: "none: it restores what was approved before" } : {}), ...(this?.via ? { via: this.via } : {}), ...(report ? { fitness: { passed: report.passed, fail: report.counts.fail, warn: report.counts.warn } } : {}) });
                return { ok: true };
            });
        },

        // ---- rolling a change back (§5.14) ----
        // What rolling an executed change back would do: each design it published, put back as it was
        // before (the version before, published again as a new one), each it created retired, each it
        // retired published again; and what would be left alone, and why. Nothing is written.
        async "design.rollbackPlan"({ id, includeChanged = false } = {}) {
            await designUser(this);
            return (await rollbackOf(await loadChange(db, id), { includeChanged: includeChanged === true })).plan;
        },
        // The change that does it, drafted by the platform, its author whoever asked. It is a change like
        // any other from there: read, submitted by its author, and executed by one approval, not theirs.
        // `includeChanged`: designs changed again since are put back as well, undoing those changes too.
        async "design.rollback"({ id, includeChanged = false } = {}) {
            const user = await designUser(this);
            if (!user.designRoles.includes("designer")) fail("Only a designer rolls a change back.", { status: 403 });
            const orig = await loadChange(db, id);
            const { content, base, plan } = await rollbackOf(orig, { includeChanged: includeChanged === true });
            const touched = plan.restores.length + plan.retires.length + plan.republishes.length;
            if (!touched) fail(`There is nothing to roll back${plan.skipped.length ? `: ${plan.skipped.map((x) => `${x.what} ${x.why}`).join("; ")}` : ""}.`, { status: 409, code: "rollback.nothing" });
            // One open change per design (§5.3): a design in another open change is not drafted twice.
            for (const kind of KINDS) for (const name of [...Object.keys(content[kind] ?? {}), ...(content.retire?.[kind] ?? [])]) {
                const [other] = await db.query(`SELECT title FROM mes.change_requests WHERE state = ANY($1) AND (content->'${kind}' ? $2 OR content->'retire'->'${kind}' ? $2) LIMIT 1`, [OPEN, name]);
                if (other) fail(`${name} is in the open change "${other.title}": finish or withdraw that one first.`, { status: 409, code: "rollback.busy" });
            }
            const full = withKinds(content);
            const problems = await problemsOf(full);
            const made = await db.transaction(async (tx) => {
                const [row] = await tx.query(
                    "INSERT INTO mes.change_requests (title, reason, state, author, content, base, rollback) VALUES ($1, $2, 'design', $3, $4, $5, $6) RETURNING id",
                    [`Roll back: ${orig.title}`.slice(0, 200), `Rolls back "${orig.title}", executed ${iso(orig.executed_at)?.slice(0, 10) ?? ""}: what it changed is put back as it was before.`, user.id, JSON.stringify(full), JSON.stringify(withKinds(base)),
                        JSON.stringify({ of: id, title: orig.title, hash: sha256(canonical(full)), on: sha256(canonical(withKinds(base))), restores: plan.restores, retires: plan.retires, republishes: plan.republishes, keeps: plan.keeps, skipped: plan.skipped })],
                );
                await audit(tx, user.id, row.id, "change:start", { rollback: id, restores: plan.restores.map((x) => x.what), retires: plan.retires.map((x) => x.what), republishes: plan.republishes.map((x) => x.what), ...(this?.via ? { via: this.via } : {}) });
                await audit(tx, user.id, id, "change:rollback-started", { by: row.id });
                return { id: row.id, plan, problems };
            });
            // Its conflicts, found in a sandbox, at once (§5.14): the fitness test, which submitting runs
            // again. A rollback that breaks something else says so before anyone is asked to approve it.
            if (fitness) {
                const report = await fitness(await loadChange(db, made.id), user).catch((error) => { log.error?.("rollback: fitness", error); return null; });
                if (report) await db.query("UPDATE mes.change_requests SET fitness = $2 WHERE id = $1", [made.id, JSON.stringify(report)]);
                return { ...made, fitness: report ? { passed: report.passed, conflicts: report.checks.find((c) => c.id === "rollback")?.items ?? [] } : null };
            }
            return made;
        },

        // Review → approval, or back to design with a note. The reviewer is never the author.
        async "design.review"({ id, decision, note } = {}) {
            const user = await designUser(this);
            if (decision !== "pass" && decision !== "changes") fail("Pass it, or ask for changes.");
            if (!user.designRoles.some((r) => r === "reviewer" || r === "designer")) fail("Only a reviewer or a designer reviews a change.", { status: 403 });
            return db.transaction(async (tx) => {
                const row = await loadChange(tx, id, true);
                if (row.state !== "review") fail("This change is not in review.", { status: 409 });
                if (authorsOf(row).includes(user.id)) fail(designedBy(row, user.id, "review"), { status: 403 });
                if (decision === "changes" && !(note ?? "").trim()) fail("Say what needs to change.", { fields: { note: "Required." } });
                // Segregation of duties must leave someone to sign for every department (§5.6).
                if (decision === "pass") {
                    const stuck = await unsignable(row.route, { authors: authorsOf(row), reviewer: user.id });
                    // A department with no approvers at all (one this change creates, before the fix
                    // that keeps new departments off a route): no reviewer can help; it must be re-routed.
                    const empty = stuck.filter((x) => x.none).map((x) => x.where);
                    if (empty.length) fail(`Nobody can approve it for ${empty.join(", ")}: ${empty.length > 1 ? "they have" : "it has"} no approvers yet. Choose Ask for changes instead, so that its author submits it again and its approvals are worked out afresh.`, { status: 409, code: "design.no_approver" });
                    if (stuck.length) {
                        // Who could review it instead: someone whose review leaves every step of every
                        // department on the route with someone to sign it (not merely outside this one).
                        fail(`If you review it, nobody can approve it for ${stuck.map((x) => x.where).join(", ")}: its approvers there are the author and you. ${await reviewersInstead(tx, row, user.id)}`, { status: 409, code: "design.no_approver" });
                    }
                }
                await tx.query("UPDATE mes.change_requests SET state = $2, reviewer = $3, review_note = $4, updated_at = now() WHERE id = $1", [id, decision === "pass" ? "approval" : "design", user.id, (note ?? "").slice(0, 2000)]);
                await audit(tx, user.id, id, `change:review:${decision}`, { note: note ?? "" });
                return { ok: true };
            });
        },

        // Approval: one representative per required department signs the frozen content. When the last
        // one approves, the platform executes the change at once (§5.3).
        // `signature`: { password } or { sso: true }, where the plant asks every signer to prove who they
        // are (§7.4, Part 11 §11.200): checked before anything is written.
        async "design.approve"({ id, department, decision, meaning, note, signature } = {}) {
            const user = await designUser(this);
            if (decision !== "approve" && decision !== "reject") fail("Approve or reject.");
            if (typeof meaning !== "string" || !meaning.trim()) fail("A signature states its meaning.", { fields: { meaning: "Required." } });
            const proof = signatures ? await signatures.signOne(this, user, `change ${id} for ${department}`, signature) : null;
            let executed = false;
            const result = await db.transaction(async (tx) => {
                const row = await loadChange(tx, id, true);
                if (row.state !== "approval") fail("This change is not awaiting approval.", { status: 409 });
                if (authorsOf(row).includes(user.id)) fail(designedBy(row, user.id, "approve"), { status: 403 });
                // Segregation of duties (§5.6): the reviewer's check and an approver's signature are two people.
                if (row.reviewer === user.id) fail("You reviewed this change, so another representative must approve it.", { status: 403 });
                if (!(row.route ?? []).some((r) => r.department === department)) fail("That department's approval is not required.");
                // The department's current step (§5.6): signed by one of its approvers, never twice by one person.
                const settings = await organizationSettings(tx);
                const signed = await tx.query("SELECT department, step, user_id, decision FROM mes.approvals WHERE change_id = $1", [id]);
                const p = await progressOf(tx, row, department, signed, settings);
                if (p.rejected || p.done) fail(`${department} has already decided.`, { status: 409 });
                const step = p.current;
                const at = p.steps.length > 1 ? ` at its step "${step.label}" (${step.step} of ${p.steps.length})` : "";
                if (!step.approvers.includes(user.id)) fail(user.reps.includes(department) ? `${department} is${at || " waiting"}: ${step.approvers.join(" or ")} signs it.` : `You do not approve for ${department}.`, { status: 403 });
                if (p.steps.some((st) => st.signed?.user_id === user.id)) fail(`You signed an earlier step for ${department}; someone else signs this one.`, { status: 403 });
                await tx.query(
                    "INSERT INTO mes.approvals (change_id, department, step, user_id, decision, meaning, note, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                    [id, department, step.step, user.id, decision, meaning.trim().slice(0, 200), (note ?? "").slice(0, 2000), row.content_hash],
                );
                await audit(tx, user.id, id, `change:${decision}`, { department, ...(p.steps.length > 1 ? { step: step.label } : {}), meaning, hash: row.content_hash, ...(proof ? { printedName: proof.printedName, method: proof.method } : {}) });
                // The change's own views follow its updated_at: a signature is a change to it too.
                await tx.query("UPDATE mes.change_requests SET updated_at = now() WHERE id = $1", [id]);
                if (decision === "reject") {
                    await tx.query("UPDATE mes.change_requests SET state = 'rejected', updated_at = now() WHERE id = $1", [id]);
                    return { state: "rejected" };
                }
                // Every department's every step signed: execution.
                const now = await tx.query("SELECT department, step, user_id, decision FROM mes.approvals WHERE change_id = $1", [id]);
                const missing = [];
                for (const r of row.route) if (!(await progressOf(tx, row, r.department, now, settings)).done) missing.push(r.department);
                // A rollback as drafted (§5.14): one approval executes it. The others' signatures are not
                // waited for: what it restores is what they approved before.
                const rolling = pureRollback(row) && row.content_hash === row.rollback.hash;
                if (missing.length && !rolling) return { state: "approval", waiting: missing };
                // Every department has approved: execution, by the platform. A failure rolls the
                // execution back (never a partial one) and keeps the approvals and the record of it.
                await tx.query("SAVEPOINT execute_change");
                try {
                    // What it relies on may have changed since it was drafted and signed (§5.3): a field
                    // its transaction writes was removed by a change executed meanwhile, a steward was
                    // added to what it touches. Its own elements' versions do not show that; the checks
                    // and the route, worked out again against what is live now, do.
                    const stale = await problemsOf(row.content);
                    if (stale.length) throw new Error(`It no longer passes the checks, since what it relies on changed after it was signed: ${stale.slice(0, 3).map((p) => p.message).join(" ")}${stale.length > 3 ? ` (and ${stale.length - 3} more)` : ""} Send it back to design.`);
                    const asked = new Set(row.route.map((r) => r.department));
                    const unasked = rolling ? [] : (await routeFor(row.content)).route.map((r) => r.department).filter((d) => !asked.has(d));
                    if (unasked.length) throw new Error(`Since it was submitted, what it touches came to answer to ${unasked.join(", ")} as well, who never signed it. Send it back to design and submit it again.`);
                    const outcome = await execute(tx, row);
                    await tx.query("UPDATE mes.change_requests SET state = 'executed', executed_at = now(), outcome = $2, updated_at = now() WHERE id = $1", [id, JSON.stringify(outcome)]);
                    await audit(tx, "platform", id, "change:execute", outcome);
                    executed = true;
                    return { state: "executed", outcome };
                } catch (error) {
                    await tx.query("ROLLBACK TO SAVEPOINT execute_change");
                    log.error("change execution failed", error);
                    await tx.query("UPDATE mes.change_requests SET state = 'failed', outcome = $2, updated_at = now() WHERE id = $1", [id, JSON.stringify({ error: String(error.message) })]);
                    await audit(tx, "platform", id, "change:failed", { error: String(error.message) });
                    return { state: "failed", error: String(error.message) };
                }
            });
            if (executed) {
                store.forget();
                // Travelers already there when a route is published take it up, at the step their step field names (§32.5);
                // one brought in as it was (not published again, §5.12) is still taken up, as a republish was.
                const routes = [...Object.keys(result.outcome?.flows ?? {}), ...(result.outcome?.unchanged?.flows ?? [])];
                if (routes.length) await onFlows?.(routes).catch((e) => log.error?.("flows: adopt", e));
            }
            return result;
        },

        // The reviewer takes their review back, before anyone has signed: the change is in review again,
        // for another reviewer (a review that left nobody to approve it, for one).
        async "design.retractReview"({ id } = {}) {
            const user = await designUser(this);
            return db.transaction(async (tx) => {
                const row = await loadChange(tx, id, true);
                if (row.state !== "approval" || row.reviewer !== user.id) fail("Only its reviewer takes a review back, while it awaits approval.", { status: 409 });
                const [signed] = await tx.query("SELECT 1 FROM mes.approvals WHERE change_id = $1", [id]);
                if (signed) fail("Someone has signed it already: the review stands.", { status: 409 });
                await tx.query("UPDATE mes.change_requests SET state = 'review', reviewer = NULL, review_note = NULL, updated_at = now() WHERE id = $1", [id]);
                await audit(tx, user.id, id, "change:review:retract", {});
                return { ok: true };
            });
        },

        async "design.withdraw"({ id } = {}) {
            const user = await designUser(this);
            return db.transaction(async (tx) => {
                const row = await loadChange(tx, id, true);
                if (!OPEN.includes(row.state) || row.author !== user.id) fail("Only the author withdraws an open change.", { status: 409 });
                await tx.query("UPDATE mes.change_requests SET state = 'withdrawn', updated_at = now() WHERE id = $1", [id]);
                await audit(tx, user.id, id, "change:withdraw", {});
                return { ok: true };
            });
        },

        // The co-designers of a change in design (§5.3), named by its author: designers who may edit and
        // submit it with them. Like the author, none of them reviews or approves it.
        async "design.codesigners"({ id, users } = {}) {
            const user = await designUser(this);
            if (!Array.isArray(users) || users.length > 20 || !users.every((u) => typeof u === "string")) fail("Co-designers are a list of people.");
            return db.transaction(async (tx) => {
                const row = await loadChange(tx, id, true);
                if (row.author !== user.id) fail(`Only its author (${row.author}) names a change's co-designers.`, { status: 403 });
                if (row.state !== "design") fail("Co-designers are named while a change is in design.", { status: 409 });
                const wanted = [...new Set(users)].filter((u) => u !== row.author).sort();
                const designers = new Set((await tx.query("SELECT DISTINCT a.subject_id FROM mes.assignments a JOIN mes.users u ON u.id = a.subject_id AND u.active WHERE a.object = 'design' AND a.subject_kind = 'user' AND a.role = 'designer'")).map((r) => r.subject_id));
                const not = wanted.filter((u) => !designers.has(u));
                if (not.length) fail(`${not.join(", ")} ${not.length > 1 ? "are not designers" : "is not a designer"}: only a designer co-designs a change.`, { fields: { users: "Designers only." } });
                await tx.query("UPDATE mes.change_requests SET co_designers = $2, contributors = ARRAY(SELECT DISTINCT u FROM unnest(contributors || $2::text[]) AS u ORDER BY u) WHERE id = $1", [id, wanted]);
                await audit(tx, user.id, id, "change:codesigners", { before: row.co_designers ?? [], after: wanted });
                return { ok: true, co_designers: wanted };
            });
        },

        // An object's name, changed while it has never been published (§6.2): in this change, with what
        // the change says about it (other objects' references, transactions, screens, roles). Once a
        // version is approved its records, partition and history carry the name, so it stays.
        async "design.renameObject"({ id, from, to } = {}) {
            const user = await designUser(this);
            if (typeof to !== "string" || !named(to)) fail("An object's name is lower case letters, digits and _, starting with a letter.", { fields: { to: "Letters, digits and _." } });
            if (["design", "query"].includes(to)) fail(`"${to}" is reserved.`, { fields: { to: "Reserved." } });
            return db.transaction(async (tx) => {
                const row = await loadChange(tx, id, true);
                if (row.state !== "design") fail("This change is no longer in design.", { status: 409 });
                if (!editorsOf(row).includes(user.id)) fail(`Only its author and co-designers edit this change.`, { status: 403 });
                const content = withKinds(row.content);
                const base = withKinds(row.base);
                if (typeof from !== "string" || !Object.hasOwn(content.definitions ?? {}, from)) fail(`This change has no object "${from}".`, { status: 404 });
                if (from === to) return { ok: true, object: to };
                const [published] = await tx.query("SELECT max(version) AS v FROM mes.definitions WHERE object = $1", [from]);
                if (published?.v) fail(`${from} was approved as version ${published.v}: its records and history carry the name, so it stays. Change its label instead.`, { status: 409, code: "design.name_fixed" });
                const [taken] = await tx.query("SELECT 1 FROM mes.definitions WHERE object = $1 LIMIT 1", [to]);
                const [elsewhere] = await tx.query("SELECT title FROM mes.change_requests WHERE id <> $1 AND state = ANY($2) AND content->'definitions' ? $3", [id, OPEN, to]);
                if (taken || content.definitions[to] || elsewhere) fail(`An object "${to}" exists already${elsewhere ? ` (in “${elsewhere.title}”)` : ""}.`, { fields: { to: "Taken." } });
                const rekey = (obj) => Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [k === from ? to : k, v]));
                content.definitions = rekey(content.definitions);
                content.definitions[to] = { ...content.definitions[to], object: to };
                base.definitions = rekey(base.definitions);
                // What this change says about it, under its new name.
                for (const def of Object.values(content.definitions)) for (const f of Object.values(def.fields ?? {})) if (f?.type === "ref" && f.to === from) f.to = to;
                for (const t of Object.values(content.transactions ?? {})) {
                    for (const input of Object.values(t.inputs ?? {})) if (input?.to === from) input.to = to;
                    if (t.appearsOn?.object === from) t.appearsOn.object = to;
                }
                for (const sc of Object.values(content.screens ?? {})) {
                    for (const p of Object.values(sc.params ?? {})) if (p?.to === from) p.to = to;
                    for (const b of sc.blocks ?? []) if (b?.object === from) b.object = to;
                }
                if (content.organization?.roles?.[from]) content.organization.roles = rekey(content.organization.roles);
                const title = row.title.endsWith(` ${from}`) ? `${row.title.slice(0, -from.length)}${to}` : row.title;
                const [written] = await tx.query(`UPDATE mes.change_requests SET title = $2, content = $3, base = $4, updated_at = now(), updated_by = $5, draft_rev = draft_rev + 1, contributors = ${CONTRIBUTE.replace("$7", "$5")} WHERE id = $1 RETURNING updated_at, draft_rev`, [id, title, JSON.stringify(content), JSON.stringify(base), user.id]);
                await audit(tx, user.id, id, "change:rename-object", { from, to });
                await saved(tx, id, user.id, written.draft_rev, { renamed: { from, to } });
                return { ok: true, object: to, updated_at: iso(written.updated_at), draft_rev: written.draft_rev, problems: await problemsOf(content) };
            });
        },

        // Every change waiting (§5.3): in review (who may review it) or in approval (each department on
        // its route: approved by whom, rejected, or pending at which step and for whom). `mine`: what
        // this person may do on it now.
        async "design.approvals"({ as } = {}) {
            const user = await designUser(this, as);
            const settings = await organizationSettings(db);
            const rows = await db.query("SELECT * FROM mes.change_requests WHERE state IN ('review', 'approval') ORDER BY submitted_at");
            const mayReview = user.designRoles.some((r) => r === "reviewer" || r === "designer");
            const out = [];
            for (const row of rows) {
                const approvals = await db.query("SELECT department, step, user_id, decision, at FROM mes.approvals WHERE change_id = $1 ORDER BY at", [row.id]);
                const departments = [];
                for (const r of row.route ?? []) {
                    if (row.state === "review") { departments.push({ department: r.department, status: "after review" }); continue; }
                    const p = await progressOf(db, row, r.department, approvals, settings);
                    const last = p.steps.filter((st) => st.signed).at(-1)?.signed ?? null;
                    departments.push({
                        department: r.department,
                        status: p.rejected ? "rejected" : p.done ? "approved" : "pending",
                        ...(p.rejected ? { by: p.rejected.user_id } : p.done ? { by: last?.user_id ?? null } : {}),
                        ...(p.current ? { step: p.current.label, stepNo: p.steps.indexOf(p.current) + 1, of: p.steps.length, waitingFor: p.current.eligible, mine: p.current.eligible.includes(user.id) } : {}),
                    });
                }
                const reviewableBy = row.state === "review" ? (await reviewOptions(row.route, authorsOf(row))).fine : [];
                out.push({
                    id: row.id, title: row.title, author: row.author, state: row.state,
                    since: iso(row.submitted_at), lastSigned: iso(approvals.at(-1)?.at ?? null),
                    departments, reviewableBy,
                    mine: row.state === "review" ? mayReview && reviewableBy.includes(user.id) : departments.some((d) => d.mine),
                });
            }
            return { me: user.id, changes: out };
        },

        // The organization as it is live (§27), for its read-only page: people, departments, steps,
        // roles, standing approvers; and the change open on it, if any.
        async "design.organization"({ as } = {}) {
            await designUser(this, as);
            const snapshot = await organizationSnapshot(db);
            // Only an open change of its own is the page's to open; one that holds it as a part of something
            // else (a suite's pack) is said when someone starts a change here (design.start).
            const [open] = await db.query("SELECT id, state, content FROM mes.change_requests WHERE state = ANY($1) AND content ? 'organization' ORDER BY created_at LIMIT 1", [OPEN]);
            return { ...draftOf(snapshot), version: snapshot.version, open: open && orgOnly(open.content) ? { id: open.id, state: open.state } : null };
        },

        // A published script's source, for the script editor.
        async "design.script"({ name } = {}) {
            await designUser(this);
            const [row] = await db.query("SELECT version, source, tests FROM mes.scripts WHERE name = $1 AND status = 'published'", [name]);
            return row ?? null;
        },

        // Problems of a draft that is not saved yet: the designer's continuous check at the server.
        async "design.check"({ definitions, scripts, services, connections, transactions, screens, flows, layouts, elements, organization, retire } = {}) {
            await designUser(this);
            const content = withKinds({ definitions: isPlain(definitions) ? definitions : {}, scripts: isPlain(scripts) ? scripts : {}, services: isPlain(services) ? services : {}, connections: isPlain(connections) ? connections : {}, transactions: isPlain(transactions) ? transactions : {}, screens: isPlain(screens) ? screens : {}, flows: isPlain(flows) ? flows : {}, layouts: isPlain(layouts) ? layouts : {}, elements: isPlain(elements) ? elements : {}, ...(isPlain(organization) ? { organization } : {}), ...(isPlain(retire) ? { retire } : {}) });
            return { problems: await problemsOf(content), ...(await routeFor(content)) };
        },
    };

    // A change's own live views re-run after every lifecycle step; execution also changes what
    // every page draws (definitions, and so lists and forms).
    const changed = ({ id } = {}) => [{ name: "design.home" }, { name: "design.change", where: { id } }, { name: "design.view" }, { name: "design.organization" }, { name: "design.approvals" }, { name: "inbox.mine" }];
    const everything = async function ({ id } = {}, result) {
        const out = changed({ id });
        if (result?.state === "executed") out.push({ name: "defs.list" }, { name: "defs.get" }, { name: "records.list" }, { name: "records.get" }, { name: "transactions.list" }, { name: "transactions.get" }, { name: "screens.list" }, { name: "screens.get" }, { name: "screens.data" }, { name: "popups.for" }, { name: "prefs.get" }, { name: "reports.layouts" });
        return out;
    };
    const touches = {
        "design.start": [{ name: "design.home" }, { name: "design.view" }],
        "design.fromPack": [{ name: "design.home" }],
        "design.save": changed,
        "design.include": changed,
        "design.submit": changed,
        "design.rollbackPlan": [],
        "design.rollback": (_args, result) => [{ name: "design.home" }, { name: "design.change" }, { name: "design.view" }, { name: "design.approvals" }, { name: "inbox.mine" }],
        "design.review": changed,
        "design.approve": everything,
        "design.withdraw": changed,
        "design.codesigners": changed,
        "design.renameObject": changed,
        "design.retractReview": changed,
        "design.script": [],
        "design.organization": [],
        "design.approvals": [],
        "design.check": [],
    };
    async function authorize(name, [args]) {
        const user = await store.userForSession(this?.sessionId);
        if (!user || !isPlain(args) || args.as !== user.id) return false;
        return (await designRolesOf(user.id)).length > 0;
    }
    return {
        services, touches, authorize, queries: ["design.home", "design.change", "design.view", "design.organization", "design.approvals"],
        // For the fitness test: what a change is checked against.
        problemsOf, published, designUser, designRolesOf, waitingFor,
        // A pack that came as a file (model-file.js): what it would change, and the change that does it.
        changeFromPack, packPreview,
        // What a draft screen or transaction may name, as it is live now plus `content`.
        knownFor: async (content = {}) => integrationKnown(await published(), content),
        useFitness(fn) { fitness = fn; },
        useSuiteDesigns(checks) { suiteDesigns = { ...checks }; },
        useSuitePacks(packs) {
            suitePacks = { ...packs };
            allLocks = mergeLocks(CORE_LOCKS, ...Object.entries(packs).map(([name, pack]) => suiteLocks({ name, label: pack.suite ?? name }, pack)));
        },
        locks: () => allLocks,
        // The installed suites' flow node kinds (§32.9), and what to do once a change publishes flows.
        useSuiteFlowNodes(kinds) { suiteFlowNodes = { ...kinds }; },
        useSignatures(given) { signatures = given; },
        useSuiteExtensions(given) { suiteExtensions = { capabilities: { ...given.capabilities }, steps: { ...given.steps }, blocks: { ...given.blocks }, elements: { ...given.elements }, schedules: { ...given.schedules } }; },
        suiteExtensions: () => suiteExtensions,
        // The suite's own check of a schedule from its kind, against what is live (integration.scheduleRuns' preview).
        async scheduleCheck(t) { return isSuiteSchedule(t) ? suiteScheduleCheck(t, await integrationKnown(await published(), {})) : []; },
        onFlowsPublished(fn) { onFlows = fn; },
        flowNodes: () => suiteFlowNodes,
        // A change's content applied to another database (a sandbox's, sandbox.js), by the very path
        // that executes an approved change: versions, partitions, conversions, its audit there.
        executeInto: (q, { id, content, base }) => q.transaction((tx) => execute(tx, { id, content, base, content_hash: sha256(canonical(content)) })),
    };
}
