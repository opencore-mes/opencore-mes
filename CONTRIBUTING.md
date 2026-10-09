<!-- 2026-10-10: the contributor licence agreement is being prepared with counsel; until it is published, outside pull requests wait. -->
# Contributing to OpenCore MES

Thank you for helping. OpenCore MES is a low-code MES for advanced manufacturing, from small plants to 300 mm fabs; contributions to the
community edition (this repository) are welcome: fixes, features, documentation, translations, tests.

## Before your first contribution: the contributor agreement

Every contributor signs the **OpenCore MES Contributor Licence Agreement** once, before their first
pull request is merged. It is being prepared and will be linked here when it is published; until then,
pull requests are welcome and reviewed, but none from outside the project is merged. In short, it will
say that:
- you wrote the contribution, or have the right to give it;
- you license it to the project under the Apache License 2.0, like the rest of the community edition;
- you also grant the project the right to use it in the proprietary **OpenCore MES suites**
  ([LICENSING.md](LICENSING.md)), so that the community edition and the suites stay one code base;
- you keep your copyright, and may use your contribution elsewhere as you like.

Each commit is also signed off (`git commit -s`), certifying the
[Developer Certificate of Origin](https://developercertificate.org).

## How OpenCore MES is built

Read these before a larger change; a pull request that goes against them is sent back:
- **Everything is a definition.** The platform knows no lot, machine or move-in: those are objects,
  transactions and screens designed in the designer, versioned, and changed through the lifecycle.
  When a domain need comes up, add the smallest *generic* ability (an expression operator, a step
  kind, a block, a widget) and express the domain part as a definition.
- **Layout is data.** Pages are laid out by data (a form's layout, a screen's blocks) and drawn by
  generic Juris components; prefer a new block or section kind over a new hand-made page.
- **Every change is governed.** Nothing reaches a live system except through design → review →
  approval → execution, and every write goes through the same policies, rules and audit trail,
  whatever path it takes (a form, a transaction, a service, an import, an AI).
- **A whole slice, with proof.** A feature arrives with its server part, its screens, its AI design
  tools where they apply, its documentation (`USERGUIDES.md`, and the design), an end-to-end test, and
  a check in a browser.
- **Suites stay outside.** `suites/` holds installed suites and is never committed.
  The community edition knows no suite by name; what a suite needs is a generic extension point,
  proposed here like any other change.
- **The core survives any removal.** The community edition works, unchanged, with any suite and any
  model removed: what a suite leaves behind stays inert and labelled, never deleted, and import and
  export of models keep working.
- **Open interfaces.** Every way in is a published, versioned contract with a specification, a
  machine-readable schema and a conformance kit: the extension API for suites, the equipment adapter
  contract, the HTTP APIs. The internals are never a contract.
- **AI builds on the contracts too.** Each contract is served to the AI, with tools that draft, check
  and test what is built on it; the AI never reviews or approves, submits only through a token its
  person gave the `design:submit` scope (the copilot never does), and never acts on a real tool.
- **Plain JavaScript, no build step.** Node 24, PostgreSQL, Juris (`@opencore-mes/juris-kit` from npm; a change to the framework is made in [its repository](https://github.com/opencore-mes/juris-kit), released, then taken here). Match the surrounding
  code: its naming, its comments (they say why), its idioms.

## Getting started

```bash
npm install
npm run db:reset      # a fresh demo database
npm run dev           # http://127.0.0.1:9090
npm run test:all      # everything: syntax, unit, end-to-end against its own test database
```

[app/mes/README.md](app/mes/README.md) explains the rest, and [USERGUIDES.md](USERGUIDES.md) is the user guide.
The design document the code cites as §n is kept by the maintainers, outside this repository.

## A pull request

1. Open an issue first for anything larger than a fix, so the design can be agreed before the code.
2. Branch from `main`; keep a pull request to one change.
3. `npm run test:all` passes. A new behaviour has a test that would fail without it.
4. The documentation says what changed, for the people who will use it.
5. Database changes are migrations in `app/mes/db/migrate.mjs`, safe to run again; never by hand.
6. Describe what changed and why, and how you checked it.

## Reporting a security problem

Do not open a public issue. Write to [security contact address]; we answer within [n] working days.

## Conduct

Be kind, be precise, assume good faith. [Code of conduct: to be adopted, e.g. the Contributor
Covenant.]
