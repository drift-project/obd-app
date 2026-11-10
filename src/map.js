// The map of the drift and replay views: map or aerial tiles under the driven
// line and a car that points the way the body points. North is up and the car
// stays in the middle. Without a connection the tiles stay empty and the line
// and the car are drawn on the plain background.

import { TILE_SIZE, project, tilesInView } from './geo.js';

export const MIN_ZOOM = 12;
export const MAX_ZOOM = 19; // the deepest level every layer has

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

const SVG = 'http://www.w3.org/2000/svg';

function svg(name, attributes = {}, children = []) {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  element.append(...children);
  return element;
}

function html(name, className, text = '') {
  const element = document.createElement(name);
  element.className = className;
  element.textContent = text;
  return element;
}

export class TrackMap {
  #view;
  #tiles;
  #path;
  #car;
  #body;
  #course;
  #hint;
  #credit;
  #layerButton;
  #zoom;
  #layer;
  #onChange;
  #onTileError;
  #images = new Map(); // "layer/zoom/x/y" -> img
  #borrowed = new Set(); // keys of the tiles that show the drawn map because their layer has no picture there
  #drawn = { points: null, length: -1, zoom: -1, anchor: null };

  /**
   * Builds the map inside `view`, an empty box with a size. `zoom` and
   * `layer` are where it starts; `onChange({ zoom, layer })` is called when
   * the buttons on the map change them and `onTileError(layer)` when a piece
   * of the map could not be loaded at all.
   */
  constructor(view, { zoom = 18, layer = 'map', onChange = () => {}, onTileError = () => {} } = {}) {
    this.#view = view;
    this.#zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom) || 18));
    this.#layer = LAYERS.find(({ id }) => id === layer) ?? LAYERS[0];
    this.#onChange = onChange;
    this.#onTileError = onTileError;

    this.#tiles = html('div', 'map-tiles');
    this.#path = svg('g', { class: 'map-path', hidden: '' });
    this.#course = svg('g', { class: 'map-course', hidden: '' }, [svg('line', { x1: 0, y1: 0, x2: 0, y2: -52 }), svg('path', { d: 'M -6 -50 L 0 -62 L 6 -50 Z' })]);
    this.#body = svg('g', { class: 'map-body', hidden: '' }, [
      svg('rect', { x: -9, y: -19, width: 18, height: 38, rx: 6 }),
      svg('path', { class: 'map-glass', d: 'M -6 -10 L 6 -10 L 5 -3 L -5 -3 Z' }),
      svg('path', { class: 'map-glass', d: 'M -5 8 L 5 8 L 6 13 L -6 13 Z' }),
    ]);
    this.#car = svg('g', { hidden: '' }, [this.#course, this.#body]);
    const overlay = svg('svg', { class: 'map-overlay', 'aria-hidden': 'true' }, [this.#path, this.#car]);

    const button = (label, name, action) => {
      const element = html('button', '', label);
      element.type = 'button';
      element.setAttribute('aria-label', name);
      element.addEventListener('click', action);
      return element;
    };
    // Shows the layer that is on; a tap goes to the next one.
    this.#layerButton = button(this.#layer.label, 'Change the map layer: map or pictures from the air', () => this.#nextLayer());
    this.#layerButton.className = 'map-layer';
    const controls = html('div', 'map-zoom');
    controls.append(button('+', 'Zoom in', () => this.#zoomBy(1)), button('-', 'Zoom out', () => this.#zoomBy(-1)), this.#layerButton);
    this.#hint = html('p', 'map-hint');
    this.#credit = html('p', 'map-credit', this.#layer.credit);
    // What the colours of the line stand for.
    const ramp = html('span', 'map-legend-ramp');
    ramp.style.background = `linear-gradient(90deg, ${Array.from({ length: SHADES }, (_, shade) => shadeColor(shade)).join(', ')})`;
    const legend = html('p', 'map-legend');
    legend.append(html('span', '', 'drift 0°'), ramp, html('span', '', `${FULL_ANGLE}°`));
    view.replaceChildren(this.#tiles, overlay, controls, this.#hint, legend, this.#credit);
    this.#tiles.dataset.layer = this.#layer.id;
  }

  get zoom() {
    return this.#zoom;
  }

  get layer() {
    return this.#layer.id;
  }

  /** Text shown in the middle of the map, such as "Waiting for a GPS position". */
  set hint(text) {
    if (this.#hint.textContent !== text) this.#hint.textContent = text;
  }

  /** Set the zoom and the layer from outside, for example to follow another map; `onChange` is not called. */
  show({ zoom = this.#zoom, layer = this.#layer.id } = {}) {
    this.#zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom) || this.#zoom));
    this.#layer = LAYERS.find(({ id }) => id === layer) ?? this.#layer;
    this.#layerButton.textContent = this.#layer.label;
    this.#credit.textContent = this.#layer.credit;
    this.#tiles.dataset.layer = this.#layer.id;
  }

  #zoomBy(step) {
    this.show({ zoom: this.#zoom + step });
    this.#onChange({ zoom: this.#zoom, layer: this.#layer.id });
  }

  #nextLayer() {
    this.show({ layer: LAYERS[(LAYERS.indexOf(this.#layer) + 1) % LAYERS.length].id });
    this.#onChange({ zoom: this.#zoom, layer: this.#layer.id });
  }

  #drawTiles(center, width, height) {
    const wanted = new Set();
    for (const tile of tilesInView(center, width, height, this.#zoom)) {
      const key = `${this.#layer.id}/${this.#zoom}/${tile.x}/${tile.y}`;
      wanted.add(key);
      let image = this.#images.get(key);
      if (!image) {
        image = document.createElement('img');
        image.alt = '';
        image.draggable = false;
        image.decoding = 'async';
        image.width = TILE_SIZE;
        image.height = TILE_SIZE;
        const drawn = LAYERS[0];
        // The drawn map is toned down to sit in the dark screen; a picture is shown as it is.
        image.classList.toggle('map-drawn', this.#layer === drawn);
        // Where this layer has no picture (the pictures from the air end at the Polish border), the
        // drawn map is shown in its place. Without a connection that fails too and the background stays.
        const instead = this.#layer === drawn ? null : drawn.url(this.#zoom, tile.x, tile.y);
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
        image.src = this.#layer.url(this.#zoom, tile.x, tile.y);
        this.#images.set(key, image);
        this.#tiles.append(image);
      }
      image.style.transform = `translate(${Math.round(tile.left)}px, ${Math.round(tile.top)}px)`;
    }
    for (const [key, image] of this.#images) {
      if (wanted.has(key)) continue;
      image.remove();
      this.#images.delete(key);
      this.#borrowed.delete(key);
    }
    // Whoever made what is on screen is named: the layer, or the map that stands in for it.
    const credit = this.#borrowed.size ? `No pictures from the air here · ${LAYERS[0].credit}` : this.#layer.credit;
    if (this.#credit.textContent !== credit) this.#credit.textContent = credit;
  }

  /**
   * The line is written once per new point, in pixels around its first point,
   * and moved as a whole on every frame. It is made of runs of one shade,
   * each reaching to the first point of the next so that they join.
   */
  #drawPath(points, center, width, height) {
    const drawn = this.#drawn;
    if (drawn.points !== points || drawn.length !== points.length || drawn.zoom !== this.#zoom) {
      drawn.points = points;
      drawn.length = points.length;
      drawn.zoom = this.#zoom;
      drawn.anchor = points.length ? project(points[0][0], points[0][1], this.#zoom) : null;
      const anchor = drawn.anchor;
      const runs = [];
      let run = null;
      for (const [latitude, longitude, angle = null] of points) {
        const point = project(latitude, longitude, this.#zoom);
        const place = `${(point.x - anchor.x).toFixed(1)},${(point.y - anchor.y).toFixed(1)}`;
        const shade = angleShade(angle);
        if (run && run.shade !== shade) run.places.push(place);
        if (!run || run.shade !== shade) {
          run = { shade, places: [] };
          runs.push(run);
        }
        run.places.push(place);
      }
      this.#path.replaceChildren(...runs.map(({ shade, places }) => svg('polyline', { points: places.join(' '), stroke: shadeColor(shade) })));
    }
    if (drawn.anchor) {
      const left = drawn.anchor.x - center.x + width / 2;
      const top = drawn.anchor.y - center.y + height / 2;
      this.#path.setAttribute('transform', `translate(${left.toFixed(1)} ${top.toFixed(1)})`);
    }
  }

  /**
   * Draw the map around `position` ({ latitude, longitude }, or null when it
   * is not known yet). `points` are the places driven so far as [latitude,
   * longitude, drift angle], the angle in degrees or null, which gives the
   * line its colour; `heading` and `course` are degrees clockwise from north
   * or null. Without a heading the car is turned along the course, and
   * without either only the map and the line are shown.
   */
  draw({ position, points, heading, course }) {
    const width = this.#view.clientWidth;
    const height = this.#view.clientHeight;
    if (!width || !height) return;
    this.#car.toggleAttribute('hidden', !position);
    this.#path.toggleAttribute('hidden', !position);
    if (!position) {
      this.#drawTiles({ x: 0, y: 0 }, 0, 0); // drops every tile
      return;
    }
    const center = project(position.latitude, position.longitude, this.#zoom);
    this.#drawTiles(center, width, height);
    this.#drawPath(points, center, width, height);
    this.#car.setAttribute('transform', `translate(${(width / 2).toFixed(1)} ${(height / 2).toFixed(1)})`);
    const direction = heading ?? course;
    this.#body.toggleAttribute('hidden', direction === null);
    if (direction !== null) this.#body.setAttribute('transform', `rotate(${direction.toFixed(1)})`);
    // A car turned by the course alone is only a guess at where the body points.
    this.#body.classList.toggle('guessed', heading === null);
    this.#course.toggleAttribute('hidden', course === null);
    if (course !== null) this.#course.setAttribute('transform', `rotate(${course.toFixed(1)})`);
  }
}
