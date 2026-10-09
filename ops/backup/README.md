# Backups and restores (COMPLIANCE.md G2)

| | |
|---|---|
| `backup.sh` | One database: `pg_dump` (custom format), encrypted with AES-256 under a key file, its SHA-256 beside it, kept by date; the last 14 days and the first of each of the last 12 months kept; optionally copied off the machine (`BACKUP_COPY`). |
| `restore.sh` | A backup into a new database: its SHA-256 checked, decrypted, restored, then the audit trail's chain verified from its first entry. A failed restore leaves nothing behind. |
| `restore-test.sh` | The latest backup restored into `<name>_restore`, verified, compared with the live database, dropped: the evidence that backups can be restored. |
| `opencore-mes-backup.service`, `.timer` | Every night at 02:30 UTC, each database in `/etc/opencore-mes/backup.env`. |
| `opencore-mes-restore-test.service`, `.timer` | On the 1st of each month. |

On a host: a key (`openssl rand -base64 48 > /etc/opencore-mes/backup.key; chmod 0400`), kept also somewhere off the
machine (without it no backup restores); `/etc/opencore-mes/backup.env` with `BACKUP_DATABASES="postgres:///… …"`,
`BACKUP_DIR=/var/backups/opencore-mes` and, for a copy off the machine, `BACKUP_COPY="rclone copy {} remote:path/"`;
then `systemctl enable --now opencore-mes-backup.timer opencore-mes-restore-test.timer`.

Recovery objectives with these alone: a day's data at most (the point), a restore in minutes for a small plant
(the time; measure yours with `restore-test.sh`). For less than a day, add continuous WAL archiving
(pgBackRest or WAL-G), which this does not set up.
