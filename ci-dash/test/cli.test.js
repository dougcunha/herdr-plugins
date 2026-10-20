'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  copyPlugin,
  defaultInstallDir,
  installPlugin,
  parseArgs,
  removeInstallDir,
  removeKeybindings,
  uninstallPlugin,
} = require('../src/cli');

function makeSource() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dash-cli-'));
  const write = (file, text) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  write('herdr-plugin.toml', 'id = "ci-dash"\nversion = "0.1.0"\n');
  write('package.json', '{"name":"@dougcunha/ci-dash"}\n');
  write('package-lock.json', '{}\n');
  write('README.md', '# CI Dash\n');
  write('src/app.js', 'module.exports = {};\n');
  write('src/cli.js', '#!/usr/bin/env node\n');
  write('test/app.test.js', '// tests\n');
  write('node_modules/yaml/index.js', '// dependency\n');
  return root;
}

function fakeRun(calls, handler = () => ({ status: 0, stdout: '', stderr: '' })) {
  return (command, args, options = {}) => {
    const call = { command, args, options };
    calls.push(call);
    return handler(call);
  };
}

test('defaults the install directory per platform', () => {
  assert.equal(
    defaultInstallDir({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      home: 'C:\\Users\\me',
    }),
    path.join('C:\\Users\\me\\AppData\\Local', 'herdr', 'plugins', 'ci-dash'),
  );
  assert.equal(
    defaultInstallDir({
      platform: 'darwin',
      env: {},
      home: '/Users/me',
    }),
    path.join('/Users/me', 'Library', 'Application Support', 'herdr', 'plugins', 'ci-dash'),
  );
  assert.equal(
    defaultInstallDir({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/data' },
      home: '/home/me',
    }),
    path.join('/data', 'herdr', 'plugins', 'ci-dash'),
  );
  assert.equal(
    defaultInstallDir({
      platform: 'linux',
      env: { CI_DASH_INSTALL_DIR: '~/ci-dash' },
      home: '/home/me',
    }),
    path.resolve(path.join('/home/me', 'ci-dash')),
  );
});

test('parses install flags', () => {
  assert.deepEqual(parseArgs([]), {
    command: 'install',
    dir: '',
    keys: true,
    help: false,
    version: false,
  });
  assert.equal(parseArgs(['install', '--dir', 'C:\\plugins']).dir, 'C:\\plugins');
  assert.equal(parseArgs(['install', '--dir=/tmp/plugins']).dir, '/tmp/plugins');
  assert.equal(parseArgs(['install', '--no-keys']).keys, false);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['--version']).version, true);
  assert.throws(() => parseArgs(['update']), /Unknown command/);
  assert.throws(() => parseArgs(['install', '--dir']), /needs a path/);
  assert.throws(() => parseArgs(['install', '--bogus']), /Unknown option/);
});

test('parses uninstall flags', () => {
  assert.equal(parseArgs(['uninstall']).command, 'uninstall');
  assert.equal(parseArgs(['uninstall', '--keep-keys']).keys, false);
  assert.equal(parseArgs(['uninstall', '--dir=/tmp/plugins']).dir, '/tmp/plugins');
  assert.throws(() => parseArgs(['uninstall', '--no-keys']), /only valid with install/);
  assert.throws(() => parseArgs(['install', '--keep-keys']), /only valid with uninstall/);
});

test('keeps the package and manifest versions in sync', () => {
  const pkg = require('../package.json');
  const manifest = fs.readFileSync(
    path.join(__dirname, '..', 'herdr-plugin.toml'),
    'utf8',
  );
  const match = /^version = "([^"]+)"/m.exec(manifest);
  assert.ok(match, 'manifest must declare a version');
  assert.equal(match[1], pkg.version);
});

test('refuses to install over the plugin source tree', () => {
  const source = makeSource();
  try {
    assert.throws(
      () => copyPlugin({ source, dir: source }),
      /outside the plugin source tree/,
    );
    assert.throws(
      () => copyPlugin({ source, dir: path.dirname(source) }),
      /outside the plugin source tree/,
    );
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('copies only runtime plugin files', () => {
  const source = makeSource();
  const dir = path.join(os.tmpdir(), `ci-dash-copy-${process.pid}-${Date.now()}`);
  try {
    const copied = copyPlugin({ source, dir });

    assert.deepEqual(copied, [
      'src',
      'herdr-plugin.toml',
      'package.json',
      'package-lock.json',
      'README.md',
    ]);
    assert.ok(fs.existsSync(path.join(dir, 'src', 'app.js')));
    assert.ok(fs.existsSync(path.join(dir, 'herdr-plugin.toml')));
    assert.ok(!fs.existsSync(path.join(dir, 'test')));
    assert.ok(!fs.existsSync(path.join(dir, 'node_modules')));
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installs dependencies, links the plugin, and adds keybindings', () => {
  const source = makeSource();
  const dir = path.join(os.tmpdir(), `ci-dash-install-${process.pid}-${Date.now()}`);
  const calls = [];
  const lines = [];
  try {
    const result = installPlugin({
      source,
      dir,
      herdr: 'herdr',
      run: fakeRun(calls),
      bunAvailable: true,
      log: (line) => lines.push(line),
    });

    assert.equal(result.packageManager, 'bun');
    assert.equal(result.keysInstalled, true);
    assert.deepEqual(
      calls.map(({ command, args }) => [command, args]),
      [
        ['bun', ['install', '--production']],
        ['herdr', ['plugin', 'link', dir]],
        ['herdr', ['plugin', 'action', 'invoke', 'ci-dash.setup-keys']],
      ],
    );
    assert.equal(calls[0].options.cwd, dir);
    assert.ok(lines.some((line) => line.includes('Linked ci-dash')));
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('falls back to npm when bun install fails', () => {
  const source = makeSource();
  const dir = path.join(os.tmpdir(), `ci-dash-npm-${process.pid}-${Date.now()}`);
  const calls = [];
  try {
    const result = installPlugin({
      source,
      dir,
      run: fakeRun(calls, (call) =>
        call.command === 'bun'
          ? { status: 1, stderr: 'bun failed' }
          : { status: 0, stdout: '', stderr: '' },
      ),
      bunAvailable: true,
    });

    assert.equal(result.packageManager, 'npm');
    assert.deepEqual(calls[1].args, [
      'install',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
    ]);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('relinks when Herdr reports the plugin as already linked', () => {
  const source = makeSource();
  const dir = path.join(os.tmpdir(), `ci-dash-relink-${process.pid}-${Date.now()}`);
  const calls = [];
  let links = 0;
  try {
    installPlugin({
      source,
      dir,
      run: fakeRun(calls, (call) => {
        if (call.command === 'herdr' && call.args[1] === 'link') {
          links += 1;
          if (links === 1) {
            return { status: 1, stderr: 'plugin ci-dash is already linked' };
          }
        }
        return { status: 0, stdout: '', stderr: '' };
      }),
      bunAvailable: false,
      keys: false,
    });

    assert.ok(
      calls.some(
        ({ command, args }) =>
          command === 'herdr' &&
          args[0] === 'plugin' &&
          args[1] === 'unlink' &&
          args[2] === 'ci-dash',
      ),
    );
    assert.equal(links, 2);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removes the CI Dash keybinding block', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dash-config-'));
  const config = path.join(root, 'config.toml');
  const calls = [];
  try {
    fs.writeFileSync(
      config,
      [
        'theme = "dark"',
        '',
        '# ci-dash:begin (managed by the CI Dash plugin)',
        '[[keys.command]]',
        'key = "prefix+alt+g"',
        'command = "ci-dash.open"',
        '# ci-dash:end',
        '',
        'after = true',
        '',
      ].join('\n'),
    );

    const result = removeKeybindings({
      configPath: config,
      run: fakeRun(calls),
    });

    assert.equal(result.status, 'removed');
    assert.equal(result.reloaded, true);
    assert.ok(fs.existsSync(result.backupPath));
    const text = fs.readFileSync(config, 'utf8');
    assert.ok(!text.includes('# ci-dash:begin'));
    assert.ok(!text.includes('ci-dash.open'));
    assert.ok(text.includes('theme = "dark"'));
    assert.ok(text.includes('after = true'));
    assert.deepEqual(
      calls.map(({ command, args }) => [command, args]),
      [['herdr', ['server', 'reload-config']]],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reports keybindings that are already absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dash-config-'));
  const config = path.join(root, 'config.toml');
  try {
    fs.writeFileSync(config, 'theme = "dark"\n');
    const result = removeKeybindings({ configPath: config, run: fakeRun([]) });
    assert.equal(result.status, 'absent');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removes an install directory only when it contains CI Dash', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dash-source-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dash-remove-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dash-other-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'herdr-plugin.toml'),
      'id = "ci-dash"\nversion = "0.1.0"\n',
    );
    fs.writeFileSync(path.join(other, 'herdr-plugin.toml'), 'id = "other"\n');

    assert.equal(removeInstallDir({ source, dir }), true);
    assert.ok(!fs.existsSync(dir));
    assert.throws(
      () => removeInstallDir({ source, dir: other }),
      /does not look like a CI Dash install/,
    );
    assert.throws(
      () => removeInstallDir({ source, dir: source }),
      /outside the plugin source tree/,
    );
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('unlinks, removes files, and drops keybindings', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dash-source-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dash-uninstall-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dash-config-'));
  const config = path.join(root, 'config.toml');
  const calls = [];
  const lines = [];
  try {
    fs.writeFileSync(
      path.join(dir, 'herdr-plugin.toml'),
      'id = "ci-dash"\nversion = "0.1.0"\n',
    );
    fs.writeFileSync(
      config,
      '# ci-dash:begin\ncommand = "ci-dash.open"\n# ci-dash:end\n',
    );

    const result = uninstallPlugin({
      source,
      dir,
      env: { HERDR_CONFIG_PATH: config },
      run: fakeRun(calls),
      keys: true,
      log: (line) => lines.push(line),
    });

    assert.deepEqual(result, {
      unlinked: true,
      removed: true,
      keysStatus: 'removed',
    });
    assert.ok(!fs.existsSync(dir));
    assert.ok(!fs.readFileSync(config, 'utf8').includes('ci-dash'));
    assert.deepEqual(
      calls.map(({ command, args }) => [command, args]),
      [
        ['herdr', ['plugin', 'unlink', 'ci-dash']],
        ['herdr', ['server', 'reload-config']],
      ],
    );
    assert.ok(lines.some((line) => line.includes('Unlinked ci-dash')));
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('continues when the plugin was not linked', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dash-source-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dash-uninstall-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'herdr-plugin.toml'),
      'id = "ci-dash"\nversion = "0.1.0"\n',
    );
    const result = uninstallPlugin({
      source,
      dir,
      env: { HERDR_CONFIG_PATH: path.join(source, 'missing.toml') },
      keys: false,
      run: fakeRun([], () => ({
        status: 1,
        stderr: 'plugin ci-dash is not linked',
      })),
    });

    assert.deepEqual(result, {
      unlinked: false,
      removed: true,
      keysStatus: 'skipped',
    });
    assert.ok(!fs.existsSync(dir));
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('does not fail the install when keybindings cannot be added', () => {
  const source = makeSource();
  const dir = path.join(os.tmpdir(), `ci-dash-keys-${process.pid}-${Date.now()}`);
  const lines = [];
  try {
    const result = installPlugin({
      source,
      dir,
      run: fakeRun([], (call) =>
        call.args.includes('ci-dash.setup-keys')
          ? { status: 1, stderr: 'config is locked' }
          : { status: 0, stdout: '', stderr: '' },
      ),
      bunAvailable: false,
      log: (line) => lines.push(line),
    });

    assert.equal(result.keysInstalled, false);
    assert.ok(lines.some((line) => line.includes('config is locked')));
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
