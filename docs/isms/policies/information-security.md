# Information security policy

> **Draft to adopt, not a certification.** Owner: [owner] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]

## Purpose

[Organization] keeps the information customers trust it with, and the service they depend on,
confidential, intact and available, and can show that it does. This is the top policy; the others in
this folder say how.

## Objectives (measured yearly at the management review)

1. No customer data disclosed to anyone the customer did not allow.
2. Every change to the service and the product goes through its change process, with its evidence
   ([change-management.md](change-management.md)).
3. The hosted service restored within its recovery objectives in every restore test
   ([backup-and-restore.md](backup-and-restore.md)).
4. Every critical or high vulnerability fixed within its deadline
   ([vulnerability-management.md](vulnerability-management.md)).
5. Every incident handled and notified on time ([incident-response.md](incident-response.md)).
6. The gaps in COMPLIANCE.md's register that the risk register marks "before the first hosted
   customer" closed before that customer.

## Roles

| Role | Who | Responsibilities |
| --- | --- | --- |
| Top management | [owner] | Approves the policies, the risk acceptances and the resources; chairs the management review. |
| Security lead | [security lead] (may be the owner) | Runs the ISMS: risk register, SoA, evidence, internal audit planning, supplier reviews, the security contact. |
| Privacy and HIPAA officer | [privacy officer] | The HIPAA security official (§164.308(a)(2)), data protection questions, breach notification decisions with the owner. |
| Engineers | [names] | Follow the policies; report events at once; keep their access to what their work needs. |
| Incident lead | Whoever is on call, or [security lead] | Leads an incident ([incident-response.md](incident-response.md)). |

One person may hold several roles. Where one person would both make and approve a change, the
product's lifecycle or a second engineer's review keeps them apart; where that is impossible, the
owner reviews afterwards and says so in the record.

## Commitments

- Information is protected by risk: risks are assessed at least yearly and at every significant change
  (a new supplier, a new kind of data such as PHI, a new hosting region), and recorded in
  [../risk-register.md](../risk-register.md).
- Legal, regulatory and contractual requirements are identified and met: GDPR, HIPAA where a BAA is
  signed, customers' contracts, and the obligations the product supports for regulated plants
  (21 CFR Part 11, EU Annex 11).
- Everyone with access knows these policies, is trained at joining and yearly, and reports security
  events at once ([human-resources-security.md](human-resources-security.md)).
- The ISMS is improved continually: nonconformities are recorded with a correction and a cause.

## Review, audit, improvement

- **Policy review:** each policy yearly, and after an incident or a significant change. A policy changed
  is re-approved and its version raised.
- **Internal audit:** yearly, by someone who did not run the area audited (another engineer, or an
  outside auditor for areas the security lead runs). The plan, findings and corrections are kept.
- **Management review:** yearly, and before a certification audit: objectives, audit results,
  incidents, risk changes, supplier reviews, customer feedback, resources, decisions.
- **Exceptions:** asked for in writing, with the risk, a compensating control and an end date;
  approved by [owner]; listed in the risk register.

## Evidence

The approved policies with their versions; the risk register and SoA versions; internal audit reports;
management review minutes; the exception list.
