import test from 'node:test';
import assert from 'node:assert/strict';
import { analyse } from '../js/analysis.js';
import { buildRayTable, captureDepthFrame, ScanBuffer, invRigid, mul4 } from '../js/depth.js';
import { demoPot, synthScan, trueWallThickness } from '../js/synth.js';

const MM = 0.001;

function wallErrors(res, pot) {
  const errs = [];
  for (const p of res.inner) {
    if (p.zone !== 'wall' || p.h < 0.025 || p.h > pot.H - 0.012) continue;
    errs.push(p.t - trueWallThickness(pot, p.h));
  }
  const mae = errs.reduce((a, e) => a + Math.abs(e), 0) / errs.length;
  const bias = errs.reduce((a, e) => a + e, 0) / errs.length;
  return { mae, bias, n: errs.length };
}

test('recovers axis, size and wall thickness from a noisy synthetic scan', () => {
  const pot = demoPot();
  const scan = synthScan(pot, { noise: 2.5 * MM, offset: [0.012, -0.009], tableErr: 0.003 });
  const res = analyse(scan);
  assert.ok(res.ok, res.message);
  console.log(`points ${scan.n}, outer ${res.nOuter}, inner ${res.nInner}, coverage`, res.coverage);
  console.log('centre', res.centre.map((v) => (v / MM).toFixed(2)), 'h0', (res.h0 / MM).toFixed(2), 'hRim', (res.hRim / MM).toFixed(1), 'rRim', (res.rRim / MM).toFixed(1));
  assert.ok(Math.hypot(res.centre[0] - 0.012, res.centre[1] + 0.009) < 1 * MM, 'axis within 1 mm');
  assert.ok(Math.abs(res.h0 - 0.003) < 1 * MM, 'table height within 1 mm');
  assert.ok(Math.abs(res.hRim - pot.H) < 4 * MM, 'rim height within 4 mm');
  const e = wallErrors(res, pot);
  console.log(`wall thickness: mean abs err ${(e.mae / MM).toFixed(2)} mm, bias ${(e.bias / MM).toFixed(2)} mm over ${e.n} samples`);
  console.log('stats (mm)', Object.fromEntries(Object.entries(res.stats).map(([k, v]) => [k, v == null ? v : +(v / MM).toFixed(2)])));
  assert.ok(e.mae < 1 * MM, 'mean wall error under 1 mm');
  assert.ok(Math.abs(res.stats.floor - 7 * MM) < 1.5 * MM, 'floor thickness within 1.5 mm');
  // The demo pot thickens towards the base: the relative trend must come through.
  const low = res.inner.filter((p) => p.zone === 'wall' && p.h > 0.02 && p.h < 0.04).map((p) => p.t);
  const high = res.inner.filter((p) => p.zone === 'wall' && p.h > 0.08 && p.h < 0.1).map((p) => p.t);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(avg(low) - avg(high) > 1.5 * MM, 'base reads thicker than rim');
});

test('subsampled live preview agrees with the full analysis', () => {
  const pot = demoPot();
  const scan = synthScan(pot, { grid: [80, 60] });
  const res = analyse(scan, { maxPoints: 60000 });
  assert.ok(res.ok, res.message);
  const e = wallErrors(res, pot);
  console.log(`preview: mean abs err ${(e.mae / MM).toFixed(2)} mm`);
  assert.ok(e.mae < 1.5 * MM);
});

test('reports what is missing when only the outside has been scanned', () => {
  const scan = synthScan(demoPot(), { grid: [80, 60] });
  // keep only frames from the first (low) orbit
  let n = 0;
  while (n < scan.n && scan.frame[n] < 24) n++;
  const res = analyse({ ...scan, pts: scan.pts, frame: scan.frame, cams: scan.cams, n });
  assert.equal(res.ok, false);
  assert.match(res.message, /inside/);
  assert.ok(res.outer?.length > 10);
});

test('depth unprojection round-trips through a WebXR-style projection', () => {
  const W = 160, H = 90, near = 0.1, far = 100;
  const fx = 1.3, fy = 2.2, cxo = 0.02, cyo = -0.03;
  // column-major off-centre perspective
  const P = new Float32Array([fx, 0, 0, 0, 0, fy, 0, 0, cxo, cyo, -(far + near) / (far - near), -1, 0, 0, (-2 * far * near) / (far - near), 0]);
  const I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const rays = buildRayTable(P, I, W, H);
  const col = 37, row = 71, d = 0.42;
  const i = row * W + col;
  const v = [rays[i * 2] * d, rays[i * 2 + 1] * d, -d];
  const ndcX = (P[0] * v[0] + P[8] * v[2]) / -v[2], ndcY = (P[5] * v[1] + P[9] * v[2]) / -v[2];
  assert.ok(Math.abs((ndcX + 1) / 2 * W - (col + 0.5)) < 1e-3);
  assert.ok(Math.abs((1 - ndcY) / 2 * H - (row + 0.5)) < 1e-3, 'row 0 is the top of the view');

  // A flat wall 0.4 m in front of the camera lands at the right place in the pot frame.
  const data = new Uint16Array(W * H).fill(400);
  const worldFromView = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.1, 0.4, 1]);
  const worldFromPot = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const buf = new ScanBuffer(20000, 4);
  const added = captureDepthFrame(buf, data, W, H, 0.001, rays, mul4(invRigid(worldFromPot), worldFromView));
  assert.ok(added > 1000);
  for (let k = 0; k < buf.n; k++) assert.ok(Math.abs(buf.pts[k * 3 + 2]) < 1e-5, 'z = 0.4 - 0.4');
  assert.deepEqual([...buf.cams.subarray(0, 3)].map((x) => +x.toFixed(3)), [0, 0.1, 0.4]);
});
