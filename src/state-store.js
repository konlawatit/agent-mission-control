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

class StateStore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.dataDir =
      options.dataDir || path.join(os.homedir(), '.agent-mission-control');
    this.stateFile = path.join(this.dataDir, 'sessions-state.json');
    this.sessions = new Map();
    this.commandQueues = new Map();
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
            this.sessions.set(s.id, s);
          }
        }
      }
    } catch {
      // Ignore corrupt state file on startup
    }
  }

  _saveToDisk() {
    try {
      const payload = {
        updatedAt: new Date().toISOString(),
        sessions: Array.from(this.sessions.values()),
      };
      fs.writeFileSync(this.stateFile, JSON.stringify(payload, null, 2), 'utf8');
    } catch {
      // Non-fatal persistence error
    }
  }

  _emitChange(eventType = 'state_updated', detail = {}) {
    this._saveToDisk();
    this.emit('change', {
      type: eventType,
      detail,
      snapshot: this.getSnapshot(),
    });
  }

  /**
   * Finds an existing session matching pid or normalized cwd to avoid duplicate cards
   * when merging live console buffer scans with Claude Code hooks.
   */
  _findMatchingSession({ sessionId, pid, cwd }) {
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
    if (cwd) {
      const norm = String(cwd).toLowerCase().replace(/[\\\/]+$/, '');
      for (const s of this.sessions.values()) {
        if (
          s.cwd &&
          String(s.cwd).toLowerCase().replace(/[\\\/]+$/, '') === norm &&
          !s.id.startsWith('room-') // Don't overwrite demo rooms unless exact ID
        ) {
          return s;
        }
      }
    }
    return null;
  }

  getOrCreateSession(sessionId, defaults = {}) {
    const existing = this._findMatchingSession({
      sessionId,
      pid: defaults.pid,
      cwd: defaults.cwd,
    });
    if (existing) {
      return existing;
    }

    const id = String(sessionId || `room-${Date.now()}`);
    const cwd = defaults.cwd || process.cwd();
    const folderName = path.basename(cwd) || 'workspace';
    const roomNum = String(this.sessions.size + 1).padStart(2, '0');
    const gitMeta = getGitMetadata(cwd);

    const created = {
      id,
      room: defaults.room || `Room ${roomNum} • ${folderName}`,
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
      goal: defaults.goal || 'รอคำสั่งเริ่มต้น...',
      tldr:
        defaults.tldr ||
        'เปิด Session เรียบร้อย พร้อมรับคำสั่งผ่าน Terminal หรือสั่งการจากหน้า Dashboard',
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
      transcriptPath: defaults.transcriptPath || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(id, created);
    return created;
  }

  /**
   * Ingests live Windows Console Screen Buffer scans from running `claude.exe` processes.
   * Detects TUI interactive choice menus (`❯ 1. Yes, try it / 2. Not now`, permission menus, etc.)
   * even before any Claude lifecycle hook fires!
   */
  ingestConsoleScan(scanItems = []) {
    if (!Array.isArray(scanItems)) return;
    let changed = false;

    for (const item of scanItems) {
      if (!item || !item.pid || !item.screen) continue;
      const parsed = parseConsoleScreen(item.screen);
      if (!parsed) continue;

      const cwd = parsed.cwd || null;
      const folderName = cwd ? path.basename(cwd) : `PID-${item.pid}`;
      const cliLabel = [
        'claude',
        parsed.version || '',
        parsed.model ? `(${parsed.model.split('·')[0].trim()})` : `(PID ${item.pid})`,
      ]
        .filter(Boolean)
        .join(' ');

      const session = this.getOrCreateSession(`claude-pid-${item.pid}`, {
        pid: item.pid,
        cwd: cwd || process.cwd(),
        room: `Room • ${folderName}`,
        cli: cliLabel,
      });

      const prevPromptJson = JSON.stringify(session.interactivePrompt);
      const prevPreview = session.screenPreview;

      session.pid = item.pid;
      session.cli = cliLabel;
      if (cwd && (session.cwd === process.cwd() || !session.cwd)) {
        session.cwd = cwd;
        session.room = `Room • ${path.basename(cwd)}`;
        const gitMeta = getGitMetadata(cwd);
        session.branch = gitMeta.branch;
        session.dirtyFiles = gitMeta.dirtyFiles;
      }

      session.screenPreview = parsed.screenPreview;

      if (parsed.interactivePrompt) {
        session.interactivePrompt = parsed.interactivePrompt;
        session.status = 'needs_input';
        session.statusLabel = `รอคุณเลือกตอบ (${parsed.interactivePrompt.options.length} ตัวเลือก)`;
        session.pendingAction = parsed.interactivePrompt.question;
        session.tldr = `⚠️ ${parsed.interactivePrompt.question} — คลิกเลือกตัวเลือก (${parsed.interactivePrompt.options
          .map((o) => `${o.number}. ${o.label}`)
          .join(' / ')}) จากด้านล่างได้เลย`;
      } else if (session.interactivePrompt && !session.id.startsWith('room-')) {
        // The TUI menu on this console tab was answered and cleared!
        session.interactivePrompt = null;
        session.pendingAction = null;
        if (session.status === 'needs_input') {
          session.status = 'idle';
          session.statusLabel = 'พร้อมรับคำสั่ง';
          session.tldr = 'ส่งคำตอบเข้า Terminal เรียบร้อย พร้อมพิมพ์คำสั่งถัดไป';
        }
      }

      if (
        JSON.stringify(session.interactivePrompt) !== prevPromptJson ||
        session.screenPreview !== prevPreview
      ) {
        session.updatedAt = new Date().toISOString();
        changed = true;
      }
    }

    if (changed) {
      this._emitChange('console_scan_updated', {});
    }
  }

  /**
   * Processes incoming lifecycle events from Claude Code Hooks or CLI wrappers.
   */
  processHookEvent(payload = {}) {
    const sessionId =
      payload.session_id ||
      payload.sessionId ||
      payload.room_id ||
      (payload.pid ? `claude-pid-${payload.pid}` : null) ||
      `cwd-${Buffer.from(String(payload.cwd || 'default')).toString('hex').slice(0, 10)}`;

    const session = this.getOrCreateSession(sessionId, {
      cwd: payload.cwd,
      room: payload.room,
      cli:
        payload.cli ||
        (payload.pane_id ? `claude (pane #${payload.pane_id})` : 'claude-code'),
      paneId: payload.pane_id || null,
      wtSession: payload.wt_session || null,
      pid: payload.pid || null,
    });

    const now = new Date().toISOString();
    session.updatedAt = now;
    if (payload.cwd) session.cwd = payload.cwd;
    if (payload.pane_id) session.paneId = payload.pane_id;
    if (payload.wt_session) session.wtSession = payload.wt_session;
    if (payload.pid && !session.pid) session.pid = payload.pid;
    if (payload.transcript_path) session.transcriptPath = payload.transcript_path;
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

    const pushTimeline = (title, badge, level = 'info') => {
      session.recentEvents.unshift({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: now,
        event: hookEvent,
        title,
        badge,
        level,
      });
      if (session.recentEvents.length > 25) {
        session.recentEvents.length = 25;
      }
    };

    if (hookEvent === 'SessionStart') {
      session.status = 'idle';
      session.statusLabel = 'เปิดห้องใหม่';
      session.tldr = 'เปิด Claude Session พร้อมเริ่มงาน';
      pushTimeline('เริ่มต้น Session ใน ' + session.cwd, 'SessionStart', 'info');
    } else if (hookEvent === 'UserPromptSubmit') {
      const promptText =
        payload.prompt ||
        payload.user_prompt ||
        payload.message ||
        'รับคำสั่งใหม่จากผู้ใช้';
      session.goal = summarizeText(promptText, 160);
      session.status = 'working';
      session.statusLabel = 'กำลังวางแผน & ทำงาน';
      session.pendingAction = null;
      session.interactivePrompt = null;
      session.stageIndex = 0;
      session.currentTool = 'Thinking...';
      session.tldr = `รับคำสั่ง: "${summarizeText(promptText, 120)}" — กำลังวิเคราะห์และวางแผนขั้นตอน`;
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
        if (session.modifiedFiles.length > 15) session.modifiedFiles.length = 15;
      }

      // If Claude calls AskUserQuestion tool with options, surface them as interactive buttons!
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
          session.pendingAction = qObj.question || 'Claude ต้องการให้คุณเลือกคำตอบ';
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
    } else if (hookEvent === 'PermissionRequest' || hookEvent === 'Notification') {
      const cmdDetail =
        (toolInput && (toolInput.command || toolInput.file_path)) ||
        payload.message ||
        payload.title ||
        (toolName ? `ขอสิทธิ์รัน ${toolName}` : 'Claude กำลังรอให้คุณเลือกคำตอบหรือกดยืนยัน');

      session.status = 'needs_input';
      session.statusLabel = 'รอคุณเลือกตอบ / Approve';
      session.pendingAction = summarizeText(cmdDetail, 120);
      session.tldr = `⚠️ รอการตัดสินใจจากคุณ: ${summarizeText(cmdDetail, 160)}`;

      // Provide standard Claude Code permission choices if console scanner hasn't already populated more specific choices
      if (!session.interactivePrompt) {
        session.interactivePrompt = {
          question: `อนุญาตให้ดำเนินการ "${summarizeText(cmdDetail, 90)}" หรือไม่?`,
          context: toolName ? [`Tool: ${toolName}`] : [],
          currentIndex: 1,
          options: [
            { index: 1, number: '1', label: 'Yes (อนุญาตครั้งนี้)', active: true },
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
      pushTimeline('ทำงานครบรอบคำสั่งแล้ว พร้อมรับคำสั่งถัดไป', 'Done', 'success');
    } else if (hookEvent === 'SessionEnd') {
      session.status = 'done';
      session.statusLabel = 'ปิด Session แล้ว';
      session.pendingAction = null;
      session.interactivePrompt = null;
      session.currentTool = 'Closed';
      pushTimeline('ปิด Session Terminal แล้ว', 'SessionEnd', 'info');
    }

    if (session.transcriptPath) {
      const parsed = parseTranscriptTail(session.transcriptPath);
      if (parsed) {
        if (
          parsed.lastAssistantText &&
          (hookEvent === 'Stop' || hookEvent === 'PostToolUse')
        ) {
          session.tldr = parsed.lastAssistantText;
        }
        if (parsed.lastUserText && session.goal === 'รอคำสั่งเริ่มต้น...') {
          session.goal = parsed.lastUserText;
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
    }

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
    Object.assign(session, patch, { updatedAt: new Date().toISOString() });
    this._emitChange('session_updated', { sessionId });
    return session;
  }

  removeSession(sessionId) {
    const deleted = this.sessions.delete(sessionId);
    if (deleted) {
      this._emitChange('session_removed', { sessionId });
    }
    return deleted;
  }

  clearAll() {
    this.sessions.clear();
    this._emitChange('cleared', {});
  }

  seedDemoSessions() {
    // Keep any real live `claude-pid-*` sessions that were already discovered!
    const liveSessions = Array.from(this.sessions.values()).filter(
      (s) => s.pid && String(s.id).startsWith('claude-pid-')
    );
    this.sessions.clear();
    for (const live of liveSessions) {
      this.sessions.set(live.id, live);
    }

    const now = new Date().toISOString();

    const demoData = [
      {
        id: 'room-auth-oauth2',
        room: 'Room 01 • auth-service',
        cli: 'claude (pane #1)',
        cwd: 'C:\\Repo\\agent-mission-control',
        branch: 'feat/oauth-pkce',
        dirtyFiles: 4,
        paneId: '1',
        status: 'needs_input',
        statusLabel: 'รอคุณเลือกตอบ (3 ตัวเลือก)',
        goal: 'เพิ่มระบบ OAuth2 PKCE และแยก Middleware ตรวจสอบ JWT Refresh Token',
        tldr: 'แก้ไฟล์ src/auth/pkce.ts เสร็จแล้ว กำลังรอให้คุณเลือกอนุมัติการรัน npm run test:integration',
        pendingAction: 'Do you want to run integration tests for OAuth2 PKCE flow?',
        interactivePrompt: {
          question: 'Do you want to proceed with running npm run test:integration?',
          context: [
            'Bash command: npm run test:integration -- --grep "PKCE flow"',
            'Directory: C:\\Repo\\agent-mission-control',
          ],
          currentIndex: 1,
          options: [
            { index: 1, number: '1', label: 'Yes (รันชุดทดสอบนี้ทันที)', active: true },
            {
              index: 2,
              number: '2',
              label: "Yes, and don't ask again for npm test commands",
              active: false,
            },
            {
              index: 3,
              number: '3',
              label: 'No, skip tests and review code diff first (esc)',
              active: false,
            },
          ],
          footer: 'Enter to confirm · Esc to cancel',
        },
        stageIndex: 2,
        currentTool: 'Bash (Waiting Choice)',
        modifiedFiles: [
          'src/auth/pkce.ts',
          'src/middleware/jwt.ts',
          'test/auth.integration.test.ts',
        ],
        subAgents: [
          {
            id: 'sub-101',
            name: 'Sub-Agent: Security Auditor',
            role: 'ตรวจสอบช่องโหว่ CSRF และ Token Leakage ใน OAuth Callback',
            subagentType: 'security-review',
            state: 'done',
            tool: 'Completed (ไม่พบช่องโหว่)',
            startedAt: now,
          },
          {
            id: 'sub-102',
            name: 'Sub-Agent: Integration Test Runner',
            role: 'เตรียม Mock OAuth Provider และรันชุดทดสอบ',
            subagentType: 'test-runner',
            state: 'waiting',
            tool: 'Waiting Selection',
            startedAt: now,
          },
        ],
        recentEvents: [
          {
            id: 'ev-1',
            timestamp: now,
            event: 'PermissionRequest',
            title: 'รอเลือกตัวเลือก: รันคำสั่ง npm run test:integration',
            badge: '3 Options',
            level: 'warning',
          },
          {
            id: 'ev-2',
            timestamp: now,
            event: 'PreToolUse',
            title: 'แก้ไขไฟล์ src/auth/pkce.ts เพิ่ม code_verifier validation',
            badge: 'Edit: pkce.ts',
            level: 'info',
          },
        ],
      },
      {
        id: 'room-payment-webhook',
        room: 'Room 02 • payment-api',
        cli: 'claude (pane #2)',
        cwd: 'C:\\Repo\\agent-mission-control',
        branch: 'feat/stripe-retry-queue',
        dirtyFiles: 6,
        paneId: '2',
        status: 'working',
        statusLabel: 'กำลังทำงาน (2 Sub-agents)',
        goal: 'สร้างระบบรับ Stripe Webhook พร้อม Dead-Letter Queue เวลาประมวลผลล้มเหลว',
        tldr: 'แตก Sub-agent 2 ตัวทำงานขนานกัน: ตัวแรกกำลังเขียน Webhook Signature Verifier ส่วนตัวที่สองกำลังสร้างตาราง Retry Queue',
        pendingAction: null,
        interactivePrompt: null,
        stageIndex: 1,
        currentTool: 'Sub-Agent: Webhook Coder',
        modifiedFiles: [
          'src/webhooks/stripe-handler.ts',
          'src/queue/retry-worker.ts',
          'prisma/schema.prisma',
        ],
        subAgents: [
          {
            id: 'sub-201',
            name: 'Sub-Agent: Webhook Handler Coder',
            role: 'เขียนระบบตรวจลายเซ็น Stripe และ Idempotency Key',
            subagentType: 'coder',
            state: 'working',
            tool: 'Edit: stripe-handler.ts',
            startedAt: now,
          },
          {
            id: 'sub-202',
            name: 'Sub-Agent: Queue & Fixture Builder',
            role: 'จำลอง Payload payment_intent.succeeded และสร้าง BullMQ Worker',
            subagentType: 'coder',
            state: 'working',
            tool: 'Write: retry-worker.ts',
            startedAt: now,
          },
          {
            id: 'sub-203',
            name: 'Sub-Agent: Codebase Explorer',
            role: 'สำรวจโครงสร้าง Event Bus เดิมของระบบจ่ายเงิน',
            subagentType: 'explore',
            state: 'done',
            tool: 'Completed',
            startedAt: now,
          },
        ],
        recentEvents: [
          {
            id: 'ev-3',
            timestamp: now,
            event: 'PreToolUse',
            title: 'แตก Sub-Agent: Queue & Fixture Builder',
            badge: 'Sub-Agent',
            level: 'primary',
          },
          {
            id: 'ev-4',
            timestamp: now,
            event: 'PreToolUse',
            title: 'กำลังแก้ไขไฟล์ src/webhooks/stripe-handler.ts',
            badge: 'Edit: stripe-handler.ts',
            level: 'info',
          },
        ],
      },
      {
        id: 'room-frontend-perf',
        room: 'Room 03 • dashboard-ui',
        cli: 'claude (pane #3)',
        cwd: 'C:\\Repo\\agent-mission-control',
        branch: 'fix/chart-rerender',
        dirtyFiles: 2,
        paneId: '3',
        status: 'working',
        statusLabel: 'กำลังรันเทส E2E',
        goal: 'แก้อาการกราฟกระพริบและลด Re-render หน้า Real-time Analytics',
        tldr: 'แยก State ของ Filter ออกจาก Chart Canvas เรียบร้อย กำลังรัน Playwright E2E เพื่อตรวจค่า FPS และ Memory Leak',
        pendingAction: null,
        interactivePrompt: null,
        stageIndex: 2,
        currentTool: 'Bash: npx playwright test',
        modifiedFiles: [
          'src/components/AnalyticsChart.tsx',
          'src/hooks/useRealtimeStream.ts',
        ],
        subAgents: [
          {
            id: 'sub-301',
            name: 'Sub-Agent: UI Performance Verifier',
            role: 'รัน Playwright ตรวจสอบการกระพริบของ Canvas ตอนข้อมูลไหลเข้า',
            subagentType: 'verifier',
            state: 'working',
            tool: 'Bash: npx playwright test',
            startedAt: now,
          },
        ],
        recentEvents: [
          {
            id: 'ev-5',
            timestamp: now,
            event: 'PreToolUse',
            title: 'กำลังรันทดสอบ Playwright E2E บนหน้า Analytics',
            badge: 'Bash: playwright',
            level: 'info',
          },
        ],
      },
      {
        id: 'room-db-index',
        room: 'Room 04 • db-optimizer',
        cli: 'claude (pane #4)',
        cwd: 'C:\\Repo\\agent-mission-control',
        branch: 'chore/orders-composite-idx',
        dirtyFiles: 1,
        paneId: '4',
        status: 'done',
        statusLabel: 'เสร็จสิ้น • รอคำสั่งถัดไป',
        goal: 'วิเคราะห์ Slow Query ตาราง orders และสร้าง Composite Index',
        tldr: 'สร้าง Migration เพิ่ม Index (tenant_id, status, created_at) และวัดผลด้วย EXPLAIN ANALYZE แล้ว เวลา Query ลดลงจาก 420ms เหลือ 18ms พร้อมเปิด PR',
        pendingAction: null,
        interactivePrompt: null,
        stageIndex: 3,
        currentTool: 'Ready',
        modifiedFiles: ['migrations/20261125_add_orders_composite_idx.sql'],
        subAgents: [
          {
            id: 'sub-401',
            name: 'Sub-Agent: SQL Query Benchmarker',
            role: 'เปรียบเทียบ Execution Plan ก่อนและหลังใส่ Composite Index',
            subagentType: 'analyzer',
            state: 'done',
            tool: 'Completed (เร็วขึ้น 95%)',
            startedAt: now,
          },
        ],
        recentEvents: [
          {
            id: 'ev-6',
            timestamp: now,
            event: 'Stop',
            title: 'ทำงานครบรอบคำสั่งแล้ว พร้อมเปิด Pull Request',
            badge: 'Done',
            level: 'success',
          },
        ],
      },
    ];

    for (const item of demoData) {
      if (!this.sessions.has(item.id)) {
        this.sessions.set(item.id, {
          ...item,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    this._emitChange('demo_seeded', {});
    return this.getSnapshot();
  }

  getSnapshot() {
    const list = Array.from(this.sessions.values()).sort((a, b) => {
      const rank = { needs_input: 0, error: 1, working: 2, idle: 3, done: 4 };
      const rA = rank[a.status] ?? 5;
      const rB = rank[b.status] ?? 5;
      if (rA !== rB) return rA - rB;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });

    const metrics = {
      totalRooms: list.length,
      needsInput: list.filter((s) => s.status === 'needs_input').length,
      working: list.filter((s) => s.status === 'working').length,
      done: list.filter((s) => s.status === 'done').length,
      activeSubAgents: list.reduce(
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
      sessions: list,
    };
  }
}

module.exports = { StateStore, STAGES };
