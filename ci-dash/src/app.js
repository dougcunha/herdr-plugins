'use strict';

const { execFile } = require('node:child_process');
const { resolveRepo } = require('./git');
const { Gh, GhError, ghErrorHint } = require('./gh');
const { parseWorkflowInputs, WorkflowInputError } = require('./workflow-inputs');
const { Tui } = require('./tui');
const fmt = require('./format');
const ui = require('./ui');

class UserError extends Error {
  constructor(message, details = '') {
    super(message);
    this.name = 'UserError';
    this.details = details;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Runs an async mapper over a list with a bounded number of workers. The
 * workflow probe must read one file per workflow, so concurrency keeps the
 * first load fast without hammering the GitHub API.
 */
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

class App {
  constructor({ cwd, quick = false, diagnose = false } = {}) {
    this.cwd = cwd || process.cwd();
    this.quick = quick;
    this.diagnose = diagnose;

    this.tui = null;
    this.screen = 'loading';
    this.message = '';
    this.error = null;
    this.retry = null;
    this.errorBack = null;

    this.repoInfo = null;
    this.repo = null;
    this.repoData = null;
    this.login = '';
    this.gh = null;

    this.workflows = [];
    this.wfIndex = 0;
    this.wfFilter = '';
    this.wfFilterMode = false;
    this.wfTop = 0;

    this.workflow = null;
    this.workflowTitle = '';
    this.refs = [];
    this.refIndex = 0;
    this.refFilter = '';
    this.refFilterMode = false;
    this.refTop = 0;
    this.ref = '';
    this.refType = 'branch';

    this.inputs = [];
    this.fieldIndex = 0;
    this.editing = false;
    this.warnings = [];

    this.watch = null;
    this.pollTimer = null;
  }

  async run() {
    if (this.diagnose) {
      try {
        await this.diagnoseRun();
      } catch (error) {
        process.stderr.write(`${this.errorText(error)}\n`);
        process.exitCode = 1;
      }
      return;
    }

    try {
      this.tui = new Tui({
        onKey: (event) => this.onKey(event),
        onResize: () => this.render(),
      });
      this.tui.start();
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }

    try {
      await this.boot();
    } catch (error) {
      this.fail(error, { retry: () => this.boot() });
    }

    this.render();
  }

  async diagnoseRun() {
    const info = await resolveRepo({
      cwd: this.cwd,
      override: process.env.CI_DASH_REPO,
    });

    if (!info.repo) {
      throw new UserError(
        'No GitHub repository found.',
        `cwd: ${info.cwd}\nremotes: ${info.remotes.join(', ') || '(none)'}\nSet CI_DASH_REPO=owner/repo or host/owner/repo.`,
      );
    }

    const gh = new Gh({ host: info.repo.host, repo: info.repo });
    const [login, repoData, workflows] = await Promise.all([
      gh.getLogin(),
      gh.getRepo(),
      gh.listWorkflows(),
    ]);

    const candidates = workflows
      .filter((workflow) => workflow.path && workflow.path.startsWith('.github/workflows/'))
      .slice(0, 10);

    let sample = null;
    for (const workflow of candidates) {
      try {
        const yaml = await gh.getWorkflowYaml(workflow, repoData.default_branch);
        const parsed = parseWorkflowInputs(yaml);
        if (parsed.dispatchable) {
          sample = {
            workflow,
            ref: repoData.default_branch,
            inputs: parsed.inputs,
            warnings: parsed.warnings,
          };
          break;
        }
      } catch {
        // Try the next workflow.
      }
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          cwd: info.cwd,
          root: info.root,
          isGit: info.isGit,
          branch: info.branch,
          remotes: info.remotes,
          remote: info.remote,
          repo: info.repo,
          login,
          repoData: {
            default_branch: repoData.default_branch,
            html_url: repoData.html_url,
            private: repoData.private,
          },
          workflows: workflows.map((workflow) => ({
            id: workflow.id,
            name: workflow.name,
            path: workflow.path,
            state: workflow.state,
          })),
          sample,
        },
        null,
        2,
      )}\n`,
    );
  }

  async boot() {
    this.screen = 'loading';
    this.message = 'Resolving repository...';
    this.render();

    this.repoInfo = await resolveRepo({
      cwd: this.cwd,
      override: process.env.CI_DASH_REPO,
    });

    if (!this.repoInfo.repo) {
      const details = [
        `cwd: ${this.repoInfo.cwd}`,
        `git repository: ${this.repoInfo.isGit ? 'yes' : 'no'}`,
        `remotes: ${this.repoInfo.remotes.join(', ') || '(none)'}`,
        '',
        'Set CI_DASH_REPO=owner/repo or host/owner/repo to override.',
      ].join('\n');
      throw new UserError(
        this.repoInfo.isGit
          ? 'No GitHub remote was found for this repository.'
          : 'This directory is not a Git repository.',
        details,
      );
    }

    this.repo = this.repoInfo.repo;
    this.gh = new Gh({ host: this.repo.host, repo: this.repo });

    this.message = `Reading ${this.repo.host}/${this.repo.slug}...`;
    this.render();

    const [login, repoData] = await Promise.all([
      this.gh.getLogin(),
      this.gh.getRepo(),
    ]);
    this.login = login;
    this.repoData = repoData;
    this.repo.defaultBranch = repoData.default_branch;
    this.repo.htmlUrl = repoData.html_url;

    await this.loadWorkflows();
  }

  async loadWorkflows() {
    this.screen = 'loading';
    this.message = 'Loading workflows...';
    this.render();

    try {
      const defaultBranch = this.repoData?.default_branch || '';
      const list = await this.gh.listWorkflows();
      const candidates = list.filter(
        (workflow) =>
          workflow.path &&
          workflow.path.startsWith('.github/workflows/') &&
          workflow.state !== 'deleted',
      );

      if (candidates.length === 0) {
        throw new UserError(
          'No GitHub Actions workflows were found.',
          `Repository: ${this.gh.workflowHtmlUrl()}`,
        );
      }

      this.message = 'Checking which workflows can be dispatched manually...';
      this.render();

      const probes = await mapLimit(candidates, 6, async (workflow) => {
        if (workflow.state !== 'active') {
          return { workflow, dispatchable: false };
        }
        try {
          const yaml = await this.gh.getWorkflowYaml(workflow, defaultBranch);
          const parsed = parseWorkflowInputs(yaml);
          return {
            workflow: { ...workflow, dispatchYaml: yaml },
            dispatchable: parsed.dispatchable,
          };
        } catch (error) {
          return { workflow, dispatchable: false, error };
        }
      });

      const workflows = probes
        .filter((probe) => probe.dispatchable)
        .map((probe) => probe.workflow)
        .sort((left, right) => left.name.localeCompare(right.name));

      if (workflows.length === 0) {
        const errors = probes.filter((probe) => probe.error);
        if (errors.length === probes.length) throw errors[0].error;

        throw new UserError(
          'No manually dispatchable workflows were found.',
          [
            `Repository: ${this.gh.workflowHtmlUrl()}`,
            `Default branch: ${defaultBranch || '(unknown)'}`,
            'No active workflow declares the workflow_dispatch trigger on the default branch.',
            'Add "on: workflow_dispatch" to a workflow file to run it here.',
          ].join('\n'),
        );
      }

      this.workflows = workflows;
      this.wfIndex = 0;
      this.wfFilter = '';
      this.wfFilterMode = false;
      this.wfTop = 0;
      this.message = '';
      this.screen = 'workflows';
      this.render();
    } catch (error) {
      this.fail(error, {
        retry: () => this.loadWorkflows(),
        back:
          this.workflows.length > 0
            ? () => {
                this.screen = 'workflows';
                this.render();
              }
            : null,
      });
    }
  }

  async chooseWorkflow() {
    const workflow = this.filteredWorkflows()[this.wfIndex];
    if (!workflow) return;

    this.workflow = workflow;
    this.workflowTitle = workflow.name;
    const includeTags = process.env.CI_DASH_INCLUDE_TAGS === '1';
    this.screen = 'loading';
    this.message = `Loading ${
      includeTags ? 'branches and tags' : 'branches'
    } for ${workflow.name}...`;
    this.render();

    try {
      const refs = await this.gh.listRefs({ includeTags });
      const defaultBranch = this.repoData?.default_branch || '';
      const currentBranch = this.repoInfo?.branch || '';

      refs.sort((left, right) => {
        const rank = (ref) => {
          if (ref.name === defaultBranch) return 0;
          if (ref.name === currentBranch) return 1;
          if (ref.type === 'branch') return 2;
          return 3;
        };
        return rank(left) - rank(right) || left.name.localeCompare(right.name);
      });

      if (refs.length === 0) {
        throw new UserError(
          includeTags ? 'No branches or tags were found.' : 'No branches were found.',
          `Repository: ${this.gh.workflowHtmlUrl(workflow)}`,
        );
      }

      this.refs = refs;
      this.refIndex = 0;
      this.refFilter = '';
      this.refFilterMode = false;
      this.refTop = 0;
      this.screen = 'refs';
      this.message = '';
      this.render();
    } catch (error) {
      this.fail(error, {
        retry: () => this.chooseWorkflow(),
        back: () => {
          this.screen = 'workflows';
          this.render();
        },
      });
    }
  }

  async chooseRef() {
    const ref = this.filteredRefs()[this.refIndex];
    if (!ref) return;

    this.ref = ref.name;
    this.refType = ref.type;
    this.screen = 'loading';
    this.message = `Reading ${this.workflow.path} at ${ref.name}...`;
    this.render();

    try {
      const yaml =
        ref.name === this.repoData?.default_branch && this.workflow?.dispatchYaml
          ? this.workflow.dispatchYaml
          : await this.gh.getWorkflowYaml(this.workflow, ref.name);
      const parsed = parseWorkflowInputs(yaml);

      if (!parsed.dispatchable) {
        throw new UserError(
          'This workflow cannot be started manually.',
          'It does not declare the workflow_dispatch trigger. Choose another workflow, or add "on: workflow_dispatch" to the workflow file.',
        );
      }

      this.inputs = parsed.inputs.map((input) => ({
        ...input,
        value: input.default,
        editValue: '',
        editOriginal: '',
      }));
      this.workflowTitle = parsed.name || this.workflow.name;
      this.warnings = parsed.warnings;
      this.fieldIndex = 0;
      this.editing = false;
      this.message = '';
      // With no inputs there is nothing to fill, so jump straight to Review.
      this.screen = this.inputs.length > 0 ? 'inputs' : 'confirm';
      this.render();
    } catch (error) {
      this.fail(error, {
        retry: () => this.chooseRef(),
        back: () => {
          this.screen = 'refs';
          this.render();
        },
      });
    }
  }

  validateInputs() {
    if (this.inputs.length > 25) {
      return { index: 0, message: 'GitHub accepts at most 25 inputs per dispatch.' };
    }

    for (let index = 0; index < this.inputs.length; index += 1) {
      const field = this.inputs[index];
      const value = String(field.value ?? '');

      if (field.required && value.trim() === '') {
        return { index, message: `${field.name} is required.` };
      }
      if (
        field.type === 'number' &&
        value.trim() !== '' &&
        !Number.isFinite(Number(value))
      ) {
        return { index, message: `${field.name} must be a number.` };
      }
      if (
        field.type === 'choice' &&
        field.options.length > 0 &&
        !field.options.includes(value)
      ) {
        return {
          index,
          message: `${field.name} must be one of: ${field.options.join(', ')}.`,
        };
      }
    }

    return null;
  }

  validateAndConfirm() {
    const problem = this.validateInputs();
    if (problem) {
      this.fieldIndex = problem.index;
      this.screen = 'inputs';
      this.message = problem.message;
      this.render();
      return;
    }

    this.message = '';
    this.screen = 'confirm';
    this.render();
  }

  buildPayload() {
    const inputs = {};
    for (const field of this.inputs) {
      if (field.type === 'boolean') {
        inputs[field.name] = field.value === 'true' ? 'true' : 'false';
      } else {
        inputs[field.name] = String(field.value ?? '');
      }
    }
    return inputs;
  }

  async dispatch() {
    const problem = this.validateInputs();
    if (problem) {
      this.fieldIndex = problem.index;
      this.screen = 'inputs';
      this.message = problem.message;
      this.render();
      return;
    }

    this.screen = 'loading';
    this.message = 'Dispatching workflow...';
    this.render();

    const inputs = this.buildPayload();
    const branch = this.refType === 'branch' ? this.ref : '';
    let baseline = 0;
    try {
      baseline = await this.gh.latestRunId(this.workflow.id, {
        ref: branch,
        actor: this.login,
      });
    } catch {
      baseline = 0;
    }

    const startedAt = Date.now();
    let result;
    try {
      result = await this.gh.dispatch(this.workflow.id, this.ref, inputs);
    } catch (error) {
      this.fail(error, {
        retry: () => this.dispatch(),
        back: () => {
          this.screen = 'confirm';
          this.render();
        },
      });
      return;
    }

    let runId = result.runId;
    if (!runId) {
      try {
        runId = await this.findRun(baseline, startedAt);
      } catch (error) {
        this.fail(error, {
          back: () => {
            this.screen = 'confirm';
            this.render();
          },
        });
        return;
      }
    }

    if (!runId) {
      this.fail(
        new UserError(
          'The workflow was dispatched, but its run could not be located.',
          `Open ${this.gh.workflowHtmlUrl(this.workflow)} and select the new run manually. It was not dispatched a second time.`,
        ),
        {
          back: () => {
            this.screen = 'confirm';
            this.render();
          },
        },
      );
      return;
    }

    this.startWatch(runId);
  }

  async findRun(baseline, startedAt) {
    const branch = this.refType === 'branch' ? this.ref : '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (attempt > 0) await sleep(3000);
      this.message = `Workflow dispatched. Looking for the new run (${attempt + 1}/30)...`;
      this.render();

      try {
        const runs = await this.gh.listRuns(this.workflow.id, {
          ref: branch,
          actor: this.login,
          perPage: 20,
        });
        const match = runs.find((run) => {
          const createdAt = Date.parse(run.created_at || '');
          return (
            Number(run.id) > baseline &&
            Number.isFinite(createdAt) &&
            createdAt >= startedAt - 60000
          );
        });
        if (match) return match.id;
      } catch (error) {
        if (
          error instanceof GhError &&
          [401, 403, 404].includes(error.status)
        ) {
          throw error;
        }
      }
    }
    return null;
  }

  startWatch(runId) {
    this.stopPoll();
    this.watch = {
      runId,
      run: null,
      jobs: [],
      error: null,
      tick: 0,
      notified: false,
      finished: false,
      scroll: 0,
      scrollMax: 0,
      jobsAt: 0,
      lastTitle: '',
      inFlight: false,
    };
    this.screen = 'run';
    this.message = '';
    this.render();
    this.pollWatch();
  }

  stopPoll() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async pollWatch() {
    if (this.screen !== 'run' || !this.watch) return;
    const watch = this.watch;
    if (watch.inFlight) return;

    watch.inFlight = true;
    try {
      const run = await this.gh.getRun(watch.runId);
      if (this.watch !== watch || this.screen !== 'run') return;

      watch.run = run;
      watch.error = null;
      watch.tick += 1;

      const shouldRefreshJobs =
        watch.jobs.length === 0 ||
        Date.now() - watch.jobsAt > 20000 ||
        run.status === 'completed';

      if (shouldRefreshJobs) {
        try {
          watch.jobs = await this.gh.listJobs(watch.runId);
          watch.jobsAt = Date.now();
        } catch {
          // Keep the last known jobs; the run status is still useful.
        }
      }

      this.updatePaneTitle(run);
      this.render();

      if (run.status === 'completed') {
        watch.finished = true;
        this.notifyCompletion(run);
        return;
      }

      const delay = watch.tick <= 12 ? 5000 : watch.tick <= 60 ? 10000 : 30000;
      if (this.watch === watch && this.screen === 'run') {
        this.pollTimer = setTimeout(() => this.pollWatch(), delay);
      }
    } catch (error) {
      if (this.watch !== watch || this.screen !== 'run') return;
      watch.error = error;
      this.render();

      const fatal =
        error instanceof GhError && [401, 403, 404].includes(error.status);
      if (!fatal && this.watch === watch && this.screen === 'run') {
        const delay = watch.tick < 10 ? 10000 : 30000;
        this.pollTimer = setTimeout(() => this.pollWatch(), delay);
      }
    } finally {
      watch.inFlight = false;
    }
  }

  updatePaneTitle(run) {
    const paneId = process.env.HERDR_PANE_ID;
    const herdr = process.env.HERDR_BIN_PATH;
    if (!paneId || !herdr) return;

    const label =
      run.status === 'completed'
        ? `CI: ${run.conclusion || 'completed'}`
        : `CI: ${String(run.status || 'running').replace(/_/g, ' ')}`;

    if (label === this.watch?.lastTitle) return;
    this.watch.lastTitle = label;
    execFile(herdr, ['pane', 'rename', paneId, label], { windowsHide: true }, () => {});
  }

  notifyCompletion(run) {
    const watch = this.watch;
    if (!watch || watch.notified) return;
    watch.notified = true;

    const herdr = process.env.HERDR_BIN_PATH;
    if (!herdr) return;

    const duration = fmt.fmtDuration(
      fmt.durationBetween(run.run_started_at || run.created_at, run.updated_at),
    );
    const conclusion = run.conclusion || 'finished';
    const title = `CI ${conclusion}: ${this.workflowTitle || run.name || 'workflow'}`;
    const body = `#${run.run_number ?? '?'} · ${run.head_branch || this.ref}${
      duration ? ` · ${duration}` : ''
    }`;
    const sound =
      conclusion === 'success'
        ? 'done'
        : ['neutral', 'skipped', 'stale'].includes(conclusion)
          ? 'none'
          : 'request';

    execFile(
      herdr,
      ['notification', 'show', title, '--body', body, '--sound', sound],
      { windowsHide: true },
      () => {},
    );
  }

  setPaneTitle(title) {
    const paneId = process.env.HERDR_PANE_ID;
    const herdr = process.env.HERDR_BIN_PATH;
    if (!paneId || !herdr) return;
    if (this.watch) this.watch.lastTitle = title;
    execFile(herdr, ['pane', 'rename', paneId, title], { windowsHide: true }, () => {});
  }

  filteredWorkflows() {
    const query = this.wfFilter.trim().toLowerCase();
    if (!query) return this.workflows;
    return this.workflows.filter((workflow) =>
      `${workflow.name} ${workflow.path}`.toLowerCase().includes(query),
    );
  }

  filteredRefs() {
    const query = this.refFilter.trim().toLowerCase();
    if (!query) return this.refs;
    return this.refs.filter((ref) =>
      `${ref.name} ${ref.type}`.toLowerCase().includes(query),
    );
  }

  windowList(items, index, maxRows, topKey) {
    const total = items.length;
    if (total === 0) {
      this[topKey] = 0;
      return { items: [], top: 0, selected: 0 };
    }

    const selected = Math.max(0, Math.min(index, total - 1));
    const rows = Math.max(1, maxRows);
    let top = Math.max(0, Math.min(this[topKey] || 0, Math.max(0, total - rows)));
    if (selected < top) top = selected;
    if (selected >= top + rows) top = selected - rows + 1;
    this[topKey] = top;

    return { items: items.slice(top, top + rows), top, selected };
  }

  moveList(delta, length, filterMode, indexKey, topKey) {
    if (filterMode) return;
    const next = Math.max(0, Math.min(length - 1, this[indexKey] + delta));
    this[indexKey] = next;
    this[topKey] = Math.min(this[topKey] || 0, next);
  }

  moveField(delta) {
    const total = this.inputs.length + 1;
    this.fieldIndex = Math.max(0, Math.min(total - 1, this.fieldIndex + delta));
    this.message = '';
  }

  cycleField(field, delta) {
    if (field.type === 'boolean') {
      field.value = field.value === 'true' ? 'false' : 'true';
      return;
    }
    if (field.type === 'choice' && field.options.length > 0) {
      const current = field.options.indexOf(field.value);
      const next =
        (current + delta + field.options.length) % field.options.length;
      field.value = field.options[next];
    }
  }

  startEditing(field) {
    field.editOriginal = field.value;
    field.editValue = field.value;
    this.editing = true;
    this.message = '';
  }

  commitEditing(field) {
    field.value = field.editValue;
    this.editing = false;
  }

  onKey(event) {
    if (event.type === 'quit') {
      this.quit();
      return;
    }
    if (event.type === 'ctrl' && event.name === 'l') {
      this.render();
      return;
    }
    if (
      event.type === 'ctrl' &&
      event.name === 'd' &&
      (this.screen === 'inputs' || this.screen === 'confirm')
    ) {
      if (this.screen === 'inputs') {
        if (this.editing) {
          const field = this.inputs[this.fieldIndex];
          if (field) this.commitEditing(field);
        }
        this.validateAndConfirm();
      } else {
        this.dispatch();
      }
      return;
    }

    switch (this.screen) {
      case 'loading':
        if (event.type === 'char' && event.ch === 'q') this.quit();
        return;
      case 'workflows':
        this.keyWorkflows(event);
        return;
      case 'refs':
        this.keyRefs(event);
        return;
      case 'inputs':
        this.keyInputs(event);
        return;
      case 'confirm':
        this.keyConfirm(event);
        return;
      case 'run':
        this.keyRun(event);
        return;
      case 'error':
        this.keyError(event);
        return;
      default:
        return;
    }
  }

  keyWorkflows(event) {
    const items = this.filteredWorkflows();

    if (event.type === 'char' && event.ch === '/') {
      this.wfFilterMode = true;
      this.render();
      return;
    }

    if (this.wfFilterMode) {
      if (event.type === 'char') {
        this.wfFilter += event.ch;
        this.wfIndex = 0;
        this.wfTop = 0;
        this.render();
        return;
      }
      if (event.type === 'backspace') {
        this.wfFilter = this.wfFilter.slice(0, -1);
        this.wfIndex = 0;
        this.wfTop = 0;
        this.render();
        return;
      }
      if (event.type === 'enter' || event.type === 'escape') {
        this.wfFilterMode = false;
        this.render();
        return;
      }
    }

    if (event.type === 'up') {
      this.wfIndex = Math.max(0, this.wfIndex - 1);
      this.render();
      return;
    }
    if (event.type === 'down') {
      this.wfIndex = Math.min(items.length - 1, this.wfIndex + 1);
      this.render();
      return;
    }
    if (event.type === 'pageup') {
      this.wfIndex = Math.max(0, this.wfIndex - 10);
      this.render();
      return;
    }
    if (event.type === 'pagedown') {
      this.wfIndex = Math.min(items.length - 1, this.wfIndex + 10);
      this.render();
      return;
    }
    if (event.type === 'home') {
      this.wfIndex = 0;
      this.render();
      return;
    }
    if (event.type === 'end') {
      this.wfIndex = Math.max(0, items.length - 1);
      this.render();
      return;
    }
    if (event.type === 'enter') {
      this.chooseWorkflow();
      return;
    }
    if (event.type === 'escape') {
      if (this.wfFilter) {
        this.wfFilter = '';
        this.wfIndex = 0;
        this.wfTop = 0;
        this.render();
      }
      return;
    }
    if (event.type === 'char' && event.ch === 'q') {
      this.quit();
      return;
    }
    if (event.type === 'char' && event.ch === 'r') {
      this.loadWorkflows();
    }
  }

  keyRefs(event) {
    const items = this.filteredRefs();

    if (event.type === 'char' && event.ch === '/') {
      this.refFilterMode = true;
      this.render();
      return;
    }

    if (this.refFilterMode) {
      if (event.type === 'char') {
        this.refFilter += event.ch;
        this.refIndex = 0;
        this.refTop = 0;
        this.render();
        return;
      }
      if (event.type === 'backspace') {
        this.refFilter = this.refFilter.slice(0, -1);
        this.refIndex = 0;
        this.refTop = 0;
        this.render();
        return;
      }
      if (event.type === 'enter' || event.type === 'escape') {
        this.refFilterMode = false;
        this.render();
        return;
      }
    }

    if (event.type === 'up') {
      this.refIndex = Math.max(0, this.refIndex - 1);
      this.render();
      return;
    }
    if (event.type === 'down') {
      this.refIndex = Math.min(items.length - 1, this.refIndex + 1);
      this.render();
      return;
    }
    if (event.type === 'pageup') {
      this.refIndex = Math.max(0, this.refIndex - 10);
      this.render();
      return;
    }
    if (event.type === 'pagedown') {
      this.refIndex = Math.min(items.length - 1, this.refIndex + 10);
      this.render();
      return;
    }
    if (event.type === 'home') {
      this.refIndex = 0;
      this.render();
      return;
    }
    if (event.type === 'end') {
      this.refIndex = Math.max(0, items.length - 1);
      this.render();
      return;
    }
    if (event.type === 'enter') {
      this.chooseRef();
      return;
    }
    if (event.type === 'escape' || (event.type === 'char' && event.ch === 'b')) {
      if (this.refFilter) {
        this.refFilter = '';
        this.refIndex = 0;
        this.refTop = 0;
        this.render();
        return;
      }
      this.screen = 'workflows';
      this.message = '';
      this.render();
      return;
    }
    if (event.type === 'char' && event.ch === 'q') {
      this.quit();
    }
  }

  keyInputs(event) {
    const total = this.inputs.length + 1;

    if (this.editing) {
      const field = this.inputs[this.fieldIndex];
      if (!field) {
        this.editing = false;
        return;
      }
      if (event.type === 'char') {
        field.editValue += event.ch;
        this.render();
        return;
      }
      if (event.type === 'backspace') {
        field.editValue = field.editValue.slice(0, -1);
        this.render();
        return;
      }
      if (event.type === 'enter') {
        this.commitEditing(field);
        this.render();
        return;
      }
      if (event.type === 'escape') {
        field.value = field.editOriginal;
        this.editing = false;
        this.render();
        return;
      }
      if (event.type === 'tab' || event.type === 'backtab') {
        this.commitEditing(field);
        this.moveField(event.type === 'tab' ? 1 : -1);
        this.render();
      }
      return;
    }

    if (event.type === 'up') {
      this.moveField(-1);
      this.render();
      return;
    }
    if (event.type === 'down') {
      this.moveField(1);
      this.render();
      return;
    }
    if (event.type === 'tab') {
      this.moveField(1);
      this.render();
      return;
    }
    if (event.type === 'backtab') {
      this.moveField(-1);
      this.render();
      return;
    }
    if (event.type === 'escape' || (event.type === 'char' && event.ch === 'b')) {
      this.editing = false;
      this.screen = 'refs';
      this.message = '';
      this.render();
      return;
    }
    if (event.type === 'char' && event.ch === 'q') {
      this.quit();
      return;
    }

    if (this.fieldIndex >= this.inputs.length) {
      if (event.type === 'enter') this.validateAndConfirm();
      return;
    }

    const field = this.inputs[this.fieldIndex];

    if (event.type === 'left' || event.type === 'right') {
      this.cycleField(field, event.type === 'left' ? -1 : 1);
      this.render();
      return;
    }
    if (event.type === 'char' && event.ch === ' ') {
      if (field.type === 'boolean') {
        this.cycleField(field, 1);
        this.render();
      }
      return;
    }
    if (event.type === 'enter') {
      if (field.type === 'boolean') {
        this.cycleField(field, 1);
        this.render();
        return;
      }
      if (field.type === 'choice') {
        this.cycleField(field, 1);
        this.render();
        return;
      }
      this.startEditing(field);
      this.render();
    }
  }

  keyConfirm(event) {
    if (event.type === 'enter') {
      this.dispatch();
      return;
    }
    if (event.type === 'escape' || (event.type === 'char' && event.ch === 'b')) {
      this.screen = this.inputs.length > 0 ? 'inputs' : 'refs';
      this.message = '';
      this.render();
      return;
    }
    if (event.type === 'char' && event.ch === 'q') this.quit();
  }

  keyRun(event) {
    const watch = this.watch;
    if (!watch) return;

    if (event.type === 'enter') {
      if (watch.runId) {
        this.gh.openRunWeb(watch.runId).catch((error) => {
          this.message = error.message;
          this.render();
        });
      }
      return;
    }

    if (event.type === 'up') {
      watch.scroll = Math.max(0, watch.scroll - 1);
      this.render();
      return;
    }
    if (event.type === 'down') {
      watch.scroll = Math.min(watch.scrollMax, watch.scroll + 1);
      this.render();
      return;
    }
    if (event.type === 'pageup') {
      watch.scroll = Math.max(0, watch.scroll - 10);
      this.render();
      return;
    }
    if (event.type === 'pagedown') {
      watch.scroll = Math.min(watch.scrollMax, watch.scroll + 10);
      this.render();
      return;
    }
    if (event.type === 'home') {
      watch.scroll = 0;
      this.render();
      return;
    }
    if (event.type === 'end') {
      watch.scroll = watch.scrollMax;
      this.render();
      return;
    }

    if (event.type === 'char' && event.ch === 'o') {
      if (watch.runId) {
        this.gh.openRunWeb(watch.runId).catch((error) => {
          this.message = error.message;
          this.render();
        });
      }
      return;
    }
    if (event.type === 'char' && event.ch === 'c') {
      if (watch.run?.status !== 'completed') {
        this.message = 'Cancellation requested...';
        this.render();
        this.gh.cancelRun(watch.runId).catch((error) => {
          this.message = error.message;
          this.render();
        });
      }
      return;
    }
    if (event.type === 'char' && event.ch === 'R') {
      this.message = 'Rerun requested...';
      this.render();
      this.gh
        .rerunRun(watch.runId)
        .then(() => {
          watch.finished = false;
          watch.notified = false;
          watch.tick = 0;
          this.pollWatch();
        })
        .catch((error) => {
          this.message = error.message;
          this.render();
        });
      return;
    }
    if (event.type === 'char' && event.ch === 'r') {
      this.pollWatch();
      return;
    }
    if (event.type === 'escape') {
      if (watch.run?.status === 'completed') {
        this.leaveRun();
      } else {
        this.message = 'Run still in progress: b starts another workflow, q closes.';
        this.render();
      }
      return;
    }
    if (event.type === 'char' && event.ch === 'b') {
      this.leaveRun();
      return;
    }
    if (event.type === 'escape' || (event.type === 'char' && event.ch === 'q')) {
      this.quit();
    }
  }

  leaveRun() {
    this.stopPoll();
    this.watch = null;
    this.screen = 'workflows';
    this.message = '';
    this.setPaneTitle('GitHub Actions');
    this.render();
  }

  keyError(event) {
    if (event.type === 'char' && event.ch === 'r' && this.retry) {
      const retry = this.retry;
      this.retry = null;
      try {
        const pending = retry();
        if (pending && typeof pending.then === 'function') {
          pending.catch((error) => this.fail(error, { retry }));
        }
      } catch (error) {
        this.fail(error, { retry });
      }
      return;
    }
    if (
      (event.type === 'escape' || (event.type === 'char' && event.ch === 'b')) &&
      this.errorBack
    ) {
      const back = this.errorBack;
      this.errorBack = null;
      back();
      return;
    }
    if (event.type === 'char' && event.ch === 'q') this.quit();
  }

  quit() {
    this.stopPoll();
    if (this.tui) this.tui.stop();
    process.exit(0);
  }

  fail(error, { retry = null, back = null } = {}) {
    this.stopPoll();

    let title = 'Something went wrong';
    if (error instanceof GhError) title = 'GitHub request failed';
    else if (error instanceof WorkflowInputError) title = 'Invalid workflow';
    else if (error instanceof UserError) title = 'Cannot continue';

    let details = '';
    if (error instanceof GhError) {
      const hint = ghErrorHint(error);
      details = [hint, error.method && error.path ? `${error.method} ${error.path}` : '']
        .filter(Boolean)
        .join('\n');
    } else if (error instanceof UserError) {
      details = error.details || '';
    }

    this.error = {
      title,
      message: error?.message || String(error),
      details,
    };
    this.retry = retry;
    this.errorBack = back;
    this.screen = 'error';
    this.message = '';
    this.render();
  }

  errorText(error) {
    const message = error?.message || String(error);
    const details =
      error instanceof UserError
        ? error.details
        : error instanceof GhError
          ? ghErrorHint(error)
          : '';
    return details ? `${message}\n${details}` : message;
  }
  headerLines(width) {
    const lines = [];
    const brand = `${ui.icon('brand')} ${fmt.style('brand', 'CI Dash')}`;
    const repoText = this.repo
      ? this.repo.host === 'github.com'
        ? this.repo.slug
        : `${this.repo.host}/${this.repo.slug}`
      : 'no repository';
    const branch =
      this.repoInfo?.branch || (this.repoInfo?.detached ? 'detached HEAD' : '');

    const brandWidth = fmt.visibleLength(brand);
    let right = this.repo
      ? fmt.style('strong', repoText)
      : fmt.style('muted', repoText);
    const room = Math.max(0, width - brandWidth - 1);
    if (fmt.visibleLength(right) > room) {
      right = fmt.ellipsizeAnsi(right, room);
    }
    lines.push(fmt.spread(brand, right, width));

    if (this.repo) {
      const pills = [];
      if (branch) {
        pills.push(`${ui.icon('branch')} ${fmt.style('info', branch)}`);
      }
      if (this.repoData?.private) {
        pills.push(`${ui.icon('lock')} ${fmt.style('warning', 'private')}`);
      }
      if (this.login) {
        pills.push(`${ui.icon('user')} ${fmt.style('muted', this.login)}`);
      }
      if (pills.length > 0) {
        lines.push(
          fmt.truncateAnsi(
            pills.join(fmt.style('border', `  ${ui.icon('sep')}  `)),
            width,
          ),
        );
      }
    }

    return lines;
  }

  stepNumber() {
    switch (this.screen) {
      case 'workflows':
        return 1;
      case 'refs':
        return 2;
      case 'inputs':
        return 3;
      case 'confirm':
      case 'run':
        return 4;
      default:
        return 0;
    }
  }

  stepLines(width) {
    if (!this.view || this.view.contentWidth < 52 || this.view.rows < 16) return [];
    const step = this.stepNumber();
    if (step === 0) return [];
    return [ui.stepper(['Workflow', 'Ref', 'Inputs', 'Run'], step, width)];
  }

  workflowStateLabel(state) {
    switch (state) {
      case 'disabled_manually':
        return 'off';
      case 'disabled_inactivity':
        return 'idle';
      case 'disabled_fork':
        return 'fork';
      default:
        return state;
    }
  }

  footerPairs() {
    switch (this.screen) {
      case 'workflows':
        return [
          [ui.icon('updown'), 'move'],
          ['Enter', 'select'],
          ['/', 'filter'],
          ['r', 'reload'],
          ['q', 'quit'],
        ];
      case 'refs':
        return [
          [ui.icon('updown'), 'move'],
          ['Enter', 'select'],
          ['/', 'filter'],
          ['Esc', 'back'],
          ['q', 'quit'],
        ];
      case 'inputs':
        return this.editing
          ? [
              ['Enter', 'commit'],
              ['Esc', 'cancel'],
              ['Tab', 'next'],
            ]
          : [
              [ui.icon('updown'), 'field'],
              [ui.icon('leftright'), 'change'],
              ['Enter', 'edit'],
              ['Ctrl+D', 'run'],
              ['Esc', 'back'],
            ];
      case 'confirm':
        return [
          ['Enter', 'dispatch'],
          ['Esc', 'back'],
        ];
      case 'run': {
        const pairs = [
          [ui.icon('updown'), 'scroll'],
          ['Enter', 'open'],
          ['c', 'cancel'],
          ['R', 'rerun'],
          ['r', 'refresh'],
          ['b', 'new run'],
        ];
        if (this.watch?.run?.status === 'completed') pairs.push(['Esc', 'back']);
        pairs.push(['q', 'close']);
        return pairs;
      }
      case 'error':
        return [
          ['r', 'retry'],
          ['b', 'back'],
          ['q', 'quit'],
        ];
      default:
        return [];
    }
  }

  footerLines(width) {
    return ui.hintsLines(this.footerPairs(), width);
  }

  messageLines(width) {
    if (!this.message || this.screen === 'loading') return [];
    return fmt
      .wrapText(`${ui.icon('warn')} ${this.message}`, width)
      .map((line) => fmt.style('warning', line));
  }

  render() {
    if (!this.tui) return;

    const columns = this.tui.columns;
    const rows = this.tui.rows;
    const boxed = columns >= 46 && rows >= 9;
    // Keep very wide terminals readable by centering a bounded card.
    const maxFrame = 110;
    const frameWidth = Math.max(12, Math.min(columns - 2, maxFrame));
    const margin = Math.max(0, Math.floor((columns - frameWidth) / 2));
    const contentWidth = Math.max(8, frameWidth - (boxed ? 4 : 0));
    this.view = { columns, rows, boxed, margin, frameWidth, contentWidth };

    const header = this.headerLines(contentWidth);
    const steps = this.stepLines(contentWidth);
    const footer = this.footerLines(contentWidth);
    const message = this.messageLines(contentWidth);

    const boxLines = boxed ? 2 : 0;
    const fixed =
      header.length +
      (steps.length > 0 ? steps.length + 1 : 0) +
      1 +
      (message.length > 0 ? message.length + 1 : 0) +
      1 +
      footer.length;
    const available = Math.max(1, rows - boxLines - fixed);

    let body;
    try {
      body = this.screenBody(contentWidth, available);
    } catch (error) {
      body = [fmt.style('danger', error.message)];
    }

    const inner = [
      ...header,
      ...(steps.length > 0 ? ['', ...steps] : []),
      '',
      ...body.slice(0, available),
      ...(message.length > 0 ? ['', ...message] : []),
      '',
      ...footer,
    ];

    if (boxed) {
      const innerHeight = Math.max(0, rows - 2);
      while (inner.length < innerHeight) inner.push('');
      const framed = [ui.frameTop(contentWidth)];
      for (const line of inner.slice(0, innerHeight)) {
        framed.push(ui.frameRow(line, contentWidth));
      }
      framed.push(ui.frameBottom(contentWidth));
      this.tui.draw(framed.map((line) => `${' '.repeat(margin)}${line}`));
      return;
    }

    const marginText = ' '.repeat(Math.max(1, margin));
    this.tui.draw(
      inner.slice(0, rows).map((line) => `${marginText}${line}`),
    );
  }

  screenBody(width, height) {
    switch (this.screen) {
      case 'loading':
        return [
          fmt.style('accent', `${ui.icon('running')} Loading…`),
          '',
          ...fmt
            .wrapText(this.message || '', width)
            .map((line) => fmt.style('muted', line)),
        ];
      case 'workflows':
        return this.workflowsBody(width, height);
      case 'refs':
        return this.refsBody(width, height);
      case 'inputs':
        return this.inputsBody(width, height);
      case 'confirm':
        return this.confirmBody(width, height);
      case 'run':
        return this.runBody(width, height);
      case 'error':
        return this.errorBody(width, height);
      default:
        return [];
    }
  }

  workflowFilterLine(width) {
    if (this.wfFilterMode || this.wfFilter) {
      const cursor = this.wfFilterMode ? fmt.style('accent', '▏') : '';
      return fmt.truncateAnsi(
        `${fmt.style('muted', `${ui.icon('search')} filter`)}  ${fmt.style(
          'text',
          this.wfFilter,
        )}${cursor}`,
        width,
      );
    }
    return fmt.style('muted', `${ui.icon('search')} press / to filter`);
  }

  refFilterLine(width) {
    if (this.refFilterMode || this.refFilter) {
      const cursor = this.refFilterMode ? fmt.style('accent', '▏') : '';
      return fmt.truncateAnsi(
        `${fmt.style('muted', `${ui.icon('search')} filter`)}  ${fmt.style(
          'text',
          this.refFilter,
        )}${cursor}`,
        width,
      );
    }
    return fmt.style('muted', `${ui.icon('search')} press / to filter`);
  }

  workflowsBody(width, height) {
    const items = this.filteredWorkflows();
    const current = items[this.wfIndex];
    const detail = current ? 2 : 0;
    const listHeight = Math.max(1, height - 4 - detail);
    const window = this.windowList(items, this.wfIndex, listHeight, 'wfTop');
    const lines = [];

    lines.push(
      fmt.spread(
        `${ui.icon('workflow')} ${fmt.style('strong', 'Workflows')}`,
        fmt.style('muted', `${items.length}`),
        width,
      ),
    );
    lines.push(ui.rule(width));
    lines.push(this.workflowFilterLine(width));
    lines.push('');

    if (window.items.length === 0) {
      lines.push(
        fmt.style('warning', `${ui.icon('warn')} No matching workflows.`),
      );
      return lines;
    }

    for (let offset = 0; offset < window.items.length; offset += 1) {
      const index = window.top + offset;
      const workflow = window.items[offset];
      const selected = index === window.selected;
      const enabled = workflow.state === 'active';
      const glyph = enabled ? ui.icon('workflow') : ui.icon('workflowOff');
      const stateLabel = this.workflowStateLabel(workflow.state);
      const statePlain = enabled ? '' : `  [${stateLabel}]`;

      const showPath = width >= 52;
      if (selected) {
        const plain = fmt.spread(
          `${ui.icon('pointer')} ${glyph} ${workflow.name}${statePlain}`,
          showPath ? workflow.path || '' : '',
          width,
        );
        lines.push(ui.row(plain, width, true));
      } else {
        const name = `${fmt.style('text', workflow.name)}${
          enabled ? '' : `  ${fmt.style('warning', `[${stateLabel}]`)}`
        }`;
        lines.push(
          fmt.spread(
            `  ${fmt.style('muted', glyph)} ${name}`,
            showPath ? fmt.style('muted', workflow.path || '') : '',
            width,
          ),
        );
      }
    }

    if (current) {
      lines.push('');
      const id = current.id != null ? `#${current.id}` : '';
      const url = current.html_url || '';
      const link = url
        ? fmt.hyperlink(url, fmt.style('info', `${ui.icon('link')} Open workflow`))
        : '';
      lines.push(
        fmt.truncateAnsi(
          `${fmt.style('muted', id)}${
            id && link ? fmt.style('border', '  ·  ') : ''
          }${link}`,
          width,
        ),
      );
    }

    return lines;
  }

  refsBody(width, height) {
    const items = this.filteredRefs();
    const listHeight = Math.max(1, height - 4);
    const window = this.windowList(items, this.refIndex, listHeight, 'refTop');
    const defaultBranch = this.repoData?.default_branch || '';
    const currentBranch = this.repoInfo?.branch || '';
    const lines = [];

    lines.push(
      fmt.spread(
        `${ui.icon('branch')} ${fmt.style('strong', 'Use workflow from')}`,
        fmt.style('muted', `${items.length}`),
        width,
      ),
    );
    lines.push(
      fmt.truncateAnsi(fmt.style('muted', this.workflow?.path || ''), width),
    );
    lines.push(this.refFilterLine(width));
    lines.push('');

    if (window.items.length === 0) {
      lines.push(fmt.style('warning', `${ui.icon('warn')} No matching refs.`));
      return lines;
    }

    for (let offset = 0; offset < window.items.length; offset += 1) {
      const index = window.top + offset;
      const ref = window.items[offset];
      const selected = index === window.selected;
      const glyph = ref.type === 'tag' ? ui.icon('tag') : ui.icon('branch');
      const badges = [ref.type];
      if (ref.name === defaultBranch) badges.push('default');
      if (ref.name === currentBranch) badges.push('current');

      const showBadges = width >= 42;
      if (selected) {
        const plain = fmt.spread(
          `${ui.icon('pointer')} ${glyph} ${ref.name}`,
          showBadges ? badges.join(' · ') : '',
          width,
        );
        lines.push(ui.row(plain, width, true));
      } else {
        const badgeText = badges
          .map((badge) => {
            if (badge === 'default') return fmt.style('success', badge);
            if (badge === 'current') return fmt.style('accent', badge);
            return fmt.style('muted', badge);
          })
          .join(fmt.style('border', ' · '));
        lines.push(
          fmt.spread(
            `  ${fmt.style('muted', glyph)} ${fmt.style('text', ref.name)}`,
            showBadges ? badgeText : '',
            width,
          ),
        );
      }
    }

    return lines;
  }

  inputsBody(width, height) {
    const field = this.inputs[this.fieldIndex];
    const total = this.inputs.length + 1;
    const title = this.workflowTitle || this.workflow?.name || 'workflow';
    const lines = [];

    lines.push(fmt.truncateAnsi(fmt.style('strong', title), width));
    lines.push(
      fmt.truncateAnsi(
        `${fmt.style('muted', this.workflow?.path || '')}${
          this.ref
            ? `${fmt.style('border', '  ·  ')}${fmt.style('info', `on ${this.ref}`)}`
            : ''
        }`,
        width,
      ),
    );
    lines.push('');

    if (this.warnings.length > 0) {
      for (const warning of this.warnings) {
        for (const line of fmt.wrapText(`${ui.icon('warn')} ${warning}`, width)) {
          lines.push(fmt.style('warning', line));
        }
      }
      lines.push('');
    }

    if (!field) {
      lines.push(
        `${fmt.style('success', ui.icon('check'))} ${fmt.style(
          'strong',
          'Ready to run',
        )}`,
      );
      lines.push('');
      lines.push(
        fmt.spread(
          fmt.style('muted', 'Inputs'),
          fmt.style('text', `${this.inputs.length}`),
          width,
        ),
      );
      lines.push(
        fmt.spread(
          fmt.style('muted', 'Ref'),
          fmt.style('info', this.ref || '(default)'),
          width,
        ),
      );
      lines.push('');
      lines.push(fmt.style('accent', `${ui.icon('running')} Review and run`));
      return lines;
    }

    const position = Math.min(this.fieldIndex + 1, total);
    const dots =
      total <= 10
        ? Array.from({ length: total }, (_, index) =>
            index < position ? ui.icon('dot') : ui.icon('circle'),
          ).join(' ')
        : '';
    lines.push(
      fmt.spread(
        fmt.style('muted', `Field ${position}/${total}`),
        dots ? fmt.style('accent', dots) : '',
        width,
      ),
    );
    lines.push('');

    const required = field.required
      ? fmt.style('danger', '*')
      : fmt.style('muted', '·');
    lines.push(
      `${required} ${fmt.style('strong', field.name)} ${fmt.style(
        'muted',
        `(${field.type})`,
      )}`,
    );

    if (field.description) {
      for (const line of fmt.wrapText(field.description, Math.max(4, width - 2))) {
        lines.push(fmt.style('muted', `  ${line}`));
      }
    }
    lines.push('');

    if (this.editing) {
      lines.push(
        `  ${fmt.style('accent', ui.icon('pointer'))} ${field.editValue}${fmt.style(
          'accent',
          '▏',
        )}`,
      );
      return lines;
    }

    if (field.type === 'boolean') {
      lines.push(
        `  ${
          field.value === 'true'
            ? fmt.style('success', `${ui.icon('dot')} true`)
            : fmt.style('muted', `${ui.icon('circle')} false`)
        }`,
      );
      return lines;
    }

    if (field.type === 'choice') {
      const all =
        field.options.length > 0 ? field.options : [field.value || '(none)'];
      const limit = 8;
      let options = all;
      if (all.length > limit) {
        const index = Math.max(0, all.indexOf(field.value));
        const start = Math.max(0, Math.min(index - 3, all.length - limit));
        options = all.slice(start, start + limit);
      }
      for (const chip of ui.chips(options, field.value, Math.max(4, width - 2))) {
        lines.push(`  ${chip}`);
      }
      if (options.length < all.length) {
        lines.push(fmt.style('muted', `  +${all.length - options.length} more`));
      }
      return lines;
    }

    const display =
      field.value === ''
        ? fmt.style('muted', '(empty)')
        : fmt.style('text', field.value);
    lines.push(`  ${fmt.style('accent', ui.icon('pointer'))} ${display}`);
    if (field.type === 'number') {
      lines.push(fmt.style('muted', '  must be a number'));
    }
    if (field.type === 'environment') {
      lines.push(fmt.style('muted', '  GitHub environment name'));
    }
    return lines;
  }

  confirmBody(width, height) {
    const lines = [];
    lines.push(
      `${fmt.style('success', ui.icon('check'))} ${fmt.style(
        'strong',
        'Review and dispatch',
      )}`,
    );
    lines.push('');
    lines.push(
      fmt.truncateAnsi(
        fmt.style('strong', this.workflowTitle || this.workflow?.name || 'workflow'),
        width,
      ),
    );
    lines.push(
      fmt.truncateAnsi(fmt.style('muted', this.workflow?.path || ''), width),
    );
    lines.push('');
    lines.push(
      fmt.spread(
        fmt.style('muted', 'Ref'),
        fmt.style('info', this.ref || '(default)'),
        width,
      ),
    );
    if (this.repo) {
      lines.push(
        fmt.spread(
          fmt.style('muted', 'Repository'),
          fmt.style('text', `${this.repo.host}/${this.repo.slug}`),
          width,
        ),
      );
    }
    lines.push('');
    lines.push(
      fmt.spread(
        fmt.style('strong', 'Inputs'),
        fmt.style('muted', `${this.inputs.length}`),
        width,
      ),
    );
    lines.push(ui.rule(width));

    if (this.inputs.length === 0) {
      lines.push(fmt.style('muted', '  (none)'));
    } else {
      const shown = this.inputs.slice(0, 12);
      for (const field of shown) {
        const value =
          field.value === ''
            ? fmt.style('muted', '(empty)')
            : fmt.style('text', fmt.sanitizeText(field.value));
        lines.push(
          fmt.spread(`  ${fmt.style('muted', field.name)}`, value, width),
        );
      }
      if (shown.length < this.inputs.length) {
        lines.push(
          fmt.style('muted', `  +${this.inputs.length - shown.length} more inputs`),
        );
      }
    }

    if (this.warnings.length > 0) {
      lines.push('');
      for (const warning of this.warnings) {
        for (const line of fmt.wrapText(`${ui.icon('warn')} ${warning}`, width)) {
          lines.push(fmt.style('warning', line));
        }
      }
    }

    lines.push('');
    lines.push(
      fmt.style('accent', `${ui.icon('running')} Press Enter to dispatch`),
    );

    if (this.workflow && this.gh) {
      const url = this.gh.workflowHtmlUrl(this.workflow);
      lines.push(
        fmt.truncateAnsi(
          fmt.hyperlink(url, fmt.style('info', `[ ${ui.icon('link')} View workflow ]`)),
          width,
        ),
      );
    }

    return lines;
  }

  runBody(width, height) {
    const watch = this.watch;
    if (!watch) return [fmt.style('muted', 'No run selected.')];

    const run = watch.run;
    const header = [];

    if (!run) {
      header.push(fmt.style('accent', `${ui.icon('running')} Loading run…`));
    } else {
      header.push(
        fmt.spread(
          `${ui.icon('workflow')} ${fmt.style(
            'strong',
            `#${run.run_number ?? '?'} ${run.name || this.workflowTitle || 'workflow'}`,
          )}`,
          fmt.style('muted', run.event || ''),
          width,
        ),
      );

      const statusColor = fmt.statusColor(run.status, run.conclusion);
      const statusText = `${fmt.style(
        statusColor,
        ui.statusIcon(run.status, run.conclusion),
      )} ${fmt.style(statusColor, fmt.statusLabel(run.status, run.conclusion))}`;
      const meta = [];
      if (run.head_branch) meta.push(run.head_branch);
      if (run.head_sha) meta.push(fmt.shortSha(run.head_sha));
      const duration = fmt.fmtDuration(
        fmt.durationBetween(
          run.run_started_at || run.created_at,
          run.status === 'completed' ? run.updated_at : null,
        ),
      );
      if (duration) meta.push(duration);
      if (run.run_attempt > 1) meta.push(`attempt ${run.run_attempt}`);
      header.push(
        fmt.truncateAnsi(
          `${statusText}${
            meta.length > 0
              ? `  ${meta.map((bit) => fmt.style('muted', bit)).join(fmt.style('border', ' · '))}`
              : ''
          }`,
          width,
        ),
      );
      if (run.html_url) {
        const button = fmt.hyperlink(
          run.html_url,
          fmt.style('accent', `[ ${ui.icon('link')} Open run ]`),
        );
        header.push(
          fmt.truncateAnsi(
            `${button}  ${fmt.style('muted', `Enter ${ui.icon('sep')} o`)}`,
            width,
          ),
        );
      }
    }

    if (watch.error) {
      header.push(
        fmt.style('warning', `${ui.icon('warn')} ${watch.error.message}`),
      );
    }

    header.push('');
    header.push(
      fmt.spread(
        fmt.style('strong', 'Jobs'),
        fmt.style('muted', `${watch.jobs.length}`),
        width,
      ),
    );
    header.push(ui.rule(width));

    const content = [];
    if (watch.jobs.length === 0) {
      content.push(fmt.style('muted', 'Waiting for jobs…'));
    }

    for (const job of watch.jobs) {
      const color = fmt.statusColor(job.status, job.conclusion);
      const icon = ui.statusIcon(job.status, job.conclusion);
      const duration = job.started_at
        ? fmt.fmtDuration(
            fmt.durationBetween(
              job.started_at,
              job.status === 'completed' ? job.completed_at : null,
            ),
          )
        : '';
      content.push(
        fmt.spread(
          `${fmt.style(color, icon)} ${fmt.style('text', job.name)}`,
          duration ? fmt.style('muted', duration) : '',
          width,
        ),
      );

      const steps = job.steps || [];
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        const last = index === steps.length - 1;
        const stepColor = fmt.statusColor(step.status, step.conclusion);
        const stepDuration = step.started_at
          ? fmt.fmtDuration(
              fmt.durationBetween(
                step.started_at,
                step.status === 'completed' ? step.completed_at : null,
              ),
            )
          : '';
        content.push(
          fmt.spread(
            `${fmt.style('border', last ? ui.icon('treeLast') : ui.icon('tree'))} ${fmt.style(
              stepColor,
              ui.statusIcon(step.status, step.conclusion),
            )} ${fmt.style('muted', step.name)}`,
            stepDuration ? fmt.style('muted', stepDuration) : '',
            width,
          ),
        );
      }
    }

    if (watch.finished && run) {
      content.push('');
      content.push(
        fmt.style(
          fmt.statusColor('completed', run.conclusion),
          `${ui.statusIcon('completed', run.conclusion)} Final: ${
            run.conclusion || 'completed'
          }`,
        ),
      );
    }

    const visibleRows = Math.max(3, height - header.length);
    watch.scrollMax = Math.max(0, content.length - visibleRows);
    watch.scroll = Math.max(0, Math.min(watch.scroll, watch.scrollMax));
    const visible = content.slice(watch.scroll, watch.scroll + visibleRows);

    return [...header, ...visible];
  }

  errorBody(width, height) {
    if (!this.error) return [];
    const lines = [
      `${fmt.style('danger', ui.icon('cross'))} ${fmt.style(
        'strong',
        this.error.title,
      )}`,
      '',
    ];

    for (const line of fmt.wrapText(this.error.message, width)) {
      lines.push(fmt.style('text', line));
    }

    if (this.error.details) {
      lines.push('');
      for (const line of fmt.wrapText(this.error.details, width)) {
        lines.push(fmt.style('muted', line));
      }
    }

    return lines;
  }
}

module.exports = {
  App,
  UserError,
};
