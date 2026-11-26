# Zero-spawn hooks: design

Date: 2026-11-26. Status: approved in conversation ("ลุยตามคำแนะนำ").

## Why

On a machine where every process creation costs 1–2 s (three endpoint-security products inject
into each new process), Mission Control made Claude Code sessions freeze: typing and Esc stopped
responding. Measured over 40 s, AMC caused about 70% of all process creation on the machine:

| Source | Processes per minute |
|---|---|
| hooks (9 events, each `bash -> bash -> node` + conhost) | ~51 |
| statusline (same chain, on every new message) | ~53 |
| server git polling (`rev-parse` + `status` every 5 s per folder) | ~52 |

Each spawn also blocks the spawning process's event loop for 0.13–1.8 s, which is what freezes
the Claude Code UI.

## Goals

- Hook events reach the server without creating any process.
- The server stops spawning git on a timer.
- When the server is not running, Claude Code sessions pay nothing and show no hook warnings.

## Non-goals

- Changing the console scanner, the usage guard or the dashboard.
- The statusline bridge: it stays opt-in (`amc install-statusline`) and is left as is, apart from
  the broken CLI import.
- Removing the legacy `/api/hook` endpoint or `hooks/claude-hook.js`.

## Anti-goal

Mission Control must never damage `~/.claude/settings.json`. It is rewritten on every server
start and stop now, so a settings file that cannot be parsed is left untouched.

## Approaches

1. **HTTP hooks (chosen).** Claude Code's `type: "http"` hook posts the event itself. A spike on
   Claude Code 2.1.332 showed: zero processes for five events (the command version made about
   20), 18.5 s against 42.9 s for the same task, `{"decision":"block"}` works for
   `UserPromptSubmit`, and the server's current reply shape is accepted.
2. **Drop the tool hooks and follow the transcript.** No hook for `PreToolUse`/`PostToolUse`; the
   server derives tool activity from the transcript it already reads. More work (the "working"
   state and `AskUserQuestion` handling move to the transcript) and keeps command hooks for the
   rest. Kept as the fallback if HTTP hooks turn out unusable.
3. **OpenTelemetry receiver.** Largest redesign, needs env vars in every shell, tool details are
   off by default, and it has no permission or notification events. Dropped.

## Design

**Hook entries.** `SessionStart` stays a command hook (Claude Code does not allow HTTP there; it
runs once per session). The other eight events become:

```json
{ "type": "http", "url": "http://127.0.0.1:<port>/api/hook/claude", "timeout": 5,
  "headers": { "X-AMC-Token": "<token>", "X-AMC-WT-Session": "$WT_SESSION",
               "X-AMC-Pane": "$WEZTERM_PANE", "X-AMC-Tmux-Pane": "$TMUX_PANE" },
  "allowedEnvVars": ["WT_SESSION", "WEZTERM_PANE", "TMUX_PANE"] }
```

`<token>` is not the API token: it is a hook-only token derived from it (HMAC), accepted on the
hook route and nowhere else. `settings.json` is not a private file the way the token file is,
and the API token can send text into terminals.

Installing replaces older command entries (`claude-hook.js`) and Mission Control hooks for any
port; uninstalling removes both kinds. Hooks are removed one by one, so a hook the user put in
the same entry as ours stays.

**Endpoint `POST /api/hook/claude`.** Same token check as the rest of the API. It answers before
it processes, because Claude Code waits for the answer before running the tool:

- `UserPromptSubmit` during a usage hold, for a non-automated session: `{"decision":"block","reason":"…"}`.
- Anything else: `{}` at once, then the event is processed on the next tick.

**Finding the Claude process.** `$CLAUDE_PID` is empty in hook headers, so the server maps
`session_id` to a pid through `~/.claude/sessions/<pid>.json` (`{ pid, sessionId, entrypoint }`).
That folder is internal to Claude Code and undocumented: any read problem means "no pid", and
the store's existing session-id and folder matching takes over. One folder scan is reused for
2 s, but a session id that is not in it triggers a fresh scan, so a session that has just
started is recognised on its first event (whether it is a scripted run is decided from this).

**Git.** The branch is read from `.git/HEAD` (following a `gitdir:` pointer for worktrees), with
no process. The dirty-file count still needs `git status --porcelain`; it runs asynchronously
only, at most once every 30 s per folder, only when an event or scan asks, and never for a folder
that is not in a repository. The first answer for a folder is 0 until the first refresh lands.

**Lifecycle.** `amc start` installs the hooks once the server is listening and removes them on
SIGINT, SIGTERM, SIGHUP, SIGBREAK and process exit. `--no-manage-hooks` (or
`AMC_MANAGE_HOOKS=0`) keeps the old manual behavior. If the server is killed hard the hooks stay
until the next start or `amc uninstall-hooks`; Claude Code then shows "hook gave no usable
answer" warnings but does not block. If the hooks cannot be removed at shutdown, the server
says so before it exits.

With more than one server running (different ports), the one started last owns the hooks. A
server that stops removes only the hooks for its own port, and the hook status a server reports
counts only hooks that post to it.

**Settings safety.** If `settings.json` cannot be parsed, install and uninstall do nothing and
report the error (install used to replace the file with hooks only). The file is written in
place, as before: writing a temp file and renaming it over the original was considered and
dropped, because a rename turns a symlinked `settings.json` (dotfiles setups) into a plain file.

**Room names.** `AMC_ROOM` is not forwarded as a header: a name with non-ASCII characters is not
a valid header value and would fail every hook request. It still arrives through the
`SessionStart` command hook, so a session started before the server keeps its folder name until
its next `SessionStart`.

## Left to the builder

File layout, cache sizes, test helper names.

## Not verified

`PermissionRequest`, `Notification` and `SubagentStop` over HTTP: a headless run does not fire
them. How the failure warnings look in the interactive UI.
