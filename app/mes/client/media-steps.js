// The steps of a guide shown on a screen (DESIGN.md §35.4): a line each, where it starts and what it is,
//   1 Remove the cover          (a PDF: the page it is on)
//   0:12 Remove the cover       (a video: when it starts, m:ss or h:mm:ss; a plain number is seconds)
//   3 Torque crosswise #photo   (how it is marked done, where the guide records it:
//                                  #click         a click, the default
//                                  #value:<input> a value typed or scanned, into that input of the transaction
//                                  #photo         a picture taken (the camera on a phone or tablet)
//                                  #file          a file uploaded (both into the block's evidence input, or
//                                                 #photo:<input>, #file:<input> for one of their own)
//                                  #device        by the equipment or a system, never at the screen
//                                  #wait          by anything else: another transaction, a flow, a service
//                                  #screen:<name> on another screen, which the step opens)
// Shared by the design check (definition.js), the server (screens.js) and the page (media.js): it imports
// nothing. → [{ n, at, label, needs, into? }] in the order written (n: the step's number, what the guide records
// as done), or { problems } for lines it cannot read.
export const MAX_STEPS_TEXT = 4000;
const LINE = /^\s*(\d{1,6}(?::\d{1,2}){0,2})\s+(\S.*)$/;

// "1:02:03" → 3723; "75" → 75; "1:75" → null (a minute has 60 seconds).
export function secondsOf(text) {
    const parts = String(text).split(":").map(Number);
    if (parts.some((p) => !Number.isInteger(p) || p < 0)) return null;
    if (parts.slice(1).some((p) => p > 59)) return null;
    return parts.reduce((t, p) => t * 60 + p, 0);
}
export const timeWords = (s) => {
    const n = Math.max(0, Math.floor(s));
    const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), sec = n % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

export function parseSteps(text) {
    const steps = [];
    const problems = [];
    if (text === undefined || text === null || text === "") return { steps, problems };
    if (typeof text !== "string") return { steps, problems: ["the steps are text: a line each"] };
    if (text.length > MAX_STEPS_TEXT) problems.push(`the steps are at most ${MAX_STEPS_TEXT} characters`);
    for (const [i, raw] of text.split(/\r?\n/).entries()) {
        if (!raw.trim()) continue;
        const m = LINE.exec(raw);
        const at = m ? secondsOf(m[1]) : null;
        if (!m || at === null) { problems.push(`line ${i + 1}, "${raw.trim().slice(0, 40)}": start it with a page (3) or a time (0:45), then the step's words`); continue; }
        const tag = /(?:^|\s)#([a-z]+)(?::([a-z][a-z0-9_]*))?\s*$/i.exec(m[2]);
        const label = (tag ? m[2].slice(0, tag.index) : m[2]).trim().slice(0, 120);
        if (!label) { problems.push(`line ${i + 1}: say what the step is, besides how it is done`); continue; }
        const needs = tag ? tag[1].toLowerCase() : "click";
        const into = tag?.[2];
        if (!NEEDS.includes(needs)) { problems.push(`line ${i + 1}: #${tag[1]} is not how a step is done (${NEEDS.map((n) => `#${n}`).join(", ")})`); continue; }
        if (TARGET[needs] === "required" && !into) { problems.push(`line ${i + 1}: #${needs} names ${needs === "screen" ? "the screen" : "the input"} (#${needs}:<name>)`); continue; }
        if (!TARGET[needs] && into) { problems.push(`line ${i + 1}: #${needs} names nothing after it`); continue; }
        steps.push({ n: steps.length + 1, at, time: m[1].includes(":"), label, needs, ...(into ? { into } : {}) });
    }
    if (steps.length > 100) problems.push("at most 100 steps");
    return { steps: steps.slice(0, 100), problems };
}

// For a PDF: each step's page (a time makes no sense there: its whole number of seconds is not a page).
export const pageSteps = (steps) => steps.filter((s) => !s.time && s.at >= 1).map((s, i) => ({ ...s, n: s.n ?? i + 1, page: s.at, needs: s.needs ?? "click" }));
// For a video: each step's start in seconds, in order.
export const timeSteps = (steps) => steps.map((s, i) => ({ ...s, n: s.n ?? i + 1, start: s.at, needs: s.needs ?? "click" })).sort((a, b) => a.start - b.start);
// How a step is marked done, and whether it names something after a colon.
export const NEEDS = ["click", "value", "photo", "file", "device", "wait", "screen"];
const TARGET = { value: "required", screen: "required", photo: "optional", file: "optional" };
// The ones done at the screen, through the block's transaction (the others are read back from its log).
export const AT_SCREEN = ["click", "value", "photo", "file"];
// The input of the transaction a step fills besides the step's number: its value, its photo or its file.
export const intoOf = (step, done) => (step.needs === "value" ? step.into : ["photo", "file"].includes(step.needs) ? step.into ?? done?.evidence : null);
// Which step a page or a moment is in: the last that starts at or before it (-1: before the first).
export const stepAt = (starts, at) => { let k = -1; for (const [i, s] of starts.entries()) if (s <= at + 0.05) k = i; return k; };
