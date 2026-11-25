let appState = {
  stages: [
    { index: 0, id: 'plan', label: '1. Plan & Explore' },
    { index: 1, id: 'code', label: '2. Implement & Code' },
    { index: 2, id: 'verify', label: '3. Verify & Test' },
    { index: 3, id: 'done', label: '4. Done / Ready' },
  ],
  metrics: {
    totalRooms: 0,
    needsInput: 0,
    working: 0,
    done: 0,
    activeSubAgents: 0,
    totalSubAgents: 0,
  },
  sessions: [],
  hooks: { installed: false, installedEvents: [] },
};

let selectedSessionId = null;
let viewMode = 'split'; // 'split' | 'grid'

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeJsAttr(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;');
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    el.style.display = 'none';
  }, 4000);
}

async function fetchInitialState() {
  try {
    const res = await fetch('/api/state');
    const data = await res.json();
    if (data.ok) {
      appState = { ...appState, ...data };
      if (!selectedSessionId && appState.sessions.length > 0) {
        selectedSessionId = appState.sessions[0].id;
      }
      renderAll();
    }
  } catch (err) {
    console.error('Failed to load initial state:', err);
  }
}

function connectSSE() {
  const evtSource = new EventSource('/api/events');
  const statusEl = document.getElementById('sse-status');

  evtSource.onopen = () => {
    if (statusEl) {
      statusEl.innerHTML =
        '<span class="dot success"></span><span>Real-time Connected</span>';
    }
  };

  evtSource.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);
      if (payload.snapshot) {
        appState.stages = payload.snapshot.stages || appState.stages;
        appState.metrics = payload.snapshot.metrics || appState.metrics;
        appState.sessions = payload.snapshot.sessions || [];
        if (
          (!selectedSessionId ||
            !appState.sessions.some((s) => s.id === selectedSessionId)) &&
          appState.sessions.length > 0
        ) {
          selectedSessionId = appState.sessions[0].id;
        }
        renderAll();
      }
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  };

  evtSource.onerror = () => {
    if (statusEl) {
      statusEl.innerHTML =
        '<span class="dot warning"></span><span>Reconnecting...</span>';
    }
  };
}

function renderHooksButton() {
  const btn = document.getElementById('hooks-btn');
  if (!btn) return;
  if (appState.hooks && appState.hooks.installed) {
    btn.className = 'btn btn-success';
    btn.innerHTML = `🟢 Claude Hooks เชื่อมต่อแล้ว (${appState.hooks.installedEvents.length} events)`;
  } else {
    btn.className = 'btn btn-warning';
    btn.innerHTML = '⚡ คลิกเพื่อผูก Claude CLI Hooks อัตโนมัติ';
  }
}

async function handleInstallHooks() {
  try {
    const res = await fetch('/api/hooks/install', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      appState.hooks = data;
      renderHooksButton();
      showToast(
        `✅ ผูก Claude Code Hooks เข้ากับ ${data.settingsPath} สำเร็จ!`
      );
    }
  } catch (err) {
    showToast('❌ ติดตั้ง Hooks ไม่สำเร็จ: ' + err.message);
  }
}

window.scanTerminalsNow = async function () {
  try {
    const res = await fetch('/api/console/scan', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      showToast('🔄 สแกนหน้าจอ Claude Terminal ทุก Tab เรียบร้อย!');
    }
  } catch (err) {
    showToast('❌ สแกนไม่สำเร็จ: ' + err.message);
  }
};

function renderMetrics() {
  const m = appState.metrics;
  const el = document.getElementById('metrics-section');
  if (!el) return;

  el.innerHTML = `
    <div class="metric-card ${m.needsInput > 0 ? 'alert-border' : ''}">
      <div>
        <div class="metric-label">⚠️ รอคุณเลือกตอบ / Approve (Attention)</div>
        <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">คลิกเลือกตัวเลือกจากหน้าเว็บได้ทันที</div>
      </div>
      <div class="metric-value" style="color: ${m.needsInput > 0 ? 'var(--warning)' : 'var(--text)'};">
        ${m.needsInput}
      </div>
    </div>

    <div class="metric-card">
      <div>
        <div class="metric-label">⚡ ห้องที่กำลังรันงาน (Active Rooms)</div>
        <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">จากทั้งหมด ${m.totalRooms} ห้องที่เปิดอยู่</div>
      </div>
      <div class="metric-value" style="color: var(--primary);">
        ${m.working} <span style="font-size:14px; color:var(--text-muted);">/ ${m.totalRooms}</span>
      </div>
    </div>

    <div class="metric-card">
      <div>
        <div class="metric-label">🤖 Sub-Agents ที่กำลังทำงาน</div>
        <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">แตก Task ขนานรวม ${m.totalSubAgents} ตัว</div>
      </div>
      <div class="metric-value" style="color: var(--purple);">
        ${m.activeSubAgents}
      </div>
    </div>

    <div class="metric-card">
      <div>
        <div class="metric-label">✅ ห้องที่เสร็จรอบคำสั่ง (Ready)</div>
        <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">พร้อมตรวจผลหรือสั่งงานต่อ</div>
      </div>
      <div class="metric-value" style="color: var(--success);">
        ${m.done}
      </div>
    </div>
  `;
}

/**
 * Renders interactive multiple-choice buttons for a session waiting on a Claude TUI menu
 * (such as `Try the new fullscreen renderer? 1. Yes, try it / 2. Not now`, permission prompts, etc.)
 */
function buildInteractiveChoiceBoxHtml(s, compact = false) {
  const prompt = s.interactivePrompt;
  if (!prompt || !Array.isArray(prompt.options) || prompt.options.length === 0) {
    if (!s.pendingAction) return '';
    return `
      <div class="attention-banner">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
          <div>
            <strong style="color:#fbbf24;">⚠️ รอการยืนยัน:</strong>
            <span class="mono" style="margin-left:8px;">${escapeHtml(s.pendingAction)}</span>
          </div>
          <div style="display:flex; gap:6px;">
            <button class="btn btn-warning" onclick="event.stopPropagation(); quickApprove('${escapeJsAttr(s.id)}')">
              ✓ Approve (y)
            </button>
            <button class="btn" onclick="event.stopPropagation(); sendTerminalKey('${escapeJsAttr(s.id)}', 'enter')">
              ↵ กด Enter
            </button>
            <button class="btn" onclick="event.stopPropagation(); sendTerminalKey('${escapeJsAttr(s.id)}', 'esc')">
              Esc ยกเลิก
            </button>
          </div>
        </div>
      </div>
    `;
  }

  const currentIdx = prompt.currentIndex || 1;
  const contextHtml =
    !compact && Array.isArray(prompt.context) && prompt.context.length > 0
      ? `<div style="font-size:12.5px; color:var(--text-muted); display:flex; flex-direction:column; gap:2px; padding-left:4px;">
          ${prompt.context.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}
        </div>`
      : '';

  const optionsHtml = prompt.options
    .map((opt) => {
      const isCursor = opt.active || opt.index === currentIdx;
      return `
        <button class="choice-btn ${isCursor ? 'active-cursor' : ''}"
                onclick="event.stopPropagation(); selectChoiceOption('${escapeJsAttr(s.id)}', ${opt.index}, ${currentIdx}, '${escapeJsAttr(opt.number)}', '${escapeJsAttr(opt.label)}')">
          <div style="display:flex; align-items:center;">
            <span class="choice-num">${escapeHtml(opt.number)}</span>
            <span>${escapeHtml(opt.label)}</span>
          </div>
          <span class="mono" style="font-size:11.5px; color:${isCursor ? '#fbbf24' : 'var(--text-muted)'};">
            ${isCursor ? '❯ เลือกอยู่ (คลิกเพื่อกดยืนยัน)' : 'คลิกเพื่อเลือกข้อนี้ ↵'}
          </span>
        </button>
      `;
    })
    .join('');

  const keypadHtml = !compact
    ? `
      <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; padding-top:6px; border-top:1px solid rgba(245, 158, 11, 0.25);">
        <span style="font-size:11.5px; color:var(--text-muted);">
          💡 ${escapeHtml(prompt.footer || 'คลิกตัวเลือกด้านบน หรือใช้ปุ่มควบคุม TUI ด้านขวา')}
        </span>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button class="btn" onclick="event.stopPropagation(); sendTerminalKey('${escapeJsAttr(s.id)}', 'up')">
            ↑ เลื่อนขึ้น
          </button>
          <button class="btn" onclick="event.stopPropagation(); sendTerminalKey('${escapeJsAttr(s.id)}', 'down')">
            ↓ เลื่อนลง
          </button>
          <button class="btn btn-warning" onclick="event.stopPropagation(); sendTerminalKey('${escapeJsAttr(s.id)}', 'enter')">
            ↵ กด Enter ยืนยันข้อที่เลือกอยู่
          </button>
          <button class="btn" onclick="event.stopPropagation(); sendTerminalKey('${escapeJsAttr(s.id)}', 'esc')">
            Esc ยกเลิก
          </button>
        </div>
      </div>
    `
    : '';

  return `
    <div class="choice-card">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
        <div style="font-weight:700; font-size:14.5px; color:#fbbf24;">
          ❓ ${escapeHtml(prompt.question)}
        </div>
        <span class="pill mono" style="color:#fbbf24; border-color:rgba(245,158,11,0.4);">
          ${s.pid ? `Live Console PID ${s.pid}` : 'Interactive Prompt'}
        </span>
      </div>
      ${contextHtml}
      <div class="choice-options-list">
        ${optionsHtml}
      </div>
      ${keypadHtml}
    </div>
  `;
}

function renderAttentionBanner() {
  const el = document.getElementById('attention-section');
  if (!el) return;
  const waitingRooms = appState.sessions.filter(
    (s) => s.status === 'needs_input'
  );
  if (waitingRooms.length === 0) {
    el.style.display = 'none';
    return;
  }

  const target = waitingRooms[0];
  el.style.display = 'block';

  if (target.interactivePrompt) {
    const p = target.interactivePrompt;
    const currentIdx = p.currentIndex || 1;
    el.innerHTML = `
      <div class="attention-banner">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <div style="display:flex; align-items:center; gap:10px;">
            <span class="dot warning"></span>
            <strong style="color:#fbbf24; font-size:14.5px;">
              ⚠️ [${escapeHtml(target.room)}] กำลังรอให้คุณเลือกคำตอบ: "${escapeHtml(p.question)}"
            </strong>
          </div>
          <button class="btn" onclick="selectSession('${escapeJsAttr(target.id)}')">
            🔍 เปิดดูห้องนี้
          </button>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:8px;">
          ${p.options
            .map(
              (opt) => `
              <button class="btn ${opt.active ? 'btn-warning' : ''}"
                      onclick="selectChoiceOption('${escapeJsAttr(target.id)}', ${opt.index}, ${currentIdx}, '${escapeJsAttr(opt.number)}', '${escapeJsAttr(opt.label)}')">
                <b>[${escapeHtml(opt.number)}]</b> ${escapeHtml(opt.label)} ${opt.active ? '❯' : ''}
              </button>
            `
            )
            .join('')}
          <button class="btn" onclick="sendTerminalKey('${escapeJsAttr(target.id)}', 'esc')">
            Esc ยกเลิก
          </button>
        </div>
      </div>
    `;
    return;
  }

  el.innerHTML = `
    <div class="attention-banner">
      <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;">
        <div style="display:flex; align-items:center; gap:10px;">
          <span class="dot warning"></span>
          <div>
            <strong style="color:#fbbf24;">⚠️ ${escapeHtml(target.room)} กำลังรอการอนุมัติจากคุณ:</strong>
            <span class="mono" style="margin-left:8px; background:rgba(0,0,0,0.35); padding:3px 8px; border-radius:6px;">
              ${escapeHtml(target.pendingAction || target.tldr)}
            </span>
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-warning" onclick="quickApprove('${escapeJsAttr(target.id)}')">
            ✓ Approve & ให้ทำต่อทันที
          </button>
          <button class="btn" onclick="selectSession('${escapeJsAttr(target.id)}')">
            🔍 ดูรายละเอียดห้องนี้
          </button>
        </div>
      </div>
    </div>
  `;
}

function buildPipelineHtml(session) {
  return `
    <div class="pipeline-bar">
      ${appState.stages
        .map((st, idx) => {
          const isDone = idx < session.stageIndex || session.status === 'done';
          const isCurrent =
            idx === session.stageIndex && session.status !== 'done';
          const cls = isCurrent ? 'current' : isDone ? 'done' : '';
          const prefix = isDone ? '✓ ' : isCurrent ? '● ' : '';
          return `<div class="stage-step ${cls}">${prefix}${escapeHtml(st.label)}</div>`;
        })
        .join('')}
    </div>
  `;
}

function buildRoomCardHtml(s, isDetailedGrid = false) {
  const isSelected = s.id === selectedSessionId;
  const dotClass =
    s.status === 'needs_input'
      ? 'warning'
      : s.status === 'working'
      ? 'primary'
      : 'success';
  const cardBorderClass =
    s.status === 'needs_input'
      ? 'needs-input'
      : s.status === 'working'
      ? 'working'
      : 'done';

  const activeSubs = (s.subAgents || []).filter(
    (sub) => sub.state === 'working' || sub.state === 'waiting'
  ).length;

  // Quick inline buttons on the card itself if interactivePrompt is active
  const inlineChoicesHtml =
    s.interactivePrompt && Array.isArray(s.interactivePrompt.options)
      ? `
        <div style="display:flex; flex-direction:column; gap:6px; padding:9px 11px; border-radius:8px; background:rgba(245, 158, 11, 0.1); border:1px solid rgba(245, 158, 11, 0.45);">
          <div style="font-size:12px; font-weight:700; color:#fbbf24;">
            ❓ ${escapeHtml(s.interactivePrompt.question)}
          </div>
          <div style="display:flex; flex-wrap:wrap; gap:6px;">
            ${s.interactivePrompt.options
              .map(
                (opt) => `
                <button class="btn ${opt.active ? 'btn-warning' : ''}"
                        style="padding:5px 10px; font-size:12px;"
                        onclick="event.stopPropagation(); selectChoiceOption('${escapeJsAttr(s.id)}', ${opt.index}, ${s.interactivePrompt.currentIndex || 1}, '${escapeJsAttr(opt.number)}', '${escapeJsAttr(opt.label)}')">
                  <b>${escapeHtml(opt.number)}.</b> ${escapeHtml(opt.label)}
                </button>
              `
              )
              .join('')}
          </div>
        </div>
      `
      : '';

  return `
    <div class="room-card ${cardBorderClass} ${isSelected ? 'selected' : ''}"
         onclick="selectSession('${escapeJsAttr(s.id)}')">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
        <div style="display:flex; align-items:center; gap:8px; font-weight:700; font-size:15px;">
          <span class="dot ${dotClass}"></span>
          <span>${escapeHtml(s.room)}</span>
        </div>
        <span class="status-badge ${escapeHtml(s.status)}">
          ${escapeHtml(s.statusLabel)}
        </span>
      </div>

      <div style="font-size:13px; color:var(--text); font-weight:500;">
        🎯 ${escapeHtml(s.goal)}
      </div>

      ${buildPipelineHtml(s)}

      ${inlineChoicesHtml}

      <div style="background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:9px 11px; font-size:12.5px; color:var(--text-muted);">
        <strong style="color:var(--text);">📌 สรุปล่าสุด (TL;DR):</strong>
        ${escapeHtml(s.tldr)}
      </div>

      ${
        isDetailedGrid && s.subAgents && s.subAgents.length > 0
          ? `<div style="display:flex; flex-direction:column; gap:5px;">
              ${s.subAgents
                .map(
                  (sub) => `
                <div style="display:flex; justify-content:space-between; font-size:12px; background:var(--bg); padding:6px 10px; border-radius:6px; border:1px solid var(--border);">
                  <span>🤖 <b>${escapeHtml(sub.name)}</b> — ${escapeHtml(sub.role)}</span>
                  <span class="mono" style="color:${sub.state === 'working' ? 'var(--primary)' : 'var(--success)'};">[${escapeHtml(sub.tool)}]</span>
                </div>`
                )
                .join('')}
            </div>`
          : ''
      }

      <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; color:var(--text-muted);" class="mono">
        <span>🌿 ${escapeHtml(s.branch)} ${s.dirtyFiles ? `(${s.dirtyFiles} modified)` : ''}</span>
        <span>${s.pid ? `🟢 PID ${s.pid} • ` : ''}🤖 ${(s.subAgents || []).length} Sub (${activeSubs} active)</span>
      </div>
    </div>
  `;
}

function buildInspectorHtml(s) {
  if (!s) {
    return `
      <div class="inspector" style="text-align:center; padding:48px; color:var(--text-muted);">
        ยังไม่มีห้องที่เลือก กดปุ่ม <b>"+ เปิดห้อง Agent ใหม่"</b> หรือ <b>"🔄 สแกนหน้าจอ Terminal ทันที"</b> ด้านบนได้เลยครับ
      </div>
    `;
  }

  const subAgentsHtml =
    s.subAgents && s.subAgents.length > 0
      ? s.subAgents
          .map((sub) => {
            const color =
              sub.state === 'working'
                ? 'var(--primary)'
                : sub.state === 'waiting'
                ? 'var(--warning)'
                : 'var(--success)';
            return `
            <div class="subagent-row">
              <div>
                <div style="font-weight:600; font-size:13px;">
                  🤖 ${escapeHtml(sub.name)}
                </div>
                <div style="font-size:12px; color:var(--text-muted);">
                  ${escapeHtml(sub.role)}
                </div>
              </div>
              <span class="mono" style="color:${color}; font-weight:600;">
                [${escapeHtml(sub.tool)}]
              </span>
            </div>
          `;
          })
          .join('')
      : `<div style="color:var(--text-muted); font-size:12.5px;">ห้องนี้ยังไม่ได้แตก Sub-agent (รันอยู่ใน Main Agent ตัวหลัก)</div>`;

  const filesHtml =
    s.modifiedFiles && s.modifiedFiles.length > 0
      ? `<div style="display:flex; flex-wrap:wrap; gap:6px;">
          ${s.modifiedFiles
            .map(
              (f) =>
                `<span class="pill mono" style="color:var(--text);">📄 ${escapeHtml(f)}</span>`
            )
            .join('')}
        </div>`
      : `<span style="color:var(--text-muted); font-size:12px;">ยังไม่มีไฟล์ที่ถูกแก้ไขในรอบนี้</span>`;

  const eventsHtml =
    s.recentEvents && s.recentEvents.length > 0
      ? s.recentEvents
          .slice(0, 6)
          .map(
            (ev) => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--border); font-size:12.5px;">
            <span>${escapeHtml(ev.title)}</span>
            <span class="mono" style="color:var(--text-muted); font-size:11.5px;">[${escapeHtml(ev.badge)}]</span>
          </div>
        `
          )
          .join('')
      : `<div style="color:var(--text-muted); font-size:12px;">ยังไม่มีประวัติ Event</div>`;

  const screenPreviewHtml = s.screenPreview
    ? `
      <div class="section-box">
        <div class="section-title">
          <span>🖥️ หน้าจอ Terminal ล่าสุด (Live Console Screen Buffer — PID ${escapeHtml(s.pid || 'N/A')})</span>
          <div style="display:flex; gap:6px;">
            <button class="btn" style="padding:3px 8px; font-size:11px;" onclick="sendTerminalKey('${escapeJsAttr(s.id)}', 'up')">↑</button>
            <button class="btn" style="padding:3px 8px; font-size:11px;" onclick="sendTerminalKey('${escapeJsAttr(s.id)}', 'down')">↓</button>
            <button class="btn" style="padding:3px 8px; font-size:11px;" onclick="sendTerminalKey('${escapeJsAttr(s.id)}', 'enter')">↵ Enter</button>
            <button class="btn" style="padding:3px 8px; font-size:11px;" onclick="sendTerminalKey('${escapeJsAttr(s.id)}', 'esc')">Esc</button>
            <button class="btn" style="padding:3px 8px; font-size:11px;" onclick="scanTerminalsNow()">🔄 รีเฟรชจอ</button>
          </div>
        </div>
        <div class="terminal-preview">${escapeHtml(s.screenPreview)}</div>
      </div>
    `
    : '';

  return `
    <div class="inspector">
      <!-- Room Header -->
      <div style="display:flex; flex-wrap:wrap; justify-content:space-between; align-items:flex-start; gap:12px; padding-bottom:12px; border-bottom:1px solid var(--border);">
        <div>
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <h2 style="font-size:19px; font-weight:700;">${escapeHtml(s.room)}</h2>
            <span class="pill mono">${escapeHtml(s.cli)}</span>
            <span class="pill mono">🌿 ${escapeHtml(s.branch)}</span>
            ${s.pid ? `<span class="pill mono" style="color:var(--success);">🟢 Connected PID ${s.pid}</span>` : ''}
          </div>
          <div class="mono" style="font-size:12px; color:var(--text-muted); margin-top:4px;">
            📁 ${escapeHtml(s.cwd || 'Local Workspace')} • Session ID: ${escapeHtml(s.id)}
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn" onclick="openRoomTerminal('${escapeJsAttr(s.id)}')">
            🖥️ เปิดใน Windows Terminal Tab
          </button>
          <button class="btn" onclick="removeRoom('${escapeJsAttr(s.id)}')">
            🗑️ ปิดการ์ดห้องนี้
          </button>
        </div>
      </div>

      <!-- Interactive Choice Card (Shows prominent selectable options whenever Claude asks a multiple-choice / TUI question) -->
      ${buildInteractiveChoiceBoxHtml(s, false)}

      <!-- Current Goal & Workflow Stage -->
      <div>
        <div class="section-title">
          <span>📊 ขั้นตอนการทำงานปัจจุบัน (Workflow Pipeline)</span>
          <span class="mono" style="color:var(--primary);">Active Tool: ${escapeHtml(s.currentTool || 'Idle')}</span>
        </div>
        ${buildPipelineHtml(s)}
      </div>

      <!-- Auto-TL;DR Summary Box -->
      <div class="section-box" style="border-color: rgba(59, 130, 246, 0.4);">
        <div class="section-title">
          <span>📌 Auto-TL;DR (สรุปสถานะล่าสุดโดยไม่ต้องเปิดอ่าน History ใน Tab)</span>
          <span>🎯 เป้าหมาย: ${escapeHtml(s.goal)}</span>
        </div>
        <div style="font-size:14px; color:var(--text); line-height:1.6;">
          ${escapeHtml(s.tldr)}
        </div>
      </div>

      <!-- Live Terminal Screen Buffer Preview -->
      ${screenPreviewHtml}

      <!-- Sub-Agent Hierarchy Tree -->
      <div class="section-box">
        <div class="section-title">
          <span>🌳 โครงสร้าง Sub-Agents ที่ทำงานอยู่ใน Session นี้ (${(s.subAgents || []).length} ตัว)</span>
          <span>Main Agent → Child Tasks</span>
        </div>
        ${subAgentsHtml}
      </div>

      <!-- Modified Files & Structured Event Timeline -->
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
        <div class="section-box">
          <div class="section-title"><span>📄 ไฟล์ที่แก้ไขในห้องนี้</span></div>
          ${filesHtml}
        </div>
        <div class="section-box">
          <div class="section-title"><span>⚡ กิจกรรมล่าสุด (Structured Events)</span></div>
          ${eventsHtml}
        </div>
      </div>

      <!-- Central Command Center -->
      <div class="section-box" style="background:var(--surface-elevated);">
        <div class="section-title">
          <span>⌨️ สั่งการไปยัง ${escapeHtml(s.room)} โดยตรง (ส่งเข้า Console Tab ทันที)</span>
          <label style="display:flex; align-items:center; gap:6px; text-transform:none; font-weight:500; cursor:pointer;">
            <input type="checkbox" id="headless-toggle" />
            <span>รันผ่าน Claude Headless Resume (--resume)</span>
          </label>
        </div>

        <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px;">
          <button class="btn" onclick="sendQuickCommand('${escapeJsAttr(s.id)}', '1', true)">
            1️⃣ เลือกข้อ 1
          </button>
          <button class="btn" onclick="sendQuickCommand('${escapeJsAttr(s.id)}', '2', true)">
            2️⃣ เลือกข้อ 2
          </button>
          <button class="btn" onclick="sendTerminalKey('${escapeJsAttr(s.id)}', 'enter')">
            ↵ ส่งปุ่ม Enter
          </button>
          <button class="btn" onclick="sendQuickCommand('${escapeJsAttr(s.id)}', 'รันชุดทดสอบ (test) และสรุปผลสั้นๆ ให้หน่อย')">
            🧪 สั่งรัน Test & สรุปผล
          </button>
          <button class="btn" onclick="sendQuickCommand('${escapeJsAttr(s.id)}', 'สรุปสิ่งที่แก้ไขไปทั้งหมดพร้อมตรวจสอบ git status')">
            📝 ขอสรุปงานที่ทำเสร็จแล้ว
          </button>
          <button class="btn" onclick="simulateSubAgent('${escapeJsAttr(s.id)}')">
            🤖 จำลองการแตก Sub-Agent
          </button>
        </div>

        <div class="cmd-bar">
          <input id="cmd-input" class="input-text"
                 placeholder="พิมพ์คำสั่งหรือหมายเลขตัวเลือก ส่งเข้า ${escapeHtml(s.room)} แล้วกด Enter..."
                 onkeydown="if(event.key==='Enter') submitCommand('${escapeJsAttr(s.id)}')" />
          <button class="btn btn-primary" onclick="submitCommand('${escapeJsAttr(s.id)}')">
            ส่งคำสั่ง ↵
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderWorkspace() {
  const container = document.getElementById('main-workspace');
  if (!container) return;

  if (viewMode === 'grid') {
    container.innerHTML = `
      <div class="grid-layout">
        ${appState.sessions.map((s) => buildRoomCardHtml(s, true)).join('')}
      </div>
    `;
    return;
  }

  const activeSession =
    appState.sessions.find((s) => s.id === selectedSessionId) ||
    appState.sessions[0];

  container.innerHTML = `
    <div class="split-layout">
      <div class="room-list">
        ${appState.sessions.map((s) => buildRoomCardHtml(s, false)).join('')}
      </div>
      <div>
        ${buildInspectorHtml(activeSession)}
      </div>
    </div>
  `;
}

function renderAll() {
  renderHooksButton();
  renderMetrics();
  renderAttentionBanner();
  renderWorkspace();
}

window.selectSession = function (sessionId) {
  selectedSessionId = sessionId;
  if (viewMode === 'grid') {
    viewMode = 'split';
  }
  renderWorkspace();
};

window.toggleViewMode = function () {
  viewMode = viewMode === 'split' ? 'grid' : 'split';
  renderWorkspace();
};

window.selectChoiceOption = async function (
  sessionId,
  targetIndex,
  currentIndex,
  numberStr,
  labelStr
) {
  try {
    const res = await fetch('/api/session/select-option', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        targetIndex,
        currentIndex,
        number: numberStr,
        label: labelStr,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`✅ ${data.message}`);
    } else {
      showToast(`⚠️ ${data.error || data.message}`);
    }
  } catch (err) {
    showToast('❌ ส่งตัวเลือกไม่สำเร็จ: ' + err.message);
  }
};

window.sendTerminalKey = async function (sessionId, keyName) {
  try {
    const res = await fetch('/api/session/send-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        key: keyName,
      }),
    });
    const data = await res.json();
    showToast(data.ok ? `⌨️ ${data.message}` : `ℹ️ ${data.message}`);
  } catch (err) {
    showToast('❌ ส่งปุ่มไม่สำเร็จ: ' + err.message);
  }
};

window.quickApprove = async function (sessionId) {
  await sendQuickCommand(sessionId, '1', true);
};

window.sendQuickCommand = async function (
  sessionId,
  command,
  isApproval = false
) {
  const headlessEl = document.getElementById('headless-toggle');
  const runHeadless = headlessEl ? headlessEl.checked : false;

  try {
    const res = await fetch('/api/session/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        command,
        isApproval,
        runHeadless,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`✅ ${data.message}`);
    }
  } catch (err) {
    showToast('❌ ส่งคำสั่งไม่สำเร็จ: ' + err.message);
  }
};

window.submitCommand = async function (sessionId) {
  const input = document.getElementById('cmd-input');
  if (!input || !input.value.trim()) return;
  const text = input.value.trim();
  input.value = '';
  await sendQuickCommand(sessionId, text, false);
};

window.simulateSubAgent = async function (sessionId) {
  const session = appState.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  await fetch('/api/hook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      cwd: session.cwd,
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_use_id: `sub-${Date.now()}`,
      tool_input: {
        description: 'Parallel Code Reviewer & Test Writer',
        subagent_type: 'code-reviewer',
        prompt: 'ตรวจสอบ Edge Cases และเขียน Unit Test ครอบคลุมฟังก์ชันล่าสุด',
      },
    }),
  });
  showToast(`🤖 แตก Sub-Agent ตัวใหม่ใน ${session.room} เรียบร้อย!`);
};

window.openRoomTerminal = async function (sessionId) {
  try {
    const res = await fetch('/api/session/open-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    const data = await res.json();
    showToast(`🖥️ ${data.message}`);
  } catch (err) {
    showToast('❌ ไม่สามารถเปิด Terminal: ' + err.message);
  }
};

window.removeRoom = async function (sessionId) {
  await fetch('/api/session/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'remove', sessionId }),
  });
  showToast('🗑️ ปิดการ์ดห้องเรียบร้อย');
};

window.seedDemoData = async function () {
  await fetch('/api/demo/seed', { method: 'POST' });
  showToast('🧪 โหลดข้อมูลจำลองพร้อมห้องที่มีตัวเลือก Interactive เรียบร้อย');
};

window.openSpawnModal = function () {
  document.getElementById('spawn-modal').classList.add('open');
};

window.closeSpawnModal = function () {
  document.getElementById('spawn-modal').classList.remove('open');
};

window.submitSpawnRoom = async function () {
  const room = document.getElementById('spawn-room').value.trim();
  const cwd = document.getElementById('spawn-cwd').value.trim();
  const goal = document.getElementById('spawn-goal').value.trim();
  const openTerminal = document.getElementById('spawn-open-wt').checked;
  const runHeadless = document.getElementById('spawn-headless').checked;

  const res = await fetch('/api/session/spawn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room,
      cwd,
      goal,
      openTerminal,
      runHeadless,
    }),
  });
  const data = await res.json();
  if (data.ok && data.session) {
    selectedSessionId = data.session.id;
    closeSpawnModal();
    showToast(`🚀 เปิดห้อง "${data.session.room}" เรียบร้อย!`);
  }
};

fetchInitialState();
connectSSE();
