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

---

## Verified pushback points (with code evidence)

Each of the eight pushback items below was re-checked directly against
`app/server.js` and `tests/race.test.js`. Every one is confirmed true.

### 1. `/draft` blocks its HTTP response on commit

**Verdict: confirmed.**

```111:120:app/server.js
  pendingSave.then(
    () => {
      res.json({ ok: true, saved: content });
    },
    () => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'save failed' });
      }
    },
  );
```

The response handler is attached *to* `pendingSave`, which only resolves
after the `setTimeout` at line 95–107 fires. Therefore the HTTP `200`
response cannot be sent until the entire pending chain — not just this save
— completes. Latency for save N is roughly `N * SAVE_COMMIT_DELAY_MS`.

### 2. `/publish` waits for the whole save chain instead of just the latest in-flight save

**Verdict: confirmed.**

```126:140:app/server.js
app.post('/publish', async (req, res) => {
  trace('publish.received', { currentDraftBeforeWait: currentDraft });
  try {
    await pendingSave;
  } catch (_) {
  }
  trace('publish.read', { currentDraftRead: currentDraft });
  publishedDraft = currentDraft;
  trace('publish.assigned', { publishedDraft });
  res.json({ ok: true, published: publishedDraft });
});
```

`pendingSave` is the *tail* of the save chain. Awaiting it means waiting
for every queued save up to that point, even though only the last save's
value would actually be read into `publishedDraft`.

### 3. `.catch(() => {})` silently swallows commit-side errors

**Verdict: confirmed.**

```87:109:app/server.js
  // .catch(() => {}) keeps the chain consumable: if a previous save's promise
  // ever rejects, this swallows it so the new save (and every later /publish
  // awaiting pendingSave) still runs instead of silently inheriting a
  // poisoned chain.
  pendingSave = pendingSave.catch(() => {}).then(
    () =>
      new Promise((resolve) => {
        setTimeout(() => {
          if (epoch === saveEpoch) {
            currentDraft = content;
            trace('draft.committed', { content });
          } else {
            trace('draft.discarded', {
              content,
              epoch,
              currentEpoch: saveEpoch,
            });
          }
          resolve();
        }, SAVE_COMMIT_DELAY_MS);
      }),
  );
```

The `.catch(() => {})` discards every prior rejection without logging it.
A future bug in the commit path would be invisible.

### 4. The `onrejected` arm of `/draft`'s response handler is unreachable

**Verdict: confirmed.**

The `pendingSave` chain is `previous.catch(() => {}).then(commit)`. The
`.catch(() => {})` upstream guarantees the promise can never reject from
prior history, and the `commit` callback itself only resolves (no `reject`,
no synchronous throw):

```91:109:app/server.js
  pendingSave = pendingSave.catch(() => {}).then(
    () =>
      new Promise((resolve) => {
        setTimeout(() => {
          // ... only resolve() ever called
          resolve();
        }, SAVE_COMMIT_DELAY_MS);
      }),
  );
```

Therefore the `onrejected` arm at lines 115–119 of `app/server.js` cannot
fire under the current code path. It is dead error handling that *looks*
defensive but isn't.

### 5. The contract for `/publish` when `/reset` is called concurrently is not documented or enforced

**Verdict: confirmed.**

`/reset` is fully synchronous and has no synchronization with `/publish`:

```153:160:app/server.js
app.post('/reset', (req, res) => {
  saveEpoch += 1;
  currentDraft = '';
  publishedDraft = '';
  pendingSave = Promise.resolve();
  trace('reset', { newEpoch: saveEpoch });
  res.json({ ok: true });
});
```

If `/reset` runs between `/publish`'s `await pendingSave` (line 132) and
`publishedDraft = currentDraft` (line 137), `/publish` will publish the
cleared empty value. There is no comment in `app/server.js` documenting
what should happen, and no test covering this interleaving.

### 6. There is no test for concurrent `/publish`s, concurrent `/draft`s, or `/reset` during a publish

**Verdict: confirmed.**

`tests/race.test.js` contains only two tests:

```22:54:tests/race.test.js
test('publish reflects the most recent save, even when save is in flight', async () => {
  const agent = supertest(app);
  await agent.post('/reset').expect(200);
  await agent
    .post('/draft')
    .send({ content: 'draft A' })
    .expect(200);
  const savePromise = agent
    .post('/draft')
    .send({ content: 'draft B' });
  const publishPromise = agent.post('/publish');
  const [_, publishResponse] = await Promise.all([savePromise, publishPromise]);
  assert.strictEqual(
    publishResponse.body.published,
    'draft B',
    'publish returned stale data — the in-flight save was not reflected',
  );
});
```

```56:69:tests/race.test.js
test('publish reflects the saved value when no save is in flight', async () => {
  const agent = supertest(app);
  await agent.post('/reset').expect(200);
  await agent
    .post('/draft')
    .send({ content: 'committed draft' })
    .expect(200);
  const publishResponse = await agent.post('/publish').expect(200);
  assert.strictEqual(publishResponse.body.published, 'committed draft');
});
```

Neither test covers two concurrent `/publish`es, three or more concurrent
`/draft`s, or any interleaving with `/reset`. Confidence in correctness
under those scenarios is low.

### 7. `saveEpoch` and the save chain assume a single Node process, and that assumption is not documented

**Verdict: confirmed.**

Both primitives are module-level `let`s:

```21:27:app/server.js
let currentDraft = '';
let publishedDraft = '';
let pendingSave = Promise.resolve();
// Bumped on /reset. Each in-flight /draft captures the epoch at request time
// and refuses to commit if the epoch has changed by the time its setTimeout
// fires, so a save that started before /reset can't clobber post-reset state.
let saveEpoch = 0;
```

These are not shared between Node processes. Running this app under
`pm2 -i 2`, behind a load balancer with multiple replicas, or in a cluster
configuration would re-introduce the original race across processes. There
is no comment in `app/server.js` calling out the single-process assumption.

### 8. `traceEvents` grows forever when `TRACE_RACE=1`

**Verdict: confirmed.**

```49:68:app/server.js
const TRACE = process.env.TRACE_RACE === '1';
const TRACE_START_MS = parseInt(process.env.TRACE_START_MS || String(Date.now()), 10);
const traceEvents = [];
function trace(event, data) {
  if (!TRACE) return;
  const evt = {
    seq: traceEvents.length,
    t_ms: Date.now() - TRACE_START_MS,
    event,
    ...(data || {}),
  };
  traceEvents.push(evt);
  // ... stderr.write(...)
}
```

There is no cap, no rotation, no periodic flush of `traceEvents`. The
in-process harness clears it between scenarios via
`traceEvents.length = 0`, but only the *harness* does that — not the
server. With `TRACE_RACE=1` set in any long-running deployment,
`traceEvents` is an unbounded memory leak. The flag is also not documented
as “for tests only.”

---

## Verification summary

All eight pushback points were verified directly against the source. None
were exaggerated; each is reproducible by reading the indicated lines in
`app/server.js` and `tests/race.test.js`. The fix is correct for the
narrow harness scenario but does not satisfy the safety, observability,
operational, or testing properties one would expect of production code.

---

## Edge case fixes applied

The nine edge cases listed earlier were addressed in `app/server.js` and
covered by new tests in `tests/edge.test.js`. All 11 tests
(2 original race tests + 9 new edge tests) pass under `npm test`, and the
harness still confirms “no race observed.”

### Code changes in `app/server.js`

| Concern | Fix |
|---|---|
| `/reset` during `/publish` await | `/publish` captures `epochAtEntry = saveEpoch` at entry. After the await, if `saveEpoch !== epochAtEntry`, it returns `409 publish aborted: state was reset during await`. |
| `/reset` between queued saves | Already handled by the per-save epoch check at commit time. The `/draft` response now distinguishes outcomes: `200 { ok: true, saved }` if committed, `409 { ok: false, error: 'save discarded ...' }` if epoch changed before commit. |
| Stuck save (`setTimeout` never fires) | `/publish` awaits via `withTimeout(pendingSave, SAVE_MAX_WAIT_MS, 'publish.await')`. On timeout it traces `publish.await.failed`, then either aborts via the epoch check or proceeds with the most recent committed state. |
| Misleading `/draft` success on discard | Resolved by the new `200` / `409` split above. The HTTP response now matches what actually happened. |
| Silent `.catch(() => {})` | Replaced with `.catch((err) => trace('chain.error.swallowed', { error: String(err) }))`. The chain stays consumable, but errors are now visible in the trace. |
| Oversized content | Two layers: explicit `express.json({ limit: BODY_LIMIT })` (default `'256kb'`) and a per-request `MAX_CONTENT_CHARS` cap (default `65536`). Oversized requests get a clean `413` JSON response, never an HTML error page. |
| Empty content | Accepted unchanged — empty string is a valid “cleared editor” state. |
| Non-ASCII content | Accepted unchanged — strings round-trip through JSON. |
| Client disconnect mid-request | All `res.json` calls now go through a `safeJson` helper that checks `res.headersSent`, `res.writableEnded`, `res.socket.destroyed`, and `res.req.aborted` before writing, and try/catches the write. A closed socket is a no-op rather than a crash. |
| Body-parser errors | New Express error handler turns `entity.too.large` into `413 { error: 'request body too large' }` and `entity.parse.failed` into `400 { error: 'invalid JSON body' }`. |

The trace event payloads consumed by the harness (`content`, `currentDraftBeforeWait`,
`currentDraftRead`, `publishedDraft`, `newEpoch`) are unchanged, so
`harness/run-race.js` and `harness/race-harness.js` continue to work
without modification.

### Tests added in `tests/edge.test.js`

Each test corresponds to one of the nine edge cases.

1. Two concurrent `/publish` calls — both return `200` with the saved value.
2. `/reset` during a `/publish` await — publish returns `409` if the reset
   races inside the await window, otherwise `200` with a value drawn from
   the legitimate state space (`''`, `'before'`, or `'B'`).
3. `/reset` between queued saves — post-reset save commits, `/current`
   reflects the post-reset value, pre-reset save returns either `200` or
   `409` depending on commit vs. reset timing.
4. Many concurrent saves followed by an immediate publish — completes
   within a generous bound (validates that `withTimeout` does not break
   normal flow and that the chain settles).
5. Five concurrent `/draft` calls — all return `200`, last save wins on
   `/publish`.
6. Empty content — accepted, `/published` returns `''`.
7. Content above `MAX_CONTENT_CHARS` — rejected with `413`.
8. Non-ASCII content (`'日本語テスト 🚀 — café'`) — round-trips through
   save and publish unchanged.
9. Client disconnect mid-request — server stays healthy and a fresh
   request immediately afterward succeeds.

### Verification

- `npm test` → 11 passed, 0 failed.
- `npm run harness` → exit code `1` ("no race observed"), which is the
  documented success state for the post-fix code.
- No new linter errors.

### Items still not addressed

These are *not* in the nine-edge-case list, so they were intentionally
left for a follow-up:

- Head-of-line blocking on `/publish` (item 1 of the failure modes).
- `/draft` HTTP latency = `SAVE_COMMIT_DELAY_MS × queue depth`
  (item 3 of the failure modes).
- Multi-process deployment (item 10 of the failure modes).
- Durability / persistence (item 11 of the failure modes).
- Unbounded `traceEvents` array under `TRACE_RACE=1` (item 12 of the
  failure modes).
