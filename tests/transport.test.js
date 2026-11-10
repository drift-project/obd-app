import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ELM327 } from '../src/elm327.js';
import { FAST_PIDS } from '../src/pids.js';
import { ELM327Simulator } from '../src/simulator.js';
import { WebSerialTransport } from '../src/transports.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Stands in for a Web Serial `SerialPort` wired to the simulator. */
class FakeSerialPort {
  constructor(simulator, { chunkSize = 0 } = {}) {
    this.simulator = simulator;
    this.chunkSize = chunkSize;
    this.opened = false;
    this.openCalls = [];
    this.controller = null;
  }

  async open(options) {
    if (this.opened) throw new DOMException('The port is already open.', 'InvalidStateError');
    this.openCalls.push(options);
    this.opened = true;
    let buffer = '';
    this.readable = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.writable = new WritableStream({
      write: (chunk) => {
        buffer += decoder.decode(chunk);
        while (buffer.includes('\r')) {
          const end = buffer.indexOf('\r');
          const answer = this.simulator.handle(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          // Bluetooth delivers answers in arbitrary pieces.
          const size = this.chunkSize || answer.length;
          for (let i = 0; i < answer.length; i += size) this.controller.enqueue(encoder.encode(answer.slice(i, i + size)));
        }
      },
    });
  }

  async close() {
    if (this.readable.locked || this.writable.locked) throw new TypeError('streams are still locked');
    this.opened = false;
  }
}

test('ELM327 session works over the Web Serial transport', async () => {
  const port = new FakeSerialPort(new ELM327Simulator());
  const elm = new ELM327(new WebSerialTransport(port), { timeoutMs: 500 });
  await elm.connect();
  assert.deepEqual(port.openCalls, [{ baudRate: 38400 }]);
  assert.equal(elm.version, 'ELM327 v1.5');
  assert.equal((await elm.query(FAST_PIDS)).size, FAST_PIDS.length);
  await elm.close();
  assert.equal(port.opened, false);
});

test('answers split into small chunks are reassembled', async () => {
  const port = new FakeSerialPort(new ELM327Simulator(), { chunkSize: 3 });
  const elm = new ELM327(new WebSerialTransport(port), { timeoutMs: 500 });
  await elm.connect();
  assert.equal((await elm.query(FAST_PIDS)).size, FAST_PIDS.length);
  await elm.close();
});

test('read returns empty text after the timeout', async () => {
  const transport = new WebSerialTransport(new FakeSerialPort(new ELM327Simulator()));
  await transport.open();
  const started = performance.now();
  assert.equal(await transport.read(30), '');
  assert.ok(performance.now() - started >= 25);
  await transport.close();
});

test('a dropped link surfaces as an error on read and write', async () => {
  const port = new FakeSerialPort(new ELM327Simulator());
  const transport = new WebSerialTransport(port);
  await transport.open();
  port.controller.error(new Error('Bluetooth link lost'));
  await assert.rejects(transport.read(200), /adapter connection lost: Bluetooth link lost/);
  await assert.rejects(transport.write('ATI\r'), /adapter connection lost/);
  await transport.close();
});

test('the port can be reopened after close, and close is safe to repeat', async () => {
  const port = new FakeSerialPort(new ELM327Simulator());
  const transport = new WebSerialTransport(port);
  await transport.open();
  await transport.close();
  await transport.close();
  await transport.open();
  await transport.write('ATI\r');
  assert.match(await transport.read(200), /ELM327 v1\.5/);
  await transport.close();
  assert.equal(port.opened, false);
});

test('a port left open by an unclean close is reused', async () => {
  const port = new FakeSerialPort(new ELM327Simulator());
  await port.open({ baudRate: 38400 });
  const transport = new WebSerialTransport(port);
  await transport.open();
  await transport.write('ATI\r');
  assert.match(await transport.read(200), /ELM327 v1\.5/);
  await transport.close();
});
