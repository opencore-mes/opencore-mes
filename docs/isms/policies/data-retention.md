# Data retention policy

> **Draft to adopt, not a certification.** Owner: [privacy officer] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]

## Principles

Keep what the customer and the law need, for as long as they need it, and no longer. In the hosted
service the customer decides the periods for their data (they are the controller or covered entity);
[Organization] offers the defaults below and carries out the customer's choice. Regulated records
(Part 11, ISO 13485, AS9100, IATF 16949) often must be kept for the life of the product plus years: the
customer's quality system says how long.

**Status:** the product has no retention periods or purge today (COMPLIANCE.md G11): records are
archived, never deleted (`records.archive` / `records.restore`, `app/mes/server/services.js`), and the audit
trail cannot be deleted at all (append-only triggers). Until G11 is built, everything is kept for the
life of the customer's service, and deleted only at its end.

## Periods

| Data | Default | Decided by | How it goes |
| --- | --- | --- | --- |
| Records (lots, equipment, quality and the rest) | Life of the service | Customer (their regulatory period) | Archived in use; purged past the period where law allows (G11, planned) |
| Audit trail | At least as long as the records it describes; never shorter than the customer's regulatory period | Customer | Never inside its period; past it, only as a whole period with the chain's head kept (G11, planned) |
| PHI in records | The covered entity's period; under HIPAA documentation rules at least 6 years for the policies and records of safeguards | Customer | As records; masked or purged per field (planned, H1–H2, G11) |
| Copilot conversations | 90 days (offered) | Customer | Purged (planned, G10, G11) |
| Sandbox databases and selections | Until the change is executed or abandoned, then 30 days | [Organization] | Dropped |
| Sessions, sign-in steps, OIDC states | Until they end; swept at each sign-in | Product | Deleted (`app/mes/server/auth.js`) |
| Event log | 2 years | [Organization] | Purged (G9, G11) |
| System logs (journald, Caddy, SSH) | 1 year | [Organization] | Rotated off the log store |
| Backups | 35 days of PITR; monthly for 12 months | [Organization], per contract | Expire in the backup store |
| Customer data at the end of the service | Returned on request within 30 days (the model file: `app/mes/server/model-file.js`, and a database dump), then deleted from servers within 30 days and from backups as they expire | Contract | Written confirmation to the customer |
| [Organization]'s own records (contracts, invoices, ISMS evidence) | As law requires; ISMS evidence 3 years; HIPAA documentation 6 years from creation or last effective date | [owner] | Deleted at review |
| Staff data | As employment law requires | [owner] | Deleted at review |

## Erasure requests

A person's request to erase their data in the hosted service goes to the customer (controller), who
decides; [Organization] carries it out within 30 days of the customer's instruction, where it does not
conflict with a record the customer must keep. A person in People & departments is deactivated, not
deleted, because the audit trail names them; removing their name from regulated records is not allowed.

## Evidence

Each customer's chosen periods (in their contract or a written instruction); deletion confirmations at the
end of a service; purge logs once G11 is built.
