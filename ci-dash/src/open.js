'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MODES = ['panel', 'tab', 'popup', 'quick'];
const DEFAULT_PANEL_AMOUNT = 0.2;

function readManifestId() {
  try {
    const manifest = fs.readFileSync(path.join(ROOT, 'herdr-plugin.toml'), 'utf8');
    const match = /^\s*id\s*=\s*"([^"]+)"/m.exec(manifest);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function readContext() {
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function resolveCwd(context) {
  const candidates = [context.workspace_cwd, context.focused_pane_cwd];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return '';
}

function defaultRun(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function parseMode(value) {
  const mode = String(value || '').toLowerCase();
  return MODES.includes(mode) ? mode : '';
}

function buildOpenArgs({
  pluginId,
  entrypoint,
  placement,
  direction,
  targetPaneId,
  cwd,
  workspaceId,
  focus = true,
}) {
  const args = ['plugin', 'pane', 'open', '--plugin', pluginId, '--entrypoint', entrypoint];
  if (placement) args.push('--placement', placement);
  if (direction) args.push('--direction', direction);
  if (targetPaneId) args.push('--target-pane', targetPaneId);
  // A target pane already identifies the workspace/tab; passing --workspace
  // together with --target-pane is rejected by Herdr.
  if (workspaceId && !targetPaneId) args.push('--workspace', workspaceId);
  // The pane command runs from the plugin root so that relative script paths
  // resolve. Pass the project directory through the environment instead of
  // --cwd, which would change the process working directory.
  if (cwd) args.push('--env', `CI_DASH_CWD=${cwd}`);
  args.push(focus ? '--focus' : '--no-focus');
  return args;
}

function parseOpenedPaneId(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || ''));
    const paneId = parsed?.result?.plugin_pane?.pane?.pane_id;
    return typeof paneId === 'string' ? paneId : '';
  } catch {
    return '';
  }
}

function buildSwapArgs({ paneId, targetPaneId }) {
  if (paneId) {
    return ['pane', 'swap', '--source-pane', paneId, '--target-pane', targetPaneId];
  }
  // The new pane keeps focus, so it can be swapped with the pane on its left.
  return ['pane', 'swap', '--current', '--direction', 'left'];
}

function buildResizeArgs({ paneId, amount = DEFAULT_PANEL_AMOUNT }) {
  const args = ['pane', 'resize'];
  if (paneId) args.push('--pane', paneId);
  else args.push('--current');
  args.push('--direction', 'left', '--amount', String(amount));
  return args;
}

function describe(result) {
  const stderr = String((result && result.stderr) || '').trim();
  const stdout = String((result && result.stdout) || '').trim();
  return stderr || stdout;
}

function failed(result) {
  return Boolean(result && (result.error || result.status !== 0));
}

// Opens the dashboard as a split pane and swaps it to the left edge of the
// focused pane, which is the closest a plugin can get to a sidebar panel.
function runPanel({
  herdr,
  pluginId,
  cwd,
  workspaceId,
  targetPaneId,
  run = defaultRun,
  amount = DEFAULT_PANEL_AMOUNT,
}) {
  if (!targetPaneId) {
    return { ok: false, step: 'open', message: 'No focused pane is available to split.' };
  }

  const opened = run(
    herdr,
    buildOpenArgs({
      pluginId,
      entrypoint: 'panel',
      placement: 'split',
      direction: 'right',
      targetPaneId,
      cwd,
      workspaceId,
      focus: true,
    }),
  );

  if (failed(opened)) {
    return {
      ok: false,
      step: 'open',
      message: describe(opened) || 'The panel pane could not be opened.',
    };
  }

  const paneId = parseOpenedPaneId(opened.stdout);

  const swapped = run(herdr, buildSwapArgs({ paneId, targetPaneId }));
  if (failed(swapped)) {
    return {
      ok: false,
      step: 'swap',
      paneId,
      message: describe(swapped) || 'The panel pane could not be moved to the left.',
    };
  }

  const resized = run(herdr, buildResizeArgs({ paneId, amount }));
  const warning = failed(resized)
    ? describe(resized) || 'The panel pane could not be resized.'
    : '';

  return { ok: true, paneId, warning };
}

function openPane({ herdr, pluginId, entrypoint, cwd, workspaceId }) {
  return spawnSync(herdr, buildOpenArgs({ pluginId, entrypoint, cwd, workspaceId }), {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function report(result) {
  const message = describe(result);
  if (message) process.stderr.write(`${message}\n`);
}

function main() {
  const requested = parseMode(process.argv[2] || 'panel');
  if (!requested) {
    process.stderr.write('Usage: node src/open.js [panel|tab|popup]\n');
    process.exitCode = 2;
    return;
  }

  const pluginId = process.env.HERDR_PLUGIN_ID || readManifestId();
  if (!pluginId) {
    process.stderr.write('Could not determine the plugin id from herdr-plugin.toml.\n');
    process.exitCode = 1;
    return;
  }

  const herdr = process.env.HERDR_BIN_PATH || 'herdr';
  const context = readContext();
  const cwd = resolveCwd(context);
  const workspaceId =
    typeof context.workspace_id === 'string' ? context.workspace_id : '';
  const targetPaneId =
    typeof context.focused_pane_id === 'string' ? context.focused_pane_id : '';

  if (requested === 'panel' && targetPaneId) {
    const result = runPanel({ herdr, pluginId, cwd, workspaceId, targetPaneId });
    if (!result.ok) {
      process.stderr.write(`${result.message}\n`);
      process.exitCode = 1;
      return;
    }
    if (result.warning) process.stderr.write(`${result.warning}\n`);
    return;
  }

  // Tabs, popups, and the tab fallback used when there is no pane to split.
  const mode = requested === 'panel' ? 'tab' : requested;
  const primary = mode === 'tab' ? 'dashboard' : 'quick';

  let result = openPane({
    herdr,
    pluginId,
    entrypoint: primary,
    cwd,
    workspaceId: mode === 'tab' ? workspaceId : '',
  });

  if (result.error) {
    const message =
      result.error.code === 'ENOENT'
        ? `Herdr binary not found: ${herdr}. Run this plugin from inside Herdr.`
        : `Could not start ${herdr}: ${result.error.message}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  if (result.status !== 0 && mode !== 'tab') {
    // Popups need a recent Herdr build. Fall back to a regular tab so the
    // action still works on older versions.
    const reason = describe(result);
    process.stderr.write(
      `Popup unavailable${reason ? ` (${reason})` : ''}; opening a tab instead.\n`,
    );
    result = openPane({ herdr, pluginId, entrypoint: 'dashboard', cwd, workspaceId });
  }

  if (result.error || result.status !== 0) {
    report(result);
    if (result.error) process.stderr.write(`Could not start ${herdr}: ${result.error.message}\n`);
    process.exitCode = result.status || 1;
    return;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_PANEL_AMOUNT,
  MODES,
  buildOpenArgs,
  buildResizeArgs,
  buildSwapArgs,
  parseMode,
  parseOpenedPaneId,
  readContext,
  resolveCwd,
  runPanel,
};
