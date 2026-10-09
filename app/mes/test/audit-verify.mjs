// The audit chain verified (§7.3, COMPLIANCE.md G3), end to end: sound from the start and from where the last
// check reached; an entry changed after it was written, or one taken from the end, is found and named, and stays
// found until it is put right; the scheduled check says so in /healthz and as a critical event, once; the
// command exits 1 on a break.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/audit-verify.mjs   (after a reset)
import pg from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { appendAudit, checkAudit, checkAuditInWorker, verifyAudit } from "../server/audit.js";
import { createApp } from "../app.mjs";
import { randomBytes } from "node:crypto";

const run = promisify(execFile);
const url = process.env.DATABASE_URL ?? "postgres:///openmes_poc";
const pool = new pg.Pool({ connectionString: url });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const command = (args = []) => run(process.execPath, [fileURLToPath(new URL("../db/verify-audit.mjs", import.meta.url)), ...args], { env: { ...process.env, DATABASE_URL: url } }).then((r) => ({ code: 0, out: r.stdout }), (e) => ({ code: e.code, out: e.stdout }));
let app = null;
try {
    const full = await checkAudit(db, { full: true });
    step("the chain as the seed and the earlier suites left it is sound, from the first entry", full.ok && full.checked > 0 && full.verifiedTo > 0, full);

    for (let i = 0; i < 3; i++) await db.transaction((tx) => appendAudit(tx, { actor: "test", object: "$test", action: `audit-verify ${i}` }));
    const next = await checkAudit(db);
    step("a later check reads only what was written since (three entries), and moves the checkpoint on", next.ok && next.checked === 3 && next.verifiedTo > full.verifiedTo, next);
    // The server's own check runs in a thread of its own, on its own connection (server.mjs): the same answer.
    const inWorker = await checkAuditInWorker(url, { full: true });
    step("the check in a worker thread, from the start, finds what the one here finds: sound, every entry", inWorker.ok && inWorker.checked === full.checked + 3 && inWorker.verifiedTo === next.verifiedTo, { inWorker, full, next });

    // An entry changed after it was written: possible only for whoever may switch the append-only trigger off.
    const [target] = await db.query("SELECT seq, actor FROM mes.audit_log WHERE action = 'audit-verify 1'");
    await db.query("ALTER TABLE mes.audit_log DISABLE TRIGGER audit_no_update");
    await db.query("UPDATE mes.audit_log SET actor = 'someone else' WHERE seq = $1", [target.seq]);
    const changed = await checkAudit(db, { full: true });
    const cli = await command(["--full"]);
    step("an entry changed after it was written is found, named, and the command exits 1",
        !changed.ok && changed.brokenAt === Number(target.seq) && /changed after it was written/.test(changed.problem) && cli.code === 1 && /BROKEN at entry/.test(cli.out), { changed, cli });
    const still = await checkAudit(db);
    step("…and stays found by the next check (the checkpoint never moves over a break)", !still.ok && still.brokenAt === Number(target.seq), still);

    // The scheduled check: /healthz and a critical event, once.
    const emitted = [];
    const events = { emit: (type, detail) => emitted.push({ type, ...detail }), flush: async () => {}, state: () => ({}) };
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 60_000, events });
    const { url: base } = await app.listen({ port: 0 });
    let health = null;
    for (let i = 0; i < 40 && !health?.audit; i++) { await new Promise((r) => setTimeout(r, 100)); health = await (await fetch(`${base}/healthz`)).json(); }
    step("the scheduled check reports the break in /healthz, and as a critical event",
        health?.audit?.ok === false && health.audit.brokenAt === Number(target.seq) && emitted.some((e) => e.type === "audit.broken" && e.severity === "critical"), { audit: health?.audit, emitted });

    // Put right: the chain is sound again.
    await db.query("UPDATE mes.audit_log SET actor = $2 WHERE seq = $1", [target.seq, target.actor]);
    await db.query("ALTER TABLE mes.audit_log ENABLE TRIGGER audit_no_update");
    const mended = await checkAudit(db);
    step("put right, the next check finds it sound again", mended.ok && (await verifyAudit(db)).ok, mended);

    // An entry taken from the end shows as a head that is not the last entry (the head of the chain the last
    // entry written is on).
    const [head] = await db.query("SELECT chain, hash FROM mes.audit_head WHERE chain = (SELECT chain FROM mes.audit_log ORDER BY seq DESC LIMIT 1)");
    await db.query("UPDATE mes.audit_head SET hash = repeat('f', 64) WHERE chain = $1", [head.chain]);
    const tail = await checkAudit(db);
    await db.query("UPDATE mes.audit_head SET hash = $2 WHERE chain = $1", [head.chain, head.hash]);
    step("an entry taken from the end (the head no longer its last entry) is found", !tail.ok && /head is not its last entry/.test(tail.problem), tail);

    // The trail in chains (§7.3): transactions' entries are spread over the chains, each linked on its own (the
    // checks above); an entry put on a chain that has no head is found.
    const spread = await db.query("SELECT count(DISTINCT chain)::int AS chains FROM mes.audit_log WHERE chain > 0");
    step("entries are spread over the chains", spread[0].chains >= 8, { spread });
    await db.query("ALTER TABLE mes.audit_log DISABLE TRIGGER audit_no_update");
    const [stray] = await db.query("INSERT INTO mes.audit_log (actor, object, action, prev_hash, hash, chain) VALUES ('someone', '$test', 'slipped in', repeat('0', 64), repeat('0', 64), 99) RETURNING seq");
    const strayCheck = await checkAudit(db);
    await db.query("DELETE FROM mes.audit_log WHERE seq = $1", [stray.seq]);
    await db.query("ALTER TABLE mes.audit_log ENABLE TRIGGER audit_no_update");
    step("an entry put on a chain that has no head is found (nobody would check it)", !strayCheck.ok && strayCheck.brokenAt === Number(stray.seq) && /no head/.test(strayCheck.problem), strayCheck);
    const sound = await checkAudit(db);
    step("…and once it is gone, the trail is sound again", sound.ok, sound);
    // Policy denials are in the trail too (G4): Olga, an operator, may not set a lot's disposition, release it
    // or archive it. Each refusal is kept, with what was asked and why; a dry run's is not.
    const session = `av-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, 'olga', now() + interval '1 hour')", [session]);
    const call = async (name, args) => { const res = await fetch(`${base}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${session}` }, body: JSON.stringify([args]) }); return { status: res.status, body: await res.json() }; };
    const [lot] = await db.query("SELECT id, row_version FROM mes.records WHERE object = 'lot' AND data->>'lot_no' = '4712'");
    const before = Number((await db.query("SELECT max(seq) AS s FROM mes.audit_log"))[0].s);
    const field = await call("records.update", { object: "lot", id: lot.id, rowVersion: Number(lot.row_version), data: { disposition: "accept" } });
    const action = await call("records.action", { object: "lot", id: lot.id, rowVersion: Number(lot.row_version), action: "release" });
    const archive = await call("records.archive", { object: "lot", id: lot.id, rowVersion: Number(lot.row_version) });
    const denied = await db.query("SELECT actor, action, record_id, after FROM mes.audit_log WHERE seq > $1 AND action LIKE 'denied:%' ORDER BY seq", [before]);
    step("a policy's refusal is audited: who, what was asked (a field, an action, archiving), on which record, and why",
        field.status === 403 && field.body.code === "policy.denied" && denied.some((d) => d.action === "denied:update" && d.actor === "olga" && d.record_id === lot.id && d.after.denial.fields.includes("disposition"))
        && denied.some((d) => d.action === "denied:action:release") && (archive.status !== 403 || denied.some((d) => d.action === "denied:archive")), { field, action: action.status, archive: archive.status, denied });
    const ok = await command();
    step("the command, the chain sound: exit 0, how far it is verified", ok.code === 0 && /audit trail sound/.test(ok.out), ok);
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await db.query("ALTER TABLE mes.audit_log ENABLE TRIGGER audit_no_update").catch(() => {});
    await app?.close?.().catch(() => {});
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
