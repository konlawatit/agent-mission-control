---
name: Agent Mission Control
description: A night-shift triage desk for many Claude Code rooms, set in graphite beside the terminals.
colors:
  bg: "oklch(0.165 0.012 255)"
  bg-sunk: "oklch(0.145 0.011 255)"
  rail: "oklch(0.185 0.012 255)"
  surface: "oklch(0.205 0.013 255)"
  surface-2: "oklch(0.235 0.014 255)"
  surface-3: "oklch(0.275 0.015 255)"
  line: "oklch(0.31 0.014 255)"
  line-soft: "oklch(0.255 0.013 255)"
  text: "oklch(0.95 0.006 255)"
  text-2: "oklch(0.80 0.012 255)"
  text-3: "oklch(0.67 0.014 255)"
  accent: "oklch(0.80 0.10 205)"
  accent-ink: "oklch(0.20 0.03 220)"
  accent-soft: "oklch(0.80 0.10 205 / 0.13)"
  attn: "oklch(0.83 0.14 78)"
  attn-soft: "oklch(0.83 0.14 78 / 0.11)"
  attn-line: "oklch(0.83 0.14 78 / 0.42)"
  work: "oklch(0.72 0.13 262)"
  work-soft: "oklch(0.72 0.13 262 / 0.14)"
  done: "oklch(0.76 0.13 155)"
  done-soft: "oklch(0.76 0.13 155 / 0.12)"
  hold: "oklch(0.70 0.17 25)"
  hold-soft: "oklch(0.70 0.17 25 / 0.12)"
  hold-line: "oklch(0.70 0.17 25 / 0.45)"
  hold-text: "oklch(0.86 0.09 25)"
  add: "oklch(0.76 0.13 155)"
  add-bg: "oklch(0.76 0.13 155 / 0.10)"
  del: "oklch(0.72 0.15 22)"
  del-bg: "oklch(0.72 0.15 22 / 0.11)"
typography:
  headline:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, -apple-system, Noto Sans Thai, Leelawadee UI, sans-serif"
    fontSize: "19px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, -apple-system, Noto Sans Thai, Leelawadee UI, sans-serif"
    fontSize: "14.5px"
    fontWeight: 650
    lineHeight: 1.4
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, -apple-system, Noto Sans Thai, Leelawadee UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, -apple-system, Noto Sans Thai, Leelawadee UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, -apple-system, Noto Sans Thai, Leelawadee UI, sans-serif"
    fontSize: "12.5px"
    fontWeight: 600
    lineHeight: 1.5
  meta:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, -apple-system, Noto Sans Thai, Leelawadee UI, sans-serif"
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: 1.5
    fontFeature: "tnum"
  figure:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, -apple-system, Noto Sans Thai, Leelawadee UI, sans-serif"
    fontSize: "22px"
    fontWeight: 650
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
  mono:
    fontFamily: "Cascadia Code, Cascadia Mono, JetBrains Mono, ui-monospace, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  pill: "999px"
spacing:
  2xs: "4px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
components:
  button:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "0 11px"
    height: "30px"
  button-hover:
    backgroundColor: "{colors.surface-3}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.sm}"
    padding: "0 11px"
    height: "30px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.sm}"
    height: "30px"
  button-attn:
    backgroundColor: "{colors.attn}"
    textColor: "oklch(0.22 0.04 70)"
    rounded: "{rounded.sm}"
    height: "30px"
  button-hold:
    backgroundColor: "{colors.hold}"
    textColor: "oklch(0.18 0.04 25)"
    rounded: "{rounded.sm}"
    height: "30px"
  icon-button:
    textColor: "{colors.text-2}"
    rounded: "{rounded.sm}"
    size: "30px"
  icon-button-on:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-2}"
    rounded: "{rounded.pill}"
    padding: "0 9px"
    height: "26px"
  input:
    backgroundColor: "{colors.bg-sunk}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "34px"
  key:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-2}"
    typography: "{typography.mono}"
    rounded: "5px"
    height: "24px"
  room-row:
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "8px"
  room-row-current:
    backgroundColor: "{colors.surface-2}"
  prompt-card:
    backgroundColor: "{colors.attn-soft}"
    rounded: "{rounded.lg}"
    padding: "12px"
  output:
    backgroundColor: "{colors.bg-sunk}"
    textColor: "{colors.text-2}"
    rounded: "{rounded.lg}"
  panel:
    backgroundColor: "{colors.rail}"
    width: "380px"
  popover:
    backgroundColor: "{colors.surface-2}"
    rounded: "{rounded.lg}"
    padding: "6px"
---

# Design System: Agent Mission Control

## Overview

**Creative North Star: "The Night-Shift Triage Desk"**

The dashboard sits on a second monitor beside a row of terminals, usually at night, and it borrows their material: graphite tinted toward blue ink, hairline borders, flat panes. It is a desk with one path through it: who needs me, then what that room is doing, then act. The resting state is quiet so that the one thing asking for the human can be seen from across the room.

Density is that of a working tool, not a marketing page. Body text is 14px, metadata drops to 11.5–12.5px, and every number is tabular. Colour is rationed hard: one cool cyan signal for interaction and focus, and four status hues that each mean exactly one thing. Depth comes from tonal steps of the same graphite, never from decorative shadow; only things that float above the desk (popovers, dialogs, toasts) lift.

The language is Thai prose with English agent terms (Plan, Code, Verify, Done, TL;DR, Sub-Agent, tool names) mixed in one line, so the type stack carries a system Thai face and labels never rely on uppercase or tracking, which Thai cannot express.

**Key Characteristics:**
- Graphite surfaces on a single hue (255), stepped by lightness only.
- One signal accent (cyan, hue 205) for interaction, focus, selection and the resting meter.
- Four status hues with fixed meanings: amber needs you, blue working, green done, red quota hold.
- Hairline 1px borders, 6–10px radii, flat panes; shadow only on overlays.
- An authored line-icon set (24 grid, 1.75 stroke, round caps) drawn in currentColor; no emoji.
- Inbox + Focus: a grouped rail of rooms, one focused room, panels on demand.

## Colors

A single cool graphite family with one cyan signal and four semantic status hues, all defined in OKLCH, which is the normative source.

### Primary
- **Terminal Cyan** (`accent`): the only interaction colour. Primary buttons (filled, with `accent-ink` text), focus rings, the selected state of icon buttons, toggles and strip buttons (on `accent-soft`), switches, the caret, links, the "Claude" turn marker in output, and the resting fill of every meter. It is also the brand mark's colour.
- **Deep Ink** (`accent-ink`): text and glyphs set on a filled cyan surface.

### Secondary (status hues; meaning only)
- **Lamp Amber** (`attn`, with `attn-soft` fill and `attn-line` border): needs you. The attention count in the top bar, the "รอคุณ" rail group, the pending prompt card, its cursor option, the current stage step when the room waits on the human.
- **Working Blue** (`work`, `work-soft`): working. The spinning status glyph and the current stage step of a running room.
- **Done Green** (`done`, `done-soft`): done. Finished stage steps, finished-room glyphs, the connection dot when live, success toasts, the A/U file badge.
- **Hold Red** (`hold`, `hold-soft`, `hold-line`, with `hold-text` for emphasis on red fills): quota hold. The hold banner, the held-room notice, the held composer, the "resume now" button, and the meter fill below the hold threshold.
- **Diff Green / Diff Red** (`add` / `add-bg`, `del` / `del-bg`): line additions and deletions in diffs and the +/− deltas beside files. They share hue with done and hold but are separate tokens so diff colour never has to change when status colour does.

### Neutral
- **Night Desk** (`bg`): page background, top bar, icon strip, IDE overlay.
- **Sunk Well** (`bg-sunk`): wells that hold machine text or input: live output, code views, search, text and number fields, segmented controls.
- **Rail Graphite** (`rail`): the room rail, side panels, the IDE file list.
- **Surface / Surface 2 / Surface 3** (`surface`, `surface-2`, `surface-3`): three raised steps. Cards, chips and notices sit on `surface`; buttons, the current room and popovers on `surface-2`; hover states, pressed segments, badges, toasts and meter tracks on `surface-3`.
- **Hairline / Soft Hairline** (`line`, `line-soft`): every border and divider. `line-soft` separates regions; `line` outlines controls and the current selection.
- **Text / Text 2 / Text 3** (`text`, `text-2`, `text-3`): primary copy; secondary copy and resting icon buttons; metadata, placeholders, counts and inactive labels.

### Named Rules
**The Meaning-Only Rule.** Status hues carry meaning only: amber means needs you, blue means working, green means done or a diff addition, red means quota hold or a diff deletion. Never use them for decoration, category or emphasis.

**The One Signal Rule.** Cyan is the only colour that says "you can act here" or "this is selected". It never stands in for a status.

**The Rising Meter Rule.** Meters fill with the accent at rest and shift to amber, then red, as they near a limit. The 5-hour usage meter turns amber below 25% remaining and red below the hold threshold (8% by default); the context meter turns amber above 60% and red above 85%.

**The Neutral Modification Rule.** A modified file's M badge is neutral (`text-2` on `surface-2`). Only additions (A, U) take green and deletions (D) take red, so the file list is not a field of colour.

## Typography

**Display Font:** none; the system has no display face.
**Body Font:** Segoe UI Variable Text (with Segoe UI, system-ui, -apple-system, then Noto Sans Thai and Leelawadee UI for Thai)
**Label/Mono Font:** Cascadia Code (with Cascadia Mono, JetBrains Mono, ui-monospace, Consolas)

**Character:** The native Windows UI face, the same one the terminals' chrome uses, paired with the terminal's own mono. It reads as part of the desktop, not as a branded site, and it renders Thai and Latin in one line without a seam.

### Hierarchy
- **Headline** (650, 19px, 1.25, −0.015em): the focused room's name. One per view.
- **Title** (650, 14.5–16px, 1.4): the prompt question, dialog and empty-state headings, panel titles (14px), the brand name.
- **Body** (400, 14px, 1.5): TL;DR, composer, general copy. Output prose runs at 13.5px, 1.6, capped at 80ch.
- **Body Small** (400, 13px): list rows, popover items, form fields, toasts.
- **Label** (600–650, 12.5px): rail group heads, stage steps, segment buttons, panel section heads, button text (13px, 550).
- **Meta** (500, 11.5–12px, tabular): timestamps, token counts, file paths under names, tile footers.
- **Figure** (650, 22px, tabular, −0.01em): the one large number, remaining usage in the Usage panel.
- **Mono** (400, 12.5px, 1.6): live output in raw mode, code and diff views, code blocks, inline code (0.88em), tool lines, branch names, keycaps, file status badges and diff deltas.

### Named Rules
**The Mono-for-Machine Rule.** Mono marks text that came from or goes to the machine: code, paths, branches, tool calls, keys, diff counts. Human-facing numbers (tokens, cost, percentages, times) stay in the UI face with tabular figures.

**The Sentence-Case Label Rule.** Group heads and section labels are sentence case, set apart by weight (650) and `text-3` colour, never by uppercase or letter-spacing, because the Thai half of every label has no case.

## Layout

A full-height application grid, no page scroll on desktop. Rows: a 48px top bar, an optional hold banner, then the app frame. The frame is three columns: a 300px rail, a fluid focus column, and an inspector made of an optional 380px panel plus a 60px icon strip on the right edge. (The direction contract sketched a 48px strip; the build settled on 60px so the strip buttons can carry Thai labels under their icons.)

The focus column stacks room header (name, branch/model/tokens/context chips), the 4-step stage stepper, the prompt card when one is pending, a one-line TL;DR, live output filling the remaining height, and the composer pinned at the bottom. Gaps inside the focus column are 12px; its padding is 16px top and 20px sides. The rail pads 12px, rows 8px. A grid view swaps rail and focus for an overview of 250px-minimum tiles in an auto-fill grid with 8px gaps.

Spacing steps on 4, 6, 8, 12, 16, 20px. Control heights are 26px (small), 30px (default), 32–34px (search, text inputs).

Responsive: at 1180px the rail narrows to 260px and the panel to 340px. At 900px the page becomes a single scrolling column (rail above focus), the brand name and secondary meter text hide, the icon strip becomes a fixed 58px bottom bar, and panels become a bottom sheet (70vh, top corners rounded 10px). The IDE overlay stacks its file list above the code.

## Elevation & Depth

The desk is flat. Depth is tonal: `bg-sunk` below the page for wells, `bg` for the page, `rail` and `surface` through `surface-3` for raised steps, all on one hue so the eye reads lightness as height. Borders, not shadows, separate panes. Only elements that float above the desk carry shadow, tinted with the same blue-black.

### Shadow Vocabulary
- **Popover lift** (`box-shadow: 0 12px 32px -6px oklch(0.05 0.01 255 / 0.65), 0 2px 6px oklch(0.05 0.01 255 / 0.4)`): model/effort and "more" popovers.
- **Dialog lift** (`box-shadow: 0 24px 60px -12px oklch(0.05 0.01 255 / 0.7)`, backdrop `oklch(0.1 0.01 255 / 0.6)`): the new-room dialog.
- **Toast lift** (`box-shadow: 0 12px 28px -8px oklch(0.05 0.01 255 / 0.7)`): transient confirmations.

### Named Rules
**The Overlays-Only Lift Rule.** Nothing that sits in the layout casts a shadow. Shadow means "this floats and will go away".

## Shapes

Gently rounded rectangles throughout: 6px for controls (buttons, inputs, segments, file rows), 8px for rows, notices, tiles and toasts, 10px for the large containers (prompt card, output well, composer, popovers, dialogs, bottom sheets). 4px for tiny tags (TL;DR label, inline code, file badges). Pills (999px) are reserved for chips and the attention count. Keycaps are 5px with a 2px bottom border, the one place the system imitates a physical object. Status and stage icons sit in circles. All borders are 1px hairlines; the only dashed border is the "connect" hint card, echoing the dashed idle glyph.

## Components

### Buttons
Compact and quiet; colour appears only where it means something.
- **Shape:** 6px radius, 30px high (26px small), 11px side padding, 13px/550 text, 6px icon gap.
- **Default:** `surface-2` with a `line` border; hover steps to `surface-3`.
- **Primary:** filled cyan with `accent-ink` text; hover lightens to `oklch(0.86 0.09 205)`. One per region (New room, Send).
- **Ghost:** transparent, `text-2`; hover fills `surface-2` and brightens text.
- **Attention / Hold:** amber or red fills with dark ink, used only for actions that resolve that status (resume now during a hold).
- **Icon button:** 30px (26px small) square, `text-2`; hover `surface-2`; selected state cyan on `accent-soft`.
- **Focus:** a 2px cyan outline offset 2px, everywhere. Disabled: 45% opacity, not-allowed cursor.
- **Transitions:** background, border and colour over 120ms.

### Chips
- **Style:** 26px pill, `surface` fill, `line-soft` border, `text-2` at 12.5px, 6px gap for a leading 14px icon. Used for branch, model/effort, tokens/cost and context in the room header, and for quick actions under the composer.
- **State:** clickable chips brighten to `surface-2` and `line` on hover. Toggle chips go cyan on `accent-soft` when pressed. The held-note chip under the composer takes the hold treatment.

### Cards / Containers
- **Corner Style:** 8px (notices, tiles), 10px (prompt card, output, composer).
- **Background:** `surface` for notices and tiles; `bg-sunk` for the output well; the prompt card uses `attn-soft` with an `attn-line` border; hold notices use `hold-soft` with `hold-line`.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Internal Padding:** 11–14px for notices and tiles, 12px for the prompt card, 12px/16px inside output.

### Inputs / Fields
- **Style:** `bg-sunk` well, `line` (or `line-soft` for search) 1px border, 6px radius, 28–34px high, cyan caret.
- **Focus:** the border turns cyan; no glow. The composer box behaves the same and turns to the hold treatment while rooms are held.
- **Switch:** 34×20 track on `surface-3`, cyan when on, with the knob in `accent-ink`; the knob slides on the standard ease-out.

### Navigation
- **Rail:** a search well, a Live/History segmented control, then rooms grouped by attention ("รอคุณ", working, idle/done) with sentence-case group heads in 12px/650 `text-3`; the attention group head is amber.
- **Room row:** a 20px status glyph, name (13.5px/600) over four stage dots and the active tool, with age and token count right-aligned in tabular meta. Hover `surface`; the current room sits on `surface-2` with a `line` border.
- **Icon strip:** 50px-wide stacked icon-over-label buttons (10.5px/600) for Files, Agents, History, Usage, with a neutral count badge; pressed state cyan on `accent-soft`.
- **Segmented control:** a `bg-sunk` track with 2px inset; the pressed segment lifts to `surface-3`.

### Prompt Card (signature)
The one amber container. It holds the pending permission question (14.5px/650), numbered options as rows with keycaps, the cursor option outlined in amber with an amber "Enter" hint, and a row of keycap buttons (up, down, enter, Esc). It appears only when a prompt is pending and sits directly under the stepper, above everything else the room says.

### Stage Stepper (signature)
Four 24px circular steps joined by 1px lines: finished steps green, the current step blue (amber when it waits on the human), future steps neutral. The rail repeats it as four 5px dots.

### Status Glyphs
Each room state maps to one authored glyph: needs you is an amber diamond with an exclamation, working is a blue spinner (1.1s linear rotation), done is a green check-circle, held is a red pause-circle, idle is a dashed neutral ring, closed is a neutral circle with a bar. Shape and colour both carry the state, so it reads without colour.

### Icons
An authored set on a 24-unit grid, stroked at 1.75 with round caps and joins, drawn in `currentColor` with no fill, rendered at 13–18px. Icons inherit their colour from context; they are never multicolour.

### Usage Meter
A 30px top-bar control: label "5h", an 84px × 6px bar on `surface-3` with a 2px threshold mark, the remaining percentage in tabular 650 weight. It opens the Usage panel. The fill follows the Rising Meter Rule.

### Side Panels and IDE Overlay
Panels slide in from the right over 180ms on the standard ease-out (10px travel plus fade) on `rail`, with a 14px/650 heading and hairline-separated sections. Files open in a full-screen IDE overlay (160ms scale-in from 0.985) with a 280px file list, diff and source tabs, a mono code table with tabular line numbers, and `add-bg`/`del-bg` row tints with +/− gutters.

### Motion
One easing, `cubic-bezier(0.16, 1, 0.3, 1)`, for everything that enters. Colour changes take 120–140ms; panels, popovers, overlays and toasts enter in 140–180ms with a short translate or scale. Under reduced motion every animation and transition collapses to near-instant.

## Do's and Don'ts

### Do:
- **Do** keep status hues to their single meanings: amber needs you, blue working, green done or a diff addition, red quota hold or a diff deletion.
- **Do** fill meters with the accent and shift them to amber, then red, as they near a limit.
- **Do** keep the M file badge neutral; only A/U go green and D goes red.
- **Do** show approval keycaps (up, down, enter, Esc) only on the prompt card.
- **Do** open side panels only on click, and never restore an open panel on reload.
- **Do** leave rooms that are idle or done during a quota hold in their own state; only rooms that had work in flight show the hold.
- **Do** step depth by tonal surfaces on hue 255 and separate regions with 1px hairlines.
- **Do** draw every icon from the authored 24-grid, 1.75-stroke set in `currentColor`.
- **Do** set numbers in tabular figures and machine text in the mono face.

### Don't:
- **Don't** use emoji as icons, anywhere, including status, buttons and toasts.
- **Don't** use a status hue for decoration, grouping or emphasis, and don't use cyan to signal a status.
- **Don't** put shadows on anything that sits in the layout; only popovers, dialogs and toasts lift.
- **Don't** uppercase or letter-space labels; separate them with weight and `text-3`.
- **Don't** repeat the same pending prompt in more than one place on the screen.
