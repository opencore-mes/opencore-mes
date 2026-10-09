// The designer's editor for people & departments (DESIGN.md §5.6, §8): the organization as one draft
// (`${w}.org`): departments with their members and approval steps, people, groups, the roles each
// object's users and groups hold, the governance department and the standing approvers. Changed
// through a change request and approved by whom it affects, like everything else.
import { validateOrganization, organizationFootprint, roleChanges, effectiveRoles, STANDING_KINDS, PSEUDO_ROLES, IDENTIFIER, PERSON_ID, INTEGRITY_REPORT, integrityProblems, signInProblems, SIGN_IN_DOMAIN } from "./definition.js";
import { noDefault } from "./select.js";
import { formatter, DATE_FORMATS, DEFAULT_FORMATS } from "./format.js";
import { DEFAULTS, THEME_COLORS, HEADER_COLORS, TONES, headerOf, soft } from "./theme.js";
import { RETENTION_KINDS, FOREVER, parsePeriod, periodWords, retentionProblems } from "./retention.js";
import { changesOf, countByTab } from "./compare.js";
import { W, clone, labelled, editorPanel } from "./editor-kit.js";
import { titleTab } from "./shell.js";
import { pickMany, tagsInput } from "./pick.js";
import { icon } from "./icons.js";
import { confirmDialog, confirmRemove } from "./dialog.js";
import * as history from "./undo.js";
import { peopleCsv, importPeople, importWords, findPeople, MIN_SEARCH } from "./people-file.js";
import { windowTable } from "./window-rows.js";

export const ORG_VIEWS = [["changes", "Changes"], ["departments", "Departments"], ["groups", "Groups"], ["people", "People"], ["roles", "Roles"], ["certifications", "Certifications"], ["standing", "Approvals"], ["formats", "Formats"], ["theme", "Theme"], ["retention", "Retention"], ["integrity", "Integrity"], ["signin", "Sign-in"], ["json", "JSON"]];
const KIND_LABELS = { object: "objects (their fields, states, policies…)", script: "rule scripts", service: "services", connection: "connections (outside systems)", transaction: "transactions", screen: "screens", layout: "report layouts", query: "named queries", organization: "people & departments" };
const hint = (words) => ({ p: { className: "muted small", textContent: words } });
const toggleIn = (list, value, on) => { const set = new Set(list ?? []); if (on) set.add(value); else set.delete(value); return [...set]; };

function orgOps(api, id) {
    const w = W(id);
    const root = `${w}.org`;
    const bump = (k) => api.setValue(`${w}.${k}`, (api.peek(`${w}.${k}`) ?? 0) + 1);
    return {
        root,
        set(path, value) { history.before(api, w, `org.${path}`); api.setValue(`${root}.${path}`, value); api.setValue(`${w}.dirty`, true); bump("vrev"); },
        edit(fn) { history.before(api, w); const copy = clone(api.peek(root)); fn(copy); api.setValue(root, copy); api.setValue(`${w}.dirty`, true); bump("vrev"); bump("rev"); },
    };
}
function orgKnown(api, id = null) {
    const home = api.peek("design.home") ?? {};
    return {
        objects: Object.fromEntries((home.objects ?? []).map((o) => [o.object, { roles: o.roles ?? [], stewards: { object: o.stewards ?? [] } }])),
        liveDepartments: Object.keys(home.organization?.departments ?? {}),
        ...(id && api.peek(`dc.${id}.live.organization`) ? { liveRoles: api.peek(`dc.${id}.live.organization.roles`) ?? {} } : {}),
        // Setup open now (§5.15): ending it then waits for someone to review besides its designers.
        liveSetup: home.setupOpen === true,
    };
}
export function organizationProblems(api, id) {
    const org = api.peek(`${W(id)}.org`);
    return org ? validateOrganization(org, orgKnown(api, id)).map((p) => ({ ...p, message: `Organization: ${p.message}` })) : [];
}
export function organizationElements(api, id, change) {
    const org = api.peek(`${W(id)}.org`);
    return org ? organizationFootprint(change.live.organization ?? null, org, { objects: orgKnown(api).objects }) : [];
}

const checks = (ro, items, current, onToggle) => ({ div: { className: "checks", children: items.map(({ value, label }) => ({ label: { key: value, children: [{ input: { type: "checkbox", disabled: ro, checked: (current ?? []).includes(value), onchange: (e) => onToggle(value, e.target.checked) } }, { span: ` ${label ?? value}` }] } })) } });
const people = (org) => Object.entries(org.users ?? {}).filter(([, u]) => u.active !== false).map(([id, u]) => ({ value: id, label: u.name, hint: id }));
function addRow(api, key, placeholder, onAdd, second = null, pattern = IDENTIFIER) {
    const path = `org.adding.${key}`;
    return {
        div: {
            className: "add-row",
            children: [
                { input: { type: "text", placeholder, value: () => api.getState(`${path}.id`, "") ?? "", oninput: (e) => api.setValue(`${path}.id`, e.target.value.trim().toLowerCase()) } },
                second ? { input: { type: "text", placeholder: second, value: () => api.getState(`${path}.name`, "") ?? "", oninput: (e) => api.setValue(`${path}.name`, e.target.value) } } : { span: {} },
                { button: { type: "button", className: "btn", textContent: "Add", disabled: () => !pattern.test(api.getState(`${path}.id`, "") ?? "") || (second && !String(api.getState(`${path}.name`, "") ?? "").trim()), onclick: () => { onAdd(api.peek(`${path}.id`), String(api.peek(`${path}.name`) ?? "").trim()); api.setValue(path, {}); } } },
            ],
        },
    };
}

// What the draft does to each person's roles: a move between departments takes the old one's roles
// away and gives the new one's. Each loss can be kept, as the person's own.
function peopleImpact(ctx) {
    const { api, org, ops, ro } = ctx;
    // People new in this change only get their departments' roles: counted, not listed one by one.
    const live = api.peek(`dc.${ctx.id}.live.organization.users`) ?? {};
    const all = ctx.impact();
    const changes = all.filter((c) => Object.hasOwn(live, c.user));
    const added = all.length - changes.length;
    if (!all.length) return { span: {} };
    const words = (list) => list.map((x) => `${x.role.replace(":", " ")} (${x.via})`).join(", ");
    return {
        fieldset: {
            key: "impact",
            className: "tx-card org-impact",
            children: [
                { legend: { children: [{ strong: `What this changes for people (${changes.length})` }] } },
                hint("Roles given to a department or group come with belonging to it: moving someone moves their roles. Keep a lost role by giving it to the person directly."),
                added ? hint(`${added} new ${added === 1 ? "person gets" : "people get"} the roles of the departments they join.`) : { span: {} },
                // In a box of its own, a window of rows drawn (window-rows.js): a reorganization may move thousands.
                changes.length ? windowTable({ key: `impact-${ctx.id}-${changes.length}`, className: "org-impact-list", count: changes.length, row: (i) => { const c = changes[i]; return { tr: { key: c.user, children: [{ td: { children: [
                        { strong: c.name },
                        c.lost.length ? { div: { className: "impact-lost", children: [
                            { span: `loses ${words(c.lost)}` },
                            ro() ? { span: {} } : { button: { type: "button", className: "mini", title: `Give these roles to ${c.name} directly`, textContent: "Keep them", onclick: () => ops.edit((o) => { for (const x of c.lost) { const [object, role] = x.role.split(":"); const held = ((o.roles[object] ??= {})[role] ??= []); if (!held.includes(`user:${c.user}`)) held.push(`user:${c.user}`); } }) } },
                        ] } } : { span: {} },
                        c.gained.length ? { div: { className: "impact-gained", textContent: `gains ${words(c.gained)}` } } : { span: {} },
                    ] } }] } }; } }) : { span: {} },
            ],
        },
    };
}

function departmentsTab(ctx) {
    const { api, org, ops, ro } = ctx;
    const everyone = people(org);
    return {
        div: {
            children: [
                peopleImpact(ctx),
                hint("Each department approves what it stewards. Its approval is a sequence of steps, signed in order, each by one of that step's approvers: never the change's author or reviewer, and never the one who signed the step before. A department changes with the approval of its own approvers and of governance."),
                labelled("Governance", { select: { disabled: ro, onchange: (e) => ops.set("governance", e.target.value), children: noDefault(Object.entries(org.departments ?? {}).map(([d, x]) => ({ option: { value: d, selected: org.governance === d, textContent: x.name } }))) } }, "Approves what nobody else stewards, new departments and new people."),
                ...Object.entries(org.departments ?? {}).map(([d, dept]) => ({
                    fieldset: {
                        key: `dept-${d}`,
                        className: `tx-card ${ctx.changedAt(`department:${d}`)}`,
                        children: [
                            { legend: { children: [{ strong: dept.name }, { span: { className: "muted small", textContent: ` ${d}` } }] } },
                            labelled("Name", { input: { type: "text", disabled: ro, value: dept.name, onchange: (e) => ops.set(`departments.${d}.name`, e.target.value) } }),
                            // Its mailbox (§28.6): told when a change waits for the department to approve it.
                            labelled("Email", { input: { type: "email", disabled: ro, value: dept.email ?? "", placeholder: "engineering@plant.example", onchange: (e) => ops.edit((o) => { const v = e.target.value.trim(); if (v) o.departments[d].email = v; else delete o.departments[d].email; }) } }, "Told by mail when a change waits for this department to approve it."),
                            // Someone who leaves the department leaves its approval steps too.
                            labelled("Members", pickMany({ key: `members-${d}`, options: everyone, value: dept.members ?? [], readOnly: ro, placeholder: "Add a member…", onChange: (next) => ops.edit((o) => { o.departments[d].members = next; const kept = new Set(next); for (const st of o.departments[d].approval ?? []) st.approvers = (st.approvers ?? []).filter((a) => kept.has(a)); }) })),
                            { strong: { className: "small", textContent: "Approval, in order" } },
                            ...(dept.approval ?? []).map((st, k) => ({
                                div: { key: `st-${k}`, className: "org-step", children: [
                                    { span: { className: "org-step-n", textContent: `${k + 1}.` } },
                                    { input: { type: "text", disabled: ro, value: st.label, placeholder: "e.g. Manager", onchange: (e) => ops.set(`departments.${d}.approval.${k}.label`, e.target.value) } },
                                    // Approvers are chosen from the department's members.
                                    (dept.members ?? []).length || (st.approvers ?? []).length
                                        ? pickMany({ key: `approvers-${d}-${k}`, options: ((members) => everyone.filter((p) => members.has(p.value)))(new Set(dept.members ?? [])), value: st.approvers ?? [], readOnly: ro, placeholder: "Add an approver (a member)…", onChange: (next) => ops.edit((o) => { o.departments[d].approval[k].approvers = next; }) })
                                        : { span: { className: "muted small", textContent: "Add members first: approvers are chosen from them." } },
                                    ro() || k === 0 ? { span: {} } : { button: { type: "button", className: "mini", title: "Earlier", "aria-label": "Earlier", children: [icon("arrowUp")], onclick: () => ops.edit((o) => { const a = o.departments[d].approval; [a[k - 1], a[k]] = [a[k], a[k - 1]]; }) } },
                                    ro() || (dept.approval ?? []).length < 2 ? { span: {} } : { button: { type: "button", className: "linkish", textContent: "remove", onclick: confirmRemove(ctx.api, `step ${k + 1}`, () => ops.edit((o) => { o.departments[d].approval.splice(k, 1); }) )} },
                                ] },
                            })),
                            ro() ? { span: {} } : { button: { type: "button", className: "btn ghost", textContent: "+ step", onclick: () => ops.edit((o) => { (o.departments[d].approval ??= []).push({ label: `Step ${(o.departments[d].approval ?? []).length + 1}`, approvers: [] }); }) } },
                        ],
                    },
                })),
                ro() ? { span: {} } : addRow(api, "dept", "new department id (e.g. it)", (id, name) => ops.edit((o) => { o.departments[id] ??= { name, members: [], approval: [{ label: "Approver", approvers: [] }] }; }), "its name (e.g. IT)"),
            ],
        },
    };
}

// People to and from a spreadsheet (people-file.js): the file goes into this draft, shown first, and is
// approved like any other edit.
function peopleBar(ctx) {
    const { api, ops, ro } = ctx;
    const note = `${ops.root}Note`;
    const download = () => {
        const url = URL.createObjectURL(new Blob([peopleCsv(api.peek(ops.root))], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `people-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const load = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        const org = api.peek(ops.root);
        const result = importPeople(org, await file.text());
        const { changes, problems } = result;
        const count = Object.values(changes).reduce((n, ids) => n + ids.length, 0);
        // Nothing to put in the change: say why (every row already as it says, rows refused, or both).
        if (!count) {
            const same = (result.same ?? []).length;
            const people = (n) => `${n} ${n === 1 ? "person" : "people"}`;
            const words = !problems.length
                ? same
                    ? `Nothing to import from ${file.name}: its ${people(same)} ${same === 1 ? "is" : "are"} already as it says, in this change. If you edited the file, check you chose the edited copy: an export is named people-<date>.csv, and a second download people-<date> (1).csv.`
                    : `Nothing to import from ${file.name}: it has no rows of people under its header.`
                : `Nothing from ${file.name} was put in this change: ${same ? `${people(same)} already as it says, and ` : ""}${problems.length} row${problems.length === 1 ? "" : "s"} could not be taken.\n${importWords(result, result.next)}`;
            api.setValue(note, { bad: true, words });
            return;
        }
        const ok = await confirmDialog(api, { title: `Import ${file.name}`, message: `Into this change:\n${importWords(result, result.next)}\n\nPeople not in the file stay as they are.`, confirm: "Put them in this change" });
        if (!ok) return;
        ops.edit((o) => { o.users = result.next.users; o.departments = result.next.departments; });
        api.setValue(note, { bad: problems.length > 0, words: `${file.name}: ${count} change${count === 1 ? "" : "s"} put in this change${problems.length ? `, ${problems.length} row${problems.length === 1 ? "" : "s"} not taken` : ""}.` });
    };
    return {
        div: {
            key: "people-bar",
            children: [
                {
                    div: {
                        className: "org-people-bar",
                        children: [
                            ro() ? { span: {} } : addRow(api, "person", "their sign-in id (e.g. mark, 104523)", (id, name) => ops.edit((o) => { o.users[id] ??= { name, active: true }; }), "their name", PERSON_ID),
                            { span: { className: "spacer" } },
                            ro() ? { span: {} } : {
                                label: {
                                    className: "btn ghost", title: "A CSV (as Export writes it, or saved from Excel): id, name, active, departments. It goes into this change; people not in it stay as they are.",
                                    children: [icon("arrowDown"), { span: "Import" }, { input: { type: "file", accept: ".csv,.tsv,.txt,text/csv", className: "visually-hidden", onchange: load } }],
                                },
                            },
                            { button: { type: "button", className: "btn ghost", title: "Everyone here as a CSV that Excel opens: id, name, active, departments", children: [icon("arrowUp"), { span: "Export" }], onclick: download } },
                        ],
                    },
                },
                () => {
                    const n = api.getState(note, null);
                    return n ? { p: { className: `org-import-note small${n.bad ? " bad" : ""}`, role: "status", children: [{ span: n.words }, { button: { type: "button", className: "linkish", textContent: "dismiss", onclick: () => api.setValue(note, null) } }] } } : { span: {} };
                },
            ],
        },
    };
}

// Groups (§5.6, §28.3a): people from any departments. A plant may have fifty: found by name, id or member, listed
// a window at a time, and each opened in a panel of its own to edit (its name, mailbox and members).
function groupsTab(ctx) {
    const { api, w, org, ops, ro } = ctx;
    const findPath = `${w}.groupFind`;
    const openPath = `${w}.groupOpen`;
    const nameOf = (u) => org.users?.[u]?.name ?? u;
    const all = Object.entries(org.groups ?? {}).sort(([a, x], [b, y]) => String(x?.name ?? a).localeCompare(String(y?.name ?? b)));
    const removeGroup = (g, name) => confirmRemove(api, `group ${name}`, () => ops.edit((o) => {
        // What it held goes with it: its roles and reading every record. An object whose approval names it is
        // named by the checks, for its designer to decide.
        delete o.groups[g];
        for (const roles of Object.values(o.roles ?? {})) for (const [role, subjects] of Object.entries(roles ?? {})) roles[role] = (subjects ?? []).filter((x) => x !== `group:${g}`);
        if (Array.isArray(o.readers)) o.readers = o.readers.filter((x) => x !== `group:${g}`);
        api.setValue(openPath, null);
    }));
    return {
        div: {
            children: [
                hint("A group is people from any departments (a team of power engineers from Engineering and Quality). Give it roles on Roles; name it in an object's approval by value (Designer: the object's Stewards tab) and it approves those records' changes: any one of its members signs, never the one who asked. Its mailbox is told when a change waits for it."),
                all.length ? { input: { type: "search", className: "people-find", placeholder: `Find among ${all.length} group(s): a name, an id or a member`, "aria-label": "Find groups", autocomplete: "off", value: () => api.getState(findPath, "") ?? "", oninput: (e) => api.setValue(findPath, e.target.value) } } : { span: {} },
                () => {
                    const q = String(api.getState(findPath, "") ?? "").trim().toLowerCase();
                    if (!all.length) return { p: { className: "muted small", textContent: "No groups yet: add one below." } };
                    const hits = q ? all.filter(([id, g]) => id.includes(q) || String(g?.name ?? "").toLowerCase().includes(q) || (g?.members ?? []).some((m) => m.includes(q) || nameOf(m).toLowerCase().includes(q))) : all;
                    if (!hits.length) return { p: { className: "muted small", textContent: `No group has "${q}" in its name, id or members.` } };
                    return windowTable({ key: `groups-${ctx.id}-${q}-${hits.length}`, className: "org-groups", head: ["Group", "Members", "Email", ""], count: hits.length, row: (i) => {
                        const [id, g] = hits[i];
                        const members = g?.members ?? [];
                        return { tr: { key: id, className: ctx.changedAt(`group:${id}`), children: [
                            { td: { children: [{ strong: g?.name ?? id }, { div: { className: "muted small", textContent: id } }] } },
                            { td: { className: "small", title: members.map(nameOf).join(", "), textContent: members.length ? `${members.length}: ${members.slice(0, 3).map(nameOf).join(", ")}${members.length > 3 ? ", …" : ""}` : "nobody yet" } },
                            { td: { className: "small", textContent: g?.email || "—" } },
                            { td: { children: [{ div: { className: "org-group-actions", children: [
                                { button: { type: "button", className: "btn ghost small", "data-group": id, title: `Open ${g?.name ?? id}`, "aria-haspopup": "dialog", textContent: ro() ? "Open" : "Edit", onclick: () => api.setValue(openPath, id) } },
                                ro() ? { span: {} } : { button: { type: "button", className: "btn ghost field-remove", title: `Remove the group ${g?.name ?? id}`, "aria-label": `Remove the group ${g?.name ?? id}`, children: [icon("trash")], onclick: removeGroup(id, g?.name ?? id) } },
                            ] } }] } },
                        ] } };
                    } });
                },
                ro() ? { span: {} } : addRow(api, "group", "new group id (e.g. power_eng)", (id, name) => { ops.edit((o) => { if (o.departments?.[id]) return; (o.groups ??= {})[id] ??= { name, members: [] }; }); api.setValue(openPath, id); }, "its name (e.g. Power engineers)"),
                // The group open, in a panel: its name, mailbox and members (picked from everyone).
                () => {
                    const id = api.getState(openPath, null);
                    const g = id ? api.peek(ops.root)?.groups?.[id] : null;
                    if (!g) return { span: {} };
                    return editorPanel(api, {
                        id: `group-${w.replace(/\W/g, "_")}`, title: g.name || id,
                        subtitle: [{ code: id }, { span: " · group" }],
                        close: () => api.setValue(openPath, null), returnTo: `[data-group="${CSS.escape(id)}"]`,
                        children: [
                            labelled("Name", { input: { type: "text", disabled: ro, value: g.name, onchange: (e) => ops.set(`groups.${id}.name`, e.target.value) } }),
                            labelled("Email", { input: { type: "email", disabled: ro, value: g.email ?? "", placeholder: "power-eng@plant.example", onchange: (e) => ops.edit((o) => { const v = e.target.value.trim(); if (v) o.groups[id].email = v; else delete o.groups[id].email; }) } }, "Told by mail when a change waits for this group to approve it."),
                            labelled("Members", pickMany({ key: `group-members-${id}`, options: people(org), value: g.members ?? [], readOnly: ro, placeholder: "Add a member, from any department…", onChange: (next) => ops.edit((o) => { o.groups[id].members = next; }) }), "Any one of them signs for the group, never the one who asked."),
                        ],
                        footer: ro() ? [] : [{ button: { type: "button", className: "btn ghost", children: [icon("trash"), { span: " Remove the group" }], onclick: removeGroup(id, g.name || id) } }],
                    });
                },
            ],
        },
    };
}

function peopleTab(ctx) {
    const { api, w, org, ops, ro } = ctx;
    const findPath = `${w}.peopleFind`;
    const everyone = Object.keys(org.users ?? {}).length;
    return {
        div: {
            children: [
                peopleBar(ctx),
                peopleImpact(ctx),
                hint("Everyone who signs in. A person is never deleted (the audit trail names them): untick Active instead. New people, and who belongs where, are approved by governance and the departments concerned."),
                // Search first (§27): a plant has thousands; demos and test instances list them at once.
                { input: { type: "search", className: "people-find", placeholder: `Find among ${everyone} people: the start of a name or department, or a sign-in id`, "aria-label": "Find people", autocomplete: "off", value: () => api.getState(findPath, "") ?? "", oninput: (e) => api.setValue(findPath, e.target.value) } },
                () => {
                    const q = api.getState(findPath, "") ?? "";
                    const { ids, total, departmentsOf, short } = findPeople(org, q, { touched: ctx.touchedPeople, all: Boolean(api.getState("simpleLists", false)) });
                    const words = short ? `Type at least ${MIN_SEARCH} letters.` : !q.trim() && !total
                        ? `Type to find someone. ${ctx.touchedPeople.length ? "" : "The people this change adds or changes are listed here."}`
                        : !q.trim() && !api.getState("simpleLists", false) ? "The people this change adds or changes; type to find anyone else." : "";
                    return {
                        div: {
                            children: [
                                words ? hint(words) : { span: {} },
                                // In a box of its own, a window of rows drawn (window-rows.js), however many match.
                                ids.length ? windowTable({ key: `people-${ctx.id}-${q.trim()}-${total}`, className: "ed-table", head: ["Id", "Name", "Active", "Departments"], count: total, row: (i) => { const pid = ids[i]; const u = org.users[pid]; return { tr: { key: pid, className: ctx.changedAt(`person:${pid}`), children: [
                                        { td: { children: [{ code: pid }] } },
                                        { td: { children: [{ input: { type: "text", disabled: ro, value: u.name, onchange: (e) => ops.set(`users.${pid}.name`, e.target.value) } }] } },
                                        { td: { children: [{ input: { type: "checkbox", disabled: ro, checked: u.active !== false, onchange: (e) => ops.set(`users.${pid}.active`, e.target.checked) } }] } },
                                        { td: (departmentsOf.get(pid) ?? []).join(", ") || "—" },
                                    ] } }; } }) : q.trim() && !short ? hint(`Nobody matches “${q.trim()}”.`) : { span: {} },
                                total ? { p: { className: "muted small", textContent: `${total} ${q.trim() && !short ? `matching “${q.trim()}”` : total === 1 ? "person" : "people"}` } } : { span: {} },
                            ],
                        },
                    };
                },
            ],
        },
    };
}

// Roles at the scale of a plant (thousands of objects): nothing is drawn all at once. By object: a
// search, folded rows, 30 drawn at a time and more as they are scrolled, the objects this change touches
// first. By group or person: everything one holds, directly and through their departments, and a
// search over every "object · role" to give them another.
const ROLES_AT_ONCE = 30;
function rolesTab(ctx) {
    const { api, w, org, ops, ro } = ctx;
    const home = api.peek("design.home") ?? {};
    const S = `${w}.orgRoles`;
    const objects = [...(home.objects ?? []).map((o) => ({ object: o.object, label: o.label, roles: o.roles ?? [] })), { object: "design", label: "Designer", roles: PSEUDO_ROLES.design }, { object: "query", label: "Queries", roles: PSEUDO_ROLES.query }, { object: "auth", label: "Sign-in", roles: PSEUDO_ROLES.auth }, { object: "privacy", label: "Privacy", roles: PSEUDO_ROLES.privacy }, { object: "integrity", label: "Data integrity", roles: PSEUDO_ROLES.integrity }, { object: "database", label: "Database", roles: PSEUDO_ROLES.database }];
    const subjects = [
        ...Object.entries(org.departments ?? {}).map(([id, d]) => ({ value: `group:${id}`, label: d.name, hint: "department" })),
        ...Object.entries(org.groups ?? {}).map(([id, g]) => ({ value: `group:${id}`, label: g.name, hint: "group" })),
        ...people(org).map((p) => ({ value: `user:${p.value}`, label: p.label, hint: p.value })),
    ];
    const name = (x) => subjects.find((y) => y.value === x)?.label ?? x;
    const setHeld = (object, role, next) => ops.edit((o) => { const roles = (o.roles[object] ??= {}); if (next.length) roles[role] = next; else delete roles[role]; if (!Object.keys(roles).length) delete o.roles[object]; });
    const mode = () => api.getState(`${S}.mode`, "object");
    const modeBar = { div: { className: "subtabs org-roles-modes", children: [["object", "By object"], ["holder", "By group or person"]].map(([m, l]) => ({ button: { key: m, type: "button", className: "subtab", classList: { active: () => mode() === m }, textContent: l, onclick: () => api.setValue(`${S}.mode`, m) } })) } };

    // The search box stays put while the list below it follows what is typed.
    const byObject = () => ({
        div: {
            children: [
                { input: { type: "search", className: "filter org-roles-q", placeholder: "Find an object, a role, or who holds one…", value: String(api.peek(`${S}.q`) ?? ""), oninput: (e) => { api.batch(() => { api.setValue(`${S}.q`, e.target.value); api.setValue(`${S}.shown`, ROLES_AT_ONCE); }); } } },
                () => objectList(),
            ],
        },
    });
    const objectList = () => {
        const q = String(api.getState(`${S}.q`, "") ?? "").trim().toLowerCase();
        const live = api.peek(ops.root) ?? org;
        const summaryOf = (o) => o.roles.map((r) => `${r}: ${(live.roles?.[o.object]?.[r] ?? []).map(name).join(", ") || "nobody"}`).join(" · ");
        const matches = objects.filter((o) => !q || `${o.label} ${o.object} ${o.roles.join(" ")} ${summaryOf(o)}`.toLowerCase().includes(q));
        const touched = (o) => (ctx.changedAt(`roles:${o.object}`) ? 0 : 1);
        const ordered = [...matches].sort((a, b) => touched(a) - touched(b) || a.label.localeCompare(b.label));
        const shown = Math.min(ordered.length, api.getState(`${S}.shown`, ROLES_AT_ONCE) ?? ROLES_AT_ONCE);
        return {
            div: {
                children: [
                    { p: { className: "muted small org-roles-count", textContent: `${matches.length} of ${objects.length} object(s)${q ? ` matching “${q}”` : ""}${ordered.length > shown ? `, ${shown} shown` : ""}.` } },
                    ...ordered.slice(0, shown).map((o) => ({
                        details: {
                            key: `roles-${o.object}`,
                            className: `tx-card org-roles-row ${ctx.changedAt(`roles:${o.object}`)}`,
                            open: Boolean(api.peek(`${S}.open.${o.object}`)) || (q && matches.length <= 3),
                            ontoggle: (e) => api.setValue(`${S}.open.${o.object}`, e.target.open),
                            children: [
                                { summary: { children: [{ strong: o.label }, { span: { className: "muted small", textContent: ` ${o.object} · ${summaryOf(o)}` } }] } },
                                ...o.roles.map((role) => ({
                                    div: { key: role, className: "org-role", children: [
                                        { code: role },
                                        pickMany({ key: `role-${o.object}-${role}`, options: subjects, value: live.roles?.[o.object]?.[role] ?? [], readOnly: ro, placeholder: "Give it to a group or a person…", onChange: (next) => setHeld(o.object, role, next) }),
                                    ] },
                                })),
                            ],
                        },
                    })),
                    ordered.length > shown ? { AutoMore: { key: `more-roles-${shown}`, id: `more-roles-${ctx.id}`, label: "Show more", onMore: () => api.setValue(`${S}.shown`, shown + ROLES_AT_ONCE) } } : { span: {} },
                ],
            },
        };
    };

    const byHolder = () => {
        const live = api.peek(ops.root) ?? org;
        const holder = api.getState(`${S}.holder`, null);
        const pickHolder = pickMany({ key: "roles-holder", single: true, options: subjects, value: holder ? [holder] : [], placeholder: "Find a department, a group or a person…", onChange: (next) => api.setValue(`${S}.holder`, next.at(-1) ?? null) });
        if (!holder) return { div: { children: [pickHolder, hint("Pick who, to see and change every role they hold.")] } };
        const direct = Object.entries(live.roles ?? {}).flatMap(([object, roles]) => Object.entries(roles ?? {}).filter(([, subs]) => (subs ?? []).includes(holder)).map(([role]) => ({ object, role })));
        const label = (object) => objects.find((o) => o.object === object)?.label ?? object;
        // A person also holds what their departments and groups hold.
        const through = holder.startsWith("user:")
            ? Object.entries(effectiveRoles(live)[holder.slice(5)] ?? {}).filter(([, via]) => via.some((v) => v !== "directly")).map(([k, via]) => ({ key: k, via: via.filter((v) => v !== "directly").join(", ") }))
            : [];
        const all = objects.flatMap((o) => o.roles.map((r) => ({ value: `${o.object}:${r}`, label: `${o.label} · ${r}`, hint: o.object }))).filter((x) => !direct.some((d) => `${d.object}:${d.role}` === x.value));
        return {
            div: {
                children: [
                    pickHolder,
                    { h4: `${name(holder)} holds` },
                    direct.length ? { ul: { className: "org-held", children: direct.map((d) => ({ li: { key: `${d.object}:${d.role}`, children: [{ span: `${label(d.object)} · ${d.role}` }, ro() ? { span: {} } : { button: { type: "button", className: "pick-x", title: "Take it away", "aria-label": "Take it away", children: [icon("x")], onclick: () => setHeld(d.object, d.role, (live.roles[d.object][d.role] ?? []).filter((x) => x !== holder)) } }] } })) } } : hint("No role of their own."),
                    through.length ? { div: { children: [{ h4: "…and through their departments and groups" }, { ul: { className: "org-held muted", children: through.map((t) => ({ li: { key: t.key, textContent: `${label(t.key.split(":")[0])} · ${t.key.split(":")[1]} (${t.via})` } })) } }] } } : { span: {} },
                    ro() ? { span: {} } : labelled("Give another role", pickMany({ key: `roles-add-${holder}`, single: true, options: all, value: [], placeholder: "Find an object's role (e.g. lot operator)…", onChange: (next) => { const pick = next.at(-1); if (!pick) return; const [object, role] = pick.split(":"); setHeld(object, role, [...(live.roles?.[object]?.[role] ?? []), holder]); } })),
                ],
            },
        };
    };

    return {
        div: {
            children: [
                hint("Who holds each role each object declares; its policies decide what the role may do. A change to the roles on an object is approved by that object's stewards."),
                modeBar,
                () => (mode() === "holder" ? byHolder() : byObject()),
            ],
        },
    };
}

function standingTab(ctx) {
    const { org, ops, ro } = ctx;
    const depts = Object.entries(org.departments ?? {}).map(([id, d]) => ({ value: id, label: d.name }));
    return {
        div: {
            children: [
                hint("Standing approvers approve every change to an element of a kind, whoever stewards it: IT on every connection and service, for example. They join the stewards; they do not replace them."),
                { table: { className: "grid ed-table", children: [
                    { thead: { children: [{ tr: { children: [{ th: "Every change to" }, { th: "is also approved by" }] } }] } },
                    { tbody: { children: STANDING_KINDS.map((k) => ({ tr: { key: k, children: [
                        { td: KIND_LABELS[k] },
                        { td: { children: [checks(ro(), depts, org.standing?.[k], (d, on) => ops.edit((o) => { const next = toggleIn(o.standing?.[k], d, on); o.standing = { ...(o.standing ?? {}) }; if (next.length) o.standing[k] = next; else delete o.standing[k]; }))] } },
                    ] } })) } },
                ] } },
                // Who reads every record (§27.7): read only, on every object, those to come included.
                { h4: "Reads every record" },
                hint("People and groups who may read every object's records, now and those designed later (a suite's too): every field but one a policy hides. They write nothing and take no action through this; they still need their roles to work. For IT, or an auditor. Approved by governance."),
                pickMany({
                    key: "readers", readOnly: ro, placeholder: "Add a person, department or group…", value: org.readers ?? [],
                    options: [
                        ...people(org).map((p) => ({ value: `user:${p.value}`, label: p.label, hint: p.value })),
                        ...Object.entries(org.departments ?? {}).map(([id, d]) => ({ value: `group:${id}`, label: d.name, hint: "department" })),
                        ...Object.entries(org.groups ?? {}).map(([id, g]) => ({ value: `group:${id}`, label: g.name, hint: "group" })),
                    ],
                    onChange: (next) => ops.edit((o) => { o.readers = next; }),
                }),
                // How much approval a change needs (§5.16): the plant's choice, approved by governance.
                { h4: "Approval level" },
                hint("How much approval a change needs before the platform executes it. Every change is signed and kept in the audit trail, whichever level; a plant that answers to regulators (Part 11, Annex 11) keeps Full."),
                { div: { className: "ed-field approval-levels", children: [
                    ["full", "Full", "A reviewer who did not design it, then an approver of each department it touches, in their steps."],
                    ["one", "One approval", "No review: the first signature by an approver of any department it touches (never its designer) executes it."],
                    ["none", "None", "Its designer signs it, and it executes: for a small plant with nobody else to ask."],
                ].map(([level, label, words]) => ({ label: { key: level, className: "small approval-level", children: [
                    { input: { type: "radio", name: "approval-level", disabled: ro, checked: (org.approval?.level ?? "full") === level, onchange: () => ops.edit((o) => { if (level === "full") delete o.approval; else o.approval = { level }; }) } },
                    { span: { children: [{ strong: label }, { span: ` ${words}` }] } },
                ] } })) } },
                // Setup (§5.15): while the plant is set up, a designer's change executes on their own signature.
                { h4: "Setup" },
                hint(org.setup?.open === true
                    ? "Setup is open: a designer's change executes on their own signature, without review or approval, each one marked and kept in the audit trail. Clear it to end setup: from then on every change is reviewed and approved. It ends once someone besides the designers can review."
                    : "While a plant is set up, a designer's change may execute on their own signature, without review or approval. IT opens it for a new installation; opening it again here is a change governance approves."),
                { div: { className: "ed-field", children: [
                    { label: { className: "small", children: [{ input: { type: "checkbox", disabled: ro, checked: org.setup?.open === true, onchange: (e) => ops.edit((o) => { o.setup = { open: e.target.checked }; }) } }, { span: " Setup is open: changes execute on their designer's signature" }] } },
                ] } },
                // Emergency changes (§5.7): one signature executes them, reviewed afterwards within a set time.
                { h4: "Emergency changes" },
                hint("A change the plant cannot wait for may be submitted as an emergency, with a reason: one approver's signature makes it live, and it is reviewed afterwards by a reviewer and each department it touches, within the days set here. Every one is in the audit trail and the event log."),
                { div: { className: "ed-field", children: [
                    { label: { className: "small", children: [{ input: { type: "checkbox", disabled: ro, checked: org.emergency?.allowed !== false, onchange: (e) => ops.edit((o) => { o.emergency = { ...(o.emergency ?? {}) }; if (e.target.checked) delete o.emergency.allowed; else o.emergency.allowed = false; if (!Object.keys(o.emergency).length) delete o.emergency; }) } }, { span: " Allowed" }] } },
                ] } },
                { div: { className: "ed-field", children: [
                    { label: "Reviewed afterwards within (days)" },
                    { input: { type: "number", min: 1, max: 30, step: 1, disabled: ro, placeholder: "3", value: org.emergency?.reviewDays ?? "", onchange: (e) => ops.edit((o) => { o.emergency = { ...(o.emergency ?? {}) }; const n = Number(e.target.value); if (e.target.value === "") delete o.emergency.reviewDays; else o.emergency.reviewDays = Number.isInteger(n) ? n : e.target.value; if (!Object.keys(o.emergency).length) delete o.emergency; }) } },
                    { div: { className: "muted small", textContent: "1 to 30; 3 when empty." } },
                ] } },
            ],
        },
    };
}

// How the plant writes dates, times and numbers (§27.6): one setting for every page, approved by
// governance; what is stored never changes with it.
const LOCALES = ["en-US", "en-GB", "de-DE", "de-CH", "fr-FR", "it-IT", "es-ES", "es-MX", "pt-BR", "nl-NL", "pl-PL", "cs-CZ", "sv-SE", "tr-TR", "ja-JP", "zh-CN", "ko-KR", "en-IN"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function formatsTab(ctx) {
    const { api, org, ops, ro } = ctx;
    const f = org.formats ?? {};
    const set = (key, value) => ops.edit((o) => { o.formats = { ...(o.formats ?? {}) }; if (value === "" || value === null || value === undefined) delete o.formats[key]; else o.formats[key] = value; });
    const zones = (() => { try { return Intl.supportedValuesOf("timeZone"); } catch { return []; } })();
    const sample = formatter({ ...f, timeZone: f.timeZone || api.getState("formats.timeZone", "UTC") });
    const field = (label, control, help) => ({ div: { className: "ed-field", children: [{ label: label }, control, help ? { div: { className: "muted small", textContent: help } } : { span: {} }] } });
    return {
        div: {
            className: "org-formats",
            children: [
                hint("How dates, times and numbers are written on every page, typed in forms, and shown in lists and history. What is stored does not change: a date stays YYYY-MM-DD, a moment UTC. Changed through this change request, approved by governance; pages follow when next opened."),
                field("Locale (numbers, e.g. 1.250,5)", { div: { children: [
                    { input: { list: "org-locales", disabled: ro, value: f.locale ?? "", placeholder: DEFAULT_FORMATS.locale, onchange: (e) => set("locale", e.target.value.trim()) } },
                    { datalist: { id: "org-locales", children: LOCALES.map((l) => ({ option: { key: l, value: l } })) } },
                ] } }),
                field("Dates written", { select: { disabled: ro, onchange: (e) => set("date", e.target.value), children: noDefault(DATE_FORMATS.map((d) => ({ option: { key: d, value: d, selected: (f.date ?? DEFAULT_FORMATS.date) === d, textContent: d } }))) } }),
                field("Times", { select: { disabled: ro, onchange: (e) => set("time", e.target.value), children: noDefault([["24h", "24-hour (14:05)"], ["12h", "12-hour (2:05 PM)"]].map(([v, l]) => ({ option: { key: v, value: v, selected: (f.time ?? DEFAULT_FORMATS.time) === v, textContent: l } }))) } }),
                field("The week begins on", { select: { disabled: ro, onchange: (e) => set("firstDay", Number(e.target.value)), children: noDefault(DAYS.map((d, i) => ({ option: { key: d, value: String(i), selected: (f.firstDay ?? DEFAULT_FORMATS.firstDay) === i, textContent: d } }))) } }),
                field("The plant's clock (time zone)", { div: { children: [
                    { input: { list: "org-zones", disabled: ro, value: f.timeZone ?? "", placeholder: `the server's (${api.getState("formats.timeZone", "UTC")})`, onchange: (e) => set("timeZone", e.target.value.trim()) } },
                    { datalist: { id: "org-zones", children: zones.map((z) => ({ option: { key: z, value: z } })) } },
                ] } }, "Times are shown on this clock, wherever a person is."),
                { p: { className: "org-formats-sample", textContent: `Reads as: ${sample.dateTime(new Date())} · ${sample.number(1250.5)} · a date: ${sample.date("2027-03-31")}` } },
            ],
        },
    };
}

// How the plant's pages look (§10.8): who picks light or dark, the top bar's name, and the colours of
// the top bar, the accent and the tones: the plant's choice, nothing checks how they read.
const COLOR_WORDS = { accent: "Accent (links, buttons, the current step)", ok: "OK (released, done)", warn: "Warn (on hold, waiting)", danger: "Danger (refused, failed)", header: "Top bar background", headerInk: "Top bar text" };
function themeTab(ctx) {
    const { org, ops, ro } = ctx;
    const t = org.theme ?? {};
    const edit = (fn) => ops.edit((o) => {
        const next = clone(o.theme ?? {});
        fn(next);
        for (const s of ["light", "dark"]) if (next.colors?.[s] && !Object.keys(next.colors[s]).length) delete next.colors[s];
        if (next.colors && !Object.keys(next.colors).length) delete next.colors;
        if (Object.keys(next).length) o.theme = next; else delete o.theme;
    });
    const setColor = (scheme, name, value) => edit((n) => {
        n.colors = n.colors ?? {};
        n.colors[scheme] = { ...(n.colors[scheme] ?? {}) };
        if (value) n.colors[scheme][name] = value.toLowerCase(); else delete n.colors[scheme][name];
    });
    const hex = (v) => /^#[0-9a-f]{6}$/i.test(v ?? "");
    // A colour as typed when it is one (#rrggbb); otherwise the default, while the change's check names it.
    const colorOf = (scheme, name) => (hex(t.colors?.[scheme]?.[name]) ? t.colors[scheme][name] : DEFAULTS[scheme][name]);
    // The top bar as the page draws it (theme.js headerOf): its text automatic when only a background is given; in
    // dark, the light scheme's bar when dark gives none of its own (a plant's brand bar). `from`: whose it is.
    const barOf = (scheme) => {
        const from = scheme === "dark" && !HEADER_COLORS.some((n) => hex(t.colors?.dark?.[n])) && HEADER_COLORS.some((n) => hex(t.colors?.light?.[n])) ? "light" : scheme;
        return { ...headerOf(from, t.colors?.[from] ?? {}), from };
    };
    const field = (label, control, help) => ({ div: { className: "ed-field", children: [{ label: label }, control, help ? { div: { className: "muted small", textContent: help } } : { span: {} }] } });
    // One scheme's colours, and its preview drawn with exactly those colours.
    const scheme = (s) => {
        const d = DEFAULTS[s];
        const b = barOf(s);
        const c = { ...Object.fromEntries(THEME_COLORS.map((n) => [n, colorOf(s, n)])), header: b.header, headerInk: b.ink };
        // The top bar's text when none is given: white or dark, whichever stands out on its background.
        const placeholderOf = (n) => (n === "headerInk" && b.auto ? `automatic (${b.ink})` : n === "header" && b.from !== s ? `as in light (${b.header})` : n === "headerInk" && b.from !== s ? `as in light (${b.ink})` : d[n]);
        return {
            div: {
                children: [
                    { h4: s === "light" ? "Light" : "Dark" },
                    ...[...HEADER_COLORS, ...THEME_COLORS].map((n) => field(COLOR_WORDS[n], { span: { className: "theme-color", children: [
                        { input: { type: "color", disabled: ro, value: c[n], onchange: (e) => setColor(s, n, e.target.value), "aria-label": `${COLOR_WORDS[n]}, ${s}` } },
                        { input: { type: "text", disabled: ro, value: t.colors?.[s]?.[n] ?? "", placeholder: placeholderOf(n), onchange: (e) => setColor(s, n, e.target.value.trim()), "aria-label": `${COLOR_WORDS[n]}, ${s}, as #rrggbb` } },
                    ] } }, n === "headerInk" ? "Empty: white or dark, whichever stands out on the background." : undefined)),
                    {
                        div: {
                            className: "theme-preview", style: { background: d.bg, color: d.ink },
                            children: [
                                { div: { className: "pv-bar", style: { background: c.header, color: c.headerInk }, children: [{ span: t.name || "OpenCore MES" }, { span: { className: "small", style: { color: c.headerInk, opacity: 0.75 }, textContent: t.scope || "PLT1 · POC" } }] } },
                                { div: { className: "pv-body", children: [
                                    { span: { className: "pv-btn", style: { background: c.accent, color: d.onFill }, textContent: "Save" } },
                                    ...["ok", "warn", "danger"].map((n) => ({ span: { className: "pv-badge", style: { background: soft(s, c[n]), color: c[n] }, textContent: n === "ok" ? "released" : n === "warn" ? "on hold" : "rejected" } })),
                                    { span: { className: "pv-badge", style: { background: soft(s, c.accent), color: c.accent }, textContent: "processing" } },
                                    { span: { style: { color: c.accent }, textContent: "a link" } },
                                ] } },
                            ],
                        },
                    },
                ],
            },
        };
    };
    return {
        div: {
            className: "org-theme",
            children: [
                hint(`How the plant's pages look. Colours are chosen for what they mean: a state's tone (ok, warn, danger, info, neutral) is part of its object's design, on its States tab, and these colours draw them. Changed through this change request, approved by governance; pages follow when next opened.`),
                { div: { className: "theme-grid", children: [
                    field("Light or dark", { select: { disabled: ro, onchange: (e) => edit((n) => { if (e.target.value === "choice") delete n.scheme; else n.scheme = e.target.value; }), children: noDefault([["choice", "Each person chooses"], ["light", "Always light, for everyone"], ["dark", "Always dark, for everyone"]].map(([v, l]) => ({ option: { key: v, value: v, selected: (t.scheme ?? "choice") === v, textContent: l } }))) } }, "Always light or dark: nobody is offered a choice (a shop floor's screens, a control room)."),
                    field("Name in the top bar", { input: { type: "text", disabled: ro, maxlength: 40, value: t.name ?? "", placeholder: "OpenCore MES", onchange: (e) => edit((n) => { const v = e.target.value.trim(); if (v) n.name = v; else delete n.name; }) } }),
                    field("Label beside it", { input: { type: "text", disabled: ro, maxlength: 40, value: t.scope ?? "", placeholder: "PLT1 · POC", onchange: (e) => edit((n) => { const v = e.target.value.trim(); if (v) n.scope = v; else delete n.scope; }) } }, "The site, plant or line, e.g. Plant 1 · Lyon."),
                ] } },
                { div: { className: "theme-grid", children: [scheme("light"), scheme("dark")] } },
                { p: { className: "muted small", textContent: `Empty: the default. Tones a state can have: ${TONES.join(", ")}.` } },
            ],
        },
    };
}

// How long the plant keeps each kind of data (§27.8): a period per kind, in days or "forever", approved by
// governance. Each kind says what it covers, its default and its floor, and whether the platform purges
// what is past it or only counts it (records and the audit trail are never purged).
function retentionTab(ctx) {
    const { org, ops, ro } = ctx;
    const r = org.retention ?? {};
    const set = (key, text) => ops.edit((o) => {
        const next = { ...(o.retention ?? {}) };
        const value = parsePeriod(text);
        if (value === undefined) delete next[key]; else next[key] = value;
        if (Object.keys(next).length) o.retention = next; else delete o.retention;
    });
    const shown = (v) => (v === undefined ? "" : v === FOREVER ? FOREVER : String(v));
    const problems = retentionProblems(r);
    return {
        div: {
            className: "org-retention",
            children: [
                hint("How long each kind of data is kept, in days (365 a year) or forever. The instance that schedules removes what is past its period, every few hours; the Data retention page shows what would go and what went. Records and the audit trail are never removed by the platform: their period is what the plant keeps, and that page counts what is past it. Changed through this change request, approved by governance."),
                {
                    table: {
                        className: "ed-table retention-table",
                        children: [
                            { thead: { children: [{ tr: { children: [{ th: "Kind" }, { th: "Kept for" }, { th: "Past it" }] } }] } },
                            { tbody: { children: RETENTION_KINDS.map((k) => ({ tr: { key: k.key, children: [
                                { td: { children: [{ strong: k.label }, { div: { className: "muted small", textContent: k.what } }] } },
                                { td: { children: [
                                    { input: { type: "text", disabled: ro, value: shown(r[k.key]), placeholder: periodWords(k.days), "aria-label": `${k.label}: kept for (days, or forever)`, onchange: (e) => set(k.key, e.target.value) } },
                                    { div: { className: "muted small", textContent: `Default ${periodWords(k.days)}; at least ${periodWords(k.floor)}.` } },
                                ] } },
                                { td: { className: "small", textContent: k.purged ? "removed" : "counted, kept" } },
                            ] } })) } },
                        ],
                    },
                },
                problems.length ? { ul: { className: "theme-checks", children: problems.map((p, i) => ({ li: { key: i, className: "error", children: [icon("x"), { span: p }] } })) } } : { span: {} },
            ],
        },
    };
}

// Where a data integrity finding's non-conformance report is raised (§7.7): one of the plant's objects, and
// which of its fields takes each part. None: the reports stay on the Data integrity page and in the audit trail.
function integrityTab(ctx) {
    const { api, org, ops, ro } = ctx;
    const home = api.peek("design.home") ?? {};
    const it = org.integrity ?? {};
    const object = (home.objects ?? []).find((o) => o.object === it.reportObject);
    const partOf = (field) => it.fields?.[field] ?? "";
    const fieldFor = (part) => Object.entries(it.fields ?? {}).find(([, p]) => p === part)?.[0] ?? "";
    const edit = (fn) => ops.edit((o) => {
        const next = { ...(o.integrity ?? {}), fields: { ...(o.integrity?.fields ?? {}) } };
        fn(next);
        if (!next.reportObject) delete next.reportObject;
        if (!Object.keys(next.fields).length) delete next.fields;
        if (next.values && !Object.keys(next.values).length) delete next.values;
        if (Object.keys(next).length) o.integrity = next; else delete o.integrity;
    });
    const problems = integrityProblems(org.integrity);
    const fields = Object.entries(object?.fields ?? {}).filter(([, f]) => ["text", "string", "enum", "longtext"].includes(f.type) || !f.type);
    return { div: { className: "org-integrity", children: [
        hint("A finding of the data integrity review is closed with a non-conformance report, signed. Name the object your plant keeps them in, and each closed finding raises a record there too, through its policies and rules, as the reviewer who closed it. None: the reports are kept on the Data integrity page and in the audit trail. Who reviews is a role (Roles, Data integrity)."),
        { label: { className: "org-integrity-object", children: [
            { span: "Report object" },
            { select: { disabled: ro, "aria-label": "Report object", onchange: (e) => edit((n) => { n.reportObject = e.target.value || undefined; n.fields = {}; delete n.values; }), children: [
                { option: { value: "", selected: !it.reportObject, textContent: "None: kept here and in the audit trail" } },
                ...(home.objects ?? []).map((o) => ({ option: { value: o.object, selected: o.object === it.reportObject, textContent: `${o.label ?? o.object} (${o.object})` } })),
            ] } },
        ] } },
        it.reportObject ? { table: { className: "ed-table", children: [
            { thead: { children: [{ tr: { children: [{ th: "Part of the report" }, { th: `${object?.label ?? it.reportObject}'s field` }] } }] } },
            { tbody: { children: INTEGRITY_REPORT.map(([part, words]) => ({ tr: { key: part, children: [
                { td: words },
                { td: { children: [{ select: { disabled: ro, "aria-label": `${words}: field`, onchange: (e) => edit((n) => { for (const [f, p] of Object.entries(n.fields)) if (p === part) delete n.fields[f]; if (e.target.value) n.fields[e.target.value] = part; }), children: [
                    { option: { value: "", selected: !fieldFor(part), textContent: "Not kept" } },
                    ...fields.map(([f, d]) => ({ option: { value: f, selected: fieldFor(part) === f, disabled: Boolean(partOf(f)) && partOf(f) !== part, textContent: d.label ?? f } })),
                ] } }] } },
            ] } })) } },
        ] } } : { span: {} },
        // The object's required fields no part fills: the same value every time (a severity, a category).
        ...(it.reportObject ? Object.entries(object?.fields ?? {}).filter(([f, d]) => d.required && !partOf(f)).map(([f, d]) => ({ label: { key: `v-${f}`, className: "org-integrity-object", children: [
            { span: `${d.label ?? f} (required): always` },
            Array.isArray(d.values)
                ? { select: { disabled: ro, "aria-label": `${d.label ?? f}: always`, onchange: (e) => edit((n) => { n.values = { ...(n.values ?? {}) }; if (e.target.value) n.values[f] = e.target.value; else delete n.values[f]; if (!Object.keys(n.values).length) delete n.values; }), children: [{ option: { value: "", selected: it.values?.[f] === undefined, textContent: "Choose…" } }, ...d.values.map((x) => ({ option: { value: x, selected: it.values?.[f] === x, textContent: x } }))] } }
                : { input: { type: "text", disabled: ro, value: it.values?.[f] ?? "", "aria-label": `${d.label ?? f}: always`, onchange: (e) => edit((n) => { n.values = { ...(n.values ?? {}) }; if (e.target.value.trim()) n.values[f] = e.target.value.trim(); else delete n.values[f]; if (!Object.keys(n.values).length) delete n.values; }) } },
        ] } })) : []),
        problems.length ? { ul: { className: "theme-checks", children: problems.map((p, i) => ({ li: { key: i, className: "error", children: [icon("x"), { span: p }] } })) } } : { span: {} },
    ] } };
}

// The certifications the plant recognizes (§27.9): an id designs name (itar), a name people read, what it is
// for. Who holds one is a Certification record (Organization, in the navigator), kept by the plant's own
// process; an object's access may reserve records to one (its Policies tab). One an object requires stays.
function certificationsTab(ctx) {
    const { api, org, ops, ro, changedAt } = ctx;
    const certs = org.certifications ?? {};
    const required = new Map();
    for (const o of api.peek("design.home.objects") ?? []) for (const r of o.access?.requires ?? []) required.set(r.certification, [...(required.get(r.certification) ?? []), o.label ?? o.object]);
    const edit = (fn) => ops.edit((o) => { o.certifications = { ...(o.certifications ?? {}) }; fn(o.certifications); if (!Object.keys(o.certifications).length) delete o.certifications; });
    return { div: { className: "org-certifications", children: [
        hint("The certifications your plant recognizes: ITAR, a cleanroom grade, a customer's clearance. An object's access may reserve records to one (its Policies tab): only those who hold it, active and in date, see them. Who holds one is kept as Certification records (Organization, in the navigator), by a form, an import, a training suite or a learning system. Approved by governance."),
        Object.keys(certs).length ? { table: { className: "ed-table", children: [
            { thead: { children: [{ tr: { children: [{ th: "Id" }, { th: "Name" }, { th: "What it is for" }, { th: "Required by" }, { th: "" }] } }] } },
            { tbody: { children: Object.entries(certs).map(([cid, c]) => ({ tr: { key: cid, className: changedAt(`certification:${cid}`), children: [
                { td: { children: [{ code: cid }] } },
                { td: { children: [{ input: { type: "text", disabled: ro, "aria-label": `${cid}: name`, value: c.name ?? "", onchange: (e) => edit((all) => { all[cid] = { ...all[cid], name: e.target.value.trim() }; }) } }] } },
                { td: { children: [{ input: { type: "text", disabled: ro, "aria-label": `${cid}: what it is for`, value: c.description ?? "", onchange: (e) => edit((all) => { const v = e.target.value.trim(); all[cid] = { ...all[cid] }; if (v) all[cid].description = v; else delete all[cid].description; }) } }] } },
                { td: { className: "muted small", textContent: (required.get(cid) ?? []).join(", ") || "—" } },
                { td: { children: [ro() ? { span: {} } : required.has(cid)
                    ? { span: { className: "muted small icon-text", title: `Required by ${required.get(cid).join(", ")}: change that first.`, children: [icon("lock"), { span: "in use" }] } }
                    : { button: { type: "button", className: "btn ghost", textContent: "Remove", onclick: confirmRemove(api, `certification ${c.name ?? cid}`, () => edit((all) => { delete all[cid]; })) } }] } },
            ] } })) } },
        ] } } : { p: { className: "muted", textContent: "None yet." } },
        ro() ? { span: {} } : addRow(api, "certification", "Id (itar)", (cid, name) => edit((all) => { if (!all[cid]) all[cid] = { name }; }), "Name (ITAR export control)"),
    ] } };
}

// What the sign-in page calls the id people type, the hint in its empty box, and the plant's domains a
// typed id may carry (§8.2): PLANT\jdoe and jdoe@plant.local sign in as jdoe. Approved like any other edit.
function signInTab(ctx) {
    const { org, ops, ro } = ctx;
    const si = org.signIn ?? {};
    const edit = (key, value) => ops.edit((o) => {
        const next = { ...(o.signIn ?? {}) };
        if (value === "" || value === null || (Array.isArray(value) && !value.length)) delete next[key]; else next[key] = value;
        if (Object.keys(next).length) o.signIn = next; else delete o.signIn;
    });
    const field = (label, control, help) => ({ div: { className: "ed-field", children: [{ label: label }, control, help ? { div: { className: "muted small", textContent: help } } : { span: {} }] } });
    const problems = signInProblems(org.signIn);
    const domains = si.domains ?? [];
    const example = domains.length ? `${domains[0]}\\jdoe${domains.find((d) => d.includes(".")) ? ` or jdoe@${domains.find((d) => d.includes("."))}` : ""}` : null;
    return { div: { className: "org-signin", children: [
        hint("What the sign-in page calls the id people type, and what it shows in the empty box: whatever your people know it as (a Windows user name, an employee number). Changed through this change request, approved by governance; the sign-in page follows when next opened."),
        field("The id is called", { input: { type: "text", maxlength: 40, disabled: ro, value: si.idLabel ?? "", placeholder: "Username", "aria-label": "The id is called", onchange: (e) => edit("idLabel", e.target.value.trim()) } }, "E.g. Windows user name, Employee number, Badge number."),
        field("Shown in the empty box", { input: { type: "text", maxlength: 60, disabled: ro, value: si.idHint ?? "", placeholder: "nothing", "aria-label": "Shown in the empty box", onchange: (e) => edit("idHint", e.target.value.trim()) } }, "E.g. PLANT\\username, username@plant.local, 6 digits."),
        field("The plant's domains", tagsInput({ key: `${ctx.w}.signin.domains`, readOnly: ro, placeholder: "Add a domain (PLANT, plant.local)…", value: domains,
            create: (t) => (SIGN_IN_DOMAIN.test(t) ? t : { error: `“${t}” is not a domain: letters, digits and hyphens, parts separated by dots` }),
            onChange: (next) => edit("domains", next) }),
            "Typed before a \\ or / or after an @, a domain listed here is dropped: the id is what follows (or comes before). The id in People & departments has no domain."),
        { div: { className: "org-signin-sample login-password", children: [
            { label: { children: [{ span: si.idLabel || "Username" }, { input: { type: "text", readOnly: true, tabIndex: -1, placeholder: si.idHint || "", "aria-label": "How the sign-in page shows it" } }] } },
            example ? { p: { className: "muted small", textContent: `${example} signs in as jdoe.` } } : { span: {} },
        ] } },
        problems.length ? { ul: { className: "theme-checks", children: problems.map((p, i) => ({ li: { key: i, className: "error", children: [icon("x"), { span: p }] } })) } } : { span: {} },
    ] } };
}

function jsonTab(ctx) {
    const { api, w, ops, ro } = ctx;
    const draft = `${w}.json.org`;
    return {
        div: {
            children: [
                hint("The whole organization as JSON. Apply to replace the draft; every check runs on it."),
                { CodeEditor: { mode: "json", rows: 24, label: "The organization as JSON", readOnly: ro, value: () => { api.getState(`${w}.vrev`); return api.getState(draft, null) ?? JSON.stringify(api.peek(ops.root), null, 2); }, onInput: (t) => api.setValue(draft, t) } },
                ro() ? { span: {} } : { button: { type: "button", className: "btn", textContent: "Apply JSON", onclick: () => { try { const parsed = JSON.parse(api.peek(draft) ?? "null"); ops.edit((o) => { for (const k of Object.keys(o)) delete o[k]; Object.assign(o, parsed); }); api.setValue(draft, null); } catch (e) { api.setValue(`${w}.error`, `JSON: ${e.message}`); } } } },
            ],
        },
    };
}

export function registerOrganizationEditor(juris, { args } = {}) {
    // The organization as it is live, read-only (the editor on a copy of it), with the way to change it.
    juris.registerComponent("PeoplePage", (props, api) => {
        const as = api.getState("me.id", null, { track: false });
        const P = "people";
        api.live("design.organization", "design.organization", args.organization(as));
        api.live("design.home", "design.home", args.design(as));
        if (!api.isServer) titleTab(api, "/design/people", "People & departments");
        // The editor's copies of it (the draft and the live one it is compared with) are made in the
        // browser only: with a plant's people, each is megabytes the page would otherwise carry three times.
        if (!api.isServer) {
            const stop = api.bindState(() => api.getState("design.organization.version"), () => {
                const live = api.peek("design.organization");
                if (!live) return;
                const { open, version, ...org } = live;
                api.batch(() => { api.setValue(`${W(P)}.org`, clone(org)); api.setValue(`dc.${P}.live`, { organization: clone(org) }); api.setValue(`${W(P)}.rev`, (api.peek(`${W(P)}.rev`) ?? 0) + 1); });
            });
            api.onCleanup(stop);
        }
        const start = () => api.call("design.start", { organization: true }).then(({ id }) => api.navigate(`/design/c/${id}`), (e) => api.setValue("people.error", e.message));
        const isDesigner = () => (api.getState("design.home.me.roles", []) ?? []).includes("designer");
        return {
            div: {
                className: "view people",
                children: [
                    { div: { className: "view-head", children: [
                        { h1: { className: "icon-text", children: [{ GuideToggle: { key: "guide-people", guide: "designer-organization" } }, { span: "People & departments" }] } },
                        { span: { className: "muted", textContent: () => `As it is live (version ${api.getState("design.organization.version", "…")}). Changing it is a change request, approved by whom it affects.` } },
                        { span: { className: "spacer" } },
                        () => {
                            const open = api.getState("design.organization.open", null);
                            if (open) return { Link: { to: `/design/c/${open.id}`, className: "btn primary", textContent: `Open the change in progress (${open.state})` } };
                            return isDesigner() ? { button: { type: "button", className: "btn primary", textContent: "Change people & departments", onclick: start } } : { span: {} };
                        },
                    ] } },
                    { p: { className: "error", textContent: () => api.getState("people.error", "") ?? "" } },
                    () => (api.getState(`${W(P)}.org`, null) ? { OrganizationEditor: { key: "people", id: P, editable: false } } : { p: { className: "muted", textContent: "Loading…" } }),
                ],
            },
        };
    });

    juris.registerComponent("OrganizationEditor", ({ id, editable, pane = 0, head }, api) => {
        const w = W(id);
        const ops = orgOps(api, id);
        const view = () => { const v = api.getState(`${w}.panes.${pane}.view`, "departments"); return ORG_VIEWS.some(([k]) => k === v) ? v : "departments"; };
        const ro = () => !api.prop(editable);
        // What the draft changes, worked out once per edit for every tab's count and the open tab (with
        // a plant's people, each comparison is a pass over all of them).
        let memo = { at: null, all: [], impact: null };
        const changes = () => {
            const at = `${api.peek(`${w}.vrev`) ?? 0}:${api.peek(`${w}.rev`) ?? 0}`;
            if (memo.at !== at) memo = { at, all: changesOf(api, id, "organization", "organization"), impact: null };
            return memo.all;
        };
        // …and what it does to people's roles, once per edit too.
        const impact = () => { changes(); return (memo.impact ??= roleChanges(api.peek(`dc.${id}.live.organization`) ?? null, api.peek(ops.root))); };
        return {
            div: {
                className: "editor",
                children: [
                    { div: { className: "editor-head", children: [
                        head ?? { span: {} },
                        { nav: { className: "subtabs", children: ORG_VIEWS.map(([key, label]) => ({ button: { key, type: "button", className: "subtab", classList: { active: () => view() === key }, onclick: () => api.setValue(`${w}.panes.${pane}.view`, key), children: [{ span: label }, () => {
                            api.getState(`${w}.vrev`);
                            const all = changes();
                            const n = key === "changes" ? all.length : countByTab(all)[key] ?? 0;
                            return n ? { span: { className: "tab-diff", textContent: String(n) } } : { span: {} };
                        }] } })) } },
                    ] } },
                    () => {
                        api.getState(`${w}.rev`);
                        const org = api.peek(ops.root);
                        if (!org) return { p: { className: "muted", textContent: "Loading…" } };
                        const all = changes();
                        const changed = new Set(all.map((c) => `${c.element}:${c.change}`));
                        const changedAt = (el) => (changed.has(`${el}:added`) ? "diff-added" : changed.has(`${el}:changed`) ? "diff-changed" : "");
                        const touchedPeople = [...new Set(all.filter((c) => c.element?.startsWith("person:") && c.change !== "removed").map((c) => c.element.slice("person:".length)))];
                        const ctx = { api, w, ops, ro, org, id, changedAt, touchedPeople, impact };
                        switch (view()) {
                            case "changes": return { ChangesView: { key: `changes-org-${id}`, id, kind: "organization", name: "organization", onOpen: (tab) => api.setValue(`${w}.panes.${pane}.view`, tab) } };
                            case "groups": return groupsTab(ctx);
                            case "people": return peopleTab(ctx);
                            case "roles": return rolesTab(ctx);
                            case "certifications": return certificationsTab(ctx);
                            case "standing": return standingTab(ctx);
                            case "formats": return formatsTab(ctx);
                            case "theme": return themeTab(ctx);
                            case "retention": return retentionTab(ctx);
                            case "integrity": return integrityTab(ctx);
                            case "signin": return signInTab(ctx);
                            case "json": return jsonTab(ctx);
                            default: return departmentsTab(ctx);
                        }
                    },
                ],
            },
        };
    });
}
