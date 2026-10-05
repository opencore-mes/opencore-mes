# OpenCore MES: the application

A thin vertical slice of the design on Node 24, PostgreSQL and Juris (`src/`). Plain
JavaScript, no build step.

## Run it

```bash
npm install
npm run db:reset      # creates database openmes_poc (local socket) and loads the seed
npm run dev           # http://127.0.0.1:9090, and every address of this machine (PORT=… for another port, HOST=127.0.0.1 for this machine only)
npm test              # policy engine, rule pipe, runner, audit hash
npm run test:all      # the whole pipeline: syntax, unit, and end-to-end against a fresh test database
```

**The test pipeline** (`tests/pipeline.mjs`) is what to run before pushing, and what CI runs on every
push (`.github/workflows/test.yml`, PostgreSQL 16, Node 24). It resets `TEST_DATABASE_URL` (default
`postgres:///openmes_test`) and refuses any database whose name lacks "test", starts a server of its
own, and runs every suite. It stops at the first failure and prints its output. `-- --quick` runs
the stages that need no database; `-- --full` adds a short load test. The replica and cluster checks
stay manual (below).

`DATABASE_URL` overrides the database (`postgres:///openmes_poc` by default).

**The database upgrades itself.** At every start the server runs what is new or changed in
`app/mes/db/migrate.mjs` (each migration recorded with its file's checksum, under one lock, so several
instances run it once). There is nothing to run by hand after pulling a change; `npm run db:migrate`
does the same without starting a server. `npm run dev` restarts when any file under `app/mes` or `src`
changes, a migration's SQL included, so it applies at once.

Settings can go in a `.env` file at the repository root (copy `.env.example`; `.env` is never
committed). `npm run dev` reads it (`--env .env`, read by the server itself) and runs under
`node --watch`: a change to the server, the framework or the client modules restarts it, and every
open page reloads by itself; after a change to `.env`, stop it and start it again. A change
to what only browsers load (`app.css`, `boot.js`, `rule-worker.js`) reloads the pages without a
restart.

**Suites** (proprietary add-ons) are installed as folders under `suites/`: unpack one
there (or link its repository) and restart; its navigator entries, pages and tables appear by
themselves. `suites/` is never committed here.

A **training instance** runs beside this one on the same machine, blank (people only; every model is
designed in the course) and on a database of its own: `npm run training:reset`, then
`npm run training` (port 9091, its own sign-in cookie, "TRAINING" on every page). TRAINING.md says
more.

Sign in by picking a seeded user (the development picker: no password, and only in development and on
the demo). In production people sign in through the plant's identity provider (OpenID Connect), its
directory (LDAP or Active Directory), or a password of their own, whichever the environment turns on
(see "Sign-in" below). Under each name, what waits for
them in the designer: "1 to sign" when they are a department's next approver on a change, "1 to review"
when they may review one (hover for which):

| User | Department | Roles |
| --- | --- | --- |
| Olga Ortiz | Production | lot operator, work order operator, deviation reporter, machine operator; runs the four machine transactions |
| Sam Lee | Production | lot supervisor, work order planner, machine maintenance |
| Quinn Park | Quality | lot quality, work order viewer, deviation quality |
| Vera Novak | — | lot and work order viewer; design reviewer (validation) |
| Dana Reyes | Engineering | designer |
| Eli Brandt | Engineering | reviewer |
| ERP integration | — | work order planner, lot viewer: an integration user, for services (below) |
| Ivan Kim, Ines Ortega | IT | design reviewers; IT approves in two steps: Ivan (Specialist), then Ines (Manager) |
| Iris Hale | IT | designer and reviewer, analyst, sign-in administrator; reads every record (§27.7), writes none; designs services and connections with the copilot; not IT's approver |

Sam, Quinn and Eli are reviewers, and the representatives of Production, Quality and Engineering who
approve for them (Dana represents Engineering too, but never approves their own change). Whoever passes
the review cannot approve the same change, so a change that needs all three departments is reviewed
by Vera, who represents none. A new object is
stewarded by the department of its area, not by its author's.

## What it shows

| Design | Where |
| --- | --- |
| No schema in advance (§6): objects, fields, states, roles, policies and rule pipes are JSON rows in `mes.definitions`; records are JSONB in one partition per object | `db/schema.sql`, `db/seed.mjs` |
| Deny-by-default policies on the record's state and type, per field and per action; explicit deny; `$perm` with reason codes (§9) | `server/policy.js` |
| "Why can't I?" answered from the decision trace, hiding what the reader cannot see (§9.7) | `access.explain`, the record's **Why?** tab |
| Rule scripts (§12): file name = function name, context in / context out, throw to reject, declared writes, fixed clock | `client/pipe.js`, `server/rules.js`, `db/seed.mjs` |
| The same pipe on every change in the browser (a Web Worker, advice) and on save/action at the backend (the decision) | `client/rule-worker.js`, `client/records.js` |
| One write shape (§11.4): session, idempotency key, row version, rights, pipe, validation, write, audit | `server/services.js` |
| An installable app (§14): manifest, icons and a service worker that never keeps live data (pages go to the network first, `/offline.html` when it cannot be reached). Every page names its build and reloads itself when `/version` says the server has moved on: at once if nothing is being edited, otherwise once the edits are saved or discarded (a banner says so). Installation and the offline page need HTTPS on a network: `TLS_CERT=… TLS_KEY=… BACKENDS=127.0.0.1:9090 node app/mes/lb.mjs` | `pwa/`, `client/updates.js`, `lb.mjs`, `test/pwa.mjs`, `test/updates.test.mjs` |
| Attachments (§34.10): the analytics copilot and the design copilot read files given with a question (pictures as images, PDFs as documents, CSV files and workbooks as their rows; at most five, a picture 5 MB, a document 10 MB); a kept prompt keeps its files and is given them each time; a report's media block shows one (a picture drawn, a document to open or save). The file store keeps each by what its bytes are (PNG, JPEG, WebP, PDF, CSV, xlsx: nothing that could run), serves a document only as a download, under a name made safe; an image field holds only a picture. Conversations keep the files' names, never their bytes | `server/blobs.js`, `server/attachments.js`, `client/attach.js`, `test/attachments.test.mjs`, `test/attachments.mjs` |
| Charts (§34.9): one contract for every chart, a report's chart block (the AI's or a person's), a screen's chart block and the analytics page: twenty kinds, which columns of the query go where, reference lines and bands, units; checked in words, drawn only from the query's rows as the viewer reads them. Drawn by Apache ECharts (Apache-2.0, an npm dependency; its browser module served at `/vendor/echarts.js`, loaded with the first chart; no CDN), in SVG, in the theme's tokens, tooltips as text, never HTML. No record id is ever shown: every answer a person or the copilot reads names each record by its title (`server/titles.js`) | `client/charts.js`, `client/chart-view.js`, `server/titles.js`, `test/charts.test.mjs`, `test/charts.mjs` |
| Excel import and export (§24): `/transfer` and **Export** above each list. Export: a tab per model, plus the records they refer to in their own tabs, references as keys, an `_about` tab. Import: any number of model tabs, in dependency order, previewed then applied, each row through the record services (policies, rule pipe, audit); each model's design says whether import may create, update and by which key. A row whose record changed since the export (its `row_version`) is refused rather than written over; a tab exported from another version of its model is reported with how its fields changed. No library: `server/xlsx.js` | `server/xlsx.js`, `server/transfer.js`, `client/transfer.js`, `test/transfer.test.mjs`, `test/transfer.mjs` |
| People & departments (§27): the organization as one design element (people, departments with members and ordered approval steps, groups, role assignments, governance, standing approvers), changed through a change request approved by whom it affects, and written to the tables at execution. Departments approve in steps (IT: Specialist → Manager), each by a different person; standing approvers join every change of a kind (IT on connections and services). Seed: IT (Ivan Kim, Ines Ortega) | `server/organization.js`, `client/organization-editor.js`, `test/organization.mjs`, `test/organization.test.mjs` |
| Dates, times and numbers (§27.6): the plant's formats (date format, 24/12 hours, locale for numbers, first day of the week, time zone) set on People & departments' **Formats** tab and approved by governance; every page reads and writes them through one module, date fields take the plant's format or a calendar, and nothing stored changes | `client/format.js`, `test/format.test.mjs`, `test/formats.mjs` |
| Themes (§10.8): every colour a token, light and dark; a state's tone (ok, warn, danger, info, neutral) in its object's design, never a colour; the plant's theme in People & departments (name, label, colours checked for contrast, and light or dark for everyone, or each person's choice), written into the page before its first byte | `client/theme.js`, `client/app.css`, `client/shell.js`, `client/organization-editor.js`, `test/theme.test.mjs`, `test/themes.mjs` |
| Dialogs (§10.6): one modal at a time from any screen, `confirmDialog` / `askDialog` (text, number, date or a choice; required; a check), focus kept inside, Esc cancels, Enter confirms, focus restored; used for archive, reload with unsaved edits, reject and ask-for-changes (a reason required), withdraw, taking a review back | `client/dialog.js` |
| Lists as they scroll (§10.1): an object's list 50 at a time, more as its end comes into view, each page live; the database pages, sorts (the definition's `list.sort`) and filters over every record, with the person's rights compiled into the query, so screens' numbers and breakdowns are exact and an old record is found at any size; indexes by last change, state, the record's JSON and its text (`pg_trgm`); text sorts with numbers in number order (`client/sort.js`); screen tables hold up to 1 000 rows and draw 25 at a time | `server/services.js` records.list, `server/record-sql.js`, `db/migrate-record-indexes.sql`, `client/records.js`, `client/sort.js`, `test/lists.mjs` |
| Screens (§26): pages composed of fixed blocks (record, table, number, breakdown, an embedded transaction, text), each a design element opened at `/s/<name>[/<value>]` with at most one parameter (a machine, scanned). Every block reads with the viewer's own rights; a table's row buttons run transactions inline; live on every record write; a draft previews with the designer's rights. Seed: **Work centre** and **Shop floor**. A design may let its page fill the window (`maximize`: a Maximize button, or opening so), hiding the navigator, top bar and tabs on a tablet or a board. Any screen opens as a dialog over the page (a button block, or a pop-up); a pop-up opens a screen by itself over a transaction, a screen or every page, for the people named, while its condition holds over the page, and closes when it stops holding (`popups.for`, live); it decides nothing | `server/screens.js`, `client/screen.js`, `client/screen-editor.js`, `test/screens.mjs`, `test/screens.test.mjs`, `test/popups.mjs` |
| Transactions (§25): screens that change several records as one, all or nothing, each a design element (inputs laid out as a form, checks, steps, where it appears, callers, stewards). Each step goes through the target object's state machine, policies, rule pipe and audit as the person, with `via` naming the transaction; a policy with `via` grants only through it, so the lot's form never offers Move in. Every record named is locked and re-checked in one database transaction; a preview shows what will change. Seed: a `machine` object, the lot's machine states and **Move in / Track in / Track out / Move out** (a one-lot press, a four-lot oven); the test designs a combined **Start** through the lifecycle, and an AI drafts one over the REST API. A design may let its page fill the window (`maximize`: a Maximize button, or opening so), hiding the navigator, top bar and tabs on a tablet or a board | `server/transactions.js`, `client/transaction.js`, `client/transaction-editor.js`, `test/transactions.mjs` |
| Kept prompts (§34.7): on the AI Report page, what a person asks the analytics copilot is kept under a title, asked again or changed, and asked by the clock as that person (a schedule, at most once an hour); each generation is kept as a report of theirs. Kept reports are picked for the copilot to work from (a summary of several), and filed under tags that filter the list (§34.8). | `server/reports.js`, `db/migrate-report-prompts.sql`, `client/reports.js`, `test/report-prompts.mjs` |
| A model file (§24.1): **Designer → Export or import the whole model** (`/design/model`). Export: every published design and, object by object, its records or nothing (the person chooses which go empty), as one JSON file; what the person may read, no secrets, people or history. Import on another installation: previewed, then its designs as one change request (review and approval there), then its records through the record services once that change has executed. `GET /model-file/export`, `POST /model-file/preview`, `/model-file/start`, `/model-file/records`; for an AI, `/ai/v1/model`. | `server/model-file.js`, `client/model-file.js`, `test/model-file.mjs` |
| Approval of record changes (§28): an object's design says which changes to its records, made outside a transaction (a form, a list, an Excel import), wait for approval: some fields in some states, new records, some actions. Saving asks why; the change waits as a request shown on the record and on Approvals, signed by the stewards of what it changes in their departments' steps (never the requester), then applied as the requester with every check, or void if the record changed meanwhile. Transactions and designed services never wait | `server/record-requests.js`, `client/requests.js`, `test/record-approval.mjs` |
| Suites (§29): products built on OpenCore MES, installed as folders under `suites/` (never committed here) and found at start: their services, live queries, HTTP handlers, jobs and migrations (named after them), their pages, components, stylesheets and navigator entries (as data), each handed what it may use and importing none of the platform's files. The pipeline runs each installed suite's tests. An open fixture proves the contract | `suites.mjs`, `client/app.js` (`withSuites`), `client/boot.js`, `test/suites.mjs`, `test/fixtures/suites/hello/` |
| Queries (§23): SQL or JSON at `/query`, with a schema explorer, over views of the objects (`q.lot`, `q.lot_stays`, …) with each object's policies compiled in, so a query shows what the person's forms would. It runs as the `mes_query` role (the views only), as one statement, with its plan checked, a time, row and size limit, for people with the `analyst` role on `query`. The database upgrades itself (see below) | `server/query.js`, `client/query.js`, `test/query.test.mjs`, `test/query.mjs` |
| AI reports, their layouts and the analytics copilot (§34): a report is data (text, figure, chart and table blocks, each with its query), kept as a record of the built-in Report object and shared by its author; opened at `/r/<id>`, its queries run as whoever opens it, over the views of §23, so it shows each person what their own policies do. Charts are SVG drawn from the data (bar, line, pie). On `/reports`, people with the `analyst` role ask a copilot that reads the schema, runs read-only queries as them (audited) and draws a report; it changes nothing, and the person keeps and shares. A **report layout** (§34.5) is a design element (the Designer's Report layouts tab, approved by its stewards): which blocks a report has, in which order, how wide, and what each is for, with no query. The person asking picks one; the copilot is told it, a report that departs from it is refused, and one that follows is drawn at the layout's widths and titles. A layout's **AI assisted line** block (§34.6) names a set of records the designer picks (a line's equipment) and a goal in words: the copilot advises what to do with them (what to process first, and why) and lists the rows to act on; it acts on nothing. A kept prompt may be pinned to one of its reports (§34.11): each run runs that report's queries again as its owner, its words kept or written fresh by the copilot; a designer makes a report layout from a report (a change holding its blocks, no query) | `client/report.js`, `client/reports.js`, `client/layout-editor.js`, `server/reports.js`, `test/report.test.mjs`, `test/reports.mjs`, `test/report-pinned.mjs` |
| Rolling a change back (§5.14): on an executed change, the platform drafts the change that puts back what it changed (each design as it was before, as a new version; what it created retired; what it retired published again), leaving alone, and saying so, what was changed again since. Its conflicts are found by applying it in a sandbox and checking everything published there together; one with a conflict is not submitted. As drafted it is not reviewed again and one approval, not its author's, executes it; edited by hand it is a change like any other. Values records hold in a field it takes back are kept, unseen | `server/design.js`, `server/sandbox.js`, `server/fitness.js`, `client/rollback.js`, `db/migrate-rollback.sql`, `test/rollback.mjs` |
| The test sandbox (§5.13): the installation's shared pre-production copy, a small database of its own holding what is published plus every change under test, applied in a set order and checked as at execution, so changes not yet approved see each other. People enter as themselves, with the same roles, on a port of its own (`TEST_SANDBOX_PORT`, the live port + 1000; `TEST_SANDBOX_URL` behind a proxy); records made there are kept across a rebuild. Each change records what it was tested with. Nothing in it reaches the live database; approval is unchanged | `server/sandbox.js`, `client/test-sandbox.js`, `db/migrate-test-sandbox.sql`, `test/test-sandbox.mjs` |
| Routes inside routes (§32.14): a route's sub flow node runs another route for the same traveler, as a child run; the lot's step is the sub route's while it is inside, the innermost step decides what is offered, and the route goes on when the sub route ends. A route marked to run only inside another takes up no traveler by itself and is tried through the routes that run it; a lot inside finishes on the version it entered | `server/flows.js`, `client/definition.js`, `client/flow-editor.js`, `db/migrate-sub-routes.sql`, `test/flows.mjs`, `test/flows.test.mjs` |
| Floor layouts, pictures and image fields (§35): a screen block draws records where they stand on an uploaded picture of the floor (places as fractions of it, named by what the records are called), each with its own picture (an image field of it, or of the record a reference names: its model) and a small square in the colour of its status (the state or a field; a legend of the theme's colours), read with the viewer's rights and live. Arranged in the designer by dragging the records and their squares. Pictures are kept by the SHA-256 of their bytes (`POST /blob`, `GET /blob/<sha256>`): PNG, JPEG and WebP by their first bytes, never changed or deleted. A field of type `image` holds one | `client/floor.js`, `client/floor-view.js`, `client/floor-editor.js`, `client/picture.js`, `server/blobs.js`, `server/screens.js`, `test/floor.test.mjs`, `test/floor.mjs` |
| Analytics, phase 1 (§22): every create, transition, archive and restore records the record's stay in its state (`mes.state_intervals`), with the object's analytics dimensions as they were; `node app/mes/db/rebuild-intervals.mjs` rebuilds them from the audit trail. A record's **Timeline** tab; an object's **Analytics** page: records in each state now, time in each state, lead time between two states, entries per day, week or month, by a dimension. The database upgrades itself (see below) | `server/analytics.js`, `client/analytics.js`, `test/analytics.test.mjs`, `test/analytics.mjs` |
| Schedules and the integration monitor (§15.3): a service's trigger can be a schedule (every N minutes or hours, times of day, weekdays, a window, a time zone, daylight saving handled), or one whose times an installed suite works out (a kind of schedule it adds, §30.11; with the suite removed nothing is planned for it and the monitor says which suite it needs), edited on the Triggers tab with a preview of the next runs. Runs are planned into the outbox once per time due however many nodes plan (`SCHEDULER=0` opts a node out); `NODE_TAGS` and a service's `runOn` keep its runs to tagged nodes. A run reads the last successful run's output; missed runs, overlap, paging, pause, resume and run now. `/design/integration` shows nodes, schedules, inbound web services, outbound connections and record triggers. The database upgrades itself (see below) | `client/schedule.js`, `server/integration.js`, `client/integration-monitor.js`, `test/schedule.test.mjs`, `test/scheduler.mjs`, `test/suite-extensions.mjs` |
| The event log (§7.6): each instance writes what happens to the system (start, stop, crash, an unclean stop found at the next start, the database down and back as one incident with the calls it refused, each save with an unknown outcome, a trigger given up on) to `.local/events/event.log` first, hash-chained, and a job copies it into `mes.event_log` once the database takes it. `EVENT_LOG_DIR` moves it. The database upgrades itself (see below) | `server/event-log.js`, `test/event-log.test.mjs`, `test/outage.mjs` |
| A write-database outage (§11.4): a gate refuses calls at once, in words, while the database is unreachable, and says when a save's outcome is unknown (COMMIT sent, never answered). The browser keeps one idempotency key per submission, so **Send again** never saves twice; a banner shows the outage and saving is blocked until it is back. `status.db` and `/healthz` report it | `server/db-gate.js`, `client/db-status.js`, `test/outage.mjs` |
| Archiving (§7.1, §11.1): `records.archive` / `records.restore` take a record out of use and back, never deleting it. A grant of its own (`record.archive`), the object's whole rule pipe (`event.kind` `archive` / `restore`), audited, a trigger event, and `ctx.records.archive/restore` for services (`uses.objects: archive`). An archived record is read-only and leaves the lists (**Show archived** brings them back). Seed: Sam (lot supervisor) archives lots on hold or consumed; `lot_archive_checks` refuses one whose disposition is undecided. The database upgrades itself (see below) | `server/services.js`, `server/policy.js`, `test/archive.mjs` |
| Hash-chained, append-only audit, rejected attempts included (§7.3) | `server/audit.js`, the **History** tab |
| One shell (§10.1): searchable navigator, favorites, tabs kept per user | `client/shell.js` |
| Live lists and forms: a change by one user reaches every open screen | Juris live queries, `touches` in `server/services.js` |
| Search across every object's records from the navigator's box; a hit counts only on a field the user may read | `records.search` |
| Presence: a record shows who else has it open, and warns when one of them is editing it | `server/presence.js`, the `Presence` banner |
| The designer (§10.5): objects, fields, states, transitions, roles, policies, rule pipe and scripts, layout, a live preview, stewards, raw JSON; up to three windows side by side on one change, all editing the same draft; presence on change requests | `client/designer.js` |
| Form layouts (§10.4): tabs, sections that fold, a 12-column grid, a widget per type (radio, buttons, checkbox list, multi-select, chips, toggle, search, stepper…), help and placeholders, **Shown when** / **Enabled when** conditions, a field's **Required when** (checked by the server too) and **several values** for an enum (records converted when it flips). Arranged on the designer's **Layout** tab by dragging cards | `client/form-layout.js`, `client/records.js`, `client/designer.js`, `test/form-layout.test.mjs`, `test/forms.mjs` |
| Version compare (§5.3): review and approval open on **Changes**, every difference from the published version with the two versions line by line; the tabs count their differences and highlight new and changed fields, policies and layout cards; the same for services and connections | `client/compare.js`, `test/compare.test.mjs` |
| The change lifecycle (§5): design → review → approval → execution; the content frozen and hashed at submit; the author never reviews or approves; execution by the platform only, all or nothing | `server/design.js` |
| Scope-based approvers (§5.6): the footprint of the draft, computed as the designer types, decides which departments' representatives approve | `client/definition.js` |

Designer: sign in as Dana (designer), open **Designer**, press **Change** on Lot, add a field on the
Fields tab and watch **Will need approval from** follow the stewards; give a reason and submit. Eli
(reviewer, representing neither department concerned) passes the review; Sam approves for Production
and Quinn for Quality, and the platform executes it: Lot v2 is live on every form. (Sam cannot both
review and approve: whoever reviews a change never approves it.) The full course is in
[TRAINING.md](../../TRAINING.md).

Try it: as Olga, open lot 4712 and type a negative quantity (the browser's pipe refuses it as you
type), then 5000 and save (the backend's `lot_check_qty` refuses it: 5% over the work order). Open lot
4711 (released) and ask **Why?** on Quantity. Sign in as Quinn in another browser, change a
disposition, and watch Olga's screen follow.

## Not built yet

- **Parts of the lifecycle (§5):** no emergency route, no effective time, no post-execution
  verification, no data migrations (a change that removes or retypes a field holding data is
  refused).
- **E-signatures (§7.4)**: an approval is recorded with its meaning and the content hash, but without
  re-entering credentials. Password ageing and SAML (§8.2). Groups beyond departments, scopes (site/area/line).
- Decision tables.
- Decimals are JSON numbers here; the design stores exact decimals.

## Sign-in

Who may sign in is People & departments' to say: an active person there, nobody else. How they prove it
is set in the environment (`server.mjs`), any of these together:

| Way | Turned on by | Notes |
| --- | --- | --- |
| Single sign-on (OpenID Connect) | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Register `https://<this site>/login/sso/callback` (or set `OIDC_REDIRECT_URI`). The sign-in id is the `preferred_username` claim, or `OIDC_CLAIM`. Multi-factor is the provider's. |
| The plant's directory (LDAP, AD) | `LDAP_URL=ldaps://dc.plant:636`, `LDAP_USER_DN` | `LDAP_USER_DN="{user}@plant.local"` for Active Directory, `"uid={user},ou=people,dc=plant,dc=example"` for OpenLDAP; `LDAP_CA_FILE` for a plant CA. |
| A password of their own | on unless `PASSWORDS=0` | IT gives a one-time link: `node app/mes/db/password.mjs olga --url https://mes.plant`. The person sets it there, and changes it from their name at the top right. |
| The picker | development, the demo, or `PICKER=1` | Anyone as anyone. Never on an instance others can reach. |

**The plant's policy** (a regulated plant's by default; none of it on a picker instance):

| Setting | Default | What |
| --- | --- | --- |
| `SIGN_WITH_PASSWORD=0` | on | Every signature (a transaction signed, a change or record change approved) asks the signer's password, or a fresh single sign-on (`prompt=login`) |
| `PASSWORD_MAX_DAYS`, `PASSWORD_HISTORY` | 90, 5 | A password of its own, and a signing password, expire; a new one may not repeat the last few |
| `MFA` | `optional` | `required` or `off`: an authenticator app's code after a password sign-in (theirs or the directory's), with recovery codes |
| `SESSION_IDLE_MINUTES` | 30 | A session with nothing done for this long ends (12 hours in any case) |

Sign-in administrators (the role *administrator* on *Sign-in* in People & departments; Iris in the seed)
issue password links, reset second factors, lift locks and end sessions on **Design → Sign-in
administration**, and see ids locked and password spraying there and in their inbox. A token for an
integration lasts `--days` (90 by default, at most 365): `node app/mes/db/token.mjs erp "ERP" --days 365`.

**Trying single sign-on**: `npm run sso:sim` runs an OpenID Connect provider for development and training
(never production; `app/mes/sso-sim.mjs`): start OpenCore MES with `OIDC_ISSUER=http://127.0.0.1:9095
OIDC_CLIENT_ID=open-mes PICKER=0`, and sign in as a seeded person with the password `sso-sim` (`--mfa`
asks a code too, `--users people.json` other people).

**A desktop's page.** A record of the built-in **Desktop** object maps a computer's IP address to the
screen or transaction it is for (load them from Excel: Data → Import / export, a tab named `desktop`
with `name`, `address`, `opens`, `page`). Whoever signs in from that address lands on that page,
filled, with Restore beside it. Behind a proxy (Caddy, or the balancer) set `TRUST_PROXY=1` (the number
of proxies in front: `2` for Caddy in front of the balancer, each adds the address it heard from), or every sign-in comes from the proxy's address and no desktop is found; never
set it on a server browsers reach directly, since they could then claim any address.

Lists of people start with a search box (a plant has thousands): the picker, People & departments and
Person show nobody until something is typed. Development and the demo list them at once, and so does
any instance started with `SIMPLE_LISTS=1` (a test instance).

A person with a password here signs in with it; anyone else with the directory's. Five wrong passwords
lock the sign-in id for 15 minutes. Sign-ins, refusals (and why), sign-outs and passwords set are in the
audit trail under `$auth`. The server says at start which ways are on.

## Read scaling with a replica

Writes go to the primary. Reads a replica can serve go to the replica, but only after it has
replayed every write this process has committed: that is the **replay fence** (`server/routing.js`).
A replica that is too far behind is not waited for past 250 ms; the primary answers instead.

The replica serves live lists and records, search, history, roles and preferences. Sessions,
idempotency keys, the write path and the designer stay on the primary.

```bash
# a primary (5434) and a streaming replica (5435), kept apart from any other local cluster
export LC_ALL=en_US.UTF-8
initdb -D .local/pg/primary -A trust            # then port 5434, unix_socket_directories '/tmp', wal_level replica
pg_ctl -D .local/pg/primary -l .local/pg/primary.log start
pg_basebackup -h /tmp -p 5434 -D .local/pg/replica -R -X stream   # then port 5435
pg_ctl -D .local/pg/replica -l .local/pg/replica.log start

DATABASE_URL="postgresql://%2Ftmp:5434/openmes_repl" npm run db:reset
DATABASE_URL="postgresql://%2Ftmp:5434/openmes_repl" REPLICA_URL="postgresql://%2Ftmp:5435/openmes_repl" PORT=3300 npm run dev
```

**Measured on 2026-09-29.** One Node instance, PostgreSQL 17 primary and replica, a laptop.

| Test | Result |
| --- | --- |
| Read-your-writes, replica 50 ms behind, **no fence** (`REPLICA_FENCE=0`) | 200 of 200 reads stale |
| Read-your-writes, replica 50 ms behind, **with the fence** | 0 of 200 stale; the read right after a save waited ~54 ms; still all served by the replica |
| 100 saves/s for 30 s, 10 live list watchers, **primary only** | all 200, p95 7 ms, primary 4,259 commits/s |
| The same, **with the replica** | all 200, p95 4 ms, primary 497 commits/s (8.6× less); 117,278 reads on the replica, none fell back; fence waits ≤ 4 ms |
| 300 saves/s, 50 watchers, either way | collapsed (see the correction below) |

**Correction (2026-09-29, later).** The 300/s collapse was not CPU, as first written. It was a deadlock
in the write path. Each save held its transaction's pool connection while the rule pipe's lookup
(and the audit of a refusal) waited for a *second* connection from the same pool of 10. With more
than 10 saves in flight, every connection was held and every transaction waited forever, with its
row lock held. The fix: the rule pipe runs before the transaction, which then only locks, re-checks
`row_version` and writes. The pools now also fail fast (`connectionTimeoutMillis`, and
`idle_in_transaction_session_timeout` in the database).

| After the fix | Result |
| --- | --- |
| 300 saves/s, 50 watchers, **one instance** + replica | all 2,987 succeed at 149/s; latency p50 1.3 s. This is the CPU limit: 50 users watching a 200-row list, each re-run on every save |
| 300 saves/s, 30 watchers, **three instances** behind the balancer | all 4,586 succeed at 229/s (was 11/s), split 1,616 / 1,616 / 1,615; latency p50 0.8 s; no transaction left open. Everything on one laptop |

The next limit is therefore live-list fan-out: narrower invalidation targets and
cheaper list re-runs.

Load test: `node app/mes/test/load.mjs [rate] [seconds] [lots] [watchers]`. Stale-read test:
`node app/mes/test/stale.mjs [rounds]`.

## Several instances: the change bus and a sticky balancer

Each instance is one Node process. Instances share the database, and Juris's Postgres outbox bus
(`BUS=1`) carries every change's targets to all of them, so a save on one instance re-runs the
affected live queries on every instance. The pieces that make that correct:

- **The fence across instances.** Each change also carries the WAL position its write reached (a
  `$lsn` target). An instance that hears it moves its replay fence there before it re-runs anything
  (`app.mjs` `onInvalidate`, `routing.advance`).
- **Definitions everywhere.** An executed design change invalidates `defs.*`, and every instance
  empties its cache of definitions and scripts.
- **Shared state lives in the database, not in a process.** Presence is an UNLOGGED table, read on the
  primary. "Why was I refused?" is read from the audit trail.
- **Sticky sessions.** `lb.mjs` pins a browser to one instance with a `mes_node` cookie, because a live
  stream and its subscribe calls must reach the same process. In production, use HAProxy, nginx or
  the cloud balancer with the same rule.

```bash
export DATABASE_URL="postgresql://%2Ftmp:5434/openmes_repl" REPLICA_URL="postgresql://%2Ftmp:5435/openmes_repl" BUS=1
INSTANCE=n1 PORT=3401 npm run dev &  INSTANCE=n2 PORT=3402 npm run dev &  INSTANCE=n3 PORT=3403 npm run dev &
LB_PORT=3400 BACKENDS=127.0.0.1:3401,127.0.0.1:3402,127.0.0.1:3403 node app/mes/lb.mjs
node app/mes/test/cluster.mjs 100      # A/B/C default to 3401/3402/3403
```

**Measured on 2026-09-29.** Three instances, primary and replica, one laptop.

| Test | Result |
| --- | --- |
| 100 saves on n1, the record open on n2, replica 50 ms behind, **with the fence** | 100 of 100 reached n2, 0 stale; save to screen p50 61 ms, p95 66 ms (mostly the 50 ms delay) |
| The same, **fence off** | 0 of 50 reached n2. The re-run read the replica too early, found no change, and nothing re-ran it: the screen stays wrong |
| Presence: Olga editing on n1 | seen from n3 |
| A design change executed on n1 | n2 and n3 serve the new definition at once |
| 100 saves/s for 30 s through the balancer, 30 watchers | 3,000 of 3,000, spread 1,041 / 1,040 / 1,040; p50 3 ms, p95 14 ms, p99 71 ms; 87,988 live patches; no read fell back to the primary |
| 300 saves/s, 30 watchers | collapsed then from the write-path deadlock; after the fix, 229/s with every save succeeding (see above) |

The last row is the next piece of work. Every instance hears every save and re-runs all of its open
lists for it, so adding instances spreads the viewers but not that per-save cost. The fixes are
narrower targets (per record, per line), cheaper list re-runs (the rows that changed, not the list),
and a short coalescing window for busy lists.

## AI as a designer: the REST API

Claude, or any AI, can work in the designer as a person through `/ai/v1/`.
Issue a token in **Designer → AI access**. It is shown once, with read and draft scopes; submitting
is optional. Then:

```bash
curl -s http://127.0.0.1:9090/ai/v1/openapi.json                       # what the API offers
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9090/ai/v1/contract
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9090/ai/v1/contracts/equipment-adapter   # a published contract
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9090/ai/v1/catalog
```

The published contracts (what is built on the core from outside it: an equipment adapter, and what the
HTTP APIs promise) are in `docs/contracts/`, each a specification, a JSON schema and a conformance kit;
`/contract` lists them and `/contracts/<name>` serves one (`get_contract` with a name, for the copilot).
Every answer of `/ai/v1` and `/svc/v1` carries `API-Version`; what `/v1` will lose comes with notice
first (`Deprecation`, `Sunset`, `Link` headers), and a plant's web service is held to the same rule
before a change breaks its callers. Check an instance against it:

```bash
node docs/contracts/http-apis/kit.mjs --url http://127.0.0.1:9090 --token "$TOKEN"
```

`node app/mes/test/ai-agent.mjs` is an AI agent's whole loop:
1. Read the contract and the catalog.
2. Draft a new object with a rule script.
3. Test the script in the sandbox (and see a deliberate mistake caught).
4. Simulate access.
5. Validate and see the approvers.
6. Confirm it cannot submit or approve.

The change it leaves is in design, marked **Drafted with AI** for its reviewers. A database made
before this is upgraded by itself when the server starts.

## The in-app copilot

Every change request's editor has a **✦ Copilot** view: ask in words, and the
model reads the model, drafts, tests its scripts and validates, as you, through the same tools as
the REST API. It never submits. Choose the AI in `.env` (or the server's environment):

```bash
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=…
```

```bash
AI_PROVIDER=openai
AI_BASE_URL=http://localhost:11434/v1
AI_MODEL=qwen3
```

The first is Claude (`AI_MODEL`, default `claude-opus-5-5`; `AI_EFFORT`, default `high`). The
second is any OpenAI-compatible model, in-house or not. With neither, the view says how to configure
one. `node app/mes/test/copilot-agent.mjs` checks the loop without a real model.

## Services and connections: integration, designed

The designer creates web services, triggers and the outside systems they reach,
under the same governance as objects: each is drafted in a change request, approved by its stewards
and by the stewards of whatever it reaches, and live the moment the change executes, with no deploy
or restart.

- A **connection** is an outside system: its base URL, the requests allowed to it, and a named secret.
  The secret's value is set on the server as `MES_SECRET_<NAME>` (in `.env` for development) and never
  appears in a design, a review or the audit. `MES_CONNECTION_HOSTS=erp.plant.local,*.lims.plant.local`
  lists the hosts connections may be sent to; with none listed any host is reached, except a
  link-local or unspecified address (a cloud's metadata service), which is always refused unless
  listed.
- Scripts run in a runner of their own, with no credentials, no files beyond the app's and its own
  network functions removed. In production, wall it in with the operating system too: see
  "Scripts: the runner's walls" below.
- A **service** is a script named as the service (the rule-script contract), with its callers (deny
  by default), its input, its triggers (`lot transition:release`, …) and what it reaches
  (`uses.objects`, `uses.connections`). On its **Identity** tab: who it acts as, by default **its
  own service role** (`service:<name>`, holding exactly the object roles granted there, approved by
  those objects' stewards), or its caller, or a user. Its record reads and writes go through the
  object's policies and rule pipe as that identity, exactly as at a form, and the audit names on
  whose behalf. Dry runs and test cases use the same identity, so tests prove what production does.

In the designer: **Designer → Services & connections → New service / New connection**, or **+ service**
and **+ connection** inside any change. A service's **Try it** tab calls the published version as you;
**Activity** shows its calls and its triggers, with **Send again** for a failed one.

Scripts (rule and service) are edited in a code editor with highlighting, line numbers and
auto-indentation. It marks a syntax error on its line anywhere in the script, and warns about calls
the script will not have (`ctx.recods…`, `fetch(…)`). **Dry run** under the editor executes the draft
on the server as you: real reads, writes checked by policy and the rule pipe but not saved, requests
checked and answered from `responses`, never sent. A runtime error is marked on its line.

An outside system calls a web service with an integration user's token:

```bash
node app/mes/db/token.mjs erp "ERP production"
```

```bash
curl -s -X POST http://127.0.0.1:9090/svc/v1/<service> -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Idempotency-Key: order-1001" -d '{"wo_no": "WO-2001"}'
```

`GET /svc/v1/openapi.json` (with the token) describes the services that token's user may call.
A refusal by a rule or the script answers 422 with its words and fields; a retry with the same
`Idempotency-Key` answers the first result again; a retry sent while the first call is still running
is answered 409 (`idempotency.running`, with `Retry-After`), never run a second time.

**The fitness test**: a change is submitted only when it passes. It checks
validation, that scripts compile and call only what they will have, and that every new or changed
script has test cases that pass. It warns about existing records the draft would no longer let be
saved, and lists access changes. Run it from the panel beside the change; a dry run is saved as a
test case with **Save as test case**.

`node app/mes/test/integration.mjs` runs it end to end (dry runs and fitness included), against a fake ERP: an ERP
integration designed, approved by engineering, production and quality, then called (wrong caller, bad
input, a quantity the work order's own rule refuses, a good order, a retry), and a lot's release
confirmed to ERP, including while ERP is down.

## Scripts: the runner's walls

Every rule, service and suite script runs in the script runner, a process beside each web process
(DESIGN.md §12.4). What the product does by itself, everywhere: Node's permission model (it reads
`app/mes` only, writes nothing, starts no process, loads no native code), an empty environment (no
database address, secret or key), a context that holds nothing of the host, and its own network
functions removed. What only the operating system can add, and **each installation must turn on**:
no network at all, and nothing of the machine to read. On Linux:

```bash
apt-get install bubblewrap        # dnf install bubblewrap
install -m 0644 ops/script-runner-sandbox.apparmor /etc/apparmor.d/open-mes-bwrap && apparmor_parser -r /etc/apparmor.d/open-mes-bwrap   # Ubuntu 23.10 and later
```

then, in the server's environment, `SCRIPT_RUNNER_WRAP=ops/script-runner-sandbox.sh` (the path from
the server's working directory, or absolute). The wrapper (`bwrap`) gives the runner a network
namespace with loopback only, a read-only file system of the system's libraries, Node and `app/mes`
(no home, `/etc` or `.env`), an empty `/tmp`, no capabilities, and ends it with the server.

Ubuntu 23.10 and later refuse user namespaces to programs without an AppArmor profile that allows
them (`kernel.apparmor_restrict_unprivileged_userns=1`): `unshare -r -n` fails there ("write failed
/proc/self/uid_map"), and so does bubblewrap until the profile above is loaded. Debian, RHEL and
older Ubuntu need no profile.

**Check it**, on each instance, by what the runner finds rather than by the settings: the start log
says `scripts: isolated (bwrap): no network, Node's permission model`, and `/healthz` shows
`"scripts": {"network": "none", "sandbox": "bwrap", "wrapped": true, …}`. Anything else
(`"network": "host"`) means scripts could reach the network if one broke out of its context; a
production instance also writes `scripts.unisolated` to its event log. Once it holds, set
`SCRIPT_ISOLATION=required`: the instance then refuses to start without the walls, so an upgrade, a
new machine or a changed AppArmor policy cannot drop them unnoticed. `npm test` tries the wrapper
wherever bubblewrap works (`test/script-runner.test.mjs`). Off Linux there is no wrapper: scripts
keep the product's own walls, and `/healthz` says `"network": "host"`.

The developer's guide (installing OpenCore MES, services and integration), printable, is
`docs/developers/` (`node docs/developers/build.mjs --pdf`).
