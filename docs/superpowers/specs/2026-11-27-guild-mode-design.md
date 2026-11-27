# Guild Mode: a game-world tab where characters run quests in a loop

Date: 2026-11-27 · Branch: `feat/guild-mode` · Source kit: `../agent-mission-control-hd2d-kit`

## Why

The dashboard today is a chat-style control room: you ask, Claude answers, you ask again. The
user wants a second way to work: state a goal, pick a character, and let that character run its
own process (research → fix → test, looping when tests fail) without being prompted turn by turn.
It should feel like a game (the HD-2D guild kit), while the chat side keeps working as before.
Both sides see every session; they only display them differently.

The user handed every decision to Claude ("ทุกการตัดสินใจนายตัดสินใจได้เลย"). Everything
below marked **call** is Claude's decision, open for the user to revisit.

## Goals

- A sidebar entry in the chat dashboard, "โลกกิลด์", that takes you into the game world.
- The game world shows **every live session** as a character, live from the same SSE stream.
  A session started in the chat or a terminal appears in the game; a quest started in the game
  appears in the chat as an ordinary room.
- A **Quest Board** in the game: write a goal, choose one of five character classes, tune its
  option (research depth or max test loops), edit its preset prompt, and send it out.
- A server-side **quest runner** that drives the character's process: it sends one prompt per
  phase, waits for the turn to finish (Stop hook), reads a verdict line, and moves on, loops
  back, pauses, or finishes. The character's scene in the game follows the phase.
- Approve permission prompts, answer simple choices, and send a message to a session from the
  game, using the APIs the chat already uses.

## Non-goals

- No new transport to Claude: quests use the existing command bridge (console input, WezTerm,
  headless `--resume`).
- No enforcement of "read-only" phases beyond the prompt (Claude Code's permission mode is not
  changed mid-session).
- No world map / overworld navigation (the `overworld_town.jpg` is used only on the title screen).
- No answering AskUserQuestion's multi-question review flow inside the game: the drawer links to
  the room in the chat for that.

## Anti-goals (would make this a failure even if it works)

- Any runtime request to the internet (CDN Tailwind, lucide, Google Fonts). The app is
  localhost-only and zero-dependency; the game must be too.
- Inline JS handlers or unescaped session text in the game page (the project's XSS rules apply).
- Anything user-typed reaching a shell. Prompts go through `bridge.dispatchCommand` only.
- Breaking or slowing the chat dashboard: it keeps its behaviour; the game is a separate page
  whose animation loop only runs while that page is open.
- A notification on every phase boundary of a quest.

## Approaches considered

1. **One big prompt** (call it "self-looping"): put the whole process in the first prompt and let
   Claude loop by itself. Cheapest, but the server cannot see which phase it is in (scene would
   be guessed from tool names), cannot cap loops, cannot pause on a blocked step. Rejected: the
   user asked for a loop that follows the character's process.
2. **Server-driven phases (chosen)**: the server owns a small state machine per quest and sends
   one prompt per phase over the existing bridge; the Stop hook ends a phase; a
   `QUEST-VERDICT:` line decides what comes next. Scenes, loop counts and pauses are exact.
3. **Agent SDK / `claude -p` only**: fully headless, no terminal. Rejected as the only mode
   because headless runs cannot answer permission prompts; kept as an opt-in launch option.

## Architecture

```
public/guild.html ──SSE /api/events──┐            ┌── public/index.html (chat)
public/guild.js                      │            │   + nav item "โลกกิลด์" → /guild
  GET /api/guild/classes             ▼            │   + quest badge on rooms
  GET/POST /api/guild/quests     src/server.js ◄──┘   + #room=<id> deep link
  POST /api/guild/quest-action       │
                                      ▼
                              src/quest-runner.js ── listens to store 'change' (hook_event)
                                      │               └ dispatches via CommandBridge
                              src/guild-classes.js (classes, phases, prompt builders)
```

### Files

| File | What |
|---|---|
| `src/guild-classes.js` | Hero classes, phase plans, preset prompts, phase prompt builder, verdict parser. Pure, no I/O. |
| `src/quest-runner.js` | `QuestRunner`: quest records, state machine, persistence (`<dataDir>/guild-quests.json`), mirrors a compact `quest` onto the session. |
| `src/server.js` | Routes below; `/guild` page with the token meta; `.jpg` MIME; wires the runner. |
| `src/state-store.js` | `hook_event` change detail also carries `lastAssistantMessage` (full text when the payload has it). |
| `src/command-bridge.js` | Headless: remember `session_id` from stream-json so later phases `--resume`; pass full `result` text as `last_assistant_message`; optional `permissionMode: 'acceptEdits'` for quest headless runs (whitelisted constant). |
| `public/guild.html`, `public/guild.css`, `public/guild.js` | The game page, ported from the kit, no external requests. |
| `public/guild-assets/**` | Kit images (backgrounds, portraits, sprites, overworld for the title screen). |
| `public/app.js`, `public/index.html` | Nav item, quest badge, `#room=` deep link, quest-aware notifications. |
| `test/guild.test.js` | Classes, verdict parser, runner state machine with fakes, HTTP routes. Added to `npm test`. |

## Hero classes (from the kit) and their phase plans

Phase kinds and their scene:

| kind | scene | meaning |
|---|---|---|
| `research` | `library` | Read-only research to the chosen depth, ends with a report. |
| `investigate` | `library` | Read-only root-cause hunt; for multi-phase classes also plans the fix. |
| `fix` | `dungeon` | Change the code. After a failed verify, fix what failed. |
| `verify` | `camp` | Run the relevant tests/build/lint; verdict PASS or FAIL. |

Finished quests (done/failed/stopped) show in `sanctuary`.

| id | name · Thai | option | phases | on verify FAIL |
|---|---|---|---|---|
| `researcher` | Sage Scholar · นักวิจัยเจาะลึก | `depth`: shallow/medium/deep (default medium) | research | – |
| `bug_hunter` | Lantern Detective · นักสืบค้นหาบั๊ก | – | investigate | – |
| `quick_fix` | Shadow Ranger · แก้บั๊กไว (ไม่ Test) | – | fix | – |
| `full_slayer` | Paladin Architect · หา-แก้-ทดสอบครบ | – | investigate, fix, verify | quest ends `failed` |
| `qa_loop` | Ironclad Artificer · วนลูป Test จนชัวร์ | `maxLoops`: 2/3/5 (default 3) | investigate, fix, verify | back to `fix` while `loop < maxLoops`, else `failed` |

Preset prompts: the kit's `buildPresetPrompt` texts, kept in Thai. The user may edit the preset
in the Quest Board; the edited text is stored on the quest and used for every phase.

### Phase prompt (sent to Claude)

One line (console input submits on newline, so the builder joins parts with ` ‖ ` and strips
`\r\n`), at most ~3,500 characters, in this order:

```
⚔️ Quest "<name>" · ขั้น <i>/<n> <phase title> (<scene label>)[ · รอบ <loop>/<maxLoops>] — เป้าหมาย: <goal>
‖ บทบาท: <preset prompt, flattened>
‖ สิ่งที่ต้องทำในขั้นนี้: <phase instruction>[ ‖ ผลทดสอบรอบก่อน: <last FAIL note>]
‖ กติกา: ทำเฉพาะขั้นนี้ ... จบคำตอบด้วยบรรทัด QUEST-VERDICT: ... ; ถ้าทำต่อไม่ได้เพราะต้องรอข้อมูลหรือการตัดสินใจจากผู้ใช้ ให้จบด้วย QUEST-VERDICT: BLOCKED — <สิ่งที่ต้องการ>
```

Verdict lines Claude is asked to end with: `verify` → `QUEST-VERDICT: PASS` or
`QUEST-VERDICT: FAIL — <สรุป>`; every other phase → `QUEST-VERDICT: DONE`.

`parseVerdict(text)` takes the **last** line matching `/QUEST-VERDICT:\s*(PASS|FAIL|DONE|BLOCKED)\b\s*[—–:-]?\s*(.*)/i`
anywhere in the text (Markdown backticks/bold around it are ignored) → `{ kind, note }` or `null`.

## Quest runner

### Record (persisted, `GET /api/guild/quests`)

```js
{
  id: 'quest-<base36 time>-<rand4>',
  sessionId,            // the room's id in the store
  name, heroClassId, goal,
  option: { key: 'depth'|'maxLoops', value } | null,
  presetPrompt,         // as sent (edited or default)
  launch: 'terminal' | 'headless' | 'existing',
  plan: [{ id, kind, scene, title }],
  phaseIndex,           // 0-based index into plan
  loop, maxLoops,       // loop starts at 1; maxLoops = 1 unless qa_loop
  state: 'launching' | 'running' | 'paused' | 'stalled' | 'done' | 'failed' | 'stopped',
  stateReason,          // Thai sentence for paused/stalled/failed/stopped, else null
  awaitingTurn,         // true between a dispatch and the Stop that ends it
  probeSent,            // a verify turn without a verdict got one follow-up asking for it
  lastVerdict: { kind, note } | null,
  log: [{ at, text, level: 'info'|'success'|'warn'|'error' }],   // newest last, max 60
  createdAt, updatedAt, finishedAt
}
```

### Mirror on the session (in every SSE snapshot, read by both pages)

`session.quest` (set with `store.updateSession`, so it persists with the room):

```js
{
  id, name, heroClassId, heroName, goal,
  state, stateReason,
  phaseIndex, phaseCount, phase: { id, kind, scene, title } | null,
  loop, maxLoops,
  scene,                // phase scene while launching/running/paused/stalled, 'sanctuary' when finished
  log: [...last 8 log entries],
  updatedAt
}
```

### Transitions

- **Create (terminal)**: create the room exactly like `/api/session/spawn` with `openTerminal`
  and `autoRunClaude`; state `launching`. When a `SessionStart` hook event arrives for that
  room, wait 1.5 s, then dispatch phase 1. If none arrives in 90 s → `stalled`
  ("เปิด Claude ใน terminal ไม่สำเร็จ…").
- **Create (headless)**: create the room, dispatch phase 1 at once with
  `{ runHeadless: true, permissionMode: 'acceptEdits' }`; later phases the same.
- **Create (existing)**: `sessionId` given; the room must be live and not `working`/`needs_input`
  (409 otherwise) and must not have a quest in `launching`/`running` (409). Dispatch phase 1 now.
- **Dispatch**: if `usageGuard.isHolding()` → `paused` ("พักงานรอ usage reset"). Otherwise
  `bridge.dispatchCommand(sessionId, prompt, { runHeadless, permissionMode })`. `delivered:false`
  → `stalled` with the bridge's message. Else `running`, `awaitingTurn = true`.
- **Stop** (`hook_event` with `hookEvent === 'Stop'` for the quest's room, `awaitingTurn` true):
  `awaitingTurn = false`; text = `detail.lastAssistantMessage` → else transcript
  `parseTranscriptTail(...).lastAssistantFullText` → else `session.tldr`; parse verdict:
  - `BLOCKED` → `paused` with the note.
  - `verify` + `PASS` → next phase or `done`.
  - `verify` + `FAIL` → `qa_loop` with `loop < maxLoops`: `loop += 1`, go to the `fix` phase,
    carry the note into the prompt; otherwise `failed` with the note.
  - `verify` + no verdict → if `!probeSent`: send one short probe ("ตอบบรรทัดเดียว QUEST-VERDICT:
    PASS หรือ FAIL — …"), `probeSent = true`; else `paused` ("ไม่ได้รับผลทดสอบ").
  - any other phase (DONE or no verdict) → next phase, or `done` after the last one.
  - Moving to the next phase resets `probeSent`, dispatches after 800 ms.
  - Stops while `awaitingTurn` is false are ignored (a second Stop from a headless close, or a
    turn the person started by hand).
- **SessionEnd** for the room while launching/running → `stalled` ("ปิด terminal ไปแล้ว…").
- **Room archived/removed** (`session_archived`/`session_removed`) → `stopped`.
- **Actions** (`POST /api/guild/quest-action`):
  - `stop`: any active state → `stopped` ("หยุดโดยผู้ใช้ งานที่กำลังทำอยู่จะจบรอบนี้เอง"); no
    keys are sent to the terminal.
  - `resume`: from `paused`/`stalled`: if the room is `working`, set `running` +
    `awaitingTurn` and let its Stop continue; else re-dispatch the current phase with a
    "ทำต่อจากที่ค้างไว้" prefix and the optional `note` from the body (max 2,000 chars).
- Every transition appends a Thai log line and updates the mirror.
- Load on start: quests whose room no longer exists become `stopped`; mirrors are re-applied.
- Persistence: write `guild-quests.json` (debounced ~300 ms; flush on server close); keep the
  newest 200 quests.

## HTTP API

All under the existing token + Host/Origin checks.

- `GET /guild`, `GET /guild.html` → `public/guild.html` with `<meta name="amc-token">` injected
  (same as `serveIndex`), `Cache-Control: no-store`.
- `GET /api/guild/classes` →
  `{ ok, classes: [{ id, name, titleThai, badge, accent, flowSteps: [Thai labels], route: [scenes],
     phases: [{ id, kind, scene, title }], option: null | { key, label, values: [{ value, label }], default },
     presets: { [optionValue or 'default']: string } }] }`
- `GET /api/guild/quests` → `{ ok, quests: [record…] }` newest first, max 50.
- `POST /api/guild/quests` body
  `{ heroClassId, goal, name?, cwd?, optionValue?, presetPrompt?, sessionId?, launch?: 'terminal'|'headless' }`
  → `{ ok, quest, session }`. Validation: known `heroClassId`; `goal` 1–4,000 chars; `name`
  ≤ 80 (default: first words of the goal); `presetPrompt` ≤ 4,000; `optionValue` must be one of
  the class's values; `cwd` through `safeDirectory` (400 if missing). 423 while the usage guard
  holds. 409 rules above.
- `POST /api/guild/quest-action` body `{ questId, action: 'stop'|'resume', note? }` →
  `{ ok, quest }`; 404 unknown quest; 409 when the action does not apply to the state.

## The game page (`/guild`)

Ported from `source/hd2d-guild.html` of the kit: the canvas renderer (four painted scenes,
Y-sorted occluders, walk polygons and obstacles, perspective scale, mouse parallax, tilt-shift
DOF, bloom/lights, particles, Bug Golem boss, healing beams, floating text, 16-bit SFX), HUD
(top bar, scene switcher with counts, portals, party strip, inspector drawer, Quest Board modal,
toast). What changes:

- **Title screen** ("กดเพื่อเข้าสู่โลกกิลด์") over `overworld_town.jpg`; the click also unlocks
  audio. A "กลับ Mission Control" button is always in the top bar (→ `/`).
- **Live data instead of mock rooms**: token from the meta tag; `EventSource('/api/events?token=…')`
  (`{ type, snapshot }` messages, `snapshot.sessions`); live rooms only
  (`lifecycle !== 'history'`). Animation state (x, y, target, walk phase, spots) is kept per
  session id across snapshots. Sessions that vanish leave with a burst.
- **Class for each session**: `session.quest.heroClassId` when present; otherwise a stable hash of
  the session id picks one of the five classes ("ฮีโร่อิสระ" — not on a quest).
- **Scene for each session**: quest → `session.quest.scene`; otherwise from the room:
  `stageIndex` 0 → library, 1 → dungeon, 2 → camp, 3 or idle/done → sanctuary; `status ===
  'working'` with `stageIndex` 3 → library. `needs_input` keeps the scene and shows a "!" bubble
  and a pulsing ring; the top bar shows a count of waiting heroes and clicking it jumps to the next.
- **Transitions**: when a hero's scene changes between snapshots: warp SFX, bursts, toast in
  Thai. When `quest.loop` grows: `loop_retry` SFX + toast. When a quest becomes `done`/`failed`:
  done SFX/toast.
- **Progress**: quest → phase progress (`phaseIndex / phaseCount`, loop shown); otherwise stage.
  While working an indeterminate shimmer moves, no fake percentage.
- **Inspector drawer** for the selected hero: name, class, cwd/branch, status label, goal, TL;DR,
  the newest Claude reply in full (taken from the snapshot's transcript `screenPreview`, verdict
  line removed, folded past 8 lines with a "ดูข้อความทั้งหมด" toggle; the TL;DR is hidden when it is
  only the start of that reply, and no reply is shown when a newer prompt has none yet),
  quest timeline (phases with current one marked, loop n/max, state + reason, last log lines),
  current tool, sub-agents, modified files, and actions:
  - pending permission/choice: buttons from `session.interactivePrompt.options` →
    `POST /api/session/select-option { sessionId, targetIndex, currentIndex, number, label }`;
    a bare `pendingAction` → Approve = `POST /api/session/command { sessionId, command: '1', isApproval: true }`.
    AskUserQuestion (`session.pendingAsk` or a prompt with `questions`) → "ตอบในหน้าแชท" link.
  - a message box → `POST /api/session/command { sessionId, command }` (423 → hold toast).
  - quest: "หยุดเควสต์" / "ทำต่อ" (+ optional note) → `/api/guild/quest-action`.
  - "เปิดในหน้าแชท" → `/#room=<id>`.
- **Quest Board** (button in the top bar and the desk hotspot in the sanctuary): class cards
  (portrait, name, badge, flow steps) from `/api/guild/classes`; option control; preset textarea
  that follows the option until the user edits it (reset button); goal (required); name; cwd
  with a `<datalist>` of cwds from live sessions (default: last used, else the selected hero's);
  "ให้ใคร": new hero in Windows Terminal (default) / new hero in background (headless, with the
  permission note) / an existing idle hero (select of live rooms that are idle/done and have no
  running quest). Submit → `POST /api/guild/quests`, close, switch to the first scene, select the hero.
- **No external requests**: no Tailwind/lucide/Google Fonts. Styles are hand-written in
  `guild.css` (keep the kit's look: dark navy HUD panels with gold borders, pixel title font).
  Icons are inline SVG. Fonts: the project's Figtree/system stack for Thai text, a system
  monospace stack for code, and the pixel look for titles (`Silkscreen` vendored under
  `public/fonts/` with its OFL licence if it can be fetched once at build time; else uppercase
  monospace with letter-spacing).
- **Safety**: all session text escaped; event delegation (`data-act`), no inline handlers;
  only same-origin requests with the `X-AMC-Token` header.
- **Comfort**: `prefers-reduced-motion` turns off parallax, particles and camera easing; SFX
  toggle and bloom toggle persist in `localStorage` (wrapped in try/catch); the 2.5D debug-layer
  button stays. The animation loop pauses while `document.hidden`. Works at phone width (HUD
  stacks, drawer becomes a bottom sheet).

## Chat dashboard changes

- Sidebar: nav item "โลกกิลด์" (sword icon) → `location.href = '/guild'`.
- Room card and room header: a small quest chip when `session.quest` exists, e.g.
  "⚔ Ironclad · ขั้น 3/3 ทดสอบ · รอบ 2/3" or "⚔ Quest สำเร็จ" / "⚔ Quest หยุดรอคุณ".
- `#room=<id>` in the URL selects that room on load and on `hashchange`.
- Notifications: a room whose `quest.state` is `running`/`launching` does not ring "done" at
  phase boundaries; a quest reaching `done`/`failed`/`paused`/`stalled` rings once
  (`kind: 'done'` for done/failed, `'attn'` for paused/stalled). `notifyTransitions` stays pure
  and is covered in `test/notify.test.js`.

## Testing

- `test/guild.test.js` (new, in `npm test`): class plans and presets; `buildPhasePrompt` is one
  line, contains goal/preset/verdict rule, carries the FAIL note into a loop-back fix;
  `parseVerdict` cases (last line wins, backticks/bold, Thai notes, none); runner with a fake
  store (EventEmitter) and fake bridge: SessionStart → dispatch; Stop → advance; verify FAIL
  loops until `maxLoops` then `failed`; PASS → `done`; BLOCKED → `paused` then `resume`;
  missing verdict → one probe then `paused`; second Stop ignored; usage hold → `paused`;
  `stop`; SessionEnd → `stalled`; persistence round-trip. HTTP: `/guild` has the token meta,
  `.jpg` served with `image/jpeg`, classes endpoint, create validation (400/404/409/423).
- `test/notify.test.js`: the quest rules above.
- `test/verify.js`: `<style>`/CSS brace balance for `guild.css` too.
- UI: headless Chrome over CDP with a seeded fixture server (see memory note
  `ui-review-headless-fixture`): title screen, each scene with heroes, drawer, Quest Board, phone
  width. Never click launch buttons that start a real `claude`.

## Left to the builder

Exact Thai copy of phase instructions, CSS details, sprite animation timings, and how the kit's
mock-only flourishes (boss HP) are driven, as long as they are honest (no fake progress numbers).
