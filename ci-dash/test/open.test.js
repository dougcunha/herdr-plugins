'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildOpenArgs,
  buildResizeArgs,
  buildSwapArgs,
  parseMode,
  parseOpenedPaneId,
  runPanel,
} = require('../src/open');

test('accepts the supported modes', () => {
  assert.equal(parseMode('panel'), 'panel');
  assert.equal(parseMode('TAB'), 'tab');
  assert.equal(parseMode('popup'), 'popup');
  assert.equal(parseMode('quick'), 'quick');
  assert.equal(parseMode('bogus'), '');
  assert.equal(parseMode(''), '');
});

test('builds the split-pane arguments for the panel mode', () => {
  const args = buildOpenArgs({
    pluginId: 'ci-dash',
    entrypoint: 'panel',
    placement: 'split',
    direction: 'right',
    targetPaneId: 'w1:p1',
    cwd: 'D:\\repo',
    workspaceId: 'w1',
  });

  assert.deepEqual(args.slice(0, 4), ['plugin', 'pane', 'open', '--plugin']);
  assert.ok(args.includes('--entrypoint'));
  assert.equal(args[args.indexOf('--entrypoint') + 1], 'panel');
  assert.equal(args[args.indexOf('--placement') + 1], 'split');
  assert.equal(args[args.indexOf('--direction') + 1], 'right');
  assert.equal(args[args.indexOf('--target-pane') + 1], 'w1:p1');
  // Herdr rejects --workspace together with --target-pane.
  assert.equal(args.includes('--workspace'), false);
  assert.equal(args[args.indexOf('--env') + 1], 'CI_DASH_CWD=D:\\repo');
  assert.equal(args.at(-1), '--focus');
});

test('builds tab arguments without a placement or target pane', () => {
  const args = buildOpenArgs({
    pluginId: 'ci-dash',
    entrypoint: 'dashboard',
    cwd: 'D:\\repo',
    workspaceId: 'w1',
  });

  assert.equal(args.includes('--placement'), false);
  assert.equal(args.includes('--direction'), false);
  assert.equal(args.includes('--target-pane'), false);
  assert.equal(args[args.indexOf('--workspace') + 1], 'w1');
});

test('reads the new pane id from the open response', () => {
  const stdout = JSON.stringify({
    result: { plugin_pane: { pane: { pane_id: 'w1:p9' } } },
  });
  assert.equal(parseOpenedPaneId(stdout), 'w1:p9');
  assert.equal(parseOpenedPaneId('not json'), '');
  assert.equal(parseOpenedPaneId(''), '');
  assert.equal(parseOpenedPaneId(JSON.stringify({ result: {} })), '');
});

test('opens, swaps and resizes the panel', () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'plugin') {
      return {
        status: 0,
        stdout: JSON.stringify({ result: { plugin_pane: { pane: { pane_id: 'w1:p9' } } } }),
        stderr: '',
      };
    }
    if (args[0] === 'pane') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };

  const result = runPanel({
    herdr: 'herdr',
    pluginId: 'ci-dash',
    cwd: 'D:\\repo',
    workspaceId: 'w1',
    targetPaneId: 'w1:p1',
    run,
  });

  assert.deepEqual(result, { ok: true, paneId: 'w1:p9', warning: '' });
  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], 'herdr');
  assert.equal(calls[0][1], 'plugin');
  assert.equal(calls[0].includes('--target-pane'), true);
  assert.deepEqual(calls[1], [
    'herdr',
    'pane',
    'swap',
    '--source-pane',
    'w1:p9',
    '--target-pane',
    'w1:p1',
  ]);
  assert.deepEqual(calls[2], [
    'herdr',
    'pane',
    'resize',
    '--pane',
    'w1:p9',
    '--direction',
    'left',
    '--amount',
    '0.2',
  ]);
});

test('falls back to the focused pane when the open response is unreadable', () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'plugin') return { status: 0, stdout: 'no json', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };

  const result = runPanel({
    herdr: 'herdr',
    pluginId: 'ci-dash',
    cwd: '',
    workspaceId: 'w1',
    targetPaneId: 'w1:p1',
    run,
  });

  assert.equal(result.ok, true);
  assert.equal(result.paneId, '');
  assert.deepEqual(calls[1], ['herdr', 'pane', 'swap', '--current', '--direction', 'left']);
  assert.deepEqual(calls[2], [
    'herdr',
    'pane',
    'resize',
    '--current',
    '--direction',
    'left',
    '--amount',
    '0.2',
  ]);
});

test('reports a failed open without swapping', () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return { status: 1, stdout: '', stderr: 'split target missing' };
  };

  const result = runPanel({
    herdr: 'herdr',
    pluginId: 'ci-dash',
    cwd: '',
    workspaceId: 'w1',
    targetPaneId: 'w1:p1',
    run,
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'open');
  assert.equal(result.message, 'split target missing');
  assert.equal(calls.length, 1);
});

test('reports a failed swap but keeps the error details', () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'plugin') {
      return {
        status: 0,
        stdout: JSON.stringify({ result: { plugin_pane: { pane: { pane_id: 'w1:p9' } } } }),
        stderr: '',
      };
    }
    return { status: 1, stdout: '', stderr: 'swap failed' };
  };

  const result = runPanel({
    herdr: 'herdr',
    pluginId: 'ci-dash',
    cwd: '',
    workspaceId: 'w1',
    targetPaneId: 'w1:p1',
    run,
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'swap');
  assert.equal(result.paneId, 'w1:p9');
  assert.equal(result.message, 'swap failed');
  assert.equal(calls.length, 2);
});

test('keeps the panel open when only the resize fails', () => {
  const run = (command, args) => {
    if (args[0] === 'plugin') {
      return {
        status: 0,
        stdout: JSON.stringify({ result: { plugin_pane: { pane: { pane_id: 'w1:p9' } } } }),
        stderr: '',
      };
    }
    if (args[1] === 'swap') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: 'resize failed' };
  };

  const result = runPanel({
    herdr: 'herdr',
    pluginId: 'ci-dash',
    cwd: '',
    workspaceId: 'w1',
    targetPaneId: 'w1:p1',
    run,
  });

  assert.equal(result.ok, true);
  assert.equal(result.warning, 'resize failed');
});

test('refuses to split without a target pane', () => {
  let called = false;
  const result = runPanel({
    herdr: 'herdr',
    pluginId: 'ci-dash',
    cwd: '',
    workspaceId: 'w1',
    targetPaneId: '',
    run: () => {
      called = true;
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'open');
  assert.equal(called, false);
});

test('builds swap and resize arguments for the current pane', () => {
  assert.deepEqual(buildSwapArgs({ paneId: '', targetPaneId: 'w1:p1' }), [
    'pane',
    'swap',
    '--current',
    '--direction',
    'left',
  ]);
  assert.deepEqual(buildResizeArgs({ paneId: 'w1:p9', amount: 0.3 }), [
    'pane',
    'resize',
    '--pane',
    'w1:p9',
    '--direction',
    'left',
    '--amount',
    '0.3',
  ]);
});
