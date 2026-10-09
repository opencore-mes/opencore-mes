// A guide's steps marked done (DESIGN.md §35.4), end to end over HTTP on the seed:
//   1. A lot, a log of steps done, the transaction that records one, a route whose sequences are placed in
//      a guide, and a station screen: a guide whose steps are done by a click, a value, a photo and the
//      equipment, and a guide that follows the route. Drafted together, approved, live. A guide whose steps
//      name what is not there is refused, each step named.
//   2. The screen as Sam sees it for a lot: nothing done yet; the transaction, the lot it fills in, the
//      inputs a value and a photo go in, the gate.
//   3. Each step done the way it says: a click, a torque typed (into its input), a photo uploaded (into
//      the evidence input); and one done by the equipment (a record written elsewhere, here by Eli). Each
//      shows done, by whom; another lot's guide shows none of them.
//   4. The guide following the route: the lot at its first step; once the step's transaction has run, the
//      route has gone on and the step shows done, by Sam.
//   5. Undo: Sam, who may archive the log's records, undoes a step; it shows not done, the record archived
//      (kept), and done again it counts anew.
//   6. A step Quality verifies (§7.4): refused with nobody beside Sam; with Quinn signed in beside, done, the
//      run's audit entry naming both. (A development instance: the picker, no passwords asked.)
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/guide-steps.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
let app = null;
const people = ["dana", "eli", "vera", "sam", "quinn"];

try {
    app = await createApp({ db, dev: true, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of people) {
        sessions[user] = `gs-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const cookie = (user) => `mes_session=${sessions[user]}`;
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: cookie(user) }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? (body && typeof body === "object" && !Array.isArray(body) ? { ok: true, ...body } : { ok: true, value: body }) : { ok: false, status: res.status, ...body };
    };
    const upload = async (user, bytes, name) => {
        const res = await fetch(`${mes}/blob?name=${encodeURIComponent(name)}`, { method: "POST", headers: { cookie: cookie(user), origin: mes, "content-type": "application/octet-stream" }, body: bytes });
        return { status: res.status, ...(await res.json()) };
    };
    const key = () => `gs-${randomBytes(6).toString("hex")}`;
    const approveAll = async (id) => {
        const submitted = await call("dana", "design.submit", { id });
        if (!submitted.ok) return { state: null, submitted };
        await call("vera", "design.review", { id, decision: "pass" });
        let state = null;
        for (let round = 0; round < 3 && state !== "executed"; round++) for (const user of people) {
            const seen = await call(user, "design.change", { id, as: user });
            for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
        }
        return { state };
    };
    const change = async (content, first, label, reason) => {
        const started = await call("dana", "design.start", { object: first, label });
        const seen = await call("dana", "design.change", { id: started.id, as: "dana" });
        const saved = await call("dana", "design.save", { id: started.id, seen: seen.draft_rev, reason, ...content });
        return { id: started.id, saved };
    };

    // ---- 1. the design ----
    const pdf = await upload("dana", await readFile(new URL("./fixtures/guide.pdf", import.meta.url)), "Cover guide.pdf");
    const [LOT, DONE, MARK, NEXT, ROUTE, SCREEN, VERIFY] = ["lot", "done", "mark", "next", "route", "station", "verify"].map((x) => `gs_${x}_t${tag}`);
    const object = (name, label, fields, titleField, extra = {}) => ({ object: name, label, area: "Production", titleField, fields, states: { initial: "open", list: ["open"], transitions: [] }, roles: ["user"], stewards: { object: ["production"] }, policies: [{ id: `${name}-all`, roles: ["user"], record: { read: true, create: true, archive: true }, fields: { "*": "write" } }], rules: [], ...extra });
    const lotDef = object(LOT, `Guided lot ${tag}`, { lot_id: { label: "Lot", type: "string" }, op: { label: "Operation", type: "string" }, note: { label: "Note", type: "string" } }, "lot_id", { flow: { as: ["traveler"], step: "op" } });
    const doneDef = object(DONE, `Step done ${tag}`, { lot: { label: "Lot", type: "ref", to: LOT }, kind: { label: "Kind", type: "string" }, step: { label: "Step", type: "integer" }, torque: { label: "Torque", type: "decimal" }, picture: { label: "Photo", type: "image" } }, "step");
    const lotScenario = (name, data, t, input, expect) => ({ name, records: { lot: { object: LOT, data } }, steps: [{ as: "sam", do: { transaction: t, input: { lot: "@lot", ...input } }, expect }] });
    const mark = {
        name: MARK, label: "Step done", description: "A step of the lot's guide, done.",
        inputs: {
            lot: { label: "Lot", type: "ref", to: LOT, required: true },
            step: { label: "Step", type: "integer", required: true },
            torque: { label: "Torque", type: "decimal", unit: "Nm" },
            picture: { label: "Photo", type: "image" },
        },
        appearsOn: { object: LOT, fills: "lot" },
        require: [{ that: { any: [{ is_null: { input: "torque" } }, { le: [{ input: "torque" }, 50] }] }, message: "A torque is at most 50 Nm.", field: "torque" }],
        steps: [{ create: DONE, set: { lot: { input: "lot" }, kind: "step", step: { input: "step" }, torque: { input: "torque" }, picture: { input: "picture" } } }],
        confirm: false, callers: { users: [], groups: ["production"] }, stewards: ["production"],
        scenarios: [lotScenario("step 1 done", { lot_id: `S-${tag}` }, MARK, { step: 1 }, { ok: true, created: { [DONE]: 1 } })],
    };
    const next = {
        name: NEXT, label: "Go on", description: "The lot's step at this operation, finished.",
        inputs: { lot: { label: "Lot", type: "ref", to: LOT, required: true } },
        appearsOn: { object: LOT, fills: "lot" }, require: [],
        steps: [{ on: "lot", set: { note: "went on" } }],
        confirm: false, callers: { users: [], groups: ["production"] }, stewards: ["production"],
        scenarios: [lotScenario("a lot goes on", { lot_id: `N-${tag}` }, NEXT, {}, { ok: true })],
    };
    const route = {
        name: ROUTE, label: `Cover route ${tag}`, description: "Open, seal, torque: each step a page of the cover guide.", kind: "route",
        participants: { lot: { object: LOT, as: "traveler" } }, context: {},
        nodes: {
            start: { kind: "start", label: "Start" },
            open: { kind: "sequence", label: "Open the cover", offers: [NEXT, MARK], leaves: [NEXT], guide: "1" },
            seal: { kind: "sequence", label: "Clean the seal", offers: [NEXT, MARK], leaves: [NEXT], guide: "2" },
            close: { kind: "sequence", label: "Torque the cover", offers: [NEXT, MARK], leaves: [NEXT], guide: "3" },
            done: { kind: "end", label: "Done", outcome: "done" },
        },
        edges: [{ from: "start", to: "open" }, { from: "open", to: "seal" }, { from: "seal", to: "close" }, { from: "close", to: "done" }],
        layout: { start: { x: 40, y: 60 }, open: { x: 220, y: 60 }, seal: { x: 400, y: 60 }, close: { x: 580, y: 60 }, done: { x: 760, y: 60 } },
        roles: { [LOT]: ["user"] }, stewards: ["production"],
        scenarios: [{ name: "Go on takes a lot to the seal", records: { lot: { object: LOT, data: { lot_id: `R-${tag}`, op: "open" } } }, steps: [{ as: "sam", do: { transaction: NEXT, input: { lot: "@lot" } }, expect: { ok: true, node: { lot: "seal" } } }] }],
    };
    // Verified by a second person, from Quality (§7.4): a final check.
    const verify = {
        ...mark, name: VERIFY, label: "Final check", description: "The cover's final check, verified by Quality.", require: [],
        steps: [{ create: DONE, set: { lot: { input: "lot" }, kind: "final", step: { input: "step" } } }],
        signature: { meaning: "Performed", verifier: { meaning: "Verified", departments: ["quality"] } },
        scenarios: [{ name: "checked, Quinn verifying", records: { lot: { object: LOT, data: { lot_id: `V-${tag}` } } }, steps: [{ as: "sam", do: { transaction: VERIFY, input: { lot: "@lot", step: 1 }, sign: { meaning: "Performed", agree: true, verifier: "quinn" } }, expect: { ok: true, created: { [DONE]: 1 } } }] }],
    };
    const done = { transaction: MARK, step: "step", fills: { lot: { param: "lot" } }, evidence: "picture", log: { object: DONE, where: { lot: { param: "lot" }, kind: "step" }, step: "step" }, gate: true };
    const screen = {
        name: SCREEN, label: `Guided station ${tag}`, description: "", params: { lot: { label: "Lot", type: "ref", to: LOT, required: true } },
        blocks: [
            { block: "media", title: "Cover guide", file: pdf.blob, name: "Cover guide", steps: "1 Remove the cover\n2 Torque to 12 Nm #value:torque\n3 The seal, seen #photo\n3 Pump down #device", done, width: 6 },
            { block: "media", title: "On the route", file: pdf.blob, name: "Cover guide", route: { flow: ROUTE, of: { param: "lot" } }, width: 6 },
            { block: "media", title: "Final check", file: pdf.blob, name: "Cover guide", steps: "3 The cover, checked", done: { ...done, transaction: VERIFY, log: { ...done.log, where: { lot: { param: "lot" }, kind: "final" } }, gate: false }, width: 6 },
        ],
        callers: { users: [], groups: ["production", "quality"] }, stewards: ["production"],
    };
    const wrong = await change({
        definitions: { [LOT]: lotDef, [DONE]: doneDef }, transactions: { [MARK]: mark, [NEXT]: next, [VERIFY]: verify }, flows: { [ROUTE]: route },
        screens: { [SCREEN]: { ...screen, blocks: [{ ...screen.blocks[0], steps: "1 Torque #value:nope\n2 Look #photo\n3 Go on #screen:nowhere", done: { ...done, evidence: undefined } }] } },
    }, LOT, `Guided lot ${tag}`, "Wrong on purpose.");
    const words = (wrong.saved.problems ?? []).map((p) => p.message).join("\n");
    await call("dana", "design.withdraw", { id: wrong.id });
    step("a guide whose steps name what is not there is refused, each step named: an input the transaction lacks, a photo with nowhere to go, a screen that is none",
        new RegExp(`step 1, "Torque": ${MARK} has no input "nope"`).test(words) && /step 2, "Look" is done with a photo: name the input it goes in/.test(words) && /step 3, "Go on": "nowhere" is not a screen/.test(words), wrong.saved.problems);
    // Who holds the objects' roles is the organization's to say (§27); here the test's people hold them, before
    // the scenarios run in the sandbox (which copies who holds what).
    await db.query("INSERT INTO mes.assignments (object, role, subject_kind, subject_id) SELECT o, 'user', 'user', u FROM unnest($1::text[]) o, unnest($2::text[]) u ON CONFLICT DO NOTHING", [[LOT, DONE], ["sam", "eli"]]);
    const made = await change({ definitions: { [LOT]: lotDef, [DONE]: doneDef }, transactions: { [MARK]: mark, [NEXT]: next, [VERIFY]: verify }, flows: { [ROUTE]: route }, screens: { [SCREEN]: screen } }, LOT, `Guided lot ${tag}`, "A station guide whose steps are marked done, and one that follows the route.");
    const live = await approveAll(made.id);
    step("the lot, its log of steps done, the transaction recording one, the route placed in the guide and the station: drafted together with no problems, approved, live",
        !made.saved.problems?.length && live.state === "executed", { problems: made.saved.problems, live });

    // ---- 2. as Sam sees it ----
    const lot1 = await call("sam", "records.create", { object: LOT, data: { lot_id: `L1-${tag}` }, key: key() });
    const lot2 = await call("sam", "records.create", { object: LOT, data: { lot_id: `L2-${tag}` }, key: key() });
    const data = async (lot) => (await call("sam", "screens.data", { name: SCREEN, arg: lot, as: "sam" })).blocks ?? [];
    const [g0] = await data(lot1.id);
    step("the guide as Sam sees it for a lot: nothing done; marked by the transaction, the lot filled in, a torque's input and a photo's, Next held until each is done",
        lot1.ok && g0?.steps?.map((s) => s.needs).join() === "click,value,photo,device" && Object.keys(g0.done?.list ?? { x: 1 }).length === 0 &&
        g0.done.transaction === MARK && g0.done.fills.lot === lot1.id && g0.done.step === "step" && g0.done.into.torque?.type === "decimal" && g0.done.into.torque.unit === "Nm" &&
        g0.done.into.picture?.type === "image" && g0.done.gate === true && g0.done.signed === false, { lot1, g0 });

    // ---- 3. each step done its way ----
    const run = (user, input) => call(user, "transactions.run", { name: MARK, input: { lot: lot1.id, ...input }, key: key() });
    const clicked = await run("sam", { step: 1 });
    const typed = await run("sam", { step: 2, torque: 12.5 });
    const tooMuch = await run("sam", { step: 2, torque: 80 });
    const png = await upload("sam", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"), "seal.png");
    const photo = await run("sam", { step: 3, picture: png.blob });
    // The equipment's: a record of the log written elsewhere (its service; here Eli, at another page).
    const device = await call("eli", "records.create", { object: DONE, data: { lot: lot1.id, kind: "step", step: 4 }, key: key() });
    const [g1] = await data(lot1.id);
    const [other] = await data(lot2.id);
    const rows = await db.query("SELECT data FROM mes.records WHERE object = $1 AND data->>'lot' = $2 ORDER BY (data->>'step')::int", [DONE, lot1.id]);
    const list = g1?.done?.list ?? {};
    step("each step done its way: a click, a torque typed (one out of its range refused, in words), a photo; and one by the equipment, written elsewhere: each shown done, by whom; another lot's guide shows none",
        clicked.ok && typed.ok && tooMuch.status === 422 && /at most 50 Nm/.test(JSON.stringify([tooMuch.error, tooMuch.fields])) && photo.ok && device.ok &&
        list[1]?.by === "sam" && list[2]?.by === "sam" && list[3]?.by === "sam" && list[4]?.by === "eli" && typeof list[4].name === "string" && list[4].name !== "eli" && list[1].at &&
        rows.length === 4 && Number(rows[1].data.torque) === 12.5 && rows[2].data.picture === png.blob && Object.keys(other?.done?.list ?? { x: 1 }).length === 0,
        { clicked, typed, tooMuch, photo, device, list, rows: rows.map((r) => r.data), other: other?.done });

    // ---- 4. the guide that follows the route ----
    const [, r0] = await data(lot1.id);
    const went = await call("sam", "transactions.run", { name: NEXT, input: { lot: lot1.id }, key: key() });
    const [, r1] = await data(lot1.id);
    step("the guide following the route: its steps the sequences placed in it, the lot at the first; once Go on has run, the route has gone on, and that step shows done, by Sam",
        r0?.steps?.map((s) => `${s.n}:${s.at}:${s.label}`).join("|") === "1:1:Open the cover|2:2:Clean the seal|3:3:Torque the cover" && r0.route?.current === 1 && Object.keys(r0.done?.list ?? { x: 1 }).length === 0 && r0.steps[0].leaves?.[0] === "Go on" &&
        went.ok && r1?.route?.current === 2 && r1.route.nodeLabel === "Clean the seal" && r1.done?.list?.[1]?.by === "sam" && !r1.done.list[2],
        { r0, went, r1 });

    // ---- 5. undo ----
    const before = (await data(lot1.id))[0]?.done?.list?.[1];
    const undone = await call("sam", "records.archive", { object: DONE, id: before?.id, rowVersion: before?.rowVersion, key: key() });
    const after = (await data(lot1.id))[0]?.done?.list ?? {};
    const [kept] = await db.query("SELECT archived_at, archived_by FROM mes.records WHERE object = $1 AND id = $2", [DONE, before?.id ?? null]);
    const again = await run("sam", { step: 1 });
    const redone = (await data(lot1.id))[0]?.done?.list?.[1];
    step("undo: Sam, who may archive the log's records, undoes step 1; it shows not done, its record archived and kept; marked again, the new record counts",
        before?.undo === true && undone.ok && !after[1] && after[2] && kept?.archived_at && kept.archived_by === "sam" && again.ok && redone?.id && redone.id !== before.id, { before, undone, after, kept, redone });

    // ---- 6. verified by a second person ----
    const v0 = (await data(lot1.id))[2]?.done;
    const alone = await call("sam", "transactions.run", { name: VERIFY, input: { lot: lot1.id, step: 1 }, key: key(), signature: { meaning: "Performed", agree: true } });
    const joined = await call("sam", "auth.second.join", { id: "quinn" });
    const verified = await call("sam", "transactions.run", { name: VERIFY, input: { lot: lot1.id, step: 1 }, key: key(), signature: { meaning: "Performed", agree: true } });
    await call("sam", "auth.second.leave", {});
    const [g6, , v1] = await data(lot1.id);
    const [entry] = await db.query("SELECT after FROM mes.audit_log WHERE object = '$transaction' AND action = $1 ORDER BY seq DESC LIMIT 1", [`run:${VERIFY}`]);
    step("a step Quality verifies: the page is told who verifies it; refused with nobody beside Sam; with Quinn beside, done, the audit entry naming both",
        v0?.verifier === "Verified" && v0.meaning === "Performed" && !alone.ok && /second person/.test(alone.error ?? "") && joined.ok && verified.ok &&
        entry?.after?.signature?.by?.id === "sam" && entry.after.signature.verifier?.id === "quinn" &&
        // Each guide reads its own records of the log: the final check is not one of the cover's steps.
        v1?.done?.list?.[1]?.by === "sam" && g6?.done?.list?.[1]?.id === redone.id, { v0, alone, joined, verified, signature: entry?.after?.signature, v1: v1?.done?.list });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close?.().catch(() => {});
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
