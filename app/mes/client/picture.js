// Pictures (DESIGN.md §35): uploading one to the picture store, and where it is read from. A picture's
// name is the SHA-256 of its bytes, so its address never shows anything but that picture.
export const MAX_PICTURE_BYTES = 5_000_000;
export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const pictureUrl = (blob) => (typeof blob === "string" && /^[0-9a-f]{64}$/.test(blob) ? `/blob/${blob}` : null);

// → { blob, type, size, w, h }; throws in words a person can act on.
export async function uploadPicture(file) {
    if (!file) throw new Error("Choose a picture.");
    if (!PICTURE_TYPES.includes(file.type)) throw new Error("A picture is a PNG, a JPEG or a WebP file.");
    if (file.size > MAX_PICTURE_BYTES) throw new Error(`A picture is at most ${MAX_PICTURE_BYTES / 1_000_000} MB: save it smaller, or as a JPEG or WebP.`);
    const res = await fetch("/blob", { method: "POST", headers: { "content-type": file.type }, body: file });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "The picture could not be uploaded.");
    // How large it is drawn at: read from the picture itself.
    const size = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({ w: 0, h: 0 });
        img.src = `/blob/${body.blob}`;
    });
    return { ...body, ...size };
}
