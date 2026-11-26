/**
 * The `amc` command line, run as a real process against a temporary home directory:
 * hook and statusline install/uninstall, and hooks being removed when the process exits.
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

function testStatuslineCommandsRun() {
  resetHome();
  let res = amc(['install-statusline']);
  assert.strictEqual(res.code, 0, res.stderr);
  assert.ok(
    readSettings().statusLine.command.includes('hooks/statusline.js'),
    'the statusline bridge is configured'
  );

  res = amc(['uninstall-statusline']);
  assert.strictEqual(res.code, 0, res.stderr);
  assert.strictEqual('statusLine' in readSettings(), false, 'and removed again');
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
  testStatuslineCommandsRun();
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
