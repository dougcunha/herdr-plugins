'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { App } = require('../src/app');
const fmt = require('../src/format');

function input(overrides = {}) {
  return {
    name: 'field',
    type: 'string',
    description: '',
    required: false,
    default: '',
    options: [],
    value: '',
    ...overrides,
  };
}

test('accepts valid inputs', () => {
  const app = new App({});
  app.inputs = [
    input({ name: 'version', required: true, value: '1.2.3' }),
    input({ name: 'retries', type: 'number', value: '2' }),
    input({ name: 'channel', type: 'choice', options: ['stable', 'beta'], value: 'beta' }),
  ];

  assert.equal(app.validateInputs(), null);
});

test('rejects a missing required input', () => {
  const app = new App({});
  app.inputs = [input({ name: 'version', required: true, value: '  ' })];

  assert.deepEqual(app.validateInputs(), {
    index: 0,
    message: 'version is required.',
  });
});

test('rejects a non-numeric number input', () => {
  const app = new App({});
  app.inputs = [input({ name: 'retries', type: 'number', value: 'many' })];

  assert.deepEqual(app.validateInputs(), {
    index: 0,
    message: 'retries must be a number.',
  });
});

test('rejects a choice value outside its options', () => {
  const app = new App({});
  app.inputs = [
    input({ name: 'channel', type: 'choice', options: ['stable', 'beta'], value: 'nightly' }),
  ];

  assert.deepEqual(app.validateInputs(), {
    index: 0,
    message: 'channel must be one of: stable, beta.',
  });
});

test('rejects more than 25 inputs', () => {
  const app = new App({});
  app.inputs = Array.from({ length: 26 }, (_, index) =>
    input({ name: `input_${index}`, value: 'x' }),
  );

  assert.deepEqual(app.validateInputs(), {
    index: 0,
    message: 'GitHub accepts at most 25 inputs per dispatch.',
  });
});

test('builds string inputs for the dispatch payload', () => {
  const app = new App({});
  app.inputs = [
    input({ name: 'flag', type: 'boolean', value: 'true' }),
    input({ name: 'off', type: 'boolean', value: '' }),
    input({ name: 'count', type: 'number', value: '3' }),
    input({ name: 'label', type: 'string', value: 'release' }),
  ];

  assert.deepEqual(app.buildPayload(), {
    flag: 'true',
    off: 'false',
    count: '3',
    label: 'release',
  });
});

test('moves to the confirmation screen when inputs are valid', () => {
  const app = new App({});
  app.inputs = [input({ name: 'version', required: true, value: '1.0.0' })];

  app.validateAndConfirm();

  assert.equal(app.screen, 'confirm');
  assert.equal(app.message, '');
});

test('focuses the invalid field instead of confirming', () => {
  const app = new App({});
  app.inputs = [
    input({ name: 'ok', value: 'yes' }),
    input({ name: 'version', required: true, value: '' }),
  ];

  app.validateAndConfirm();

  assert.equal(app.screen, 'inputs');
  assert.equal(app.fieldIndex, 1);
  assert.equal(app.message, 'version is required.');
});

test('filters workflows by name and path, case-insensitively', () => {
  const app = new App({});
  app.workflows = [
    { name: 'Build', path: '.github/workflows/build.yml' },
    { name: 'Release', path: '.github/workflows/release.yml' },
  ];
  app.wfFilter = 'RELEASE';
  assert.deepEqual(app.filteredWorkflows(), [app.workflows[1]]);

  app.wfFilter = '.github/workflows/';
  assert.equal(app.filteredWorkflows().length, 2);
});

test('filters refs by name and type', () => {
  const app = new App({});
  app.refs = [
    { name: 'main', type: 'branch' },
    { name: 'v1.0.0', type: 'tag' },
  ];
  app.refFilter = 'tag';
  assert.deepEqual(app.filteredRefs(), [app.refs[1]]);
});

test('keeps the selected list item inside a scrolling window', () => {
  const app = new App({});
  const items = Array.from({ length: 30 }, (_, index) => index);

  const first = app.windowList(items, 25, 10, 'wfTop');
  assert.equal(first.selected, 25);
  assert.equal(first.top, 16);
  assert.deepEqual(first.items, items.slice(16, 26));

  const second = app.windowList(items, 2, 10, 'wfTop');
  assert.equal(second.top, 2);
  assert.deepEqual(second.items, items.slice(2, 12));
});

test('clamps selection when the list is empty', () => {
  const app = new App({});
  const window = app.windowList([], 3, 10, 'wfTop');
  assert.equal(window.top, 0);
  assert.equal(window.selected, 0);
  assert.deepEqual(window.items, []);
});

function appWithGh(workflows, yamlByPath) {
  const app = new App({});
  const drawn = [];
  app.tui = {
    columns: 80,
    rows: 24,
    draw(lines) {
      drawn.length = 0;
      drawn.push(...lines);
    },
  };
  app.repo = { host: 'github.com', owner: 'o', name: 'r', slug: 'o/r' };
  app.repoData = { default_branch: 'main' };
  app.gh = {
    listWorkflows: async () => workflows,
    getWorkflowYaml: async (workflow) => {
      if (!(workflow.path in yamlByPath)) {
        throw new Error(`no yaml for ${workflow.path}`);
      }
      return yamlByPath[workflow.path];
    },
    workflowHtmlUrl: () => 'https://github.com/o/r/actions',
  };
  return app;
}

test('lists only workflows that can be dispatched manually', async () => {
  const app = appWithGh(
    [
      { id: 1, name: 'Build', path: '.github/workflows/build.yml', state: 'active' },
      { id: 2, name: 'Lint', path: '.github/workflows/lint.yml', state: 'active' },
      { id: 3, name: 'Off', path: '.github/workflows/off.yml', state: 'disabled_manually' },
      { id: 4, name: 'Gone', path: '.github/workflows/gone.yml', state: 'deleted' },
      { id: 5, name: 'Other', path: 'docs/other.yml', state: 'active' },
    ],
    {
      '.github/workflows/build.yml': 'on: workflow_dispatch\n',
      '.github/workflows/lint.yml': 'on:\n  push:\n',
      '.github/workflows/off.yml': 'on: workflow_dispatch\n',
    },
  );

  await app.loadWorkflows();

  assert.equal(app.screen, 'workflows');
  assert.deepEqual(
    app.workflows.map((workflow) => workflow.name),
    ['Build'],
  );
  assert.equal(app.workflows[0].dispatchYaml, 'on: workflow_dispatch\n');
});

test('surfaces an error when no workflow can be dispatched manually', async () => {
  const app = appWithGh(
    [{ id: 1, name: 'Lint', path: '.github/workflows/lint.yml', state: 'active' }],
    { '.github/workflows/lint.yml': 'on:\n  push:\n' },
  );

  await app.loadWorkflows();

  assert.equal(app.screen, 'error');
  assert.match(app.error.message, /No manually dispatchable workflows/);
});

test('reports the underlying error when every workflow probe fails', async () => {
  const app = appWithGh(
    [{ id: 1, name: 'Build', path: '.github/workflows/build.yml', state: 'active' }],
    {},
  );

  await app.loadWorkflows();

  assert.equal(app.screen, 'error');
  assert.match(app.error.message, /no yaml for/);
});

test('skips the inputs screen when the workflow declares no inputs', async () => {
  const app = appWithGh([], {
    '.github/workflows/build.yml': 'on: workflow_dispatch\n',
  });
  app.workflow = { name: 'Build', path: '.github/workflows/build.yml' };
  app.refs = [{ name: 'main', type: 'branch' }];

  await app.chooseRef();

  assert.equal(app.screen, 'confirm');
  assert.deepEqual(app.inputs, []);
});

test('opens the inputs screen when the workflow declares inputs', async () => {
  const app = appWithGh([], {
    '.github/workflows/build.yml':
      'on:\n  workflow_dispatch:\n    inputs:\n      version:\n        required: true\n',
  });
  app.workflow = { name: 'Build', path: '.github/workflows/build.yml' };
  app.refs = [{ name: 'main', type: 'branch' }];

  await app.chooseRef();

  assert.equal(app.screen, 'inputs');
  assert.equal(app.inputs.length, 1);
});

test('run screen shows a short link button instead of the raw URL', () => {
  const term = process.env.TERM;
  process.env.TERM = 'xterm-256color';
  try {
    const app = new App({});
    app.watch = {
      run: {
        html_url: 'https://github.com/o/r/actions/runs/123',
        run_number: 1,
        name: 'CI',
        status: 'in_progress',
        conclusion: null,
        head_branch: 'main',
        head_sha: 'abcdef123456',
        run_attempt: 1,
        event: 'workflow_dispatch',
      },
      jobs: [],
      scroll: 0,
      scrollMax: 0,
    };

    const lines = app.runBody(60, 30);
    const button = lines.find((line) => line.includes('Open run'));

    assert.ok(button, 'expected an Open run button');
    assert.ok(button.includes('https://github.com/o/r/actions/runs/123'));
    assert.ok(!fmt.stripAnsi(button).includes('https://github.com'));
  } finally {
    if (term === undefined) delete process.env.TERM;
    else process.env.TERM = term;
  }
});

function appOnRun(status) {
  const app = new App({});
  app.tui = { columns: 80, rows: 24, draw() {} };
  app.screen = 'run';
  app.watch = {
    runId: 123,
    run: { status, conclusion: status === 'completed' ? 'success' : null },
    jobs: [],
    scroll: 0,
    scrollMax: 0,
    finished: status === 'completed',
  };
  return app;
}

test('Esc returns to the workflow list once the run completes', () => {
  const app = appOnRun('completed');

  app.keyRun({ type: 'escape' });

  assert.equal(app.screen, 'workflows');
  assert.equal(app.watch, null);
});

test('Esc keeps watching while the run is still in progress', () => {
  const app = appOnRun('in_progress');

  app.keyRun({ type: 'escape' });

  assert.equal(app.screen, 'run');
  assert.ok(app.watch);
  assert.match(app.message, /still in progress/);
});

test('run footer labels b as a new run and offers Esc only after completion', () => {
  const running = appOnRun('in_progress');
  assert.ok(running.footerPairs().some(([key, label]) => key === 'b' && label === 'new run'));
  assert.ok(!running.footerPairs().some(([key]) => key === 'Esc'));

  const done = appOnRun('completed');
  assert.ok(done.footerPairs().some(([key, label]) => key === 'Esc' && label === 'back'));
});

