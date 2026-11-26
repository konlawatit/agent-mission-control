/**
 * Plan usage, checked on demand.
 *
 * Nothing here polls. When the person asks (POST /api/usage/check), one idle Claude Code terminal
 * gets `/usage` typed into it, the dialog it opens is read off the screen, and Esc closes it again.
 * `/usage` is a local command: it sends nothing to the model and costs no tokens. The command
 * never goes through the dashboard's prompt path, so the room's status, TL;DR, queue and
 * notifications are untouched, and the console scanner leaves that terminal's screen alone
 * while the dialog is open (ConsoleScanner.holdPid).
 *
 * The dialog, as Claude Code 2.1.332 draws it:
 *
 *   Current session
 *   ▌                                                  1% used
 *   Resets 3:29am (Asia/Bangkok)
 *   Current week (all models)
 *   ███████                                            14% used
 *   Resets Dec 3, 12:59pm (Asia/Bangkok)
 *   Current week (Fable)
 *   ...
 *   ←/→ to switch · f to fix 2 of 5 · d to show day · w to show week · Esc to close
 */
const { parseConsoleScreen, isUsageDialogScreen } = require('./console-scanner');

const USAGE_COMMAND = '/usage';
const DISMISSED_RE = /Settings dialog dismissed/i;
const SECTION_RE = /^\s*Current (session|week)(?:\s*\(([^)]{1,60})\))?(?=\s{2,}|\s*$)/i;
const USED_RE = /(\d{1,3}(?:\.\d+)?)\s*%\s*used/i;
const RESETS_RE = /\bResets?\s+(.+?)\s*$/i;
const BLOCK_END_RE = /contributing to your usage|^\s*Approximate\b/i;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

class UsageCheckError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function clampPct(n) {
  return Math.max(0, Math.min(100, Math.round(Number(n) * 10) / 10));
}

/* ---------- Reset times ---------- */

const formatters = new Map();
function zoneFormatter(tz) {
  const key = tz || '';
  if (!formatters.has(key)) {
    formatters.set(
      key,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz || undefined,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      })
    );
  }
  return formatters.get(key);
}

function isKnownZone(tz) {
  try {
    zoneFormatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a time zone (undefined = this machine's zone). */
function zonedParts(ms, tz) {
  const p = {};
  for (const { type, value } of zoneFormatter(tz).formatToParts(new Date(ms))) p[type] = Number(value);
  return { year: p.year, month: p.month - 1, day: p.day, hour: p.hour % 24, minute: p.minute, second: p.second };
}

function zoneOffsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time in `tz` happens. Month overflow (day 32) rolls over as Date.UTC does. */
function zonedToUtc(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month, day, hour, minute);
  const first = guess - zoneOffsetMs(guess, tz);
  return guess - zoneOffsetMs(first, tz);
}

/**
 * A reset as Claude Code prints it ("3:29am (Asia/Bangkok)", "Dec 3, 12:59pm (Asia/Bangkok)",
 * "12am", "in 2 hr 5 min") as the ISO time of its next occurrence after `nowMs`, or null.
 * The zone in brackets is used when this machine knows it, otherwise local time.
 */
function parseResetText(raw, nowMs = Date.now()) {
  const text = String(raw || '').replace(/�/g, '').trim();
  if (!text) return null;
  const zone = text.match(/\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\)\s*$/);
  const tz = zone && isKnownZone(zone[1]) ? zone[1] : undefined;
  const body = (zone ? text.slice(0, zone.index) : text).trim().replace(/\s+/g, ' ');

  let m = body.match(/^in (?:(\d+) ?(?:d|days?) ?)?(?:(\d+) ?(?:h|hr|hrs|hours?) ?)?(?:(\d+) ?(?:m|min|mins|minutes?))?$/i);
  if (m && (m[1] || m[2] || m[3])) {
    const minutes = Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
    return new Date(nowMs + minutes * 60000).toISOString();
  }

  m = body.match(/^(?:([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (?:at )?)?(\d{1,2})(?::(\d{2}))? ?([ap])\.?m\.?$/i);
  if (!m) return null;
  const hour12 = Number(m[3]);
  const minute = m[4] ? Number(m[4]) : 0;
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (m[5].toLowerCase() === 'p' ? 12 : 0); // 12am = 0h, 12pm = 12h
  const today = zonedParts(nowMs, tz);

  if (m[1]) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    const day = Number(m[2]);
    if (month === undefined || day < 1 || day > 31) return null;
    let at = zonedToUtc(today.year, month, day, hour, minute, tz);
    if (at <= nowMs) at = zonedToUtc(today.year + 1, month, day, hour, minute, tz);
    return new Date(at).toISOString();
  }
  let at = zonedToUtc(today.year, today.month, today.day, hour, minute, tz);
  if (at <= nowMs) at = zonedToUtc(today.year, today.month, today.day + 1, hour, minute, tz);
  return new Date(at).toISOString();
}

/* ---------- The /usage screen ---------- */

/**
 * Reads the usage blocks off a screen. Returns null when none is on it, else
 * { session, week, models: [{ name, ... }], complete, dialog } where each window is
 * { usedPct, resetsText, resetsAt } (or null when that block is off the screen), and `dialog`
 * says the dialog's footer is on screen (it is open now). The screen read holds only the last
 * ~45 rows, so a long dialog can push blocks out of it; lines garbled by the console (Thai becomes
 * U+FFFD) around it are ignored. When a block shows up twice (an earlier dialog left in the
 * scrollback above the open one), the lower, newer one counts.
 */
function parseUsageScreen(screen, nowMs = Date.now()) {
  if (typeof screen !== 'string' || !screen) return null;
  const lines = screen.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  const out = { session: null, week: null, models: [] };
  const models = new Map();
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(SECTION_RE);
    if (!head) continue;
    let usedPct = null;
    let resetsText = null;
    for (let j = i; j < Math.min(lines.length, i + 5); j++) {
      if (j > i && (SECTION_RE.test(lines[j]) || BLOCK_END_RE.test(lines[j]))) break;
      const used = usedPct === null && lines[j].match(USED_RE);
      if (used) usedPct = clampPct(used[1]);
      const resets = resetsText === null && lines[j].match(RESETS_RE);
      if (resets) resetsText = resets[1].replace(/�/g, '').trim().slice(0, 80);
    }
    if (usedPct === null) continue; // still loading, or its numbers are off the screen
    found = true;
    const win = { usedPct, resetsText, resetsAt: resetsText ? parseResetText(resetsText, nowMs) : null };
    const label = (head[2] || '').trim();
    if (head[1].toLowerCase() === 'session') out.session = win;
    else if (!label || /^all models?$/i.test(label)) out.week = win;
    else if (models.has(label) || models.size < 6) models.set(label, win);
  }

  if (!found) return null;
  out.models = Array.from(models, ([name, win]) => ({ name: name.slice(0, 40), ...win }));
  out.complete = Boolean(out.session && out.week);
  out.dialog = isUsageDialogScreen(lines);
  return out;
}

function sameReading(a, b) {
  const key = (r) =>
    JSON.stringify([r.session, r.week, r.models].map((w) => (Array.isArray(w) ? w.map((x) => [x.name, x.usedPct]) : w && w.usedPct)));
  return Boolean(a && b) && key(a) === key(b);
}

/* ---------- The check ---------- */

const NO_IDLE_ROOM =
  'ต้องมี Claude Code เปิดอยู่อย่างน้อย 1 ห้องที่ว่าง (ไม่ได้ทำงาน ไม่มีคำถามค้าง และช่องพิมพ์ว่าง) ถึงจะเช็ค usage ได้';

/**
 * Runs `/usage` in one idle terminal and reads the result. `terminal` is the console scanner (or a
 * stand-in with the same methods): readScreen(pid), sendText(pid, text) which presses Enter,
 * sendKey(pid, key), holdPid(pid) and releasePid(pid). One check runs at a time.
 */
class UsageChecker {
  constructor(store, terminal, options = {}) {
    this.store = store;
    this.terminal = terminal || null;
    this.pollMs = options.pollMs ?? 500;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 3000;
    this.now = options.now || (() => Date.now());
    this.sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onChange = options.onChange || (() => {});
    this.running = null;
  }

  get busy() {
    return Boolean(this.running);
  }

  /** Live rooms with a terminal, the preferred one first, then idle ones, newest first. */
  _candidates(preferSessionId) {
    const rank = (s) => (s.status === 'idle' || s.status === 'done' ? 0 : 1);
    const rooms = Array.from(this.store.sessions.values())
      .filter(
        (s) =>
          s.lifecycle === 'live' &&
          Number(s.pid) > 0 &&
          s.isProcessAlive !== false &&
          s.status !== 'working' &&
          s.status !== 'needs_input' &&
          !s.interactivePrompt
      )
      .sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    const preferred = rooms.findIndex((s) => s.id === preferSessionId);
    if (preferred > 0) rooms.unshift(rooms.splice(preferred, 1)[0]);
    return rooms;
  }

  async _read(pid) {
    try {
      const r = await this.terminal.readScreen(pid);
      return r && r.ok && typeof r.screen === 'string' ? r : null;
    } catch {
      return null;
    }
  }

  /** Idle means: no prompt or dialog up, not mid-turn, and an empty input box on screen. */
  _isIdle(read) {
    const parsed = read && parseConsoleScreen(read.screen, { cursorRow: read.cursorRow, cursorCol: read.cursorCol });
    return Boolean(parsed && !parsed.interactivePrompt && !parsed.busy && !parsed.usageDialog && parsed.inputText === '');
  }

  async check({ preferSessionId = null } = {}) {
    if (!this.terminal) {
      throw new UsageCheckError(501, 'เช็ค usage ได้เฉพาะบน Windows ที่เปิด Claude Code ไว้ใน terminal', 'unsupported');
    }
    if (this.running) {
      throw new UsageCheckError(409, 'กำลังเช็ค usage อยู่ รอผลสักครู่', 'busy');
    }
    this.running = { startedAt: new Date(this.now()).toISOString() };
    this.onChange();
    try {
      for (const session of this._candidates(preferSessionId)) {
        if (!this._isIdle(await this._read(session.pid))) continue;
        this.running.sessionId = session.id;
        return await this._runOn(session);
      }
      throw new UsageCheckError(409, NO_IDLE_ROOM, 'no-idle-room');
    } finally {
      this.running = null;
      this.onChange();
    }
  }

  async _runOn(session) {
    const pid = Number(session.pid);
    this.terminal.holdPid(pid);
    try {
      const sent = await this.terminal.sendText(pid, USAGE_COMMAND);
      if (!sent || !sent.ok) {
        throw new UsageCheckError(502, `ส่ง /usage เข้า terminal ของห้อง ${session.room} ไม่สำเร็จ`, 'send-failed');
      }

      let best = null;
      let stable = 0;
      const deadline = this.now() + this.timeoutMs;
      while (this.now() < deadline) {
        await this.sleep(this.pollMs);
        const read = await this._read(pid);
        const parsed = read && parseUsageScreen(read.screen, this.now());
        // Not open yet, still loading its numbers, or only an old dialog left in the scrollback.
        if (!parsed || !parsed.dialog) continue;
        if (parsed.complete) {
          best = parsed;
          break;
        }
        // Part of the dialog is off the screen read: take it once it has stopped changing.
        stable = sameReading(best, parsed) ? stable + 1 : 0;
        best = parsed;
        if (stable >= 2) break;
      }

      const closed = await this._close(pid);
      if (!best) {
        throw new UsageCheckError(504, 'อ่านผล /usage จาก terminal ไม่ทัน ลองเช็คใหม่อีกครั้ง', 'timeout');
      }
      return {
        closed,
        reading: {
          checkedAt: new Date(this.now()).toISOString(),
          sessionId: session.id,
          room: session.room,
          session: best.session,
          week: best.week,
          models: best.models,
          partial: !best.complete,
        },
      };
    } finally {
      this.terminal.releasePid(pid);
    }
  }

  /**
   * Esc closes the dialog; Claude Code then prints "⎿  Settings dialog dismissed". A second Esc is
   * sent only while the dialog is still on screen (on an empty input box a double Esc would open
   * the rewind menu). Text left in the input box when /usage never ran is cleared.
   */
  async _key(pid, key) {
    try {
      const r = await this.terminal.sendKey(pid, key);
      return Boolean(r && r.ok);
    } catch {
      return false;
    }
  }

  async _close(pid) {
    await this._key(pid, 'esc');
    const started = this.now();
    let resent = false;
    while (this.now() - started < this.closeTimeoutMs) {
      await this.sleep(Math.min(this.pollMs, 400));
      const read = await this._read(pid);
      const parsed = read && parseConsoleScreen(read.screen, { cursorRow: read.cursorRow, cursorCol: read.cursorCol });
      if (!parsed) continue;
      if (parsed.usageDialog) {
        // Still open a while after the first Esc: that one was lost, so the dialog gets another.
        if (!resent && this.now() - started >= 1200) resent = await this._key(pid, 'esc');
        continue;
      }
      if (typeof parsed.inputText === 'string' && parsed.inputText.trim().startsWith(USAGE_COMMAND)) {
        await this._key(pid, 'ctrl-u');
        continue;
      }
      if (DISMISSED_RE.test(read.screen) || parsed.inputText !== null) return true;
    }
    return false;
  }
}

module.exports = {
  USAGE_COMMAND,
  UsageChecker,
  UsageCheckError,
  parseUsageScreen,
  parseResetText,
  zonedToUtc,
};
