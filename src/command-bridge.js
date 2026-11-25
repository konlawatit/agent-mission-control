const { spawn, execFile } = require('child_process');
const fs = require('fs');

/**
 * Bi-Directional Command Bridge for Agent Mission Control.
 * Supports 4 ways to send commands or open a specific session from the dashboard:
 * 1. Wrapper Queue (`amc run`): Immediate delivery to active wrapped terminal tab.
 * 2. WezTerm CLI IPC (`wezterm cli send-text --pane-id <id>`): Direct keystroke injection into terminal pane.
 * 3. Claude Session Resume (`claude --resume <session_id> -p "<command>" --output-format stream-json`):
 *    Runs or continues the session in the background and streams progress directly into Mission Control.
 * 4. Open / Focus Windows Terminal or PowerShell in the room's workspace (`wt.exe` / `powershell`).
 */
class CommandBridge {
  constructor(stateStore) {
    this.store = stateStore;
    this.activeProcesses = new Map(); // sessionId -> ChildProcess
  }

  /**
   * Dispatches a command or approval to a session using the best available transport.
   */
  async dispatchCommand(sessionId, commandText, options = {}) {
    const session = this.store.getOrCreateSession(sessionId, {
      cwd: options.cwd,
      room: options.room,
    });

    const trimmed = String(commandText || '').trim();
    if (!trimmed) {
      throw new Error('Command text cannot be empty');
    }

    const mode = options.mode || 'auto'; // 'auto' | 'wrapper' | 'wezterm' | 'claude-resume'
    const isApproval =
      options.isApproval ||
      /^(y|yes|approve|ok|1)$/i.test(trimmed);

    // Update UI state immediately so user gets instant visual feedback
    this.store.processHookEvent({
      session_id: session.id,
      cwd: session.cwd,
      hook_event_name: 'UserPromptSubmit',
      prompt: isApproval
        ? `[Approved] ${session.pendingAction || trimmed}`
        : trimmed,
    });

    // 1. Always enqueue into wrapper queue in case `amc run` is polling this room
    this.store.enqueueCommand(session.id, trimmed);

    // 2. If WezTerm Pane ID is available and mode is auto or wezterm, try WezTerm IPC
    if ((mode === 'auto' || mode === 'wezterm') && session.paneId) {
      const wezSent = await this._tryWezTermSend(session.paneId, trimmed);
      if (wezSent) {
        return {
          ok: true,
          transport: 'wezterm-ipc',
          message: `ส่งคำสั่งเข้า WezTerm Pane #${session.paneId} เรียบร้อย`,
        };
      }
    }

    // 3. If wrapperConnected is true, the `amc run` wrapper will pick it up from the queue
    if ((mode === 'auto' || mode === 'wrapper') && session.wrapperConnected) {
      return {
        ok: true,
        transport: 'amc-wrapper',
        message: `ส่งคำสั่งเข้า Terminal Wrapper (${session.room}) เรียบร้อย`,
      };
    }

    // 4. If mode === 'claude-resume' or user explicitly wants background execution via Claude CLI
    if (mode === 'claude-resume' || options.runHeadless) {
      this._spawnClaudeHeadless(session, trimmed);
      return {
        ok: true,
        transport: 'claude-headless-resume',
        message: `สั่งรัน Claude CLI ต่อเนื่องจาก Session (${session.id}) ในพื้นหลังแล้ว`,
      };
    }

    // Default fallback: queued + update state (works for both demo rooms and hook-tracked tabs)
    if (isApproval) {
      this.store.updateSession(session.id, {
        status: 'working',
        statusLabel: 'ได้รับ Approve • กำลังรันต่อ',
        pendingAction: null,
        tldr: `อนุมัติคำสั่งเรียบร้อย กำลังดำเนินการต่อใน ${session.room}`,
      });
    }

    return {
      ok: true,
      transport: 'mission-control-queue',
      message: `บันทึกและส่งคำสั่งไปยัง ${session.room} เรียบร้อย`,
    };
  }

  _tryWezTermSend(paneId, text) {
    return new Promise((resolve) => {
      execFile(
        'wezterm',
        ['cli', 'send-text', '--pane-id', String(paneId), '--no-paste', `${text}\r`],
        { timeout: 2000 },
        (err) => {
          resolve(!err);
        }
      );
    });
  }

  /**
   * Spawns a new Claude Code headless/streaming turn or resumes an existing session.
   */
  _spawnClaudeHeadless(session, promptText) {
    const cwd =
      session.cwd && fs.existsSync(session.cwd) ? session.cwd : process.cwd();

    const args = ['-p', promptText, '--output-format', 'stream-json', '--verbose'];
    // Only pass --resume if session.id looks like a real UUID from Claude Code
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(session.id)) {
      args.unshift('--resume', session.id);
    }

    try {
      const child = spawn('claude', args, {
        cwd,
        shell: true,
        env: {
          ...process.env,
          AMC_ROOM: session.room,
        },
      });

      this.activeProcesses.set(session.id, child);

      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim().startsWith('{')) continue;
          try {
            const evt = JSON.parse(line);
            this._handleClaudeStreamJson(session.id, evt);
          } catch {
            // Ignore partial line
          }
        }
      });

      child.on('close', (code) => {
        this.activeProcesses.delete(session.id);
        this.store.processHookEvent({
          session_id: session.id,
          cwd,
          hook_event_name: 'Stop',
          summary:
            code === 0
              ? undefined
              : `Process จบการทำงานด้วยรหัส (exit code ${code})`,
        });
      });
    } catch (err) {
      this.store.updateSession(session.id, {
        status: 'error',
        statusLabel: 'รัน Claude CLI ไม่สำเร็จ',
        tldr: `เกิดข้อผิดพลาด: ${err.message}`,
      });
    }
  }

  _handleClaudeStreamJson(sessionId, evt) {
    if (!evt || typeof evt !== 'object') return;
    if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
      for (const block of evt.message.content) {
        if (block.type === 'tool_use') {
          this.store.processHookEvent({
            session_id: sessionId,
            hook_event_name: 'PreToolUse',
            tool_name: block.name,
            tool_input: block.input || {},
            tool_use_id: block.id,
          });
        } else if (block.type === 'text' && block.text) {
          this.store.updateSession(sessionId, {
            tldr: block.text.slice(0, 220),
          });
        }
      }
    } else if (evt.type === 'result' && evt.result) {
      this.store.processHookEvent({
        session_id: sessionId,
        hook_event_name: 'Stop',
        summary: String(evt.result).slice(0, 220),
      });
    }
  }

  /**
   * Opens a new Terminal window/tab in the session's workspace directory
   * (Windows Terminal `wt.exe` if available, fallback to PowerShell / cmd).
   */
  openTerminalTab(sessionId, options = {}) {
    const session = this.store.sessions.get(sessionId);
    const cwd =
      (session && session.cwd && fs.existsSync(session.cwd) && session.cwd) ||
      options.cwd ||
      process.cwd();
    const roomTitle = (session && session.room) || options.room || 'Agent Room';
    const commandToRun = options.command || 'claude';

    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        // Try Windows Terminal (wt.exe) first so it opens as a nice tab
        execFile(
          'wt.exe',
          [
            '-w',
            '0',
            'new-tab',
            '--title',
            roomTitle,
            '-d',
            cwd,
            'powershell.exe',
            '-NoExit',
            '-Command',
            `$env:AMC_ROOM='${roomTitle.replace(/'/g, "''")}'; Write-Host '🎛️ Connected to Agent Mission Control: ${roomTitle}' -ForegroundColor Cyan`,
          ],
          (wtErr) => {
            if (!wtErr) {
              return resolve({
                ok: true,
                launcher: 'windows-terminal',
                message: `เปิด Tab "${roomTitle}" ใน Windows Terminal แล้ว`,
              });
            }
            // Fallback to start powershell
            spawn(
              'cmd.exe',
              [
                '/c',
                'start',
                `"${roomTitle}"`,
                'powershell.exe',
                '-NoExit',
                '-Command',
                `Set-Location '${cwd}'; $env:AMC_ROOM='${roomTitle}'`,
              ],
              { cwd, detached: true, stdio: 'ignore' }
            ).unref();

            resolve({
              ok: true,
              launcher: 'powershell',
              message: `เปิดหน้าต่าง PowerShell สำหรับ "${roomTitle}" แล้ว`,
            });
          }
        );
      } else {
        resolve({
          ok: false,
          launcher: 'manual',
          message: `กรุณาเปิด Terminal ที่โฟลเดอร์ ${cwd} แล้วรัน ${commandToRun}`,
        });
      }
    });
  }
}

module.exports = { CommandBridge };
