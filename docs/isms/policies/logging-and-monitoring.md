# Logging and monitoring policy

> **Draft to adopt, not a certification.** Owner: [security lead] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]

## What is logged

| Log | What it holds | Where | Status |
| --- | --- | --- | --- |
| **Audit trail** | Every record write, design change, signature (with printed name and how it was proved), transaction refusal, service call, sandbox opening, flow step; sign-ins, refusals, sign-outs, passwords, second factors, sign-in administration, token issue and revoke (`$auth`). Who, when, on whose behalf. | `mes.audit_log`, SHA-256 hash chain, written in the same database transaction as the change; triggers refuse update, delete and truncate (`app/mes/server/audit.js`, `app/mes/db/schema.sql`, `app/mes/db/migrate-append-only-truncate.sql`) | In place, with policy denials (`denied:*`, G4). Out of the application's role's reach once `ops/db/protect-audit.sql` is run (G3). |
| **Audit verification** | The chain checked from the last checkpoint every 15 minutes, result in `/healthz`, a break raised as a critical event; by hand with `node app/mes/db/verify-audit.mjs [--full]` | `app/mes/app.mjs`, `app/mes/server/audit.js` | In place (G3) |
| **Data integrity** | Writes made around the platform, straight in the database: to records, designs, people and roles. Who (the database user), from where, when, each field before and after (a sensitive one masked); what the scan found; each finding's signed non-conformance report; the signed periodic reviews | `mes.integrity_tripwire`, `mes.integrity_findings`, `mes.integrity_reviews`; every record's seal (`app/mes/server/integrity.js`, `app/mes/db/migrate-integrity.sql`) | In place (G16): scanned every 15 minutes, every record weekly; the plant's integrity reviewers close findings on **Design → Data integrity** |
| **Event log** | What happens to the system: starts, stops, crashes, unclean stops, database outages, unknown save outcomes, triggers given up, script runner without its walls, ids locked (`auth.locked`) | A hash-chained file per instance, copied into `mes.event_log` (append-only) (`app/mes/server/event-log.js`) | In place: the file set aside past 50 MB with its chain carried on; each event at or above `ALERT_MIN_SEVERITY` written to the journal as one `alert {…}` JSON line and posted to `ALERT_WEBHOOK_URL` (`app/mes/server/alerts.js`, G9). Gap: no screen to read it. |
| **Reads of PHI** | Who read which PHI field of which record | — | Planned (H3) |
| **Copilot data** | Every query the analytics copilot runs as the person (`$query`, `ai-query`), and each report it draws | `app/mes/server/reports.js` | In place. What the design copilot reads in its dry runs is not logged as such (G10). |
| **Web server and system** | Caddy access logs, journald (`journalctl -u opencore-mes`), SSH logins (auth.log) | The server | In place; shipping off the machine is the host's (below) |
| **Development and suppliers** | GitHub audit log, CI runs; consoles' own logs (hosting, registrar, Stripe, Anthropic) | The suppliers | Available; reviewed below |

Logs never hold passwords, tokens, secrets or connection credentials; the event log names an unknown
save by its keys, never its data. Time comes from the database clock for the audit trail; servers keep
time by NTP (systemd-timesyncd, Ubuntu's default; check it is on at provisioning).

## Monitoring and alerts

Required before the first hosted customer (G9), sent to [on-call channel] and [phone]. The application's own
events reach the channel through `ALERT_WEBHOOK_URL` (errors and critical events, the same kind at most once
in ten minutes, the ones held back counted in the next); the rest come from outside it:

| Alert | Source |
| --- | --- |
| The service is down, or `/healthz` fails | An outside uptime check every minute |
| The database is unreachable | `/healthz` `db`, event `db.down` |
| The audit chain is broken | `/healthz` `audit`, event `audit.broken` (critical) |
| A record, design, person or role changed outside the platform | `/healthz` `integrity`, event `integrity.violation` (critical) |
| The script runner lost its walls | `/healthz` `scripts.network` ≠ `none`; the instance also refuses to start with `SCRIPT_ISOLATION=required` |
| A trigger given up on, a crash, an unclean stop | Event log (`trigger.dead`, `instance.crash`, `instance.unclean_stop`) |
| Ids locked or password spraying | Event log `auth.locked`; the sign-in administrators' inbox (the customer's) |
| A backup or WAL archive failed | The backup job |
| A certificate expires within 14 days | The uptime check |
| Disk over 80 %, memory, CPU sustained | The host's monitoring |

## Shipping and keeping

The event log, journald and Caddy's logs are copied to [log store] off the server, within minutes, where
the server's own accounts cannot change or delete them (the host's log shipper, e.g. journald's remote
upload or the provider's agent; planned). Retention: one year online for
system logs; the audit trail for as long as [data-retention.md](data-retention.md) says (never shorter
than the customer's regulatory period).

## Review

- **Daily** (on working days): alerts and anything they did not cover, by whoever is on call.
- **Weekly**: the event log's warnings and errors, failed sign-ins and locks on the hosted service,
  the audit verification's status.
- **Monthly**: GitHub's audit log, who logged in to the servers (and why), console logins at suppliers.
- **Quarterly**: with the access review ([access-control.md](access-control.md)).

Each review leaves a dated note: what was looked at, what was found, what was done.

## Evidence

Alert history; the review notes; `/healthz` output per instance (audit, scripts); the log store's
retention settings.
