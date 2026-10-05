# `equipment-adapter` 1.0

An **equipment adapter** holds the link to a machine in one protocol (SECS/GEM over HSMS, OPC UA,
MQTT, …) and speaks to the rest of OpenCore MES in one language only: the **tool type's names**. A
tool type names what the MES reads from and sends to every machine of a kind (its variables with their
units or named values, its events and what each carries, its commands and their parameters). A
machine's **interface** says which adapter holds its link and maps that machine's own codes (a VID, an
OPC UA node id, an MQTT topic) onto those names. Screens, transactions and scripts never know the
protocol: a machine over HSMS and another of the same tool type over OPC UA open the same screen and
run the same transaction.

The adapter is loaded by the process that holds machine links (an equipment node). This document is
the contract between the two; `schema.json` is the same contract for a machine to read, and `kit.mjs`
checks an adapter against it.

## The module

An adapter is an ES module whose default export is:

| Member | What |
| --- | --- |
| `name` | The name an interface gives in `adapter` (`"hsms"`, `"opc-ua"`, `"mqtt"`): letters, digits and `-` |
| `label` | What a person reads ("SECS/GEM over HSMS") |
| `contract` | The version of this contract it implements, `"1.0"`. A loader refuses a major version it does not provide, saying so |
| `serves` | What it does beyond reading variables and reporting events and alarms, which every adapter does: any of `"command"`, `"recipes"`, `"gem300"` |
| `check(mapping, { toolType })` | Its own part of an interface, checked: how each of the tool's ids is written, its protocol fields, and what it cannot serve (recipes on an adapter that has none). Returns a list of problems in words a reviewer reads, empty when there is none. **Pure**: no I/O, no `node:` imports, so a designer in a browser runs the same check as the server |
| `connect(machine, hooks)` | Opens the link and returns a **session** (or a promise of one). It must not wait for the tool: a tool that is off is a link that is not communicating, said through `hooks.emit`, and retried |

## `machine`

```js
{
  id, title,                         // the machine record's id and what people call it
  address: { host, port, deviceId }, // from its record; deviceId only where the protocol has one
  mapping,                           // its interface: variables, events, alarms, commands, recipes,
                                     // modules, and the adapter's own section (e.g. "opcua", "mqtt")
  toolType,                          // its tool type
  modules: [{ id, title, module, mapping, toolType }],
                                     // the machines that ride on its link (a cluster tool's chambers):
                                     // `module` is the tool's id for each, `mapping` its own codes
  secret(name),                      // a credential the node holds (a password, a key), never in a design
  dir,                               // a directory the adapter may keep files in (its certificates)
}
```

Every code an interface maps belongs to one place, the machine itself or one module, so the adapter
always knows whose an event, an alarm or a variable is.

## What it reports: `hooks.emit(item)`

| `kind` | Item | When |
| --- | --- | --- |
| `state` | `{ communicating, detail }` | Each time the link changes: connected and set up (`true`), lost, refused, retrying (`false`). `detail` says what, in words ("TLS handshake refused by 10.20.4.7:4840") |
| `event` | `{ code, name, label?, values, id?, module? }` | An event the mapping names: `name` the tool type's event it is (`label` the mapping's own name for it), `values` what its report carries, by the tool type's names, in the tool type's units. An event the mapping does not name: `{ code, name, values: {}, unknown: true }` |
| `alarm` | `{ code, name, set, text?, category?, module? }` | An alarm set (`set: true`) or cleared. One the mapping does not name carries `unknown: true` |
| `alarms` | `{ active: [{ code, text?, category? }], module? }` | Optional: the alarms set now, read when the link is set up, so what changed while nobody listened is known |

`module` is the tool's id for the module an item is about, absent for the machine itself. `id`, when
the protocol has one, identifies the occurrence: **the same occurrence delivered again** (a tool's
spool, an MQTT QoS 1 redelivery) **carries the same `id`**, and two occurrences never share one, so
whoever writes it down writes it once.

`hooks.log` has `info`, `warn` and `error`.

## The session

| Call | Answer |
| --- | --- |
| `status(names, { module? })` | `{ values: { Name: value }, at }`: each name asked that the mapping provides, in the tool type's units; `at` an ISO time |
| `command(name, params, { module? })` | `{ accepted: true, later? }`; `later` when the tool accepted and will finish later. Parameters by the tool type's names. **A refusal throws** an error with `refused: true` and the tool's reason in its message |
| `recipes` | Only with `serves` `"recipes"`: `list()` → `[ppid]`; `read(ppid)` → `{ body, binary? }` or `{ missing: true }`; `send(ppid, body, { binary, replace })` → `{ sent: true }` |
| `gem300` | Only with `serves` `"gem300"` (SEMI E87, E40, E94, E90): `carrier(args)`, `job(args)`, `access(args)`, `reserve(args)` |
| `stop()` | Closes the link; resolves once nothing more will be emitted |

A call while the link is not communicating throws, saying why ("ETCH-07 is not communicating: HSMS
not selected"), with `notCommunicating: true`.

## Values

An interface converts what the tool reports into the tool type's units with an expression over
`value` (`add`, `sub`, `mul`, `div`, `round`), and names a coded value from a table (`values: { "3":
"PROCESSING" }`). An adapter applies both before anything leaves it; nothing above it ever sees a
vendor's units or codes.

## The rules

1. **Names only.** Above the adapter there are tool-type names and nothing else: no VID, node id,
   topic or protocol term in what it emits or answers.
2. **It reconnects by itself** until `stop()`, and says each change of the link (`state`).
3. **Nothing after `stop()`.** Once `stop()` resolves, the adapter emits nothing.
4. **In order.** Events and alarms of one machine are emitted in the order the tool sent them.
5. **A command is sent once.** An adapter never retries a command that may have reached the tool:
   a command cannot be taken back, and the caller decides.
6. **Only the address it is given.** It connects to `machine.address` and nowhere else; the node has
   already checked that address is on the tool network.
7. **Credentials through `secret()` only**, never from a design, a mapping or a log line.
8. **It refuses what it cannot serve**, at `check`, in words, rather than failing on the floor.

## The conformance kit

```bash
node docs/contracts/equipment-adapter/kit.mjs path/to/fixture.mjs [--json]
```

The kit drives an adapter against a scripted tool through this contract only. A **fixture** is a
module whose default export gives the adapter and a tool speaking its protocol:

```js
export default {
  adapter,                       // the adapter module's default export
  async tool() {                 // a scripted tool, started; answers:
    return {
      address, mapping,          // where it listens, and an interface of the kit's tool type for it
      set(name, raw),            // a variable of the kit's tool type, as the tool reports it
      raise(event, raw),         // the tool raises an event of the kit's tool type
      alarm(name, set),          // the tool sets or clears Overheat
      refuse(command, words),    // the tool refuses the next command of that name
      commands(),                // what it received: [{ name, params }], by the kit's names
      drop(), restore(),         // the link goes down; it comes back
      replay?(),                 // the last event delivered again, as a redelivery (optional)
      stop(),
    };
  },
  badMappings: [{ why, mapping }], // mappings the adapter must refuse at check
};
```

The kit's tool type (`KIT_TOOL_TYPE` in `kit.mjs`): `Temperature` in degC (the tool reports kelvin,
so the mapping must convert), `State` with the values IDLE and RUNNING (the tool reports the codes 1
and 2), `Lot`;
the events `Started` and `Ended`, each carrying `Lot`; the commands `START` (`Lot`) and `STOP`; the
alarm `Overheat`. It checks, in order: the module's members; that `check` accepts the fixture's
mapping and refuses each bad one; connect and the first `state`; `status` converted and named; events
in order with their values and distinct ids; an alarm set and cleared; commands accepted with their
parameters, refused with the tool's words, and an unknown one never sent; the link dropped and back
by itself, `status` working again; a redelivery with the same id (when the fixture can replay); and
nothing after `stop()`. It prints each step and exits non-zero when one fails; `--json` prints
`{ contract, adapter, ok, steps: [{ name, ok, skipped?, detail }] }` for a program or an AI to read.

`reference/` holds a reference adapter over an in-memory tool and its fixture: the smallest adapter
that passes, and the kit's own test.

## Versions

See `CHANGELOG.md`. 1.0 is the first.
