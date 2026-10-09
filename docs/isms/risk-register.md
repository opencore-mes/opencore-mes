# Risk register

> **Draft to adopt, not a certification.** Owner: [security lead] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]

The initial risks to the hosted service and to customers' data, assessed on 2026-10-06 from the code
and COMPLIANCE.md. Reassess yearly, after an incident, and at each significant change (a new supplier,
PHI, a new region).

**Method.** Likelihood and impact each 1 (low) to 3 (high); rating = likelihood × impact: 1–2 low, 3–4
medium, 6–9 high. Treatment: **reduce** (a control), **avoid**, **transfer** (contract, insurance) or
**accept** (signed by [owner]). "Before go-live" means before the first hosted customer. G# are the gaps in
COMPLIANCE.md; H# the planned PHI safeguards in [hipaa-security-rule.md](hipaa-security-rule.md); A.x the
Annex A controls in [statement-of-applicability.md](statement-of-applicability.md).

| # | Asset | Threat | L | I | Rating | Treatment | Owner | Link |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | Customer databases | Disk, server or provider loss with no backup: everything lost | 2 | 3 | **6 high** | Reduce: nightly encrypted backups and monthly restore tests (built, `ops/backup/`), copied off-account, WAL archiving. Before go-live. | [owner] | G2, A.8.13 |
| R2 | Customer databases | A reset or migration run against the wrong database (`app/mes/db/reset.mjs` wipes with no guard; it happened to the development database) | 2 | 3 | **6 high** | Reduce: `app/mes/db/reset.mjs` refuses a database whose audit trail is protected (`ops/db/protect-audit.sql`); no reset scripts reachable in hosted environments; backups (R1). | [security lead] | G2, A.8.31 |
| R3 | Production servers | An engineer's SSH key stolen from a laptop; deploys connect as root | 2 | 3 | **6 high** | Reduce: hardware-backed or passphrase keys, a deploy user without root, `sudo` with reasons, quarterly key review, disk encryption on laptops. | [security lead] | G13, A.8.2, A.8.1 |
| R4 | Production servers | Attack on an unhardened host: no firewall, password SSH or root login, missing security updates | 2 | 3 | **6 high** | Reduce: firewall (443 and SSH only), key-only SSH, no root login, unattended security upgrades, more systemd sandboxing. Before go-live. | [security lead] | G13, A.8.9, A.8.20 |
| R5 | The service, all customers | A vulnerable or malicious npm package (a dependency, or its dependencies) | 2 | 3 | **6 high** | Reduce: few dependencies, lockfile, `npm ci`; `npm audit` in CI and Dependabot; review of each dependency update. | [security lead] | G8, A.8.8, A.5.21 |
| R6 | Source code, then the service | A GitHub account taken over; malicious code merged and deployed | 1 | 3 | 3 medium | Reduce: MFA required, branch protection with required review and CI, deploy only from `main` commits that passed CI, never a dirty tree. | [owner] | A.8.4, A.8.32 |
| R7 | Audit trail | Tampering by whoever controls the application's database role (it owns the table and could drop the triggers); a break unnoticed | 1 | 3 | 3 medium | Reduce: scheduled chain verification with a critical alert (in progress); a separate owner role so the application may only insert and read. | [security lead] | G3, A.8.15 |
| R8 | Customer data, PHI | Record data or PHI sent to the AI provider without a DPA or BAA in place | 2 | 3 | **6 high** | Reduce: copilots off per hosted customer until agreed in writing; a "never to the AI" field flag; PHI kept from the copilots until a BAA covers it; or an in-house model. | [privacy officer] | G10, H6, A.5.23 |
| R9 | PHI in records | Read by plant staff who do not need it (policies too broad), unnoticed | 2 | 3 | **6 high** | Reduce: PHI fields marked, masked by default, reads logged, reviewed; customer guidance on minimum necessary policies. | [privacy officer] | H1–H3, A.8.11 |
| R10 | Disks, backups, snapshots | Data read from a provider's disk, snapshot or a stolen backup (no encryption at rest) | 1 | 3 | 3 medium | Reduce: encrypted volumes and encrypted backups; PHI fields encrypted. Before go-live. | [security lead] | G12, H4, A.8.24 |
| R11 | Sign-in | Credential stuffing or password spraying against password sign-ins | 2 | 2 | 4 medium | Reduce: lockout (in place), MFA required on the hosted service, alerts on locks and spraying (in place in the product), a rate limit per address (missing). | [security lead] | G1, G9, A.8.5 |
| R12 | The service | An outage or attack not noticed for hours: no alerting, logs only on the server | 3 | 2 | **6 high** | Reduce: uptime checks; alerts on the event log's errors (`db.down`, `audit.broken`, crashes) to a webhook (built, `ALERT_WEBHOOK_URL`); backups; logs shipped off the server. Before go-live. | [security lead] | G9, A.8.16 |
| R13 | Customer data | An engineer with server access reads or changes data outside the product (psql), unlogged | 1 | 3 | 3 medium | Reduce: few people with server access; access with a reason in a record; SSH and sudo logs shipped. The hash chain shows a change to the audit trail itself; the data integrity review (`app/mes/server/integrity.js`, COMPLIANCE.md G16) finds a record, design, person or role changed directly in the database, with the database user and address where its tripwire saw it, and each finding is closed only with a signed non-conformance report. | [owner] | A.8.2, A.8.18 |
| R14 | The whole service | One person holds most access and knowledge (the owner) | 3 | 2 | **6 high** | Reduce: a second named person per console; sealed break-glass record; runbooks in git. | [owner] | A.5.29, A.5.2 |
| R15 | Hosted service availability | The single hosting provider or region fails | 1 | 3 | 3 medium | Reduce: provider-neutral provisioning; restore in another region within the RTO; a replica for customers who pay for it. Transfer: provider SLA. | [owner] | A.5.30, A.8.14 |
| R16 | The domain | Registrar or DNS account taken over; the service's name pointed elsewhere (phishing customers' sign-ins) | 1 | 3 | 3 medium | Reduce: registrar lock, MFA, two named people, DNS change alerts; HSTS (in place). | [owner] | A.5.19, A.8.21 |
| R17 | Public demo on the same host | The public demo or training plant (anyone signs in, every role) shares a server with hosted customers' data; a breakout reaches them | 2 | 3 | **6 high** | Avoid: hosted customers never on the demo's servers, databases, roles or secrets. | [owner] | A.8.22, A.8.31 |
| R18 | The service | A designer-written script escapes its context and reaches the network or the host | 1 | 3 | 3 medium | Reduce: the runner's own walls (in place), bubblewrap with no network and `SCRIPT_ISOLATION=required` on every hosted instance, checked at deploy. | [security lead] | G14, A.8.22 |
| R19 | Customer networks | A designed connection used to reach internal or metadata addresses (SSRF) | 1 | 2 | 2 low | Reduce: link-local always refused (in place); `MES_CONNECTION_HOSTS` set for every hosted customer. | [security lead] | A.8.20 |
| R20 | Browser sessions | Cross-site scripting or injection in the app | 1 | 3 | 3 medium | Reduce: CSP on every page (in place), parameterized SQL, review; drop `'unsafe-eval'` on the designer's pages; penetration test. | [security lead] | G6, A.8.26, A.8.28 |
| R21 | Live configuration | An urgent fix forces a change around the lifecycle (direct database edit) because there is no emergency route | 2 | 2 | 4 medium | Reduce: build the emergency route, or write down that urgent changes take the normal route with reviewers called at once. | [owner] | G15, A.8.32 |
| R22 | Personal data, PHI | Kept longer than allowed, or not erasable when the law asks | 2 | 2 | 4 medium | Reduce: retention periods per kind, set per customer, and a purge (never the audit trail inside its period). | [privacy officer] | G11, A.5.33, A.8.10 |
| R23 | Customers' trust, legal | A breach notified late (HIPAA 60 days, GDPR 72 hours, contracts) | 1 | 3 | 3 medium | Reduce: the incident policy's deadlines, a yearly exercise, contacts kept current. | [privacy officer] | A.5.24–A.5.26 |
| R24 | Laptops | A laptop lost with source code, keys or `.env` secrets | 2 | 2 | 4 medium | Reduce: disk encryption, screen lock, keys with passphrases, no customer data on laptops, quick revocation. | [owner] | A.8.1, A.7.9 |
| R25 | TOTP keys | The second-factor keys stored readable in the database; a database copy lets someone generate codes | 1 | 2 | 2 low | Reduce: encrypt them under a key outside the database; accept until encryption at rest (R10). | [security lead] | A.8.24 |

## Accepted risks

None yet. Each acceptance names the risk, why, the compensating control, the end date and [owner]'s
signature.
