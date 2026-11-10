// Web Serial transport for the ELM327 driver.
//
// Chrome on Android (137+) and desktop Chrome/Edge expose paired classic
// Bluetooth SPP devices, such as cheap ELM327 adapters, as serial ports.
// The baud rate is required by the API and ignored for Bluetooth links.

const encoder = new TextEncoder();

/** The standard Bluetooth Serial Port Profile, which ELM327 adapters use. */
export const SERIAL_PORT_PROFILE = '00001101-0000-1000-8000-00805f9b34fb';

/**
 * Options for `navigator.serial.requestPort()`.
 *
 * Chrome on Android sees paired Bluetooth devices only with the "Nearby
 * devices" permission, and its chooser asks for that permission only when the
 * request is limited to Bluetooth ports. An open request gets an empty list
 * ("No compatible devices found") and nothing tells the user why. Android has
 * no other serial ports anyway; elsewhere wired adapters stay in the list.
 */
export function portRequestOptions({ android = false } = {}) {
  if (!android) return {};
  return {
    filters: [{ bluetoothServiceClassId: SERIAL_PORT_PROFILE }],
    allowedBluetoothServiceClassIds: [SERIAL_PORT_PROFILE],
  };
}

async function requestPort(serial, android) {
  try {
    return await serial.requestPort(portRequestOptions({ android }));
  } catch (error) {
    // A browser that does not accept the Bluetooth filter: ask without it.
    if (!android || error.name !== 'TypeError') throw error;
    return serial.requestPort();
  }
}

/**
 * The adapter port: the one the browser remembers, or one picked by the user.
 *
 * Remembered ports are asked for only when an adapter was picked on this device
 * before (`pickedBefore`). Chrome on Android fills its list of Bluetooth ports
 * once per browser start. Asking for remembered ports before Chrome holds the
 * Bluetooth permission leaves that list empty until Chrome is restarted.
 */
export async function pickPort(serial, { choose = false, pickedBefore = false, android = false } = {}) {
  if (!choose && pickedBefore) {
    const [port] = await serial.getPorts();
    if (port) return { port, remembered: true };
  }
  return { port: await requestPort(serial, android), remembered: false };
}

export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class WebSerialTransport {
  #reader = null;
  #writer = null;
  #pump = null;
  #queue = '';
  #failure = null;
  #wake = null;

  constructor(port, { baudRate = 38400, ioTimeoutMs = 5000 } = {}) {
    this.port = port;
    this.baudRate = baudRate;
    this.ioTimeoutMs = ioTimeoutMs;
  }

  async open() {
    try {
      await withTimeout(this.port.open({ baudRate: this.baudRate }), 10000, 'opening the adapter timed out');
    } catch (error) {
      // Still open after an unclean close: reuse it.
      if (error.name !== 'InvalidStateError') throw error;
    }
    this.#queue = '';
    this.#failure = null;
    this.#reader = this.port.readable.getReader();
    this.#writer = this.port.writable.getWriter();
    this.#pump = this.#readLoop(this.#reader);
  }

  async #readLoop(reader) {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.#queue += decoder.decode(value, { stream: true });
        this.#wake?.();
      }
      this.#failure ??= new Error('adapter closed the connection');
    } catch (error) {
      this.#failure ??= error;
    }
    this.#wake?.();
  }

  async write(text) {
    if (this.#failure || !this.#writer) throw this.#lost();
    await withTimeout(this.#writer.write(encoder.encode(text)), this.ioTimeoutMs, 'writing to the adapter timed out');
  }

  /** Text that arrives within `timeoutMs` (may be ''); read(0) returns what is buffered. */
  async read(timeoutMs) {
    if (!this.#queue && !this.#failure && timeoutMs > 0) {
      await new Promise((resolve) => {
        let timer = null;
        const done = () => {
          clearTimeout(timer);
          this.#wake = null;
          resolve();
        };
        timer = setTimeout(done, timeoutMs);
        this.#wake = done;
      });
    }
    if (this.#queue) {
      const text = this.#queue;
      this.#queue = '';
      return text;
    }
    if (this.#failure || !this.#reader) throw this.#lost();
    return '';
  }

  async close() {
    const reader = this.#reader;
    const writer = this.#writer;
    const pump = this.#pump;
    this.#reader = null;
    this.#writer = null;
    this.#pump = null;
    this.#wake?.();
    if (reader) {
      await withTimeout(reader.cancel(), 2000, 'cancel timed out').catch(() => {});
      await withTimeout(pump, 2000, 'reader did not stop').catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
    if (writer) {
      try {
        writer.releaseLock();
      } catch {
        // already released
      }
    }
    await withTimeout(this.port.close(), 3000, 'closing the adapter timed out').catch(() => {});
  }

  #lost() {
    return new Error(`adapter connection lost${this.#failure ? `: ${this.#failure.message}` : ''}`);
  }
}
