'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { App } = require('../src/app');
const { GhError } = require('../src/gh');
const fmt = require('../src/format');

delete process.env.HERDR_BIN_PATH;
delete process.env.HERDR_PANE_ID;

function completedRun(overrides = {}) {
  return {
    id: 11,
    run_number: 7,
    name: 'CI',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: 'abcdef1234567',
    run_started_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:01:00Z',
    run_attempt: 1,
    html_url: 'https://github.com/herdrdev/herdr/actions/runs/11',
    ...overrides,
  };
}

function prepare(app) {
  app.workflow = {
    id: 123,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    html_url: 'https://github.com/herdrdev/herdr/blob/main/.github/workflows/ci.yml',
  };
  app.workflowTitle = 'CI';
  app.ref = 'main';
  app.refType = 'branch';
  app.login = 'tester';
  app.inputs = [];
  app.repo = { host: 'github.com', slug: 'herdrdev/herdr' };
  return app;
}

async function waitFor(predicate, timeout = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}

test('dispatches, then polls the run to its final status', async () => {
  const app = prepare(new App({}));
  const calls = [];

  app.gh = {
    latestRunId: async (workflowId, options) => {
      calls.push(['latest', workflowId, options]);
      return 10;
    },
    dispatch: async (workflowId, ref, inputs) => {
      calls.push(['dispatch', workflowId, ref, inputs]);
      return { runId: 11 };
    },
    getRun: async () => completedRun(),
    listJobs: async () => [
      {
        name: 'build',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-01-01T00:00:00Z',
        completed_at: '2026-01-01T00:00:30Z',
        steps: [{ name: 'checkout', status: 'completed', conclusion: 'success' }],
      },
    ],
    listArtifacts: async () => [
      { id: 3, name: 'build-output', size_in_bytes: 2048, expired: false },
    ],
  };

  await app.dispatch();
  await waitFor(() => app.watch && app.watch.finished);

  assert.deepEqual(calls[0], ['latest', 123, { ref: 'main', actor: 'tester' }]);
  assert.deepEqual(calls[1], ['dispatch', 123, 'main', {}]);
  assert.equal(app.screen, 'run');
  assert.equal(app.watch.runId, 11);
  assert.equal(app.watch.run.conclusion, 'success');
  assert.equal(app.watch.jobs.length, 1);
  assert.equal(app.watch.artifacts.length, 1);
  assert.equal(app.watch.artifactsLoaded, true);
});

test('renders artifacts in the poll that completes the run', async () => {
  const app = prepare(new App({}));
  const drawn = [];
  app.tui = {
    columns: 100,
    rows: 40,
    draw(lines) {
      drawn.length = 0;
      drawn.push(...lines);
    },
  };
  app.screen = 'run';
  app.watch = {
    runId: 11,
    run: completedRun({ status: 'in_progress', conclusion: null }),
    jobs: [],
    artifacts: [],
    artifactsLoaded: false,
    artifactsError: null,
    tick: 0,
    notified: false,
    finished: false,
    scroll: 0,
    scrollMax: 0,
    jobsAt: 0,
    inFlight: false,
  };
  app.gh = {
    getRun: async () => completedRun(),
    listJobs: async () => [],
    listArtifacts: async () => [
      { id: 3, name: 'build-output', size_in_bytes: 2048, expired: false },
    ],
  };

  await app.pollWatch();

  assert.equal(app.watch.finished, true);
  assert.equal(app.watch.artifacts.length, 1);
  const rendered = drawn.map((line) => fmt.stripAnsi(line));
  assert.ok(rendered.some((line) => line.includes('Artifacts')));
  assert.ok(rendered.some((line) => line.includes('build-output')));
  assert.ok(rendered.some((line) => line.includes('[ download ]')));
  assert.ok(
    Array.from(app.clickTargets.values()).some((entries) =>
      entries.some((entry) => entry.target.kind === 'artifact'),
    ),
  );
});

test('downloads an artifact when its row is clicked', async () => {
  const app = prepare(new App({}));
  app.cwd = 'C:/repo';
  const artifact = { id: 3, name: 'build-output', size_in_bytes: 2048, expired: false };
  let download = null;

  app.tui = { columns: 100, rows: 30, draw() {} };
  app.screen = 'run';
  app.watch = {
    runId: 11,
    run: completedRun(),
    jobs: [],
    artifacts: [artifact],
    artifactsLoaded: true,
    finished: true,
    notified: true,
    scroll: 0,
    scrollMax: 0,
  };
  app.gh = {
    downloadArtifact: async (runId, value, options) => {
      download = { runId, artifact: value, options };
      return { dir: 'C:/repo/.ci-dash/artifacts/11/build-output' };
    },
  };

  app.render();
  const [rowY, entries] = Array.from(app.clickTargets.entries()).find(([, list]) =>
    list.some((entry) => entry.target.kind === 'artifact'),
  );
  assert.ok(entries, 'expected a clickable artifact row');

  app.onClick({ type: 'click', y: rowY, x: entries.find((entry) => entry.target.kind === 'artifact').start });
  await waitFor(() => app.message.startsWith('Downloaded'));

  assert.equal(download.runId, 11);
  assert.equal(download.artifact, artifact);
  assert.deepEqual(download.options, { dir: 'C:/repo' });
  assert.match(app.message, /build-output/);
  assert.match(app.message, /\.ci-dash/);
});

test('correlates the run when dispatch returns no details', async () => {
  const app = prepare(new App({}));
  const createdAt = new Date().toISOString();

  app.gh = {
    latestRunId: async () => 20,
    dispatch: async () => ({ runId: null }),
    listRuns: async () => [
      { id: 21, created_at: createdAt },
      { id: 20, created_at: '2025-12-31T23:00:00Z' },
    ],
    getRun: async () => completedRun({ id: 21 }),
    listJobs: async () => [],
  };

  await app.dispatch();
  await waitFor(() => app.watch && app.watch.finished);

  assert.equal(app.watch.runId, 21);
});

test('does not dispatch when an input is invalid', async () => {
  const app = prepare(new App({}));
  app.inputs = [
    {
      name: 'version',
      type: 'string',
      required: true,
      default: '',
      options: [],
      value: '',
    },
  ];

  let dispatched = false;
  app.gh = {
    latestRunId: async () => 0,
    dispatch: async () => {
      dispatched = true;
      return { runId: 11 };
    },
  };

  await app.dispatch();

  assert.equal(dispatched, false);
  assert.equal(app.screen, 'inputs');
  assert.equal(app.message, 'version is required.');
});

test('shows a GitHub error when dispatch fails', async () => {
  const app = prepare(new App({}));

  app.gh = {
    latestRunId: async () => 0,
    dispatch: async () => {
      throw new GhError('Resource not accessible by integration', { status: 403 });
    },
  };

  await app.dispatch();

  assert.equal(app.screen, 'error');
  assert.equal(app.error.title, 'GitHub request failed');
  assert.match(app.error.message, /Resource not accessible/);
  assert.match(app.error.details, /Actions write permission/);
});

test('stops watching a run after a permission error', async () => {
  const app = prepare(new App({}));
  let attempts = 0;

  app.gh = {
    latestRunId: async () => 0,
    dispatch: async () => ({ runId: 11 }),
    getRun: async () => {
      attempts += 1;
      throw new GhError('Not Found', { status: 404 });
    },
    listJobs: async () => [],
  };

  await app.dispatch();
  await waitFor(() => app.watch && app.watch.error);

  const first = attempts;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(attempts, first);
  assert.equal(app.pollTimer, null);
});
