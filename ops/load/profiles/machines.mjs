// The seed's model (app/mes/db/seed.mjs): a move is one lot through one step on one machine, Move in, Track in,
// Track out, Move out, as Olga or Sam (production), on a free lot and a free machine of the pool.
export const label = "the seed's machines: Move in, Track in, Track out, Move out";
export const names = ["move_in", "track_in", "track_out", "move_out"];

const NEXT = { created: "move_in", in_process: "move_in", at_machine: "track_in", processing: "track_out", processed: "move_out" };
let freeLots = [], freeMachines = [];

export async function setup({ call, peak, run, inBatches }) {
    const machines = Number(process.env.MACHINES ?? Math.max(500, peak * 5)), lots = Number(process.env.LOTS ?? Math.max(500, peak * 5));
    const wo = await call("sam", "records.create", { object: "work_order", data: { wo_no: `LOAD-${run}`, item: "PA66-NAT-25", qty: 1e9, line: "L1" } });
    freeMachines = (await inBatches(machines, (i) => call("sam", "records.create", { object: "machine", data: { machine_id: `LM-${run}-${i}`, name: `Load ${i}`, kind: "press", capacity: 1 } }))).map((m) => m.id);
    freeLots = (await inBatches(lots, (i) => call("olga", "records.create", { object: "lot", data: { lot_no: `L-${run}-${i}`, item: "PA66-NAT-25", work_order: wo.id, qty: 100, uom: "kg" } }))).map((l) => l.id);
    return `${freeLots.length} lots, ${freeMachines.length} machines`;
}

const inputOf = (step, lot, machine) => (step === "move_in" ? { lot, machine } : step === "track_out" ? { lot, good_qty: 100, scrap_qty: 0 } : { lot });
// → "behind" (nothing free), or { ok, lost? }; each transaction timed through `timed`.
export async function move({ call, timed, refused }, n) {
    const lot = freeLots.shift(), machine = freeMachines.shift();
    if (!lot || !machine) { if (lot) freeLots.unshift(lot); if (machine) freeMachines.unshift(machine); return "behind"; }
    const user = n % 2 ? "olga" : "sam";
    let step = "move_in", tries = 0;
    while (step) {
        try {
            await timed(step, () => call(user, "transactions.run", { name: step, input: inputOf(step, lot, machine) }, n));
            step = names[names.indexOf(step) + 1];
        } catch (error) {
            refused(step, error);
            // Put right from the lot's state as the server has it, a few times; then the lot leaves the pool.
            if (++tries > 3) return { ok: false, lost: true };
            const now = await call(user, "records.get", { object: "lot", id: lot, as: user }, n).catch(() => null);
            if (!now) return { ok: false, lost: true };
            if (now.state === "in_process" && !now.machine && step !== "move_in") step = null;
            else step = NEXT[now.state] ?? null;
            if (step === "move_in" && now.machine) return { ok: false, lost: true };
        }
    }
    freeLots.push(lot); freeMachines.push(machine);
    return { ok: true };
}
