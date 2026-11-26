#!/usr/bin/env node
/**
 * Standalone Claude Code Lifecycle Hook Reporter for Agent Mission Control.
 * Reads Claude Code hook payload from stdin and sends it to the local Mission Control server
 * (http://127.0.0.1:4310/api/hook). Never blocks or crashes Claude CLI if the server is offline.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.AMC_PORT || 4310);
const HOST = process.env.AMC_HOST || '127.0.0.1';
const DATA_DIR = path.join(os.homedir(), '.agent-mission-control');

// The Mission Control server rejects API calls without its per-install token.
function readToken() {
  try {
    return fs.readFileSync(path.join(DATA_DIR, 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

let rawInput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  rawInput += chunk;
});

process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = rawInput.trim() ? JSON.parse(rawInput) : {};
  } catch {
    payload = { raw: rawInput };
  }

  // Note: Do NOT send `process.ppid` as `pid` here, because Claude spawns an intermediate shell
  // to run hooks, so `process.ppid` is a temporary shell PID that differs from `claude.exe`'s PID!
  const enriched = {
    ...payload,
    hook_event_name:
      process.argv[2] || payload.hook_event_name || payload.event || 'Unknown',
    cwd: payload.cwd || process.cwd(),
    pane_id: process.env.WEZTERM_PANE || process.env.TMUX_PANE || null,
    wt_session: process.env.WT_SESSION || null,
    room: process.env.AMC_ROOM || null,
    // Claude Code exports these to the processes it starts: the PID of the claude process (the
    // dashboard's room for that terminal) and how it was started ("cli" in a terminal; "sdk-*"
    // for `claude -p` and the Agent SDK, which get no room of their own).
    claude_pid: Number(process.env.CLAUDE_PID) || null,
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || null,
    timestamp: new Date().toISOString(),
  };

  const body = JSON.stringify(enriched);

  const req = http.request(
    {
      hostname: HOST,
      port: PORT,
      path: '/api/hook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-AMC-Token': readToken(),
      },
      timeout: 1200,
    },
    (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        // During a usage hold the server asks us to hold new prompts until the window resets.
        if (enriched.hook_event_name === 'UserPromptSubmit') {
          try {
            const reply = JSON.parse(data);
            if (reply && reply.hold && reply.hold.reason) {
              process.stdout.write(
                JSON.stringify({ decision: 'block', reason: String(reply.hold.reason) })
              );
            }
          } catch {}
        }
        process.exit(0);
      });
    }
  );

  req.on('error', () => {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.appendFileSync(
        path.join(DATA_DIR, 'offline-events.jsonl'),
        body + '\n',
        'utf8'
      );
    } catch {}
    process.exit(0);
  });

  req.on('timeout', () => {
    req.destroy();
    process.exit(0);
  });

  req.write(body);
  req.end();
});
