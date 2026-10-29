'use strict';

const { EventEmitter } = require('node:events');

/**
 * Input backend that only records events in memory. Used for automated tests
 * and for `npm run start:mock` (trying the protocol on a non-Windows machine).
 * It never prints or persists what is typed.
 */
class MockBackend extends EventEmitter {
  constructor({ maxEvents = 10000 } = {}) {
    super();
    this.name = 'mock';
    this.events = [];
    this.maxEvents = maxEvents;
    this.started = false;
  }

  async start() {
    this.started = true;
  }

  async stop() {
    this.started = false;
  }

  _rec(ev) {
    this.events.push(ev);
    if (this.events.length > this.maxEvents) this.events.shift();
    this.emit('event', ev);
  }

  move(dx, dy) {
    this._rec({ type: 'move', dx, dy });
  }

  button(button, down) {
    this._rec({ type: 'button', button, down });
  }

  wheel(dx, dy) {
    this._rec({ type: 'wheel', dx, dy });
  }

  key(name) {
    this._rec({ type: 'key', name });
  }

  gesture(action) {
    this._rec({ type: 'gesture', action });
  }

  zoom(dy) {
    this._rec({ type: 'zoom', dy });
  }

  text(s) {
    this._rec({ type: 'text', text: s });
  }
}

module.exports = { MockBackend };
