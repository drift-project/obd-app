// The camera of the map. Flat, it looks straight down with north up and the
// car in the middle. In 3D it follows behind and above the car, as the chase
// view of a racing game does: the ground is tilted away from the viewer and
// turned so that the car drives up the screen, and things further ahead are
// drawn smaller.
//
// The ground is a plane in the coordinates the map is drawn in: x to the
// east and y to the south, in pixels of the map at its zoom, measured from
// the car. Height above the ground is `up`, in the same pixels.
//
// The browser draws the map tiles with a CSS 3D transform and the line and
// the car are painted on a canvas with toScreen(). Both follow the same
// sums, so what is painted sits exactly on the tiles: the ground is turned
// by rotateZ(-bearing), tilted by rotateX(tilt) and seen through
// `perspective` from above the place the car is drawn.

const RADIANS = Math.PI / 180;
// Looking down steeply enough that on a phone the ground reaches the top of the view, without sky. On a taller
// view the ground ends FAR_PX ahead, under a strip of sky.
export const TILT_DEG = 40;
export const FAR_PX = 2000; // how far ahead the ground is drawn at most
const CAR_DOWN = 0.78; // how far down the view the car sits in 3D

/**
 * The camera for a view of `width` by `height` pixels: flat, or `tilted`
 * behind the car with the direction `bearing` (degrees clockwise from north)
 * pointing up the screen.
 */
export function camera({ width, height, tilted = false, bearing = 0 }) {
  const tilt = tilted ? TILT_DEG * RADIANS : 0;
  const carY = tilted ? height * CAR_DOWN : height / 2;
  const perspective = tilted ? Math.max(height * 0.9, 320) : Infinity;
  const turn = tilted ? bearing * RADIANS : 0;
  return {
    width,
    height,
    tilted,
    tilt,
    carX: width / 2,
    carY,
    perspective,
    bearing: tilted ? bearing : 0,
    cos: Math.cos(turn),
    sin: Math.sin(turn),
    cosTilt: Math.cos(tilt),
    sinTilt: Math.sin(tilt),
    far: tilted ? FAR_PX : Infinity,
    // Where the ground meets the sky, in pixels from the top of the view.
    horizon: tilted ? carY - perspective / Math.tan(tilt) : -Infinity,
  };
}

/**
 * The turned and tilted place of a ground point `x`, `y` from the car at
 * height `up`: `{ x, y, z }` with x and y measured on the screen from where
 * the car is drawn and z towards the viewer. `ahead` is how far ahead of
 * the car the point lies along the bearing, before the tilt.
 */
export function inView(cam, x, y, up = 0) {
  // rotateZ(-bearing): the direction of travel points up the screen.
  const x1 = cam.cos * x + cam.sin * y;
  const y1 = -cam.sin * x + cam.cos * y;
  // rotateX(tilt): what lies ahead goes away from the viewer, and height comes towards it.
  return { x: x1, y: y1 * cam.cosTilt - up * cam.sinTilt, z: y1 * cam.sinTilt + up * cam.cosTilt, ahead: -y1 };
}

/**
 * Where a ground point appears on the screen: `{ x, y, scale, depth }` in
 * view pixels, with `scale` how much larger than on the flat map things are
 * drawn there and `depth` the distance from the viewer. Null for a point at
 * or behind the viewer.
 */
export function toScreen(cam, x, y, up = 0) {
  const point = inView(cam, x, y, up);
  if (!cam.tilted) return { x: cam.carX + point.x, y: cam.carY + point.y, scale: 1, depth: -up };
  const w = 1 - point.z / cam.perspective;
  if (w <= 0.05) return null;
  return {
    x: cam.carX + point.x / w,
    y: cam.carY + point.y / w,
    scale: 1 / w,
    depth: Math.hypot(point.x, point.y, cam.perspective - point.z),
  };
}

/** The ground point seen at a place on the screen, `{ x, y }` from the car, or null above the horizon. */
export function toGround(cam, screenX, screenY) {
  const u = screenX - cam.carX;
  const v = screenY - cam.carY;
  let x1 = u;
  let y1 = v;
  if (cam.tilted) {
    const below = cam.perspective * cam.cosTilt + v * cam.sinTilt;
    if (below <= 0) return null;
    y1 = (v * cam.perspective) / below;
    x1 = u * (1 - (y1 * cam.sinTilt) / cam.perspective);
  }
  // Turned back from the screen to the map.
  return { x: cam.cos * x1 - cam.sin * y1, y: cam.sin * x1 + cam.cos * y1 };
}

/**
 * The part of the ground the view shows, as four corners from the car in
 * order round the edge (bottom left, bottom right, far right, far left).
 * In 3D it ends at the haze, `far` pixels ahead.
 */
export function visibleGround(cam) {
  const { width, height } = cam;
  const near = [toGround(cam, 0, height), toGround(cam, width, height)];
  let farCorners = [toGround(cam, width, 0), toGround(cam, 0, 0)];
  if (cam.tilted) {
    const tooFar = farCorners.some((corner) => !corner || inView(cam, corner.x, corner.y).ahead > cam.far);
    if (tooFar) {
      // The far edge is the line `far` ahead, as wide as the view is there.
      const widen = 1 + (cam.far * cam.sinTilt) / cam.perspective;
      farCorners = [(width - cam.carX) * widen, -cam.carX * widen].map((x1) => ({
        x: cam.cos * x1 - cam.sin * -cam.far,
        y: cam.sin * x1 + cam.cos * -cam.far,
      }));
    }
  }
  return [...near, ...farCorners];
}

/**
 * The CSS for the element that holds the ground in its own pixels, with the
 * car at `groundX`, `groundY` in them: the transform of that element (its
 * transform origin at 0 0) and the perspective of its parent.
 */
export function groundCss(cam, groundX, groundY) {
  const px = (value) => `${value.toFixed(2)}px`;
  const transform = cam.tilted
    ? `translate3d(${px(cam.carX)}, ${px(cam.carY)}, 0) rotateX(${cam.tilt.toFixed(5)}rad) rotateZ(${(-cam.bearing * RADIANS).toFixed(5)}rad) translate3d(${px(-groundX)}, ${px(-groundY)}, 0)`
    : // Flat, on whole pixels: tiles placed between pixels show a faint line where they meet.
      `translate3d(${px(Math.round(cam.carX - groundX))}, ${px(Math.round(cam.carY - groundY))}, 0)`;
  return {
    transform,
    perspective: cam.tilted ? px(cam.perspective) : 'none',
    origin: `${px(cam.carX)} ${px(cam.carY)}`,
  };
}
