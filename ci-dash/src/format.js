'use strict';

const colorEnabled = !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const codes = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  inverse: '\x1b[7m',
};

const truecolor =
  colorEnabled && /truecolor|24bit/i.test(process.env.COLORTERM || '');
const ansi256 =
  colorEnabled &&
  (truecolor ||
    /256color/i.test(process.env.TERM || '') ||
    process.env.TERM === 'xterm' ||
    process.platform === 'win32');

/**
 * Semantic color tokens. Each one is resolved to the best available color
 * depth when it is painted, so the same layout works on a 16-color terminal
 * and on a truecolor one.
 */
const styles = {
  brand: { fg: [122, 162, 247], fg256: 111, fg16: '94', bold: true },
  strong: { fg: [230, 237, 243], fg256: 255, fg16: '97', bold: true },
  text: { fg: [201, 209, 217], fg256: 250, fg16: '37' },
  accent: { fg: [125, 207, 255], fg256: 117, fg16: '96', bold: true },
  info: { fg: [125, 207, 255], fg256: 117, fg16: '96' },
  muted: { fg: [139, 148, 158], fg256: 245, fg16: '90' },
  border: { fg: [71, 90, 115], fg256: 60, fg16: '90' },
  success: { fg: [158, 206, 106], fg256: 149, fg16: '92', bold: true },
  danger: { fg: [247, 118, 142], fg256: 204, fg16: '91', bold: true },
  warning: { fg: [224, 175, 104], fg256: 179, fg16: '93' },
  key: { fg: [122, 162, 247], fg256: 111, fg16: '96', bold: true },
  green: { fg: [158, 206, 106], fg256: 149, fg16: '92' },
  red: { fg: [247, 118, 142], fg256: 204, fg16: '91' },
  yellow: { fg: [224, 175, 104], fg256: 179, fg16: '93' },
  cyan: { fg: [125, 207, 255], fg256: 117, fg16: '96' },
  gray: { fg: [139, 148, 158], fg256: 245, fg16: '90' },
  selection: {
    bg: [47, 51, 77],
    bg256: 236,
    fg: [230, 237, 243],
    fg256: 255,
    fg16: '97',
    reverse: true,
  },
};

function fgParams(spec) {
  if (truecolor && spec.fg) return `38;2;${spec.fg.join(';')}`;
  if (ansi256 && spec.fg256 != null) return `38;5;${spec.fg256}`;
  if (spec.fg16) return spec.fg16;
  return '';
}

function bgParams(spec) {
  if (truecolor && spec.bg) return `48;2;${spec.bg.join(';')}`;
  if (ansi256 && spec.bg256 != null) return `48;5;${spec.bg256}`;
  if (spec.bg16) return spec.bg16;
  return '';
}

function style(name, value) {
  const spec = styles[name];
  if (!colorEnabled || !spec) return String(value);

  const params = [];
  const back = bgParams(spec);
  if (!back && spec.reverse) params.push('7');
  if (spec.bold) params.push('1');
  const front = fgParams(spec);
  if (front) params.push(front);
  if (back) params.push(back);
  if (params.length === 0) return String(value);
  return `\x1b[${params.join(';')}m${value}${codes.reset}`;
}

function color(name, value) {
  const code = codes[name];
  if (!colorEnabled || !code) return String(value);
  return `${code}${value}${codes.reset}`;
}

function stripAnsi(input) {
  return String(input)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * Terminal hyperlink (OSC 8). The visible text can be anything; the target
 * stays intact, so clicking opens the full URL even when the label is short.
 */
function hyperlink(url, text) {
  const target = String(url || '');
  if (!/^https?:\/\//i.test(target)) return String(text);
  if (process.env.TERM === 'dumb' || process.env.CI_DASH_NO_LINKS === '1') {
    return String(text);
  }
  return `\x1b]8;;${target}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function visibleLength(input) {
  return Array.from(stripAnsi(input)).length;
}

const HYPERLINK_CLOSE = '\x1b]8;;\x1b\\';

function hasOpenHyperlink(text) {
  const openers = text.match(/\x1b\]8;;[^\x1b]+\x1b\\/g);
  const closers = text.match(/\x1b\]8;;\x1b\\/g);
  const opened = openers ? openers.length : 0;
  const closed = closers ? closers.length : 0;
  return opened > closed;
}

function truncateAnsi(input, width) {
  const source = String(input);
  if (width <= 0) return '';
  let output = '';
  let visible = 0;
  let index = 0;
  while (index < source.length && visible < width) {
    if (source[index] === '\x1b') {
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(source.slice(index));
      if (osc) {
        output += osc[0];
        index += osc[0].length;
        continue;
      }
      const csi = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(source.slice(index));
      if (csi) {
        output += csi[0];
        index += csi[0].length;
        continue;
      }
    }
    const codePoint = source.codePointAt(index);
    const character = String.fromCodePoint(codePoint);
    output += character;
    index += character.length;
    visible += 1;
  }
  if (index < source.length && source.includes('\x1b')) {
    output += codes.reset;
  }
  if (hasOpenHyperlink(output)) output += HYPERLINK_CLOSE;
  return output;
}

function padRight(input, width) {
  const length = visibleLength(input);
  if (length >= width) return input;
  return `${input}${' '.repeat(width - length)}`;
}

function sanitizeText(input) {
  return String(input ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
}

/**
 * Keep SGR color codes generated by this plugin while dropping every other
 * escape sequence and control character. Workflow, job and step names come
 * from repository YAML and must not be able to move the cursor or clear the
 * screen.
 */
function sanitizeAnsiLine(input) {
  const source = String(input ?? '');
  let output = '';
  let index = 0;

  while (index < source.length) {
    if (source[index] === '\x1b') {
      const sgr = /^\x1b\[[0-9;]*m/.exec(source.slice(index));
      if (sgr) {
        output += sgr[0];
        index += sgr[0].length;
        continue;
      }
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(source.slice(index));
      if (osc) {
        // Keep OSC 8 hyperlinks pointing at https, plus their closing
        // sequence, which the "open run" button relies on. Every other OSC
        // sequence is dropped.
        if (/^\x1b\]8;;(?:https:\/\/[^\x07\x1b]*)?\x1b\\$/.test(osc[0])) {
          output += osc[0];
        }
        index += osc[0].length;
        continue;
      }
      const sequence = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(source.slice(index));
      index += sequence ? sequence[0].length : 1;
      continue;
    }

    const codePoint = source.codePointAt(index);
    const character = String.fromCodePoint(codePoint);
    output += codePoint < 0x20 || codePoint === 0x7f ? ' ' : character;
    index += character.length;
  }

  return output;
}

/**
 * Places `left` and `right` on the same line, padding the gap with spaces.
 * The right side wins when the width is tight, so callers can keep the most
 * useful value (a path, a duration) visible in narrow panels.
 */
function ellipsizeAnsi(input, width) {
  const safeWidth = Math.max(0, width);
  if (visibleLength(input) <= safeWidth) return String(input);
  if (safeWidth <= 1) return truncateAnsi(input, safeWidth);

  const truncated = truncateAnsi(input, safeWidth - 1);
  if (truncated.endsWith(codes.reset)) {
    return `${truncated.slice(0, -codes.reset.length)}…${codes.reset}`;
  }
  return `${truncated}…`;
}

function spread(left, right, width) {
  const safeWidth = Math.max(1, width);
  const leftText = String(left ?? '');
  const rightText = String(right ?? '');
  const rightWidth = visibleLength(rightText);

  if (rightWidth === 0) {
    return padRight(ellipsizeAnsi(leftText, safeWidth), safeWidth);
  }
  if (rightWidth >= safeWidth) {
    return padRight(ellipsizeAnsi(rightText, safeWidth), safeWidth);
  }

  const room = safeWidth - rightWidth - 1;
  const leftText2 = padRight(ellipsizeAnsi(leftText, room), room);
  return `${leftText2} ${rightText}`;
}

function wrapText(input, width) {
  const safeWidth = Math.max(1, width);
  const source = sanitizeText(input);
  const output = [];

  for (const paragraph of source.split(/\r?\n/)) {
    if (paragraph.trim() === '') {
      output.push('');
      continue;
    }

    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (word === '') continue;
      if (line === '') {
        if (word.length <= safeWidth) {
          line = word;
        } else {
          let rest = word;
          while (rest.length > safeWidth) {
            output.push(rest.slice(0, safeWidth));
            rest = rest.slice(safeWidth);
          }
          line = rest;
        }
        continue;
      }

      if (line.length + 1 + word.length <= safeWidth) {
        line += ` ${word}`;
      } else {
        output.push(line);
        if (word.length <= safeWidth) {
          line = word;
        } else {
          let rest = word;
          while (rest.length > safeWidth) {
            output.push(rest.slice(0, safeWidth));
            rest = rest.slice(safeWidth);
          }
          line = rest;
        }
      }
    }
    output.push(line);
  }

  return output;
}

function fmtDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '';
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  if (total < 1) return '<1s';
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function durationBetween(start, end) {
  const from = Date.parse(start || '');
  const to = Date.parse(end || '');
  if (!Number.isFinite(from)) return 0;
  return Math.max(0, (Number.isFinite(to) ? to : Date.now()) - from);
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : '';
}

function statusColor(status, conclusion) {
  if (status === 'completed') {
    switch (conclusion) {
      case 'success':
        return 'green';
      case 'failure':
      case 'timed_out':
      case 'startup_failure':
        return 'red';
      case 'cancelled':
      case 'action_required':
        return 'yellow';
      default:
        return 'gray';
    }
  }
  if (status === 'in_progress') return 'cyan';
  if (status === 'queued' || status === 'requested' || status === 'waiting') return 'yellow';
  return 'gray';
}

function statusLabel(status, conclusion) {
  if (!status) return 'unknown';
  if (status === 'completed') return conclusion || 'completed';
  return String(status).replace(/_/g, ' ');
}

function stepMarker(status, conclusion) {
  if (status === 'completed') {
    if (conclusion === 'success') return '[ok]';
    if (conclusion === 'skipped') return '[-]';
    if (conclusion === 'cancelled') return '[!]';
    return '[x]';
  }
  if (status === 'in_progress') return '[..]';
  return '[ ]';
}

module.exports = {
  codes,
  color,
  style,
  styles,
  hyperlink,
  colorEnabled,
  ansi256,
  truecolor,
  stripAnsi,
  visibleLength,
  truncateAnsi,
  ellipsizeAnsi,
  padRight,
  spread,
  sanitizeText,
  sanitizeAnsiLine,
  wrapText,
  fmtDuration,
  durationBetween,
  shortSha,
  statusColor,
  statusLabel,
  stepMarker,
};
