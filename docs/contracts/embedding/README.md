# `embedding` 1.0

A page of another site may show OpenCore MES in a frame beside its own content (a course beside the
plant it teaches, a work instruction beside the screen it is about) and talk to it by window messages.
The plant names the sites that may (`EMBED_ORIGINS`); no other site may frame it.

What an embedding page can do is small on purpose:

- **hear** where the person is: who is signed in, and each page they go to (its path and title);
- **ask that something be outlined** by the words a person sees on it (a button's, a link's, a tab's,
  a field's label, a heading), the outline the UI guides draw (DESIGN.md §33).

It cannot click, type, read a record or a form, or call a service: what a person does in the frame they
do themselves, under their own roles, and every write goes through the core's services as it does
anywhere else. Its words are matched against what is on screen, never the page's markup, so an
embedding page depends on nothing but what a person reads (§31: the internals are never a contract).

`schema.json` beside this file holds the same as data; `kit.mjs` checks a running instance.

## The setting

`EMBED_ORIGINS`: the origins that may frame OpenCore MES, comma-separated, each `https://host[:port]`
exactly (`http://` only for `127.0.0.1` and `localhost`). An address with a path, a query or a user
stops the start, saying which.

- **Unset** (the default): every page says `Content-Security-Policy: … frame-ancestors 'none'` and
  `X-Frame-Options: DENY`. Nothing may frame it.
- **Set**: every page says `frame-ancestors <the origins>` and leaves `X-Frame-Options` out (it cannot
  name a site). Sign-in works in the frame as it does outside it: the session cookie is `SameSite=Lax`,
  which a browser sends when both sites share a registrable domain (`trainings.example.com` framing
  `plant.example.com`). A site of another domain framing it would find the person signed out.

## Messages

Each message, both ways, is an object:

```json
{ "protocol": "opencore-mes.embed", "version": "1.0", "type": "outline", "label": "Submit for review", "kind": "button" }
```

A message whose protocol is another, whose major version is another, whose type is not listed here, or
whose fields do not fit, is ignored. OpenCore MES reads only messages from its parent window whose
origin is one of `EMBED_ORIGINS`, and sends to its parent only under each of those origins by name (the
browser delivers it to the one that is there).

### From the embedding page

| Type | Fields | What happens |
| --- | --- | --- |
| `hello` | | `ready` is sent again |
| `outline` | `label` (1–200 characters), `kind` (`any`, `button`, `link`, `tab`, `field`, `heading`; default `any`) | Every visible element of that kind named `label` is outlined (at most 40): exact names first, else names that begin with it. Case, runs of spaces and a trailing `:` or `*` do not count. A field is found by its label and outlined whole. The first is scrolled into view. It keeps looking every half second, since what it names may appear a moment later (a tab loading, a dialog opening), until `clear`, another `outline`, or another page. Answered by `outlined`. |
| `clear` | | The outlines go |

### From OpenCore MES

| Type | Fields | When |
| --- | --- | --- |
| `ready` | `viewer` (`{ id, name }` or `null`), `instance` (its name or `null`), `path`, `title` | Once the page has started; again on `hello` |
| `location` | `path`, `title` | Each time the person goes to another page of OpenCore MES (the outlines are cleared then) |
| `outlined` | `label`, `found` (how many are outlined; `0` means none yet, and it keeps looking) | In answer to `outline`, and again each time that number changes while it looks |

`path` is the page's path and query (`/designer/changes/42`); `title` is the page's title.

## A sketch

```js
const frame = document.querySelector("iframe");                 // src: https://plant.example.com/
const MES = new URL(frame.src).origin;
const say = (type, fields = {}) => frame.contentWindow.postMessage({ protocol: "opencore-mes.embed", version: "1.0", type, ...fields }, MES);
addEventListener("message", (e) => {
    if (e.origin !== MES || e.data?.protocol !== "opencore-mes.embed") return;
    if (e.data.type === "location") showStepFor(e.data.path);
});
frame.addEventListener("load", () => say("hello"));
say("outline", { label: "Designer", kind: "link" });
```

## How it may change

As every contract (`docs/contracts/README.md`): a minor version adds (a message, an optional field, a
kind); a major version may remove or change, after a minor one has marked it deprecated. OpenCore MES
reads any `1.x` message it knows and ignores the rest, so an embedding page written for a later `1.x`
still works where only part of it is understood.

## The kit

```bash
node docs/contracts/embedding/kit.mjs --url https://plant.example.com --origin https://trainings.example.com
```

checks that a running instance lets that origin frame it and nothing else, by the headers of its
sign-in page (`--page` names another page anyone may open; on a public demo, opening the sign-in page
makes the visitor a guest, as it does for anyone who arrives). It also
exports `checkMessage(message)`, which an embedding page's own tests use on what they receive.
