'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Tui } = require('../src/tui');

test('turns SGR mouse presses into clicks with terminal coordinates', () => {
  const clicks = [];
  const tui = new Tui({ onClick: (event) => clicks.push(event) });

  tui.handleMouseData(Buffer.from('\x1b[<0;10;5M'));
  tui.handleMouseData(Buffer.from('\x1b[<0;12;6m'));

  assert.deepEqual(clicks, [{ type: 'click', x: 10, y: 5 }]);
});

test('maps the mouse wheel to scrolling keys', () => {
  const keys = [];
  const tui = new Tui({ onKey: (event) => keys.push(event) });

  tui.handleMouseData(Buffer.from('\x1b[<64;10;5M\x1b[<65;10;5M'));

  assert.deepEqual(keys, [{ type: 'up' }, { type: 'down' }]);
});

test('reassembles a mouse sequence split across chunks', () => {
  const clicks = [];
  const tui = new Tui({ onClick: (event) => clicks.push(event) });

  tui.handleMouseData(Buffer.from('\x1b[<0;10;'));
  assert.equal(tui.mousePending, '\x1b[<0;10;');

  tui.handleMouseData(Buffer.from('5M'));
  assert.deepEqual(clicks, [{ type: 'click', x: 10, y: 5 }]);
  assert.equal(tui.mousePending, '');
});
