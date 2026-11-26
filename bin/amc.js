#!/usr/bin/env node
/**
 * Agent Mission Control CLI (`amc`)
 *
 * Commands:
 *   amc start [--port 4310] [--no-open]            Start Mission Control server & open Web UI (Real sessions only)
 *             [--no-manage-hooks]                  The server connects the Claude Code hooks while it runs and removes
 *                                                  them when it stops; this flag leaves ~/.claude/settings.json alone
 *   amc install-hooks                              Install Claude Code lifecycle hooks into ~/.claude/settings.json
 *   amc uninstall-hooks                            Remove Mission Control hooks from ~/.claude/settings.json
 *   amc install-statusline                         Forward real 5h plan usage from Claude Code's statusline (keeps an existing statusline)
 *   amc uninstall-statusline                       Restore the statusline that was configured before
 *   amc status                                     Show live & history sessions right in the terminal
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
  installStatusline,
  uninstallStatusline,
} = require('../src/hook-installer');
const { attachManagedHooks } = require('../src/hook-lifecycle');
const { readToken } = require('../src/security');

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
          'X-AMC-Token': readToken(),
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
    const result = installClaudeHooks({ port: PORT });
    if (result.error) {
      console.log(`❌ ติดตั้ง Claude Code Hooks ไม่สำเร็จ: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log('✅ ติดตั้ง Claude Code Lifecycle Hooks สำเร็จ!');
    console.log(`   ไฟล์ตั้งค่า: ${result.settingsPath}`);
    console.log(`   Events ที่เชื่อมต่อ: ${result.installedEvents.join(', ')}`);
    console.log(
      '   ⚠️ Hooks ที่ติดตั้งด้วยคำสั่งนี้จะค้างอยู่แม้ปิดเซิร์ฟเวอร์ และ Claude Code จะขึ้นคำเตือนทุก tool call ระหว่างที่เซิร์ฟเวอร์ไม่ได้เปิด'
    );
    console.log(
      '      ปกติไม่ต้องใช้คำสั่งนี้: "amc start" เชื่อมและถอด hooks ให้เอง (ใช้คู่กับ "amc start --no-manage-hooks" เท่านั้น)'
    );
    return;
  }

  if (subcommand === 'uninstall-hooks') {
    const result = uninstallClaudeHooks();
    if (result.error) {
      console.log(`❌ ถอนการติดตั้ง Claude Code Hooks ไม่สำเร็จ: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log('✅ ถอนการติดตั้ง Claude Code Hooks เรียบร้อย');
    console.log(`   ไฟล์ตั้งค่า: ${result.settingsPath}`);
    return;
  }

  if (subcommand === 'install-statusline') {
    const result = installStatusline();
    if (result.error) {
      console.log(`❌ ติดตั้ง statusline ไม่สำเร็จ: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log('✅ เชื่อม Claude Code statusline กับ Mission Control แล้ว (usage 5 ชม. จริง)');
    if (result.wrapsPrevious) {
      console.log('   statusline เดิมของคุณยังแสดงเหมือนเดิม (ถูกครอบไว้ ไม่ได้ลบ)');
    }
    console.log(`   ไฟล์ตั้งค่า: ${result.settingsPath}`);
    return;
  }

  if (subcommand === 'uninstall-statusline') {
    const result = uninstallStatusline();
    console.log('✅ คืนค่า statusline เดิมเรียบร้อย');
    console.log(`   ไฟล์ตั้งค่า: ${result.settingsPath}`);
    return;
  }

  if (subcommand === 'status') {
    const statusUrl = `http://127.0.0.1:${PORT}/api/state`;
    const statusOptions = { headers: { 'X-AMC-Token': readToken() } };
    const req = http.get(statusUrl, statusOptions, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        const data = JSON.parse(raw);
        if (!data.ok) {
          console.log(`❌ Mission Control ตอบกลับ: ${data.error}`);
          return;
        }
        console.log('\n🎛️  AGENT MISSION CONTROL — LIVE & HISTORY STATUS');
        console.log('====================================================');
        console.log(
          `🟢 เปิดอยู่ (Live): ${data.metrics.liveRooms} | ⚠️ รอเลือกตอบ: ${data.metrics.needsInput} | 🕘 ประวัติที่ปิดแล้ว (History): ${data.metrics.historyRooms}\n`
        );
        for (const s of data.sessions) {
          const icon =
            s.lifecycle === 'history'
              ? '🕘'
              : s.status === 'needs_input'
              ? '⚠️'
              : s.status === 'working'
              ? '⚡'
              : '🟢';
          console.log(
            `${icon} [${s.room}] (${s.project} • ${s.branch}) — ${s.statusLabel}`
          );
          console.log(`   📁 โฟลเดอร์: ${s.cwd}`);
          console.log(`   📌 TL;DR   : ${s.tldr}`);
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
    const roomName =
      getFlagValue('--room') || `${path.basename(process.cwd())}`;
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

  // Default: `start` (Real sessions only — no demo rooms seeded!)
  const noOpen = args.includes('--no-open');
  // The server owns its hooks unless told otherwise: connected once it is listening, removed
  // when it stops, so a Claude Code session never posts to a server that is not there.
  const manageHooks =
    !args.includes('--no-manage-hooks') && process.env.AMC_MANAGE_HOOKS !== '0';
  const { server, store, token } = createMissionControlServer();

  // Persist debounced state before exiting on Ctrl+C / service stop.
  const shutdown = () => {
    store.flush();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(PORT, '127.0.0.1', () => {
    // Only after the port is ours: a second instance that fails to bind must not touch the
    // hooks of the one that is running.
    const managed = manageHooks
      ? attachManagedHooks({
          proc: process,
          install: () => installClaudeHooks({ port: PORT, token }),
          // Only this instance's hooks: another server on another port keeps its own.
          uninstall: () => uninstallClaudeHooks({ port: PORT }),
          onSignal: shutdown,
          onUninstallFailed: (message) => {
            console.log(`⚠️  ถอด Claude Code Hooks ไม่สำเร็จ: ${message}`);
            console.log(
              '   Hooks ยังค้างอยู่ใน ~/.claude/settings.json และ Claude Code จะขึ้นคำเตือนทุก tool call จนกว่าจะรัน "amc uninstall-hooks" หรือเปิดเซิร์ฟเวอร์อีกครั้ง'
            );
          },
        })
      : null;
    const hooksState = managed ? managed.result : checkHooksStatus();
    const hooksLine = hooksState.error
      ? `🔴 เชื่อมไม่สำเร็จ: ${hooksState.error}`
      : hooksState.installed
      ? `🟢 ติดตั้งแล้ว (${hooksState.installedEvents.length} events)` +
        (managed ? ' • ถอดอัตโนมัติเมื่อปิดเซิร์ฟเวอร์' : '')
      : '🟡 ยังไม่ได้ผูกอัตโนมัติ (กดปุ่มติดตั้งบนหน้าเว็บ หรือรัน npm run install-hooks)';

    const url = `http://127.0.0.1:${PORT}`;
    console.log('\n============================================================');
    console.log('🎛️  AGENT MISSION CONTROL — READY (REAL SESSIONS MODE)');
    console.log('============================================================');
    console.log(`🌐 Web Dashboard : ${url}`);
    console.log(`🔗 Claude Hooks  : ${hooksLine}`);
    console.log('------------------------------------------------------------');
    console.log('💡 ระบบกำลังสแกนและจดจำทุก Session ของ Claude ที่คุณเปิดใช้งานจริง');
    console.log('   หากเผลอปิด Tab ระบบจะย้ายไปเก็บในแท็บ "🕘 ประวัติที่ปิดแล้ว"');
    console.log('   เพื่อให้คุณกดปุ่ม "🔄 กู้คืน / เปิดต่อใน Terminal" ได้ตลอดเวลา!');
    console.log('============================================================\n');

    if (!noOpen) {
      openBrowser(url);
    }
  });
}

runCommand();
