'use strict';

/* =========================================================================
 * Agent Mission Control — dashboard
 * Inbox (rail grouped by attention) + Focus (selected room) + Inspector
 * (Files / Agents / History / Usage panels that open on demand).
 *
 * Security: every value from sessions, transcripts or terminals is escaped
 * before it reaches innerHTML, and actions only run through the `data-act`
 * delegation below (no inline handlers carry data).
 * ========================================================================= */

const AMC_TOKEN = (document.querySelector('meta[name="amc-token"]') || {}).content || '';

let appState = {
  stages: [],
  metrics: {},
  usageGuard: null,
  projects: [],
  categories: [],
  sessions: [],
  hooks: null, // unknown until the first snapshot; avoids flashing the "install hooks" notice
  statusline: { installed: false },
};

const ui = {
  selectedId: null,
  lifecycle: 'live', // 'live' | 'history'
  filter: 'all', // 'all' | 'attn' (sidebar "รอคุณ")
  view: 'focus', // 'focus' | 'grid'
  theme: 'auto', // 'auto' | 'light' | 'dark'
  panel: null, // null | 'files' | 'agents' | 'history' | 'usage'
  search: '',
  project: 'ALL',
  category: 'ALL',
  pinnedOnly: false,
  mdMode: true,
  fontSize: 13.5,
  expanded: false,
  headless: false,
  connected: true,
};

const files = { sessionId: null, list: [], signature: '', loading: false, error: null };
const ide = { open: false, sessionId: null, path: null, mode: 'diff', detail: null, loading: false };
const drafts = new Map();
const scrollState = new Map();
let mountedFocusId = null;
let popoverKind = null;

const STAGES = [
  { id: 'plan', label: 'Plan', icon: 'compass' },
  { id: 'code', label: 'Code', icon: 'code' },
  { id: 'verify', label: 'Verify', icon: 'shieldCheck' },
  { id: 'done', label: 'Done', icon: 'target' },
];

const MODELS = [
  { value: 'opus', id: 'claude-opus-5-5', family: 'opus', label: 'Opus 5.5', desc: 'งานยาก' },
  { value: 'sonnet', id: 'claude-sonnet-5-5', family: 'sonnet', label: 'Sonnet 5.5', desc: 'งานทั่วไป' },
  { value: 'haiku', id: 'claude-haiku-5-5', family: 'haiku', label: 'Haiku 5.5', desc: 'เร็ว ถูก' },
  { value: 'claude-fable-5-2', id: 'claude-fable-5-2', family: 'fable', label: 'Fable 5.2', desc: 'เก่งที่สุด' },
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/* ---------- Preferences (per viewer, best effort) ---------- */
const PREF_KEY = 'amc.ui.v3';
const PREF_KEYS = ['view', 'mdMode', 'fontSize', 'headless', 'lifecycle', 'filter', 'theme'];
try {
  const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
  // Side panels are not restored: details open only when asked for, on every visit.
  for (const k of PREF_KEYS) {
    if (saved[k] !== undefined) ui[k] = saved[k];
  }
} catch {}
function savePrefs() {
  try {
    const out = {};
    for (const k of PREF_KEYS) out[k] = ui[k];
    localStorage.setItem(PREF_KEY, JSON.stringify(out));
  } catch {}
}

/** auto follows the OS; light/dark pin the theme on <html>. */
function applyTheme() {
  const root = document.documentElement;
  if (ui.theme === 'light' || ui.theme === 'dark') root.dataset.theme = ui.theme;
  else delete root.dataset.theme;
}
applyTheme();

/* ---------- Utilities ---------- */
const $ = (sel, root = document) => root.querySelector(sel);

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function act(name, ...args) {
  return `data-act="${escapeHtml(name)}" data-args="${escapeHtml(JSON.stringify(args))}"`;
}

/** Runs a whitelisted action named by a `data-act` (or `data-change-act`) attribute. */
function runAction(el, attr, extraArgs) {
  const name = el.getAttribute(attr);
  const fn = Object.prototype.hasOwnProperty.call(Actions, name) ? Actions[name] : null;
  if (typeof fn !== 'function') return;
  if (extraArgs) return fn(...extraArgs);
  let args = [];
  try {
    args = JSON.parse(el.getAttribute('data-args') || '[]');
  } catch {
    return;
  }
  // Popover openers also need their anchor element.
  if (/^open(Model|More|Filters)$/.test(name)) return fn(args[0], el);
  return fn(...args);
}

/** Replaces innerHTML only when the markup changed, so focus and hover survive live updates. */
function setHTML(el, html) {
  if (!el) return;
  if (el.__html !== html) {
    el.innerHTML = html;
    el.__html = html;
  }
}

function formatTokens(n) {
  const num = Number(n || 0);
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(num >= 1e7 ? 1 : 2)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(num >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(num));
}

function formatUsd(n) {
  const v = Number(n || 0);
  return v >= 100 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;
}

function relTime(iso) {
  if (!iso) return '';
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 30) return 'now';
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function clock(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

function until(iso) {
  if (!iso) return '';
  const min = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (min <= 0) return 'อีกไม่นาน';
  if (min < 60) return `อีก ${min} นาที`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `อีก ${h} ชม. ${m} นาที` : `อีก ${h} ชม.`;
}

function plainText(md) {
  return String(md || '')
    .replace(/`+/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function modelFamily(model) {
  const m = String(model || '').toLowerCase();
  return ['fable', 'mythos', 'opus', 'sonnet', 'haiku'].find((f) => m.includes(f)) || null;
}

function modelLabel(model) {
  const m = String(model || '').toLowerCase();
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  let r = m.match(/claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/);
  if (r) return `${cap(r[1])} ${r[2]}${r[3] && r[3].length <= 2 ? `.${r[3]}` : ''}`;
  r = m.match(/claude-(\d)-(\d)-(opus|sonnet|haiku)/);
  if (r) return `${cap(r[3])} ${r[1]}.${r[2]}`;
  const fam = modelFamily(m);
  if (fam) {
    const known = MODELS.find((x) => x.family === fam);
    return known ? known.label : cap(fam);
  }
  return m ? cap(m) : 'Model';
}

function freshTokens(s) {
  const t = s.tokenUsage || {};
  if (typeof t.freshTokens === 'number') return t.freshTokens;
  return Number(t.inputTokens || 0) + Number(t.outputTokens || 0) + Number(t.cacheCreateTokens || 0);
}

function contextPct(s) {
  if (s.liveContext && typeof s.liveContext.usedPct === 'number') return s.liveContext.usedPct;
  return Number((s.tokenUsage || {}).contextWindowPct || 0);
}

/* ---------- Icons (authored, 24 grid, 1.75 stroke) ---------- */
const ICON_PATHS = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  rows: '<rect x="4" y="4" width="6" height="16" rx="1.5"/><path d="M14 6.5h6M14 12h6M14 17.5h6"/>',
  refresh: '<path d="M19.5 10.5A7.5 7.5 0 0 0 6 7.2L4.5 8.7"/><path d="M4.5 4.5v4.2h4.2"/><path d="M4.5 13.5A7.5 7.5 0 0 0 18 16.8l1.5-1.5"/><path d="M19.5 19.5v-4.2h-4.2"/>',
  plug: '<path d="M9 3v4.5M15 3v4.5"/><path d="M6.5 7.5h11v3.5a5.5 5.5 0 0 1-11 0z"/><path d="M12 16.5V21"/>',
  branch: '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="7.5" r="2"/><path d="M6.5 7.5v9"/><path d="M17.5 9.5v.5a5 5 0 0 1-5 5H9"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/>',
  fileDiff: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/><path d="M12 10.5v5M9.5 13h5M9.5 17.5h5"/>',
  agents: '<circle cx="12" cy="5.5" r="2.2"/><circle cx="5.5" cy="18" r="2.2"/><circle cx="18.5" cy="18" r="2.2"/><path d="M12 7.7v3.8M12 11.5 7 16M12 11.5l5 4.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  gauge: '<path d="M4.6 17.5a8.5 8.5 0 1 1 14.8 0"/><path d="m12 13.5 3.8-4.3"/><circle cx="12" cy="14" r="1.4"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  paperclip: '<path d="M19.5 11.2 12 18.7a4.6 4.6 0 0 1-6.5-6.5l7.8-7.8a3.1 3.1 0 0 1 4.4 4.4l-7.8 7.8a1.55 1.55 0 0 1-2.2-2.2l7.1-7.1"/>',
  chevronDown: '<path d="m7 10 5 5 5-5"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  pin: '<path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z"/><path d="M12 14v6.5"/>',
  edit: '<path d="M4.5 19.5h3.8L19 8.8a2.1 2.1 0 0 0-3-3L5.3 16.5z"/><path d="m14.5 7.3 3 3"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4" rx="1"/><path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5"/><path d="M10 12.5h4"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.5h9.2L17.5 7"/>',
  editor: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 8.5h17"/><path d="m9.5 12-2.2 2.3 2.2 2.2M14.5 12l2.2 2.3-2.2 2.2"/>',
  send: '<path d="M5 12h13M12.5 6l6 6-6 6"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  expand: '<path d="M14.5 4.5h5v5M9.5 19.5h-5v-5M19.5 4.5l-6 6M4.5 19.5l6-6"/>',
  collapse: '<path d="M19.5 4.5l-5.5 5.5M14 5.5V10h4.5M4.5 19.5 10 14M10 18.5V14H5.5"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15H17"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 3.3 20.7 12 12 20.7 3.3 12z"/><path d="M12 8.3v4.4"/><circle cx="12" cy="15.7" r="0.95" fill="currentColor" stroke="none"/>',
  pauseCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M10 9v6M14 9v6"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.7-5"/>',
  idle: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>',
  spinner: '<circle cx="12" cy="12" r="8" opacity="0.28"/><path class="spin" d="M12 4a8 8 0 0 1 8 8"/>',
  closed: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12h7"/>',
  flask: '<path d="M9.5 3.5h5M10.5 3.5v5.2L5.7 17a2 2 0 0 0 1.7 3h9.2a2 2 0 0 0 1.7-3l-4.8-8.3V3.5"/><path d="M7.8 15h8.4"/>',
  summary: '<path d="M10.5 6.5h9M10.5 12h9M10.5 17.5h9"/><path d="m4 6.5 1.4 1.4L8 5.3M4 12l1.4 1.4L8 10.8M4 17.5l1.4 1.4L8 16.3"/>',
  cloud: '<path d="M7.5 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.3 1.7 3.7 3.7 0 0 1-.7 7.3z"/>',
  spark: '<path d="M12 3.5c.6 4.3 2.2 5.9 6.5 6.5-4.3.6-5.9 2.2-6.5 6.5-.6-4.3-2.2-5.9-6.5-6.5 4.3-.6 5.9-2.2 6.5-6.5z"/><path d="M18.5 16v4M16.5 18h4"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  code: '<path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5"/>',
  shieldCheck: '<path d="M12 3.5 19 6v5.5c0 4.2-3 7.5-7 9-4-1.5-7-4.8-7-9V6z"/><path d="m9 12 2.2 2.2 3.8-4"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.2"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
  flag: '<path d="M5.5 21V4"/><path d="M5.5 5c2.6-1.6 5 .4 7.3-.2S16.5 3.7 18.5 4.6v8.2c-2-.9-3.5-.3-5.7.3s-4.7-1.4-7.3.2"/>',
  text: '<path d="M5 6.5h14M5 12h14M5 17.5h9"/>',
  tokens: '<ellipse cx="12" cy="6.5" rx="7" ry="2.8"/><path d="M5 6.5v5c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-5"/><path d="M5 11.5v5c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-5"/>',
  layers: '<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/>',
  arrowUp: '<path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5"/>',
  arrowDown: '<path d="M12 5v13.5M6.5 13 12 18.5l5.5-5.5"/>',
  enter: '<path d="M19 5v6.5a3 3 0 0 1-3 3H6"/><path d="m10 10.5-4 4 4 4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.95" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  contrast: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none"/>',
};

function icon(name, size = 16, extra = '') {
  const paths = ICON_PATHS[name] || '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${paths}</svg>`;
}

/* ---------- Room status ---------- */
function roomState(s) {
  if (s.lifecycle === 'history') return { key: 'closed', cls: '', glyph: 'closed', label: 'ปิดแล้ว' };
  // A permission prompt still needs the human during a hold: approving it lets the step finish.
  if (s.status === 'needs_input') return { key: 'attn', cls: 's-attn', glyph: 'alert', label: 'รอคุณ' };
  if ((s.quotaHold && s.status !== 'working') || s.status === 'paused_quota') {
    return { key: 'hold', cls: 's-hold', glyph: 'pauseCircle', label: 'พักรอ usage reset' };
  }
  if (s.status === 'working') return { key: 'work', cls: 's-work', glyph: 'spinner', label: 'กำลังทำงาน' };
  if (s.status === 'done') return { key: 'done', cls: 's-done', glyph: 'checkCircle', label: 'เสร็จแล้ว' };
  return { key: 'idle', cls: '', glyph: 'idle', label: 'ว่าง' };
}

function stageIndex(s) {
  return Math.max(0, Math.min(3, Number(s.stageIndex || 0)));
}

// A stage is "now" only while a turn is in flight; an idle room has no current stage.
const ACTIVE_STATES = new Set(['attn', 'work', 'hold']);

function stageDotsHtml(s) {
  const idx = stageIndex(s);
  const finished = s.status === 'done' || s.lifecycle === 'history';
  const st = roomState(s);
  if (!finished && !ACTIVE_STATES.has(st.key)) return '';
  return `<span class="dots ${st.key === 'attn' ? 'is-attn' : ''}" aria-hidden="true">${STAGES.map((_, i) => {
    const cls = finished || i < idx ? 'on' : i === idx ? 'now' : '';
    return `<i class="${cls}"></i>`;
  }).join('')}</span>`;
}

/* ---------- Markdown (escape first, then format) ---------- */
function formatInline(escaped) {
  const codes = [];
  let out = escaped.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code class="md-inline-code">${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong class="md-bold"><em>$1</em></strong>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong class="md-bold">$1</strong>');
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  out = out.replace(
    /(^|[\s(])(https?:\/\/[^\s)<]+)/g,
    '$1<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer">$2</a>'
  );
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)] || '');
}

function renderMarkdown(raw) {
  if (!raw) return '';
  const lines = String(raw).replace(/\r\n/g, '\n').split('\n');
  // Claude replies (and any text before the first marker) become cards; user turns become bubbles.
  const top = [];
  let group = null;
  const push = (html) => {
    if (!group) group = [];
    group.push(html);
  };
  const closeGroup = () => {
    if (group && group.length) top.push(`<div class="md-claude">${group.join('')}</div>`);
    group = null;
  };
  let fence = false;
  let lang = '';
  let code = [];
  let table = [];

  const flushTable = () => {
    if (!table.length) return;
    if (table.length === 1) {
      push(`<p class="md-p">${formatInline(escapeHtml(table[0]))}</p>`);
      table = [];
      return;
    }
    let html = '<table class="md-table">';
    table.forEach((row, r) => {
      const cells = row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (r === 1 && cells.every((c) => /^[:\-]+$/.test(c))) return;
      const tag = r === 0 ? 'th' : 'td';
      html += `<tr>${cells.map((c) => `<${tag}>${formatInline(escapeHtml(c))}</${tag}>`).join('')}</tr>`;
    });
    push(`${html}</table>`);
    table = [];
  };

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('```')) {
      flushTable();
      if (!fence) {
        fence = true;
        lang = t.slice(3).trim();
        code = [];
      } else {
        push(
          `<div class="md-code-block">${lang ? `<div class="md-code-lang">${escapeHtml(lang)}</div>` : ''}<pre><code>${escapeHtml(code.join('\n'))}</code></pre></div>`
        );
        fence = false;
      }
      continue;
    }
    if (fence) {
      code.push(line);
      continue;
    }
    if (/^\|.+\|$/.test(t)) {
      table.push(t);
      continue;
    }
    flushTable();
    if (!t) continue;

    if (t.startsWith('🧑 คุณ:')) {
      closeGroup();
      top.push(`<div class="md-user-turn">${formatInline(escapeHtml(t.slice('🧑 คุณ:'.length).trim()))}</div>`);
      continue;
    }
    if (t.startsWith('🤖 Claude:')) {
      const rest = t.slice('🤖 Claude:'.length).trim();
      closeGroup();
      push(`<div class="md-claude-turn">${icon('spark', 14)} Claude</div>`);
      if (rest) push(`<p class="md-p">${formatInline(escapeHtml(rest))}</p>`);
      continue;
    }
    const tool = t.match(/^🔧\s*\[Tool:\s*([^\]]+)\]\s*(.*)$/);
    if (tool) {
      push(
        `<div class="md-tool-line">${icon('terminal', 13)}<b>${escapeHtml(tool[1])}</b><span>${escapeHtml(tool[2])}</span></div>`
      );
      continue;
    }
    if (/^([-*_]{3,}|[─━═]{6,})$/.test(t)) {
      push('<hr class="md-hr" />');
      continue;
    }
    const h = t.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      push(`<div class="md-h${Math.min(3, h[1].length)}">${formatInline(escapeHtml(h[2]))}</div>`);
      continue;
    }
    const ul = line.match(/^(\s*)([-*•·])\s+(.+)$/);
    if (ul) {
      const indent = Math.min(48, Math.floor(ul[1].length / 2) * 14);
      push(
        `<div class="md-li" style="margin-left:${indent}px"><span class="md-li-bullet">•</span><div>${formatInline(escapeHtml(ul[3]))}</div></div>`
      );
      continue;
    }
    const ol = line.match(/^(\s*)([❯>]?\s*\d+[.)])\s+(.+)$/);
    if (ol) {
      const indent = Math.min(48, Math.floor(ol[1].length / 2) * 14);
      push(
        `<div class="md-li" style="margin-left:${indent}px"><span class="md-li-bullet">${escapeHtml(ol[2].trim())}</span><div>${formatInline(escapeHtml(ol[3]))}</div></div>`
      );
      continue;
    }
    if (t.startsWith('> ')) {
      push(`<div class="md-quote">${formatInline(escapeHtml(t.slice(2)))}</div>`);
      continue;
    }
    push(`<p class="md-p">${formatInline(escapeHtml(line))}</p>`);
  }
  flushTable();
  if (fence && code.length) {
    push(`<div class="md-code-block"><pre><code>${escapeHtml(code.join('\n'))}</code></pre></div>`);
  }
  closeGroup();
  return top.join('');
}

/* ---------- API ---------- */
function apiFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { ...(init.headers || {}), 'X-AMC-Token': AMC_TOKEN } });
}

async function postJson(url, body) {
  try {
    const res = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let data = {};
    try {
      data = await res.json();
    } catch {}
    return { ok: res.ok && data.ok !== false, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: err.message } };
  }
}

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(message, tone = 'ok') {
  const el = $('#toast');
  if (!el) return;
  const ic = tone === 'err' ? 'alert' : tone === 'warn' ? 'info' : 'check';
  el.className = `toast is-${tone}`;
  el.innerHTML = `${icon(ic, 16)}<span>${escapeHtml(message)}</span>`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, tone === 'err' ? 6000 : 3800);
}

/** Server messages sometimes start with an emoji marker; the toast carries its own icon. */
function cleanMsg(msg) {
  return String(msg || '').replace(/^[\p{Extended_Pictographic}️\s]+/u, '');
}

/* ---------- Derived lists ---------- */
function selected() {
  return appState.sessions.find((s) => s.id === ui.selectedId) || null;
}

function matchesFilters(s) {
  if (ui.project !== 'ALL' && s.project !== ui.project) return false;
  if (ui.category !== 'ALL' && s.category !== ui.category) return false;
  if (ui.pinnedOnly && !s.pinned) return false;
  const q = ui.search.trim().toLowerCase();
  if (q) {
    const hay = [s.room, s.project, s.category, s.cwd, s.branch, s.goal, s.tldr]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function byPinnedThenAge(a, b) {
  if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? 1 : -1;
  return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
}

/** Where the user dragged the room to; rooms never placed come after, pinned then oldest first. */
function byManualOrder(a, b) {
  const ao = Number.isFinite(a.sortOrder) ? a.sortOrder : Infinity;
  const bo = Number.isFinite(b.sortOrder) ? b.sortOrder : Infinity;
  if (ao !== bo) return ao < bo ? -1 : 1;
  return byPinnedThenAge(a, b);
}

function manualOrderIds() {
  return appState.sessions.slice().sort(byManualOrder).map((s) => s.id);
}

/** Rail groups in reading order: who needs me first. */
function railGroups() {
  const visible = appState.sessions.filter(matchesFilters);
  if (ui.lifecycle === 'history') {
    const list = visible
      .filter((s) => s.lifecycle === 'history')
      .sort((a, b) => String(b.closedAt || b.updatedAt || '').localeCompare(String(a.closedAt || a.updatedAt || '')));
    return [{ key: 'history', label: 'ปิดแล้ว', items: list }];
  }
  const live = visible.filter((s) => s.lifecycle !== 'history');
  const groups = [
    { key: 'attn', label: 'รอคุณ', items: [] },
    { key: 'work', label: 'กำลังทำงาน', items: [] },
    { key: 'hold', label: 'พักรอ usage reset', items: [] },
    { key: 'rest', label: 'ว่าง / เสร็จแล้ว', items: [] },
  ];
  for (const s of live) {
    const k = roomState(s).key;
    const g = groups.find((x) => x.key === k) || groups[3];
    g.items.push(s);
  }
  groups.forEach((g) => g.items.sort(byManualOrder));
  const shown = ui.filter === 'attn' ? groups.filter((g) => g.key === 'attn') : groups;
  return shown.filter((g) => g.items.length);
}

function railOrder() {
  return railGroups().flatMap((g) => g.items);
}

function ensureSelection() {
  const order = railOrder();
  if (!order.length) {
    ui.selectedId = null;
    return;
  }
  if (!order.some((s) => s.id === ui.selectedId)) ui.selectedId = order[0].id;
}

function currentNav() {
  if (ui.view === 'grid') return 'overview';
  if (ui.lifecycle === 'history') return 'history';
  return ui.filter === 'attn' ? 'attn' : 'live';
}

/* ---------- Sidebar ---------- */
function renderSidebar() {
  const dot = $('#conn-dot');
  if (dot) dot.classList.toggle('is-off', !ui.connected);
  const connLabel = $('#conn-label');
  if (connLabel) connLabel.textContent = ui.connected ? 'เชื่อมต่อแล้ว' : 'กำลังเชื่อมต่อใหม่';

  const newBtn = $('#new-btn');
  if (newBtn && !newBtn.__done) {
    newBtn.innerHTML = `${icon('plus', 17)}<span class="side-label">ห้องใหม่</span>`;
    newBtn.title = 'เปิดห้อง Agent ใหม่';
    newBtn.__done = true;
  }

  const live = appState.sessions.filter((s) => s.lifecycle !== 'history');
  const waiting = live.filter((s) => s.status === 'needs_input').length;
  const hist = appState.sessions.length - live.length;
  const nav = currentNav();
  const item = (key, ic, label, trail) => `
    <button class="nav-item" ${act('navigate', key)} ${nav === key ? 'aria-current="page"' : ''} title="${escapeHtml(label)}">
      ${icon(ic, 18)}<span class="label side-label">${escapeHtml(label)}</span>${trail}
    </button>`;
  setHTML(
    $('#side-nav'),
    item('live', 'rows', 'Live', `<span class="count">${live.length}</span>`) +
      item('attn', 'alert', 'รอคุณ', waiting ? `<span class="badge-attn">${waiting}</span>` : `<span class="count">0</span>`) +
      item('overview', 'grid', 'ภาพรวม', '') +
      item('history', 'clock', 'ประวัติ', `<span class="count">${hist}</span>`)
  );

  const u = appState.usageGuard;
  let usage = '';
  if (u) {
    const remaining = Number(u.remainingPct ?? 100);
    const threshold = Number(u.autoPauseThresholdPct || 8);
    const cls = remaining < threshold ? 'is-low' : remaining < 25 ? 'is-mid' : '';
    const source = u.source === 'claude' ? 'จาก Claude Code' : u.source === 'simulated' ? 'ค่าจำลอง' : 'ค่าประมาณ';
    usage = `
      <button class="usage-card ${u.hold ? 'is-hold' : ''}" ${act('openPanel', 'usage')} aria-label="Usage รอบ 5 ชม. คงเหลือ ${remaining}%" title="Usage รอบ 5 ชม. คงเหลือ ${remaining}% (${escapeHtml(source)}) · พักงานเมื่อต่ำกว่า ${threshold}%">
        <span class="usage-top">Usage 5 ชม.</span>
        <span class="usage-value">${remaining}%<small>คงเหลือ</small></span>
        <span class="bar ${cls}" aria-hidden="true"><i style="width:${Math.max(2, remaining)}%"></i><span class="bar-mark" style="left:${threshold}%"></span></span>
        <span class="usage-foot"><span>${u.hold ? 'พักงานอยู่ · ' : ''}reset ${escapeHtml(clock(u.resetAt))}</span><span>${escapeHtml(source)}</span></span>
      </button>`;
  }
  setHTML($('#side-usage'), usage);

  const hooksOk = appState.hooks && appState.hooks.installed;
  const themeIcon = ui.theme === 'dark' ? 'moon' : ui.theme === 'light' ? 'sun' : 'contrast';
  const themeLabel = ui.theme === 'dark' ? 'ธีมมืด' : ui.theme === 'light' ? 'ธีมสว่าง' : 'ธีมตามระบบ';
  setHTML(
    $('#side-tools'),
    `<button class="icon-btn ${hooksOk ? '' : 'is-warn'}" ${act('installHooks')} aria-label="${hooksOk ? 'Claude hooks เชื่อมแล้ว' : 'ติดตั้ง Claude hooks'}" title="${hooksOk ? `Claude hooks เชื่อมแล้ว (${(appState.hooks.installedEvents || []).length} events)` : 'ยังไม่ได้ติดตั้ง Claude Code hooks คลิกเพื่อติดตั้ง'}">${icon('plug', 18)}</button>
     <button class="icon-btn" ${act('scanTerminals')} aria-label="สแกน terminal ทุก tab" title="สแกน terminal ทุก tab">${icon('refresh', 18)}</button>
     <button class="icon-btn" ${act('cycleTheme')} aria-label="${themeLabel}" title="${themeLabel} (คลิกเพื่อสลับ)">${icon(themeIcon, 18)}</button>`
  );
}

function renderHoldBanner() {
  const el = $('#hold-banner');
  const u = appState.usageGuard;
  if (!u || !u.hold) {
    el.hidden = true;
    setHTML(el, '');
    return;
  }
  el.hidden = false;
  const pending = u.hold.pendingSteps ? ` · รอ ${u.hold.pendingSteps} ห้องทำ step ปัจจุบันให้จบ` : '';
  setHTML(
    el,
    `${icon('pauseCircle', 20)}
     <div><b>พักงานไว้ก่อน</b> usage เหลือ ${escapeHtml(u.remainingPct)}% บันทึก checkpoint แล้ว
       <div class="sub">ทำงานต่ออัตโนมัติ ${escapeHtml(clock(u.resetAt))} (${escapeHtml(until(u.resetAt))})${escapeHtml(pending)}</div>
     </div>
     <button class="btn btn-hold btn-sm" ${act('resumeNow')}>${icon('play', 14)}ทำต่อเลย</button>`
  );
}

/* ---------- Room list ---------- */
function renderList() {
  // A redraw mid-drag would drop the card being held; redraw once it is let go.
  if (drag.active) {
    drag.dirty = true;
    return;
  }
  const titles = { live: 'ห้องที่เปิดอยู่', attn: 'รอคุณ', history: 'ประวัติ', overview: 'ห้องที่เปิดอยู่' };
  const title = $('#list-title');
  if (title) title.textContent = titles[currentNav()];
  const fb = $('#filter-btn');
  if (fb) {
    if (!fb.__icon) {
      fb.innerHTML = icon('sliders', 18);
      fb.__icon = true;
    }
    fb.classList.toggle('is-active', ui.project !== 'ALL' || ui.category !== 'ALL' || ui.pinnedOnly);
  }

  const groups = railGroups();
  let html = '';
  if (!groups.length) {
    const filtered = ui.search || ui.project !== 'ALL' || ui.category !== 'ALL' || ui.pinnedOnly;
    html = `<div class="empty-list">${
      filtered
        ? 'ไม่พบห้องที่ตรงกับตัวกรอง'
        : ui.filter === 'attn' && ui.lifecycle !== 'history'
        ? 'ไม่มีห้องไหนรอคุณอยู่'
        : ui.lifecycle === 'history'
        ? 'ยังไม่มีห้องที่ปิดไป'
        : 'ยังไม่มีห้องที่เปิดอยู่<br />เปิด <span class="mono">claude</span> ใน terminal หรือกด ห้องใหม่'
    }</div>`;
  }
  for (const g of groups) {
    if (groups.length > 1 || g.key === 'history') {
      html += `<div class="group-head ${g.key === 'attn' ? 'is-attn' : ''}">${escapeHtml(g.label)} <span class="count">${g.items.length}</span></div>`;
    }
    const dragGroup = g.key !== 'history' && g.items.length > 1 ? g.key : '';
    html += g.items.map((s) => rcardHtml(s, s.id === ui.selectedId && ui.view === 'focus', dragGroup)).join('');
  }
  if (ui.lifecycle === 'history' && groups.length) {
    html += `<div style="padding:6px 4px"><button class="btn btn-ghost btn-sm" ${act('clearHistory')}>${icon('trash', 14)}ล้างประวัติที่ไม่ได้ปักหมุด</button></div>`;
  }
  setHTML($('#rail-list'), hooksNoticeHtml() + html);
}

/** Without hooks the server only sees terminal screens, so working/done can't be told apart. */
function hooksNoticeHtml() {
  if (!appState.hooks || appState.hooks.installed !== false || ui.lifecycle === 'history') return '';
  return `
    <div class="notice is-attn list-notice" role="status">${icon('plug', 18)}
      <div class="notice-text">
        <span>สถานะห้องยังไม่สด</span>
        <span class="notice-sub">ติดตั้ง hooks เพื่อให้รู้ว่าห้องไหนทำงานอยู่หรือเสร็จแล้ว</span>
      </div>
      <button class="btn btn-sm" ${act('installHooks')}>ติดตั้ง</button>
    </div>`;
}

const PILL_LABEL = { attn: 'รอคุณ', work: 'กำลังทำงาน', hold: 'พักรอ reset', done: 'เสร็จแล้ว', idle: 'ว่าง', closed: 'ปิดแล้ว' };

/** What the room is doing now, in one or two lines: its question if it asks, else its TL;DR. */
function roomSummaryHtml(s) {
  const st = roomState(s);
  if (st.key === 'attn') {
    const p = s.interactivePrompt;
    const q = p && p.question;
    const n = p && Array.isArray(p.questions) ? p.questions.length : 0;
    const lead = n > 1 ? `ถาม ${n} ข้อ: ` : 'ถาม: ';
    const text = q ? `${lead}${q}` : s.pendingAction ? `รอยืนยัน: ${s.pendingAction}` : s.tldr || s.goal;
    return `<span class="rc-sum is-ask">${escapeHtml(plainText(text))}</span>`;
  }
  const text = s.tldr || s.goal;
  return text ? `<span class="rc-sum">${formatInline(escapeHtml(text))}</span>` : '';
}

/** `group` (a status-group key) makes the card draggable within that group. */
function rcardHtml(s, current = false, group = '') {
  const st = roomState(s);
  const dragAttrs = group
    ? ` data-id="${escapeHtml(s.id)}" data-group="${escapeHtml(group)}" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"`
    : '';
  const hint = group ? '\nลากเพื่อสลับลำดับ (Alt+↑/↓)' : '';
  const pillCls = st.key === 'idle' || st.key === 'closed' ? '' : `s-${st.key}`;
  const avatarCls = st.key === 'idle' ? '' : `s-${st.key}`;
  const time = relTime(s.lifecycle === 'history' && s.closedAt ? s.closedAt : s.updatedAt);
  const stage = STAGES[stageIndex(s)].label;
  const tool = !ACTIVE_STATES.has(st.key)
    ? ''
    : st.key === 'work' && s.currentTool && s.currentTool !== 'Idle'
    ? `${stage} · ${s.currentTool}`
    : stage;
  return `
    <button class="rcard" ${act('selectRoom', s.id)} aria-current="${current}"${dragAttrs} title="${escapeHtml((s.cwd || '') + hint)}">
      <span class="avatar ${avatarCls}" role="img" aria-label="${escapeHtml(st.label)}">${icon(st.glyph, 20)}${s.pinned ? `<span class="pin-dot">${icon('pin', 11)}</span>` : ''}</span>
      <span class="rc-top"><span class="rc-name">${escapeHtml(s.room)}</span><time class="rc-time" datetime="${escapeHtml(s.updatedAt || '')}">${escapeHtml(time)}</time></span>
      <span class="rc-state"><span class="pill ${pillCls}">${escapeHtml(PILL_LABEL[st.key] || st.label)}</span>${stageDotsHtml(s)}${tool ? `<span class="rc-tool">${escapeHtml(tool)}</span>` : ''}</span>
      ${roomSummaryHtml(s)}
      <span class="rc-foot">
        <span class="branch">${icon('branch', 12)}${escapeHtml(s.branch || '-')}</span>
        <span title="Tokens ใหม่ (ไม่รวม cache read)">${icon('tokens', 12)}${formatTokens(freshTokens(s))}</span>
        ${(s.subAgents || []).length ? `<span title="Sub-agents">${icon('agents', 12)}${(s.subAgents || []).length}</span>` : ''}
      </span>
    </button>`;
}

/* ---------- Focus ---------- */
function renderFocus() {
  const el = $('#focus');
  el.classList.toggle('is-expanded', ui.expanded);
  const s = selected();
  if (!s) {
    saveDraft();
    mountedFocusId = null;
    setHTML(
      el,
      `<div class="focus-empty"><div>
        <h2>${appState.sessions.length ? 'เลือกห้องจากรายการด้านซ้าย' : 'ยังไม่มีห้อง Agent'}</h2>
        <p>${appState.sessions.length ? 'หรือเปลี่ยนตัวกรอง' : 'เปิด claude ใน terminal ที่ติดตั้ง hooks แล้ว ห้องจะขึ้นที่นี่เอง'}</p>
        <div class="row">
          <button class="btn btn-primary" ${act('openSpawn')}>${icon('plus', 15)}ห้องใหม่</button>
          <button class="btn" ${act('scanTerminals')}>${icon('refresh', 15)}สแกน terminal</button>
        </div>
      </div></div>`
    );
    return;
  }

  if (mountedFocusId !== s.id || !$('#f-head', el)) {
    saveDraft();
    mountedFocusId = s.id;
    el.__html = null;
    el.innerHTML = `
      <div class="focus-scroll">
        <div class="focus-head" id="f-head"></div>
        <div id="f-step"></div>
        <div id="f-notice" style="display:flex; flex-direction:column; gap:10px"></div>
        <div id="f-tldr"></div>
        <div class="output">
          <div class="output-head" id="f-out-head"></div>
          <div class="output-body" id="f-out" tabindex="0" aria-label="Live output"></div>
        </div>
      </div>
      <div class="composer" id="f-composer"></div>`;
    $('#f-out').addEventListener('scroll', onOutputScroll);
    renderComposer(s);
  }

  setHTML($('#f-head'), focusHeadHtml(s));
  setHTML($('#f-step'), stepperHtml(s));
  setHTML($('#f-notice'), noticesHtml(s));
  setHTML(
    $('#f-tldr'),
    s.tldr || s.goal
      ? `<div class="tldr"><span class="tldr-label">TL;DR</span><span class="tldr-text" title="${escapeHtml(plainText(s.tldr || s.goal))}">${formatInline(escapeHtml(s.tldr || s.goal))}</span></div>`
      : ''
  );
  setHTML($('#f-out-head'), outputHeadHtml());
  syncOutput(s);
  updateComposerState(s);
}

function focusHeadHtml(s) {
  const t = s.tokenUsage || {};
  const ctx = contextPct(s);
  const fam = modelFamily(s.model);
  const effort = String(s.effort || 'high');
  const connected = s.pid || s.paneId || s.wrapperConnected;
  return `
    <div class="title-row">
      <h1 title="${escapeHtml(s.room)}">${escapeHtml(s.room)}</h1>
      <button class="icon-btn icon-btn-sm" ${act('openEdit', s.id)} aria-label="แก้ไขชื่อห้อง" title="แก้ไขชื่อห้อง หมวดหมู่ และเป้าหมาย">${icon('edit', 15)}</button>
      <div class="title-actions">
        <button class="btn btn-ghost btn-sm" ${act('openInVsCode', s.id, '', 1)} title="เปิดโฟลเดอร์ห้องนี้ใน VS Code">${icon('editor', 15)}VS Code</button>
        <button class="icon-btn" ${act('togglePin', s.id, !s.pinned)} aria-pressed="${Boolean(s.pinned)}" aria-label="${s.pinned ? 'เลิกปักหมุด' : 'ปักหมุด'}" title="${s.pinned ? 'เลิกปักหมุด' : 'ปักหมุดไว้บนสุด'}">${icon('pin', 16)}</button>
        <button class="icon-btn" ${act('openMore', s.id)} aria-label="คำสั่งเพิ่มเติม" title="คำสั่งเพิ่มเติม">${icon('more', 18)}</button>
      </div>
    </div>
    <div class="meta-row">
      <span class="chip mono" title="${escapeHtml(s.cwd || '')}">${icon('branch', 14)}<span class="clip">${escapeHtml(s.branch || '-')}</span></span>
      <button class="chip" ${act('openModel', s.id)} title="เปลี่ยน model และ effort (ส่ง /model และ /effort เข้า terminal)" ${s.lifecycle === 'history' ? 'disabled' : ''}>
        ${icon('spark', 14)}<span>${escapeHtml(fam ? modelLabel(s.model) : 'Model')}</span><span style="color:var(--text-3)">${escapeHtml(effort)}</span>${icon('chevronDown', 14)}
      </button>
      <button class="chip num" ${act('openPanel', 'usage')} title="Tokens ใหม่ ${formatTokens(freshTokens(s))} · cache read ${formatTokens(t.cacheReadTokens)} · ค่าใช้จ่ายเทียบราคา API ${formatUsd(t.estimatedCostUsd)}">
        ${icon('tokens', 14)}<span>${formatTokens(freshTokens(s))}</span><span style="color:var(--text-3)">${formatUsd(t.estimatedCostUsd)}</span>
      </button>
      <span class="chip num" title="Context window ใช้ไป ${ctx}%">${icon('layers', 14)}<span>ctx ${Math.round(ctx)}%</span><span class="bar ctx-mini ${ctx > 85 ? 'is-low' : ctx > 60 ? 'is-mid' : ''}"><i style="width:${ctx > 0 ? Math.max(2, ctx) : 0}%"></i></span></span>
      ${
        s.lifecycle !== 'history' && !connected
          ? `<span class="chip" title="ยังไม่พบ terminal ของห้องนี้ คำสั่งจะเข้าคิวไว้ หรือเปิดโหมดพื้นหลัง">${icon('plug', 14)}ยังไม่เชื่อม terminal</span>`
          : ''
      }
    </div>`;
}

function stepperHtml(s) {
  const idx = stageIndex(s);
  const finished = s.status === 'done' || s.lifecycle === 'history';
  const key = roomState(s).key;
  const attn = key === 'attn';
  const active = !finished && ACTIVE_STATES.has(key);
  const label = active ? STAGES[idx].label : finished ? 'เสร็จแล้ว' : 'ว่าง รอคำสั่งถัดไป';
  return `<div class="stepper" aria-label="ขั้นตอน: ${escapeHtml(label)}">${STAGES.map((st, i) => {
    const done = finished || (active && i < idx);
    const now = active && i === idx;
    const cls = done ? 'is-done' : now ? `is-now${attn ? ' is-attn' : ''}` : '';
    const line = i < STAGES.length - 1 ? `<span class="step-line ${done ? 'is-done' : ''}"></span>` : '';
    return `<span class="step ${cls}" ${now ? 'aria-current="step"' : ''}><span class="step-icon">${icon(done ? 'check' : st.icon, 13)}</span>${st.label}</span>${line}`;
  }).join('')}</div>`;
}

function noticesHtml(s) {
  const parts = [];
  if (s.lifecycle === 'history') {
    parts.push(`
      <div class="notice is-closed">${icon('closed', 18)}
        <div class="notice-text"><span>ปิด tab ไปเมื่อ ${escapeHtml(relTime(s.closedAt || s.updatedAt))} ที่แล้ว</span><span class="notice-sub mono">${escapeHtml(s.cwd || '')}</span></div>
        <button class="btn btn-sm" ${act('resumeRoom', s.id)}>${icon('play', 14)}เปิดต่อ</button>
      </div>`);
  }
  if (s.quotaHold) {
    const u = appState.usageGuard || {};
    parts.push(`
      <div class="notice is-hold">${icon('pauseCircle', 18)}
        <div class="notice-text">
          <span>${s.quotaHold.final ? 'บันทึก checkpoint แล้ว พักรอ usage reset' : 'ให้ทำ step ปัจจุบันให้จบก่อน แล้วจะพักรอ reset'}</span>
          <span class="notice-sub">ทำงานต่ออัตโนมัติ ${escapeHtml(clock(u.resetAt || s.quotaHold.resumeAt))}${s.savedCheckpoint && s.savedCheckpoint.goal ? ` · งาน: ${escapeHtml(plainText(s.savedCheckpoint.goal))}` : ''}</span>
        </div>
        <button class="btn btn-sm" ${act('resumeNow')}>${icon('play', 14)}ทำต่อเลย</button>
      </div>`);
  }
  if (s.lifecycle !== 'history') {
    const ask = askHtml(s);
    if (ask) parts.push(ask);
  }
  return parts.join('');
}

/** Tabs for a prompt with several questions: which is on screen, which are answered, then submit. */
function askTabsHtml(s, p) {
  const n = p.questions.length;
  const allAnswered = p.questions.every((q) => q.answered);
  // The terminal's own position: a question, the submit step (n), or unknown (-1) when the
  // screen matches neither; then tabs can't be stepped to.
  const at = p.activeQuestion >= 0 ? p.activeQuestion : p.reviewStep || allAnswered ? n : -1;
  const tab = (i, label, done) => {
    const isCur = i === at;
    const mark = done ? icon('check', 12) : i < n ? String(i + 1) : icon('send', 11);
    return `<button class="ask-tab ${isCur ? 'is-current' : ''} ${done ? 'is-done' : ''}" role="tab" aria-selected="${isCur}"
        ${at >= 0 && !isCur ? act('askTab', s.id, i, at) : 'disabled'}
        title="${escapeHtml(i < n ? p.questions[i].question : 'ตรวจคำตอบแล้วส่ง')}"><span class="ask-tab-mark">${mark}</span>${escapeHtml(label)}</button>`;
  };
  return `<div class="ask-tabs" role="tablist" aria-label="คำถาม ${n} ข้อ">${p.questions
    .map((q, i) => tab(i, q.header || `ข้อ ${i + 1}`, q.answered))
    .join('')}${tab(n, 'ส่งคำตอบ', false)}</div>`;
}

// Ticks chosen on the dashboard for a multi-select question, sent to the terminal in one go
// (ticking in the terminal one by one redraws the prompt after every click).
// Key: room + question text -> Set of the option positions that should end up ticked.
const askDrafts = new Map();

function askDraftKey(s, p) {
  return `${s.id}|${p.question}`;
}

function isDraftable(p, o) {
  return Boolean(p.multiSelect && o.claude && typeof o.checked === 'boolean');
}

/** Whether the option shows as ticked: the dashboard's pending choice, else the terminal's. */
function draftTicked(s, p, o) {
  const draft = askDrafts.get(askDraftKey(s, p));
  return draft && isDraftable(p, o) ? draft.has(o.index) : Boolean(o.checked);
}

function multiSubmitHtml(s, p) {
  const draft = askDrafts.get(askDraftKey(s, p));
  const ticked = p.options.filter((o) => isDraftable(p, o) && draftTicked(s, p, o)).length;
  const pending = Boolean(draft) && p.options.some((o) => isDraftable(p, o) && draft.has(o.index) !== Boolean(o.checked));
  const label = p.nextIndex ? `ยืนยัน ${ticked} ข้อ แล้วไปต่อ` : `ยืนยัน ${ticked} ข้อ`;
  return `
    <div class="ask-submit">
      <button class="btn btn-attn btn-sm" ${act('submitMulti', s.id)}>${icon('check', 14)}${escapeHtml(label)}</button>
      <span class="ask-note">${pending ? 'ยังไม่ได้ส่งเข้า terminal กดยืนยันเพื่อส่งทีเดียว' : 'ติ๊กได้หลายข้อ แล้วกดยืนยันทีเดียว'}</span>
    </div>`;
}

function askHtml(s) {
  const p = s.interactivePrompt;
  // Drafts belong to the question on screen now; drop this room's older ones.
  if (p && p.question) {
    const keep = askDraftKey(s, p);
    for (const k of askDrafts.keys()) if (k.startsWith(`${s.id}|`) && k !== keep) askDrafts.delete(k);
  }
  const multi = Boolean(p && Array.isArray(p.questions) && p.questions.length > 1);
  const tabKey = (dir) =>
    multi
      ? `<button class="key" ${act('sendKey', s.id, dir)} aria-label="${dir === 'left' ? 'คำถามก่อนหน้า' : 'คำถามถัดไป'}" title="${dir === 'left' ? 'คำถามก่อนหน้า' : 'คำถามถัดไป'}">${dir === 'left' ? '←' : '→'}</button>`
      : '';
  const keys = `
    <div class="ask-keys">
      ${tabKey('left')}
      <button class="key" ${act('sendKey', s.id, 'up')} aria-label="เลื่อนขึ้น" title="เลื่อนขึ้น">${icon('arrowUp', 13)}</button>
      <button class="key" ${act('sendKey', s.id, 'down')} aria-label="เลื่อนลง" title="เลื่อนลง">${icon('arrowDown', 13)}</button>
      ${tabKey('right')}
      <button class="key" ${act('sendKey', s.id, 'enter')} aria-label="Enter" title="Enter">${icon('enter', 13)}</button>
      <button class="key" ${act('sendKey', s.id, 'esc')} title="ยกเลิก (Esc)">Esc</button>
    </div>`;
  if (p && Array.isArray(p.options) && p.options.length) {
    const cur = p.currentIndex || 1;
    // Screen-read context lines are only shown when Claude's own question text isn't known,
    // or on the submit step (its warning, e.g. "Some questions are unanswered").
    const context =
      (p.source !== 'claude' || p.reviewStep) && Array.isArray(p.context) && p.context.length
        ? `<div class="ask-context">${p.context.slice(0, 4).map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</div>`
        : '';
    const chips = [
      p.header && !multi ? `<span class="ask-chip">${escapeHtml(p.header)}</span>` : '',
      p.multiSelect ? '<span class="ask-chip">เลือกได้หลายข้อ</span>' : '',
    ].join('');
    const cursorOpt = p.options.find((o) => o.index === cur);
    const preview = cursorOpt && cursorOpt.preview ? `<pre class="ask-preview">${escapeHtml(cursorOpt.preview)}</pre>` : '';
    return `
      <div class="ask" role="group" aria-label="Claude ถามคุณ">
        ${multi ? askTabsHtml(s, p) : ''}
        <div class="ask-head">${icon('alert', 16)}<div class="ask-q">${escapeHtml(p.question)}${chips ? `<div class="ask-chips">${chips}</div>` : ''}</div></div>
        ${context}
        <div class="ask-options">${p.options.map((o) => {
          const isCur = o.active || o.index === cur;
          const draftable = isDraftable(p, o);
          const ticked = draftTicked(s, p, o);
          const changed = draftable && ticked !== Boolean(o.checked);
          const check =
            typeof o.checked === 'boolean'
              ? `<span class="opt-check ${ticked ? 'is-on' : ''} ${changed ? 'is-pending' : ''}" role="img" aria-label="${ticked ? 'เลือกแล้ว' : 'ยังไม่เลือก'}">${icon('check', 12)}</span>`
              : '';
          // Claude's multi-select options tick on the dashboard; everything else goes straight to the terminal.
          const action = draftable ? act('toggleDraft', s.id, o.index) : act('chooseOption', s.id, o.index, cur, o.number, o.label);
          const hint = draftable ? (ticked ? 'เอาออก' : 'ติ๊ก') : isCur ? 'Enter' : 'เลือก';
          return `<button class="opt ${isCur && !draftable ? 'is-cursor' : ''} ${draftable && ticked ? 'is-ticked' : ''}" ${action} ${draftable ? `aria-pressed="${ticked}"` : ''}>
              <span class="key">${escapeHtml(o.number)}</span>${check}
              <span class="opt-body"><span class="opt-label">${escapeHtml(o.label)}</span>${o.description ? `<span class="opt-desc">${escapeHtml(o.description)}</span>` : ''}</span>
              <span class="opt-hint">${hint}</span></button>`;
        }).join('')}</div>
        ${p.multiSelect && p.options.some((o) => isDraftable(p, o)) ? multiSubmitHtml(s, p) : ''}
        ${preview}
        ${keys}
      </div>`;
  }
  if (p && Array.isArray(p.questions) && p.questions.length) {
    // Claude's questions are open but this terminal layout couldn't be read: list them and let
    // the keys drive the terminal until the screen is recognised again.
    return `
      <div class="ask" role="group" aria-label="Claude ถามคุณ">
        ${multi ? askTabsHtml(s, p) : ''}
        <div class="ask-head">${icon('alert', 16)}<div class="ask-q">Claude ถามคุณ${multi ? ` ${p.questions.length} ข้อ` : ''}<div class="ask-chips"><span class="ask-chip">ตอบใน terminal หรือใช้ปุ่มด้านล่าง</span></div></div></div>
        <ol class="ask-list">${p.questions
          .map((q) => `<li><span class="ask-list-q">${escapeHtml(q.question)}</span><span class="ask-list-o">${q.options.map((o) => escapeHtml(o.label)).join(' · ')}</span></li>`)
          .join('')}</ol>
        ${keys}
      </div>`;
  }
  if (s.pendingAction) {
    return `
      <div class="ask" role="group" aria-label="รอยืนยัน">
        <div class="ask-head">${icon('alert', 16)}<div class="ask-q">รอยืนยัน <span class="mono" style="font-weight:500">${escapeHtml(s.pendingAction)}</span></div></div>
        <div style="display:flex; gap:6px; padding-left:26px; flex-wrap:wrap">
          <button class="btn btn-attn btn-sm" ${act('approve', s.id)}>${icon('check', 14)}อนุญาต</button>
          <button class="btn btn-sm" ${act('sendKey', s.id, 'esc')}>ปฏิเสธ (Esc)</button>
        </div>
      </div>`;
  }
  return '';
}

function outputHeadHtml() {
  return `
    <span class="output-title">${icon('terminal', 14)}Live output</span>
    <button class="icon-btn icon-btn-sm ${ui.mdMode ? '' : 'is-on'}" ${act('toggleMd')} aria-pressed="${!ui.mdMode}" aria-label="แสดงข้อความดิบ" title="${ui.mdMode ? 'แสดงข้อความดิบ (raw)' : 'แสดงแบบจัดรูปแบบ (Markdown)'}">${icon(ui.mdMode ? 'code' : 'text', 15)}</button>
    <button class="btn btn-ghost btn-sm" ${act('fontSize', -1)} aria-label="ตัวอักษรเล็กลง" title="ตัวอักษรเล็กลง">A−</button>
    <button class="btn btn-ghost btn-sm" ${act('fontSize', 1)} aria-label="ตัวอักษรใหญ่ขึ้น" title="ตัวอักษรใหญ่ขึ้น">A+</button>
    <button class="icon-btn icon-btn-sm" ${act('copyOutput')} aria-label="คัดลอก" title="คัดลอกข้อความ">${icon('copy', 15)}</button>
    <button class="icon-btn icon-btn-sm" ${act('toggleExpand')} aria-pressed="${ui.expanded}" aria-label="ขยาย output" title="${ui.expanded ? 'ย่อกลับ (Esc)' : 'ขยาย output'}">${icon(ui.expanded ? 'collapse' : 'expand', 15)}</button>`;
}

function onOutputScroll(e) {
  const el = e.currentTarget;
  if (!mountedFocusId) return;
  scrollState.set(mountedFocusId, {
    top: el.scrollTop,
    stick: el.scrollHeight - el.scrollTop - el.clientHeight <= 32,
  });
}

/* ---------- Reading back ---------- */
// The live preview carries only a room's latest ~30 lines. Older messages of its session are
// fetched a page at a time from where that preview starts (`previewFrom`, a byte offset in the
// room's own transcript) and kept here per room, so they survive updates of the live part.
const olderMsgs = new Map(); // room id -> { lines, from, anchor, transcript, done, loading }

function olderFor(s) {
  const st = olderMsgs.get(s.id);
  if (!st) return null;
  if (st.transcript !== s.transcriptPath) {
    olderMsgs.delete(s.id); // the room moved to another session (e.g. /clear): start over
    return null;
  }
  // The live preview moved forward: refill everything between the oldest loaded line and the
  // new preview start, so nothing falls into the gap.
  if (Number.isFinite(s.previewFrom) && s.previewFrom !== st.anchor && !st.loading) {
    const anchor = s.previewFrom;
    st.loading = true;
    getJson(`/api/session/conversation?sessionId=${encodeURIComponent(s.id)}&before=${anchor}&since=${st.from}`).then((r) => {
      st.loading = false;
      if (r && r.ok) {
        st.lines = r.lines;
        st.anchor = anchor;
      }
      const current = appState.sessions.find((x) => x.id === s.id);
      if (current && mountedFocusId === s.id) syncOutput(current, true);
    });
  }
  return st;
}

async function getJson(url) {
  try {
    const res = await apiFetch(url);
    return await res.json();
  } catch {
    return null;
  }
}

/** Everything the output shows for a room: loaded older messages, then the live preview. */
function outputText(s) {
  const st = olderFor(s);
  const older = st && st.lines.length ? `${st.lines.join('\n\n')}\n\n` : '';
  return older + (s.screenPreview || '');
}

function olderControlHtml(s) {
  const st = olderMsgs.get(s.id);
  if (!Number.isFinite(s.previewFrom) || s.previewFrom <= 0) return '';
  if (st && st.done) return `<div class="output-start">เริ่มต้น session</div>`;
  return `<div class="output-older"><button class="btn btn-ghost btn-sm" ${act('loadOlder', s.id)} ${st && st.loading ? 'disabled' : ''}>${icon('arrowUp', 14)}${st && st.loading ? 'กำลังโหลด…' : 'โหลดข้อความก่อนหน้า'}</button></div>`;
}

function syncOutput(s, force = false) {
  const body = $('#f-out');
  if (!body) return;
  body.style.fontSize = `${ui.fontSize}px`;
  const text = outputText(s);
  const control = olderControlHtml(s);
  const mode = ui.mdMode ? 'md' : 'raw';
  if (!force && body.__text === text && body.__mode === mode && body.__control === control) return;
  body.__text = text;
  body.__mode = mode;
  body.__control = control;
  body.classList.toggle('is-raw', !ui.mdMode);
  if (!text) {
    body.innerHTML = `<div class="output-empty">ยังไม่มีข้อความจากห้องนี้</div>`;
  } else if (ui.mdMode) {
    body.innerHTML = control + renderMarkdown(text);
  } else {
    body.innerHTML = `${control}<div class="output-raw"></div>`;
    body.querySelector('.output-raw').textContent = text;
  }
  const saved = scrollState.get(s.id);
  body.scrollTop = !saved || saved.stick ? body.scrollHeight : saved.top;
}

function renderComposer(s) {
  const el = $('#f-composer');
  el.innerHTML = `
    <div class="attach-tray" id="attach-tray" aria-label="ไฟล์แนบ"></div>
    <div class="composer-box">
      <button class="attach-btn" id="attach-btn" ${act('pickFiles')} aria-label="แนบไฟล์หรือรูป" title="แนบไฟล์หรือรูป (วางภาพด้วย Ctrl+V หรือลากไฟล์มาวางได้)">${icon('paperclip', 19)}</button>
      <input type="file" id="attach-input" multiple hidden />
      <label class="sr-only" for="cmd-input">สั่งงานห้องนี้</label>
      <textarea id="cmd-input" rows="1" placeholder="สั่งงานห้องนี้ (Enter ส่ง, Shift+Enter ขึ้นบรรทัดใหม่)"></textarea>
      <button class="send" id="send-btn" ${act('submitCommand')} aria-label="ส่ง" title="ส่ง (Enter)">${icon('send', 18)}</button>
    </div>
    <div class="composer-row" id="composer-row"></div>`;
  const ta = $('#cmd-input');
  ta.value = drafts.get(s.id) || '';
  autosize(ta);
  ta.addEventListener('input', () => {
    drafts.set(mountedFocusId, ta.value);
    autosize(ta);
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      Actions.submitCommand();
    }
  });
  // A screenshot or a copied image/file pasted into the box becomes an attachment.
  ta.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    const files = dt ? [...dt.files] : [];
    if (!files.length) return;
    if (!(dt.getData('text/plain') || '').trim()) e.preventDefault();
    addAttachments(mountedFocusId, files);
  });
  $('#attach-input').addEventListener('change', (e) => {
    addAttachments(mountedFocusId, [...e.target.files]);
    e.target.value = '';
  });
  // Files dragged from Explorer or a browser onto the composer.
  const hasFiles = (e) => [...(e.dataTransfer ? e.dataTransfer.types : [])].includes('Files');
  el.addEventListener('dragover', (e) => {
    if (!hasFiles(e) || ta.disabled) return;
    e.preventDefault();
    el.classList.add('is-drop');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('is-drop');
  });
  el.addEventListener('drop', (e) => {
    el.classList.remove('is-drop');
    if (!hasFiles(e) || ta.disabled) return;
    e.preventDefault();
    addAttachments(mountedFocusId, [...e.dataTransfer.files]);
  });
  renderAttachTray(s.id);
}

/* ---------- Composer attachments ---------- */
// Files wait here per room until the message is sent. Each uploads as soon as it is added
// (the server stores it outside the repository); the message then carries the file paths.
const attachments = new Map(); // room id -> [{ id, name, size, isImage, status, path, preview, error, done }]
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
const MAX_ATTACH_FILES = 10;

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function attachName(file) {
  // Screenshots arrive from the clipboard as "image.png"; give them a findable name.
  if (!file.name || /^image\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return `screenshot-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
  }
  return file.name;
}

function addAttachments(sessionId, files) {
  if (!sessionId || !files.length) return;
  const list = attachments.get(sessionId) || [];
  attachments.set(sessionId, list);
  for (const file of files) {
    if (list.length >= MAX_ATTACH_FILES) {
      toast(`แนบได้ครั้งละไม่เกิน ${MAX_ATTACH_FILES} ไฟล์`, 'warn');
      break;
    }
    if (file.size > MAX_ATTACH_BYTES) {
      toast(`${file.name || 'ไฟล์'} ใหญ่เกิน 20 MB`, 'warn');
      continue;
    }
    if (file.size === 0) continue; // folders and empty files
    const isImage = /^image\//.test(file.type);
    const item = {
      id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: attachName(file),
      size: file.size,
      isImage,
      status: 'uploading',
      path: null,
      error: '',
      preview: isImage ? URL.createObjectURL(file) : null,
    };
    item.done = uploadAttachment(sessionId, item, file);
    list.push(item);
  }
  renderAttachTray(sessionId);
}

async function uploadAttachment(sessionId, item, file) {
  try {
    const res = await apiFetch(
      `/api/session/attachment?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(item.name)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }
    );
    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (!res.ok || data.ok === false || !data.path) throw new Error(data.error || `HTTP ${res.status}`);
    item.status = 'ready';
    item.path = data.path;
  } catch (err) {
    item.status = 'error';
    item.error = String(err.message || err);
  }
  if (mountedFocusId === sessionId) renderAttachTray(sessionId);
}

function clearAttachments(sessionId) {
  for (const a of attachments.get(sessionId) || []) if (a.preview) URL.revokeObjectURL(a.preview);
  attachments.delete(sessionId);
  if (mountedFocusId === sessionId) renderAttachTray(sessionId);
}

function renderAttachTray(sessionId) {
  const tray = $('#attach-tray');
  if (!tray) return;
  const list = attachments.get(sessionId) || [];
  setHTML(
    tray,
    list
      .map((a) => {
        const sub = a.status === 'uploading' ? 'กำลังอัปโหลด…' : a.status === 'error' ? `อัปโหลดไม่สำเร็จ: ${a.error}` : formatBytes(a.size);
        return `
        <div class="attach-chip is-${a.status}" title="${escapeHtml(a.status === 'ready' ? a.path : a.name)}">
          ${a.preview ? `<img class="attach-thumb" src="${escapeHtml(a.preview)}" alt="" />` : `<span class="attach-icon">${icon('file', 17)}</span>`}
          <span class="attach-meta"><span class="attach-name">${escapeHtml(a.name)}</span><span class="attach-sub">${escapeHtml(sub)}</span></span>
          <button class="attach-x" ${act('removeAttachment', sessionId, a.id)} aria-label="เอา ${escapeHtml(a.name)} ออก" title="เอาออก">${icon('x', 13)}</button>
        </div>`;
      })
      .join('')
  );
}

/** The message Claude receives: the text, then one absolute path per line for it to open. */
function messageWithAttachments(text, files) {
  if (!files.length) return text;
  const lead = text || (files.every((f) => f.isImage) ? 'ช่วยดูรูปที่แนบมา' : 'ช่วยดูไฟล์ที่แนบมา');
  return `${lead}\n\nไฟล์แนบ (${files.length}):\n${files.map((f) => `- ${f.path}`).join('\n')}`;
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(160, ta.scrollHeight)}px`;
}

function updateComposerState(s) {
  const history = s.lifecycle === 'history';
  // During a usage hold new prompts wait for the reset; approvals and keys still work.
  const held = Boolean(appState.usageGuard && appState.usageGuard.hold);
  // A closed room only takes prompts through the background (`claude --resume`) path.
  const closed = history && !ui.headless;
  const ta = $('#cmd-input');
  const send = $('#send-btn');
  const box = $('#f-composer .composer-box');
  if (box) {
    box.classList.toggle('is-held', held);
    box.classList.toggle('is-closed', closed && !held);
  }
  if (ta) {
    ta.disabled = closed;
    ta.placeholder = held
      ? 'พักรอ usage reset อยู่ พิมพ์เก็บไว้ได้ จะส่งได้หลัง reset หรือกด "ทำต่อเลย"'
      : closed
      ? 'ห้องนี้ปิดแล้ว กด "เปิดต่อ" หรือเปิดโหมดพื้นหลังเพื่อสั่งงาน'
      : 'สั่งงานห้องนี้ (Enter ส่ง, Shift+Enter ขึ้นบรรทัดใหม่)';
  }
  const attachBtn = $('#attach-btn');
  if (attachBtn) attachBtn.disabled = closed;
  if (send) {
    send.disabled = held || closed;
    send.title = held ? 'พักรอ usage reset อยู่' : closed ? 'ห้องนี้ปิดแล้ว' : 'ส่ง (Enter)';
  }
  const quickOff = closed ? 'disabled' : '';
  setHTML(
    $('#composer-row'),
    `
    ${held ? `<span class="chip is-held-note">${icon('pauseCircle', 14)}คำสั่งใหม่พักไว้ถึง ${escapeHtml(clock(appState.usageGuard.resetAt))}</span>` : `
    <button class="chip" ${act('quick', 'รันชุดทดสอบ (test) แล้วสรุปผลสั้นๆ')} title="ส่ง: รันชุดทดสอบแล้วสรุปผล" ${quickOff}>${icon('flask', 14)}Run tests</button>
    <button class="chip" ${act('quick', 'สรุปสิ่งที่แก้ไขไปทั้งหมด พร้อมตรวจ git status')} title="ส่ง: สรุปสิ่งที่แก้ไขทั้งหมด" ${quickOff}>${icon('summary', 14)}สรุปงาน</button>`}
    ${
      // Approval keys live on the prompt card only; here the one key that matters is stopping a running turn.
      !history && s.status === 'working'
        ? `<button class="chip" ${act('sendKey', s.id, 'esc')} title="ส่งปุ่ม Esc เข้า terminal เพื่อหยุด Claude">${icon('pauseCircle', 14)}หยุด (Esc)</button>`
        : ''
    }
    <button class="chip toggle-chip" style="margin-left:auto" ${act('toggleHeadless')} aria-pressed="${ui.headless}" title="ส่งผ่าน claude --resume ในพื้นหลัง ใช้ได้แม้ปิด terminal แล้ว">${icon('cloud', 14)}พื้นหลัง</button>`
  );
}

function saveDraft() {
  const ta = $('#cmd-input');
  if (ta && mountedFocusId) drafts.set(mountedFocusId, ta.value);
}

/* ---------- Inspector ---------- */
function renderStrip() {
  const s = selected();
  const fileCount = s ? Math.max(Number(s.dirtyFiles || 0), (s.modifiedFiles || []).length, files.sessionId === s.id ? files.list.length : 0) : 0;
  const agents = s ? (s.subAgents || []).length : 0;
  const turns = s ? (s.taskHistory || []).length : 0;
  const btn = (key, ic, label, badge) => `
    <button class="strip-btn" ${act('togglePanel', key)} aria-pressed="${ui.panel === key}" title="${escapeHtml(label)}" ${s ? '' : 'disabled'}>
      ${icon(ic, 19)}<span>${escapeHtml(label)}</span>${badge ? `<span class="badge">${escapeHtml(badge)}</span>` : ''}
    </button>`;
  setHTML(
    $('#strip'),
    btn('files', 'fileDiff', 'ไฟล์', fileCount || '') +
      btn('agents', 'agents', 'Agents', agents || '') +
      btn('history', 'clock', 'ประวัติ', turns || '') +
      btn('usage', 'gauge', 'Usage', '')
  );
}

function renderPanel() {
  const panel = $('#panel');
  const s = selected();
  if (!ui.panel || !s || ui.view === 'grid') {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const titles = { files: 'ไฟล์ที่แก้ไข', agents: 'Sub-agents', history: 'ประวัติคำสั่ง', usage: 'Usage' };
  let body = '';
  let tools = '';
  if (ui.panel === 'files') {
    maybeLoadFiles(s);
    body = filesPanelHtml(s);
    tools = `<button class="icon-btn icon-btn-sm" ${act('reloadFiles')} aria-label="โหลดใหม่" title="โหลดรายการไฟล์ใหม่">${icon('refresh', 15)}</button>`;
  } else if (ui.panel === 'agents') body = agentsPanelHtml(s);
  else if (ui.panel === 'history') body = historyPanelHtml(s);
  else if (ui.panel === 'usage') body = usagePanelHtml(s);

  setHTML(
    panel,
    `<div class="panel-head"><h2>${escapeHtml(titles[ui.panel])}</h2>${tools}
       <button class="icon-btn icon-btn-sm" ${act('togglePanel', ui.panel)} aria-label="ปิด" title="ปิด (Esc)">${icon('x', 15)}</button></div>
     <div class="panel-body">${body}</div>`
  );
}

function fileStatus(code) {
  const c = String(code || '').trim();
  if (c === '??') return { cls: 'U', label: 'U', text: 'ไฟล์ใหม่ (ยังไม่ track)' };
  if (c.includes('A')) return { cls: 'A', label: 'A', text: 'เพิ่มใหม่' };
  if (c.includes('D')) return { cls: 'D', label: 'D', text: 'ลบ' };
  if (c.includes('R')) return { cls: 'M', label: 'R', text: 'เปลี่ยนชื่อ' };
  if (c === 'Touched') return { cls: 'T', label: '•', text: 'Claude แตะไฟล์นี้ (ไม่มี diff)' };
  return { cls: 'M', label: 'M', text: 'แก้ไข' };
}

function fileRowHtml(s, f, current = false) {
  const st = fileStatus(f.status);
  const parts = String(f.path).split('/');
  const name = parts.pop();
  let dir = parts.join('/');
  // Keep the end of long folder paths, which is the part that tells files apart.
  if (dir.length > 42) dir = `…${dir.slice(-40)}`;
  return `
    <button class="file-row" ${act('openIde', s.id, f.path)} aria-current="${current}" title="${escapeHtml(f.path)} · ${escapeHtml(st.text)}">
      <span class="fstat ${st.cls}">${st.label}</span>
      <span class="fname"><b>${escapeHtml(name)}</b>${dir ? `<span>${escapeHtml(dir)}</span>` : ''}</span>
      <span class="delta">${f.additions ? `<span class="a">+${f.additions}</span>` : ''}${f.deletions ? `<span class="d">−${f.deletions}</span>` : ''}</span>
    </button>`;
}

function filesPanelHtml(s) {
  if (files.sessionId !== s.id || (files.loading && !files.list.length)) {
    return `<div class="panel-empty">กำลังโหลดรายการไฟล์</div>`;
  }
  if (files.error) return `<div class="panel-empty">โหลดไฟล์ไม่สำเร็จ: ${escapeHtml(files.error)}</div>`;
  if (!files.list.length) {
    return `<div class="panel-empty">ไม่มีไฟล์ที่แก้ไขใน working tree</div>
      <div style="display:flex; justify-content:center"><button class="btn btn-sm" ${act('openInVsCode', s.id, '', 1)}>${icon('editor', 14)}เปิดโฟลเดอร์ใน VS Code</button></div>`;
  }
  const add = files.list.reduce((n, f) => n + (f.additions || 0), 0);
  const del = files.list.reduce((n, f) => n + (f.deletions || 0), 0);
  return `
    <div class="panel-section" style="padding-bottom:4px">
      <h3>${files.list.length} ไฟล์ <span class="aside delta"><span class="a">+${add}</span><span class="d">−${del}</span></span></h3>
    </div>
    ${files.list.map((f) => fileRowHtml(s, f)).join('')}
    <div style="padding:12px 8px"><button class="btn btn-sm" ${act('openInVsCode', s.id, '', 1)}>${icon('editor', 14)}เปิดทั้งโฟลเดอร์ใน VS Code</button></div>`;
}

function agentsPanelHtml(s) {
  const subs = s.subAgents || [];
  if (!subs.length) return `<div class="panel-empty">ยังไม่มี sub-agent ในรอบนี้</div>`;
  return subs
    .map((a) => {
      const st = a.state === 'working' ? 's-work' : a.state === 'waiting' ? 's-attn' : 's-done';
      const g = a.state === 'working' ? 'spinner' : a.state === 'waiting' ? 'alert' : 'checkCircle';
      return `<div class="agent-row"><span class="avatar ${st}">${icon(g, 16)}</span>
        <div style="min-width:0"><b>${escapeHtml(a.name)}</b><span>${escapeHtml(a.role || '')}</span></div>
        <span class="chip mono">${escapeHtml(a.tool || '')}</span></div>`;
    })
    .join('');
}

function historyPanelHtml(s) {
  const turns = s.taskHistory || [];
  if (!turns.length) return `<div class="panel-empty">ยังไม่มีประวัติคำสั่งในห้องนี้</div>`;
  return turns
    .map(
      (t) => `<div class="turn">
        <div class="turn-goal"><span>${escapeHtml(plainText(t.goal))}</span><time>${escapeHtml(relTime(t.timestamp))}</time></div>
        ${t.tldr ? `<div class="turn-tldr">${formatInline(escapeHtml(t.tldr))}</div>` : ''}
      </div>`
    )
    .join('');
}

function usagePanelHtml(s) {
  const t = s.tokenUsage || {};
  const ctx = contextPct(s);
  const ctxSize = (s.liveContext && s.liveContext.size) || t.contextWindowTokens || 1000000;
  const u = appState.usageGuard || {};
  const remaining = Number(u.remainingPct ?? 100);
  const threshold = Number(u.autoPauseThresholdPct || 8);
  const barCls = remaining < threshold ? 'is-low' : remaining < 25 ? 'is-mid' : '';
  const sourceText =
    u.source === 'claude'
      ? `จาก Claude Code statusline · อัปเดต ${relTime(u.observedAt)}`
      : u.source === 'simulated'
      ? 'ค่าจำลองสำหรับทดสอบ'
      : `ประมาณจาก token ใหม่ ${formatTokens(u.windowTokens)} / ${formatTokens(u.tokenBudget)} ใน 5 ชม.`;
  const statusline = appState.statusline || {};

  // The connect prompt is only for the estimate path; a simulated test or a live reading never shows it.
  const connect =
    u.source === 'estimate'
      ? statusline.installed || u.observedAt
        ? `<div class="connect">${icon('info', 16)}<div class="help">${u.observedAt ? `ค่าจริงล่าสุดหมดอายุแล้ว (${escapeHtml(relTime(u.observedAt))} ที่แล้ว)` : 'เชื่อม statusline แล้ว'} ตัวเลขจริงจะขึ้นหลัง Claude ตอบครั้งถัดไป (เฉพาะแพลน Pro/Max)</div></div>`
        : `<div class="connect">${icon('link', 16)}<div>
             <div class="help" style="color:var(--text-2); margin-bottom:8px">ตัวเลขนี้เป็นค่าประมาณ เชื่อม statusline ของ Claude Code เพื่อใช้ % จริงของรอบ 5 ชม.${statusline.wrapsPrevious ? '' : ' (ถ้ามี statusline เดิม จะยังแสดงเหมือนเดิม)'}</div>
             <button class="btn btn-sm" ${act('installStatusline')}>${icon('link', 14)}เชื่อม usage จริง</button></div></div>`
      : '';

  return `
    <section class="panel-section">
      <h3>${icon('gauge', 15)}Plan usage รอบ 5 ชม.</h3>
      <div class="quota-line"><span class="big">${remaining}%</span><span class="of">คงเหลือ · ใช้ไป ${escapeHtml(u.usedPct ?? 0)}%</span></div>
      <span class="bar wide-bar ${barCls}" aria-hidden="true"><i style="width:${Math.max(1, remaining)}%"></i><span class="bar-mark" style="left:${threshold}%"></span></span>
      <div class="quota-foot"><span>${escapeHtml(sourceText)}</span><span>reset ${escapeHtml(clock(u.resetAt))}</span></div>
      ${u.sevenDay ? `<div class="quota-foot"><span>รอบ 7 วัน ใช้ไป ${escapeHtml(u.sevenDay.usedPct)}%</span><span>${u.sevenDay.resetsAt ? `reset ${escapeHtml(new Date(u.sevenDay.resetsAt).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' }))}` : ''}</span></div>` : ''}
      ${connect}
    </section>

    <section class="panel-section">
      <h3>${icon('pauseCircle', 15)}พักงานอัตโนมัติ
        <span class="aside"><button class="switch" role="switch" aria-checked="${u.enabled !== false}" aria-label="เปิดใช้การพักงานอัตโนมัติ" ${act('toggleGuard', u.enabled === false)}></button></span></h3>
      <p class="help">เมื่อ usage เหลือน้อยกว่า ${threshold}% ระบบจะบันทึก checkpoint ทุกห้อง ปล่อยให้ step ที่กำลังทำจบก่อน แล้วพักคำสั่งใหม่ไว้จนกว่า usage จะ reset จากนั้นสั่งให้ห้องที่งานค้างทำต่อเอง</p>
      <label class="field">พักเมื่อเหลือน้อยกว่า (%)
        <input type="number" min="1" max="50" step="1" value="${threshold}" data-change-act="setThreshold" /></label>
      ${
        u.source === 'estimate'
          ? `<label class="field">งบ token ใหม่ต่อ 5 ชม. (ค่าประมาณ)
              <input type="number" min="10000" step="100000" value="${escapeHtml(u.tokenBudget || 5000000)}" data-change-act="setBudget" /></label>`
          : ''
      }
      <div class="actions-row">
        ${
          u.hold
            ? `<button class="btn btn-hold btn-sm" ${act('resumeNow')}>${icon('play', 14)}ทำต่อเลย</button>`
            : `<button class="btn btn-ghost btn-sm" ${act('simulateHold')} title="จำลองว่า usage เหลือ 6.5% เพื่อดูการพักงาน">ทดสอบการพัก</button>`
        }
      </div>
    </section>

    <section class="panel-section">
      <h3>${icon('tokens', 15)}ห้องนี้ <span class="aside">${escapeHtml(modelLabel(s.model))}</span></h3>
      <dl class="stat-list">
        <dt title="input + output + cache write">Tokens ใหม่</dt><dd>${formatTokens(freshTokens(s))}</dd>
        <dt>Output</dt><dd>${formatTokens(t.outputTokens)}</dd>
        <dt>Cache read</dt><dd>${formatTokens(t.cacheReadTokens)}</dd>
        <dt>ใน 5 ชม. ล่าสุด</dt><dd>${formatTokens(t.window5hTokens)}</dd>
        <dt title="คิดตามราคา API ต่อ model ไม่ใช่ค่าใช้จ่ายจริงของแพลน subscription">เทียบราคา API</dt><dd>${formatUsd(t.estimatedCostUsd)}</dd>
        <dt>Context</dt><dd>${Math.round(ctx)}%<small>ของ ${formatTokens(ctxSize)}</small></dd>
      </dl>
      <span class="bar wide-bar ${ctx > 85 ? 'is-low' : ctx > 60 ? 'is-mid' : ''}" aria-hidden="true" style="margin-top:8px"><i style="width:${Math.max(1, ctx)}%"></i></span>
    </section>`;
}

/* ---------- Files & IDE ---------- */
function filesSignature(s) {
  return `${s.id}|${s.dirtyFiles || 0}|${(s.modifiedFiles || []).length}`;
}

function maybeLoadFiles(s) {
  if (files.loading) return;
  if (files.sessionId === s.id && files.signature === filesSignature(s)) return;
  loadFiles(s.id);
}

async function loadFiles(sessionId) {
  const s = appState.sessions.find((x) => x.id === sessionId);
  files.loading = true;
  if (files.sessionId !== sessionId) files.list = [];
  files.sessionId = sessionId;
  files.error = null;
  try {
    const res = await apiFetch(`/api/session/files?sessionId=${encodeURIComponent(sessionId)}`);
    const data = await res.json();
    if (data.ok) files.list = data.files || [];
    else files.error = data.error || 'error';
  } catch (err) {
    files.error = err.message;
  }
  files.loading = false;
  files.signature = s ? filesSignature(s) : '';
  renderPanel();
  renderStrip();
  if (ide.open) renderIde();
}

function parseUnifiedDiff(text) {
  const rows = [];
  let oldN = 0;
  let newN = 0;
  let inHunk = false;
  for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (m) {
        oldN = Number(m[1]);
        newN = Number(m[2]);
        inHunk = true;
        rows.push({ type: 'hunk', text: line });
      }
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('diff --git')) {
      inHunk = false;
      continue;
    }
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) rows.push({ type: 'add', newN: newN++, text: line.slice(1) });
    else if (line.startsWith('-')) rows.push({ type: 'del', oldN: oldN++, text: line.slice(1) });
    else rows.push({ type: 'ctx', oldN: oldN++, newN: newN++, text: line.slice(1) });
  }
  if (rows.length && rows[rows.length - 1].type === 'ctx' && rows[rows.length - 1].text === '') rows.pop();
  return rows;
}

function lnButton(sessionId, path, n) {
  if (!n) return '';
  return `<button ${act('openInVsCode', sessionId, path, n)} title="เปิดบรรทัด ${n} ใน VS Code">${n}</button>`;
}

function ideCodeHtml() {
  const d = ide.detail;
  if (ide.loading && !d) return `<div class="code-msg">กำลังโหลดไฟล์</div>`;
  if (!d) return `<div class="code-msg">เลือกไฟล์ทางซ้ายเพื่อดู</div>`;
  if (!d.ok) return `<div class="code-msg">เปิดไฟล์ไม่ได้: ${escapeHtml(d.error || '')}</div>`;
  const sid = ide.sessionId;
  const path = ide.path;

  if (ide.mode === 'diff') {
    const rows = parseUnifiedDiff(d.diff);
    if (!rows.length) {
      return `<div class="code-msg">${d.exists ? 'ไฟล์นี้ไม่มี diff เทียบกับ HEAD (อาจเป็นไฟล์ใหม่ที่ยังไม่ track)' : 'ไฟล์ถูกลบไปแล้ว'}<br /><br />
        ${d.exists ? `<button class="btn btn-sm" ${act('setIdeMode', 'source')}>${icon('code', 14)}ดู source</button>` : ''}</div>`;
    }
    return `<table><tbody>${rows
      .map((r) => {
        if (r.type === 'hunk') return `<tr class="hunk"><td class="ln"></td><td class="ln"></td><td class="src">${escapeHtml(r.text)}</td></tr>`;
        return `<tr class="${r.type}"><td class="ln">${r.oldN || ''}</td><td class="ln">${lnButton(sid, path, r.newN)}</td><td class="src">${escapeHtml(r.text)}</td></tr>`;
      })
      .join('')}</tbody></table>`;
  }

  if (!d.exists) return `<div class="code-msg">ไฟล์ถูกลบไปแล้ว ดูได้เฉพาะ diff</div>`;
  const changed = new Set(parseUnifiedDiff(d.diff).filter((r) => r.type === 'add').map((r) => r.newN));
  const f = files.list.find((x) => x.path === path);
  const allNew = f && String(f.status).trim() === '??';
  const lines = String(d.content || '').replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return `<table><tbody>${lines
    .map((l, i) => {
      const n = i + 1;
      return `<tr class="${allNew || changed.has(n) ? 'changed' : ''}"><td class="ln">${lnButton(sid, path, n)}</td><td class="src">${escapeHtml(l)}</td></tr>`;
    })
    .join('')}</tbody></table>${d.truncated ? `<div class="code-msg">แสดง 120 KB แรกเท่านั้น เปิดใน VS Code เพื่อดูทั้งไฟล์</div>` : ''}`;
}

function renderIde() {
  const el = $('#ide');
  if (!ide.open) {
    el.hidden = true;
    return;
  }
  const s = appState.sessions.find((x) => x.id === ide.sessionId);
  el.hidden = false;
  const f = files.list.find((x) => x.path === ide.path);
  const parts = String(ide.path || '').split('/');
  const name = parts.pop() || '';
  const dir = parts.join('/');
  el.innerHTML = `
    <div class="ide-bar">
      <div class="ide-crumb">${icon('folder', 15)}<span>${escapeHtml(s ? s.room : '')}${dir ? ` / ${escapeHtml(dir)}` : ''}</span><span>/</span><b>${escapeHtml(name)}</b></div>
      <div class="ide-spacer"></div>
      ${ide.path ? `<button class="btn btn-sm" ${act('openInVsCode', ide.sessionId, ide.path, 1)}>${icon('editor', 14)}เปิดใน VS Code</button>` : ''}
      <button class="icon-btn" ${act('closeIde')} aria-label="ปิด" title="ปิด (Esc)">${icon('x', 17)}</button>
    </div>
    <div class="ide-body">
      <nav class="ide-files" aria-label="ไฟล์ที่แก้ไข">
        <div class="group-head" style="padding-top:4px">ไฟล์ที่แก้ไข <span class="count">${files.list.length}</span></div>
        ${files.list.map((x) => fileRowHtml(s || { id: ide.sessionId }, x, x.path === ide.path)).join('') || '<div class="panel-empty">ไม่มีไฟล์</div>'}
      </nav>
      <div class="ide-main">
        <div class="ide-tabs">
          <div class="seg" style="flex:0 0 auto" role="group" aria-label="มุมมองไฟล์">
            <button aria-pressed="${ide.mode === 'diff'}" ${act('setIdeMode', 'diff')}>${icon('fileDiff', 14)}Diff</button>
            <button aria-pressed="${ide.mode === 'source'}" ${act('setIdeMode', 'source')}>${icon('code', 14)}Source</button>
          </div>
          ${f ? `<span class="delta">${f.additions ? `<span class="a">+${f.additions}</span>` : ''}${f.deletions ? `<span class="d">−${f.deletions}</span>` : ''}</span>` : ''}
        </div>
        <div class="code" tabindex="0">${ideCodeHtml()}</div>
      </div>
    </div>`;
}

async function loadIdeDetail() {
  if (!ide.sessionId || !ide.path) return;
  ide.loading = true;
  ide.detail = null;
  renderIde();
  try {
    const res = await apiFetch(
      `/api/session/file-content?sessionId=${encodeURIComponent(ide.sessionId)}&file=${encodeURIComponent(ide.path)}`
    );
    ide.detail = await res.json();
    if (ide.detail.ok && !String(ide.detail.diff || '').trim() && ide.detail.exists) ide.mode = 'source';
  } catch (err) {
    ide.detail = { ok: false, error: err.message };
  }
  ide.loading = false;
  renderIde();
}

/* ---------- Overview ---------- */
function renderOverview() {
  const el = $('#overview');
  if (ui.view !== 'grid') return;
  const list = appState.sessions.filter((s) => matchesFilters(s) && s.lifecycle !== 'history');

  // One line that answers "who needs me" before any card is read.
  const counts = { attn: 0, work: 0, hold: 0, rest: 0 };
  for (const s of list) {
    const k = roomState(s).key;
    counts[k in counts ? k : 'rest'] += 1;
  }
  const summary = [
    ['attn', 's-attn', 'รอคุณ'],
    ['work', 's-work', 'กำลังทำงาน'],
    ['hold', 's-hold', 'พักรอ reset'],
    ['rest', '', 'ว่าง / เสร็จแล้ว'],
  ]
    .filter(([k]) => k !== 'hold' || counts.hold)
    .map(([k, cls, label]) => `<span class="pill ${counts[k] ? cls : ''}"><b class="num">${counts[k]}</b>${escapeHtml(label)}</span>`)
    .join('');
  const head = `<div class="ov-top"><h2 class="ov-title">ภาพรวมทุกห้อง</h2><div class="ov-summary" aria-label="สรุปสถานะ">${summary}</div></div>${hooksNoticeHtml()}`;
  if (!list.length) {
    setHTML(el, `${head}<div class="empty-list">ไม่มีห้องที่เปิดอยู่</div>`);
    return;
  }

  // Project lanes, densely packed; lanes holding a room that waits on you come first,
  // then the order the user dragged rooms into.
  const rank = { attn: 0, work: 1, hold: 2, done: 3, idle: 4, closed: 5 };
  const position = new Map(manualOrderIds().map((id, i) => [id, i]));
  const lanes = new Map();
  for (const s of list) {
    const k = s.project || 'General';
    if (!lanes.has(k)) lanes.set(k, []);
    lanes.get(k).push(s);
  }
  const ordered = [...lanes.entries()]
    .map(([name, items]) => {
      items.sort((a, b) => rank[roomState(a).key] - rank[roomState(b).key] || byManualOrder(a, b));
      const first = Math.min(...items.map((s) => position.get(s.id) ?? Infinity));
      return { name, items, best: rank[roomState(items[0]).key], first };
    })
    .sort((a, b) => a.best - b.best || a.first - b.first || a.name.localeCompare(b.name));
  const html = ordered
    .map(
      ({ name, items }) => `
      <section class="ov-lane" aria-label="${escapeHtml(name)}">
        <div class="ov-head">${icon('folder', 16)}<span class="ov-name">${escapeHtml(name)}</span><span class="count">${items.length}</span></div>
        <div class="ov-path mono" title="${escapeHtml(items[0].cwd || '')}">${escapeHtml(items[0].cwd || '')}</div>
        <div class="ov-stack">${items.map((s) => rcardHtml(s)).join('')}</div>
      </section>`
    )
    .join('');
  setHTML(el, `${head}<div class="ov-lanes">${html}</div>`);
}

/* ---------- Popovers ---------- */
function openPopover(anchor, html, kind) {
  const pop = $('#popover');
  pop.innerHTML = html;
  pop.hidden = false;
  popoverKind = kind;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - w - 12);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 6);
  pop.style.left = `${Math.max(12, left)}px`;
  pop.style.top = `${top}px`;
  const first = pop.querySelector('button, select, input');
  if (first) first.focus({ preventScroll: true });
}

function closePopover() {
  const pop = $('#popover');
  if (!pop.hidden) {
    pop.hidden = true;
    popoverKind = null;
  }
}

function modelPopoverHtml(s) {
  const fam = modelFamily(s.model);
  const effort = String(s.effort || 'high');
  return `
    <div class="pop-label">Model</div>
    ${MODELS.map(
      (m) => `<button class="pop-item" ${act('setModel', s.id, m.value)}>${icon('spark', 15)}${escapeHtml(m.label)}
        ${fam === m.family ? `<span class="check">${icon('check', 15)}</span>` : `<span class="desc">${escapeHtml(m.desc)}</span>`}</button>`
    ).join('')}
    <div class="pop-sep"></div>
    <div class="pop-label">Effort</div>
    <div class="pop-seg" role="group" aria-label="Effort">${EFFORTS.map(
      (e) => `<button aria-pressed="${effort === e}" ${act('setEffort', s.id, e)}>${e}</button>`
    ).join('')}</div>
    <div class="help" style="padding:2px 8px 6px">ส่ง /model และ /effort เข้า terminal ของห้องนี้</div>`;
}

function morePopoverHtml(s) {
  const history = s.lifecycle === 'history';
  return `
    <button class="pop-item" ${act('resumeRoom', s.id)}>${icon('play', 15)}${history ? 'เปิดต่อใน Windows Terminal' : 'เปิด/กู้คืนใน Windows Terminal'}</button>
    <button class="pop-item" ${act('openEdit', s.id)}>${icon('edit', 15)}แก้ไขห้อง</button>
    <button class="pop-item" ${act('copyPath', s.id)}>${icon('copy', 15)}คัดลอก path</button>
    <div class="pop-sep"></div>
    ${
      history
        ? `<button class="pop-item is-danger" ${act('removeRoom', s.id)}>${icon('trash', 15)}ลบถาวร</button>`
        : `<button class="pop-item" ${act('archiveRoom', s.id)}>${icon('archive', 15)}เก็บเข้าประวัติ</button>`
    }`;
}

function filtersPopoverHtml() {
  const opt = (v, cur) => `<option value="${escapeHtml(v)}" ${cur === v ? 'selected' : ''}>${escapeHtml(v)}</option>`;
  return `
    <div class="pop-label">โปรเจกต์</div>
    <div style="padding:0 6px"><select class="pop-select" data-change-act="setProject" aria-label="โปรเจกต์">
      <option value="ALL">ทุกโปรเจกต์</option>${(appState.projects || []).map((p) => opt(p, ui.project)).join('')}</select></div>
    <div class="pop-label">หมวดหมู่</div>
    <div style="padding:0 6px"><select class="pop-select" data-change-act="setCategory" aria-label="หมวดหมู่">
      <option value="ALL">ทุกหมวดหมู่</option>${(appState.categories || []).map((c) => opt(c, ui.category)).join('')}</select></div>
    <div class="pop-sep"></div>
    <button class="pop-item" ${act('togglePinnedOnly')}>${icon('pin', 15)}เฉพาะที่ปักหมุด${ui.pinnedOnly ? `<span class="check">${icon('check', 15)}</span>` : ''}</button>
    ${ui.project !== 'ALL' || ui.category !== 'ALL' || ui.pinnedOnly ? `<button class="pop-item" ${act('clearFilters')}>${icon('x', 15)}ล้างตัวกรอง</button>` : ''}`;
}

/* ---------- Render root ---------- */
function renderAll() {
  ensureSelection();
  $('#work').classList.toggle('is-grid', ui.view === 'grid');
  renderSidebar();
  renderHoldBanner();
  renderList();
  if (ui.view === 'grid') renderOverview();
  else renderFocus();
  renderStrip();
  renderPanel();
}

/* ---------- Actions ---------- */
async function sendCommand(sessionId, command, isApproval = false) {
  const r = await postJson('/api/session/command', {
    sessionId,
    command,
    isApproval,
    runHeadless: ui.headless,
  });
  if (r.status === 423) {
    toast('พักงานรอ usage reset อยู่ คำสั่งยังไม่ถูกส่ง กด "ทำต่อเลย" ถ้าต้องการส่งตอนนี้', 'warn');
    return false;
  }
  if (!r.ok) {
    toast(`ส่งคำสั่งไม่สำเร็จ: ${r.data.error || r.data.message || r.status}`, 'err');
    return false;
  }
  toast(cleanMsg(r.data.message) || 'ส่งแล้ว', r.data.delivered === false ? 'warn' : 'ok');
  return true;
}

function openVscodeUri(uri) {
  const a = document.createElement('a');
  a.href = uri;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const Actions = {
  selectRoom(id) {
    ui.selectedId = id;
    if (ui.view === 'grid') ui.view = 'focus';
    const s = selected();
    if (s && s.lifecycle === 'history' && ui.lifecycle !== 'history') ui.lifecycle = 'history';
    if (s && s.lifecycle !== 'history' && ui.lifecycle === 'history') ui.lifecycle = 'live';
    // A room chosen from the overview may not be waiting on you; show it in the full list.
    if (s && ui.filter === 'attn' && roomState(s).key !== 'attn') ui.filter = 'all';
    if (ide.open && ide.sessionId !== id) Actions.closeIde();
    savePrefs();
    renderAll();
    // On a phone the room sits below the list: bring it into view after a tap.
    if (window.matchMedia('(max-width: 900px)').matches) {
      const focus = $('#focus');
      if (focus) focus.scrollIntoView({ block: 'start' });
    }
  },
  jumpToAttention() {
    const s = appState.sessions.find((x) => x.lifecycle !== 'history' && x.status === 'needs_input');
    if (!s) return;
    ui.lifecycle = 'live';
    ui.search = '';
    $('#search-input').value = '';
    Actions.selectRoom(s.id);
  },
  setLifecycle(v) {
    ui.lifecycle = v;
    savePrefs();
    renderAll();
  },
  navigate(key) {
    ui.view = key === 'overview' ? 'grid' : 'focus';
    ui.lifecycle = key === 'history' ? 'history' : 'live';
    ui.filter = key === 'attn' ? 'attn' : 'all';
    if (key === 'overview') ui.panel = null;
    savePrefs();
    renderAll();
  },
  cycleTheme() {
    ui.theme = ui.theme === 'auto' ? 'light' : ui.theme === 'light' ? 'dark' : 'auto';
    applyTheme();
    savePrefs();
    renderSidebar();
    toast(ui.theme === 'auto' ? 'ธีมตามระบบ' : ui.theme === 'light' ? 'ธีมสว่าง' : 'ธีมมืด');
  },
  toggleView() {
    ui.view = ui.view === 'grid' ? 'focus' : 'grid';
    savePrefs();
    renderAll();
  },
  togglePanel(key) {
    ui.panel = ui.panel === key ? null : key;
    savePrefs();
    renderStrip();
    renderPanel();
  },
  openPanel(key) {
    if (ui.view === 'grid') ui.view = 'focus';
    ui.panel = key;
    savePrefs();
    renderAll();
  },
  openFilters(_, el) {
    if (popoverKind === 'filters') return closePopover();
    openPopover(el, filtersPopoverHtml(), 'filters');
  },
  openModel(id, el) {
    const s = appState.sessions.find((x) => x.id === id);
    if (!s) return;
    if (popoverKind === 'model') return closePopover();
    openPopover(el, modelPopoverHtml(s), 'model');
  },
  openMore(id, el) {
    const s = appState.sessions.find((x) => x.id === id);
    if (!s) return;
    if (popoverKind === 'more') return closePopover();
    openPopover(el, morePopoverHtml(s), 'more');
  },
  togglePinnedOnly() {
    ui.pinnedOnly = !ui.pinnedOnly;
    closePopover();
    renderAll();
  },
  clearFilters() {
    ui.project = 'ALL';
    ui.category = 'ALL';
    ui.pinnedOnly = false;
    closePopover();
    renderAll();
  },
  setProject(v) {
    ui.project = v || 'ALL';
    renderAll();
  },
  setCategory(v) {
    ui.category = v || 'ALL';
    renderAll();
  },

  async setModel(id, value) {
    closePopover();
    const r = await postJson('/api/session/model-effort', { sessionId: id, model: value });
    const label = (MODELS.find((m) => m.value === value) || {}).label || value;
    if (!r.ok) return toast(`เปลี่ยน model ไม่สำเร็จ: ${r.data.error || r.status}`, 'err');
    toast(r.data.delivered ? `ส่ง /model ${value} แล้ว (${label})` : `ยังส่งเข้า terminal ไม่ได้ คำสั่ง /model เข้าคิวไว้`, r.data.delivered ? 'ok' : 'warn');
  },
  async setEffort(id, value) {
    closePopover();
    const r = await postJson('/api/session/model-effort', { sessionId: id, effort: value });
    if (!r.ok) return toast(`ปรับ effort ไม่สำเร็จ: ${r.data.error || r.status}`, 'err');
    toast(r.data.delivered ? `ส่ง /effort ${value} แล้ว` : `ยังส่งเข้า terminal ไม่ได้ คำสั่ง /effort เข้าคิวไว้`, r.data.delivered ? 'ok' : 'warn');
  },

  async chooseOption(id, targetIndex, currentIndex, number, label) {
    const r = await postJson('/api/session/select-option', { sessionId: id, targetIndex, currentIndex, number, label });
    if (!r.ok) return toast(`เลือกไม่สำเร็จ: ${r.data.error || r.data.message || r.status}`, 'err');
    toast(cleanMsg(r.data.message) || `เลือก ${label}`, r.data.delivered === false ? 'warn' : 'ok');
  },
  /** Tick or untick a multi-select option on the dashboard only; nothing is sent yet. */
  toggleDraft(id, index) {
    const s = appState.sessions.find((x) => x.id === id);
    const p = s && s.interactivePrompt;
    if (!p) return;
    const key = askDraftKey(s, p);
    if (!askDrafts.has(key)) {
      askDrafts.set(key, new Set(p.options.filter((o) => isDraftable(p, o) && o.checked).map((o) => o.index)));
    }
    const draft = askDrafts.get(key);
    if (draft.has(index)) draft.delete(index);
    else draft.add(index);
    renderFocus();
  },
  /** Send the ticked set: Enter on every option whose tick differs from the terminal, then Next. */
  async submitMulti(id) {
    const s = appState.sessions.find((x) => x.id === id);
    const p = s && s.interactivePrompt;
    if (!p) return;
    const key = askDraftKey(s, p);
    const toggles = p.options
      .filter((o) => isDraftable(p, o) && draftTicked(s, p, o) !== Boolean(o.checked))
      .map((o) => o.index);
    const r = await postJson('/api/session/multi-select', {
      sessionId: id,
      toggles,
      currentIndex: p.currentIndex || 1,
      nextIndex: p.nextIndex || null,
    });
    if (!r.ok || r.data.ok === false) {
      return toast(cleanMsg(r.data.message || r.data.error) || 'ส่งคำตอบไม่สำเร็จ', 'err');
    }
    askDrafts.delete(key);
    toast(cleanMsg(r.data.message) || 'ส่งคำตอบแล้ว');
  },
  /** Move the terminal's question tab from `from` to `to` with ←/→, one step at a time. */
  async askTab(id, to, from) {
    const delta = Number(to) - Number(from);
    const key = delta > 0 ? 'right' : 'left';
    for (let i = 0; i < Math.abs(delta); i++) {
      const r = await postJson('/api/session/send-key', { sessionId: id, key });
      if (!r.ok || r.data.ok === false) return toast(cleanMsg(r.data.message || r.data.error) || 'สลับคำถามไม่สำเร็จ', 'warn');
    }
  },
  async sendKey(id, key) {
    const r = await postJson('/api/session/send-key', { sessionId: id, key });
    if (!r.ok) toast(cleanMsg(r.data.message || r.data.error) || 'ส่งปุ่มไม่สำเร็จ', 'warn');
  },
  approve(id) {
    return sendCommand(id, '1', true);
  },
  approveWith(id, value) {
    return sendCommand(id, value, true);
  },
  quick(text) {
    const s = selected();
    if (s) return sendCommand(s.id, text, false);
  },
  async submitCommand() {
    const s = selected();
    const ta = $('#cmd-input');
    if (!s || !ta) return;
    const list = attachments.get(s.id) || [];
    if (!ta.value.trim() && !list.length) return;
    if (list.some((a) => a.status === 'uploading')) {
      toast('รออัปโหลดไฟล์ให้เสร็จแล้วจะส่งให้', 'warn');
      await Promise.all(list.map((a) => a.done));
    }
    const failed = list.filter((a) => a.status === 'error');
    if (failed.length) {
      return toast(`มี ${failed.length} ไฟล์ที่อัปโหลดไม่สำเร็จ เอาออกแล้วลองแนบใหม่`, 'err');
    }
    const text = ta.value.trim();
    const sent = await sendCommand(s.id, messageWithAttachments(text, list.filter((a) => a.status === 'ready')), false);
    if (sent) {
      ta.value = '';
      drafts.delete(s.id);
      autosize(ta);
      clearAttachments(s.id);
    }
  },
  pickFiles() {
    const input = $('#attach-input');
    if (input && !$('#cmd-input').disabled) input.click();
  },
  removeAttachment(sessionId, id) {
    const list = attachments.get(sessionId) || [];
    const item = list.find((a) => a.id === id);
    if (item && item.preview) URL.revokeObjectURL(item.preview);
    attachments.set(sessionId, list.filter((a) => a.id !== id));
    renderAttachTray(sessionId);
  },
  toggleHeadless() {
    ui.headless = !ui.headless;
    savePrefs();
    const s = selected();
    if (s) updateComposerState(s);
  },
  toggleMd() {
    ui.mdMode = !ui.mdMode;
    savePrefs();
    renderFocus();
  },
  fontSize(delta) {
    ui.fontSize = Math.min(20, Math.max(11, ui.fontSize + delta));
    savePrefs();
    const body = $('#f-out');
    if (body) body.style.fontSize = `${ui.fontSize}px`;
  },
  /** Load the page of messages just before what the output already shows. */
  async loadOlder(id) {
    const s = appState.sessions.find((x) => x.id === id);
    if (!s || !Number.isFinite(s.previewFrom)) return;
    let st = olderFor(s);
    if (!st) {
      st = { lines: [], from: s.previewFrom, anchor: s.previewFrom, transcript: s.transcriptPath, done: false, loading: false };
      olderMsgs.set(id, st);
    }
    if (st.loading || st.done) return;
    st.loading = true;
    syncOutput(s, true);
    const r = await getJson(`/api/session/conversation?sessionId=${encodeURIComponent(id)}&before=${st.from}&limit=40`);
    st.loading = false;
    if (!r || !r.ok) {
      syncOutput(s, true);
      return toast('โหลดข้อความก่อนหน้าไม่สำเร็จ', 'err');
    }
    st.lines = [...r.lines, ...st.lines];
    st.from = r.from;
    st.done = r.done;
    // Keep the reader where they were: the new lines appear above.
    const body = $('#f-out');
    const prevHeight = body ? body.scrollHeight : 0;
    const prevTop = body ? body.scrollTop : 0;
    scrollState.set(id, { top: prevTop, stick: false });
    syncOutput(s, true);
    if (body && mountedFocusId === id) {
      body.scrollTop = prevTop + (body.scrollHeight - prevHeight);
      scrollState.set(id, { top: body.scrollTop, stick: false });
    }
  },
  async copyOutput() {
    const s = selected();
    if (!s || !outputText(s)) return;
    try {
      await navigator.clipboard.writeText(outputText(s));
      toast('คัดลอกแล้ว');
    } catch {
      toast('คัดลอกไม่สำเร็จ', 'err');
    }
  },
  toggleExpand() {
    ui.expanded = !ui.expanded;
    renderFocus();
  },

  async openInVsCode(id, file, line) {
    const r = await postJson('/api/session/open-vscode', { sessionId: id, file: file || undefined, line: line || 1 });
    if (!r.ok || !r.data.uri) return toast(`เปิด VS Code ไม่ได้: ${r.data.error || r.status}`, 'err');
    openVscodeUri(r.data.uri);
    toast(cleanMsg(r.data.message));
  },
  async openIde(id, path) {
    if (files.sessionId !== id || !files.list.length) await loadFiles(id);
    ide.open = true;
    ide.sessionId = id;
    ide.path = path || (files.list[0] && files.list[0].path) || null;
    ide.mode = 'diff';
    closePopover();
    await loadIdeDetail();
    const code = $('#ide .code');
    if (code) code.focus({ preventScroll: true });
  },
  setIdeMode(mode) {
    ide.mode = mode;
    renderIde();
  },
  closeIde() {
    ide.open = false;
    ide.detail = null;
    renderIde();
  },
  reloadFiles() {
    const s = selected();
    if (s) loadFiles(s.id);
  },

  async togglePin(id, pinned) {
    const r = await postJson('/api/session/update', { sessionId: id, patch: { pinned: Boolean(pinned) } });
    if (!r.ok) return;
    if (pinned) await saveRoomMove(id); // pinning puts the room at the top of its group
    toast(pinned ? 'ปักหมุดแล้ว' : 'เลิกปักหมุดแล้ว');
  },
  openEdit(id) {
    closePopover();
    const s = appState.sessions.find((x) => x.id === id);
    if (!s) return;
    $('#edit-session-id').value = s.id;
    $('#edit-room-name').value = s.room || '';
    $('#edit-room-category').value = s.category || 'General';
    $('#edit-room-goal').value = s.goal || '';
    $('#edit-dialog').showModal();
  },
  async copyPath(id) {
    closePopover();
    const s = appState.sessions.find((x) => x.id === id);
    if (!s) return;
    try {
      await navigator.clipboard.writeText(s.cwd || '');
      toast('คัดลอก path แล้ว');
    } catch {
      toast('คัดลอกไม่สำเร็จ', 'err');
    }
  },
  async archiveRoom(id) {
    closePopover();
    const r = await postJson('/api/session/update', { action: 'archive', sessionId: id });
    if (r.ok) toast('เก็บเข้าประวัติแล้ว');
  },
  async removeRoom(id) {
    closePopover();
    const s = appState.sessions.find((x) => x.id === id);
    if (!window.confirm(`ลบห้อง "${s ? s.room : id}" ออกจากประวัติถาวร?`)) return;
    const r = await postJson('/api/session/update', { action: 'remove', sessionId: id });
    if (r.ok) toast('ลบแล้ว');
  },
  async clearHistory() {
    if (!window.confirm('ล้างห้องในประวัติที่ไม่ได้ปักหมุดทั้งหมด?')) return;
    const r = await postJson('/api/session/update', { action: 'clear-history' });
    if (r.ok) toast('ล้างประวัติแล้ว');
  },
  async resumeRoom(id) {
    closePopover();
    const r = await postJson('/api/session/resume', { sessionId: id, resume: true });
    toast(cleanMsg(r.data.message || r.data.error) || 'สั่งเปิดต่อแล้ว', r.ok ? 'ok' : 'err');
    if (r.ok) ui.lifecycle = 'live';
  },

  async installHooks() {
    const r = await postJson('/api/hooks/install', {});
    if (!r.ok) return toast(`ติดตั้ง hooks ไม่สำเร็จ: ${r.data.error || r.status}`, 'err');
    appState.hooks = r.data;
    renderSidebar();
    renderList();
    toast('เชื่อม Claude Code hooks แล้ว ห้องที่เปิดไว้ก่อนหน้านี้ต้องเปิดใหม่ถึงจะส่งสถานะ');
  },
  async installStatusline() {
    const r = await postJson('/api/statusline/install', {});
    if (!r.ok) return toast(`เชื่อม statusline ไม่สำเร็จ: ${r.data.error || r.status}`, 'err');
    appState.statusline = r.data;
    renderPanel();
    toast(r.data.wrapsPrevious ? 'เชื่อมแล้ว statusline เดิมยังแสดงเหมือนเดิม' : 'เชื่อม statusline แล้ว');
  },
  async scanTerminals() {
    const r = await postJson('/api/console/scan', {});
    toast(r.ok ? 'สแกน terminal แล้ว' : 'สแกนไม่สำเร็จ', r.ok ? 'ok' : 'err');
  },

  async resumeNow() {
    const r = await postJson('/api/usage/config', { action: 'reset-and-resume' });
    if (!r.ok) return toast('ทำต่อไม่สำเร็จ', 'err');
    const n = (r.data.resumedSessions || []).length;
    toast(n ? `ส่งให้ ${n} ห้องทำงานต่อแล้ว` : 'ปลดพักแล้ว');
  },
  async simulateHold() {
    if (!window.confirm('จำลองว่า usage เหลือ 6.5%? ทุกห้องจะถูกบันทึก checkpoint และพักคำสั่งใหม่จนกว่าจะกด "ทำต่อเลย"')) return;
    const r = await postJson('/api/usage/config', { action: 'simulate-low-quota' });
    toast(r.ok ? 'เริ่มพักงาน (จำลอง) แล้ว' : 'จำลองไม่สำเร็จ', r.ok ? 'warn' : 'err');
  },
  async toggleGuard(enabled) {
    const r = await postJson('/api/usage/config', { enabled: Boolean(enabled) });
    if (r.ok) toast(enabled ? 'เปิดการพักงานอัตโนมัติแล้ว' : 'ปิดการพักงานอัตโนมัติแล้ว', enabled ? 'ok' : 'warn');
  },
  async setThreshold(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1 || n > 50) return toast('ใส่ได้ 1 ถึง 50', 'warn');
    const r = await postJson('/api/usage/config', { autoPauseThresholdPct: n });
    if (r.ok) toast(`จะพักเมื่อเหลือน้อยกว่า ${n}%`);
  },
  async setBudget(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 10000) return toast('งบต้องไม่น้อยกว่า 10,000 tokens', 'warn');
    const r = await postJson('/api/usage/config', { tokenBudget: n });
    if (r.ok) toast(`ตั้งงบ ${formatTokens(n)} tokens ต่อ 5 ชม.`);
  },

  openSpawn() {
    const s = selected();
    const cwd = $('#spawn-cwd');
    if (!cwd.value && s && s.cwd) cwd.value = s.cwd;
    $('#spawn-dialog').showModal();
  },
};

/* ---------- Event delegation ---------- */
document.addEventListener('click', (e) => {
  const pop = $('#popover');
  if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('[data-act="openModel"],[data-act="openMore"],[data-act="openFilters"]')) {
    closePopover();
  }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  runAction(el, 'data-act');
});

// A file dropped outside the composer would make the browser open it and leave the dashboard.
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files') && !e.defaultPrevented) e.preventDefault();
  });
}

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change-act]');
  if (el) runAction(el, 'data-change-act', [el.value]);
});

function isTyping(target) {
  return Boolean(target && typeof target.closest === 'function' && target.closest('input, textarea, select, [contenteditable="true"]'));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (drag.active) return endDrag(false);
    if (popoverKind) return closePopover();
    if (ide.open) return Actions.closeIde();
    if (ui.expanded) return Actions.toggleExpand();
    if (ui.panel && !isTyping(e.target)) return Actions.togglePanel(ui.panel);
    return;
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const card = typeof e.target.closest === 'function' && e.target.closest('.rcard[data-group]');
    if (card) {
      e.preventDefault();
      nudgeRoom(card, e.key === 'ArrowUp' ? -1 : 1);
    }
    return;
  }
  if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') {
    e.preventDefault();
    $('#search-input').focus();
    return;
  }
  if (ide.open && (e.key === 'j' || e.key === 'k')) {
    const i = files.list.findIndex((f) => f.path === ide.path);
    const next = files.list[i + (e.key === 'j' ? 1 : -1)];
    if (next) Actions.openIde(ide.sessionId, next.path);
    return;
  }
  if (!ide.open && ui.view === 'focus' && (e.key === 'j' || e.key === 'k')) {
    const order = railOrder();
    const i = order.findIndex((s) => s.id === ui.selectedId);
    const next = order[i + (e.key === 'j' ? 1 : -1)];
    if (next) {
      Actions.selectRoom(next.id);
      const row = document.querySelector('.rcard[aria-current="true"]');
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
  }
});

/* ---------- Drag to reorder rooms (within a status group) ---------- */
// Mouse: press and move. Touch: hold ~0.3 s, then move (a quick swipe still scrolls).
// Keyboard: Alt+↑ / Alt+↓ on a focused card.
const drag = { pending: null, active: null, dirty: false, raf: 0, suppressClickUntil: 0 };
const DRAG_SLOP_PX = 6;
const TOUCH_SLOP_PX = 8;
const LONG_PRESS_MS = 320;
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function groupCards(card) {
  return [...card.parentElement.querySelectorAll(`.rcard[data-group="${CSS.escape(card.dataset.group)}"]`)];
}

function scrollParent(el) {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return document.scrollingElement;
}

/** Put `id` just before `beforeId` (or just after `afterId`) in the saved order, then store it. */
async function saveRoomMove(id, { beforeId = null, afterId = null } = {}) {
  const order = manualOrderIds().filter((x) => x !== id);
  let at = beforeId ? order.indexOf(beforeId) : afterId ? order.indexOf(afterId) + 1 : 0;
  if (at < 0) at = order.length;
  order.splice(at, 0, id);
  const byId = new Map(appState.sessions.map((s) => [s.id, s]));
  order.forEach((x, i) => {
    const s = byId.get(x);
    if (s) s.sortOrder = i;
  });
  renderAll();
  const r = await postJson('/api/session/update', { action: 'reorder', order });
  if (!r.ok) toast(`บันทึกลำดับไม่สำเร็จ: ${r.data.error || r.status}`, 'err');
}

function startDrag() {
  const p = drag.pending;
  drag.pending = null;
  if (!p || !p.card.isConnected) return;
  clearTimeout(p.timer);
  const rect = p.card.getBoundingClientRect();
  drag.active = {
    card: p.card,
    id: p.card.dataset.id,
    pointerId: p.pointerId,
    y: p.lastY,
    grab: p.startY - rect.top,
    dy: 0,
    startIndex: groupCards(p.card).indexOf(p.card),
    scroller: scrollParent(p.card),
  };
  try {
    p.card.setPointerCapture(p.pointerId);
  } catch {
    // capture is best effort; window listeners still follow the pointer
  }
  p.card.classList.add('is-dragging');
  document.body.classList.add('is-reordering');
  drag.raf = requestAnimationFrame(dragFrame);
}

/** Keep the held card under the pointer and move it past group siblings whose middle it crosses. */
function followPointer() {
  const d = drag.active;
  if (!d) return;
  const { card } = d;
  const cards = groupCards(card);
  const layoutTop = card.getBoundingClientRect().top - d.dy;
  // The card can't leave its status group, so it stays within the group's span (a little give).
  const give = 3;
  const minDy = Math.min(...cards.map((c) => c.offsetTop)) - card.offsetTop - give;
  const maxDy = Math.max(...cards.map((c) => c.offsetTop + c.offsetHeight)) - card.offsetHeight - card.offsetTop + give;
  d.dy = Math.min(maxDy, Math.max(minDy, d.y - d.grab - layoutTop));
  card.style.translate = `0 ${d.dy}px`;

  const sibs = cards.filter((c) => c !== card);
  const center = card.offsetTop + d.dy + card.offsetHeight / 2;
  const before = sibs.find((s) => center < s.offsetTop + s.offsetHeight / 2) || null;
  if (before === (cards[cards.indexOf(card) + 1] || null)) return;

  const oldTops = new Map(sibs.map((s) => [s, s.offsetTop]));
  const oldTop = card.offsetTop;
  if (before) before.before(card);
  else sibs[sibs.length - 1].after(card);
  d.dy -= card.offsetTop - oldTop;
  card.style.translate = `0 ${d.dy}px`;
  if (reduceMotion()) return;
  for (const s of sibs) {
    const delta = oldTops.get(s) - s.offsetTop;
    if (delta) s.animate([{ translate: `0 ${delta}px` }, { translate: '0 0' }], { duration: 170, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
  }
}

/** Auto-scroll near the list's edges while a card is held. */
function dragFrame() {
  const d = drag.active;
  if (!d) return;
  const sc = d.scroller;
  const box = sc === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : sc.getBoundingClientRect();
  const edge = 56;
  let step = 0;
  if (d.y < box.top + edge) step = -Math.min(16, Math.ceil((box.top + edge - d.y) / 4));
  else if (d.y > box.bottom - edge) step = Math.min(16, Math.ceil((d.y - (box.bottom - edge)) / 4));
  if (step) sc.scrollTop += step;
  followPointer();
  drag.raf = requestAnimationFrame(dragFrame);
}

function cancelPending() {
  if (drag.pending) clearTimeout(drag.pending.timer);
  drag.pending = null;
}

function endDrag(commit) {
  const d = drag.active;
  if (!d) return;
  cancelAnimationFrame(drag.raf);
  drag.active = null;
  drag.suppressClickUntil = performance.now() + 400;
  d.card.classList.remove('is-dragging');
  d.card.style.translate = '';
  document.body.classList.remove('is-reordering');
  const cards = groupCards(d.card);
  const idx = cards.indexOf(d.card);
  if (!commit || idx === d.startIndex) {
    drag.dirty = false;
    d.card.parentElement.__html = null; // put the DOM back exactly as rendered
    renderList();
    return;
  }
  const beforeId = cards[idx + 1] ? cards[idx + 1].dataset.id : null;
  const afterId = beforeId ? null : cards[idx - 1] ? cards[idx - 1].dataset.id : null;
  drag.dirty = false;
  saveRoomMove(d.id, { beforeId, afterId });
}

function nudgeRoom(card, dir) {
  const cards = groupCards(card);
  const target = cards[cards.indexOf(card) + dir];
  if (!target) return;
  const id = card.dataset.id;
  saveRoomMove(id, dir < 0 ? { beforeId: target.dataset.id } : { afterId: target.dataset.id });
  const again = document.querySelector(`.rcard[data-id="${CSS.escape(id)}"]`);
  if (again) {
    again.focus({ preventScroll: true });
    again.scrollIntoView({ block: 'nearest' });
  }
}

const railList = $('#rail-list');
railList.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || drag.active) return;
  const card = e.target.closest('.rcard[data-group]');
  if (!card) return;
  cancelPending();
  drag.pending = {
    card,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    lastY: e.clientY,
    touch: e.pointerType !== 'mouse',
    timer: 0,
  };
  if (drag.pending.touch) drag.pending.timer = setTimeout(startDrag, LONG_PRESS_MS);
});
window.addEventListener('pointermove', (e) => {
  const p = drag.pending;
  if (p && e.pointerId === p.pointerId) {
    p.lastY = e.clientY;
    const moved = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
    if (p.touch && moved > TOUCH_SLOP_PX) cancelPending(); // a swipe: let the list scroll
    else if (!p.touch && moved > DRAG_SLOP_PX) startDrag();
    return;
  }
  if (drag.active && e.pointerId === drag.active.pointerId) {
    drag.active.y = e.clientY;
    followPointer();
  }
});
window.addEventListener('pointerup', (e) => {
  cancelPending();
  if (drag.active && e.pointerId === drag.active.pointerId) endDrag(true);
});
window.addEventListener('pointercancel', () => {
  cancelPending();
  endDrag(false);
});
// Once a touch drag has started, stop the page from scrolling under the finger.
railList.addEventListener('touchmove', (e) => {
  if (drag.active) e.preventDefault();
}, { passive: false });
railList.addEventListener('contextmenu', (e) => {
  if (drag.pending || drag.active) e.preventDefault();
});
// The click that ends a drag must not also open the room.
railList.addEventListener('click', (e) => {
  if (performance.now() < drag.suppressClickUntil) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

$('#search-input').addEventListener('input', (e) => {
  ui.search = e.target.value || '';
  renderAll();
});
$('#search-icon').innerHTML = icon('search', 15);

/* ---------- Dialogs ---------- */
$('#spawn-dialog').addEventListener('close', async () => {
  const dlg = $('#spawn-dialog');
  if (dlg.returnValue !== 'ok') return;
  const body = {
    room: $('#spawn-room').value.trim(),
    category: $('#spawn-category').value.trim() || 'Development',
    cwd: $('#spawn-cwd').value.trim(),
    goal: $('#spawn-goal').value.trim(),
    openTerminal: $('#spawn-open-wt').checked,
    autoRunClaude: $('#spawn-open-wt').checked,
    runHeadless: $('#spawn-headless').checked,
  };
  const r = await postJson('/api/session/spawn', body);
  if (!r.ok || !r.data.session) return toast(`สร้างห้องไม่สำเร็จ: ${r.data.error || r.status}`, 'err');
  ui.selectedId = r.data.session.id;
  ui.lifecycle = 'live';
  ui.view = 'focus';
  $('#spawn-room').value = '';
  $('#spawn-goal').value = '';
  toast(`เปิดห้อง "${r.data.session.room}" แล้ว`);
  renderAll();
});

$('#edit-dialog').addEventListener('close', async () => {
  const dlg = $('#edit-dialog');
  if (dlg.returnValue !== 'ok') return;
  const sessionId = $('#edit-session-id').value;
  const r = await postJson('/api/session/update', {
    sessionId,
    patch: {
      room: $('#edit-room-name').value.trim(),
      category: $('#edit-room-category').value.trim() || 'General',
      goal: $('#edit-room-goal').value.trim(),
    },
  });
  toast(r.ok ? 'บันทึกแล้ว' : 'บันทึกไม่สำเร็จ', r.ok ? 'ok' : 'err');
});

/* ---------- Data ---------- */
function applySnapshot(snap) {
  appState.stages = snap.stages || appState.stages;
  appState.metrics = snap.metrics || appState.metrics;
  appState.usageGuard = snap.usageGuard || appState.usageGuard;
  appState.projects = snap.projects || [];
  appState.categories = snap.categories || [];
  appState.sessions = snap.sessions || [];
  if (snap.hooks) appState.hooks = snap.hooks;
  if (snap.statusline) appState.statusline = snap.statusline;
}

async function fetchInitialState() {
  try {
    const res = await apiFetch('/api/state');
    const data = await res.json();
    if (data.ok) {
      applySnapshot(data);
      renderAll();
    }
  } catch (err) {
    console.error('Failed to load state:', err);
  }
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderAll();
    if (ide.open) {
      // Keep the open file list in step with new edits without refetching the open file.
      const s = appState.sessions.find((x) => x.id === ide.sessionId);
      if (s && files.signature !== filesSignature(s) && !files.loading) loadFiles(s.id);
    }
  });
}

function connectSSE() {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(AMC_TOKEN)}`);
  es.onopen = () => {
    ui.connected = true;
    renderSidebar();
  };
  es.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);
      if (payload.snapshot) {
        applySnapshot(payload.snapshot);
        scheduleRender();
      }
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  };
  es.onerror = () => {
    ui.connected = false;
    renderSidebar();
  };
}

// Relative times and the hold countdown drift without new events.
setInterval(() => {
  renderList();
  renderHoldBanner();
}, 30000);

renderAll();
fetchInitialState();
connectSSE();
