'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('shows the plugin version in the footer', () => {
  const app = appOnRun('completed');
  const version = require('../package.json').version;

  const lines = app.footerLines(80).map((line) => fmt.stripAnsi(line).trimEnd());
  assert.ok(lines.some((line) => line.endsWith(`v${version}`)));

  const narrow = app.footerLines(4).map((line) => fmt.stripAnsi(line));
  assert.ok(!narrow.some((line) => line.includes(`v${version}`)));
});

test('lists artifacts only after the run completes', () => {
  const app = appOnRun('completed');
  app.watch.artifacts = [
    { id: 1, name: 'build-output', size_in_bytes: 2048, expired: false },
  ];

  const lines = app.runBody(80, 40).map((line) => fmt.stripAnsi(line));
  assert.ok(lines.some((line) => line.includes('Artifacts')));
  assert.ok(lines.some((line) => line.includes('build-output') && line.includes('2 KB')));

  app.watch.artifacts = [];
  const without = app.runBody(80, 40).map((line) => fmt.stripAnsi(line));
  assert.ok(!without.some((line) => line.includes('Artifacts')));

  const running = appOnRun('in_progress');
  running.watch.artifacts = [
    { id: 1, name: 'build-output', size_in_bytes: 2048, expired: false },
  ];
  const during = running.runBody(80, 40).map((line) => fmt.stripAnsi(line));
  assert.ok(!during.some((line) => line.includes('Artifacts')));
});

test('highlights the artifact row under the mouse', () => {
  const app = appOnRun('completed');
  app.watch.artifacts = [
    { id: 7, name: 'build-output', size_in_bytes: 2048, expired: false },
  ];
  const pointers = [];
  app.tui.setPointer = (value) => pointers.push(value);

  app.render();
  const row = Array.from(app.clickTargets.entries()).find(([, entries]) =>
    entries.some((entry) => entry.target.kind === 'artifact'),
  )[0];

  app.onHover({ type: 'move', y: row });

  assert.equal(app.hoverKey, 'artifact:7');
  assert.equal(pointers[pointers.length - 1], true);

  app.onHover({ type: 'move', y: 1 });
  assert.equal(app.hoverKey, null);
  assert.equal(pointers[pointers.length - 1], false);
});

test('opens the run when the Open run row is clicked', () => {
  const app = appOnRun('completed');
  app.watch.run.html_url = 'https://github.com/o/r/actions/runs/123';
  let opened = null;
  app.gh = {
    openRunWeb: async (runId) => {
      opened = runId;
    },
  };

  app.render();
  const row = Array.from(app.clickTargets.entries()).find(([, entries]) =>
    entries.some((entry) => entry.target.kind === 'run'),
  );
  app.onClick({ type: 'click', y: row[0], x: row[1][0].start });

  assert.equal(opened, 123);
});

test('marks expired artifacts without making them clickable', () => {
  const app = appOnRun('completed');
  app.watch.artifacts = [
    { id: 1, name: 'old-output', size_in_bytes: 1024, expired: true },
  ];
  app.render();

  const lines = app.runBody(80, 40).map((line) => fmt.stripAnsi(line));
  assert.ok(lines.some((line) => line.includes('old-output') && line.includes('expired')));
  assert.equal(app.clickLines.length, 0);
});

function appWithArtifacts({ workflows = [], runs = {}, artifacts = {} } = {}) {
  const app = new App({});
  app.tui = { columns: 100, rows: 30, draw() {} };
  app.repo = { host: 'github.com', owner: 'o', name: 'r', slug: 'o/r' };
  app.repoData = { default_branch: 'main' };
  app.gh = {
    listWorkflows: async () => workflows,
    latestRuns: async (workflowId) => runs[workflowId] || [],
    listArtifacts: async (runId) => artifacts[runId] || [],
    downloadArtifact: async (runId, artifact) => ({
      dir: `/tmp/${runId}/${artifact.name}`,
    }),
  };
  return app;
}

const BUILD = {
  id: 1,
  name: 'Build',
  path: '.github/workflows/build.yml',
  state: 'active',
};
const LINT = {
  id: 2,
  name: 'Lint',
  path: '.github/workflows/lint.yml',
  state: 'active',
};

function artifactsTabApp() {
  const app = appWithArtifacts({
    workflows: [BUILD, LINT],
    runs: {
      1: [
        { id: 11, run_number: 2, head_branch: 'main' },
        { id: 10, run_number: 1, head_branch: 'main' },
      ],
      2: [{ id: 20, run_number: 5, head_branch: 'dev' }],
    },
    artifacts: {
      11: [],
      10: [
        {
          id: 100,
          name: 'build-output.zip',
          size_in_bytes: 2048,
          created_at: '2026-01-01T10:30:00',
          expired: false,
        },
      ],
      20: [
        {
          id: 200,
          name: 'lint report.txt',
          size_in_bytes: 10,
          created_at: '2026-01-02T09:00:00',
          expired: false,
        },
      ],
    },
  });
  app.tab = 'artifacts';
  app.screen = 'workflows';
  return app;
}

test('reads the artifacts of the newest run that produced some', async () => {
  const app = artifactsTabApp();

  await app.loadArtifactTab();

  assert.deepEqual(
    app.artifactTab.groups.map((group) => group.run.id),
    [20, 10],
  );
  assert.equal(app.artifactTab.loaded, true);
});

function artifactFixture(overrides = {}) {
  return {
    id: 100,
    name: 'build-output.zip',
    size_in_bytes: 2048,
    created_at: '2026-01-01T10:30:00',
    expired: false,
    ...overrides,
  };
}

function artifactGroup(artifacts) {
  return {
    workflow: BUILD,
    run: { id: 10, run_number: 1, head_branch: 'main' },
    artifacts,
  };
}

test('artifacts tab shows the full name, creation date and size', () => {
  const app = artifactsTabApp();
  app.artifactTab.loaded = true;
  app.artifactTab.groups = [artifactGroup([artifactFixture()])];

  const lines = app.artifactsBody(90, 30).map((line) => fmt.stripAnsi(line));

  assert.ok(lines.some((line) => line.includes('build-output.zip')));
  assert.ok(lines.some((line) => line.includes('2026-01-01 10:30')));
  assert.ok(lines.some((line) => line.includes('2 KB')));
});

function findClickTarget(app, kind) {
  for (const [y, entries] of app.clickTargets) {
    const hit = entries.find((entry) => entry.target.kind === kind);
    if (hit) return { y, x: hit.start };
  }
  return null;
}

test('clicking an artifact row downloads it from its own run', async () => {
  const app = artifactsTabApp();
  app.artifactTab.loaded = true;
  app.artifactTab.groups = [artifactGroup([artifactFixture()])];
  const downloads = [];
  app.gh.downloadArtifact = async (runId, artifact) => {
    downloads.push([runId, artifact.name]);
    return { dir: '/tmp/out' };
  };

  app.render();
  app.onClick({ type: 'click', ...findClickTarget(app, 'artifact') });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(downloads, [[10, 'build-output.zip']]);
});

test('Enter downloads the artifact selected with the arrow keys', async () => {
  const app = artifactsTabApp();
  app.artifactTab.loaded = true;
  app.artifactTab.groups = [
    artifactGroup([
      artifactFixture({ id: 100, name: 'first.zip', size_in_bytes: 1 }),
      artifactFixture({ id: 101, name: 'old.zip', expired: true }),
      artifactFixture({ id: 102, name: 'second.zip', size_in_bytes: 3 }),
    ]),
  ];
  const downloads = [];
  app.gh.downloadArtifact = async (runId, artifact) => {
    downloads.push([runId, artifact.name]);
    return { dir: '/tmp/out' };
  };

  app.render();
  app.keyArtifacts({ type: 'down' });
  app.keyArtifacts({ type: 'enter' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(downloads, [[10, 'second.zip']]);
});

test('artifacts load on first open and the refresh button reloads them', async () => {
  const app = appWithArtifacts();
  let calls = 0;
  app.gh.listWorkflows = async () => {
    calls += 1;
    return [];
  };

  await app.openTab('artifacts');
  assert.equal(calls, 1);

  app.openTab('dispatch');
  await app.openTab('artifacts');
  assert.equal(calls, 1);

  app.onClick({ type: 'click', ...findClickTarget(app, 'refresh') });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
});

test('the folder button opens the artifacts download folder', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dash-'));
  const dir = path.join(cwd, '.ci-dash', 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  const app = appWithArtifacts();
  const opened = [];
  app.cwd = cwd;
  app.openPath = async (target) => {
    opened.push(target);
  };

  await app.openTab('artifacts');
  app.onClick({ type: 'click', ...findClickTarget(app, 'folder') });
  await new Promise((resolve) => setImmediate(resolve));
  app.keyArtifacts({ type: 'char', ch: 'o' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(opened, [dir, dir]);
  assert.equal(app.message, `Opened ${dir}`);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('the folder button opens the folder of the selected artifact once downloaded', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dash-'));
  const root = path.join(cwd, '.ci-dash', 'artifacts');
  const second = path.join(root, '10', 'second.zip');
  fs.mkdirSync(second, { recursive: true });
  const app = artifactsTabApp();
  const opened = [];
  app.cwd = cwd;
  app.openPath = async (target) => {
    opened.push(target);
  };
  app.artifactTab.loaded = true;
  app.artifactTab.groups = [
    artifactGroup([
      artifactFixture({ id: 100, name: 'first.zip' }),
      artifactFixture({ id: 102, name: 'second.zip' }),
    ]),
  ];
  app.render();

  // The first artifact was not downloaded, so the root opens.
  await app.openArtifactsFolder();
  app.keyArtifacts({ type: 'down' });
  await app.openArtifactsFolder();
  // A download from another run is the fallback for an artifact not on disk.
  app.lastDownloadDir = second;
  app.keyArtifacts({ type: 'up' });
  await app.openArtifactsFolder();

  assert.deepEqual(opened, [root, second, second]);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('the folder button reports when nothing was downloaded yet', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dash-'));
  const app = appWithArtifacts();
  let opened = 0;
  app.cwd = cwd;
  app.openPath = async () => {
    opened += 1;
  };

  await app.openArtifactsFolder();

  assert.equal(opened, 0);
  assert.match(app.message, /No artifacts downloaded yet/);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('the tab bar shows icon buttons when the labeled buttons do not fit', async () => {
  const app = appWithArtifacts();
  await app.openTab('artifacts');
  const bar = (width) => {
    const { lines, spans } = app.tabLines(width);
    return {
      text: fmt.stripAnsi(lines[0]),
      kinds: spans.map((span) => span.target.kind).filter((kind) => kind !== 'tab'),
    };
  };

  const wide = bar(80);
  const narrow = bar(40);

  assert.deepEqual(wide.kinds, ['folder', 'refresh']);
  assert.ok(wide.text.includes('Open folder'));
  assert.deepEqual(narrow.kinds, ['folder', 'refresh']);
  assert.ok(!narrow.text.includes('Open folder'));
  assert.ok(!narrow.text.includes('Refresh'));
  assert.equal(fmt.visibleLength(narrow.text), 40);
});

test('artifacts tab reports a failed load and offers a retry', async () => {
  const app = appWithArtifacts();
  app.gh.listWorkflows = async () => {
    throw new Error('boom');
  };

  await app.loadArtifactTab();
  const lines = app.artifactsBody(80, 20).map((line) => fmt.stripAnsi(line));

  assert.equal(app.artifactTab.loaded, false);
  assert.ok(lines.some((line) => line.includes('boom')));
  assert.ok(lines.some((line) => line.includes('r to try again')));
});

test('Tab switches between the dispatch flow and the artifacts tab', () => {
  const app = appWithArtifacts();

  app.keyWorkflows({ type: 'tab' });
  assert.equal(app.tab, 'artifacts');

  app.keyArtifacts({ type: 'tab' });
  assert.equal(app.tab, 'dispatch');
});

