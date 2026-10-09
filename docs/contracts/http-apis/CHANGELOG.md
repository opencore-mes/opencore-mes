# `http-apis` changelog

## 1.3 (2026-10-09)

Added (nothing removed or changed): transactions and named queries as web services, under their own names in
`/svc/v1`, each only where its design publishes it (`http.enabled`). `POST /svc/v1/{transaction}` runs one and
`POST /svc/v1/{transaction}/preview` says what it would change (scope `transaction:run`); a reference input takes
a record's id or its title. `GET /svc/v1/{query}` reads a page of a named query's rows (scope `query:run`), its
parameters in the query string. The answers gain `409` with `code: stale` and `503` (busy). The three kinds
share one set of names. A change that would break a transaction's or query's callers needs their notice
first, as a service's does.

## 1.2 (2026-10-07)

Added (nothing removed or changed): `GET /suites` (scope `design:read`), the installed suites as the AI needs them:
each with its version and a newer one on the registry, what it gives designs, its design pack against what is
live, its set-up guide, every version of it run here and what each gave; the suites that ran here and are not
installed now; and what every live design needs from suites, given or not and why, with the version that last gave
it and the command back.

## 1.1 (2026-10-06)

Added (nothing removed or changed): named queries as a design kind (§23.1). `POST /changes` takes `query`
(and `layout`, which it took already, now written down); `PUT /changes/{id}` and `POST /validate` take `queries`.

## 1.0 (2026-10-06)

`/ai/v1` and `/svc/v1` as they were, written down: every `/ai/v1` operation (27), the `/svc/v1` envelope,
`API-Version` on every answer, deprecation by notice (`Deprecation`, `Sunset`, `Link`), and the rule for a
plant's own web services. Nothing deprecated.
