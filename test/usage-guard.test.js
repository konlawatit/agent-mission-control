/**
 * Usage guard and dashboard API checks: the guard acting on the latest /usage reading with no
 * polling (one timer during a hold), the "finish the step, then hold" pause, checkpoint files,
 * resume after reset, prompt blocking during a hold, usage-guard.json from older versions, the
 * removed always-on usage paths, the on-request context endpoint, and the model/effort and
 * VS Code endpoints.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Isolate from the developer's real ~/.claude and ~/.agent-mission-control.
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-guard-home-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

const { StateStore } = require('../src/state-store');
const { UsageGuard } = require('../src/usage-guard');
const { createMissionControlServer } = require('../src/server');
const { getContextWindowTokens, encodeProjectDir } = require('../src/transcript-parser');

const TOKEN = 'a'.repeat(48);
const HOUR = 3600 * 1000;

function request(port, { method = 'GET', urlPath = '/', body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'X-AMC-Token': TOKEN };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function makeRoom(store, id, cwd, status) {
  const s = store.getOrCreateSession(id, { cwd, room: id, status, goal: `goal of ${id}` });
  s.status = status;
  s.lifecycle = 'live';
  return s;
}

/** A /usage reading as the checker hands it over. */
function reading(now, usedPct, resetInMs, extra = {}) {
  return {
    checkedAt: new Date(now).toISOString(),
    sessionId: 'idle-room',
    room: 'idle-room',
    session: { usedPct, resetsText: 'x', resetsAt: new Date(now + resetInMs).toISOString() },
    week: { usedPct: 30, resetsText: 'Dec 3', resetsAt: new Date(now + 100 * HOUR).toISOString() },
    models: [],
    partial: false,
    ...extra,
  };
}

/** A scheduler the test drives by hand: what is pending, and firing it. */
function fakeTimers() {
  const timers = { pending: [] };
  timers.schedule = (fn, ms) => {
    const handle = { fn, ms };
    timers.pending.push(handle);
    return handle;
  };
  timers.unschedule = (handle) => {
    timers.pending = timers.pending.filter((h) => h !== handle);
  };
  timers.fire = async () => {
    const handle = timers.pending.shift();
    handle.fn();
    await new Promise((r) => setImmediate(r));
  };
  return timers;
}

async function testGuardLifecycle(tempDir) {
  const dataDir = path.join(tempDir, 'guard');
  const store = new StateStore({ dataDir });
  const cwdA = fs.mkdtempSync(path.join(tempDir, 'a-'));
  const cwdB = fs.mkdtempSync(path.join(tempDir, 'b-'));
  const cwdC = fs.mkdtempSync(path.join(tempDir, 'c-'));
  makeRoom(store, 'working-room', cwdA, 'working');
  makeRoom(store, 'idle-room', cwdB, 'idle');
  makeRoom(store, 'asking-room', cwdC, 'needs_input');

  let now = Date.parse('2026-11-26T10:00:00Z');
  const dispatched = [];
  const bridge = {
    dispatchCommand: async (id, text) => {
      dispatched.push({ id, text });
      return { ok: true, delivered: true };
    },
  };
  const timers = fakeTimers();
  const guard = new UsageGuard(store, bridge, { now: () => now, schedule: timers.schedule, unschedule: timers.unschedule });
  guard.start();
  assert.strictEqual(timers.pending.length, 0, 'nothing is scheduled without a hold: no polling');

  // Nothing checked yet: no number, no hold, nothing estimated.
  let summary = await guard.checkAndEnforce();
  assert.strictEqual(summary.source, 'none');
  assert.strictEqual(summary.remainingPct, null);
  assert.strictEqual(summary.lastCheck, null);
  assert.strictEqual(guard.isHolding(), false);

  // 20% used: recorded, nothing happens.
  assert.ok(guard.recordCheck(reading(now, 20, 3 * HOUR)));
  summary = await guard.checkAndEnforce();
  assert.strictEqual(summary.source, 'check');
  assert.strictEqual(summary.remainingPct, 80);
  assert.strictEqual(summary.lastCheck.session.remainingPct, 80);
  assert.strictEqual(summary.lastCheck.week.remainingPct, 70);
  assert.strictEqual(guard.isHolding(), false);
  assert.strictEqual(timers.pending.length, 0);
  assert.strictEqual(guard.recordCheck({ checkedAt: 'nope' }), false, 'a broken reading is refused');

  // 95% used: the hold starts, every live room is checkpointed, nothing is interrupted.
  const resetAt = now + 3 * HOUR;
  guard.recordCheck(reading(now, 95, 3 * HOUR));
  summary = await guard.checkAndEnforce();
  assert.strictEqual(guard.isHolding(), true, 'hold starts below the threshold');
  assert.strictEqual(summary.hold.rooms, 3);
  assert.strictEqual(summary.hold.pendingSteps, 1, 'only the working room is mid-step');
  assert.strictEqual(summary.resetAt, new Date(resetAt).toISOString(), 'it resumes at the reading\'s reset');
  assert.strictEqual(dispatched.length, 0, 'starting a hold sends nothing to terminals');
  assert.strictEqual(timers.pending.length, 1, 'one timer, for the resume time');
  assert.strictEqual(timers.pending[0].ms, 3 * HOUR);
  const cpFile = path.join(dataDir, 'checkpoints', 'working-room.json');
  assert.ok(fs.existsSync(cpFile), 'checkpoint written to disk');
  assert.strictEqual(store.sessions.get('working-room').quotaHold.final, false);

  // The working room finishes its step (a hook event re-evaluates): the checkpoint is refreshed.
  const working = store.sessions.get('working-room');
  working.status = 'done';
  working.tldr = 'finished the migration step';
  await guard.checkAndEnforce();
  assert.strictEqual(guard.config.hold.sessions['working-room'].final, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(cpFile, 'utf8')).tldr, 'finished the migration step');
  assert.strictEqual(guard.getUsageSummary().hold.pendingSteps, 0);
  assert.strictEqual(timers.pending.length, 1, 'still the one timer');

  // The timer firing before the reset (clock drift) keeps the hold and waits again.
  now += 1 * HOUR;
  await timers.fire();
  assert.strictEqual(guard.isHolding(), true);
  assert.strictEqual(timers.pending.length, 1);
  assert.strictEqual(timers.pending[0].ms, 2 * HOUR);

  // At the reset the timer lifts the hold and only rooms with unfinished work get a prompt.
  now = resetAt + 1000;
  await timers.fire();
  assert.strictEqual(guard.isHolding(), false, 'hold lifts at reset');
  const ids = dispatched.map((d) => d.id).sort();
  assert.deepStrictEqual(ids, ['asking-room', 'working-room'], 'idle rooms are not prompted');
  assert.ok(dispatched[0].text.includes('checkpoint'), 'resume prompt points at the checkpoint');
  for (const s of store.sessions.values()) {
    assert.strictEqual(s.quotaHold, null, 'hold markers cleared');
  }
  assert.strictEqual(timers.pending.length, 0, 'no timer left after the hold');

  // The reading's window has reset: it is history, not a reason to hold again.
  summary = await guard.checkAndEnforce();
  assert.strictEqual(summary.stale, true);
  assert.strictEqual(summary.source, 'none');
  assert.strictEqual(summary.remainingPct, null);
  assert.strictEqual(summary.lastCheck.session.usedPct, 95, 'the last reading is still shown');
  assert.strictEqual(guard.isHolding(), false);

  // A newer reading from the next window ends a hold early.
  guard.recordCheck(reading(now, 96, 2 * HOUR));
  await guard.checkAndEnforce();
  assert.strictEqual(guard.isHolding(), true);
  guard.recordCheck(reading(now, 10, 5 * HOUR));
  await guard.checkAndEnforce();
  assert.strictEqual(guard.isHolding(), false, 'a later reset above the threshold lifts the hold');

  // A simulated hold without a current reading resumes after one 5-hour window.
  now += 6 * HOUR;
  await guard.simulateLowQuota(6.5);
  assert.strictEqual(guard.getUsageSummary().source, 'simulated');
  assert.strictEqual(guard.getUsageSummary().remainingPct, 6.5);
  assert.strictEqual(guard.config.hold.resumeAt, new Date(now + 5 * HOUR).toISOString());

  // Disabling the guard lifts an active hold without prompting anyone.
  const before = dispatched.length;
  await guard.updateConfig({ enabled: false, tokenBudget: 123 });
  assert.strictEqual(guard.isHolding(), false);
  assert.strictEqual(dispatched.length, before);
  assert.strictEqual(timers.pending.length, 0);
  assert.strictEqual('tokenBudget' in guard.config, false, 'the estimate budget is gone');
  guard.stop();
  store.flush();
}

/** usage-guard.json written by earlier versions loads cleanly and is rewritten without old keys. */
async function testConfigMigration(tempDir) {
  const dataDir = path.join(tempDir, 'migrate');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'usage-guard.json');
  const now = Date.parse('2026-11-26T10:00:00Z');
  fs.writeFileSync(
    file,
    JSON.stringify({
      enabled: true,
      autoPauseThresholdPct: 999, // out of range: the default stays
      windowHours: 5,
      tokenBudget: 5000000,
      manualRemainingPct: null,
      observed: { fiveHour: { usedPct: 32, resetsAt: '2026-11-26T10:00:00.000Z' }, seenAt: '2026-11-26T08:09:43.818Z' },
      hold: null,
      lastResumedAt: '2026-11-25T01:00:00.000Z',
    })
  );
  let store = new StateStore({ dataDir });
  let guard = new UsageGuard(store, null, { now: () => now });
  let summary = guard.getUsageSummary();
  assert.strictEqual(summary.autoPauseThresholdPct, 8);
  assert.strictEqual(summary.source, 'none', 'a statusline reading is not a check');
  assert.strictEqual(summary.lastResumedAt, '2026-11-25T01:00:00.000Z');
  let saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(
    Object.keys(saved).sort(),
    ['autoPauseThresholdPct', 'enabled', 'hold', 'lastCheck', 'lastResumedAt', 'manualRemainingPct']
  );

  // The flag-style hold of the oldest versions becomes a hold, and its resume timer is armed.
  fs.writeFileSync(
    file,
    JSON.stringify({ isPausedByQuota: true, pausedAt: '2026-11-26T09:00:00Z', resetAt: '2026-11-26T12:00:00Z', lastCheck: 'junk' })
  );
  const timers = fakeTimers();
  store = new StateStore({ dataDir });
  guard = new UsageGuard(store, null, { now: () => now, schedule: timers.schedule, unschedule: timers.unschedule });
  assert.strictEqual(guard.isHolding(), true);
  assert.strictEqual(guard.getUsageSummary().lastCheck, null, 'junk is dropped');
  guard.start();
  assert.strictEqual(timers.pending.length, 1);
  assert.strictEqual(timers.pending[0].ms, 2 * HOUR);
  saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual('isPausedByQuota' in saved, false);
  guard.stop();
  assert.strictEqual(timers.pending.length, 0, 'stop clears the timer');

  // Unreadable JSON: defaults, and the file is not replaced.
  fs.writeFileSync(file, '{ broken');
  guard = new UsageGuard(new StateStore({ dataDir }), null);
  assert.strictEqual(guard.getUsageSummary().enabled, true);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ broken');
}

function testContextWindowSizes() {
  assert.strictEqual(getContextWindowTokens('claude-opus-5-5'), 1000000);
  assert.strictEqual(getContextWindowTokens('claude-haiku-4-5'), 200000);
}

/** A transcript under the isolated ~/.claude/projects with replies carrying usage. */
function writeTranscript(cwd, sessionId, entries) {
  const dir = path.join(isolatedHome, '.claude', 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

function reply(model, usage, extra = {}) {
  return {
    type: 'assistant',
    timestamp: '2026-11-26T10:00:00.000Z',
    message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], usage },
    ...extra,
  };
}

async function testHttp(tempDir) {
  const dataDir = path.join(tempDir, 'http');
  const { server, store } = createMissionControlServer({
    dataDir,
    token: TOKEN,
    disableScanner: true,
    offlineFile: path.join(dataDir, 'offline-events.jsonl'),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const cwd = fs.mkdtempSync(path.join(tempDir, 'room-'));
  fs.writeFileSync(path.join(cwd, 'my file.ts'), 'one\ntwo\nthree\n');
  makeRoom(store, 'room-x', cwd, 'working');

  try {
    // The always-on usage paths are gone.
    for (const urlPath of ['/api/usage/observed', '/api/statusline/install']) {
      const res = await request(port, { method: 'POST', urlPath, body: {} });
      assert.strictEqual(res.status, 404, `${urlPath} is removed`);
    }
    let res = await request(port, { urlPath: '/api/state' });
    assert.strictEqual('statusline' in res.json, false, 'no statusline status in the snapshot');
    assert.strictEqual('totalTokens' in res.json.metrics, false, 'no token totals in the snapshot');
    assert.strictEqual('totalCostUsd' in res.json.metrics, false);
    let room = res.json.sessions.find((s) => s.id === 'room-x');
    assert.strictEqual(room.tokenUsage, undefined, 'no per-room usage in the snapshot');
    assert.strictEqual(room.liveContext, undefined);
    assert.strictEqual(res.json.usageGuard.source, 'none');
    assert.strictEqual('tokenBudget' in res.json.usageGuard, false);

    // Model/effort: aliases and full IDs pass, anything with spaces or odd characters does not.
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/session/model-effort',
      body: { sessionId: 'room-x', model: 'claude-fable-5-2', effort: 'xhigh' },
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
      res.json.dispatched.map((d) => d.value),
      ['claude-fable-5-2', 'xhigh']
    );
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/session/model-effort',
      body: { sessionId: 'room-x', model: 'opus\r/exit' },
    });
    assert.strictEqual(res.status, 400, 'odd model strings are refused');

    // VS Code: a vscode:// link inside the room, never outside it.
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/session/open-vscode',
      body: { sessionId: 'room-x', file: 'my file.ts', line: 3 },
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.json.uri.startsWith('vscode://file/'), res.json.uri);
    assert.ok(res.json.uri.endsWith('my%20file.ts:3:1'), res.json.uri);
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/session/open-vscode',
      body: { sessionId: 'room-x', file: '../outside.txt' },
    });
    assert.strictEqual(res.status, 403);

    // Context on request: the prompt side of the last main-thread reply, against the model's window.
    const sid = '3f9a1c2e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
    const file = writeTranscript(cwd, sid, [
      reply('claude-opus-5-5', { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 100000, output_tokens: 50 }),
      { type: 'user', message: { role: 'user', content: 'next' } },
      reply('claude-opus-5-5', { input_tokens: 4, cache_creation_input_tokens: 2000, cache_read_input_tokens: 338000, output_tokens: 900 }),
      // A sub-agent's reply and a synthetic one (no usage) come later but do not count.
      reply('claude-haiku-4-5', { input_tokens: 9, cache_read_input_tokens: 5000 }, { isSidechain: true }),
      reply('<synthetic>', { input_tokens: 0, output_tokens: 0 }),
    ]);
    const roomX = store.sessions.get('room-x');
    roomX.transcriptPath = file;
    res = await request(port, { urlPath: '/api/session/context?id=room-x' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.contextTokens, 340004);
    assert.strictEqual(res.json.windowTokens, 1000000);
    assert.strictEqual(res.json.usedPct, 34);
    assert.strictEqual(res.json.model, 'claude-opus-5-5');
    assert.ok(res.json.checkedAt);
    res = await request(port, { urlPath: '/api/state' });
    room = res.json.sessions.find((s) => s.id === 'room-x');
    assert.strictEqual(room.liveContext, undefined, 'a context check is not pushed in snapshots');

    // Found by the room's Claude session id when no path is recorded yet.
    roomX.transcriptPath = null;
    roomX.claudeSessionId = sid;
    res = await request(port, { urlPath: '/api/session/context?id=room-x' });
    assert.strictEqual(res.json.contextTokens, 340004);

    // Only .jsonl files under ~/.claude/projects are read.
    const outside = path.join(tempDir, 'outside.jsonl');
    fs.writeFileSync(outside, `${JSON.stringify(reply('claude-opus-5-5', { input_tokens: 5 }))}\n`);
    roomX.claudeSessionId = null;
    roomX.transcriptPath = outside;
    res = await request(port, { urlPath: '/api/session/context?id=room-x' });
    assert.strictEqual(res.status, 404);
    const notJsonl = path.join(path.dirname(file), 'notes.txt');
    fs.writeFileSync(notJsonl, 'x');
    roomX.transcriptPath = notJsonl;
    res = await request(port, { urlPath: '/api/session/context?id=room-x' });
    assert.strictEqual(res.status, 404);
    // A transcript without any reply yet.
    roomX.transcriptPath = writeTranscript(cwd, '00000000-0000-4000-8000-000000000000', [
      { type: 'user', message: { role: 'user', content: 'hi' } },
    ]);
    res = await request(port, { urlPath: '/api/session/context?id=room-x' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.usedPct, null);
    // The id is validated.
    res = await request(port, { urlPath: '/api/session/context' });
    assert.strictEqual(res.status, 400);
    res = await request(port, { urlPath: `/api/session/context?id=${'x'.repeat(201)}` });
    assert.strictEqual(res.status, 400);
    res = await request(port, { urlPath: '/api/session/context?id=no-such-room' });
    assert.strictEqual(res.status, 404);

    // During a hold, new prompts are held in the terminal and from the dashboard; approvals pass.
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/usage/config',
      body: { action: 'simulate-low-quota' },
    });
    assert.strictEqual(res.json.ok, true);
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/hook',
      body: { session_id: 'room-x', cwd, hook_event_name: 'UserPromptSubmit', prompt: 'next task' },
    });
    assert.ok(res.json.hold && res.json.hold.reason.includes('6.5%'), 'hook is told to block the prompt');
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/session/command',
      body: { sessionId: 'room-x', command: 'next task' },
    });
    assert.strictEqual(res.status, 423);
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/session/command',
      body: { sessionId: 'room-x', command: '1', isApproval: true },
    });
    assert.strictEqual(res.status, 200, 'approvals still go through');

    res = await request(port, {
      method: 'POST',
      urlPath: '/api/usage/config',
      body: { action: 'reset-and-resume' },
    });
    assert.strictEqual(res.json.ok, true);
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/hook',
      body: { session_id: 'room-x', cwd, hook_event_name: 'UserPromptSubmit', prompt: 'next task' },
    });
    assert.strictEqual(res.json.hold, undefined, 'prompts flow again after resume');
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-guard-'));
  try {
    testContextWindowSizes();
    await testGuardLifecycle(tempDir);
    await testConfigMigration(tempDir);
    await testHttp(tempDir);
    console.log('✅ Usage guard (no polling), context on request and dashboard API checks passed!');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('❌ Usage guard checks failed:', err);
  process.exit(1);
});
