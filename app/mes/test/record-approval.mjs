// Approval of record changes (§28), end to end against a running server:
//   1. Lot's design, changed through the lifecycle, says: a lot's quantity, new lots and holding a lot
//      wait for approval when changed outside a transaction.
//   2. Olga changes a lot's quantity on its form: asked why first; then it waits, the lot as it was,
//      showing what waits and for whom. A second change waits behind it; Sam may not ask for one only
//      he could approve. Production (Sam) and Quality (Quinn) sign; it is applied, as Olga, audited.
//   3. What does not wait: another field (the unit), and the same quantity through a transaction.
//   4. Rejected (with why), withdrawn (by its requester only), and void: the lot changed before the
//      last signature, so nothing is written.
//   5. A new lot and a hold wait too, and are applied once signed; an Excel import's new lot waits.
//   5b. Who approves by the lot's value (its unit: kg by Engineering, l by Quality): a quantity asked on a kg
//      lot waits for Engineering alone; moving a lot from kg to l, for both.
//   5c. Engineering's mailbox (People & departments) is told of a change that waits for it: what, which
//      fields by label (never values), why, who, and where to sign. Archiving waits too, and is applied.
//   5d. A group (Eli of Engineering, Quinn of Quality) approves a kg lot's quantity: any one member signs, its
//      mailbox is told; a transaction that sets the quantity is approved by the group as it is designed, and
//      its runs never wait; the group is not removed while Lot's approval names it.
//   6. Put back: what still waits is withdrawn, and lot's design no longer asks for approval (a change).
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/record-approval.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { writeXlsx } from "../server/xlsx.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;

const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
const { url: mes } = await app.listen({ port: 0 });
const sessions = {};
for (const user of ["dana", "eli", "vera", "sam", "quinn", "olga"]) {
    sessions[user] = `ra-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status, body, code: body.code });
    return body;
};
const attempt = (p) => p.then((value) => ({ ok: true, value }), (e) => ({ ok: false, status: e.status, message: e.message, code: e.code, fields: e.body?.fields }));
const key = () => `ra-${randomBytes(8).toString("hex")}`;
const rec = async (id) => (await db.query("SELECT state, data, row_version FROM mes.records WHERE id = $1", [id]))[0];
const sign = (user, id, department, decision = "approve", note) => call(user, "requests.approve", { id, department, decision, meaning: decision === "approve" ? "Approved" : "Rejected", note });

try {
    // Lots to work on, made before their changes wait.
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' ORDER BY created_at LIMIT 1");
    const newLot = (no, qty = 100) => call("sam", "records.create", { object: "lot", data: { lot_no: `${no}-${tag}`, item: "PP-BLK-10", work_order: wo.id, qty, uom: "kg" }, key: key() });
    const [a, b, c, d] = [await newLot("RA"), await newLot("RB"), await newLot("RC"), await newLot("RD")];
    for (const lot of [a, b, c, d]) await call("sam", "records.action", { object: "lot", id: lot.id, action: "start", rowVersion: 1, key: key() });

    // A reference names a record of its object that the writer may read: not any id that is well formed.
    const stray = await attempt(call("sam", "records.create", { object: "lot", data: { lot_no: `RX-${tag}`, item: "PP-BLK-10", work_order: "00000000-0000-4000-8000-000000000000", qty: 1, uom: "kg" }, key: key() }));
    const wrongKind = await attempt(call("sam", "records.update", { object: "lot", id: a.id, rowVersion: 2, data: { work_order: b.id }, key: key() }));
    step("a reference to no record, or to a record of another object, is refused at its field", !stray.ok && /work order you can see/i.test(JSON.stringify(stray)) && !wrongKind.ok, { stray, wrongKind });

    // ---- 1. the design ----
    const change = await call("dana", "design.start", { object: "lot" });
    const lot = (await call("dana", "design.change", { id: change.id, as: "dana" })).content.definitions.lot;
    lot.approval = { edit: { fields: ["qty"] }, create: true, actions: ["hold"] };
    // Vera (a viewer) reads lots, but not their quantity: a request must not show it to her either.
    lot.policies.push({ id: "ra-hide-qty", roles: ["viewer"], deny: { read: ["qty"] } });
    const bad = await call("dana", "design.save", { id: change.id, reason: "x", definitions: { lot: { ...lot, approval: { edit: { fields: ["weight"] }, actions: ["fly"] } } } });
    step("the design's mistakes named: a field and an action it does not have", bad.problems.some((p) => /"weight" is not a field/.test(p.message)) && bad.problems.some((p) => /"fly" is not an action/.test(p.message)), bad.problems);
    await call("dana", "design.save", { id: change.id, reason: "A lot's quantity, new lots and holds are approved by the stewards.", definitions: { lot } });
    await call("dana", "design.submit", { id: change.id });
    await call("vera", "design.review", { id: change.id, decision: "pass" });
    for (const [who, dept] of (await call("dana", "design.change", { id: change.id, as: "dana" })).route.map((r) => [{ production: "sam", quality: "quinn", engineering: "eli" }[r.department], r.department])) await call(who, "design.approve", { id: change.id, department: dept, decision: "approve", meaning: "Approved" });
    const published = await call("olga", "defs.get", { object: "lot", as: "olga" });
    step("published; the form is told which changes wait, and its stewards (who approve them)", JSON.stringify(published.approval) === JSON.stringify(lot.approval) && JSON.stringify(published.stewards) === JSON.stringify(lot.stewards), { approval: published.approval, stewards: published.stewards });

    // ---- 2. a quantity, asked for ----
    const noWhy = await attempt(call("olga", "records.update", { object: "lot", id: a.id, rowVersion: 2, data: { qty: 95 }, key: key() }));
    step("without a reason: asked why, naming who approves", !noWhy.ok && noWhy.code === "record.reason" && /waits for approval by production, quality: say why/.test(noWhy.message), noWhy);
    const asked = await call("olga", "records.update", { object: "lot", id: a.id, rowVersion: 2, data: { qty: 95 }, key: key(), reason: "Recount after spill." });
    step("with one: a request, not a write; the lot as it was", asked.$request?.state === "pending" && asked.$request.route.join() === "production,quality" && (await rec(a.id)).data.qty === 100, asked);
    const shown = await call("olga", "requests.ofRecord", { object: "lot", id: a.id, as: "olga" });
    step("the lot shows what waits: 100 → 95, why, for whom", shown?.changes.map((x) => `${x.field}:${x.before}→${x.after}`).join() === "qty:100→95" && shown.reason === "Recount after spill." && shown.departments.map((x) => `${x.department}:${x.waitingFor.join("/")}`).join() === "production:sam,quality:quinn" && shown.can.withdraw && !shown.can.approveFor.length, shown);
    const veras = await call("vera", "requests.ofRecord", { object: "lot", id: a.id, as: "vera" });
    const samsView = await call("sam", "requests.ofRecord", { object: "lot", id: a.id, as: "sam" });
    step("who may read the lot but not its quantity sees that it waits, not the values; who approves it sees them",
        veras?.changes.length === 1 && veras.changes[0].field === "qty" && veras.changes[0].hidden === true && veras.changes[0].before === null && veras.changes[0].after === null && !JSON.stringify(veras.changes).includes("95")
        && samsView.changes[0].after === 95 && !samsView.changes[0].hidden, { veras: veras?.changes, sam: samsView.changes });
    // …and the lot's page itself, drawn for each of them (the request's card is part of it).
    const pageFor = async (user) => { const res = await fetch(`${mes}/o/lot/${a.id}`, { headers: { cookie: `mes_session=${sessions[user]}` } }); return { status: res.status, html: await res.text(), csp: res.headers.get("content-security-policy") ?? "" }; };
    const [veraPage, samPage] = [await pageFor("vera"), await pageFor("sam")];
    // Only the designer's pages may build a function from text (its editors parse scripts that way).
    const designCsp = (await fetch(`${mes}/design`, { headers: { cookie: `mes_session=${sessions.dana}` } })).headers.get("content-security-policy") ?? "";
    step("the lot's page is drawn for both: hers says the values are hidden from her, his shows them; each page says what it may load",
        veraPage.status === 200 && veraPage.html.includes("hidden from you") && !/req-after[^>]*>95</.test(veraPage.html) && samPage.status === 200 && /req-after[^>]*>95</.test(samPage.html) && !samPage.html.includes("hidden from you")
        && /script-src 'self' 'sha256-/.test(veraPage.csp) && /frame-ancestors 'none'/.test(veraPage.csp) && !/script-src[^;]*'unsafe-(inline|eval)'/.test(veraPage.csp) && /script-src 'self' 'unsafe-eval' 'sha256-/.test(designCsp),
        { vera: [veraPage.status, veraPage.html.includes("hidden from you")], sam: [samPage.status, /req-after[^>]*>95</.test(samPage.html)], csp: veraPage.csp });
    const second = await attempt(call("olga", "records.update", { object: "lot", id: a.id, rowVersion: 2, data: { qty: 90 }, key: key(), reason: "again" }));
    step("a second change to it waits behind the first: refused", !second.ok && second.code === "record.pending", second);
    const own = await attempt(call("sam", "records.update", { object: "lot", id: b.id, rowVersion: 2, data: { qty: 97 }, key: key(), reason: "mine" }));
    step("Sam may not ask for a change only he could approve for Production", !own.ok && own.code === "record.no_approver" && /Nobody but you could approve it for production/.test(own.message), own);
    const inbox = await call("quinn", "requests.list", { as: "quinn" });
    step("on Quinn's approvals list, hers to sign", inbox.pending.some((r) => r.id === asked.$request.id && r.mine), inbox.pending.map((r) => [r.id, r.mine]));
    const samsInbox = await call("sam", "inbox.mine", { as: "sam" });
    step("beside Sam's name: it waits for him, named, linking to it", samsInbox.items.some((i) => i.kind === "sign" && i.record && i.id === asked.$request.id && i.department === "production" && /^Change to Lot RA-/.test(i.title) && i.link === `/request/${asked.$request.id}`) && samsInbox.count === samsInbox.items.length, samsInbox);
    step("…not beside Olga's: she asked for it", !(await call("olga", "inbox.mine", { as: "olga" })).items.some((i) => i.id === asked.$request.id));
    const notOlga = await attempt(sign("olga", asked.$request.id, "production"));
    step("Olga cannot sign her own", !notOlga.ok && notOlga.status === 403, notOlga);
    await sign("sam", asked.$request.id, "production");
    step("once Sam has signed, it leaves his list", !(await call("sam", "inbox.mine", { as: "sam" })).items.some((i) => i.id === asked.$request.id));
    step("after Production, still waiting for Quality; the lot unchanged", (await rec(a.id)).data.qty === 100 && (await call("olga", "requests.ofRecord", { object: "lot", id: a.id, as: "olga" })).departments.find((x) => x.department === "quality").status === "pending");
    const done = await sign("quinn", asked.$request.id, "quality");
    const afterA = await rec(a.id);
    step("after Quality: applied, as Olga", done.request.state === "applied" && afterA.data.qty === 95 && Number(afterA.row_version) === 3, { done, afterA });
    const trail = await db.query("SELECT actor, action FROM mes.audit_log WHERE object = 'lot' AND record_id = $1 ORDER BY seq", [a.id]);
    step("the lot's history: asked, signed twice, applied, the update by Olga", trail.map((t) => `${t.actor}:${t.action}`).slice(-5).join() === "olga:request:edit,sam:request:approve,quinn:request:approve,olga:update,platform:request:applied", trail);
    step("nothing waits on it any more", (await call("olga", "requests.ofRecord", { object: "lot", id: a.id, as: "olga" })) === null);

    // ---- 3. what does not wait ----
    const unit = await call("olga", "records.update", { object: "lot", id: a.id, rowVersion: 3, data: { uom: "l" }, key: key() });
    step("another field (the unit) is written at once", !unit.$request && unit.uom === "l" && (await rec(a.id)).data.uom === "l", unit);
    const [machine] = await db.query("SELECT id FROM mes.records WHERE object = 'machine' AND state = 'idle' ORDER BY data->>'machine_id' LIMIT 1");
    await call("olga", "transactions.run", { name: "move_in", input: { lot: c.id, machine: machine.id }, key: key() });
    await call("olga", "transactions.run", { name: "track_in", input: { lot: c.id }, key: key() });
    await call("olga", "transactions.run", { name: "track_out", input: { lot: c.id, good_qty: 98, scrap_qty: 2, scrap_reason: "setup" }, key: key() });
    await call("olga", "transactions.run", { name: "move_out", input: { lot: c.id }, key: key() });
    step("a transaction sets the quantity without waiting: it is the approved way", (await rec(c.id)).data.qty === 98 && !(await call("olga", "requests.ofRecord", { object: "lot", id: c.id, as: "olga" })));

    // ---- 4. rejected, withdrawn, void ----
    const r1 = await call("olga", "records.update", { object: "lot", id: b.id, rowVersion: 2, data: { qty: 80 }, key: key(), reason: "Short delivery." });
    const noNote = await attempt(sign("quinn", r1.$request.id, "quality", "reject"));
    step("a rejection says why", !noNote.ok && /Say why it is rejected/.test(noNote.message), noNote);
    const rejected = await sign("quinn", r1.$request.id, "quality", "reject", "The delivery note says 100.");
    step("rejected: nothing written, and Production need not sign", rejected.request.state === "rejected" && (await rec(b.id)).data.qty === 100 && /The delivery note says 100/.test(rejected.request.outcome), rejected);
    const r2 = await call("olga", "records.update", { object: "lot", id: b.id, rowVersion: 2, data: { qty: 85 }, key: key(), reason: "Try again." });
    const notHers = await attempt(call("sam", "requests.withdraw", { id: r2.$request.id }));
    const back = await call("olga", "requests.withdraw", { id: r2.$request.id });
    step("withdrawn by its requester only", !notHers.ok && notHers.status === 403 && back.request.state === "withdrawn" && (await rec(b.id)).data.qty === 100, { notHers, back });
    const r3 = await call("olga", "records.update", { object: "lot", id: b.id, rowVersion: 2, data: { qty: 90 }, key: key(), reason: "Recount." });
    await call("olga", "records.update", { object: "lot", id: b.id, rowVersion: 2, data: { uom: "l" }, key: key() }); // the lot changes meanwhile
    await sign("sam", r3.$request.id, "production");
    const voided = await sign("quinn", r3.$request.id, "quality");
    step("void: the lot changed before the last signature, so nothing is written, and it says why", voided.request.state === "void" && /changed after this was asked for/.test(voided.request.outcome) && (await rec(b.id)).data.qty === 100, voided);

    // ---- 5. a new lot, a hold, an import ----
    const made = await call("olga", "records.create", { object: "lot", data: { lot_no: `RN-${tag}`, item: "PP-BLK-10", work_order: wo.id, qty: 50, uom: "kg" }, key: key(), reason: "Sample lot." });
    const beforeCount = (await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = 'lot' AND data->>'lot_no' = $1", [`RN-${tag}`]))[0].n;
    await sign("sam", made.$request.id, "production");
    const madeDone = await sign("quinn", made.$request.id, "quality");
    const [newRow] = await db.query("SELECT created_by, state FROM mes.records WHERE object = 'lot' AND data->>'lot_no' = $1", [`RN-${tag}`]);
    step("a new lot waits, then exists once signed, made by Olga", beforeCount === 0 && madeDone.request.state === "applied" && madeDone.request.record_id && newRow?.created_by === "olga" && newRow.state === "created", { madeDone, newRow });
    const hold = await call("olga", "records.action", { object: "lot", id: d.id, action: "hold", rowVersion: 2, key: key(), reason: "Suspect contamination." });
    const holdShown = await call("quinn", "requests.get", { id: hold.$request.id, as: "quinn" });
    step("a hold waits, shown as the action and where it leads", holdShown.op === "action" && holdShown.actionLabel === "Hold" && holdShown.to === "on_hold" && (await rec(d.id)).state === "in_process", holdShown);
    await sign("sam", hold.$request.id, "production");
    await sign("quinn", hold.$request.id, "quality");
    step("…and is taken once signed", (await rec(d.id)).state === "on_hold");
    const book = writeXlsx([{ name: "lot", rows: [["lot_no", "item", "work_order", "qty", "uom"], [`RX-${tag}`, "PP-BLK-10", (await db.query("SELECT data->>'wo_no' AS n FROM mes.records WHERE id = $1", [wo.id]))[0].n, 10, "kg"]] }]);
    const post = (query) => fetch(`${mes}/transfer/import?${query}`, { method: "POST", headers: { cookie: `mes_session=${sessions.olga}`, origin: mes }, body: book }).then((r) => r.json());
    const preview = await post("apply=0");
    step("an import's preview says the new lot would wait", preview.models?.[0]?.counts.approval === 1 && preview.models[0].counts.create === 0, preview);
    const imported = await post(`apply=1&reason=${encodeURIComponent("Lots from the ERP cut-over.")}`);
    const [importReq] = await db.query("SELECT reason, state FROM mes.record_requests WHERE id = $1", [imported.models?.[0]?.rows?.[0]?.request ?? null]);
    step("applied: it waits as a request, with the import's reason", imported.models?.[0]?.counts.approval === 1 && importReq?.state === "pending" && importReq.reason === "Excel import: Lots from the ERP cut-over.", { imported, importReq });

    // ---- 5b. who approves, by the lot's value (§28.3a): its unit, kg by Engineering, l by Quality ----
    await call("olga", "requests.withdraw", { id: imported.models[0].rows[0].request });
    const byChange = await call("dana", "design.start", { object: "lot" });
    const byLot = (await call("dana", "design.change", { id: byChange.id, as: "dana" })).content.definitions.lot;
    byLot.approval = { edit: { fields: ["qty", "uom"] }, archive: true, by: { field: "uom", values: { kg: ["engineering"], l: ["quality"] } } };
    const badBy = await call("dana", "design.save", { id: byChange.id, reason: "x", definitions: { lot: { ...byLot, approval: { edit: true, by: { field: "uom", values: { gallon: ["ghost"] } } } } } });
    step("approval by a value is checked as it is designed: a value the field does not have, a department that does not exist",
        badBy.problems.some((p) => /"gallon" is not one of Unit's values/.test(p.message)) && badBy.problems.some((p) => /"ghost" \(for gallon\) is not a department/.test(p.message)), badBy.problems);
    await call("dana", "design.save", { id: byChange.id, reason: "A lot's quantity is approved by the department of its unit.", definitions: { lot: byLot } });
    await call("dana", "design.submit", { id: byChange.id });
    await call("vera", "design.review", { id: byChange.id, decision: "pass" });
    for (const [who, dept] of (await call("dana", "design.change", { id: byChange.id, as: "dana" })).route.map((r) => [{ production: "sam", quality: "quinn", engineering: "eli" }[r.department], r.department])) await call(who, "design.approve", { id: byChange.id, department: dept, decision: "approve", meaning: "Approved" });
    const e = await newLot("RE");
    const kgAsked = await call("olga", "records.update", { object: "lot", id: e.id, rowVersion: 1, data: { qty: 90 }, key: key(), reason: "Weighed again." });
    const kgShown = await call("olga", "requests.ofRecord", { object: "lot", id: e.id, as: "olga" });
    step("a kg lot's quantity waits for Engineering alone (in place of the stewards), and says for which value",
        kgAsked.$request?.route.join() === "engineering" && kgShown.departments.length === 1 && kgShown.departments[0].because.includes("value:uom=kg") && kgShown.departments[0].waitingFor.includes("eli"), { route: kgAsked.$request?.route, kgShown: kgShown?.departments });
    await sign("eli", kgAsked.$request.id, "engineering");
    const kgDone = await rec(e.id);
    const moved = await call("olga", "records.update", { object: "lot", id: e.id, rowVersion: Number(kgDone.row_version), data: { uom: "l" }, key: key(), reason: "Liquid after all." });
    step("signed by Engineering, it is applied; moving it from kg to l is signed by both: the unit it leaves and the one it joins",
        kgDone.data.qty === 90 && moved.$request?.route.join() === "engineering,quality", { qty: kgDone.data.qty, route: moved.$request?.route });
    await call("olga", "requests.withdraw", { id: moved.$request.id });

    // ---- 5c. a department's mailbox told what waits for it (§28.6); archiving waits too ----
    const orgChange = await call("dana", "design.start", { organization: true });
    const org = (await call("dana", "design.change", { id: orgChange.id, as: "dana" })).content.organization;
    const badMail = await call("dana", "design.save", { id: orgChange.id, reason: "x", organization: { ...org, departments: { ...org.departments, quality: { ...org.departments.quality, email: "quality at plant" } } } });
    org.departments.engineering.email = "engineering@plant.example";
    await call("dana", "design.save", { id: orgChange.id, reason: "Engineering's mailbox, told what waits for it.", organization: org });
    await call("dana", "design.submit", { id: orgChange.id });
    await call("vera", "design.review", { id: orgChange.id, decision: "pass" });
    for (const [who, dept] of (await call("dana", "design.change", { id: orgChange.id, as: "dana" })).route.map((r) => [{ production: "sam", quality: "quinn", engineering: "eli" }[r.department], r.department])) await call(who, "design.approve", { id: orgChange.id, department: dept, decision: "approve", meaning: "Approved" });
    const orgNow = await call("dana", "design.change", { id: (await call("dana", "design.start", { organization: true })).id, as: "dana" });
    step("a department's mailbox is checked as it is designed, and kept with People & departments",
        badMail.problems?.some((p) => /"quality at plant" is not an email address/.test(p.message)) && orgNow.content.organization.departments.engineering.email === "engineering@plant.example",
        { bad: badMail.problems, kept: orgNow.content.organization.departments.engineering });
    await call("dana", "design.withdraw", { id: orgNow.id }).catch(() => {});
    const eNow = await rec(e.id);
    const mailed = await call("olga", "records.update", { object: "lot", id: e.id, rowVersion: Number(eNow.row_version), data: { qty: 85 }, key: key(), reason: "Second weighing." });
    const [letter] = await db.query("SELECT to_addr, subject, body FROM mes.mail_outbox WHERE key = $1", [`request:${mailed.$request.id}:engineering`]);
    step("its mailbox is told, with the request: what waits, the field it changes by its label (not its values), why, who asked, and where to sign",
        letter?.to_addr === "engineering@plant.example" && /^To approve for Engineering: Change to Lot RE-/.test(letter.subject) && /It changes: Quantity\./.test(letter.body) && /Why: Second weighing\./.test(letter.body)
        && letter.body.includes(`/request/${mailed.$request.id}`) && /\(for kg\)/.test(letter.body) && !/\b85\b|\b90\b/.test(letter.body),
        letter);
    await call("olga", "requests.withdraw", { id: mailed.$request.id });
    // (Lots are archived on hold or consumed, their disposition decided: started, held and rejected first.)
    await call("sam", "records.action", { object: "lot", id: e.id, action: "start", rowVersion: Number((await rec(e.id)).row_version), key: key() });
    await call("sam", "records.action", { object: "lot", id: e.id, action: "hold", rowVersion: Number((await rec(e.id)).row_version), key: key() });
    await call("quinn", "records.update", { object: "lot", id: e.id, rowVersion: Number((await rec(e.id)).row_version), data: { disposition: "reject" }, key: key() });
    const eBefore = await rec(e.id);
    const archiving = await call("sam", "records.archive", { object: "lot", id: e.id, rowVersion: Number(eBefore.row_version), key: key(), reason: "A duplicate of another lot." });
    const stillThere = await db.query("SELECT archived_at FROM mes.records WHERE id = $1", [e.id]);
    await sign("eli", archiving.$request.id, "engineering");
    const gone = await db.query("SELECT archived_at, archived_by FROM mes.records WHERE id = $1", [e.id]);
    step("archiving (the MES deletes nothing) waits for approval like a change, by the lot's unit, and is applied, as Sam (who may archive lots), once signed",
        archiving.$request?.op === "archive" && archiving.$request.route.join() === "engineering" && stillThere[0].archived_at === null && gone[0].archived_at !== null && gone[0].archived_by === "sam",
        { archiving: archiving.$request, gone });

    // ---- 5d. a group approves (§28.3a): people from two departments, any one of them signs ----
    // A change through the whole lifecycle: saved, submitted, reviewed and signed by each department on its route.
    const through = async (start, save) => {
        const ch = await call("dana", "design.start", start);
        const saved = await call("dana", "design.save", { id: ch.id, ...save });
        if (saved.problems?.length) return { id: ch.id, problems: saved.problems };
        await call("dana", "design.submit", { id: ch.id });
        await call("vera", "design.review", { id: ch.id, decision: "pass" });
        for (const [who, dept] of (await call("dana", "design.change", { id: ch.id, as: "dana" })).route.map((r) => [{ production: "sam", quality: "quinn", engineering: "eli" }[r.department], r.department])) await call(who, "design.approve", { id: ch.id, department: dept, decision: "approve", meaning: "Approved" });
        return { id: ch.id, problems: [] };
    };
    const orgNow2 = (await call("dana", "design.change", { id: (await call("dana", "design.start", { organization: true })).id, as: "dana" }));
    await call("dana", "design.withdraw", { id: orgNow2.id }).catch(() => {});
    const withTeam = { ...orgNow2.content.organization, groups: { ...(orgNow2.content.organization.groups ?? {}), lot_team: { name: "Lot team", email: "lot-team@plant.example", members: ["eli", "quinn"] } } };
    const teamMade = await through({ organization: true }, { reason: "A lot team from engineering and quality.", organization: withTeam });
    const lotNow = (await call("dana", "design.change", { id: (await call("dana", "design.start", { object: "lot" })).id, as: "dana" }));
    await call("dana", "design.withdraw", { id: lotNow.id }).catch(() => {});
    const teamLot = { ...lotNow.content.definitions.lot, approval: { edit: { fields: ["qty", "uom"] }, by: { field: "uom", values: { kg: ["lot_team"], l: ["quality"] } } } };
    const teamNamed = await through({ object: "lot" }, { reason: "A kg lot's quantity is approved by the lot team.", definitions: { lot: teamLot } });
    step("a group of people from two departments is made in People & departments, with its mailbox, and named by a value of Lot's approval",
        !teamMade.problems.length && !teamNamed.problems.length && (await db.query("SELECT 1 FROM mes.groups WHERE id = 'lot_team' AND kind = 'group'")).length === 1, { teamMade, teamNamed });
    const g = await newLot("RG");
    const teamAsked = await call("olga", "records.update", { object: "lot", id: g.id, rowVersion: 1, data: { qty: 75 }, key: key(), reason: "Recounted." });
    const teamShown = await call("olga", "requests.ofRecord", { object: "lot", id: g.id, as: "olga" });
    const [teamLetter] = await db.query("SELECT to_addr, subject FROM mes.mail_outbox WHERE key = $1", [`request:${teamAsked.$request?.id}:lot_team`]);
    step("a kg lot's quantity waits for the group, any of its members may sign (Eli of Engineering, Quinn of Quality), and its mailbox is told",
        teamAsked.$request?.route.join() === "lot_team" && ["eli", "quinn"].every((u) => teamShown.departments[0]?.waitingFor?.includes(u)) && teamLetter?.to_addr === "lot-team@plant.example" && /^To approve for Lot team: Change to Lot RG-/.test(teamLetter.subject),
        { route: teamAsked.$request?.route, shown: teamShown?.departments, teamLetter });
    await sign("quinn", teamAsked.$request.id, "lot_team");
    step("one member's signature is the group's: Quinn signs, and it is applied", (await rec(g.id)).data.qty === 75, await rec(g.id));
    // §28.3b: a transaction that writes what the group's approval controls is approved by the group as it is
    // designed, once; its runs never wait.
    const TXN = `ra_recount_${tag}`;
    const recount = {
        name: TXN, label: `Recount a lot ${tag}`, description: "Sets a lot's counted quantity.",
        inputs: { lot: { label: "Lot", type: "ref", to: "lot", required: true }, qty: { label: "Counted", type: "decimal", required: true } },
        require: [], steps: [{ on: "lot", set: { qty: { input: "qty" } } }],
        callers: { users: [], groups: ["production"] }, stewards: ["production"],
        scenarios: [{ name: "a lot recounted", records: { lot: { object: "lot", where: { lot_no: `RG-${tag}` } } }, steps: [{ as: "olga", do: { transaction: TXN, input: { lot: "@lot", qty: 70 } }, expect: { ok: true } }] }],
    };
    const txChange = await call("dana", "design.start", { transaction: TXN, label: recount.label });
    const txSaved = await call("dana", "design.save", { id: txChange.id, reason: "Recounting a lot on the floor.", transactions: { [TXN]: recount } });
    await call("dana", "design.submit", { id: txChange.id });
    await call("vera", "design.review", { id: txChange.id, decision: "pass" });
    const txRoute = (await call("dana", "design.change", { id: txChange.id, as: "dana" })).route.map((r) => r.department);
    const eliSees = await call("eli", "design.change", { id: txChange.id, as: "eli" });
    step("a transaction that sets a lot's quantity is approved, as it is designed, by the group Lot's approval names: Eli (Engineering) may sign for it",
        txRoute.includes("lot_team") && (eliSees.can?.approveFor ?? []).includes("lot_team"), { txRoute, can: eliSees.can, problems: txSaved.problems });
    for (const [who, dept] of txRoute.map((d) => [{ production: "sam", quality: "quinn", engineering: "eli", lot_team: "eli" }[d], d])) await call(who, "design.approve", { id: txChange.id, department: dept, decision: "approve", meaning: "Approved" });
    const recounted = await newLot("RH");
    const ran = await call("olga", "transactions.run", { name: TXN, input: { lot: recounted.id, qty: 61 }, key: key() });
    step("…and, approved once, its runs never wait: the quantity is set at once, nothing is asked",
        (await rec(recounted.id)).data.qty === 61 && !(await db.query("SELECT 1 FROM mes.record_requests WHERE record_id = $1", [recounted.id])).length, { ran, rec: await rec(recounted.id) });
    const { groups: _, ...noTeam } = withTeam;
    const removing = await call("dana", "design.start", { organization: true });
    const refused = await call("dana", "design.save", { id: removing.id, reason: "x", organization: { ...noTeam, groups: Object.fromEntries(Object.entries(withTeam.groups).filter(([k]) => k !== "lot_team")) } });
    step("a group Lot's approval still names is not removed: the check says where it is named",
        refused.problems?.some((p) => /Group lot_team is named by Lot's approval by value/.test(p.message)), refused.problems);
    await call("dana", "design.withdraw", { id: removing.id }).catch(() => {});

    // ---- 6. put back, for the suites after this one ----
    const undo = await call("dana", "design.start", { object: "lot" });
    const plain = (await call("dana", "design.change", { id: undo.id, as: "dana" })).content.definitions.lot;
    delete plain.approval;
    plain.policies = plain.policies.filter((r) => r.id !== "ra-hide-qty");
    await call("dana", "design.save", { id: undo.id, reason: "Back as it was.", definitions: { lot: plain } });
    await call("dana", "design.submit", { id: undo.id });
    await call("vera", "design.review", { id: undo.id, decision: "pass" });
    for (const [who, dept] of (await call("dana", "design.change", { id: undo.id, as: "dana" })).route.map((r) => [{ production: "sam", quality: "quinn", engineering: "eli" }[r.department], r.department])) await call(who, "design.approve", { id: undo.id, department: dept, decision: "approve", meaning: "Approved" });
    // The lot team goes, now that nothing names it.
    const orgBack = (await call("dana", "design.change", { id: (await call("dana", "design.start", { organization: true })).id, as: "dana" }));
    await call("dana", "design.withdraw", { id: orgBack.id }).catch(() => {});
    const teamGone = await through({ organization: true }, { reason: "The lot team is no longer needed.", organization: { ...orgBack.content.organization, groups: Object.fromEntries(Object.entries(orgBack.content.organization.groups ?? {}).filter(([k]) => k !== "lot_team")) } });
    step("put back: the group, named by nothing now, is removed", !teamGone.problems.length, teamGone.problems);
    // The lot archived above, back in use: the suites after this one count lots.
    await call("sam", "records.restore", { object: "lot", id: e.id, rowVersion: Number((await rec(e.id)).row_version), key: key() });
    step("put back: nothing waits, and lot's design asks for no approval", !(await call("olga", "defs.get", { object: "lot", as: "olga" })).approval && !(await db.query("SELECT 1 FROM mes.record_requests WHERE state = 'pending'")).length);
} catch (error) {
    step("the test ran to the end", false, { error: error.message, body: error.body });
} finally {
    await app.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
