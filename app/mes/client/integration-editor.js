// The designer's editors for services and connections (DESIGN.md §15.2), beside the object editor
// (designer.js), in the same windows on the same working copy. A service or a connection is changed
// as an object is: every edit is a draft in a change request, checked as it is typed, approved by the
// stewards of what it reaches, and live once executed.
import { pickMany, tagsInput } from "./pick.js";
import { noDefault } from "./select.js";
import { validateService, validateConnection, validateScript, integrationFootprint, serviceIdentity, FIELD_TYPES, HTTP_METHODS, AUTH_KINDS, SERVICE_OPS, RECORD_EVENTS, IDENTIFIER } from "./definition.js";
import { isSchedule, isSuiteSchedule, suiteOf, scheduleProblems, runsOf, describeSchedule, DAYS, MAX_CATCH_UP } from "./schedule.js";
import { changesOf, countByTab } from "./compare.js";
import { W, clone, text, labelled, check, compileInPage, draftDefinitions } from "./editor-kit.js";
import { findSyntaxError, callableProblems } from "./code-editor.js";
import { plant, formatDateTime } from "./format.js";
import { icon, withIcon } from "./icons.js";
import { confirmRemove } from "./dialog.js";
import * as history from "./undo.js";

export const SERVICE_VIEWS = [["copilot", "Copilot", "sparkle"], ["changes", "Changes"], ["general", "General"], ["input", "Input"], ["callers", "Identity"], ["triggers", "Triggers"], ["reaches", "Reaches"], ["script", "Script"], ["try", "Try it"], ["activity", "Activity"], ["stewards", "Stewards"], ["json", "JSON"]];
export const CONNECTION_VIEWS = [["copilot", "Copilot", "sparkle"], ["changes", "Changes"], ["general", "General"], ["auth", "Authentication"], ["allow", "Allowed requests"], ["activity", "Activity"], ["stewards", "Stewards"], ["json", "JSON"]];
const SLOT = { service: "sv", connection: "cn", transaction: "tx", screen: "sc", flow: "fl", layout: "ly", query: "qy", element: "el" };

// The working copy's part for one service or connection, and edits to it.
export function elementOps(api, id, kind, name) {
    const w = W(id);
    const root = `${w}.${SLOT[kind]}.${name}`;
    const bump = (key) => api.setValue(`${w}.${key}`, (api.peek(`${w}.${key}`) ?? 0) + 1);
    const touched = (structural) => {
        api.setValue(`${w}.dirty`, true);
        bump("vrev");
        if (structural) bump("rev");
    };
    return {
        root,
        set(path, value, structural = false) { history.before(api, w, structural ? null : `${root}.${path}`); api.setValue(`${root}.${path}`, value); touched(structural); },
        edit(fn) { history.before(api, w); const copy = clone(api.peek(root)); fn(copy); api.setValue(root, copy); touched(true); },
        setScript(script, source) { history.before(api, w, `s.${script}`); api.setValue(`${w}.s.${script}`, source); touched(false); },
    };
}

// What a service or connection may name: the objects (with their actions), scripts, connections,
// users, groups and departments there will be once the change executes.
function knownOf(api, w) {
    const home = api.peek("design.home") ?? {};
    const objects = Object.fromEntries((home.objects ?? []).map((o) => [o.object, { actions: o.actions ?? [], roles: o.roles ?? [], stewards: { object: o.stewards ?? [] }, ...(o.approval ? { approval: o.approval } : {}) }]));
    for (const [object, body] of Object.entries(draftDefinitions(api, w))) if (body) objects[object] = { actions: (body.states?.transitions ?? []).map((t) => t.action), roles: body.roles ?? [], stewards: body.stewards ?? {}, ...(body.approval ? { approval: body.approval } : {}) };
    return {
        objects,
        scripts: [...new Set([...(home.scripts ?? []).map((s) => s.name), ...Object.keys(api.peek(`${w}.s`) ?? {})])],
        connections: [...new Set([...(home.connections ?? []).map((c) => c.name), ...Object.keys(api.peek(`${w}.cn`) ?? {})])],
        users: (home.users ?? []).map((u) => u.id),
        groups: (home.groups ?? []).map((g) => g.id),
        departments: (home.departments ?? []).map((d) => d.id),
        suiteCapabilities: home.suiteCapabilities ?? {},
        // The transactions a service may run (§25): which services each names, and whether it is signed.
        transactions: Object.fromEntries([
            ...(home.transactions ?? []).map((t) => [t.name, { label: t.label, callers: { services: t.services ?? [] }, signed: Boolean(t.signed), stewards: t.stewards ?? [] }]),
            ...Object.entries(api.peek(`${w}.tx`) ?? {}).map(([n, t]) => [n, { label: t?.label ?? n, callers: { services: t?.callers?.services ?? [] }, signed: Boolean(t?.signature), stewards: t?.stewards ?? [] }]),
        ]),
        // Kinds of schedule the installed suites add (§30.11): a schedule from one is checked against them.
        suiteSchedules: home.suiteSchedules ?? {},
    };
}

export function integrationProblems(api, id) {
    const w = W(id);
    const known = knownOf(api, w);
    const problems = [];
    for (const [name, body] of Object.entries(api.peek(`${w}.cn`) ?? {})) for (const p of validateConnection(body, known)) problems.push({ ...p, message: `${name}: ${p.message}` });
    for (const [name, body] of Object.entries(api.peek(`${w}.sv`) ?? {})) for (const p of validateService(body, known)) problems.push({ ...p, message: `${name}: ${p.message}` });
    return problems;
}

// The footprint of the change's services and connections, against what is live (for RoutePanel).
export function integrationElements(api, id, change) {
    const w = W(id);
    const home = api.peek("design.home") ?? {};
    const known = knownOf(api, w);
    const connections = { ...Object.fromEntries((home.connections ?? []).map((c) => [c.name, { stewards: c.stewards ?? [] }])), ...(api.peek(`${w}.cn`) ?? {}) };
    const context = { objects: known.objects, connections, transactions: known.transactions };
    const out = [];
    for (const [name, body] of Object.entries(api.peek(`${w}.cn`) ?? {})) out.push(...integrationFootprint("connection", name, change.live.connections?.[name] ?? undefined, body, context));
    for (const [name, body] of Object.entries(api.peek(`${w}.sv`) ?? {})) out.push(...integrationFootprint("service", name, change.live.services?.[name] ?? undefined, body, context));
    return { elements: out, services: api.peek(`${w}.sv`) ?? {}, context };
}

// A dry run's error, for the script's editor to put on its line (while the text is what was run).
export const dryRunError = (api, w, name) => () => {
    const r = api.getState(`${w}.run.${name}`, null);
    return r?.error ? { ...r.error, source: r.source } : null;
};

// A test case from a dry run: what it ran on, and what it did, as the expectation (§5.9).
export function caseFrom(kind, name, given, r, as, me) {
    // A script a suite or a flow node runs (§29.4, §32.5): this input, this output (or this refusal). The
    // dry run's own additions to its output are not the script's: who ran it is left out, and the time it
    // ran at goes into the input instead, so a script that reads ctx.now gives the same output again.
    if (kind === "plain") {
        const { as: _who, now, ...output } = r.output && typeof r.output === "object" && !Array.isArray(r.output) ? r.output : {};
        return { name, run: { ...given, ...(now !== undefined && given?.now === undefined ? { now } : {}) }, expect: r.ok ? { output } : { throws: { message: r.error?.message } } };
    }
    if (kind === "rule") {
        const { writes, ...run } = given;
        return { name, run, expect: r.ok ? { data: Object.fromEntries((r.changed ?? []).map((f) => [f, r.data?.[f]])), changed: r.changed ?? [] } : { throws: { message: r.error?.message, ...(r.error?.field ? { field: r.error.field } : {}) } } };
    }
    const { as: _, ...run } = given;
    return {
        name, run, ...(as && as !== me ? { as } : {}),
        expect: r.ok ? { ok: true, output: r.output, writes: r.writes?.length ?? 0, requests: r.requests?.length ?? 0 } : { ok: false, error: r.error?.message },
    };
}
function addCase(api, id, script, testCase) {
    const w = W(id);
    // A published script's cases travel with it: the script joins the change.
    if (api.peek(`${w}.s.${script}`) === undefined && api.peek(`${w}.viewing`)?.name === script) api.setValue(`${w}.s.${script}`, api.peek(`${w}.viewing`).source);
    const cases = [...(api.peek(`${w}.t.${script}`) ?? []).filter((c) => c.name !== testCase.name), testCase];
    history.before(api, w);
    api.setValue(`${w}.t.${script}`, cases);
    api.setValue(`${w}.dirty`, true);
    api.setValue(`${w}.vrev`, (api.peek(`${w}.vrev`) ?? 0) + 1);
    api.setValue(`${w}.casesRev`, (api.peek(`${w}.casesRev`) ?? 0) + 1);
}

// ---- small shared pieces ----
const toggleIn = (list, value, on) => {
    const set = new Set(list ?? []);
    if (on) set.add(value); else set.delete(value);
    return [...set];
};
const checks = (ctx, items, current, onToggle) => ({
    div: {
        className: "checks",
        children: items.map(({ value, label }) => ({
            label: { key: value, children: [{ input: { type: "checkbox", disabled: ctx.ro, checked: (current ?? []).includes(value), onchange: (e) => onToggle(value, e.target.checked) } }, { span: ` ${label ?? value}` }] },
        })),
    },
});
const hint = (words) => ({ p: { className: "muted small", textContent: words } });
const nameRow = (ctx, placeholder, onAdd) => {
    const path = `${ctx.w}.adding.${ctx.kind}.${placeholder.length}`;
    return {
        div: {
            className: "add-row",
            children: [
                { input: { type: "text", placeholder, value: () => ctx.api.getState(path, "") ?? "", oninput: (e) => ctx.api.setValue(path, e.target.value.trim().toLowerCase()) } },
                { button: { type: "button", className: "btn", textContent: "Add", disabled: () => !IDENTIFIER.test(ctx.api.getState(path, "") ?? ""), onclick: () => { onAdd(ctx.api.peek(path)); ctx.api.setValue(path, ""); } } },
            ],
        },
    };
};

// ---- a service's tabs ----
function serviceGeneral(ctx) {
    const { body, name } = ctx;
    return {
        div: {
            className: "ed-grid",
            children: [
                labelled("Name", { input: { type: "text", value: body.name, disabled: true } }, `Fixed once created; its script is ${name}.js.`),
                labelled("Label", text(ctx, "label")),
                labelled("Description", text(ctx, "description", { multiline: true })),
                labelled("Web service", check(ctx, "http.enabled", `outside systems call it: POST /svc/v1/${name}`), "With an integration user's token (scope service:call); only its callers get an answer."),
                ...(body.http?.enabled || body.deprecated ? [deprecation(ctx)] : []),
            ],
        },
    };
}

// A design published over HTTP (a web service, a transaction, a named query) deprecated: its callers' notice.
// Every call is then answered with Deprecation, Sunset and Link headers, and its OpenAPI operation says so; a
// change that would break its callers goes through once the sunset has passed (docs/contracts/http-apis).
export function deprecation(ctx) {
    const { body, ops, ro } = ctx;
    const d = body.deprecated;
    const today = new Date().toISOString().slice(0, 10);
    return {
        div: {
            className: "ed-span",
            children: [
                labelled("Deprecated", { label: { children: [{ input: { type: "checkbox", disabled: ro, checked: Boolean(d), onchange: (e) => ops.set("deprecated", e.target.checked ? { since: today, sunset: "", successor: "", note: "" } : undefined, true) } }, { span: " its callers are told on every call, until its sunset" }] } }, "For a change its callers must prepare for: give them notice here first, then change it after the sunset (or publish the new shape under a new name, and name it as the successor)."),
                ...(d ? [
                    labelled("Since", { input: { type: "date", disabled: ro, value: d.since ?? "", onchange: (e) => ops.set("deprecated.since", e.target.value, true) } }),
                    labelled("Sunset", { input: { type: "date", disabled: ro, value: d.sunset ?? "", onchange: (e) => ops.set("deprecated.sunset", e.target.value, true) } }, "The date after which it may change or go."),
                    labelled("Successor", text(ctx, "deprecated.successor", { placeholder: "what to call instead (its name)" })),
                    labelled("Note for its callers", text(ctx, "deprecated.note", { multiline: true })),
                ] : []),
            ],
        },
    };
}

function inputTab(ctx) {
    const { body, ops, ro } = ctx;
    const input = body.input ?? {};
    return {
        div: {
            children: [
                hint("What a caller sends. Each input is checked against its type before the script runs; a bad one is refused with a message per input."),
                {
                    table: {
                        className: "grid ed-table",
                        children: [
                            { thead: { children: [{ tr: { children: ["Input", "Label", "Type", "Required", "Values (enum)", ""].map((h) => ({ th: h })) } }] } },
                            {
                                tbody: {
                                    children: Object.entries(input).map(([field, spec]) => ({
                                        tr: {
                                            key: field,
                                            children: [
                                                { td: { children: [{ code: field }] } },
                                                { td: { children: [text(ctx, `input.${field}.label`)] } },
                                                { td: { children: [{ select: { disabled: ro, onchange: (e) => ops.set(`input.${field}.type`, e.target.value, true), children: noDefault(FIELD_TYPES.map((t) => ({ option: { value: t, selected: spec.type === t, textContent: t } }))) } }] } },
                                                { td: { children: [check(ctx, `input.${field}.required`, "")] } },
                                                { td: { children: [spec.type === "enum" ? tagsInput({ key: `${ctx.w}.svals.${ctx.name}.${field}`, readOnly: ro, placeholder: "Add a value…", value: spec.values ?? [], onChange: (next) => ops.set(`input.${field}.values`, next, true) }) : { span: { className: "muted", textContent: "—" } }] } },
                                                { td: { children: ro() ? [] : [{ button: { type: "button", className: "btn ghost", textContent: "Remove", onclick: confirmRemove(ctx.api, `input ${field}`, () => ops.edit((b) => { delete b.input[field]; }) )} }] } },
                                            ],
                                        },
                                    })),
                                },
                            },
                        ],
                    },
                },
                ro() ? { span: {} } : nameRow(ctx, "New input (e.g. wo_no)", (field) => ops.edit((b) => { (b.input ??= {})[field] ??= { label: field, type: "string" }; })),
            ],
        },
    };
}

function callersTab(ctx) {
    const { api, body, ops, ro, name } = ctx;
    const home = api.peek("design.home") ?? {};
    const callers = body.callers ?? {};
    const identity = serviceIdentity(body);
    const grants = body.roles ?? {};
    const toggleRole = (object, role, on) => ops.edit((b) => {
        const roles = { ...(b.roles ?? {}) };
        const next = toggleIn(roles[object], role, on);
        if (next.length) roles[object] = next; else delete roles[object];
        b.roles = roles;
    });
    return {
        div: {
            children: [
                { h4: "Acts as" },
                labelled("Identity", {
                    select: {
                        disabled: ro, onchange: (e) => ops.set("runAs", e.target.value, true),
                        children: noDefault([
                            { option: { value: "service", selected: identity === "service", textContent: `Its own service role (service:${name})` } },
                            { option: { value: "caller", selected: identity === "caller", textContent: "Its caller (whoever calls it)" } },
                            ...(home.users ?? []).map((u) => ({ option: { value: u.id, selected: identity === u.id, textContent: `Run as ${u.name} (${u.id})` } })),
                        ]),
                    },
                }, identity === "service"
                    ? "It acts with exactly the roles below, whoever sets it off, and every write it makes is audited as the service, on behalf of its caller or event. Its tests run the same way."
                    : identity === "caller" ? "It acts with the caller's own rights, so it does what they could do. A record event has no caller: a service with triggers cannot run this way."
                        : "It acts with that user's roles, on behalf of its caller or event."),
                identity === "service" ? {
                    div: {
                        children: [
                            { h4: "Service role" },
                            hint("The roles it holds on each object, from the roles each object declares; its policies decide what they allow. Granting a role on an object is approved by that object's stewards."),
                            {
                                table: {
                                    className: "grid ed-table",
                                    children: [
                                        { thead: { children: [{ tr: { children: [{ th: "Object" }, { th: "Roles it holds" }] } }] } },
                                        { tbody: { children: (home.objects ?? []).map((o) => ({ tr: { key: o.object, children: [
                                            { td: o.label },
                                            { td: { children: [{ div: { className: "checks", children: (o.roles ?? []).map((role) => ({ label: { key: role, children: [{ input: { type: "checkbox", disabled: ro(), checked: (grants[o.object] ?? []).includes(role), onchange: (e) => toggleRole(o.object, role, e.target.checked) } }, { span: ` ${role}` }] } })) } }] } },
                                        ] } })) } },
                                    ],
                                },
                            },
                        ],
                    },
                } : { span: {} },
                { h4: "Who may call it" },
                hint("Deny by default: nobody may call it until named here. Who may call is a change like any other, approved by its stewards."),
                { h4: "Users" },
                pickMany({ key: `callers-${ctx.name}`, options: (home.users ?? []).map((u) => ({ value: u.id, label: u.name, hint: u.id })), value: callers.users ?? [], readOnly: ctx.ro, placeholder: "Add a person…", onChange: (next) => ops.edit((b) => { b.callers = { ...(b.callers ?? {}), users: next }; }) }),
                { h4: "Groups" },
                checks(ctx, (home.groups ?? []).map((g) => ({ value: g.id, label: g.name })), callers.groups, (v, on) => ops.edit((b) => { b.callers = { ...(b.callers ?? {}), groups: toggleIn(b.callers?.groups, v, on) }; })),
            ],
        },
    };
}

function triggersTab(ctx) {
    const { api, body, ops, ro } = ctx;
    const objects = api.peek("design.home.objects") ?? [];
    const plantTz = api.peek("design.home.plantTz") ?? "UTC";
    const eventsOf = (object) => [...RECORD_EVENTS, ...((objects.find((o) => o.object === object)?.actions) ?? []).map((a) => `transition:${a}`)];
    const on = (body.on ?? []).map((t, i) => ({ t, i }));
    const events = on.filter(({ t }) => !isSchedule(t));
    const schedules = on.filter(({ t }) => isSchedule(t));
    const kinds = api.peek("design.home.suiteSchedules") ?? {};
    return {
        div: {
            children: [
                { h4: "On a record event" },
                hint("A trigger runs after the record's change is committed (never for one rolled back), as the identity on the Identity tab, and is retried while the other system is down. A service never sets itself off."),
                events.length ? {
                    table: {
                        className: "grid ed-table",
                        children: [
                            { thead: { children: [{ tr: { children: ["Object", "Event", ""].map((h) => ({ th: h })) } }] } },
                            {
                                tbody: {
                                    children: events.map(({ t, i }) => ({
                                        tr: {
                                            key: `${i}-${t.object}-${t.event}`,
                                            children: [
                                                { td: { children: [{ select: { disabled: ro, onchange: (e) => ops.edit((b) => { b.on[i] = { object: e.target.value, event: "create" }; }), children: noDefault(objects.map((o) => ({ option: { value: o.object, selected: o.object === t.object, textContent: o.label } }))) } }] } },
                                                { td: { children: [{ select: { disabled: ro, onchange: (e) => ops.set(`on.${i}.event`, e.target.value, true), children: noDefault(eventsOf(t.object).map((ev) => ({ option: { value: ev, selected: ev === t.event, textContent: ev } }))) } }] } },
                                                { td: { children: ro() ? [] : [{ button: { type: "button", className: "btn ghost", textContent: "Remove", onclick: confirmRemove(ctx.api, "this trigger", () => ops.edit((b) => { b.on.splice(i, 1); }) )} }] } },
                                            ],
                                        },
                                    })),
                                },
                            },
                        ],
                    },
                } : { p: { className: "muted small", textContent: "None." } },
                ro() || !objects.length ? { span: {} } : { button: { type: "button", className: "btn", textContent: "Add trigger", onclick: () => ops.edit((b) => { (b.on ??= []).push({ object: objects[0].object, event: "create" }); }) } },

                { h4: "On a schedule" },
                hint(`The clock sets it off, as the identity on the Identity tab, once per time due however many nodes plan it. Times are in the plant's time zone (${plantTz}) unless the schedule names another, and follow daylight saving. The script reads ctx.event: { kind: "schedule", scheduledAt, previous: { at, output } }, the last successful run's output, so it can keep a cursor there. Pausing a published schedule is done from the integration monitor, not here.`),
                ...schedules.map(({ t, i }) => (isSuiteSchedule(t) ? suiteScheduleCard(ctx, t, i, plantTz, kinds) : scheduleCard(ctx, t, i, plantTz, kinds))),
                ro() ? { span: {} } : { div: { className: "ed-row", children: [
                    { button: { type: "button", className: "btn", textContent: "Add schedule", onclick: () => ops.edit((b) => { (b.on ??= []).push({ schedule: { every: { minutes: 15 } }, missed: "last", overlap: "skip" }); }) } },
                    // A kind of schedule an installed suite adds (§30.11): its settings start empty.
                    ...Object.entries(kinds).map(([kind, spec]) => ({ button: { key: `add-${kind}`, type: "button", className: "btn", textContent: `Add schedule: ${spec.label ?? kind}`, onclick: () => ops.edit((b) => { (b.on ??= []).push({ schedule: { from: kind }, missed: "last", overlap: "skip" }); }) } })),
                ] } },

                { h4: "Where it runs" },
                labelled("Run on nodes tagged", { input: { type: "text", placeholder: "any node", disabled: ro, value: body.runOn ?? "", onchange: (e) => ops.edit((b) => { const v = e.target.value.trim(); if (v) b.runOn = v; else delete b.runOn; }) } },
                    "Leave empty to let any node run its triggers and schedules. A tag (e.g. erp) keeps them to the nodes started with NODE_TAGS=erp: the ones that can reach the other system. Calls from outside run wherever they arrive."),
            ],
        },
    };
}

// One schedule trigger: how often, which days, the window, the time zone, what to do with missed and
// overlapping runs, and the next runs it would make.
function scheduleCard(ctx, t, i, plantTz, kinds = {}) {
    const { ops, ro } = ctx;
    const s = t.schedule ?? {};
    const mode = Array.isArray(s.at) ? "at" : "every";
    const unit = s.every?.hours !== undefined ? "hours" : "minutes";
    const amount = s.every?.[unit] ?? 15;
    const edit = (fn) => ops.edit((b) => { fn(b.on[i].schedule, b.on[i]); });
    const problems = scheduleProblems(t);
    const next = problems.length ? [] : runsOf(t, Date.now(), { limit: 5, tz: plantTz });
    const tz = s.tz ?? plantTz;
    const show = showIn(tz);
    const time = (value, onchange) => ({ input: { type: "time", disabled: ro, value: value ?? "", onchange } });
    return {
        fieldset: {
            key: `schedule-${i}`,
            className: "schedule-card",
            children: [
                { legend: describeSchedule(t, plantTz) || "Schedule" },
                {
                    div: {
                        className: "ed-row",
                        children: [
                            runsSelect(ctx, i, mode, kinds),
                            mode === "every"
                                ? labelled("Every", { span: { className: "inline", children: [
                                    { input: { type: "number", min: 1, max: unit === "hours" ? 24 : 720, disabled: ro, value: String(amount), onchange: (e) => edit((sc) => { sc.every = { [unit]: Number(e.target.value) }; }) } },
                                    { select: { disabled: ro, onchange: (e) => edit((sc) => { sc.every = { [e.target.value]: e.target.value === "hours" ? 1 : 15 }; }), children: noDefault([["minutes", "minutes"], ["hours", "hours"]].map(([v, l]) => ({ option: { value: v, selected: unit === v, textContent: l } }))) } },
                                ] } }, "counted from midnight")
                                : labelled("At", tagsInput({ key: `${ctx.w}.at.${ctx.name}.${i}`, readOnly: ro, placeholder: "Add a time (HH:MM)…", value: s.at ?? [],
                                    // A time of day, read loosely (6:00 is 06:00), or why not.
                                    create: (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, "0")}:${m[2]}` : { error: `“${t}” is not a time of day (HH:MM)` }; },
                                    onChange: (next) => edit((sc) => { sc.at = next; }) }), "times of day, HH:MM"),
                            mode === "every"
                                ? labelled("Only between", { span: { className: "inline", children: [
                                    time(s.between?.[0], (e) => edit((sc) => { const to = sc.between?.[1] ?? "22:00"; if (e.target.value) sc.between = [e.target.value, to]; else delete sc.between; })),
                                    { span: " – " },
                                    time(s.between?.[1], (e) => edit((sc) => { const from = sc.between?.[0] ?? "06:00"; if (e.target.value) sc.between = [from, e.target.value]; else delete sc.between; })),
                                ] } }, "empty: all day; may cross midnight")
                                : { span: {} },
                        ],
                    },
                },
                {
                    div: {
                        className: "checks",
                        children: DAYS.map((d) => ({
                            label: { key: d, children: [{ input: { type: "checkbox", disabled: ro, checked: !s.days || s.days.includes(d), onchange: (e) => edit((sc) => {
                                const days = new Set(sc.days ?? DAYS);
                                if (e.target.checked) days.add(d); else days.delete(d);
                                if (days.size === DAYS.length) delete sc.days; else sc.days = DAYS.filter((x) => days.has(x));
                            }) } }, { span: ` ${d[0].toUpperCase()}${d.slice(1)}` }] },
                        })),
                    },
                },
                whenMissedRow(ctx, t, i, plantTz),
                problems.length
                    ? { ul: { className: "error small", children: problems.map((p, k) => ({ li: { key: k, textContent: p } })) } }
                    : { p: { className: "muted small", textContent: `Next runs (${tz}): ${next.map(show).join(" · ") || "none"}` } },
                ro() ? { span: {} } : { button: { type: "button", className: "btn ghost", textContent: "Remove schedule", onclick: confirmRemove(ctx.api, "this schedule", () => ops.edit((b) => { b.on.splice(i, 1); }) )} },
            ],
        },
    };
}

// When a run is due on the schedule's own clock, written the plant's way.
// (`seconds`: a suite's kind may give times off the minute.)
const showIn = (tz, seconds = false) => (ms) => `${new Date(ms).toLocaleDateString(plant().formats.locale, { timeZone: tz, weekday: "short" })} ${formatDateTime(ms, { ...plant().formats, timeZone: tz }, { seconds })}`;

// How a schedule's times are given: by the clock (every…, at times of day) or by a kind of schedule an
// installed suite adds (§30.11). Changing it starts the new way afresh: a suite's settings empty.
function runsSelect(ctx, i, mode, kinds) {
    const { ops, ro } = ctx;
    const options = [["every", "every…"], ["at", "at times of day"], ...Object.entries(kinds).map(([kind, spec]) => [`from:${kind}`, spec.label ?? kind])];
    // (One whose suite is gone stays listed as what it is.)
    if (mode.startsWith("from:") && !options.some(([v]) => v === mode)) options.push([mode, `${mode.slice(5)} (needs the ${suiteOf(mode.slice(5))} suite)`]);
    const pick = (v) => ops.edit((b) => {
        const tz = b.on[i].schedule?.tz;
        b.on[i].schedule = v === "at" ? { at: ["06:00"] } : v === "every" ? { every: { minutes: 15 } } : { from: v.slice(5) };
        if (tz !== undefined) b.on[i].schedule.tz = tz;
    });
    return labelled("Runs", { select: { disabled: ro, onchange: (e) => pick(e.target.value), children: noDefault(options.map(([v, l]) => ({ option: { value: v, selected: mode === v, textContent: l } }))) } });
}

// The time zone, and what to do with missed and overlapping runs: the same for every schedule.
function whenMissedRow(ctx, t, i, plantTz) {
    const { ops, ro } = ctx;
    const s = t.schedule ?? {};
    const edit = (fn) => ops.edit((b) => { fn(b.on[i].schedule, b.on[i]); });
    return {
        div: {
            className: "ed-row",
            children: [
                labelled("Time zone", { input: { type: "text", disabled: ro, value: s.tz ?? "", placeholder: plantTz, onchange: (e) => edit((sc) => { const v = e.target.value.trim(); if (v) sc.tz = v; else delete sc.tz; }) } }, "empty: the plant's"),
                labelled("Missed runs", { select: { disabled: ro, onchange: (e) => edit((sc, trig) => { trig.missed = e.target.value; }), children: noDefault([["last", "run the latest one"], ["none", "skip them"], ["all", `run each (up to ${MAX_CATCH_UP})`]].map(([v, l]) => ({ option: { value: v, selected: (t.missed ?? "last") === v, textContent: l } }))) } }, "when every node, or the database, was down"),
                labelled("While a run is still going", { select: { disabled: ro, onchange: (e) => edit((sc, trig) => { trig.overlap = e.target.value; }), children: noDefault([["skip", "skip the new run"], ["queue", "queue it"]].map(([v, l]) => ({ option: { value: v, selected: (t.overlap ?? "skip") === v, textContent: l } }))) } }),
            ],
        },
    };
}

// One setting of a suite's kind of schedule, as its kind types it (schedule.js); empty until filled in.
function settingInput(ctx, i, key, type, value) {
    const { ops, ro } = ctx;
    const set = (v) => ops.edit((b) => { if (v === undefined) delete b.on[i].schedule[key]; else b.on[i].schedule[key] = v; });
    if (type === "boolean") return { input: { type: "checkbox", disabled: ro, checked: value === true, onchange: (e) => set(e.target.checked ? true : undefined) } };
    if (type === "number" || type === "integer") return { input: { type: "number", disabled: ro, value: value === undefined || value === null ? "" : String(value), onchange: (e) => set(e.target.value.trim() === "" ? undefined : Number(e.target.value)) } };
    if (type === "list") return tagsInput({ key: `${ctx.w}.set.${ctx.name}.${i}.${key}`, readOnly: ro, placeholder: "Add…", value: Array.isArray(value) ? value : [], onChange: (l) => set(l.length ? l : undefined) });
    return { input: { type: "text", disabled: ro, value: value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value), onchange: (e) => set(e.target.value === "" ? undefined : e.target.value) } };
}

// A suite by its label, as people read it: "the Hello suite", never "the Hello suite suite".
const suiteName = (api, suite) => { const label = (api.peek("suites") ?? []).find((x) => x.name === suite)?.label ?? suite; return /\bsuite$/i.test(label) ? label : `${label} suite`; };

// A schedule whose times a suite's kind works out (§30.11): its settings, the time zone, missed and
// overlap, and its next runs, which the server asks the suite for. One whose suite is not installed is
// shown as it is, to be kept until the suite is back or taken out.
function suiteScheduleCard(ctx, t, i, plantTz, kinds) {
    const { api, ops, ro } = ctx;
    const s = t.schedule ?? {};
    const spec = kinds[s.from] ?? null;
    const config = spec?.config ?? {};
    const keys = [...new Set([...Object.keys(config).filter((k) => k !== "*"), ...Object.keys(s).filter((k) => !["from", "tz"].includes(k))])];
    const problems = scheduleProblems(t, { suiteSchedules: kinds });
    const tz = s.tz ?? plantTz;
    return {
        fieldset: {
            key: `schedule-${i}-${s.from}`,
            className: "schedule-card",
            children: [
                { legend: describeSchedule(t, plantTz, kinds) || "Schedule" },
                hint(spec
                    ? `Its times come from the ${suiteName(api, spec.suite)}, which works them out from the settings below.`
                    : `This schedule needs the ${suiteOf(s.from)} suite, which is not installed here: nothing is planned for it until the suite is back.`),
                { div: { className: "ed-row", children: [
                    runsSelect(ctx, i, `from:${s.from}`, kinds),
                    ...keys.map((k) => labelled(`${k}${(spec?.required ?? []).includes(k) ? " (needed)" : ""}`, settingInput(ctx, i, k, config[k], s[k]))),
                ] } },
                whenMissedRow(ctx, t, i, plantTz),
                problems.length
                    ? { ul: { className: "error small", children: problems.map((p, k) => ({ li: { key: k, textContent: p } })) } }
                    : { SchedulePreview: { key: `preview-${JSON.stringify(t)}`, trigger: clone(t), tz } },
                ro() ? { span: {} } : { button: { type: "button", className: "btn ghost", textContent: "Remove schedule", onclick: confirmRemove(ctx.api, "this schedule", () => ops.edit((b) => { b.on.splice(i, 1); }) )} },
            ],
        },
    };
}

function reachesTab(ctx) {
    const { api, w, body, ops } = ctx;
    const home = api.peek("design.home") ?? {};
    const connections = [...new Set([...(home.connections ?? []).map((c) => c.name), ...Object.keys(api.peek(`${w}.cn`) ?? {})])];
    const uses = body.uses ?? {};
    return {
        div: {
            children: [
                hint("What it may touch, and nothing else. Every record it reads or writes goes through the object's policies and its rule pipe as whoever set it off, exactly as at a form; the stewards of each object it writes, of each connection it uses and of each transaction it runs approve this."),
                { h4: "Connections" },
                connections.length
                    ? checks(ctx, connections.map((c) => ({ value: c })), uses.connections, (v, on) => ops.edit((b) => { b.uses = { ...(b.uses ?? {}), connections: toggleIn(b.uses?.connections, v, on) }; }))
                    : hint("No connection yet: start one from the designer's home, or add one to this change."),
                // The transactions its script may run (ctx.transactions.run, §25): live, drafted in this
                // change, and any it names that is neither (shown, so it can be taken out).
                { h4: "Transactions" },
                (() => {
                    const drafted = api.peek(`${w}.tx`) ?? {};
                    const all = [...new Map([...(uses.transactions ?? []).map((n) => [n, { value: n }]), ...(home.transactions ?? []).map((t) => [t.name, { value: t.name, label: t.label, signed: t.signed }]), ...Object.entries(drafted).map(([n, t]) => [n, { value: n, label: t?.label ?? n, signed: Boolean(t?.signature) }])]).values()].sort((a, b) => String(a.label ?? a.value).localeCompare(String(b.label ?? b.value)));
                    if (!all.length) return hint("No transaction yet.");
                    return { div: { children: [
                        hint("What its script may run, with ctx.transactions.run(name, input): all or nothing, through the transaction's checks and its steps' policies and rules, as whoever the service acts as. A transaction a person signs is not one a service runs. Run as its own service role, the transaction's callers must name this service too; its stewards approve both."),
                        checks(ctx, all.filter((t) => !t.signed || (uses.transactions ?? []).includes(t.value)), uses.transactions, (v, on) => ops.edit((b) => { const next = toggleIn(b.uses?.transactions, v, on); b.uses = { ...(b.uses ?? {}) }; if (next.length) b.uses.transactions = next; else delete b.uses.transactions; })),
                    ] } };
                })(),
                // What an installed suite gives a service's script (ctx.<suite>, §30.11); one the service
                // names that is not installed is shown, so it can be taken out.
                ...[...new Set([...Object.keys(home.suiteCapabilities ?? {}), ...Object.keys(uses.suites ?? {})])].sort().flatMap((suite) => {
                    const given = home.suiteCapabilities?.[suite] ?? null;
                    const named = uses.suites?.[suite] ?? [];
                    const all = [...new Set([...(given ?? []), ...named])];
                    if (!all.length) return [];
                    const set = (v, on) => ops.edit((b) => {
                        const next = toggleIn(b.uses?.suites?.[suite], v, on);
                        const suites = { ...(b.uses?.suites ?? {}) };
                        if (next.length) suites[suite] = next; else delete suites[suite];
                        b.uses = { ...(b.uses ?? {}) };
                        if (Object.keys(suites).length) b.uses.suites = suites; else delete b.uses.suites;
                    });
                    return [
                        { h4: `From the ${(api.peek("suites") ?? []).find((x) => x.name === suite)?.label ?? suite} suite` },
                        given ? hint(`What its script may ask of it, as ctx.${suite.replace(/-/g, "_")}: only what is ticked.`) : hint(`The ${suite} suite is not installed here: the service is refused, in words, when its script asks this of it.`),
                        checks(ctx, all.map((c) => ({ value: c })), named, set),
                    ];
                }),
                { h4: "Objects" },
                {
                    table: {
                        className: "grid ed-table",
                        children: [
                            { thead: { children: [{ tr: { children: ["Object", ...SERVICE_OPS].map((h) => ({ th: h })) } }] } },
                            {
                                tbody: {
                                    children: (home.objects ?? []).map((o) => ({
                                        tr: {
                                            key: o.object,
                                            children: [
                                                { td: o.label },
                                                ...SERVICE_OPS.map((op) => ({
                                                    td: {
                                                        children: [{
                                                            input: {
                                                                type: "checkbox", disabled: ctx.ro, checked: (uses.objects?.[o.object] ?? []).includes(op),
                                                                onchange: (e) => ops.edit((b) => {
                                                                    const objects = { ...(b.uses?.objects ?? {}) };
                                                                    const next = toggleIn(objects[o.object], op, e.target.checked);
                                                                    if (next.length) objects[o.object] = next; else delete objects[o.object];
                                                                    b.uses = { ...(b.uses ?? {}), objects };
                                                                }),
                                                            },
                                                        }],
                                                    },
                                                })),
                                            ],
                                        },
                                    })),
                                },
                            },
                        ],
                    },
                },
            ],
        },
    };
}

function scriptTab(ctx) {
    const { api, w, name, ops, ro } = ctx;
    const source = () => api.getState(`${w}.s.${name}`, undefined);
    return {
        div: {
            children: [
                hint("The rule-script contract: one function named as the service, context in, context out; throw to refuse (the caller reads the words), or throw with { retry: true } when the other system is down. ctx.records and ctx.http are its only reach."),
                // Read without tracking: the editor follows the text itself, and a tab redrawn on
                // every keystroke would take the caret away.
                api.peek(`${w}.s.${name}`) === undefined
                    ? { p: { className: "muted", textContent: "Its published script is not in this change." } }
                    : { CodeEditor: { key: `ce-${name}`, mode: "js", rows: 22, label: `${name}.js`, readOnly: ro, value: () => source() ?? "", onInput: (text) => ops.setScript(name, text), lint: (t) => callableProblems(t, "service", { suites: ctx.body?.uses?.suites }), runError: dryRunError(api, w, name) } },
                () => {
                    api.getState(`${w}.vrev`);
                    const src = api.peek(`${w}.s.${name}`);
                    if (src === undefined) return { span: {} };
                    const problems = validateScript(name, src, compileInPage);
                    return { p: { className: problems.length ? "error small" : "notice small", textContent: problems.length ? problems[0].message : "Compiles; the name rule holds." } };
                },
                api.peek(`${w}.s.${name}`) === undefined ? { span: {} } : { DryRun: { key: `dry-${name}`, id: ctx.id, kind: "service", name } },
                api.peek(`${w}.s.${name}`) === undefined ? { span: {} } : { TestCases: { key: `cases-${name}`, id: ctx.id, name, readOnly: ro } },
            ],
        },
    };
}

function stewardsOf(ctx) {
    const { api, body, ops } = ctx;
    const depts = api.peek("design.home.departments") ?? [];
    return {
        div: {
            children: [
                hint(ctx.kind === "service"
                    ? "Its stewards approve every change to it. A change to what it reaches (objects it writes or reacts to, connections it uses) is also approved by their stewards."
                    : "Its stewards approve every change to it: its address, its authentication and the requests it allows. A service that starts using it is approved by them too."),
                checks(ctx, depts.map((d) => ({ value: d.id, label: d.name })), body.stewards, (v, on) => ops.edit((b) => { b.stewards = toggleIn(b.stewards, v, on); })),
            ],
        },
    };
}

export function jsonOf(ctx) {
    const { api, w, ops, ro, name, kind } = ctx;
    const draft = `${w}.json.${kind}.${name}`;
    return {
        div: {
            children: [
                hint(`The whole ${kind} as JSON, for integrators. Apply to replace the draft; every check runs on it as on any other edit.`),
                { CodeEditor: { mode: "json", rows: 24, label: `${name} as JSON`, readOnly: ro, value: () => { api.getState(`${w}.vrev`); return api.getState(draft, null) ?? JSON.stringify(api.peek(ops.root), null, 2); }, onInput: (text) => api.setValue(draft, text) } },
                ro() ? { span: {} } : {
                    button: {
                        type: "button", className: "btn", textContent: "Apply JSON",
                        onclick: () => {
                            try {
                                const parsed = JSON.parse(api.peek(draft) ?? "null");
                                if (parsed?.name !== name) throw new Error(`the name must stay "${name}"`);
                                ops.edit((b) => { for (const k of Object.keys(b)) delete b[k]; Object.assign(b, parsed); });
                                api.setValue(draft, null);
                            } catch (e) {
                                api.setValue(`${w}.error`, `JSON: ${e.message}`);
                            }
                        },
                    },
                },
            ],
        },
    };
}

// ---- a connection's tabs ----
function connectionGeneral(ctx) {
    const { body, ops, ro } = ctx;
    return {
        div: {
            className: "ed-grid",
            children: [
                labelled("Name", { input: { type: "text", value: body.name, disabled: true } }, "Fixed once created; services name it."),
                labelled("Label", text(ctx, "label")),
                labelled("Base URL", text(ctx, "baseUrl", { placeholder: "https://erp.example.com/api" }), "Every request goes here and stays here: redirects are not followed."),
                labelled("Timeout (ms)", { input: { type: "number", min: 100, max: 30000, disabled: ro, value: body.timeoutMs ?? 5000, onchange: (e) => ops.set("timeoutMs", Number(e.target.value), true) } }),
            ],
        },
    };
}

function authTab(ctx) {
    const { body, ops, ro } = ctx;
    const auth = body.auth ?? { kind: "none" };
    return {
        div: {
            className: "ed-grid",
            children: [
                labelled("Kind", { select: { disabled: ro, onchange: (e) => ops.set("auth.kind", e.target.value, true), children: noDefault(AUTH_KINDS.map((k) => ({ option: { value: k, selected: auth.kind === k, textContent: k } }))) } }),
                auth.kind === "none" ? { span: {} } : labelled("Secret", text(ctx, "auth.secret", { structural: true, placeholder: "erp_token" }), `Named here; its value is set on the server (MES_SECRET_${String(auth.secret ?? "").toUpperCase()}) and never appears in a design, a review or the audit.`),
                auth.kind === "header" ? labelled("Header", text(ctx, "auth.header", { placeholder: "X-API-Key" })) : { span: {} },
            ],
        },
    };
}

function allowTab(ctx) {
    const { body, ops, ro } = ctx;
    return {
        div: {
            children: [
                hint("The only requests a service may send this system. A path ending in * allows what follows it (/orders/*); anything not listed is refused, and the refusal is logged."),
                {
                    table: {
                        className: "grid ed-table",
                        children: [
                            { thead: { children: [{ tr: { children: ["Method", "Path", ""].map((h) => ({ th: h })) } }] } },
                            {
                                tbody: {
                                    children: (body.allow ?? []).map((a, i) => ({
                                        tr: {
                                            key: `${i}-${a.method}-${a.path}`,
                                            children: [
                                                { td: { children: [{ select: { disabled: ro, onchange: (e) => ops.set(`allow.${i}.method`, e.target.value, true), children: noDefault(HTTP_METHODS.map((m) => ({ option: { value: m, selected: a.method === m, textContent: m } }))) } }] } },
                                                { td: { children: [text(ctx, `allow.${i}.path`, { structural: true })] } },
                                                { td: { children: ro() ? [] : [{ button: { type: "button", className: "btn ghost", textContent: "Remove", onclick: confirmRemove(ctx.api, "this entry", () => ops.edit((b) => { b.allow.splice(i, 1); }) )} }] } },
                                            ],
                                        },
                                    })),
                                },
                            },
                        ],
                    },
                },
                ro() ? { span: {} } : { button: { type: "button", className: "btn", textContent: "Add request", onclick: () => ops.edit((b) => { (b.allow ??= []).push({ method: "POST", path: "/" }); }) } },
            ],
        },
    };
}

export function registerIntegrationEditor(juris) {
    juris.registerComponent("IntegrationEditor", ({ id, editable, pane = 0, kind, name, head }, api) => {
        const w = W(id);
        const ops = elementOps(api, id, kind, name);
        const views = kind === "service" ? SERVICE_VIEWS : CONNECTION_VIEWS;
        const view = () => {
            const v = api.getState(`${w}.panes.${pane}.view`, "general");
            return views.some(([key]) => key === v) ? v : "general";
        };
        const ro = () => !api.prop(editable);
        return {
            div: {
                className: "editor",
                children: [
                    {
                        div: {
                            className: "editor-head",
                            children: [
                                head ?? { span: {} },
                                { nav: { className: "subtabs", children: views.map(([key, label, glyph]) => ({ button: { key, type: "button", className: "subtab", classList: { active: () => view() === key }, onclick: () => api.setValue(`${w}.panes.${pane}.view`, key), children: [glyph ? icon(glyph) : { span: {} }, { span: label }, () => {
                                    // How many differences from the published version this tab holds (compare.js).
                                    api.getState(`${w}.vrev`);
                                    api.getState(`dc.${id}.updated_at`);
                                    const all = changesOf(api, id, kind, name);
                                    const n = key === "changes" ? all.length : countByTab(all)[key] ?? 0;
                                    return n ? { span: { className: "tab-diff", title: `${n} change(s) from the published version`, textContent: String(n) } } : { span: {} };
                                }] } })) } },
                            ],
                        },
                    },
                    () => {
                        api.getState(`${w}.rev`);
                        const body = api.peek(ops.root);
                        if (!body) return { p: { className: "muted", textContent: "Loading…" } };
                        const ctx = { api, w, ops, ro, body, id, kind, name, root: ops.root };
                        switch (view()) {
                            case "copilot": return { CopilotPanel: { key: `copilot-${id}`, id } };
                            case "input": return inputTab(ctx);
                            case "callers": return callersTab(ctx);
                            case "triggers": return triggersTab(ctx);
                            case "reaches": return reachesTab(ctx);
                            case "script": return scriptTab(ctx);
                            case "try": return { ServiceTry: { key: `try-${name}`, name, body: clone(body) } };
                            case "activity": return { IntegrationActivity: { key: `act-${kind}-${name}`, kind, name } };
                            case "changes": return { ChangesView: { key: `changes-${kind}-${name}`, id, kind, name, onOpen: (tab) => api.setValue(`${w}.panes.${pane}.view`, tab) } };
                            case "stewards": return stewardsOf(ctx);
                            case "json": return jsonOf(ctx);
                            case "auth": return authTab(ctx);
                            case "allow": return allowTab(ctx);
                            default: return kind === "service" ? serviceGeneral(ctx) : connectionGeneral(ctx);
                        }
                    },
                ],
            },
        };
    });

    // A dry run (§15.2) of the draft script, on the server: executed with everything it may call
    // callable. Reads are real, with your rights; writes go through policy and the rule pipe and are
    // not saved; requests are checked and answered from `responses`, never sent.
    juris.registerComponent("DryRun", ({ id, kind, name, writes = [], example: sample = {} }, api) => {
        const w = W(id);
        const key = `${w}.run.${name}`;
        const home = () => api.peek("design.home") ?? {};
        const template = () => {
            // A suite's script: the input its suite gives it, as the suite shows it.
            if (kind === "plain") return JSON.stringify(sample ?? {}, null, 2);
            if (kind === "rule") {
                const fields = Object.keys(api.peek(`${w}.b.fields`) ?? {});
                return JSON.stringify({ event: { kind: "save", changed: [] }, data: Object.fromEntries(fields.map((f) => [f, null])), record: {} }, null, 2);
            }
            const body = api.peek(`${w}.sv.${name}`) ?? {};
            const example = Object.fromEntries(Object.entries(body.input ?? {}).map(([k, f]) => [k, { integer: 1, decimal: 1.5, boolean: true, date: "2026-10-01", enum: f.values?.[0] ?? "" }[f.type] ?? ""]));
            const responses = {};
            for (const c of body.uses?.connections ?? []) {
                for (const a of (api.peek(`${w}.cn.${c}`)?.allow ?? [])) responses[`${a.method} ${a.path.replace(/\*$/, "1")}`] = { status: 200, body: {} };
            }
            if (!Object.keys(responses).length && (body.uses?.connections ?? []).length) responses["POST /path"] = { status: 200, body: {} };
            const trigger = body.on?.[0];
            const event = trigger && !body.http?.enabled ? { kind: trigger.event, object: trigger.object, id: "<a record id>" } : null;
            return JSON.stringify({ ...(event ? { event } : { input: example }), ...(Object.keys(responses).length ? { responses } : {}) }, null, 2);
        };
        const [given, setGiven] = api.useState("given", null);
        const [busy, setBusy] = api.useState("busy", false);
        const [caseName, setCaseName] = api.useState("caseName", "");
        // Who a service's dry run acts as is its design's identity (resolved on the server, as in
        // production). Running as its caller, you may stand in as one of its declared callers.
        const identities = () => {
            if (kind !== "service") return [];
            const body = api.peek(`${w}.sv.${name}`) ?? {};
            return serviceIdentity(body) === "caller" ? [...new Set(body.callers?.users ?? [])] : [];
        };
        const defaultAs = () => api.peek("me.id");
        const identityWords = () => {
            const body = api.peek(`${w}.sv.${name}`) ?? {};
            const mode = serviceIdentity(body);
            if (mode === "service") return `as service:${name}, with its draft service role (${Object.entries(body.roles ?? {}).map(([o, r]) => `${o}: ${r.join("/")}`).join(", ") || "no roles yet"})`;
            if (mode === "caller") return "as its caller";
            return `as ${mode}`;
        };
        const [asUser, setAs] = api.useState("as", null);
        const sourceNow = () => api.peek(`${w}.s.${name}`) ?? (api.peek(`${w}.viewing`)?.name === name ? api.peek(`${w}.viewing`).source : "");
        const run = async () => {
            const source = sourceNow();
            let parsed;
            try { parsed = JSON.parse(given() ?? template()); } catch { api.setValue(key, { ok: false, error: { message: "The dry run's input is not JSON." }, source: null }); return; }
            const syntax = findSyntaxError(source);
            if (syntax) { api.setValue(key, { ok: false, error: { message: `Fix line ${syntax.line} first: ${syntax.message}` }, source: null }); return; }
            setBusy(true);
            try {
                const result = await api.call("design.dryRun", {
                    kind, name, source,
                    ...(kind === "service" ? { service: clone(api.peek(`${w}.sv.${name}`)), connections: clone(api.peek(`${w}.cn`) ?? {}), transactions: clone(api.peek(`${w}.tx`) ?? {}) } : {}),
                    run: kind === "rule" ? { ...parsed, writes } : { ...parsed, as: asUser() ?? defaultAs() },
                });
                api.setValue(key, { ...result, source });
            } catch (e) {
                api.setValue(key, { ok: false, error: { message: e.message, fields: e.fields }, source: null });
            } finally {
                setBusy(false);
            }
        };
        const me = () => (home().users ?? []).find((u) => u.id === api.peek("me.id"))?.name ?? "you";
        const block = (title, value) => ({ div: { className: "dry-block", children: [{ strong: title }, { pre: { textContent: typeof value === "string" ? value : JSON.stringify(value, null, 2) } }] } });
        return {
            details: {
                className: "dry-run", open: true,
                children: [
                    { summary: { children: [{ strong: "Dry run" }, { span: { className: "muted small", textContent: " — execute this draft, changing nothing" } }] } },
                    { p: { className: "muted small", textContent: () => `Runs on the server, in the sandbox it will run in, ${kind === "service" ? identityWords() : `as ${me()}`}, exactly as in production. Writes go through the object's policy and rule pipe and are not saved; requests are checked against the connection and answered from "responses", never sent.` } },
                    { CodeEditor: { mode: "json", rows: 6, label: "Dry run input", value: () => given() ?? template(), onInput: (t) => setGiven(t) } },
                    { div: { className: "dry-buttons", children: [
                        { button: { type: "button", className: "btn primary", disabled: busy, children: () => (busy() ? [{ span: "Running…" }] : [icon("play"), { span: "Run" }]), onclick: run } },
                        { button: { type: "button", className: "btn ghost", textContent: "Reset input", onclick: () => setGiven(null) } },
                        () => (kind === "service" && identities().length ? {
                            label: { className: "dry-as", children: [
                                { span: { className: "muted small", textContent: "as " } },
                                { select: {
                                    title: "Who the script acts as. Another's rights are audited.",
                                    onchange: (e) => setAs(e.target.value),
                                    children: noDefault([...new Set([api.peek("me.id"), ...identities()])].map((u) => ({ option: { value: u, selected: (asUser() ?? defaultAs()) === u, textContent: u === api.peek("me.id") ? `caller: you (${u})` : `caller: ${u}` } }))),
                                } },
                            ] },
                        } : { span: {} }),
                    ] } },
                    () => {
                        const r = api.getState(key, null);
                        if (!r) return { span: {} };
                        const e = r.error;
                        return {
                            div: {
                                className: `dry-result ${r.ok ? "ok" : "bad"}`,
                                children: [
                                    { div: { className: "dry-head", children: [
                                        { span: { className: `badge ${r.ok ? "s-executed" : e?.fault ? "s-rejected" : "s-review"}`, textContent: r.ok ? "ran" : e?.retry ? "asks to retry" : e?.fault ? "failed" : "refused" } },
                                        { span: { className: "muted small", textContent: r.ms !== undefined ? ` ${r.as ? `as ${r.as}${r.onBehalfOf ? ` for ${r.onBehalfOf}` : ""} · ` : ""}${r.ms} ms · nothing was saved or sent` : "" } },
                                    ] } },
                                    r.ms !== undefined ? { div: { className: "dry-save", children: [
                                        { input: { placeholder: "test case name (what this shows)", value: () => caseName(), oninput: (e) => setCaseName(e.target.value) } },
                                        { button: { type: "button", className: "btn", textContent: "Save as test case", disabled: () => !caseName().trim(), onclick: () => { addCase(api, id, name, caseFrom(kind, caseName().trim(), JSON.parse(given() ?? template()), r, asUser() ?? defaultAs(), api.peek("me.id"))); setCaseName(""); } } },
                                    ] } } : { span: {} },
                                    e ? { p: { className: "error small", textContent: `${e.line ? `Line ${e.line}${e.column ? `:${e.column}` : ""} — ` : ""}${e.name && e.name !== "Error" && e.name !== "ServiceError" ? `${e.name}: ` : ""}${e.message}${e.fields ? ` ${JSON.stringify(e.fields)}` : ""}` } } : { span: {} },
                                    r.output !== undefined && r.output !== null ? block("Output", r.output) : { span: {} },
                                    kind === "rule" && r.changed ? block(`Data (changed: ${r.changed.join(", ") || "nothing"})`, r.data) : { span: {} },
                                    r.writes?.length ? block("Would write (not saved)", r.writes.map((x) => `${x.op} ${x.object}${x.id ? ` ${x.id.slice(0, 8)}` : ""}${x.action ? ` → ${x.action}` : ""} ${x.data ? JSON.stringify(x.data) : ""}`).join("\n")) : { span: {} },
                                    r.transactions?.length ? block("Would run (not run)", r.transactions.map((t) => `${t.transaction}${t.key ? ` (key ${t.key})` : ""} ${JSON.stringify(t.input)}${t.error ? `\n  → refused: ${t.error}` : `\n  → ${t.changes} record(s) it would change`}`).join("\n")) : { span: {} },
                                    r.requests?.length ? block("Would send (not sent)", r.requests.map((q) => `${q.method} ${q.url}  [auth: ${q.auth}]${q.body !== undefined && q.body !== null ? `\n  body: ${JSON.stringify(q.body)}` : ""}\n  → answered ${q.response.status} ${JSON.stringify(q.response.body)}`).join("\n")) : { span: {} },
                                    r.reads?.length ? block("Read", r.reads.map((x) => `${x.op} ${x.object} ${x.id ?? JSON.stringify(x.where ?? {})} → ${x.found !== undefined ? (x.found ? "found" : "not found") : `${x.count} row(s)`}`).join("\n")) : { span: {} },
                                ],
                            },
                        };
                    },
                ],
            },
        };
    });

    // A script's test cases (§5.9): what the fitness test runs, with each one's last result.
    juris.registerComponent("TestCases", ({ id, name, readOnly }, api) => {
        const w = W(id);
        const [asJson, setAsJson] = api.useState("json", false);
        const ro = () => Boolean(typeof readOnly === "function" ? readOnly() : readOnly);
        const setCases = (cases) => {
            history.before(api, w);
            api.setValue(`${w}.t.${name}`, cases);
            api.setValue(`${w}.dirty`, true);
            api.setValue(`${w}.vrev`, (api.peek(`${w}.vrev`) ?? 0) + 1);
            // The list below redraws on it: a case removed goes at once, as one added comes (addCase).
            api.setValue(`${w}.casesRev`, (api.peek(`${w}.casesRev`) ?? 0) + 1);
        };
        return {
            div: {
                className: "test-cases",
                children: [
                    { div: { className: "pane-bar", children: [
                        { strong: "Test cases" },
                        { span: { className: "muted small", textContent: " — run by the fitness test before this change can be submitted" } },
                        { span: { className: "spacer" } },
                        { button: { type: "button", className: "btn ghost", textContent: () => (asJson() ? "List" : "JSON"), onclick: () => setAsJson(!asJson()) } },
                    ] } },
                    () => {
                        api.getState(`${w}.casesRev`);
                        api.getState(`dc.${id}.updated_at`);
                        const cases = api.peek(`${w}.t.${name}`) ?? [];
                        if (asJson()) {
                            return { CodeEditor: { key: `cases-${name}`, mode: "json", rows: 8, label: `${name} test cases`, readOnly: ro, value: () => JSON.stringify(api.getState(`${w}.t.${name}`, []) ?? [], null, 2), onInput: (text) => { try { const v = JSON.parse(text); if (Array.isArray(v)) setCases(v); } catch { /* the editor marks it */ } } } };
                        }
                        if (!cases.length) return { p: { className: "muted small", textContent: "None yet: run a dry run above and save it as a test case. A new or changed script needs at least one." } };
                        const last = (api.peek(`dc.${id}.fitness.checks`) ?? []).find((c) => c.id === "tests")?.cases ?? [];
                        const current = api.peek(`dc.${id}.fitnessCurrent`);
                        return {
                            ul: {
                                className: "case-list",
                                children: cases.map((c, i) => {
                                    const result = last.find((x) => x.script === name && x.name === c.name);
                                    return {
                                        li: {
                                            key: `${i}-${c.name}`,
                                            children: [
                                                { span: { className: `case-mark ${result ? (result.passed ? "ok" : "bad") : "none"}${current ? "" : " stale"}`, children: [icon(result ? (result.passed ? "check" : "x") : "circle")], title: result ? `${result.detail}${current ? "" : " (before the latest edits)"}` : "Not run yet" } },
                                                { span: { className: "case-name", textContent: c.name } },
                                                { span: { className: "muted small", textContent: ` ${c.as ? `as ${c.as} · ` : ""}${c.expect?.throws || c.expect?.ok === false ? "expects a refusal" : "expects it to run"}` } },
                                                result && !result.passed ? { div: { className: "error small", textContent: result.detail } } : { span: {} },
                                                ro() ? { span: {} } : { button: { type: "button", className: "linkish", textContent: "remove", onclick: confirmRemove(api, "this test case", () => setCases(cases.filter((_, j) => j !== i)) )} },
                                            ],
                                        },
                                    };
                                }),
                            },
                        };
                    },
                ],
            },
        };
    });

    // The next runs of a schedule a suite's kind gives the times of (§30.11): only the server can ask
    // the suite (integration.scheduleRuns). Drawn afresh for each version of the schedule (its key).
    juris.registerComponent("SchedulePreview", ({ trigger, tz }, api) => {
        const [answer, setAnswer] = api.useState("answer", null);
        if (!api.isServer) api.onMount(() => { api.call("integration.scheduleRuns", { trigger }).then(setAnswer, (e) => setAnswer({ error: e.message })); });
        return {
            p: {
                className: () => (answer()?.error || answer()?.problems?.length ? "error small" : "muted small"),
                textContent: () => {
                    const a = answer();
                    if (!a) return `Next runs (${tz}): working them out…`;
                    if (a.error) return a.error;
                    if (a.problems?.length) return a.problems.join(" ");
                    const at = a.runs.map((iso) => Date.parse(iso));
                    return `${a.text}. Next runs (${tz}): ${at.map(showIn(tz, at.some((ms) => ms % 60_000 !== 0))).join(" · ") || "none"}`;
                },
            },
        };
    });

    // Calls the published service as the signed-in person: what a caller gets, refusals included.
    juris.registerComponent("ServiceTry", ({ name, body }, api) => {
        const published = () => (api.getState("design.home.services", []) ?? []).some((s) => s.name === name);
        const example = Object.fromEntries(Object.entries(body.input ?? {}).map(([k, f]) => [k, { integer: 1, decimal: 1.5, boolean: true, date: "2026-10-01", enum: f.values?.[0] ?? "" }[f.type] ?? ""]));
        const [input, setInput] = api.useState("input", JSON.stringify(example, null, 2));
        const [answer, setAnswer] = api.useState("answer", null);
        const run = async () => {
            let parsed;
            try { parsed = JSON.parse(input()); } catch { setAnswer({ error: "The input is not JSON." }); return; }
            try { setAnswer({ ok: await api.call("integration.call", { name, input: parsed }) }); } catch (e) { setAnswer({ error: e.message, fields: e.fields }); }
        };
        return {
            div: {
                children: () => (published()
                    ? [
                        { p: { key: "h", className: "muted small", textContent: "Calls the published version, as you, through its callers, its input checks, the policies and rule pipes of what it touches, and the audit. Your draft is not what runs." } },
                        { CodeEditor: { key: "i", mode: "json", rows: 8, label: "Input as JSON", value: () => input(), onInput: (text) => setInput(text) } },
                        { button: { key: "b", type: "button", className: "btn primary", textContent: "Call it", onclick: run } },
                        () => (answer() ? { pre: { className: `try-answer ${answer().error ? "bad" : "ok"}`, textContent: JSON.stringify(answer().error ? { error: answer().error, fields: answer().fields } : answer().ok, null, 2) } } : { span: {} }),
                    ]
                    : [{ p: { key: "n", className: "muted", textContent: "Try it once its change is executed: only a published service runs." } }]),
            },
        };
    });

    // What a service did (its calls, from the audit trail) and its triggers' outbox, with a retry.
    juris.registerComponent("IntegrationActivity", ({ kind, name }, api) => {
        const [data, setData] = api.useState("data", null);
        const [error, setError] = api.useState("error", null);
        const load = () => api.call("integration.activity", kind === "service" ? { name } : {}).then((d) => {
            // A connection's activity: the calls that sent it a request.
            setData(kind === "service" ? d : { calls: d.calls.filter((c) => (c.calls ?? []).some((r) => r.connection === name)), outbox: [] });
        }, (e) => setError(e.message));
        if (!api.isServer) api.onMount(() => { load(); });
        const retry = (rowId) => api.call("integration.retry", { id: rowId }).then(load, (e) => setError(e.message));
        return {
            div: {
                children: [
                    { div: { className: "pane-bar", children: [{ span: { className: "muted small", textContent: "The latest calls and triggers." } }, { span: { className: "spacer" } }, { button: { type: "button", className: "btn", textContent: "Refresh", onclick: load } }] } },
                    { p: { className: "error small", textContent: () => error() ?? "" } },
                    () => {
                        const d = data();
                        if (!d) return { p: { className: "muted", textContent: "Loading…" } };
                        return {
                            div: {
                                children: [
                                    { h4: `Calls (${d.calls.length})` },
                                    d.calls.length ? {
                                        table: {
                                            className: "grid",
                                            children: [
                                                { thead: { children: [{ tr: { children: ["When", "As", "Outcome", "How", "Requests", "ms"].map((h) => ({ th: h })) } }] } },
                                                { tbody: { children: d.calls.map((c) => ({ tr: { key: c.seq, children: [
                                                    { td: plant().dateTime(c.at) },
                                                    { td: c.actor },
                                                    { td: { children: [{ span: { className: `badge ${c.action.startsWith("called") ? "s-executed" : c.action.startsWith("rejected") ? "s-review" : "s-rejected"}`, textContent: c.action.split(":")[0] } }, c.error ? { div: { className: "muted small", textContent: c.error.message } } : { span: {} }] } },
                                                    { td: c.via?.http ? `web (${c.via.http})` : c.via?.schedule ? "schedule" : c.via?.trigger ? `trigger ${c.via.trigger}` : "UI" },
                                                    // A request sent, a transaction run (§25), or what it asked of a suite (§30.11).
                                                    { td: (c.calls ?? []).map((r) => (r.transaction ? `ran ${r.transaction}${r.error ? `: refused (${r.error})` : ""}` : r.suite ? `${r.suite}.${r.call}${r.error ? `: ${r.error}` : ""}` : `${r.method} ${r.path} → ${r.status ?? "unreachable"}`)).join("; ") || "—" },
                                                    { td: String(c.ms ?? "") },
                                                ] } })) } },
                                            ],
                                        },
                                    } : { p: { className: "muted small", textContent: "None yet." } },
                                    kind === "service" ? { h4: `Triggers (${d.outbox.length})` } : { span: {} },
                                    kind === "service" && d.outbox.length ? {
                                        table: {
                                            className: "grid",
                                            children: [
                                                { thead: { children: [{ tr: { children: ["#", "Event", "State", "Tries", "Last error", ""].map((h) => ({ th: h })) } }] } },
                                                { tbody: { children: d.outbox.map((o) => ({ tr: { key: o.id, children: [
                                                    { td: String(o.id) },
                                                    { td: o.event.kind === "schedule" ? `schedule ${plant().dateTime(o.event.scheduledAt)}${o.event.manual ? " (run now)" : ""}${o.event.page > 1 ? ` · page ${o.event.page}` : ""}` : `${o.event.object} ${o.event.kind}` },
                                                    { td: { children: [{ span: { className: `badge ${o.state === "done" ? "s-executed" : ["retry", "running", "pending"].includes(o.state) ? "s-review" : "s-rejected"}`, textContent: o.state } }] } },
                                                    { td: String(o.attempts) },
                                                    { td: o.last_error ?? "" },
                                                    { td: { children: ["retry", "dead", "rejected"].includes(o.state) ? [{ button: { type: "button", className: "btn ghost", textContent: "Send again", onclick: () => retry(o.id) } }] : [] } },
                                                ] } })) } },
                                            ],
                                        },
                                    } : { span: {} },
                                ],
                            },
                        };
                    },
                ],
            },
        };
    });
}
