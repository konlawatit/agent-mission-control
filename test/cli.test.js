/**
 * The `amc` command line, run as a real process against a temporary home directory:
 * hook install/uninstall, removing the old statusline usage bridge, and hooks being removed when
 * the process exits.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-cli-'));
const repoRoot = path.join(__dirname, '..');
const settingsPath = path.join(home, '.claude', 'settings.json');

function childEnv(extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  if (!('AMC_PORT' in extra)) delete env.AMC_PORT;
  return env;
}

function runNode(args, extraEnv) {
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: repoRoot,
      env: childEnv(extraEnv),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  }
}

const amc = (args, extraEnv) => runNode([path.join('bin', 'amc.js'), ...args], extraEnv);

function readSettings() {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

function resetHome() {
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
}

/**
 * The statusline usage bridge is gone (usage is checked on request now). Installing it is
 * refused without starting a server; an install left by an earlier version is removed cleanly,
 * putting back the statusline that was there before.
 */
function testLegacyStatuslineCleanup() {
  resetHome();
  const previousFile = path.join(home, '.agent-mission-control', 'statusline-previous.json');
  const ours = { type: 'command', command: 'node "C:/old/agent-mission-control/hooks/statusline.js"' };
  const theirs = { type: 'command', command: 'echo my-own-line', padding: 1 };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.mkdirSync(path.dirname(previousFile), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: ours, model: 'opus' }), 'utf8');
  fs.writeFileSync(previousFile, JSON.stringify(theirs), 'utf8');

  // A port of its own, so that even a fall-through to `start` could never meet a running dashboard.
  let res = amc(['install-statusline'], { AMC_PORT: '4998' });
  assert.strictEqual(res.code, 1, 'the removed command reports failure');
  assert.ok(res.stdout.includes('เช็คตอนนี้'), `it points at the usage check: ${res.stdout}`);
  assert.deepStrictEqual(readSettings().statusLine, ours, 'and changes nothing');

  res = amc(['uninstall-statusline']);
  assert.strictEqual(res.code, 0, res.stderr);
  assert.deepStrictEqual(readSettings().statusLine, theirs, 'the earlier statusline is back');
  assert.strictEqual(readSettings().model, 'opus', 'other settings are kept');
  assert.strictEqual(fs.existsSync(previousFile), false);

  // Without a saved earlier statusline, ours is simply removed; a second run is a no-op.
  fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: ours }), 'utf8');
  res = amc(['uninstall-statusline']);
  assert.strictEqual(res.code, 0, res.stderr);
  assert.strictEqual('statusLine' in readSettings(), false);
  res = amc(['uninstall-statusline']);
  assert.strictEqual(res.code, 0, res.stderr);

  // A statusline that is not ours is never touched.
  fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: theirs }), 'utf8');
  res = amc(['uninstall-statusline']);
  assert.deepStrictEqual(readSettings().statusLine, theirs);
}

function testInstallHooksUsesConfiguredPort() {
  resetHome();
  const res = amc(['install-hooks'], { AMC_PORT: '4777' });
  assert.strictEqual(res.code, 0, res.stderr);
  assert.strictEqual(
    readSettings().hooks.PreToolUse[0].hooks[0].url,
    'http://127.0.0.1:4777/api/hook/claude'
  );

  const removed = amc(['uninstall-hooks']);
  assert.strictEqual(removed.code, 0, removed.stderr);
  assert.deepStrictEqual(readSettings().hooks, {});
}

function testBrokenSettingsAreRefused() {
  resetHome();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const broken = '{ broken';
  fs.writeFileSync(settingsPath, broken, 'utf8');

  for (const command of ['install-hooks', 'uninstall-hooks']) {
    const res = amc([command]);
    assert.strictEqual(res.code, 1, `${command} reports failure through its exit code`);
    assert.ok(res.stdout.includes('❌'), `${command} says so: ${res.stdout}`);
    assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), broken, `${command} left the file alone`);
  }
}

function testProcessExitRemovesHooks() {
  resetHome();
  // A real process: hooks are there while it runs and gone once it has exited.
  const script = `
    const { attachManagedHooks } = require('./src/hook-lifecycle');
    const installer = require('./src/hook-installer');
    attachManagedHooks({
      proc: process,
      install: () => installer.installClaudeHooks({ port: 4555, token: 'd'.repeat(48) }),
      uninstall: installer.uninstallClaudeHooks,
      onSignal() {},
    });
    const text = require('fs').readFileSync(installer.getClaudeSettingsPath(), 'utf8');
    process.stdout.write(text.includes('127.0.0.1:4555/api/hook/claude') ? 'INSTALLED' : 'MISSING');
    process.exit(0);
  `;
  const res = runNode(['-e', script]);
  assert.strictEqual(res.code, 0, res.stderr);
  assert.strictEqual(res.stdout, 'INSTALLED', 'hooks were present while the process ran');
  assert.deepStrictEqual(readSettings().hooks, {}, 'and removed when it exited');
}

try {
  testLegacyStatuslineCleanup();
  testInstallHooksUsesConfiguredPort();
  testBrokenSettingsAreRefused();
  testProcessExitRemovesHooks();
  console.log('✅ CLI checks passed!');
} catch (err) {
  console.error('❌ CLI checks failed:', err);
  process.exitCode = 1;
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
