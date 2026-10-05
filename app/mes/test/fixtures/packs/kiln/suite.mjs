// A fixture suite for the design-pack e2e (test/packs.mjs, DESIGN.md §29.6): no code, only designs. A
// kiln and the loads fired in it, which refer to each other (a kiln's first load), a transaction that
// fires a load, a screen with tabs, the roles it suggests, and sample records.
const t = Date.now() % 100000;
export const KILN = `kiln_t${t}`;
export const LOAD = `kiln_load_t${t}`;
export const FIRE = `kiln_fire_t${t}`;
export const SCREEN = `kiln_station_t${t}`;

export default {
    name: "kiln",
    label: "Kiln",
    version: "1.0.0",
    designs: {
        label: "Kiln designs", version: "1.0.0", description: "A kiln and the loads fired in it.",
        definitions: [
            {
                object: KILN, label: "Kiln", area: "Kilns", description: "A kiln.", titleField: "kiln_id",
                fields: { kiln_id: { label: "Kiln", type: "string", required: true }, first_load: { label: "First load", type: "ref", to: LOAD } },
                states: { initial: "idle", list: ["idle", "firing"], transitions: [{ action: "fire", label: "Fire", from: ["idle"], to: "firing" }, { action: "cool", label: "Cool", from: ["firing"], to: "idle" }] },
                roles: ["operator"], stewards: { object: ["production"] },
                policies: [{ id: "kiln-all", roles: ["operator"], record: { read: true, create: true }, fields: { "*": "write" }, actions: { fire: "allow", cool: "allow" } }],
                list: { columns: ["kiln_id"] }, form: { sections: [{ label: "Kiln", fields: ["kiln_id", "first_load"] }] }, rules: [],
            },
            {
                object: LOAD, label: "Load", area: "Kilns", description: "What goes into a kiln at once.", titleField: "load_no",
                fields: { load_no: { label: "Load", type: "string", required: true }, kiln: { label: "Kiln", type: "ref", to: KILN }, pieces: { label: "Pieces", type: "integer", required: true }, note: { label: "Note", type: "string" } },
                states: { initial: "loaded", list: ["loaded", "fired"], tones: { fired: "ok" }, transitions: [{ action: "fire", label: "Fire", from: ["loaded"], to: "fired" }] },
                roles: ["operator"], stewards: { object: ["production"] },
                policies: [{ id: "load-all", roles: ["operator"], record: { read: true, create: true }, fields: { "*": "write" }, actions: { fire: "allow" } }],
                list: { columns: ["load_no", "kiln", "pieces"] }, form: { sections: [{ label: "Load", fields: ["load_no", "kiln", "pieces"] }] },
                rules: [{ script: `kiln_pieces_t${t}` }],
            },
        ],
        scripts: {
            [`kiln_pieces_t${t}`]: `// A load holds at least one piece.
export default function kiln_pieces_t${t}(ctx) {
    if (typeof ctx.data.pieces === "number" && ctx.data.pieces < 1) throw Object.assign(new Error("A load holds at least one piece."), { field: "pieces" });
    return ctx;
}
`,
        },
        tests: { [`kiln_pieces_t${t}`]: [
            { name: "a load of pieces", run: { event: { kind: "create" }, data: { load_no: "L", pieces: 3 } }, expect: { data: { pieces: 3 } } },
            { name: "no pieces", run: { event: { kind: "create" }, data: { load_no: "L", pieces: 0 } }, expect: { throws: { field: "pieces" } } },
        ] },
        transactions: [{
            name: FIRE, label: "Fire a load", description: "The load is fired in its kiln.",
            inputs: { load: { label: "Load", type: "ref", to: LOAD, required: true }, kiln: { label: "Kiln", type: "ref", to: KILN, required: true, from: "load.kiln" }, first: { label: "First load", type: "ref", to: LOAD, from: "kiln.first_load" } },
            appearsOn: { object: LOAD, states: ["loaded"], fills: "load", when: { gt: [{ record: "pieces" }, 0] } },
            require: [{ that: { eq: [{ lookup: "kiln.state" }, "idle"] }, message: "The kiln is firing already.", field: "kiln" }],
            steps: [{ on: "load", set: { note: { lookup: "first.load_no" } }, action: "fire" }, { on: "kiln", action: "fire" }],
            confirm: true, callers: { users: [], groups: ["production"] }, stewards: ["production"],
            // Evidence before any real kiln exists: records it gives, of objects only this pack makes.
            scenarios: [{
                name: "a load fired in an idle kiln",
                records: { kiln: { object: KILN, data: { kiln_id: `KS-${t}` } }, load: { object: LOAD, data: { load_no: `LS-${t}`, kiln: "@kiln", pieces: 3 } } },
                steps: [{ as: "olga", do: { transaction: FIRE, input: { load: "@load" } }, expect: { ok: true, states: { load: "fired", kiln: "firing" } } }],
            }],
        }],
        screens: [{
            name: SCREEN, label: "Kiln station", description: "Loads, and firing one.", params: {},
            blocks: [
                { block: "table", title: "Loads", object: LOAD, where: {}, columns: ["load_no", "state"], rowActions: [FIRE], width: 12 },
                { block: "transaction", name: FIRE, tab: "Fire", width: 12 },
                { block: "text", text: "Cool the kiln from its page.", tab: "Cool", width: 12 },
            ],
            callers: { users: [], groups: ["production"] }, stewards: ["production"],
        }],
        roles: { [KILN]: { operator: ["group:production", "group:nowhere"] }, [LOAD]: { operator: ["group:production"] } },
        records: [
            { key: "k1", object: KILN, data: { kiln_id: `K1-${t}` } },
            { key: "l1", object: LOAD, data: { load_no: `L1-${t}`, kiln: "@k1", pieces: 12 } },
            { key: "l2", object: LOAD, data: { load_no: `L2-${t}`, kiln: "@k1", pieces: 4 }, actions: ["fire"] },
            { ref: "k1", set: { first_load: "@l1" } },
        ],
    },
};
