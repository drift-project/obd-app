// What can be worked out about the engine from what the car reports.

// Power from the air the engine takes in. A petrol engine burns a gram of
// fuel with 14.7 grams of air, a gram of petrol holds about 44 kJ, and about
// 30% of that reaches the crankshaft: 0.9 kW, or 1.2 metric horsepower, for
// every gram of air a second. It is an estimate of the power at that moment,
// good to perhaps a fifth, and says nothing of a diesel.
export const HP_PER_GRAM_PER_SECOND = 1.2;

/** Estimated engine power in metric horsepower for an air flow in grams a second. */
export const powerHp = (airFlow) => airFlow * HP_PER_GRAM_PER_SECOND;

/**
 * The power through a recording as a table for a Recording, from its air
 * flow, or null when the car did not report one.
 */
export function powerTable(recording) {
  const { times, values } = recording.series('obd.maf_gs');
  if (!times.length) return null;
  const data = new Float64Array(times.length * 2);
  for (let index = 0; index < times.length; index += 1) {
    data[index * 2] = times[index];
    data[index * 2 + 1] = powerHp(values[index]);
  }
  return { columns: ['timestamp_ms', 'power_hp'], data };
}
