// Words written by a person or a copilot, drawn as they were meant: paragraphs, lists ("- item"),
// **bold** and [links](https://…), the little of Markdown a model writes without being asked. Everything
// is drawn as text (never as HTML), so what is written cannot become markup. → Juris layout nodes.
//
// A link goes to an https address (in a new tab) or to a page of this site ("/s/work_centre"); anything
// else is left as the text it was written as.
const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/;
export const linkTarget = (url) => (/^https:\/\/[^\s/]+/i.test(url) ? { href: url, external: true } : /^\/(?!\/)[^\s]*$/.test(url) ? { href: url, external: false } : null);
const inline = (text) => String(text).split(/(\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\))/).filter(Boolean).map((part, i) => {
    if (/^\*\*[^*\n]+\*\*$/.test(part)) return { strong: { key: i, textContent: part.slice(2, -2) } };
    const link = LINK.exec(part);
    const target = link && linkTarget(link[2]);
    if (target) return { a: { key: i, href: target.href, textContent: link[1], ...(target.external ? { target: "_blank", rel: "noopener noreferrer" } : {}) } };
    return { span: { key: i, textContent: part } };
});

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
