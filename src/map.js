// The map of the drift view: OpenStreetMap tiles under the driven line and a
// car that points the way the body points. North is up and the car stays in
// the middle. Without a connection the tiles stay empty and the line and the
// car are drawn on the plain background.

import { TILE_SIZE, project, tilesInView } from './geo.js';

const tileUrl = (zoom, x, y) => `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;

export const MIN_ZOOM = 12;
export const MAX_ZOOM = 19; // the deepest level the tile server has

export class TrackMap {
  #view;
  #tiles;
  #path;
  #car;
  #body;
  #course;
  #zoom;
  #images = new Map(); // "zoom/x/y" -> img
  #drawn = { points: null, length: -1, zoom: -1, anchor: null };

  /**
   * `elements`: the view (sized box), the tile layer, the SVG polyline of the
   * driven line, the car group and inside it the body and the course arrow.
   */
  constructor({ view, tiles, path, car, body, course }, zoom = 18) {
    this.#view = view;
    this.#tiles = tiles;
    this.#path = path;
    this.#car = car;
    this.#body = body;
    this.#course = course;
    this.#zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom) || 18));
  }

  get zoom() {
    return this.#zoom;
  }

  /** Zoom in (+1) or out (-1); returns the new level. */
  zoomBy(step) {
    this.#zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.#zoom + step));
    return this.#zoom;
  }

  #drawTiles(center, width, height) {
    const wanted = new Set();
    for (const tile of tilesInView(center, width, height, this.#zoom)) {
      const key = `${this.#zoom}/${tile.x}/${tile.y}`;
      wanted.add(key);
      let image = this.#images.get(key);
      if (!image) {
        image = document.createElement('img');
        image.alt = '';
        image.draggable = false;
        image.decoding = 'async';
        image.width = TILE_SIZE;
        image.height = TILE_SIZE;
        // No connection or no such tile: leave the background showing.
        image.addEventListener('error', () => {
          image.style.visibility = 'hidden';
        });
        image.src = tileUrl(this.#zoom, tile.x, tile.y);
        this.#images.set(key, image);
        this.#tiles.append(image);
      }
      image.style.transform = `translate(${Math.round(tile.left)}px, ${Math.round(tile.top)}px)`;
    }
    for (const [key, image] of this.#images) {
      if (wanted.has(key)) continue;
      image.remove();
      this.#images.delete(key);
    }
  }

  /**
   * The line is written once per new point, in pixels around its first point,
   * and moved as a whole on every frame.
   */
  #drawPath(points, center, width, height) {
    const drawn = this.#drawn;
    if (drawn.points !== points || drawn.length !== points.length || drawn.zoom !== this.#zoom) {
      drawn.points = points;
      drawn.length = points.length;
      drawn.zoom = this.#zoom;
      drawn.anchor = points.length ? project(points[0][0], points[0][1], this.#zoom) : null;
      const anchor = drawn.anchor;
      const text = points.map(([latitude, longitude]) => {
        const point = project(latitude, longitude, this.#zoom);
        return `${(point.x - anchor.x).toFixed(1)},${(point.y - anchor.y).toFixed(1)}`;
      });
      this.#path.setAttribute('points', text.join(' '));
    }
    if (drawn.anchor) {
      const left = drawn.anchor.x - center.x + width / 2;
      const top = drawn.anchor.y - center.y + height / 2;
      this.#path.setAttribute('transform', `translate(${left.toFixed(1)} ${top.toFixed(1)})`);
    }
  }

  /**
   * Draw the map around `position` ({ latitude, longitude }, or null when it
   * is not known yet). `points` are the fixes driven so far as [latitude,
   * longitude]; `heading` and `course` are degrees clockwise from north or
   * null. Without a heading the car is turned along the course.
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
