# Render area: notes for the contract

Files changed: `src/html-safety.js`, `src/ssr-renderer.js`, `src/dom-renderer.js`,
`src/server/document.js`. Tests: `tests/framework/render.test.mjs` (Node; the DOM side runs on a
small stand-in DOM inside the test file, which throws where a browser throws, e.g. `classList.toggle`
with a bad token).

## For the core agent (src/juris.js, src/client.js), not mine to change

- **`allowInnerHTML`**: both renderers read `this.juris?.allowInnerHTML === true`. It needs to be a
  constructor option (boolean, default false; refuse anything but true/false) and in `SHARED_OPTIONS`,
  so the kernel and `hydrate` give it to both sides alike (a server that draws innerHTML and a
  browser that refuses it would take the markup away at boot).
- **`client.js` has the same DOM-clobbering pattern as the document's loader**:
  `globalThis.requestIdleCallback ?? …` finds an element with `id="requestIdleCallback"` in a browser
  without the API (Safari), and calling it throws. Use `typeof requestIdleCallback === "function"`.
  (Already on the core list.)

## README changes

### "Safe by default" (What Juris does, first bullet)

Add `plaintext` and `style` to the list of refused tags, and innerHTML:

> Both renderers refuse a tag that runs code, loads a document or reaches the whole page (`script`,
> `iframe`, `object`, `embed`, `base`, `meta`, `link`, `style`, `plaintext`, SVG's `set` and
> `animate…`, SVG's `style` included), … and `innerHTML`, which is markup, unless the instance says
> `allowInnerHTML: true`. … An app widens this only by name (`allowTags`, `allowSchemes`,
> `allowInnerHTML`), for both sides at once …

"What it costs": replace "`innerHTML` is written as given, so it is for the app's own markup, never
data." with:

> `innerHTML` is left out unless the instance says `allowInnerHTML: true`; with it, it is written as
> given, so it is for the app's own markup, never data (a row spread into props, a row that lands in
> a child position, or a component that forwards `...rest`, such as `Link` and `Await`, carries it
> through). A `style` object's value that would end its declaration is left out.

### "Components and layouts"

- `innerHTML` bullet becomes:
  > `textContent` is text, always escaped. `innerHTML` is markup: both renderers leave it out (named
  > on the console in `devMode`) unless the instance is given `allowInnerHTML: true`, and then write
  > it as given, so it is for the app's own markup and never for data. `enhance` keeps its own rule:
  > inside an enhancement it throws unless the call says `{ allowHtml: true }`, which opens it there.
- `class`/`classList`/`style` bullet: add
  > A `classList` key is one or more class names, split on whitespace (`{ "btn active": on }`);
  > an empty key is nothing. A `style` object's keys are camelCase properties (`marginTop`,
  > `WebkitTransform`, `cssFloat` for `float`) or custom properties (`"--accent"`); `cssText` and
  > anything else is left out. A value is a string or a number with no `;`, `{`, `}`, `<`, `\`,
  > `/*` or control character (newline included); any other value is left out on both sides (named in
  > `devMode`), and on the client it takes off the value before it.
- Keyed lists: add
  > A keyed component whose root is not an element (it draws `null`, or text) keeps its place and its
  > state in a keyed list, as an element does.

### "html-safety.js"

Exports become: `safeAttributeName`, `allowedTags`, `safeTagName`, `checkTag`, `reusableElement`,
`checkInnerHTML`, `classTokens`, `checkStyle`, `allowedSchemes`, `safeUrl`, `checkAttribute`.

Add bullets:

> - `checkInnerHTML(allowed)`: refused unless `allowed === true` (the instance's `allowInnerHTML`).
> - `classTokens(key)`: a `classList` key's class names, split on ASCII whitespace, empty ones skipped.
> - `checkStyle(key, value)` answers `{ ok, name, reason }` for one style key: `name` is the CSS
>   property (`margin-top`, `--accent`, `-webkit-transform`, `float`), given whenever the key is a
>   property; `null`, `undefined` and `""` are a removal, never refused.
> - `reusableElement(localName, tag, allowed)`: whether the DOM renderer may take an element that is
>   already there as the one `tag` draws: the same tag, and one `checkTag` allows.

And in the refused-tags wording, add `plaintext` (the parser never closes it: the rest of the document,
state and loader included, becomes its text) and `style` (page-wide CSS from data: attribute-value
exfiltration through selectors and `url()`, `@import`); `allowTags: ["style"]` opens it.

### "dom-renderer.js"

Add:

> An element that is already there (server markup, a previous draw, what `enhance` adopts) is taken
> for a layout only when its tag is one the layout could draw (`reusableElement`): otherwise it is
> replaced (by the empty text node a refused tag draws), and `enhance` throws on an element, or a
> component adopting one, whose tag is refused unless `allowTags` names it. On an SVG or MathML
> element, `xlink:…`, `xml:…` and `xmlns`/`xmlns:…` attributes are set in their namespaces, as the
> HTML parser sets them.

### "ssr-renderer.js"

Add:

> An HTML `<style>` (drawn only with `allowTags: ["style"]`) writes its text as given, the CSS the
> parser reads raw, and is left out when the text contains `</style`; inside `<svg>` a `<style>`'s
> text is ordinary text and is escaped.

### "server/document.js"

"What escaping cannot make safe throws": add

> a `<meta http-equiv="refresh">` whose URL part (after the delay, `;` or `,`, an optional `url=` and
> quote) has a scheme the URL rules refuse (`javascript:`, `vbscript:`, `data:`, anything unknown);

and in the loader description:

> The loader uses `requestIdleCallback` only when it is a function (`typeof`), so an element with
> `id="requestIdleCallback"` cannot stand in for it where the browser has none.

### "Security defaults and invariants"

- The defaults, row "Unsafe tags and URL schemes are refused…": becomes "Unsafe tags (`style` and
  `plaintext` among them), `innerHTML`, and URL schemes are refused, on both sides; an app names what
  it adds (`allowTags`, `allowSchemes`, `allowInnerHTML`)". Test column: add
  `tests/framework/render.test.mjs`.
- Invariants, "Rendering and the browser", first bullet: add
  > `innerHTML` is refused unless the instance allows it; a `style` object's keys and values and a
  > `classList` key are held to one rule on both sides (`checkStyle`, `classTokens`); an element that
  > is already there is reused only for a tag the renderers would draw. `tests/framework/render.test.mjs`.
- Invariants: add "A `<meta http-equiv="refresh">` URL is held to the scheme rules; the loader is not
  fooled by DOM clobbering. `tests/framework/render.test.mjs`."
- "Open", "CSS from data": becomes
  > A `style` string, or an allowed value in a style object, can still make the browser fetch a URL
  > (`background: url(…)`): a value cannot end its declaration or start another, but `url()` is a
  > value. Build styles from objects with known keys.

## What to check in a real browser

The stand-in DOM holds the renderer's calls; these need the real thing (the browser suite):

1. `{ p: { innerHTML: '<img src=x onerror=…>' } }` mounted on a default instance: no `<img>` in the
   DOM; with `allowInnerHTML: true` it is there. `enhance(el, { innerHTML })` still throws; with
   `{ allowHtml: true }` it writes.
2. `{ div: { classList: { "btn active": true, "": true } } }`: mounts, `class="btn active"`, no
   exception; toggling the value off removes both.
3. `{ div: { style: { color: "red;background:red", cssText: "position:fixed", "--accent": "blue" } } }`:
   no `color`, no `position`, `--accent` set (getPropertyValue). Hydrate a server page with the same
   layout: the attribute the server wrote equals what the client leaves (no mismatch).
4. `{ svg: { children: [{ use: { "xlink:href": "#icon" } }] } }` drawn by the client shows the symbol
   (the attribute's namespaceURI is the XLink namespace), in Safari 15.4 too.
5. Keyed list with a component that returns `null` and keeps `useState`: reorder and re-render the list;
   the state survives and the definition is not re-run.
6. Server markup holding an `<iframe>` under an element given to `enhance(host, { children: [{ iframe:
   { src } }] })`: the iframe is replaced, no `src` written.
7. The loader in Safari (no requestIdleCallback) with an element `id="requestIdleCallback"` in the
   body: the app boots.

## Not done, and why

- `allowTags: ["script"]` still escapes a script's text in the SSR output (`a < b` becomes
  `a &lt; b`, which breaks the script), the same bug as `<style>` had. Not asked, and a script's
  raw-text rules (`</script`, `<!--`, `<script`) are subtler; the document writer's `rawText` is the
  model if it is wanted.
- `!important` in a style value: the DOM drops it on assignment, the server writes it. Harmless (it
  cannot add a declaration), so left as it is; the one rule could refuse `!` if the two should agree
  to the character.
- A string `style` is unchanged on both sides (the README's "CSS from data" says why it is the
  caller's).
- Enhancing an element whose own tag is refused now throws (`enhance(linkElement, …)` for a theme
  switch needs `allowTags: ["link"]`). Deliberate, per "reuse requires checkTag"; flagged for the
  README and for any app that enhances a `<link>`, `<meta>` or `<iframe>`.
