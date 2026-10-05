// Files a person attaches (DESIGN.md §34.10): a picture, a PDF, a CSV file or an Excel workbook, kept in the
// file store (POST /blob: kept by what it is, its kind read from its bytes), for a copilot to read with a
// message, for a kept prompt to be given each time, for a report to show. A list in state, at `path`:
// [{ blob, name, type, size }].
import { icon } from "./icons.js";

export const MAX_FILES = 5;
export const ACCEPT = ".png,.jpg,.jpeg,.webp,.pdf,.csv,.xlsx,image/png,image/jpeg,image/webp,application/pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const KIND = { "image/png": "picture", "image/jpeg": "picture", "image/webp": "picture", "application/pdf": "PDF", "text/csv": "CSV", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel" };
export const kindOf = (type) => KIND[type] ?? "file";
const sizeWords = (n) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);
// Where a kept file is opened or saved, under its name (a picture opens; a document is saved).
export const fileHref = (f) => `/blob/${f.blob}${f.name ? `?name=${encodeURIComponent(f.name)}` : ""}`;

// One file into the store: { blob, type, size }, or it throws with the store's own words.
export async function uploadFile(file) {
    const res = await fetch("/blob", { method: "POST", body: file, credentials: "same-origin" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "The file could not be kept.");
    return body;
}

// What stands for a file: a picture by its own preview (served from the store, kept by the browser), a
// document by its icon.
const isPicture = (f) => String(f.type ?? "").startsWith("image/");
export const fileMark = (f, size = "small") => (isPicture(f) ? { img: { className: `att-thumb ${size}`, src: `/blob/${f.blob}`, alt: "", loading: "lazy", decoding: "async" } } : icon("file"));
// The files of a message or a prompt, as links (in a conversation, beside what was asked).
export const fileChips = (files) => ({ div: { className: "att-chips", children: (files ?? []).map((f) => ({ a: { key: f.blob, className: `att-chip${isPicture(f) ? " pic" : ""}`, href: fileHref(f), target: "_blank", rel: "noopener", title: `${f.name ?? kindOf(f.type)}: ${isPicture(f) ? "open it full size" : "open or save"}`, children: [fileMark(f, "large"), { span: { className: "att-name", textContent: f.name ?? kindOf(f.type) } }] } })) } });

// Files into the list at `path`, each kept in the store first (the paper clip, a paste, a drop alike).
export async function addFiles(api, path, files) {
    const list = () => api.getState(path, []) ?? [];
    api.setValue(`${path}$said`, null);
    for (const file of Array.from(files ?? [])) {
        if (list().length >= MAX_FILES) { api.setValue(`${path}$said`, `At most ${MAX_FILES} files.`); break; }
        const name = (file.name && file.name !== "image.png" ? file.name : `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${(file.type.split("/")[1] ?? "png").replace("jpeg", "jpg")}`).slice(0, 200);
        api.setValue(`${path}$busy`, name);
        try {
            const kept = await uploadFile(file);
            if (!list().some((f) => f.blob === kept.blob)) api.setValue(path, [...list(), { blob: kept.blob, name, type: kept.type, size: kept.size }]);
        } catch (error) {
            api.setValue(`${path}$said`, `${name}: ${error.message}`);
        }
    }
    api.setValue(`${path}$busy`, null);
}
// What a text box gives to take files pasted into it (a screenshot, a file copied) or dropped on it: text
// pasted stays text; a paste that holds files attaches them instead.
export const pasteFiles = (api, path) => ({
    onpaste: (e) => { const files = [...(e.clipboardData?.files ?? [])]; if (!files.length) return; e.preventDefault(); addFiles(api, path, files); },
    ondragover: (e) => { if ([...(e.dataTransfer?.types ?? [])].includes("Files")) e.preventDefault(); },
    ondrop: (e) => { const files = [...(e.dataTransfer?.files ?? [])]; if (!files.length) return; e.preventDefault(); addFiles(api, path, files); },
});

export function registerAttach(juris) {
    // props: path (the list in state), disabled (a function or a value), label (the button's words).
    juris.registerComponent("AttachFiles", ({ path, disabled = false, label = "Attach" }, api) => {
        const id = `att-${Math.random().toString(36).slice(2, 10)}`;
        const list = () => api.getState(path, []) ?? [];
        const off = () => (typeof disabled === "function" ? disabled() : disabled);
        const add = (files) => addFiles(api, path, files);
        const remove = (blob) => api.setValue(path, list().filter((f) => f.blob !== blob));
        return {
            div: {
                className: "att",
                children: [
                    { input: { id, type: "file", multiple: true, accept: ACCEPT, className: "att-input", tabindex: "-1", "aria-hidden": "true", onchange: (e) => { add(e.target.files); e.target.value = ""; } } },
                    { button: { type: "button", className: "btn ghost small att-btn", disabled: () => off() || list().length >= MAX_FILES || Boolean(api.getState(`${path}$busy`, null)), title: "Attach a picture, a PDF, a CSV file or an Excel workbook (up to 5); or paste or drop one into the box", onclick: () => globalThis.document?.getElementById(id)?.click(), children: [icon("attach"), { span: label }] } },
                    () => (api.getState(`${path}$busy`, null) ? { span: { className: "muted small", textContent: `Keeping ${api.getState(`${path}$busy`)}…` } } : { span: {} }),
                    () => ({ div: { className: "att-chips", children: list().map((f) => ({ span: { key: f.blob, className: `att-chip${isPicture(f) ? " pic" : ""}`, children: [
                        fileMark(f), { span: { className: "att-name", textContent: f.name } }, { span: { className: "muted", textContent: ` ${kindOf(f.type)}, ${sizeWords(f.size ?? 0)}` } },
                        { button: { type: "button", className: "att-x", title: `Take ${f.name} off`, "aria-label": `Take ${f.name} off`, disabled: off(), onclick: () => remove(f.blob), children: [icon("x")] } },
                    ] } })) } }),
                    () => (api.getState(`${path}$said`, null) ? { p: { className: "error small", role: "alert", textContent: api.getState(`${path}$said`) } } : { span: {} }),
                ],
            },
        };
    });
}
