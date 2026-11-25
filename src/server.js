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
} = require('./transcript-parser');
const {
  checkHooksStatus,
  installClaudeHooks,
  uninstallClaudeHooks,
  checkStatuslineStatus,
  installStatusline,
} = require('./hook-installer');
const {
  TOKEN_HEADER,
  loadOrCreateToken,
  isAllowedHost,
  isAllowedOrigin,
  tokensEqual,
} = require('./security');

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

  function isAuthorized(req, parsedUrl) {
    if (tokensEqual(req.headers[TOKEN_HEADER], token)) return true;
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
          hooks: checkHooksStatus(),
          statusline: checkStatuslineStatus(),
          ...store.getSnapshot(),
        });
      }

      // 3. Receive Claude Hook / Agent Telemetry Event
      if (req.method === 'POST' && pathname === '/api/hook') {
        const payload = await readJsonBody(req);
        const eventName = payload.hook_event_name || payload.event;
        if (eventName === 'UserPromptSubmit' && usageGuard.isHolding()) {
          // The hook script turns this into a {"decision":"block"} answer for Claude Code.
          const summary = usageGuard.getUsageSummary();
          const resumeAt = summary.resetAt
            ? new Date(summary.resetAt).toLocaleTimeString('th-TH', {
                hour: '2-digit',
                minute: '2-digit',
              })
            : '-';
          return sendJson(res, 200, {
            ok: true,
            hold: {
              resumeAt: summary.resetAt,
              reason: `Mission Control พักงานไว้: usage เหลือ ${summary.remainingPct}% (ต่ำกว่า ${summary.autoPauseThresholdPct}%) จะทำงานต่ออัตโนมัติราว ${resumeAt} หรือกด "ทำต่อเลย" ใน dashboard`,
            },
          });
        }
        const session = store.processHookEvent(payload);
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
        return sendJson(res, 200, { ok: true, ...checkHooksStatus() });
      }
      if (req.method === 'POST' && pathname === '/api/hooks/install') {
        const status = installClaudeHooks();
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
          sessionId: body.session_id,
          cwd: body.cwd,
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
