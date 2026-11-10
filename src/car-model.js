// The car on the map: a few boxes for the 3D view, a plain shape for the flat
// map. Both are painted on the canvas over the map tiles.
//
// The model is in its own pixels, x to the right of the car, y to the back
// and z up, the front at -y. It is drawn with the faces that look away from
// the viewer left out and the others from the furthest to the nearest, each
// lit by a sun high in the north-west, so the car keeps its shape as it
// turns.

import { inView, toScreen } from './camera.js';

export const MODEL_LENGTH = 44; // bumper to bumper, in model pixels

const RADIANS = Math.PI / 180;
const unit = (v) => {
  const size = Math.hypot(...v);
  return v.map((value) => value / size);
};
// x east, y south, z up.
const SUN = unit([-0.35, -0.45, 0.82]);

const PAINT = [235, 52, 46];
const ROOF = [210, 40, 36];
const GLASS = [26, 38, 50];
const TYRE = [18, 21, 25];
const HEADLIGHT = 'rgb(255, 236, 170)';
const TAILLIGHT = 'rgb(255, 48, 48)';

/** A face: four corners in order round its edge, the middle of the solid it belongs to, a colour and lights painted on it. */
const face = (name, corners, middle, color, lights = []) => ({ name, corners, middle, color, lights });

function box(name, [x0, x1], [y0, y1], [z0, z1], color, { front = [], back = [], roof = color } = {}) {
  const middle = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  return [
    face(`${name} top`, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], middle, roof),
    // Corners from the top left as seen from outside, so lights can be placed by their share of width and height.
    face(`${name} front`, [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]], middle, color, front),
    face(`${name} back`, [[x1, y1, z1], [x0, y1, z1], [x0, y1, z0], [x1, y1, z0]], middle, color, back),
    face(`${name} left`, [[x0, y1, z1], [x0, y0, z1], [x0, y0, z0], [x0, y1, z0]], middle, color),
    face(`${name} right`, [[x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0]], middle, color),
  ];
}

function cabin() {
  const bottom = { x: 8.8, front: -7.5, back: 14, z: 9 };
  const top = { x: 7.4, front: -1.5, back: 9.5, z: 14.5 };
  const middle = [0, 3.5, 11.75];
  const corner = (side, end, level) => [side * level.x, level[end], level.z];
  return [
    face('cabin roof', [corner(-1, 'front', top), corner(1, 'front', top), corner(1, 'back', top), corner(-1, 'back', top)], middle, ROOF),
    face('windscreen', [corner(-1, 'front', top), corner(1, 'front', top), corner(1, 'front', bottom), corner(-1, 'front', bottom)], middle, GLASS),
    face('rear window', [corner(1, 'back', top), corner(-1, 'back', top), corner(-1, 'back', bottom), corner(1, 'back', bottom)], middle, GLASS),
    face('left windows', [corner(-1, 'back', top), corner(-1, 'front', top), corner(-1, 'front', bottom), corner(-1, 'back', bottom)], middle, GLASS),
    face('right windows', [corner(1, 'front', top), corner(1, 'back', top), corner(1, 'back', bottom), corner(1, 'front', bottom)], middle, GLASS),
  ];
}

const LIGHTS = (color) => [
  { color, u: [0.06, 0.3], v: [0.18, 0.5] },
  { color, u: [0.7, 0.94], v: [0.18, 0.5] },
];

export const CAR_FACES = [
  ...[
    [[-11.5, -6.5], [-17.5, -8.5]],
    [[6.5, 11.5], [-17.5, -8.5]],
    [[-11.5, -6.5], [8.5, 17.5]],
    [[6.5, 11.5], [8.5, 17.5]],
  ].flatMap(([x, y], index) => box(`wheel ${index + 1}`, x, y, [0, 6.5], TYRE)),
  ...box('body', [-10, 10], [-22, 22], [2.5, 9], PAINT, { front: LIGHTS(HEADLIGHT), back: LIGHTS(TAILLIGHT) }),
  ...cabin(),
];

const shade = (color, light) => `rgb(${color.map((value) => Math.round(Math.min(255, value * light))).join(', ')})`;

/**
 * The faces of the car that the camera sees, furthest first, each with its
 * corners on the screen, its colour as lit and its lights: the car with its
 * middle at the car's place, pointing `heading` degrees clockwise from
 * north, `scale` times the model size.
 */
export function visibleFaces(cam, { heading, scale }) {
  const turn = heading * RADIANS;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  // Model to ground: turned by the heading (the front, -y, points along it), scaled, height kept as height.
  const ground = ([x, y, z]) => [(x * cos - y * sin) * scale, (x * sin + y * cos) * scale, z * scale];
  const out = [];
  for (const { name, corners, middle, color, lights } of CAR_FACES) {
    const points = corners.map(ground);
    const centre = points.reduce((sum, point) => sum.map((value, axis) => value + point[axis] / points.length), [0, 0, 0]);
    // The outward normal, from two edges, turned to point away from the middle of its solid.
    const a = points[1].map((value, axis) => value - points[0][axis]);
    const b = points[3].map((value, axis) => value - points[0][axis]);
    let normal = unit([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
    const inside = ground(middle);
    if (normal.reduce((sum, value, axis) => sum + value * (centre[axis] - inside[axis]), 0) < 0) normal = normal.map((value) => -value);
    // Seen from the viewer's side? (For the flat map the viewer looks straight down.)
    const seenAt = inView(cam, ...centre);
    const tip = inView(cam, centre[0] + normal[0], centre[1] + normal[1], centre[2] + normal[2]);
    const facing = [tip.x - seenAt.x, tip.y - seenAt.y, tip.z - seenAt.z];
    const towardViewer = cam.tilted ? [-seenAt.x, -seenAt.y, cam.perspective - seenAt.z] : [0, 0, 1];
    if (facing.reduce((sum, value, axis) => sum + value * towardViewer[axis], 0) <= 1e-9) continue;
    const screen = points.map((point) => toScreen(cam, ...point));
    if (screen.some((point) => point === null)) continue;
    const lit = 0.42 + 0.58 * Math.max(0, normal.reduce((sum, value, axis) => sum + value * SUN[axis], 0));
    const at = (u, v) => {
      // Corners 0, 1 and 3 span the face: 0 top left, 1 top right, 3 bottom left.
      const point = points[0].map((value, axis) => value + (points[1][axis] - value) * u + (points[3][axis] - value) * v);
      return toScreen(cam, ...point);
    };
    out.push({
      name,
      depth: toScreen(cam, ...centre).depth,
      corners: screen,
      color: shade(color, lit),
      edge: shade(color, lit * 0.7),
      lights: lights.map((light) => ({
        color: light.color,
        corners: [at(light.u[0], light.v[0]), at(light.u[1], light.v[0]), at(light.u[1], light.v[1]), at(light.u[0], light.v[1])],
      })),
    });
  }
  return out.sort((first, second) => second.depth - first.depth);
}

function polygon(ctx, corners) {
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (const corner of corners.slice(1)) ctx.lineTo(corner.x, corner.y);
  ctx.closePath();
}

/**
 * Paint the 3D car with its shadow. `faint` paints it see-through: the way
 * the body points is then only a guess.
 */
export function paintCar(ctx, cam, { heading, scale, faint = false }) {
  const turn = heading * RADIANS;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const onGround = (x, y) => toScreen(cam, (x * cos - y * sin) * scale, (x * sin + y * cos) * scale);
  ctx.save();
  ctx.globalAlpha = faint ? 0.45 : 1;
  // A soft shadow: a wide faint one and a darker one the size of the car.
  for (const [width, length, alpha] of [[15, 29, 0.14], [12, 25, 0.3]]) {
    const corners = [onGround(-width, -length), onGround(width, -length), onGround(width, length), onGround(-width, length)];
    if (corners.some((corner) => corner === null)) continue;
    polygon(ctx, corners);
    ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
    ctx.fill();
  }
  ctx.lineJoin = 'round';
  ctx.lineWidth = 0.6;
  for (const { corners, color, edge, lights } of visibleFaces(cam, { heading, scale })) {
    polygon(ctx, corners);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = edge;
    ctx.stroke();
    for (const light of lights) {
      if (light.corners.some((corner) => corner === null)) continue;
      polygon(ctx, light.corners);
      ctx.fillStyle = light.color;
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * The car on the flat map, as seen from above: `x`, `y` on the screen,
 * pointing `direction` degrees clockwise from north. `guessed` draws only
 * its outline: where it points is then only the direction of travel.
 */
export function paintFlatCar(ctx, x, y, direction, guessed = false) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(direction * RADIANS);
  ctx.beginPath();
  ctx.roundRect(-9, -19, 18, 38, 6);
  ctx.fillStyle = guessed ? 'rgba(255, 70, 64, 0.25)' : 'rgb(255, 70, 64)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#fff';
  if (guessed) ctx.setLineDash([3, 3]);
  ctx.stroke();
  if (!guessed) {
    ctx.fillStyle = '#2a0d0c';
    for (const glass of [
      [[-6, -10], [6, -10], [5, -3], [-5, -3]],
      [[-5, 8], [5, 8], [6, 13], [-6, 13]],
    ]) {
      ctx.beginPath();
      ctx.moveTo(...glass[0]);
      for (const point of glass.slice(1)) ctx.lineTo(...point);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}
