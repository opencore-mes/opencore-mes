# OpenCore MES user guide: designing the system

For the people who build the plant's system in the designer: process and quality engineers who
design objects and rules, and IT integrators who connect other systems. It follows the order you
work in: find your way around, open a change, design what the plant needs, get it approved, then
watch it run.

Section numbers given as §n refer to the design document, kept by the maintainers. Questions not yet decided are in [OPENQUESTIONS.md](OPENQUESTIONS.md). A hands-on course with exercises on
the demo system is in [TRAINING.md](TRAINING.md).

> This guide describes OpenCore MES as it is built (`app/mes/`). Where something the design describes is
> not built yet, a **Not yet** note says so.

## Contents

1. [The one rule: design → review → approval → execution](#1-the-one-rule)
2. [Finding your way around](#2-finding-your-way-around)
3. [Working in a change request](#3-working-in-a-change-request)
4. [Designing an object](#4-designing-an-object)
5. [Rules: checking and adjusting data](#5-rules-checking-and-adjusting-data)
6. [Connections: the outside systems](#6-connections-the-outside-systems)
7. [Services: talking to outside systems](#7-services-talking-to-outside-systems)
8. [Schedules: running a service by the clock](#8-schedules-running-a-service-by-the-clock)
9. [Transactions: screens that change several records as one](#9-transactions-screens-that-change-several-records-as-one)
    - [Signed by two people](#signed-by-two-people)
10. [Screens: pages you compose](#10-screens-pages-you-compose)
11. [Flow templates: routes and plans](#11-flow-templates-routes-and-plans)
12. [Getting a change approved](#12-getting-a-change-approved)
13. [After it is live: the integration monitor](#13-after-it-is-live-the-integration-monitor)
    - [Analytics: time between states](#analytics-time-between-states)
    - [Queries: SQL and JSON](#queries-sql-and-json)
    - [AI Report: reports, layouts and the analytics copilot](#ai-report-reports-layouts-and-the-analytics-copilot)
    - [Import and export in Excel](#import-and-export-in-excel)
    - [The whole model to another installation](#the-whole-model-to-another-installation)
14. [Designing with an AI](#14-designing-with-an-ai)
15. [What your design means for the people using it](#15-what-your-design-means-for-the-people-using-it)
16. [Quick reference](#16-quick-reference)
17. [Expressions: conditions and values](#17-expressions-conditions-and-values)

---

## 1. The one rule

**Nothing reaches the plant except through a change request** (§5). Every change goes through four
stages:

| Stage | Who | What happens |
|---|---|---|
| **Design** | A designer | You draft the change: objects, rules, scripts, services, connections, schedules. Nothing you draft affects the plant yet |
| **Review** | A reviewer (not you) | Someone else reads the change and passes it, or asks for changes |
| **Approval** | One representative per department concerned | Each department whose data or process the change touches approves or rejects it |
| **Execution** | The platform | Once every department has approved, the platform publishes the change in one step. No person, and no AI, publishes anything |

Three things follow from it:
- **You never approve your own change,** and whoever reviews a change cannot also approve it for a
  department.
- **The departments that approve are worked out for you** from what the change touches: its
  *footprint* (§5.6). Change a quality field and Quality approves; change a service that writes lots
  and the lot's stewards approve.
- **Execution is all or nothing.** If something the change was drafted against has changed since
  (someone else's change executed first), execution is refused, and the change is marked failed so
  you can redo it on top of the new version.

### Designers, roles and approvers: three different things

They are easy to mix up, because all three are about "who may". They answer different questions:

| | Answers | Set where | Example |
|---|---|---|---|
| **The designer** | *How does the system work?* The objects, fields, policies, screens, layouts | A change request, in the Designer | Dana adds a Picture field to Equipment |
| **Roles** | *Who may do what with the records?* A policy ties a role to rights: read, create, write these fields, take these actions | The object's **Roles & policies** tab; people are given roles in **People & departments** | Engineers may upload an equipment's picture |
| **Stewards and their approvers** | *Does this change go live?* | The object's **Stewards** tab (departments); each department's approval steps in **People & departments** | Production signs the change that adds the field |

So, for one change: the designer drafts the field and the policy; the policy's role says who will be
able to use it once it is live; the stewards' approvers decide whether it goes live at all.

Two things that catch people out:

- **"designer" and "reviewer" are roles on the Designer itself, not on your objects.** A policy can
  only name roles the object declares. Name another and the draft says *Policy "…": its roles must be
  roles of this object*: take that role out of the policy, use one the object has, or add a role to
  the object and give it to people.
- **Holding a role does not make someone an approver, and being an approver gives no right on the
  records.** A quality engineer who approves changes for Quality still needs a role on an object to
  open its records.

## 2. Finding your way around

**The shell.** On the left, the navigator shows your favorites: the objects, screens and
transactions you starred (☆), in the order you starred them, on every device. Everything else shared
with you is found by search: type a few letters of its name, or of what it is ("screen",
"transaction"), and star it to keep it. **Show all** lists everything at once (objects by area, then
screens and transactions) until you leave the page. The same search box also finds records, each
showing where it stands: its state, in its colour, and the first fields of its object's list (a tool's
process and why it is down, a PM schedule's next date). A designer chooses those fields by the order of
the list's columns. Your
favorites are also the cards on the home page. Under **Data** are **Query**, **AI Report** (each for
those who may use it) and **Import / export**; under **Design** the **Designer**, **Approvals**,
**People & departments** and the **Integration monitor** (if you have the designer role). An installed
suite may add pages of its own, under Data, Design or a heading of its own. On the right, every page
you open becomes a tab. A row of tabs never wraps or scrolls: the tabs that fit are drawn whole, the
open one always among them, and the rest are under **N more** at its end.

**What is this?** The **?** at the top left of a page or a panel opens its guide, on the left where
the navigator was: what each thing on it is, and how to use it (a checkbox, radio buttons, a drop-down,
a scan field, a table, a button). Point at an item of the guide and the thing it is about is outlined on
the page. A record's and a transaction's guide is made from their design, so it always matches the form
you see. **Esc** or **×** closes it.

**Light or dark.** In the top bar, beside **live**: as your device is set, light, or dark. Your choice
follows you to every device. On a phone it is one button: tap it for the next. If your plant has chosen
one for everyone (a shop floor's screens), there is no choice to make, and it is not shown.

**The designer home** (`/design`) lists:
- **Objects**: each published object with its version and stewards. **Change** opens (or reuses) a
  change request for it; **open change** means one is already in progress.
- **Services & connections**: each published service and connection. **New service** and **New
  connection** start one.
- **Changes**: every change and its stage.
- **AI access**: tokens that let an AI work as you (section 14).

**Roles in the designer.** You may be a **designer** (you draft), a **reviewer**, and/or a
**department representative** (you approve for your department). A reviewer who is not a designer
reads and approves but does not draft.

> **The seeded people.** In development, on the demo and in a test instance, you sign in by picking a
> seeded person. Dana designs; Eli and Vera review; Sam, Quinn and Eli represent Production, Quality and
> Engineering.

**Signing in.** The demo has no sign-in: you arrive as a designer, and press your name at the top right
to be anyone else (you stay on the page you are on). In development, or a test instance with the picker
on, you pick who you are at sign-in, and switch the same way from your name. Ready to switch to: those you picked lately in this browser, whoever has something waiting to
review or sign, and everyone who reviews or approves; type a few letters of a name to find anyone else. At a plant you sign in the way it has set up: **Sign in with** its single sign-on, or
your sign-in id and password (the plant directory's, or one of your own that IT gave you a link to
set). You can sign in only once People & departments has you, as active; if the page says you are not
there, ask whoever keeps it. Five wrong passwords lock your sign-in id for 15 minutes. To change a
password of your own, press your name at the top right: you give your current one, then the new one
twice (at least 12 characters, a few words you will remember), and anywhere else you were signed in,
you are signed out. Forgotten it? Ask IT for a new link.

What a regulated plant adds (its IT turns each on; a development or demo instance has none of it):

- **Your password expires.** The password page says until when (every 90 days, say). Once it has
  expired, signing in asks for a new one first; a new one may not be one of your last few.
- **A second factor.** On the password page, **Set up an authenticator app**: add the key it shows to
  an authenticator app on your phone (or tap the link on the phone), keep the ten **recovery codes**
  somewhere safe apart from the phone, and type the code the app shows. From then on, signing in with
  your password asks for the app's code. Lost the phone? Type a recovery code instead (each works once),
  or ask a sign-in administrator to take the second factor off. Where the plant requires one, your next
  sign-in sets it up. Who signs in through single sign-on has their identity provider's instead.
- **Idle sessions end.** After a while with nothing done (30 minutes, say), you are signed out and the
  sign-in page says why. Leaving a page open does not count as doing something.
- **Signing asks your password.** Approving a change, approving a record change, and running a
  transaction you sign each ask for your password at that moment, or **Sign in again with single
  sign-on** in a small window (it asks you to sign in there again, whatever it remembers, and then
  closes). The audit trail keeps your name and how you signed.

**Sign-in administration** (**Design → Sign-in administration**, for those People & departments makes
sign-in administrators: the role *administrator* on *Sign-in*): what needs a look (sign-in ids locked
in the last day, wrong passwords on many ids within minutes: someone may be trying common passwords),
and a search for anyone, with their password and its age, second factor, a lock, sessions and last
sign-in. **Password link** makes a one-time link to set a password, shown once for you to hand over;
**Reset second factor** takes off a lost phone's (say why); **Unlock** lifts a lock; **End sessions**
signs them out everywhere. Each is in the audit trail, by you. The same alerts reach your inbox.

**Trying single sign-on.** `npm run sso:sim` starts a small identity provider for development and
training (never production): start OpenCore MES with `OIDC_ISSUER=http://127.0.0.1:9095
OIDC_CLIENT_ID=open-mes PICKER=0` and sign in as any seeded person with its password (`sso-sim`);
`--mfa` makes it ask a code as well.

### What waits for you, and what is in progress
Beside your name, at the top right, a bell counts what waits for you: changes you may review, the
steps of changes you may sign, changes to records you may sign, and plans waiting for you (section
11). Click it for the list, in groups (**Plans waiting for you**, **To sign**, **To review**); each
opens where you act on it, and **Open Approvals** shows everything waiting. It follows as others act.

**Alerts** from an installed suite come first in the same list, under **Alerts**, when a suite has
something for you: each says what it is about and opens the page where it is dealt with (at most 20 a
suite).
The suite decides what to tell you and when it is dealt with: an alert leaves the list once the suite
clears it. A suite whose alerts cannot be read is left out, never the rest of the list.

The **Designer** opens on **In progress**: the changes open now, yours first, one click from each.
Below, a tab per kind of design (Objects, Transactions, Screens, Flows, Report layouts, Services &
connections, People & departments; **From suites** once an installed suite adds a kind of design),
each with a search, its **New**, and a dot when something in it has an open change; then **Test
sandbox** (section 3) and **Changes**. **Changes** lists the open ones by default; **Mine** and **All**
show the rest. The open tab is in the page's address (`/design?tab=screens`), so a link opens on it.

**View** beside a design opens it as it is live, read-only, in the same tabs a change has (an
object's rules with their test cases): nothing is drafted and no change request is made, so look
as much as you like. **Relies on** lists the objects it uses (Move in: the lot, the step, the
equipment and its model); tick one to show it in the same view, then pick it in a window's list or
press **Split** to see both side by side. The address keeps what you ticked, so the link opens the
same view for someone else. **Change it** there starts a change when you mean to; if one is open already,
it links to it.

**From the suites** shows the designs an installed suite brings (an assembly and test line: lots,
wafers, routes, equipment, SPC): how many are new, how many differ from what is live, and the roles
they would give. **Start a change from it** opens one change request holding all of it; you edit it
like any other, and it is reviewed and approved before anything goes live. Once it is live, **Load its
sample records** creates the suite's sample data through the ordinary forms' checks, as you, so your
roles decide what you may create; loading again adds nothing. Where an object's design makes a new
record or an action wait for approval (section 4, **Stewards**), that sample is sent for approval
instead, its reason saying it is a sample, and the note says how many wait.

**What an installed suite adds to your designs.** A suite may add building blocks that you use like
the platform's own, each shown where it is used:
- **A design element of its own kind**, on the Designer's **From suites** tab: started, edited (its
  **Design** tab is the suite's), reviewed and approved like a screen or a transaction. The suite
  checks it with the rest of the change, against what is live and against the services that run on
  its kinds of schedule, and may refuse a change in words: one that would rewrite what is already done
  (a day already gone), or leave a service's schedule naming something that is no longer there. Its
  words are in the **Problems** list, like any other problem, and the change cannot be submitted
  until they are put right.
- **A kind of schedule**: a service runs at times the suite works out (section 8, "Schedules from an
  installed suite").
- **Something a service may ask of it**: ticked under the service's **what it may touch**, then
  called from its script. A dry run and the script's test cases never act for real; they report what
  would have been asked.
- **A transaction step**: added from the Steps tab. A step that cannot be taken back (the suite says
  so) must be the last one, so it happens only once every other step has held.
- **A screen block**: added from the block list.
- **Alerts** for you, beside your name (above, "What waits for you").

If a suite is later removed, nothing of yours is deleted. Its elements stay listed, saying which suite
they need; a service that asks the suite is refused in words; a transaction with its step does not
run, and says why; its block says what it needs while the rest of the screen works; a schedule of its
kind plans nothing and says which suite it needs. All of it works again once the suite is back.

## 3. Working in a change request

Open a change from the designer home: **Change** on an object, **New service**, **New connection**,
or **Start design** for a new object (give it a name such as `inspection` and a label). A new
object's name can be changed on its **General** tab until its first version is approved; after that
it is fixed, and the label is what people read.

**Several designs in one change.** When one piece of work spans several designs (a new field on the
lot and the work order, the transaction that fills them, the screen that shows them), bring them all
into one change with **Change also…**. It is reviewed once, and each department any of them touches
approves once (the approval route is every design's, together); it executes all at once, or not at
all. Every rule still applies to each design: its own problems, its scripts' test cases, its
scenarios if it is a transaction or a flow template that changed, and execution refuses the whole
change if any of them changed live since it was brought in. A design brought in and left as it was
asks no one's approval and is not published again. A design is in one open change at a time: one
already in another is refused, naming that change; finish or withdraw that one, or make the edit
there.

**A copy of another.** Every **New** form (object, service, connection, transaction, screen, flow
template) offers *blank* or *a copy of …* a live one of its kind (or press **Copy** on a design's row:
the New form above takes it, the cursor in its name box): the new one starts as all of it,
under its new name (its label, if left empty, says "(copy)"). A service brings its script, its
function renamed; an object its rule scripts, each copied under a name of its own (`lot_round_qty`
becomes `batch_round_qty`), so the copy's rules are its own; a transaction or a flow template its
scenarios, running the copy. Nobody holds a role on a copied object yet: give them in People &
departments. A copy is a new design, with no tie to the original, reviewed and approved like any
other. **Add to this change** copies one drawn in the same change too.

**The change request page:**
- **The stage bar**: Design · Review · Approval · Execution, with the current stage highlighted.
- **What it holds**: the objects, scripts, services, connections, transactions, screens and flow
  templates in the change. **Add to this change** makes a new one in it (blank, or a copy).
  **Change also… → Bring in** brings a live one in, to change it together with the rest: an object,
  a transaction, a screen, a flow template, a service (with its script) or a connection. Unsaved
  edits are saved first, and the one brought in opens in the first window, as it is live.
- **Windows.** **Split** shows up to three editors side by side on the same draft, for example
  the object on the left and its rule script on the right. Every window edits the same draft.
- **The side panel**:
  - **Why this change**: the reason. Required before you can submit; reviewers and approvers read it.
  - **Problems**: everything the platform would refuse, found as you type (a field that does not
    exist, a script that does not parse, a trigger on an unknown event…). You cannot submit while
    any remain.
  - **Fitness test**: runs the evidence reviewers will see (section 12). **Run fitness test** runs it
    now; submitting runs it again.
  - **Will need approval from**: the departments whose representatives will approve, recalculated
    as you type. Watch it: if a department appears that you did not expect, your change touches
    more than you meant.
  - **Save draft**, **Submit for review**, **Withdraw**.
- **Designers.** A draft is its author's: to other designers it is read only. At the top of the side
  panel the author adds **co-designers** (other designers), who edit, save and submit it too. Like the
  author, they cannot review or approve it, and that stays so if the author takes them off the list
  later: the panel lists them under "also worked on it". If two of you save at once, the second save
  is refused and names who saved first; **Load their version** brings their work in (yours is then
  replaced). A fitness run or a review never counts as a save.
- **Presence.** If someone else has the same change open, a banner says so, and says when they are
  editing.

**Every tab has a JSON view** showing the element exactly as it will be stored. You can edit it and
**Apply JSON**; the same checks apply.

### The test sandbox: trying changes together before approval

Approval is for a design you are done with. While you are still iterating, and when your change only
makes sense together with someone else's, use the **test sandbox**: one shared copy of the system that
holds what is live plus **every change under test**. A screen in your change can show the object in a
colleague's, before either is approved.

1. On your change, in the panel on the right, press **Add to test sandbox**. The change stays in design
   and stays yours to edit.
2. Press **Open the test sandbox**. It opens in a tab of its own, with **TEST SANDBOX** in the top bar.
   You are signed in as yourself, with your own roles (and the ones the changes under test give you).
3. Try things. Records you make there stay there; nothing reaches the plant. Go back to the change,
   edit, save: the test sandbox is rebuilt the next time it is opened, and your test records are kept.
4. When the design has settled, submit each change for review as usual.

**The order matters.** The Designer's **Test sandbox** tab lists the changes under test in the order
they are applied. A change that needs what another brings (a screen needs its object) must come after
it; if it does not, it is marked *could not be applied*, with the reason, and the others still run. A
designer moves changes up and down with the arrows. **Build it again now** rebuilds at once.

**What it was tested with** is recorded on each change, under *Tested with*: when, and which other
changes were in the test sandbox with it. Reviewers and approvers see it.

Things to know:

- The test sandbox starts with no records of the plant: make the ones you need there.
- Being under test changes nothing about approval. Every change is still reviewed, approved and
  executed on its own. If your change needs another one to be live first, get that one approved first:
  a change whose needs are not live yet is refused when it executes, and says what is missing.
- **Take it out** removes your change from the test sandbox. A change that executes or is withdrawn
  leaves it by itself.

### Rolling a change back

A change that has executed can be rolled back. You do not rebuild the old version by hand: the platform
drafts the change that puts things back.

1. Open the executed change (Designer → **Changes** → *all*), and press **Roll back this change**.
2. Read what it will do: each design back to how it was before, anything that change created retired,
   anything it retired published again. Confirm, and the rollback opens as a new change, yours.
3. It is **tried in a sandbox at once**. If rolling back would break something made since (a screen
   that shows a field you are taking away), the fitness report says what, and the rollback cannot be
   submitted until that is dealt with.
4. **Submit it.** It is not reviewed again, since it restores what was reviewed and approved before.
5. **One approver signs, and it executes.** Anyone who approves for a department it touches, except
   you. The other departments are not waited for.

Things to know:

- **Nothing is erased.** The rollback is a change on the record like any other; the design gets a new
  version whose content is the old one. Both changes link to each other.
- **Records are not rolled back.** If the change added a field and people filled it in, the field goes
  but the values are kept, unseen, and reappear if the field is added again. The plan tells you how
  many records hold a value.
- **Changed again since.** If a later change touched the same design, rolling back would undo that
  too. You are asked: leave that design as it is, or roll it back as well.
- **Not rolled back by this**: people & departments (change them in People & departments), and flow
  templates, report layouts or a suite's design elements the change created (change them, or leave
  them unused).
- **If you edit the rollback** before submitting, it stops being a rollback as far as approval goes:
  it is reviewed and approved in full, like any change.

## 4. Designing an object

An object is a kind of record: a lot, a work order, a deviation, an inspection. Nothing is defined in
advance: the object's fields, states, roles and rules *are* its design (§6).

Open an object's change and use its tabs:

### General
**Excel import and export** (also on this tab): whether the model may be exported, whether an
import may create records or update (override) existing ones, and the field rows are matched by
(section 13, "Import and export in Excel").

**Label**, **Area** (where it appears in the navigator), **Description**, and the **Title field**:
the field that names a record in lists, tabs and references (for a lot, the lot number).

**Analytics dimensions:** up to five fields (for a lot: `item, uom`) copied into each stay of a
record in a state, so its analytics can be grouped by them. The value copied is the one the record
had when the stay began: a lot moved to another item later still counts under the item it had then.
Long text cannot be a dimension. Choosing dimensions is a design change like any other.

### Fields
Each field has a name (lower case letters, digits and `_`; it cannot be changed once published), a
label, and a type:

- **Renaming a field:** until it is published, click its name (✎) and give the new one. Everything in
  the object that names it follows: the title field, the list, the form, policies and their
  conditions, hints, analytics and import. Scripts, transactions and screens in the same change that
  read it are named by the checks. A published field's name is locked (its records hold their values
  under it): change its label, which is what people see, or add a field and remove the old one.
- **Kept fields (the lock in the list):** some parts of an object are relied on, by the platform (the
  built-in Person's sign-in id, name and active) or by an installed suite. A note at the top of
  **Fields** says who keeps what, and why. A kept field cannot be removed or retyped, stays required if
  it was, and keeps its choices (add more if you like); kept states, actions, rules and policies stay.
  The checks name anything that would break one. Removing the suite that keeps something lifts its lock.

| Type | Holds |
|---|---|
| `string` | Short text, up to 500 characters |
| `text` | Longer text |
| `integer`, `decimal` | Numbers |
| `boolean` | Yes or no |
| `date` | A date (YYYY-MM-DD) |
| `enum` | One of a list of values you give |
| `ref` | A reference to a record of another object (a lot's work order) |
| `image` | A picture (PNG, JPEG or WebP, up to 5 MB): whoever may write the field uploads it on the form |

Mark a field **required**, or **computed** (set by a rule, not typed). Names such as `id`, `state`,
`type`, `archived_at`, `created_by`, `created_at`, `updated_by` and `updated_at` are reserved: a
record keeps those itself.

What a field accepts is checked where it is entered, with the reason beside it: a whole number is one
the database can hold (not `1e300`), a date is one that exists (not 31 February), a reference names a
record of the object it refers to that the person may read, and a choice lists each of its values
once. Numbers are shown as they were entered, grouped in the plant's format and never rounded: 0.0004
reads 0.0004 everywhere, in an approval too.

- **Several values** (under an enum's values) lets a field hold more than one: a lot's defects, a
  work order's lines. Turning it on or off in a change converts the stored records when the change is
  executed. A field used as an analytics dimension or an import key keeps a single value.
- **Required when** (in the field's inspector on **Layout**) makes a field required only under a
  condition, for example a reason when the disposition is `reject`:
  `{"eq": [{"data": "disposition"}, "reject"]}`. The server checks it too.

### States
**A list** (departments, operations, reasons: reference data that is added and edited, never moved
through a lifecycle) has one state and no transitions. A new object starts that way; its records show
no state, and the tab says it is a list. Add states and transitions when the object has a lifecycle.

The record's life: its **States** (for a lot: `created`, `in_process`, `on_hold`, `released`,
`consumed`), the **Initial state**, and the **transitions** between them. Each transition is an
action with a label ("Release"), the states it may start from, and the state it leads to. Actions
appear as buttons on the record, for the people allowed to take them.

**Tones**: how each state shows, by what it means: **ok** (released), **warn** (on hold), **danger**
(rejected), **info**, **neutral** (consumed), or **plain**. Each state's badge previews it. You choose a
meaning, never a colour: the plant's theme colours it, in light and dark alike.

### Roles & policies
Who may do what (§9). Access is **denied unless a policy grants it**.
- **Roles** are declared by the object (`operator`, `supervisor`, `quality`, `viewer`). People and
  groups are given roles through their own change requests.
- A **policy** grants something to one or more roles, optionally under a **condition**:
  - **may read records**, **may create records**, **may archive and restore records**;
  - per field: **read** or **write** (write includes read); `*` for every field not named. Each field
    is a tile: click it to go from nothing to read to write and back; green is write, amber read;
  - per action: **allow**;
  - **deny**: fields that may not be written whatever other policies say (a lock that wins), fields
    hidden entirely, actions refused. Each is a list of names; one name written alone is reported
    as a problem, never read as "deny nothing".
- A **condition** ([section 17](#17-expressions-conditions-and-values)) reads the record (its state, type, any field) and the user, written as JSON, for
  example `{"in": [{"record": "state"}, ["created", "in_process"]]}`. Conditions never read the
  clock; a rule does that (section 5). A condition is checked as you design it: an operator the
  language does not have, or one given the wrong shape, is a problem on the policy, before anyone
  opens a record.
- **In Queries and Analytics** a policy counts as it does on a form, with two limits: a condition
  that reads the user's departments, or that does arithmetic, cannot be said in SQL, so in a query
  that policy grants nothing (and what it hides stays hidden). Write such access by role or by
  state where people need it in Queries.
- **Hints** say what a person can do instead, for example "A released lot's quantity is corrected
  through a deviation". They appear when someone asks **Why?**.

**Overview.** At the top of the tab, a grid shows the whole object at a glance: its roles across, and
down the side the records (read, create, archive), every field and every action. Each cell is what
that role comes to over *all* the policies:

| Cell | Means |
|---|---|
| green **write**, **yes**, **allow** | granted |
| amber **read** | may read the field, not write it |
| **—** | not granted (the default) |
| red **locked**, **hidden**, **refused** | a deny applies, and wins over any grant |
| a dashed outline and a `*` | only under a condition, or only through a transaction |

Point at a cell to read which policies make it so. Click a role's name to show only the policies that
name it; click it again for all of them. The grid follows your edits as you make them.

**Changing a grant from the grid.** A cell is what several policies add up to, so a change is always a
change to one policy:

- **Click a cell**: under the grid, every policy that names that role is listed with what it says on
  that field or action. Click a policy's tile to change it (a field goes — → read → write → —; the rest
  are granted or not). A policy shared with other roles says so in amber: *a change here is also for
  maintenance, quality*.
- **Double-click a cell** (or press Enter on it) to change it at once. This works when there is no
  doubt which policy to change: exactly one policy is for that role alone and has no condition.
  Otherwise the list opens for you to choose.
- **Grant it in a new policy for the role alone** adds a policy named after the role, when none of the
  existing ones is the right place.
- A cell may not change colour after your click: another policy may still grant as much. The list
  shows why.
- Denies, conditions and "only through transactions" are edited in the policy's own card below. It reads the
design, not a record: what one person may do with one record at one moment is still answered by
**Why?** on that record.

Every "no" can be explained: a person who cannot change something presses **Why?** and reads the
policy, the condition and the state that decided it, from the system's own decision (§9.7).

**Archiving.** "May archive and restore records" lets a role take a record out of use: it leaves
the lists, becomes read-only and keeps its history (nothing is ever deleted). A condition applies
both ways: if supervisors may archive lots that are on hold, only they may restore a lot archived
while on hold.

### Rules
The object's rule pipe (section 5): **Add to pipe** adds a published script, or one written in this
change.

### Layout
How the list and the form look. Nothing here grants or refuses anything; that is **Roles & policies**.

- **List**: the columns, in order, and how the list is sorted. **Search first** is for an object with
  too many records to browse (Person has it): its list starts empty, with a search box, and shows what
  matches. Development, the demo and test instances list them anyway.
- **Form tabs**: one page, or several tabs (**+ tab**); each tab holds sections.
- **Sections**: a heading and its fields. A section may **fold** (a person opens it when needed) and
  start folded.
- **Fields**: drag a card to move it, within a section or to another; or use ◀ ▶ to move it and
  − + to make it narrower or wider (a row is 12 columns: 4 is a third, 6 a half, 12 the whole row).
  A field goes no narrower than its widget fits: 2 for a text, number or checkbox, 3 for a
  dropdown, date or search, 4 for buttons, chips, lists and text boxes. In a narrow window the cards
  sit two to a row, as the form does on a small screen.
  Fields not on the form wait in the tray below; drag them in.
- **Inspector** (click a card):
  - **Width**, **Drawn as** (the widget: a dropdown, radio list or buttons; for several values a
    checkbox list, multi-select or chips; a checkbox, toggle or yes / no; a search as you type for a
    reference; a number with − +), **Help text**, **Placeholder**, the **Rows** of a text box;
  - **Shown when**: the field appears only under a condition, for example
    `{"eq": [{"data": "disposition"}, "reject"]}`;
  - **Enabled when**: it can be typed in only under a condition; otherwise it is greyed out. A field
    a policy locks stays locked whatever this says;
  - **Required when**: see **Fields**.
  Conditions ([section 17](#17-expressions-conditions-and-values)) read the form's `data`, the `record` (its `state`, `type`) and the `user`, like a
  policy's. Press **Apply** under each; a condition that does not read right is shown in red.

### Preview
The list and the form as a person will see them, from the draft.

### Stewards
The departments that answer for the object, and optionally for single fields, states, transitions
or policies. Stewards decide who approves: a change to the `disposition` field goes to its
stewards (Quality) and not to the whole object's. A new object is stewarded by its area's
department.

**Approval of record changes** (at the bottom of the tab): changes to this object's records made
outside a transaction can wait until the stewards approve them.
- **Changing values waits for approval**: any field, or only the fields you tick, in any state or
  only the states you tick (a lot's quantity once it is released).
- **A new record waits for approval**: it exists once approved.
- **Actions wait for approval**: every action, or the ones you tick (putting a lot on hold).

Transactions never wait: they are the approved way to change records. Leave this off for lists and
master data that do not need it.

A change that waits shows on its record to everyone who may read the record: that it waits, why, and
for whom. The values themselves (as it is → as asked) are shown to who asked, to those who approve
it, and to anyone who may read that field; for anyone else a hidden field reads "hidden from you".

## 5. Rules: checking and adjusting data

When metadata is not enough ("at most 5 % over the work order's quantity"), write a **rule script**
(§12). Rules run as a **pipe**: each script gets a context, returns it, and passes it on. A script
**refuses by throwing**; its message is what the person reads.

```js
// lot_check_qty.js
export default async function lot_check_qty(ctx) {
  if (ctx.event.kind !== "save" || !ctx.data.work_order) return ctx;   // not mine: disregard
  const order = await ctx.lookup("work_order", ctx.data.work_order);
  const limit = order.qty * 1.05;
  if (ctx.data.qty > limit) {
    throw Object.assign(new Error(`At most ${limit}: 5% over the order quantity.`), { field: "qty" });
  }
  return ctx;
}
```

**The contract:**
- One file, one function, the same name: `lot_check_qty.js` exports `lot_check_qty`. Nothing else in
  the file: no `import`, no other statement.
- **Throw to refuse.** `field: "qty"` puts the message beside that field; `fields: { … }` places
  several.
- **The pipe runs on every change of state,** and your script decides whether it cares:

| `ctx.event.kind` | When | Where it runs |
|---|---|---|
| `change` | Every keystroke, pick or scan in the form; someone else's change arriving | The browser, as advice |
| `save` | Create or update | The browser, then the server, which decides |
| `action` | A transition (`ctx.event.action` names it) | The browser, then the server |
| `archive`, `restore` | Archiving or restoring the record | The browser, then the server |
| `committed` | After the change is saved (entries marked committed only) | The server |

- **The context:** `ctx.event` (what changed: `changed`, `prev`, `source`), `ctx.user`,
  `ctx.record` (as stored), `ctx.data` (the values being checked), `ctx.now` (the clock: use it, not
  `Date`), and `ctx.lookup(object, key)`: one record, with your rights, by its id or by its title as a
  label reads it (a hold code `"SPC"`, the newest in use); on the server only, so a script that looks
  up is **backend only**.
- **Changing data.** A script may change a field in `ctx.data` only if its pipe entry declares it in
  **writes**. An undeclared change stops the pipe. This way a reviewer sees, from the object alone,
  what each script can alter.
- **Pipe entry options:** **writes** (the fields it may set), **when** (a condition to skip it
  without running it), **backend only** (it needs rights the person may not have, so it runs only on
  the server), **committed** (it runs after the save).
- **Scripts cannot** reach the network, the page, or other systems, and have no randomness: the same
  context always gives the same outcome, so an auditor can replay any decision. To act on another
  system after a save, use a service (section 7).

**Test cases are part of the script** (§12.6). Each case gives a context and the expected result
(data, changed fields, or the expected error). A new or changed script without test cases, or with
a failing one, cannot be submitted.

```json
{ "name": "over the limit", "run": { "event": { "kind": "save" }, "data": { "qty": 2000, "work_order": "…" } },
  "expect": { "throws": { "field": "qty" } } }
```

**Dry run** executes the draft script on a context you give, with real lookups (your rights), and
shows what it changed or the error on its line.

A script imports nothing: `import(…)` is reported as a problem where it is written (in a comment or
a text too, so word it another way), and has no typed arrays or WebAssembly to work with. Its data is
what its context holds.

## 6. Connections: the outside systems

A **connection** describes an outside system (ERP, a LIMS, a label printer) (§15.2). Create one with
**New connection** or **+ connection**:

| Tab | What you set |
|---|---|
| **General** | Label and **base URL** (`https://erp.plant.local/api`) |
| **Authentication** | `none`, `bearer`, `header` or `basic`, and the **name** of the secret. The secret's value is set on the server by IT (`MES_SECRET_<NAME>`); it never appears in a design, a review or an AI's context |
| **Allowed requests** | The only requests services may send: a method and a path (`POST /confirmations`, `GET /orders/*`). Anything else is refused, and so is a path written to climb out of what is allowed (`..`, `%2e`, a backslash, a space): a script that builds a path from an order number sends exactly that path or nothing |
| **Activity** | Every request services sent it |
| **Stewards** | Who answers for it. They approve every service that starts using it |

Requests and answers are JSON. The request timeout is set per connection. IT may list the hosts
connections can be sent to on the server; a connection to a host that is not on that list is refused
when it is used, saying so (ask IT to add it).

> **Not yet.** Only JSON over HTTP, and only the four kinds of authentication above (no OAuth2 client
> credentials or client certificates yet).

## 7. Services: talking to outside systems

A **service** is a script plus what may set it off and what it may reach (§15.2). Create one with
**New service** or **+ service**. A new service can do nothing and be called by nobody until you say
so.

| Tab | What you set |
|---|---|
| **General** | Label, description, and whether it is a **web service** outside systems call (`POST /svc/v1/<name>`) |
| **Input** | What a caller sends, typed like fields. Each input is checked before the script runs |
| **Identity** | **Who it acts as** (`runAs`): its own **service role** (the default: an identity of its own, holding only the object roles you grant it here), **its caller**, or a named **user** (such as the integration user `erp`). And its **callers**: the users and groups allowed to call it |
| **Triggers** | What sets it off besides a call: **record events** (a lot is created, a lot is released…) and **schedules** (section 8). And **where it runs** (`runOn`) |
| **Reaches** | The objects it may read, create, update, act on or archive, the connections it may use, and the **transactions** it may run. Nothing else is reachable |
| **Script** | The script. It is checked as you type, including calls to things it will not have |
| **Try it** | Calls the published version |
| **Activity** | Its calls and triggers, and each request it sent. A failed trigger can be sent again |
| **Stewards** | Who answers for it |

**The script** has the rule-script contract (one function, context in, context out, throw to
refuse), with what the service may reach on its context:

```js
// A released lot is confirmed to ERP.
export default async function erp_lot_released(ctx) {
  const lot = await ctx.records.get("lot", ctx.event.id);
  const res = await ctx.http("erp", { method: "POST", path: "/confirmations", body: { lot_no: lot.lot_no, qty: lot.qty } });
  if (res.status >= 500) throw Object.assign(new Error("ERP is unavailable"), { retry: true });
  if (!res.ok) throw new Error(`ERP refused the confirmation (${res.status})`);
  ctx.output = { confirmation: res.body.id };
  return ctx;
}
```

- `ctx.input`: what the caller sent. `ctx.event`: the record event (`{ kind, object, id, by }`) or
  the schedule (section 8). `ctx.user`: who it acts as. `ctx.output`: what the caller gets back.
- `ctx.records.get / list / create / update / action / archive / restore`: every record it touches
  goes through the object's policies and **rule pipe**, exactly as at a form, and is audited as the
  service, on behalf of whoever or whatever set it off. A rule that throws refuses the service's
  write, with the rule's words.
- `ctx.http(connection, { method, path, query, body })` → `{ status, ok, body }`: only what the
  connection allows.
- `ctx.transactions.run(name, input, { key })` → `{ run, changes, records }`: runs a transaction ticked
  under **Reaches**, exactly as a person running it would, all or nothing: its checks, and each step through
  the object's policies and rule pipe. Use it when outside systems start things the plant starts with a
  transaction (ERP starting a lot runs **Start a lot**, so an obsolete product is refused for ERP as it is on
  the floor). If the service runs as its own service role, the transaction's **Callers** tab must tick the
  service under **Services** (its stewards approve that, and the checks say when it is missing). A refusal
  comes back with the transaction's own words and field, and reaches the caller as a 422. `key` (the lot's
  number, the event's id) makes a run sent again answer the first, so a retried trigger does not start a lot
  twice. A transaction someone signs is never run by a service. **Dry run** shows what the transaction
  would change (**Would run**) and writes nothing.
- **Throw with words** to refuse (a caller gets 422 and your message). **Throw with
  `{ retry: true }`** when the other system is down: a trigger is then retried, with a growing
  wait (2, 4, 8… seconds, at most five minutes apart), ten times over about a quarter of an hour
  before it is marked dead. Each retry runs the whole script again: `ctx.event.attempt` says which
  attempt this is, so call the other system first and write records after, or check what an
  earlier attempt already wrote.

**Called as a web service.** The caller sends its token and JSON. With an `Idempotency-Key` header
(one per business message: the order number and its revision), a retry answers the first result
instead of running again; a retry sent while the first call is still running is answered 409
(`idempotency.running`, with `Retry-After`) and should simply be sent again. A key is its caller's
own: two systems may use the same text. A refusal answers the script's or the rule's words; a failure
inside the server answers "The request failed." and the details stay in the server's log. Every answer
carries `API-Version: 1.0`, the version of the contract the platform keeps (`docs/contracts/http-apis`).

**Changing a web service its callers rely on.** What a web service takes is a promise to whoever calls
it. A change that would break a caller (an input removed, retyped, made required or losing a value, a
new required input, the service no longer a web service, a caller taken off) is refused at the fitness
test when someone called it over HTTP in the last 30 days: the **Web services' callers** check names
them and how often they called. Give them notice instead: on the service's **General** tab, tick
**Deprecated** and give the date it starts, its **sunset** (the date after which it may change) and its
**successor** (the service to use instead), with a note. Once that change is live, every call is
answered with `Deprecation`, `Sunset` and `Link` headers and the service's OpenAPI description says
until when; after the sunset, the breaking change goes through (with a warning). Or publish the new
shape under a new name, and name it as the successor. A service nobody called in 30 days changes with a
warning only.

**How a trigger behaves.** A record-event trigger runs **after** the record's change is committed,
never for one that was rolled back, and is retried while the other system is down. A service never
sets itself off, and a chain of services stops at three. The other system should treat the request
as idempotent: it may, rarely, receive it twice.

**Dry run** executes the draft with everything it may call callable and nothing changed: reads are
real, writes go through policy and the rule pipe but are not saved, and requests are checked against
the connection and answered from the responses you give (`{ "POST /confirmations": { "status": 201,
"body": { "id": "X" } } }`), never sent.

> **Where scripts run.** Every script (rules, services, dry runs) runs in a separate script runner:
> it holds no passwords or keys, cannot read the server's files, and a script that loops or eats
> memory is stopped and reported as a fault. Form buttons that call a service are not there yet.

## 8. Schedules: running a service by the clock

A **schedule** is a trigger that the clock sets off (§15.3). On the service's **Triggers** tab,
**Add schedule**:

| Setting | Meaning |
|---|---|
| **Runs** every… | Every N **minutes** (1–720) or **hours** (1–24), counted from midnight |
| **Runs** at times of day | A list such as `06:00, 14:00, 22:00` |
| **Only between** | For "every": a window of the day, such as 06:00–22:00. It may cross midnight (22:00–06:00). Empty: all day |
| **Days** | The weekdays it runs, by the calendar day of each run |
| **Time zone** | Empty: the plant's. Times follow daylight saving: a time the clock skips runs once when it would have been, and a time that happens twice runs once |
| **Missed runs** | What to do with runs that could not start on time because the system was down: **run the latest one** (the default), **skip them**, or **run each** (up to 100) |
| **While a run is still going** | **Skip the new run** (the default) or **queue it** |

Under each schedule, **Next runs** shows the next five times, and the legend reads it back in words
("every 15 min, 06:00–22:00, Mon Tue Wed Thu Fri (Europe/Berlin)").

**What the script reads:** `ctx.event` is
`{ kind: "schedule", scheduledAt, previous: { at, output } }`. `previous` is the **last successful
run's output**, so keep your position there:

```js
// Every 15 minutes: pull the orders ERP changed since the last successful run.
export default async function erp_orders_pull(ctx) {
  const since = ctx.event.previous?.output?.cursor ?? "2026-01-01T00:00:00Z";
  const res = await ctx.http("erp", { method: "GET", path: "/orders", query: { changedSince: since } });
  if (res.status >= 500) throw Object.assign(new Error("ERP is unavailable"), { retry: true });
  for (const order of res.body.orders) { /* create or update work orders */ }
  ctx.output = { cursor: res.body.until, more: res.body.hasMore === true };
  return ctx;
}
```

- **Large jobs in pages.** Answer `ctx.output.more = true` and the next page runs at once
  (`ctx.event.page` counts them, up to 100), each reading the previous page's output. Each page must
  finish within the script's time limit.
- **Identity.** A scheduled service acts as its service role or a named user; it cannot run as "its
  caller", since the clock calls nobody.
- **Where it runs.** Leave **Run on nodes tagged** empty to let any node run it. Give a tag (such as
  `erp`) to keep its runs, and its record triggers, to the nodes IT started with that tag: typically
  the ones inside the network that can reach the other system. Changing it is a design change.
- **It runs once per time due,** however many nodes the plant runs. On the day the clocks go forward,
  a time that does not exist that day (02:30) runs once at the moment it would have been, and the
  times after it still run.
- A schedule starts from the moment its change executes: it never runs the times it would have had
  before.

**Test it** with a dry run on an event such as
`{ "kind": "schedule", "scheduledAt": "2026-10-01T06:00:00Z", "previous": { "output": { "cursor": "…" } } }`,
once as a first run (no `previous`) and once as a later one.

### Schedules from an installed suite

Some times only an installed suite can work out: "at every shift end" of a calendar the suite keeps,
say. A suite may add **kinds of schedule** of its own (§30.11). Each one appears on the **Triggers**
tab as a button **Add schedule: <its name>**, and in the **Runs** list of any schedule.

- Its **settings** are the suite's: each one is empty until you fill it in, and the ones marked
  **(needed)** must be. The suite checks them with the rest of the change, and says in words what is
  wrong.
- **Time zone**, **Missed runs** and **While a run is still going** work as for a clock schedule; it has
  no every, at, between or days, since the suite gives the times.
- The card's legend is the kind's name. **Next runs**, under it, asks the server, which asks the
  suite, for the next five times, after the suite's own words for the schedule; or what is wrong with
  its settings, in the suite's words.
- The scheduler plans its runs like any other: once per time due, however many nodes plan it. If the
  suite cannot give its times (its calendar cannot be read, say), nothing is planned for that schedule
  then, the event log says so, and every other service goes on.
- **If the suite is removed**, the service stays published and labelled as it is. Nothing is planned
  for that schedule, the integration monitor says which suite it needs, and a change to the service
  says so too. Once the suite is back, it runs again from then on.

In JSON: `{ "schedule": { "from": "<suite>.<kind>", "<setting>": value, "tz": "Europe/Berlin" },
"missed": "last", "overlap": "skip" }`.

> The core has no calendar object of its own (see OPENQUESTIONS.md): a schedule that follows a shift
> calendar comes from an installed suite that keeps one.

## 9. Transactions: screens that change several records as one

Some work changes several records at once, and must change all of them or none. Putting a lot on a
machine assigns the lot to the machine *and* loads the machine. A **transaction** is a screen you
design for that: what the person enters or scans, what must hold, and the steps. The seed has four:
**Move in**, **Track in**, **Track out** and **Move out**. They are designs like any object's, so your
plant can cut them differently (one **Start** that moves in and tracks in at once) without anyone
writing code.

Start one from the designer's home (**Transactions → New transaction**), or add one to a change
(**+ transaction**). Its tabs:

- **General**: its label and description; **Appears on** puts a button on records of an object while
  they are in the states you tick, with the record filled in (**…filling in** says which input), and
  **…only when** a condition on the record holds, if you give one (`{"eq": [{"record": "step_kind"},
  "spc"]}`); from
  the navigator (a favorite, or found by searching its name) it opens empty. **Confirm first** shows the person what will
  change before it runs (recommended). **Electronic signature**: its meaning, if the person must sign.
  **Verified by a second person**: another person, signed in beside the one running it, verifies it
  (what their signature means, *Verified*, and who may give it: departments, or roles written
  `<object>.<role>`); at every submit both re-enter their passwords. Two signatures at most.
  **Fill the window**: a **Maximize** button on its page that sets the navigator, the top bar and the
  tabs aside, for a tablet at a machine or a board on a wall (**on request**), or the page opening that
  way (**always at first**). Filled, the page still shows who is signed in and whether it is live, and
  the database banners stay; **Restore** brings the rest back. Each device remembers the person's
  choice for that page, so a kiosk stays filled after a reload.
- **Inputs**: what the person enters. A reference input names a record (a lot, a machine); set
  **Filled in from** to take it from another record (the lot's machine), shown, not typed. Any other
  input may be filled in from a field of the same type, its value shown beside what is typed (the lot's
  units beside Good and Rejected), as the person reads it. One filled in can fill in another (the
  product's route, then the route's first step), but not in a circle.
- **Layout**: the same layout editor as an object's form. Draw a reference as **scan or type the
  label**: the person scans the lot's barcode (or types "4711") and presses Enter. Set **Required when**
  here (a scrap reason when there is scrap).
- **Checks**: what must hold before anything changes, each with the words the person reads when it
  does not, on the input it is about. Conditions read `{"input": "good_qty"}`, `{"lookup":
  "machine.capacity"}` (a field of the record an input names), `{"user": "id"}`, `{"person":
  "certified_for"}` (a field of the Person record of whoever runs it: hold an operator to what the
  plant certified them for) and `{"count":
  {"object": "lot", "where": {"machine": {"input": "machine"}, "state": ["processing"]}}}`, with `add`
  and `sub` for quantities. Checks run again, under lock, the moment it runs: two people can never both
  pass "the machine is not full".
- **Steps**: in order, each on the record an input names: **Sets** fields (to an input, a looked-up
  value, a fixed value or nothing), **then takes the action** (one of that object's transitions),
  **Only when** a condition holds (the machine is loaded only if it was idle). Conditions ([section 17](#17-expressions-conditions-and-values)) read the
  records as they were before the first step.
  **Add a step that creates a record**: **Creates a** (which object), **How many** (one, or one per row
  of a rows input), and **Sets** its fields, a row's values read as `{"row": "value"}`. It is checked by
  that object's own policies and rules, as the person, and its stewards approve the transaction too.
- **Rows** (an input's type **rows (a table)**): the person fills in a table, one row per reading or
  wafer. Give its fields as `value:decimal, note:string`, and **at least** / **at most** how many rows
  (at least 3 readings, say). A condition can read them with `some` or `every`:
  `{"some": [{"input": "readings"}, {"gt": [{"row": "value"}, 1.5]}]}`. `mul` and `div` work out a
  yield: `{"div": [{"input": "good"}, {"add": [{"input": "good"}, {"input": "reject"}]}]}`.
- **Callers**: who may run it; nobody until named (deny by default): groups, people, and **services**
  whose scripts run it as their own service role (an ERP starting lots). A signed transaction is run by
  people only.
- **Try it**: opens the published screen.

**Each step goes through the object's own rules**, as the person running it: its state machine, its
policies, its rule pipe, its audit. So the object must allow it, **only through the transaction**: on
the object's **Roles & policies** tab, give the policy that grants the step's fields and action
**Only through transactions: move_in** (its names). That policy then grants nothing on the object's
own form, which never offers Move in on its own; a person who tries is told "Move in is done through
the Move in transaction", and **Why?** says so too. Put a state condition on it as well, so it grants
only where the transaction applies.

**What the person sees**: the inputs; **Check** shows what will change, record by record ("Lot 4713:
created → at machine; Machine M-101: idle → loaded"); **Confirm** runs it, all or nothing, and the
screen is ready for the next lot. Anything refused says why, on the input concerned ("The machine is
full.", "Lot 4713: The quantity must be more than zero."). Those messages belong to the inputs as they
were checked: any edit clears them (a machine refused may be fixed by scanning another lot), and so
does leaving the form, its page or its tab on a screen; what was typed stays. A label scanned that
finds nothing leaves the input empty and says so. **Clear** empties the form and its messages, but for
what the screen or the record fills in.

**From the keyboard or a scanner, without a mouse.** The cursor starts in the first empty input.
**Enter** (what a scanner sends after a label, too) goes to the next, in the order the form is laid
out; a scanned label first finds its record, and the cursor moves on only once it did. On the last
input, Enter checks; the cursor is then on **Confirm**, and Enter again runs it (a signature's box: Enter
ticks it; where two sign, Enter goes on to each password, then to Confirm). **Ctrl+Enter** (⌘+Enter on a Mac) checks or confirms from anywhere in the form, **Esc** goes
back an input, or out of a check. An input that shows an error, or is required and empty, keeps the
cursor until it is put right. Once done, the form is empty with the cursor in its first input, ready
for the next lot. To design it otherwise (which input next, what moves on from it, a question only for
a lot on hold, confirming at once), name an **input flow** on the transaction's General tab ([section 11](#input-flows-entry-designed-for-the-keyboard-and-the-scanner)).

**Approval**: a transaction is approved by its stewards, and a change to its steps also by the
stewards of each object, field and transition they write. The `via` policies are the objects' own, so
their stewards approve what a transaction may do to their records.

### Signed by two people

A transaction can need a second person to verify it (**Verified by a second person** on its General tab):
a material checked by Quality, a recipe loaded under a witness. At the station:

1. The operator signs in as usual. The second person signs in **beside them**: the people icon with a
   **+** beside the operator's name at the top, their sign-in id and their password, **Sign in beside
   me**. Two at most: a third is refused until one of them signs out.
2. Both names show at the top (*Olga Ortiz + Quinn Park*). The form of a transaction that needs a
   verifier, once checked, asks for both passwords: *Your password*, and the second person's. Each
   signature shows its meaning and whose it is. Without a second person signed in, it says so and offers
   **Add a second person**.
3. **Confirm** runs it only if the second person may verify it (one of its departments or roles, and not
   the operator), and both passwords are right. A wrong one refuses it, says whose, and writes nothing; it
   counts towards that person's lock (five wrong ones lock them for 15 minutes, as at sign-in).
4. The run's entry in the audit trail keeps both signatures: names, meanings, the time.
5. The second person stays signed in beside the operator, signing again at each submit with their
   password, until **Sign … out** (the × beside their name) or the operator signs out, which ends both.

Who signs in through single sign-on has no password here: they set a **signing password** on their
**Your password** page, used only to sign (it never signs anyone in), or each uses **Sign in again with
single sign-on** beside their password box. Who signs in through the plant's
directory signs with their directory password. On a development or demo instance (anyone may be
anyone) no password is asked; who may verify is checked all the same. In a sandbox or a scenario, a
signed step names its verifier (**Verified by**), with no password.

## 10. Screens: pages you compose

A **screen** is a page you put together from blocks: a **Work centre** for one machine (the machine,
how many lots are on it, the lots processing, waiting and done, and a form to move the next lot in),
or a **Shop floor** board (machines by state, lots on hold, scrap by reason). The seed has both.
People open screens from the navigator: a favorite, or found by searching its name (star it to keep it).

Start one from the designer's home (**Screens → New screen**), or add one to a change (**+ screen**).
Its tabs:

- **General**: its label and description; **Opened with**: nothing (the same page for everyone) or a
  record (a machine), picked by **scanning** its label or from a list. Each machine then has its own
  address and tab: `/s/work_centre/<machine>`. **…only those where** limits which records open it
  (`{"process": ["die_saw"]}`: a die saw's screen lists and opens die saws only). **Fill the window**, as a transaction's: a **Maximize** button on its page that sets the navigator, the top bar and the
  tabs aside, for a tablet at a machine or a board on a wall (**on request**), or the page opening that
  way (**always at first**). Filled, the page still shows who is signed in and whether it is live, and
  the database banners stay; **Restore** brings the rest back. Each device remembers the person's
  choice for that page, so a kiosk stays filled after a reload.
- **Blocks**: **+ add a block**, then set its **Title** and **Width** (of a 12-column row; on a tablet
  or a phone they stack), and **↑ ↓** to order them. Give blocks a **Tab** to put them under tabs:
  blocks with the same tab share it (four transaction forms, under **Move in**, **Track in**, **Track
  out** and **Move out**), and blocks without one stay above the tabs:
  - **one record**: a record's fields, usually the one the screen is opened with (`{"param": "machine"}`);
  - **a table of records** (it holds up to **At most** rows, 1 000 at the most, and draws **Drawn at a
    time** of them, more as it is scrolled; sorted text puts numbers in number order): **Only records where** (for example `machine = {"param": "machine"}` and
    `state = ["processing"]`), the **Columns**, the sort, how many rows, and **Buttons on each row**:
    transactions that appear on those records. A row shows the ones for its state; pressing one fills the
    row into the screen's own form of that transaction, if it has one (a station's **Move in** tab: the tab
    opens, the row is marked, and the page scrolls to the form with four of the list's rows still in sight),
    or else opens it right under the table with the row filled in; when it is done the row moves on. **…filling
    in** fills one of their inputs with the screen's record too (the equipment, on Move in), locked. **Record
    buttons**: **New** (to add one) and **Remove** on each row (it archives the record, after asking),
    each shown only to whoever the object's policies allow, its rules still applying;
  - **a number**: how many records, or the sum, average, least or most of a number field; optionally
    only those **Changed** today or in the last 7 or 30 days;
  - **a breakdown**: bars by a field or by state, with the same measures;
  - **a chart from a query**: any of the AI Report's twenty kinds of chart. Its query is a JSON or SQL
    query over the views of the **Queries** page, run as whoever opens the screen (what their policies
    hide is not there); a JSON query may stand for the screen's parameter, `{"eq": [{"field":
    "machine"}, {"param": "machine"}]}`, so a machine's screen charts that machine. Pick the kind, then
    say which of its columns go where (the boxes the kind needs are starred), the unit, how it is drawn
    (stacked, across, labels…), and reference lines or bands as JSON. A record named in its answer
    is shown by its title, never its id;
  - **a transaction's form**: embedded, with inputs the screen fills in (the machine) shown locked;
    **In a dialog: close the dialog once it is done**, for a screen shown as a dialog;
  - **a button that opens a screen**: it opens that screen as a **dialog** over this one, with what you
    give **Opened with** (`{"param": "machine"}`); shown only to people who may open that screen;
  - **text**.
- **Preview**: the draft as it will look, with your own rights; pick a machine to open it with.
- **Pop-up**: tick **Opens by itself** to have this screen open as a dialog, by itself, **Over** the
  pages you choose (a transaction, a screen, or every page), **For** the groups or people you name,
  **While** a condition ([section 17](#17-expressions-conditions-and-values)) holds (over the page: a transaction's inputs, `{"lookup": "machine.state"}`,
  a screen's parameter, counts), **Opened with** what it needs from the page (`{"input": "machine"}`).
  Everyone on that page sees it at once, and it closes by itself when the condition stops holding. A
  person may close it; it shows again when they next open the page while it still holds. It only
  shows: what must not happen is refused by the transaction's own checks (its **Must hold**). The seed's
  **Machine down** opens over Move in and Track in while the machine is down.
- **Callers**: who may open it; nobody until named.

**Any screen can be a dialog.** A button or a pop-up opens it over the page you are on, which stays
as it was: a few questions, or a whole screen of its own, such as manual data collection with its
tables and its transaction. Close it with its ✕, Escape or a click beside it.

**Everyone sees it with their own rights.** A table lists only the records they may read, with only
the fields they may read; a number counts and adds only those. So one screen can serve Production
and Quality, each seeing what they are allowed to. A screen changes nothing itself: its buttons are
transactions, with their own checks and approvals. It is approved by its stewards alone.

**It is live:** a lot tracked in on one tablet moves from "Waiting" to "Processing" on every screen
showing that machine.

**From the keyboard or a scanner.** Opened without its machine, the cursor waits in its scan (or list);
once chosen, it goes to the first empty input of the form on the tab in view. **Alt+1**, **Alt+2**, …
switch the tabs (Option+1 on a Mac), the tab's form taking the cursor; a row's button that fills a form
puts the cursor in that form. Each form then goes as [section 9](#9-transactions-screens-that-change-several-records-as-one) says. A screen may name an **input flow** too,
over its machine and its forms (scan the machine, then on Move in the lot, run, and again).

### A floor layout: the line seen from above

A **floor layout** block draws your equipment where it stands on a picture of the floor, each with a
small square in the colour of its state, as it is right now (§35). Add it on a screen's **Blocks** tab
(**+ add a block → a floor layout**), then, on its card:

1. **Of**: the object your equipment is.
2. **Status**: the field the square shows: the record's state, or a field of it (a choice, a yes/no).
3. **Each record's picture**: where the equipment's own picture is: an image field of the equipment, or
   of what it refers to (*Model → Picture*: one picture per model, set once on the model). None: a
   plain tile with its name.
4. **Legend**: a colour for each state. Leave one alone and it takes its tone. The colours are the
   theme's (five tones and eight more), so the board reads in light and in dark.
5. **Upload the floor's picture**: a top view of the floor or the line (PNG, JPEG or WebP, up to 5 MB).
6. **Put the equipment on it**: type part of a name (*WBD*), and click each one found. Then:
   - **drag** a tool to where it stands;
   - **drag its small square** to where it sits on the tool (its signal tower, its screen);
   - click a tool to **size** it with the slider, or take it off the floor;
   - **Same size and square for its like** gives every tool with the same picture the same size and
     square position: arrange one wirebonder, and the others follow;
   - the arrow keys move the chosen tool a step (with Shift, a larger one).

The squares on the canvas already show the tools' real states. Name who may open the screen
(**Callers**), and submit the change: the layout is reviewed and approved with its screen. Up to 200
tools on a floor.

On the board, a tool that changes state changes colour at once, on every screen showing it; the legend
counts the tools in each state; a tool opens its record. Each person sees the states of the tools they
may read: one they may not is drawn in its place with an empty square. Use **Fill the window** (General)
for a wall board.

To hold pictures, give an object a field of type **image** (its **Fields** tab): on its form, whoever
may write the field uploads the picture.

### Showing and enabling blocks and tabs by condition

A screen can offer only what makes sense right now: at a machine that already has a lot on it, the
**Move in** tab is greyed; a block for Quality is drawn for Quality only (§26.9). Every block has
three more settings, under its Title, Tab and Width:

- **Shown when**: a condition. While it does not hold, the block is not drawn, and its records are not
  read or sent to the page. Empty means always.
- **Enabled when**: a condition. While it does not hold, the block is drawn greyed and cannot be used
  (not with the pointer, and not from the keyboard). Empty means always.
- **…because**: what the person reads on a greyed block, and on its tab: "This machine already has a
  lot on it." Write it as you would say it at the machine.

**Tabs follow their blocks.** A tab none of whose blocks is shown is not there. A tab none of whose
blocks is enabled is greyed, with a lock and the reason when the pointer rests on it; pressing it
says the reason under the tabs instead of opening it. If the tab someone is on becomes unavailable,
the screen moves to the first one that is. A row's button that fills a greyed form (**Move in** on a
waiting lot) is greyed with the same reason.

**What a condition reads** (the language of [section 17](#17-expressions-conditions-and-values)):

| It reads | Written | For example |
|---|---|---|
| the record the screen was opened with: a field, or its state | `{"lookup": "machine.state"}` | `{"eq": [{"lookup": "machine.state"}, "idle"]}` |
| what the screen was opened with | `{"param": "machine"}` | `{"not": {"is_null": {"param": "machine"}}}` |
| who is looking: their id, name, departments | `{"user": "departments"}` | `{"contains": [{"user": "departments"}, "quality"]}` |
| how many records there are | `{"count": {"object": …, "where": …}}` | `{"gt": [{"count": {"object": "lot", "where": {"machine": {"param": "machine"}, "state": ["at_machine"]}}}, 0]}` |

The record is read as the person may read it: a field their policies hide is empty to the condition.
A condition is checked as you design it (a field the record does not have, an operator the language
does not have, are problems on the block), and it is worked out again whenever a record changes, so
the tab comes back the moment the machine is idle. A condition that cannot be worked out does not
hold: the block is not shown, or not enabled.

**It is what the screen offers, not who may do it.** A greyed tab saves someone a refusal; it is not
the rule. Whether a transaction may run is still its own **callers** and **requirements**
(section 9), checked when it is confirmed, wherever it is run from. Put the rule there, and repeat
it here only so the screen does not offer what would be refused. Likewise, hiding a block keeps its
*records* from the page; the block's own title and words are part of the screen's design, which
everyone who may open the screen receives.

**With the copilot:** "grey the Move in tab while the machine has a lot on it, and say so", or "show
the scrap figures to Quality only".

### A desktop's own page

A computer on the floor is usually for one job. Say so once, and whoever signs in there starts on
that page (§6.8):

- Open **Desktop** (search "desktop" in the navigator; it is listed for those who hold a role on it:
  the designers at first, and whoever People & departments gives `editor` or `viewer` on it, usually
  IT) and add a record: the desktop's
  **name** (Press 3 terminal), its **address** (the IP address its browser comes from, as the server
  sees it: ask IT), whether it **opens** a screen or a transaction, and that screen's or transaction's
  **name** as the designer has it (`work_centre`, `move_in`). For a screen opened on one record (the
  work centre of *this* press), give the record's id in **Opened with**.
- **Load a floor at once** from Excel: Data → Import / export, a tab named `desktop` with the columns
  `name`, `address`, `opens`, `page` (and `opened_with`, `note`). A row is found again by its
  address, so loading the workbook again updates the desktops it names and adds the new ones.
- **At that desktop,** signing in opens its page instead of Home, filling the window. **Restore**
  (top right of the page) brings back the navigator, the top bar and the tabs, and the person can go
  anywhere from there; it stays restored until they sign out, and the next sign-in opens it filled
  again. Home shows **This desktop opens …** as a way back.
- Someone who may not open that page (its callers) lands on Home there, as on any computer. A link
  followed before signing in still leads where it pointed.
- An address must be an IP address (anything else is refused at the field) and must stay the same:
  give the computer a reserved or fixed address. **Archive** a desktop to stop it opening its page.

## 11. Flow templates: routes and plans

A **flow template** is how something goes, drawn: a **route** a lot goes through step by step, or a
**plan** (an OCAP, out-of-control action plan) that an event such as an SPC reading out of limits sets
off. You draw it in the **Flow** designer; it is approved like any other design, and every run of it is
audited.

**First, the objects take part.** Open the object in the change (a lot), and on its **General** tab
under **Flows** tick how its records may take part:

- **a traveler**: goes along a route (a lot). Pick its **step field**, a text or choice field: the
  step the lot is at. The route sets it as the lot moves on; and if someone sets it (a form, an import,
  a transaction that moves it), the route follows. Its policies must let the template write it. If it
  is a choice field, each step of the route must be one of its choices.
- **a resource**: where a step's work is done (a tool).
- **a subject**: its records may set a plan off (an SPC reading).
- **a reference**: a template may read it (a product).

**Then the template.** Start one from the designer's home (**Flows → New flow template**), or add one to
a change (**+ flow template**). Either may start **as a copy of** another (pick it beside the name): all
of it under the new name, its scenarios running the copy. One process's OCAP becomes another's this way:
change its start (the step it is set off at), its causes and their actions, and its label. A copy is a new
design, reviewed and approved like any other (§3: every kind is copied the same way). Its tabs:

- **Flow**: the canvas. **Add** a node from the palette; drag it into place; click it for its settings
  beside the canvas; **Wire from here…** then click the node it goes to. Click a wire for its settings.
  **Tidy** lays everything out. A node or wire with a problem is outlined in red, its problem said
  under its settings. On a phone, the canvas is a list. **Zoom**: the canvas is fitted to the panel;
  **−** and **+** in its corner zoom out and in, as does Ctrl (⌘ on a Mac) with the wheel, or a pinch,
  about the pointer; the percentage fits it again. Zoomed in, drag the empty ground to move about. A
  run's map (**Show the route**, a plan's page) zooms the same way. The zoom is yours alone: it is not
  saved with the design.
- **General**: its label, its **kind** (a route or a plan: each has its own palette), and **Ends early
  when** (a lot merged or scrapped ends its way where it is).
- **Context**: what every run carries and its decisions read: its records (by their names on the
  Participants tab), the **values** it starts with (a limit, a number of retries), and what is
  collected on the way.
- **Participants**: its records (the traveler, the resource, what it reads, each taken from another
  with **from**: the lot's product), and **what the template itself may do**: the roles it acts with
  when it sets a lot's step and state and makes its scripts' writes. Give it the least it needs.
- **Stewards**, **Changes**, **JSON** and **Copilot**, as for every design.

**A route's nodes**

| Node | What it is for |
| --- | --- |
| **Start** | Where runs begin. **For travelers where**: which lots this route takes (`{"eq": [{"context": "product.route_flow"}, "back_end"]}`). A lot made part-way starts at its step. On a plan: **For events where**, and **Due on** (a date field of its subject: it sets off when that date arrives) and **sets off again** (once its last run for a record has ended) |
| **Sequence** | A step. **Done here**: the transactions offered on a lot at this step (elsewhere they are refused, and not shown on its page); **…taking it on**: those that move it on (Move out); **Marks its state**: optional; **On resources where**: only these tools (`{"process": ["die_saw"]}`), the ones a transaction is given, not those it reads off them (a test cell's tester, an input taken `from` the cell); **Settings**: values its transactions read (`{"lsl": 28, "usl": 36}`, read as `{"node": "lsl"}`) |
| **Auto decision** | Branches at once. Click each wire for **Taken when**, a condition on the context ([section 17](#17-expressions-conditions-and-values); `{"gt": [{"context": "lot.scrap_qty"}, {"context": "max_scrap"}]}`); they are tried in order (**Try earlier**), the last may be empty: otherwise |
| **Sub flow** | Runs **another route** for the same traveler. The lot goes through that route's steps, then comes back to this route's next step. **Runs**: the route to run; **Passes** and **Takes back**: values into its context and back |
| **End** | Closes the run, with its **outcome** (shipped) |

**A route inside a route.** Draw a segment once (a rework loop, a test segment, a common back end) and
run it from every route that needs it:

1. Draw the segment as its own route, and on its **General** tab set **Runs** to *only inside another
   route*. It then takes up no lot by itself, and needs no scenario of its own: it is tried through the
   routes that run it.
2. In each route that needs it, add a **Sub flow** node where the segment belongs, pick it under
   **Runs**, and wire it in like a step.

While a lot is in the segment, its step is the segment's (Strip, Redo), the transactions offered are
that step's, and its page shows both: *Main route › Rework · at Strip*. When the segment reaches its
End, the lot goes on to the route's next step. A fix to the segment is one change, and every route that
runs it follows: lots entering it afterwards take the new version; a lot already inside finishes on the
version it entered. A lot may be carried out of a segment by setting its step to a step of the route
it runs inside: the segment ends there, and the route follows, marked off route. Routes nest at most
five deep, and never in a circle.

**A plan's nodes**: **Wait** (a
message and the time remaining; when the time is up it goes on by itself, waits for someone to
acknowledge, or also offers **Retry**, which takes its retry wire back), **Manual decision** (a person
picks one of its wires: name each wire's choice), **Input screen** (collects list choices, typed
values, files, images and links into the context), **Sub flow** (runs another template, passing it
values and taking some back; never in a circle: a template whose sub flows lead back to itself, through
others too, is refused, the way round named; and at most five plans deep, the first and four below it:
a run that would go deeper stops at that sub flow, saying so. The designer checks circles, not depth,
so keep chains short), and **Auto decision**, **Start** and **End** as above.

**Scripts on a node.** Every node can run a script **On entering** and **On leaving**: a rule script
(§5) that gets the run's context and gives it back. It can set values in the context for the decisions
after, and ask for writes (`ctx.writes.push({ record: "lot", action: "ship" })`). Those are made after
it, as the template, through the record's own rules: its transitions, policies and rule pipes decide,
and a refusal stops the run there, saying why. Like every script, it needs its test cases.

**When a plan runs.** A plan sets off by itself when a record of its subject is made or changed
where its start's condition holds (a deviation raised as major, an SPC reading out of limits), once per
record. Two settings of its start change that. **Due on** names a date field of the subject (a
preventive maintenance's next date): the plan sets off when that date arrives, with nobody writing
anything, checked about once a minute. **Sets off again** lets it run again for the same record once its
last run there has ended (a tool that goes down a second time); one runs at a time, however often the
record is changed meanwhile. A plan whose start has neither a condition nor a due date runs only as
another plan's sub flow. When it reaches a
decision, an input screen or a wait to acknowledge, it appears in the **bell** of the people it is for
(**Plans waiting for you**). Its page shows the plan's own state (in progress, stopped or ended), what
set it off with that record's own state beside it (a tool **Down** while its repair is in progress), and
the route that record was on, the time
remaining at a wait, a button per choice, or a form to fill in (lists, numbers, yes or no, files,
photos, links), with its way so far and what it holds; files open from there: a picture, a PDF or
plain text opens beside the page, anything else (a web page, a drawing with scripts in it) is saved to
your device instead of being opened. When two people act on the same step at once, or one clicks
twice, the plan goes on once and the other is told someone has just acted. **Show the flow** draws
the plan as it was designed with its way on it: the steps it went through filled in, the wires it took
marked (×2 when twice, as after a retry), where it is now outlined, what it never reached faded; point at
a step for when it was there and who moved it on. Only the people it is for
may act; everything they do is in the audit trail. The record that set it off, and the records it
reads (a deviation's lot), show the plan on their page.

**Its evidence.** A template that sets off by itself (every route; a plan whose start has a condition or a due date)
carries at least one **scenario**, or it is not submitted. Make one in the change's sandbox: pick or
give the records, walk one through (run the transactions, or **Answer a plan**: fill its screen in,
pick a choice, acknowledge or retry a wait, or let its time pass), and **Keep it as a scenario of** the
template: it keeps what each step did and the step or node each record reached. Its **Scenarios** tab
lists them with their last result; the fitness test runs them all again on every submit.

**When a route runs.** On a lot's page you see the route it is on, the step it is at and its way there;
**Show the route** draws the route with the lot's way on it, a step set by hand drawn off route.
A lot at a step is offered only what that step does. When a transaction that takes it on commits,
the route moves it on, through decisions, to the next step. If someone sets its step by hand, the route
follows, marked **off route** in its way. If the step they set is no step of the route, the run
stops and says so; the route's moves are refused until the step is put right.

### Input flows: entry designed for the keyboard and the scanner

An **input flow** is a third kind of flow template, drawn on the same canvas (General tab, **Kind: an
input flow**; it starts you with *Scan the lot → Check and confirm → Next*). It says how a person at a
transaction or a screen fills it in, and any number of transactions and screens name it (their General
tab, **Input flow**), so one scanning flow serves every station that works the same way. Its steps:

- **Ask**: the cursor to one input, outlined, with its **prompt** above the form ("Scan the lot"). On a
  transaction, an input by name (`lot`); on a screen, `param` (its machine) or `move_in.lot` (the name
  alone when it has one transaction). **Moves on by**: Enter (the default, and what a scanner sends),
  Tab, Enter or Tab, **a key of its own** (F1–F12, or a scanner's suffix such as `*`; press it in the
  box), or **by itself, once complete** (a scan that found its record, a choice picked, or the entry
  reaching a length or matching a pattern). An input already filled (by the screen, a row's button, a
  Fill) is passed over, unless you untick it. **On an error**: the cursor stays until it is put right (the
  default), or goes on regardless.
- **Fill**: sets an input on the way (the good quantity from the lot's, `{"lookup": "lot.qty"}`).
- **Auto decision**: its wires' conditions, on what was entered: `{"lookup": "lot.state"}` is the
  state of the lot just scanned, so a lot on hold can be asked *why* and others not.
- **Run**: Check, then **Enter on Confirm**, or **confirmed at once**; a signature is always asked. If
  the check refuses, the cursor goes back to the last ask with what it said.
- **End**: **the start again** for the next one (the form is empty again), or stop.

The designer checks it where it is named: a transaction's input flow asks only for its inputs that a
person types, and a screen's only for its machine and its own forms' inputs, each problem named. It runs
in the browser and writes nothing itself; changing which input flow a transaction uses needs no new
scenario. The copilot and the AI API can draft one, and walk it with sample values to show you what it
asks, in order.

## 12. Getting a change approved

1. **Give the reason** in **Why this change**. Write it for the approvers: what, why, and what the
   plant will notice.
2. **Clear the problems** in the side panel.
3. **Try it in a sandbox** (a new or changed transaction needs this). The sandbox is a database of its
   own: your draft runs there on copies of real records, and nothing live is touched.
   - **Records it starts with**: give each a key (`lot`), pick a real one (scan or type its label: it
     comes with what it refers to, its product, its step), or give one (its data as JSON, `"@product"`
     naming another). Only what you may see is copied. **Find a record** searches every object at once
     (a lot number, a tool, a name): click a hit to add it, its key made from its object.
   - A server keeps six sandboxes open at a time, two of them yours: close one you no longer need
     (they also close by themselves after a quarter of an hour unused). Scenario runs take turns, a
     few at a time; when many are queued, the fitness test asks you to try again in a minute.
   - **Saved selection**: keep the records under a name, your own, on any change's sandbox. **Save as…**
     names it (a date and time to begin with), **Save** keeps edits over it, **Rename…** and **Delete**
     do what they say; pick another to switch to it (asked first if what is here is not saved). The
     list shows each one's records and when it was saved; "Edited since saved" says it has changed.
   - Every JSON field here (a given record's data, **Where**, an edit's or a new record's data, a service's
     input, a plan's values, a transaction's rows) is a code editor: coloured, a syntax error marked on
     its line, and a field its object does not have named, with the ones it has.
   - **Open the sandbox**, then **Run a step**: a transaction (its inputs pick among the sandbox's
     records), a record's action, an edit, a new record, a service or a screen, **As** anyone: their
     roles decide, as they will live. Each step says whether it ran or was refused, and what moved.
     **Start again** gives fresh copies.
   - **Keep it as a scenario of** a transaction of the change, **Named** what it shows. The scenario
     is kept with every version of the transaction, and the fitness test runs it again, on fresh
     copies of the records as they are then. The transaction's **Scenarios** tab lists them, with
     their last result and **open in the sandbox** to run one again.
4. **Run the fitness test.** It checks exactly what you will submit and gives reviewers the evidence:
   - **fails** on problems, scripts that do not compile or call what they will not have, new or
     changed scripts without test cases, failing test cases, and new or changed transactions without
     a scenario or with one that does not do what it expects;
   - **warns** about existing records the draft would no longer let be saved (a new required field,
     a state removed), with how many;
   - **lists access changes** per role and state (`lot · operator · on_hold: +archive, qty w→r`).
5. **Submit for review.** The content is frozen at this point and identified by its hash; what is
   approved is exactly what was reviewed. If it needs changes later, it comes back to Design.
6. **Review.** A reviewer who is not you reads it, then **Pass review** or **Ask for changes** (with a
   note, back to you). A review or an approval opens on **Changes**: every difference from the
   published version, marked **new**, **changed** or **removed**, with the published and the proposed
   versions line by line (red taken out, green put in), and **Open Fields**, **Open Layout**… to see
   it in place. The tabs carry how many differences each holds, and inside them new and changed
   fields, policies and layout cards are highlighted. You see the same while designing. A reviewer who represents a department cannot also approve for that
   department, and is told so first.
7. **Approval.** Each department in **Will need approval from** approves or rejects through one of
   its representatives (rejecting, or asking for changes, opens a box for the reason: it is required,
   and the author and the audit trail read it) (**Approve for Production**, **Reject for Quality**). One rejection ends the
   change: it is marked rejected, and a new change starts from the published version.
8. **Execution.** When every department has approved, the platform publishes the change at once, in
   one step: new versions of the objects, scripts, services and connections, live everywhere with no
   restart. Open forms pick up the new version. At that moment the change is checked once more
   against what is live *now*: if something it relies on was changed or retired while it waited (a
   field its transaction writes, an object its screen shows), or what it touches came to answer to
   a department that never signed it, it does not go live. It is marked **failed**, saying what
   changed; send it back to design, fix it and submit again.

**Who is asked.** Everything a change touches is in its footprint, whether or not the designer has a
tab for it (an object's part in flows, a setting added by a suite): each element answers to its
stewards, a script a flow runs at a step answers to that flow's stewards, and an element nobody
stewards answers to the governance department, also when the rest of the change has stewards.

**Withdraw** abandons a change at any time before execution.

A design is in **one open change at a time**: starting a change on it, bringing it into one, or
saving it into one is refused while another open change holds it, naming that change and its author.
Finish or withdraw that one, or make your edit there.

**Approvals** (the navigator's Design group, or search "approvals", "pending", "sign") lists every change
waiting for review or approval, live: for each, its departments, approved ✓ (by whom), rejected ✗, or
pending at which step and for whom. What you can review or sign now is marked and comes first; **Only
what I can do now** hides the rest.

### People & departments, and approval steps

Who approves is set under **People & departments** (the navigator's Design group, or search "people",
"roles", "departments"): its page shows the organization as it is live, read-only (who holds what, each
department's steps), and **Change people & departments** starts a change whose draft is it as it is, or
**Open the change in progress** goes to the one already open (only one at a time). Another open change
may hold it too, as part of something else (the roles a suite's designs or a model file would give):
then no change starts here, and you are told which change holds it, its stage and its author. Once that
one is executed or withdrawn, a change can start here.

- **Departments**: each one's name, members and **approval, in order**: its steps (e.g. IT: 1.
  Specialist, 2. Manager), each with the people who may sign it. The steps are signed one after the
  other, each by a different person, never the change's author or reviewer. Departments sign in
  parallel with each other. **+ step** adds one; **Governance** names the department that approves what
  nobody else stewards, new departments and new people.
- **People**: everyone who signs in. Untick **Active** instead of deleting someone. Each person also has
  a **Person** record (the built-in Person object), made, renamed and made inactive as this change
  executes: add what the plant keeps about people (a badge, a shift, skills) to Person in the designer.
  Their sign-in id, name and whether active stay here: Person shows them read only.
- **Find people** first: a plant has thousands, so the People tab lists nobody until you type a few
  letters of a name, sign-in id or department, except the people your change adds or changes, which are
  always shown first. The list scrolls with the tab (the window itself never scrolls) and shows fifteen
at a time: scroll to the end of them (or press **show more**) for the next fifteen, however many match. A
  department with many members shows how many, and typing in its members box finds one (✕ removes them)
  or someone to add. On the demo and test instances everyone is listed at once.
- **Add, Import, Export** sit at the top of the People tab. **Export** downloads everyone as a CSV that
  Excel opens (id, name, active, departments: their ids, separated by spaces). **Import** reads one back,
  edited, or saved from HR's spreadsheet (comma, semicolon or tab): each row says what that person is.
  New ids are added (a name is needed), the others take the row's name, active (yes or no) and
  departments. An empty name or active cell keeps what is there; an empty departments cell means none.
  People not in the file stay as they are: nobody leaves by being left out. Before anything changes, it
  shows what the file would do, and which rows it cannot take and why. It goes into this change only,
  approved like any other edit.
- People are chosen by typing a few letters of their name in a box (Enter, or a click, adds; ✕ on a
  chip removes).
- **Moving someone** between departments moves their roles: they lose the old department's and gain the
  new one's. **What this changes for people** lists that, person by person; **Keep them** gives a lost
  role to the person directly. The fitness test lists it too, for the reviewers and approvers.
- **Roles**: who holds each role each object declares (lot operator: Production), and the designer's
  Two ways in, for any number of objects: **By object** (search an object, a role, or who holds one;
  objects fold to one line, 30 at a time, more as you scroll, the ones this change touches first) and
  **By group or person** (pick who: everything they hold, directly and through their departments;
  ✕ takes one away, **Give another role** searches every object's roles).
  and the query console's roles. A change here is approved by that object's stewards.
- **Approvals**: **standing approvers**, departments that approve every change to a kind of element,
  whoever stewards it. Tick IT for connections and services, and every integration change goes to IT
  too.
- **Reads every record** (on the Approvals tab): people and groups who may read every object's
  records, those designed later and a suite's included, every field but one a policy hides. It writes
  nothing and takes no action; for IT building services, or an auditor. Governance approves it, and
  **What this changes for people** shows who gains it.

**Adding IT to the approval flow**: add the IT department with its people and steps (**Departments**,
**People**), give them the designer's reviewer role so they can see what they approve (**Roles** →
Designer), then either tick IT as a standing approver for the kinds it answers for (**Approvals**), or
name IT as a steward on the elements it answers for (their Stewards tabs).

While approving, the side panel shows each department's steps: which are signed, by whom, and whose turn
it is; the button says which step you sign ("Approve for it as Manager (2 of 2)").

**Dates, times and numbers** (the **Formats** tab): how the plant writes them on every page: the date
format (`DD.MM.YYYY`, `MM/DD/YYYY`, …), 24 or 12 hours, the locale for numbers (1.250,5), the week's
first day and the plant's clock (time zone). It shows how a moment, a number and a date will read.
Approved by governance; pages follow when next opened. Nothing stored changes.

**How the pages look** (the **Theme** tab): **Light or dark**: each person chooses (the default), or
always light, or always dark, for everyone (then nobody is offered a choice). The **name** in the top
bar and the **label** beside it (the site, plant or line). The **colours** of the accent and of the
ok, warn and danger tones, for light and dark, each with a colour picker; empty is the default. A
preview shows them on a top bar, a button, the tones and a link, and every colour is checked: one
people could not read (below 4.5:1) is listed in red and the change cannot be submitted until it is
fixed. Approved by governance; pages follow when next opened.

## 13. After it is live: the integration monitor

**Integration monitor** (`/design/integration`) shows what the plant's integration is doing, every
10 seconds, all times in the plant's time zone:

| Section | What it shows | What you can do |
|---|---|---|
| **Nodes** | Each running server: alive or gone, its tags, whether it plans schedules and runs triggers, its build, when it was last seen. A red warning if no live node plans schedules or runs triggers | Tell IT |
| **Schedules** | Each scheduled service: when it runs (or, for a schedule from a suite that is not installed, which suite it needs), where, the **next run**, the **last run** and its outcome and error, totals (ok, failed, missed, skipped), what is queued, and its last runs | **Pause**, **Resume**, **Run now** |
| **Inbound** | Each web service outside systems call: its address, its callers, its calls in the last 24 hours (ok, refused, failed), the last call | |
| **Outbound** | Each connection: the services that use it, its requests in the last 24 hours (ok, failed, unreachable), the average time, the last request | |
| **Record triggers** | Each service a record event sets off: what it reacts to, where it runs, its queue and its last 24 hours | Send a failed one again from the service's **Activity** tab |

**Pause, Resume and Run now are operations, not design:** they take effect at once, without a
change request, and are audited and written to the event log.
- **Pause** stops new runs (a run already queued still runs), for example while ERP is down for
  maintenance.
- **Resume** plans from now on: what fell due while paused is not caught up. Use **Run now** if a
  run is needed.
- **Run now** runs the service once, outside its schedule, with the schedule's identity.

> **Not yet.** The design gives pausing, resuming and running now to the service's stewards; today
> anyone with the designer may.

### Analytics: time between states

The platform records every stay of a record in a state: when it entered, when it left, who moved it
and by which action (§22). Nothing to design beyond the dimensions (section 4); every object with
states has it.

- **A record's Timeline tab:** its states in order, as a coloured strip and a table (entered, left,
  by whom, how long). An archived record's stay ends when it is archived; restoring it starts a new
  one.
- **An object's Analytics page** (**Analytics** above its list), for a period (the last 7, 30 or 90
  days, or a year), optionally **By** one of its dimensions:
  - **Now:** the records in each state at this moment, their average age and the oldest. Archived
    records are not counted.
  - **Time in each state:** the stays that ended in the period: how many, average, median, 90th
    percentile and longest.
  - **Lead time:** from a record's first entry into one state to its first entry into another after
    it (for a lot, created → released), for records that reached the second in the period; with the
    slowest records, each a link (only those you may read are listed).
  - **Entries:** records entering a state per day, week or month (lots released per day), in the
    plant's time zone.
- **Who sees it:** anyone holding a role on the object; grouping only by a field they may read in
  every state.

> **Not yet.** Measures and dashboards you design, and OEE, are the next phases (§22.6): this page is
> the first, built-in view.

### Queries: SQL and JSON

**Query** (under **Data** in the navigator, for people with the analyst role) asks the plant's data
anything, in SQL or JSON (§23).
- **The schema explorer** (left) lists a view per object (`lot`, `work_order`, …) and its stays in
  states (`lot_stays`). Each column shows its type, and a tag when you may read it only in some states,
  or never (it is then empty for you). **Use sample query** starts you off; clicking a column adds its
  name to your query.
- **SQL:** one `SELECT` (a `WITH` before it is fine). Ctrl/⌘ + Enter runs it. For example, lots per
  item released in the last week:
  ```sql
  SELECT l.item, count(*) AS released
  FROM lot_stays s JOIN lot l ON l.id = s.record_id
  WHERE s.state = 'released' AND s.entered_at > now() - interval '7 days'
  GROUP BY l.item ORDER BY released DESC
  ```
- **JSON**, if you do not write SQL:
  `{ "from": "lot", "select": ["state", { "count": "*", "as": "lots" }], "groupBy": ["state"] }`.
  **Open as SQL** shows what it became.
- **You see what your forms show:** the same rows and fields your roles let you read, whoever wrote
  the query. Nothing else is reachable: the tables behind the views, settings and other databases are
  refused, and a query stops after 5 seconds or 1 000 rows (up to 10 000 if you ask).
- **Download CSV** saves the result. A value that a spreadsheet would run as a formula (one that starts
  with `=`, `+`, `-` or `@`) is written with an apostrophe before it, so it opens as text.
- Both editors colour what you type (keywords, strings, numbers, names, comments) and mark an
  unclosed bracket, string or comment on its line before you run anything.

### AI Report: reports, layouts and the analytics copilot

**AI Report** (under **Data** in the navigator) holds pages of words, figures, charts and tables on the
plant's data (§34). You see the entry when you hold a role on the built-in **AI report** object: analysts
are its **authors**; give anyone else the **reader** role (People & departments) to let them open what
is shared.

- **Ask the copilot** (analysts, on the AI Report page): say what you want to know in plain words, for
  example *"How many lots are in each state, and how many were released per day this week?"*. It reads
  the schema, runs queries, and draws a report: a few words on what stands out, figures, charts and
  tables. Its charts are of twenty kinds, each for its question: bars (stacked, across), lines and
  areas, scatter and bubbles, pie, donut and funnel, heat map, box plot and histogram (drawn from the
  values themselves), radar, gauge, tree map and sunburst, sankey, waterfall, Pareto, candlesticks, and
  bars with lines on a second axis; with reference lines (a target, limits) and shaded bands. A chart
  draws only what its query answers, as whoever opens the report: no number is ever written into one.
  Point at a bar, a slice or a point for its value. No record is ever shown by its internal id, on a chart,
  in a table or in the copilot's words: each is named by its title, as you may read it ("—" where you may
  not). Ask again to change it
  (*"make the second chart a line, and add the lots on hold as a table"*). **New chat** clears the
  conversation.
- **It reads as you.** The copilot's queries are yours: the same rows and fields your forms show, the
  same limits as the Queries page. It cannot change a record or a design, and each query it runs and
  each report it draws is in the audit trail under your name.
- **Keep this report** saves what is drawn, under the title you give it. It is then listed under
  **Kept reports** and has its own address (`/r/…`), which you can send to someone or set as a
  [desktop's own page](#a-desktops-own-page).
- **Share** lets everyone with a role on AI report open it. **A report holds no data, only its queries:**
  they run when it is opened, as whoever opens it. A colleague who may not read a field or an object
  sees that block empty, or a line saying they may not read it, never your rows.
- **Pick a layout** (above the question box) to have the report drawn on a shape the plant designed:
  the *Daily report*, the *Shift report*. Under the pick you see what the layout is for and its blocks,
  each as wide as it will be. The copilot then fills exactly those blocks, in that order; it chooses the
  queries and the words, from what you may read. **None** leaves the arrangement to the copilot. You can
  change the pick between questions.
- **Find a layout from the navigator**: type its name in the search box (*"wirebond"*, *"daily"*). It is
  listed under **AI reports**, opens the AI Report page with that layout picked, and can be starred
  like a screen. Only published layouts are found, by people who may ask for a report (analysts).
- A kept report is a record: its changes are in its history, and its author can archive it from its
  record page (**Data → AI report**). One drawn on a layout says which, and keeps its shape even if the
  layout is changed later.
- **What the AI is sent:** the names of your objects' views and columns, and the rows of the queries the
  copilot runs for you (at most 40 a query). If your plant's data may not go to an AI provider, do not
  give out the analyst role, or run without an AI configured: kept reports still open.
- **Attach** (the paper clip above the question box, or paste a screenshot or a copied file into the
  box, or drop one on it; pasted text stays text) gives the copilot files with your question: a
  picture (a defect, a label, a whiteboard), a PDF (a spec, a certificate, a work instruction), a CSV
  file or an Excel workbook, up to five, a picture at most 5 MB, a document 10 MB. It sees pictures and
  reads PDFs and spreadsheets (the first rows of each sheet), and says what they show beside the plant's
  data (*"is the bond force in this photo's lot within the limits in this workbook?"*). Each file is kept
  by what it is, and shown in the conversation to open again. To show one in the report, ask: it adds a
  **media** block, a picture drawn or a document to open or save, with a caption. A model that cannot
  read PDFs (an in-house one) is told a PDF was attached.
- **Keep prompt** (under the question box) keeps what you asked, under a title, in **Kept prompts**,
  with its files (the box's, or those of what you asked last): **Given with it each time** in its form
  lists them, to add or take off; a prompt asked by the clock is given them every time.
  From there: **Put it in the box** to ask it again, as it is or changed first; **Change** its words,
  its layout or its schedule; **Generate now** to have it asked as you without opening a conversation;
  **Remove** it (the reports it generated stay).
- **Asked by the clock.** A kept prompt can be asked every day, Monday to Friday, once a week, or
  every few hours (at most once an hour), at the plant's time. It is asked as you, with your rights
  as they are then, and each report it draws is kept as yours, titled with the prompt's title and the
  date and time. If you leave, or may no longer query, it is not asked, and says why. At most ten of
  your prompts run by the clock.
- **The same report every time.** Asked again, the copilot arranges each report afresh (on a layout,
  it keeps the layout's blocks but writes new queries and words). When one of a prompt's reports is the
  one you want every time, press **Keep this report's queries** on the prompt: it is pinned to its last
  report. From then on each run, by you or by the clock, runs that report's queries again, as you, and
  keeps a new report with exactly its blocks, titles and charts, with that day's numbers. The prompt says
  which report it repeats. **Its words** choose what happens to the report's text:
  - **As written (no AI)**: the words stay as first written. No AI is asked, so it works even where none
    is configured. A sentence that quotes a number keeps that number, so write such reports' words to say
    what to look at, not what the numbers are.
  - **Written fresh by the copilot, each run**: the copilot rewrites only the words (and an AI assisted
    block's advice) from what that run's figures, charts and tables show. It changes no block and runs no
    query.

  If a block's query no longer works (a field was removed), that block says why in the new report, and the
  prompt says which block. **Ask the copilot each time** unpins it.
- **A layout from a report** (designers): on a kept report's page, **Make a layout from it** opens a new
  change in the Designer with a report layout of that report's blocks: their kinds, order, widths, titles
  and chart kinds, and what each is for, in words. Its queries do not go with it: on a layout, the copilot
  writes those for each report. A picture or file the report showed has no place in a layout. Review it on
  the layout's tabs (an AI assisted block needs its goal written), then submit it like any design: once it
  is approved, everyone can pick it.
- **Tags.** File a report under words of your own (*daily, wirebond*): **add tags** beside it in
  **Kept reports**, with commas between them. Every tag in use appears above the list as a filter:
  click one and only the reports with that tag are listed; click another to narrow further; **show
  all** clears it. A kept prompt names the tags of the reports it generates, so everything the clock
  produces is already filed: one asked by the clock must have at least one (its form marks the field
  **\***, and says so if it is empty). A scheduled prompt kept without tags before this says so in the
  list: change it to give it tags.
- **Ask about several reports.** Tick reports in **Kept reports** (or **Select all**), press **Ask the
  copilot about the selected**, and say what you want of them: a summary, what changed, what to do
  next. The copilot is handed each as you may read it now: its words as written, and today's numbers,
  because a report holds no data of its own. At most twelve at a time.

#### Designing a report layout

A **report layout** decides how an AI report looks, so that everyone asking for "the daily report" gets
the same page. It is designed in the **Designer**, on the **Report layouts** tab, and goes through
review and approval like a screen.

1. **New report layout**: a name (`daily_report`) and a label (*Daily report*), then **Start design**.
   It starts with four blocks you can change. **Copy** starts one from a live layout.
2. **General**: the label people pick it by, a description (shown under the pick), and **Guidance for
   the copilot**: words about the whole report. *"Cover the last 24 hours. Lead with what needs action.
   Name lots and tools by their labels."*
   **Type** makes the layout **an AI assisted line**: a report about one line that says which lots must
   be processed, and in which order, to meet the shift's goal. Choose it, then, right there:
   - **Records of**: the object your equipment is (*Equipment*).
   - **Which**: the equipment of the line. Type part of a name (*WB*), click what is found; or type a
     name in full and press Enter. Up to 50, listed as people call them (*WB-01*).
   - **The goal**: *"Meet this shift's output target on every work order running on the line; what is
     due first goes first."* If targets are records, say where.

   Everything the copilot reads for this report is kept to that equipment. **For another line, copy the
   layout** (**Copy** on the Report layouts tab): the copy starts with the same equipment and goal;
   change the equipment, and it goes through approval as its own layout (*Wirebond line 1*, *Wirebond
   line 2*).
3. **Blocks**, in reading order, at most 12. For each:
   - **Kind**: text (the copilot's words), a figure (one number), a chart, a table.
   - **Width**: a quarter, a third, half, or the whole row. Four quarter-width figures make a row of
     numbers; two half-width charts sit side by side. On a phone each takes more.
   - **Chart** (a chart block): one of the twenty kinds (the note under it says what each is for), or
     leave the choice to the copilot.
   - **Title**: kept as written on every report. Leave it empty and the copilot titles the block.
   - **What belongs here**: say it as you would to a colleague: what, over which period, in which
     order. *"Lots on hold: lot, hold reason, since when; longest first."* The copilot writes the query.
   - **An AI assisted line** is a block that advises instead of reporting: *which lots must this line
     process to meet the shift's goal?* Pick the **object** its records are of (your equipment), then
     **which** records make up the line: type to find them and click, or type a name in full and press
     Enter. They are listed by what people call them (*DB-01*), up to 50. Then write **the goal**:
     *"Meet this shift's output target on every work order running on the line; what is due first goes
     first."* If the targets are records, say where (*"targets are in Shift goal records"*). Give it
     the line's name as its title.
   - **copy** on a block puts a copy just below it. For a second line, copy the AI assisted line, change
     its title and swap its records. To give another area its own report, copy the whole layout
     (**Copy** on the Report layouts tab) and change the records there.
4. **Preview** sketches the page: each block where and as wide as it will be.
5. **Stewards**: the departments that approve changes to it. Then submit the change as usual.

Things to know:

- **A layout holds no query and no data.** It names no object or field, so it cannot show anyone
  anything: each report drawn on it is read with the rights of whoever asked or opens it.
- **The copilot must follow it.** A report with a block missing, added, out of order or of another kind
  is not drawn; the copilot is told what differs and draws it again. Widths and titles are the
  layout's, whatever the copilot proposes.
- **An AI assisted line advises; it does nothing.** The copilot reads what waits and what is done on
  the records you picked, as the person asking may read them, and writes what to process first and why,
  with the list in order. Nobody's lot is moved: acting on it is a transaction, as always. On a kept
  report the list is read again each time it is opened, but the advice is from when it was drawn: ask
  again for today's.
- **Changing a layout** does not change reports already kept: they keep the shape they were drawn with.
- The design copilot can draft a layout for you (*"a daily report layout: four figures, two charts, a
  table of lots on hold"*), in a change, like any design.

### Import and export in Excel

**Data → Import / export**, or **Export** above any list (§24).
- **Export** the models you tick. With **Include the records they refer to**, a lot export also has
  a work order tab with the orders those lots refer to. References are written as the other record's
  key (the order number). The `_about` tab lists each field and its type.
- **Import** a workbook: each tab named after its model, the first row naming the fields; several
  models may come in one file. You first see a **preview** (to create, to update, unchanged, refused,
  and why), and nothing changes until you **Apply**. Applying the same file twice changes nothing twice.
  A workbook is read up to 100 000 rows a tab and Excel's own last column, and a file that is larger
  inside than it looks (or damaged) is refused with the reason, before anything is read from it.
- **An import never quietly undoes someone else's work.** Each exported row carries its record's
  `row_version`. If someone changed the record after your export, that row is refused ("changed since
  this file was exported"): export again and redo your edit, or empty the row's `row_version` cell if
  you mean to write over their change.
- **If a model changed since the export** (a new definition version), the preview says so and lists
  what changed in its fields; **Apply** asks you to confirm. Check that the file's values still mean
  what they meant, a unit in particular.
- **What an import may do is part of each model's design** (its General tab, **Excel import and
  export**): may it create records, may it update (override) existing ones, and which field names a
  record. Every row is checked like a form: your rights, the model's rules, the audit trail.

### The whole model to another installation

**Designer → Export or import the whole model** carries a model from one installation to another as
one file, without copying the database.

- **Export.** Every published design goes into the file: objects, rules, services and connections,
  transactions, screens, flow templates, report layouts, and the roles departments hold. The list
  shows each object with how many records it holds: leave it ticked and it goes **with its records**,
  untick it and it goes **empty** (its design only). You export what you may read: an object you hold
  no role on, or whose design forbids export, goes empty and says why. Secrets, people, earlier
  versions and the audit trail are never in the file.
- **Import.** Choose the file on the other installation. It is checked first and nothing changes:
  you see how many designs are new, changed or the same as live, anything to put right, and what
  that server lacks (a connection's secret, a suite). **Start a change from it** makes one change
  request with every design that is new or different; it is reviewed and approved there like any
  other. Nothing that is live there and not in the file is touched.
- **Its records.** Once that change has executed, choose the file again and **Check its records**,
  then **Load**. Each record is written as you, checked like a form: your rights, the object's rules,
  the audit trail. An object's records load only if its design lets an import create records (its
  General tab, **Excel import and export**). Loading the same file twice adds nothing.
- **What to expect.** Every record arrives in its object's first state: a lot that was running at the
  source arrives as a new lot. History does not travel: each design starts at version 1 and each
  record's history at its import; the change's audit entry says which file and site it came from.
  A scenario that picked a record of the source plant carries a copy of that record instead.

## 14. Designing with an AI

The AI drafts and assists; **it never reviews or approves**, the copilot never submits, and neither
ever sees a secret's value (§16).

- **✦ Copilot** (a tab on every object, service and connection): ask in words ("add a batch
  reference field that quality fills in while the lot is on hold"). It reads the model, drafts into
  your change, writes scripts with their test cases, dry-runs and validates them, as you, with your
  rights. What it drafted is marked **Drafted with AI** for your reviewers. You check and submit.
  The conversation is kept with the change: come back any time (another day, after a restart) and
  carry on where you left off. **New conversation** deletes it, after asking. **Attach** (or paste, or
  drop, into the box) gives it what
  you design from: a photo of a paper form, a drawing, a work instruction as a PDF, a list of values as
  a CSV file or workbook; it says what it took from each, and designs only through your change, as
  always. (A plan's input screen can ask a person for a file or a picture too: inputs of type `file`
  or `image`, kept with the run.)
  It works on the change it was opened on and no other, whatever it reads there. Its saves build on
  the draft as it last read it: if a co-designer saved meanwhile, it reads theirs first rather than
  writing over it. A dry run it makes reads with your rights only: for a service that runs as a
  service role or as another caller, dry-run it yourself. There is a ceiling on messages (30 an hour
  for one person); past it, it asks you to come back later.
- **AI access** (designer home): **Issue token** lets an outside AI (Claude Code, or another) work in
  the designer as you over the REST API (`/ai/v1`, described by its OpenAPI). Choose its scopes:
  `design:read`, `design:draft`, and `design:submit` if it may submit for you (the change's history
  then says the submit came through that token). There is no scope to review or approve. **Revoke**
  a token at any time; a token also stops working the moment the designer is no longer shared with
  you. An AI that saves a draft should send the `draft_rev` it read (`seen`): a save built on a draft
  someone has changed since is then refused instead of undoing their work.

## 15. What your design means for the people using it

- **Live screens.** Lists and forms follow every change as it happens, whoever made it. A screen
  that is not current says so.
- **Copy from any list.** Pointing at a cell of any list (an object's, a screen's table, a query's
  result) shows a small copy button at its right edge: one click puts the value (a lot number, a
  quantity) on the clipboard, and it shows a tick. Cells being edited, and empty ones, have none.
- **Rules as they type.** Your rule pipe runs in the form on every keystroke, as advice, and again on
  the server when they save, which decides. The message they read is the one your script threw.
  The advice never holds the form up: a rule that takes more than a few seconds in the browser, or
  a browser too old to run rules beside the page (Firefox before 114), is skipped there, and the
  person reads the rule's words when they save.
- **Why?** Anything they cannot change or do has a **Why?** that explains it from your policies,
  states and rules. Write **hints** so it also says what to do instead.
- **Changes that wait for approval.** Where your design says so (Stewards, Approval of record
  changes), the fields concerned are tagged *needs approval* on the form. As soon as someone changes
  one, the form sums up every change it would send (as it is → as edited), who approves it, and asks
  why; **Save** becomes **Submit for approval**. Once they are sure, they submit, and the change is
  sent to the stewards instead of being written; the
  record shows it in a banner (as it is → as asked, who has signed, who is awaited) until it is
  approved and applied, rejected (with why) or withdrawn. If the record changes meanwhile, the
  approved change is void, not applied, and is asked again. Approvers sign on the record or on
  **Approvals** (*Changes to records*); a new record's request has a page of its own.
- **Archived records** leave the lists (**Show archived** brings them back), and are read-only until
  someone allowed to restores them.
- **When the database is unavailable,** nothing can be saved: a banner says so, Save is disabled,
  and what they typed stays on screen. If a save was interrupted and its outcome is unknown, they
  press **Send again**: the same change is never saved twice.
- **Everything is audited:** who changed what, when, and which rules ran, including refused
  attempts and what services did on their behalf.
- **A new version loads by itself.** When the server is updated, open screens reload on their own,
  straight away if nothing is being edited; otherwise a banner says a new version is ready, and it
  loads once they save or discard. Tablets and phones can **install** OpenCore MES as an app (on HTTPS),
  and show a page of its own while the server cannot be reached, coming back by itself.

## 16. Quick reference

**Rule script context:** `event` (`kind`, `object`, `action`, `changed`, `prev`, `source`), `user`,
`record`, `data`, `now`, `lookup(object, id or title)` (backend only).

**Service script context:** `service`, `input`, `event`, `user`, `now`, `output`,
`records.get/list/create/update/action/archive/restore`, `http(connection, request)`.

**What a service may do with an object (`uses.objects`):** `read`, `create`, `update`, `action`,
`archive` (archiving and restoring).

**Record events a trigger may name:** `create`, `update`, `archive`, `restore`,
`transition:<action>`.

**Schedule:**
```json
{ "schedule": { "every": { "minutes": 15 } | { "hours": 2 }, "at": ["06:00"],
                "between": ["06:00", "22:00"], "days": ["mon", "…"], "tz": "Europe/Berlin" },
  "missed": "last" | "none" | "all", "overlap": "skip" | "queue" }
```
(`every` or `at`, not both; `between` only with `every`.) Or a kind of schedule an installed suite adds:
`{ "schedule": { "from": "<suite>.<kind>", "<setting>": value, "tz": "…" }, "missed": …, "overlap": … }`,
with no `every`, `at`, `between` or `days`.

**Screen:**
```json
{ "name", "label", "params": { "machine": { "type": "ref", "to": "machine", "widget": "scan" } },
  "blocks": [ { "block": "table", "object": "lot", "where": { "machine": { "param": "machine" }, "state": ["at_machine"] },
                "columns": ["lot_no", "qty"], "rowActions": ["track_in"], "width": 6 },
              { "block": "kpi", "object": "lot", "where": {}, "measure": { "sum": "scrap_qty" }, "since": "today", "label": "scrapped" } ],
  "callers": { "groups": [ … ] }, "stewards": [ … ] }
```
Blocks: `record` (of, show), `table` (where, columns, sort, limit, rowActions), `kpi` (where, measure,
since, label), `breakdown` (where, by, measure), `chart` (query, chart, x, y, series, … as a report's chart has them), `transaction` (name, fills), `button` (opens, with),
`floor` (object, status, picture, colours, image, places), `text`, and a kind an installed suite adds
(`"<suite>.<kind>"`). Every block may have `title`, `width`, `tab`, `showWhen`, `enableWhen` and
`disabledBecause`.

**Transaction:**
```json
{ "name", "label", "inputs": { "lot": { "type": "ref", "to": "lot", "required": true },
                              "machine": { "type": "ref", "to": "machine", "from": "lot.machine" } },
  "form": { "sections": [ … ] }, "appearsOn": { "object": "lot", "states": ["at_machine"], "fills": "lot" },
  "require": [{ "that": <condition>, "message": "…", "field": "machine" }],
  "steps": [{ "on": "lot", "set": { "field": <value> }, "action": "track_in", "when": <condition> }],
  "confirm": true, "signature": { "meaning": "Performed" }, "maximize": "toggle",
  "callers": { "groups": [ … ] }, "stewards": [ … ] }
```
A policy that applies only through transactions: `"via": ["move_in", …]`.

**Form layout entry:**
```json
{ "field": "reason", "width": 6, "widget": "textarea", "rows": 4, "help": "…", "placeholder": "…",
  "show": { "eq": [{ "data": "disposition" }, "reject"] }, "enable": { "ne": [{ "record": "state" }, "released"] } }
```
A form is `{ "sections": [ { "label", "collapsible", "collapsed", "fields": [ … ] } ] }` or
`{ "tabs": [ { "label", "sections": [ … ] } ] }`; a bare field name is an entry with its defaults.

**Common refusals and what they mean:**

| Message | Fix |
|---|---|
| "It changes qty, which its binding does not declare (writes)" (dry run) | Add the field to the pipe entry's **writes** |
| "lot_check_qty.js has no test cases: a new or changed script carries its evidence." (fitness) | Add test cases to the script |
| "service … may not update lot: add it to the service's uses.objects" | Tick the operation on **Reaches** |
| "… is not allowed on connection erp" | Add the method and path to the connection's **Allowed requests** |
| "A record event or a schedule has no caller" | Set **Identity** to its service role or a user |
| "no live node has this tag" (monitor) | Ask IT to start a node with that tag (`NODE_TAGS`), or clear **Run on nodes tagged** |
| "It never runs: the window leaves no time for it" | Widen **Only between**, or shorten **Every** |

**For IT (starting the servers):** `INSTANCE` (the node's name), `NODE_TAGS` (its tags),
`SCHEDULER=0` (it plans no schedules), `OUTBOX=0` (it runs no triggers), `PLANT_TZ` (the plant's
time zone), `MES_SECRET_<NAME>` (a connection's secret), `EVENT_LOG_DIR` (where its event log is
written).

---

## 17. Expressions: conditions and values

An **expression** is how a design says *when* something holds, or *what* a value is, without writing
code: a policy's condition, a field shown only when another has a value, a transaction's checks and
what its steps set, a screen's filter, a pop-up's trigger, a flow's branch. It is written as **JSON**,
and the designer checks it as you type (a box that does not read right turns red, and the problem says
what it read that it may not). It never runs code: the platform walks it.

```json
{"in": [{"lookup": "carrier.kind"}, ["magazine", "carrier"]]}
```

reads: *the kind of the carrier entered is magazine or carrier*. `in` is the operator; `{"lookup":
"carrier.kind"}` reads a value; `["magazine", "carrier"]` is a list of values. Every expression is
built from those three things.

### Values you write

| Format | Write it as | Notes |
|---|---|---|
| Text | `"released"` | In double quotes. A choice field's value is its stored name (`"on_hold"`, not "On hold"). Case matters. |
| Number | `25`, `2.5`, `-3` | No quotes: `"5"` is text and is not equal to `5`. |
| Yes / no | `true`, `false` | No quotes. |
| Empty | `null` | A field with no value. Test it with `is_null`. |
| List | `["magazine", "carrier"]` | For `in`, and what `contains` looks in. |
| Date | `"2026-10-03"` | A date field holds its day as text, year first, so `lt`, `gt` compare dates correctly. |
| Moment | `"2026-10-03T06:30:00Z"` | Stored in UTC, as written; shown in the plant's time zone. |
| A record | its id | A reference field (or input) holds the id of the record it names: compare it with another reference, or read the record's fields with `lookup`. |
| Several choices | a list | A field taking several choices holds a list: ask with `contains`. |

There is no "now" or "today" in an expression: a condition gives the same answer whenever it is
checked. Time belongs in schedules, waits and analytics.

### Values you read

A **reference** is `{ "<where from>": "<what>" }`. What it can read depends on where the expression
is written; the designer says so if you read from somewhere it cannot.

| Reference | Reads | Example |
|---|---|---|
| `record` | The record as it is saved: a field, or `state`, `type`, `id` | `{"record": "state"}` |
| `data` | The form as it is being filled in, before it is saved | `{"data": "disposition"}` |
| `user` | The person: `id`; in a policy, also `roles` | `{"user": "id"}` |
| `person` | A field of the built-in Person record of who runs it (a badge, certifications) | `{"person": "semi_certified_for"}` |
| `event` | In a rule's entry: `kind`, `action`, `changed` (the fields being changed) | `{"event": "kind"}` |
| `input` | What was entered in a transaction or an input flow; a reference input is its record's id | `{"input": "good_qty"}` |
| `lookup` | A field (or `state`) of the record an input names, one level: `<input>.<field>` | `{"lookup": "machine.capacity"}` |
| `row` | Inside `some` / `every`, or a step run once per row: a field of one row of a table input | `{"row": "value"}` |
| `param` | What a screen was opened with (its machine) | `{"param": "machine"}` |
| `node` | A setting of the route step a transaction runs at (a sequence's settings) | `{"node": "lsl"}` |
| `context` | A flow's run: its records' fields (`lot.state`) and its values | `{"context": "lot.scrap_qty"}` |

A path may go one step into a record (`lookup: "lot.product"` gives the product's id), not through it
to the product's own fields: to read those, add an input filled in from it (`from: "lot.product"`).

**Where you write it, and what it reads:**

| Where | Reads |
|---|---|
| A policy's condition (Roles & policies) | `record`, `user` |
| A field's Shown when, Enabled when, Required when (Layout) | `data`, `record`, `user` |
| A transaction's Appears on … only when | `record` |
| A rule's entry, run only when (Rules) | `event`, `data`, `record` |
| A transaction's checks, a step's values and its only when; an input's required when | `input`, `lookup`, `row`, `node`, `user`, `person`, and `count`; required when reads `data` |
| A screen's blocks (which records, which record, what a form is filled with) | `param`, `user` |
| A pop-up's while and with | `input`, `lookup`, `param`, `user`, and `count` |
| A route's or a plan's conditions (start, wires, ends early) | `context` |
| An input flow's wires and fills | `input`, `lookup`, `param`, `user` |

### Operators

| Operator | Means | Example |
|---|---|---|
| `eq`, `ne` | equal, not equal | `{"eq": [{"record": "state"}, "on_hold"]}` |
| `lt`, `le`, `gt`, `ge` | less than, at most, more than, at least (numbers; texts and dates in order) | `{"gt": [{"input": "scrap_qty"}, 0]}` |
| `in` | the value is one of a list | `{"in": [{"lookup": "carrier.kind"}, ["magazine", "carrier"]]}` |
| `contains` | a list holds the value (the other way round from `in`) | `{"contains": [{"person": "semi_certified_for"}, {"lookup": "equipment.process"}]}` |
| `is_null` | the value is empty | `{"is_null": {"input": "reason"}}` |
| `all` | every part holds (and) | `{"all": [{"eq": [{"record": "state"}, "on_hold"]}, {"ne": [{"data": "disposition"}, null]}]}` |
| `any` | at least one part holds (or) | `{"any": [{"eq": [{"record": "type"}, "wip"]}, {"eq": [{"record": "type"}, "finished"]}]}` |
| `not` | the part does not hold | `{"not": {"in": [{"record": "state"}, ["shipped", "scrapped"]]}}` |
| `add`, `sub` | sum, difference; an empty value counts as 0 | `{"add": [{"input": "good_qty"}, {"input": "reject_qty"}]}` |
| `mul`, `div` | product, quotient; an empty value, or a division by 0, gives no value | `{"div": [{"input": "good_qty"}, {"lookup": "lot.qty"}]}` |
| `some`, `every` | some, or every, row of a table input holds the condition, read with `row` | `{"every": [{"input": "readings"}, {"le": [{"row": "value"}, 36]}]}` |
| `count` | how many records in use match: their fields equal the values given (a list: any of them) | `{"count": {"object": "lot", "where": {"machine": {"input": "machine"}, "state": ["at_machine", "processing"]}}}` |

`eq`, `ne`, `lt`, `le`, `gt`, `ge` take two parts, `in` and `contains` two (the value and the list,
the list and the value), `all` and `any` a list of parts, `not` and `is_null` one. Parts may be
values, references or other operators, nested as deep as needed.

### How it is read

- **Exactly equal.** `eq` compares as written: `"5"` and `5` are not equal; `"On hold"` and
  `"on_hold"` are not either.
- **A condition holds only when it is `true`**; `not` of anything that is not `true` is true.
- **Empty values.** A field with no value is empty: it is not `eq` to any value, but in `lt`, `le`,
  `gt`, `ge` an empty number may count as 0. Where a field may be empty, ask first:
  `{"all": [{"not": {"is_null": {"input": "temp"}}}, {"lt": [{"input": "temp"}, 80]}]}`. `is_null` is
  true for no value; an empty text (`""`) is a value: to take both,
  `{"any": [{"is_null": {"data": "note"}}, {"eq": [{"data": "note"}, ""]}]}`.
- **Sums.** `add` and `sub` count an empty value as 0 (a reject quantity left empty); `mul` and `div`
  give no value then, and `div` by 0 gives no value rather than an error (a yield on nothing is not
  0 %). Results are rounded to 9 decimals.
- **A count** counts in the database the object's records in use (not archived) whose fields equal
  the values given (a list: any of them).
- **Why?** On a record, Why? shows each condition that decided, the values it read, and which part
  did not hold.

### Patterns

| What you want | Expression |
|---|---|
| A field only on hold | `{"eq": [{"record": "state"}, "on_hold"]}` |
| A reason only when rejecting | `{"eq": [{"data": "disposition"}, "reject"]}` |
| The machine is not full | `{"lt": [{"count": {"object": "lot", "where": {"machine": {"input": "machine"}, "state": ["at_machine", "processing"]}}}, {"lookup": "machine.capacity"}]}` |
| Good and rejected add up to the lot | `{"eq": [{"add": [{"input": "good_qty"}, {"input": "reject_qty"}]}, {"lookup": "lot.qty"}]}` |
| Every reading within limits | `{"every": [{"input": "readings"}, {"all": [{"ge": [{"row": "value"}, {"node": "lsl"}]}, {"le": [{"row": "value"}, {"node": "usl"}]}]}]}` |
| The operator is certified for this machine's process | `{"contains": [{"person": "semi_certified_for"}, {"lookup": "equipment.process"}]}` |
| The scanned lot is on hold (an input flow's wire) | `{"eq": [{"lookup": "lot.state"}, "on_hold"]}` |

**With the copilot.** Ask it in words ("only when the lot is on hold and the disposition is reject"):
it writes the expression into the draft, and the designer checks it like any other. The AI API's
contract lists the same operators and references.
