# The information security management system (ISMS): a draft set

> **Draft to adopt, not a certification.** Written on 2026-10-06 from the code and
> [COMPLIANCE.md](../../COMPLIANCE.md). Nothing here is in force until [owner] has reviewed it, named the
> owners, approved it and dated it. Neither ISO/IEC 27001 nor SOC 2 certifies a document set: an
> accredited auditor certifies an organization whose controls have run, with evidence, over time.

## What this is

The documents an organization needs to run OpenCore MES as a service under ISO/IEC 27001:2022, a SOC 2
Type II report and the HIPAA Security Rule: the scope, the policies, the risk register, the Statement of
Applicability, the SOC 2 control matrix and the HIPAA safeguards. Each is short, written for a small team
(the owner and a few engineers), and says only what such a team can actually operate. Where the product
already enforces a control, the document points to the file that does it, and says "planned" for what is
not built. COMPLIANCE.md stays the product's own readiness record and its gap register (G1 to G15); these
documents cite it and never contradict it.

## Two ways OpenCore MES is run

| | Plants install it themselves | [Organization] hosts it for a customer |
| --- | --- | --- |
| Who is audited | The plant, for its own installation | [Organization], for the hosted service |
| What [Organization] owes | A product that supports the plant's controls (sign-in, audit trail, change control, logging, backups, Part 11 and Annex 11), documented, with a security contact and fixes | This whole set, operating: SOC 2 Type II and ISO/IEC 27001:2022 for the service |
| HIPAA | The plant decides whether PHI goes into records; the product must give it the safeguards (planned, see [hipaa-security-rule.md](hipaa-security-rule.md)) | [Organization] is the plant's business associate (or subcontractor) and signs a BAA before any PHI is hosted |
| Which documents apply | The product sections of the SoA, the SOC 2 matrix and the HIPAA table, read as "what the product gives you" | All of them |

A plant that installs OpenCore MES may borrow any of these policies as a starting point for its own.

## How to adopt it

1. **Review.** [owner] reads each document against how the organization really works and strikes or
   changes what it will not do. A policy that is not followed is worse than none: auditors test it.
2. **Name the owners.** Replace every `[owner]`, `[security lead]`, `[Organization]` and `[date]`. One
   person may hold several roles; separation of duties comes from the product and from review, not
   from headcount.
3. **Approve and date.** [owner] approves the set in writing (a signed commit, a dated record in the ISMS
   folder), with a next review date no later than a year away.
4. **Operate it and keep evidence.** Each policy ends with the evidence it produces. Keep it in
   [the ISMS evidence location] for at least the period the policy says (six years for anything the HIPAA
   documentation rule covers). SOC 2 Type II needs 3 to 12 months of it before the audit window closes.
5. **Close the gaps.** Work through the risk register's treatments and COMPLIANCE.md's gap register.
   A gap closed is written into COMPLIANCE.md in the same change, then into the SoA here.
6. **Check it.** An internal audit and a management review (both in
   [policies/information-security.md](policies/information-security.md)) before an ISO/IEC 27001 stage 1
   audit or the start of a SOC 2 observation window.

**Public or private.** The release export publishes `docs/` with the community edition
(`ops/release/export.mjs`). These templates may be public; the filled-in copies (names, suppliers'
contracts, the risk register with its owners, the asset inventory, hosts and addresses) are the
organization's records and are kept in [the private ISMS location], never in this repository.

## Index

| Document | What it is |
| --- | --- |
| [scope.md](scope.md) | What the ISMS covers for the hosted service, and what it does not |
| [risk-register.md](risk-register.md) | The initial risks, their treatment and owners |
| [statement-of-applicability.md](statement-of-applicability.md) | Every ISO/IEC 27001:2022 Annex A control: applies or not, how it is met, status |
| [soc2-control-matrix.md](soc2-control-matrix.md) | The Trust Services Criteria used, mapped to controls and evidence |
| [hipaa-security-rule.md](hipaa-security-rule.md) | The HIPAA Security Rule's safeguards, how each is met, and what is the plant's or the host's |
| **Policies** | |
| [information-security.md](policies/information-security.md) | The top policy: objectives, roles, review, internal audit |
| [access-control.md](policies/access-control.md) | Who reaches what, in the product and in operations |
| [change-management.md](policies/change-management.md) | Design changes in the product, and code changes to it |
| [secure-development.md](policies/secure-development.md) | How the code is written, reviewed and tested |
| [cryptography-and-keys.md](policies/cryptography-and-keys.md) | What is encrypted or hashed, and how keys and secrets are kept |
| [backup-and-restore.md](policies/backup-and-restore.md) | Backups, restore tests, recovery objectives |
| [logging-and-monitoring.md](policies/logging-and-monitoring.md) | The audit trail, the event log, alerts, reviews |
| [incident-response.md](policies/incident-response.md) | Handling an incident, and who must be told by when |
| [business-continuity.md](policies/business-continuity.md) | Keeping the service, or getting it back |
| [supplier-management.md](policies/supplier-management.md) | Each supplier, what it gets, its assurance, the contract needed |
| [data-retention.md](policies/data-retention.md) | How long each kind of data is kept, and how it goes |
| [vulnerability-management.md](policies/vulnerability-management.md) | Finding and fixing weaknesses |
| [acceptable-use.md](policies/acceptable-use.md) | What staff may and may not do with the organization's systems and data |
| [human-resources-security.md](policies/human-resources-security.md) | Joining, training, leaving |

Every document carries the same control block: owner, approved by, version, effective date, next review.
