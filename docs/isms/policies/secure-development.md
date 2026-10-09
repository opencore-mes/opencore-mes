# Secure development policy

> **Draft to adopt, not a certification.** Owner: [security lead] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]

## The rules the code follows

The project's rules (`CLAUDE.md`, `CONTRIBUTING.md`) are security rules too, and a change against them
is sent back:

- **Every write goes through the generic services**, so policies, rules and the audit trail apply
  whatever the path (form, transaction, service, import, AI) (`app/mes/server/services.js`). Never
  write records around them.
- **Deny by default** for every read, write and action (`app/mes/server/policy.js`).
- **SQL is parameterized**, identifiers checked (`app/mes/server/record-sql.js`); user-written SQL runs
  as a restricted role over policy views, one statement, with limits (`app/mes/server/query.js`).
- **Scripts written in the designer run in the script runner**: a separate process with Node's
  permission model, no environment, its own network functions removed (`app/mes/server/rules.js`,
  `app/mes/server/script-worker.mjs`, `app/mes/server/no-network.mjs`), and on the hosted service
  inside bubblewrap with no network (`ops/script-runner-sandbox.sh`, `SCRIPT_ISOLATION=required`).
- **The browser is held by a Content-Security-Policy** the server writes on every page, with
  `frame-ancestors 'none'` unless `EMBED_ORIGINS` names sites (`app/mes/app.mjs`); API calls must be
  JSON, form posts check Origin. The designer's pages still allow `'unsafe-eval'` (G6).
- **Uploads are kept by what their bytes are**, never served as something that runs
  (`app/mes/server/blobs.js`).
- **Outbound requests** refuse link-local addresses and keep to `MES_CONNECTION_HOSTS`
  (`app/mes/server/integration.js`).
- **Errors for people** say what happened without internals (`fail()` / `ServiceError`); anything else
  reaches the browser as "request failed".
- **No secrets in code, designs, the audit trail or git** ([cryptography-and-keys.md](cryptography-and-keys.md)).
- **Few dependencies**: three at run time, pinned by `package-lock.json`. A new one needs a reason in
  the pull request and the security lead's agreement.

## The lifecycle

1. **Design**: a feature that touches sign-in, policies, the audit trail, scripts, uploads, outbound
   requests, the AI or PHI gets a short threat note in its pull request (what could go wrong, what stops
   it).
2. **Build**: a whole slice, with its test (`CLAUDE.md`, "A whole slice, with proof").
3. **Test**: `npm run test:all` (syntax, unit, every end-to-end suite on a fresh test database; it
   refuses a database whose name lacks "test", `tests/pipeline.mjs`). Security behaviour has its own
   suites, e.g. `app/mes/test/auth.mjs`, `app/mes/test/auth-hardening.mjs`, `app/mes/test/dual-sign.mjs`,
   `app/mes/test/hardening.test.mjs`, `app/mes/test/script-runner.test.mjs`,
   and the framework's own in its repository (`tests/server.test.mjs` of `@opencore-mes/juris-kit`).
4. **Review**: another engineer, with the security items above in mind
   ([change-management.md](change-management.md)).
5. **Scan**: `npm audit` in CI and Dependabot (planned, G8); see
   [vulnerability-management.md](vulnerability-management.md).
6. **Release**: the deploy runs the tests again on the server.

## Environments and test data

- Development uses `openmes_poc`, tests `openmes_test`, each sandbox a database of its own; the hosted
  service's databases are never used for development or tests, and no production data is copied out of
  production. A customer's data needed to reproduce a fault is reproduced with made-up data, or, with the
  customer's written permission, looked at inside the hosted service.
- Seeds and fixtures hold made-up people and records only (`app/mes/db/seed.mjs`).
- `npm run db:reset` wipes the database it targets without a backup: never run it against anything but a
  named test database ([backup-and-restore.md](backup-and-restore.md)).

## AI coding assistants

Engineers may use AI coding assistants. Their output is code like any other: reviewed, tested, merged
by a person. No customer data, PHI, secret or production log goes into a prompt. Commits carry no AI
attribution lines (the release export refuses them).

## Source code

Private repositories hold the suites and the private design; the community edition is public. Access
follows [access-control.md](access-control.md). Private files never reach the public tree (the export
refuses them, `ops/release/export.mjs`).

## Evidence

Pull requests with threat notes and reviews; CI runs; dependency scan results; the test suites.
