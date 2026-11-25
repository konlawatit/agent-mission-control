const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

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

function scanTranscriptsForCwd(cwd) {
  if (!cwd) return [];
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return [];

    const normCwd = String(cwd)
      .split('>')[0]
      .trim()
      .replace(/[\\\/]+$/, '');
    const expectedSlug = normCwd.replace(/[:\\\/\s_]+/g, '-').toLowerCase();
    const folderBase = path
      .basename(normCwd)
      .replace(/[\s_]+/g, '-')
      .toLowerCase();

    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    const matchedFiles = [];

    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dNameLower = d.name.toLowerCase();
      if (
        dNameLower === expectedSlug ||
        dNameLower.endsWith(folderBase) ||
        dNameLower.includes(folderBase)
      ) {
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

    for (const filePath of filesToRead) {
      if (!fs.existsSync(filePath)) continue;
      const stat = fs.statSync(filePath);
      const maxBytes = 256 * 1024;
      const start = Math.max(0, stat.size - maxBytes);
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);

      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buffer, 0, length, start);
      fs.closeSync(fd);

      const raw = buffer.toString('utf8');
      const lines = raw
        .split(/\r?\n/)
        .filter((line) => line.trim().startsWith('{'));

      for (const line of lines) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

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
          const clean = text.trim();
          if (!clean || clean.startsWith('<')) return;
          lastUserText = clean;
          conversationLines.push(`🧑 คุณ: ${clean}`);

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
              conversationLines.push(`🤖 Claude:\n${clean}`);
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
                conversationLines.push(
                  `🔧 [Tool: ${block.name}] ${summarizeText(fileOrCmd, 100)}`
                );
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

    const recentLog = conversationLines.slice(-30).join('\n\n');

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
  parseTranscriptTail,
  parseTranscriptTailUncached,
  clearCaches,
  summarizeText,
  inferWorkflowFromTool,
};
