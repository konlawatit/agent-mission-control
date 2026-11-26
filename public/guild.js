'use strict';

/* =========================================================================
 * Guild Mode — the game page of Agent Mission Control.
 * Ported from the agent-mission-control-hd2d-kit (source/hd2d-guild.html): the canvas HD-2D
 * renderer, HUD, Quest Board. The kit's mock rooms and fake simulation are replaced by live
 * sessions from the SSE stream; quests are created and steered through the server's APIs.
 *
 * Security: every value that comes from a session, a quest or the server is escaped before it
 * reaches innerHTML; actions run only through `data-act` delegation (no inline handlers);
 * requests are same-origin with the X-AMC-Token header.
 * ========================================================================= */
(() => {
  /* =====================================================================
   * 0. CONSTANTS & HELPERS
   * ===================================================================== */
  const TOKEN = (document.querySelector('meta[name="amc-token"]') || {}).content || '';
  const WORLD_W = 1920;
  const WORLD_H = 1080;
  const ASSETS = '/guild-assets';
  const NARROW_PX = 760;
  const PIXEL_FONT = '"Silkscreen", "Figtree", "Leelawadee UI", "Noto Sans Thai", monospace';
  const UI_FONT = '"Figtree", "Leelawadee UI", "Noto Sans Thai", system-ui, sans-serif';
  const LS_KEYS = { sfx: 'amc.guild.sfx', bloom: 'amc.guild.bloom', cwd: 'amc.guild.lastCwd' };
  const FOCUS_WAIT_MS = 10000;

  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const finePointer = window.matchMedia ? window.matchMedia('(pointer: fine)') : null;
  const reducedMotion = () => Boolean(motionQuery && motionQuery.matches);
  const isNarrow = () => window.innerWidth < NARROW_PX;

  const $ = (sel, root = document) => root.querySelector(sel);

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Escape first, then format **bold** and `code` (the only Markdown the TL;DR needs). */
  function miniMd(str) {
    return esc(str)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const textOf = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

  function truncate(str, n) {
    const s = textOf(str);
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  }

  /** FNV-1a: a stable class for sessions that are not on a quest. */
  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function safeColor(c, fallback) {
    return typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : fallback;
  }

  function clockTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  }

  /** Server messages sometimes start with an emoji; the toast has its own icon. */
  function cleanMsg(msg) {
    return textOf(msg).replace(/^[\p{Extended_Pictographic}️\s]+/u, '');
  }

  function lsGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function lsSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* storage blocked: the setting lasts for this visit only */
    }
  }

  /* ---------- Icons (inline SVG, 24 grid) ---------- */
  const ICON_PATHS = {
    arrowLeft: '<path d="M19 12H5.5M11 6l-6 6 6 6"/>',
    swords: '<path d="M4.5 4.5 15 15"/><path d="m12.8 17.2 4.4-4.4"/><path d="m16 16 3.5 3.5"/><path d="M19.5 4.5 9 15"/><path d="m6.8 12.8 4.4 4.4"/><path d="M8 16l-3.5 3.5"/>',
    bookOpen: '<path d="M12 7.5C10.5 5.9 8 5 3.5 5v13c4.5 0 7 .9 8.5 2.5 1.5-1.6 4-2.5 8.5-2.5V5C16 5 13.5 5.9 12 7.5z"/><path d="M12 7.5V20"/>',
    castle: '<path d="M4 20.5v-12h2.5V11h2V8.5h2V11h3V8.5h2V11h2V8.5H20v12z"/><path d="M10 20.5v-4a2 2 0 0 1 4 0v4"/>',
    shieldPlus: '<path d="M12 3.5 19 6v5.5c0 4.2-3 7.5-7 9-4-1.5-7-4.8-7-9V6z"/><path d="M12 9v6M9 12h6"/>',
    layers: '<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/><path d="m3.5 16.5 8.5 4.5 8.5-4.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
    volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 6.7a7.5 7.5 0 0 1 0 10.6"/>',
    volumeOff: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
    scroll: '<path d="M7.5 4.5h11a2 2 0 0 1 2 2V8h-3.5"/><path d="M17 6.5v11a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 17.5V16H14v1.5a2.5 2.5 0 0 0 2.5 2.5"/><path d="M6 16V6.5a2 2 0 0 1 2-2"/><path d="M9 9h5M9 12.5h5"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    alert: '<path d="M12 3.3 20.7 12 12 20.7 3.3 12z"/><path d="M12 8.3v4.4"/><circle cx="12" cy="15.7" r="0.95" fill="currentColor" stroke="none"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.95" fill="currentColor" stroke="none"/>',
    send: '<path d="M5 12h13M12.5 6l6 6-6 6"/>',
    chevronLeft: '<path d="m14.5 6-6 6 6 6"/>',
    chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
    spark: '<path d="M12 3.5c.6 4.3 2.2 5.9 6.5 6.5-4.3.6-5.9 2.2-6.5 6.5-.6-4.3-2.2-5.9-6.5-6.5 4.3-.6 5.9-2.2 6.5-6.5z"/><path d="M18.5 16v4M16.5 18h4"/>',
    play: '<path d="M8 5.5v13l10-6.5z"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
    chat: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-8.5l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"/>',
    loop: '<path d="M4.5 12a7.5 7.5 0 0 1 12.9-5.2l2.1 2.2"/><path d="M19.5 4.5V9H15"/><path d="M19.5 12a7.5 7.5 0 0 1-12.9 5.2l-2.1-2.2"/><path d="M4.5 19.5V15H9"/>',
    pause: '<circle cx="12" cy="12" r="8.5"/><path d="M10 9v6M14 9v6"/>',
  };

  function icon(name, size = 16) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name] || ''}</svg>`;
  }

  function hydrateIcons(root) {
    root.querySelectorAll('[data-icon]').forEach((el) => {
      el.innerHTML = icon(el.getAttribute('data-icon'), Number(el.getAttribute('data-size')) || 15);
    });
  }

  /* =====================================================================
   * 1. SCENES & 2.5D DEPTH (from the kit)
   * ===================================================================== */
  // Interactive Quest Board hotspot inside the Guild Hall Sanctuary.
  const QUEST_BOARD_SPOT = { x: 960, y: 458, rx: 145, ry: 55 };

  const SCENES = {
    library: {
      id: 'library',
      shortLabel: 'ห้องสมุด',
      title: 'GRAND ARCANE LIBRARY · ห้องสมุด (ค้นคว้า / สืบหาสาเหตุ)',
      desc: 'ฮีโร่ที่กำลังค้นคว้า สืบหาต้นตอบั๊ก หรือวางแผนงานจะมาอยู่ที่นี่',
      accent: '#c49bff',
      activeClass: 'active-library',
      icon: 'bookOpen',
      lights: [
        { x: 1240, y: 290, color: '#ffcf78', radius: 330 },
        { x: 1510, y: 310, color: '#ffcf78', radius: 310 },
        { x: 960, y: 615, color: '#c49bff', radius: 220 },
        { x: 575, y: 740, color: '#ffbe55', radius: 190 },
        { x: 1435, y: 745, color: '#ffbe55', radius: 190 },
      ],
      particleColor: 'violet',
    },
    dungeon: {
      id: 'dungeon',
      shortLabel: 'ดันเจียน',
      title: 'ANCIENT DUNGEON · ดันเจียน (ลงมือแก้โค้ด)',
      desc: 'ฮีโร่ที่กำลังแก้โค้ดสู้กับ Bug Golem — เสร็จขั้นนี้แล้วจะย้ายฉากต่อเองตามขั้นของเควสต์',
      accent: '#4de8ff',
      activeClass: 'active-dungeon',
      icon: 'swords',
      lights: [
        { x: 425, y: 505, color: '#ff8a2a', radius: 220 },
        { x: 1515, y: 505, color: '#ff8a2a', radius: 220 },
        { x: 235, y: 655, color: '#ff7a20', radius: 190 },
        { x: 1705, y: 655, color: '#ff7a20', radius: 190 },
        { x: 345, y: 580, color: '#4de8ff', radius: 190 },
        { x: 1615, y: 580, color: '#4de8ff', radius: 190 },
      ],
      particleColor: 'cyan',
    },
    sanctuary: {
      id: 'sanctuary',
      shortLabel: 'ห้องโถงกิลด์',
      title: 'GUILD HALL SANCTUARY · ห้องโถงกิลด์ (พักผ่อน / Quest Board)',
      desc: 'ฮีโร่ที่ว่างหรือจบเควสต์แล้วพักที่นี่ คลิกโต๊ะ Quest Board กลางโถงเพื่อส่งเควสต์ใหม่',
      accent: '#fae29c',
      activeClass: 'active-sanctuary',
      icon: 'castle',
      lights: [
        { x: 960, y: 310, color: '#ffe599', radius: 340 },
        { x: 1580, y: 640, color: '#ff8a2e', radius: 270, isFire: true },
        { x: 520, y: 310, color: '#ffbb52', radius: 180 },
        { x: 1400, y: 310, color: '#ffbb52', radius: 180 },
      ],
      particleColor: 'gold',
    },
    camp: {
      id: 'camp',
      shortLabel: 'ค่ายทหาร',
      title: 'MILITARY HEALING CAMP · ค่ายทหาร (ทดสอบ / QA Loop)',
      desc: 'ฮีโร่ที่กำลังรันเทสต์และตรวจผล — คลาสวนลูปจะกลับลงดันเจียนเองถ้าเทสต์ไม่ผ่าน',
      accent: '#3ee89e',
      activeClass: 'active-camp',
      icon: 'shieldPlus',
      lights: [
        { x: 955, y: 500, color: '#3ee89e', radius: 290, isHeal: true },
        { x: 1195, y: 585, color: '#ff8a2b', radius: 240, isFire: true },
        { x: 790, y: 345, color: '#ffbb52', radius: 165 },
        { x: 1410, y: 725, color: '#ffbb52', radius: 175 },
      ],
      particleColor: 'emerald',
    },
  };

  const SCENE_ORDER = ['library', 'dungeon', 'sanctuary', 'camp'];
  const STAGE_SCENES = ['library', 'dungeon', 'camp', 'sanctuary'];
  const STAGE_LABELS = ['วางแผน & สำรวจ', 'ลงมือแก้โค้ด', 'ตรวจสอบ & ทดสอบ', 'เสร็จ / พร้อม'];

  // 2.5D depth data for each painted scene (verbatim from the kit):
  // - walkPoly: walkable floor; obstacles: ellipses heroes steer around
  // - occluders: cut-outs of the painting drawn in the Y-sort, so a hero behind a desk is hidden by it
  const SCENE_DEPTH = {
    sanctuary: {
      walkPoly: { minX: 430, maxX: 1490, minY: 535, maxY: 850 },
      obstacles: [
        { x: 960, y: 495, rx: 165, ry: 55, label: 'Quest Desk' },
        { x: 1580, y: 660, rx: 120, ry: 95, label: 'Fireplace' },
        { x: 380, y: 615, rx: 115, ry: 65, label: 'Side Desk' },
      ],
      occluders: [
        { x: 805, y: 420, w: 310, h: 128, sortY: 542, feather: 10 },
        { x: 15, y: 745, w: 365, h: 270, sortY: 960, feather: 14 },
        { x: 1405, y: 865, w: 370, h: 215, sortY: 985, feather: 14 },
      ],
    },
    library: {
      walkPoly: { minX: 430, maxX: 1490, minY: 540, maxY: 845 },
      obstacles: [
        { x: 565, y: 795, rx: 120, ry: 65, label: 'West Study Table' },
        { x: 895, y: 675, rx: 115, ry: 60, label: 'Center Table' },
        { x: 1095, y: 625, rx: 105, ry: 52, label: 'North Table' },
        { x: 1435, y: 775, rx: 120, ry: 65, label: 'East Study Table' },
      ],
      occluders: [
        { x: 980, y: 550, w: 235, h: 120, sortY: 642, feather: 10 },
        { x: 760, y: 600, w: 255, h: 138, sortY: 702, feather: 10 },
        { x: 1310, y: 695, w: 255, h: 155, sortY: 810, feather: 12 },
        { x: 430, y: 715, w: 265, h: 165, sortY: 830, feather: 12 },
        { x: 1005, y: 885, w: 360, h: 195, sortY: 1010, feather: 12 },
      ],
    },
    dungeon: {
      walkPoly: { minX: 460, maxX: 1460, minY: 515, maxY: 840 },
      obstacles: [
        { x: 675, y: 655, rx: 125, ry: 70, label: 'Bug Golem Boss' },
        { x: 350, y: 610, rx: 115, ry: 120, label: 'Left Crystal Pillar' },
        { x: 1580, y: 610, rx: 115, ry: 120, label: 'Right Crystal Pillar' },
      ],
      occluders: [
        { x: 0, y: 120, w: 295, h: 960, sortY: 1040, feather: 16 },
        { x: 1625, y: 120, w: 295, h: 960, sortY: 1040, feather: 16 },
        { x: 255, y: 880, w: 220, h: 200, sortY: 1020, feather: 14 },
        { x: 1370, y: 880, w: 230, h: 200, sortY: 1020, feather: 14 },
      ],
    },
    camp: {
      walkPoly: { minX: 430, maxX: 1480, minY: 485, maxY: 835 },
      obstacles: [
        { x: 955, y: 548, rx: 75, ry: 48, label: 'Healing Crystal' },
        { x: 1195, y: 585, rx: 78, ry: 45, label: 'Campfire' },
        { x: 565, y: 390, rx: 180, ry: 95, label: 'West Tent' },
        { x: 1390, y: 390, rx: 180, ry: 95, label: 'East Tent' },
      ],
      occluders: [
        { x: 895, y: 420, w: 125, h: 175, sortY: 572, feather: 10 },
        { x: 1130, y: 510, w: 130, h: 115, sortY: 605, feather: 12 },
        { x: 0, y: 520, w: 410, h: 520, sortY: 940, feather: 16 },
        { x: 1365, y: 580, w: 555, h: 500, sortY: 960, feather: 16 },
      ],
    },
  };

  function isPointBlocked(sceneId, x, y, pad = 24) {
    const d = SCENE_DEPTH[sceneId];
    if (!d) return false;
    const p = d.walkPoly;
    if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) return true;
    for (const ob of d.obstacles) {
      const dx = (x - ob.x) / (ob.rx + pad);
      const dy = (y - ob.y) / (ob.ry + pad);
      if (dx * dx + dy * dy < 1) return true;
    }
    return false;
  }

  // Real 3/4 RPG depth: smaller further back (y≈480), larger in the foreground (y≈860).
  function getPerspectiveScale(y) {
    return Math.max(0.8, Math.min(1.16, 0.8 + ((y - 470) / 390) * 0.34));
  }

  // Scene-specific spots: library tables/shelves, camp healing crystal & campfire, dungeon battle line.
  const LIBRARY_SPOTS = [
    { type: 'read', x: 615, y: 760, dir: 'left' },
    { type: 'read', x: 920, y: 665, dir: 'left' },
    { type: 'read', x: 1110, y: 615, dir: 'left' },
    { type: 'shelf', x: 560, y: 575, dir: 'up' },
    { type: 'shelf', x: 790, y: 555, dir: 'up' },
    { type: 'read', x: 1415, y: 760, dir: 'right' },
  ];
  const CAMP_SPOTS = [
    { type: 'heal', x: 845, y: 575, dir: 'right' },
    { type: 'eat', x: 1120, y: 635, dir: 'right' },
    { type: 'eat', x: 1285, y: 620, dir: 'left' },
    { type: 'heal', x: 1035, y: 550, dir: 'left' },
  ];
  // Kept inside the dungeon's walk area (the kit's formula ran past it from the 4th hero on).
  const DUNGEON_SLOTS = [
    { x: 1145, y: 605 },
    { x: 1260, y: 700 },
    { x: 1145, y: 795 },
    { x: 1290, y: 590 },
    { x: 1035, y: 700 },
    { x: 1330, y: 800 },
    { x: 1395, y: 680 },
    { x: 1040, y: 600 },
  ];
  const DUNGEON_BOSS = { x: 675, y: 655, hitTimer: 0, attackTimer: 2.5, shakeX: 0 };

  function loadImage(src) {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    return img;
  }
  const sceneImgs = {};
  SCENE_ORDER.forEach((id) => {
    sceneImgs[id] = loadImage(`${ASSETS}/backgrounds/${id}.jpg`);
  });

  /* =====================================================================
   * 2. HERO CLASSES (built-in look + cache of GET /api/guild/classes)
   * ===================================================================== */
  const CLASS_IDS = ['researcher', 'bug_hunter', 'quick_fix', 'full_slayer', 'qa_loop'];
  const CLASS_VISUALS = {
    researcher: { name: 'Sage Scholar', titleThai: 'นักวิจัยเจาะลึก', badge: 'Research + ปรับความลึก', accent: '#c49bff', glow: '#c49bff', flowSteps: ['ห้องสมุด', 'ห้องโถงกิลด์'], route: ['library', 'sanctuary'] },
    bug_hunter: { name: 'Lantern Detective', titleThai: 'นักสืบค้นหาบั๊ก', badge: 'หาบั๊กอย่างเดียว', accent: '#f5b84c', glow: '#ffbe55', flowSteps: ['ห้องสมุด (สืบหาบั๊ก)', 'ห้องโถงกิลด์'], route: ['library', 'sanctuary'] },
    quick_fix: { name: 'Shadow Ranger', titleThai: 'แก้บั๊กไว (ไม่ Test)', badge: 'แก้ไวข้าม Test', accent: '#4de8ff', glow: '#4de8ff', flowSteps: ['ดันเจียน (แก้ไว)', 'ห้องโถงกิลด์'], route: ['dungeon', 'sanctuary'] },
    full_slayer: { name: 'Paladin Architect', titleThai: 'หา-แก้-ทดสอบครบ', badge: 'ครบวงจร 3 ด่าน', accent: '#fae29c', glow: '#f7d579', flowSteps: ['ห้องสมุด', 'ดันเจียน', 'ค่ายทหาร Test', 'ห้องโถงกิลด์'], route: ['library', 'dungeon', 'camp', 'sanctuary'] },
    qa_loop: { name: 'Ironclad Artificer', titleThai: 'วนลูป Test จนชัวร์', badge: 'Fix ⇄ Test Loop', accent: '#3ee89e', glow: '#3ee89e', flowSteps: ['ห้องสมุด', 'ดันเจียน ⇄ ค่าย Test (Loop)', 'ห้องโถงกิลด์'], route: ['library', 'dungeon', 'camp', 'sanctuary'] },
  };
  CLASS_IDS.forEach((id) => {
    Object.assign(CLASS_VISUALS[id], {
      id,
      portrait: `${ASSETS}/portraits/${id}-256.jpg`,
      phases: [],
      option: null,
      presets: {},
    });
  });

  const spriteSheets = {};
  CLASS_IDS.forEach((id) => {
    spriteSheets[id] = loadImage(`${ASSETS}/sprites/${id}.png`);
  });
  const monsterSheet = loadImage(`${ASSETS}/sprites/bug_golem.png`);

  const classes = { status: 'idle', error: '', list: [], byId: new Map() };
  let classesPromise = null;

  function strList(a) {
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : null;
  }

  /** Server class → the page's shape. Images and sprite glow always come from the built-in table. */
  function normalizeClass(raw) {
    if (!raw || typeof raw !== 'object' || !CLASS_VISUALS[raw.id]) return null;
    const vis = CLASS_VISUALS[raw.id];
    const phases = Array.isArray(raw.phases)
      ? raw.phases
          .filter((p) => p && typeof p === 'object')
          .map((p) => ({ id: textOf(p.id), kind: textOf(p.kind), scene: SCENES[p.scene] ? p.scene : 'library', title: textOf(p.title) }))
      : [];
    let option = null;
    if (raw.option && typeof raw.option === 'object' && Array.isArray(raw.option.values)) {
      const values = raw.option.values
        .filter((v) => v && (typeof v.value === 'string' || typeof v.value === 'number'))
        .map((v) => ({ value: v.value, label: textOf(v.label) || String(v.value) }));
      if (values.length) option = { key: textOf(raw.option.key), label: textOf(raw.option.label), values, default: raw.option.default };
    }
    const presets = raw.presets && typeof raw.presets === 'object' ? raw.presets : {};
    const route = (strList(raw.route) || vis.route).filter((s) => SCENES[s]);
    return {
      ...vis,
      name: textOf(raw.name) || vis.name,
      titleThai: textOf(raw.titleThai) || vis.titleThai,
      badge: textOf(raw.badge) || vis.badge,
      accent: safeColor(raw.accent, vis.accent),
      flowSteps: strList(raw.flowSteps) || vis.flowSteps,
      route: route.length ? route : vis.route,
      phases,
      option,
      presets,
    };
  }

  function classInfo(id) {
    return classes.byId.get(id) || CLASS_VISUALS[id] || CLASS_VISUALS.researcher;
  }

  function loadClasses() {
    if (classes.status === 'loading' && classesPromise) return classesPromise;
    classes.status = 'loading';
    classes.error = '';
    classesPromise = (async () => {
      const r = await getJson('/api/guild/classes');
      const list = r.ok && Array.isArray(r.data.classes) ? r.data.classes.map(normalizeClass).filter(Boolean) : [];
      if (list.length) {
        classes.list = list;
        classes.byId = new Map(list.map((c) => [c.id, c]));
        classes.status = 'ok';
      } else {
        classes.status = 'error';
        classes.error = r.ok ? 'ไม่พบคลาสตัวละคร' : errText(r);
      }
      if (qb.open) renderQuestBoard(qb.presetEdited === false);
      scheduleHud(true);
    })();
    return classesPromise;
  }

  /* =====================================================================
   * 3. APP STATE, CAMERA, EFFECTS
   * ===================================================================== */
  const QUEST_STATE_LABEL = {
    launching: 'กำลังเรียกฮีโร่',
    running: 'กำลังทำเควสต์',
    paused: 'หยุดรอคุณ',
    stalled: 'ติดขัด',
    done: 'เควสต์สำเร็จ',
    failed: 'เควสต์ไม่ผ่าน',
    stopped: 'หยุดเควสต์แล้ว',
  };
  const ACTIVE_QUEST = new Set(['launching', 'running', 'paused', 'stalled']);
  const RUNNING_QUEST = new Set(['launching', 'running']);
  const FINISHED_QUEST = new Set(['done', 'failed', 'stopped']);

  const state = {
    entered: false,
    currentScene: 'sanctuary',
    connected: false,
    hasSnapshot: false,
    sfxEnabled: lsGet(LS_KEYS.sfx) !== 'off',
    bloomEnabled: lsGet(LS_KEYS.bloom) !== 'off',
    showNavMask: false,
    selectedId: null,
    hoveredId: null,
    hoveredQuestBoard: false,
    drawerTab: 'overview',
    usageGuard: null,
    pendingFocus: null, // { id, questId, until, fromHash }
    busy: new Set(),
  };

  /** Live heroes by session id. Insertion order is stable, so battle slots and spots stay put. */
  const heroes = new Map();
  const drafts = { msg: new Map(), note: new Map() };

  const cam = {
    cx: WORLD_W / 2,
    cy: WORLD_H / 2,
    zoom: 1.03,
    targetCx: WORLD_W / 2,
    targetCy: WORLD_H / 2,
    targetZoom: 1.03,
    mouseX: 0,
    mouseY: 0,
    free: false, // phone + bottom sheet: let the camera leave the world vertically
  };

  const effects = [];
  const floatingTexts = [];
  const projectiles = [];
  const particles = Array.from({ length: 56 }, (_, i) => ({
    x: Math.random() * WORLD_W,
    y: Math.random() * WORLD_H,
    r: i % 4 === 0 ? 2.6 : 1.4,
    phase: Math.random() * Math.PI * 2,
    vx: (Math.random() - 0.5) * 14,
    vy: -10 - Math.random() * 16,
    isSpecial: i % 3 === 0,
  }));

  function spawnFloatingText(x, y, text, color = '#fae29c', size = 16) {
    floatingTexts.push({ x, y, text, color, size, vy: -42, life: 1.15, maxLife: 1.15 });
  }

  function spawnProjectile(x1, y1, x2, y2, color) {
    projectiles.push({ x: x1, y: y1, x1, y1, x2, y2, t: 0, dur: 0.24, color });
  }

  function spawnBurst(wx, wy, color, count = 22) {
    if (effects.length > 400) return;
    for (let i = 0; i < count; i++) {
      const ang = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const spd = 45 + Math.random() * 90;
      effects.push({
        x: wx,
        y: wy,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 38,
        life: 0.75 + Math.random() * 0.4,
        maxLife: 1.15,
        color,
        size: 3 + Math.random() * 2.5,
      });
    }
  }

  function burstAtHero(h, color, count) {
    if (h.scene === state.currentScene) spawnBurst(h.x, h.y - 12, color, count);
  }

  /* ---------- 16-bit SFX (Web Audio; starts only after the title-screen click) ---------- */
  let audioCtx = null;

  function unlockAudio() {
    try {
      if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = new Ctx();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    } catch {
      audioCtx = null;
    }
  }

  function playSfx(type) {
    if (!state.sfxEnabled || !audioCtx || document.hidden) return;
    try {
      const now = audioCtx.currentTime;
      const tone = (freq, off, dur, wave = 'triangle', vol = 0.055) => {
        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.type = wave;
        osc.frequency.setValueAtTime(freq, now + off);
        g.gain.setValueAtTime(vol, now + off);
        g.gain.exponentialRampToValueAtTime(0.001, now + off + dur);
        osc.connect(g);
        g.connect(audioCtx.destination);
        osc.start(now + off);
        osc.stop(now + off + dur);
      };
      if (type === 'click') {
        tone(660, 0, 0.05, 'square', 0.028);
        tone(880, 0.04, 0.06, 'triangle', 0.038);
      } else if (type === 'scene') {
        tone(440, 0, 0.06, 'triangle', 0.045);
        tone(587.33, 0.05, 0.09, 'triangle', 0.045);
      } else if (type === 'warp') {
        tone(523.25, 0, 0.07, 'sine', 0.05);
        tone(783.99, 0.06, 0.12, 'sine', 0.05);
      } else if (type === 'loop_retry') {
        tone(440, 0, 0.08, 'sawtooth', 0.045);
        tone(392, 0.08, 0.09, 'sawtooth', 0.045);
        tone(523.25, 0.16, 0.12, 'triangle', 0.05);
      } else if (type === 'fail') {
        tone(392, 0, 0.1, 'sawtooth', 0.045);
        tone(311.13, 0.1, 0.12, 'sawtooth', 0.045);
        tone(261.63, 0.22, 0.22, 'triangle', 0.05);
      } else if (type === 'approve' || type === 'done') {
        tone(523.25, 0, 0.08, 'triangle', 0.065);
        tone(659.25, 0.07, 0.08, 'triangle', 0.065);
        tone(783.99, 0.14, 0.12, 'triangle', 0.075);
        tone(1046.5, 0.21, 0.2, 'sine', 0.075);
      }
    } catch {
      /* audio is decoration only */
    }
  }

  /* ---------- Toast ---------- */
  let toastTimer = null;
  function toast(message, tone = 'ok') {
    const el = $('#toast');
    if (!el) return;
    el.className = `toast hud show is-${tone}`;
    $('#toast-icon').innerHTML = icon(tone === 'err' ? 'alert' : tone === 'warn' ? 'info' : 'spark', 16);
    $('#toast-msg').textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), tone === 'err' ? 6000 : 3800);
  }

  /* ---------- HTTP (same origin, token header) ---------- */
  function apiFetch(url, init = {}) {
    return fetch(url, { ...init, headers: { ...(init.headers || {}), 'X-AMC-Token': TOKEN } });
  }

  async function readJson(res) {
    try {
      const data = await res.json();
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  async function getJson(url) {
    try {
      const res = await apiFetch(url);
      const data = await readJson(res);
      return { ok: res.ok && data.ok !== false, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 0, data: { error: err.message } };
    }
  }

  async function postJson(url, body) {
    try {
      const res = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const data = await readJson(res);
      return { ok: res.ok && data.ok !== false, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 0, data: { error: err.message } };
    }
  }

  function errText(r) {
    return cleanMsg(r.data.error || r.data.message) || (r.status ? `HTTP ${r.status}` : 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
  }

  /* =====================================================================
   * 4. LIVE ADAPTER (SSE snapshot → heroes)
   * ===================================================================== */
  let eventSource = null;
  let reconnectTimer = null;

  function connectSSE() {
    clearTimeout(reconnectTimer);
    try {
      eventSource = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`);
    } catch {
      scheduleReconnect();
      return;
    }
    const es = eventSource;
    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      let payload = null;
      try {
        payload = JSON.parse(e.data);
      } catch {
        return;
      }
      if (payload && payload.snapshot && typeof payload.snapshot === 'object') {
        setConnected(true);
        applySnapshot(payload.snapshot, payload.type);
      }
    };
    // EventSource retries by itself; only a closed stream (e.g. a 401) needs a fresh one.
    es.onerror = () => {
      setConnected(false);
      if (es.readyState === 2) {
        es.close();
        scheduleReconnect();
      }
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSSE, 3000);
  }

  function setConnected(v) {
    if (state.connected === v) return;
    state.connected = v;
    scheduleHud();
  }

  const heroName = (s) => textOf(s.room) || textOf(s.project) || 'ฮีโร่';
  const questOf = (s) => (s && s.quest && typeof s.quest === 'object' && s.quest.id ? s.quest : null);
  const stageOf = (s) => clamp(Math.floor(Number(s.stageIndex) || 0), 0, 3);

  function classIdFor(s) {
    const q = questOf(s);
    if (q && CLASS_VISUALS[q.heroClassId]) return q.heroClassId;
    return CLASS_IDS[hashString(s.id) % CLASS_IDS.length];
  }

  /** Quest → its phase scene; otherwise the room's stage (spec "Scene for each session"). */
  function sceneFor(s, prevScene) {
    const q = questOf(s);
    if (q && ACTIVE_QUEST.has(q.state) && SCENES[q.scene]) return q.scene;
    if (s.status === 'needs_input' && prevScene) return prevScene; // waiting keeps the scene
    if (s.status === 'idle' || s.status === 'done') return 'sanctuary';
    const stage = stageOf(s);
    if (stage === 3) return s.status === 'working' ? 'library' : 'sanctuary';
    return STAGE_SCENES[stage];
  }

  function deriveView(s, prevScene) {
    const q = questOf(s);
    return {
      classId: classIdFor(s),
      scene: sceneFor(s, prevScene),
      quest: q,
      questActive: Boolean(q && ACTIVE_QUEST.has(q.state)),
      questState: q ? q.state : null,
      loop: q ? Math.max(1, Number(q.loop) || 1) : 0,
      waiting: s.status === 'needs_input',
      working: s.status === 'working',
    };
  }

  function isIdleSession(s) {
    const q = questOf(s);
    return (s.status === 'idle' || s.status === 'done') && !(q && RUNNING_QUEST.has(q.state));
  }

  /** True when a hero standing at (x, y) would be hidden behind a painted foreground piece. */
  function isBehindOccluder(sceneId, x, y) {
    const d = SCENE_DEPTH[sceneId];
    return d.occluders.some((oc) => y < oc.sortY && x > oc.x - 20 && x < oc.x + oc.w + 20 && y - 50 > oc.y && y - 50 < oc.y + oc.h);
  }

  /** A free spot on the floor, as far as it can find from `others` (so name plates don't pile up). */
  function randomWalkablePoint(sceneId, others = []) {
    const b = SCENE_DEPTH[sceneId].walkPoly;
    let best = null;
    let bestGap = -1;
    for (let i = 0; i < 40 && bestGap < 220; i++) {
      const x = b.minX + 60 + Math.random() * (b.maxX - b.minX - 120);
      const y = b.minY + 30 + Math.random() * (b.maxY - b.minY - 60);
      if (isPointBlocked(sceneId, x, y, 20) || isBehindOccluder(sceneId, x, y)) continue;
      const gap = others.length ? Math.min(...others.map((o) => Math.hypot(o.x - x, (o.y - y) * 1.6))) : 9999;
      if (gap > bestGap) {
        best = { x, y };
        bestGap = gap;
      }
    }
    return best || { x: (b.minX + b.maxX) / 2, y: b.maxY - 40 };
  }

  function othersIn(sceneId, h) {
    const out = [];
    for (const o of heroes.values()) if (o !== h && o.scene === sceneId) out.push({ x: o.targetX, y: o.targetY });
    return out;
  }

  function placeHero(h, sceneId) {
    h.scene = sceneId;
    h.libSpot = null;
    h.campSpot = null;
    h.activity = 'idle';
    h.combatCd = null;
    h.emoteCd = null;
    h.attackPose = 0;
    h.dashOffset = 0;
    const p = sceneId === 'dungeon' ? { x: 1300 + Math.random() * 120, y: 690 + Math.random() * 90 } : randomWalkablePoint(sceneId, othersIn(sceneId, h));
    h.x = p.x;
    h.y = p.y;
    h.targetX = p.x;
    h.targetY = p.y;
    h.vx = 0;
    h.vy = 0;
    h.waitTimer = 0.6 + Math.random();
  }

  function createHero(s, view) {
    const seed = hashString(s.id);
    const h = {
      id: s.id,
      session: s,
      view,
      classId: view.classId,
      scene: view.scene,
      dir: seed % 2 ? 'left' : 'right',
      walkPhase: 0,
      jitterX: (seed % 31) - 15,
      jitterY: ((seed >>> 5) % 17) - 8,
    };
    placeHero(h, view.scene);
    return h;
  }

  function applySnapshot(snap, type) {
    // The first snapshot, a reconnect ('init') and anything before the title click apply silently.
    const quiet = !state.entered || !state.hasSnapshot || type === 'init';
    state.hasSnapshot = true;
    state.usageGuard = snap.usageGuard || null;
    const live = (Array.isArray(snap.sessions) ? snap.sessions : []).filter(
      (s) => s && typeof s.id === 'string' && s.id && s.lifecycle !== 'history'
    );
    const seen = new Set();
    for (const s of live) {
      seen.add(s.id);
      const h = heroes.get(s.id);
      if (!h) {
        const nh = createHero(s, deriveView(s, null));
        heroes.set(s.id, nh);
        if (!quiet) announceEnter(nh);
        continue;
      }
      const before = h.view;
      const view = deriveView(s, h.scene);
      h.session = s;
      h.view = view;
      h.classId = view.classId;
      const sameQuest = view.quest && before.quest && view.quest.id === before.quest.id;
      const finishedNow = sameQuest && view.questState !== before.questState && FINISHED_QUEST.has(view.questState);
      // A hero off quest hops scenes with every tool it runs: only quest steps and the hero you are
      // following are worth a toast; the others just warp.
      const worthToast = !finishedNow && (view.questActive || state.selectedId === h.id);
      if (view.scene !== h.scene) moveHero(h, view.scene, { quiet, withToast: worthToast });
      if (!quiet) announceChanges(h, before, view);
    }
    for (const h of [...heroes.values()]) {
      if (!seen.has(h.id)) removeHero(h, quiet);
    }
    flushAnnouncements();
    tryPendingFocus();
    scheduleHud();
  }

  /* One snapshot can change many heroes: only the most important toast and sound play. */
  let announcements = [];
  function announce(message, tone, priority, sfx) {
    announcements.push({ message, tone, priority, sfx });
  }
  function flushAnnouncements() {
    if (!announcements.length) return;
    const top = announcements.reduce((a, b) => (b.priority >= a.priority ? b : a));
    const more = announcements.length - 1;
    announcements = [];
    if (top.sfx) playSfx(top.sfx);
    toast(more ? `${top.message} (และอีก ${more} เรื่อง)` : top.message, top.tone);
  }

  function announceEnter(h) {
    const c = classInfo(h.classId);
    burstAtHero(h, c.accent, 26);
    announce(`ฮีโร่ใหม่ ${heroName(h.session)} มาถึง${SCENES[h.scene].shortLabel}`, 'ok', 1, 'scene');
  }

  function sceneMoveMessage(h, to) {
    const name = heroName(h.session);
    const q = h.view.quest;
    const label = SCENES[to].shortLabel;
    if (h.view.questActive && q.phase && q.phase.title) {
      const n = Math.max(1, Number(q.phaseCount) || 1);
      const i = clamp(Number(q.phaseIndex) || 0, 0, n - 1);
      return `${name} ไปที่${label} · ขั้น ${i + 1}/${n} ${textOf(q.phase.title)}`;
    }
    return `${name} ย้ายไปที่${label}`;
  }

  function moveHero(h, to, { quiet, withToast }) {
    const from = h.scene;
    if (!quiet && from === state.currentScene) spawnBurst(h.x, h.y - 12, SCENES[from].accent, 22);
    placeHero(h, to);
    if (!quiet) {
      burstAtHero(h, SCENES[to].accent, 24);
      if (withToast) announce(sceneMoveMessage(h, to), 'ok', 2, 'warp');
    }
    if (state.selectedId === h.id) {
      if (to === state.currentScene) focusCamera(h);
      else resetCamera();
    }
  }

  function announceChanges(h, before, view) {
    const name = heroName(h.session);
    const q = view.quest;
    const bq = before.quest;
    if (q && bq && q.id === bq.id) {
      if (view.loop > before.loop) {
        burstAtHero(h, '#ff9642', 22);
        announce(`${name} ทดสอบไม่ผ่าน วนกลับไปแก้ รอบ ${view.loop}/${Number(q.maxLoops) || view.loop}`, 'warn', 4, 'loop_retry');
      }
      if (view.questState !== before.questState) {
        const reason = q.stateReason ? `: ${textOf(q.stateReason)}` : '';
        if (q.state === 'done') {
          burstAtHero(h, '#fae29c', 30);
          announce(`${name} ทำเควสต์ "${textOf(q.name)}" สำเร็จ กลับห้องโถงกิลด์แล้ว`, 'ok', 6, 'done');
        } else if (q.state === 'failed') {
          announce(`${name} เควสต์ไม่ผ่าน${reason}`, 'err', 6, 'fail');
        } else if (q.state === 'paused' || q.state === 'stalled') {
          announce(`${name} ${QUEST_STATE_LABEL[q.state]}${reason}`, 'warn', 5);
        }
      }
    } else if (q && ACTIVE_QUEST.has(q.state) && (!bq || bq.id !== q.id)) {
      announce(`${name} รับเควสต์ "${textOf(q.name)}" แล้ว`, 'ok', 3);
    }
    if (view.waiting && !before.waiting) announce(`${name} รอคุณตอบ`, 'warn', 7);
  }

  function removeHero(h, quiet) {
    if (!quiet) burstAtHero(h, classInfo(h.classId).accent, 26);
    heroes.delete(h.id);
    drafts.msg.delete(h.id);
    drafts.note.delete(h.id);
    if (state.hoveredId === h.id) state.hoveredId = null;
    if (state.selectedId === h.id) {
      state.selectedId = null;
      resetCamera();
    }
  }

  /* ---------- Focus requests: a quest just created, or /guild#hero=<id> ---------- */
  function requestFocus(id, { questId = null, ms = FOCUS_WAIT_MS, fromHash = false } = {}) {
    state.pendingFocus = { id, questId, until: Date.now() + ms, fromHash };
    setTimeout(tryPendingFocus, ms + 50); // gives up (quietly) if it never shows up
    tryPendingFocus();
  }

  function tryPendingFocus() {
    const pf = state.pendingFocus;
    if (!pf || !state.entered) return;
    if (Date.now() > pf.until) {
      state.pendingFocus = null;
      if (pf.fromHash) clearHeroHash();
      return;
    }
    const h = heroes.get(pf.id);
    if (!h) return;
    if (pf.questId && !(h.view.quest && h.view.quest.id === pf.questId)) return;
    state.pendingFocus = null;
    if (pf.fromHash) clearHeroHash();
    if (h.scene !== state.currentScene) {
      switchScene(h.scene, { keepSelection: true, then: () => selectHero(h.id, { silent: true }) });
    } else {
      selectHero(h.id, { silent: true });
    }
  }

  function heroIdFromHash() {
    const m = /^#hero=(.+)$/.exec(window.location.hash || '');
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]) || null;
    } catch {
      return null;
    }
  }

  function clearHeroHash() {
    if (!/^#hero=/.test(window.location.hash || '')) return;
    try {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch {
      /* ignore */
    }
  }

  function focusFromHash() {
    const id = heroIdFromHash();
    if (id) requestFocus(id, { fromHash: true });
  }

  /* =====================================================================
   * 5. SIMULATION (movement and scene activities; no fake progress)
   * ===================================================================== */
  function heroesIn(sceneId) {
    const out = [];
    for (const h of heroes.values()) if (h.scene === sceneId) out.push(h);
    return out;
  }

  function baseScale() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cover = Math.max(w / WORLD_W, h / WORLD_H);
    if (w >= NARROW_PX) return cover;
    // Phone portrait: cover would show only the middle quarter; fit the walkable floor instead.
    return Math.max(w / WORLD_W, Math.min(cover, w / 980));
  }

  function clampView(cx, cy, zoom) {
    const s = baseScale() * zoom;
    const hw = window.innerWidth / 2 / s;
    const hh = window.innerHeight / 2 / s;
    const x = hw * 2 >= WORLD_W ? WORLD_W / 2 : clamp(cx, hw, WORLD_W - hw);
    let y = cy;
    if (!cam.free) y = hh * 2 >= WORLD_H ? WORLD_H / 2 : clamp(cy, hh, WORLD_H - hh);
    return { x, y };
  }

  function focusCamera(h) {
    if (isNarrow()) {
      // The drawer is a bottom sheet: put the hero in the upper part of the screen.
      cam.free = true;
      cam.targetZoom = 1.5;
      const s = baseScale() * cam.targetZoom;
      cam.targetCx = h.x;
      cam.targetCy = h.y - 40 + (0.5 - 0.26) * (window.innerHeight / s);
    } else {
      cam.free = false;
      cam.targetZoom = 1.18;
      cam.targetCx = Math.max(460, Math.min(WORLD_W - 320, h.x + 150));
      cam.targetCy = Math.max(320, Math.min(WORLD_H - 240, h.y + 20));
    }
  }

  function resetCamera() {
    cam.free = false;
    cam.targetZoom = 1.03;
    cam.targetCx = WORLD_W / 2;
    cam.targetCy = WORLD_H / 2;
  }

  function updateCamera(dt) {
    const reduce = reducedMotion();
    const parallax = !reduce && !state.selectedId && (!finePointer || finePointer.matches);
    const k = reduce ? 1 : Math.min(1, dt * 5);
    cam.zoom += (cam.targetZoom - cam.zoom) * k;
    const t = clampView(cam.targetCx + (parallax ? cam.mouseX * 26 : 0), cam.targetCy + (parallax ? cam.mouseY * 14 : 0), cam.zoom);
    cam.cx += (t.x - cam.cx) * k;
    cam.cy += (t.y - cam.cy) * k;
  }

  /** Walk toward the target; true once there. */
  function stepToward(h, speed, dt, phaseRate) {
    const dist = Math.hypot(h.targetX - h.x, h.targetY - h.y);
    if (dist <= 6) {
      h.vx = 0;
      h.vy = 0;
      return true;
    }
    h.vx = ((h.targetX - h.x) / dist) * speed;
    h.vy = ((h.targetY - h.y) / dist) * speed;
    h.x += h.vx * dt;
    h.y += h.vy * dt;
    h.walkPhase += dt * phaseRate;
    h.dir = h.vx > 0 ? 'right' : 'left';
    return false;
  }

  function targetSpot(h, spot) {
    h.targetX = spot.x + h.jitterX;
    h.targetY = spot.y + h.jitterY;
  }

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  /** A spot no other hero in the scene is heading for (any spot when all are taken). */
  function pickFreeSpot(spots, h) {
    const taken = othersIn(h.scene, h);
    const free = spots.filter((sp) => !taken.some((t) => Math.hypot(t.x - sp.x, t.y - sp.y) < 60));
    return pick(free.length ? free : spots);
  }

  function updateDungeonHero(h, dt, slot) {
    const pos = DUNGEON_SLOTS[slot % DUNGEON_SLOTS.length];
    h.targetX = pos.x;
    h.targetY = pos.y;
    if (!stepToward(h, 110, dt, 7)) return;
    h.dir = 'left'; // always face the Bug Golem
    if (!h.view.working) return; // waits in stance until the turn runs
    h.combatCd = (h.combatCd ?? 0.8 + slot * 0.9) - dt;
    if (h.combatCd > 0) return;
    h.combatCd = 1.65 + Math.random() * 0.9;
    h.dashOffset = -68;
    h.attackPose = 0.48;
    if (state.currentScene !== 'dungeon') return;
    const glow = classInfo(h.classId).glow;
    spawnProjectile(h.x - 45, h.y - 26, DUNGEON_BOSS.x + 35, DUNGEON_BOSS.y - 45, glow);
    const isCrit = Math.random() > 0.68;
    const dmg = isCrit ? Math.floor(210 + Math.random() * 90) : Math.floor(85 + Math.random() * 65);
    setTimeout(() => {
      if (state.currentScene !== 'dungeon') return;
      DUNGEON_BOSS.hitTimer = 0.28;
      DUNGEON_BOSS.shakeX = -12;
      spawnBurst(DUNGEON_BOSS.x + 15, DUNGEON_BOSS.y - 45, isCrit ? '#fae29c' : glow, isCrit ? 18 : 11);
      spawnFloatingText(DUNGEON_BOSS.x + (Math.random() - 0.5) * 60, DUNGEON_BOSS.y - 110, isCrit ? `CRIT -${dmg}!` : `-${dmg}`, isCrit ? '#fae29c' : '#ff7b8a', isCrit ? 18 : 14);
    }, 210);
  }

  function updateLibraryHero(h, dt, slot) {
    if (!h.libSpot) {
      h.libSpot = LIBRARY_SPOTS[slot % LIBRARY_SPOTS.length];
      targetSpot(h, h.libSpot);
    }
    if (!stepToward(h, 58, dt, 4.8)) return;
    h.dir = h.libSpot.dir;
    h.activity = h.libSpot.type;
    if (!h.view.working) return;
    h.emoteCd = (h.emoteCd ?? 1.8) - dt;
    if (h.emoteCd <= 0 && state.currentScene === 'library') {
      h.emoteCd = 2.8 + Math.random() * 1.8;
      const notes = h.activity === 'shelf' ? ['เลือกหนังสือ...', 'ค้นหาคัมภีร์...'] : ['กำลังอ่าน...', 'พบเบาะแส!', 'จดบันทึก...'];
      spawnFloatingText(h.x, h.y - 102, pick(notes), '#e4d0ff', 11);
    }
    h.waitTimer -= dt;
    if (h.waitTimer <= 0) {
      h.libSpot = pickFreeSpot(LIBRARY_SPOTS, h);
      targetSpot(h, h.libSpot);
      h.waitTimer = 4.2 + Math.random() * 2.5;
    }
  }

  function updateCampHero(h, dt, slot) {
    if (!h.campSpot) {
      h.campSpot = CAMP_SPOTS[slot % CAMP_SPOTS.length];
      targetSpot(h, h.campSpot);
    }
    if (!stepToward(h, 52, dt, 4.5)) return;
    h.dir = h.campSpot.dir;
    h.activity = h.view.waiting ? 'heal' : h.campSpot.type; // waiting: the red healing ring
    if (!h.view.working) return;
    h.emoteCd = (h.emoteCd ?? 1.4) - dt;
    if (h.emoteCd <= 0 && state.currentScene === 'camp') {
      h.emoteCd = 2.1 + Math.random() * 1.4;
      if (h.activity === 'eat') spawnFloatingText(h.x, h.y - 100, pick(['+35 HP (สตูว์ร้อน)', 'พักรอบกองไฟ...', 'ฟื้นพลัง!']), '#ffd27d', 11);
      else spawnFloatingText(h.x, h.y - 100, `+${Math.floor(42 + Math.random() * 38)} HP`, '#5ef5b5', 14);
    }
    h.waitTimer -= dt;
    if (h.waitTimer <= 0) {
      h.campSpot = pickFreeSpot(CAMP_SPOTS, h);
      targetSpot(h, h.campSpot);
      h.waitTimer = 5 + Math.random() * 3;
    }
  }

  // Guild hall: calm strolling that steers around the desk, fireplace and side desk.
  function updateSanctuaryHero(h, dt) {
    h.activity = 'idle';
    const dist = Math.hypot(h.targetX - h.x, h.targetY - h.y);
    if (dist > 6) {
      const vx = ((h.targetX - h.x) / dist) * 48;
      const vy = ((h.targetY - h.y) / dist) * 48;
      const nx = h.x + vx * dt;
      const ny = h.y + vy * dt;
      if (!isPointBlocked(h.scene, nx, ny, 14)) {
        h.vx = vx;
        h.vy = vy;
        h.x = nx;
        h.y = ny;
        h.walkPhase += dt * 4.2;
        h.dir = h.vx > 0 ? 'right' : 'left';
      } else if (!isPointBlocked(h.scene, nx, h.y, 14)) {
        h.vx = vx;
        h.vy = 0;
        h.x = nx;
        h.walkPhase += dt * 4.2;
      } else if (!isPointBlocked(h.scene, h.x, ny, 14)) {
        h.vx = 0;
        h.vy = vy;
        h.y = ny;
        h.walkPhase += dt * 4.2;
      } else {
        h.targetX = h.x;
        h.targetY = h.y;
        h.waitTimer = 0.4;
      }
      return;
    }
    h.vx = 0;
    h.vy = 0;
    h.waitTimer -= dt;
    if (h.waitTimer <= 0) {
      const p = randomWalkablePoint(h.scene, othersIn(h.scene, h));
      h.targetX = p.x;
      h.targetY = p.y;
      h.waitTimer = 2.6 + Math.random() * 2.8;
    }
  }

  function updateSimulation(dt, time) {
    // The camera keeps the selected hero in view while it walks.
    const sel = state.selectedId && heroes.get(state.selectedId);
    if (sel && sel.scene === state.currentScene) focusCamera(sel);
    updateCamera(dt);
    const slots = { library: 0, dungeon: 0, camp: 0, sanctuary: 0 };
    for (const h of heroes.values()) {
      const slot = slots[h.scene]++;
      if (h.attackPose > 0) h.attackPose = Math.max(0, h.attackPose - dt);
      if (h.dashOffset) h.dashOffset *= Math.pow(0.02, dt);
      // A waiting (or paused) hero still walks to its spot, then stands still with its bubble:
      // the scene updates only act (attack, emote, change spot) while the turn is running.
      if (h.scene === 'dungeon') updateDungeonHero(h, dt, slot);
      else if (h.scene === 'library') updateLibraryHero(h, dt, slot);
      else if (h.scene === 'camp') updateCampHero(h, dt, slot);
      else if (!h.view.waiting) updateSanctuaryHero(h, dt);
      else {
        h.vx = 0;
        h.vy = 0;
      }
    }

    if (!reducedMotion()) {
      particles.forEach((pt) => {
        pt.x += pt.vx * dt + Math.sin(time + pt.phase) * 6 * dt;
        pt.y += pt.vy * dt;
        if (pt.y < 0) pt.y = WORLD_H;
        if (pt.x < 0) pt.x = WORLD_W;
        if (pt.x > WORLD_W) pt.x = 0;
      });
    }

    if (DUNGEON_BOSS.hitTimer > 0) DUNGEON_BOSS.hitTimer = Math.max(0, DUNGEON_BOSS.hitTimer - dt);
    DUNGEON_BOSS.shakeX *= Math.pow(0.005, dt);
    DUNGEON_BOSS.attackTimer -= dt;
    if (DUNGEON_BOSS.attackTimer <= 0) DUNGEON_BOSS.attackTimer = 3.4 + Math.random() * 1.5;

    for (let i = projectiles.length - 1; i >= 0; i--) {
      const pr = projectiles[i];
      pr.t += dt;
      const u = Math.min(1, pr.t / pr.dur);
      pr.x = pr.x1 + (pr.x2 - pr.x1) * u;
      pr.y = pr.y1 + (pr.y2 - pr.y1) * u;
      if (u >= 1) projectiles.splice(i, 1);
    }
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
      const ft = floatingTexts[i];
      ft.life -= dt;
      ft.y += ft.vy * dt;
      ft.vy *= 0.94;
      if (ft.life <= 0) floatingTexts.splice(i, 1);
    }
    for (let i = effects.length - 1; i >= 0; i--) {
      const ef = effects[i];
      ef.life -= dt;
      ef.x += ef.vx * dt;
      ef.y += ef.vy * dt;
      ef.vy += 120 * dt;
      if (ef.life <= 0) effects.splice(i, 1);
    }
  }

  /* =====================================================================
   * 6. RENDERER (canvas)
   * ===================================================================== */
  const canvas = $('#world-canvas');
  const ctx = canvas.getContext('2d');

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function screenToWorld(sx, sy) {
    const s = baseScale() * cam.zoom;
    return { wx: (sx - window.innerWidth / 2) / s + cam.cx, wy: (sy - window.innerHeight / 2) / s + cam.cy };
  }

  /** Honest progress: quest phases, or the room's 4 stages. Shared by the canvas and the HUD. */
  function progressModel(h) {
    const s = h.session;
    const v = h.view;
    const q = v.quest;
    if (q) {
      const count = Math.max(1, Number(q.phaseCount) || 1);
      const idx = clamp(Number(q.phaseIndex) || 0, 0, count - 1);
      const finished = FINISHED_QUEST.has(q.state);
      const title = q.phase && q.phase.title ? ` ${textOf(q.phase.title)}` : '';
      let label = finished ? QUEST_STATE_LABEL[q.state] : `ขั้น ${idx + 1}/${count}${title}`;
      if ((Number(q.maxLoops) || 1) > 1) label += ` · รอบ ${v.loop}/${Number(q.maxLoops)}`;
      if (v.waiting) label = `รอคุณตอบ · ${label}`;
      else if (q.state === 'paused' || q.state === 'stalled') label = `${QUEST_STATE_LABEL[q.state]} · ${label}`;
      return {
        count,
        done: q.state === 'done' ? count : idx,
        current: finished ? -1 : idx,
        working: v.working && !finished,
        tone: v.waiting ? 'attn' : q.state === 'failed' ? 'failed' : q.state === 'stopped' ? 'stopped' : '',
        label,
      };
    }
    const stage = stageOf(s);
    const rest = s.status === 'idle' || s.status === 'done';
    return {
      count: 4,
      done: s.status === 'done' ? 4 : rest ? 0 : stage,
      current: rest ? -1 : stage,
      working: v.working,
      tone: v.waiting ? 'attn' : '',
      label: v.waiting ? 'รอคุณตอบ' : rest ? textOf(s.statusLabel) || 'พร้อมรับคำสั่ง' : STAGE_LABELS[stage],
    };
  }

  function drawSegBar(x, y, w, hgt, model, accent, time) {
    const gap = 3;
    const n = model.count;
    const segW = (w - gap * (n - 1)) / n;
    ctx.fillStyle = 'rgba(7, 10, 18, 0.88)';
    ctx.fillRect(x - 2, y - 2, w + 4, hgt + 4);
    for (let i = 0; i < n; i++) {
      const sx = x + i * (segW + gap);
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(sx, y, segW, hgt);
      if (i < model.done) {
        ctx.fillStyle = model.tone === 'failed' ? '#b4233a' : model.tone === 'stopped' ? '#64748b' : accent;
        ctx.fillRect(sx, y, segW, hgt);
      } else if (i === model.current) {
        ctx.save();
        ctx.globalAlpha = model.tone === 'attn' ? 1 : 0.45;
        ctx.fillStyle = model.tone === 'attn' ? '#ff5666' : accent;
        ctx.fillRect(sx, y, segW, hgt);
        ctx.restore();
        if (model.working && !reducedMotion()) {
          // Indeterminate shimmer: work is happening, how far along is unknown.
          const band = 14;
          const t = (time * 0.75) % 1;
          const bx = sx - band + t * (segW + band);
          ctx.save();
          ctx.beginPath();
          ctx.rect(sx, y, segW, hgt);
          ctx.clip();
          const g = ctx.createLinearGradient(bx, 0, bx + band, 0);
          g.addColorStop(0, 'rgba(255,255,255,0)');
          g.addColorStop(0.5, 'rgba(255,255,255,0.8)');
          g.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = g;
          ctx.fillRect(bx, y, band, hgt);
          ctx.restore();
        }
      }
    }
  }

  function drawPixelHero(x, y, opts) {
    const { heroId, dir, walkPhase, moving, waiting, glowColor, time, selected, hovered, scene, activity, dashOffset = 0, attackPose = 0 } = opts;
    const sheet = spriteSheets[heroId];
    const px = Math.round(x + dashOffset);
    const py = Math.round(y);

    ctx.save();
    // Ground contact shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.56)';
    ctx.beginPath();
    ctx.ellipse(px, py + 24, 28, 10.5, 0, 0, Math.PI * 2);
    ctx.fill();

    if (scene === 'camp' && activity === 'heal') {
      const r = 36 + Math.sin(time * 4) * 4;
      ctx.strokeStyle = waiting ? `rgba(255, 86, 102, ${0.58 + 0.35 * Math.sin(time * 6)})` : `rgba(62, 232, 158, ${0.62 + 0.3 * Math.sin(time * 4)})`;
      ctx.lineWidth = 2.8;
      ctx.beginPath();
      ctx.ellipse(px, py + 24, r, 14, 0, 0, Math.PI * 2);
      ctx.stroke();
      const beam = ctx.createLinearGradient(px, py - 95, px, py + 24);
      beam.addColorStop(0, 'rgba(62, 232, 158, 0)');
      beam.addColorStop(0.6, 'rgba(62, 232, 158, 0.16)');
      beam.addColorStop(1, 'rgba(62, 232, 158, 0.32)');
      ctx.fillStyle = beam;
      ctx.fillRect(px - 26, py - 95, 52, 118);
    } else if (waiting) {
      // Pulsing red ring: this hero waits for you.
      const pulse = 0.5 + 0.5 * Math.sin(time * 6);
      ctx.strokeStyle = `rgba(255, 86, 102, ${0.55 + 0.4 * pulse})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(px, py + 24, 34 + pulse * 6, 13 + pulse * 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (selected || hovered) {
      ctx.strokeStyle = selected ? '#fae29c' : 'rgba(250, 226, 156, 0.72)';
      ctx.lineWidth = selected ? 2.8 : 1.8;
      ctx.beginPath();
      ctx.ellipse(px, py + 24, 35 + Math.sin(time * 5) * 2, 13, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Animation frame per activity: 0 idle, 1 walk L, 2 walk R, 3 action
    let frameIdx = 0;
    let bobY = 0;
    let sitSquash = 1.0;
    if (moving) {
      const cycle = [1, 0, 2, 0];
      frameIdx = cycle[Math.floor(walkPhase * 1.45) % 4];
      bobY = Math.abs(Math.sin(walkPhase * 2.1)) * -4.5;
    } else if (scene === 'dungeon') {
      frameIdx = attackPose > 0 ? 3 : 0;
      bobY = attackPose > 0 ? -5 : Math.sin(time * 5.2 + x) * 2.2;
    } else if (scene === 'library') {
      if (activity === 'shelf') {
        frameIdx = Math.sin(time * 2.4 + x) > 0.1 ? 3 : 0;
        bobY = Math.sin(time * 2.4 + x) * 1.6;
      } else if (activity === 'read') {
        sitSquash = 0.91;
        bobY = 5 + Math.sin(time * 2.2 + x) * 1.0;
      }
    } else if (scene === 'camp') {
      if (activity === 'eat') {
        sitSquash = 0.89;
        bobY = 6 + Math.abs(Math.sin(time * 4.2 + x)) * -2.2;
      } else {
        frameIdx = Math.sin(time * 2.5 + x) > 0.2 ? 3 : 0;
        bobY = Math.sin(time * 2.8 + x) * 1.8;
      }
    } else {
      frameIdx = Math.sin(time * 1.1 + x) > 0.9 ? 3 : 0;
      bobY = Math.sin(time * 2.4 + x) * 1.3;
    }

    const facingLeft = dir === 'left';
    const drawSize = Math.round(112 * getPerspectiveScale(y));
    if (sheet && sheet.complete && sheet.naturalWidth > 0) {
      const cellW = sheet.naturalWidth / 4;
      const cellH = sheet.naturalHeight;
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.translate(px, Math.round(py + 25 + bobY));
      ctx.scale(facingLeft ? -1 : 1, sitSquash);
      if (selected || attackPose > 0) {
        ctx.shadowBlur = selected ? 18 : 16;
        ctx.shadowColor = selected ? '#fae29c' : glowColor;
      }
      ctx.drawImage(sheet, frameIdx * cellW, 0, cellW, cellH, -drawSize / 2, -drawSize, drawSize, drawSize);
      ctx.restore();
    }

    // Scene props & micro-animations
    if (!moving && scene === 'library' && (activity === 'read' || activity === 'shelf')) {
      const bx = px + (facingLeft ? -34 : 34);
      const by = py - (activity === 'shelf' ? 44 : 18) + Math.sin(time * 3.5 + x) * 2.5;
      ctx.fillStyle = '#5c3418';
      ctx.fillRect(bx - 13, by - 5, 26, 13);
      ctx.fillStyle = '#fff5d6';
      ctx.fillRect(bx - 11, by - 4, 10, 10);
      ctx.fillRect(bx + 1, by - 4, 10, 10);
      const flip = Math.sin(time * 5 + x);
      ctx.fillStyle = '#fae29c';
      ctx.fillRect(bx + (flip > 0 ? 1 : -9), by - 5, 8, 10);
      const gy = (time * 24 + x) % 28;
      ctx.fillStyle = `rgba(196, 155, 255, ${1 - gy / 28})`;
      ctx.fillRect(bx - 2 + Math.sin(time * 4) * 4, by - 8 - gy, 4, 4);
    } else if (!moving && scene === 'camp' && activity === 'eat') {
      const fx = px + (facingLeft ? -30 : 30);
      const fy = py + 2;
      ctx.fillStyle = '#6b3e1e';
      ctx.fillRect(fx - 10, fy, 20, 8);
      ctx.fillStyle = '#4a2912';
      ctx.fillRect(fx - 8, fy + 6, 16, 4);
      ctx.fillStyle = '#f5a631';
      ctx.fillRect(fx - 8, fy - 2, 16, 4);
      for (let k = 0; k < 2; k++) {
        const sy = (time * 20 + k * 12 + x) % 24;
        ctx.fillStyle = `rgba(255, 248, 232, ${(1 - sy / 24) * 0.7})`;
        ctx.fillRect(fx - 3 + k * 6 + Math.sin(time * 4 + k) * 2.5, fy - 5 - sy, 3, 4);
      }
    } else if (scene === 'camp' && activity === 'heal' && !waiting) {
      const hy = (time * 30 + x) % 48;
      ctx.fillStyle = `rgba(98, 255, 185, ${(1 - hy / 48) * 0.95})`;
      ctx.fillRect(px + 28, py - 24 - hy, 10, 3);
      ctx.fillRect(px + 31.5, py - 27.5 - hy, 3, 10);
    }
    ctx.restore();
  }

  function drawSubAgent(x, y, status, time) {
    const py = y + Math.sin(time * 4.2 + x) * 3.5;
    const col = status === 'working' ? '#4de8ff' : status === 'waiting' ? '#ff5666' : '#3ee89e';
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.beginPath();
    ctx.ellipse(x, y + 12, 8, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 14;
    ctx.shadowColor = col;
    ctx.fillStyle = '#0c101e';
    ctx.fillRect(x - 7, py - 9, 14, 14);
    ctx.fillStyle = col;
    ctx.fillRect(x - 5, py - 7, 10, 10);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x - 3, py - 5, 2, 2);
    ctx.fillRect(x + 1, py - 5, 2, 2);
    ctx.restore();
  }

  function drawBubble(x, y, fill, stroke, glyph, time) {
    const bounce = reducedMotion() ? 4 : Math.abs(Math.sin(time * 5.5)) * 8;
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(x, y - bounce, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    if (glyph === 'pause') {
      ctx.fillRect(x - 5, y - bounce - 6, 3.5, 12);
      ctx.fillRect(x + 1.5, y - bounce - 6, 3.5, 12);
    } else {
      ctx.font = `bold 16px ${PIXEL_FONT}`;
      ctx.fillText('!', x, y + 6 - bounce);
    }
  }

  /** Plates and labels grow when the world is drawn small (phones), so they stay readable. */
  function overlayScale() {
    return clamp(0.8 / (baseScale() * cam.zoom), 1, 2.2);
  }

  const plateName = (h) => truncate(heroName(h.session), 24);

  function overlayLabel(h) {
    const v = h.view;
    const q = v.quest;
    const showBar = h.scene !== 'sanctuary' || v.questActive || v.waiting || v.working;
    if (showBar) return { showBar, text: truncate(progressModel(h).label, 34) };
    return { showBar, text: q && FINISHED_QUEST.has(q.state) ? QUEST_STATE_LABEL[q.state] : `${classInfo(h.classId).titleThai} · พักผ่อน` };
  }

  /**
   * Heroes standing close together would pile their plates on each other: stack plates upward
   * and feet labels downward until they are clear. `order` decides who keeps the spot.
   */
  function layoutOverlays(order) {
    const k = overlayScale();
    const hit = (a, b) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
    const tops = [];
    const bottoms = [];
    const out = new Map();
    ctx.save();
    for (const h of order) {
      ctx.font = `bold 12px ${PIXEL_FONT}`;
      const tw = Math.max(ctx.measureText(plateName(h)).width + 20, 96) * k;
      const q = h.view.quest;
      const bubble = h.view.waiting || (q && (q.state === 'paused' || q.state === 'stalled'));
      const above = (bubble ? 56 : 20) * k; // plate, plus the bubble over it
      let dy = 0;
      let top = null;
      for (let i = 0; i < 6; i++) {
        top = { x1: h.x - tw / 2, x2: h.x + tw / 2, y1: h.y - 76 - above + dy, y2: h.y - 76 + dy };
        if (!tops.some((r) => hit(r, top))) break;
        dy -= above + 3 * k;
      }
      tops.push(top);
      ctx.font = `600 11px ${UI_FONT}`;
      const bw = Math.max(98, ctx.measureText(overlayLabel(h).text).width + 14) * k;
      let by = 0;
      let bottom = null;
      for (let i = 0; i < 6; i++) {
        bottom = { x1: h.x - bw / 2, x2: h.x + bw / 2, y1: h.y + 31 + by, y2: h.y + 31 + 27 * k + by };
        if (!bottoms.some((r) => hit(r, bottom))) break;
        by += 29 * k;
      }
      bottoms.push(bottom);
      out.set(h.id, { dy, by });
    }
    ctx.restore();
    return out;
  }

  function drawHeroOverlay(h, time, place = { dy: 0, by: 0 }) {
    const c = classInfo(h.classId);
    const v = h.view;
    const q = v.quest;
    const isSelected = h.id === state.selectedId;
    const k = overlayScale();
    ctx.save();
    ctx.textAlign = 'center';

    // Above the head: name plate (its bottom edge stays put) and the "!" / pause bubble over it.
    ctx.save();
    ctx.translate(h.x, h.y - 76 + place.dy);
    ctx.scale(k, k);
    if (v.waiting) drawBubble(0, -40, '#ff384e', '#fff0b8', '!', time);
    else if (q && (q.state === 'paused' || q.state === 'stalled')) drawBubble(0, -40, '#c27a12', '#fff0b8', 'pause', time);
    ctx.font = `bold 12px ${PIXEL_FONT}`;
    const name = plateName(h);
    const tw = Math.max(ctx.measureText(name).width + 20, 96);
    ctx.fillStyle = isSelected ? 'rgba(48, 36, 14, 0.94)' : 'rgba(8, 11, 20, 0.86)';
    ctx.fillRect(-tw / 2, -20, tw, 20);
    ctx.strokeStyle = v.waiting ? '#ff5666' : isSelected ? '#fae29c' : c.accent;
    ctx.lineWidth = isSelected ? 2 : 1.2;
    ctx.strokeRect(-tw / 2, -20, tw, 20);
    ctx.fillStyle = v.waiting ? '#ffd0d6' : '#f7ead2';
    ctx.fillText(name, 0, -6);
    ctx.restore();

    // At the feet: honest progress (segments + shimmer) and its label.
    ctx.save();
    ctx.translate(h.x, h.y + 31 + place.by);
    ctx.scale(k, k);
    const { showBar, text: sub } = overlayLabel(h);
    ctx.font = `600 11px ${UI_FONT}`;
    if (showBar) {
      drawSegBar(-49, 0, 98, 5, progressModel(h), c.accent, time);
      const sw = ctx.measureText(sub).width + 12;
      ctx.fillStyle = 'rgba(7, 10, 18, 0.84)';
      ctx.fillRect(-sw / 2, 10, sw, 16);
      ctx.fillStyle = v.waiting ? '#ff9aa4' : '#e6eefc';
      ctx.fillText(sub, 0, 22);
    } else {
      const sw = ctx.measureText(sub).width + 14;
      ctx.fillStyle = 'rgba(7, 10, 18, 0.82)';
      ctx.fillRect(-sw / 2, 1, sw, 17);
      ctx.fillStyle = q && q.state === 'failed' ? '#ff9aa4' : '#fae29c';
      ctx.fillText(sub, 0, 13);
    }
    ctx.restore();
    ctx.restore();
  }

  function drawBoss(time, fighters) {
    const bx = Math.round(DUNGEON_BOSS.x + DUNGEON_BOSS.shakeX);
    const by = Math.round(DUNGEON_BOSS.y);
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.beginPath();
    ctx.ellipse(bx, by + 34, 62, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(255, 65, 95, ${0.35 + 0.25 * Math.sin(time * 4)})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(bx, by + 34, 72 + Math.sin(time * 3) * 4, 24, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Frames: 2 hit recoil, 1 lunge (only while someone fights), 0 idle
    let mFrame = 0;
    if (DUNGEON_BOSS.hitTimer > 0) mFrame = 2;
    else if (fighters > 0 && DUNGEON_BOSS.attackTimer < 0.35) mFrame = 1;
    const mSize = 215;
    const mBob = Math.sin(time * 3.2) * 3.5;
    if (monsterSheet.complete && monsterSheet.naturalWidth > 0) {
      const cw = monsterSheet.naturalWidth / 4;
      ctx.imageSmoothingEnabled = false;
      if (DUNGEON_BOSS.hitTimer > 0) {
        ctx.shadowBlur = 24;
        ctx.shadowColor = '#ffffff';
      }
      ctx.drawImage(monsterSheet, mFrame * cw, 0, cw, monsterSheet.naturalHeight, bx - mSize / 2, by + 36 - mSize + mBob, mSize, mSize);
      ctx.shadowBlur = 0;
    }

    // Name plate. No HP bar: nothing in a session says how much of the bug is left.
    ctx.translate(bx, by - 160);
    const k = overlayScale();
    ctx.scale(k, k);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(12, 8, 18, 0.88)';
    ctx.fillRect(-92, -38, 184, 38);
    ctx.strokeStyle = '#ff5666';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-92, -38, 184, 38);
    ctx.font = `bold 12px ${PIXEL_FONT}`;
    ctx.fillStyle = '#ffd0d6';
    ctx.fillText('BUG GOLEM', 0, -22);
    ctx.font = `600 11px ${UI_FONT}`;
    ctx.fillStyle = fighters ? '#ffb3bd' : '#9aa6bd';
    ctx.fillText(fighters ? `ฮีโร่กำลังสู้ ${fighters} ตัว` : 'รอผู้ท้าชิง', 0, -7);
    ctx.restore();
  }

  function drawNavMask(depthInfo) {
    ctx.save();
    const wp = depthInfo.walkPoly;
    ctx.fillStyle = 'rgba(62, 232, 158, 0.16)';
    ctx.strokeStyle = 'rgba(62, 232, 158, 0.85)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([10, 6]);
    ctx.fillRect(wp.minX, wp.minY, wp.maxX - wp.minX, wp.maxY - wp.minY);
    ctx.strokeRect(wp.minX, wp.minY, wp.maxX - wp.minX, wp.maxY - wp.minY);
    ctx.setLineDash([]);
    depthInfo.obstacles.forEach((ob) => {
      ctx.fillStyle = 'rgba(255, 70, 92, 0.34)';
      ctx.strokeStyle = '#ff5666';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(ob.x, ob.y, ob.rx, ob.ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = `bold 11px ${PIXEL_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffd0d6';
      ctx.fillText(`BLOCKED: ${ob.label}`, ob.x, ob.y + 4);
    });
    depthInfo.occluders.forEach((oc) => {
      ctx.strokeStyle = 'rgba(250, 226, 156, 0.78)';
      ctx.lineWidth = 1.8;
      ctx.strokeRect(oc.x, oc.y, oc.w, oc.h);
      ctx.font = `bold 10px ${PIXEL_FONT}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#fae29c';
      ctx.fillText(`OCCLUDE Y>${oc.sortY}`, oc.x + 6, oc.y + 15);
    });
    ctx.restore();
  }

  function drawQuestBoardSign(time) {
    const q = QUEST_BOARD_SPOT;
    const hover = state.hoveredQuestBoard;
    const floatY = reducedMotion() ? 0 : Math.sin(time * 3.2) * 5;
    ctx.save();
    ctx.strokeStyle = `rgba(250, 226, 156, ${Math.min(1, 0.55 + 0.35 * Math.sin(time * 3.5) + (hover ? 0.2 : 0))})`;
    ctx.lineWidth = hover ? 3 : 2;
    ctx.beginPath();
    ctx.ellipse(q.x, q.y + 22, 118 + Math.sin(time * 3) * 5, 32, 0, 0, Math.PI * 2);
    ctx.stroke();
    // The sign keeps its bottom edge on the desk and grows on small screens.
    const k = overlayScale();
    ctx.translate(q.x, q.y - 8 + floatY);
    ctx.scale(k, k);
    const bw = 260;
    const bh = 46;
    ctx.fillStyle = hover ? 'rgba(56, 40, 14, 0.96)' : 'rgba(14, 18, 32, 0.92)';
    ctx.fillRect(-bw / 2, -bh, bw, bh);
    ctx.strokeStyle = hover ? '#fff2c2' : '#e5b85c';
    ctx.lineWidth = hover ? 2.5 : 1.8;
    ctx.strokeRect(-bw / 2, -bh, bw, bh);
    ctx.textAlign = 'center';
    ctx.font = `bold 12px ${PIXEL_FONT}`;
    ctx.fillStyle = '#fae29c';
    ctx.fillText('QUEST BOARD (+)', 0, -bh + 20);
    ctx.font = `600 11px ${UI_FONT}`;
    ctx.fillStyle = '#f3ead3';
    ctx.fillText('คลิกเพื่อส่งเควสต์และเลือกตัวละคร', 0, -bh + 37);
    ctx.restore();
  }

  function drawLightsAndParticles(sc, time) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    sc.lights.forEach((l, idx) => {
      const flick = reducedMotion() ? 0.93 : 0.86 + 0.14 * Math.sin(time * (l.isFire ? 10 : 3.5) + idx);
      const r = l.radius * flick;
      const g = ctx.createRadialGradient(l.x, l.y, 8, l.x, l.y, r);
      g.addColorStop(0, `${l.color}85`);
      g.addColorStop(0.45, `${l.color}28`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(l.x, l.y, r, 0, Math.PI * 2);
      ctx.fill();
    });
    if (!reducedMotion()) {
      particles.forEach((pt) => {
        const a = 0.4 + 0.45 * Math.sin(time * 2.5 + pt.phase);
        if (sc.particleColor === 'emerald' && pt.isSpecial) {
          ctx.fillStyle = `rgba(90, 255, 180, ${a})`;
          ctx.fillRect(pt.x - 4, pt.y - 1.2, 8, 2.4);
          ctx.fillRect(pt.x - 1.2, pt.y - 4, 2.4, 8);
        } else if (sc.particleColor === 'violet' && pt.isSpecial) {
          ctx.fillStyle = `rgba(215, 175, 255, ${a})`;
          ctx.fillRect(pt.x - 3, pt.y - 4, 6, 8);
        } else {
          ctx.fillStyle =
            sc.particleColor === 'cyan'
              ? `rgba(85, 235, 255, ${a})`
              : sc.particleColor === 'emerald'
                ? `rgba(85, 245, 175, ${a})`
                : `rgba(255, 226, 145, ${a})`;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, pt.r, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    }
    ctx.restore();
  }

  function drawScene(time) {
    const sceneId = state.currentScene;
    const sc = SCENES[sceneId];
    const bg = sceneImgs[sceneId];
    const bgReady = bg && bg.complete && bg.naturalWidth > 0;
    if (bgReady) ctx.drawImage(bg, 0, 0, WORLD_W, WORLD_H);
    else {
      ctx.fillStyle = '#0d111b';
      ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    }

    const here = heroesIn(sceneId);
    const drawables = [];

    if (sceneId === 'dungeon') {
      const fighters = here.filter((h) => h.view.working).length;
      drawables.push({ y: DUNGEON_BOSS.y, draw: () => drawBoss(time, fighters) });
    }

    here.forEach((h) => {
      const subs = (Array.isArray(h.session.subAgents) ? h.session.subAgents : [])
        .filter((sa) => sa && (sa.state === 'working' || sa.state === 'waiting'))
        .slice(0, 3);
      subs.forEach((sa, idx) => {
        const ang = time * 1.5 + idx * 2.5;
        const sx = h.x + Math.cos(ang) * 42;
        const sy = h.y + Math.sin(ang) * 20 + 8;
        drawables.push({ y: sy, draw: () => drawSubAgent(sx, sy, sa.state, time) });
      });
      drawables.push({
        y: h.y,
        draw: () => {
          drawPixelHero(h.x, h.y, {
            heroId: h.classId,
            dir: h.dir,
            walkPhase: h.walkPhase,
            moving: Math.hypot(h.vx, h.vy) > 6,
            waiting: h.view.waiting,
            glowColor: classInfo(h.classId).glow,
            time,
            selected: h.id === state.selectedId,
            hovered: h.id === state.hoveredId,
            scene: sceneId,
            activity: h.activity || 'idle',
            dashOffset: h.dashOffset || 0,
            attackPose: h.attackPose || 0,
          });
        },
      });
    });

    // Painted foreground pieces join the Y-sort, so heroes behind a desk are hidden by it.
    const depthInfo = SCENE_DEPTH[sceneId];
    if (depthInfo && bgReady) {
      const sxScale = bg.naturalWidth / WORLD_W;
      const syScale = bg.naturalHeight / WORLD_H;
      depthInfo.occluders.forEach((oc) => {
        drawables.push({
          y: oc.sortY,
          draw: () => {
            ctx.save();
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(oc.x, oc.y, oc.w, oc.h, oc.feather || 10);
            else ctx.rect(oc.x, oc.y, oc.w, oc.h);
            ctx.clip();
            ctx.drawImage(bg, oc.x * sxScale, oc.y * syScale, oc.w * sxScale, oc.h * syScale, oc.x, oc.y, oc.w, oc.h);
            ctx.restore();
          },
        });
      });
    }

    drawables.sort((a, b) => a.y - b.y);
    drawables.forEach((d) => d.draw());

    // Debug layer on top of the painting, so the occluder outlines and labels can be read.
    if (state.showNavMask && depthInfo) drawNavMask(depthInfo);

    if (sceneId === 'sanctuary') drawQuestBoardSign(time);

    // Name plates, bubbles and progress sit above the painted foreground so they stay readable;
    // the selected and the hovered hero go last (on top).
    const rank = (h) => (h.id === state.selectedId ? 3 : h.view.waiting ? 2 : h.id === state.hoveredId ? 1 : 0);
    const order = here.slice().sort((a, b) => rank(b) - rank(a) || a.y - b.y);
    const places = layoutOverlays(order);
    order
      .slice()
      .reverse()
      .forEach((h) => drawHeroOverlay(h, time, places.get(h.id)));

    effects.forEach((ef) => {
      ctx.save();
      ctx.fillStyle = ef.color;
      ctx.globalAlpha = Math.max(0, ef.life / ef.maxLife);
      ctx.fillRect(ef.x, ef.y, ef.size, ef.size);
      ctx.restore();
    });

    projectiles.forEach((pr) => {
      ctx.save();
      ctx.shadowBlur = 18;
      ctx.shadowColor = pr.color;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = pr.color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(pr.x, pr.y);
      ctx.lineTo(pr.x + 24, pr.y);
      ctx.stroke();
      ctx.restore();
    });

    floatingTexts.forEach((ft) => {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, (ft.life / ft.maxLife) * 1.4));
      ctx.textAlign = 'center';
      ctx.font = `bold ${ft.size}px ${PIXEL_FONT}`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(5, 7, 14, 0.92)';
      ctx.strokeText(ft.text, ft.x, ft.y);
      ctx.fillStyle = ft.color;
      ctx.fillText(ft.text, ft.x, ft.y);
      ctx.restore();
    });

    if (state.bloomEnabled) drawLightsAndParticles(sc, time);
  }

  function renderFrame(time) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    ctx.fillStyle = '#060810';
    ctx.fillRect(0, 0, vw, vh);
    const s = baseScale() * cam.zoom;
    ctx.save();
    ctx.translate(vw / 2, vh / 2);
    ctx.scale(s, s);
    ctx.translate(-cam.cx, -cam.cy);
    drawScene(time);
    ctx.restore();
  }

  /* =====================================================================
   * 7. HUD RENDERERS
   * ===================================================================== */
  let hudTimer = null;
  let hudForce = false;
  function scheduleHud(force = false) {
    hudForce = hudForce || force;
    if (hudTimer) return;
    hudTimer = setTimeout(() => {
      hudTimer = null;
      const f = hudForce;
      hudForce = false;
      renderHud(f);
    }, 0);
  }

  function renderHud(force = false) {
    renderTopbar();
    renderSceneSwitcher(force);
    renderSubtitle();
    renderPortals();
    renderPartyStrip(force);
    renderDrawer(force);
    if (qb.open) {
      renderQbExisting();
      renderQbDatalist();
    }
  }

  const waitingHeroes = () => [...heroes.values()].filter((h) => h.view.waiting);

  function gemClass(h) {
    const s = h.session;
    const q = h.view.quest;
    if (h.view.waiting) return 'gem-attn';
    if (q && (q.state === 'paused' || q.state === 'stalled')) return 'gem-hold';
    if (s.status === 'paused_quota' || (s.quotaHold && s.status !== 'working')) return 'gem-hold';
    if (h.view.working) return h.scene === 'dungeon' ? 'gem-work' : h.scene === 'camp' ? 'gem-test' : 'gem-research';
    if (s.status === 'done' || (q && q.state === 'done')) return 'gem-done';
    return 'gem-idle';
  }

  function statusPill(h) {
    const s = h.session;
    const label = textOf(s.statusLabel);
    if (h.view.waiting) return { cls: 'pill-attn', label: label || 'รอคุณ' };
    if (s.status === 'paused_quota' || (s.quotaHold && s.status !== 'working')) return { cls: 'pill-hold', label: 'พักรอ usage reset' };
    if (h.view.working) return { cls: 'pill-work', label: label || 'กำลังทำงาน' };
    if (s.status === 'done') return { cls: 'pill-done', label: label || 'เสร็จแล้ว' };
    return { cls: '', label: label || 'ว่าง' };
  }

  let topbarSig = '';
  function renderTopbar() {
    const total = heroes.size;
    const waiting = waitingHeroes().length;
    const sig = JSON.stringify([state.connected, state.hasSnapshot, total, waiting]);
    if (sig === topbarSig) return;
    topbarSig = sig;
    $('#conn-dot').className = `gem ${state.connected ? 'gem-live' : 'gem-off'}`;
    $('#conn-label').textContent = state.connected ? `เชื่อมต่อสด · ฮีโร่ ${total} ตัว` : 'ขาดการเชื่อมต่อ กำลังลองใหม่…';
    const btn = $('#waiting-btn');
    if (waiting) {
      btn.hidden = false;
      btn.innerHTML = `${icon('alert', 15)}<span>รอคุณ ${waiting}</span>`;
      btn.setAttribute('aria-label', `มีฮีโร่รอคุณ ${waiting} ตัว ไปที่ตัวถัดไป`);
      btn.title = 'ไปที่ฮีโร่ที่รอคุณตัวถัดไป';
    } else {
      btn.hidden = true;
    }
    $('#title-dot').className = `gem ${state.connected ? 'gem-live' : 'gem-off'}`;
    $('#title-meta').textContent = !state.connected
      ? 'กำลังเชื่อมต่อ Mission Control…'
      : !state.hasSnapshot
        ? 'เชื่อมต่อแล้ว กำลังโหลดฮีโร่…'
        : `ฮีโร่ออนไลน์ ${total} ตัว${waiting ? ` · รอคุณ ${waiting}` : ''}`;
  }

  let switcherSig = '';
  function renderSceneSwitcher(force) {
    const rows = SCENE_ORDER.map((id) => {
      const list = heroesIn(id);
      return [id, list.length, list.filter((h) => h.view.waiting).length];
    });
    const sig = JSON.stringify([state.currentScene, rows]);
    if (!force && sig === switcherSig) return;
    switcherSig = sig;
    $('#scene-switcher').innerHTML = rows
      .map(([id, count, alerts]) => {
        const sc = SCENES[id];
        const active = state.currentScene === id;
        const label = `${sc.shortLabel} มีฮีโร่ ${count} ตัว${alerts ? ` รอคุณ ${alerts}` : ''}`;
        return `<button type="button" class="scene-tab ${active ? `${sc.activeClass} is-active` : ''}" data-act="switch-scene" data-scene="${id}" aria-pressed="${active}" aria-label="${esc(label)}" title="${esc(label)}">
          ${icon(sc.icon, 14)}<span class="tab-label">${esc(sc.shortLabel)}</span><span class="count">${count}</span>${alerts ? `<span class="alerts">! ${alerts}</span>` : ''}
        </button>`;
      })
      .join('');
  }

  let subtitleScene = '';
  function renderSubtitle() {
    if (subtitleScene === state.currentScene) return;
    subtitleScene = state.currentScene;
    const sc = SCENES[state.currentScene];
    $('#scene-subtitle').innerHTML = `
      <div class="subtitle-card" style="border-color:${sc.accent}">
        <div class="pixel subtitle-title" style="color:${sc.accent}">${esc(sc.title)}</div>
        <div class="subtitle-desc">${esc(sc.desc)}</div>
      </div>`;
  }

  let portalScene = '';
  function renderPortals() {
    if (portalScene === state.currentScene) return;
    portalScene = state.currentScene;
    const idx = SCENE_ORDER.indexOf(state.currentScene);
    const set = (el, target, side) => {
      if (!target) {
        el.hidden = true;
        return;
      }
      const sc = SCENES[target];
      el.hidden = false;
      el.setAttribute('data-scene', target);
      el.setAttribute('aria-label', `ไปที่${sc.shortLabel}`);
      el.innerHTML =
        side === 'left'
          ? `${icon('chevronLeft', 16)}<span class="portal-label">${esc(sc.shortLabel)}</span>`
          : `<span class="portal-label">${esc(sc.shortLabel)}</span>${icon('chevronRight', 16)}`;
    };
    set($('#portal-left'), SCENE_ORDER[idx - 1], 'left');
    set($('#portal-right'), SCENE_ORDER[idx + 1], 'right');
  }

  function segHtml(model, accent) {
    let segs = '';
    for (let i = 0; i < model.count; i++) {
      const cls = i < model.done ? 'on' : i === model.current ? `now${model.working ? ' working' : ''}` : '';
      segs += `<i class="${cls}"></i>`;
    }
    return `<div class="seg-bar ${model.tone ? `is-${model.tone}` : ''}" style="--accent:${accent}" role="img" aria-label="${esc(model.label)}">${segs}</div>`;
  }

  function partyOrder(list) {
    const rank = (h) => (h.view.waiting ? 0 : h.view.working ? 1 : 2);
    return list.map((h, i) => [h, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
  }

  function chipHtml(h) {
    const s = h.session;
    const c = classInfo(h.classId);
    const v = h.view;
    const q = v.quest;
    const name = heroName(s);
    const selected = h.id === state.selectedId;
    const id = esc(h.id);
    let action;
    if (v.waiting) {
      action = `<button type="button" class="btn btn-crimson btn-sm btn-block" data-act="select-hero" data-id="${id}">${icon('alert', 13)}<span>ดูคำขอและตอบ</span></button>`;
    } else if (h.scene === 'sanctuary' && !v.questActive && !v.working) {
      const sub = q && FINISHED_QUEST.has(q.state) ? QUEST_STATE_LABEL[q.state] : textOf(s.statusLabel) || 'พักผ่อน';
      action = `<span class="chip-sub">${esc(sub)}</span>${
        isIdleSession(s) ? `<button type="button" class="btn btn-gold btn-sm btn-block" data-act="open-quest-board" data-id="${id}">${icon('scroll', 13)}<span>ส่งออกเควสต์</span></button>` : ''
      }`;
    } else {
      const model = progressModel(h);
      action = `${segHtml(model, c.accent)}<span class="chip-sub">${esc(model.label)}</span>`;
    }
    return `
      <div class="chip ${selected ? 'selected' : ''} ${v.waiting ? 'is-alert' : ''}">
        <button type="button" class="chip-select" data-act="select-hero" data-id="${id}" aria-pressed="${selected}" aria-label="${esc(`ดูรายละเอียด ${name}`)}"></button>
        <div class="chip-portrait"><img src="${c.portrait}" alt="" /><span class="gem ${gemClass(h)}"></span></div>
        <div class="chip-body">
          <span class="chip-name pixel" title="${esc(name)}">${esc(name)}</span>
          <span class="chip-class" style="color:${c.accent}">${esc(c.titleThai)}${q ? '' : ' · ฮีโร่อิสระ'}</span>
          ${action}
        </div>
      </div>`;
  }

  let partySig = '';
  function renderPartyStrip(force) {
    const here = partyOrder(heroesIn(state.currentScene));
    const sig = JSON.stringify([
      state.currentScene,
      state.selectedId,
      classes.status,
      here.map((h) => [h.id, h.classId, heroName(h.session), h.session.status, h.session.statusLabel, h.session.stageIndex, h.view.quest, isIdleSession(h.session)]),
    ]);
    if (!force && sig === partySig) return;
    partySig = sig;
    const strip = $('#party-strip');
    if (!here.length) {
      strip.innerHTML = `
        <div class="hud party-empty">
          <span>ตอนนี้ยังไม่มีฮีโร่อยู่ใน${esc(SCENES[state.currentScene].shortLabel)}</span>
          <button type="button" class="btn btn-gold btn-sm" data-act="open-quest-board">${icon('scroll', 13)}<span>เปิด Quest Board ส่งเควสต์</span></button>
        </div>`;
      return;
    }
    strip.innerHTML = here.map(chipHtml).join('');
  }

  /* ---------- Inspector drawer ---------- */
  let drawerSig = '';

  function attentionHtml(h) {
    const s = h.session;
    const p = s.interactivePrompt && typeof s.interactivePrompt === 'object' ? s.interactivePrompt : null;
    if (!(h.view.waiting || p || s.pendingAction)) return '';
    const id = esc(h.id);
    const chatHref = esc(`/#room=${encodeURIComponent(h.id)}`);
    const busy = state.busy.has(`attn:${h.id}`) ? 'disabled' : '';
    const questions =
      p && Array.isArray(p.questions) && p.questions.length
        ? p.questions
        : s.pendingAsk && Array.isArray(s.pendingAsk.questions)
          ? s.pendingAsk.questions
          : null;

    // AskUserQuestion (and multi-select): answered in the chat, which has the review flow.
    if (questions || s.pendingAsk || (p && p.multiSelect)) {
      const list = questions
        ? `<ol class="attn-list">${questions.slice(0, 4).map((q) => `<li>${esc(q && q.question)}</li>`).join('')}</ol>`
        : p && p.question
          ? `<div class="attn-q"><span>${esc(p.question)}</span></div>`
          : '';
      return `
        <div class="attn" role="group" aria-label="Claude ถามคุณ">
          <div class="attn-q">${icon('alert', 16)}<span>Claude ถามคุณ${questions && questions.length > 1 ? ` ${questions.length} ข้อ` : ''} — ตอบในหน้าแชทได้ครบทุกข้อ</span></div>
          ${list}
          <div class="attn-actions"><a class="btn btn-gold" href="${chatHref}">${icon('chat', 14)}<span>ตอบในหน้าแชท</span></a></div>
        </div>`;
    }

    if (p && Array.isArray(p.options) && p.options.length) {
      const cur = Number(p.currentIndex) || 1;
      const opts = p.options
        .filter((o) => o && typeof o === 'object')
        .map(
          (o) => `
          <button type="button" class="opt ${Number(o.index) === cur ? 'is-cursor' : ''}" data-act="choose-option" data-id="${id}" data-index="${esc(o.index)}" ${busy}>
            <span class="opt-num">${esc(o.number)}</span>
            <span><span>${esc(o.label)}</span>${o.description ? `<span class="opt-desc">${esc(o.description)}</span>` : ''}</span>
          </button>`
        )
        .join('');
      return `
        <div class="attn" role="group" aria-label="รอคุณเลือก">
          <div class="attn-q">${icon('alert', 16)}<span>${esc(p.question || s.pendingAction || 'รอคุณเลือก')}</span></div>
          <div class="attn-options">${opts}</div>
          <div class="attn-actions"><button type="button" class="btn btn-sm" data-act="reject" data-id="${id}" ${busy}>ยกเลิก (Esc)</button></div>
        </div>`;
    }

    if (s.pendingAction) {
      return `
        <div class="attn" role="group" aria-label="รอยืนยัน">
          <div class="attn-q">${icon('alert', 16)}<span>รอยืนยัน: <span class="mono">${esc(s.pendingAction)}</span></span></div>
          <div class="attn-actions">
            <button type="button" class="btn btn-emerald" data-act="approve" data-id="${id}" ${busy}>${icon('check', 14)}<span>อนุญาต</span></button>
            <button type="button" class="btn btn-crimson" data-act="reject" data-id="${id}" ${busy}>ปฏิเสธ (Esc)</button>
          </div>
        </div>`;
    }

    return `
      <div class="attn" role="group" aria-label="รอคุณ">
        <div class="attn-q">${icon('alert', 16)}<span>${esc(s.statusLabel || 'รอคุณตอบใน terminal')}</span></div>
        <div class="attn-actions"><a class="btn" href="${chatHref}">${icon('chat', 14)}<span>เปิดในหน้าแชท</span></a></div>
      </div>`;
  }

  function questLogHtml(entries) {
    const lv = (l) => (l === 'success' || l === 'warn' || l === 'error' ? l : 'info');
    return `<ol class="log-list selectable">${entries
      .map((e) => `<li class="lv-${lv(e && e.level)}"><time>${esc(clockTime(e && e.at))}</time>${esc(e && e.text)}</li>`)
      .join('')}</ol>`;
  }

  function questCardHtml(h) {
    const q = h.view.quest;
    const c = classInfo(h.classId);
    const count = Math.max(1, Number(q.phaseCount) || (c.phases.length || 1));
    const idx = clamp(Number(q.phaseIndex) || 0, 0, count - 1);
    const finished = FINISHED_QUEST.has(q.state);
    const phases = c.phases.length === count ? c.phases : null;
    let timeline;
    if (phases) {
      timeline = phases
        .map((p, i) => {
          const done = q.state === 'done' || i < idx;
          const now = !finished && i === idx;
          const item = `<li class="${done ? 'done' : now ? 'now' : ''}" ${now ? 'aria-current="step"' : ''}>${icon(done ? 'check' : SCENES[p.scene].icon, 12)}<span>${esc(p.title)}</span></li>`;
          return i < phases.length - 1 ? `${item}<li class="arrow" aria-hidden="true">→</li>` : item;
        })
        .join('');
    } else {
      const title = q.phase && q.phase.title ? ` ${textOf(q.phase.title)}` : '';
      timeline = `<li class="${finished ? 'done' : 'now'}">ขั้น ${idx + 1}/${count}${esc(title)}</li>`;
    }
    const stateCls = { launching: 'pill-work', running: 'pill-work', paused: 'pill-hold', stalled: 'pill-hold', done: 'pill-done', failed: 'pill-fail' }[q.state] || '';
    const maxLoops = Number(q.maxLoops) || 1;
    const log = Array.isArray(q.log) ? q.log.slice(-3) : [];
    const qid = esc(q.id);
    const busy = state.busy.has(`quest:${q.id}`) ? 'disabled' : '';
    let actions = '';
    if (q.state === 'paused' || q.state === 'stalled') {
      actions = `
        <label class="qb-label" for="quest-note">โน้ตถึงฮีโร่ (ไม่ใส่ก็ได้)</label>
        <input id="quest-note" class="input note-input" type="text" maxlength="2000" autocomplete="off" placeholder="เช่น ใช้ branch เดิม แล้วรันเฉพาะเทสต์ที่พัง" />
        <div class="attn-actions">
          <button type="button" class="btn btn-emerald" data-act="quest-resume" data-quest="${qid}" ${busy}>${icon('play', 14)}<span>ทำต่อ</span></button>
          <button type="button" class="btn btn-crimson" data-act="quest-stop" data-quest="${qid}" ${busy}>${icon('stop', 14)}<span>หยุดเควสต์</span></button>
        </div>`;
    } else if (ACTIVE_QUEST.has(q.state)) {
      actions = `<div class="attn-actions"><button type="button" class="btn btn-crimson" data-act="quest-stop" data-quest="${qid}" ${busy}>${icon('stop', 14)}<span>หยุดเควสต์</span></button></div>`;
    }
    return `
      <div class="card">
        <div class="row row-between">
          <span class="card-title pixel">QUEST · ${esc(q.name)}</span>
          <span class="pill ${stateCls}">${esc(QUEST_STATE_LABEL[q.state] || q.state)}</span>
        </div>
        <ol class="timeline" aria-label="ขั้นของเควสต์">${timeline}</ol>
        ${maxLoops > 1 ? `<div class="row"><span class="pill">${icon('loop', 12)}<span>รอบ ${h.view.loop}/${maxLoops}</span></span></div>` : ''}
        ${q.stateReason ? `<div class="reason">${esc(q.stateReason)}</div>` : ''}
        ${log.length ? questLogHtml(log) : ''}
        ${actions}
      </div>`;
  }

  function stageCardHtml(h) {
    const model = progressModel(h);
    return `
      <div class="card">
        <div class="card-title pixel">ความคืบหน้าของห้อง</div>
        ${segHtml(model, classInfo(h.classId).accent)}
        <div class="row" style="font-size:12px;color:#cbd5e1">${esc(model.label)}</div>
        <p class="empty-note" style="margin:0">ฮีโร่อิสระ ไม่ได้อยู่บนเควสต์ ฉากตามขั้นงานของห้อง</p>
      </div>`;
  }

  function overviewHtml(h) {
    const s = h.session;
    const q = h.view.quest;
    const pill = statusPill(h);
    const tool = textOf(s.currentTool);
    return `
      <div class="card">
        <div class="row row-between">
          <span class="pill ${pill.cls}">${esc(pill.label)}</span>
          ${tool && tool !== 'Idle' ? `<span class="mono" style="font-size:11px;color:#94a3b8" title="${esc(tool)}">${esc(truncate(tool, 40))}</span>` : ''}
        </div>
        <div class="card-title pixel">${q ? 'เป้าหมายเควสต์' : 'งานล่าสุด'} &amp; TL;DR</div>
        <div class="goal selectable">${esc(q ? q.goal : s.goal)}</div>
        <div class="tldr selectable">${miniMd(s.tldr)}</div>
      </div>
      ${q ? questCardHtml(h) : stageCardHtml(h)}
      <div class="card card-cyan">
        <div class="card-title pixel">WORKSPACE</div>
        <dl class="kv">
          <dt>โฟลเดอร์</dt><dd class="mono selectable">${esc(s.cwd || '—')}</dd>
          <dt>branch</dt><dd class="mono">${esc(s.branch || '—')}</dd>
          ${s.model ? `<dt>model</dt><dd class="mono">${esc(s.model)}</dd>` : ''}
        </dl>
      </div>`;
  }

  function logHtml(h) {
    const s = h.session;
    const q = h.view.quest;
    const events = Array.isArray(s.recentEvents) ? s.recentEvents.filter((e) => e && typeof e === 'object').slice(0, 15) : [];
    const qlog = q && Array.isArray(q.log) ? q.log : [];
    const lv = (l) => (l === 'success' || l === 'warn' || l === 'error' ? l : 'info');
    return `
      ${q ? `<div class="card-title pixel">บันทึกเควสต์</div>${qlog.length ? questLogHtml(qlog) : '<p class="empty-note">ยังไม่มีบันทึก</p>'}` : ''}
      <div class="card-title pixel">เหตุการณ์ล่าสุด</div>
      ${
        events.length
          ? `<ol class="log-list selectable">${events
              .map((e) => `<li class="lv-${lv(e.level)}"><time>${esc(clockTime(e.timestamp))}</time>${esc(e.title)}</li>`)
              .join('')}</ol>`
          : '<p class="empty-note">ยังไม่มีเหตุการณ์</p>'
      }`;
  }

  function fileList(s) {
    return (Array.isArray(s.modifiedFiles) ? s.modifiedFiles : [])
      .map((f) => (typeof f === 'string' ? f : f && typeof f.path === 'string' ? f.path : ''))
      .filter(Boolean);
  }

  function filesHtml(h) {
    const s = h.session;
    const files = fileList(s).slice(0, 40);
    const agents = (Array.isArray(s.subAgents) ? s.subAgents : []).filter((a) => a && typeof a === 'object').slice(0, 20);
    const agentGem = (st) => (st === 'working' ? 'gem-work' : st === 'waiting' ? 'gem-attn' : 'gem-done');
    return `
      <div class="card">
        <div class="card-title pixel">ไฟล์ที่แก้ (${files.length})</div>
        ${files.length ? `<ul class="file-list selectable">${files.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p class="empty-note" style="margin:0">ยังไม่มีไฟล์ที่แก้</p>'}
      </div>
      <div class="card">
        <div class="card-title pixel">ผู้ช่วย (Sub-agent)</div>
        ${
          agents.length
            ? `<ul class="agent-list">${agents
                .map(
                  (a) => `<li><span class="gem ${agentGem(a.state)}"></span><span><strong>${esc(a.name || a.subagentType || 'Sub-agent')}</strong><span class="agent-role">${esc(truncate(a.role || a.tool, 140))}</span></span></li>`
                )
                .join('')}</ul>`
            : '<p class="empty-note" style="margin:0">ไม่มีผู้ช่วยในรอบนี้</p>'
        }
      </div>`;
  }

  function drawerHtml(h) {
    const s = h.session;
    const c = classInfo(h.classId);
    const q = h.view.quest;
    const name = heroName(s);
    const nFiles = fileList(s).length;
    const tabs = [
      ['overview', 'ภาพรวม'],
      ['log', 'บันทึก'],
      ['files', `ไฟล์ & ผู้ช่วย (${nFiles})`],
    ];
    const body = state.drawerTab === 'log' ? logHtml(h) : state.drawerTab === 'files' ? filesHtml(h) : overviewHtml(h);
    const sending = state.busy.has(`msg:${h.id}`) ? 'disabled' : '';
    return `
      <div class="drawer-head">
        <div class="drawer-id">
          <img src="${c.portrait}" alt="" />
          <div style="min-width:0">
            <div class="drawer-name pixel" title="${esc(name)}">${esc(name)}</div>
            <div class="drawer-class" style="color:${c.accent}"><span>${esc(c.name)} · ${esc(c.titleThai)}</span>${q ? '' : '<span class="tag">ฮีโร่อิสระ</span>'}</div>
            <div class="drawer-meta mono">${esc(s.branch || '—')} · ${esc(SCENES[h.scene].shortLabel)}</div>
          </div>
        </div>
        <button type="button" class="icon-btn" data-act="close-drawer" aria-label="ปิดรายละเอียด">${icon('x', 18)}</button>
      </div>
      ${attentionHtml(h)}
      <div class="drawer-tabs" role="tablist" aria-label="ส่วนรายละเอียด">
        ${tabs
          .map(
            ([id, label]) =>
              `<button type="button" role="tab" class="drawer-tab" id="dtab-${id}" data-act="drawer-tab" data-tab="${id}" aria-selected="${state.drawerTab === id}">${esc(label)}</button>`
          )
          .join('')}
      </div>
      <div class="drawer-body" role="tabpanel" aria-labelledby="dtab-${esc(state.drawerTab)}">${body}</div>
      <div class="drawer-foot">
        <form id="cmd-form" class="cmd-form" data-id="${esc(h.id)}">
          <input id="cmd-input" class="input" type="text" maxlength="8000" autocomplete="off" placeholder="${esc(`ส่งข้อความถึง ${truncate(name, 30)}…`)}" aria-label="ข้อความถึงฮีโร่" />
          <button type="submit" class="btn btn-gold" ${sending}>${icon('send', 14)}<span>ส่ง</span></button>
        </form>
        <a class="btn btn-block" href="${esc(`/#room=${encodeURIComponent(h.id)}`)}">${icon('chat', 14)}<span>เปิดในหน้าแชท</span></a>
      </div>`;
  }

  function renderDrawer(force) {
    const el = $('#drawer');
    const h = state.selectedId ? heroes.get(state.selectedId) : null;
    document.body.classList.toggle('drawer-open', Boolean(h));
    if (!h) {
      if (drawerSig) {
        drawerSig = '';
        el.classList.remove('open');
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = '';
      }
      return;
    }
    const sig = JSON.stringify([h.session, h.classId, h.scene, state.drawerTab, classes.status, [...state.busy]]);
    if (!force && sig === drawerSig) return;
    drawerSig = sig;

    // Keep what the person is typing, where the focus is, and the scroll position.
    const active = document.activeElement;
    const focusId = active && el.contains(active) && active.id ? active.id : null;
    const bodyEl = el.querySelector('.drawer-body');
    const scrollTop = bodyEl ? bodyEl.scrollTop : 0;

    el.innerHTML = drawerHtml(h);
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');

    const msg = $('#cmd-input', el);
    if (msg) msg.value = drafts.msg.get(h.id) || '';
    const note = $('#quest-note', el);
    if (note) note.value = drafts.note.get(h.id) || '';
    const newBody = el.querySelector('.drawer-body');
    if (newBody) newBody.scrollTop = scrollTop;
    if (focusId) {
      const f = document.getElementById(focusId);
      if (f) {
        f.focus({ preventScroll: true });
        if (typeof f.value === 'string' && f.setSelectionRange) f.setSelectionRange(f.value.length, f.value.length);
      }
    }
  }

  /* =====================================================================
   * 8. QUEST BOARD
   * ===================================================================== */
  const qb = { open: false, heroId: 'qa_loop', optionValue: null, presetEdited: false, launch: 'terminal', existingId: '', submitting: false, opener: null };

  function presetFor(c, value) {
    const p = c.presets || {};
    const v = p[String(value)];
    return textOf(typeof v === 'string' ? v : p.default);
  }

  function defaultCwd() {
    const last = lsGet(LS_KEYS.cwd);
    if (last) return last;
    const sel = state.selectedId && heroes.get(state.selectedId);
    if (sel && sel.session.cwd) return textOf(sel.session.cwd);
    for (const h of heroes.values()) if (h.session.cwd) return textOf(h.session.cwd);
    return '';
  }

  function openQuestBoard(sessionId) {
    qb.opener = document.activeElement;
    qb.open = true;
    $('#qb-modal').hidden = false;
    document.body.classList.add('modal-open');
    if (sessionId) {
      const h = heroes.get(sessionId);
      if (h && isIdleSession(h.session)) {
        qb.launch = 'existing';
        qb.existingId = sessionId;
      }
    }
    const cwd = $('#qb-cwd');
    if (!cwd.value.trim()) cwd.value = defaultCwd();
    if (classes.status !== 'ok' && classes.status !== 'loading') loadClasses();
    renderQuestBoard(!qb.presetEdited);
    playSfx('click');
    setTimeout(() => {
      const target = isNarrow() ? $('#qb-grid [aria-pressed="true"]') : $('#qb-goal');
      if (target) target.focus({ preventScroll: isNarrow() });
    }, 0);
  }

  function closeQuestBoard() {
    if (!qb.open) return;
    qb.open = false;
    $('#qb-modal').hidden = true;
    document.body.classList.remove('modal-open');
    const back = qb.opener;
    qb.opener = null;
    if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
  }

  function ensureOptionValue(c) {
    if (!c.option) {
      qb.optionValue = null;
      return;
    }
    const has = (v) => c.option.values.some((x) => String(x.value) === String(v));
    if (qb.optionValue !== null && has(qb.optionValue)) return;
    qb.optionValue = has(c.option.default) ? c.option.default : c.option.values[0].value;
  }

  function renderQuestBoard(resetPreset) {
    const status = $('#qb-status');
    if (classes.status === 'ok') {
      status.hidden = true;
    } else if (classes.status === 'error') {
      status.hidden = false;
      status.className = 'qb-status is-err';
      status.innerHTML = `${icon('alert', 16)}<span>โหลดรายชื่อคลาสไม่สำเร็จ: ${esc(classes.error)}</span><button type="button" class="btn btn-sm" data-act="qb-retry">ลองใหม่</button>`;
    } else {
      status.hidden = false;
      status.className = 'qb-status';
      status.textContent = 'กำลังโหลดรายชื่อคลาสจากเซิร์ฟเวอร์…';
    }

    const list = classes.status === 'ok' ? classes.list : CLASS_IDS.map((id) => CLASS_VISUALS[id]);
    if (!list.some((c) => c.id === qb.heroId)) qb.heroId = list[0].id;
    const chosen = classInfo(qb.heroId);
    ensureOptionValue(chosen);

    $('#qb-grid').innerHTML = list
      .map((c) => {
        const active = c.id === qb.heroId;
        return `
          <button type="button" class="hero-card" data-act="qb-pick-hero" data-hero="${esc(c.id)}" aria-pressed="${active}">
            <span class="hero-card-art"><img src="${c.portrait}" alt="" /><span class="hero-card-badge" style="color:${c.accent}">${esc(c.badge)}</span></span>
            <span class="hero-card-name pixel">${esc(c.name)}</span>
            <span class="hero-card-thai">${esc(c.titleThai)}</span>
          </button>`;
      })
      .join('');

    const flow = chosen.flowSteps
      .map((st, i) => `<span class="step">${esc(st)}</span>${i < chosen.flowSteps.length - 1 ? '<span class="arrow" aria-hidden="true">→</span>' : ''}`)
      .join('');
    const option = chosen.option
      ? `
        <div class="qb-option" role="group" aria-label="${esc(chosen.option.label)}">
          <span class="qb-option-label">${esc(chosen.option.label)}</span>
          <div class="qb-option-values">
            ${chosen.option.values
              .map(
                (v, i) =>
                  `<button type="button" class="btn btn-sm" data-act="qb-set-option" data-index="${i}" aria-pressed="${String(v.value) === String(qb.optionValue)}">${esc(v.label)}</button>`
              )
              .join('')}
          </div>
        </div>`
      : '';
    $('#qb-config').innerHTML = `
      <div class="qb-config-head">
        <span><span class="pixel" style="font-size:11px;color:${chosen.accent}">${esc(chosen.name)}</span> <span style="font-size:12px;color:#cbd5e1">(${esc(chosen.titleThai)})</span></span>
        <div class="flow" aria-label="เส้นทางของคลาส">${flow}</div>
      </div>
      ${option}`;

    if (resetPreset || !qb.presetEdited) {
      $('#qb-preset').value = presetFor(chosen, qb.optionValue);
      qb.presetEdited = false;
    }

    renderQbWho();
    renderQbExisting();
    renderQbDatalist();

    const first = (chosen.phases[0] && chosen.phases[0].scene) || chosen.route[0] || 'sanctuary';
    $('#qb-hint').textContent = `ตัวละครจะเริ่มที่${SCENES[first].shortLabel} แล้วเดินตามขั้นของคลาสเองจนจบเควสต์`;
    const submit = $('#qb-submit');
    submit.disabled = qb.submitting || classes.status !== 'ok';
    submit.querySelector('span:last-child').textContent = qb.submitting ? 'กำลังส่งเควสต์…' : 'ปักหมุด Quest & ส่งตัวละครออกลุย';
  }

  function renderQbWho() {
    document.querySelectorAll('input[name="qb-launch"]').forEach((r) => {
      r.checked = r.value === qb.launch;
    });
    $('#qb-headless-note').hidden = qb.launch !== 'headless';
    $('#qb-cwd').disabled = qb.launch === 'existing';
  }

  function renderQbExisting() {
    const sel = $('#qb-existing');
    const idle = [...heroes.values()].filter((h) => isIdleSession(h.session));
    if (qb.existingId && !idle.some((h) => h.id === qb.existingId)) qb.existingId = '';
    if (!qb.existingId && idle.length) qb.existingId = idle[0].id;
    const html = idle.length
      ? idle
          .map((h) => `<option value="${esc(h.id)}" ${h.id === qb.existingId ? 'selected' : ''}>${esc(truncate(heroName(h.session), 40))} · ${esc(classInfo(h.classId).titleThai)}</option>`)
          .join('')
      : '<option value="">ไม่มีฮีโร่ที่ว่างอยู่</option>';
    if (sel.innerHTML !== html) sel.innerHTML = html;
    const radio = document.querySelector('input[name="qb-launch"][value="existing"]');
    radio.disabled = !idle.length;
    if (!idle.length && qb.launch === 'existing') {
      qb.launch = 'terminal';
      renderQbWho();
    }
    sel.disabled = !idle.length || qb.launch !== 'existing';
  }

  function renderQbDatalist() {
    const cwds = [...new Set([lsGet(LS_KEYS.cwd), ...[...heroes.values()].map((h) => h.session.cwd)].filter((c) => typeof c === 'string' && c))];
    const html = cwds.slice(0, 30).map((c) => `<option value="${esc(c)}"></option>`).join('');
    const dl = $('#qb-cwd-list');
    if (dl.innerHTML !== html) dl.innerHTML = html;
  }

  async function submitQuest() {
    if (qb.submitting) return;
    if (classes.status !== 'ok') {
      toast('ยังโหลดรายชื่อคลาสไม่สำเร็จ ลองกด "ลองใหม่" ก่อน', 'warn');
      return;
    }
    const goal = $('#qb-goal').value.trim();
    if (!goal) {
      toast('ใส่เป้าหมายของเควสต์ก่อนส่ง', 'warn');
      $('#qb-goal').focus();
      return;
    }
    const chosen = classInfo(qb.heroId);
    const body = { heroClassId: chosen.id, goal };
    const name = $('#qb-name').value.trim();
    if (name) body.name = name;
    if (chosen.option) body.optionValue = qb.optionValue;
    const preset = $('#qb-preset').value.trim();
    if (preset) body.presetPrompt = preset;
    let cwd = '';
    if (qb.launch === 'existing') {
      if (!qb.existingId) {
        toast('เลือกฮีโร่ที่ว่างอยู่ก่อน', 'warn');
        return;
      }
      body.sessionId = qb.existingId;
    } else {
      body.launch = qb.launch;
      cwd = $('#qb-cwd').value.trim();
      if (cwd) body.cwd = cwd;
    }

    qb.submitting = true;
    renderQuestBoard(false);
    const r = await postJson('/api/guild/quests', body);
    qb.submitting = false;
    renderQuestBoard(false);

    if (r.status === 423) {
      toast('พักงานรอ usage reset อยู่ ยังส่งเควสต์ไม่ได้ตอนนี้', 'warn');
      return;
    }
    if (!r.ok) {
      toast(`ส่งเควสต์ไม่สำเร็จ: ${errText(r)}`, 'err');
      return;
    }
    if (cwd) lsSet(LS_KEYS.cwd, cwd);
    const quest = r.data.quest && typeof r.data.quest === 'object' ? r.data.quest : {};
    const sessionId = (r.data.session && r.data.session.id) || quest.sessionId || body.sessionId;
    $('#qb-goal').value = '';
    $('#qb-name').value = '';
    qb.presetEdited = false;
    closeQuestBoard();
    playSfx('warp');
    toast(`ปักหมุดเควสต์ "${textOf(quest.name) || truncate(goal, 30)}" แล้ว ส่ง ${chosen.name} ออกลุย`);
    const plan0 = Array.isArray(quest.plan) && quest.plan[0] ? quest.plan[0].scene : null;
    const first = SCENES[plan0] ? plan0 : (chosen.phases[0] && chosen.phases[0].scene) || chosen.route[0] || 'sanctuary';
    switchScene(first, { keepSelection: true });
    if (typeof sessionId === 'string' && sessionId) requestFocus(sessionId, { questId: quest.id || null, ms: 15000 });
  }

  /* =====================================================================
   * 9. ACTIONS & NAVIGATION
   * ===================================================================== */
  function selectHero(id, { silent = false } = {}) {
    const h = heroes.get(id);
    if (!h) return;
    if (!silent) playSfx('click');
    state.selectedId = id;
    if (h.scene === state.currentScene) focusCamera(h);
    renderHud(true);
  }

  function deselect() {
    if (!state.selectedId) return;
    state.selectedId = null;
    resetCamera();
    renderHud(true);
  }

  function switchScene(sceneId, { keepSelection = false, then = null } = {}) {
    if (!SCENES[sceneId]) return;
    if (state.currentScene === sceneId) {
      if (then) then();
      return;
    }
    playSfx('scene');
    const veil = $('#scene-veil');
    veil.classList.add('active');
    setTimeout(
      () => {
        state.currentScene = sceneId;
        state.hoveredId = null;
        state.hoveredQuestBoard = false;
        if (!keepSelection) state.selectedId = null;
        const sel = state.selectedId && heroes.get(state.selectedId);
        if (sel && sel.scene === sceneId) focusCamera(sel);
        else resetCamera();
        renderHud(true);
        veil.classList.remove('active');
        if (then) then();
      },
      reducedMotion() ? 0 : 150
    );
  }

  function nextWaiting() {
    const list = waitingHeroes();
    if (!list.length) return;
    const i = list.findIndex((h) => h.id === state.selectedId);
    const next = list[(i + 1) % list.length];
    if (next.scene !== state.currentScene) switchScene(next.scene, { keepSelection: true, then: () => selectHero(next.id, { silent: true }) });
    else selectHero(next.id);
  }

  async function withBusy(key, fn) {
    if (state.busy.has(key)) return;
    state.busy.add(key);
    renderDrawer(true);
    try {
      await fn();
    } finally {
      state.busy.delete(key);
      renderDrawer(true);
    }
  }

  function chooseOption(id, index) {
    const h = heroes.get(id);
    const p = h && h.session.interactivePrompt;
    const o = p && Array.isArray(p.options) ? p.options.find((x) => x && String(x.index) === String(index)) : null;
    if (!o) {
      toast('ตัวเลือกนี้ไม่อยู่บนจอแล้ว ลองดูอีกครั้ง', 'warn');
      return;
    }
    return withBusy(`attn:${id}`, async () => {
      const r = await postJson('/api/session/select-option', {
        sessionId: id,
        targetIndex: o.index,
        currentIndex: Number(p.currentIndex) || 1,
        number: o.number,
        label: o.label,
      });
      if (!r.ok) return toast(`เลือกไม่สำเร็จ: ${errText(r)}`, 'err');
      playSfx('approve');
      burstAtHero(h, '#3ee89e', 24);
      toast(cleanMsg(r.data.message) || `เลือก "${textOf(o.label)}" แล้ว`, r.data.delivered === false ? 'warn' : 'ok');
    });
  }

  function approve(id) {
    const h = heroes.get(id);
    return withBusy(`attn:${id}`, async () => {
      const r = await postJson('/api/session/command', { sessionId: id, command: '1', isApproval: true });
      if (!r.ok) return toast(`อนุญาตไม่สำเร็จ: ${errText(r)}`, 'err');
      playSfx('approve');
      if (h) burstAtHero(h, '#3ee89e', 24);
      toast(cleanMsg(r.data.message) || 'อนุญาตแล้ว', r.data.delivered === false ? 'warn' : 'ok');
    });
  }

  function reject(id) {
    return withBusy(`attn:${id}`, async () => {
      const r = await postJson('/api/session/send-key', { sessionId: id, key: 'esc' });
      if (!r.ok) return toast(`ส่ง Esc ไม่สำเร็จ: ${errText(r)}`, 'err');
      playSfx('click');
      toast('ส่ง Esc แล้ว');
    });
  }

  function sendMessage(id, text) {
    const h = heroes.get(id);
    return withBusy(`msg:${id}`, async () => {
      const r = await postJson('/api/session/command', { sessionId: id, command: text });
      if (r.status === 423) return toast('พักงานรอ usage reset อยู่ ข้อความยังไม่ถูกส่ง', 'warn');
      if (!r.ok) return toast(`ส่งข้อความไม่สำเร็จ: ${errText(r)}`, 'err');
      drafts.msg.delete(id);
      const input = $('#cmd-input');
      if (input) input.value = '';
      playSfx('click');
      if (h) burstAtHero(h, SCENES[h.scene].accent, 14);
      toast(cleanMsg(r.data.message) || `ส่งข้อความถึง ${h ? heroName(h.session) : 'ฮีโร่'} แล้ว`, r.data.delivered === false ? 'warn' : 'ok');
    });
  }

  function questAction(questId, action) {
    const h = [...heroes.values()].find((x) => x.view.quest && x.view.quest.id === questId);
    const note = action === 'resume' && h ? (drafts.note.get(h.id) || '').trim() : '';
    return withBusy(`quest:${questId}`, async () => {
      const body = { questId, action };
      if (note) body.note = note.slice(0, 2000);
      const r = await postJson('/api/guild/quest-action', body);
      if (!r.ok) return toast(`${action === 'stop' ? 'หยุดเควสต์' : 'ทำต่อ'}ไม่สำเร็จ: ${errText(r)}`, 'err');
      if (h) drafts.note.delete(h.id);
      playSfx(action === 'stop' ? 'click' : 'warp');
      toast(action === 'stop' ? 'หยุดเควสต์แล้ว งานที่กำลังทำอยู่จะจบรอบนี้เอง' : 'สั่งให้ฮีโร่ทำเควสต์ต่อแล้ว');
    });
  }

  function setPressed(act, on) {
    const b = document.querySelector(`[data-act="${act}"]`);
    if (b) b.setAttribute('aria-pressed', String(on));
  }

  function toggleNavMask() {
    playSfx('click');
    state.showNavMask = !state.showNavMask;
    setPressed('toggle-navmask', state.showNavMask);
    toast(state.showNavMask ? 'แสดงเลเยอร์ 2.5D: เขียว = เดินได้ · แดง = สิ่งกีดขวาง · ทอง = ฉากหน้าบังตัวละคร' : 'ซ่อนเลเยอร์ 2.5D แล้ว');
  }

  function toggleBloom() {
    playSfx('click');
    state.bloomEnabled = !state.bloomEnabled;
    document.body.classList.toggle('bloom-off', !state.bloomEnabled);
    setPressed('toggle-bloom', state.bloomEnabled);
    lsSet(LS_KEYS.bloom, state.bloomEnabled ? 'on' : 'off');
    toast(state.bloomEnabled ? 'เปิดแสงและเบลอ HD-2D แล้ว' : 'ปิดแสงและเบลอ HD-2D แล้ว');
  }

  function toggleSfx() {
    state.sfxEnabled = !state.sfxEnabled;
    if (state.sfxEnabled) {
      unlockAudio();
      playSfx('click');
    }
    setPressed('toggle-sfx', state.sfxEnabled);
    lsSet(LS_KEYS.sfx, state.sfxEnabled ? 'on' : 'off');
    toast(state.sfxEnabled ? 'เปิดเสียง RPG 16-bit แล้ว' : 'ปิดเสียงแล้ว');
  }

  function enterWorld() {
    if (state.entered) return;
    state.entered = true;
    unlockAudio();
    document.body.classList.remove('is-title');
    setHudInert(false);
    const title = $('#title-screen');
    title.classList.add('leaving');
    setTimeout(() => {
      title.hidden = true;
    }, reducedMotion() ? 0 : 520);
    if (document.activeElement && title.contains(document.activeElement)) document.activeElement.blur();
    playSfx('warp');
    resizeCanvas();
    renderHud(true);
    startLoop();
    focusFromHash();
  }

  function setHudInert(on) {
    ['#topbar', '.party-dock', '#drawer', '#portal-left', '#portal-right'].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      if (on) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    });
  }

  /* =====================================================================
   * 10. INPUT EVENTS (delegation only)
   * ===================================================================== */
  const ACTIONS = {
    'enter-world': () => enterWorld(),
    'switch-scene': (el) => switchScene(el.getAttribute('data-scene')),
    portal: (el) => switchScene(el.getAttribute('data-scene')),
    'select-hero': (el, id) => (state.selectedId === id && el.classList.contains('chip-select') ? deselect() : selectHero(id)),
    'close-drawer': () => {
      playSfx('click');
      deselect();
    },
    'drawer-tab': (el) => {
      playSfx('click');
      state.drawerTab = el.getAttribute('data-tab') || 'overview';
      renderDrawer(true);
    },
    'next-waiting': () => nextWaiting(),
    'choose-option': (el, id) => chooseOption(id, el.getAttribute('data-index')),
    approve: (el, id) => approve(id),
    reject: (el, id) => reject(id),
    'quest-stop': (el) => questAction(el.getAttribute('data-quest'), 'stop'),
    'quest-resume': (el) => questAction(el.getAttribute('data-quest'), 'resume'),
    'open-quest-board': (el, id) => openQuestBoard(id),
    'close-quest-board': () => closeQuestBoard(),
    'qb-retry': () => loadClasses(),
    'qb-pick-hero': (el) => {
      playSfx('click');
      qb.heroId = el.getAttribute('data-hero') || qb.heroId;
      qb.optionValue = null;
      renderQuestBoard(true);
    },
    'qb-set-option': (el) => {
      const c = classInfo(qb.heroId);
      const v = c.option && c.option.values[Number(el.getAttribute('data-index'))];
      if (!v) return;
      playSfx('click');
      qb.optionValue = v.value;
      renderQuestBoard(false);
    },
    'qb-reset-preset': () => {
      playSfx('click');
      renderQuestBoard(true);
    },
    'toggle-navmask': () => toggleNavMask(),
    'toggle-bloom': () => toggleBloom(),
    'toggle-sfx': () => toggleSfx(),
  };

  document.addEventListener('click', (e) => {
    if (e.target.closest('a[href]')) return; // links navigate on their own
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = ACTIONS[el.getAttribute('data-act')];
    if (!fn) return;
    e.preventDefault();
    fn(el, el.getAttribute('data-id'));
  });

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.id === 'qb-form') {
      e.preventDefault();
      submitQuest();
    } else if (form.id === 'cmd-form') {
      e.preventDefault();
      const id = form.getAttribute('data-id');
      const input = $('#cmd-input', form);
      const text = input ? input.value.trim() : '';
      if (id && text) sendMessage(id, text);
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'qb-preset') qb.presetEdited = true;
    else if (t.id === 'cmd-input' && state.selectedId) drafts.msg.set(state.selectedId, t.value);
    else if (t.id === 'quest-note' && state.selectedId) drafts.note.set(state.selectedId, t.value);
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'qb-launch') {
      qb.launch = t.value;
      renderQbWho();
      renderQbExisting();
      if (qb.launch === 'headless') $('#qb-headless-note').scrollIntoView({ block: 'nearest' });
    } else if (t.id === 'qb-existing') {
      qb.existingId = t.value;
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    cam.mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
    cam.mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
    const { wx, wy } = screenToWorld(e.clientX, e.clientY);
    state.hoveredQuestBoard = isOverQuestBoard(wx, wy);
    state.hoveredId = heroAt(wx, wy, 64);
    canvas.style.cursor = state.hoveredId || state.hoveredQuestBoard ? 'pointer' : 'default';
  });

  canvas.addEventListener('mouseleave', () => {
    cam.mouseX = 0;
    cam.mouseY = 0;
    state.hoveredId = null;
    state.hoveredQuestBoard = false;
  });

  canvas.addEventListener('click', (e) => {
    if (!state.entered) return;
    const { wx, wy } = screenToWorld(e.clientX, e.clientY);
    const id = heroAt(wx, wy, 66);
    if (id) return selectHero(id);
    if (isOverQuestBoard(wx, wy)) return openQuestBoard();
    if (state.selectedId) {
      playSfx('click');
      deselect();
    }
  });

  function heroAt(wx, wy, radius) {
    const r = radius * Math.max(1, overlayScale() * 0.75); // small heroes on phones get a bigger target
    let best = null;
    let bestD = r;
    for (const h of heroesIn(state.currentScene)) {
      const d = Math.hypot(wx - h.x, wy - (h.y - 30));
      if (d < bestD) {
        best = h.id;
        bestD = d;
      }
    }
    return best;
  }

  function isOverQuestBoard(wx, wy) {
    if (state.currentScene !== 'sanctuary') return false;
    const q = QUEST_BOARD_SPOT;
    const k = overlayScale();
    const overSign = Math.abs(wx - q.x) < 130 * k && wy < q.y - 8 && wy > q.y - 8 - 52 * k;
    return overSign || (Math.abs(wx - q.x) < q.rx && Math.abs(wy - (q.y - 20)) < q.ry + 35);
  }

  window.addEventListener('keydown', (e) => {
    if (!state.entered) return;
    if (e.key === 'Escape') {
      if (qb.open) closeQuestBoard();
      else if (state.selectedId) deselect();
      return;
    }
    const tag = document.activeElement ? document.activeElement.tagName : '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || qb.open || e.ctrlKey || e.metaKey || e.altKey) return;
    const idx = ['1', '2', '3', '4'].indexOf(e.key);
    if (idx >= 0) switchScene(SCENE_ORDER[idx]);
  });

  window.addEventListener('resize', () => {
    resizeCanvas();
    const sel = state.selectedId && heroes.get(state.selectedId);
    if (sel && sel.scene === state.currentScene) focusCamera(sel);
    else resetCamera();
  });

  window.addEventListener('hashchange', () => {
    if (state.entered) focusFromHash();
  });

  /* =====================================================================
   * 11. LOOP & BOOT
   * ===================================================================== */
  let loopRunning = false;
  let lastTs = 0;

  function startLoop() {
    if (loopRunning || !state.entered || document.hidden) return;
    loopRunning = true;
    lastTs = 0;
    requestAnimationFrame(frame);
  }

  function frame(ts) {
    // The loop stops while the tab is hidden; visibilitychange starts it again.
    if (document.hidden || !state.entered) {
      loopRunning = false;
      return;
    }
    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
    lastTs = ts;
    const time = ts / 1000;
    updateSimulation(dt, time);
    renderFrame(time);
    requestAnimationFrame(frame);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) startLoop();
  });

  function boot() {
    hydrateIcons(document);
    document.body.classList.toggle('bloom-off', !state.bloomEnabled);
    setPressed('toggle-bloom', state.bloomEnabled);
    setPressed('toggle-sfx', state.sfxEnabled);
    setHudInert(true);
    resizeCanvas();
    renderHud(true);
    connectSSE();
    loadClasses();
    if (document.fonts && document.fonts.load) {
      ['700 12px "Silkscreen"', '400 12px "Silkscreen"', '600 11px "Figtree"'].forEach((f) => document.fonts.load(f).catch(() => {}));
    }
    const enter = $('.title-enter');
    if (enter) enter.focus();
  }

  boot();
})();
