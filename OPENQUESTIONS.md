# Open questions

Decisions still to make, with the options found so far and a proposal for each. The questions here
continue the numbering of DESIGN.md §20 (O1–O19; O6 and O18 are decided). When one is decided, move
it into DESIGN.md with its reasoning and mark it decided here.

Last updated: 2026-09-30 (archiving; event log; demo site; analytics).

## Context: archiving and restoring records

Already decided:
- **Archiving is a platform operation** (`records.archive`, `records.restore`), not a transition each
  object defines. A record is never deleted (Part 11).
- **Archiving follows the object's rule pipe.** The whole pipe runs with `event.kind: "archive"` or
  `"restore"`, in the browser as advice and on the server as the decision. A throw refuses the change,
  and the refusal is audited.

What exists now (branch `juris-fixes`, uncommitted):
- Archiving sets `archived_at` and `archived_by` on the record. The data stays in the MES.
- An archived record is read-only and leaves the lists.
- One grant, `record.archive`, covers both archiving and restoring.
- Services reach it through `ctx.records.archive` and `ctx.records.restore`.
- The steps are tested end to end in `app/mes/test/archive.mjs`.

Constraints that any answer below must respect:
- **The audit trail is one hash chain for the whole database.** Every row's hash covers the row
  before it, a trigger refuses UPDATE and DELETE, and each record's rows are interleaved with every
  other record's. Removing a record's rows would break verification for all records written after
  them.
- **External archive packages are keyed by `object + UUID`, never by a natural key** such as a lot
  number. Otherwise archiving a later record with the same number overwrites the earlier package.

## Archive and restore: how it works

### O20. What does archiving leave in the MES?
- **A. Offload.** Archive pushes the record to an external archive system and keeps a stub in the
  MES (id, title field, state, dates, external reference, hash). Restore fetches it back.
- **B. External approval.** The data stays in the MES. An outside system (for example a QMS ticket)
  only decides whether a restore may happen.
- **C. Mixed.** Each object chooses. Objects without an external archive keep their data in the MES.

**Proposal:** C. **Depends on:** O39 (what is driving archiving).

### O21. How is an object's archiver and restorer bound?
- Declared on the object definition: `"archive": { "archiver": "…", "restorer": "…" }`.
- A naming convention (`<object>_restore`).
- A marker on the service (`implements: restore, for: lot`).

**Proposal:** on the object. Then there is exactly one binding per object, the object's stewards
approve it, and it appears in the change footprint. A convention cannot be reviewed, and markers let
two services claim the same object.

### O22. Does restore wait for the answer, or is it a request?
Cold storage can take hours to answer. As a request, the record shows `restoring`, the call goes
through the outbox with retries, and failures appear on the service's Activity tab.

**Proposal:** design for requests. The first version may wait for the answer.

### O23. Is archiving also a call to an external service, and in what order?
With offload (O20 A or C), archiving must push the package out. There are two orders:
- The MES clears its copy first, and the push runs after the commit.
- The MES clears its copy only after the external system confirms it has stored the package.

**Proposal:** clear only after confirmation, so the data exists in at least one place at all times.

### O24. What happens for an object with no restorer bound?
- Restore is unavailable, and "Why can't I?" says no restore service is bound to the object.
- A built-in local restorer clears the flag, as the current build does.

**Proposal:** the built-in local restorer is the default, and a bound restorer replaces it.

### O25. One grant for archive and restore, or two?
Today `record.archive` covers both, and its `when` condition applies to both directions: a lot
archived while on hold can only be restored by someone who may archive lots on hold. A separate
`record.restore` grant would let, for example, only Quality restore.

**Proposal:** two grants if restorers reach external systems. Otherwise one is enough.
**Needs:** a decision from the product owner.

### O26. Which identity does the MES use toward the external archive?
- The service's own identity (`service:<name>`, holding only the roles its design grants).
- The person who asked for the restore.

**Proposal:** the service's identity, so the external system sees one approved integration user. The
audit row still names the person the service acted for.

### O27. Who writes restored data back?
**Proposal:** the platform, never the service. The restorer only fetches. The platform:
1. checks the record against the hash taken at archive time;
2. validates it against the definition version it was archived under;
3. writes it back in the usual write shape, with an audit row naming the restorer and the result of
   the hash check.

If either check fails, nothing is written and the failure is audited.

### O28. Can an archived record be inspected without restoring it?
Part 11 §11.10(b) and (c) require records to stay readable for inspection throughout the retention
period. Restoring is a change to the record, so an inspector should not have to restore a record to
read it.

**Proposal:** yes. Restorers expose two operations:
- `fetch`, behind a read-only **View from archive**: it gets the package, checks it, and displays it.
- `restore`.

## History (the audit trail) when a record is archived

### O29. Does a record's history leave the MES with it?
- **A. Copy only.** A copy of the history goes into the package, and the audit rows stay in the MES
  unchanged. Restore has nothing to bring back.
- **B. The header stays and the body leaves.** Each audit row is split:
  - The **header** stays in the MES and is never modified: sequence number, time, actor, action,
    record, the body's digest, and the chain hashes.
  - The **body** (`before`, `after`, `rules`) can be offloaded.

  The chain hashes the body's digest, so it still verifies when the body is gone. Restore reattaches
  the bodies to their original rows after checking them against their digests. No rows are
  re-created, so sequence numbers and the chain do not change.
- **C. One chain per record,** anchored in a global chain. This is a redesign of the audit trail.

**Proposal:** B if database size or a retention policy is the driver, A otherwise. Audit rows are
small next to record data, so A may be enough. **Depends on:** O39.

### O30. If headers and bodies are split (O29 B), what happens to existing rows?
Existing rows cannot be re-hashed without breaking the chain.

**Proposal:** rows up to a cutover sequence number keep the current hash formula. Rows after it use
the digest formula. Verification switches formula at the cutover.

### O31. What counts as a record's history?
First cut:

| Goes with the record | Stays in the MES | Deleted after a retention period, not archived |
| --- | --- | --- |
| The record's own audit rows, including refused attempts and rule traces | E-signature records (they must stay linked to their records, Part 11 §11.70) | Outbox rows |
| | Service-call audits that mention the record (they belong to the service's history) | Idempotency results |
| | Genealogy links (other lots trace through this one) | |
| | The archive and restore rows themselves | |
| | Rows written while the record is archived | |

**Needs:** a review by QA and CSV.

### O32. What happens to related records when one is archived?
Examples: a lot's deviations, and its child lots.
- Archive them together (cascade).
- Refuse the archive while active records reference this one.
- Allow it, and show references to an archived record as archived.

**Proposal:** refuse while active records reference it. It is the simplest rule and keeps
traceability intact.

## Scale

### O33. When are the audit table's index, partitions and checkpoints added?
Today `audit_log` has only its primary key. The History tab and "Why can't I?" scan the whole table,
and get slower as every record's history grows, archive or not. Rough size of the headers: about
200 bytes per row including indexes, so ~300 million rows or ~60 GB a year at an assumed average of
10 writes per second.

**Proposal:**
1. Add an index on `(object, record_id, seq)` now.
2. Partition `audit_log` by month or year. History queries are limited to the record's lifetime, so
   they only touch the partitions they need, and old partitions can move to cheaper storage.
3. Write a signed checkpoint into the chain, for example monthly, so verification starts from the
   last checkpoint instead of from the first row.

### O34. How do lists and search stay fast as archived stubs accumulate?
- Put active and archived records in separate partitions of `mes.records`, so lists and search scan
  only active records.
- Replace search's `ILIKE` over every JSONB value (a full scan per object, which will not scale
  either way) with a trigram or full-text index on declared searchable fields.

**Proposal:** both, before a pilot plant.

## Reused natural keys (lot numbers reused every 10 years)

Every record's identity is its UUID. Audit rows, references and genealogy links all use the UUID,
so the 2016 lot 4711 and the 2026 lot 4711 never share history. The questions are about the natural
key.

### O35. Unique among what?
- **Among active records** (a partial unique index where `archived_at IS NULL`). A number can be
  reused once the old record is archived.
- **Within a scope,** such as `lot_no + item` or `lot_no + year`, when the customer's label carries
  that scope.

**Proposal:** a definition-level setting chosen by the object's stewards:
`unique: { fields: [...], among: "active" | "all" }`. The POC has no unique fields yet.

### O36. What happens when a reused number conflicts with a restore?
If the 2016 lot 4711 is restored while the 2026 lot 4711 is active:
- **Refuse,** with the reason: "Lot 4711 is in use by another lot (created 2026-03-02). Archive or
  rename it first."
- Restore it under a qualified title.

**Proposal:** refuse. Two active lots with one number is the ambiguity that traceability standards
(IATF 16949, AS9100) forbid.

### O37. How do lookups by lot number resolve?
Scanners, ERP messages, and services calling `ctx.records.list("lot", { lot_no })` look records up
by number.

**Proposal:**
- Lookups resolve to the active record only. `records.list` already leaves out archived records.
- Search shows both, told apart by date and an archived tag: "4711 · 2016 · archived" and
  "4711 · 2026".
- Stubs always keep their title field and creation date, even when everything else is offloaded,
  because after offload the stub is the only way to find an old record's history by its number.

### O38. How do the retention period and the reuse cycle relate?
If records are kept about as long as the reuse cycle, an old lot reaches the end of its retention
around when its number comes back. It can then be disposed of, with its own audited disposal
record, before the number is reused. Uniqueness among active records is then enough. If retention
runs longer than the reuse cycle (common in aerospace and medical devices), O35's scoped uniqueness
and O36's conflict check are needed.

**Needs:** each customer's retention periods. Also decide whether disposal at the end of retention
is part of release 1.

## What drives archiving

### O39. Why do customers archive?
- Database size and performance.
- A retention policy (keep for N years, then dispose).
- Keeping lists and search free of finished records.

The answer decides O20 (offload or not) and O29 (whether history leaves).
**Needs:** input from customers.

## The event log (DESIGN.md §7.6)

Built on the recommended defaults: each instance writes a hash-chained file first, and a job copies
it into `mes.event_log`. One row per instance, grouped into incidents by id. Refused calls are
counted per service, and each unknown outcome is logged on its own. Still open:

### O40. Who may read the event log?
- IT operations only, through the file and the table.
- Also QA and supervisors, through a "System events" screen in the MES.

**Proposal:** a screen for a role that the platform declares (for example `system:viewer`), assigned
like any other role. **Blocks:** the screen.

### O41. Is the event log a GxP record?
If it is part of validation evidence, it needs a set retention period, and the hash chain is
required rather than a nice-to-have. If it is operational only, it can be rotated and pruned freely.

**Proposal:** treat it as a GxP record, because it is the evidence for incidents (EU Annex 11 §13)
and for saves refused during an outage. **Needs:** QA and CSV.

### O42. Which events alert someone, and how?
Candidates: `db.down`, `instance.crash`, `instance.unclean_stop`, `trigger.dead`. Channels: email,
Teams, an andon board.

**Proposal:** alert on `critical` and `error` severities. The channel is each plant's choice.

### O43. How is the file rotated and kept?
**Proposal:** daily files, with the chain carried across files (each file's first event names the
previous file's last hash). Keep files for the retention period decided in O41.

## Demo instances on opencoremes.com

opencoremes.com hosts the product showcase and demo instances only; customers run the MES on
premises. Found in the code, these must be settled before a demo is public:
- ~~**Designer scripts can run arbitrary code on the host.**~~ **Closed 2026-10-02**: every script runs
  in the separate script runner (no credentials, Node's permission model, a context with nothing of
  the host in it, DESIGN.md §12.4). Left: the runner's OS user has the host's network until the
  deployment takes it away.
- **Service connections can call any address,** internal ones included, because a connection's
  `baseUrl` is arbitrary.
- **Anyone can sign in as anyone.** `POST /login` takes any user id without a password, in
  production mode too.
- **Visitors see each other's data** on a shared instance.
- **The copilot spends the AI key** on every anonymous visitor's request.

### O44. One sandbox per visitor, or one shared instance?
- **Per visitor:** "Start a demo" clones a fresh database from the seed
  (`CREATE DATABASE … TEMPLATE`, about a second), and a job deletes it after a set time (for
  example 4 hours).
- **Shared,** reset nightly: simpler, but visitors see and change each other's data.

**Proposal:** per visitor. With that, the password-less demo login is acceptable, because the users
are fictional and nobody else's data is reachable.

### O45. What may a demo visitor publish?
- Nothing that runs: draft, dry run, fitness test and submit, but approved scripts never execute.
- Everything, once the separate script runner exists (no credentials, no network, Node's
  permission model).

**The runner exists** (2026-10-02, DESIGN.md §12.4); what is left is its network. **Proposal:**
everything, once the demo's runner has no network. Either way, demo instances have no
outbound network, or only an allow-list of demo hosts, so a connection cannot reach internal
addresses.

### O46. Is the copilot on in the demo?
- Off, with a recorded walkthrough instead.
- On, with a cap per sandbox and per day, possibly on a cheaper model.
- On without a cap: not recommended.

**Proposal:** on with a cap, because the AI is part of what the product shows.

### O47. What abuse limits apply?
**Proposal:** a rate limit per IP address; caps per sandbox on records, change requests and
database size; and a cap on sandboxes that exist at once.

### O48. Where is the demo hosted?
- A single VM running PostgreSQL and the app, with sandboxes as databases.
- Containers (one app container, or one per sandbox) with a managed PostgreSQL.

**Proposal:** a single VM first. Sandboxes are databases, so it scales to many visitors before
containers are needed.

### O49. What does the showcase site contain?
**Proposal:** a static site, separate from the MES, with:
- what OpenCore MES is;
- the designer and the change lifecycle;
- "Why can't I?";
- archiving and traceability;
- the AI design tools;
- the Part 11 mapping;
- "Start a demo".

## Analytics (DESIGN.md §22)

Decided: every family of numbers is in scope; machine data comes from EDC or from operators, per
machine; measures, dashboards, equipment, downtime reasons and the calendar's design go through the
change lifecycle.

### O50. Who sees analytics?
- Everyone who may read the object.
- Only the roles each measure names (its audience).

**Proposal:** the measure's audience, denied by default, because aggregates can reveal what single
records hide.

### O51. How long are facts and rollups kept?
State intervals and equipment facts grow with the plant (equipment facts: ~20 events/s).

**Proposal:** detailed equipment facts for 2 years, rollups for the record retention period, state
intervals as long as their records. **Needs:** each customer's retention periods (see O38, O41).

### O52. Who owns the shift calendar, and how is it changed?
**Decided (2026-10-05), DESIGN.md §36:** a calendar per line with a plant default; its days changed by
audited edits, no approval (a day gone not at all); a cycle that repeats, so a new year needs no new
calendar.

From the scheduler discussion: next year's calendar must be published before the new year, and
holidays can be updated.
- Who drafts and approves it (production planning, HR, the plant manager)?
- Does an update to a published year need approval, or only an audited edit?
- One calendar per plant, or per line or work centre?
- If the new year arrives with no calendar: keep the standard pattern and alert, or block what
  depends on it (OEE availability, shift schedules)?

**Proposal:** per line with a plant default; planning drafts, the plant manager approves; holiday
updates to future days are audited records approved by the calendar's stewards; with no calendar,
keep the standard pattern and alert from 60 days before.

### O53. Who owns the downtime-reason taxonomy?
Reasons map to the six big losses and drive the loss Pareto. **Proposal:** a design element
stewarded by production and maintenance, with a plant-wide list and optional per-line additions.

### O54. When EDC and an operator disagree, who wins?
**Proposal:** EDC decides when a machine ran and stopped; operators assign reasons and may correct
times only as audited late entries, with a reason, which the supervisor sees.

### O55. What is a micro-stop?
**Proposal:** a stop shorter than a threshold set per machine (default 2 minutes) counts as
performance loss, not downtime, and needs no reason.

### O56. Where does ideal cycle time come from?
- Master data per item and machine (routing).
- Derived from the best observed rate.

**Proposal:** master data, with the observed best shown beside it so a wrong value stands out.

### O57. Does a measure used in a regulated decision need more?
A KPI used in batch release, or reported to a customer, is a GxP result. **Proposal:** a measure
can be marked regulated: its results are then kept per version with the facts they came from, and
its changes need QA among the approvers.

## Object relationships on forms (asked 2026-10-01, for later)

### O58. How are relationships between objects designed, and shown on forms?
Today a relationship is one `ref` field pointing at one record (a lot's work order). Nothing shows the
other direction (a work order's lots), and a screen can list related records but a form cannot.
**Asked:** forms that display related records, change them, and run transactions on them: a work
order's lots under the order, a lot's deviations under the lot, an operation's steps under the
operation.
**To decide:**
- Is a relationship its own design element (named, with a cardinality, one-to-many or many-to-many,
  and who stewards it), or read from `ref` fields as they are? Many-to-many needs a link object.
- A **related records section** in the form layout (§10.4): which relationship, its columns, sort, its
  **New** (creating a related record with the reference filled in), row buttons (open, remove, the
  transactions that appear on the related object), and editing a related row in place or in its own form.
- Saving: is a form with related rows saved as one (a transaction over the parent and its rows, §25),
  or each row on its own?
- Rights: each related row is read and written with the viewer's rights on its own object (§9), as a
  screen's table is (§26.2).
- Genealogy (IATF/AS9100): does a lot's "made from" relationship use the same element, with its trace
  view (§17.2)?

### O59. Approval of record changes: what is still open (§28)

Built: single changes to one record (values, a new record, an action) waiting for the stewards'
signatures, applied as the requester or void. Open:
- **Signing again** (Part 11 §11.200): an approval is signed by the session's user with a meaning, as
  design approvals are; re-entering a password or second factor to sign is not built (O1).
- **An apply interrupted** between the last signature and the write (a crash) leaves the request
  pending with every signature; it is applied by the next decision on it, not by itself. A sweep at
  start-up, or a "Apply now" for an approver, would settle it.
- **Stale is strict:** any write to the record voids it, even one to another field. Voiding only when
  an asked field (or the state) changed would void less often; it is a choice of rigour.
- **Several changes in one request** (many records, as an import is) are one request per record.
- **Notifications:** nobody is told a change waits except by looking (Approvals, the sign-in list).

