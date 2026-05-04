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
