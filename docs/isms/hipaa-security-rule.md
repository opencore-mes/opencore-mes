# HIPAA Security Rule: safeguards

> **Draft to adopt, not a certification.** Owner: [privacy officer] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]. Not legal advice: have counsel confirm each customer's HIPAA
> role and the BAA terms.

## When HIPAA applies

Some medical-device plants keep protected health information (PHI) in records: a patient's name, an
identifier or images on a patient-specific device's traveler. HIPAA applies to that data only when the
plant is a **covered entity** or, more often for a manufacturer, a **business associate** of one (a
hospital that sends patient data for a custom implant). Many manufacturers are neither, and then other
laws (GDPR, state laws) govern the same data. The plant decides; the product must make HIPAA's
safeguards possible either way.

| Model | Who is responsible |
| --- | --- |
| **The plant installs OpenCore MES** | The plant runs every safeguard below in its own installation. [Organization] is not a business associate (it never reaches the data) and supplies the product features marked "product". |
| **[Organization] hosts it** | [Organization] is the plant's business associate (or a subcontractor business associate) and signs a **BAA before any PHI is hosted**. It runs the administrative, physical and technical safeguards for the service; the plant still runs its own (its workforce, its policies in the product, who it makes active). |

## The PHI safeguards in the product

Referred to as H1–H6 across this set. Status as of 2026-10-06.

| # | Safeguard | What it does | Status |
| --- | --- | --- | --- |
| H1 | PHI fields marked | An object's design marks a field `sensitive: true`, under change control like every design; the design checks keep it out of titles, analytics dimensions, sorting and import keys. | **Built** (`app/mes/client/definition.js`) |
| H2 | Masked by default | A sensitive field is masked wherever records are shown or leave (pages, lists, screens, search, exports, model files), even for those whose policy lets them read it; showing it takes a reason, and a policy that hides it refuses. | **Built** (`app/mes/server/policy.js` `mask`, `records.reveal`) |
| H3 | Reads logged | Every showing is in the audit trail (`read:sensitive`: who, which record and field, why), and a refused one (`denied:read:<field>`); the audit trail itself never holds a sensitive value. | **Built** (`app/mes/test/sensitive.mjs`) |
| H4 | Encrypted at rest | PHI fields encrypted in the database under keys outside it, so a database copy or backup does not reveal them. | **Not built.** Meanwhile: the disk encrypted (G12) and backups encrypted (G2). |
| H5 | Break-glass access | In an emergency, access (a role, a policy) is given by an emergency change: one signature, reviewed afterwards within a set number of days, every step audited. | **Built as an emergency change** (G15, `app/mes/server/design.js`). Not built: access that expires by itself. |
| H6 | AI kept from PHI | A sensitive field has no column in the query views and is masked in every read, so no copilot or AI report receives it; the copilots are off unless a provider is set, and may use an in-house model. | **Built** for sensitive fields. Other record data reaches the provider only when a copilot is on: a BAA with it first, or an in-house model. |

Until H4 is built, the disk's encryption is its measure: a hosted customer keeps PHI only on an encrypted
volume, with its BAA signed; a self-hosting plant does the same, and leaves the copilots off or in-house.

R = required, A = addressable (implement it, or document why an equivalent measure or none is reasonable).
A 2025 proposed rule would make most addressable specifications required; check its status at each review.

## Administrative safeguards (§164.308)

| Standard / specification | R/A | How it is met | The plant's or the host's part |
| --- | --- | --- | --- |
| (a)(1) Security management: risk analysis | R | [risk-register.md](risk-register.md), with PHI risks R8, R9, R10 | Host: keep it current. Plant: its own analysis of its installation. |
| Risk management | R | Treatments in the risk register; COMPLIANCE.md gaps | Host |
| Sanction policy | R | [policies/human-resources-security.md](policies/human-resources-security.md) | Both, for their own workforce |
| Information system activity review | R | Audit trail and event log (`app/mes/server/audit.js`, `app/mes/server/event-log.js`); PHI reads (H3, `read:sensitive`); reviews per [policies/logging-and-monitoring.md](policies/logging-and-monitoring.md) | Host reviews the system; plant reviews its users' activity |
| (a)(2) Assigned security responsibility | R | [privacy officer] named in [policies/information-security.md](policies/information-security.md) | Each names its own |
| (a)(3) Workforce security: authorization/supervision | A | Access by ticket and approval ([policies/access-control.md](policies/access-control.md)) | Both |
| Workforce clearance | A | Screening ([policies/human-resources-security.md](policies/human-resources-security.md)) | Both |
| Termination procedures | A | Same-day removal; in the product, deactivating a person ends their sessions | Both |
| (a)(4) Information access management: isolating clearinghouse functions | R | N/A: no clearinghouse | — |
| Access authorization | A | Product: roles only through governed changes (`app/mes/server/organization.js`), policies per field (`app/mes/server/policy.js`); PHI fields granted narrowly (H1, H2) | Plant decides who; host for its own staff |
| Access establishment and modification | A | The same, with the audit trail of each change | Plant |
| (a)(5) Security awareness and training: reminders | A | Training and reminders | Both |
| Protection from malicious software | A | Uploads by their bytes (`app/mes/server/blobs.js`); script runner walls; laptops' protection | Host; plant for its endpoints |
| Log-in monitoring | A | Sign-ins and refusals audited (`$auth`); locks and password spraying in the administrators' inbox and `auth.locked` in the event log | Plant's administrators watch; host alerts through `ALERT_WEBHOOK_URL` (G9) |
| Password management | A | scrypt, ageing, history, lockout, MFA (`app/mes/server/sign-in.js`) | Plant sets its policy (or its IdP's) |
| (a)(6) Security incident procedures: response and reporting | R | [policies/incident-response.md](policies/incident-response.md) | Both; host notifies the plant per the BAA |
| (a)(7) Contingency plan: data backup plan | R | [policies/backup-and-restore.md](policies/backup-and-restore.md) | Host: nightly encrypted backups, monthly restore tests (`ops/backup/`, G2). Plant, self-hosted: its own, or the same scripts. |
| Disaster recovery plan | R | [policies/business-continuity.md](policies/business-continuity.md) | Host |
| Emergency mode operation plan | R | Business continuity; the database gate during outages (`app/mes/server/db-gate.js`); plant's paper fallback | Both |
| Testing and revision | A | Quarterly restore tests, yearly recovery test | Host |
| Applications and data criticality analysis | A | Business continuity's table of processes | Both |
| (a)(8) Evaluation | R | Yearly internal audit and review | Both |
| (b)(1) Business associate contracts | R | BAAs with the plant and with subcontractors that may receive PHI (hosting, AI provider, email): [policies/supplier-management.md](policies/supplier-management.md) | Host signs; plant signs with the host |

## Physical safeguards (§164.310)

| Standard / specification | R/A | How it is met | The plant's or the host's part |
| --- | --- | --- | --- |
| (a)(1) Facility access controls: contingency operations | A | Inherited from [hosting provider] | Host (provider's report); plant for its own servers when self-hosted |
| Facility security plan | A | Inherited | Same |
| Access control and validation procedures | A | Inherited | Same |
| Maintenance records | A | Inherited | Same |
| (b) Workstation use | R | [policies/acceptable-use.md](policies/acceptable-use.md) | Plant for its floor terminals; host for staff laptops |
| (c) Workstation security | R | Encrypted, locked laptops; idle sessions end (`SESSION_IDLE_MINUTES`, 30 by default) | Plant: shared terminals, kiosks (shorter kiosk idle time is designed, not built) |
| (d)(1) Device and media controls: disposal | R | Provider disk wiping; laptops wiped | Both |
| Media re-use | R | The same | Both |
| Accountability | A | Asset inventory | Both |
| Data backup and storage | A | Backups before moving equipment (G2) | Host |

## Technical safeguards (§164.312)

| Standard / specification | R/A | How it is met | The plant's or the host's part |
| --- | --- | --- | --- |
| (a)(1) Access control: unique user identification | R | **Product, in place:** every person has their own sign-in id; only people active in People & departments sign in; actions audited by id (`app/mes/server/auth.js`). The picker (anyone as anyone) exists only in development and on the demo and must never be on. | Plant: no shared accounts; the host checks `PICKER` and `DEMO` are off |
| Emergency access procedure | R | **Product, in place:** an emergency change gives access with one signature, reviewed afterwards (H5, G15). Meanwhile: the plant's sign-in administrators can grant roles only through a governed change, and `app/mes/db/recover-designer.mjs` restores design roles only when nobody can change the system; restore from backup for data loss | Plant defines who may break glass; host runs restores |
| Automatic logoff | A | **Product, in place:** sessions end after 30 minutes without activity (`SESSION_IDLE_MINUTES`) and after 12 hours in any case (`app/mes/server/auth.js`) | Plant sets the idle time; kiosks' own shorter time is designed, not built |
| Encryption and decryption | A | **Planned:** PHI fields encrypted (H4); database and backups encrypted at rest (G12, G2) | Host for the service; plant for its own installation (disk encryption) |
| (b) Audit controls | R | **Product, in place:** hash-chained, append-only audit trail of every write, signature and sign-in (`app/mes/server/audit.js`); verified every 15 minutes, a break raised as a critical event (G3); policy denials audited (G4); out of the application's role's reach with `ops/db/protect-audit.sql` (G3). **Planned:** reads of PHI (H3) | Plant reviews; host keeps and protects the trail |
| (c)(1) Integrity: mechanism to authenticate ePHI | A | **Product, in place:** each write checks the record's `row_version` and goes through policies and rules (`app/mes/server/services.js`); approvals bound to the content's hash (`app/mes/server/design.js`, `app/mes/server/record-requests.js`); the audit chain shows any change to the trail; every record sealed (HMAC-SHA256 under `INTEGRITY_KEY`), a record altered, added or deleted outside the platform found by the data integrity review (`app/mes/server/integrity.js`, COMPLIANCE.md G16) | Host: backups and restore integrity checks |
| (d) Person or entity authentication | R | **Product, in place:** OIDC, LDAP over ldaps, scrypt passwords, TOTP second factor, lockout; signatures re-authenticate (`app/mes/server/sign-in.js`, `app/mes/server/signatures.js`); integrations by hashed, expiring tokens (`app/mes/server/ai-api.js`) | Plant: `MFA=required` or an IdP with MFA for anyone granted PHI |
| (e)(1) Transmission security: integrity controls | A | **In place:** TLS for every connection (Caddy, `ops/demo/Caddyfile`); Secure cookies; ldaps | Plant: its own TLS when self-hosted (plain HTTP is not supported) |
| Encryption | A | **In place:** TLS 1.2+ and HSTS. PHI must not travel by email or to an AI provider without a BAA (H6) | Both |

## Organizational requirements (§164.314)

| Standard | R/A | How it is met |
| --- | --- | --- |
| (a) Business associate contracts | R | A BAA with each hosted customer that keeps PHI, before it is kept; BAAs with subcontractors that may receive PHI (hosting provider; AI provider before H6 lets PHI reach it; email provider if it ever carries PHI). The BAA states breach notice to the customer (no later than 60 days, §164.410; the BAA should set a shorter time), return or destruction at the end, and the subcontractor flow-down. |
| (b) Group health plans | R | N/A |

## Policies, procedures and documentation (§164.316)

| Standard / specification | R/A | How it is met |
| --- | --- | --- |
| (a) Policies and procedures | R | This set, adopted and approved ([README.md](README.md)) |
| (b)(1) Documentation | R | Written, versioned, with the actions and assessments they call for (incident records, reviews, risk assessments) |
| Time limit | R | Kept 6 years from creation or last effective date ([policies/data-retention.md](policies/data-retention.md)) |
| Availability | R | Available to those who apply them, in [the private ISMS location] |
| Updates | R | Reviewed yearly and at changes affecting ePHI |

## Before the first PHI is hosted

1. Every field that may hold PHI marked sensitive (H1); H4 built, or the disk encrypted and accepted as its measure.
2. Encryption at rest (G12). Backups with restore tests (G2) are built: install their timers and key.
3. Alerting set (`ALERT_WEBHOOK_URL`) and logs shipped off the server (G9); the audit trail protected (`ops/db/protect-audit.sql`, G3).
4. A hosting provider that signs a BAA; the AI provider's BAA, or the copilots off for PHI.
5. The customer's BAA signed, and its breach notice time agreed.
