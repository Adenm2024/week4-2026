// race-harness.js — drive the save/publish race deterministically and
// produce a unified timeline that proves the bug is a race condition.
//
// What this does, at a high level:
//   1. Starts the app in-process with TRACE_RACE=1 so server-side events
//      (draft.received, draft.committed, publish.received) are recorded.
//   2. For each scenario, runs:
//        - reset
//        - save("draft A") and wait for commit
//        - save("draft B") WITHOUT awaiting   (in-flight save)
//        - sleep(publishOffsetMs)
//        - publish()
//      with a different publishOffsetMs each time.
//   3. Merges client-side trace events (request sent / response received)
//      with the server-side trace events into one timeline.
//   4. Reports, per scenario, whether publish saw the in-flight value
//      (correct) or the previous committed value (the race firing).
//
// Why this proves "race condition":
//   The bug appears IFF /publish hits the server while /draft for "draft B"
//   is still in flight — i.e. publish.received's timestamp falls between
//   draft.received("draft B") and draft.committed("draft B"). When publish
//   is delayed past the commit, the bug disappears. That timing-dependent
//   appearance is the literal definition of a race condition.
//
// Run with:
//     node harness/race-harness.js
//
// Optional env vars:
//     SAVE_COMMIT_DELAY_MS   Override server-side commit delay (default 300).
//     OFFSETS                Comma-separated publish offsets in ms (default
//                            "0,50,150,400,500", chosen so two values land
//                            outside the in-flight window).

'use strict';

// Synchronize the server's clock to ours so the merged timeline lines up.
const TRACE_START_MS = Date.now();
process.env.TRACE_RACE = '1';
process.env.TRACE_START_MS = String(TRACE_START_MS);
process.env.SAVE_COMMIT_DELAY_MS =
  process.env.SAVE_COMMIT_DELAY_MS || '300';

const app = require('../app/server.js');
const { traceEvents } = app;

const SAVE_DELAY = parseInt(process.env.SAVE_COMMIT_DELAY_MS, 10);
const OFFSETS = (process.env.OFFSETS || '0,50,150,400,500')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n));

let baseUrl;
const clientEvents = [];

function clientTrace(event, data) {
  const evt = {
    seq: clientEvents.length,
    t_ms: Date.now() - TRACE_START_MS,
    side: 'client',
    event,
    ...(data || {}),
  };
  clientEvents.push(evt);
  return evt;
}

async function http(method, urlPath, body) {
  const opts = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  };
  clientTrace(`${method} ${urlPath} sent`, body || {});
  const res = await fetch(baseUrl + urlPath, opts);
  const json = await res.json();
  clientTrace(`${method} ${urlPath} returned`, json);
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clearTraces() {
  traceEvents.length = 0;
  clientEvents.length = 0;
}

function mergedTimeline() {
  const server = traceEvents.map((e) => ({ ...e, side: 'server' }));
  return [...server, ...clientEvents].sort((a, b) => {
    if (a.t_ms !== b.t_ms) return a.t_ms - b.t_ms;
    if (a.side !== b.side) return a.side === 'client' ? -1 : 1;
    return a.seq - b.seq;
  });
}

function printTimeline() {
  const events = mergedTimeline();
  if (events.length === 0) {
    console.log('  (no events)');
    return;
  }
  const t0 = events[0].t_ms;
  for (const e of events) {
    const dt = String(e.t_ms - t0).padStart(5, ' ');
    const detail = Object.keys(e)
      .filter(
        (k) =>
          k !== 'seq' && k !== 't_ms' && k !== 'event' && k !== 'side',
      )
      .map((k) => `${k}=${JSON.stringify(e[k])}`)
      .join(' ');
    console.log(
      `  +${dt}ms  [${e.side.padEnd(6)}]  ${e.event.padEnd(28)} ${detail}`,
    );
  }
}

function diagnose() {
  const recvB = traceEvents.find(
    (e) => e.event === 'draft.received' && e.content === 'draft B',
  );
  const commitB = traceEvents.find(
    (e) => e.event === 'draft.committed' && e.content === 'draft B',
  );
  const pubReceived = traceEvents.find((e) => e.event === 'publish.received');
  const pubRead =
    traceEvents.find((e) => e.event === 'publish.read') || pubReceived;

  if (!recvB || !commitB || !pubReceived || !pubRead) {
    return { verdict: 'incomplete trace', inFlight: null };
  }
  const inFlight =
    pubReceived.t_ms >= recvB.t_ms && pubReceived.t_ms < commitB.t_ms;
  return {
    inFlight,
    recvB_ms: recvB.t_ms,
    commitB_ms: commitB.t_ms,
    publishReceived_ms: pubReceived.t_ms,
    publishRead_ms: pubRead.t_ms,
    publishBeforeWait: pubReceived.currentDraftBeforeWait,
    publishRead: pubRead.currentDraftRead,
  };
}

async function runScenario(publishOffsetMs) {
  clearTraces();

  await http('POST', '/reset');
  await http('POST', '/draft', { content: 'draft A' });

  const t0 = Date.now() - TRACE_START_MS;
  clientTrace('scenario.begin', { publishOffsetMs, t0_relative_ms: t0 });

  const savePromise = http('POST', '/draft', { content: 'draft B' });
  await sleep(publishOffsetMs);
  const publishPromise = http('POST', '/publish');

  const [, publishResult] = await Promise.all([savePromise, publishPromise]);

  const published = publishResult.published;
  const saw = published === 'draft B' ? 'draft B (in-flight value)'
            : published === 'draft A' ? 'draft A (stale value)'
            :                            JSON.stringify(published);
  const expected = 'draft B';
  const correct = published === expected;
  const d = diagnose();

  return {
    publishOffsetMs,
    published,
    saw,
    correct,
    diag: d,
  };
}

function header(s) {
  console.log('\n' + '='.repeat(72));
  console.log(s);
  console.log('='.repeat(72));
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;

  header(
    `race harness — SAVE_COMMIT_DELAY_MS=${SAVE_DELAY}ms, ` +
      `offsets=[${OFFSETS.join(', ')}]ms`,
  );
  console.log(
    'For each scenario:\n' +
      '  1. POST /draft "draft A" and wait for commit.\n' +
      '  2. POST /draft "draft B" WITHOUT awaiting.\n' +
      '  3. Sleep publishOffsetMs.\n' +
      '  4. POST /publish.\n' +
      'Broken code races when publish reads inside [draft B received, draft B committed].',
  );

  const results = [];
  for (const off of OFFSETS) {
    header(`SCENARIO  publishOffsetMs = ${off}`);
    const r = await runScenario(off);
    results.push(r);

    console.log(`published value:   ${JSON.stringify(r.published)}`);
    console.log(`interpretation:    publish saw ${r.saw}`);
    if (r.diag.recvB_ms != null) {
      const window = `[${r.diag.recvB_ms}ms, ${r.diag.commitB_ms}ms)`;
      console.log(
        `draft B in-flight window: ${window}`,
      );
      console.log(
        `publish received at: ${r.diag.publishReceived_ms}ms    publish read at: ${r.diag.publishRead_ms}ms`,
      );
      console.log(
        `publish.received was ${r.diag.inFlight ? 'INSIDE' : 'OUTSIDE'} the in-flight window`,
      );
    }
    console.log('\nmerged timeline (relative ms; server + client):');
    printTimeline();
  }

  header('SUMMARY');
  console.log(
    'offset(ms) | publish saw                      | timing/result',
  );
  console.log(
    '-----------|----------------------------------|------------------------------------------',
  );
  for (const r of results) {
    const off = String(r.publishOffsetMs).padStart(10);
    const saw = r.saw.padEnd(32);
    const where =
      r.diag.inFlight === true && r.correct
        ? 'INSIDE  -> waited for save (correct)'
        : r.diag.inFlight === true
          ? 'INSIDE  -> race fires (stale)'
          : r.diag.inFlight === false
          ? 'OUTSIDE -> no race (correct)'
          : '(unknown)';
    console.log(`${off} | ${saw} | ${where}`);
  }

  const sawStale = results.some((r) => !r.correct);
  const sawCorrect = results.some((r) => r.correct);
  console.log('');
  if (sawStale && sawCorrect) {
    console.log(
      'CONCLUSION: the bug is timing-dependent. publish returns the wrong\n' +
        'value precisely when it lands inside the draft-B in-flight window,\n' +
        'and returns the right value when it lands outside it. That is the\n' +
        'literal definition of a race condition between /draft and /publish.',
    );
  } else if (sawStale && !sawCorrect) {
    console.log(
      'All scenarios returned stale data. The publish offsets did not span\n' +
        'past the commit; try OFFSETS that exceed SAVE_COMMIT_DELAY_MS.',
    );
  } else {
    console.log(
      'No stale reads observed. The race may have been masked by a fix\n' +
        'already applied, or the offsets all landed outside the in-flight\n' +
        'window. Re-run with OFFSETS=0,50 to force in-window publishes.',
    );
  }

  server.close();
}

main().catch((err) => {
  console.error('harness failed:', err);
  process.exit(1);
});
