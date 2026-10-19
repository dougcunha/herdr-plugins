'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BLOCK_BEGIN = '# ci-dash:begin';
const BLOCK_END = '# ci-dash:end';
const MARKER_FILE = 'keybindings.json';

// Alt combinations are free in the default keymap. The first free key wins;
// existing bindings in config.toml are always respected.
const OPEN_KEYS = ['prefix+alt+g', 'prefix+alt+o', 'prefix+shift+o', 'prefix+ctrl+alt+g'];
const QUICK_KEYS = ['prefix+alt+q', 'prefix+alt+w', 'prefix+shift+q', 'prefix+ctrl+alt+q'];

function expandHome(value) {
  const text = String(value || '');
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

function defaultRun(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function resolveConfigPath({ env = process.env, herdr, run = defaultRun } = {}) {
  if (env.HERDR_CONFIG_PATH) {
    return path.resolve(expandHome(env.HERDR_CONFIG_PATH));
  }

  const binary = herdr || env.HERDR_BIN_PATH || 'herdr';
  const help = run(binary, ['--help']);
  if (help && help.status === 0) {
    const match = /^Config:\s+(.+?)\s*$/m.exec(String(help.stdout || ''));
    if (match) return path.resolve(expandHome(match[1]));
  }

  if (process.platform === 'win32' && env.APPDATA) {
    return path.join(env.APPDATA, 'herdr', 'config.toml');
  }

  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'herdr', 'config.toml');
}

function keyInUse(text, key) {
  return text.includes(`"${key}"`) || text.includes(`'${key}'`);
}

function chooseKey(text, candidates, used) {
  for (const key of candidates) {
    if (used.has(key) || keyInUse(text, key)) continue;
    used.add(key);
    return key;
  }
  return '';
}

function buildBlockLines(openKey, quickKey) {
  return [
    `${BLOCK_BEGIN} (managed by the CI Dash plugin; remove this block to disable)`,
    '[[keys.command]]',
    `key = "${openKey}"`,
    'type = "plugin_action"',
    'command = "ci-dash.open"',
    'description = "Open the CI Dash panel"',
    '',
    '[[keys.command]]',
    `key = "${quickKey}"`,
    'type = "plugin_action"',
    'command = "ci-dash.quick"',
    'description = "Quick-run a GitHub Actions workflow"',
    BLOCK_END,
  ];
}

function appendBlock(text, lines) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = `${lines.join(eol)}${eol}`;
  if (!text) return block;

  let separator;
  if (text.endsWith(`${eol}${eol}`)) separator = '';
  else if (text.endsWith('\n')) separator = eol;
  else separator = `${eol}${eol}`;

  return `${text}${separator}${block}`;
}

function alreadyConfigured(text) {
  return (
    text.includes(BLOCK_BEGIN) ||
    /command\s*=\s*"ci-dash\.(?:open|quick)"/.test(text)
  );
}

function readMarker(stateDir) {
  if (!stateDir) return null;
  try {
    const raw = fs.readFileSync(path.join(stateDir, MARKER_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeMarker(stateDir, value) {
  if (!stateDir) return;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, MARKER_FILE),
      `${JSON.stringify(value, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // The keybindings are already written; a missing marker only means the
    // setup will be attempted again if the block is removed later.
  }
}

function backupConfig(configPath) {
  if (!fs.existsSync(configPath)) return '';
  const backupPath = `${configPath}.ci-dash.bak`;
  if (fs.existsSync(backupPath)) return backupPath;
  try {
    fs.copyFileSync(configPath, backupPath);
    return backupPath;
  } catch {
    return '';
  }
}

function notifyKeys({ run, herdr, openKey, quickKey }) {
  run(herdr, [
    'notification',
    'show',
    'CI Dash keybindings added',
    '--body',
    `${openKey} opens the panel · ${quickKey} opens the popup`,
    '--sound',
    'none',
  ]);
}

function installKeybindings({
  configPath,
  stateDir = '',
  force = false,
  notify = false,
  herdr = process.env.HERDR_BIN_PATH || 'herdr',
  run = defaultRun,
} = {}) {
  if (!configPath) {
    return { status: 'error', message: 'No config path was found.' };
  }

  const exists = fs.existsSync(configPath);
  const text = exists ? fs.readFileSync(configPath, 'utf8') : '';

  if (alreadyConfigured(text)) {
    const marker = readMarker(stateDir);
    if (!marker || marker.configPath !== configPath) {
      writeMarker(stateDir, {
        version: 1,
        configPath,
        source: 'existing',
        installedAt: new Date().toISOString(),
      });
    }
    return {
      status: 'unchanged',
      message: 'CI Dash keybindings are already configured.',
      configPath,
    };
  }

  const marker = readMarker(stateDir);
  if (!force && exists && marker && marker.configPath === configPath) {
    return {
      status: 'skipped',
      message:
        'Keybinding setup already ran for this config. Remove the marker or run the setup-keys action to add them again.',
      configPath,
    };
  }

  const used = new Set();
  const openKey = chooseKey(text, OPEN_KEYS, used);
  const quickKey = chooseKey(text, QUICK_KEYS, used);
  if (!openKey || !quickKey) {
    return {
      status: 'error',
      message:
        'No free keybinding was found. Edit config.toml manually or free one of the candidate combinations.',
      configPath,
    };
  }

  const backupPath = backupConfig(configPath);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, appendBlock(text, buildBlockLines(openKey, quickKey)), 'utf8');

  writeMarker(stateDir, {
    version: 1,
    configPath,
    source: force ? 'manual' : 'startup',
    openKey,
    quickKey,
    installedAt: new Date().toISOString(),
  });

  let reloaded = false;
  if (run) {
    const reload = run(herdr, ['server', 'reload-config']);
    reloaded = Boolean(reload && reload.status === 0);
  }

  if (notify) {
    notifyKeys({ run, herdr, openKey, quickKey });
  }

  return {
    status: 'installed',
    message: `CI Dash keybindings added: ${openKey} opens the panel, ${quickKey} opens the popup.`,
    configPath,
    backupPath,
    openKey,
    quickKey,
    reloaded,
  };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const force = args.has('--force');
  const notifyRequested = args.has('--notify') && process.env.CI_DASH_NO_NOTIFY !== '1';
  const herdr = process.env.HERDR_BIN_PATH || 'herdr';
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || '';
  const configPath = resolveConfigPath({ herdr });

  try {
    const result = installKeybindings({
      configPath,
      stateDir,
      force,
      notify: notifyRequested,
      herdr,
    });

    process.stdout.write(`${result.message}\n`);
    if (result.configPath) process.stdout.write(`config: ${result.configPath}\n`);
    if (result.backupPath) process.stdout.write(`backup: ${result.backupPath}\n`);
    if (result.status === 'installed' && !result.reloaded) {
      process.stdout.write('Run "herdr server reload-config" or restart Herdr to apply.\n');
    }
    if (result.status === 'error') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Could not add CI Dash keybindings: ${error.message}\n`);
    if (notifyRequested) {
      defaultRun(herdr, [
        'notification',
        'show',
        'CI Dash keybindings not added',
        '--body',
        error.message,
        '--sound',
        'none',
      ]);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  BLOCK_BEGIN,
  BLOCK_END,
  OPEN_KEYS,
  QUICK_KEYS,
  alreadyConfigured,
  appendBlock,
  buildBlockLines,
  chooseKey,
  installKeybindings,
  resolveConfigPath,
};
