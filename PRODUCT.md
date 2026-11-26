# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is the author: a developer on Windows who runs many Claude Code (`claude`) sessions at once, each in its own terminal tab (Windows Terminal, PowerShell, WezTerm, VS Code terminal), often one room per git worktree. Their job is to keep every session moving without paying the context-switching cost of reading back through each tab's scrollback.

Other Claude Code power users are a secondary, later audience. The project is MIT-licensed and public, but the author's own workflow decides design trade-offs. Public readiness must not slow the core loop down.

## Product Purpose

Agent Mission Control (`amc`) is a local server and web dashboard (`http://127.0.0.1:4310`) that collects state from every Claude Code session through lifecycle hooks and transcript parsing, then shows it in one place. Instead of checking each tab by hand (pull), sessions report in on their own (event-driven push).

It succeeds when the user can glance at one screen and know:
- which rooms are waiting on them (permission prompts, approvals, errors),
- where each room is in its workflow,
- what each room last did, without reading the log,
- and when they can act on a room straight from the dashboard.

## Positioning

The dashboard doesn't just monitor; it also sends commands back. It reads real Claude Code hook events and transcripts with no configuration per tab, and it can send keystrokes, approvals and prompts back into the live sessions (Windows console bridge, WezTerm IPC, the `amc run` wrapper, `claude --resume`). It is built around the Claude Code lifecycle (Plan → Code → Verify → Done, sub-agents spawned through `Task`, permission prompts) rather than generic terminal multiplexing.

## Operating Context

- The dashboard is open beside the terminals, often on a second screen. It is used **equally as a glanceable monitor and as a command center**: monitoring is the resting state, and acting on a room (approve, send a command, ask for a summary, launch a room) has to take only a click or two.
- Rooms are discovered on their own once `amc install-hooks` has run. They can be named with `$env:AMC_ROOM`, or launched from the dashboard (new Windows Terminal tab or a headless background run).
- CLI companions: `amc start`, `amc status` (summary table in the terminal), `amc install-hooks` / `uninstall-hooks`, `amc run --room "<name>" claude`.
- The usage quota guard watches combined token and cost use across sessions in a rolling 5-hour window. Below a threshold (8% remaining by default) it saves a checkpoint for each session, interrupts them safely, and resumes them all when the window resets.
- Moving to a new machine is a supported workflow (one-command `setup.ps1` / `setup.sh`).

## Capabilities and Constraints

- **Core features:** 4-stage workflow pipeline per room (`1. Plan` → `2. Code` → `3. Verify` → `4. Done`); Auto-TL;DR pulled from the transcript; a live tree of the main agent and its sub-agents, with status and the tool currently running; an attention queue that floats rooms needing a decision to the top; a two-way command center; a chat/terminal view with Markdown rendering and turn history; the usage guard.
- **Stack:** pure Node.js >= 18 with zero external dependencies. The frontend is a hand-written `public/index.html` plus `public/app.js`, with no framework and no build step. Keep it portable across OSes; no native modules.
- **Security (binding):** listens only on 127.0.0.1. Every `/api/*` call needs the `X-AMC-Token` header (token stored in `~/.agent-mission-control/token`). Host and Origin are restricted to the local machine, and there is no wildcard CORS. Shell commands are never built from strings; room names and paths reach PowerShell as quoted literals through `-EncodedCommand`. The UI has no inline JS with embedded data: actions use `data-act` with event delegation, so terminal text can never run as code. All rendered terminal and transcript content must be treated as untrusted.
- **Terminology:** "room" (ห้อง) = one agent session/tab; "Main Agent" / "Sub-Agents"; "Attention Queue"; "TL;DR"; workflow stage names as above.
- **Undecided:** how wide the public, non-Windows audience gets supported (macOS/Linux/WSL setup exists, but the console bridge is Windows-first).

## Brand Commitments

- Name: **Agent Mission Control**, short form `amc` (also the CLI command).
- **UI language:** Thai prose with English technical terms (Plan/Code/Verify/Done, Approve, TL;DR, Sub-Agent, Tool names). Keep this mix; do not translate agent and tool terms, and do not switch to English-only. Document `lang` is `th`, so text has to render Thai well.
- README and docs are written in the same Thai + English style.

## Evidence on Hand

- `README.md`: problem statement, feature list, setup, CLI table, security model.
- `docs/ARCHITECTURE_AND_DESIGN.md`: the 4-layer architecture, how tool events map to stages, sub-agent tree extraction, the command bridge.
- `docs/WORKFLOW_PLAYBOOK.md`: git worktrees, WezTerm/Windows Terminal pairing, the machine-migration checklist.
- `test/verify.js`, `test/security.test.js`: tests for behaviour and security.
- There are no screenshots, demo recordings, user testimonials, usage metrics or adoption numbers. Do not make any up.

## Product Principles

1. **Glance first, act second.** The resting state answers "who needs me?" in under a second. Actions sit one or two clicks from that answer, never behind navigation.
2. **Attention is the scarce resource.** Rooms waiting on the human outrank everything else, and quiet rooms stay quiet.
3. **Summaries over scrollback.** Show the distilled state (stage, TL;DR, active tool, sub-agents) and keep the raw log one step away.
4. **Local, safe, and dependency-free.** Never trade the security model or zero-dependency portability for a feature.
5. **Built for the author's workflow, readable by strangers.** Optimise for heavy daily multi-tab use, while keeping setup and copy clear enough to share publicly.
