const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { StateStore } = require('../src/state-store');
const { inferWorkflowFromTool } = require('../src/transcript-parser');

async function runTests() {
  console.log('🧪 Running Agent Mission Control Verification Suite...');

  const tempDir = path.join(os.tmpdir(), `amc-test-${Date.now()}`);
  const store = new StateStore({ dataDir: tempDir });

  // 1. Test SessionStart & UserPromptSubmit
  store.processHookEvent({
    session_id: 'test-sess-1',
    room: 'Room Test • Auth',
    cwd: process.cwd(),
    hook_event_name: 'SessionStart',
  });

  store.processHookEvent({
    session_id: 'test-sess-1',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Refactor OAuth2 middleware and spawn sub-agents for tests',
  });

  let snap = store.getSnapshot();
  assert.strictEqual(snap.sessions.length, 1);
  assert.strictEqual(snap.sessions[0].status, 'working');
  assert.strictEqual(snap.sessions[0].stageIndex, 0);

  // 2. Test Sub-Agent Spawning via PreToolUse (Task)
  store.processHookEvent({
    session_id: 'test-sess-1',
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

  store.processHookEvent({
    session_id: 'test-sess-1',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  });
  snap = store.getSnapshot();
  assert.strictEqual(snap.sessions[0].stageIndex, 2);

  // 4. Test Attention Queue Alert (Notification)
  store.processHookEvent({
    session_id: 'test-sess-1',
    hook_event_name: 'Notification',
    message: 'Allow Bash command: npm run test:integration?',
  });
  snap = store.getSnapshot();
  assert.strictEqual(snap.sessions[0].status, 'needs_input');
  assert.strictEqual(snap.metrics.needsInput, 1);

  // 5. Test Stop Event (Completion)
  store.processHookEvent({
    session_id: 'test-sess-1',
    hook_event_name: 'Stop',
    summary: 'All OAuth2 tests passed and sub-agents completed.',
  });
  snap = store.getSnapshot();
  assert.strictEqual(snap.sessions[0].status, 'done');
  assert.strictEqual(snap.sessions[0].stageIndex, 3);
  assert.strictEqual(snap.metrics.activeSubAgents, 0);

  // 6. Test HTTP Server & API Endpoints (/api/state, /api/hook, /api/session/command)
  const { createMissionControlServer } = require('../src/server');
  const { server } = createMissionControlServer({ store });
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      try {
        const port = server.address().port;
        const stateRes = await fetch(`http://127.0.0.1:${port}/api/state`);
        const stateJson = await stateRes.json();
        assert.strictEqual(stateJson.ok, true);
        assert.strictEqual(stateJson.metrics.totalRooms, 1);

        const cmdRes = await fetch(`http://127.0.0.1:${port}/api/session/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: 'test-sess-1',
            command: 'Run final lint check',
          }),
        });
        const cmdJson = await cmdRes.json();
        assert.strictEqual(cmdJson.ok, true);

        server.close(() => resolve());
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });

  // Cleanup temp test dir
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ All verification assertions (StateStore + Hooks + HTTP API) passed!');
}

runTests().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
