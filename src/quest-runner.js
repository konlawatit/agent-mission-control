/**
 * Guild Mode quest runner: drives a hero's process one phase at a time.
 *
 * A quest belongs to one room. The runner sends one prompt per phase over the command bridge,
 * waits for the turn to end (the Stop hook), reads the `QUEST-VERDICT:` line and moves on, loops
 * back to the fix phase, pauses or finishes. Quest records are kept in
 * `<dataDir>/guild-quests.json`; a compact copy is mirrored onto the room (`session.quest`) so
 * both pages see it in every snapshot. Timers are injectable (`now`, `schedule`, `unschedule`) so
 * tests run synchronously.
 */
const fs = require('fs');
const path = require('path');
const {
  getHeroClass,
  planFor,
  resolveOption,
  presetFor,
  flattenText,
  buildPhasePrompt,
  buildProbePrompt,
  parseVerdict,
  SCENE_LABELS,
} = require('./guild-classes');
const { parseTranscriptTail } = require('./transcript-parser');
const { resolveResumeId, isHeadlessExitSummary } = require('./command-bridge');

const QUEST_FILE = 'guild-quests.json';
const MAX_QUESTS = 200; // kept on disk
const LIST_LIMIT = 50; // GET /api/guild/quests
const MAX_LOG = 60;
const MIRROR_LOG = 8;
const MAX_GOAL = 4000;
const MAX_NAME = 80;
const MAX_PRESET = 4000;
const MAX_NOTE = 2000;
const MAX_ID = 200;

const ACTIVE = new Set(['launching', 'running', 'paused', 'stalled']);
const STATES = new Set([...ACTIVE, 'done', 'failed', 'stopped']);
const LEVELS = new Set(['info', 'success', 'warn', 'error']);

const USAGE_REASON = 'พักงานรอ usage reset';
const HEADLESS_OPTIONS = Object.freeze({ runHeadless: true, permissionMode: 'acceptEdits' });

class QuestError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** The room has a way to type into a terminal (console, WezTerm pane, `amc run` wrapper). */
function hasTerminal(session) {
  return Boolean(session && (session.pid || session.paneId || session.wrapperConnected));
}

function defaultDirectory(dir) {
  if (!dir || typeof dir !== 'string') return null;
  try {
    const resolved = path.resolve(dir);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/** A quest's default name: the start of its goal, cut at a space when there is one. */
function defaultQuestName(goal) {
  const text = flattenText(goal);
  if (text.length <= 40) return text;
  const cut = text.slice(0, 40);
  const space = cut.lastIndexOf(' ');
  return `${(space >= 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** What identifies an answer across Stops: its last few hundred characters. */
function answerKey(text) {
  const t = String(text || '').trim();
  return t ? t.slice(-300) : null;
}

function lastAssistantTextFromTranscript(session) {
  if (!session || !session.transcriptPath) return null;
  try {
    // Only the room's own transcript (no cwd): another session in the folder is not this turn.
    const parsed = parseTranscriptTail(session.transcriptPath, null);
    return (parsed && parsed.lastAssistantFullText) || null;
  } catch {
    return null;
  }
}

class QuestRunner {
  constructor(store, bridge, options = {}) {
    this.store = store;
    this.bridge = bridge;
    this.usageGuard = options.usageGuard || null;
    this.dataDir = options.dataDir || store.dataDir;
    this.file = path.join(this.dataDir, QUEST_FILE);
    this.now = options.now || (() => Date.now());
    this.schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
    this.unschedule = options.unschedule || ((handle) => clearTimeout(handle));
    this.resolveDirectory = options.resolveDirectory || defaultDirectory;
    this.readTranscriptText = options.readTranscriptText || lastAssistantTextFromTranscript;
    this.launchTimeoutMs = options.launchTimeoutMs ?? 90000;
    this.sessionStartDelayMs = options.sessionStartDelayMs ?? 1500;
    this.phaseGapMs = options.phaseGapMs ?? 800;
    // A background run's process must be gone before the next phase starts: its exit sends one
    // more Stop, which would otherwise end the new phase.
    this.headlessWaitMs = options.headlessWaitMs ?? 30000;
    this.saveDebounceMs = options.saveDebounceMs ?? 300;
    this.launchTimeoutReason = `เปิด Claude ใน terminal ไม่สำเร็จ (ไม่มีสัญญาณเริ่ม session ภายใน ${Math.round(
      this.launchTimeoutMs / 1000
    )} วินาที) ลองพิมพ์ claude ในแท็บนั้นแล้วกด "ทำต่อ"`;

    this.quests = new Map(); // id -> record, oldest first
    this._timers = new Map(); // quest id -> the one pending timer of that quest
    this._seq = new Map(); // quest id -> transition counter; a dispatch answer from before a newer transition is stale
    this._saveTimer = null;
    this._dirty = false;
    this._stopped = false;

    this._onChange = (evt) => {
      try {
        this._handleChange(evt);
      } catch {
        // One bad event must not take the server down.
      }
    };
    this._load();
    store.on('change', this._onChange);
  }

  // ---------- public API ----------

  /**
   * Validates a `POST /api/guild/quests` body. Throws QuestError (400, 404, 409, 423); returns
   * `{ heroClassId, goal, name, option, presetPrompt, launch, sessionId, cwd }`, where sessionId
   * is set only for an existing room and cwd only for a new one.
   */
  prepare(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new QuestError(400, 'ข้อมูลเควสต์ไม่ถูกต้อง');
    }
    const heroClass = getHeroClass(body.heroClassId);
    if (!heroClass) throw new QuestError(400, 'ไม่รู้จักอาชีพฮีโร่นี้');

    if (body.goal !== undefined && typeof body.goal !== 'string') throw new QuestError(400, 'เป้าหมายต้องเป็นข้อความ');
    const goal = String(body.goal || '').trim();
    if (!goal) throw new QuestError(400, 'ใส่เป้าหมายของเควสต์ก่อน');
    if (goal.length > MAX_GOAL) throw new QuestError(400, `เป้าหมายยาวเกิน ${MAX_GOAL.toLocaleString('en-US')} ตัวอักษร`);

    if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') {
      throw new QuestError(400, 'ชื่อเควสต์ต้องเป็นข้อความ');
    }
    const name = flattenText(body.name || '');
    if (name.length > MAX_NAME) throw new QuestError(400, `ชื่อเควสต์ยาวเกิน ${MAX_NAME} ตัวอักษร`);

    const option = resolveOption(heroClass, body.optionValue);
    if (option === undefined) throw new QuestError(400, 'ตัวเลือกของอาชีพนี้ไม่ถูกต้อง');

    if (body.presetPrompt !== undefined && body.presetPrompt !== null && typeof body.presetPrompt !== 'string') {
      throw new QuestError(400, 'preset prompt ต้องเป็นข้อความ');
    }
    const preset = String(body.presetPrompt || '').trim();
    if (preset.length > MAX_PRESET) throw new QuestError(400, `preset prompt ยาวเกิน ${MAX_PRESET.toLocaleString('en-US')} ตัวอักษร`);

    const existing = body.sessionId !== undefined && body.sessionId !== null && body.sessionId !== '';
    if (existing && (typeof body.sessionId !== 'string' || body.sessionId.length > MAX_ID)) {
      throw new QuestError(400, 'sessionId ไม่ถูกต้อง');
    }
    let launch = 'existing';
    let cwd = null;
    if (!existing) {
      launch = body.launch === undefined || body.launch === null ? 'terminal' : body.launch;
      if (launch !== 'terminal' && launch !== 'headless') {
        throw new QuestError(400, 'launch ต้องเป็น terminal หรือ headless');
      }
      cwd = this.resolveDirectory(body.cwd);
      if (!cwd) {
        throw new QuestError(400, body.cwd ? `ไม่พบโฟลเดอร์: ${String(body.cwd).slice(0, 300)}` : 'เลือกโฟลเดอร์ที่จะให้ฮีโร่ทำงานก่อน');
      }
    }

    if (this._holding()) throw new QuestError(423, 'พักงานรอ usage reset อยู่ ยังส่งเควสต์ใหม่ไม่ได้');
    if (existing) this._checkRoomFree(body.sessionId);

    return {
      heroClassId: heroClass.id,
      goal,
      name: name || defaultQuestName(goal),
      option,
      presetPrompt: preset || presetFor(heroClass.id, option ? option.value : undefined),
      launch,
      sessionId: existing ? body.sessionId : null,
      cwd,
    };
  }

  /**
   * Starts a prepared quest in room `sessionId` (the existing room, or the one the server just
   * made). Terminal quests wait for the terminal's SessionStart; the others dispatch phase 1 now.
   * Resolves with a copy of the record once that first dispatch has been answered.
   */
  async start(prepared, sessionId = prepared.sessionId) {
    const session = this.store.sessions.get(sessionId);
    if (!session) throw new QuestError(404, 'ไม่พบห้องนี้');
    if (this._busyQuest(sessionId)) throw new QuestError(409, 'ฮีโร่ตัวนี้มีเควสต์ที่กำลังทำอยู่แล้ว');
    // A paused or stalled quest in the same room gives way to the new one.
    for (const old of this._questsFor(sessionId)) {
      if (ACTIVE.has(old.state)) this._finish(old, 'stopped', 'มีเควสต์ใหม่ในห้องนี้แทน', 'warn');
    }

    const heroClass = getHeroClass(prepared.heroClassId);
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const launch = prepared.launch;
    const quest = {
      id: `quest-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`,
      sessionId,
      name: prepared.name,
      heroClassId: heroClass.id,
      goal: prepared.goal,
      option: prepared.option,
      presetPrompt: prepared.presetPrompt,
      launch,
      // An existing room without a terminal is driven the way a background quest is.
      headless:
        launch === 'headless' ||
        (launch === 'existing' && !hasTerminal(session) && Boolean(resolveResumeId(session))),
      plan: planFor(heroClass.id),
      phaseIndex: 0,
      loop: 1,
      maxLoops: heroClass.loops && prepared.option ? Number(prepared.option.value) : 1,
      state: launch === 'terminal' ? 'launching' : 'running',
      stateReason: null,
      awaitingTurn: false,
      probeSent: false,
      // The current phase's prompt reached the room (false between phases).
      phaseSent: false,
      // The verify note a loop-back fix works from.
      failNote: null,
      // "ทำต่อ" while the room was busy with something else: start this phase at its next Stop.
      waitForIdle: false,
      resumeNote: null,
      lastVerdict: null,
      // The room's last answer so far: a transcript still ending with it is not this turn's.
      answerKey: answerKey(this.readTranscriptText(session)),
      log: [],
      createdAt: nowIso,
      updatedAt: nowIso,
      finishedAt: null,
    };
    this.quests.set(quest.id, quest);
    this._prune();

    const how =
      launch === 'terminal'
        ? 'เปิด Windows Terminal ให้ฮีโร่ รอ Claude พร้อม'
        : quest.headless
          ? 'ทำงานเบื้องหลัง (claude -p) แก้ไฟล์ได้โดยไม่ต้องถาม'
          : 'ใช้ห้องที่เปิดอยู่';
    this._log(quest, `รับเควสต์ "${quest.name}" · ${heroClass.name} (${heroClass.titleThai}) — ${how}`);
    if (launch === 'terminal') {
      this._setTimer(quest, this.launchTimeoutMs, () => this._launchTimedOut(quest.id));
      this._touch(quest);
      return this.get(quest.id);
    }
    this._touch(quest);
    await this._dispatch(quest);
    return this.get(quest.id);
  }

  /** prepare + start, for a body that names its room (or for tests). */
  async createQuest(body) {
    const prepared = this.prepare(body);
    return this.start(prepared, prepared.sessionId || body.sessionId);
  }

  /** The terminal for a terminal quest could not be opened. */
  launchFailed(questId, message) {
    const quest = this.quests.get(questId);
    if (!quest || quest.state !== 'launching') return;
    this._stall(quest, `เปิด terminal ไม่สำเร็จ: ${message || 'ไม่ทราบสาเหตุ'}`);
  }

  /** `POST /api/guild/quest-action`: stop or resume. Resolves with a copy of the record. */
  async action(questId, action, note) {
    if (typeof questId !== 'string' || !questId || questId.length > MAX_ID) throw new QuestError(400, 'ไม่ระบุเควสต์');
    if (action !== 'stop' && action !== 'resume') throw new QuestError(400, 'action ต้องเป็น stop หรือ resume');
    if (note !== undefined && note !== null && typeof note !== 'string') throw new QuestError(400, 'note ต้องเป็นข้อความ');
    if (typeof note === 'string' && note.length > MAX_NOTE) {
      throw new QuestError(400, `ข้อความยาวเกิน ${MAX_NOTE.toLocaleString('en-US')} ตัวอักษร`);
    }
    const quest = this.quests.get(questId);
    if (!quest) throw new QuestError(404, 'ไม่พบเควสต์นี้');

    if (action === 'stop') {
      if (!ACTIVE.has(quest.state)) throw new QuestError(409, 'เควสต์นี้จบไปแล้ว');
      // No keys go to the terminal: a turn in progress finishes on its own.
      this._finish(quest, 'stopped', 'หยุดโดยผู้ใช้ งานที่กำลังทำอยู่จะจบรอบนี้เอง', 'warn');
      return this.get(quest.id);
    }
    if (quest.state !== 'paused' && quest.state !== 'stalled') {
      throw new QuestError(409, 'ทำต่อได้เฉพาะเควสต์ที่พักหรือค้างอยู่');
    }
    if (this._holding()) throw new QuestError(423, 'พักงานรอ usage reset อยู่ ยังทำต่อไม่ได้');
    await this._resume(quest, (note || '').trim() || null);
    return this.get(quest.id);
  }

  /** Newest first, at most 50 (copies). */
  list() {
    return this._sorted()
      .slice(-LIST_LIMIT)
      .reverse()
      .map((q) => structuredClone(q));
  }

  get(id) {
    const quest = this.quests.get(id);
    return quest ? structuredClone(quest) : null;
  }

  /** The room's newest quest that is still launching or running, if any. */
  busyQuestFor(sessionId) {
    const quest = this._busyQuest(sessionId);
    return quest ? structuredClone(quest) : null;
  }

  /** Writes pending changes now (server close). */
  flush() {
    if (this._dirty) this._save();
  }

  /** Stops listening, clears every timer and writes what is pending. */
  stop() {
    this._stopped = true;
    this.store.removeListener('change', this._onChange);
    for (const handle of this._timers.values()) this.unschedule(handle);
    this._timers.clear();
    this.flush();
  }

  // ---------- events ----------

  _handleChange({ type, detail } = {}) {
    if (this._stopped) return;
    const sessionId = detail && detail.sessionId;
    if (type === 'hook_event' && sessionId) {
      if (detail.hookEvent === 'SessionStart') this._onSessionStart(sessionId);
      else if (detail.hookEvent === 'Stop') this._onStop(sessionId, detail);
      else if (detail.hookEvent === 'SessionEnd') this._onSessionEnd(sessionId);
    } else if ((type === 'session_archived' || type === 'session_removed') && sessionId) {
      const reason = type === 'session_archived' ? 'ห้องถูกเก็บเข้าประวัติแล้ว' : 'ห้องถูกลบแล้ว';
      for (const quest of this._questsFor(sessionId)) {
        if (ACTIVE.has(quest.state)) this._finish(quest, 'stopped', reason, 'warn');
      }
    } else if (type === 'session_merged' && sessionId && detail.into) {
      // The room was merged into another one (same Claude session or terminal): follow it.
      for (const quest of this._questsFor(sessionId)) quest.sessionId = detail.into;
      const latest = this._latestFor(detail.into);
      if (latest) this._touch(latest);
    } else if (type === 'quota_resumed') {
      // The hold lifted: quests it paused carry on by themselves.
      for (const quest of this._sorted()) {
        if (quest.state === 'paused' && quest.stateReason === USAGE_REASON) {
          this._resume(quest, null).catch(() => {});
        }
      }
    }
  }

  _onSessionStart(sessionId) {
    const quest = this._activeFor(sessionId);
    if (!quest || quest.launch !== 'terminal') return;
    // Claude may come up after the launch timed out (started by hand in that tab): carry on.
    const atLaunch =
      quest.state === 'launching' ||
      (quest.state === 'stalled' && !quest.phaseSent && quest.stateReason === this.launchTimeoutReason);
    if (!atLaunch) return;
    this._bump(quest);
    quest.state = 'launching';
    quest.stateReason = null;
    this._log(quest, 'Claude ในแท็บพร้อมแล้ว เริ่มขั้นแรก');
    this._touch(quest);
    // Give the terminal a moment to draw its input box before typing into it.
    this._setTimer(quest, this.sessionStartDelayMs, () => this._fireDispatch(quest.id, {}, 0));
  }

  _onSessionEnd(sessionId) {
    const quest = this._activeFor(sessionId);
    if (!quest || (quest.state !== 'launching' && quest.state !== 'running')) return;
    // A background run's Claude session ends after every phase; that is not a closed terminal
    // (the store keeps such a room live too, see StateStore.processHookEvent).
    if (quest.headless) return;
    this._stall(quest, 'ปิด terminal ไปแล้ว กู้คืนห้องในหน้าแชทก่อน แล้วกด "ทำต่อ"');
  }

  _onStop(sessionId, detail) {
    const quest = this._activeFor(sessionId);
    if (!quest || quest.state !== 'running') return;
    if (!quest.awaitingTurn) {
      // The turn the room was busy with is over: now start the phase "ทำต่อ" asked for.
      if (quest.waitForIdle) {
        quest.waitForIdle = false;
        const note = quest.resumeNote;
        quest.resumeNote = null;
        this._touch(quest);
        this._scheduleDispatch(quest, this.phaseGapMs, { resume: true, note });
      }
      // Otherwise a second Stop (a background run's exit) or a turn started by hand.
      return;
    }
    this._bump(quest);
    quest.awaitingTurn = false;
    const session = this.store.sessions.get(sessionId);
    const given = typeof detail.lastAssistantMessage === 'string' ? detail.lastAssistantMessage : '';
    if (quest.headless && isHeadlessExitSummary(given)) {
      this._stall(quest, `รัน Claude เบื้องหลังไม่สำเร็จ: ${given}`);
      return;
    }
    // The hook's own copy first; the transcript only when that carries no verdict, and only when
    // it no longer ends with the previous turn's answer (this turn's may not be written yet).
    let verdict = parseVerdict(given);
    let answer = given;
    if (!verdict) {
      const fromFile = this.readTranscriptText(session) || '';
      if (fromFile && answerKey(fromFile) !== quest.answerKey) {
        verdict = parseVerdict(fromFile);
        if (!answer) answer = fromFile;
      }
    }
    if (answer) quest.answerKey = answerKey(answer);
    quest.lastVerdict = verdict;
    const phase = quest.plan[quest.phaseIndex];

    if (verdict && verdict.kind === 'BLOCKED') {
      this._pause(quest, verdict.note ? `Claude รอคุณ: ${verdict.note}` : 'Claude รอข้อมูลหรือการตัดสินใจจากคุณ');
      return;
    }
    if (phase.kind === 'verify') {
      if (verdict && verdict.kind === 'PASS') {
        this._log(quest, `ทดสอบผ่าน${quest.maxLoops > 1 ? ` (รอบ ${quest.loop}/${quest.maxLoops})` : ''}`, 'success');
        this._advance(quest);
        return;
      }
      if (verdict && verdict.kind === 'FAIL') {
        const note = verdict.note || 'ทดสอบไม่ผ่าน';
        const fixIndex = quest.plan.findIndex((p) => p.kind === 'fix');
        if (quest.loop < quest.maxLoops && fixIndex >= 0) {
          this._log(quest, `ทดสอบไม่ผ่าน (รอบ ${quest.loop}/${quest.maxLoops}): ${note} — วนกลับไปแก้`, 'warn');
          quest.loop += 1;
          quest.phaseIndex = fixIndex;
          quest.failNote = note;
          quest.probeSent = false;
          quest.phaseSent = false;
          this._touch(quest);
          this._scheduleDispatch(quest, this.phaseGapMs);
          return;
        }
        const rounds = quest.maxLoops > 1 ? ` ครบ ${quest.maxLoops} รอบ` : '';
        this._finish(quest, 'failed', `ทดสอบไม่ผ่าน${rounds}: ${note}`, 'error');
        return;
      }
      if (!quest.probeSent) {
        quest.probeSent = true;
        this._log(quest, 'ไม่พบบรรทัด QUEST-VERDICT ถามผลทดสอบอีกครั้ง', 'warn');
        this._touch(quest);
        this._scheduleDispatch(quest, this.phaseGapMs, { probe: true });
        return;
      }
      this._pause(quest, 'ไม่ได้รับผลทดสอบ (ไม่มีบรรทัด QUEST-VERDICT: PASS/FAIL) ตรวจผลในห้องแล้วกด "ทำต่อ"');
      return;
    }
    this._log(quest, `จบขั้น ${quest.phaseIndex + 1}/${quest.plan.length} ${phase.title}`, 'success');
    this._advance(quest);
  }

  // ---------- transitions ----------

  _advance(quest) {
    if (quest.phaseIndex + 1 >= quest.plan.length) {
      this._finish(quest, 'done', null, 'success');
      return;
    }
    quest.phaseIndex += 1;
    quest.probeSent = false;
    quest.phaseSent = false;
    this._touch(quest);
    this._scheduleDispatch(quest, this.phaseGapMs);
  }

  async _resume(quest, note) {
    const session = this.store.sessions.get(quest.sessionId);
    if (!session) {
      this._finish(quest, 'stopped', 'ไม่พบห้องของเควสต์นี้แล้ว', 'warn');
      return;
    }
    if (session.status === 'working' || session.status === 'needs_input') {
      this._clearTimer(quest);
      this._bump(quest);
      quest.state = 'running';
      quest.stateReason = null;
      if (quest.phaseSent) {
        // The phase's own turn is still going: its Stop carries the quest on.
        quest.awaitingTurn = true;
        this._log(quest, 'ทำต่อ: ห้องยังทำงานอยู่ รอให้รอบนี้จบแล้วไปต่อ');
      } else {
        quest.waitForIdle = true;
        quest.resumeNote = note;
        this._log(quest, 'ทำต่อ: ห้องกำลังทำอย่างอื่นอยู่ จะเริ่มขั้นนี้เมื่อรอบนั้นจบ');
      }
      this._touch(quest);
      return;
    }
    if (this._headlessBusy(quest)) {
      throw new QuestError(409, 'งานเบื้องหลังรอบก่อนยังไม่ปิด รอสักครู่แล้วกด "ทำต่อ" อีกครั้ง');
    }
    await this._dispatch(quest, { resume: true, note });
  }

  /** A background quest's previous `claude -p` process is still running. */
  _headlessBusy(quest) {
    return Boolean(quest.headless && this.bridge.activeProcesses && this.bridge.activeProcesses.has(quest.sessionId));
  }

  /** Sends the current phase (or the verdict probe) to the room. */
  async _dispatch(quest, { resume = false, note = null, probe = false } = {}) {
    if (!ACTIVE.has(quest.state)) return;
    const session = this.store.sessions.get(quest.sessionId);
    if (!session) {
      this._finish(quest, 'stopped', 'ไม่พบห้องของเควสต์นี้แล้ว', 'warn');
      return;
    }
    if (this._holding()) {
      this._pause(quest, USAGE_REASON);
      return;
    }
    const phase = quest.plan[quest.phaseIndex];
    const prompt = probe
      ? buildProbePrompt()
      : buildPhasePrompt({
          quest,
          phase,
          failNote: phase.kind === 'fix' && quest.loop > 1 ? quest.failNote : null,
          resume,
          note,
        });
    const seq = this._bump(quest);
    const sentBefore = quest.phaseSent;
    quest.state = 'running';
    quest.stateReason = null;
    quest.awaitingTurn = true;
    quest.waitForIdle = false;
    quest.resumeNote = null;
    quest.phaseSent = true; // set first: a very fast Stop may arrive before the answer below
    if (!probe) quest.probeSent = false; // a phase sent afresh may ask for its verdict once again
    const loopText = quest.maxLoops > 1 && phase.kind !== 'investigate' ? ` · รอบ ${quest.loop}/${quest.maxLoops}` : '';
    this._log(
      quest,
      probe
        ? 'ขอผลทดสอบเป็นบรรทัด QUEST-VERDICT'
        : `${resume ? 'ทำต่อ' : 'เริ่ม'}ขั้น ${quest.phaseIndex + 1}/${quest.plan.length} ${phase.title} · ${
            SCENE_LABELS[phase.scene] || phase.scene
          }${loopText}`
    );
    this._touch(quest);

    let result;
    try {
      // noQueue: an undelivered phase stalls here and is sent again on "ทำต่อ"; a copy left in
      // the room's queue could reach the terminal later by itself.
      result = await this.bridge.dispatchCommand(
        quest.sessionId,
        prompt,
        quest.headless ? { ...HEADLESS_OPTIONS } : { noQueue: true }
      );
    } catch (err) {
      result = { ok: false, delivered: false, message: err && err.message };
    }
    // Stopped, ended or moved on while the bridge was busy: this answer is old news.
    if (this._seq.get(quest.id) !== seq || quest.state !== 'running') return;
    if (!result || result.ok === false || result.delivered === false) {
      quest.awaitingTurn = false;
      quest.phaseSent = probe ? sentBefore : false;
      this._stall(quest, `ส่งคำสั่งไม่ถึง Claude: ${(result && result.message) || 'ไม่ทราบสาเหตุ'}`);
    }
  }

  _scheduleDispatch(quest, delay, opts = {}) {
    this._setTimer(quest, delay, () => this._fireDispatch(quest.id, opts, 0));
  }

  _fireDispatch(questId, opts, waited) {
    const quest = this.quests.get(questId);
    if (!quest || (quest.state !== 'running' && quest.state !== 'launching') || quest.awaitingTurn) return;
    if (this._headlessBusy(quest)) {
      if (waited < this.headlessWaitMs) {
        this._setTimer(quest, 500, () => this._fireDispatch(questId, opts, waited + 500));
        return;
      }
      // Never two runs at once: the old one's exit would end the new phase.
      this._stall(quest, 'งานเบื้องหลังรอบก่อนยังไม่ปิด รอให้จบแล้วกด "ทำต่อ"');
      return;
    }
    this._dispatch(quest, opts).catch(() => {});
  }

  _launchTimedOut(questId) {
    const quest = this.quests.get(questId);
    if (quest && quest.state === 'launching') this._stall(quest, this.launchTimeoutReason);
  }

  _pause(quest, reason) {
    this._halt(quest, 'paused', reason);
    this._log(quest, `พักเควสต์: ${reason}`, 'warn');
    this._touch(quest);
  }

  _stall(quest, reason) {
    this._halt(quest, 'stalled', reason);
    this._log(quest, `เควสต์ค้าง: ${reason}`, 'error');
    this._touch(quest);
  }

  _finish(quest, state, reason, level) {
    this._halt(quest, state, reason);
    quest.finishedAt = new Date(this.now()).toISOString();
    const label = { done: 'เควสต์สำเร็จ', failed: 'เควสต์ล้มเหลว', stopped: 'หยุดเควสต์แล้ว' }[state];
    this._log(quest, reason ? `${label}: ${reason}` : label, level);
    this._touch(quest);
  }

  _halt(quest, state, reason) {
    this._clearTimer(quest);
    this._bump(quest);
    quest.state = state;
    quest.stateReason = reason || null;
    quest.awaitingTurn = false;
    quest.waitForIdle = false;
    quest.resumeNote = null;
  }

  // ---------- helpers ----------

  _holding() {
    return Boolean(this.usageGuard && this.usageGuard.isHolding());
  }

  _checkRoomFree(sessionId) {
    const session = this.store.sessions.get(sessionId);
    if (!session) throw new QuestError(404, 'ไม่พบห้องนี้');
    if (session.lifecycle === 'history') throw new QuestError(409, 'ห้องนี้ปิดไปแล้ว กู้คืนห้องก่อนส่งเควสต์');
    if (session.status === 'working' || session.status === 'needs_input') {
      throw new QuestError(409, 'ฮีโร่ตัวนี้กำลังทำงานหรือรอคำตอบอยู่');
    }
    if (this._busyQuest(sessionId)) throw new QuestError(409, 'ฮีโร่ตัวนี้มีเควสต์ที่กำลังทำอยู่แล้ว');
  }

  _bump(quest) {
    const seq = (this._seq.get(quest.id) || 0) + 1;
    this._seq.set(quest.id, seq);
    return seq;
  }

  _setTimer(quest, ms, fn) {
    this._clearTimer(quest);
    if (this._stopped) return;
    const handle = this.schedule(() => {
      if (this._timers.get(quest.id) === handle) this._timers.delete(quest.id);
      fn();
    }, ms);
    if (handle && typeof handle.unref === 'function') handle.unref();
    this._timers.set(quest.id, handle);
  }

  _clearTimer(quest) {
    const handle = this._timers.get(quest.id);
    if (handle) {
      this.unschedule(handle);
      this._timers.delete(quest.id);
    }
  }

  _sorted() {
    return Array.from(this.quests.values()).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  _questsFor(sessionId) {
    return this._sorted().filter((q) => q.sessionId === sessionId);
  }

  _latestFor(sessionId) {
    const list = this._questsFor(sessionId);
    return list[list.length - 1] || null;
  }

  _activeFor(sessionId) {
    const list = this._questsFor(sessionId).filter((q) => ACTIVE.has(q.state));
    return list[list.length - 1] || null;
  }

  _busyQuest(sessionId) {
    const quest = this._activeFor(sessionId);
    return quest && (quest.state === 'launching' || quest.state === 'running') ? quest : null;
  }

  _log(quest, text, level = 'info') {
    quest.log.push({ at: new Date(this.now()).toISOString(), text: String(text), level });
    if (quest.log.length > MAX_LOG) quest.log.splice(0, quest.log.length - MAX_LOG);
  }

  /** Records a change: timestamp, the room's mirror, a save soon. */
  _touch(quest) {
    quest.updatedAt = new Date(this.now()).toISOString();
    this._mirror(quest);
    this._scheduleSave();
  }

  _mirrorOf(quest) {
    const heroClass = getHeroClass(quest.heroClassId);
    const active = ACTIVE.has(quest.state);
    const phase = active ? quest.plan[quest.phaseIndex] || null : null;
    return {
      id: quest.id,
      name: quest.name,
      heroClassId: quest.heroClassId,
      heroName: heroClass ? heroClass.name : quest.heroClassId,
      goal: quest.goal,
      state: quest.state,
      stateReason: quest.stateReason,
      phaseIndex: quest.phaseIndex,
      phaseCount: quest.plan.length,
      phase: phase ? { ...phase } : null,
      loop: quest.loop,
      maxLoops: quest.maxLoops,
      scene: phase ? phase.scene : 'sanctuary',
      log: quest.log.slice(-MIRROR_LOG).map((entry) => ({ ...entry })),
      updatedAt: quest.updatedAt,
    };
  }

  /** Only a room's newest quest is shown on it. */
  _mirror(quest) {
    if (!this.store.sessions.has(quest.sessionId)) return;
    if (this._latestFor(quest.sessionId) !== quest) return;
    this.store.updateSession(quest.sessionId, { quest: this._mirrorOf(quest) });
  }

  /** Keeps the newest MAX_QUESTS, dropping finished ones first. */
  _prune() {
    if (this.quests.size <= MAX_QUESTS) return;
    const sorted = this._sorted();
    let excess = this.quests.size - MAX_QUESTS;
    for (const quest of sorted) {
      if (excess <= 0) break;
      if (ACTIVE.has(quest.state)) continue;
      this.quests.delete(quest.id);
      this._seq.delete(quest.id);
      excess -= 1;
    }
  }

  // ---------- persistence ----------

  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer || this._stopped) return;
    this._saveTimer = setTimeout(() => this._save(), this.saveDebounceMs);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  /** Atomic write (temp file + rename), like the session state. */
  _save() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._dirty = false;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const payload = { version: 1, updatedAt: new Date(this.now()).toISOString(), quests: this._sorted() };
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {}
  }

  /** A stored record, checked field by field; null when it is not one. */
  _cleanRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const heroClass = getHeroClass(raw.heroClassId);
    if (typeof raw.id !== 'string' || !/^quest-[a-z0-9]+-[a-z0-9]+$/.test(raw.id)) return null;
    if (typeof raw.sessionId !== 'string' || !raw.sessionId || !heroClass || !STATES.has(raw.state)) return null;
    if (typeof raw.goal !== 'string' || !raw.goal || Number.isNaN(Date.parse(raw.createdAt))) return null;
    const plan = planFor(heroClass.id);
    const option = resolveOption(heroClass, raw.option && raw.option.value) ?? resolveOption(heroClass, null);
    const int = (v, min, max, fallback) => (Number.isInteger(v) && v >= min && v <= max ? v : fallback);
    const text = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
    const verdict =
      raw.lastVerdict && typeof raw.lastVerdict.kind === 'string'
        ? { kind: raw.lastVerdict.kind, note: String(raw.lastVerdict.note || '') }
        : null;
    const maxLoops = heroClass.loops && option ? Number(option.value) : 1;
    return {
      id: raw.id,
      sessionId: raw.sessionId,
      name: text(raw.name, MAX_NAME) || defaultQuestName(raw.goal),
      heroClassId: heroClass.id,
      goal: raw.goal.slice(0, MAX_GOAL),
      option: option || null,
      presetPrompt: text(raw.presetPrompt, MAX_PRESET) || presetFor(heroClass.id, option ? option.value : undefined),
      launch: ['terminal', 'headless', 'existing'].includes(raw.launch) ? raw.launch : 'existing',
      headless: Boolean(raw.headless),
      plan,
      phaseIndex: int(raw.phaseIndex, 0, plan.length - 1, 0),
      loop: int(raw.loop, 1, maxLoops, 1),
      maxLoops,
      state: raw.state,
      stateReason: text(raw.stateReason, 1000),
      awaitingTurn: Boolean(raw.awaitingTurn),
      probeSent: Boolean(raw.probeSent),
      phaseSent: Boolean(raw.phaseSent),
      failNote: text(raw.failNote, 1000),
      waitForIdle: Boolean(raw.waitForIdle),
      resumeNote: text(raw.resumeNote, MAX_NOTE),
      lastVerdict: verdict,
      answerKey: text(raw.answerKey, 400),
      log: (Array.isArray(raw.log) ? raw.log : [])
        .filter((e) => e && typeof e.text === 'string')
        .slice(-MAX_LOG)
        .map((e) => ({
          at: Number.isNaN(Date.parse(e.at)) ? raw.createdAt : e.at,
          text: e.text.slice(0, 2000),
          level: LEVELS.has(e.level) ? e.level : 'info',
        })),
      createdAt: raw.createdAt,
      updatedAt: Number.isNaN(Date.parse(raw.updatedAt)) ? raw.createdAt : raw.updatedAt,
      finishedAt: Number.isNaN(Date.parse(raw.finishedAt)) ? null : raw.finishedAt,
    };
  }

  /**
   * Loads guild-quests.json and settles what a restart interrupted: a quest whose room is gone
   * stops, a launch waits for its terminal again, a pending phase is sent again, and a background
   * phase that was running has lost its process (stalled). Every room's mirror is re-applied.
   */
  _load() {
    let raw;
    try {
      if (!fs.existsSync(this.file)) return;
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    const list = raw && Array.isArray(raw.quests) ? raw.quests : [];
    for (const item of list) {
      const quest = this._cleanRecord(item);
      if (quest) this.quests.set(quest.id, quest);
    }
    this._prune();
    for (const quest of this._sorted()) {
      if (!ACTIVE.has(quest.state)) continue;
      if (!this.store.sessions.has(quest.sessionId)) {
        this._finish(quest, 'stopped', 'ห้องของเควสต์นี้ไม่อยู่แล้ว', 'warn');
      } else if (quest.state === 'launching') {
        this._setTimer(quest, this.launchTimeoutMs, () => this._launchTimedOut(quest.id));
      } else if (quest.state === 'running' && quest.headless && quest.awaitingTurn) {
        this._stall(quest, 'Mission Control เริ่มใหม่ระหว่างที่งานเบื้องหลังกำลังรัน ตรวจผลในห้องแล้วกด "ทำต่อ"');
      } else if (quest.state === 'running' && !quest.awaitingTurn && !quest.waitForIdle) {
        this._scheduleDispatch(quest, this.phaseGapMs, { probe: quest.probeSent && quest.phaseSent });
      } else if (quest.state === 'paused' && quest.stateReason === USAGE_REASON && !this._holding()) {
        // The hold lifted while Mission Control was closed: no quota_resumed will come for it.
        this._setTimer(quest, this.phaseGapMs, () => this._resume(quest, null).catch(() => {}));
      }
    }
    const rooms = new Set(Array.from(this.quests.values(), (q) => q.sessionId));
    for (const sessionId of rooms) {
      const latest = this._latestFor(sessionId);
      if (latest) this._mirror(latest);
    }
  }
}

module.exports = { QuestRunner, QuestError, QUEST_FILE, USAGE_REASON, defaultQuestName };
