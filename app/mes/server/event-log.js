// The event log: what happened to the system, as the audit trail (audit.js) records what happened to
// records. An instance started or stopped, or did not stop cleanly; the write database became
// unreachable and came back; a trigger was given up on.
//
// Written to a file first, because the events that matter most happen when the database is not
// there to take them: "the database is down" cannot be written to the database. Each instance
// appends one JSON event per line to its own file, with a sequence and a hash chain of its own (the
// audit trail's rule: a line removed or edited breaks the chain). A forwarder copies what the file
// holds into mes.event_log whenever the database takes it, keyed by (instance, seq), so copying
// twice never duplicates, and whatever was written during an outage arrives once it is over.
//
//   const events = createEventLog({ dir, instance, build, pid, runtime })
//   events.start()            logs the start, and an unclean stop of the run before when it finds one
//   events.emit(kind, { severity, message, incident, details })   → the event, appended
//   events.stop(reason)       logs the stop, and marks the stop clean
//   events.flush(db)          copies what the database lacks; answers how many
//   events.state()            { file, seq, pending } for /healthz
//
// A crash cannot log itself: a marker file says an instance is running, removed by a clean stop. A
// marker found at start is an unclean stop, logged then.
//
// One file per instance name: two processes must never share an instance name and a directory,
// or their chains fork.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonical, sha256 } from "./audit.js";

const GENESIS = "0".repeat(64);
export const SEVERITIES = ["info", "warning", "error", "critical"];

// The event's hash: over the previous hash and the event itself, without its own hash.
const hashOf = (event) => {
    const { hash, ...rest } = event;
    return sha256(rest.prev + canonical(rest));
};

// Every event in a file, in order; a line that does not parse is kept as { bad: line }.
export function readEvents(file) {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return { bad: line }; }
    });
}

// Recomputes a file's chain: { ok, checked, brokenAt } (brokenAt: the line number, from 1).
export function verifyEvents(file) {
    let prev = GENESIS;
    let seq = 0;
    const events = readEvents(file);
    for (const [i, e] of events.entries()) {
        if (e.bad !== undefined || e.prev !== prev || e.seq !== seq + 1 || e.hash !== hashOf(e)) return { ok: false, checked: events.length, brokenAt: i + 1 };
        prev = e.hash;
        seq = e.seq;
    }
    return { ok: true, checked: events.length, brokenAt: null };
}

// The last event of a file, read from its end (a file of years stays cheap to resume).
function lastEvent(file) {
    if (!existsSync(file)) return null;
    const fd = openSync(file, "r");
    try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, 64 * 1024);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        const lines = buffer.toString("utf8").split("\n").filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
            try { return JSON.parse(lines[i]); } catch { /* a torn last line: the one before it */ }
        }
        return null;
    } finally {
        closeSync(fd);
    }
}

export function createEventLog({ dir, instance = null, build = null, pid = null, runtime = null, log = console, now = () => new Date() }) {
    const name = instance ?? "local";
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, instance ? `event.${instance}.log` : "event.log");
    const marker = `${file}.running`;
    const last = lastEvent(file);
    let seq = last?.seq ?? 0;
    let prev = last?.hash ?? GENESIS;
    let pending = [];     // written to the file, not yet known to be in the database
    let ingested = null;  // the database's last seq for this instance, once asked

    function emit(kind, { severity = "info", message = kind, incident = null, details = null } = {}) {
        if (!SEVERITIES.includes(severity)) throw new TypeError(`event log: severity is one of ${SEVERITIES.join(", ")}`);
        const event = {
            seq: seq + 1, at: now().toISOString(), instance: name, build, kind, severity, message,
            ...(incident ? { incident } : {}), ...(details ? { details } : {}), prev,
        };
        event.hash = hashOf(event);
        try {
            appendFileSync(file, `${JSON.stringify(event)}\n`);
        } catch (error) {
            // Not written, so not in the chain: said where someone will see it, and dropped.
            log.error?.(`event log: could not write ${kind} to ${file}: ${error.message}`);
            return null;
        }
        seq = event.seq;
        prev = event.hash;
        pending.push(event);
        return event;
    }

    return {
        file,
        emit,
        start() {
            if (existsSync(marker)) {
                let before = null;
                try { before = JSON.parse(readFileSync(marker, "utf8")); } catch { /* unreadable: still unclean */ }
                emit("instance.unclean_stop", {
                    severity: "error",
                    message: `The previous run${before?.pid ? ` (pid ${before.pid}, started ${before.startedAt})` : ""} did not stop cleanly. Its last event was ${last ? `${last.kind} at ${last.at}` : "none"}.`,
                    details: { previous: before, lastEvent: last ? { seq: last.seq, kind: last.kind, at: last.at } : null },
                });
            }
            writeFileSync(marker, JSON.stringify({ pid, startedAt: now().toISOString(), build }));
            return emit("instance.start", { message: `Started${build ? ` (build ${build})` : ""}.`, details: { pid, runtime } });
        },
        stop(reason = "stop") {
            const event = emit("instance.stop", { message: `Stopped (${reason}).`, details: { reason } });
            rmSync(marker, { force: true });
            return event;
        },
        async flush(db) {
            if (ingested === null) {
                const [row] = await db.query("SELECT COALESCE(max(seq), 0)::bigint AS max FROM mes.event_log WHERE instance = $1", [name]);
                ingested = Number(row?.max ?? 0);
                // What the file holds beyond it: written during an outage, or by an earlier run.
                const known = new Set(pending.map((e) => e.seq));
                const older = readEvents(file).filter((e) => e.bad === undefined && e.instance === name && e.seq > ingested && !known.has(e.seq));
                pending = [...older, ...pending].sort((a, b) => a.seq - b.seq);
                // The database is ahead of the file: the file was lost (a new disk, a new container under
                // the same instance name) and this run began again at 1. Its events would all be "known
                // already" until it passed the old count, and none would arrive, with no word of it. The
                // numbering goes on from the database's, and what this run wrote so far is written again
                // under new numbers, after an event that says what happened.
                if (ingested > seq) {
                    const lost = pending.filter((e) => e.seq <= ingested);
                    log.error?.(`event log: the database holds events of ${name} up to ${ingested}, and its file only up to ${seq}: the file was lost. Numbering goes on from ${ingested}.`);
                    seq = ingested;
                    pending = [];
                    emit("event_log.reset", { severity: "critical", message: `The event log's file was lost: the database held events up to ${ingested}, the file ${lost.length ? `began again at ${lost[0].seq}` : "was empty"}. Numbering goes on from the database's.`, details: { databaseSeq: ingested, rewritten: lost.length } });
                    for (const e of lost) emit(e.kind, { severity: e.severity, message: e.message, incident: e.incident ?? null, details: { ...(e.details ?? {}), firstWrittenAt: e.at, firstSeq: e.seq } });
                }
            }
            const batch = pending.filter((e) => e.seq > ingested);
            if (batch.length) {
                const rows = batch.map((e) => ({ instance: e.instance, seq: e.seq, at: e.at, build: e.build, kind: e.kind, severity: e.severity, incident: e.incident ?? null, message: e.message, details: e.details ?? null, prev_hash: e.prev, hash: e.hash }));
                await db.query(
                    `INSERT INTO mes.event_log (instance, seq, at, build, kind, severity, incident, message, details, prev_hash, hash)
                     SELECT instance, seq, at, build, kind, severity, incident, message, details, prev_hash, hash
                     FROM jsonb_to_recordset($1::jsonb) AS x(instance text, seq bigint, at timestamptz, build text, kind text, severity text, incident text, message text, details jsonb, prev_hash text, hash text)
                     ON CONFLICT (instance, seq) DO NOTHING`,
                    [JSON.stringify(rows)],
                );
                ingested = batch.at(-1).seq;
            }
            pending = pending.filter((e) => e.seq > ingested);
            return batch.length;
        },
        state: () => ({ file, seq, pending: pending.length }),
    };
}

// The write database's outages as events (db-gate.js's onDown and onUp, and every call the app
// refused because of one): one incident from down to up, the calls refused per service, and each
// call whose outcome is unknown on its own, with what finds it again (object, id, action, key).
// Never the data it carried.
export function watchDb(events) {
    let incident = null;
    let refused = {};
    let unknown = 0;
    return {
        onDown(error) {
            incident = `db-${Date.now().toString(36)}`;
            refused = {};
            unknown = 0;
            events.emit("db.down", { severity: "critical", incident, message: `The write database is unreachable (${error?.code ?? error?.message ?? "no answer"}). Calls are refused until it answers.`, details: { error: String(error?.code ?? error?.message ?? error) } });
        },
        onUp({ downForMs = null } = {}) {
            const total = Object.values(refused).reduce((n, c) => n + c, 0);
            events.emit("db.up", {
                severity: "warning", incident,
                message: `The write database answers again${downForMs === null ? "" : ` after ${Math.round(downForMs / 1000)} s`}: ${total} call(s) refused, ${unknown} with an unknown outcome.`,
                details: { downForMs, refused, unknown },
            });
            incident = null;
        },
        // Told of every call the app refused with a db.* code.
        onRefused(service, error, args) {
            refused[service] = (refused[service] ?? 0) + 1;
            if (error?.code !== "db.unknown") return;
            unknown += 1;
            const a = args && typeof args === "object" ? args : {};
            events.emit("db.unknown_outcome", {
                severity: "error", incident,
                message: `${service} may or may not have been saved: the database stopped answering during COMMIT.`,
                details: { service, object: a.object ?? null, id: a.id ?? null, action: a.action ?? null, key: a.key ?? null },
            });
        },
    };
}
