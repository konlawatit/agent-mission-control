const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Claude Code keeps one `<pid>.json` per running session in ~/.claude/sessions:
 *   { "pid": 16136, "sessionId": "<uuid>", "cwd": "...", "startedAt": 1795631483360,
 *     "kind": "interactive", "entrypoint": "cli", ... }
 * HTTP hooks carry the session id but nothing from the process environment, so this is how a
 * hook event is tied to the claude process (and so to the terminal) it came from.
 *
 * The folder is internal to Claude Code and undocumented: anything unreadable simply means
 * "unknown", and callers fall back to matching by session id and folder.
 */
const SESSION_REGISTRY_TTL_MS = 2000;
const MAX_REMEMBERED_MISSES = 500;

// One scan per folder is reused for a short while: hook events arrive in bursts.
// sessionsDir -> { at, bySessionId, misses: Map<sessionId, time a scan last confirmed it absent> }
const scans = new Map();

function textOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

function scanRegistry(sessionsDir) {
  const bySessionId = new Map();
  let names;
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return bySessionId;
  }

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(sessionsDir, name), 'utf8'));
      const pid = Number(raw && raw.pid);
      const sessionId = textOrNull(raw && raw.sessionId);
      if (!Number.isInteger(pid) || pid <= 0 || !sessionId) continue;

      // A resumed session runs in a new process; a crashed one can leave its file behind.
      const startedAt = Number(raw.startedAt) || 0;
      const known = bySessionId.get(sessionId);
      if (known && known.startedAt >= startedAt) continue;

      bySessionId.set(sessionId, {
        startedAt,
        sessionId,
        info: {
          pid,
          entrypoint: textOrNull(raw.entrypoint),
          kind: textOrNull(raw.kind),
          cwd: textOrNull(raw.cwd),
        },
      });
    } catch {
      // A half-written or foreign file: skip it.
    }
  }
  return bySessionId;
}

/** The running claude process of a session id, or null when the registry does not know it. */
function lookupClaudeSession(sessionId, options = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const sessionsDir = options.sessionsDir || path.join(os.homedir(), '.claude', 'sessions');
  const now = (options.now || Date.now)();

  let scan = scans.get(sessionsDir);
  const rescan = () => {
    scan = { at: now, bySessionId: scanRegistry(sessionsDir), misses: scan ? scan.misses : new Map() };
    scans.set(sessionsDir, scan);
  };
  if (!scan || now - scan.at > SESSION_REGISTRY_TTL_MS) rescan();

  let hit = scan.bySessionId.get(sessionId);
  if (!hit) {
    // A session that started after the last scan has to be found on its first event (whether
    // it is a scripted run is decided from this), so a miss reads the folder again. An id the
    // registry really does not have is remembered, so it costs one read per TTL, not one per event.
    const missedAt = scan.misses.get(sessionId);
    const knownAbsent = missedAt !== undefined && now - missedAt <= SESSION_REGISTRY_TTL_MS;
    if (scan.at !== now && !knownAbsent) {
      rescan();
      hit = scan.bySessionId.get(sessionId);
    }
    if (!hit && scan.at === now) {
      scan.misses.delete(sessionId);
      scan.misses.set(sessionId, now);
      if (scan.misses.size > MAX_REMEMBERED_MISSES) {
        scan.misses.delete(scan.misses.keys().next().value);
      }
    }
  }
  return hit ? { ...hit.info } : null;
}

/**
 * The session a running claude process is on now (its newest registry entry), or null. This is
 * how a terminal found by the console scanner is tied to its own transcript right away, instead
 * of guessing the newest transcript in its folder (two sessions started together in one folder
 * could swap until their first hook arrived). After /clear the same pid moves to a new session.
 */
function lookupClaudeSessionByPid(pid, options = {}) {
  const wanted = Number(pid);
  if (!Number.isInteger(wanted) || wanted <= 0) return null;
  const sessionsDir = options.sessionsDir || path.join(os.homedir(), '.claude', 'sessions');
  const now = (options.now || Date.now)();
  let scan = scans.get(sessionsDir);
  if (!scan || now - scan.at > SESSION_REGISTRY_TTL_MS) {
    scan = { at: now, bySessionId: scanRegistry(sessionsDir), misses: scan ? scan.misses : new Map() };
    scans.set(sessionsDir, scan);
  }
  let best = null;
  for (const entry of scan.bySessionId.values()) {
    if (entry.info.pid === wanted && (!best || entry.startedAt > best.startedAt)) best = entry;
  }
  return best ? { ...best.info, sessionId: best.sessionId } : null;
}

/** Forget cached registry scans (tests, or after a known change). */
function clearSessionRegistryCache() {
  scans.clear();
}

module.exports = { lookupClaudeSession, lookupClaudeSessionByPid, clearSessionRegistryCache, SESSION_REGISTRY_TTL_MS };
