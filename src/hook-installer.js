const fs = require('fs');
const path = require('path');
const os = require('os');

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

/**
 * Checks whether Agent Mission Control hooks are currently installed in ~/.claude/settings.json
 */
function checkHooksStatus() {
  const settingsPath = getClaudeSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return {
      installed: false,
      settingsPath,
      installedEvents: [],
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const hooks = raw.hooks || {};
    const installedEvents = [];

    for (const evt of HOOK_EVENTS) {
      const list = hooks[evt];
      if (Array.isArray(list)) {
        const found = list.some((entry) => {
          const innerHooks = Array.isArray(entry.hooks) ? entry.hooks : [entry];
          return innerHooks.some(
            (h) =>
              typeof h.command === 'string' &&
              h.command.includes('claude-hook.js')
          );
        });
        if (found) installedEvents.push(evt);
      }
    }

    return {
      installed: installedEvents.length >= 4,
      settingsPath,
      installedEvents,
    };
  } catch (err) {
    return {
      installed: false,
      settingsPath,
      error: err.message,
      installedEvents: [],
    };
  }
}

/**
 * Safely merges Agent Mission Control lifecycle hooks into ~/.claude/settings.json
 */
function installClaudeHooks() {
  const settingsPath = getClaudeSettingsPath();
  const claudeDir = path.dirname(settingsPath);

  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
      settings = {};
    }
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }

  for (const evt of HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[evt])) {
      settings.hooks[evt] = [];
    }

    settings.hooks[evt] = settings.hooks[evt].filter((entry) => {
      const innerHooks = Array.isArray(entry.hooks) ? entry.hooks : [entry];
      return !innerHooks.some(
        (h) =>
          typeof h.command === 'string' && h.command.includes('claude-hook.js')
      );
    });

    const hookEntry =
      evt === 'PreToolUse' || evt === 'PostToolUse' || evt === 'PermissionRequest'
        ? {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: buildHookCommand(evt),
              },
            ],
          }
        : {
            hooks: [
              {
                type: 'command',
                command: buildHookCommand(evt),
              },
            ],
          };

    settings.hooks[evt].push(hookEntry);
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return checkHooksStatus();
}

/**
 * Removes Agent Mission Control hooks from ~/.claude/settings.json
 */
function uninstallClaudeHooks() {
  const settingsPath = getClaudeSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return { uninstalled: true, settingsPath };
  }

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (settings.hooks && typeof settings.hooks === 'object') {
    for (const evt of Object.keys(settings.hooks)) {
      if (Array.isArray(settings.hooks[evt])) {
        settings.hooks[evt] = settings.hooks[evt].filter((entry) => {
          const innerHooks = Array.isArray(entry.hooks) ? entry.hooks : [entry];
          return !innerHooks.some(
            (h) =>
              typeof h.command === 'string' &&
              h.command.includes('claude-hook.js')
          );
        });
        if (settings.hooks[evt].length === 0) {
          delete settings.hooks[evt];
        }
      }
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return { uninstalled: true, settingsPath };
}

const STATUSLINE_MARKER = 'hooks/statusline.js';

function getStatuslineScriptPath() {
  return path.resolve(__dirname, '..', 'hooks', 'statusline.js');
}

function getPreviousStatuslineFile() {
  return path.join(os.homedir(), '.agent-mission-control', 'statusline-previous.json');
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

function isOurStatusline(statusLine) {
  return Boolean(
    statusLine &&
      typeof statusLine.command === 'string' &&
      statusLine.command.replace(/\\/g, '/').includes(STATUSLINE_MARKER)
  );
}

/** Whether the usage bridge statusline is configured in ~/.claude/settings.json. */
function checkStatuslineStatus() {
  const settingsPath = getClaudeSettingsPath();
  try {
    const settings = readSettings(settingsPath);
    const previous = fs.existsSync(getPreviousStatuslineFile());
    return {
      installed: isOurStatusline(settings.statusLine),
      wrapsPrevious: previous,
      settingsPath,
    };
  } catch (err) {
    return { installed: false, wrapsPrevious: false, settingsPath, error: err.message };
  }
}

/**
 * Points Claude Code's statusline at the usage bridge. An existing statusline is kept and
 * wrapped (the bridge runs it and prints its output), so the user's own line does not change.
 */
function installStatusline() {
  const settingsPath = getClaudeSettingsPath();
  const claudeDir = path.dirname(settingsPath);
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });

  let settings;
  try {
    settings = readSettings(settingsPath);
  } catch {
    // Never overwrite a settings file we cannot parse.
    return { ...checkStatuslineStatus(), installed: false, error: 'settings.json อ่านไม่ได้' };
  }

  const current = settings.statusLine;
  if (current && !isOurStatusline(current) && typeof current.command === 'string') {
    const prevFile = getPreviousStatuslineFile();
    fs.mkdirSync(path.dirname(prevFile), { recursive: true });
    fs.writeFileSync(prevFile, JSON.stringify(current, null, 2), 'utf8');
  }

  const scriptPath = getStatuslineScriptPath().replace(/\\/g, '/');
  settings.statusLine = {
    type: 'command',
    command: `node "${scriptPath}"`,
    ...(current && typeof current.padding === 'number' ? { padding: current.padding } : {}),
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return checkStatuslineStatus();
}

/** Restores the statusline that was configured before the bridge, or removes ours. */
function uninstallStatusline() {
  const settingsPath = getClaudeSettingsPath();
  const settings = readSettings(settingsPath);
  if (!isOurStatusline(settings.statusLine)) return checkStatuslineStatus();
  const prevFile = getPreviousStatuslineFile();
  if (fs.existsSync(prevFile)) {
    settings.statusLine = JSON.parse(fs.readFileSync(prevFile, 'utf8'));
    fs.unlinkSync(prevFile);
  } else {
    delete settings.statusLine;
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return checkStatuslineStatus();
}

module.exports = {
  checkStatuslineStatus,
  installStatusline,
  uninstallStatusline,
  HOOK_EVENTS,
  getClaudeSettingsPath,
  getHookScriptPath,
  checkHooksStatus,
  installClaudeHooks,
  uninstallClaudeHooks,
};
