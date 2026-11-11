// Turns a cloud of depth points of a round pot into inner/outer profiles and wall thickness.
// Pure module: no DOM, runs in the browser and in Node (tests).
//
// Frame: origin at the tapped centre on the table, +y up (table normal). Units: metres.
//
// Method
//  1. Table height is re-estimated from depth points around the pot, so pot and table
//     share the same depth bias.
//  2. The rotation axis is fitted as the common centre of concentric rings.
//  3. Each point is labelled inside/outside by pure visibility geometry: a ray can only
//     reach the inside of an open pot by passing through the opening (the rim disc).
//     This does not depend on the (noisy) depth value at all, only on the ray.
//  4. Rotational symmetry collapses everything into a 2D (radius, height) half-section,
//     where thousands of noisy samples per bin are reduced by medians.
//  5. Thickness = distance from the inner profile to the outer profile (or to the table
//     under the base).

const MM = 0.001;
const SLAB = 4 * MM;       // ring height for the axis fit
const DH = 2 * MM;         // outer profile bin height
const NB = 120;            // inner profile angular bins (0..180 deg about a point on the axis)
const RIM_MARGIN = 4 * MM; // rays crossing the rim plane this close to the rim are ambiguous
const SECTORS = 36;

function sortedCopy(arr, n = arr.length) {
  return Float32Array.from(arr.subarray(0, n)).sort();
}
function quantileSorted(s, q) {
  if (!s.length) return NaN;
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1) + 0.5)))];
}

// Median and MAD of `vals` per group key (key < 0 = skip).
function groupStats(keys, vals, K, count = keys.length) {
  const off = new Int32Array(K + 1);
  for (let i = 0; i < count; i++) if (keys[i] >= 0) off[keys[i] + 1]++;
  for (let k = 0; k < K; k++) off[k + 1] += off[k];
  const buf = new Float32Array(off[K]);
  const pos = off.slice(0, K);
  for (let i = 0; i < count; i++) if (keys[i] >= 0) buf[pos[keys[i]]++] = vals[i];
  const n = new Int32Array(K), med = new Float32Array(K), mad = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    const a = off[k], b = off[k + 1];
    n[k] = b - a;
    if (b === a) { med[k] = NaN; mad[k] = NaN; continue; }
    const sub = buf.subarray(a, b).sort();
    const m = sub[(b - a) >> 1];
    med[k] = m;
    for (let i = 0; i < sub.length; i++) sub[i] = Math.abs(sub[i] - m);
    sub.sort();
    mad[k] = sub[(b - a) >> 1];
  }
  return { n, med, mad };
}

// Kernel-weighted local line fit evaluated at x0 (no first-order bias at the ends).
function localLinear(xs, ys, ws, x0, sigma) {
  let S0 = 0, S1 = 0, S2 = 0, T0 = 0, T1 = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = ws[i];
    if (!(w > 0)) continue;
    const d = xs[i] - x0;
    if (Math.abs(d) > 4 * sigma) continue;
    const k = w * Math.exp(-0.5 * d * d / (sigma * sigma));
    S0 += k; S1 += k * d; S2 += k * d * d; T0 += k * ys[i]; T1 += k * d * ys[i];
  }
  if (S0 < 1e-9) return NaN;
  const det = S0 * S2 - S1 * S1;
  if (det < 1e-3 * S0 * S0 * sigma * sigma) return T0 / S0;
  return (S2 * T0 - S1 * T1) / det;
}

/** Inside (1) / outside (0) / unusable (-1), from where the camera ray crosses the rim plane. */
export function classifyPoint(x, y, z, camX, camY, camZ, g) {
  const H = y - g.h0;
  if (H <= g.hMin || H >= g.hRim) return -1;
  const CH = camY - g.h0;
  if (CH <= g.hRim) return 0; // camera below the rim cannot see inside
  const t = (g.hRim - CH) / (H - CH);
  const px = camX + t * (x - camX) - g.cx;
  const pz = camZ + t * (z - camZ) - g.cz;
  const rx = Math.hypot(px, pz);
  if (rx < g.rRim - RIM_MARGIN) return 1;
  if (rx > g.rRim + RIM_MARGIN) return 0;
  return -1;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return { d: Math.hypot(px - qx, py - qy), qx, qy };
}

function refineCentre(X, Z, grp, K, groupOk, cx, cz, count) {
  const sw = new Float64Array(K), swr = new Float64Array(K), sux = new Float64Array(K), suz = new Float64Array(K);
  const rho = new Float64Array(K).fill(NaN);
  const HUBER = 5 * MM;
  for (let iter = 0; iter < 10; iter++) {
    sw.fill(0); swr.fill(0); sux.fill(0); suz.fill(0);
    for (let i = 0; i < count; i++) {
      const g = grp[i];
      if (g < 0 || !groupOk[g]) continue;
      const dx = X[i] - cx, dz = Z[i] - cz;
      const r = Math.hypot(dx, dz) || 1e-9;
      let w = 1;
      if (!Number.isNaN(rho[g])) { const e = Math.abs(r - rho[g]); if (e > HUBER) w = HUBER / e; }
      sw[g] += w; swr[g] += w * r; sux[g] += w * dx / r; suz[g] += w * dz / r;
    }
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < count; i++) {
      const g = grp[i];
      if (g < 0 || !groupOk[g] || sw[g] < 8) continue;
      const dx = X[i] - cx, dz = Z[i] - cz;
      const r = Math.hypot(dx, dz) || 1e-9;
      const mean = swr[g] / sw[g];
      let w = 1;
      if (!Number.isNaN(rho[g])) { const e0 = Math.abs(r - rho[g]); if (e0 > HUBER) w = HUBER / e0; }
      const e = r - mean;
      const ux = dx / r - sux[g] / sw[g], uz = dz / r - suz[g] / sw[g];
      a11 += w * ux * ux; a12 += w * ux * uz; a22 += w * uz * uz;
      b1 += w * ux * e; b2 += w * uz * e;
    }
    for (let g = 0; g < K; g++) rho[g] = sw[g] > 0 ? swr[g] / sw[g] : NaN;
    const lam = 1e-3 * (a11 + a22) + 1e-12;
    a11 += lam; a22 += lam;
    const det = a11 * a22 - a12 * a12;
    if (!(det > 0)) break;
    let sx = (a22 * b1 - a12 * b2) / det, sz = (a11 * b2 - a12 * b1) / det;
    const step = Math.hypot(sx, sz);
    if (step > 15 * MM) { sx *= 15 * MM / step; sz *= 15 * MM / step; }
    cx += sx; cz += sz;
    if (step < 0.02 * MM) break;
  }
  return [cx, cz];
}

/**
 * @param scan {pts:Float32Array(xyz), frame:Uint32Array, cams:Float32Array(xyz per frame), n}
 * @param opts {maxPoints}
 */
export function analyse(scan, opts = {}) {
  const N = scan.n;
  const stride = Math.max(1, Math.ceil(N / (opts.maxPoints || 1e12)));
  const m = Math.floor(N / stride);
  const fail = (message, extra = {}) => ({ ok: false, message, nPoints: N, ...extra });
  if (m < 400) return fail('Collecting depth points…');

  const X = new Float32Array(m), Y = new Float32Array(m), Z = new Float32Array(m);
  const CX = new Float32Array(m), CY = new Float32Array(m), CZ = new Float32Array(m);
  for (let j = 0; j < m; j++) {
    const i = j * stride, f = scan.frame[i];
    X[j] = scan.pts[i * 3]; Y[j] = scan.pts[i * 3 + 1]; Z[j] = scan.pts[i * 3 + 2];
    CX[j] = scan.cams[f * 3]; CY[j] = scan.cams[f * 3 + 1]; CZ[j] = scan.cams[f * 3 + 2];
  }
  const tmp = new Float32Array(m);
  let k = 0;

  // --- rough pot radius about the tapped centre
  for (let j = 0; j < m; j++) if (Y[j] > 8 * MM) tmp[k++] = Math.hypot(X[j], Z[j]);
  if (k < 200) return fail('Point the camera at the pot');
  const rRough = quantileSorted(sortedCopy(tmp, k), 0.97);

  // --- table height from depth points around the pot
  k = 0;
  for (let j = 0; j < m; j++) {
    if (Math.abs(Y[j]) < 20 * MM && Math.hypot(X[j], Z[j]) > rRough + 15 * MM) tmp[k++] = Y[j];
  }
  let h0 = 0, sigT = 2 * MM;
  if (k >= 50) {
    const s = sortedCopy(tmp, k);
    h0 = quantileSorted(s, 0.5);
    for (let i = 0; i < k; i++) s[i] = Math.abs(s[i] - h0);
    s.sort();
    sigT = 1.4826 * quantileSorted(s, 0.5);
  }
  const hMin = Math.min(15 * MM, Math.max(6 * MM, 3 * sigT));

  // --- rim height
  k = 0;
  for (let j = 0; j < m; j++) {
    if (Y[j] - h0 > hMin && Math.hypot(X[j], Z[j]) < rRough + 10 * MM) tmp[k++] = Y[j] - h0;
  }
  if (k < 200) return fail('Point the camera at the pot');
  const hRim = quantileSorted(sortedCopy(tmp, k), 0.985);
  if (hRim < 20 * MM) return fail('No pot found above the table. Is the centre placed on the pot?');

  // --- initial centre: tapped point, or footprint centroid once the pot has been seen all round
  let cx = 0, cz = 0;
  {
    const seen = new Uint8Array(24);
    const G = 5 * MM, W = 120, grid = new Uint8Array(W * W);
    for (let j = 0; j < m; j++) {
      if (Y[j] - h0 <= hMin) continue;
      seen[Math.floor((Math.atan2(Z[j], X[j]) + Math.PI) / (2 * Math.PI) * 24) % 24] = 1;
      const gx = Math.floor(X[j] / G) + W / 2, gz = Math.floor(Z[j] / G) + W / 2;
      if (gx >= 0 && gx < W && gz >= 0 && gz < W) { const c = gz * W + gx; if (grid[c] < 255) grid[c]++; }
    }
    if (seen.reduce((a, b) => a + b, 0) >= 18) {
      let sx = 0, sz = 0, c = 0;
      for (let gz = 0; gz < W; gz++) for (let gx = 0; gx < W; gx++) {
        if (grid[gz * W + gx] >= 3) { sx += (gx - W / 2 + 0.5) * G; sz += (gz - W / 2 + 0.5) * G; c++; }
      }
      if (c > 20) { cx = sx / c; cz = sz / c; }
    }
  }

  // --- alternate: classify <-> fit axis
  const cls = new Int8Array(m);
  const grp = new Int32Array(m);
  const R = new Float32Array(m);
  const NSLAB = Math.ceil(hRim / SLAB) + 1;
  const geom = { cx, cz, h0, hMin, hRim, rRim: rRough };
  const fitStride = Math.max(1, Math.ceil(m / 80000));
  for (let it = 0; it < 3; it++) {
    geom.cx = cx; geom.cz = cz;
    k = 0;
    for (let j = 0; j < m; j++) {
      R[j] = Math.hypot(X[j] - cx, Z[j] - cz);
      if (Math.abs(Y[j] - h0 - hRim) < 6 * MM && R[j] < rRough + 30 * MM) tmp[k++] = R[j];
    }
    if (k < 20) return fail('Rim not found yet. Scan around the top of the pot.');
    geom.rRim = quantileSorted(sortedCopy(tmp, k), 0.5);
    for (let j = 0; j < m; j++) {
      const c = classifyPoint(X[j], Y[j], Z[j], CX[j], CY[j], CZ[j], geom);
      cls[j] = c;
      const use = c === 0 || (c === 1 && it > 0);
      grp[j] = use && j % fitStride === 0 ? c * NSLAB + Math.min(NSLAB - 1, Math.floor((Y[j] - h0) / SLAB)) : -1;
    }
    const gs = groupStats(grp, R, 2 * NSLAB);
    const groupOk = new Uint8Array(2 * NSLAB);
    for (let g = 0; g < 2 * NSLAB; g++) {
      // Rings only: skip sparse slabs and (after the first pass) slabs that are floor, not wall.
      groupOk[g] = gs.n[g] >= 20 && (it === 0 || gs.mad[g] < 8 * MM) ? 1 : 0;
    }
    [cx, cz] = refineCentre(X, Z, grp, 2 * NSLAB, groupOk, cx, cz, m);
  }
  geom.cx = cx; geom.cz = cz;
  let nOuter = 0, nInner = 0;
  const secO = new Int32Array(SECTORS), secI = new Int32Array(SECTORS);
  for (let j = 0; j < m; j++) {
    R[j] = Math.hypot(X[j] - cx, Z[j] - cz);
    const c = classifyPoint(X[j], Y[j], Z[j], CX[j], CY[j], CZ[j], geom);
    cls[j] = c;
    if (c < 0) continue;
    const s = Math.floor((Math.atan2(Z[j] - cz, X[j] - cx) + Math.PI) / (2 * Math.PI) * SECTORS) % SECTORS;
    if (c === 0) { nOuter++; secO[s]++; } else { nInner++; secI[s]++; }
  }
  const secMin = Math.max(3, Math.round(40 / stride));
  const coverage = {
    outer: secO.reduce((a, v) => a + (v >= secMin ? 1 : 0), 0) / SECTORS,
    inner: secI.reduce((a, v) => a + (v >= secMin ? 1 : 0), 0) / SECTORS,
  };
  const base = {
    nPoints: N, nOuter: nOuter * stride, nInner: nInner * stride, coverage,
    centre: [cx, cz], h0, hRim, rRim: geom.rRim, hMin, geom: { ...geom },
  };
  const minN = 6;

  // --- outer profile r(h)
  const NH = Math.ceil(hRim / DH);
  for (let j = 0; j < m; j++) grp[j] = cls[j] === 0 ? Math.min(NH - 1, Math.floor((Y[j] - h0) / DH)) : -1;
  const so = groupStats(grp, R, NH);
  const hs = new Float32Array(NH), ws = new Float32Array(NH);
  let i0 = -1, i1 = -1;
  for (let i = 0; i < NH; i++) {
    hs[i] = (i + 0.5) * DH;
    ws[i] = so.n[i] >= minN && hs[i] > hMin ? Math.min(so.n[i], 200) : 0;
    if (ws[i] > 0) { if (i0 < 0) i0 = i; i1 = i; }
  }
  if (i0 < 0 || i1 - i0 < 5) return { ...fail('Scan around the outside of the pot'), ...base };
  const outer = [];
  const madO = [];
  for (let i = i0; i <= i1; i++) {
    const r = localLinear(hs, so.med, ws, hs[i], 5 * MM);
    if (!Number.isNaN(r)) outer.push({ r, h: hs[i], n: so.n[i] * stride });
    if (ws[i] > 0) madO.push(so.mad[i]);
  }
  outer.unshift({ r: outer[0].r, h: 0, n: 0 }); // lowest few mm are hidden in table noise: extend straight down
  base.outer = outer;

  // --- inner profile, polar about a point on the axis inside the cavity
  const hO = 0.55 * hRim;
  const RHO = tmp;
  for (let j = 0; j < m; j++) {
    if (cls[j] !== 1) { grp[j] = -1; continue; }
    const dh = hO - (Y[j] - h0);
    RHO[j] = Math.hypot(R[j], dh);
    grp[j] = Math.min(NB - 1, Math.floor(Math.atan2(R[j], dh) / Math.PI * NB));
  }
  const si = groupStats(grp, RHO, NB);
  const as = new Float32Array(NB), wi = new Float32Array(NB);
  let b0 = -1, b1 = -1, nValid = 0;
  for (let b = 0; b < NB; b++) {
    as[b] = (b + 0.5) / NB * Math.PI;
    wi[b] = si.n[b] >= minN ? Math.min(si.n[b], 200) : 0;
    if (wi[b] > 0) { if (b0 < 0) b0 = b; b1 = b; nValid++; }
  }
  if (nValid < 12) return { ...fail('Now look down into the pot to scan the inside'), ...base };
  const inner = [];
  const madI = [];
  const sigA = 2 * Math.PI / NB;
  for (let b = b0; b <= b1; b++) {
    const rho = localLinear(as, si.med, wi, as[b], sigA);
    if (Number.isNaN(rho)) continue;
    inner.push({ r: rho * Math.sin(as[b]), h: hO - rho * Math.cos(as[b]), n: si.n[b] * stride, interp: wi[b] === 0 });
    if (wi[b] > 0) madI.push(si.mad[b]);
  }
  if (inner[0].r > 2 * MM) inner.unshift({ r: 0, h: inner[0].h, n: 0, interp: true });

  // --- thickness: inner vertex -> nearest point of (table under base + outer wall)
  const outerR = (h) => {
    if (h <= outer[0].h) return outer[0].r;
    for (let i = 1; i < outer.length; i++) {
      if (h <= outer[i].h) {
        const f = (h - outer[i - 1].h) / (outer[i].h - outer[i - 1].h || 1);
        return outer[i - 1].r + f * (outer[i].r - outer[i - 1].r);
      }
    }
    return outer[outer.length - 1].r;
  };
  let s = 0;
  for (let i = 0; i < inner.length; i++) {
    const p = inner[i];
    if (i > 0) s += Math.hypot(p.r - inner[i - 1].r, p.h - inner[i - 1].h);
    p.s = s;
    let best = distToSegment(p.r, p.h, 0, 0, outer[0].r, 0);
    let zone = 'floor';
    for (let q = 1; q < outer.length; q++) {
      const d = distToSegment(p.r, p.h, outer[q - 1].r, outer[q - 1].h, outer[q].r, outer[q].h);
      if (d.d < best.d) { best = d; zone = 'wall'; }
    }
    const inside = zone === 'floor' ? p.h >= 0 : p.r <= outerR(p.h);
    p.t = inside ? best.d : -best.d;
    p.zone = zone;
    p.nr = best.qx; p.nh = best.qy;
  }

  const wallT = inner.filter((p) => p.zone === 'wall' && !p.interp).map((p) => p.t);
  const floorT = inner.filter((p) => p.zone === 'floor' && !p.interp).map((p) => p.t);
  const rimT = inner.filter((p) => p.zone === 'wall' && p.h > hRim - 12 * MM).map((p) => p.t);
  const med = (a) => (a.length ? quantileSorted(Float32Array.from(a).sort(), 0.5) : null);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    ok: true,
    ...base,
    inner,
    stats: {
      wallMin: wallT.length ? Math.min(...wallT) : null,
      wallMax: wallT.length ? Math.max(...wallT) : null,
      wallMean: mean(wallT),
      floor: med(floorT),
      rim: med(rimT),
      negativeFraction: inner.filter((p) => p.t < 0).length / inner.length,
    },
    noise: { outer: 1.4826 * (med(madO) ?? 0), inner: 1.4826 * (med(madI) ?? 0) },
  };
}
