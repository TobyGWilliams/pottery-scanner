// Pure maths for turning WebXR CPU depth buffers into 3D points.
// All matrices are column-major Float32Array/Array(16), as WebXR and WebGL use.

export function mul4(a, b, out = new Float32Array(16)) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

// Inverse of a rigid transform (rotation + translation only).
export function invRigid(m, out = new Float32Array(16)) {
  const r00 = m[0], r10 = m[1], r20 = m[2];
  const r01 = m[4], r11 = m[5], r21 = m[6];
  const r02 = m[8], r12 = m[9], r22 = m[10];
  const tx = m[12], ty = m[13], tz = m[14];
  out[0] = r00; out[1] = r01; out[2] = r02; out[3] = 0;
  out[4] = r10; out[5] = r11; out[6] = r12; out[7] = 0;
  out[8] = r20; out[9] = r21; out[10] = r22; out[11] = 0;
  out[12] = -(r00 * tx + r10 * ty + r20 * tz);
  out[13] = -(r01 * tx + r11 * ty + r21 * tz);
  out[14] = -(r02 * tx + r12 * ty + r22 * tz);
  out[15] = 1;
  return out;
}

/**
 * Per-depth-pixel view-space ray table.
 *
 * For depth pixel (col,row) the view-space point at depth d (metres from the
 * camera plane) is (table[2i]*d, table[2i+1]*d, -d).
 *
 * @param proj              view.projectionMatrix
 * @param normViewFromDepth inverse of depthInfo.normDepthBufferFromNormView
 *                          (i.e. depthInfo.normDepthBufferFromNormView.inverse.matrix)
 *
 * Normalised view coordinates have their origin top-left, y down (WebXR
 * depth-sensing spec §1.1), hence the y flip going to NDC.
 */
export function buildRayTable(proj, normViewFromDepth, width, height) {
  const t = new Float32Array(width * height * 2);
  const m = normViewFromDepth;
  const p0 = proj[0], p5 = proj[5], p8 = proj[8], p9 = proj[9];
  for (let row = 0; row < height; row++) {
    const vd = (row + 0.5) / height;
    for (let col = 0; col < width; col++) {
      const ud = (col + 0.5) / width;
      const u = m[0] * ud + m[4] * vd + m[12];
      const v = m[1] * ud + m[5] * vd + m[13];
      const ndcX = 2 * u - 1;
      const ndcY = 1 - 2 * v;
      const i = (row * width + col) * 2;
      t[i] = (ndcX + p8) / p0;
      t[i + 1] = (ndcY + p9) / p5;
    }
  }
  return t;
}

/** Growable store of scan points, kept in the pot frame (origin = tapped centre on the table, +y = up). */
export class ScanBuffer {
  constructor(capacity = 2_000_000, maxFrames = 20_000) {
    this.capacity = capacity;
    this.pts = new Float32Array(capacity * 3);
    this.frame = new Uint32Array(capacity);
    this.cams = new Float32Array(maxFrames * 3);
    this.maxFrames = maxFrames;
    this.n = 0;
    this.nFrames = 0;
  }
  get full() {
    return this.n >= this.capacity || this.nFrames >= this.maxFrames;
  }
  beginFrame(cx, cy, cz) {
    const f = this.nFrames++;
    this.cams[f * 3] = cx; this.cams[f * 3 + 1] = cy; this.cams[f * 3 + 2] = cz;
    return f;
  }
  add(x, y, z) {
    if (this.n >= this.capacity) return;
    const i = this.n++;
    this.pts[i * 3] = x; this.pts[i * 3 + 1] = y; this.pts[i * 3 + 2] = z;
    this.frame[i] = this.nFrames - 1;
  }
}

export const CAPTURE = {
  roi: 0.22,        // m, horizontal radius around the tapped centre that is kept
  hLow: -0.02,      // m, keep a little table so its height can be self-calibrated
  hHigh: 0.45,      // m
  dMin: 0.12,       // m, depth range accepted
  dMax: 1.2,
  edgeRel: 0.03,    // neighbour depth jump (fraction of depth) treated as a flying pixel
};

/**
 * Unproject one depth frame into the scan buffer.
 * @param data          Uint16Array | Float32Array depth buffer
 * @param rawToMeters   depthInfo.rawValueToMeters
 * @param rays          table from buildRayTable
 * @param potFromView   4x4: view space -> pot frame
 * @returns number of points added
 */
export function captureDepthFrame(buf, data, width, height, rawToMeters, rays, potFromView, cfg = CAPTURE) {
  const m = potFromView;
  buf.beginFrame(m[12], m[13], m[14]);
  const roi2 = cfg.roi * cfg.roi;
  const before = buf.n;
  let tableSkip = 0;
  for (let row = 1; row < height - 1; row++) {
    for (let col = 1; col < width - 1; col++) {
      const i = row * width + col;
      const d = data[i] * rawToMeters;
      if (!(d > cfg.dMin && d < cfg.dMax)) continue;
      // Reject depth discontinuities: pixels straddling an edge are smeared between surfaces.
      const lim = cfg.edgeRel * d / rawToMeters;
      const raw = data[i];
      const a = data[i - 1], b = data[i + 1], c = data[i - width], e = data[i + width];
      if (a === 0 || b === 0 || c === 0 || e === 0) continue;
      if (Math.abs(a - raw) > lim || Math.abs(b - raw) > lim || Math.abs(c - raw) > lim || Math.abs(e - raw) > lim) continue;
      const vx = rays[i * 2] * d, vy = rays[i * 2 + 1] * d, vz = -d;
      const y = m[1] * vx + m[5] * vy + m[9] * vz + m[13];
      if (y < cfg.hLow || y > cfg.hHigh) continue;
      const x = m[0] * vx + m[4] * vy + m[8] * vz + m[12];
      const z = m[2] * vx + m[6] * vy + m[10] * vz + m[14];
      if (x * x + z * z > roi2) continue;
      // The table is only needed for a height reference: keep 1 in 4 of its points.
      if (y < 0.004 && (tableSkip++ & 3) !== 0) continue;
      buf.add(x, y, z);
    }
  }
  return buf.n - before;
}
