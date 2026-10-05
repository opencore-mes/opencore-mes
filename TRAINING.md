# OpenCore MES training guide

A hands-on course for the people who will design and look after the plant's system: process and
quality engineers (designers), their reviewers and department representatives, and IT integrators.
Every exercise runs on the demo system with its seeded people and records, so trainees can try
everything, make mistakes, and reset.

[USERGUIDES.md](USERGUIDES.md) is the reference to keep open beside this course: this guide says what
to do, the user guide explains each screen.

| | |
|---|---|
| **Length** | One day for modules 1–6; add half a day for modules 7–9 and the final project, and two hours for module 10 |
| **Format** | Short demonstration by the trainer, then the exercise, then the review questions |
| **Group** | Up to 8 trainees, in pairs: one designs, the other reviews and approves, then swap |
| **You need** | A laptop with a browser; two browser windows (one normal, one private) to be two people at once |

## Contents

- [Before the course (trainer)](#before-the-course-trainer)
- [A blank training instance](#a-blank-training-instance)
- [The cast](#the-cast)
- [Module 1: The plant floor](#module-1-the-plant-floor)
- [Module 2: Your first change](#module-2-your-first-change)
- [Module 3: Who may do what](#module-3-who-may-do-what)
- [Module 4: Rules with test cases](#module-4-rules-with-test-cases)
- [Module 5: Archiving and restoring](#module-5-archiving-and-restoring)
- [Module 6: Analytics](#module-6-analytics)
- [Module 7: Services and connections](#module-7-services-and-connections)
- [Module 8: Schedules and the integration monitor](#module-8-schedules-and-the-integration-monitor)
- [Module 9: Designing with an AI (optional)](#module-9-designing-with-an-ai-optional)
- [Module 10: Flows: plans, sub flows and input flows](#module-10-flows-plans-sub-flows-and-input-flows)
- [Final project](#final-project)
- [Track B: a plant from nothing](#track-b-a-plant-from-nothing)
- [Trainer notes](#trainer-notes)

---

## Before the course (trainer)

1. Install and start the demo system (details in [app/mes/README.md](app/mes/README.md)):
   ```bash
   npm install
   npm run db:reset      # a fresh demo database: seeded people, objects and records (later
                         # upgrades apply themselves when the server starts)
   npm run dev           # http://127.0.0.1:9090, and every address of this machine (PORT=… for another port, HOST=127.0.0.1 for this machine only)
   ```
2. **Reset before every session** with `npm run db:reset`: exercises change the objects, and a later
   group should start from the same place. Stop the server first, and start it again after.
3. Check you can sign in (the development picker lists the seeded people, no passwords) and that
   **Designer** appears in the navigator when signed in as Dana.
4. Module 7's web-service exercise needs a token; issue one before the course:
   `node app/mes/db/token.mjs erp "ERP training"` (it is printed once).
5. Module 9 needs an AI provider configured in `.env` (see the README); skip the module otherwise.

## A blank training instance

For a course where trainees model the plant themselves ([Track B](#track-b-a-plant-from-nothing)),
run a **training instance**: a second system on the same machine, beside the development one and
never touching its data.

```bash
npm run training:reset    # its own database (openmes_training), blank: people only
npm run training          # http://<this machine>:9091; trainees open it from their laptops
```

- **People only:** the cast below, their departments and approval steps (IT approves in two), and
  their roles on the designer and the query page. No objects, transactions, screens or records: every
  model is designed during the course, through the change lifecycle.
- **Its own sign-in:** signing in on :9091 does not sign anyone out of :9090. Every page's header says
  **TRAINING**.
- **Reset between groups** with `npm run training:reset` (stop it first, start it again after). It
  can never reset the development database: `TRAINING_DATABASE_URL` (default
  `postgres:///openmes_training`) is refused when it names that one. `TRAINING_PORT` changes the port.
- **After the code is upgraded**, stop it and start it again (`npm run training`): it upgrades its own
  database at start (`database: applied …`). A start refused with `EADDRINUSE` means the old one is
  still running on its port: stop that one first.
- Olga and the ERP user hold no roles yet: they can sign in, and see nothing until a change gives
  their departments a role on something.
- **Locked out?** A change that leaves nobody a designer (or nobody else to review) is refused. If an
  instance got there anyway, `npm run training -- --recover-designer dana --reviewer vera "why"`
  gives the roles back (audited); then Dana puts the rest right through a change. Or reset it.

## The cast

Trainees play these people. Sign in as the one an exercise names; use the private window for the
second person.

| Person | Department | In this course |
|---|---|---|
| **Olga Ortiz** | Production | Operator: creates and works lots |
| **Sam Lee** | Production | Supervisor; **approves for Production** |
| **Quinn Park** | Quality | Quality: dispositions; **approves for Quality** |
| **Dana Reyes** | Engineering | **The designer**: drafts every change |
| **Eli Brandt** | Engineering | **Reviewer**; approves for Engineering |
| **Vera Novak** | — | Independent **reviewer**, representing no department |
| **ERP integration** | — | The outside system's user, for web services |

**Remember the segregation of duties:** the author never reviews or approves their own change, and
whoever reviews a change cannot also approve it. So when a change needs Production and Quality,
**Eli or Vera reviews**, and Sam and Quinn approve.

---

## Module 1: The plant floor

**You will learn** how people use what designers build: live screens, rules as they type,
"Why can't I?", a screen that fills the window, and Excel that never undoes a colleague's work. Every
later module changes something you will see here.

### Exercise 1.1: Live screens
1. Window A: sign in as **Olga**. Type `lot` in the navigator's search, open **Lot** (star it to keep it at the top), then lot **4712**.
2. Window B (private): sign in as **Quinn**. Open lot **4712** too.
3. Both windows show a presence banner: the other person is viewing this lot.
4. In window B, change **Disposition** and **Save**.

**You should see** window A follow at once, without reloading. While Quinn is typing, Olga's banner
says Quinn is **editing**.

### Exercise 1.2: Rules as you type, and at the server
1. As **Olga**, on lot 4712, type `-5` in **Quantity**. The message appears as you type: the lot's
   rule pipe runs in the browser on every keystroke.
2. Type `5000` and **Save**. This time the **server** refuses: "At most … 5% over the order quantity".
   That rule looks up the work order, which only the server does.
3. **Discard**.

### Exercise 1.3: Why can't I?
1. As **Olga**, open lot **4711** (released). **Quantity** is locked.
2. Press **Why?** next to it.

**You should see** the policy that grants the change, its condition (the state must be created or in
process), the lot's state (released), and what to do instead: correct it through a deviation. None of
it is guessed: it is the system's own decision.

### Exercise 1.4: The record's story
On lot 4712, open **History** (every change, who, when, which rules ran) and **Timeline** (each state,
how long it stayed there).

### Exercise 1.5: Fill the window (Olga)
At a machine, a tablet shows one task, nothing else.
1. As **Olga**, open **Move in** (type `move in` in the navigator's search). Press **Maximize** beside its title.
2. The top bar, the navigator and the tabs step aside. Beside **Restore** stay her name and **live**:
   who a signature will name, and whether what she sees is current.
3. Reload the page: it is still filled. This device remembers, per transaction.
4. Press **Restore**. Open **Shop floor** (search `shop floor` in the navigator): its design opens it filled, a board
   for a wall. Restore it; reload: this device now remembers that too.
5. In the top bar, pick **Dark**, then **Light**: it is Olga's, on every device she signs in on. (A
   plant may choose one for everyone in People & departments → **Theme**; then there is no choice.)

### Exercise 1.6: Excel, and the copy it was made from (Sam)
1. As **Sam**, open **Data → Import / export**, tick **Work order**, untick **Include the records they
   refer to**, and export.
2. Open work order **WO-1002** and change its **Quantity**; **Save**. (A colleague did it after your
   export.)
3. Back on **Import / export**, choose the file you exported. The preview refuses WO-1002: "changed
   since this file was exported", with both versions and who changed it last. Applying the file would
   have put the old quantity back without anyone noticing.
4. In Excel, empty WO-1002's **row_version** cell, save, and choose the file again: now it is **to
   update**. An empty cell writes over the record on purpose. Do not apply it.
5. Export **Lot** too, and keep that file. After Module 2 (which changes the lot's design), choose it
   on **Import / export**: the preview says it was exported from an older version of Lot than the one
   in use. A new optional field (`batch_ref`) changes nothing the file holds, so it adds that the fields
   read as they did, and warns that a value may still mean something else (a unit). A removed or
   retyped field would be named. Where such a file has rows to apply, **Apply** asks you to confirm
   first.

**Review questions**
1. Why does the negative quantity show at once, but the 5000 only on save?
2. Where does the text of a "Why?" answer come from?
3. What would Olga see if the database stopped answering while she saves? (User guide, section 15.)
4. Who decides whether a transaction or a screen may fill the window? Who decides it on one tablet?
5. Why does an export carry a `row_version` column?

---

## Module 2: Your first change

**You will learn** the one rule: design → review → approval → execution. Nothing reaches the plant
another way.

### Exercise 2.1: Draft the change (Dana)
1. Sign in as **Dana**. Open **Designer**. Next to **Lot**, press **Change**.
2. In the change request, open the **Fields** tab. Add a field named `batch_ref`, label
   **Batch reference**, type `string`.
3. Watch **Will need approval from** in the side panel: **Production** and **Quality**, the lot's
   stewards. A new field with no stewards of its own answers to the object's.
4. Open **Layout** and put `batch_ref` in the **Quality** section, then check **Preview**.
5. Write the reason in **Why this change**: "Record the supplier batch reference for traceability."
6. Press **Run fitness test** and read it: no problems, and the access changes it lists: every role
   that reads lots can now read the new field, in every state.
7. **Submit for review.**

### Exercise 2.2: Review (Eli)
1. Window B: sign in as **Eli**. Open **Designer**, then the change in **Change requests**.
2. Read the reason, the footprint and the fitness report. The content was frozen when Dana submitted:
   what the departments approve is exactly what you read.
3. Press **Pass review**. (Try **Ask for changes** in a later round: it needs a note, and returns the
   change to Dana.)

### Exercise 2.3: Approve (Sam, then Quinn)
1. Sign in as **Sam**, open the change, **Approve for Production**.
2. Sign in as **Quinn**, open the change, **Approve for Quality**.

**You should see** the change go to **Execution** and then executed by the platform, the moment the
last department approves. Open any lot: **Batch reference** is on the form, on every screen, with no
restart.

### Exercise 2.4: What the rules stop
Look at what each person is **not** offered (the server refuses the same, however it is asked):
- As **Dana**, open her change while it is in review: no **Pass review**. An author never reviews or
  approves their own change.
- Start a second change as Dana and submit it; as **Sam**, open it in review. The panel warns that if
  he reviews it he cannot also approve it for Production. Pass it; in approval, he is not offered
  **Approve for Production**.
- As **Dana**, try to **Submit for review** with the reason empty: refused.

Withdraw the second change afterwards.

### Exercise 2.5: Two designers on one change (optional)
Only Dana designs in the demo, so first make Eli a designer too.
1. As **Dana**: Designer → **Change people & departments** → **Roles**: add Eli to the designers on
   the designer. Reason, submit; **Vera** reviews; **Eli** approves for Engineering.
2. As **Dana**, change **Work order**. At the top of the side panel, add **Eli** as a co-designer.
3. Window A, as **Dana**: start editing the description, and do not save yet.
4. Window B, as **Eli**: open the change, edit its label, **Save draft**.
5. Window A, as **Dana**: **Save draft**. Refused: "eli saved this draft since you opened it". **Load
   their version** brings Eli's work in; yours is replaced. Neither of you silently undid the other.
6. As **Dana**, start another edit; meanwhile, as **Eli**, press **Run fitness test**. Dana saves:
   accepted. A fitness run, a review or a signature never counts as a save.
7. As **Dana**, take Eli off the list: his page turns read only, and the panel lists him under "also
   worked on it". Dana submits. As **Eli**, open the change: he is not offered **Pass review**, and
   the server would refuse it. **Vera** reviews it instead.

### Exercise 2.6: Several designs, one change (optional)
One piece of work often spans several designs. They go through one change, approved once. (After 2.5,
finish or withdraw its change to Work order first: a design is in one open change at a time.)
1. As **Dana**, change **Work order** (Designer → **Change**). Add a field `customer_ref`, label
   **Customer reference**, type `string`.
2. In the bar above the editor, **Change also… → Lot → Bring in**. Lot opens in the window, as it is
   live; the title is now "Change Work order, Lot". Add `customer_ref` to Lot too.
3. **Will need approval from**: Production (both objects) and Quality (the lot): each department once,
   not once per object. Write the reason, run the fitness test (it checks each design), submit.
4. **Eli** reviews once; **Sam** approves for Production, **Quinn** for Quality. Both objects change at
   the same moment: open a lot and a work order.
5. Try **Change also…** with an object that another open change holds (start one on Machine first): it
   is refused, naming that change. Withdraw it afterwards.

**Review questions**
1. Why did Quality have to approve a field that production operators will never write?
2. Who executes a change, and when?
3. What happens to a change if someone else's change to lots executes first?
4. Eli was taken off the list before Dana submitted. Why may he still not review it?
5. In 2.6, Production had two objects in the change. How many times did Sam sign, and what would
   happen if Lot had changed live between step 2 and the approval?

---

## Module 3: Who may do what

**You will learn** that access is denied unless a policy grants it, and how to make every "no"
explain itself.

### Exercise 3.1: Grant a field in a state (Dana)
Goal: Quality may write **Batch reference** while a lot is **on hold**, and nobody else may write it.
1. Change **Lot**, open **Roles & policies**.
2. Open the policy `lot-quality-disposition` (roles: quality; condition: in process or on hold). Grant
   `batch_ref` **write**.
3. Check **Will need approval from**: the policy touches the states its condition names.
4. Add a **hint**: open the **JSON** view, add `"write:batch_ref": "Quality records the batch
   reference while the lot is in process or on hold."` to `hints`, and **Apply JSON**.
5. Reason, fitness test, submit. Eli reviews, Sam and Quinn approve.

### Exercise 3.2: Test it as the people concerned
1. As **Quinn**, open lot 4712 (in process): **Batch reference** is writable. Save a value.
2. As **Olga**, open lot 4712: it is read only. **Why?** shows the policy, the role it needs, and your
   hint.
3. As **Quinn**, open lot 4711 (released): read only, because of the state.

**Review questions**
1. A policy grants and a deny locks: which wins when both apply?
2. Why can a condition not say "only until the end of the shift"? Where would such a check go?

---

## Module 4: Rules with test cases

**You will learn** the rule-script contract (context in, context out, throw to refuse) and why every
script carries its evidence.

### Exercise 4.1: Write the rule (Dana)
Goal: a batch reference, when given, looks like `B-1234`.
1. Change **Lot**, open **Rules**. Type `lot_batch_ref_format` as the new script's name and press
   **Add to pipe**. Open the script and replace its text with:
   ```js
   // A batch reference, when given, is B- and four digits.
   export default function lot_batch_ref_format(ctx) {
     if (ctx.event.kind === "change" && !ctx.event.changed.includes("batch_ref")) return ctx;
     const v = ctx.data.batch_ref;
     if (v && !/^B-\d{4}$/.test(v)) {
       throw Object.assign(new Error("A batch reference is B- and four digits, e.g. B-0421."), { field: "batch_ref" });
     }
     return ctx;
   }
   ```
2. Leave its **writes** empty: it changes nothing.
3. Put its test cases in the script's **test cases** box:
   ```json
   [
     { "name": "a good one", "run": { "event": { "kind": "save" }, "data": { "batch_ref": "B-0421" } }, "expect": { "changed": [] } },
     { "name": "a bad one", "run": { "event": { "kind": "save" }, "data": { "batch_ref": "421" } }, "expect": { "throws": { "field": "batch_ref" } } },
     { "name": "none given", "run": { "event": { "kind": "save" }, "data": {} }, "expect": { "changed": [] } }
   ]
   ```
4. In the script's **Dry run** panel, run it on `{ "event": { "kind": "change", "changed": ["batch_ref"] }, "data": { "batch_ref": "x" } }`
   and read the error.
5. Run the fitness test: the three cases pass. Submit; review; approve.

### Exercise 4.2: Break it on purpose
In a new change, edit the script so it sets `ctx.data.batch_ref = v.toUpperCase()`. Dry run it: it
fails, because the pipe entry does not declare `batch_ref` in **writes**. Declare it, and it passes.
Then make it loop: replace its body with `while (true) {}` and dry run it. It is stopped after a fraction
of a second and reported as a fault, and nothing else waits on it: every script runs in a separate
script runner, which holds no password or key, reads none of the server's files, and reaches a record
or another system only through what `ctx` hands it. Then withdraw the change.

### Exercise 4.3: See it work
As **Quinn**, type `421` in **Batch reference** on lot 4712: the message appears as you type. Type
`B-0421`: it goes away, and **Save** is allowed.

**Review questions**
1. Why must a script use `ctx.now` and never `Date`?
2. Why can a script not call ERP? What do you use instead?
3. What does the fitness test do with a changed script that has no test cases?
4. A script loops forever on a save. What does the operator see, and what is saved?

---

## Module 5: Archiving and restoring

**You will learn** that nothing is deleted: a record is archived, and archiving follows the same
policies and rules as everything else.

### Exercise 5.1: Refused by the rule
1. As **Sam**, open lot **4712** and take the action **Hold**.
2. Press **Archive**. The lot's rule `lot_archive_checks` refuses: the disposition is not decided. The
   refusal is audited (see **History**).

### Exercise 5.2: Archive and restore
1. As **Quinn**, set **Disposition** to `reject` and save.
2. As **Sam**, **Archive** it (confirm). The lot leaves the list; tick **Show archived** to see it.
   Its form is read only, with a banner saying who archived it.
3. As **Olga**, try to change it, and press **Why?**: "archived … read only until it is restored".
4. As **Sam**, **Restore** it. It is back in the list, and editable as before.
5. Open **Timeline**: archiving ended the stay on hold; restoring started a new one.

**Review questions**
1. Which policy lets Sam archive, and in which states? Why can Olga not?
2. Why is the archived time not counted as time "on hold"?

---

## Module 6: Analytics

**You will learn** to read the time records spend in each state, and how dimensions let you compare.

### Exercise 6.1: Make some history
As **Olga**, create three lots (**New** on the Lot list) for the work order WO-1001, two of item
`PA66-NAT-25` and one of `PP-BLK-10`. Start each one. As **Quinn**, set their disposition to `accept`
and **Release** them, a few minutes apart.

### Exercise 6.2: Read it
1. On the Lot list, press **Analytics**.
2. **Now:** the lots in each state at this moment and how long they have been there.
3. **Time in each state:** average, median, 90th percentile.
4. **Lead time:** from **created** to **released**. Open the slowest lot from the list.
5. Set **By** to `item` and compare the two items.
6. **Entries:** lots released per day.

### Exercise 6.3: A new dimension (Dana)
Add `work_order` to Lot's **Analytics dimensions** (General tab) through a change, and get it
approved. New stays carry it from then on.

**Review questions**
1. A lot's item is changed after it was created. Under which item does its first stay count, and why?
2. Who may see a lot's analytics? Who may group them by a field?

---

## Module 7: Services and connections

**You will learn** how the MES talks to other systems: connections describe them, services act, and
the change lifecycle governs both.

### Exercise 7.1: A connection (Dana)
1. In **Designer**, **New connection**: name `erp_demo`, label **ERP (training)**.
2. **General:** base URL `https://erp.example.com/api`.
3. **Authentication:** `none` for this exercise (a real one names a secret whose value IT sets on the
   server).
4. **Allowed requests:** `POST /confirmations`.

### Exercise 7.2: A service on a record event
1. **+ service** in the same change: name `erp_lot_released`.
2. **Identity:** its own service role, with the lot role `viewer`.
3. **Triggers:** Lot, `transition:release`.
4. **Reaches:** lot **read**; connection `erp_demo`.
5. **Script:**
   ```js
   // A released lot is confirmed to ERP.
   export default async function erp_lot_released(ctx) {
     const lot = await ctx.records.get("lot", ctx.event.id);
     const res = await ctx.http("erp_demo", { method: "POST", path: "/confirmations", body: { lot_no: lot.lot_no, qty: lot.qty } });
     if (res.status >= 500) throw Object.assign(new Error("ERP is unavailable"), { retry: true });
     if (!res.ok) throw new Error(`ERP refused the confirmation (${res.status})`);
     ctx.output = { confirmation: res.body?.id ?? null };
     return ctx;
   }
   ```
6. **Dry run** with the event `{ "kind": "transition:release", "object": "lot", "id": "<a lot's id>" }` and
   responses `{ "POST /confirmations": { "status": 201, "body": { "id": "C-1" } } }`. Nothing is sent.
   Then with `{ "status": 503 }`: the error asks for a retry.
7. Try `ctx.http("erp_demo", { method: "GET", path: "/orders" })` in a dry run: refused, because the
   connection does not allow it.
8. Look at **Will need approval from**: Engineering (the connection) and Production and Quality (it
   reacts to lots). An integration touching every department is reviewed by **Vera**.

Withdraw the change at the end, or approve it and watch module 8's monitor show its triggers
failing and retrying (erp.example.com does not answer).

### Exercise 7.3: A web service (optional)
A service with **General → web service** on, **Identity → callers**: `erp`, and an input
`wo_no` (string, required), approved, can be called with the token from the preparation:
```bash
curl -s -X POST http://127.0.0.1:9090/svc/v1/<name> -H "authorization: Bearer mes_…" \
     -H "content-type: application/json" -d '{"wo_no": "WO-9001"}'
curl -s http://127.0.0.1:9090/svc/v1/openapi.json -H "authorization: Bearer mes_…"
```
Try it without the token (401), with a missing input (400, per field), and twice with the same
`Idempotency-Key` header (the first answer, not a second run).

**Review questions**
1. Where is the secret's value, and who can see it?
2. Why does a trigger run after the release is committed, and never for one that was rolled back?
3. What does the service's identity decide, and who approves the roles it holds?

---

## Module 8: Schedules and the integration monitor

**You will learn** to run a service by the clock, and to watch and operate the plant's integration.

### Exercise 8.1: A scheduled service (Dana)
1. **New service** `lots_in_process_count`. **Identity:** its own service role, lot role `viewer`.
   **Reaches:** lot **read**.
2. **Script:**
   ```js
   // Counts the lots in process, and how the count moved since the last run.
   export default async function lots_in_process_count(ctx) {
     const lots = await ctx.records.list("lot", { state: "in_process" });
     const before = ctx.event.previous?.output?.count ?? null;
     ctx.output = { count: lots.length, change: before === null ? null : lots.length - before };
     return ctx;
   }
   ```
3. **Triggers → Add schedule:** every **1 minute**, every day (so it runs whenever the course is
   held). Read **Next runs**, then try a window (**Only between**) and some weekdays, and watch the
   preview follow. Set **Missed runs** to "run the latest one", **While a run is still going** to
   "skip the new run".
4. Dry run with `{ "kind": "schedule", "scheduledAt": "2026-10-01T06:00:00Z" }` (a first run), then add
   `"previous": { "output": { "count": 1 } }` (a later one).
5. Submit; review; approve. (It reaches lots: Production and Quality approve.)

### Exercise 8.2: The integration monitor
1. Open **Integration monitor** in the navigator.
2. **Nodes:** your server, alive, planning schedules and running the outbox.
3. **Schedules:** `lots_in_process_count`, its next run. Wait a minute: its last run is **done**; open
   **Last runs**. Start a lot as Olga, and watch the next run's output count it.
4. **Pause** it; wait past a run time: nothing runs. **Resume**: it plans from now on. **Run now**:
   one run at once.
5. If you approved module 7's `erp_lot_released`, release a lot and watch **Record triggers** and
   **Outbound**: requests unreachable, the trigger retried, then dead. **Send again** from the
   service's **Activity** tab.

### Exercise 8.3: Where it runs (with IT)
Restart the server with `NODE_TAGS=erp npm run dev`. Set the service's **Run on nodes tagged** to
`erp` through a change. The monitor shows the node's tag, and warns when no live node has a service's
tag.

**Review questions**
1. The plant runs three servers. How many times does a 06:00 run happen?
2. The system was down from 06:00 to 07:10. What does "run the latest one" do?
3. Why is pausing an operation and not a design change?

---

## Module 9: Designing with an AI (optional)

**You will learn** to let an AI draft, while you stay the one who submits.

1. As **Dana**, change **Lot**, open **✦ Copilot**, and ask: "Add a boolean field *sample_taken* that
   quality sets while a lot is on hold, with a rule that a lot cannot be released unless it is true,
   and test cases."
2. Read what it drafted, field by field, and the script with its tests. Run the fitness test.
3. Note the **Drafted with AI** marks your reviewer will see.
4. On the designer home, **Issue token** for an outside AI with `design:read` and `design:draft`.
   Note there is no scope to review or approve. **Revoke** it.

**Review questions**
1. Who is responsible for a change the AI drafted?
2. Why does the AI never see a connection's secret?

---

## Module 10: Flows: plans, sub flows and input flows

**You will learn** how a plan (an OCAP) leads several people through a response, how a plan runs
another as a **sub flow**, how a template proves itself in the **sandbox** before anyone approves it,
and how an **input flow** lets an operator work from a scanner without the mouse. Flow templates are
designs like the rest: drawn in the designer, reviewed, approved.

Run it after a reset: it uses lot 4711 (released), 4712 (in process) and 4713 (created).

### Exercise 10.1: A plan at work (Olga, Quinn, Eli, Sam)
The seed's **Deviation response** plan sets off when a deviation is raised as major or critical.
1. As **Olga**, find **Deviation** in the navigator and create one: title "Specks in the regrind",
   lot **4713**, severity **major**. Save.
2. Open lot 4713: it is **On hold**. The plan's start held it, as the template, through the lot's own
   lifecycle. The deviation's page links the plan: **Deviation response · at Contain, for quality**.
   Open it: Olga may read it, and it says **Waiting for quality**: the next step is not hers.
3. As **Quinn**, the bell lists it under **Plans waiting for you**. Open **Contain**, say what was done,
   tick **Quarantined** (a photo is optional), **Send**. The plan moves to **Await the lab**:
   **Acknowledge** it, as if the lab's result were in.
4. As **Eli**, the bell has **Deviation response: Root cause?**. Eli holds no role on deviations, yet
   the decision is Engineering's, so it is his to make. Press **Method**.
5. As **Sam**, **Retrain the crew**: who was trained, **Send**.
6. As **Quinn**, **Disposition**: decision **accept**, **Send**. The plan ends **Closed**.
7. On the plan's page, **Show the flow**: the nodes it went through filled in, the wires it took
   marked. Point at a node for when it was there and who moved it on. Zoom with **−** and **+**.

The lot is still on hold: the plan recorded Quality's decision, and resuming or releasing the lot is
an action on the lot itself.

### Exercise 10.2: A sub flow (Dana)
The lab's result becomes a plan of its own, **Lab check**, that Deviation response runs and waits for.
1. As **Dana**: **Designer → Flows**, **Change** beside **Deviation response**.
2. **Add to this change**: **+ flow template**, name `lab_check`, **Add**.
3. In **lab_check**:
   - **General:** label **Lab check**, **Kind:** a plan (OCAP).
   - **Participants:** **+ a record**: Deviation, as subject. A sub flow is about the same record as
     the plan that runs it.
   - **Flow:** click **First step** (a route's step), **Remove the node**. **Add** an **Input screen**:
     label **Lab result**, **Who:** quality, **Collects:** **+ a field** `result`, label Result, type
     enum, values `pass, fail`, required. Wire **Start → Lab result → Done** (**Wire from here…**,
     then the node it goes to).
   - Leave **For events where** on its start empty: a plan that nothing sets off runs only as another
     plan's sub flow.
4. In **Deviation response**, **Flow:**
   - Click the wire from **Await the lab** to **Root cause?**, **Remove the wire**.
   - **Add** a **Sub flow**: label **Lab check**, **Runs:** `lab_check`, **Takes back:**
     `{"lab_result": "result"}` (its `result`, as `lab_result` here).
   - Wire **Await the lab → Lab check → Root cause?**. **Tidy** if it looks crowded.
5. Write the reason: "The lab's result as its own step, entered by Quality, kept with the deviation."
   Run the fitness test: **Scenarios in a sandbox** fails, "deviation_response: a new or changed flow
   template carries a scenario", and **Submit** is refused until it passes. Lab check needs none: it
   only ever runs inside another. The next exercise makes one.

### Exercise 10.3: Its evidence, in the sandbox (Dana)
1. In **Deviation response**, **Scenarios → Make one in the sandbox**.
2. **Records it starts with:** key `lot`, object Lot, picked from live, record **4711**, **Add**. Then
   **Open the sandbox**: the change's draft on copies of real records, in a database of its own.
   Nothing live is written.
3. **Run a step**, one at a time, then **Run**. **What ran** shows each one and where the plan is:

   | What | As | Settings |
   |---|---|---|
   | Make a record | Olga | Object Deviation; data `{"title": "Specks in the regrind", "lot": "@lot", "severity": "major"}`; name it `dev` |
   | Answer a plan | Quinn | Record @dev; fill its input screen in; values `{"action": "Bagged and tagged", "quarantined": true}` |
   | Answer a plan | Quinn | Record @dev; acknowledge its wait (the plan now waits for Lab check) |
   | Answer a plan | Quinn | Record @dev; plan **Lab check**; fill its input screen in; values `{"result": "pass"}` |
   | Answer a plan | Eli | Record @dev; pick a manual decision's choice: Material |
   | Answer a plan | Quinn | Record @dev; fill its input screen in; values `{"decision": "accept"}` |

4. **Keep it as a scenario of** Deviation response, named "A major deviation, the lab passes it",
   **Save the scenario**. It keeps the node each step reached, and expects them every time it runs.
5. **Back to the change**, run the fitness test: **scenarios: 1 of 1 passed**. **Will need approval
   from:** Production and Quality. Submit; **Eli** (or Vera) reviews; **Sam** approves for Production,
   **Quinn** for Quality.
6. Try it live. As **Olga**, raise a **critical** deviation on lot **4711**. A released lot is not
   held; the plan still runs. As **Quinn**, contain it and acknowledge the lab. The bell now has
   **Lab check: Lab result**, and its page says it is a sub flow of Deviation response. Enter **fail**:
   Deviation response goes on to **Root cause?**, and its **What it holds** has the lab result, fail.

**Sub flows nest, never in a circle.** A sub flow may run sub flows of its own, at most five plans
deep (the first and four below it); a run that would go deeper stops there, saying so. A template whose
sub flows lead back to itself is refused in the designer, the way round named.

### Exercise 10.4: An input flow at the press (Dana, then Olga)
1. As **Dana**: **Designer → Transactions**, **Change** beside **Move in**.
2. **Add to this change**: **+ flow template**, name `scan_move_in`, **Add**. **General:** label
   **Scan to move in**, **Kind:** an input flow. **Flow:** remove **First step**, then **Add**:
   - an **Ask**: label **Scan the lot**, **Asks for** lot, **Prompt** "Scan the lot";
   - an **Ask**: label **Scan the machine**, **Asks for** machine, **Prompt** "Scan the machine";
   - a **Run**: **Confirming:** Check, and confirmed at once.
   Wire **Start → Scan the lot → Scan the machine → Run → Done**. Click **Done**: **Then** the start
   again, for the next one.
3. In **Move in**, **General → Input flow:** `scan_move_in`. Reason, fitness test (no scenario needed:
   how a form is filled changes nothing it does), submit; Eli reviews; Sam approves for Production.
4. As **Olga**, open **Move in** from the navigator. The cursor is in **Lot** under "Scan the lot".
   Type `4712` and press Enter (a scanner sends the Enter itself): the cursor moves to **Machine**.
   Type `M-101`, Enter: Move in runs on its own, **Move in: done** lists what changed, and the cursor
   is back in **Lot** for the next one. Not a click.
5. Now type `4713` (on hold since 10.1) and `M-102`. Refused: the reason is shown at the field, and
   the cursor stays where it is to put it right. Each Ask's **On an error** says whether to stay or
   go on.
6. Try further (optional): **Moves on by** a key of its own (F2) for the machine, or **By itself, once
   complete** with a length, for a scanner that sends no Enter.

**Review questions**
1. Eli has no role on deviations. Why could he answer the root cause, and what could he not do?
2. Why did Deviation response need a scenario, and Lab check none?
3. The scenario ran on lot 4711. What happened to the real lot 4711 while it ran?
4. Who approved the input flow, and why does it not need a scenario?

---

## Final project

In pairs, design, review and approve a small object end to end. One trainee designs; the other
reviews (as Eli or Vera) and approves (as Sam and Quinn).

**Inspection:** Quality inspects a lot.
1. An object `inspection` (area Quality) with fields: lot (reference to Lot), result (`pass`, `fail`),
   notes (text), inspector (string).
2. States: `open` → `in_progress` → `passed` or `failed`, with actions `start`, `pass`, `fail`.
3. Roles `inspector` and `viewer`; policies so inspectors write fields while open or in progress, and
   everyone with a role reads. A hint for a locked result.
4. A rule with test cases: an inspection cannot be passed while its result is `fail`, nor failed while
   it is `pass`.
5. Analytics dimension: `result`.
6. A scheduled service, every morning at 06:00 on weekdays, that counts inspections still open.
7. Fitness test clean, reason written, submitted, reviewed, approved, executed.
8. Give the roles through a change to **People & departments** (Designer → Change people &
   departments → Roles): Quality `inspector`, Production `viewer` on Inspection. It is reviewed and
   approved like any change.
9. Show it working: an inspection through its states as the people who may; a refused transition and
   its **Why?**; its Timeline; the Analytics page; the schedule in the monitor.

**Assessment checklist:** the change passed review without changes asked, or the requested changes
were made; every script has test cases; nobody approved their own work; the trainee can explain each
approver on the list.

---

## Track B: a plant from nothing

On a [blank training instance](#a-blank-training-instance), in place of modules 1–6. The same pairs
and cast; every step goes through a change: drafted by Dana, reviewed by Vera (or Eli), approved by
the departments it touches. Before each submission the change page names anyone whose review would
leave a department with nobody to sign: pick someone else.

1. **The first object (a list).** Designer → **New object**: `part`, label Part. It starts as a list:
   one state, a Name field. Add **Part number** (string, required, at most 20 characters), make it
   the title field, show it in the list and on the form. Write the reason; submit; Vera reviews;
   **Sam approves for Production**, its steward. It is live, and nobody can use it yet: sign in as
   Olga to see.
2. **Who may use it.** Designer → **Change people & departments** → **Roles**: give Production the
   `user` role on Part. Submit, review, approve. Olga now finds Part by searching the navigator and creates
   P-100 Bracket.
3. **A lifecycle.** A second object, `work_order` (area Production): a reference to Part, a quantity
   (number, at least 1), states `planned` → `released` → `done` with actions `release` and `finish`,
   roles `planner` and `operator`, policies so a planner creates and releases and an operator
   finishes. Give Sam `planner` and Production `operator` (People & departments). Run one order
   through as the people who may, and ask **Why?** on a refused action.
4. **A rule with test cases.** A work order cannot be released with a quantity above 1000: the rule,
   its test cases (one passing, one failing), the fitness test clean.
5. **A transaction.** `finish_order`: from a released work order's page, the operator enters the good
   quantity; one step sets it and finishes the order. Callers: Production.
6. **A screen.** `production_board`: a count of released orders, orders by state, and a table of
   today's orders with a Finish button (the transaction). Callers: Production and Quality.
7. **Ask a colleague.** Show the board as Olga; then, as Dana, change the board and see who must
   approve (its stewards), and why.

**Assessment:** as for the final project, and every object, role, transaction and screen on the
instance was designed by the group, through a change.

---

## Trainer notes

- **Reset between groups** (`npm run db:reset`): lot 4712's state and the Lot definition change during
  the course.
- **Module order:** 2 before 3, 4 and 6 (they build on `batch_ref`); 7 before 8.2's trigger part.
  Module 10 starts from a reset (10.1 holds lot 4713, 10.4 moves 4712 onto M-101), its exercises in
  order: 10.4's refusal needs lot 4713 held.
  Exercise 1.6 changes WO-1002's quantity, and 2.5 makes Eli a designer for the rest of the session:
  both are undone by the reset.
- **Common questions**
  - *"Why can't I just edit the live object?"* Nothing reaches the plant except through a change
    request: design, review, approval, execution (§5).
  - *"Why did Quality have to approve?"* The footprint: the change touched what Quality stewards.
  - *"Why is Save greyed out?"* A rule's error stands, the database is unavailable (a banner says so),
    or a save's outcome is unknown (press **Send again**).
- **Expected messages**, word for word, are in the user guide's quick reference (section 16).
- **Roles on a new object** are given through a change to People & departments (Roles), after the
  object's own change has executed: until then nobody can use the object.
- **Things the demo does not do** (say so when asked): passwords and single sign-on (built, but the demo
  keeps the picker so anyone can try it); e-signatures
  on approvals; schedules that follow a shift calendar; measures, dashboards and OEE (analytics
  phases 2 and 3); form buttons that call a service. Open decisions are in OPENQUESTIONS.md.
