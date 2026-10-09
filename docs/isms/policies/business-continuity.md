# Business continuity policy

> **Draft to adopt, not a certification.** Owner: [owner] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]

## What must keep going

A plant runs its shifts on OpenCore MES: lots, equipment, signatures. The hosted service is the
critical process; support, sales and development can wait days.

| Process | Maximum tolerable outage | RTO | RPO |
| --- | --- | --- | --- |
| The hosted service, per customer | [24 hours] | 8 hours (default offered) | 15 minutes |
| Security fixes to the product | [7 days] | — | — |
| Support | [2 working days] | — | — |

Plants should also have their own manual fallback for a shift without the MES (paper travelers); the
product says when it cannot save and never saves twice on a retry (`app/mes/server/db-gate.js`), so
work can resume cleanly.

## Scenarios and responses

| Scenario | Response |
| --- | --- |
| Server or disk lost | Provision a new server from git (the provisioning script and units), restore the latest backup to the point of loss ([backup-and-restore.md](backup-and-restore.md)), point DNS at it. Needs G2 done. |
| The hosting provider or region down | Same as above in [second region or second provider]. Keep the provisioning script provider-neutral (plain Ubuntu, as `ops/demo/provision.sh` is). |
| Higher availability (a customer's contract asks it) | A streaming replica and several instances behind a balancer are supported (`app/mes/README.md`: replica, cluster, `app/mes/lb.mjs`); promoting the replica is a manual step to write down and test before it is offered. |
| Database corrupted or a bad change | Point-in-time restore before the event; or, for a design change, the governed rollback. |
| GitHub unavailable | Every engineer has a full clone; a deploy can run from a clean clone of the last released tag. |
| DNS or registrar account lost | Registrar lock, MFA, two named people with access; the zone exported and kept. |
| Certificate issuance fails | Caddy retries; certificates last 90 days and renew at about 60, so there are weeks to act. |
| AI provider down | The plant runs without the copilot; nothing else depends on it. |
| A key person unavailable ([owner] holds most access today) | Every console has a second named person; a sealed break-glass record of where credentials and recovery codes are, held by [backup holder]; runbooks in git (`ops/`). |

## Testing

Yearly: a full recovery of one customer's service to a new server from git and the backups, timed
against the RTO; and a walk-through of the key-person scenario. Quarterly restore tests count toward it.

## Evidence

The recovery test records; the second-person list per console; the exported DNS zone and its date.
