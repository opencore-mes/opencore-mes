// Schedules (DESIGN.md §15.3): a service's trigger that the clock sets off. The same code runs in
// the browser (the designer's check and its "next runs" preview) and on the server (the scheduler).
//
// A schedule is structured, not a cron string, so an engineer and the AI read it alike and nothing
// has to parse cron:
//   { "schedule": { "every": { "minutes": 15 }, "between": ["06:00", "22:00"],
//                   "days": ["mon", "tue", "wed", "thu", "fri"], "tz": "Europe/Berlin" },
//     "missed": "last", "overlap": "skip" }
//   { "schedule": { "at": ["06:00", "14:00", "22:00"] } }
//
//   every     { minutes: 1–720 } or { hours: 1–24 }, counted from midnight
//   at        times of day, "HH:MM"
//   between   narrows `every` to a window of the day; one that crosses midnight ("22:00", "06:00") is
//             allowed
//   days      the days it runs, by the calendar day of each run; all days when left out
//   tz        an IANA time zone; the plant's when left out. Times follow daylight saving: a time the
//             clock skips runs at the moment it would have been (02:30 → 03:30), and a time that
//             happens twice runs once, the first time
//   missed    what the scheduler does with runs it could not start on time (every node, or the
//             database, was down): "none" skips them, "last" (the default) runs the latest one,
//             "all" runs each of them, up to MAX_CATCH_UP
//   overlap   "skip" (the default): no new run while one is still waiting or running; "queue": queue
//             it anyway
//
// Or the times come from a kind of schedule an installed suite adds (§30.11), named "<suite>.<kind>",
// with the settings its kind names, and tz if wanted; missed and overlap as above:
//   { "schedule": { "from": "<suite>.<kind>", "<setting>": value, "tz": "Europe/Berlin" } }
// Only the suite can work its times out (a calendar it keeps, say): the server asks it
// (integration.js), and the browser checks the shape against the kinds design.home names. With the
// suite gone the design stays as it is, says what it needs, and nothing is planned for it.
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const MISSED = ["none", "last", "all"];
export const OVERLAP = ["skip", "queue"];
export const MAX_CATCH_UP = 100;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

export const isSchedule = (trigger) => isPlain(trigger) && trigger.schedule !== undefined;
// A schedule whose times a suite's kind works out: { schedule: { from: "<suite>.<kind>", … } }.
export const isSuiteSchedule = (trigger) => isSchedule(trigger) && isPlain(trigger.schedule) && trigger.schedule.from !== undefined;
export const SUITE_KIND = /^[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9_]{0,47}$/;
export const suiteOf = (kind) => String(kind ?? "").split(".")[0];
// What a suite's kind is given: the schedule's own settings, without from and tz.
export function suiteSettings(trigger) {
    const { from, tz, ...settings } = isPlain(trigger?.schedule) ? trigger.schedule : {};
    return settings;
}
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export function validTimeZone(tz) {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

function everyMinutes(every) {
    if (!isPlain(every) || Object.keys(every).length !== 1) return null;
    if (Number.isInteger(every.minutes) && every.minutes >= 1 && every.minutes <= 720) return every.minutes;
    if (Number.isInteger(every.hours) && every.hours >= 1 && every.hours <= 24) return every.hours * 60;
    return null;
}

// The types a suite's schedule kind may give its settings (`config`), as the designer edits them; any
// other type is the suite's own to check.
const SETTING_TYPES = {
    number: (v) => typeof v === "number" && Number.isFinite(v),
    integer: (v) => Number.isInteger(v),
    string: (v) => typeof v === "string",
    text: (v) => typeof v === "string",
    boolean: (v) => typeof v === "boolean",
    list: (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
};
const TYPE_WORDS = { number: "a number", integer: "a whole number", string: "text", text: "text", boolean: "yes or no", list: "a list of words" };
const filled = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);

// A schedule from a suite's kind, against the kinds installed (`known.suiteSchedules`: kind → { label,
// config, required }); left out, only its shape is checked and the server's check decides. The suite's
// own check of its settings (its `validate`) runs on the server.
function suiteScheduleProblems(trigger, known) {
    const problems = [];
    const s = trigger.schedule;
    if (["every", "at", "between", "days"].some((k) => s[k] !== undefined)) problems.push("A schedule from a suite has no every, at, between or days: the suite works its times out.");
    if (typeof s.from !== "string" || !SUITE_KIND.test(s.from)) problems.push('from names a kind of schedule an installed suite adds: "<suite>.<kind>".');
    if (s.tz !== undefined && (typeof s.tz !== "string" || !validTimeZone(s.tz))) problems.push(`"${s.tz}" is not a time zone (for example Europe/Berlin).`);
    if (typeof s.from === "string" && SUITE_KIND.test(s.from) && isPlain(known.suiteSchedules)) {
        const spec = known.suiteSchedules[s.from];
        if (!spec) problems.push(`"${s.from}" needs the ${suiteOf(s.from)} suite, which is not installed here: nothing is planned for it until the suite is back.`);
        else {
            const label = spec.label ?? s.from;
            const config = isPlain(spec.config) ? spec.config : {};
            const settings = suiteSettings(trigger);
            for (const k of Array.isArray(spec.required) ? spec.required : []) if (!filled(settings[k])) problems.push(`${label}: "${k}" is needed.`);
            for (const [k, v] of Object.entries(settings)) {
                if (!Object.hasOwn(config, k)) { if (!Object.hasOwn(config, "*")) problems.push(`${label} has no setting "${k}" (${Object.keys(config).join(", ") || "none"}).`); continue; }
                if (filled(v) && SETTING_TYPES[config[k]] && !SETTING_TYPES[config[k]](v)) problems.push(`${label}: "${k}" is ${TYPE_WORDS[config[k]]}.`);
            }
        }
    }
    if (trigger.missed !== undefined && !MISSED.includes(trigger.missed)) problems.push(`missed is ${MISSED.join(", ")}.`);
    if (trigger.overlap !== undefined && !OVERLAP.includes(trigger.overlap)) problems.push(`overlap is ${OVERLAP.join(" or ")}.`);
    return problems;
}

// What is wrong with a schedule trigger: [message]. `known.suiteSchedules`: the kinds the installed
// suites add, for a schedule that comes from one.
export function scheduleProblems(trigger, known = {}) {
    const problems = [];
    const s = trigger?.schedule;
    if (!isPlain(s)) return ["A schedule is an object: { every } or { at }, with days, between and tz if wanted; or { from } a suite's kind."];
    if (s.from !== undefined) return suiteScheduleProblems(trigger, known ?? {});
    const hasEvery = s.every !== undefined;
    const hasAt = s.at !== undefined;
    if (hasEvery === hasAt) problems.push("A schedule runs either every N minutes or hours (every), or at times of day (at).");
    if (hasEvery && !everyMinutes(s.every)) problems.push("every is { minutes: 1–720 } or { hours: 1–24 }.");
    if (hasAt && (!Array.isArray(s.at) || !s.at.length || !s.at.every((t) => typeof t === "string" && TIME.test(t)))) problems.push('at lists times of day, "HH:MM".');
    if (s.days !== undefined && (!Array.isArray(s.days) || !s.days.length || !s.days.every((d) => DAYS.includes(d)))) problems.push(`days are some of ${DAYS.join(", ")}.`);
    if (s.between !== undefined) {
        if (!hasEvery) problems.push("between narrows a schedule that runs every N minutes or hours.");
        else if (!Array.isArray(s.between) || s.between.length !== 2 || !s.between.every((t) => typeof t === "string" && TIME.test(t)) || s.between[0] === s.between[1]) problems.push('between is ["HH:MM", "HH:MM"]: two different times.');
    }
    if (s.tz !== undefined && (typeof s.tz !== "string" || !validTimeZone(s.tz))) problems.push(`"${s.tz}" is not a time zone (for example Europe/Berlin).`);
    for (const key of Object.keys(s)) if (!["every", "at", "between", "days", "tz"].includes(key)) problems.push(`A schedule has no "${key}".`);
    if (trigger.missed !== undefined && !MISSED.includes(trigger.missed)) problems.push(`missed is ${MISSED.join(", ")}.`);
    if (trigger.overlap !== undefined && !OVERLAP.includes(trigger.overlap)) problems.push(`overlap is ${OVERLAP.join(" or ")}.`);
    if (!problems.length && !slotsOf(s).length) problems.push("It never runs: the window leaves no time for it.");
    return problems;
}

// The minutes after midnight at which it runs, on a day it runs.
function slotsOf(s) {
    if (Array.isArray(s.at)) return [...new Set(s.at.filter((t) => TIME.test(t)).map(toMinutes))].sort((a, b) => a - b);
    const step = everyMinutes(s.every);
    if (!step) return [];
    const [from, to] = Array.isArray(s.between) ? s.between.map(toMinutes) : [0, 1440];
    const inside = (m) => (from < to ? m >= from && m < to : m >= from || m < to);
    const out = [];
    for (let m = 0; m < 1440; m += step) if (inside(m)) out.push(m);
    return out;
}

// ---- time zones, with nothing but Intl ------------------------------------------------------
const formatters = new Map();
function wallAt(ms, tz) {
    let f = formatters.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
        formatters.set(tz, f);
    }
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}
const offsetAt = (ms, tz) => {
    const w = wallAt(ms, tz);
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
};
// The instant a wall-clock time happens in `tz`: the first of two when the clock falls back, and
// the moment it would have been when the clock springs forward over it.
export function instantOf(y, mo, d, h, mi, tz) {
    const wall = Date.UTC(y, mo - 1, d, h, mi);
    const before = offsetAt(wall - DAY_MS, tz);
    const after = offsetAt(wall + DAY_MS, tz);
    const matches = [...new Set([wall - before, wall - after])].filter((t) => {
        const w = wallAt(t, tz);
        return w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi;
    });
    return matches.length ? Math.min(...matches) : wall - before;
}

// The runs after `afterMs`: at most `limit`, none after `untilMs`. Instants in ms.
export function runsOf(trigger, afterMs, { untilMs = Infinity, limit = 5, tz: plantTz = "UTC" } = {}) {
    const s = trigger?.schedule;
    // (A suite's kind: only the server can ask it, integration.js.)
    if (!isPlain(s) || s.from !== undefined || scheduleProblems(trigger).length) return [];
    const tz = s.tz ?? plantTz;
    const slots = slotsOf(s);
    const start = wallAt(afterMs, tz);
    const out = [];
    const lastDay = Number.isFinite(untilMs) ? Math.ceil((untilMs - afterMs) / DAY_MS) + 2 : 400;
    for (let i = 0; i <= lastDay && out.length < limit; i++) {
        const date = new Date(Date.UTC(start.y, start.mo - 1, start.d + i));
        if (Array.isArray(s.days) && !s.days.includes(DAYS[(date.getUTCDay() + 6) % 7])) continue;
        // The day's instants in the order they come: on the day the clocks go forward, a wall time
        // that is skipped falls after the slot that follows it, so "past the end" for one slot says
        // nothing about the next (a 03:00 run after a skipped 02:30 was never queued).
        const day = slots.map((m) => instantOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), Math.floor(m / 60), m % 60, tz)).sort((a, b) => a - b);
        for (const t of day) {
            if (t <= afterMs || t > untilMs || out.includes(t)) continue;
            out.push(t);
            if (out.length >= limit) break;
        }
    }
    return out.sort((a, b) => a - b);
}

// The next run of a service's schedules after `afterMs`, or null.
export function nextRunOf(triggers, afterMs, tz) {
    const next = (Array.isArray(triggers) ? triggers : []).filter(isSchedule).map((t) => runsOf(t, afterMs, { limit: 1, tz })[0]).filter(Number.isFinite);
    return next.length ? Math.min(...next) : null;
}

// In words: "every 15 min, 06:00–22:00, Mon–Fri (Europe/Berlin)". One from a suite's kind is in the
// suite's words (`kinds`: kind → { label, describe? }; the server has describe, the browser the label),
// or says which suite it needs.
export function describeSchedule(trigger, plantTz = "UTC", kinds = {}) {
    const s = trigger?.schedule;
    if (!isPlain(s)) return "";
    if (s.from !== undefined) {
        const spec = isPlain(kinds) ? kinds[s.from] : undefined;
        if (!spec) return `${s.from} (needs the ${suiteOf(s.from)} suite, which is not installed here)`;
        let words = null;
        try { words = typeof spec.describe === "function" ? spec.describe(suiteSettings(trigger)) : null; } catch { words = null; }
        return `${typeof words === "string" && words.trim() ? words.trim() : spec.label ?? s.from}${s.tz ? ` (${s.tz})` : ""}`;
    }
    const minutes = everyMinutes(s.every);
    const when = Array.isArray(s.at)
        ? `at ${s.at.join(", ")}`
        : minutes ? `every ${minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`}${Array.isArray(s.between) ? `, ${s.between[0]}–${s.between[1]}` : ""}` : "?";
    const days = Array.isArray(s.days) && s.days.length < 7 ? `, ${s.days.map((d) => d[0].toUpperCase() + d.slice(1)).join(" ")}` : "";
    return `${when}${days} (${s.tz ?? plantTz})`;
}
