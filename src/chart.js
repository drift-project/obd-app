// One signal drawn over time in the replay view, with a cursor at the
// replay position. The line is redrawn only when the window of time changes;
// in between only the cursor moves.

const SVG = 'http://www.w3.org/2000/svg';
const WIDTH = 1000; // the plot's own units; the picture is stretched to the box
const HEIGHT = 100;
const MARGIN = 6; // room above the highest and below the lowest value

function node(name, className, text = '') {
  const element = document.createElement(name);
  element.className = className;
  element.textContent = text;
  return element;
}

function svg(name, attributes) {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

/** A number with as many decimals as its range needs: 3456, 78.5, 0.123. */
export function formatValue(value, min, max) {
  if (value === null || !Number.isFinite(value)) return '--';
  const range = Math.abs(max - min);
  // A signal that never changes is written as it is, without a row of zeros.
  if (!(range > 0)) return String(Number(value.toFixed(3)));
  const digits = range >= 100 ? 0 : range >= 10 ? 1 : range >= 1 ? 2 : range >= 0.01 ? 3 : 5;
  return value.toFixed(digits);
}

/**
 * The line through `points` ([[time, value], ...] in order of time) as the
 * `d` of an SVG path, for the window `from` to `to` and the value range `min`
 * to `max`. The line is interrupted at every time in `breaks` (sorted), which
 * is where the recording continued after a pause. A point on its own is drawn
 * as a dot.
 */
export function plotPath(points, from, to, min, max, breaks = []) {
  const span = to - from || 1;
  const range = max - min;
  let path = '';
  let next = 0; // the break the line has not reached yet
  let alone = false; // the piece being drawn has one point so far
  for (const [time, value] of points) {
    const x = (((time - from) / span) * WIDTH).toFixed(1);
    // A signal that never changes runs through the middle.
    const share = range > 0 ? (value - min) / range : 0.5;
    const y = (HEIGHT - MARGIN - share * (HEIGHT - 2 * MARGIN)).toFixed(1);
    let fresh = path === '';
    while (next < breaks.length && time >= breaks[next]) {
      next += 1;
      fresh = true;
    }
    if (fresh) {
      path += `${alone ? 'h0' : ''}M${x},${y}`;
      alone = true;
    } else {
      path += `L${x},${y}`;
      alone = false;
    }
  }
  return alone ? `${path}h0` : path;
}

/**
 * Where marked stretches of time go in the plot: `marks` are `[{ from, to,
 * kind }]` and the result `[{ x, width, kind }]` for the window `from` to
 * `to`, cut off at its edges, without the marks that lie outside it.
 */
export function markBoxes(marks, from, to) {
  const span = to - from || 1;
  const boxes = [];
  for (const mark of marks) {
    const left = Math.max(mark.from, from);
    const right = Math.min(mark.to, to);
    if (right <= left) continue;
    boxes.push({ x: ((left - from) / span) * WIDTH, width: ((right - left) / span) * WIDTH, kind: mark.kind });
  }
  return boxes;
}

/**
 * A dot at every point, as the `d` of an SVG path drawn with round line ends
 * and a stroke that is not stretched with the plot: each point is a line of
 * no length, which such a stroke shows as a round dot.
 */
export function plotDots(points, from, to, min, max) {
  // The same places as the line goes through: a line from a point to itself.
  return points.map((point) => plotPath([point], from, to, min, max)).join('');
}

// Dots are drawn while they stand apart, at least this many pixels of plot per point, and smaller where they
// stand closer.
const DOT_SPACING_PX = 3;
const DOT_PX = 4.5;

export class SignalChart {
  #marks = svg('g', { class: 'chart-marks' });
  #line = svg('path', { class: 'chart-line', d: '' });
  #dots = svg('path', { class: 'chart-dots', d: '' });
  #plot;
  #cursor = svg('line', { class: 'chart-cursor', x1: 0, x2: 0, y1: 0, y2: HEIGHT });
  #value = node('strong', 'chart-value', '--');
  #high = node('span', '', '');
  #low = node('span', '', '');
  #from = 0;
  #to = 1;
  #min = 0;
  #max = 1;

  /**
   * `name` and `source` label the signal. `onRemove()` is called by the
   * button that takes the chart away, `onSeek(share)` by a tap on the plot,
   * with the tapped place as a share of its width from 0 to 1.
   */
  constructor({ name, source, onRemove, onSeek }) {
    this.element = node('div', 'chart');
    const head = node('div', 'chart-head');
    const remove = node('button', 'chart-remove', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.addEventListener('click', onRemove);
    head.append(node('span', 'chart-name', name), node('span', 'chart-source', source), this.#value, remove);
    const plot = svg('svg', { class: 'chart-plot', viewBox: `0 0 ${WIDTH} ${HEIGHT}`, preserveAspectRatio: 'none' });
    plot.append(this.#marks, this.#line, this.#dots, this.#cursor);
    this.#plot = plot;
    plot.addEventListener('click', (event) => {
      const box = plot.getBoundingClientRect();
      if (box.width > 0) onSeek(Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1));
    });
    const scale = node('div', 'chart-scale');
    scale.append(this.#high, this.#low);
    const body = node('div', 'chart-body');
    body.append(plot, scale);
    this.element.append(head, body);
  }

  /**
   * Draw `points` ([[time, value], ...]) for the window `from` to `to`. `min`
   * and `max` are the signal's whole range, so the scale stays put from one
   * window to the next. `breaks` are the times where the line is interrupted
   * and `marks` (`[{ from, to, kind }]`) stretches of time shaded behind it.
   * `exact` says that the points are the measurements themselves, not thinned
   * out for drawing: then each gets a dot where they stand far enough apart.
   */
  draw(points, from, to, min, max, breaks = [], marks = [], { exact = false } = {}) {
    this.#from = from;
    this.#to = to;
    this.#min = min;
    this.#max = max;
    this.#marks.replaceChildren(
      ...markBoxes(marks, from, to).map(({ x, width, kind }) =>
        svg('rect', { class: `chart-mark chart-mark-${kind}`, x: x.toFixed(1), y: 0, width: Math.max(width, 2).toFixed(1), height: HEIGHT }),
      ),
    );
    this.#line.setAttribute('d', plotPath(points, from, to, min, max, breaks));
    const room = this.#plot.clientWidth || 300;
    const inside = points.filter(([time]) => time >= from && time <= to);
    const spacing = room / Math.max(inside.length, 1);
    const dots = exact && spacing >= DOT_SPACING_PX;
    this.#dots.setAttribute('d', dots ? plotDots(inside, from, to, min, max) : '');
    if (dots) this.#dots.style.strokeWidth = `${Math.min(DOT_PX, Math.max(2.5, spacing * 0.9)).toFixed(1)}px`;
    this.#high.textContent = formatValue(max, min, max);
    this.#low.textContent = max > min ? formatValue(min, min, max) : '';
  }

  /** Put the cursor at `time` and show the value there (null when there is none). */
  cursor(time, value) {
    const x = (((time - this.#from) / (this.#to - this.#from || 1)) * WIDTH).toFixed(1);
    if (this.#cursor.getAttribute('x1') !== x) {
      this.#cursor.setAttribute('x1', x);
      this.#cursor.setAttribute('x2', x);
    }
    const text = formatValue(value, this.#min, this.#max);
    if (this.#value.textContent !== text) this.#value.textContent = text;
  }
}
