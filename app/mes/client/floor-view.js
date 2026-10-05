// A floor layout, drawn (DESIGN.md §35): the floor's picture, each placed record where it stands (its
// own picture, or a plain tile), a small square on it in its status's colour, and the legend. Drawn
// from a block's data (screens.js): a pure function of it, so it follows the records as they change.
// Positions are fractions of the floor, so it is the same floor at every width.
import { colourOf, FLOOR_COLOUR_WORDS } from "./floor.js";
import { pictureUrl } from "./picture.js";

const pct = (v) => `${Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 10000) / 100}%`;
const words = (v) => String(v ?? "").replace(/_/g, " ");

// One placed record. `inner`: what wraps it (a link to the record on a page; nothing in the editor).
export function floorItem(data, it, { link = true, selected = false, extra = {} } = {}) {
    const colour = colourOf(data.colours, data.tones, it.status);
    const said = it.id ? `${it.of} · ${it.status === null ? "no status" : words(it.status)}` : `${it.of} · not a record you may read`;
    const body = [
        pictureUrl(it.picture) ? { img: { className: "floor-pic", src: pictureUrl(it.picture), alt: "", draggable: false } } : { span: { className: "floor-box", textContent: it.of } },
        { span: { className: `floor-dot fc-${it.id ? colour : "none"}`, style: { left: pct(it.ix), top: pct(it.iy) }, "data-dot": "1" } },
        pictureUrl(it.picture) ? { span: { className: "floor-name", textContent: it.of } } : { span: {} },
    ];
    return { div: {
        key: it.of, className: `floor-item${selected ? " selected" : ""}`, title: said, style: { left: pct(it.x), top: pct(it.y), width: pct(it.w) }, "data-of": it.of, ...extra,
        children: link && it.id ? [{ Link: { to: `/o/${data.object}/${it.id}`, className: "floor-link", "aria-label": said, children: body } }] : body,
    } };
}

// The legend: each value the status may take (and any met besides), its colour, how many stand so.
export function floorLegend(data) {
    const items = data.items ?? [];
    const met = items.filter((it) => it.id && it.status !== null).map((it) => it.status);
    const values = [...new Set([...(data.values ?? []), ...met])];
    if (!values.length) return { span: {} };
    return { ul: { className: "floor-legend", "aria-label": `${data.statusLabel ?? "Status"}: what each colour means`, children: values.map((v) => ({ li: { key: v, children: [
        { span: { className: `floor-dot fc-${colourOf(data.colours, data.tones, v)}` } },
        { span: words(v) },
        { span: { className: "muted", textContent: String(met.filter((m) => m === v).length) } },
    ] } })) } };
}

export function floorView(data, { link = true } = {}) {
    if (!pictureUrl(data?.image?.blob)) return { p: { className: "muted small", textContent: "The floor's picture is not set yet." } };
    return { div: { className: "floor-wrap", children: [
        { div: { className: "floor", style: { aspectRatio: `${data.image.w} / ${data.image.h}` }, children: [
            { img: { className: "floor-image", src: pictureUrl(data.image.blob), alt: `${data.label ?? "Floor"} layout`, draggable: false } },
            ...(data.items ?? []).map((it) => floorItem(data, it, { link })),
        ] } },
        floorLegend(data),
    ] } };
}
export { FLOOR_COLOUR_WORDS };
