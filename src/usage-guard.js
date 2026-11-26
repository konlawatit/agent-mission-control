const fs = require('fs');
const path = require('path');

const HOUR_MS = 3600 * 1000;
// When a hold starts without a known reset time, it lifts after one 5-hour window.
const WINDOW_MS = 5 * HOUR_MS;
const MAX_TIMER_MS = 2147483647; // setTimeout's limit (~24.8 days)
const MIN_TIMER_MS = 1000;

function clampPct(n) {
  return Math.max(0, Math.min(100, Math.round(Number(n) * 10) / 10));
}

function isoOrNull(value) {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function cleanText(value, max) {
  return typeof value === 'string' && value ? value.slice(0, max) : null;
}

/** One usage window from a /usage reading: { usedPct, resetsAt, resetsText }. */
function cleanWindow(win) {
  if (!win || typeof win !== 'object') return null;
  const used = Number(win.usedPct);
  if (win.usedPct === null || win.usedPct === undefined || !Number.isFinite(used)) return null;
  return { usedPct: clampPct(used), resetsAt: isoOrNull(win.resetsAt), resetsText: cleanText(win.resetsText, 80) };
}

/** A stored /usage reading, or null when it is not one (an older file, a hand edit). */
function cleanCheck(check) {
  if (!check || typeof check !== 'object') return null;
  const checkedAt = isoOrNull(check.checkedAt);
  const session = cleanWindow(check.session);
  const week = cleanWindow(check.week);
  if (!checkedAt || (!session && !week)) return null;
  const models = (Array.isArray(check.models) ? check.models : [])
    .map((m) => {
      const win = cleanWindow(m);
      const name = m && cleanText(m.name, 40);
      return win && name ? { name, ...win } : null;
    })
    .filter(Boolean)
    .slice(0, 6);
  return {
    checkedAt,
    sessionId: cleanText(check.sessionId, 200),
    room: cleanText(check.room, 200),
    session,
    week,
    models,
    partial: Boolean(check.partial),
  };
}

function cleanHold(hold, nowIso) {
  if (!hold || typeof hold !== 'object') return null;
  const sessions = {};
  if (hold.sessions && typeof hold.sessions === 'object') {
    for (const [id, entry] of Object.entries(hold.sessions)) {
      if (!entry || typeof entry !== 'object') continue;
      sessions[id] = { hadWork: Boolean(entry.hadWork), final: Boolean(entry.final), savedAt: isoOrNull(entry.savedAt) };
    }
  }
  return {
    startedAt: isoOrNull(hold.startedAt) || nowIso,
    resumeAt: isoOrNull(hold.resumeAt),
    reason: cleanText(hold.reason, 300) || 'Usage ต่ำกว่าเกณฑ์',
    source: cleanText(hold.source, 20) || 'check',
    sessions,
  };
}

const CONFIG_KEYS = ['enabled', 'autoPauseThresholdPct', 'manualRemainingPct', 'lastCheck', 'hold', 'lastResumedAt'];

/**
 * Usage quota guard.
 *
 * Works from the latest real plan-usage reading, taken on request by running `/usage` in an idle
 * Claude Code terminal (src/usage-check.js). Nothing polls: the guard evaluates when a reading
 * arrives, when hooks report activity, and when its settings change; during a hold one timer
 * waits for the reset. When remaining usage in the 5-hour window is below the threshold (8% by
 * default) it starts a hold:
 *   1. every live room gets a progress checkpoint, written to disk;
 *   2. rooms mid-turn are allowed to finish their current step, and the checkpoint is refreshed
 *      when they stop;
 *   3. new prompts are held (dashboard commands are refused, and the UserPromptSubmit hook
 *      blocks prompts typed into the terminal);
 *   4. at the window reset the hold lifts and rooms that had unfinished work get a resume prompt.
 */
class UsageGuard {
  constructor(stateStore, commandBridge, options = {}) {
    this.store = stateStore;
    this.bridge = commandBridge;
    this.configFile = path.join(this.store.dataDir, 'usage-guard.json');
    this.checkpointsDir = path.join(this.store.dataDir, 'checkpoints');
    this.now = options.now || (() => Date.now());
    this.schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
    this.unschedule = options.unschedule || ((handle) => clearTimeout(handle));
    // Whether a /usage check is running right now (set by the server).
    this.isChecking = options.isChecking || (() => false);
    this.resumeTimer = null;
    this.stopped = false;

    this.config = {
      enabled: true,
      autoPauseThresholdPct: 8,
      // Set only by "ทดสอบการพัก": pretends usage is at this level until the hold lifts.
      manualRemainingPct: null,
      // The latest /usage reading (see cleanCheck).
      lastCheck: null,
      hold: null,
      lastResumedAt: null,
    };

    this._loadConfig();
  }

  /**
   * Loads usage-guard.json. Each value is checked; anything from older versions (the token-budget
   * estimate, statusline readings, the flag-style hold) is dropped and the file rewritten.
   */
  _loadConfig() {
    let raw;
    try {
      if (!fs.existsSync(this.configFile)) return;
      raw = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
    } catch {
      return;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const nowIso = new Date(this.now()).toISOString();
    const c = this.config;
    if (typeof raw.enabled === 'boolean') c.enabled = raw.enabled;
    const threshold = Number(raw.autoPauseThresholdPct);
    if (Number.isFinite(threshold) && threshold >= 1 && threshold <= 50) c.autoPauseThresholdPct = threshold;
    if (typeof raw.manualRemainingPct === 'number' && Number.isFinite(raw.manualRemainingPct)) {
      c.manualRemainingPct = clampPct(raw.manualRemainingPct);
    }
    c.lastCheck = cleanCheck(raw.lastCheck);
    c.hold = cleanHold(raw.hold, nowIso);
    // Earlier versions kept the hold as a flag plus a whole-store baseline.
    if (!c.hold && raw.isPausedByQuota) {
      c.hold = cleanHold({ startedAt: raw.pausedAt, resumeAt: raw.resetAt, source: 'legacy' }, nowIso);
    }
    c.lastResumedAt = isoOrNull(raw.lastResumedAt);
    if (Object.keys(raw).some((key) => !CONFIG_KEYS.includes(key))) this._saveConfig();
  }

  _saveConfig() {
    try {
      if (!fs.existsSync(this.store.dataDir)) {
        fs.mkdirSync(this.store.dataDir, { recursive: true });
      }
      const tmp = `${this.configFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), 'utf8');
      fs.renameSync(tmp, this.configFile);
    } catch {}
  }

  /** Arms the resume timer for a hold restored from disk. Nothing else runs on a schedule. */
  start() {
    this.stopped = false;
    this._armResumeTimer();
  }

  stop() {
    this.stopped = true;
    this._clearResumeTimer();
  }

  _clearResumeTimer() {
    if (this.resumeTimer) {
      this.unschedule(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  /** One timer, for the hold's resume time; re-armed whenever the hold changes. */
  _armResumeTimer() {
    this._clearResumeTimer();
    const hold = this.config.hold;
    if (this.stopped || !hold || !hold.resumeAt) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(MIN_TIMER_MS, Date.parse(hold.resumeAt) - this.now()));
    this.resumeTimer = this.schedule(() => {
      this.resumeTimer = null;
      this.checkAndEnforce().catch(() => {});
    }, delay);
    if (this.resumeTimer && typeof this.resumeTimer.unref === 'function') this.resumeTimer.unref();
  }

  isHolding() {
    return Boolean(this.config.hold);
  }

  /** Stores a /usage reading as the latest one; real numbers replace a simulated level. */
  recordCheck(reading) {
    const check = cleanCheck(reading);
    if (!check) return false;
    this.config.lastCheck = check;
    this.config.manualRemainingPct = null;
    this._saveConfig();
    this.store._emitChange('usage_checked', {});
    return true;
  }

  /** The 5-hour window of the latest reading while it still describes the current window. */
  _currentSessionWindow() {
    const check = this.config.lastCheck;
    const win = check && check.session;
    if (!win) return null;
    if (win.resetsAt && Date.parse(win.resetsAt) <= this.now()) return null;
    return win;
  }

  getUsageSummary() {
    const threshold = Number(this.config.autoPauseThresholdPct) || 8;
    const check = this.config.lastCheck;
    const current = this._currentSessionWindow();

    let source = 'none';
    let usedPct = null;
    if (typeof this.config.manualRemainingPct === 'number') {
      source = 'simulated';
      usedPct = clampPct(100 - this.config.manualRemainingPct);
    } else if (current) {
      source = 'check';
      usedPct = current.usedPct;
    }
    const remainingPct = usedPct === null ? null : clampPct(100 - usedPct);
    const hold = this.config.hold;
    const withRemaining = (win) => (win ? { ...win, remainingPct: clampPct(100 - win.usedPct) } : null);

    return {
      enabled: Boolean(this.config.enabled),
      source,
      autoPauseThresholdPct: threshold,
      remainingPct,
      usedPct,
      isLowQuota: remainingPct !== null && remainingPct < threshold,
      isPausedByQuota: Boolean(hold),
      hold: hold
        ? {
            startedAt: hold.startedAt,
            resumeAt: hold.resumeAt,
            reason: hold.reason,
            source: hold.source,
            rooms: Object.keys(hold.sessions || {}).length,
            pendingSteps: Object.values(hold.sessions || {}).filter((h) => !h.final).length,
          }
        : null,
      resetAt: hold && hold.resumeAt ? hold.resumeAt : current ? current.resetsAt : null,
      lastCheck: check
        ? {
            ...check,
            session: withRemaining(check.session),
            week: withRemaining(check.week),
            models: check.models.map(withRemaining),
          }
        : null,
      // The latest reading's 5-hour window has reset since: its numbers are history.
      stale: Boolean(check && check.session && !current),
      checking: Boolean(this.isChecking()),
      lastResumedAt: this.config.lastResumedAt,
    };
  }

  async checkAndEnforce() {
    const summary = this.getUsageSummary();
    const hold = this.config.hold;

    if (!hold) {
      if (summary.enabled && summary.isLowQuota) {
        this.startHold(
          `Usage คงเหลือ ${summary.remainingPct}% (ต่ำกว่าเกณฑ์ ${summary.autoPauseThresholdPct}%)`,
          summary
        );
      }
      return this.getUsageSummary();
    }

    this._finalizeFinishedSteps();

    const now = this.now();
    const resumeDue = Boolean(hold.resumeAt) && now >= Date.parse(hold.resumeAt);
    // A newer reading from the next window (a later reset, above the threshold) ends the hold early.
    const current = summary.source === 'check' ? this._currentSessionWindow() : null;
    const rolledOver =
      Boolean(current && current.resetsAt && hold.resumeAt) &&
      Date.parse(current.resetsAt) > Date.parse(hold.resumeAt) &&
      !summary.isLowQuota;

    if (resumeDue || rolledOver) {
      await this.resumeAll({ autoTriggered: true });
    } else if (!this.resumeTimer) {
      this._armResumeTimer();
    }
    return this.getUsageSummary();
  }

  _checkpointFor(session, reason, savedAt) {
    return {
      sessionId: session.id,
      room: session.room,
      cwd: session.cwd,
      branch: session.branch,
      claudeSessionId: session.claudeSessionId,
      savedAt,
      reason,
      goal: session.goal,
      stageIndex: session.stageIndex,
      statusAtSave: session.status,
      tldr: session.tldr,
      modifiedFiles: [...(session.modifiedFiles || [])],
    };
  }

  _writeCheckpointFile(checkpoint) {
    try {
      if (!fs.existsSync(this.checkpointsDir)) {
        fs.mkdirSync(this.checkpointsDir, { recursive: true });
      }
      const file = path.join(
        this.checkpointsDir,
        `${String(checkpoint.sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
      );
      fs.writeFileSync(file, JSON.stringify(checkpoint, null, 2), 'utf8');
    } catch {}
  }

  startHold(reason, summary = this.getUsageSummary()) {
    const nowIso = new Date(this.now()).toISOString();
    const current = this._currentSessionWindow();
    const resumeAt =
      (current && current.resetsAt) || new Date(this.now() + WINDOW_MS).toISOString();
    const sessions = {};

    for (const session of this.store.sessions.values()) {
      if (session.lifecycle !== 'live') continue;
      const midStep = session.status === 'working';
      const hadWork = midStep || session.status === 'needs_input';
      const checkpoint = this._checkpointFor(session, reason, nowIso);
      this._writeCheckpointFile(checkpoint);
      sessions[session.id] = { hadWork, final: !midStep, savedAt: nowIso };
      session.savedCheckpoint = checkpoint;
      // Only rooms with unfinished work are shown as held; idle and finished rooms keep their state.
      session.quotaHold = hadWork ? { since: nowIso, resumeAt, final: !midStep } : null;
      if (!hadWork) continue;
      if (!Array.isArray(session.recentEvents)) session.recentEvents = [];
      session.recentEvents.unshift({
        id: `quota-hold-${this.now()}-${session.id}`,
        timestamp: nowIso,
        event: 'QuotaHold',
        title: midStep
          ? `${reason} — บันทึก checkpoint แล้ว ให้ทำ step นี้ให้จบก่อนพัก`
          : `${reason} — บันทึก checkpoint และพักรอ reset`,
        badge: 'Quota hold',
        level: 'warning',
      });
    }

    this.config.hold = {
      startedAt: nowIso,
      resumeAt,
      reason,
      source: summary.source,
      sessions,
    };
    this._saveConfig();
    this._armResumeTimer();
    this.store._emitChange('quota_hold', { reason, rooms: Object.keys(sessions) });
    return { ok: true, pausedSessions: Object.keys(sessions), usage: this.getUsageSummary() };
  }

  /** Refreshes the checkpoint of a room that was mid-step when the hold began, once it stops. */
  _finalizeFinishedSteps() {
    const hold = this.config.hold;
    if (!hold || !hold.sessions) return;
    let changed = false;
    const nowIso = new Date(this.now()).toISOString();
    for (const [id, entry] of Object.entries(hold.sessions)) {
      if (entry.final) continue;
      const session = this.store.sessions.get(id);
      if (!session) {
        entry.final = true;
        changed = true;
        continue;
      }
      if (session.status === 'working') continue;
      const checkpoint = this._checkpointFor(session, hold.reason, nowIso);
      this._writeCheckpointFile(checkpoint);
      session.savedCheckpoint = checkpoint;
      session.quotaHold = { ...(session.quotaHold || {}), final: true };
      entry.final = true;
      entry.savedAt = nowIso;
      changed = true;
    }
    if (changed) {
      this._saveConfig();
      this.store._emitChange('quota_hold_checkpoint', {});
    }
  }

  _resumePrompt(checkpoint) {
    const goal = checkpoint && checkpoint.goal ? checkpoint.goal : 'งานก่อนหน้า';
    const last = checkpoint && checkpoint.tldr ? ` สถานะล่าสุดก่อนพัก: ${checkpoint.tldr}` : '';
    return `Usage reset แล้ว ทำงานต่อจาก checkpoint ที่บันทึกไว้: "${goal}".${last}`;
  }

  /** Lifts the hold and sends a resume prompt to rooms that had unfinished work. */
  async resumeAll(options = {}) {
    const hold = this.config.hold;
    const nowIso = new Date(this.now()).toISOString();
    // Clear the hold first so the resume prompts themselves are not held.
    this.config.hold = null;
    this.config.manualRemainingPct = null;
    this.config.lastResumedAt = nowIso;
    this._clearResumeTimer();
    this._saveConfig();

    const resumedSessions = [];
    const entries = hold && hold.sessions ? Object.entries(hold.sessions) : [];
    for (const [id, entry] of entries) {
      const session = this.store.sessions.get(id);
      if (!session) continue;
      const checkpoint = session.savedCheckpoint;
      session.quotaHold = null;
      if (!Array.isArray(session.recentEvents)) session.recentEvents = [];
      session.recentEvents.unshift({
        id: `quota-resume-${this.now()}-${id}`,
        timestamp: nowIso,
        event: 'QuotaResume',
        title: entry.hadWork
          ? 'Usage reset แล้ว — ส่ง prompt ให้ทำงานต่อจาก checkpoint'
          : 'Usage reset แล้ว — ปลดพัก',
        badge: options.autoTriggered ? 'Auto-resumed' : 'Resumed',
        level: 'success',
      });

      if (
        entry.hadWork &&
        session.lifecycle === 'live' &&
        this.bridge &&
        options.dispatchResume !== false
      ) {
        try {
          await this.bridge.dispatchCommand(session.id, this._resumePrompt(checkpoint));
          resumedSessions.push(id);
        } catch {}
      }
      session.savedCheckpoint = null;
    }

    // Rooms restored from an older state file may still carry a hold marker.
    for (const session of this.store.sessions.values()) {
      if (session.quotaHold) session.quotaHold = null;
      if (session.status === 'paused_quota') session.status = 'idle';
    }

    this.store._emitChange('quota_resumed', { resumedSessions });
    return { ok: true, resumedSessions, usage: this.getUsageSummary() };
  }

  /** Test hook ("ทดสอบการพัก"): pretends usage is at `remainingPct` and starts a hold. */
  async simulateLowQuota(remainingPct = 6.5) {
    this.config.manualRemainingPct = remainingPct;
    this._saveConfig();
    if (this.config.hold) return { ok: true, usage: this.getUsageSummary() };
    return this.startHold(`จำลอง Usage คงเหลือ ${remainingPct}%`);
  }

  async updateConfig(patch = {}) {
    if (typeof patch.enabled === 'boolean') {
      this.config.enabled = patch.enabled;
      // Turning the guard off lifts an active hold without sending resume prompts.
      if (!patch.enabled && this.config.hold) {
        await this.resumeAll({ dispatchResume: false });
      }
    }
    if (typeof patch.autoPauseThresholdPct === 'number' && Number.isFinite(patch.autoPauseThresholdPct)) {
      this.config.autoPauseThresholdPct = Math.max(1, Math.min(50, patch.autoPauseThresholdPct));
    }
    if (patch.manualRemainingPct === null) {
      this.config.manualRemainingPct = null;
    }
    this._saveConfig();
    await this.checkAndEnforce();
    this.store._emitChange('usage_config_updated', {});
    return this.getUsageSummary();
  }
}

module.exports = { UsageGuard, cleanCheck };
