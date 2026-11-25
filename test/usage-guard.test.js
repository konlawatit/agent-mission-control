/**
 * Usage guard and dashboard API checks: real vs estimated usage, the "finish the step, then hold"
 * pause, checkpoint files, resume after reset, prompt blocking during a hold, and the new
 * model/effort, VS Code and statusline endpoints.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { StateStore } = require('../src/state-store');
const { UsageGuard, normalizeWindow } = require('../src/usage-guard');
const { createMissionControlServer } = require('../src/server');
const { estimateClaudeCostUsd, getContextWindowTokens } = require('../src/transcript-parser');

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
  let windowTokens = 1000000;
  const dispatched = [];
  const bridge = {
    dispatchCommand: async (id, text) => {
      dispatched.push({ id, text });
      return { ok: true, delivered: true };
    },
  };
  const guard = new UsageGuard(store, bridge, {
    now: () => now,
    recentTokens: () => ({ tokens: windowTokens, oldestAt: now - 2 * HOUR }),
  });
  guard.config.tokenBudget = 5000000;

  // 20% used: nothing happens, and the estimate is labelled as such.
  let summary = await guard.checkAndEnforce();
  assert.strictEqual(summary.source, 'estimate');
  assert.strictEqual(summary.remainingPct, 80);
  assert.strictEqual(guard.isHolding(), false);

  // 95% used: the hold starts, every live room is checkpointed, nothing is interrupted.
  windowTokens = 4750000;
  summary = await guard.checkAndEnforce();
  assert.strictEqual(guard.isHolding(), true, 'hold starts below the threshold');
  assert.strictEqual(summary.hold.rooms, 3);
  assert.strictEqual(summary.hold.pendingSteps, 1, 'only the working room is mid-step');
  assert.strictEqual(dispatched.length, 0, 'starting a hold sends nothing to terminals');
  const cpFile = path.join(dataDir, 'checkpoints', 'working-room.json');
  assert.ok(fs.existsSync(cpFile), 'checkpoint written to disk');
  assert.strictEqual(store.sessions.get('working-room').quotaHold.final, false);

  // The working room finishes its step: its checkpoint is refreshed and marked final.
  const working = store.sessions.get('working-room');
  working.status = 'done';
  working.tldr = 'finished the migration step';
  await guard.checkAndEnforce();
  assert.strictEqual(guard.config.hold.sessions['working-room'].final, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(cpFile, 'utf8')).tldr, 'finished the migration step');
  assert.strictEqual(guard.getUsageSummary().hold.pendingSteps, 0);

  // Still inside the window: the hold stays.
  now += 1 * HOUR;
  await guard.checkAndEnforce();
  assert.strictEqual(guard.isHolding(), true);

  // The reset time passes: the hold lifts and only rooms with unfinished work get a prompt.
  now += 4 * HOUR;
  windowTokens = 0;
  await guard.checkAndEnforce();
  assert.strictEqual(guard.isHolding(), false, 'hold lifts at reset');
  const ids = dispatched.map((d) => d.id).sort();
  assert.deepStrictEqual(ids, ['asking-room', 'working-room'], 'idle rooms are not prompted');
  assert.ok(dispatched[0].text.includes('checkpoint'), 'resume prompt points at the checkpoint');
  for (const s of store.sessions.values()) {
    assert.strictEqual(s.quotaHold, null, 'hold markers cleared');
  }

  // Real usage from the statusline wins over the estimate while it is fresh.
  assert.ok(
    guard.observe({ five_hour: { used_percentage: 40, resets_at: Math.floor((now + 2 * HOUR) / 1000) } })
  );
  summary = guard.getUsageSummary();
  assert.strictEqual(summary.source, 'claude');
  assert.strictEqual(summary.remainingPct, 60);

  // A reading whose reset already passed is ignored.
  now += 3 * HOUR;
  assert.strictEqual(guard.getUsageSummary().source, 'estimate');

  // Disabling the guard lifts an active hold without prompting anyone.
  windowTokens = 4900000;
  await guard.checkAndEnforce();
  assert.strictEqual(guard.isHolding(), true);
  const before = dispatched.length;
  await guard.updateConfig({ enabled: false });
  assert.strictEqual(guard.isHolding(), false);
  assert.strictEqual(dispatched.length, before);
  store.flush();
}

function testNormalizers() {
  assert.deepStrictEqual(normalizeWindow({ used_percentage: 12.345, resets_at: 1767225600 }), {
    usedPct: 12.3,
    resetsAt: '2026-01-01T00:00:00.000Z',
  });
  assert.strictEqual(
    normalizeWindow({ used_percentage: 50, resets_at: '2026-01-01T00:00:00Z' }).resetsAt,
    '2026-01-01T00:00:00.000Z'
  );
  assert.strictEqual(normalizeWindow({ used_percentage: 'x' }), null);
  assert.strictEqual(normalizeWindow(null), null);

  // Current Opus is $4/$20; the old $15/$75 rate only applies to Claude 3 / Opus 4.0-4.1.
  const usage = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheCreateTokens: 0 };
  assert.strictEqual(estimateClaudeCostUsd('claude-opus-5-5', usage), 24);
  assert.strictEqual(estimateClaudeCostUsd('claude-sonnet-5-5', usage), 12);
  assert.strictEqual(estimateClaudeCostUsd('claude-3-opus-20240229', usage), 90);
  assert.strictEqual(getContextWindowTokens('claude-opus-5-5'), 1000000);
  assert.strictEqual(getContextWindowTokens('claude-haiku-4-5'), 200000);
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
    // Model/effort: aliases and full IDs pass, anything with spaces or odd characters does not.
    let res = await request(port, {
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

    // Statusline readings feed the guard.
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/usage/observed',
      body: {
        cwd,
        model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
        rate_limits: { five_hour: { used_percentage: 30, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
        context_window: { used_percentage: 42, context_window_size: 1000000 },
      },
    });
    assert.strictEqual(res.json.accepted, true);
    res = await request(port, { urlPath: '/api/state' });
    assert.strictEqual(res.json.usageGuard.source, 'claude');
    assert.strictEqual(res.json.usageGuard.remainingPct, 70);
    const room = res.json.sessions.find((s) => s.id === 'room-x');
    assert.strictEqual(room.model, 'claude-opus-5-5');
    assert.strictEqual(room.liveContext.usedPct, 42);

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
    assert.ok(res.json.hold && res.json.hold.reason, 'hook is told to block the prompt');
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
    testNormalizers();
    await testGuardLifecycle(tempDir);
    await testHttp(tempDir);
    console.log('✅ Usage guard, statusline bridge and dashboard API checks passed!');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('❌ Usage guard checks failed:', err);
  process.exit(1);
});
