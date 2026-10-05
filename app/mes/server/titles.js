// What people call a record, never its id (DESIGN.md §34.9): an answer to a query (a report's block, a
// screen's chart, what the analytics copilot is handed) may hold record ids, a reference column or an id
// column; none is ever shown. Each is replaced by its record's title, read as the person reading would
// read it (its object's policies: one they may not read is "—"), so a chart is labelled "M-101", not
// 17307cb7-51b1-…; an id that names no record is "—" too.
import { mask } from "./policy.js";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HIDDEN = "—";
const MAX_IDS = 2000;

export function createTitles({ store, records }) {
    const x = records.internals;
    // id → what this person calls it: its title as they may read it, "—" when they may not, or it is no record.
    async function titlesOf(user, ids) {
        const out = new Map();
        const wanted = [...new Set(ids)].filter((v) => UUID.test(v)).slice(0, MAX_IDS);
        if (!wanted.length) return out;
        const rows = await x.reader.query("SELECT id, object FROM mes.records WHERE id = ANY($1::uuid[])", [wanted]);
        const byObject = new Map();
        for (const r of rows) (byObject.get(r.object) ?? byObject.set(r.object, []).get(r.object)).push(r.id);
        for (const [object, list] of byObject) {
            const def = await store.definition(object);
            if (!def) continue;
            const actor = await x.actorFor(user, object);
            for (const id of list) {
                const row = await x.loadRow(x.reader, object, id);
                const seen = row && mask(def.body, actor, x.rowOut(row));
                const title = seen ? seen[def.body.titleField] ?? null : null;
                out.set(id, seen ? (title === null || title === undefined || title === "" ? def.body.label ?? object : String(title)) : HIDDEN);
            }
        }
        for (const id of wanted) if (!out.has(id)) out.set(id, HIDDEN);
        return out;
    }
    // A query's answer ({ columns, rows, … }) with every id in it shown as its title.
    async function titled(user, answer) {
        if (!answer || !Array.isArray(answer.rows)) return answer;
        const ids = [];
        for (const r of answer.rows) for (const v of r) if (typeof v === "string" && UUID.test(v)) ids.push(v);
        if (!ids.length) return answer;
        const names = await titlesOf(user, ids);
        return { ...answer, rows: answer.rows.map((r) => r.map((v) => (typeof v === "string" && UUID.test(v) ? names.get(v.toLowerCase()) ?? names.get(v) ?? HIDDEN : v))) };
    }
    return { titlesOf, titled };
}
