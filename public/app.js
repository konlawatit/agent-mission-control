let appState = {
  stages: [
    { index: 0, id: 'plan', label: '1. Plan & Explore' },
    { index: 1, id: 'code', label: '2. Implement & Code' },
    { index: 2, id: 'verify', label: '3. Verify & Test' },
    { index: 3, id: 'done', label: '4. Done / Ready' },
  ],
  metrics: {
    totalRooms: 0,
    liveRooms: 0,
    historyRooms: 0,
    pinnedRooms: 0,
    needsInput: 0,
    working: 0,
    done: 0,
    activeSubAgents: 0,
    totalSubAgents: 0,
  },
  projects: [],
  categories: [],
  sessions: [],
  hooks: { installed: false, installedEvents: [] },
};

let selectedSessionId = null;
let mountedInspectorSessionId = null;
let viewMode = 'split'; // 'split' | 'grid'
let activeTab = 'live'; // 'live' | 'needs_input' | 'history' | 'by_project' | 'pinned' | 'all'
let searchQuery = '';
let selectedProject = 'ALL';
let selectedCategory = 'ALL';
let isChatFullscreen = false;
let terminalFontSize = 13;

// Persist user scroll state per session so scrolling never jumps back to top
const terminalScrollState = new Map(); // sessionId -> { scrollTop, stickToBottom }

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders a click action as data attributes instead of an inline onclick handler.
 * Arguments are JSON-encoded and HTML-escaped, so untrusted text from the terminal
 * (option labels, room names, ids) can never break out into executable JS.
 */
const ACTIONS = new Set([
  'switchTab',
  'quickApprove',
  'sendTerminalKey',
  'selectChoiceOption',
  'selectSession',
  'resumeSession',
  'togglePinRoom',
  'openEditModal',
  'archiveRoom',
  'removeRoomPermanent',
  'sendQuickCommand',
  'submitCommand',
]);

function act(name, ...args) {
  return `data-act="${escapeHtml(name)}" data-args="${escapeHtml(JSON.stringify(args))}"`;
}

function runAction(el, attr) {
  const name = el.getAttribute(attr);
  if (!ACTIONS.has(name) || typeof window[name] !== 'function') return;
  let args;
  try {
    args = JSON.parse(el.getAttribute('data-args') || '[]');
  } catch {
    return;
  }
  window[name](...args);
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  // A nested element with its own static onclick handles the click itself.
  const inner = e.target.closest('[onclick]');
  if (inner && inner !== el && el.contains(inner)) return;
  runAction(el, 'data-act');
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.closest) return;
  const el = e.target.closest('[data-enter-act]');
  if (el) runAction(el, 'data-enter-act');
});

// Every API call carries the per-install token the server embeds in index.html.
const AMC_TOKEN =
  (document.querySelector('meta[name="amc-token"]') || {}).content || '';

function apiFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), 'X-AMC-Token': AMC_TOKEN },
  });
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return '';
  const diffSec = Math.max(
    0,
    Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000)
  );
  if (diffSec < 15) return 'เมื่อสักครู่';
  if (diffSec < 60) return `${diffSec} วินาทีที่แล้ว`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} นาทีที่แล้ว`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} ชั่วโมงที่แล้ว`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} วันที่แล้ว`;
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    el.style.display = 'none';
  }, 4200);
}

async function fetchInitialState() {
  try {
    const res = await apiFetch('/api/state');
    const data = await res.json();
    if (data.ok) {
      appState = { ...appState, ...data };
      ensureValidSelection();
      renderAll();
    }
  } catch (err) {
    console.error('Failed to load initial state:', err);
  }
}

function connectSSE() {
  const evtSource = new EventSource(`/api/events?token=${encodeURIComponent(AMC_TOKEN)}`);
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
        appState.projects = payload.snapshot.projects || [];
        appState.categories = payload.snapshot.categories || [];
        appState.sessions = payload.snapshot.sessions || [];
        ensureValidSelection();
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

function getFilteredSessions() {
  return appState.sessions.filter((s) => {
    if (activeTab === 'live' && s.lifecycle !== 'live') return false;
    if (
      activeTab === 'needs_input' &&
      !(s.lifecycle === 'live' && s.status === 'needs_input')
    ) {
      return false;
    }
    if (activeTab === 'history' && s.lifecycle !== 'history') return false;
    if (activeTab === 'pinned' && !s.pinned) return false;

    if (selectedProject !== 'ALL' && s.project !== selectedProject) {
      return false;
    }
    if (selectedCategory !== 'ALL' && s.category !== selectedCategory) {
      return false;
    }

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      const hay = [
        s.room,
        s.project,
        s.category,
        s.cwd,
        s.branch,
        s.goal,
        s.tldr,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }

    return true;
  });
}

function ensureValidSelection() {
  const filtered = getFilteredSessions();
  if (
    filtered.length > 0 &&
    (!selectedSessionId || !filtered.some((s) => s.id === selectedSessionId))
  ) {
    selectedSessionId = filtered[0].id;
  } else if (filtered.length === 0) {
    selectedSessionId = null;
  }
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
    const res = await apiFetch('/api/hooks/install', { method: 'POST' });
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
    const res = await apiFetch('/api/console/scan', { method: 'POST' });
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
    <div class="metric-card" onclick="switchTab('live')">
      <div>
        <div class="metric-label">🟢 เปิดอยู่ตอนนี้ (Live Sessions)</div>
        <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">Terminal Tab ที่กำลังทำงานอยู่</div>
      </div>
      <div class="metric-value" style="color: var(--success);">
        ${m.liveRooms || 0}
      </div>
    </div>

    <div class="metric-card ${m.needsInput > 0 ? 'alert-border' : ''}" onclick="switchTab('needs_input')">
      <div>
        <div class="metric-label">⚠️ รอคุณเลือกตอบ / Approve</div>
        <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">คลิกเลือกตัวเลือกจากหน้าเว็บได้ทันที</div>
      </div>
      <div class="metric-value" style="color: ${m.needsInput > 0 ? 'var(--warning)' : 'var(--text)'};">
        ${m.needsInput || 0}
      </div>
    </div>

    <div class="metric-card" onclick="switchTab('history')">
      <div>
        <div class="metric-label">🕘 เคยเปิดไว้ / ปิดไปแล้ว (History)</div>
        <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">เผื่อเผลอปิด กด Resume กู้คืนได้ทันที</div>
      </div>
      <div class="metric-value" style="color: #94a3b8;">
        ${m.historyRooms || 0}
      </div>
    </div>

    <div class="metric-card" onclick="switchTab('by_project')">
      <div>
        <div class="metric-label">📁 โปรเจกต์ทั้งหมด & Sub-Agents</div>
        <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">${(appState.projects || []).length} โปรเจกต์ • ${m.activeSubAgents || 0} Active Sub-Agents</div>
      </div>
      <div class="metric-value" style="color: var(--primary);">
        ${(appState.projects || []).length}
      </div>
    </div>
  `;
}

function renderTabsAndFilters() {
  const m = appState.metrics;
  const tabsBar = document.getElementById('tabs-bar');
  if (tabsBar) {
    const tabs = [
      { id: 'live', label: '🟢 เปิดอยู่ตอนนี้ (Live)', count: m.liveRooms || 0 },
      {
        id: 'needs_input',
        label: '⚠️ รอเลือกตอบ',
        count: m.needsInput || 0,
      },
      {
        id: 'history',
        label: '🕘 ประวัติที่ปิดแล้ว (History)',
        count: m.historyRooms || 0,
      },
      {
        id: 'by_project',
        label: '📁 แยกตามโปรเจกต์',
        count: (appState.projects || []).length,
      },
      {
        id: 'pinned',
        label: '📌 ปักหมุด',
        count: m.pinnedRooms || 0,
      },
      { id: 'all', label: '🌐 ทั้งหมด', count: m.totalRooms || 0 },
    ];

    tabsBar.innerHTML = tabs
      .map(
        (t) => `
        <button class="tab-btn ${activeTab === t.id ? 'active' : ''}"
                ${act('switchTab', t.id)}>
          <span>${t.label}</span>
          <span class="tab-count">${t.count}</span>
        </button>
      `
      )
      .join('');
  }

  const projSelect = document.getElementById('project-filter');
  if (projSelect && document.activeElement !== projSelect) {
    const current = selectedProject;
    projSelect.innerHTML =
      `<option value="ALL">📁 ทุกโปรเจกต์ (${(appState.projects || []).length})</option>` +
      (appState.projects || [])
        .map(
          (p) =>
            `<option value="${escapeHtml(p)}" ${current === p ? 'selected' : ''}>📁 ${escapeHtml(p)}</option>`
        )
        .join('');
  }

  const catSelect = document.getElementById('category-filter');
  if (catSelect && document.activeElement !== catSelect) {
    const current = selectedCategory;
    catSelect.innerHTML =
      `<option value="ALL">🏷️ ทุกหมวดหมู่ (${(appState.categories || []).length})</option>` +
      (appState.categories || [])
        .map(
          (c) =>
            `<option value="${escapeHtml(c)}" ${current === c ? 'selected' : ''}>🏷️ ${escapeHtml(c)}</option>`
        )
        .join('');
  }
}

window.switchTab = function (tabId) {
  activeTab = tabId;
  mountedInspectorSessionId = null;
  ensureValidSelection();
  renderTabsAndFilters();
  renderWorkspace();
};

window.handleSearchChange = function (val) {
  searchQuery = val || '';
  mountedInspectorSessionId = null;
  ensureValidSelection();
  renderWorkspace();
};

window.handleProjectFilter = function (val) {
  selectedProject = val || 'ALL';
  mountedInspectorSessionId = null;
  ensureValidSelection();
  renderWorkspace();
};

window.handleCategoryFilter = function (val) {
  selectedCategory = val || 'ALL';
  mountedInspectorSessionId = null;
  ensureValidSelection();
  renderWorkspace();
};

function buildInteractiveChoiceBoxHtml(s, compact = false) {
  if (s.lifecycle === 'history') return '';
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
            <button class="btn btn-warning" ${act('quickApprove', s.id)}>
              ✓ Approve (y)
            </button>
            <button class="btn" ${act('sendTerminalKey', s.id, 'enter')}>
              ↵ กด Enter
            </button>
            <button class="btn" ${act('sendTerminalKey', s.id, 'esc')}>
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
                ${act('selectChoiceOption', s.id, opt.index, currentIdx, opt.number, opt.label)}>
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
          <button class="btn" ${act('sendTerminalKey', s.id, 'up')}>
            ↑ เลื่อนขึ้น
          </button>
          <button class="btn" ${act('sendTerminalKey', s.id, 'down')}>
            ↓ เลื่อนลง
          </button>
          <button class="btn btn-warning" ${act('sendTerminalKey', s.id, 'enter')}>
            ↵ กด Enter ยืนยันข้อที่เลือกอยู่
          </button>
          <button class="btn" ${act('sendTerminalKey', s.id, 'esc')}>
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
    (s) => s.lifecycle === 'live' && s.status === 'needs_input'
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
          <button class="btn" ${act('selectSession', target.id)}>
            🔍 เปิดดูห้องนี้
          </button>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:8px;">
          ${p.options
            .map(
              (opt) => `
              <button class="btn ${opt.active ? 'btn-warning' : ''}"
                      ${act('selectChoiceOption', target.id, opt.index, currentIdx, opt.number, opt.label)}>
                <b>[${escapeHtml(opt.number)}]</b> ${escapeHtml(opt.label)} ${opt.active ? '❯' : ''}
              </button>
            `
            )
            .join('')}
          <button class="btn" ${act('sendTerminalKey', target.id, 'esc')}>
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
          <button class="btn btn-warning" ${act('quickApprove', target.id)}>
            ✓ Approve & ให้ทำต่อทันที
          </button>
          <button class="btn" ${act('selectSession', target.id)}>
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
            idx === session.stageIndex &&
            session.status !== 'done' &&
            session.lifecycle === 'live';
          const cls = isCurrent ? 'current' : isDone ? 'done' : '';
          const prefix = isDone ? '✓ ' : isCurrent ? '● ' : '';
          return `<div class="stage-step ${cls}">${prefix}${escapeHtml(st.label)}</div>`;
        })
        .join('')}
    </div>
  `;
}

function buildRoomCardHtml(s) {
  const isSelected = s.id === selectedSessionId;
  const isHistory = s.lifecycle === 'history';
  const dotClass = isHistory
    ? 'closed'
    : s.status === 'needs_input'
    ? 'warning'
    : s.status === 'working'
    ? 'primary'
    : 'success';
  const cardBorderClass = isHistory
    ? 'closed-card'
    : s.status === 'needs_input'
    ? 'needs-input'
    : s.status === 'working'
    ? 'working'
    : 'done';

  const inlineChoicesHtml =
    !isHistory &&
    s.interactivePrompt &&
    Array.isArray(s.interactivePrompt.options)
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
                        ${act('selectChoiceOption', s.id, opt.index, s.interactivePrompt.currentIndex || 1, opt.number, opt.label)}>
                  <b>${escapeHtml(opt.number)}.</b> ${escapeHtml(opt.label)}
                </button>
              `
              )
              .join('')}
          </div>
        </div>
      `
      : '';

  const historyActionHtml = isHistory
    ? `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding-top:4px;">
        <span style="font-size:11.5px; color:var(--text-muted);">
          🕘 ปิดเมื่อ ${formatRelativeTime(s.closedAt || s.updatedAt)}
        </span>
        <button class="btn btn-success" style="padding:5px 11px; font-size:12px;"
                ${act('resumeSession', s.id)}>
          🔄 กู้คืน / เปิดต่อใน Terminal
        </button>
      </div>
    `
    : '';

  return `
    <div class="room-card ${cardBorderClass} ${isSelected ? 'selected' : ''}"
         ${act('selectSession', s.id)}>
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
        <div style="display:flex; align-items:center; gap:8px; font-weight:700; font-size:15px;">
          <span class="dot ${dotClass}"></span>
          <span>${s.pinned ? '📌 ' : ''}${escapeHtml(s.room)}</span>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <span class="pill" style="font-size:11px; padding:1px 8px;">🏷️ ${escapeHtml(s.category || 'General')}</span>
          <span class="status-badge ${escapeHtml(s.status)}">
            ${escapeHtml(s.statusLabel)}
          </span>
        </div>
      </div>

      <div style="font-size:12px; color:var(--text-muted);" class="mono">
        📁 ${escapeHtml(s.project || '')} • ${escapeHtml(s.cwd || '')}
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

      ${historyActionHtml}

      <div style="display:flex; justify-content:space-between; align-items:center; font-size:11.5px; color:var(--text-muted);" class="mono">
        <span>🌿 ${escapeHtml(s.branch)} ${s.dirtyFiles ? `(${s.dirtyFiles} modified)` : ''}</span>
        <span>📜 ${(s.taskHistory || []).length} งานในห้องนี้ • ${s.pid ? `🟢 PID ${s.pid}` : formatRelativeTime(s.updatedAt)}</span>
      </div>
    </div>
  `;
}

function buildInspectorHeaderHtml(s) {
  const isHistory = s.lifecycle === 'history';
  return `
    <div style="display:flex; flex-wrap:wrap; justify-content:space-between; align-items:flex-start; gap:12px; padding-bottom:12px; border-bottom:1px solid var(--border);">
      <div>
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <h2 style="font-size:19px; font-weight:700;">${s.pinned ? '📌 ' : ''}${escapeHtml(s.room)}</h2>
          <span class="pill">🏷️ ${escapeHtml(s.category || 'General')}</span>
          <span class="pill mono">${escapeHtml(s.cli)}</span>
          <span class="pill mono">🌿 ${escapeHtml(s.branch)}</span>
          ${
            s.pid
              ? `<span class="pill mono" style="color:var(--success);">🟢 Live PID ${s.pid}</span>`
              : `<span class="pill mono" style="color:#94a3b8;">🕘 Saved in History</span>`
          }
        </div>
        <div class="mono" style="font-size:12px; color:var(--text-muted); margin-top:5px;">
          📁 ${escapeHtml(s.cwd || 'Local Workspace')} • เปิดใช้งานแล้ว ${s.openCount || 1} ครั้ง • อัปเดตล่าสุด ${formatRelativeTime(s.updatedAt)}
        </div>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:6px;">
        <button class="btn" ${act('togglePinRoom', s.id, !s.pinned)}>
          ${s.pinned ? '📌 เลิกปักหมุด' : '📌 ปักหมุดกันลืม'}
        </button>
        <button class="btn" ${act('openEditModal', s.id)}>
          ✏️ เปลี่ยนชื่อ / หมวดหมู่
        </button>
        <button class="btn btn-success" ${act('resumeSession', s.id)}>
          🔄 เปิดต่อใน Terminal (Resume)
        </button>
        ${
          !isHistory
            ? `<button class="btn" ${act('archiveRoom', s.id)}>📥 เก็บเข้าประวัติ</button>`
            : `<button class="btn" ${act('removeRoomPermanent', s.id)}>🗑️ ลบถาวร</button>`
        }
      </div>
    </div>
  `;
}

function buildInspectorBodyDynamicHtml(s) {
  const isHistory = s.lifecycle === 'history';

  const recoveryBannerHtml = isHistory
    ? `
      <div class="choice-card" style="border-color: var(--success); background: linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(19, 26, 39, 0.96));">
        <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px;">
          <div>
            <div style="font-weight:700; font-size:15px; color:#34d399;">
              🕘 Session นี้ถูกปิดหน้าต่าง Terminal ไปแล้ว (${formatRelativeTime(s.closedAt || s.updatedAt)})
            </div>
            <div style="font-size:12.5px; color:var(--text-muted); margin-top:3px;">
              ระบบจดจำโฟลเดอร์โปรเจกต์ <code>${escapeHtml(s.cwd)}</code> และประวัติไว้ครบถ้วน กดปุ่มด้านขวาเพื่อเปิด Terminal และคุยต่อจากจุดเดิมได้ทันที
            </div>
          </div>
          <button class="btn btn-success" style="padding:10px 16px; font-size:13.5px;"
                  ${act('resumeSession', s.id)}>
            🔄 กู้คืน / เปิดต่อใน Terminal (Resume Session)
          </button>
        </div>
      </div>
    `
    : '';

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
          .slice(0, 8)
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

  const previousTurns = Array.isArray(s.taskHistory) ? s.taskHistory : [];
  const taskHistoryHtml =
    previousTurns.length > 0
      ? `<div style="display:flex; flex-direction:column; gap:8px; max-height:260px; overflow-y:auto; padding-right:4px;">
          ${previousTurns
            .map(
              (turn, idx) => `
              <div style="padding:10px 12px; border-radius:8px; background:var(--surface); border:1px solid var(--border); display:flex; flex-direction:column; gap:5px;">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                  <div style="font-weight:700; font-size:13px; color:${idx === 0 ? '#60a5fa' : 'var(--text)'};">
                    ${idx === 0 ? '🟢 คำสั่งล่าสุด:' : `🕘 รอบก่อนหน้า #${previousTurns.length - idx}:`} ${escapeHtml(turn.goal)}
                  </div>
                  <span class="mono" style="font-size:11px; color:var(--text-muted); flex-shrink:0;">
                    ${formatRelativeTime(turn.timestamp)}
                  </span>
                </div>
                <div style="font-size:12.5px; color:var(--text-muted); line-height:1.5;">
                  ${escapeHtml(turn.tldr || 'กำลังประมวลผล...')}
                </div>
                ${
                  Array.isArray(turn.tools) && turn.tools.length > 0
                    ? `<div style="display:flex; flex-wrap:wrap; gap:5px; margin-top:2px;">
                        ${turn.tools
                          .slice(0, 6)
                          .map(
                            (t) =>
                              `<span class="pill mono" style="font-size:10.5px; padding:1px 7px;">🔧 ${escapeHtml(t)}</span>`
                          )
                          .join('')}
                      </div>`
                    : ''
                }
              </div>
            `
            )
            .join('')}
        </div>`
      : `<div style="color:var(--text-muted); font-size:12.5px;">ยังไม่มีประวัติคำสั่งก่อนหน้าในห้องนี้</div>`;

  return `
    ${recoveryBannerHtml}
    ${!isHistory ? buildInteractiveChoiceBoxHtml(s, false) : ''}

    <div>
      <div class="section-title">
        <span>📊 ขั้นตอนการทำงานปัจจุบัน (Current Interaction Pipeline)</span>
        <span class="mono" style="color:var(--primary);">Active Tool: ${escapeHtml(s.currentTool || 'Idle')}</span>
      </div>
      ${buildPipelineHtml(s)}
    </div>

    <div class="section-box" style="border-color: rgba(59, 130, 246, 0.45);">
      <div class="section-title">
        <span>📌 การโต้ตอบล่าสุดที่กำลังทำอยู่ (Latest Active Interaction)</span>
        <span>🎯 คำสั่งล่าสุด: ${escapeHtml(s.goal)}</span>
      </div>
      <div style="font-size:14px; color:var(--text); line-height:1.6;">
        ${escapeHtml(s.tldr)}
      </div>
    </div>

    <div class="section-box">
      <div class="section-title">
        <span>📜 ประวัติการสั่งงานและบทสนทนาภายในห้องนี้ (${previousTurns.length} รอบคำสั่ง)</span>
        <span>ไม่สร้างห้องซ้ำ — เก็บประวัติรวมไว้ในห้องเดียว</span>
      </div>
      ${taskHistoryHtml}
    </div>

    <div class="section-box">
      <div class="section-title">
        <span>🌳 โครงสร้าง Sub-Agents ใน Session นี้ (${(s.subAgents || []).length} ตัว)</span>
        <span>Main Agent → Child Tasks</span>
      </div>
      ${subAgentsHtml}
    </div>

    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
      <div class="section-box">
        <div class="section-title"><span>📄 ไฟล์ที่แก้ไขในห้องนี้</span></div>
        ${filesHtml}
      </div>
      <div class="section-box">
        <div class="section-title"><span>⚡ ประวัติเหตุการณ์ (Session Timeline)</span></div>
        ${eventsHtml}
      </div>
    </div>
  `;
}

/**
 * Updates the terminal preview box WITHOUT destroying its DOM node or resetting user scroll!
 */
function syncTerminalPreviewDom(s) {
  const wrapper = document.getElementById('inspector-terminal-box');
  if (!wrapper) return;

  if (!s.screenPreview) {
    wrapper.style.display = 'none';
    return;
  }

  wrapper.style.display = 'block';
  const titleSpan = document.getElementById('terminal-box-title');
  if (titleSpan) {
    titleSpan.textContent =
      s.lifecycle === 'history'
        ? '🖥️ หน้าจอ Terminal ล่าสุด (ภาพหน้าจอก่อนปิด Tab)'
        : `🖥️ หน้าจอ Terminal ล่าสุด (Live Console Buffer — PID ${s.pid || 'N/A'})`;
  }

  const pre = document.getElementById('terminal-preview-content');
  if (!pre) return;

  // Bind scroll listener once so we remember exactly where the user scrolled
  if (!pre.dataset.scrollBound) {
    pre.dataset.scrollBound = '1';
    pre.addEventListener('scroll', () => {
      const isNearBottom =
        pre.scrollHeight - pre.scrollTop - pre.clientHeight <= 28;
      terminalScrollState.set(s.id, {
        scrollTop: pre.scrollTop,
        stickToBottom: isNearBottom,
      });
    });
  }

  const prevText = pre.dataset.rawText || '';
  if (prevText !== s.screenPreview) {
    const saved = terminalScrollState.get(s.id);
    pre.textContent = s.screenPreview;
    pre.dataset.rawText = s.screenPreview;

    // If user hasn't scrolled up manually, or first time viewing, scroll to bottom
    if (!saved || saved.stickToBottom) {
      pre.scrollTop = pre.scrollHeight;
    } else {
      pre.scrollTop = saved.scrollTop;
    }
  }
}

function buildFullInspectorMountHtml(s) {
  if (!s) {
    return `
      <div class="inspector" style="text-align:center; padding:48px 24px; color:var(--text-muted);">
        <div style="font-size:32px; margin-bottom:10px;">🎛️</div>
        <div style="font-size:15px; font-weight:600; color:var(--text); margin-bottom:6px;">
          ไม่พบ Session ในมุมมอง/ตัวกรองนี้
        </div>
        <div style="font-size:13px; max-width:460px; margin:0 auto 16px;">
          เมื่อคุณเปิด <code>claude</code> ใน Windows Terminal หรือ PowerShell ระบบจะตรวจจับและบันทึกห้องให้อัตโนมัติ และหากเผลอปิด Tab ระบบจะย้ายมาเก็บไว้ในแท็บ <b>"🕘 ประวัติที่ปิดแล้ว (History)"</b>
        </div>
        <div style="display:flex; justify-content:center; gap:10px;">
          <button class="btn btn-primary" onclick="openSpawnModal()">+ เปิดห้อง Agent ใหม่</button>
          <button class="btn" onclick="scanTerminalsNow()">🔄 สแกนหน้าจอ Terminal ทันที</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="inspector" id="mounted-inspector" data-session-id="${escapeHtml(s.id)}">
      <div id="inspector-header-region">
        ${buildInspectorHeaderHtml(s)}
      </div>

      <!-- Unified Chat & Terminal Wrapper (Supports 1-Click Fullscreen Expansion without losing scroll or input focus!) -->
      <div class="chat-center-wrapper ${isChatFullscreen ? 'fullscreen-mode' : ''}" id="chat-center-wrapper">
        <!-- 1. Chat & Command Input Box AT THE VERY TOP -->
        <div class="section-box" style="background:var(--surface-elevated); border-color: rgba(59, 130, 246, 0.45);" id="inspector-command-box">
          <div class="section-title">
            <span>💬 แชท & สั่งการไปยัง ${escapeHtml(s.room)} โดยตรง</span>
            <div style="display:flex; align-items:center; gap:10px;">
              <label style="display:flex; align-items:center; gap:6px; text-transform:none; font-weight:500; cursor:pointer;">
                <input type="checkbox" id="headless-toggle" />
                <span>รันผ่าน Claude Headless Resume (--resume)</span>
              </label>
              <button class="btn btn-primary" style="padding:4px 10px; font-size:11.5px;" id="fullscreen-chat-btn" onclick="toggleChatFullscreen()">
                ${isChatFullscreen ? '🗕 ย่อกลับขนาดปกติ (Esc)' : '⛶ ขยายแชทเต็มจอ (Fullscreen)'}
              </button>
            </div>
          </div>

          <div class="cmd-bar" style="margin-bottom:10px;">
            <input id="cmd-input" class="input-text"
                   placeholder="พิมพ์ข้อความแชท คำสั่ง หรือหมายเลขตัวเลือก ส่งเข้า ${escapeHtml(s.room)} แล้วกด Enter..."
                   data-enter-act="submitCommand" data-args="${escapeHtml(JSON.stringify([s.id]))}" />
            <button class="btn btn-primary" ${act('submitCommand', s.id)}>
              ส่งข้อความ ↵
            </button>
          </div>

          <div style="display:flex; flex-wrap:wrap; gap:6px;">
            <button class="btn" ${act('sendQuickCommand', s.id, '1', true)}>
              1️⃣ เลือกข้อ 1
            </button>
            <button class="btn" ${act('sendQuickCommand', s.id, '2', true)}>
              2️⃣ เลือกข้อ 2
            </button>
            <button class="btn" ${act('sendTerminalKey', s.id, 'enter')}>
              ↵ ส่งปุ่ม Enter
            </button>
            <button class="btn" ${act('sendQuickCommand', s.id, 'รันชุดทดสอบ (test) และสรุปผลสั้นๆ ให้หน่อย')}>
              🧪 สั่งรัน Test & สรุปผล
            </button>
            <button class="btn" ${act('sendQuickCommand', s.id, 'สรุปสิ่งที่แก้ไขไปทั้งหมดพร้อมตรวจสอบ git status')}>
              📝 ขอสรุปงานที่ทำเสร็จแล้ว
            </button>
          </div>
        </div>

        <!-- 2. Live Chat / Terminal Screen Output right under the chat input box -->
        <div class="section-box" id="inspector-terminal-box" style="display:${s.screenPreview ? 'block' : 'none'};">
          <div class="section-title">
            <span id="terminal-box-title">🖥️ หน้าจอแชท & Terminal ล่าสุด</span>
            <div style="display:flex; flex-wrap:wrap; gap:6px;">
              <button class="btn" style="padding:3px 8px; font-size:11px;" onclick="adjustTerminalFont(-1)" title="ลดขนาดตัวอักษร">A-</button>
              <button class="btn" style="padding:3px 8px; font-size:11px;" onclick="adjustTerminalFont(1)" title="เพิ่มขนาดตัวอักษร">A+</button>
              <button class="btn" style="padding:3px 8px; font-size:11px;" onclick="copyTerminalPreview()" title="คัดลอกข้อความแชททั้งหมด">📋 คัดลอก</button>
              <button class="btn" style="padding:3px 8px; font-size:11px;" ${act('sendTerminalKey', s.id, 'up')}>↑</button>
              <button class="btn" style="padding:3px 8px; font-size:11px;" ${act('sendTerminalKey', s.id, 'down')}>↓</button>
              <button class="btn" style="padding:3px 8px; font-size:11px;" ${act('sendTerminalKey', s.id, 'enter')}>↵ Enter</button>
              <button class="btn" style="padding:3px 8px; font-size:11px;" ${act('sendTerminalKey', s.id, 'esc')}>Esc</button>
              <button class="btn" style="padding:3px 8px; font-size:11px;" onclick="scanTerminalsNow()">🔄 รีเฟรชจอ</button>
              <button class="btn btn-primary" style="padding:3px 10px; font-size:11px;" id="fullscreen-term-btn" onclick="toggleChatFullscreen()">
                ${isChatFullscreen ? '🗕 ย่อกลับ (Esc)' : '⛶ ขยายเต็มจอ'}
              </button>
            </div>
          </div>
          <div class="terminal-preview" id="terminal-preview-content" style="font-size:${terminalFontSize}px;"></div>
        </div>
      </div>

      <!-- 3. Workflow Pipeline, Latest TL;DR, Turn History, Sub-Agents, Modified Files -->
      <div id="inspector-dynamic-region" style="display:flex; flex-direction:column; gap:15px;">
        ${buildInspectorBodyDynamicHtml(s)}
      </div>
    </div>
  `;
}

function buildGroupedByProjectHtml(sessions) {
  if (sessions.length === 0) {
    return buildFullInspectorMountHtml(null);
  }
  const groups = new Map();
  for (const s of sessions) {
    const key = s.project || 'General';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  let html = '';
  for (const [projName, items] of groups.entries()) {
    const liveCount = items.filter((i) => i.lifecycle === 'live').length;
    const histCount = items.filter((i) => i.lifecycle === 'history').length;
    const sampleCwd = items[0] ? items[0].cwd : '';

    html += `
      <div class="project-group">
        <div class="project-group-header">
          <div>
            <strong style="font-size:15px;">📁 โปรเจกต์: ${escapeHtml(projName)}</strong>
            <span class="mono" style="font-size:12px; color:var(--text-muted); margin-left:10px;">${escapeHtml(sampleCwd)}</span>
          </div>
          <div style="display:flex; gap:8px;">
            <span class="pill" style="color:var(--success);">🟢 เปิดอยู่ ${liveCount}</span>
            <span class="pill">🕘 ประวัติ ${histCount}</span>
          </div>
        </div>
        <div class="grid-layout">
          ${items.map((s) => buildRoomCardHtml(s)).join('')}
        </div>
      </div>
    `;
  }
  return html;
}

function renderWorkspace() {
  const container = document.getElementById('main-workspace');
  if (!container) return;

  const filtered = getFilteredSessions();

  if (activeTab === 'by_project') {
    mountedInspectorSessionId = null;
    container.innerHTML = buildGroupedByProjectHtml(filtered);
    return;
  }

  if (viewMode === 'grid') {
    mountedInspectorSessionId = null;
    container.innerHTML =
      filtered.length > 0
        ? `<div class="grid-layout">${filtered
            .map((s) => buildRoomCardHtml(s))
            .join('')}</div>`
        : buildFullInspectorMountHtml(null);
    return;
  }

  const activeSession =
    filtered.find((s) => s.id === selectedSessionId) || filtered[0] || null;

  const clearHistoryBtnHtml =
    activeTab === 'history' && filtered.length > 0
      ? `<div style="display:flex; justify-content:space-between; align-items:center; padding:4px 4px 8px;">
          <span style="font-size:12px; color:var(--text-muted);">🕘 รายการ Session ที่เคยเปิดไว้ (กด Resume เพื่อเปิดต่อใน Terminal)</span>
          <button class="btn" style="padding:4px 10px; font-size:11.5px;" onclick="clearUnpinnedHistory()">🗑️ ล้างประวัติที่ไม่ได้ปักหมุด</button>
        </div>`
      : '';

  const roomListHtml =
    filtered.length > 0
      ? filtered.map((s) => buildRoomCardHtml(s)).join('')
      : `<div class="section-box" style="text-align:center; padding:24px; color:var(--text-muted);">
          ไม่มีรายการในแท็บ "${escapeHtml(activeTab)}"
        </div>`;

  // Check if the split layout and inspector for this exact session are ALREADY mounted!
  // If so, update only the left list and dynamic regions WITHOUT touching #cmd-input or #terminal-preview-content!
  const existingLeftCol = document.getElementById('split-left-col');
  const existingHeaderRegion = document.getElementById('inspector-header-region');
  const existingDynamicRegion = document.getElementById('inspector-dynamic-region');

  if (
    activeSession &&
    mountedInspectorSessionId === activeSession.id &&
    existingLeftCol &&
    existingHeaderRegion &&
    existingDynamicRegion
  ) {
    existingLeftCol.innerHTML = `${clearHistoryBtnHtml}<div class="room-list">${roomListHtml}</div>`;
    existingHeaderRegion.innerHTML = buildInspectorHeaderHtml(activeSession);
    existingDynamicRegion.innerHTML = buildInspectorBodyDynamicHtml(activeSession);
    syncTerminalPreviewDom(activeSession);
    return;
  }

  // Otherwise, mount the split layout fresh for the new session selection
  mountedInspectorSessionId = activeSession ? activeSession.id : null;
  container.innerHTML = `
    <div class="split-layout">
      <div id="split-left-col">
        ${clearHistoryBtnHtml}
        <div class="room-list">
          ${roomListHtml}
        </div>
      </div>
      <div id="split-right-col">
        ${buildFullInspectorMountHtml(activeSession)}
      </div>
    </div>
  `;

  if (activeSession) {
    syncTerminalPreviewDom(activeSession);
  }
}

function renderAll() {
  renderHooksButton();
  renderMetrics();
  renderAttentionBanner();
  renderTabsAndFilters();
  renderWorkspace();
}

window.selectSession = function (sessionId) {
  selectedSessionId = sessionId;
  if (viewMode === 'grid' || activeTab === 'by_project') {
    viewMode = 'split';
    if (activeTab === 'by_project') activeTab = 'all';
  }
  renderTabsAndFilters();
  renderWorkspace();
};

window.toggleViewMode = function () {
  viewMode = viewMode === 'split' ? 'grid' : 'split';
  mountedInspectorSessionId = null;
  renderWorkspace();
};

window.toggleChatFullscreen = function () {
  isChatFullscreen = !isChatFullscreen;
  const wrapper = document.getElementById('chat-center-wrapper');
  if (wrapper) {
    wrapper.classList.toggle('fullscreen-mode', isChatFullscreen);
  }
  const btn1 = document.getElementById('fullscreen-chat-btn');
  if (btn1) {
    btn1.innerHTML = isChatFullscreen
      ? '🗕 ย่อกลับขนาดปกติ (Esc)'
      : '⛶ ขยายแชทเต็มจอ (Fullscreen)';
  }
  const btn2 = document.getElementById('fullscreen-term-btn');
  if (btn2) {
    btn2.innerHTML = isChatFullscreen ? '🗕 ย่อกลับ (Esc)' : '⛶ ขยายเต็มจอ';
  }
};

window.adjustTerminalFont = function (delta) {
  terminalFontSize = Math.min(22, Math.max(11, terminalFontSize + delta));
  const pre = document.getElementById('terminal-preview-content');
  if (pre) {
    pre.style.fontSize = `${terminalFontSize}px`;
  }
};

window.copyTerminalPreview = function () {
  const pre = document.getElementById('terminal-preview-content');
  if (!pre || !pre.textContent) return;
  navigator.clipboard.writeText(pre.textContent).then(() => {
    showToast('📋 คัดลอกข้อความหน้าจอแชทเข้า Clipboard เรียบร้อย!');
  });
};

// Allow pressing Escape key on browser page (when not inside input) to exit fullscreen chat mode
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isChatFullscreen) {
    window.toggleChatFullscreen();
  }
});

window.selectChoiceOption = async function (
  sessionId,
  targetIndex,
  currentIndex,
  numberStr,
  labelStr
) {
  try {
    const res = await apiFetch('/api/session/select-option', {
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
      showToast(data.delivered === false ? data.message : `✅ ${data.message}`);
    } else {
      showToast(`⚠️ ${data.error || data.message}`);
    }
  } catch (err) {
    showToast('❌ ส่งตัวเลือกไม่สำเร็จ: ' + err.message);
  }
};

window.sendTerminalKey = async function (sessionId, keyName) {
  try {
    const res = await apiFetch('/api/session/send-key', {
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
    const res = await apiFetch('/api/session/command', {
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
      showToast(data.delivered === false ? data.message : `✅ ${data.message}`);
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

window.resumeSession = async function (sessionId) {
  try {
    const res = await apiFetch('/api/session/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, resume: true }),
    });
    const data = await res.json();
    showToast(`🔄 ${data.message}`);
    activeTab = 'live';
    mountedInspectorSessionId = null;
    renderTabsAndFilters();
  } catch (err) {
    showToast('❌ กู้คืน Session ไม่สำเร็จ: ' + err.message);
  }
};

window.togglePinRoom = async function (sessionId, pinnedState) {
  await apiFetch('/api/session/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      patch: { pinned: Boolean(pinnedState) },
    }),
  });
  showToast(
    pinnedState
      ? '📌 ปักหมุดห้องนี้ไว้ในรายการสำคัญแล้ว'
      : '📌 ยกเลิกการปักหมุดแล้ว'
  );
};

window.openEditModal = function (sessionId) {
  const s = appState.sessions.find((item) => item.id === sessionId);
  if (!s) return;
  document.getElementById('edit-session-id').value = s.id;
  document.getElementById('edit-room-name').value = s.room || '';
  document.getElementById('edit-room-category').value = s.category || 'General';
  document.getElementById('edit-room-goal').value = s.goal || '';
  document.getElementById('edit-modal').classList.add('open');
};

window.closeEditModal = function () {
  document.getElementById('edit-modal').classList.remove('open');
};

window.submitEditRoom = async function () {
  const sessionId = document.getElementById('edit-session-id').value;
  const room = document.getElementById('edit-room-name').value.trim();
  const category =
    document.getElementById('edit-room-category').value.trim() || 'General';
  const goal = document.getElementById('edit-room-goal').value.trim();

  await apiFetch('/api/session/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      patch: { room, category, goal },
    }),
  });
  closeEditModal();
  showToast('✅ บันทึกชื่อห้องและหมวดหมู่เรียบร้อย');
};

window.archiveRoom = async function (sessionId) {
  await apiFetch('/api/session/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'archive', sessionId }),
  });
  showToast('📥 เก็บห้องเข้าแท็บ "🕘 ประวัติที่ปิดแล้ว" เรียบร้อย');
};

window.removeRoomPermanent = async function (sessionId) {
  await apiFetch('/api/session/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'remove', sessionId }),
  });
  showToast('🗑️ ลบประวัติห้องนี้ถาวรแล้ว');
};

window.clearUnpinnedHistory = async function () {
  await apiFetch('/api/session/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'clear-history' }),
  });
  showToast('🗑️ ล้างประวัติห้องที่ไม่ได้ปักหมุดเรียบร้อย');
};

window.openSpawnModal = function () {
  document.getElementById('spawn-modal').classList.add('open');
};

window.closeSpawnModal = function () {
  document.getElementById('spawn-modal').classList.remove('open');
};

window.submitSpawnRoom = async function () {
  const room = document.getElementById('spawn-room').value.trim();
  const category =
    document.getElementById('spawn-category').value.trim() || 'Development';
  const cwd = document.getElementById('spawn-cwd').value.trim();
  const goal = document.getElementById('spawn-goal').value.trim();
  const openTerminal = document.getElementById('spawn-open-wt').checked;
  const runHeadless = document.getElementById('spawn-headless').checked;

  const res = await apiFetch('/api/session/spawn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room,
      category,
      cwd,
      goal,
      openTerminal,
      autoRunClaude: openTerminal,
      runHeadless,
    }),
  });
  const data = await res.json();
  if (data.ok && data.session) {
    selectedSessionId = data.session.id;
    activeTab = 'live';
    mountedInspectorSessionId = null;
    closeSpawnModal();
    showToast(`🚀 เปิดห้อง "${data.session.room}" เรียบร้อย!`);
  }
};

fetchInitialState();
connectSSE();
