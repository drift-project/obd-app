// Map arithmetic for the drift view: the Web Mercator projection that map
// tiles use, the tiles that cover a view and a step along a course.

export const TILE_SIZE = 256;

const RADIANS = Math.PI / 180;
const EARTH_RADIUS_M = 6371008.8; // mean radius, for distances on the ground
const MERCATOR_RADIUS_M = 6378137; // the sphere the map projection is drawn on
const MAX_LATITUDE = 85.05112878; // the edge of the square Web Mercator world

/** Position in pixels of the whole-world map at `zoom` (256 pixels wide at zoom 0). */
export function project(latitude, longitude, zoom) {
  const size = TILE_SIZE * 2 ** zoom;
  const clamped = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, latitude));
  const sine = Math.sin(clamped * RADIANS);
  return {
    x: ((longitude + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * size,
  };
}

/**
 * Tiles that cover a view of `width` by `height` pixels centred on the world
 * pixel `center`: `[{ x, y, left, top }]`, with left and top in view pixels.
 * Columns wrap around the date line; rows outside the world are left out.
 */
export function tilesInView(center, width, height, zoom) {
  const count = 2 ** zoom;
  const originX = center.x - width / 2;
  const originY = center.y - height / 2;
  const tiles = [];
  for (let row = Math.floor(originY / TILE_SIZE); row * TILE_SIZE < originY + height; row += 1) {
    if (row < 0 || row >= count) continue;
    for (let column = Math.floor(originX / TILE_SIZE); column * TILE_SIZE < originX + width; column += 1) {
      tiles.push({
        x: ((column % count) + count) % count,
        y: row,
        left: column * TILE_SIZE - originX,
        top: row * TILE_SIZE - originY,
      });
    }
  }
  return tiles;
}

/** The point `meters` away from a position along `course` (degrees clockwise from north). Good for short steps. */
export function advance(latitude, longitude, course, meters) {
  const north = (Math.cos(course * RADIANS) * meters) / EARTH_RADIUS_M;
  const east = (Math.sin(course * RADIANS) * meters) / EARTH_RADIUS_M;
  return {
    latitude: latitude + north / RADIANS,
    longitude: longitude + east / RADIANS / Math.cos(latitude * RADIANS),
  };
}

/** The position `east` and `north` metres away from another. Good for short distances. */
export function offsetBy({ latitude, longitude }, east, north) {
  return {
    latitude: latitude + north / EARTH_RADIUS_M / RADIANS,
    longitude: longitude + east / (EARTH_RADIUS_M * Math.cos(latitude * RADIANS)) / RADIANS,
  };
}

/** Metres east and north from one position to another. Good for short distances. */
export function metersBetween(from, to) {
  return {
    east: (to.longitude - from.longitude) * RADIANS * EARTH_RADIUS_M * Math.cos(from.latitude * RADIANS),
    north: (to.latitude - from.latitude) * RADIANS * EARTH_RADIUS_M,
  };
}

/** Metres that one pixel of the map covers at a latitude and zoom. */
export function metersPerPixel(latitude, zoom) {
  return (2 * Math.PI * MERCATOR_RADIUS_M * Math.cos(latitude * RADIANS)) / (TILE_SIZE * 2 ** zoom);
}
