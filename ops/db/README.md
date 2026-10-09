# Database administration

Scripts a database administrator runs by hand, as `postgres` (or the database's owner), never the application.

## protect-audit.sql: the audit trail out of the application's reach

By default the application's own database role owns the audit trail (`mes.audit_log`) and its head, so whoever
holds that role's password could switch off the triggers that refuse changes to it. This script moves both into
a schema `audit` owned by `mes_audit`, a role nobody signs in as, and leaves views where the application writes.
From then on the application adds to the trail and reads it, and can no longer change, delete, truncate or drop
an entry, nor switch a trigger off. The scheduled check (`/healthz`, `node app/mes/db/verify-audit.mjs`) reads
`audit.audit_log` itself.

```bash
sudo -u postgres psql -v app=opencore -d opencore_mes_demo -f ops/db/protect-audit.sql
```

`app` names the application's role (the one in `DATABASE_URL`). Run it again after an upgrade whose release
notes say the audit trail gained a column; a migration that alters the table itself fails at start on a
protected database, saying which: run that migration as `postgres`, then this script.

Tested by `app/mes/test/audit-protect.mjs` (in `npm run test:all`, where the connection is a superuser).

Not for a database that is reset (the public demo, the training plant): a reset rebuilds the schema `mes`, and the
protected trail would be left behind it.
