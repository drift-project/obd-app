// Wheels against the ground: where the driven wheels turned faster than the
// car moved, or slower.
//
// The car reports the speed of its wheels (on a rear-wheel-drive car the
// reading follows the driven wheels) and GPS the speed over the ground. In a
// power slide the first runs away from the second; with the handbrake pulled
// it falls behind.
//
// Two things have to be taken out before the two can be compared. The car
// and GPS do not agree exactly even on a straight road (tyre size, the
// speedometer's own scale), so their ratio is measured where the car drives
// steadily. And the reading from the car is old when it arrives: on the first
// real drives it ran about half a second behind GPS, measured off the
// throttle where the wheels cannot spin.

export const WHEEL_LAG_MS = 500; // how far the car's reading runs behind GPS
const GPS_HOLD_MS = 2500;
const STEADY_MS = 1000; // GPS speed this long before and after must agree for a value to count as steady
const STEADY_MS_CHANGE = 0.6; // m/s
const MIN_STEADY_SPEED = 5; // m/s: below it one km/h of rounding is too much of the ratio
const MIN_STEADY_VALUES = 8;
const FLOOR_KMH = 10; // percentages are taken of at least this much, so walking pace does not blow them up
const SPIN_KMH = 6;
const SPIN_PCT = 15;
// Pulling away, the car's reading starts late and low, so "slower" is only believed at some speed.
const LOCK_FROM_KMH = 20;
const LOCK_KMH = -8;
const LOCK_PCT = -25;
const STRONG_PCT = 30; // a single value this far out is believed on its own
const SAME_SPAN_MS = 2500; // values further apart do not belong to one span

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * Compares the car's speed with the speed over ground through a recording.
 * Returns null when it has no car speed or no GPS speed, else:
 *
 * - `factor`: car speed divided by ground speed while the car grips, and
 *   `steady`, the number of values it was measured from (0: not measured,
 *   the factor is then 1);
 * - `columns` and `data`: a table with a row for every speed value of the
 *   car: what the car would read if the wheels gripped (`ground_kmh`), how
 *   much more it read (`excess_kmh`) and that as a share (`slip_pct`);
 * - `spans`: `[{ from, to, kind, peak }]`, the stretches where the wheels
 *   turned faster (`kind` 'spin') or slower ('lock') than the car moved, with
 *   the largest `slip_pct` in each.
 */
export function wheelSlip(recording) {
  const car = recording.series('obd.speed_kmh');
  if (!car.times.length || !recording.has('gps.speed_ms')) return null;
  const ground = (time) => recording.interpolate('gps.speed_ms', time - WHEEL_LAG_MS, GPS_HOLD_MS);

  // The ratio on steady stretches. Wheelspin on a steady stretch is rare, and the median shrugs it off.
  const ratios = [];
  for (let index = 0; index < car.times.length; index += 1) {
    const time = car.times[index];
    const now = ground(time);
    const before = ground(time - STEADY_MS);
    const after = ground(time + STEADY_MS);
    if (now === null || before === null || after === null || now < MIN_STEADY_SPEED) continue;
    if (Math.abs(after - before) > STEADY_MS_CHANGE) continue;
    ratios.push(car.values[index] / (now * 3.6));
  }
  const measured = ratios.length >= MIN_STEADY_VALUES ? median(ratios) : 1;
  // A ratio far from one is not a speedometer error: the two speeds are not the same thing at all
  // (other units, a broken sensor). Nothing is corrected then, and nothing is marked either.
  const comparable = measured > 0.8 && measured < 1.25;
  const factor = comparable ? measured : 1;

  const data = new Float64Array(car.times.length * 4);
  const kinds = [];
  for (let index = 0; index < car.times.length; index += 1) {
    const time = car.times[index];
    const speed = ground(time);
    data[index * 4] = time;
    if (speed === null) {
      data.fill(NaN, index * 4 + 1, index * 4 + 4);
      kinds.push(null);
      continue;
    }
    const expected = speed * 3.6 * factor;
    const excess = car.values[index] - expected;
    const slip = (100 * excess) / Math.max(expected, FLOOR_KMH);
    data[index * 4 + 1] = expected;
    data[index * 4 + 2] = excess;
    data[index * 4 + 3] = slip;
    if (!comparable) kinds.push(null);
    else if (excess >= SPIN_KMH && slip >= SPIN_PCT) kinds.push('spin');
    else if (expected >= LOCK_FROM_KMH && excess <= LOCK_KMH && slip <= LOCK_PCT) kinds.push('lock');
    else kinds.push(null);
  }

  // Values of one kind that follow each other make a span. It reaches half way to the neighbouring values.
  const spans = [];
  const step = car.times.length > 1 ? median(Array.from(car.times.subarray(1), (time, index) => time - car.times[index])) : 1000;
  const reach = Math.min(Math.max(step / 2, 100), 1000);
  let open = null;
  const close = () => {
    if (open && (open.count >= 2 || Math.abs(open.peak) >= STRONG_PCT)) {
      spans.push({ from: open.from - reach, to: open.to + reach, kind: open.kind, peak: open.peak });
    }
    open = null;
  };
  for (let index = 0; index < car.times.length; index += 1) {
    const kind = kinds[index];
    const time = car.times[index];
    if (open && (kind !== open.kind || time - open.to > SAME_SPAN_MS)) close();
    if (!kind) continue;
    const slip = data[index * 4 + 3];
    if (!open) open = { from: time, to: time, kind, peak: slip, count: 0 };
    open.to = time;
    open.count += 1;
    if (Math.abs(slip) > Math.abs(open.peak)) open.peak = slip;
  }
  close();

  return {
    factor,
    steady: comparable && ratios.length >= MIN_STEADY_VALUES ? ratios.length : 0,
    columns: ['timestamp_ms', 'ground_kmh', 'excess_kmh', 'slip_pct'],
    data,
    spans,
  };
}
