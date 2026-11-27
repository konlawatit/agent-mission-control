# Parked Work (งานค้าง) — Design

Date: 2026-11-27 · Branch: on top of `feat/guild-mode` (the build the user runs today)

## Intent

The user wants to put a room down for now, closing it both in the dashboard and in its
terminal, and pick it up later with one click. When they come back, it should read as
unfinished work they need to carry on, not as an old closed room. "Not every room is like
that", so parked rooms get their own tab and must not mix with History.

## What exists today

- A terminal that closes sends `SessionEnd`. The room moves to History (`lifecycle: 'history'`,
  `status: 'closed'`, label "ปิด Tab ไปแล้ว • กู้คืนได้"). "เปิดต่อ" opens a Windows Terminal tab
  running `claude --resume <id>` in the room's folder (`POST /api/session/resume`). This restores
  the whole conversation.
- "เก็บเข้าประวัติ" archives a live room without closing its terminal (`archivedAt` set). New
  activity from that session brings it back.
- History mixes finished and unfinished rooms. "ล้างประวัติที่ไม่ได้ปักหมุด" deletes every
  unpinned History room.
- The only record of where a room got to is the 220-character TL;DR.
- Claude Code deletes transcripts that have had no activity for `cleanupPeriodDays`. That is
  30 by default, and the user has not set it. After that, `--resume` cannot restore the room.

## Goals

1. One action, **พักงาน**, saves where the room got to, ends its Claude session, closes its
   terminal tab where that can be done safely, and moves the room to a new **งานค้าง** tab.
2. The งานค้าง tab lists only parked rooms. Each one shows what the work is, where it stopped,
   the user's note, and when it can still be resumed.
3. **ทำต่อ** resumes the same Claude session in a terminal, in one click.
4. History no longer shows parked rooms, and clearing History never deletes them.

## Non-goals

- Asking Claude to write a handoff note before closing. The user chose option A: only data the
  dashboard already has, plus the user's own note.
- Showing parked work in the guild page. Parked rooms stay hidden there, like History rooms.
- Keeping transcripts alive past Claude's cleanup by touching their files. The page only warns.
- Starting a new session automatically from the note once the transcript is gone. The page
  offers "คัดลอกบันทึก" instead.
- A git status snapshot (uncommitted files). It could come later.

## Anti-goals

- A parked room must never be lost by clearing History, by deduplication or merging, or by a
  server restart.
- The `/exit` the dashboard types must never become the room's goal, a turn in its history, or a
  "รับคำสั่งใหม่" TL;DR.
- The dashboard must never type `exit` into a shell that has other work on it (see Closing the
  terminal).
- Parking must not silently drop a running turn. A working room waits for its turn to end unless
  the user explicitly chooses to stop now.

## Approaches considered

1. **A `parked` record on the existing room; `lifecycle` stays `'history'` once closed.** This
   was chosen. Every closed-room behaviour comes for free: no notifications, the resume button,
   the background `claude --resume` composer, and the scanner's revive rules. The views only
   filter on `parked`.
2. A third lifecycle value, `'parked'`. The meaning is clearer, but dozens of checks of the form
   `lifecycle !== 'history'` (app.js, notify, store, guild) would treat it as live. The
   regression risk is high.
3. A separate parked-work store file that references room ids. It duplicates room data and
   needs syncing. It would only help if a room could vanish, and the anti-goals already rule
   that out.

The user picked option A for what to save (no Claude-written handoff) and asked for a dedicated
tab. The how was left to Claude, who chose approach 1.

## Design

### Data: `session.parked`

Set when the user confirms พักงาน. It is persisted with the room in `sessions-state.json`, which
already saves whole session objects.

```js
parked: {
  at: ISO,                 // when the user parked it
  note: string,            // optional, ≤ 1000 chars, what the user wants to remember
  goal: string,            // quest goal if on a quest, else session.goal
  lastReply: string,       // newest Claude reply in full (transcript lastAssistantFullText,
                           // else the last 🤖 entry of screenPreview); QUEST-VERDICT lines removed; ≤ 8000 chars
  tldr: string,            // session.tldr at that moment
  branch, cwd, model,      // copied
  stageIndex: number,
  files: string[],         // modifiedFiles paths, ≤ 40
  quest: { name, state, phaseTitle } | null,
  claudeSessionId: string, // what --resume needs (the room id, or claudeSessionId for headless)
  draft: string,           // text that was in Claude's input box (typed, or put back after an
                           // interrupt) when the dashboard closed it; shown on the card, never lost
  closing: 'pending' | 'waiting-turn' | 'closed' | 'tab-left-open' | 'not-connected' | 'failed'
         | 'interrupted' | 'resuming',
  closeMessage: string,    // Thai, shown on the card, e.g. "ปิด Claude แล้ว แท็บ terminal ปิดเองได้เลย"
}
```

### Park flow (server: `POST /api/session/park { sessionId, note, now?: boolean }`)

1. Validate: the room exists and is not already parked. The note is a string ≤ 1000 characters.
   Return 409 if parked.
2. Build the snapshot. If the room is **live**:
   - **Working**, `now` not set: set `closing: 'waiting-turn'`. The room stays live and shows
     the card "จะพักเมื่อรอบนี้จบ" with a cancel button. When `Stop` arrives, refresh the
     snapshot (the reply is now final) and close.
   - **Working** with `now: true`, or **waiting on a permission or question**: send Esc first.
     That interrupts the turn or denies the prompt, and the dialog says so. Then close.
   - **Idle or done**: close now.
3. **Close** = end Claude, then close the tab:
   - Type `/exit` through the low-level transport: console `sendText` + Enter, WezTerm
     `send-text`, or the `amc run` wrapper queue. Do not use `dispatchCommand`/`recordSentPrompt`,
     which would make `/exit` a turn (anti-goal).
   - Wait up to 15 s for `SessionEnd` from that session. If it doesn't come, check that the pid
     is gone.
   - **Closing the tab after Claude has ended:**
     - Windows console: the scan's `consolePids` for that console, taken before `/exit`, minus
       Claude's own pid. If what is left is exactly one process and it is a shell
       (`powershell.exe`, `pwsh.exe`, `cmd.exe`, `bash.exe`), type `exit` + Enter into it. Windows
       Terminal closes the tab when the shell exits 0. Otherwise set `closing: 'tab-left-open'`.
     - WezTerm: `wezterm cli kill-pane --pane-id <paneId>`.
     - The `amc run` wrapper exits with Claude. Headless rooms have no tab.
   - No terminal link (no pid, pane or wrapper), or the transport fails: set
     `closing: 'not-connected'` or `'failed'` and archive the room
     (`archiveOrRemoveSession(id, false)`). The message tells the user to close the tab
     themselves.
4. In every path the room ends in `lifecycle: 'history'` with `parked` set. Emit
   `session_parked`.
5. If the room is already in History, that is "ย้ายไปงานค้าง". It only records the snapshot
   when its process is gone. When the process is still alive, it runs the close sequence (see
   decision 5 below).

Other endpoints:
- `POST /api/session/park-cancel`: only while `closing: 'waiting-turn'`. It removes `parked`.
- `POST /api/session/park-note { sessionId, note }`: edit the note.
- `POST /api/session/unpark { sessionId }`: "เสร็จแล้ว / ย้ายไปประวัติ". It removes `parked`, so
  the room becomes ordinary History.

All of these take only `sessionId`, `note` and `now`. Nothing from the body reaches a shell. The
only strings ever typed are the fixed `/exit` and `exit`.

### Unparking automatically

When a parked room is **confirmed** live again, its `parked` record is removed and a timeline
entry "กลับมาทำต่อจากงานค้าง: <note>" is pushed. "Confirmed" means one of these:
- SessionStart or a new prompt arrives from the session
- the scanner sees its process
- it is the survivor of a `session_merged` from a resumed session

Clicking ทำต่อ alone does not unpark. It sets `closing: 'resuming'` and opens the terminal, and
the room stays in History until one of the signals above. If none comes within 90 s, or the
launch fails, the room goes back to its parked state with the message "เปิดต่อไม่สำเร็จ ลองอีกครั้ง".
This replaces today's `openTerminalTab` habit of setting `lifecycle: 'live'` up front, but only
for parked rooms.

While `closing: 'waiting-turn'`, the room is live by design and keeps its record.

### Decisions from the builder check (Claude's calls)

1. **Text in Claude's input box at close time** is saved first and then cleared:
   - Read the box from `terminalInput`/`restoredInput` and save it into `parked.draft`.
   - Clear it with the existing clear-input path (Ctrl+U), then type `/exit`.
   - The card and notice show the draft as "ข้อความที่พิมพ์ค้างไว้" with a copy button. Nothing
     the user typed is lost, and `/exit` never becomes a prompt.
2. **"The turn ended"** means the room reached idle by any signal the store already uses: Stop,
   the transcript's turn end, or the idle-screen check, with no prompt open.
   - New work during the wait (a queued message Claude submits, or a prompt typed in the
     terminal) extends the wait to the next idle.
   - A permission prompt or question during the wait keeps it waiting, and the card says
     "รอคุณตอบก่อน ถึงจะพักได้" with "หยุดตอนนี้".
   - There is no maximum wait. The card always offers ยกเลิก and หยุดตอนนี้.
   - Parking a quest room pauses its quest at confirm time (reason "พักงานไว้ (งานค้าง)"), so the
     runner sends no next phase.
3. **Typing lock.** From confirm until the close finishes, the server refuses anything that
   would type into that room with 409 "กำลังพักงานห้องนี้". This covers `dispatchCommand`,
   select-option, send-key, the usage check's choice of an idle terminal, and the quest runner.
   Only the close sequence may type. That keeps a stray prompt from landing in the shell once
   Claude has exited.
4. **The "only a shell is left" check runs after Claude has exited**, not on the snapshot taken
   before `/exit`.
   - Before `/exit`, note the shell candidates on that console: pids in `consolePids` whose image
     name is `powershell.exe`, `pwsh.exe`, `cmd.exe` or `bash.exe`. Add an image-name lookup to the
     bridge for this.
   - After Claude has exited, re-read the console's process list through that shell's pid,
     excluding the bridge's own process.
   - Type `exit` only if exactly that one shell remains. Anything else left on the console (an
     MCP server that outlived Claude, a user job, a second shell) means `tab-left-open`.
5. **Rooms whose Claude is still running**, for example ones archived with เก็บเข้าประวัติ while
   the terminal stayed open:
   - ย้ายไปงานค้าง runs the full close sequence when the room's pid is alive. It records only
     when the process is gone.
   - ทำต่อ never opens a second `claude --resume` for a session whose process is alive. It brings
     the room back live (as today's activity revive does) and focuses it.
   - `failed`/`not-connected` rooms keep their pid, so the same rule applies to them.
6. **Server restart while `waiting-turn` or mid-close.** The server cannot know what happened
   while it was down, so it never resumes closing.
   - On load, it sets `closing: 'interrupted'` with "พักงานไม่เสร็จเพราะเซิร์ฟเวอร์รีสตาร์ท" and
     keeps the snapshot and note.
   - A room whose process is still alive becomes live again. Its notice offers "พักงานอีกครั้ง",
     with the note prefilled.
   - A room whose process is gone stays parked as `tab-left-open`.

### Store rules

- `clearHistoryOnly()` skips rooms with `parked`, as it does pinned rooms.
- Deduplication and merging (`_deduplicateSessions`, `_mergeSessionData`): a `parked` record on
  either side survives on the primary.
- `metrics.parkedRooms` is the count of rooms with `parked` and `lifecycle: 'history'`.

### Resume expiry

`GET /api/session/park-info?sessionId=` (or a field computed into the snapshot, the builder's
call) returns `{ transcriptExists, lastActivityAt, expiresAt, daysLeft }`:
- `lastActivityAt` is the transcript file's mtime.
- `expiresAt` is that mtime plus `cleanupPeriodDays`, read from `~/.claude/settings.json`
  (default 30).
- The card shows "resume ได้อีก N วัน". From 7 days or fewer it is amber. When the transcript is
  gone it shows "หมดอายุ resume แล้ว", and ทำต่อ is replaced by "คัดลอกบันทึก", which copies the
  goal, note, last reply and files as plain text.

### Chat UI (`public/app.js`, `index.html`)

- Sidebar: a new item **งานค้าง** (icon: bookmark) with a count, between ภาพรวม and ประวัติ.
  `ui.lifecycle` gains `'parked'`.
- `railGroups()`:
  - The `parked` view lists History rooms with `parked`, newest `parked.at` first.
  - The `history` view leaves them out.
  - The History count leaves them out too.
- **พักงาน** entry points:
  - the room's ⋯ menu ("พักงานไว้ก่อน", next to "เก็บเข้าประวัติ")
  - History rooms ("ย้ายไปงานค้าง")
- **Park dialog:**
  - the note textarea (placeholder "เช่น รอทีมตอบเรื่อง -s ours ก่อนค่อยทำต่อ")
  - a read-only preview of what will be saved: goal, branch, files count, first line of the
    last reply
  - for a working room, a choice: "รอรอบนี้จบแล้วค่อยปิด" (default) or "หยุดตอนนี้"
  - a line saying the terminal will be closed
  - primary button "พักงานและปิด terminal"
- **Parked card in the rail:** room name, cwd · branch, time since `parked.at`, goal, the note,
  "ค้างที่:" with the first ~120 characters of `lastReply` (or the TL;DR), files count, stage,
  and the expiry. "ทำต่อ" is on the card.
- **Opening a parked room** shows its normal view with a notice at the top:
  - "งานค้าง · พักไว้เมื่อ …"
  - the note (editable)
  - the closing result message, if any
  - the full `lastReply`, rendered with the existing Markdown and folded past 8 lines like the
    guild drawer
  - buttons: ทำต่อ · แก้โน้ต · ย้ายไปประวัติ
  This notice replaces History's "ปิด tab ไปเมื่อ …" notice for parked rooms.
- **ทำต่อ** calls the existing `resumeRoom` (`/api/session/resume`).
- Notifications: parked rooms are History rooms, so they are already silent. The "waiting-turn"
  room is live. When it closes, its turn end does not ring "done", because it is going to
  งานค้าง.

### Quests

A parked quest room's Claude ends, so the quest runner's existing `SessionEnd` handling stalls
the quest. It gets a parking-specific reason, "พักงานไว้ (งานค้าง)", via the `session_parked`
event, so the guild shows why. Resuming the quest stays a guild action.

### Testing

- Store and server tests:
  - the park snapshot fields
  - working → waiting-turn → Stop → closed
  - now/permission → Esc first
  - already-history → record only
  - clear-history keeps parked rooms
  - merge keeps `parked`
  - going live unparks and pushes the timeline entry
  - `/exit` is not recorded as a prompt
  - endpoint validation (409, note length)
  - park-cancel and unpark
  - expiry maths from mtime and `cleanupPeriodDays`
- Bridge: the close sequence with a stubbed transport, covering:
  - a shell-only console → `exit` typed
  - an extra process on the console → tab left open, nothing typed
  - no `SessionEnd` in time → `failed`
- UI: headless-Chrome check with the e2e fixture:
  - the nav count
  - the parked rail cards
  - History excludes parked rooms
  - the park dialog for an idle room and a working room
  - the parked-room notice and the folded reply
  - phone width
- `npm test` stays green, and `test/verify.js` brace checks pass.

## Left to the builder

- Exact Thai copy beyond the strings quoted above, icons, and spacing. Follow DESIGN.md.
- Whether expiry info is fetched per room or computed into the snapshot. It must not read files
  on every snapshot for every room; cache by mtime.
- How the close sequence is structured, whether in the bridge or a small `parking.js` module.
- Timeouts other than the 15 s `SessionEnd` wait.
