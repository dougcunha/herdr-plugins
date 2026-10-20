'use strict';

const fmt = require('./format');

/**
 * Glyphs are single width so the layout stays aligned on every terminal.
 * Set CI_DASH_ASCII=1 to fall back to plain ASCII.
 */
const ASCII = Boolean(process.env.CI_DASH_ASCII) || process.env.TERM === 'dumb';

const UNICODE = {
  brand: '◆',
  pointer: '❯',
  workflow: '◆',
  workflowOff: '◇',
  branch: '⎇',
  tag: '#',
  user: '@',
  lock: '●',
  check: '✓',
  cross: '✗',
  dot: '●',
  circle: '○',
  running: '▶',
  queued: '◌',
  skipped: '⊘',
  cancelled: '■',
  warn: '▲',
  star: '★',
  link: '↗',
  download: '↓',
  search: '⌕',
  sep: '›',
  dash: '─',
  tree: '├─',
  treeLast: '└─',
  updown: '↑↓',
  leftright: '←→',
  enter: '⏎',
};

const PLAIN = {
  brand: '*',
  pointer: '>',
  workflow: '*',
  workflowOff: '-',
  branch: '|',
  tag: '#',
  user: '@',
  lock: '*',
  check: '+',
  cross: 'x',
  dot: '*',
  circle: 'o',
  running: '>',
  queued: '.',
  skipped: '-',
  cancelled: '!',
  warn: '!',
  star: '*',
  link: '->',
  download: 'v',
  search: '/',
  sep: '>',
  dash: '-',
  tree: '|-',
  treeLast: '\\-',
  updown: '^v',
  leftright: '<>',
  enter: 'Enter',
};

const GLYPHS = ASCII ? PLAIN : UNICODE;

function icon(name) {
  return GLYPHS[name] || '';
}

function statusIcon(status, conclusion) {
  if (status === 'completed') {
    switch (conclusion) {
      case 'success':
        return GLYPHS.check;
      case 'skipped':
        return GLYPHS.skipped;
      case 'cancelled':
        return GLYPHS.cancelled;
      case 'neutral':
      case 'stale':
        return GLYPHS.circle;
      default:
        return GLYPHS.cross;
    }
  }
  if (status === 'in_progress') return GLYPHS.running;
  if (status === 'queued' || status === 'requested' || status === 'waiting') {
    return GLYPHS.queued;
  }
  return GLYPHS.circle;
}

function theme(name, value) {
  return fmt.style(name, value);
}

function pad(content, width) {
  return fmt.padRight(fmt.ellipsizeAnsi(content, width), width);
}

function rule(width, char = GLYPHS.dash) {
  const count = Math.max(0, Math.floor(width));
  return theme('border', char.repeat(count));
}

/**
 * Renders one list row. Selected rows are flattened to plain text and painted
 * with a single background token, because an inner color reset would drop the
 * highlight halfway across the line.
 */
function row(content, width, selected = false) {
  if (selected) return theme('selection', pad(fmt.stripAnsi(content), width));
  return pad(content, width);
}

function stepper(labels, current, width) {
  const parts = labels.map((label, index) => {
    const number = index + 1;
    if (number < current) {
      return `${icon('check')} ${theme('muted', `${number} ${label}`)}`;
    }
    if (number === current) {
      return `${theme('accent', `${icon('pointer')} ${number} ${label}`)}`;
    }
    return theme('muted', `${number} ${label}`);
  });
  return fmt.truncateAnsi(
    parts.join(theme('border', `  ${icon('sep')}  `)),
    width,
  );
}

/**
 * Packs the shortcut hints into up to `maxLines` lines, keeping the labels
 * with their keys. Narrow panels wrap instead of dropping the descriptions.
 */
function hintsLines(pairs, width, maxLines = 2) {
  const segments = pairs.map(
    ([key, label]) => `${theme('key', key)} ${theme('muted', label)}`,
  );
  if (segments.length === 0) return [''];

  const lines = [];
  let line = '';
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!line) {
      line = fmt.ellipsizeAnsi(segment, width);
      continue;
    }
    const candidate = `${line}  ${segment}`;
    if (fmt.visibleLength(candidate) <= width) {
      line = candidate;
      continue;
    }
    lines.push(line);
    if (lines.length >= Math.max(1, maxLines) - 1) {
      const rest = [segment, ...segments.slice(index + 1)].join('  ');
      lines.push(fmt.ellipsizeAnsi(rest, width));
      return lines;
    }
    line = segment;
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

function chips(options, current, width) {
  const parts = options.map((option) => {
    const active = option === current;
    const marker = active ? icon('dot') : icon('circle');
    const text = active ? theme('accent', option) : theme('muted', option);
    return `${theme(active ? 'accent' : 'border', marker)} ${text}`;
  });
  const lines = [];
  let line = '';
  for (const part of parts) {
    const candidate = line ? `${line}  ${part}` : part;
    if (fmt.visibleLength(candidate) > width && line) {
      lines.push(line);
      line = part;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function frameTop(contentWidth) {
  const bar = (ASCII ? '-' : '─').repeat(Math.max(0, contentWidth + 2));
  return theme('border', ASCII ? `+${bar}+` : `╭${bar}╮`);
}

function frameBottom(contentWidth) {
  const bar = (ASCII ? '-' : '─').repeat(Math.max(0, contentWidth + 2));
  return theme('border', ASCII ? `+${bar}+` : `╰${bar}╯`);
}

function frameRow(content, contentWidth) {
  const bar = ASCII ? '|' : '│';
  return `${theme('border', bar)} ${pad(content, contentWidth)} ${theme('border', bar)}`;
}

module.exports = {
  ASCII,
  GLYPHS,
  icon,
  statusIcon,
  theme,
  pad,
  rule,
  row,
  stepper,
  hintsLines,
  chips,
  frameTop,
  frameBottom,
  frameRow,
};
