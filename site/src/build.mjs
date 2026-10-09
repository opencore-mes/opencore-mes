// Builds the site's pages (opencoremes.com): each page's own content (src/pages/<name>.html, a JSON comment on its
// first line: title, description, nav) inside the one layout every page shares: its head, the top bar with the
// page it is marked, the icons it uses (only those), the background bricks and the footer. Static, nothing from
// elsewhere: what Caddy serves is site/ as built (ops/demo/deploy.sh --site; src/ is not shipped).
//
//   node site/src/build.mjs        writes site/<name>.html for every page; run after changing anything in src/
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

const SRC = new URL("./", import.meta.url);
const OUT = new URL("../", import.meta.url);
const read = (name) => readFileSync(new URL(name, SRC), "utf8");

// The pages, in the order the menus list them: [file, label, the problem it answers].
export const PAGES = [
    ["design", "Design", "Changes wait on a vendor"],
    ["control", "Control", "Changes nobody can trace"],
    ["floor", "Floor", "Stale screens and paper"],
    ["ai", "AI", "Answers that take a week"],
    ["connect", "Connect", "Glue for every machine"],
    ["scale", "Scale", "Growth means downtime"],
    ["editions", "Editions", "Paying for what you skip"],
    ["about", "About", "Who makes it"],
];
const ORIGIN = "https://opencoremes.com";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Every icon, by id, from the one sprite; a page carries only those it uses.
const sprite = read("icons.svg");
const symbols = new Map([...sprite.matchAll(/<symbol id="([^"]+)"[\s\S]*?<\/symbol>/g)].map((m) => [m[1], m[0].replace(/<symbol id="([^"]+)"viewBox/, '<symbol id="$1" viewBox')]));
const iconsFor = (html) => {
    const used = [...new Set([...html.matchAll(/href="#(i-[\w-]+)"/g)].map((m) => m[1]))];
    for (const id of used) if (!symbols.has(id)) throw new Error(`icon #${id} is not in icons.svg`);
    return `<svg width="0" height="0" style="position:absolute" aria-hidden="true">\n  <defs>\n${used.map((id) => `    ${symbols.get(id)}`).join("\n")}\n  </defs>\n</svg>`;
};
const bricks = read("bricks.html").trim();

function page(name, html) {
    const first = /^<!--\s*(\{[\s\S]*?\})\s*-->\n/.exec(html);
    if (!first) throw new Error(`${name}.html: its first line is a JSON comment (title, description)`);
    const meta = JSON.parse(first[1]);
    const body = html.slice(first[0].length);
    const path = name === "index" ? "/" : `/${name}`;
    const nav = (cls) => PAGES.filter(([p]) => p !== "about").map(([p, label]) => `<a href="/${p}"${p === name ? ' aria-current="page"' : ""}${cls}>${label}</a>`).join("\n      ");
    const shell = `<header class="top">
  <div class="wrap">
    <a class="brand" href="/" aria-label="OpenCore MES home">
      <svg viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="102" fill="#2b303a"/><path fill="#fff" d="M138 374V138h47l71 101 71-101h47v236h-47V222l-71 100-71-100v152z"/></svg>
      OpenCore MES
    </a>
    <nav class="links" aria-label="Main">
      ${nav("")}
    </nav>
    <a class="btn primary" href="https://demo.opencoremes.com/">Try the demo</a>
    <details class="menu">
      <summary aria-label="Every page, and the other sites"><svg class="icon"><use href="#i-menu"/></svg></summary>
      <nav aria-label="Pages">
          <a href="/"${name === "index" ? ' aria-current="page"' : ""}>Home</a>
${PAGES.map(([p, label, problem]) => `          <a href="/${p}"${p === name ? ' aria-current="page"' : ""}><b>${label}</b><small>${problem}</small></a>`).join("\n")}
          <hr>
          <a href="https://trainings.opencoremes.com/">Courses</a>
          <a href="https://suites.opencoremes.com/">Suites store</a>
          <a href="https://github.com/opencore-mes/opencore-mes" rel="noopener">Source on GitHub</a>
      </nav>
    </details>
  </div>
</header>`;
    const footer = `<footer>
  <div class="wrap">
    <span>© 2026 OpenCore MES. "OpenCore MES" is a trademark of its owner.</span>
    <span>${PAGES.map(([p, label]) => `<a href="/${p}">${label}</a>`).join(" · ")}</span>
    <span><a href="https://demo.opencoremes.com/">Live demo</a> · <a href="https://trainings.opencoremes.com/">Courses</a> · <a href="https://suites.opencoremes.com/">Suites store</a> · <a href="https://github.com/opencore-mes/opencore-mes" rel="noopener">Source on GitHub</a> · <a href="mailto:contact@opencoremes.com?subject=OpenCore%20MES">Contact</a></span>
  </div>
</footer>`;
    const all = `${shell}\n${body}\n${footer}`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.description)}">
<meta name="theme-color" content="#2b303a">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:url" content="${ORIGIN}${path}">
<meta property="og:type" content="website">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="canonical" href="${ORIGIN}${path}">
<link rel="stylesheet" href="/site.css">
<script src="/glow.js" defer></script>
</head>
<body>
${bricks}
${iconsFor(all)}

${all}
</body>
</html>
`;
}

const names = readdirSync(new URL("pages/", SRC)).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5));
for (const [p] of PAGES) if (!names.includes(p)) throw new Error(`no page src/pages/${p}.html`);
for (const name of names) {
    const out = page(name, read(`pages/${name}.html`));
    writeFileSync(new URL(`${name}.html`, OUT), out);
    console.log(`site/${name}.html  ${(out.length / 1024).toFixed(1)} KB`);
}
