---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: ["public/app.js"]
---

# Dashboard (public/index.html + public/app.js)

Mode: Operate. The surface is used equally as a glanceable monitor and as a command center.

Audience and job: the author, running many Claude Code rooms in terminal tabs. They need to know what every room is doing and whether it needs them, without opening each room, and to act on a room within one or two clicks.

Constraints:
- No inline data-bearing JS. Actions go only through `data-act` delegation.
- Terminal and transcript text is untrusted and always escaped.
- Thai prose keeps English agent terms.
- Zero dependencies and no build step. Fonts are self-hosted in public/fonts.

Replaces: the dark graphite world (2026-11-26 build). The user asked for the look of a reference image they supplied.

## Direction contract

THESIS: The overview is the product. Every room card says what that room is doing right now (status, stage, a short summary, the active tool), so the author never has to open a room to know it. The thesis refuses the terse one-line inbox ("if it looks like this I might as well use Claude").

OWN-WORLD:
- Ground: soft lavender-periwinkle with two blurred colour fields (pink and violet).
- Shell: a violet-to-periwinkle gradient sidebar.
- Work surface: a large translucent white glass card with 24–28px radii and soft violet-tinted shadows.
- Room cards: white, 16px radii. The selected card lifts out of the list.
- Primary: a violet gradient for buttons and the send circle. User turns render as violet chat bubbles.
- Status hues for meaning only: amber means needs you, blue means working, green means done, rose means quota hold.
- Type: Figtree for Latin, the system Thai face for Thai.
- Dark mode follows the system: deep indigo glass, same structure.

STORY: The author glances at the list, where every card shows its status pill, stage dots, summary and active tool. They open a room to answer its prompt in one click, read the output as a conversation, and send the next instruction. Files, Agents, History and Usage open as a floating glass sheet only on click, and files open in a full IDE with a jump to VS Code. The 5h usage meter lives in the sidebar. A hold below 8% checkpoints rooms and resumes them after the reset.

FIRST VIEWPORT:
- Left (220px): the violet gradient sidebar. Mark, New room, nav (Live / รอคุณ with a count badge / ภาพรวม / ประวัติ), and at the bottom the 5h meter, hooks, scan and theme.
- Right: the glass work card, split into three parts:
  - The room list (360px), with search, then rich room cards grouped Needs you / Working / Idle.
  - The selected room: header with model/effort, stage stepper, prompt card, TL;DR, chat-style output, and a pill composer with a round violet send button.
  - A 56px icon strip on the card's right edge.

FORM: The structure is Inbox + Focus (user pick), now with rich room cards (user pick "การ์ดห้องแบบเต็ม"). The world is pinned by the user's words and reference image. seed: none (pinned) "อยากได้ style สีประมาณนี้มีความขอบมนๆ โปร่งใส transparent" + "มองเห็นจากภาพรวมได้เลยโดยที่ไม่จำเป็นต้องเข้าไปดูใน tab ว่าตอนนี้กำลังทำอะไรอยู่มีสรุปสั้นๆให้อ่านและ status เป็นอะไร"

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Finish review (2026-11-26)

Method: a seeded, isolated instance (scanner off, temp HOME, every room state: needs-input prompt, pending approval, working, idle, done, closed, quota hold, empty) rendered in headless Chrome over CDP at 1440, 1280, 1024 and 390 px, light and dark, with panels, popovers, IDE, dialogs, overview, history, expanded output and keyboard focus. Contrast measured numerically over the composited glass.

Verdict: ships. The direction contract holds (lavender ground, violet shell, glass work card, rich room cards, chat output, pill composer); the defects below were fixed in this pass.

Fixed:
- Focus column overflowed: with a prompt card (and especially during a hold) the output painted under the composer. The column now scrolls and the output keeps a 260px floor.
- Phones: `backdrop-filter` on `.work` made it the containing block for the fixed strip and panel, so the bar sat at the end of the page and panels opened offscreen. The blur is dropped at ≤900px.
- The open room card's lift was clipped by the list's scroll box and re-wrapped its text; it now slides 10px with a transform.
- 901–1180px left the room column ~340px wide; the sidebar now folds into an icon rail there.
- Overview was one card per row per project; it is now a status summary plus dense project lanes, attention first.
- Contrast: light shell labels were 2.3–2.7:1 and white on the rose button 3.9:1; the shell gradient was deepened (≥4.6:1) and `hold-fill` added (5.4:1). Dark primary unified between auto and pinned dark; a separate `ring` token.
- Global `:focus-visible` reset every focused element to an 8px radius; removed. Code ligatures (`===` as one glyph) turned off.
- IDE bar actions were not right-aligned (missing `ide-spacer` class); closed rooms kept live quick-action chips; usage card width followed its text; `ctx 0%` drew a stub bar; undefined `--accent` on the pin button.

Known gaps:
- The reference image is not in the repo; the review checked against this contract's words, not the picture.
- Off-stage dots are 1.5–1.7:1; accepted because the stage is named in text beside them.
- Checked in Chromium only.
