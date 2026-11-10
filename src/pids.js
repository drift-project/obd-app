// OBD-II mode 01 PIDs read by the app (SAE J1979) and their decoders.
//
// The first ten columns are the PIDs, field names and column order of
// OBDPids.py in raspberry-unicore, so a CSV from the phone and one from the
// Raspberry logger start alike. The temperatures after them are read only
// where the car reports them. Brake pressure and steering angle are not
// standard mode 01 PIDs.

const percent = (d) => Math.round((d[0] * 1000) / 255) / 10;
const temperature = (d) => d[0] - 40;
// Fuel trim: 128 is none, below takes fuel away, above adds it.
const trim = (byte) => Math.round(((byte - 128) * 1000) / 128) / 10;
// An oxygen sensor: its voltage, and the fuel trim it asks for (255: the sensor is not used for trim).
const oxygen = (d) => ({ volts: d[0] / 200, trim: d[1] === 0xff ? null : trim(d[1]) });

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
  // Read only for diagnostics; one answer can hold several values, which DIAG_FIELDS take apart.
  [0x01, { length: 4, decode: (d) => ({ mil: d[0] >> 7, codes: d[0] & 0x7f }) }],
  [0x03, { length: 2, decode: (d) => ({ first: d[0], second: d[1] }) }],
  [0x06, { length: 1, decode: (d) => trim(d[0]) }],
  [0x07, { length: 1, decode: (d) => trim(d[0]) }],
  [0x08, { length: 1, decode: (d) => trim(d[0]) }],
  [0x09, { length: 1, decode: (d) => trim(d[0]) }],
  [0x0a, { length: 1, decode: (d) => 3 * d[0] }],
  [0x0e, { length: 1, decode: (d) => d[0] / 2 - 64 }],
  [0x12, { length: 1, decode: (d) => d[0] }],
  ...[0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b].map((pid) => [pid, { length: 2, decode: oxygen }]),
  [0x1c, { length: 1, decode: (d) => d[0] }],
  [0x1f, { length: 2, decode: (d) => 256 * d[0] + d[1] }],
  [0x21, { length: 2, decode: (d) => 256 * d[0] + d[1] }],
  [0x2f, { length: 1, decode: percent }],
  [0x31, { length: 2, decode: (d) => 256 * d[0] + d[1] }],
  [0x33, { length: 1, decode: (d) => d[0] }],
]);

// Supported-PID bitmaps: 0x00 covers 0x01-0x20, 0x20 covers 0x21-0x40, and so on.
export const SUPPORT_PIDS = [0x00, 0x20, 0x40, 0x60];
export const SUPPORT_LENGTH = 4;

// Polled every cycle: what the driver does and what the car answers with.
export const FAST_PIDS = [0x0c, 0x0d, 0x11, 0x49];
// Polled one at a time, round robin, at most once per slow interval.
export const SLOW_PIDS = [0x04, 0x05, 0x0f, 0x10, 0x0b, 0x5c, 0x46, 0x3c];

// The supply voltage is not a PID: the adapter measures it itself.
export const VOLTAGE_FIELD = 'battery_v';

const FUEL_SYSTEM = {
  1: 'open loop: engine still cold',
  2: 'closed loop: oxygen sensors in use',
  4: 'open loop: load or fuel cut',
  8: 'open loop: a fault',
  16: 'closed loop: a sensor is faulty',
};
const SECONDARY_AIR = { 1: 'before the catalyst', 2: 'after the catalyst', 4: 'from outside, or off', 8: 'pump on for a test' };
const STANDARD = { 1: 'OBD-II (California)', 2: 'OBD (federal)', 3: 'OBD and OBD-II', 6: 'EOBD (Europe)', 7: 'EOBD and OBD-II', 9: 'EOBD, OBD and OBD-II' };

/**
 * The values of the diagnostic mode, in their column order: the column
 * name, the PID it is read from and how it is taken out of the answer, with a
 * label and a unit for the screen and words for the codes.
 */
export const DIAG_FIELDS = [
  { name: 'mil_on', pid: 0x01, part: (v) => v.mil, label: 'Check engine light', words: (v) => (v ? 'ON' : 'off') },
  { name: 'trouble_codes', pid: 0x01, part: (v) => v.codes, label: 'Stored trouble codes' },
  { name: 'fuel_system_1', pid: 0x03, part: (v) => v.first, label: 'Fuel system 1', words: (v) => FUEL_SYSTEM[v] ?? (v ? `code ${v}` : 'not present') },
  { name: 'fuel_system_2', pid: 0x03, part: (v) => v.second, label: 'Fuel system 2', words: (v) => FUEL_SYSTEM[v] ?? (v ? `code ${v}` : 'not present') },
  { name: 'stft_b1_pct', pid: 0x06, label: 'Short-term fuel trim, bank 1', unit: '%' },
  { name: 'ltft_b1_pct', pid: 0x07, label: 'Long-term fuel trim, bank 1', unit: '%' },
  { name: 'stft_b2_pct', pid: 0x08, label: 'Short-term fuel trim, bank 2', unit: '%' },
  { name: 'ltft_b2_pct', pid: 0x09, label: 'Long-term fuel trim, bank 2', unit: '%' },
  { name: 'timing_deg', pid: 0x0e, label: 'Ignition timing advance', unit: '°' },
  ...[
    [0x14, 'b1s1', 'bank 1, sensor 1'],
    [0x15, 'b1s2', 'bank 1, sensor 2'],
    [0x16, 'b1s3', 'bank 1, sensor 3'],
    [0x17, 'b1s4', 'bank 1, sensor 4'],
    [0x18, 'b2s1', 'bank 2, sensor 1'],
    [0x19, 'b2s2', 'bank 2, sensor 2'],
    [0x1a, 'b2s3', 'bank 2, sensor 3'],
    [0x1b, 'b2s4', 'bank 2, sensor 4'],
  ].flatMap(([pid, short, where]) => [
    { name: `o2_${short}_v`, pid, part: (v) => v.volts, label: `Oxygen sensor ${where}`, unit: 'V' },
    { name: `o2_${short}_trim_pct`, pid, part: (v) => v.trim, label: `Trim from oxygen sensor ${where}`, unit: '%' },
  ]),
  { name: 'secondary_air', pid: 0x12, label: 'Secondary air', words: (v) => SECONDARY_AIR[v] ?? `code ${v}` },
  { name: 'fuel_pressure_kpa', pid: 0x0a, label: 'Fuel pressure', unit: 'kPa' },
  { name: 'fuel_level_pct', pid: 0x2f, label: 'Fuel level', unit: '%' },
  { name: 'barometric_kpa', pid: 0x33, label: 'Air pressure', unit: 'kPa' },
  { name: 'run_time_s', pid: 0x1f, label: 'Running since the start', unit: 's' },
  { name: 'distance_mil_km', pid: 0x21, label: 'Driven with the light on', unit: 'km' },
  { name: 'distance_cleared_km', pid: 0x31, label: 'Driven since codes were cleared', unit: 'km' },
  { name: 'obd_standard', pid: 0x1c, label: 'OBD standard', words: (v) => STANDARD[v] ?? `code ${v}` },
];

/** The PIDs the diagnostic mode reads, each once, in the order of DIAG_FIELDS. */
export const DIAG_PIDS = [...new Set(DIAG_FIELDS.map(({ pid }) => pid))];

/** The value of a diagnostic column from the values read, or null. */
export function diagValue(field, values) {
  if (!values.has(field.pid)) return null;
  const value = values.get(field.pid);
  const part = field.part ? field.part(value) : value;
  return typeof part === 'number' && Number.isFinite(part) ? part : null;
}

// Fixed column order of logged rows. A value is null when the car does not
// support the PID or it was not polled in that cycle. The diagnostic values
// come after the voltage, so the columns before stay where they were.
export const FIELDS = [
  'timestamp_ms',
  ...[...FAST_PIDS, ...SLOW_PIDS].map((pid) => PIDS.get(pid).name),
  VOLTAGE_FIELD,
  ...DIAG_FIELDS.map(({ name }) => name),
];

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
