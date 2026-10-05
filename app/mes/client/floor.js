// A floor layout (DESIGN.md §35): a screen block that draws records where they stand, on a picture of
// the floor, each with a small square showing its state as it is now.
//
//   { block: "floor", title?, width?, object,              the records drawn (the equipment)
//     status: "state" | field,                              what the square shows
//     colours: { value: colour },                           the legend: a colour per value (FLOOR_COLOURS)
//     image: { blob, w, h },                                the floor's picture (the picture store)
//     picture?: field | "ref.field",                        where each record's own picture is: an image
//                                                           field of it, or of the record a reference
//                                                           field names (the equipment's model)
//     places: [{ of, x, y, w, ix, iy }] }                   at most MAX_PLACES
//
// A place names its record by what people call it (`of`: the object's title field), not by an id: a
// design is read by its reviewers, and carried to other installations. x, y: where its top left corner
// is, as fractions of the floor's width and height; w: how wide it is drawn, as a fraction of the
// floor's width; ix, iy: where its square sits within it, as fractions of its own width and height.
// Fractions, so the floor is the same at every size it is drawn.
//
// Shared by the server (which checks a block) and the browser (which draws and arranges it): it
// imports nothing.
export const MAX_PLACES = 200;
// The legend's colours: the tones a state is coloured by everywhere (§10.8), and the series colours a
// chart uses, for plants with more states than tones. Each is a token with a light and a dark value
// (app.css): a design names a colour, never a number.
export const FLOOR_COLOURS = ["neutral", "info", "ok", "warn", "danger", "c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"];
export const FLOOR_COLOUR_WORDS = { neutral: "grey", info: "accent", ok: "green", warn: "amber", danger: "red", c0: "indigo", c1: "teal", c2: "orange", c3: "pink", c4: "violet", c5: "cyan", c6: "lime", c7: "brown" };
const TONE_COLOUR = { neutral: "neutral", info: "info", ok: "ok", warn: "warn", danger: "danger" };
export const DEFAULT_PLACE = { w: 0.08, ix: 0.82, iy: 0.06 };

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const BLOB = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9_]{0,47}$/;
const frac = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

// The values a status may take, in the order the legend lists them: an object's states, a choice
// field's values, yes and no; a field of any other kind has none to list (its values are coloured as
// they are met).
export function statusValues(def, status) {
    if (status === "state") return [...(def?.states?.list ?? def?.states ?? [])];
    const f = def?.fields?.[status];
    if (f?.type === "enum") return [...(f.values ?? [])];
    if (f?.type === "boolean") return ["true", "false"];
    return [];
}
// The fields a status may be: the state, and short fields with a value to colour.
export const statusFields = (def) => ["state", ...Object.entries(def?.fields ?? {}).filter(([, f]) => ["enum", "boolean", "string"].includes(f?.type) && !f.multiple).map(([k]) => k)];
// Where a record's picture may be: its own image fields, and those of the records its reference
// fields name ("model.image"). → [{ path, label }]
export function pictureFields(def, objects = {}) {
    const out = [];
    for (const [k, f] of Object.entries(def?.fields ?? {})) {
        if (f?.type === "image") out.push({ path: k, label: f.label ?? k });
        if (f?.type === "ref" && !f.multiple) for (const [k2, f2] of Object.entries(objects[f.to]?.fields ?? {})) if (f2?.type === "image") out.push({ path: `${k}.${k2}`, label: `${f.label ?? k} → ${f2.label ?? k2}` });
    }
    return out;
}
// The colour of a value: the legend's, else (a state) its tone's, else grey.
export const colourOf = (colours, tones, value) => {
    const key = value === null || value === undefined ? "" : String(value);
    if (isPlain(colours) && FLOOR_COLOURS.includes(colours[key])) return colours[key];
    return TONE_COLOUR[tones?.[key]] ?? "neutral";
};

// What is wrong with a floor block: [messages]. `def`: its object as known ({ fields, states,
// titleField }), `objects`: every object, for a picture read through a reference.
export function floorProblems(b, def, objects = {}) {
    const out = [];
    if (def && !def.titleField) out.push(`${b.object} has no title field: its records are placed by what they are called.`);
    if (b.status === undefined) out.push("say which field is the status (the state, or a field).");
    else if (b.status !== "state" && !(typeof b.status === "string" && def?.fields && Object.hasOwn(def.fields, b.status))) out.push(`${b.object} has no field "${b.status}".`);
    else if (b.status !== "state" && def?.fields && !statusFields(def).includes(b.status)) out.push(`"${b.status}" is not a field a status can be read from (a choice, a yes/no or a short text).`);
    if (b.colours !== undefined) {
        if (!isPlain(b.colours) || Object.keys(b.colours).length > 100) out.push("the legend is { value: colour }.");
        else for (const [v, c] of Object.entries(b.colours)) if (!FLOOR_COLOURS.includes(c)) out.push(`the legend's colour for "${v}" is one of ${FLOOR_COLOURS.join(", ")}.`);
    }
    if (!isPlain(b.image) || !BLOB.test(b.image.blob ?? "")) out.push("upload the picture of the floor.");
    else if (!(Number.isInteger(b.image.w) && Number.isInteger(b.image.h) && b.image.w > 0 && b.image.h > 0 && b.image.w <= 20000 && b.image.h <= 20000)) out.push("the floor's picture says how large it is (image.w, image.h, in pixels).");
    if (b.picture !== undefined) {
        const parts = typeof b.picture === "string" ? b.picture.split(".") : [];
        if (parts.length < 1 || parts.length > 2 || !parts.every((p) => NAME.test(p))) out.push('the records\' picture is an image field, or one through a reference: "image" or "model.image".');
        else if (def?.fields && !pictureFields(def, objects).some((p) => p.path === b.picture)) out.push(`"${b.picture}" is not an image field of ${b.object}${parts.length === 2 ? ", or of what it refers to" : ""}.`);
    }
    const places = Array.isArray(b.places) ? b.places : null;
    if (b.places !== undefined && !places) out.push("places is a list.");
    if ((places ?? []).length > MAX_PLACES) out.push(`a floor holds at most ${MAX_PLACES} places.`);
    const seen = new Set();
    (places ?? []).forEach((p, i) => {
        if (!isPlain(p) || typeof p.of !== "string" || !p.of.trim() || p.of.length > 120) { out.push(`place ${i + 1} names its record (of).`); return; }
        if (seen.has(p.of)) out.push(`"${p.of}" is placed twice.`);
        seen.add(p.of);
        if (!frac(p.x) || !frac(p.y) || !frac(p.ix) || !frac(p.iy) || !(frac(p.w) && p.w >= 0.01)) out.push(`"${p.of}": where it stands, how wide it is and where its square sits are fractions between 0 and 1.`);
        for (const k of Object.keys(p)) if (!["of", "x", "y", "w", "ix", "iy"].includes(k)) out.push(`"${p.of}": a place has no "${k}".`);
    });
    return out;
}
