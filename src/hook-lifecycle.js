/**
 * Ties the Claude Code hooks to the life of the server process: installed while it runs,
 * removed when it stops. A session whose hooks point at a server that is not there shows a
 * warning on every tool call, so the hooks must not outlive the server.
 */

// Ctrl+C, service stop, the terminal window being closed, Ctrl+Break.
const MANAGED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];

/**
 * Runs `install()` now and `uninstall()` once, on the first stop signal or process exit.
 * A stop signal is passed on to `onSignal` afterwards so the caller can shut down.
 * If the hooks could not be removed, `onUninstallFailed(message)` is told: shutting down still
 * goes ahead, but the person must know the hooks are still there.
 */
function attachManagedHooks({ proc, install, uninstall, onSignal, onUninstallFailed }) {
  let result;
  try {
    result = install();
  } catch (err) {
    result = { installed: false, error: err.message };
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    let failure = null;
    try {
      const outcome = uninstall();
      if (outcome && outcome.error) failure = String(outcome.error);
    } catch (err) {
      failure = err.message;
    }
    if (failure && onUninstallFailed) onUninstallFailed(failure);
  };

  for (const signal of MANAGED_SIGNALS) {
    proc.on(signal, () => {
      release();
      onSignal(signal);
    });
  }
  proc.on('exit', release);

  return { result, release };
}

module.exports = { attachManagedHooks, MANAGED_SIGNALS };
