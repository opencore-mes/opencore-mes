// The reference adapter of equipment-adapter 1.0: the smallest adapter that passes the kit, over a tool
// that lives in the same process (a MemoryTool, found by its port). It shows each part of the contract
// with nothing of a real protocol in the way; an adapter for a real one does the same over its wire.
//
// Its mapping: variables, events, alarms and commands keyed by the tool's own names for them (letters,
// digits, _ and .); a command { name: the tool's, params: { Parameter: the tool's name } }.

const KEY = /^[A-Za-z0-9_.]{1,64}$/;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const map = (v) => (isPlain(v) ? v : {});
const tools = new Map(); // port → MemoryTool

// The interface's conversion: an expression over `value` (the tool's).
function convert(expr, value) {
    if (typeof expr === "number") return expr;
    if (!isPlain(expr)) return value;
    if (Object.hasOwn(expr, "value")) return value;
    const [op] = Object.keys(expr);
    const [x, y] = expr[op].map((e) => convert(e, value));
    return { add: x + y, sub: x - y, mul: x * y, div: x / y, round: Math.round(x * 10 ** y) / 10 ** y }[op];
}
const asToolType = (v, raw) => (raw === undefined || raw === null ? null : isPlain(v.values) ? v.values[String(raw)] ?? String(raw) : v.convert !== undefined ? convert(v.convert, Number(raw)) : raw);

// A tool in this process: what it holds, and what it does when told.
export class MemoryTool {
    constructor(port) { this.port = port; this.values = {}; this.listeners = new Set(); this.up = true; this.received = []; this.refusals = new Map(); this.seq = 0; tools.set(port, this); }
    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    say(message) { for (const fn of [...this.listeners]) fn(message); }
    set(name, value) { this.values[name] = value; }
    raise(event, values = {}) { Object.assign(this.values, values); this.last = { type: "event", event, id: ++this.seq, values: { ...this.values } }; if (this.up) this.say(this.last); }
    alarm(name, set) { if (this.up) this.say({ type: "alarm", alarm: name, set }); }
    replay() { if (this.last && this.up) this.say(this.last); }
    drop() { this.up = false; this.say({ type: "down" }); }
    restore() { this.up = true; this.say({ type: "up" }); }
    command(name, params) {
        if (!this.up) throw new Error("not connected");
        const words = this.refusals.get(name);
        if (words !== undefined) { this.refusals.delete(name); return { ok: false, words }; }
        this.received.push({ name, params });
        return { ok: true };
    }
    stop() { tools.delete(this.port); this.listeners.clear(); }
}

export default {
    name: "memory",
    label: "In-memory reference tool",
    contract: "1.0",
    serves: ["command"],
    check(mapping) {
        const out = [];
        for (const kind of ["variables", "events", "alarms", "commands"]) for (const id of Object.keys(map(mapping?.[kind]))) if (!KEY.test(id)) out.push(`${kind} "${id}": the tool's name is letters, digits, _ and . only.`);
        for (const [name, c] of Object.entries(map(mapping?.commands))) if (!isPlain(c) || typeof c.name !== "string" || !c.name) out.push(`command ${name}: give the tool's name for it (name).`);
        if (mapping?.recipes) out.push("recipes: the in-memory tool keeps no recipes.");
        return out;
    },
    connect(machine, { emit }) {
        const m = machine.mapping;
        let stopped = false;
        let off = () => {};
        let communicating = false;
        const state = (up, detail) => { if (!stopped && communicating !== up) { communicating = up; emit({ kind: "state", communicating: up, detail }); } };
        const variableOf = (name) => Object.entries(map(m.variables)).find(([, v]) => v.as === name);
        const attach = () => {
            const tool = tools.get(Number(machine.address.port));
            if (!tool) return setTimeout(() => !stopped && attach(), 200);
            off = tool.on((msg) => {
                if (stopped) return;
                if (msg.type === "down") return state(false, "the tool went away");
                if (msg.type === "up") return state(true, "the tool is back");
                if (msg.type === "event") {
                    const e = map(m.events)[msg.event];
                    if (!e) return emit({ kind: "event", code: msg.event, name: `event ${msg.event}`, values: {}, unknown: true, id: msg.id });
                    const values = {};
                    for (const name of e.report ?? []) { const v = variableOf(name); if (v) values[name] = asToolType(v[1], msg.values[v[0]]); }
                    emit({ kind: "event", code: msg.event, name: e.as ?? e.name, label: e.name, values, id: msg.id });
                }
                if (msg.type === "alarm") { const a = map(m.alarms)[msg.alarm]; emit({ kind: "alarm", code: msg.alarm, name: a?.name ?? `alarm ${msg.alarm}`, set: msg.set, ...(a ? {} : { unknown: true }) }); }
            });
            state(tool.up, tool.up ? "connected to the in-memory tool" : "the tool is not up");
            this_.tool = tool;
        };
        const this_ = { tool: null };
        attach();
        const ready = () => { if (!communicating || !this_.tool) throw Object.assign(new Error(`${machine.title} is not communicating: the in-memory tool is not up.`), { notCommunicating: true }); return this_.tool; };
        return {
            async status(names) {
                const tool = ready();
                const values = {};
                for (const name of names) { const v = variableOf(name); if (v) values[name] = asToolType(v[1], tool.values[v[0]]); }
                return { values, at: new Date().toISOString() };
            },
            async command(name, params = {}) {
                const c = map(m.commands)[name];
                if (!c) throw new Error(`${machine.title}'s interface has no command ${name}.`);
                const tool = ready();
                const sent = Object.fromEntries(Object.entries(params).map(([k, v]) => [map(c.params)[k] ?? k, v]));
                const answer = tool.command(c.name, sent);
                if (!answer.ok) throw Object.assign(new Error(`${machine.title} refused ${name}: ${answer.words}.`), { refused: true });
                return { accepted: true };
            },
            async stop() { stopped = true; off(); },
        };
    },
};
