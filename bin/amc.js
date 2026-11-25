#!/usr/bin/env node
/**
 * Agent Mission Control CLI (`amc`)
 *
 * Commands:
 *   amc start [--port 4310] [--demo] [--no-open]   Start Mission Control server & open Web UI
 *   amc demo                                       Start server pre-loaded with 4 simulated agent rooms
 *   amc install-hooks                              Install Claude Code lifecycle hooks into ~/.claude/settings.json
 *   amc uninstall-hooks                            Remove Mission Control hooks from ~/.claude/settings.json
 *   amc status                                     Show live multi-room status table right in the terminal
 *   amc run [--room "Auth"] <cmd> [args...]        Wrap any CLI agent in a Mission Control tracked room
 */
const http = require('http');
const path = require('path');
const { spawn, exec } = require('child_process');
const { createMissionControlServer } = require('../src/server');
const {
  checkHooksStatus,
  installClaudeHooks,
  uninstallClaudeHooks,
} = require('../src/hook-installer');

const args = process.argv.slice(2);
const subcommand = args[0] || 'start';
const PORT = Number(process.env.AMC_PORT || getFlagValue('--port') || 4310);

function getFlagValue(flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return null;
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    exec(`start "" "${url}"`);
  } else if (process.platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

function postHookPayload(payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: '/api/hook',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 1200,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

async function runCommand() {
  if (subcommand === 'install-hooks' || subcommand === 'setup') {
    const result = installClaudeHooks();
    console.log('✅ ติดตั้ง Claude Code Lifecycle Hooks สำเร็จ!');
    console.log(`   ไฟล์ตั้งค่า: ${result.settingsPath}`);
    console.log(`   Events ที่เชื่อมต่อ: ${result.installedEvents.join(', ')}`);
    return;
  }

  if (subcommand === 'uninstall-hooks') {
    const result = uninstallClaudeHooks();
    console.log('✅ ถอนการติดตั้ง Claude Code Hooks เรียบร้อย');
    console.log(`   ไฟล์ตั้งค่า: ${result.settingsPath}`);
    return;
  }

  if (subcommand === 'status') {
    const req = http.get(`http://127.0.0.1:${PORT}/api/state`, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        const data = JSON.parse(raw);
        console.log('\n🎛️  AGENT MISSION CONTROL — LIVE STATUS');
        console.log('====================================================');
        console.log(
          `Rooms: ${data.metrics.totalRooms} | ⚠️ รอตัดสินใจ: ${data.metrics.needsInput} | ⚡ กำลังรัน: ${data.metrics.working} | 🤖 Active Sub-Agents: ${data.metrics.activeSubAgents}\n`
        );
        for (const s of data.sessions) {
          const icon =
            s.status === 'needs_input'
              ? '⚠️'
              : s.status === 'working'
              ? '⚡'
              : s.status === 'done'
              ? '✅'
              : '⏸️';
          console.log(`${icon} [${s.room}] (${s.branch}) — ${s.statusLabel}`);
          console.log(`   🎯 เป้าหมาย: ${s.goal}`);
          console.log(`   📌 TL;DR   : ${s.tldr}`);
          if (s.subAgents && s.subAgents.length > 0) {
            console.log(
              `   🌳 Sub-Agents (${s.subAgents.length}): ${s.subAgents
                .map((sub) => `${sub.name} [${sub.state}]`)
                .join(', ')}`
            );
          }
          console.log('');
        }
      });
    });
    req.on('error', () => {
      console.log(
        `❌ ยังไม่ได้เปิดเซิร์ฟเวอร์ Mission Control บนพอร์ต ${PORT} (รัน "npm start" หรือ "amc start" ก่อนครับ)`
      );
    });
    return;
  }

  if (subcommand === 'run') {
    // Wrap any CLI command (e.g. `amc run --room "Auth" claude`)
    const roomName =
      getFlagValue('--room') ||
      `Room • ${path.basename(process.cwd())}`;
    let cmdStartIdx = 1;
    if (args[1] === '--room') cmdStartIdx = 3;
    const targetCmd = args[cmdStartIdx] || 'claude';
    const targetArgs = args.slice(cmdStartIdx + 1);
    const sessionId = `wrap-${path.basename(process.cwd())}-${process.pid}`;

    console.log(
      `🎛️  [Agent Mission Control] เชื่อมต่อห้อง "${roomName}" (${sessionId}) แล้ว`
    );

    await postHookPayload({
      session_id: sessionId,
      room: roomName,
      cwd: process.cwd(),
      cli: `${targetCmd} (wrapped)`,
      wrapper_connected: true,
      hook_event_name: 'SessionStart',
    });

    const child = spawn(targetCmd, targetArgs, {
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        AMC_ROOM: roomName,
        AMC_SESSION_ID: sessionId,
      },
    });

    child.on('exit', async (code) => {
      await postHookPayload({
        session_id: sessionId,
        room: roomName,
        cwd: process.cwd(),
        wrapper_connected: false,
        hook_event_name: 'SessionEnd',
      });
      process.exit(code || 0);
    });
    return;
  }

  // Default: `start` or `demo`
  const isDemo = subcommand === 'demo' || args.includes('--demo');
  const noOpen = args.includes('--no-open');
  const { server, store } = createMissionControlServer();

  if (isDemo || store.sessions.size === 0) {
    store.seedDemoSessions();
  }

  const hooksState = checkHooksStatus();

  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}`;
    console.log('\n============================================================');
    console.log('🎛️  AGENT MISSION CONTROL — READY');
    console.log('============================================================');
    console.log(`🌐 Web Dashboard : ${url}`);
    console.log(
      `🔗 Claude Hooks  : ${
        hooksState.installed
          ? '🟢 ติดตั้งแล้ว (' + hooksState.installedEvents.length + ' events)'
          : '🟡 ยังไม่ได้ผูกอัตโนมัติ (กดปุ่มติดตั้งบนหน้าเว็บ หรือรัน npm run install-hooks)'
      }`
    );
    console.log('------------------------------------------------------------');
    console.log('💡 ทุกครั้งที่คุณเปิด Claude CLI ใน Terminal Tab ใดๆ');
    console.log('   สถานะห้อง, Workflow Stage, Sub-Agents และ Auto-TL;DR');
    console.log('   จะเด้งขึ้นบนหน้าจอ Dashboard อัตโนมัติโดยไม่ต้องไล่อ่าน Log!');
    console.log('============================================================\n');

    if (!noOpen) {
      openBrowser(url);
    }
  });
}

runCommand();
