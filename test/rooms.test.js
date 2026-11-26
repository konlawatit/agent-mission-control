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
  // The run's own process starting and exiting neither idles nor closes the room.
  for (const hook_event_name of ['SessionStart', 'SessionEnd']) {
    assert.strictEqual(store.processHookEvent({ session_id: SID_MAIN, cwd: repo, transcript_path: mainTranscript, hook_event_name, entrypoint: 'sdk-cli' }), room);
  }
  assert.strictEqual(room.status, 'working');
  assert.strictEqual(room.lifecycle, 'live');
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

// 5b. Two sessions started together in one folder, before any hook: each terminal gets its own
//     transcript from Claude Code's session registry, not the newest one in the folder.
{
  const sessionsDir = path.join(isolatedHome, '.claude', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const SID_OLDER = '22222222-1111-4111-8111-000000000001';
  const SID_NEWER = '22222222-1111-4111-8111-000000000002';
  const SID_FRESH = '22222222-1111-4111-8111-000000000003';
  const older = transcript(repo, SID_OLDER, 'cli');
  const newer = transcript(repo, SID_NEWER, 'cli');
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(newer, later, later); // the newest file in the folder
  const reg = (pid, sessionId) =>
    fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: repo, startedAt: Date.now(), kind: 'interactive', entrypoint: 'cli' }));
  reg(701, SID_OLDER);
  reg(702, SID_NEWER);
  reg(703, SID_FRESH); // just opened: no transcript yet
  clearCaches();
  const store = new StateStore({ dataDir: fs.mkdtempSync(path.join(isolatedHome, 'data-')), claudeSessionsDir: sessionsDir });
  const screen = 'Claude Code\n> ';
  store.ingestConsoleScan([
    { pid: 701, cwd: repo, screen },
    { pid: 702, cwd: repo, screen },
    { pid: 703, cwd: repo, screen },
  ]);
  const byPid = (pid) => Array.from(store.sessions.values()).find((s) => Number(s.pid) === pid);
  assert.strictEqual(byPid(701).claudeSessionId, SID_OLDER);
  assert.strictEqual(byPid(701).transcriptPath, older, 'the older session keeps its own transcript');
  assert.strictEqual(byPid(702).transcriptPath, newer);
  assert.ok(!byPid(703).transcriptPath, 'a session with no transcript yet borrows nobody else\'s');

  // /clear: the same terminal moves to a new session.
  const SID_CLEARED = '22222222-1111-4111-8111-000000000004';
  const cleared = transcript(repo, SID_CLEARED, 'cli');
  reg(701, SID_CLEARED);
  clearCaches();
  require('../src/claude-sessions').clearSessionRegistryCache();
  store.ingestConsoleScan([{ pid: 701, cwd: repo, screen }, { pid: 702, cwd: repo, screen }, { pid: 703, cwd: repo, screen }]);
  assert.strictEqual(byPid(701).transcriptPath, cleared, 'after /clear the room follows the new session');
  store.flush();
}

// 7. Room state seen live on Claude Code 2.1.332: slash commands, archiving a room whose terminal is
//    still open, stale TL;DRs, the model, and the first screen of a new session.
const { parseConsoleScreen } = require('../src/console-scanner');
const { parseTranscriptTailUncached } = require('../src/transcript-parser');
const { CommandBridge } = require('../src/command-bridge');

const RULE = '─'.repeat(60);
const BANNER = (model, cwd) => [' ▐▛███▜▌   Claude Code v2.1.332', `▝▜█████▛▘  ${model}`, `  ▘▘ ▝▝    ${cwd}`, ''];
const idleScreen = (above = []) => [...above, RULE, '❯ ', RULE, '  ? for shortcuts'].join('\r\n');
const busyScreen = (above = []) => [...above, '✶ Cogitating… (5s · ↓ 120 tokens)', '', RULE, '❯ ', RULE, '  · esc to interrupt · Opus 5.5 · 5h 16%'].join('\r\n');
const modelPicker = [
  RULE,
  ' Select model',
  ' Switch between Claude models. Applies to this session and future Claude Code sessions.',
  '',
  ' ❯ 1. Default (recommended)   Opus 5.5 · Most capable',
  '   2. Sonnet                  Sonnet 5.5 · Everyday tasks',
  '   3. Haiku                   Haiku 5.5 · Fastest',
  '',
  ' Enter to confirm · Esc to exit',
].join('\r\n');

/** A terminal the dashboard can type into without a real console. */
function fakeScanner() {
  const typed = [];
  return {
    typed,
    sendText: async (pid, text) => (typed.push(text), { ok: true }),
    sendKey: async () => ({ ok: true }),
    selectOption: async () => ({ ok: true }),
    scanOnce: async () => {},
  };
}

/** A store whose clock the test moves. */
function clockedStore(dataDir = fs.mkdtempSync(path.join(isolatedHome, 'data-'))) {
  const clock = { t: Date.now() };
  const store = new StateStore({ dataDir, saveDebounceMs: 0, now: () => clock.t });
  return { store, clock, dataDir };
}

function freshFolder(name) {
  const dir = path.join(isolatedHome, 'rooms', `${name}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function roomStateChecks() {
  // 7a. Local slash commands sent from the dashboard (or reported by a hook) leave the room as it was.
  {
    const { store } = clockedStore();
    const cwd = freshFolder('slash');
    const bridge = new CommandBridge(store, fakeScanner());
    store.ingestConsoleScan([{ pid: 910, cwd, screen: idleScreen(BANNER('Opus 5.5 · API Usage Billing', cwd)) }]);
    const room = Array.from(store.sessions.values()).find((s) => s.pid === 910);
    store.processHookEvent({ session_id: room.id, cwd, hook_event_name: 'Stop', summary: 'แก้บั๊กเสร็จแล้ว' });
    const before = { status: room.status, tldr: room.tldr, goal: room.goal, statusLabel: room.statusLabel };
    for (const cmd of ['/effort high', '/model sonnet', '/usage', '/context', '/effort medium']) {
      const r = await bridge.dispatchCommand(room.id, cmd);
      assert.ok(r.delivered, `${cmd} reached the terminal`);
      assert.deepStrictEqual(
        { status: room.status, tldr: room.tldr, goal: room.goal, statusLabel: room.statusLabel },
        before,
        `${cmd} does not start a turn`
      );
    }
    // Claude Code's own UserPromptSubmit for a local command changes nothing either.
    store.processHookEvent({ session_id: room.id, cwd, hook_event_name: 'UserPromptSubmit', prompt: '/usage' });
    assert.strictEqual(room.status, before.status, 'a /usage hook is not a turn');
    // A custom command or skill is a prompt: Claude works on it.
    await bridge.dispatchCommand(room.id, '/review the auth module');
    assert.strictEqual(room.status, 'working', 'a prompt-type slash command still starts a turn');
    store.flush();
  }

  // 7b. A room left "working" with no turn running (no Stop ever came) settles once the terminal
  //     has sat idle for a while with no hook activity, and never while the screen is busy.
  {
    const { store, clock } = clockedStore();
    const cwd = freshFolder('stale');
    store.ingestConsoleScan([{ pid: 911, cwd, screen: idleScreen(BANNER('Opus 5.5 · API Usage Billing', cwd)) }]);
    const room = Array.from(store.sessions.values()).find((s) => s.pid === 911);
    store.processHookEvent({ session_id: room.id, cwd, hook_event_name: 'UserPromptSubmit', prompt: 'อธิบายโค้ดนี้หน่อย' });
    assert.strictEqual(room.status, 'working');
    const scan = (screen) => store.ingestConsoleScan([{ pid: 911, cwd, screen }]);

    // A real turn: busy for a long time, then a stretch the scanner happens to read as idle but with
    // fresh hook activity.
    for (let i = 0; i < 10; i++) {
      clock.t += 5000;
      scan(busyScreen());
    }
    assert.strictEqual(room.status, 'working', 'a busy screen is a running turn');
    clock.t += 2000;
    scan(idleScreen());
    clock.t += 2000;
    scan(idleScreen());
    assert.strictEqual(room.status, 'working', 'a few idle seconds are not enough');
    store.processHookEvent({ session_id: room.id, cwd, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.js' } });
    clock.t += 9000;
    scan(idleScreen());
    assert.strictEqual(room.status, 'working', 'recent hook activity keeps it working');
    store.processHookEvent({ session_id: room.id, cwd, hook_event_name: 'PostToolUse', tool_name: 'Read' });
    room.workingSignalAt = new Date(clock.t - 60000).toISOString(); // no hook for a minute
    clock.t += 2000;
    scan(busyScreen());
    clock.t += 2000;
    scan(idleScreen());
    assert.strictEqual(room.status, 'working', 'the idle stretch starts over after a busy screen');
    clock.t += 11000;
    scan(idleScreen());
    assert.notStrictEqual(room.status, 'working', 'idle screen + no hooks for >10 s: not working');
    assert.ok(!/รับคำสั่งใหม่/.test(room.tldr), `the TL;DR no longer says a command is being analysed: ${room.tldr}`);

    // A background `claude -p` run for the same room works while its terminal sits idle.
    store.recordSentPrompt(room.id, 'สรุป diff ให้หน่อย', { viaTerminal: false });
    assert.strictEqual(room.status, 'working');
    for (let i = 0; i < 4; i++) {
      clock.t += 6000;
      scan(idleScreen());
    }
    assert.strictEqual(room.status, 'working', 'a background run is not settled by the idle terminal');
    store.processHookEvent({ session_id: room.id, cwd, hook_event_name: 'Stop', summary: 'สรุปแล้ว' });
    assert.strictEqual(room.status, 'done');
    assert.ok(!room.backgroundRunAt, 'its Stop ends the background run');
    store.flush();
  }

  // 7c. In the transcript, a local command is not a turn: the last turn stays done.
  {
    const file = path.join(freshFolder('tx'), 'local.jsonl');
    const ts = (s) => new Date(Date.UTC(2026, 10, 26, 7, 0, s)).toISOString();
    const lines = [
      { type: 'user', timestamp: ts(0), message: { role: 'user', content: 'hi' } },
      { type: 'assistant', timestamp: ts(1), message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'user', timestamp: ts(2), isMeta: true, rowSource: 'harness', message: { role: 'user', content: '<local-command-caveat>The command below was run directly in Claude Code</local-command-caveat>' } },
      { type: 'user', timestamp: ts(2), rowSource: 'local', message: { role: 'user', content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>fable</command-args>' } },
      { type: 'user', timestamp: ts(2), rowSource: 'local', message: { role: 'user', content: '<local-command-stdout>Set model to `Fable 5.2` and saved as your default for new sessions</local-command-stdout>' } },
      { type: 'user', timestamp: ts(3), message: { role: 'user', content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>' } },
      { type: 'user', timestamp: ts(3), message: { role: 'user', content: '<local-command-stdout>Set effort level to high (saved as your default for new sessions)</local-command-stdout>' } },
      { type: 'user', timestamp: ts(5), message: { role: 'user', content: '<bash-input>git status</bash-input>' } },
      { type: 'user', timestamp: ts(5), message: { role: 'user', content: '<bash-stdout>nothing to commit</bash-stdout><bash-stderr></bash-stderr>' } },
    ];
    fs.writeFileSync(file, lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
    let p = parseTranscriptTailUncached(file, null);
    assert.strictEqual(p.turnState, 'done', 'local commands do not reopen the turn');
    assert.strictEqual(p.turnStateAt, ts(1));
    assert.strictEqual(p.currentModel, 'claude-fable-5-2', '/model output is the model now in use');
    assert.strictEqual(p.detectedModel, 'claude-opus-5-5', 'costs still use the model that answered');

    const synthetic = path.join(path.dirname(file), 'synthetic.jsonl');
    fs.writeFileSync(
      synthetic,
      [lines[0], lines[1], { type: 'assistant', timestamp: ts(4), message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } }]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n'
    );
    p = parseTranscriptTailUncached(synthetic, null);
    assert.strictEqual(p.detectedModel, 'claude-opus-5-5', 'a synthetic message is not a model');
    assert.strictEqual(p.currentModel, 'claude-opus-5-5');
  }

  // 7d. Archiving a live room whose terminal is still open: it stays in history while that terminal
  //     sits idle, across a restart; it comes back only on new activity, with the real status. A new
  //     terminal in the same folder gets its own room.
  {
    const { store, dataDir } = clockedStore();
    const cwd = freshFolder('archive');
    const SID = '33333333-1111-4111-8111-000000000001';
    store.ingestConsoleScan([{ pid: 920, cwd, screen: idleScreen(BANNER('Opus 5.5 · API Usage Billing', cwd)) }]);
    const room = Array.from(store.sessions.values()).find((s) => s.pid === 920);
    store.processHookEvent({ session_id: SID, cwd, claude_pid: 920, hook_event_name: 'UserPromptSubmit', prompt: 'ทำ A' });
    store.processHookEvent({ session_id: SID, cwd, claude_pid: 920, hook_event_name: 'Stop', summary: 'ทำ A เสร็จ' });
    assert.strictEqual(room.claudeSessionId, SID);

    assert.ok(store.archiveOrRemoveSession(room.id, false));
    assert.strictEqual(room.lifecycle, 'history');
    const screen = idleScreen(BANNER('Opus 5.5 · API Usage Billing', cwd));
    store.ingestConsoleScan([{ pid: 920, cwd, screen }]);
    store.ingestConsoleScan([{ pid: 920, cwd, screen }]);
    assert.strictEqual(room.lifecycle, 'history', 'the next scans leave it in history');
    assert.strictEqual(room.status, 'closed');
    assert.strictEqual(store.sessions.size, 1, 'no new room for the same terminal');

    // "Claude is waiting for your input" is not activity.
    store.processHookEvent({ session_id: SID, cwd, claude_pid: 920, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    assert.strictEqual(room.lifecycle, 'history', 'an idle notification does not bring it back');

    // A new terminal in the same folder is a new room.
    store.ingestConsoleScan([{ pid: 920, cwd, screen }, { pid: 921, cwd, screen }]);
    const other = Array.from(store.sessions.values()).find((s) => s.pid === 921);
    assert.ok(other && other !== room && other.lifecycle === 'live', 'the new terminal has its own live room');
    assert.strictEqual(room.lifecycle, 'history');

    // Restart: still archived while the same terminal is open.
    store.flush();
    const { store: again } = clockedStore(dataDir);
    again.ingestConsoleScan([{ pid: 920, cwd, screen }, { pid: 921, cwd, screen }]);
    const reloaded = again.sessions.get(room.id);
    assert.strictEqual(reloaded.lifecycle, 'history', 'archived across a restart');
    assert.strictEqual(again.sessions.size, 2);

    // The person types in that terminal: the room is back, working.
    again.processHookEvent({ session_id: SID, cwd, claude_pid: 920, hook_event_name: 'UserPromptSubmit', prompt: 'ทำ B ต่อ' });
    assert.strictEqual(reloaded.lifecycle, 'live', 'new activity brings it back');
    assert.strictEqual(reloaded.status, 'working', 'with its real status');
    again.ingestConsoleScan([{ pid: 920, cwd, screen: busyScreen() }, { pid: 921, cwd, screen }]);
    assert.strictEqual(reloaded.lifecycle, 'live');
    assert.strictEqual(reloaded.status, 'working', 'the scan does not reset it to idle');

    // Archived again, then its terminal closes: it stays in history and lets go of the process.
    again.archiveOrRemoveSession(room.id, false);
    again.ingestConsoleScan([{ pid: 921, cwd, screen }]);
    assert.strictEqual(reloaded.lifecycle, 'history');
    assert.ok(!reloaded.pid, 'the closed terminal is released');

    // Its session resumed later in another terminal: back like any closed room.
    const sessionsDir = path.join(isolatedHome, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, '922.json'), JSON.stringify({ pid: 922, sessionId: SID, cwd, startedAt: Date.now(), kind: 'interactive', entrypoint: 'cli' }));
    require('../src/claude-sessions').clearSessionRegistryCache();
    again.ingestConsoleScan([{ pid: 921, cwd, screen }, { pid: 922, cwd, screen }]);
    const resumed = Array.from(again.sessions.values()).filter((s) => s.claudeSessionId === SID);
    assert.strictEqual(resumed.length, 1, 'one room for the session');
    assert.strictEqual(resumed[0].lifecycle, 'live', 'resumed in a new terminal: live again');
    assert.strictEqual(resumed[0].pid, 922);
    fs.rmSync(path.join(sessionsDir, '922.json'));

    // A room known only from hooks (no pid yet) archived, then its terminal is found: still archived.
    const SID2 = '33333333-1111-4111-8111-000000000002';
    const cwd2 = freshFolder('archive-hook');
    const hookRoom = again.processHookEvent({ session_id: SID2, cwd: cwd2, hook_event_name: 'SessionStart' });
    assert.ok(hookRoom && !hookRoom.pid);
    again.archiveOrRemoveSession(hookRoom.id, false);
    fs.writeFileSync(path.join(sessionsDir, '923.json'), JSON.stringify({ pid: 923, sessionId: SID2, cwd: cwd2, startedAt: Date.now(), kind: 'interactive', entrypoint: 'cli' }));
    require('../src/claude-sessions').clearSessionRegistryCache();
    again.ingestConsoleScan([{ pid: 921, cwd, screen }, { pid: 922, cwd, screen }, { pid: 923, cwd: cwd2, screen }]);
    assert.strictEqual(hookRoom.lifecycle, 'history', 'its terminal does not revive it');
    assert.strictEqual(hookRoom.pid, 923, 'the terminal is tied to it');
    assert.ok(!Array.from(again.sessions.values()).some((s) => s !== hookRoom && s.pid === 923), 'and gets no second room');
    fs.rmSync(path.join(sessionsDir, '923.json'));
    require('../src/claude-sessions').clearSessionRegistryCache();
    again.flush();
  }

  // 7e. TL;DR follows what is on screen: a closed /model picker gives the TL;DR back, and a message
  //     sent while a turn runs is queued, not the current command.
  {
    const { store } = clockedStore();
    const cwd = freshFolder('tldr');
    const bridge = new CommandBridge(store, fakeScanner());
    const banner = BANNER('Sonnet 5.5 · Claude Max', cwd);
    store.ingestConsoleScan([{ pid: 930, cwd, screen: idleScreen(banner) }]);
    const room = Array.from(store.sessions.values()).find((s) => s.pid === 930);
    const tldrBefore = room.tldr;
    store.ingestConsoleScan([{ pid: 930, cwd, screen: [...banner, modelPicker].join('\r\n') }]);
    assert.strictEqual(room.status, 'needs_input');
    assert.ok(room.tldr.includes('Select model'));
    store.ingestConsoleScan([{ pid: 930, cwd, screen: idleScreen(banner) }]);
    assert.notStrictEqual(room.status, 'needs_input', 'the picker is gone');
    assert.ok(!room.tldr.includes('Select model'), `the TL;DR no longer shows the picker: ${room.tldr}`);
    assert.strictEqual(room.tldr, tldrBefore, 'the TL;DR from before the picker is back');

    // A turn is running; a second message typed from the dashboard waits in Claude's queue.
    await bridge.dispatchCommand(room.id, 'เพิ่ม test ให้ด้วย');
    store.ingestConsoleScan([{ pid: 930, cwd, screen: busyScreen() }]);
    store.processHookEvent({ session_id: room.id, cwd, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.js' } });
    const running = { goal: room.goal, tldr: room.tldr, stage: room.stageIndex };
    const r = await bridge.dispatchCommand(room.id, 'แล้วสรุปผลให้ด้วย');
    assert.ok(r.delivered);
    assert.strictEqual(room.goal, running.goal, 'the goal is still the running turn');
    assert.strictEqual(room.tldr, running.tldr, 'the TL;DR still describes the running turn');
    assert.strictEqual(room.stageIndex, running.stage);
    assert.strictEqual(room.status, 'working');
    assert.ok(room.recentEvents.some((e) => /แล้วสรุปผลให้ด้วย/.test(e.title)), 'the queued message is noted in the timeline');
    store.flush();
  }

  // 7f. The model: unknown until known; the banner, then /model output, then the transcript.
  {
    const { store } = clockedStore();
    const cwd = freshFolder('model');
    const fresh = store.getOrCreateSession('room-model', { cwd });
    assert.ok(!fresh.model, `no invented model: ${fresh.model}`);

    store.ingestConsoleScan([{ pid: 940, cwd, screen: idleScreen(BANNER('Sonnet 5.5 · Claude Max', cwd)) }]);
    const room = Array.from(store.sessions.values()).find((s) => s.pid === 940);
    assert.strictEqual(room.model, 'claude-sonnet-5-5', 'read from the banner');

    store.ingestConsoleScan([{ pid: 940, cwd, screen: idleScreen([...BANNER('Sonnet 5.5 · Claude Max', cwd), '❯ /model haiku', '  ⎿  Set model to Haiku 5.5', '']) }]);
    assert.strictEqual(room.model, 'claude-haiku-5-5', '/model output on screen wins over the banner');

    assert.strictEqual(parseConsoleScreen(idleScreen(BANNER('Fable 5.2 · Claude Max', cwd))).model, 'claude-fable-5-2');
    assert.strictEqual(parseConsoleScreen(idleScreen(['Claude Code', '● Opus 5.5 is great at planning'])).model, null, 'only the banner says which model runs');
    store.flush();
  }

  // 7g. A new session's live output starts at the Claude Code banner, not the shell history above it.
  {
    const cwd = freshFolder('banner');
    const history = [
      'PS C:\\Users\\me> dir',
      '',
      '    Directory: C:\\Users\\me',
      '',
      'Mode                 LastWriteTime         Length Name',
      '----                 -------------         ------ ----',
      'd-----        26/11/2026     09:00                repos',
      `PS ${cwd}> claude`,
    ];
    const screen = idleScreen([...history, ...BANNER('Opus 5.5 · API Usage Billing', cwd)]);
    const parsed = parseConsoleScreen(screen);
    assert.ok(parsed.screenPreview.startsWith(' ▐▛███▜▌   Claude Code v2.1.332'), parsed.screenPreview);
    assert.ok(!parsed.screenPreview.includes('PS '), 'no shell history');

    // Once the banner has scrolled off, the preview is the screen's last lines as before.
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const scrolled = parseConsoleScreen(idleScreen(long));
    assert.ok(scrolled.screenPreview.includes('line 39') && !scrolled.screenPreview.includes('line 10\n'));

    const { store, clock } = clockedStore();
    store.ingestConsoleScan([{ pid: 950, cwd, screen }]);
    const room = Array.from(store.sessions.values()).find((s) => s.pid === 950);
    assert.ok(room.screenPreview.startsWith(' ▐▛███▜▌'), 'the room shows the banner first');
    clock.t += 2000;
    store.ingestConsoleScan([{ pid: 950, cwd, screen: idleScreen([...BANNER('Opus 5.5 · API Usage Billing', cwd), '❯ /effort high', '  ⎿  Set effort level to high']) }]);
    assert.ok(room.screenPreview.includes('Set effort level to high'), 'with no transcript yet, the preview follows the screen');
    store.flush();
  }
}

// 6. Over HTTP: automated events are acknowledged but ignored, and never held.
(async () => {
  await roomStateChecks();
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

    // Any session by id: the shared viewer for search results and automated runs.
    page = await get(`/api/transcript?sessionId=${SID_MAIN}`);
    assert.strictEqual(page.status, 200);
    assert.deepStrictEqual(page.json.lines, ['🧑 คุณ: hi']);
    assert.strictEqual(page.json.meta.entrypoint, 'cli');
    assert.strictEqual(page.json.meta.cwd, repo);
    page = await get(`/api/transcript?sessionId=${SID_MAIN}&after=0`);
    assert.deepStrictEqual(page.json.lines, ['🧑 คุณ: hi'], 'forward from the start');
    assert.strictEqual(page.json.done, true);
    page = await get(`/api/transcript?sessionId=${SID_MAIN}&at=0`);
    assert.deepStrictEqual(page.json.lines, ['🧑 คุณ: hi'], 'ending at one entry');
    page = await get(`/api/transcript?sessionId=..%2F..%2Fetc`);
    assert.strictEqual(page.status, 400, 'only a session id');
    page = await get(`/api/transcript?sessionId=99999999-9999-4999-8999-999999999999`);
    assert.strictEqual(page.status, 404);
    page = await get(`/api/transcript?sessionId=${SID_MAIN}&limit=0`);
    assert.strictEqual(page.status, 400);
  } finally {
    server.close();
    store.flush();
  }
  console.log('✅ Room matching checks passed!');
})().catch((err) => {
  console.error('❌ Room matching checks failed:', err);
  process.exit(1);
});
