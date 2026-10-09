# `http-apis` 1.0

OpenCore MES has two HTTP APIs that outside systems and agents build on, each with its version in the
path:

| API | Who calls it | Described by |
| --- | --- | --- |
| `/ai/v1` | AI agents working in the designer as a person, through a token (design:read, design:draft, design:submit) | `GET /ai/v1/openapi.json` |
| `/svc/v1` | Outside systems (ERP, LIMS, a plant's own tools) calling what the plant designed and published over HTTP: its web services (service:call), transactions (transaction:run) and named queries (query:run), through a token | `GET /svc/v1/openapi.json`: what the token's person may call |

This contract says what `/v1` promises, how that may change, and how a caller is told before it does.
`schema.json` beside this file holds the same promise as data: every `/ai/v1` operation (its scope, its
path parameters, the request fields it reads) and the `/svc/v1` envelope. `surface.mjs` compares a live
OpenAPI document with it, and `kit.mjs` checks a running instance.

## What `/v1` promises

- **`/ai/v1`**: each operation in `schema.json` (`x-apis./ai/v1.surface`) stays, with its scope, its path
  parameters and every request field it reads, for as long as `/v1` runs. Answers keep the fields they
  have; new ones may be added.
- **`/svc/v1`, the envelope**: `POST /svc/v1/{service}`, a bearer token with `service:call`, JSON in and
  out, `Idempotency-Key` (the first answer is given again for the same key and caller), and the answers
  listed in `schema.json` (`x-apis./svc/v1.answers`), each error as `{ error, code?, fields? }`: words a
  person reads, a stable `code` where there is one, a message per input in `fields`.
- **`/svc/v1`, transactions and named queries** (1.3): a design publishes one over HTTP (`http.enabled`), under
  its own name, which no other kind there may take:
  - `POST /svc/v1/{transaction}` runs a transaction as the token's person (`transaction:run`): its inputs by
    name, a reference as a record's id or its title (as a scanner reads it), a rows input as an array; the
    same callers, checks, policies, all or nothing and audit as at its screen; `Idempotency-Key` as above.
    `POST /svc/v1/{transaction}/preview` says what it would change, record by record, and writes nothing. A
    transaction a person signs, or one only routes run, is never published.
  - `GET /svc/v1/{query}?<parameter>=<value>` reads a named query as the token's person (`query:run`): its
    parameters typed as it declares them, `offset`, `sort`, `dir` and `limit` to page; the answer `{ columns,
    rows, next }` holds at most the query's limit, `next` the offset of the next page or null. It changes
    nothing; it takes no `Idempotency-Key`.
  - `409` with `code: stale` says a record a run read changed meanwhile (run it again); `503` that the server
    is busy (`Retry-After`), nothing changed.
- **Every answer** of both carries `API-Version: 1.3`, the version of this contract the core provides.

## How it may change

- **A minor version adds**: an operation, an optional request field, a field in an answer, a `code`.
  It is written into `schema.json` and `CHANGELOG.md` first; the core's own test refuses an operation or a
  field the live API offers and the contract does not list.
- **Nothing promised is removed or changed in `/v1`**: an operation, its scope, a path parameter, a
  request field it reads, the error envelope, what a status means. The core's own test refuses it. Such a
  change is `/v2`, which runs beside `/v1` at least until `/v1`'s sunset.
- **Notice first.** What `/v1` will lose is marked deprecated in `schema.json` (`x-deprecated`): since
  when, its sunset (at least 180 days later), and its successor. From then on every answer to it carries:
  - `Deprecation: @<seconds>` (RFC 9745): when it was deprecated;
  - `Sunset: <date>` (RFC 8594): the date after which it may go;
  - `Link: <successor>; rel="successor-version"`: where to go instead.
  Each use is logged (the instance's event log, once a day per token and operation), so whoever runs the
  plant can see who still calls it. Nothing is deprecated in 1.0.

## A plant's own web services

What each designed web service (a service, a transaction or a named query published over HTTP) takes and answers is the plant's promise to its callers, not the core's:
it changes through the plant's change requests. The core holds it to the same rule:

- **A change that would break callers is refused** at the fitness test when someone called the service
  over HTTP in the last 30 days: an input removed, made required, added as required, its type changed or
  a value taken from its list; HTTP turned off; a caller taken off its callers; for a query, a parameter
  gone, made required or of another type, a column it gives taken away. The test names the callers and how
  often they called.
- **Give notice instead**: mark the service deprecated (on its General tab: since, sunset, its
  successor, a note). Its callers then get the same `Deprecation`, `Sunset` and `Link` headers on every
  call, its OpenAPI operation says `deprecated: true`, and once the sunset has passed the change goes
  through. Or publish the new shape under a new name, and deprecate the old one.

## The API kit

```bash
node docs/contracts/http-apis/kit.mjs --url http://127.0.0.1:9090 --token <a token with design:read and service:call> [--json]
```

It checks a running instance against this contract, without changing anything: every promised `/ai/v1`
operation in its OpenAPI document with the same scope, parameters and fields, nothing offered that is not
promised, `API-Version` on every answer, each read-only operation answering JSON, the error envelope and
statuses (no token, an unknown operation, a body that is not JSON), and the `/svc/v1` envelope (no
token, a missing scope, an unknown service, a body that is not JSON); with `--service <name> --input
<json>` also a call and its retry with the same `Idempotency-Key`. It exits non-zero when a step fails;
`--json` prints `{ contract, ok, steps }`.

## Versions

See `CHANGELOG.md`. 1.0 is the first written down: what `/v1` offered on 2026-10-06.
