// The audit chain's scheduled check (§7.3, COMPLIANCE.md G3) in a thread of its own, on a connection of its
// own: re-hashing a quarter of an hour of a busy plant's entries (a million and more) takes the time of the
// thread that does it, and the one that answers people's requests is never that thread. Started by
// checkAuditInWorker (audit.js) with the database's address; answers what checkAudit found, or its error.
import { parentPort, workerData } from "node:worker_threads";
import pg from "pg";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { checkAudit } from "./audit.js";

const pool = new pg.Pool({ connectionString: workerData.url, max: 1 });
try {
    parentPort.postMessage({ result: await checkAudit(fromPg(pool), workerData.options ?? {}) });
} catch (error) {
    parentPort.postMessage({ error: { message: error.message, code: error.code } });
} finally {
    await pool.end();
}
