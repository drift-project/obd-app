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

/** The unit of a signal, from the end of its column name: speed_kmh and ground_kmh are both km/h. */
export function unitOf(column) {
  const at = column.lastIndexOf('_');
  return at < 0 ? column : column.slice(at + 1);
}

/**
 * The value range each signal of a chart is drawn in: `signals` are
 * `[{ column, min, max }]`. Signals of one unit share one range, so that
 * they can be compared on the chart; signals of different units each keep
 * their own.
 */
export function chartRanges(signals) {
  const shared = signals.length > 1 && signals.every(({ column }) => unitOf(column) === unitOf(signals[0].column));
  if (!shared) return signals.map(({ min, max }) => ({ min, max, shared: false }));
  const min = Math.min(...signals.map((signal) => signal.min));
  const max = Math.max(...signals.map((signal) => signal.max));
  return signals.map(() => ({ min, max, shared: true }));
}

/** The colours of the lines of one chart, in the order the signals were added. */
export const SERIES_COLORS = ['rgb(66, 186, 255)', 'rgb(255, 181, 71)', 'rgb(61, 220, 132)', 'rgb(255, 111, 181)'];

/**
 * One or more signals drawn over time, each line in its own colour, with a
 * cursor at the replay position. The lines are redrawn only when the window
 * of time changes; in between only the cursor moves.
 */
export class SignalChart {
  #marks = svg('g', { class: 'chart-marks' });
  #lines = [];
  #plot;
  #cursor = svg('line', { class: 'chart-cursor', x1: 0, x2: 0, y1: 0, y2: HEIGHT });
  #rows = [];
  #high = node('div', 'chart-scale-top');
  #low = node('div', 'chart-scale-bottom');
  #ranges = [];
  #from = 0;
  #to = 1;

  /**
   * `series` (`[{ name, source }]`) label the signals. `onRemove(index)` is
   * called by the button that takes one of them away, `onSeek(share)` by a
   * tap on the plot, with the tapped place as a share of its width from 0
   * to 1. `choices()` gives the signals that could be added, as `[{ label,
   * options: [{ id, name }] }]`, and `onAdd(id)` adds one.
   */
  constructor({ series, onRemove, onSeek, choices, onAdd }) {
    this.element = node('div', 'chart');
    const heads = node('div', 'chart-heads');
    series.forEach(({ name, source }, index) => {
      const color = SERIES_COLORS[index % SERIES_COLORS.length];
      const row = node('div', 'chart-head');
      const swatch = node('span', 'chart-swatch');
      swatch.style.background = color;
      const value = node('strong', 'chart-value', '--');
      value.style.color = color;
      const remove = node('button', 'chart-remove', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${name}`);
      remove.addEventListener('click', () => onRemove(index));
      row.append(swatch, node('span', 'chart-name', name), node('span', 'chart-source', source), value, remove);
      heads.append(row);
      this.#rows.push(value);
      const line = svg('path', { class: 'chart-line', d: '' });
      const dots = svg('path', { class: 'chart-dots', d: '' });
      line.style.stroke = color;
      dots.style.stroke = color;
      this.#lines.push({ line, dots });
    });
    // Another signal on this chart: a list of them takes the place of the button until one is picked.
    const add = node('button', 'chart-add', '+');
    add.type = 'button';
    add.setAttribute('aria-label', 'Add a signal to this chart');
    add.addEventListener('click', () => {
      const pick = document.createElement('select');
      pick.className = 'chart-pick';
      pick.setAttribute('aria-label', 'Signal to add to this chart');
      const first = document.createElement('option');
      first.value = '';
      first.textContent = 'Add to this chart…';
      pick.append(first);
      for (const { label, options } of choices()) {
        const group = document.createElement('optgroup');
        group.label = label;
        for (const { id, name } of options) {
          const option = document.createElement('option');
          option.value = id;
          option.textContent = name;
          group.append(option);
        }
        pick.append(group);
      }
      pick.addEventListener('change', () => {
        if (pick.value) onAdd(pick.value);
        else pick.replaceWith(add);
      });
      pick.addEventListener('blur', () => {
        if (pick.isConnected && !pick.value) pick.replaceWith(add);
      });
      add.replaceWith(pick);
      pick.focus();
    });
    const firstRow = heads.firstChild;
    firstRow.insertBefore(add, firstRow.querySelector('.chart-remove'));
    const plot = svg('svg', { class: 'chart-plot', viewBox: `0 0 ${WIDTH} ${HEIGHT}`, preserveAspectRatio: 'none' });
    plot.append(this.#marks, ...this.#lines.flatMap(({ line, dots }) => [line, dots]), this.#cursor);
    this.#plot = plot;
    plot.addEventListener('click', (event) => {
      const box = plot.getBoundingClientRect();
      if (box.width > 0) onSeek(Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1));
    });
    const scale = node('div', 'chart-scale');
    scale.append(this.#high, this.#low);
    const body = node('div', 'chart-body');
    body.append(plot, scale);
    this.element.append(heads, body);
  }

  /**
   * Draw the window `from` to `to`. `lines` hold for each signal its `points`
   * ([[time, value], ...]), the `min` and `max` it is drawn between (the
   * whole range of the signal, or of all signals of its unit on this chart,
   * so the scale stays put from one window to the next) and `exact`: the
   * points are the measurements themselves, not thinned out for drawing, so
   * each gets a dot where they stand far enough apart. `breaks` are the
   * times where the lines are interrupted and `marks` (`[{ from, to, kind
   * }]`) stretches of time shaded behind them.
   */
  draw(lines, from, to, breaks = [], marks = []) {
    this.#from = from;
    this.#to = to;
    this.#ranges = lines.map(({ min, max }) => ({ min, max }));
    this.#marks.replaceChildren(
      ...markBoxes(marks, from, to).map(({ x, width, kind }) =>
        svg('rect', { class: `chart-mark chart-mark-${kind}`, x: x.toFixed(1), y: 0, width: Math.max(width, 2).toFixed(1), height: HEIGHT }),
      ),
    );
    const room = this.#plot.clientWidth || 300;
    lines.forEach(({ points, min, max, exact }, index) => {
      const { line, dots } = this.#lines[index];
      line.setAttribute('d', plotPath(points, from, to, min, max, breaks));
      const inside = points.filter(([time]) => time >= from && time <= to);
      const spacing = room / Math.max(inside.length, 1);
      const shown = exact && spacing >= DOT_SPACING_PX;
      dots.setAttribute('d', shown ? plotDots(inside, from, to, min, max) : '');
      if (shown) dots.style.strokeWidth = `${Math.min(DOT_PX, Math.max(2.5, spacing * 0.9)).toFixed(1)}px`;
    });
    // The scale: one pair of numbers where the signals share their range, else one pair for each in its colour.
    const shared = lines.length > 1 && lines.every(({ min, max }) => min === lines[0].min && max === lines[0].max);
    const labels = (pick) =>
      (shared ? [lines[0]] : lines).map((line, index) => {
        const label = node('span', '', pick(line));
        if (!shared && lines.length > 1) label.style.color = SERIES_COLORS[index % SERIES_COLORS.length];
        return label;
      });
    this.#high.replaceChildren(...labels(({ min, max }) => formatValue(max, min, max)));
    this.#low.replaceChildren(...labels(({ min, max }) => (max > min ? formatValue(min, min, max) : '')));
  }

  /** Put the cursor at `time` and show the value of each signal there (null when it has none). */
  cursor(time, values) {
    const x = (((time - this.#from) / (this.#to - this.#from || 1)) * WIDTH).toFixed(1);
    if (this.#cursor.getAttribute('x1') !== x) {
      this.#cursor.setAttribute('x1', x);
      this.#cursor.setAttribute('x2', x);
    }
    values.forEach((value, index) => {
      const range = this.#ranges[index] ?? { min: 0, max: 1 };
      const text = formatValue(value, range.min, range.max);
      if (this.#rows[index] && this.#rows[index].textContent !== text) this.#rows[index].textContent = text;
    });
  }
}
