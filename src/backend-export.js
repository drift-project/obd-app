// A recording in the form the team's backend imports.
//
// The backend (repository drifthing, `manage.py csvimport --file ... --commit`)
// reads a CSV with the columns timestamp, location, speed_kmh, drift_angle,
// acceleration_g and direction into the telemetry points of one race log:
// the time as ISO 8601, the place as WKT "POINT(longitude latitude)" in WGS 84,
// the speed in km/h, the drift angle in degrees, the acceleration in g and
// the direction as a compass bearing.
//
// The rows are those of the drift stream, ten a second. Where the drift
// angle is not known (before the car has driven straight once, or after the
// phone was moved) there is no row: every column of the backend must have a
// value, and a made-up zero would read as driving straight.

const G = 9.80665;
const HOLD_MS = 1500;

/**
 * The CSV text for the backend. `recording` is the replayed recording with
 * its drift stream worked out, `track` its smoothed GPS track (SmoothTrack)
 * and `lateMs` how long after the car was somewhere GPS reports it.
 */
export function backendCsv(recording, track, { lateMs = 0 } = {}) {
  const lines = ['timestamp,location,speed_kmh,drift_angle,acceleration_g,direction'];
  if (!track) return `${lines.join('\n')}\n`;
  const { times } = recording.series('drift.drift_angle_deg');
  for (const time of times) {
    const angle = recording.interpolateAngle('drift.drift_angle_deg', time, HOLD_MS);
    const at = track.at(time + lateMs);
    if (angle === null || !at || at.course === null) continue;
    // Braking, speeding up and cornering together: the change of the velocity GPS measured, over about a second.
    const acceleration = (track.acceleration(time + lateMs) ?? 0) / G;
    // The car points along the line turned by the drift angle, as the replay shows it.
    const direction = (((at.course + angle) % 360) + 360) % 360;
    lines.push(
      [
        new Date(time).toISOString(),
        `POINT(${at.longitude.toFixed(7)} ${at.latitude.toFixed(7)})`,
        (at.speed * 3.6).toFixed(1),
        angle.toFixed(1),
        acceleration.toFixed(3),
        direction.toFixed(1),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
