'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function runGit(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

function normalizeRepo(host, owner, name) {
  return {
    host,
    owner,
    name,
    slug: `${owner}/${name}`,
    url: `https://${host}/${owner}/${name}`,
  };
}

function parseRemoteUrl(input) {
  const value = String(input || '').trim();
  if (!value) return null;

  let host = '';
  let rawPath = '';

  if (!value.includes('://')) {
    // scp-like: git@github.com:owner/repo.git
    const match = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);
    if (!match) return null;
    host = match[1];
    rawPath = match[2];
  } else {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (!['http:', 'https:', 'ssh:', 'git:', 'git+ssh:'].includes(parsed.protocol)) {
      return null;
    }
    host = parsed.hostname;
    rawPath = parsed.pathname;
  }

  rawPath = rawPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');

  const parts = rawPath.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  if (!host || (!host.includes('.') && host !== 'localhost')) return null;

  const [owner, name] = parts;
  if (!owner || !name) return null;
  return normalizeRepo(host, owner, name);
}

function parseRepoSpec(spec) {
  const value = String(spec || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  if (!value) return null;

  const parts = value.split('/').filter(Boolean);
  if (parts.length === 2) return normalizeRepo('github.com', parts[0], parts[1]);
  if (parts.length === 3) return normalizeRepo(parts[0], parts[1], parts[2]);
  return null;
}

async function resolveRepo({ cwd, override } = {}) {
  const start = path.resolve(cwd || process.cwd());
  let root = start;
  let isGit = true;

  try {
    root = await runGit(start, ['rev-parse', '--show-toplevel']);
  } catch {
    isGit = false;
  }

  const remotes = [];
  let remote = null;

  if (isGit) {
    try {
      const listing = await runGit(root, ['remote']);
      for (const name of listing.split(/\r?\n/).map((line) => line.trim())) {
        if (name) remotes.push(name);
      }
    } catch {
      // A repository without remotes is still usable with an explicit override.
    }

    if (remotes.length > 0) {
      const name = remotes.includes('origin') ? 'origin' : remotes[0];
      try {
        const url = await runGit(root, ['remote', 'get-url', name]);
        remote = { name, url, parsed: parseRemoteUrl(url) };
      } catch {
        remote = { name, url: '', parsed: null };
      }
    }
  }

  let branch = '';
  let sha = '';
  if (isGit) {
    try {
      branch = await runGit(root, ['branch', '--show-current']);
    } catch {
      branch = '';
    }
    try {
      sha = await runGit(root, ['rev-parse', '--short', 'HEAD']);
    } catch {
      sha = '';
    }
  }

  const repo = override ? parseRepoSpec(override) : remote?.parsed || null;

  return {
    cwd: start,
    root,
    isGit,
    remotes,
    remote,
    repo,
    branch,
    sha,
    detached: isGit && !branch,
  };
}

module.exports = {
  runGit,
  parseRemoteUrl,
  parseRepoSpec,
  resolveRepo,
};
