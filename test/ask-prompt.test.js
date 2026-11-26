/**
 * Claude's multi-question prompts: exact text from the tool input, cursor and progress from the
 * (garbled) terminal screen.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-home-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
const { parseConsoleScreen } = require('../src/console-scanner');
const { sanitizeQuestions, matchQuestionIndex, mergeScreenPrompt } = require('../src/ask-prompt');
const { parseTranscriptTailUncached } = require('../src/transcript-parser');
const { StateStore } = require('../src/state-store');

const QUESTIONS = [
  {
    question: '[ทดสอบ] ถ้าจะเพิ่มฟีเจอร์ export invoice ใน new-cpt ควรทำเป็นแบบไหน?',
    header: 'Export',
    multiSelect: false,
    options: [
      { label: 'PDF (Recommended)', description: 'ใช้ template เดียวกับ legacy client-portal-api' },
      { label: 'Excel (.xlsx)', description: 'เหมาะกับฝ่ายบัญชีที่ต้องเอาไปคำนวณต่อ' },
      { label: 'CSV', description: 'ทำง่ายและเร็วที่สุด แต่ไม่มี format' },
    ],
  },
  {
    question: '[ทดสอบ] อยากให้ tool ช่วยทำอะไรบ้างหลังแก้โค้ดเสร็จ? (เลือกได้หลายข้อ)',
    header: 'หลังแก้โค้ด',
    multiSelect: true,
    options: [
      { label: 'รัน unit test', description: 'รัน test ของ project ที่แก้' },
      { label: 'Code review', description: 'รีวิวหา bug ใน diff ก่อน commit' },
    ],
  },
  {
    question: '[ทดสอบ] ชอบ layout ของหน้า Subscription แบบไหน?',
    header: 'Layout',
    multiSelect: false,
    options: [
      { label: 'Card', description: 'แสดงแต่ละ package เป็นการ์ด', preview: '┌──┐\n│฿990│\n└──┘' },
      { label: 'Table', description: 'เทียบฟีเจอร์เป็นตาราง' },
    ],
  },
];

// What the Windows console returned for the first question (captured from a real session).
const SCREEN_Q1 = [
  '────────────────────────────────────────────────────────',
  '←  ☐ Export  ☐ ห�งแ�โ�ด  ☐ Layout  ✔ Submit  →',
  '',
  '[ทดสอบ] �าจะเ�ม�เจอ� export invoice ใน new-cpt ควร�เ�นแบบไหน?',
  '',
  '❯ 1. PDF (Recommended)',
  '     ใช� template เ�ยว�บ legacy client-portal-api',
  '  2. Excel (.xlsx)',
  '  3. CSV',
  '  4. Type something.',
  '  5. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');

const SCREEN_Q2 = [
  '────────────────────────────────────────────────────────',
  '←  ☒ Export  ☐ ห�งแ�โ�ด  ☐ Layout  ✔ Submit  →',
  '',
  '[ทดสอบ] อยาก�ห� tool �วย�อะไร�างหลังแ�โ�ดเสร�จ? (เลือกไ�หลาย�อ)',
  '',
  '  1. [✔] รัน unit test',
  '❯ 2. [ ] Code review',
  '  3. Type something.',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');

// A question with previews: the box sits beside the options and pushes the footer far down
// (read from a real session).
const SCREEN_Q3_PREVIEW = [
  '───────────────────────────────────────────────────────────────────────────',
  '←  ☐ Export  ☐ ห�งแ�โ�ด  ☐ Layout  ✔ Submit  →',
  '',
  '[ทดสอบ] ชอบ layout ของห�า Subscription แบบไหน?',
  '',
  '❯ 1. Card                         ┌──────────────────────────────────────────┐',
  '  2. Table                        │ ┌──────────┐ ┌──────────┐ ┌──────────┐   │',
  '                                  │ │  Basic   │ │   Pro    │ │Enterprise│   │',
  '                                  │ │  ฿990    │ │  ฿2,490  │ │  �ด�อ  │     │',
  '                                  │ │ [เ�อก]  │ │ [เ�อก]  │ │ [�ด�อ] │       │',
  '                                  │ └──────────┘ └──────────┘ └──────────┘   │',
  '                                  └──────────────────────────────────────────┘',
  '',
  '                                  Notes: press n to add notes',
  '',
  '───────────────────────────────────────────────────────────────────────────',
  '  Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel',
].join('\n');

// 0. A prompt with a preview beside its options is still a prompt, with clean option labels.
{
  const p = parseConsoleScreen(SCREEN_Q3_PREVIEW).interactivePrompt;
  assert.ok(p, 'the preview layout is recognised as a prompt');
  assert.deepStrictEqual(p.options.map((o) => o.label), ['Card', 'Table'], 'the preview box is cut off the labels');
  assert.strictEqual(p.currentIndex, 1);
  assert.ok(/Esc to cancel/.test(p.footer) && !p.footer.includes('┌'), `footer is the key hint line: ${p.footer}`);
  const m = mergeScreenPrompt(p, { questions: sanitizeQuestions(QUESTIONS) });
  assert.strictEqual(m.activeQuestion, 2, 'matched to the Layout question');
  assert.ok(m.options[0].preview.includes('฿990'), 'the clean preview comes from the tool input');
}

// The last step of a multi-question prompt (read from a real session).
const SCREEN_REVIEW = [
  '───────────────────────────────────────────────────────────────────────────',
  '←  ☐ Export  ☐ ห�งแ�โ�ด  ☐ Layout  ✔ Submit  →',
  '',
  'Review your answers',
  '',
  '⚠ Some questions are unanswered',
  '',
  '❯ 1. Submit answers',
  '  2. Cancel',
].join('\n');

// 0b. The submit step is known as such, so the tabs can move back from it.
{
  const p = parseConsoleScreen(SCREEN_REVIEW).interactivePrompt;
  const m = mergeScreenPrompt(p, { questions: sanitizeQuestions(QUESTIONS) });
  assert.strictEqual(m.activeQuestion, -1, 'no question is on screen');
  assert.strictEqual(m.reviewStep, true, 'it is the submit step');
  assert.deepStrictEqual(m.options.map((o) => o.label), ['Submit answers', 'Cancel']);
  assert.ok(m.context.includes('⚠ Some questions are unanswered'), 'the warning stays');
  assert.ok(!m.context.some((l) => l.includes('�')), 'garbled lines (the tab bar) are dropped');
}

// A multi-select question: checkboxes, then an unnumbered "Next" row (read from a real session).
const SCREEN_MULTI = [
  '───────────────────────────────────────────────────────────────────────────',
  '←  ☒ Export  ☐ ห�งแ�โ�ด  ☐ Layout  ✔ Submit  →',
  '',
  '[ทดสอบ] อยากใ� tool �วย�อะไร�างห�งแ�โ�ดเส�จ? (เ�อกไ�หลาย�อ)',
  '',
  '  1. [ ] �น unit test',
  '         �น test ของ project �แ�',
  '  2. [ ] Code review',
  '         ��วหา bug ใน diff �อน commit',
  '❯ 3. [ ] �ปเดต Apidog',
  '         sync API doc จาก Swagger ไป Apidog',
  '  4. [ ] �น�ก journal',
  '         จด�ง��ลง ~/journal/',
  '  5. [ ] Type something',
  '     Next',
  '───────────────────────────────────────────────────────────────────────────',
  '  6. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');

// 0c. Arrow positions count the "Next" row, so moving to "Chat about this" stays correct.
{
  const p = parseConsoleScreen(SCREEN_MULTI).interactivePrompt;
  assert.deepStrictEqual(p.options.map((o) => o.index), [1, 2, 3, 4, 5, 7]);
  assert.strictEqual(p.nextIndex, 6, 'the Next row is position 6');
  assert.strictEqual(p.currentIndex, 3);
  assert.deepStrictEqual(p.options.slice(0, 5).map((o) => o.checked), [false, false, false, false, false]);
  const m = mergeScreenPrompt(p, { questions: sanitizeQuestions(QUESTIONS) });
  assert.strictEqual(m.activeQuestion, 1);
  assert.strictEqual(m.nextIndex, 6, 'kept through the merge');
  assert.strictEqual(m.options[1].label, 'Code review');
}

// 1. The screen parser reads tabs and checkboxes, and never takes the tab bar for the question.
{
  const p1 = parseConsoleScreen(SCREEN_Q1).interactivePrompt;
  assert.ok(p1.question.startsWith('[ทดสอบ]'), `question line, not the tab bar: ${p1.question}`);
  assert.deepStrictEqual(p1.tabs.map((t) => t.done), [false, false, false, true]);
  const p2 = parseConsoleScreen(SCREEN_Q2).interactivePrompt;
  assert.strictEqual(p2.options[0].checked, true, '[✔] is ticked');
  assert.strictEqual(p2.options[1].checked, false, '[ ] is not');
  assert.strictEqual(p2.options[1].label, 'Code review', 'checkbox stripped from the label');
  assert.strictEqual(p2.currentIndex, 2);
}

// 2. The garbled on-screen question is matched to Claude's exact one.
{
  const qs = sanitizeQuestions(QUESTIONS);
  assert.strictEqual(matchQuestionIndex('[ทดสอบ] �าจะเ�ม�เจอ� export invoice ใน new-cpt ควร�เ�นแบบไหน?', qs), 0);
  assert.strictEqual(matchQuestionIndex('[ทดสอบ] อยาก�ห� tool �วย�อะไร�างหลังแ�โ�ดเสร�จ? (เลือกไ�หลาย�อ)', qs), 1);
  assert.strictEqual(matchQuestionIndex('Ready to submit your answers?', qs), -1, 'the submit step matches none');
}

// 3. Merging: exact Thai text, every question, screen cursor and progress kept.
{
  const ask = { id: 't1', questions: sanitizeQuestions(QUESTIONS) };
  const m1 = mergeScreenPrompt(parseConsoleScreen(SCREEN_Q1).interactivePrompt, ask);
  assert.strictEqual(m1.question, QUESTIONS[0].question);
  assert.strictEqual(m1.questions.length, 3, 'all questions are listed');
  assert.strictEqual(m1.activeQuestion, 0);
  assert.strictEqual(m1.options[0].label, 'PDF (Recommended)');
  assert.strictEqual(m1.options[0].description, QUESTIONS[0].options[0].description, 'descriptions in clean Thai');
  assert.strictEqual(m1.options[3].label, 'Type something.', "the TUI's own options stay");
  assert.ok(!JSON.stringify(m1).includes('�'), 'no garbled text survives the merge');

  const m2 = mergeScreenPrompt(parseConsoleScreen(SCREEN_Q2).interactivePrompt, ask);
  assert.strictEqual(m2.activeQuestion, 1);
  assert.strictEqual(m2.multiSelect, true);
  assert.strictEqual(m2.options[0].label, 'รัน unit test');
  assert.strictEqual(m2.options[0].checked, true, 'tick state comes from the screen');
  assert.strictEqual(m2.currentIndex, 2, 'cursor comes from the screen');
  assert.deepStrictEqual(m2.questions.map((q) => q.answered), [true, false, false]);
}

// 4. The transcript gives the open question until its tool result arrives.
{
  const file = path.join(isolatedHome, 'ask.jsonl');
  const ask = {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: { questions: QUESTIONS } }] },
  };
  fs.writeFileSync(file, [{ type: 'user', message: { role: 'user', content: 'ask me' } }, ask].map((e) => JSON.stringify(e)).join('\n') + '\n');
  let parsed = parseTranscriptTailUncached(file, null);
  assert.ok(parsed.pendingAsk, 'an unanswered AskUserQuestion is pending');
  assert.strictEqual(parsed.pendingAsk.questions.length, 3);
  assert.strictEqual(parsed.pendingAsk.questions[1].multiSelect, true);
  fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'PDF' }] } }) + '\n');
  parsed = parseTranscriptTailUncached(file, null);
  assert.strictEqual(parsed.pendingAsk, null, 'answered questions are no longer pending');
}

// 5. The PreToolUse hook carries all questions, not only the first.
{
  const store = new StateStore({ dataDir: fs.mkdtempSync(path.join(isolatedHome, 'store-')) });
  const cwd = fs.mkdtempSync(path.join(isolatedHome, 'room-'));
  const room = store.processHookEvent({
    session_id: 'ask-room',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'toolu_2',
    tool_input: { questions: QUESTIONS },
  });
  assert.strictEqual(room.status, 'needs_input');
  assert.strictEqual(room.interactivePrompt.questions.length, 3);
  assert.strictEqual(room.interactivePrompt.question, QUESTIONS[0].question);
  assert.strictEqual(room.statusLabel, 'รอคุณตอบ 3 คำถาม');
  store.processHookEvent({ session_id: 'ask-room', cwd, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' });
  assert.strictEqual(room.pendingAsk, null, 'answering clears the pending questions');
  store.flush();
}

// 6. Through the console scan: the preview layout merges; an unknown layout keeps the room
//    waiting (not "idle") while the transcript says the question is open; the permission
//    flow for AskUserQuestion never turns into Yes/No.
{
  const store = new StateStore({ dataDir: fs.mkdtempSync(path.join(isolatedHome, 'store-')) });
  const cwd = fs.mkdtempSync(path.join(isolatedHome, 'room-'));
  const transcript = path.join(isolatedHome, 'scan-ask.jsonl');
  const askEntry = {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_9', name: 'AskUserQuestion', input: { questions: QUESTIONS } }] },
  };
  fs.writeFileSync(transcript, [{ type: 'user', message: { role: 'user', content: 'ask' } }, askEntry].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const room = store.getOrCreateSession('claude-pid-777', { cwd, pid: 777 });
  room.transcriptPath = transcript;

  store.ingestConsoleScan([{ pid: 777, cwd, screen: SCREEN_Q3_PREVIEW }]);
  assert.strictEqual(room.status, 'needs_input');
  assert.strictEqual(room.interactivePrompt.activeQuestion, 2, 'the Layout question is on screen');
  assert.strictEqual(room.interactivePrompt.question, QUESTIONS[2].question);

  const unknownLayout = ['Claude Code', '', 'something the parser has never seen', '> '].join('\n');
  store.ingestConsoleScan([{ pid: 777, cwd, screen: unknownLayout }]);
  assert.strictEqual(room.status, 'needs_input', 'still waiting on the open questions');
  assert.strictEqual(room.interactivePrompt.questions.length, 3);
  assert.strictEqual(room.interactivePrompt.activeQuestion, -1, 'position unknown');

  store.processHookEvent({ session_id: room.id, cwd, hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS } });
  assert.ok(!/Yes/.test(JSON.stringify(room.interactivePrompt.options)), 'no Yes/No approval for a question');
  assert.ok(!/ขอสิทธิ์/.test(room.tldr), 'the summary is not a permission request');
  store.flush();
}

console.log('✅ Multi-question prompt checks passed!');
