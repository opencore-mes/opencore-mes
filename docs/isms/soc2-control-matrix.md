# SOC 2 control matrix

> **Draft to adopt, not a certification.** Owner: [security lead] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]

The Trust Services Criteria (AICPA, 2017, with the 2022 points of focus) chosen for the hosted service:
**Security** (the common criteria CC1–CC9, required), **Availability** (A1), **Confidentiality** (C1), and
**Privacy** (P, briefly: most of it falls to the customer as controller). Processing Integrity is not
chosen for the first report; the product's change control and audit trail would support it later.

Each row: the criterion (in short), the controls that meet it, the evidence an auditor samples, and the
status (as in [statement-of-applicability.md](statement-of-applicability.md)). A SOC 2 **Type II** report
needs these controls operating, with evidence, over an observation window of 3 to 12 months, which cannot
start before the "Planned" rows run and the first customer is hosted.

## Security: the common criteria

| Criterion | Controls | Evidence | Status |
| --- | --- | --- | --- |
| CC1.1 Integrity and ethical values | Acceptable use and HR policies, signed at joining and yearly | Signed acknowledgements | Planned |
| CC1.2 Oversight by the board or owner | The owner approves policies and chairs the management review | Review minutes | Planned |
| CC1.3 Structure, authority, responsibility | Roles in [information-security.md](policies/information-security.md) | Approved policy, role list | Planned |
| CC1.4 Competence | Screening, training at joining and yearly | Training records | Planned |
| CC1.5 Accountability | Disciplinary process; objectives reviewed yearly | HR records, review minutes | Planned |
| CC2.1 Quality information for internal control | Logs and `/healthz`; COMPLIANCE.md kept current with the code | Monitoring reviews, COMPLIANCE.md history | Partial |
| CC2.2 Internal communication | Policies published to staff; security reminders; event reporting channel | Training records, channel | Planned |
| CC2.3 External communication | Security contact and `SECURITY.md` (G8); customer notices of incidents, changes and sub-processors; published contracts (`docs/contracts/`) | Contact page, notices sent | Partial (G8) |
| CC3.1 Objectives specified | Objectives in the information security policy | Approved policy | Planned |
| CC3.2 Risks identified and analysed | [risk-register.md](risk-register.md), yearly and at change | Register versions | Planned (draft exists) |
| CC3.3 Fraud risk considered | Separation of duties enforced by the product (`app/mes/server/design.js`, `app/mes/server/record-requests.js`); insider risks R13 | Risk register | Partial |
| CC3.4 Significant changes assessed | Risk assessment at new suppliers, PHI, regions | Register entries | Planned |
| CC4.1 Ongoing and separate evaluations | Weekly and monthly log reviews; quarterly access reviews; yearly internal audit; penetration test; audit chain verification (in progress, G3) | Review notes, audit reports | Planned |
| CC4.2 Deficiencies communicated and corrected | Findings into the gap register (COMPLIANCE.md) and risk register, with owners and dates | Registers | Partial |
| CC5.1 Control activities chosen | The SoA and this matrix | Approved versions | Planned |
| CC5.2 Technology general controls | Product controls in CC6–CC8; server baseline (G13) | Configuration, `/healthz` | Partial |
| CC5.3 Policies and procedures deployed | The policies in [policies/](policies/), runbooks (`ops/`, `app/mes/README.md`) | Approved policies | Planned |
| CC6.1 Logical access security | Deny-by-default policies (`app/mes/server/policy.js`), sign-in by OIDC, LDAP or scrypt passwords, MFA, sessions hashed (`app/mes/server/sign-in.js`, `app/mes/server/auth.js`); TLS; encryption at rest missing | Configuration of the hosted instance (`MFA=required`, `SIGN_WITH_PASSWORD`), test suites, `$auth` audit entries | Partial (G12) |
| CC6.2 Registering and authorizing users | Only people active in People & departments, added by governed change (`app/mes/server/organization.js`); ops access by ticket | Change requests, tickets | Partial |
| CC6.3 Changing and removing access | Roles by governed change; deactivation ends sessions; leaver checklist; quarterly review | Change requests, review lists, leaver checklists | Partial (no periodic review yet) |
| CC6.4 Physical access | Inherited from [hosting provider] | Its SOC 2 report, reviewed | Planned |
| CC6.5 Disposal of assets | Provider disk wiping in contract; laptops wiped; data deleted at the end of a service | Contract, disposal records | Planned |
| CC6.6 Boundary protection | Caddy TLS, the app on localhost (`ops/demo/Caddyfile`); firewall and SSH hardening (G13); connections to listed hosts, link-local refused (`app/mes/server/integration.js`) | Firewall rules, configuration | Partial (G13) |
| CC6.7 Data in transit and at rest | TLS and HSTS; ldaps; no data by email; encryption at rest and of backups planned | Caddy configuration; disk encryption settings | Partial (G12) |
| CC6.8 Unauthorized or malicious software | CSP (`app/mes/app.mjs`); uploads by their bytes (`app/mes/server/blobs.js`); script runner walls (`ops/script-runner-sandbox.sh`, `SCRIPT_ISOLATION=required`); dependency scanning (G8) | `/healthz` `scripts`, deploy logs | Partial (G6, G8) |
| CC7.1 Detecting configuration changes and vulnerabilities | Vulnerability policy; scans (G8); `/healthz` checked at deploy | Scan results, deploy logs | Planned (G8) |
| CC7.2 Monitoring for anomalies | Audit trail and event log (`app/mes/server/audit.js`, `app/mes/server/event-log.js`); locks and spraying in the administrators' inbox; policy denials audited (G4); alerts to a webhook (`app/mes/server/alerts.js`, G9); records, designs, people and roles changed outside the platform found every 15 minutes, each a critical event, closed with a signed non-conformance report (`app/mes/server/integrity.js`, G16); shipping off the server the host's | Alert history, review notes | Partial (G9: shipping) |
| CC7.3 Evaluating security events | Severities and assessment in [incident-response.md](policies/incident-response.md) | Incident records | Planned |
| CC7.4 Responding to incidents | Incident steps, containment tools (`app/mes/server/account.js`), notification table | Incident records, notices | Planned |
| CC7.5 Recovering from incidents | Restore (`ops/backup/restore.sh`), post-incident review | Restore records, reviews | Partial: built, reviews to run |
| CC8.1 Change management | Product lifecycle (`app/mes/server/design.js`, `app/mes/server/fitness.js`, `app/mes/server/signatures.js`); pull requests, CI (`.github/workflows/test.yml`), deploy with tests (`ops/demo/deploy.sh`) | Change requests with approvals and hashes; pull requests and CI runs; deploy logs | Partial (G15, branch protection) |
| CC9.1 Business disruption risk | [business-continuity.md](policies/business-continuity.md), backups (G2); insurance [if any] | Recovery tests | Planned |
| CC9.2 Vendors and business partners | [supplier-management.md](policies/supplier-management.md) | Supplier register, reports reviewed, DPAs and BAAs | Planned |

## Availability

| Criterion | Controls | Evidence | Status |
| --- | --- | --- | --- |
| A1.1 Capacity | Load measurements (`app/mes/test/load.mjs`, `app/mes/README.md`); replica and instances; host monitoring | Monitoring graphs, capacity reviews | Partial |
| A1.2 Environmental protections, backup, recovery infrastructure | Provider's data centre; backups and WAL archiving off-account; database gate during outages (`app/mes/server/db-gate.js`) | Provider report; backup logs | Partial: nightly encrypted backups built (`ops/backup/`); WAL archiving planned |
| A1.3 Recovery testing | Monthly automatic restore tests (`ops/backup/restore-test.sh`), quarterly by hand, yearly full recovery | Test records against RTO and RPO | Partial: automatic test built |

## Confidentiality

| Criterion | Controls | Evidence | Status |
| --- | --- | --- | --- |
| C1.1 Confidential information identified and protected | Classification (SoA 5.12); field-level rights and masking (`app/mes/server/policy.js`); PHI marked and masked (H1, H2); the AI data flow governed (G10) | Policies, designs, configuration | Partial (G10, H1–H2) |
| C1.2 Confidential information disposed of | Retention and deletion at the end of a service ([data-retention.md](policies/data-retention.md)) | Deletion confirmations | Planned (G11) |

## Privacy (brief)

In the hosted service the customer is the controller of the personal data in it (people's names and ids,
whatever their records hold); [Organization] processes it on their instructions. The privacy criteria are
therefore met mostly by the customer, with [Organization] supporting them; [Organization] is controller
only for its own customers' contacts, billing and staff data.

| Criterion | [Organization]'s part | Status |
| --- | --- | --- |
| P1 Notice | A privacy notice for its own site, sales and support; customers' notices to their staff are theirs | Planned |
| P2 Choice and consent | The customer's; for its own data, consent where required | Planned |
| P3 Collection | Only what the service needs; the product holds the fields the customer designs | Planned |
| P4 Use, retention, disposal | Retention per customer and purge (G11); copilot conversations' period (G10) | Planned (G10, G11) |
| P5 Access | Customers export people and records (`app/mes/server/model-file.js`, `app/mes/server/transfer.js`) to answer access requests | Partial |
| P6 Disclosure and notification | Sub-processors listed; breach notices per [incident-response.md](policies/incident-response.md) | Planned |
| P7 Quality | People correct their data through the customer's own governed changes | Partial |
| P8 Monitoring and enforcement | Complaints to [privacy contact]; yearly review | Planned |
