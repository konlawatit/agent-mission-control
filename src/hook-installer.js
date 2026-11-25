const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
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
      // Backup unreadable file before modifying
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

    // Remove any older claude-hook.js entry to avoid duplicates
    settings.hooks[evt] = settings.hooks[evt].filter((entry) => {
      const innerHooks = Array.isArray(entry.hooks) ? entry.hooks : [entry];
      return !innerHooks.some(
        (h) =>
          typeof h.command === 'string' && h.command.includes('claude-hook.js')
      );
    });

    const hookEntry =
      evt === 'PreToolUse' || evt === 'PostToolUse'
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

module.exports = {
  HOOK_EVENTS,
  getClaudeSettingsPath,
  getHookScriptPath,
  checkHooksStatus,
  installClaudeHooks,
  uninstallClaudeHooks,
};
