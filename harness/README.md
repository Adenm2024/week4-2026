# Race-condition harness

Purpose: prove that the Save / Publish bug in `app/server.js` is a race
condition between an in-flight `POST /draft` and a `POST /publish` that does
not wait for it.

## Run it

```bash
npm run harness
```

The harness will:

1. Spawn `app/server.js` as a child process on port `3100` with tracing on
   (`TRACE_RACE=1`) and the save-commit delay set to 300ms.
2. Run two scenarios against it:
   - **Control** — save a value, await its commit, then publish. This must
     publish the saved value. If it doesn't, the bug is not a timing race.
   - **Race** — save A and await it (so it commits), then send save B
     **without** awaiting, then immediately fire publish. The hypothesis is
     that publish reads `currentDraft` *before* save B's commit timer fires
     and so publishes the stale value `"draft A"`.
3. Merge client-side and server-side timestamped trace lines (they share an
   epoch via the `TRACE_START_MS` env var) and write the unified timeline to
   `trace.txt` at the repo root.

Exit code:

| code | meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| 0    | Race reproduced — hypothesis confirmed.                            |
| 1    | Race did not reproduce — hypothesis not confirmed by this run.     |
| 2    | Control scenario itself failed — the bug is not (just) a race.     |
| 3    | Harness error (server failed to start, fetch crashed, etc).        |

## What "race confirmed" looks like in `trace.txt`

In a confirmed run you'll see this pattern in scenario B:

```
[server] draft.received    content="draft B"            <- save B accepted
[server] publish.received  currentDraftRead="draft A"   <- publish reads OLD value
[server] publish.assigned  publishedDraft="draft A"     <- and marks it live
[server] draft.committed   content="draft B"            <- save B finally lands, too late
```

That is the bug: `/publish` does not wait for in-flight `/draft` requests, so
it can read and publish the previous committed value while the latest save's
`setTimeout` callback hasn't run yet.

## Why this stays separate from the fix

The harness only **observes**. The trace logging in `app/server.js` is gated
behind `TRACE_RACE=1` and changes no behavior — the existing `npm test`
suite is unaffected.
