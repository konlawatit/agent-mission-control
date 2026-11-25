const { execFile } = require('child_process');
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

function invokeWinConsoleBridge(args = [], timeoutMs = 4500) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !fs.existsSync(BRIDGE_SCRIPT)) {
      return resolve({ ok: false, items: [] });
    }

    const tmpFile = path.join(
      os.tmpdir(),
      `amc-bridge-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`
    );

    const psArgs = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      BRIDGE_SCRIPT,
      ...args,
      '-OutputFile',
      tmpFile,
    ];

    execFile('powershell.exe', psArgs, { timeout: timeoutMs }, () => {
      try {
        if (fs.existsSync(tmpFile)) {
          const raw = fs.readFileSync(tmpFile, 'utf8');
          fs.unlinkSync(tmpFile);
          const parsed = JSON.parse(raw);
          return resolve(parsed);
        }
      } catch {
        try {
          if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        } catch {}
      }
      resolve({ ok: false, items: [] });
    });
  });
}

class ConsoleScanner {
  constructor(stateStore, options = {}) {
    this.store = stateStore;
    this.intervalMs = options.intervalMs || 1800;
    this.timer = null;
    this.scanning = false;
  }

  start() {
    if (this.timer || process.platform !== 'win32') return;
    this.scanOnce();
    this.timer = setInterval(() => {
      this.scanOnce();
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async scanOnce() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const result = await invokeWinConsoleBridge(['-Action', 'scan']);
      if (result && result.ok && Array.isArray(result.items)) {
        this.store.ingestConsoleScan(result.items);
      }
    } catch {
      // Ignore scan errors
    } finally {
      this.scanning = false;
    }
  }

  async selectOption(pid, currentIndex, targetIndex, numberValue) {
    const res = await invokeWinConsoleBridge([
      '-Action',
      'select-option',
      '-TargetPid',
      String(pid),
      '-CurrentIndex',
      String(currentIndex || 1),
      '-TargetIndex',
      String(targetIndex || 1),
      '-Value',
      String(numberValue || targetIndex || '1'),
    ]);
    setTimeout(() => this.scanOnce(), 250);
    return res;
  }

  async sendKey(pid, keyName) {
    const res = await invokeWinConsoleBridge([
      '-Action',
      'send-key',
      '-TargetPid',
      String(pid),
      '-Value',
      String(keyName),
    ]);
    setTimeout(() => this.scanOnce(), 250);
    return res;
  }

  async sendText(pid, text) {
    const res = await invokeWinConsoleBridge([
      '-Action',
      'send-text',
      '-TargetPid',
      String(pid),
      '-Value',
      String(text),
    ]);
    setTimeout(() => this.scanOnce(), 300);
    return res;
  }
}

module.exports = {
  extractValidDirectory,
  parseConsoleScreen,
  invokeWinConsoleBridge,
  ConsoleScanner,
};
