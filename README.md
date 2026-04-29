# Week 4 Individual Assignment: Debug This With AI

This repo contains a small Node/Express app with a known race condition between save and publish. Your job is to **direct AI through the debugging loop** for it: instrument, prove the bug, fix it, get a fresh AI to review the fix, and ship it through PR-gated CI.

The full assignment description, rubric, reflection questions, and submission instructions are in the **`week4_assignment.md`** posted in Canvas. Read that first — this README only covers what's in the repo and how to run it.

---

## Quick start

You need Node.js 20 or higher.

```bash
git clone <this-repo>
cd <repo-name>
npm install
npm start
```

Open http://localhost:3000 in a browser.

---

## What's in the repo

```
app/
  server.js       The Express app. The bug is in here.
  static/
    index.html    Frontend — a textarea, Save button, Publish button.

harness/          Empty. You fill this with your test harness.

tests/
  race.test.js    The pre-written regression test. Don't modify it.
                  Your fix needs to make this test pass.

.github/
  workflows/
    test.yml      CI workflow. Runs the regression test on every PR.

package.json      Dependencies and scripts.
```

---

## See the bug

Run the app, open it in a browser, and try this:

1. Type `hello` in the textarea.
2. Click **Save**. The status log should show "save sent" and "save committed".
3. Type ` world` (so the textarea now reads `hello world`).
4. **Immediately** — within about 200ms — click **Publish**.
5. Look at the published content at the bottom of the page.

If you clicked Publish fast enough, the published content is `hello`, not `hello world`. The save for `hello world` was still in flight when publish read the state, so publish saw the old value.

That's the bug. It's in `app/server.js` — open it and you can see the cause.

---

## Run the regression test

```bash
npm test
```

Against the broken code, the race test fails and the no-race test passes:

```
# pass 1
# fail 1
```

Once you've applied a correct fix, both tests pass:

```
# pass 2
# fail 0
```

---

## Where to do your work

Your work happens on a branch in your fork. Create a branch (something like `fix/race-condition`), commit your harness, instrumentation, fix, and AI conversations there, push, open a PR into `main` of your fork. CI runs on the PR. When checks are green, you've passed the gate.

The full submission flow is in the assignment doc on Canvas.

---

## Hints (read only if stuck on the mechanics, not on the bug itself)

- **Running the app.** `npm start` runs the server on port 3000. To free the port, Ctrl-C the process.

- **Adjusting the race timing.** The save endpoint has an artificial commit delay controlled by `SAVE_COMMIT_DELAY_MS` (defaults to 200ms). If your harness needs different timing, set the env var: `SAVE_COMMIT_DELAY_MS=500 npm start`.

- **The `/reset` endpoint.** Useful for harnesses that need to start each scenario fresh. POST to `/reset` and the server clears its state.

- **CI failures.** Open the Actions tab on your PR, click the failing run, click the failing step. The error is in the last few lines of the log.

For everything else (what the harness should do, what AI prompts to use, how to think about the review step), see the assignment doc and the study guide.
