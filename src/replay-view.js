// The replay view: a recording played back on the map, with charts of any of
// its signals over time. The recording is the log kept in this app or files
// saved or shared from it (CSV files, or the ZIP archive with all of them).

import { SignalChart } from './chart.js';
import { Recording, parseCsv, skipGap, streamOf } from './replay.js';
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
const FIRST_SIGNALS = ['obd.rpm', 'obd.speed_kmh', 'gps.speed_ms', 'drift.drift_angle_deg', 'obd.throttle_pct'];
const STREAM_TITLES = {
  obd: 'car',
  gps: 'GPS',
  drift: 'drift view',
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
// How long a value stays on screen after it was measured.
const CAR_HOLD_MS = 5000;
const DRIFT_HOLD_MS = 1500;
const GPS_HOLD_MS = 3000;

const decoder = new TextDecoder();
const two = (value) => String(value).padStart(2, '0');
const clock = (ms) => {
  const date = new Date(ms);
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
};
const span = (ms) => `${Math.floor(ms / 60000)}:${two(Math.floor(ms / 1000) % 60)}`;
const title = (stream) => STREAM_TITLES[stream] ?? stream;
const rounded = (value, scale = 1) => (value === null ? '--' : String(Math.round(value * scale)));

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
    const recording = new Recording(tables);
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
    this.#text('replay-info', `${source}: ${clock(recording.start)} to ${clock(recording.end)}, ${recording.signals.length} signals${skipped}.${trouble}`);
    $('replay-body').hidden = false;
    $('replay-map').hidden = this.#positions === null;
  }

  /** The driven line for the map, from the positions of the drift view if it recorded them, else from GPS. */
  #buildTrack() {
    const recording = this.#recording;
    this.#positions = ['drift', 'gps'].find((stream) => recording.has(`${stream}.latitude_deg`) && recording.has(`${stream}.longitude_deg`)) ?? null;
    this.#track = [];
    if (!this.#positions) return;
    const latitudes = recording.series(`${this.#positions}.latitude_deg`).values;
    const longitudes = recording.series(`${this.#positions}.longitude_deg`).values;
    const count = Math.min(latitudes.length, longitudes.length);
    const stride = Math.max(1, Math.ceil(count / TRACK_POINTS));
    for (let index = 0; index < count; index += stride) this.#track.push([latitudes[index], longitudes[index]]);
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
        chart.draw(recording.points(id, from, from + length), from, from + length, min, max, this.#breaks);
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

    if (this.#positions) {
      // Between two positions the car moves along the straight line from one to the next.
      const hold = this.#positions === 'drift' ? DRIFT_HOLD_MS : GPS_HOLD_MS;
      const latitude = recording.interpolate(`${this.#positions}.latitude_deg`, time, hold);
      const longitude = recording.interpolate(`${this.#positions}.longitude_deg`, time, hold);
      const known = latitude !== null && longitude !== null;
      this.#map.draw({
        position: known ? { latitude, longitude } : null,
        points: this.#track,
        heading: recording.value('drift.heading_deg', time, DRIFT_HOLD_MS),
        course: recording.value('drift.course_deg', time, DRIFT_HOLD_MS) ?? recording.value('gps.heading_deg', time, GPS_HOLD_MS),
      });
      this.#map.hint = known ? '' : 'No position at this moment';
    }
  }
}
