'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fmt = require('../src/format');

function withLinksEnabled(fn) {
  const term = process.env.TERM;
  const noLinks = process.env.CI_DASH_NO_LINKS;
  process.env.TERM = 'xterm-256color';
  delete process.env.CI_DASH_NO_LINKS;
  try {
    return fn();
  } finally {
    if (term === undefined) delete process.env.TERM;
    else process.env.TERM = term;
    if (noLinks === undefined) delete process.env.CI_DASH_NO_LINKS;
    else process.env.CI_DASH_NO_LINKS = noLinks;
  }
}

test('adds a hyperlink without counting the target in the layout', () => {
  withLinksEnabled(() => {
    const link = fmt.hyperlink(
      'https://github.com/o/r/actions/runs/1',
      'Open run',
    );
    assert.ok(link.includes('\x1b]8;;https://github.com/o/r/actions/runs/1\x1b\\'));
    assert.equal(fmt.stripAnsi(link), 'Open run');
    assert.equal(fmt.visibleLength(link), 'Open run'.length);
  });
});

test('closes the hyperlink when the label is truncated', () => {
  withLinksEnabled(() => {
    const link = fmt.hyperlink(
      'https://github.com/o/r/actions/runs/1',
      'Open run in browser',
    );
    const truncated = fmt.truncateAnsi(link, 4);
    assert.equal(fmt.stripAnsi(truncated), 'Open');
    assert.ok(truncated.endsWith('\x1b]8;;\x1b\\'));
  });
});

test('keeps https hyperlinks and drops other OSC sequences', () => {
  const link = '\x1b]8;;https://example.test/x\x1b\\x\x1b]8;;\x1b\\';
  assert.equal(fmt.sanitizeAnsiLine(link), link);
  assert.equal(fmt.sanitizeAnsiLine('\x1b]0;title\x07x'), 'x');
});


test('strips ANSI codes when measuring text', () => {
  const input = '\x1b[31mred\x1b[0m';
  assert.equal(fmt.stripAnsi(input), 'red');
  assert.equal(fmt.visibleLength(input), 3);
});

test('truncates text without counting ANSI codes', () => {
  const input = '\x1b[31mhello\x1b[0m';
  const truncated = fmt.truncateAnsi(input, 3);
  assert.equal(fmt.stripAnsi(truncated), 'hel');
  assert.equal(fmt.visibleLength(truncated), 3);
  assert.ok(truncated.endsWith(fmt.codes.reset));
});

test('leaves short text untouched', () => {
  assert.equal(fmt.truncateAnsi('abc', 10), 'abc');
  assert.equal(fmt.truncateAnsi('abc', 0), '');
});

test('adds an ellipsis when text is too long', () => {
  assert.equal(fmt.ellipsizeAnsi('abcdef', 4), 'abc…');
  assert.equal(fmt.ellipsizeAnsi('abc', 4), 'abc');
  assert.equal(fmt.ellipsizeAnsi('abcdef', 1), 'a');
});

test('spreads two columns across the available width', () => {
  assert.equal(fmt.stripAnsi(fmt.spread('a', 'b', 5)), 'a   b');
  assert.equal(fmt.stripAnsi(fmt.spread('abcdef', 'x', 4)), 'a… x');
  assert.equal(fmt.stripAnsi(fmt.spread('abc', 'def', 4)), ' def');
});

test('sanitizes control characters', () => {
  assert.equal(fmt.sanitizeText('a\x1b[31mb\x00c'), 'ab c');
});

test('keeps SGR color codes but drops other escape sequences', () => {
  assert.equal(
    fmt.sanitizeAnsiLine('a\x1b[31mb\x1b[2Jc\x07d'),
    'a\x1b[31mbc d',
  );
  assert.equal(fmt.sanitizeAnsiLine('\x1b]0;title\x07x'), 'x');
});

test('wraps paragraphs at word boundaries', () => {
  assert.deepEqual(fmt.wrapText('The quick brown fox', 10), ['The quick', 'brown fox']);
  assert.deepEqual(fmt.wrapText('one\n\ntwo', 20), ['one', '', 'two']);
});

test('breaks words longer than the width', () => {
  assert.deepEqual(fmt.wrapText('abcdefghijkl', 5), ['abcde', 'fghij', 'kl']);
});

test('formats durations', () => {
  assert.equal(fmt.fmtDuration(0), '<1s');
  assert.equal(fmt.fmtDuration(1500), '1s');
  assert.equal(fmt.fmtDuration(61000), '1m 1s');
  assert.equal(fmt.fmtDuration(120000), '2m');
  assert.equal(fmt.fmtDuration(3600000), '1h');
  assert.equal(fmt.fmtDuration(3660000), '1h 1m');
  assert.equal(fmt.fmtDuration(Number.NaN), '');
});

test('computes duration between timestamps', () => {
  assert.equal(
    fmt.durationBetween('2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z'),
    60000,
  );
  assert.equal(fmt.durationBetween('not-a-date', '2026-01-01T00:00:00Z'), 0);
});

test('shortens commit SHAs', () => {
  assert.equal(fmt.shortSha('0123456789abcdef'), '0123456');
  assert.equal(fmt.shortSha(''), '');
});

test('maps run and job statuses to labels and colors', () => {
  assert.equal(fmt.statusColor('completed', 'success'), 'green');
  assert.equal(fmt.statusColor('completed', 'failure'), 'red');
  assert.equal(fmt.statusColor('completed', 'cancelled'), 'yellow');
  assert.equal(fmt.statusColor('in_progress', null), 'cyan');
  assert.equal(fmt.statusColor('queued', null), 'yellow');
  assert.equal(fmt.statusLabel('completed', 'success'), 'success');
  assert.equal(fmt.statusLabel('in_progress', null), 'in progress');
  assert.equal(fmt.statusLabel('', null), 'unknown');
});

test('renders step markers', () => {
  assert.equal(fmt.stepMarker('completed', 'success'), '[ok]');
  assert.equal(fmt.stepMarker('completed', 'skipped'), '[-]');
  assert.equal(fmt.stepMarker('completed', 'cancelled'), '[!]');
  assert.equal(fmt.stepMarker('completed', 'failure'), '[x]');
  assert.equal(fmt.stepMarker('in_progress', null), '[..]');
  assert.equal(fmt.stepMarker('queued', null), '[ ]');
});
