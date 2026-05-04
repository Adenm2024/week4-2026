// Save-and-Publish Draft Editor
//
// This app has a known race condition between /draft and /publish.
// See README.md for the bug description and what you're being asked to do.

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'static')));

// ---------------------------------------------------------------------------
// In-memory storage
// ---------------------------------------------------------------------------
// `currentDraft` is the most recent saved draft.
// `publishedDraft` is what /publish has marked as live.
//
// In a real app these would live in a database. For this assignment, in-memory
// is fine — the bug is in the timing, not the storage.
let currentDraft = '';
let publishedDraft = '';
let pendingSave = Promise.resolve();
// Bumped on /reset. Each in-flight /draft captures the epoch at request time
// and refuses to commit if the epoch has changed by the time its setTimeout
// fires, so a save that started before /reset can't clobber post-reset state.
let saveEpoch = 0;

// SAVE_COMMIT_DELAY_MS controls how long a /draft request takes to commit.
// In production this would represent database write latency, network latency,
// or any other delay between "request received" and "value updated."
//
// Set to 200ms by default to make the race condition reliably reproducible.
// Tests may override this via environment variable.
const SAVE_COMMIT_DELAY_MS = parseInt(process.env.SAVE_COMMIT_DELAY_MS || '200', 10);

// ---------------------------------------------------------------------------
// Optional trace logging (instrumentation only — no behavior change)
// ---------------------------------------------------------------------------
// Off by default. Enable with TRACE_RACE=1. When enabled, every /draft
// arrival/commit and every /publish read records a structured event with a
// monotonic millisecond timestamp. Events are:
//   1) appended to the `traceEvents` array exported from this module, so an
//      in-process harness (see /harness) can read them programmatically, and
//   2) mirrored to stderr as a single human-readable line.
//
// TRACE_START_MS lets a harness pin the server's clock to the same epoch the
// harness uses, so server-side and client-side deltas line up in one timeline.
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
  const detail = Object.keys(evt)
    .filter((k) => k !== 'seq' && k !== 't_ms' && k !== 'event')
    .map((k) => `${k}=${JSON.stringify(evt[k])}`)
    .join(' ');
  process.stderr.write(
    `[+${String(evt.t_ms).padStart(5, ' ')}ms] [server #${String(evt.seq).padStart(3, '0')}] ${event} ${detail}\n`,
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// POST /draft — save the current draft text.
//
// Each save is queued behind the previous one. That gives /publish a single
// promise to await so it never reads currentDraft while a save is mid-commit.
app.post('/draft', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }

  trace('draft.received', { content });
  const epoch = saveEpoch;

  // .catch(() => {}) keeps the chain consumable: if a previous save's promise
  // ever rejects, this swallows it so the new save (and every later /publish
  // awaiting pendingSave) still runs instead of silently inheriting a
  // poisoned chain.
  pendingSave = pendingSave.catch(() => {}).then(
    () =>
      new Promise((resolve) => {
        // Simulate write latency.
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
});

// POST /publish — mark the most recent saved draft as live.
//
// Wait for any in-flight save to commit before reading currentDraft.
app.post('/publish', async (req, res) => {
  trace('publish.received', { currentDraftBeforeWait: currentDraft });
  // /draft swallows rejections, so pendingSave should always be fulfilled.
  // Defend against a future change that breaks that invariant — a rejection
  // here must not take down the publish handler.
  try {
    await pendingSave;
  } catch (_) {
    // Fall through and publish whatever is currently committed.
  }
  trace('publish.read', { currentDraftRead: currentDraft });
  publishedDraft = currentDraft;
  trace('publish.assigned', { publishedDraft });
  res.json({ ok: true, published: publishedDraft });
});

// GET /published — return the currently published draft.
app.get('/published', (req, res) => {
  res.json({ published: publishedDraft });
});

// GET /current — return the currently saved (committed) draft.
app.get('/current', (req, res) => {
  res.json({ current: currentDraft });
});

// Reset endpoint for tests.
app.post('/reset', (req, res) => {
  saveEpoch += 1;
  currentDraft = '';
  publishedDraft = '';
  pendingSave = Promise.resolve();
  trace('reset', { newEpoch: saveEpoch });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Draft editor running on http://localhost:${PORT}`);
    console.log(`SAVE_COMMIT_DELAY_MS = ${SAVE_COMMIT_DELAY_MS}`);
  });
}

module.exports = app;
module.exports.traceEvents = traceEvents;
