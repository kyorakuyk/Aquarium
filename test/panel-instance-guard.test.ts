import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  isPanelPortOccupied,
  type PanelPortConnector,
  type PanelPortSocket,
} from '../src/app/panel-instance-guard.ts';

class FakePortSocket extends EventEmitter {
  timeoutMs = 0;
  timeoutCallback: (() => void) | undefined;
  destroyed = false;

  setTimeout(timeoutMs: number, callback: () => void): this {
    this.timeoutMs = timeoutMs;
    this.timeoutCallback = callback;
    return this;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function connectorFor(socket: FakePortSocket, onConnect: (host: string, port: number) => void): PanelPortConnector {
  return ({ host, port }) => {
    onConnect(host, port);
    return socket as unknown as PanelPortSocket;
  };
}

test('detects a listener on the configured panel address and closes the probe socket', async () => {
  const socket = new FakePortSocket();
  let target: { host: string; port: number } | undefined;
  const occupied = isPanelPortOccupied('127.0.0.1', 5180, connectorFor(socket, (host, port) => {
    target = { host, port };
  }));

  socket.emit('connect');

  assert.equal(await occupied, true);
  assert.deepEqual(target, { host: '127.0.0.1', port: 5180 });
  assert.equal(socket.destroyed, true);
});

test('treats connection refusal as an available panel port', async () => {
  const socket = new FakePortSocket();
  const available = isPanelPortOccupied('127.0.0.1', 5180, connectorFor(socket, () => {}));
  const refused = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });

  socket.emit('error', refused);

  assert.equal(await available, false);
  assert.equal(socket.destroyed, true);
});

test('fails closed when the panel-port probe times out', async () => {
  const socket = new FakePortSocket();
  const occupied = isPanelPortOccupied('::1', 5180, connectorFor(socket, () => {}), 250);

  assert.equal(socket.timeoutMs, 250);
  socket.timeoutCallback?.();

  assert.equal(await occupied, true);
  assert.equal(socket.destroyed, true);
});

test('does not probe a non-loopback configured host', async () => {
  const occupied = await isPanelPortOccupied('0.0.0.0', 5180, () => {
    assert.fail('must not connect to a non-loopback host');
  });

  assert.equal(occupied, false);
});
