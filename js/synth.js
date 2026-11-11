// Synthetic scan generator: ray-casts a virtual pot from a ring of virtual phone
// positions and adds depth noise. Used by the tests and by the in-app demo.

import { ScanBuffer } from './depth.js';

const MM = 0.001;

/** A mug-like pot: 110 mm tall, walls 4 mm at the rim thickening to 9 mm at the base, 7 mm floor. */
export function demoPot() {
  const H = 0.11, tf = 7 * MM;
  const rOut = (h) => 0.045 + 0.006 * Math.sin((h / H) * Math.PI);
  const wall = (h) => (9 - 5 * (h / H)) * MM;
  const rIn = (h) => rOut(h) - wall(h);
  const rc = rIn(tf) - 0.012;
  const floorH = (r) => tf + (r > rc ? 30 * (r - rc) * (r - rc) : 0); // rounded inside corner
  return { H, rOut, rIn, floorH, rMax: 0.052 };
}

function inClay(pot, r, h) {
  if (h < 0 || h > pot.H || r > pot.rOut(h)) return false;
  return !(h > pot.floorH(r) && r < pot.rIn(h));
}

function gauss(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param o.noise      depth noise sigma (m), along the ray
 * @param o.depthScale multiplicative depth bias (1 = none)
 * @param o.offset     [x,z] of the true pot axis relative to the tapped centre
 * @param o.tableErr   true table height relative to the anchor plane (m)
 * @param o.grid       [cols, rows] of the virtual depth image
 * @param o.azimuths   camera positions per ring
 */
export function synthScan(pot = demoPot(), o = {}) {
  const noise = o.noise ?? 2.5 * MM, scale = o.depthScale ?? 1;
  const [ox, oz] = o.offset ?? [0.012, -0.009];
  const tableErr = o.tableErr ?? 0.003;
  const [W, Hpx] = o.grid ?? [120, 90];
  const nAz = o.azimuths ?? 24;
  const rand = mulberry32(o.seed ?? 7);
  const buf = new ScanBuffer(o.capacity ?? 1_500_000, 4000);
  const rings = [
    { height: 0.07, dist: 0.36, n: nAz },           // low orbit: outside only
    { height: 0.34, dist: 0.26, n: nAz },           // high orbit: far inside wall + near outside
    { height: 0.42, dist: 0.07, n: Math.ceil(nAz / 2) }, // nearly overhead: floor + lower walls
  ];
  const tanX = Math.tan((62 * Math.PI) / 360), tanY = tanX * (Hpx / W);
  const Rb = pot.rMax + 0.005, ROI = 0.22;
  for (const ring of rings) {
    for (let a = 0; a < ring.n; a++) {
      const az = (a / ring.n) * 2 * Math.PI + ring.height;
      const C = [ring.dist * Math.cos(az), ring.height, ring.dist * Math.sin(az)];
      const T = [0, pot.H * 0.5, 0];
      // camera basis
      let f = [T[0] - C[0], T[1] - C[1], T[2] - C[2]];
      const fl = Math.hypot(...f); f = f.map((v) => v / fl);
      let rt = [f[2], 0, -f[0]]; // f x up(0,1,0) = (-f.z,0,f.x) -> sign irrelevant here
      const rl = Math.hypot(...rt) || 1; rt = rt.map((v) => v / rl);
      const up = [rt[1] * f[2] - rt[2] * f[1], rt[2] * f[0] - rt[0] * f[2], rt[0] * f[1] - rt[1] * f[0]];
      buf.beginFrame(C[0] + ox, C[1] + tableErr, C[2] + oz);
      for (let py = 0; py < Hpx; py++) {
        for (let px = 0; px < W; px++) {
          const sx = ((px + 0.5) / W * 2 - 1) * tanX, sy = ((py + 0.5) / Hpx * 2 - 1) * tanY;
          let d = [f[0] + sx * rt[0] + sy * up[0], f[1] + sx * rt[1] + sy * up[1], f[2] + sx * rt[2] + sy * up[2]];
          const dl = Math.hypot(...d); d = d.map((v) => v / dl);
          // range of t where the ray is inside the bounding cylinder
          const A = d[0] * d[0] + d[2] * d[2], B = 2 * (C[0] * d[0] + C[2] * d[2]), Cc = C[0] * C[0] + C[2] * C[2] - Rb * Rb;
          const disc = B * B - 4 * A * Cc;
          let hit = -1;
          if (disc > 0 && A > 1e-12) {
            const t0 = Math.max(0, (-B - Math.sqrt(disc)) / (2 * A)), t1 = (-B + Math.sqrt(disc)) / (2 * A);
            for (let t = t0; t < t1; t += 1.5 * MM) {
              const h = C[1] + t * d[1];
              if (h < 0) break;
              if (inClay(pot, Math.hypot(C[0] + t * d[0], C[2] + t * d[2]), h)) {
                let lo = t - 1.5 * MM, hi = t;
                for (let b = 0; b < 8; b++) {
                  const mid = (lo + hi) / 2;
                  if (inClay(pot, Math.hypot(C[0] + mid * d[0], C[2] + mid * d[2]), C[1] + mid * d[1])) hi = mid; else lo = mid;
                }
                hit = hi;
                break;
              }
            }
          }
          let isTable = false;
          if (hit < 0) {
            if (d[1] >= -1e-6) continue;
            hit = -C[1] / d[1]; // table plane
            isTable = true;
          }
          const t = hit * scale + noise * gauss(rand);
          const x = C[0] + t * d[0], y = C[1] + t * d[1], z = C[2] + t * d[2];
          if (x * x + z * z > ROI * ROI) continue;
          if (isTable && rand() > 0.25) continue;
          buf.add(x + ox, y + tableErr, z + oz);
        }
      }
    }
  }
  return buf;
}

/** True perpendicular wall thickness at height h (distance from the inner wall to the outer surface). */
export function trueWallThickness(pot, h) {
  const r = pot.rIn(h);
  let best = Infinity;
  for (let hh = 0; hh <= pot.H; hh += 0.25 * MM) best = Math.min(best, Math.hypot(pot.rOut(hh) - r, hh - h));
  return best;
}
