// OBD-II mode 01 PIDs read by the app (SAE J1979) and their decoders.
//
// The first ten columns are the PIDs, field names and column order of
// OBDPids.py in raspberry-unicore, so a CSV from the phone and one from the
// Raspberry logger start alike. The temperatures after them are read only
// where the car reports them. Brake pressure and steering angle are not
// standard mode 01 PIDs.

const percent = (d) => Math.round((d[0] * 1000) / 255) / 10;
const temperature = (d) => d[0] - 40;

export const PIDS = new Map([
  [0x04, { name: 'engine_load_pct', length: 1, unit: '%', decode: percent }],
  [0x05, { name: 'coolant_c', length: 1, unit: '°C', decode: temperature }],
  [0x0b, { name: 'map_kpa', length: 1, unit: 'kPa', decode: (d) => d[0] }],
  [0x0c, { name: 'rpm', length: 2, unit: 'rpm', decode: (d) => (256 * d[0] + d[1]) / 4 }],
  [0x0d, { name: 'speed_kmh', length: 1, unit: 'km/h', decode: (d) => d[0] }],
  [0x0f, { name: 'intake_air_c', length: 1, unit: '°C', decode: temperature }],
  [0x10, { name: 'maf_gs', length: 2, unit: 'g/s', decode: (d) => (256 * d[0] + d[1]) / 100 }],
  [0x11, { name: 'throttle_pct', length: 1, unit: '%', decode: percent }],
  [0x3c, { name: 'catalyst_c', length: 2, unit: '°C', decode: (d) => (256 * d[0] + d[1] - 400) / 10 }],
  [0x46, { name: 'ambient_c', length: 1, unit: '°C', decode: temperature }],
  [0x49, { name: 'pedal_pct', length: 1, unit: '%', decode: percent }],
  [0x5c, { name: 'oil_c', length: 1, unit: '°C', decode: temperature }],
]);

// Supported-PID bitmaps: 0x00 covers 0x01-0x20, 0x20 covers 0x21-0x40, and so on.
export const SUPPORT_PIDS = [0x00, 0x20, 0x40, 0x60];
export const SUPPORT_LENGTH = 4;

// Polled every cycle: what the driver does and what the car answers with.
export const FAST_PIDS = [0x0c, 0x0d, 0x11, 0x49];
// Polled one at a time, round robin, at most once per slow interval.
export const SLOW_PIDS = [0x04, 0x05, 0x0f, 0x10, 0x0b, 0x5c, 0x46, 0x3c];

// Fixed column order of logged rows. A value is null when the car does not
// support the PID or it was not polled in that cycle.
export const FIELDS = ['timestamp_ms', ...[...FAST_PIDS, ...SLOW_PIDS].map((pid) => PIDS.get(pid).name)];

/** Number of data bytes the car sends back for a mode 01 PID (undefined if unknown). */
export function responseLength(pid) {
  if (SUPPORT_PIDS.includes(pid)) return SUPPORT_LENGTH;
  return PIDS.get(pid)?.length;
}

/** Turn a 4-byte support bitmap for PID `base` into a list of supported PIDs. */
export function decodeSupported(base, data) {
  const supported = [];
  for (let byteIndex = 0; byteIndex < SUPPORT_LENGTH && byteIndex < data.length; byteIndex += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      if (data[byteIndex] & (0x80 >> bit)) supported.push(base + byteIndex * 8 + bit + 1);
    }
  }
  return supported;
}
