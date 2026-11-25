const fs = require('fs');
const path = require('path');
const { getRecentBillableTokens } = require('./transcript-parser');

const HOUR_MS = 3600 * 1000;
// A statusline reading older than this no longer describes the current window.
const OBSERVATION_MAX_AGE_MS = 6 * HOUR_MS;
// Estimate mode only releases a hold once usage has recovered this far past the threshold.
const RECOVERY_MARGIN_PCT = 5;

function clampPct(n) {
  return Math.max(0, Math.min(100, Math.round(Number(n) * 10) / 10));
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Claude Code reports epoch seconds; accept milliseconds too.
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** Normalizes one `rate_limits` window from the Claude Code statusline payload. */
function normalizeWindow(win) {
  if (!win || typeof win !== 'object') return null;
  const pct = Number(win.used_percentage ?? win.usedPercentage);
  if (!Number.isFinite(pct)) return null;
  return { usedPct: clampPct(pct), resetsAt: toIso(win.resets_at ?? win.resetsAt) };
}

/**
 * Usage quota guard.
 *
 * Reads the real 5-hour plan usage from the Claude Code statusline bridge when available and
 * falls back to an estimate (fresh tokens in the last 5 hours against a configurable budget).
 * When remaining usage drops below the threshold (8% by default) it starts a hold:
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
    this.timer = null;
    this.now = options.now || (() => Date.now());
    this.recentTokens = options.recentTokens || getRecentBillableTokens;

    this.config = {
      enabled: true,
      autoPauseThresholdPct: 8,
      windowHours: 5,
      // Fresh tokens (input + output + cache writes) per 5-hour window, estimate mode only.
      tokenBudget: 5000000,
      manualRemainingPct: null,
      observed: null,
      hold: null,
      lastResumedAt: null,
    };

    this._loadConfig();
  }

  _loadConfig() {
    try {
      if (fs.existsSync(this.configFile)) {
        const raw = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
        for (const key of Object.keys(this.config)) {
          if (Object.prototype.hasOwnProperty.call(raw, key)) this.config[key] = raw[key];
        }
        // Earlier versions kept the hold as a flag plus a whole-store baseline.
        if (raw.isPausedByQuota && !this.config.hold) {
          this.config.hold = {
            startedAt: raw.pausedAt || new Date(this.now()).toISOString(),
            resumeAt: raw.resetAt || null,
            reason: 'Usage ต่ำกว่าเกณฑ์',
            source: 'estimate',
            sessions: {},
          };
        }
      }
    } catch {}
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

  start(intervalMs = 4000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.checkAndEnforce().catch(() => {});
    }, intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isHolding() {
    return Boolean(this.config.hold);
  }

  /** Records a statusline reading (`rate_limits` from Claude Code). */
  observe(rateLimits) {
    if (!rateLimits || typeof rateLimits !== 'object') return false;
    const fiveHour = normalizeWindow(rateLimits.five_hour || rateLimits.fiveHour);
    const sevenDay = normalizeWindow(rateLimits.seven_day || rateLimits.sevenDay);
    if (!fiveHour && !sevenDay) return false;
    this.config.observed = {
      fiveHour,
      sevenDay,
      seenAt: new Date(this.now()).toISOString(),
    };
    this._saveConfig();
    return true;
  }

  _liveObservation() {
    const obs = this.config.observed;
    if (!obs || !obs.fiveHour) return null;
    const now = this.now();
    if (now - Date.parse(obs.seenAt || 0) > OBSERVATION_MAX_AGE_MS) return null;
    // Claude Code drops a window once it resets; a reading past its reset is stale.
    if (obs.fiveHour.resetsAt && Date.parse(obs.fiveHour.resetsAt) <= now) return null;
    return obs;
  }

  _estimate() {
    const now = this.now();
    const windowMs = Number(this.config.windowHours || 5) * HOUR_MS;
    const { tokens, oldestAt } = this.recentTokens(now - windowMs);
    const budget = Math.max(10000, Number(this.config.tokenBudget || 5000000));
    return {
      windowTokens: tokens,
      usedPct: clampPct((tokens / budget) * 100),
      // Rolling window: the oldest counted message ages out first.
      resetsAt: new Date((oldestAt || now) + windowMs).toISOString(),
    };
  }

  getUsageSummary() {
    const threshold = Number(this.config.autoPauseThresholdPct || 8);
    const estimate = this._estimate();
    const observed = this._liveObservation();

    let source = 'estimate';
    let usedPct = estimate.usedPct;
    let resetAt = estimate.resetsAt;
    if (typeof this.config.manualRemainingPct === 'number') {
      source = 'simulated';
      usedPct = clampPct(100 - this.config.manualRemainingPct);
    } else if (observed) {
      source = 'claude';
      usedPct = observed.fiveHour.usedPct;
      resetAt = observed.fiveHour.resetsAt || resetAt;
    }
    const remainingPct = clampPct(100 - usedPct);
    const hold = this.config.hold;

    let totalTokensAll = 0;
    let totalCostAll = 0;
    for (const s of this.store.sessions.values()) {
      const u = s.tokenUsage || {};
      totalTokensAll += Number(u.totalTokens || 0);
      totalCostAll += Number(u.estimatedCostUsd || 0);
    }

    return {
      enabled: Boolean(this.config.enabled),
      source,
      autoPauseThresholdPct: threshold,
      remainingPct,
      usedPct,
      isLowQuota: remainingPct < threshold,
      isPausedByQuota: Boolean(hold),
      hold: hold
        ? {
            startedAt: hold.startedAt,
            resumeAt: hold.resumeAt,
            reason: hold.reason,
            source: hold.source,
            rooms: Object.keys(hold.sessions || {}).length,
            pendingSteps: Object.values(hold.sessions || {}).filter((h) => !h.final)
              .length,
          }
        : null,
      resetAt: hold && hold.resumeAt ? hold.resumeAt : resetAt,
      windowHours: Number(this.config.windowHours || 5),
      tokenBudget: Math.max(10000, Number(this.config.tokenBudget || 5000000)),
      windowTokens: estimate.windowTokens,
      sevenDay: observed && observed.sevenDay ? observed.sevenDay : null,
      observedAt: this.config.observed ? this.config.observed.seenAt : null,
      lastResumedAt: this.config.lastResumedAt,
      totalTokensAll,
      totalCostAll: Math.round(totalCostAll * 10000) / 10000,
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
    const resumeDue = hold.resumeAt && now >= Date.parse(hold.resumeAt);
    // A fresh reading with a later reset means the window already rolled over.
    const rolledOver =
      summary.source === 'claude' &&
      hold.resumeAt &&
      summary.resetAt &&
      Date.parse(summary.resetAt) > Date.parse(hold.resumeAt) &&
      !summary.isLowQuota;
    const recovered =
      summary.source === 'estimate' &&
      hold.source === 'estimate' &&
      summary.remainingPct >= summary.autoPauseThresholdPct + RECOVERY_MARGIN_PCT;

    if (resumeDue || rolledOver || recovered) {
      await this.resumeAll({ autoTriggered: true });
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
    const resumeAt =
      summary.resetAt ||
      new Date(this.now() + Number(this.config.windowHours || 5) * HOUR_MS).toISOString();
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

  /** Test hook: pretends usage is at `remainingPct` and starts a hold. */
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
    if (typeof patch.autoPauseThresholdPct === 'number') {
      this.config.autoPauseThresholdPct = Math.max(
        1,
        Math.min(50, patch.autoPauseThresholdPct)
      );
    }
    if (typeof patch.tokenBudget === 'number' && patch.tokenBudget >= 10000) {
      this.config.tokenBudget = Math.round(patch.tokenBudget);
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

module.exports = { UsageGuard, normalizeWindow };
