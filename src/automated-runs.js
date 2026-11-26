'use strict';
/**
 * Automated Claude runs: `claude -p` and Agent SDK sessions (transcripts whose `entrypoint` is
 * `sdk-*`). They get no room in the dashboard on purpose; this module sums them up per working
 * folder so a job left running overnight can be judged at a glance: how many runs and when, the
 * tokens they used, which failed, and where nothing ran at all.
 *
 * Reading: every transcript under ~/.claude/projects modified inside the window is read forward
 * until the first message that names its entrypoint (at most a few MB per scan: a `claude -p`
 * prompt can be that large and the entrypoint is written after it; a file that names none yet is
 * asked again once it grows). Automated transcripts are then read on, only the bytes appended
 * since the previous scan, and each file's result is kept until its size or mtime changes. Reads
 * are async and a scan yields to the event loop between files and between chunks, so the server
 * keeps answering while a cold scan runs. Large bookkeeping records (`api-request-blob`,
 * attachments) are skipped without being buffered.
 *
 * When a run counts as failed (decided from real e2e-forge transcripts, Claude Code 2.1.3xx):
 * - ok          the last main-chain message is Claude's reply that ended the turn
 *               (stop_reason end_turn / stop_sequence) and is not an API error.
 * - api_error   the last assistant message is an API error (`isApiErrorMessage`, model
 *               "<synthetic>": "API Error: Server error mid-response", rate_limit, 403 …).
 * - interrupted the last prompt is "[Request interrupted by user…]".
 * - max_tokens, refusal, context_full
 *               the last reply stopped on that stop_reason (`max_tokens`, `refusal`,
 *               `model_context_window_exceeded`) and nothing followed it; its text is the detail.
 * - cut_off     the run stopped mid-work: the last entry is a tool call, a tool result or a
 *               prompt Claude never answered, and the run has been quiet for 20 minutes. In
 *               practice a `-p` run that hit "This command requires approval", or one its runner
 *               killed on a timeout. The last failed tool result, if any, is kept as the detail.
 * - no_reply    Claude never answered at all (e.g. a hook blocked the prompt); the hook's
 *               message is the detail.
 * A run that is not finished and was written to in the last 20 minutes (longer than the 10-minute
 * Bash limit) is "running", not failed. A sub-agent writes only its own transcript
 * (`<session>/subagents/*.jsonl`), so the newest write there counts as the run's activity too.
 * Failed tool calls (`tool_result.is_error`) do not fail a run, since Claude carries on after a
 * failed command all the time (most successful e2e-forge runs have several); they are counted.
 * Retried API errors (`system`/`api_error` entries) are counted too, not treated as failures.
 *
 * Tokens are "fresh" tokens (input + output + cache creation), as everywhere else in the
 * dashboard: cache reads are cheap against plan limits. Cache reads are reported separately.
 * Sub-agent transcripts (`<session>/subagents/*.jsonl`) are not added to their run.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { isAutomatedEntrypoint } = require('./transcript-parser');

const fsp = fs.promises;

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 7 * 24;
const HOUR_MS = 3600 * 1000;
const RUNNING_GRACE_MS = 20 * 60 * 1000;
const READ_CHUNK_BYTES = 1024 * 1024;
const ENTRYPOINT_CHUNK_BYTES = 128 * 1024; // most transcripts name their entrypoint in this much
const ENTRYPOINT_SCAN_BYTES = 4 * 1024 * 1024; // read per scan, at most, while looking for it
const DECIDE_BYTES = 160; // enough of a line to tell a bookkeeping record from a message
const RECENT_RUNS = 30;
const RESCAN_MIN_MS = 3000;
const PROMPT_CHARS = 160;
const DETAIL_CHARS = 200;
const RECENT_IDS = 16; // one API message is written as several entries, close together
const NEWLINE = 0x0a;
const INTERRUPTED_RE = /^\[Request interrupted by user/;
// Text Claude Code itself puts in a user message (slash commands, `!` shell, reminders, hook and
// background-task notes). Any other text is a prompt, even one that starts with a tag.
const HARNESS_TAG_RE =
  /^<(?:command-[a-z-]+|local-command-[a-z-]+|system-reminder|bash-(?:input|stdout|stderr)|user-prompt-submit-hook|task-notification|user-memory-input)>/;
// A reply that ended on one of these stop reasons, with nothing after it, failed for that reason.
const STOP_FAILURES = { max_tokens: 'max_tokens', refusal: 'refusal', model_context_window_exceeded: 'context_full' };
const STOPPED = new Set(Object.values(STOP_FAILURES));
const FINISHED = new Set(['ok', 'api_error', 'interrupted']);
// Records that start with `{"type":"…"` are read only for these types; the rest (api-request
// blobs and shapes, session owner, tool lists …) are skipped without being parsed.
const READ_TYPES = new Set(['user', 'assistant', 'system', 'cost-state', 'queue-operation']);

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

function hourFloor(ms) {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0); // local time: the hours the person reads on the clock
  return d.getTime();
}

function shortText(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function iso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

function folderName(cwd) {
  const parts = String(cwd || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(cwd || '');
}

/** Whether a line is worth parsing, judged from its first bytes. */
function wantLine(head) {
  const m = /^\{"type":"([^"]*)"/.exec(head);
  if (m) return READ_TYPES.has(m[1]);
  // Messages start with parentUuid/isSidechain; an attachment's payload follows right after.
  return !/^\{"parentUuid":[^,]*,"isSidechain":(?:true|false),"attachment":/.test(head);
}

function freshRun(file) {
  return {
    file,
    sessionId: path.basename(file, '.jsonl'),
    projectDir: path.basename(path.dirname(file)),
    size: 0,
    mtimeMs: 0,
    subagentMs: 0, // newest write to one of its sub-agents' transcripts
    offset: 0, // bytes consumed: always the start of a line
    entrypoint: null,
    cwd: null,
    firstAt: 0,
    lastAt: 0,
    model: null,
    firstPrompt: null,
    queuedPrompt: null,
    notice: null,
    tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    byHour: new Map(), // local hour start -> fresh tokens
    recentIds: [],
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    apiRetries: 0,
    costUsd: null,
    sawAssistant: false,
    end: 'none', // none | working | ok | api_error | interrupted
    endDetail: null,
    lastToolError: null,
  };
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function ingestAssistant(run, e, at) {
  const msg = e.message || {};
  const content = Array.isArray(msg.content) ? msg.content : [];
  const id = msg.id || e.uuid || null;
  const isNew = !id || !run.recentIds.includes(id);
  if (id && isNew) {
    run.recentIds.push(id);
    if (run.recentIds.length > RECENT_IDS) run.recentIds.shift();
  }
  const synthetic = msg.model === '<synthetic>';
  if (isNew) {
    const u = msg.usage;
    if (u && typeof u === 'object') {
      const input = Number(u.input_tokens) || 0;
      const output = Number(u.output_tokens) || 0;
      const create = Number(u.cache_creation_input_tokens) || 0;
      run.tokens.input += input;
      run.tokens.output += output;
      run.tokens.cacheCreate += create;
      run.tokens.cacheRead += Number(u.cache_read_input_tokens) || 0;
      const fresh = input + output + create;
      if (fresh && at) {
        const h = hourFloor(at);
        run.byHour.set(h, (run.byHour.get(h) || 0) + fresh);
      }
    }
    if (!synthetic) run.turns += 1;
  }
  if (msg.model && !synthetic) run.model = msg.model;
  for (const b of content) if (b && b.type === 'tool_use') run.toolCalls += 1;
  if (e.isSidechain) return;
  run.sawAssistant = true;
  if (e.isApiErrorMessage) {
    run.end = 'api_error';
    run.endDetail = shortText(blockText(content) || e.error || 'API error', DETAIL_CHARS);
  } else if (msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop_sequence') {
    run.end = 'ok';
    run.endDetail = null;
  } else if (Object.prototype.hasOwnProperty.call(STOP_FAILURES, msg.stop_reason)) {
    run.end = STOP_FAILURES[msg.stop_reason];
    run.endDetail = shortText(blockText(content), DETAIL_CHARS) || null;
  } else {
    run.end = 'working'; // a tool call (or a streamed part) that Claude still has to follow up
  }
}

function ingestUser(run, e) {
  if (e.isSidechain || e.isMeta || e.isCompactSummary) return;
  const content = (e.message || {}).content;
  if (Array.isArray(content)) {
    const results = content.filter((b) => b && b.type === 'tool_result');
    if (results.length) {
      run.end = 'working'; // Claude has to answer the tool results
      const failed = results.filter((b) => b.is_error);
      run.toolErrors += failed.length;
      run.lastToolError = failed.length
        ? shortText(blockText(failed[failed.length - 1].content) || 'tool error', DETAIL_CHARS)
        : null;
    }
  }
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
      ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text)
      : [];
  for (const raw of texts) {
    const text = String(raw).trim();
    if (!text || HARNESS_TAG_RE.test(text)) continue; // local commands, reminders, hook notes
    if (INTERRUPTED_RE.test(text)) {
      run.end = 'interrupted';
      continue;
    }
    if (!run.firstPrompt) run.firstPrompt = shortText(text, PROMPT_CHARS);
    run.end = 'working';
    run.lastToolError = null;
  }
}

function ingestLine(run, line) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  if (!e || typeof e !== 'object') return;
  const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) || 0 : 0;
  if (at) {
    if (!run.firstAt || at < run.firstAt) run.firstAt = at;
    if (at > run.lastAt) run.lastAt = at;
  }
  if (!run.cwd && typeof e.cwd === 'string' && e.cwd) run.cwd = e.cwd;
  if (!run.entrypoint && typeof e.entrypoint === 'string') run.entrypoint = e.entrypoint;
  switch (e.type) {
    case 'assistant':
      return ingestAssistant(run, e, at);
    case 'user':
      return ingestUser(run, e);
    case 'system':
      if (e.subtype === 'api_error') run.apiRetries += 1;
      else if (e.subtype === 'informational' && (e.level === 'warning' || e.level === 'error') && typeof e.content === 'string') {
        run.notice = shortText(e.content, DETAIL_CHARS);
      }
      return;
    case 'cost-state':
      if (Number.isFinite(Number(e.totalCostUSD))) run.costUsd = Number(e.totalCostUSD);
      return;
    case 'queue-operation':
      // The prompt as handed to `claude -p`; kept in case no user message follows (hook block).
      if (e.operation === 'enqueue' && !run.queuedPrompt && typeof e.content === 'string' && e.content.trim() && !HARNESS_TAG_RE.test(e.content.trim())) {
        run.queuedPrompt = shortText(e.content, PROMPT_CHARS);
      }
      return;
    default:
  }
}

/**
 * Reads whole lines appended after `run.offset`, up to `size`; a partial last line waits.
 * Reading also ends once `stop()` is true after a line, or at the first line end past `maxBytes`
 * (a line is always read to its end, so a huge one cannot stall it). Returns true when every
 * complete line up to `size` was read.
 */
async function readAppended(run, size, stats, { maxBytes = Infinity, chunkBytes = READ_CHUNK_BYTES, stop = null } = {}) {
  const fh = await fsp.open(run.file, 'r');
  const from = run.offset;
  try {
    let pos = run.offset;
    let parts = [];
    let partLen = 0;
    let mode = 0; // 0 undecided, 1 keep, 2 skip
    while (pos < size) {
      const len = Math.min(chunkBytes, size - pos);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (bytesRead <= 0) break;
      const chunk = bytesRead === len ? buf : buf.subarray(0, bytesRead);
      stats.bytesRead += bytesRead;
      let p = 0;
      while (p < chunk.length) {
        const nl = chunk.indexOf(NEWLINE, p);
        const end = nl === -1 ? chunk.length : nl;
        if (mode !== 2 && end > p) {
          parts.push(chunk.subarray(p, end));
          partLen += end - p;
        }
        if (mode === 0 && (partLen >= DECIDE_BYTES || nl !== -1)) {
          const headBuf = parts.length === 1 ? parts[0] : Buffer.concat(parts, partLen);
          mode = wantLine(headBuf.toString('utf8', 0, Math.min(partLen, DECIDE_BYTES))) ? 1 : 2;
          if (mode === 2) {
            parts = [];
            partLen = 0;
          }
        }
        if (nl === -1) break;
        if (mode === 1 && partLen) {
          ingestLine(run, (parts.length === 1 ? parts[0] : Buffer.concat(parts, partLen)).toString('utf8'));
        }
        parts = [];
        partLen = 0;
        mode = 0;
        p = nl + 1;
        run.offset = pos + p;
        if ((stop && stop()) || run.offset - from >= maxBytes) return false;
      }
      pos += bytesRead;
      await yieldToLoop();
    }
    return true;
  } finally {
    await fh.close();
  }
}

/** When one of the session's sub-agents last wrote its transcript (0 when it has none). */
async function newestSubagentWrite(file) {
  const sessionDir = file.slice(0, -'.jsonl'.length);
  const dir = path.join(sessionDir, 'subagents');
  let newest = 0;
  try {
    // Real folders only: never follow a link out of ~/.claude/projects.
    if (!(await fsp.lstat(sessionDir)).isDirectory() || !(await fsp.lstat(dir)).isDirectory()) return 0;
    for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
      if (!d.isFile() || !d.name.endsWith('.jsonl')) continue;
      const st = await fsp.lstat(path.join(dir, d.name));
      if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
    }
  } catch {
    // No sub-agents, or one removed mid-listing: what was seen so far stands.
  }
  return newest;
}

function runStatus(run, now) {
  if (run.end === 'ok') return { status: 'ok', reason: null, detail: null };
  if (run.end === 'api_error') return { status: 'failed', reason: 'api_error', detail: run.endDetail };
  if (run.end === 'interrupted') return { status: 'failed', reason: 'interrupted', detail: null };
  if (now - Math.max(run.mtimeMs, run.subagentMs) < RUNNING_GRACE_MS) return { status: 'running', reason: null, detail: null };
  if (STOPPED.has(run.end)) return { status: 'failed', reason: run.end, detail: run.endDetail };
  if (!run.sawAssistant) return { status: 'failed', reason: 'no_reply', detail: run.notice };
  return { status: 'failed', reason: 'cut_off', detail: run.lastToolError };
}

function publicRun(run, now) {
  const startMs = run.firstAt || run.mtimeMs;
  const endMs = Math.max(run.lastAt || run.mtimeMs, startMs);
  const t = run.tokens;
  return {
    sessionId: run.sessionId,
    folder: folderName(run.cwd || run.projectDir),
    cwd: run.cwd,
    entrypoint: run.entrypoint,
    startedAt: iso(startMs),
    endedAt: iso(endMs),
    durationMs: endMs - startMs,
    model: run.model,
    tokens: t.input + t.output + t.cacheCreate,
    cacheReadTokens: t.cacheRead,
    costUsd: run.costUsd,
    turns: run.turns,
    toolCalls: run.toolCalls,
    toolErrors: run.toolErrors,
    apiRetries: run.apiRetries,
    ...runStatus(run, now),
    firstPrompt: run.firstPrompt || run.queuedPrompt || null,
  };
}

/** Busy intervals merged, then the longest gap between them that lies inside the window. */
function idleGaps(intervals, windowStart) {
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  let longest = null;
  for (let i = 1; i < merged.length; i++) {
    const from = Math.max(merged[i - 1][1], windowStart);
    const to = merged[i][0];
    if (to > from && (!longest || to - from > longest.to - longest.from)) longest = { from, to };
  }
  return { merged, longest };
}

/**
 * The per-folder summary of every cached run active inside the window: the last `hours` local
 * hours, the current one included, which are exactly the chart's bars. Counts, failures and
 * tokens are those of the bars, so the totals always add up to what the chart shows.
 */
function summarize(runs, { hours, now }) {
  const firstHour = hourFloor(now) - (hours - 1) * HOUR_MS;
  const windowStart = firstHour;
  const groups = new Map();
  for (const run of runs) {
    const view = publicRun(run, now);
    const start = Date.parse(view.startedAt);
    const end = view.status === 'running' ? now : Date.parse(view.endedAt);
    if (end < windowStart) continue;
    const cwd = run.cwd || null;
    const key = (cwd || run.projectDir).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
    if (!groups.has(key)) groups.set(key, { key, folder: view.folder, cwd, items: [] });
    groups.get(key).items.push({ run, view, start, end });
  }

  const out = [];
  for (const g of groups.values()) {
    const hourly = [];
    for (let i = 0; i < hours; i++) {
      hourly.push({ hourStart: iso(firstHour + i * HOUR_MS), runs: 0, tokens: 0, failed: 0, activeMinutes: 0 });
    }
    const slot = (ms) => {
      const i = Math.floor((ms - firstHour) / HOUR_MS);
      return i >= 0 && i < hours ? hourly[i] : null;
    };
    const intervals = [];
    let failed = 0;
    let running = 0;
    let tokens = 0;
    let lastRunAt = 0;
    for (const { run, view, start, end } of g.items) {
      intervals.push([start, end]);
      if (view.status === 'failed') failed += 1;
      if (view.status === 'running') running += 1;
      lastRunAt = Math.max(lastRunAt, end);
      // A run that began before the window still going in it counts in the first bar.
      const h = slot(Math.min(Math.max(start, windowStart), now));
      if (h) {
        h.runs += 1;
        if (view.status === 'failed') h.failed += 1;
      }
      for (const [hourStart, n] of run.byHour) {
        const hs = slot(hourStart);
        if (!hs) continue; // spent before the window
        hs.tokens += n;
        tokens += n;
      }
    }
    const { merged, longest } = idleGaps(intervals, windowStart);
    for (const [s, e] of merged) {
      for (let i = Math.max(0, Math.floor((s - firstHour) / HOUR_MS)); i < hours; i++) {
        const hs = firstHour + i * HOUR_MS;
        if (hs >= e) break;
        const overlap = Math.min(e, hs + HOUR_MS) - Math.max(s, hs);
        if (overlap > 0) hourly[i].activeMinutes = Math.min(60, hourly[i].activeMinutes + overlap / 60000);
      }
    }
    for (const h of hourly) h.activeMinutes = Math.round(h.activeMinutes);
    const recent = g.items
      .map((x) => x.view)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    out.push({
      key: g.key,
      folder: g.folder,
      cwd: g.cwd,
      runs: g.items.length,
      failed,
      running,
      tokens,
      lastRunAt: iso(lastRunAt),
      hourly,
      longestIdleMinutes: longest ? Math.floor((longest.to - longest.from) / 60000) : 0,
      longestIdle: longest ? { from: iso(longest.from), to: iso(longest.to) } : null,
      idleSinceMinutes: running ? 0 : Math.max(0, Math.floor((now - lastRunAt) / 60000)),
      recent: recent.slice(0, RECENT_RUNS),
    });
  }
  out.sort((a, b) => String(b.lastRunAt).localeCompare(String(a.lastRunAt)));
  const totals = { groups: out.length, runs: 0, failed: 0, running: 0, tokens: 0 };
  for (const g of out) {
    totals.runs += g.runs;
    totals.failed += g.failed;
    totals.running += g.running;
    totals.tokens += g.tokens;
  }
  return { generatedAt: iso(now), windowHours: hours, windowStart: iso(windowStart), groups: out, totals };
}

class AutomatedRuns {
  /**
   * @param {object} [options]
   * @param {string} [options.projectsDir] where Claude Code keeps transcripts (default ~/.claude/projects)
   * @param {number} [options.rescanMinMs] a request within this long after a scan reuses it
   */
  constructor({ projectsDir = null, rescanMinMs = RESCAN_MIN_MS } = {}) {
    this.projectsDir = projectsDir;
    this.rescanMinMs = rescanMinMs;
    this.runs = new Map(); // transcript path -> run state (automated transcripts only)
    this.pending = new Map(); // transcript path -> run state of one that has not named its entrypoint yet
    this.skipped = new Map(); // transcript path -> entrypoint of a session that is not automated
    this.inflight = null; // { hours, promise }
    this.lastScan = null; // { hours, at, stats }
  }

  dir() {
    return this.projectsDir || path.join(os.homedir(), '.claude', 'projects');
  }

  /** The summary for the last `hours`, after bringing the cache up to date. */
  async summary({ hours = DEFAULT_WINDOW_HOURS, now = null } = {}) {
    const h = Math.max(1, Math.min(MAX_WINDOW_HOURS, Math.floor(Number(hours) || DEFAULT_WINDOW_HOURS)));
    const stats = await this.refresh(h);
    const result = summarize(this.runs.values(), { hours: h, now: now === null ? Date.now() : now });
    return { ...result, scan: stats };
  }

  /** Scans for the last `hours` unless a scan covering them is running or has just finished. */
  refresh(hours) {
    const last = this.lastScan;
    if (last && last.hours >= hours && Date.now() - last.at < this.rescanMinMs) {
      return Promise.resolve({ ...last.stats, reused: true });
    }
    if (this.inflight) {
      if (this.inflight.hours >= hours) return this.inflight.promise;
      return this.inflight.promise.catch(() => {}).then(() => this.refresh(hours));
    }
    const promise = this.scan(hours).finally(() => {
      if (this.inflight && this.inflight.promise === promise) this.inflight = null;
    });
    this.inflight = { hours, promise };
    return promise;
  }

  async scan(hours) {
    const started = Date.now();
    const since = started - hours * HOUR_MS;
    const stats = { files: 0, automated: 0, filesRead: 0, bytesRead: 0, ms: 0 };
    const seen = new Map(); // transcript path -> mtime
    let dirs = [];
    try {
      dirs = await fsp.readdir(this.dir(), { withFileTypes: true });
    } catch {
      dirs = [];
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(this.dir(), d.name);
      let names = [];
      try {
        names = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        let st;
        try {
          st = await fsp.lstat(file);
        } catch {
          continue;
        }
        if (!st.isFile()) continue; // never follow a link out of ~/.claude/projects
        seen.set(file, st.mtimeMs);
        if (st.mtimeMs < since) continue;
        stats.files += 1;
        if (this.skipped.has(file)) continue;
        try {
          await this.update(file, st, stats);
        } catch {
          // Unreadable right now (locked, removed mid-scan); the next scan tries again.
        }
      }
      await yieldToLoop();
    }
    // Forget files that are gone or older than the largest window.
    const oldest = started - (MAX_WINDOW_HOURS + 1) * HOUR_MS;
    for (const map of [this.runs, this.pending, this.skipped]) {
      for (const file of map.keys()) if (!(seen.get(file) >= oldest)) map.delete(file);
    }
    stats.ms = Date.now() - started;
    this.lastScan = { hours, at: Date.now(), stats };
    return stats;
  }

  async update(file, st, stats) {
    const known = this.runs.has(file);
    const map = known ? this.runs : this.pending;
    let run = map.get(file);
    if (run && st.size === run.size && st.mtimeMs === run.mtimeMs) {
      // Unchanged: cache hit.
      if (known) {
        stats.automated += 1;
        await this.checkSubagents(run);
      }
      return;
    }
    if (!run || st.size < run.offset) {
      run = freshRun(file); // new, or rewritten shorter: start over
      map.set(file, run);
    }
    if (!known) {
      // Read until a message names the entrypoint; what was read already counts for the run.
      stats.filesRead += 1;
      const complete = await readAppended(run, st.size, stats, {
        chunkBytes: ENTRYPOINT_CHUNK_BYTES,
        maxBytes: ENTRYPOINT_SCAN_BYTES,
        stop: () => Boolean(run.entrypoint),
      });
      if (!run.entrypoint) {
        // Not named yet: carry on from here next scan, or once it grows when all of it was read.
        if (complete) {
          run.size = st.size;
          run.mtimeMs = st.mtimeMs;
        }
        return;
      }
      this.pending.delete(file);
      if (!isAutomatedEntrypoint(run.entrypoint)) {
        this.skipped.set(file, run.entrypoint);
        return;
      }
      this.runs.set(file, run);
    }
    stats.automated += 1;
    if (st.size > run.offset) {
      if (known) stats.filesRead += 1;
      await readAppended(run, st.size, stats);
    }
    run.size = st.size;
    run.mtimeMs = st.mtimeMs;
    await this.checkSubagents(run);
  }

  /** A run waiting on a sub-agent writes nothing itself; the sub-agent's transcript shows it is alive. */
  async checkSubagents(run) {
    if (FINISHED.has(run.end) || Date.now() - run.mtimeMs < RUNNING_GRACE_MS) return;
    run.subagentMs = await newestSubagentWrite(run.file);
  }
}

module.exports = {
  AutomatedRuns,
  summarize,
  DEFAULT_WINDOW_HOURS,
  MAX_WINDOW_HOURS,
  RUNNING_GRACE_MS,
};
