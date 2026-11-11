// Where the car was pushed, on one circle (a g-g diagram): the acceleration
// along the car, up for speeding up and down for braking, and across it, to
// the right or to the left, in g. The dots are the time the charts show, in
// the colour of the drift angle as on the map; the moment of the replay is
// the big dot, with a tail of the second before it.
//
// The car's own directions are used, not those of its path. In a drift the
// car points into the corner, so the push that bends its path leans towards
// "speeding up" on this circle: drifting shows as dots off to the front.

import { angleShade, shadeColor } from './map.js';

const SVG = 'http://www.w3.org/2000/svg';
export const G = 9.80665;
const SIZE = 240; // the plot's own units, a square
const MIDDLE = SIZE / 2;
const SCALE = 100; // units per g
const EDGE_G = 1.15; // a push beyond this is drawn on the edge, in its direction
const RINGS = [0.5, 1];
export const TAIL_MS = 1000;
const IDS = ['drift.ahead_ms2', 'drift.right_ms2'];

function svg(name, attributes = {}, text = '') {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text) element.textContent = text;
  return element;
}

/** Whether `recording` knows the acceleration of the car. */
export const hasGrip = (recording) => IDS.every((id) => recording.has(id));

/** Plot units for an acceleration `ahead` and `right` in m/s²: x to the right, y down the picture. */
export function toPlot(ahead, right) {
  let x = right / G;
  let y = ahead / G;
  const size = Math.hypot(x, y);
  if (size > EDGE_G) {
    x = (x / size) * EDGE_G;
    y = (y / size) * EDGE_G;
  }
  return [MIDDLE + x * SCALE, MIDDLE - y * SCALE];
}

/**
 * The acceleration of the car from `from` to `to`: `[{ time, ahead, right, angle }]` in m/s² with the drift
 * angle of the moment in degrees (null where it is not known), one for each row of the drift stream.
 */
export function gripPoints(recording, from, to) {
  const { times, values } = recording.series(IDS[0]);
  // The first row at or after `from`: this runs on every frame of a replay.
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (times[middle] < from) low = middle + 1;
    else high = middle;
  }
  const points = [];
  for (let index = low; index < times.length; index += 1) {
    const time = times[index];
    if (time > to) break;
    const right = recording.value(IDS[1], time, 0);
    if (!Number.isFinite(right) || !Number.isFinite(values[index])) continue;
    points.push({ time, ahead: values[index], right, angle: recording.value('drift.drift_angle_deg', time, 0) });
  }
  return points;
}

/** The largest total acceleration of `points` in g, or null without any. */
export function mostGrip(points) {
  return points.reduce((most, { ahead, right }) => Math.max(most ?? 0, Math.hypot(ahead, right) / G), null);
}

const grams = (value) => (Math.abs(value) / G).toFixed(2);

/** The acceleration of one moment in words: "0.42 g: 0.31 g right, 0.28 g speeding up". */
export function gripText(ahead, right) {
  if (ahead === null || right === null) return 'No acceleration at this moment';
  const total = Math.hypot(ahead, right);
  return `${grams(total)} g: ${grams(right)} g ${right >= 0 ? 'right' : 'left'}, ${grams(ahead)} g ${ahead >= 0 ? 'speeding up' : 'braking'}`;
}

/** The dots of `points` as one path of dots for each shade of the drift angle: `Map(shade -> d)`. */
export function dotPaths(points) {
  const paths = new Map();
  for (const { ahead, right, angle } of points) {
    const [x, y] = toPlot(ahead, right);
    const shade = angleShade(angle);
    paths.set(shade, `${paths.get(shade) ?? ''}M${x.toFixed(1)},${y.toFixed(1)}h0`);
  }
  return paths;
}

export class GripChart {
  #dots;
  #tail;
  #now;
  #readout;
  #most;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'grip';
    const plot = svg('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, class: 'grip-plot', role: 'img', 'aria-label': 'Acceleration of the car: along it up and down, across it left and right' });
    for (const ring of RINGS) {
      plot.append(svg('circle', { cx: MIDDLE, cy: MIDDLE, r: ring * SCALE, class: 'grip-ring' }));
      const corner = MIDDLE + ring * SCALE * Math.SQRT1_2;
      plot.append(svg('text', { x: corner + 3, y: corner + 11, class: 'grip-scale' }, `${ring} g`));
    }
    plot.append(
      svg('line', { x1: 6, y1: MIDDLE, x2: SIZE - 6, y2: MIDDLE, class: 'grip-axis' }),
      svg('line', { x1: MIDDLE, y1: 18, x2: MIDDLE, y2: SIZE - 18, class: 'grip-axis' }),
      svg('text', { x: MIDDLE, y: 12, 'text-anchor': 'middle', class: 'grip-label' }, 'speeding up'),
      svg('text', { x: MIDDLE, y: SIZE - 4, 'text-anchor': 'middle', class: 'grip-label' }, 'braking'),
      svg('text', { x: 4, y: MIDDLE - 5, class: 'grip-label' }, 'left'),
      svg('text', { x: SIZE - 4, y: MIDDLE - 5, 'text-anchor': 'end', class: 'grip-label' }, 'right'),
    );
    this.#dots = svg('g', { class: 'grip-dots' });
    this.#tail = svg('polyline', { class: 'grip-tail', points: '' });
    this.#now = svg('circle', { r: 6.5, class: 'grip-now', visibility: 'hidden' });
    plot.append(this.#dots, this.#tail, this.#now);
    this.#readout = document.createElement('p');
    this.#readout.className = 'grip-readout';
    this.#most = document.createElement('p');
    this.#most.className = 'grip-most';
    this.element.append(plot, this.#readout, this.#most);
  }

  /** Draw the dots of a window of time: `points` from gripPoints(). */
  draw(points) {
    const paths = [...dotPaths(points)].sort(([a], [b]) => a - b);
    this.#dots.replaceChildren(...paths.map(([shade, d]) => svg('path', { d, stroke: shadeColor(shade) })));
    const most = mostGrip(points);
    this.#most.textContent = most === null ? 'No acceleration in this stretch.' : `Most in this stretch: ${most.toFixed(2)} g`;
  }

  /** Show the moment of the replay: `now` ({ ahead, right, angle } or null) and the `tail` before it. */
  cursor(now, tail = []) {
    this.#tail.setAttribute('points', tail.map(({ ahead, right }) => toPlot(ahead, right).map((value) => value.toFixed(1)).join(',')).join(' '));
    if (!now) {
      this.#now.setAttribute('visibility', 'hidden');
      this.#readout.textContent = gripText(null, null);
      return;
    }
    const [x, y] = toPlot(now.ahead, now.right);
    this.#now.setAttribute('cx', x.toFixed(1));
    this.#now.setAttribute('cy', y.toFixed(1));
    this.#now.setAttribute('fill', shadeColor(angleShade(now.angle)));
    this.#now.setAttribute('visibility', 'visible');
    this.#readout.textContent = gripText(now.ahead, now.right);
  }
}
