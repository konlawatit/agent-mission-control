const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BRIDGE_SCRIPT = path.resolve(__dirname, 'win-console-bridge.ps1');

/**
 * Parses a raw Windows Console Screen Buffer dump from `claude.exe` to extract:
 * - Workspace directory (`cwd`) from the Claude banner if visible
 * - Model / version info (`Claude Code v2.1.332`, `Opus 5.5`)
 * - Interactive multiple-choice TUI prompts (e.g. `❯ 1. Yes, try it` / `2. Not now`,
 *   Permission prompts `1. Yes` / `2. Yes, and don't ask again` / `3. No`,
 *   or AskUserQuestion menus)
 * - Clean last lines for live terminal preview
 */
function parseConsoleScreen(rawScreen) {
  if (!rawScreen || typeof rawScreen !== 'string') {
    return null;
  }

  const lines = rawScreen
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''));

  // Trim trailing blank lines
  while (lines.length > 0 && !lines[lines.length - 1].trim()) {
    lines.pop();
  }

  if (lines.length === 0) return null;

  let detectedCwd = null;
  let detectedVersion = null;
  let detectedModel = null;

  // Scan top banner lines for Claude Code version, model, and workspace directory
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const line = lines[i];
    const verMatch = line.match(/Claude Code\s+(v[\d\.]+)/i);
    if (verMatch) {
      detectedVersion = verMatch[1];
    }
    const modelMatch = line.match(/(Opus|Sonnet|Haiku)\s+[\d\.]+[^│\r\n]*/i);
    if (modelMatch) {
      detectedModel = modelMatch[0].trim();
    }
    const pathMatch = line.match(/([A-Za-z]:\\[^\r\n]+)/);
    if (pathMatch) {
      const candidate = pathMatch[1].trim();
      if (fs.existsSync(candidate)) {
        detectedCwd = candidate;
      } else {
        detectedCwd = candidate;
      }
    }
  }

  // Detect interactive choice menu in the bottom 30 lines
  const tailStart = Math.max(0, lines.length - 30);
  const tailLines = lines.slice(tailStart);

  // Look for numbered options like:
  //   ❯ 1. Yes, try it
  //     2. Not now
  // or
  //   > 1. Yes
  //     2. Yes, allow all
  //     3. No
  const optionRegex = /^\s*([❯>●\*])?\s*(\d+)[\.\)]\s+(.+)$/;
  const options = [];
  let firstOptionLineIdx = -1;
  let lastOptionLineIdx = -1;
  let currentIndex = 1;

  for (let i = 0; i < tailLines.length; i++) {
    const line = tailLines[i];
    // Skip lines that are inside markdown numbered lists far above if separated by prompt box
    const m = line.match(optionRegex);
    if (m) {
      const hasCursor = Boolean(m[1]);
      const num = m[2];
      const label = m[3].trim();

      // Ensure sequential option numbers (1, 2, 3...)
      const expectedIndex = options.length + 1;
      if (Number(num) === expectedIndex || (options.length === 0 && Number(num) === 1)) {
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
        // Start of a newer menu lower down on the screen
        options.length = 0;
        firstOptionLineIdx = i;
        lastOptionLineIdx = i;
        currentIndex = hasCursor ? 1 : 1;
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

  // Validate that the detected options are an active bottom TUI menu
  // (i.e. near the bottom of the screen, not followed by a normal prompt input box far below)
  if (options.length >= 2 && tailLines.length - lastOptionLineIdx <= 6) {
    // If none had an explicit cursor character matched, mark the first option active by default
    if (!options.some((o) => o.active)) {
      options[0].active = true;
      currentIndex = 1;
    }

    // Extract question & context lines above firstOptionLineIdx
    // Find the last horizontal divider (────) above firstOptionLineIdx
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

/**
 * Invokes `win-console-bridge.ps1` with a temporary JSON output file.
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
    // Re-scan after 250ms so the UI updates immediately
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
  parseConsoleScreen,
  invokeWinConsoleBridge,
  ConsoleScanner,
};
