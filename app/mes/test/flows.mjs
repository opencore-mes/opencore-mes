// Flow templates (§32), routes, end to end on the seed's lots and machines:
//   1. Dana designs a route: the lot opts in as its traveler (its station is its step field), the
//      machine as its resource. Start, Inspect, Press (presses only), then an auto decision on the
//      context (its max_scrap value) sends a lot either to Held (an end whose onEnter script holds it,
//      as the template) or to the Oven (ovens only), then Done. A template's mistakes are named, node by
//      node and wire by wire.
//   2. Approved by everyone it reaches; the lot's stewards too (it opts in, and the template writes it).
//   3. A lot made for the route starts it at Inspect, its station marked by the route, audited.
//   4. Not offered where it is: Move in at Inspect is refused, in words; Inspect takes it on to Press.
//   5. The wrong kind of machine at Press is refused; on a press, its four moves; Move out takes it on.
//   6. A lot scrapped beyond the context's limit: the auto decision sends it to Held, whose script holds
//      it (audited as the template) and notes why in the context; its run ends. A clean one goes to
//      the Oven, and on to Done.
//   7. Its step moved by hand: the route follows, off its wires, audited so, and its map shows the move
//      off route; moved to no step, the run stops, saying so; moved back to a step, it goes again.
//   8. Plans (OCAP): the seed's Deviation response set off by a major deviation (its start's script
//      holding the lot, as the plan), not by a minor one; in Quality's inbox; refused to someone it is
//      not for; its input screen's fields checked, then filled in with a photo; the lab's wait
//      acknowledged; Engineering's choice; Production's retry back; the lot rejected; its way, files
//      and audit; its map, the template as its version draws it, its way on it (§32.7). A plan of its
//      own: a wait that goes on by itself, a sub flow that hands a value back. A plan sets off once per
//      record, unless its start says again (then again once its last run has ended, never two at a
//      time); and on a date of its subject (due): on a write once the date has arrived, and by the
//      scheduler when it arrives with no write.
//   9. The AI: the template contract, a live template, one checked (by node; what is missing), laid
//      out, and explained in words.
//  10. A suite's node kind: with the hello suite, a greeting station is checked by the suite; without
//      it, a node of that kind needs the hello suite.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/flows.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { loadSuites } from "../suites.mjs";
import { flowWalk } from "../client/definition.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
let app = null;
let suiteApp = null;

try {
    const suites = await loadSuites({ dir: fileURLToPath(new URL("./fixtures/suites/", import.meta.url)) });
    // Its scheduler on, quickly: a plan's wait that goes on by itself (§32.5).
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 250 });
    const { url: mes } = await app.listen({ port: 0 });
    const people = ["olga", "sam", "quinn", "dana", "eli", "vera", "ivan", "ines"];
    const sessions = {};
    for (const user of people) {
        sessions[user] = `fl-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const callAt = (base) => async (user, name, args) => {
        const res = await fetch(`${base}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const call = callAt(mes);
    const key = () => `fl-${randomBytes(8).toString("hex")}`;
    const run = (name, input, user = "olga") => call(user, "transactions.run", { name, input, key: key() });

    // ---- 1. the design ----
    const ITEM = `FLOW-${tag}`;
    const FLOW = `press_route_t${tag}`;
    const INSPECT = `inspect_t${tag}`;
    const HOLD = `hold_lot_t${tag}`;
    const CHECK = `check_t${tag}`;
    const { id } = await call("dana", "design.start", { flow: FLOW, label: "Press route" });
    const [lotDef] = await db.query("SELECT body FROM mes.definitions WHERE object = 'lot' AND status = 'published'");
    const [machineDef] = await db.query("SELECT body FROM mes.definitions WHERE object = 'machine' AND status = 'published'");
    const lot = {
        ...lotDef.body,
        fields: { ...lotDef.body.fields, station: { label: "Station", type: "string" } },
        roles: [...lotDef.body.roles.filter((r) => r !== "router"), "router"],
        policies: [
            ...lotDef.body.policies.filter((x) => !["lot-router", "lot-station"].includes(x.id)),
            { id: "lot-router", roles: ["router"], record: { read: true }, fields: { station: "write", "*": "read" }, actions: { hold: "allow" } },
            // On the floor a lot's station may be set by hand (a lot carried elsewhere): the route follows.
            { id: "lot-station", roles: ["operator", "supervisor"], fields: { station: "write" } },
        ],
        flow: { as: ["traveler"], step: "station" },
        // Its history says the machine and what was scrapped; the rest of a change is counted, not listed.
        history: { fields: ["machine", "scrap_qty"] },
    };
    // A machine may have another paired on it (an oven beside a press): read off it, never placed by the route.
    const machine = { ...machineDef.body, fields: { ...machineDef.body.fields, paired: { label: "Paired with", type: "ref", to: "machine" } }, flow: { as: ["resource"] } };
    const inspect = {
        name: INSPECT, label: "Inspect", description: "The lot is looked at, and started.",
        inputs: { lot: { label: "Lot", type: "ref", to: "lot", required: true } },
        appearsOn: { object: "lot", states: ["created"], fills: "lot" },
        require: [], steps: [{ on: "lot", action: "start" }],
        confirm: true, callers: { users: [], groups: ["production"] }, stewards: ["production"],
        scenarios: [{ name: "a new lot started", records: { wo: { object: "work_order", where: { wo_no: ["WO-1002"] } }, lot: { object: "lot", data: { lot_no: `IN-${tag}`, item: "PP-BLK-10", work_order: "@wo", qty: 10, uom: "kg" } } }, steps: [{ as: "olga", do: { transaction: INSPECT, input: { lot: "@lot" } }, expect: { ok: true, states: { lot: "in_process" } } }] }],
    };
    const check = {
        name: CHECK, label: "Check the press", description: "A press checked, with the machine paired on it.",
        inputs: {
            lot: { label: "Lot", type: "ref", to: "lot", required: true },
            machine: { label: "Machine", type: "ref", to: "machine", required: true },
            paired: { label: "Paired with", type: "ref", to: "machine", from: "machine.paired" },
        },
        appearsOn: { object: "lot", states: ["in_process"], fills: "lot" },
        require: [], steps: [{ on: "lot", set: { uom: { lookup: "lot.uom" } } }],
        confirm: true, callers: { users: [], groups: ["production"] }, stewards: ["production"],
        scenarios: [{
            name: "a press with an oven paired on it checked at Press",
            records: {
                wo: { object: "work_order", where: { wo_no: ["WO-1002"] } },
                oven: { object: "machine", data: { machine_id: `SO-${tag}`, name: "Scenario oven", kind: "oven", capacity: 4 } },
                press: { object: "machine", data: { machine_id: `SP-${tag}`, name: "Scenario press", kind: "press", capacity: 1, paired: "@oven" } },
                lot: { object: "lot", data: { lot_no: `SK-${tag}`, item: ITEM, work_order: "@wo", qty: 10, uom: "kg", station: "press" } },
            },
            steps: [{ as: "olga", do: { transaction: CHECK, input: { lot: "@lot", machine: "@press" } }, expect: { ok: true } }],
        }],
    };
    // Held's onEnter: holds the lot, and notes why in the context.
    const holdScript = `// On entering Held: the lot is held, as the route, by its own lifecycle (§32.5).
export default async function ${HOLD}(ctx) {
  ctx.context.held_for = "scrap over " + ctx.context.max_scrap;
  ctx.context.held_at = ctx.now;
  // As the template, with its roles: its own lot and a work order (it holds roles there), its machine
  // (none there: null).
  const lot = await ctx.lookup("lot", ctx.context.lot.id);
  ctx.context.held_qty = lot ? lot.qty : null;
  ctx.context.saw_order = (await ctx.lookup("work_order", "WO-1002")) !== null;
  ctx.context.saw_machine = (await ctx.lookup("machine", "SP-${tag}")) !== null;
  ctx.writes.push({ record: "lot", action: "hold" });
  return ctx;
}
`;
    const holdTests = [{ name: "holds the lot", run: { event: { kind: "enter", node: "held" }, context: { max_scrap: 5, lot: { id: "L1" } }, writes: [], now: "2026-10-01T08:00:00.000Z", lookups: { "lot/L1": { qty: 90 }, "work_order/WO-1002": { wo_no: "WO-1002" } } }, expect: { output: { writes: [{ record: "lot", action: "hold" }], context: { held_for: "scrap over 5", held_at: "2026-10-01T08:00:00.000Z", held_qty: 90, saw_order: true, saw_machine: false } } } }];
    const flow = {
        name: FLOW, label: "Press route", description: "Inspect, press, then the oven; too much scrap is held.", kind: "route",
        participants: { lot: { object: "lot", as: "traveler" }, machine: { object: "machine", as: "resource" } },
        context: { max_scrap: 5 },
        ends: { when: { in: [{ context: "lot.state" }, ["consumed"]] } },
        nodes: {
            start: { kind: "start", label: "Start", when: { eq: [{ context: "lot.item" }, ITEM] } },
            inspect: { kind: "sequence", label: "Inspect", offers: [INSPECT], leaves: [INSPECT] },
            press: { kind: "sequence", label: "Press", offers: ["move_in", "track_in", "track_out", "move_out", CHECK], leaves: ["move_out"], resource: { kind: ["press"] }, settings: { max_scrap: 5 } },
            scrap: { kind: "auto_decision", label: "Too much scrap?" },
            held: { kind: "end", label: "Held", outcome: "held", onEnter: HOLD },
            oven: { kind: "sequence", label: "Oven", offers: ["move_in", "track_in", "track_out", "move_out"], leaves: ["move_out"], resource: { kind: ["oven"] } },
            done: { kind: "end", label: "Done", outcome: "done" },
        },
        edges: [
            { from: "start", to: "inspect" },
            { from: "inspect", to: "press" },
            { from: "press", to: "scrap" },
            { from: "scrap", to: "held", when: { gt: [{ context: "lot.scrap_qty" }, { context: "max_scrap" }] } },
            { from: "scrap", to: "oven" },
            { from: "oven", to: "done" },
        ],
        layout: { start: { x: 40, y: 60 }, inspect: { x: 220, y: 60 }, press: { x: 400, y: 60 }, scrap: { x: 580, y: 60 }, held: { x: 580, y: 200 }, oven: { x: 760, y: 60 }, done: { x: 940, y: 60 } },
        roles: { lot: ["router"], work_order: ["viewer"] }, stewards: ["production"],
        // Its evidence (§32.8): a lot made part-way, at Inspect, taken on to Press.
        scenarios: [{
            name: "Inspect takes a lot on to Press",
            records: { wo: { object: "work_order", where: { wo_no: ["WO-1002"] } }, lot: { object: "lot", data: { lot_no: `SC-${tag}`, item: ITEM, work_order: "@wo", qty: 10, uom: "kg", station: "inspect" } } },
            steps: [{ as: "olga", do: { transaction: INSPECT, input: { lot: "@lot" } }, expect: { ok: true, node: { lot: "press" } } }],
        }],
    };
    const wrong = await call("dana", "design.check", {
        definitions: { lot: { ...lot, flow: undefined }, machine },
        transactions: { [INSPECT]: inspect, [CHECK]: check },
        scripts: { [HOLD]: holdScript },
        flows: { [FLOW]: {
            ...flow,
            nodes: { ...flow.nodes, lost: { kind: "sequence", label: "Lost", offers: ["move_in"], leaves: ["track_in"] }, ask: { kind: "manual_decision", label: "Ask", for: { groups: ["quality"] } }, nap: { kind: "wait", label: "Nap", mode: "auto" }, inspect: { ...flow.nodes.inspect, onExit: "no_such_script" } },
            edges: [...flow.edges, { from: "inspect", to: "done", when: { gt: [{ context: "lot.qty" }, 1] } }, { from: "nap", to: "done" }, { from: "ask", to: "done" }],
        } },
    });
    const words = (wrong.problems ?? []).map((p) => p.message).join("\n");
    step("a template's mistakes are named: an object that did not opt in, a node no way leads to, leaving on what it does not offer, a condition off an auto decision, a plan's node on a route, a wait with nothing to show, a script that is not there",
        /lot does not take part in flows as a traveler/.test(words) && /Lost: no way leads to it from the start/.test(words) && /Lost: it leaves on track_in, which it does not offer/.test(words)
        && /only an auto decision's wires have conditions/.test(words) && /Ask: a manual decision belongs to a plan, not a route/.test(words) && /Nap: say what it shows while it waits/.test(words) && /onExit "no_such_script" is not a script/.test(words), wrong.problems);
    const fresh = await call("dana", "design.change", { id, as: "dana" });
    const saved = await call("dana", "design.save", { id, seen: fresh.draft_rev, reason: "Lots go through the press, then the oven.", definitions: { lot, machine }, transactions: { [INSPECT]: inspect, [CHECK]: check }, scripts: { [HOLD]: holdScript }, tests: { [HOLD]: holdTests }, flows: { [FLOW]: flow } });
    step("the route, the lot and machine opting in, Inspect and Held's script, drafted together: no problems", saved.problems?.length === 0, saved.problems);
    const tried = await call("dana", "sandbox.tryScenario", { id, flow: FLOW, scenario: { records: flow.scenarios[0].records, steps: [{ ...flow.scenarios[0].steps[0], expect: { ok: true, node: { lot: "oven" } } }] } });
    step("a scenario tried on the draft that expects the wrong node fails, saying where the lot is (§32.8)", tried.passed === false && /lot is at press, expected at oven/.test(tried.detail), tried);

    // ---- 1b. the route followed by hand in the change's sandbox (§32.8) ----
    const box = await call("dana", "sandbox.open", { id, records: { ...flow.scenarios[0].records, press: { object: "machine", where: { kind: ["press"], state: ["idle"] } }, broken: { object: "machine", data: { machine_id: `MX-${tag}`, name: "Press out of order", kind: "press", capacity: 1 }, state: "down" }, oven: { object: "machine", where: { kind: ["oven"] }, state: "down" } } });
    const boxLot = box.records?.lot?.id;
    const [liveOven] = await db.query("SELECT state FROM mes.records WHERE id = $1", [box.records?.oven?.id]);
    step("a record picked may start in a state of its own: the oven, idle live, starts down in the sandbox, said so; the live one is untouched",
        box.records?.oven?.state === "down" && liveOven?.state !== "down" && (box.notes ?? []).some((n) => /oven: starts down here/.test(n)), { oven: box.records?.oven, live: liveOven, notes: box.notes, error: box.error });
    const travelers = await call("dana", "sandbox.travelers", { id });
    const atInspect = await call("dana", "sandbox.where", { id, record: boxLot, as: "olga" });
    step("in the change's sandbox, the lot it starts with is a traveler on the drafted route: at Inspect, which offers Inspect, with the route's map and no plan waiting",
        travelers.length === 1 && travelers[0].id === boxLot && travelers[0].key === "lot" && travelers[0].route === "Press route" && travelers[0].runState === "running"
        && atInspect.route?.node === "inspect" && atInspect.route.offers.includes(INSPECT) && Boolean(atInspect.route.map?.nodes?.press) && atInspect.tasks.length === 0,
        { travelers, atInspect: { node: atInspect.route?.node, offers: atInspect.route?.offers, tasks: atInspect.tasks, error: atInspect.error } });
    const boxInspected = await call("dana", "sandbox.run", { id, step: { as: "olga", do: { transaction: INSPECT, input: { lot: "@lot" } } } });
    const atPress = await call("dana", "sandbox.where", { id, record: boxLot, as: "olga" });
    const suggested = await call("dana", "sandbox.suggest", { id, as: "olga", transaction: "move_in", input: { lot: boxLot }, field: "machine" });
    const byKey = Object.fromEntries((suggested.candidates ?? []).map((c) => [c.key, c]));
    step("Inspect run there, the lot is at Press; for Move in's machine it suggests the presses only (the oven is not where Press is done), the idle one taken, the one down refused in the transaction's words",
        boxInspected.ok && atPress.route?.node === "press" && suggested.step?.node === "press" && suggested.step.allows?.kind?.includes("press")
        && byKey.press?.ok === true && byKey.broken?.ok === false && /The machine is down/.test(byKey.broken.why) && !byKey.oven && suggested.others >= 1
        && suggested.candidates[0].ok === true,
        { inspected: boxInspected.error ?? "ok", node: atPress.route?.node, suggested });
    const noLot = await call("dana", "sandbox.suggest", { id, as: "olga", transaction: "move_in", input: {}, field: "machine" });
    const notTheirs = await call("dana", "sandbox.suggest", { id, as: "vera", transaction: "move_in", input: { lot: boxLot }, field: "machine" });
    step("…with no lot given, it suggests no machine to guess among, but asks for the lot first; as someone who may not run it, it says why once, trying none",
        noLot.waitFor?.field === "lot" && noLot.candidates.length === 0
        && Boolean(notTheirs.untried) && notTheirs.candidates.length > 0 && notTheirs.candidates.every((c) => c.ok === null),
        { noLot, notTheirs: { untried: notTheirs.untried, n: notTheirs.candidates?.length, error: notTheirs.error } });
    step("…each suggestion says what it is, by its object's list columns (a machine's name and kind), not only its number",
        Array.isArray(byKey.press?.about) && byKey.press.about.includes("press") && byKey.press.about.length <= 2, byKey.press);
    const notRef = await call("dana", "sandbox.suggest", { id, as: "olga", transaction: INSPECT, input: {}, field: "nothing_here" });
    step("…and nothing for an input that is not a reference", Array.isArray(notRef.candidates) && notRef.candidates.length === 0, notRef);
    await call("dana", "sandbox.close", { id });
    const badState = await call("dana", "sandbox.open", { id, records: { oven: { object: "machine", where: { kind: ["oven"] }, state: "asleep" } } });
    step("…one its object does not have is refused, naming those it has", /has no state "asleep": one of/.test(badState.error ?? ""), badState);
    await call("dana", "sandbox.close", { id });
    // What the route needs to be walked to its end, before a sandbox is opened (§5.11).
    const [pressId] = (await db.query("SELECT id FROM mes.records WHERE object = 'machine' AND data->>'kind' = 'press' AND archived_at IS NULL LIMIT 1")).map((r) => r.id);
    const needs = await call("dana", "sandbox.needs", { id, flow: FLOW, records: { lot: flow.scenarios[0].records.lot, press: { object: "machine", id: pressId } } });
    const machineNeeds = (needs.needs ?? []).filter((n) => n.object === "machine");
    const kindsNeeded = machineNeeds.map((n) => [].concat(n.where.kind).join());
    step("what the drafted route needs is said before the sandbox opens: a press for Press and an oven for Oven, in the order a lot meets them; the press chosen gives the first, live ovens are offered for the second",
        needs.flow === FLOW && needs.routes?.some((r) => r.name === FLOW && r.draft) && kindsNeeded.join("|") === "press|oven"
        && machineNeeds[0].why.includes("Press") && machineNeeds[0].have.includes("press") && machineNeeds[1].have.length === 0 && machineNeeds[1].candidates.length > 0
        && needs.traveler?.object === "lot",
        { needs: needs.error ?? needs.needs, routes: needs.routes });
    // The traveler is the first need: the route's own (its participant as traveler), the ones its start takes.
    const bare = await call("dana", "sandbox.needs", { id, flow: FLOW, records: {} });
    step("…and the traveler first, as required as the rest: a lot whose item the route's start takes, the given one counting; asked for when none is chosen",
        needs.needs?.[0]?.object === "lot" && Boolean(needs.needs[0].traveler) && [].concat(needs.needs[0].where?.item).join() === ITEM && needs.needs[0].have.includes("lot")
        && bare.needs?.[0]?.object === "lot" && bare.needs[0].have.length === 0 && /the traveler/.test(bare.needs[0].why.join()),
        { first: needs.needs?.[0], bare: bare.needs?.[0] ?? bare });

    // ---- 2. approved ----
    const submitted = await call("dana", "design.submit", { id });
    const routed = await call("dana", "design.change", { id, as: "dana" });
    const flowRuns = (routed.fitness?.checks ?? []).find((c) => c.id === "scenarios")?.runs?.filter((r) => r.flow === FLOW) ?? [];
    step("the fitness test walked the route's scenario in a sandbox: passed", flowRuns.length === 1 && flowRuns[0].passed, flowRuns);
    await call("vera", "design.review", { id, decision: "pass" });
    let state = null;
    for (let round = 0; round < 4 && state !== "executed"; round++) {
        for (const user of people) {
            const seen = await call(user, "design.change", { id, as: user });
            for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
        }
    }
    const unfit = submitted.ok ? null : JSON.stringify((await call("dana", "design.change", { id, as: "dana" })).fitness ?? {}).slice(0, 3000);
    step("routed to the lot's stewards (production, quality) and approved: live", submitted.ok && routed.route.map((r) => r.department).sort().join() === "production,quality" && state === "executed", { submitted, unfit, route: routed.route?.map((r) => r.department), state });

    // ---- 3. a lot starts the route ----
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1002'");
    const newLot = async (no, qty) => (await call("sam", "records.create", { object: "lot", data: { lot_no: no, item: ITEM, work_order: wo.id, qty, uom: "kg" }, key: key() })).id;
    const runOf = (lotId) => call("olga", "flows.runOf", { object: "lot", id: lotId, as: "olga" });
    const rec = async (object, rid) => (await db.query("SELECT state, data FROM mes.records WHERE id = $1", [rid]))[0];
    const lotA = await newLot(`FA-${tag}`, 100);
    let where = await runOf(lotA);
    step("a lot made for the route starts it at Inspect; the route marks its station", where?.node === "inspect" && where.state === "running" && (await rec("lot", lotA)).data.station === "inspect", where);
    const other = (await call("sam", "records.create", { object: "lot", data: { lot_no: `FX-${tag}`, item: "PP-BLK-10", work_order: wo.id, qty: 10, uom: "kg" }, key: key() })).id;
    step("…a lot its start condition does not hold for is on no route", (await runOf(other)) === null);

    // ---- a template copied (§32.4): another starts as a copy of a live one ----
    const COPY = `press_route_b_t${tag}`;
    const copied = await call("dana", "design.start", { flow: COPY, label: "Press route B", from: FLOW });
    const copyChange = copied.id ? await call("dana", "design.change", { id: copied.id, as: "dana" }) : null;
    const copyBody = copyChange?.content?.flows?.[COPY];
    const [liveFlow] = await db.query("SELECT body FROM mes.flows WHERE name = $1 AND status = 'published'", [FLOW]);
    const same = (k) => JSON.stringify(copyBody?.[k]) === JSON.stringify(liveFlow.body[k]);
    step("a flow template started as a copy of a live one: a new change, all of it under the new name and label, its title saying whose copy it is",
        !copied.error && copyBody?.name === COPY && copyBody.label === "Press route B" && ["nodes", "edges", "participants", "layout", "roles", "stewards"].every(same) && /a copy of Press route/.test(copyChange.title),
        { copied, title: copyChange?.title, name: copyBody?.name });
    const notLive = await call("dana", "design.start", { flow: `nope_t${tag}`, from: `no_such_t${tag}` });
    const taken = await call("dana", "design.start", { flow: FLOW, from: FLOW });
    const notCopied = await call("dana", "design.start", { retire: { kind: "flows", name: FLOW }, from: FLOW });
    step("…refused, in words: a copy of what is not live, under a name taken, of a retirement",
        notLive.status === 400 && /no live flow/.test(notLive.error) && taken.status === 400 && /exists already/.test(taken.error) && notCopied.status === 400 && /is not started as a copy/.test(notCopied.error), { notLive, taken, notCopied });
    if (copied.id) await call("dana", "design.withdraw", { id: copied.id }).catch(() => null);

    // ---- 4. not offered here; on ----
    // A press and an oven of its own (other suites leave the seed's busy).
    const press = await call("sam", "records.create", { object: "machine", data: { machine_id: `PR-${tag}`, name: "Flow press", kind: "press", capacity: 1 }, key: key() });
    const oven = await call("sam", "records.create", { object: "machine", data: { machine_id: `OV-${tag}`, name: "Flow oven", kind: "oven", capacity: 4 }, key: key() });
    const early = await run("move_in", { lot: lotA, machine: press.id });
    step("Move in at Inspect is refused: it is not done there, in words", early.status >= 400 && /is at Inspect \(Press route\), where Move in is not done/.test(early.error), early);
    const inspected = await run(INSPECT, { lot: lotA });
    where = await runOf(lotA);
    step("Inspect takes it on: at Press, its station following", inspected.ok && where.node === "press" && (await rec("lot", lotA)).data.station === "press", { inspected, where });

    // A machine read off the one picked (its paired oven) is that one's part; the one picked is still placed.
    const paired = await call("sam", "records.create", { object: "machine", data: { machine_id: `PP-${tag}`, name: "Flow press, paired", kind: "press", capacity: 1, paired: oven.id }, key: key() });
    const pairedCheck = await run(CHECK, { lot: lotA, machine: paired.id });
    const checkOven = await run(CHECK, { lot: lotA, machine: oven.id });
    step("a machine read off the one picked (the oven paired on a press) is not placed by the route; the one picked still is",
        pairedCheck.ok && checkOven.status >= 400 && new RegExp(`OV-${tag} is not where Press is done`).test(checkOven.error), { pairedCheck, checkOven });

    // ---- 5. the wrong machine; the four moves ----
    const toOven = await run("move_in", { lot: lotA, machine: oven.id });
    step("the oven at Press is refused: not where Press is done, its kind named", toOven.status >= 400 && new RegExp(`OV-${tag} is not where Press is done: its kind is oven`).test(toOven.error), toOven);
    const moved = await run("move_in", { lot: lotA, machine: press.id });
    const tracked = await run("track_in", { lot: lotA });
    const out = await run("track_out", { lot: lotA, good_qty: 90, scrap_qty: 10, scrap_reason: "dimension" });
    where = await runOf(lotA);
    step("on a press: Move in, Track in, Track out run, and it stays at Press until it leaves", moved.ok && tracked.ok && out.ok && where.node === "press", { moved: moved.error, tracked: tracked.error, out: out.error, where });

    // ---- 6. an auto decision on the context, an end's script ----
    const away = await run("move_out", { lot: lotA });
    where = await runOf(lotA);
    const heldLot = await rec("lot", lotA);
    step("Move out takes it on: 10 kg scrapped, over the context's 5, the auto decision sends it to Held, whose script holds it and says why in the context; its run ends",
        away.ok && where.state === "ended" && where.outcome === "held" && heldLot.state === "on_hold" && where.steps.map((s) => s.node).join() === "start,inspect,press,scrap,held" && where.context?.held_for === "scrap over 5", { away: away.error, where, state: heldLot.state });
    step("…its script read the time as every script does, from ctx.now (§12): when it held the lot",
        typeof where.context?.held_at === "string" && Math.abs(Date.parse(where.context.held_at) - Date.now()) < 120000, where.context);
    step("…and looked records up as the template (§32.6): its own lot read, with its quantity, and a work order (roles it holds); its machine, where it holds none, not seen",
        where.context?.held_qty === heldLot.data.qty && where.context?.saw_order === true && where.context?.saw_machine === false, { context: where.context, qty: heldLot.data.qty });
    // Its history in words (§10.10): a transaction's writes named by it, a step by its label and route, the
    // fields the design says by their labels, the rest counted; every change on asking.
    const hist = await call("olga", "records.history", { object: "lot", id: lotA });
    const histAll = await call("olga", "records.history", { object: "lot", id: lotA, every: true });
    const keysOf = (rows) => new Set(rows.flatMap((r) => Object.keys({ ...(r.before ?? {}), ...(r.after ?? {}) })));
    const outRows = hist.filter((r) => r.via?.name === "track_out");
    step("its history names the transaction behind each change and the step it entered, by label and route; only the fields its design says, the rest counted; every change on asking",
        outRows.length >= 1 && outRows.every((r) => r.via.label === "Track out" && r.via.kind === "transaction") && hist.some((r) => r.step?.label === "Press" && r.step.route === "Press route" && r.via?.kind === "flow")
        && hist.some((r) => r.labels?.scrap_qty && r.after?.scrap_qty === 10) && [...keysOf(hist)].every((k) => ["machine", "scrap_qty", "state", "archived_at", "archived_by"].includes(k))
        && hist.some((r) => r.omitted > 0) && keysOf(histAll).has("scrap_reason") && hist.every((r) => r.actorName),
        { hist: hist.map((r) => [r.action, r.via?.label, r.step?.label, Object.keys(r.after ?? {}).join(","), r.omitted]), every: [...keysOf(histAll)] });
    const audit = await db.query("SELECT actor, on_behalf_of FROM mes.audit_log WHERE record_id = $1 AND action = 'transition:hold'", [lotA]);
    step("…the hold is audited as the flow, for its run", audit.length === 1 && audit[0].actor === `flow:${FLOW}` && audit[0].on_behalf_of?.startsWith(`flow:${FLOW}:`), audit);
    const lotB = await newLot(`FB-${tag}`, 50);
    await run(INSPECT, { lot: lotB });
    await run("move_in", { lot: lotB, machine: press.id });
    await run("track_in", { lot: lotB });
    await run("track_out", { lot: lotB, good_qty: 50, scrap_qty: 0 });
    await run("move_out", { lot: lotB });
    where = await runOf(lotB);
    step("a clean lot goes to the Oven instead (the oven now its machine's kind)", where.node === "oven" && (await rec("lot", lotB)).data.station === "oven", where);
    const ovenIn = await run("move_in", { lot: lotB, machine: oven.id });
    await run("track_in", { lot: lotB });
    await run("track_out", { lot: lotB, good_qty: 50, scrap_qty: 0 });
    await run("move_out", { lot: lotB });
    where = await runOf(lotB);
    step("…and from the Oven to the end: Done", ovenIn.ok && where.state === "ended" && where.outcome === "done", { ovenIn: ovenIn.error, where });

    // ---- 7. its step moved by hand ----
    const lotC = await newLot(`FC-${tag}`, 20);
    const setStation = async (station) => {
        const [row] = await db.query("SELECT row_version FROM mes.records WHERE id = $1", [lotC]);
        return call("olga", "records.update", { object: "lot", id: lotC, rowVersion: Number(row.row_version), data: { station }, key: key() });
    };
    const carried = await setStation("oven");
    where = await runOf(lotC);
    step("its station set to Oven by hand, at Inspect: the route follows it there, off its wires, audited so", !carried.error && where.node === "oven" && where.state === "running" && where.steps.at(-1).offRoute === true && /off route/.test(where.steps.at(-1).via), { carried, where });
    const offWalk = where.map ? flowWalk(where.map, where.steps) : null;
    step("…its map: the route as its version draws it, the move from Inspect to the Oven shown off its wires (§32.7)",
        where.map?.kind === "route" && where.map.nodes.oven?.kind === "sequence" && where.map.nodes.held?.hooks === true && offWalk.off.some((m) => m.from === "inspect" && m.to === "oven") && offWalk.visits.oven === 1,
        { map: where.map && Object.keys(where.map.nodes), offWalk });
    const lost = await setStation("paint shop");
    where = await runOf(lotC);
    const lostTx = await run("move_in", { lot: lotC, machine: oven.id });
    step("…set to no step of the route: the run stops, saying so, and the route's moves are refused until it is put right", !lost.error && where.state === "stopped" && /"paint shop", which is no step of Press route/.test(where.reason) && lostTx.status >= 400 && /is stopped at Oven/.test(lostTx.error), { lost, where, lostTx });
    await setStation("press");
    where = await runOf(lotC);
    step("…set back to a step: it goes again, from there", where.node === "press" && where.state === "running", where);

    // ---- 8. plans (OCAP) ----
    const lotD = await newLot(`FD-${tag}`, 30);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const planOf = async (devId, flowName = "deviation_response") => (await db.query("SELECT * FROM mes.flow_runs WHERE subject_id = $1 AND flow = $2 ORDER BY started_at DESC LIMIT 1", [devId, flowName]))[0];
    const minor = await call("quinn", "records.create", { object: "deviation", data: { title: `Scratch ${tag}`, lot: lotD, severity: "minor" }, key: key() });
    const major = await call("quinn", "records.create", { object: "deviation", data: { title: `Moisture ${tag}`, lot: lotD, severity: "major" }, key: key() });
    let plan = await planOf(major.id);
    step("a major deviation sets the Deviation response off (a minor one does not); its start's script holds the lot, as the plan; it waits at Contain, for Quality",
        !(await planOf(minor.id)) && plan?.state === "running" && plan.node === "contain" && plan.waiting?.kind === "input_screen" && plan.waiting.for.groups.includes("quality") && (await rec("lot", lotD)).state === "on_hold" && plan.context.held_by === "Deviation raised",
        { minor: Boolean(await planOf(minor.id)), plan, lot: (await rec("lot", lotD)).state });
    const quinnBox = await call("quinn", "inbox.mine", { as: "quinn" });
    const olgaBox = await call("olga", "inbox.mine", { as: "olga" });
    step("…in Quality's bell, not in Production's", quinnBox.items?.some((i) => i.kind === "task" && i.link === `/f/${plan.id}`) && !olgaBox.items?.some((i) => i.link === `/f/${plan.id}`), { quinn: quinnBox.items, olga: olgaBox.items });
    const notHers = await call("olga", "flows.act", { run: plan.id, values: { action: "x", quarantined: true } });
    const empty = await call("quinn", "flows.act", { run: plan.id, values: {} });
    step("someone it is not for is refused; required fields are named", notHers.status === 403 && /This is for quality/.test(notHers.error) && empty.status === 400 && empty.fields?.action && empty.fields?.quarantined, { notHers, empty });
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const contained = await call("quinn", "flows.act", { run: plan.id, values: { action: "Lot quarantined in cage 3", quarantined: true, photo: { name: "cage.png", type: "image/png", data: PNG } } });
    plan = await planOf(major.id);
    step("Contain filled in, with a photo kept with the run: on to Await the lab, a wait to acknowledge", contained.ok && plan.node === "lab" && plan.waiting?.mode === "acknowledge" && plan.context.action === "Lot quarantined in cage 3" && plan.context.photo?.file && plan.due_at, { contained, plan });
    // Acknowledged twice at once (a double click, or two of the group): one goes on, one is told.
    const stepsBefore = (await db.query("SELECT count(*)::int AS n FROM mes.flow_steps WHERE run_id = $1", [plan.id]))[0].n;
    const twice = await Promise.all([call("quinn", "flows.act", { run: plan.id, action: "acknowledge" }), call("quinn", "flows.act", { run: plan.id, action: "acknowledge" })]);
    const stepsAfter = (await db.query("SELECT count(*)::int AS n FROM mes.flow_steps WHERE run_id = $1", [plan.id]))[0].n;
    step("a wait acted on twice at once goes on once: the other is told someone has just acted",
        twice.filter((r) => r.ok).length === 1 && twice.filter((r) => r.status === 409 && r.code === "flow.not-waiting").length === 1 && stepsAfter === stepsBefore + 1, { twice, stepsBefore, stepsAfter });
    const chose = await call("dana", "flows.act", { run: plan.id, choice: "Machine" });
    plan = await planOf(major.id);
    const back = await call("olga", "flows.act", { run: plan.id, action: "retry" });
    plan = await planOf(major.id);
    step("the lab acknowledged; Engineering chooses Machine; Production retries: back at Await the lab", chose.ok && back.ok && plan.node === "lab", { chose, back, plan });
    await call("quinn", "flows.act", { run: plan.id, action: "acknowledge" });
    await call("dana", "flows.act", { run: plan.id, choice: "Material" });
    const rejected = await call("quinn", "flows.act", { run: plan.id, values: { decision: "reject" } });
    plan = await planOf(major.id);
    const way = (await db.query("SELECT node FROM mes.flow_steps WHERE run_id = $1 ORDER BY seq", [plan.id])).map((w) => w.node).join();
    const task = await call("quinn", "flows.task", { run: plan.id, as: "quinn" });
    const photo = await call("quinn", "flows.file", { id: plan.context.photo.file });
    const acts = await db.query("SELECT actor FROM mes.audit_log WHERE record_id = $1 AND action = 'act:deviation_response' ORDER BY seq", [plan.id]);
    step("Material, then rejected: the plan ends Rejected; its way, its photo and every act audited, by whom",
        rejected.ok && plan.state === "ended" && plan.outcome === "rejected" && way === "start,contain,lab,cause,fix,lab,cause,disposition,decide,rejected" && photo.type === "image/png" && photo.data === PNG && task.files?.length === 1 && acts.map((a) => a.actor).join() === "quinn,quinn,dana,olga,quinn,dana,quinn",
        { rejected, way, task: task && { state: task.state, files: task.files }, acts });
    // Its map (§32.7): the template without its scripts and conditions, its way on it.
    const walk = flowWalk(task.map ?? {}, task.steps ?? []);
    const retryAt = (task.map?.edges ?? []).findIndex((e) => e.retry);
    step("…its map: the template as its version draws it (no script or condition in it), its way on it: Await the lab and the cause twice, the retry wire once, nothing off its wires",
        task.map?.kind === "plan" && !JSON.stringify(task.map).includes("flow_hold_lot") && !JSON.stringify(task.map).includes("\"when\"") && walk.visits.lab === 2 && walk.visits.cause === 2 && walk.taken[retryAt] === 1 && walk.off.length === 0 && walk.visits.rejected === 1,
        { map: task.map && Object.keys(task.map.nodes), walk, retryAt });
    const onLot = await call("olga", "flows.plansOf", { object: "lot", id: lotD, as: "olga" });
    step("…shown on the lot's page, as a plan it took part in", onLot.some((p) => p.id === plan.id && p.state === "ended"), onLot);

    // A plan of its own: a wait that goes on by itself, then a sub flow handing a value back.
    const PARENT = `triage_t${tag}`;
    const CHILD = `ask_t${tag}`;
    const parentFlow = {
        name: PARENT, label: "Triage", kind: "plan", participants: { deviation: { object: "deviation", as: "subject" } },
        nodes: {
            start: { kind: "start", label: "Critical", when: { eq: [{ context: "deviation.severity" }, "critical"] } },
            settle: { kind: "wait", label: "Let it settle", message: "A moment.", seconds: 1, mode: "auto" },
            ask: { kind: "sub_flow", label: "Ask Quality", flow: CHILD, pass: { about: { context: "deviation.title" } }, returns: { answer: "answer" } },
            done: { kind: "end", label: "Triaged", outcome: "triaged" },
        },
        edges: [{ from: "start", to: "settle" }, { from: "settle", to: "ask" }, { from: "ask", to: "done" }], stewards: ["quality"],
        // Its evidence: a critical deviation raised; the wait's time passed; the sub flow answered.
        scenarios: [{
            name: "triaged",
            records: {},
            steps: [
                { as: "quinn", do: { create: "deviation", data: { title: "Smoke", severity: "critical" }, key: "dev" }, expect: { ok: true, node: { dev: "settle" } } },
                { as: "quinn", do: { act: { record: "@dev", plan: PARENT, action: "time_up" } }, expect: { ok: true, node: { dev: "ask" } } },
                { as: "quinn", do: { act: { record: "@dev", plan: CHILD, values: { answer: "keep" } } }, expect: { ok: true, node: { dev: "done" } } },
            ],
        }],
    };
    const childFlow = {
        name: CHILD, label: "Ask Quality", kind: "plan", participants: { deviation: { object: "deviation", as: "subject" } },
        nodes: { start: { kind: "start", label: "Start" }, q: { kind: "input_screen", label: "Your answer", for: { users: [], groups: ["quality"] }, fields: [{ name: "answer", label: "Answer", type: "enum", values: ["scrap", "keep"], required: true }] }, end: { kind: "end", label: "Answered" } },
        edges: [{ from: "start", to: "q" }, { from: "q", to: "end" }], stewards: ["quality"],
    };
    const { id: planChange } = await call("dana", "design.start", { flow: PARENT, label: "Triage" });
    const pc = await call("dana", "design.change", { id: planChange, as: "dana" });
    const planSaved = await call("dana", "design.save", { id: planChange, seen: pc.draft_rev, reason: "Critical deviations are triaged.", flows: { [PARENT]: parentFlow, [CHILD]: childFlow } });
    await call("dana", "design.submit", { id: planChange });
    await call("vera", "design.review", { id: planChange, decision: "pass" });
    let planState = null;
    for (let round = 0; round < 4 && planState !== "executed"; round++) for (const user of people) {
        const seen = await call(user, "design.change", { id: planChange, as: user });
        for (const department of seen.can?.approveFor ?? []) planState = (await call(user, "design.approve", { id: planChange, department, decision: "approve", meaning: "Approved" })).state ?? planState;
    }
    const critical = await call("quinn", "records.create", { object: "deviation", data: { title: `Fire ${tag}`, severity: "critical" }, key: key() });
    let triage = await planOf(critical.id, PARENT);
    const waitedAt = triage?.node;
    for (let i = 0; i < 80 && triage?.node !== "ask"; i++) { await sleep(250); triage = await planOf(critical.id, PARENT); }
    const child = await planOf(critical.id, CHILD);
    step("a plan of its own: its wait goes on by itself when the time is up, into a sub flow whose run is its child, given what it passes",
        !planSaved.problems?.length && planState === "executed" && waitedAt === "settle" && triage.node === "ask" && triage.waiting?.kind === "sub_flow" && child?.parent_id === triage.id && child.node === "q" && child.context.about === `Fire ${tag}`,
        { problems: planSaved.problems, planState, waitedAt, triage, child });
    const answered = await call("quinn", "flows.act", { run: child.id, values: { answer: "keep" } });
    triage = await planOf(critical.id, PARENT);
    step("…the sub flow answered: it ends, and its parent takes the answer back and ends too", answered.ok && triage.state === "ended" && triage.outcome === "triaged" && triage.context.answer === "keep" && (await planOf(critical.id, CHILD)).state === "ended", { answered, triage });

    // Sub flows never run in a circle (§32.5a). In the designer: the child made to run its parent is refused, naming the way round.
    const approveAll = async (id) => {
        let state = null;
        for (let round = 0; round < 4 && state !== "executed"; round++) for (const user of people) {
            const seen = await call(user, "design.change", { id, as: user });
            for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
        }
        return state;
    };
    const withSub = (flow, id, sub) => ({ ...flow, nodes: { ...flow.nodes, [id]: { kind: "sub_flow", label: `Run ${sub}`, flow: sub } }, edges: [...flow.edges.filter((e) => !(e.from === "q" && e.to === "end")), { from: "q", to: id }, { from: id, to: "end" }] });
    const { id: loopChange } = await call("dana", "design.start", { flow: CHILD });
    const lc = await call("dana", "design.change", { id: loopChange, as: "dana" });
    const looped = await call("dana", "design.save", { id: loopChange, seen: lc.draft_rev, reason: "Ask, then triage again.", flows: { [CHILD]: withSub(childFlow, "again", PARENT) } });
    await call("dana", "design.withdraw", { id: loopChange });
    step("a sub flow that leads back to its own template, through another, is refused in the designer, naming the way round",
        looped.problems?.some((p) => new RegExp(`${CHILD} → ${PARENT} → ${CHILD} runs ${CHILD} again, without end`).test(p.message)), looped.problems);

    // At run time: two changes, each sound when submitted, close a circle once both are live (Ask runs Q; Q runs Triage).
    const Q = `q_t${tag}`;
    const qFlow = { name: Q, label: "Second opinion", kind: "plan", participants: { deviation: { object: "deviation", as: "subject" } }, nodes: { start: { kind: "start", label: "Start" }, end: { kind: "end", label: "Done" } }, edges: [{ from: "start", to: "end" }], stewards: ["quality"] };
    const { id: qChange } = await call("dana", "design.start", { flow: Q, label: "Second opinion" });
    await call("dana", "design.save", { id: qChange, seen: (await call("dana", "design.change", { id: qChange, as: "dana" })).draft_rev, reason: "A second opinion.", flows: { [Q]: qFlow } });
    await call("dana", "design.submit", { id: qChange });
    await call("vera", "design.review", { id: qChange, decision: "pass" });
    const qState = await approveAll(qChange);
    const [one, two] = [await call("dana", "design.start", { flow: CHILD }), await call("dana", "design.start", { flow: Q })];
    const s1 = await call("dana", "design.save", { id: one.id, seen: (await call("dana", "design.change", { id: one.id, as: "dana" })).draft_rev, reason: "Ask, then a second opinion.", flows: { [CHILD]: withSub(childFlow, "second", Q) } });
    const s2 = await call("dana", "design.save", { id: two.id, seen: (await call("dana", "design.change", { id: two.id, as: "dana" })).draft_rev, reason: "A second opinion triages again.", flows: { [Q]: { ...qFlow, nodes: { ...qFlow.nodes, again: { kind: "sub_flow", label: "Triage again", flow: PARENT } }, edges: [{ from: "start", to: "again" }, { from: "again", to: "end" }] } } });
    for (const id of [one.id, two.id]) { await call("dana", "design.submit", { id }); await call("vera", "design.review", { id, decision: "pass" }); }
    const [st1, st2] = [await approveAll(one.id), await approveAll(two.id)];
    const looping = await call("quinn", "records.create", { object: "deviation", data: { title: `Loop ${tag}`, severity: "critical" }, key: key() });
    let askRun = null;
    for (let i = 0; i < 80 && askRun?.node !== "q"; i++) { await sleep(250); askRun = await planOf(looping.id, CHILD); }
    await call("quinn", "flows.act", { run: askRun.id, values: { answer: "keep" } });
    const qRun = await planOf(looping.id, Q);
    const triages = (await db.query("SELECT count(*)::int AS n FROM mes.flow_runs WHERE subject_id = $1 AND flow = $2", [looping.id, PARENT]))[0].n;
    // Two changes each sound alone, a circle together: the second is checked again against what is live
    // at its last signature (§5.3), so it does not go live, and the plan runs on without a circle. (A
    // circle that reached run time all the same stops there, saying so: flows.js sub-flow depth.)
    const twoNow = await call("dana", "design.change", { id: two.id, as: "dana" });
    step("…and two changes each sound alone that would make one together: the second fails at its last signature, saying what it relies on changed, and no second triage starts",
        qState === "executed" && !s1.problems?.length && !s2.problems?.length && st1 === "executed" && st2 === "failed" && twoNow.state === "failed" && qRun?.state !== "stopped" && triages === 1,
        { qState, s1: s1.problems, s2: s2.problems, st1, st2, two: twoNow.state, qRun: qRun && { state: qRun.state, reason: qRun.reason }, triages });

    // Once per record, unless it sets off again; and on a date (§32.5a). An object of checks that opts
    // in as a plan's subject, with a date; a plan that sets off again on each open check, and one due on
    // its date.
    const triagedAgain = await call("quinn", "records.update", { object: "deviation", id: critical.id, rowVersion: Number((await db.query("SELECT row_version FROM mes.records WHERE id = $1", [critical.id]))[0].row_version), data: { title: `Fire ${tag}, written again` }, key: key() });
    const triageRuns = (await db.query("SELECT count(*)::int AS n FROM mes.flow_runs WHERE subject_id = $1 AND flow = $2", [critical.id, PARENT]))[0].n;
    step("a plan sets off once per record: written again after its run ended, the critical deviation sets off no second triage", triagedAgain.id && triageRuns === 1, { triagedAgain, triageRuns });
    const CHK = `chk_t${tag}`;
    const AGAIN = `recheck_t${tag}`;
    const DUE = `due_t${tag}`;
    const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const { id: chkChange } = await call("dana", "design.start", { object: CHK, label: "Checks" });
    const chkDef = { ...(await call("dana", "design.change", { id: chkChange, as: "dana" })).content.definitions[CHK] };
    Object.assign(chkDef, {
        titleField: "name", area: "Quality",
        fields: { name: { label: "Name", type: "string", required: true }, due_on: { label: "Due on", type: "date" } },
        states: { initial: "open", list: ["open", "closed"], transitions: [{ action: "close", label: "Close", from: ["open"], to: "closed" }] },
        policies: [{ id: "chk-all", roles: ["user"], record: { read: true, create: true }, fields: { "*": "write" }, actions: { close: "allow" } }],
        list: { columns: ["name", "due_on"] }, form: { sections: [{ label: "Check", fields: ["name", "due_on"] }] },
        stewards: { object: ["quality"] }, flow: { as: ["subject"] },
    });
    const note = (label) => ({ kind: "input_screen", label, for: { users: [], groups: ["quality"] }, fields: [{ name: "note", label: "Note", type: "string", required: true }] });
    const againFlow = {
        name: AGAIN, label: "Recheck", kind: "plan", participants: { chk: { object: CHK, as: "subject" } },
        nodes: { start: { kind: "start", label: "Open", when: { eq: [{ context: "chk.state" }, "open"] }, again: true }, q: note("Look at it"), end: { kind: "end", label: "Looked at" } },
        edges: [{ from: "start", to: "q" }, { from: "q", to: "end" }], stewards: ["quality"],
        scenarios: [{ name: "looked at", records: {}, steps: [
            { as: "quinn", do: { create: CHK, data: { name: "One" }, key: "chk" }, expect: { ok: true, node: { chk: "q" } } },
            { as: "quinn", do: { act: { record: "@chk", plan: AGAIN, values: { note: "fine" } } }, expect: { ok: true, node: { chk: "end" } } },
        ] }],
    };
    // Once done, its script makes the follow-up check, as the plan (its roles let it create checks).
    const FOLLOW = `follow_t${tag}`;
    const followScript = `// Done: a follow-up check in a week, made as the plan.
export default function ${FOLLOW}(ctx) {
  ctx.writes.push({ create: "${CHK}", data: { name: "Follow-up of " + ctx.context.chk.name } });
  return ctx;
}
`;
    const followTests = [{ name: "makes the follow-up", run: { event: { kind: "enter", node: "end" }, context: { chk: { name: "X" } }, writes: [] }, expect: { output: { writes: [{ create: CHK, data: { name: "Follow-up of X" } }] } } }];
    const dueFlow = {
        name: DUE, label: "Due check", kind: "plan", participants: { chk: { object: CHK, as: "subject" } },
        nodes: { start: { kind: "start", label: "Due", due: "due_on", again: true }, q: note("Do the check"), end: { kind: "end", label: "Done", onEnter: FOLLOW } },
        edges: [{ from: "start", to: "q" }, { from: "q", to: "end" }], stewards: ["quality"], roles: { [CHK]: ["user"] },
        scenarios: [{ name: "due", records: {}, steps: [{ as: "quinn", do: { create: CHK, data: { name: "Late", due_on: "2020-01-01" }, key: "chk" }, expect: { ok: true, node: { chk: "q" } } }] }],
    };
    const wrongDue = await call("dana", "design.check", { definitions: { [CHK]: chkDef }, flows: { [DUE]: { ...dueFlow, nodes: { ...dueFlow.nodes, start: { ...dueFlow.nodes.start, due: "name" } } } } });
    step("a due date that is not a date field of the subject is named, with the date fields it has", wrongDue.problems?.some((p) => p.path === `flows.${DUE}.nodes.start` && /due names a date field of the subject \(chk_t\d+: due_on\)/.test(p.message)), wrongDue.problems);
    const chkSaved = await call("dana", "design.save", { id: chkChange, reason: "Checks, looked at again and on their date.", definitions: { [CHK]: chkDef }, flows: { [AGAIN]: againFlow, [DUE]: dueFlow }, scripts: { [FOLLOW]: followScript }, tests: { [FOLLOW]: followTests } });
    // Quality's role on the new object first: its scenarios run as Quality.
    await db.query("INSERT INTO mes.assignments (subject_kind, subject_id, object, role) VALUES ('group', 'quality', $1, 'user')", [CHK]);
    await call("dana", "design.submit", { id: chkChange });
    await call("vera", "design.review", { id: chkChange, decision: "pass" });
    const chkState = await approveAll(chkChange);
    const runsOf = async (id, flowName) => db.query("SELECT * FROM mes.flow_runs WHERE subject_id = $1 AND flow = $2 ORDER BY started_at", [id, flowName]);
    const rowVersion = async (id) => Number((await db.query("SELECT row_version FROM mes.records WHERE id = $1", [id]))[0].row_version);
    const chk1 = await call("quinn", "records.create", { object: CHK, data: { name: `Tomorrow ${tag}`, due_on: day(1) }, key: key() });
    await call("quinn", "records.update", { object: CHK, id: chk1.id, rowVersion: await rowVersion(chk1.id), data: { name: `Tomorrow ${tag}, renamed` }, key: key() });
    const whileRunning = await runsOf(chk1.id, AGAIN);
    step("a plan that sets off again: one run while it runs, however often its record is written", !chkSaved.problems?.length && chkState === "executed" && whileRunning.length === 1 && whileRunning[0].node === "q", { problems: chkSaved.problems, chkState, runs: whileRunning.map((r) => [r.state, r.node]) });
    await call("quinn", "flows.act", { run: whileRunning[0].id, values: { note: "fine" } });
    await call("quinn", "records.update", { object: CHK, id: chk1.id, rowVersion: await rowVersion(chk1.id), data: { name: `Tomorrow ${tag}, again` }, key: key() });
    const afterEnd = await runsOf(chk1.id, AGAIN);
    step("…once it has ended, the next write sets it off again", afterEnd.length === 2 && afterEnd[0].state === "ended" && afterEnd[1].state === "running", afterEnd.map((r) => [r.state, r.node]));
    const notYet = await runsOf(chk1.id, DUE);
    const chk2 = await call("quinn", "records.create", { object: CHK, data: { name: `Yesterday ${tag}`, due_on: day(-1) }, key: key() });
    const onWrite = await runsOf(chk2.id, DUE);
    step("a plan due on a date: not before it (due tomorrow), at once on a write once it has arrived (due yesterday)", notYet.length === 0 && onWrite.length === 1 && onWrite[0].node === "q", { notYet: notYet.length, onWrite: onWrite.map((r) => [r.state, r.node]) });
    const doneCheck = await call("quinn", "flows.act", { run: onWrite[0]?.id, values: { note: "done" } });
    const follow = await db.query("SELECT data, created_by FROM mes.records WHERE object = $1 AND data->>'name' = $2", [CHK, `Follow-up of Yesterday ${tag}`]);
    step("…done, its script makes a record of its own (the follow-up check), as the plan, through the record services, once", doneCheck.ok !== false && follow.length === 1 && follow[0].created_by === `flow:${DUE}`, { doneCheck, follow });
    // The date arrives with no write: an instance's scheduler sets it off (time passed, as the test
    // moves the date; a first tick checks due dates at once).
    await db.query("UPDATE mes.records SET data = data || jsonb_build_object('due_on', $2::text) WHERE id = $1", [chk1.id, day(0)]);
    const clockApp = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 200 });
    await clockApp.listen({ port: 0 });
    let byClock = [];
    for (let i = 0; i < 100 && !byClock.length; i++) { await sleep(200); byClock = await runsOf(chk1.id, DUE); }
    await clockApp.close();
    const [firstStep] = byClock.length ? await db.query("SELECT via, by FROM mes.flow_steps WHERE run_id = $1 ORDER BY seq LIMIT 1", [byClock[0].id]) : [];
    step("…and when the date arrives with no write, the scheduler sets it off, saying so", byClock.length === 1 && byClock[0].node === "q" && firstStep?.via === "due_on arrived", { runs: byClock.map((r) => [r.state, r.node]), firstStep });

    // ---- 9. the AI: read, check, lay out, explain ----
    const { createTokens } = await import("../server/ai-api.js");
    const issued = await createTokens(db).issue("dana", { name: "flows test", agent: "test agent" });
    const ai = async (method, path, body) => {
        const res = await fetch(`${mes}/ai/v1${path}`, { method, headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json", "x-ai-agent": "test agent" }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
    };
    const contractRead = await ai("GET", "/contract");
    const live = await ai("GET", `/flows/${FLOW}`);
    const checked = await ai("POST", "/flows/check", { name: FLOW, flow: { ...flow, participants: { ...flow.participants, wo: { object: "work_order", as: "reference", from: "lot.work_order" } }, nodes: { ...flow.nodes, lost: { kind: "end", label: "Lost" } } } });
    const laid = await ai("POST", "/flows/layout", { flow: { ...flow, layout: {} } });
    const told = await ai("POST", "/flows/explain", { name: FLOW });
    // Tried on a draft being designed: a change of the live template, as the Copilot would.
    const { id: againId } = await call("dana", "design.start", { flow: FLOW });
    const aiTried = await ai("POST", "/scenarios/try", { id: againId, flow: FLOW, scenario: flow.scenarios[0] });
    step("the AI reads the template contract and a live template, checks one (a node no way leads to, by its node; the work order to opt in, as missing), lays one out, explains one in words, and tries a scenario in a sandbox (the node it reaches, by its label)",
        /step field/.test(contractRead.body.flows?.optIn ?? "") && /manual_decision/.test(contractRead.body.flows?.nodes ?? "") && live.body.flow?.name === FLOW
        && checked.body.problems?.some((p) => p.path === `flows.${FLOW}.nodes.lost`) && checked.body.missing?.some((m) => /work_order takes no part as a reference/.test(m))
        && laid.body.layout?.start?.x === 40 && laid.body.layout.press.x > laid.body.layout.inspect.x
        && aiTried.body?.passed === true && aiTried.body.steps?.[0]?.nodes?.lot?.[FLOW]?.node === "press" && aiTried.body.steps[0].nodes.lot[FLOW].label === "Press"
        && /Start: the start, for runs where lot.item is/.test(told.body.words) && /Held if lot.scrap_qty > max_scrap/.test(told.body.words) && /on entering, hold_lot_t/.test(told.body.words),
        { contract: Boolean(contractRead.body.flows), live: live.status, checked: checked.body, layout: laid.body, words: told.body, tried: aiTried.body });

    // ---- 10. a suite's node kind ----
    // ---- routes inside routes (§32.14) ----
    // A sub route (Rework: Strip, Redo) drawn once, run by a route (Prep, then Rework, then Pack). The lot
    // goes through the sub route's steps and comes back to the route's next.
    const ITEM2 = `SUBR-${tag}`;
    const MAIN = `main_route_t${tag}`;
    const SUB = `rework_route_t${tag}`;
    const subRoute = {
        name: SUB, label: "Rework", kind: "route", asSub: true, description: "Strip, then redo.",
        participants: { lot: { object: "lot", as: "traveler" } }, context: { verdict: "reworked" },
        nodes: { start: { kind: "start", label: "Start" }, strip: { kind: "sequence", label: "Strip", offers: [CHECK, "move_out"], leaves: [CHECK] }, redo: { kind: "sequence", label: "Redo", offers: [CHECK], leaves: [CHECK] }, back: { kind: "end", label: "Reworked", outcome: "reworked" } },
        edges: [{ from: "start", to: "strip" }, { from: "strip", to: "redo" }, { from: "redo", to: "back" }],
        layout: { start: { x: 40, y: 60 }, strip: { x: 220, y: 60 }, redo: { x: 400, y: 60 }, back: { x: 580, y: 60 } },
        roles: { lot: ["router"], work_order: ["viewer"] }, stewards: ["production"],
    };
    const mainRoute = {
        name: MAIN, label: "Main route", kind: "route", description: "Prep, the rework sub route, then pack.",
        participants: { lot: { object: "lot", as: "traveler" } }, context: {},
        nodes: {
            start: { kind: "start", label: "Start", when: { eq: [{ context: "lot.item" }, ITEM2] } },
            prep: { kind: "sequence", label: "Prep", offers: [INSPECT], leaves: [INSPECT] },
            rework: { kind: "sub_flow", label: "Rework it", flow: SUB, returns: { verdict: "verdict" } },
            pack: { kind: "sequence", label: "Pack", offers: [CHECK, "move_in"], leaves: [CHECK] },
            done: { kind: "end", label: "Done", outcome: "done" },
        },
        edges: [{ from: "start", to: "prep" }, { from: "prep", to: "rework" }, { from: "rework", to: "pack" }, { from: "pack", to: "done" }],
        layout: { start: { x: 40, y: 60 }, prep: { x: 220, y: 60 }, rework: { x: 400, y: 60 }, pack: { x: 580, y: 60 }, done: { x: 760, y: 60 } },
        roles: { lot: ["router"], work_order: ["viewer"] }, stewards: ["production"],
        scenarios: [{
            name: "Prep takes a lot into the rework sub route",
            records: { wo: { object: "work_order", where: { wo_no: ["WO-1002"] } }, lot: { object: "lot", data: { lot_no: `SR-${tag}`, item: ITEM2, work_order: "@wo", qty: 10, uom: "kg", station: "prep" } } },
            steps: [{ as: "olga", do: { transaction: INSPECT, input: { lot: "@lot" } }, expect: { ok: true, node: { lot: "rework" } } }],
        }],
    };
    const subChange = await call("dana", "design.start", { flow: MAIN, label: "Main route" });
    const wrongKind = await call("dana", "design.check", { flows: { [MAIN]: { ...mainRoute, nodes: { ...mainRoute.nodes, rework: { ...mainRoute.nodes.rework, flow: Q } } }, [SUB]: subRoute } });
    const wrongSub = await call("dana", "design.check", { flows: {
        [MAIN]: mainRoute,
        [SUB]: { ...subRoute, nodes: { ...subRoute.nodes, again: { kind: "sub_flow", label: "Again", flow: MAIN } }, edges: [...subRoute.edges.filter((e) => e.from !== "redo"), { from: "redo", to: "again" }, { from: "again", to: "back" }] },
    } });
    const wrongSubWords = [...(wrongKind.problems ?? []), ...(wrongSub.problems ?? [])].map((p) => p.message).join("\n");
    const planSub = await call("dana", "design.check", { flows: { [SUB]: { ...subRoute, kind: "plan", asSub: true } } });
    step("a route's sub flow runs a route: one that names a plan is refused, as is a circle of routes; only a route is marked as running inside another",
        /is a plan: a route runs another route/.test(wrongSubWords) && /runs .* again, without end/.test(wrongSubWords) && /asSub is true or false, on a route/.test(JSON.stringify(planSub.problems ?? planSub)), { kind: wrongKind.problems ?? wrongKind, wrong: wrongSub.problems ?? wrongSub, plan: planSub.problems ?? planSub });
    const subSaved = await call("dana", "design.save", { id: subChange.id, reason: "A rework loop drawn once, run by the routes that need it.", flows: { [MAIN]: mainRoute, [SUB]: subRoute } });
    const subSubmitted = await call("dana", "design.submit", { id: subChange.id });
    const subFit = (await call("dana", "design.change", { id: subChange.id, as: "dana" })).fitness;
    const subRuns = (subFit?.checks ?? []).find((c) => c.id === "scenarios")?.runs ?? [];
    await call("vera", "design.review", { id: subChange.id, decision: "pass" });
    let subState = null;
    for (let round = 0; round < 4 && subState !== "executed"; round++) {
        for (const user of people) {
            const seen = await call(user, "design.change", { id: subChange.id, as: user });
            for (const department of seen.can?.approveFor ?? []) subState = (await call(user, "design.approve", { id: subChange.id, department, decision: "approve", meaning: "Approved" })).state ?? subState;
        }
    }
    step("the route and its sub route are drafted in one change; the sub route needs no scenario of its own (it is tried through the route that runs it, whose scenario takes a lot to the sub flow that runs it); approved, both are live",
        subSaved.problems?.length === 0 && subSubmitted.ok && subRuns.filter((r) => r.flow === MAIN).length === 1 && subRuns.every((r) => r.passed) && !subRuns.some((r) => r.flow === SUB) && subState === "executed",
        { problems: subSaved.problems ?? subSaved, submitted: subSubmitted, runs: subRuns, state: subState, fit: subSubmitted.ok ? null : JSON.stringify(subFit ?? {}).slice(0, 1500) });
    const routeRuns = (lotId) => db.query("SELECT id, flow, kind, state, node, outcome, parent_id, context, waiting FROM mes.flow_runs WHERE subject_id = $1 AND kind = 'route' ORDER BY started_at, (parent_id IS NOT NULL)", [lotId]);
    const [pressM] = await db.query("SELECT id FROM mes.records WHERE object = 'machine' AND archived_at IS NULL ORDER BY created_at LIMIT 1");
    const newLot2 = async (no) => (await call("sam", "records.create", { object: "lot", data: { lot_no: no, item: ITEM2, work_order: wo.id, qty: 10, uom: "kg" }, key: key() })).id;
    const lotS = await newLot2(`SRA-${tag}`);
    const atPrep = await routeRuns(lotS);
    step("a lot starts the route, not the sub route by itself: one run, at Prep", atPrep.length === 1 && atPrep[0].flow === MAIN && atPrep[0].node === "prep" && (await rec("lot", lotS)).data.station === "prep", atPrep);
    const seenBefore = await runOf(lotS);
    step("its page has the route's sub flow open to a click before the lot gets there: the node names the sub route, whose map comes as published, nothing walked on it, and the way holds the one run",
        seenBefore.map?.nodes?.rework?.flow === SUB && seenBefore.routes?.length === 1 && seenBefore.routes[0].id === seenBefore.id && seenBefore.routes[0].parent === null
        && Object.keys(seenBefore.subMaps?.[SUB]?.nodes ?? {}).includes("strip") && !JSON.stringify(seenBefore.subMaps).includes("verdict"),
        { map: seenBefore.map?.nodes?.rework, routes: seenBefore.routes, subMaps: seenBefore.subMaps });
    // Move out is offered only inside the sub route (at Strip): on the route's own steps it is refused,
    // the sub route not entered yet (the whole way counts, §32.14).
    // (Its machine set as a fixture, the field being a transaction's to write: what is tried is the gate.)
    const lotG = await newLot2(`SRG-${tag}`);
    await db.query("UPDATE mes.records SET data = data || jsonb_build_object('machine', $2::text) WHERE id = $1", [lotG, pressM.id]);
    const outEarly = await run("move_out", { lot: lotG });
    step("a transaction only the sub route offers is refused on the route's own step, before the lot enters the sub route",
        outEarly.status >= 400 && /at Prep \(Main route\), where Move out is not done/.test(outEarly.error ?? ""), outEarly);
    const intoSub = await run(INSPECT, { lot: lotS });
    const inSub = await routeRuns(lotS);
    const seenIn = await runOf(lotS);
    step("leaving Prep, it enters the sub route: the route waits at its sub flow, the sub route's run is its child, and the lot's step is the sub route's first (Strip); its page says where, and inside which route",
        !intoSub.error && inSub.length === 2 && inSub[0].node === "rework" && inSub[0].waiting?.kind === "sub_flow" && inSub[1].flow === SUB && inSub[1].parent_id === inSub[0].id && inSub[1].node === "strip" && (await rec("lot", lotS)).data.station === "strip"
        && seenIn.flow === SUB && seenIn.nodeLabel === "Strip" && seenIn.inside?.[0]?.label === "Main route" && seenIn.inside[0].nodeLabel === "Rework it" && seenIn.routed.includes("move_in"),
        { intoSub, inSub, seenIn: { flow: seenIn.flow, node: seenIn.nodeLabel, inside: seenIn.inside, routed: seenIn.routed } });
    const notHere = await run("move_in", { lot: lotS, machine: pressM.id });
    step("in the sub route, its step decides: a transaction the route offers only at Pack is not done at Strip", Boolean(notHere.error) && /is at Strip \(Rework\), where .* is not done/.test(notHere.error), notHere);
    const toRedo = await run(CHECK, { lot: lotS, machine: pressM.id });
    const atRedo = await routeRuns(lotS);
    const outOfSub = await run(CHECK, { lot: lotS, machine: pressM.id });
    const afterSub = await routeRuns(lotS);
    step("through the sub route's steps and out at its end: the sub route's run ends (reworked), the route takes back what it returns and goes on to its next step (Pack)",
        !toRedo.error && atRedo[1].node === "redo" && !outOfSub.error && afterSub[1].state === "ended" && afterSub[1].outcome === "reworked" && afterSub[0].state === "running" && afterSub[0].node === "pack" && afterSub[0].waiting === null && afterSub[0].context?.verdict === "reworked" && (await rec("lot", lotS)).data.station === "pack",
        { toRedo, outOfSub, afterSub });
    const finish = await run(CHECK, { lot: lotS, machine: pressM.id });
    const subDone = await routeRuns(lotS);
    step("and on to the route's end", !finish.error && subDone[0].state === "ended" && subDone[0].outcome === "done", { finish, subDone });
    const seenDone = await runOf(lotS);
    const subRun = seenDone.routes?.find((r) => r.flow === SUB);
    step("ended, its page still opens the sub route from its node: the route at the top, the sub route's run under it with the node that ran it (Rework it), its own way, map and outcome",
        seenDone.flow === MAIN && seenDone.routes?.length === 2 && seenDone.routes[0].id === seenDone.id && subRun?.parent === seenDone.id && subRun.at === "rework"
        && subRun.state === "ended" && subRun.outcome === "reworked" && subRun.steps.map((x) => x.node).join(",").startsWith("start,strip") && Boolean(subRun.map?.nodes?.strip),
        { routes: seenDone.routes?.map(({ map, ...r }) => r) });
    // Taken out of the sub route by hand: its step set to a step of the route it runs inside.
    const lotT = await newLot2(`SRB-${tag}`);
    await run(INSPECT, { lot: lotT });
    const lotTRow = await call("olga", "records.get", { object: "lot", id: lotT, as: "olga" });
    const takenOut = await call("olga", "records.update", { object: "lot", id: lotT, rowVersion: lotTRow.row_version, data: { station: "pack" }, key: key() });
    const carriedRuns = await routeRuns(lotT);
    const carriedWay = await db.query("SELECT node, via FROM mes.flow_steps WHERE run_id = $1 ORDER BY seq DESC LIMIT 1", [carriedRuns[0].id]);
    step("a lot carried out of the sub route (its step set to Pack, a step of the route it runs inside): the sub route's run ends there, saying so, and the route follows to Pack, off its wires, on the record",
        !takenOut.error && carriedRuns[1].state === "ended" && /left for Pack \(Main route\)/.test(carriedRuns[1].outcome) && carriedRuns[0].state === "running" && carriedRuns[0].node === "pack" && /off route/.test(carriedWay[0]?.via ?? ""),
        { carried: takenOut.error ?? "ok", carriedRuns, carriedWay });

    suiteApp = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, suites });
    const suiteCall = callAt((await suiteApp.listen({ port: 0 })).url);
    const greet = (greeting) => ({ ...flow, nodes: { ...flow.nodes, oven: { kind: "hello.station", label: "Greet", offers: flow.nodes.oven.offers, leaves: ["move_out"], settings: { greeting } } } });
    const home = await suiteCall("dana", "design.home", { as: "dana" });
    const good = await suiteCall("dana", "design.check", { flows: { [FLOW]: greet("Hello") } });
    const lower = await suiteCall("dana", "design.check", { flows: { [FLOW]: greet("hello") } });
    const gone = await call("dana", "design.check", { flows: { [FLOW]: greet("Hello") } });
    step("with the hello suite, its greeting station is offered and checked by the suite; without it, the node needs the hello suite",
        home.flowNodes?.["hello.station"]?.extends === "sequence" && !good.problems?.length && /a greeting starts with a capital letter/.test(JSON.stringify(lower.problems)) && /needs the hello suite/.test(JSON.stringify(gone.problems)),
        { kinds: home.flowNodes, good: good.problems, lower: lower.problems, gone: gone.problems });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await suiteApp?.close();
    await app?.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
