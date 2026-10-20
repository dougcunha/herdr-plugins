'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

class GhError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GhError';
    this.status = details.status ?? null;
    this.stderr = details.stderr ?? '';
    this.stdout = details.stdout ?? '';
    this.path = details.path ?? '';
    this.method = details.method ?? '';
  }
}

function parseGhError(stderr) {
  const text = String(stderr || '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    const parts = [];
    if (parsed.message) parts.push(parsed.message);
    if (Array.isArray(parsed.errors)) {
      for (const error of parsed.errors) {
        if (typeof error === 'string') {
          parts.push(error);
        } else if (error && typeof error === 'object') {
          const bits = [error.resource, error.field, error.code, error.message].filter(Boolean);
          if (bits.length > 0) parts.push(bits.join(': '));
        }
      }
    }
    if (parts.length > 0) return parts.join(' — ');
  } catch {
    // Fall through to the plain-text form.
  }
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 4).join(' ');
}

function runGh(args, { input, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.GH_BIN || 'gh', args, {
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: '1',
        GH_PAGER: 'cat',
        PAGER: 'cat',
        NO_COLOR: '1',
        CLICOLOR: '0',
      },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new GhError(`gh timed out after ${Math.round(timeout / 1000)}s`, { stderr }));
    }, timeout);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const message =
        error.code === 'ENOENT'
          ? 'GitHub CLI (gh) was not found on PATH. Install it from https://cli.github.com and run gh auth login.'
          : `Could not start gh: ${error.message}`;
      reject(new GhError(message, { stderr }));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const message = parseGhError(stderr) || `gh exited with status ${code}`;
      reject(new GhError(message, { status: code, stderr, stdout }));
    });

    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

function flattenPages(data) {
  if (!Array.isArray(data)) return [];
  if (data.length === 0) return [];
  if (Array.isArray(data[0])) return data.flat();
  return data;
}

function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

function safeArtifactDir(name) {
  const cleaned = String(name || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '');
  return cleaned || 'artifact';
}

class Gh {
  constructor({ host, repo, run = runGh }) {
    this.host = host || 'github.com';
    this.repo = repo;
    this.run = run;
  }

  get slug() {
    return this.repo ? this.repo.slug : '';
  }

  repoPath(suffix = '') {
    return `repos/${this.repo.owner}/${this.repo.name}${suffix}`;
  }

  async api(path, options = {}) {
    const {
      method,
      input,
      headers = [],
      paginate = false,
      slurp = false,
      jq,
      timeout = 120000,
    } = options;

    const args = ['api', '--hostname', this.host];
    if (method) args.push('--method', method);
    if (paginate) args.push('--paginate');
    if (slurp) args.push('--slurp');
    if (jq) args.push('--jq', jq);
    for (const header of headers) args.push('--header', header);
    if (input != null) args.push('--input', '-');
    args.push(path);

    try {
      return await this.run(args, { input, timeout });
    } catch (error) {
      if (error instanceof GhError) {
        error.path = path;
        error.method = method || 'GET';
      }
      throw error;
    }
  }

  async apiJson(path, options = {}) {
    const { stdout } = await this.api(path, options);
    const text = stdout.trim();
    if (!text) throw new GhError(`GitHub returned an empty response for ${path}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new GhError(`GitHub returned invalid JSON for ${path}`);
    }
  }

  async apiText(path, options = {}) {
    const { stdout } = await this.api(path, options);
    return stdout;
  }

  async getLogin() {
    const user = await this.apiJson('user');
    return user.login;
  }

  async getRepo() {
    return this.apiJson(this.repoPath());
  }

  async listWorkflows() {
    const data = await this.apiJson(this.repoPath('/actions/workflows?per_page=100'), {
      paginate: true,
      slurp: true,
    });
    const pages = Array.isArray(data) ? data : [data];
    return pages.flatMap((page) => page.workflows || []);
  }

  async listRefs({ includeTags = false } = {}) {
    const branchPages = await this.apiJson(
      this.repoPath('/branches?per_page=100'),
      { paginate: true, slurp: true },
    );

    const branches = flattenPages(branchPages).map((branch) => ({
      name: branch.name,
      type: 'branch',
      protected: Boolean(branch.protected),
    }));

    if (!includeTags) return branches;

    const tagPages = await this.apiJson(this.repoPath('/tags?per_page=100'), {
      paginate: true,
      slurp: true,
    });
    const tags = flattenPages(tagPages).map((tag) => ({
      name: tag.name,
      type: 'tag',
      protected: false,
    }));

    const seen = new Set();
    const refs = [];
    for (const ref of [...branches, ...tags]) {
      const key = `${ref.type}:${ref.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
    return refs;
  }

  async getWorkflowYaml(workflow, ref) {
    const path = this.repoPath(
      `/contents/${encodePath(workflow.path)}?ref=${encodeURIComponent(ref)}`,
    );
    const data = await this.apiJson(path);

    if (data.type !== 'file' || !data.content) {
      throw new GhError(`${workflow.path} is not a file on ${ref}`);
    }

    const encoding = data.encoding === 'base64' ? 'base64' : 'utf8';
    const text = Buffer.from(data.content, encoding).toString('utf8');
    if (!text.trim()) throw new GhError(`${workflow.path} is empty on ${ref}`);
    return text;
  }

  async dispatch(workflowId, ref, inputs) {
    const body = JSON.stringify({
      ref,
      inputs,
      return_run_details: true,
    });

    const { stdout } = await this.api(
      this.repoPath(`/actions/workflows/${workflowId}/dispatches`),
      {
        method: 'POST',
        input: body,
        headers: ['Accept: application/vnd.github+json'],
      },
    );

    const text = stdout.trim();
    if (!text) return { runId: null, htmlUrl: null, raw: null };

    try {
      const data = JSON.parse(text);
      return {
        runId: data.workflow_run_id ?? null,
        htmlUrl: data.html_url ?? data.run_url ?? null,
        raw: data,
      };
    } catch {
      return { runId: null, htmlUrl: null, raw: text };
    }
  }

  async listRuns(workflowId, { ref, actor, perPage = 20 } = {}) {
    const params = new URLSearchParams({
      event: 'workflow_dispatch',
      per_page: String(perPage),
    });
    if (ref) params.set('branch', ref);
    if (actor) params.set('actor', actor);

    const data = await this.apiJson(
      this.repoPath(`/actions/workflows/${workflowId}/runs?${params.toString()}`),
    );
    return data.workflow_runs || [];
  }

  async latestRuns(workflowId, perPage = 5) {
    const data = await this.apiJson(
      this.repoPath(`/actions/workflows/${workflowId}/runs?per_page=${perPage}`),
    );
    return data.workflow_runs || [];
  }

  async latestRunId(workflowId, { ref, actor } = {}) {
    const runs = await this.listRuns(workflowId, { ref, actor, perPage: 20 });
    return runs.reduce((max, run) => Math.max(max, Number(run.id) || 0), 0);
  }

  async getRun(runId) {
    return this.apiJson(this.repoPath(`/actions/runs/${runId}`));
  }

  async listJobs(runId) {
    const data = await this.apiJson(
      this.repoPath(`/actions/runs/${runId}/jobs?per_page=100`),
      { paginate: true, slurp: true },
    );
    const pages = Array.isArray(data) ? data : [data];
    return pages.flatMap((page) => page.jobs || []);
  }

  async listArtifacts(runId) {
    const data = await this.apiJson(
      this.repoPath(`/actions/runs/${runId}/artifacts?per_page=100`),
      { paginate: true, slurp: true },
    );
    const pages = Array.isArray(data) ? data : [data];
    return pages.flatMap((page) => page.artifacts || []);
  }

  async downloadArtifact(runId, artifact, { dir } = {}) {
    const name = String(artifact?.name || '').trim();
    if (!name) throw new GhError('The artifact has no name.');
    if (artifact.expired) {
      throw new GhError(`Artifact "${name}" has expired and can no longer be downloaded.`);
    }

    const root = path.resolve(dir || process.cwd());
    const target = path.join(
      root,
      '.ci-dash',
      'artifacts',
      String(runId),
      safeArtifactDir(name),
    );
    fs.mkdirSync(target, { recursive: true });

    await this.run(
      [
        'run',
        'download',
        String(runId),
        '--name',
        name,
        '--dir',
        target,
        '-R',
        `${this.host}/${this.slug}`,
      ],
      { timeout: 600000 },
    );
    return { dir: target };
  }

  async listEnvironments() {
    try {
      const data = await this.apiJson(this.repoPath('/environments?per_page=100'));
      return (data.environments || []).map((environment) => environment.name);
    } catch {
      return [];
    }
  }

  async cancelRun(runId) {
    await this.api(this.repoPath(`/actions/runs/${runId}/cancel`), {
      method: 'POST',
      headers: ['Accept: application/vnd.github+json'],
    });
  }

  async rerunRun(runId) {
    await this.api(this.repoPath(`/actions/runs/${runId}/rerun`), {
      method: 'POST',
      headers: ['Accept: application/vnd.github+json'],
    });
  }

  async openRunWeb(runId) {
    await runGh(['run', 'view', String(runId), '--web', '-R', `${this.host}/${this.slug}`]);
  }

  workflowHtmlUrl(workflow) {
    if (workflow?.html_url) return workflow.html_url;
    if (!workflow?.path) return `https://${this.host}/${this.slug}/actions`;
    const filename = workflow.path.split('/').pop();
    return `https://${this.host}/${this.slug}/actions/workflows/${encodeURIComponent(filename)}`;
  }
}

function ghErrorHint(error) {
  if (!(error instanceof GhError)) return '';
  if (error.status === 401) return 'Run gh auth login and try again.';
  if (error.status === 403) {
    return 'The token may need Actions write permission, or the organization may require SSO authorization.';
  }
  if (error.status === 404) {
    return 'The repository or workflow was not found, or the token has no access.';
  }
  if (error.status === 422) {
    return 'GitHub rejected the request. Check the selected ref and input values.';
  }
  if (error.status === 429) {
    return 'GitHub rate limit reached. Wait a moment and retry.';
  }
  return '';
}

module.exports = {
  Gh,
  GhError,
  ghErrorHint,
  parseGhError,
  runGh,
};
