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

  // 4. Test Reopening / Reviving Session in the same folder
  store.ingestConsoleScan([
    {
      pid: 88888,
      cwd: sampleCwd,
      title: 'Claude Code',
      screen: sampleScreen,
    },
  ]);
  snap = store.getSnapshot();
  assert.strictEqual(snap.sessions.length, 1, 'Should revive existing session instead of duplicating');
  assert.strictEqual(snap.sessions[0].lifecycle, 'live');
  assert.strictEqual(snap.sessions[0].pid, 88888);
  assert.strictEqual(snap.sessions[0].openCount, 2);

  // 5. Test Hook Event + ConsoleScanner Deduplication (including dirty PowerShell prompt `> claude` and new UUID turns!)
  store.processHookEvent({
    session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    cwd: sampleCwd,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'สรุปโปรเจกต์นี้ให้หน่อย',
  });

  store.processHookEvent({
    session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    cwd: sampleCwd,
    hook_event_name: 'Stop',
    summary: 'สรุปโครงสร้างระบบเรียบร้อย',
  });

  // Now simulate a SECOND conversation / new UUID in the same folder + dirty `> claude` path from console!
  store.processHookEvent({
    session_id: '99999999-e5f6-7890-abcd-ef1234567890',
    cwd: `${sampleCwd}> claude`,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'ดูโปรเจกต์นี้หน่อย และคิดว่ามีจุดไหนที่ทำให้ดีกว่านี้ได้ไหม',
  });

  store.ingestConsoleScan([
    {
      pid: 27120,
      cwd: sampleCwd,
      title: 'Claude Code',
      screen: sampleScreen,
    },
  ]);

  snap = store.getSnapshot();
  assert.strictEqual(
    snap.sessions.length,
    1,
    'Multiple turns, new UUIDs, or dirty "> claude" paths for the same folder MUST stay in 1 single room!'
  );
  assert.strictEqual(
    snap.sessions[0].goal,
    'ดูโปรเจกต์นี้หน่อย และคิดว่ามีจุดไหนที่ทำให้ดีกว่านี้ได้ไหม',
    'Main room card must display the latest active interaction!'
  );
  assert.ok(
    snap.sessions[0].taskHistory.length >= 1,
    'Previous completed turns must be stored inside the room taskHistory!'
  );

  // 6. Test Sub-Agent Spawning & Workflow Stages
  store.processHookEvent({
    session_id: snap.sessions[0].id,
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
  assert.strictEqual(snap.sessions[0].subAgents.length, 1);
  assert.strictEqual(snap.metrics.activeSubAgents, 1);

  const editInference = inferWorkflowFromTool('Edit', { file_path: 'src/auth.ts' });
  assert.strictEqual(editInference.stageIndex, 1);

  const testInference = inferWorkflowFromTool('Bash', { command: 'npm run test:unit' });
  assert.strictEqual(testInference.stageIndex, 2);

  // Cleanup temp test dir
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ All verification assertions (No Demo + Session Memory/History + Project Categorization) passed!');
}

runTests().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
