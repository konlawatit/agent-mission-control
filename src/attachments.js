/**
 * Files and images attached from the dashboard composer.
 *
 * The browser uploads each file once; it is stored under the Mission Control data folder (never in
 * the user's repository, so `git status` stays clean) and the message sent to Claude carries the
 * absolute path, which Claude then reads (the Read tool opens images too).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

/**
 * A name that is safe on every filesystem and in a terminal line: ASCII letters, digits, `.`, `_`,
 * `-`, with the (lower-cased) extension kept. The client's name is only a hint, never a path.
 */
function safeFileName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  const rawExt = path.extname(base);
  const ext = rawExt.toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
  const stem = base
    .slice(0, base.length - rawExt.length)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 60);
  return `${stem || 'file'}${ext.length > 1 ? ext : ''}`;
}

function attachmentsRoot(dataDir) {
  return path.join(dataDir, 'attachments');
}

function roomFolder(dataDir, sessionId) {
  const room = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'room';
  return path.join(attachmentsRoot(dataDir), room);
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Streams a request body into the room's attachment folder. Rejects (status 413) past `maxBytes`
 * and leaves nothing behind on failure. Resolves to { path, name, size }.
 */
function saveAttachment(req, { dataDir, sessionId, name, maxBytes = MAX_ATTACHMENT_BYTES }) {
  return new Promise((resolve, reject) => {
    const dir = roomFolder(dataDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `${stamp()}-${crypto.randomBytes(3).toString('hex')}-${safeFileName(name)}`;
    const finalPath = path.join(dir, fileName);
    const partPath = `${finalPath}.part`;
    const out = fs.createWriteStream(partPath, { flags: 'wx' });
    let size = 0;
    let failed = false;

    const fail = (err) => {
      if (failed) return;
      failed = true;
      req.unpipe(out);
      req.resume();
      out.destroy();
      fs.rm(partPath, { force: true }, () => reject(err));
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('Attachment too large');
        err.statusCode = 413;
        fail(err);
      }
    });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (failed) return;
      if (size === 0) {
        const err = new Error('Empty attachment');
        err.statusCode = 400;
        fs.rm(partPath, { force: true }, () => reject(err));
        return;
      }
      fs.rename(partPath, finalPath, (err) => {
        if (err) return fail(err);
        resolve({ path: finalPath, name: fileName, size });
      });
    });
    req.pipe(out);
  });
}

/** Deletes attachments older than `maxAgeMs` (best effort; run at start-up). */
function pruneAttachments(dataDir, maxAgeMs = ATTACHMENT_MAX_AGE_MS) {
  const root = attachmentsRoot(dataDir);
  let rooms = [];
  try {
    rooms = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const room of rooms) {
    const dir = path.join(root, room.name);
    try {
      for (const f of fs.readdirSync(dir)) {
        const file = path.join(dir, f);
        const st = fs.statSync(file);
        if (st.isFile() && st.mtimeMs < cutoff) {
          fs.rmSync(file, { force: true });
          removed += 1;
        }
      }
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } catch {
      // another process may be using the folder; try again next start
    }
  }
  return removed;
}

module.exports = {
  MAX_ATTACHMENT_BYTES,
  safeFileName,
  saveAttachment,
  pruneAttachments,
};
