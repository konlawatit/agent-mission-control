/**
 * Security & robustness checks: API authentication, DNS-rebinding / cross-origin guards,
 * command-injection-safe launchers, honest delivery reporting, XSS-safe rendering helpers,
 * and debounced atomic persistence.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createMissionControlServer } = require('../src/server');
const { StateStore } = require('../src/state-store');
const {
  CommandBridge,
  psLiteral,
  buildTerminalScript,
  safeTitle,
  resolveResumeId,
} = require('../src/command-bridge');
const { isAllowedHost, isAllowedOrigin, tokensEqual } = require('../src/security');

const TOKEN = 'f'.repeat(48);

function request(port, { method = 'GET', urlPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const authed = (extra = {}) => ({ 'X-AMC-Token': TOKEN, ...extra });
const jsonHeaders = (extra = {}) =>
  authed({ 'Content-Type': 'application/json', ...extra });

async function testHttpLayer(tempDir) {
  const { server, store, bridge } = createMissionControlServer({
    dataDir: tempDir,
    token: TOKEN,
    disableScanner: true,
    offlineFile: path.join(tempDir, 'offline-events.jsonl'),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    // Unauthenticated API calls are rejected.
    let res = await request(port, { urlPath: '/api/state' });
    assert.strictEqual(res.status, 401, 'API must require the token');

    res = await request(port, { urlPath: '/api/state', headers: authed() });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.ok, true);
    assert.strictEqual(
      res.headers['access-control-allow-origin'],
      undefined,
      'No wildcard CORS'
    );

    // DNS rebinding: foreign Host header is refused even for static files.
    res = await request(port, { urlPath: '/', headers: { Host: 'evil.example:4310' } });
    assert.strictEqual(res.status, 403);

    // Cross-site browser request is refused even if it somehow had the token.
    res = await request(port, {
      urlPath: '/api/state',
      headers: authed({ Origin: 'https://evil.example' }),
    });
    assert.strictEqual(res.status, 403);
    res = await request(port, {
      urlPath: '/api/state',
      headers: authed({ Origin: `http://localhost:${port}` }),
    });
    assert.strictEqual(res.status, 200, 'Same-machine dashboard origin is allowed');

    // "Simple" text/plain POSTs (no CORS preflight) are rejected.
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/hook',
      headers: authed({ 'Content-Type': 'text/plain' }),
      body: JSON.stringify({ session_id: 'x', hook_event_name: 'Stop' }),
    });
    assert.strictEqual(res.status, 415);

    // Dashboard page embeds the token and sends hardening headers.
    res = await request(port, { urlPath: '/' });
    assert.strictEqual(res.status, 200);
    assert.ok(res.raw.includes(`<meta name="amc-token" content="${TOKEN}" />`));
    assert.strictEqual(res.headers['x-frame-options'], 'DENY');

    // Path traversal stays inside public/.
    res = await request(port, { urlPath: '/..%2fpackage.json' });
    assert.notStrictEqual(res.status, 200);

    // Hook ingestion with token works.
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/hook',
      headers: jsonHeaders(),
      body: JSON.stringify({
        session_id: 'sec-test-session',
        cwd: tempDir,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'hello',
      }),
    });
    assert.strictEqual(res.status, 200);
    const sessionId = res.json.sessionId;

    // Session patches only touch user-editable fields (pid targets console input!).
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/session/update',
      headers: jsonHeaders(),
      body: JSON.stringify({
        sessionId,
        patch: { room: 'Renamed', pid: 4242, cwd: 'C:\\Windows' },
      }),
    });
    assert.strictEqual(res.status, 200);
    const updated = store.sessions.get(sessionId);
    assert.strictEqual(updated.room, 'Renamed');
    assert.notStrictEqual(updated.pid, 4242, 'pid must not be patchable');
    assert.notStrictEqual(updated.cwd, 'C:\\Windows', 'cwd must not be patchable');

    // Manual room order: stored per room, only from a list of known room ids.
    for (const d of ['order-a', 'order-b']) fs.mkdirSync(path.join(tempDir, d), { recursive: true });
    const roomA = store.getOrCreateSession('order-a', { cwd: path.join(tempDir, 'order-a') }).id;
    const roomB = store.getOrCreateSession('order-b', { cwd: path.join(tempDir, 'order-b') }).id;
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/session/update',
      headers: jsonHeaders(),
      body: JSON.stringify({ action: 'reorder', order: [roomB, 'no-such-room', roomA] }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(store.sessions.get(roomB).sortOrder, 0, 'first id gets position 0');
    assert.strictEqual(store.sessions.get(roomA).sortOrder, 1, 'unknown ids do not take a position');
    for (const bad of [{ order: 'x' }, { order: [1, 2] }, { order: new Array(1001).fill('a') }]) {
      res = await request(port, {
        method: 'POST',
        urlPath: '/api/session/update',
        headers: jsonHeaders(),
        body: JSON.stringify({ action: 'reorder', ...bad }),
      });
      assert.strictEqual(res.status, 400, `reorder rejects ${JSON.stringify(bad).slice(0, 40)}`);
    }
    assert.strictEqual(store.sessions.get(roomB).sortOrder, 0, 'a rejected reorder changes nothing');
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/session/update',
      headers: jsonHeaders(),
      body: JSON.stringify({ sessionId: roomA, patch: { sortOrder: -5 } }),
    });
    assert.strictEqual(store.sessions.get(roomA).sortOrder, 1, 'sortOrder is not a free-form patch field');
    // Multi-select answers arrive once, validated, and drive the terminal in position order.
    const keyCalls = [];
    const realScanner = bridge.consoleScanner;
    bridge.consoleScanner = {
      selectOption: async (pid, cur, target) => {
        keyCalls.push([cur, target]);
        return { ok: true };
      },
    };
    store.sessions.get(roomA).pid = 4242;
    for (const bad of [
      { toggles: 'x', currentIndex: 1 },
      { toggles: [0], currentIndex: 1 },
      { toggles: [2, 2], currentIndex: 1 },
      { toggles: [1], currentIndex: 99 },
      { toggles: [1], currentIndex: 1, nextIndex: 'next' },
    ]) {
      res = await request(port, {
        method: 'POST',
        urlPath: '/api/session/multi-select',
        headers: jsonHeaders(),
        body: JSON.stringify({ sessionId: roomA, ...bad }),
      });
      assert.strictEqual(res.status, 400, `multi-select rejects ${JSON.stringify(bad)}`);
    }
    assert.strictEqual(keyCalls.length, 0, 'nothing reaches the terminal from a rejected answer');
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/session/multi-select',
      headers: jsonHeaders(),
      body: JSON.stringify({ sessionId: roomA, toggles: [4, 1], currentIndex: 3, nextIndex: 6 }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.delivered, true);
    assert.deepStrictEqual(keyCalls, [[3, 1], [1, 4], [4, 6]], 'toggles top-down, then Next');
    bridge.consoleScanner = realScanner;

    store.flush();
    const reloaded = new StateStore({ dataDir: tempDir });
    assert.strictEqual(reloaded.sessions.get(roomB).sortOrder, 0, 'the order survives a restart');

    // The terminal launcher never receives a client-supplied command line.
    let launcherOptions = null;
    bridge.openTerminalTab = async (id, opts) => {
      launcherOptions = opts;
      return { ok: true };
    };
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/session/open-terminal',
      headers: jsonHeaders(),
      body: JSON.stringify({ sessionId, command: 'calc.exe', cwd: 'Z:\\nope' }),
    });
    assert.strictEqual(res.status, 200);
    assert.ok(launcherOptions, 'launcher called');
    assert.strictEqual(launcherOptions.command, undefined);
    assert.strictEqual(launcherOptions.cwd, undefined, 'non-existent cwd dropped');

    // Spawning a room in a folder that does not exist is refused.
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/session/spawn',
      headers: jsonHeaders(),
      body: JSON.stringify({ cwd: path.join(tempDir, 'does-not-exist') }),
    });
    assert.strictEqual(res.status, 400);

    // SSE: token via query string, and bursts of events are coalesced.
    const messages = await new Promise((resolve, reject) => {
      let stream = '';
      const req = http.get(
        { host: '127.0.0.1', port, path: `/api/events?token=${TOKEN}` },
        (sse) => {
          assert.strictEqual(sse.statusCode, 200);
          sse.setEncoding('utf8');
          sse.on('data', (chunk) => {
            stream += chunk;
          });
          setTimeout(() => {
            for (let i = 0; i < 25; i++) {
              store.processHookEvent({
                session_id: sessionId,
                hook_event_name: 'PreToolUse',
                tool_name: 'Read',
                tool_input: { file_path: `f${i}.js` },
                tool_use_id: `t${i}`,
              });
            }
          }, 50);
          setTimeout(() => {
            req.destroy();
            resolve(
              stream.split('\n\n').filter((m) => m.startsWith('data: '))
            );
          }, 600);
        }
      );
      req.on('error', (err) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });
    });
    assert.ok(messages.length >= 2, `init + at least one update (got ${messages.length})`);
    assert.ok(
      messages.length <= 4,
      `25 rapid events should be coalesced (got ${messages.length} SSE messages)`
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function testLauncherQuoting() {
  assert.strictEqual(psLiteral("it's"), "'it''s'");
  assert.strictEqual(psLiteral('smart\u2019quote'), "'smart\u2019\u2019quote'");

  const evilRoom = "x'; Start-Process calc; '";
  const script = buildTerminalScript({
    cwd: "C:\\a'b",
    room: evilRoom,
    claudeArgs: ['--resume', '11111111-2222-3333-4444-555555555555'],
    banner: `hello ${evilRoom}`,
  });
  assert.ok(script.includes(`$env:AMC_ROOM = 'x''; Start-Process calc; '''`));
  assert.ok(script.includes("Set-Location -LiteralPath 'C:\\a''b'"));
  assert.ok(
    script.endsWith("& claude '--resume' '11111111-2222-3333-4444-555555555555'")
  );

  assert.ok(!safeTitle('room; new-tab cmd /c calc').includes(';'));
  assert.ok(!safeTitle('a"b').includes('"'));

  assert.strictEqual(resolveResumeId({ id: 'x', claudeSessionId: 'abc & calc' }), null);
  assert.strictEqual(
    resolveResumeId({ id: '11111111-2222-3333-4444-555555555555' }),
    '11111111-2222-3333-4444-555555555555'
  );
}

async function testCommandBridge(tempDir) {
  const store = new StateStore({ dataDir: path.join(tempDir, 'bridge') });
  const bridge = new CommandBridge(store, null);
  store.getOrCreateSession('room-1', { room: 'Room 1', cwd: tempDir });

  // No live transport: report honestly instead of claiming success.
  let res = await bridge.dispatchCommand('room-1', 'run the tests');
  assert.strictEqual(res.delivered, false);
  assert.strictEqual(res.transport, 'mission-control-queue');

  // "1" / "ok" are only approvals when something is pending.
  res = await bridge.dispatchCommand('room-1', 'ok');
  assert.notStrictEqual(store.sessions.get('room-1').statusLabel, 'ได้รับ Approve • กำลังรันต่อ');

  // Headless runs never put the prompt on a shell command line.
  let headlessPrompt = null;
  bridge._spawnClaudeHeadless = (session, prompt) => {
    headlessPrompt = prompt;
  };
  res = await bridge.dispatchCommand('room-1', 'echo hi & calc', { runHeadless: true });
  assert.strictEqual(res.delivered, true);
  assert.strictEqual(headlessPrompt, 'echo hi & calc');

  // Unknown key names are refused before reaching the console bridge.
  res = await bridge.sendTerminalKey('room-1', 'enter; rm -rf');
  assert.strictEqual(res.ok, false);

  // Option index 0 / garbage falls back safely instead of being coerced.
  res = await bridge.selectInteractiveOption('room-1', { targetIndex: 'abc' });
  assert.strictEqual(res.delivered, false);
  store.flush();
}

function testStorePersistence(tempDir) {
  const dataDir = path.join(tempDir, 'persist');
  const store = new StateStore({ dataDir, saveDebounceMs: 10000 });
  store.getOrCreateSession('p-1', { room: 'Persist', cwd: tempDir });
  store.updateSession('p-1', { goal: 'g1' });
  store.updateSession('p-1', { goal: 'g2' });
  store.flush();
  const saved = JSON.parse(fs.readFileSync(store.stateFile, 'utf8'));
  assert.ok(saved.sessions.some((s) => s.id === 'p-1' && s.goal === 'g2'));
  assert.deepStrictEqual(
    fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp')),
    [],
    'atomic write leaves no temp files'
  );
}

function testSecurityHelpers() {
  assert.ok(isAllowedHost('127.0.0.1:4310'));
  assert.ok(isAllowedHost('localhost:4310'));
  assert.ok(isAllowedHost('[::1]:4310'));
  assert.ok(!isAllowedHost('evil.example:4310'));
  assert.ok(!isAllowedHost('127.0.0.1.evil.example'));
  assert.ok(!isAllowedHost(undefined));
  assert.ok(isAllowedOrigin(undefined));
  assert.ok(isAllowedOrigin('http://127.0.0.1:4310'));
  assert.ok(!isAllowedOrigin('null'));
  assert.ok(!isAllowedOrigin('https://localhost.evil.example'));
  assert.ok(tokensEqual('abc', 'abc'));
  assert.ok(!tokensEqual('abc', 'abd'));
  assert.ok(!tokensEqual('', ''));
}

/** Loads the dashboard's escaping helpers in a sandbox and checks they neutralise markup. */
function testDashboardEscaping() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = src.indexOf('function escapeHtml');
  const end = src.indexOf('function runAction');
  assert.ok(start !== -1 && end > start, 'helpers found in app.js');
  const sandbox = {};
  vm.runInNewContext(`${src.slice(start, end)}; this.escapeHtml = escapeHtml; this.act = act;`, sandbox);

  const payload = `&#39;);alert(1)//"><img src=x onerror=alert(2)>`;
  const attrs = sandbox.act('selectChoiceOption', 'id', 1, 1, '1', payload);
  assert.ok(!/[<>]/.test(attrs), 'no raw angle brackets');
  assert.ok(!attrs.includes('onclick'), 'no inline handler');
  // Attribute values must not contain an unescaped quote that could close them.
  const values = attrs.match(/="([^"]*)"/g);
  assert.strictEqual(values.length, 2);
  assert.ok(!src.includes('escapeJsAttr'), 'inline-JS escaping helper is gone');
  assert.ok(!/onclick="[^"]*\$\{/.test(src), 'no inline handler interpolates data');
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-sec-'));
  try {
    testSecurityHelpers();
    testLauncherQuoting();
    testDashboardEscaping();
    testStorePersistence(tempDir);
    await testCommandBridge(tempDir);
    await testHttpLayer(tempDir);
    console.log('✅ Security & robustness checks passed!');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('❌ Security checks failed:', err);
  process.exit(1);
});
