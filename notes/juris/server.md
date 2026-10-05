# Server area: notes for the contract (src/README.md)

Files changed: `src/server/http.js`, `src/server/kernel.js`, `src/server/page-cache.js`,
`src/server/minify.js`, `src/server/modules.js`. Tests: `tests/framework/server.test.mjs`.
`src/server/dev-reload.js` is unchanged.

## F21 (closed): `sendFile` closes the file when the client goes away

Section `server/http.js`, the `sendFile` bullet. Add at the end:

> The file is read through `stream.pipeline`, so it is closed however the answer ends: a client that
> goes away mid-download (a video seeking cuts the download it no longer wants) no longer leaves the
> read stream, and its file descriptor, open until the process runs out of them.

Same section, the `pack` bullet. Replace "`pack(text, { status })` gzips a body once" with:

> `pack(text, { status, gzip })` gzips a body once (`gzip: false` keeps no gzip, `gz: null`, for bytes
> that are compressed already; `send` then answers with the bytes whatever the client accepts)

## F22 (closed): `extra` may answer a promise

Section `server/kernel.js`, `createPagePipeline`, step 3 and the `render(url, viewer)` paragraph:
write `resolve(url, await extra(viewer), { viewer })` for `resolve(url, extra(viewer), { viewer })`.
The bullet "Every hook may return a promise" now holds for `extra` too; no other text changes.

## F23 (closed): timers Node cannot keep are refused; a job never runs beside itself

Section `server/kernel.js`, `createLifecycle`, the `jobs` bullet. Replace "an interval in
milliseconds" with:

> an interval, `every`, a whole number of milliseconds from 1 to 2^31 - 1 (about 24.8 days, the
> longest a Node timer keeps: a longer one fired every millisecond; a job wanted monthly runs daily
> and checks whether its day has come)

and add after "keeps its schedule;":

> a job never runs beside itself: a tick that comes while its previous run is still in flight is
> skipped, not reported as an error, and `skipped` (`{ [job name]: count }`) counts them;

The return value line becomes `{ serve(handler), start(), drain(), stop(), draining, skipped }`.

Same section, the `/healthz` text: "within `health.timeoutMs` (2000 unless told)" becomes "within
`health.timeoutMs` (2000 unless told; a whole number of milliseconds, 1 to 2^31 - 1, refused
otherwise when the lifecycle is made)". 0 is refused rather than read as "no limit": the bound is
what keeps a database that never answers from holding the balancer's question open.

Section `createJurisServer`, the `close()` paragraph: after "for at most `closeTimeoutMs` (8000
unless told)" add "(a whole number of milliseconds from 0, which cuts them at once, to 2^31 - 1;
anything else is refused when the server is made)".

## F24 (closed): the page cache

(a) Section `server/kernel.js`, `render(url, viewer)`, the bullet on the 404 and the title. Add:

> The route's own call counts as read by the page whatever its body calls: the kernel reads it for
> the status and the title, and its answer is in the page's state, so it is in the trace the cache
> decides on (its key in `calls`, its service in `services`, and the page is never `static`). A page
> titled from a service nothing in its body called was kept forever, or on no service, and a change
> to that service never evicted it.

(b) Section `server/page-cache.js`, the `createPageCache` bullet: "`put` refuses a page whose
services were invalidated while it rendered" becomes:

> `put` refuses a page whose services were invalidated while it rendered, and any page, a static one
> too, rendered across an `EVERYTHING` invalidation or a `clear()`

(c) Section `server/kernel.js`, `createPagePipeline`, step 6. Add:

> A viewer's page, like a `personal` one, is never put to the cache at all (`onRender` is told
> `{ cache: false, reason: "personal" }`): a refused put drops what the key holds, and every
> signed-in page view evicted the guests' copy of that page.

## F25 (closed): the minifier and the module server

Section `server/minify.js`. Replace the paragraph with:

> **Exports:** `minifyJs`, `minifyCss`, `jsTokens`.
>
> What a server sends browsers in production, made smaller and nothing else. Conservative by design:
> `minifyJs` removes comments, indentation and blank lines, collapses each run of whitespace to one
> character (a newline when the run held any of JavaScript's line terminators, `\r`, U+2028 and
> U+2029 included, which also end a line comment), and never looks inside a string, a template's
> text or a regular expression, so token boundaries and semicolon insertion come out as written; it
> never renames or folds anything. Whether a `/` begins a regex is read from the token before it and
> the brackets open around it: after the `)` of an `if`, `while`, `for` or `with` head and after a
> block's `}` a regex may follow; after an expression's `)`, an object literal's `}` or a property
> named like a keyword (`x.return`), it is division. `jsTokens(src)` is that reading, as tokens
> whose texts joined are the source (the module server's import stamping reads it too). One case
> is read wrong, and no one writes it: division right after a function or class expression's `}`.
> `minifyCss` also drops whitespace around `{};:,>` where it cannot matter and the `;` before a `}`
> (never inside a string), keeps the space before a colon wherever it was written (a descendant
> combinator, at the top level, in `@media` or nested in a rule), and drops a comment, leaving a
> space only between two characters of a name or a number (`.a/**/.b` is `.a.b`, as a browser reads
> it; `0/**/auto` is `0 auto`).

Section `server/modules.js`, "The code id and the stamps". Replace "`codeId` is a hash of the
snapshot and `build`" with:

> `codeId` is a hash of the snapshot, `build` and the transform (the module server's own version,
> which moves with any change to its stamper or the framework's minifier, and whether production
> minifies and with what: a custom minifier by its functions' source text), so a URL changes exactly
> when the bytes served under it can: a server upgraded under the same build and files once served
> new bytes under URLs browsers had kept as immutable for a year. A custom minifier whose source text
> stays the same while its behaviour changes (a wrapper around a library that was upgraded) needs a
> new `build`.

and replace "Every import a served module makes is stamped … however the source spaces them" with
the same text plus:

> Only code is read: a string, a comment, a regex or a template that spells an import is left as it
> is, and `import()`'s argument is stamped as a string or as a template with no substitution
> (`` import(`./b.js`) ``), which was left unstamped and loaded under a second URL. An `import()`
> inside a template's substitution is stamped.

Also "Section "A rolling deploy mixes two builds"" (the code id bullet, "`codeId` is a hash of the
snapshot and the build"): add "and the transform the server applies".

## Lower findings (closed)

Section `server/modules.js`, "Static files": after "while a font or a picture goes one way" add
"(and is never gzipped at all: it was, on its first request, which stalled the event loop and kept
it twice)".

Section `server/kernel.js`:
- `createPagePipeline(options)` returns `{ render(url, viewer), handle(req, res, url), close() }`:
  "`close()` begins no more stale pages' replacements (one scheduled and not yet begun hands its key
  back to the cache) and resolves once those under way have finished."
- the `close()` order: step 4 becomes "then the jobs stop, a run in flight finishing first, and the
  stale pages' replacements under way finish (none begins from then on)". A replacement renders with
  no request, so the server's close did not wait for it, and it could run after `onShutdown` closed
  the pool.

## The old README text that is now wrong

- `server/minify.js`'s header named `tests/framework/minify.test.mjs`; its cases are in
  `tests/framework/server.test.mjs` now (the header says so). If the README lists the framework's
  test files, add `server.test.mjs`.
