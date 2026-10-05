// Read scaling (DESIGN.md §7): writes go to the primary; reads that tolerate a replica go to one, but
// only once the replica has replayed every write this process has committed. That is the fence: after
// each commit the primary's WAL position is noted, and a replica read first waits (briefly) until the
// replica's replay position has passed it. A replica too far behind is not waited for: the primary
// answers. So no screen is ever drawn from data older than the save that asked for it.
//
//   const routing = createRouting({ primary, replica, maxWaitMs, fence })
//   routing.db     the primary, for writes and the write path's own reads; commits move the fence
//   routing.read   (sql, params) → rows, from the replica when it has caught up, else the primary
//   routing.stats  counters for /healthz
//
// With several instances, the fence is advanced by the changes other instances publish on the bus
// (`advance`, fed by app.mjs's onInvalidate), each carrying the WAL position of its write (`lsn`).

const parse = (lsn) => {
    const [hi, lo] = String(lsn).split("/");
    return (BigInt(`0x${hi}`) << 32n) + BigInt(`0x${lo}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WRITES = /^\s*(insert|update|delete|create|alter|drop)\b/i;

export function createRouting({ primary, replica = null, maxWaitMs = 250, pollMs = 2, fence = true }) {
    const stats = { replica: Boolean(replica), fence, replicaReads: 0, primaryReads: 0, waited: 0, fellBack: 0, maxWaitMs: 0, lagBytes: 0 };
    let committed = 0n;   // the newest WAL position this process's writes reached
    let replayed = 0n;    // the newest replay position the replica has reported
    let asking = null;    // one replay query in flight, shared by every waiting read

    async function noteCommit() {
        const [{ lsn }] = await primary.query("SELECT pg_current_wal_lsn()::text AS lsn");
        const at = parse(lsn);
        if (at > committed) committed = at;
    }
    function askReplica() {
        asking ??= replica.query("SELECT pg_last_wal_replay_lsn()::text AS lsn")
            .then(([row]) => { if (row?.lsn) { const at = parse(row.lsn); if (at > replayed) replayed = at; } })
            .finally(() => { asking = null; });
        return asking;
    }
    async function caughtUp(target) {
        if (replayed >= target) return true;
        // A replica that does not answer has not caught up: the read goes to the primary.
        await askReplica().catch(() => {});
        return replayed >= target;
    }

    const db = {
        async query(sql, params) {
            const rows = await primary.query(sql, params);
            if (WRITES.test(sql)) await noteCommit();
            return rows;
        },
        async transaction(fn) {
            const out = await primary.transaction(fn);
            await noteCommit();
            return out;
        },
    };

    async function read(sql, params) {
        if (!replica) { stats.primaryReads += 1; return primary.query(sql, params); }
        if (fence) {
            const target = committed;
            if (!(await caughtUp(target))) {
                stats.waited += 1;
                const began = Date.now();
                while (Date.now() - began < maxWaitMs && !(await caughtUp(target))) await sleep(pollMs);
                stats.maxWaitMs = Math.max(stats.maxWaitMs, Date.now() - began);
                stats.lagBytes = Number(committed > replayed ? committed - replayed : 0n);
                if (replayed < target) {
                    stats.fellBack += 1;
                    stats.primaryReads += 1;
                    return primary.query(sql, params);
                }
            }
        }
        stats.replicaReads += 1;
        // The replica down (restarting, its connection lost): the primary answers the read instead of
        // the reader being refused. A statement that is itself wrong fails there the same way.
        return replica.query(sql, params).catch(() => { stats.primaryReads += 1; return primary.query(sql, params); });
    }

    // The fence across instances: a change published on the bus carries the WAL position its
    // instance reached (`$lsn`), and every instance that applies it moves its fence there before it
    // re-runs a single query, so a re-run caused by another instance's write waits for that write too.
    const lsn = () => `${(committed >> 32n).toString(16).toUpperCase()}/${(committed & 0xffffffffn).toString(16).toUpperCase()}`;
    const advance = (text) => {
        try { const at = parse(text); if (at > committed) committed = at; } catch { /* not a position */ }
    };

    return { db, read, stats, lsn, advance };
}
