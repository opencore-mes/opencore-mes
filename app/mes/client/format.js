// How the plant writes dates, times and numbers (DESIGN.md §27.6): one setting for every page, part of
// People & departments, so it is changed like the rest of the organization (designed, approved). What
// is stored never changes with it: a date is YYYY-MM-DD, a moment UTC, a number a number; only what
// people read and type does. Pure, so the server (its checks, its pages) and the browser share it.
//
//   formats: { locale: "de-DE",          numbers (1.250,5) and month names, as that locale writes them
//              date: "DD.MM.YYYY",       how a date is written and typed
//              time: "24h" | "12h",
//              firstDay: 1,              the week's first day (0 Sunday … 6 Saturday), for calendars
//              timeZone: "Europe/Berlin" the plant's clock; unset, the server's (PLANT_TZ) }

export const DATE_FORMATS = ["YYYY-MM-DD", "DD.MM.YYYY", "DD/MM/YYYY", "MM/DD/YYYY", "DD-MM-YYYY", "YYYY/MM/DD"];
export const DEFAULT_FORMATS = Object.freeze({ locale: "en-US", date: "YYYY-MM-DD", time: "24h", firstDay: 1, timeZone: "UTC" });
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const pad = (n) => String(n).padStart(2, "0");

// What is wrong with a formats setting: [messages].
export function formatsProblems(f) {
    if (f === undefined) return [];
    if (!isPlain(f)) return ["Formats are { locale, date, time, firstDay, timeZone }."];
    const out = [];
    for (const k of Object.keys(f)) if (!["locale", "date", "time", "firstDay", "timeZone"].includes(k)) out.push(`Formats: "${k}" is not locale, date, time, firstDay or timeZone.`);
    if (f.locale !== undefined) {
        try { if (typeof f.locale !== "string" || !Intl.getCanonicalLocales(f.locale).length) throw new Error(); } catch { out.push(`Formats: "${f.locale}" is not a locale (e.g. en-US, de-DE, fr-FR).`); }
    }
    if (f.date !== undefined && !DATE_FORMATS.includes(f.date)) out.push(`Formats: dates are written ${DATE_FORMATS.join(", ")}.`);
    if (f.time !== undefined && !["24h", "12h"].includes(f.time)) out.push("Formats: the time is 24h or 12h.");
    if (f.firstDay !== undefined && !(Number.isInteger(f.firstDay) && f.firstDay >= 0 && f.firstDay <= 6)) out.push("Formats: the week's first day is 0 (Sunday) to 6 (Saturday).");
    if (f.timeZone !== undefined) {
        try { new Intl.DateTimeFormat("en-US", { timeZone: f.timeZone }); } catch { out.push(`Formats: "${f.timeZone}" is not a time zone (e.g. Europe/Berlin, America/Chicago).`); }
    }
    return out;
}

// The setting as used: the plant's, over the defaults.
export const formatsOf = (f) => ({ ...DEFAULT_FORMATS, ...(isPlain(f) ? Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== null && v !== "")) : {}) });

const write = (pattern, y, m, d) => pattern.replace("YYYY", y).replace("MM", pad(m)).replace("DD", pad(d));

// A date (YYYY-MM-DD) as the plant writes it; anything else as it is.
export function formatDate(iso, f = DEFAULT_FORMATS) {
    const m = typeof iso === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
    return m ? write(f.date ?? DEFAULT_FORMATS.date, m[1], Number(m[2]), Number(m[3])) : iso ?? "";
}

// A date as typed in the plant's way (or as YYYY-MM-DD): → "YYYY-MM-DD", or null when it does not read
// as a real date.
export function parseDate(text, f = DEFAULT_FORMATS) {
    const t = String(text ?? "").trim();
    if (!t) return null;
    const order = (f.date ?? DEFAULT_FORMATS.date).match(/YYYY|MM|DD/g);
    const parts = t.split(/[^0-9]+/).filter(Boolean);
    let y, m, d;
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) [y, m, d] = parts.map(Number);
    else {
        if (parts.length !== 3) return null;
        const at = Object.fromEntries(order.map((k, i) => [k, Number(parts[i])]));
        [y, m, d] = [at.YYYY, at.MM, at.DD];
        if (y < 100) y += 2000;
    }
    const date = new Date(Date.UTC(y, m - 1, d));
    if (!y || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
}

// A moment (an ISO timestamp, a Date, epoch ms) on the plant's clock: its date and time, as written there.
function partsOf(at, f) {
    const date = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(date.getTime())) return null;
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: f.timeZone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date).map((x) => [x.type, x.value]));
    return { y: p.year, m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: p.minute, s: p.second };
}
const clock = (p, f, seconds) => {
    const tail = `${p.min}${seconds ? `:${p.s}` : ""}`;
    if ((f.time ?? "24h") === "12h") return `${((p.h + 11) % 12) + 1}:${tail} ${p.h < 12 ? "AM" : "PM"}`;
    return `${pad(p.h)}:${tail}`;
};
export function formatDateTime(at, f = DEFAULT_FORMATS, { seconds = false } = {}) {
    const p = at === null || at === undefined || at === "" ? null : partsOf(at, f);
    return p ? `${write(f.date ?? DEFAULT_FORMATS.date, p.y, p.m, p.d)} ${clock(p, f, seconds)}` : "";
}
export function formatTime(at, f = DEFAULT_FORMATS, { seconds = false } = {}) {
    const p = at === null || at === undefined || at === "" ? null : partsOf(at, f);
    return p ? clock(p, f, seconds) : "";
}
// The plant's date of a moment: what "today" is there.
export function dayOf(at, f = DEFAULT_FORMATS) {
    const p = partsOf(at, f);
    return p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : null;
}

// A number as the plant's locale writes it (1,250.5 or 1.250,5): every digit it has, never rounded,
// since what is shown is what was stored and what someone signs (0.0004 read "0" at three places).
// A figure worked out for show (an average) says how many places it wants: { max: 3 }.
export function formatNumber(n, f = DEFAULT_FORMATS, { max = 20 } = {}) {
    if (n === null || n === undefined || n === "" || !Number.isFinite(Number(n))) return n ?? "";
    // Text holding more digits than a number keeps is shown as it is, not as the number nearest to it.
    if (typeof n === "string" && String(Number(n)) !== n.trim() && /^-?\d{16,}$/.test(n.trim())) return n;
    try { return new Intl.NumberFormat(f.locale ?? DEFAULT_FORMATS.locale, { maximumFractionDigits: max }).format(Number(n)); } catch { return String(n); }
}

// The setting a page uses, as a formatter: `fmt(api)` reads the plant's from the page's state.
export function formatter(f) {
    const use = formatsOf(f);
    return {
        formats: use,
        date: (iso) => formatDate(iso, use),
        dateTime: (at, o) => formatDateTime(at, use, o),
        time: (at, o) => formatTime(at, use, o),
        number: (n, o) => formatNumber(n, use, o),
        parseDate: (text) => parseDate(text, use),
        datePattern: use.date,
    };
}
export const fmt = (api) => formatter(api.getState("formats", null));

// The plant's setting for code that draws without a page's state at hand (a list's cell, a history
// line): one plant, one setting, set by the page's root (shell.js App) on every render, on the server
// and in the browser, before anything below it is drawn.
let current = formatter(null);
export function usePlantFormats(f) { current = formatter(f); }
export const plant = () => current;

// A design's label as a noun in a sentence ("New PM record", "a metrology reading"): lower case, except a
// word written with two or more capitals, which is an abbreviation people read as such (PM, WAT, AI).
export const noun = (label) => String(label ?? "").split(/(\s+)/).map((w) => ((w.match(/[A-Z]/g) ?? []).length >= 2 ? w : w.toLowerCase())).join("");
