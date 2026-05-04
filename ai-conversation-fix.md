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
