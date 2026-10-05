# Live area: notes for the contract

Files changed: `src/live-protocol.js`, `src/server/service-dispatcher.js`, `src/server/bus/pg-outbox.js`,
`src/server/bus/mysql-outbox.js`, `src/server/db.js`, `src/server/process.js`.
Tests: `tests/framework/live.test.mjs` (each finding's test is named after it).

What `src/README.md` should say differently, by section.

## `#### live-protocol.js` (F17)

Replace the `canAddress` bullet's parenthesis with:

> - `canAddress(value)` says whether every own key of an object can be one segment of a state path
>   (no `.`, no `__proto__`, and not the empty key, whose path would be its parent's: at the top, a
>   patch for it replaced or deleted the whole result); an object that fails it is sent by `diff` and
>   written by `assign` whole. `diff(previous, next)` is the leaf patch the server sends; a key is
>   deleted when `next` has no OWN key by that name, so a removed field named `constructor` or
>   `toString` is deleted like any other.

Security defaults and invariants, "Services and live queries", the `diff` line becomes:

> - `diff` treats a dotted, `__proto__` or empty key as data, a `Date` as a leaf, and deletes a
>   removed key whatever its name. `tests/framework/juris-hardening.test.mjs`,
>   `tests/framework/live.test.mjs`.

## `#### server/service-dispatcher.js`

In the **`live`** bullet, after the list of options, add:

> Every number among them is checked at construction as `retryMs` is, and a `TypeError` names the
> one that is not: `keepAlive` a whole number of milliseconds from 1 (0 wrote a keep-alive every
> millisecond), `graceMs` and `recheckMs` whole numbers from 0, `maxKeysPerClient`, `maxGroups` and
> `maxBufferBytes` whole numbers from 1 or `Infinity`, and `maxStreamsPerCaller`,
> `maxGroupsPerCaller` and `maxPostsPerMinute` whole numbers from 0 (0 is no ceiling, as it always
> was) or `Infinity`. A string (`maxGroups: "5"`) used to compare as no ceiling. `null` still means
> the default.

In the **`live.strictQueries`** bullet, "every name an array-valued `touches` entry lists" becomes:

> every query an array-valued `touches` entry names (the name of each target: `"q"`, `{ name: "q",
> args }` and `{ name: "q", where }` all make `q` subscribable; `ALL` makes nothing so)

(Before, an object target went into the set as the object, so `q` was not subscribable through it.)

Replace "`handler.invalidateAccess(who)` re-asks `authorize` about a caller's subscriptions at once."
with (F16):

> `handler.invalidateAccess(who)` re-asks `authorize` about a caller's subscriptions at once, whatever
> `recheckMs` is: `recheckMs` paces only the re-check before a patch, and 0 turns that one off. (With
> `recheckMs: 0`, invalidateAccess used to ask nothing, and a revocation silently did nothing.)

Add to the **Calls** bullet, after "A refusal answers …" (the status clamp):

> A refusal's status is the `status` its error carries when that is an HTTP error status Node knows
> (a 4xx or 5xx in `http.STATUS_CODES`), 400 when it carries none, and 500 for anything else (a 999,
> a 302, a string): a thrown status used to go out as given.

and (F19):

> A service that succeeded runs its `touches` whatever becomes of its answer: a result JSON cannot
> carry (a BigInt, a cycle) is answered as a refusal, and the change it made is still invalidated.

In the **`forms`** bullet, after "(413)", add:

> ; an upload that ends before its body does (a tab closed mid-send) runs nothing and is answered 400
> if anyone is left to answer (it used to reject out of the dispatcher, into the host's 500)

Add a bullet about the stream (F13, F14, F15):

> - **One stream per client id.** A stream reopened with its `?client=<id>` replaces the one that id
>   had, which is ended (it used to stay open, uncounted by `maxStreamsPerCaller`, with no
>   keep-alive). A stream request that goes away while `identify` runs makes no client and is
>   answered nothing (its client used to stay "connected" for good and hold a place under the
>   ceiling). A subscribe whose client is dropped (its grace period ended) while `authorize` runs is
>   answered 403 `live.client-unknown`, and joins no group.

Add to the **`live`** paragraph about the bus (F18), and to "Three things … an app has to know" if
that is where bus behaviour lives:

> A mutation's invalidation publishes to the bus beside its local re-runs, not before them: a slow or
> hung pool no longer delays this instance's own updates (a failed publish still goes to `onError`,
> `live.bus.publish`, and `handler.invalidate` still resolves once both are done). What arrives off
> the bus is applied without the bus waiting for the re-runs (a failure goes to `onError`,
> `live.bus.apply`), so one slow query does not stall every change behind it. A bus's `read()`/`poll()`
> therefore resolves once the re-runs are started, not finished.

And (F19, refresh path):

> A live query whose result JSON cannot carry fails like any other failed re-run: `onError(error,
> name, args)`, the subscribers told `{ key, error }`, and nothing kept to answer the next subscriber
> from. It used to be an unhandled rejection.

`options.onError`'s description in the source already covers "a live query fails to re-run".

## `#### server/process.js` (F26)

Signature: `startProcess({ workers, liveQueries, allow, env, workerIdEnv, refusal, exit, onWorkerExit,
log, backoff, cluster, timers })`.

Replace the second bullet's last clause with:

> a worker that exits unasked (not cleanly, not on SIGTERM or SIGINT) is replaced with the same `env`
> and the id "r", after `onWorkerExit(worker, code, signal)`, and after a wait: `backoff: { minMs =
> 1000, maxMs = 30000, resetAfterMs = 30000 }`, the wait doubling from `minMs` to `maxMs` while
> workers keep dying, and starting over once a worker that ran at least `resetAfterMs` dies. A
> worker that cannot start (the database is down) used to be replaced at once, for ever: a fork loop.
> A `backoff` value that is not a whole number of milliseconds is refused (`TypeError`).

Last bullet: "`log` and `cluster` are injectable for a test" becomes "`log`, `cluster` and `timers`
(`{ setTimeout, now }`) are injectable for a test".

## `#### server/db.js` (F26)

Replace "and releases the connection either way" with:

> and releases the connection either way, unless the ROLLBACK itself failed: then the connection may
> still be inside the transaction, so it is destroyed rather than pooled (pg: `client.release(error)`;
> mysql2 and mariadb: `conn.destroy()`), and the pool opens a new one.

## `#### server/bus/pg-outbox.js` (F20)

Signature gains `reconnectMs` and `reconnectMaxMs`. Add a bullet:

> - The LISTEN connection is the bus's own. When it is lost, the bus opens it again after
>   `reconnectMs` (500), and keeps trying, the wait doubling up to `reconnectMaxMs` (30000), until it
>   is back or the bus is stopped, then reads at once (it used to try once, so a database that took
>   longer to come back left the bus on the sweep for good). A client whose `LISTEN` fails is
>   released with the error, which destroys it, instead of staying checked out. A `start()` that fails
>   rejects and leaves the bus stopped, so calling it again tries again (it used to do nothing). Each
>   failed attempt counts in `stats().errors` and `lastErrorAt`, its words to `onError`.

## `#### server/bus/mysql-outbox.js`

Add:

> A full batch is followed by the next poll only once it has been delivered, so no two polls run at
> once and `stop()` resolves with none running (the next one used to be let in while the first still
> awaited delivery).

## Security defaults and invariants, "Services and live queries"

Add:

> - One socket per client id; a stream abandoned during `identify`, or a client dropped during
>   `authorize`, leaves nothing behind; `invalidateAccess` always asks. `tests/framework/live.test.mjs`.

## Not done / for other owners

- None of the listed findings in this area is left open.
- The unsendable-result refusal still answers 400 (the refusal's default), as before; a 500 would
  arguably describe it better, but that is a change of answer, not of the fix asked for.
