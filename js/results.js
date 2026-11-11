// Results page: cross-section heat map, thickness-along-profile chart, 3D cutaway.

import * as THREE from '../vendor/three.module.min.js';

const INK = '#1f1d1a', MUTED = '#6b665e', GRID = '#e2ddd4', SURFACE = '#fbfaf7';
// One-hue sequential ramp, light = thin, dark = thick.
const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b']
  .map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);

function rampRGB(f) {
  const x = Math.max(0, Math.min(1, f)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x)), u = x - i;
  return RAMP[i].map((c, k) => Math.round(c + u * (RAMP[i + 1][k] - c)));
}
const css = (rgb) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
const mm = (v, d = 1) => (v * 1000).toFixed(d);

function setupCanvas(canvas, cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export class ResultsView {
  constructor(el) {
    this.el = el; // {section, chart, view3d, readout, stats, legend, notes}
    this.hover = -1;
    const bind = (canvas, pick) => {
      const h = (ev) => {
        const b = canvas.getBoundingClientRect();
        this.setHover(pick(ev.clientX - b.left, ev.clientY - b.top));
      };
      canvas.addEventListener('pointerdown', h);
      canvas.addEventListener('pointermove', h);
    };
    bind(el.section, (x, y) => this._pickSection(x, y));
    bind(el.chart, (x) => this._pickChart(x));
    this._init3d();
    window.addEventListener('resize', () => this.result && this.draw());
  }

  show(result, offset = 0) {
    this.result = result;
    this.offset = offset;
    this.hover = -1;
    this.draw();
  }

  setOffset(offset) { this.offset = offset; this.draw(); }

  setHover(i) {
    if (i === this.hover) return;
    this.hover = i;
    this._drawSection();
    this._drawChart();
    this._readout();
  }

  // displayed thickness of inner vertex i
  t(i) { return Math.max(0, this.result.inner[i].t + this.offset); }

  draw() {
    const inner = this.result.inner;
    const ts = inner.map((_, i) => this.t(i));
    this.tMin = Math.min(...ts);
    this.tMax = Math.max(...ts);
    if (this.tMax - this.tMin < 1e-4) this.tMax = this.tMin + 1e-4;
    this.color = (t) => rampRGB((t - this.tMin) / (this.tMax - this.tMin));
    this._stats();
    this._legend();
    this._drawSection();
    this._drawChart();
    this._build3d();
    this._readout();
  }

  _stats() {
    const r = this.result, s = r.stats, o = this.offset;
    const wall = r.inner.map((p, i) => ({ p, t: this.t(i) })).filter((x) => x.p.zone === 'wall' && !x.p.interp);
    const tMin = Math.min(...wall.map((x) => x.t)), tMax = Math.max(...wall.map((x) => x.t));
    const rimD = 2 * r.outer[r.outer.length - 1].r;
    const tiles = [
      ['Thinnest wall', mm(tMin) + ' mm'],
      ['Thickest wall', mm(tMax) + ' mm'],
      ['Thick : thin', tMin > 0.0003 ? (tMax / tMin).toFixed(1) + '×' : '–'],
      ['Floor', s.floor != null ? mm(Math.max(0, s.floor + o)) + ' mm' : '–'],
      ['Height', mm(r.hRim, 0) + ' mm'],
      ['Rim width', mm(rimD, 0) + ' mm'],
    ];
    this.el.stats.innerHTML = tiles.map(([k, v]) => `<div class="tile"><div class="tile-v">${v}</div><div class="tile-k">${k}</div></div>`).join('');
    const notes = [];
    const noise = Math.max(r.noise.outer, r.noise.inner);
    notes.push(`Depth scatter in this scan was about ±${mm(noise)} mm per point, averaged over ${(r.nOuter + r.nInner).toLocaleString()} points. Trust the pattern (where it is thicker or thinner) more than the millimetre values.`);
    if (s.negativeFraction > 0.1 && o === 0) notes.push('Parts of the inside surface were measured outside the outer surface, so the phone’s depth error is larger than the wall. Enter a measured rim thickness below to anchor the scale.');
    if (r.coverage.outer < 0.8 || r.coverage.inner < 0.8) notes.push(`Coverage was partial (outside ${Math.round(r.coverage.outer * 100)}%, inside ${Math.round(r.coverage.inner * 100)}%). A full walk round the pot gives a steadier result.`);
    notes.push('The base is measured from the table to the inside floor, so a foot ring or a hollowed base reads as solid clay.');
    this.el.notes.innerHTML = notes.map((n) => `<li>${n}</li>`).join('');
  }

  _legend() {
    const stops = RAMP.map((c, i) => `${css(c)} ${(i / (RAMP.length - 1) * 100).toFixed(0)}%`).join(',');
    this.el.legend.innerHTML = `<span>${mm(this.tMin)} mm<br><small>thinner</small></span><div class="legend-bar" style="background:linear-gradient(90deg,${stops})"></div><span class="r">${mm(this.tMax)} mm<br><small>thicker</small></span>`;
  }

  _drawSection() {
    const r = this.result, inner = r.inner, outer = r.outer;
    const cssW = this.el.section.parentElement.clientWidth;
    const padX = 78, padTop = 16, padBot = 26;
    const rMax = Math.max(...outer.map((p) => p.r)), hMax = Math.max(outer[outer.length - 1].h, inner[inner.length - 1].h);
    const sc = Math.min((cssW - 2 * padX) / (2 * rMax), 420 / hMax);
    const cssH = Math.round(hMax * sc + padTop + padBot);
    const ctx = setupCanvas(this.el.section, cssW, cssH);
    const cx = cssW / 2, y0 = cssH - padBot;
    const X = (rr, side) => cx + side * rr * sc, Y = (h) => y0 - h * sc;
    this._sec = { cx, y0, sc };
    ctx.clearRect(0, 0, cssW, cssH);

    // table
    ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(8, y0 + 0.5); ctx.lineTo(cssW - 8, y0 + 0.5); ctx.stroke();

    for (const side of [-1, 1]) {
      for (let i = 0; i < inner.length - 1; i++) {
        const a = inner[i], b = inner[i + 1];
        const c = css(this.color((this.t(i) + this.t(i + 1)) / 2));
        ctx.fillStyle = c; ctx.strokeStyle = c; ctx.lineWidth = 0.75;
        ctx.beginPath();
        ctx.moveTo(X(a.r, side), Y(a.h));
        ctx.lineTo(X(b.r, side), Y(b.h));
        ctx.lineTo(X(b.nr, side), Y(b.nh));
        if (a.zone !== b.zone) ctx.lineTo(X(outer[0].r, side), Y(0)); // base corner wedge
        ctx.lineTo(X(a.nr, side), Y(a.nh));
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      ctx.strokeStyle = INK; ctx.lineWidth = 1.25; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(X(0, side), Y(0));
      outer.forEach((p) => ctx.lineTo(X(p.r, side), Y(p.h)));
      const top = inner[inner.length - 1];
      ctx.lineTo(X(top.r, side), Y(top.h));
      for (let i = inner.length - 2; i >= 0; i--) ctx.lineTo(X(inner[i].r, side), Y(inner[i].h));
      ctx.stroke();
    }

    // direct labels: thinnest and thickest wall
    const wallIdx = inner.map((p, i) => i).filter((i) => inner[i].zone === 'wall' && !inner[i].interp);
    if (wallIdx.length) {
      const iMin = wallIdx.reduce((a, b) => (this.t(b) < this.t(a) ? b : a));
      const iMax = wallIdx.reduce((a, b) => (this.t(b) > this.t(a) ? b : a));
      ctx.font = '12px system-ui, sans-serif'; ctx.textBaseline = 'middle';
      const label = (i, side, text) => {
        const p = inner[i];
        const x = X(p.nr, side), y = Y(p.nh);
        ctx.strokeStyle = MUTED; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x + side * 3, y); ctx.lineTo(x + side * 12, y); ctx.stroke();
        ctx.fillStyle = INK; ctx.textAlign = side > 0 ? 'left' : 'right';
        ctx.fillText(`${mm(this.t(i))} mm`, x + side * 15, y - 7);
        ctx.fillStyle = MUTED;
        ctx.fillText(text, x + side * 15, y + 7);
      };
      label(iMin, 1, 'thinnest');
      label(iMax, -1, 'thickest');
    }

    if (this.hover >= 0) {
      const p = inner[this.hover];
      for (const side of [-1, 1]) {
        ctx.strokeStyle = INK; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(X(p.r, side), Y(p.h)); ctx.lineTo(X(p.nr, side), Y(p.nh)); ctx.stroke();
        ctx.fillStyle = SURFACE;
        ctx.beginPath(); ctx.arc(X(p.r, side), Y(p.h), 4, 0, 7); ctx.fill(); ctx.stroke();
      }
    }
    ctx.fillStyle = MUTED; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('table', cx, y0 + 6);
  }

  _pickSection(x, y) {
    const { cx, y0, sc } = this._sec, inner = this.result.inner;
    const rr = Math.abs(x - cx) / sc, h = (y0 - y) / sc;
    let best = -1, bd = Infinity;
    for (let i = 0; i < inner.length; i++) {
      // distance to the wall segment between inner and outer surface
      const p = inner[i];
      const mx = (p.r + p.nr) / 2, mh = (p.h + p.nh) / 2;
      const d = Math.hypot(rr - mx, h - mh);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  _drawChart() {
    const inner = this.result.inner;
    const cssW = this.el.chart.parentElement.clientWidth, cssH = 170;
    const ctx = setupCanvas(this.el.chart, cssW, cssH);
    const L = 34, Rr = 10, T = 10, B = 30;
    const sMax = inner[inner.length - 1].s || 1;
    const tTop = Math.ceil(this.tMax * 1000 / 2) * 2 / 1000 || 0.002;
    const X = (s) => L + (s / sMax) * (cssW - L - Rr), Y = (t) => cssH - B - (t / tTop) * (cssH - T - B);
    this._ch = { L, W: cssW - L - Rr, sMax };
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.font = '11px system-ui, sans-serif';
    // grid + y labels
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const step = tTop * 1000 > 12 ? 4 : 2;
    for (let v = 0; v <= tTop * 1000 + 1e-6; v += step) {
      const y = Math.round(Y(v / 1000)) + 0.5;
      ctx.strokeStyle = GRID; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(cssW - Rr, y); ctx.stroke();
      ctx.fillStyle = MUTED; ctx.fillText(String(v), L - 6, y);
    }
    // where the floor ends and the wall starts
    const iWall = inner.findIndex((p) => p.zone === 'wall');
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = MUTED;
    if (iWall > 0) {
      const xb = Math.round(X(inner[iWall].s)) + 0.5;
      ctx.strokeStyle = MUTED; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(xb, T); ctx.lineTo(xb, cssH - B); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText('floor', (L + xb) / 2, cssH - B + 6);
      ctx.fillText('wall, base → rim', (xb + cssW - Rr) / 2, cssH - B + 6);
    } else {
      ctx.fillText('inside surface, base → rim', (L + cssW - Rr) / 2, cssH - B + 6);
    }
    ctx.strokeStyle = '#256abf'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    inner.forEach((p, i) => (i ? ctx.lineTo(X(p.s), Y(this.t(i))) : ctx.moveTo(X(p.s), Y(this.t(i)))));
    ctx.stroke();
    if (this.hover >= 0) {
      const p = inner[this.hover], x = X(p.s), y = Y(this.t(this.hover));
      ctx.strokeStyle = MUTED; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, T); ctx.lineTo(Math.round(x) + 0.5, cssH - B); ctx.stroke();
      ctx.fillStyle = '#256abf'; ctx.strokeStyle = SURFACE; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill(); ctx.stroke();
    }
  }

  _pickChart(x) {
    const { L, W, sMax } = this._ch, inner = this.result.inner;
    const s = ((x - L) / W) * sMax;
    let best = 0;
    for (let i = 1; i < inner.length; i++) if (Math.abs(inner[i].s - s) < Math.abs(inner[best].s - s)) best = i;
    return best;
  }

  _readout() {
    if (this.hover < 0) { this.el.readout.textContent = 'Touch the section or the chart to read a thickness.'; return; }
    const p = this.result.inner[this.hover];
    const where = p.zone === 'floor' ? `floor, ${mm(p.r, 0)} mm from the centre` : `wall, ${mm(p.h, 0)} mm above the table`;
    this.el.readout.innerHTML = `<strong>${mm(this.t(this.hover))} mm</strong> · ${where}${p.interp ? ' · estimated, few depth points here' : ''}`;
  }

  // ---------- 3D cutaway ----------
  _init3d() {
    const canvas = this.el.view3d;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.scene3 = new THREE.Scene();
    this.cam3 = new THREE.PerspectiveCamera(35, 1, 0.01, 10);
    this.scene3.add(new THREE.HemisphereLight(0xffffff, 0x9a9388, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 2, 1.5);
    this.scene3.add(sun);
    this.pivot = new THREE.Group();
    this.scene3.add(this.pivot);
    this.yaw = 3.6; this.pitch = 0.5; // open side of the cutaway faces the viewer
    let last = null;
    canvas.addEventListener('pointerdown', (e) => { last = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!last) return;
      this.yaw += (e.clientX - last[0]) * 0.01;
      this.pitch = Math.max(-0.2, Math.min(1.4, this.pitch + (e.clientY - last[1]) * 0.01));
      last = [e.clientX, e.clientY];
      this._render3d();
    });
    const up = () => { last = null; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  }

  _build3d() {
    const r = this.result, inner = r.inner, outer = r.outer;
    if (this.mesh) { this.pivot.remove(this.mesh); this.mesh.geometry.dispose(); }
    const col = (t) => { const c = this.color(t); return new THREE.Color(`rgb(${c[0]},${c[1]},${c[2]})`); };
    // closed half-section loop: inside (centre -> rim), outside (rim -> base), base centre
    const loop = inner.map((p, i) => ({ r: p.r, h: p.h, c: col(this.t(i)) }));
    for (let q = outer.length - 1; q >= 0; q--) {
      const o = outer[q];
      let bi = 0, bd = Infinity;
      inner.forEach((p, i) => { const d = Math.hypot(p.nr - o.r, p.nh - o.h); if (d < bd) { bd = d; bi = i; } });
      loop.push({ r: o.r, h: o.h, c: col(this.t(bi)) });
    }
    loop.push({ r: 0, h: 0, c: col(this.t(0)) });
    const SEG = 64, SWEEP = 1.5 * Math.PI;
    const pos = [], colr = [], idx = [];
    for (let s = 0; s <= SEG; s++) {
      const a = (s / SEG) * SWEEP;
      for (const v of loop) { pos.push(v.r * Math.cos(a), v.h, v.r * Math.sin(a)); colr.push(v.c.r, v.c.g, v.c.b); }
    }
    const n = loop.length;
    for (let s = 0; s < SEG; s++) for (let j = 0; j < n - 1; j++) {
      const a = s * n + j, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    // cut faces
    for (const ang of [0, SWEEP]) {
      const ca = Math.cos(ang), sa = Math.sin(ang);
      for (let i = 0; i < inner.length - 1; i++) {
        const A = inner[i], B = inner[i + 1];
        const c = col((this.t(i) + this.t(i + 1)) / 2);
        const quad = [[A.r, A.h], [B.r, B.h], [B.nr, B.nh], [A.nr, A.nh]];
        if (A.zone !== B.zone) quad.splice(3, 0, [outer[0].r, 0]);
        const base = pos.length / 3;
        for (const [rr, h] of quad) { pos.push(rr * ca, h, rr * sa); colr.push(c.r, c.g, c.b); }
        for (let k = 1; k < quad.length - 1; k++) idx.push(base, base + k, base + k + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    this.mesh.position.y = -r.hRim / 2;
    this.pivot.add(this.mesh);
    this._size3 = Math.max(r.hRim, 2 * Math.max(...outer.map((p) => p.r)));
    this._render3d();
  }

  _render3d() {
    const canvas = this.el.view3d;
    const w = canvas.parentElement.clientWidth, h = Math.min(360, Math.round(w * 0.8));
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(w, h, true);
    this.cam3.aspect = w / h;
    this.cam3.updateProjectionMatrix();
    const dist = this._size3 * 2.6;
    this.cam3.position.set(0, Math.sin(this.pitch) * dist, Math.cos(this.pitch) * dist);
    this.cam3.lookAt(0, 0, 0);
    this.pivot.rotation.y = this.yaw;
    this.renderer.render(this.scene3, this.cam3);
  }
}

/** Small live profile for the AR overlay. */
export function drawPreview(canvas, res) {
  const W = 132, H = 132;
  const ctx = setupCanvas(canvas, W, H);
  ctx.clearRect(0, 0, W, H);
  if (!res || !res.outer) return;
  const outer = res.outer, inner = res.inner || [];
  const rMax = Math.max(...outer.map((p) => p.r)), hMax = res.hRim;
  const sc = Math.min((W - 16) / (2 * rMax), (H - 16) / hMax);
  const cx = W / 2, y0 = H - 8;
  for (const side of [-1, 1]) {
    ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#6da7ec';
    ctx.beginPath();
    outer.forEach((p, i) => (i ? ctx.lineTo(cx + side * p.r * sc, y0 - p.h * sc) : ctx.moveTo(cx + side * p.r * sc, y0 - p.h * sc)));
    ctx.stroke();
    ctx.strokeStyle = '#f5a53c';
    ctx.beginPath();
    inner.forEach((p, i) => (i ? ctx.lineTo(cx + side * p.r * sc, y0 - p.h * sc) : ctx.moveTo(cx + side * p.r * sc, y0 - p.h * sc)));
    ctx.stroke();
  }
}
