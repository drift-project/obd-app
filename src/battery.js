// How charged the car battery is, judged by its voltage.
//
// A 12 V lead-acid battery that has rested shows its charge in its voltage:
// about 12.6 V when full and 11.8 V when empty for a standard (flooded) one.
// The adapter measures the voltage at the diagnostic socket, which is the
// battery's. With the engine off that tells the charge, while the starter
// turns it tells how well the battery holds up, and with the engine running
// it tells whether the alternator charges.
//
// It is an estimate, not a measurement. The ignition is on while the
// voltage is read, which pulls it down a little; a battery that was charged
// in the last hours reads high; and the voltmeter of a cheap adapter can be
// off by a tenth of a volt or two. A tenth of a volt is about twelve percent
// of charge.

/** Volts of a rested battery and the charge in percent they stand for, lowest first. */
export const BATTERY_TYPES = {
  // Battery Council International: full at 12.6 V, 0.2 V less for every quarter.
  flooded: [
    [11.8, 0],
    [12.0, 25],
    [12.2, 50],
    [12.4, 75],
    [12.6, 100],
  ],
  // Trojan's figures for its AGM batteries, which sit about 0.2 V higher when full.
  agm: [
    [11.64, 0],
    [11.94, 25],
    [12.24, 50],
    [12.54, 75],
    [12.84, 100],
  ],
};

/** Charge in percent, 0 to 100, of a rested battery that shows `volts`; null without a voltage. */
export function chargePercent(volts, type = 'flooded') {
  if (!Number.isFinite(volts)) return null;
  const table = BATTERY_TYPES[type] ?? BATTERY_TYPES.flooded;
  if (volts <= table[0][0]) return 0;
  for (let index = 1; index < table.length; index += 1) {
    const [low, lowPercent] = table[index - 1];
    const [high, highPercent] = table[index];
    if (volts <= high) return lowPercent + ((volts - low) / (high - low)) * (highPercent - lowPercent);
  }
  return 100;
}

/**
 * What the voltage with the engine running says about charging: 'normal',
 * 'weak' (the alternator does not keep up: heavy load at idle, or a battery
 * that takes all it can get), 'not charging' (battery voltage only: the
 * alternator or its belt) or 'too high' (the regulator).
 */
export function chargingVerdict(volts) {
  if (!Number.isFinite(volts)) return null;
  if (volts < 13.0) return 'not charging';
  if (volts < 13.6) return 'weak';
  if (volts <= 14.9) return 'normal';
  return 'too high';
}

export const RUNNING_RPM = 400; // the starter turns the engine at 200 to 300
const KEEP = 12; // readings kept for each state
const SETTLE_MS = 10000; // after the start the alternator needs a moment
const START_WINDOW_MS = 6000; // readings this long before the engine fired belong to the start
const DIP_VOLTS = 0.5; // a drop below the resting voltage that counts as the starter

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const lastVolts = (readings, count) => readings.slice(-count).map(([, volts]) => volts);

/**
 * Follows the battery through a session. Feed it every voltage reading with
 * the engine speed of that moment; ask it for what it has seen.
 */
export class BatteryMonitor {
  #off = []; // [time, volts] with the engine off
  #on = []; // [time, volts] with the engine running
  #running = false;
  #hasRun = false;
  #startedAt = null;
  #beforeStart = null; // resting voltage frozen when the engine was started
  #lowest = null; // lowest voltage seen while the starter turned
  #latest = null;

  /** A reading of `volts` at `time` (ms); `rpm` is the engine speed then, or null when it is not known. */
  add(time, volts, rpm) {
    if (!Number.isFinite(volts)) return;
    this.#latest = volts;
    if (typeof rpm !== 'number') return;
    const running = rpm >= RUNNING_RPM;
    if (running && !this.#running) this.#started(time);
    this.#running = running;
    const readings = running ? this.#on : this.#off;
    readings.push([time, volts]);
    if (readings.length > KEEP) readings.shift();
  }

  #started(time) {
    this.#startedAt = time;
    this.#on = [];
    // The starter pulls the last readings down, for several of them if the engine is slow to fire.
    // The higher half of the recent readings is the battery at rest.
    const recent = lastVolts(this.#off, 8).sort((a, b) => b - a);
    const resting = median(recent.slice(0, Math.ceil(recent.length / 2)));
    // Only the first start of a session has a rested battery behind it.
    if (resting !== null && !this.#hasRun) {
      this.#beforeStart = resting;
      const during = this.#off.filter(([at]) => at >= time - START_WINDOW_MS).map(([, volts]) => volts);
      const lowest = Math.min(...during);
      this.#lowest = during.length && lowest <= resting - DIP_VOLTS ? lowest : null;
    }
    this.#hasRun = true;
  }

  /**
   * What the session has shown so far, voltages in volts:
   * `latest`, the newest reading;
   * `rest`, the voltage with the engine off and `afterDriving` when it was
   * taken after the engine had run, so it reads high;
   * `starting`, the lowest voltage while the starter turned, if a reading
   * caught it;
   * `charging`, the voltage with the engine running, once it has settled;
   * `running`, whether the engine runs now.
   * Each is null when it has not been seen.
   */
  summary() {
    const live = median(lastVolts(this.#off, 5));
    let rest = null;
    if (this.#beforeStart !== null) rest = { volts: this.#beforeStart, afterDriving: false };
    else if (live !== null) rest = { volts: live, afterDriving: this.#hasRun };
    const settled = this.#on.filter(([at]) => at >= this.#startedAt + SETTLE_MS);
    return {
      latest: this.#latest,
      rest,
      starting: this.#lowest,
      charging: median(lastVolts(settled, 5)),
      running: this.#running,
    };
  }
}
