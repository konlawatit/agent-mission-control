const { spawn, execFile } = require('child_process');
const fs = require('fs');

class CommandBridge {
  constructor(stateStore, consoleScanner = null) {
    this.store = stateStore;
    this.consoleScanner = consoleScanner;
    this.activeProcesses = new Map();
  }

  /**
   * Selects an interactive TUI option (1, 2, 3...) directly inside a running Claude CLI tab!
   */
  async selectInteractiveOption(sessionId, optionPayload = {}) {
    const session = this.store.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const targetIndex = Number(optionPayload.targetIndex || optionPayload.index || 1);
    const currentIndex = Number(
      optionPayload.currentIndex ||
        (session.interactivePrompt && session.interactivePrompt.currentIndex) ||
        1
    );
    const numberStr = String(optionPayload.number || targetIndex);
    const labelStr = optionPayload.label || `ตัวเลือกที่ ${numberStr}`;

    // 1. If we have a real Windows Console PID, inject the selection directly into CONIN$
    if (session.pid && this.consoleScanner) {
      const res = await this.consoleScanner.selectOption(
        session.pid,
        currentIndex,
        targetIndex,
        numberStr
      );
      if (res && res.ok) {
        this.store.updateSession(session.id, {
          status: 'working',
          statusLabel: `เลือก [${numberStr}. ${labelStr}] แล้ว`,
          pendingAction: null,
          interactivePrompt: null,
          tldr: `✓ ส่งการเลือก "${numberStr}. ${labelStr}" เข้าหน้าจอ Terminal (PID ${session.pid}) เรียบร้อย`,
        });
        return {
          ok: true,
          transport: 'win32-console-input',
          message: `เลือก "${numberStr}. ${labelStr}" ส่งเข้า Terminal (PID ${session.pid}) สำเร็จ!`,
        };
      }
    }

    // 2. If WezTerm Pane is available, send the option number + Enter
    if (session.paneId) {
      const wezSent = await this._tryWezTermSend(session.paneId, numberStr);
      if (wezSent) {
        this.store.updateSession(session.id, {
          status: 'working',
          statusLabel: `เลือก [${numberStr}. ${labelStr}] แล้ว`,
          pendingAction: null,
          interactivePrompt: null,
          tldr: `✓ ส่งตัวเลือก "${numberStr}. ${labelStr}" เข้า WezTerm Pane #${session.paneId} เรียบร้อย`,
        });
        return {
          ok: true,
          transport: 'wezterm-ipc',
          message: `เลือก "${numberStr}. ${labelStr}" ส่งเข้า WezTerm Pane #${session.paneId} สำเร็จ!`,
        };
      }
    }

    // 3. Fallback / Demo room state update
    this.store.enqueueCommand(session.id, numberStr);
    this.store.updateSession(session.id, {
      status: 'working',
      statusLabel: `เลือก [${numberStr}. ${labelStr}] แล้ว`,
      pendingAction: null,
      interactivePrompt: null,
      tldr: `✓ เลือกคำตอบ "${numberStr}. ${labelStr}" เรียบร้อย กำลังดำเนินการต่อใน ${session.room}`,
    });

    return {
      ok: true,
      transport: 'mission-control-state',
      message: `เลือก "${numberStr}. ${labelStr}" ใน ${session.room} เรียบร้อย`,
    };
  }

  /**
   * Sends a special TUI navigation key (up, down, enter, esc, space, 1, 2, 3) to the terminal tab.
   */
  async sendTerminalKey(sessionId, keyName) {
    const session = this.store.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (session.pid && this.consoleScanner) {
      const res = await this.consoleScanner.sendKey(session.pid, keyName);
      if (res && res.ok) {
        return {
          ok: true,
          transport: 'win32-console-key',
          message: `ส่งปุ่ม [${keyName.toUpperCase()}] เข้า Terminal (PID ${session.pid}) สำเร็จ`,
        };
      }
    }

    return {
      ok: false,
      transport: 'none',
      message: `ห้องนี้เป็นห้องจำลอง หรือยังไม่ได้เชื่อมต่อ PID ของ claude.exe`,
    };
  }

  /**
   * Dispatches a text command or approval to a session using the best available transport.
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

    const mode = options.mode || 'auto';
    const isApproval =
      options.isApproval || /^(y|yes|approve|ok|1)$/i.test(trimmed);

    // 1. If the session currently has an interactive prompt and the user typed a number (1, 2, 3) or clicked Approve
    if (session.interactivePrompt && /^[1-9]$/.test(trimmed)) {
      const idx = Number(trimmed);
      const matchedOpt = (session.interactivePrompt.options || []).find(
        (o) => o.index === idx || o.number === trimmed
      );
      return this.selectInteractiveOption(session.id, {
        targetIndex: idx,
        currentIndex: session.interactivePrompt.currentIndex || 1,
        number: trimmed,
        label: matchedOpt ? matchedOpt.label : `ตัวเลือก ${trimmed}`,
      });
    }

    // 2. If we have a live Windows Console PID (`claude.exe`), inject text + Enter directly into CONIN$!
    if (!options.runHeadless && session.pid && this.consoleScanner) {
      const sent = await this.consoleScanner.sendText(session.pid, trimmed);
      if (sent && sent.ok) {
        this.store.processHookEvent({
          session_id: session.id,
          cwd: session.cwd,
          hook_event_name: 'UserPromptSubmit',
          prompt: trimmed,
        });
        return {
          ok: true,
          transport: 'win32-console-input',
          message: `ส่งคำสั่ง "${trimmed}" เข้าหน้าจอ Claude Terminal (PID ${session.pid}) โดยตรงเรียบร้อย!`,
        };
      }
    }

    this.store.processHookEvent({
      session_id: session.id,
      cwd: session.cwd,
      hook_event_name: 'UserPromptSubmit',
      prompt: isApproval
        ? `[Approved] ${session.pendingAction || trimmed}`
        : trimmed,
    });

    this.store.enqueueCommand(session.id, trimmed);

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

    if ((mode === 'auto' || mode === 'wrapper') && session.wrapperConnected) {
      return {
        ok: true,
        transport: 'amc-wrapper',
        message: `ส่งคำสั่งเข้า Terminal Wrapper (${session.room}) เรียบร้อย`,
      };
    }

    if (mode === 'claude-resume' || options.runHeadless) {
      this._spawnClaudeHeadless(session, trimmed);
      return {
        ok: true,
        transport: 'claude-headless-resume',
        message: `สั่งรัน Claude CLI ต่อเนื่องจาก Session (${session.id}) ในพื้นหลังแล้ว`,
      };
    }

    if (isApproval) {
      this.store.updateSession(session.id, {
        status: 'working',
        statusLabel: 'ได้รับ Approve • กำลังรันต่อ',
        pendingAction: null,
        interactivePrompt: null,
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

  _spawnClaudeHeadless(session, promptText) {
    const cwd =
      session.cwd && fs.existsSync(session.cwd) ? session.cwd : process.cwd();

    const args = ['-p', promptText, '--output-format', 'stream-json', '--verbose'];
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
          } catch {}
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
    if (
      evt.type === 'assistant' &&
      evt.message &&
      Array.isArray(evt.message.content)
    ) {
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
