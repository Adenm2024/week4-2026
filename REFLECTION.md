# Reflection

## On building the apparatus

### 1. Why do we create a harness? Why is it worth the time, instead of just asking AI to fix the bug directly?

I built the harness because the bug was a timing race — running the app and hoping `/publish` happened to land between `/draft`'s `await` and its commit would have surfaced the failure maybe one run in fifty, with no proof of which interleaving I'd actually hit. The harness deterministically forces the bad ordering and reports "race observed" / "no race observed", so I get a binary, reproducible signal both *before* the fix (it must fire) and *after* (it must stop firing). Asking AI to fix the bug directly skips that signal entirely — I'd be trusting that the patch works, instead of demonstrating it.

### 2. Why is isolation important? Why does the harness drive the failing code path under controlled conditions instead of running the full app and hoping the bug fires?

The full app has logging, the Express middleware stack, body parsing, and HTTP latency all wrapped around the bug — none of which are part of the race itself, and all of which add noise that can hide or perturb the timing window. The harness drives `/draft` and `/publish` with a controlled `SAVE_COMMIT_DELAY_MS` so the in-flight save is guaranteed to overlap the publish, instead of relying on real-world network/scheduling jitter to occasionally land there. That control is what made `npm run harness` a useful regression check: it doesn't just *test* the fix, it *proves* the failing interleaving no longer wins.

### 3. How does modular design help in debugging?

`app/server.js` already had a clean seam — `/draft` owned the save, `/publish` owned the read, and the only shared state was `currentDraft` and `pendingSave`. That meant the fix lived in roughly twenty lines: serialize saves into a chain, gate commits on `saveEpoch`, and have `/publish` await the chain. If the same logic had been buried in a 500-line monolithic handler with validation, persistence, response shaping, and tracing all interleaved, just finding the read-after-write seam would have taken longer than the actual fix, and any patch would carry collateral risk to unrelated code paths.

---

## On the review

### 4. What kinds of problems with a fix can a code review catch that an automated test cannot?

Contract and design omissions — failures the tests don't exercise because nobody thought to assert them. A test verifies behavior against an assumption; if the assumption itself is missing or wrong, there is nothing for a test to fail on. In my review, this showed up as `/reset` vs `/publish` having no defined contract, an `onrejected` arm in `/draft` that was structurally unreachable, and a `.catch(() => {})` that would silently mask any future commit-path exception — none of which any green test could surface.

### 5. Quote from the review.

From `review.md`:

> "What is the contract for `/publish` when `/reset` is called concurrently? It is not in the comments, not in tests, and the implementation does not enforce one."

Testing alone couldn't have surfaced this because the original test suite only covered `/draft` vs `/publish`; nobody had written a `/reset`-mid-publish test, and you can't fail an assertion you never wrote. The reviewer was pointing at a *missing* contract, not a broken one — exactly the class of issue a human reads code to find. That single comment is what drove the real code change in `/publish` to capture `epochAtEntry` and return `409` if `saveEpoch` shifted during the await, plus the new edge test `/reset during /publish await is detected via the epoch check`.
