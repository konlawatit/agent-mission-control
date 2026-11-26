/**
 * A room's context window use, read on request (GET /api/session/context), never pushed live.
 *
 * The context Claude carried into its last reply is the prompt side of that reply's usage:
 * input + cache creation + cache read tokens. Only a `.jsonl` transcript under
 * ~/.claude/projects is ever opened, and it is read backwards from the end in chunks.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getContextWindowTokens, findTranscriptById } = require('./transcript-parser');

const CHUNK_BYTES = 256 * 1024;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The room's transcript when it is a `.jsonl` file inside ~/.claude/projects, else null. */
function roomTranscript(session) {
  const projectsDir = path.resolve(os.homedir(), '.claude', 'projects') + path.sep;
  const candidates = [];
  if (session.transcriptPath) candidates.push(String(session.transcriptPath));
  if (session.claudeSessionId && UUID_RE.test(session.claudeSessionId)) {
    const found = findTranscriptById(session.claudeSessionId);
    if (found) candidates.push(found);
  }
  for (const candidate of candidates) {
    const file = path.resolve(candidate);
    if (!file.toLowerCase().startsWith(projectsDir.toLowerCase()) || !file.endsWith('.jsonl')) continue;
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

/** Context tokens of one transcript line, or null when it is not a main-thread reply with usage. */
function contextOf(line) {
  if (!line.includes('"usage"') || !line.includes('assistant')) return null;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || entry.isSidechain) return null;
  const msg = entry.message || entry;
  if ((msg.role || entry.type) !== 'assistant' || !msg.usage || typeof msg.usage !== 'object') return null;
  const u = msg.usage;
  const tokens =
    Number(u.input_tokens || 0) + Number(u.cache_creation_input_tokens || 0) + Number(u.cache_read_input_tokens || 0);
  if (!(tokens > 0)) return null; // synthetic replies (an API error, an interrupt) carry no usage
  return { tokens, model: typeof msg.model === 'string' ? msg.model : null, at: entry.timestamp || null };
}

/** The context at the last assistant reply in `file`, or null when there is none yet. */
function readLastContext(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    let end = size;
    let carry = Buffer.alloc(0);
    while (end > 0 && size - end < MAX_SCAN_BYTES) {
      const start = Math.max(0, end - CHUNK_BYTES);
      const chunk = Buffer.alloc(end - start);
      fs.readSync(fd, chunk, 0, chunk.length, start);
      end = start;
      const buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      // The part before the first newline may be the end of a line that starts in an earlier chunk.
      const firstNl = start > 0 ? buf.indexOf(0x0a) : -1;
      carry = firstNl >= 0 ? buf.subarray(0, firstNl) : start > 0 ? buf : Buffer.alloc(0);
      const body = start > 0 ? (firstNl >= 0 ? buf.subarray(firstNl + 1) : Buffer.alloc(0)) : buf;
      const lines = body.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const found = contextOf(lines[i]);
        if (found) return found;
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** What the context endpoint answers for a room. */
function sessionContext(session, now = Date.now()) {
  const file = roomTranscript(session);
  if (!file) return { ok: false, statusCode: 404, error: 'ไม่พบ transcript ของห้องนี้' };
  const last = readLastContext(file);
  const checkedAt = new Date(now).toISOString();
  if (!last) {
    return { ok: true, contextTokens: null, windowTokens: null, usedPct: null, model: null, messageAt: null, checkedAt };
  }
  const windowTokens = getContextWindowTokens(last.model || session.model);
  return {
    ok: true,
    contextTokens: last.tokens,
    windowTokens,
    usedPct: Math.min(100, Math.round((last.tokens / windowTokens) * 1000) / 10),
    model: last.model,
    messageAt: last.at,
    checkedAt,
  };
}

module.exports = { sessionContext, readLastContext, roomTranscript };
