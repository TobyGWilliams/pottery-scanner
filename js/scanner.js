// WebXR AR session: places the pot centre on the table, then accumulates depth points.

import * as THREE from '../vendor/three.module.min.js';
import { analyse, classifyPoint } from './analysis.js';
import { buildRayTable, captureDepthFrame, ScanBuffer, invRigid, mul4, CAPTURE } from './depth.js';

const DISPLAY_MAX = 150_000;
const COL_OUT = [0.22, 0.53, 0.9], COL_IN = [0.96, 0.6, 0.15], COL_NONE = [0.75, 0.75, 0.75];

export async function arSupport() {
  if (!window.isSecureContext) return { ok: false, why: 'This page must be served over HTTPS (or localhost) for camera access.' };
  if (!navigator.xr) return { ok: false, why: 'This browser has no WebXR. Use Chrome on an ARCore-capable Android phone.' };
  try {
    if (!(await navigator.xr.isSessionSupported('immersive-ar'))) {
      return { ok: false, why: 'AR is not available on this device. It needs Chrome on Android with Google Play Services for AR.' };
    }
  } catch (e) {
    return { ok: false, why: 'AR check failed: ' + e.message };
  }
  return { ok: true };
}

export class Scanner {
  /**
   * @param overlay  DOM element shown on top of the camera feed
   * @param on       {status(text), live(result, scan), ended(scan|null)}
   */
  constructor(overlay, on) {
    this.overlay = overlay;
    this.on = on;
    this.phase = 'idle';
  }

  async start() {
    const depthStateInit = {
      usagePreference: ['cpu-optimized'],
      dataFormatPreference: ['luminance-alpha', 'float32'],
      depthTypeRequest: ['raw', 'smooth'], // unfiltered depth where the browser offers it
    };
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'depth-sensing'],
      optionalFeatures: ['dom-overlay', 'anchors'],
      domOverlay: { root: this.overlay },
      depthSensing: depthStateInit,
    });
    this.session = session;
    this.scan = new ScanBuffer();
    this.phase = 'place';
    this.lastHit = null;
    this.anchor = null;
    this.worldFromPot = null;
    this.rays = null;
    this.rayKey = '';
    this.lastCapTime = 0;
    this.lastCapPose = null;
    this.lastAnalysis = 0;
    this.lastAnalysedN = 0;
    this.live = null;
    this.depthSeen = false;
    this.paused = false;
    this.wantPlace = false;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.xr.enabled = true;
    renderer.localClippingEnabled = true;
    renderer.xr.setReferenceSpaceType('local');
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera();

    // Reticle shown on the table while placing.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.035, 0.04, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.004, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.reticle = new THREE.Group();
    this.reticle.add(ring, dot);
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    this.scene.add(this.reticle);

    // Everything attached to the pot frame.
    this.potGroup = new THREE.Group();
    this.potGroup.matrixAutoUpdate = false;
    this.potGroup.visible = false;
    this.scene.add(this.potGroup);
    const circle = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * 2 * Math.PI;
      circle.push(new THREE.Vector3(CAPTURE.roi * Math.cos(a), 0.001, CAPTURE.roi * Math.sin(a)));
    }
    this.potGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(circle), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })));
    this.axisLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.3, 0)]),
      new THREE.LineBasicMaterial({ color: 0xffffff }),
    );
    this.potGroup.add(this.axisLine);
    const geo = new THREE.BufferGeometry();
    this.dispPos = new Float32Array(DISPLAY_MAX * 3);
    this.dispCol = new Float32Array(DISPLAY_MAX * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.dispPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.dispCol, 3));
    geo.setDrawRange(0, 0);
    // The dots are cut by a vertical plane through the pot's axis that always faces the
    // phone, so only the far half is drawn and you look straight into the cross-section.
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.003, vertexColors: true, sizeAttenuation: true, clippingPlanes: [this.clipPlane] }));
    this.points.frustumCulled = false;
    this.potGroup.add(this.points);

    await renderer.xr.setSession(session);
    this.viewerSpace = await session.requestReferenceSpace('viewer');
    this.hitSource = await session.requestHitTestSource({ space: this.viewerSpace });
    session.addEventListener('end', () => this._ended());
    renderer.setAnimationLoop((time, frame) => this._frame(time, frame));
    this.on.status('Find the table: move the phone slowly until a white ring appears.');
  }

  /** Fix the pot centre at the reticle. Applied inside the next XR frame, where anchors can be created. */
  place() {
    if (this.phase !== 'place' || !this.lastHit) return false;
    this.wantPlace = true;
    return true;
  }

  _place(hit, matrix) {
    this.wantPlace = false;
    this.worldFromPot = Float32Array.from(matrix);
    if (hit.createAnchor) {
      try { hit.createAnchor().then((a) => { this.anchor = a; }).catch(() => {}); } catch (e) { /* anchors unavailable */ }
    }
    this.phase = 'scan';
    this.reticle.visible = false;
    this.potGroup.visible = true;
    this.on.placed?.();
  }

  restart() {
    this.scan = new ScanBuffer();
    this.phase = 'place';
    this.wantPlace = false;
    this.anchor = null;
    this.live = null;
    this.lastAnalysedN = 0;
    this.potGroup.visible = false;
    this.points.geometry.setDrawRange(0, 0);
  }

  setPaused(p) { this.paused = p; }

  finish() {
    this.finished = true;
    this.session?.end();
  }

  cancel() {
    this.finished = false;
    this.session?.end();
  }

  _ended() {
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    this.phase = 'idle';
    const scan = this.finished && this.scan.n > 0 ? this.scan : null;
    this.finished = false;
    this.on.ended(scan);
  }

  // An exception inside an XR frame callback stops the loop and freezes the camera
  // feed, so report it on screen and keep going.
  _frame(time, frame) {
    try {
      this._frameInner(time, frame);
    } catch (e) {
      this.on.status('Scanner error: ' + (e && e.message ? e.message : e));
      console.error(e);
    }
  }

  _frameInner(time, frame) {
    if (!frame) return;
    const ref = this.renderer.xr.getReferenceSpace();
    const pose = frame.getViewerPose(ref);
    if (!pose) {
      this.on.status('Tracking lost. Move the phone slowly and keep the table in view.');
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const view = pose.views[0];

    let depth = null;
    try { depth = frame.getDepthInformation(view); } catch (e) { /* not ready */ }
    if (depth && !this.depthSeen) this.depthSeen = true;

    if (this.phase === 'place') {
      const hits = frame.getHitTestResults(this.hitSource);
      const hp = hits.length ? hits[0].getPose(ref) : null;
      if (hp) {
        this.reticle.matrix.fromArray(hp.transform.matrix);
        this.reticle.visible = true;
        this.lastHit = { result: hits[0], matrix: hp.transform.matrix };
        if (this.wantPlace) this._place(hits[0], hp.transform.matrix);
        this.on.status(this.depthSeen
          ? 'Look straight down into the pot, put the ring on its centre, then tap Place.'
          : 'Table found. Warming up depth: move the phone gently side to side.');
      } else {
        this.reticle.visible = false;
        this.lastHit = null;
      }
    } else if (this.phase === 'scan') {
      if (this.anchor) {
        const ap = frame.getPose(this.anchor.anchorSpace, ref);
        if (ap) this.worldFromPot = Float32Array.from(ap.transform.matrix);
      }
      this.potGroup.matrix.fromArray(this.worldFromPot);
      this._updateSlice(view);
      if (depth && !this.paused && !this.scan.full && time - this.lastCapTime > 100 && this._moved(view)) {
        this._capture(view, depth);
        this.lastCapTime = time;
      }
      if (time - this.lastAnalysis > 1500 && this.scan.n !== this.lastAnalysedN) {
        this.lastAnalysis = time;
        this.lastAnalysedN = this.scan.n;
        this.live = analyse(this.scan, { maxPoints: 120_000 });
        this._refreshDisplay();
        this.on.live(this.live, this.scan);
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  _updateSlice(view) {
    const m = this.worldFromPot, g = this.live?.geom;
    const ax = g ? g.cx : 0, ay = g ? g.h0 : 0, az = g ? g.cz : 0;
    // axis point and up direction in world space
    const Ax = m[0] * ax + m[4] * ay + m[8] * az + m[12];
    const Ay = m[1] * ax + m[5] * ay + m[9] * az + m[13];
    const Az = m[2] * ax + m[6] * ay + m[10] * az + m[14];
    const ux = m[4], uy = m[5], uz = m[6];
    const c = view.transform.position;
    let dx = c.x - Ax, dy = c.y - Ay, dz = c.z - Az;
    const along = dx * ux + dy * uy + dz * uz;
    dx -= along * ux; dy -= along * uy; dz -= along * uz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.02) return; // directly overhead: keep the last slice direction
    // keep the side facing away from the phone
    this.clipPlane.normal.set(-dx / len, -dy / len, -dz / len);
    this.clipPlane.constant = (dx * Ax + dy * Ay + dz * Az) / len;
  }

  // Skip frames from an almost stationary phone: they add correlated error, not information.
  _moved(view) {
    const p = view.transform.position, q = view.transform.orientation;
    const last = this.lastCapPose;
    if (last) {
      const d = Math.hypot(p.x - last.p[0], p.y - last.p[1], p.z - last.p[2]);
      const dot = Math.abs(q.x * last.q[0] + q.y * last.q[1] + q.z * last.q[2] + q.w * last.q[3]);
      if (d < 0.008 && dot > 0.9999) return false;
    }
    this.lastCapPose = { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w] };
    return true;
  }

  _capture(view, depth) {
    const w = depth.width, h = depth.height;
    const nd = depth.normDepthBufferFromNormView;
    const key = `${w}x${h}|${view.projectionMatrix[0]}|${view.projectionMatrix[5]}|${view.projectionMatrix[8]}|${view.projectionMatrix[9]}|${nd.matrix[0]}|${nd.matrix[1]}|${nd.matrix[12]}|${nd.matrix[13]}`;
    if (key !== this.rayKey) {
      this.rays = buildRayTable(view.projectionMatrix, nd.inverse.matrix, w, h);
      this.rayKey = key;
    }
    const data = this.session.depthDataFormat === 'float32' ? new Float32Array(depth.data) : new Uint16Array(depth.data);
    const potFromView = mul4(invRigid(this.worldFromPot), view.transform.matrix);
    captureDepthFrame(this.scan, data, w, h, depth.rawValueToMeters, this.rays, potFromView);
  }

  _refreshDisplay() {
    const s = this.scan, g = this.live?.geom;
    const stride = Math.max(1, Math.ceil(s.n / DISPLAY_MAX));
    let k = 0;
    for (let i = 0; i < s.n && k < DISPLAY_MAX; i += stride, k++) {
      const x = s.pts[i * 3], y = s.pts[i * 3 + 1], z = s.pts[i * 3 + 2];
      this.dispPos[k * 3] = x; this.dispPos[k * 3 + 1] = y; this.dispPos[k * 3 + 2] = z;
      let c = COL_NONE;
      if (g) {
        const f = s.frame[i];
        const cl = classifyPoint(x, y, z, s.cams[f * 3], s.cams[f * 3 + 1], s.cams[f * 3 + 2], g);
        c = cl === 0 ? COL_OUT : cl === 1 ? COL_IN : COL_NONE;
      }
      this.dispCol[k * 3] = c[0]; this.dispCol[k * 3 + 1] = c[1]; this.dispCol[k * 3 + 2] = c[2];
    }
    const geo = this.points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.setDrawRange(0, k);
    if (g) {
      const p = this.axisLine.geometry.attributes.position;
      p.setXYZ(0, g.cx, g.h0, g.cz);
      p.setXYZ(1, g.cx, g.h0 + g.hRim + 0.05, g.cz);
      p.needsUpdate = true;
    }
  }
}
