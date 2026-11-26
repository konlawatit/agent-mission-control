const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const { sanitizeQuestions } = require('./ask-prompt');

const GIT_CACHE_TTL_MS = 5000;
const TRANSCRIPT_LIST_TTL_MS = 2000;
const MAX_CACHE_ENTRIES = 200;

const GIT_OPTS = {
  stdio: ['ignore', 'pipe', 'ignore'],
  timeout: 1500,
  windowsHide: true,
};

function toGitMeta(branchOut, statusOut) {
  const branch = String(branchOut || '').trim();
  const status = String(statusOut || '').trim();
  return {
    branch: branch || 'main',
    dirtyFiles: status ? status.split(/\r?\n/).filter(Boolean).length : 0,
  };
}

function readGitMetadataSync(cwd) {
  try {
    return toGitMeta(
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        ...GIT_OPTS,
        cwd,
      }),
      execFileSync('git', ['status', '--porcelain'], { ...GIT_OPTS, cwd })
    );
  } catch {
    return { branch: 'local', dirtyFiles: 0 };
  }
}

function readGitMetadataAsync(cwd) {
  const run = (args) =>
    new Promise((resolve, reject) =>
      execFile('git', args, { ...GIT_OPTS, cwd }, (err, stdout) =>
        err ? reject(err) : resolve(stdout)
      )
    );
  return Promise.all([
    run(['rev-parse', '--abbrev-ref', 'HEAD']),
    run(['status', '--porcelain']),
  ])
    .then(([branchOut, statusOut]) => toGitMeta(branchOut, statusOut))
    .catch(() => ({ branch: 'local', dirtyFiles: 0 }));
}

function boundCache(map) {
  if (map.size > MAX_CACHE_ENTRIES) {
    map.delete(map.keys().next().value);
  }
}

const gitCache = new Map();

function getGitMetadata(cwd) {
  if (!cwd || !fs.existsSync(cwd)) {
    return { branch: 'main', dirtyFiles: 0 };
  }
  const hit = gitCache.get(cwd);
  if (!hit) {
    const value = readGitMetadataSync(cwd);
    gitCache.set(cwd, { at: Date.now(), value, refreshing: false });
    boundCache(gitCache);
    return { ...value };
  }
  if (Date.now() - hit.at > GIT_CACHE_TTL_MS && !hit.refreshing) {
    hit.refreshing = true;
    readGitMetadataAsync(cwd).then((value) => {
      hit.value = value;
      hit.at = Date.now();
      hit.refreshing = false;
    });
  }
  return { ...hit.value };
}

/**
 * Lists modified, staged, untracked, and session-touched files in `cwd` with git diff line counts
 * for the built-in Web IDE File Explorer.
 */
function getWorkspaceChangedFiles(cwd, sessionModifiedFiles = []) {
  if (!cwd || !fs.existsSync(cwd)) return [];
  const fileMap = new Map();

  try {
    // -uall lists files inside untracked folders; only trailing whitespace is trimmed because
    // the two-character status column of the first line can start with a space.
    const statusOut = execFileSync('git', ['status', '--porcelain', '-uall'], {
      ...GIT_OPTS,
      cwd,
    })
      .toString('utf8')
      .replace(/\s+$/, '');

    if (statusOut) {
      for (const line of statusOut.split(/\r?\n/)) {
        if (line.length < 4) continue;
        const code = line.slice(0, 2).trim() || 'M';
        let relPath = line.slice(3).trim();
        if (relPath.includes(' -> ')) {
          relPath = relPath.split(' -> ').pop().trim();
        }
        relPath = relPath.replace(/^"+|"+$/g, '');
        fileMap.set(relPath.replace(/\\/g, '/'), {
          path: relPath.replace(/\\/g, '/'),
          status: code,
          additions: 0,
          deletions: 0,
        });
      }
    }

    // New untracked files have no diff; count their lines as additions.
    for (const entry of fileMap.values()) {
      if (entry.status !== '??') continue;
      try {
        const abs = path.join(cwd, entry.path);
        const st = fs.statSync(abs);
        if (st.isFile() && st.size <= 512 * 1024) {
          const text = fs.readFileSync(abs, 'utf8');
          const breaks = (text.match(/\n/g) || []).length;
          entry.additions = text && !text.endsWith('\n') ? breaks + 1 : breaks;
        }
      } catch {}
    }

    const numstatOut = execFileSync('git', ['diff', '--numstat', 'HEAD'], {
      ...GIT_OPTS,
      cwd,
    })
      .toString('utf8')
      .trim();

    if (numstatOut) {
      for (const line of numstatOut.split(/\r?\n/)) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          const add = Number(parts[0]) || 0;
          const del = Number(parts[1]) || 0;
          const relPath = parts[2].trim().replace(/\\/g, '/');
          const existing = fileMap.get(relPath) || {
            path: relPath,
            status: 'M',
            additions: 0,
            deletions: 0,
          };
          existing.additions = add;
          existing.deletions = del;
          fileMap.set(relPath, existing);
        }
      }
    }
  } catch {
    // Fallback if not a git repo
  }

  const resolvedCwd = path.resolve(cwd);
  for (const rawFile of sessionModifiedFiles || []) {
    if (!rawFile) continue;
    const abs = path.isAbsolute(rawFile)
      ? path.resolve(rawFile)
      : path.resolve(resolvedCwd, rawFile);
    if (abs.startsWith(resolvedCwd + path.sep)) {
      const rel = path.relative(resolvedCwd, abs).replace(/\\/g, '/');
      if (!fileMap.has(rel)) {
        fileMap.set(rel, {
          path: rel,
          status: 'Touched',
          additions: 0,
          deletions: 0,
        });
      }
    }
  }

  return Array.from(fileMap.values()).slice(0, 50);
}

/**
 * Safely reads a file's unified Git diff and source content inside `cwd` for the Web IDE viewer.
 * Strictly blocks any path traversal outside `cwd`.
 */
function getWorkspaceFileDetail(cwd, relativeFilePath) {
  if (!cwd || !relativeFilePath || typeof relativeFilePath !== 'string') {
    return { ok: false, error: 'Missing cwd or file path' };
  }
  const baseDir = path.resolve(cwd);
  const targetPath = path.resolve(baseDir, relativeFilePath);
  if (
    targetPath !== baseDir &&
    !targetPath.startsWith(baseDir + path.sep)
  ) {
    return { ok: false, error: 'Path traversal denied' };
  }

  const relNormalized = path.relative(baseDir, targetPath).replace(/\\/g, '/');
  let diffText = '';
  try {
    diffText = execFileSync('git', ['diff', 'HEAD', '--', relNormalized], {
      ...GIT_OPTS,
      cwd: baseDir,
      maxBuffer: 512 * 1024,
    }).toString('utf8');
    if (!diffText.trim()) {
      diffText = execFileSync('git', ['diff', '--', relNormalized], {
        ...GIT_OPTS,
        cwd: baseDir,
        maxBuffer: 512 * 1024,
      }).toString('utf8');
    }
  } catch {
    diffText = '';
  }

  let content = '';
  let exists = false;
  let truncated = false;
  try {
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
      exists = true;
      const stat = fs.statSync(targetPath);
      const maxRead = 120 * 1024;
      const len = Math.min(stat.size, maxRead);
      truncated = stat.size > maxRead;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(targetPath, 'r');
      fs.readSync(fd, buf, 0, len, 0);
      fs.closeSync(fd);
      content = buf.toString('utf8');
    }
  } catch (err) {
    content = `Cannot read file: ${err.message}`;
  }

  return {
    ok: true,
    relativePath: relNormalized,
    fullPath: targetPath,
    exists,
    truncated,
    diff: diffText,
    content,
  };
}

/**
 * Estimates API cost in USD from Claude token counts and model family.
 */
// First-party API rates in USD per 1M tokens: [input, output, cache read].
// Cache writes are billed at 1.25x input (5-minute TTL). Most specific prefix wins.
const MODEL_RATES = [
  ['claude-fable-5-2', [8, 40, 0.2]],
  ['claude-mythos-5-2', [8, 40, 0.2]],
  ['claude-fable-5', [10, 50, 1.0]],
  ['claude-mythos-5', [10, 50, 1.0]],
  ['claude-opus-5-5', [4, 20, 0.2]],
  ['claude-opus-5', [5, 25, 0.5]],
  ['claude-opus-4-8', [5, 25, 0.5]],
  ['claude-opus-4-7', [5, 25, 0.5]],
  ['claude-opus-4-6', [5, 25, 0.5]],
  ['claude-opus-4-5', [5, 25, 0.5]],
  ['claude-sonnet-5-5', [2, 10, 0.1]],
  ['claude-sonnet-5', [2, 10, 0.2]],
  ['claude-haiku-5-5', [0.1, 0.5, 0.01]],
  ['claude-haiku-4-5', [1, 5, 0.1]],
];
const FAMILY_RATES = {
  fable: [8, 40, 0.2],
  mythos: [8, 40, 0.2],
  opus: [4, 20, 0.2],
  sonnet: [3, 15, 0.3],
  haiku: [1, 5, 0.1],
};

function getModelRates(modelName) {
  const m = String(modelName || '').toLowerCase();
  for (const [prefix, rates] of MODEL_RATES) {
    if (m.startsWith(prefix)) return rates;
  }
  // Claude 3.x / Opus 4.0-4.1 era IDs carried the older, higher Opus price.
  if (/claude-(3|opus-4-[01]|opus-4-\d{8})/.test(m) && m.includes('opus')) {
    return [15, 75, 1.5];
  }
  for (const family of Object.keys(FAMILY_RATES)) {
    if (m.includes(family)) return FAMILY_RATES[family];
  }
  return FAMILY_RATES.sonnet;
}

/**
 * Estimates API-equivalent cost in USD from Claude token counts and the model that produced them.
 * Subscription plans are not billed per token; this is a relative-cost signal only.
 */
function estimateClaudeCostUsd(modelName, usage) {
  const [inRate, outRate, cacheReadRate] = getModelRates(modelName);
  const cacheWriteRate = inRate * 1.25;

  const cost =
    ((usage.inputTokens || 0) / 1e6) * inRate +
    ((usage.outputTokens || 0) / 1e6) * outRate +
    ((usage.cacheReadTokens || 0) / 1e6) * cacheReadRate +
    ((usage.cacheCreateTokens || 0) / 1e6) * cacheWriteRate;

  return Math.round(cost * 10000) / 10000;
}

/**
 * The folder name Claude Code keeps a working directory's transcripts under: every character
 * that is not a letter or digit becomes "-" (C:\repo\app\.wt\x -> C--repo-app--wt-x).
 */
function encodeProjectDir(cwd) {
  return String(cwd || '')
    .split('>')[0]
    .trim()
    .replace(/[\\\/]+$/, '')
    .replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Where a Claude session was started, from its transcript's folder: the nearest ancestor of
 * `cwd` (the hook's current directory, which follows Bash `cd`) whose encoding names that folder.
 */
function launchCwdFor(cwd, transcriptPath) {
  if (!cwd || !transcriptPath) return null;
  const projectDir = path.basename(path.dirname(String(transcriptPath))).toLowerCase();
  let dir = String(cwd).replace(/[\\\/]+$/, '');
  for (let i = 0; i < 40 && dir; i++) {
    if (encodeProjectDir(dir).toLowerCase() === projectDir) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const entrypointCache = new Map();

/** How a transcript's session was started ("cli" in a terminal, "sdk-cli" for `claude -p`, "sdk-ts"/"sdk-py" for the SDK). */
function transcriptEntrypoint(transcriptPath) {
  if (!transcriptPath) return null;
  const key = String(transcriptPath);
  if (entrypointCache.has(key)) return entrypointCache.get(key);
  let found = null;
  try {
    const fd = fs.openSync(key, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      const m = line.match(/"entrypoint"\s*:\s*"([^"]+)"/);
      if (m) {
        found = m[1];
        break;
      }
    }
  } catch {
    return null; // not written yet; ask again next time
  }
  if (found) {
    entrypointCache.set(key, found);
    boundCache(entrypointCache);
  }
  return found;
}

/** A session started by a script or tool (`claude -p`, the Agent SDK), not by a person in a terminal. */
function isAutomatedEntrypoint(entrypoint) {
  return /^sdk-/i.test(String(entrypoint || ''));
}

/** The transcript file of a Claude session id, wherever its project folder is. */
function findTranscriptById(sessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(sessionId || ''))) return null;
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    for (const d of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const file = path.join(projectsDir, d.name, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  } catch {}
  return null;
}

function scanTranscriptsForCwd(cwd) {
  if (!cwd) return [];
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return [];

    // Only this folder's own transcripts: a loose "name contains" match also pulled in sibling
    // and nested folders (e2e-forge matched e2e-forge--worktrees-partner) and mixed sessions.
    const expectedSlug = encodeProjectDir(cwd).toLowerCase();
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    const matchedFiles = [];

    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      if (d.name.toLowerCase() === expectedSlug) {
        const fullDir = path.join(projectsDir, d.name);
        const files = fs
          .readdirSync(fullDir)
          .filter((f) => f.endsWith('.jsonl'));
        for (const f of files) {
          const fullFile = path.join(fullDir, f);
          const stat = fs.statSync(fullFile);
          matchedFiles.push({
            path: fullFile,
            mtimeMs: stat.mtimeMs,
            sessionId: path.basename(f, '.jsonl'),
          });
        }
      }
    }

    matchedFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return matchedFiles;
  } catch {
    return [];
  }
}

const transcriptListCache = new Map();

function findTranscriptsForCwd(cwd) {
  if (!cwd) return [];
  const key = String(cwd);
  const hit = transcriptListCache.get(key);
  if (hit && Date.now() - hit.at < TRANSCRIPT_LIST_TTL_MS) {
    return hit.list;
  }
  const list = scanTranscriptsForCwd(cwd);
  transcriptListCache.set(key, { at: Date.now(), list });
  boundCache(transcriptListCache);
  return list;
}

const parseCache = new Map();

function fileSignature(paths) {
  return paths
    .map((p) => {
      try {
        const st = fs.statSync(p);
        return `${p}:${st.mtimeMs}:${st.size}`;
      } catch {
        return `${p}:missing`;
      }
    })
    .join('|');
}

function parseTranscriptTail(transcriptPath, cwd = null) {
  const candidates = findTranscriptsForCwd(cwd)
    .slice(0, 3)
    .map((item) => item.path);
  if (transcriptPath) candidates.push(transcriptPath);

  const key = `${transcriptPath || ''}\u0000${cwd || ''}`;
  const signature = fileSignature(candidates);
  const hit = parseCache.get(key);
  if (hit && hit.signature === signature) {
    return hit.result && structuredClone(hit.result);
  }

  const result = parseTranscriptTailUncached(transcriptPath, cwd);
  parseCache.set(key, { signature, result });
  boundCache(parseCache);
  return result && structuredClone(result);
}

function clearCaches() {
  gitCache.clear();
  transcriptListCache.clear();
  parseCache.clear();
  usageCache.clear();
}

function findLatestTranscriptForCwd(cwd) {
  const list = findTranscriptsForCwd(cwd);
  return list.length > 0 ? list[0].path : null;
}

/**
 * Incremental, whole-file token accounting per transcript.
 * The tail parser only reads the last 256 KB, which undercounts long sessions, so usage is
 * accumulated here by reading only the bytes appended since the previous call.
 */
const usageCache = new Map();
const USAGE_RECENT_MS = 6 * 3600 * 1000;
const USAGE_CHUNK_BYTES = 4 * 1024 * 1024;

function freshUsageEntry() {
  return {
    offset: 0,
    carry: '',
    seen: new Set(),
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      messageCount: 0,
    },
    // { t: epoch ms, b: billable tokens } for messages inside the recent window
    recent: [],
    lastAt: 0,
  };
}

function ingestUsageLine(entry, line) {
  if (!line.includes('"usage"')) return;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  const msg = obj.message || obj;
  const usage = msg && msg.usage;
  if (!usage || typeof usage !== 'object') return;
  const key = msg.id || obj.uuid || `${obj.timestamp}-${usage.output_tokens || 0}`;
  if (entry.seen.has(key)) return;
  entry.seen.add(key);

  const inTok = Number(usage.input_tokens || 0);
  const outTok = Number(usage.output_tokens || 0);
  const cacheCreate = Number(usage.cache_creation_input_tokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || 0);
  const t = entry.totals;
  t.inputTokens += inTok;
  t.outputTokens += outTok;
  t.cacheCreateTokens += cacheCreate;
  t.cacheReadTokens += cacheRead;
  t.thinkingTokens += Number(
    (usage.output_tokens_details && usage.output_tokens_details.thinking_tokens) || 0
  );
  t.messageCount += 1;

  const at = Date.parse(obj.timestamp || '') || 0;
  if (at > entry.lastAt) entry.lastAt = at;
  if (at && Date.now() - at < USAGE_RECENT_MS) {
    // Cache reads are cheap against plan limits, so the estimate counts fresh tokens only.
    entry.recent.push({ t: at, b: inTok + outTok + cacheCreate });
  }
}

function readUsageIncremental(filePath) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    usageCache.delete(filePath);
    return null;
  }
  let entry = usageCache.get(filePath);
  if (!entry || st.size < entry.offset) {
    entry = freshUsageEntry();
    usageCache.set(filePath, entry);
  }
  if (st.size > entry.offset) {
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      while (entry.offset < st.size) {
        const len = Math.min(USAGE_CHUNK_BYTES, st.size - entry.offset);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, entry.offset);
        entry.offset += len;
        const text = entry.carry + buf.toString('utf8');
        const lines = text.split('\n');
        entry.carry = lines.pop() || '';
        for (const line of lines) ingestUsageLine(entry, line);
      }
    } catch {
      // Leave what was read; the next call retries from the stored offset.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  const cutoff = Date.now() - USAGE_RECENT_MS;
  if (entry.recent.length && entry.recent[0].t < cutoff) {
    entry.recent = entry.recent.filter((r) => r.t >= cutoff);
  }
  return entry;
}

/**
 * Fresh (non-cache-read) tokens across every transcript read so far, since `sinceMs`.
 * Each transcript file is counted once, even when several rooms share it.
 */
function getRecentBillableTokens(sinceMs) {
  let tokens = 0;
  let oldestAt = null;
  for (const entry of usageCache.values()) {
    for (const r of entry.recent) {
      if (r.t < sinceMs) continue;
      tokens += r.b;
      if (oldestAt === null || r.t < oldestAt) oldestAt = r.t;
    }
  }
  return { tokens, oldestAt };
}

function getContextWindowTokens(modelName) {
  const m = String(modelName || '').toLowerCase();
  if (m.includes('haiku-4') || m.includes('claude-3') || /-4-[0-5]\b/.test(m)) {
    return 200000;
  }
  return 1000000;
}

const TAIL_CHUNK_BYTES = 256 * 1024;
const TAIL_MAX_BYTES = 4 * 1024 * 1024;
const TAIL_MIN_LINES = 30; // the preview shows the last 30 conversation lines
const NEWLINE = 0x0a;

function isHumanPromptText(entry, text) {
  if (entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return false;
  const clean = String(text || '').trim();
  return Boolean(clean) && !clean.startsWith('<');
}

/** How many preview lines an entry adds, and whether it starts a turn. */
function countShown(entry) {
  const msg = entry.message || entry;
  const role = msg.role || entry.type;
  const content = msg.content;
  let lines = 0;
  let prompts = 0;
  if (role === 'user') {
    const texts =
      typeof content === 'string'
        ? [content]
        : Array.isArray(content)
        ? content.filter((b) => b.type === 'text').map((b) => b.text)
        : [];
    for (const t of texts) {
      if (isHumanPromptText(entry, t)) {
        lines += 1;
        if (!INTERRUPTED_RE.test(String(t).trim())) prompts += 1; // a stop is not a prompt
      }
    }
  } else if (role === 'assistant' && Array.isArray(content)) {
    for (const b of content) {
      if ((b.type === 'text' && b.text && b.text.trim()) || (b.type === 'tool_use' && b.name)) lines += 1;
    }
  }
  return { lines, prompts };
}

/** A transcript line as a conversation entry, or null for bookkeeping and broken lines. */
function parseConversationLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let entry;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return null;
  }
  // Claude Code also stores request copies (`api-request-blob`, which carry a `message`),
  // tool shapes and attachments in the same file. Only real messages are conversation,
  // plus the marker written when a turn ends and the queue of messages sent while it worked.
  if (isTurnEndMarker(entry) || entry.type === 'queue-operation') return entry;
  if (typeof entry.type === 'string' && entry.type !== 'user' && entry.type !== 'assistant') {
    return null;
  }
  return entry;
}

function isTurnEndMarker(entry) {
  return entry.type === 'system' && entry.subtype === 'turn_duration';
}

const INTERRUPTED_RE = /^\[Request interrupted by user/;
const STOPPED_LINE = '⏹ หยุดแล้ว (กด Esc)';
const MAX_QUEUE_ITEMS = 10;

/**
 * Messages sent while Claude was working wait in its queue (`queue-operation` entries). If the
 * turn is stopped with Esc, Claude Code puts the waiting ones back into the terminal's input box
 * (`popAll`). Tracks both, so the dashboard can show what is waiting and what came back.
 */
function trackQueue(state, entry) {
  if (entry.type === 'queue-operation') {
    const text = String(entry.content == null ? '' : entry.content);
    if (entry.operation === 'enqueue') {
      state.queue.push({ text, at: entry.timestamp || null });
      state.restored = null; // a new message was submitted from the input box
    } else if (entry.operation === 'dequeue') {
      state.queue.shift();
    } else if (entry.operation === 'remove') {
      const i = state.queue.findIndex((q) => q.text === text);
      if (i >= 0) state.queue.splice(i, 1); // queued before the part read: nothing to drop
    } else if (entry.operation === 'popAll') {
      const back = state.queue.filter((q) => !/^\s*</.test(q.text)).map((q) => q.text.trim());
      state.restored = back.length ? { text: back.join('\n'), at: entry.timestamp || null } : null;
      state.queue = [];
    }
    return;
  }
  // A prompt the person submitted after the restore means the input box was used.
  const msg = entry.message || entry;
  if (state.restored && (msg.role || entry.type) === 'user' && !entry.isMeta && countShown(entry).prompts > 0) {
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (!INTERRUPTED_RE.test(text.trim())) state.restored = null;
  }
}

/**
 * The AskUserQuestion call still waiting for an answer after `entry`, given the one before.
 * Its input has every question in full, which the terminal screen cannot show (see ask-prompt).
 */
function trackPendingAsk(pending, entry) {
  if (isTurnEndMarker(entry)) return null;
  const msg = entry.message || entry;
  const content = Array.isArray(msg.content) ? msg.content : [];
  const role = msg.role || entry.type;
  if (role === 'assistant') {
    for (const b of content) {
      if (b.type === 'tool_use' && b.name === 'AskUserQuestion') {
        const questions = sanitizeQuestions(b.input && b.input.questions);
        if (questions) pending = { id: String(b.id || ''), questions, at: entry.timestamp || null };
      }
    }
  } else if (role === 'user' && pending) {
    if (content.some((b) => b.type === 'tool_result' && b.tool_use_id === pending.id)) return null;
  }
  return pending;
}

/**
 * Whether the turn is still running after this entry ('running'), over ('done'), or unchanged (null).
 * Lets the dashboard notice a finished turn when no Stop hook reports it.
 */
function turnStateAfter(entry) {
  if (isTurnEndMarker(entry)) return 'done';
  const msg = entry.message || entry;
  const role = msg.role || entry.type;
  if (role === 'assistant') {
    return msg.stop_reason === 'end_turn' ? 'done' : 'running';
  }
  if (role !== 'user' || entry.isMeta || entry.isCompactSummary) return null;
  const content = msg.content;
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
      ? content.filter((b) => b.type === 'text').map((b) => String(b.text || ''))
      : [];
  if (texts.some((t) => INTERRUPTED_RE.test(t.trim()))) return 'done';
  return 'running'; // a new prompt, or a tool result Claude still has to answer
}

/**
 * Conversation entries ending before byte `endOffset`, oldest first, read backwards in chunks
 * until `enough({ lines, prompts })` says so, the start of the file, or `maxBytes`. Each entry
 * carries its byte offset (`entryOffset`), which is how the dashboard pages back through a session.
 * With `sinceOffset`, reading stops at that offset (entries before it are left out).
 */
function readEntriesBackward(filePath, endOffset, { enough = () => false, maxBytes = TAIL_MAX_BYTES, sinceOffset = null } = {}) {
  const batches = [];
  let lines = 0;
  let prompts = 0;
  let end = endOffset;
  let carry = Buffer.alloc(0); // start of a line whose beginning is in an earlier chunk
  let reachedStart = false;
  const fd = fs.openSync(filePath, 'r');
  try {
    while (end > 0 && endOffset - end < maxBytes && !enough({ lines, prompts })) {
      if (sinceOffset !== null && end <= sinceOffset) break;
      const start = Math.max(0, end - TAIL_CHUNK_BYTES);
      const chunk = Buffer.alloc(end - start);
      fs.readSync(fd, chunk, 0, chunk.length, start);
      end = start;
      let buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let bufOffset = start;
      if (start > 0) {
        // Bytes before the first newline may continue further back; keep them for the next chunk.
        // Splitting on the newline byte never cuts a UTF-8 character.
        const firstNewline = buf.indexOf(NEWLINE);
        if (firstNewline === -1) {
          carry = buf;
          continue;
        }
        carry = buf.subarray(0, firstNewline);
        buf = buf.subarray(firstNewline + 1);
        bufOffset = start + firstNewline + 1;
      } else {
        carry = Buffer.alloc(0);
        reachedStart = true;
      }
      const batch = [];
      let pos = 0;
      while (pos < buf.length) {
        let nl = buf.indexOf(NEWLINE, pos);
        if (nl === -1) nl = buf.length;
        const lineOffset = bufOffset + pos;
        const entry = sinceOffset !== null && lineOffset < sinceOffset ? null : parseConversationLine(buf.toString('utf8', pos, nl));
        pos = nl + 1;
        if (!entry) continue;
        Object.defineProperty(entry, 'entryOffset', { value: lineOffset, enumerable: false });
        batch.push(entry);
        const shown = countShown(entry);
        lines += shown.lines;
        prompts += shown.prompts;
      }
      batches.push(batch);
    }
  } finally {
    fs.closeSync(fd);
  }
  const entries = batches.reverse().flat();
  const atStart = reachedStart || (end === 0 && carry.length === 0);
  // Where reading back should continue: the end of the line cut at the last chunk's start.
  return { entries, reachedStart: atStart, resumeAt: atStart ? 0 : end + carry.length };
}

/**
 * The newest conversation entries of a transcript, oldest first: until the preview is full and
 * the latest human prompt is in, or TAIL_MAX_BYTES is read. A fixed byte window can hold almost
 * no messages once large bookkeeping records sit at the end of the file.
 */
function readConversationTail(filePath, size) {
  return readEntriesBackward(filePath, size, {
    enough: ({ lines, prompts }) => lines >= TAIL_MIN_LINES && prompts >= 1,
  }).entries;
}

/** What the output panel shows for one transcript entry, in the same form as the live preview. */
function displayLinesFor(entry) {
  const msg = entry.message || entry;
  const role = msg.role || entry.type;
  const content = msg.content;
  const out = [];
  if (role === 'user') {
    const texts =
      typeof content === 'string'
        ? [content]
        : Array.isArray(content)
        ? content.filter((b) => b.type === 'text' && b.text).map((b) => b.text)
        : [];
    for (const t of texts) {
      if (!isHumanPromptText(entry, t)) continue;
      out.push(INTERRUPTED_RE.test(t.trim()) ? STOPPED_LINE : `🧑 คุณ: ${t.trim()}`);
    }
  } else if (role === 'assistant' && Array.isArray(content)) {
    for (const b of content) {
      if (b.type === 'text' && b.text && b.text.trim()) out.push(`🤖 Claude:\n${b.text.trim()}`);
      if (b.type === 'tool_use' && b.name) {
        const input = b.input || {};
        const what = input.command || input.file_path || input.path || input.description || input.pattern || '';
        out.push(`🔧 [Tool: ${b.name}] ${summarizeText(what, 100)}`);
      }
    }
  }
  return out;
}

const PAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * An older page of a session's conversation, for reading back past the live preview: the
 * display lines of entries before byte `before` (at least `limit` lines, whole entries), or,
 * with `since`, every entry from `since` up to `before`. `from` is where the next page ends.
 */
function readConversationPage(filePath, { before, since = null, limit = 40 }) {
  const size = fs.statSync(filePath).size;
  const end = Math.max(0, Math.min(Number.isFinite(before) ? before : size, size));
  const { entries, reachedStart, resumeAt } = readEntriesBackward(filePath, end, {
    enough: since === null ? ({ lines }) => lines >= limit : () => false,
    maxBytes: PAGE_MAX_BYTES,
    sinceOffset: since,
  });
  // A chunk can hold far more than a page: keep only the newest whole entries that make `limit` lines.
  let first = 0;
  if (since === null) {
    let count = 0;
    first = entries.length;
    while (first > 0 && count < limit) {
      first -= 1;
      count += displayLinesFor(entries[first]).length;
    }
  }
  const page = entries.slice(first);
  const lines = page.flatMap(displayLinesFor);
  const from = page.length ? page[0].entryOffset : since !== null ? since : resumeAt;
  // Everything older has been read once the start of the file was reached and nothing was left out.
  const restHasLines = entries.slice(0, first).some((e) => displayLinesFor(e).length);
  return { lines, from, done: since === null && reachedStart && !restHasLines };
}

function parseTranscriptTailUncached(transcriptPath, cwd = null) {
  const allTranscripts = findTranscriptsForCwd(cwd);
  const targetPath =
    transcriptPath && fs.existsSync(transcriptPath)
      ? transcriptPath
      : allTranscripts.length > 0
      ? allTranscripts[0].path
      : null;

  if (!targetPath || !fs.existsSync(targetPath)) {
    return null;
  }

  try {
    const filesToRead =
      allTranscripts.length > 0
        ? allTranscripts.slice(0, 3).map((item) => item.path).reverse()
        : [targetPath];

    if (!filesToRead.includes(targetPath)) {
      filesToRead.push(targetPath);
    }

    let lastAssistantFullText = null;
    let lastAssistantText = null;
    let lastUserText = null;
    let detectedModel = null;
    const conversationLines = [];
    const subAgentsMap = new Map();
    const turns = [];
    let currentTurn = null;

    const tokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      contextWindowPct: 0,
      estimatedCostUsd: 0,
      messageCount: 0,
    };

    const seenMessageIds = new Set();
    let turnState = null;
    let turnStateAt = null;
    let pendingAsk = null;
    const queueState = { queue: [], restored: null };

    for (const filePath of filesToRead) {
      if (!fs.existsSync(filePath)) continue;
      const stat = fs.statSync(filePath);

      for (const entry of readConversationTail(filePath, stat.size)) {
        if (filePath === targetPath) {
          const next = turnStateAfter(entry);
          if (next) {
            turnState = next;
            turnStateAt = entry.timestamp || new Date(stat.mtimeMs).toISOString();
          }
          pendingAsk = trackPendingAsk(pendingAsk, entry);
          trackQueue(queueState, entry);
        }
        if (isTurnEndMarker(entry) || entry.type === 'queue-operation') continue;
        const msg = entry.message || entry;
        const role = msg.role || entry.type;
        const content = msg.content;
        const ts = entry.timestamp || new Date(stat.mtimeMs).toISOString();

        if (msg.model && typeof msg.model === 'string') {
          detectedModel = msg.model;
        }

        // Accumulate real Claude token usage per unique message/entry
        if (msg.usage && typeof msg.usage === 'object') {
          const msgKey = msg.id || entry.uuid || `${ts}-${msg.usage.output_tokens || 0}`;
          if (!seenMessageIds.has(msgKey)) {
            seenMessageIds.add(msgKey);
            const inTok = Number(msg.usage.input_tokens || 0);
            const outTok = Number(msg.usage.output_tokens || 0);
            const cacheCreate = Number(msg.usage.cache_creation_input_tokens || 0);
            const cacheRead = Number(msg.usage.cache_read_input_tokens || 0);
            const thinkTok = Number(
              (msg.usage.output_tokens_details &&
                msg.usage.output_tokens_details.thinking_tokens) ||
                0
            );

            tokenUsage.inputTokens += inTok;
            tokenUsage.outputTokens += outTok;
            tokenUsage.cacheCreateTokens += cacheCreate;
            tokenUsage.cacheReadTokens += cacheRead;
            tokenUsage.thinkingTokens += thinkTok;
            tokenUsage.messageCount += 1;

            const turnContext = inTok + cacheCreate + cacheRead;
            if (turnContext > 0) {
              tokenUsage.contextTokens = turnContext;
              tokenUsage.contextWindowPct = Math.min(
                100,
                Math.round((turnContext / 200000) * 1000) / 10
              );
            }
          }
        }

        const recordUserPrompt = (text) => {
          // Skill bodies, image notes and compaction summaries are written as user messages
          // by the harness; they are not the human's prompt.
          if (!isHumanPromptText(entry, text)) return;
          const clean = text.trim();
          // Esc writes "[Request interrupted by user…]" as a user message: show where the turn
          // stopped, not a bubble the person never typed.
          if (INTERRUPTED_RE.test(clean)) {
            conversationLines.push({ t: STOPPED_LINE, o: entry.entryOffset, f: filePath });
            return;
          }
          lastUserText = clean;
          // Each preview line remembers its entry (file + byte offset) for paging back.
          conversationLines.push({ t: `🧑 คุณ: ${clean}`, o: entry.entryOffset, f: filePath });

          if (currentTurn && (currentTurn.tldr || currentTurn.tools.length > 0)) {
            turns.push(currentTurn);
          }
          currentTurn = {
            id: entry.uuid || `turn-${turns.length + 1}-${Date.now()}`,
            goal: summarizeText(clean, 180),
            tldr: '',
            tools: [],
            timestamp: ts,
            sessionId: path.basename(filePath, '.jsonl'),
          };
        };

        if (role === 'user' && typeof content === 'string') {
          recordUserPrompt(content);
        } else if (role === 'user' && Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              recordUserPrompt(block.text);
            }
            if (block.type === 'tool_result' && block.tool_use_id) {
              if (subAgentsMap.has(block.tool_use_id)) {
                const sub = subAgentsMap.get(block.tool_use_id);
                sub.state = block.is_error ? 'failed' : 'done';
                sub.tool = 'Completed';
                if (typeof block.content === 'string') {
                  sub.resultSummary = summarizeText(block.content, 140);
                } else if (Array.isArray(block.content)) {
                  const textBlock = block.content.find(
                    (b) => b.type === 'text'
                  );
                  if (textBlock && textBlock.text) {
                    sub.resultSummary = summarizeText(textBlock.text, 140);
                  }
                }
              }
            }
          }
        }

        if (role === 'assistant' && Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text && block.text.trim()) {
              const clean = block.text.trim();
              lastAssistantFullText = clean;
              lastAssistantText = clean;
              conversationLines.push({ t: `🤖 Claude:\n${clean}`, o: entry.entryOffset, f: filePath });
              if (currentTurn) {
                currentTurn.tldr = summarizeText(clean, 240);
                currentTurn.timestamp = ts;
              }
            }
            if (block.type === 'tool_use') {
              const input = block.input || {};
              const fileOrCmd =
                input.command ||
                input.file_path ||
                input.path ||
                input.description ||
                input.pattern ||
                '';
              if (block.name) {
                const badge = `${block.name}${
                  fileOrCmd
                    ? ': ' + summarizeText(path.basename(String(fileOrCmd)), 35)
                    : ''
                }`;
                conversationLines.push({
                  t: `🔧 [Tool: ${block.name}] ${summarizeText(fileOrCmd, 100)}`,
                  o: entry.entryOffset,
                  f: filePath,
                });
                if (currentTurn && !currentTurn.tools.includes(badge)) {
                  currentTurn.tools.push(badge);
                }
              }
            }
            if (
              block.type === 'tool_use' &&
              (block.name === 'Task' ||
                block.name === 'Agent' ||
                block.name === 'dispatch_agent')
            ) {
              const input = block.input || {};
              const subName =
                input.description ||
                input.subagent_type ||
                input.name ||
                'Sub-Agent Task';
              const subRole = input.prompt
                ? summarizeText(input.prompt, 110)
                : input.subagent_type || 'Autonomous Sub-task';
              subAgentsMap.set(block.id, {
                id: block.id,
                name: `Sub-Agent: ${subName}`,
                role: subRole,
                subagentType: input.subagent_type || 'general',
                state: 'working',
                tool: 'Running Task...',
                startedAt: ts,
              });
            }
          }
        }
      }
    }

    if (currentTurn) {
      turns.push(currentTurn);
    }

    // Replace the tail-only counts with whole-file totals for the same transcripts.
    const fullTotals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      messageCount: 0,
    };
    let recentBillable = 0;
    const windowStart = Date.now() - 5 * 3600 * 1000;
    let accumulated = false;
    for (const filePath of filesToRead) {
      const acc = readUsageIncremental(filePath);
      if (!acc) continue;
      accumulated = true;
      for (const k of Object.keys(fullTotals)) fullTotals[k] += acc.totals[k];
      for (const r of acc.recent) if (r.t >= windowStart) recentBillable += r.b;
    }
    if (accumulated) Object.assign(tokenUsage, fullTotals);
    tokenUsage.window5hTokens = recentBillable;
    tokenUsage.freshTokens =
      tokenUsage.inputTokens + tokenUsage.outputTokens + tokenUsage.cacheCreateTokens;
    tokenUsage.contextWindowTokens = getContextWindowTokens(detectedModel);
    tokenUsage.contextWindowPct = tokenUsage.contextTokens
      ? Math.min(
          100,
          Math.round((tokenUsage.contextTokens / tokenUsage.contextWindowTokens) * 1000) / 10
        )
      : 0;

    tokenUsage.totalTokens =
      tokenUsage.inputTokens +
      tokenUsage.outputTokens +
      tokenUsage.cacheCreateTokens +
      tokenUsage.cacheReadTokens;
    tokenUsage.estimatedCostUsd = estimateClaudeCostUsd(
      detectedModel,
      tokenUsage
    );

    // The live preview: the last 30 lines, widened to start on a whole entry so that paging back
    // from `previewFrom` (the byte offset of its first entry) neither repeats nor skips a line.
    let first = Math.max(0, conversationLines.length - 30);
    while (
      first > 0 &&
      conversationLines[first - 1].f === conversationLines[first].f &&
      conversationLines[first - 1].o === conversationLines[first].o
    ) {
      first -= 1;
    }
    const previewLines = conversationLines.slice(first);
    const recentLog = previewLines.map((l) => l.t).join('\n\n');
    const previewFrom =
      previewLines.length && previewLines[0].f === targetPath && Number.isFinite(previewLines[0].o)
        ? previewLines[0].o
        : null;

    return {
      transcriptPath: targetPath,
      detectedModel,
      tokenUsage,
      lastAssistantFullText,
      lastAssistantText: lastAssistantText
        ? summarizeText(lastAssistantText, 260)
        : null,
      lastUserText: lastUserText ? summarizeText(lastUserText, 160) : null,
      utf8Preview: recentLog || lastAssistantFullText || null,
      previewFrom,
      turnState,
      turnStateAt,
      pendingAsk,
      // Messages still waiting in Claude's queue (sent while it worked), Claude Code's own
      // notifications left out; and the text put back into the input box, if any.
      queuedMessages: queueState.queue
        .filter((q) => !/^\s*</.test(q.text) && q.text.trim())
        .slice(-MAX_QUEUE_ITEMS)
        .map((q) => q.text.trim().slice(0, 4000)),
      restoredInput: queueState.restored ? { text: queueState.restored.text.slice(0, 4000), at: queueState.restored.at } : null,
      turnHistory: turns.reverse().slice(0, 20),
      subAgents: Array.from(subAgentsMap.values()),
    };
  } catch {
    return null;
  }
}

function summarizeText(text, maxLen = 200) {
  if (!text) return '';
  const cleaned = String(text)
    .replace(/```[\s\S]*?```/g, '[โค้ด/คำสั่ง]')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1) + '…';
}

function inferWorkflowFromTool(toolName, toolInput = {}) {
  const name = String(toolName || '');
  const filePath =
    toolInput.file_path ||
    toolInput.path ||
    toolInput.notebook_path ||
    toolInput.pattern ||
    '';
  const shortFile = filePath ? path.basename(String(filePath)) : '';

  if (
    ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite'].includes(
      name
    )
  ) {
    const detail = shortFile
      ? `กำลังอ่านและสำรวจ ${shortFile}`
      : toolInput.pattern
      ? `กำลังค้นหาโค้ด "${toolInput.pattern}"`
      : `กำลังสำรวจโครงสร้างและวางแผน (${name})`;
    return {
      stageIndex: 0,
      stageName: 'plan',
      toolBadge: `${name}${shortFile ? ': ' + shortFile : ''}`,
      tldr: detail,
      modifiedFile: null,
    };
  }

  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) {
    return {
      stageIndex: 1,
      stageName: 'code',
      toolBadge: `${name}: ${shortFile || 'file'}`,
      tldr: `กำลังแก้ไขไฟล์ ${shortFile || 'โค้ดในโปรเจกต์'} (${name})`,
      modifiedFile: filePath ? String(filePath) : null,
    };
  }

  if (name === 'Task' || name === 'Agent') {
    const desc =
      toolInput.description ||
      toolInput.subagent_type ||
      summarizeText(toolInput.prompt || 'งานย่อย', 60);
    return {
      stageIndex: 1,
      stageName: 'code',
      toolBadge: `Sub-Agent: ${desc}`,
      tldr: `แตก Sub-Agent (${desc}) เพื่อแยกทำงานขนาน`,
      modifiedFile: null,
      isSubAgent: true,
    };
  }

  if (name === 'Bash') {
    const cmd = String(toolInput.command || '').trim();
    const isTestOrVerify =
      /\b(test|jest|vitest|mocha|pytest|playwright|cypress|lint|eslint|tsc|typecheck|check|verify|build|cargo\s+test|go\s+test)\b/i.test(
        cmd
      );
    const shortCmd = summarizeText(cmd, 70);
    return {
      stageIndex: isTestOrVerify ? 2 : 1,
      stageName: isTestOrVerify ? 'verify' : 'code',
      toolBadge: `Bash: ${shortCmd}`,
      tldr: isTestOrVerify
        ? `กำลังรันทดสอบ/ตรวจสอบระบบ: ${shortCmd}`
        : `กำลังรันคำสั่ง Terminal: ${shortCmd}`,
      modifiedFile: null,
    };
  }

  return {
    stageIndex: 1,
    stageName: 'code',
    toolBadge: name || 'Tool',
    tldr: `กำลังเรียกใช้งาน ${name}`,
    modifiedFile: null,
  };
}

module.exports = {
  getGitMetadata,
  getWorkspaceChangedFiles,
  getWorkspaceFileDetail,
  estimateClaudeCostUsd,
  getModelRates,
  getRecentBillableTokens,
  getContextWindowTokens,
  findTranscriptsForCwd,
  findLatestTranscriptForCwd,
  findTranscriptById,
  readConversationPage,
  encodeProjectDir,
  launchCwdFor,
  transcriptEntrypoint,
  isAutomatedEntrypoint,
  parseTranscriptTail,
  parseTranscriptTailUncached,
  clearCaches,
  summarizeText,
  inferWorkflowFromTool,
};
