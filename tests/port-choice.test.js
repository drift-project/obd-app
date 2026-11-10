// How the app asks the browser for the adapter port. Two details decide
// whether Chrome on Android shows the paired adapter at all (found on the
// first test with a real phone, where the list was empty):
// the request must be limited to Bluetooth ports, and remembered ports must
// not be asked for before an adapter was ever picked.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SERIAL_PORT_PROFILE, pickPort, portRequestOptions } from '../src/transports.js';

const BLUETOOTH_ONLY = {
  filters: [{ bluetoothServiceClassId: SERIAL_PORT_PROFILE }],
  allowedBluetoothServiceClassIds: [SERIAL_PORT_PROFILE],
};

/** Stands in for `navigator.serial`; `refuse` makes the chooser fail for a given request. */
function fakeSerial({ remembered = [], refuse = () => null } = {}) {
  const calls = [];
  return {
    calls,
    async getPorts() {
      calls.push(['getPorts']);
      return remembered;
    },
    async requestPort(options) {
      calls.push(['requestPort', options]);
      const error = refuse(options);
      if (error) throw error;
      return 'picked port';
    },
  };
}

test('on Android only Bluetooth serial ports are asked for', () => {
  // Only such a request makes Chrome ask for its Bluetooth permission.
  assert.deepEqual(portRequestOptions({ android: true }), BLUETOOTH_ONLY);
  assert.equal(SERIAL_PORT_PROFILE, '00001101-0000-1000-8000-00805f9b34fb');
});

test('elsewhere every serial port is offered', () => {
  assert.deepEqual(portRequestOptions({ android: false }), {});
  assert.deepEqual(portRequestOptions(), {});
});

test('remembered ports are not asked for before an adapter was ever picked', async () => {
  const serial = fakeSerial({ remembered: ['old port'] });
  const result = await pickPort(serial, { android: true });
  assert.deepEqual(result, { port: 'picked port', remembered: false });
  assert.deepEqual(serial.calls, [['requestPort', BLUETOOTH_ONLY]]);
});

test('a remembered adapter is reused without the chooser', async () => {
  const serial = fakeSerial({ remembered: ['old port', 'older port'] });
  const result = await pickPort(serial, { pickedBefore: true, android: true });
  assert.deepEqual(result, { port: 'old port', remembered: true });
  assert.deepEqual(serial.calls, [['getPorts']]);
});

test('the chooser opens when the remembered adapter is gone', async () => {
  const serial = fakeSerial();
  const result = await pickPort(serial, { pickedBefore: true });
  assert.deepEqual(result, { port: 'picked port', remembered: false });
  assert.deepEqual(serial.calls, [['getPorts'], ['requestPort', {}]]);
});

test('choosing another adapter always opens the chooser', async () => {
  const serial = fakeSerial({ remembered: ['old port'] });
  const result = await pickPort(serial, { choose: true, pickedBefore: true });
  assert.deepEqual(result, { port: 'picked port', remembered: false });
  assert.deepEqual(serial.calls, [['requestPort', {}]]);
});

test('a browser that does not accept the Bluetooth filter is asked without it', async () => {
  const serial = fakeSerial({ refuse: (options) => (options ? new TypeError('unknown filter') : null) });
  const result = await pickPort(serial, { android: true });
  assert.deepEqual(result, { port: 'picked port', remembered: false });
  assert.deepEqual(serial.calls, [['requestPort', BLUETOOTH_ONLY], ['requestPort', undefined]]);
});

test('a chooser closed without a choice is reported and not opened again', async () => {
  const closed = () => new DOMException('No port selected by the user.', 'NotFoundError');
  const serial = fakeSerial({ refuse: closed });
  await assert.rejects(pickPort(serial, { android: true }), { name: 'NotFoundError' });
  assert.equal(serial.calls.length, 1);
});
