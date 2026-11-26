---
name: Agent Mission Control
description: A calm lavender control room where every Claude Code room says what it is doing, on rounded translucent glass beside the terminals.
colors:
  ground: "oklch(0.935 0.022 282)"
  blob-a: "oklch(0.82 0.11 2 / 0.75)"
  blob-b: "oklch(0.66 0.19 292 / 0.55)"
  glass: "oklch(0.995 0.004 282 / 0.70)"
  glass-strong: "oklch(0.995 0.004 282 / 0.94)"
  glass-edge: "oklch(1 0 0 / 0.75)"
  card: "oklch(1 0 0 / 0.80)"
  card-sel: "oklch(1 0 0)"
  soft: "oklch(0.962 0.014 282)"
  soft-2: "oklch(0.93 0.024 282)"
  lane: "oklch(0.97 0.012 282 / 0.55)"
  line: "oklch(0.90 0.02 282)"
  text: "oklch(0.27 0.065 276)"
  text-2: "oklch(0.43 0.045 276)"
  text-3: "oklch(0.52 0.035 276)"
  code-bg: "oklch(0.985 0.006 282)"
  dot-off: "oklch(0.86 0.03 282)"
  primary: "oklch(0.50 0.23 287)"
  primary-2: "oklch(0.53 0.20 272)"
  primary-ink: "oklch(0.47 0.22 287)"
  primary-soft: "oklch(0.55 0.23 287 / 0.11)"
  on-primary: "oklch(1 0 0)"
  ring: "oklch(0.50 0.23 287)"
  side-a: "oklch(0.55 0.18 300)"
  side-b: "oklch(0.49 0.15 270)"
  on-side: "oklch(1 0 0)"
  on-side-2: "oklch(1 0 0 / 0.90)"
  attn: "oklch(0.74 0.16 62)"
  attn-ink: "oklch(0.50 0.14 55)"
  attn-soft: "oklch(0.80 0.15 70 / 0.18)"
  attn-line: "oklch(0.74 0.16 62 / 0.55)"
  work: "oklch(0.60 0.17 255)"
  work-ink: "oklch(0.47 0.17 258)"
  work-soft: "oklch(0.60 0.17 255 / 0.12)"
  done: "oklch(0.68 0.16 150)"
  done-ink: "oklch(0.45 0.12 152)"
  done-soft: "oklch(0.68 0.16 150 / 0.14)"
  hold: "oklch(0.63 0.20 15)"
  hold-fill: "oklch(0.55 0.20 15)"
  hold-ink: "oklch(0.50 0.19 15)"
  hold-soft: "oklch(0.63 0.20 15 / 0.11)"
  hold-line: "oklch(0.63 0.20 15 / 0.45)"
  add-bg: "oklch(0.68 0.16 150 / 0.13)"
  del-bg: "oklch(0.63 0.20 15 / 0.11)"
typography:
  headline:
    fontFamily: "Figtree, Segoe UI Variable Text, Segoe UI, system-ui, -apple-system, Leelawadee UI, Noto Sans Thai, sans-serif"
    fontSize: "23px"
    fontWeight: 750
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Figtree, Segoe UI Variable Text, Segoe UI, system-ui, -apple-system, Leelawadee UI, Noto Sans Thai, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.4
  body:
    fontFamily: "Figtree, Segoe UI Variable Text, Segoe UI, system-ui, -apple-system, Leelawadee UI, Noto Sans Thai, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: "Figtree, Segoe UI Variable Text, Segoe UI, system-ui, -apple-system, Leelawadee UI, Noto Sans Thai, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.5
  label:
    fontFamily: "Figtree, Segoe UI Variable Text, Segoe UI, system-ui, -apple-system, Leelawadee UI, Noto Sans Thai, sans-serif"
    fontSize: "12.5px"
    fontWeight: 650
    lineHeight: 1.5
  meta:
    fontFamily: "Figtree, Segoe UI Variable Text, Segoe UI, system-ui, -apple-system, Leelawadee UI, Noto Sans Thai, sans-serif"
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: 1.5
    fontFeature: "tnum"
  figure:
    fontFamily: "Figtree, Segoe UI Variable Text, Segoe UI, system-ui, -apple-system, Leelawadee UI, Noto Sans Thai, sans-serif"
    fontSize: "30px"
    fontWeight: 750
    letterSpacing: "-0.03em"
    fontFeature: "tnum"
  mono:
    fontFamily: "Cascadia Code, Cascadia Mono, JetBrains Mono, ui-monospace, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  xs: "8px"
  sm: "10px"
  md: "14px"
  lg: "18px"
  xl: "26px"
  pill: "999px"
spacing:
  2xs: "4px"
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "14px"
  xl: "18px"
  2xl: "24px"
components:
  button:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "34px"
  button-hover:
    backgroundColor: "{colors.soft-2}"
  button-primary:
    backgroundColor: "linear-gradient(135deg, {colors.primary}, {colors.primary-2})"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "34px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.sm}"
    height: "34px"
  button-attn:
    backgroundColor: "{colors.attn}"
    textColor: "oklch(0.25 0.05 60)"
    rounded: "{rounded.sm}"
    height: "34px"
  button-hold:
    backgroundColor: "{colors.hold-fill}"
    textColor: "oklch(1 0 0)"
    rounded: "{rounded.sm}"
    height: "34px"
  icon-button:
    textColor: "{colors.text-2}"
    rounded: "{rounded.sm}"
    size: "34px"
  icon-button-on:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary-ink}"
  chip:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.text-2}"
    rounded: "{rounded.pill}"
    padding: "0 11px"
    height: "28px"
  pill:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.text-2}"
    rounded: "{rounded.pill}"
    padding: "0 9px"
    height: "22px"
  input:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "40px"
  key:
    backgroundColor: "{colors.card-sel}"
    textColor: "{colors.text-2}"
    typography: "{typography.mono}"
    rounded: "7px"
    height: "26px"
  room-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "14px"
  room-card-current:
    backgroundColor: "{colors.card-sel}"
  prompt-card:
    backgroundColor: "{colors.attn-soft}"
    rounded: "{rounded.lg}"
    padding: "16px"
  output:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.text-2}"
    rounded: "{rounded.lg}"
  composer:
    backgroundColor: "{colors.card-sel}"
    rounded: "26px"
    height: "52px"
  panel:
    backgroundColor: "{colors.glass-strong}"
    rounded: "{rounded.xl}"
    width: "380px"
  popover:
    backgroundColor: "{colors.glass-strong}"
    rounded: "{rounded.lg}"
    padding: "8px"
  nav-item:
    textColor: "{colors.on-side-2}"
    rounded: "{rounded.sm}"
    height: "42px"
---

# Design System: Agent Mission Control

## Overview

**Creative North Star: "The Glass Control Room"**

The dashboard sits beside the terminals and does one job: say what every Claude Code room is doing right now, without opening it. Its world is the one the author pinned with a reference image and two sentences: a soft lavender room ("สีประมาณนี้ ขอบมนๆ โปร่งใส transparent") where every room can be read from the overview, with a short summary and its status ("มองเห็นจากภาพรวมได้เลย... มีสรุปสั้นๆ ให้อ่านและ status เป็นอะไร").

So the ground is lavender with two blurred colour fields, the shell is a violet gradient, and the work happens on a large sheet of white glass with generous radii. Everything that is the author's to act on is violet; everything that says how a room is doing uses one of four status hues and nothing else. The room card, not the log, is the unit of the product: status pill, stage dots, the active tool, a three-line summary (or the question it is asking), and the branch, tokens and sub-agents underneath.

The language is Thai prose with English agent terms (Plan, Code, Verify, Done, TL;DR, Sub-Agent, tool names) in one line. Figtree sets the Latin half, the system Thai face (Leelawadee UI on Windows, Noto Sans Thai elsewhere) sets the Thai half, and labels never rely on uppercase or tracking, which Thai cannot express.

**Key Characteristics:**
- Lavender ground (hue 282) with a pink and a violet blurred field; a violet-to-periwinkle gradient shell.
- One large translucent glass work card (26px radius, 28px backdrop blur, violet-tinted shadow) holding list, room and inspector.
- Rich room cards (18px radius) that summarise each room; the open one slides toward the room it opens.
- One violet primary for acting and selection, drawn as a gradient on buttons, the send circle and user chat bubbles.
- Four status hues with fixed meanings: amber needs you, blue working, green done, rose quota hold.
- An authored line-icon set (24 grid, 1.75 stroke, round caps) in `currentColor`; no emoji.
- Light and dark follow the system and can be pinned; dark is deep indigo glass with the same structure.

## Colors

A lavender family on hue 276–287 with one violet signal and four semantic status hues, all in OKLCH, which is the normative source. Values above are the light theme; dark values are listed after the roles.

### Primary
- **Violet** (`primary` → `primary-2`, drawn as a 135° gradient): the only "act here / this is selected" colour. Primary buttons, the send circle, the current stage step, pressed segments, switches when on, user turns in the output, the strip's count badges.
- **Violet Ink** (`primary-ink`): violet as text or glyph on a light surface: the Claude turn marker, list bullets, links, the TL;DR tag, pressed icon and strip buttons (on `primary-soft`).
- **Focus Ring** (`ring`): every keyboard focus outline. Equal to `primary` in light; a lighter violet in dark so it clears 3:1 on indigo glass.

### Secondary (status hues; meaning only)
- **Lamp Amber** (`attn`, `attn-ink`, `attn-soft`, `attn-line`): needs you. The "รอคุณ" group head and pill, the prompt card, its cursor option, the current stage step while the room waits, the nav badge (amber ink on white).
- **Working Blue** (`work`, `work-ink`, `work-soft`): working. The spinning avatar, the "กำลังทำงาน" pill, the current stage dot, tool names in output, an automated run that is still going ("กำลังรัน").
- **Done Green** (`done`, `done-ink`, `done-soft`): done. Finished steps and dots, done avatars, the A/U file badge, success toasts, the live connection dot, a finished automated run ("สำเร็จ").
- **Quota Rose** (`hold`, `hold-ink`, `hold-soft`, `hold-line`, `hold-fill`): quota hold, or an automated run that failed. The hold banner, the held-room notice, the held composer and its note chip, the low end of meters; on the งานอัตโนมัติ view the failed-run count pill (only when above zero), a failed run's reason pill and the failed part of an hourly bar. `hold-fill` is the darker rose used under white text (the "ทำต่อเลย" button).
- **Diff tints** (`add-bg`, `del-bg`): row tints in diffs. They share hue with done and hold but are separate tokens.

### Neutral
- **Lavender Ground** (`ground`, with `blob-a` pink and `blob-b` violet fields blurred 70px behind everything).
- **Glass** (`glass`, `glass-strong`, `glass-edge`): the work card at 70%, floating sheets (panel, popover, IDE, dialog, toast) at 94%, and a 1px inner white edge on every glass and card surface.
- **Cards** (`card`, `card-sel`): room cards and notices at 80% white; hover, selected and the composer at solid white.
- **Wells** (`soft`, `soft-2`, `lane`, `code-bg`): the output well, chips, inputs and resting buttons (`soft`); hover and tracks (`soft-2`); overview lanes (`lane`); code views (`code-bg`).
- **Line** (`line`): table borders, dividers inside panels, the IDE bar and file list edge.
- **Text / Text 2 / Text 3** (`text`, `text-2`, `text-3`): headings and primary copy; summaries and output prose; metadata, timestamps, placeholders.
- **Shell** (`side-a` → `side-b`, `on-side`, `on-side-2`): the sidebar gradient and its white text.

### Dark theme
Deep indigo glass, same structure: `ground` 0.175/0.035/285, `glass` 0.245 at 62%, `card` 0.30 at 70%, `card-sel` 0.345, text 0.96 / 0.83 / 0.71, `primary` 0.56/0.22/287 → `primary-2` 0.55/0.17/268 (still dark enough for white text), `primary-ink` and `ring` lifted to 0.80 / 0.78, status inks lifted to ~0.80 lightness, shell 0.43/0.165/303 → 0.34/0.12/274. The theme follows `prefers-color-scheme`; the sidebar's theme button cycles auto → light → dark and pins it with `data-theme` on `<html>`.

### Named Rules
**The Meaning-Only Rule.** Status hues carry meaning only: amber means needs you, blue means working, green means done or a diff addition, rose means quota hold, a failed automated run or a diff deletion. Never use them for decoration, category or emphasis. The one exception is the find-highlight: `attn-soft` behind a searched term in search snippets and the transcript viewer, as in a browser's find bar.

**The One Violet Rule.** Violet is the only colour that says "you can act here" or "this is selected". It never stands in for a status, and a status never borrows it.

**The Rising Meter Rule.** Meters fill violet at rest (white inside the violet sidebar) and shift to amber, then rose, as they near a limit. The 5-hour usage meter turns amber below 25% remaining and rose below the hold threshold (8% by default), with a tick at the threshold; the weekly meters in the Usage panel follow the same colours without the tick; the context meter turns amber above 60% and rose above 85%. A 0% meter draws no fill, and so does a meter with no reading ("ยังไม่ได้เช็ค", or a reading whose window has reset).

**The Neutral Modification Rule.** A modified file's M badge is neutral (`text-2` on `soft-2`). Only additions (A, U) take green and deletions (D) take rose, so the file list is not a field of colour.

**The Measured Contrast Rule.** Contrast is measured over the composited glass, not over the token alone. Body and meta text clear 4.5:1 in both themes (`text-3` on a card: 5.5 light, 5.8 dark), status inks on their soft fills clear 4.9:1, and the shell gradient was deepened until its 90% white labels clear 4.5:1 at the gradient's lightest point. White text only sits on `primary` (6.7:1 light, 5.1:1 dark) or `hold-fill` (5.4:1), never on `hold` or the light shell stops. The off-stage dots (1.5–1.7:1) are the one exception, and only because the stage is always named in text beside them.

## Typography

**Display Font:** none; Figtree at 750 carries every heading.
**Body Font:** Figtree (self-hosted, latin and latin-ext subsets, SIL OFL 1.1; licence in `public/fonts/OFL.txt`), falling back to Segoe UI Variable Text, Segoe UI, system-ui, then Leelawadee UI and Noto Sans Thai for Thai.
**Mono Font:** Cascadia Code (with Cascadia Mono, JetBrains Mono, ui-monospace, Consolas), ligatures off.

**Character:** Figtree's round, open geometry matches the rounded glass, and it stays friendly at 750 without turning into a display face. Thai falls through to the system face per glyph, so a mixed line keeps one rhythm without a webfont for Thai.

### Hierarchy
- **Headline** (750, 23px, 1.2, −0.02em): the open room's name, the list title, the overview title. One per region.
- **Title** (700, 15px, 1.4): the prompt question, panel titles (17px/750), dialog titles (19px/750), room names on cards (14.5px/700).
- **Body** (400, 14px, 1.5): TL;DR and the composer. Output prose runs at 13.5px, 1.6, capped at 80ch; card summaries at 13px, clamped to three lines.
- **Body Small** (500–550, 13px): popover items, file rows, form fields, toasts, options in the prompt card (13.5px/550).
- **Label** (650–700, 12.5px): group heads, stage steps, chips, segment buttons, panel section heads.
- **Meta** (500, 11.5px, tabular): timestamps, token counts (automated runs), card footers, paths under file names. Pills are 11.5px/650.
- **Figure** (750, 30px, tabular, −0.03em): remaining 5-hour usage in the Usage panel (weekly rows use 15px/750); the sidebar shows the same number at 22px.
- **Mono** (400, 12.5px, 1.6): raw output, code and diff views, code blocks, inline code (0.86em), tool lines, branches, paths, keycaps, file badges.

### Named Rules
**The Mono-for-Machine Rule.** Mono marks text that came from or goes to the machine: code, paths, branches, tool calls, keys, diff counts. Human-facing numbers (tokens, cost, percentages, times) stay in Figtree with tabular figures.

**The No-Ligature Rule.** Code, keys and mono text render with `font-variant-ligatures: none`. Cascadia's ligatures turn `===` into a single glyph, and a diff must show exactly what was typed.

**The Sentence-Case Label Rule.** Group heads and section labels are sentence case, set apart by weight and `text-3`, never by uppercase or letter-spacing.

## Layout

A full-height application on desktop with no page scroll. The shell pads 18px around two columns: the sidebar and the glass work card. The sidebar is 236px and tucks 28px under the work card's rounded left edge, so the card reads as laid on top of it.

The work card is a grid: an optional hold banner across the top row, then three columns: the room list (372px), the open room (fluid), and a 64px icon strip on the card's right edge. Inspector panels (380px) float inside the card to the left of the strip, inset 14px from top and bottom.

The open room stacks: title row (name, edit, VS Code, pin, more), a chip row (branch, model/effort, the context check, terminal connection), the four-step stepper, notices (closed, hold), the prompt card, a TL;DR line, the output well filling the rest, then the composer pinned at the bottom. Gaps are 14px; padding is 24px top, 24px right, 18px left.

The overview replaces list, room and strip with a status summary (counts per status as pills) and project lanes: a grid of `minmax(310px, 1fr)` columns, each a soft well holding that project's room cards, lanes holding a waiting room first.

Spacing steps on 4, 6, 8, 10, 12, 14, 18, 24px. Control heights: 28px small, 34px default, 40px search and text inputs, 42px sidebar items.

### Responsive
- **≤1280px:** sidebar 212px, list 330px, panel 340px.
- **901–1180px:** the sidebar folds into an 84px icon rail: brand mark with the connection dot on its corner, a 46px round "new room" button, icon-only nav with the attention badge on the icon, the usage card reduced to its percentage and bar, tools stacked. Labels stay in the DOM for screen readers. List 312px.
- **≤900px:** one scrolling page. The sidebar becomes a top card (nav as a 3 × 2 grid of 54px icon-over-label buttons at 11.5px/650, counts and the amber badge in the top-right corner, so all six stay on screen without sideways scrolling; usage meter inline), the list and the open room follow, the strip becomes a fixed bottom bar, and panels become a 70vh bottom sheet above it. The work card drops its backdrop blur here, because `backdrop-filter` makes an element the containing block for fixed descendants and would pin the bar and sheet to the card instead of the screen. Below 440px the stage stepper tightens (5px gaps, 12px labels) so a 360px screen never scrolls sideways.

### Named Rules
**The Pinned Composer Rule.** The composer never moves and nothing paints under it. When header, notices, prompt card and TL;DR leave too little room, the column scrolls as a whole and the output keeps a 260px floor.

**The Blur-Free Ancestor Rule.** No ancestor of a `position: fixed` element may carry `backdrop-filter`, `filter` or `transform`.

## Elevation & Depth

Depth is glass over colour. The ground's blurred fields show through the 70% work card (backdrop blur 28px, saturate 1.3), cards sit on it at 80% white, and floating sheets sit at 94% with stronger blur. Every glass and card surface has a 1px inner white edge (`glass-edge`) instead of a border. Shadows are violet-tinted in light and near-black indigo in dark, never neutral grey.

### Shadow Vocabulary
- **Card** (`0 8px 24px -14px oklch(0.42 0.16 287 / 0.30)`): room cards, notices, search, the composer at rest, prompt options.
- **Lift** (`0 22px 44px -18px oklch(0.42 0.18 287 / 0.42)`): the open room card, popovers, toasts, hovered prompt options, the focused composer.
- **Shell** (`0 40px 90px -36px oklch(0.38 0.16 287 / 0.45)`): the sidebar, the work card, panels, the IDE, dialogs.
- **Primary** (`0 10px 22px -10px oklch(0.50 0.23 287 / 0.65)`): violet fills (primary buttons, send, the current step, user bubbles).

### Named Rules
**The Tinted Shadow Rule.** A shadow carries the violet of the room it sits in. Grey or black drop shadows are off-world.

## Shapes

Rounded throughout and rounder as things get bigger: 8px for small controls (small buttons, keycaps 7px, popover rows), 10px for buttons and nav items, 14px for inputs, prompt options, code blocks and the new-room button, 18px for room cards, the prompt card, the output well and popovers, 26px for the work card, sidebar, panels, IDE, dialogs, overview lanes and the composer pill. Pills (999px) are for chips, status pills, badges and toasts. Avatars, stage steps and the send button are circles.

## Components

### Buttons
- **Shape:** 10px radius, 34px high (28px small), 14px side padding, 13px/600 text, 7px icon gap.
- **Default:** `soft` fill; hover `soft-2`.
- **Primary:** the violet gradient with white text and the primary shadow; hover lifts 1px. One per region (new room in dialogs and empty states, create, save).
- **Ghost:** transparent, `text-2`; hover fills `soft`.
- **Attention / Hold:** amber with dark ink ("อนุญาต"), or `hold-fill` with white ("ทำต่อเลย"). Only for actions that resolve that status.
- **Danger:** `hold-fill` (rose) with white text, only for the confirm button of a destructive dialog ("ลบถาวร", "ล้างประวัติ"); never a resting button.
- **Icon button:** 34px (28px small) square, `text-2`; hover `soft`; pressed violet ink on `primary-soft`.
- **Focus:** a 2px `ring` outline offset 2px that follows the element's own radius. Disabled: 45% opacity.

### Chips and Pills
- **Chip:** 28px pill on `soft`, `text-2` at 12.5px, 14px leading icon. Branch, model/effort and the context check in the room header; quick actions under the composer. The context chip is a button: "เช็ค context" until clicked, then "ctx 34%" with a mini meter and the check time in `text-3`; it never updates on its own, a click reads it again (a spinner and "กำลังเช็ค context…" meanwhile). No room shows its own token count or cost. Toggle chips turn violet ink on `primary-soft` when pressed; the held note takes the hold treatment.
- **Status pill:** 22px, 11.5px/650, the status ink on its soft fill (neutral for idle and closed).

### Room Card (signature)
The unit of the product. A 44px gradient avatar in the status hue with the status glyph (and a pin dot when pinned); then the room name and relative time; a row with the status pill and, while a turn is in flight (working, waiting on you, held), four stage dots and the stage plus active tool ("Code · Edit"); an idle room shows its pill alone, with a still ring-and-dot glyph that cannot be mistaken for the working spinner; the summary, which is the room's question in amber ink when it waits on you and otherwise its TL;DR (three lines, inline code kept); and a meta footer of branch, fresh tokens and sub-agent count. Cards are `card` with the card shadow; hover goes to solid white. The open room's card turns solid white, takes the lift shadow and slides 10px toward the room it opens (a transform, so its text never re-wraps); on a phone it gets a 2px violet inner ring instead.

Cards reorder by drag inside their status group: press and move with a mouse, hold for 0.3s then move on touch (a quick swipe still scrolls), or Alt+↑/↓ on a focused card. The held card lifts 2% with the lift shadow and a 2px `ring` edge and cannot leave its group; its neighbours slide aside over 170ms; Escape puts everything back. The order is stored per room on the server, so it survives reloads and restarts, and pinning moves a room to the top. Rooms never placed sort after placed ones, oldest first.

### Prompt Card (signature)
The one amber container: `attn-soft` with an `attn-line` inner edge, 18px radius, 16px padding. The question at 15px/700, up to four lines of context, numbered options as white rows with keycaps (the cursor option ringed in amber with an amber "Enter" hint), and keycap buttons for up, down, enter and Esc. A pending tool approval shows the command in mono with "อนุญาต" and "ปฏิเสธ (Esc)". It sits under the stepper, above everything else the room says, and approval keys appear nowhere else. On a tall card the key row sticks to the bottom of the room column on a frosted amber band and settles back into the card at its end (scroll-state container queries; older browsers keep it in the card).

When Claude asks several questions at once, a row of pill tabs sits on top: one per question (its header, a number or a green check once answered) and a last "ส่งคำตอบ" tab, the current one ringed in amber; clicking a tab moves the terminal there with ←/→, and ←/→ keycaps join the key row. Options carry their description on a second line in `text-2`; multi-select options tick on the dashboard only (an 18px checkbox, amber when ticked, with a dashed amber outline while the tick is not yet in the terminal) and an amber "ยืนยัน N ข้อ แล้วไปต่อ" button sends the whole set at once (Enter on each option that differs, then the terminal's "Next" row, or → to the next tab where the terminal has no such row), so the terminal is not redrawn per click; the terminal's own rows ("Type something", "Chat about this") still act at once; an option with a preview shows it in a mono box under the list. Question and option text always come from Claude's tool input (hook or transcript), never from the screen, which garbles Thai: the screen only says which question is showing, where the cursor is and what is ticked.

### Stage Stepper
Four 28px circular steps joined by 2px lines: finished steps green-ink checks on `done-soft`, the current step a violet gradient circle (amber while the room waits on you), future steps neutral. An idle room has no current step: every step is neutral, because a stage only means something while a turn runs. Cards repeat it as four 6px dots: green done, blue (or amber) current, `dot-off` ahead. The dots repeat the stage named beside them, so they are decorative for assistive tech.

### Output as Conversation
The output well (`soft`, 18px) shows the transcript as a chat: user turns are right-aligned violet gradient bubbles (18/18/6/18 radius, up to 78% wide); Claude turns are white cards (6/18/18/18) headed by a violet "Claude" marker; tool calls are mono lines with the tool name in `work-ink`; Markdown headings, lists, tables, quotes and fenced code render inside. A raw toggle shows the plain text in mono, A−/A+ change its size, and it sticks to the bottom unless the reader scrolled up. The live part is the last ~30 lines; a ghost "โหลดข้อความก่อนหน้า" button at the top pages back through the room's own session 40 lines at a time (the reader keeps their place as lines appear above), down to a hairline "เริ่มต้น session" divider. A closed room in ประวัติ reads back the same way. The expand button (or F) is focus mode: the room fills the screen (browser full screen when allowed, else the window) on the plain ground, its conversation in a centred column up to 1120px, with only the question card and the composer kept; the output header then carries the room name (14px/700, one line) and its status pill. Esc, the collapse button or leaving browser full screen ends it. A turn stopped with Esc shows as a rose hairline divider "⏹ หยุดแล้ว (กด Esc)", never as a bubble the person typed; messages waiting in Claude's queue follow the live part as dashed violet bubbles with "อยู่ในคิว จะส่งเมื่อ Claude ทำรอบนี้เสร็จ". Text left unsent in the terminal's own input box shows above the composer as an amber notice (exact text when known, else as read from the screen with a note that Thai may be incomplete) with ส่งข้อความนี้ / ย้ายมาแก้ในนี้ / ลบทิ้ง; sending while it is there turns the notice into a choice (ลบของเดิมแล้วส่งข้อความใหม่ / ส่งรวมกัน / ยกเลิก) instead of appending silently. A room is one Claude session in one terminal, never a folder: two sessions in one project are two cards, and each shows only its own transcript. Every line of a user turn stays inside its bubble; the "ไฟล์แนบ (N):" list renders as compact file chips in the bubble (the name without its timestamp prefix, the full path on hover). The "โหลดข้อความก่อนหน้า" button only shows when something older exists; otherwise the "เริ่มต้น session" divider sits at the top.

### Composer
A white pill (26px radius) with a 40px paperclip button on the left, an auto-growing textarea and a 40px violet send circle; on focus it lifts and takes a 2px `ring` inner edge. Below it: quick-action chips (Run tests, สรุปงาน), "หยุด (Esc)" while the room works, and the background (headless) toggle on the right. During a quota hold the pill turns `hold-soft`, send is disabled and the quick actions give way to a "held until" note. For a closed room it turns `soft` with a line edge, send and quick actions are disabled, and the placeholder says to resume the room or switch to background mode.

Attachments: files come from the paperclip, a paste (a screenshot or copied image becomes `screenshot-HHMMSS.png`) or a drop on the composer (a dashed `ring` outline while dragging). Each uploads at once and waits above the pill as a white chip (14px radius): a 40px thumbnail for images or a violet file tile, the name (ellipsis), the size or "กำลังอัปโหลด…" in `work-ink`, a rose state with the error when it fails, and a remove button; two per row on a phone. Sending waits for uploads and appends one absolute path per line under "ไฟล์แนบ (N):", which Claude opens itself. Files live in the data folder, never the repository, 20 MB and 10 files at most, removed after 14 days.

### Navigation
- **Sidebar:** brand mark (40px, white 18% glass) and name with the connection dot; a white "ห้องใหม่" button with violet text; nav items Live, รอคุณ (white badge with amber count), ภาพรวม, ประวัติ, ค้นหา, งานอัตโนมัติ, 42px high, white 12% on hover and 22% when current; then the usage card and four tool buttons (hooks, scan terminals, notifications, theme).
- **Usage card:** white 14% glass, "Usage 5 ชม.", the remaining percentage of the latest check at 22px/750, a white meter with the threshold tick, and a footer with the reset time and how long ago it was checked ("เช็คเมื่อสักครู่", "เช็ค 5m ที่แล้ว"; "ค่าจำลอง" during ทดสอบการพัก). Before any check, or once the checked window has reset, it shows "—" with "ยังไม่ได้เช็ค" / "reset แล้ว" and an empty meter. It opens the Usage panel. During a hold it gains a rose inner ring.
- **Usage panel:** plan usage as a whole, never per room. Nothing is fetched on its own: "เช็คตอนนี้" (default button; spinner and "กำลังเช็ค…" while it runs, a toast with the result or the reason it could not run) types `/usage` into one idle Claude Code terminal and closes it again. It shows the 5-hour window as the figure with its meter, reset time and countdown, then one 6px meter row per weekly limit (all models, then each model Claude Code lists), then when and through which room it was checked. ทดสอบการพัก puts a `hold-soft` note above the numbers saying the level is simulated. The auto-pause section follows: switch, threshold field, and ทดสอบการพัก or ทำต่อเลย.
- **Icon strip:** 52px stacked icon-over-label buttons (10.5px/650) for ไฟล์, Agents, ประวัติ, Usage, with violet count badges; pressed violet ink on `primary-soft`.

### Notifications
- **Bell:** a sidebar tool button between scan and theme, off by default. Off, it is a slashed bell in `on-side-2`; on, a plain bell pressed in white 22% glass with a white glyph (the shell's form of a pressed icon button, the same fill as the current nav item, since violet on the violet shell would not read). When the person turned it on but the browser now blocks notifications, the slashed bell takes the hooks button's warm warning ink. `aria-pressed` carries the state and the title says what it does or why it is off.
- **Permission:** asked only when the person turns the bell on, from that click. Denied, dismissed and unsupported each get a Thai toast that says what to do, and the bell stays off. The choice persists with the other view prefs.
- **When it rings:** a system notification (the Notification API; on Windows, the notification centre) when a live room changes into รอคุณ (`needs_input`) or finishes a turn (`done`). It stays silent for the first snapshot after load or after the stream reconnects, for a room seen for the first time, for history rooms, and for the room open in focus view while the window is visible and focused. A repeat of the same change for the same room within 20 seconds is dropped, so a flapping room rings once. Changes are tracked while the bell is off, so turning it on never replays old ones.
- **Text:** plain, without Markdown, emoji or line breaks. The title is the room name; the body is "รอคุณตอบ: <question>" ("รอคุณตอบ 3 ข้อ: …" for several, "รอคุณยืนยัน: <command>" for an approval without a question) or "ทำเสร็จแล้ว: <TL;DR, about 80 characters>". Each room has one tag, so its newer notification replaces the older one.
- **Click:** focuses the dashboard and opens that room, clearing a search or filter that would hide it. A notification for the room now on screen closes when the person comes back to the window.
- **Tab title:** "(N) Mission Control" while N live rooms wait on you, plain "Mission Control" when none, whether or not the bell is on.

### Panels, Popovers and the IDE
- **Panels** float inside the work card as 94% glass sheets (26px radius, 30px blur), entering over 220ms with a 14px slide. Sections are separated by `line` hairlines. They open only on click and are never restored on reload.
- **Popovers** (model/effort, more, filters) are 94% glass with 18px radius, positioned under their anchor and flipped above when there is no room. A popover closes when its room or view changes and leaves nothing in the DOM; Esc returns focus to its anchor. The model/effort popover opens with a short note that the choice also becomes Claude Code's default for new sessions, and marks the current model and effort (violet, a check, `aria-pressed`); an unknown model marks nothing and the chip reads "Model".
- **The IDE overlay** covers the screen inset 16px: a 58px bar (breadcrumb, "เปิดใน VS Code", close) over a 300px file list and a Diff/Source view in a mono table with clickable line numbers that open VS Code at that line.
- **Confirm dialog:** every confirmation is the in-page `#confirm-dialog` (`role="alertdialog"`, dialog shape and shadow), never the browser's `confirm()`, which a ticked "prevent additional dialogs" silently turns into "no". A 17px/750 question, a `text-2` line on what happens, then ยกเลิก (focused first) and the action: Danger for deletes, Primary otherwise. Esc and a backdrop click cancel; global shortcuts pause while any dialog is open. Buttons go full width on a phone.
- **Transcript viewer on a phone:** an 8px inset over a dim scrim that closes it on click; the page behind does not scroll.

### Overview
Status pills with counts, then project lanes (see Layout). Every lane shows the project name, its room count and the folder path (truncated, full path on hover), and stacks the same room cards as the list, sorted attention first and then in the dragged order; lanes follow the same rule. When Claude Code hooks are not installed an amber notice above the lanes (and above the room list) says the status is not live, with an "ติดตั้ง" button.

### Search
The ค้นหา view replaces list, room and strip (like the overview) with one centred column up to 940px: the headline "ค้นหาบทสนทนา" with the index state on the right in `text-3` ("ค้นจาก N session", or a turning spinner and "กำลังสร้างดัชนี… x/y session" while the server builds its index), a 48px white search field (14px radius, card shadow; on focus the lift shadow and a 2px `ring` inner edge), then three toggle chips คนพิมพ์ / งานอัตโนมัติ / ทั้งหมด (pressed: violet ink on `primary-soft`; the choice is remembered per viewer). Typing searches after 250 ms (Enter at once), at least 2 characters, Thai and English alike. A `text-3` count line ("พบใน N session") heads the results. Each result is a card (`card`, 18px, card shadow): the session's first prompt as its title (14.5px/700, one line) with the last activity date on the right (meta); a row with a folder glyph and the project name, a neutral pill with the match count, a neutral "งานอัตโนมัติ" pill for `claude -p` / SDK runs, and the folder path in mono; up to three snippets spread over the session (first, middle, last match), each a full-width `soft` row (10px radius, hover `soft-2`) with its speaker in a 52px column ("คุณ" in `text-3`, "Claude" in `primary-ink`, "Tool" in mono `work-ink`) and up to three lines of text, tool lines in mono; and two ghost buttons, อ่านทั้ง session and คัดลอก claude --resume. A snippet opens the transcript viewer at that entry with the reply that followed it, and every occurrence of the term is marked. The matched term is marked with `attn-soft` behind the text (650 weight), the same find-highlight the viewer uses; it is the only place amber appears without meaning "needs you", and it never fills a surface. Empty, no-result ("ไม่พบ …" with a "ลองค้นในทั้งหมด" chip) and building states are centred `text-3` notes, never cards. On a phone the speaker sits above its snippet and the path is hidden.

### Automated Runs
The งานอัตโนมัติ view shows what `claude -p` and Agent SDK sessions did (they get no room). Like the overview it replaces list, room and strip: the 23px title with total pills (runs, failed in rose only when above zero, running in blue when any, tokens), and on the right the update time, three window chips (24 ชม. / 3 วัน / 7 วัน; the chosen one violet ink on `primary-soft`) and a refresh icon button; one `text-3` line says why these runs are here. Below, one card per working folder (`card`, 26px radius, card shadow) in a `minmax(540px, 1fr)` grid: the folder name at 15px/750 with its full path in mono under it; stat pills (runs, failed, running, tokens, last run); the hourly chart; the idle sentence; then "รันล่าสุด" and eight run rows, with a ghost "ดูอีก N รัน" button for the rest (the API sends the newest 30).

- **Hourly chart:** inline SVG, one slot per hour of the window, 52px high. A bar is the runs started in that hour, violet like a resting meter, with the failed share stacked at its foot in `hold`. Under every slot sits a 4px strip: `soft-2` when nothing ran, violet while a run was going, its opacity rising with the minutes of work, so a long run still shows in the hours after it started and empty hours read as gaps. Each slot has a native tooltip (hour, runs, failed, tokens, minutes of work). Hour labels every 6 hours (24 ชม.), 12 hours (3 วัน) or a date per day (7 วัน), 11px `text-3` tabular.
- **Idle sentence:** a clock glyph and "ว่างนานสุด **3 ชม. 20 นาที** (01:10–04:30)", the longest gap between runs inside the window (with dates when it is not today), then "ไม่มีรันใหม่มา …" once nothing has run for 30 minutes.
- **Run row:** a full-width button (10px radius, `soft` on hover) in five columns: start time (650, `text`), duration and tokens (`text-3`, right-aligned, tabular), a status pill (สำเร็จ green, กำลังรัน blue, or the failure reason in rose: จบกลางคัน, API error, ถูกหยุด, ไม่ได้ตอบ) and the first prompt on one line. A failed run adds a `text-3` line saying what stopped it ("หยุดหลัง 60 turns · This command requires approval"). The tooltip carries the prompt, model, turns and tool calls; a click opens the run in the transcript viewer. On a phone the prompt moves to its own line under time, duration, tokens and the pill.
- **States:** "กำลังอ่าน transcript…" during the first scan; an empty state that says nothing ran in the chosen window and what will show up here; an error line with "ลองอีกครั้ง". The view refreshes every 30 seconds while it is open and the tab is visible.

### Icons
An authored set on a 24-unit grid, stroked at 1.75 with round caps and joins, in `currentColor`, rendered at 11–20px. Icons inherit colour from context and are never multicolour.

### Motion
One easing, `cubic-bezier(0.16, 1, 0.3, 1)`. Colour changes take 140ms; the room card's slide and shadow 220ms; panels 220ms, the IDE 200ms, toasts 200ms and popovers 160ms, each with a short slide or scale. The working spinner turns every 1.1s. Under `prefers-reduced-motion` every animation and transition collapses to near-instant.

## Do's and Don'ts

### Do:
- **Do** let the room card answer "what is it doing?": status pill, stage, active tool, a short summary, the question when it asks.
- **Do** keep status hues to their single meanings and violet to acting and selection.
- **Do** measure contrast over the composited glass, in both themes, before shipping a colour.
- **Do** keep the composer pinned and let the column scroll when content does not fit.
- **Do** keep the M file badge neutral; only A/U go green and D goes rose.
- **Do** show approval keycaps only on the prompt card.
- **Do** open panels only on click, and never restore an open panel on reload.
- **Do** tint shadows violet (indigo in dark) and give glass a 1px inner white edge instead of a border.
- **Do** set numbers in tabular figures and machine text in mono without ligatures.

### Don't:
- **Don't** use emoji as icons, anywhere, including status, buttons and toasts.
- **Don't** put white text on `hold`, `attn` or the light shell stops; use `hold-fill`, dark ink, or the deepened gradient.
- **Don't** put `backdrop-filter`, `filter` or `transform` on an ancestor of a fixed element.
- **Don't** move the open room's card with margins; a transform keeps its text from re-wrapping and stays inside the list's scroll clip.
- **Don't** uppercase or letter-space labels; separate them with weight and `text-3`.
- **Don't** repeat the same pending prompt in more than one place on the screen.
