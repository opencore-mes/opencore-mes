// A plan's page (DESIGN.md §32.7), `/f/<run>`: one run of a plan (an OCAP), what set it off and the
// route it was on there, where it is now and its way there, its values and files. Where it waits for
// the person looking, they act on it here: a wait's time remaining and its Acknowledge or Retry, a
// manual decision's choices, an input screen's fields (list choices, typed values, files, images,
// links). **Show the flow** draws the plan as designed with its way on it (flow-picture.js). And, on a
// record's page, the plans it took part in.
import { icon } from "./icons.js";
import { noDefault } from "./select.js";
import { INLINE_FILE } from "./input-flow.js";
import { flowRunMap, useRunMap } from "./flow-picture.js";
import { plant } from "./format.js";
import { stateBadgeClass } from "./theme.js";
import { titleTab } from "./shell.js";
import { keyFlow, focusFirst, controlsOf } from "./keyboard.js";

const words = (s) => String(s ?? "").replace(/_/g, " ");
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// Seconds as the time remaining reads: 1:05:09, 4:07, 0:09.
function remaining(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
// A file chosen in the browser, as the service takes it: { name, type, data (base64) }.
const readFile = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type || "application/octet-stream", data: String(reader.result).split(",")[1] ?? "" });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
});
// A collected file, opened from the run.
async function openFile(api, id) {
    const f = await api.call("flows.file", { id });
    const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
    // Opened beside the page only as a picture, a PDF or plain text; anything else is saved, never
    // run: a blob has this site's origin, and an HTML file would act as whoever opened it.
    if (INLINE_FILE.test(f.type)) { window.open(URL.createObjectURL(new Blob([bytes], { type: f.type })), "_blank", "noopener"); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    a.download = f.name || "file";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// A picked picture as a data: address for its preview (the renderer takes no blob: address).
const previewOf = (file) => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
});
const STATE_TONE = { running: "info", stopped: "danger", ended: "ok" };
// A plan's own state in words that cannot be read as its record's: a repair "running" beside a tool that
// is down would say the tool runs.
const RUN_WORDS = { running: "in progress", stopped: "stopped", ended: "ended" };

export function registerFlowTask(juris, { args }) {
    // `embedded`: only the step it waits at (its form, choices or wait), inside another page (a screen's plan block,
    // §26.10); `onDone()`: told once the person's act is taken.
    juris.registerComponent("FlowTask", ({ run, embedded = false, onDone = null }, api) => {
        const as = api.getState("me.id", null, { track: false });
        const P = `flowtask.${run}`;
        const F = `flowform.${run}`;
        api.live(P, "flows.task", args.flowTask(run, as));
        // A clock for a wait's time remaining.
        const [now, setNow] = api.useState("now", Date.now());
        if (!api.isServer) {
            api.onMount(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); });
            // Without a mouse (§25.6): its form taken as a transaction's (Enter to the next field, on the last Send;
            // Esc back), the cursor in its first field once the step is drawn; a choice's first button; a wait's
            // Acknowledge. A technician at a bench works the step from the keyboard.
            const doc = globalThis.document;
            const stopKeys = keyFlow(() => doc.querySelector(".task-form"), { primary: () => doc.querySelector(".task-form .view-actions .btn.primary") });
            const stopFocus = api.bindState(() => { const t = api.getState(P, null); return t ? `${t.state}:${t.nodeLabel ?? ""}:${t.mayAct}` : ""; }, (at) => {
                if (!at) return;
                setTimeout(() => {
                    const form = doc.querySelector(".task-form");
                    // A fresh step: its first field (a box to tick among them); one coming back with an error: that one.
                    if (form) { if (!form.contains(doc.activeElement)) { const first = controlsOf(form)[0]; if (first) first.focus(); else focusFirst(form); } return; }
                    const button = doc.querySelector(".task-choices .btn, .task-card .view-actions .btn.primary");
                    if (button && (!doc.activeElement || doc.activeElement === doc.body)) button.focus();
                }, 80);
            });
            api.onCleanup(() => { stopKeys(); stopFocus(); });
        }
        // Its map: the template with its way on it, when the person opens it.
        const map = useRunMap(api, "plan");
        // The files chosen, kept here (state holds plain data: only their names go there).
        const chosen = new Map();
        const act = async (payload) => {
            api.batch(() => { api.setValue(`${F}.busy`, true); api.setValue(`${F}.error`, null); api.setValue(`${F}.fields`, {}); });
            try {
                const values = { ...(api.peek(`${F}.values`) ?? {}) };
                for (const [k, file] of chosen) values[k] = await readFile(file);
                await api.call("flows.act", { run, ...payload, ...(payload.values ? { values } : {}) });
                chosen.clear();
                api.batch(() => { api.setValue(`${F}.values`, {}); api.setValue(`${F}.picked`, {}); });
                onDone?.(api.peek(P)?.nodeLabel ?? null);
            } catch (error) {
                api.batch(() => { api.setValue(`${F}.error`, error.message); api.setValue(`${F}.fields`, error.fields ?? {}); });
            } finally {
                api.setValue(`${F}.busy`, false);
            }
        };
        const busy = () => api.getState(`${F}.busy`, false);
        const fieldError = (k) => ({ div: { className: "field-error", textContent: () => api.getState(`${F}.fields.${k}`, "") ?? "" } });
        const control = (fld) => {
            const set = (v) => api.setValue(`${F}.values.${fld.name}`, v);
            const value = () => api.getState(`${F}.values.${fld.name}`, "") ?? "";
            switch (fld.type) {
                case "boolean": return { label: { className: "check-control checkbox", children: [{ input: { type: "checkbox", checked: () => value() === true, onchange: (e) => set(e.target.checked) } }, { span: " yes" }] } };
                case "enum": return { select: { onchange: (e) => set(e.target.value || null), children: noDefault([{ option: { value: "", textContent: "—" } }, ...fld.values.map((v) => ({ option: { value: v, textContent: words(v), selected: () => value() === v } }))]) } };
                // A list from a named query (§32.6): the options the server worked out for this person, as they may
                // read them; the one chosen is checked again when it is sent.
                case "query": {
                    const options = Array.isArray(fld.options) ? fld.options : [];
                    return { div: { className: "task-query", children: [
                        { select: { disabled: !options.length, onchange: (e) => { const o = options.find((x) => String(x.value) === e.target.value); set(o ? o.value : null); }, children: noDefault([
                            { option: { value: "", textContent: options.length ? "—" : "nothing to choose" } },
                            ...options.map((o) => ({ option: { key: String(o.value), value: String(o.value), textContent: o.label, selected: () => String(value()) === String(o.value) } })),
                        ]) } },
                        fld.problem ? { p: { className: "field-error", textContent: fld.problem } } : { span: {} },
                    ] } };
                }
                case "integer": case "decimal": return { input: { type: "number", step: fld.type === "decimal" ? "any" : 1, value, oninput: (e) => set(e.target.value === "" ? null : Number(e.target.value)) } };
                case "link": return { input: { type: "url", placeholder: "https://…", value, oninput: (e) => set(e.target.value) } };
                case "file": case "image": return { div: { className: "task-file", children: [
                    { input: { type: "file", accept: fld.type === "image" ? "image/png,image/jpeg,image/gif,image/webp" : undefined, ...(fld.type === "image" ? { capture: "environment" } : {}), onchange: (e) => {
                        const file = e.target.files?.[0] ?? null;
                        if (file) chosen.set(fld.name, file); else chosen.delete(fld.name);
                        api.setValue(`${F}.picked.${fld.name}`, file ? { name: file.name, url: null } : null);
                        if (file && fld.type === "image" && /^image\/(png|jpeg|gif|webp)$/.test(file.type)) previewOf(file).then((url) => { if (chosen.get(fld.name) === file) api.setValue(`${F}.picked.${fld.name}`, { name: file.name, url }); });
                    } } },
                    () => { const v = api.getState(`${F}.picked.${fld.name}`, null); return v?.url ? { img: { className: "task-preview", alt: v.name, src: v.url } } : { span: {} }; },
                ] } };
                default: return { input: { type: "text", value, oninput: (e) => set(e.target.value), onchange: (e) => { if (e.target.value !== e.target.value.trim()) set(e.target.value.trim()); } } };
            }
        };
        // What it waits for, and the person's part in it.
        const waitingCard = (t) => {
            const w = t.waiting;
            const forWhom = [...(w.for?.groups ?? []), ...(w.for?.users ?? [])].join(", ");
            const head = [{ h2: { className: "icon-text task-node", children: [icon({ wait: "hourglass", manual_decision: "personChoice", input_screen: "form", sub_flow: "subflow" }[w.kind] ?? "info"), { span: t.nodeLabel }] } }, t.message ? { p: { textContent: t.message } } : { span: {} }];
            const notYours = !t.mayAct && w.kind !== "sub_flow" && !(w.kind === "wait" && w.mode === "auto") ? { p: { className: "muted small", textContent: `Waiting for ${forWhom || "someone"}.` } } : { span: {} };
            const error = { p: { className: "error", textContent: () => api.getState(`${F}.error`, "") ?? "" } };
            if (w.kind === "wait") {
                const due = t.dueAt ? new Date(t.dueAt).getTime() : null;
                return { section: { className: "panel task-card", children: [...head,
                    { div: { className: "task-clock", children: [{ span: { className: "muted small", textContent: "Time remaining" } }, { strong: { className: "task-remaining", textContent: () => (due === null ? "—" : due - now() > 0 ? remaining(due - now()) : w.mode === "auto" ? "now" : "time is up") } }] } },
                    w.mode === "auto" ? { p: { className: "muted small", textContent: "It goes on by itself when the time is up." } } : { span: {} },
                    t.mayAct && w.mode !== "auto" ? { div: { className: "view-actions", children: [
                        { button: { type: "button", className: "btn primary", disabled: busy, textContent: "Acknowledge", onclick: () => act({ action: "acknowledge" }) } },
                        w.mode === "retry" ? { button: { type: "button", className: "btn", disabled: busy, children: [icon("refresh"), { span: "Retry" }], onclick: () => act({ action: "retry" }) } } : { span: {} },
                    ] } } : notYours, error,
                ] } };
            }
            if (w.kind === "manual_decision") {
                return { section: { className: "panel task-card", children: [...head,
                    t.mayAct ? { div: { className: "task-choices", children: t.choices.map((c) => ({ button: { key: c, type: "button", className: "btn", disabled: busy, textContent: c, onclick: () => act({ choice: c }) } })) } } : notYours, error,
                ] } };
            }
            if (w.kind === "input_screen") {
                return { section: { className: "panel task-card", children: [...head,
                    t.mayAct ? { div: { className: "form task-form", children: [
                        ...t.fields.map((fld) => ({ div: { key: fld.name, className: "field", "data-guide": `field:${fld.name}`, children: [{ label: { children: [{ span: `${fld.label}${fld.required ? " *" : ""}` }] } }, control(fld), fieldError(fld.name)] } })),
                        { div: { className: "view-actions", children: [{ button: { type: "button", className: "btn primary", disabled: busy, textContent: () => (busy() ? "Sending…" : "Send"), onclick: () => act({ values: true }) } }] } },
                    ] } } : notYours, error,
                ] } };
            }
            return { section: { className: "panel task-card", children: [...head, { p: { className: "muted", textContent: "Waiting for its sub flow to end." } }, ...t.children.filter((c) => c.state !== "ended").map((c) => ({ Link: { key: c.id, to: `/f/${c.id}`, className: "btn", children: [icon("subflow"), { span: c.label }] } }))] } };
        };
        const valueWords = (v) => (isPlain(v) && v.file ? `${v.name} (${Math.max(1, Math.round(v.size / 1024))} KB)` : isPlain(v) ? Object.entries(v).filter(([k]) => !k.endsWith("label") || k === "label").map(([, x]) => words(x)).join(" · ") : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));
        return {
            div: {
                className: embedded ? "task-embedded" : "view task-page",
                children: [() => {
                    const t = api.getState(P, null);
                    if (t === null) return { div: { children: [{ h1: "Not found" }, { p: { className: "muted", textContent: "This plan does not exist, or it is not shared with you." } }] } };
                    if (!t) return { p: { className: "muted", textContent: "Loading…" } };
                    const waits = t.state === "running" && t.waiting;
                    if (embedded) return waits ? waitingCard(t) : { p: { className: "muted small", textContent: `${t.label}: ${t.state === "ended" ? `ended${t.outcome ? ` (${t.outcome})` : ""}` : "on its way"}.` } };
                    if (!api.isServer) titleTab(api, `/f/${run}`, `${t.label}: ${t.nodeLabel}`);
                    return { div: { children: [
                        { div: { className: "record-head", children: [{ div: { className: "title", children: [
                            { GuideToggle: { key: `guide-task-${run}`, title: `${t.label}: this plan`, make: () => ({ intro: "A plan (an OCAP) set off by a record: it goes from step to step, waiting where a person decides, fills something in, or acknowledges a wait.", sections: [{ title: "This page", items: [
                                { label: "What set it off", words: "The record it is about, and the route that record was on, at its step.", highlight: ".task-origin" },
                                { label: "Now", words: "Where it waits, and for whom. When it is for you, you act here: a button per choice, a form to fill in (lists, numbers, files, photos, links), or a wait's Acknowledge and Retry.", highlight: ".task-card" },
                                { label: "Its way", words: "Every step it went through, who moved it on, and when.", highlight: ".task-way" },
                                { label: "What it holds", words: "The values it collected, and its files and photos: open them from here.", highlight: ".task-values" },
                                { label: "Show the flow", words: "The plan as it was designed, with its way on it: the steps it went through filled in, the wires it took marked (×2: twice), where it is now outlined, the rest faded. Point at a step for when it was there and who moved it on.", highlight: ".flow-map-toggle, .flow-run-map" },
                            ] }] }) } },
                            { span: { className: "kind", textContent: "Plan" } }, { h1: t.label },
                            { span: { className: stateBadgeClass(t.state, STATE_TONE), textContent: t.state === "ended" ? `ended: ${t.outcome ?? ""}` : RUN_WORDS[t.state] ?? t.state } },
                        ] } }] } },
                        t.description ? { p: { className: "muted", textContent: t.description } } : { span: {} },
                        { div: { className: "task-origin small", children: [
                            t.subject ? { span: { className: "icon-text", children: [{ span: { key: "w", textContent: "Set off by " } }, { Link: { key: "l", to: `/o/${t.subject.object}/${t.subject.id}`, textContent: t.subject.title } }, ...(t.subject.state ? [{ span: { key: "s", className: stateBadgeClass(t.subject.state, { [t.subject.state]: t.subject.tone }), title: `${t.subject.title} is ${t.subject.state.replace(/_/g, " ")} now`, textContent: t.subject.state.replace(/_/g, " ") } }] : [])] } } : { span: {} },
                            isPlain(t.context.route) ? { span: { textContent: ` · on ${t.context.route.label}, at ${t.context.route.step_label}` } } : { span: {} },
                            t.parent ? { span: { children: [{ span: " · a sub flow of " }, { Link: { to: `/f/${t.parent.id}`, textContent: t.parent.label } }] } } : { span: {} },
                            { span: { className: "muted", textContent: ` · started ${plant().dateTime(t.startedAt)}` } },
                            t.map ? { button: { type: "button", className: "btn ghost small flow-map-toggle", "aria-expanded": () => String(map.open()), onclick: map.toggle, children: [icon("branch"), { span: { textContent: () => (map.open() ? "Hide the flow" : "Show the flow") } }] } } : { span: {} },
                        ] } },
                        t.state === "stopped" ? { p: { className: "error", textContent: `Stopped at ${t.nodeLabel}: ${t.reason}` } } : { span: {} },
                        t.state === "ended" ? { p: { className: "ok-text icon-text", children: [icon("check"), { span: `Ended at ${t.nodeLabel}${t.outcome ? `: ${t.outcome}` : ""}, ${plant().dateTime(t.endedAt)}.` }] } } : { span: {} },
                        waits ? waitingCard(t) : { span: {} },
                        () => (map.open() && t.map ? { section: { className: "panel task-map", children: [flowRunMap({ map: t.map, steps: t.steps, node: t.node, state: t.state, key: `run-${run}`, api })] } } : { span: {} }),
                        { div: { className: "task-columns", children: [
                            { section: { className: "panel task-way", children: [{ h3: "Its way" }, { ol: { children: t.steps.map((st) => ({ li: { key: st.seq, children: [{ strong: st.label }, { span: { className: "muted small", textContent: ` · ${st.via ?? ""} · ${String(st.by ?? "").replace(/^flow:/, "the plan ")} · ${plant().dateTime(st.at)}` } }] } })) } }] } },
                            { section: { className: "panel task-values", children: [
                                { h3: "What it holds" },
                                Object.keys(t.context).length ? { dl: { children: Object.entries(t.context).flatMap(([k, v]) => [{ dt: { key: `k-${k}`, textContent: words(k) } }, { dd: { key: `v-${k}`, children: [isPlain(v) && v.file ? { button: { type: "button", className: "linkish", textContent: valueWords(v), onclick: () => openFile(api, v.file) } } : { span: { textContent: valueWords(v) } }] } }]) } } : { p: { className: "muted small", textContent: "Nothing yet." } },
                                t.children.length ? { div: { className: "small", children: [{ strong: "Sub flows: " }, ...t.children.map((c) => ({ Link: { key: c.id, to: `/f/${c.id}`, textContent: `${c.label} (${c.state}) ` } }))] } } : { span: {} },
                            ] } },
                        ] } },
                    ] } };
                }],
            },
        };
    });

    // On a record's page: the plans it set off or took part in, each a link to its page.
    juris.registerComponent("RecordPlans", ({ object, id }, api) => {
        const as = api.getState("me.id", null, { track: false });
        const P = `recplans.${object}.${id}`;
        api.live(P, "flows.plansOf", args.record(object, id, as));
        return { div: { className: () => `record-plans${(api.getState(P, []) ?? []).length ? "" : " none"}`, children: () => (api.getState(P, []) ?? []).map((p) => ({ Link: { key: p.id, to: `/f/${p.id}`, className: `record-plan state-${p.state}`, children: [
            icon("branch"), { strong: p.label },
            { span: { className: "muted small", textContent: p.state === "ended" ? ` · ended: ${p.outcome ?? ""}` : p.state === "stopped" ? " · stopped" : ` · at ${p.nodeLabel}${p.waitingFor.length ? `, for ${p.waitingFor.join(", ")}` : ""}` } },
        ] } })) } };
    });
}
