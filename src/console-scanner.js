const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { modelIdFromText } = require('./transcript-parser');

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
/**
 * What sits in Claude Code's input box (the rows between the last two horizontal rules, the first
 * starting with ❯): '' when empty, null when no input box is on screen. Text the dashboard
 * typed that never got sent stays here, and a new message would be appended to it.
 */
function parseInputBox(lines, cursor = {}) {
  const rules = [];
  lines.forEach((l, i) => {
    if (/^\s*[─━]{20,}\s*$/.test(l)) rules.push(i);
  });
  if (rules.length < 2) return null;
  const firstRow = rules[rules.length - 2] + 1;
  const box = lines.slice(firstRow, rules[rules.length - 1]);
  if (!box.length || !/^\s*❯/.test(box[0])) return null;
  const text = [box[0].replace(/^\s*❯\s?/, ''), ...box.slice(1).map((l) => l.replace(/^ {0,2}/, ''))]
    .join('\n')
    .replace(/\s+$/, '');
  if (!text.trim()) return '';
  // An empty box can show a suggested next prompt (dim, but the console reports no faint colour).
  // The caret then sits at the start of the box, before that text; typed text has it after.
  const caretAtStart = cursor.cursorRow === firstRow && Number(cursor.cursorCol) <= box[0].indexOf('❯') + 2;
  if (caretAtStart || /^Try "/.test(text.trim())) return '';
  return text;
}

// The row after a multi-select question's checkboxes that moves on ("❯ Next" when the cursor is on it).
const NEXT_ROW_RE = /^\s*([❯>])?\s*Next\s*$/;

// Only prompts say this; the working spinner says "esc to interrupt", which must not match.
const PROMPT_KEY_HINT_RE = /Esc to cancel|Enter to (?:select|confirm)/i;

/** An option line can carry a preview box to its right; keep only the option text. */
function stripSidePanel(text) {
  const m = text.match(/\s{3,}[─-╿]/);
  return m ? text.slice(0, m.index) : text;
}

const TAB_MARKS = '☐☑☒✔✓■□';
const TAB_MARK_RE = new RegExp(`[${TAB_MARKS}]`);

function isQuestionTabBar(line) {
  return /[←→]/.test(line) && TAB_MARK_RE.test(line);
}

/** Tabs of a multi-question prompt in order, each answered or not (☐ = not yet). */
function parseQuestionTabs(line) {
  const re = new RegExp(`([${TAB_MARKS}])\\s+([^${TAB_MARKS}←→]+)`, 'g');
  return Array.from(line.matchAll(re), (m) => ({
    name: m[2].trim(),
    done: m[1] !== '☐' && m[1] !== '□',
  }));
}

/** A multi-select option reads "[ ] label" or "☐ label"; keep the label and whether it is ticked. */
function splitCheckbox(label) {
  const m = label.match(/^(?:\[([ xX✔✓])\]|([☐☑☒◯◉]))\s+(.*)$/);
  if (!m) return { label };
  const mark = m[1] !== undefined ? m[1] : m[2];
  return { label: m[3], checked: !(mark === ' ' || mark === '☐' || mark === '◯') };
}

// The first line of Claude Code's start-up banner: the logo with "Claude Code v2.1.332" beside it
// (or the boxed "✻ Welcome to Claude Code!" of older versions). Only the logo makes it the banner;
// a reply that mentions "Claude Code v2.1" is not.
const BANNER_RE = /[▐▛▜▌▝▘▗▖▙▟█].*Claude Code v\d|✻ Welcome to Claude Code/;
// The model line under the logo: "Opus 5.5 · API Usage Billing", "Sonnet 5.5 · Claude Max".
const BANNER_MODEL_RE = /\b(?:Opus|Sonnet|Haiku|Fable|Mythos)\s+\d+(?:\.\d+)?/i;
// What /model prints when it is done: "⎿  Set model to Sonnet 5.5", "⎿  Kept model as Opus 5.5".
const MODEL_SET_RE = /⎿\s+(?:Set model to|Kept model as)\s+(.+)/i;
// The working spinner above the input box: "✶ Cogitating… (5s · ↓ 120 tokens)". A finished turn
// leaves "✻ Worked for 5s", without the ellipsis.
const SPINNER_RE = /^\s*[·✢✳✶✻✽*]\s+\S[^…]{0,60}…/;

/** Index of the last start-up banner on screen (where this Claude session's output begins), or -1. */
function findBanner(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!BANNER_RE.test(lines[i])) continue;
    // The boxed banner starts at the box's top edge, one line up.
    return i > 0 && /^\s*╭─/.test(lines[i - 1]) ? i - 1 : i;
  }
  return -1;
}

/**
 * Whether Claude is in the middle of a turn: "esc to interrupt" in the footer, or the spinner
 * just above the input box.
 */
function isBusyScreen(lines) {
  if (lines.slice(-6).some((l) => /esc to interrupt/i.test(l))) return true;
  const rules = [];
  lines.forEach((l, i) => {
    if (/^\s*[─━]{20,}\s*$/.test(l)) rules.push(i);
  });
  const boxTop = rules.length >= 2 ? rules[rules.length - 2] : lines.length;
  return lines.slice(Math.max(0, boxTop - 12), boxTop).some((l) => SPINNER_RE.test(l));
}

function parseConsoleScreen(rawScreen, cursor = {}) {
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

  // A new session's screen still holds the shell history above the banner (`dir`, `PS C:\…>
  // claude`): what Claude printed starts at the banner, which also names the model and folder.
  const bannerIdx = findBanner(lines);
  if (bannerIdx >= 0) {
    lines.slice(bannerIdx, bannerIdx + 8).forEach((line, i) => {
      const ver = line.match(/Claude Code\s+(v[\d.]+)/i);
      if (ver && !detectedVersion) detectedVersion = ver[1];
      // The model sits beside the logo (its first three lines), never further down.
      const model = i < 3 && !detectedModel && line.match(BANNER_MODEL_RE);
      if (model) detectedModel = modelIdFromText(model[0]);
      if (!detectedCwd) detectedCwd = extractValidDirectory(line);
    });
  }
  // A /model switch shown after the banner is newer than it.
  for (const line of lines.slice(Math.max(0, bannerIdx))) {
    const set = line.match(MODEL_SET_RE);
    if (set && modelIdFromText(set[1])) detectedModel = modelIdFromText(set[1]);
  }

  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const line = lines[i];
    const verMatch = !detectedVersion && line.match(/Claude Code\s+(v[\d\.]+)/i);
    if (verMatch) {
      detectedVersion = verMatch[1];
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

  // A multi-select question ends its checkboxes with an unnumbered "Next" row.
  let nextItem = null;

  for (let i = 0; i < tailLines.length; i++) {
    const line = tailLines[i];
    const nextMatch = options.length > 0 && !nextItem ? line.match(NEXT_ROW_RE) : null;
    if (nextMatch) {
      nextItem = { index: options.length + 1, active: Boolean(nextMatch[1]) };
      if (nextItem.active) currentIndex = nextItem.index;
      continue;
    }
    const m = line.match(optionRegex);
    if (m) {
      const hasCursor = Boolean(m[1]);
      const num = m[2];
      const label = stripSidePanel(m[3]).trim();

      const expectedIndex = options.length + 1;
      if (
        Number(num) === expectedIndex ||
        (options.length === 0 && Number(num) === 1)
      ) {
        if (options.length === 0) {
          firstOptionLineIdx = i;
        }
        lastOptionLineIdx = i;
        // `index` is the arrow-key position, which counts an unnumbered "Next" row above it.
        const optIndex = options.length + 1 + (nextItem ? 1 : 0);
        if (hasCursor) {
          currentIndex = optIndex;
        }
        options.push({
          index: optIndex,
          number: String(num),
          ...splitCheckbox(label),
          active: hasCursor,
        });
      } else if (Number(num) === 1) {
        options.length = 0;
        nextItem = null;
        firstOptionLineIdx = i;
        lastOptionLineIdx = i;
        currentIndex = 1;
        options.push({
          index: 1,
          number: '1',
          ...splitCheckbox(label),
          active: hasCursor,
        });
      }
    }
  }

  let interactivePrompt = null;

  // The key-hint line under a prompt ("Enter to select · … · Esc to cancel"). A question with
  // previews puts the preview box, notes and extra options between it and the last option.
  let keyHintIdx = -1;
  for (let i = tailLines.length - 1; i > lastOptionLineIdx && i >= 0; i--) {
    if (PROMPT_KEY_HINT_RE.test(tailLines[i])) {
      keyHintIdx = i;
      break;
    }
  }
  const promptEndsNearby =
    tailLines.length - lastOptionLineIdx <= 6 ||
    (keyHintIdx > lastOptionLineIdx && keyHintIdx - lastOptionLineIdx <= 24);

  if (options.length >= 2 && promptEndsNearby) {
    if (!options.some((o) => o.active) && !(nextItem && nextItem.active)) {
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

    const allHeaderLines = tailLines
      .slice(sectionStart, firstOptionLineIdx)
      .map((l) => l.trim())
      .filter((l) => l && !/[─━═]{8,}/.test(l));
    // A multi-question prompt shows a tab bar: "←  ☐ Export  ☐ Layout  ✔ Submit  →".
    const tabLine = allHeaderLines.find(isQuestionTabBar);
    const headerLines = allHeaderLines.filter((l) => l !== tabLine);

    const question =
      headerLines.find((l) => l.endsWith('?') || l.endsWith(':')) ||
      headerLines[0] ||
      'Claude กำลังรอให้คุณเลือกคำตอบ';

    const context = allHeaderLines.filter((l) => l !== question).slice(-5);

    const footerLines =
      keyHintIdx >= 0
        ? [tailLines[keyHintIdx].trim()]
        : tailLines
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
    if (tabLine) interactivePrompt.tabs = parseQuestionTabs(tabLine);
    if (nextItem) interactivePrompt.nextIndex = nextItem.index;
  }

  // The last 18 lines, starting no earlier than the banner (nothing of the shell above it).
  const previewLines = lines.slice(Math.max(bannerIdx, lines.length - 18, 0)).join('\n');

  return {
    cwd: detectedCwd,
    version: detectedVersion,
    // A model id ("claude-sonnet-5-5") when the banner or a /model switch is on screen, else null.
    model: detectedModel,
    interactivePrompt,
    // Only meaningful when no prompt dialog is up.
    inputText: interactivePrompt ? null : parseInputBox(lines, cursor),
    busy: isBusyScreen(lines),
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
