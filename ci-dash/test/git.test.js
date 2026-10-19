'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const {
  parseRemoteUrl,
  parseRepoSpec,
  resolveRepo,
} = require('../src/git');

const execFileAsync = promisify(execFile);

test('parses HTTPS remotes', () => {
  assert.deepEqual(parseRemoteUrl('https://github.com/herdrdev/herdr.git'), {
    host: 'github.com',
    owner: 'herdrdev',
    name: 'herdr',
    slug: 'herdrdev/herdr',
    url: 'https://github.com/herdrdev/herdr',
  });
});

test('parses scp-like SSH remotes', () => {
  const repo = parseRemoteUrl('git@github.com:dougcunha/ci-dash.git');
  assert.equal(repo.host, 'github.com');
  assert.equal(repo.slug, 'dougcunha/ci-dash');
});

test('parses ssh:// remotes', () => {
  const repo = parseRemoteUrl('ssh://git@github.example.com/team/project.git');
  assert.equal(repo.host, 'github.example.com');
  assert.equal(repo.slug, 'team/project');
});

test('parses git:// remotes', () => {
  const repo = parseRemoteUrl('git://github.com/team/project');
  assert.equal(repo.slug, 'team/project');
});

test('rejects unsupported or malformed remotes', () => {
  assert.equal(parseRemoteUrl(''), null);
  assert.equal(parseRemoteUrl('not-a-remote'), null);
  assert.equal(parseRemoteUrl('https://github.com/owner'), null);
  assert.equal(parseRemoteUrl('https://github.com/owner/repo/extra'), null);
  assert.equal(parseRemoteUrl('ftp://github.com/owner/repo'), null);
});

test('parses owner/repo overrides', () => {
  const repo = parseRepoSpec('herdrdev/herdr');
  assert.equal(repo.host, 'github.com');
  assert.equal(repo.slug, 'herdrdev/herdr');
});

test('parses host/owner/repo overrides', () => {
  const repo = parseRepoSpec('github.example.com/team/project');
  assert.equal(repo.host, 'github.example.com');
  assert.equal(repo.slug, 'team/project');
});

test('normalizes URL-shaped overrides', () => {
  const repo = parseRepoSpec('https://github.com/herdrdev/herdr.git');
  assert.equal(repo.slug, 'herdrdev/herdr');
});

test('rejects malformed overrides', () => {
  assert.equal(parseRepoSpec(''), null);
  assert.equal(parseRepoSpec('owner'), null);
  assert.equal(parseRepoSpec('a/b/c/d'), null);
});

test('resolves the repository from a Git remote', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-dash-git-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await execFileAsync('git', ['-C', directory, 'init'], { windowsHide: true });
  await execFileAsync(
    'git',
    ['-C', directory, 'remote', 'add', 'origin', 'https://github.com/herdrdev/herdr.git'],
    { windowsHide: true },
  );

  const info = await resolveRepo({ cwd: directory });
  assert.equal(info.isGit, true);
  assert.equal(path.normalize(info.root), path.normalize(directory));
  assert.deepEqual(info.remotes, ['origin']);
  assert.equal(info.repo.slug, 'herdrdev/herdr');
});

test('uses the override when the directory has no remote', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-dash-plain-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const info = await resolveRepo({ cwd: directory, override: 'team/project' });
  assert.equal(info.isGit, false);
  assert.equal(info.repo.slug, 'team/project');
  assert.equal(info.remote, null);
});

test('prefers origin over other remotes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-dash-remotes-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await execFileAsync('git', ['-C', directory, 'init'], { windowsHide: true });
  await execFileAsync(
    'git',
    ['-C', directory, 'remote', 'add', 'upstream', 'https://github.com/other/fork.git'],
    { windowsHide: true },
  );
  await execFileAsync(
    'git',
    ['-C', directory, 'remote', 'add', 'origin', 'https://github.com/team/project.git'],
    { windowsHide: true },
  );

  const info = await resolveRepo({ cwd: directory });
  assert.equal(info.remote.name, 'origin');
  assert.equal(info.repo.slug, 'team/project');
});
