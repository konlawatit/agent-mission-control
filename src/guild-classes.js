/**
 * Guild Mode hero classes: what each class does phase by phase, and the prompts the quest runner
 * (src/quest-runner.js) sends for each phase. Pure data and string building, no I/O.
 *
 * Classes and preset texts come from the HD-2D guild kit (hd2d-guild.html, HERO_CLASSES).
 */

// Console input submits on a newline, so a phase prompt is one line of parts joined by this.
const SEPARATOR = ' ‖ ';
const MAX_PROMPT_CHARS = 3500;
// When the goal and the preset do not both fit, the preset keeps at least this much.
const PRESET_RESERVE = 600;
const MAX_FAIL_NOTE = 600;
const MAX_RESUME_NOTE = 1200;
const MAX_VERDICT_NOTE = 500;

const SCENE_OF_KIND = { research: 'library', investigate: 'library', fix: 'dungeon', verify: 'camp' };
const PHASE_TITLES = { research: 'ค้นคว้า', investigate: 'สืบหาต้นตอ', fix: 'แก้โค้ด', verify: 'ทดสอบ' };
const SCENE_LABELS = { library: 'ห้องสมุด', dungeon: 'ดันเจียน', camp: 'ค่ายทดสอบ', sanctuary: 'ห้องโถงกิลด์' };

// The kit's depth texts (they go into the researcher's preset).
const DEPTH_PRESET = {
  shallow: 'Quick Scan (ค้นหาเร็วเฉพาะจุดสำคัญ, อ่านเฉพาะไฟล์หลัก)',
  medium: 'Standard Research (วิเคราะห์โครงสร้างโค้ด, dependency และสรุปทางเลือก)',
  deep: 'Deep Dive (เจาะลึกทุกไฟล์ที่เกี่ยวข้อง, trace data flow, edge cases และสรุปรายงานเชิงลึก)',
};

// What the research phase does at each depth; the preset may be edited, this part is not.
const DEPTH_INSTRUCTION = {
  shallow:
    'ค้นคว้าแบบเร็ว (Quick Scan): ดูเฉพาะไฟล์หลักและจุดที่เกี่ยวกับเป้าหมายโดยตรง ตอบให้ตรงประเด็นภายในไม่กี่ขั้น ไม่ต้องไล่ทุกไฟล์',
  medium:
    'ค้นคว้าแบบมาตรฐาน: ไล่โครงสร้างโค้ดส่วนที่เกี่ยวข้อง จุดที่เรียกใช้ และ dependency แล้วสรุปทางเลือกพร้อมข้อดีข้อเสีย',
  deep:
    'ค้นคว้าเชิงลึก (Deep Dive): อ่านทุกไฟล์ที่เกี่ยวข้อง trace data flow ตั้งแต่ต้นทางถึงปลายทาง ตรวจ edge case ความเสี่ยง และจุดที่ยังไม่แน่ใจ',
};

const READ_ONLY = 'ห้ามแก้ไขหรือสร้างไฟล์ใด ๆ (อ่านอย่างเดียว)';
const INVESTIGATE =
  `สืบหาต้นตอของปัญหา (root cause) ${READ_ONLY} ไล่ error path เงื่อนไข และลำดับการทำงานที่ทำให้เกิดปัญหา ` +
  'รันได้เฉพาะคำสั่งที่ไม่เปลี่ยนอะไร (อ่าน log, รันเทสที่มีอยู่) สรุปไฟล์ บรรทัด และสาเหตุ';
const INVESTIGATE_SOLO = `${INVESTIGATE} พร้อมแนวทางแก้ที่แนะนำ`;
const INVESTIGATE_THEN_FIX =
  `${INVESTIGATE} แล้วปิดท้ายด้วยแผนแก้เป็นข้อ ๆ: ไฟล์ที่จะแก้ แก้อะไร และจะทดสอบอย่างไร ` +
  'ขั้นนี้ยังไม่ต้องแก้โค้ด ขั้นถัดไปจะลงมือตามแผนนี้';
const FIX_QUICK =
  'แก้โค้ดให้ได้ตามเป้าหมายด้วย diff ที่เล็กและตรงจุดที่สุด ไม่ refactor หรือแตะส่วนที่ไม่เกี่ยว ' +
  'ไม่ต้องรันชุดทดสอบเต็ม สรุปไฟล์ที่แก้และเหตุผลสั้น ๆ';
const FIX_PLANNED =
  'ลงมือแก้ตามแผนจากขั้นสืบหาต้นตอ diff เล็กและตรงจุด ไม่ refactor หรือแตะส่วนที่ไม่เกี่ยว ' +
  'ขั้นนี้ยังไม่ต้องรันชุดทดสอบเต็ม (ขั้นถัดไปจะทดสอบ) สรุปไฟล์ที่แก้และเหตุผลสั้น ๆ';
const FIX_RETRY =
  'ผลทดสอบรอบก่อนไม่ผ่าน: แก้เฉพาะสิ่งที่ทำให้ไม่ผ่านตามผลด้านล่าง ไม่แก้ส่วนอื่นเพิ่ม ' +
  'ถ้าเห็นว่าตัวทดสอบเองผิดให้อธิบายเหตุผลชัด ๆ ก่อนแก้ สรุปสิ่งที่แก้ในรอบนี้';
const VERIFY =
  'ตรวจว่างานที่แก้ใช้ได้จริง: รันชุดทดสอบ/build/lint ที่เกี่ยวข้องของโปรเจกต์ ' +
  '(หาคำสั่งจาก package.json, Makefile, README หรือ CLAUDE.md) ห้ามแก้โค้ดในขั้นนี้ ' +
  'รายงานคำสั่งที่รันและผลลัพธ์ ถ้าไม่ผ่านให้สรุป error สำคัญพร้อมไฟล์และบรรทัด';

const RULES_COMMON =
  'กติกา: ทำเฉพาะขั้นนี้ อย่าข้ามไปทำขั้นถัดไป · ถ้าต้องเลือกระหว่างทางให้ตัดสินใจเองอย่างสมเหตุสมผลแล้วบอกไว้ในคำตอบ';
const RULES_DONE = 'จบคำตอบด้วยบรรทัด QUEST-VERDICT: DONE';
const RULES_VERIFY =
  'จบคำตอบด้วยบรรทัด QUEST-VERDICT: PASS ถ้าผ่านทั้งหมด หรือ QUEST-VERDICT: FAIL — <สรุปสิ่งที่ไม่ผ่าน> ถ้ามีอะไรไม่ผ่าน';
const RULES_BLOCKED =
  'ถ้าทำต่อไม่ได้เพราะต้องรอข้อมูลหรือการตัดสินใจจากผู้ใช้ อย่าถามกลางทาง ให้จบด้วย QUEST-VERDICT: BLOCKED — <สิ่งที่ต้องการ>';

const HERO_CLASSES = [
  {
    id: 'researcher',
    name: 'Sage Scholar',
    titleThai: 'นักวิจัยเจาะลึก',
    badge: 'Research + ปรับความลึก',
    accent: '#c49bff',
    flowSteps: ['ห้องสมุด', 'ห้องโถงกิลด์'],
    route: ['library', 'sanctuary'],
    phases: ['research'],
    loops: false,
    option: {
      key: 'depth',
      label: 'ระดับความลึกของการค้นคว้า',
      values: [
        { value: 'shallow', label: 'Quick Scan' },
        { value: 'medium', label: 'Standard' },
        { value: 'deep', label: 'Deep Dive' },
      ],
      default: 'medium',
    },
    preset: (depth) =>
      `[ROLE: Deep Researcher | Depth: ${DEPTH_PRESET[depth] || DEPTH_PRESET.medium}]\n` +
      'สำรวจและค้นคว้าข้อมูลในโค้ดเบสตามหัวข้อ Quest โดยไม่แก้ไขไฟล์จริง สรุปเป็นรายงานพร้อมอ้างอิงชื่อไฟล์และบรรทัดที่เกี่ยวข้องอย่างชัดเจน',
  },
  {
    id: 'bug_hunter',
    name: 'Lantern Detective',
    titleThai: 'นักสืบค้นหาบั๊ก',
    badge: 'หาบั๊กอย่างเดียว',
    accent: '#f5b84c',
    flowSteps: ['ห้องสมุด (สืบหาบั๊ก)', 'ห้องโถงกิลด์'],
    route: ['library', 'sanctuary'],
    phases: ['investigate'],
    loops: false,
    option: null,
    preset: () =>
      '[ROLE: Bug Hunter | Mode: Read-Only Root Cause Analysis]\n' +
      'ไล่ Trace หาต้นตอของบั๊ก (Root Cause), จุดที่เกิด race condition หรือ error path โดยห้ามแก้ไขโค้ด สรุปรายชื่อไฟล์ บรรทัด และแนวทางแก้ที่แนะนำ',
  },
  {
    id: 'quick_fix',
    name: 'Shadow Ranger',
    titleThai: 'แก้บั๊กไว (ไม่ Test)',
    badge: 'แก้ไวข้าม Test',
    accent: '#4de8ff',
    flowSteps: ['ดันเจียน (แก้ไว)', 'ห้องโถงกิลด์'],
    route: ['dungeon', 'sanctuary'],
    phases: ['fix'],
    loops: false,
    option: null,
    preset: () =>
      '[ROLE: Rapid Bugfix | Mode: Fast Patch, Skip Test Suite]\n' +
      'ตรงเข้าแก้ไขบั๊กหรือจุดที่ต้องการอย่างรวดเร็วด้วย diff ที่เล็กและปลอดภัยที่สุด ไม่ต้องรันชุดทดสอบเต็มระบบ (Skip Test) เมื่อแก้เสร็จให้สรุปสิ่งที่แก้ทันที',
  },
  {
    id: 'full_slayer',
    name: 'Paladin Architect',
    titleThai: 'หา-แก้-ทดสอบครบ',
    badge: 'ครบวงจร 3 ด่าน',
    accent: '#fae29c',
    flowSteps: ['ห้องสมุด', 'ดันเจียน', 'ค่ายทหาร Test', 'ห้องโถงกิลด์'],
    route: ['library', 'dungeon', 'camp', 'sanctuary'],
    phases: ['investigate', 'fix', 'verify'],
    loops: false,
    option: null,
    preset: () =>
      '[ROLE: Full Bug Slayer | Mode: Investigate → Fix → Verify]\n' +
      '1) สืบหาสาเหตุของปัญหาในโค้ดเบส 2) วางแผนและลงมือแก้โค้ดให้เรียบร้อย 3) รันชุดทดสอบเพื่อยืนยันว่าแก้หายจริงและไม่กระทบส่วนอื่น',
  },
  {
    id: 'qa_loop',
    name: 'Ironclad Artificer',
    titleThai: 'วนลูป Test จนชัวร์',
    badge: 'Fix ⇄ Test Loop',
    accent: '#3ee89e',
    flowSteps: ['ห้องสมุด', 'ดันเจียน ⇄ ค่าย Test (Loop)', 'ห้องโถงกิลด์'],
    route: ['library', 'dungeon', 'camp', 'sanctuary'],
    phases: ['investigate', 'fix', 'verify'],
    loops: true,
    option: {
      key: 'maxLoops',
      label: 'จำนวนรอบวนลูปทดสอบสูงสุด',
      values: [
        { value: 2, label: 'สูงสุด 2 รอบ' },
        { value: 3, label: 'สูงสุด 3 รอบ' },
        { value: 5, label: 'สูงสุด 5 รอบ' },
      ],
      default: 3,
    },
    preset: (maxLoops) => {
      const n = maxLoops || 3;
      return (
        `[ROLE: Ironclad QA Loop | Max Retry Loops: ${n}]\n` +
        `ค้นหาสาเหตุ แก้โค้ด และรัน Test Suite แบบวนลูปอัตโนมัติ: หาก Test ไม่ผ่านให้วิเคราะห์ error แล้ววนกลับไปแก้โค้ดและรัน Test ซ้ำจนกว่าจะผ่าน 100% (สูงสุด ${n} รอบ)`
      );
    },
  },
];

const CLASS_BY_ID = new Map(HERO_CLASSES.map((c) => [c.id, c]));

function getHeroClass(id) {
  return (typeof id === 'string' && CLASS_BY_ID.get(id)) || null;
}

/** The phases a class runs, in order. Phase ids are the kinds (a plan never repeats a kind). */
function planFor(classId) {
  const heroClass = getHeroClass(classId);
  if (!heroClass) return [];
  return heroClass.phases.map((kind) => ({
    id: kind,
    kind,
    scene: SCENE_OF_KIND[kind],
    title: PHASE_TITLES[kind],
  }));
}

/**
 * The option a quest runs with: `{ key, value }`, null for a class without one, or undefined
 * when `raw` is not one of the class's values. Empty means the class default. Values compare as
 * strings, so "3" from a form and 3 from JSON both pick 3.
 */
function resolveOption(heroClass, raw) {
  if (!heroClass || !heroClass.option) return null;
  const { key, values } = heroClass.option;
  if (raw === undefined || raw === null || raw === '') return { key, value: heroClass.option.default };
  const hit = values.find((v) => String(v.value) === String(raw).trim());
  return hit ? { key, value: hit.value } : undefined;
}

/** The class's default preset for an option value (the class default when none is given). */
function presetFor(classId, optionValue) {
  const heroClass = getHeroClass(classId);
  if (!heroClass) return '';
  const option = resolveOption(heroClass, optionValue);
  return heroClass.preset(option ? option.value : undefined);
}

/** `GET /api/guild/classes`: everything the Quest Board shows, no functions. */
function classesForClient() {
  return HERO_CLASSES.map((c) => {
    const presets = {};
    if (c.option) {
      for (const v of c.option.values) presets[String(v.value)] = c.preset(v.value);
    } else {
      presets.default = c.preset();
    }
    return {
      id: c.id,
      name: c.name,
      titleThai: c.titleThai,
      badge: c.badge,
      accent: c.accent,
      flowSteps: [...c.flowSteps],
      route: [...c.route],
      phases: planFor(c.id),
      option: c.option
        ? {
            key: c.option.key,
            label: c.option.label,
            values: c.option.values.map((v) => ({ ...v })),
            default: c.option.default,
          }
        : null,
      presets,
    };
  });
}

/** One line of plain text: line breaks and control characters become spaces. */
function flattenText(value) {
  return String(value ?? '')
    .replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** Cuts to at most `max` characters, ending with "…" when cut (never half of a surrogate pair). */
function clip(text, max) {
  if (text.length <= max) return text;
  if (max <= 1) return '';
  let cut = text.slice(0, max - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

function phaseInstruction(quest, phase, failNote) {
  const multi = Array.isArray(quest.plan) && quest.plan.length > 1;
  switch (phase.kind) {
    case 'research': {
      const depth = quest.option && quest.option.key === 'depth' ? quest.option.value : 'medium';
      return `${DEPTH_INSTRUCTION[depth] || DEPTH_INSTRUCTION.medium} ${READ_ONLY} จบด้วยรายงานสรุปที่อ้างอิงชื่อไฟล์และบรรทัดที่เกี่ยวข้อง`;
    }
    case 'investigate':
      return multi ? INVESTIGATE_THEN_FIX : INVESTIGATE_SOLO;
    case 'fix':
      if (failNote) return FIX_RETRY;
      return multi ? FIX_PLANNED : FIX_QUICK;
    case 'verify':
      return VERIFY;
    default:
      return '';
  }
}

/**
 * The prompt for one phase, as a single line of at most MAX_PROMPT_CHARS:
 *   [↻ ทำต่อ… ‖] ⚔️ Quest "<name>" · ขั้น i/n <title> (<scene>)[ · รอบ l/m] — เป้าหมาย: <goal>
 *   ‖ บทบาท: <preset> ‖ สิ่งที่ต้องทำในขั้นนี้: <instruction>[ ‖ ผลทดสอบรอบก่อน: <note>] ‖ กติกา: …
 * The goal and the preset share what is left after the fixed parts; the goal goes first.
 * `failNote` (a fix phase after a failed verify), `resume` and `note` (the person's message on
 * "ทำต่อ") are optional.
 */
function buildPhasePrompt({ quest, phase = null, failNote = null, resume = false, note = null } = {}) {
  const plan = Array.isArray(quest.plan) ? quest.plan : [];
  let index = phase ? plan.findIndex((p) => p.id === phase.id) : quest.phaseIndex;
  if (!(index >= 0 && index < plan.length)) index = 0;
  const current = phase || plan[index];
  const isVerify = current.kind === 'verify';
  const fail = current.kind === 'fix' && failNote ? clip(flattenText(failNote), MAX_FAIL_NOTE) : '';

  const loopPart =
    quest.maxLoops > 1 && (current.kind === 'fix' || isVerify) ? ` · รอบ ${quest.loop}/${quest.maxLoops}` : '';
  const head =
    `⚔️ Quest "${flattenText(quest.name)}" · ขั้น ${index + 1}/${plan.length} ${current.title} ` +
    `(${SCENE_LABELS[current.scene] || current.scene})${loopPart} — เป้าหมาย: `;
  const instruction = `สิ่งที่ต้องทำในขั้นนี้: ${phaseInstruction(quest, current, fail)}`;
  const rules = `${RULES_COMMON} · ${isVerify ? RULES_VERIFY : RULES_DONE} ; ${RULES_BLOCKED}`;
  const userNote = note ? `ข้อความจากผู้ใช้: ${clip(flattenText(note), MAX_RESUME_NOTE)}` : '';
  const prefix = resume ? `↻ ทำต่อจากที่ค้างไว้${userNote ? ` — ${userNote}` : ''}` : userNote;

  const assemble = (goal, preset) =>
    [
      prefix,
      `${head}${goal}`,
      `บทบาท: ${preset}`,
      instruction,
      fail ? `ผลทดสอบรอบก่อน: ${fail}` : '',
      rules,
    ]
      .filter(Boolean)
      .join(SEPARATOR);

  const goal = flattenText(quest.goal);
  const preset = flattenText(quest.presetPrompt);
  const room = Math.max(0, MAX_PROMPT_CHARS - assemble('', '').length);
  const goalMax = Math.max(room - Math.min(preset.length, PRESET_RESERVE), Math.floor(room / 2));
  const goalOut = clip(goal, goalMax);
  const presetOut = clip(preset, Math.max(0, room - goalOut.length));
  return assemble(goalOut, presetOut);
}

/** The one follow-up for a verify turn that ended without a verdict line. */
function buildProbePrompt() {
  return (
    'ตอบบรรทัดเดียว QUEST-VERDICT: PASS หรือ QUEST-VERDICT: FAIL — <สรุปสั้น ๆ ว่าอะไรไม่ผ่าน> ' +
    'ตามผลทดสอบล่าสุดของขั้นนี้ (ไม่ต้องรันอะไรเพิ่มและไม่ต้องแก้โค้ด)'
  );
}

// Markdown backticks/bold around the marker, the colon or the verdict are tolerated.
const VERDICT_RE = /^QUEST-VERDICT[`*_]*\s*:\s*[`*_]*\s*(PASS|FAIL|DONE|BLOCKED)\b[`*_]*\s*[—–:-]?\s*(.*)$/i;

/**
 * The verdict Claude ended a phase with: the last `QUEST-VERDICT: <KIND> [— note]` in the text
 * → `{ kind, note }` (kind upper-case, note '' when none), or null.
 */
function parseVerdict(text) {
  if (typeof text !== 'string' || !text) return null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const upper = line.toUpperCase();
    // The last marker on the line wins too; an earlier one may be Claude quoting the rule.
    for (let at = upper.lastIndexOf('QUEST-VERDICT'); at >= 0; at = at > 0 ? upper.lastIndexOf('QUEST-VERDICT', at - 1) : -1) {
      const m = VERDICT_RE.exec(line.slice(at));
      if (!m) continue;
      const note = m[2].replace(/^[\s`*]+|[\s`*]+$/g, '');
      return { kind: m[1].toUpperCase(), note: clip(note, MAX_VERDICT_NOTE) };
    }
  }
  return null;
}

module.exports = {
  HERO_CLASSES,
  SCENE_LABELS,
  PHASE_TITLES,
  MAX_PROMPT_CHARS,
  getHeroClass,
  planFor,
  resolveOption,
  presetFor,
  classesForClient,
  flattenText,
  buildPhasePrompt,
  buildProbePrompt,
  parseVerdict,
};
