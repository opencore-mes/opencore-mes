# Change management policy

> **Draft to adopt, not a certification.** Owner: [security lead] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]

Two kinds of change reach the hosted service, and both are governed: **changes a customer designs in
the product** (objects, rules, screens, transactions, services, connections, People & departments), and
**changes to the product and the servers** that [Organization] makes.

## 1. Design changes in the product (the customer's, enforced by the product)

Every design change goes through design → review → approval → execution (`app/mes/server/design.js`;
USERGUIDES.md). Nothing reaches a live system any other way.

| Step | What the product enforces |
| --- | --- |
| Design | A change request with an author and a reason; the draft is edited, never live. AI tools draft as the person and their edits are marked for reviewers; the AI never submits through the copilot, and through `/ai/v1` only with a token its person gave the `design:submit` scope (`app/mes/server/ai-api.js`). |
| Fitness test | Before submit: validation, scripts compile and call only what they will have, every new or changed script has passing test cases, scenarios in a sandbox (`app/mes/server/fitness.js`, `app/mes/server/sandbox.js`); the test sandbox holds changes under test together (`app/mes/client/test-sandbox.js`). |
| Review | By a reviewer who is not the author. |
| Approval | By the departments whose scope the change touches, in their steps; one person never signs two steps; whoever reviewed never approves; every signature re-authenticates its signer where `SIGN_WITH_PASSWORD` is on (the production default; `app/mes/server/signatures.js`). Approvals are bound to the hash of the exact content approved. |
| Execution | By the platform, all or nothing, only if the content still matches the approved hash. |
| Rollback | A drafted change that puts back what was changed, itself governed (`app/mes/client/rollback.js`). |
| Record | Author, reason, diff, reviewer, approvals with their meaning, the hash, the fitness evidence, the execution time, in the hash-chained audit trail (`app/mes/server/audit.js`). |

**Emergency design changes** (G15): one approver's signature executes the change, and it is reviewed
afterwards by a reviewer and confirmed or flagged by each department it touches, within the days the
organization sets; overdue ones are flagged and said in the event log (`app/mes/client/emergency.js`).

**Setup** (a new installation only, DESIGN.md §5.15): while the customer's plant is being set up, a
designer's change executes on their own signature, without review or approval, each marked, signed and in
the audit trail. [Organization] opens it at install only when the customer asks (`SETUP=1`), and records
that in the installation's handover. The customer ends it from People & departments before go-live, once
someone besides the designers can review; their validation covers the changes listed as made during setup.
Opening it again is a change the customer's governance approves.
The one console tool outside the lifecycle, `app/mes/db/recover-designer.mjs`, restores design roles
only when nobody can change the system any more, refuses otherwise, and is audited with who ran it and
why.

**Customer's part:** who designs, reviews and approves (People & departments), and their own procedure
for validating changes (Part 11 / Annex 11 plants).

## 2. Changes to the product and the hosted service ([Organization]'s)

| Kind | Route |
| --- | --- |
| Code (community edition, suites) | A branch, a pull request describing what and why, `npm run test:all` passing in CI (`.github/workflows/test.yml`, every push and pull request, with `--full`), reviewed and approved by an engineer other than the author, merged to `main`. Branch protection on `main` (required review, required CI, no force push) is to be configured and recorded (COMPLIANCE.md: "No branch protection or required-reviewer rule is written down"). |
| Database schema | Only as migrations listed in `app/mes/db/migrate.mjs`, safe to run again, applied by the server at start; never by hand. |
| Deploy | From a commit on `main` that passed CI, never from a working tree with uncommitted changes (the demo's `ops/demo/deploy.sh` marks such a release `-dirty`; the hosted deploy must refuse it). The deploy runs the test pipeline again on the server, switches the release, restarts and checks `/healthz` (including the script runner's walls). The last five releases are kept; going back is switching `current` to the one before (schema migrations are forward and additive, so the previous release must still run on the migrated schema). |
| Suites | Installed and versioned through `opencore-mes suite` (`app/mes/suite-install.mjs`); every version a customer ran is kept. |
| Servers (packages, settings, units) | Through the provisioning script and units in git (`ops/demo/provision.sh`, `ops/demo/*.service` for the demo; the hosted service's equivalents), by pull request. A change made by hand on a server during an incident is written into git within [2] working days. |
| Suppliers, new kinds of data | A risk assessment first ([../risk-register.md](../risk-register.md)). |

**Emergency code changes:** a fix may be deployed after one other engineer's review in chat (or, if
nobody can be reached within [1] hour for a critical incident, by the incident lead alone), with CI
passing. The pull request is completed and reviewed within [2] working days, and the incident record
links it.

**Customer notice:** a release that changes behaviour is announced [n] days before, in release notes;
what `/v1` APIs promise changes only as `docs/contracts/http-apis/` says (deprecation headers first).

## Evidence

Pull requests with reviews and CI runs; the deploy log (release stamp, tests on the server, `/healthz`);
the product's change requests and audit trail; emergency change records.
