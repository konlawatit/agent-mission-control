const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { StateStore } = require('../src/state-store');
const { inferWorkflowFromTool } = require('../src/transcript-parser');
const { parseConsoleScreen } = require('../src/console-scanner');

async function runTests() {
  console.log('🧪 Running Agent Mission Control Verification Suite...');

  // 0. Test Interactive TUI Choice Parser (`parseConsoleScreen`)
  const sampleScreen = [
    ' ▐▛███▛█   Claude Code v2.1.332',
    '▝▜██████▀  Opus 5.5 · API Usage Billing',
    ' ▝▝   ▝▝   C:\\Job\\Application Developer Test\\queue-ticket-system',
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
  assert.strictEqual(
    parsedScreen.cwd,
    'C:\\Job\\Application Developer Test\\queue-ticket-system'
  );
  assert.ok(parsedScreen.interactivePrompt, 'Should detect interactive choice prompt');
  assert.strictEqual(
    parsedScreen.interactivePrompt.question,
    'Try the new fullscreen renderer?'
  );
  assert.strictEqual(parsedScreen.interactivePrompt.options.length, 2);
  assert.strictEqual(parsedScreen.interactivePrompt.options[0].label, 'Yes, try it');
  assert.strictEqual(parsedScreen.interactivePrompt.options[0].active, true);
  assert.strictEqual(parsedScreen.interactivePrompt.options[1].label, 'Not now');

  const tempDir = path.join(os.tmpdir(), `amc-test-${Date.now()}`);
  const store = new StateStore({ dataDir: tempDir });

  // 1. Test Console Scan Ingestion into StateStore
  store.ingestConsoleScan([
    {
      pid: 99999,
      title: 'Claude Code',
      screen: sampleScreen,
    },
  ]);

  let snap = store.getSnapshot();
  assert.strictEqual(snap.sessions.length, 1);
  assert.strictEqual(snap.sessions[0].status, 'needs_input');
  assert.ok(snap.sessions[0].interactivePrompt);
  assert.strictEqual(snap.sessions[0].interactivePrompt.options.length, 2);

  // 2. Test Sub-Agent Spawning via PreToolUse (Task)
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
  assert.strictEqual(snap.sessions[0].subAgents[0].state, 'working');
  assert.strictEqual(snap.metrics.activeSubAgents, 1);

  // 3. Test Code Stage Transition (Edit) and Verify Stage Transition (Bash test)
  const editInference = inferWorkflowFromTool('Edit', { file_path: 'src/auth.ts' });
  assert.strictEqual(editInference.stageIndex, 1);

  const testInference = inferWorkflowFromTool('Bash', { command: 'npm run test:unit' });
  assert.strictEqual(testInference.stageIndex, 2);

  // 4. Test Stop Event (Completion)
  store.processHookEvent({
    session_id: snap.sessions[0].id,
    hook_event_name: 'Stop',
    summary: 'All OAuth2 tests passed and sub-agents completed.',
  });
  snap = store.getSnapshot();
  assert.strictEqual(snap.sessions[0].status, 'done');
  assert.strictEqual(snap.sessions[0].stageIndex, 3);
  assert.strictEqual(snap.metrics.activeSubAgents, 0);

  // Cleanup temp test dir
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ All verification assertions (Console TUI Parser + StateStore + Sub-Agents) passed!');
}

runTests().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
