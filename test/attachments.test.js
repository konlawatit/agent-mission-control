/**
 * Composer attachments: upload over HTTP, stored only inside the data folder, bounded, pruned.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-home-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
const { createMissionControlServer } = require('../src/server');
const { safeFileName, saveAttachment, pruneAttachments } = require('../src/attachments');

const TOKEN = 'a'.repeat(48);

function request(port, { method = 'POST', urlPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
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
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const filesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

(async () => {
  // 1. File names are reduced to a safe ASCII name; the client's path is never used.
  assert.strictEqual(safeFileName('../../evil.ps1'), 'evil.ps1');
  assert.strictEqual(safeFileName('C:\\Users\\x\\รูป หน้าจอ.PNG'), 'file.png');
  assert.strictEqual(safeFileName('report final (2).pdf'), 'report-final-2.pdf');
  assert.strictEqual(safeFileName(''), 'file');

  // 2. Over the size limit: rejected, and no partial file is left behind.
  const dataDir = fs.mkdtempSync(path.join(isolatedHome, 'data-'));
  await assert.rejects(
    saveAttachment(Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), { dataDir, sessionId: 'r1', name: 'big.bin', maxBytes: 10 }),
    (err) => err.statusCode === 413
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(filesIn(path.join(dataDir, 'attachments', 'r1')), [], 'nothing kept from a rejected upload');

  // 3. Old attachments are pruned.
  const old = await saveAttachment(Readable.from([Buffer.from('old')]), { dataDir, sessionId: 'r1', name: 'old.txt' });
  const past = (Date.now() - 20 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(old.path, past, past);
  const fresh = await saveAttachment(Readable.from([Buffer.from('new')]), { dataDir, sessionId: 'r1', name: 'new.txt' });
  assert.strictEqual(pruneAttachments(dataDir), 1);
  assert.ok(!fs.existsSync(old.path) && fs.existsSync(fresh.path), 'only the old file is removed');

  // 4. Over HTTP: token, content type, a known room; stored under the data folder only.
  const serverDir = fs.mkdtempSync(path.join(isolatedHome, 'server-'));
  const { server, store } = createMissionControlServer({ dataDir: serverDir, token: TOKEN, disableScanner: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const roomCwd = fs.mkdtempSync(path.join(isolatedHome, 'room-'));
    const room = store.getOrCreateSession('attach-room', { cwd: roomCwd }).id;
    const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
    const url = (name, id = room) => `/api/session/attachment?sessionId=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`;
    const octet = { 'X-AMC-Token': TOKEN, 'Content-Type': 'application/octet-stream' };

    let res = await request(port, { urlPath: url('a.png'), headers: { 'Content-Type': 'application/octet-stream' }, body: png });
    assert.strictEqual(res.status, 401, 'the token is required');
    res = await request(port, { urlPath: url('a.png'), headers: { 'X-AMC-Token': TOKEN, 'Content-Type': 'multipart/form-data' }, body: png });
    assert.strictEqual(res.status, 415, 'only application/octet-stream (forces a CORS preflight)');
    res = await request(port, { urlPath: url('a.png', 'no-such-room'), headers: octet, body: png });
    assert.strictEqual(res.status, 404, 'unknown rooms are refused');
    res = await request(port, { urlPath: url('x.png'), headers: { ...octet, 'Content-Length': String(21 * 1024 * 1024) } });
    assert.strictEqual(res.status, 413, 'a declared size over 20 MB is refused before reading');

    res = await request(port, { urlPath: url('../../../evil.png'), headers: octet, body: png });
    assert.strictEqual(res.status, 200);
    const saved = res.json.path;
    const root = path.join(serverDir, 'attachments') + path.sep;
    assert.ok(saved.startsWith(root), `stored under the data folder: ${saved}`);
    assert.ok(saved.endsWith('-evil.png') && !saved.includes('..'), 'the name cannot climb out');
    assert.ok(fs.readFileSync(saved).equals(png), 'content intact');
    assert.strictEqual(res.json.size, png.length);
    assert.ok(!saved.startsWith(roomCwd), "never inside the room's repository");
  } finally {
    server.close();
    store.flush();
  }

  console.log('✅ Attachment checks passed!');
})().catch((err) => {
  console.error('❌ Attachment checks failed:', err);
  process.exit(1);
});
