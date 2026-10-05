// Brings machines, the four machine transactions (DESIGN.md §25) and the Work centre and Shop floor
// screens (§26) to an existing database the way
// everything arrives: as a change request, drafted by Dana, for people to review, approve and the
// platform to execute. Nothing is published by this script.
//
//   node app/mes/db/draft-machines.mjs              drafts the change (once). Who holds the machine's
//                                                   roles is given afterwards, through People & departments
//   node app/mes/db/draft-machines.mjs --machines   once the change is executed: the three machines
//
//   DATABASE_URL  default postgres:///openmes_poc
//
// The lot is drafted from the live lot, with only what is missing added (its machine fields, states,
// transitions, the via policy and a form section), so nothing already designed is lost. A reset
// database has all of it from the seed already; this is for a database that grew by changes.
import pg from "pg";
import { fromPg } from "../../../src/server/db.js";
import { createStore } from "../server/store.js";
import { createDesign } from "../server/design.js";
import { appendAudit } from "../server/audit.js";
import { openInterval, dimsOf } from "../server/analytics.js";
import { definitions, transactions, screens, assignments, records } from "./seed.mjs";

const TITLE = "Machines, the lot's machine transactions, and their screens";
const REASON = "Lots are worked on machines: move in (assign), track in (start), track out (good and scrap), move out. Each is a transaction that changes the lot and the machine together, all or nothing; the lot's form never offers those transitions on their own (via policy). Capacity is checked under lock, so a one-lot press never gets two.";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const clone = (v) => JSON.parse(JSON.stringify(v));

try {
    const [machineLive] = await db.query("SELECT version FROM mes.definitions WHERE object = 'machine' AND status = 'published'");
    if (process.argv.includes("--machines")) {
        if (!machineLive) throw new Error("The machine object is not published yet: approve the change first.");
        const [{ n }] = await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = 'machine'");
        if (n) { console.log(`${n} machine(s) already there; nothing to do.`); process.exit(0); }
        const def = (await db.query("SELECT body FROM mes.definitions WHERE object = 'machine' AND status = 'published'"))[0].body;
        await db.transaction(async (tx) => {
            for (const r of records.filter((x) => x.object === "machine")) {
                const [row] = await tx.query("INSERT INTO mes.records (object, def_version, state, data, created_by, updated_by) VALUES ('machine', $1, $2, $3, 'sam', 'sam') RETURNING id", [machineLive.version, r.state, JSON.stringify(r.data)]);
                await appendAudit(tx, { actor: "sam", object: "machine", recordId: row.id, defVersion: machineLive.version, action: "create", after: { ...r.data, state: r.state } });
                await openInterval(tx, { object: "machine", recordId: row.id, state: r.state, by: "sam", action: "create", dims: dimsOf(def, r.data) });
                console.log(`machine ${r.data.machine_id} (${r.data.name}, capacity ${r.data.capacity})`);
            }
        });
        process.exit(0);
    }

    const [open] = await db.query("SELECT id, state, content FROM mes.change_requests WHERE title LIKE 'Machines,%' AND author = 'dana' AND state IN ('design', 'review', 'approval')");
    if (open) {
        // Drafted before the screens existed: they join it, while it is still in design.
        if (open.state === "design" && !Object.keys(open.content.screens ?? {}).length) {
            const content = { ...open.content, screens: Object.fromEntries(screens.map((sc) => [sc.name, sc])) };
            const design = createDesign({ store: createStore(db), log: { error() {} } });
            const problems = await design.problemsOf(content);
            if (problems.length) { console.log("The draft has problems:", problems); process.exit(1); }
            await db.query("UPDATE mes.change_requests SET title = $2, content = $3, base = base || $4::jsonb, updated_at = now() WHERE id = $1", [open.id, TITLE, JSON.stringify(content), JSON.stringify({ screens: Object.fromEntries(screens.map((sc) => [sc.name, null])) })]);
            console.log(`The screens joined the open change: /design/c/${open.id}`);
        } else console.log(`The change is already open: /design/c/${open.id}`);
        process.exit(0);
    }
    if (machineLive) { console.log("The machine object is published already; nothing to draft."); process.exit(0); }

    // The lot as it is, with the machine parts added where missing.
    const [lotLive] = await db.query("SELECT version, body FROM mes.definitions WHERE object = 'lot' AND status = 'published'");
    const seedLot = definitions.find((d) => d.object === "lot");
    const lot = clone(lotLive.body);
    for (const f of ["machine", "scrap_qty", "scrap_reason"]) lot.fields[f] ??= seedLot.fields[f];
    for (const s of ["at_machine", "processing", "processed"]) if (!lot.states.list.includes(s)) lot.states.list.splice(lot.states.list.indexOf("on_hold") >= 0 ? lot.states.list.indexOf("on_hold") : lot.states.list.length, 0, s);
    for (const t of seedLot.states.transitions.filter((x) => ["move_in", "track_in", "track_out", "move_out"].includes(x.action))) if (!lot.states.transitions.some((x) => x.action === t.action)) lot.states.transitions.push(t);
    const via = seedLot.policies.find((p) => p.id === "lot-machine-moves");
    if (!lot.policies.some((p) => p.id === via.id)) lot.policies.push(via);
    const section = seedLot.form.sections.find((s) => s.label === "At the machine");
    const sections = lot.form?.sections ?? lot.form?.tabs?.[0]?.sections;
    if (sections && !sections.some((s) => s.label === section.label)) sections.push(section);
    const machine = definitions.find((d) => d.object === "machine");
    const content = {
        definitions: { lot, machine }, scripts: {}, services: {}, connections: {}, tests: {},
        transactions: Object.fromEntries(transactions.map((t) => [t.name, t])),
        screens: Object.fromEntries(screens.map((sc) => [sc.name, sc])),
    };
    const base = { definitions: { lot: lotLive.version, machine: null }, scripts: {}, services: {}, connections: {}, tests: {}, transactions: Object.fromEntries(transactions.map((t) => [t.name, null])), screens: Object.fromEntries(screens.map((sc) => [sc.name, null])) };

    // Checked as the designer's page and the submit gate would.
    const design = createDesign({ store: createStore(db), log: { error() {} } });
    const problems = await design.problemsOf(content);
    if (problems.length) { console.log("The draft has problems:", problems); process.exit(1); }

    const id = await db.transaction(async (tx) => {
        const [row] = await tx.query("INSERT INTO mes.change_requests (title, reason, state, author, content, base) VALUES ($1, $2, 'design', 'dana', $3, $4) RETURNING id", [TITLE, REASON, JSON.stringify(content), JSON.stringify(base)]);
        await appendAudit(tx, { actor: "dana", object: "$change", recordId: row.id, action: "change:start", after: { objects: ["lot", "machine"], transactions: transactions.map((t) => t.name), screens: screens.map((sc) => sc.name), via: "draft-machines.mjs" } });
        return row.id;
    });
    console.log(`Drafted by Dana: /design/c/${id}`);
    console.log("Next: Dana submits it (the fitness test runs), Eli reviews, Sam approves for Production and Quinn for Quality; the platform executes it.");
    console.log("Then: node app/mes/db/draft-machines.mjs --machines   (M-101, M-102 and the oven OV-1)");
    console.log(`And give the machine's roles through People & departments → Roles → Machine (the seed's: ${assignments.filter((a) => a[2] === "machine").map(([k, sub, , role]) => `${role}: ${k} ${sub}`).join(", ")}).`);
} finally {
    await pool.end();
}
