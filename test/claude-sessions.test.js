/**
 * Claude Code's session registry (~/.claude/sessions/<pid>.json): finding the pid of the claude
 * process a hook event came from, now that HTTP hooks carry no environment.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-sessions-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

const { lookupClaudeSession } = require('../src/claude-sessions');

const SID_A = '88630827-3ff5-40f2-a81d-2d2792b8d03f';
const SID_B = '28d1e238-e03b-4884-adf1-736c36cbaa00';

let dirCount = 0;
/** A fresh registry folder per test, so one test's cached scan cannot answer another's lookup. */
function registryDir() {
  const dir = path.join(isolatedHome, `registry-${dirCount++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A registry file as Claude Code 2.1.332 writes it. */
function writeEntry(dir, pid, sessionId, extra = {}) {
  const entry = {
    pid,
    sessionId,
    cwd: 'C:\\repos\\e2e-forge',
    startedAt: 1795631483360,
    procStart: '134401050784146921',
    version: '2.1.332',
    peerProtocol: 1,
    peerFeatures: ['notify_idle', 'artifact_yield'],
    kind: 'interactive',
    entrypoint: 'cli',
    pidDomain: 'win32:comp',
    ...extra,
  };
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify(entry), 'utf8');
}

function testFindsSession() {
  const dir = registryDir();
  writeEntry(dir, 16136, SID_A);
  assert.deepStrictEqual(lookupClaudeSession(SID_A, { sessionsDir: dir }), {
    pid: 16136,
    entrypoint: 'cli',
    kind: 'interactive',
    cwd: 'C:\\repos\\e2e-forge',
  });
}

function testIgnoresNoise() {
  const dir = registryDir();
  fs.writeFileSync(path.join(dir, '16136.c36701dcfd3ea61c.key'), 'not json at all', 'utf8');
  fs.writeFileSync(path.join(dir, '999.json'), '{ nope', 'utf8');
  fs.writeFileSync(path.join(dir, '1000.json'), '{ "pid": 1000 }', 'utf8');
  fs.writeFileSync(path.join(dir, '1001.json'), JSON.stringify({ pid: 'x', sessionId: SID_B }), 'utf8');
  writeEntry(dir, 412, SID_A);

  assert.strictEqual(lookupClaudeSession(SID_A, { sessionsDir: dir }).pid, 412);
  assert.strictEqual(lookupClaudeSession(SID_B, { sessionsDir: dir }), null, 'an entry without a real pid');
  assert.strictEqual(lookupClaudeSession('ec018271-3578-4606-af90-421bac69aa12', { sessionsDir: dir }), null);
  for (const bad of ['', null, undefined, 42]) {
    assert.strictEqual(lookupClaudeSession(bad, { sessionsDir: dir }), null);
  }
}

function testMissingFolder() {
  const missing = path.join(isolatedHome, 'no-such-folder');
  assert.strictEqual(lookupClaudeSession(SID_A, { sessionsDir: missing }), null);
}

function testNewestWins() {
  // A resumed session gets a new process; a crashed one can leave its old file behind.
  const dir = registryDir();
  writeEntry(dir, 100, SID_A, { startedAt: 1 });
  writeEntry(dir, 200, SID_A, { startedAt: 2 });
  assert.strictEqual(lookupClaudeSession(SID_A, { sessionsDir: dir }).pid, 200);
}

function testNewSessionFoundOnItsFirstEvent() {
  // Another session's event has just scanned the folder; then a new claude process starts.
  // Its very first event must be recognised: whether it is a scripted run depends on it.
  const dir = registryDir();
  let t = 0;
  const now = () => t;
  writeEntry(dir, 100, SID_A);
  assert.strictEqual(lookupClaudeSession(SID_A, { sessionsDir: dir, now }).pid, 100);

  writeEntry(dir, 5151, SID_B, { kind: 'headless', entrypoint: 'sdk-cli' });
  t = 300;
  assert.deepStrictEqual(lookupClaudeSession(SID_B, { sessionsDir: dir, now }), {
    pid: 5151,
    entrypoint: 'sdk-cli',
    kind: 'headless',
    cwd: 'C:\\repos\\e2e-forge',
  });
}

function testUnknownIdIsNotRescannedOnEveryEvent() {
  // An id the registry does not have (an `amc run` wrapper id, an older Claude Code) must not
  // cost a folder read per event.
  const dir = registryDir();
  let t = 0;
  const now = () => t;
  assert.strictEqual(lookupClaudeSession(SID_A, { sessionsDir: dir, now }), null);

  writeEntry(dir, 555, SID_A);
  t = 1999;
  assert.strictEqual(lookupClaudeSession(SID_A, { sessionsDir: dir, now }), null);
  t = 2001;
  assert.strictEqual(lookupClaudeSession(SID_A, { sessionsDir: dir, now }).pid, 555);
}

function testKnownSessionIsServedFromTheLastScan() {
  const dir = registryDir();
  let t = 0;
  const now = () => t;
  writeEntry(dir, 321, SID_A);
  assert.strictEqual(lookupClaudeSession(SID_A, { sessionsDir: dir, now }).pid, 321);

  fs.rmSync(path.join(dir, '321.json'));
  t = 1999;
  assert.strictEqual(lookupClaudeSession(SID_A, { sessionsDir: dir, now }).pid, 321);
  t = 2001;
  assert.strictEqual(lookupClaudeSession(SID_A, { sessionsDir: dir, now }), null, 'the session ended');
}

function testDefaultFolderIsUnderHome() {
  const dir = path.join(isolatedHome, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  writeEntry(dir, 777, SID_B);
  assert.strictEqual(lookupClaudeSession(SID_B).pid, 777);
}

function run() {
  try {
    testFindsSession();
    testIgnoresNoise();
    testMissingFolder();
    testNewestWins();
    testNewSessionFoundOnItsFirstEvent();
    testUnknownIdIsNotRescannedOnEveryEvent();
    testKnownSessionIsServedFromTheLastScan();
    testDefaultFolderIsUnderHome();
    console.log('✅ Claude session registry checks passed!');
  } finally {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

try {
  run();
} catch (err) {
  console.error('❌ Claude session registry checks failed:', err);
  process.exit(1);
}
