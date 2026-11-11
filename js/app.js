import { analyse } from './analysis.js';
import { Scanner, arSupport } from './scanner.js';
import { ResultsView, drawPreview } from './results.js';
import { demoPot, synthScan } from './synth.js';
import { VERSION } from './version.js';

const $ = (id) => document.getElementById(id);
const STORE = 'pot-scan-last';
const pages = ['home', 'busy', 'results'];
const showPage = (name) => pages.forEach((p) => { $(p).hidden = p !== name; });

let view = null;
let current = null; // {result, rimKnown}

function load() {
  try { return JSON.parse(localStorage.getItem(STORE)); } catch (e) { return null; }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(current)); } catch (e) { /* storage unavailable */ }
}

function offsetFor(c) {
  return c.rimKnown != null && c.result.stats.rim != null ? c.rimKnown / 1000 - c.result.stats.rim : 0;
}

function showResult(c) {
  current = c;
  showPage('results');
  window.scrollTo(0, 0);
  view ??= new ResultsView({
    section: $('section'), chart: $('chart'), view3d: $('view3d'), readout: $('readout'),
    stats: $('stats'), legend: $('legend'), notes: $('notes'),
  });
  $('rim').value = c.rimKnown ?? '';
  view.show(c.result, offsetFor(c));
}

function process(scan, label) {
  $('busy-text').textContent = label;
  showPage('busy');
  // let the page paint before the heavy pass
  setTimeout(() => {
    const result = analyse(scan, { maxPoints: 1_500_000 });
    if (!result.ok) {
      showPage('home');
      $('support').textContent = `That scan could not be solved: ${result.message} Try again and cover both the outside and the inside.`;
      return;
    }
    delete result.geom;
    showResult({ result, rimKnown: null, when: new Date().toISOString() });
    save();
  }, 50);
}

// ---------- AR scan ----------
const overlay = $('overlay');
let lastStatus = '';
const setStatus = (t) => { if (t !== lastStatus) { lastStatus = t; $('ov-status').textContent = t; } };

function scanUi(phase) {
  $('ov-place').hidden = phase !== 'place';
  $('ov-finish').hidden = phase !== 'scan';
  $('ov-restart').hidden = phase !== 'scan';
  $('ov-live').hidden = phase !== 'scan';
}

const scanner = new Scanner(overlay, {
  status: setStatus,
  placed() {
    scanUi('scan');
    setStatus('Walk slowly round the outside of the pot, 30–40 cm away.');
  },
  live(res, scan) {
    $('ov-n').textContent = scan.n.toLocaleString();
    $('ov-out').textContent = Math.round((res.coverage?.outer ?? 0) * 100) + '%';
    $('ov-in').textContent = Math.round((res.coverage?.inner ?? 0) * 100) + '%';
    drawPreview($('ov-preview'), res);
    if (scan.full) setStatus('That is plenty of data. Tap Finish.');
    else if (!res.ok) setStatus(res.message);
    else if (res.coverage.outer < 0.85) setStatus('Keep going round the outside until the blue dots wrap the whole pot.');
    else if (res.coverage.inner < 0.85) setStatus('Now hold the phone above the pot and look down into it from every side.');
    else setStatus('Good coverage. A second slow lap sharpens the result, or tap Finish.');
  },
  ended(scan) {
    overlay.classList.remove('active');
    if (scan) process(scan, `Working out the thickness from ${scan.n.toLocaleString()} depth points…`);
    else showPage('home');
  },
});

$('start').addEventListener('click', async () => {
  overlay.classList.add('active');
  scanUi('place');
  setStatus('Starting camera…');
  try {
    await scanner.start();
  } catch (e) {
    overlay.classList.remove('active');
    $('support').textContent = e.name === 'NotSupportedError'
      ? 'This phone’s browser does not offer AR depth sensing, which the scan needs. It works in Chrome on ARCore phones that support the Depth API.'
      : 'Could not start the scan: ' + e.message;
  }
});
$('ov-place').addEventListener('click', () => scanner.place());
$('ov-restart').addEventListener('click', () => { scanner.restart(); scanUi('place'); });
$('ov-finish').addEventListener('click', () => scanner.finish());
$('ov-cancel').addEventListener('click', () => scanner.cancel());

// ---------- home / results ----------
function runDemo() {
  $('busy-text').textContent = 'Building an example scan…';
  showPage('busy');
  setTimeout(() => process(synthScan(demoPot(), { grid: [80, 60] }), 'Working out the thickness…'), 50);
}
$('demo').addEventListener('click', runDemo);
$('last').addEventListener('click', () => { const c = load(); if (c) showResult(c); });
$('again').addEventListener('click', () => { showPage('home'); $('last').hidden = !load(); });
$('rim').addEventListener('input', () => {
  const v = parseFloat($('rim').value);
  current.rimKnown = Number.isFinite(v) && v > 0 ? v : null;
  view.setOffset(offsetFor(current));
  save();
});
$('rim-clear').addEventListener('click', () => { $('rim').value = ''; $('rim').dispatchEvent(new Event('input')); });
$('export').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(current, null, 1)], { type: 'application/json' }));
  a.download = `pot-scan-${(current.when || '').slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('version').textContent = VERSION;
$('last').hidden = !load();
arSupport().then((s) => {
  $('start').disabled = !s.ok;
  $('support').textContent = s.ok ? 'Ready. You will be asked for camera access.' : s.why;
});
if (new URLSearchParams(location.search).has('demo')) runDemo();
