/**
 * Guild Mode backend: hero classes and phase prompts (src/guild-classes.js), the quest runner's
 * state machine with a fake store, bridge and clock (src/quest-runner.js), the bridge and store
 * pieces it relies on, and the /guild + /api/guild/* routes.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-guild-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

const guild = require('../src/guild-classes');
const { QuestRunner, QuestError, USAGE_REASON, QUEST_FILE } = require('../src/quest-runner');
const {
  CommandBridge,
  headlessClaudeArgs,
  headlessExitSummary,
  headlessErrorSummary,
  isHeadlessExitSummary,
} = require('../src/command-bridge');
const { StateStore } = require('../src/state-store');
const { createMissionControlServer } = require('../src/server');

const TOKEN = 'g'.repeat(48);
const UUID_A = '5f0c2a8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const UUID_B = '6a1d3b9f-2c3d-4e5f-9a01-b2c3d4e5f6a7';
const UUID_C = '7b2e4ca0-3d4e-4f60-8b12-c3d4e5f6a7b8';
const settle = () => new Promise((r) => setImmediate(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function roomDir(name) {
  const dir = path.join(isolatedHome, 'rooms', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------------------------
// 1. Hero classes, presets and the client shape
// ---------------------------------------------------------------------------------------------
function testClasses() {
  const classes = guild.classesForClient();
  assert.deepStrictEqual(
    classes.map((c) => c.id),
    ['researcher', 'bug_hunter', 'quick_fix', 'full_slayer', 'qa_loop']
  );
  const kinds = (id) => guild.planFor(id).map((p) => p.kind);
  assert.deepStrictEqual(kinds('researcher'), ['research']);
  assert.deepStrictEqual(kinds('bug_hunter'), ['investigate']);
  assert.deepStrictEqual(kinds('quick_fix'), ['fix']);
  assert.deepStrictEqual(kinds('full_slayer'), ['investigate', 'fix', 'verify']);
  assert.deepStrictEqual(kinds('qa_loop'), ['investigate', 'fix', 'verify']);
  assert.deepStrictEqual(
    guild.planFor('qa_loop').map((p) => p.scene),
    ['library', 'dungeon', 'camp'],
    'phase kinds map to their scenes'
  );
  assert.deepStrictEqual(guild.planFor('nope'), []);

  for (const c of classes) {
    for (const key of ['id', 'name', 'titleThai', 'badge', 'accent', 'flowSteps', 'route', 'phases', 'option', 'presets']) {
      assert.ok(key in c, `${c.id} has ${key}`);
    }
    assert.strictEqual(c.route[c.route.length - 1], 'sanctuary', 'every route ends in the sanctuary');
    for (const p of c.phases) assert.deepStrictEqual(Object.keys(p).sort(), ['id', 'kind', 'scene', 'title']);
    assert.strictEqual(JSON.parse(JSON.stringify(c)).id, c.id, 'plain JSON, no functions');
  }
  const researcher = classes.find((c) => c.id === 'researcher');
  assert.strictEqual(researcher.option.key, 'depth');
  assert.strictEqual(researcher.option.default, 'medium');
  assert.deepStrictEqual(researcher.option.values.map((v) => v.value), ['shallow', 'medium', 'deep']);
  assert.deepStrictEqual(Object.keys(researcher.presets), ['shallow', 'medium', 'deep']);
  assert.ok(researcher.presets.deep.includes('Deep Dive') && researcher.presets.deep.includes('ไม่แก้ไขไฟล์จริง'));
  const qa = classes.find((c) => c.id === 'qa_loop');
  assert.strictEqual(qa.option.key, 'maxLoops');
  assert.strictEqual(qa.option.default, 3);
  assert.deepStrictEqual(qa.option.values.map((v) => v.value), [2, 3, 5]);
  assert.ok(qa.presets['5'].includes('สูงสุด 5 รอบ'));
  for (const id of ['bug_hunter', 'quick_fix', 'full_slayer']) {
    const c = classes.find((x) => x.id === id);
    assert.strictEqual(c.option, null);
    assert.deepStrictEqual(Object.keys(c.presets), ['default']);
    assert.ok(c.presets.default.startsWith('[ROLE: '));
  }

  const researcherClass = guild.getHeroClass('researcher');
  assert.deepStrictEqual(guild.resolveOption(researcherClass, undefined), { key: 'depth', value: 'medium' });
  assert.deepStrictEqual(guild.resolveOption(guild.getHeroClass('qa_loop'), '5'), { key: 'maxLoops', value: 5 });
  assert.strictEqual(guild.resolveOption(guild.getHeroClass('qa_loop'), 4), undefined, 'not one of the values');
  assert.strictEqual(guild.resolveOption(guild.getHeroClass('quick_fix'), 'x'), null, 'no option to choose');
  assert.strictEqual(guild.presetFor('qa_loop', 2), qa.presets['2']);
}

// ---------------------------------------------------------------------------------------------
// 2. parseVerdict
// ---------------------------------------------------------------------------------------------
function testParseVerdict() {
  const p = guild.parseVerdict;
  assert.deepStrictEqual(p('ทำเสร็จแล้ว\nQUEST-VERDICT: DONE'), { kind: 'DONE', note: '' });
  assert.deepStrictEqual(
    p('QUEST-VERDICT: FAIL — เก่า\nแก้แล้วรันใหม่\nQUEST-VERDICT: PASS'),
    { kind: 'PASS', note: '' },
    'the last line wins'
  );
  assert.deepStrictEqual(p('**QUEST-VERDICT:** FAIL — เทส 2 ตัวไม่ผ่าน'), { kind: 'FAIL', note: 'เทส 2 ตัวไม่ผ่าน' });
  assert.deepStrictEqual(p('`QUEST-VERDICT: PASS`'), { kind: 'PASS', note: '' }, 'backticks');
  assert.deepStrictEqual(p('**QUEST-VERDICT: BLOCKED** - ต้องการ URL ของ staging'), {
    kind: 'BLOCKED',
    note: 'ต้องการ URL ของ staging',
  });
  assert.deepStrictEqual(p('quest-verdict: fail: login.test.js line 40'), { kind: 'FAIL', note: 'login.test.js line 40' });
  assert.deepStrictEqual(p('ผลคือ QUEST-VERDICT: FAIL – timeout ใน `api.test.js`'), {
    kind: 'FAIL',
    note: 'timeout ใน `api.test.js',
  });
  assert.strictEqual(p('ไม่มีบรรทัดผลลัพธ์'), null);
  assert.strictEqual(p('QUEST-VERDICT: MAYBE'), null);
  assert.strictEqual(p('QUEST-VERDICT: PASSED'), null, 'a whole word only');
  assert.strictEqual(p(''), null);
  assert.strictEqual(p(null), null);
  assert.strictEqual(p('x\r\nQUEST-VERDICT: DONE\r\n').kind, 'DONE', 'CRLF text');
  assert.ok(p(`QUEST-VERDICT: FAIL — ${'ก'.repeat(900)}`).note.length <= 500, 'notes are capped');
}

// ---------------------------------------------------------------------------------------------
// 3. buildPhasePrompt / buildProbePrompt
// ---------------------------------------------------------------------------------------------
function questFor(classId, extra = {}) {
  const heroClass = guild.getHeroClass(classId);
  const option = guild.resolveOption(heroClass, extra.optionValue);
  return {
    name: 'แก้ login ค้าง',
    heroClassId: classId,
    goal: 'หน้า login ค้าง\nเมื่อกด submit สองครั้ง',
    option,
    presetPrompt: guild.presetFor(classId, option ? option.value : undefined),
    plan: guild.planFor(classId),
    phaseIndex: 0,
    loop: 1,
    maxLoops: heroClass.loops ? option.value : 1,
    ...extra,
  };
}

function testPhasePrompt() {
  const oneLine = (s) => assert.ok(!/[\r\n]/.test(s), `one line: ${s.slice(0, 80)}`);
  const quest = questFor('qa_loop', { optionValue: 3 });

  const first = guild.buildPhasePrompt({ quest });
  oneLine(first);
  assert.ok(first.startsWith('⚔️ Quest "แก้ login ค้าง" · ขั้น 1/3 สืบหาต้นตอ (ห้องสมุด) — เป้าหมาย: หน้า login ค้าง เมื่อกด submit สองครั้ง'), first);
  assert.ok(first.includes(' ‖ บทบาท: [ROLE: Ironclad QA Loop | Max Retry Loops: 3] ค้นหาสาเหตุ'), 'preset, flattened');
  assert.ok(first.includes('สิ่งที่ต้องทำในขั้นนี้: สืบหาต้นตอ') && first.includes('ห้ามแก้ไขหรือสร้างไฟล์'), 'read-only investigate');
  assert.ok(first.includes('แผนแก้'), 'a multi-phase investigate ends with a fix plan');
  assert.ok(first.includes('QUEST-VERDICT: DONE') && first.includes('QUEST-VERDICT: BLOCKED — <สิ่งที่ต้องการ>'));
  assert.ok(!first.includes('QUEST-VERDICT: PASS'), 'only verify asks for PASS/FAIL');
  assert.ok(!first.includes('รอบ 1/3'), 'no loop count on the investigate phase');

  const solo = guild.buildPhasePrompt({ quest: questFor('bug_hunter') });
  assert.ok(solo.includes('แนวทางแก้ที่แนะนำ') && !solo.includes('แผนแก้'), 'a lone investigate only recommends');

  const verify = guild.buildPhasePrompt({ quest: { ...quest, phaseIndex: 2, loop: 2 } });
  oneLine(verify);
  assert.ok(verify.includes('ขั้น 3/3 ทดสอบ (ค่ายทดสอบ) · รอบ 2/3'), verify.slice(0, 120));
  assert.ok(verify.includes('QUEST-VERDICT: PASS') && verify.includes('QUEST-VERDICT: FAIL — <'));
  assert.ok(verify.includes('package.json') && verify.includes('ห้ามแก้โค้ดในขั้นนี้'));

  const loopBack = guild.buildPhasePrompt({
    quest: { ...quest, phaseIndex: 1, loop: 2 },
    failNote: 'login.test.js:\n expected 200 got 500',
  });
  oneLine(loopBack);
  assert.ok(loopBack.includes('ผลทดสอบรอบก่อน: login.test.js: expected 200 got 500'), 'the FAIL note is carried');
  assert.ok(loopBack.includes('แก้เฉพาะสิ่งที่ทำให้ไม่ผ่าน'), 'a loop-back fixes what failed');
  assert.ok(loopBack.indexOf('ผลทดสอบรอบก่อน') < loopBack.indexOf('กติกา:'));

  const fixFirst = guild.buildPhasePrompt({ quest: { ...quest, phaseIndex: 1 }, failNote: null });
  assert.ok(!fixFirst.includes('ผลทดสอบรอบก่อน') && fixFirst.includes('diff เล็ก'));

  const depthShallow = guild.buildPhasePrompt({ quest: questFor('researcher', { optionValue: 'shallow' }) });
  const depthDeep = guild.buildPhasePrompt({ quest: questFor('researcher', { optionValue: 'deep' }) });
  assert.ok(depthShallow.includes('Quick Scan') && depthDeep.includes('trace data flow'), 'research honours depth');

  const resumed = guild.buildPhasePrompt({ quest, resume: true, note: 'ใช้ staging\nไม่ใช่ prod' });
  assert.ok(resumed.startsWith('↻ ทำต่อจากที่ค้างไว้ — ข้อความจากผู้ใช้: ใช้ staging ไม่ใช่ prod ‖ ⚔️ Quest'), resumed.slice(0, 100));
  assert.ok(guild.buildPhasePrompt({ quest }).startsWith('⚔️ Quest'), 'no prefix without resume or note');
  assert.ok(guild.buildPhasePrompt({ quest, note: 'ดู log' }).startsWith('ข้อความจากผู้ใช้: ดู log ‖ ⚔️ Quest'));

  // Huge goal, preset and notes still fit, keep the goal first and the rules whole.
  const huge = guild.buildPhasePrompt({
    quest: { ...quest, phaseIndex: 1, loop: 2, goal: 'ก'.repeat(4000), presetPrompt: 'ข'.repeat(4000), name: 'น'.repeat(80) },
    failNote: 'f'.repeat(3000),
    resume: true,
    note: 'n'.repeat(2000),
  });
  oneLine(huge);
  assert.ok(huge.length <= guild.MAX_PROMPT_CHARS, `length ${huge.length}`);
  assert.ok(huge.endsWith('QUEST-VERDICT: BLOCKED — <สิ่งที่ต้องการ>'), 'the rules survive');
  assert.ok(huge.includes('ก'.repeat(300)) && huge.includes('ข'.repeat(100)), 'both goal and preset keep a share');
  assert.ok(huge.includes('…'), 'cut text is marked');

  const probe = guild.buildProbePrompt();
  oneLine(probe);
  assert.ok(probe.includes('QUEST-VERDICT: PASS') && probe.includes('FAIL'));
}

// ---------------------------------------------------------------------------------------------
// 4. QuestRunner with fakes
// ---------------------------------------------------------------------------------------------
class FakeStore extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.sessions = new Map();
  }

  addRoom(id, extra = {}) {
    const room = { id, room: id, cwd: isolatedHome, lifecycle: 'live', status: 'idle', tldr: '', ...extra };
    this.sessions.set(id, room);
    return room;
  }

  updateSession(id, patch) {
    const room = this.sessions.get(id);
    if (!room) return null;
    Object.assign(room, patch);
    this.emit('change', { type: 'session_updated', detail: { sessionId: id } });
    return room;
  }

  hook(id, hookEvent, extra = {}) {
    const room = this.sessions.get(id);
    if (room && hookEvent === 'Stop') room.status = 'done';
    if (room && hookEvent === 'SessionEnd') Object.assign(room, { lifecycle: 'history', status: 'closed' });
    this.emit('change', { type: 'hook_event', detail: { sessionId: id, hookEvent, ...extra } });
  }

  stop(id, lastAssistantMessage) {
    this.hook(id, 'Stop', lastAssistantMessage === undefined ? {} : { lastAssistantMessage });
  }
}

function fakeClock() {
  let t = Date.parse('2026-11-27T03:00:00.000Z');
  const timers = [];
  const pending = () => timers.filter((h) => !h.cancelled && !h.ran).sort((a, b) => a.at - b.at);
  return {
    // Called as methods of the runner, so none of these use `this`.
    now: () => t,
    schedule: (fn, ms) => {
      const h = { fn, ms, at: t + ms, cancelled: false, ran: false };
      timers.push(h);
      return h;
    },
    unschedule: (h) => {
      if (h) h.cancelled = true;
    },
    pending,
    async runNext() {
      const next = pending()[0];
      if (!next) return null;
      next.ran = true;
      t = Math.max(t, next.at);
      next.fn();
      await settle();
      return next;
    },
    advance(ms) {
      t += ms;
    },
  };
}

function fakeBridge() {
  return {
    calls: [],
    activeProcesses: new Map(),
    reply: { ok: true, delivered: true, message: 'ส่งแล้ว' },
    async dispatchCommand(sessionId, text, opts = {}) {
      this.calls.push({ sessionId, text, opts });
      return this.reply;
    },
    last() {
      return this.calls[this.calls.length - 1];
    },
  };
}

let roomCounter = 0;
function setup({ dataDir } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(isolatedHome, 'quests-'));
  const store = new FakeStore(dir);
  const bridge = fakeBridge();
  const clock = fakeClock();
  const usageGuard = {
    holding: false,
    isHolding() {
      return this.holding;
    },
  };
  const transcripts = new Map();
  const make = () =>
    new QuestRunner(store, bridge, {
      usageGuard,
      now: clock.now,
      schedule: clock.schedule,
      unschedule: clock.unschedule,
      readTranscriptText: (room) => transcripts.get(room && room.id) || null,
      saveDebounceMs: 5,
    });
  const runner = make();
  return { dataDir: dir, store, bridge, clock, usageGuard, transcripts, runner, make };
}

/** A quest in a room of its own; `launch` terminal/headless, or a room with a terminal (existing). */
async function startQuest(ctx, body, { existing = false, room: roomExtra = {} } = {}) {
  roomCounter += 1;
  const id = `room-${roomCounter}`;
  if (existing) {
    ctx.store.addRoom(id, { pid: 4000 + roomCounter, ...roomExtra });
    const quest = await ctx.runner.createQuest({ goal: 'หา bug ใน login', ...body, sessionId: id });
    return { id, quest };
  }
  const prepared = ctx.runner.prepare({ goal: 'หา bug ใน login', cwd: isolatedHome, ...body });
  ctx.store.addRoom(id, { cwd: prepared.cwd, ...roomExtra });
  const quest = await ctx.runner.start(prepared, id);
  return { id, quest };
}

const q = (ctx, id) => ctx.runner.get(id);

async function expectQuestError(promiseOrFn, status, label) {
  try {
    const r = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
    if (r && typeof r.then === 'function') await r;
  } catch (err) {
    assert.ok(err instanceof QuestError, `${label}: a QuestError (${err && err.message})`);
    assert.strictEqual(err.statusCode, status, `${label}: ${err.message}`);
    return err;
  }
  assert.fail(`${label}: expected ${status}`);
}

async function testTerminalLoopUntilFailed() {
  const ctx = setup();
  const { id, quest } = await startQuest(ctx, { heroClassId: 'qa_loop', optionValue: 2 });
  const room = ctx.store.sessions.get(id);
  assert.strictEqual(quest.state, 'launching');
  assert.strictEqual(quest.maxLoops, 2);
  assert.strictEqual(quest.launch, 'terminal');
  assert.ok(/^quest-[a-z0-9]+-[a-z0-9]{4}$/.test(quest.id), quest.id);
  assert.strictEqual(ctx.bridge.calls.length, 0, 'nothing is sent before the terminal is up');
  assert.deepStrictEqual(
    ctx.clock.pending().map((h) => h.ms),
    [90000],
    'a launch timeout is armed'
  );
  assert.strictEqual(room.quest.state, 'launching');
  assert.strictEqual(room.quest.scene, 'library');
  assert.strictEqual(room.quest.heroName, 'Ironclad Artificer');
  assert.strictEqual(room.quest.phaseCount, 3);
  assert.deepStrictEqual(Object.keys(room.quest).sort(), [
    'goal', 'heroClassId', 'heroName', 'id', 'log', 'loop', 'maxLoops', 'name', 'phase', 'phaseCount',
    'phaseIndex', 'scene', 'state', 'stateReason', 'updatedAt',
  ]);

  // SessionStart → 1.5 s → phase 1 over the terminal.
  ctx.store.hook(id, 'SessionStart');
  assert.deepStrictEqual(ctx.clock.pending().map((h) => h.ms), [1500], 'the launch timeout is replaced');
  await ctx.clock.runNext();
  assert.strictEqual(ctx.bridge.calls.length, 1);
  assert.deepStrictEqual(ctx.bridge.last().opts, { noQueue: true }, 'a terminal quest is typed into its terminal');
  assert.ok(ctx.bridge.last().text.includes('ขั้น 1/3 สืบหาต้นตอ'));
  assert.ok(!/[\r\n]/.test(ctx.bridge.last().text));
  assert.strictEqual(q(ctx, quest.id).state, 'running');
  assert.strictEqual(q(ctx, quest.id).awaitingTurn, true);

  // Stop (DONE) → the next phase after 800 ms; a second Stop changes nothing.
  ctx.store.stop(id, 'สาเหตุอยู่ที่ submit handler\nQUEST-VERDICT: DONE');
  assert.strictEqual(q(ctx, quest.id).phaseIndex, 1);
  assert.strictEqual(q(ctx, quest.id).awaitingTurn, false);
  assert.strictEqual(room.quest.scene, 'dungeon');
  assert.deepStrictEqual(ctx.clock.pending().map((h) => h.ms), [800]);
  ctx.store.stop(id);
  assert.strictEqual(q(ctx, quest.id).phaseIndex, 1, 'a second Stop is ignored');
  assert.strictEqual(ctx.clock.pending().length, 1);
  await ctx.clock.runNext();
  assert.strictEqual(ctx.bridge.calls.length, 2);
  assert.ok(ctx.bridge.last().text.includes('ขั้น 2/3 แก้โค้ด (ดันเจียน) · รอบ 1/2'));

  ctx.store.stop(id, 'แก้แล้ว\nQUEST-VERDICT: DONE');
  await ctx.clock.runNext();
  assert.ok(ctx.bridge.last().text.includes('ขั้น 3/3 ทดสอบ'));
  assert.strictEqual(room.quest.scene, 'camp');

  // FAIL with loops left → back to fix, carrying the note.
  ctx.store.stop(id, 'รัน npm test\nQUEST-VERDICT: FAIL — login.test.js ยังล้ม 1 เคส');
  let cur = q(ctx, quest.id);
  assert.strictEqual(cur.loop, 2);
  assert.strictEqual(cur.phaseIndex, 1);
  assert.strictEqual(cur.state, 'running');
  assert.deepStrictEqual(cur.lastVerdict, { kind: 'FAIL', note: 'login.test.js ยังล้ม 1 เคส' });
  assert.ok(cur.log.some((e) => e.level === 'warn' && e.text.includes('วนกลับไปแก้')));
  await ctx.clock.runNext();
  assert.ok(ctx.bridge.last().text.includes('ผลทดสอบรอบก่อน: login.test.js ยังล้ม 1 เคส'));
  assert.ok(ctx.bridge.last().text.includes('รอบ 2/2'));

  ctx.store.stop(id, 'QUEST-VERDICT: DONE');
  await ctx.clock.runNext();
  ctx.store.stop(id, 'QUEST-VERDICT: FAIL — ยังล้มเหมือนเดิม');
  cur = q(ctx, quest.id);
  assert.strictEqual(cur.state, 'failed', 'no loops left');
  assert.ok(cur.stateReason.includes('ครบ 2 รอบ') && cur.stateReason.includes('ยังล้มเหมือนเดิม'), cur.stateReason);
  assert.ok(cur.finishedAt);
  assert.strictEqual(ctx.clock.pending().length, 0);
  assert.strictEqual(room.quest.state, 'failed');
  assert.strictEqual(room.quest.scene, 'sanctuary');
  assert.strictEqual(room.quest.phase, null);
  assert.ok(room.quest.log.length <= 8);
  assert.strictEqual(ctx.bridge.calls.length, 5);
  ctx.runner.stop();
}

async function testExistingRoomPassAndTranscriptFallback() {
  const ctx = setup();
  const { id, quest } = await startQuest(ctx, { heroClassId: 'full_slayer' }, { existing: true });
  assert.strictEqual(quest.launch, 'existing');
  assert.strictEqual(quest.state, 'running');
  assert.strictEqual(quest.maxLoops, 1);
  assert.strictEqual(ctx.bridge.calls.length, 1, 'an existing room gets phase 1 at once');
  assert.deepStrictEqual(ctx.bridge.last().opts, { noQueue: true });

  // No message on the Stop: the transcript's last answer is read instead.
  ctx.transcripts.set(id, 'วางแผนแล้ว\nQUEST-VERDICT: DONE');
  ctx.store.stop(id);
  assert.strictEqual(q(ctx, quest.id).phaseIndex, 1);
  await ctx.clock.runNext();
  ctx.transcripts.delete(id);
  // Neither: the TL;DR.
  ctx.store.sessions.get(id).tldr = 'แก้ไฟล์ auth.js · QUEST-VERDICT: DONE';
  ctx.store.stop(id);
  assert.strictEqual(q(ctx, quest.id).phaseIndex, 2);
  await ctx.clock.runNext();
  ctx.store.stop(id, 'npm test ผ่านหมด\n**QUEST-VERDICT: PASS**');
  const done = q(ctx, quest.id);
  assert.strictEqual(done.state, 'done');
  assert.strictEqual(done.stateReason, null);
  assert.ok(done.log.some((e) => e.level === 'success' && e.text.includes('ทดสอบผ่าน')));
  assert.strictEqual(ctx.store.sessions.get(id).quest.scene, 'sanctuary');
  ctx.runner.stop();
}

async function testBlockedPauseAndResume() {
  const ctx = setup();
  const { id, quest } = await startQuest(ctx, { heroClassId: 'bug_hunter' }, { existing: true });
  ctx.store.stop(id, 'ต้องดู log จริงก่อน\nQUEST-VERDICT: BLOCKED — ต้องการ URL ของ staging');
  let cur = q(ctx, quest.id);
  assert.strictEqual(cur.state, 'paused');
  assert.ok(cur.stateReason.includes('ต้องการ URL ของ staging'), cur.stateReason);
  assert.strictEqual(ctx.clock.pending().length, 0, 'nothing is sent while paused');

  await expectQuestError(() => ctx.runner.action(quest.id, 'resume', 'x'.repeat(2001)), 400, 'note too long');
  const resumed = await ctx.runner.action(quest.id, 'resume', '  ใช้ https://staging.example  ');
  assert.strictEqual(resumed.state, 'running');
  assert.strictEqual(ctx.bridge.calls.length, 2);
  assert.ok(
    ctx.bridge.last().text.startsWith('↻ ทำต่อจากที่ค้างไว้ — ข้อความจากผู้ใช้: ใช้ https://staging.example ‖ ⚔️ Quest'),
    ctx.bridge.last().text.slice(0, 120)
  );
  ctx.store.stop(id, 'เจอแล้ว\nQUEST-VERDICT: DONE');
  assert.strictEqual(q(ctx, quest.id).state, 'done', 'a one-phase quest is done after its phase');
  await expectQuestError(() => ctx.runner.action(quest.id, 'resume'), 409, 'resume a finished quest');
  ctx.runner.stop();
}

async function testVerifyWithoutVerdictProbesOnce() {
  const ctx = setup();
  const { id, quest } = await startQuest(ctx, { heroClassId: 'full_slayer' }, { existing: true });
  ctx.store.stop(id, 'QUEST-VERDICT: DONE');
  await ctx.clock.runNext();
  ctx.store.stop(id, 'QUEST-VERDICT: DONE');
  await ctx.clock.runNext();
  assert.strictEqual(q(ctx, quest.id).phaseIndex, 2);

  ctx.store.stop(id, 'เทสผ่านหมดแล้วครับ'); // no verdict line
  assert.strictEqual(q(ctx, quest.id).probeSent, true);
  await ctx.clock.runNext();
  assert.strictEqual(ctx.bridge.last().text, guild.buildProbePrompt(), 'one short probe');
  assert.strictEqual(q(ctx, quest.id).awaitingTurn, true);

  ctx.store.stop(id, 'ผ่านครับ');
  const cur = q(ctx, quest.id);
  assert.strictEqual(cur.state, 'paused');
  assert.ok(cur.stateReason.includes('ไม่ได้รับผลทดสอบ'));
  assert.strictEqual(ctx.bridge.calls.length, 4, 'only one probe');

  // A probe answered with a verdict carries on.
  const other = await startQuest(ctx, { heroClassId: 'full_slayer' }, { existing: true });
  ctx.store.stop(other.id, 'QUEST-VERDICT: DONE');
  await ctx.clock.runNext();
  ctx.store.stop(other.id, 'QUEST-VERDICT: DONE');
  await ctx.clock.runNext();
  ctx.store.stop(other.id, 'เสร็จ');
  await ctx.clock.runNext();
  ctx.store.stop(other.id, 'QUEST-VERDICT: PASS');
  assert.strictEqual(q(ctx, other.quest.id).state, 'done');
  ctx.runner.stop();
}

async function testUsageHold() {
  const ctx = setup();
  const { id, quest } = await startQuest(ctx, { heroClassId: 'full_slayer' }, { existing: true });
  ctx.store.stop(id, 'QUEST-VERDICT: DONE');
  ctx.usageGuard.holding = true;
  await ctx.clock.runNext();
  let cur = q(ctx, quest.id);
  assert.strictEqual(cur.state, 'paused');
  assert.strictEqual(cur.stateReason, USAGE_REASON);
  assert.strictEqual(ctx.bridge.calls.length, 1, 'nothing is sent during a hold');
  await expectQuestError(() => ctx.runner.action(quest.id, 'resume'), 423, 'resume during a hold');
  await expectQuestError(
    () => ctx.runner.prepare({ heroClassId: 'quick_fix', goal: 'x', cwd: isolatedHome }),
    423,
    'new quest during a hold'
  );

  // The hold lifts: the quest carries on by itself.
  ctx.usageGuard.holding = false;
  ctx.store.emit('change', { type: 'quota_resumed', detail: {} });
  await settle();
  cur = q(ctx, quest.id);
  assert.strictEqual(cur.state, 'running');
  assert.strictEqual(ctx.bridge.calls.length, 2);
  assert.ok(ctx.bridge.last().text.includes('ขั้น 2/3 แก้โค้ด'));

  // Held while the guard's own resume prompt keeps the room busy: phase 2 starts after that turn.
  ctx.store.stop(id, 'QUEST-VERDICT: DONE');
  ctx.usageGuard.holding = true;
  await ctx.clock.runNext();
  assert.strictEqual(q(ctx, quest.id).state, 'paused');
  ctx.usageGuard.holding = false;
  ctx.store.sessions.get(id).status = 'working';
  ctx.store.emit('change', { type: 'quota_resumed', detail: {} });
  await settle();
  cur = q(ctx, quest.id);
  assert.strictEqual(cur.state, 'running');
  assert.strictEqual(cur.awaitingTurn, false, 'the busy turn is not this phase');
  assert.strictEqual(ctx.bridge.calls.length, 2);
  ctx.store.stop(id, 'ทำต่อจาก checkpoint แล้ว');
  assert.strictEqual(q(ctx, quest.id).phaseIndex, 2, 'that Stop does not end the phase');
  await ctx.clock.runNext();
  assert.strictEqual(ctx.bridge.calls.length, 3);
  assert.ok(ctx.bridge.last().text.includes('ขั้น 3/3 ทดสอบ'));

  // "ทำต่อ" with a note while the room is busy: the note goes out with the phase after that turn.
  const other = await startQuest(ctx, { heroClassId: 'full_slayer' }, { existing: true });
  ctx.store.stop(other.id, 'QUEST-VERDICT: DONE');
  ctx.usageGuard.holding = true;
  await ctx.clock.runNext();
  ctx.usageGuard.holding = false;
  ctx.store.sessions.get(other.id).status = 'working';
  cur = await ctx.runner.action(other.quest.id, 'resume', 'เน้นไฟล์ auth.js');
  assert.strictEqual(cur.state, 'running');
  assert.strictEqual(cur.waitForIdle, true);
  const sentBefore = ctx.bridge.calls.length;
  ctx.store.stop(other.id, 'งานอื่นจบ');
  await ctx.clock.runNext();
  assert.strictEqual(ctx.bridge.calls.length, sentBefore + 1);
  assert.ok(
    ctx.bridge.last().text.startsWith('↻ ทำต่อจากที่ค้างไว้ — ข้อความจากผู้ใช้: เน้นไฟล์ auth.js ‖ ⚔️ Quest'),
    ctx.bridge.last().text.slice(0, 120)
  );
  assert.ok(ctx.bridge.last().text.includes('ขั้น 2/3'));
  ctx.runner.stop();
}

async function testStopAndActionErrors() {
  const ctx = setup();
  const { id, quest } = await startQuest(ctx, { heroClassId: 'full_slayer' }, { existing: true });
  const stopped = await ctx.runner.action(quest.id, 'stop');
  assert.strictEqual(stopped.state, 'stopped');
  assert.ok(stopped.stateReason.includes('หยุดโดยผู้ใช้'));
  ctx.store.stop(id, 'QUEST-VERDICT: DONE');
  assert.strictEqual(q(ctx, quest.id).phaseIndex, 0, 'a stopped quest ignores the turn ending');
  assert.strictEqual(ctx.clock.pending().length, 0);
  assert.strictEqual(ctx.bridge.calls.length, 1, 'no keys or prompts after stop');
  await expectQuestError(() => ctx.runner.action(quest.id, 'stop'), 409, 'stop twice');
  await expectQuestError(() => ctx.runner.action('quest-nope-0000', 'stop'), 404, 'unknown quest');
  await expectQuestError(() => ctx.runner.action(quest.id, 'explode'), 400, 'unknown action');
  await expectQuestError(() => ctx.runner.action('', 'stop'), 400, 'no quest id');

  // Stop during the gap between phases cancels the pending dispatch.
  const other = await startQuest(ctx, { heroClassId: 'full_slayer' }, { existing: true });
  ctx.store.stop(other.id, 'QUEST-VERDICT: DONE');
  assert.strictEqual(ctx.clock.pending().length, 1);
  await ctx.runner.action(other.quest.id, 'stop');
  assert.strictEqual(ctx.clock.pending().length, 0);

  // Resume on a running quest does not apply.
  const third = await startQuest(ctx, { heroClassId: 'quick_fix' }, { existing: true });
  await expectQuestError(() => ctx.runner.action(third.quest.id, 'resume'), 409, 'resume while running');
  ctx.runner.stop();
}

async function testSessionEndStallsThenResume() {
  const ctx = setup();
  const { id, quest } = await startQuest(ctx, { heroClassId: 'full_slayer' }, { existing: true });
  ctx.store.hook(id, 'SessionEnd');
  let cur = q(ctx, quest.id);
  assert.strictEqual(cur.state, 'stalled');
  assert.ok(cur.stateReason.includes('ปิด terminal ไปแล้ว'));
  assert.strictEqual(cur.awaitingTurn, false);

  // Restored in a terminal and idle: the phase is sent again, marked as a resume.
  Object.assign(ctx.store.sessions.get(id), { lifecycle: 'live', status: 'idle' });
  await ctx.runner.action(quest.id, 'resume');
  assert.strictEqual(ctx.bridge.calls.length, 2);
  assert.ok(ctx.bridge.last().text.startsWith('↻ ทำต่อจากที่ค้างไว้ ‖ ⚔️ Quest'));

  // Stalled while its turn still runs: resume just waits for that turn's Stop.
  ctx.store.hook(id, 'SessionEnd');
  Object.assign(ctx.store.sessions.get(id), { lifecycle: 'live', status: 'working' });
  cur = await ctx.runner.action(quest.id, 'resume');
  assert.strictEqual(cur.state, 'running');
  assert.strictEqual(cur.awaitingTurn, true);
  assert.strictEqual(ctx.bridge.calls.length, 2, 'nothing re-sent');
  ctx.store.stop(id, 'QUEST-VERDICT: DONE');
  assert.strictEqual(q(ctx, quest.id).phaseIndex, 1);
  ctx.runner.stop();
}

async function testLaunchTimeoutAndUndelivered() {
  const ctx = setup();
  const { id, quest } = await startQuest(ctx, { heroClassId: 'quick_fix' });
  await ctx.clock.runNext(); // 90 s, no SessionStart
  let cur = q(ctx, quest.id);
  assert.strictEqual(cur.state, 'stalled');
  assert.strictEqual(cur.stateReason, ctx.runner.launchTimeoutReason);
  assert.ok(cur.stateReason.includes('90 วินาที'));

  // Claude started by hand in that tab later: the quest picks up from there.
  ctx.store.hook(id, 'SessionStart');
  assert.strictEqual(q(ctx, quest.id).state, 'launching');
  await ctx.clock.runNext();
  assert.strictEqual(q(ctx, quest.id).state, 'running');
  assert.strictEqual(ctx.bridge.calls.length, 1);

  // The bridge could not deliver: stalled with its message, and the phase counts as unsent.
  ctx.bridge.reply = { ok: true, delivered: false, message: 'ยังส่งเข้า Terminal ไม่ได้ — เก็บไว้ในคิว' };
  const other = await startQuest(ctx, { heroClassId: 'quick_fix' }, { existing: true });
  cur = q(ctx, other.quest.id);
  assert.strictEqual(cur.state, 'stalled');
  assert.ok(cur.stateReason.includes('ยังส่งเข้า Terminal ไม่ได้'), cur.stateReason);
  assert.strictEqual(cur.phaseSent, false);
  assert.strictEqual(cur.awaitingTurn, false);

  // A thrown bridge error is a stall too.
  ctx.bridge.dispatchCommand = async () => {
    throw new Error('Command text cannot be empty');
  };
  ctx.store.sessions.get(other.id).status = 'idle';
  cur = await ctx.runner.action(other.quest.id, 'resume');
  assert.strictEqual(cur.state, 'stalled');
  assert.ok(cur.stateReason.includes('Command text cannot be empty'));

  // launchFailed from the server (wt.exe missing) on a launching quest.
  const third = await startQuest(ctx, { heroClassId: 'quick_fix' });
  ctx.runner.launchFailed(third.quest.id, 'ไม่พบ wt.exe');
  assert.strictEqual(q(ctx, third.quest.id).state, 'stalled');
  assert.ok(q(ctx, third.quest.id).stateReason.includes('ไม่พบ wt.exe'));
  ctx.runner.stop();
}

async function testHeadless() {
  const ctx = setup();
  const { id, quest } = await startQuest(ctx, { heroClassId: 'full_slayer', launch: 'headless' });
  assert.strictEqual(quest.launch, 'headless');
  assert.strictEqual(quest.headless, true);
  assert.strictEqual(quest.state, 'running');
  assert.deepStrictEqual(ctx.bridge.last().opts, { runHeadless: true, permissionMode: 'acceptEdits' });

  // The run's Stop (from the result) ends the phase; its process exit sends another Stop.
  ctx.bridge.activeProcesses.set(id, {});
  ctx.store.stop(id, 'วางแผนแล้ว\nQUEST-VERDICT: DONE');
  // The real store keeps the room live on a background run's SessionEnd; the quest ignores it too.
  ctx.store.emit('change', { type: 'hook_event', detail: { sessionId: id, hookEvent: 'SessionEnd' } });
  const room = ctx.store.sessions.get(id);
  assert.strictEqual(q(ctx, quest.id).state, 'running', "a background run's SessionEnd is not a closed terminal");
  assert.strictEqual(room.status, 'done');
  await ctx.clock.runNext(); // 800 ms: the previous process is still there
  assert.strictEqual(ctx.bridge.calls.length, 1, 'waits for the previous process to exit');
  assert.deepStrictEqual(ctx.clock.pending().map((h) => h.ms), [500]);
  ctx.bridge.activeProcesses.delete(id);
  ctx.store.stop(id); // the exit's own Stop
  await ctx.clock.runNext();
  assert.strictEqual(ctx.bridge.calls.length, 2);
  assert.ok(ctx.bridge.last().text.includes('ขั้น 2/3 แก้โค้ด'));
  assert.deepStrictEqual(ctx.bridge.last().opts, { runHeadless: true, permissionMode: 'acceptEdits' });

  // A run that crashed (exit code, no result) stalls instead of moving on.
  ctx.store.stop(id, headlessExitSummary(1));
  const cur = q(ctx, quest.id);
  assert.strictEqual(cur.state, 'stalled');
  assert.strictEqual(cur.phaseIndex, 1);
  assert.ok(cur.stateReason.includes('exit code 1'));

  // An existing room without a terminal but with a Claude session runs in the background too.
  const bg = await startQuest(ctx, { heroClassId: 'quick_fix' }, { existing: true, room: { pid: null, claudeSessionId: UUID_A } });
  assert.strictEqual(bg.quest.headless, true);
  assert.deepStrictEqual(ctx.bridge.last().opts, { runHeadless: true, permissionMode: 'acceptEdits' });
  ctx.runner.stop();
}

async function testValidationAndExistingRules() {
  const ctx = setup();
  const r = ctx.runner;
  const base = { heroClassId: 'quick_fix', goal: 'แก้ typo', cwd: isolatedHome };
  const bad = [
    [{ ...base, heroClassId: 'wizard' }, 'unknown class'],
    [{ ...base, goal: '   ' }, 'empty goal'],
    [{ ...base, goal: 'x'.repeat(4001) }, 'goal too long'],
    [{ ...base, goal: 42 }, 'goal not text'],
    [{ ...base, name: 'n'.repeat(81) }, 'name too long'],
    [{ ...base, presetPrompt: 'p'.repeat(4001) }, 'preset too long'],
    [{ ...base, heroClassId: 'researcher', optionValue: 'abyss' }, 'unknown depth'],
    [{ ...base, heroClassId: 'qa_loop', optionValue: 4 }, 'maxLoops not offered'],
    [{ ...base, launch: 'teleport' }, 'unknown launch'],
    [{ ...base, cwd: undefined }, 'no folder'],
    [{ ...base, cwd: path.join(isolatedHome, 'missing-dir') }, 'missing folder'],
    [null, 'no body'],
  ];
  for (const [body, label] of bad) await expectQuestError(() => r.prepare(body), 400, label);

  const ok = r.prepare({ ...base, heroClassId: 'qa_loop', optionValue: '5', goal: 'หน้า checkout แสดงราคาผิดเมื่อใช้คูปองซ้อนกันสองใบ และยอดรวมติดลบ' });
  assert.deepStrictEqual(ok.option, { key: 'maxLoops', value: 5 });
  assert.strictEqual(ok.presetPrompt, guild.presetFor('qa_loop', 5), 'the default preset follows the option');
  assert.ok(ok.name.length <= 41 && ok.name.endsWith('…'), `default name from the goal: ${ok.name}`);
  assert.strictEqual(ok.launch, 'terminal');
  assert.strictEqual(r.prepare({ ...base, presetPrompt: '  [ROLE: mine]  ', name: ' ชื่อเอง ' }).presetPrompt, '[ROLE: mine]');
  assert.strictEqual(r.prepare({ ...base, name: ' ชื่อเอง ' }).name, 'ชื่อเอง');

  await expectQuestError(() => r.prepare({ ...base, sessionId: 'room-missing' }), 404, 'unknown room');
  ctx.store.addRoom('busy', { status: 'working' });
  await expectQuestError(() => r.prepare({ ...base, sessionId: 'busy' }), 409, 'working room');
  ctx.store.addRoom('asking', { status: 'needs_input' });
  await expectQuestError(() => r.prepare({ ...base, sessionId: 'asking' }), 409, 'room waiting for an answer');
  ctx.store.addRoom('closed', { lifecycle: 'history', status: 'closed' });
  await expectQuestError(() => r.prepare({ ...base, sessionId: 'closed' }), 409, 'closed room');
  const { id } = await startQuest(ctx, { heroClassId: 'quick_fix' });
  await expectQuestError(() => r.prepare({ ...base, sessionId: id }), 409, 'a launching quest in the room');
  await expectQuestError(() => r.start(r.prepare(base), id), 409, 'start re-checks the room');
  ctx.runner.stop();
}

async function testRoomArchivedRemovedAndNewestMirror() {
  const ctx = setup();
  const a = await startQuest(ctx, { heroClassId: 'full_slayer' }, { existing: true });
  ctx.store.emit('change', { type: 'session_archived', detail: { sessionId: a.id } });
  assert.strictEqual(q(ctx, a.quest.id).state, 'stopped');
  assert.ok(q(ctx, a.quest.id).stateReason.includes('เก็บเข้าประวัติ'));
  const b = await startQuest(ctx, { heroClassId: 'full_slayer' }, { existing: true });
  ctx.store.sessions.delete(b.id);
  ctx.store.emit('change', { type: 'session_removed', detail: { sessionId: b.id } });
  assert.strictEqual(q(ctx, b.quest.id).state, 'stopped');

  // A paused quest gives way to a new one in the same room; the room shows the new one.
  const c = await startQuest(ctx, { heroClassId: 'bug_hunter' }, { existing: true });
  ctx.store.stop(c.id, 'QUEST-VERDICT: BLOCKED — รอ');
  ctx.store.sessions.get(c.id).status = 'idle';
  const next = await ctx.runner.createQuest({ heroClassId: 'quick_fix', goal: 'อีกงาน', sessionId: c.id });
  assert.strictEqual(q(ctx, c.quest.id).state, 'stopped');
  assert.ok(q(ctx, c.quest.id).stateReason.includes('เควสต์ใหม่'));
  assert.strictEqual(ctx.store.sessions.get(c.id).quest.id, next.id);

  const listed = ctx.runner.list();
  assert.strictEqual(listed[0].id, next.id, 'newest first');
  assert.strictEqual(listed.length, 4);
  ctx.runner.stop();
}

async function testPersistence() {
  const ctx = setup();
  const done = await startQuest(ctx, { heroClassId: 'quick_fix' }, { existing: true });
  ctx.store.stop(done.id, 'QUEST-VERDICT: DONE');
  const waiting = await startQuest(ctx, { heroClassId: 'qa_loop', optionValue: 3 }, { existing: true });
  const between = await startQuest(ctx, { heroClassId: 'full_slayer' }, { existing: true });
  ctx.store.stop(between.id, 'QUEST-VERDICT: DONE'); // phase 2 pending
  const gone = await startQuest(ctx, { heroClassId: 'bug_hunter' });
  const launching = await startQuest(ctx, { heroClassId: 'quick_fix' });
  ctx.runner.stop(); // flushes
  const file = path.join(ctx.dataDir, QUEST_FILE);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.quests.length, 5);

  ctx.store.sessions.delete(gone.id);
  for (const room of ctx.store.sessions.values()) delete room.quest;
  const before = ctx.bridge.calls.length;
  const runner = ctx.make();
  const byId = (id) => runner.get(id);
  assert.deepStrictEqual(
    runner.list().map((x) => x.id).sort(),
    [done, waiting, between, gone, launching].map((x) => x.quest.id).sort()
  );
  assert.strictEqual(byId(done.quest.id).state, 'done');
  assert.strictEqual(byId(gone.quest.id).state, 'stopped', 'a quest whose room is gone stops');
  assert.ok(byId(gone.quest.id).stateReason.includes('ไม่อยู่แล้ว'));
  const w = byId(waiting.quest.id);
  assert.strictEqual(w.state, 'running');
  assert.strictEqual(w.awaitingTurn, true);
  assert.deepStrictEqual(w.option, { key: 'maxLoops', value: 3 });
  assert.strictEqual(w.maxLoops, 3);
  assert.strictEqual(w.presetPrompt, waiting.quest.presetPrompt);
  assert.deepStrictEqual(w.plan, waiting.quest.plan);
  assert.strictEqual(byId(launching.quest.id).state, 'launching');
  assert.strictEqual(ctx.store.sessions.get(waiting.id).quest.id, waiting.quest.id, 'mirrors are re-applied');
  assert.strictEqual(ctx.store.sessions.get(done.id).quest.state, 'done');

  // The phase that was about to be sent goes out; the waiting turn's Stop still counts.
  const timers = ctx.clock.pending().map((h) => h.ms).sort((a, b) => a - b);
  assert.deepStrictEqual(timers, [800, 90000]);
  await ctx.clock.runNext();
  assert.strictEqual(ctx.bridge.calls.length, before + 1);
  assert.ok(ctx.bridge.last().text.includes('ขั้น 2/3'));
  ctx.store.stop(waiting.id, 'QUEST-VERDICT: DONE');
  assert.strictEqual(runner.get(waiting.quest.id).phaseIndex, 1);
  runner.stop();

  // A broken file is ignored, not fatal.
  fs.writeFileSync(file, '{ not json');
  const fresh = new QuestRunner(new FakeStore(ctx.dataDir), fakeBridge(), { saveDebounceMs: 5 });
  assert.deepStrictEqual(fresh.list(), []);
  fresh.stop();
}

// ---------------------------------------------------------------------------------------------
// 5. Bridge and store pieces the runner relies on
// ---------------------------------------------------------------------------------------------
async function testBridgeAndStore() {
  // Headless arguments: the permission mode is a whitelisted constant.
  assert.deepStrictEqual(headlessClaudeArgs({ id: 'session-1' }), ['-p', '--output-format', 'stream-json', '--verbose']);
  assert.deepStrictEqual(headlessClaudeArgs({ id: 'session-1', claudeSessionId: UUID_A }, { permissionMode: 'acceptEdits' }), [
    '--resume', UUID_A, '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
  ]);
  for (const mode of ['bypassPermissions', 'acceptEdits & calc', 'plan', '']) {
    assert.ok(!headlessClaudeArgs({ id: 's' }, { permissionMode: mode }).includes('--permission-mode'), mode);
  }

  const dataDir = fs.mkdtempSync(path.join(isolatedHome, 'store-'));
  const store = new StateStore({ dataDir, saveDebounceMs: 0 });
  const bridge = new CommandBridge(store, null);
  const cwd = roomDir('bridge');
  const room = store.getOrCreateSession('session-bridge', { cwd });
  assert.strictEqual(room.claudeSessionId, null);
  const details = [];
  store.on('change', (e) => e.type === 'hook_event' && details.push(e.detail));

  // stream-json: the first session id is remembered so the next run resumes it.
  bridge._handleClaudeStreamJson(room.id, { type: 'system', subtype: 'init', session_id: UUID_B });
  assert.strictEqual(room.claudeSessionId, UUID_B);
  bridge._handleClaudeStreamJson(room.id, { type: 'system', subtype: 'init', session_id: UUID_C });
  assert.strictEqual(room.claudeSessionId, UUID_B, 'an existing session id is kept');
  bridge._handleClaudeStreamJson(room.id, { type: 'system', session_id: 'not-a-uuid' });
  assert.strictEqual(room.claudeSessionId, UUID_B);
  const other = store.getOrCreateSession('session-other', { cwd: roomDir('bridge-other') });
  bridge._handleClaudeStreamJson(other.id, { type: 'system', session_id: 'x; rm -rf' });
  assert.strictEqual(other.claudeSessionId, null, 'only a UUID is taken');
  assert.deepStrictEqual(headlessClaudeArgs(room).slice(0, 2), ['--resume', UUID_B]);

  // result: the full answer travels with the Stop; the TL;DR stays short.
  const longAnswer = `${'รายละเอียด '.repeat(60)}\nQUEST-VERDICT: DONE`;
  bridge._handleClaudeStreamJson(room.id, { type: 'result', result: longAnswer, session_id: UUID_B });
  const stop = details[details.length - 1];
  assert.strictEqual(stop.hookEvent, 'Stop');
  assert.strictEqual(stop.sessionId, room.id);
  assert.strictEqual(stop.lastAssistantMessage, longAnswer);
  assert.ok(room.tldr.length <= 220 && !room.tldr.includes('QUEST-VERDICT'), 'TL;DR keeps its 220-char summary');

  // processHookEvent: last_assistant_message, else summary, else nothing.
  store.processHookEvent({ session_id: room.id, hook_event_name: 'Stop', last_assistant_message: 'ทั้งหมด\nQUEST-VERDICT: PASS', summary: 'สั้น' });
  assert.strictEqual(details[details.length - 1].lastAssistantMessage, 'ทั้งหมด\nQUEST-VERDICT: PASS');
  store.processHookEvent({ session_id: room.id, hook_event_name: 'Stop', summary: 'สรุปสั้น' });
  assert.strictEqual(details[details.length - 1].lastAssistantMessage, 'สรุปสั้น');
  store.processHookEvent({ session_id: room.id, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} });
  assert.ok(!('lastAssistantMessage' in details[details.length - 1]));

  // dispatchCommand passes the permission mode to the background run only.
  const spawned = [];
  bridge._spawnClaudeHeadless = (session, text, opts) => spawned.push({ id: session.id, text, opts });
  await bridge.dispatchCommand(room.id, 'ทำขั้นถัดไป', { runHeadless: true, permissionMode: 'acceptEdits' });
  await bridge.dispatchCommand(room.id, 'อีกครั้ง', { runHeadless: true });
  assert.deepStrictEqual(spawned.map((s) => s.opts.permissionMode), ['acceptEdits', undefined]);
  assert.strictEqual(headlessExitSummary(2), 'Process จบการทำงานด้วยรหัส (exit code 2)');
  store.flush();
}

// ---------------------------------------------------------------------------------------------
// 6. HTTP routes
// ---------------------------------------------------------------------------------------------
function request(port, { method = 'GET', urlPath, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const auth = { 'X-AMC-Token': TOKEN };
const post = (port, urlPath, body) =>
  request(port, { method: 'POST', urlPath, headers: { ...auth, 'Content-Type': 'application/json' }, body });

async function testHttp() {
  const publicDir = path.join(isolatedHome, 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><html><head><title>MC</title></head><body></body></html>');
  fs.writeFileSync(path.join(publicDir, 'guild.html'), '<!doctype html><html><head><title>Guild</title></head><body></body></html>');
  fs.writeFileSync(path.join(publicDir, 'hero.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]));
  fs.writeFileSync(path.join(publicDir, 'sky.webp'), Buffer.from('RIFF0000WEBP'));

  const dataDir = path.join(isolatedHome, 'http-data');
  const { server, store, bridge, questRunner } = createMissionControlServer({
    dataDir,
    token: TOKEN,
    disableScanner: true,
    offlineFile: path.join(dataDir, 'offline-events.jsonl'),
    publicDir,
    questRunnerOptions: { sessionStartDelayMs: 5, phaseGapMs: 5 },
  });
  assert.ok(questRunner instanceof QuestRunner, 'the runner is exposed');
  // Never a real claude / wt.exe: the bridge's outward calls are recorded instead.
  const sent = [];
  const opened = [];
  let openReply = { ok: true, launcher: 'windows-terminal', message: 'เปิดแท็บแล้ว' };
  bridge.dispatchCommand = async (sessionId, text, opts = {}) => {
    sent.push({ sessionId, text, opts });
    return { ok: true, delivered: true, message: 'ส่งแล้ว' };
  };
  bridge.openTerminalTab = async (sessionId, opts) => {
    opened.push({ sessionId, opts });
    return openReply;
  };
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    // The game page, with the token meta like index.html.
    for (const urlPath of ['/guild', '/guild.html']) {
      const res = await request(port, { urlPath });
      assert.strictEqual(res.status, 200, urlPath);
      assert.ok(res.headers['content-type'].startsWith('text/html'));
      assert.strictEqual(res.headers['cache-control'], 'no-store');
      assert.ok(res.raw.includes(`<meta name="amc-token" content="${TOKEN}" />`), urlPath);
      assert.ok(res.raw.includes('<title>Guild</title>'));
    }
    const index = await request(port, { urlPath: '/' });
    assert.ok(index.raw.includes('amc-token') && index.raw.includes('<title>MC</title>'), 'index.html as before');
    let res = await request(port, { urlPath: '/hero.jpg' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-type'], 'image/jpeg');
    res = await request(port, { urlPath: '/sky.webp' });
    assert.strictEqual(res.headers['content-type'], 'image/webp');

    // Classes.
    res = await request(port, { urlPath: '/api/guild/classes' });
    assert.strictEqual(res.status, 401, 'token required');
    res = await request(port, { urlPath: '/api/guild/classes', headers: auth });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.ok, true);
    assert.deepStrictEqual(res.json.classes, JSON.parse(JSON.stringify(guild.classesForClient())));

    // Create: validation.
    const cwd = roomDir('http-quest');
    res = await post(port, '/api/guild/quests', { heroClassId: 'wizard', goal: 'x', cwd });
    assert.strictEqual(res.status, 400);
    res = await post(port, '/api/guild/quests', { heroClassId: 'quick_fix', goal: '', cwd });
    assert.strictEqual(res.status, 400);
    res = await post(port, '/api/guild/quests', { heroClassId: 'quick_fix', goal: 'x', cwd: path.join(cwd, 'nope') });
    assert.strictEqual(res.status, 400);
    assert.ok(res.json.error.includes('ไม่พบโฟลเดอร์'));
    res = await post(port, '/api/guild/quests', { heroClassId: 'quick_fix', goal: 'x', sessionId: 'room-unknown' });
    assert.strictEqual(res.status, 404);
    const busy = store.getOrCreateSession('room-busy', { cwd: roomDir('busy'), status: 'working' });
    res = await post(port, '/api/guild/quests', { heroClassId: 'quick_fix', goal: 'x', sessionId: busy.id });
    assert.strictEqual(res.status, 409);
    res = await request(port, {
      method: 'POST',
      urlPath: '/api/guild/quests',
      headers: { ...auth, 'Content-Type': 'text/plain' },
      body: '{}',
    });
    assert.strictEqual(res.status, 415, 'JSON only');
    assert.strictEqual(store.sessions.size, 1, 'no room is made for a refused quest');

    // Create: a new hero in Windows Terminal.
    res = await post(port, '/api/guild/quests', { heroClassId: 'qa_loop', goal: 'ทำให้ login ผ่านเทส', cwd, optionValue: 2, name: 'Login' });
    assert.strictEqual(res.status, 200, res.raw);
    const terminalQuest = res.json.quest;
    const terminalRoom = res.json.session;
    assert.strictEqual(terminalQuest.state, 'launching');
    assert.strictEqual(terminalQuest.maxLoops, 2);
    assert.strictEqual(terminalQuest.sessionId, terminalRoom.id);
    assert.strictEqual(terminalRoom.cwd, cwd);
    assert.strictEqual(terminalRoom.quest.id, terminalQuest.id);
    assert.strictEqual(terminalRoom.quest.scene, 'library');
    assert.deepStrictEqual(opened, [{ sessionId: terminalRoom.id, opts: { cwd, room: 'Login', autoRunClaude: true } }]);
    assert.strictEqual(sent.length, 0);
    res = await post(port, '/api/guild/quests', { heroClassId: 'quick_fix', goal: 'อีกงาน', sessionId: terminalRoom.id });
    assert.strictEqual(res.status, 409, 'one running quest per room');

    // Its terminal reports in through the hooks: SessionStart → phase 1; Stop → phase 2.
    res = await post(port, '/api/hook', { session_id: UUID_A, cwd, hook_event_name: 'SessionStart' });
    assert.strictEqual(res.json.sessionId, terminalRoom.id, 'the hook found the quest room');
    await wait(40);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].sessionId, terminalRoom.id);
    assert.ok(sent[0].text.includes('⚔️ Quest "Login" · ขั้น 1/3'));
    res = await post(port, '/api/hook', {
      session_id: UUID_A,
      cwd,
      hook_event_name: 'Stop',
      last_assistant_message: 'พบสาเหตุแล้ว\nQUEST-VERDICT: DONE',
    });
    await wait(40);
    assert.strictEqual(sent.length, 2);
    assert.ok(sent[1].text.includes('ขั้น 2/3 แก้โค้ด'));
    assert.strictEqual(store.sessions.get(terminalRoom.id).quest.scene, 'dungeon');

    // Create: a background hero.
    res = await post(port, '/api/guild/quests', {
      heroClassId: 'researcher',
      goal: 'สรุป flow การจ่ายเงิน',
      cwd: roomDir('http-bg'),
      launch: 'headless',
      optionValue: 'deep',
    });
    assert.strictEqual(res.status, 200, res.raw);
    assert.strictEqual(res.json.quest.state, 'running');
    assert.strictEqual(res.json.launchResult, null);
    assert.deepStrictEqual(sent[2].opts, { runHeadless: true, permissionMode: 'acceptEdits' });
    assert.ok(sent[2].text.includes('Deep Dive'));
    const bgQuest = res.json.quest;

    // Create: an idle hero that already has a terminal.
    const idle = store.getOrCreateSession('room-idle', { cwd: roomDir('idle'), pid: 31337 });
    res = await post(port, '/api/guild/quests', { heroClassId: 'quick_fix', goal: 'แก้ typo ใน README', sessionId: idle.id });
    assert.strictEqual(res.status, 200, res.raw);
    assert.strictEqual(res.json.quest.launch, 'existing');
    assert.deepStrictEqual(sent[3].opts, { noQueue: true });
    assert.strictEqual(sent[3].sessionId, idle.id);

    // The terminal could not be opened.
    openReply = { ok: false, launcher: 'manual', message: 'ไม่มี Windows Terminal' };
    res = await post(port, '/api/guild/quests', { heroClassId: 'quick_fix', goal: 'x', cwd: roomDir('no-wt') });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.quest.state, 'stalled');
    assert.ok(res.json.quest.stateReason.includes('ไม่มี Windows Terminal'));

    // List.
    res = await request(port, { urlPath: '/api/guild/quests', headers: auth });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.quests.length, 4);
    assert.strictEqual(res.json.quests[3].id, terminalQuest.id, 'newest first');

    // Actions.
    res = await post(port, '/api/guild/quest-action', { questId: terminalQuest.id, action: 'stop' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.quest.state, 'stopped');
    res = await post(port, '/api/guild/quest-action', { questId: terminalQuest.id, action: 'stop' });
    assert.strictEqual(res.status, 409);
    res = await post(port, '/api/guild/quest-action', { questId: bgQuest.id, action: 'resume' });
    assert.strictEqual(res.status, 409, 'a running quest cannot be resumed');
    res = await post(port, '/api/guild/quest-action', { questId: 'quest-zz-0000', action: 'stop' });
    assert.strictEqual(res.status, 404);
    res = await post(port, '/api/guild/quest-action', { questId: bgQuest.id, action: 'dance' });
    assert.strictEqual(res.status, 400);

    // A quest that fails to start leaves no room of its own behind.
    const realStart = questRunner.start;
    questRunner.start = async () => {
      throw new QuestError(409, 'ทดสอบ');
    };
    const roomsBefore = store.sessions.size;
    res = await post(port, '/api/guild/quests', { heroClassId: 'quick_fix', goal: 'x', cwd: roomDir('orphan') });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(store.sessions.size, roomsBefore, 'the room made for it is removed');
    questRunner.start = realStart;

    // 423 while the usage guard holds.
    res = await post(port, '/api/usage/config', { action: 'simulate-low-quota' });
    assert.strictEqual(res.json.ok, true);
    res = await post(port, '/api/guild/quests', { heroClassId: 'quick_fix', goal: 'x', cwd: roomDir('held') });
    assert.strictEqual(res.status, 423);
    assert.strictEqual(res.json.held, true);
    res = await post(port, '/api/usage/config', { enabled: false });
    assert.strictEqual(res.json.ok, true);

    // No game page yet (it is written separately): 404, not a crash.
    fs.unlinkSync(path.join(publicDir, 'guild.html'));
    res = await request(port, { urlPath: '/guild' });
    assert.strictEqual(res.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, QUEST_FILE), 'utf8'));
  assert.strictEqual(saved.quests.length, 4, 'quests are written on close');
}

// ---------------------------------------------------------------------------------------------
// Review fixes: failed background results, overlapping runs, no queued copies, stale
// transcripts, merged rooms, a hold that lifted while closed, a fresh probe after "ทำต่อ"
// ---------------------------------------------------------------------------------------------
async function testReviewFixes() {
  // A background result that is an error stalls the quest; it is not the phase's answer.
  {
    const ctx = setup();
    const { id, quest } = await startQuest(ctx, { heroClassId: 'full_slayer', launch: 'headless' });
    ctx.store.stop(id, headlessErrorSummary('Claude AI usage limit reached'));
    const cur = q(ctx, quest.id);
    assert.strictEqual(cur.state, 'stalled');
    assert.strictEqual(cur.phaseIndex, 0, 'the phase did not count as done');
    assert.ok(cur.stateReason.includes('usage limit'));
  }
  {
    const store = new StateStore({ dataDir: fs.mkdtempSync(path.join(isolatedHome, 'store-err-')), saveDebounceMs: 0 });
    const bridge = new CommandBridge(store, null);
    const room = store.getOrCreateSession('session-err', { cwd: roomDir('bridge-err') });
    const details = [];
    store.on('change', (e) => e.type === 'hook_event' && details.push(e.detail));
    bridge._handleClaudeStreamJson(room.id, { type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached' });
    assert.ok(isHeadlessExitSummary(details[details.length - 1].lastAssistantMessage), 'an error result reads as a failure');
    bridge._handleClaudeStreamJson(room.id, { type: 'result', subtype: 'error_during_execution', result: 'boom' });
    assert.ok(isHeadlessExitSummary(details[details.length - 1].lastAssistantMessage), 'so does an error subtype');
    bridge._handleClaudeStreamJson(room.id, { type: 'result', subtype: 'success', is_error: false, result: 'ok\nQUEST-VERDICT: DONE' });
    assert.strictEqual(details[details.length - 1].lastAssistantMessage, 'ok\nQUEST-VERDICT: DONE');

    // noQueue: a prompt nothing could deliver is not left in the room's queue.
    const r = await bridge.dispatchCommand(room.id, 'phase prompt', { noQueue: true });
    assert.strictEqual(r.delivered, false);
    assert.deepStrictEqual(store.dequeueCommands(room.id), []);
    const r2 = await bridge.dispatchCommand(room.id, 'ordinary prompt');
    assert.strictEqual(r2.delivered, false);
    assert.strictEqual(store.dequeueCommands(room.id).length, 1, 'without noQueue it is queued as before');
    store.flush();
  }

  // Background: the previous run still alive after the wait stalls; never two runs at once.
  {
    const ctx = setup();
    const { id, quest } = await startQuest(ctx, { heroClassId: 'full_slayer', launch: 'headless' });
    ctx.bridge.activeProcesses.set(id, {});
    ctx.store.stop(id, 'QUEST-VERDICT: DONE');
    for (let i = 0; i < 200 && q(ctx, quest.id).state === 'running'; i++) await ctx.clock.runNext();
    assert.strictEqual(q(ctx, quest.id).state, 'stalled');
    assert.strictEqual(ctx.bridge.calls.length, 1, 'no second run while the first is alive');
    await expectQuestError(() => ctx.runner.action(quest.id, 'resume'), 409, 'resume waits for the old run');
    ctx.bridge.activeProcesses.delete(id);
    await ctx.runner.action(quest.id, 'resume');
    assert.strictEqual(ctx.bridge.calls.length, 2);
    assert.ok(ctx.bridge.last().text.includes('ขั้น 2/3'));
  }

  // A transcript that still ends with the previous answer is not this turn's answer.
  {
    const ctx = setup();
    const { id, quest } = await startQuest(ctx, { heroClassId: 'full_slayer' }, { existing: true });
    ctx.transcripts.set(id, 'แผนแก้\nQUEST-VERDICT: BLOCKED — ขอ token');
    ctx.store.stop(id); // no message in the hook: read from the transcript
    assert.strictEqual(q(ctx, quest.id).state, 'paused');
    await ctx.runner.action(quest.id, 'resume', 'token อยู่ใน .env');
    ctx.store.stop(id); // the answer is not in the file yet
    const cur = q(ctx, quest.id);
    assert.strictEqual(cur.state, 'running', 'the old BLOCKED is not read again');
    assert.strictEqual(cur.phaseIndex, 1, 'no verdict on a non-verify phase moves on');
  }

  // A merged room: the quest follows the room it went into.
  {
    const ctx = setup();
    const { id, quest } = await startQuest(ctx, { heroClassId: 'quick_fix' }, { existing: true });
    ctx.store.addRoom('room-merged-into', { pid: 9999 });
    ctx.store.sessions.delete(id);
    ctx.store.emit('change', { type: 'session_merged', detail: { sessionId: id, into: 'room-merged-into' } });
    assert.strictEqual(q(ctx, quest.id).sessionId, 'room-merged-into');
    assert.strictEqual(ctx.store.sessions.get('room-merged-into').quest.id, quest.id);
    ctx.store.stop('room-merged-into', 'QUEST-VERDICT: DONE');
    assert.strictEqual(q(ctx, quest.id).state, 'done');
  }
  {
    const store = new StateStore({ dataDir: fs.mkdtempSync(path.join(isolatedHome, 'store-merge-')), saveDebounceMs: 0 });
    const a = store.getOrCreateSession('room-a', { cwd: roomDir('merge-a') });
    const b = store.getOrCreateSession('room-b', { cwd: roomDir('merge-b') });
    Object.assign(a, { claudeSessionId: UUID_C, updatedAt: '2026-11-27T01:00:00.000Z' });
    Object.assign(b, { claudeSessionId: UUID_C, updatedAt: '2026-11-27T02:00:00.000Z' });
    const merged = [];
    store.on('change', (e) => e.type === 'session_merged' && merged.push(e.detail));
    store._deduplicateSessions();
    assert.deepStrictEqual(merged, [{ sessionId: 'room-a', into: 'room-b' }]);
    store.flush();
  }

  // A usage hold that lifted while Mission Control was closed: the paused quest carries on.
  {
    const ctx = setup();
    const { id, quest } = await startQuest(ctx, { heroClassId: 'full_slayer' }, { existing: true });
    ctx.usageGuard.holding = true;
    ctx.store.stop(id, 'QUEST-VERDICT: DONE');
    await ctx.clock.runNext();
    assert.strictEqual(q(ctx, quest.id).stateReason, USAGE_REASON);
    ctx.runner.stop();
    ctx.usageGuard.holding = false;
    const runner2 = ctx.make();
    assert.strictEqual(runner2.get(quest.id).state, 'paused');
    await ctx.clock.runNext();
    assert.strictEqual(runner2.get(quest.id).state, 'running');
    assert.ok(ctx.bridge.last().text.includes('ขั้น 2/3'));
    runner2.stop();
  }

  // After "ทำต่อ", a verify turn without a verdict is asked once more before pausing again.
  {
    const ctx = setup();
    const { id, quest } = await startQuest(ctx, { heroClassId: 'full_slayer' }, { existing: true });
    ctx.store.stop(id, 'QUEST-VERDICT: DONE');
    await ctx.clock.runNext();
    ctx.store.stop(id, 'QUEST-VERDICT: DONE');
    await ctx.clock.runNext();
    ctx.store.stop(id, 'ไม่มีผล');
    await ctx.clock.runNext(); // the probe
    ctx.store.stop(id, 'ก็ยังไม่มี');
    assert.strictEqual(q(ctx, quest.id).state, 'paused');
    await ctx.runner.action(quest.id, 'resume');
    assert.strictEqual(q(ctx, quest.id).probeSent, false);
    ctx.store.stop(id, 'รันแล้วแต่ลืมบอกผล');
    assert.strictEqual(q(ctx, quest.id).state, 'running', 'asks for the verdict again instead of pausing');
    assert.strictEqual(q(ctx, quest.id).probeSent, true);
  }
}

async function run() {
  testClasses();
  testParseVerdict();
  testPhasePrompt();
  await testTerminalLoopUntilFailed();
  await testExistingRoomPassAndTranscriptFallback();
  await testBlockedPauseAndResume();
  await testVerifyWithoutVerdictProbesOnce();
  await testUsageHold();
  await testStopAndActionErrors();
  await testSessionEndStallsThenResume();
  await testLaunchTimeoutAndUndelivered();
  await testHeadless();
  await testValidationAndExistingRules();
  await testRoomArchivedRemovedAndNewestMirror();
  await testPersistence();
  await testBridgeAndStore();
  await testReviewFixes();
  await testHttp();
  console.log('✅ Guild Mode checks passed!');
}

run()
  .catch((err) => {
    console.error('❌ Guild Mode checks failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(isolatedHome, { recursive: true, force: true });
    } catch {}
  });
