const { spawn, execFile } = require('child_process');
const fs = require('fs');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAMED_KEYS = new Set(['enter', 'esc', 'escape', 'up', 'down', 'left', 'right', 'tab', 'space']);
const APPROVAL_RE = /^(y|yes|approve)$/i;

/**
 * Quotes a value as a PowerShell single-quoted literal. PowerShell also treats the
 * Unicode quote characters U+2018..U+201B as single quotes, so those are doubled too.
 */
function psLiteral(value) {
  return `'${String(value ?? '').replace(/['‘’‚‛]/g, '$&$&')}'`;
}

/** Encodes a script for `powershell.exe -EncodedCommand` (base64 of UTF-16LE). */
function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Window titles go straight onto wt.exe's command line, where `;` separates sub-commands. */
function safeTitle(title) {
  return (
    String(title || 'Agent Room')
      .replace(/[;"\u0000-\u001f]/g, ' ')
      .trim()
      .slice(0, 80) || 'Agent Room'
  );
}

function resolveResumeId(session) {
  if (!session) return null;
  if (session.claudeSessionId && UUID_RE.test(session.claudeSessionId)) {
    return session.claudeSessionId;
  }
  return UUID_RE.test(session.id) ? session.id : null;
}

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : fallback;
}

/**
 * Builds the PowerShell script for a new terminal tab. Every dynamic value is a quoted
 * literal and the script travels base64-encoded, so room names and paths are never parsed
 * as code by cmd.exe, wt.exe or PowerShell.
 */
function buildTerminalScript({ cwd, room, claudeArgs, banner }) {
  const lines = [
    `Set-Location -LiteralPath ${psLiteral(cwd)}`,
    `$env:AMC_ROOM = ${psLiteral(room)}`,
    `Write-Host ${psLiteral(banner)} -ForegroundColor Cyan`,
  ];
  if (claudeArgs) {
    lines.push(`& claude ${claudeArgs.map(psLiteral).join(' ')}`);
  }
  return lines.join('\n');
}

class CommandBridge {
  constructor(stateStore, consoleScanner = null) {
    this.store = stateStore;
    this.consoleScanner = consoleScanner;
    this.activeProcesses = new Map();
  }

  /**
   * Selects an interactive TUI option (1, 2, 3...) directly inside a running Claude CLI tab.
   */
  async selectInteractiveOption(sessionId, optionPayload = {}) {
    const session = this.store.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const targetIndex = parsePositiveInt(
      optionPayload.targetIndex ?? optionPayload.index,
      1
    );
    const currentIndex = parsePositiveInt(
      optionPayload.currentIndex ??
        (session.interactivePrompt && session.interactivePrompt.currentIndex),
      1
    );
    const numberStr = String(optionPayload.number ?? targetIndex);
    const labelStr = optionPayload.label || `ตัวเลือกที่ ${numberStr}`;
    const selectedPatch = {
      status: 'working',
      workingSignalAt: new Date().toISOString(),
      statusLabel: `เลือก [${numberStr}. ${labelStr}] แล้ว`,
      pendingAction: null,
      interactivePrompt: null,
    };

    if (session.pid && this.consoleScanner) {
      const res = await this.consoleScanner.selectOption(
        session.pid,
        currentIndex,
        targetIndex,
        numberStr
      );
      if (res && res.ok) {
        this.store.updateSession(session.id, {
          ...selectedPatch,
          tldr: `✓ ส่งการเลือก "${numberStr}. ${labelStr}" เข้าหน้าจอ Terminal (PID ${session.pid}) เรียบร้อย`,
        });
        return {
          ok: true,
          delivered: true,
          transport: 'win32-console-input',
          message: `เลือก "${numberStr}. ${labelStr}" ส่งเข้า Terminal (PID ${session.pid}) สำเร็จ!`,
        };
      }
    }

    if (session.paneId) {
      const wezSent = await this._tryWezTermSend(session.paneId, numberStr);
      if (wezSent) {
        this.store.updateSession(session.id, {
          ...selectedPatch,
          tldr: `✓ ส่งตัวเลือก "${numberStr}. ${labelStr}" เข้า WezTerm Pane #${session.paneId} เรียบร้อย`,
        });
        return {
          ok: true,
          delivered: true,
          transport: 'wezterm-ipc',
          message: `เลือก "${numberStr}. ${labelStr}" ส่งเข้า WezTerm Pane #${session.paneId} สำเร็จ!`,
        };
      }
    }

    // No live transport reached the terminal: queue it, but keep the prompt visible
    // instead of pretending the choice was made.
    this.store.enqueueCommand(session.id, numberStr);
    return {
      ok: true,
      delivered: false,
      transport: 'mission-control-queue',
      message: `⏳ ยังส่งเข้า Terminal ของ ${session.room} ไม่ได้ — เก็บตัวเลือก "${numberStr}" ไว้ในคิวแล้ว`,
    };
  }

  /**
   * Applies a multi-select answer in one go: Enter on each option whose tick should flip
   * (positions are arrow-key positions, top = 1), then, when given, Enter on the "Next" row.
   * The dashboard collects the ticks first, so the terminal is driven once instead of per click.
   */
  async applyMultiSelect(sessionId, { toggles, currentIndex, nextIndex }) {
    const session = this.store.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (!session.pid || !this.consoleScanner) {
      return {
        ok: false,
        delivered: false,
        message: `ไม่พบ terminal ของห้อง ${session.room} ที่เปิดอยู่ จึงส่งคำตอบไม่ได้`,
      };
    }
    let cursor = currentIndex;
    const steps = [...toggles].sort((a, b) => a - b);
    if (nextIndex) steps.push(nextIndex);
    for (const target of steps) {
      const res = await this.consoleScanner.selectOption(session.pid, cursor, target, String(target));
      if (!res || !res.ok) {
        return { ok: false, delivered: false, message: 'ส่งคำตอบเข้า terminal ไม่ครบ ลองตรวจในหน้าต่าง terminal' };
      }
      cursor = target;
    }
    this.store.updateSession(session.id, {
      tldr: `✓ ส่งคำตอบแบบเลือกหลายข้อเข้า Terminal (PID ${session.pid}) แล้ว`,
    });
    return {
      ok: true,
      delivered: true,
      transport: 'win32-console-key',
      message: nextIndex ? 'ส่งคำตอบแล้ว ไปข้อถัดไป' : 'อัปเดตตัวเลือกแล้ว',
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

    const key = String(keyName || '').toLowerCase();
    if (!NAMED_KEYS.has(key) && key.length !== 1) {
      return {
        ok: false,
        transport: 'none',
        message: `ไม่รองรับปุ่ม "${keyName}"`,
      };
    }

    if (session.pid && this.consoleScanner) {
      const res = await this.consoleScanner.sendKey(session.pid, key);
      if (res && res.ok) {
        return {
          ok: true,
          delivered: true,
          transport: 'win32-console-key',
          message: `ส่งปุ่ม [${key.toUpperCase()}] เข้า Terminal (PID ${session.pid}) สำเร็จ`,
        };
      }
    }

    return {
      ok: false,
      transport: 'none',
      message: `ไม่พบ Process claude.exe ที่กำลังเปิดอยู่ของห้องนี้ (สามารถกดปุ่ม "🔄 กู้คืน / เปิดต่อใน Terminal" ได้ครับ)`,
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
    // Plain text such as "1" or "ok" is only an approval when the room is actually waiting for one.
    const isApproval =
      Boolean(options.isApproval) ||
      (Boolean(session.pendingAction) && APPROVAL_RE.test(trimmed));

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
          delivered: true,
          transport: 'win32-console-input',
          message: `ส่งคำสั่ง "${trimmed}" เข้าหน้าจอ Claude Terminal (PID ${session.pid}) โดยตรงเรียบร้อย!`,
        };
      }
    }

    const recordPrompt = () =>
      this.store.processHookEvent({
        session_id: session.id,
        cwd: session.cwd,
        hook_event_name: 'UserPromptSubmit',
        prompt: isApproval
          ? `[Approved] ${session.pendingAction || trimmed}`
          : trimmed,
      });

    if ((mode === 'auto' || mode === 'wezterm') && session.paneId) {
      const wezSent = await this._tryWezTermSend(session.paneId, trimmed);
      if (wezSent) {
        recordPrompt();
        return {
          ok: true,
          delivered: true,
          transport: 'wezterm-ipc',
          message: `ส่งคำสั่งเข้า WezTerm Pane #${session.paneId} เรียบร้อย`,
        };
      }
    }

    if (mode === 'claude-resume' || options.runHeadless) {
      recordPrompt();
      this._spawnClaudeHeadless(session, trimmed);
      return {
        ok: true,
        delivered: true,
        transport: 'claude-headless-resume',
        message: `สั่งรัน Claude CLI ต่อเนื่องจาก Session (${session.id}) ในพื้นหลังแล้ว`,
      };
    }

    // The wrapper (`amc run`) and hooks pick commands up from the queue on their next poll.
    this.store.enqueueCommand(session.id, trimmed);

    if ((mode === 'auto' || mode === 'wrapper') && session.wrapperConnected) {
      recordPrompt();
      return {
        ok: true,
        delivered: true,
        transport: 'amc-wrapper',
        message: `ส่งคำสั่งเข้า Terminal Wrapper (${session.room}) เรียบร้อย`,
      };
    }

    return {
      ok: true,
      delivered: false,
      transport: 'mission-control-queue',
      message: `⏳ ยังส่งเข้า Terminal ของ ${session.room} ไม่ได้ — เก็บคำสั่งไว้ในคิว (ลองกด "🔄 กู้คืน / เปิดต่อใน Terminal" หรือเปิดโหมด Headless)`,
    };
  }

  _tryWezTermSend(paneId, text) {
    if (!/^\d+$/.test(String(paneId))) return Promise.resolve(false);
    return new Promise((resolve) => {
      execFile(
        'wezterm',
        [
          'cli',
          'send-text',
          '--pane-id',
          String(paneId),
          '--no-paste',
          `${text}\r`,
        ],
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

    // The prompt is written to stdin rather than passed as an argument: on Windows `claude`
    // is often a .cmd shim that needs a shell, and nothing user-supplied may reach that shell.
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    const resumeId = resolveResumeId(session);
    if (resumeId) {
      args.unshift('--resume', resumeId);
    }

    try {
      const child = spawn('claude', args, {
        cwd,
        shell: process.platform === 'win32',
        windowsHide: true,
        env: {
          ...process.env,
          AMC_ROOM: session.room,
        },
      });

      this.activeProcesses.set(session.id, child);
      child.stdin.on('error', () => {});
      child.stdin.end(promptText, 'utf8');

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

      child.on('error', (err) => {
        this.activeProcesses.delete(session.id);
        this.store.updateSession(session.id, {
          status: 'error',
          statusLabel: 'รัน Claude CLI ไม่สำเร็จ',
          tldr: `เกิดข้อผิดพลาด: ${err.message}`,
        });
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

  /**
   * Opens or resumes a Session in a new Windows Terminal tab.
   * If `options.resume` is true:
   * - Uses `claude --resume <claudeSessionId>` if a specific UUID was recorded,
   * - Or `claude --continue` to resume the latest conversation in that folder.
   */
  openTerminalTab(sessionId, options = {}) {
    const session = this.store.sessions.get(sessionId);
    const cwd =
      (session && session.cwd && fs.existsSync(session.cwd) && session.cwd) ||
      (options.cwd && fs.existsSync(options.cwd) && options.cwd) ||
      process.cwd();
    const roomTitle = safeTitle((session && session.room) || options.room);

    let claudeArgs = null;
    if (options.resume) {
      const resumeId = resolveResumeId(session);
      claudeArgs = resumeId ? ['--resume', resumeId] : ['--continue'];
    } else if (options.autoRunClaude) {
      claudeArgs = [];
    }
    const claudeCmd = ['claude', ...(claudeArgs || [])].join(' ');

    if (session && options.resume) {
      this.store.updateSession(session.id, {
        lifecycle: 'live',
        status: 'idle',
        statusLabel: 'กำลังกู้คืน Session ใน Terminal...',
        closedAt: null,
        tldr: `กำลังเปิดหน้าต่าง Terminal ที่ ${cwd} พร้อมคำสั่ง "${claudeCmd}"`,
      });
    }

    return new Promise((resolve) => {
      if (process.platform !== 'win32') {
        return resolve({
          ok: false,
          launcher: 'manual',
          message: `กรุณาเปิด Terminal ที่โฟลเดอร์ ${cwd} แล้วรัน ${claudeCmd}`,
        });
      }

      const banner = claudeArgs
        ? `🎛️ Resuming Session in Agent Mission Control: ${roomTitle}`
        : `🎛️ Connected to Agent Mission Control: ${roomTitle} (พิมพ์ claude หรือ claude --continue เพื่อเริ่มงาน)`;
      const encoded = encodePowerShell(
        buildTerminalScript({ cwd, room: roomTitle, claudeArgs, banner })
      );
      const psArgs = ['-NoExit', '-EncodedCommand', encoded];

      execFile(
        'wt.exe',
        ['-w', '0', 'new-tab', '--title', roomTitle, 'powershell.exe', ...psArgs],
        (wtErr) => {
          if (this.consoleScanner) {
            setTimeout(() => this.consoleScanner.scanOnce(), 1500);
          }
          if (!wtErr) {
            return resolve({
              ok: true,
              launcher: 'windows-terminal',
              command: claudeCmd,
              message: options.resume
                ? `กู้คืนห้อง "${roomTitle}" (${claudeCmd}) ใน Windows Terminal Tab ใหม่แล้ว!`
                : `เปิด Tab "${roomTitle}" ใน Windows Terminal แล้ว`,
            });
          }

          // Without Windows Terminal: a detached PowerShell gets its own console window.
          // Spawned directly (no cmd.exe `start`), so the title is never shell-parsed.
          try {
            spawn('powershell.exe', psArgs, {
              cwd,
              detached: true,
              stdio: 'ignore',
            }).unref();
          } catch (err) {
            return resolve({
              ok: false,
              launcher: 'none',
              message: `เปิด Terminal ไม่สำเร็จ: ${err.message}`,
            });
          }

          resolve({
            ok: true,
            launcher: 'powershell',
            command: claudeCmd,
            message: `เปิดหน้าต่าง PowerShell สำหรับ "${roomTitle}" แล้ว`,
          });
        }
      );
    });
  }
}

module.exports = {
  CommandBridge,
  psLiteral,
  encodePowerShell,
  buildTerminalScript,
  safeTitle,
  resolveResumeId,
};
