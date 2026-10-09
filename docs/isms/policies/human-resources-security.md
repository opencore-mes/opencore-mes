# Human resources security policy

> **Draft to adopt, not a certification.** Owner: [owner] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]

## Before joining

- **Screening**, where the law allows and in proportion to the access: identity, right to work,
  references; a criminal record check for anyone who will reach production or PHI, where lawful in their
  country.
- **Agreements** signed before any access: confidentiality (also covering customer data and PHI),
  [acceptable-use.md](acceptable-use.md), intellectual property; for contractors, the same in their
  contract, with a DPA if they reach personal data.

## While working

- **Training** at joining (before access to production) and yearly: these policies, phishing, handling
  customer data and PHI (HIPAA's minimum necessary rule, breach reporting), secure coding for engineers.
  Each completion recorded.
- **Security reminders** when something changes (a new threat, an incident's lesson).
- **Roles** written down in [information-security.md](information-security.md).
- **Disciplinary process**: a breach of policy is handled by [owner] in proportion (a reminder, removal of
  access, the end of the contract), fairly and with the person heard; HIPAA requires sanctions to be
  applied and recorded.
- **Remote work**: from a private place; no customer data on screens others see; public Wi-Fi only
  through the work tools' own encryption (HTTPS, SSH).

## Leaving or changing role

- The same day: every account disabled, SSH keys removed from servers, GitHub and supplier
  consoles removed, tokens the person issued reviewed (the product's tokens expire; revoke those still
  needed under a new owner), devices and MFA keys returned.
- Within [5] working days: shared secrets they knew rotated ([cryptography-and-keys.md](cryptography-and-keys.md)).
- A reminder that confidentiality continues after they leave.
- The checklist, signed by [owner], is the evidence.

## Evidence

Signed agreements; screening records (kept as the law allows); training records; disciplinary records;
leaver checklists.
