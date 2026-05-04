# Critical review of the save/publish race fix

This document records the critical review of the fixed code in `app/server.js`.
The fix addresses the race condition where `/publish` could read `currentDraft`
before an in-flight `/draft` had committed. The review below identifies failure
modes the fix does not address, edge cases that are missed, assumptions baked
into the design, and cleaner alternatives.

---

## Failure modes the fix does not address

**1. Head-of-line blocking on `/publish`.**
`/publish` awaits `pendingSave`, which is the *tail* of the entire save chain.
If many `/draft`s are queued, publish waits for *all* of them — not just the
latest. Why does publish need to wait for save #7 if save #12 is already
chained?

**2. Unbounded promise chain growth.**
Every `/draft` does `pendingSave = pendingSave.catch(...).then(...)`. There is
no trimming. Under load, the chain grows forever. The microtask queue pressure
and memory footprint scale with traffic. Nothing collapses or coalesces saves.

**3. `/draft` HTTP latency = `SAVE_COMMIT_DELAY_MS` × queue depth.**
The response handler is attached *after* the commit. With 50 queued saves and
`SAVE_COMMIT_DELAY_MS=200`, save #50 waits 10 seconds for an HTTP `200`. That
is not acceptable in production.

**4. `/publish` vs `/reset` is not synchronized.**
`/reset` is fully synchronous: bumps epoch, clears state, replaces
`pendingSave`. `/publish` is async. There is no lock between them. Concrete
sequence that is currently undefined:

- `/publish` awaits `pendingSave` (resolves immediately when chain is empty).
- Between the `await` resolving and the next line, `/reset` runs and clears
  `currentDraft`.
- `/publish` then reads `currentDraft = ''` and assigns it as published.

The fix focuses only on `/draft` vs `/publish`, not `/reset` vs `/publish`.

**5. Late-arriving saves are not waited on.**
`await pendingSave` captures the chain *as of that moment*. If a new `/draft`
arrives during the await, that new save is on a *new* chain and the current
`/publish` will not wait for it. That may be intended, but it is unstated and
untested.

**6. Misleading `/draft` HTTP response on epoch discard.**
When epoch changes mid-flight, the server records `draft.discarded`, but
`/draft`'s response handler still returns:

```json
{ "ok": true, "saved": "<content>" }
```

The API lies to the client. It should either return an error or a status
indicating the save was invalidated.

**7. `.catch(() => {})` swallows real exceptions.**
`pendingSave.catch(() => {})` keeps the chain consumable, but it also masks
every bug in the commit logic. There is no logging path. If `currentDraft =
content` ever throws (for example in a future refactor with a real store), it
will fail silently forever and you will not know why publishes look stale.

**8. `/draft`'s own response handler can never reach the `500` branch.**
The chain swallows rejections, so the `onrejected` arm of
`pendingSave.then(...)` is unreachable. It is dead error-handling code that
*looks* defensive but cannot actually fire.

**9. No timeout / cancellation on a stuck save.**
If `setTimeout` ever fails to fire (clock skew in test environments, suspended
VM, fake timers in tests), `pendingSave` never resolves, every future
`/publish` hangs forever, and so does every future `/draft` HTTP response.
There is no per-save timeout and no chain reset on stall.

**10. The in-memory model assumes a single Node process.**
If anyone runs `pm2 -i 2` or scales horizontally behind a load balancer, the
race reappears across processes and `pendingSave` is no longer shared. The fix
is correct only for the “one Node process, in-memory” deployment.

**11. No durability.**
Crash → all drafts lost. Not strictly the race-fix's job, but worth flagging
because the *read-after-write* semantics being defended here have no
persistence backing them.

**12. Tracing is unbounded in production.**
`traceEvents.push(evt)` never trims. If anyone ever sets `TRACE_RACE=1` in
production for diagnostics, that is a memory leak.

---

## Edge cases the test/harness do not cover

- Two concurrent `/publish` requests.
- `/reset` arriving during a `/publish` await.
- `/reset` arriving between two queued saves (only the “before save” case is
  exercised).
- A `/draft` whose `setTimeout` never fires.
- Many concurrent `/draft`s (>2).
- Empty `content`.
- Very large `content` (no length cap, no rate limit, default Express body
  size is 100kb).
- Non-ASCII or binary-like strings.
- HTTP client disconnect mid-request — the response handler still calls
  `res.json` which writes to a closed socket.

---

## Assumptions the fix bakes in

- One Node process, one event loop, in-memory state.
- The artificial `SAVE_COMMIT_DELAY_MS` is the *only* latency source. In
  production, real DB write latency varies and can be much longer or much
  shorter; the chain semantics remain correct, but UX assumptions don't.
- All callers eventually `await` their `/draft` if they care about ordering.
  Otherwise the response order vs. commit order can diverge and clients can be
  confused.
- `/reset` is only called by tests. There is no auth or rate limit on it.
- Express runs the route handlers atomically with respect to other route
  handlers — true within the synchronous body, *not* true across `await`
  points.

---

## Cleaner alternatives a senior engineer would suggest

1. **Async mutex (clearer mental model).** A real `Mutex` from a small library
   (or 10 lines of code). `/draft` and `/publish` both acquire and release it.
   The intent — “these critical sections are mutually exclusive” — becomes the
   single primitive instead of a hand-rolled promise chain.

2. **Atomic swap with a version counter.** Each save assigns an integer
   version. `/publish` waits for *the latest known version* to commit, not the
   entire chain. This avoids head-of-line blocking when many saves stack up.

3. **Coalescing / latest-wins.** Editor saves are typically idempotent and only
   the last one matters. Replace any pending un-committed save with the newer
   one instead of queueing them all. Lower latency, lower memory, simpler
   reasoning.

4. **Push the concern down to the storage layer.** In a real app, a
   transactional DB read inside `/publish` (`SELECT … FOR UPDATE` or similar)
   makes the JS-level chain unnecessary. The current design is essentially
   re-implementing transaction isolation in application code.

5. **Make `/draft` respond immediately and commit asynchronously.** Right now
   `/draft` blocks the HTTP response until `setTimeout` fires. If the goal is
   just “publish must reflect the latest accepted save,” the response can fire
   as soon as the save is *enqueued*, and `/publish` still waits on the queue.
   UX gets faster.

6. **Replace the silent `.catch(() => {})` with explicit error logging.** Keep
   the chain consumable, but don't lose every error.

7. **Apply the epoch check in `/publish` too.** Right now epoch logic only
   protects `/draft` commits. `/publish` reads `currentDraft` with no awareness
   of whether a `/reset` happened during its await. A consistent design would
   record the epoch at publish entry and refuse to publish if epoch changed
   during the await, or at minimum log it.

---

## Things to push back on in code review

- “Why does `/draft` block its HTTP response on commit? Either commit
  synchronously, or respond on enqueue.”
- “Why does `/publish` wait for the *whole* chain instead of just the latest
  in-flight save?”
- “`.catch(() => {})` is silently eating bugs. At least log the error.”
- “The `onrejected` arm in `/draft`'s response handler is unreachable. Remove
  it or stop swallowing errors upstream.”
- “What is the contract for `/publish` when `/reset` is called concurrently?
  It is not in the comments, not in tests, and the implementation does not
  enforce one.”
- “There is no test for concurrent `/publish`s, concurrent `/draft`s, or
  `/reset` during a publish. How confident are we that this is fixed?”
- “`saveEpoch` and the chain assume single-process. Is that documented
  anywhere?”
- “`traceEvents` grows forever when `TRACE_RACE=1`. Either cap it or document
  that this flag is for tests only.”

---

## Net summary

The fix is **correct for the specific scenario the harness and the test
exercise**: save A committed, save B in flight, publish fired, publish must
see save B. It serializes saves and makes publish wait on the queue. That
works.

It is **not robust** for: concurrent publishes, `/reset` racing with
`/publish`, save chains under load, stuck saves, multi-process deployments, or
any future refactor that introduces a real exception in the commit path. The
HTTP semantics of `/draft` are also poor (latency = queue depth × delay;
misleading success on discard).

If this were a PR being reviewed in a real production codebase, the items
worth blocking on at minimum are:

- Item 1 (head-of-line blocking on `/publish`).
- Item 3 (`/draft` response latency under load).
- Item 4 (`/publish` vs `/reset` synchronization).
- Item 6 (misleading `/draft` HTTP response on discard).
- Item 7 (silent `.catch(() => {})`).

Tests should be added for concurrent `/publish`s, concurrent `/draft`s, and
`/reset` interleavings before this is considered production-ready.
