const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const {
  getGitMetadata,
  parseTranscriptTail,
  summarizeText,
  inferWorkflowFromTool,
} = require('./transcript-parser');
const { parseConsoleScreen } = require('./console-scanner');

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

class StateStore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.dataDir =
      options.dataDir || path.join(os.homedir(), '.agent-mission-control');
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
            this.sessions.set(s.id, s);
          }
          this._deduplicateSessionsByCwd();
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
  _deduplicateSessionsByCwd() {
    const byCwd = new Map();
    const unknownCwdSessions = [];

    for (const s of Array.from(this.sessions.values())) {
      if (s.cwd) s.cwd = sanitizeCwd(s.cwd);
      const key = normalizeCwdKey(s.cwd);
      if (!key) {
        unknownCwdSessions.push(s);
        continue;
      }
      if (!byCwd.has(key)) {
        byCwd.set(key, []);
      }
      byCwd.get(key).push(s);
    }

    for (const [, group] of byCwd.entries()) {
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

  _enrichSessionFromTranscript(session) {
    if (!session) return;
    const parsed = parseTranscriptTail(session.transcriptPath, session.cwd);
    if (!parsed) return;

    if (parsed.transcriptPath) {
      session.transcriptPath = parsed.transcriptPath;
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
  _findMatchingSession({ sessionId, pid, cwd }) {
    if (cwd) {
      const norm = normalizeCwdKey(cwd);
      if (norm) {
        for (const s of this.sessions.values()) {
          if (normalizeCwdKey(s.cwd) === norm) {
            return s;
          }
        }
      }
    }
    if (sessionId && this.sessions.has(String(sessionId))) {
      return this.sessions.get(String(sessionId));
    }
    if (pid) {
      for (const s of this.sessions.values()) {
        if (s.pid && Number(s.pid) === Number(pid)) {
          return s;
        }
      }
    }
    if (pid && !cwd) {
      const liveSessions = Array.from(this.sessions.values()).filter(
        (s) => s.lifecycle === 'live'
      );
      if (liveSessions.length === 1) {
        return liveSessions[0];
      }
    }
    return null;
  }

  getOrCreateSession(sessionId, defaults = {}) {
    const cleanCwd = sanitizeCwd(defaults.cwd);
    const existing = this._findMatchingSession({
      sessionId,
      pid: defaults.pid,
      cwd: cleanCwd || undefined,
    });
    if (existing) {
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

      const parsed = parseConsoleScreen(item.screen);
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

      const session = this.getOrCreateSession(`claude-pid-${numericPid}`, {
        pid: numericPid,
        cwd: cwd || undefined,
        room: cwd ? project : `Claude Tab (PID ${numericPid})`,
        project: cwd ? project : 'Terminal Session',
        category: cwd ? category : 'CLI',
        cli: cliLabel,
      });

      const prevStateSig = JSON.stringify({
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
        session.interactivePrompt = parsed.interactivePrompt;
        session.status = 'needs_input';
        session.statusLabel = `รอคุณเลือกตอบ (${parsed.interactivePrompt.options.length} ตัวเลือก)`;
        session.pendingAction = parsed.interactivePrompt.question;
        session.tldr = `⚠️ ${parsed.interactivePrompt.question} — คลิกเลือกตัวเลือก (${parsed.interactivePrompt.options
          .map((o) => `${o.number}. ${o.label}`)
          .join(' / ')}) จากด้านล่างได้เลย`;
      } else if (session.interactivePrompt) {
        session.interactivePrompt = null;
        session.pendingAction = null;
        if (session.status === 'needs_input') {
          session.status = 'idle';
          session.statusLabel = 'พร้อมรับคำสั่ง';
          this._enrichSessionFromTranscript(session);
        }
      }

      const nextStateSig = JSON.stringify({
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

    this._deduplicateSessionsByCwd();

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

  processHookEvent(payload = {}) {
    const rawSessionId = payload.session_id || payload.sessionId || null;
    const isUuid =
      rawSessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(rawSessionId));
    const cleanCwd = sanitizeCwd(payload.cwd);

    const lookupId =
      rawSessionId ||
      payload.room_id ||
      (payload.pid ? `claude-pid-${payload.pid}` : null) ||
      `cwd-${Buffer.from(String(cleanCwd || 'default')).toString('hex').slice(0, 10)}`;

    const session = this.getOrCreateSession(lookupId, {
      cwd: cleanCwd,
      room: payload.room,
      claudeSessionId: isUuid ? String(rawSessionId) : null,
      cli:
        payload.cli ||
        (payload.pane_id ? `claude (pane #${payload.pane_id})` : 'claude-code'),
      paneId: payload.pane_id || null,
      wtSession: payload.wt_session || null,
      pid: payload.pid || null,
    });

    const now = new Date().toISOString();
    session.updatedAt = now;
    if (isUuid) {
      session.claudeSessionId = String(rawSessionId);
    }
    if (cleanCwd) {
      session.cwd = cleanCwd;
      const meta = this._inferProjectMeta(cleanCwd);
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

      // Archive previous completed/active interaction into internal taskHistory before starting the new turn!
      if (
        session.goal &&
        !DEFAULT_GOALS.has(session.goal) &&
        session.goal !== newGoal
      ) {
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
      session.stageIndex = 0;
      session.currentTool = 'Thinking...';
      session.tldr = `รับคำสั่งใหม่: "${summarizeText(promptText, 120)}" — กำลังวิเคราะห์และวางแผนขั้นตอน`;
      pushTimeline(`คำสั่งใหม่: ${summarizeText(promptText, 90)}`, 'Prompt', 'primary');
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
        const qObj = Array.isArray(toolInput.questions)
          ? toolInput.questions[0]
          : toolInput;
        const opts = Array.isArray(qObj.options) ? qObj.options : [];
        if (opts.length > 0) {
          session.status = 'needs_input';
          session.statusLabel = `รอคุณเลือกตอบ (${opts.length} ตัวเลือก)`;
          session.pendingAction =
            qObj.question || 'Claude ต้องการให้คุณเลือกคำตอบ';
          session.interactivePrompt = {
            question: qObj.question || 'กรุณาเลือกแนวทางที่ต้องการ:',
            context: qObj.header ? [qObj.header] : [],
            currentIndex: 1,
            options: opts.map((o, idx) => ({
              index: idx + 1,
              number: String(idx + 1),
              label:
                typeof o === 'string'
                  ? o
                  : `${o.label || o.title || ''}${o.description ? ' — ' + o.description : ''}`,
              active: idx === 0,
            })),
            footer: 'คลิกปุ่มตัวเลือกด้านล่างเพื่อส่งคำตอบเข้า Terminal ทันที',
          };
        }
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
      hookEvent === 'PermissionRequest' ||
      hookEvent === 'Notification'
    ) {
      const cmdDetail =
        (toolInput && (toolInput.command || toolInput.file_path)) ||
        payload.message ||
        payload.title ||
        (toolName
          ? `ขอสิทธิ์รัน ${toolName}`
          : 'Claude กำลังรอให้คุณเลือกคำตอบหรือกดยืนยัน');

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
      session.status = 'done';
      session.statusLabel = 'เสร็จสิ้น (รอบคำสั่ง)';
      session.pendingAction = null;
      session.interactivePrompt = null;
      session.stageIndex = 3;
      session.currentTool = 'Ready';
      for (const sub of session.subAgents) {
        if (sub.state === 'working') {
          sub.state = 'done';
          sub.tool = 'Completed';
        }
      }
      if (payload.summary || payload.last_assistant_message) {
        session.tldr = summarizeText(
          payload.summary || payload.last_assistant_message,
          220
        );
      }
      this._archiveTurnIntoHistory(session, {
        goal: session.goal,
        tldr: session.tldr,
        timestamp: now,
        sessionId: session.claudeSessionId || session.id,
      });
      pushTimeline('ทำงานครบรอบคำสั่งแล้ว พร้อมรับคำสั่งถัดไป', 'Done', 'success');
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

    this._enrichSessionFromTranscript(session);
    this._deduplicateSessionsByCwd();

    this._emitChange('hook_event', { sessionId: session.id, hookEvent });
    return session;
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
    };

    return {
      stages: STAGES,
      metrics,
      projects,
      categories,
      sessions: list,
    };
  }
}

module.exports = { StateStore, STAGES };
