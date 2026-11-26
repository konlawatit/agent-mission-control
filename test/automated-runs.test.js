/**
 * Automated runs (`claude -p`, Agent SDK): only sdk-* transcripts are counted, grouped by the
 * folder they ran in, bucketed per hour with the longest idle gap, failures told apart from
 * failed tool calls, and files read once and then only what was appended.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-auto-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

const { AutomatedRuns, RUNNING_GRACE_MS } = require('../src/automated-runs');
const { encodeProjectDir } = require('../src/transcript-parser');
const { createMissionControlServer } = require('../src/server');

const TOKEN = 'a'.repeat(48);
const NOW = Date.now();
const HOUR = 3600 * 1000;
const at = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();
const projects = path.join(isolatedHome, '.claude', 'projects');

const PARTNER = 'C:\\Repo\\e2e-forge\\.worktrees\\partner';
const OTHER = 'C:\\Repo\\other-tool';
const HUMAN = 'C:\\Repo\\client-portal-api';

let seq = 0;
const uuid = () => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
};

/** Entries in the key order Claude Code writes them (parentUuid first, `type` later). */
function run(cwd, entrypoint, sessionId = uuid()) {
  const lines = [];
  const base = () => ({ parentUuid: null, isSidechain: false });
  const meta = (minAgo) => ({ userType: 'external', entrypoint, cwd, sessionId, timestamp: at(minAgo) });
  const api = {
    sessionId,
    lines,
    prompt(minAgo, text) {
      lines.push({ ...base(), type: 'user', message: { role: 'user', content: text }, ...meta(minAgo) });
      return api;
    },
    assistant(minAgo, { id = `msg_${uuid()}`, stop = 'end_turn', text = null, tool = null, usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 70, cache_read_input_tokens: 1000 }, split = false, apiError = null } = {}) {
      const content = [];
      if (text) content.push({ type: 'text', text });
      if (tool) content.push({ type: 'tool_use', id: `toolu_${id}`, name: tool, input: { command: 'npx playwright test' } });
      const message = { model: apiError ? '<synthetic>' : 'claude-opus-5-5', id, type: 'message', role: 'assistant', content, stop_reason: stop, usage };
      const extra = apiError ? { error: apiError.error, isApiErrorMessage: true } : {};
      // A streamed message is written as one entry per content block, each with the same usage.
      if (split) lines.push({ ...base(), message: { ...message, content: [{ type: 'thinking', thinking: '' }] }, type: 'assistant', ...meta(minAgo) });
      lines.push({ ...base(), message, type: 'assistant', ...extra, ...meta(minAgo) });
      return api;
    },
    toolResult(minAgo, { text = 'ok', isError = false } = {}) {
      lines.push({ ...base(), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: text, is_error: isError }] }, ...meta(minAgo) });
      return api;
    },
    raw(obj) {
      lines.push(obj);
      return api;
    },
    write(mtimeMinAgo, root = projects) {
      const dir = path.join(root, encodeProjectDir(cwd));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${sessionId}.jsonl`);
      fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
      const t = new Date(NOW - mtimeMinAgo * 60000);
      fs.utimesSync(file, t, t);
      api.file = file;
      return api;
    },
  };
  return api;
}

// Fresh tokens of the default usage: input 10 + output 20 + cache creation 70.
const FRESH = 100;

// ---- Folder "partner": an overnight e2e job ----
const r1 = run(PARTNER, 'sdk-cli')
  .raw({ type: 'queue-operation', operation: 'enqueue', timestamp: at(600), sessionId: 'x', content: 'Write the Playwright spec for this flow' })
  .prompt(600, 'Write the Playwright spec for this flow: สร้างใบเสนอราคา')
  .assistant(599, { stop: 'tool_use', tool: 'Bash', split: true })
  .toolResult(598, { text: 'Error: 1 test failed', isError: true }) // a failed command does not fail the run
  .assistant(597, { stop: 'tool_use', tool: 'Edit' })
  .toolResult(596)
  .assistant(595, { text: 'The spec passes now.' })
  .raw({ type: 'cost-state', sessionId: 'x', totalCostUSD: 1.25 })
  .write(595);
const r2 = run(PARTNER, 'sdk-cli').prompt(570, 'You review ONE generated e2e spec').assistant(566, { text: 'Looks good.' }).write(566);
// Stopped right after a refused command: no final reply.
const r3 = run(PARTNER, 'sdk-cli')
  .prompt(540, 'A generated spec needs fixing. Fix the TEST.')
  .assistant(535, { stop: 'tool_use', tool: 'Bash' })
  .toolResult(525, { text: 'This command requires approval', isError: true })
  .write(525);
// The API failed for good.
const r4 = run(PARTNER, 'sdk-cli')
  .prompt(180, 'You plan ONE end-to-end test')
  .assistant(179, { stop: 'tool_use', tool: 'Read' })
  .toolResult(178)
  .raw({ parentUuid: null, isSidechain: false, type: 'system', subtype: 'api_error', level: 'error', retryAttempt: 1, timestamp: at(177) })
  .assistant(176, { stop: 'stop_sequence', text: 'API Error: Server error mid-response.', usage: { input_tokens: 0, output_tokens: 0 }, apiError: { error: 'server_error' } })
  .write(176);
// A run with huge bookkeeping records: a 3 MB request blob (with a fake usage inside that must not
// count) and an attachment, plus a 1.5 MB tool result that crosses read chunks and must be read.
const blob = {
  type: 'api-request-blob',
  sessionId: 'x',
  hash: 'h',
  message: { role: 'assistant', usage: { input_tokens: 999999, output_tokens: 999999 }, content: [{ type: 'text', text: 'x'.repeat(3 * 1024 * 1024) }] },
};
const r5 = run(PARTNER, 'sdk-cli')
  .prompt(120, 'Write the Playwright spec for this flow')
  .raw(blob)
  .raw({ parentUuid: null, isSidechain: false, attachment: { type: 'hook_success', content: 'y'.repeat(200 * 1024) }, type: 'attachment', timestamp: at(119) })
  .assistant(119, { stop: 'tool_use', tool: 'Bash' })
  .toolResult(118, { text: `ผลการรัน ${'ก'.repeat(500 * 1024)}` })
  .assistant(115, { text: 'Done.' })
  .write(115);
// Older than a day: only in the longer windows.
const rOld = run(PARTNER, 'sdk-cli').prompt(50 * 60, 'Old run').assistant(50 * 60 - 3, { text: 'ok' }).write(50 * 60 - 3);

// ---- Folder "other-tool": an Agent SDK tool ----
const r6 = run(OTHER, 'sdk-ts').prompt(60, 'Summarise the changelog').assistant(58, { text: 'Summary.' }).write(58);
// Still going: mid-work and written just now.
const r7 = run(OTHER, 'sdk-ts').prompt(4, 'Long job').assistant(1, { stop: 'tool_use', tool: 'Bash' }).write(0);
// Blocked by a hook before Claude answered.
const r8 = run(OTHER, 'sdk-cli')
  .raw({ type: 'queue-operation', operation: 'enqueue', timestamp: at(40), sessionId: 'x', content: 'Read note.txt and reply' })
  .raw({ parentUuid: null, isSidechain: false, type: 'system', subtype: 'informational', level: 'warning', content: 'UserPromptSubmit operation blocked by hook:\nNOPE', timestamp: at(40), entrypoint: 'sdk-cli', cwd: OTHER })
  .write(40);
const r9 = run(OTHER, 'sdk-cli')
  .prompt(50, 'Do something')
  .assistant(49, { stop: 'tool_use', tool: 'Bash' })
  .raw({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, timestamp: at(48), cwd: OTHER })
  .write(48);

// ---- A person's terminal session: never counted ----
run(HUMAN, 'cli').prompt(30, 'fix the invoice bug').assistant(29, { text: 'Fixed.' }).write(29);

const hourFloor = (x) => {
  const d = new Date(x);
  d.setMinutes(0, 0, 0);
  return d.getTime();
};
// Summaries below are taken at NOW, so an hour boundary passing while the test runs (or a slow
// scan) cannot shift the buckets these indexes point at.
const hourIndex = (ms, hours) => Math.round((hourFloor(ms) - (hourFloor(NOW) - (hours - 1) * HOUR)) / HOUR);

function byFolder(summary, name) {
  const g = summary.groups.find((x) => x.folder === name);
  assert.ok(g, `group ${name} is present (got ${summary.groups.map((x) => x.folder).join(', ')})`);
  return g;
}
const runOf = (g, r) => g.recent.find((x) => x.sessionId === r.sessionId);

async function testSummary(ar) {
  const s = await ar.summary({ hours: 24, now: NOW });
  assert.strictEqual(s.windowHours, 24);
  assert.deepStrictEqual(s.groups.map((g) => g.folder).sort(), ['other-tool', 'partner'], 'only sdk-* runs, grouped by the folder they ran in');
  assert.ok(!JSON.stringify(s).includes('invoice'), 'the terminal session never shows up');

  const p = byFolder(s, 'partner');
  assert.strictEqual(p.cwd, PARTNER);
  assert.strictEqual(p.runs, 5, 'the day-old run is outside the 24 h window');
  assert.strictEqual(p.failed, 2);
  assert.strictEqual(p.running, 0);
  assert.strictEqual(p.recent[0].sessionId, r5.sessionId, 'newest run first');

  const v1 = runOf(p, r1);
  assert.strictEqual(v1.status, 'ok', 'a failed tool call does not fail the run');
  assert.strictEqual(v1.toolErrors, 1);
  assert.strictEqual(v1.tokens, 3 * FRESH, 'split entries of one message are counted once');
  assert.strictEqual(v1.cacheReadTokens, 3000);
  assert.strictEqual(v1.turns, 3);
  assert.strictEqual(v1.toolCalls, 2);
  assert.strictEqual(v1.costUsd, 1.25);
  assert.strictEqual(v1.model, 'claude-opus-5-5');
  assert.strictEqual(v1.entrypoint, 'sdk-cli');
  assert.strictEqual(v1.firstPrompt, 'Write the Playwright spec for this flow: สร้างใบเสนอราคา');
  assert.strictEqual(v1.durationMs, 5 * 60000);

  const v3 = runOf(p, r3);
  assert.deepStrictEqual([v3.status, v3.reason, v3.detail], ['failed', 'cut_off', 'This command requires approval'], 'stopped mid-work after a refused command');
  const v4 = runOf(p, r4);
  assert.deepStrictEqual([v4.status, v4.reason], ['failed', 'api_error']);
  assert.ok(/Server error/.test(v4.detail), v4.detail);
  assert.strictEqual(v4.apiRetries, 1, 'retried API errors are counted');
  assert.strictEqual(v4.turns, 1, 'the synthetic API error message is not a turn');

  const v5 = runOf(p, r5);
  assert.strictEqual(v5.status, 'ok', 'lines after a 3 MB blob and a 1.5 MB tool result are read');
  assert.strictEqual(v5.tokens, 2 * FRESH, 'usage inside an api-request-blob is never counted');
  // r1 three messages, r2 and r3 one each, r4 one (its API error carries no usage), r5 two.
  assert.strictEqual(p.tokens, 3 * FRESH + FRESH + FRESH + FRESH + 2 * FRESH);

  // Hourly buckets: 24 local hours ending with the current one.
  assert.strictEqual(p.hourly.length, 24);
  assert.strictEqual(p.hourly.reduce((n, h) => n + h.runs, 0), 5);
  assert.strictEqual(p.hourly.reduce((n, h) => n + h.failed, 0), 2);
  assert.strictEqual(p.hourly.reduce((n, h) => n + h.tokens, 0), p.tokens);
  const h4 = p.hourly[hourIndex(NOW - 180 * 60000, 24)];
  assert.ok(h4.runs >= 1 && h4.failed >= 1, `the API-error run counts in its start hour ${JSON.stringify(h4)}`);
  // Busy minutes: r1 5, r2 4, r3 15, r4 4, r5 5 = 33, rounded per hour.
  const active = p.hourly.reduce((n, h) => n + h.activeMinutes, 0);
  assert.ok(active >= 30 && active <= 36, `hours show the minutes runs were going (${active})`);
  assert.ok(p.hourly[hourIndex(NOW - 532 * 60000, 24)].activeMinutes > 0, 'the hour in the middle of a run is active');
  for (let m = 7 * 60; m >= 4 * 60; m -= 60) {
    const h = p.hourly[hourIndex(NOW - m * 60000, 24)];
    assert.strictEqual(h.runs + h.activeMinutes, 0, `idle hours stay empty (${m / 60} h ago)`);
  }

  // Longest idle: from the end of the refused run (525 min ago) to the API-error run (180 min ago).
  assert.strictEqual(p.longestIdleMinutes, 345);
  assert.strictEqual(p.longestIdle.from, at(525));
  assert.strictEqual(p.longestIdle.to, at(180));
  assert.strictEqual(p.idleSinceMinutes, 115);

  const o = byFolder(s, 'other-tool');
  assert.strictEqual(o.runs, 4);
  assert.strictEqual(o.running, 1);
  assert.strictEqual(o.failed, 2);
  assert.strictEqual(runOf(o, r7).status, 'running', 'mid-work and written just now');
  const v8 = runOf(o, r8);
  assert.deepStrictEqual([v8.status, v8.reason], ['failed', 'no_reply']);
  assert.ok(/blocked by hook/.test(v8.detail), v8.detail);
  assert.strictEqual(v8.firstPrompt, 'Read note.txt and reply', 'the queued prompt stands in when no message was written');
  assert.deepStrictEqual([runOf(o, r9).status, runOf(o, r9).reason], ['failed', 'interrupted']);
  assert.strictEqual(runOf(o, r6).entrypoint, 'sdk-ts');
  assert.strictEqual(o.idleSinceMinutes, 0, 'not idle while a run is going');

  assert.deepStrictEqual(s.totals, { groups: 2, runs: 9, failed: 4, running: 1, tokens: p.tokens + o.tokens });
  assert.strictEqual(s.groups[0].folder, 'other-tool', 'the folder with the newest activity first');

  const week = await ar.summary({ hours: 72, now: NOW });
  assert.strictEqual(byFolder(week, 'partner').runs, 6, 'the day-old run is in the 3-day window');
  assert.strictEqual(byFolder(week, 'partner').hourly.length, 72);
}

async function testCacheAndAppend(ar) {
  const warm = await ar.summary({ hours: 24, now: NOW });
  assert.strictEqual(warm.scan.filesRead, 0, `unchanged files are not read again ${JSON.stringify(warm.scan)}`);
  assert.strictEqual(warm.scan.bytesRead, 0);
  assert.strictEqual(warm.scan.automated, 9);

  // A new turn appended to a finished run: only the new bytes are read.
  const before = fs.statSync(r5.file).size;
  const extra =
    [
      { parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: 'One more thing' }, timestamp: at(10), cwd: PARTNER },
      { parentUuid: null, isSidechain: false, message: { id: 'msg_more', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done again.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3 } }, type: 'assistant', timestamp: at(9) },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n';
  fs.appendFileSync(r5.file, extra);
  let s = await ar.summary({ hours: 24, now: NOW });
  assert.strictEqual(s.scan.filesRead, 1, 'only the grown file is read');
  assert.strictEqual(s.scan.bytesRead, Buffer.byteLength(extra), 'and only its new bytes');
  let v5 = runOf(byFolder(s, 'partner'), r5);
  assert.strictEqual(v5.tokens, 2 * FRESH + 6);
  assert.strictEqual(v5.turns, 3);
  assert.strictEqual(v5.endedAt, at(9));
  assert.ok(fs.statSync(r5.file).size > before);

  // A line still being written waits until it is complete, and is counted once.
  const line = JSON.stringify({ parentUuid: null, isSidechain: false, message: { id: 'msg_last', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Last.' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } }, type: 'assistant', timestamp: at(8) });
  fs.appendFileSync(r5.file, line.slice(0, 40));
  s = await ar.summary({ hours: 24, now: NOW });
  assert.strictEqual(runOf(byFolder(s, 'partner'), r5).tokens, 2 * FRESH + 6, 'a partial line is not read yet');
  fs.appendFileSync(r5.file, `${line.slice(40)}\n`);
  s = await ar.summary({ hours: 24, now: NOW });
  v5 = runOf(byFolder(s, 'partner'), r5);
  assert.strictEqual(v5.tokens, 2 * FRESH + 16, 'the completed line is read once');
  s = await ar.summary({ hours: 24, now: NOW });
  assert.strictEqual(runOf(byFolder(s, 'partner'), r5).tokens, 2 * FRESH + 16);

  // A rewritten (shorter) file is read again from the start.
  fs.writeFileSync(r2.file, `${JSON.stringify(r2.lines[0])}\n`);
  const t = new Date(NOW - 570 * 60000);
  fs.utimesSync(r2.file, t, t);
  s = await ar.summary({ hours: 24, now: NOW });
  const v2 = runOf(byFolder(s, 'partner'), r2);
  assert.deepStrictEqual([v2.status, v2.reason, v2.tokens], ['failed', 'no_reply', 0], 'a prompt Claude never answered');

  // A removed transcript drops out.
  fs.rmSync(r9.file);
  s = await ar.summary({ hours: 24, now: NOW });
  assert.ok(!runOf(byFolder(s, 'other-tool'), r9), 'a deleted run is forgotten');
}

// ---- Edge cases, in their own projects folder so the counts above stay as they are ----
const edgeProjects = path.join(isolatedHome, 'edge-projects');

function findRun(s, r) {
  for (const g of s.groups) {
    const v = runOf(g, r);
    if (v) return v;
  }
  return null;
}

async function testEdgeCases() {
  const E = 'C:\\Repo\\edge';
  const W = 'C:\\Repo\\edge-window';
  const queued = (minAgo, content) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: at(minAgo), sessionId: 'x', content });
  const touch = (file, minAgo) => {
    const t = new Date(NOW - minAgo * 60000);
    fs.utimesSync(file, t, t);
  };

  // 1. A piped prompt larger than the first read, written twice (queued, then as the message)
  // before the first entry that names the entrypoint.
  const BIG = `Review this diff:\n${'+ a changed line\n'.repeat(20 * 1024)}`;
  const big = run(E, 'sdk-cli').raw(queued(30, BIG)).prompt(30, BIG).assistant(29, { text: 'Reviewed.' }).write(29, edgeProjects);
  // More than one scan's worth of records before the first message.
  const filler = 'z'.repeat(1536 * 1024);
  const late = run(E, 'sdk-ts').raw(queued(28, filler)).raw(queued(28, filler)).raw(queued(28, filler)).prompt(28, 'After the filler').assistant(27, { text: 'ok' }).write(27, edgeProjects);
  // Nothing that names it yet.
  const growing = run(E, 'sdk-cli').raw(queued(26, 'q'.repeat(200 * 1024))).write(26, edgeProjects);

  // 2. Quiet main transcripts: one waiting on a sub-agent, one whose sub-agent stopped long ago,
  // one in a long Bash command.
  const subagent = (r, minAgo) => {
    const dir = path.join(path.dirname(r.file), r.sessionId, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'agent-a1.jsonl');
    fs.writeFileSync(file, '{}\n');
    touch(file, minAgo);
  };
  const viaSub = run(E, 'sdk-cli').prompt(40, 'Fan out').assistant(30, { stop: 'tool_use', tool: 'Task' }).write(30, edgeProjects);
  subagent(viaSub, 2);
  const deadSub = run(E, 'sdk-cli').prompt(90, 'Fan out').assistant(80, { stop: 'tool_use', tool: 'Task' }).write(80, edgeProjects);
  subagent(deadSub, 60);
  const quiet = run(E, 'sdk-cli').prompt(20, 'Long test run').assistant(15, { stop: 'tool_use', tool: 'Bash' }).write(15, edgeProjects);

  // 3. The window is the chart's hours: one run began before it and finished inside it, one
  // ended just before it.
  const firstHour = hourFloor(NOW) - 23 * HOUR;
  const ago = (ms) => (NOW - ms) / 60000;
  const straddle = run(W, 'sdk-cli')
    .prompt(ago(firstHour - 40 * 60000), 'Overnight job')
    .assistant(ago(firstHour - 30 * 60000), { stop: 'tool_use', tool: 'Bash' })
    .toolResult(ago(firstHour - 29 * 60000))
    .assistant(ago(firstHour + 10 * 60000), { text: 'Done.' })
    .write(ago(firstHour + 10 * 60000), edgeProjects);
  const before = run(W, 'sdk-cli').prompt(ago(firstHour - 20 * 60000), 'Earlier').assistant(ago(firstHour - 15 * 60000), { text: 'ok' }).write(ago(firstHour - 15 * 60000), edgeProjects);

  // 4. Prompts that start with a tag, and Claude Code's own tags.
  const xml = run(E, 'sdk-ts').prompt(100, '<task>Fix the flaky spec</task>').assistant(99, { text: 'Fixed.' }).write(99, edgeProjects);
  const harness = run(E, 'sdk-cli').prompt(91, '<command-name>/clear</command-name>').prompt(90, 'Real prompt').assistant(89, { text: 'ok' }).write(89, edgeProjects);
  const followUp = run(E, 'sdk-ts').prompt(80, 'First step').assistant(79, { text: 'Done.' }).prompt(78, '<instructions>Now the next step</instructions>').write(78, edgeProjects);

  // 5. Replies that stopped on other stop reasons.
  const maxTok = run(E, 'sdk-cli').prompt(70, 'Write it all').assistant(69, { stop: 'max_tokens', text: 'Here is the first half' }).write(69, edgeProjects);
  const refused = run(E, 'sdk-cli').prompt(68, 'Do it').assistant(67, { stop: 'refusal' }).write(67, edgeProjects);
  const full = run(E, 'sdk-cli').prompt(66, 'Read everything').assistant(65, { stop: 'model_context_window_exceeded' }).write(65, edgeProjects);
  const maxTokNow = run(E, 'sdk-cli').prompt(3, 'Write it all').assistant(2, { stop: 'max_tokens', text: 'Half' }).write(2, edgeProjects);

  const ar = new AutomatedRuns({ projectsDir: edgeProjects, rescanMinMs: 0 });
  let s = await ar.summary({ hours: 24, now: NOW });

  const vBig = findRun(s, big);
  assert.ok(vBig, 'a run whose prompt is larger than the first read is found');
  assert.strictEqual(vBig.status, 'ok');
  assert.ok(vBig.firstPrompt.startsWith('Review this diff'), vBig.firstPrompt);
  assert.ok(!findRun(s, late), 'one scan reads at most a few MB looking for the entrypoint');
  assert.ok(!findRun(s, growing), 'a transcript that names nothing yet is not a run yet');
  growing.prompt(25, 'Now the prompt').assistant(24, { text: 'Done.' }).write(24, edgeProjects);
  s = await ar.summary({ hours: 24, now: NOW });
  assert.strictEqual((findRun(s, late) || {}).status, 'ok', 'the next scan carries on where the last one stopped');
  assert.strictEqual((findRun(s, growing) || {}).firstPrompt, 'Now the prompt', 'it is asked again once it grows');

  assert.strictEqual(findRun(s, viaSub).status, 'running', 'a sub-agent still writing keeps its run alive');
  assert.deepStrictEqual([findRun(s, deadSub).status, findRun(s, deadSub).reason], ['failed', 'cut_off']);
  assert.strictEqual(findRun(s, quiet).status, 'running', '15 quiet minutes (a long Bash command) are not a failure');

  const w = byFolder(s, 'edge-window');
  assert.strictEqual(s.windowStart, new Date(firstHour).toISOString(), 'the window starts with the first bar');
  assert.ok(!findRun(s, before), 'a run that ended before the window is left out');
  assert.strictEqual(w.runs, 1);
  assert.strictEqual(w.hourly[0].runs, 1, 'a run that began before the window counts in the first bar');
  assert.strictEqual(w.tokens, FRESH, 'tokens spent before the window are not counted');
  assert.strictEqual(findRun(s, straddle).tokens, 2 * FRESH, 'the run row still shows all it used');
  for (const g of s.groups) {
    assert.strictEqual(g.hourly.reduce((n, h) => n + h.runs, 0), g.runs, `${g.folder}: bars add up to the run count`);
    assert.strictEqual(g.hourly.reduce((n, h) => n + h.failed, 0), g.failed, `${g.folder}: and to the failures`);
    assert.strictEqual(g.hourly.reduce((n, h) => n + h.tokens, 0), g.tokens, `${g.folder}: and to the tokens`);
  }
  assert.strictEqual(s.totals.tokens, s.groups.reduce((n, g) => n + g.tokens, 0));

  assert.strictEqual(findRun(s, xml).firstPrompt, '<task>Fix the flaky spec</task>', 'a prompt that starts with a tag is still the prompt');
  assert.strictEqual(findRun(s, harness).firstPrompt, 'Real prompt', "Claude Code's own tags are not the prompt");
  assert.deepStrictEqual([findRun(s, followUp).status, findRun(s, followUp).reason], ['failed', 'cut_off'], 'a tagged follow-up Claude never answered is not a finished run');

  const vMax = findRun(s, maxTok);
  assert.deepStrictEqual([vMax.status, vMax.reason, vMax.detail], ['failed', 'max_tokens', 'Here is the first half']);
  assert.deepStrictEqual([findRun(s, refused).status, findRun(s, refused).reason], ['failed', 'refusal']);
  assert.deepStrictEqual([findRun(s, full).status, findRun(s, full).reason], ['failed', 'context_full']);
  assert.strictEqual(findRun(s, maxTokNow).status, 'running', 'a stop Claude Code may still follow up is not judged yet');
}

async function testConcurrentAndYielding() {
  const ar = new AutomatedRuns({ rescanMinMs: 0 });
  let ticked = false;
  const a = ar.summary({ hours: 24 });
  const b = ar.summary({ hours: 24 });
  setImmediate(() => {
    ticked = true;
  });
  const [x, y] = await Promise.all([a, b]);
  assert.ok(ticked, 'the event loop keeps turning during a cold scan');
  assert.strictEqual(x.scan, y.scan, 'two requests during one scan share it');
  assert.ok(x.scan.filesRead >= 8 && x.scan.bytesRead > 4 * 1024 * 1024, JSON.stringify(x.scan));

  const quick = new AutomatedRuns(); // the server's default: a scan is reused for a few seconds
  await quick.summary({ hours: 24 });
  const again = await quick.summary({ hours: 24 });
  assert.strictEqual(again.scan.reused, true);
  const wider = await quick.summary({ hours: 72 });
  assert.ok(!wider.scan.reused, 'a wider window scans again');
}

function request(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode, json });
        });
      })
      .on('error', reject);
  });
}

async function testApi() {
  const dataDir = path.join(isolatedHome, 'data');
  const { server } = createMissionControlServer({
    dataDir,
    token: TOKEN,
    disableScanner: true,
    offlineFile: path.join(dataDir, 'offline-events.jsonl'),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const auth = { 'X-AMC-Token': TOKEN };
  try {
    assert.strictEqual((await request(port, '/api/automated')).status, 401, 'the token is required');
    const ok = await request(port, '/api/automated?hours=24', auth);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.json.ok, true);
    assert.strictEqual(ok.json.windowHours, 24);
    assert.ok(ok.json.generatedAt && ok.json.totals && Array.isArray(ok.json.groups));
    const g = ok.json.groups.find((x) => x.folder === 'partner');
    assert.ok(g && Array.isArray(g.hourly) && g.hourly.length === 24 && Array.isArray(g.recent));
    for (const key of ['key', 'folder', 'cwd', 'runs', 'failed', 'tokens', 'lastRunAt', 'longestIdleMinutes']) assert.ok(key in g, `group has ${key}`);
    for (const key of ['hourStart', 'runs', 'tokens', 'failed']) assert.ok(key in g.hourly[0], `hour has ${key}`);
    assert.ok(!JSON.stringify(ok.json).includes('.jsonl'), 'transcript paths are not exposed');
    assert.strictEqual((await request(port, '/api/automated', auth)).json.windowHours, 24, '24 h by default');
    assert.strictEqual((await request(port, '/api/automated?hours=168', auth)).json.windowHours, 168);
    for (const bad of ['0', '169', '2.5', 'abc', '-1', '1e3']) {
      assert.strictEqual((await request(port, `/api/automated?hours=${bad}`, auth)).status, 400, `hours=${bad} is refused`);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function main() {
  assert.ok(RUNNING_GRACE_MS > 10 * 60000, "longer than the Bash tool's 10-minute limit");
  const ar = new AutomatedRuns({ rescanMinMs: 0 });
  await testSummary(ar);
  await testCacheAndAppend(ar);
  await testEdgeCases();
  await testConcurrentAndYielding();
  await testApi();
  console.log('✅ Automated runs checks passed!');
}

main()
  .catch((err) => {
    console.error('❌ Automated runs checks failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(isolatedHome, { recursive: true, force: true });
    } catch {}
  });
