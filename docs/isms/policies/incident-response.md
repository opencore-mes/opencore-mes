# Incident response policy

> **Draft to adopt, not a certification.** Owner: [security lead] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]

## What counts

A **security event** is anything that might affect the confidentiality, integrity or availability of
the hosted service or customer data: an alert, a strange log line, a lost laptop, a phishing email
clicked, a report from a customer or a researcher. An **incident** is an event the incident lead
decides is real or likely. A **breach** is an incident in which personal data or PHI was, or may have
been, disclosed, changed, lost or made unavailable to someone not allowed.

Everyone reports an event at once to [security channel / phone] and [security lead]. Outsiders report to
[security contact address] (the contact in `CONTRIBUTING.md`, still a placeholder: G8). Nobody is blamed
for reporting.

## Severity

| | Meaning | Response |
| --- | --- | --- |
| **S1** | Customer data exposed or likely exposed; PHI involved; the service down for all customers; an attacker in a server or account | At once, day or night; [owner] told within 1 hour |
| **S2** | One customer affected; a control failed (audit chain broken, a record or role changed outside the platform (`integrity.violation`), script runner walls lost, backups failing); a credential exposed | Within 4 hours |
| **S3** | No customer impact; a weakness found | Next working day |

## Steps

1. **Record**: open an incident record ([incident tracker]) with the time of discovery. All times in UTC.
2. **Lead**: the first engineer to respond leads until they hand over; the lead names who does what.
3. **Contain**: revoke tokens or sessions (Sign-in administration, `app/mes/server/account.js`; tokens in
   the designer), rotate exposed secrets, block an address at the firewall, take a server off the
   network, stop the service. Before changing a compromised server, keep evidence: a disk snapshot, the
   logs, `/healthz`, the audit and event logs (export `mes.audit_log` and `mes.event_log` for the
   period; their hash chains show whether they were altered: `app/mes/server/audit.js`,
   `app/mes/server/event-log.js`).
4. **Assess**: what data, which customers, how many people, whether PHI; decide whether it is a breach
   (below). Write down the reasoning, even when the answer is no.
5. **Eradicate and recover**: fix the cause through the change process (emergency route allowed,
   [change-management.md](change-management.md)); restore from backups if needed
   ([backup-and-restore.md](backup-and-restore.md)).
6. **Notify** as below.
7. **Learn**: within 10 working days of closing an S1 or S2, a short review (what happened, why, what
   changes); the changes go into the risk register and the backlog.

## Who must be told, and by when

The clock starts at **discovery** (when [Organization] knew, or by reasonable diligence would have
known). Decisions about notification are [owner]'s with [privacy officer]; legal advice is taken for any
S1.

| Who | When | When it applies |
| --- | --- | --- |
| **The customer** (each affected) | Without undue delay, and within the time in their contract (default offered: **48 hours** from discovery for a confirmed incident affecting their data), with what is known, then updates | Always, for any incident affecting their data or service. In the hosted service [Organization] is the customer's processor (GDPR) or business associate (HIPAA), so the customer is the one who notifies authorities and individuals unless the contract says otherwise. |
| **The customer, as a HIPAA covered entity or business associate** | Without unreasonable delay and **no later than 60 calendar days** after discovery (45 CFR §164.410), or sooner as the BAA says (the BAA should say, e.g. 5 days); with the individuals identified and the facts §164.410(c) lists | A breach of unsecured PHI held under a BAA |
| **Individuals and HHS** (by the covered entity, or by [Organization] if the BAA delegates it) | Individuals without unreasonable delay, no later than 60 days after discovery (§164.404); HHS at the same time if 500 or more people are affected, otherwise in the yearly log within 60 days of the year's end (§164.408); prominent media for more than 500 residents of a state or jurisdiction (§164.406) | A breach of unsecured PHI. "Unsecured" means not encrypted to HHS's guidance: a reason to build H4. |
| **The supervisory authority** (GDPR) | **Within 72 hours** of becoming aware (Art. 33), by the controller: the customer for their data; [Organization] for its own (staff, its own customers' contact and billing data) | A personal data breach, unless unlikely to result in a risk to people's rights |
| **Data subjects** (GDPR) | Without undue delay (Art. 34), by the controller | When the breach is likely to result in a high risk to them |
| **Other laws** | As each requires (US state breach laws, others where customers are) | [privacy officer] keeps the list for the countries customers are in |
| **Suppliers, insurers, law enforcement** | As their contracts and the case require | [cyber insurer, if any] |

What a notice says: what happened and when, what data and how many people, what has been done, what
the recipient should do, whom to contact. Every notice sent is kept with the incident.

## Practice

Once a year, a tabletop exercise of an S1 with PHI (for example: a laptop with an SSH key stolen; a
customer reports records changed that nobody approved). Recorded like an incident, marked as an
exercise.

## Evidence

Incident records with their timelines, decisions and notices; post-incident reviews; exercise records.
