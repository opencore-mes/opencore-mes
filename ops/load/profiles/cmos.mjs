// The fab's CMOS route (cmos_route, with its pattern_layer sub flow, once per layer), as a copy of the fab's
// database has it: a move is one lot through one step of its route, as the crew on the open shift works it.
//   a tool step       Track in on a free tool of the step's area, by the crew's operator qualified for the area
//                     (their tool role <area>_op), then the step's leaving transaction (Track out; WAT out with a
//                     yield over every product's limit)
//   metrology         Measure at the step's target, then Metrology out, by the crew's metrology operator
//   an inspection     each wafer drawn recorded (no defect, pass), then Inspect done
//   an MRB step       the decision "release", signed by Quality
//   a lot held        released by Quality first (a future hold)
// A lot that completes is replaced by a new one (Start lot). Everything is read from the copy: the open shift,
// its crew, who is qualified for what, the routes' steps; the profile only knows the model's kinds of step.
//   TOOLS_PER_AREA  tools made for the load in each area (default the larger of 30 and half the peak rate),
//                   with a PM limit no load reaches (the PM plan's tasks are people's, not this load's)
//   LOTS            lots on the route at once (default the larger of 300 and three seconds of the peak)
//   WAFERS          wafers a lot (default 25)
export const label = "the fab's CMOS route: each step of a lot, as the open shift's crew works it";
export const names = ["track_in", "track_out", "measure", "metrology_out", "record_check", "inspect_done", "wat_out", "release_lot", "mrb_disposition", "start_lot"];

const ROUTES = ["cmos_route", "pattern_layer"];
let shift, ops, inspector, quality, nodes, products, meanings, wafers, run;
const tools = {};
// A tool a lot was tracked in on whose leaving transaction then failed: it runs that lot until it leaves.
const heldBy = new Map();
let freeLots = [];
let started = 0;
let startMs = 0;

export async function setup({ call, q, peak, run: r, inBatches }) {
    run = r;
    wafers = Number(process.env.WAFERS ?? 25);
    [shift] = await q("SELECT id, data->>'crew' AS crew FROM mes.records WHERE object = 'shift' AND state = 'open' AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1");
    if (!shift) throw new Error("No shift is open in this copy: open one in the fab first.");
    const crew = (await q("SELECT data->>'user' AS id FROM mes.records WHERE object = 'person' AND archived_at IS NULL AND data->>'crew' = $1 AND coalesce((data->>'active')::boolean, true)", [shift.crew])).map((p) => p.id);
    // Who on the crew may work which area: their tool role <area>_op.
    ops = {};
    for (const a of await q("SELECT role, subject_id FROM mes.assignments WHERE object = 'tool' AND subject_kind = 'user' AND role LIKE '%\\_op' AND subject_id = ANY($1) ORDER BY subject_id", [crew])) ops[a.role.slice(0, -3)] ??= a.subject_id;
    const bodies = Object.fromEntries((await q("SELECT name, body FROM mes.transactions WHERE status = 'published'")).map((t) => [t.name, t.body]));
    inspector = (bodies.measure?.callers?.users ?? []).find((u) => crew.includes(u));
    [quality] = (await q("SELECT user_id FROM mes.group_members WHERE group_id = 'quality' ORDER BY user_id")).map((m) => m.user_id);
    meanings = Object.fromEntries(Object.entries(bodies).filter(([, b]) => b.signature).map(([n, b]) => [n, b.signature.meaning]));
    nodes = {};
    for (const f of await q("SELECT name, body FROM mes.flows WHERE status = 'published' AND name = ANY($1)", [ROUTES])) for (const [id, n] of Object.entries(f.body.nodes)) if (n.kind === "sequence") nodes[id] = n;
    products = await q("SELECT id, (data->>'yield_limit')::numeric AS yield_limit FROM mes.records WHERE object = 'product' AND state = 'active' AND archived_at IS NULL ORDER BY id");
    if (!products.length || !inspector || !quality) throw new Error(`The copy lacks what the load needs: products ${products.length}, a metrology operator on crew ${shift.crew} (${inspector}), Quality (${quality}).`);
    // Tools for the load, in every area a step names, made as an engineer would (through the record services).
    const areas = [...new Set(Object.values(nodes).flatMap((n) => n.resource?.area ?? []))];
    const missing = areas.filter((a) => !ops[a]);
    if (missing.length) throw new Error(`Nobody on crew ${shift.crew} is qualified for ${missing.join(", ")}.`);
    const perArea = Number(process.env.TOOLS_PER_AREA ?? Math.max(30, Math.ceil(peak / 2)));
    for (const area of areas) {
        tools[area] = (await inBatches(perArea, (i) => call("dana", "records.create", { object: "tool", data: { tool_id: `LT-${run}-${area}-${i}`, name: `Load ${area} ${i}`, area, pm_limit: 1_000_000_000, wafers_since_pm: 0 } }))).map((t) => t.id);
    }
    const lots = Number(process.env.LOTS ?? Math.max(300, peak * 3));
    // A lot starts with its wafers made and its route begun: a few at a time (25 at once wait on each other for connections).
    const t0 = performance.now();
    freeLots = (await inBatches(lots, (i) => startLot(call, i), Number(process.env.START_AT_ONCE ?? 4))).filter(Boolean);
    startMs = Math.round((performance.now() - t0) / Math.max(1, freeLots.length));
    return `${freeLots.length} lots of ${wafers} wafers on cmos_route (started in ${startMs} ms each, ${process.env.START_AT_ONCE ?? 4} at a time), ${areas.length} areas × ${perArea} tools, crew ${shift.crew} (${Object.entries(ops).map(([a, u]) => `${a} ${u}`).join(", ")}; metrology ${inspector}; Quality ${quality})`;
}

async function startLot(call, i, timed = (_, fn) => fn()) {
    const out = await timed("start_lot", () => call(i % 2 ? "olga" : "sam", "transactions.run", { name: "start_lot", input: { route: "cmos_route", lot_no: `LT-${run}-${i}`, wafers, product: products[i % products.length].id, priority: "normal" } }));
    return out.records?.find((r) => r.object === "lot")?.id ?? null;
}

const yieldOk = () => Math.min(99.5, Math.max(...products.map((p) => Number(p.yield_limit))) + 5);

// → "behind" (no lot, or no tool free), or { ok, lost? }.
export async function move({ call, timed, refused }, n) {
    // Any free lot, not the next in line: lots go at their own pace, spread over the route, as in a fab (in
    // turn, they move in step and reach each step together).
    if (!freeLots.length) return "behind";
    const at = Math.floor(Math.random() * freeLots.length);
    const lot = freeLots[at];
    freeLots[at] = freeLots[freeLots.length - 1];
    freeLots.pop();
    const tx = (user, name, input) => timed(name, () => call(user, "transactions.run", { name, input, ...(meanings[name] ? { signature: { meaning: meanings[name], agree: true } } : {}) }, n));
    let tool = null, area = null, keep = false;
    try {
        let now = await call(quality, "records.get", { object: "lot", id: lot, as: quality }, n);
        if (now.state === "completed" || now.state === "scrapped") {
            const next = await startLot(call, 1e6 + started++, timed);
            if (next) freeLots.push(next);
            return { ok: true, notAMove: true };
        }
        if (now.state === "on_hold") {
            await tx(quality, "release_lot", { lot, reason: "Load test: released to go on." });
            now = await call(quality, "records.get", { object: "lot", id: lot, as: quality }, n);
        }
        const node = nodes[now.step];
        if (!node) { freeLots.push(lot); return { ok: true, notAMove: true }; }
        const offers = node.offers ?? [];
        const leave = (node.leaves ?? [])[0];
        if (offers.includes("track_in")) {
            area = node.resource?.area?.[0];
            if (now.state === "waiting") {
                tool = tools[area]?.shift();
                if (!tool) { freeLots.unshift(lot); return "behind"; }
                await tx(ops[area], "track_in", { lot, tool, shift: shift.id });
            } else tool = heldBy.get(lot) ?? null;
            keep = true;
            await tx(ops[area], leave, { lot, shift: shift.id, ...(leave === "wat_out" ? { yield_pct: yieldOk() } : {}) });
            keep = false;
            heldBy.delete(lot);
        } else if (offers.includes("measure")) {
            await tx(inspector, "measure", { lot, shift: shift.id, value: Number(node.settings?.target ?? 0) });
            await tx(inspector, "metrology_out", { lot, shift: shift.id });
        } else if (offers.includes("inspect_done")) {
            const { rows } = await call(inspector, "records.list", { object: "wafer_check", where: { lot, state: "pending" }, page: 1, as: inspector }, n);
            for (const c of rows ?? []) await tx(inspector, "record_check", { check: c.id, shift: shift.id, defect: "none", result: "pass" });
            await tx(inspector, "inspect_done", { lot, shift: shift.id });
        } else if (offers.includes("mrb_disposition")) {
            await tx(quality, "mrb_disposition", { lot, note: "Load test: released to go on.", decision: "release" });
        } else {
            freeLots.push(lot);
            return { ok: true, notAMove: true };
        }
        freeLots.push(lot);
        return { ok: true };
    } catch (error) {
        refused(error.step ?? "move", error);
        // A lot whose route has stopped goes nowhere until someone sees to it: it leaves the pool, counted.
        if (error.code === "transaction.flow" && /is stopped/.test(error.message)) return { ok: false, lost: true };
        // Else the lot goes back to be read again (its state as the server has it decides what comes next).
        freeLots.push(lot);
        return { ok: false };
    } finally {
        if (tool && keep) heldBy.set(lot, tool);
        else if (tool) tools[area].push(tool);
    }
}
