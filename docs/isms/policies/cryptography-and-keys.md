# Cryptography and key management policy

> **Draft to adopt, not a certification.** Owner: [security lead] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]

## What is protected, and how

| Data | Protection | Where | Status |
| --- | --- | --- | --- |
| Traffic between browsers or integrations and the service | TLS 1.2+ by Caddy with Let's Encrypt certificates, HSTS; the app listens on localhost only | `ops/demo/Caddyfile`, `HOST=127.0.0.1` in the environment | In place |
| Sign-in to the customer's directory | ldaps (TLS), a plant CA by `LDAP_CA_FILE` | `app/mes/server/sign-in.js` | In place |
| Single sign-on | Authorization code with PKCE (S256); the ID token's signature checked against the provider's keys | `app/mes/server/sign-in.js` | In place |
| Passwords | scrypt (N 2^15, r 8, p 1), parameters in the hash; history kept as hashes | `app/mes/server/sign-in.js` | In place |
| Session ids, one-time password links, recovery codes, API tokens | Random; stored as SHA-256 only | `app/mes/server/auth.js`, `app/mes/db/migrate-auth-hardening.sql`, `app/mes/server/ai-api.js` | In place |
| Second-factor (TOTP) keys | AES-256-GCM under `SEAL_KEY` (or `SEAL_KEY_FILE`), a key kept outside the database and its backups; those kept before sealed by `app/mes/db/seal-secrets.mjs` | `app/mes/server/seal.js`, `mes.mfa` | In place (G12) where the key is set; without it, stored as they are |
| Audit trail and event log | SHA-256 hash chains (integrity, not secrecy) | `app/mes/server/audit.js`, `app/mes/server/event-log.js` | In place; verified every 15 minutes and by hand (`app/mes/db/verify-audit.mjs`, G3) |
| Records (data integrity) | HMAC-SHA256 seal per record under `INTEGRITY_KEY` (or `INTEGRITY_KEY_FILE`), 32 bytes, kept with the servers' environment, never in the database or its backups; designs and access sealed the same way. Without the key, a plain SHA-256 (finds a careless edit, not a deliberate one). A key changed: a reviewer re-seals everything, signed | `app/mes/server/integrity.js` | In place (G16) |
| Pictures and files | Kept by the SHA-256 of their bytes | `app/mes/server/blobs.js` | In place |
| Database at rest, backups | Encrypted disks or volumes; backups encrypted before they leave the server | — | **Missing** (G12, G2). Required before the first hosted customer |
| PHI fields | Field-level encryption at rest | — | Planned (H4 in [../hipaa-security-rule.md](../hipaa-security-rule.md)) |
| Copilot conversations | Stored in plain text; may hold record data | `mes.copilot_conversations` | Encryption with PHI (H4), retention (G11) planned |
| Database connections | Local socket only on the hosted service; TLS (`sslmode=verify-full`) required if the database is ever on another host | `DATABASE_URL` | In place on one host |

Algorithms in use: TLS as negotiated by Caddy and Node; SHA-256; scrypt; HMAC-SHA1 for TOTP (as RFC
6238 and authenticator apps require); RS/PS/ES signatures for ID tokens. No home-made cryptography.

## Secrets and keys

| Secret | Kept | Who | Rotated |
| --- | --- | --- | --- |
| AI provider key | `/etc/opencore-mes/ai.env`, root:opencore 0640, read by the service unit; never in git | Root, the service | Yearly, at a leaver, or at any suspicion |
| Connection secrets (`MES_SECRET_<NAME>`) | The server's environment file, same rights; never in designs, reviews or the audit trail | Root, the service | As the customer's system requires, and at any suspicion |
| OIDC client secret | The server's environment | Root, the service | Yearly or as the customer's IdP requires |
| TLS private keys | Caddy's storage, managed by Caddy | Root, Caddy | Automatically (Let's Encrypt, about every 60 days) |
| SSH keys | Each engineer's laptop, passphrase-protected (a hardware key where possible) | That engineer | At a lost device or leaver; reviewed quarterly |
| Seal key (`SEAL_KEY_FILE`) and integrity key (`INTEGRITY_KEY_FILE`) | `/etc/opencore-mes/seal.key`, `integrity.key`, root:opencore 0440 (the installation procedure, IN-13), with an offline copy held by [owner]; never in the database or its backups | Root, the service | At any suspicion. A new seal key: second factors set up again (or sealed again first); a new integrity key: a reviewer re-seals everything, signed |
| Backup encryption key | [password manager / KMS], with an offline copy held by [owner] | [owner], [backup holder] | Yearly; old keys kept for as long as backups made with them |
| Stripe, registrar, DNS, npm, GitHub tokens | The password manager; CI secrets in GitHub's encrypted secrets | Named people | Yearly, at a leaver, or at any suspicion |
| Integration and AI tokens issued by the product | Shown once; stored hashed; expire in 30 to 365 days | The customer | By expiry; revoked from the designer |

Rules: a secret is never committed, pasted into a ticket, chat or AI prompt, or written to a log. The
`.env` file is for development only and never committed (`.gitignore`). The release export refuses
private keys and API tokens (`ops/release/export.mjs`). A secret exposed is rotated at once and handled
as an incident.

## Evidence

The key inventory above, filled in, with rotation dates; disk-encryption settings of each server;
backup encryption configuration; Caddy's certificate log.
