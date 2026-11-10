// The map of the drift and replay views: map or aerial tiles under the driven
// line and the car.
//
// It has two views. Flat, north is up and the car stays in the middle. In 3D
// the camera follows behind and above the car, as the chase view of a racing
// game does (see camera.js): the ground is tilted away and turned so that the
// car drives up the screen, and the car is a small model (car-model.js).
//
// The tiles are images laid on a plane that the browser turns and tilts with
// a CSS 3D transform; each tile is a layer of its own, so nothing large has
// to be painted again while the view moves. The line, the arrow of the
// direction of travel and the car are painted on a canvas over the tiles
// with the same sums, so they sit exactly on them. Without a connection the
// tiles stay empty and a grid is painted on the ground instead, so the car
// can still be seen to move.

import { camera, groundCss, toScreen, visibleGround } from './camera.js';
import { MODEL_LENGTH, paintCar, paintFlatCar } from './car-model.js';
import { TILE_SIZE, metersPerPixel, project, tilesInView } from './geo.js';

export const MIN_ZOOM = 12;
export const MAX_ZOOM = 21;
// The deepest level every layer has pictures for. Closer than that, its pictures are shown enlarged.
const TILE_ZOOM = 19;

const GEOPORTAL = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMTS/StandardResolution';

/**
 * What can be shown under the line. Both use the same tile grid.
 *
 * Pictures of the whole world (Esri World Imagery, for one) fit the same
 * grid, but their terms ask for an account with the provider, so they are
 * not built in.
 */
export const LAYERS = [
  {
    id: 'map',
    label: 'Map',
    credit: '© OpenStreetMap',
    url: (zoom, x, y) => `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`,
  },
  {
    // Pictures from the air: the Polish state orthophoto. Open data, free for any use, Poland only.
    id: 'orthophoto',
    label: 'Sat',
    credit: '© GUGiK, geoportal.gov.pl',
    url: (zoom, x, y) =>
      `${GEOPORTAL}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTOFOTOMAPA&STYLE=default&FORMAT=image/jpeg` +
      `&TILEMATRIXSET=EPSG:3857&TILEMATRIX=EPSG:3857:${zoom}&TILEROW=${y}&TILECOL=${x}`,
  },
];

/** The two views; the button on the map names the one that is on. */
export const MODES = [
  { id: '3d', label: '3D' },
  { id: '2d', label: '2D' },
];

// The driven line is coloured by the drift angle at each of its points: blue where the car goes the way
// it points, then through violet and pink to red at this many degrees and beyond.
export const FULL_ANGLE = 35;
const SHADES = 12; // the line is drawn in runs of one shade, so the shades are few
const RAMP = [
  [66, 186, 255],
  [143, 125, 255],
  [228, 85, 200],
  [255, 70, 64],
];

/** The shade of the line, from 0 to SHADES - 1, for a drift angle in degrees to either side (null: not known). */
export function angleShade(angle) {
  if (angle === null || angle === undefined || Number.isNaN(angle)) return 0;
  return Math.round((Math.min(Math.abs(angle), FULL_ANGLE) / FULL_ANGLE) * (SHADES - 1));
}

/** The colour of a shade as CSS. */
export function shadeColor(shade) {
  const along = (Math.max(0, Math.min(SHADES - 1, shade)) / (SHADES - 1)) * (RAMP.length - 1);
  const from = Math.min(Math.floor(along), RAMP.length - 2);
  const share = along - from;
  const mixed = RAMP[from].map((value, index) => Math.round(value + (RAMP[from + 1][index] - value) * share));
  return `rgb(${mixed.join(', ')})`;
}

const SHADE_COLORS = Array.from({ length: SHADES }, (_, shade) => shadeColor(shade));
const TURN_S = 0.35; // the 3D camera follows the direction of travel most of the way in about this time
const JUMP_M = 80; // a jump further than this (a seek in a replay) turns the camera at once
const ANCHOR_RANGE = 20000; // map pixels from the anchor before positions count from a new one
const CAR_LENGTH_M = 4.8 * 1.4; // drawn a little larger than a real car, so that it reads at a glance
const LINE_PX = 4;
const GRID_PX = 64;
const AMBER = 'rgb(255, 181, 71)';
const RADIANS = Math.PI / 180;

const wrap180 = (degrees) => ((((degrees + 180) % 360) + 360) % 360) - 180;
const clampZoom = (zoom, otherwise) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom) || otherwise));

function html(name, className, text = '') {
  const element = document.createElement(name);
  element.className = className;
  element.textContent = text;
  return element;
}

/** Whether the square of `size` at `left`, `top` overlaps the convex polygon `corners` ([{ x, y }]). */
export function overlaps(corners, left, top, size) {
  const square = [
    { x: left, y: top },
    { x: left + size, y: top },
    { x: left + size, y: top + size },
    { x: left, y: top + size },
  ];
  const axes = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ];
  corners.forEach((corner, index) => {
    const next = corners[(index + 1) % corners.length];
    axes.push({ x: next.y - corner.y, y: corner.x - next.x });
  });
  const span = (points, axis) => {
    let low = Infinity;
    let high = -Infinity;
    for (const point of points) {
      const value = point.x * axis.x + point.y * axis.y;
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    return [low, high];
  };
  return axes.every((axis) => {
    const [a0, a1] = span(corners, axis);
    const [b0, b1] = span(square, axis);
    return a1 >= b0 && b1 >= a0;
  });
}

/** The part of the line from `a` to `b` inside the convex polygon `corners`, or null (Cyrus-Beck). */
export function clipLine(corners, a, b) {
  let enter = 0;
  let leave = 1;
  const direction = { x: b.x - a.x, y: b.y - a.y };
  // The polygon's corners go round one way; an edge's inward side is found from a point inside.
  const inside = corners.reduce((sum, corner) => ({ x: sum.x + corner.x / corners.length, y: sum.y + corner.y / corners.length }), { x: 0, y: 0 });
  for (let index = 0; index < corners.length; index += 1) {
    const from = corners[index];
    const to = corners[(index + 1) % corners.length];
    let normal = { x: from.y - to.y, y: to.x - from.x };
    if (normal.x * (inside.x - from.x) + normal.y * (inside.y - from.y) < 0) normal = { x: -normal.x, y: -normal.y };
    const towards = normal.x * direction.x + normal.y * direction.y;
    const distance = normal.x * (a.x - from.x) + normal.y * (a.y - from.y);
    if (Math.abs(towards) < 1e-12) {
      if (distance < 0) return null;
      continue;
    }
    const at = -distance / towards;
    if (towards > 0) enter = Math.max(enter, at);
    else leave = Math.min(leave, at);
    if (enter > leave) return null;
  }
  return [
    { x: a.x + direction.x * enter, y: a.y + direction.y * enter },
    { x: a.x + direction.x * leave, y: a.y + direction.y * leave },
  ];
}

export class TrackMap {
  #view;
  #scene;
  #ground;
  #canvas;
  #ctx;
  #hint;
  #credit;
  #layerButton;
  #modeButton;
  #zoom;
  #zoom3d;
  #mode;
  #layer;
  #onChange;
  #onTileError;
  #images = new Map(); // "layer/zoom/x/y" -> img
  #borrowed = new Set(); // keys of the tiles that show the drawn map because their layer has no picture there
  #loaded = new Set(); // keys of the tiles that have a picture on screen
  #anchor = null; // { x, y, zoom }: the map pixel that ground positions are counted from
  #trail = { points: null, length: -1, zoom: -1, xs: null, ys: null, shades: null };
  #bearing = null; // where the 3D camera looks, degrees clockwise from north
  #frameAt = null;
  #last = null; // the position of the frame before, to notice jumps
  #size = { width: 0, height: 0, ratio: 0 };

  /**
   * Builds the map inside `view`, an empty box with a size. `zoom` (flat),
   * `zoom3d`, `mode` ('3d' or '2d') and `layer` are where it starts;
   * `onChange({ zoom, zoom3d, mode, layer })` is called when the buttons on
   * the map change them and `onTileError(layer)` when a piece of the map
   * could not be loaded at all.
   */
  constructor(view, { zoom = 18, zoom3d = 20, mode = '3d', layer = 'map', onChange = () => {}, onTileError = () => {} } = {}) {
    this.#view = view;
    this.#zoom = clampZoom(zoom, 18);
    this.#zoom3d = clampZoom(zoom3d, 20);
    this.#mode = MODES.find(({ id }) => id === mode) ?? MODES[0];
    this.#layer = LAYERS.find(({ id }) => id === layer) ?? LAYERS[0];
    this.#onChange = onChange;
    this.#onTileError = onTileError;

    this.#scene = html('div', 'map-scene');
    // The ground: the tiles are laid on it, and the browser turns and tilts it.
    this.#ground = html('div', 'map-tiles');
    this.#scene.append(this.#ground);
    this.#canvas = document.createElement('canvas');
    this.#canvas.className = 'map-paint';
    this.#canvas.setAttribute('aria-hidden', 'true');
    this.#ctx = this.#canvas.getContext('2d');

    const button = (label, name, action) => {
      const element = html('button', '', label);
      element.type = 'button';
      element.setAttribute('aria-label', name);
      element.addEventListener('click', action);
      return element;
    };
    // The two buttons below the zoom show what is on; a tap goes to the next.
    this.#modeButton = button('', 'Change the view: 3D behind the car or the flat map', () => this.#nextMode());
    this.#modeButton.className = 'map-layer';
    this.#layerButton = button('', 'Change the map layer: map or pictures from the air', () => this.#nextLayer());
    this.#layerButton.className = 'map-layer';
    const controls = html('div', 'map-zoom');
    controls.append(button('+', 'Zoom in', () => this.#zoomBy(1)), button('-', 'Zoom out', () => this.#zoomBy(-1)), this.#modeButton, this.#layerButton);
    this.#hint = html('p', 'map-hint');
    this.#credit = html('p', 'map-credit');
    // What the colours of the line stand for.
    const ramp = html('span', 'map-legend-ramp');
    ramp.style.background = `linear-gradient(90deg, ${SHADE_COLORS.join(', ')})`;
    const legend = html('p', 'map-legend');
    legend.append(html('span', '', 'drift 0°'), ramp, html('span', '', `${FULL_ANGLE}°`));
    view.replaceChildren(this.#scene, this.#canvas, html('div', 'map-fog'), controls, this.#hint, legend, this.#credit);
    this.show();
  }

  get zoom() {
    return this.#zoom;
  }

  get zoom3d() {
    return this.#zoom3d;
  }

  get mode() {
    return this.#mode.id;
  }

  get layer() {
    return this.#layer.id;
  }

  /** Text shown in the middle of the map, such as "Waiting for a GPS position". */
  set hint(text) {
    if (this.#hint.textContent !== text) this.#hint.textContent = text;
  }

  /** Set the zooms, the view and the layer from outside, for example to follow another map; `onChange` is not called. */
  show({ zoom = this.#zoom, zoom3d = this.#zoom3d, mode = this.#mode.id, layer = this.#layer.id } = {}) {
    this.#zoom = clampZoom(zoom, this.#zoom);
    this.#zoom3d = clampZoom(zoom3d, this.#zoom3d);
    const next = MODES.find(({ id }) => id === mode) ?? this.#mode;
    // Into 3D the camera starts behind the car, not swinging round from wherever it last looked.
    if (next !== this.#mode) this.#bearing = null;
    this.#mode = next;
    this.#layer = LAYERS.find(({ id }) => id === layer) ?? this.#layer;
    this.#modeButton.textContent = this.#mode.label;
    this.#layerButton.textContent = this.#layer.label;
    this.#credit.textContent = this.#layer.credit;
    this.#ground.dataset.layer = this.#layer.id;
    this.#view.dataset.mode = this.#mode.id;
  }

  #settings() {
    return { zoom: this.#zoom, zoom3d: this.#zoom3d, mode: this.#mode.id, layer: this.#layer.id };
  }

  #zoomBy(step) {
    if (this.#mode.id === '3d') this.show({ zoom3d: this.#zoom3d + step });
    else this.show({ zoom: this.#zoom + step });
    this.#onChange(this.#settings());
  }

  #nextMode() {
    this.show({ mode: MODES[(MODES.indexOf(this.#mode) + 1) % MODES.length].id });
    this.#onChange(this.#settings());
  }

  #nextLayer() {
    this.show({ layer: LAYERS[(LAYERS.indexOf(this.#layer) + 1) % LAYERS.length].id });
    this.#onChange(this.#settings());
  }

  #dropTiles() {
    for (const image of this.#images.values()) image.remove();
    this.#images.clear();
    this.#borrowed.clear();
    this.#loaded.clear();
  }

  /** The tiles the camera sees, laid on the ground; returns whether any of them shows a picture. */
  #drawTiles(cam, center, zoom) {
    const tileZoom = Math.min(zoom, TILE_ZOOM);
    const factor = 2 ** (zoom - tileZoom); // how much a picture is enlarged
    const size = TILE_SIZE * factor;
    const corners = visibleGround(cam).map(({ x, y }) => ({ x: x + center.x, y: y + center.y }));
    const xs = corners.map(({ x }) => x);
    const ys = corners.map(({ y }) => y);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const width = Math.max(...xs) - left;
    const height = Math.max(...ys) - top;
    const anchor = this.#anchor;
    const wanted = new Set();
    let shown = false;
    for (const tile of tilesInView({ x: (left + width / 2) / factor, y: (top + height / 2) / factor }, width / factor, height / factor, tileZoom)) {
      const worldLeft = left + tile.left * factor;
      const worldTop = top + tile.top * factor;
      if (cam.tilted && !overlaps(corners, worldLeft, worldTop, size)) continue;
      const key = `${this.#layer.id}/${tileZoom}/${tile.x}/${tile.y}`;
      wanted.add(key);
      if (this.#loaded.has(key)) shown = true;
      if (this.#images.has(key)) continue;
      const image = document.createElement('img');
      image.alt = '';
      image.draggable = false;
      image.decoding = 'async';
      image.width = TILE_SIZE;
      image.height = TILE_SIZE;
      if (factor !== 1) {
        image.style.width = `${size + 1}px`;
        image.style.height = `${size + 1}px`;
      }
      const drawn = LAYERS[0];
      // The drawn map is toned down to sit in the dark screen; a picture is shown as it is.
      image.classList.toggle('map-drawn', this.#layer === drawn);
      // Where this layer has no picture (the pictures from the air end at the Polish border), the
      // drawn map is shown in its place. Without a connection that fails too and the background stays.
      const instead = this.#layer === drawn ? null : drawn.url(tileZoom, tile.x, tile.y);
      image.addEventListener('load', () => {
        if (this.#images.get(key) === image) this.#loaded.add(key);
      });
      image.addEventListener('error', () => {
        if (instead && !this.#borrowed.has(key) && this.#images.get(key) === image) {
          this.#borrowed.add(key);
          image.classList.add('map-drawn');
          image.src = instead;
        } else {
          image.style.visibility = 'hidden';
          this.#onTileError(this.#layer.id);
        }
      });
      image.src = this.#layer.url(tileZoom, tile.x, tile.y);
      image.style.transform = `translate3d(${Math.round(worldLeft - anchor.x)}px, ${Math.round(worldTop - anchor.y)}px, 0)`;
      this.#images.set(key, image);
      this.#ground.append(image);
    }
    for (const [key, image] of this.#images) {
      if (wanted.has(key)) continue;
      image.remove();
      this.#images.delete(key);
      this.#borrowed.delete(key);
      this.#loaded.delete(key);
    }
    // Whoever made what is on screen is named: the layer, or the map that stands in for it.
    const credit = this.#borrowed.size ? `No pictures from the air here · ${LAYERS[0].credit}` : this.#layer.credit;
    if (this.#credit.textContent !== credit) this.#credit.textContent = credit;
    return shown;
  }

  /** Lines on the ground every GRID_PX map pixels, for when no tile could be shown. */
  #paintGrid(ctx, cam, center) {
    const corners = visibleGround(cam);
    const xs = corners.map(({ x }) => x + center.x);
    const ys = corners.map(({ y }) => y + center.y);
    ctx.save();
    ctx.strokeStyle = 'rgba(39, 56, 71, 0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const line = (a, b) => {
      const piece = clipLine(corners, { x: a.x - center.x, y: a.y - center.y }, { x: b.x - center.x, y: b.y - center.y });
      if (!piece) return;
      const from = toScreen(cam, piece[0].x, piece[0].y);
      const to = toScreen(cam, piece[1].x, piece[1].y);
      if (!from || !to) return;
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
    };
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    for (let x = Math.ceil(minX / GRID_PX) * GRID_PX; x <= maxX; x += GRID_PX) line({ x, y: minY }, { x, y: maxY });
    for (let y = Math.ceil(minY / GRID_PX) * GRID_PX; y <= maxY; y += GRID_PX) line({ x: minX, y }, { x: maxX, y });
    ctx.stroke();
    ctx.restore();
  }

  /** The driven line: a dark edge, then its colours, thinner where it is further away. */
  #paintTrail(ctx, cam, center, zoom, points) {
    const trail = this.#trail;
    if (trail.points !== points || trail.length !== points.length || trail.zoom !== zoom) {
      const grows = trail.points === points && trail.zoom === zoom && points.length > trail.length && trail.length >= 0;
      const xs = new Float64Array(points.length);
      const ys = new Float64Array(points.length);
      const shades = new Uint8Array(points.length);
      const from = grows ? trail.length : 0;
      if (grows) {
        xs.set(trail.xs);
        ys.set(trail.ys);
        shades.set(trail.shades);
      }
      for (let index = from; index < points.length; index += 1) {
        const [latitude, longitude, angle = null] = points[index];
        const place = project(latitude, longitude, zoom);
        xs[index] = place.x;
        ys[index] = place.y;
        shades[index] = angleShade(angle);
      }
      Object.assign(trail, { points, length: points.length, zoom, xs, ys, shades });
    }
    const count = points.length;
    if (count < 2) return;
    const { width, height } = cam;
    const margin = 40;
    const screen = new Array(count);
    for (let index = 0; index < count; index += 1) {
      const x = trail.xs[index] - center.x;
      const y = trail.ys[index] - center.y;
      if (cam.tilted) {
        const ahead = cam.sin * x - cam.cos * y;
        if (ahead > cam.far * 1.15 || ahead < -2 * cam.height) continue;
      } else if (Math.abs(x) > width + margin || Math.abs(y) > height + margin) {
        continue;
      }
      screen[index] = toScreen(cam, x, y);
    }
    const shown = (point) => point && point.x > -width && point.x < 2 * width && point.y > -height && point.y < 2 * height;
    for (const outline of [true, false]) {
      let style = null;
      ctx.beginPath();
      for (let index = 1; index < count; index += 1) {
        const a = screen[index - 1];
        const b = screen[index];
        if (!shown(a) || !shown(b)) continue;
        const thick = Math.round(LINE_PX * ((a.scale + b.scale) / 2) * 2) / 2;
        const key = outline ? thick : `${trail.shades[index]}/${thick}`;
        if (key !== style) {
          if (style !== null) ctx.stroke();
          style = key;
          ctx.beginPath();
          ctx.lineWidth = outline ? thick + 2 : thick;
          ctx.strokeStyle = outline ? 'rgba(0, 0, 0, 0.45)' : SHADE_COLORS[trail.shades[index]];
          ctx.moveTo(a.x, a.y);
        } else if (!shown(screen[index - 2]) && index > 1) {
          ctx.moveTo(a.x, a.y);
        }
        ctx.lineTo(b.x, b.y);
      }
      if (style !== null) ctx.stroke();
    }
  }

  /** The direction of travel as an arrow on the ground from the car. */
  #paintCourse(ctx, cam, course, scale) {
    const turn = course * RADIANS;
    const along = (distance, side = 0) => ({ x: Math.sin(turn) * distance + Math.cos(turn) * side, y: -Math.cos(turn) * distance + Math.sin(turn) * side });
    const reach = cam.tilted ? 62 * scale : 62;
    const onScreen = ({ x, y }) => toScreen(cam, x, y);
    const base = onScreen(along(0));
    const tip = onScreen(along(reach));
    const left = onScreen(along(reach - 12 * (cam.tilted ? scale : 1), -6 * (cam.tilted ? scale : 1)));
    const right = onScreen(along(reach - 12 * (cam.tilted ? scale : 1), 6 * (cam.tilted ? scale : 1)));
    if (!base || !tip || !left || !right) return;
    ctx.save();
    ctx.strokeStyle = AMBER;
    ctx.fillStyle = AMBER;
    ctx.lineCap = 'round';
    ctx.lineWidth = 3 * ((base.scale + tip.scale) / 2);
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo((left.x + right.x) / 2, (left.y + right.y) / 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  #fit(width, height) {
    const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
    const size = this.#size;
    if (size.width === width && size.height === height && size.ratio === ratio) return;
    Object.assign(size, { width, height, ratio });
    this.#canvas.width = Math.round(width * ratio);
    this.#canvas.height = Math.round(height * ratio);
  }

  /**
   * Draw the map around `position` ({ latitude, longitude }, or null when it
   * is not known yet). `points` are the places driven so far as [latitude,
   * longitude, drift angle], the angle in degrees or null, which gives the
   * line its colour; `heading` and `course` are degrees clockwise from north
   * or null. Without a heading the car is turned along the course, and
   * without either only the map and the line are shown. `car: false` leaves
   * the car out, for a place that is only near where the car was.
   */
  draw({ position, points = [], heading = null, course = null, car = true }) {
    const width = this.#view.clientWidth;
    const height = this.#view.clientHeight;
    if (!width || !height) return;
    this.#fit(width, height);
    const ctx = this.#ctx;
    const { ratio } = this.#size;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!position) {
      this.#dropTiles();
      this.#bearing = null;
      this.#last = null;
      return;
    }
    const tilted = this.#mode.id === '3d';
    const zoom = tilted ? this.#zoom3d : this.#zoom;
    const center = project(position.latitude, position.longitude, zoom);
    const anchor = this.#anchor;
    if (!anchor || anchor.zoom !== zoom || Math.abs(center.x - anchor.x) > ANCHOR_RANGE || Math.abs(center.y - anchor.y) > ANCHOR_RANGE) {
      this.#dropTiles();
      this.#anchor = { x: Math.round(center.x), y: Math.round(center.y), zoom };
    }

    // The 3D camera follows the direction of travel, a little behind it, and jumps with the car.
    const now = performance.now();
    const target = course ?? heading;
    const last = this.#last;
    const jumped =
      last &&
      Math.hypot((position.latitude - last.latitude) * 111320, (position.longitude - last.longitude) * 111320 * Math.cos(position.latitude * RADIANS)) > JUMP_M;
    if (target !== null && (this.#bearing === null || jumped)) {
      this.#bearing = target;
    } else if (target !== null) {
      const seconds = Math.min(Math.max((now - (this.#frameAt ?? now)) / 1000, 0), 0.5);
      this.#bearing = (this.#bearing + wrap180(target - this.#bearing) * (1 - Math.exp(-seconds / TURN_S)) + 360) % 360;
    }
    this.#frameAt = now;
    this.#last = { latitude: position.latitude, longitude: position.longitude };
    const cam = camera({ width, height, tilted, bearing: this.#bearing ?? 0 });

    const css = groundCss(cam, center.x - this.#anchor.x, center.y - this.#anchor.y);
    this.#ground.style.transform = css.transform;
    this.#scene.style.perspective = css.perspective;
    this.#scene.style.perspectiveOrigin = css.origin;
    if (tilted) {
      // Sky above the horizon, and haze that hides the far end of the ground and thins out towards the car.
      const ahead = toScreen(cam, Math.sin(cam.bearing * RADIANS) * cam.far, -Math.cos(cam.bearing * RADIANS) * cam.far);
      const solid = Math.max((ahead?.y ?? cam.horizon) - cam.horizon + 8, 8);
      this.#view.style.setProperty('--horizon', `${cam.horizon.toFixed(1)}px`);
      this.#view.style.setProperty('--haze-solid', `${solid.toFixed(1)}px`);
      this.#view.style.setProperty('--haze', `${(solid + 90).toFixed(1)}px`);
    }

    if (!this.#drawTiles(cam, center, zoom)) this.#paintGrid(ctx, cam, center);
    this.#paintTrail(ctx, cam, center, zoom, points);
    if (!car) return;
    const scale = tilted ? Math.min(Math.max(CAR_LENGTH_M / metersPerPixel(position.latitude, zoom) / MODEL_LENGTH, 0.3), 3) : 1;
    if (course !== null) this.#paintCourse(ctx, cam, course, scale);
    const direction = heading ?? course;
    if (direction === null) return;
    if (tilted) paintCar(ctx, cam, { heading: direction, scale, faint: heading === null });
    else paintFlatCar(ctx, cam.carX, cam.carY, direction, heading === null);
  }
}
