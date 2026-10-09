// Files on records and screens (DESIGN.md §35.4): uploading one to the file store, and showing it as what it
// is: a picture shown, a video played (its bytes read as it plays, so it seeks), a PDF read in the page, a
// spreadsheet offered to save. A file's name in the store is the SHA-256 of its bytes; a record's file is
// read through the record (`/file/<object>/<id>/<field>`), as its reader, and a design's own (a screen's
// guide) by its name (`/blob/<sha256>`).
//
// The media view is the only place the platform draws an <iframe> (app.mjs and boot.js allow the tag): its
// source is always one of those two addresses, built here, never a value a design or a record gives.
import { icon } from "./icons.js";
import { plant } from "./format.js";
import { pageSteps, timeSteps, stepAt, timeWords } from "./media-steps.js";
import { signDialog, freshSignOn } from "./sign.js";
import { confirmDialog } from "./dialog.js";

// pdf.js (vendored, /vendor/pdf.js, its worker beside it), loaded the first time a PDF is drawn. A browser it
// does not run in, or a PDF it cannot read, is shown by the browser's own viewer instead.
let pdfLibrary = null;
const loadPdf = () => (pdfLibrary ??= import("/vendor/pdf.js").then((lib) => { lib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.js"; return lib; }));

export const BLOB = /^[0-9a-f]{64}$/;
// The kinds a file field may accept (definition.js FILE_KINDS), as the browser's file picker knows them.
export const FILE_TYPES = {
    picture: ["image/png", "image/jpeg", "image/webp"],
    pdf: ["application/pdf"],
    video: ["video/mp4", "video/webm"],
    spreadsheet: ["text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
};
const EXTENSIONS = { picture: [".png", ".jpg", ".jpeg", ".webp"], pdf: [".pdf"], video: [".mp4", ".webm"], spreadsheet: [".csv", ".xlsx"] };
export const DEFAULT_ACCEPT = ["picture", "pdf", "video"];
const kinds = (accept) => (Array.isArray(accept) && accept.length ? accept : DEFAULT_ACCEPT);
// The file picker's `accept`: the types and their extensions (a CSV file is often typed otherwise).
export const acceptAttr = (accept) => kinds(accept).flatMap((k) => [...(FILE_TYPES[k] ?? []), ...(EXTENSIONS[k] ?? [])]).join(",");
// The most a file of a kind may be (server/blobs.js: pictures 5 MB, documents 10 MB, videos 100 MB).
const LIMITS = { picture: 5_000_000, pdf: 10_000_000, spreadsheet: 10_000_000, video: 100_000_000 };
export const kindOf = (type) => Object.keys(FILE_TYPES).find((k) => FILE_TYPES[k].includes(type)) ?? null;
const KIND_WORDS = { picture: "a picture", pdf: "a PDF", video: "a video (MP4, WebM)", spreadsheet: "a CSV file or an Excel workbook" };
export const acceptWords = (accept) => { const w = kinds(accept).map((k) => KIND_WORDS[k] ?? k); return w.length > 1 ? `${w.slice(0, -1).join(", ")} or ${w.at(-1)}` : w[0]; };
export const sizeWords = (n) => (typeof n !== "number" ? "" : n >= 1_000_000 ? `${plant().number(Math.round(n / 100_000) / 10)} MB` : `${plant().number(Math.max(1, Math.round(n / 1000)))} kB`);

// → { blob, type, size, name }; throws in words a person can act on. The kind is the server's to say (it
// reads the bytes): the browser's word for it is only checked first, to say so sooner.
export async function uploadFile(file, accept) {
    if (!file) throw new Error("Choose a file.");
    const kind = kindOf(file.type) ?? (file.name.toLowerCase().endsWith(".csv") ? "spreadsheet" : null);
    if (kind && !kinds(accept).includes(kind)) throw new Error(`This takes ${acceptWords(accept)}.`);
    if (kind && file.size > LIMITS[kind]) throw new Error(`${KIND_WORDS[kind][0].toUpperCase()}${KIND_WORDS[kind].slice(1)} is at most ${LIMITS[kind] / 1_000_000} MB.`);
    const res = await fetch(`/blob?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "The file could not be uploaded.");
    if (!kinds(accept).includes(kindOf(body.type))) throw new Error(`This takes ${acceptWords(accept)}; that file is ${KIND_WORDS[kindOf(body.type)] ?? "something else"}.`);
    return body;
}

// Where a file is read: a record's through the record, a design's own by its name.
export const recordFileUrl = (object, id, field) => `/file/${encodeURIComponent(object)}/${encodeURIComponent(id)}/${encodeURIComponent(field)}`;
export const blobUrl = (blob) => (typeof blob === "string" && BLOB.test(blob) ? `/blob/${blob}` : null);
// What a file is, asked of the store without its bytes (HEAD): { type, size, name } or null.
export async function aboutFile(src) {
    try {
        const res = await fetch(src, { method: "HEAD" });
        if (!res.ok) return null;
        const name = /filename="([^"]*)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? null;
        return { type: res.headers.get("content-type"), size: Number(res.headers.get("content-length")) || null, name };
    } catch {
        return null;
    }
}

export function registerMedia(juris) {
    // One file, shown as what it is. `src` is /blob/<sha256> or /file/…; `type`, `name` and `size` when the
    // server said (a screen's block), else asked of the store. `height`: a PDF's or a video's, in pixels.
    // `steps`: [{ n, at, time, label, needs }] (media-steps.js), a guide's steps; `pauseAtSteps`: a video stops at
    // each step's end. `live`: where the screen keeps the block's data, whose `done` says which steps are done
    // (live: a step marked by the equipment shows at once) and how this page marks one; `arg`: the screen's.
    juris.registerComponent("MediaView", ({ src, type = null, name = null, size = null, height = 480, compact = false, steps = [], pauseAtSteps = true, live = null, arg = null }, api) => {
        const [meta, setMeta] = api.useState("meta", type ? { type, name, size } : null);
        // Asked of the store in the browser only (the server draws "Loading…" and the page asks once booted).
        if (!meta() && src && typeof window !== "undefined") aboutFile(src).then((m) => setMeta(m ?? { type: null, name, size }));
        return {
            div: {
                className: `media-view${compact ? " compact" : ""}`,
                children: () => {
                    const m = meta();
                    if (!src) return [{ span: { className: "muted small", textContent: "No file." } }];
                    if (!m) return [{ span: { className: "muted small", textContent: "Loading…" } }];
                    const kind = kindOf(m.type);
                    const label = m.name || (kind ? KIND_WORDS[kind].replace(/^an? /, "") : "file");
                    const open = { a: { className: "media-open small", href: kind === "pdf" ? `${src}?view=1` : src, target: "_blank", rel: "noopener", children: [icon(kind === "video" ? "play" : "file"), { span: ` ${label}${m.size ? ` · ${sizeWords(m.size)}` : ""}` }] } };
                    if (compact || !kind || kind === "spreadsheet") return [open];
                    if (kind === "picture") return [{ a: { href: src, target: "_blank", rel: "noopener", children: [{ img: { className: "media-picture", src, alt: m.name ?? "", loading: "lazy" } }] } }];
                    if (kind === "video") return [{ VideoSteps: { key: `vs-${src}`, src, steps, height, pauseAtSteps, live, arg } }, open];
                    return [{ PdfPages: { key: `pp-${src}`, src, steps, height, name: m.name, live, arg } }, open];
                },
            },
        };
    });

    // A file field on a form: the file shown small, and uploaded, replaced or taken off by whoever may
    // write the field. A file saved already is read through its record (`record`: { object, id }).
    juris.registerComponent("FileField", ({ id, f, name, field, record = null, disabled, onPick }, api) => {
        const [busy, setBusy] = api.useState("busy", false);
        const [error, setError] = api.useState("error", null);
        const [preview, setPreview] = api.useState("preview", false);
        const off = () => (typeof disabled === "function" ? disabled() : Boolean(disabled));
        const stored = () => api.getState(`${f}.data.${name}`, null);
        // The file as saved is read through its record; one uploaded since, by its name until it is saved.
        const src = () => (stored() && record?.id && stored() === record.value ? recordFileUrl(record.object, record.id, name) : blobUrl(stored()));
        const choose = async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            api.batch(() => { setBusy(true); setError(null); });
            try { onPick((await uploadFile(file, field?.accept)).blob); } catch (err) { setError(err.message); } finally { setBusy(false); }
        };
        return {
            div: {
                className: "file-field",
                children: [
                    () => (stored() ? { MediaView: { key: `mv-${stored()}-${preview() ? 1 : 0}`, src: src(), compact: !preview(), height: 420 } } : { span: { className: "muted small", textContent: "No file." } }),
                    { span: { className: "image-field-buttons", children: () => [
                        stored() ? { button: { type: "button", className: "btn ghost", textContent: preview() ? "Hide" : "Show here", onclick: () => setPreview(!preview()) } } : null,
                        off() ? null : { label: { className: "btn", children: [{ span: busy() ? "Uploading…" : stored() ? "Replace…" : "Upload…" }, { input: { id, type: "file", accept: acceptAttr(field?.accept), className: "visually-hidden", disabled: busy(), onchange: choose } }] } },
                        off() || !stored() ? null : { button: { type: "button", className: "btn ghost", textContent: "Remove", onclick: () => onPick(null) } },
                    ].filter(Boolean) } },
                    { span: { className: "muted small", textContent: off() ? "" : `Takes ${acceptWords(field?.accept)}.` } },
                    { span: { className: "error small", role: "alert", textContent: () => error() ?? "" } },
                ],
            },
        };
    });

    // A PDF, a page at a time, drawn by pdf.js to fit its box, with big Previous and Next for the people at the
    // screen: by step when the guide has steps (each on its page), page by page otherwise. The arrow keys move
    // too. Without pdf.js (an old browser, a PDF it cannot read), the browser's own viewer.
    juris.registerComponent("PdfPages", ({ src, steps = [], height = 480, name = null, live = null, arg = null }, api) => {
        const id = `pdf-${Math.random().toString(36).slice(2, 10)}`;
        const marks = pageSteps(steps);
        // A guide following a route opens where the traveler is.
        const here = live ? marks.findIndex((x) => x.n === api.peek(`${live}.route.current`)) : -1;
        const [pages, setPages] = api.useState("pages", null);
        const [failed, setFailed] = api.useState("failed", false);
        // With steps it goes a step at a time (two on one page are two steps); without, a page at a time.
        const [k, setK] = api.useState("step", Math.max(0, here));
        const [loose, setLoose] = api.useState("page", 1);
        const shown = () => marks.filter((x) => !pages() || x.page <= pages());
        const page = () => (marks.length ? shown()[Math.min(k(), shown().length - 1)]?.page ?? 1 : loose());
        const at = () => (marks.length ? Math.min(k(), shown().length - 1) : loose() - 1);
        const count = () => (marks.length ? shown().length : pages() ?? 1);
        const go = (i) => {
            if (i < 0 || i >= count() || i === at()) return;
            const before = page();
            if (marks.length) setK(i); else setLoose(i + 1);
            if (page() !== before) document.getElementById(id)?.__draw?.(page());
        };
        const prev = () => go(at() - 1);
        const next = () => go(at() + 1);
        if (!api.isServer) {
            api.onMount(() => {
                const box = document.getElementById(id);
                const canvas = box?.querySelector("canvas");
                if (!canvas) return undefined;
                let doc = null, task = null, gone = false;
                const draw = async (n) => {
                    if (!doc || gone) return;
                    const p = await doc.getPage(Math.min(Math.max(1, n), doc.numPages));
                    const one = p.getViewport({ scale: 1 });
                    const fit = Math.min((box.clientWidth || one.width) / one.width, height / one.height);
                    const ratio = globalThis.devicePixelRatio || 1;
                    const view = p.getViewport({ scale: fit * ratio });
                    task?.cancel();
                    canvas.width = Math.floor(view.width);
                    canvas.height = Math.floor(view.height);
                    canvas.style.width = `${Math.floor(view.width / ratio)}px`;
                    canvas.style.height = `${Math.floor(view.height / ratio)}px`;
                    task = p.render({ canvasContext: canvas.getContext("2d"), viewport: view });
                    await task.promise.catch(() => {});
                };
                box.__draw = draw;
                loadPdf()
                    .then((lib) => lib.getDocument({ url: src, isEvalSupported: false }).promise)
                    .then((d) => { if (gone) return; doc = d; setPages(d.numPages); draw(page()); })
                    .catch(() => setFailed(true));
                const sized = typeof ResizeObserver === "function" ? new ResizeObserver(() => draw(page())) : null;
                sized?.observe(box);
                return () => { gone = true; sized?.disconnect(); task?.cancel(); doc?.destroy?.(); delete box.__draw; };
            });
        }
        const keys = (e) => { if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); next(); } if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); prev(); } };
        return {
            div: {
                className: "pdf-pages",
                children: () => (failed()
                    ? [{ iframe: { className: "media-pdf", src: `${src}?view=1`, title: name ?? "PDF", style: { height: `${height}px` } } }]
                    : [
                        { div: { id, className: "pdf-page", tabIndex: 0, role: "img", "aria-label": `${name ?? "PDF"}, page ${page()}${pages() ? ` of ${pages()}` : ""}`, onkeydown: keys, style: { minHeight: `${Math.min(height, 240)}px` }, children: [{ canvas: { className: "pdf-canvas" } }] } },
                        stepBar({
                            where: marks.length ? `Step ${at() + 1} of ${count()}: ${shown()[at()]?.label ?? ""}` : `Page ${page()}${pages() ? ` of ${pages()}` : ""}`,
                            sub: marks.length ? `page ${page()}${pages() ? ` of ${pages()}` : ""}` : null,
                            prev: { label: marks.length ? "Previous step" : "Previous page", onclick: prev, disabled: at() <= 0 },
                            next: { label: marks.length ? "Next step" : "Next page", onclick: next, disabled: at() >= count() - 1 || gated(api, live, shown()[at()]) },
                            list: marks.length > 1 ? shown().map((x, i) => ({ label: `${i + 1}. ${x.label}`, on: i === at(), done: isDone(api, live, x), here: isHere(api, live, x), onclick: () => go(i) })) : [],
                            done: marks.length ? doneArea(live, shown()[at()], arg, next) : null,
                        }),
                    ]),
            },
        };
    });

    // A video with its guide's steps: Previous step, Play this step (it stops where the next begins, when the
    // block says so: the operator does the step, then goes on) and Next step, the steps listed to jump to.
    juris.registerComponent("VideoSteps", ({ src, steps = [], height = 480, pauseAtSteps = true, live = null, arg = null }, api) => {
        const id = `vid-${Math.random().toString(36).slice(2, 10)}`;
        const marks = timeSteps(steps);
        const here = live ? marks.findIndex((x) => x.n === api.peek(`${live}.route.current`)) : -1;
        const [at, setAt] = api.useState("at", marks.length ? Math.max(0, here) : -1);
        const video = () => document.getElementById(id);
        let stopAt = null;
        const play = (k) => {
            const v = video();
            if (!v || !marks[k]) return;
            v.currentTime = marks[k].start;
            // Steps that start at one moment share its clip: it stops where the next moment begins.
            const after = marks.find((x) => x.start > marks[k].start);
            stopAt = pauseAtSteps && after ? after.start : null;
            setAt(k);
            v.play()?.catch?.(() => {});
        };
        if (!api.isServer && marks.length) {
            api.onMount(() => {
                const v = video();
                if (!v) return undefined;
                const tick = () => {
                    // At the step's end: stopped just before the next begins, so it still reads as this step.
                    if (stopAt !== null && v.currentTime >= stopAt - 0.05) { v.pause(); v.currentTime = Math.max(0, stopAt - 0.15); stopAt = null; }
                    const k = stepAt(marks.map((x) => x.start), v.currentTime);
                    // Still within the moment of the step in view (two steps starting there): it stays.
                    if (k !== at() && !(k >= 0 && marks[at()]?.start === marks[k].start)) setAt(k);
                };
                v.addEventListener("timeupdate", tick);
                v.addEventListener("seeking", () => { if (stopAt !== null && v.currentTime < (marks[at()]?.start ?? 0) - 0.5) stopAt = null; });
                return () => v.removeEventListener("timeupdate", tick);
            });
        }
        return {
            div: {
                className: "video-steps",
                children: [
                    { video: { id, className: "media-video", src, controls: true, preload: "metadata", playsInline: true, style: { maxHeight: `${height}px` } } },
                    () => (marks.length ? stepBar({
                        where: at() >= 0 ? `Step ${at() + 1} of ${marks.length}: ${marks[at()].label}` : "Before the first step",
                        sub: at() >= 0 ? `from ${timeWords(marks[at()].start)}` : null,
                        prev: { label: "Previous step", onclick: () => play(Math.max(0, at() - 1)), disabled: at() <= 0 },
                        play: { label: "Play this step", onclick: () => play(Math.max(0, at())) },
                        next: { label: "Next step", onclick: () => play(at() + 1), disabled: at() >= marks.length - 1 || gated(api, live, marks[at()]) },
                        list: marks.map((x, i) => ({ label: `${i + 1}. ${x.label}`, on: i === at(), done: isDone(api, live, x), here: isHere(api, live, x), onclick: () => play(i) })),
                        done: doneArea(live, marks[at()], arg, () => play(at() + 1)),
                    }) : { span: {} }),
                ],
            },
        };
    });
}

// Which steps are done (§35.4), from the block's live data: by its log's records, or a route that has gone on.
const doneOf = (api, live) => (live ? api.getState(`${live}.done`, null) : null);
const isDone = (api, live, step) => Boolean(step && doneOf(api, live)?.list?.[step.n]);
const isHere = (api, live, step) => Boolean(step && live && api.getState(`${live}.route.current`, null) === step.n);
// Next waits for the step in view to be done, where the block says so (`gate`).
const gated = (api, live, step) => Boolean(step && doneOf(api, live)?.gate && !isDone(api, live, step));
const doneArea = (live, step, arg, next) => (live && step ? { StepDone: { key: `sd-${step.n}`, live, step, arg, next } } : null);
const VERBS = { click: "Mark done", value: "Done", photo: "Take a photo", file: "Upload a file" };

// The controls under a guide: where it is, big Previous / (Play) / Next, and its steps to jump to.
function stepBar({ where, sub, prev, next, play = null, list = [], done = null }) {
    return {
        div: {
            className: "step-bar",
            children: [
                { div: { className: "step-where", children: [{ strong: where }, sub ? { span: { className: "muted small", textContent: ` · ${sub}` } } : null].filter(Boolean) } },
                done,
                { div: { className: "step-buttons", children: [
                    { button: { type: "button", className: "btn step-btn", disabled: prev.disabled, onclick: prev.onclick, textContent: `‹ ${prev.label}` } },
                    play ? { button: { type: "button", className: "btn primary step-btn", onclick: play.onclick, children: [icon("play"), { span: ` ${play.label}` }] } } : null,
                    { button: { type: "button", className: "btn primary step-btn", disabled: next.disabled, onclick: next.onclick, textContent: `${next.label} ›` } },
                ].filter(Boolean) } },
                list.length ? { div: { className: "step-list", children: list.map((x, i) => ({ button: { key: `st-${i}`, type: "button", className: `step-chip${x.on ? " on" : ""}${x.done ? " done" : ""}${x.here ? " here" : ""}`, "aria-current": x.on ? "step" : undefined, title: x.done ? "Done" : x.here ? "Where it is now" : undefined, onclick: x.onclick, children: [x.done ? icon("check") : x.here ? icon("play") : null, { span: x.label }].filter(Boolean) } })) } } : null,
            ].filter(Boolean),
        },
    };
}

// The step in view, done or to do (§35.4): who did it and when; else how it is done here, through the block's
// transaction (a click, a value, a photo from the camera, a file), or what it waits for: the equipment, another
// transaction or screen, the route going on. Every mark is the transaction's run: its callers, its checks, its
// signature, the audit trail; nothing is written around it.
export function registerStepDone(juris) {
    juris.registerComponent("StepDone", ({ live, step, arg = null, next = null }, api) => {
        const [busy, setBusy] = api.useState("busy", false);
        const [error, setError] = api.useState("error", null);
        const [value, setValue] = api.useState("value", "");
        // A second person's verification (§7.4): both re-enter their passwords, or sign on again (none where
        // anyone is anyone: a development or demo instance), as on the transaction's form.
        const [pw1, setPw1] = api.useState("pw1", "");
        const [pw2, setPw2] = api.useState("pw2", "");
        const [sso, setSso] = api.useState("sso", {});
        const mark = async (extra = {}) => {
            const d = api.peek(`${live}.done`);
            if (!d?.transaction || busy()) return;
            setError(null);
            let signature;
            if (d.verifier) {
                if (!api.peek("me.second")) { api.setValue("ui.second.open", true); setError("A second person verifies this step: they sign in beside you first."); return; }
                const proof = (n, pw) => (sso()[n] ? { [n === 1 ? "sso" : "secondSso"]: true } : { [n === 1 ? "password" : "secondPassword"]: pw });
                signature = { meaning: d.meaning, agree: true, ...proof(1, pw1()), ...proof(2, pw2()) };
            } else if (d.signed) {
                const proof = await signDialog(api, { title: `${d.label}: step ${step.n}`, message: `"${step.label}" done. Signed: ${d.meaning}.`, confirm: "Sign" });
                if (proof === null) return;
                signature = { meaning: d.meaning, agree: true, ...proof };
            }
            setBusy(true);
            try {
                const key = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
                await api.call("transactions.run", { name: d.transaction, input: { ...d.fills, [d.step]: step.n, ...extra }, key, ...(signature ? { signature } : {}) });
                api.batch(() => { setValue(""); setPw1(""); setPw2(""); setSso({}); });
                next?.();
            } catch (e) {
                const fields = e?.fields && typeof e.fields === "object" ? Object.values(e.fields).filter((v) => typeof v === "string" && v !== "Required.") : [];
                setError([e?.message ?? "It could not be marked done.", ...fields].join(" "));
            } finally {
                setBusy(false);
            }
        };
        const upload = async (file, accept) => {
            if (!file) return;
            setBusy(true);
            setError(null);
            let blob;
            try { blob = (await uploadFile(file, accept)).blob; } catch (e) { setError(e.message); setBusy(false); return; }
            setBusy(false);
            await mark({ [intoOfStep(step, api.peek(`${live}.done`))]: blob });
        };
        const undo = async (d, had) => {
            if (!(await confirmDialog(api, { title: `Undo step ${step.n}?`, message: `"${step.label}" will show as not done. Its record is archived, not deleted: the audit trail keeps who did it and who undid it.`, confirm: "Undo" }))) return;
            setBusy(true);
            setError(null);
            try {
                await api.call("records.archive", { object: d.log, id: had.id, rowVersion: had.rowVersion, key: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}` });
            } catch (e) {
                setError(e?.message ?? "It could not be undone.");
            } finally {
                setBusy(false);
            }
        };
        // Who verifies: the second person signed in beside the operator, and both their proofs.
        const verifyArea = (d) => {
            const second = api.getState("me.second", null);
            if (!second) return { div: { className: "step-done-row", children: [
                { p: { className: "small icon-text", children: [icon("users"), { span: `A second person verifies this ("${d.verifier}"): they sign in beside you first.` }] } },
                { button: { type: "button", className: "btn", textContent: "Add a second person", onclick: (e) => { e.stopPropagation(); api.setValue("ui.second.open", true); setTimeout(() => document.querySelector(".second-panel input")?.focus(), 0); } } },
            ] } };
            const noPasswords = api.getState("picker", false);
            const proof = (n, label, get, set, who) => (sso()[n]
                ? { p: { className: "small icon-text", children: [icon("check"), { span: `${who === "second" ? "They" : "You"} signed in again with single sign-on.` }] } }
                : { div: { className: "step-done-row", children: [
                    { label: { className: "small", children: [{ span: `${label} ` }, { input: { type: "password", autocomplete: "off", "aria-label": label, value: get(), oninput: (e) => set(e.target.value) } }] } },
                    api.getState("signing.sso", false) ? { button: { type: "button", className: "btn small", textContent: "Sign in again with single sign-on", onclick: async () => { if (await freshSignOn(who)) setSso({ ...sso(), [n]: true }); } } } : null,
                ].filter(Boolean) } });
            return { div: { className: "step-done-verify", children: [
                { p: { className: "small", textContent: `Signed by ${api.peek("me.name") ?? "you"} and verified by ${second.name}: "${d.verifier}".` } },
                ...(noPasswords ? [{ p: { className: "muted small", textContent: "No passwords on a development or demo instance: who signs is checked all the same." } }] : [proof(1, "Your password", pw1, setPw1, "me"), proof(2, `${second.name}'s password`, pw2, setPw2, "second")]),
            ] } };
        };
        return {
            div: {
                className: "step-done",
                children: () => {
                    const d = api.getState(`${live}.done`, null);
                    const route = api.getState(`${live}.route`, null);
                    if (!d) return [];
                    const had = d.list?.[step.n];
                    if (had) return [{ div: { className: "step-done-row", children: [
                        { p: { className: "step-done-yes icon-text", children: [icon("check"), { span: `Done by ${had.name ?? "someone"}, ${plant().dateTime(had.at)}` }] } },
                        // Undone: its record archived, as its policies allow; the audit trail keeps both.
                        had.undo && d.log ? { button: { type: "button", className: "btn ghost small", disabled: busy(), onclick: () => undo(d, had), children: [icon("undo"), { span: " Undo" }] } } : null,
                    ].filter(Boolean) } }, ...(error() ? [{ p: { className: "error small", role: "alert", textContent: error() } }] : [])];
                    const out = [];
                    const atScreen = !d.route && !d.off && !d.problems?.[step.n] && ["click", "value", "photo", "file"].includes(step.needs ?? "click");
                    if (atScreen && d.verifier) out.push(verifyArea(d));
                    const say = (words, cls = "muted") => out.push({ p: { className: `step-done-wait ${cls}`, textContent: words } });
                    if (d.off) say("Open it with a record to mark its steps done.");
                    else if (d.problems?.[step.n]) say(`This step cannot be marked done here: ${d.problems[step.n]}`, "error");
                    else if (d.route) {
                        if (route?.current === step.n) say(`${route.label}: here now. It goes on when ${(step.leaves ?? []).join(" or ") || "the step is moved"} is done.`);
                        else say(route?.current ? `${route.label}: not yet; it is at ${route.nodeLabel ?? "another step"}.` : route?.state ? `${route.label}: it is not on this route now.` : `${route?.label ?? "The route"}: not started.`);
                    } else if (step.needs === "device") say("Done by the equipment: waiting for it to say so.");
                    else if (step.needs === "wait") say("Done elsewhere: waiting for it to be recorded.");
                    else if (step.needs === "screen") out.push({ p: { className: "step-done-wait", children: [{ span: { className: "muted", textContent: "Done on another screen: " } }, { a: { href: arg ? `/s/${step.into}/${encodeURIComponent(arg)}` : `/s/${step.into}`, textContent: "open it" } }] } });
                    else if (step.needs === "value") {
                        const spec = d.into?.[step.into] ?? { type: "string", label: step.into };
                        out.push({ div: { className: "step-done-row", children: [
                            { label: { className: "small", htmlFor: `sv-${live}-${step.n}`, textContent: `${spec.label}${spec.unit ? ` (${spec.unit})` : ""}` } },
                            valueControl(`sv-${live}-${step.n}`, spec, value(), setValue, () => mark({ [step.into]: typed(spec, value()) })),
                            { button: { type: "button", className: "btn primary", disabled: busy() || value() === "", onclick: () => mark({ [step.into]: typed(spec, value()) }), children: [icon("check"), { span: ` ${VERBS.value}` }] } },
                        ] } });
                    } else if (step.needs === "photo" || step.needs === "file") {
                        const photo = step.needs === "photo";
                        const accept = photo ? ["picture"] : d.into?.[intoOfStep(step, d)]?.type === "image" ? ["picture"] : DEFAULT_ACCEPT;
                        out.push({ label: { className: `btn primary${busy() ? " disabled" : ""}`, children: [icon(photo ? "camera" : "upload"), { span: ` ${busy() ? "Uploading…" : VERBS[step.needs]}` },
                            { input: { type: "file", className: "visually-hidden", accept: photo ? "image/*" : acceptAttr(accept), ...(photo ? { capture: "environment" } : {}), disabled: busy(), onchange: (e) => { const f = e.target.files?.[0]; e.target.value = ""; upload(f, accept); } } }] } });
                    } else out.push({ button: { type: "button", className: "btn primary", disabled: busy(), onclick: () => mark(), children: [icon("check"), { span: ` ${busy() ? "Marking…" : VERBS.click}` }] } });
                    if (error()) out.push({ p: { className: "error small", role: "alert", textContent: error() } });
                    return out;
                },
            },
        };
    });
}
const intoOfStep = (step, d) => (step.needs === "value" ? step.into : step.into ?? d?.evidence);
// A value as its input takes it: a number for a number, yes or no for a yes-or-no.
const typed = (spec, v) => (["integer", "decimal"].includes(spec.type) ? Number(v) : spec.type === "boolean" ? v === "true" : v);
function valueControl(id, spec, v, set, submit) {
    const enter = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
    const options = Array.isArray(spec.values) ? spec.values.map((o) => ({ value: String(o), label: String(o) })) : null;
    if (spec.type === "boolean") return { select: { id, onchange: (e) => set(e.target.value), children: [{ option: { value: "", textContent: "—" } }, { option: { value: "true", selected: v === "true", textContent: "Yes" } }, { option: { value: "false", selected: v === "false", textContent: "No" } }] } };
    if (options) return { select: { id, onchange: (e) => set(e.target.value), children: [{ option: { value: "", textContent: "—" } }, ...options.map((o) => ({ option: { value: o.value, selected: v === o.value, textContent: o.label } }))] } };
    const number = ["integer", "decimal"].includes(spec.type);
    return { input: { id, type: number ? "number" : spec.type === "date" ? "date" : "text", ...(number ? { step: spec.type === "integer" ? "1" : "any", inputMode: "decimal" } : {}), autocomplete: "off", value: v, oninput: (e) => set(e.target.value), onkeydown: enter } };
}
