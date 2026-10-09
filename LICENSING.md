<!-- DRAFT 2026-10-06: the licence is the Apache License 2.0; the list of suites is still a placeholder, pending counsel. -->
# Licensing

OpenCore MES comes in two parts: **the community edition**, which is open source, and **the suites**,
which are proprietary.

## The community edition: open source

OpenCore MES is a low-code Manufacturing Execution System for advanced manufacturing, from small plants to 300 mm fabs. The community
edition is everything in this repository:
- the platform: the change lifecycle (design → review → approval → execution), the designer, records,
  policies, rules, the audit trail, transactions, screens, approval of record changes, analytics,
  queries, import and export, services and connections, the AI design tools;
- the Juris web framework it runs on, published on its own as `@opencore-mes/juris-kit` (its repository,
  [opencore-mes/juris-kit](https://github.com/opencore-mes/juris-kit), under the same licence);
- the documentation, the demo data and the tests.

It is licensed under the **Apache License, Version 2.0** (the full text is in [LICENSE](LICENSE)), which also grants a licence to the contributors' patents that their contributions use. You may use it, study it,
change it and share it, for any purpose, commercial or not, at no cost.

### Copies carry the notice

Whenever you copy or distribute OpenCore MES, in whole or in part, changed or not, you must:
1. keep the copyright notice and the licence;
2. keep the attributions in [NOTICE](NOTICE), and pass them on with your copy;
3. say clearly what you changed, in the files you changed.

A product, service or fork built on OpenCore MES must say so where its users can see it: "Built on
OpenCore MES".

### The name is not part of the licence

The licence covers the code, not the name **OpenCore MES** or the logos. A changed
version must have a name of its own. [TRADEMARKS.md](TRADEMARKS.md) says what you may and may not do
with the name.

## The suites: proprietary

The **OpenCore MES suites** are products built on the community edition and sold separately, under
commercial licences. They are not in this repository and not under its licence. They include:
- Import & Export: ERP and legacy files mapped onto your models;
- Equipment integration: SECS/GEM, GEM300, OPC UA, MQTT;
- Shift Calendar: shifts, crews, rosters, staffing alerts;
- Material management, Vendor management, Quality management, Maintenance, OEE and downtime;
- industry packs: Semiconductor (back-end assembly and test), Wafer fab, Carpentry, Load board management;
- Sales channels: marketplace orders to shipping.

The current list, with prices, is at [suites.opencoremes.com](https://suites.opencoremes.com).

The community edition is complete on its own: it never needs a suite to run, and a feature does not
move from the community edition into a suite.

A suite is installed beside the community edition, as a folder under `suites/`, and plugs into it
through a published extension point: the community edition knows no suite by name,
and never contains a suite's code. Anyone may write their own extension through the same point.

For a suite, support, or a licence on other terms, contact contact@opencoremes.com.

## Contributing

Contributions to the community edition are welcome. Each contributor agrees to the contributor
licence agreement first, so that every contribution can be distributed under the community licence
and also used in the suites. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Questions

| | |
|---|---|
| May I use OpenCore MES in my plant, for free? | Yes. |
| May I sell services (installation, design, support) around it? | Yes, under your own name, saying it is built on OpenCore MES. |
| May I ship a changed version to my customers? | Yes, with the notices kept, your changes marked, and a name of your own. |
| May I call my version "OpenCore MES" or use its logo? | No, unless you have written permission. |
| Do I need a suite? | No. The suites add to the community edition; it runs without them. |
