'use strict';

const readline = require('node:readline');
const { truncateAnsi, sanitizeAnsiLine } = require('./format');

class Tui {
  constructor({ onKey, onResize } = {}) {
    this.onKey = onKey || (() => {});
    this.onResize = onResize || (() => {});
    this.started = false;
    this.stopped = false;
    this.keypressHandler = null;
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
    process.stdin.resume();
    readline.emitKeypressEvents(process.stdin);

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
      process.stdout.write('\x1b[?25h\x1b[?1049l');
    } catch {
      // The terminal may already be gone.
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;

    if (this.keypressHandler) {
      process.stdin.removeListener('keypress', this.keypressHandler);
    }
    if (this.resizeHandler) {
      process.stdout.removeListener('resize', this.resizeHandler);
    }
    if (this.exitHandler) {
      process.removeListener('exit', this.exitHandler);
    }

    if (this.started) {
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
