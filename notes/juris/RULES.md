# Rules for the Juris fix work (read before changing anything)

Repository: /Users/restiguay/dev/open-mes, branch `juris-fixes`. The framework is `src/`; its
contract is `src/README.md`. Node 24, plain JavaScript ES modules, no TypeScript, no build step.

1. **Own only your files.** Four agents work in this tree at once, each on its own set of files
   (listed in your task). Do not edit any other file under `src/` or `app/`. If a fix needs a
   change in a file you do not own, describe it in your notes file (below) instead.
2. **A failing test first.** For every fix, write a regression test in your own test file
   `tests/framework/<area>.test.mjs` (node:test + node:assert/strict), see it fail, then fix, see it
   pass. Import framework modules by relative path (`../../src/...`). No new npm dependencies. A fix
   that can only be shown in a real browser (DOM behaviour) gets a Node test where the logic can be
   reached (a pure function, the SSR side) and a clear note of what to check in a browser.
3. **The boundary** (`src/README.md`, "The boundary"): top-level `src/*.js` is served to browsers, so it
   imports nothing from `node:`, npm or `src/server/`, and uses no `Buffer`, `process` or `require(`.
   Nothing in `src/` reads `process.env`. No app vocabulary in `src/` (no lot, work order, MES, …).
4. **The browser floor**: Safari 15.4, Chrome 93, Firefox 92. No `structuredClone`, `findLast`,
   `toSorted`, `Object.groupBy`, `Promise.withResolvers`, lookbehind in regexes, static blocks, and so
   on, in top-level `src/*.js`. `Object.hasOwn`, `??=`, optional chaining are fine.
5. **Safe by default; compatible otherwise.** Keep the public API. Where a fix changes a default (a
   refusal that did not exist), the app opts back in by name, as the existing `allowTags` does.
6. **Match the code's style**: prose comments that say why, in the framework's voice (see any file),
   small and precise changes, no reformatting of code you do not change.
7. **Notes for the contract.** Everything the README must say differently (a new option, a new
   refusal, a changed default, a closed finding) goes into `notes/juris/<area>.md`: the section of
   `src/README.md` it belongs to, and the text to add or change. Do not edit `src/README.md`.
8. **At the end**: run `node --test tests/framework/<area>.test.mjs` and `npm test` (the app's suite
   must stay green), and `node --check` every file you touched. Report: each finding, what you did,
   the test that holds it, and anything you did not fix, with the reason.
