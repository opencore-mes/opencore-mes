// Archiving (records.archive / records.restore), end to end, against a running server:
//   1. Sam (lot supervisor) makes a lot. Archiving it is refused by policy while it is created
//      (the seed grants archive on on_hold and consumed lots only).
//   2. Sam holds it. Archiving it is now allowed by policy, but the lot's rule pipe refuses it:
//      lot_archive_checks throws while the disposition is undecided. The refusal is audited.
//   3. Quinn rejects the lot; Sam archives it. It leaves the list, joins the archived list, and is
//      read-only: an update and an action are refused, and "why?" says it is archived.
//   4. Sam restores it: it is back in the list, and writable again.
//   5. A service's ctx.records.archive (dry run): the same policy and pipe, nothing changed.
//
//   DATABASE_URL=postgres:///openmes_poc node app/mes/test/archive.mjs
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { sessionKey } from "../server/store.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const SVC = `lot_scrap_t${tag}`;

const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0 });
const { url: mes } = await app.listen({ port: 0 });
const sessions = {};
for (const user of ["sam", "quinn", "olga", "dana"]) {
    sessions[user] = `ar-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status, body });
    return body;
};
const refused = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, status: error.status, message: error.message, body: error.body }));
const key = () => `ar-${randomBytes(8).toString("hex")}`;

let lotId = null;
try {
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1001'");
    let lot = await call("sam", "records.create", { object: "lot", data: { lot_no: `AR${tag}`, item: "PA66-NAT-25", work_order: wo.id, qty: 10, uom: "kg" }, key: key() });
    lotId = lot.id;

    // ---- 1. policy ----
    step("the supervisor may not archive a lot that is only created", lot.$perm.archive === false && lot.$perm.why["record:archive"] === "state");
    const early = await refused(call("sam", "records.archive", { object: "lot", id: lotId, rowVersion: lot.row_version, key: key() }));
    step("…and the server refuses it, in words from the policy", !early.ok && early.status === 403 && /cannot be archived while it is created/.test(early.message), early);

    // ---- 2. the rule pipe ----
    lot = await call("sam", "records.action", { object: "lot", id: lotId, action: "hold", rowVersion: lot.row_version, key: key() });
    step("on hold, the policy allows archiving", lot.$perm.archive === true);
    const byRule = await refused(call("sam", "records.archive", { object: "lot", id: lotId, rowVersion: lot.row_version, key: key() }));
    step("the lot's rule pipe refuses it: lot_archive_checks, on the disposition field", !byRule.ok && byRule.message === "Decide the lot's disposition before archiving it." && byRule.body?.fields?.disposition, byRule);
    const [rejectedAudit] = await db.query("SELECT action, rules FROM mes.audit_log WHERE record_id = $1 AND action = 'rejected:archive'", [lotId]);
    step("the refusal is audited with the pipe's trace", rejectedAudit && rejectedAudit.rules.some((t) => t.script === "lot_archive_checks" && t.outcome === "threw"), rejectedAudit);
    const still = await call("sam", "records.get", { object: "lot", id: lotId, as: "sam" });
    step("and nothing changed", still.archived_at === null && still.row_version === lot.row_version);

    // ---- 3. archive ----
    lot = await call("quinn", "records.update", { object: "lot", id: lotId, rowVersion: lot.row_version, data: { disposition: "reject" }, key: key() });
    const olga = await refused(call("olga", "records.archive", { object: "lot", id: lotId, rowVersion: lot.row_version, key: key() }));
    step("an operator may not archive (role)", !olga.ok && olga.status === 403 && /None of your roles/.test(olga.message), olga);
    const k = key();
    lot = await call("sam", "records.archive", { object: "lot", id: lotId, rowVersion: lot.row_version, key: k });
    step("the supervisor archives the decided lot", Boolean(lot.archived_at) && lot.archived_by === "sam" && lot.state === "on_hold");
    const again = await call("sam", "records.archive", { object: "lot", id: lotId, rowVersion: lot.row_version - 1, key: k });
    step("a retry with the same key answers the first result", again.row_version === lot.row_version && again.archived_at === lot.archived_at);
    const [archiveAudit] = await db.query("SELECT actor, before, after, rules FROM mes.audit_log WHERE record_id = $1 AND action = 'archive'", [lotId]);
    step("the archive is audited, with the pipe that passed", archiveAudit?.actor === "sam" && archiveAudit.before.archived_at === null && archiveAudit.after.archived_by === "sam" && archiveAudit.rules.some((t) => t.script === "lot_archive_checks" && t.outcome === "passed"), archiveAudit);
    const list = await call("sam", "records.list", { object: "lot", as: "sam" });
    const archivedList = await call("sam", "records.list", { object: "lot", as: "sam", archived: true });
    step("it leaves the list and joins the archived list", !list.rows.some((r) => r.id === lotId) && archivedList.rows.some((r) => r.id === lotId));
    const seen = await call("quinn", "records.get", { object: "lot", id: lotId, as: "quinn" });
    step("it is read-only for everyone", seen.$perm.fields.disposition === "r" && seen.$perm.why.disposition === "archived" && seen.$perm.actions.length === 0);
    const update = await refused(call("quinn", "records.update", { object: "lot", id: lotId, rowVersion: lot.row_version, data: { disposition: "accept" }, key: key() }));
    step("an update is refused: archived", !update.ok && update.status === 409 && update.body?.code === "record.archived", update);
    const action = await refused(call("sam", "records.action", { object: "lot", id: lotId, action: "resume", rowVersion: lot.row_version, key: key() }));
    step("an action is refused: archived", !action.ok && action.status === 409 && /archived; restore it/.test(action.message), action);
    const why = await call("quinn", "access.explain", { object: "lot", id: lotId, field: "disposition" });
    step("\"why can't I?\" says it is archived, and by whom", why.decision === "deny" && why.because[0].source === "archive" && /archived by sam/.test(why.because[0].detail), why.because);
    const whyArchive = await call("olga", "access.explain", { object: "lot", id: lotId, archive: true });
    step("\"why can't I archive?\" names the rule and the role it needs", whyArchive.decision === "deny" && whyArchive.because.some((b) => b.rule === "lot-archive"), whyArchive.because);
    const history = await call("sam", "records.history", { object: "lot", id: lotId });
    step("the history shows the refused and the done archive", history.some((h) => h.action === "archive" && h.after.archived_by === "sam") && history.some((h) => h.action === "rejected:archive"), history.map((h) => h.action));

    // ---- 4. restore ----
    lot = await call("sam", "records.restore", { object: "lot", id: lotId, rowVersion: lot.row_version, key: key() });
    const back = await call("sam", "records.list", { object: "lot", as: "sam" });
    step("the supervisor restores it: back in the list, writable again", lot.archived_at === null && back.rows.some((r) => r.id === lotId) && lot.$perm.actions.includes("resume"));
    const twice = await refused(call("sam", "records.restore", { object: "lot", id: lotId, rowVersion: lot.row_version, key: key() }));
    step("restoring a record that is not archived is refused", !twice.ok && twice.status === 409, twice);

    // ---- 5. a service's ctx.records.archive, dry run ----
    const service = {
        name: SVC, label: "Scrap a lot", description: "Archives a rejected lot.", input: { lot: { label: "Lot", type: "ref", to: "lot", required: true } },
        http: { enabled: true }, callers: { users: ["sam"], groups: [] }, on: [], runAs: "service", roles: { lot: ["supervisor"] },
        uses: { connections: [], objects: { lot: ["read", "archive"] } }, stewards: ["production"],
    };
    const source = `// Archives a rejected lot.
export default async function ${SVC}(ctx) {
  const lot = await ctx.records.archive("lot", ctx.input.lot);
  ctx.output = { archived_at: lot.archived_at };
  return ctx;
}`;
    const checked = await call("dana", "design.check", { services: { [SVC]: service }, scripts: { [SVC]: source } });
    const serviceProblems = (checked.problems ?? []).filter((p) => String(p.path).startsWith(`services.${SVC}.uses`));
    step("a service may declare archive in uses.objects", serviceProblems.length === 0, serviceProblems);
    const dry = await call("dana", "design.dryRun", { kind: "service", name: SVC, source, service, run: { input: { lot: lotId } } });
    const unchanged = await call("sam", "records.get", { object: "lot", id: lotId, as: "sam" });
    step("dry run: ctx.records.archive goes through policy and the pipe, and changes nothing", dry.ok && dry.writes[0]?.op === "archive" && dry.output?.archived_at && unchanged.archived_at === null, { ok: dry.ok, error: dry.error, writes: dry.writes });
    const noUse = await call("dana", "design.dryRun", { kind: "service", name: SVC, source, service: { ...service, uses: { connections: [], objects: { lot: ["read"] } } }, run: { input: { lot: lotId } } });
    step("without archive in uses.objects, the service may not archive", !noUse.ok && /may not archive lot/.test(noUse.error?.message ?? ""), noUse.error);
} catch (error) {
    step("unexpected", false, { message: error.message, body: error.body });
} finally {
    await app.close();
    // What this run made, except its audit (append-only by design).
    if (lotId) await db.query("DELETE FROM mes.records WHERE object = 'lot' AND id = $1", [lotId]);
    await db.query("DELETE FROM mes.idempotency WHERE key LIKE 'ar-%'");
    await db.query("DELETE FROM mes.sessions WHERE id = ANY($1)", [Object.values(sessions).map(sessionKey)]);
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
console.log(JSON.stringify(steps, null, 1));
console.log(failed.length ? `\n${failed.length} step(s) FAILED` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
