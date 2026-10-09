# Security policy

## Reporting a vulnerability

Do not open a public issue. Write to [security contact address] with what you found, how to reproduce it, and
what it lets someone do. We answer within [n] working days, tell you what we will do and when, and credit you
when the fix is released, unless you ask us not to.

Please give us a reasonable time to fix it before you make it public, and do not read, change or delete data
that is not yours while you look (the public demo, demo.opencoremes.com, is a sandbox you may use; it is erased
every night).

## What is supported

The latest release receives security fixes. A plant that runs its own installation upgrades with
`npm install -g @opencore-mes/server@latest` (or its checkout's next release) and restarts: the database
migrates itself at start.

## What we do

- Every change goes through review and the test pipeline (`npm run test:all`); CI fails on a known high or
  critical vulnerability in the packages that ship (`npm audit --omit=dev --audit-level=high`), and Dependabot
  proposes updates weekly.
- The controls an auditor looks for, and what is still to do, are in [COMPLIANCE.md](COMPLIANCE.md).
