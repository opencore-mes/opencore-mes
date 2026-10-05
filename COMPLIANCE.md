# Compliance: SOC 2 and ISO/IEC 27001 readiness

Where OpenCore MES stands against the SOC 2 Trust Services Criteria (Security, Availability,
Confidentiality, Privacy) and ISO/IEC 27001:2022 (its Annex A controls), what is missing, and what to do
about it. Checked against the code on 2026-10-03. Like every document here, it must match the code:
when a gap is closed, say so here in the same change, with the file that closes it.

## What these frameworks ask, and of whom

SOC 2 and ISO 27001 certify an **organization running a service**: its people, policies, risk
management and the evidence that its controls ran, over time. A codebase is not certified. What the
product decides is whether those controls are possible, and easy to prove.

Which of them we need depends on how OpenCore MES is run:

- **We host it for customers (SaaS):** we need SOC 2 (Type II, over 3 to 12 months) and/or ISO 27001
  ourselves, for the service and the organization behind it.
- **Customers install it themselves:** they audit their own installation. We need the product to
  support their controls (authentication, logging, backups, change control), and the regulated ones
  need 21 CFR Part 11 and EU Annex 11 support from it.

Either way, the product gaps below must be closed first. The organizational work is ours only for the
hosted model.

## Status at a glance

**Not ready.** The product's change control, authorization, audit trail and now its sign-in are
strong foundations. But there is no backup, and none of the organizational controls (policies, risk
assessment, incident response, supplier management) exist yet.

### What was the blocker

**Anyone could sign in as anyone, without a password.** No longer outside development and the demo:
people sign in through single sign-on (OpenID Connect, with PKCE and the ID token verified), the
plant's directory (LDAP or Active Directory, over ldaps), or a password of their own (scrypt, set
through a one-time link), with lockout, and each sign-in and refusal in the audit trail
(`app/mes/server/sign-in.js`, `app/mes/server/auth.js`; tested end to end against a stand-in provider
and directory in `app/mes/test/auth.mjs`). Only someone active in People & departments may sign in.
The picker (anyone as anyone) remains in development and on the public demo, by design, and is
refused elsewhere unless `PICKER=1` is set. Since 2026-10-05 a password sign-in may ask (or require) a
second factor, passwords age, sessions idle out, and every signature re-authenticates its signer
(`app/mes/test/auth-hardening.mjs`, against the SSO simulator).

## Control areas

Status: **Strong** (in place, evidence available) · **Partial** (in place, with gaps) · **Missing**.

| Area | SOC 2 | ISO 27001 Annex A | Status | Evidence in the product | Gap |
| --- | --- | --- | --- | --- | --- |
| Change management | CC8.1 | A.8.32, A.8.25 | **Strong** | Every design change goes through design, review, approval and execution (`app/mes/server/design.js`). Approvals are bound to a hash of the exact content approved, and execution checks it still matches. Authors, the reviewer and approvers are kept apart; one person never signs two steps. A fitness test (validation, script tests, scenarios in a sandbox) runs before submit. CI runs the whole test pipeline on every push and pull request (`.github/workflows/test.yml`); the demo deploy runs it again on the server before switching (`ops/demo/deploy.sh`). | Emergency changes are designed, not built. No branch protection or required-reviewer rule is written down. |
| Logical access: authorization | CC6.1, CC6.3 | A.5.15, A.5.18, A.8.3 | **Strong** | Deny by default, explicit deny wins, field-level masking (`app/mes/server/policy.js`); every write goes through the policy check (`app/mes/server/services.js`). Roles are given through the governed organization change. Record approvals: the requester never signs, one person never signs two steps (`app/mes/server/record-requests.js`). AI tokens: scoped, stored as SHA-256 hashes, revocable, rate-limited, never able to review or approve, and refused once the designer is no longer shared with their person (`app/mes/server/ai-api.js`); the in-app copilot is held to the change it was opened on and to an hourly ceiling of messages (`app/mes/server/copilot.js`). A pending record request shows a field's values only to its requester, its approvers and those who may read that field. | AI tokens never expire. No periodic access review is built or written down. |
| Logical access: authentication | CC6.1, CC6.2 | A.5.16, A.5.17, A.8.5 | **Partial** | Single sign-on (OIDC, PKCE, ID token signature, issuer, audience, expiry and nonce checked), LDAP/AD bind over ldaps, or local scrypt passwords set through one-time links; 5 wrong passwords lock the id for 15 minutes, counted in one statement so that tries sent at once neither pass the lock nor lift it; after sign-in the browser is sent only to a page of this site (`onThisSite`, `src/server/http.js`); only people active in People & departments sign in; the picker is off outside development and the demo (`app/mes/server/sign-in.js`, `app/mes/server/auth.js`, `app/mes/test/auth.mjs`). Session ids are 32 random bytes, kept server-side; the cookie is HttpOnly, SameSite=Lax and Secure outside dev (`src/server/http.js`); a sign-in from a mapped desktop says which one in its audit entry, and the address it goes by is the proxy's word only when the server is told a proxy is in front (`TRUST_PROXY`, `app/mes/server/desktops.js`); sessions end after 12 hours; deactivating a person ends theirs; a password change ends their other sessions. | No multi-factor for directory or local passwords (single sign-on brings the provider's). No password ageing or reuse check. No page for IT to issue a password link (a command does). No idle timeout. Session ids are stored as they are, not hashed. No cleanup of expired sessions. The load balancer's sticky cookie lacks Secure (`app/mes/lb.mjs`). |
| Audit trail | CC7.2, CC4.1 | A.8.15, A.5.28 | **Partial** | Every record write, design change, signature, transaction refusal, service call, sandbox opening and flow step is written to a SHA-256 hash chain, in the same database transaction as the change (`app/mes/server/audit.js`); triggers refuse updates, deletes and TRUNCATE (`app/mes/db/schema.sql`, `app/mes/db/migrate-append-only-truncate.sql`). Records are archived, never deleted. | The chain is never verified: `verifyAudit()` is called by nothing (no job, command or screen). The application's own database role owns the table, so it could drop the triggers that refuse changes to it. Plain access denials and AI token issue and revoke are not logged. No retention rule. |
| Electronic signatures (Part 11, Annex 11) | CC8.1 | A.5.31 | **Partial** | Approvals and record-request signatures carry their meaning and are bound to the content hash. A transaction verified by a second person is signed by two, each re-entering their password at every submit (own password, a signing password for single sign-on, or the directory; wrong ones count towards the lock), the verifier checked against the design's departments or roles; both names, ids and meanings are kept in the run's hash-chained audit entry (`app/mes/server/signatures.js`, `app/mes/test/dual-sign.mjs`). | A signature by one person alone, design and record-request approvals, still sign by the session, without re-authentication. |
| Backups and recovery | A1.2, A1.3 | A.8.13, A.5.29, A.5.30 | **Missing** | A streaming read replica is supported (`app/mes/README.md`); it is not a backup. | No backup, WAL archiving or point-in-time recovery; no restore procedure, recovery time or recovery point objective; no restore ever tested. |
| Encryption | CC6.1, CC6.7 | A.8.24 | **Partial** | TLS by Caddy with Let's Encrypt and HSTS (`ops/demo/Caddyfile`); the app listens on localhost behind it. Connection credentials live outside the designs, in the environment (`MES_SECRET_<NAME>`); the AI key in a root-owned file. | No encryption at rest (database, backups). Database connections are not over TLS (fine for a local socket only). Copilot conversations, which may hold record data, are stored in plain text. |
| Web application security | CC6.6, CC6.8 | A.8.26, A.8.28 | **Partial** | API calls must be JSON (a CSRF guard); form posts and sign-in check Origin; SQL is parameterized, identifiers checked; user-written SQL runs as a restricted role over policy views with a timeout (`app/mes/server/query.js`); rule scripts run in a separate process with Node's permission model and limits, in a context that imports nothing and holds no typed arrays, and the runner and its workers take their own network functions away at start (`app/mes/server/rules.js`, `script-worker.mjs`, `no-network.mjs`). Every page carries a Content-Security-Policy written by the server (its own scripts and the loader by hash, no inline script, requests and forms to the site only, `frame-ancestors 'none'`), with `X-Frame-Options`, `nosniff` and a same-origin referrer (`app/mes/app.mjs`, `src/server/kernel.js` `headers`). A connection is never sent to a link-local or unspecified address (a cloud's metadata service), and only to the hosts a plant lists when it lists any (`MES_CONNECTION_HOSTS`, `app/mes/server/integration.js` `addressOf`); the request goes to the address that was checked, under the host's name (`sendTo`), and its path is sent as checked. Uploaded workbooks are read within limits; a collected file opens in the page only as a picture, a PDF or text. The file store keeps only what its bytes show to be a picture, a PDF, a CSV file or an Excel workbook, serves each with `nosniff` and a sandboxing CSP, a document only as a download under a name made safe (`app/mes/server/blobs.js`). | The designer's pages alone allow `'unsafe-eval'` (its editors parse a script by building a function they never call; `app/mes/client/app.js` loads the designer afresh when it is come to from another page); every page allows inline styles. Sign-in locks an id after 5 wrong passwords, but has no rate limit per address. The script runner's operating-system walls (no network, a read-only file system: `ops/script-runner-sandbox.sh`, bubblewrap) are each installation's to turn on, and are off unless `SCRIPT_RUNNER_WRAP` is set; `/healthz` shows per instance whether they hold (`scripts.network`), and `SCRIPT_ISOLATION=required` refuses to start without them (G14). With no list of hosts, private addresses are reached, as a plant's systems are there. |
| Monitoring and incident detection | CC7.2, CC7.3 | A.8.16, A.5.25 | **Partial** | A hash-chained event log per instance (starts, stops, crashes, database outages, failed triggers), copied into the database (`app/mes/server/event-log.js`); `/healthz`. | No alerting, no log shipping, no screen to read the event log, no rotation of its file. |
| Vulnerability management | CC7.1 | A.8.8, A.8.7 | **Missing** | Three runtime dependencies (the database driver, the AI provider's SDK, Apache ECharts for charts, Apache-2.0, served to the browser from the app itself), with a lockfile; Node installed with its checksum checked (`ops/demo/provision.sh`). | No dependency scanning (`npm audit`, Dependabot); deploys run `npm ci --no-audit`. The security contact in `CONTRIBUTING.md` is a placeholder. No penetration test. |
| Infrastructure and operations | CC6.6, CC6.8 | A.8.9, A.8.20, A.8.22 | **Partial** | The service runs as its own user with systemd sandboxing (NoNewPrivileges, ProtectSystem=strict, ProtectHome, PrivateTmp) (`ops/demo/open-mes.service`). | Deploys connect as root. No firewall, SSH hardening or automatic security updates in provisioning. No CapabilityBoundingSet, IPAddressDeny or SystemCallFilter. Server access is not documented. |
| Data protection and privacy | P-series, C1.1, C1.2 | A.5.33, A.5.34, A.8.10, A.8.11 | **Missing** | People are an id, a name and whatever fields the plant adds to the Person object; records are archived, never deleted. | No retention or erasure rules (records, audit, Copilot conversations, sandbox selections). Real record data can reach the AI provider (the Copilot's dry runs read real records as the person) with no redaction or per-field flag. |
| Suppliers | CC9.2 | A.5.19 to A.5.23 | **Missing** | The AI provider is configurable (Anthropic, or any OpenAI-compatible endpoint); on the demo, connections call no outside system, but its Copilot does send what it is asked to its provider. | No supplier inventory or assessment (AI provider, hosting, DNS, certificates). |

## Gap register

In the order to do them. Size: **S** (days), **M** (one to three weeks), **L** (more). Owner left to fill in.

| # | Gap | Criteria | What to do | Size | Owner |
| --- | --- | --- | --- | --- | --- |
| G1 | ~~No authentication: anyone signs in as anyone~~ Done: OIDC, LDAP/AD and local passwords with lockout; the picker out of production; sign-in, refusals and sign-out audited (`app/mes/server/sign-in.js`). Closed 2026-10-05: password ageing and history (Part 11 §11.300: `PASSWORD_MAX_DAYS` 90, `PASSWORD_HISTORY` 5, an expired password changed at sign-in); a second factor for password sign-ins (an authenticator app, RFC 6238, with recovery codes; `MFA` optional or required); the Sign-in administration page issues password links, resets a second factor, lifts a lock, ends sessions, each audited (`app/mes/server/account.js`). Tested end to end with the SSO simulator (`app/mes/test/auth-hardening.mjs`). | CC6.1, A.8.5 | | S | Closed |
| G2 | No backups, no tested restore | A1.2, A.8.13 | Nightly base backup and WAL archiving to separate storage, encrypted; a written restore procedure; a restore tested every quarter; recovery time and recovery point objectives agreed. | M | |
| G3 | Audit chain never verified, and deletable by its owner | CC7.2, A.8.15 | A scheduled `verifyAudit()` with an alert on a break, and a command to run it by hand; the application connects as a role that may only insert and read `audit_log` (the schema owned by another). | M | |
| G4 | Missing audit events | CC7.2, A.8.15 | Policy denials, role and organization changes (already governed: check they are all there). Sign-in, refusals, sign-out, passwords, second factors, administration and token issue and revoke are audited (`$auth`; tokens since 2026-10-05, by whoever issues them, the command line included). | S | Partly closed 2026-10-05: tokens; policy denials and the organization check remain. |
| G5 | No re-authentication when signing | Part 11 §11.200, A.5.31 | Ask for the password, or a fresh SSO sign-in, at each signature; record the printed name. | M | Closed 2026-10-05: every signature (a transaction signed by one or verified by two, a change approved, a record change approved) asks its signer's password or a fresh sign-in at the identity provider (`prompt=login`, `max_age=0`, its `auth_time` checked; once, for that session and person, five minutes), where `SIGN_WITH_PASSWORD` is on (the default in production); the audit keeps the printed name and how it was proved (`app/mes/server/signatures.js`). |
| G6 | ~~No CSP or anti-framing header on the app~~ Done: every page carries a policy written by the server, with the hashes of its own inline scripts (`app/mes/app.mjs`; checked in `app/mes/test/record-approval.mjs` and `tests/framework/server.test.mjs`). `'unsafe-eval'` is allowed on the designer's pages only. Left: the designer's editors parse without it. | CC6.8, A.8.26 | Parse scripts in the editors without building a function, then drop `'unsafe-eval'` there too. | S | |
| G7 | Session hygiene | CC6.1, A.8.5 | An idle timeout; session ids stored hashed; expired sessions swept; Secure on the balancer's cookie; AI tokens with an expiry. | S | Closed 2026-10-05: `SESSION_IDLE_MINUTES` (30; activity is a page opened or a click or key, never polling); sessions kept by their SHA-256 (a database trigger hashes every insert); ended sessions swept at each sign-in; the bundled balancer's cookie is Secure over HTTPS (a plant's own balancer: set it there); tokens last 30 to 365 days (90 by default; those issued before, 90 more at least). |
| G8 | No dependency scanning; no security contact | CC7.1, A.8.8 | `npm audit` in CI (failing on high and critical), Dependabot; a real address and response time in `CONTRIBUTING.md` and a `SECURITY.md`. | S | |
| G9 | No alerting or log shipping | CC7.2, A.8.16 | Alerts on `/healthz` failing, database down, audit break, failed triggers; ship the event log and journald off the machine; rotate the event-log file. | M | Partly closed 2026-10-05: repeated sign-in failures: a lock is written to the event log (`auth.locked`), and ids locked and password spraying are in the sign-in administrators' inbox and page. The rest remains. |
| G10 | AI data flow not governed | P-series, A.5.23, A.8.11 | Write down what the Copilot may send to the provider (the design copilot: designs; the analytics copilot, §34: view and column names, and up to 40 rows of each query it runs as the person, every one audited); a per-field "never to the AI" flag honoured by its tools; a retention period for Copilot conversations; the provider's terms and data processing reviewed. | M | |
| G11 | Data retention and erasure | P4.2, A.5.33, A.8.10 | Retention periods per kind (records, audit, conversations, selections, sessions), set per plant; a way to purge what is past them where law allows (never the audit trail inside its period). | M | |
| G12 | Encryption at rest | CC6.7, A.8.24 | Encrypted disks or database storage, and encrypted backups (G2), with key management written down. | S | |
| G13 | Server hardening | CC6.6, A.8.9 | A firewall (only 443 and the SSH port open), SSH key-only and not as root, automatic security updates, more systemd sandboxing (capabilities, system calls; the script runner's network is G14). | S | |
| G14 | Script runner network; connection addresses. Done in the product: the runner removes its own network functions; connections refuse link-local addresses and keep to `MES_CONNECTION_HOSTS` when set. Built 2026-10-05: the operating system's walls, `ops/script-runner-sandbox.sh` (bubblewrap: a network namespace with loopback only, a read-only file system of the libraries, Node and `app/mes`, no capabilities) with `ops/script-runner-sandbox.apparmor` for Ubuntu 23.10 and later, where `unshare -r -n` is refused; the runner reports what it finds at start (any network, the sandbox), in the start log, the event log (`scripts.unisolated`, a warning, in production) and `/healthz` (`scripts.network`); `SCRIPT_ISOLATION=required` refuses to start without the walls (`app/mes/server/rules.js`, `server.mjs`, DESIGN.md §12.4, `app/mes/README.md` "Scripts: the runner's walls"). | CC6.8, A.8.22 | **Each installation, not the product:** install bubblewrap (and the AppArmor profile on Ubuntu), set `SCRIPT_RUNNER_WRAP=ops/script-runner-sandbox.sh`, confirm `/healthz` shows `"scripts": {"network": "none", "sandbox": "bwrap"}`, then set `SCRIPT_ISOLATION=required`; set `MES_CONNECTION_HOSTS` to the plant's systems. Evidence for an auditor is that `/healthz` output per instance, not the setting. The demo host: provisioned for it (`ops/demo/provision.sh`, `demo.env`, `deploy.sh` loads the profile and fails the deploy unless `/healthz` reports no network); verified there 2026-10-05 under the service's own systemd restrictions (as `openmes`: bubblewrap refused without the profile, "Failed RTM_NEWADDR"; with it the runner tests pass and the runner reports `network: "none"`, `sandbox: "bwrap"`), bubblewrap and the profile installed; on since release 20261005152922-4ba493c, with `SCRIPT_ISOLATION=required` (its `/healthz`: `"scripts": {"network": "none", "sandbox": "bwrap", "wrapped": true}`). Off Linux there is no wrapper, and `/healthz` says so. `npm test` tries the wrapper wherever bubblewrap works (`app/mes/test/script-runner.test.mjs`). | S | Built; open per installation |
| G15 | Emergency changes | CC8.1, A.8.32 | Build the designed emergency path (single approval, review after) with its audit, or write down that there is none. | M | |

## The organization's side (an ISMS)

None of this exists yet. It is needed for ISO 27001 certification and for a SOC 2 report, and only
if we run OpenCore MES for customers (or for ourselves as a regulated service).

- **Scope** of the management system: the service, the people, the locations, the suppliers.
- **Risk assessment** and **risk treatment plan**; for ISO 27001, the **Statement of Applicability**
  (each Annex A control: applies or not, why, and how).
- **Policies:** information security, access control, acceptable use, change management (largely
  what the product enforces already), secure development, encryption and keys, backup, logging and
  monitoring, incident response, business continuity, supplier management, data retention,
  vulnerability management.
- **People:** background checks where lawful, security training at joining and yearly, confidentiality
  agreements, offboarding that removes access the same day.
- **Assets:** an inventory of systems, data and the accounts that reach them (servers, GitHub, the
  domain registrar, the AI provider, certificates).
- **Incident response:** who decides, who is told (customers, authorities, within what time), a
  practised run-through.
- **Business continuity:** recovery objectives (with G2), a tested plan.
- **Assurance:** an internal audit and a management review before an ISO 27001 stage 1 audit; for
  SOC 2 Type II, controls operating for 3 to 12 months with evidence kept (a compliance platform helps
  collect it).

## What the product already proves for an auditor

Worth keeping as it is, and pointing auditors to:

- **Change control:** each design change with its author, reason, diff, reviewer, approvals by
  department with their meaning, the hash of what was approved, the fitness test's evidence, and when
  it was executed.
- **Separation of duties**, enforced by the platform rather than by procedure.
- **A tamper-evident audit trail** of every record write and design change, with who, when and on
  whose behalf (a person, a transaction, a flow, a service, the AI).
- **Records never deleted:** archived, read-only, restorable.
- **Least privilege by default:** nobody reads or writes anything a policy has not granted.
- **AI that can draft but never submit, review or approve**, its edits marked for reviewers.

## Related obligations

- **21 CFR Part 11 and EU Annex 11** (regulated manufacturing): change control, the audit trail and
  signature meaning are in place; authentication, re-authentication at signing and printed names (G1,
  G5) and backups (G2) are needed before a validated installation.
- **GDPR** (people's names, and anything plants put in records): retention and erasure (G11), the AI
  provider as a processor (G10).
