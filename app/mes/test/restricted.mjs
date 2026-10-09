// Certifications and what an object's access requires (DESIGN.md §27.9, §9.9), end to end over HTTP on the seed:
//   1. People & departments lists ITAR, through a change.
//   2. Certifications recorded: one of a kind it does not list refused; Eli's in date, Quinn's out of date.
//   3. Products, lots and wafers whose access requires ITAR when military: the lot's and the wafer's
//      "military" derived from their product, through their references (§6.11).
//   4. Who sees a military lot: in a list (its count too), opened by its id, found by search, in a query
//      view, in analytics: Eli (ITAR) does; Sam (none), Quinn (out of date) and Iris (reads every record) do not.
//   5. A write that would leave a record reserved from its writer is refused, in words.
//   6. Revoked, then reinstated: Eli's access follows at once.
//   7. The product reclassified: its lots and wafers open to everyone, in the same write.
//   8. What a design check refuses: a certification the organization does not list; taking one off the
//      list while an object requires it.
//   9. A transaction only a certified person runs: its require reads { user: "certifications" }; Sam is
//      refused, in its words; Eli (ITAR) runs it.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/restricted.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
let app = null;
const people = ["dana", "eli", "vera", "sam", "quinn", "iris", "ivan", "ines", "olga"];
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of people) {
        sessions[user] = `rs-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? (body && typeof body === "object" && !Array.isArray(body) ? { ok: true, ...body } : { ok: true, value: body }) : { ok: false, status: res.status, ...body };
    };
    const key = () => `rs-${randomBytes(6).toString("hex")}`;
    const approveAll = async (id) => {
        const submitted = await call("dana", "design.submit", { id });
        if (!submitted.ok) return { state: null, submitted };
        await call("vera", "design.review", { id, decision: "pass" });
        let state = null;
        for (let round = 0; round < 4 && state !== "executed"; round++) for (const user of people) {
            const seen = await call(user, "design.change", { id, as: user });
            for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
        }
        return { state };
    };
    const organizationChange = async (edit, reason) => {
        const { id } = await call("dana", "design.start", { organization: true });
        const seen = await call("dana", "design.change", { id, as: "dana" });
        const saved = await call("dana", "design.save", { id, seen: seen.draft_rev, reason, organization: edit(seen.content.organization) });
        return { id, saved };
    };
    const change = async (definitions, reason) => {
        const first = Object.keys(definitions)[0];
        const started = await call("dana", "design.start", { object: first, label: definitions[first].label });
        const seen = await call("dana", "design.change", { id: started.id, as: "dana" });
        const saved = await call("dana", "design.save", { id: started.id, seen: seen.draft_rev, reason, definitions });
        return { id: started.id, saved };
    };
    const row = async (object, id) => (await db.query("SELECT * FROM mes.records WHERE object = $1 AND id = $2", [object, id]))[0];

    // ---- 1. ITAR, listed ----
    const listed = await organizationChange((org) => ({ ...org, certifications: { ...(org.certifications ?? {}), itar: { name: "ITAR export control", description: "US export-controlled defense articles and their data." } } }), "The plant recognizes ITAR.");
    // (Listed already by an earlier run on this database: nothing to change.)
    const listedDone = await approveAll(listed.id);
    if (listedDone.submitted?.error === "This change changes nothing.") { listedDone.state = "executed"; await call("dana", "design.withdraw", { id: listed.id }); }
    const [org] = await db.query("SELECT body->'certifications' AS c FROM mes.organization WHERE status = 'published'");
    step("People & departments lists ITAR, approved by governance", !listed.saved.problems?.length && listedDone.state === "executed" && org?.c?.itar?.name === "ITAR export control", { problems: listed.saved.problems, listedDone, org });

    // ---- 2. certifications ----
    const personOf = async (user) => (await db.query("SELECT id FROM mes.records WHERE object = 'person' AND data->>'user' = $1", [user]))[0]?.id;
    const certify = (user, kind, data = {}) => personOf(user).then((person) => call("dana", "records.create", { object: "certification", data: { person, kind, ...data }, key: key() }));
    // What an earlier run on this database recorded is revoked first, through the services, as Dana.
    for (const old of await db.query("SELECT c.id, c.row_version FROM mes.records c JOIN mes.records p ON p.object = 'person' AND p.id::text = c.data->>'person' WHERE c.object = 'certification' AND c.state = 'active' AND p.data->>'user' = ANY($1)", [["eli", "quinn", "sam"]])) {
        await call("dana", "records.action", { object: "certification", id: old.id, action: "revoke", rowVersion: Number(old.row_version), key: key() });
    }
    const unknown = await certify("eli", "nuclear");
    const eli = await certify("eli", "itar", { valid_from: day(-30), valid_until: day(365), number: `ITAR-${tag}` });
    const quinn = await certify("quinn", "itar", { valid_from: day(-400), valid_until: day(-1), number: `ITAR-Q-${tag}` });
    const backwards = await certify("sam", "itar", { valid_from: day(10), valid_until: day(1) });
    step("certifications recorded by Dana: one of a kind People & departments does not list is refused, in words; one that ends before it starts too; Eli's in date, Quinn's out of date",
        unknown.status === 400 && /"nuclear" is not a certification People & departments lists \(itar\)/.test(unknown.fields?.kind ?? "") && backwards.status === 400 && backwards.fields?.valid_until && eli.ok && quinn.ok,
        { unknown, eli, quinn, backwards });

    // ---- 3. the objects ----
    const [PRODUCT, LOT, WAFER] = ["product", "lot", "wafer"].map((x) => `rs_${x}_t${tag}`);
    const open = (o) => [{ id: `${o}-all`, roles: ["user"], record: { read: true, create: true }, fields: { "*": "write" } }];
    const military = { eq: [{ record: "military" }, true] };
    const object = (name, label, fields, titleField, extra = {}) => ({ object: name, label, area: "Production", titleField, fields, states: { initial: "open", list: ["open", "done"], transitions: [{ action: "finish", label: "Finish", from: ["open"], to: "done" }] }, roles: ["user"], stewards: { object: ["production"] }, policies: open(name).map((p) => ({ ...p, actions: { finish: "allow" } })), rules: [], ...extra });
    const defs = {
        [PRODUCT]: object(PRODUCT, `Restricted product ${tag}`, { code: { label: "Code", type: "string" }, control: { label: "Control", type: "enum", values: ["none", "military"] }, military: { label: "Military", type: "boolean" } }, "code",
            { access: { requires: [{ certification: "itar", when: { eq: [{ record: "control" }, "military"] } }] } }),
        [LOT]: object(LOT, `Restricted lot ${tag}`, { lot_id: { label: "Lot", type: "string" }, product: { label: "Product", type: "ref", to: PRODUCT }, military: { label: "Military", type: "boolean", from: { eq: [{ record: "product.control" }, "military"] } } }, "lot_id",
            { access: { requires: [{ certification: "itar", when: military }] } }),
        [WAFER]: object(WAFER, `Restricted wafer ${tag}`, { mark: { label: "Mark", type: "string" }, lot: { label: "Lot", type: "ref", to: LOT }, military: { label: "Military", type: "boolean", from: "lot.military" } }, "mark",
            { access: { requires: [{ certification: "itar", when: military }] } }),
    };
    const made = await change(defs, "Products, lots and wafers; a military one only for ITAR.");
    const madeDone = await approveAll(made.id);
    await db.query("INSERT INTO mes.assignments (object, role, subject_kind, subject_id) SELECT o, 'user', 'user', u FROM unnest($1::text[]) o, unnest($2::text[]) u ON CONFLICT DO NOTHING", [[PRODUCT, LOT, WAFER], ["sam", "eli", "quinn"]]);
    const make = (user, o, data) => call(user, "records.create", { object: o, data, key: key() });
    const civ = await make("sam", PRODUCT, { code: `CIV-${tag}`, control: "none" });
    const mil = await make("eli", PRODUCT, { code: `MIL-${tag}`, control: "military" });
    const lotCiv = await make("sam", LOT, { lot_id: `LC-${tag}`, product: civ.id });
    const lotMil = await make("eli", LOT, { lot_id: `LM-${tag}`, product: mil.id });
    const wafer = await make("eli", WAFER, { mark: `WM-${tag}`, lot: lotMil.id });
    step("objects whose access requires ITAR when military, a lot's and a wafer's military derived through their references; Eli makes the military ones",
        !made.saved.problems?.length && madeDone.state === "executed" && civ.ok && mil.ok && lotCiv.ok && lotMil.ok && lotMil.military === true && wafer.ok && wafer.military === true,
        { problems: made.saved.problems, madeDone, mil, lotMil, wafer });

    // ---- 4. who sees it ----
    const listOf = async (user) => { const l = await call(user, "records.list", { object: LOT, as: user, page: 1 }); return { ids: (l.rows ?? []).map((r) => r.id), total: l.total ?? l.more?.total ?? l.page?.total, ok: l.ok, error: l.error, keys: Object.keys(l) }; };
    const [sl, el, ql, il] = [await listOf("sam"), await listOf("eli"), await listOf("quinn"), await listOf("iris")];
    step("in the list: Eli sees the military lot; Sam, Quinn (out of date) and Iris (reads every record) see only the civil one, and their count says one",
        el.ids.includes(lotMil.id) && el.ids.includes(lotCiv.id) && el.total === 2 &&
        sl.ids.includes(lotCiv.id) && !sl.ids.includes(lotMil.id) && sl.total === 1 && !ql.ids.includes(lotMil.id) && il.ok && !il.ids.includes(lotMil.id) && il.ids.includes(lotCiv.id),
        { sl, el, ql, il });
    const [samGet, eliGet, irisGet] = [await call("sam", "records.get", { object: LOT, id: lotMil.id, as: "sam" }), await call("eli", "records.get", { object: LOT, id: lotMil.id, as: "eli" }), await call("iris", "records.get", { object: LOT, id: lotMil.id, as: "iris" })];
    const samWafer = await call("sam", "records.get", { object: WAFER, id: wafer.id, as: "sam" });
    step("opened by its id: nothing for Sam and Iris (as for a record that is not there), nor its wafer; Eli opens it",
        samGet.ok && samGet.value === null && irisGet.ok && irisGet.value === null && samWafer.ok && samWafer.value === null && eliGet.ok && eliGet.id === lotMil.id, { samGet, irisGet, eliGet, samWafer });
    const findOf = async (user) => JSON.stringify(await call(user, "records.search", { q: `LM-${tag}`, as: user }));
    const [sf, ef] = [await findOf("sam"), await findOf("eli")];
    step("found by search: by Eli, not by Sam", ef.includes(lotMil.id) && !sf.includes(lotMil.id), { sf, ef });
    const countIn = async (user) => (await call(user, "query.sql", { sql: `SELECT count(*) AS n, count(*) FILTER (WHERE military) AS m FROM "${LOT}"` }));
    const [sq, eq] = [await countIn("sam"), await countIn("eli")];
    step("in a query view: Sam counts one lot, none military; Eli two, one military",
        sq.ok && Number(sq.rows?.[0]?.[0]) === 1 && Number(sq.rows?.[0]?.[1]) === 0 && eq.ok && Number(eq.rows?.[0]?.[0]) === 2 && Number(eq.rows?.[0]?.[1]) === 1, { sq, eq });
    const nowOf = async (user) => (await call(user, "analytics.states", { object: LOT })).now?.reduce((n, s) => n + s.count, 0);
    const [sa, ea] = [await nowOf("sam"), await nowOf("eli")];
    step("in analytics: Sam's figures count the civil lot alone, Eli's both", sa === 1 && ea === 2, { sa, ea });

    // ---- 5. writes that would reserve the record from its writer ----
    const samMil = await make("sam", LOT, { lot_id: `LX-${tag}`, product: mil.id });
    const samMove = await call("sam", "records.update", { object: LOT, id: lotCiv.id, rowVersion: lotCiv.row_version, data: { product: mil.id }, key: key() });
    step("Sam may not make a lot of the military product (refused, in words, naming the certification), nor move his lot onto it (a product he cannot see)",
        !samMil.ok && samMil.status === 403 && /would require the ITAR export control certification, which you do not hold/.test(samMil.error ?? "") &&
        !samMove.ok && /No restricted product \d+ you can see with that id/.test(samMove.fields?.product ?? ""), { samMil, samMove });

    // ---- 6. revoked, reinstated ----
    const revoked = await call("dana", "records.action", { object: "certification", id: eli.id, action: "revoke", rowVersion: eli.row_version, key: key() });
    const afterRevoke = await listOf("eli");
    const reinstated = await call("dana", "records.action", { object: "certification", id: eli.id, action: "reinstate", rowVersion: revoked.row_version, key: key() });
    const afterReinstate = await listOf("eli");
    step("Eli's certification revoked: the military lot is gone from his list at once; reinstated, it is back",
        revoked.ok && !afterRevoke.ids.includes(lotMil.id) && reinstated.ok && afterReinstate.ids.includes(lotMil.id), { revoked, afterRevoke, reinstated, afterReinstate });

    // ---- 7. reclassified ----
    const milNow = await row(PRODUCT, mil.id);
    const reclass = await call("eli", "records.update", { object: PRODUCT, id: mil.id, rowVersion: Number(milNow.row_version), data: { control: "none" }, key: key() });
    const samAfter = await listOf("sam");
    const samWaferAfter = await call("sam", "records.get", { object: WAFER, id: wafer.id, as: "sam" });
    step("the product reclassified: its lot and wafer are no longer military (derived, in the same write), and Sam sees them",
        reclass.ok && samAfter.ids.includes(lotMil.id) && samWaferAfter.ok && samWaferAfter.military === false, { reclass, samAfter, samWaferAfter });

    // ---- 8. refused at the check ----
    const wrong = await change({ [LOT]: { ...defs[LOT], access: { requires: [{ certification: "cleanroom", when: military }, { certification: "itar", when: { eq: [{ record: "product.control" }, "military"] } }] } } }, "Wrong on purpose.");
    const words = (wrong.saved.problems ?? []).map((p) => p.message).join("\n");
    await call("dana", "design.withdraw", { id: wrong.id });
    const unlist = await organizationChange((o) => ({ ...o, certifications: {} }), "Wrong on purpose.");
    const unlistWords = (unlist.saved.problems ?? []).map((p) => p.message).join("\n");
    await call("dana", "design.withdraw", { id: unlist.id });
    step("a design check refuses a certification the organization does not list, a condition read through a reference (derive it first), and taking ITAR off the list while objects require it",
        /"cleanroom" is not a certification People & departments lists/.test(words) && /derive that field first/.test(words) && /"itar" is required by Restricted product/.test(unlistWords),
        { words, unlistWords });

    // ---- 9. a transaction only a certified person runs ----
    const SHIP = `rs_ship_t${tag}`;
    const ship = {
        name: SHIP, label: "Ship a lot", description: "Only someone ITAR-certified ships a lot.",
        inputs: { lot: { label: "Lot", type: "ref", to: LOT, required: true } },
        appearsOn: { object: LOT, fills: "lot" },
        require: [{ that: { contains: [{ user: "certifications" }, "itar"] }, message: "Only someone ITAR-certified ships a lot." }],
        steps: [{ on: "lot", action: "finish" }],
        confirm: false, callers: { users: ["sam", "eli"], groups: [] }, stewards: ["production"],
        // Its sandbox holds no one's certifications but those its scenario records: Eli's ITAR, here.
        scenarios: [{ name: "Eli ships", records: { eli: { object: "person", where: { user: ["eli"] } }, itar: { object: "certification", data: { person: "@eli", kind: "itar" } }, lot: { object: LOT, data: { lot_id: `SC-${tag}` } } }, steps: [{ as: "eli", do: { transaction: SHIP, input: { lot: "@lot" } }, expect: { ok: true, states: { lot: "done" } } }] }],
    };
    const txStarted = await call("dana", "design.start", { transaction: SHIP, label: "Ship a lot" });
    const txSeen = await call("dana", "design.change", { id: txStarted.id, as: "dana" });
    const txSaved = await call("dana", "design.save", { id: txStarted.id, seen: txSeen.draft_rev, reason: "Only someone ITAR-certified ships.", transactions: { [SHIP]: ship } });
    const txLive = await approveAll(txStarted.id);
    const samShips = await call("sam", "transactions.run", { name: SHIP, input: { lot: lotCiv.id }, key: key() });
    const eliShips = await call("eli", "transactions.run", { name: SHIP, input: { lot: lotCiv.id }, key: key() });
    step("a transaction only a certified person runs (its require reads their certifications): Sam is refused in its words, Eli (ITAR) ships",
        !txSaved.problems?.length && txLive.state === "executed" && !samShips.ok && /Only someone ITAR-certified ships a lot/.test(samShips.error ?? "") && eliShips.ok,
        { problems: txSaved.problems, txLive, samShips, eliShips });
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
