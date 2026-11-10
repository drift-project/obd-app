// The replay view: a recording played back on the map, with charts of any of
// its signals over time. The recording is the log kept in this app or files
// saved or shared from it (CSV files, or the ZIP archive with all of them).

import { SignalChart } from './chart.js';
import { driftTable } from './drift-replay.js';
import { powerTable } from './engine.js';
import { Recording, parseCsv, skipGap, streamOf } from './replay.js';
import { findDrifts, summarize } from './summary.js';
import { SmoothTrack } from './track.js';
import { wheelSlip } from './wheels.js';
import { unzip } from './zip.js';

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16];
// How much time the charts show at once; 0 is the whole recording.
const WINDOWS = [
  [10000, '10 s'],
  [30000, '30 s'],
  [120000, '2 min'],
  [600000, '10 min'],
  [0, 'All'],
];
// Shown when a recording is opened for the first time, as far as it has them.
const FIRST_SIGNALS = ['drift.drift_angle_deg', 'obd.speed_kmh', 'wheels.ground_kmh', 'obd.throttle_pct', 'obd.rpm', 'gps.speed_ms'];
const STREAM_TITLES = {
  obd: 'car',
  gps: 'GPS',
  drift: 'drift view',
  drift_recorded: 'drift view, as recorded',
  wheels: 'wheels against the ground',
  engine: 'engine, estimated',
  accelerometer: 'accelerometer',
  linear_acceleration: 'acceleration, no gravity',
  gyroscope: 'gyroscope',
  magnetometer: 'magnetometer',
  orientation: 'orientation',
  relative_orientation: 'orientation, no compass',
};
const SIGNALS_KEY = 'drifthing-obd-replay-signals';
const SPEED_KEY = 'drifthing-obd-replay-speed';
const WINDOW_KEY = 'drifthing-obd-replay-window';
const TRACK_POINTS = 5000;
const POINTS_PER_CHART = 800; // a chart draws at most this many points; more are thinned keeping the peaks
const EXAMPLES = 'examples/'; // recordings that come with the app, listed in index.json there
const LEAD_IN_MS = 1500; // a tap on a drift starts the replay this much before it
// How long a value stays on screen after it was measured.
const CAR_HOLD_MS = 5000;
const DRIFT_HOLD_MS = 1500;
const GPS_HOLD_MS = 3000;
// A fix tells where the car was about half a second before it reached the app (0.45 to 0.6 s on the first real
// drives). A replay knows what came later, so the place at a moment is read from the fixes that much further on.
const GPS_LATE_MS = 500;

const decoder = new TextDecoder();
const two = (value) => String(value).padStart(2, '0');
const clock = (ms) => {
  const date = new Date(ms);
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
};
const span = (ms) => `${Math.floor(ms / 60000)}:${two(Math.floor(ms / 1000) % 60)}`;
const title = (stream) => STREAM_TITLES[stream] ?? stream;
const rounded = (value, scale = 1) => (value === null ? '--' : String(Math.round(value * scale)));

/**
 * The smoothed line through the GPS fixes of a recording. The fixes are timed by the receiver's own clock
 * (fix_ms), which spaces them evenly where their arrival may bunch up, moved onto the time line of the
 * recording by the usual delay between fix and arrival. A fix more than 50 m off is left out.
 */
function smoothGps(recording) {
  const { times, values: latitudes } = recording.series('gps.latitude_deg');
  const longitudes = recording.series('gps.longitude_deg').values;
  const exact = (id, time) => recording.value(id, time, 0);
  const delays = [];
  for (const time of times) {
    const fix = exact('gps.fix_ms', time);
    if (fix !== null && time - fix >= 0 && time - fix < 5000) delays.push(time - fix);
  }
  delays.sort((a, b) => a - b);
  const delay = delays.length ? delays[Math.floor(delays.length / 2)] : null;
  const fixes = [];
  for (let index = 0; index < Math.min(times.length, longitudes.length); index += 1) {
    const time = times[index];
    if (exact('gps.accuracy_m', time) > 50) continue;
    const fix = exact('gps.fix_ms', time);
    fixes.push({
      time: delay !== null && fix !== null && time - fix >= 0 && time - fix < 5000 ? fix + delay : time,
      latitude: latitudes[index],
      longitude: longitudes[index],
      speed: exact('gps.speed_ms', time),
      course: exact('gps.heading_deg', time),
    });
  }
  fixes.sort((a, b) => a.time - b.time);
  const track = new SmoothTrack(fixes);
  return track.empty ? null : track;
}

export class ReplayView {
  #$;
  #map;
  #logTables;
  #read;
  #write;
  #recording = null;
  #stretches = [];
  #breaks = []; // where the recording continues after a pause
  #cursor = 0;
  #playing = false;
  #speed = 1;
  #windowMs = 30000;
  #lastFrame = null;
  #page = null; // the window of time the charts are drawn for
  #panels = []; // signal ids, in the order of the charts
  #charts = new Map();
  #track = [];
  #positions = null; // the stream the position comes from
  #smooth = null; // the smoothed line through the GPS fixes, where the recording has them
  #marks = []; // stretches shaded on the charts: where the wheels turned faster or slower than the car moved
  #dragging = false;
  #shown = new Map(); // element id -> the text it shows

  /**
   * `$` finds an element by its id and `map` is the TrackMap of this view.
   * `logTables()` gives the log kept in the app as tables for a Recording.
   * `readStored` and `writeStored` keep small settings.
   */
  constructor({ $, map, logTables, readStored, writeStored }) {
    this.#$ = $;
    this.#map = map;
    this.#logTables = logTables;
    this.#read = readStored;
    this.#write = writeStored;

    const speed = Number(readStored(SPEED_KEY));
    if (SPEEDS.includes(speed)) this.#speed = speed;
    const windowMs = readStored(WINDOW_KEY);
    if (windowMs !== null && WINDOWS.some(([value]) => value === Number(windowMs))) this.#windowMs = Number(windowMs);
    this.#fill($('replay-speed'), SPEEDS.map((value) => [value, `×${value}`]), this.#speed);
    this.#fill($('replay-window'), WINDOWS, this.#windowMs);

    $('replay-log').addEventListener('click', () => this.openLog());
    $('replay-open').addEventListener('click', () => $('replay-files').click());
    $('replay-files').addEventListener('change', (event) => {
      const files = [...event.target.files];
      event.target.value = ''; // so the same file can be opened again
      if (files.length) this.openFiles(files);
    });
    $('replay-play').addEventListener('click', () => this.#play(!this.#playing));
    $('replay-speed').addEventListener('change', (event) => {
      this.#speed = Number(event.target.value);
      writeStored(SPEED_KEY, String(this.#speed));
    });
    $('replay-window').addEventListener('change', (event) => {
      this.#windowMs = Number(event.target.value);
      writeStored(WINDOW_KEY, String(this.#windowMs));
      this.#page = null;
    });
    const seek = $('replay-seek');
    seek.addEventListener('pointerdown', () => {
      this.#dragging = true;
    });
    for (const done of ['pointerup', 'pointercancel', 'change']) {
      seek.addEventListener(done, () => {
        this.#dragging = false;
      });
    }
    seek.addEventListener('input', () => this.#seek(Number(seek.value) / Number(seek.max)));
    $('replay-add').addEventListener('change', (event) => {
      if (event.target.value) this.#addPanel(event.target.value);
    });
    $('replay-examples').addEventListener('change', (event) => {
      const name = event.target.value;
      event.target.value = '';
      if (name) this.openExample(name);
    });
    this.#listExamples();
  }

  /** The recordings that come with the app. Without a connection, or without any, the list stays away. */
  async #listExamples() {
    const select = this.#$('replay-examples');
    try {
      const response = await fetch(`${EXAMPLES}index.json`);
      const examples = response.ok ? await response.json() : [];
      if (!Array.isArray(examples) || !examples.length) return;
      const first = document.createElement('option');
      first.value = '';
      first.textContent = 'Example recordings…';
      select.replaceChildren(
        first,
        ...examples.map(({ file, title }) => {
          const option = document.createElement('option');
          option.value = file;
          option.textContent = title;
          return option;
        }),
      );
      select.hidden = false;
    } catch {
      // No list, no examples: the rest of the replay does not need them.
    }
  }

  /** Replay one of the recordings that come with the app. */
  async openExample(name) {
    this.#play(false);
    this.#text('replay-info', 'Fetching the example…');
    try {
      // Only names from the list, and only out of the examples folder.
      const response = await fetch(`${EXAMPLES}${encodeURIComponent(name)}`);
      if (!response.ok) throw new Error(`the server answered ${response.status}`);
      await this.openFiles([new File([await response.blob()], name)]);
    } catch (error) {
      this.#text('replay-info', `The example could not be fetched: ${error.message}.`);
    }
  }

  #fill(select, options, chosen) {
    select.replaceChildren(
      ...options.map(([value, label]) => {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = label;
        option.selected = value === chosen;
        return option;
      }),
    );
  }

  /** Write a text to an element, and only when it changed: this runs on every frame. */
  #text(id, text) {
    if (this.#shown.get(id) === text) return;
    this.#shown.set(id, text);
    this.#$(id).textContent = text;
  }

  // Loading ---------------------------------------------------------------------

  /** Replay what the app has in its log right now. */
  openLog() {
    this.#open(this.#logTables(), 'The log in this app');
  }

  /** Replay files saved or shared from the app: CSV files, or the ZIP archive that holds them. */
  async openFiles(files) {
    const tables = [];
    const problems = [];
    const add = (name, text) => {
      const { columns, data } = parseCsv(text);
      // A file that was renamed is still the car's log if it has the car's columns.
      tables.push({ stream: columns.includes('rpm') ? 'obd' : streamOf(name), columns, data });
    };
    this.#play(false);
    this.#text('replay-info', 'Reading the files…');
    for (const file of files) {
      try {
        if (/\.zip$/i.test(file.name)) {
          for (const entry of await unzip(file)) if (/\.csv$/i.test(entry.name)) add(entry.name, decoder.decode(entry.bytes));
        } else if (/\.csv$/i.test(file.name)) {
          add(file.name, await file.text());
        } else if (!/\.txt$/i.test(file.name)) {
          // A text file is the description that travels with the CSV files: not data, and no problem either.
          problems.push(`${file.name} is not a CSV or ZIP file`);
        }
      } catch (error) {
        problems.push(`${file.name}: ${error.message}`);
      }
    }
    this.#open(tables, files.length === 1 ? files[0].name : `${files.length} files`, problems);
  }

  #open(tables, source, problems = []) {
    const $ = this.#$;
    const recorded = new Recording(tables);
    let all = tables;
    // The drift angle is worked out again from the recorded sensors, so an old log is not stuck with what its
    // version made of them. What the drive itself showed stays in the recording under another name.
    const again = recorded.empty ? null : driftTable(recorded);
    if (again) all = [...all.map((table) => (table.stream === 'drift' ? { ...table, stream: 'drift_recorded' } : table)), { stream: 'drift', ...again }];
    // The speed of the wheels against the speed over ground: its own signals, and bands on every chart.
    const wheels = recorded.empty ? null : wheelSlip(recorded);
    if (wheels) all = [...all, { stream: 'wheels', columns: wheels.columns, data: wheels.data }];
    const power = recorded.empty ? null : powerTable(recorded);
    if (power) all = [...all, { stream: 'engine', ...power }];
    const recording = all === tables ? recorded : new Recording(all);
    for (const stream of recording.skipped) problems.push(`"${stream}" has no times in milliseconds in its first column`);
    const trouble = problems.length ? ` Left out: ${problems.join('; ')}.` : '';
    this.#play(false);
    for (const chart of this.#charts.values()) chart.element.remove();
    this.#charts.clear();
    this.#panels = [];
    this.#page = null;
    if (recording.empty) {
      this.#recording = null;
      $('replay-body').hidden = true;
      this.#text('replay-info', `${source}: nothing to replay.${trouble}`);
      return;
    }
    this.#recording = recording;
    this.#stretches = recording.stretches();
    this.#breaks = this.#stretches.slice(1).map(([from]) => from);
    this.#cursor = recording.start;
    this.#marks = wheels ? wheels.spans : [];
    this.#buildTrack();
    let wanted = [];
    try {
      wanted = JSON.parse(this.#read(SIGNALS_KEY)) ?? [];
    } catch {
      // nothing chosen yet
    }
    const known = (Array.isArray(wanted) ? wanted : []).filter((id) => recording.has(id));
    for (const id of known.length ? known : FIRST_SIGNALS.filter((id) => recording.has(id)).slice(0, 4)) this.#addPanel(id, false);
    if (!this.#panels.length) this.#addPanel(recording.signals[0].id, false);
    this.#listSignals();
    const pauses = this.#breaks.length;
    const skipped = pauses > 0 ? `, ${pauses} pause${pauses > 1 ? 's' : ''} that the replay jumps over` : '';
    const reworked = again ? ' The drift angle is worked out again from the recorded sensors.' : '';
    const placeless = this.#positions === null ? ' It has no positions, so there is no map.' : '';
    this.#text(
      'replay-info',
      `${source}: ${clock(recording.start)} to ${clock(recording.end)}, ${recording.signals.length} signals${skipped}.${reworked}${placeless}${trouble}`,
    );
    this.#text('replay-marks', this.#marksText(wheels));
    const drifts = findDrifts(recording);
    this.#listDrifts(drifts);
    this.#listTotals(summarize(recording, drifts, this.#marks));
    $('replay-body').hidden = false;
    $('replay-map').hidden = this.#positions === null;
  }

  /** The drifts of the recording, one line each; a tap starts the replay just before it. */
  #listDrifts(drifts) {
    const $ = this.#$;
    $('replay-drifts').hidden = drifts.length === 0;
    this.#text('replay-drifts-title', `Drifts in this recording: ${drifts.length}`);
    $('replay-drift-list').replaceChildren(
      ...drifts.map((drift) => {
        const button = document.createElement('button');
        button.type = 'button';
        const cell = (name, content, className = '') => {
          const element = document.createElement(name);
          element.textContent = content;
          element.className = className;
          return element;
        };
        const spun = drift.slipPct !== null && drift.slipPct >= 15;
        button.append(
          cell('span', clock(drift.from)),
          cell('span', `${((drift.to - drift.from) / 1000).toFixed(1)} s`),
          cell('strong', `${Math.round(Math.abs(drift.peak))}° ${drift.side}`),
          cell('span', `${Math.round(drift.speedKmh)} km/h${spun ? `, wheels +${Math.round(drift.slipPct)}%` : ''}`, spun ? 'spun' : ''),
        );
        button.addEventListener('click', () => this.#moveTo(drift.from - LEAD_IN_MS));
        return button;
      }),
    );
  }

  /** The totals of the recording as a list of names and values; what the recording cannot tell is left out. */
  #listTotals(totals) {
    const rows = [['Recorded', span(totals.recordedMs)]];
    const add = (name, value) => rows.push([name, value]);
    if (totals.distanceM !== null) add('Distance', totals.distanceM >= 1000 ? `${(totals.distanceM / 1000).toFixed(2)} km` : `${Math.round(totals.distanceM)} m`);
    if (totals.topSpeedKmh !== null) add('Top speed over ground', `${Math.round(totals.topSpeedKmh)} km/h`);
    if (totals.topWheelKmh !== null) add('Top speed of the wheels', `${Math.round(totals.topWheelKmh)} km/h`);
    if (totals.topRpm !== null) add('Highest revs', `${Math.round(totals.topRpm)} rpm`);
    if (totals.topCoolantC !== null) add('Hottest coolant', `${Math.round(totals.topCoolantC)} °C`);
    if (this.#recording.has('drift.drift_angle_deg')) {
      add('Drifts', totals.drifts ? `${totals.drifts}, ${(totals.driftMs / 1000).toFixed(1)} s in all` : 'none');
      if (totals.drifts) {
        add('Largest angle', `${Math.round(Math.abs(totals.bestAngle))}° ${totals.bestAngle > 0 ? 'R' : 'L'}`);
        add('Longest drift', `${(totals.longestMs / 1000).toFixed(1)} s`);
        add('Speed while drifting', `${Math.round(totals.driftSpeedKmh)} km/h on average`);
      }
    }
    if (totals.topSlipPct !== null) add('Wheelspin', `${(totals.spinMs / 1000).toFixed(1)} s in all, up to +${Math.round(totals.topSlipPct)}%`);
    this.#$('replay-summary-list').replaceChildren(
      ...rows.map(([name, value]) => {
        const row = document.createElement('div');
        const term = document.createElement('dt');
        const data = document.createElement('dd');
        term.textContent = name;
        data.textContent = value;
        row.append(term, data);
        return row;
      }),
    );
  }

  /** What the bands on the charts mean, for the line under them. */
  #marksText(wheels) {
    if (!wheels) return '';
    const spins = wheels.spans.filter(({ kind }) => kind === 'spin').length;
    const locks = wheels.spans.length - spins;
    const scale = wheels.steady ? `On steady stretches the car reads ${(wheels.factor * 100).toFixed(1)}% of the GPS speed, which is taken out.` : '';
    if (!wheels.spans.length) return `The wheels never turned clearly faster or slower than the car moved. ${scale}`.trim();
    const parts = [];
    if (spins) parts.push(`red bands: wheels faster than the car moved (${spins})`);
    if (locks) parts.push(`blue bands: wheels slower (${locks})`);
    const list = parts.join(', ');
    return `${list.charAt(0).toUpperCase()}${list.slice(1)}. ${scale}`.trim();
  }

  /**
   * The driven line for the map, with the drift angle at each of its points for its colour. It goes through the
   * GPS fixes. The positions of the drift view are a second choice: during the drive they had to be guessed
   * ahead of each fix, which leaves a jagged line.
   */
  #buildTrack() {
    const recording = this.#recording;
    this.#positions = ['gps', 'drift'].find((stream) => recording.has(`${stream}.latitude_deg`) && recording.has(`${stream}.longitude_deg`)) ?? null;
    this.#track = [];
    this.#smooth = null;
    if (!this.#positions) return;
    if (this.#positions === 'gps') this.#smooth = smoothGps(recording);
    if (this.#smooth) {
      // Each point of the line carries the drift angle of the moment the car was there, for its colour.
      this.#track = this.#smooth
        .points(TRACK_POINTS)
        .map(([latitude, longitude, time]) => [latitude, longitude, recording.interpolateAngle('drift.drift_angle_deg', time - GPS_LATE_MS, DRIFT_HOLD_MS)]);
      return;
    }
    const { times, values: latitudes } = recording.series(`${this.#positions}.latitude_deg`);
    const longitudes = recording.series(`${this.#positions}.longitude_deg`).values;
    const count = Math.min(latitudes.length, longitudes.length);
    const stride = Math.max(1, Math.ceil(count / TRACK_POINTS));
    // A fix tells where the car was a moment before it arrived, so the angle of that moment belongs to it.
    const late = this.#positions === 'gps' ? GPS_LATE_MS : 0;
    for (let index = 0; index < count; index += stride) {
      // A fix that is tens of metres off would only scribble on the map.
      if (recording.value('gps.accuracy_m', times[index], 0) > 50) continue;
      this.#track.push([latitudes[index], longitudes[index], recording.value('drift.drift_angle_deg', times[index] - late, DRIFT_HOLD_MS)]);
    }
  }

  // Charts ----------------------------------------------------------------------

  /** The signals that have no chart yet, grouped by where they come from. */
  #listSignals() {
    const select = this.#$('replay-add');
    const first = document.createElement('option');
    first.value = '';
    first.textContent = 'Add a signal to the charts…';
    const groups = new Map();
    for (const { id, stream, column } of this.#recording.signals) {
      if (this.#panels.includes(id)) continue;
      if (!groups.has(stream)) {
        const group = document.createElement('optgroup');
        group.label = title(stream);
        groups.set(stream, group);
      }
      const option = document.createElement('option');
      option.value = id;
      option.textContent = column;
      groups.get(stream).append(option);
    }
    select.replaceChildren(first, ...groups.values());
    select.value = '';
    select.disabled = groups.size === 0;
  }

  #addPanel(id, remember = true) {
    if (this.#panels.includes(id) || !this.#recording.has(id)) return;
    const { stream, column } = this.#recording.signals.find((signal) => signal.id === id);
    const chart = new SignalChart({
      name: column,
      source: title(stream),
      onRemove: () => this.#removePanel(id),
      onSeek: (share) => {
        if (this.#page) this.#moveTo(this.#page[0] + share * (this.#page[1] - this.#page[0]));
      },
    });
    this.#panels.push(id);
    this.#charts.set(id, chart);
    this.#$('replay-charts').append(chart.element);
    this.#page = null;
    if (remember) this.#rememberPanels();
  }

  #removePanel(id) {
    this.#charts.get(id)?.element.remove();
    this.#charts.delete(id);
    this.#panels = this.#panels.filter((panel) => panel !== id);
    this.#rememberPanels();
  }

  #rememberPanels() {
    this.#write(SIGNALS_KEY, JSON.stringify(this.#panels));
    this.#listSignals();
  }

  // Playing ---------------------------------------------------------------------

  #play(on) {
    const recording = this.#recording;
    // Play at the end starts again from the beginning.
    if (on && recording && this.#cursor >= recording.end) this.#cursor = recording.start;
    this.#playing = Boolean(on && recording);
    this.#lastFrame = null;
    this.#text('replay-play', this.#playing ? 'Pause' : 'Play');
  }

  /** Stop playing, for when the view is left. */
  pause() {
    this.#play(false);
  }

  /** Move to `time`; from inside a pause it goes on to where the recording continues. */
  #moveTo(time) {
    const recording = this.#recording;
    const bounded = Math.min(Math.max(time, recording.start), recording.end);
    this.#cursor = skipGap(this.#stretches, bounded) ?? recording.end;
  }

  #seek(share) {
    if (!this.#recording) return;
    this.#moveTo(this.#recording.start + share * (this.#recording.end - this.#recording.start));
  }

  /** Called on every animation frame while the view is open; `now` is the page clock in ms. */
  frame(now) {
    const recording = this.#recording;
    if (recording && this.#playing) {
      // A frame that took long (the page was in the background) must not throw the replay far ahead.
      const elapsed = this.#lastFrame === null ? 0 : Math.min(now - this.#lastFrame, 250);
      const next = skipGap(this.#stretches, this.#cursor + elapsed * this.#speed);
      if (next === null || next >= recording.end) {
        this.#cursor = recording.end;
        this.#play(false);
      } else {
        this.#cursor = next;
      }
    }
    this.#lastFrame = now;
    if (recording) this.#render();
  }

  #render() {
    const recording = this.#recording;
    const time = this.#cursor;
    const { start, end } = recording;

    // The charts show one page of time; a new page is drawn when the cursor leaves it.
    const length = this.#windowMs || end - start || 1;
    const from = Math.min(start + Math.floor((time - start) / length) * length, Math.max(end - length, start));
    if (!this.#page || this.#page[0] !== from || this.#page[1] !== from + length) {
      this.#page = [from, from + length];
      const signals = new Map(recording.signals.map((signal) => [signal.id, signal]));
      for (const [id, chart] of this.#charts) {
        const { min, max } = signals.get(id);
        // The measurements themselves are shown as dots on the line, where there are few enough not to be thinned out.
        const exact = recording.count(id, from, from + length) <= POINTS_PER_CHART;
        chart.draw(recording.points(id, from, from + length, POINTS_PER_CHART), from, from + length, min, max, this.#breaks, this.#marks, { exact });
      }
      this.#text('replay-range', `${clock(from)} to ${clock(Math.min(from + length, end))}`);
    }
    for (const [id, chart] of this.#charts) chart.cursor(time, recording.value(id, time));

    const seek = this.#$('replay-seek');
    const place = String(Math.round(((time - start) / (end - start || 1)) * Number(seek.max)));
    if (!this.#dragging && seek.value !== place) seek.value = place;
    this.#text('replay-clock', `${clock(time)}.${Math.floor((time % 1000) / 100)} · ${span(time - start)} of ${span(end - start)}`);

    const angle = recording.value('drift.drift_angle_deg', time, DRIFT_HOLD_MS);
    this.#text('replay-angle', angle === null ? '--' : String(Math.round(Math.abs(angle))));
    // Which side the nose points to, seen along the direction of travel.
    this.#text('replay-side', angle === null || Math.abs(angle) < 1 ? '°' : angle > 0 ? '° R' : '° L');
    this.#text('replay-gps', rounded(recording.value('drift.speed_ms', time, DRIFT_HOLD_MS) ?? recording.value('gps.speed_ms', time, GPS_HOLD_MS), 3.6));
    this.#text('replay-car', rounded(recording.value('obd.speed_kmh', time, CAR_HOLD_MS)));
    this.#text('replay-rpm', rounded(recording.value('obd.rpm', time, CAR_HOLD_MS)));
    // Inside a band the car's speed is not the speed of the car: say by how much the wheels are off.
    const mark = this.#marks.find((band) => time >= band.from && time <= band.to);
    const slip = mark ? recording.value('wheels.slip_pct', time, CAR_HOLD_MS) : null;
    this.#text('replay-slip', slip === null ? '' : `wheels ${slip > 0 ? '+' : ''}${Math.round(slip)}%`);
    const wheels = slip === null ? '' : mark.kind;
    if (this.#shown.get('wheels') !== wheels) {
      this.#shown.set('wheels', wheels);
      this.#$('replay-car-tile').dataset.wheels = wheels;
    }

    if (this.#smooth) {
      // The car goes along the smoothed line. It points as the line goes, turned by the drift angle, so the
      // angle seen between car and line is the angle in the readouts.
      const at = this.#smooth.at(time + GPS_LATE_MS, GPS_HOLD_MS);
      const angle = recording.interpolateAngle('drift.drift_angle_deg', time, DRIFT_HOLD_MS);
      const course = at?.course ?? null;
      const heading = course !== null && angle !== null ? (course + angle + 360) % 360 : recording.interpolateAngle('drift.heading_deg', time, DRIFT_HOLD_MS);
      const nearest = at ?? this.#smooth.at(Math.min(Math.max(time + GPS_LATE_MS, this.#smooth.start), this.#smooth.end), Infinity);
      this.#map.draw({
        position: { latitude: nearest.latitude, longitude: nearest.longitude },
        points: this.#track,
        heading: at ? heading : null,
        course: at ? course : null,
        car: Boolean(at),
      });
      this.#map.hint = at ? '' : 'No position at this moment';
    } else if (this.#positions) {
      // Between two positions the car moves along the straight line from one to the next.
      const fromGps = this.#positions === 'gps';
      const hold = fromGps ? GPS_HOLD_MS : DRIFT_HOLD_MS;
      const at = fromGps ? time + GPS_LATE_MS : time;
      const latitudes = `${this.#positions}.latitude_deg`;
      const longitudes = `${this.#positions}.longitude_deg`;
      let latitude = recording.interpolate(latitudes, at, hold);
      let longitude = recording.interpolate(longitudes, at, hold);
      const known = latitude !== null && longitude !== null;
      if (!known) {
        // Before the first fix, and where GPS fell silent, the map stays on the nearest place that is known,
        // with the line but without the car.
        latitude = recording.value(latitudes, at) ?? recording.series(latitudes).values[0];
        longitude = recording.value(longitudes, at) ?? recording.series(longitudes).values[0];
      }
      this.#map.draw({
        position: { latitude, longitude },
        points: this.#track,
        heading: known ? recording.value('drift.heading_deg', time, DRIFT_HOLD_MS) : null,
        course: known ? (recording.value('drift.course_deg', time, DRIFT_HOLD_MS) ?? recording.value('gps.heading_deg', time, GPS_HOLD_MS)) : null,
      });
      this.#map.hint = known ? '' : 'No position at this moment';
    }
  }
}
