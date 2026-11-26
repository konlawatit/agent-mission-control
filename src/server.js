const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { StateStore } = require('./state-store');
const { CommandBridge } = require('./command-bridge');
const { ConsoleScanner } = require('./console-scanner');
const { UsageGuard } = require('./usage-guard');
const {
  getWorkspaceChangedFiles,
  getWorkspaceFileDetail,
  isAutomatedEntrypoint,
  transcriptEntrypoint,
  readConversationPage,
  readConversationForward,
  entryEndOffset,
  transcriptMeta,
  findTranscriptById,
} = require('./transcript-parser');
const {
  checkHooksStatus,
  installClaudeHooks,
  uninstallClaudeHooks,
  checkStatuslineStatus,
  installStatusline,
  HOOK_ENDPOINT_PATH,
} = require('./hook-installer');
const { lookupClaudeSession } = require('./claude-sessions');
const {
  TOKEN_HEADER,
  loadOrCreateToken,
  deriveHookToken,
  isAllowedHost,
  isAllowedOrigin,
  tokensEqual,
} = require('./security');
const { MAX_ATTACHMENT_BYTES, saveAttachment, pruneAttachments } = require('./attachments');
const { AutomatedRuns, DEFAULT_WINDOW_HOURS, MAX_WINDOW_HOURS } = require('./automated-runs');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SSE_THROTTLE_MS = 120;
const EDITABLE_FIELDS = ['room', 'category', 'goal', 'pinned'];
const MAX_REORDER_IDS = 1000;
const MAX_PROMPT_POSITION = 30; // arrow-key positions in a terminal prompt

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Returns the resolved path when `dir` is an existing directory, otherwise null. */
function safeDirectory(dir) {
  if (!dir || typeof dir !== 'string') return null;
  try {
    const resolved = path.resolve(dir);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/** Copies only the whitelisted, user-editable fields of a session patch. */
function pickEditableFields(patch) {
  const out = {};
  for (const key of EDITABLE_FIELDS) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
      out[key] =
        key === 'pinned'
          ? Boolean(patch[key])
          : String(patch[key] ?? '').slice(0, 300);
    }
  }
  return out;
}

function createMissionControlServer(options = {}) {
  const store = options.store || new StateStore(options);
  const token = options.token || loadOrCreateToken(options.tokenFile);
  const scanner = options.disableScanner
    ? null
    : new ConsoleScanner(store, { intervalMs: options.scanIntervalMs || 1800 });
  const bridge = new CommandBridge(store, scanner);
  const usageGuard = new UsageGuard(store, bridge);
  store.usageGuard = usageGuard;
  const publicDir = path.resolve(__dirname, '..', 'public');
  const sseClients = new Set();
  // Old composer attachments (two weeks and older) are removed in the background.
  setImmediate(() => pruneAttachments(store.dataDir));

  if (scanner) {
    scanner.start();
    usageGuard.start();
  }

  // Ingest any offline events spooled while server was closed
  const offlineFile =
    options.offlineFile ||
    path.join(os.homedir(), '.agent-mission-control', 'offline-events.jsonl');
  if (fs.existsSync(offlineFile)) {
    try {
      const lines = fs
        .readFileSync(offlineFile, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean);
      for (const line of lines) {
        try {
          store.processHookEvent(JSON.parse(line));
        } catch {}
      }
      fs.unlinkSync(offlineFile);
    } catch {}
  }

  // Bursts of hook events (e.g. many PreToolUse calls in a row) are coalesced into one
  // broadcast: the dashboard only renders the latest snapshot, so intermediate ones are waste.
  let pendingBroadcast = null;
  let broadcastTimer = null;

  function flushBroadcast() {
    broadcastTimer = null;
    if (!pendingBroadcast) return;
    const data = JSON.stringify({
      ...pendingBroadcast,
      snapshot: store.getSnapshot(),
    });
    pendingBroadcast = null;
    for (const res of sseClients) {
      try {
        res.write(`data: ${data}\n\n`);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  store.on('change', (eventPayload) => {
    if (sseClients.size === 0) return;
    pendingBroadcast = { type: eventPayload.type, detail: eventPayload.detail };
    if (!broadcastTimer) {
      broadcastTimer = setTimeout(flushBroadcast, SSE_THROTTLE_MS);
    }
  });

  function sendJson(res, statusCode, data) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      // Requiring JSON forces browsers into a CORS preflight, which this server never approves.
      const contentType = String(req.headers['content-type'] || '');
      if (!/^application\/json\b/i.test(contentType)) {
        req.resume();
        return reject(
          new HttpError(415, 'Content-Type must be application/json')
        );
      }
      let raw = '';
      let size = 0;
      let aborted = false;
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        if (aborted) return;
        size += Buffer.byteLength(chunk);
        if (size > MAX_BODY_BYTES) {
          aborted = true;
          reject(new HttpError(413, 'Payload too large'));
          return;
        }
        raw += chunk;
      });
      req.on('end', () => {
        if (aborted) return;
        if (!raw.trim()) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new HttpError(400, 'Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Body of a Claude Code HTTP hook. Unlike readJsonBody it never rejects: any answer other
   * than 2xx makes Claude Code show a warning on that tool call, so a body that is too large
   * (a screenshot in `tool_response`), malformed or not JSON is read to the end and reported
   * as null.
   */
  function readHookBody(req) {
    return new Promise((resolve) => {
      const isJson = /^application\/json\b/i.test(String(req.headers['content-type'] || ''));
      let raw = '';
      let size = 0;
      let skip = !isJson;
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        if (skip) return;
        size += Buffer.byteLength(chunk);
        if (size > MAX_BODY_BYTES) {
          skip = true;
          raw = '';
          return;
        }
        raw += chunk;
      });
      req.on('end', () => {
        if (skip) return resolve(null);
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null);
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }

  /**
   * An HTTP hook carries nothing from the claude process's environment, which is where the hook
   * script (hooks/claude-hook.js) read these from. The pid comes from Claude Code's session
   * registry; the terminal ids come from headers Claude Code fills from its own environment.
   */
  function enrichHttpHookPayload(payload, headers) {
    const header = (name) => {
      const value = headers[name];
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    };
    const known = lookupClaudeSession(payload.session_id, {
      sessionsDir: options.claudeSessionsDir,
    });
    if (known) {
      if (!payload.claude_pid) payload.claude_pid = known.pid;
      if (!payload.entrypoint) payload.entrypoint = known.entrypoint;
    }
    payload.pane_id = header('x-amc-pane') || header('x-amc-tmux-pane');
    payload.wt_session = header('x-amc-wt-session');
  }

  /** What a held prompt is told, and when work resumes. */
  function holdInfo() {
    const summary = usageGuard.getUsageSummary();
    const resumeAt = summary.resetAt
      ? new Date(summary.resetAt).toLocaleTimeString('th-TH', {
          hour: '2-digit',
          minute: '2-digit',
        })
      : '-';
    return {
      resumeAt: summary.resetAt,
      reason: `Mission Control พักงานไว้: usage เหลือ ${summary.remainingPct}% (ต่ำกว่า ${summary.autoPauseThresholdPct}%) จะทำงานต่ออัตโนมัติราว ${resumeAt} หรือกด "ทำต่อเลย" ใน dashboard`,
    };
  }

  // The token written into ~/.claude/settings.json for the HTTP hooks: it opens the hook
  // endpoint and nothing else.
  const hookToken = deriveHookToken(token);

  /** Hook status for this server: hooks that post to another instance do not count. */
  function ownHooksStatus() {
    const address = server.address();
    return checkHooksStatus(address ? { port: address.port } : {});
  }

  function isAuthorized(req, parsedUrl) {
    if (tokensEqual(req.headers[TOKEN_HEADER], token)) return true;
    if (
      parsedUrl.pathname === HOOK_ENDPOINT_PATH &&
      tokensEqual(req.headers[TOKEN_HEADER], hookToken)
    ) {
      return true;
    }
    // EventSource cannot set headers, so only the SSE stream accepts the token as a query param.
    return (
      parsedUrl.pathname === '/api/events' &&
      tokensEqual(parsedUrl.searchParams.get('token'), token)
    );
  }

  function serveIndex(res) {
    const html = fs
      .readFileSync(path.join(publicDir, 'index.html'), 'utf8')
      .replace('<head>', `<head>\n  <meta name="amc-token" content="${token}" />`);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME_TYPES['.html'],
      'Cache-Control': 'no-store',
    });
    res.end(html);
  }

  // Automated runs (`claude -p`, Agent SDK) are summarised from their transcripts on request.
  const automatedRuns = options.automatedRuns || new AutomatedRuns();

  const server = http.createServer(async (req, res) => {
    // DNS-rebinding guard: a hostile domain resolving to 127.0.0.1 still sends its own Host.
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden host');
    }

    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;

    if (pathname.startsWith('/api/')) {
      if (!isAllowedOrigin(req.headers.origin)) {
        return sendJson(res, 403, { ok: false, error: 'Forbidden origin' });
      }
      if (!isAuthorized(req, parsedUrl)) {
        return sendJson(res, 401, {
          ok: false,
          error: 'Missing or invalid token',
        });
      }
    }

    try {
      // 1. SSE Real-time Event Stream
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write(
          `data: ${JSON.stringify({
            type: 'init',
            snapshot: store.getSnapshot(),
          })}\n\n`
        );
        sseClients.add(res);
        req.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }

      // 2. Full State Snapshot
      if (req.method === 'GET' && pathname === '/api/state') {
        return sendJson(res, 200, {
          ok: true,
          hooks: ownHooksStatus(),
          statusline: checkStatuslineStatus(),
          ...store.getSnapshot(),
        });
      }

      // 3. Claude Code HTTP hooks (`type: "http"`): Claude Code posts the event itself, so no
      // hook process is started. The answer is Claude Code's hook output: {} or a block decision.
      if (req.method === 'POST' && pathname === HOOK_ENDPOINT_PATH) {
        const payload = await readHookBody(req);
        if (!payload) return sendJson(res, 200, {});
        enrichHttpHookPayload(payload, req.headers);
        const automated =
          isAutomatedEntrypoint(payload.entrypoint) ||
          isAutomatedEntrypoint(transcriptEntrypoint(payload.transcript_path));
        if (
          payload.hook_event_name === 'UserPromptSubmit' &&
          usageGuard.isHolding() &&
          !automated
        ) {
          return sendJson(res, 200, { decision: 'block', reason: holdInfo().reason });
        }
        // Claude Code waits for this answer before it runs the tool: answer first, work after.
        sendJson(res, 200, {});
        setImmediate(() => {
          try {
            const session = store.processHookEvent(payload);
            if (!session) return;
            usageGuard.checkAndEnforce().catch(() => {});
            store.dequeueCommands(session.id);
          } catch {
            // One bad event must not take the server down.
          }
        });
        return;
      }

      // 3b. Hook script (SessionStart, older installs) and `amc run` wrapper events
      if (req.method === 'POST' && pathname === '/api/hook') {
        const payload = await readJsonBody(req);
        const eventName = payload.hook_event_name || payload.event;
        // `claude -p` / Agent SDK runs started by scripts and tools are not the dashboard's to
        // manage: they get no room and are never held (their own tooling decides when to stop).
        const automated =
          isAutomatedEntrypoint(payload.entrypoint) ||
          isAutomatedEntrypoint(transcriptEntrypoint(payload.transcript_path));
        if (eventName === 'UserPromptSubmit' && usageGuard.isHolding() && !automated) {
          // The hook script turns this into a {"decision":"block"} answer for Claude Code.
          return sendJson(res, 200, { ok: true, hold: holdInfo() });
        }
        const session = store.processHookEvent(payload);
        if (!session) return sendJson(res, 200, { ok: true, ignored: 'automated' });
        usageGuard.checkAndEnforce().catch(() => {});
        const pendingCommands = store.dequeueCommands(session.id);
        return sendJson(res, 200, {
          ok: true,
          sessionId: session.id,
          pendingCommands,
        });
      }

      // 4. Select an Interactive Multiple-Choice Option (1, 2, 3...)
      if (req.method === 'POST' && pathname === '/api/session/select-option') {
        const body = await readJsonBody(req);
        if (!body.sessionId) {
          return sendJson(res, 400, { ok: false, error: 'Missing sessionId' });
        }
        const result = await bridge.selectInteractiveOption(
          body.sessionId,
          body
        );
        return sendJson(res, 200, result);
      }

      // 3b. Older messages of a room's own session, a page at a time (reading back past the preview)
      if (req.method === 'GET' && pathname === '/api/session/conversation') {
        const session = store.sessions.get(parsedUrl.searchParams.get('sessionId') || '');
        if (!session) return sendJson(res, 404, { ok: false, error: 'Session not found' });
        const int = (name) => {
          const raw = parsedUrl.searchParams.get(name);
          if (raw === null || raw === '') return null;
          const n = Number(raw);
          return Number.isSafeInteger(n) && n >= 0 ? n : NaN;
        };
        const before = int('before');
        const since = int('since');
        const limit = int('limit');
        if ([before, since, limit].some(Number.isNaN) || (limit !== null && (limit < 1 || limit > 200))) {
          return sendJson(res, 400, { ok: false, error: 'Invalid paging parameters' });
        }
        // Only a Claude transcript under ~/.claude/projects is ever read here.
        const projectsDir = path.resolve(os.homedir(), '.claude', 'projects') + path.sep;
        const file = session.transcriptPath ? path.resolve(String(session.transcriptPath)) : null;
        if (!file || !file.toLowerCase().startsWith(projectsDir.toLowerCase()) || !file.endsWith('.jsonl') || !fs.existsSync(file)) {
          return sendJson(res, 200, { ok: true, lines: [], from: 0, done: true });
        }
        const page = readConversationPage(file, {
          before: before === null ? undefined : before,
          since,
          limit: limit || 40,
        });
        return sendJson(res, 200, { ok: true, ...page });
      }

      // 3c. Any Claude session's conversation by its id (search results, automated runs), paged
      //     back (`before`), forward (`after`) or ending at an entry (`at`).
      if (req.method === 'GET' && pathname === '/api/transcript') {
        const sessionId = parsedUrl.searchParams.get('sessionId') || '';
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
          return sendJson(res, 400, { ok: false, error: 'Invalid session id' });
        }
        const num = (name) => {
          const raw = parsedUrl.searchParams.get(name);
          if (raw === null || raw === '') return null;
          const n = Number(raw);
          return Number.isSafeInteger(n) && n >= 0 ? n : NaN;
        };
        const before = num('before');
        const after = num('after');
        const at = num('at');
        const since = num('since');
        const limit = num('limit');
        if ([before, after, at, since, limit].some(Number.isNaN) || (limit !== null && (limit < 1 || limit > 200))) {
          return sendJson(res, 400, { ok: false, error: 'Invalid paging parameters' });
        }
        const projectsDir = path.resolve(os.homedir(), '.claude', 'projects') + path.sep;
        const found = findTranscriptById(sessionId);
        const file = found ? path.resolve(found) : null;
        if (!file || !file.toLowerCase().startsWith(projectsDir.toLowerCase()) || !file.endsWith('.jsonl')) {
          return sendJson(res, 404, { ok: false, error: 'Transcript not found' });
        }
        const meta = { sessionId, projectDir: path.basename(path.dirname(file)), ...transcriptMeta(file) };
        if (after !== null) {
          return sendJson(res, 200, { ok: true, meta, ...readConversationForward(file, { after, limit: limit || 40 }) });
        }
        const end = at !== null ? entryEndOffset(file, at) : before;
        const page = readConversationPage(file, { before: end === null ? undefined : end, since, limit: limit || 40 });
        return sendJson(res, 200, { ok: true, meta, ...page, to: end === null ? meta.size : end });
      }

      // 4a. Attach a file or image to the next message (raw body, one file per request)
      if (req.method === 'POST' && pathname === '/api/session/attachment') {
        // Not a CORS-safelisted type, so a browser on another origin must preflight (and is refused).
        // Refusals below leave the body unread, so the connection is closed rather than reused.
        const refuse = (status, error) => {
          res.setHeader('Connection', 'close');
          req.resume();
          return sendJson(res, status, { ok: false, error });
        };
        if (!/^application\/octet-stream\b/i.test(String(req.headers['content-type'] || ''))) {
          return refuse(415, 'Content-Type must be application/octet-stream');
        }
        const sessionId = parsedUrl.searchParams.get('sessionId') || '';
        if (!store.sessions.has(sessionId)) {
          return refuse(404, 'Session not found');
        }
        if (Number(req.headers['content-length'] || 0) > MAX_ATTACHMENT_BYTES) {
          return refuse(413, 'ไฟล์ใหญ่เกิน 20 MB');
        }
        try {
          const saved = await saveAttachment(req, {
            dataDir: store.dataDir,
            sessionId,
            name: parsedUrl.searchParams.get('name') || 'file',
          });
          return sendJson(res, 200, { ok: true, ...saved });
        } catch (err) {
          const status = err.statusCode || 500;
          res.setHeader('Connection', 'close');
          return sendJson(res, status, {
            ok: false,
            error: status === 413 ? 'ไฟล์ใหญ่เกิน 20 MB' : status === 400 ? 'ไฟล์ว่าง' : 'บันทึกไฟล์ไม่สำเร็จ',
          });
        }
      }

      // 4c. Empty the terminal's input box (text left unsent there)
      if (req.method === 'POST' && pathname === '/api/session/clear-input') {
        const body = await readJsonBody(req);
        if (!body.sessionId || !store.sessions.has(body.sessionId)) {
          return sendJson(res, 404, { ok: false, error: 'Session not found' });
        }
        return sendJson(res, 200, await bridge.clearTerminalInput(body.sessionId));
      }

      // 4b. Apply a multi-select answer in one go (ticks collected on the dashboard)
      if (req.method === 'POST' && pathname === '/api/session/multi-select') {
        const body = await readJsonBody(req);
        const pos = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_PROMPT_POSITION;
        const toggles = body.toggles;
        if (
          !body.sessionId ||
          !Array.isArray(toggles) ||
          toggles.length > MAX_PROMPT_POSITION ||
          !toggles.every(pos) ||
          new Set(toggles).size !== toggles.length ||
          !pos(body.currentIndex) ||
          !(body.nextIndex == null || pos(body.nextIndex))
        ) {
          return sendJson(res, 400, { ok: false, error: 'Invalid multi-select answer' });
        }
        const result = await bridge.applyMultiSelect(body.sessionId, {
          toggles,
          currentIndex: body.currentIndex,
          nextIndex: body.nextIndex || null,
        });
        return sendJson(res, 200, result);
      }

      // 5. Send Special Terminal Navigation Key (up, down, enter, esc)
      if (req.method === 'POST' && pathname === '/api/session/send-key') {
        const body = await readJsonBody(req);
        if (!body.sessionId || !body.key) {
          return sendJson(res, 400, {
            ok: false,
            error: 'Missing sessionId or key',
          });
        }
        const result = await bridge.sendTerminalKey(body.sessionId, body.key);
        return sendJson(res, 200, result);
      }

      // 6. Trigger Immediate Console Scan
      if (req.method === 'POST' && pathname === '/api/console/scan') {
        if (scanner) {
          await scanner.scanOnce();
        }
        return sendJson(res, 200, {
          ok: true,
          ...store.getSnapshot(),
        });
      }

      // 7. Poll pending commands
      if (req.method === 'GET' && pathname === '/api/session/commands') {
        const sessionId = parsedUrl.searchParams.get('sessionId');
        const commands = sessionId ? store.dequeueCommands(sessionId) : [];
        return sendJson(res, 200, { ok: true, commands });
      }

      // 8. Dispatch Command / Approval from Dashboard to a Session
      if (req.method === 'POST' && pathname === '/api/session/command') {
        const body = await readJsonBody(req);
        if (!body.sessionId || !body.command) {
          return sendJson(res, 400, {
            ok: false,
            error: 'Missing sessionId or command',
          });
        }
        // During a quota hold only approvals go through; new prompts wait for the reset.
        if (usageGuard.isHolding() && !body.isApproval && !body.force) {
          return sendJson(res, 423, {
            ok: false,
            held: true,
            error: 'พักงานรอ usage reset อยู่ คำสั่งใหม่ยังไม่ถูกส่ง',
          });
        }
        const result = await bridge.dispatchCommand(
          body.sessionId,
          body.command,
          {
            mode: body.mode || 'auto',
            isApproval: Boolean(body.isApproval),
            runHeadless: Boolean(body.runHeadless),
            clearFirst: Boolean(body.clearFirst),
          }
        );
        return sendJson(res, 200, result);
      }

      // 9. Create / Spawn a New Agent Room
      if (req.method === 'POST' && pathname === '/api/session/spawn') {
        const body = await readJsonBody(req);
        const sessionId = body.sessionId || `session-${Date.now()}`;
        const cwd = body.cwd ? safeDirectory(body.cwd) : process.cwd();
        if (!cwd) {
          return sendJson(res, 400, {
            ok: false,
            error: `ไม่พบโฟลเดอร์: ${body.cwd}`,
          });
        }
        const folderName = path.basename(cwd) || 'Workspace';
        const roomName = body.room || folderName;

        const session = store.getOrCreateSession(sessionId, {
          room: roomName,
          category: body.category || undefined,
          cwd,
          cli: body.cli || 'claude-code',
          goal: body.goal || 'เปิดห้องทำงานใหม่จาก Mission Control',
          status: body.goal ? 'working' : 'idle',
          statusLabel: body.goal ? 'กำลังเริ่มงาน' : 'พร้อมรับคำสั่ง',
        });

        if (body.category) {
          store.updateSession(session.id, { category: body.category });
        }

        let launchResult = null;
        if (body.openTerminal) {
          launchResult = await bridge.openTerminalTab(session.id, {
            cwd,
            room: roomName,
            autoRunClaude: Boolean(body.autoRunClaude),
          });
        }
        if (body.goal && body.runHeadless) {
          await bridge.dispatchCommand(session.id, body.goal, {
            runHeadless: true,
          });
        } else {
          store._emitChange('session_spawned', { sessionId: session.id });
        }

        return sendJson(res, 200, {
          ok: true,
          session,
          launchResult,
        });
      }

      // 10. Open or Resume Session in Windows Terminal Tab
      if (
        req.method === 'POST' &&
        (pathname === '/api/session/open-terminal' ||
          pathname === '/api/session/resume')
      ) {
        const body = await readJsonBody(req);
        if (!body.sessionId) {
          return sendJson(res, 400, { ok: false, error: 'Missing sessionId' });
        }
        // Only these fields reach the launcher; the command line is always built server-side.
        const result = await bridge.openTerminalTab(body.sessionId, {
          cwd: safeDirectory(body.cwd) || undefined,
          room: typeof body.room === 'string' ? body.room : undefined,
          autoRunClaude: Boolean(body.autoRunClaude),
          resume:
            pathname === '/api/session/resume' ? true : Boolean(body.resume),
        });
        return sendJson(res, 200, result);
      }

      // 11. Update, Archive, Pin, or Remove a Session Room
      if (req.method === 'POST' && pathname === '/api/session/update') {
        const body = await readJsonBody(req);
        if (body.action === 'archive' && body.sessionId) {
          store.archiveOrRemoveSession(body.sessionId, false);
          return sendJson(res, 200, { ok: true });
        }
        if (body.action === 'remove' && body.sessionId) {
          store.archiveOrRemoveSession(body.sessionId, true);
          return sendJson(res, 200, { ok: true });
        }
        if (body.action === 'clear-history') {
          store.clearHistoryOnly();
          return sendJson(res, 200, { ok: true });
        }
        if (body.action === 'reorder') {
          const order = body.order;
          if (
            !Array.isArray(order) ||
            order.length > MAX_REORDER_IDS ||
            !order.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200)
          ) {
            return sendJson(res, 400, { ok: false, error: 'order must be a list of room ids' });
          }
          return sendJson(res, 200, { ok: true, moved: store.reorderSessions(order) });
        }
        if (!body.sessionId) {
          return sendJson(res, 400, { ok: false, error: 'Missing sessionId' });
        }
        const updated = store.updateSession(
          body.sessionId,
          pickEditableFields(body.patch || {})
        );
        if (!updated) {
          return sendJson(res, 404, { ok: false, error: 'Session not found' });
        }
        return sendJson(res, 200, { ok: true, session: updated });
      }

      // 12. Check / Install Claude Code Hooks
      if (req.method === 'GET' && pathname === '/api/hooks/status') {
        return sendJson(res, 200, { ok: true, ...ownHooksStatus() });
      }
      if (req.method === 'POST' && pathname === '/api/hooks/install') {
        // The HTTP hooks must point at this server: its port and its token.
        const status = installClaudeHooks({ port: server.address().port, token });
        return sendJson(res, 200, { ok: true, ...status });
      }
      if (req.method === 'POST' && pathname === '/api/hooks/uninstall') {
        const status = uninstallClaudeHooks();
        return sendJson(res, 200, { ok: true, ...status });
      }

      // 13. Web IDE: List Modified / Touched Workspace Files
      if (req.method === 'GET' && pathname === '/api/session/files') {
        const sessionId = parsedUrl.searchParams.get('sessionId');
        const session = sessionId ? store.sessions.get(sessionId) : null;
        if (!session) {
          return sendJson(res, 404, { ok: false, error: 'Session not found' });
        }
        const files = getWorkspaceChangedFiles(
          session.cwd,
          session.modifiedFiles
        );
        return sendJson(res, 200, { ok: true, cwd: session.cwd, files });
      }

      // 14. Web IDE: Read File Content & Unified Git Diff
      if (req.method === 'GET' && pathname === '/api/session/file-content') {
        const sessionId = parsedUrl.searchParams.get('sessionId');
        const relFile = parsedUrl.searchParams.get('file');
        const session = sessionId ? store.sessions.get(sessionId) : null;
        if (!session || !relFile) {
          return sendJson(res, 400, {
            ok: false,
            error: 'Missing sessionId or file',
          });
        }
        const detail = getWorkspaceFileDetail(session.cwd, relFile);
        return sendJson(res, detail.ok ? 200 : 403, detail);
      }

      // 15. Web IDE: Open File or Workspace in VS Code (`code --goto`)
      if (req.method === 'POST' && pathname === '/api/session/open-vscode') {
        const body = await readJsonBody(req);
        const session = body.sessionId
          ? store.sessions.get(body.sessionId)
          : null;
        if (!session || !session.cwd) {
          return sendJson(res, 404, { ok: false, error: 'Session not found' });
        }
        const baseDir = path.resolve(session.cwd);
        let targetPath = baseDir;
        if (body.file && typeof body.file === 'string') {
          const candidate = path.resolve(baseDir, body.file);
          if (
            candidate !== baseDir &&
            !candidate.startsWith(baseDir + path.sep)
          ) {
            return sendJson(res, 403, {
              ok: false,
              error: 'Path traversal denied',
            });
          }
          targetPath = candidate;
        }
        // A vscode:// link opens through the OS protocol handler, so no shell is involved.
        const stat = fs.existsSync(targetPath) ? fs.statSync(targetPath) : null;
        const line = Math.max(1, Math.min(1e6, Math.floor(Number(body.line) || 1)));
        const uriPath = targetPath
          .replace(/\\/g, '/')
          .split('/')
          .map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
          .join('/')
          .replace(/^\/+/, '');
        const uri =
          stat && stat.isFile()
            ? `vscode://file/${uriPath}:${line}:1`
            : `vscode://file/${uriPath}`;
        return sendJson(res, 200, {
          ok: true,
          targetPath,
          uri,
          message: `เปิด ${path.basename(targetPath)} ใน VS Code`,
        });
      }

      // 16. Model & Effort Switcher (`/model` and `/effort`)
      if (req.method === 'POST' && pathname === '/api/session/model-effort') {
        const body = await readJsonBody(req);
        const session = body.sessionId
          ? store.sessions.get(body.sessionId)
          : null;
        if (!session) {
          return sendJson(res, 404, { ok: false, error: 'Session not found' });
        }
        // Aliases Claude Code's /model understands, or a full model ID. No spaces are allowed,
        // so the value can never carry extra input into the terminal.
        const MODEL_ALIASES = new Set(['default', 'opus', 'sonnet', 'haiku', 'opusplan']);
        const isAllowedModel = (m) =>
          MODEL_ALIASES.has(m) || /^claude-[a-z0-9]+(-[a-z0-9]+){1,4}(\[1m\])?$/.test(m);
        const ALLOWED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

        const patch = {};
        const dispatched = [];

        if (body.model && isAllowedModel(String(body.model).toLowerCase())) {
          const m = String(body.model).toLowerCase();
          patch.model = m;
          const r = await bridge.dispatchCommand(session.id, `/model ${m}`);
          dispatched.push({ type: 'model', value: m, delivered: r.delivered });
        }
        if (
          body.effort &&
          ALLOWED_EFFORTS.has(String(body.effort).toLowerCase())
        ) {
          const eff = String(body.effort).toLowerCase();
          patch.effort = eff;
          const r = await bridge.dispatchCommand(session.id, `/effort ${eff}`);
          dispatched.push({
            type: 'effort',
            value: eff,
            delivered: r.delivered,
          });
        }

        if (dispatched.length === 0) {
          return sendJson(res, 400, { ok: false, error: 'model หรือ effort ไม่ถูกต้อง' });
        }
        // Only remember what actually reached the terminal; the transcript corrects it later.
        const deliveredPatch = {};
        for (const d of dispatched) {
          if (d.delivered) deliveredPatch[d.type] = d.value;
        }
        if (Object.keys(deliveredPatch).length > 0) {
          store.updateSession(session.id, deliveredPatch);
        }

        return sendJson(res, 200, {
          ok: true,
          delivered: dispatched.every((d) => d.delivered),
          dispatched,
          session: store.sessions.get(session.id),
        });
      }

      // 17. Usage Quota & <8% Auto-Pause Guard Endpoints
      if (req.method === 'GET' && pathname === '/api/usage') {
        return sendJson(res, 200, {
          ok: true,
          usage: usageGuard.getUsageSummary(),
        });
      }
      if (req.method === 'POST' && pathname === '/api/usage/config') {
        const body = await readJsonBody(req);
        if (body.action === 'simulate-low-quota') {
          return sendJson(res, 200, await usageGuard.simulateLowQuota(6.5));
        }
        if (body.action === 'reset-and-resume') {
          return sendJson(res, 200, await usageGuard.resumeAll());
        }
        const summary = await usageGuard.updateConfig(body);
        return sendJson(res, 200, { ok: true, usage: summary });
      }

      // 18. Statusline bridge: real plan usage (rate_limits) and model from Claude Code
      if (req.method === 'POST' && pathname === '/api/usage/observed') {
        const body = await readJsonBody(req);
        const accepted = usageGuard.observe(body.rate_limits);
        const session = store._findMatchingSession({
          pid: Number(body.claude_pid) || undefined,
          claudeSessionId: typeof body.session_id === 'string' ? body.session_id : undefined,
          cwd: body.cwd,
          matchFolder: true,
        });
        if (session) {
          const modelId =
            body.model && typeof body.model.id === 'string' ? body.model.id : null;
          if (modelId && modelId.length < 80) session.model = modelId;
          const cw = body.context_window;
          if (cw && Number.isFinite(Number(cw.used_percentage))) {
            session.liveContext = {
              usedPct: Math.max(0, Math.min(100, Number(cw.used_percentage))),
              size: Number(cw.context_window_size) || null,
              at: new Date().toISOString(),
            };
          }
        }
        if (accepted || session) {
          store._emitChange('usage_observed', {});
          usageGuard.checkAndEnforce().catch(() => {});
        }
        return sendJson(res, 200, { ok: true, accepted });
      }
      if (req.method === 'POST' && pathname === '/api/statusline/install') {
        const status = installStatusline();
        return sendJson(res, status.error ? 500 : 200, { ok: !status.error, ...status });
      }

      // ---------- Automated runs: GET /api/automated?hours=24 ----------
      // `claude -p` / Agent SDK runs per working folder: runs per hour, tokens, failures and the
      // longest idle gap. Reads only .jsonl transcripts under ~/.claude/projects (src/automated-runs).
      if (req.method === 'GET' && pathname === '/api/automated') {
        const raw = parsedUrl.searchParams.get('hours');
        const hours = raw === null || raw === '' ? DEFAULT_WINDOW_HOURS : Number(raw);
        if (!Number.isSafeInteger(hours) || hours < 1 || hours > MAX_WINDOW_HOURS) {
          return sendJson(res, 400, { ok: false, error: `hours must be a whole number from 1 to ${MAX_WINDOW_HOURS}` });
        }
        return sendJson(res, 200, { ok: true, ...(await automatedRuns.summary({ hours })) });
      }

      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });
      }

      // 13. Static Files (index.html is rendered with the API token embedded)
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
      }
      if (pathname === '/' || pathname === '/index.html') {
        return serveIndex(res);
      }

      const filePath = path.join(publicDir, pathname);
      if (!filePath.startsWith(publicDir + path.sep)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        return fs.createReadStream(filePath).pipe(res);
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err) {
      if (res.headersSent) return res.end();
      sendJson(res, err.statusCode || 500, { ok: false, error: err.message });
    }
  });

  server.on('close', () => {
    if (scanner) scanner.stop();
    if (usageGuard) usageGuard.stop();
    if (broadcastTimer) clearTimeout(broadcastTimer);
    store.flush();
  });

  return { server, store, bridge, scanner, usageGuard, token };
}

module.exports = { createMissionControlServer };
