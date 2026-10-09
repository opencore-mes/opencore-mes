# OpenCore MES

A low-code manufacturing execution system for advanced manufacturing, from small plants to 300 mm fabs:
semiconductor and electronics, medical devices, aerospace and automotive suppliers, where every lot is
traced, machines report what they do, and auditors follow every change.

Your engineers design the objects, states, roles, rules, screens, transactions, services and flows in a
browser designer, with an AI that drafts what they describe. Every change goes through **design →
review → approval → execution** before it reaches the plant, and every write goes through the same
policies, rules and hash-chained audit trail, whatever path it takes. Every record is sealed: a change made
straight in the database is found, and closed only with a signed non-conformance report. Lots, machines,
OEE, quality and SPC are not modules: they are designs, and the platform knows none of them by name.

This is the **community edition**: the whole platform, open source under the Apache License 2.0. It is a
proof of concept on its way to a first release.

- Website: https://opencoremes.com
- Live demo (a public sandbox, reset every night): https://demo.opencoremes.com

## Run it

Node 24 or later and PostgreSQL; plain JavaScript ES modules, no build step.

From npm, with a plant folder of its own for its settings, suites and event log:

```bash
npm install -g @opencore-mes/server
opencore-mes init my-plant && cd my-plant
opencore-mes db reset --yes   # creates the database named in .env and loads the seed (sample people, to try it)
opencore-mes start            # http://127.0.0.1:9090
```

For a plant's own installation (a Linux server with HTTPS, backups and a hardened host, or a plant folder),
follow the installation procedure: [docs/installation/installation-procedure.html](docs/installation/installation-procedure.html)
([PDF](docs/installation/installation-procedure.pdf)). It starts from an empty database
(`opencore-mes db reset --yes --empty`) and the first administrator IT names (`opencore-mes admin`).

From a checkout, to work on it:

```bash
npm ci
npm run db:reset      # creates the database openmes_poc (local socket) and loads the seed
npm run dev           # http://127.0.0.1:9090
npm run test:all      # the whole pipeline: syntax, unit, then every end-to-end suite on a fresh test database
```

`app/mes/README.md` says more: the settings, sign-in (single sign-on, a directory, passwords with a second
factor), scaling with a replica and several instances, the AI design API and the in-app copilot,
services and connections. `docs/developers/` is the developer's guide (installing, integration), also as
a PDF.

## What is here

| Path | What |
| --- | --- |
| `app/mes/` | The application: `server/` (the services), `client/` (browser modules, also rendered on the server), `db/` (schema, seed, migrations), `test/` |
| `@opencore-mes/juris-kit` (npm) | Juris, the real-time web framework it runs on, a dependency in `package.json`; developed in its own repository, [opencore-mes/juris-kit](https://github.com/opencore-mes/juris-kit), whose `REFERENCE.md` is its contract |
| `docs/contracts/` | The published contracts that adapters, extensions and outside systems build on (an equipment adapter, the HTTP APIs), each with a specification, a schema and a conformance kit (on npm as `@opencore-mes/equipment-adapter` and `@opencore-mes/http-apis`) |
| `docs/developers/` | The developer's guide |
| `USERGUIDES.md`, `TRAINING.md` | The user guide for designers, and a hands-on course |
| `COMPLIANCE.md` | SOC 2 and ISO 27001 readiness: each control area, its evidence in the code, the gaps |
| `ops/` | Running it on a server (the public demo's deployment, the script runner's sandbox) |
| `site/` | The website |

Code comments cite the maintainers' design document by section (§n).

## Extending it

What a plant needs beyond the platform is designed in the designer, not coded. Suites, equipment adapters
and outside systems build on published, versioned contracts (`docs/contracts/`), and the core runs, and is
tested, with none of them installed.

## Licence and contributing

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE). [LICENSING.md](LICENSING.md) explains the
community edition and what is sold separately; [TRADEMARKS.md](TRADEMARKS.md) the name; and
[CONTRIBUTING.md](CONTRIBUTING.md) how to contribute (a contributor agreement, signed-off commits, and
how the platform is built).
