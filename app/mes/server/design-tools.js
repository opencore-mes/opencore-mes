// The design tools (DESIGN.md §16.8): one registry, two ways in. The REST API (ai-api.js) exposes each
// tool as an endpoint for any AI outside; the in-app copilot (copilot.js) hands the same tools to the
// model it runs. So what an AI can do never differs by the way it came in.
//
// Each tool: { description, scope, input_schema (JSON Schema), run(who, input, agent) }. `who` is the
// person the AI works for ({ user_id, user_name, scopes, name }); every tool runs as that person,
// through the design services, with `via` naming the AI on everything it drafts. No tool reviews,
// approves or executes: those are a person's (§5).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { CALL_KIND } from "@opencore-mes/juris-kit/live-protocol.js";
import { runRules } from "./rules.js";
import { KINDS, CHART_KINDS, CHART_KEYS, TONES as CHART_TONES } from "../client/charts.js";
import { decide, explainDecision } from "./policy.js";
import { FIELD_TYPES, SENSITIVE_TYPES, IDENTIFIER, RESERVED, HTTP_METHODS, AUTH_KINDS, SERVICE_OPS, RECORD_EVENTS, FLOW_ROLES, FLOW_NODE_KINDS, FLOW_KINDS_OF, INPUT_TYPES, tidyLayout, explainFlow } from "../client/definition.js";
import { stepFrom } from "../client/input-flow.js";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const refuse = (message, extra = {}) => { throw Object.assign(new Error(message), { expose: true, status: 400, ...extra }); };

// The published contracts (docs/contracts, §31): what is built on the core from outside it (an equipment
// adapter, a suite), each a specification and a schema, served by name so an agent builds on the
// version the core provides, never on one it remembers.
const CONTRACTS_DIR = new URL("../../../docs/contracts/", import.meta.url);
export function publishedContracts() {
    if (!existsSync(CONTRACTS_DIR)) return [];
    return readdirSync(CONTRACTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(new URL(`${d.name}/schema.json`, CONTRACTS_DIR))).map((d) => {
        const schema = JSON.parse(readFileSync(new URL(`${d.name}/schema.json`, CONTRACTS_DIR), "utf8"));
        return { name: d.name, version: schema["x-contract"]?.version ?? null, title: schema.title ?? d.name, description: schema.description ?? "" };
    });
}
export function publishedContract(name) {
    const found = publishedContracts().find((c) => c.name === name);
    if (!found) refuse(`There is no contract "${name}". The contracts: ${publishedContracts().map((c) => c.name).join(", ") || "none"}.`);
    const read = (file) => readFileSync(new URL(`${name}/${file}`, CONTRACTS_DIR), "utf8");
    return { ...found, specification: read("README.md"), schema: JSON.parse(read("schema.json")), changelog: existsSync(new URL(`${name}/CHANGELOG.md`, CONTRACTS_DIR)) ? read("CHANGELOG.md") : null, kit: existsSync(new URL(`${name}/kit.mjs`, CONTRACTS_DIR)) ? `docs/contracts/${name}/kit.mjs` : null };
}

// The rules a design must follow, for an AI to read before it drafts anything.
export function contract() {
    return {
        summary: "Objects are defined as data: fields, states and transitions, roles, deny-by-default policies, a rule pipe of scripts, a form and a list, and stewards. Every change is a change request: design → review → approval → execution. An AI drafts; people review, approve and sign; the platform executes.",
        identifiers: { pattern: IDENTIFIER.source, reserved: [...RESERVED].sort(), appliesTo: ["object", "field", "state", "action", "role", "script"] },
        // Charts (§34.9): a report's chart block, a screen's chart block. A chart names its kind and which
        // columns of its query go where; it draws only what its query answers.
        charts: { kinds: Object.fromEntries(CHART_KINDS.map((k) => [k, { label: KINDS[k].label, for: KINDS[k].for, needs: KINDS[k].needs, may: KINDS[k].may }])), keys: CHART_KEYS, tones: CHART_TONES },
        fieldTypes: FIELD_TYPES,
        field: { label: "string", type: `one of ${FIELD_TYPES.join(", ")}`, required: "boolean", values: "enum: the allowed strings", to: "ref: the referenced object", options: "ref: its choices from a named query (§23.1), in place of every record of its object: { query: '<query name>', display?: [the query's columns that say each; none: the record's title], params?: { parameter: expression over { data: '<field>' } (the form being filled), { record: '<field>' }, { user: 'id' } } }. The query returns the records' id (a column id); the picker lists its rows as the person may read them, and a save is refused unless the record is one of them. Example: a lot's press from the presses of the lot's line: { query: 'machines_of', display: ['machine_id', 'name'], params: { kind: 'press', line: { data: 'line' } } }", computed: "boolean: may be set by a rule script even where the user may not write it", sensitive: `boolean: health or personal data to protect (a patient's name or id). Masked wherever records are shown or leave (lists, record pages, search, Excel export, screens, the audit trail's values); shown only on its record, to someone who may read it and gives a reason, each showing audited; never in the query views, analytics, AI reports or the copilots. Types: ${SENSITIVE_TYPES.join(", ")}. Never the titleField, an analytics dimension, list.sort, transfer.import.key, flow.step, a transaction input's from, or a screen block's where, sort, measure, breakdown by or floor status. Policies still decide who may read and write it at all.`, accept: "a 'file' field only (§35.4): the kinds of file it takes, of picture, pdf, video, spreadsheet (left out: picture, pdf and video). A file field holds a file's name in the file store (POST /blob, uploaded by a person; at most 5 MB a picture, 10 MB a document, 100 MB a video, MP4 or WebM); it is read only through its record, as the record's reader (GET /file/<object>/<id>/<field>); never sensitive or erasable; it may be derived ('step.instruction'): a lot then shows its step's instruction", erasable: "boolean: holds a person's personal data, which a privacy officer may erase from a record (records.erase, §27.8: replaced by '[erased]' or emptied; the record and its history stay); not on a picture, nor on what People & departments keeps", maxLength: "integer: the longest a text (string, up to 2000) or long text (text, up to 20000) may be, in characters; unsaid, 500. Typing stops there and a save is refused past it", from: "a derived field (§6.11), kept by the platform, never typed or set by a step or a rule: a path through single references, '<ref field>.<field of what it points to>' as many hops as they go ('product.control', 'lot.product.code', a last step 'state' reads that record's state), of the type it reads; or an expression over { record: 'field' } where a field may be such a path ({ \"eq\": [{ \"record\": \"product.control\" }, \"military\"] }). Worked out at every save of its record and again, in the same write, when a record it reads through changes (audited 'derive'); executing the change that adds it fills every record. Never required, sensitive, erasable or computed; never from a sensitive field; no loops. Read like any field: lists, queries, policies, an object's access requirements" },
        states: { initial: "a state in list", list: "the states in order", transitions: "[{ action, label, from: [states], to: state }] — the object's buttons", tones: "{ state: neutral|info|ok|warn|danger } — what a state means, coloured by the plant's theme (on_hold: warn); never a colour" },
        approval: "optional (§28): which changes to records made outside a transaction wait for approval: { edit?: true | { fields?: [field], states?: [state] }, create?: true, actions?: true | [action], archive?: true (archiving and restoring: the MES deletes nothing), by?: { field (a choice, text or yes/no), values: { '<value>': [departments or groups] }, stewards?: 'replace' (unsaid) | 'also' } }. Approved by the stewards of what changes; with by, by the departments and groups of the record's value (a group: any one member signs, never the asker) (the value it has and the one asked, both), in place of the stewards or as well; a value not listed, the stewards",
        scanBy: "optional (§10.4): up to 3 string or integer fields, never sensitive, a scan or a name typed also finds a record by, whole, besides its title (Person is scanned by user, the sign-in id on a badge): ['serial']",
        history: "optional { fields?: [field] (whose changes a record's History tab lists; absent, every field; the state, archiving and approvals always), steps?: false (route steps said as a field changing, not 'Entered <step> (<route>)'), via?: false (the transaction or plan behind a change not named) }: how the history reads, never what the audit trail keeps; a reader may still show every change (§10.10)",
        policies: {
            rule: "{ id, roles: [role], when?: expression, record?: { read, create, archive (archive and restore; an archived record is read-only) }, fields?: { field|'*': 'read'|'write' }, actions?: { action: 'allow' }, deny?: { fields: [field] (no write), read: [field] (hidden), actions: [action] }, via?: [transaction names] (the rule applies only to writes made through those transactions; the object's form never offers them on their own) }",
            combining: "Deny is the default. Grants are unioned across every rule whose roles the user holds and whose condition holds; an explicit deny wins; write implies read.",
        },
        expressions: {
            references: "{ record: 'state' | field } { user: 'id' | 'roles' | 'certifications' | 'departments' (the departments the person belongs to: { in: [{ record: 'department' }, { user: 'departments' }] } keeps each department's records to its people) } { data: field } { event: 'kind' | 'changed' | 'action' }",
            operators: "eq ne lt le gt ge: [a, b]; in: [value, list]; contains: [list, value]; all/any: [...]; not: x; is_null: x",
            example: { in: [{ record: "state" }, ["created", "in_process"]] },
        },
        ruleScripts: {
            shape: "One file per rule; the file name is the function name: export default [async] function <name>(ctx) { …; return ctx; }. Nothing else at the top level, no import.",
            context: "ctx.event { kind: change|save|action|committed, changed: [fields], action, source, prev }, ctx.user (read-only), ctx.record (the stored row, read-only), ctx.data (the values being checked), ctx.now (fixed clock), ctx.lookup(object, id or title-field value) (backend only, the user's rights; the newest in use by its title). Anything added to ctx passes to the next script.",
            reject: "throw Object.assign(new Error('Words for the user.'), { field: 'field' }) — or { fields: { field: message } }. The first throw stops the pipe. A TypeError and other faults show a fixed message instead.",
            writes: "A binding declares the fields its script may change in ctx.data ({ script, writes: [fields] }); any other change fails the pipe.",
            reactOrDisregard: "The pipe runs on every change of state; a script returns ctx untouched when the change is not its concern (check ctx.event.kind and ctx.event.changed).",
            deterministic: "Date is fixed at ctx.now; Math.random does not exist; no network, timers, require or import.",
            binding: "{ script, writes?: [fields], when?: expression, backendOnly?: true (uses lookup), committed?: true (after commit) }",
            test: "{ name, ctx: { event, data, record?, user? }, writes?: [fields], lookups?: { 'object/id': record }, expect?: { data: { field: value } }, throws?: { field?, message? (substring) } }",
        },
        lifecycle: "Changes are drafted in a change request (state design), validated, then submitted by a person (or a token with design:submit). Reviewers and the departments that steward what the change touches approve it; the platform then executes it. One change may hold several designs (objects, transactions, screens, flows, services, connections): start it on one, bring live ones in with add_to_change (new ones are written with save_draft), and it is reviewed once, approved once by each department any of them touches, and executed all or nothing; each design is in one open change at a time.",
        stewards: "{ object: [departments], fields: { field: [departments] }, states: { state: [departments] }, transitions: {…}, policies: {…} } — who approves changes to what.",
        builtIns: "Built-in objects (builtIn: true) are published by the platform in every installation; designers change them like any other. Person: one record per person in People & departments, kept in step with it (its user, name and active are People & departments' own: no policy or rule may write them, nobody makes or archives a Person). Desktop: one record per computer on the floor (its address, and the screen or transaction it opens at sign-in); its address, opens, page and opened_with fields and its rule desktop_address are read by sign-in and stay.",
        locks: "Parts of an object the platform or an installed suite relies on (get_catalog: locks per object): a locked field stays (same type, still required, its choices kept, more may be added); locked states, actions, rules and policies stay; a kept object is not retired. Locks come from the platform and the suites installed, never from the design: validate names what breaks one, and who holds it.",
        fitness: {
            summary: "Submitting runs the fitness test on exactly what is submitted, and refuses a change that fails it; run_fitness runs it on the draft. It fails on validation problems, scripts that do not compile or call what they will not have, a new or changed script without test cases, and failing cases. It warns about existing records the draft would no longer let be saved, and lists access changes per role and state.",
            tests: "content.tests: { <script name>: [test case] }, published with the script.",
            ruleCase: "{ name, run: { event, data, record }, expect: { data?: { field: value }, changed?: [fields], throws?: { message?, field? } } }",
            serviceCase: "{ name, run: { input } | { event: { kind, object, id }, responses: { 'POST /path': { status, body } } }, as?: one of its callers (with runAs 'caller'), expect: { ok?: true|false, output?: {…} (a subset), error?: 'words', writes?: n, requests?: n } } — run as a dry run, with the identity the service will run as",
        },
        transactions: {
            summary: "A transaction is a screen that changes several records as one, all or nothing (move a lot onto a machine: the lot and the machine). It is a design element like a service (content.transactions), approved by its stewards and by the stewards of what its steps write. Nothing in the platform knows the domain: move-in, track-in, track-out and move-out are transactions a designer draws.",
            shape: "{ name, label, description, inputs: { name: { label, type (a field type, or 'rows': a table, with fields: { name: { label, type: string|integer|decimal|boolean|date|enum } }, min?, max?), required?, values? (enum), to? (ref), options? (ref: its choices from a named query, as a field's options: { query, display?, params?: expressions over { input }, { lookup: '<ref input>.<field>' }, { user }, { node: '<route step setting>' } }; a run is refused unless the record entered is one the query gives the person; not for an input filled in from another), multiple?, requiredWhen?: expression over { data }, from?: '<ref input>.<its field>' (filled in from that record, shown not typed: a ref input from a ref field to the same object, any other type from a field of its type, its value copied as the person reads it; that input may itself be filled in, not in a circle; never from a sensitive field), sensitive?: true (an input a step sets into a sensitive field must be: the run's audit entry keeps that it was given, not what) } }, form?: { sections } | { tabs } (the form layout over the inputs; widget 'scan' reads a record by its title, as a barcode scanner types it), appearsOn?: { object, states?: [states], fills: <ref input to that object>, when?: expression over { record: 'field' } } (a button on those records, where when holds), require: [{ that: expression, message, field?: input }], steps: [{ on: <ref input>, set?: { field: expression }, action?: <a transition of that object>, when?: expression } | { create: <object>, set: { field: expression }, forEach?: <rows input> (once per row, read as { row: 'field' }), when?: expression } | { find: { object, where: { field: expression | null (empty) | [values] }, limit?: 1..100 (20) }, as: <a name>, set?, action?, when? } (the records of that object whose fields equal what the run works out, that the person may read, in use, the oldest first; each set and acted on like an input's record; the steps after it read { found: '<as>.count' } and { found: '<as>.first.<field>' })] (a created record goes through its object's own policies, rules and validation), confirm?: true (show what will change first; the default), signature?: { meaning, verifier?: { meaning, departments?: [ids], roles?: ['<object>.<role>'] } } (verifier: a second person signed in beside the one running it, of one of those departments or roles, verifies it; both re-enter their passwords at every submit; a scenario step's sign names the verifier: sign: { meaning, agree: true, verifier: '<user>' }), scenarios?: [{ name, records: { key: { object, id?, where? } (picked from live) | { object, data, state? } (given) }, steps: [{ as?: user, do: { transaction, input, sign? } | { action, record: '@key' } | { update: '@key', data } | { create: object, data, key? } | { service, input } | { screen, arg? }, expect?: { ok, error, states: { key: state }, fields, created: { object: n } } }] }] (its evidence, kept with each version; values '@key' name a record; a new or changed transaction needs a passing one, run by the fitness test in a sandbox), maximize?: 'toggle' (a Maximize button on its screen sets the navigator, top bar and tabs aside: a tablet at a machine) | 'start' (it opens so), inputFlow?: '<an input flow>' (how it is filled from the keyboard: the flows section's input), callers: { users, groups, services?: [the services whose scripts may run it, as their own service role; not with a signature], flows?: [the routes that run it at every step (their everySequence), as themselves; not with a signature] }, http?: { enabled: true } (published over HTTP, §25.7: POST /svc/v1/<name> runs it and POST /svc/v1/<name>/preview says what it would change, as the token's person (scope transaction:run), who must be among its users or groups; a ref input as its record's id or title; never with a signature, never one only routes or services run; its name no web service or query published over HTTP may have), deprecated?: { since, sunset, successor?, note? } (its web callers' notice, as a service's), stewards: [departments] }",
            expressions: "A transaction's expressions read { input: name } (a ref input is its record's id), { lookup: 'machine.capacity' } (a field of the record an input names), { user: 'id' }, { user: 'departments' } (the departments the person running it belongs to: { in: [{ lookup: 'tool.department' }, { user: 'departments' }] }), { user: 'certifications' } (the certifications the person running it holds today, a list: { contains: [{ user: 'certifications' }, 'cnc_router'] } for a step only a certified person does; a scenario's sandbox holds only those its records make, a certification record for the Person it finds), and { count: { object, where: { field: expression | [values] } } } (records in use); with add, sub, mul and div (div is empty when dividing by 0: a yield is { div: [good, { add: [good, reject] }] }) besides the usual operators, and { some: [{ input: <rows input> }, condition] } / { every: [...] } over a rows input, the condition reading each row as { row: 'field' }. They read the records as they were before any step, and are worked out again under lock when it runs.",
            steps: "Each step writes one record through that object's state machine, policies, rule pipe and validation, as the person running it with via = this transaction's name: the object needs a policy with via: [name] that grants the fields it sets and the action it takes. Steps run in order; a later step sees the record as earlier ones left it. set runs before action within a step.",
            example: "move_in: inputs { lot: ref lot, machine: ref machine }, require [{ that: { lt: [{ count: { object: 'lot', where: { machine: { input: 'machine' }, state: ['at_machine','processing'] } } }, { lookup: 'machine.capacity' }] }, message: 'The machine is full.', field: 'machine' }], steps [{ on: 'lot', set: { machine: { input: 'machine' } }, action: 'move_in' }, { on: 'machine', action: 'load', when: { eq: [{ lookup: 'machine.state' }, 'idle'] } }]",
        },
        organization: {
            summary: "People & departments are one design element (content.organization), changed through a change request: departments with their members and their approval steps (signed in order, each by a different person, never the author or the reviewer), people, groups, who holds each role on each object (and on the pseudo-objects design and query), the governance department, and standing approvers (departments that approve every element of a kind, whoever stewards it). A department's change is approved by its own approvers and governance; roles on an object by its stewards; people by governance and their departments.",
            shape: "{ governance: department, standing: { object|script|service|connection|transaction|screen|organization: [departments] }, users: { id: { name, active } }, departments: { id: { name, email? (its mailbox, told when a change to a record waits for it), members: [users], approval: [{ label, approvers: [users] }, …] } }, groups: { id: { name, email? (its mailbox, told when a record change waits for the group), members: [users from any departments] } } (a group holds roles, and approves a record's changes where an object's approval.by names it: any one member signs), roles: { object: { role: ['user:olga', 'group:production'] } }, readers?: ['user:<id>' | 'group:<id>'] (who reads every object's records, those to come included: read only, every field but one a policy hides; governance approves), formats?: { locale, date, time, firstDay, timeZone }, retention?: { records|audit|events|conversations|saved|sign_in|integration|answers: days | 'forever' } (how long each kind of data is kept; a kind left out keeps its default; records and the audit trail are never purged, the audit trail kept at least six years and as long as the records; governance approves), theme?: { scheme: 'choice' (each person picks light or dark) | 'light' | 'dark' (the plant's, nobody picks), name, scope (the top bar's), colors?: { light|dark: { accent|ok|warn|danger|header|headerInk: '#rrggbb' } } (header, headerInk: the top bar's background and text; dark falls back to light's) (each must read at 4.5:1 or better; validate says which does not) } } — start_change with organization: true gives the whole current organization as the draft; save_draft the whole of it back.",
        },
        flows: {
            summary: "A flow template (content.flows, §32) is what the Flow designer draws: a route a traveler (a lot) goes through step by step, or a plan (an OCAP) an event sets off. Its nodes are wired to one another; each run of it carries a context (the template's initial values, its records, what its scripts put there) that its decisions read. Approved by its stewards, by the stewards of the transactions it offers, and of the objects its own identity may write. Only objects whose design says they take part (flow: { as: [roles] }) may be named, as what they take part as. A route moves after a transaction commits, never inside it; what the template itself writes (a step, a state, its scripts' writes) goes through the records' own policies and rules, as the template (its roles).",
            optIn: `On an object: flow: { as: [${FLOW_ROLES.join("|")}], step?: <a text or choice field> } (a traveler's step field: the sequence it is at. A route marks it on entering a sequence; any write that moves it (a transaction, a form, an import) moves the route there, off its wires if need be, audited. Its policies must let the template write it).`,
            shape: "{ name, label, description, kind: 'route'|'plan'|'input', participants: { key: { object, as, from?: '<key>.<ref field>' } } (a route: one traveler, at most one resource), context?: { name: initial value }, ends?: { when: expression } (checked after each write to the traveler: merged, scrapped), nodes: { id: node }, edges: [{ from, to, when?: expression (an auto decision's), label?: a manual decision's choice, retry?: true (a retry wait's way back) }], layout: { id: { x, y } }, roles: { object: [roles] } (what the template's own identity may do), stewards: [departments] }",
            nodes: `Kinds: ${FLOW_NODE_KINDS.join(", ")}; a route draws ${FLOW_KINDS_OF.route.join(", ")}; a plan draws ${FLOW_KINDS_OF.plan.join(", ")}; an input flow draws ${FLOW_KINDS_OF.input.join(", ")} (see input); and the installed suites' (get_catalog flowNodes, each extending one of them, with its own settings). Every node: { kind, label, onEnter?: script, onExit?: script }. start { when?: expression, due?: a date field of a plan's subject, again?: true } (one per template; a route: a traveler made where it holds starts, at the sequence its step field names if it is part-way; a plan: due sets it off when that date arrives (today in the plant or earlier), with no write; again lets it set off again for a record once its last run there has ended). sequence { offers: [transactions appearing on the traveler], leaves: [those of them that take it on], resource?: { field: [values] } (only such resources here), settings?: { key: value } (its transactions read { node: 'key' }), state?: a state of the traveler to mark on entering, screen?, guide?: where it is in the route's guide, a PDF's page '3' or a video's time '0:45' (a screen's media block with route: { flow, of } shows these sequences as its steps, §35.4) } (the node's id is the value its step field takes). auto_decision {} (its wires' when, in order; the last may have none: otherwise). manual_decision { message?, for: { users, groups } } (its wires' labels are the choices). wait { message, seconds, mode: 'auto'|'acknowledge'|'retry', for? }. input_screen { message?, for, fields: [{ name, label, type: ${INPUT_TYPES.join("|")}, values?, required? }] } (a list, in the order the screen shows them; into the context under each name; a field of type 'query' draws a dropdown from a named query (see queries): { query: '<name>', value: '<column kept>', display?: ['<columns shown, joined>'], separator?: ' · ', params?: { <its parameter>: expression over { context: … } and { user: 'id' } } }, its options worked out as the person filling it in may read them, the value sent checked against them again). sub_flow { flow, pass?: { name: expression }, returns?: { name: '<its context name>' } } (never in a circle: sub flows that lead back to the template, through others too, are refused). end { outcome? }. A plan starts on its own when a record of its subject is made or written where its start's condition holds (and its due date, if it names one, has arrived), or when that date arrives: once per record, or again after each run when its start says again; one whose start has neither a condition nor a due date runs only as a sub flow. Its context also holds route: { flow, label, step, step_label }, the route its records were on when it was set off.`,
            scripts: "onEnter and onExit name rule scripts (content.scripts, with their test cases): ctx { event: { kind: 'enter'|'exit', node, label, flow }, context: { values…, <participant>: its record }, writes: [] } in, the same out. Values it sets in context are kept on the run; each of writes ({ record: <participant>, action } or { record, set: { field: value } }) is made after, as the template, through the record services: the object's own lifecycle decides. Prefer declarative (a sequence's state, a decision's wires); a script is the escape hatch.",
            expressions: "A template's conditions read its context: { context: '<participant>.<field>' } or '.state', or { context: '<value>' }, with the usual operators. A transaction run on a traveler of a route also reads { node: '<setting>' } (and node.name, node.label) of its sequence.",
            rules: "One start; every node reachable from it; every node but an end goes on: a start, sequence, wait, input screen or sub flow by one wire, an auto decision by wires with conditions (the last may have none), a manual decision by labelled wires; a sequence leaves only on what it offers; nothing leaves an end or leads back to the start. A transaction a route offers anywhere is refused on a traveler at a sequence that does not offer it, and on a resource its sequence does not allow.",
            scenarios: "scenarios: [{ name, records, steps }] as a transaction's (its evidence, kept with each version), each step may also answer a plan ({ act: { record: '@key', plan?, values? | choice? | action: acknowledge | retry | time_up } }; time_up passes a wait's time, in a sandbox only) and expect { node: { key: node } } (the node of this template the record's run reached). A new or changed template that sets off on its own (a route; a plan whose start has a condition) needs a passing one: the fitness test runs it. Try one with try_scenario before proposing it.",
            input: "kind 'input' (§32.13): how a transaction or a screen is filled from the keyboard or a scanner, without a mouse; named by any number of them (a transaction's or a screen's inputFlow: '<flow name>'). No participants, no context, no scenarios, no scripts. Nodes: start; ask { input: a transaction's input by name, or on a screen 'param' (what it is opened with) or '<transaction>.<input>' (the name alone when the screen has one transaction block), prompt?, advance?: 'enter' (default; a scanner's too) | 'tab' | 'enter_or_tab' | 'key' (key: 'F1'..'F12' or one non-letter, non-digit character: a scanner's suffix) | 'auto' (by itself: a scan that found its record, a choice picked, or the entry reaching length characters or matching pattern), skipIfFilled? (default true: an input the screen, a row or a fill filled is passed over), onError?: 'stay' (default: the cursor stays while its field shows an error or it is required and empty) | 'go' }; fill { input, value: expression }; auto_decision (its wires' when); run { transaction? (on a screen with several), confirm?: 'ask' (default: Check, then Enter on Confirm) | 'auto' (confirmed once checked; a signature is always asked) }; end { then?: 'repeat' (default: back to the start for the next one) | 'stop' }. Its expressions read { input: '<name>' }, { lookup: '<input>.<field>' } (or .state), { param: '<name>' }, { user: 'id' }. Without an input flow, a form goes input to input by Enter in its layout's order, Check and Confirm by Enter, Esc back, and stays on an input whose field shows an error. walk_input_flow walks one with sample values.",
            subRoutes: "A route may run another route (§32.14): a sub_flow node { flow: '<a route for the same traveler object>', pass?, returns? } wired in like a step. The traveler goes through that route's sequences (its step field names them) and comes back to this route's next node when it ends. A route with asSub: true runs only inside another: it takes up no traveler by itself and needs no scenario. A route's everySequence: { onEnter?: { run: '<transaction>' }, onExit?: { run: '<transaction>' } } runs that transaction on its traveler, as the route (its roles), each time the traveler enters any step or leaves one (the step field still naming the step it leaves): what to do at every step said once, such as holds set ahead for a lot at a step (a transaction that finds them, uses them and holds the lot); the transaction appears on the traveler's object, names the route in callers.flows, and is not signed; the route's scenarios prove it. A route runs routes, a plan plans; never in a circle. Draw a shared segment (a rework loop, a test segment) once and run it from each route that needs it.",
            tools: "get_flow, check_flow (problems by node and wire, and what is missing to run it), layout_flow (places the nodes; Tidy on the canvas does the same), explain_flow (the template in plain words, for you and the reviewers), try_scenario (a scenario run on the draft in a sandbox, nothing saved), walk_input_flow (an input flow walked with sample values: what it asks, fills and runs, in order). Draft with start_change({ flow }) and save_draft({ flows }); start_change({ flow, from }) starts one as a copy of a live one (another process's OCAP).",
        },
        queries: {
            summary: "A named query (content.queries, §23.1) is one SELECT over the query views (get_schema of the query page: one view per object, its columns the fields a person may read), with typed parameters by name (:family), designed, reviewed and approved like a screen. It runs as the person it is for: it grants nothing, it never sees a sensitive field. Used by: a plan's input screen's dropdown (flows: input_screen, a field of type 'query'); a reference's choices (an object's field or a transaction's ref input: options { query, display?, params? }; the query must give an id column); and a screen's table of its rows (block table with query). What each names of its columns is checked against the columns it gives (described without running it): a change that takes a column away names every design that shows it, even one not in the change, and design.align (the designer's Align) brings those in, put right where plain. A change that takes a field from an object names each query that reads it.",
            shape: "{ name, label, description?, sql: 'SELECT … WHERE family = :family', params: { family: { type: 'string'|'integer'|'decimal'|'boolean'|'date', label?, required? } } (every :name declared, every one declared used; never $1), limit?: 1..1000 (200), tests?: [{ name, params: { family: 'die_attach' } }] (the fitness test runs each as the submitter: it must run, and give the columns the lists drawn from it name), http?: { enabled: true, callers: { users, groups } } (published over HTTP, §23.3: GET /svc/v1/<name>?family=… reads a page of its rows as the token's person (scope query:run), who must be among these callers; its name no web service or transaction published over HTTP may have), deprecated?: { since, sunset, successor?, note? } (its web callers' notice), stewards: [departments] }",
            example: "tools_of_family: sql \"SELECT id, tool_no, family FROM machine WHERE family = :family AND state <> 'down' ORDER BY tool_no\", params { family: { type: 'string', label: 'Equipment family', required: true } }, tests [{ name: 'die attach', params: { family: 'die_attach' } }]; in a plan: { name: 'tool', label: 'Tool', type: 'query', query: 'tools_of_family', value: 'id', display: ['tool_no', 'family'], params: { family: { context: 'product.equipment_family' } }, required: true }.",
        },
        layouts: {
            summary: "A report layout (content.layouts, §34.5) says how an AI report is laid out: which blocks, in which order, how wide, and what each is for. It holds no query and no data. Once live, whoever asks the analytics copilot for a report may pick it, and the copilot fills it from what that person may read; a report that departs from it is not drawn. Approved by its stewards.",
            shape: `{ name, label, description?, guidance?: words for the analytics copilot about the whole report (the period, what matters, the tone; at most 2000 characters), scope?: { object, by?, values: [what each record is called, 1..50] } with goal: words (an AI assisted line, §34.6: the whole report is about those records, a line's equipment, and says what must be processed, in which order, to meet the goal; copy the layout with other values for another line), blocks: [1..12 of { block: 'text' | 'figure' | 'chart' | 'table' | 'media' (a file the person attaches, shown: a picture, or a document to open, §34.10) | 'assist' (an AI assisted line, §34.6: advice on a set of records toward a goal; it alone names records, and takes scope: { object, by?: a field (left out: the object's title field), values: [what each record is called, 1..50] } and goal: words, what is to be achieved with them and where the targets are found; copy the block with other values for another line), title?: kept as written on every report (without one the copilot titles it), width?: 'quarter' | 'third' | 'half' | 'full' (of a 12-column row; left out: a figure a quarter, a chart half, text and tables full), chart?: one of ${CHART_KINDS.join(', ')} (a chart block only; left out, the copilot chooses; get_contract charts: what each is for and needs), hint?: what belongs there, in words (what, over which period, in which order; at most 500 characters) }], stewards: [departments] }`,
            example: "daily_report: guidance 'Cover the last 24 hours. Lead with what needs action.'; blocks: text full (hint: the situation in three sentences), figure quarter 'Lots released' , figure quarter 'Lots on hold', chart half line (hint: lots released per day, the last 7 days), chart half bar (hint: lots on hold by reason), table full 'On hold' (hint: lot, reason, since when; longest first)",
        },
        screens: {
            summary: "A screen is a page of fixed building blocks (content.screens), approved by its stewards. Its buttons write only through the record services and transactions, as the viewer; every block reads with the viewer's own rights, so it never shows more than their forms would. Nobody opens it until callers name them.",
            shape: "{ name, label, description, params: { machine: { label, type: ref|string|enum|date, to? (ref), widget?: scan|select, search?: true | { show: [up to 6 fields] } (a scanned ref: a whole label opens it, a part typed lists the records holding it counted by state, each a click from opening the screen on it), where?: { field|'state': [values] } (a ref: only such records open it and are listed: a die saw's screen, die saws) } } (at most one: what it is opened with, /s/<name>/<value>), blocks: [block], maximize?: 'toggle' | 'start' (as a transaction's), oneTab?: true (a screen with a parameter, worked all day: each record it is opened on stays in its one tab, named after the screen, and its input flow's end with then 'repeat' goes back to the scan, its label kept above the next prompt; with the parameter required: false the screen shows its blocks before a scan), inputFlow?: '<an input flow>' (over its param and its transaction blocks' inputs: the flows section's input), popup?: { on: ['transaction:<name>' | 'screen:<name>' | '*'], for: { users, groups }, while: expression, with?: expression } (it opens by itself as a dialog over those pages, for those people, while the condition holds over the page: a transaction's { input }, { lookup: 'input.field' }, a screen's { param }, { user }, counts; and closes when it stops holding. It decides nothing: what must not happen is refused by the transaction's require), callers: { users, groups }, stewards: [departments] }",
            blocks: "Each { block, title?, width?: 3..12, tab?: a label (blocks with the same tab share it in a tab bar; blocks with none stay above the tabs: a station screen with Move in, Track in, Track out and Move out, each a transaction block), showWhen?: condition (while it does not hold the block is not drawn and not read), enableWhen?: condition (while it does not hold the block is greyed and unusable; a tab all of whose shown blocks are so is greyed), disabledBecause?: the reason in words (only with enableWhen) }. A block's condition reads { param: name }, { lookup: '<param>.<field>' } (a field or the state of the record the screen was opened with, e.g. { eq: [{ lookup: 'equipment.state' }, 'idle'] }), { user: 'id' | 'name' | 'departments' } and { count: { object, where } }; it is for what the screen offers, not for who may do it (a transaction's callers and require still decide). And: record { object, of: expression (a record id, e.g. { param: 'machine' }), show: [fields|'state'] }; table of a named query's rows (§23.1) { query: '<query name>', params?: { parameter: expression over { param }, { user } }, columns?: [the query's columns; none: all but id], sort?: { field: one of its columns, dir }, limit?, pageSize?, object?: whose records the query's id column names (a row links to its record, and offers rowActions, transactions appearing on that object; a row offers one only in its appearsOn states when the query gives a state column), rowActions?, rowActionsIn? } (no where, create or archive: its query says which rows); table { object, where?, columns: [fields|'state'], sort?: { field, dir } (text sorts with numbers in number order), limit?: 1..1000 (200: the rows it holds), pageSize?: 5..200 (25: drawn at a time, more as scrolled), create?: true (a New button, for whoever may create one), archive?: true (a Remove button on each row: archives it, for whoever may; the record services as the viewer, through policies and rules), rowActions?: [transactions that appear on that object; a row's button runs it inline], rowActionsIn?: 'below' (unsaid: the row button's form under the table) | 'panel' (in a panel over the screen, the list in sight behind it), fills?: { input: expression } (inputs its row buttons fill in besides the row, locked: { equipment: { param: 'equipment' } } on Move in) }; kpi { object, where?, measure: 'count' | { sum|avg|min|max: number field }, since?: today|7d|30d, label }; breakdown { object, where?, by: field|'state', measure, since? }; chart { query: { sql } | { json } | { named: '<named query>', params?: { parameter: expression over { param } and { user } } } (over the views of the Queries page, run as the viewer; a JSON query's where may say { param: '<name>' } for the screen's parameter; a named query is the formula approved once, read by every chart and table that names it), chart: a kind, and which columns go where, as a report's chart block has them (§34.9: chart, x, y, series, size, value, source, target, path, open, high, low, close, lines, stack, horizontal, smooth, step, labels, log, unit, bins, min, max, marks, bands) }; transaction { name, fills?: { input: expression }, closeOnDone?: true } (its form, embedded, those inputs set and locked; closeOnDone closes the dialog it is shown in once it runs); text { text } (at most 2000 characters: lines for paragraphs, '- ' for a list, **bold**, '# ' a heading, [words](https://…) or [words](/s/<screen>) a link; drawn as text, never markup); plan { of: expression (a record's id, usually { param: 'tool' }), flows?: [plan names] } (the step that record's running plan waits at, drawn as its own page draws it: the form for those it is for, the cursor in it; whom it waits for to anyone else); a transaction block is left out for a viewer who may not run it, so one screen can serve two kinds of people; runs { transactions: [names], limit?: 5–200 (50), mine?: true } (what was done lately with those transactions, from the audit trail, newest first: when, who, the records each moved as the viewer may read them, their state's way and the fields set; a desk's history: showWhen { is_null: { param: 'tool' } } shows it while no record is open); button { opens: screen, label?, with?: expression (that screen's parameter) } (opens that screen as a dialog over this one, for those who may open it); media { object, of: expression (a record id), field: a 'file' or 'image' field of that object, a derived one included (a lot's step's work instruction, from: 'step.instruction'), stepsField?: a text field of the same record holding its steps, height?: 160..1600, pauseAtSteps?: false } | { file: a file's 64-character name in the file store, name?, steps?: its steps as text, height?, pauseAtSteps?: false } (steps: a line each, '3 Torque crosswise' for a PDF's page or '0:45 Clean the seal' for a video's time; at the screen, big Previous/Next by step, a PDF drawn a page at a time, a video's step stopping at its end). Its steps marked done: done?: { transaction (records a step done; one a second person verifies asks for them beside the operator; a step done is undone by archiving its record, for whoever may), step: its integer input taking the step's number (1, 2, … as written), fills?: { input: expression } (e.g. { lot: { param: 'lot' } }), evidence?: its image or file input for #photo/#file steps, log: { object (the records that say a step is done: the transaction creates one; the equipment, a flow or another transaction may too), where: { field: expression } (whose: { lot: { param: 'lot' } }), step: its number field }, gate?: true (Next only once the step in view is done) }; each step line may end with how it is done: #click (default), #value:<input> (a value typed or scanned into that input), #photo or #file (into evidence; #photo:<input>, #file:<input> for another), #device (the equipment), #wait (another transaction, a flow), #screen:<name> (on that screen, which the step opens). Or route?: { flow: a route template, of: expression (the traveler) } instead of steps and done: its steps are the route's sequences that say guide: '3' or '0:45' (where they are in this file), ticked once the traveler has gone on, the one it is at marked; they are done by the sequence's transactions (§35.4: a picture shown, a video played, a PDF read in the page; a record's is read as the viewer, its access deciding; the screen's own file is uploaded by a person in the designer, POST /blob: you cannot upload one, so leave file as you find it and say what needs uploading).",
            floor: "A floor layout block (§35): { block: 'floor', object, status: 'state' | a choice, yes/no or short text field, colours?: { value: one of neutral, info, ok, warn, danger, c0..c7 } (the legend; a state left out takes its tone), image: { blob, w, h } (the floor's picture: uploaded by a person in the designer, POST /blob; you cannot upload one, so leave image as you find it and say that it needs uploading), picture?: an image field of the object, or 'ref.field' through a reference (its model's picture), places: [{ of: what the record is called (its title field), x, y (its top left corner, fractions 0..1 of the floor), w (its width, a fraction of the floor's), ix, iy (where its small status square sits on it, fractions of its own size) }] (at most 200) }. Each placed record the viewer may read is drawn where it stands, its square in its status's colour, live. Arranging is done by dragging in the designer; you may place records on a grid for a start.",
            where: "{ field|'state'|'type': expression | [values] }: records in use whose fields equal them. Expressions read { param: name } and { user: 'id' }.",
            example: "work_centre: params { machine: ref machine, widget scan }; blocks: record of { param: 'machine' }; table of lots where { machine: { param: 'machine' }, state: ['processing'] } with rowActions ['track_out']; transaction move_in with fills { machine: { param: 'machine' } }",
        },
        suites: {
            summary: "Installed suites add to designs through generic extension points (get_catalog: suiteCapabilities, suiteSteps, suiteBlocks, suiteSchedules, flowNodes). A design may use only what an installed suite gives; with the suite removed the design stays, labelled, and says what it needs where it is used.",
            capabilities: "A service's script reaches a suite as ctx.<suite>.<name>(args) only if its design allows it: uses.suites: { <suite>: [names] } (get_catalog suiteCapabilities lists the names). In a dry run and in test cases nothing outside is touched: the call is reported under `suites`, answered as the suite says a dry run answers, or null.",
            steps: "A transaction step of a suite's kind: { step: '<suite>.<kind>', <setting>: value or expression, when? } (get_catalog suiteSteps: each kind's settings, which are needed, and whether it is irreversible). It writes no record itself. One that cannot be taken back comes after every other step.",
            blocks: "A screen block of a suite's kind: { block: '<suite>.<kind>', title?, width?, tab?, showWhen?, <setting>: value } (get_catalog suiteBlocks).",
            schedules: "A service's schedule whose times a suite works out (a calendar only it keeps): { schedule: { from: '<suite>.<kind>', <setting>: value, tz? }, missed?, overlap? } in the service's on (get_catalog suiteSchedules: each kind's label, settings and which are needed). It has no every, at, between or days. The suite checks its settings; validate and save_draft answer its problems. With the suite removed the service stays published and nothing is planned for that schedule until the suite is back.",
            installed: "get_suites: the suites installed here, each with its version and, where the plant has signed in to the suites registry, a newer one (newest, update: the command IT runs); what it gives designs (capabilities, steps, blocks, schedules, elements, flowNodes, designPart); its design pack against what is live (designs: version, counts new/changed/same, differ: which, open: the changes holding any); its set-up guide (guide: how a plant takes it in, step by step and by who); and its history: every version run here, the one run most lately first, with when it first and last ran, what each gave, and whether it is kept on disk (kept: the versions opencore-mes suite use brings back). removed: suites that ran here and are not installed now, their last version and the command that has them back (back). And needs: what every live design needs from suites, each given or not, with why (the suite is not installed, or its version gives no such thing) and, where an earlier version gave it, lastGiven (that version, when it last ran, and back: the command that returns to it); broken lists those not given.",
            support: "Helping a person set a suite up: answer from its guide (get_suites, guide), in its order and naming who does each step; what it gives designs is what get_suites says it gives, nothing else. Helping with an integration: read the published contracts (get_contract with a name) and the installed suites' kinds, and draft only through them.",
            versions: "A newer version of a suite (get_suites: newest): say so, with what IT runs (update) and that a restart follows, the version it replaces kept (opencore-mes suite use <name>@<version> goes back). After an update, read get_suites again: a design pack that now differs from what is live (designs.differ) is offered in the designer under Suites (Design → Suites), as a change a designer starts and people approve (you cannot start it from a pack); a need no longer given (broken) is a design to change: draft the change that stops using what the suite no longer gives (add_to_change, save_draft, validate), or name the version that last gave it (lastGiven: its version, when it last ran) and the command IT runs to go back (back), and what going back would lose of the newer version (compare history[].gives). Never claim a suite, or a version of it, gives what get_suites does not list.",
            elements: "A design element of a suite's own kind (content.elements): { name, kind: '<suite>.<kind>', label, description?, stewards: [departments], …what the kind adds } (get_catalog: suiteElements, the kinds, each with its `contract`: what the kind adds, in the suite's words; elements, the published ones). Started with start_change { element, kind }, saved with save_draft { elements }, approved by its stewards. The suite checks what its kind adds; validate and save_draft answer its problems.",
        },
        integration: {
            summary: "Services and connections are design elements, changed through the same change requests (content.services, content.connections) and approved by their stewards and by the stewards of what they reach. Deny by default: nobody may call a service, and no service may reach an object or a connection, until an approved change names them.",
            connection: `{ name, label, baseUrl: 'https://…', auth: { kind: ${AUTH_KINDS.join("|")}, secret: name (its value is set on the server, never in a design), header? (kind header) }, allow: [{ method: ${HTTP_METHODS.join("|")}, path: '/confirmations' | '/orders/*' }], timeoutMs?: 100..30000, stewards: [departments] }`,
            service: `{ name, label, description, input: { field: { label, type (a field type), required, values? } }, http: { enabled } (POST /svc/v1/<name>), deprecated?: { since: 'YYYY-MM-DD', sunset: 'YYYY-MM-DD' (later), successor?: another web service, note? } (its callers' notice: every call then answers with Deprecation, Sunset and Link headers; a change that would break callers of the last 30 days needs it, past its sunset, or a new name), callers: { users: [ids], groups: [ids] } (who may call), on: [{ object, event: ${RECORD_EVENTS.join("|")}|transition:<action> } (after commit, retried) | { schedule: { every: { minutes: 1..720 } | { hours: 1..24 }, between?: ['HH:MM', 'HH:MM'], days?: [mon..sun], tz? } | { at: ['HH:MM'], days?, tz? } | { from: '<suite>.<kind>', <setting>: value, tz? } (an installed suite's kind, get_catalog suiteSchedules), missed?: none|last|all, overlap?: skip|queue }] (triggers; a schedule has no caller), runAs: "service" (default: its own identity service:<name>) | "caller" (not with triggers) | a user id, roles: { object: [roles that object declares] } (its service role, with runAs "service"; approved by those objects' stewards), uses: { connections: [names], objects: { object: [${SERVICE_OPS.join("|")}] }, transactions?: [the transactions its script may run; run as its own service role, each transaction's callers.services must name it; never a signed one] }, stewards: [departments] }`,
            identity: "A service acts as its identity (runAs), resolved alike for real runs, dry runs and test cases: its own service role holds exactly the roles in `roles`, on behalf of its caller or event (the audit says so). Give it the least roles that let it do its job.",
            dryRun: "dry_run executes a draft service or rule script with everything it may call callable and nothing changed: run it before handing a draft over.",
            script: "A service's script is scripts[<service name>], with the rule-script contract (export default async function <name>(ctx) { …; return ctx; }). ctx.input (checked against input), ctx.event ({ kind, object, id, by } for a trigger), ctx.user, ctx.now, ctx.output (what the caller gets). ctx.records.get/list(object, where?)/create(object, data)/update(object, id, data)/action(object, id, action)/archive(object, id)/restore(object, id): as ctx.user, through the object's policies and rule pipe. ctx.http(connection, { method, path, query?, body? }) → { status, ok, body }: only requests the connection allows. ctx.transactions.run(name, input, { key? }) → { run, changes, records }: a transaction in uses.transactions, all or nothing, through its checks and its steps' policies and rules, as ctx.user (a refusal throws with its words and fields; key, at most 60 characters, makes a retried run answer the first); in a dry run it is planned, not run. Throw with words to refuse (422 to a caller); throw with { retry: true } when the other system is down (a trigger is retried).",
        },
    };
}

// A design service called as the person the AI works for; `via` names the AI on what it drafts.
const asCaller = (who, agent) => ({
    [CALL_KIND]: "direct",
    apiUser: { id: who.user_id, name: who.user_name },
    via: { token: who.name, agent: String(agent || who.agent || "unnamed AI").slice(0, 80) },
});

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description) => ({ type: "string", description });
const loose = (description) => ({ type: "object", description });

export function designTools({ store, services }) {
    const call = (name, who, args, agent) => services[name].call(asCaller(who, agent), args ?? {});
    const need = (who, scope) => {
        if (!who.scopes.includes(scope)) throw Object.assign(new Error(`This token lacks the scope ${scope}.`), { expose: true, status: 403, code: "scope.missing" });
    };
    async function scriptsOf(overrides) {
        const out = new Map(await store.scripts());
        for (const [name, source] of Object.entries(isPlain(overrides) ? overrides : {})) {
            if (source === null) out.delete(name);
            else out.set(name, { version: `draft-${createHash("sha256").update(String(source)).digest("hex").slice(0, 12)}`, source: String(source) });
        }
        return out;
    }
    const baseCtx = (ctx = {}, object = "test") => ({
        event: { kind: "change", object, action: null, changed: [], source: "test", prev: {}, ...(ctx?.event ?? {}) },
        user: { id: "test", roles: [], ...(ctx?.user ?? {}) },
        record: ctx?.record ?? {},
        data: ctx?.data ?? {},
        now: ctx?.now ?? "2026-01-01T08:00:00.000Z",
    });
    const lookupFrom = (map) => async (object, id) => (isPlain(map) ? (map[`${object}/${id}`] ?? null) : null);
    const subset = (want, have) => Object.entries(want ?? {}).every(([k, v]) => JSON.stringify(have?.[k]) === JSON.stringify(v));
    const definitionFor = async (input) => {
        const definition = isPlain(input?.definition) ? input.definition : (await store.definition(input?.object))?.body;
        if (!definition) refuse("Name a published object, or give a definition.");
        return definition;
    };

    // Transactions' and objects' labels by name, for a flow in words.
    const labelsOf = async () => ({
        transactions: Object.fromEntries([...(await store.transactions()).values()].map((t) => [t.body.name, t.body.label ?? t.body.name])),
        objects: Object.fromEntries((await store.allDefinitions()).filter(Boolean).map((d) => [d.body.object, d.body.label ?? d.body.object])),
    });
    const tools = {
        get_contract: {
            scope: "design:read",
            description: "The rules every design must follow: identifiers, field types, the policy and expression language, the rule-script contract and its test format, the lifecycle and stewards. Read it before drafting. With a name, one of the published contracts listed under `contracts` instead (e.g. equipment-adapter: what an equipment adapter implements), its specification, schema and conformance kit.",
            input_schema: obj({ name: { type: "string", description: "A published contract's name (listed under contracts); leave out for the design rules." } }),
            run: async (who, args = {}) => (need(who, "design:read"), typeof args.name === "string" && args.name ? publishedContract(args.name) : { ...contract(), contracts: publishedContracts() }),
        },
        get_catalog: {
            scope: "design:read",
            description: "Every published object's full definition, what the platform and installed suites lock on each, the departments (who can steward), the published rule scripts, services and connections, and the users and groups (for a service's callers).",
            input_schema: obj({}),
            run: async (who) => {
                need(who, "design:read");
                const defs = await store.allDefinitions();
                const home = await call("design.home", who, { as: who.user_id });
                const services = await store.services();
                const connections = await store.connections();
                return {
                    objects: defs.map((d) => ({ version: d.version, definition: d.body })), departments: home.departments, scripts: home.scripts,
                    services: [...services.values()].map((x) => ({ version: x.version, service: x.body })),
                    connections: [...connections.values()].map((x) => ({ version: x.version, connection: x.body })),
                    transactions: [...(await store.transactions()).values()].map((x) => ({ version: x.version, transaction: x.body })),
                    screens: [...(await store.screens()).values()].map((x) => ({ version: x.version, screen: x.body })),
                    flows: [...(await store.flows()).values()].map((x) => ({ version: x.version, flow: x.body })),
                    layouts: [...(await store.layouts()).values()].map((x) => ({ version: x.version, layout: x.body })),
                    queries: [...(await store.queries()).values()].map((x) => ({ version: x.version, query: x.body })),
                    flowNodes: home.flowNodes,
                    // What else the installed suites add (§30.11): what a service's script may ask of each,
                    // their transaction step kinds and screen block kinds,
                    suiteCapabilities: home.suiteCapabilities, suiteSteps: home.suiteSteps, suiteBlocks: home.suiteBlocks,
                    // …the kinds of schedule a service may run on, whose times the suite works out.
                    suiteSchedules: home.suiteSchedules,
                    // …and their own kinds of design element, with the published ones.
                    suiteElements: home.suiteElements, elements: home.elements,
                    // What the platform and the installed suites lock, per object (builtins.js).
                    locks: home.locks,
                    organization: home.organization,
                    users: home.users, groups: home.groups,
                };
            },
        },
        get_suites: {
            scope: "design:read",
            description: "The suites installed here: each one's version and a newer one on the suites registry (with the update command), what it gives designs, its design pack against what is live (what differs, and open changes holding it), and its set-up guide; and what every live design needs from suites, each need given or not and why (broken: the ones not given: a suite removed, or a version that dropped something). Read it to help set a suite up, to say an update is out, and to find and resolve what an update or a removal breaks.",
            input_schema: obj({}),
            run: async (who) => (need(who, "design:read"), call("design.suites", who, { as: who.user_id })),
        },
        get_object: {
            scope: "design:read",
            description: "One published object's definition.",
            input_schema: obj({ object: str("The object's name.") }, ["object"]),
            run: async (who, { object } = {}) => {
                need(who, "design:read");
                const def = await store.definition(object);
                if (!def) throw Object.assign(new Error("No such object."), { expose: true, status: 404 });
                return { version: def.version, definition: def.body };
            },
        },
        get_script: {
            scope: "design:read",
            description: "A published rule script's source.",
            input_schema: obj({ name: str("The script's name.") }, ["name"]),
            run: async (who, { name } = {}) => {
                need(who, "design:read");
                const script = (await store.scripts()).get(name);
                if (!script) throw Object.assign(new Error("No such published script."), { expose: true, status: 404 });
                return { name, version: script.version, source: script.source };
            },
        },
        list_changes: {
            scope: "design:read",
            description: "Change requests, newest first.",
            input_schema: obj({}),
            run: async (who) => (need(who, "design:read"), (await call("design.home", who, { as: who.user_id })).changes),
        },
        start_change: {
            scope: "design:draft",
            description: "Start a change request for one object, service, connection, transaction, screen, flow, report layout or named query (give exactly one of them): an existing one's live body becomes the draft, or a new one is made. A new one of any of these kinds may start as a copy of a live one of its kind (from: its name): all of it, under the new name; a service brings its script, an object its rule scripts (each under a new name), a transaction or flow its scenarios running the copy (one process's OCAP copied for another, then its start and causes changed). A new service comes with its script. More of any kind can be added to the same change with save_draft. Answers the change's id.",
            input_schema: obj({ element: str("A design element of a suite's kind, by its name (get_catalog: elements); a new one also gives kind."), kind: str("For a new design element: its kind, '<suite>.<kind>' (get_catalog: suiteElements)."), object: str("An object's name (lower case, digits, _)."), service: str("A service's name."), connection: str("A connection's name."), transaction: str("A transaction's name."), screen: str("A screen's name."), flow: str("A flow's name (a route or a plan, §32)."), layout: str("A report layout's name (§34.5)."), query: str("A named query's name (§23.1)."), organization: { type: "boolean", description: "true: a change to people & departments." }, label: str("A new one's label."), from: str("A new object, service, connection, transaction, screen or flow: the live one of its kind it starts as a copy of.") }),
            run: async (who, input, agent) => {
                need(who, "design:draft");
                if (input?.organization === true) return call("design.start", who, { organization: true }, agent);
                if (typeof input?.element === "string") return call("design.start", who, { element: input.element, kind: input?.kind, label: input?.label }, agent);
                const which = ["object", "service", "connection", "transaction", "screen", "flow", "layout", "query"].filter((k) => typeof input?.[k] === "string");
                if (which.length !== 1) refuse("Give exactly one of object, service, connection, transaction, screen, flow, layout, query, or organization: true.");
                return call("design.start", who, { [which[0]]: input[which[0]], label: input?.label, ...(typeof input?.from === "string" ? { from: input.from } : {}) }, agent);
            },
        },
        add_to_change: {
            scope: "design:draft",
            description: "Bring a live object, transaction, screen, flow, service or connection into a change in design, to change it together with the rest (§5.12): its live body becomes its draft, at the version live now; then edit it with save_draft. One change, one review, and one approval from each department any of its designs touches; executed all or nothing. Refused if it is already in another open change (that change is named). A new design is made with save_draft, not this.",
            input_schema: obj({ id: str("The change request's id."), kind: { type: "string", enum: ["object", "transaction", "screen", "flow", "service", "connection"], description: "What it is." }, name: str("Its name (an object's name, a transaction's, …).") }, ["id", "kind", "name"]),
            run: async (who, input, agent) => (need(who, "design:draft"), call("design.include", who, { id: input?.id, kind: input?.kind, name: input?.name }, agent)),
        },
        // A model file (§24.1): the whole model as one file, and a change started from one.
        export_model: {
            scope: "design:read",
            description: "Every published design as one model file (objects, scripts and their tests, connections, services, transactions, screens, flows, report layouts, the roles departments hold), to carry to another installation. Designs only: no records, no secrets, no people, no history.",
            input_schema: obj({}),
            run: async (who, _input, agent) => (need(who, "design:read"), call("model.export", who, {}, agent)),
        },
        preview_model_file: {
            scope: "design:read",
            description: "What a model file (from export_model, or exported in the Designer of another installation) would change here, nothing written: each design new, changed or the same as live, the roles it would give, what its designs fail of the checks a change must pass, and what this installation lacks that they name (a secret, a suite).",
            input_schema: obj({ file: loose("The model file, as exported.") }, ["file"]),
            run: async (who, input, agent) => (need(who, "design:read"), call("model.preview", who, { file: input?.file }, agent)),
        },
        start_change_from_model_file: {
            scope: "design:draft",
            description: "Start one change request holding every design of a model file that is new or different here. It is a change like any other from there: edited with save_draft, submitted by its person, reviewed and approved by people. The file's records are loaded by a person afterwards, in the Designer.",
            input_schema: obj({ file: loose("The model file, as exported.") }, ["file"]),
            run: async (who, input, agent) => (need(who, "design:draft"), call("model.start", who, { file: input?.file }, agent)),
        },
        get_change: {
            scope: "design:read",
            description: "A change request: its draft (content.definitions, content.scripts), problems, footprint, approval route, and what AIs drafted in it.",
            input_schema: obj({ id: str("The change request's id.") }, ["id"]),
            run: async (who, { id } = {}) => (need(who, "design:read"), call("design.change", who, { id, as: who.user_id })),
        },
        save_draft: {
            scope: "design:draft",
            description: "Save the change's draft (design stage only). Give each object's WHOLE definition under definitions, each service's, connection's and transaction's WHOLE body under services, connections and transactions, and scripts as { name: source } (null drops a script, service, connection or transaction from the change). Answers the problems the draft still has.",
            input_schema: obj({
                id: str("The change request's id."),
                title: str("A new title, optional."),
                reason: str("Why the change is made (required before it can be submitted)."),
                definitions: loose("{ object: whole definition }"),
                scripts: loose("{ script name: source, or null }"),
                services: loose("{ service name: whole service, or null }"),
                connections: loose("{ connection name: whole connection, or null }"),
                transactions: loose("{ transaction name: whole transaction, or null } — see the contract's transactions section"),
                screens: loose("{ screen name: whole screen, or null } — see the contract's screens section"),
                flows: loose("{ flow name: whole flow, or null } — see the contract's flows section"),
                layouts: loose("{ report layout name: whole layout, or null } — see the contract's layouts section"),
                queries: loose("{ query name: whole named query, or null } — see the contract's queries section"),
                elements: loose("{ name: whole design element of a suite's kind, or null } — see the contract's suites section"),
                organization: loose("the whole organization (see the contract's organization section), or null"),
                tests: loose("{ script name: [test cases], or null } — see the contract's fitness section"),
                seen: { type: "integer", description: "The draft_rev that get_change answered when you read the draft. Give it: a save built on a draft someone has saved since is then refused (409, design.stale) instead of undoing their work." },
            }, ["id"]),
            run: async (who, input, agent) => {
                need(who, "design:draft");
                return call("design.save", who, { seen: input?.seen, id: input?.id, title: input?.title, reason: input?.reason, definitions: input?.definitions, scripts: input?.scripts, services: input?.services, connections: input?.connections, transactions: input?.transactions, screens: input?.screens, flows: input?.flows, layouts: input?.layouts, queries: input?.queries, elements: input?.elements, organization: input?.organization, tests: input?.tests }, agent);
            },
        },
        submit_change: {
            scope: "design:submit",
            description: "Submit the change for review. Only with the design:submit scope; a person usually does this.",
            input_schema: obj({ id: str("The change request's id.") }, ["id"]),
            run: async (who, { id } = {}, agent) => (need(who, "design:submit"), call("design.submit", who, { id }, agent)),
        },
        validate: {
            scope: "design:read",
            description: "Validate a draft without saving it: its problems, footprint and approval route.",
            input_schema: obj({ flows: loose("{ flow name: whole flow }"), definitions: loose("{ object: whole definition }"), scripts: loose("{ script name: source }"), services: loose("{ service name: whole service }"), connections: loose("{ connection name: whole connection }"), transactions: loose("{ transaction name: whole transaction }"), screens: loose("{ screen name: whole screen }"), layouts: loose("{ report layout name: whole layout }"), queries: loose("{ query name: whole named query }") }),
            run: async (who, input) => (need(who, "design:read"), call("design.check", who, { definitions: input?.definitions, scripts: input?.scripts, services: input?.services, connections: input?.connections, transactions: input?.transactions, screens: input?.screens, flows: input?.flows, layouts: input?.layouts, queries: input?.queries })),
        },
        get_flow: {
            scope: "design:read",
            description: "One published flow template (a route or a plan, §32): its body, version, and in plain words.",
            input_schema: obj({ name: str("The flow's name.") }, ["name"]),
            run: async (who, { name } = {}) => {
                need(who, "design:read");
                const f = (await store.flows()).get(name);
                if (!f) throw Object.assign(new Error("No such published flow."), { expose: true, status: 404 });
                return { version: f.version, flow: f.body, words: explainFlow(f.body, await labelsOf()) };
            },
        },
        check_flow: {
            scope: "design:read",
            description: "Check a flow template: its problems, each naming its node (nodes.<id>) or wire (edges.<n>), so the very part can be fixed; and what is missing to run it (objects to opt in, roles for the flow), to propose in the same change, never to apply quietly. Give a change id and the flow's name (its draft), or a whole flow.",
            input_schema: obj({ id: str("A change request holding the flow (optional)."), name: str("The flow's name."), flow: loose("A whole flow, to check without a change (optional)."), definitions: loose("{ object: whole definition } drafted with it (optional)") }, ["name"]),
            run: async (who, { id, name, flow, definitions } = {}) => {
                need(who, "design:read");
                let body = flow;
                let defs = definitions ?? {};
                if (!body && id) {
                    const change = await call("design.change", who, { id, as: who.user_id });
                    body = change.content?.flows?.[name];
                    defs = { ...(change.content?.definitions ?? {}), ...defs };
                }
                body ??= (await store.flows()).get(name)?.body;
                if (!body) refuse(`No flow "${name}" to check: give the change it is in, or the whole flow.`);
                const checked = await call("design.check", who, { flows: { [name]: body }, definitions: defs });
                const missing = [];
                for (const [key, p] of Object.entries(body.participants ?? {})) {
                    const def = defs[p?.object] ?? (await store.definition(p?.object))?.body;
                    if (def && !(def.flow?.as ?? []).includes(p.as)) missing.push(`${p.object} takes no part as a ${p.as}: add flow: { as: [${[...new Set([...(def.flow?.as ?? []), p.as])].map((r) => `"${r}"`).join(", ")}] } to its definition, in this change (for ${key}).`);
                }
                return { problems: checked.problems.filter((p) => p.path.startsWith(`flows.${name}.`) || p.path === `flows.${name}`), otherProblems: checked.problems.filter((p) => !p.path.startsWith(`flows.${name}`)), missing, route: checked.route };
            },
        },
        try_scenario: {
            scope: "design:read",
            description: "Try a scenario on a change's draft, in a sandbox of its own (§5.11, §32.8): its records picked from live (as the person sees them) or given, its steps run as whom they say, each step's outcome and the node every record's runs reached. Nothing is saved: propose the scenario to the person, who keeps it (save_draft, under the transaction's or the flow template's scenarios) or not. A step of a flow template's scenario may answer a plan: { act: { record: '@key', plan?, values? | choice? | action: acknowledge | retry | time_up } }, and expect { node: { key: node } }.",
            input_schema: obj({ id: str("The change request."), transaction: str("The transaction it is a scenario of (or flow)."), flow: str("The flow template it is a scenario of (or transaction)."), scenario: loose("{ records, steps } — see the transactions section's scenarios, and the flows section") }, ["id", "scenario"]),
            run: async (who, { id, transaction, flow, scenario } = {}) => {
                need(who, "design:read");
                if (!services["sandbox.tryScenario"]) refuse("No sandbox can be made on this server.");
                return call("sandbox.tryScenario", who, { id, ...(flow ? { flow } : { transaction }), scenario });
            },
        },
        walk_input_flow: {
            scope: "design:read",
            description: "Walk an input flow (kind input, §32.13) as a person at the form would, with sample values: what it asks for, in order, what it fills, its decisions taken, where it runs the form and what it does at its end. An ask whose input has a value in `values.input` is answered with it (and moves on); the walk stops at the first ask with none (it waits there), or after one round. Give a whole flow, or a change id and its name, or a published flow's name.",
            input_schema: obj({ flow: loose("A whole input flow (optional)."), id: str("A change request holding it (optional)."), name: str("Its name."), values: loose("{ input: { name: value }, lookup: { input: { field: value, state } }, param: { name: value }, user: { id } }: what the person enters, and the records it names.") }),
            run: async (who, { flow, id, name, values = {} } = {}) => {
                need(who, "design:read");
                let body = flow;
                if (!body && id) body = (await call("design.change", who, { id, as: who.user_id })).content?.flows?.[name];
                body ??= (await store.flows()).get(name)?.body;
                if (!body) refuse(`No flow "${name ?? ""}" to walk: give the change it is in, or the whole flow.`);
                if (body.kind !== "input") refuse(`${body.name ?? name} is a ${body.kind}, not an input flow.`);
                const scope = { input: { ...(values.input ?? {}) }, lookup: values.lookup ?? {}, param: values.param ?? {}, user: values.user ?? { id: who.user_id } };
                const answered = new Set();
                const steps = [];
                let from = null;
                for (let i = 0; i < 60; i++) {
                    const step = stepFrom(body, from, scope, { filled: (input) => answered.has(input) });
                    for (const f of step.fills ?? []) { steps.push({ fill: f.input, value: f.value }); scope.input[f.input] = f.value; }
                    if (step.error) { steps.push({ error: step.error }); break; }
                    const n = step.node;
                    if (n.kind === "ask") {
                        if (!Object.hasOwn(scope.input, n.input)) { steps.push({ ask: n.input, node: step.id, prompt: n.prompt ?? n.label, waits: true }); break; }
                        steps.push({ ask: n.input, node: step.id, prompt: n.prompt ?? n.label, answer: scope.input[n.input], movesOnBy: n.advance === "key" ? n.key : n.advance ?? "enter" });
                        answered.add(n.input);
                        from = step.id;
                        continue;
                    }
                    if (n.kind === "run") { steps.push({ run: n.transaction ?? "the form", node: step.id, confirm: n.confirm ?? "ask" }); from = step.id; continue; }
                    steps.push({ end: n.then ?? "repeat", node: step.id });
                    break;
                }
                return { steps, words: explainFlow(body, await labelsOf()) };
            },
        },
        layout_flow: {
            scope: "design:read",
            description: "Place a flow template's nodes so it reads on the canvas (left to right from its start, a node's branches below one another): the layout to save with it. The canvas's Tidy does the same.",
            input_schema: obj({ flow: loose("The whole flow.") }, ["flow"]),
            run: async (who, { flow } = {}) => (need(who, "design:read"), { layout: tidyLayout(flow ?? {}) }),
        },
        explain_flow: {
            scope: "design:read",
            description: "A flow template walked in plain words, node by node, for you and for the reviewers: give a whole flow, or a change id and its name, or a published flow's name.",
            input_schema: obj({ flow: loose("A whole flow (optional)."), id: str("A change request holding it (optional)."), name: str("Its name.") }),
            run: async (who, { flow, id, name } = {}) => {
                need(who, "design:read");
                let body = flow;
                if (!body && id) body = (await call("design.change", who, { id, as: who.user_id })).content?.flows?.[name];
                body ??= (await store.flows()).get(name)?.body;
                if (!body) refuse(`No flow "${name ?? ""}" to explain.`);
                return { words: explainFlow(body, await labelsOf()) };
            },
        },
        test_script: {
            scope: "design:read",
            description: "Run test cases for one rule script in the sandbox: the given source, or the published one. Each test: { name, ctx: { event, data, record? }, writes?: [fields], lookups?: { 'object/id': record }, expect?: { data: {…} }, throws?: { field?, message? } }.",
            input_schema: obj({ name: str("The script's name."), source: str("The script's source; the published one when omitted."), tests: { type: "array", items: { type: "object" } } }, ["name", "tests"]),
            run: async (who, input) => {
                need(who, "design:read");
                const name = input?.name;
                if (typeof name !== "string" || !IDENTIFIER.test(name)) refuse("Name the script.");
                const scripts = await scriptsOf(typeof input?.source === "string" ? { [name]: input.source } : {});
                if (!scripts.has(name)) refuse("Give the script's source, or name a published script.");
                const tests = Array.isArray(input?.tests) ? input.tests.slice(0, 100) : [];
                if (!tests.length) refuse("Give at least one test case.", { fields: { tests: "Required." } });
                const results = [];
                for (const [i, t] of tests.entries()) {
                    const outcome = await runRules({
                        definition: { rules: [{ script: name, writes: Array.isArray(t?.writes) ? t.writes : [] }] },
                        scripts, ctx: baseCtx(t?.ctx), lookup: lookupFrom(t?.lookups),
                    });
                    const passed = t?.throws
                        ? Boolean(outcome.error) && !outcome.error.fault
                            && (t.throws.field === undefined || outcome.error.field === t.throws.field)
                            && (t.throws.message === undefined || String(outcome.error.message).includes(t.throws.message))
                        : !outcome.error && subset(t?.expect?.data, outcome.ctx.data);
                    results.push({
                        name: t?.name ?? `test ${i + 1}`, passed,
                        outcome: outcome.error ? (outcome.error.fault ? "fault" : "threw") : "passed",
                        ...(outcome.error ? { error: { message: outcome.error.message, field: outcome.error.field, detail: outcome.error.fault ? outcome.error.detail : undefined } } : { data: outcome.ctx.data }),
                    });
                }
                return { script: name, passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length, results };
            },
        },
        run_pipe: {
            scope: "design:read",
            description: "Run an object's whole rule pipe on one context (a change, a save or an action), with a draft definition and draft scripts if given.",
            input_schema: obj({ object: str("A published object's name."), definition: loose("A draft definition instead."), scripts: loose("Draft scripts { name: source }."), ctx: loose("{ event, data, record? }"), lookups: loose("{ 'object/id': record }") }),
            run: async (who, input) => {
                need(who, "design:read");
                const definition = await definitionFor(input);
                const outcome = await runRules({ definition, scripts: await scriptsOf(input?.scripts), ctx: baseCtx(input?.ctx, definition.object), lookup: lookupFrom(input?.lookups) });
                return { ok: !outcome.error, error: outcome.error ? { script: outcome.error.script, message: outcome.error.message, field: outcome.error.field, fault: outcome.error.fault } : null, data: outcome.ctx.data, trace: outcome.trace };
            },
        },
        run_fitness: {
            scope: "design:read",
            description: "Run the fitness test on a change's draft: what submitting it runs, and what its reviewers read. It fails on validation problems, scripts that do not compile or call what they will not have, new or changed scripts without test cases (content.tests), and failing cases; it warns about existing records the draft would no longer let be saved, and lists access changes. Save the draft first.",
            input_schema: obj({ id: str("The change request's id.") }, ["id"]),
            run: async (who, { id } = {}) => {
                need(who, "design:read");
                if (!services["design.fitness"]) refuse("The fitness test is not available here.");
                return call("design.fitness", who, { id });
            },
        },
        dry_run: {
            scope: "design:read",
            description: "Execute a draft script, changing nothing. kind 'service': give the draft service (its whole body) and any draft connections, and run: { input } for a call, or { event: { kind, object, id } } for a trigger, with responses: { 'POST /path': { status, body } } answering its requests. kind 'rule': run: { event, data, record, writes: [fields its binding declares] }. Reads are real, with the person's rights; creates, updates and actions go through the object's policy and rule pipe and are not saved; requests are checked against the connection and never sent. Answers the output, what it would write and send, what it read, and any error with its line.",
            input_schema: obj({
                kind: { type: "string", enum: ["service", "rule"] }, name: str("The script's name (a service's is the service's)."), source: str("The draft script's source."),
                service: loose("kind service: the draft service's whole body."), connections: loose("kind service: draft connections { name: body } (published ones are used otherwise)."), run: loose("What to run it on (see the description)."),
            }, ["kind", "name", "source"]),
            run: async (who, input) => {
                need(who, "design:read");
                if (!services["design.dryRun"]) refuse("Dry runs are not available here.");
                return call("design.dryRun", who, { kind: input?.kind, name: input?.name, source: input?.source, service: input?.service, connections: input?.connections, run: input?.run });
            },
        },
        simulate_access: {
            scope: "design:read",
            description: "What a user holding these roles may read, write and do on a record in a state (archived when record.archived_at is set), from a published or draft definition; with explain: { field }, { action } or { archive: true }, why.",
            input_schema: obj({ object: str("A published object's name."), definition: loose("A draft definition instead."), roles: { type: "array", items: { type: "string" } }, record: loose("{ state, …fields }"), explain: loose("{ field }, { action } or { archive: true }") }, ["roles"]),
            run: async (who, input) => {
                need(who, "design:read");
                const definition = await definitionFor(input);
                const user = { id: "simulated", roles: Array.isArray(input?.roles) ? input.roles.map(String) : [] };
                const record = isPlain(input?.record) ? { state: definition.states?.initial, ...input.record } : { state: definition.states?.initial };
                const d = decide(definition, user, record);
                const out = { roles: user.roles, record, read: d.read, create: d.create, archive: d.archive, fields: d.fields, actions: d.actions, why: d.why };
                if (isPlain(input?.explain)) out.explain = explainDecision(definition, user, record, input.explain.archive === true ? { archive: true } : input.explain.action ? { action: input.explain.action } : { field: input.explain.field, op: input.explain.op ?? "write" });
                return out;
            },
        },
    };
    return tools;
}
