const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * Git state shown on a room: branch and number of changed files.
 *
 * Starting a process is expensive on machines with endpoint-security software (1-2 s each has
 * been measured), and even an asynchronous spawn blocks the event loop while the process is
 * created. So the branch is read straight from .git/HEAD, and `git status` runs in the
 * background, at most once per GIT_STATUS_TTL_MS per folder, and only for folders that are in
 * a repository. Nothing here waits for git.
 */
const GIT_STATUS_TTL_MS = 30000;
// One process start alone can take longer than the 1.5 s this used to allow.
const GIT_STATUS_TIMEOUT_MS = 10000;
const MAX_CACHE_ENTRIES = 200;
const MAX_PARENT_LEVELS = 40;

const statusCache = new Map();

/** The git directory governing `cwd`: `.git` itself, or where a worktree's `.git` file points. */
function findGitDir(cwd) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < MAX_PARENT_LEVELS; i++) {
    const dotGit = path.join(dir, '.git');
    let stat = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {}
    if (stat && stat.isDirectory()) return dotGit;
    if (stat && stat.isFile()) {
      const pointer = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
      return pointer ? path.resolve(dir, pointer[1].trim()) : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * The checked-out branch of the repository `cwd` is in, without starting git: 'HEAD' when
 * detached (as `git rev-parse --abbrev-ref HEAD` prints), null outside a repository.
 */
function readBranch(cwd) {
  if (!cwd) return null;
  try {
    const gitDir = findGitDir(cwd);
    if (!gitDir) return null;
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return ref ? ref[1] : 'HEAD';
  } catch {
    return null;
  }
}

function runGitStatus(cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['status', '--porcelain'],
      {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GIT_STATUS_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout)))
    );
  });
}

function countChangedFiles(porcelain) {
  const text = String(porcelain || '').trim();
  return text ? text.split(/\r?\n/).filter(Boolean).length : 0;
}

/**
 * `{ branch, dirtyFiles }` for a room's folder. Returns at once: `dirtyFiles` is the last count
 * seen (0 until the first background refresh lands).
 */
function getGitMetadata(cwd, options = {}) {
  if (!cwd || !fs.existsSync(cwd)) {
    return { branch: 'main', dirtyFiles: 0 };
  }
  const branch = readBranch(cwd);
  if (!branch) {
    return { branch: 'local', dirtyFiles: 0 };
  }

  const clock = options.now || Date.now;
  let entry = statusCache.get(cwd);
  if (!entry) {
    entry = { dirtyFiles: 0, refreshedAt: null, refreshing: false };
    statusCache.set(cwd, entry);
    if (statusCache.size > MAX_CACHE_ENTRIES) {
      statusCache.delete(statusCache.keys().next().value);
    }
  }

  const stale = entry.refreshedAt === null || clock() - entry.refreshedAt > GIT_STATUS_TTL_MS;
  if (stale && !entry.refreshing) {
    entry.refreshing = true;
    let pending;
    try {
      pending = Promise.resolve((options.runStatus || runGitStatus)(cwd));
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending
      .then(
        (porcelain) => {
          entry.dirtyFiles = countChangedFiles(porcelain);
        },
        () => {
          // git missing, timed out or failed: keep the last count and wait out the TTL.
        }
      )
      .then(() => {
        entry.refreshedAt = clock();
        entry.refreshing = false;
      });
  }

  return { branch, dirtyFiles: entry.dirtyFiles };
}

function clearGitCache() {
  statusCache.clear();
}

module.exports = { readBranch, getGitMetadata, clearGitCache, GIT_STATUS_TTL_MS };
