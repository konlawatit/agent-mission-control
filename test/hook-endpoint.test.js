/**
 * POST /api/hook/claude: the endpoint Claude Code's `type: "http"` hooks post to. Its answer is
 * Claude Code's hook output, so it is `{}` or a block decision, and it never fails a request:
 * any non-2xx answer shows up as a warning on the user's tool call.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-hookapi-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

const { createMissionControlServer } = require('../src/server');
const { encodeProjectDir } = require('../src/transcript-parser');

const TOKEN = 'c'.repeat(48);
// What the installer writes into settings.json: a token for the hook endpoint only.
const HOOK_TOKEN = crypto
  .createHmac('sha256', TOKEN)
  .update('amc-hook-endpoint-v1')
  .digest('hex')
  .slice(0, 48);
const SID_HOOKTOKEN = '7b1e0a52-9c1d-4f6e-8a2b-3c4d5e6f7a8b';
const SID_A = '88630827-3ff5-40f2-a81d-2d2792b8d03f';
const SID_HDR = '28d1e238-e03b-4884-adf1-736c36cbaa00';
const SID_NOHDR = '43297ae1-cfec-40c7-84ba-b1874f82b73f';
const SID_SDK = 'ec018271-3578-4606-af90-421bac69aa12';
const SID_UNKNOWN = '19557dfd-7c63-4ffd-9a2d-ee84cc3611fb';

function request(port, { method = 'POST', urlPath, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch {}
        resolve({ status: res.statusCode, raw, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const jsonHeaders = (extra = {}) => ({
  'X-AMC-Token': TOKEN,
  'Content-Type': 'application/json',
  ...extra,
});

/** The server answers first and processes on the next tick; give that tick time to run. */
const settle = () => new Promise((r) => setTimeout(r, 25));

async function postHook(port, payload, extraHeaders = {}) {
  const res = await request(port, {
    urlPath: '/api/hook/claude',
    headers: jsonHeaders(extraHeaders),
    body: JSON.stringify(payload),
  });
  await settle();
  return res;
}

function roomDir(name) {
  const dir = path.join(isolatedHome, 'rooms', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A registry file as Claude Code 2.1.332 writes it into ~/.claude/sessions. */
function writeRegistryEntry(dir, pid, sessionId, entrypoint) {
  fs.writeFileSync(
    path.join(dir, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      cwd: 'C:\\somewhere',
      startedAt: 1795631483360,
      procStart: '134401050784146921',
      version: '2.1.332',
      peerProtocol: 1,
      kind: entrypoint === 'cli' ? 'interactive' : 'headless',
      entrypoint,
      pidDomain: 'win32:comp',
    }),
    'utf8'
  );
}

/** A hook body with the fields Claude Code 2.1.332 sends. */
function hookBody(sessionId, cwd, event, extra = {}) {
  return {
    session_id: sessionId,
    transcript_path: path.join(
      isolatedHome,
      '.claude',
      'projects',
      encodeProjectDir(cwd),
      `${sessionId}.jsonl`
    ),
    cwd,
    prompt_id: 'd2a4c1de-0000-4000-8000-000000000001',
    permission_mode: 'default',
    hook_event_name: event,
    ...extra,
  };
}

const readTool = (cwd) => ({
  effort: 'high',
  tool_name: 'Read',
  tool_input: { file_path: path.join(cwd, 'a.txt') },
  tool_use_id: 'toolu_01',
});

const findRoom = (store, sessionId) =>
  Array.from(store.sessions.values()).find((s) => s.claudeSessionId === sessionId);

async function testRequiresToken(port) {
  const res = await request(port, {
    urlPath: '/api/hook/claude',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.strictEqual(res.status, 401, 'the hook endpoint is behind the API token');
}

async function testAnswersEmptyAndProcesses(port, store) {
  const cwd = roomDir('a');
  const res = await postHook(port, hookBody(SID_A, cwd, 'PreToolUse', readTool(cwd)));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.raw, '{}', "Claude Code's hook output: nothing to say");

  const room = findRoom(store, SID_A);
  assert.ok(room, 'the event created the room');
  assert.strictEqual(room.pid, 4242, 'pid comes from the session registry');
  assert.strictEqual(room.status, 'working');
}

async function testHeadersCarryTerminalIds(port, store) {
  const cwd = roomDir('hdr');
  await postHook(port, hookBody(SID_HDR, cwd, 'PreToolUse', readTool(cwd)), {
    'X-AMC-WT-Session': 'wt-abc',
    'X-AMC-Pane': 'pane-7',
    'X-AMC-Tmux-Pane': '',
  });
  const room = findRoom(store, SID_HDR);
  assert.strictEqual(room.wtSession, 'wt-abc');
  assert.strictEqual(room.paneId, 'pane-7');

  // Claude Code sends an empty value for a variable that is not set in its environment.
  const cwd2 = roomDir('nohdr');
  await postHook(port, hookBody(SID_NOHDR, cwd2, 'PreToolUse', readTool(cwd2)), {
    'X-AMC-WT-Session': '',
    'X-AMC-Pane': '',
    'X-AMC-Tmux-Pane': '',
  });
  const bare = findRoom(store, SID_NOHDR);
  assert.strictEqual(bare.wtSession, null);
  assert.strictEqual(bare.paneId, null);
}

async function testUnknownSessionStillProcessed(port, store) {
  const cwd = roomDir('unknown');
  const res = await postHook(port, hookBody(SID_UNKNOWN, cwd, 'PreToolUse', readTool(cwd)), {
    'X-AMC-Pane': '',
    'X-AMC-Tmux-Pane': '%3',
  });
  assert.strictEqual(res.raw, '{}');
  const room = findRoom(store, SID_UNKNOWN);
  assert.ok(room, 'a session the registry does not know still gets its room');
  assert.ok(!room.pid, 'and simply has no pid');
  assert.strictEqual(room.paneId, '%3', 'tmux pane is used when there is no WezTerm pane');
}

async function testHoldBlocksPromptsOnly(port, store) {
  const cwdA = findRoom(store, SID_A).cwd;
  let res = await request(port, {
    urlPath: '/api/usage/config',
    headers: jsonHeaders(),
    body: JSON.stringify({ action: 'simulate-low-quota' }),
  });
  assert.strictEqual(res.json.ok, true);

  res = await postHook(port, hookBody(SID_A, cwdA, 'UserPromptSubmit', { prompt: 'do it' }));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(Object.keys(res.json).sort(), ['decision', 'reason']);
  assert.strictEqual(res.json.decision, 'block');
  assert.ok(res.json.reason.includes('Mission Control'), res.json.reason);
  assert.notStrictEqual(findRoom(store, SID_A).goal, 'do it', 'a blocked prompt is not recorded');

  res = await postHook(port, hookBody(SID_A, cwdA, 'PreToolUse', readTool(cwdA)));
  assert.strictEqual(res.raw, '{}', 'only new prompts are held; a running step finishes');

  // `claude -p` / SDK runs belong to other tooling: never held, and they get no room.
  const cwdSdk = roomDir('sdk');
  res = await postHook(port, hookBody(SID_SDK, cwdSdk, 'UserPromptSubmit', { prompt: 'scripted' }));
  assert.strictEqual(res.raw, '{}');
  assert.strictEqual(findRoom(store, SID_SDK), undefined);

  // Turning the guard off lifts the hold without sending resume prompts anywhere.
  res = await request(port, {
    urlPath: '/api/usage/config',
    headers: jsonHeaders(),
    body: JSON.stringify({ enabled: false }),
  });
  assert.strictEqual(res.json.ok, true);
  res = await postHook(port, hookBody(SID_A, cwdA, 'UserPromptSubmit', { prompt: 'do it now' }));
  assert.strictEqual(res.raw, '{}');
  assert.strictEqual(findRoom(store, SID_A).goal, 'do it now', 'prompts flow again');
}

async function testBadBodiesStillOk(port, store) {
  const cwdA = findRoom(store, SID_A).cwd;
  const huge = JSON.stringify(
    hookBody(SID_A, cwdA, 'PostToolUse', {
      ...readTool(cwdA),
      tool_response: 'x'.repeat(3 * 1024 * 1024),
    })
  );
  let res = await request(port, { urlPath: '/api/hook/claude', headers: jsonHeaders(), body: huge });
  assert.strictEqual(res.status, 200, 'a screenshot-sized tool result must not become a warning');
  assert.strictEqual(res.raw, '{}');

  res = await request(port, {
    urlPath: '/api/hook/claude',
    headers: jsonHeaders(),
    body: '{not json',
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.raw, '{}');

  const cwdText = roomDir('text');
  res = await request(port, {
    urlPath: '/api/hook/claude',
    headers: { 'X-AMC-Token': TOKEN, 'Content-Type': 'text/plain' },
    body: JSON.stringify(hookBody(SID_SDK, cwdText, 'PreToolUse', readTool(cwdText))),
  });
  await settle();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.raw, '{}');
  assert.ok(
    !Array.from(store.sessions.values()).some((s) => s.cwd === cwdText),
    'only application/json bodies are acted on'
  );
}

async function testLegacyEndpointUnchanged(port) {
  const cwd = roomDir('legacy');
  const res = await request(port, {
    urlPath: '/api/hook',
    headers: jsonHeaders(),
    body: JSON.stringify({
      session_id: 'wrap-legacy-1',
      room: 'Auth',
      cwd,
      cli: 'claude (wrapped)',
      wrapper_connected: true,
      hook_event_name: 'SessionStart',
    }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.ok, true);
  assert.ok(Array.isArray(res.json.pendingCommands), 'the hook script and `amc run` still get their reply');
}

async function testHookTokenOpensOnlyTheHookRoute(port, store) {
  const hookOnly = { 'X-AMC-Token': HOOK_TOKEN, 'Content-Type': 'application/json' };
  const cwd = roomDir('hooktoken');

  let res = await request(port, {
    urlPath: '/api/hook/claude',
    headers: hookOnly,
    body: JSON.stringify(hookBody(SID_HOOKTOKEN, cwd, 'PreToolUse', readTool(cwd))),
  });
  await settle();
  assert.strictEqual(res.status, 200);
  assert.ok(findRoom(store, SID_HOOKTOKEN), 'the token in settings.json delivers hook events');

  // settings.json is not a private file; what it holds must not open the rest of the API.
  res = await request(port, { method: 'GET', urlPath: '/api/state', headers: hookOnly });
  assert.strictEqual(res.status, 401, 'it cannot read the dashboard state');
  res = await request(port, {
    urlPath: '/api/session/command',
    headers: hookOnly,
    body: JSON.stringify({ sessionId: findRoom(store, SID_HOOKTOKEN).id, command: 'echo hi' }),
  });
  assert.strictEqual(res.status, 401, 'it cannot send text into a terminal');
  res = await request(port, {
    urlPath: '/api/hook',
    headers: hookOnly,
    body: JSON.stringify({ session_id: 'wrap-x', cwd, hook_event_name: 'SessionStart' }),
  });
  assert.strictEqual(res.status, 401, 'nor use the older hook route');
}

async function testInstallButtonUsesThisServer(port) {
  const settingsPath = path.join(isolatedHome, '.claude', 'settings.json');
  let res = await request(port, { urlPath: '/api/hooks/install', headers: jsonHeaders(), body: '{}' });
  assert.strictEqual(res.json.installed, true);
  const hook = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PreToolUse[0].hooks[0];
  assert.strictEqual(hook.url, `http://127.0.0.1:${port}/api/hook/claude`, "this server's own port");
  assert.strictEqual(hook.headers['X-AMC-Token'], HOOK_TOKEN, "this server's hook-only token");

  res = await request(port, { method: 'GET', urlPath: '/api/hooks/status', headers: jsonHeaders() });
  assert.strictEqual(res.json.installed, true);

  // Another instance, on another port, takes the hooks over: this server is no longer connected.
  const taken = fs.readFileSync(settingsPath, 'utf8').split(`:${port}/`).join(`:${port + 1}/`);
  fs.writeFileSync(settingsPath, taken, 'utf8');
  res = await request(port, { method: 'GET', urlPath: '/api/hooks/status', headers: jsonHeaders() });
  assert.strictEqual(res.json.installed, false, 'the dashboard shows it lost its hooks');
  res = await request(port, { method: 'GET', urlPath: '/api/state', headers: jsonHeaders() });
  assert.strictEqual(res.json.hooks.installed, false);

  res = await request(port, { urlPath: '/api/hooks/uninstall', headers: jsonHeaders(), body: '{}' });
  assert.strictEqual(res.json.uninstalled, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks, {});
}

async function run() {
  const sessionsDir = path.join(isolatedHome, 'claude-sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  // Written before the first request: the server reuses one scan of this folder for 2 s.
  writeRegistryEntry(sessionsDir, 4242, SID_A, 'cli');
  writeRegistryEntry(sessionsDir, 4343, SID_HDR, 'cli');
  writeRegistryEntry(sessionsDir, 4344, SID_NOHDR, 'cli');
  writeRegistryEntry(sessionsDir, 5151, SID_SDK, 'sdk-cli');

  const dataDir = path.join(isolatedHome, 'data');
  const { server, store } = createMissionControlServer({
    dataDir,
    token: TOKEN,
    disableScanner: true,
    offlineFile: path.join(dataDir, 'offline-events.jsonl'),
    claudeSessionsDir: sessionsDir,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    await testRequiresToken(port);
    await testAnswersEmptyAndProcesses(port, store);
    await testHeadersCarryTerminalIds(port, store);
    await testUnknownSessionStillProcessed(port, store);
    await testHoldBlocksPromptsOnly(port, store);
    await testBadBodiesStillOk(port, store);
    await testLegacyEndpointUnchanged(port);
    await testHookTokenOpensOnlyTheHookRoute(port, store);
    await testInstallButtonUsesThisServer(port);
    console.log('✅ HTTP hook endpoint checks passed!');
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('❌ HTTP hook endpoint checks failed:', err);
  process.exit(1);
});
