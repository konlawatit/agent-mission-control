'use strict';

/**
 * Search across every Claude session (roadmap item 2).
 *
 * An in-memory index of what the dashboard shows of each transcript under ~/.claude/projects:
 * the person's prompts, Claude's replies and tool lines (displayLinesFor), one joined string per
 * session plus where each line starts and which transcript entry (byte offset) it came from, so a
 * result opens the viewer at that entry.
 *
 * Transcripts are append-only and mostly bookkeeping (request copies of many MB), so:
 * - each file is read once, from where the last pass stopped (only the appended bytes on rescans),
 *   with async reads in 1 MB chunks;
 * - lines that announce a non-conversation type up front (`{"type":"api-request-blob",…`) are
 *   skipped without being decoded or parsed;
 * - parsing runs in slices of a few milliseconds with a setImmediate between them, so the server
 *   keeps answering hooks and the dashboard while the index builds.
 *
 * Only regular `<uuid>.jsonl` files directly inside a project folder are read (sub-agent
 * transcripts in `<session>/subagents/` are part of their parent session and cannot be opened by
 * id). Nothing is written anywhere: a full build takes seconds, so the index is rebuilt on start.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  parseConversationLine,
  displayLinesFor,
  isAutomatedEntrypoint,
  launchCwdFor,
  summarizeText,
} = require('./transcript-parser');

const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const SEP = '\u0000'; // between lines of a session's text; a query never contains it
const NEWLINE = 0x0a;
const QUOTE = 0x22;
const TYPE_PREFIX = Buffer.from('{"type":"');

const DEFAULTS = {
  sliceMs: 8, // longest stretch of parsing before giving the event loop a turn
  chunkBytes: 1024 * 1024,
  startDelayMs: 3000, // let the server finish starting before the first build
  rescanMs: 45 * 1000, // look for new and grown transcripts this often
  kickMinMs: 10 * 1000, // a search re-checks the files when the last pass is older than this
  maxLineChars: 4000, // a longer reply is indexed up to here (99.6% of real lines are shorter)
  maxTotalChars: 32 * 1000 * 1000, // ~64 MB worst case (UTF-16); oldest sessions give way first
};

const MAX_COUNT_PER_SESSION = 1000; // matches counted per session; enough to rank, bounded work
const MAX_HIT_LINES = 200; // distinct matching lines remembered per session for snippets
const SNIPPETS_PER_SESSION = 3;
const SNIPPET_BEFORE = 70;
const SNIPPET_AFTER = 110;
const MATCH_BONUS_MS = 6 * 3600 * 1000; // each doubling of matches counts like 6 hours of recency

const USER_PREFIX = '🧑 คุณ: ';
const CLAUDE_PREFIX = '🤖 Claude:\n';
const TOOL_RE = /^🔧 \[Tool: ([^\]]*)\] ?/;

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/** [role, text] of a display line: 'u' the person, 'a' Claude, 't' a tool call. */
function splitDisplayLine(line) {
  if (line.startsWith(USER_PREFIX)) return ['u', line.slice(USER_PREFIX.length)];
  if (line.startsWith(CLAUDE_PREFIX)) return ['a', line.slice(CLAUDE_PREFIX.length)];
  const m = TOOL_RE.exec(line);
  if (m) return ['t', `${m[1]} ${line.slice(m[0].length)}`.trim()];
  return null; // the "stopped" divider and anything else carries nothing to search
}

/** A line that names a bookkeeping type first (`{"type":"api-request-blob",…`) needs no parsing. */
function isBookkeepingLine(buf, start, end) {
  if (end - start <= TYPE_PREFIX.length) return false;
  for (let i = 0; i < TYPE_PREFIX.length; i++) {
    if (buf[start + i] !== TYPE_PREFIX[i]) return false;
  }
  const from = start + TYPE_PREFIX.length;
  const quote = buf.indexOf(QUOTE, from);
  if (quote === -1 || quote >= end || quote - from > 48) return false;
  const type = buf.toString('latin1', from, quote);
  return type !== 'user' && type !== 'assistant';
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Index of the last line starting at or before `pos`. */
function lineAt(starts, pos) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Keeps a cut from splitting a surrogate pair (emoji) in half. */
function safeCut(text, i) {
  const c = text.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff ? i - 1 : i;
}

/**
 * Text around a match, whitespace collapsed, with where the match sits in it. In prose (`plain`)
 * the Markdown markers around the match (`code`, **bold**) are dropped; commands keep theirs.
 */
function snippetFor(line, at, len, { plain = false } = {}) {
  const start = Math.max(0, safeCut(line, Math.max(0, at - SNIPPET_BEFORE)));
  const end = Math.min(line.length, safeCut(line, Math.min(line.length, at + len + SNIPPET_AFTER)));
  const squash = (s) => (plain ? s.replace(/`+|\*\*/g, '') : s).replace(/\s+/g, ' ');
  let before = squash(line.slice(start, at));
  const match = line.slice(at, at + len).replace(/\s+/g, ' ');
  let after = squash(line.slice(at + len, end));
  if (start === 0) before = before.replace(/^ /, '');
  if (end === line.length) after = after.replace(/ $/, '');
  const pre = start > 0 ? '…' : '';
  const post = end < line.length ? '…' : '';
  return { text: pre + before + match + after + post, hl: [pre.length + before.length, match.length] };
}

function folderName(cwd) {
  return String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

class SearchIndex {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.projectsDir = path.resolve(options.projectsDir || path.join(os.homedir(), '.claude', 'projects'));
    this.recs = new Map(); // file -> record
    this.totalChars = 0;
    this.totalLines = 0;
    this.total = 0; // transcripts found by the last listing
    this.done = false; // the first full pass has finished
    this.started = false;
    this.stopped = false;
    this.scanning = null; // promise of the pass in progress
    this.timer = null;
    this.lastScanEnd = 0;
    this.buildMs = null;
    this.sliceStart = 0;
  }

  /** Builds in the background after `delayMs`, then keeps the index current. Idempotent. */
  start({ delayMs = this.opts.startDelayMs } = {}) {
    if (this.started || this.stopped) return;
    this.started = true;
    this._schedule(delayMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** A search asks for fresh results: start now, or re-check files if the last pass is stale. */
  kick() {
    if (this.stopped) return;
    if (!this.started) return this.start({ delayMs: 0 });
    if (!this.scanning && Date.now() - this.lastScanEnd >= this.opts.kickMinMs) this._schedule(0);
  }

  /** One full pass now (or the one in progress). Resolves when it has finished. */
  scanNow() {
    if (this.scanning) return this.scanning;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.started = true;
    this.scanning = this._scan()
      .catch(() => {})
      .finally(() => {
        this.scanning = null;
        this.lastScanEnd = Date.now();
        if (!this.stopped) this._schedule(this.opts.rescanMs);
      });
    return this.scanning;
  }

  _schedule(ms) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scanNow();
    }, ms);
    if (this.timer.unref) this.timer.unref();
  }

  status() {
    let files = 0;
    let skipped = 0;
    for (const rec of this.recs.values()) {
      if (rec.indexed) files += 1;
      if (rec.skipped) skipped += 1;
    }
    return {
      done: this.done,
      building: Boolean(this.scanning),
      files,
      total: this.total,
      lines: this.totalLines,
      chars: this.totalChars,
      approxMB: Math.round((this.totalChars * 2) / 1e5) / 10, // UTF-16 upper bound
      skipped,
      buildMs: this.buildMs,
    };
  }

  /* ---------- Listing ---------- */

  async _listFiles() {
    let dirs;
    try {
      dirs = await fs.promises.readdir(this.projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const d of dirs) {
      if (this.stopped) break;
      if (!d.isDirectory()) continue;
      const dir = path.join(this.projectsDir, d.name);
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      // Only regular files named like a session; links are never followed out of the folder.
      const names = entries.filter((e) => e.isFile() && SESSION_FILE_RE.test(e.name)).map((e) => e.name);
      const stats = await Promise.all(
        names.map((name) => fs.promises.lstat(path.join(dir, name)).catch(() => null))
      );
      names.forEach((name, i) => {
        const st = stats[i];
        if (!st || !st.isFile()) return;
        out.push({
          file: path.join(dir, name),
          sessionId: name.slice(0, -'.jsonl'.length),
          projectDir: d.name,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      });
    }
    return out;
  }

  /* ---------- Building ---------- */

  async _scan() {
    const t0 = Date.now();
    this.sliceStart = performance.now();
    const found = await this._listFiles();
    if (this.stopped) return;
    const present = new Set(found.map((f) => f.file));
    for (const [file, rec] of this.recs) {
      if (!present.has(file)) {
        this._dropText(rec);
        this.recs.delete(file);
      }
    }
    this.total = found.length;
    // Newest first: the sessions most likely to be looked for become searchable first.
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const f of found) {
      if (this.stopped) return;
      let rec = this.recs.get(f.file);
      if (rec && f.size < rec.offset) {
        // Rewritten rather than appended to: read it again from the start.
        this._dropText(rec);
        rec = null;
      }
      if (!rec) {
        rec = this._newRecord(f);
        this.recs.set(f.file, rec);
      }
      rec.mtimeMs = f.mtimeMs;
      rec.size = f.size;
      if (rec.skipped) continue;
      if (f.size > rec.offset) {
        if (!rec.lineCount && this.totalChars >= this.opts.maxTotalChars) {
          rec.skipped = true; // over the memory budget: older sessions stay out
          continue;
        }
        try {
          await this._indexFile(rec, f.size);
        } catch {
          // Unreadable right now (deleted, locked): the next pass continues from rec.offset.
        }
        this._enforceBudget(rec);
      }
      rec.indexed = true;
    }
    if (!this.done) {
      this.done = true;
      this.buildMs = Date.now() - t0;
    }
  }

  _newRecord(f) {
    return {
      file: f.file,
      sessionId: f.sessionId,
      projectDir: f.projectDir,
      size: f.size,
      mtimeMs: f.mtimeMs,
      offset: 0, // bytes read so far, always at a line start
      cwd: null,
      entrypoint: null,
      startedAt: null,
      title: '',
      text: '', // every indexed line, joined with SEP
      starts: [], // where each line starts in `text`
      roles: [], // 'u' | 'a' | 't' per line
      offs: [], // byte offset of the transcript entry each line came from
      lineCount: 0,
      indexed: false,
      skipped: false,
    };
  }

  async _indexFile(rec, size) {
    const fh = await fs.promises.open(rec.file, 'r');
    const batch = { roles: [], offs: [], texts: [], end: rec.offset };
    try {
      let pos = rec.offset; // next byte to read
      let lineStart = rec.offset; // first byte of the line being assembled
      let carry = []; // pieces of a line that started in an earlier chunk
      while (pos < size && !this.stopped) {
        const len = Math.min(this.opts.chunkBytes, size - pos);
        const chunk = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(chunk, 0, len, pos);
        if (!bytesRead) break;
        const fresh = chunk.subarray(0, bytesRead);
        pos += bytesRead;
        if (carry.length && fresh.indexOf(NEWLINE) === -1) {
          carry.push(fresh); // still inside one long line (a request copy can be megabytes)
          continue;
        }
        const data = carry.length ? Buffer.concat([...carry, fresh]) : fresh;
        const dataStart = lineStart;
        carry = [];
        let p = 0;
        for (;;) {
          const nl = data.indexOf(NEWLINE, p);
          if (nl === -1) break;
          this._ingestLine(rec, data, p, nl, dataStart + p, batch);
          p = nl + 1;
          lineStart = dataStart + p;
          batch.end = lineStart;
          if (performance.now() - this.sliceStart >= this.opts.sliceMs) {
            this._commit(rec, batch);
            await yieldToLoop();
            this.sliceStart = performance.now();
            if (this.stopped) return;
          }
        }
        // A line without its newline yet is being written: it is read again next pass.
        if (p < data.length) carry.push(data.subarray(p));
      }
      this._commit(rec, batch);
    } finally {
      await fh.close().catch(() => {});
    }
  }

  _ingestLine(rec, buf, start, end, entryOffset, batch) {
    if (end - start < 2 || isBookkeepingLine(buf, start, end)) return;
    const entry = parseConversationLine(buf.toString('utf8', start, end));
    if (!entry) return;
    if (!rec.entrypoint && typeof entry.entrypoint === 'string') rec.entrypoint = entry.entrypoint;
    if (!rec.cwd && typeof entry.cwd === 'string') rec.cwd = launchCwdFor(entry.cwd, rec.file) || entry.cwd;
    if (!rec.startedAt && typeof entry.timestamp === 'string') rec.startedAt = entry.timestamp;
    for (const line of displayLinesFor(entry)) {
      const parts = splitDisplayLine(line);
      if (!parts) continue;
      let text = parts[1].replace(/\u0000/g, ' ');
      if (!text) continue;
      if (text.length > this.opts.maxLineChars) text = text.slice(0, safeCut(text, this.opts.maxLineChars));
      if (!rec.title && parts[0] === 'u') rec.title = summarizeText(text, 90);
      batch.roles.push(parts[0]);
      batch.offs.push(entryOffset);
      batch.texts.push(text);
    }
  }

  /** Makes a batch of lines searchable and moves the record's read position past them. */
  _commit(rec, batch) {
    const n = batch.texts.length;
    if (n) {
      const joined = batch.texts.join(SEP); // a fresh flat string: no slices of parsed JSON kept alive
      const before = rec.text.length;
      let at = before ? before + 1 : 0;
      rec.text = before ? rec.text + SEP + joined : joined;
      for (let i = 0; i < n; i++) {
        rec.starts.push(at);
        rec.roles.push(batch.roles[i]);
        rec.offs.push(batch.offs[i]);
        at += batch.texts[i].length + 1;
      }
      rec.lineCount += n;
      this.totalChars += rec.text.length - before;
      this.totalLines += n;
      batch.roles = [];
      batch.offs = [];
      batch.texts = [];
    }
    rec.offset = batch.end;
  }

  _dropText(rec) {
    this.totalChars -= rec.text.length;
    this.totalLines -= rec.lineCount;
    rec.text = '';
    rec.starts = [];
    rec.roles = [];
    rec.offs = [];
    rec.lineCount = 0;
    rec.offset = 0;
    rec.title = '';
  }

  /** Over budget after a session grew: the least recently used other sessions give way. */
  _enforceBudget(current) {
    while (this.totalChars > this.opts.maxTotalChars) {
      let oldest = null;
      for (const rec of this.recs.values()) {
        if (rec === current || !rec.lineCount) continue;
        if (!oldest || rec.mtimeMs < oldest.mtimeMs) oldest = rec;
      }
      if (!oldest) break;
      this._dropText(oldest);
      oldest.skipped = true;
    }
  }

  /* ---------- Searching ---------- */

  /**
   * Sessions whose shown text contains `q` (case-insensitive substring, so Thai needs no word
   * splitting), most recent first with a small lift for more matches.
   * scope: 'people' (started in a terminal or app), 'automated' (`claude -p`, the SDK) or 'all'.
   */
  search(q, { scope = 'people', limit = 20 } = {}) {
    const t0 = performance.now();
    const needle = String(q || '');
    const re = new RegExp(escapeRegExp(needle), 'gi');
    const hits = [];
    for (const rec of this.recs.values()) {
      if (!rec.lineCount) continue;
      const automated = isAutomatedEntrypoint(rec.entrypoint);
      if (scope === 'people' && automated) continue;
      if (scope === 'automated' && !automated) continue;
      re.lastIndex = 0;
      let count = 0;
      let last = -1;
      const lines = [];
      let m;
      while ((m = re.exec(rec.text)) !== null) {
        count += 1;
        if (lines.length < MAX_HIT_LINES) {
          const li = lineAt(rec.starts, m.index);
          if (li !== last) {
            lines.push({ li, at: m.index - rec.starts[li], len: m[0].length });
            last = li;
          }
        }
        if (count >= MAX_COUNT_PER_SESSION) break;
      }
      if (count) hits.push({ rec, count, lines, automated });
    }
    const score = (h) => h.rec.mtimeMs + Math.log2(1 + h.count) * MATCH_BONUS_MS;
    hits.sort((a, b) => score(b) - score(a));
    const results = hits.slice(0, limit).map((h) => this._result(h));
    return {
      q: needle,
      scope,
      total: hits.length,
      results,
      tookMs: Math.round((performance.now() - t0) * 10) / 10,
      indexing: this.status(),
    };
  }

  _result({ rec, count, lines, automated }) {
    // Up to three matching lines, spread over the session (first, middle, last).
    const picks =
      lines.length <= SNIPPETS_PER_SESSION
        ? lines
        : [lines[0], lines[Math.floor((lines.length - 1) / 2)], lines[lines.length - 1]];
    const snippets = picks.map(({ li, at, len }) => {
      const start = rec.starts[li];
      const end = li + 1 < rec.starts.length ? rec.starts[li + 1] - 1 : rec.text.length;
      const line = rec.text.slice(start, end);
      const role = rec.roles[li];
      return { role, offset: rec.offs[li], ...snippetFor(line, at, len, { plain: role !== 't' }) };
    });
    return {
      sessionId: rec.sessionId,
      title: rec.title || folderName(rec.cwd) || rec.projectDir,
      project: folderName(rec.cwd) || rec.projectDir,
      projectDir: rec.projectDir,
      cwd: rec.cwd,
      entrypoint: rec.entrypoint,
      automated,
      startedAt: rec.startedAt,
      modifiedAt: new Date(rec.mtimeMs).toISOString(),
      matchCount: count,
      moreMatches: count >= MAX_COUNT_PER_SESSION,
      snippets,
    };
  }
}

module.exports = { SearchIndex, splitDisplayLine, isBookkeepingLine, snippetFor };
