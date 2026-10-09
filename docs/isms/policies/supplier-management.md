# Supplier management policy

> **Draft to adopt, not a certification.** Owner: [security lead] · Approved by: [owner] · Version 0.1 ·
> Effective: [date] · Next review: [date]

## Rules

1. **Before use**: every supplier that will hold, process or reach customer data, the source code or the
   servers is assessed: what data it gets, its assurance (SOC 2 Type II report, ISO/IEC 27001 certificate,
   or a questionnaire for smaller ones), its contract terms, where data is kept, and its sub-processors.
   The result goes into the register below and, for a new risk, the risk register.
2. **The contract** says, where the supplier gets personal data: a data processing agreement (GDPR Art.
   28); a BAA where it may receive PHI; breach notice to [Organization] without undue delay; deletion or
   return at the end; the right to their audit reports.
3. **Yearly review**: the latest report or certificate read (and its exceptions and the controls it says
   the customer must run, its "complementary user entity controls"), the contract still right, the
   account's users and MFA checked.
4. **Leaving a supplier**: data deleted or returned, with confirmation; access keys revoked.
5. Customers are told of sub-processors that touch their data, and of changes [30] days before.

## The register (at 2026-10-06; to confirm and complete)

| Supplier | What it does | What data it gets | Assurance to obtain | Contract terms needed | Status |
| --- | --- | --- | --- | --- | --- |
| **[Hosting provider]** (the VPS: one Ubuntu server today running the public demo, the training plant, the trainings site, and the suites registry and store once deployed; hosted customers will need servers of their own) | Servers, disks, network | Everything on the servers: for hosted customers, all their data, PHI included under a BAA | SOC 2 Type II or ISO/IEC 27001 covering the data centre and the platform; physical security is inherited from it | DPA; a BAA before any PHI is hosted (many VPS providers do not sign one: choose a provider that does for PHI customers); data location; deletion of disks at the end | To assess. The current VPS is acceptable for public, data-free sites only. |
| **GitHub** | Source code, pull requests, CI (Actions), issues | Source code; CI secrets; no customer data (tests use made-up data) | GitHub's SOC 2 Type II / ISO 27001 reports (through its trust portal; check which plan they cover) | GitHub's terms and DPA; MFA required for the organization | In use |
| **[Domain registrar / DNS]** | `opencoremes.com` and its zone | Contact details; control of where the service's names point | Its security attestations, if any; otherwise registrar lock and MFA are the controls | Registrar lock; MFA; two named people | In use; to assess |
| **Let's Encrypt** (ISRG) | TLS certificates, issued to Caddy | Domain names only | A public CA audited under the WebTrust criteria | Its subscriber agreement | In use |
| **Stripe** | Payments for the suites (checkout, licences) | Customers' billing contacts and payments; card data stays with Stripe (checkout on Stripe's side), never on [Organization]'s servers | PCI DSS service provider attestation, SOC 2 Type II | Stripe's terms and DPA | Planned live |
| **[SMTP provider]** | Email from the service (planned: notifications, password links) | People's email addresses and message contents; must never carry PHI or record data | SOC 2 Type II or ISO 27001 | DPA; no PHI in email unless a BAA is signed and the content needs it | Planned |
| **Anthropic** | The AI behind the copilots (`AI_PROVIDER=anthropic`, `app/mes/server/ai-gateway.js`) when a customer turns them on | What the person asks and what the copilot's tools read as the person: designs; record data in the design copilot's dry runs; for the analytics copilot, view and column names and up to 40 rows of each query (COMPLIANCE.md G10); attached files | Anthropic's SOC 2 Type II and ISO/IEC 27001 reports (its trust portal) | Commercial terms with its DPA; data retention and training terms reviewed; **a BAA before any PHI may reach it** (Anthropic offers BAAs for eligible API use: confirm which features and settings it covers). Until then the product must keep PHI from the copilots (planned, H6), and the customer decides whether the copilot is on. A customer may instead name an in-house model (`AI_PROVIDER=openai` with `AI_BASE_URL`), which keeps data inside their network. | In use on the demo (no customer data); per hosted customer: off until they agree in writing |
| **npm** (GitHub) | Packages: the three runtime dependencies (`pg`, `@anthropic-ai/sdk`, `echarts`) and their trees; publishing `@opencore-mes/*` packages (`ops/npm/`) | None of customers' data; the integrity of the code that runs | GitHub's reports; the controls are ours: `package-lock.json`, `npm ci`, scanning (G8), publishing with MFA and provenance | Publishing accounts with MFA; tokens scoped and short-lived | In use |

Not suppliers of the hosted service but to keep in mind: the customer's identity provider and directory
(the customer's), and the Node.js and Ubuntu distributions (checked: Node by its published checksum,
`ops/demo/provision.sh`; Ubuntu packages by their signed repositories).

## Evidence

This register with review dates; the reports obtained and their review notes; signed DPAs and BAAs;
sub-processor notices to customers.
