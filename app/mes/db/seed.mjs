// Seed data for the proof of concept: four objects and four transactions defined as data (no schema
// in advance), their rule scripts, users in three departments, and a few records. In the real system all of this arrives
// through change requests (DESIGN.md §5); the seed stands in for the first ones.

export const users = [
    { id: "olga", name: "Olga Ortiz" },     // operator, production
    { id: "sam", name: "Sam Lee" },         // supervisor, production
    { id: "quinn", name: "Quinn Park" },    // quality
    { id: "vera", name: "Vera Novak" },     // read-only viewer; validation reviewer of design changes
    { id: "dana", name: "Dana Reyes" },     // designer, engineering
    { id: "eli", name: "Eli Brandt" },      // reviewer, engineering's second representative
    { id: "erp", name: "ERP integration" }, // an integration user (§15.2): its roles are assigned like anyone's
    { id: "ivan", name: "Ivan Kim" },       // IT specialist
    { id: "ines", name: "Ines Ortega" },    // IT manager
    { id: "iris", name: "Iris Hale" },      // IT designer: designs everything (services with the AI too), reads every record
];

export const groups = [
    { id: "production", name: "Production", kind: "department", members: ["olga", "sam"] },
    { id: "quality", name: "Quality", kind: "department", members: ["quinn"] },
    { id: "engineering", name: "Engineering", kind: "department", members: ["dana", "eli"] },
    { id: "it", name: "IT", kind: "department", members: ["ivan", "ines", "iris"] },
];

// Who approves for a department (§5.6): [department, user, step]. IT approves in two steps, its
// specialist, then its manager; the others in one.
export const representatives = [
    ["production", "sam", 1],
    ["quality", "quinn", 1],
    ["engineering", "dana", 1],
    ["engineering", "eli", 1],   // so a change Dana authors can still be approved for Engineering
    ["it", "ivan", 1],
    ["it", "ines", 2],
];
export const stepLabels = { it: ["Specialist", "Manager"] };
// Who reads every record (§27.7): IT's designer, read only, on every object (those to come, a suite's too).
export const readers = ["user:iris"];

export const assignments = [
    ["group", "production", "lot", "operator"],
    ["user", "sam", "lot", "supervisor"],
    ["group", "quality", "lot", "quality"],
    ["user", "vera", "lot", "viewer"],
    ["group", "production", "work_order", "operator"],
    ["user", "sam", "work_order", "planner"],
    ["group", "quality", "work_order", "viewer"],
    ["user", "vera", "work_order", "viewer"],
    ["group", "production", "deviation", "reporter"],
    ["group", "quality", "deviation", "quality"],
    // The built-in Person (builtins.js): every department reads who is who; Engineering keeps what the
    // plant adds about them (People & departments keeps their names).
    ["group", "production", "person", "viewer"],
    ["group", "quality", "person", "viewer"],
    ["group", "it", "person", "viewer"],
    ["group", "engineering", "person", "editor"],
    // The built-in Desktop (§6.8): IT keeps which page each desktop opens; Engineering reads them.
    ["group", "it", "desktop", "editor"],
    ["group", "engineering", "desktop", "viewer"],
    // The built-in Report (§34): Production and Quality read the shared ones (those who query are its
    // authors: given by the platform as the object arrives, builtins.js BUILT_IN_FIRST_ROLES).
    ["group", "production", "report", "reader"],
    ["group", "quality", "report", "reader"],
    // The designer (§10.5): the pseudo-object "design" carries the design roles.
    ["user", "dana", "design", "designer"],
    ["user", "sam", "design", "reviewer"],
    ["user", "quinn", "design", "reviewer"],
    ["user", "eli", "design", "reviewer"],
    // An independent reviewer, who represents no department: a change that touches every department
    // (an integration reaching lots and ERP) still has a reviewer who is not also its only approver.
    ["user", "vera", "design", "reviewer"],
    // IT reads and approves in the designer.
    ["user", "ivan", "design", "reviewer"],
    ["user", "ines", "design", "reviewer"],
    // IT's designer: designs every kind of element (services and connections with the copilot), and
    // reviews others' changes; never IT's approver, so Ivan and Ines can still approve what Iris designs.
    ["user", "iris", "design", "designer"],
    ["user", "iris", "design", "reviewer"],
    ["user", "iris", "query", "analyst"],
    // IT administers sign-in (§8.2): password links, a lost phone's second factor, a lock lifted.
    ["user", "iris", "auth", "administrator"],
    // IT's manager answers for personal data (§27.8): the retention report, the purge run now, erasure.
    ["user", "ines", "privacy", "officer"],
    // Queries (§23): the analysts. What each sees is still what their roles on each object allow.
    ["user", "sam", "query", "analyst"],
    ["user", "quinn", "query", "analyst"],
    ["user", "dana", "query", "analyst"],
    ["user", "eli", "query", "analyst"],
    ["user", "vera", "query", "analyst"],
    ["user", "dana", "lot", "viewer"],
    ["user", "dana", "work_order", "viewer"],
    // ERP plans work orders and reads lots; a service it calls, or that runs as it, can do no more.
    ["user", "erp", "work_order", "planner"],
    ["user", "erp", "lot", "viewer"],
    // Machines (§25): operators move lots on and off them through the transactions; maintenance keeps them.
    ["group", "production", "machine", "operator"],
    ["user", "sam", "machine", "maintenance"],
    ["group", "quality", "machine", "viewer"],
    ["user", "vera", "machine", "viewer"],
    ["user", "dana", "machine", "viewer"],
];

const LINES = ["L1", "L2", "L3"];
const SCRAP_REASONS = ["setup", "dimension", "surface", "contamination", "other"];
const AT_MACHINE = ["at_machine", "processing", "processed"];

export const definitions = [
    {
        object: "work_order",
        label: "Work order",
        area: "Production",
        description: "An order to make a quantity of an item on a line.",
        titleField: "wo_no",
        fields: {
            wo_no: { label: "Work order no.", type: "string", required: true },
            item: { label: "Item", type: "string", required: true },
            qty: { label: "Quantity", type: "decimal", required: true },
            line: { label: "Line", type: "enum", values: LINES, required: true },
            due: { label: "Due", type: "date" },
        },
        states: {
            initial: "planned",
            list: ["planned", "released", "closed"],
            tones: { released: "ok", closed: "ok" },
            transitions: [
                { action: "release", label: "Release", from: ["planned"], to: "released" },
                { action: "close", label: "Close", from: ["released"], to: "closed" },
            ],
        },
        roles: ["planner", "operator", "viewer"],
        stewards: { object: ["production"] },
        policies: [
            { id: "wo-read", roles: ["planner", "operator", "viewer"], record: { read: true }, fields: { "*": "read" } },
            { id: "wo-plan", roles: ["planner"], record: { create: true }, when: { eq: [{ record: "state" }, "planned"] }, fields: { "*": "write" }, actions: { release: "allow" } },
            { id: "wo-close", roles: ["planner"], actions: { close: "allow" } },
        ],
        list: { columns: ["wo_no", "item", "qty", "line", "due"] },
        analytics: { dimensions: ["line", "item"] },
        // Excel import (§24): planners may create and update work orders, matched by number.
        transfer: { import: { create: true, update: true, key: "wo_no" } },
        form: { sections: [{ label: "Order", fields: ["wo_no", "item", "qty", "line", "due"] }] },
        rules: [
            { script: "wo_qty_positive" },
        ],
    },
    {
        object: "lot",
        label: "Lot",
        area: "Production",
        description: "A quantity of one item made under one work order, tracked from creation to use.",
        titleField: "lot_no",
        fields: {
            lot_no: { label: "Lot no.", type: "string", required: true },
            item: { label: "Item", type: "string", required: true },
            work_order: { label: "Work order", type: "ref", to: "work_order", required: true },
            qty: { label: "Quantity", type: "decimal", required: true },
            uom: { label: "Unit", type: "enum", values: ["ea", "kg", "l"], required: true },
            expiry: { label: "Expiry", type: "date", computed: true },
            disposition: { label: "Disposition", type: "enum", values: ["pending", "accept", "reject", "rework"] },
            // At a machine (§25): set by the Move in / Track out / Move out transactions only.
            machine: { label: "Machine", type: "ref", to: "machine" },
            scrap_qty: { label: "Scrap", type: "decimal" },
            scrap_reason: { label: "Scrap reason", type: "enum", values: SCRAP_REASONS },
            // Its step on a route (§32.3): marked by the route; set by hand, the route follows.
            station: { label: "Route step", type: "string" },
        },
        states: {
            initial: "created",
            list: ["created", "in_process", "at_machine", "processing", "processed", "on_hold", "released", "consumed"],
            tones: { on_hold: "warn", released: "ok", consumed: "neutral" },
            transitions: [
                { action: "start", label: "Start", from: ["created"], to: "in_process" },
                { action: "hold", label: "Hold", from: ["created", "in_process"], to: "on_hold" },
                { action: "resume", label: "Resume", from: ["on_hold"], to: "in_process" },
                { action: "release", label: "Release", from: ["in_process", "on_hold"], to: "released" },
                { action: "consume", label: "Consume", from: ["released"], to: "consumed" },
                // A machine's four steps: assigned, started, ended, taken off. Taken only through the
                // transactions of the same names (the lot-machine-moves policy), which move the machine too.
                { action: "move_in", label: "Move in", from: ["created", "in_process"], to: "at_machine" },
                { action: "track_in", label: "Track in", from: ["at_machine"], to: "processing" },
                { action: "track_out", label: "Track out", from: ["processing"], to: "processed" },
                { action: "move_out", label: "Move out", from: ["processed"], to: "in_process" },
            ],
        },
        roles: ["operator", "supervisor", "quality", "viewer", "router"],
        stewards: { object: ["production", "quality"], fields: { disposition: ["quality"] }, states: { released: ["quality"] } },
        policies: [
            { id: "lot-read", roles: ["operator", "supervisor", "quality", "viewer"], record: { read: true }, fields: { "*": "read" } },
            {
                id: "lot-production-edit", roles: ["operator", "supervisor"], record: { create: true },
                when: { in: [{ record: "state" }, ["created", "in_process"]] },
                fields: { lot_no: "write", item: "write", work_order: "write", qty: "write", uom: "write", expiry: "write", station: "write" },
                actions: { start: "allow", hold: "allow" },
            },
            // A route's own identity (§32.6): it marks the step, and holds a lot its scripts say to.
            { id: "lot-router", roles: ["router"], record: { read: true }, fields: { station: "write", "*": "read" }, actions: { hold: "allow" } },
            { id: "lot-supervisor", roles: ["supervisor"], actions: { resume: "allow", consume: "allow" } },
            {
                id: "lot-quality-disposition", roles: ["quality"],
                when: { in: [{ record: "state" }, ["in_process", "on_hold"]] },
                fields: { disposition: "write" }, actions: { hold: "allow", resume: "allow", release: "allow" },
            },
            { id: "lot-expiry-locked", roles: ["operator", "supervisor", "quality", "viewer"], when: { in: [{ record: "state" }, ["released", "consumed"]] }, deny: { fields: ["expiry"] } },
            { id: "lot-archive", roles: ["supervisor"], record: { archive: true }, when: { in: [{ record: "state" }, ["on_hold", "consumed"]] } },
            // Only through the machine transactions: never from the lot's own form.
            {
                id: "lot-machine-moves", roles: ["operator", "supervisor"], via: ["move_in", "track_in", "track_out", "move_out"],
                when: { in: [{ record: "state" }, ["created", "in_process", ...AT_MACHINE]] },
                fields: { machine: "write", qty: "write", scrap_qty: "write", scrap_reason: "write" },
                actions: { move_in: "allow", track_in: "allow", track_out: "allow", move_out: "allow" },
            },
        ],
        hints: {
            "write:qty": "A released lot's quantity is corrected through a deviation (object 'deviation', action 'create').",
            "write:disposition": "Disposition is set by Quality while the lot is in process or on hold.",
            "record:archive": "A supervisor archives a lot once it is consumed, or while it is on hold (a scrapped lot).",
        },
        list: { columns: ["lot_no", "item", "qty", "uom", "disposition"] },
        analytics: { dimensions: ["item", "uom"] },
        // Excel import (§24): new lots only; an existing lot is never overridden by a file.
        transfer: { import: { create: true, update: false, key: "lot_no" } },
        form: {
            sections: [
                { label: "Lot", fields: ["lot_no", "item", "work_order"] },
                { label: "Quantity", fields: ["qty", "uom", "expiry"] },
                { label: "Quality", fields: ["disposition"] },
                { label: "At the machine", collapsible: true, fields: ["machine", "scrap_qty", "scrap_reason", "station"] },
            ],
        },
        rules: [
            { script: "lot_round_qty", writes: ["qty"] },
            { script: "lot_qty_positive" },
            { script: "lot_default_expiry", writes: ["expiry"] },
            { script: "lot_check_qty", backendOnly: true },
            { script: "lot_release_checks" },
            { script: "lot_archive_checks" },
        ],
        // Flow templates (§32): it goes along routes, and plans read it.
        flow: { as: ["traveler", "reference"], step: "station" },
    },
    {
        object: "deviation",
        label: "Deviation",
        area: "Quality",
        description: "Something that did not go as specified, and what was done about it.",
        titleField: "title",
        fields: {
            title: { label: "Title", type: "string", required: true },
            lot: { label: "Lot", type: "ref", to: "lot" },
            severity: { label: "Severity", type: "enum", values: ["minor", "major", "critical"], required: true },
            description: { label: "Description", type: "text" },
            root_cause: { label: "Root cause", type: "text" },
        },
        states: {
            initial: "open",
            list: ["open", "investigating", "closed"],
            tones: { closed: "ok" },
            transitions: [
                { action: "investigate", label: "Investigate", from: ["open"], to: "investigating" },
                { action: "close", label: "Close", from: ["investigating"], to: "closed" },
            ],
        },
        roles: ["reporter", "quality"],
        stewards: { object: ["quality"] },
        policies: [
            { id: "dev-read", roles: ["reporter", "quality"], record: { read: true }, fields: { "*": "read" } },
            { id: "dev-report", roles: ["reporter", "quality"], record: { create: true }, when: { eq: [{ record: "state" }, "open"] }, fields: { title: "write", lot: "write", severity: "write", description: "write" } },
            { id: "dev-investigate", roles: ["quality"], when: { in: [{ record: "state" }, ["open", "investigating"]] }, fields: { root_cause: "write", severity: "write" }, actions: { investigate: "allow", close: "allow" } },
        ],
        list: { columns: ["title", "severity", "lot"] },
        analytics: { dimensions: ["severity"] },
        form: { sections: [{ label: "Deviation", fields: ["title", "lot", "severity", "description"] }, { label: "Investigation", fields: ["root_cause"] }] },
        rules: [
            { script: "dev_close_needs_cause" },
        ],
        // A deviation raised may set a plan off (OCAP, §32).
        flow: { as: ["subject"] },
    },
    {
        object: "machine",
        label: "Machine",
        area: "Production",
        description: "Where lots are processed: a press, an oven. How many lots it holds at once is its capacity.",
        titleField: "machine_id",
        fields: {
            machine_id: { label: "Machine", type: "string", required: true },
            name: { label: "Name", type: "string", required: true },
            kind: { label: "Kind", type: "enum", values: ["press", "oven", "dryer", "extruder"], required: true },
            capacity: { label: "Capacity (lots)", type: "integer", required: true },
            down_reason: { label: "Down because", type: "string", requiredWhen: { eq: [{ record: "state" }, "down"] } },
        },
        states: {
            initial: "idle",
            list: ["idle", "loaded", "running", "down"],
            tones: { running: "ok", down: "danger" },
            transitions: [
                { action: "load", label: "Load", from: ["idle"], to: "loaded" },
                { action: "start", label: "Start", from: ["loaded"], to: "running" },
                { action: "finish", label: "Finish", from: ["running"], to: "loaded" },
                { action: "unload", label: "Unload", from: ["loaded"], to: "idle" },
                { action: "break_down", label: "Down", from: ["idle", "loaded", "running"], to: "down" },
                { action: "repair", label: "Repaired", from: ["down"], to: "idle" },
            ],
        },
        roles: ["operator", "maintenance", "viewer"],
        stewards: { object: ["production"] },
        policies: [
            { id: "machine-read", roles: ["operator", "maintenance", "viewer"], record: { read: true }, fields: { "*": "read" } },
            { id: "machine-maintain", roles: ["maintenance"], record: { create: true }, fields: { "*": "write" }, actions: { break_down: "allow", repair: "allow" } },
            { id: "machine-down", roles: ["operator"], fields: { down_reason: "write" }, actions: { break_down: "allow" } },
            // Loaded, started, finished and unloaded by the lot transactions, never by hand.
            { id: "machine-lot-moves", roles: ["operator"], via: ["move_in", "track_in", "track_out", "move_out"], actions: { load: "allow", start: "allow", finish: "allow", unload: "allow" } },
        ],
        list: { columns: ["machine_id", "name", "kind", "capacity"] },
        analytics: { dimensions: ["kind"] },
        form: { sections: [{ label: "Machine", fields: ["machine_id", "name", "kind", "capacity"] }, { label: "Down", fields: ["down_reason"] }] },
        rules: [],
        flow: { as: ["resource", "reference"] },
    },
];

// Transactions (§25): screens that change several records as one. Each is a definition like the
// objects above; the platform knows nothing of lots or machines. The four below are one plant's way
// of working a machine; another plant designs one "Start" that moves in and tracks in at once.
const lotInput = { label: "Lot", type: "ref", to: "lot", required: true };
const machineOfLot = { label: "Machine", type: "ref", to: "machine", required: true, from: "lot.machine" };
const onMachine = (states) => ({ count: { object: "lot", where: { machine: { input: "machine" }, state: states } } });
const notDown = { that: { ne: [{ lookup: "machine.state" }, "down"] }, message: "The machine is down.", field: "machine" };
export const transactions = [
    {
        name: "move_in", label: "Move in", description: "Put a lot on a machine: the lot is assigned to it, and the machine is loaded.",
        inputs: { lot: lotInput, machine: { label: "Machine", type: "ref", to: "machine", required: true } },
        form: { sections: [{ label: "Move in", fields: [{ field: "lot", widget: "scan", width: 6 }, { field: "machine", widget: "scan", width: 6 }] }] },
        appearsOn: { object: "lot", states: ["created", "in_process"], fills: "lot" },
        require: [
            notDown,
            { that: { lt: [onMachine(AT_MACHINE), { lookup: "machine.capacity" }] }, message: "The machine is full.", field: "machine" },
        ],
        steps: [
            { on: "lot", set: { machine: { input: "machine" } }, action: "move_in" },
            { on: "machine", action: "load", when: { eq: [{ lookup: "machine.state" }, "idle"] } },
        ],
        confirm: true, maximize: "toggle", callers: { users: [], groups: ["production"] }, stewards: ["production"],
    },
    {
        name: "track_in", label: "Track in", description: "Start processing a lot that is on a machine; the machine runs.",
        inputs: { lot: lotInput, machine: machineOfLot },
        form: { sections: [{ label: "Track in", fields: [{ field: "lot", widget: "scan", width: 6 }, { field: "machine", width: 6 }] }] },
        appearsOn: { object: "lot", states: ["at_machine"], fills: "lot" },
        require: [notDown],
        steps: [
            { on: "lot", action: "track_in" },
            { on: "machine", action: "start", when: { eq: [{ lookup: "machine.state" }, "loaded"] } },
        ],
        confirm: true, maximize: "toggle", callers: { users: [], groups: ["production"] }, stewards: ["production"],
    },
    {
        name: "track_out", label: "Track out", description: "End processing: what came out good, and what was scrapped and why.",
        inputs: {
            lot: lotInput, machine: machineOfLot,
            good_qty: { label: "Good", type: "decimal", required: true },
            scrap_qty: { label: "Scrap", type: "decimal" },
            scrap_reason: { label: "Scrap reason", type: "enum", values: SCRAP_REASONS, requiredWhen: { gt: [{ data: "scrap_qty" }, 0] } },
        },
        form: {
            sections: [
                { label: "Track out", fields: [{ field: "lot", widget: "scan", width: 6 }, { field: "machine", width: 6 }] },
                { label: "Result", fields: [{ field: "good_qty", widget: "stepper" }, { field: "scrap_qty", widget: "stepper" }, { field: "scrap_reason", show: { gt: [{ data: "scrap_qty" }, 0] } }] },
            ],
        },
        appearsOn: { object: "lot", states: ["processing"], fills: "lot" },
        require: [
            { that: { eq: [{ add: [{ input: "good_qty" }, { input: "scrap_qty" }] }, { lookup: "lot.qty" }] }, message: "Good and scrap together must be the lot's quantity.", field: "good_qty" },
        ],
        steps: [
            { on: "lot", set: { qty: { input: "good_qty" }, scrap_qty: { input: "scrap_qty" }, scrap_reason: { input: "scrap_reason" } }, action: "track_out" },
            // The machine stops when the last lot processing on it is tracked out (this one).
            { on: "machine", action: "finish", when: { eq: [onMachine(["processing"]), 1] } },
        ],
        confirm: true, maximize: "toggle", callers: { users: [], groups: ["production"] }, stewards: ["production"],
    },
    {
        name: "move_out", label: "Move out", description: "Take a processed lot off its machine; the machine is idle again once nothing is left on it.",
        inputs: { lot: lotInput, machine: machineOfLot },
        form: { sections: [{ label: "Move out", fields: [{ field: "lot", widget: "scan", width: 6 }, { field: "machine", width: 6 }] }] },
        appearsOn: { object: "lot", states: ["processed"], fills: "lot" },
        require: [],
        steps: [
            { on: "lot", set: { machine: null }, action: "move_out" },
            { on: "machine", action: "unload", when: { all: [{ eq: [{ lookup: "machine.state" }, "loaded"] }, { eq: [onMachine(AT_MACHINE), 1] }] } },
        ],
        confirm: true, maximize: "toggle", callers: { users: [], groups: ["production"] }, stewards: ["production"],
    },
];

// Rule scripts (DESIGN.md §12): one function per file name; context in, context out; throw to reject.
export const scripts = {
    lot_round_qty: `// Rounds the quantity to three decimals whenever it changes.
export default function lot_round_qty(ctx) {
  if (ctx.event.kind === "change" && !ctx.event.changed.includes("qty")) return ctx;
  if (typeof ctx.data.qty === "number") ctx.data.qty = Math.round(ctx.data.qty * 1000) / 1000;
  return ctx;
}`,
    lot_qty_positive: `// A lot's quantity is more than zero.
export default function lot_qty_positive(ctx) {
  if (ctx.event.kind === "change" && !ctx.event.changed.includes("qty")) return ctx;
  if (typeof ctx.data.qty === "number" && ctx.data.qty <= 0) {
    throw Object.assign(new Error("The quantity must be more than zero."), { field: "qty" });
  }
  return ctx;
}`,
    lot_default_expiry: `// A new lot without an expiry expires 180 days from today.
export default function lot_default_expiry(ctx) {
  if (ctx.event.kind !== "save" || ctx.record.id || ctx.data.expiry) return ctx;
  const expiry = new Date(Date.parse(ctx.now) + 180 * 24 * 3600 * 1000);
  ctx.data.expiry = expiry.toISOString().slice(0, 10);
  return ctx;
}`,
    lot_check_qty: `// On save: at most 5% over the work order's quantity (looks the order up, so it runs at the backend).
export default async function lot_check_qty(ctx) {
  if (ctx.event.kind !== "save" || !ctx.data.work_order) return ctx;
  const order = await ctx.lookup("work_order", ctx.data.work_order);
  if (!order) throw Object.assign(new Error("Pick a work order you can see."), { field: "work_order" });
  const limit = Math.round(order.qty * 1.05 * 1000) / 1000;
  if (ctx.data.qty > limit) {
    throw Object.assign(new Error("At most " + limit + ": 5% over work order " + order.wo_no + "."), { field: "qty" });
  }
  return ctx;
}`,
    lot_release_checks: `// Release needs an accepted disposition; a rejected lot is never released.
export default function lot_release_checks(ctx) {
  if (ctx.event.kind === "change" && ctx.event.changed.includes("disposition") && ctx.data.disposition === "reject" && ctx.record.state === "released") {
    throw Object.assign(new Error("A released lot cannot be rejected; open a deviation."), { field: "disposition" });
  }
  if (ctx.event.kind === "action" && ctx.event.action === "release" && ctx.data.disposition !== "accept") {
    throw Object.assign(new Error("Set the disposition to accept before releasing the lot."), { field: "disposition" });
  }
  return ctx;
}`,
    lot_archive_checks: `// A lot is archived only once its disposition is decided.
export default function lot_archive_checks(ctx) {
  if (ctx.event.kind !== "archive") return ctx;
  if (ctx.data.disposition !== "accept" && ctx.data.disposition !== "reject") {
    throw Object.assign(new Error("Decide the lot's disposition before archiving it."), { field: "disposition" });
  }
  return ctx;
}`,
    wo_qty_positive: `// A work order's quantity is more than zero.
export default function wo_qty_positive(ctx) {
  if (ctx.event.kind === "change" && !ctx.event.changed.includes("qty")) return ctx;
  if (typeof ctx.data.qty === "number" && ctx.data.qty <= 0) {
    throw Object.assign(new Error("The quantity must be more than zero."), { field: "qty" });
  }
  return ctx;
}`,
    dev_close_needs_cause: `// A deviation is closed only with a root cause.
export default function dev_close_needs_cause(ctx) {
  if (ctx.event.kind === "action" && ctx.event.action === "close" && !(ctx.data.root_cause ?? "").trim()) {
    throw Object.assign(new Error("Write the root cause before closing."), { field: "root_cause" });
  }
  return ctx;
}`,
};

// Their test cases (fitness.js: { name, run: { event, data, record }, expect }): the evidence each script
// carries, and what a copy of its object carries with it (a copy of Lot passes the fitness test as it is).
const save = (data, record = {}) => ({ event: { kind: "save" }, data, record });
export const tests = {
    lot_round_qty: [
        { name: "a quantity is rounded to three decimals", run: save({ qty: 1.23456 }), expect: { changed: ["qty"] } },
        { name: "another field changed: the quantity is left alone", run: { event: { kind: "change", changed: ["note"] }, data: { qty: 1.23456 } }, expect: { changed: [] } },
    ],
    lot_qty_positive: [
        { name: "more than zero passes", run: save({ qty: 5 }), expect: { changed: [] } },
        { name: "zero or less is refused on the quantity", run: save({ qty: -5 }), expect: { throws: { field: "qty" } } },
    ],
    lot_default_expiry: [
        { name: "a new lot without an expiry gets one", run: save({ qty: 1 }), expect: { changed: ["expiry"] } },
        { name: "an expiry given is kept", run: save({ expiry: "2027-01-31" }), expect: { changed: [] } },
        { name: "a lot saved again is left alone", run: save({ qty: 1 }, { id: "a-lot" }), expect: { changed: [] } },
    ],
    lot_check_qty: [
        { name: "no work order: nothing to compare", run: save({ qty: 5 }), expect: { changed: [] } },
        { name: "only on save", run: { event: { kind: "change", changed: ["qty"] }, data: { qty: 5, work_order: "x" } }, expect: { changed: [] } },
        { name: "a work order nobody can see is refused", run: save({ qty: 5, work_order: "00000000-0000-0000-0000-000000000000" }), expect: { throws: { field: "work_order" } } },
    ],
    lot_release_checks: [
        { name: "release with an accepted disposition", run: { event: { kind: "action", action: "release" }, data: { disposition: "accept" }, record: { state: "in_process" } }, expect: { changed: [] } },
        { name: "release without one is refused", run: { event: { kind: "action", action: "release" }, data: { disposition: "hold" }, record: { state: "in_process" } }, expect: { throws: { field: "disposition" } } },
        { name: "a released lot is never rejected", run: { event: { kind: "change", changed: ["disposition"] }, data: { disposition: "reject" }, record: { state: "released" } }, expect: { throws: { field: "disposition" } } },
    ],
    lot_archive_checks: [
        { name: "a decided lot is archived", run: { event: { kind: "archive" }, data: { disposition: "accept" } }, expect: { changed: [] } },
        { name: "an undecided one is refused", run: { event: { kind: "archive" }, data: { disposition: "hold" } }, expect: { throws: { field: "disposition" } } },
    ],
    wo_qty_positive: [
        { name: "more than zero passes", run: save({ qty: 100 }), expect: { changed: [] } },
        { name: "zero or less is refused on the quantity", run: save({ qty: 0 }), expect: { throws: { field: "qty" } } },
    ],
    dev_close_needs_cause: [
        { name: "closed with a root cause", run: { event: { kind: "action", action: "close" }, data: { root_cause: "Worn die" } }, expect: { changed: [] } },
        { name: "closed without one is refused", run: { event: { kind: "action", action: "close" }, data: { root_cause: " " } }, expect: { throws: { field: "root_cause" } } },
    ],
};

// Records: { object, state, data } with refs given as keys resolved at seed time.
// Flow templates (§32), as designs like the rest: a process flow (a route) a glass-filled nylon lot
// goes through, and the out-of-control action plan (OCAP) a major deviation sets off. Drawn in the Flow
// designer; nothing here is code but one script, run on entering a node.
scripts.flow_hold_lot = `// On entering a node: the lot is held, as the flow template, by its own lifecycle (§32.6).
export default function flow_hold_lot(ctx) {
  const lot = ctx.context.lot;
  if (lot && (lot.state === "created" || lot.state === "in_process")) ctx.writes.push({ record: "lot", action: "hold" });
  ctx.context.held_by = ctx.event.label;
  return ctx;
}
`;
const moves = ["move_in", "track_in", "track_out", "move_out"];
const step = (label, kinds, extra = {}) => ({ kind: "sequence", label, offers: moves, leaves: ["move_out"], resource: { kind: kinds }, ...extra });
const anyone = (...groups) => ({ users: [], groups });
export const flows = [
    {
        name: "molding_route", label: "Molding route", kind: "route",
        description: "Glass-filled nylon: dried, molded on a press, cured. A lot scrapping more than the limit at molding is held for review instead of curing.",
        participants: { lot: { object: "lot", as: "traveler" }, machine: { object: "machine", as: "resource" } },
        context: { max_scrap: 25 },
        ends: { when: { in: [{ context: "lot.state" }, ["released", "consumed"]] } },
        nodes: {
            start: { kind: "start", label: "Start", when: { eq: [{ context: "lot.item" }, "PA6-GF30-NAT"] } },
            drying: step("Drying", ["oven", "dryer"], { settings: { temp_c: 80, hours: 4 } }),
            molding: step("Molding", ["press"], { settings: { cycle_s: 42 } }),
            scrap_check: { kind: "auto_decision", label: "Scrap over the limit?" },
            curing: step("Curing", ["oven"], { settings: { temp_c: 120, hours: 2 } }),
            held: { kind: "end", label: "Held for review", outcome: "held", onEnter: "flow_hold_lot" },
            done: { kind: "end", label: "Ready", outcome: "ready" },
        },
        edges: [
            { from: "start", to: "drying" },
            { from: "drying", to: "molding" },
            { from: "molding", to: "scrap_check" },
            { from: "scrap_check", to: "held", when: { gt: [{ context: "lot.scrap_qty" }, { context: "max_scrap" }] } },
            { from: "scrap_check", to: "curing" },
            { from: "curing", to: "done" },
        ],
        layout: { start: { x: 40, y: 60 }, drying: { x: 280, y: 60 }, molding: { x: 520, y: 60 }, scrap_check: { x: 760, y: 60 }, curing: { x: 1000, y: 60 }, done: { x: 1240, y: 60 }, held: { x: 1000, y: 200 } },
        roles: { lot: ["router"], work_order: ["viewer"] }, stewards: ["production"],
    },
    {
        name: "deviation_response", label: "Deviation response", kind: "plan",
        description: "A major or critical deviation: the lot is held, contained, the lab heard, the root cause found by engineering, and quality disposes of the lot.",
        participants: { deviation: { object: "deviation", as: "subject" }, lot: { object: "lot", as: "reference", from: "deviation.lot" } },
        context: { lab_hours: 4 },
        nodes: {
            start: { kind: "start", label: "Deviation raised", when: { in: [{ context: "deviation.severity" }, ["major", "critical"]] }, onEnter: "flow_hold_lot" },
            contain: { kind: "input_screen", label: "Contain", message: "Quarantine the lot and what it touched; say what was done.", for: anyone("quality"), fields: [{ name: "action", label: "What was done", type: "string", required: true }, { name: "photo", label: "Photo of the quarantine", type: "image" }, { name: "quarantined", label: "Quarantined", type: "boolean", required: true }] },
            lab: { kind: "wait", label: "Await the lab", message: "Samples are at the lab: wait for the result before deciding.", seconds: 14400, mode: "acknowledge", for: anyone("quality") },
            cause: { kind: "manual_decision", label: "Root cause?", message: "What caused it?", for: anyone("engineering") },
            fix: { kind: "wait", label: "Fix the machine", message: "Repair and requalify the machine; Retry goes back to the lab.", seconds: 3600, mode: "retry", for: anyone("production") },
            train: { kind: "input_screen", label: "Retrain the crew", for: anyone("production"), fields: [{ name: "trained", label: "Who was trained", type: "string", required: true }, { name: "record", label: "Training record", type: "file" }] },
            disposition: { kind: "input_screen", label: "Disposition", message: "Decide about the lot, with the evidence.", for: anyone("quality"), fields: [{ name: "decision", label: "Decision", type: "enum", values: ["accept", "rework", "reject"], required: true }, { name: "evidence", label: "Evidence", type: "file" }, { name: "report", label: "8D report", type: "link" }] },
            decide: { kind: "auto_decision", label: "Rejected?" },
            rejected: { kind: "end", label: "Rejected", outcome: "rejected" },
            closed: { kind: "end", label: "Closed", outcome: "closed" },
        },
        edges: [
            { from: "start", to: "contain" },
            { from: "contain", to: "lab" },
            { from: "lab", to: "cause" },
            { from: "cause", to: "fix", label: "Machine" },
            { from: "cause", to: "disposition", label: "Material" },
            { from: "cause", to: "train", label: "Method" },
            { from: "fix", to: "lab", retry: true },
            { from: "fix", to: "disposition" },
            { from: "train", to: "disposition" },
            { from: "disposition", to: "decide" },
            { from: "decide", to: "rejected", when: { eq: [{ context: "decision" }, "reject"] } },
            { from: "decide", to: "closed" },
        ],
        layout: { start: { x: 40, y: 60 }, contain: { x: 280, y: 60 }, lab: { x: 520, y: 60 }, cause: { x: 760, y: 60 }, fix: { x: 520, y: 240 }, train: { x: 760, y: 420 }, disposition: { x: 1000, y: 240 }, decide: { x: 1240, y: 240 }, rejected: { x: 1480, y: 330 }, closed: { x: 1480, y: 150 } },
        roles: { lot: ["router"] }, stewards: ["quality"],
    },
];

export const records = [
    { key: "wo1", object: "work_order", state: "released", data: { wo_no: "WO-1001", item: "PA66-NAT-25", qty: 1200, line: "L3", due: "2026-10-15" } },
    { key: "wo2", object: "work_order", state: "planned", data: { wo_no: "WO-1002", item: "PP-BLK-10", qty: 800, line: "L1", due: "2026-10-22" } },
    { key: "lot1", object: "lot", state: "released", data: { lot_no: "4711", item: "PA66-NAT-25", work_order: "@wo1", qty: 1250, uom: "kg", expiry: "2027-03-31", disposition: "accept" } },
    { key: "lot2", object: "lot", state: "in_process", data: { lot_no: "4712", item: "PA66-NAT-25", work_order: "@wo1", qty: 600, uom: "kg", expiry: "2027-04-02", disposition: "pending" } },
    { key: "lot3", object: "lot", state: "created", data: { lot_no: "4713", item: "PP-BLK-10", work_order: "@wo2", qty: 400, uom: "kg", disposition: "pending" } },
    { key: "m101", object: "machine", state: "idle", data: { machine_id: "M-101", name: "Press 1", kind: "press", capacity: 1 } },
    { key: "m102", object: "machine", state: "idle", data: { machine_id: "M-102", name: "Press 2", kind: "press", capacity: 1 } },
    { key: "ov1", object: "machine", state: "idle", data: { machine_id: "OV-1", name: "Curing oven", kind: "oven", capacity: 4 } },
    { key: "dev1", object: "deviation", state: "open", data: { title: "Moisture above limit on lot 4712", lot: "@lot2", severity: "minor", description: "Dryer outlet read 0.25% against a 0.20% limit." } },
];

// Report layouts (§34.5): how an AI report is laid out. A layout holds no query: whoever asks the
// analytics copilot for a report picks one, and the copilot fills it from what they may read.
export const layouts = [
    {
        name: "daily_report", label: "Daily report", description: "The plant in the last 24 hours: what was released, what is held, what waits.",
        guidance: "Cover the last 24 hours unless a block says otherwise. Lead with what needs action today. Name lots, work orders and machines by their labels, never by an id.",
        blocks: [
            { block: "text", width: "full", title: "The situation", hint: "Three sentences at most: what was done, what is stuck, what to look at first. With the numbers." },
            { block: "figure", width: "quarter", title: "Lots released", hint: "Lots that entered the released state in the last 24 hours." },
            { block: "figure", width: "quarter", title: "Lots in process", hint: "Lots being processed now." },
            { block: "figure", width: "quarter", title: "Lots on hold", hint: "Lots held now." },
            { block: "figure", width: "quarter", title: "Open work orders", hint: "Work orders not yet closed." },
            { block: "chart", chart: "line", width: "half", title: "Released per day", hint: "Lots released per day, the last 7 days, oldest first." },
            { block: "chart", chart: "bar", width: "half", title: "Lots by state", hint: "How many lots are in each state now." },
            { block: "table", width: "full", title: "Waiting longest", hint: "The ten lots that have been in their present state longest: lot, state, since when. Longest first." },
        ],
        stewards: ["production"],
    },
];

// Screens (§26): pages composed of fixed building blocks. Each is a definition like the objects and
// transactions above; every block reads with the viewer's own rights.
const onThis = (states) => ({ machine: { param: "machine" }, state: states });
export const screens = [
    {
        name: "work_centre", label: "Work centre", description: "One machine: what is on it, and the moves to make.",
        params: { machine: { label: "Machine", type: "ref", to: "machine", required: true, widget: "scan" } },
        blocks: [
            { block: "record", title: "Machine", object: "machine", of: { param: "machine" }, show: ["machine_id", "name", "kind", "capacity", "state"], width: 4 },
            { block: "kpi", title: "Lots on it", label: "lots", object: "lot", where: onThis(AT_MACHINE), measure: "count", width: 4 },
            { block: "kpi", title: "Scrap today (all machines)", label: "scrapped", object: "lot", where: {}, measure: { sum: "scrap_qty" }, since: "today", width: 4 },
            { block: "table", title: "Processing", object: "lot", where: onThis(["processing"]), columns: ["lot_no", "item", "qty", "uom"], rowActions: ["track_out"], width: 6 },
            { block: "table", title: "Waiting to start", object: "lot", where: onThis(["at_machine"]), columns: ["lot_no", "item", "qty", "uom"], rowActions: ["track_in"], width: 6 },
            { block: "table", title: "Done: take off", object: "lot", where: onThis(["processed"]), columns: ["lot_no", "qty", "scrap_qty", "scrap_reason"], rowActions: ["move_out"], width: 6 },
            { block: "transaction", title: "Move a lot in", name: "move_in", fills: { machine: { param: "machine" } }, width: 6 },
        ],
        maximize: "toggle", callers: { users: [], groups: ["production"] }, stewards: ["production"],
    },
    {
        name: "shop_floor", label: "Shop floor", description: "Every machine and every lot on one, at a glance.",
        params: {},
        blocks: [
            { block: "breakdown", title: "Machines", object: "machine", by: "state", measure: "count", width: 4 },
            { block: "kpi", title: "Lots at machines", label: "lots", object: "lot", where: { state: AT_MACHINE }, measure: "count", width: 4 },
            { block: "kpi", title: "Lots on hold", label: "lots", object: "lot", where: { state: ["on_hold"] }, measure: "count", width: 4 },
            { block: "table", title: "At the machines", object: "lot", where: { state: AT_MACHINE }, columns: ["lot_no", "machine", "state", "qty"], sort: { field: "machine", dir: "asc" }, width: 8 },
            { block: "breakdown", title: "Scrap this week, by reason", object: "lot", where: {}, by: "scrap_reason", measure: { sum: "scrap_qty" }, since: "7d", width: 4 },
        ],
        // A board on the wall: it opens filling the window.
        maximize: "start", callers: { users: [], groups: ["production", "quality"] }, stewards: ["production"],
    },
    {
        // A pop-up (§26.7): over Move in and Track in, while the machine they name is down, this opens
        // by itself and says so; it goes away when the machine is repaired. It decides nothing: Move
        // in's own check refuses a machine that is down.
        name: "machine_down", label: "Machine down", description: "This machine is down: lots are not moved onto it or started on it until it is repaired.",
        params: { machine: { label: "Machine", type: "ref", to: "machine", required: true, widget: "scan" } },
        blocks: [
            { block: "record", title: "Machine", object: "machine", of: { param: "machine" }, show: ["machine_id", "name", "state", "down_reason"], width: 6 },
            { block: "text", text: "Pick another machine, or ask maintenance when it will be back.", width: 6 },
        ],
        popup: { on: ["transaction:move_in", "transaction:track_in"], for: { groups: ["production"] }, while: { eq: [{ lookup: "machine.state" }, "down"] }, with: { input: "machine" } },
        callers: { users: [], groups: ["production", "quality"] }, stewards: ["production"],
    },
];

// Volume for a demo (ops/demo/demo.env, SEED_VOLUME): `n` more lots over a dozen more work orders, so
// a demo has lists to page through and numbers and breakdowns worth reading. The same records every
// time (a fixed sequence, no randomness); lots in the states that do not need a machine (moves onto
// machines are the transactions' to make); each within its order's quantity (lot_check_qty) and
// with a reason for any scrap. Development and the tests leave it at none.
const ITEMS = ["PA66-NAT-25", "PP-BLK-10", "PA6-GF30-NAT", "POM-WHT-05", "PC-CLR-12"];
const VOLUME_STATES = [["released", 30], ["consumed", 20], ["in_process", 20], ["created", 20], ["on_hold", 10]];
// A lot number as plants write them: LOT, a running number, two letters and a check letter (LOT1235AB-C).
const LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ";
const lotNo = (i) => `LOT${1235 + i}${LETTERS[(i * 7) % LETTERS.length]}${LETTERS[(i * 3 + 5) % LETTERS.length]}-${LETTERS[(i * 11 + 2) % LETTERS.length]}`;
export function volume(n = 0) {
    if (!(n > 0)) return [];
    let x = 7;
    const next = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; // the same every time
    const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    const orders = Array.from({ length: 12 }, (_, i) => ({
        key: `vwo${i + 1}`, object: "work_order", state: i < 4 ? "closed" : i < 9 ? "released" : "planned",
        data: { wo_no: `WO-${2001 + i}`, item: ITEMS[i % ITEMS.length], qty: 600 + 200 * (i % 5), line: `L${1 + (i % 3)}`, due: day(i < 4 ? -20 + i * 3 : 3 + i * 2) },
    }));
    const states = VOLUME_STATES.flatMap(([state, share]) => Array.from({ length: share }, () => state));
    const lots = Array.from({ length: n }, (_, i) => {
        const state = states[Math.floor((i * states.length) / n)];
        // Finished lots on the closed and released orders; lots still in work on the released and planned ones.
        const done = state === "released" || state === "consumed";
        const order = orders[done ? i % 9 : 4 + (i % 8)];
        const qty = Math.round(order.data.qty * (0.3 + next() * 0.6));
        const scrap = done && next() < 0.35 ? Math.round(qty * next() * 0.06) : 0;
        return {
            key: `vlot${i + 1}`, object: "lot", state,
            data: {
                lot_no: lotNo(i), item: order.data.item, work_order: `@${order.key}`, qty, uom: "kg",
                ...(done ? { expiry: day(150 + (i % 30)) } : {}),
                disposition: done ? "accept" : state === "on_hold" ? (i % 2 ? "rework" : "pending") : "pending",
                ...(scrap > 0 ? { scrap_qty: scrap, scrap_reason: SCRAP_REASONS[i % SCRAP_REASONS.length] } : {}),
            },
        };
    });
    return [...orders, ...lots];
}

