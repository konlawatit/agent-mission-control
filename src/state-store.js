const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const {
  getGitMetadata,
  parseTranscriptTail,
  summarizeText,
  inferWorkflowFromTool,
  launchCwdFor,
  transcriptEntrypoint,
  isAutomatedEntrypoint,
  findTranscriptById,
  findTranscriptsForCwd,
} = require('./transcript-parser');
const { lookupClaudeSessionByPid } = require('./claude-sessions');
const { parseConsoleScreen } = require('./console-scanner');
const { sanitizeQuestions, promptFromQuestions, mergeScreenPrompt, sameText } = require('./ask-prompt');

function askStatusLabel(prompt) {
  const n = Array.isArray(prompt.questions) ? prompt.questions.length : 0;
  return n > 1
    ? `รอคุณตอบ ${n} คำถาม`
    : `รอคุณเลือกตอบ (${(prompt.options || []).length} ตัวเลือก)`;
}

const STAGES = [
  { index: 0, id: 'plan', label: '1. Plan & Explore' },
  { index: 1, id: 'code', label: '2. Implement & Code' },
  { index: 2, id: 'verify', label: '3. Verify & Test' },
  { index: 3, id: 'done', label: '4. Done / Ready' },
];

const DEMO_IDS = new Set([
  'room-auth-oauth2',
  'room-payment-webhook',
  'room-frontend-perf',
  'room-db-index',
]);

const DEFAULT_GOALS = new Set([
  'รอคำสั่งเริ่มต้น...',
  'เปิด Session พร้อมเริ่มงาน',
  'เปิดห้องทำงานใหม่จาก Mission Control',
]);

function isDefaultTldr(text) {
  if (!text) return true;
  return (
    text.includes('พร้อมรับคำสั่งผ่าน Terminal หรือสั่งการจากหน้า Dashboard') ||
    text === 'เปิด Claude Session พร้อมเริ่มงาน'
  );
}

/**
 * Cleans any raw `cwd` string (stripping PowerShell prompt suffixes like `> claude`)
 */
function sanitizeCwd(rawCwd) {
  if (!rawCwd) return '';
  return String(rawCwd)
    .split('>')[0]
    .trim()
    .replace(/[\\\/]+$/, '');
}

function normalizeCwdKey(cwd) {
  const clean = sanitizeCwd(cwd);
  return clean ? clean.toLowerCase() : '';
}

/**
 * What a Notification hook means: 'attention' (a permission prompt or a question is on screen),
 * 'idle' ("Claude is waiting for your input" after a turn), or 'info'. Uses Claude Code's
 * `notification_type` when sent, else the message.
 */
function notificationKind(payload) {
  const type = String(payload.notification_type || '').toLowerCase();
  if (type) {
    if (/permission|elicitation/.test(type)) return 'attention';
    return /idle/.test(type) ? 'idle' : 'info';
  }
  const message = String(payload.message || '');
  if (/waiting for your input/i.test(message)) return 'idle';
  if (/permission|approv/i.test(message)) return 'attention';
  return 'info';
}

function sameDir(a, b) {
  const ka = normalizeCwdKey(a).replace(/\//g, '\\');
  const kb = normalizeCwdKey(b).replace(/\//g, '\\');
  return Boolean(ka) && ka === kb;
}

/**
 * Rooms that a `claude -p` / Agent SDK run created for itself (before such runs were told apart):
 * a room whose own id is a Claude session id whose transcript says it was not started in a terminal.
 */
function isAutomatedRoom(session) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(session.id || ''))) return false;
  const own =
    session.transcriptPath && path.basename(String(session.transcriptPath), '.jsonl') === session.id
      ? session.transcriptPath
      : findTranscriptById(session.id);
  return isAutomatedEntrypoint(transcriptEntrypoint(own));
}

class StateStore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.dataDir =
      options.dataDir || path.join(os.homedir(), '.agent-mission-control');
    // Claude Code's per-process session registry (~/.claude/sessions); overridable for tests.
    this.claudeSessionsDir = options.claudeSessionsDir || undefined;
    this._transcriptMisses = new Map(); // session id -> when its transcript was last not found
    this.stateFile = path.join(this.dataDir, 'sessions-state.json');
    this.sessions = new Map();
    this.commandQueues = new Map();
    this.saveDebounceMs = options.saveDebounceMs ?? 400;
    this._saveTimer = null;
    this._dirty = false;
    this._ensureDataDir();
    this._loadFromDisk();
  }

  _ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  _loadFromDisk() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        if (Array.isArray(raw.sessions)) {
          for (const s of raw.sessions) {
            if (DEMO_IDS.has(s.id)) continue;

            // Sanitize any dirty cwd like `C:\Repo\agent-mission-control> claude`
            if (s.cwd) {
              s.cwd = sanitizeCwd(s.cwd);
            }
            const meta = this._inferProjectMeta(s.cwd);
            s.project = meta.project;
            if (!s.category || s.category.includes('>')) {
              s.category = meta.category;
            }
            if (!s.customNamed || (s.room && s.room.includes('>'))) {
              s.room = meta.project;
              s.customNamed = false;
            }
            if (!s.lifecycle) {
              s.lifecycle = s.status === 'closed' ? 'history' : 'live';
            }
            if (!Array.isArray(s.taskHistory)) {
              s.taskHistory = [];
            }
            if (s.screenPreview && s.screenPreview.includes('\uFFFD')) {
              s.screenPreview = null;
            }
            // Rooms an automated `claude -p` / SDK run made for itself are not rooms anyone opened.
            if (isAutomatedRoom(s)) continue;
            this.sessions.set(s.id, s);
          }
          this._deduplicateSessions();
          this._enrichAllFromTranscripts();
          this._saveToDisk();
        }
      }
    } catch {
      // Ignore corrupt state file on startup
    }
  }

  /**
   * STRICT 1-FOLDER = 1-ROOM GUARANTEE:
   * Merges any sessions sharing the same normalized `cwd` into a single canonical Room,
   * preserving previous interactions inside `primary.taskHistory`.
   */
  /**
   * Merges rooms that are the same session seen twice (e.g. the scanner's room for a terminal
   * and a room a hook made before the pid was known, or a resumed session's closed room and its
   * new terminal). Sharing a folder is not enough: each session in a project keeps its own room.
   */
  _deduplicateSessions() {
    const groups = new Map();
    const add = (key, s) => {
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(s);
    };
    for (const s of Array.from(this.sessions.values())) {
      if (s.cwd) s.cwd = sanitizeCwd(s.cwd);
      if (s.claudeSessionId) add(`sid:${s.claudeSessionId}`, s);
      if (s.pid && s.lifecycle !== 'history') add(`pid:${s.pid}`, s);
    }

    for (const set of groups.values()) {
      const group = Array.from(set).filter((s) => this.sessions.get(s.id) === s);
      if (group.length <= 1) continue;

      // Sort so the most recently updated / active session is primary
      group.sort((a, b) => {
        if (a.lifecycle !== b.lifecycle) {
          return a.lifecycle === 'live' ? -1 : 1;
        }
        return new Date(b.updatedAt) - new Date(a.updatedAt);
      });

      const primary = group[0];
      for (let i = 1; i < group.length; i++) {
        const dup = group[i];
        this._mergeSessionInto(primary, dup);
        this.sessions.delete(dup.id);
      }
    }
  }

  _mergeSessionInto(target, source) {
    if (!target || !source) return;
    if (source.claudeSessionId && !target.claudeSessionId) {
      target.claudeSessionId = source.claudeSessionId;
    }
    if (source.transcriptPath && !target.transcriptPath) {
      target.transcriptPath = source.transcriptPath;
    }
    if (source.pid && !target.pid) {
      target.pid = source.pid;
    }
    if (Number.isFinite(source.sortOrder) && !Number.isFinite(target.sortOrder)) {
      target.sortOrder = source.sortOrder; // keep the room where the user placed it
    }
    // If source had a real goal/tldr and target has a default one, adopt it;
    // otherwise archive source's goal/tldr into target.taskHistory!
    if (source.goal && !DEFAULT_GOALS.has(source.goal)) {
      if (DEFAULT_GOALS.has(target.goal)) {
        target.goal = source.goal;
        if (!isDefaultTldr(source.tldr)) target.tldr = source.tldr;
      } else {
        this._archiveTurnIntoHistory(target, {
          goal: source.goal,
          tldr: source.tldr,
          timestamp: source.updatedAt || source.createdAt,
          sessionId: source.claudeSessionId || source.id,
        });
      }
    }
    if (source.tldr && !isDefaultTldr(source.tldr) && isDefaultTldr(target.tldr)) {
      target.tldr = source.tldr;
    }
    if ((source.stageIndex || 0) > (target.stageIndex || 0) && target.stageIndex === 0) {
      target.stageIndex = source.stageIndex;
    }
    if (source.interactivePrompt && !target.interactivePrompt) {
      target.interactivePrompt = source.interactivePrompt;
      target.status = 'needs_input';
      target.statusLabel = source.statusLabel;
    }
    if (Array.isArray(source.taskHistory)) {
      for (const th of source.taskHistory) {
        this._archiveTurnIntoHistory(target, th);
      }
    }
    if (Array.isArray(source.subAgents)) {
      for (const sub of source.subAgents) {
        if (!target.subAgents.some((s) => s.id === sub.id)) {
          target.subAgents.push(sub);
        }
      }
    }
    if (Array.isArray(source.modifiedFiles)) {
      for (const f of source.modifiedFiles) {
        if (!target.modifiedFiles.includes(f)) {
          target.modifiedFiles.push(f);
        }
      }
    }
    if (Array.isArray(source.recentEvents)) {
      for (const ev of source.recentEvents) {
        if (!target.recentEvents.some((e) => e.id === ev.id)) {
          target.recentEvents.push(ev);
        }
      }
      target.recentEvents.sort(
        (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
      );
      if (target.recentEvents.length > 30) target.recentEvents.length = 30;
    }
  }

  /**
   * Adds a completed or previous interaction turn into `session.taskHistory` without duplicates.
   */
  _archiveTurnIntoHistory(session, turnObj) {
    if (!session || !turnObj || !turnObj.goal || DEFAULT_GOALS.has(turnObj.goal)) {
      return;
    }
    if (!Array.isArray(session.taskHistory)) {
      session.taskHistory = [];
    }
    const existing = session.taskHistory.find(
      (item) => item.goal === turnObj.goal
    );
    if (existing) {
      if (turnObj.tldr && !isDefaultTldr(turnObj.tldr)) {
        existing.tldr = turnObj.tldr;
      }
      if (turnObj.tools && turnObj.tools.length > 0) {
        existing.tools = turnObj.tools;
      }
      return;
    }
    session.taskHistory.unshift({
      id: turnObj.id || `turn-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      goal: turnObj.goal,
      tldr:
        turnObj.tldr && !isDefaultTldr(turnObj.tldr)
          ? turnObj.tldr
          : 'ดำเนินการเสร็จสิ้น',
      tools: Array.isArray(turnObj.tools) ? turnObj.tools : [],
      timestamp: turnObj.timestamp || new Date().toISOString(),
      sessionId: turnObj.sessionId || session.claudeSessionId || session.id,
    });
    if (session.taskHistory.length > 25) {
      session.taskHistory.length = 25;
    }
  }

  /**
   * The transcript this room shows: its own (named by a hook) or, until a hook names it, the
   * newest one in its folder that no other room is showing. Never several sessions merged.
   */
  _transcriptFor(session) {
    const sid = session.claudeSessionId;
    const own = session.transcriptPath && fs.existsSync(session.transcriptPath) ? session.transcriptPath : null;
    if (sid) {
      // The session is known: only its own transcript, never a neighbour's. A session that has
      // not written one yet (no message so far) shows nothing until it does.
      if (own && path.basename(own, '.jsonl') === sid) return own;
      const missedAt = this._transcriptMisses.get(sid);
      if (missedAt && Date.now() - missedAt < 5000) return null; // not written yet; look again soon
      const found = findTranscriptById(sid);
      if (found) {
        session.transcriptPath = found;
        this._transcriptMisses.delete(sid);
      } else {
        this._transcriptMisses.set(sid, Date.now());
        if (this._transcriptMisses.size > 500) this._transcriptMisses.delete(this._transcriptMisses.keys().next().value);
      }
      return found;
    }
    if (own) return own;
    if (!session.cwd) return null;
    // Last resort (no hook and no session registry): the newest transcript in the folder that no
    // other room shows.
    const key = (p) => path.resolve(String(p)).toLowerCase();
    const taken = new Set();
    for (const s of this.sessions.values()) {
      if (s !== session && s.transcriptPath) taken.add(key(s.transcriptPath));
    }
    const free = findTranscriptsForCwd(session.cwd).find((t) => !taken.has(key(t.path)));
    return free ? free.path : null;
  }

  _enrichSessionFromTranscript(session) {
    if (!session) return;
    const target = this._transcriptFor(session);
    if (!target) return;
    const parsed = parseTranscriptTail(target, null);
    if (!parsed) return;

    if (parsed.transcriptPath) {
      session.transcriptPath = parsed.transcriptPath;
    }
    if (parsed.detectedModel) {
      session.model = parsed.detectedModel;
    }
    if (parsed.tokenUsage) {
      session.tokenUsage = parsed.tokenUsage;
    }
    if (
      parsed.lastAssistantText &&
      (isDefaultTldr(session.tldr) || session.status === 'done' || session.status === 'idle')
    ) {
      session.tldr = parsed.lastAssistantText;
    }
    if (parsed.lastUserText && DEFAULT_GOALS.has(session.goal)) {
      session.goal = parsed.lastUserText;
    }
    if (parsed.utf8Preview && !session.interactivePrompt) {
      session.screenPreview = parsed.utf8Preview;
      // Where that preview starts in the transcript; older messages are paged from here.
      session.previewFrom = Number.isFinite(parsed.previewFrom) ? parsed.previewFrom : null;
    }
    // The open AskUserQuestion, so the screen's garbled copy can be replaced (see ask-prompt).
    if (parsed.pendingAsk) {
      session.pendingAsk = parsed.pendingAsk;
    } else if (
      session.pendingAsk &&
      parsed.turnStateAt &&
      (!session.pendingAsk.at || Date.parse(parsed.turnStateAt) > Date.parse(session.pendingAsk.at))
    ) {
      session.pendingAsk = null; // the transcript has moved past it
    }
    // When the transcript last moved (a tool ran, a reply, an interrupt): a prompt reported before
    // that is over.
    if (parsed.turnStateAt) session.lastTurnStateAt = parsed.turnStateAt;
    // Messages waiting in Claude's queue, and text it put back into the input box.
    session.queuedMessages = Array.isArray(parsed.queuedMessages) ? parsed.queuedMessages : [];
    session.restoredInput = parsed.restoredInput || null;
    // A Claude session started before the hooks were installed never sends Stop, so a room the
    // dashboard set to "working" would stay that way. The transcript records when the turn ended.
    // Only a turn end newer than the last working signal (or the room itself) counts.
    const workingSince = session.workingSignalAt || session.createdAt;
    if (
      session.status === 'working' &&
      parsed.turnState === 'done' &&
      parsed.turnStateAt &&
      (!workingSince || Date.parse(parsed.turnStateAt) > Date.parse(workingSince))
    ) {
      this._finishTurn(session, parsed.turnStateAt, parsed.lastAssistantFullText);
    }
    if (Array.isArray(parsed.turnHistory) && parsed.turnHistory.length > 0) {
      // Populate internal room history from all turns in this project's transcripts!
      // Keep the newest turn as current goal/tldr if none is active, and list all turns in taskHistory
      for (const t of [...parsed.turnHistory].reverse()) {
        this._archiveTurnIntoHistory(session, t);
      }
    }
    if (parsed.subAgents && parsed.subAgents.length > 0) {
      for (const tSub of parsed.subAgents) {
        const existing = session.subAgents.find((s) => s.id === tSub.id);
        if (!existing) {
          session.subAgents.push(tSub);
        } else if (tSub.state === 'done') {
          existing.state = 'done';
          existing.tool = 'Completed';
          if (tSub.resultSummary) existing.resultSummary = tSub.resultSummary;
        }
      }
    }
  }

  _enrichAllFromTranscripts() {
    for (const s of this.sessions.values()) {
      this._enrichSessionFromTranscript(s);
    }
  }

  /**
   * Writes the state atomically (temp file + rename) so a crash mid-write
   * can never leave a truncated sessions-state.json behind.
   */
  _saveToDisk() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._dirty = false;
    try {
      const payload = {
        updatedAt: new Date().toISOString(),
        sessions: Array.from(this.sessions.values()),
      };
      const tmpFile = `${this.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmpFile, this.stateFile);
    } catch {}
  }

  /** Coalesces bursts of changes into a single disk write. */
  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => this._saveToDisk(), this.saveDebounceMs);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  /** Persists any pending changes immediately (call on shutdown). */
  flush() {
    if (this._dirty) this._saveToDisk();
  }

  _emitChange(eventType = 'state_updated', detail = {}) {
    this._scheduleSave();
    // Listeners build the snapshot themselves when (and if) they need it.
    this.emit('change', { type: eventType, detail });
  }

  _inferProjectMeta(cwd) {
    const clean = sanitizeCwd(cwd);
    if (!clean) {
      return { project: 'General', category: 'General' };
    }
    const parts = clean.split(/[\\\/]+/).filter(Boolean);
    const project = parts[parts.length - 1] || 'Workspace';
    const parent = parts.length >= 2 ? parts[parts.length - 2] : 'Local';
    return {
      project,
      category: parent,
    };
  }

  /**
   * IMPORTANT: Always match by normalized `cwd` FIRST!
   * That way, 1 project folder = 1 Room Card, even across multiple turns or new Claude session UUIDs!
   */
  /**
   * A room is one Claude session in one terminal, not one folder: several sessions can run in
   * the same project and each gets its own room. Identity, strongest first: the room id, the
   * claude process (pid), the Claude session id. A folder alone (`matchFolder`) only identifies
   * a room when exactly one open room there is still unclaimed, i.e. not tied to another
   * process or session (a room opened from the dashboard before its terminal was seen, or a
   * terminal whose hooks have not reported yet).
   */
  _findMatchingSession({ sessionId, pid, claudeSessionId, cwd, matchFolder = false }) {
    const rooms = Array.from(this.sessions.values());
    if (sessionId && this.sessions.has(String(sessionId))) {
      return this.sessions.get(String(sessionId));
    }
    if (pid) {
      const byPid =
        rooms.find((s) => s.lifecycle !== 'history' && Number(s.pid) === Number(pid)) ||
        rooms.find((s) => s.pid && Number(s.pid) === Number(pid));
      if (byPid) return byPid;
    }
    const sid =
      claudeSessionId || (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(sessionId || '')) ? String(sessionId) : null);
    if (sid) {
      const bySid = rooms.find((s) => s.claudeSessionId === sid);
      if (bySid) return bySid;
    }
    if (matchFolder && cwd) {
      const key = normalizeCwdKey(cwd);
      const unclaimed = rooms.filter(
        (s) =>
          s.lifecycle !== 'history' &&
          normalizeCwdKey(s.cwd) === key &&
          (!pid || !s.pid) &&
          (!sid || !s.claudeSessionId)
      );
      if (unclaimed.length === 1) return unclaimed[0];
    }
    return null;
  }

  getOrCreateSession(sessionId, defaults = {}) {
    const cleanCwd = sanitizeCwd(defaults.cwd);
    const existing = this._findMatchingSession({
      sessionId,
      pid: defaults.pid,
      claudeSessionId: defaults.claudeSessionId,
      cwd: cleanCwd || undefined,
      matchFolder: Boolean(defaults.matchFolder),
    });
    if (existing) {
      if (defaults.pid && !existing.pid) existing.pid = defaults.pid;
      return existing;
    }

    const cwd = cleanCwd || sanitizeCwd(process.cwd());
    const { project, category } = this._inferProjectMeta(cwd);
    const gitMeta = getGitMetadata(cwd);
    const id = String(sessionId || `room-${project.toLowerCase()}-${Date.now()}`);

    const created = {
      id,
      claudeSessionId:
        /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)
          ? id
          : defaults.claudeSessionId || null,
      room: defaults.room ? sanitizeCwd(defaults.room) : `${project}`,
      project: defaults.project ? sanitizeCwd(defaults.project) : project,
      category: defaults.category ? sanitizeCwd(defaults.category) : category,
      tags: Array.isArray(defaults.tags) ? defaults.tags : [category],
      pinned: Boolean(defaults.pinned),
      sortOrder: null, // manual position set by dragging in the dashboard; null = not placed yet
      lifecycle: defaults.lifecycle || 'live',
      isProcessAlive: true,
      cli: defaults.cli || 'claude-code',
      cwd,
      branch: defaults.branch || gitMeta.branch,
      dirtyFiles:
        typeof defaults.dirtyFiles === 'number'
          ? defaults.dirtyFiles
          : gitMeta.dirtyFiles,
      paneId: defaults.paneId || null,
      wtSession: defaults.wtSession || null,
      pid: defaults.pid || null,
      wrapperConnected: Boolean(defaults.wrapperConnected),
      status: defaults.status || 'idle',
      statusLabel: defaults.statusLabel || 'พร้อมรับคำสั่ง',
      goal: defaults.goal || 'เปิด Session พร้อมเริ่มงาน',
      tldr:
        defaults.tldr ||
        'เชื่อมต่อ Session เรียบร้อย พร้อมรับคำสั่งผ่าน Terminal หรือสั่งการจากหน้า Dashboard',
      pendingAction: defaults.pendingAction || null,
      interactivePrompt: defaults.interactivePrompt || null,
      screenPreview: defaults.screenPreview || null,
      stageIndex:
        typeof defaults.stageIndex === 'number' ? defaults.stageIndex : 0,
      currentTool: defaults.currentTool || 'Idle',
      subAgents: Array.isArray(defaults.subAgents) ? defaults.subAgents : [],
      modifiedFiles: Array.isArray(defaults.modifiedFiles)
        ? defaults.modifiedFiles
        : [],
      recentEvents: Array.isArray(defaults.recentEvents)
        ? defaults.recentEvents
        : [],
      taskHistory: Array.isArray(defaults.taskHistory)
        ? defaults.taskHistory
        : [],
      model: defaults.model || 'opus',
      effort: defaults.effort || 'high',
      tokenUsage: defaults.tokenUsage || {
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
      },
      savedCheckpoint: defaults.savedCheckpoint || null,
      transcriptPath: defaults.transcriptPath || null,
      openCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      closedAt: null,
    };

    this._enrichSessionFromTranscript(created);
    this.sessions.set(id, created);
    return created;
  }

  ingestConsoleScan(scanItems = []) {
    if (!Array.isArray(scanItems)) return;
    let changed = false;
    const now = new Date().toISOString();
    const activePids = new Set();
    for (const i of scanItems) {
      if (!i || !i.pid) continue;
      activePids.add(Number(i.pid));
      if (Array.isArray(i.consolePids)) {
        for (const cp of i.consolePids) activePids.add(Number(cp));
      }
    }

    for (const item of scanItems) {
      if (!item || !item.pid || !item.screen) continue;
      const numericPid = Number(item.pid);

      const parsed = parseConsoleScreen(item.screen, { cursorRow: item.cursorRow, cursorCol: item.cursorCol });
      if (!parsed) continue;

      // Authoritative OS-level PEB `item.cwd` takes precedence over screen-scraped `parsed.cwd`!
      const cwd = sanitizeCwd(item.cwd || parsed.cwd) || null;
      const knownByPid = Array.from(this.sessions.values()).find(
        (s) => s.pid && Number(s.pid) === numericPid
      );
      if (!cwd && !knownByPid && this.sessions.size > 0) {
        continue;
      }

      const { project, category } = this._inferProjectMeta(cwd);
      const cliLabel = [
        'claude',
        parsed.version || '',
        parsed.model
          ? `(${parsed.model.split('·')[0].trim()})`
          : `(PID ${numericPid})`,
      ]
        .filter(Boolean)
        .join(' ');

      // One room per terminal: a new claude process in a folder that already has a room gets
      // its own, unless that room is still unclaimed (opened from the dashboard, no pid yet).
      const session = this.getOrCreateSession(`claude-pid-${numericPid}`, {
        pid: numericPid,
        cwd: cwd || undefined,
        room: cwd ? project : `Claude Tab (PID ${numericPid})`,
        project: cwd ? project : 'Terminal Session',
        category: cwd ? category : 'CLI',
        cli: cliLabel,
        matchFolder: true,
      });

      const prevStateSig = JSON.stringify({
        input: session.terminalInput,
        queued: session.queuedMessages,
        lifecycle: session.lifecycle,
        status: session.status,
        pid: session.pid,
        cwd: session.cwd,
        prompt: session.interactivePrompt,
        preview: session.screenPreview,
        tldr: session.tldr,
        historyCount: (session.taskHistory || []).length,
      });

      if (session.lifecycle === 'history') {
        session.lifecycle = 'live';
        session.closedAt = null;
        session.openCount = (session.openCount || 1) + 1;
        if (session.status === 'closed') {
          session.status = 'idle';
          session.statusLabel = 'กลับมาเปิดใช้งาน (Resumed)';
        }
      }

      session.isProcessAlive = true;
      // Always bind the exact console PID discovered for this specific `cwd`!
      session.pid = numericPid;
      session.cli = cliLabel;
      // Claude Code's session registry says which session this process is on, so the room gets
      // its own transcript at once (and the new one after /clear), with no guessing by folder.
      const registered = lookupClaudeSessionByPid(numericPid, { sessionsDir: this.claudeSessionsDir });
      if (registered && registered.sessionId && registered.sessionId !== session.claudeSessionId) {
        session.claudeSessionId = registered.sessionId;
        session.transcriptPath = null; // found by id in _transcriptFor
      }

      if (cwd && (!session.cwd || session.room.startsWith('Claude Tab'))) {
        session.cwd = cwd;
        const meta = this._inferProjectMeta(cwd);
        session.project = meta.project;
        session.category = meta.category;
        if (!session.customNamed) {
          session.room = meta.project;
        }
        const gitMeta = getGitMetadata(cwd);
        session.branch = gitMeta.branch;
        session.dirtyFiles = gitMeta.dirtyFiles;
      }

      this._enrichSessionFromTranscript(session);

      if (!session.screenPreview || parsed.interactivePrompt) {
        const cleanConsolePreview = (parsed.screenPreview || '').replace(
          /\uFFFD+/g,
          ''
        );
        if (!session.screenPreview) {
          session.screenPreview = cleanConsolePreview;
        }
      }

      if (parsed.interactivePrompt) {
        // Claude's own question text replaces the screen's (Thai arrives garbled from the console).
        const prompt = mergeScreenPrompt(parsed.interactivePrompt, session.pendingAsk);
        // A permission prompt: its options read fine from the screen, but the command shown with
        // it garbles Thai; use the hook's exact copy instead of any garbled line.
        const perm = session.permissionDetail;
        if (prompt.source !== 'claude' && perm && session.hookPromptAt) {
          const clean = (prompt.context || []).filter((l) => !l.includes('�') && !perm.text.includes(l.trim()));
          prompt.context = [perm.text, ...clean].slice(0, 5);
          if (prompt.question.includes('�')) prompt.question = `อนุญาตให้ ${perm.tool} ทำงานนี้หรือไม่?`;
        }
        session.interactivePrompt = prompt;
        session.promptOnScreen = true;
        session.status = 'needs_input';
        session.statusLabel = askStatusLabel(prompt);
        session.pendingAction = prompt.question;
        session.tldr = `⚠️ ${prompt.question} — คลิกเลือกตัวเลือก (${prompt.options
          .map((o) => `${o.number}. ${o.label}`)
          .join(' / ')}) จากด้านล่างได้เลย`;
      } else if (session.pendingAsk) {
        // The transcript says Claude is still waiting on its questions even though this screen
        // layout wasn't recognised: keep the room waiting, with the terminal's position unknown.
        session.interactivePrompt = {
          ...promptFromQuestions(session.pendingAsk.questions),
          activeQuestion: -1,
          currentIndex: 0,
          options: [],
        };
        session.status = 'needs_input';
        session.statusLabel = askStatusLabel(session.interactivePrompt);
        session.pendingAction = session.pendingAsk.questions[0].question;
      } else if (
        session.hookPromptAt &&
        !session.promptOnScreen &&
        !(session.lastTurnStateAt && Date.parse(session.lastTurnStateAt) > Date.parse(session.hookPromptAt))
      ) {
        // A hook reported a permission prompt this screen hasn't shown (not drawn yet, or a
        // layout the parser doesn't know). Clearing it here made the card flash and vanish; it
        // stays until it has been seen and gone, or the transcript moves past it.
      } else if (session.interactivePrompt) {
        session.interactivePrompt = null;
        session.pendingAction = null;
        session.hookPromptAt = null;
        session.promptOnScreen = false;
        session.permissionDetail = null;
        if (session.status === 'needs_input') {
          session.status = 'idle';
          session.statusLabel = 'พร้อมรับคำสั่ง';
          this._enrichSessionFromTranscript(session);
        }
      }

      // What is sitting unsent in the terminal's input box (null = empty or not on screen).
      if (parsed.inputText !== null && parsed.inputText !== undefined) {
        if (!parsed.inputText) {
          session.terminalInput = null;
        } else {
          // The screen garbles Thai; when it is text we know (typed by the dashboard, or put back
          // from Claude's queue), keep the exact copy too.
          const known = [session.restoredInput && session.restoredInput.text, session.lastTypedText].filter(Boolean);
          const exact = known.find((k) => sameText(parsed.inputText, k)) || null;
          session.terminalInput = { text: parsed.inputText.slice(0, 4000), exact: exact ? exact.slice(0, 4000) : null };
        }
      }
      session.terminalBusy = Boolean(parsed.busy);

      const nextStateSig = JSON.stringify({
        input: session.terminalInput,
        queued: session.queuedMessages,
        lifecycle: session.lifecycle,
        status: session.status,
        pid: session.pid,
        cwd: session.cwd,
        prompt: session.interactivePrompt,
        preview: session.screenPreview,
        tldr: session.tldr,
        historyCount: (session.taskHistory || []).length,
      });

      if (prevStateSig !== nextStateSig) {
        session.updatedAt = now;
        changed = true;
      }
    }

    this._deduplicateSessions();

    for (const session of this.sessions.values()) {
      if (
        session.lifecycle === 'live' &&
        session.pid &&
        !activePids.has(Number(session.pid))
      ) {
        session.lifecycle = 'history';
        session.isProcessAlive = false;
        session.closedAt = now;
        session.updatedAt = now;
        session.status = 'closed';
        session.statusLabel = 'ปิด Tab ไปแล้ว • กู้คืนได้';
        session.interactivePrompt = null;
        session.pendingAction = null;
        session.currentTool = 'Tab Closed';
        session.recentEvents.unshift({
          id: `${Date.now()}-closed`,
          timestamp: now,
          event: 'TabClosed',
          title: `หน้าต่าง Terminal (PID ${session.pid}) ถูกปิด — บันทึกเก็บไว้ในประวัติเรียบร้อย`,
          badge: 'Saved to History',
          level: 'info',
        });
        session.pid = null;
        changed = true;
      }
    }

    if (changed) {
      this._emitChange('console_scan_updated', {});
    }
  }

  /**
   * The room a hook event belongs to, or null when it belongs to none (an automated session).
   *
   * Order: the claude process itself (CLAUDE_PID, the scanner's room for that terminal), then
   * the room already bound to this Claude session, then the folder the session was STARTED in
   * (from its transcript folder). The hook's `cwd` follows Bash `cd`, so matching on it attached
   * a session that had cd'ed into a worktree to that worktree's room.
   */
  _roomForHook(payload, { rawSessionId, isUuid, roomCwd, automated }) {
    const rooms = Array.from(this.sessions.values());
    if (automated) {
      // `claude -p` / the SDK: only a room that is already this session's (the dashboard's own
      // background run) takes its events; a room that such a run created itself is dropped.
      const owner = isUuid && rooms.find((s) => s.claudeSessionId === rawSessionId && s.id !== rawSessionId);
      if (!owner && isUuid && this.sessions.has(rawSessionId)) {
        this.sessions.delete(rawSessionId);
        this._emitChange('session_removed', { sessionId: rawSessionId });
      }
      return owner || null;
    }
    const claudePid = Number(payload.claude_pid);
    if (Number.isInteger(claudePid) && claudePid > 0) {
      const byPid = rooms.find((s) => s.lifecycle !== 'history' && Number(s.pid) === claudePid);
      if (byPid) return byPid;
    }
    if (isUuid) {
      const bound = rooms.find(
        (s) => (s.claudeSessionId === rawSessionId || s.id === rawSessionId) && (!roomCwd || sameDir(s.cwd, roomCwd))
      );
      if (bound) return bound;
    }
    return undefined; // fall back to getOrCreateSession by folder
  }

  processHookEvent(payload = {}) {
    const rawSessionId = payload.session_id || payload.sessionId || null;
    const isUuid =
      rawSessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(rawSessionId));
    const cleanCwd = sanitizeCwd(payload.cwd);
    // The folder the session was started in; the hook's own cwd moves with Bash `cd`.
    const roomCwd = launchCwdFor(cleanCwd, payload.transcript_path) || cleanCwd;
    const automated =
      isAutomatedEntrypoint(payload.entrypoint) ||
      isAutomatedEntrypoint(transcriptEntrypoint(payload.transcript_path));

    const lookupId =
      rawSessionId ||
      payload.room_id ||
      (payload.pid ? `claude-pid-${payload.pid}` : null) ||
      `cwd-${Buffer.from(String(roomCwd || 'default')).toString('hex').slice(0, 10)}`;

    const matched = this._roomForHook(payload, { rawSessionId, isUuid, roomCwd, automated });
    if (matched === null) return null; // an automated session nobody owns: no room
    const session =
      matched ||
      this.getOrCreateSession(lookupId, {
        cwd: roomCwd,
        room: payload.room,
        claudeSessionId: isUuid ? String(rawSessionId) : null,
        cli:
          payload.cli ||
          (payload.pane_id ? `claude (pane #${payload.pane_id})` : 'claude-code'),
        paneId: payload.pane_id || null,
        wtSession: payload.wt_session || null,
        pid: payload.pid || Number(payload.claude_pid) || null,
        // Without a pid, a session claims the one open room in its folder that no session owns yet.
        matchFolder: true,
      });

    const now = new Date().toISOString();
    session.updatedAt = now;
    if (isUuid) {
      session.claudeSessionId = String(rawSessionId);
    }
    // A room keeps the folder it was opened in; only a room without one (or a placeholder
    // "Claude Tab" from the scanner) takes it from the event.
    if (roomCwd && (!session.cwd || String(session.room || '').startsWith('Claude Tab'))) {
      session.cwd = roomCwd;
      const meta = this._inferProjectMeta(roomCwd);
      session.project = meta.project;
      session.category = meta.category;
      if (!session.customNamed) {
        session.room = meta.project;
      }
    }
    if (payload.room) {
      session.room = sanitizeCwd(payload.room);
      session.customNamed = true;
    }
    if (payload.pane_id) session.paneId = payload.pane_id;
    if (payload.wt_session) session.wtSession = payload.wt_session;
    if (payload.pid && !session.pid) session.pid = payload.pid;
    if (Number(payload.claude_pid) > 0 && !session.pid) session.pid = Number(payload.claude_pid);
    if (payload.transcript_path)
      session.transcriptPath = payload.transcript_path;
    if (typeof payload.wrapper_connected === 'boolean') {
      session.wrapperConnected = payload.wrapper_connected;
    }

    if (session.cwd && fs.existsSync(session.cwd)) {
      const gitMeta = getGitMetadata(session.cwd);
      session.branch = gitMeta.branch;
      session.dirtyFiles = gitMeta.dirtyFiles;
    }

    const hookEvent =
      payload.hook_event_name || payload.event || payload.type || 'Heartbeat';
    const toolName = payload.tool_name || payload.toolName || '';
    const toolInput = payload.tool_input || payload.toolInput || {};

    if (hookEvent !== 'SessionEnd') {
      session.lifecycle = 'live';
      session.isProcessAlive = true;
      session.closedAt = null;
    }

    const pushTimeline = (title, badge, level = 'info') => {
      session.recentEvents.unshift({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: now,
        event: hookEvent,
        title,
        badge,
        level,
      });
      if (session.recentEvents.length > 30) {
        session.recentEvents.length = 30;
      }
    };

    if (hookEvent === 'SessionStart') {
      session.status = 'idle';
      session.statusLabel = 'เปิดห้องพร้อมใช้งาน';
      pushTimeline('เริ่มต้น Session ใน ' + session.cwd, 'SessionStart', 'info');
    } else if (hookEvent === 'UserPromptSubmit') {
      const promptText =
        payload.prompt ||
        payload.user_prompt ||
        payload.message ||
        'รับคำสั่งใหม่จากผู้ใช้';
      const newGoal = summarizeText(promptText, 160);
      // Claude Code also submits its own messages as prompts (<task-notification> when a
      // background task finishes, <system-reminder>, …): the room works on, but its goal stays
      // what the person asked.
      const injected = /^\s*</.test(String(promptText));

      if (injected) {
        session.status = 'working';
        session.statusLabel = 'กำลังทำงาน';
        session.currentTool = 'Thinking...';
      } else {
        // Archive previous completed/active interaction into internal taskHistory before starting the new turn!
        if (session.goal && !DEFAULT_GOALS.has(session.goal) && session.goal !== newGoal) {
          this._archiveTurnIntoHistory(session, {
            goal: session.goal,
            tldr: session.tldr,
            timestamp: now,
            sessionId: session.claudeSessionId || session.id,
          });
        }

        session.goal = newGoal;
        session.status = 'working';
        session.statusLabel = 'กำลังวางแผน & ทำงาน';
        session.pendingAction = null;
        session.interactivePrompt = null;
        session.pendingAsk = null;
        session.stageIndex = 0;
        session.currentTool = 'Thinking...';
        session.tldr = `รับคำสั่งใหม่: "${summarizeText(promptText, 120)}" — กำลังวิเคราะห์และวางแผนขั้นตอน`;
        pushTimeline(`คำสั่งใหม่: ${summarizeText(promptText, 90)}`, 'Prompt', 'primary');
      }
    } else if (hookEvent === 'PreToolUse') {
      const inferred = inferWorkflowFromTool(toolName, toolInput);
      session.status = 'working';
      session.pendingAction = null;
      session.stageIndex = Math.max(
        session.stageIndex === 3 ? 0 : session.stageIndex,
        inferred.stageIndex
      );
      session.currentTool = inferred.toolBadge;
      session.tldr = inferred.tldr;

      if (
        inferred.modifiedFile &&
        !session.modifiedFiles.includes(inferred.modifiedFile)
      ) {
        session.modifiedFiles.unshift(inferred.modifiedFile);
        if (session.modifiedFiles.length > 20) session.modifiedFiles.length = 20;
      }

      if (
        toolName === 'AskUserQuestion' ||
        (Array.isArray(toolInput.questions) && toolInput.questions.length > 0)
      ) {
        this._openAsk(session, toolInput, payload.tool_use_id, now);
      }

      if (inferred.isSubAgent) {
        const subId =
          payload.tool_use_id ||
          `sub-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
        const subDesc =
          toolInput.description ||
          toolInput.subagent_type ||
          'Sub-Agent Worker';
        const subPrompt = summarizeText(
          toolInput.prompt || 'กำลังรันงานย่อยแบบขนาน',
          120
        );
        const existing = session.subAgents.find((s) => s.id === subId);
        if (!existing) {
          session.subAgents.unshift({
            id: subId,
            name: `Sub-Agent: ${subDesc}`,
            role: subPrompt,
            subagentType: toolInput.subagent_type || 'general',
            state: 'working',
            tool: 'Running Task...',
            startedAt: now,
          });
        }
        const activeSubCount = session.subAgents.filter(
          (s) => s.state === 'working'
        ).length;
        session.statusLabel = `กำลังทำงาน (${activeSubCount} Sub-agent)`;
        pushTimeline(`เปิด Sub-Agent: ${subDesc}`, 'Sub-Agent', 'primary');
      } else if (session.status !== 'needs_input') {
        const activeSubCount = session.subAgents.filter(
          (s) => s.state === 'working'
        ).length;
        session.statusLabel =
          activeSubCount > 0
            ? `กำลังทำงาน (${activeSubCount} Sub)`
            : inferred.stageIndex === 2
            ? 'กำลังรันเทส/ตรวจผล'
            : 'กำลังทำงาน';
        pushTimeline(inferred.tldr, inferred.toolBadge, 'info');
      }
    } else if (hookEvent === 'PostToolUse') {
      session.pendingAction = null;
      session.interactivePrompt = null;
      if (toolName === 'AskUserQuestion') session.pendingAsk = null;
      if (toolName === 'Task' || toolName === 'Agent') {
        const subId = payload.tool_use_id;
        const target =
          (subId && session.subAgents.find((s) => s.id === subId)) ||
          session.subAgents.find((s) => s.state === 'working');
        if (target) {
          target.state = 'done';
          target.tool = 'Completed';
          target.completedAt = now;
        }
      }
      const activeSubCount = session.subAgents.filter(
        (s) => s.state === 'working'
      ).length;
      session.status = 'working';
      session.statusLabel =
        activeSubCount > 0
          ? `กำลังทำงาน (${activeSubCount} Sub)`
          : 'กำลังประมวลผลต่อ';
    } else if (hookEvent === 'SubagentStop') {
      const runningSub = session.subAgents.find((s) => s.state === 'working');
      if (runningSub) {
        runningSub.state = 'done';
        runningSub.tool = 'Completed';
        runningSub.completedAt = now;
      }
      pushTimeline('Sub-Agent ทำงานเสร็จสิ้น 1 ตัว', 'SubagentStop', 'success');
    } else if (
      (hookEvent === 'PermissionRequest' || hookEvent === 'Notification') &&
      (toolName === 'AskUserQuestion' || session.pendingAsk)
    ) {
      // AskUserQuestion also goes through the permission flow ("Claude needs your permission").
      // It is a question, not an approval: show the questions, never Yes/No.
      if (!session.pendingAsk) this._openAsk(session, toolInput, payload.tool_use_id, now);
      session.status = 'needs_input';
    } else if (hookEvent === 'Notification' && notificationKind(payload) !== 'attention') {
      // "Claude is waiting for your input" comes ~60 s after a turn ends: the room is idle, not
      // asking anything. Treating it as a question flashed a fake approval card into "รอคุณ".
      pushTimeline(summarizeText(payload.message || 'Claude รอคำสั่งถัดไป', 90), 'Notification', 'info');
    } else if (
      hookEvent === 'PermissionRequest' ||
      hookEvent === 'Notification'
    ) {
      // Kept until the prompt shows and goes on screen, or the transcript moves past it (see
      // ingestConsoleScan): the first scan can run before the terminal has drawn the prompt.
      session.hookPromptAt = now;
      const cmdDetail =
        (toolInput && (toolInput.command || toolInput.file_path)) ||
        payload.message ||
        payload.title ||
        (toolName
          ? `ขอสิทธิ์รัน ${toolName}`
          : 'Claude กำลังรอให้คุณเลือกคำตอบหรือกดยืนยัน');
      // The exact command; the screen's copy garbles Thai (see ingestConsoleScan).
      if (toolName) session.permissionDetail = { tool: String(toolName).slice(0, 80), text: String(cmdDetail).slice(0, 2000) };

      session.status = 'needs_input';
      session.statusLabel = 'รอคุณเลือกตอบ / Approve';
      session.pendingAction = summarizeText(cmdDetail, 120);
      session.tldr = `⚠️ รอการตัดสินใจจากคุณ: ${summarizeText(cmdDetail, 160)}`;

      if (!session.interactivePrompt) {
        session.interactivePrompt = {
          question: `อนุญาตให้ดำเนินการ "${summarizeText(cmdDetail, 90)}" หรือไม่?`,
          context: toolName ? [`Tool: ${toolName}`] : [],
          currentIndex: 1,
          options: [
            {
              index: 1,
              number: '1',
              label: 'Yes (อนุญาตครั้งนี้)',
              active: true,
            },
            {
              index: 2,
              number: '2',
              label: "Yes, and don't ask again (อนุญาตเสมอในโปรเจกต์นี้)",
              active: false,
            },
            {
              index: 3,
              number: '3',
              label: 'No (ปฏิเสธและสั่งให้ทำวิธีอื่น)',
              active: false,
            },
          ],
          footer: 'Enter to confirm · Esc to cancel',
        };
      }
      pushTimeline(session.tldr, 'Needs Choice', 'warning');
    } else if (hookEvent === 'Stop') {
      this._finishTurn(session, now, payload.summary || payload.last_assistant_message);
    } else if (hookEvent === 'SessionEnd') {
      session.lifecycle = 'history';
      session.isProcessAlive = false;
      session.closedAt = now;
      session.pid = null;
      session.status = 'closed';
      session.statusLabel = 'ปิด Tab ไปแล้ว • กู้คืนได้';
      session.pendingAction = null;
      session.interactivePrompt = null;
      session.currentTool = 'Closed';
      pushTimeline(
        'ปิด Session Terminal แล้ว (บันทึกไว้ในประวัติ สามารถกด Resume ได้)',
        'SessionEnd',
        'info'
      );
    }

    // Any of these means a permission prompt reported earlier has been answered or abandoned.
    if (['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionEnd'].includes(hookEvent)) {
      session.hookPromptAt = null;
      session.promptOnScreen = false;
      session.permissionDetail = null;
    }

    // The last moment anything said this room is working; a transcript turn end after it means done.
    if (session.status === 'working') {
      session.workingSignalAt = now;
    }

    this._enrichSessionFromTranscript(session);
    this._deduplicateSessions();

    this._emitChange('hook_event', { sessionId: session.id, hookEvent });
    return session;
  }

  /** Claude asked AskUserQuestion: show every question, exactly as written; the screen adds the cursor. */
  _openAsk(session, toolInput, toolUseId, at) {
    const questions = sanitizeQuestions(toolInput && toolInput.questions);
    if (!questions) return;
    session.pendingAsk = { id: String(toolUseId || ''), questions, at };
    session.interactivePrompt = promptFromQuestions(questions);
    session.status = 'needs_input';
    session.statusLabel = askStatusLabel(session.interactivePrompt);
    session.pendingAction = questions[0].question || 'Claude ต้องการให้คุณเลือกคำตอบ';
    session.tldr = `⚠️ Claude ถามคุณ${questions.length > 1 ? ` ${questions.length} ข้อ` : ''}: ${questions[0].question}`;
  }

  /** A turn is over: from the Stop hook, or from the transcript when no hook reports it. */
  _finishTurn(session, at, summary = null) {
    session.status = 'done';
    session.statusLabel = 'เสร็จสิ้น (รอบคำสั่ง)';
    session.pendingAction = null;
    session.interactivePrompt = null;
    session.stageIndex = 3;
    session.currentTool = 'Ready';
    session.workingSignalAt = null;
    session.pendingAsk = null;
    session.hookPromptAt = null;
    session.promptOnScreen = false;
    session.permissionDetail = null;
    for (const sub of session.subAgents) {
      if (sub.state === 'working') {
        sub.state = 'done';
        sub.tool = 'Completed';
      }
    }
    if (summary) {
      session.tldr = summarizeText(summary, 220);
    }
    this._archiveTurnIntoHistory(session, {
      goal: session.goal,
      tldr: session.tldr,
      timestamp: at,
      sessionId: session.claudeSessionId || session.id,
    });
    session.recentEvents.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: at,
      event: 'Stop',
      title: 'ทำงานครบรอบคำสั่งแล้ว พร้อมรับคำสั่งถัดไป',
      badge: 'Done',
      level: 'success',
    });
    if (session.recentEvents.length > 30) session.recentEvents.length = 30;
  }

  enqueueCommand(sessionId, commandText) {
    if (!this.commandQueues.has(sessionId)) {
      this.commandQueues.set(sessionId, []);
    }
    const item = {
      id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      command: commandText,
      createdAt: new Date().toISOString(),
    };
    this.commandQueues.get(sessionId).push(item);
    return item;
  }

  dequeueCommands(sessionId) {
    const queue = this.commandQueues.get(sessionId) || [];
    this.commandQueues.set(sessionId, []);
    return queue;
  }

  updateSession(sessionId, patch = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (patch.room && patch.room !== session.room) {
      patch.customNamed = true;
    }
    Object.assign(session, patch, { updatedAt: new Date().toISOString() });
    this._emitChange('session_updated', { sessionId });
    return session;
  }

  /**
   * Manual room order from the dashboard: each known id takes its position in `ids`.
   * The UI sorts by status first and uses this order inside each status group.
   */
  reorderSessions(ids) {
    let position = 0;
    let moved = 0;
    for (const id of ids) {
      const session = this.sessions.get(id);
      if (!session) continue;
      if (session.sortOrder !== position) {
        session.sortOrder = position;
        moved += 1;
      }
      position += 1;
    }
    if (moved) this._emitChange('sessions_reordered', { moved });
    return moved;
  }

  archiveOrRemoveSession(sessionId, permanent = false) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (permanent || session.lifecycle === 'history') {
      this.sessions.delete(sessionId);
      this._emitChange('session_removed', { sessionId });
      return true;
    }
    session.lifecycle = 'history';
    session.isProcessAlive = false;
    session.closedAt = new Date().toISOString();
    session.updatedAt = new Date().toISOString();
    session.status = 'closed';
    session.statusLabel = 'เก็บเข้าประวัติแล้ว • กู้คืนได้';
    session.interactivePrompt = null;
    session.pendingAction = null;
    this._emitChange('session_archived', { sessionId });
    return true;
  }

  clearHistoryOnly() {
    for (const [id, s] of this.sessions.entries()) {
      if (s.lifecycle === 'history' && !s.pinned) {
        this.sessions.delete(id);
      }
    }
    this._emitChange('history_cleared', {});
  }

  getSnapshot() {
    const list = Array.from(this.sessions.values()).sort((a, b) => {
      if (a.lifecycle !== b.lifecycle) {
        return a.lifecycle === 'live' ? -1 : 1;
      }
      if (Boolean(a.pinned) !== Boolean(b.pinned)) {
        return a.pinned ? -1 : 1;
      }
      const rank = {
        needs_input: 0,
        error: 1,
        working: 2,
        idle: 3,
        done: 4,
        closed: 5,
      };
      const rA = rank[a.status] ?? 5;
      const rB = rank[b.status] ?? 5;
      if (rA !== rB) return rA - rB;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });

    const liveList = list.filter((s) => s.lifecycle === 'live');
    const historyList = list.filter((s) => s.lifecycle === 'history');
    const projects = Array.from(
      new Set(list.map((s) => s.project || 'General'))
    ).sort();
    const categories = Array.from(
      new Set(list.map((s) => s.category || 'General'))
    ).sort();

    const metrics = {
      totalRooms: list.length,
      liveRooms: liveList.length,
      historyRooms: historyList.length,
      pinnedRooms: list.filter((s) => s.pinned).length,
      needsInput: liveList.filter((s) => s.status === 'needs_input').length,
      working: liveList.filter((s) => s.status === 'working').length,
      done: liveList.filter((s) => s.status === 'done' || s.status === 'idle')
        .length,
      activeSubAgents: liveList.reduce(
        (sum, s) =>
          sum +
          (Array.isArray(s.subAgents)
            ? s.subAgents.filter(
                (sub) => sub.state === 'working' || sub.state === 'waiting'
              ).length
            : 0),
        0
      ),
      totalSubAgents: list.reduce(
        (sum, s) => sum + (Array.isArray(s.subAgents) ? s.subAgents.length : 0),
        0
      ),
      totalTokens: list.reduce(
        (sum, s) => sum + Number((s.tokenUsage && s.tokenUsage.totalTokens) || 0),
        0
      ),
      totalCostUsd:
        Math.round(
          list.reduce(
            (sum, s) =>
              sum + Number((s.tokenUsage && s.tokenUsage.estimatedCostUsd) || 0),
            0
          ) * 10000
        ) / 10000,
    };

    return {
      stages: STAGES,
      metrics,
      usageGuard: this.usageGuard ? this.usageGuard.getUsageSummary() : null,
      projects,
      categories,
      sessions: list,
    };
  }
}

module.exports = { StateStore, STAGES };
