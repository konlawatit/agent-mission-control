/**
 * Search across every session (roadmap 2): the background index over ~/.claude/projects and
 * GET /api/search. Transcripts here have the shape Claude Code writes today: conversation lines
 * between multi-megabyte bookkeeping records, tool results and harness messages.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-search-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
const { SearchIndex, snippetFor } = require('../src/search-index');
const { encodeProjectDir, readConversationPage, entryEndOffset } = require('../src/transcript-parser');
const { createMissionControlServer } = require('../src/server');

const projectsDir = path.join(isolatedHome, '.claude', 'projects');
const SID_PERSON = 'aaaaaaaa-1111-4111-8111-000000000001';
const SID_AUTO = 'bbbbbbbb-2222-4222-8222-000000000002';
const SID_OLD = 'cccccccc-3333-4333-8333-000000000003';
const SID_BIG = 'dddddddd-4444-4444-8444-000000000004';
const CWD = 'C:\\Repo\\client-portal-api';
const CWD_AUTO = 'C:\\Repo\\e2e-forge\\.worktrees\\partner';

let clock = Date.parse('2026-11-20T08:00:00.000Z');
const ts = () => new Date((clock += 1000)).toISOString();
// Real lines start with parentUuid, so the type is only known after parsing.
const base = (sessionId, cwd, entrypoint) => ({ parentUuid: null, isSidechain: false, cwd, sessionId, entrypoint });
const userLine = (ctx, content, extra = {}) => ({ ...base(...ctx), type: 'user', timestamp: ts(), message: { role: 'user', content }, ...extra });
const assistantLine = (ctx, blocks) => ({ ...base(...ctx), type: 'assistant', timestamp: ts(), message: { role: 'assistant', model: 'claude-opus-5-5', content: blocks } });
const text = (t) => ({ type: 'text', text: t });
const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2)}`, name, input });
// A request copy as Claude Code stores it: megabytes, type first. Holds a word found nowhere else.
const blob = (sessionId, mb) => ({
  type: 'api-request-blob',
  sessionId,
  message: { role: 'user', content: [text(`blobonlyterm webhook ${'x'.repeat(mb * 1024 * 1024)}`)] },
});

function projectFile(cwd, sessionId) {
  const dir = path.join(projectsDir, encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.jsonl`);
}
const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** Byte offset of the first line containing `needle` (to check what the index reports). */
function offsetOfLine(file, needle) {
  const buf = fs.readFileSync(file);
  let pos = 0;
  while (pos < buf.length) {
    let nl = buf.indexOf(10, pos);
    if (nl === -1) nl = buf.length;
    if (buf.toString('utf8', pos, nl).includes(needle)) return pos;
    pos = nl + 1;
  }
  return -1;
}

// ---- Fixture transcripts ----
const P = [SID_PERSON, CWD, 'cli'];
const personFile = projectFile(CWD, SID_PERSON);
fs.writeFileSync(
  personFile,
  jsonl([
    { type: 'permission-mode', permissionMode: 'default', sessionId: SID_PERSON },
    userLine(P, 'หา session ที่ทำเกี่ยวกับ webhook กับ Venio ให้หน่อย'),
    blob(SID_PERSON, 3), // spans several 1 MB reads
    assistantLine(P, [text('เจอแล้วครับ ต้องตรวจสอบราคาใน `VenioWebhookController` ก่อน'), toolUse('Read', { file_path: 'src/Webhooks/VenioWebhookController.cs' })]),
    userLine(P, [{ type: 'tool_result', tool_use_id: 'x', content: 'toolresultonlyterm webhook body' }], { toolUseResult: { stdout: 'toolresultonlyterm' } }),
    userLine(P, 'Base directory for this skill: metaonlyterm', { isMeta: true }),
    userLine(P, '<command-name>/clear</command-name> commandonlyterm'),
    { type: 'user', timestamp: ts(), cwd: CWD, sessionId: SID_PERSON, message: { role: 'user', content: 'Refresh Token ด้วย RefreshTokenService' } }, // type first
    assistantLine(P, [text('ปรับ RefreshTokenService แล้ว รัน test ผ่าน 14 รายการ')]),
    userLine(P, '[Request interrupted by user]'),
    blob(SID_PERSON, 1),
    assistantLine(P, [text('สรุป: webhook ของ Venio ตรวจสอบราคาครบแล้ว')]),
  ])
);
const A = [SID_AUTO, CWD_AUTO, 'sdk-cli'];
const autoFile = projectFile(CWD_AUTO, SID_AUTO);
fs.writeFileSync(
  autoFile,
  jsonl([userLine(A, 'Generate an e2e spec for the webhook settings page'), assistantLine(A, [text('Spec written for webhook settings.'), toolUse('Write', { file_path: 'tests/e2e/webhook.spec.ts' })])])
);
const oldFile = projectFile('C:\\Repo\\legacy', SID_OLD);
fs.writeFileSync(oldFile, jsonl([userLine([SID_OLD, 'C:\\Repo\\legacy', 'cli'], 'old webhook notes')]));
fs.utimesSync(oldFile, new Date('2026-01-01'), new Date('2026-01-01'));
// Never indexed: a sub-agent transcript (cannot be opened by id), a file not named like a session.
const subDir = path.join(path.dirname(personFile), SID_PERSON, 'subagents');
fs.mkdirSync(subDir, { recursive: true });
fs.writeFileSync(path.join(subDir, 'agent-1.jsonl'), jsonl([userLine(P, 'subagentonlyterm')]));
fs.writeFileSync(path.join(path.dirname(personFile), 'notes.jsonl'), jsonl([userLine(P, 'notesonlyterm')]));
fs.writeFileSync(path.join(isolatedHome, `${SID_PERSON}.jsonl`), jsonl([userLine(P, 'outsideonlyterm')]));

const ids = (r) => r.results.map((x) => x.sessionId).sort();

(async () => {
  // 1. Build, then find Thai and English, case-insensitively, by scope.
  {
    const idx = new SearchIndex({ projectsDir });
    await idx.scanNow();
    const st = idx.status();
    assert.strictEqual(st.done, true, 'first build finished');
    assert.strictEqual(st.total, 3, `only session files directly in a project folder count (${st.total})`);
    assert.strictEqual(st.files, 3);

    assert.deepStrictEqual(ids(idx.search('webhook', { scope: 'all' })), [SID_PERSON, SID_AUTO, SID_OLD].sort());
    assert.deepStrictEqual(ids(idx.search('WEBHOOK', { scope: 'all' })), [SID_PERSON, SID_AUTO, SID_OLD].sort(), 'case-insensitive');
    assert.deepStrictEqual(ids(idx.search('webhook', { scope: 'people' })), [SID_PERSON, SID_OLD].sort(), 'people: no sdk-* runs');
    assert.deepStrictEqual(ids(idx.search('webhook', { scope: 'automated' })), [SID_AUTO], 'automated: sdk-* runs only');

    const thai = idx.search('ตรวจสอบราคา', { scope: 'people' });
    assert.deepStrictEqual(ids(thai), [SID_PERSON], 'Thai substring, no word splitting');
    const hit = thai.results[0];
    assert.strictEqual(hit.matchCount, 2);
    assert.strictEqual(hit.title, 'หา session ที่ทำเกี่ยวกับ webhook กับ Venio ให้หน่อย', 'title is the first human prompt');
    assert.strictEqual(hit.project, 'client-portal-api');
    assert.strictEqual(hit.cwd, CWD);
    assert.strictEqual(hit.entrypoint, 'cli');
    assert.ok(hit.startedAt && hit.modifiedAt, 'dates are reported');
    for (const s of hit.snippets) {
      assert.strictEqual(s.text.slice(s.hl[0], s.hl[0] + s.hl[1]), 'ตรวจสอบราคา', `hl marks the match in "${s.text}"`);
    }

    // The match is ranked by recency first: the January session comes last.
    const all = idx.search('webhook', { scope: 'all' }).results.map((r) => r.sessionId);
    assert.strictEqual(all[all.length - 1], SID_OLD, 'older sessions rank lower');

    // Tool lines and type-first user lines are searchable; the person's text keeps its case.
    assert.deepStrictEqual(ids(idx.search('VenioWebhookController.cs', { scope: 'all' })), [SID_PERSON]);
    const tool = idx.search('VenioWebhookController.cs', { scope: 'all' }).results[0].snippets.find((s) => s.role === 't');
    assert.ok(tool && tool.text.startsWith('Read '), `tool line snippet: ${tool && tool.text}`);
    assert.deepStrictEqual(ids(idx.search('refresh token', { scope: 'all' })), [SID_PERSON]);
    assert.ok(idx.search('refresh token', { scope: 'all' }).results[0].snippets[0].text.includes('Refresh Token'));

    // 2. Bookkeeping, tool results, harness messages, sub-agents and other files are never indexed.
    for (const term of ['blobonlyterm', 'xxxxxxxxxx', 'toolresultonlyterm', 'metaonlyterm', 'commandonlyterm', 'Request interrupted', 'subagentonlyterm', 'notesonlyterm', 'outsideonlyterm']) {
      assert.strictEqual(idx.search(term, { scope: 'all' }).total, 0, `"${term}" is not searchable`);
    }
    assert.ok(st.chars < 2000, `megabyte blobs add nothing to the index (${st.chars} chars)`);

    // 3. A snippet's offset is its transcript entry: the viewer's page ending there shows it.
    const r = idx.search('ปรับ RefreshTokenService', { scope: 'all' }).results[0];
    const off = r.snippets[0].offset;
    assert.strictEqual(off, offsetOfLine(personFile, 'ปรับ RefreshTokenService'), 'offset is the start of the entry line');
    const page = readConversationPage(personFile, { before: entryEndOffset(personFile, off), limit: 3 });
    assert.ok(page.lines[page.lines.length - 1].includes('ปรับ RefreshTokenService'), `page ends at the match: ${page.lines.slice(-1)}`);
    for (const s of idx.search('webhook', { scope: 'all' }).results.flatMap((x) => x.snippets.map((sn) => ({ ...sn, sid: x.sessionId })))) {
      const file = s.sid === SID_PERSON ? personFile : s.sid === SID_AUTO ? autoFile : oldFile;
      const last = readConversationPage(file, { before: entryEndOffset(file, s.offset), limit: 1 }).lines.slice(-3).join('\n');
      assert.ok(/webhook/i.test(last), `entry at ${s.offset} holds the match`);
    }

    // 4. Appending: only the new bytes are read, a half-written line waits for its newline.
    const linesBefore = idx.status().lines;
    const countBefore = idx.search('webhook', { scope: 'all' }).results.find((x) => x.sessionId === SID_PERSON).matchCount;
    fs.appendFileSync(personFile, jsonl([userLine(P, 'เพิ่ม appendedterm ทีหลัง')]));
    const partial = JSON.stringify(assistantLine(P, [text('ยังเขียนไม่จบ partialterm')]));
    fs.appendFileSync(personFile, partial.slice(0, 40));
    await idx.scanNow();
    assert.deepStrictEqual(ids(idx.search('appendedterm', { scope: 'all' })), [SID_PERSON], 'appended prompt found');
    assert.strictEqual(idx.status().lines, linesBefore + 1, 'nothing was indexed twice');
    assert.strictEqual(idx.search('webhook', { scope: 'all' }).results.find((x) => x.sessionId === SID_PERSON).matchCount, countBefore);
    assert.strictEqual(idx.search('partialterm', { scope: 'all' }).total, 0, 'a line still being written is not read yet');
    fs.appendFileSync(personFile, partial.slice(40) + '\n');
    await idx.scanNow();
    const done = idx.search('partialterm', { scope: 'all' });
    assert.deepStrictEqual(ids(done), [SID_PERSON], 'completed line found');
    assert.strictEqual(done.results[0].snippets[0].offset, offsetOfLine(personFile, 'partialterm'));

    // 5. A rewritten (shorter) file is read again from the start; a deleted one disappears.
    fs.writeFileSync(autoFile, jsonl([userLine(A, 'rewrittenterm only')]));
    await idx.scanNow();
    assert.deepStrictEqual(ids(idx.search('rewrittenterm', { scope: 'all' })), [SID_AUTO]);
    assert.deepStrictEqual(ids(idx.search('webhook', { scope: 'automated' })), [], 'old content of the rewritten file is gone');
    fs.renameSync(oldFile, oldFile + '.bak');
    await idx.scanNow();
    assert.ok(!ids(idx.search('webhook', { scope: 'all' })).includes(SID_OLD), 'a deleted transcript leaves the index');
    fs.renameSync(oldFile + '.bak', oldFile);
    idx.stop();
  }

  // 6. Memory budget: newest sessions are indexed first, older ones give way.
  {
    const idx = new SearchIndex({ projectsDir, maxTotalChars: 200 });
    await idx.scanNow();
    const st = idx.status();
    assert.ok(st.skipped >= 1, `over budget some sessions are left out (${JSON.stringify(st)})`);
    assert.strictEqual(idx.search('webhook', { scope: 'all' }).results.some((r) => r.sessionId === SID_OLD), false, 'the oldest session is the one left out');
    idx.stop();
  }

  // 7. The event loop keeps turning while a large transcript is indexed.
  {
    const bigProjects = path.join(isolatedHome, 'big-projects');
    const dir = path.join(bigProjects, 'C--Repo-big');
    fs.mkdirSync(dir, { recursive: true });
    const B = [SID_BIG, 'C:\\Repo\\big', 'cli'];
    const fd = fs.openSync(path.join(dir, `${SID_BIG}.jsonl`), 'w');
    const para = 'ตรวจสอบการคำนวณราคา proration และ webhook ของ Venio อีกครั้ง '.repeat(12);
    for (let i = 0; i < 25; i++) {
      const rows = [];
      for (let j = 0; j < 1000; j++) rows.push(assistantLine(B, [text(`${i}-${j} ${para}`), toolUse('Bash', { command: `dotnet test --filter Case${j}` })]));
      fs.writeSync(fd, jsonl(rows));
    }
    fs.closeSync(fd);

    // One read for the whole file, so only the time slicing can keep the loop responsive.
    const idx = new SearchIndex({ projectsDir: bigProjects, chunkBytes: 256 * 1024 * 1024 });
    let immediates = 0;
    let maxLag = 0;
    let running = true;
    const spin = () => {
      immediates += 1;
      if (running) setImmediate(spin);
    };
    setImmediate(spin);
    const lagLoop = () => {
      const t = performance.now();
      setTimeout(() => {
        maxLag = Math.max(maxLag, performance.now() - t - 5);
        if (running) lagLoop();
      }, 5);
    };
    lagLoop();
    const t0 = performance.now();
    await idx.scanNow();
    const buildMs = performance.now() - t0;
    running = false;
    const st = idx.status();
    assert.strictEqual(st.lines, 50000, `every reply and tool line indexed (${st.lines})`);
    assert.ok(buildMs > 100, `the fixture is big enough to matter (${buildMs.toFixed(0)} ms)`);
    assert.ok(immediates > 20, `setImmediate callbacks kept running during the build (${immediates})`);
    assert.ok(maxLag < 80, `timers stayed on time while building (worst lag ${maxLag.toFixed(1)} ms over ${buildMs.toFixed(0)} ms)`);
    const r = idx.search('Case999', { scope: 'all' });
    assert.strictEqual(r.results[0].matchCount, 25);
    assert.ok(r.tookMs < 200, `search is fast (${r.tookMs} ms)`);
    idx.stop();
  }

  // 8. Snippets: whitespace collapsed, ellipses where text was cut, the match marked.
  {
    const s = snippetFor(`${'a'.repeat(200)} needle\n\n  after ${'b'.repeat(200)}`, 201, 6);
    assert.ok(s.text.startsWith('…') && s.text.endsWith('…'));
    assert.strictEqual(s.text.slice(s.hl[0], s.hl[0] + s.hl[1]), 'needle');
    assert.ok(!/\s{2}/.test(s.text), 'whitespace collapsed');
    const prose = snippetFor('บันทึกลง `WebhookDeliveries` แบบ **ถาวร**', 10, 7, { plain: true });
    assert.strictEqual(prose.text, 'บันทึกลง WebhookDeliveries แบบ ถาวร', 'Markdown markers dropped from prose');
    assert.strictEqual(prose.text.slice(prose.hl[0], prose.hl[0] + prose.hl[1]), 'Webhook');
    const cmd = snippetFor('grep `which node`', 0, 4);
    assert.strictEqual(cmd.text, 'grep `which node`', 'commands keep their backticks');
  }

  // 9. Over HTTP: token, parameter checks, results and the viewer opening at a snippet.
  {
    const dataDir = fs.mkdtempSync(path.join(isolatedHome, 'srv-'));
    const token = 'c'.repeat(48);
    const { server, searchIndex } = createMissionControlServer({ dataDir, token, disableScanner: true, offlineFile: path.join(dataDir, 'off.jsonl') });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const get = (p, withToken = true) =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: p, agent: false, headers: withToken ? { 'X-AMC-Token': token } : {} }, (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (raw += c));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        });
        req.on('error', reject);
        req.end();
      });
    const q = (s) => encodeURIComponent(s);
    try {
      assert.strictEqual((await get(`/api/search?q=webhook`, false)).status, 401, 'token required');
      assert.strictEqual(searchIndex.started, false, 'tests and fixtures build only when searched');
      for (const bad of ['q=w', `q=${q('ก'.repeat(201))}`,'q=webhook&scope=everything', 'q=webhook&limit=0', 'q=webhook&limit=51', 'q=webhook&limit=abc', `q=${q('web\u0000hook')}`]) {
        assert.strictEqual((await get(`/api/search?${bad}`)).status, 400, `rejected: ${bad.slice(0, 40)}`);
      }
      const first = await get(`/api/search?q=webhook`);
      assert.strictEqual(first.status, 200);
      assert.ok(first.body.indexing && typeof first.body.indexing.done === 'boolean', 'indexing state is reported');
      assert.strictEqual(searchIndex.started, true, 'the first search starts the build');
      await searchIndex.scanNow();
      const res = await get(`/api/search?q=${q('ตรวจสอบราคา')}&limit=5`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.indexing.done, true);
      assert.strictEqual(res.body.scope, 'people', 'people is the default scope');
      assert.deepStrictEqual(res.body.results.map((r) => r.sessionId), [SID_PERSON]);
      const auto = await get(`/api/search?q=rewrittenterm&scope=automated`);
      assert.deepStrictEqual(auto.body.results.map((r) => r.sessionId), [SID_AUTO]);
      const status = await get('/api/search/status');
      assert.strictEqual(status.body.indexing.files, 3);

      const snip = res.body.results[0].snippets[res.body.results[0].snippets.length - 1];
      const page = await get(`/api/transcript?sessionId=${SID_PERSON}&at=${snip.offset}&limit=4`);
      assert.strictEqual(page.status, 200);
      assert.ok(page.body.lines[page.body.lines.length - 1].includes('ตรวจสอบราคา'), 'the viewer opens at the matching entry');
    } finally {
      await new Promise((r) => server.close(r));
    }
    assert.strictEqual(searchIndex.stopped, true, 'closing the server stops the index');
  }

  console.log('✅ Search index checks passed!');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
