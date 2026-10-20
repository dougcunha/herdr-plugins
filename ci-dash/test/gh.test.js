'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Gh, GhError, parseGhError } = require('../src/gh');

const REPO = {
  host: 'github.com',
  owner: 'herdrdev',
  name: 'herdr',
  slug: 'herdrdev/herdr',
};

function ghWithApi(handler) {
  const gh = new Gh({ host: 'github.com', repo: REPO });
  gh.api = async (path, options = {}) => handler(path, options);
  return gh;
}

function ghWithStdout(stdout, capture) {
  return ghWithApi(async (path, options) => {
    if (capture) {
      capture.path = path;
      capture.options = options;
    }
    return { stdout, stderr: '' };
  });
}

test('dispatch sends the documented body and reads return_run_details', async () => {
  const capture = {};
  const gh = ghWithStdout(
    JSON.stringify({ workflow_run_id: 99, html_url: 'https://github.com/run/99' }),
    capture,
  );

  const result = await gh.dispatch(123, 'main', { dry_run: 'true' });

  assert.equal(capture.path, 'repos/herdrdev/herdr/actions/workflows/123/dispatches');
  assert.equal(capture.options.method, 'POST');
  assert.deepEqual(capture.options.headers, ['Accept: application/vnd.github+json']);
  assert.deepEqual(JSON.parse(capture.options.input), {
    ref: 'main',
    inputs: { dry_run: 'true' },
    return_run_details: true,
  });
  assert.deepEqual(result, {
    runId: 99,
    htmlUrl: 'https://github.com/run/99',
    raw: { workflow_run_id: 99, html_url: 'https://github.com/run/99' },
  });
});

test('dispatch tolerates the legacy 204 empty response', async () => {
  const gh = ghWithStdout('');
  const result = await gh.dispatch(123, 'main', {});

  assert.deepEqual(result, { runId: null, htmlUrl: null, raw: null });
});

test('dispatch keeps unexpected response bodies', async () => {
  const gh = ghWithStdout('not json');
  const result = await gh.dispatch(123, 'main', {});

  assert.deepEqual(result, { runId: null, htmlUrl: null, raw: 'not json' });
});

test('apiJson rejects empty and invalid responses', async () => {
  const empty = ghWithStdout('   ');
  await assert.rejects(empty.apiJson('user'), /empty response/);

  const invalid = ghWithStdout('nope');
  await assert.rejects(invalid.apiJson('user'), /invalid JSON/);
});

test('lists workflows across paginated pages', async () => {
  const capture = {};
  const gh = ghWithStdout(
    JSON.stringify([
      { total_count: 2, workflows: [{ id: 1 }, { id: 2 }] },
      { total_count: 3, workflows: [{ id: 3 }] },
    ]),
    capture,
  );

  const workflows = await gh.listWorkflows();

  assert.deepEqual(workflows.map((workflow) => workflow.id), [1, 2, 3]);
  assert.equal(capture.options.paginate, true);
  assert.equal(capture.options.slurp, true);
});

test('lists jobs across paginated pages', async () => {
  const gh = ghWithApi(async () => ({
    stdout: JSON.stringify([
      { total_count: 2, jobs: [{ id: 1 }, { id: 2 }] },
      { total_count: 3, jobs: [{ id: 3 }] },
    ]),
  }));

  const jobs = await gh.listJobs(7);
  assert.deepEqual(jobs.map((job) => job.id), [1, 2, 3]);
});

test('lists run artifacts across paginated pages', async () => {
  const capture = {};
  const gh = ghWithApi(async (path, options) => {
    capture.path = path;
    capture.options = options;
    return {
      stdout: JSON.stringify([
        { total_count: 2, artifacts: [{ id: 1 }, { id: 2 }] },
        { total_count: 3, artifacts: [{ id: 3 }] },
      ]),
    };
  });

  const artifacts = await gh.listArtifacts(7);

  assert.deepEqual(artifacts.map((artifact) => artifact.id), [1, 2, 3]);
  assert.equal(capture.path, 'repos/herdrdev/herdr/actions/runs/7/artifacts?per_page=100');
  assert.equal(capture.options.paginate, true);
  assert.equal(capture.options.slurp, true);
});

test('downloads an artifact into a per-run directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dash-artifacts-'));
  const calls = [];
  try {
    const gh = new Gh({
      host: 'github.com',
      repo: REPO,
      run: async (args, options) => {
        calls.push({ args, options });
        return { stdout: '', stderr: '' };
      },
    });

    const result = await gh.downloadArtifact(
      11,
      { id: 3, name: 'build logs', expired: false },
      { dir },
    );

    assert.deepEqual(calls[0].args, [
      'run',
      'download',
      '11',
      '--name',
      'build logs',
      '--dir',
      path.join(dir, '.ci-dash', 'artifacts', '11', 'build logs'),
      '-R',
      'github.com/herdrdev/herdr',
    ]);
    assert.equal(calls[0].options.timeout, 600000);
    assert.deepEqual(result, {
      dir: path.join(dir, '.ci-dash', 'artifacts', '11', 'build logs'),
    });
    assert.ok(fs.statSync(result.dir).isDirectory());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses to download an expired artifact', async () => {
  const gh = new Gh({
    host: 'github.com',
    repo: REPO,
    run: async () => {
      throw new Error('should not run');
    },
  });

  await assert.rejects(
    gh.downloadArtifact(11, { id: 3, name: 'logs', expired: true }),
    /has expired/,
  );
});

test('lists only branches by default', async () => {
  const calls = [];
  const gh = new Gh({ host: 'github.com', repo: REPO });
  gh.apiJson = async (path) => {
    calls.push(path);
    if (path.includes('/branches')) {
      return [[{ name: 'main', protected: true }, { name: 'dev' }]];
    }
    throw new Error(`unexpected request: ${path}`);
  };

  const refs = await gh.listRefs();

  assert.deepEqual(refs, [
    { name: 'main', type: 'branch', protected: true },
    { name: 'dev', type: 'branch', protected: false },
  ]);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/branches/);
});

test('can include tags when requested', async () => {
  const gh = new Gh({ host: 'github.com', repo: REPO });
  gh.apiJson = async (path) => {
    if (path.includes('/branches')) {
      return [[{ name: 'main', protected: true }, { name: 'dev' }]];
    }
    return [[{ name: 'v1.0.0' }]];
  };

  const refs = await gh.listRefs({ includeTags: true });

  assert.deepEqual(refs, [
    { name: 'main', type: 'branch', protected: true },
    { name: 'dev', type: 'branch', protected: false },
    { name: 'v1.0.0', type: 'tag', protected: false },
  ]);
});

test('reads and decodes a workflow file at a ref', async () => {
  const content = Buffer.from('on: workflow_dispatch\n').toString('base64');
  const capture = {};
  const gh = ghWithApi(async (path) => {
    capture.path = path;
    return {
      stdout: JSON.stringify({ type: 'file', encoding: 'base64', content }),
      stderr: '',
    };
  });

  const text = await gh.getWorkflowYaml(
    { path: '.github/workflows/release.yml' },
    'release/v1',
  );

  assert.equal(text, 'on: workflow_dispatch\n');
  assert.equal(
    capture.path,
    'repos/herdrdev/herdr/contents/.github/workflows/release.yml?ref=release%2Fv1',
  );
});

test('rejects a workflow path that is not a file', async () => {
  const gh = ghWithApi(async () => ({
    stdout: JSON.stringify({ type: 'dir' }),
    stderr: '',
  }));

  await assert.rejects(
    gh.getWorkflowYaml({ path: '.github/workflows/release.yml' }, 'main'),
    /is not a file/,
  );
});

test('queries dispatch runs by workflow, branch and actor', async () => {
  const capture = {};
  const gh = ghWithApi(async (path) => {
    capture.path = path;
    return { stdout: JSON.stringify({ workflow_runs: [{ id: 2 }, { id: 5 }] }), stderr: '' };
  });

  const latest = await gh.latestRunId(123, { ref: 'main', actor: 'tester' });

  assert.equal(latest, 5);
  assert.match(capture.path, /^repos\/herdrdev\/herdr\/actions\/workflows\/123\/runs\?/);
  assert.match(capture.path, /event=workflow_dispatch/);
  assert.match(capture.path, /per_page=20/);
  assert.match(capture.path, /branch=main/);
  assert.match(capture.path, /actor=tester/);
});

test('builds workflow URLs with GitHub-like fallbacks', () => {
  const gh = new Gh({ host: 'github.com', repo: REPO });

  assert.equal(
    gh.workflowHtmlUrl({ html_url: 'https://example.test/workflow' }),
    'https://example.test/workflow',
  );
  assert.equal(
    gh.workflowHtmlUrl({ path: '.github/workflows/release.yml' }),
    'https://github.com/herdrdev/herdr/actions/workflows/release.yml',
  );
  assert.equal(gh.workflowHtmlUrl({}), 'https://github.com/herdrdev/herdr/actions');
});

test('parses gh JSON and plain-text errors', () => {
  assert.equal(
    parseGhError(
      JSON.stringify({
        message: 'Validation Failed',
        errors: [{ resource: 'Workflow', field: 'ref', code: 'invalid' }],
      }),
    ),
    'Validation Failed — Workflow: ref: invalid',
  );
  assert.equal(
    parseGhError('HTTP 403: Resource not accessible\nsecond line\n'),
    'HTTP 403: Resource not accessible second line',
  );
  assert.equal(parseGhError(''), '');
});

test('GhError keeps HTTP details for hints', () => {
  const error = new GhError('denied', { status: 403, path: 'repos/x/y', method: 'POST' });
  assert.equal(error.status, 403);
  assert.equal(error.path, 'repos/x/y');
  assert.equal(error.method, 'POST');
});
