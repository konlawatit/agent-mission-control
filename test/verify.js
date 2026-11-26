const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Isolate from the developer's real ~/.claude transcripts: rooms here use this repo as their cwd,
// and real sessions in it (sub-agents, turns) would otherwise leak into the assertions.
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-home-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
const { StateStore } = require('../src/state-store');
const { inferWorkflowFromTool } = require('../src/transcript-parser');
const { parseConsoleScreen } = require('../src/console-scanner');

async function runTests() {
  console.log('🧪 Running Agent Mission Control Verification Suite...');

  // 0. Test Interactive TUI Choice Parser (`parseConsoleScreen`)
  const sampleCwd = process.cwd();
  const sampleFolder = path.basename(sampleCwd);
  const sampleParent = path.basename(path.dirname(sampleCwd));
  const sampleScreen = [
    ' ▐▛███▛█   Claude Code v2.1.332',
    '▝▜██████▀  Opus 5.5 · API Usage Billing',
    ` ▝▝   ▝▝   ${sampleCwd}`,
    '────────────────────────────────────────────────────────',
    '  Try the new fullscreen renderer?',
    '',
    '  · Flicker-free output',
    '  · Mouse support: click to move your cursor or expand results',
    '',
    '  ❯ 1. Yes, try it',
    '    2. Not now',
    '',
    '  Enter to confirm · Esc to cancel',
  ].join('\r\n');

  const parsedScreen = parseConsoleScreen(sampleScreen);
  assert.ok(parsedScreen, 'Should parse console screen buffer');
  assert.strictEqual(parsedScreen.version, 'v2.1.332');
  assert.strictEqual(parsedScreen.cwd, sampleCwd);
  assert.ok(parsedScreen.interactivePrompt, 'Should detect interactive choice prompt');
  assert.strictEqual(
    parsedScreen.interactivePrompt.question,
    'Try the new fullscreen renderer?'
  );
  assert.strictEqual(parsedScreen.interactivePrompt.options.length, 2);

  const tempDir = path.join(os.tmpdir(), `amc-test-${Date.now()}`);
  const store = new StateStore({ dataDir: tempDir });

  // 1. Ensure zero demo rooms on startup
  assert.strictEqual(store.getSnapshot().sessions.length, 0);

  // 2. Test Console Scan Ingestion & Automatic Project/Category Categorization
  store.ingestConsoleScan([
    {
      pid: 99999,
      cwd: sampleCwd,
      title: 'Claude Code',
      screen: sampleScreen,
    },
  ]);

  let snap = store.getSnapshot();
  assert.strictEqual(snap.sessions.length, 1);
  assert.strictEqual(snap.sessions[0].lifecycle, 'live');
  assert.strictEqual(snap.sessions[0].project, sampleFolder);
  assert.strictEqual(snap.sessions[0].category, sampleParent);
  assert.strictEqual(snap.sessions[0].status, 'needs_input');
  assert.strictEqual(snap.metrics.liveRooms, 1);
  assert.strictEqual(snap.metrics.historyRooms, 0);

  // 3. Test Accidental Tab Close Detection -> Automatically transitions to 'history'
  store.ingestConsoleScan([]); // PID 99999 disappeared (tab closed)
  snap = store.getSnapshot();
  assert.strictEqual(snap.sessions.length, 1, 'Session must be remembered in history');
  assert.strictEqual(snap.sessions[0].lifecycle, 'history');
  assert.strictEqual(snap.sessions[0].status, 'closed');
  assert.strictEqual(snap.metrics.liveRooms, 0);
  assert.strictEqual(snap.metrics.historyRooms, 1);

  // 4. A new terminal in the same folder is a new room; the closed session stays readable in history.
  store.ingestConsoleScan([
    {
      pid: 88888,
      cwd: sampleCwd,
      title: 'Claude Code',
      screen: sampleScreen,
    },
  ]);
  snap = store.getSnapshot();
  assert.strictEqual(snap.sessions.length, 2, 'one room per session, not per folder');
  const reopened = snap.sessions.find((s) => s.lifecycle === 'live');
  assert.ok(reopened, 'the new terminal is live');
  assert.strictEqual(reopened.pid, 88888);
  assert.strictEqual(snap.metrics.historyRooms, 1, 'the closed session stays in history');

  // 5. Hooks join the terminal they come from; a second session in the same folder gets its own
  //    room (including a dirty PowerShell `> claude` path), and the scanner's next terminal claims it.
  const SID_A = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const SID_B = '99999999-e5f6-7890-abcd-ef1234567890';
  store.processHookEvent({
    session_id: SID_A,
    cwd: sampleCwd,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'สรุปโปรเจกต์นี้ให้หน่อย',
  });
  store.processHookEvent({
    session_id: SID_A,
    cwd: sampleCwd,
    hook_event_name: 'Stop',
    summary: 'สรุปโครงสร้างระบบเรียบร้อย',
  });
  const roomA = store.sessions.get(reopened.id);
  assert.strictEqual(roomA.claudeSessionId, SID_A, 'the session claimed the open terminal\'s room');
  assert.ok(roomA.taskHistory.length >= 1, 'completed turns are kept in the room history');

  store.processHookEvent({
    session_id: SID_B,
    cwd: `${sampleCwd}> claude`,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'ดูโปรเจกต์นี้หน่อย และคิดว่ามีจุดไหนที่ทำให้ดีกว่านี้ได้ไหม',
  });
  store.ingestConsoleScan([
    { pid: 88888, cwd: sampleCwd, title: 'Claude Code', screen: sampleScreen },
    { pid: 27120, cwd: sampleCwd, title: 'Claude Code', screen: sampleScreen },
  ]);

  snap = store.getSnapshot();
  const live = snap.sessions.filter((s) => s.lifecycle === 'live');
  assert.strictEqual(live.length, 2, 'two sessions in one folder are two rooms');
  const roomB = live.find((s) => s.claudeSessionId === SID_B);
  assert.ok(roomB, 'session B has its own room');
  assert.strictEqual(roomB.pid, 27120, 'the new terminal claimed session B\'s room instead of making a third');
  assert.strictEqual(roomB.cwd, sampleCwd, 'the "> claude" suffix is cleaned off');
  assert.strictEqual(roomB.goal, 'ดูโปรเจกต์นี้หน่อย และคิดว่ามีจุดไหนที่ทำให้ดีกว่านี้ได้ไหม');
  assert.strictEqual(store.sessions.get(reopened.id).goal, 'สรุปโปรเจกต์นี้ให้หน่อย', 'room A keeps its own conversation');

  // 6. Test Sub-Agent Spawning & Workflow Stages
  store.processHookEvent({
    session_id: roomB.id,
    hook_event_name: 'PreToolUse',
    tool_name: 'Task',
    tool_use_id: 'sub-task-1',
    tool_input: {
      description: 'Security Reviewer',
      subagent_type: 'security',
      prompt: 'Audit JWT token verification logic',
    },
  });

  snap = store.getSnapshot();
  assert.strictEqual(snap.sessions.find((s) => s.id === roomB.id).subAgents.length, 1);
  assert.strictEqual(snap.metrics.activeSubAgents, 1);

  const editInference = inferWorkflowFromTool('Edit', { file_path: 'src/auth.ts' });
  assert.strictEqual(editInference.stageIndex, 1);

  const testInference = inferWorkflowFromTool('Bash', { command: 'npm run test:unit' });
  assert.strictEqual(testInference.stageIndex, 2);

  // The dashboard's stylesheet must close every block: one missing `}` (easy to lose when a merge
  // joins two @media blocks) silently moves every later rule inside that media query.
  const assertBracesClose = (label, cssText) => {
    const css = cssText
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
    let depth = 0;
    css.split('\n').forEach((text, i) => {
      for (const ch of text) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        assert.ok(depth >= 0, `${label}: unmatched "}" on style line ${i + 1}`);
      }
    });
    assert.strictEqual(depth, 0, `${label}: a block is never closed`);
  };
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assertBracesClose('index.html <style>', html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>')));
  // The guild page (game world) keeps its styles in their own file.
  const guildCss = path.join(__dirname, '..', 'public', 'guild.css');
  if (fs.existsSync(guildCss)) assertBracesClose('guild.css', fs.readFileSync(guildCss, 'utf8'));

  // Cleanup temp test dir
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ All verification assertions (No Demo + Session Memory/History + Project Categorization) passed!');
}

runTests().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
