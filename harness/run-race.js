// Race-condition harness for the Save / Publish bug.
//
// What this proves:
//   The hypothesis is that /publish does NOT wait for an in-flight /draft, so
//   when a save is mid-commit and publish arrives, publish reads the OLD value
//   of `currentDraft` and marks it live. This harness drives two scenarios
//   against the real server and produces a single timeline that shows whether
//   that ordering actually occurs.
//
// How it works:
//   1. Spawn app/server.js as a child process with:
//        TRACE_RACE=1            -> server emits timestamped trace lines
//        TRACE_START_MS=<epoch>  -> server's `t_ms` shares this process's epoch
//        SAVE_COMMIT_DELAY_MS=300-> wide enough race window to be deterministic
//        PORT=3100               -> avoids colliding with a dev server on 3000
//   2. Wait for the server to accept connections.
//   3. Run two scenarios against it:
//        A) Control: save -> await commit -> publish. Should publish the saved
//           value. If this fails, the bug is NOT a race; stop.
//        B) Race:    save A -> await -> save B (NOT awaited) -> publish
//           immediately. Hypothesis: publish returns "draft A".
//   4. Merge client-side and server-side trace lines (they share an epoch) and
//      write a chronological timeline to trace.txt at the repo root.
//   5. Exit 0 if the race reproduced (hypothesis confirmed), 1 if it did not.

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'app', 'server.js');
const TRACE_FILE = path.join(REPO_ROOT, 'trace.txt');

const PORT = 3100;
const SAVE_COMMIT_DELAY_MS = 300;
const TRACE_START_MS = Date.now();

// ---------------------------------------------------------------------------
// Trace buffer. Both client-side lines (produced here) and server-side lines
// (forwarded from the child's stderr) are appended here in arrival order. We
// sort them by their leading `[+NNNms]` timestamp before writing trace.txt so
// the final file reads as a single timeline.
// ---------------------------------------------------------------------------
const traceLines = [];

function nowMs() {
  return Date.now() - TRACE_START_MS;
}

function clientTrace(msg) {
  const dt = nowMs();
  const line = `[+${String(dt).padStart(5, ' ')}ms] [client       ] ${msg}`;
  traceLines.push(line);
  // Mirror to console so the user sees progress live.
  console.log(line);
}

function note(msg) {
  // Section headers: no timestamp, sorted to the top of their nearest block.
  const line = `--- ${msg} ---`;
  traceLines.push(line);
  console.log('\n' + line);
}

// ---------------------------------------------------------------------------
// Spawn the server with tracing on.
// ---------------------------------------------------------------------------
const server = spawn(process.execPath, [SERVER_PATH], {
  env: {
    ...process.env,
    PORT: String(PORT),
    TRACE_RACE: '1',
    TRACE_START_MS: String(TRACE_START_MS),
    SAVE_COMMIT_DELAY_MS: String(SAVE_COMMIT_DELAY_MS),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverStderrBuf = '';
server.stderr.on('data', (chunk) => {
  serverStderrBuf += chunk.toString();
  let nl;
  while ((nl = serverStderrBuf.indexOf('\n')) !== -1) {
    const line = serverStderrBuf.slice(0, nl);
    serverStderrBuf = serverStderrBuf.slice(nl + 1);
    if (line.trim()) {
      traceLines.push(line);
      console.log(line);
    }
  }
});

server.stdout.on('data', (chunk) => {
  // Server startup messages on stdout — informative only, not part of trace.
  process.stdout.write(`[server-stdout] ${chunk}`);
});

server.on('exit', (code, signal) => {
  if (code !== null && code !== 0) {
    console.error(`[harness] server exited with code ${code}`);
  } else if (signal) {
    console.error(`[harness] server killed by ${signal}`);
  }
});

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function post(pathname, body) {
  const opts = {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, opts);
  return res.json();
}

async function waitForServer(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/current`);
      if (res.ok) return;
    } catch (_) {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server did not start on port ${PORT} within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
async function scenarioControl() {
  note('SCENARIO A — control: save fully committed BEFORE publish');
  await post('/reset');
  clientTrace('save "control" SENT (will await commit)');
  const saved = await post('/draft', { content: 'control' });
  clientTrace(`save "control" RESPONSE received: ${JSON.stringify(saved)}`);
  clientTrace('publish SENT');
  const pub = await post('/publish');
  clientTrace(`publish RESPONSE: ${JSON.stringify(pub)}`);
  const ok = pub.published === 'control';
  clientTrace(
    `CONTROL RESULT: published=${JSON.stringify(pub.published)} ` +
      `(expected "control") -> ${ok ? 'OK' : 'UNEXPECTED FAILURE'}`,
  );
  return ok;
}

async function scenarioRace() {
  note('SCENARIO B — race: save B in flight when publish fires');
  await post('/reset');

  clientTrace('save "draft A" SENT (will await commit)');
  const a = await post('/draft', { content: 'draft A' });
  clientTrace(`save "draft A" RESPONSE: ${JSON.stringify(a)}`);

  // Fire save B WITHOUT awaiting. The server will buffer the request, start its
  // SAVE_COMMIT_DELAY_MS timer, and only assign currentDraft when that fires.
  clientTrace('save "draft B" SENT  (NOT awaited — in flight)');
  const savePromise = post('/draft', { content: 'draft B' });

  // Immediately fire publish. The hypothesis says publish will read
  // currentDraft NOW (still "draft A") and mark "draft A" live.
  clientTrace('publish SENT IMMEDIATELY (before save B can commit)');
  const publishPromise = post('/publish');

  const [bResp, pResp] = await Promise.all([savePromise, publishPromise]);
  clientTrace(`save "draft B" RESPONSE (eventual): ${JSON.stringify(bResp)}`);
  clientTrace(`publish RESPONSE: ${JSON.stringify(pResp)}`);

  // Sanity check what the server thinks is committed now.
  const cur = await (await fetch(`http://127.0.0.1:${PORT}/current`)).json();
  clientTrace(`/current after race: ${JSON.stringify(cur)}`);

  const stale = pResp.published !== 'draft B';
  clientTrace(
    `RACE RESULT: published=${JSON.stringify(pResp.published)} ` +
      `(expected "draft B") -> ${stale ? 'BUG REPRODUCED (stale value)' : 'no race observed'}`,
  );
  return stale;
}

// ---------------------------------------------------------------------------
// Sort the merged trace by timestamp prefix.
//   - Timestamped lines sort by their `[+NNNms]` prefix.
//   - Section headers (lines starting with `--- `) anchor to the next
//     timestamped line (sort just before it).
//   - Other untimestamped lines (e.g. summary block) inherit the timestamp of
//     the most recent timestamped line, so they stay at the end where they
//     were emitted instead of floating to t=0.
// ---------------------------------------------------------------------------
function sortTrace(lines) {
  const TS = /^\[\+\s*(\d+)ms\]/;
  const annotated = [];
  let pendingHeader = null;
  let lastTimestamp = 0;

  for (const line of lines) {
    if (line.startsWith('--- ')) {
      pendingHeader = line;
      continue;
    }
    const m = line.match(TS);
    const t = m ? parseInt(m[1], 10) : lastTimestamp;
    if (m) lastTimestamp = t;
    if (pendingHeader) {
      annotated.push({ t, sub: -1, line: pendingHeader });
      pendingHeader = null;
    }
    annotated.push({ t, sub: annotated.length, line });
  }
  if (pendingHeader) {
    annotated.push({ t: lastTimestamp, sub: annotated.length, line: pendingHeader });
  }

  annotated.sort((a, b) => (a.t - b.t) || (a.sub - b.sub));
  return annotated.map((x) => x.line);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  let exitCode = 0;
  let raceReproduced = false;
  let summary = '';
  try {
    await waitForServer();
    clientTrace(
      `harness up: PORT=${PORT}, SAVE_COMMIT_DELAY_MS=${SAVE_COMMIT_DELAY_MS}, ` +
        `TRACE_START_MS epoch shared with server`,
    );

    const controlOk = await scenarioControl();
    if (!controlOk) {
      console.error(
        '\n[harness] Control scenario failed — bug is NOT just a timing race. Stopping.',
      );
      exitCode = 2;
    } else {
      raceReproduced = await scenarioRace();

      // Print the summary live to the console so the user sees it, but keep
      // it out of the merged trace timeline — it belongs as a footer in
      // trace.txt, not inline with timestamped events.
      const summaryLines = [
        '',
        '--- SUMMARY ---',
        `control scenario:     ${controlOk ? 'PASS (publish saw the saved value)' : 'FAIL'}`,
        `race scenario:        ${raceReproduced ? 'BUG REPRODUCED (publish saw stale value)' : 'no race observed'}`,
        '',
        'Interpretation:',
      ];

      if (raceReproduced) {
        summaryLines.push(
          '  - When publish is fired while a save is still in flight, publish reads',
          '    the PREVIOUS value and marks it live. That is the race.',
          '',
          '  In the trace above, look for this pattern in scenario B:',
          '    [server]  draft.received   content="draft B"            <-- save B request received',
          '    [server]  publish.received currentDraftRead="draft A"   <-- publish reads OLD value',
          '    [server]  publish.assigned publishedDraft="draft A"     <-- and marks it live',
          '    [server]  draft.committed  content="draft B"            <-- save B finally commits, too late',
        );
      } else {
        summaryLines.push(
          '  - Publish was fired while save B was still in flight, but it waited',
          '    for the pending save to commit before reading currentDraft.',
          '',
          '  In the trace above, look for this fixed pattern in scenario B:',
          '    [server]  draft.received   content="draft B"              <-- save B request received',
          '    [server]  publish.received currentDraftBeforeWait="draft A" <-- publish arrives during the old state',
          '    [server]  draft.committed  content="draft B"              <-- save B commits',
          '    [server]  publish.read     currentDraftRead="draft B"     <-- publish reads the committed new value',
          '    [server]  publish.assigned publishedDraft="draft B"       <-- and marks the new value live',
        );
      }
      summary = summaryLines.join('\n');
      console.log(summary);

      exitCode = raceReproduced ? 0 : 1;
    }
  } catch (err) {
    console.error('[harness] error:', err);
    exitCode = 3;
  } finally {
    server.kill('SIGTERM');
    // Give stderr a moment to flush before we sort and write.
    await new Promise((r) => setTimeout(r, 100));

    const sorted = sortTrace(traceLines);
    const header = [
      '# Race-condition harness trace',
      `# Generated: ${new Date().toISOString()}`,
      `# PORT=${PORT}  SAVE_COMMIT_DELAY_MS=${SAVE_COMMIT_DELAY_MS}  TRACE_START_MS=${TRACE_START_MS}`,
      '#',
      '# Lines from [client       ] are emitted by harness/run-race.js.',
      '# Lines from [server #NNN  ] are emitted by app/server.js when TRACE_RACE=1.',
      '# All `[+NNNms]` deltas share the same epoch, so this is one merged timeline.',
      '',
    ].join('\n');
    const footer = summary ? '\n' + summary + '\n' : '';
    fs.writeFileSync(TRACE_FILE, header + sorted.join('\n') + '\n' + footer);
    console.log(`\n[harness] trace written to ${TRACE_FILE}`);
    console.log(`[harness] exit code: ${exitCode}`);
    process.exit(exitCode);
  }
})();
