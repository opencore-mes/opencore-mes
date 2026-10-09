// Seals the secrets kept before SEAL_KEY was set (server/seal.js, COMPLIANCE.md G12): each authenticator's TOTP
// secret still in the clear is sealed under the key, in one transaction. Safe to run again: a sealed one is left.
//
//   SEAL_KEY_FILE=/etc/opencore-mes/seal.key DATABASE_URL=postgres:///opencore_mes_demo node app/mes/db/seal-secrets.mjs
import pg from "pg";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { isSealed, sealKey, sealSecret } from "../server/seal.js";

if (!sealKey()) { console.error("No SEAL_KEY (or SEAL_KEY_FILE): nothing to seal with. Make one with `openssl rand -hex 32`, kept outside the database and its backups."); process.exit(2); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc", max: 1 });
const db = fromPg(pool);
try {
    const sealed = await db.transaction(async (tx) => {
        let n = 0;
        for (const row of await tx.query("SELECT user_id, secret FROM mes.mfa FOR UPDATE")) {
            if (isSealed(row.secret)) continue;
            await tx.query("UPDATE mes.mfa SET secret = $2 WHERE user_id = $1", [row.user_id, sealSecret(row.secret)]);
            n++;
        }
        return n;
    });
    console.log(`${sealed} authenticator secret(s) sealed`);
} finally {
    await pool.end();
}
