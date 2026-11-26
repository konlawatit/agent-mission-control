/**
 * Hook installer: HTTP hook entries (no process per event), migration from the older command
 * hooks, and never damaging ~/.claude/settings.json.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate from the developer's real ~/.claude and ~/.agent-mission-control.
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-hooks-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

const {
  installClaudeHooks,
  uninstallClaudeHooks,
  checkHooksStatus,
} = require('../src/hook-installer');

const claudeDir = path.join(isolatedHome, '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');
const TOKEN = 'a'.repeat(48);
// settings.json gets a token that only opens the hook endpoint, never the API token itself.
const hookTokenOf = (apiToken) =>
  crypto.createHmac('sha256', apiToken).update('amc-hook-endpoint-v1').digest('hex').slice(0, 48);
const HOOK_TOKEN = hookTokenOf(TOKEN);

const ALL_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Notification',
  'SubagentStop',
  'Stop',
  'SessionEnd',
];
const HTTP_EVENTS = ALL_EVENTS.filter((e) => e !== 'SessionStart');
const MATCHER_EVENTS = ['PreToolUse', 'PostToolUse', 'PermissionRequest'];

const httpHook = (port, token) => ({
  type: 'http',
  url: `http://127.0.0.1:${port}/api/hook/claude`,
  timeout: 5,
  headers: {
    'X-AMC-Token': token,
    'X-AMC-WT-Session': '$WT_SESSION',
    'X-AMC-Pane': '$WEZTERM_PANE',
    'X-AMC-Tmux-Pane': '$TMUX_PANE',
  },
  allowedEnvVars: ['WT_SESSION', 'WEZTERM_PANE', 'TMUX_PANE'],
});

const legacyEntry = (evt) => ({
  ...(MATCHER_EVENTS.includes(evt) ? { matcher: '*' } : {}),
  hooks: [
    {
      type: 'command',
      command: `node "C:/tools/agent-mission-control/hooks/claude-hook.js" ${evt}`,
    },
  ],
});

const FOREIGN_ENTRY = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };

function reset() {
  fs.rmSync(claudeDir, { recursive: true, force: true });
}

function writeRaw(text) {
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsPath, text, 'utf8');
}

function readSettings() {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

/** An entry Mission Control wrote, of either kind. */
function isAmcEntry(entry) {
  return (entry.hooks || []).some(
    (h) =>
      (typeof h.command === 'string' && h.command.includes('claude-hook.js')) ||
      (h.type === 'http' && String(h.url).endsWith('/api/hook/claude'))
  );
}

function testFreshInstall() {
  reset();
  const result = installClaudeHooks({ port: 4999, token: TOKEN });
  const settings = readSettings();

  assert.strictEqual(settings.hooks.SessionStart.length, 1);
  const start = settings.hooks.SessionStart[0];
  assert.strictEqual(start.matcher, undefined);
  assert.strictEqual(start.hooks.length, 1);
  assert.strictEqual(start.hooks[0].type, 'command', 'SessionStart cannot be an HTTP hook');
  assert.ok(
    /claude-hook\.js" SessionStart$/.test(start.hooks[0].command),
    `SessionStart still runs the hook script, got: ${start.hooks[0].command}`
  );

  for (const evt of HTTP_EVENTS) {
    assert.strictEqual(settings.hooks[evt].length, 1, `${evt} has one entry`);
    const entry = settings.hooks[evt][0];
    assert.deepStrictEqual(entry.hooks, [httpHook(4999, HOOK_TOKEN)], `${evt} posts over HTTP`);
    assert.strictEqual(
      entry.matcher,
      MATCHER_EVENTS.includes(evt) ? '*' : undefined,
      `${evt} matcher`
    );
  }

  assert.strictEqual(result.installed, true);
  assert.deepStrictEqual(result.installedEvents, ALL_EVENTS);
  assert.strictEqual(result.error, undefined);
  assert.ok(
    !fs.readFileSync(settingsPath, 'utf8').includes(TOKEN),
    'the API token (which can type into terminals) is not copied into settings.json'
  );
}

function testDefaultTokenComesFromTokenFile() {
  reset();
  installClaudeHooks({ port: 4999 });
  const token = fs
    .readFileSync(path.join(isolatedHome, '.agent-mission-control', 'token'), 'utf8')
    .trim();
  assert.ok(/^[a-f0-9]{48}$/.test(token), 'a token file was created');
  assert.strictEqual(
    readSettings().hooks.Stop[0].hooks[0].headers['X-AMC-Token'],
    hookTokenOf(token)
  );
  assert.ok(!fs.readFileSync(settingsPath, 'utf8').includes(token));
}

function testKeepsForeignHookInsideOurEntry() {
  // Someone grouped their own hook under the same entry as ours.
  reset();
  installClaudeHooks({ port: 4310, token: TOKEN });
  const mine = { type: 'command', command: 'echo mine' };
  const edited = readSettings();
  edited.hooks.PreToolUse[0].hooks.push(mine);
  writeRaw(JSON.stringify(edited, null, 2));

  installClaudeHooks({ port: 4310, token: TOKEN });
  const reinstalled = readSettings().hooks.PreToolUse;
  assert.strictEqual(
    reinstalled.flatMap((e) => e.hooks).filter((h) => h.command === 'echo mine').length,
    1,
    'their hook survives a reinstall'
  );
  assert.strictEqual(
    reinstalled.flatMap((e) => e.hooks).filter((h) => h.type === 'http').length,
    1,
    'and ours is not duplicated'
  );

  uninstallClaudeHooks();
  assert.deepStrictEqual(readSettings().hooks, { PreToolUse: [{ matcher: '*', hooks: [mine] }] });
}

function testUninstallScopedToPort() {
  // Two servers on different ports: stopping one must not remove the other's hooks.
  reset();
  installClaudeHooks({ port: 4310, token: TOKEN });
  const before = readSettings();

  const other = uninstallClaudeHooks({ port: 4311 });
  assert.strictEqual(other.uninstalled, true);
  assert.deepStrictEqual(readSettings(), before, 'another instance stopping changes nothing');

  uninstallClaudeHooks({ port: 4310 });
  assert.deepStrictEqual(readSettings().hooks, {}, 'the owner stopping removes everything it wrote');
}

function testStatusIsPortAware() {
  reset();
  installClaudeHooks({ port: 4310, token: TOKEN });
  assert.strictEqual(checkHooksStatus({ port: 4310 }).installed, true);
  assert.strictEqual(
    checkHooksStatus({ port: 4311 }).installed,
    false,
    'hooks that post to another server are not "connected" for this one'
  );
  assert.strictEqual(checkHooksStatus().installed, true, 'without a port: any Mission Control hooks');
}

function testMigratesLegacyAndKeepsForeign() {
  reset();
  const before = {
    model: 'opus',
    permissions: { allow: ['Read'] },
    hooks: {},
  };
  for (const evt of ALL_EVENTS) before.hooks[evt] = [legacyEntry(evt)];
  before.hooks.PreToolUse.unshift(FOREIGN_ENTRY);
  writeRaw(JSON.stringify(before, null, 2));

  installClaudeHooks({ port: 4310, token: TOKEN });
  const after = readSettings();

  assert.strictEqual(after.model, 'opus');
  assert.deepStrictEqual(after.permissions, { allow: ['Read'] });
  for (const evt of HTTP_EVENTS) {
    const commands = after.hooks[evt].flatMap((e) => e.hooks.map((h) => h.command || ''));
    assert.ok(
      !commands.some((c) => c.includes('claude-hook.js')),
      `${evt}: the command hook is replaced, not kept beside the HTTP one`
    );
  }
  for (const evt of ALL_EVENTS) {
    assert.strictEqual(after.hooks[evt].filter(isAmcEntry).length, 1, `${evt}: one AMC entry`);
  }
  assert.deepStrictEqual(
    after.hooks.PreToolUse.filter((e) => !isAmcEntry(e)),
    [FOREIGN_ENTRY],
    "someone else's hook on the same event survives"
  );

  installClaudeHooks({ port: 4310, token: TOKEN });
  assert.deepStrictEqual(readSettings(), after, 'installing twice changes nothing');
}

function testUninstallRemovesBothKinds() {
  reset();
  // A mix: HTTP entries from this version plus a leftover command entry from an older one.
  installClaudeHooks({ port: 4310, token: TOKEN });
  const mixed = readSettings();
  mixed.hooks.PreToolUse.push(FOREIGN_ENTRY);
  mixed.hooks.Stop.push(legacyEntry('Stop'));
  writeRaw(JSON.stringify(mixed, null, 2));

  const result = uninstallClaudeHooks();

  assert.strictEqual(result.uninstalled, true);
  assert.deepStrictEqual(readSettings().hooks, { PreToolUse: [FOREIGN_ENTRY] });
  assert.strictEqual(checkHooksStatus().installed, false);
  assert.deepStrictEqual(checkHooksStatus().installedEvents, []);
}

function testUnparsableSettingsUntouched() {
  reset();
  const broken = '{ "model": "opus", ';
  writeRaw(broken);

  const installed = installClaudeHooks({ port: 4310, token: TOKEN });
  assert.strictEqual(installed.installed, false);
  assert.ok(typeof installed.error === 'string' && installed.error.length > 0, 'install says why');
  assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), broken, 'install left the file alone');

  const removed = uninstallClaudeHooks();
  assert.strictEqual(removed.uninstalled, false);
  assert.ok(typeof removed.error === 'string' && removed.error.length > 0, 'uninstall says why');
  assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), broken, 'uninstall left the file alone');

  assert.deepStrictEqual(fs.readdirSync(claudeDir), ['settings.json'], 'no backup or temp file');
}

function testInvalidPortFallsBack() {
  reset();
  installClaudeHooks({ port: NaN, token: TOKEN });
  assert.strictEqual(
    readSettings().hooks.PreToolUse[0].hooks[0].url,
    'http://127.0.0.1:4310/api/hook/claude'
  );
}

function run() {
  try {
    testFreshInstall();
    testDefaultTokenComesFromTokenFile();
    testMigratesLegacyAndKeepsForeign();
    testUninstallRemovesBothKinds();
    testUnparsableSettingsUntouched();
    testInvalidPortFallsBack();
    testKeepsForeignHookInsideOurEntry();
    testUninstallScopedToPort();
    testStatusIsPortAware();
    console.log('✅ Hook installer checks passed!');
  } finally {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

try {
  run();
} catch (err) {
  console.error('❌ Hook installer checks failed:', err);
  process.exit(1);
}
