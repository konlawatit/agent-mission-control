/**
 * Transcript tail parsing against the shape Claude Code writes today: real user/assistant
 * messages interleaved with large bookkeeping records (api-request blobs, tool shapes,
 * attachments) and harness-injected meta messages.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-home-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
const { parseTranscriptTailUncached } = require('../src/transcript-parser');

const user = (text, extra = {}) => ({ type: 'user', timestamp: '2026-11-26T01:00:00.000Z', message: { role: 'user', content: text }, ...extra });
const assistant = (text) => ({
  type: 'assistant',
  timestamp: '2026-11-26T01:00:01.000Z',
  message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] },
});
// Copies of request messages, as Claude Code now stores them: ~120 KB each.
const blob = (i) => ({
  type: 'api-request-blob',
  sessionId: 's',
  hash: `h${i}`,
  message: { role: 'user', content: [{ type: 'text', text: 'Tool loaded.' }, { type: 'text', text: 'x'.repeat(120 * 1024) }] },
});

function writeTranscript(entries) {
  const file = path.join(isolatedHome, `t-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

// 1. Big bookkeeping records at the end must not push the conversation out of view.
{
  const entries = [];
  for (let i = 1; i <= 20; i++) {
    entries.push(user(`prompt ${i}`));
    entries.push(assistant(`reply ${i}`));
  }
  for (let i = 0; i < 6; i++) entries.push(blob(i)); // ~720 KB, well past a 256 KB window
  entries.push(user('latest prompt'));
  entries.push(assistant('latest reply'));
  const parsed = parseTranscriptTailUncached(writeTranscript(entries), null);
  assert.ok(parsed, 'parser returns a result');
  const preview = parsed.utf8Preview || '';
  assert.ok(preview.includes('latest reply'), 'newest reply is shown');
  assert.ok(preview.includes('reply 15'), `older replies stay visible behind large records:\n${preview.slice(0, 300)}`);
  assert.ok(!preview.includes('Tool loaded.'), 'api-request-blob copies are not read as conversation');
  assert.ok(!preview.includes('xxxxxxxx'), 'blob payloads never reach the preview');
  assert.ok(parsed.turnHistory.length >= 10, `turn history survives large records (got ${parsed.turnHistory.length})`);
}

// 2. Harness-injected user messages are not the human's prompts.
{
  const entries = [
    user('real question'),
    user('Base directory for this skill: /skills/debugging', { isMeta: true }),
    user('This session is being continued from a previous conversation', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    assistant('answer'),
  ];
  const parsed = parseTranscriptTailUncached(writeTranscript(entries), null);
  const preview = parsed.utf8Preview || '';
  assert.strictEqual(parsed.lastUserText, 'real question', 'last prompt is the human one');
  assert.ok(!preview.includes('Base directory'), 'meta (skill body) messages are hidden');
  assert.ok(!preview.includes('being continued'), 'compaction summaries are hidden');
}

// 3. A long tool-heavy turn still finds the human prompt that started it.
{
  const entries = [user('earlier prompt'), assistant('earlier reply'), user('fix the dashboard')];
  for (let i = 0; i < 120; i++) {
    entries.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `step ${i}` } }] },
    });
    entries.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok '.repeat(2000) }] } });
    if (i % 10 === 0) entries.push(blob(i));
  }
  const parsed = parseTranscriptTailUncached(writeTranscript(entries), null);
  assert.strictEqual(parsed.lastUserText, 'fix the dashboard', 'the turn prompt is found behind many tool calls');
  assert.ok(parsed.turnHistory.some((t) => t.goal === 'fix the dashboard'), 'the running turn is in history');
}

// 4. A file with no line breaks inside the read cap still parses (no partial-line garbage).
{
  const entries = [user('only prompt'), assistant('only reply')];
  const parsed = parseTranscriptTailUncached(writeTranscript(entries), null);
  assert.ok(parsed.utf8Preview.includes('only reply'), 'short transcripts parse whole');
}

// 5. The transcript says when a turn ended, for rooms whose hooks are not live.
const at = (ms) => new Date(Date.now() + ms).toISOString();
const turnEnd = (ms) => ({ type: 'system', subtype: 'turn_duration', timestamp: at(ms), durationMs: 1000 });
const endTurn = (text, ms) => ({
  type: 'assistant',
  timestamp: at(ms),
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
});
const toolCall = (ms) => ({
  type: 'assistant',
  timestamp: at(ms),
  message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] },
});
{
  let parsed = parseTranscriptTailUncached(writeTranscript([user('go'), endTurn('done', 1000), turnEnd(1001)]), null);
  assert.strictEqual(parsed.turnState, 'done', 'turn_duration ends the turn');
  assert.ok(Date.parse(parsed.turnStateAt) > Date.now(), 'with the time it ended');
  parsed = parseTranscriptTailUncached(writeTranscript([user('go'), toolCall(1000)]), null);
  assert.strictEqual(parsed.turnState, 'running', 'a pending tool call is a running turn');
  parsed = parseTranscriptTailUncached(writeTranscript([user('go'), endTurn('a', 0), turnEnd(1), user('next')]), null);
  assert.strictEqual(parsed.turnState, 'running', 'a new prompt after the end starts a turn');
  parsed = parseTranscriptTailUncached(writeTranscript([user('go'), toolCall(0), user('[Request interrupted by user]')]), null);
  assert.strictEqual(parsed.turnState, 'done', 'an interrupted turn is over');
}

// 6. A room the dashboard marked "working" finishes when its transcript shows the turn ended,
//    even if no Stop hook ever arrives (the Claude session started before hooks were installed).
{
  const { StateStore } = require('../src/state-store');
  const dataDir = fs.mkdtempSync(path.join(isolatedHome, 'store-'));
  const cwd = fs.mkdtempSync(path.join(isolatedHome, 'room-'));
  const store = new StateStore({ dataDir });
  const transcript = writeTranscript([user('earlier'), endTurn('old reply', -60000), turnEnd(-59000)]);
  const room = store.processHookEvent({
    session_id: 'dashboard-room',
    cwd,
    transcript_path: transcript,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'run the tests',
  });
  assert.strictEqual(room.status, 'working', 'sending a prompt marks the room working');
  store._enrichSessionFromTranscript(room);
  assert.strictEqual(room.status, 'working', 'a turn that ended before the prompt does not finish it');

  fs.appendFileSync(transcript, [user('run the tests'), endTurn('all green', 2000), turnEnd(2001)].map((e) => JSON.stringify(e)).join('\n') + '\n');
  store._enrichSessionFromTranscript(room);
  assert.strictEqual(room.status, 'done', 'the transcript turn end finishes the room');
  assert.strictEqual(room.currentTool, 'Ready');

  // A room opened with a goal in a folder whose last transcript ended long ago keeps working.
  const cwd2 = fs.mkdtempSync(path.join(isolatedHome, 'room-'));
  const oldTranscript = writeTranscript([user('old'), endTurn('old', -3600000), turnEnd(-3599000)]);
  const spawned = store.getOrCreateSession('spawned-room', { cwd: cwd2, status: 'working', goal: 'new task' });
  spawned.transcriptPath = oldTranscript;
  store._enrichSessionFromTranscript(spawned);
  assert.strictEqual(spawned.status, 'working', 'an old finished transcript does not finish a new room');
  store.flush();
}

// 7. Reading back: older pages plus the live preview are the whole conversation, in order,
//    with nothing missing or repeated, even across large bookkeeping records.
{
  const { readConversationPage } = require('../src/transcript-parser');
  const entries = [];
  for (let i = 1; i <= 120; i++) {
    entries.push(user(`prompt ${i}`));
    entries.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }, { type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `f${i}.js` } }] },
    });
    if (i % 25 === 0) entries.push(blob(i));
  }
  const file = writeTranscript(entries);
  const parsed = parseTranscriptTailUncached(file, null);
  assert.ok(parsed.previewFrom > 0, 'the preview starts part-way into the file');
  const previewLines = parsed.utf8Preview.split(/\n\n(?=🧑|🤖|🔧)/);

  const older = [];
  let before = parsed.previewFrom;
  let pages = 0;
  for (;;) {
    const page = readConversationPage(file, { before, limit: 40 });
    assert.ok(page.lines.length <= 42, `a page is about the size asked for (${page.lines.length})`);
    older.unshift(...page.lines);
    pages += 1;
    assert.ok(page.from < before || page.done, 'each page moves back');
    before = page.from;
    if (page.done) break;
    assert.ok(pages < 50, 'paging ends');
  }
  const all = [...older, ...previewLines];
  const expected = [];
  for (let i = 1; i <= 120; i++) expected.push(`🧑 คุณ: prompt ${i}`, `🤖 Claude:\nreply ${i}`, `🔧 [Tool: Read] f${i}.js`);
  assert.deepStrictEqual(all, expected, 'older pages + preview = the whole session, no gaps or repeats');
  assert.ok(pages > 1, 'more than one page was needed');

  // Gap fill: everything from an older cursor up to the current preview start.
  const cursor = readConversationPage(file, { before: parsed.previewFrom, limit: 10 }).from;
  const gap = readConversationPage(file, { before: parsed.previewFrom, since: cursor });
  assert.deepStrictEqual(gap.lines, readConversationPage(file, { before: parsed.previewFrom, limit: 10 }).lines);
}

// A guild quest's verdict line is for the quest runner: summaries (the TL;DR) leave it out,
// unless it is all there is.
{
  const { summarizeText } = require('../src/transcript-parser');
  assert.strictEqual(summarizeText('รัน npm test: all passed\nQUEST-VERDICT: PASS'), 'รัน npm test: all passed');
  assert.strictEqual(summarizeText('แก้แล้ว\r\n**QUEST-VERDICT: FAIL — 2 tests**'), 'แก้แล้ว');
  assert.strictEqual(summarizeText('QUEST-VERDICT: PASS'), 'QUEST-VERDICT: PASS');
  assert.strictEqual(summarizeText('see QUEST-VERDICT: PASS in the middle'), 'see QUEST-VERDICT: PASS in the middle');
}

console.log('✅ Transcript tail parsing checks passed!');
