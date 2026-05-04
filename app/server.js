// Save-and-Publish Draft Editor
//
// Race condition between /draft and /publish is fixed by serializing saves
// behind `pendingSave` and having /publish await it before reading.
// This file also handles the edge cases listed in `review.md`:
//   - /reset during a /publish await (epoch check after await).
//   - /reset between queued saves (per-save epoch check at commit time).
//   - Stuck save (Promise.race against SAVE_MAX_WAIT_MS).
//   - Discarded save returns 409 instead of misleading "ok: true".
//   - Body size limit and per-request content length cap (413).
//   - Empty content and non-ASCII content pass through unchanged.
//   - Client disconnect: response writes are guarded by `safeJson`.
//   - Many concurrent saves: each save's response is bound to its own commit.

const express = require('express');
const path = require('path');

const app = express();

// Explicit body limit. Any larger body is rejected with 413 by Express's
// JSON parser; the error is normalized to JSON in the error handler below.
const BODY_LIMIT = process.env.BODY_LIMIT || '256kb';
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.static(path.join(__dirname, 'static')));

// ---------------------------------------------------------------------------
// In-memory storage
// ---------------------------------------------------------------------------
let currentDraft = '';
let publishedDraft = '';
let pendingSave = Promise.resolve();
// Bumped on /reset. Each in-flight /draft captures the epoch at request time
// and refuses to commit if the epoch has changed by the time its setTimeout
// fires. /publish also captures the epoch and refuses to publish if /reset
// happened during its await.
let saveEpoch = 0;

// Tunables.
const SAVE_COMMIT_DELAY_MS = parseInt(
  process.env.SAVE_COMMIT_DELAY_MS || '200',
  10,
);
// Maximum time /publish will wait for `pendingSave` before treating it as
// stuck. Defends against suspended VMs, clock skew, or fake-timer test setups
// that could otherwise leave `pendingSave` permanently unsettled.
const SAVE_MAX_WAIT_MS = parseInt(
  process.env.SAVE_MAX_WAIT_MS ||
    String(Math.max(5000, SAVE_COMMIT_DELAY_MS * 10)),
  10,
);
// Per-request content length cap, in characters. Independent of BODY_LIMIT
// so that a small JSON envelope carrying a huge string is still rejected
// even if it fits within BODY_LIMIT bytes.
const MAX_CONTENT_CHARS = parseInt(
  process.env.MAX_CONTENT_CHARS || '65536',
  10,
);

// ---------------------------------------------------------------------------
// Optional trace logging (instrumentation only — no behavior change)
// ---------------------------------------------------------------------------
const TRACE = process.env.TRACE_RACE === '1';
const TRACE_START_MS = parseInt(
  process.env.TRACE_START_MS || String(Date.now()),
  10,
);
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
  const detail = Object.keys(evt)
    .filter((k) => k !== 'seq' && k !== 't_ms' && k !== 'event')
    .map((k) => `${k}=${JSON.stringify(evt[k])}`)
    .join(' ');
  process.stderr.write(
    `[+${String(evt.t_ms).padStart(5, ' ')}ms] [server #${String(evt.seq).padStart(3, '0')}] ${event} ${detail}\n`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Race `promise` against a timeout. Resolves with the promise's value if it
// settles first; rejects with a timeout error otherwise. Always clears the
// underlying timer so we don't leak handles.
function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Send a JSON response only if the underlying socket is still writable. A
// destroyed socket or an already-aborted request is a no-op rather than a
// thrown error that would crash the handler.
function safeJson(res, status, body) {
  const closed =
    res.headersSent ||
    res.writableEnded ||
    (res.socket && res.socket.destroyed) ||
    (res.req && res.req.aborted);
  if (closed) {
    trace('response.skipped', { status, reason: 'socket closed' });
    return;
  }
  try {
    res.status(status).json(body);
  } catch (err) {
    trace('response.error', { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// POST /draft — save the current draft text.
//
// Each save is queued behind the previous one. /publish awaits the same
// promise so it never reads currentDraft mid-commit. Each save also captures
// the epoch at request time; if /reset bumps the epoch before the save's
// timer fires, the save is discarded and the HTTP response is 409.
app.post('/draft', (req, res) => {
  const body = req.body || {};
  const { content } = body;
  if (typeof content !== 'string') {
    return safeJson(res, 400, { error: 'content must be a string' });
  }
  if (content.length > MAX_CONTENT_CHARS) {
    return safeJson(res, 413, {
      error: `content exceeds ${MAX_CONTENT_CHARS} chars`,
      length: content.length,
    });
  }

  trace('draft.received', { content });
  const epoch = saveEpoch;

  // The .catch arm logs swallowed errors instead of silently dropping them,
  // so a future bug in the commit path is visible rather than invisible.
  pendingSave = pendingSave
    .catch((err) => {
      trace('chain.error.swallowed', { error: String(err) });
    })
    .then(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            const committed = epoch === saveEpoch;
            if (committed) {
              currentDraft = content;
              trace('draft.committed', { content });
            } else {
              trace('draft.discarded', {
                content,
                epoch,
                currentEpoch: saveEpoch,
              });
            }
            resolve({ committed });
          }, SAVE_COMMIT_DELAY_MS);
        }),
    );

  pendingSave.then(
    (result) => {
      if (result && result.committed) {
        safeJson(res, 200, { ok: true, saved: content });
      } else {
        safeJson(res, 409, {
          ok: false,
          error: 'save discarded: state was reset before commit',
        });
      }
    },
    (err) => {
      safeJson(res, 500, { error: 'save failed', detail: String(err) });
    },
  );
});

// POST /publish — mark the most recent saved draft as live.
//
// Wait for any in-flight save to commit before reading currentDraft. Capture
// the epoch at entry and re-check after the await so a /reset that races
// with the publish is detected and the publish aborts with 409 instead of
// publishing stale or cleared state.
app.post('/publish', async (req, res) => {
  const epochAtEntry = saveEpoch;
  trace('publish.received', { currentDraftBeforeWait: currentDraft });

  let timedOut = false;
  try {
    await withTimeout(pendingSave, SAVE_MAX_WAIT_MS, 'publish.await');
  } catch (err) {
    timedOut = true;
    trace('publish.await.failed', { error: String(err) });
  }

  if (saveEpoch !== epochAtEntry) {
    trace('publish.aborted.reset', { epochAtEntry, saveEpoch });
    return safeJson(res, 409, {
      ok: false,
      error: 'publish aborted: state was reset during await',
      epochAtEntry,
      saveEpoch,
    });
  }

  if (timedOut) {
    trace('publish.proceeding.afterTimeout', { currentDraft });
  }

  trace('publish.read', { currentDraftRead: currentDraft });
  publishedDraft = currentDraft;
  trace('publish.assigned', { publishedDraft });
  safeJson(res, 200, { ok: true, published: publishedDraft });
});

// GET /published — return the currently published draft.
app.get('/published', (req, res) => {
  safeJson(res, 200, { published: publishedDraft });
});

// GET /current — return the currently saved (committed) draft.
app.get('/current', (req, res) => {
  safeJson(res, 200, { current: currentDraft });
});

// Reset endpoint for tests.
app.post('/reset', (req, res) => {
  saveEpoch += 1;
  currentDraft = '';
  publishedDraft = '';
  pendingSave = Promise.resolve();
  trace('reset', { newEpoch: saveEpoch });
  safeJson(res, 200, { ok: true });
});

// Express error handler: turn body-parser errors into structured JSON
// instead of the default HTML error page.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return safeJson(res, 413, { error: 'request body too large' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return safeJson(res, 400, { error: 'invalid JSON body' });
  }
  return safeJson(res, 500, { error: 'internal error', detail: String(err) });
});

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Draft editor running on http://localhost:${PORT}`);
    console.log(`SAVE_COMMIT_DELAY_MS = ${SAVE_COMMIT_DELAY_MS}`);
    console.log(`SAVE_MAX_WAIT_MS = ${SAVE_MAX_WAIT_MS}`);
    console.log(`MAX_CONTENT_CHARS = ${MAX_CONTENT_CHARS}`);
    console.log(`BODY_LIMIT = ${BODY_LIMIT}`);
  });
}

module.exports = app;
module.exports.traceEvents = traceEvents;
