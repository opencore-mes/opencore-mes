// The reference adapter's fixture for the kit: an in-memory tool, and the kit's tool type mapped onto
// its own names. `node docs/contracts/equipment-adapter/kit.mjs docs/contracts/equipment-adapter/reference/fixture.mjs`
import adapter, { MemoryTool } from "./memory.mjs";

let next = 41000;
const mapping = {
    adapter: "memory",
    variables: {
        temp_k: { as: "Temperature", units: "K", convert: { sub: [{ value: null }, 273.15] } },
        state: { as: "State", values: { 1: "IDLE", 2: "RUNNING" } },
        lot: { as: "Lot" },
    },
    events: { begin: { name: "Begin", as: "Started", report: ["Lot"] }, end: { name: "End", as: "Ended", report: ["Lot"] } },
    alarms: { hot: { name: "Overheat" } },
    commands: { START: { name: "go", params: { Lot: "lot" } }, STOP: { name: "halt", params: {} } },
};
// The kit's names for what the tool holds and does.
const VARIABLE = { Temperature: "temp_k", State: "state", Lot: "lot" };
const EVENT = { Started: "begin", Ended: "end" };
const COMMAND = { go: "START", halt: "STOP" };

export default {
    adapter,
    async tool() {
        const port = next++;
        const t = new MemoryTool(port);
        return {
            address: { host: "memory", port },
            mapping,
            set: (name, raw) => t.set(VARIABLE[name], raw),
            raise: async (event, raw = {}) => t.raise(EVENT[event], Object.fromEntries(Object.entries(raw).map(([k, v]) => [VARIABLE[k], v]))),
            alarm: (name, set) => t.alarm(name === "Overheat" ? "hot" : name, set),
            refuse: (command, words) => t.refusals.set(Object.keys(COMMAND).find((k) => COMMAND[k] === command), words),
            commands: () => t.received.map((c) => ({ name: COMMAND[c.name], params: Object.fromEntries(Object.entries(c.params).map(([k, v]) => [Object.keys(VARIABLE).find((n) => VARIABLE[n] === k) ?? k, v])) })),
            drop: () => t.drop(),
            restore: () => t.restore(),
            replay: () => t.replay(),
            stop: async () => t.stop(),
        };
    },
    badMappings: [
        { why: "a tool's name with a space in it", mapping: { ...mapping, variables: { "temp k": { as: "Temperature" } } } },
        { why: "recipes, which it cannot serve", mapping: { ...mapping, recipes: true } },
    ],
};
