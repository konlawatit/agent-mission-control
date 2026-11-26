/**
 * Room notifications: which status changes ring, and what the notification says. The logic is a
 * pure block inside public/app.js; this loads exactly that block in a sandbox.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const start = src.indexOf('/* ---------- Notifications: transitions');
const end = src.indexOf('/* ---------- Notifications: browser wiring');
assert.ok(start !== -1 && end > start, 'notification block found in app.js');
const sandbox = {};
vm.runInNewContext(
  `${src.slice(start, end)}
   this.notifyTransitions = notifyTransitions;
   this.notifyPlain = notifyPlain;
   this.notifyMessage = notifyMessage;
   this.NOTIFY_REPEAT_MS = NOTIFY_REPEAT_MS;`,
  sandbox
);
const { notifyTransitions, notifyPlain, notifyMessage, NOTIFY_REPEAT_MS } = sandbox;

const room = (id, status, extra = {}) => ({ id, room: `room ${id}`, status, lifecycle: 'live', ...extra });

/** Feeds snapshots in order; returns the events of each step. */
function play(steps) {
  let memory = null;
  return steps.map(({ sessions, now = 0, viewingId = null, baseline = false }) => {
    const r = notifyTransitions(memory, sessions, { now, viewingId, baseline });
    memory = r.memory;
    // Array.from builds the list in this realm, so deepStrictEqual compares values only.
    return Array.from(r.events, (e) => `${e.id}:${e.kind}`);
  });
}

const tests = {
  'first snapshot after load is silent'() {
    const [first] = play([{ sessions: [room('a', 'needs_input'), room('b', 'done')] }]);
    assert.deepStrictEqual(first, []);
  },
  'idle -> needs_input rings once as attn'() {
    const out = play([{ sessions: [room('a', 'idle')] }, { sessions: [room('a', 'needs_input')], now: 1000 }]);
    assert.deepStrictEqual(out[1], ['a:attn']);
  },
  'needs_input -> needs_input is silent'() {
    const out = play([
      { sessions: [room('a', 'idle')] },
      { sessions: [room('a', 'needs_input')], now: 1000 },
      { sessions: [room('a', 'needs_input')], now: 2000 },
    ]);
    assert.deepStrictEqual(out[2], []);
  },
  'working -> done rings as done'() {
    const out = play([{ sessions: [room('a', 'working')] }, { sessions: [room('a', 'done')], now: 1000 }]);
    assert.deepStrictEqual(out[1], ['a:done']);
  },
  'other changes are silent (working, idle, paused_quota)'() {
    const out = play([
      { sessions: [room('a', 'done'), room('b', 'idle')] },
      { sessions: [room('a', 'working'), room('b', 'paused_quota')], now: 1000 },
      { sessions: [room('a', 'idle'), room('b', 'working')], now: 2000 },
    ]);
    assert.deepStrictEqual(out[1], []);
    assert.deepStrictEqual(out[2], []);
  },
  'the room on screen is silent, others still ring'() {
    const out = play([
      { sessions: [room('a', 'working'), room('b', 'working')] },
      { sessions: [room('a', 'done'), room('b', 'needs_input')], now: 1000, viewingId: 'a' },
    ]);
    assert.deepStrictEqual(out[1], ['b:attn']);
  },
  'a history room never rings, nor when it comes back live'() {
    const out = play([
      { sessions: [room('a', 'working'), room('h', 'closed', { lifecycle: 'history' })] },
      { sessions: [room('a', 'done', { lifecycle: 'history' }), room('h', 'needs_input', { lifecycle: 'history' })], now: 1000 },
      { sessions: [room('h', 'needs_input')], now: 2000 },
    ]);
    assert.deepStrictEqual(out[1], []);
    assert.deepStrictEqual(out[2], [], 'first time seen live is a baseline');
  },
  'a room seen for the first time is silent'() {
    const out = play([{ sessions: [room('a', 'idle')] }, { sessions: [room('a', 'idle'), room('new', 'needs_input')], now: 1000 }]);
    assert.deepStrictEqual(out[1], []);
  },
  'a rapid repeat of the same transition is suppressed, then rings again after the window'() {
    const t = 50000;
    const out = play([
      { sessions: [room('a', 'idle')], now: t },
      { sessions: [room('a', 'needs_input')], now: t + 1000 },
      { sessions: [room('a', 'idle')], now: t + 3000 },
      { sessions: [room('a', 'needs_input')], now: t + 5000 },
      { sessions: [room('a', 'idle')], now: t + 1000 + NOTIFY_REPEAT_MS },
      { sessions: [room('a', 'needs_input')], now: t + 2000 + NOTIFY_REPEAT_MS },
    ]);
    assert.deepStrictEqual(out[1], ['a:attn']);
    assert.deepStrictEqual(out[3], [], 'flapping back within the window');
    assert.deepStrictEqual(out[5], ['a:attn'], 'after the window it rings again');
  },
  'a different kind right after is not suppressed'() {
    const out = play([
      { sessions: [room('a', 'working')] },
      { sessions: [room('a', 'needs_input')], now: 1000 },
      { sessions: [room('a', 'done')], now: 3000 },
    ]);
    assert.deepStrictEqual(out[1], ['a:attn']);
    assert.deepStrictEqual(out[2], ['a:done']);
  },
  'a reconnect (baseline) is silent but keeps flapping memory'() {
    const out = play([
      { sessions: [room('a', 'idle')] },
      { sessions: [room('a', 'needs_input')], now: 1000 },
      { sessions: [room('a', 'done'), room('b', 'done')], now: 2000, baseline: true },
      { sessions: [room('a', 'needs_input'), room('b', 'done')], now: 3000 },
    ]);
    assert.deepStrictEqual(out[2], []);
    assert.deepStrictEqual(out[3], [], 'same kind within the window, even across a reconnect');
  },
  'several rooms change in one snapshot: one event each'() {
    const out = play([
      { sessions: [room('a', 'working'), room('b', 'working'), room('c', 'idle')] },
      { sessions: [room('a', 'done'), room('b', 'needs_input'), room('c', 'needs_input')], now: 1000 },
    ]);
    assert.deepStrictEqual(out[1], ['a:done', 'b:attn', 'c:attn']);
  },
  'notifyPlain strips Markdown, emoji and line breaks, and cuts long text'() {
    assert.strictEqual(notifyPlain('⚠️ **แก้** `AuthController.cs`\n\n- เพิ่ม [endpoint](http://x) ใหม่'), 'แก้ AuthController.cs เพิ่ม endpoint ใหม่');
    assert.strictEqual(notifyPlain('## สรุป\n1. รัน *unit* test\n> ผ่าน'), 'สรุป รัน unit test ผ่าน');
    assert.strictEqual(notifyPlain('keeps refresh_token_service and 2.5 s'), 'keeps refresh_token_service and 2.5 s');
    const long = notifyPlain('ก'.repeat(200));
    assert.strictEqual(Array.from(long).length, 80);
    assert.ok(long.endsWith('…'));
    assert.strictEqual(notifyPlain(null), '');
  },
  'notifyMessage: Thai text for a question, an approval and a finished turn'() {
    const ask = notifyMessage(room('a', 'needs_input', { room: 'Auth Refactor', interactivePrompt: { question: 'Do you want to run\n`dotnet ef`?' } }), 'attn');
    assert.deepStrictEqual({ ...ask }, { title: 'Auth Refactor', body: 'รอคุณตอบ: Do you want to run dotnet ef?' });
    const multi = notifyMessage(room('a', 'needs_input', { interactivePrompt: { question: 'Q1', questions: [{}, {}, {}] } }), 'attn');
    assert.strictEqual(multi.body, 'รอคุณตอบ 3 ข้อ: Q1');
    const approve = notifyMessage(room('a', 'needs_input', { pendingAction: 'Bash(npx nx e2e web-e2e)' }), 'attn');
    assert.strictEqual(approve.body, 'รอคุณยืนยัน: Bash(npx nx e2e web-e2e)');
    assert.strictEqual(notifyMessage(room('a', 'needs_input'), 'attn').body, 'ห้องนี้รอคุณอยู่');
    const done = notifyMessage(room('a', 'done', { tldr: 'อัปเดต **WezTerm** pairing แล้ว commit เรียบร้อย' }), 'done');
    assert.strictEqual(done.body, 'ทำเสร็จแล้ว: อัปเดต WezTerm pairing แล้ว commit เรียบร้อย');
    assert.strictEqual(notifyMessage(room('a', 'done', { tldr: '⚠️ รอการตัดสินใจจากคุณ: x' }), 'done').body, 'ทำเสร็จแล้ว');
    assert.strictEqual(notifyMessage(room('a', 'done', { tldr: '' }), 'done').body, 'ทำเสร็จแล้ว');
    const doneLong = notifyMessage(room('a', 'done', { tldr: 'ข'.repeat(300) }), 'done');
    assert.ok(Array.from(doneLong.body).length <= 'ทำเสร็จแล้ว: '.length + 80);
    assert.strictEqual(notifyMessage({ id: 'x', status: 'done' }, 'done').title, 'ห้อง Agent');
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n${err.stack}`);
  }
}
if (failed) {
  console.error(`❌ ${failed} notification test(s) failed`);
  process.exit(1);
}
console.log('✅ Notification checks passed!');
