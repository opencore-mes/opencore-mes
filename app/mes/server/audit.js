// The audit trail (DESIGN.md §7.3): append-only (a trigger refuses UPDATE and DELETE), hash-chained,
// time-stamped by the database clock, written in the same transaction as the change it records.
import { createHash } from "node:crypto";

// Canonical JSON: keys sorted, so the hash of a row does not depend on key order.
export function canonical(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// Appends one entry inside `tx`. The chain head is locked, so concurrent writers form one line.
export async function appendAudit(tx, entry) {
    const [head] = await tx.query("SELECT hash FROM mes.audit_head WHERE id FOR UPDATE");
    const [{ at }] = await tx.query("SELECT clock_timestamp() AS at");
    const row = {
        at: new Date(at).toISOString(),
        actor: entry.actor,
        object: entry.object,
        record_id: entry.recordId ?? null,
        def_version: entry.defVersion ?? null,
        action: entry.action,
        before: entry.before ?? null,
        after: entry.after ?? null,
        rules: entry.rules ?? null,
        // Who a service acted for (§15.2): hashed with the rest, and only when there is someone, so
        // the rows written before it existed keep their hash.
        ...(entry.onBehalfOf ? { on_behalf_of: entry.onBehalfOf } : {}),
    };
    const hash = sha256(head.hash + canonical(row));
    await tx.query(
        `INSERT INTO mes.audit_log (at, actor, object, record_id, def_version, action, before, after, rules, on_behalf_of, prev_hash, hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [row.at, row.actor, row.object, row.record_id, row.def_version, row.action,
            row.before && JSON.stringify(row.before), row.after && JSON.stringify(row.after), row.rules && JSON.stringify(row.rules), row.on_behalf_of ?? null, head.hash, hash],
    );
    await tx.query("UPDATE mes.audit_head SET hash = $1 WHERE id", [hash]);
    return hash;
}

// Recomputes the chain from the start: { ok, checked, brokenAt }.
export async function verifyAudit(db) {
    const rows = await db.query("SELECT * FROM mes.audit_log ORDER BY seq");
    let prev = "0".repeat(64);
    for (const r of rows) {
        const row = {
            at: new Date(r.at).toISOString(), actor: r.actor, object: r.object, record_id: r.record_id, def_version: r.def_version,
            action: r.action, before: r.before, after: r.after, rules: r.rules,
            ...(r.on_behalf_of ? { on_behalf_of: r.on_behalf_of } : {}),
        };
        if (r.prev_hash !== prev || r.hash !== sha256(prev + canonical(row))) return { ok: false, checked: rows.length, brokenAt: Number(r.seq) };
        prev = r.hash;
    }
    return { ok: true, checked: rows.length, brokenAt: null };
}
