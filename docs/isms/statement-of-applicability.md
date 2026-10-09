# Statement of Applicability (ISO/IEC 27001:2022 Annex A)

> **Draft to adopt, not a certification.** Owner: [security lead] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]

All 93 Annex A controls, for the scope in [scope.md](scope.md). For each: whether it applies and why;
how it is met (a **product** feature, with its file; an **ops** procedure; a **policy** in
[policies/](policies/)); and its status: **In place**, **Partial** (in place, with gaps), **Planned** (not
in place), or **N/A**. Statuses follow COMPLIANCE.md (checked 2026-10-06); G# are its gaps, H# the
planned PHI safeguards ([hipaa-security-rule.md](hipaa-security-rule.md)), R# the risks
([risk-register.md](risk-register.md)). Every control applies unless the row says otherwise. Organizational
controls stay "Planned" until the policies are approved and have run.

For a plant installing OpenCore MES itself, the rows marked **product** say what the software gives its
own ISMS.

## 5 Organizational controls

| Control | How it is met | Status |
| --- | --- | --- |
| 5.1 Policies for information security | Policy: [information-security.md](policies/information-security.md) and the topic policies, approved and reviewed yearly. | Planned |
| 5.2 Information security roles and responsibilities | Policy: roles in information-security.md (owner, security lead, privacy and HIPAA officer, engineers). | Planned |
| 5.3 Segregation of duties | Product: the author never reviews or approves; one person never signs two steps; the reviewer never approves (`app/mes/server/design.js`); record approvals never by the requester (`app/mes/server/record-requests.js`); the AI never reviews or approves (`app/mes/server/ai-api.js`). Ops: code reviewed by someone other than its author ([change-management.md](policies/change-management.md)). | Partial (product in place; branch protection not configured) |
| 5.4 Management responsibilities | Policy: the owner approves policies and resources, and chairs the management review. | Planned |
| 5.5 Contact with authorities | Policy: supervisory authority, HHS and law enforcement contacts listed by the privacy officer; used per [incident-response.md](policies/incident-response.md). | Planned |
| 5.6 Contact with special interest groups | Ops: subscriptions to Node.js, PostgreSQL, Caddy and Ubuntu security notices, GitHub advisories ([vulnerability-management.md](policies/vulnerability-management.md)). | Planned |
| 5.7 Threat intelligence | Ops: the same advisories, and CISA's known exploited vulnerabilities list, reviewed weekly; relevant items into the risk register. | Planned |
| 5.8 Information security in project management | Policy: a threat note in pull requests that touch security-relevant areas ([secure-development.md](policies/secure-development.md)); product features arrive as a whole slice with tests. | Partial (practice exists, not written as a requirement) |
| 5.9 Inventory of information and other associated assets | Ops: an asset inventory (servers, databases, repositories, domains, supplier accounts, keys, laptops) with owners, kept in the private ISMS location; the supplier register and the key inventory are part of it. | Planned |
| 5.10 Acceptable use of information and other associated assets | Policy: [acceptable-use.md](policies/acceptable-use.md), signed at joining and yearly. | Planned |
| 5.11 Return of assets | Policy: leaver checklist ([human-resources-security.md](policies/human-resources-security.md)). | Planned |
| 5.12 Classification of information | Policy: four classes: public (site, community edition), internal (private repositories, ISMS), confidential (customer data, secrets), restricted (PHI). Product: field-level read and write rights per object (`app/mes/server/policy.js`); PHI fields marked (planned, H1). | Planned |
| 5.13 Labelling of information | Product: PHI fields marked in an object's design and shown as such (planned, H1); demo and training instances labelled on every page. Ops: documents carry their class in the header. | Planned |
| 5.14 Information transfer | Product: HTTPS only (`ops/demo/Caddyfile`, Secure cookies); ldaps; exports limited to what the person may read (`app/mes/server/model-file.js`, `app/mes/server/transfer.js`). Policy: no customer data by email or chat; DPAs and BAAs with suppliers. | Partial |
| 5.15 Access control | Product: deny by default, explicit deny wins, per field and action (`app/mes/server/policy.js`), on every write (`app/mes/server/services.js`) and query (`app/mes/server/query.js`). Policy: [access-control.md](policies/access-control.md). | Partial (product in place; ops policy to run) |
| 5.16 Identity management | Product: only people active in People & departments sign in; identities changed by governed change (`app/mes/server/organization.js`); integration users with tokens. Ops: one account per person at every supplier. | Partial |
| 5.17 Authentication information | Product: scrypt passwords set through one-time links, ageing and history, TOTP with recovery codes, signing passwords (`app/mes/server/sign-in.js`, `app/mes/server/account.js`). Ops: password manager, MFA on every console. | Partial (product in place, G1 closed; ops to run) |
| 5.18 Access rights | Product: roles granted only through approved changes; sign-in administration (`app/mes/server/account.js`). Ops: quarterly access review. | Partial (no periodic access review yet, product or ops) |
| 5.19 Information security in supplier relationships | Policy: [supplier-management.md](policies/supplier-management.md). | Planned |
| 5.20 Addressing information security within supplier agreements | Policy: DPAs, BAAs (hosting, AI provider, email) before data reaches them. | Planned |
| 5.21 Managing information security in the ICT supply chain | Product: three runtime dependencies, lockfile, `npm ci`; Node checked by checksum (`ops/demo/provision.sh`). Ops: dependency scanning (G8). | Partial |
| 5.22 Monitoring, review and change management of supplier services | Policy: yearly supplier review of reports and contracts. | Planned |
| 5.23 Information security for use of cloud services | Policy: hosting and AI provider assessed; the AI provider's data flow written down and governed (G10); customers choose the AI provider or an in-house model (`app/mes/server/ai-gateway.js`). | Planned (G10) |
| 5.24 Information security incident management planning and preparation | Policy: [incident-response.md](policies/incident-response.md), yearly exercise. | Planned |
| 5.25 Assessment and decision on information security events | Policy: severities S1–S3; product: event log with severities (`app/mes/server/event-log.js`). | Planned |
| 5.26 Response to information security incidents | Policy: incident steps; product tools to contain (end sessions, revoke tokens, lift or set locks: `app/mes/server/account.js`). | Planned |
| 5.27 Learning from information security incidents | Policy: post-incident review within 10 working days into the risk register. | Planned |
| 5.28 Collection of evidence | Product: hash-chained audit trail and event log, verifiable (`app/mes/server/audit.js`, `app/mes/server/event-log.js`). Ops: snapshot and log export before changing a compromised server. | Partial (chain verification in progress, G3) |
| 5.29 Information security during disruption | Product: the database gate refuses calls in words during an outage and never saves twice (`app/mes/server/db-gate.js`); the script runner refuses to start without its walls (`SCRIPT_ISOLATION=required`). Policy: [business-continuity.md](policies/business-continuity.md). | Partial |
| 5.30 ICT readiness for business continuity | Ops: nightly encrypted backups and monthly restore tests (`ops/backup/`), recovery to a new server from git (G2). | Partial |
| 5.31 Legal, statutory, regulatory and contractual requirements | Policy: register of obligations (GDPR, HIPAA under BAA, contracts, customers' Part 11 / Annex 11). Product: Part 11 signatures with meaning, content hash, re-authentication (`app/mes/server/signatures.js`). | Partial |
| 5.32 Intellectual property rights | Ops: Apache-2.0 community edition (`LICENSE`, `NOTICE`), contributor agreement and DCO (`CONTRIBUTING.md`), dependencies' licences checked (ECharts Apache-2.0). | Partial (CLA link is a placeholder) |
| 5.33 Protection of records | Product: records archived, never deleted; audit trail append-only against update, delete and truncate (`app/mes/db/schema.sql`, `app/mes/db/migrate-append-only-truncate.sql`); every record sealed under a key outside the database, a change made around the platform found and closed with a signed non-conformance report (`app/mes/server/integrity.js`, G16). Ops: retention periods (G11), backups (`ops/backup/`, G2). | Partial (G11) |
| 5.34 Privacy and protection of PII | Product: field-level rights; titles instead of record ids in AI answers (`app/mes/server/titles.js`). Policy: retention, DPAs, PHI safeguards (H1–H6). | Planned (G10, G11, H1–H6) |
| 5.35 Independent review of information security | Ops: yearly internal audit by someone independent of the area; penetration test; the certification audits. | Planned |
| 5.36 Compliance with policies, rules and standards for information security | Ops: the review schedule in [logging-and-monitoring.md](policies/logging-and-monitoring.md) and [access-control.md](policies/access-control.md); COMPLIANCE.md kept current with the code. | Partial (COMPLIANCE.md maintained; reviews not yet run) |
| 5.37 Documented operating procedures | Ops: `ops/demo/README.md`, `app/mes/README.md` (running, scaling, sign-in, script runner), `docs/developers/`; the hosted service's runbooks to write (backup, restore, deploy user, alert handling). | Partial |

## 6 People controls

| Control | How it is met | Status |
| --- | --- | --- |
| 6.1 Screening | Policy: [human-resources-security.md](policies/human-resources-security.md), as the law allows. | Planned |
| 6.2 Terms and conditions of employment | Policy: confidentiality and security duties in contracts. | Planned |
| 6.3 Information security awareness, education and training | Policy: at joining and yearly, with records. | Planned |
| 6.4 Disciplinary process | Policy: in human-resources-security.md (also the HIPAA sanction policy). | Planned |
| 6.5 Responsibilities after termination or change of employment | Policy: same-day removal, confidentiality continues. | Planned |
| 6.6 Confidentiality or non-disclosure agreements | Policy: signed before access; contractors too. | Planned |
| 6.7 Remote working | Policy: [acceptable-use.md](policies/acceptable-use.md) (devices, places, networks). The team works remotely. | Planned |
| 6.8 Information security event reporting | Policy: report at once to [security channel]; outsiders to the security contact (a placeholder in `CONTRIBUTING.md`, G8). | Planned (G8) |

## 7 Physical controls

[Organization] has no data centre or server room: production runs at [hosting provider], whose
physical controls are inherited and evidenced by its SOC 2 / ISO 27001 reports (reviewed yearly,
[supplier-management.md](policies/supplier-management.md)). Staff work from home offices.

| Control | How it is met | Status |
| --- | --- | --- |
| 7.1 Physical security perimeters | Inherited from [hosting provider]. Applies through the supplier. | Planned (report to obtain) |
| 7.2 Physical entry | Inherited from [hosting provider]. | Planned (report to obtain) |
| 7.3 Securing offices, rooms and facilities | N/A for premises: no office holds customer data or servers; home offices covered by 7.7 and 8.1. | N/A |
| 7.4 Physical security monitoring | Inherited from [hosting provider]. | Planned (report to obtain) |
| 7.5 Protecting against physical and environmental threats | Inherited from [hosting provider]; backups in another region (G2). | Planned |
| 7.6 Working in secure areas | N/A: no secure areas of [Organization]'s own. | N/A |
| 7.7 Clear desk and clear screen | Policy: screen lock after 5 minutes, no customer data on screens others see (acceptable-use.md). Product: idle sessions end after 30 minutes (`SESSION_IDLE_MINUTES`). | Partial (product in place) |
| 7.8 Equipment siting and protection | Inherited from [hosting provider] for servers; laptops under 8.1. | Planned (report to obtain) |
| 7.9 Security of assets off-premises | Policy: encrypted laptops, reporting a loss at once. | Planned |
| 7.10 Storage media | Policy: no removable media with customer data; backups on encrypted provider storage (G2, G12). | Planned |
| 7.11 Supporting utilities | Inherited from [hosting provider]. | Planned (report to obtain) |
| 7.12 Cabling security | Inherited from [hosting provider]. | Planned (report to obtain) |
| 7.13 Equipment maintenance | Inherited for servers; laptops kept updated (acceptable-use.md). | Planned |
| 7.14 Secure disposal or re-use of equipment | Inherited for provider disks (the contract must say they are wiped); laptops wiped before reuse or disposal, recorded. | Planned |

## 8 Technological controls

| Control | How it is met | Status |
| --- | --- | --- |
| 8.1 User endpoint devices | Policy: encryption, screen lock, updates, malware protection (acceptable-use.md). Product, for plants: shared kiosks with their own idle time are planned, not built. | Planned |
| 8.2 Privileged access rights | Product: sign-in administrator role, design roles only through governed changes; `recover-designer.mjs` refuses unless nobody can change the system, and is audited. Ops: few people with server access; deploys still connect as root (G13). | Partial (G13) |
| 8.3 Information access restriction | Product: policies per object, state, field and action (`app/mes/server/policy.js`); queries over policy views as `mes_query` (`app/mes/server/query.js`); a pending request's values shown only to those who may see them (`app/mes/server/record-requests.js`). | In place (product) |
| 8.4 Access to source code | Ops: private repositories for suites and private files; write to `main` by reviewed pull request; the export refuses private files (`ops/release/export.mjs`). | Partial (branch protection not configured) |
| 8.5 Secure authentication | Product: OIDC with PKCE and checked ID tokens, LDAP over ldaps, scrypt passwords, lockout, TOTP, idle and absolute session limits, sessions stored hashed, re-authentication at signing (`app/mes/server/sign-in.js`, `app/mes/server/auth.js`, `app/mes/server/signatures.js`; tests `app/mes/test/auth.mjs`, `app/mes/test/auth-hardening.mjs`). Gap: no rate limit per address. Ops: MFA on every supplier console. | Partial (G1, G5, G7 closed; ops to run) |
| 8.6 Capacity management | Product: measured load (`app/mes/test/load.mjs`, results in `app/mes/README.md`), replica and several instances supported. Ops: host monitoring of disk, memory, CPU (G9). | Partial |
| 8.7 Protection against malware | Product: uploads kept only as pictures, PDF, CSV or xlsx by their bytes, served with `nosniff` and a sandboxing CSP (`app/mes/server/blobs.js`); scripts walled in (G14). Ops: laptops' malware protection; servers run only packaged software. | Partial |
| 8.8 Management of technical vulnerabilities | Policy: [vulnerability-management.md](policies/vulnerability-management.md). No scanning or contact yet. | Planned (G8) |
| 8.9 Configuration management | Ops: servers built from git (`ops/demo/provision.sh`, units, `ops/demo/demo.env` with no secrets); systemd sandboxing (`ops/demo/opencore-mes.service`). Gaps: firewall, SSH hardening, unattended upgrades, more sandboxing. | Partial (G13) |
| 8.10 Information deletion | Product: records archived only; no purge. Policy: [data-retention.md](policies/data-retention.md); deletion at the end of a service. | Planned (G11) |
| 8.11 Data masking | Product: a person sees only the fields their policies allow (`mask`, `app/mes/server/policy.js`); "why can't I?" hides what the reader cannot see. PHI masked by default and a "never to the AI" flag are planned (H2, G10). | Partial |
| 8.12 Data leakage prevention | Product: queries limited in rows, size and time (`app/mes/server/query.js`); exports only what the person may read; outbound connections to listed hosts (`MES_CONNECTION_HOSTS`, `app/mes/server/integration.js`); the copilot's data flow (G10). | Partial (G10) |
| 8.13 Information backup | Ops: [backup-and-restore.md](policies/backup-and-restore.md): nightly, encrypted, restore-tested monthly (`ops/backup/`). | Partial: WAL archiving planned |
| 8.14 Redundancy of information processing facilities | Product: replica with a replay fence, several instances over a change bus, a sticky balancer (`app/mes/server/routing.js`, `app/mes/lb.mjs`). Ops: single server today; offered per customer. | Partial |
| 8.15 Logging | Product: hash-chained, append-only audit trail and event log (`app/mes/server/audit.js`, `app/mes/server/event-log.js`). Policy denials audited (G4); the trail out of the application's role's reach (`ops/db/protect-audit.sql`, G3); writes made around the platform kept by a database tripwire, with the database user and address (`app/mes/db/migrate-integrity.sql`, G16). Gap: PHI reads (H3). | Partial (H3) |
| 8.16 Monitoring activities | Product: `/healthz` (database, audit, script runner), event log, sign-in administrators' inbox for locks and spraying. Product: alerts to a webhook and the journal (`app/mes/server/alerts.js`). Ops: an outside uptime check, log shipping. | Partial (G9: shipping) |
| 8.17 Clock synchronization | Product: audit times from the database clock (`clock_timestamp()`, `app/mes/db/schema.sql`). Ops: NTP on servers (systemd-timesyncd), checked at provisioning. | Partial (NTP not checked by the provisioning script) |
| 8.18 Use of privileged utility programs | Product: the console tools that change access (`app/mes/db/password.mjs`, `token.mjs`, `recover-designer.mjs`) record what they do in the audit trail (tokens by the operating-system user); `verify-audit.mjs` only reads. Ops: psql on production only during an incident or restore, with a reason recorded. | Partial |
| 8.19 Installation of software on operational systems | Ops: only through the deploy (tracked files, `npm ci` from the lockfile, tests on the server) and the provisioning script; suites through `opencore-mes suite`, each version kept (`app/mes/suite-install.mjs`). | Partial (deploys from a dirty tree are possible today) |
| 8.20 Networks security | Ops: the app on localhost behind Caddy with TLS and HSTS (`ops/demo/Caddyfile`). Gap: no firewall (G13). | Partial (G13) |
| 8.21 Security of network services | Ops: TLS by Caddy; DNS and registrar with lock and MFA; supplier terms. | Partial |
| 8.22 Segregation of networks | Product: the script runner's network namespace (bubblewrap, `ops/script-runner-sandbox.sh`, required on the demo); link-local refused and listed hosts for connections. Ops: hosted customers never on the demo's servers (R17). | Partial (G14 per installation) |
| 8.23 Web filtering | Applies narrowly: servers' outbound access limited to package mirrors, the AI provider and the customer's listed hosts (`MES_CONNECTION_HOSTS`). Laptops: browsers' safe browsing. A web proxy is not proportionate for this team. | Partial |
| 8.24 Use of cryptography | Policy: [cryptography-and-keys.md](policies/cryptography-and-keys.md). TLS, scrypt, SHA-256 in place; no encryption at rest. | Partial (G12, H4) |
| 8.25 Secure development life cycle | Policy: [secure-development.md](policies/secure-development.md); CI on every push (`.github/workflows/test.yml`). | Partial |
| 8.26 Application security requirements | Product: CSP, `X-Frame-Options`, `nosniff`, same-origin referrer (`app/mes/app.mjs`); JSON-only API calls and Origin checks; framing only by named origins (`EMBED_ORIGINS`, `app/mes/client/embed.js`). Gap: `'unsafe-eval'` on the designer's pages. | Partial (G6) |
| 8.27 Secure system architecture and engineering principles | Product: one write path through policies, rules and audit (`app/mes/server/services.js`); the framework boundary (`@opencore-mes/juris-kit`: its `REFERENCE.md` and `tests/boundary.test.mjs`, in its own repository); governed changes only. | In place (product) |
| 8.28 Secure coding | Policy: secure-development.md; parameterized SQL (`app/mes/server/record-sql.js`); review. | Partial |
| 8.29 Security testing in development and acceptance | Product: security suites in the pipeline (`app/mes/test/auth.mjs`, `auth-hardening.mjs`, `dual-sign.mjs`, `hardening.test.mjs`, `script-runner.test.mjs`); the HTTP contract kit (`docs/contracts/http-apis/kit.mjs`). Ops: penetration test. | Partial (no penetration test) |
| 8.30 Outsourced development | Applies only if a contractor writes code: the same review, CI and agreements as staff. None today. | N/A today |
| 8.31 Separation of development, test and production environments | Product: the pipeline refuses a database whose name lacks "test" (`tests/pipeline.mjs`); sandboxes and the test sandbox in databases of their own (`app/mes/server/sandbox.js`). Ops: hosted production on its own servers; `app/mes/db/reset.mjs` has no guard (R2). | Partial |
| 8.32 Change management | Product: design → review → approval → execution, hash-bound (`app/mes/server/design.js`). Ops: pull requests, CI, deploy with tests ([change-management.md](policies/change-management.md)). Gaps: emergency route, branch protection. | Partial (G15) |
| 8.33 Test information | Product: seeds and fixtures are made up (`app/mes/db/seed.mjs`); sandboxes copy records within the customer's own installation, as the person, never written back. Policy: no production data outside production. | In place |
| 8.34 Protection of information systems during audit testing | Ops: auditors get read-only evidence exports, not production access; tests against production only agreed and outside shifts; the contract kits are run against a test instance. | Planned |
