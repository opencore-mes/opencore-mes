// Designing a floor layout (DESIGN.md §35), in the screen editor's block card: which field is the
// status, the legend's colours, the floor's picture, where each record's own picture is, and the floor
// itself, arranged by hand: records found by typing and put on it, dragged to where they stand, the
// small square dragged to where it sits on each.
import { statusFields, statusValues, pictureFields, colourOf, FLOOR_COLOURS, FLOOR_COLOUR_WORDS, MAX_PLACES, DEFAULT_PLACE } from "./floor.js";
import { noDefault } from "./select.js";
import { floorItem, floorLegend } from "./floor-view.js";
import { uploadPicture, pictureUrl, PICTURE_TYPES } from "./picture.js";
import { W, labelled } from "./editor-kit.js";
import { icon } from "./icons.js";

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const round = (v) => Math.round(v * 10000) / 10000;
const select = (ctx, value, options, onchange) => ({ select: { disabled: ctx.ro, onchange: (e) => onchange(e.target.value), children: noDefault(options.map(([v, l]) => ({ option: { value: v, selected: value === v, textContent: l } }))) } });

// The block's settings above the floor: status, legend, the records' picture.
export function floorConfig(ctx, b, i, known) {
    const { ops } = ctx;
    const def = known.objects[b.object] ?? {};
    const status = b.status ?? "state";
    const values = statusValues(def, status);
    const pictures = pictureFields(def, known.objects);
    const labelOf = (f) => (f === "state" ? "its state" : def.fields?.[f]?.label ?? f);
    return [
        { div: { className: "ed-row", children: [
            labelled("Status", select(ctx, status, statusFields(def).map((f) => [f, labelOf(f)]), (v) => ops.edit((bb) => { bb.blocks[i].status = v; bb.blocks[i].colours = {}; })), "The field the small square shows: the record's state, or a field of it. It follows the record as it changes."),
            labelled("Each record's picture", select(ctx, b.picture ?? "", [["", "none: a plain tile with its name"], ...pictures.map((p) => [p.path, p.label])], (v) => ops.edit((bb) => { if (v) bb.blocks[i].picture = v; else delete bb.blocks[i].picture; })), pictures.length ? "An image field of the record, or of what it refers to (its model: one picture for every tool of the model)." : "No image field yet: give the object, or the object its model refers to, a field of type image."),
        ] } },
        labelled("Legend", { div: { className: "floor-colours", children: values.length ? values.map((v) => ({ label: { key: v, className: "floor-colour", children: [
            { span: { className: `floor-dot fc-${colourOf(b.colours, def.tones, v)}` } },
            { span: String(v).replace(/_/g, " ") },
            select(ctx, b.colours?.[v] ?? "", [["", def.tones?.[v] ? `as its tone (${def.tones[v]})` : "grey"], ...FLOOR_COLOURS.map((c) => [c, FLOOR_COLOUR_WORDS[c]])], (c) => ops.edit((bb) => { bb.blocks[i].colours = { ...(bb.blocks[i].colours ?? {}) }; if (c) bb.blocks[i].colours[v] = c; else delete bb.blocks[i].colours[v]; })),
        ] } })) : [{ span: { className: "muted small", textContent: "This field's values are not listed in its design: each is grey until given a colour in the JSON (colours)." } }] } }, "The colour of each value. Colours are the theme's own, so they read in light and in dark."),
        { FloorArrange: { key: `floor-${ctx.name}-${i}`, id: ctx.id, name: ctx.name, i, editable: () => !ctx.ro() } },
    ];
}

export function registerFloorEditor(juris) {
    juris.registerComponent("FloorArrange", ({ id, name, i, editable }, api) => {
        const w = W(id);
        const root = `${w}.sc.${name}`;
        const S = `${w}.floor.${name}.${i}`;
        const can = () => (typeof editable === "function" ? editable() : Boolean(editable));
        const block = () => api.peek(`${root}.blocks.${i}`) ?? {};
        const touched = () => { api.setValue(`${w}.dirty`, true); api.setValue(`${w}.vrev`, (api.peek(`${w}.vrev`) ?? 0) + 1); api.setValue(`${w}.rev`, (api.peek(`${w}.rev`) ?? 0) + 1); };
        const edit = (fn) => { const body = JSON.parse(JSON.stringify(api.peek(root))); fn(body.blocks[i]); api.setValue(root, body); touched(); };
        const objects = () => Object.fromEntries((api.peek("design.home.objects") ?? []).map((o) => [o.object, o]));
        const titleField = () => api.peek(`${w}.defs.${block().object}.titleField`) ?? objects()[block().object]?.titleField ?? null;

        // What the placed records are now (their pictures, their status), read as the designer: the
        // draft block, previewed. Read again when what is placed, or where pictures are, changes.
        let asked = null;
        const load = () => {
            const b = block();
            if (!b.image?.blob || !b.object) return;
            const mark = JSON.stringify([b.object, b.status, b.picture, (b.places ?? []).map((p) => p.of)]);
            if (mark === asked) return;
            asked = mark;
            const dept = (api.peek("design.home.departments") ?? [])[0]?.id;
            api.call("screens.preview", { screen: { name: "floor_arrange", label: "Floor", params: {}, blocks: [{ block: "floor", object: b.object, status: b.status ?? "state", image: b.image, ...(b.picture ? { picture: b.picture } : {}), places: b.places ?? [] }], callers: { users: [api.peek("me.id")], groups: [] }, stewards: [dept].filter(Boolean) } }).then(
                (r) => api.setValue(`${S}.now`, Object.fromEntries((r.data?.blocks?.[0]?.items ?? []).map((it) => [it.of, { id: it.id, status: it.status, picture: it.picture }]))),
                () => {});
        };
        if (!api.isServer) api.onMount(load);

        const upload = async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            api.batch(() => { api.setValue(`${S}.busy`, true); api.setValue(`${S}.error`, null); });
            try {
                const p = await uploadPicture(file);
                if (!p.w || !p.h) throw new Error("The picture could not be read: try another file.");
                edit((b) => { b.image = { blob: p.blob, w: p.w, h: p.h }; });
            } catch (err) { api.setValue(`${S}.error`, err.message); } finally { api.setValue(`${S}.busy`, false); }
        };

        // Finding records to place: by typing, as the designer may read them.
        let timer = null;
        const search = (q) => {
            api.setValue(`${S}.q`, q);
            clearTimeout(timer);
            const b = block();
            if (!q.trim() || !b.object) { api.setValue(`${S}.found`, []); return; }
            const by = titleField();
            timer = setTimeout(() => api.call("records.list", { object: b.object, as: api.peek("me.id"), q: q.trim() }).then((l) => {
                const names = (l.rows ?? []).map((r) => String((by && r[by]) ?? r.$title ?? "")).filter(Boolean);
                const called = names.filter((n) => n.toLowerCase().includes(q.trim().toLowerCase()));
                api.setValue(`${S}.found`, (called.length ? called : names).slice(0, 24));
            }, () => api.setValue(`${S}.found`, [])), 200);
        };
        // A record put on the floor: beside the last one placed, sized and marked like one already
        // there with the same picture (the same model), or like the last.
        const place = (of) => {
            const b = block();
            const places = b.places ?? [];
            if (!of || places.some((p) => p.of === of) || places.length >= MAX_PLACES) return;
            const last = places[places.length - 1];
            const like = last ?? DEFAULT_PLACE;
            const n = places.length;
            edit((bb) => { (bb.places ??= []).push({ of, x: round(clamp(last ? last.x + like.w + 0.01 : 0.04 + (n % 8) * 0.1, 0, 1 - like.w)), y: round(clamp(last ? last.y : 0.06)), w: like.w, ix: like.ix, iy: like.iy }); });
            api.setValue(`${S}.sel`, of);
            load();
        };

        // Dragging: a record across the floor, or its square across the record. The element follows the
        // pointer as it moves; the design takes the place when it is let go.
        const drag = (e, of) => {
            if (!can() || e.button > 0) return;
            const item = e.currentTarget;
            const floor = item.parentElement;
            const dot = e.target.closest?.("[data-dot]");
            const [fr, ir] = [floor.getBoundingClientRect(), item.getBoundingClientRect()];
            const start = { x: e.clientX, y: e.clientY, left: ir.left - fr.left, top: ir.top - fr.top };
            let moved = false;
            let at = null;
            e.preventDefault();
            api.setValue(`${S}.sel`, of);
            const move = (ev) => {
                moved = moved || Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 2;
                if (!moved) return;
                if (dot) {
                    at = { ix: round(clamp((ev.clientX - ir.left) / ir.width)), iy: round(clamp((ev.clientY - ir.top) / ir.height)) };
                    dot.style.left = `${at.ix * 100}%`;
                    dot.style.top = `${at.iy * 100}%`;
                } else {
                    at = { x: round(clamp((start.left + ev.clientX - start.x) / fr.width, 0, 1 - ir.width / fr.width)), y: round(clamp((start.top + ev.clientY - start.y) / fr.height, 0, Math.max(0, 1 - ir.height / fr.height))) };
                    item.style.left = `${at.x * 100}%`;
                    item.style.top = `${at.y * 100}%`;
                }
            };
            const up = () => {
                globalThis.removeEventListener("pointermove", move);
                globalThis.removeEventListener("pointerup", up);
                globalThis.removeEventListener("pointercancel", up);
                if (at) edit((b) => { const p = (b.places ?? []).find((x) => x.of === of); if (p) Object.assign(p, at); });
            };
            globalThis.addEventListener("pointermove", move);
            globalThis.addEventListener("pointerup", up);
            globalThis.addEventListener("pointercancel", up);
        };
        // The arrow keys move the chosen one a step (with Shift, a larger one): for whoever does not drag.
        const nudge = (e) => {
            const of = api.peek(`${S}.sel`);
            const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
            if (!can() || !of || !d) return;
            e.preventDefault();
            const step = e.shiftKey ? 0.02 : 0.004;
            edit((b) => { const p = (b.places ?? []).find((x) => x.of === of); if (p) { p.x = round(clamp(p.x + d[0] * step, 0, 1 - p.w)); p.y = round(clamp(p.y + d[1] * step)); } });
        };

        return { div: { className: "floor-arrange", children: () => {
            api.getState(`${w}.rev`);
            const b = block();
            const def = objects()[b.object] ?? {};
            const now = api.getState(`${S}.now`, {}) ?? {};
            const sel = api.getState(`${S}.sel`, null);
            const places = b.places ?? [];
            const chosen = places.find((p) => p.of === sel);
            const data = { object: b.object, label: def.label, image: b.image, colours: b.colours ?? {}, tones: (b.status ?? "state") === "state" ? def.tones ?? {} : {}, statusLabel: "Status", values: statusValues(def, b.status ?? "state"), items: places.map((p) => ({ ...p, id: now[p.of]?.id ?? "draft", status: now[p.of]?.status ?? null, picture: now[p.of]?.picture ?? null })) };
            const error = api.getState(`${S}.error`, null);
            const found = (api.getState(`${S}.found`, []) ?? []).filter((v) => !places.some((p) => p.of === v));
            return [
                { div: { className: "floor-tools", children: [
                    { strong: { className: "small", textContent: "The floor" } },
                    can() ? { label: { className: "btn", children: [{ span: api.getState(`${S}.busy`, false) ? "Uploading…" : b.image?.blob ? "Replace the floor's picture…" : "Upload the floor's picture…" }, { input: { type: "file", accept: PICTURE_TYPES.join(","), className: "visually-hidden", onchange: upload } }] } } : { span: {} },
                    { span: { className: "muted small", textContent: b.image?.blob ? `${b.image.w} × ${b.image.h} · ${places.length} of at most ${MAX_PLACES} placed` : "A top view of the floor or the line: PNG, JPEG or WebP, at most 5 MB." } },
                    error ? { span: { className: "error small", role: "alert", textContent: error } } : { span: {} },
                ] } },
                !pictureUrl(b.image?.blob) ? { span: {} } : { div: { children: [
                    can() ? { div: { className: "scope-pick", children: [
                        { input: { type: "search", placeholder: `Type to find ${(def.label ?? b.object ?? "").toLowerCase()} records, then click one to put it on the floor`, "aria-label": "Find records to place", value: () => api.getState(`${S}.q`, "") ?? "", oninput: (e) => search(e.target.value), onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); place(e.target.value.trim()); } } } },
                        found.length ? { div: { className: "scope-found", children: found.map((v) => ({ button: { key: v, type: "button", className: "btn ghost", textContent: `+ ${v}`, onclick: () => place(v) } })) } } : { span: {} },
                    ] } } : { span: {} },
                    { div: { className: "floor-wrap", children: [
                        { div: { className: `floor${can() ? " floor-edit" : ""}`, tabindex: can() ? "0" : undefined, "aria-label": "The floor: drag a record to where it stands, and its square to where it sits on it; the arrow keys move the chosen one", style: { aspectRatio: `${b.image.w} / ${b.image.h}` }, onkeydown: nudge, children: [
                            { img: { className: "floor-image", src: pictureUrl(b.image.blob), alt: "", draggable: false } },
                            ...data.items.map((it) => floorItem(data, it, { link: false, selected: it.of === sel, extra: { onpointerdown: (e) => drag(e, it.of) } })),
                        ] } },
                        floorLegend({ ...data, items: data.items.filter((it) => now[it.of]?.id) }),
                    ] } },
                    chosen && can() ? { div: { className: "floor-tools", children: [
                        { strong: chosen.of },
                        { label: { className: "inline small", children: [{ span: "Size " }, { input: { type: "range", min: 1, max: 40, step: 0.5, value: String(Math.round(chosen.w * 1000) / 10), "aria-label": `How wide ${chosen.of} is drawn, in hundredths of the floor's width`, onchange: (e) => edit((bb) => { const p = bb.places.find((x) => x.of === chosen.of); p.w = round(clamp(Number(e.target.value) / 100, 0.01, 0.4)); p.x = round(clamp(p.x, 0, 1 - p.w)); }) } }] } },
                        { button: { type: "button", className: "btn ghost", title: "Every record with the same picture is drawn as wide, with its square at the same spot", textContent: "Same size and square for its like", onclick: () => edit((bb) => { const pic = now[chosen.of]?.picture ?? null; for (const p of bb.places) if (p.of !== chosen.of && (now[p.of]?.picture ?? null) === pic) { p.w = chosen.w; p.ix = chosen.ix; p.iy = chosen.iy; p.x = round(clamp(p.x, 0, 1 - p.w)); } }) } },
                        { button: { type: "button", className: "btn ghost", children: [icon("x"), { span: "Take it off the floor" }], onclick: () => { edit((bb) => { bb.places = bb.places.filter((x) => x.of !== chosen.of); }); api.setValue(`${S}.sel`, null); } } },
                    ] } } : { p: { className: "muted small", textContent: can() ? "Drag a record to where it stands. Drag its small square to where it sits on it (its signal tower, its screen). Click one to size it or take it off." : "" } },
                ] } },
            ];
        } } };
    });
}
