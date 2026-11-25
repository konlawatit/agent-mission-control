#!/usr/bin/env node
/**
 * Claude Code statusline bridge for Agent Mission Control.
 *
 * Claude Code pipes a JSON payload to the statusline command after each response. On Pro/Max
 * plans it includes `rate_limits.five_hour` / `seven_day` with `used_percentage` and
 * `resets_at`. This script forwards the usage fields to the local Mission Control server
 * (fire-and-forget, short timeout) and prints a status line.
 *
 * If a statusline was configured before `amc install-statusline`, that command is kept in
 * ~/.agent-mission-control/statusline-previous.json and its output is printed instead of ours,
 * so installing the bridge never replaces the user's own statusline.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const PORT = Number(process.env.AMC_PORT || 4310);
const HOST = process.env.AMC_HOST || '127.0.0.1';
const DATA_DIR = path.join(os.homedir(), '.agent-mission-control');

function readToken() {
  try {
    return fs.readFileSync(path.join(DATA_DIR, 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function readPreviousCommand() {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, 'statusline-previous.json'), 'utf8')
    );
    return raw && typeof raw.command === 'string' && raw.command.trim() ? raw : null;
  } catch {
    return null;
  }
}

function pct(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `${Math.round(v)}%` : null;
}

function ownLine(payload) {
  const parts = [];
  const model = payload.model && (payload.model.display_name || payload.model.id);
  if (model) parts.push(model);
  const five = payload.rate_limits && payload.rate_limits.five_hour;
  const fivePct = five && pct(five.used_percentage);
  if (fivePct) parts.push(`5h ${fivePct}`);
  const ctx = payload.context_window && pct(payload.context_window.used_percentage);
  if (ctx) parts.push(`ctx ${ctx}`);
  return parts.join(' · ');
}

function forward(payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      session_id: payload.session_id || null,
      transcript_path: payload.transcript_path || null,
      cwd:
        (payload.workspace && payload.workspace.current_dir) || payload.cwd || process.cwd(),
      model: payload.model || null,
      rate_limits: payload.rate_limits || null,
      context_window: payload.context_window || null,
      cost: payload.cost || null,
    });
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path: '/api/usage/observed',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-AMC-Token': readToken(),
        },
        timeout: 400,
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('error', resolve);
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.write(body);
    req.end();
  });
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', async () => {
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  const forwarding = forward(payload);

  let line = '';
  const previous = readPreviousCommand();
  if (previous) {
    try {
      const out = spawnSync(previous.command, {
        input: raw,
        shell: true,
        encoding: 'utf8',
        timeout: 1500,
        windowsHide: true,
      });
      line = String(out.stdout || '').replace(/\s+$/, '');
    } catch {
      line = '';
    }
  }
  if (!line) line = ownLine(payload);

  await forwarding;
  process.stdout.write(line);
  process.exit(0);
});
