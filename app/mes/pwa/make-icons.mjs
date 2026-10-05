// Draws the app's icons (PNG) with nothing but Node: a graphite square with a white "M", supersampled.
// The maskable one keeps the letter inside the middle 60%, so any mask a system applies leaves it
// whole. Run again after changing the design: node app/mes/pwa/make-icons.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const GRAPHITE = [43, 48, 58];
const WHITE = [255, 255, 255];
// The letter, in a unit box.
const M = [[0, 1], [0, 0], [0.2, 0], [0.5, 0.42], [0.8, 0], [1, 0], [1, 1], [0.8, 1], [0.8, 0.36], [0.5, 0.76], [0.2, 0.36], [0.2, 1]];
const inside = (x, y, poly) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i]; const [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
};
function draw(size, { glyph = 0.46, radius = 0.2 } = {}) {
    const px = new Uint8Array(size * size * 4);
    const g0 = (1 - glyph) / 2;
    const S = 4;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let bg = 0; let fg = 0;
            for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
                const u = (x + (sx + 0.5) / S) / size; const v = (y + (sy + 0.5) / S) / size;
                // A rounded square (radius 0 fills the whole icon, for the maskable one).
                const dx = Math.max(radius - u, 0, u - (1 - radius)); const dy = Math.max(radius - v, 0, v - (1 - radius));
                if (radius === 0 || dx * dx + dy * dy <= radius * radius) {
                    bg += 1;
                    if (inside((u - g0) / glyph, (v - g0) / glyph, M)) fg += 1;
                }
            }
            const n = S * S; const a = bg / n; const f = bg ? fg / bg : 0;
            const i = (y * size + x) * 4;
            for (let c = 0; c < 3; c++) px[i + c] = Math.round(GRAPHITE[c] * (1 - f) + WHITE[c] * f);
            px[i + 3] = Math.round(a * 255);
        }
    }
    return png(size, px);
}
function png(size, px) {
    const raw = Buffer.alloc((size * 4 + 1) * size);
    for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1); }
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
const dir = new URL(".", import.meta.url);
writeFileSync(new URL("icon-192.png", dir), draw(192));
writeFileSync(new URL("icon-512.png", dir), draw(512));
writeFileSync(new URL("icon-maskable-512.png", dir), draw(512, { glyph: 0.4, radius: 0 }));
writeFileSync(new URL("apple-touch-icon.png", dir), draw(180, { radius: 0 }));
console.log("icons written");
