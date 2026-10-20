#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { version: VERSION } = require('../package.json');

const PLUGIN_ID = 'ci-dash';
const PACKAGE_NAME = '@dougcunha/ci-dash';
const COPY_ENTRIES = [
  'src',
  'herdr-plugin.toml',
  'package.json',
  'package-lock.json',
  'README.md',
];

const USAGE = `Install CI Dash into Herdr.

Usage: ${PACKAGE_NAME} install [options]

Options:
  --dir <path>   Install into this directory instead of the default
  --no-keys      Do not add the Herdr keybindings
  -h, --help     Show this help
  -v, --version  Show the installer version`;

function expandHome(value, home = os.homedir()) {
  const text = String(value || '');
  if (text === '~') return home;
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return path.join(home, text.slice(2));
  }
  return text;
}

function defaultInstallDir({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (env.CI_DASH_INSTALL_DIR) {
    return path.resolve(expandHome(env.CI_DASH_INSTALL_DIR, home));
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(base, 'herdr', 'plugins', PLUGIN_ID);
  }
  if (platform === 'darwin') {
    return path.join(
      home,
      'Library',
      'Application Support',
      'herdr',
      'plugins',
      PLUGIN_ID,
    );
  }
  const base = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, 'herdr', 'plugins', PLUGIN_ID);
}

function parseArgs(argv) {
  const options = {
    command: 'install',
    dir: '',
    keys: true,
    help: false,
    version: false,
  };
  const args = [...argv];

  if (args[0] === 'help') {
    options.help = true;
    return options;
  }
  if (args[0] && !args[0].startsWith('-')) {
    options.command = args.shift();
  }
  if (options.command !== 'install') {
    throw new Error(`Unknown command: ${options.command}`);
  }

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-v' || arg === '--version') {
      options.version = true;
    } else if (arg === '--no-keys') {
      options.keys = false;
    } else if (arg === '--dir') {
      const value = args.shift();
      if (!value) throw new Error('--dir needs a path');
      options.dir = value;
    } else if (arg.startsWith('--dir=')) {
      options.dir = arg.slice('--dir='.length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function defaultRun(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

function commandAvailable(command, run = defaultRun) {
  const result = run(command, ['--version'], { stdio: 'ignore' });
  return Boolean(result && !result.error && result.status === 0);
}

function describeFailure(command, result) {
  if (result?.error?.code === 'ENOENT') {
    return command === 'herdr'
      ? `${command} was not found. Install Herdr or set HERDR_BIN_PATH.`
      : `${command} was not found. Install it and try again.`;
  }
  if (result?.error) {
    return `Could not run ${command}: ${result.error.message}`;
  }
  const output = String(result?.stderr || result?.stdout || '').trim();
  return `${command} exited with status ${result?.status ?? '?'}${
    output ? `: ${output}` : ''
  }`;
}

function runOrThrow(run, command, args, options = {}) {
  const result = run(command, args, options);
  if (!result || result.error || result.status !== 0) {
    throw new Error(describeFailure(command, result));
  }
  return result;
}

function copyPlugin({ source, dir }) {
  const sourcePath = path.resolve(source);
  const dirPath = path.resolve(dir);
  if (
    sourcePath === dirPath ||
    sourcePath.startsWith(`${dirPath}${path.sep}`) ||
    dirPath.startsWith(`${sourcePath}${path.sep}`)
  ) {
    throw new Error('Install directory must be outside the plugin source tree.');
  }

  fs.mkdirSync(dirPath, { recursive: true });
  const copied = [];
  for (const entry of COPY_ENTRIES) {
    const from = path.join(sourcePath, entry);
    if (!fs.existsSync(from)) continue;
    const to = path.join(dirPath, entry);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true, force: true });
    copied.push(entry);
  }
  return copied;
}

function installDependencies({ dir, run, bunAvailable }) {
  if (bunAvailable) {
    const bun = run('bun', ['install', '--production'], { cwd: dir });
    if (bun && !bun.error && bun.status === 0) return 'bun';
  }
  runOrThrow(run, 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: dir,
  });
  return 'npm';
}

function installPlugin({
  source,
  dir,
  herdr = 'herdr',
  keys = true,
  run = defaultRun,
  bunAvailable = false,
  log = () => {},
}) {
  if (!fs.existsSync(path.join(source, 'herdr-plugin.toml'))) {
    throw new Error(`No herdr-plugin.toml found in ${source}`);
  }

  copyPlugin({ source, dir });
  log(`Copied the plugin to ${dir}`);

  const packageManager = installDependencies({ dir, run, bunAvailable });
  log(`Installed dependencies with ${packageManager}`);

  const linkArgs = ['plugin', 'link', dir];
  try {
    runOrThrow(run, herdr, linkArgs, { cwd: dir });
  } catch (error) {
    if (!/already (?:linked|installed|exists)/i.test(error.message)) {
      throw error;
    }
    runOrThrow(run, herdr, ['plugin', 'unlink', PLUGIN_ID]);
    runOrThrow(run, herdr, linkArgs, { cwd: dir });
  }
  log(`Linked ${PLUGIN_ID} with Herdr`);

  let keysInstalled = false;
  if (keys) {
    try {
      runOrThrow(
        run,
        herdr,
        ['plugin', 'action', 'invoke', `${PLUGIN_ID}.setup-keys`],
        {},
      );
      keysInstalled = true;
      log('Added the CI Dash keybindings');
    } catch (error) {
      log(`Warning: keybindings were not added: ${error.message}`);
    }
  }

  return { dir, packageManager, keysInstalled };
}

function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    platform = process.platform,
    home = os.homedir(),
    run = defaultRun,
    out = (line) => process.stdout.write(`${line}\n`),
    err = (line) => process.stderr.write(`${line}\n`),
  } = {},
) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err(`${error.message}\n\n${USAGE}`);
    return 2;
  }

  if (options.help) {
    out(USAGE);
    return 0;
  }
  if (options.version) {
    out(VERSION);
    return 0;
  }

  const source = path.resolve(__dirname, '..');
  const dir = options.dir
    ? path.resolve(expandHome(options.dir, home))
    : defaultInstallDir({ platform, env, home });
  const herdr = env.HERDR_BIN_PATH || 'herdr';

  try {
    out(`Installing CI Dash ${VERSION} to ${dir}`);
    installPlugin({
      source,
      dir,
      herdr,
      keys: options.keys,
      run,
      bunAvailable: commandAvailable('bun', run),
      log: out,
    });
    out(`CI Dash is ready. Open it with: herdr plugin action invoke ${PLUGIN_ID}.open`);
    return 0;
  } catch (error) {
    err(`Install failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  COPY_ENTRIES,
  PACKAGE_NAME,
  PLUGIN_ID,
  USAGE,
  commandAvailable,
  copyPlugin,
  defaultInstallDir,
  installDependencies,
  installPlugin,
  main,
  parseArgs,
};
