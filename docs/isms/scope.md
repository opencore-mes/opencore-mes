# ISMS scope: the OpenCore MES hosted service

> **Draft to adopt, not a certification.** Owner: [owner] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]

## The scope statement

> The information security management system of [Organization] covers the design, development,
> operation and support of the OpenCore MES hosted service ([service name]): the software that runs it,
> the infrastructure it runs on, the data customers keep in it (including protected health information
> where a customer's BAA allows it), and the people, processes and suppliers that build and run it,
> from [location(s)] and remotely.

ISO/IEC 27001 clause 4.3 asks for this statement, with its boundaries and interfaces. SOC 2 calls the
same thing the "system description".

At [date] no customer is hosted yet. The scope takes effect with the first hosted customer, and the
SOC 2 observation window cannot start before then.

## In scope

| Area | What |
| --- | --- |
| The product | OpenCore MES as deployed for hosted customers: the community edition (this repository) and any suites a customer has licensed, at the releases deployed. |
| Customer data | Records, designs, people (ids, names, fields the customer adds), the audit trail, the event log, copilot conversations, attachments and pictures, sessions and tokens, backups of all of these. PHI only where a BAA is signed with that customer ([hipaa-security-rule.md](hipaa-security-rule.md)). |
| Infrastructure | The production servers for hosted customers ([hosting provider], [region]), their operating systems, PostgreSQL, Caddy (TLS), the systemd units, backups and their storage, monitoring. |
| Development | The source repositories (GitHub), CI (`.github/workflows/test.yml`), the release and deploy tooling (`ops/demo/deploy.sh` and its hosted-service equivalent), the npm packages (`ops/npm/`). |
| Supporting services | The domain and DNS, certificates (Let's Encrypt), email ([SMTP provider], planned), the AI provider (Anthropic) when a customer turns the copilot on, payments (a payment processor, for sold suites and courses). See [policies/supplier-management.md](policies/supplier-management.md). |
| People | [owner] and the engineers with access to any of the above, and contractors with such access. |
| Endpoints | The laptops those people use to reach source code, servers or customer data. |

## Out of scope, and why

| Out | Why |
| --- | --- |
| Plants that install OpenCore MES themselves | They run their own installation and their own ISMS. [Organization] supports them through the product, its documentation and security fixes (the "product" rows of the SoA). |
| The public demo (`demo.opencoremes.com`) and the training plant | Public sandboxes with no customer data: anyone signs in as anyone, every night they are reset (`ops/demo/README.md`). They are in scope only as a threat: they must never share a server, database, database role or secret with the hosted service. |
| The landing page (`opencoremes.com`) and the trainings site | Static or public content, no customer data. Their hosting is still covered by the infrastructure controls when it shares a host with something in scope (it must not: see above). |
| The suites registry and store | Holds licence tokens and, through its payment processor, payment records; no customer plant data. Covered by its own controls; brought into scope if a hosted customer's data ever reaches it. |
| Customers' own users, identity providers, networks, equipment and integrations | The customer's responsibility: their sign-in policy (OIDC or LDAP), who they make active in People & departments, their designs and policies, the systems their connections reach. The shared responsibilities are listed per control in [statement-of-applicability.md](statement-of-applicability.md) and [hipaa-security-rule.md](hipaa-security-rule.md). |
| Physical security of data centres | Inherited from [hosting provider] (its SOC 2 / ISO 27001 reports); [Organization] has no premises holding customer data. |

## Interfaces and dependencies

- **Customers** reach the service over HTTPS only; their integrations through `/svc/v1` and the AI
  through `/ai/v1`, each with a token (`docs/contracts/http-apis/`).
- **The customer's identity provider** (OIDC) or directory (LDAP over ldaps), when they use one
  (`app/mes/server/sign-in.js`).
- **Outbound**: connections a customer designs reach the hosts listed in `MES_CONNECTION_HOSTS` only
  (required on the hosted service), and the AI provider when the copilot is on.
- **Suppliers** above, each with the terms in the supplier policy.

## Locations

[Organization]'s registered address: [address]. Staff work remotely: [countries]. Production data
resides in [hosting provider, region]; backups in [backup location, region]. A customer who requires a
region is told which one before signing.
