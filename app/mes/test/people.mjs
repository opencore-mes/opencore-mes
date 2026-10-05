// The built-in Person object and locks (§6.7), end to end against a running server:
//   1. Person is published in every installation, built in: one record per person in People &
//      departments, its sign-in id, name and whether active as they are there; its list search first.
//   2. What breaks its locks is named: the name field removed, the sign-in id retyped, a policy that
//      lets someone write the name or make a Person, a rule that sets "active"; retiring it is refused.
//      The locks are the designer's to see (design.home).
//   3. A designer adds a badge field through a change, approved like any other.
//   4. Engineering (its editors) sets a badge; nobody writes a name, makes or archives a Person.
//   5. Organization changes (people new, a name changed, someone leaving) keep Person in step, in the
//      same change: records made, one renamed (its badge kept), one made inactive, never archived.
//   6. People from a spreadsheet: what Export writes, edited and imported into a change, executes like
//      any other edit; whoever is not in the file stays as they are.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/people.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "../../../src/server/db.js";
import { createApp } from "../app.mjs";
import { peopleCsv, importPeople } from "../client/people-file.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const clone = (v) => JSON.parse(JSON.stringify(v));
let app = null;

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    const { url: mes } = await app.listen({ port: 0 });
    const people = ["dana", "eli", "vera", "sam", "quinn", "ivan", "ines", "olga", "iris"];
    const sessions = {};
    for (const user of people) {
        sessions[user] = `pp-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const key = () => `pp-${randomBytes(8).toString("hex")}`;
    // A change through review and every approval it needs.
    const approveAll = async (id) => {
        const submitted = await call("dana", "design.submit", { id });
        if (submitted.error) return submitted;
        await call("vera", "design.review", { id, decision: "pass" });
        let state = null;
        for (let round = 0; round < 4 && state !== "executed"; round++) {
            for (const user of people) {
                const seen = await call(user, "design.change", { id, as: user });
                for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
            }
        }
        return { state };
    };
    const personOf = async (user) => (await db.query("SELECT id, data, row_version, archived_at FROM mes.records WHERE object = 'person' AND data->>'user' = $1", [user]))[0];

    // ---- 1. built in ----
    const [def] = await db.query("SELECT version, body FROM mes.definitions WHERE object = 'person' AND status = 'published'");
    const users = await db.query("SELECT id, name, active FROM mes.users ORDER BY id");
    const records = await db.query("SELECT data FROM mes.records WHERE object = 'person'");
    step("Person is published, built in: one record per person, each as People & departments has them",
        def?.body.builtIn === true && def.body.list.searchFirst === true && records.length === users.length && users.every((u) => records.some((r) => r.data.user === u.id && r.data.name === u.name && r.data.active === u.active)), { def: def?.body?.builtIn, records: records.length, users: users.length });

    // ---- 2. locks ----
    const retire = await call("dana", "design.start", { retire: { kind: "definitions", name: "person" } });
    const retireChange = await call("dana", "design.change", { id: retire.id, as: "dana" });
    step("retiring Person is refused: the platform needs it", (retireChange.problems ?? []).some((p) => /cannot be retired: the platform needs it/.test(p.message)), retireChange.problems);
    await call("dana", "design.withdraw", { id: retire.id });
    const { id } = await call("dana", "design.start", { object: "person" });
    const change = await call("dana", "design.change", { id, as: "dana" });
    const body = change.content.definitions.person;
    const broken = clone(body);
    delete broken.fields.name;
    broken.titleField = "user";
    broken.fields.user.type = "integer";
    broken.policies.push({ id: "person-hr", roles: ["editor"], record: { create: true }, fields: { name: "write" } });
    broken.rules = [{ script: "nope_rule", writes: ["active"] }];
    const refused = await call("dana", "design.save", { id, reason: "Badges.", definitions: { person: broken } });
    const words = (refused.problems ?? []).map((p) => p.message).join("\n");
    step("what breaks its locks is named: a field removed, one retyped, a policy that writes the name or makes a Person, a rule that sets active",
        /Field "name" cannot be removed: it is locked by the platform/.test(words) && /Field "user" stays a string/.test(words) && /cannot let anyone write "name"/.test(words) && /cannot let anyone make or archive a record here/.test(words) && /cannot set "active"/.test(words), refused.problems);
    const home = await call("dana", "design.home", { as: "dana" });
    step("the designer sees the locks: by the platform, its managed fields, kept", home.locks?.person?.some((l) => l.by === "core" && l.keep && l.managed.includes("name")), home.locks?.person);

    // ---- 3. a badge, added by a designer ----
    const withBadge = clone(body);
    withBadge.fields.badge = { label: "Badge", type: "string" };
    withBadge.list.columns.push("badge");
    withBadge.form.sections[0].fields.push("badge");
    const saved = await call("dana", "design.save", { id, seen: (await call("dana", "design.change", { id, as: "dana" })).draft_rev, definitions: { person: withBadge } });
    const done = await approveAll(id);
    const [live] = await db.query("SELECT version, body FROM mes.definitions WHERE object = 'person' AND status = 'published'");
    step("a designer adds a badge field: no problems, approved and live, still built in", !saved.problems?.length && done.state === "executed" && live.body.fields.badge && live.body.builtIn === true && live.version === def.version + 1, { problems: saved.problems, done, version: live?.version });

    // ---- 4. who writes what ----
    let olga = await personOf("olga");
    const badge = await call("dana", "records.update", { object: "person", id: olga.id, rowVersion: Number(olga.row_version), data: { badge: `B-${tag}` }, key: key() });
    olga = await personOf("olga");
    step("Engineering (its editors) sets Olga's badge; her name shows read only, kept in People & departments", !badge.error && olga.data.badge === `B-${tag}` && badge.$perm?.fields?.name === "r" && badge.$perm?.why?.name === "managed" && badge.$perm.fields.badge === "w", badge);
    const renamed = await call("dana", "records.update", { object: "person", id: olga.id, rowVersion: Number(olga.row_version), data: { name: "Olga Someone" }, key: key() });
    const made = await call("dana", "records.create", { object: "person", data: { user: `x_${tag}`, name: "Nobody" }, key: key() });
    const archived = await call("dana", "records.archive", { object: "person", id: olga.id, rowVersion: Number(olga.row_version), key: key() });
    step("nobody writes a name, makes or archives a Person: People & departments keeps them",
        renamed.status === 403 && /People & departments keeps it/.test(renamed.error) && made.status === 403 && archived.status === 403 && (await personOf("olga")).data.name === "Olga Ortiz", { renamed, made, archived });

    // ---- 5. kept in step with People & departments ----
    const NEW = `nadia_t${tag}`;
    const orgChange = await call("dana", "design.start", { organization: true });
    const org = (await call("dana", "design.change", { id: orgChange.id, as: "dana" })).content.organization;
    org.users[NEW] = { name: "Nadia New", active: true };
    org.departments.production.members.push(NEW);
    const LEAVER = `noah_t${tag}`;
    org.users[LEAVER] = { name: "Noah Leaving", active: true };
    org.users.olga.name = "Olga Ortiz-Lee";
    const orgSaved = await call("dana", "design.save", { id: orgChange.id, reason: "Nadia and Noah join; Olga's name.", organization: org });
    const orgDone = await approveAll(orgChange.id);
    // Then Noah leaves: made inactive, never deleted.
    const leaveChange = await call("dana", "design.start", { organization: true });
    const org2 = (await call("dana", "design.change", { id: leaveChange.id, as: "dana" })).content.organization;
    org2.users[LEAVER].active = false;
    const leaveSaved = await call("dana", "design.save", { id: leaveChange.id, reason: "Noah leaves.", organization: org2 });
    const leaveDone = await approveAll(leaveChange.id);
    const [nadia, olgaAfter, noah] = [await personOf(NEW), await personOf("olga"), await personOf(LEAVER)];
    step("organization changes keep Person in step: Nadia's record made, Olga's renamed (her badge kept), Noah's made, then inactive (not archived)",
        !orgSaved.problems?.length && orgDone.state === "executed" && !leaveSaved.problems?.length && leaveDone.state === "executed"
        && nadia?.data.name === "Nadia New" && nadia.data.active === true && olgaAfter.data.name === "Olga Ortiz-Lee" && olgaAfter.data.badge === `B-${tag}` && noah?.data.active === false && !noah.archived_at,
        { problems: [orgSaved.problems, leaveSaved.problems], orgDone, leaveDone, nadia: nadia?.data, olga: olgaAfter?.data, noah: noah?.data });
    const audited = await db.query("SELECT actor, action FROM mes.audit_log WHERE object = 'person' AND record_id = $1 ORDER BY seq", [nadia?.id]);
    step("…written as the platform, and audited", audited.length === 1 && audited[0].actor === "platform:organization" && audited[0].action === "create", audited);

    // ---- 6. from a spreadsheet ----
    const fileChange = await call("dana", "design.start", { organization: true });
    const org3 = (await call("dana", "design.change", { id: fileChange.id, as: "dana" })).content.organization;
    const exported = peopleCsv(org3);
    const PAT = `pat_t${tag}`;
    // The exported file, Nadia renamed, Noah's row taken out, and Pat added to Quality.
    const edited = exported.split("\r\n").filter((line) => !line.startsWith(`${LEAVER},`)).map((line) => (line.startsWith(`${NEW},`) ? line.replace("Nadia New", "Nadia Newer") : line)).join("\r\n") + `${PAT},Pat Imported,yes,quality\r\n`;
    const imported = importPeople(org3, edited);
    const fileSaved = await call("dana", "design.save", { id: fileChange.id, reason: "People from the HR spreadsheet.", organization: imported.next });
    const fileDone = await approveAll(fileChange.id);
    const [pat, nadia2, noah2] = [await personOf(PAT), await personOf(NEW), await personOf(LEAVER)];
    const inQuality = (await db.query("SELECT 1 FROM mes.group_members WHERE group_id = 'quality' AND user_id = $1", [PAT])).length === 1;
    step("people from a spreadsheet: Pat added to Quality, Nadia renamed, Noah (not in the file) left as he was; approved, Person kept in step",
        !imported.problems.length && imported.changes.added.join() === PAT && imported.changes.renamed.join() === NEW && !fileSaved.problems?.length && fileDone.state === "executed"
        && pat?.data.name === "Pat Imported" && inQuality && nadia2.data.name === "Nadia Newer" && noah2?.data.active === false,
        { problems: imported.problems, changes: imported.changes, saved: fileSaved.problems, fileDone, pat: pat?.data });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
