# Core: what `src/README.md` must say differently

Area: `src/juris.js`, `src/state-manager.js`, `src/router.js`, `src/forms.js`,
`src/remote-services.js`, `src/live-data.js`, `src/client.js` (unchanged: `component-manager.js`,
`storage.js`, `errors.js`, `clock.js`). Tests: `tests/framework/core.test.mjs`.

Each entry names the README section and the text to add or change.

---

## "Reserved state roots" (table)

- `$async` row, "What is under it": add at the end
  "; and `live.<path>`, each live path's `status` and `message` where no live client keeps them (a
  server, or a browser without one: `api.liveState`)". The async root is private and a server's
  `clearState` empties it, so this never reaches a page.
- `$live` row, "What is under it": add
  "; and `paths.<path>`, each live path's `status` (`"live"`, `"pending"`, `"failed"`,
  `"offline"`) and, while it is failed, its `message`, the path written as one segment
  (`pathSegment` in `state-manager.js`: `%`, `.` and `*` escaped), gone once nothing is subscribed
  there (`api.liveState`)".

## "The Juris instance"

- Options list: add `allowInnerHTML` (a boolean, `false` unless given; anything else refused with a
  `TypeError`) after `allowSchemes`.
- Add: "`privatePaths` and `asyncPath` name roots of the state: a name with a `.` in it (or an empty
  one, or a `privatePaths` that is not a list) is refused at construction with a `TypeError`. A
  nested name used to match no root, so what it named was serialised into the page as if it had
  never been given." (Nested private paths are refused, not supported: `serializeState` strips
  root keys, and stripping a leaf would mean copying the root.)

## "The component api"

- **Services** bullet: after the `live(...)` sentence add
  "`liveState(path)` says, tracked, whether what is at a live path is current: `"live"` (the latest
  answer is on screen, a preloaded one included), `"pending"` (subscribed, the first answer not here
  yet: what is shown is older, or nothing), `"failed"` (the subscribe was refused, or the server
  could not run the query again; or, with no live client, the call rejected), `"offline"` (the
  stream is down), or `null` where nothing is live; `liveMessage(path)` is a failed path's words, or
  `null`. On a server a preloaded live path is `"live"`, and so is the browser's first render of it,
  so the two draw alike."

## "Modules a browser downloads" → `juris.js`

- **Options both sides share** bullet: `(allowTags, allowSchemes, allowInnerHTML)`.
- **Preloaded answers** bullet, add: "Each answer is kept as the page carries it, a JSON round trip,
  so a component that writes under a preloaded answer during a render writes into the request's
  copy, never into the object the service answered (which a service that caches, master data, hands
  every request). An answer JSON cannot carry (a cycle, a `BigInt`) is recorded as that call's
  failure. `renderRequest` copies the plain objects and arrays of the `state` it is given, for the
  same reason (other values, a `Date` or a class instance under `$server`, are kept as they are)."
- Add a bullet **Live status**: the `liveState` text above, plus: "Without a live client (a server,
  or a browser booted with `live: false`) `live()` is one call whose answer is assigned; only the
  latest call at a path writes it, so an older answer that arrives late (the arguments moved, or on
  a server it belongs to a request already rendered) is dropped rather than assigned over the newer
  one. A service that answers synchronously is taken too."

## "Modules a browser downloads" → `state-manager.js`

- Exports: add `pathSegment` and `MAX_ERROR_LOG`.
- Add: "`pathSegment(text)` makes any text one segment of a state path (`%`, `.` and `*` escaped,
  `__proto__` escaped whole), distinct texts giving distinct segments; the live status is kept under
  it. The async error logs (`errors` under the async root, and each group's) keep the last
  `MAX_ERROR_LOG` (50) entries: in a browser they used to grow for the life of the page. The async
  counters never go below 0."

## "Modules a browser downloads" → `router.js`

- **URLs** bullet, add: "A path starts with exactly one `/`: a backslash is read as `/` (as a
  browser reads it, and as the kernel's `canonicalPath` does), a tab or a newline is dropped (a
  browser drops them from a URL), and leading slashes collapse to one; so no target the router
  answers (`resolve`'s `redirect`, `resolveTarget`, `link().href`, a navigation) can name another
  host. `/\evil.com`, `\\evil.com` and `//evil.com` all answer `/evil.com`; `/%5Cevil.com` stays a
  path."
- **Options** bullet: "`routePath` is a root of the state: a name with a `.` is refused."
- Add: "**Booting on a transferred route.** The browser adopts the route the server rendered; where
  it is the address bar's path, the address bar's query and `#fragment` are kept (the server never
  sees the fragment, and a cached page was rendered from its cache key without the query parameters
  it does not read), so the first URL write no longer replaces them away."
- Add: "`Link`'s `href` follows the route (it is bound, and reads `$route.path`), and a click goes
  where the href says when it is clicked: a target resolved against the current route (a name whose
  params come from it) used to be resolved once, and `RouterView` keeps a page's instance when only
  its params change."
- Add: "In hash mode the route is compared with the address's fragment alone, so navigating to where
  the tab already is pushes no entry."

## "Modules a browser downloads" → `forms.js`

- Add: "A service that answered is a success: `onSuccess` throwing, or rejecting, goes to the
  console, never to `<path>.error` or `onError` (it used to read as a failed save, and the user
  saved again)."
- Add: "`reset()` clears `submitting` too, so a submit that never answers does not leave the form
  refusing every submit; the answer of a submit made before a `reset()` then leaves the form's
  state alone (`onSuccess` or `onError` is still told). The stubs' `timeoutMs` (below) ends such a
  call on its own."

## "Modules a browser downloads" → `remote-services.js`

- `remoteServices` bullet: `remoteServices(names, { base = "/api", fallback, fetch, timeoutMs =
  30000 })`, and add: "`timeoutMs` is how long a call (its answer and its body) may take, whole
  milliseconds from 0 (no limit) to 2^31 − 1, anything else refused with a `TypeError`; a call that
  takes longer is aborted and rejects with a `ServiceError` of status 408, code
  `request.timeout`, and the words "The request took too long; it may or may not have been
  applied.". A 2xx answer whose body is not JSON rejects with a `ServiceError` of status 502, code
  `response.not-json` (`fallback`'s words): it used to resolve `{ error: "200 OK" }`, so a captive
  portal's page read as saved. The dispatcher always answers JSON."
- `sseClient` bullet, `statePath`: add "`.paths.<path>`, each live path's status (see `liveState`
  in "The component api")". `onError`: add "and the path's status is `"failed"` with the same
  words, as it is when the server could not run the query again (a patch with `error`), until the
  next answer". Add: "The transport's `subscribe(key, name, args, path, { seeded })` takes whether
  the preload's answer is already on screen (then the path starts `"live"`); every path it keeps is
  `"offline"` while the stream is down (an error, a reopen, `close()` with paths still subscribed),
  `"pending"` again from the hello that brings it back until the new full answer. `dispose()` also
  removes every status it kept."

## "Modules a browser downloads" → `client.js`

- "`juris` is the instance's own options, `{ allowTags, allowSchemes, allowInnerHTML }`".

## "Modules a browser downloads" → `live-data.js`

- Add: "The getter both helpers answer carries `path`, `state()` and `message()`, tracked reads of
  `api.liveState(path)` and `api.liveMessage(path)`: between a change of arguments and the new
  answer the last route's data stays on screen and `state()` is `"pending"`, and it is `"failed"`
  for good when the new answer is refused, where it used to be shown under the new route with no
  mark at all."

## "What the server and the browser are given alike"

- `{ allowTags, allowSchemes, allowInnerHTML }`: "the tags and URL schemes both renderers draw
  beyond the ones they allow (`html-safety.js`), and whether a layout may set `innerHTML` (a
  boolean, off unless given)".

## "One server instance, every request"

- Add: "The async counters belong to the request too. On a server `clearState` resets them, each
  group's included (a server render awaits nothing between `clearState` and `serializeState`, so
  nothing of the last request is in flight), and a promise counted before it settles into nothing:
  a promise one request tracked, or one that never settles, used to keep every later request's
  `Await` on its fallback. A browser carries its counters across a clear, as before."
- Add: "A preloaded answer and the state a request is rendered with are the request's own copies
  (see `juris.js`), so a service's cached object is never written by a render, nor carried into the
  next request's page."

## "Security defaults and invariants" → "The invariants"

- **Rendering and the browser**: add "- No target the router answers names another host: a
  backslash is a slash, and a path has exactly one leading slash (`resolve`'s redirect,
  `resolveTarget`, `link().href`). `tests/framework/core.test.mjs`."
- **Requests and responses** (or "One server instance"): add "- A server's `clearState` resets the
  async counters, and a preloaded answer or a request's state is copied, so no request's data or
  pending work reaches another. `tests/framework/core.test.mjs`."
- Add: "- `clearState` skips an own `__proto__` key in the state it is given, so a parsed state
  cannot set the root's prototype. `tests/framework/core.test.mjs`."

## "Not yet" → "One release's leftovers"

- Nothing listed there changes, but note in `remote-services.js` that the old reading of a non-JSON
  2xx (resolving `{ error }`) is gone: it is a rejection now.

## Browser checks (Node reached the logic with fakes; these want a real browser)

- `client.js` `whenIdle`: in a browser without `requestIdleCallback` (Safari) and a page with an
  element `id="requestIdleCallback"`, the boot finishes and prefetches the routes' code after
  ~1.2 s. Held in Node by a source check only.
- The router's boot (F8) and hash-mode comparison were held with a fake window/history; in a
  browser: open `/page?utm=1#section` of a server-rendered page, and the address bar keeps both
  after boot; in hash mode, clicking a link to the current route adds no history entry.
- `Link`'s bound `href` in the DOM renderer: on `/items/1`, a `{ Link: { to: { name: "edit" } } }`
  updates to `/items/2/edit` after navigating to `/items/2` (the Node test holds the binding).
- The live status with a real `EventSource` (Node used a fake).
