const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { StateStore } = require('./state-store');
const { CommandBridge } = require('./command-bridge');
const {
  checkHooksStatus,
  installClaudeHooks,
  uninstallClaudeHooks,
} = require('./hook-installer');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function createMissionControlServer(options = {}) {
  const store = options.store || new StateStore(options);
  const bridge = new CommandBridge(store);
  const publicDir = path.resolve(__dirname, '..', 'public');
  const sseClients = new Set();

  // Ingest any offline events spooled while server was closed
  const offlineFile = path.join(
    os.homedir(),
    '.agent-mission-control',
    'offline-events.jsonl'
  );
  if (fs.existsSync(offlineFile)) {
    try {
      const lines = fs
        .readFileSync(offlineFile, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean);
      for (const line of lines) {
        try {
          store.processHookEvent(JSON.parse(line));
        } catch {
          // Ignore malformed line
        }
      }
      fs.unlinkSync(offlineFile);
    } catch {
      // Ignore
    }
  }

  // Broadcast state updates to all connected browser dashboards via SSE
  store.on('change', (eventPayload) => {
    const data = JSON.stringify(eventPayload);
    for (const res of sseClients) {
      try {
        res.write(`data: ${data}\n\n`);
      } catch {
        sseClients.delete(res);
      }
    }
  });

  function sendJson(res, statusCode, data) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(body);
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 2 * 1024 * 1024) {
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        if (!raw.trim()) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    try {
      // 1. SSE Real-time Event Stream
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
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
          ...store.getSnapshot(),
        });
      }

      // 3. Receive Claude Hook / Agent Telemetry Event
      if (req.method === 'POST' && pathname === '/api/hook') {
        const payload = await readJsonBody(req);
        const session = store.processHookEvent(payload);
        const pendingCommands = store.dequeueCommands(session.id);
        return sendJson(res, 200, {
          ok: true,
          sessionId: session.id,
          pendingCommands,
        });
      }

      // 4. Poll pending commands (for `amc run` CLI wrapper)
      if (req.method === 'GET' && pathname === '/api/session/commands') {
        const sessionId = parsedUrl.searchParams.get('sessionId');
        const commands = sessionId ? store.dequeueCommands(sessionId) : [];
        return sendJson(res, 200, { ok: true, commands });
      }

      // 5. Dispatch Command / Approval from Dashboard to a Session
      if (req.method === 'POST' && pathname === '/api/session/command') {
        const body = await readJsonBody(req);
        if (!body.sessionId || !body.command) {
          return sendJson(res, 400, {
            ok: false,
            error: 'Missing sessionId or command',
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

      // 6. Create / Spawn a New Agent Room
      if (req.method === 'POST' && pathname === '/api/session/spawn') {
        const body = await readJsonBody(req);
        const sessionId = body.sessionId || `room-${Date.now()}`;
        const cwd = body.cwd || process.cwd();
        const roomName =
          body.room || `Room ${String(store.sessions.size + 1).padStart(2, '0')} • ${path.basename(cwd)}`;

        const session = store.getOrCreateSession(sessionId, {
          room: roomName,
          cwd,
          cli: body.cli || 'claude-code',
          goal: body.goal || 'เปิดห้องทำงานใหม่จาก Mission Control',
          status: body.goal ? 'working' : 'idle',
          statusLabel: body.goal ? 'กำลังเริ่มงาน' : 'พร้อมรับคำสั่ง',
        });

        let launchResult = null;
        if (body.openTerminal) {
          launchResult = await bridge.openTerminalTab(session.id, {
            cwd,
            room: roomName,
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

      // 7. Open / Focus Windows Terminal Tab for an existing Room
      if (req.method === 'POST' && pathname === '/api/session/open-terminal') {
        const body = await readJsonBody(req);
        const result = await bridge.openTerminalTab(body.sessionId, body);
        return sendJson(res, 200, result);
      }

      // 8. Update or Remove a Session Room
      if (req.method === 'POST' && pathname === '/api/session/update') {
        const body = await readJsonBody(req);
        if (body.action === 'remove' && body.sessionId) {
          store.removeSession(body.sessionId);
          return sendJson(res, 200, { ok: true });
        }
        if (body.action === 'clear-all') {
          store.clearAll();
          return sendJson(res, 200, { ok: true });
        }
        const updated = store.updateSession(body.sessionId, body.patch || {});
        return sendJson(res, 200, { ok: true, session: updated });
      }

      // 9. Seed Demo Multi-Agent Rooms
      if (req.method === 'POST' && pathname === '/api/demo/seed') {
        const snapshot = store.seedDemoSessions();
        return sendJson(res, 200, { ok: true, ...snapshot });
      }

      // 10. Check / Install Claude Code Hooks
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

      // 11. Static Files (public/index.html, public/app.js)
      let filePath =
        pathname === '/'
          ? path.join(publicDir, 'index.html')
          : path.join(publicDir, pathname);

      // Prevent directory traversal
      if (!filePath.startsWith(publicDir)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        return fs.createReadStream(filePath).pipe(res);
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  });

  return { server, store, bridge };
}

module.exports = { createMissionControlServer };
