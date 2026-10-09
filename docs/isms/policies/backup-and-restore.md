# Backup and restore policy

> **Draft to adopt, not a certification.** Owner: [security lead] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]

**Status: in place for nightly backups and monthly restore tests (`ops/backup/`, COMPLIANCE.md G2); WAL
archiving (point-in-time recovery) planned.** A streaming replica is supported (`app/mes/README.md`, "Read
scaling with a replica"), but a replica copies a mistake at once and is not a backup.

## Objectives (to agree with each customer; these are the defaults offered)

| | Default | Notes |
| --- | --- | --- |
| Recovery point objective (RPO) | 24 hours today; 15 minutes once WAL archiving runs | A backup nightly (`ops/backup/backup.sh`); continuous WAL archiving planned |
| Recovery time objective (RTO) | 8 hours | Restore to a new server from the provisioning script and the latest backup |
| Retention | 14 daily backups and 12 monthly (`KEEP_DAYS`, `KEEP_MONTHS`); 35 days of point-in-time recovery once WAL archiving runs | Longer only if a customer's contract requires it, and within [data-retention.md](data-retention.md) |

## What is backed up

- Each hosted customer's PostgreSQL database: records, designs, the audit trail, the event log, sessions,
  pictures and files (all in the database), copilot conversations.
- The event log files (`EVENT_LOG_DIR`) not yet copied into the database.
- The server's configuration is not backed up as such: it is rebuilt from git (provisioning script,
  units, environment files without secrets); secrets are re-issued from the password manager.

## How

1. **Backups** nightly at 02:30 UTC (`ops/backup/opencore-mes-backup.timer`: `pg_dump` of each database, a
   SHA-256 checksum beside it), copied by `BACKUP_COPY` to storage at [backup provider, region]: a
   different provider account from the production servers, so one compromised account cannot delete
   both. **WAL archiving** continuously (planned).
2. **Encrypted** before they are written (AES-256, the key in `/etc/opencore-mes/backup.key`, readable by
   root only, with a copy kept off the server: [cryptography-and-keys.md](cryptography-and-keys.md)).
   A backup without its key cannot be restored.
3. **Immutable** for their retention period where the storage offers it (object lock).
4. **Monitored**: a backup or archive that fails raises an alert the same day
   ([logging-and-monitoring.md](logging-and-monitoring.md)).

## Restore tests

Every month, automatically (`ops/backup/opencore-mes-restore-test.timer`): the latest backup's checksum is
checked, it is restored into a scratch database, its records are counted and the audit chain verified over
the whole trail (`node app/mes/db/verify-audit.mjs --full`), and the scratch database dropped; a failure
fails the unit, which the host's monitoring reports. Every quarter, and after any change to the backup
setup, by hand as well: restore the latest backup of [one customer, in rotation] to a scratch server;
start OpenCore MES on it; check that it starts and that the last change before the backup is there. Record the time taken
against the RTO, and the data lost against the RPO. Then destroy the scratch server and its data.

## Never

- Never run `npm run db:reset`, `db:reset:suites` or `app/mes/db/reset.mjs` against a hosted database:
  they wipe it with no backup (it has happened to the development database). `reset.mjs` refuses a
  database whose audit trail is protected (`ops/db/protect-audit.sql`): protect every hosted database.
- Never restore over a live database without a backup taken just before.

## Evidence

Backup job logs; the alert history; quarterly restore test records (date, backup used, point in time,
time taken, checks passed); the storage's retention and lock settings.
