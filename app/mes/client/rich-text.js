// Words written by a person or a copilot, drawn as they were meant: paragraphs, lists ("- item") and
// **bold**, the little of Markdown a model writes without being asked. Everything is drawn as text
// (never as HTML), so what is written cannot become markup. → Juris layout nodes.
const inline = (text) => String(text).split(/(\*\*[^*\n]+\*\*)/).filter(Boolean).map((part, i) => (/^\*\*[^*\n]+\*\*$/.test(part) ? { strong: { key: i, textContent: part.slice(2, -2) } } : { span: { key: i, textContent: part } }));

export function richText(text) {
    const out = [];
    let items = null;
    const flush = () => { if (items) { out.push({ ul: { key: out.length, className: "rich-list", children: items } }); items = null; } };
    for (const raw of String(text ?? "").split("\n")) {
        const line = raw.trimEnd();
        const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
        if (bullet) { (items ??= []).push({ li: { key: items.length, children: inline(bullet[1]) } }); continue; }
        flush();
        if (!line.trim()) continue;
        const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
        out.push(heading ? { p: { key: out.length, className: "rich-p rich-head", children: [{ strong: heading[1].replace(/\*\*/g, "") }] } } : { p: { key: out.length, className: "rich-p", children: inline(line.trim()) } });
    }
    flush();
    return out;
}
