// A printable, controlled document (the developer's guide, the installation procedure): numbered parts and
// sections, procedures as step tables with a Done column, a cover with the document number and revision, a
// contents page, and a PDF printed by headless Chrome. One template, so every document prints alike.
//
//   const d = printable();
//   d.add(d.h1("Part", "id"), d.h2("Section", "id2"), d.proc({ id: "IN-01", title, who, purpose, before, steps, after }));
//   await d.write({ dir, name, doc: "OMES-…", revision, issued, title, subtitle, appliesTo, pdf })
// A reference to a section or procedure is written [[see:<its id>]]: resolved to its number, as a link.
import { writeFileSync, mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const code = (s) => `<code${String(s ?? "").length <= 26 ? ' class="n"' : ""}>${esc(s)}</code>`;
export const list = (xs) => xs.map(code).join(", ");
export const pre = (s, lang = "") => `<pre class="${lang}">${esc(s.replace(/^\n/, ""))}</pre>`;
export const table = (head, rows) => `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c ?? ""}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
export const kv = (pairs) => `<table class="kv"><tbody>${pairs.filter(Boolean).map(([k, v]) => `<tr><th>${k}</th><td>${v ?? "—"}</td></tr>`).join("")}</tbody></table>`;
export const note = (html, kind = "note") => `<div class="callout ${kind}"><strong>${{ note: "Note", warn: "Caution", planned: "Planned", undo: "Cannot be undone" }[kind]}.</strong> ${html}</div>`;
// Under a command that cannot be taken back: what is lost, and how to avoid it.
export const undoable = (html) => note(html, "undo");
export const h3 = (title) => `<h3>${esc(title)}</h3>`;
// Commands to type, one whole command a line, never inside a sentence (people copy what they see): what is
// between < > is to be replaced, and shown so. In the HTML each block has a Copy button.
export const cmd = (lines) => `<div class="cmd"><button type="button" class="copy" aria-label="Copy these commands">Copy</button><pre>${[].concat(lines).map((l) => esc(l).replace(/&lt;([^&]+?)&gt;/g, '<span class="ph">&lt;$1&gt;</span>')).join("\n")}</pre></div>`;
// A file's content (a settings file, a unit): to paste into an editor, never into a terminal. Titled with its path.
export const file = (where, text) => `<div class="cmd file"><div class="file-head">File <b>${esc(where)}</b>: paste into an editor, not the terminal</div><button type="button" class="copy" aria-label="Copy the file's content">Copy</button><pre>${esc(text.replace(/^\n/, "")).replace(/&lt;([^&\n]+?)&gt;/g, '<span class="ph">&lt;$1&gt;</span>')}</pre></div>`;
// A command in a step's prose is refused at build: it would be copied with the words around it.
const COMMAND_WORDS = /^(sudo|npm|npx|node|opencore-mes|systemctl|curl|install|ln|echo|cd|mkdir|openssl|apt-get|apt|brew|psql|wsl|git|dropdb|createdb|chown|chmod|caddy|ufw|export|set|for|cp|mv|rm|tar|DATABASE_URL=|HOST=|PGHOST=|DEMO_HOST=|BACKUP_KEY=|journalctl|ls|grep|cat)\b/;
export function commandsInProse(html) {
    const prose = String(html).replace(/<div class="cmd[^"]*">[\s\S]*?<\/pre><\/div>/g, "");
    return [...prose.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map((m) => m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")).filter((c) => COMMAND_WORDS.test(c.trim()) && /\s/.test(c.trim()));
}

export const CSS = `
@page { size: A4; margin: 16mm 14mm 18mm; }
:root { --ink: #141821; --muted: #5b6474; --line: #d6dbe3; --soft: #f3f5f8; --accent: #2b303a; --warn: #8a4b00; --warn-soft: #fff4e0; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 900px; padding: 24px 16px; color: var(--ink); background: #fff; font: 10.5pt/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
h1.part { font-size: 20pt; margin: 0 0 10px; padding-top: 4px; border-bottom: 2px solid var(--ink); break-before: page; }
h2 { font-size: 14pt; margin: 22px 0 8px; break-after: avoid; }
h3 { font-size: 12pt; margin: 18px 0 6px; break-after: avoid; }
p, ul { margin: 0 0 8px; }
li { margin: 2px 0; }
code { font: 8.6pt/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--soft); padding: 0 3px; border-radius: 3px; overflow-wrap: anywhere; }
code.n { white-space: nowrap; overflow-wrap: normal; }
pre { font: 8.4pt/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--soft); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; break-inside: avoid; margin: 6px 0 10px; }
a { color: var(--accent); text-decoration: none; }
table { width: 100%; border-collapse: collapse; margin: 4px 0 10px; font-size: 9pt; }
th, td { border: 1px solid var(--line); padding: 4px 6px; text-align: left; vertical-align: top; }
thead th { background: var(--soft); }
tr { break-inside: avoid; }
table.kv th { width: 24%; background: var(--soft); font-weight: 600; }
.callout { border-left: 4px solid var(--accent); background: var(--soft); padding: 6px 10px; margin: 8px 0; font-size: 9.5pt; break-inside: avoid; }
.callout.warn, .callout.planned { border-left-color: var(--warn); background: var(--warn-soft); }
.callout.undo { border-left-color: #b42318; background: #fdecea; color: #7a1a12; margin-top: 4px; }
.flow { display: grid; gap: 6px; margin: 6px 0 12px; }
.flow div { border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 4px; padding: 6px 10px; font-size: 9.5pt; background: var(--soft); }
.proc { border: 1.5px solid var(--ink); border-radius: 6px; padding: 10px 12px; margin: 14px 0; }
.proc-head { display: flex; gap: 10px; align-items: baseline; margin-bottom: 6px; break-after: avoid; }
.proc-id { font-weight: 700; background: var(--ink); color: #fff; padding: 1px 8px; border-radius: 4px; font-size: 9.5pt; }
.proc-title { font-weight: 700; font-size: 12pt; }
table.steps { table-layout: fixed; }
table.steps th:nth-child(2) { width: 60%; }
table.steps td { overflow-wrap: anywhere; }
table.steps td.n, table.steps th.n { width: 26px; text-align: center; }
table.steps td.ok, table.steps th.ok { width: 52px; }
.proc-after { font-size: 9.5pt; }
.cover { min-height: 250mm; display: flex; flex-direction: column; justify-content: center; }
.cover .doc-no { color: var(--muted); letter-spacing: .06em; }
.cover .title { font-size: 34pt; margin: 6px 0; border: 0; break-before: auto; }
.cover .subtitle { font-size: 15pt; color: var(--muted); margin-bottom: 26px; }
.toc { break-before: page; }
.toc ol { padding-left: 18px; }
.toc li.l1 { font-weight: 700; margin-top: 6px; }
.toc li.l2 { margin-left: 14px; font-weight: 400; }
.cmd { position: relative; margin: 6px 0 4px; break-inside: avoid; }
.cmd pre { margin: 0; padding-right: 58px; background: #0f1218; color: #e8ebf0; border-color: #0f1218; white-space: pre; overflow-x: auto; }
.cmd .ph { color: #ffd166; font-style: italic; }
.ph-sample { background: #0f1218; color: #ffd166; font-style: italic; padding: 0 4px; border-radius: 3px; }
.cmd .copy { position: absolute; top: 4px; right: 4px; font: 600 8pt ui-sans-serif, system-ui, sans-serif; border: 1px solid #3a4150; background: #232833; color: #e8ebf0; border-radius: 4px; padding: 2px 8px; cursor: pointer; }
.cmd .copy.done { background: #1f6f43; }
.cmd.file pre { background: #f7f3e8; color: var(--ink); border-color: #d9cfb3; }
.cmd.file .ph { color: #8a4b00; }
.cmd.file .copy { top: 26px; background: #efe6cc; color: var(--ink); border-color: #d9cfb3; }
.file-head { font-size: 8.5pt; color: var(--muted); margin-bottom: 2px; }
.rules { border: 1.5px solid var(--ink); border-radius: 6px; padding: 8px 12px; margin: 10px 0; }
@media screen { body { padding-top: 32px; } h1.part { margin-top: 48px; } }
@media print { .cmd .copy { display: none; } .cmd pre { white-space: pre-wrap; padding-right: 10px; } }
@media print { a { color: var(--ink); } }
`;

// The Copy buttons: the block's text, as typed (the placeholders still to be replaced).
const COPY_SCRIPT = `(function () {
  function said(b, words, ok) { b.textContent = words; b.classList.toggle("done", ok); setTimeout(function () { b.textContent = "Copy"; b.classList.remove("done"); }, 2000); }
  // The old way first: it works from a file on disk (file://), where the clipboard API is refused.
  function byCommand(text) {
    var t = document.createElement("textarea");
    t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.top = "-1000px"; t.style.opacity = "0";
    document.body.appendChild(t); t.select(); t.setSelectionRange(0, text.length);
    var ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(t); return ok;
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest(".cmd .copy") : null;
    if (!b) return;
    var pre = b.parentNode.querySelector("pre"), text = pre.textContent;
    if (byCommand(text)) { said(b, "Copied", true); return; }
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(function () { said(b, "Copied", true); }, function () { select(pre, b); }); return; }
    select(pre, b);
  });
  // Neither allowed: the text selected, to copy with the keyboard.
  function select(pre, b) { var r = document.createRange(); r.selectNodeContents(pre); var s = getSelection(); s.removeAllRanges(); s.addRange(r); said(b, /Mac/.test(navigator.platform) ? "Press ⌘C" : "Press Ctrl+C", false); }
})();`;

export function printable() {
    const toc = [];
    const body = [];
    const refused = [];
    let part = 0;
    let section = 0;
    const h1 = (title, id) => { part++; section = 0; toc.push({ level: 1, id, title: `${part}. ${title}` }); return `<h1 id="${id}" class="part">${part}. ${esc(title)}</h1>`; };
    const h2 = (title, id) => { section++; toc.push({ level: 2, id, title: `${part}.${section} ${title}` }); return `<h2 id="${id}">${part}.${section} ${esc(title)}</h2>`; };
    const proc = ({ id, title, who, purpose, before = [], steps, after = "" }) => {
        toc.push({ level: 3, id: `p-${id}`, title: `${id} ${title}` });
        return `<section class="proc" id="p-${id}">
  <div class="proc-head"><span class="proc-id">${id}</span><span class="proc-title">${esc(title)}</span></div>
  ${kv([["Purpose", purpose], ["Done by", who], before.length ? ["Before you start", `<ul>${before.map((b) => `<li>${b}</li>`).join("")}</ul>`] : null])}
  <table class="steps"><thead><tr><th class="n">#</th><th>Do this</th><th>You should see</th><th class="ok">Done</th></tr></thead><tbody>
  ${steps.map(([a, r, cmds, irreversible], i) => {
        const bad = commandsInProse(a);
        if (bad.length) refused.push(`${id} step ${i + 1}: ${bad.join(" | ")}`);
        // The step's commands (an array, one whole command each), or a block already made (a file's content).
        // (A fourth part: what the step's command does that cannot be taken back, said right under it.)
        return `<tr><td class="n">${i + 1}</td><td>${a}${cmds ? (typeof cmds === "string" ? cmds : cmd(cmds)) : ""}${irreversible ? undoable(irreversible) : ""}</td><td>${r ?? ""}</td><td class="ok"></td></tr>`;
    }).join("")}
  </tbody></table>${after ? `<div class="proc-after">${after}</div>` : ""}
</section>`;
    };
    const add = (...xs) => body.push(...xs);

    // → the HTML file's path; with `pdf`, the PDF printed beside it (headless Chrome; CHROME=<path> if not on macOS).
    async function write({ dir, name, doc, revision, issued, title, subtitle, appliesTo, footerTitle = title, pdf = false }) {
        if (refused.length) throw new Error(`Commands inside a step's prose: give each as the step's commands (a block of its own), or they are copied with the words around them:\n  ${refused.join("\n  ")}`);
        const tocHtml = `<nav class="toc"><h2>Contents</h2><ol>${toc.filter((t) => t.level < 3).map((t) => `<li class="l${t.level}"><a href="#${t.id}">${esc(t.title)}</a></li>`).join("")}</ol>
<h3>Procedures</h3><ol class="procs">${toc.filter((t) => t.level === 3).map((t) => `<li><a href="#${t.id}">${esc(t.title)}</a></li>`).join("")}</ol></nav>`;
        const cover = `<section class="cover">
  <p class="doc-no">${doc} · Revision ${revision}</p>
  <h1 class="title">OpenCore MES</h1>
  <p class="subtitle">${subtitle}</p>
  ${kv([["Document", doc], ["Revision", `${revision}, issued ${issued}`], ["Applies to", appliesTo]])}
</section>`;
        const numbered = (text) => text.replace(/\[\[see:([\w-]+)\]\]/g, (_, id) => { const t = toc.find((x) => x.id === id); if (!t) throw new Error(`see(${id}): no such section`); return `<a href="#${id}">${esc(t.title.split(" ")[0].replace(/\.$/, ""))}</a>`; });
        const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body>${cover}${tocHtml}${numbered(body.join("\n"))}<script>${COPY_SCRIPT}</script></body></html>`;
        const out = path.join(dir, `${name}.html`);
        writeFileSync(out, html);
        console.log(`${out}: ${(html.length / 1024).toFixed(0)} KB, ${toc.filter((t) => t.level === 3).length} procedures`);
        if (pdf) await printPdf(out, path.join(dir, `${name}.pdf`), `${doc} rev. ${revision} · ${footerTitle}`);
        return out;
    }
    return { add, h1, h2, h3, proc, toc, write };
}

async function printPdf(htmlFile, pdfFile, footerText) {
    const chromePath = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const port = 9700 + Math.floor(Math.random() * 200);
    const chrome = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), "printable-"))}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let target = null;
    for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {} }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let seq = 0; const pending = new Map();
    ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result))); ws.send(JSON.stringify({ id, method, params })); });
    try {
        await cdp("Page.enable");
        await cdp("Page.navigate", { url: pathToFileURL(htmlFile).href });
        await sleep(1500);
        const footer = `<div style="font: 7.5pt sans-serif; color: #666; width: 100%; padding: 0 14mm; display: flex; justify-content: space-between;"><span>${esc(footerText)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
        const pdf = await cdp("Page.printToPDF", { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: "<div></div>", footerTemplate: footer });
        writeFileSync(pdfFile, Buffer.from(pdf.data, "base64"));
        console.log(`${pdfFile}: ${(Buffer.from(pdf.data, "base64").length / 1024).toFixed(0)} KB`);
    } finally { ws.close(); chrome.kill(); }
}
