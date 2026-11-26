const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadOrCreateToken, deriveHookToken } = require('./security');

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Notification',
  'SubagentStop',
  'Stop',
  'SessionEnd',
];

// Claude Code only allows command hooks on SessionStart. Every other event is posted over HTTP
// by Claude Code itself, which starts no process (a command hook is bash -> bash -> node).
const HTTP_HOOK_EVENTS = HOOK_EVENTS.filter((evt) => evt !== 'SessionStart');
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);
const HOOK_ENDPOINT_PATH = '/api/hook/claude';
const DEFAULT_PORT = 4310;
const HTTP_HOOK_TIMEOUT_SECONDS = 5;
const OUR_HTTP_HOOK_URL = /^http:\/\/127\.0\.0\.1:(\d+)\/api\/hook\/claude$/;

// Terminal ids the hook script used to read from its own environment. Claude Code fills these
// header values from its environment; a variable that is not set arrives as an empty string.
const FORWARDED_ENV_HEADERS = {
  'X-AMC-WT-Session': 'WT_SESSION',
  'X-AMC-Pane': 'WEZTERM_PANE',
  'X-AMC-Tmux-Pane': 'TMUX_PANE',
};

function getClaudeSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function getHookScriptPath() {
  return path.resolve(__dirname, '..', 'hooks', 'claude-hook.js');
}

function buildHookCommand(eventName) {
  const scriptPath = getHookScriptPath().replace(/\\/g, '/');
  return `node "${scriptPath}" ${eventName}`;
}

function validPort(port) {
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function buildHttpHook(port, hookToken) {
  const headers = { 'X-AMC-Token': hookToken };
  for (const [header, envVar] of Object.entries(FORWARDED_ENV_HEADERS)) {
    headers[header] = `$${envVar}`;
  }
  return {
    type: 'http',
    url: `http://127.0.0.1:${port}${HOOK_ENDPOINT_PATH}`,
    timeout: HTTP_HOOK_TIMEOUT_SECONDS,
    headers,
    allowedEnvVars: Object.values(FORWARDED_ENV_HEADERS),
  };
}

/** The hook script: every event in older versions, SessionStart in this one. */
function isOurCommandHook(hook) {
  return Boolean(hook) && typeof hook.command === 'string' && hook.command.includes('claude-hook.js');
}

/** An HTTP hook that posts to a Mission Control server: any, or the one on `port`. */
function isOurHttpHook(hook, port) {
  if (!hook || hook.type !== 'http' || typeof hook.url !== 'string') return false;
  const match = hook.url.match(OUR_HTTP_HOOK_URL);
  return Boolean(match) && (port === undefined || Number(match[1]) === port);
}

function isOurHook(hook) {
  return isOurCommandHook(hook) || isOurHttpHook(hook);
}

/** The hooks of an entry; very old settings stored a hook directly as the entry. */
function hooksOf(entry) {
  if (!entry || typeof entry !== 'object') return [];
  return Array.isArray(entry.hooks) ? entry.hooks : [entry];
}

/**
 * An event's entries without the hooks `shouldRemove` picks. Only those hooks go: a hook the
 * user put in the same entry as ours stays, in its entry.
 */
function withoutHooks(entries, shouldRemove) {
  const kept = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) {
      if (!shouldRemove(entry)) kept.push(entry);
      continue;
    }
    const remaining = entry.hooks.filter((hook) => !shouldRemove(hook));
    if (remaining.length === entry.hooks.length) kept.push(entry);
    else if (remaining.length > 0) kept.push({ ...entry, hooks: remaining });
  }
  return kept;
}

/**
 * Reads settings.json. A file that exists but does not parse is reported, never replaced:
 * Claude Code may be in the middle of writing it, or the user may have left a typo in it.
 */
function loadSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return { settings: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'settings.json ไม่ใช่ JSON object จึงไม่ได้แก้ไขไฟล์' };
    }
    return { settings: parsed };
  } catch (err) {
    return { error: `settings.json อ่านไม่ได้ จึงไม่ได้แก้ไขไฟล์ (${err.message})` };
  }
}

function saveSettings(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

/**
 * Checks whether Agent Mission Control hooks are currently installed in ~/.claude/settings.json.
 * With `options.port`, HTTP hooks count only when they post to the server on that port: hooks
 * that feed another instance are not "connected" for this one.
 */
function checkHooksStatus(options = {}) {
  const settingsPath = getClaudeSettingsPath();
  const loaded = loadSettings(settingsPath);
  if (loaded.error) {
    return { installed: false, settingsPath, error: loaded.error, installedEvents: [] };
  }

  const port = validPort(options.port);
  const counts = (hook) => isOurCommandHook(hook) || isOurHttpHook(hook, port);
  const hooks = loaded.settings.hooks || {};
  const installedEvents = HOOK_EVENTS.filter(
    (evt) => Array.isArray(hooks[evt]) && hooks[evt].some((entry) => hooksOf(entry).some(counts))
  );
  return {
    installed: installedEvents.length >= 4,
    settingsPath,
    installedEvents,
  };
}

/**
 * Merges Agent Mission Control lifecycle hooks into ~/.claude/settings.json, replacing the
 * hooks an earlier install (of either kind, for any port) left there: the server started last
 * owns the hooks. Other hooks are kept.
 *
 * `options.token` is the API token; what is written is the hook-only token derived from it.
 */
function installClaudeHooks(options = {}) {
  const settingsPath = getClaudeSettingsPath();
  const loaded = loadSettings(settingsPath);
  if (loaded.error) {
    return { installed: false, settingsPath, error: loaded.error, installedEvents: [] };
  }

  const port = validPort(options.port) || DEFAULT_PORT;
  const hookToken = deriveHookToken(options.token || loadOrCreateToken());
  const settings = loaded.settings;
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }

  for (const evt of HOOK_EVENTS) {
    const kept = Array.isArray(settings.hooks[evt])
      ? withoutHooks(settings.hooks[evt], isOurHook)
      : [];
    const hook = HTTP_HOOK_EVENTS.includes(evt)
      ? buildHttpHook(port, hookToken)
      : { type: 'command', command: buildHookCommand(evt) };
    kept.push(MATCHER_EVENTS.has(evt) ? { matcher: '*', hooks: [hook] } : { hooks: [hook] });
    settings.hooks[evt] = kept;
  }

  saveSettings(settingsPath, settings);
  return checkHooksStatus({ port });
}

/**
 * Removes Agent Mission Control hooks from ~/.claude/settings.json: all of them, or with
 * `options.port` only what the server on that port owns, so that one instance stopping does
 * not disconnect another. The SessionStart script hook is shared; it goes when no instance's
 * HTTP hooks are left.
 */
function uninstallClaudeHooks(options = {}) {
  const settingsPath = getClaudeSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return { uninstalled: true, settingsPath };
  }
  const loaded = loadSettings(settingsPath);
  if (loaded.error) {
    return { uninstalled: false, settingsPath, error: loaded.error };
  }

  const settings = loaded.settings;
  if (settings.hooks && typeof settings.hooks === 'object') {
    const port = validPort(options.port);
    const strip = (shouldRemove) => {
      for (const evt of Object.keys(settings.hooks)) {
        if (Array.isArray(settings.hooks[evt])) {
          settings.hooks[evt] = withoutHooks(settings.hooks[evt], shouldRemove);
        }
      }
    };

    if (port === undefined) {
      strip(isOurHook);
    } else {
      strip((hook) => isOurHttpHook(hook, port));
      const anotherInstanceLeft = Object.values(settings.hooks).some(
        (entries) =>
          Array.isArray(entries) &&
          entries.some((entry) => hooksOf(entry).some((hook) => isOurHttpHook(hook)))
      );
      if (!anotherInstanceLeft) strip(isOurCommandHook);
    }

    for (const evt of Object.keys(settings.hooks)) {
      if (Array.isArray(settings.hooks[evt]) && settings.hooks[evt].length === 0) {
        delete settings.hooks[evt];
      }
    }
  }

  saveSettings(settingsPath, settings);
  return { uninstalled: true, settingsPath };
}

/*
 * Earlier versions pointed Claude Code's statusline at hooks/statusline.js, which pushed plan
 * usage to the dashboard on every render. Usage is now checked on request (src/usage-check.js)
 * and that script is gone, so only the clean-up remains: put back the statusline that was there
 * before (kept in ~/.agent-mission-control/statusline-previous.json), or remove ours.
 */
const STATUSLINE_MARKER = 'hooks/statusline.js';

function getPreviousStatuslineFile() {
  return path.join(os.homedir(), '.agent-mission-control', 'statusline-previous.json');
}

function isOurStatusline(statusLine) {
  return Boolean(
    statusLine &&
      typeof statusLine.command === 'string' &&
      statusLine.command.replace(/\\/g, '/').includes(STATUSLINE_MARKER)
  );
}

/** Whether the old usage-bridge statusline is still configured in ~/.claude/settings.json. */
function checkStatuslineStatus() {
  const settingsPath = getClaudeSettingsPath();
  const { settings, error } = loadSettings(settingsPath);
  if (error) return { installed: false, settingsPath, error };
  return { installed: isOurStatusline(settings.statusLine), settingsPath };
}

/** Restores the statusline configured before the old usage bridge, or removes ours. */
function uninstallStatusline() {
  const settingsPath = getClaudeSettingsPath();
  const { settings, error } = loadSettings(settingsPath);
  if (error) return { installed: false, removed: false, settingsPath, error };
  if (!isOurStatusline(settings.statusLine)) return { installed: false, removed: false, settingsPath };
  const prevFile = getPreviousStatuslineFile();
  let previous = null;
  try {
    const raw = JSON.parse(fs.readFileSync(prevFile, 'utf8'));
    if (raw && typeof raw === 'object' && typeof raw.command === 'string') previous = raw;
  } catch {}
  if (previous) settings.statusLine = previous;
  else delete settings.statusLine;
  saveSettings(settingsPath, settings);
  fs.rmSync(prevFile, { force: true });
  return { installed: false, removed: true, restored: Boolean(previous), settingsPath };
}

module.exports = {
  checkStatuslineStatus,
  uninstallStatusline,
  HOOK_EVENTS,
  HTTP_HOOK_EVENTS,
  HOOK_ENDPOINT_PATH,
  getClaudeSettingsPath,
  getHookScriptPath,
  checkHooksStatus,
  installClaudeHooks,
  uninstallClaudeHooks,
};
