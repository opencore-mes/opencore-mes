# @opencore-mes/server

OpenCore MES, the community edition: a low-code manufacturing execution system for advanced
manufacturing, from small plants to 300 mm fabs. Engineers design the objects, states, roles, rules,
screens, transactions and services in a browser designer, and every change goes through **design →
review → approval → execution** before it reaches the plant. Every write goes through the same policies,
rules and hash-chained audit trail, whatever path it takes.

This package is the application, ready to run. It is a proof of concept on its way to a first release.
The source, the user guide and the developer's guide are at https://github.com/opencore-mes/opencore-mes.

## Run it

You need Node 24 or later and PostgreSQL. Settings, suites and the event log live in a plant folder,
outside the package:

```bash
npm install -g @opencore-mes/server
opencore-mes init my-plant      # my-plant/.env (the settings, commented), suites/, .local/
cd my-plant
opencore-mes db reset --yes     # creates the database named in .env and loads the seed (sample people)
opencore-mes start              # http://127.0.0.1:9090
```

For a plant's own installation, start empty and name its first administrator, who sets up the rest:

```bash
opencore-mes db reset --yes --empty
opencore-mes admin <id> "<Full name>" --url https://<your server>   # prints a one-time password link
```

The installation procedure (a Linux server with HTTPS, backups and a hardened host; upgrades; suites) is in
the repository: docs/installation/installation-procedure.pdf.

Without `PROD=1` it runs in development mode: anyone signs in as anyone from a picker, and the seed's
people approve each other's changes. That is for trying it out, never for a reachable instance.

| Command | What it does |
| --- | --- |
| `opencore-mes init [folder]` | makes a plant folder; an existing `.env` is left as it is |
| `opencore-mes start` | starts the server with the folder's `.env` (run it from inside the folder) |
| `opencore-mes db migrate` | brings the database up to date (the server also does this when it starts) |
| `opencore-mes db reset --yes` | makes the database again from the seed: **everything in it is lost** |
| `opencore-mes token <user> "<name>"` | makes a token for an integration user |
| `opencore-mes password <user> --url <site>` | makes a one-time link for a person to set their password |
| `opencore-mes db reset --yes --empty` | an empty database: a plant's own installation (**everything in it is lost**) |
| `opencore-mes admin <id> "<name>"` | the first administrator of an empty installation, with a password link; opens setup |

## In production

Set `PROD=1` and a way to sign in in `.env`: `OIDC_ISSUER` (single sign-on), `LDAP_URL` (the plant's
directory) or passwords of its own with a second factor. `app/mes/server.mjs` in this package lists
every setting. On Linux, wall the script runner in with the operating system: set
`SCRIPT_RUNNER_WRAP` to this package's `ops/script-runner-sandbox.sh` (it needs bubblewrap) and
`SCRIPT_ISOLATION=required`. `/healthz` reports what the scripts are walled in with.

To upgrade, update the package and restart. The server migrates the database when it starts.

## Suites

Suites are sold separately and installed into the plant folder's `suites/` from the suites registry,
with the licence token from your account at the suites store (suites.opencoremes.com: planned, not
open yet):

```bash
opencore-mes suite login              # paste the licence token
opencore-mes suite install <name>     # then restart
opencore-mes suite list
```

`suite update` installs the newest version, `suite remove` takes one out and `suite use <name>@<version>`
brings back an earlier one: every version a plant ran is kept in `suites/.versions/`, and a suite's
designs and tables stay whatever happens to its folder. A plant with no way out installs the package
file downloaded from the store: `opencore-mes suite install <name> --from <file>.tgz`.

## Extending it

What a plant needs beyond the platform is designed in the designer, not coded. Equipment adapters and
outside systems build on published, versioned contracts, each a package of its own with a conformance
kit: `@opencore-mes/equipment-adapter` and `@opencore-mes/http-apis`.

## Licence

Apache License 2.0: see LICENSE and NOTICE. OpenCore MES is a trademark of Resti Guay. The chart library
in `app/mes/vendor/` is Apache ECharts, under its own licence (Apache License 2.0) beside it.
