# AI Conversation: Save/Publish Race Condition

This file captures the working transcript between the user and the AI
assistant while debugging, instrumenting, and fixing the Save/Publish race
in `app/server.js`.

---

## 1. Initial framing

**User:**
> I am having a problem with my publish button not always publishing what
> has been saved. I think this is a race condition and I want to check
> that this is the case. Let's build a harness in the harness directory
> and instrument to trace what is happening and to confirm that the bug
> is due to a race condition.

**Assistant approach:**
- Mapped the save/publish flow in `app/server.js` and `app/static/index.html`.
- Found `POST /draft` commits via a `setTimeout(..., SAVE_COMMIT_DELAY_MS)`,
  while `POST /publish` reads `currentDraft` synchronously — the textbook
  shape of an in-flight write vs. an immediate read.
- Added gated trace instrumentation (`TRACE_RACE=1`) that records
  `draft.received`, `draft.committed`, `publish.received`,
  `publish.assigned` with a shared `TRACE_START_MS` epoch so client and
  server timestamps line up.
- Built two harnesses:
  - `harness/run-race.js` — spawns the server as a child process on port
    3100 with `TRACE_RACE=1`, runs a control scenario (save → wait →
    publish) and a race scenario (save A → unawaited save B → immediate
    publish), merges client + server events, writes `trace.txt`.
  - `harness/race-harness.js` — in-process variant that sweeps a
    `publishOffsetMs` to show the bug is timing-dependent.
- Added an `npm run harness` script.

**Result of running the harness against the broken code (excerpt):**

```
draft.received   content="draft B"          <-- save B request received
publish.received currentDraftRead="draft A" <-- publish reads OLD value
publish.assigned publishedDraft="draft A"   <-- and marks it live
draft.committed  content="draft B"          <-- save B finally commits, too late
```

`SUMMARY: race scenario: BUG REPRODUCED (publish saw stale value).`

---

## 2. "Did you get a trace — save it to trace.txt and tell me if it
indicated a race condition."

**Assistant:**
Yes. The harness wrote `trace.txt` with the merged client/server timeline.
The trace shows publish hitting the server *between* `draft.received` for
`"draft B"` and `draft.committed` for `"draft B"`, and `currentDraftRead`
being `"draft A"` at that moment. That timing-dependent stale read is the
literal definition of a race condition between `/draft` and `/publish`.

---

## 3. "Did you fix the problem?"

**Assistant:** No — only built the harness and confirmed the diagnosis.
The next step is to change `app/server.js` so `/publish` cannot read
`currentDraft` while a save is mid-commit.

---

## 4. "How should we fix this problem?"

**Assistant proposed fix (first pass):**

```js
let pendingSave = Promise.resolve();

app.post('/draft', (req, res) => {
  const { content } = req.body;

  pendingSave = new Promise((resolve) => {
    setTimeout(() => {
      currentDraft = content;
      resolve(content);
    }, SAVE_COMMIT_DELAY_MS);
  });

  pendingSave.then((saved) => {
    res.json({ ok: true, saved });
  });
});

app.post('/publish', async (req, res) => {
  await pendingSave;
  publishedDraft = currentDraft;
  res.json({ ok: true, published: publishedDraft });
});
```

Idea: track the latest in-flight save as a promise; have `/publish` await
it before reading `currentDraft`.

---

## 5. "Review the code that was just generated for correctness and
proof read — is the proposed fix a good one?"

**Assistant review (summary of issues found in the first-pass snippet):**

1. **Lost the `typeof content !== 'string'` validation** — regression.
2. **Lost the `trace(...)` calls** — the harness can no longer prove the
   fix from a trace.
3. **No error path on the save promise** — if the inner work ever rejects,
   `/publish` would hang.
4. **Doesn't actually serialize saves**, just tracks the latest one. With
   variable commit latency two overlapping saves could commit out of
   order. Variable name oversells what the code does.
5. **Reading the saved value through the resolved promise** is needless
   indirection; `content` is already in scope.

**Proposed tightened version:** chain saves with
`pendingSave = pendingSave.then(...)`, restore validation, restore trace
calls, drop the response payload coming back through the promise.

---

## 6. "If you agree, make the changes."

**Assistant:** Agreed. Applied:

```js
pendingSave = pendingSave.then(
  () =>
    new Promise((resolve) => {
      setTimeout(() => {
        currentDraft = content;
        trace('draft.committed', { content });
        resolve();
      }, SAVE_COMMIT_DELAY_MS);
    }),
);
pendingSave.then(() => res.json({ ok: true, saved: content }));
```

```js
app.post('/publish', async (req, res) => {
  trace('publish.received', { currentDraftBeforeWait: currentDraft });
  await pendingSave;
  trace('publish.read', { currentDraftRead: currentDraft });
  publishedDraft = currentDraft;
  trace('publish.assigned', { publishedDraft });
  res.json({ ok: true, published: publishedDraft });
});
```

Also reset `pendingSave = Promise.resolve()` in `/reset`.

**Verification:**
- `npm test`: 2 pass, 0 fail.
- Harness re-run: race scenario now shows
  `publish.received currentDraftBeforeWait="draft A"` →
  `draft.committed content="draft B"` →
  `publish.read currentDraftRead="draft B"` →
  `publish.assigned publishedDraft="draft B"`. Race no longer fires.

The harness summary text was updated to recognize both "bug reproduced"
and "fix prevented the race" patterns.

---

## 7. "Review the updated code for correctness only."

**Assistant correctness review of the committed fix:**

What's correct:

- Saves chain through `pendingSave.then(...)`, so commits stay in arrival
  order even if commit latency varies.
- Each request's response is attached to its own promise — concurrent
  saves don't cross-respond.
- `/publish` does the read/assign synchronously after `await pendingSave`,
  so nothing can interleave between reading `currentDraft` and writing
  `publishedDraft`.
- Validation and trace events are preserved. The new `publish.read`
  event distinguishes "what publish would have read" (`publish.received`
  with `currentDraftBeforeWait`) from "what publish actually used"
  (`publish.read` with `currentDraftRead`).

Latent issues flagged:

1. **`/reset` doesn't revoke in-flight saves** — a save scheduled before
   reset will fire its `setTimeout` after reset and clobber `currentDraft`.
   Not exercised by current tests, but a real wart.
2. **The save chain is unrecoverable if any commit ever rejects.** Today
   nothing in the chain can reject, but if it ever did, `pendingSave`
   would become a rejected promise and every subsequent save and publish
   would inherit the failure.
3. **Response `.then` has no error handler** — `res.json` throwing would
   produce an unhandled rejection.
4. **`/publish` is unprotected against `await` rejection** for the same
   reason.
5. **Behavior change: saves are now strictly serial.** With the artificial
   delay this just adds latency under bursty saves; the regression test
   only sends two saves so it doesn't notice.

Verdict: correct for the documented scenarios; #1 and #2 are the ones to
fix before considering the change "done".

---

## 8. "Fix #1 (in-flight save outliving /reset) and #2 (chain poisoning)."

**Assistant changes in `app/server.js`:**

- Added `let saveEpoch = 0;` and bumped it in `/reset`.
- Each `/draft` captures `const epoch = saveEpoch;` at request time and
  the `setTimeout` callback only commits when `epoch === saveEpoch`.
  Otherwise it logs `draft.discarded` and resolves without writing.
- Self-healed the chain at the head:
  `pendingSave = pendingSave.catch(() => {}).then(...)` — a rejection in
  any prior save can't poison future saves or publishes.
- Response `.then` now has an `onrejected` arm that returns 500 (guarded
  with `res.headersSent` to avoid double-send).
- `/publish` wraps `await pendingSave` in `try/catch` as defense in depth.

**Verification:** `npm test` still 2 pass / 0 fail; lints clean.

---

## 9. "npm test ... fail 1" (running on a different machine)

**User report:**
> Tests fail on `/home/ubuntu/week4-2026` with the same stale-`'draft A'`
> result.

**Assistant diagnosis:**
The fix on WSL was only in the working tree — `git log` showed only
`Initial commit` and `app/server.js` was ` M` (modified, uncommitted).
The Ubuntu box had pulled a checkout that didn't include the fix, so it
was running the original broken code. Recommended committing and pushing,
then pulling on Ubuntu.

---

## 10. "Continue to commit the fix."

**Assistant did the split:**

1. Saved the fixed `app/server.js` to a temp file.
2. Wrote an instrumentation-only version of `app/server.js` (trace events
   added, behavior unchanged from the original broken code).
3. Ran the harness against that version to regenerate `trace.txt` with a
   meaningful bug-reproduction artifact.
4. Staged harness files, instrumentation-only `app/server.js`, the
   `harness` npm script, `package-lock.json`, deleted `harness/.gitkeep`,
   and committed:

   ```
   689726d Add race-condition harness and trace instrumentation
   ```

5. Restored the fixed `app/server.js`. Re-ran the harness to refresh
   `trace.txt` so it showed the fix preventing the race.
6. Committed:

   ```
   993537d Fix save/publish race by serializing saves and gating publish
   ```

`master` was then ahead of `origin/master` by 2.

`WEEK4PRACTICE.md` (user's notes) was deliberately left untracked.

---

## 11. "Push only — then I will run the test from Ubuntu terminal."

**Assistant:** Tried `git push origin master`. Failed with
`fatal: could not read Username for 'https://github.com'` because the
Cursor agent shell has no GitHub credentials and no credential helper.
Reported the situation and listed options (`gh auth login`,
`credential.helper store`, switch remote to SSH).

---

## 12. Ubuntu attempt: `git push origin master` returned "Everything
up-to-date"

**Assistant explanation:**
Ubuntu was on local branch `race-fix`, while its local `master` already
matched `origin/master` (both stale). The push was a no-op against the
wrong branch. The actual work on origin lives on `race-fix`, not
`master`.

`git fetch origin` on WSL revealed `origin/race-fix` had two commits on
top of master (`f8f2cfc Rename ci.yml to test.yml` and
`acc290e Add package-lock.json for reproducible installs`) that weren't
on local master. The fix had to be stacked on top of `origin/race-fix`,
not pushed directly as `master`.

**Assistant rebuilt the branch:**

```bash
git checkout -B race-fix origin/race-fix
git cherry-pick 689726d 993537d
```

Cherry-picks were clean (the existing `package-lock.json` on `race-fix`
was identical to the one in commit 1). Tests passed on the new branch.
Final local layout:

```
c3ff0f2 (HEAD -> race-fix) Fix save/publish race by serializing saves and gating publish
b5808c7 Add race-condition harness and trace instrumentation
acc290e (origin/race-fix) Add package-lock.json for reproducible installs
f8f2cfc Rename ci.yml to test.yml
6c86448 (origin/master) Initial commit
```

---

## 13. Push from the user's WSL terminal

**Assistant guidance:** the agent shell can't push (no credentials).
From a normal WSL terminal:

```bash
cd "/mnt/c/Users/Aden M/OneDrive/Desktop/week4-506-2026/week4-2026"
git push origin race-fix
```

Then on Ubuntu:

```bash
git pull
npm test
```

User confirmed `npm test` then passed locally on WSL (2 pass, 0 fail).
Until `git push origin race-fix` is actually executed from a credentialed
terminal, Ubuntu will continue to fail because `origin/race-fix` does
not yet contain the fix.

---

## 14. GitHub branches, Ubuntu verification, and Actions workflow

**User asked why GitHub showed two branches.**

**Assistant explained:** this is expected for the assignment workflow.

- `master` is the pristine baseline branch, still at the initial commit.
- `race-fix` is the feature branch containing the harness, instrumentation,
  fix, and AI conversation transcript.
- The next assignment step is a PR from `race-fix` into `master`.

**User verified on Ubuntu:**

```bash
npm test
```

Output showed:

```text
pass 2
fail 0
```

**User also ran:**

```bash
npm run harness
```

The harness output showed:

```text
publish.received currentDraftBeforeWait="draft A"
draft.committed content="draft B"
publish.read currentDraftRead="draft B"
publish.assigned publishedDraft="draft B"
RACE RESULT: published="draft B" (expected "draft B") -> no race observed
```

**Assistant explained:** this is the desired fixed behavior. Publish arrived
while save B was in flight, but waited for the pending save to commit before
reading `currentDraft`. The harness wrote a refreshed `trace.txt`.

The harness printed:

```text
[harness] exit code: 1
```

**Assistant clarified:** in this harness, exit code `1` means "race did not
reproduce." That is expected after the fix. It is not an application problem.

**User reported GitHub Actions text like:**

```text
.github/workflows/test.yml #5: Commit e628835 pushed by Adenm2024
```

**Assistant explained:** that line is just the GitHub Actions run title. It
does not by itself mean failure. To know the result, open the run and look for
green check / red X / running status, then inspect the failing job step if
needed.

Before that, the workflow file had been discovered to be empty, so the
assistant added a real Node 20 GitHub Actions workflow:

```yaml
name: Tests

on:
  push:
    branches: [master, race-fix]
  pull_request:
    branches: [master]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test
```

Local `npm test` still passed after adding the workflow. The assistant
instructed the user to commit and push that workflow change from WSL:

```bash
git add .github/workflows/test.yml
git commit -m "Add GitHub Actions test workflow"
git push origin race-fix
```

---

## Final state of `app/server.js`

Key contract enforced by the fix:

- Each `POST /draft` queues its commit behind the previous save's
  promise: `pendingSave = pendingSave.catch(() => {}).then(commit)`.
- `POST /publish` is `async` and `await`s `pendingSave` before reading
  `currentDraft`, so it can never observe a half-applied save.
- Each `/draft` captures the current `saveEpoch`. `POST /reset` bumps the
  epoch, so a save scheduled before a reset becomes a no-op when its
  timer fires.
- Response handlers have `onfulfilled`/`onrejected` arms; `/publish`
  wraps the await in `try/catch`.

Verification artifacts:
- `tests/race.test.js` — both regression tests pass.
- `harness/run-race.js` — race scenario no longer reproduces; the trace
  shows publish waiting for `draft.committed` before reading.
- `trace.txt` — captures the post-fix timeline.

---

## Follow-up checks on trace observability and git state

The user asked whether a terminal snippet showing:

```bash
touch recommit.txt
git add recommit.txt
git commit -m 'recommitting to cause github actions to fire'
```

meant the commit existed and whether it helped observability. The assistant
explained that a terminal command alone does not prove a commit exists in git
history, and a recommit by itself does not improve observability. It can
re-trigger GitHub Actions, but the race only becomes visible through the
harness and instrumentation.

The assistant checked the local workspace and found `recommit.txt` was missing,
then added an empty `recommit.txt` file. It was left untracked; nothing was
staged or committed.

The user then saw a rejected push:

```text
! [rejected]        race-fix -> race-fix (non-fast-forward)
Your branch and 'origin/race-fix' have diverged,
and have 1 and 2 different commits each, respectively.
```

The assistant explained that local `race-fix` and `origin/race-fix` each had
unique commits. The suggested resolution was to commit any intended staged work
first, then integrate the remote branch with:

```bash
git pull --rebase origin race-fix
git push origin race-fix
```

The user also ran:

```bash
git push origin master
```

and Git reported `Everything up-to-date`, which only confirmed that `master`
had nothing new to push. It did not resolve the separate `race-fix` divergence.

The user asked whether the repository contains both forms of race-condition
observability:

1. A test harness that drives HTTP endpoints, simulates user actions, uses
   controlled timing / artificial delays, and produces a clear log.
2. Code-level instrumentation inside the app.

The assistant checked the repo and confirmed both are present:

- `harness/run-race.js` starts `app/server.js` with `TRACE_RACE=1`,
  `TRACE_START_MS`, `SAVE_COMMIT_DELAY_MS=300`, and `PORT=3100`, then drives
  `POST /reset`, `POST /draft`, and `POST /publish`.
- `harness/run-race.js` writes a merged client/server timeline to `trace.txt`.
- `harness/race-harness.js` also runs HTTP scenarios in process and sweeps
  publish offsets with `sleep(publishOffsetMs)`.
- `tests/race.test.js` is a regression test that controls save timing and
  fires publish while save B is in flight.
- `app/server.js` has app-level trace instrumentation gated by `TRACE_RACE=1`.

The trace capture was checked without re-running the harness. `trace.txt`
already showed a captured harness run against the instrumented app:

```text
# Lines from [client       ] are emitted by harness/run-race.js.
# Lines from [server #NNN  ] are emitted by app/server.js when TRACE_RACE=1.
```

The trace includes the fields needed to make the race visible:

- timestamps, such as `[+ 6365ms]`;
- event/request tags, such as `draft.received`, `publish.received`,
  `draft.committed`, `publish.read`, and `publish.assigned`;
- payload/state values, such as `content="draft B"`,
  `currentDraftBeforeWait="draft A"`, `currentDraftRead="draft B"`, and
  `publishedDraft="draft B"`.

Key captured trace excerpt:

```text
[+ 6365ms] [server #009] draft.received content="draft B"
[+ 6366ms] [server #010] publish.received currentDraftBeforeWait="draft A"
[+ 6667ms] [server #011] draft.committed content="draft B"
[+ 6668ms] [server #012] publish.read currentDraftRead="draft B"
[+ 6668ms] [server #013] publish.assigned publishedDraft="draft B"
```

The assistant noted that GitHub Actions ran `npm test`, but did not yet run
`npm run harness`, so the harness existed and worked but was not automatically
run by CI.

The user then asked to include `npm run harness`. The assistant updated
`.github/workflows/test.yml` to add a `Run race harness` step before
`npm test`:

```yaml
- name: Run race harness
  run: |
    set +e
    npm run harness
    code=$?
    set -e
    if [ "$code" -ne 0 ] && [ "$code" -ne 1 ]; then
      exit "$code"
    fi
    echo "Accepted harness exit code $code (0=race reproduced, 1=no race observed)."
```

This keeps the harness output visible in GitHub Actions logs while respecting
the harness's documented exit codes: `0` means the race reproduced, and `1`
means the fixed app did not reproduce the race. Unexpected harness errors still
fail CI.

The user added a marker line inside `recommit.txt`:

```text
Recommit marker to trigger GitHub Actions.
```

The user then asked to commit the changes, and the assistant created commit
`811457b Run race harness in CI`, which included
`.github/workflows/test.yml`, `ai-conversation-fix.md`, and `recommit.txt`.

---

## Critical review of the fix

The user asked for a critical, senior-engineer-style review of the fixed
code in `app/server.js`, including failure modes it does not address, edge
cases missed, assumptions baked in, alternatives, and concrete pushback
points. The user asked the assistant to show the result first, before making
any changes.

The assistant produced a thorough review covering the items below. The full
text was then saved to `review.md` at the repo root.

### Failure modes the fix does not address

1. Head-of-line blocking on `/publish` — publish awaits the entire pending
   chain instead of just the latest in-flight save.
2. Unbounded promise chain growth — `pendingSave` is never trimmed.
3. `/draft` HTTP latency scales with queue depth × `SAVE_COMMIT_DELAY_MS`.
4. `/publish` vs `/reset` is not synchronized; concurrent reset can clear
   `currentDraft` between publish's await and its read.
5. Late-arriving saves are not waited on by an in-flight publish.
6. `/draft` returns `{ ok: true, saved: ... }` even when the save was
   discarded due to an epoch change.
7. `pendingSave.catch(() => {})` silently swallows every commit-side error.
8. `/draft`'s `onrejected` response branch is unreachable because of (7).
9. No timeout or cancellation on a stuck save; everything blocks forever.
10. The whole design assumes one Node process, in-memory state.
11. No durability — a crash loses every draft.
12. `traceEvents` grows unbounded when `TRACE_RACE=1`.

### Edge cases not covered by tests / harness

- Two concurrent `/publish` requests.
- `/reset` arriving during a `/publish` await.
- `/reset` arriving between two queued saves.
- A `/draft` whose `setTimeout` never fires.
- More than two concurrent `/draft`s.
- Empty `content`.
- Very large `content` (no length cap or rate limit).
- Non-ASCII or binary-like strings.
- HTTP client disconnect mid-request.

### Assumptions baked into the fix

- One Node process, one event loop, in-memory state.
- The artificial `SAVE_COMMIT_DELAY_MS` is the only latency source.
- Callers `await` their `/draft` if they care about ordering.
- `/reset` is only invoked by tests; it has no auth or rate limit.
- Express handlers are atomic only within their synchronous body, not across
  `await` points.

### Cleaner alternatives a senior engineer would suggest

1. Use an explicit async mutex around the read/write critical section.
2. Use a version counter and have `/publish` await only the latest version.
3. Coalesce or "latest-wins" pending saves rather than queueing all of them.
4. Push the consistency concern down to the storage layer (e.g.
   `SELECT … FOR UPDATE`).
5. Make `/draft` respond on enqueue, not after commit.
6. Replace the silent `.catch(() => {})` with explicit error logging.
7. Apply the epoch check inside `/publish` too, so it is consistent with
   `/draft`.

### Pushback points worth blocking on in code review

- `/draft` blocking its HTTP response on commit.
- `/publish` waiting on the whole save chain instead of the latest save.
- Silent error swallowing via `.catch(() => {})`.
- Unreachable `onrejected` arm in `/draft`.
- Undocumented contract for `/publish` + `/reset` concurrency.
- Missing tests for concurrent publishes, concurrent saves, and reset
  interleavings.
- Single-process assumption being undocumented.
- Unbounded `traceEvents` array under `TRACE_RACE=1`.

### Net summary

The fix is **correct for the harness/test scenario** (save A committed, save
B in flight, publish fires, publish must see save B). It serializes saves
and makes publish wait on the queue.

It is **not robust** for: concurrent publishes, `/reset` racing with
`/publish`, save chains under load, stuck saves, multi-process deployments,
or any future refactor that introduces a real exception in the commit path.
The HTTP semantics of `/draft` are also poor (latency scales with queue
depth; misleading success on discard).

If reviewed as a real production PR, items worth blocking on at minimum are:
head-of-line blocking on `/publish`, `/draft` response latency under load,
`/publish` vs `/reset` synchronization, the misleading `/draft` HTTP
response on discard, and the silent `.catch(() => {})`.

### What was committed for the review

The full review text was written to `review.md` and committed as
`5548b34 Add critical review of the race fix`. The branch `race-fix` is now
ahead of `origin/race-fix` by 2 commits and has not been pushed.

---

## Re-verification of the eight pushback points

The user asked the assistant to re-check each pushback point against the
actual source and to document the verified findings in `review.md` and in
this transcript. Each point was checked against `app/server.js` and
`tests/race.test.js`. All eight were confirmed true.

### 1. `/draft` blocks its HTTP response on commit

The response handler at `app/server.js` lines 111–120 is attached to
`pendingSave`. `pendingSave` only resolves after the `setTimeout` at line
95–107 fires. The HTTP `200` therefore cannot be sent until the entire
queue ahead of this save also commits. Latency for save N is roughly
`N * SAVE_COMMIT_DELAY_MS`.

### 2. `/publish` waits for the whole save chain instead of just the latest in-flight save

`app/server.js` line 132 does `await pendingSave;`. `pendingSave` is the
*tail* of the chain at await time, so all earlier queued saves are also
awaited even though only the last save's value is read at line 137.

### 3. `.catch(() => {})` silently swallows commit-side errors

`app/server.js` line 91 does
`pendingSave = pendingSave.catch(() => {}).then(...)`. The empty handler
discards every prior rejection without logging it. A real commit-side bug
would never surface.

### 4. The `onrejected` arm of `/draft`'s response handler is unreachable

The chain `previous.catch(() => {}).then(commit)` at lines 91–109 cannot
reject: `.catch(() => {})` cleans previous rejections, and the `commit`
callback only ever calls `resolve()` (no throw, no `reject`). The
`onrejected` arm at lines 115–119 cannot fire under the current code path.
It is dead error handling that *looks* defensive but isn't.

### 5. The `/publish` + `/reset` concurrency contract is not documented or enforced

`/reset` at lines 153–160 is fully synchronous: it bumps `saveEpoch`,
clears `currentDraft` and `publishedDraft`, and reassigns `pendingSave`.
There is no synchronization between `/reset` and `/publish`. If `/reset`
runs between `/publish`'s `await pendingSave` (line 132) and
`publishedDraft = currentDraft` (line 137), `/publish` will publish the
cleared empty value. No comment in `app/server.js` documents this, and no
test covers it.

### 6. There is no test for concurrent publishes, concurrent saves, or `/reset` during a publish

`tests/race.test.js` only contains two tests:

- “publish reflects the most recent save, even when save is in flight” —
  one save A, one save B in flight, one publish.
- “publish reflects the saved value when no save is in flight” — one save,
  one publish.

There is no coverage of:

- Two or more concurrent `/publish`es.
- Three or more concurrent `/draft`s.
- `/reset` interleaved with an in-flight `/publish`.
- `/reset` interleaved with multiple `/draft`s.

### 7. `saveEpoch` and the save chain assume a single Node process, and that assumption is not documented

`currentDraft`, `publishedDraft`, `pendingSave`, and `saveEpoch` are
module-level `let`s at `app/server.js` lines 21–27. They are not shared
between processes. Under `pm2 -i 2`, behind a load balancer with multiple
replicas, or in a Node cluster, the original race re-emerges across
processes. There is no comment in `app/server.js` calling out the
single-process assumption.

### 8. `traceEvents` grows forever when `TRACE_RACE=1`

`traceEvents` is declared at line 51 and pushed into at line 60
unconditionally when `TRACE` is true. There is no cap, no rotation, and no
flushing in the server. The harness clears it between scenarios via
`traceEvents.length = 0`, but only the *harness* does that, not the
server. With `TRACE_RACE=1` set in a long-running deployment, this is an
unbounded memory leak. The flag is also not documented as “for tests
only.”

### Verification summary

All eight pushback points are reproducible by reading the indicated lines
in `app/server.js` and `tests/race.test.js`. None of them were
exaggerated. The fix is correct for the harness's narrow scenario, but
fails to satisfy the safety, observability, operational, and testing
properties one would expect of production code. The verified findings are
documented in `review.md`.

---

## Edge-case fixes applied

The user asked for code changes that address the nine edge cases the
review identified as untested or unhandled. The assistant updated
`app/server.js` and added a new test file `tests/edge.test.js` with one
test per edge case. The full test suite (11 tests) passes and the harness
continues to report "no race observed."

### Changes in `app/server.js`

- `/publish` now captures `epochAtEntry = saveEpoch` at function entry.
  After the await, if `saveEpoch !== epochAtEntry`, it returns `409
  publish aborted: state was reset during await`. This addresses the
  `/reset` vs `/publish` race.
- `/publish` awaits via `withTimeout(pendingSave, SAVE_MAX_WAIT_MS,
  'publish.await')` so a stuck `setTimeout` (suspended VM, fake timers,
  clock skew) cannot wedge the handler. On timeout the trace records
  `publish.await.failed` and the handler proceeds with the most recent
  committed state, or aborts via the epoch check.
- `/draft` no longer claims `{ ok: true, saved: ... }` for a discarded
  save. The commit promise resolves with `{ committed: bool }`, and the
  response handler returns `200` for committed saves and `409 save
  discarded: state was reset before commit` otherwise.
- The previously silent `pendingSave.catch(() => {})` is now
  `pendingSave.catch((err) => trace('chain.error.swallowed', ...))`. The
  chain stays consumable but errors are visible in the trace.
- Body size is capped via `express.json({ limit: BODY_LIMIT })` (default
  `'256kb'`), and `/draft` enforces a per-request `MAX_CONTENT_CHARS`
  ceiling (default `65536`). Both produce clean `413` JSON responses.
- A new Express error handler turns `entity.too.large` and
  `entity.parse.failed` into structured JSON instead of HTML pages.
- All `res.json` calls go through a `safeJson` helper that checks
  `res.headersSent`, `res.writableEnded`, `res.socket.destroyed`, and
  `res.req.aborted` before writing, and try/catches the write. A closed
  socket is a no-op rather than a crash.
- Trace event payloads that the harness depends on (`content`,
  `currentDraftBeforeWait`, `currentDraftRead`, `publishedDraft`,
  `newEpoch`) are unchanged, so `harness/run-race.js` and
  `harness/race-harness.js` keep working.

### New tests in `tests/edge.test.js`

One test per edge case:

1. Two concurrent `/publish` calls both return `200` with the saved value.
2. `/reset` during a `/publish` await is detected via the epoch check;
   publish returns either `409` or a value drawn from the legitimate
   state space.
3. `/reset` between queued saves discards the pre-reset save and lets the
   post-reset save commit; `/current` reflects the post-reset value.
4. Many saves followed by an immediate publish must finish within a
   generous time bound (smoke test for `withTimeout`).
5. Five concurrent `/draft` calls all return `200` and the last save wins
   on `/publish`.
6. Empty content is accepted as a valid draft.
7. Content above `MAX_CONTENT_CHARS` is rejected with `413`.
8. Non-ASCII content (`'日本語テスト 🚀 — café'`) round-trips unchanged.
9. A client disconnect mid-request does not crash the server; a follow-up
   request immediately afterward still works.

### Verification

- `npm test` reports `tests 11 / pass 11 / fail 0`.
- `npm run harness` exits with code `1`, which is the documented
  "no race observed" state for the fixed code.
- No new linter errors in `app/server.js` or `tests/edge.test.js`.

### What is still out of scope

The user's request was specifically about the nine edge cases. The
following items from the broader review were *not* addressed in this
round and remain noted in `review.md`:

- Head-of-line blocking on `/publish`.
- `/draft` HTTP latency scaling with queue depth.
- Multi-process deployment.
- Durability across process restart.
- Unbounded `traceEvents` array under `TRACE_RACE=1`.

---

## Pushing the fixes to GitHub and Ubuntu

The user committed the fixes and the doc updates locally on the WSL clone
and asked whether the changes were live on GitHub and on the Ubuntu /
EC2 box. The assistant confirmed:

- GitHub: not live. The local `race-fix` was 4 commits ahead of
  `origin/race-fix`. A push was required.
- Ubuntu / EC2 (`ubuntu@ip-172-31-0-34`): not live either. That clone
  needs its own `git fetch` / `git pull` after the push.

### Rebase conflict on trace.txt

The user ran:

```bash
git pull --rebase origin race-fix
```

It produced:

```text
Auto-merging trace.txt
CONFLICT (content): Merge conflict in trace.txt
error: could not apply 534981a... Address race-fix edge cases and add edge regression tests
```

`trace.txt` is regenerated by the harness, so the conflict was just two
different harness runs on the same branch. The resolution was to take
the local (post-fix) trace and continue the rebase. During a rebase the
roles are inverted, so `--theirs` here refers to the commit being
replayed:

```bash
git checkout --theirs trace.txt
git add trace.txt
GIT_EDITOR=true git rebase --continue
```

`GIT_EDITOR=true` was needed because `git rebase --continue` tried to
open `nano` for the commit message, which fails in a non-interactive
shell. Setting `GIT_EDITOR=true` makes git accept the existing commit
message without opening an editor.

After the continue, git reported:

```text
Successfully rebased and updated refs/heads/race-fix.
## race-fix...origin/race-fix [ahead 4]
```

Local `race-fix` is now cleanly rebased on top of `origin/race-fix` with
the four assistant commits replayed in order:

```text
65db485 Address race-fix edge cases and add edge regression tests
c6bf374 Document critical review in conversation transcript
3615d40 Add critical review of the race fix
dd41e66 Run race harness in CI
```

(Commit hashes changed because the rebase rewrote them onto the new
upstream tip.)

### Next steps to make the changes live

The push and the EC2 update have not been performed yet. To make the
fixes live everywhere, the user runs:

```bash
git push origin race-fix
```

and then on the Ubuntu / EC2 box:

```bash
cd ~/week4-2026
git fetch origin
git pull --rebase origin race-fix
```

If the EC2 box has its own divergent commits, the same `--theirs`
strategy on `trace.txt` (or any other harness-generated file) applies
there too.

---

## Adding before-and-after trace evidence

The user asked about the reviewer note:

> `trace.txt` is from the fixed code, so consider committing a pre-fix capture
> alongside it so the race is visible directly in the trace file as well as in
> the AI conversation.

The assistant explained that the current `trace.txt` only shows the fixed
behavior: `/publish` waits for save B to commit and then publishes
`"draft B"`. To make the bug visible directly in the repository artifacts,
the branch should also include a before-fix trace file:

- `trace-before-fix.txt` — captured from the broken version, showing
  `published="draft A"` and `BUG REPRODUCED`.
- `trace.txt` — captured from the fixed version, showing
  `published="draft B"` and `no race observed`.

The assistant identified commit `b5808c7 Add race-condition harness and trace
instrumentation` as the pre-fix harness commit and suggested extracting the
old trace from it:

```bash
git show b5808c7:trace.txt > trace-before-fix.txt
```

Then the user verified the pre-fix trace. `rg` was not installed in the WSL
terminal, so the assistant suggested `grep -E` instead:

```bash
grep -E 'BUG REPRODUCED|published="draft A"' trace-before-fix.txt
```

The command printed:

```text
[+ 8136ms] [client       ] RACE RESULT: published="draft A" (expected "draft B") -> BUG REPRODUCED (stale value)
race scenario:        BUG REPRODUCED (publish saw stale value)
```

The user then verified the fixed trace:

```bash
grep -E 'no race observed|published="draft B"' trace.txt
```

The command printed:

```text
[+ 6827ms] [client       ] RACE RESULT: published="draft B" (expected "draft B") -> no race observed
race scenario:        no race observed
```

The assistant explained that these two outputs prove both sides of the race:
the old code published stale `"draft A"`, while the fixed code waited and
published `"draft B"`.

The assistant also explained this commit command:

```bash
git commit -m "$(cat <<'EOF'
Add before-and-after race traces

EOF
)"
```

It is a heredoc-based way to pass a commit message to `git commit -m`. For a
simple one-line message, it is equivalent to:

```bash
git commit -m "Add before-and-after race traces"
```

The user staged and committed the trace evidence:

```bash
git add trace-before-fix.txt trace.txt
git commit -m "Add before-and-after race traces"
```

Git reported:

```text
[race-fix e8814dc] Add before-and-after race traces
 1 file changed, 50 insertions(+)
 create mode 100644 trace-before-fix.txt
```

The assistant clarified that `trace.txt` was already tracked and unchanged,
so the commit only added the new `trace-before-fix.txt` file.

---

## Local, GitHub, and EC2 synchronization follow-up

The user then asked:

> commit, and ensure github, is uptodate and similar to the local files.

The assistant replied:

> I’ll commit the transcript update, then push `race-fix` so GitHub matches this
> local branch. First I’m checking the exact pending changes and recent commit
> style.

The assistant checked the local branch and pending changes:

```bash
git status --short --branch
```

Git reported:

```text
## race-fix...origin/race-fix [ahead 1]
 M ai-conversation-fix.md
```

The assistant reviewed the transcript diff and recent commits:

```bash
git diff HEAD -- ai-conversation-fix.md
git log --oneline -n 8
```

The recent commits were:

```text
e8814dc Add before-and-after race traces
808d468 Add reflection file note
3ff19d7 Ignore local practice notes
e16ff6f Expand conversation-fix and review docs
65db485 Address race-fix edge cases and add edge regression tests
c6bf374 Document critical review in conversation transcript
3615d40 Add critical review of the race fix
dd41e66 Run race harness in CI
```

The assistant then said:

> The only uncommitted change is the transcript update in
> `ai-conversation-fix.md`; the branch is already one commit ahead because of
> the before-fix trace commit. I’m committing the transcript now, then I’ll push
> both local commits.

The assistant committed the transcript update:

```bash
git add ai-conversation-fix.md && git commit -m "$(cat <<'EOF'
Document before-and-after trace evidence

EOF
)" && git status --short --branch
```

Git reported:

```text
[race-fix 32376ad] Document before-and-after trace evidence
 1 file changed, 94 insertions(+)
## race-fix...origin/race-fix [ahead 2]
```

The assistant said:

> The transcript commit succeeded, and local `race-fix` is now ahead of GitHub
> by 2 commits. I’m pushing those commits to `origin/race-fix` and then I’ll
> verify the branch is synced.

The assistant tried to push:

```bash
git push origin race-fix && git status --short --branch
```

The push failed in the agent shell because it had no GitHub credentials:

```text
fatal: could not read Username for 'https://github.com': No such device or address
```

The assistant checked status again:

```bash
git status --short --branch
```

Git reported:

```text
## race-fix...origin/race-fix [ahead 2]
```

The assistant then told the user:

> Committed the transcript update:
>
> ```text
> 32376ad Document before-and-after trace evidence
> ```
>
> Local `race-fix` is clean and ahead of GitHub by 2 commits:
>
> ```text
> e8814dc Add before-and-after race traces
> 32376ad Document before-and-after trace evidence
> ```
>
> I tried to push, but this agent shell cannot authenticate to GitHub:
>
> ```text
> fatal: could not read Username for 'https://github.com'
> ```
>
> Run this in your normal terminal to update GitHub:
>
> ```bash
> git push origin race-fix
> ```
>
> After that, GitHub will match your local branch.

The user then asked:

> check again, if local files nad github, files are the same

The assistant replied:

> I’ll compare your local `race-fix` commit against `origin/race-fix` from
> GitHub. If fetch works, this will tell us definitively whether GitHub has the
> same commits.

The assistant fetched GitHub and checked status:

```bash
git fetch origin race-fix
git status --short --branch
```

Git reported:

```text
From https://github.com/Adenm2024/week4-2026
 * branch            race-fix   -> FETCH_HEAD
```

and:

```text
## race-fix...origin/race-fix
```

The assistant said:

> Fetch succeeded, and `git status` no longer shows “ahead”, which means your
> local tracking branch is likely synced with GitHub. I’m checking the exact
> commit hashes and diff to confirm there are no file differences.

The assistant compared local and GitHub hashes and diffs:

```bash
git rev-parse HEAD origin/race-fix
git diff --stat origin/race-fix..HEAD
git diff --stat HEAD..origin/race-fix
git log --oneline -n 5 --decorate
```

Git reported matching hashes:

```text
32376ad45dc8ee50bfb9880a217dc8d390c54405
32376ad45dc8ee50bfb9880a217dc8d390c54405
```

Both diff commands produced no output, meaning there were no local-only or
GitHub-only file differences.

The latest commits were:

```text
32376ad (HEAD -> race-fix, origin/race-fix) Document before-and-after trace evidence
e8814dc Add before-and-after race traces
808d468 Add reflection file note
3ff19d7 Ignore local practice notes
e16ff6f Expand conversation-fix and review docs
```

The assistant told the user:

> Yes. Local files and GitHub are the same on `race-fix`.
>
> Verified:
>
> ```text
> HEAD = origin/race-fix = 32376ad45dc8ee50bfb9880a217dc8d390c54405
> ```
>
> Latest commits on both:
>
> ```text
> 32376ad Document before-and-after trace evidence
> e8814dc Add before-and-after race traces
> ```
>
> There are no local-only or GitHub-only file differences.

The user then asked:

> Check if ec2 the same also

The assistant replied:

> I’ll try to check the EC2 clone directly using the previously referenced path
> `~/week4-2026` on `ubuntu@ip-172-31-0-34`, then compare its `HEAD` with
> `origin/race-fix`.

The assistant attempted to SSH:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=8 ubuntu@ip-172-31-0-34 'cd ~/week4-2026 && git fetch origin race-fix && printf "HEAD=" && git rev-parse HEAD && printf "origin/race-fix=" && git rev-parse origin/race-fix && git status --short --branch && git log --oneline -n 5 --decorate'
```

The SSH attempt failed:

```text
ssh: Could not resolve hostname ip-172-31-0-34: Name or service not known
```

The assistant said:

> That EC2 private hostname is not resolvable from this WSL environment, so I
> can’t SSH to it directly from here. I’ll check whether there’s an existing
> IDE terminal connected to EC2 that I can read for its latest state.

The assistant checked the available IDE terminals, but they were local WSL
terminals, not EC2 terminals.

The assistant then told the user:

> I could not check EC2 directly from here because this hostname does not
> resolve in WSL:
>
> ```text
> ubuntu@ip-172-31-0-34
> ```
>
> Run this on the EC2 terminal:
>
> ```bash
> cd ~/week4-2026
> git fetch origin race-fix
> git status --short --branch
> git rev-parse HEAD origin/race-fix
> git log --oneline -n 3 --decorate
> ```
>
> EC2 is up to date if both hashes print as:
>
> ```text
> 32376ad45dc8ee50bfb9880a217dc8d390c54405
> 32376ad45dc8ee50bfb9880a217dc8d390c54405
> ```
>
> If EC2 is behind, run:
>
> ```bash
> git pull --ff-only origin race-fix
> ```

The user then ran the EC2 commands and reported:

```text
ubuntu@ip-172-31-0-34:~/week4-2026$ git status --short --branch
## race-fix...origin/race-fix [behind 2]
ubuntu@ip-172-31-0-34:~/week4-2026$ git rev-parse HEAD origin/race-fix
808d46842095048c7f8fefdd8151471646f61173
32376ad45dc8ee50bfb9880a217dc8d390c54405
ubuntu@ip-172-31-0-34:~/week4-2026$ git log --oneline -n 3 --decorate
808d468 (HEAD -> race-fix) Add reflection file note
3ff19d7 Ignore local practice notes
e16ff6f Expand conversation-fix and review docs
ubuntu@ip-172-31-0-34:~/week4-2026$
```

The assistant answered:

> EC2 is **behind by 2 commits**. It does not yet have:
>
> ```text
> e8814dc Add before-and-after race traces
> 32376ad Document before-and-after trace evidence
> ```
>
> Since EC2 has no local changes shown, update it with:
>
> ```bash
> git pull --ff-only origin race-fix
> ```
>
> Then verify:
>
> ```bash
> git status --short --branch
> git rev-parse HEAD origin/race-fix
> git log --oneline -n 3 --decorate
> ```
>
> Expected result:
>
> ```text
> ## race-fix...origin/race-fix
> ```
>
> And both hashes should be:
>
> ```text
> 32376ad45dc8ee50bfb9880a217dc8d390c54405
> ```

The user then asked:

> do you capture all conversation here in ai-conversation-fix.md

The assistant answered:

> Not all of the latest conversation is captured yet.
>
> `ai-conversation-fix.md` includes the conversation up through:
>
> - creating `trace-before-fix.txt`
> - verifying old trace shows `BUG REPRODUCED`
> - verifying fixed `trace.txt` shows `no race observed`
> - committing `e8814dc Add before-and-after race traces`
>
> It does **not yet include** the latest follow-up where:
>
> - I committed `32376ad Document before-and-after trace evidence`
> - we confirmed GitHub/local are now the same
> - EC2 was checked and found **behind by 2 commits**
> - I told you to run `git pull --ff-only origin race-fix` on EC2
>
> So if you want the transcript fully current, we should append those latest
> sync/EC2 verification steps too.

The user then asked:

> append every word, and ensure all files are the same either local, github,
> and ec2

This section was appended in response to that request. The local repository and
GitHub were already verified to match at commit
`32376ad45dc8ee50bfb9880a217dc8d390c54405`. EC2 still needed to run:

```bash
git pull --ff-only origin race-fix
```

and then verify that `HEAD` and `origin/race-fix` both equal:

```text
32376ad45dc8ee50bfb9880a217dc8d390c54405
```
