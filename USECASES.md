# OpenCore MES use cases: modeling examples for designers

A book of worked examples: a need a plant has, and the design that meets it, written as the JSON the
designer keeps (**Design → JSON** on any element shows the same). Every example uses only what the
platform has today; where a need goes past it, the example says so.

How to use it:

- **Read the need, copy the shape.** Each example is one element or a part of one: an object's fields,
  a policy, a transaction, a screen, a route, a service. Start a change, open the element, and either
  draw it in the designer (every key here has a field of its own there) or paste the JSON into its
  JSON tab. The designer checks it as you go and says, in words, what does not fit your model.
- **Or ask the copilot.** "Make a future hold like the one in the use cases, for our wafer lots"
  works: the copilot drafts the same JSON into your change, and the designer checks it the same way.
- **Names are examples.** `lot`, `machine`, `work_order` and `deviation` are the demonstration model's
  objects (`app/mes/db/seed.mjs`); `product`, `future_hold` and the rest are invented for the example.
  Nothing in the platform knows any of them: rename everything to your plant's words.
- **Everything still goes through a change.** Each example is a draft until it is reviewed, approved
  and executed (the user guide, section 1). Several examples together are one change, approved once.

The words used throughout (expressions, `record`, `input`, `lookup`, `count`) are explained in
[section 17 of the user guide](USERGUIDES.md#17-expressions-conditions-and-values); the elements themselves in the
rest of the [user guide](USERGUIDES.md). A hands-on course is in [TRAINING.md](TRAINING.md).

## Contents

**A. Objects: what the plant keeps**

1. [A lot and its lifecycle](#1-a-lot-and-its-lifecycle)
2. [Who may do what, in which state](#2-who-may-do-what-in-which-state)
3. [A field locked once released](#3-a-field-locked-once-released)
4. [Fields written only through a transaction](#4-fields-written-only-through-a-transaction)
5. [Required only when, shown only when](#5-required-only-when-shown-only-when)
6. [A field copied from the product (derived)](#6-a-field-copied-from-the-product-derived)
7. [Several choices in one field](#7-several-choices-in-one-field)
8. [Long notes: height and longest length](#8-long-notes-height-and-longest-length)
9. [Pictures and documents on a record](#9-pictures-and-documents-on-a-record)
10. [Patient data: sensitive and erasable fields](#10-patient-data-sensitive-and-erasable-fields)
11. [Records only the certified see (export control)](#11-records-only-the-certified-see-export-control)
12. [What the history says](#12-what-the-history-says)
13. [Work orders imported from Excel](#13-work-orders-imported-from-excel)
14. [Archiving instead of deleting](#14-archiving-instead-of-deleting)
15. [A form in sections and tabs](#15-a-form-in-sections-and-tabs)
16. [Saying why a write is refused (hints)](#16-saying-why-a-write-is-refused-hints)

**B. Rules: checking and adjusting**

17. [Round a value as it is typed](#17-round-a-value-as-it-is-typed)
18. [Refuse a value, on the field](#18-refuse-a-value-on-the-field)
19. [A default on a new record](#19-a-default-on-a-new-record)
20. [Check against another record (on the server)](#20-check-against-another-record-on-the-server)
21. [Guard an action](#21-guard-an-action)

**C. Approvals of record changes**

22. [Changes to a record wait for approval](#22-changes-to-a-record-wait-for-approval)
23. [Approved by whoever owns it (approval by a value)](#23-approved-by-whoever-owns-it-approval-by-a-value)
24. [Groups that approve, departments with a mailbox](#24-groups-that-approve-departments-with-a-mailbox)
25. [A transaction that writes approved values](#25-a-transaction-that-writes-approved-values)

**D. Transactions: changing several records as one**

26. [Move in: a lot onto a machine, if it has room](#26-move-in-a-lot-onto-a-machine-if-it-has-room)
27. [Track out: good and scrap must add up](#27-track-out-good-and-scrap-must-add-up)
28. [Readings in a table, within the step's limits](#28-readings-in-a-table-within-the-steps-limits)
29. [A reading out of limits opens a deviation](#29-a-reading-out-of-limits-opens-a-deviation)
30. [One record per row: samples, child lots](#30-one-record-per-row-samples-child-lots)
31. [Signed, and verified by a second person](#31-signed-and-verified-by-a-second-person)
32. [Only a certified operator runs it](#32-only-a-certified-operator-runs-it)
33. [Hold and release a lot](#33-hold-and-release-a-lot)
34. [Future hold: hold the lot at a step still to come](#34-future-hold-hold-the-lot-at-a-step-still-to-come)

**E. Screens: pages people work in**

35. [A work centre station](#35-a-work-centre-station)
36. [Held lots, released from the list](#36-held-lots-released-from-the-list)
37. [A board on the wall](#37-a-board-on-the-wall)
38. [A pop-up while the machine is down](#38-a-pop-up-while-the-machine-is-down)
39. [A chart on a screen](#39-a-chart-on-a-screen)
40. [Tabs, and blocks shown only when they apply](#40-tabs-and-blocks-shown-only-when-they-apply)
41. [A list people add to and remove from](#41-a-list-people-add-to-and-remove-from)
42. [A button to another screen](#42-a-button-to-another-screen)

**F. Flows: routes and plans**

43. [A route: steps, machines, settings](#43-a-route-steps-machines-settings)
44. [Branch on the result, hold at the end](#44-branch-on-the-result-hold-at-the-end)
45. [A rework segment drawn once](#45-a-rework-segment-drawn-once)
46. [Engineering lots: held after every step](#46-engineering-lots-held-after-every-step)
47. [Out-of-control action plan (OCAP)](#47-out-of-control-action-plan-ocap)
48. [Preventive maintenance by count](#48-preventive-maintenance-by-count)
49. [Preventive maintenance by date](#49-preventive-maintenance-by-date)
50. [Scanning without a mouse (input flow)](#50-scanning-without-a-mouse-input-flow)

**G. Integration: other systems**

51. [The ERP as a connection](#51-the-erp-as-a-connection)
52. [ERP sends work orders (a web service)](#52-erp-sends-work-orders-a-web-service)
53. [ERP is told when a lot is released (a trigger)](#53-erp-is-told-when-a-lot-is-released-a-trigger)
54. [Pull from ERP every 15 minutes (a schedule)](#54-pull-from-erp-every-15-minutes-a-schedule)
55. [A service that runs a transaction](#55-a-service-that-runs-a-transaction)

**H. Reports and analysis**

56. [A named query with parameters](#56-a-named-query-with-parameters)
57. [The daily report the AI fills in](#57-the-daily-report-the-ai-fills-in)
58. [Analytics: what to slice by](#58-analytics-what-to-slice-by)

**I. The organization**

59. [Who approves designs, and who uses what](#59-who-approves-designs-and-who-uses-what)
60. [How long data is kept](#60-how-long-data-is-kept)
61. [Who tunes the database](#61-who-tunes-the-database)

**J. Putting it together, by industry**

62. [Recipes by industry](#62-recipes-by-industry)

**K. Queries that drive choices and tables**

63. [A reference's choices from a query](#63-a-references-choices-from-a-query)
64. [Choices that follow another input](#64-choices-that-follow-another-input)
65. [A screen table of a query's rows](#65-a-screen-table-of-a-querys-rows)
66. [Kept in line when a query or a field changes](#66-kept-in-line-when-a-query-or-a-field-changes)

---

## A. Objects: what the plant keeps

### 1. A lot and its lifecycle

**Need.** A lot is made, worked, held, released and used. Each step is an action people take, and a
lot on hold must look different at a glance.

```json
{
  "object": "lot",
  "label": "Lot",
  "area": "Production",
  "titleField": "lot_no",
  "fields": {
    "lot_no": { "label": "Lot no.", "type": "string", "required": true },
    "item": { "label": "Item", "type": "string", "required": true },
    "work_order": { "label": "Work order", "type": "ref", "to": "work_order", "required": true },
    "qty": { "label": "Quantity", "type": "decimal", "required": true },
    "uom": { "label": "Unit", "type": "enum", "values": ["ea", "kg", "l"], "required": true }
  },
  "states": {
    "initial": "created",
    "list": ["created", "in_process", "on_hold", "released", "consumed"],
    "tones": { "on_hold": "warn", "released": "ok", "consumed": "neutral" },
    "transitions": [
      { "action": "start", "label": "Start", "from": ["created"], "to": "in_process" },
      { "action": "hold", "label": "Hold", "from": ["created", "in_process"], "to": "on_hold" },
      { "action": "resume", "label": "Resume", "from": ["on_hold"], "to": "in_process" },
      { "action": "release", "label": "Release", "from": ["in_process", "on_hold"], "to": "released" },
      { "action": "consume", "label": "Consume", "from": ["released"], "to": "consumed" }
    ]
  },
  "roles": ["operator", "supervisor", "quality", "viewer"],
  "stewards": { "object": ["production", "quality"] },
  "list": { "columns": ["lot_no", "item", "qty", "uom"] }
}
```

- A state is coloured by its **tone** (neutral, info, ok, warn, danger), never by a colour, so it reads
  the same in light and dark.
- `stewards` say who approves a change to this design. They can be narrower:
  `"fields": { "disposition": ["quality"] }` makes Quality the approver of the disposition field alone.

### 2. Who may do what, in which state

**Need.** Operators create and edit lots while they are being made; Quality alone sets the
disposition and releases; everyone reads.

```json
"policies": [
  { "id": "lot-read", "roles": ["operator", "supervisor", "quality", "viewer"], "record": { "read": true }, "fields": { "*": "read" } },
  {
    "id": "lot-production-edit", "roles": ["operator", "supervisor"], "record": { "create": true },
    "when": { "in": [{ "record": "state" }, ["created", "in_process"]] },
    "fields": { "lot_no": "write", "item": "write", "work_order": "write", "qty": "write", "uom": "write" },
    "actions": { "start": "allow", "hold": "allow" }
  },
  {
    "id": "lot-quality", "roles": ["quality"],
    "when": { "in": [{ "record": "state" }, ["in_process", "on_hold"]] },
    "fields": { "disposition": "write" }, "actions": { "hold": "allow", "resume": "allow", "release": "allow" }
  }
]
```

- A policy grants; nothing is allowed that no policy grants. Several policies add up.
- `when` reads the record as it is saved (`record`) and the person (`user`). The record's **Why?**
  shows which policy decided.
- Who holds a role (operator, quality) is set in **People & departments**, not in the object (use case 59).

### 3. A field locked once released

**Need.** After release, nobody changes the expiry, whatever else their role allows.

```json
{ "id": "lot-expiry-locked", "roles": ["operator", "supervisor", "quality", "viewer"],
  "when": { "in": [{ "record": "state" }, ["released", "consumed"]] },
  "deny": { "fields": ["expiry"] } }
```

- `deny` wins over every grant, so it is the way to say "never, in this state".

### 4. Fields written only through a transaction

**Need.** The machine a lot is on, and its scrap, are set by Move in and Track out, never by typing
into the lot's form.

```json
{ "id": "lot-machine-moves", "roles": ["operator", "supervisor"],
  "via": ["move_in", "track_in", "track_out", "move_out"],
  "fields": { "machine": "write", "scrap_qty": "write", "scrap_reason": "write" },
  "actions": { "move_in": "allow", "track_in": "allow", "track_out": "allow", "move_out": "allow" } }
```

- `via` grants the rights only to writes made by those transactions. The same person editing the lot's
  form sees the fields read-only.
- The same works on the machine: its `load`, `start`, `finish` and `unload` actions are allowed only
  `via` the lot transactions, so the two never disagree.

### 5. Required only when, shown only when

**Need.** A machine that is down needs a reason; a lot's scrap reason shows only once there is scrap.

```json
"fields": {
  "down_reason": { "label": "Down because", "type": "string",
                   "requiredWhen": { "eq": [{ "record": "state" }, "down"] } }
}
```

```json
"form": { "sections": [
  { "label": "Result", "fields": [
    "scrap_qty",
    { "field": "scrap_reason", "show": { "gt": [{ "data": "scrap_qty" }, 0] } }
  ] }
] }
```

- `requiredWhen` is on the field: it decides what is valid, so the server checks it too.
- `show` and `enable` are on the form: they only present. What a person may write is still the
  policies'.

### 6. A field copied from the product (derived)

**Need.** Every lot shows its product's control class, and follows it when the product is
reclassified.

```json
"fields": {
  "product": { "label": "Product", "type": "ref", "to": "product", "required": true },
  "control": { "label": "Control", "type": "enum", "values": ["production", "engineering"], "from": "product.control" }
}
```

- Nobody writes a derived field; the platform keeps it. A path may go further:
  `"from": "lot.product.control"` on a wafer.
- Derived fields can drive policies, approvals by value (use case 23) and certifications (use case 11), so a rule
  written once on the product reaches everything made of it.

### 7. Several choices in one field

**Need.** A tool is qualified for several processes.

```json
"processes": { "label": "Qualified for", "type": "enum", "multiple": true, "values": ["etch", "deposition", "implant"] }
```

- In the form it is a multi-select, checkbox list or chips (Layout → widget).
- Ask it with `contains`: `{"contains": [{"lookup": "tool.processes"}, "etch"]}`.

### 8. Long notes: height and longest length

**Need.** A deviation's description gets a large box that grows, and at most 5 000 characters.

```json
"fields": { "description": { "label": "Description", "type": "text", "maxLength": 5000 } },
"form": { "sections": [ { "label": "Deviation", "fields": [ { "field": "description", "rows": 4, "maxRows": 16 } ] } ] }
```

- `rows` is the smallest height in lines; the box grows with what is typed up to `maxRows`, then
  scrolls. The form counts what is left as people type.
- A text field takes at most 20 000 characters, a short text 2 000; 500 when nothing is said.

### 9. Pictures and documents on a record

**Need.** A deviation carries a photo of the defect and the lab's report.

```json
"fields": {
  "photo": { "label": "Photo", "type": "image" },
  "lab_report": { "label": "Lab report", "type": "file" }
}
```

- A picture is shown in the form and in lists; a file opens from the record. Both are kept by their
  content, and never deleted.

### 10. Patient data: sensitive and erasable fields

**Need.** A device's record names the patient. It must be hidden everywhere unless someone asks with
a reason, and erased on request.

```json
"patient_name": { "label": "Patient", "type": "string", "sensitive": true, "erasable": true }
```

- A sensitive value is shown as *Hidden: sensitive* with a Show button: showing it asks for a reason
  and is audited each time. It never reaches queries, analytics or the AI.
- `erasable` lets the privacy officer erase it from a record (the erasure is audited; the record
  stays). Pictures and files cannot be erasable yet.

### 11. Records only the certified see (export control)

**Need.** A military product, and every lot made of it, is visible only to people holding the export
control certification.

```json
"fields": { "military": { "label": "Military", "type": "boolean", "from": "product.military" } },
"access": { "requires": [{ "certification": "itar", "when": { "eq": [{ "record": "military" }, true] } }] }
```

- The certification is listed in People & departments, and each person's is kept with its dates. A
  person without it gets nothing on such a record: not in lists, counts, searches, screens, queries,
  reports or exports.
- A service holds no certification unless its design names it (`"certifications": ["itar"]`).

### 12. What the history says

**Need.** A lot's history should say each change of quantity and disposition, the steps of its route,
and which transaction made each change.

```json
"history": { "fields": ["qty", "disposition", "state"], "steps": true, "via": true }
```

- The audit trail keeps everything anyway; `history` chooses what the record's History tab tells
  people.

### 13. Work orders imported from Excel

**Need.** Planners load the week's work orders from a spreadsheet, matching by number.

```json
"transfer": { "import": { "create": true, "update": true, "key": "wo_no" } }
```

- Each row is a write through the object's policies and rules, as the person importing: a row they
  could not type is refused, with the row and the reason.
- `"update": false` makes it create-only (an existing lot is never overwritten by a file).

### 14. Archiving instead of deleting

**Need.** A supervisor takes a scrapped lot out of use. Nothing is ever deleted.

```json
{ "id": "lot-archive", "roles": ["supervisor"], "record": { "archive": true },
  "when": { "in": [{ "record": "state" }, ["on_hold", "consumed"]] } }
```

- An archived record leaves lists and counts, stays readable with its history, and can be restored by
  someone with the same right. Add `"archive": true` to the object's `approval` (use case 22) to make it wait
  for approval.

### 15. A form in sections and tabs

**Need.** The lot's form groups what is entered when, with the machine fields folded away.

```json
"form": {
  "sections": [
    { "label": "Lot", "fields": ["lot_no", "item", "work_order"] },
    { "label": "Quantity", "fields": [{ "field": "qty", "width": 4, "widget": "stepper" }, "uom", "expiry"] },
    { "label": "At the machine", "collapsible": true, "collapsed": true, "fields": ["machine", "scrap_qty", "scrap_reason"] }
  ]
}
```

- Or `"form": { "tabs": [ { "label": "Lot", "sections": [ … ] }, … ] }` for long records.
- Widths are out of 12. A reference is searched as typed by default; `"widget": "scan"` takes a scan,
  `"select"` a short dropdown.

### 16. Saying why a write is refused (hints)

**Need.** An operator who cannot change a released lot's quantity should be told where to go.

```json
"hints": {
  "write:qty": "A released lot's quantity is corrected through a deviation.",
  "record:archive": "A supervisor archives a lot once it is consumed, or while it is on hold."
}
```

---

## B. Rules: checking and adjusting

A rule is one script per file: a context in, the same context out, and an error thrown to refuse
(with the field it is about). It runs in the browser as the person types (advice) and again on the
server (the decision). Each script carries its test cases, which the change's fitness check runs.

```json
"rules": [
  { "script": "lot_round_qty", "writes": ["qty"] },
  { "script": "lot_qty_positive" },
  { "script": "lot_default_expiry", "writes": ["expiry"] },
  { "script": "lot_check_qty", "backendOnly": true },
  { "script": "lot_release_checks" }
]
```

`writes` names what a rule may change; `backendOnly` runs it only on the server (it looks records up).

### 17. Round a value as it is typed

```js
// Rounds the quantity to three decimals whenever it changes.
export default function lot_round_qty(ctx) {
  if (ctx.event.kind === "change" && !ctx.event.changed.includes("qty")) return ctx;
  if (typeof ctx.data.qty === "number") ctx.data.qty = Math.round(ctx.data.qty * 1000) / 1000;
  return ctx;
}
```

### 18. Refuse a value, on the field

```js
// A lot's quantity is more than zero.
export default function lot_qty_positive(ctx) {
  if (ctx.event.kind === "change" && !ctx.event.changed.includes("qty")) return ctx;
  if (typeof ctx.data.qty === "number" && ctx.data.qty <= 0) {
    throw Object.assign(new Error("The quantity must be more than zero."), { field: "qty" });
  }
  return ctx;
}
```

Its tests, kept with it:

```json
[
  { "name": "more than zero passes", "run": { "event": { "kind": "save" }, "data": { "qty": 5 } }, "expect": { "changed": [] } },
  { "name": "zero or less is refused on the quantity", "run": { "event": { "kind": "save" }, "data": { "qty": -5 } }, "expect": { "throws": { "field": "qty" } } }
]
```

### 19. A default on a new record

```js
// A new lot without an expiry expires 180 days from today.
export default function lot_default_expiry(ctx) {
  if (ctx.event.kind !== "save" || ctx.record.id || ctx.data.expiry) return ctx;
  const expiry = new Date(Date.parse(ctx.now) + 180 * 24 * 3600 * 1000);
  ctx.data.expiry = expiry.toISOString().slice(0, 10);
  return ctx;
}
```

- Use `ctx.now`, never the clock: the same rule gives the same answer in the browser, on the server
  and in its tests.

### 20. Check against another record (on the server)

```js
// On save: at most 5% over the work order's quantity.
export default async function lot_check_qty(ctx) {
  if (ctx.event.kind !== "save" || !ctx.data.work_order) return ctx;
  const order = await ctx.lookup("work_order", ctx.data.work_order);
  if (!order) throw Object.assign(new Error("Pick a work order you can see."), { field: "work_order" });
  const limit = Math.round(order.qty * 1.05 * 1000) / 1000;
  if (ctx.data.qty > limit) throw Object.assign(new Error("At most " + limit + ": 5% over work order " + order.wo_no + "."), { field: "qty" });
  return ctx;
}
```

- `ctx.lookup` reads as the person saving, so the rule never sees more than they may. Mark it
  `backendOnly`.

### 21. Guard an action

```js
// Release needs an accepted disposition.
export default function lot_release_checks(ctx) {
  if (ctx.event.kind === "action" && ctx.event.action === "release" && ctx.data.disposition !== "accept") {
    throw Object.assign(new Error("Set the disposition to accept before releasing the lot."), { field: "disposition" });
  }
  return ctx;
}
```

- `ctx.event.kind` is `change` (as typed), `save`, `action` (with `action`) or `archive`.

---

## C. Approvals of record changes

### 22. Changes to a record wait for approval

**Need.** A product's recipe and limits, once the product is released, change only when the
product's stewards approve. New products and archiving wait too.

```json
"approval": {
  "edit": { "fields": ["recipe", "limits"], "states": ["released"] },
  "create": true,
  "actions": ["obsolete"],
  "archive": true
}
```

- A change made in the form, a list or an import becomes a request; it is written once its approvers
  sign. The record shows it pending.
- `"edit": true` makes every field wait; `"actions": true` every action.
- A transaction or a designed service is the approved way to change such a record: its steps never
  wait (its design was approved instead; see use case 25).

### 23. Approved by whoever owns it (approval by a value)

**Need.** Products belong to a group of engineers: a litho product's changes are approved by the litho
engineers, an etch product's by the etch engineers, not by every product steward.

```json
"fields": {
  "owner": { "label": "Owned by", "type": "enum", "values": ["litho", "etch", "thin_film"], "required": true }
},
"approval": {
  "edit": true,
  "archive": true,
  "by": {
    "field": "owner",
    "values": { "litho": ["litho_engineers"], "etch": ["etch_engineers"], "thin_film": ["thin_film_engineers", "quality"] },
    "stewards": "replace"
  }
}
```

- Each value names departments or groups. `"stewards": "replace"` means those approve instead of the
  object's stewards; `"also"` adds them.
- The field is a choice, a text or a yes / no. To approve by a referenced record's value, derive it
  into a text field first (use case 6).

### 24. Groups that approve, departments with a mailbox

**Need.** The litho engineers come from Engineering and Quality; any one of them approves (never the
person asking). Quality's shared mailbox hears of every request.

```json
"departments": {
  "quality": { "name": "Quality", "email": "quality@plant.example", "members": ["olga", "quinn"],
               "approval": [{ "label": "Quality review", "approvers": ["olga", "quinn"] }] }
},
"groups": {
  "litho_engineers": { "name": "Litho engineers", "members": ["eli", "quinn", "sam"] }
}
```

- This is part of the organization (People & departments), changed through a change like the rest.
  Anyone can be in a group, whatever their department.
- A group approves in one step: any active member signs.

### 25. A transaction that writes approved values

**Need.** A "Change recipe" transaction sets a released product's recipe. It must not slip past the
litho engineers.

- Nothing to add: when the transaction's design is submitted, the designer sees that its steps write
  approval-controlled values, and routes the **design** to those approvers (the litho, etch and thin
  film groups above). Once approved, its runs never wait.
- The same holds for a service and a route that write such values.

---

## D. Transactions: changing several records as one

A transaction is a form of inputs, the checks it must pass, and its steps, each a write to a record
through that object's own state machine, policies, rules and audit. It runs all or nothing.

### 26. Move in: a lot onto a machine, if it has room

```json
{
  "name": "move_in", "label": "Move in",
  "description": "Put a lot on a machine: the lot is assigned to it, and the machine is loaded.",
  "inputs": {
    "lot": { "label": "Lot", "type": "ref", "to": "lot", "required": true },
    "machine": { "label": "Machine", "type": "ref", "to": "machine", "required": true }
  },
  "form": { "sections": [{ "label": "Move in", "fields": [{ "field": "lot", "widget": "scan", "width": 6 }, { "field": "machine", "widget": "scan", "width": 6 }] }] },
  "appearsOn": { "object": "lot", "states": ["created", "in_process"], "fills": "lot" },
  "require": [
    { "that": { "ne": [{ "lookup": "machine.state" }, "down"] }, "message": "The machine is down.", "field": "machine" },
    { "that": { "lt": [{ "count": { "object": "lot", "where": { "machine": { "input": "machine" }, "state": ["at_machine", "processing", "processed"] } } }, { "lookup": "machine.capacity" }] },
      "message": "The machine is full.", "field": "machine" }
  ],
  "steps": [
    { "on": "lot", "set": { "machine": { "input": "machine" } }, "action": "move_in" },
    { "on": "machine", "action": "load", "when": { "eq": [{ "lookup": "machine.state" }, "idle"] } }
  ],
  "confirm": true,
  "callers": { "users": [], "groups": ["production"] },
  "stewards": ["production"]
}
```

- `appearsOn` puts a **Move in** button on lots in those states, with the lot filled in.
- `count` counts in the database; conditions read the records as they were before any step.
- `confirm` shows what will change before it runs.

### 27. Track out: good and scrap must add up

```json
{
  "name": "track_out", "label": "Track out",
  "inputs": {
    "lot": { "label": "Lot", "type": "ref", "to": "lot", "required": true },
    "machine": { "label": "Machine", "type": "ref", "to": "machine", "required": true, "from": "lot.machine" },
    "good_qty": { "label": "Good", "type": "decimal", "required": true },
    "scrap_qty": { "label": "Scrap", "type": "decimal" },
    "scrap_reason": { "label": "Scrap reason", "type": "enum", "values": ["setup", "dimension", "surface", "other"],
                      "requiredWhen": { "gt": [{ "data": "scrap_qty" }, 0] } }
  },
  "form": { "sections": [
    { "label": "Track out", "fields": [{ "field": "lot", "widget": "scan", "width": 6 }, { "field": "machine", "width": 6 }] },
    { "label": "Result", "fields": [{ "field": "good_qty", "widget": "stepper" }, { "field": "scrap_qty", "widget": "stepper" },
      { "field": "scrap_reason", "show": { "gt": [{ "data": "scrap_qty" }, 0] } }] }
  ] },
  "appearsOn": { "object": "lot", "states": ["processing"], "fills": "lot" },
  "require": [
    { "that": { "eq": [{ "add": [{ "input": "good_qty" }, { "input": "scrap_qty" }] }, { "lookup": "lot.qty" }] },
      "message": "Good and scrap together must be the lot's quantity.", "field": "good_qty" }
  ],
  "steps": [
    { "on": "lot", "set": { "qty": { "input": "good_qty" }, "scrap_qty": { "input": "scrap_qty" }, "scrap_reason": { "input": "scrap_reason" } }, "action": "track_out" },
    { "on": "machine", "action": "finish",
      "when": { "eq": [{ "count": { "object": "lot", "where": { "machine": { "input": "machine" }, "state": ["processing"] } } }, 1] } }
  ],
  "confirm": true, "callers": { "users": [], "groups": ["production"] }, "stewards": ["production"]
}
```

- `"from": "lot.machine"` fills the machine from the lot; nobody types it.
- The machine finishes only when this was the last lot processing on it.

### 28. Readings in a table, within the step's limits

**Need.** At a measuring step, the operator enters five thicknesses. Each must be within the limits
the route gives that step, so one transaction serves every step.

```json
"inputs": {
  "lot": { "label": "Lot", "type": "ref", "to": "lot", "required": true },
  "readings": { "label": "Readings", "type": "rows", "min": 5, "max": 5,
                "fields": { "site": { "type": "string" }, "value": { "type": "decimal" } } }
},
"require": [
  { "that": { "every": [{ "input": "readings" },
      { "all": [{ "ge": [{ "row": "value" }, { "node": "lsl" }] }, { "le": [{ "row": "value" }, { "node": "usl" }] }] }] },
    "message": "A reading is outside this step's limits.", "field": "readings" }
]
```

On the route, each step says its limits (use case 43):

```json
"measure_ox": { "kind": "sequence", "label": "Oxide thickness", "offers": ["measure"], "leaves": ["measure"], "settings": { "lsl": 95, "usl": 105 } }
```

- `{"node": "usl"}` reads the setting of the route step the lot is at.

### 29. A reading out of limits opens a deviation

**Need.** Instead of refusing, record the readings and open a deviation when one is out, so the
out-of-control plan (use case 47) starts.

```json
"steps": [
  { "on": "lot", "action": "track_out" },
  { "create": "deviation",
    "set": { "title": "Reading out of limits", "lot": { "input": "lot" }, "severity": "major" },
    "when": { "some": [{ "input": "readings" }, { "gt": [{ "row": "value" }, { "node": "usl" }] }] } }
]
```

- The person running it needs the right to create a deviation (a `reporter` role on it, or the
  transaction run `via`).

### 30. One record per row: samples, child lots

**Need.** Each sample pulled from a lot becomes a sample record.

```json
"inputs": {
  "lot": { "label": "Lot", "type": "ref", "to": "lot", "required": true },
  "samples": { "label": "Samples", "type": "rows", "min": 1, "max": 20,
               "fields": { "sample_no": { "type": "string" }, "position": { "type": "enum", "values": ["top", "centre", "bottom"] } } }
},
"steps": [
  { "create": "sample", "forEach": "samples",
    "set": { "sample_no": { "row": "sample_no" }, "position": { "row": "position" }, "lot": { "input": "lot" } } }
]
```

- The same shape splits a lot into child lots (`create: "lot"`, a `parent` reference set to
  `{"input": "lot"}`). No expression adds up a column of rows yet, so the transaction cannot check that
  the children add up to the parent.

### 31. Signed, and verified by a second person

**Need.** Releasing a lot from hold is signed by the person doing it, and verified by someone from
Quality standing beside them (21 CFR Part 11).

```json
"signature": {
  "meaning": "Released from hold",
  "verifier": { "meaning": "Verified", "departments": ["quality"] }
}
```

- Both re-enter their passwords at every submit; both signatures, with their meanings, are in the
  audit trail. `roles: ["lot.quality"]` names the verifiers by role instead.
- A signed transaction is never run by a service or a route: a person signs it.

### 32. Only a certified operator runs it

**Need.** Only operators certified on the furnace process may track lots in on a furnace.

```json
"require": [
  { "that": { "contains": [{ "user": "certifications" }, "furnace"] },
    "message": "You are not certified on the furnace. Ask your supervisor.", "field": "lot" }
]
```

- `user.certifications` is what the person holds today (in date), as People & departments keeps it.
- To match the machine instead of a fixed name, keep the certifications a person holds in a field the
  plant adds to Person, and compare it with the machine's process:
  `{"contains": [{"person": "certified_for"}, {"lookup": "machine.process"}]}`.

### 33. Hold and release a lot

```json
{
  "name": "hold_lot", "label": "Hold",
  "inputs": {
    "lot": { "label": "Lot", "type": "ref", "to": "lot", "required": true },
    "reason": { "label": "Why", "type": "text", "required": true }
  },
  "appearsOn": { "object": "lot", "states": ["created", "in_process"], "fills": "lot" },
  "require": [],
  "steps": [ { "on": "lot", "set": { "hold_reason": { "input": "reason" } }, "action": "hold" } ],
  "callers": { "users": [], "groups": ["production", "quality"] }, "stewards": ["quality"]
}
```

```json
{
  "name": "release_lot", "label": "Release from hold",
  "inputs": {
    "lot": { "label": "Lot", "type": "ref", "to": "lot", "required": true },
    "note": { "label": "Why it may go on", "type": "text", "required": true }
  },
  "appearsOn": { "object": "lot", "states": ["on_hold"], "fills": "lot" },
  "require": [],
  "steps": [ { "on": "lot", "set": { "hold_reason": null, "release_note": { "input": "note" } }, "action": "resume" } ],
  "signature": { "meaning": "Released from hold" },
  "callers": { "users": [], "groups": ["quality"] }, "stewards": ["quality"]
}
```

- The lot needs `hold_reason` and `release_note` fields, written `via` these two (use case 4).
- A list of held lots with a Release button on each row is use case 36.

### 34. Future hold: hold the lot at a step still to come

**Need.** An engineer says: "hold lot L-1 when it leaves the etch step", or "hold every lot of this
item when it leaves implant". The hold is set in advance, used once, and anyone can see what is set.

A **future hold** is an object of its own:

```json
{
  "object": "future_hold", "label": "Future hold", "area": "Quality", "titleField": "reason",
  "fields": {
    "lot": { "label": "Lot (or empty: every lot of the item)", "type": "ref", "to": "lot" },
    "item": { "label": "Item", "type": "string" },
    "at": { "label": "When it leaves step", "type": "string", "required": true },
    "reason": { "label": "Why", "type": "text", "required": true }
  },
  "states": {
    "initial": "active", "list": ["active", "used", "cancelled"], "tones": { "active": "warn", "used": "neutral" },
    "transitions": [
      { "action": "use", "label": "Used", "from": ["active"], "to": "used" },
      { "action": "cancel", "label": "Cancel", "from": ["active"], "to": "cancelled" }
    ]
  },
  "roles": ["engineer", "viewer", "router"],
  "stewards": { "object": ["quality"] },
  "policies": [
    { "id": "fh-read", "roles": ["engineer", "viewer", "router"], "record": { "read": true }, "fields": { "*": "read" } },
    { "id": "fh-set", "roles": ["engineer"], "record": { "create": true }, "when": { "eq": [{ "record": "state" }, "active"] }, "fields": { "*": "write" }, "actions": { "cancel": "allow" } },
    { "id": "fh-use", "roles": ["router"], "actions": { "use": "allow" } }
  ],
  "list": { "columns": ["lot", "item", "at", "reason"] }
}
```

A transaction finds the holds set for this lot at the step it is leaving, uses them, and holds the
lot if there were any:

```json
{
  "name": "apply_future_holds", "label": "Apply future holds",
  "inputs": { "lot": { "label": "Lot", "type": "ref", "to": "lot", "required": true } },
  "appearsOn": { "object": "lot", "fills": "lot" },
  "require": [],
  "steps": [
    { "find": { "object": "future_hold", "where": { "lot": { "input": "lot" }, "at": { "lookup": "lot.station" }, "state": ["active"] } },
      "as": "for_this_lot", "action": "use" },
    { "find": { "object": "future_hold", "where": { "lot": null, "item": { "lookup": "lot.item" }, "at": { "lookup": "lot.station" }, "state": ["active"] } },
      "as": "for_the_item" },
    { "on": "lot", "action": "hold",
      "when": { "any": [{ "gt": [{ "found": "for_this_lot.count" }, 0] }, { "gt": [{ "found": "for_the_item.count" }, 0] }] } }
  ],
  "confirm": false,
  "callers": { "users": [], "groups": [], "flows": ["molding_route"] },
  "stewards": ["quality"]
}
```

The route runs it as each lot leaves any step:

```json
"everySequence": { "onExit": { "run": "apply_future_holds" } },
"roles": { "lot": ["router"], "future_hold": ["router"] }
```

- A `find` step finds records (at most `limit`) and may take an action on each, or `set` fields;
  later steps read `found.<as>.count` and `found.<as>.first.<field>`. Found records are locked while
  the transaction runs. `null` in `where` means "empty"; an input that has no value finds nothing.
- An item-wide hold is not `use`d: it stays active for the next lot, until an engineer cancels it.
- `callers.flows` names the routes that may run it on their traveler, and `appearsOn` says which
  input the traveler fills. Its callers name no person, so nobody is offered it as a button. A
  transaction run only by routes is proven by those routes' scenarios.
- The lot's `station` is the step field the route marks (use case 43). A lot not on a route has none, and
  finds nothing.

---

## E. Screens: pages people work in

A screen is a page of blocks (record, table, kpi, breakdown, chart, transaction, text, button, floor,
media), each reading with the viewer's own rights. It is opened with at most one parameter.

### 35. A work centre station

```json
{
  "name": "work_centre", "label": "Work centre",
  "description": "One machine: what is on it, and the moves to make.",
  "params": { "machine": { "label": "Machine", "type": "ref", "to": "machine", "required": true, "widget": "scan" } },
  "blocks": [
    { "block": "record", "title": "Machine", "object": "machine", "of": { "param": "machine" }, "show": ["machine_id", "name", "capacity", "state"], "width": 4 },
    { "block": "kpi", "title": "Lots on it", "label": "lots", "object": "lot", "where": { "machine": { "param": "machine" }, "state": ["at_machine", "processing", "processed"] }, "measure": "count", "width": 4 },
    { "block": "kpi", "title": "Scrap today", "label": "scrapped", "object": "lot", "where": {}, "measure": { "sum": "scrap_qty" }, "since": "today", "width": 4 },
    { "block": "table", "title": "Processing", "object": "lot", "where": { "machine": { "param": "machine" }, "state": ["processing"] }, "columns": ["lot_no", "item", "qty"], "rowActions": ["track_out"], "width": 6 },
    { "block": "table", "title": "Waiting to start", "object": "lot", "where": { "machine": { "param": "machine" }, "state": ["at_machine"] }, "columns": ["lot_no", "item", "qty"], "rowActions": ["track_in"], "width": 6 },
    { "block": "transaction", "title": "Move a lot in", "name": "move_in", "fills": { "machine": { "param": "machine" } }, "width": 6 }
  ],
  "maximize": "toggle",
  "callers": { "users": [], "groups": ["production"] }, "stewards": ["production"]
}
```

- A table's row buttons are transactions that appear on that object; the row fills the lot.
- `"where": { "kind": ["press"] }` on the parameter limits which machines open it.

### 36. Held lots, released from the list

**Need.** Quality sees every held lot, sorted by how long it has waited, and releases one from its row
in a panel, without leaving the list.

```json
{
  "name": "held_lots", "label": "Held lots", "params": {},
  "blocks": [
    { "block": "table", "title": "On hold", "object": "lot", "where": { "state": ["on_hold"] },
      "columns": ["lot_no", "item", "qty", "hold_reason"], "sort": { "field": "lot_no", "dir": "asc" },
      "rowActions": ["release_lot"], "rowActionsIn": "panel", "width": 12 }
  ],
  "callers": { "users": [], "groups": ["quality"] }, "stewards": ["quality"]
}
```

- `"rowActionsIn": "panel"` opens the row's form in a panel over the screen; left out, it opens
  under the table. People can sort by any column themselves; `sort` is where it starts.

### 37. A board on the wall

```json
{
  "name": "shop_floor", "label": "Shop floor", "params": {},
  "blocks": [
    { "block": "breakdown", "title": "Machines", "object": "machine", "by": "state", "measure": "count", "width": 4 },
    { "block": "kpi", "title": "Lots on hold", "label": "lots", "object": "lot", "where": { "state": ["on_hold"] }, "measure": "count", "width": 4 },
    { "block": "breakdown", "title": "Scrap this week, by reason", "object": "lot", "where": {}, "by": "scrap_reason", "measure": { "sum": "scrap_qty" }, "since": "7d", "width": 4 },
    { "block": "table", "title": "At the machines", "object": "lot", "where": { "state": ["at_machine", "processing", "processed"] }, "columns": ["lot_no", "machine", "state", "qty"], "sort": { "field": "machine", "dir": "asc" }, "width": 12 }
  ],
  "maximize": "start",
  "callers": { "users": [], "groups": ["production", "quality"] }, "stewards": ["production"]
}
```

- `"maximize": "start"` opens it filling the window.

### 38. A pop-up while the machine is down

**Need.** Over Move in and Track in, warn the operator when the machine they scanned is down.

```json
{
  "name": "machine_down", "label": "Machine down",
  "params": { "machine": { "label": "Machine", "type": "ref", "to": "machine", "required": true } },
  "blocks": [
    { "block": "record", "title": "Machine", "object": "machine", "of": { "param": "machine" }, "show": ["machine_id", "name", "state", "down_reason"], "width": 6 },
    { "block": "text", "text": "Pick another machine, or ask maintenance when it will be back.", "width": 6 }
  ],
  "popup": { "on": ["transaction:move_in", "transaction:track_in"], "for": { "groups": ["production"] },
             "while": { "eq": [{ "lookup": "machine.state" }, "down"] }, "with": { "input": "machine" } },
  "callers": { "users": [], "groups": ["production", "quality"] }, "stewards": ["production"]
}
```

- A pop-up decides nothing: Move in's own check refuses a machine that is down.

### 39. A chart on a screen

```json
{ "block": "chart", "title": "Lots on it, by state", "width": 6,
  "query": { "json": { "from": "lot", "select": ["state", { "count": "*", "as": "lots" }],
                       "where": { "eq": [{ "field": "machine" }, { "param": "machine" }] }, "groupBy": ["state"] } },
  "chart": "donut", "x": "state", "y": ["lots"] }
```

- Kinds include bar, line, area, scatter, pie, donut, heatmap, boxplot, histogram, gauge, pareto,
  sankey and more. `marks` draw a target or limits; `bands` shade ranges; colours are tones.
- A query written in SQL works too (`"query": { "sql": "SELECT …" }`), run as the viewer.

### 40. Tabs, and blocks shown only when they apply

**Need.** A lot's screen shows its deviations on a Quality tab to Quality alone, and a Release form
that is greyed out unless the lot is on hold.

```json
{
  "name": "lot_overview", "label": "Lot",
  "params": { "lot": { "label": "Lot", "type": "ref", "to": "lot", "required": true, "widget": "scan" } },
  "blocks": [
    { "block": "record", "title": "Lot", "object": "lot", "of": { "param": "lot" }, "show": ["lot_no", "item", "qty", "state"], "width": 12 },
    { "block": "table", "title": "Its deviations", "tab": "Quality", "object": "deviation", "where": { "lot": { "param": "lot" } },
      "columns": ["title", "severity"], "width": 6,
      "showWhen": { "contains": [{ "user": "departments" }, "quality"] } },
    { "block": "transaction", "title": "Release", "tab": "Quality", "name": "release_lot", "fills": { "lot": { "param": "lot" } }, "width": 6,
      "enableWhen": { "eq": [{ "lookup": "lot.state" }, "on_hold"] }, "disabledBecause": "Only a held lot is released here." }
  ],
  "callers": { "users": [], "groups": ["production", "quality"] }, "stewards": ["quality"]
}
```

- Blocks that name the same `tab` share it; the rest show above the tabs. A block not shown is not
  read either; a tab none of whose blocks is shown is not there.
- A block's condition reads the screen's parameter (`param`), the record it names (`lookup`), who is
  looking (`user`: `id`, `departments`) and counts. It only presents: the Release form still checks the
  person's rights.

### 41. A list people add to and remove from

```json
{ "block": "table", "title": "Future holds", "object": "future_hold", "where": { "state": ["active"] },
  "columns": ["lot", "item", "at", "reason"], "create": true, "archive": true, "width": 12 }
```

- `create` adds a **New** button, `archive` a **Remove** on each row: the object's own, through its
  policies, so only an engineer sees them.

### 42. A button to another screen

```json
{ "block": "button", "label": "Open the machine", "opens": "work_centre", "with": { "param": "machine" } }
```

---

## F. Flows: routes and plans

### 43. A route: steps, machines, settings

**Need.** Glass-filled nylon is dried, molded on a press, then cured. Each step offers the machine
transactions, needs a machine of the right kind, and carries its settings.

```json
{
  "name": "molding_route", "label": "Molding route", "kind": "route",
  "participants": { "lot": { "object": "lot", "as": "traveler" }, "machine": { "object": "machine", "as": "resource" } },
  "ends": { "when": { "in": [{ "context": "lot.state" }, ["released", "consumed"]] } },
  "nodes": {
    "start": { "kind": "start", "label": "Start", "when": { "eq": [{ "context": "lot.item" }, "PA6-GF30-NAT"] } },
    "drying": { "kind": "sequence", "label": "Drying", "offers": ["move_in", "track_in", "track_out", "move_out"], "leaves": ["move_out"],
                "resource": { "kind": ["oven", "dryer"] }, "settings": { "temp_c": 80, "hours": 4 } },
    "molding": { "kind": "sequence", "label": "Molding", "offers": ["move_in", "track_in", "track_out", "move_out"], "leaves": ["move_out"],
                 "resource": { "kind": ["press"] }, "settings": { "cycle_s": 42 } },
    "done": { "kind": "end", "label": "Ready", "outcome": "ready" }
  },
  "edges": [ { "from": "start", "to": "drying" }, { "from": "drying", "to": "molding" }, { "from": "molding", "to": "done" } ],
  "roles": { "lot": ["router"], "work_order": ["viewer"] },
  "stewards": ["production"]
}
```

- The lot names its step field: `"flow": { "as": ["traveler", "reference"], "step": "station" }` on
  the lot object, and the machine `"flow": { "as": ["resource"] }`.
- A lot made where `start.when` holds starts the route. Entering a step marks `station`; leaving it
  takes one of `leaves`.
- `roles` is what the route's own identity may do (mark the step, its scripts' writes).

### 44. Branch on the result, hold at the end

```json
"context": { "max_scrap": 25 },
"nodes": {
  "scrap_check": { "kind": "auto_decision", "label": "Scrap over the limit?" },
  "held": { "kind": "end", "label": "Held for review", "outcome": "held", "onEnter": "flow_hold_lot" },
  "curing": { "kind": "sequence", "label": "Curing", "offers": ["move_in", "track_in", "track_out", "move_out"], "leaves": ["move_out"], "resource": { "kind": ["oven"] } }
},
"edges": [
  { "from": "molding", "to": "scrap_check" },
  { "from": "scrap_check", "to": "held", "when": { "gt": [{ "context": "lot.scrap_qty" }, { "context": "max_scrap" }] } },
  { "from": "scrap_check", "to": "curing" }
]
```

```js
// On entering a node: the lot is held, as the route, through its own lifecycle.
export default function flow_hold_lot(ctx) {
  const lot = ctx.context.lot;
  if (lot && (lot.state === "created" || lot.state === "in_process")) ctx.writes.push({ record: "lot", action: "hold" });
  return ctx;
}
```

- An auto decision tries its wires in order; the last may have no condition.
- A node's script adds writes (`{ record, action }` or `{ record, set }`); they are made after, as the
  route, through the record's policies.

### 45. A rework segment drawn once

```json
{ "name": "rework_loop", "label": "Rework", "kind": "route", "asSub": true,
  "participants": { "lot": { "object": "lot", "as": "traveler" } },
  "context": { "verdict": null },
  "nodes": {
    "start": { "kind": "start", "label": "Start" },
    "strip": { "kind": "sequence", "label": "Strip", "offers": ["track_out"], "leaves": ["track_out"] },
    "done": { "kind": "end", "label": "Reworked" }
  },
  "edges": [ { "from": "start", "to": "strip" }, { "from": "strip", "to": "done" } ],
  "roles": { "lot": ["router"] }, "stewards": ["production"] }
```

In each route that needs it:

```json
"rework": { "kind": "sub_flow", "label": "Rework it", "flow": "rework_loop", "returns": { "verdict": "verdict" } }
```

- `asSub` keeps it from taking up lots by itself. The lot goes through its steps, then comes back to
  the next step of the route it came from. `pass` sends values in; `returns` takes values back.

### 46. Engineering lots: held after every step

**Need.** Engineering lots (not yet production) sometimes need an engineer to look at them after each
step before they go on.

On the lot, a yes / no that the engineer sets:

```json
"hold_every_step": { "label": "Hold after every step", "type": "boolean" }
```

A transaction that holds the lot when it says so:

```json
{
  "name": "hold_if_asked", "label": "Hold if asked",
  "inputs": { "lot": { "label": "Lot", "type": "ref", "to": "lot", "required": true } },
  "appearsOn": { "object": "lot", "fills": "lot" },
  "require": [],
  "steps": [ { "on": "lot", "action": "hold", "when": { "eq": [{ "lookup": "lot.hold_every_step" }, true] } } ],
  "confirm": false,
  "callers": { "users": [], "groups": [], "flows": ["molding_route"] },
  "stewards": ["engineering"]
}
```

On the engineering route:

```json
"everySequence": { "onExit": { "run": "hold_if_asked" } }
```

- The lot goes on to its next step, held there; the engineer releases it from the held-lots list
  (use case 36) when satisfied.
- One `everySequence` runs one transaction: to combine this with future holds (use case 34), put both kinds
  of step in the same transaction.

### 47. Out-of-control action plan (OCAP)

**Need.** A major or critical deviation holds the lot, asks Quality to contain it, waits for the lab,
lets Engineering name the cause, and ends with Quality's disposition.

```json
{
  "name": "deviation_response", "label": "Deviation response", "kind": "plan",
  "participants": { "deviation": { "object": "deviation", "as": "subject" }, "lot": { "object": "lot", "as": "reference", "from": "deviation.lot" } },
  "nodes": {
    "start": { "kind": "start", "label": "Deviation raised", "when": { "in": [{ "context": "deviation.severity" }, ["major", "critical"]] }, "onEnter": "flow_hold_lot" },
    "contain": { "kind": "input_screen", "label": "Contain", "message": "Quarantine the lot and what it touched; say what was done.",
                 "for": { "users": [], "groups": ["quality"] },
                 "fields": [{ "name": "action", "label": "What was done", "type": "string", "required": true }, { "name": "photo", "label": "Photo", "type": "image" }] },
    "lab": { "kind": "wait", "label": "Await the lab", "message": "Wait for the lab's result.", "seconds": 14400, "mode": "acknowledge", "for": { "users": [], "groups": ["quality"] } },
    "cause": { "kind": "manual_decision", "label": "Root cause?", "message": "What caused it?", "for": { "users": [], "groups": ["engineering"] } },
    "fix": { "kind": "wait", "label": "Fix the machine", "message": "Repair and requalify; Retry goes back to the lab.", "seconds": 3600, "mode": "retry", "for": { "users": [], "groups": ["production"] } },
    "disposition": { "kind": "input_screen", "label": "Disposition", "for": { "users": [], "groups": ["quality"] },
                     "fields": [{ "name": "decision", "label": "Decision", "type": "enum", "values": ["accept", "rework", "reject"], "required": true }] },
    "decide": { "kind": "auto_decision", "label": "Rejected?" },
    "rejected": { "kind": "end", "label": "Rejected", "outcome": "rejected" },
    "closed": { "kind": "end", "label": "Closed", "outcome": "closed" }
  },
  "edges": [
    { "from": "start", "to": "contain" }, { "from": "contain", "to": "lab" }, { "from": "lab", "to": "cause" },
    { "from": "cause", "to": "fix", "label": "Machine" }, { "from": "cause", "to": "disposition", "label": "Material" },
    { "from": "fix", "to": "lab", "retry": true }, { "from": "fix", "to": "disposition" },
    { "from": "disposition", "to": "decide" },
    { "from": "decide", "to": "rejected", "when": { "eq": [{ "context": "decision" }, "reject"] } },
    { "from": "decide", "to": "closed" }
  ],
  "roles": { "lot": ["router"] }, "stewards": ["quality"]
}
```

- The deviation object says it may set plans off: `"flow": { "as": ["subject"] }`.
- A plan sets off by itself when a deviation is raised or changed where its start holds, once per
  deviation. Each step waiting for someone appears in their bell (**Plans waiting for you**). What they
  enter goes into the plan's context, which later decisions read (`{"context": "decision"}`).

### 48. Preventive maintenance by count

**Need.** A press is maintained every 50 000 shots.

On the machine, two numbers, a policy that lets Track out count, and the plan's role:

```json
"fields": {
  "shots": { "label": "Shots since PM", "type": "integer" },
  "pm_every": { "label": "PM every (shots)", "type": "integer" }
},
"policies": [
  { "id": "machine-count", "roles": ["operator"], "via": ["track_out"], "fields": { "shots": "write" } }
],
"flow": { "as": ["resource", "subject"] }
```

Track out counts (one more step):

```json
{ "on": "machine", "set": { "shots": { "add": [{ "lookup": "machine.shots" }, { "lookup": "lot.qty" }] } } }
```

A plan starts when the count is reached, and again each time after:

```json
{
  "name": "pm_by_count", "label": "PM by shots", "kind": "plan",
  "participants": { "machine": { "object": "machine", "as": "subject" } },
  "nodes": {
    "start": { "kind": "start", "label": "Count reached", "again": true, "when": { "ge": [{ "context": "machine.shots" }, { "context": "machine.pm_every" }] } },
    "do_pm": { "kind": "input_screen", "label": "Do the PM", "for": { "users": [], "groups": ["maintenance"] }, "onExit": "pm_reset_count",
               "fields": [{ "name": "done", "label": "What was done", "type": "string", "required": true }] },
    "done": { "kind": "end", "label": "Done" }
  },
  "edges": [ { "from": "start", "to": "do_pm" }, { "from": "do_pm", "to": "done" } ],
  "roles": { "machine": ["maintenance"] }, "stewards": ["production"]
}
```

```js
// Leaving the PM: the count starts again.
export default function pm_reset_count(ctx) {
  ctx.writes.push({ record: "machine", set: { shots: 0 } });
  return ctx;
}
```

- `again: true` sets the plan off once more after its last run for that machine has ended.

### 49. Preventive maintenance by date

**Need.** A calibration is due on a date kept on the gauge.

```json
"start": { "kind": "start", "label": "Calibration due", "due": "next_calibration", "again": true }
```

- `due` names a date field of the plan's subject: when the date arrives, the plan starts by itself,
  with nobody writing anything. Have its last step's script set the next date (a write, as in use case
  48), and `again` starts it once more then.

### 50. Scanning without a mouse (input flow)

**Need.** At Move in, the operator scans the lot, then the machine, and it runs; a held lot stops the
flow there.

```json
{
  "name": "scan_move_in", "label": "Scan to move in", "kind": "input",
  "nodes": {
    "start": { "kind": "start", "label": "Start" },
    "lot": { "kind": "ask", "label": "Scan the lot", "input": "lot", "advance": "auto" },
    "held": { "kind": "auto_decision", "label": "On hold?" },
    "stop": { "kind": "end", "label": "Held", "then": "stop" },
    "machine": { "kind": "ask", "label": "Scan the machine", "input": "machine", "advance": "enter" },
    "go": { "kind": "run", "label": "Move in", "confirm": "auto" },
    "next": { "kind": "end", "label": "Next lot", "then": "repeat" }
  },
  "edges": [
    { "from": "start", "to": "lot" }, { "from": "lot", "to": "held" },
    { "from": "held", "to": "stop", "when": { "eq": [{ "lookup": "lot.state" }, "on_hold"] } },
    { "from": "held", "to": "machine" },
    { "from": "machine", "to": "go" }, { "from": "go", "to": "next" }
  ],
  "stewards": ["production"]
}
```

The transaction (or a screen) names it: `"inputFlow": "scan_move_in"`.

- `advance` is what moves on: Enter (a scanner's too), Tab, a key of its own, or `auto` (a scan that
  found its record). A signature is always asked for.

---

## G. Integration: other systems

### 51. The ERP as a connection

```json
{
  "name": "erp", "label": "ERP",
  "baseUrl": "https://erp.plant.example/api",
  "auth": { "kind": "bearer", "secret": "erp_token" },
  "allow": [ { "method": "GET", "path": "/orders*" }, { "method": "POST", "path": "/confirmations" } ],
  "timeoutMs": 5000,
  "stewards": ["engineering"]
}
```

- The secret's value is set on the server, never in a design. A service may send only what `allow`
  lists (a trailing `*` allows what follows).

### 52. ERP sends work orders (a web service)

```json
{
  "name": "wo_from_erp", "label": "Work order from ERP",
  "input": {
    "wo_no": { "label": "Work order no.", "type": "string", "required": true },
    "item": { "type": "string", "required": true },
    "qty": { "type": "decimal", "required": true },
    "line": { "type": "enum", "values": ["L1", "L2", "L3"], "required": true }
  },
  "http": { "enabled": true },
  "callers": { "users": ["erp"], "groups": [] },
  "on": [],
  "runAs": "service", "roles": { "work_order": ["planner"] },
  "uses": { "connections": [], "objects": { "work_order": ["create"] } },
  "stewards": ["production"]
}
```

```js
// ERP sends a work order; it is created through the work order's policies and rules.
export default async function wo_from_erp(ctx) {
  const wo = await ctx.records.create("work_order", { wo_no: ctx.input.wo_no, item: ctx.input.item, qty: ctx.input.qty, line: ctx.input.line });
  ctx.output = { id: wo.id, wo_no: wo.wo_no, state: wo.state };
  return ctx;
}
```

- ERP calls `POST /svc/v1/wo_from_erp` with its token; an `Idempotency-Key` header makes a retry safe.
  `GET /svc/v1/openapi.json` describes what that token may call.

### 53. ERP is told when a lot is released (a trigger)

```json
{
  "name": "lot_released_to_erp", "label": "Lot released → ERP",
  "input": {}, "http": { "enabled": false }, "callers": { "users": [], "groups": [] },
  "on": [ { "object": "lot", "event": "transition:release" } ],
  "runAs": "erp",
  "uses": { "connections": ["erp"], "objects": { "lot": ["read"] } },
  "stewards": ["production"]
}
```

```js
export default async function lot_released_to_erp(ctx) {
  const lot = await ctx.records.get("lot", ctx.event.id);
  const res = await ctx.http("erp", { method: "POST", path: "/confirmations", body: { lot_no: lot.lot_no, qty: lot.qty, uom: lot.uom } });
  if (res.status >= 500) throw Object.assign(new Error("ERP is unavailable"), { retry: true });
  if (!res.ok) throw new Error("ERP refused the confirmation (" + res.status + ")");
  ctx.output = { confirmation: res.body.id };
  return ctx;
}
```

- Triggers run after the write is saved, never inside it. A `retry` error is tried again later; every
  run is in the integration monitor.
- Events are `create`, `update`, `archive`, `restore` and `transition:<action>`.

### 54. Pull from ERP every 15 minutes (a schedule)

```json
"on": [
  { "schedule": { "every": { "minutes": 15 }, "between": ["06:00", "22:00"], "days": ["mon", "tue", "wed", "thu", "fri"], "tz": "Europe/Berlin" },
    "missed": "last", "overlap": "skip" }
]
```

```js
export default async function pull_orders(ctx) {
  const res = await ctx.http("erp", { method: "GET", path: "/orders", query: { status: "released" } });
  if (!res.ok) throw Object.assign(new Error("ERP did not answer (" + res.status + ")"), { retry: true });
  for (const o of res.body.orders) {
    const [there] = await ctx.records.list("work_order", { wo_no: o.number });
    if (!there) await ctx.records.create("work_order", { wo_no: o.number, item: o.item, qty: o.qty, line: o.line });
  }
  ctx.output = { seen: res.body.orders.length };
  return ctx;
}
```

- Or at fixed times: `{ "schedule": { "at": ["06:00", "14:00", "22:00"] } }`. The designer shows the
  next runs. `missed` says what to do with runs missed while the plant's servers were down.

### 55. A service that runs a transaction

**Need.** An automated cell reports that a lot is on a machine; the MES should do exactly what Move in
does, checks included.

```json
"uses": { "connections": [], "objects": {}, "transactions": ["move_in"] }
```

```js
export default async function cell_move_in(ctx) {
  const run = await ctx.transactions.run("move_in", { lot: ctx.input.lot, machine: ctx.input.machine }, { key: ctx.input.event_id });
  ctx.output = { run: run.run };
  return ctx;
}
```

- Move in must name it among its callers (`"callers": { …, "services": ["cell_move_in"] }`). A signed
  transaction is never run by a service.

---

## H. Reports and analysis

### 56. A named query with parameters

```json
{
  "name": "scrap_by_reason", "label": "Scrap by reason",
  "sql": "SELECT scrap_reason, sum(scrap_qty) AS scrap\nFROM lot\nWHERE item = :item\nGROUP BY scrap_reason\nORDER BY scrap DESC",
  "params": { "item": { "type": "string", "label": "Item", "required": true } },
  "limit": 200,
  "tests": [ { "name": "nylon", "params": { "item": "PA66-NAT-25" } } ],
  "stewards": ["production"]
}
```

- Queries run as the viewer, over views named after the objects, and see only what that person may
  read. Sensitive fields are not there.

### 57. The daily report the AI fills in

```json
{
  "name": "daily_report", "label": "Daily report",
  "guidance": "Cover the last 24 hours. Lead with what needs action today. Name lots and machines by their labels, never by an id.",
  "blocks": [
    { "block": "text", "width": "full", "title": "The situation", "hint": "Three sentences at most, with the numbers." },
    { "block": "figure", "width": "quarter", "title": "Lots released", "hint": "Lots released in the last 24 hours." },
    { "block": "figure", "width": "quarter", "title": "Lots on hold", "hint": "Lots held now." },
    { "block": "chart", "chart": "line", "width": "half", "title": "Released per day", "hint": "The last 7 days, oldest first." },
    { "block": "table", "width": "full", "title": "Waiting longest", "hint": "The ten lots longest in their state." }
  ],
  "stewards": ["production"]
}
```

- A layout holds no query: the analytics copilot fills it from what the person asking may read, and
  every number comes from a query it ran.

### 58. Analytics: what to slice by

```json
"analytics": { "dimensions": ["item", "uom"] }
```

- The analytics page counts the object's records and the time between its states, sliced by those
  fields.

---

## I. The organization

### 59. Who approves designs, and who uses what

```json
{
  "governance": "engineering",
  "roles": {
    "lot": { "operator": ["group:production"], "quality": ["group:quality"] },
    "future_hold": { "engineer": ["group:engineering", "group:quality"], "viewer": ["group:production"] },
    "design": { "designer": ["user:dana", "user:sam"], "reviewer": ["user:vera"] }
  }
}
```

- An object declares its roles; People & departments says who holds them (`user:<id>`, `group:<id>`).
  `design`, `query`, `auth`, `privacy` and `database` are the platform's own roles.
- `governance` approves what no one else stewards: new departments and people, among others.

### 60. How long data is kept

```json
"retention": { "conversations": 365, "integration": 730, "audit": "forever" }
```

- In days, or `forever`. Records and the audit trail are never purged by the platform (a floor of six
  years); the Data retention page counts what is past its period.

### 61. Who tunes the database

```json
"roles": { "database": { "administrator": ["user:ivan"] } }
```

- The Database area (IT only) shows every statement the platform sends, measured, with its plan; an AI
  may propose indexes, which the administrator builds or drops (audited, no change request).

---

## J. Putting it together, by industry

### 62. Recipes by industry

| Plant need | Use cases |
|---|---|
| **Semiconductors.** Wafer lots on a route with recipe settings per step | 1, 43 (`settings`), 28 (`node` limits) |
| Equipment qualified per process, operators certified per process | 7, 32 |
| Future hold, engineering holds after every step | 34, 46 |
| SPC readings with OCAP on a violation | 28, 29, 47 |
| PM by wafer count and by date | 48, 49 |
| **Medical devices.** A device history record: what was done, by whom, signed | 12, 31 |
| Patient data on a device's record | 10 |
| Release only with an accepted disposition, verified by Quality | 21, 31 |
| Nonconformance and CAPA as objects with plans | 1, 47 |
| **Aerospace.** Export-controlled products and everything made of them | 6, 11 |
| First article: readings per characteristic, signed | 28, 31 |
| Serial numbers, one record per part | 30 |
| **Automotive.** Traceability from part to lot to work order | 1 (references), 12 |
| Changes to released products approved by the owning engineers | 22, 23, 24 |
| Work orders from ERP, confirmations back | 51–54 |
| **Every plant.** Station screens, held lots, boards | 35–38 |
| A daily report | 57 |

---

## K. Queries that drive choices and tables

### 63. A reference's choices from a query

**Need.** A lot's press is picked among the presses only, never an oven, and the list says each by its id
and name.

The query (it gives the records' `id`):

```json
{
  "name": "machines_of_kind", "label": "Machines of a kind",
  "sql": "SELECT id, machine_id, name, kind\nFROM machine\nWHERE kind = :kind\nORDER BY machine_id",
  "params": { "kind": { "type": "string", "label": "Kind", "required": true } },
  "limit": 200, "tests": [{ "name": "presses", "params": { "kind": "press" } }],
  "stewards": ["production"]
}
```

The lot's field:

```json
"press": { "label": "Press", "type": "ref", "to": "machine",
           "options": { "query": "machines_of_kind", "display": ["machine_id", "name"], "params": { "kind": "press" } } }
```

- The picker lists the query's rows as the field is entered, run as the person (what they may not read is
  not there), narrowed as they type.
- A save naming any other machine is refused on the field: "That press is not one of its choices".
- A parameter may read the form being filled: `{"data": "line"}` gives the presses of the lot's line.

### 64. Choices that follow another input

**Need.** A transaction asks for the kind of machine first, then offers only machines of that kind.

```json
"inputs": {
  "lot": { "label": "Lot", "type": "ref", "to": "lot", "required": true },
  "kind": { "label": "Kind", "type": "enum", "values": ["press", "oven"], "required": true },
  "machine": { "label": "Machine", "type": "ref", "to": "machine", "required": true,
               "options": { "query": "machines_of_kind", "display": ["machine_id"], "params": { "kind": { "input": "kind" } } } }
}
```

- Its parameters read the inputs (`{"input": "kind"}`), the records they name (`{"lookup": "lot.item"}`), the
  person and the route step's settings (`{"node": "area"}`): the tools qualified for the step a lot is at.
- A run naming a machine the query does not give is refused on that input.

### 65. A screen table of a query's rows

**Need.** A board of the lots in a state, with what a query works out about them, and a Release button on
each.

```json
{
  "name": "lots_in_state", "label": "Lots in a state",
  "sql": "SELECT id, lot_no, item, qty, state\nFROM lot\nWHERE state = :state\nORDER BY lot_no",
  "params": { "state": { "type": "string", "label": "State", "required": true } },
  "limit": 500, "tests": [{ "name": "on hold", "params": { "state": "on_hold" } }],
  "stewards": ["quality"]
}
```

```json
{
  "name": "held_board", "label": "Held lots board", "params": {},
  "blocks": [
    { "block": "table", "title": "On hold", "query": "lots_in_state", "params": { "state": "on_hold" },
      "columns": ["lot_no", "item", "qty"], "sort": { "field": "lot_no", "dir": "asc" },
      "object": "lot", "rowActions": ["release_lot"], "rowActionsIn": "panel", "width": 12 }
  ],
  "callers": { "users": [], "groups": ["quality"] }, "stewards": ["quality"]
}
```

- The rows are the query's, run as the viewer: whatever it joins and works out (a wait in hours, a
  product's family). Ids show as their records' titles.
- `object` makes each row its record: it links to it, and offers that object's transactions; when the query
  gives a `state` column, only those whose states it is in.
- Its parameters read the screen's parameter (`{"param": "machine"}`) and the viewer.

### 66. Kept in line when a query or a field changes

**Need.** Someone narrows a query a live screen shows, or takes from an object a field a query reads; nothing
should break unnoticed.

- A query's **Used by** tab shows the columns it gives (described by the database without running it) and
  every design that names them: the fields and inputs whose choices it gives, the tables of its rows, the
  plans' lists.
- A change that takes a column from a query names every design that shows it, in the change or not:
  "Held lots board (not in this change), table "On hold": its columns uses "qty", which lots_in_state does
  not give". A change that takes a field from an object names each query that reads it.
- **Align** brings those designs into the change, each without what is no longer there, to approve with the
  rest.

