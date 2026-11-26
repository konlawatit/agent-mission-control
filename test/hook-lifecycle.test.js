/**
 * Managed hooks: the server installs its hooks while it runs and removes them when it stops, so
 * a Claude Code session never posts to a server that is not there.
 */
const assert = require('assert');
const { EventEmitter } = require('events');
const { attachManagedHooks } = require('../src/hook-lifecycle');

function harness({ install, uninstall } = {}) {
  const proc = new EventEmitter();
  const calls = { install: 0, uninstall: 0, signals: [], failures: [] };
  const managed = attachManagedHooks({
    proc,
    install: () => {
      calls.install += 1;
      return install ? install() : { installed: true, installedEvents: ['Stop'] };
    },
    uninstall: () => {
      calls.uninstall += 1;
      return uninstall ? uninstall() : { uninstalled: true };
    },
    onSignal: (signal) => calls.signals.push(signal),
    onUninstallFailed: (message) => calls.failures.push(message),
  });
  return { proc, calls, managed };
}

function testLeftoverHooksAreReported() {
  // Hooks that outlive the server make Claude Code warn on every tool call: say so, loudly.
  const refused = harness({
    uninstall: () => ({ uninstalled: false, error: 'settings.json อ่านไม่ได้' }),
  });
  refused.proc.emit('SIGINT');
  assert.deepStrictEqual(refused.calls.failures, ['settings.json อ่านไม่ได้']);

  const threw = harness({
    uninstall: () => {
      throw new Error('EPERM: locked');
    },
  });
  threw.proc.emit('exit', 0);
  assert.deepStrictEqual(threw.calls.failures, ['EPERM: locked']);

  const fine = harness();
  fine.proc.emit('SIGINT');
  assert.deepStrictEqual(fine.calls.failures, [], 'a clean removal says nothing');
}

function testInstallsOnceAndReportsResult() {
  const { calls, managed } = harness();
  assert.strictEqual(calls.install, 1);
  assert.deepStrictEqual(managed.result, { installed: true, installedEvents: ['Stop'] });
  assert.strictEqual(calls.uninstall, 0, 'nothing is removed while the server runs');
}

function testEveryStopSignalRemovesHooks() {
  // Ctrl+C, service stop, closing the terminal window, Ctrl+Break.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    const { proc, calls } = harness();
    proc.emit(signal);
    assert.strictEqual(calls.uninstall, 1, `${signal} removes the hooks`);
    assert.deepStrictEqual(calls.signals, [signal], `${signal} is passed on so the server can exit`);
  }
}

function testRemovesOnlyOnce() {
  const { proc, calls, managed } = harness();
  proc.emit('SIGINT');
  proc.emit('SIGINT');
  proc.emit('exit', 0);
  managed.release();
  assert.strictEqual(calls.uninstall, 1);
  assert.deepStrictEqual(calls.signals, ['SIGINT', 'SIGINT']);
}

function testExitWithoutSignal() {
  const { proc, calls } = harness();
  proc.emit('exit', 1);
  assert.strictEqual(calls.uninstall, 1, 'a crash that still exits cleanly removes the hooks');
  assert.deepStrictEqual(calls.signals, []);
}

function testUninstallFailureDoesNotBlockShutdown() {
  const { proc, calls } = harness({
    uninstall: () => {
      throw new Error('settings.json is locked');
    },
  });
  assert.doesNotThrow(() => proc.emit('SIGTERM'));
  assert.deepStrictEqual(calls.signals, ['SIGTERM'], 'the server still gets to shut down');
}

function testInstallFailureIsReported() {
  const { managed } = harness({
    install: () => {
      throw new Error('boom');
    },
  });
  assert.deepStrictEqual(managed.result, { installed: false, error: 'boom' });
}

try {
  testInstallsOnceAndReportsResult();
  testEveryStopSignalRemovesHooks();
  testRemovesOnlyOnce();
  testExitWithoutSignal();
  testUninstallFailureDoesNotBlockShutdown();
  testInstallFailureIsReported();
  testLeftoverHooksAreReported();
  console.log('✅ Hook lifecycle checks passed!');
} catch (err) {
  console.error('❌ Hook lifecycle checks failed:', err);
  process.exit(1);
}
