const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BRIDGE_SCRIPT = path.resolve(__dirname, 'win-console-bridge.ps1');

/**
 * Sanitizes a raw path candidate extracted from terminal output
 * (e.g. strips `> claude` from PowerShell prompt `PS C:\Repo\agent-mission-control> claude`)
 * and verifies that it is a real existing directory on disk.
 */
function extractValidDirectory(line) {
  if (!line || typeof line !== 'string') return null;
  const pathMatch = line.match(/([A-Za-z]:\\[^\r\n>|]+)/);
  if (!pathMatch) return null;

  let candidate = pathMatch[1].trim();
  // Remove trailing punctuation or quotes
  candidate = candidate.replace(/["'`.,;]+$/, '').trim();

  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch {
    // Ignore invalid path
  }
  return null;
}

/**
 * Parses a raw Windows Console Screen Buffer dump from `claude.exe` to extract:
 * - Verified workspace directory (`cwd`)
 * - Model / version info (`Claude Code v2.1.332`, `Opus 5.5`)
 * - Interactive multiple-choice TUI prompts
 * - Clean last lines for live terminal preview
 */
function parseConsoleScreen(rawScreen) {
  if (!rawScreen || typeof rawScreen !== 'string') {
    return null;
  }

  const lines = rawScreen
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''));

  while (lines.length > 0 && !lines[lines.length - 1].trim()) {
    lines.pop();
  }

  if (lines.length === 0) return null;

  let detectedCwd = null;
  let detectedVersion = null;
  let detectedModel = null;

  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const line = lines[i];
    const verMatch = line.match(/Claude Code\s+(v[\d\.]+)/i);
    if (verMatch) {
      detectedVersion = verMatch[1];
    }
    const modelMatch = line.match(/(Opus|Sonnet|Haiku)\s+[\d\.]+[^│\r\n]*/i);
    if (modelMatch) {
      detectedModel = modelMatch[0].trim();
    }
    if (!detectedCwd) {
      const validDir = extractValidDirectory(line);
      if (validDir) {
        detectedCwd = validDir;
      }
    }
  }

  const tailStart = Math.max(0, lines.length - 30);
  const tailLines = lines.slice(tailStart);

  const optionRegex = /^\s*([❯>●\*])?\s*(\d+)[\.\)]\s+(.+)$/;
  const options = [];
  let firstOptionLineIdx = -1;
  let lastOptionLineIdx = -1;
  let currentIndex = 1;

  for (let i = 0; i < tailLines.length; i++) {
    const line = tailLines[i];
    const m = line.match(optionRegex);
    if (m) {
      const hasCursor = Boolean(m[1]);
      const num = m[2];
      const label = m[3].trim();

      const expectedIndex = options.length + 1;
      if (
        Number(num) === expectedIndex ||
        (options.length === 0 && Number(num) === 1)
      ) {
        if (options.length === 0) {
          firstOptionLineIdx = i;
        }
        lastOptionLineIdx = i;
        const optIndex = options.length + 1;
        if (hasCursor) {
          currentIndex = optIndex;
        }
        options.push({
          index: optIndex,
          number: String(num),
          label,
          active: hasCursor,
        });
      } else if (Number(num) === 1) {
        options.length = 0;
        firstOptionLineIdx = i;
        lastOptionLineIdx = i;
        currentIndex = 1;
        options.push({
          index: 1,
          number: '1',
          label,
          active: hasCursor,
        });
      }
    }
  }

  let interactivePrompt = null;

  if (options.length >= 2 && tailLines.length - lastOptionLineIdx <= 6) {
    if (!options.some((o) => o.active)) {
      options[0].active = true;
      currentIndex = 1;
    }

    let sectionStart = 0;
    for (let i = firstOptionLineIdx - 1; i >= 0; i--) {
      if (/[─━═]{8,}/.test(tailLines[i])) {
        sectionStart = i + 1;
        break;
      }
    }

    const headerLines = tailLines
      .slice(sectionStart, firstOptionLineIdx)
      .map((l) => l.trim())
      .filter((l) => l && !/[─━═]{8,}/.test(l));

    const question =
      headerLines.find((l) => l.endsWith('?') || l.endsWith(':')) ||
      headerLines[0] ||
      'Claude กำลังรอให้คุณเลือกคำตอบ';

    const context = headerLines.filter((l) => l !== question).slice(-5);

    const footerLines = tailLines
      .slice(lastOptionLineIdx + 1)
      .map((l) => l.trim())
      .filter(Boolean);

    interactivePrompt = {
      question,
      context,
      currentIndex,
      options,
      footer: footerLines.join(' · ') || 'Enter to confirm · Esc to cancel',
    };
  }

  const previewLines = lines.slice(-18).join('\n');

  return {
    cwd: detectedCwd,
    version: detectedVersion,
    model: detectedModel,
    interactivePrompt,
    screenPreview: previewLines,
  };
}

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE_SCRIPT];

/**
 * One-shot fallback: starts a fresh PowerShell (and recompiles the C# bridge) per call.
 * Only used when the persistent bridge cannot be started.
 */
function invokeWinConsoleBridge(args = [], timeoutMs = 4500) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !fs.existsSync(BRIDGE_SCRIPT)) {
      return resolve({ ok: false, items: [] });
    }

    const tmpFile = path.join(
      os.tmpdir(),
      `amc-bridge-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`
    );

    execFile(
      'powershell.exe',
      [...POWERSHELL_ARGS, ...args, '-OutputFile', tmpFile],
      { timeout: timeoutMs, windowsHide: true },
      () => {
        try {
          const raw = fs.readFileSync(tmpFile, 'utf8');
          return resolve(JSON.parse(raw));
        } catch {
          resolve({ ok: false, items: [] });
        } finally {
          fs.rm(tmpFile, { force: true }, () => {});
        }
      }
    );
  });
}

/** Maps a request object to the one-shot script's command-line parameters. */
function toBridgeArgs(request) {
  const args = ['-Action', request.action];
  if (request.targetPid) args.push('-TargetPid', String(request.targetPid));
  if (request.currentIndex) args.push('-CurrentIndex', String(request.currentIndex));
  if (request.targetIndex) args.push('-TargetIndex', String(request.targetIndex));
  // `-Value:<text>` binds the value even when the text itself starts with "-".
  if (request.value !== undefined) args.push(`-Value:${request.value}`);
  return args;
}

/**
 * Keeps a single PowerShell process alive in `-Action serve` mode so the C# console bridge is
 * compiled once instead of on every scan (PowerShell 5.1 start-up + Add-Type costs ~1s of CPU).
 * Requests are newline-delimited JSON and answered strictly in order.
 */
class PersistentBridge {
  constructor(options = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs || 8000;
    this.child = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.failures = 0;
    this.disabledUntil = 0;
  }

  _start() {
    if (this.ready) return this.ready;

    this.ready = new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn('powershell.exe', [...POWERSHELL_ARGS, '-Action', 'serve'], {
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        });
      } catch (err) {
        return reject(err);
      }
      this.child = child;
      this.buffer = '';

      const startTimer = setTimeout(() => {
        reject(new Error('Bridge start-up timed out'));
        if (this.child === child) this._teardown(new Error('Bridge start-up timed out'));
      }, 20000);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        this.buffer += chunk;
        let newline;
        while ((newline = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, newline).trim();
          this.buffer = this.buffer.slice(newline + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.ready) {
            clearTimeout(startTimer);
            this.failures = 0;
            resolve();
            continue;
          }
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            entry.resolve(msg);
          }
        }
      });

      child.stdin.on('error', () => {});
      child.on('error', (err) => {
        clearTimeout(startTimer);
        reject(err);
        if (this.child === child) this._teardown(err);
      });
      child.on('exit', () => {
        clearTimeout(startTimer);
        reject(new Error('Bridge exited'));
        if (this.child === child) this._teardown(new Error('Bridge exited'));
      });
    });

    // Avoid unhandled rejections when nobody is awaiting the start-up promise.
    this.ready.catch(() => {});
    return this.ready;
  }

  _teardown(err) {
    const child = this.child;
    this.child = null;
    this.ready = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: err.message, items: [] });
    }
    this.pending.clear();
    if (child && child.exitCode === null) {
      try {
        child.kill();
      } catch {}
    }
    // Back off after repeated crashes so a broken environment does not respawn PowerShell forever.
    this.failures += 1;
    if (this.failures >= 3) {
      this.disabledUntil = Date.now() + 60000;
      this.failures = 0;
    }
  }

  get available() {
    return Date.now() >= this.disabledUntil;
  }

  async request(request) {
    await this._start();
    const child = this.child;
    if (!child) throw new Error('Bridge not running');
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'Bridge request timed out', items: [] });
        // A hung request (e.g. stuck AttachConsole) poisons the ordered stream: restart.
        this._teardown(new Error('Bridge request timed out'));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, timer });
      child.stdin.write(`${JSON.stringify({ id, ...request })}\n`, 'utf8');
    });
  }

  stop() {
    if (this.child) {
      try {
        this.child.stdin.end();
      } catch {}
    }
    this._teardown(new Error('Bridge stopped'));
    this.failures = 0;
    this.disabledUntil = 0;
  }
}

class ConsoleScanner {
  constructor(stateStore, options = {}) {
    this.store = stateStore;
    this.intervalMs = options.intervalMs || 1800;
    this.timer = null;
    this.scanning = false;
    this.bridge = options.bridge || new PersistentBridge();
  }

  /** Sends a request through the persistent bridge, falling back to a one-shot process. */
  async _call(request) {
    if (process.platform !== 'win32' || !fs.existsSync(BRIDGE_SCRIPT)) {
      return { ok: false, items: [] };
    }
    if (this.bridge.available) {
      try {
        return await this.bridge.request(request);
      } catch {
        // fall through to the one-shot path
      }
    }
    return invokeWinConsoleBridge(toBridgeArgs(request));
  }

  start() {
    if (this.timer || process.platform !== 'win32') return;
    this.scanOnce();
    this.timer = setInterval(() => {
      this.scanOnce();
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.bridge.stop();
  }

  async scanOnce() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const result = await this._call({ action: 'scan' });
      if (result && result.ok && Array.isArray(result.items)) {
        this.store.ingestConsoleScan(result.items);
      }
    } catch {
      // Ignore scan errors
    } finally {
      this.scanning = false;
    }
  }

  _rescanSoon(delayMs) {
    setTimeout(() => this.scanOnce(), delayMs);
  }

  async selectOption(pid, currentIndex, targetIndex, numberValue) {
    const res = await this._call({
      action: 'select-option',
      targetPid: Number(pid),
      currentIndex: currentIndex || 1,
      targetIndex: targetIndex || 1,
      value: String(numberValue || targetIndex || '1'),
    });
    this._rescanSoon(250);
    return res;
  }

  async sendKey(pid, keyName) {
    const res = await this._call({
      action: 'send-key',
      targetPid: Number(pid),
      value: String(keyName),
    });
    this._rescanSoon(250);
    return res;
  }

  async sendText(pid, text) {
    const res = await this._call({
      action: 'send-text',
      targetPid: Number(pid),
      value: String(text),
    });
    this._rescanSoon(300);
    return res;
  }
}

module.exports = {
  extractValidDirectory,
  parseConsoleScreen,
  invokeWinConsoleBridge,
  PersistentBridge,
  ConsoleScanner,
};
