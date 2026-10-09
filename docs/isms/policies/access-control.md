# Access control policy

> **Draft to adopt, not a certification.** Owner: [security lead] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]

## Principles

Least privilege, deny by default, one person per account, access removed the day it is no longer
needed. This holds both inside the product and for the systems that run it.

## Inside the product (what each customer controls)

The product enforces these; the customer decides who gets what.

| Control | How the product does it |
| --- | --- |
| Who may sign in | Only a person active in People & departments; sign-in by the customer's OIDC provider, LDAP/AD over ldaps, or a password of their own (scrypt, set through a one-time link) (`app/mes/server/sign-in.js`, `app/mes/server/auth.js`). |
| Strength | Lockout after 5 wrong passwords for 15 minutes; password ageing and history (`PASSWORD_MAX_DAYS` 90, `PASSWORD_HISTORY` 5); a second factor for password sign-ins (`MFA`: `optional`, set `required` on the hosted service); single sign-on brings the provider's own. |
| Sessions | 32 random bytes, kept by their SHA-256, HttpOnly, Secure, SameSite=Lax; 30 minutes idle (`SESSION_IDLE_MINUTES`), 12 hours at most; deactivating a person or changing a password ends their sessions (`app/mes/server/auth.js`, `app/mes/db/migrate-auth-hardening.sql`). |
| What they may do | Policies per object, state, field and action, deny by default, explicit deny wins (`app/mes/server/policy.js`), applied to every write (`app/mes/server/services.js`) and every query (`app/mes/server/query.js`, the `mes_query` role over policy views). |
| Roles | Given only through a governed change to People & departments (`app/mes/server/organization.js`), approved by whom it affects. |
| Administration | Sign-in administrators (a role in People & departments) issue password links and setup codes (five letters on a printed slip, for everyone who has no password yet and has never signed in; only their hashes kept, five wrong tries spend one), reset second factors, lift locks, end sessions, each audited (`app/mes/server/account.js`). A person with a password here may move to the directory once it accepts their directory password; their password here is then removed, audited. |
| Machines and integrations | Tokens per integration user, scoped, stored as SHA-256, 30 to 365 days (90 by default), revocable, issue and revoke audited (`app/mes/server/ai-api.js`, `app/mes/db/token.mjs`). |
| The picker | Anyone as anyone: development and the demo only. It must never be on in the hosted service (`PICKER` unset, `DEMO` unset; checked at each deploy). |

**Customer's part:** whom they make active, the roles they grant, their identity provider's own
controls, and a periodic review of both (the product lists people and roles in People & departments;
a built access review report is planned).

## Operations (what [Organization] controls)

| System | Who | How |
| --- | --- | --- |
| Production servers | [named engineers], at most [n] | SSH keys only, one per person, no shared keys; no password login. Deploys as root today (G13): the target is a deploy user with only the rights a deploy needs, and root by `sudo` with a reason. |
| Production database | Nobody directly in normal work | The service connects by local socket as `opencore`; a person reaches the database only during an incident or a restore, with the reason written in the incident or change record. |
| Customer data inside the product | Nobody at [Organization] by default | Support signs in as a person only when the customer creates one for them and says so in writing; that access ends when the ticket closes. Under a BAA, PHI is reached only as the planned break-glass procedure allows ([../hipaa-security-rule.md](../hipaa-security-rule.md), H5). |
| GitHub | Engineers | Organization accounts with MFA required; write to `main` only through a reviewed pull request (branch protection: to be configured and written down, see [change-management.md](change-management.md)). |
| Registrar and DNS, hosting console, Stripe, Anthropic console, npm, email | [owner] plus one named backup | Each with MFA (a hardware key where offered), from a password manager; recovery codes kept offline. |
| Secrets (AI key, `MES_SECRET_<NAME>`, TLS keys) | The service user and root | Files readable only by root and the service (`/etc/opencore-mes/ai.env`, root:opencore 0640), never in git ([cryptography-and-keys.md](cryptography-and-keys.md)). |

## Joining, changing, leaving

- Access is asked for in a ticket naming the system and the reason, approved by [owner], and granted
  by someone other than the requester where possible.
- A change of role removes what the old role needed.
- Leaving: every account and key removed the same day, shared secrets they knew rotated within
  [5] working days ([human-resources-security.md](human-resources-security.md)).

## Reviews

Every quarter [security lead] lists who has access to each system above (server `authorized_keys`,
GitHub members, each console's users, the product's sign-in administrators on the hosted service) and
[owner] confirms or removes each. The list, with the date and the decisions, is the evidence.

## Evidence

Access tickets; the quarterly review lists; `authorized_keys` and console user exports; the product's
`$auth` audit entries (sign-ins, refusals, administration, tokens).
