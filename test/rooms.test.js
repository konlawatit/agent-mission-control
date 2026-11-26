/**
 * Which room a hook event belongs to. Mirrors the e2e-forge case: an interactive session that
 * `cd`s into a worktree, and a `claude -p` probe run inside that worktree.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-home-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
const {
  encodeProjectDir,
  launchCwdFor,
  findTranscriptsForCwd,
  clearCaches,
} = require('../src/transcript-parser');
const { StateStore } = require('../src/state-store');
const { createMissionControlServer } = require('../src/server');

const SID_MAIN = '88630827-3ff5-40f2-a81d-2d2792b8d03f';
const SID_PROBE = 'ec018271-3578-4606-af90-421bac69aa12';

const repo = path.join(isolatedHome, 'repos', 'e2e-forge');
const worktree = path.join(repo, '.worktrees', 'partner');
fs.mkdirSync(worktree, { recursive: true });
const projects = path.join(isolatedHome, '.claude', 'projects');

function transcript(cwd, sid, entrypoint) {
  const dir = path.join(projects, encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  const entry = { type: 'user', entrypoint, cwd, sessionId: sid, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } };
  fs.writeFileSync(file, JSON.stringify(entry) + '\n');
  return file;
}
const mainTranscript = transcript(repo, SID_MAIN, 'cli');
const probeTranscript = transcript(worktree, SID_PROBE, 'sdk-cli');

// 1. Folder names are encoded the way Claude Code does, and only a folder's own transcripts count.
{
  assert.strictEqual(encodeProjectDir('C:\\Users\\a\\e2e-forge\\.worktrees\\partner'), 'C--Users-a-e2e-forge--worktrees-partner');
  clearCaches();
  const own = findTranscriptsForCwd(repo).map((t) => t.sessionId);
  assert.deepStrictEqual(own, [SID_MAIN], 'the worktree\'s transcripts are not the repo\'s');
  assert.strictEqual(launchCwdFor(worktree, mainTranscript), repo, 'a cd into the worktree still maps to where the session started');
  assert.strictEqual(launchCwdFor(worktree, probeTranscript), worktree);
}

function newStore() {
  return new StateStore({ dataDir: fs.mkdtempSync(path.join(isolatedHome, 'data-')), saveDebounceMs: 0 });
}

// 2. An interactive session that cd'ed into a worktree stays in its own room.
{
  const store = newStore();
  const room = store.getOrCreateSession('claude-pid-500', { cwd: repo, pid: 500 });
  const before = store.sessions.size;
  const ev = (extra) =>
    store.processHookEvent({
      session_id: SID_MAIN,
      cwd: worktree, // where Bash cd'ed to
      transcript_path: mainTranscript,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'why so few?',
      ...extra,
    });
  assert.strictEqual(ev({ claude_pid: 500, entrypoint: 'cli' }), room, 'matched by the claude process id');
  assert.strictEqual(ev({}), room, 'without the pid, matched by the folder the session started in');
  assert.strictEqual(store.sessions.size, before, 'no "partner" room appears');
  assert.ok(room.cwd === repo && room.room === 'e2e-forge', 'the room keeps its folder and name');
  assert.strictEqual(room.claudeSessionId, SID_MAIN);
  store.flush();
}

// 3. A `claude -p` probe gets no room, even when it inherited CLAUDE_CODE_ENTRYPOINT=cli.
{
  const store = newStore();
  store.getOrCreateSession('claude-pid-500', { cwd: repo, pid: 500 });
  const before = store.sessions.size;
  for (const hook_event_name of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
    const r = store.processHookEvent({ session_id: SID_PROBE, cwd: worktree, transcript_path: probeTranscript, hook_event_name, entrypoint: 'cli', claude_pid: 500 });
    assert.strictEqual(r, null, `${hook_event_name} from the probe is ignored`);
  }
  const r = store.processHookEvent({ session_id: '11111111-2222-3333-4444-555555555555', cwd: worktree, hook_event_name: 'SessionStart', entrypoint: 'sdk-ts' });
  assert.strictEqual(r, null, 'an SDK session without a transcript yet is ignored too');
  assert.strictEqual(store.sessions.size, before, 'no rooms were created');
  store.flush();
}

// 4. The dashboard's own background run (`claude -p --resume`) still updates its room.
{
  const store = newStore();
  const room = store.getOrCreateSession('claude-pid-600', { cwd: repo, pid: 600 });
  room.claudeSessionId = SID_MAIN;
  const r = store.processHookEvent({ session_id: SID_MAIN, cwd: repo, transcript_path: mainTranscript, hook_event_name: 'UserPromptSubmit', prompt: 'go', entrypoint: 'sdk-cli' });
  assert.strictEqual(r, room);
  assert.strictEqual(room.status, 'working');
  store.flush();
}

// 5. Rooms a probe created earlier are dropped when the state is loaded.
{
  const dataDir = fs.mkdtempSync(path.join(isolatedHome, 'data-'));
  fs.writeFileSync(
    path.join(dataDir, 'sessions-state.json'),
    JSON.stringify({
      sessions: [
        { id: SID_PROBE, room: 'partner', cwd: worktree, lifecycle: 'live', status: 'needs_input', transcriptPath: mainTranscript, taskHistory: [], recentEvents: [], subAgents: [], modifiedFiles: [] },
        { id: 'claude-pid-700', room: 'e2e-forge', cwd: repo, lifecycle: 'live', status: 'idle', taskHistory: [], recentEvents: [], subAgents: [], modifiedFiles: [] },
      ],
    })
  );
  const store = new StateStore({ dataDir });
  assert.ok(!store.sessions.has(SID_PROBE), 'the probe\'s room is gone');
  assert.ok(store.sessions.has('claude-pid-700'), 'real rooms stay');
  store.flush();
}

// 6. Over HTTP: automated events are acknowledged but ignored, and never held.
(async () => {
  const dataDir = fs.mkdtempSync(path.join(isolatedHome, 'srv-'));
  const token = 'b'.repeat(48);
  const { server, store, usageGuard } = createMissionControlServer({ dataDir, token, disableScanner: true, offlineFile: path.join(dataDir, 'off.jsonl') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const post = (body) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/api/hook', agent: false, headers: { 'Content-Type': 'application/json', 'X-AMC-Token': token, 'Content-Length': Buffer.byteLength(data) } },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => resolve(JSON.parse(raw)));
        }
      );
      req.on('error', reject);
      req.end(data);
    });
  try {
    usageGuard.isHolding = () => true; // pretend a usage hold is on
    let res = await post({ session_id: SID_PROBE, cwd: worktree, transcript_path: probeTranscript, hook_event_name: 'UserPromptSubmit', prompt: 'ok', entrypoint: 'sdk-cli' });
    assert.strictEqual(res.ignored, 'automated');
    assert.ok(!res.hold, 'automated runs are not held');
    res = await post({ session_id: SID_MAIN, cwd: repo, transcript_path: mainTranscript, hook_event_name: 'UserPromptSubmit', prompt: 'go', entrypoint: 'cli' });
    assert.ok(res.hold, 'a person\'s prompt is held as before');
    assert.strictEqual(store.sessions.size, 0, 'no room from the ignored event');

    // Reading back a room's conversation: only its own Claude transcript, validated paging.
    const get = (urlPath) =>
      new Promise((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: urlPath, agent: false, headers: { 'X-AMC-Token': token } }, (r) => {
            let raw = '';
            r.on('data', (c) => (raw += c));
            r.on('end', () => resolve({ status: r.statusCode, json: JSON.parse(raw) }));
          })
          .on('error', reject);
      });
    const room = store.getOrCreateSession('read-room', { cwd: repo });
    room.transcriptPath = mainTranscript;
    let page = await get(`/api/session/conversation?sessionId=read-room&limit=10`);
    assert.strictEqual(page.status, 200);
    assert.deepStrictEqual(page.json.lines, ['🧑 คุณ: hi']);
    assert.strictEqual(page.json.done, true);
    page = await get(`/api/session/conversation?sessionId=read-room&before=-1`);
    assert.strictEqual(page.status, 400, 'negative offsets are refused');
    page = await get(`/api/session/conversation?sessionId=read-room&limit=5000`);
    assert.strictEqual(page.status, 400, 'oversized pages are refused');
    const outside = path.join(isolatedHome, 'not-a-transcript.jsonl');
    fs.writeFileSync(outside, JSON.stringify({ type: 'user', message: { role: 'user', content: 'secret' } }) + '\n');
    room.transcriptPath = outside;
    page = await get(`/api/session/conversation?sessionId=read-room`);
    assert.deepStrictEqual(page.json.lines, [], 'files outside ~/.claude/projects are never read');
    page = await get(`/api/session/conversation?sessionId=nope`);
    assert.strictEqual(page.status, 404);
  } finally {
    server.close();
    store.flush();
  }
  console.log('✅ Room matching checks passed!');
})().catch((err) => {
  console.error('❌ Room matching checks failed:', err);
  process.exit(1);
});
