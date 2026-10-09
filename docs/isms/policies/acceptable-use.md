# Acceptable use policy

> **Draft to adopt, not a certification.** Owner: [security lead] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]

For everyone with access to [Organization]'s systems, source code or customer data: staff and
contractors. Each signs it at joining and yearly.

## Devices

- Work is done on a laptop with full-disk encryption on (FileVault, BitLocker, LUKS), a screen lock
  after 5 minutes, automatic operating system updates, the vendor's malware protection on, and a firewall.
- SSH keys and the password manager are protected by a passphrase or hardware key. A lost or stolen
  device is reported at once ([incident-response.md](incident-response.md)); its keys are revoked.
- No customer data is kept on a laptop. Source code and development databases with made-up data are fine.
- Phones used for MFA or email have a screen lock and current updates.

## Accounts

- One person, one account; never share a login, key or MFA device. MFA on every work account that
  offers it.
- A password manager for every password; no password reused.
- Work accounts are for work.

## Customer data

- Reach customer data only when a task needs it and the customer allowed it
  ([access-control.md](access-control.md)); never copy it out of the hosted service.
- Never put customer data, PHI, secrets or production logs into an AI tool, a ticket, a chat, email, a
  public issue or a pull request.
- PHI is reached only under the break-glass procedure (planned, H5) and only under a BAA.

## Code and systems

- Never commit secrets, `.env` or private files (the project's private files are excluded from git and
  from the public export).
- Never run a database reset outside a named test database.
- Never turn off a security control (the script runner's walls, the CSP, sign-in settings, MFA on an
  account) without a change record.
- Install only software from the operating system's store or the vendor; no cracked or unknown tools.

## Communication

- Report anything suspicious at once: a phishing email, an unexpected MFA prompt, a strange server
  login.
- Speak about customers and incidents only with those who need to know.

Breaking this policy may lead to access being removed and to disciplinary action
([human-resources-security.md](human-resources-security.md)).
