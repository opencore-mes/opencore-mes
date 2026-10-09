// How long the plant keeps each kind of data (DESIGN.md §27.8, COMPLIANCE.md G11), without a server: the
// kinds, the setting's check, and the periods in force. One module for the People & departments editor,
// the change's check on the server, the purge (server/retention.js) and the Data retention page.
//
// The setting is part of the organization, approved by governance like the formats (§27.6):
//   "retention": { "conversations": 365, "integration": 730, "audit": "forever" }
// a number of days, or "forever"; a kind left out keeps its default. Two kinds are never purged by the
// platform, whatever their period: records (archived, never deleted: Part 11, genealogy) and the audit
// trail (append-only, §7.3). Their period is what the plant promises to keep, with a floor, and the
// Data retention page counts what is past it; taking them out of the database is not the platform's.
// The others are purged by the instance that schedules, past their period.

export const FOREVER = "forever";
const YEAR = 365;
// Never shorter: HIPAA keeps documentation six years (§164.316(b)(2)); Part 11 keeps an audit trail as
// long as the records it describes (§11.10(e)), so the audit trail is never kept shorter than the records.
export const AUDIT_FLOOR_DAYS = 6 * YEAR;
export const MAX_DAYS = 100 * YEAR;

// key: the setting's name; purged: whether the platform removes what is past its period (else counted
// only); days: the default (null: forever); floor: the shortest period allowed, in days.
export const RETENTION_KINDS = [
    { key: "records", label: "Archived records", purged: false, days: null, floor: AUDIT_FLOOR_DAYS, what: "Records archived (out of use, read-only), with what they carry: their pictures and documents, their routes' runs. Never deleted by the platform; a person's personal data in them is erased on its own (Data retention, Erase)." },
    { key: "audit", label: "The audit trail", purged: false, days: null, floor: AUDIT_FLOOR_DAYS, what: "Every change, signature, refusal and sign-in, hash-chained. Append-only: never purged by the platform. At least six years, and at least as long as the records." },
    { key: "events", label: "The event log's copy", purged: true, days: null, floor: YEAR, what: "What happened to the system (instances started and stopped, outages, retention runs), as copied into the database. Each instance's last event stays, so its numbering goes on; its own file is not touched." },
    { key: "conversations", label: "AI conversations", purged: true, days: null, floor: 7, what: "The design copilot's conversations (with their change) and the analytics copilot's, counted from their last message. One under way is never purged." },
    { key: "saved", label: "Saved selections and kept prompts", purged: true, days: null, floor: 30, what: "Sandbox selections and kept report prompts no one has changed or run for this long. The reports they made are records (Archived records)." },
    { key: "sign_in", label: "Sign-in leftovers", purged: true, days: 30, floor: 1, what: "Sessions ended or expired, password links used or expired, sign-ins and fresh sign-ins left half done, counted from when each ended. Who signed in, and who made a link, stays in the audit trail." },
    { key: "integration", label: "Integration runs", purged: true, days: null, floor: 7, what: "Finished runs of triggers and schedules (done, refused, given up), with what they were sent and answered. Runs waiting or under way are never purged." },
    { key: "answers", label: "Answers kept for retries", purged: true, days: 90, floor: 7, what: "The answer to each request made with a key, kept so that the same request sent again is answered, not done twice." },
];
export const KIND = Object.fromEntries(RETENTION_KINDS.map((k) => [k.key, k]));

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Words for a period: "forever", "90 days", "1 year", "6 years", "400 days".
export function periodWords(days) {
    if (days === null || days === undefined || days === FOREVER) return "forever";
    if (days % YEAR === 0) return `${days / YEAR} year${days === YEAR ? "" : "s"}`;
    return `${days} day${days === 1 ? "" : "s"}`;
}

// What a person types in the editor (a number of days, "forever", "6y", "6 years", empty) → what is kept
// in the setting: a number, "forever", undefined (the default), or the text itself, which the check names.
export function parsePeriod(text) {
    const t = String(text ?? "").trim().toLowerCase();
    if (!t) return undefined;
    if (t === FOREVER) return FOREVER;
    const m = /^(\d+)\s*(d|days?|y|years?)?$/.exec(t);
    if (!m) return String(text).trim();
    return Number(m[1]) * (m[2]?.startsWith("y") ? YEAR : 1);
}

// The setting's mistakes, in words: [messages].
export function retentionProblems(retention) {
    if (retention === undefined) return [];
    if (!isPlain(retention)) return ["Retention is { kind: days or \"forever\" }."];
    const out = [];
    for (const [key, value] of Object.entries(retention)) {
        const kind = KIND[key];
        if (!kind) { out.push(`"${key}" is not a kind of data kept (${RETENTION_KINDS.map((k) => k.key).join(", ")}).`); continue; }
        if (value === FOREVER) continue;
        if (!Number.isInteger(value) || value < 1) { out.push(`${kind.label}: "${value}" is not a period: a whole number of days (365 for a year), or "forever".`); continue; }
        if (value < kind.floor) out.push(`${kind.label}: at least ${periodWords(kind.floor)}${kind.key === "audit" || kind.key === "records" ? " (HIPAA §164.316 keeps documentation six years)" : ""}, not ${periodWords(value)}.`);
        if (value > MAX_DAYS) out.push(`${kind.label}: at most ${periodWords(MAX_DAYS)}; longer is "forever".`);
    }
    // The audit trail outlives the records it describes (Part 11 §11.10(e)).
    const p = periodsOf(retention);
    if (p.audit !== null && (p.records === null || p.records > p.audit)) out.push(`The audit trail is kept at least as long as the records it describes (Part 11 §11.10(e)): records ${periodWords(p.records)}, the audit trail ${periodWords(p.audit)}.`);
    return out;
}

// The periods in force, in days, per kind (null: forever): the setting's, else the default. A value
// the check refuses never reaches a published setting; one that did would count as the default.
export function periodsOf(retention) {
    const given = isPlain(retention) ? retention : {};
    return Object.fromEntries(RETENTION_KINDS.map((k) => {
        const v = given[k.key];
        if (v === FOREVER) return [k.key, null];
        return [k.key, Number.isInteger(v) && v >= k.floor && v <= MAX_DAYS ? v : k.days];
    }));
}

// The moment before which a kind's data is past its period (ISO), or null when it is kept forever.
export function cutoffOf(days, now = Date.now()) {
    return days === null || days === undefined ? null : new Date(now - days * 86_400_000).toISOString();
}

// ---- erasure (§27.8): a person's personal data taken out of a record, the record and its history kept ----
// A field holds personal data the plant may have to erase when its object's design says so (`erasable:
// true`, approved by the field's stewards). What an erased field holds instead: text says it was erased;
// anything else is emptied.
export const ERASED = "[erased]";
export const erasableFields = (body) => Object.entries(body?.fields ?? {}).filter(([, f]) => f?.erasable === true).map(([name]) => name);
export const tombstoneOf = (field) => (field?.type === "string" || field?.type === "text" ? ERASED : null);
// Whether a value is already what erasing leaves (nothing to erase).
export const isErased = (field, value) => value === undefined || value === null || value === "" || value === tombstoneOf(field) || (Array.isArray(value) && !value.length);
