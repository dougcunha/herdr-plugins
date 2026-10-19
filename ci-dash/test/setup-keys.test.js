'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BLOCK_BEGIN,
  OPEN_KEYS,
  QUICK_KEYS,
  appendBlock,
  buildBlockLines,
  installKeybindings,
  resolveConfigPath,
} = require('../src/setup-keys');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dash-keys-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    config: path.join(dir, 'config.toml'),
    state: path.join(dir, 'state'),
  };
}

function fakeRun(calls = []) {
  return (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('adds a marked keybinding block to an existing config', (t) => {
  const { dir, config, state } = workspace(t);
  fs.writeFileSync(config, '[keys]\ngoto = "prefix+ctrl+g"\n', 'utf8');
  const calls = [];

  const result = installKeybindings({
    configPath: config,
    stateDir: state,
    run: fakeRun(calls),
    herdr: 'herdr',
  });

  assert.equal(result.status, 'installed');
  assert.equal(result.openKey, 'prefix+alt+g');
  assert.equal(result.quickKey, 'prefix+alt+q');
  assert.equal(result.reloaded, true);

  const text = fs.readFileSync(config, 'utf8');
  assert.ok(text.startsWith('[keys]\ngoto = "prefix+ctrl+g"\n'));
  assert.equal(text.match(/^\[keys\]$/gm).length, 1);
  assert.equal(text.match(/^goto = "prefix\+ctrl\+g"$/gm).length, 1);
  assert.equal(text.split(BLOCK_BEGIN).length, 2);
  assert.match(text, /command = "ci-dash\.open"/);
  assert.match(text, /command = "ci-dash\.quick"/);

  assert.equal(fs.readFileSync(`${config}.ci-dash.bak`, 'utf8'), '[keys]\ngoto = "prefix+ctrl+g"\n');
  const marker = JSON.parse(fs.readFileSync(path.join(state, 'keybindings.json'), 'utf8'));
  assert.equal(marker.configPath, config);
  assert.equal(marker.openKey, 'prefix+alt+g');

  assert.deepEqual(calls[0], ['herdr', 'server', 'reload-config']);
  assert.equal(calls.length, 1);
  assert.ok(fs.existsSync(dir));
});

test('skips keys that already exist in the config', (t) => {
  const { config, state } = workspace(t);
  fs.writeFileSync(
    config,
    [
      '[keys]',
      'one = "prefix+alt+g"',
      'two = "prefix+alt+q"',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = installKeybindings({
    configPath: config,
    stateDir: state,
    run: fakeRun(),
  });

  assert.equal(result.status, 'installed');
  assert.equal(result.openKey, 'prefix+alt+o');
  assert.equal(result.quickKey, 'prefix+alt+w');
});

test('fails when every candidate key is taken', (t) => {
  const { config, state } = workspace(t);
  const lines = ['[keys]'];
  for (const key of [...OPEN_KEYS, ...QUICK_KEYS]) {
    lines.push(`taken_${lines.length} = "${key}"`);
  }
  fs.writeFileSync(config, `${lines.join('\n')}\n`, 'utf8');
  const before = fs.readFileSync(config, 'utf8');

  const result = installKeybindings({
    configPath: config,
    stateDir: state,
    run: fakeRun(),
  });

  assert.equal(result.status, 'error');
  assert.match(result.message, /No free keybinding/);
  assert.equal(fs.readFileSync(config, 'utf8'), before);
});

test('is idempotent after installation', (t) => {
  const { config, state } = workspace(t);
  fs.writeFileSync(config, 'a = 1\n', 'utf8');

  const first = installKeybindings({ configPath: config, stateDir: state, run: fakeRun() });
  const afterFirst = fs.readFileSync(config, 'utf8');

  const second = installKeybindings({ configPath: config, stateDir: state, run: fakeRun() });
  const third = installKeybindings({
    configPath: config,
    stateDir: state,
    force: true,
    run: fakeRun(),
  });

  assert.equal(first.status, 'installed');
  assert.equal(second.status, 'unchanged');
  assert.equal(third.status, 'unchanged');
  assert.equal(fs.readFileSync(config, 'utf8'), afterFirst);

  const marker = JSON.parse(fs.readFileSync(path.join(state, 'keybindings.json'), 'utf8'));
  assert.equal(marker.source, 'startup');
  assert.equal(marker.openKey, 'prefix+alt+g');
});

test('respects a deliberate removal until the setup action is used', (t) => {
  const { config, state } = workspace(t);
  fs.writeFileSync(config, 'a = 1\n', 'utf8');

  installKeybindings({ configPath: config, stateDir: state, run: fakeRun() });
  fs.writeFileSync(config, 'a = 1\n', 'utf8');

  const startup = installKeybindings({ configPath: config, stateDir: state, run: fakeRun() });
  assert.equal(startup.status, 'skipped');
  assert.equal(fs.readFileSync(config, 'utf8'), 'a = 1\n');

  const manual = installKeybindings({
    configPath: config,
    stateDir: state,
    force: true,
    run: fakeRun(),
  });
  assert.equal(manual.status, 'installed');
  assert.equal(fs.readFileSync(config, 'utf8').split(BLOCK_BEGIN).length, 2);
});

test('does not duplicate a binding the user added manually', (t) => {
  const { config, state } = workspace(t);
  fs.writeFileSync(
    config,
    '[[keys.command]]\nkey = "prefix+alt+g"\ntype = "plugin_action"\ncommand = "ci-dash.open"\n',
    'utf8',
  );

  const result = installKeybindings({ configPath: config, stateDir: state, run: fakeRun() });

  assert.equal(result.status, 'unchanged');
  assert.equal(fs.readFileSync(config, 'utf8').split(BLOCK_BEGIN).length, 1);
});

test('preserves CRLF line endings', (t) => {
  const { config, state } = workspace(t);
  fs.writeFileSync(config, 'a = 1\r\n', 'utf8');

  installKeybindings({ configPath: config, stateDir: state, run: fakeRun() });

  const text = fs.readFileSync(config, 'utf8');
  assert.ok(text.includes('a = 1\r\n'));
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false);
});

test('separates the block from a config without a trailing newline', () => {
  const text = appendBlock('a = 1', ['# block']);
  assert.equal(text, 'a = 1\n\n# block\n');
});

test('sends a notification when requested', (t) => {
  const { config, state } = workspace(t);
  fs.writeFileSync(config, '', 'utf8');
  const calls = [];

  const result = installKeybindings({
    configPath: config,
    stateDir: state,
    notify: true,
    run: fakeRun(calls),
    herdr: 'herdr',
  });

  assert.equal(result.status, 'installed');
  const notification = calls.find((call) => call.includes('notification'));
  assert.ok(notification);
  assert.ok(notification.includes('CI Dash keybindings added'));
  assert.ok(notification.includes('prefix+alt+g opens the panel · prefix+alt+q opens the popup'));
});

test('builds a complete TOML block', () => {
  const lines = buildBlockLines('prefix+alt+g', 'prefix+alt+q');
  assert.equal(lines[0].startsWith(BLOCK_BEGIN), true);
  assert.ok(lines.includes('type = "plugin_action"'));
  assert.ok(lines.some((line) => line === 'command = "ci-dash.open"'));
  assert.ok(lines.some((line) => line === 'command = "ci-dash.quick"'));
});

test('resolves an explicit HERDR_CONFIG_PATH', () => {
  const resolved = resolveConfigPath({
    env: { HERDR_CONFIG_PATH: '~/custom/herdr.toml' },
    run: fakeRun(),
  });
  assert.equal(resolved, path.join(os.homedir(), 'custom', 'herdr.toml'));
});

test('reads the config path from herdr --help', () => {
  const resolved = resolveConfigPath({
    env: {},
    herdr: 'herdr',
    run: (command, args) => {
      assert.equal(command, 'herdr');
      assert.deepEqual(args, ['--help']);
      return { status: 0, stdout: 'Config: /tmp/herdr/config.toml\n', stderr: '' };
    },
  });
  assert.equal(resolved, path.resolve('/tmp/herdr/config.toml'));
});
