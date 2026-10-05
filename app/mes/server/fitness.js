// The fitness test (DESIGN.md §5.9): what a change must pass before it is submitted for review, and
// the evidence its reviewers and approvers read. It tests exactly the content submitted: the report
// carries that content's hash, is kept on the change, and is frozen with it.
//
// It fails (and submitting is refused) when the change is broken or untested:
//   - validation problems (the same as the designer shows);
//   - a script that does not compile, or calls what it will not have (code-editor.js's check);
//   - a new or changed script without test cases, or a test case whose expectation is not met.
//     Cases run through the dry-run engine (integration.js): executed, nothing changed.
// It warns, for the approvers to weigh, about what the change does to what exists:
//   - existing records replayed through the draft definition and rule pipe: how many could no
//     longer be saved, and why (a rule that would refuse them, a field now required);
// and informs them of what it changes in access: per role and state, what is gained or lost.
//
// Test cases, per script, in content.tests (and published with the script):
//   rule script:    { name, run: { event, data, record }, expect: { data?: { field: value }, changed?: [fields], throws?: { message?, field? } } }
//   service script: { name, run: { input } | { event, responses }, as?: user,
//                     expect: { ok?: true | false, output?: {…}, error?: "words", writes?: n, requests?: n } }
//   a script a suite's part of a design names (§29.4): { name, run: {its input}, expect: { output?: {…}, throws?: { message? } } }
// A service's case runs as the service will in production: its own service role (the draft's roles),
// its user, or its caller (the author, or one of its callers named in `as`). A rule's, as the author.
import { fail } from "../../../src/errors.js";
import { CALL_KIND } from "../../../src/live-protocol.js";
import { canonical, sha256 } from "./audit.js";
import { checkScript, runRules, runDryScript } from "./rules.js";
import { decide } from "./policy.js";
import { validate } from "./services.js";
import { validateScript, roleChanges, suiteScripts, flowSetsOff, breakingForCallers } from "../client/definition.js";
import { organizationSnapshot, draftOf } from "./organization.js";
import { resolveIdentity } from "./integration.js";
import { callableProblems } from "../client/code-editor.js";

const REPLAY_LIMIT = 100;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// Does `have` hold everything `want` says (objects: key by key, deeply; anything else: equal)?
// What a case expects holds in what came out: its fields, and a list item by item (stored cases come
// back with their keys sorted, so never by their text).
const holds = (want, have) => (isPlain(want) ? isPlain(have) && Object.entries(want).every(([k, v]) => holds(v, have[k]))
    : Array.isArray(want) ? Array.isArray(have) && want.length === have.length && want.every((v, i) => holds(v, have[i])) : same(want, have));

export function createFitness({ store, design, integration, records, sandboxes = null, log = console }) {
    const { db } = store;

    // The objects and scripts as they will be once the change executes.
    async function world(content) {
        const live = await design.published();
        const definitions = { ...Object.fromEntries(Object.entries(live.definitions).map(([k, v]) => [k, v.body])), ...(content.definitions ?? {}) };
        const services = { ...Object.fromEntries(Object.entries(live.services).map(([k, v]) => [k, v.body])), ...(content.services ?? {}) };
        const scripts = new Map(Object.entries(live.scripts).map(([k, v]) => [k, { version: v.version, source: v.source }]));
        for (const [name, source] of Object.entries(content.scripts ?? {})) scripts.set(name, { version: `draft-${sha256(source).slice(0, 12)}`, source });
        return { live, definitions, services, scripts };
    }

    async function runCase(kind, name, source, c, { user, w, content }) {
        const label = c?.name ?? "(unnamed)";
        if (kind === "plain") {
            if (!isPlain(c) || !isPlain(c.run)) return { script: name, name: label, passed: false, detail: "A test case is { name, run, expect }." };
            const expect = isPlain(c.expect) ? c.expect : {};
            const r = await runDryScript({ name, source, ctx: { ...c.run, now: c.run.now ?? new Date().toISOString() } });
            if (expect.throws) {
                const ok = Boolean(r.error) && !r.error.fault && (expect.throws.message === undefined || String(r.error.message).includes(expect.throws.message));
                return { script: name, name: label, passed: ok, detail: ok ? `refused: ${r.error.message}` : r.error ? `refused differently: ${r.error.message}` : "expected a refusal; it ran" };
            }
            if (r.error) return { script: name, name: label, passed: false, detail: `${r.error.message}${r.error.line ? ` (line ${r.error.line})` : ""}` };
            if (expect.output !== undefined && !holds(expect.output, r.result)) return { script: name, name: label, passed: false, detail: `output ${JSON.stringify(r.result)} does not hold ${JSON.stringify(expect.output)}` };
            return { script: name, name: label, passed: true, detail: "ran as expected" };
        }
        if (!isPlain(c) || !isPlain(c.run)) return { script: name, name: label, passed: false, detail: "A test case is { name, run, expect }." };
        const expect = isPlain(c.expect) ? c.expect : {};
        if (kind === "rule") {
            const writes = [...new Set(Object.values(w.definitions).flatMap((d) => (d?.rules ?? []).filter((r) => r.script === name).flatMap((r) => r.writes ?? [])))];
            const r = await integration.dryRunRule({ user, name, source, writes, ctx: c.run });
            if (expect.throws) {
                const ok = Boolean(r.error) && !r.error.fault
                    && (expect.throws.message === undefined || String(r.error.message).includes(expect.throws.message))
                    && (expect.throws.field === undefined || r.error.field === expect.throws.field);
                return { script: name, name: label, passed: ok, detail: ok ? `refused: ${r.error.message}` : r.error ? `refused differently: ${r.error.message}${r.error.line ? ` (line ${r.error.line})` : ""}` : "expected a refusal; it passed" };
            }
            if (r.error) return { script: name, name: label, passed: false, detail: `${r.error.line ? `line ${r.error.line}: ` : ""}${r.error.message}` };
            if (expect.data && !holds(expect.data, r.data)) return { script: name, name: label, passed: false, detail: `data is ${JSON.stringify(Object.fromEntries(Object.keys(expect.data).map((k) => [k, r.data?.[k]])))}, expected ${JSON.stringify(expect.data)}` };
            if (expect.changed && !same([...expect.changed].sort(), [...r.changed].sort())) return { script: name, name: label, passed: false, detail: `changed ${r.changed.join(", ") || "nothing"}, expected ${expect.changed.join(", ")}` };
            return { script: name, name: label, passed: true, detail: r.changed.length ? `changed ${r.changed.join(", ")}` : "passed, changed nothing" };
        }
        // A service: as it will run in production (its service role, its user, or its caller).
        const service = w.services[name];
        const event = isPlain(c.run.event) ? c.run.event : null;
        let caller = user;
        if (c.as !== undefined && c.as !== user.id) {
            if (!(service.callers?.users ?? []).includes(c.as)) return { script: name, name: label, passed: false, detail: `A case stands in as one of its callers (${(service.callers?.users ?? []).join(", ") || "none yet"}), not ${c.as}.` };
            caller = await store.user(c.as);
            if (!caller) return { script: name, name: label, passed: false, detail: `No active user ${c.as}.` };
        }
        let as;
        try { as = await resolveIdentity(store, service, { caller: event ? null : caller, event }); } catch (e) { return { script: name, name: label, passed: false, detail: e.message }; }
        const r = await integration.dryRunService({ user: as, service, source, connections: content.connections ?? {}, transactions: content.transactions ?? {}, input: isPlain(c.run.input) ? c.run.input : {}, event, responses: c.run.responses });
        const wantOk = expect.ok ?? true;
        const where = r.error?.line ? ` (line ${r.error.line})` : "";
        if (wantOk !== r.ok) return { script: name, name: label, passed: false, detail: r.ok ? "expected a refusal; it ran" : `${r.error?.message ?? "failed"}${where}` };
        if (!wantOk && expect.error !== undefined && !String(r.error?.message).includes(expect.error)) return { script: name, name: label, passed: false, detail: `refused with "${r.error?.message}", expected "${expect.error}"` };
        if (wantOk && expect.output !== undefined && !holds(expect.output, r.output)) return { script: name, name: label, passed: false, detail: `output ${JSON.stringify(r.output)} does not hold ${JSON.stringify(expect.output)}` };
        if (expect.writes !== undefined && r.writes.length !== expect.writes) return { script: name, name: label, passed: false, detail: `would write ${r.writes.length}, expected ${expect.writes}` };
        if (expect.requests !== undefined && r.requests.length !== expect.requests) return { script: name, name: label, passed: false, detail: `would send ${r.requests.length}, expected ${expect.requests}` };
        return { script: name, name: label, passed: true, detail: `as ${as.id}: ${r.ok ? `ran; would write ${r.writes.length}, send ${r.requests.length}` : `refused: ${r.error?.message}`}` };
    }

    // The existing records of one object, replayed through the draft: what could no longer be saved.
    async function replay(object, draft, w, user) {
        const actor = { id: user.id, name: user.name, roles: await store.rolesFor(user.id, object), departments: [] };
        const self = { [CALL_KIND]: "internal", reason: "fitness", user };
        const lookup = async (o, id) => records["records.get"].call(self, { object: o, id });
        // Archived records are never saved again (read-only until restored): not replayed.
        const rows = await db.query("SELECT * FROM mes.records WHERE object = $1 AND archived_at IS NULL ORDER BY updated_at DESC LIMIT $2", [object, REPLAY_LIMIT]);
        const refused = new Map(); // why -> [titles]
        const faults = [];
        for (const row of rows) {
            const title = row.data?.[draft.titleField] ?? row.id.slice(0, 8);
            const invalid = validate(draft, row.data, { state: row.state, type: row.type });
            if (invalid) for (const [field, message] of Object.entries(invalid)) { const k = `${field}: ${message}`; refused.set(k, [...(refused.get(k) ?? []), title]); }
            if (!draft.states?.list?.includes(row.state)) { const k = `state "${row.state}" is no longer a state`; refused.set(k, [...(refused.get(k) ?? []), title]); }
            const outcome = await runRules({
                definition: draft, scripts: w.scripts, lookup,
                ctx: { event: { kind: "save", object, action: null, changed: [], source: "fitness", prev: {} }, user: actor, record: { ...row.data, id: row.id, state: row.state }, data: { ...row.data }, now: new Date().toISOString() },
            });
            if (outcome.error?.fault) faults.push(`${title}: ${outcome.error.script} failed (${outcome.error.detail ?? outcome.error.message})`);
            else if (outcome.error) { const k = `${outcome.error.script}: ${outcome.error.message}`; refused.set(k, [...(refused.get(k) ?? []), title]); }
        }
        return { count: rows.length, refused, faults };
    }

    // What each role may do, by state, before and after: the changes only.
    function accessDiff(object, before, after) {
        if (!before) return [`new object ${object}: roles ${(after.roles ?? []).join(", ") || "none"}`];
        const out = [];
        const roles = [...new Set([...(before.roles ?? []), ...(after.roles ?? [])])];
        const states = [...new Set([...(before.states?.list ?? []), ...(after.states?.list ?? [])])];
        for (const role of roles) {
            for (const state of states) {
                const user = { id: "fitness", roles: [role] };
                const a = before.states?.list?.includes(state) ? decide(before, user, { state }) : null;
                const b = after.states?.list?.includes(state) ? decide(after, user, { state }) : null;
                const parts = [];
                if (Boolean(a?.read) !== Boolean(b?.read)) parts.push(b?.read ? "+read" : "−read");
                if (state === (after.states?.initial ?? before.states?.initial) && Boolean(a?.create) !== Boolean(b?.create)) parts.push(b?.create ? "+create" : "−create");
                if (Boolean(a?.archive) !== Boolean(b?.archive)) parts.push(b?.archive ? "+archive" : "−archive");
                for (const f of new Set([...Object.keys(a?.fields ?? {}), ...Object.keys(b?.fields ?? {})])) {
                    const x = a?.fields?.[f] ?? "–";
                    const y = b?.fields?.[f] ?? "–";
                    if (x !== y) parts.push(`${f} ${x}→${y}`);
                }
                const actionsA = new Set(a?.actions ?? []);
                const actionsB = new Set(b?.actions ?? []);
                for (const act of actionsB) if (!actionsA.has(act)) parts.push(`+${act}`);
                for (const act of actionsA) if (!actionsB.has(act)) parts.push(`−${act}`);
                if (parts.length) out.push(`${object} · ${role} · ${state}: ${parts.join(", ")}`);
            }
        }
        return out;
    }

    // run(row, user) → the report. `row` is the change (its content and base).
    async function run(row, user) {
        const content = row.content;
        const started = Date.now();
        const w = await world(content);
        const checks = [];

        // 1. Validation.
        const problems = await design.problemsOf(content);
        checks.push({ id: "validation", title: "Valid", status: problems.length ? "fail" : "pass", summary: problems.length ? `${problems.length} problem(s)` : "no problems", items: problems.map((p) => p.message) });

        // 1b. A rollback (§5.14): applied in a sandbox, and everything published there checked together.
        // What it takes away from under something changed since is a conflict, found there and nowhere
        // else; a rollback with one is not submitted.
        if (row.rollback && sandboxes?.conflictsOf) {
            const c = await sandboxes.conflictsOf(row, user).catch((error) => ({ ok: false, items: [`The sandbox could not be made: ${error.message}`] }));
            checks.push({ id: "rollback", title: "Rolled back in a sandbox: nothing else breaks", status: c.ok ? "pass" : "fail", summary: c.ok ? "applied there; everything published still holds together" : `${c.items.length} conflict(s)`, items: c.items });
        }

        // 2. Scripts compile, and call only what they will have.
        const scriptItems = [];
        for (const [name, source] of Object.entries(content.scripts ?? {})) {
            for (const p of validateScript(name, source, checkScript)) scriptItems.push(p.message);
            try {
                for (const p of callableProblems(source, w.services[name] ? "service" : "rule", { suites: w.services[name]?.uses?.suites })) scriptItems.push(`${name}.js line ${p.line}: ${p.message}`);
            } catch { /* a script that does not compile is reported above */ }
        }
        const scriptCount = Object.keys(content.scripts ?? {}).length;
        checks.push({ id: "scripts", title: "Scripts compile and call only what they have", status: scriptItems.length ? "fail" : scriptCount ? "pass" : "info", summary: scriptCount ? (scriptItems.length ? `${scriptItems.length} finding(s)` : `${scriptCount} script(s) clean`) : "no scripts in this change", items: scriptItems });

        // 2b. Web services' callers (docs/contracts/http-apis): a change that would break whoever called a
        // web service over HTTP in the last 30 days needs their notice first: the service deprecated (they
        // are told on every call) and its sunset passed, or the new shape under a new name.
        const callerItems = [];
        let callersBroken = 0;
        let callersWarned = 0;
        const live = Object.keys(content.services ?? {}).length ? await store.services() : new Map();
        for (const [name, draft] of Object.entries(content.services ?? {})) {
            const was = live.get(name)?.body;
            const breaks = draft ? breakingForCallers(was, draft) : [];
            if (!breaks.length) continue;
            const callers = await store.db.query(
                `SELECT actor, after->'via'->>'http' AS token, count(*)::int AS n, max(at) AS last FROM mes.audit_log
                 WHERE object = '$service' AND after->>'service' = $1 AND after->'via' ? 'http' AND at > now() - interval '30 days'
                 GROUP BY 1, 2 ORDER BY n DESC LIMIT 10`, [name]);
            const who = callers.map((c) => `${c.actor} (token ${c.token}: ${c.n} call${c.n === 1 ? "" : "s"}, the last ${new Date(c.last).toISOString().slice(0, 10)})`).join("; ");
            const d = was.deprecated;
            if (!callers.length) { callersWarned++; callerItems.push(`${name}: ${breaks.join("; ")}. Nobody called it over HTTP in the last 30 days.`); }
            else if (d?.sunset && Date.parse(d.sunset) <= Date.now()) { callersWarned++; callerItems.push(`${name}: ${breaks.join("; ")}. Its callers were told (deprecated since ${d.since}, its sunset ${d.sunset} has passed): ${who}.`); }
            else {
                callersBroken++;
                callerItems.push(`${name} would break its callers, ${who}: ${breaks.join("; ")}. ${d ? `It is deprecated, and its sunset is ${d.sunset}: change it after then, or` : "Give them notice first: mark it deprecated with a sunset (they are told on every call) and change it after the sunset, or"} publish the new shape under a new name, as its successor.`);
            }
        }
        checks.push({ id: "callers", title: "Web services' callers", status: callersBroken ? "fail" : callersWarned ? "warn" : "info", summary: callersBroken ? `${callersBroken} web service(s) would break their callers` : callersWarned ? `${callersWarned} change(s) callers would notice` : "nothing a caller would notice", items: callerItems });

        // 3. Test cases: every new or changed script has some, and they pass.
        const cases = [];
        const missing = [];
        const tested = new Set([...Object.keys(content.scripts ?? {}), ...Object.keys(content.tests ?? {})]);
        // Scripts a suite's part of a design names (§29.4): input in, output out.
        const suiteNamed = new Set(Object.values(w.definitions).flatMap((d) => suiteScripts(d)));
        // And those a flow template's nodes run on entering and leaving (§32.6): the context in and out.
        const flowBodies = [...Object.values(w.live.flows ?? {}).map((f) => f.body), ...Object.values(content.flows ?? {})];
        for (const f of flowBodies) for (const n of Object.values(f?.nodes ?? {})) for (const k of ["onEnter", "onExit"]) if (typeof n?.[k] === "string") suiteNamed.add(n[k]);
        for (const name of tested) {
            const script = w.scripts.get(name);
            if (!script) continue;
            const changed = Object.hasOwn(content.scripts ?? {}, name) && content.scripts[name] !== w.live.scripts[name]?.source;
            const list = content.tests?.[name] ?? w.live.scripts[name]?.tests ?? [];
            if (!list.length) { if (changed) missing.push(`${name}.js has no test cases: a new or changed script carries its evidence.`); continue; }
            const kind = w.services[name] ? "service" : suiteNamed.has(name) ? "plain" : "rule";
            for (const c of list) {
                try {
                    cases.push(await runCase(kind, name, script.source, c, { user, w, content }));
                } catch (error) {
                    log.error?.("fitness case", error);
                    cases.push({ script: name, name: c?.name ?? "(unnamed)", passed: false, detail: `the case could not run: ${error.message}` });
                }
            }
        }
        const failedCases = cases.filter((c) => !c.passed);
        checks.push({
            id: "tests", title: "Test cases", status: missing.length || failedCases.length ? "fail" : cases.length ? "pass" : "info",
            summary: cases.length || missing.length ? `${cases.length - failedCases.length} of ${cases.length} passed${missing.length ? `; ${missing.length} script(s) without cases` : ""}` : "no scripts to test",
            items: [...missing, ...failedCases.map((c) => `${c.script} · ${c.name}: ${c.detail}`)], cases,
        });

        // 3b. Scenarios (§5.11): every new or changed transaction carries one or more, kept with its
        // versions; each runs in a sandbox, on fresh copies of real records (or records it gives).
        const toRun = [];
        const noScenario = [];
        // What it does, for this: the input flow it names (§32.13) says how it is filled from the keyboard,
        // not what it does, so naming one asks for no new evidence.
        const doing = (b) => { const { inputFlow, ...rest } = b ?? {}; return canonical(rest); };
        for (const [name, body] of Object.entries(content.transactions ?? {})) {
            const before = w.live.transactions?.[name]?.body;
            if (before && doing(before) === doing(body)) continue;
            const list = Array.isArray(body?.scenarios) ? body.scenarios : [];
            if (!list.length) noScenario.push(`${name}: a new or changed transaction carries a scenario: open the sandbox, run it on real records (or records you give), and save the run.`);
            for (const scenario of list) toRun.push({ transaction: name, scenario });
        }
        // And every new or changed flow template that sets off on its own (§32.8): walked through, its nodes expected.
        for (const [name, body] of Object.entries(content.flows ?? {})) {
            const before = w.live.flows?.[name]?.body;
            if (!body || (before && canonical(before) === canonical(body)) || !flowSetsOff(body)) continue;
            const list = Array.isArray(body?.scenarios) ? body.scenarios : [];
            if (!list.length) noScenario.push(`${name}: a new or changed flow template carries a scenario: open the sandbox, walk a record through it (a lot along the route, a reading that sets the plan off), and save the run.`);
            for (const scenario of list) toRun.push({ flow: name, scenario });
        }
        const runs = sandboxes ? await sandboxes.runScenarios(row, user, toRun) : toRun.map(({ transaction, flow, scenario }) => ({ ...(flow ? { flow } : { transaction }), name: scenario?.name ?? "(unnamed)", passed: false, detail: "no sandbox can be made here" }));
        const failedRuns = runs.filter((r) => !r.passed);
        checks.push({
            id: "scenarios", title: "Scenarios in a sandbox", status: noScenario.length || failedRuns.length ? "fail" : runs.length ? "pass" : "info",
            summary: runs.length || noScenario.length ? `${runs.length - failedRuns.length} of ${runs.length} passed${noScenario.length ? `; ${noScenario.length} without one` : ""}` : "no transactions or flow templates to try",
            items: [...noScenario, ...failedRuns.map((r) => `${r.transaction ?? r.flow} · ${r.name}: ${r.detail}`), ...[...new Set(runs.flatMap((r) => r.notes ?? []))]],
            runs: runs.map(({ transaction, flow, name, passed, detail }) => ({ ...(flow ? { flow } : { transaction }), name, passed, detail })),
        });

        // 4. Existing records, replayed through the draft.
        const affected = new Set(Object.keys(content.definitions ?? {}));
        for (const [object, d] of Object.entries(w.definitions)) if ((d?.rules ?? []).some((r) => Object.hasOwn(content.scripts ?? {}, r.script))) affected.add(object);
        const replayItems = [];
        const faultItems = [];
        let replayed = 0;
        for (const object of affected) {
            const draft = w.definitions[object];
            if (!draft || !w.live.definitions[object]) continue; // a new object has no records yet
            const r = await replay(object, draft, w, user);
            replayed += r.count;
            for (const [why, titles] of r.refused) replayItems.push(`${titles.length} of ${r.count} ${draft.label ?? object} record(s) could no longer be saved — ${why} (${titles.slice(0, 5).join(", ")}${titles.length > 5 ? ", …" : ""})`);
            faultItems.push(...r.faults.slice(0, 10).map((f) => `${object} ${f}`));
        }
        checks.push({
            id: "records", title: "Existing records under the draft", status: faultItems.length ? "fail" : replayItems.length ? "warn" : affected.size ? "pass" : "info",
            summary: !affected.size ? "no object's rules or definition change" : faultItems.length ? `${faultItems.length} script failure(s) on real records` : replayItems.length ? `${replayItems.length} finding(s) in ${replayed} record(s) replayed` : `${replayed} record(s) replayed, all still savable`,
            items: [...faultItems, ...replayItems],
        });

        // 5. Access, per role and state.
        const accessItems = [];
        for (const [object, body] of Object.entries(content.definitions ?? {})) accessItems.push(...accessDiff(object, w.live.definitions[object]?.body ?? null, body));
        checks.push({ id: "access", title: "Access changes", status: "info", summary: accessItems.length ? `${accessItems.length} change(s)` : "none", items: accessItems });

        // 6. People (§27): a change to the organization, person by person: the roles each gains and
        // loses (a move between departments moves the roles that come with them). A warning when
        // someone loses one, for the approvers to weigh.
        if (content.organization) {
            const people = roleChanges(draftOf(await organizationSnapshot(db)), content.organization);
            const items = people.flatMap((c) => [
                ...(c.lost.length ? [`${c.name} loses ${c.lost.map((x) => `${x.role.replace(":", " ")} (${x.via})`).join(", ")}`] : []),
                ...(c.gained.length ? [`${c.name} gains ${c.gained.map((x) => `${x.role.replace(":", " ")} (${x.via})`).join(", ")}`] : []),
            ]);
            const losing = people.filter((c) => c.lost.length).length;
            checks.push({ id: "people", title: "People's roles", status: losing ? "warn" : "info", summary: people.length ? `${people.length} person(s) affected${losing ? `, ${losing} lose a role` : ""}` : "nobody's roles change", items });
        }

        const counts = { fail: checks.filter((c) => c.status === "fail").length, warn: checks.filter((c) => c.status === "warn").length };
        return { at: new Date().toISOString(), by: user.id, hash: sha256(canonical(content)), passed: counts.fail === 0, counts, ms: Date.now() - started, checks };
    }

    const services = {
        // Run the fitness test on a change's draft now (its author or anyone who designs or reviews).
        async "design.fitness"({ id } = {}) {
            const user = await design.designUser(this);
            if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) fail("Not found.", { status: 404 });
            const [row] = await db.query("SELECT * FROM mes.change_requests WHERE id = $1", [id]);
            if (!row) fail("Not found.", { status: 404 });
            if (row.state !== "design") return row.fitness ?? null; // frozen with the submitted content
            const report = await run(row, user);
            await db.query("UPDATE mes.change_requests SET fitness = $2, updated_at = now() WHERE id = $1 AND state = 'design'", [id, JSON.stringify(report)]);
            return report;
        },
    };
    const touches = { "design.fitness": ({ id } = {}) => [{ name: "design.change", where: { id } }, { name: "design.home" }] };
    return { run, services, touches };
}

