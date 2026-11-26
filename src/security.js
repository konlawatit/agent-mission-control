const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.agent-mission-control');
const DEFAULT_TOKEN_FILE = path.join(DATA_DIR, 'token');
const TOKEN_HEADER = 'x-amc-token';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Returns the per-install API token, creating it on first use.
 * The token lives in the user's home directory so the Claude hook and the CLI can read it,
 * while web pages opened in the browser cannot.
 */
function loadOrCreateToken(tokenFile = DEFAULT_TOKEN_FILE) {
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (/^[a-f0-9]{32,}$/.test(existing)) return existing;
  } catch {}

  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, token, { encoding: 'utf8', mode: 0o600 });
  return token;
}

/** Reads the token without creating it (for clients such as the hook and `amc status`). */
function readToken(tokenFile = DEFAULT_TOKEN_FILE) {
  try {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * The token written into ~/.claude/settings.json for Claude Code's HTTP hooks. It is derived
 * from the API token and opens the hook endpoint only: settings.json is not a private file the
 * way the token file is (it is synced in dotfiles and pasted into bug reports), and the API
 * token itself can send text into terminals.
 */
function deriveHookToken(apiToken) {
  return crypto
    .createHmac('sha256', String(apiToken || ''))
    .update('amc-hook-endpoint-v1')
    .digest('hex')
    .slice(0, 48);
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  const value = String(hostHeader).trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value : value.slice(0, end + 1);
  }
  return value.split(':')[0];
}

/**
 * Blocks DNS-rebinding: a malicious domain that resolves to 127.0.0.1 still sends its own
 * name in the Host header, so only loopback host names are accepted.
 */
function isAllowedHost(hostHeader) {
  return LOOPBACK_HOSTS.has(hostnameOf(hostHeader));
}

/**
 * Browsers always send Origin on cross-site POSTs. Requests without an Origin come from
 * non-browser clients (hook, CLI) and are still subject to the token check.
 */
function isAllowedOrigin(originHeader) {
  if (!originHeader) return true;
  try {
    const url = new URL(originHeader);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

function tokensEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  return bufA.length === bufB.length && bufA.length > 0 && crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  DEFAULT_TOKEN_FILE,
  TOKEN_HEADER,
  loadOrCreateToken,
  readToken,
  deriveHookToken,
  isAllowedHost,
  isAllowedOrigin,
  tokensEqual,
};
