'use strict';

const readline = require('node:readline');
const { truncateAnsi, sanitizeAnsiLine } = require('./format');

class Tui {
  constructor({ onKey, onClick, onHover, onResize } = {}) {
    this.onKey = onKey || (() => {});
    this.onClick = onClick || (() => {});
    this.onHover = onHover || (() => {});
    this.onResize = onResize || (() => {});
    this.started = false;
    this.stopped = false;
    this.mouseEnabled = false;
    this.pointerSet = false;
    this.mousePending = '';
    this.mouseSuppress = false;
    this.keypressHandler = null;
    this.mouseHandler = null;
    this.resizeHandler = null;
    this.exitHandler = null;
  }

  get columns() {
    return process.stdout.columns || 100;
  }

  get rows() {
    return process.stdout.rows || 30;
  }

  start() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('CI Dash needs an interactive terminal. Run it inside a Herdr pane.');
    }

    process.stdin.setRawMode(true);
    this.mouseHandler = (chunk) => this.handleMouseData(chunk);
    process.stdin.on('data', this.mouseHandler);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.resume();

    this.keypressHandler = (str, key) => this.handleKey(str, key);
    this.resizeHandler = () => this.onResize();
    this.exitHandler = () => this.writeRestore();

    process.stdin.on('keypress', this.keypressHandler);
    process.stdout.on('resize', this.resizeHandler);
    process.on('exit', this.exitHandler);

    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
    this.started = true;
  }

  writeRestore() {
    try {
      process.stdout.write(
        '\x1b]22;default\x1b\\\x1b[?1003l\x1b[?1006l\x1b[?25h\x1b[?1049l',
      );
    } catch {
      // The terminal may already be gone.
    }
  }

  /**
   * SGR mouse reporting is enabled only while clickable rows are on screen,
   * so native selection and scrolling keep working everywhere else.
   */
  setMouse(enabled) {
    if (this.mouseEnabled === enabled) return;
    this.mouseEnabled = enabled;
    if (!enabled) this.setPointer(false);
    if (!this.started) return;
    process.stdout.write(
      enabled ? '\x1b[?1003h\x1b[?1006h' : '\x1b[?1003l\x1b[?1006l',
    );
  }

  /**
   * OSC 22 asks terminals that support it to show a hand over clickable
   * rows. Elsewhere the hover highlight is the only feedback and the
   * sequence is ignored.
   */
  setPointer(pointer) {
    if (this.pointerSet === pointer) return;
    this.pointerSet = pointer;
    if (!this.started) return;
    process.stdout.write(
      pointer ? '\x1b]22;pointer\x1b\\' : '\x1b]22;default\x1b\\',
    );
  }

  handleMouseData(chunk) {
    const text = `${this.mousePending}${chunk.toString('utf8')}`;
    this.mousePending = '';

    const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let matched = false;
    let match;
    while ((match = pattern.exec(text))) {
      matched = true;
      if (match[4] !== 'M') continue;

      const button = Number(match[1]);
      const x = Number(match[2]);
      const y = Number(match[3]);
      if ((button & 32) === 32) {
        if ((button & 3) === 3) this.onHover({ type: 'move', x, y });
      } else if ((button & 64) === 64) {
        this.onKey({ type: (button & 1) === 1 ? 'down' : 'up' });
      } else if ((button & 3) === 0) {
        this.onClick({ type: 'click', x, y });
      }
    }

    const partial = /\x1b\[<[0-9;]*$/.exec(text);
    if (partial) this.mousePending = partial[0];

    if (matched || partial) {
      // readline parses the same chunk as ordinary keys after this listener
      // returns; swallow them so a click does not type into a filter.
      this.mouseSuppress = true;
      queueMicrotask(() => {
        this.mouseSuppress = false;
      });
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;

    if (this.keypressHandler) {
      process.stdin.removeListener('keypress', this.keypressHandler);
    }
    if (this.mouseHandler) {
      process.stdin.removeListener('data', this.mouseHandler);
    }
    if (this.resizeHandler) {
      process.stdout.removeListener('resize', this.resizeHandler);
    }
    if (this.exitHandler) {
      process.removeListener('exit', this.exitHandler);
    }

    if (this.started) {
      this.setMouse(false);
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Ignore terminals that already restored themselves.
      }
      process.stdin.pause();
      this.writeRestore();
    }
  }

  draw(lines) {
    if (!this.started) return;
    const columns = this.columns;
    const rows = this.rows;
    const output = (lines || [])
      .slice(0, rows)
      .map((line) => truncateAnsi(sanitizeAnsiLine(line), columns))
      .join('\r\n');
    process.stdout.write(`\x1b[H\x1b[2J${output}`);
  }

  handleKey(str, key = {}) {
    if (this.mouseSuppress) return;

    if (key.ctrl && key.name === 'c') {
      this.onKey({ type: 'quit' });
      return;
    }

    if (key.ctrl && key.name) {
      this.onKey({ type: 'ctrl', name: key.name });
      return;
    }

    switch (key.name) {
      case 'return':
      case 'enter':
        this.onKey({ type: 'enter' });
        return;
      case 'escape':
        this.onKey({ type: 'escape' });
        return;
      case 'tab':
        this.onKey({ type: key.shift ? 'backtab' : 'tab' });
        return;
      case 'up':
      case 'down':
      case 'left':
      case 'right':
      case 'pageup':
      case 'pagedown':
      case 'home':
      case 'end':
        this.onKey({ type: key.name });
        return;
      case 'backspace':
      case 'delete':
        this.onKey({ type: key.name });
        return;
      default:
        break;
    }

    if (key.meta) return;

    if (str) {
      for (const character of String(str)) {
        this.onKey({ type: 'char', ch: character });
      }
    }
  }
}

module.exports = { Tui };
