/**
 * Git metadata for a room: the branch is read from .git/HEAD (no process), and the dirty-file
 * count is refreshed in the background at most every 30 s, never blocking the caller.
 * Repositories here are faked by writing .git/HEAD by hand; no git binary is involved.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-git-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

const gitMeta = require('../src/git-meta');
const parser = require('../src/transcript-parser');

const { readBranch, getGitMetadata } = gitMeta;

let repoCount = 0;
function fakeRepo(head = 'ref: refs/heads/feat/x\n') {
  const root = path.join(isolatedHome, `repo-${repoCount++}`);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), head, 'utf8');
  return root;
}

/** A status runner the test resolves by hand, counting how often it is asked. */
function manualStatus() {
  const runner = (cwd) => {
    runner.calls.push(cwd);
    return new Promise((resolve, reject) => {
      runner.resolve = resolve;
      runner.reject = reject;
    });
  };
  runner.calls = [];
  return runner;
}

const flush = () => new Promise((r) => setImmediate(r));

function hasGitAbove(dir) {
  let cur = dir;
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

function testReadBranch() {
  const root = fakeRepo();
  const nested = path.join(root, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  assert.strictEqual(readBranch(root), 'feat/x');
  assert.strictEqual(readBranch(nested), 'feat/x', 'a subfolder belongs to the repository above it');

  const detached = fakeRepo('1736237a9f0c2b3d4e5f60718293a4b5c6d7e8f9\n');
  assert.strictEqual(readBranch(detached), 'HEAD', 'what `git rev-parse --abbrev-ref HEAD` prints');

  const plain = path.join(isolatedHome, 'plain-folder');
  fs.mkdirSync(plain, { recursive: true });
  if (!hasGitAbove(plain)) {
    assert.strictEqual(readBranch(plain), null);
  }
}

function testWorktreePointer() {
  const main = fakeRepo('ref: refs/heads/main\n');
  const adminDir = path.join(main, '.git', 'worktrees', 'wt');
  fs.mkdirSync(adminDir, { recursive: true });
  fs.writeFileSync(path.join(adminDir, 'HEAD'), 'ref: refs/heads/side\n', 'utf8');

  const relative = path.join(isolatedHome, `wt-${repoCount++}`);
  fs.mkdirSync(relative, { recursive: true });
  fs.writeFileSync(
    path.join(relative, '.git'),
    `gitdir: ${path.relative(relative, adminDir).replace(/\\/g, '/')}\n`,
    'utf8'
  );
  assert.strictEqual(readBranch(relative), 'side', 'a linked worktree has its own HEAD');

  const absolute = path.join(isolatedHome, `wt-${repoCount++}`);
  fs.mkdirSync(absolute, { recursive: true });
  fs.writeFileSync(path.join(absolute, '.git'), `gitdir: ${adminDir}\n`, 'utf8');
  assert.strictEqual(readBranch(absolute), 'side');
}

async function testFirstCallDoesNotWait() {
  const root = fakeRepo();
  const runStatus = manualStatus();

  assert.deepStrictEqual(getGitMetadata(root, { runStatus, now: () => 0 }), {
    branch: 'feat/x',
    dirtyFiles: 0,
  });
  assert.deepStrictEqual(runStatus.calls, [root], 'the count is fetched in the background');

  runStatus.resolve(' M a.js\n?? b.js\n');
  await flush();
  assert.deepStrictEqual(getGitMetadata(root, { runStatus, now: () => 0 }), {
    branch: 'feat/x',
    dirtyFiles: 2,
  });
  assert.strictEqual(runStatus.calls.length, 1);
}

async function testTtlAndInFlight() {
  const root = fakeRepo();
  const runStatus = manualStatus();
  let t = 0;
  const now = () => t;

  getGitMetadata(root, { runStatus, now });
  runStatus.resolve('');
  await flush();

  t = 29999;
  getGitMetadata(root, { runStatus, now });
  assert.strictEqual(runStatus.calls.length, 1, 'git is not started again within 30 s');

  t = 30001;
  getGitMetadata(root, { runStatus, now });
  assert.strictEqual(runStatus.calls.length, 2);

  getGitMetadata(root, { runStatus, now });
  getGitMetadata(root, { runStatus, now });
  assert.strictEqual(runStatus.calls.length, 2, 'one refresh at a time');
  runStatus.resolve('');
  await flush();
}

function testNotARepo() {
  const runStatus = manualStatus();
  const plain = path.join(isolatedHome, 'plain-folder-2');
  fs.mkdirSync(plain, { recursive: true });
  if (!hasGitAbove(plain)) {
    assert.deepStrictEqual(getGitMetadata(plain, { runStatus }), { branch: 'local', dirtyFiles: 0 });
  }
  assert.deepStrictEqual(getGitMetadata('', { runStatus }), { branch: 'main', dirtyFiles: 0 });
  assert.deepStrictEqual(getGitMetadata(path.join(isolatedHome, 'gone'), { runStatus }), {
    branch: 'main',
    dirtyFiles: 0,
  });
  assert.deepStrictEqual(runStatus.calls, [], 'no git process for a folder outside a repository');
}

async function testStatusFailureKeepsLastValue() {
  const root = fakeRepo();
  const runStatus = manualStatus();
  let t = 0;
  const now = () => t;

  getGitMetadata(root, { runStatus, now });
  runStatus.resolve(' M a.js\n M b.js\n');
  await flush();

  t = 30001;
  getGitMetadata(root, { runStatus, now });
  runStatus.reject(new Error('git timed out'));
  await flush();
  assert.strictEqual(getGitMetadata(root, { runStatus, now }).dirtyFiles, 2);
  assert.strictEqual(runStatus.calls.length, 2, 'a failed refresh is not retried in a tight loop');
}

async function testParserUsesThisModule() {
  assert.strictEqual(parser.getGitMetadata, gitMeta.getGitMetadata);

  const root = fakeRepo();
  const runStatus = manualStatus();
  getGitMetadata(root, { runStatus, now: () => 0 });
  runStatus.resolve(' M a.js\n');
  await flush();
  assert.strictEqual(getGitMetadata(root, { runStatus, now: () => 0 }).dirtyFiles, 1);

  parser.clearCaches();
  assert.strictEqual(
    getGitMetadata(root, { runStatus, now: () => 0 }).dirtyFiles,
    0,
    'clearCaches() also forgets git state'
  );
  runStatus.resolve('');
  await flush();
}

async function run() {
  try {
    testReadBranch();
    testWorktreePointer();
    await testFirstCallDoesNotWait();
    await testTtlAndInFlight();
    testNotARepo();
    await testStatusFailureKeepsLastValue();
    await testParserUsesThisModule();
    console.log('✅ Git metadata checks passed!');
  } finally {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('❌ Git metadata checks failed:', err);
  process.exit(1);
});
