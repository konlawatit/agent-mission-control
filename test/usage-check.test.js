/**
 * Plan usage on request: reading Claude Code's /usage dialog off the screen, the check itself
 * (an idle terminal is chosen, /usage typed, Esc sent, the room left untouched) against a fake
 * terminal, the console scanner leaving a terminal alone mid-check, and the HTTP endpoints.
 * No real terminal is touched and nothing here starts `claude`.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Isolate from the developer's real ~/.claude and ~/.agent-mission-control.
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-usagecheck-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

const { StateStore } = require('../src/state-store');
const { parseConsoleScreen, ConsoleScanner } = require('../src/console-scanner');
const { UsageChecker, parseUsageScreen, parseResetText } = require('../src/usage-check');
const { createMissionControlServer } = require('../src/server');

const TOKEN = 'e'.repeat(48);
const RULE = '─'.repeat(80);
const GARBLED = '  ● ���������� ��� ���������� ������';

// 2026-11-26 22:00 in Asia/Bangkok (UTC+7).
const NOW = Date.parse('2026-11-26T15:00:00Z');

/** The /usage dialog as Claude Code 2.1.332 draws it. */
function usageDialog({ session = 1, week = 14, model = 12, sessionReset = '3:29am', weekReset = 'Dec 3, 12:59pm' } = {}) {
  return [
    GARBLED,
    '',
    '  Status   Config   Usage',
    '',
    '  Current session',
    `  ▌                                                  ${session}% used`,
    `  Resets ${sessionReset} (Asia/Bangkok)`,
    '',
    '  Current week (all models)',
    `  ███████                                            ${week}% used`,
    `  Resets ${weekReset} (Asia/Bangkok)`,
    '',
    '  Current week (Fable)',
    `  ██████                                             ${model}% used`,
    `  Resets ${weekReset} (Asia/Bangkok)`,
    '',
    "  What's contributing to your usage?",
    '  Approximate · sessions on this computer only',
    '  1. Run /clear between unrelated tasks                    23%',
    '  2. Fewer subagents for small lookups                     12%',
    '  Skills 31% · Subagents 22% · Plugins 9% · MCP 4%',
    '',
    '  ←/→ to switch · f to fix 2 of 5 · d to show day · w to show week · Esc to close',
  ].join('\n');
}

const LOADING = ['  Status   Config   Usage', '', '  Loading usage…', '', '  ←/→ to switch · Esc to close'].join('\n');

function idleScreen(extra = [], input = '') {
  return [GARBLED, ...extra, '', RULE, `❯ ${input}`, RULE, '  ? for shortcuts'].join('\n');
}
const BUSY = [GARBLED, '✻ Thinking… (12s · esc to interrupt)', '', RULE, '❯ ', RULE].join('\n');
const PROMPT = [
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No, and tell Claude what to do differently',
  '',
  ' Esc to cancel',
].join('\n');

/* ---------- The screen parser ---------- */

function testParser() {
  const r = parseUsageScreen(usageDialog(), NOW);
  assert.ok(r && r.complete && r.dialog, 'a full dialog parses');
  assert.deepStrictEqual(r.session, {
    usedPct: 1,
    resetsText: '3:29am (Asia/Bangkok)',
    resetsAt: '2026-11-26T20:29:00.000Z', // the next 3:29am in Bangkok
  });
  assert.strictEqual(r.week.usedPct, 14);
  assert.strictEqual(r.week.resetsAt, '2026-12-03T05:59:00.000Z');
  assert.deepStrictEqual(r.models.map((m) => [m.name, m.usedPct]), [['Fable', 12]]);

  // 12am is midnight and 12pm is noon; a time already past today means tomorrow.
  assert.strictEqual(parseResetText('12am (Asia/Bangkok)', NOW), '2026-11-26T17:00:00.000Z');
  assert.strictEqual(parseResetText('12pm (Asia/Bangkok)', NOW), '2026-11-27T05:00:00.000Z');
  assert.strictEqual(parseResetText('11:59pm (Asia/Bangkok)', NOW), '2026-11-26T16:59:00.000Z');
  assert.strictEqual(parseResetText('9pm (Asia/Bangkok)', NOW), '2026-11-27T14:00:00.000Z');
  // A date reset: this year while still ahead, otherwise next year.
  assert.strictEqual(parseResetText('Dec 3, 12:59pm (Asia/Bangkok)', NOW), '2026-12-03T05:59:00.000Z');
  assert.strictEqual(parseResetText('Jan 2, 1am (Asia/Bangkok)', NOW), '2027-01-01T18:00:00.000Z');
  assert.strictEqual(parseResetText('Nov 20 at 9am (Asia/Bangkok)', NOW), '2027-11-20T02:00:00.000Z');
  assert.strictEqual(parseResetText('in 2 hr 5 min', NOW), '2026-11-26T17:05:00.000Z');
  assert.strictEqual(parseResetText('soon', NOW), null);
  assert.strictEqual(parseResetText('13pm', NOW), null);
  // An unknown zone falls back to this machine's local time.
  const local = new Date(NOW);
  local.setHours(15, 0, 0, 0);
  if (local.getTime() <= NOW) local.setDate(local.getDate() + 1);
  assert.strictEqual(parseResetText('3pm (Mars/Olympus)', NOW), local.toISOString());

  // Loading: the dialog is up but has no numbers yet.
  assert.strictEqual(parseUsageScreen(LOADING, NOW), null);
  assert.strictEqual(parseUsageScreen(idleScreen(), NOW), null);

  // The read holds only the last ~45 rows: a block above it is missing, the rest still counts.
  const cut = usageDialog().split('\n').slice(12).join('\n');
  const partial = parseUsageScreen(cut, NOW);
  assert.strictEqual(partial.session, null);
  assert.strictEqual(partial.week, null);
  assert.strictEqual(partial.models[0].usedPct, 12);
  assert.strictEqual(partial.complete, false);
  // Only the week block missing.
  const noWeek = usageDialog().split('\n').filter((l, i) => i < 8 || i > 10).join('\n');
  const r2 = parseUsageScreen(noWeek, NOW);
  assert.strictEqual(r2.session.usedPct, 1);
  assert.strictEqual(r2.week, null);
  assert.strictEqual(r2.complete, false);

  // An earlier dialog left in the scrollback above the open one: the lower one is the reading.
  const twice = `${usageDialog({ session: 70 }).split('\n').slice(0, 8).join('\n')}\n  ⎿  Settings dialog dismissed\n${usageDialog({ session: 5 })}`;
  assert.strictEqual(parseUsageScreen(twice, NOW).session.usedPct, 5);

  // The scanner does not read the dialog's numbered tips as a question waiting on the person.
  const scan = parseConsoleScreen(usageDialog());
  assert.strictEqual(scan.interactivePrompt, null);
  assert.strictEqual(scan.usageDialog, true);
  assert.strictEqual(scan.inputText, null);
  assert.strictEqual(parseConsoleScreen(LOADING).usageDialog, true);
  // Real prompts are unaffected.
  assert.ok(parseConsoleScreen(PROMPT).interactivePrompt, 'a permission prompt still reads as one');
  assert.strictEqual(parseConsoleScreen(PROMPT).usageDialog, false);
}

/* ---------- The check, against a fake terminal ---------- */

/**
 * A stand-in for the console scanner. Each pid has a screen; `/usage` opens the dialog (after
 * `loadingReads` reads of the loading state) and Esc closes it (after ignoring `lostEsc` presses).
 */
class FakeTerminal {
  constructor() {
    this.terms = new Map();
    this.calls = [];
    this.held = new Set();
    this.heldDuring = [];
  }

  add(pid, screen, opts = {}) {
    this.terms.set(pid, { base: screen, mode: 'idle', loadingReads: 1, lostEsc: 0, neverOpens: false, ...opts });
  }

  async readScreen(pid) {
    this.calls.push(['read', pid]);
    const t = this.terms.get(pid);
    if (!t) return { ok: false };
    let screen = t.base;
    if (t.mode === 'loading') {
      screen = LOADING;
      if (--t.loadingReads <= 0) t.mode = 'dialog';
    } else if (t.mode === 'dialog') {
      screen = t.dialog || usageDialog();
      this.heldDuring.push(this.held.has(pid));
    }
    return { ok: true, pid, screen, cursorRow: -1, cursorCol: -1 };
  }

  async sendText(pid, text) {
    this.calls.push(['text', pid, text]);
    const t = this.terms.get(pid);
    if (t && text === '/usage' && !t.neverOpens) t.mode = 'loading';
    return { ok: true };
  }

  async sendKey(pid, key) {
    this.calls.push(['key', pid, key]);
    const t = this.terms.get(pid);
    if (t && key === 'esc' && (t.mode === 'dialog' || t.mode === 'loading')) {
      if (t.lostEsc > 0) t.lostEsc -= 1;
      else Object.assign(t, { mode: 'idle', base: idleScreen(['  ⎿  Settings dialog dismissed']) });
    }
    return { ok: true };
  }

  holdPid(pid) {
    this.held.add(pid);
  }

  releasePid(pid) {
    this.held.delete(pid);
  }

  typed() {
    return this.calls.filter((c) => c[0] === 'text');
  }

  keys(pid) {
    return this.calls.filter((c) => c[0] === 'key' && c[1] === pid).map((c) => c[2]);
  }
}

function makeRoom(store, id, pid, status, extra = {}) {
  const s = store.getOrCreateSession(id, { room: id, goal: `goal of ${id}` });
  Object.assign(s, { pid, status, lifecycle: 'live', isProcessAlive: true, tldr: `tldr of ${id}` }, extra);
  return s;
}

function fakeClock() {
  const clock = { t: NOW };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => {
    clock.t += ms;
  };
  return clock;
}

function roomState(s) {
  return JSON.stringify({
    status: s.status,
    statusLabel: s.statusLabel,
    tldr: s.tldr,
    goal: s.goal,
    events: (s.recentEvents || []).length,
    history: (s.taskHistory || []).length,
    prompt: s.interactivePrompt,
  });
}

async function testCheckFlow(tempDir) {
  const store = new StateStore({ dataDir: path.join(tempDir, 'flow') });
  const term = new FakeTerminal();
  makeRoom(store, 'working', 101, 'working');
  term.add(101, idleScreen());
  makeRoom(store, 'typing', 102, 'idle');
  term.add(102, idleScreen([], 'half a sentence'));
  makeRoom(store, 'asking', 103, 'idle');
  term.add(103, PROMPT);
  makeRoom(store, 'thinking', 104, 'idle');
  term.add(104, BUSY);
  makeRoom(store, 'free', 105, 'idle');
  term.add(105, idleScreen(), { loadingReads: 2 });
  makeRoom(store, 'closed', 106, 'idle', { lifecycle: 'history' });
  term.add(106, idleScreen());

  const before = new Map(Array.from(store.sessions.values(), (s) => [s.id, roomState(s)]));
  let changes = 0;
  const clock = fakeClock();
  const checker = new UsageChecker(store, term, {
    now: clock.now,
    sleep: clock.sleep,
    onChange: () => (changes += 1),
  });

  // The preferred room has text in its input box, so another idle room is used.
  const result = await checker.check({ preferSessionId: 'typing' });
  assert.deepStrictEqual(term.typed(), [['text', 105, '/usage']], 'only the idle room got /usage');
  assert.strictEqual(result.reading.sessionId, 'free');
  assert.strictEqual(result.reading.room, 'free');
  assert.strictEqual(result.reading.session.usedPct, 1);
  assert.strictEqual(result.reading.week.usedPct, 14);
  assert.strictEqual(result.reading.models[0].name, 'Fable');
  assert.strictEqual(result.reading.partial, false);
  assert.strictEqual(result.closed, true, 'the dialog was closed');
  assert.deepStrictEqual(term.keys(105), ['esc'], 'one Esc closes it');
  assert.ok(term.heldDuring.length && term.heldDuring.every(Boolean), 'the scanner was told to leave the terminal alone');
  assert.strictEqual(term.held.size, 0, 'and released afterwards');
  assert.strictEqual(changes, 2, 'start and end of the check are announced');
  assert.strictEqual(checker.busy, false);
  for (const s of store.sessions.values()) {
    assert.strictEqual(roomState(s), before.get(s.id), `room ${s.id} is unchanged (status, TL;DR, goal, history)`);
    assert.deepStrictEqual(store.dequeueCommands(s.id), [], `nothing queued for ${s.id}`);
  }

  // The preferred room is used when it is idle.
  term.calls.length = 0;
  term.terms.get(102).base = idleScreen();
  const again = await checker.check({ preferSessionId: 'typing' });
  assert.strictEqual(again.reading.sessionId, 'typing');
  assert.deepStrictEqual(term.typed(), [['text', 102, '/usage']]);

  // One check at a time.
  term.calls.length = 0;
  const first = checker.check();
  await assert.rejects(checker.check(), (err) => err.statusCode === 409 && err.code === 'busy');
  await first;
  assert.strictEqual(term.typed().length, 1, 'the refused check typed nothing');

  // An Esc that does not land: a second one goes in while the dialog is still up.
  term.calls.length = 0;
  term.terms.get(105).lostEsc = 1;
  term.terms.get(102).base = idleScreen([], 'busy typing');
  const lost = await checker.check();
  assert.strictEqual(lost.closed, true);
  assert.deepStrictEqual(term.keys(105), ['esc', 'esc']);

  // A dialog that never opens: the check gives up, still presses Esc once and releases the pid.
  term.calls.length = 0;
  term.terms.get(105).neverOpens = true;
  await assert.rejects(checker.check(), (err) => err.statusCode === 504);
  assert.deepStrictEqual(term.keys(105), ['esc']);
  assert.strictEqual(term.held.size, 0);
  term.terms.get(105).neverOpens = false;

  // No idle Claude Code at all: a clear answer, nothing typed.
  term.calls.length = 0;
  for (const [pid, t] of term.terms) if (pid !== 104) t.base = BUSY;
  await assert.rejects(checker.check(), (err) => err.statusCode === 409 && /อย่างน้อย 1 ห้อง/.test(err.message));
  assert.strictEqual(term.typed().length, 0);

  // No console bridge (not Windows): refused up front.
  await assert.rejects(new UsageChecker(store, null).check(), (err) => err.statusCode === 501);
  store.flush();
}

/* ---------- The console scanner during a check ---------- */

async function testScannerHoldsPid(tempDir) {
  if (process.platform !== 'win32') return; // the scanner only talks to a bridge on Windows
  const store = new StateStore({ dataDir: path.join(tempDir, 'scan') });
  const cwd = fs.mkdtempSync(path.join(tempDir, 'cwd-'));
  const room = makeRoom(store, 'claude-pid-555', 555, 'idle', { cwd });
  let screen = usageDialog();
  const scanner = new ConsoleScanner(store, {
    bridge: {
      available: true,
      request: async () => ({ ok: true, items: [{ pid: 555, cwd, consolePids: [555], screen }] }),
      stop() {},
    },
  });
  const before = roomState(room);

  scanner.holdPid(555);
  await scanner.scanOnce();
  assert.strictEqual(room.lifecycle, 'live', 'a held terminal is still alive');
  assert.strictEqual(roomState(room), before, 'its screen is left alone');

  // Released with the dialog still up (a scan already in flight): still no question for the person.
  scanner.releasePid(555);
  await scanner.scanOnce();
  assert.strictEqual(room.status, 'idle');
  assert.strictEqual(room.interactivePrompt, null);
  assert.notStrictEqual(room.status, 'needs_input');

  screen = PROMPT;
  await scanner.scanOnce();
  assert.strictEqual(room.status, 'needs_input', 'a real prompt is still picked up');
  scanner.stop();
  store.flush();
}

/* ---------- HTTP ---------- */

function request(port, { method = 'GET', urlPath, body } = {}) {
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

async function testHttp(tempDir) {
  const dataDir = path.join(tempDir, 'http');
  const term = new FakeTerminal();
  const { server, store, usageGuard } = createMissionControlServer({
    dataDir,
    token: TOKEN,
    disableScanner: true,
    offlineFile: path.join(dataDir, 'offline-events.jsonl'),
    usageTerminal: term,
    usageCheckOptions: { pollMs: 5, timeoutMs: 2000, closeTimeoutMs: 1500 },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const room = makeRoom(store, 'room-a', 201, 'idle');
  term.add(201, idleScreen());

  try {
    let res = await request(port, { urlPath: '/api/state' });
    assert.strictEqual(res.json.usageGuard.lastCheck, null, 'nothing is checked until asked');
    assert.strictEqual(res.json.usageGuard.source, 'none');
    assert.strictEqual(term.calls.length, 0, 'loading the dashboard touches no terminal');

    res = await request(port, { method: 'POST', urlPath: '/api/usage/check', body: { preferSessionId: 42 } });
    assert.strictEqual(res.status, 400);

    const before = roomState(room);
    res = await request(port, { method: 'POST', urlPath: '/api/usage/check', body: { preferSessionId: 'room-a' } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.closed, true);
    assert.strictEqual(res.json.reading.session.remainingPct, 99);
    assert.strictEqual(res.json.reading.week.remainingPct, 86);
    assert.strictEqual(res.json.usage.source, 'check');
    assert.strictEqual(roomState(room), before, 'the room the check used is unchanged');

    res = await request(port, { urlPath: '/api/state' });
    assert.strictEqual(res.json.usageGuard.lastCheck.room, 'room-a', 'the reading is in the snapshot');
    assert.strictEqual(res.json.usageGuard.checking, false);

    // If Claude Code reports `/usage` as a prompt, the room does not take it as a task.
    for (const urlPath of ['/api/hook', '/api/hook/claude']) {
      res = await request(port, {
        method: 'POST',
        urlPath,
        body: { session_id: 'room-a', hook_event_name: 'UserPromptSubmit', prompt: '/usage', claude_pid: 201 },
      });
      assert.strictEqual(res.status, 200);
    }
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(roomState(room), before, '/usage is not recorded as the room\'s prompt');

    // A low reading starts the hold right away; the hold does not block the next check.
    term.terms.get(201).dialog = usageDialog({ session: 96 });
    res = await request(port, { method: 'POST', urlPath: '/api/usage/check', body: {} });
    assert.strictEqual(res.json.usage.remainingPct, 4);
    assert.ok(res.json.usage.hold, 'remaining 4% < 8%: hold started');
    assert.ok(usageGuard.resumeTimer, 'one timer waits for the reset');
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/hook',
      body: { session_id: 'room-a', hook_event_name: 'UserPromptSubmit', prompt: '/usage' },
    });
    assert.strictEqual(res.json.hold, undefined, '/usage is never held');
    res = await request(port, { method: 'POST', urlPath: '/api/usage/config', body: { action: 'reset-and-resume' } });
    assert.strictEqual(res.json.ok, true);

    // Two checks at once: the second is refused while the first runs.
    term.terms.get(201).dialog = usageDialog();
    term.terms.get(201).loadingReads = 20;
    const [a, b] = await Promise.all([
      request(port, { method: 'POST', urlPath: '/api/usage/check', body: {} }),
      new Promise((r) => setTimeout(r, 15)).then(() => request(port, { method: 'POST', urlPath: '/api/usage/check', body: {} })),
    ]);
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 409);
    assert.ok(b.json.error.includes('กำลังเช็ค'));

    // No idle room.
    term.terms.get(201).base = BUSY;
    res = await request(port, { method: 'POST', urlPath: '/api/usage/check', body: {} });
    assert.strictEqual(res.status, 409);
    assert.ok(/Claude Code/.test(res.json.error));
  } finally {
    await new Promise((r) => server.close(r));
  }

  // Without a console bridge (disableScanner, no stand-in): a clear refusal.
  const plain = createMissionControlServer({ dataDir: path.join(tempDir, 'plain'), token: TOKEN, disableScanner: true });
  await new Promise((r) => plain.server.listen(0, '127.0.0.1', r));
  try {
    const res = await request(plain.server.address().port, { method: 'POST', urlPath: '/api/usage/check', body: {} });
    assert.strictEqual(res.status, 501);
    assert.ok(res.json.error.includes('Windows'));
  } finally {
    await new Promise((r) => plain.server.close(r));
  }
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-usagecheck-run-'));
  try {
    testParser();
    await testCheckFlow(tempDir);
    await testScannerHoldsPid(tempDir);
    await testHttp(tempDir);
    console.log('✅ Usage check (/usage screen parser, idle-room check, scanner hold, endpoints) passed!');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('❌ Usage check tests failed:', err);
  process.exit(1);
});
