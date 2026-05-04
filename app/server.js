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
// Note the artificial delay: the draft is not committed to currentDraft
// until SAVE_COMMIT_DELAY_MS milliseconds after the request arrives.
app.post('/draft', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }

  trace('draft.received', { content });

  // Simulate write latency.
  setTimeout(() => {
    currentDraft = content;
    trace('draft.committed', { content });
    res.json({ ok: true, saved: content });
  }, SAVE_COMMIT_DELAY_MS);
});

// POST /publish — mark the most recent saved draft as live.
//
// THE BUG: this reads currentDraft *immediately*. If a /draft request is
// in flight (its timeout hasn't fired), publishedDraft will be set to the
// older saved value, not the in-flight one.
app.post('/publish', (req, res) => {
  trace('publish.received', { currentDraftRead: currentDraft });
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
  currentDraft = '';
  publishedDraft = '';
  trace('reset');
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
