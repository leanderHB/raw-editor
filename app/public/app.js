// relative, not absolute, paths — this needs to work whether the site is hosted at
// a domain root (our local dev server) or under a subpath (GitHub Pages project
// sites are served at https://<user>.github.io/<repo>/, not the domain root).
import LibRaw from './vendor/libraw-wasm/index.js';
import { minigl, Spline } from './vendor/mini-gl/minigl.js';

const statusEl = document.getElementById('status');
const setStatus = (s) => { statusEl.textContent = s; };

const openBtn = document.getElementById('openBtn');
const fileInput = document.getElementById('fileInput');
const exportBtn = document.getElementById('exportBtn');
const resetBtn = document.getElementById('resetBtn');
const rotate90Btn = document.getElementById('rotate90Btn');
const canvasWrap = document.getElementById('canvasWrap');

const SLIDER_KEYS = ['straighten', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'saturation', 'temperature', 'tint', 'vibrance', 'clarity', 'dehaze', 'vignette', 'bloom', 'defringe'];
const state = Object.fromEntries(SLIDER_KEYS.map((k) => [k, 0]));
state.sonyLook = false;

const sonyLookCheckbox = document.getElementById('sonyLook');

// --- Settings persistence & named presets ----------------------------------
// Two related but separate mechanisms, both in localStorage (not an actual HTTP
// cookie — same idea, but doesn't round-trip to a server on every request and
// holds far more than 4KB; there's no server here anyway):
//
// 1. Auto-saved "last used" settings: every edit silently becomes the default
//    starting point for the next image you open. No name, one slot, always on.
// 2. Named presets: an explicit list you save/apply/delete on demand.
//
// Both exclude 'straighten': it's a per-photo horizon correction, not part of
// a "look" that should carry over to an unrelated image (mirrors how
// Lightroom's Sync/Previous-settings dialog leaves geometry unchecked by
// default while carrying tone/color/effects).
const SETTINGS_STORAGE_KEY = 'raw-editor-settings-v1';
const PRESETS_STORAGE_KEY = 'raw-editor-presets-v1';
const PERSISTED_SLIDER_KEYS = SLIDER_KEYS.filter((k) => k !== 'straighten');

// The serializable "look": every slider except straighten, Sony Look, and the
// tone curve. Shared by both the auto-save slot and named presets.
function serializeLook() {
  return {
    sliders: Object.fromEntries(PERSISTED_SLIDER_KEYS.map((k) => [k, state[k]])),
    sonyLook: state.sonyLook,
    curvePoints,
  };
}

// Applies a serialized look to state + UI. Deliberately never touches
// straighten — callers that need straighten reset (opening a brand new image)
// do that separately with resetStraighten().
function applyLook(look) {
  for (const key of PERSISTED_SLIDER_KEYS) {
    const value = look?.sliders?.[key] ?? 0;
    state[key] = value;
    document.getElementById(key).value = value;
    document.getElementById(key + 'Val').textContent = value.toFixed(2);
  }
  state.sonyLook = look?.sonyLook ?? false;
  sonyLookCheckbox.checked = state.sonyLook;
  curvePoints = look?.curvePoints ? look.curvePoints.map((p) => [...p]) : IDENTITY_CURVE();
  drawCurve();
}

function resetStraighten() {
  state.straighten = 0;
  document.getElementById('straighten').value = 0;
  document.getElementById('straightenVal').textContent = '0.00';
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(serializeLook()));
  } catch (err) {
    console.warn('could not save settings', err);
  }
}

function loadSavedSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn('could not load saved settings', err);
    return null;
  }
}

function loadPresets() {
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.warn('could not load presets', err);
    return [];
  }
}

function savePresetsList(list) {
  try {
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('could not save presets', err);
  }
}

const presetSelect = document.getElementById('presetSelect');
const savePresetBtn = document.getElementById('savePresetBtn');
const deletePresetBtn = document.getElementById('deletePresetBtn');

function renderPresetOptions() {
  const presets = loadPresets();
  const current = presetSelect.value;
  presetSelect.innerHTML = '<option value="">— choose a preset —</option>';
  for (const preset of presets) {
    const opt = document.createElement('option');
    opt.value = preset.name;
    opt.textContent = preset.name;
    presetSelect.appendChild(opt);
  }
  presetSelect.value = presets.some((p) => p.name === current) ? current : '';
  deletePresetBtn.disabled = !presetSelect.value;
}

presetSelect.addEventListener('change', () => {
  deletePresetBtn.disabled = !presetSelect.value;
  if (!presetSelect.value) return;
  const preset = loadPresets().find((p) => p.name === presetSelect.value);
  if (!preset) return;
  applyLook(preset); // never touches straighten — presets are a color/tone look, not geometry
  render();
});

savePresetBtn.addEventListener('click', () => {
  const name = window.prompt('Save current settings as preset named:');
  if (!name) return;
  const presets = loadPresets();
  const existingIndex = presets.findIndex((p) => p.name === name);
  if (existingIndex !== -1 && !window.confirm(`A preset named "${name}" already exists. Overwrite it?`)) return;
  const preset = { name, ...serializeLook() };
  if (existingIndex !== -1) presets[existingIndex] = preset;
  else presets.push(preset);
  savePresetsList(presets);
  renderPresetOptions();
  presetSelect.value = name;
  deletePresetBtn.disabled = false;
});

deletePresetBtn.addEventListener('click', () => {
  if (!presetSelect.value) return;
  if (!window.confirm(`Delete preset "${presetSelect.value}"?`)) return;
  savePresetsList(loadPresets().filter((p) => p.name !== presetSelect.value));
  renderPresetOptions();
});

renderPresetOptions();
// ---------------------------------------------------------------------------

// --- Per-image settings -----------------------------------------------------
// On top of the single global "last used" default above: each specific photo
// remembers its own edit, keyed by a fingerprint (name+size+lastModified —
// the closest thing to a stable ID the browser File API exposes, no real path
// available). This survives both switching between sidebar images in one
// session (each keeps its own look) and reopening the same file in a future
// session (localStorage, not in-memory) — "reload the image, get the same
// edit again". Falls back to the global default for a genuinely new file.
const PER_IMAGE_STORAGE_KEY = 'raw-editor-per-image-v1';
let activeFileKey = null;

function fileFingerprint(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function loadPerImageStore() {
  try {
    return JSON.parse(localStorage.getItem(PER_IMAGE_STORAGE_KEY) || '{}');
  } catch (err) {
    console.warn('could not load per-image settings', err);
    return {};
  }
}

function savePerImageLook(fileKey) {
  if (!fileKey) return;
  try {
    const store = loadPerImageStore();
    store[fileKey] = serializeLook();
    localStorage.setItem(PER_IMAGE_STORAGE_KEY, JSON.stringify(store));
  } catch (err) {
    console.warn('could not save per-image settings', err);
  }
}

function loadPerImageLook(fileKey) {
  if (!fileKey) return null;
  return loadPerImageStore()[fileKey] || null;
}
// ---------------------------------------------------------------------------

// darktable (GPL-3) ships a "sony alpha like" base curve — a tone curve
// approximating Sony Alpha bodies' own in-camera JPEG rendering, matched by
// maker (any Sony Alpha, not specifically the a6300). Applied first, like a
// camera profile, before the user's own adjustments sit on top of it.
// Source: darktable src/iop/basecurve.c, basecurve_presets[], "sony alpha like".
const SONY_ALPHA_LIKE_CURVE = [
  [0, 0],
  [0.031949, 0.036532],
  [0.105431, 0.228226],
  [0.434505, 0.759678],
  [0.855738, 0.983468],
  [1, 1],
];

// --- Tone curve editor ---------------------------------------------------
// A single value/luminance curve (no separate R/G/B channels) — click empty
// space to add a point, double-click a point to remove it. The end points
// default to sitting right on the left/right borders (x=0 / x=1); dragging
// one inward "detaches" it from the border, at which point the segment from
// the border to that point is drawn (and applied) as a flat straight line at
// the point's own height — i.e. a hard clip, the same way Photoshop/Lightroom's
// curve endpoints behave when pulled in from the corner.
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const IDENTITY_CURVE = () => [[0, 0], [1, 1]];
let curvePoints = IDENTITY_CURVE();

const curveCanvas = document.getElementById('curveCanvas');
const curveCtx = curveCanvas.getContext('2d');
const CURVE_W = curveCanvas.width;
const CURVE_H = curveCanvas.height;
const CURVE_POINT_R = 5;
const CURVE_HIT_R = 10;

function curveToCanvas([x, y]) {
  return [x * CURVE_W, CURVE_H - y * CURVE_H];
}
function canvasToCurve(cx, cy) {
  return [clamp01(cx / CURVE_W), clamp01(1 - cy / CURVE_H)];
}
function isCurveIdentity() {
  return curvePoints.length === 2
    && curvePoints[0][0] === 0 && curvePoints[0][1] === 0
    && curvePoints[1][0] === 1 && curvePoints[1][1] === 1;
}
function resetCurve() {
  curvePoints = IDENTITY_CURVE();
  drawCurve();
}
// The points actually fed to the spline/GPU: if an end point has detached from
// its border (x>0 for the first point, x<1 for the last), prepend/append a
// synthetic point at the border with the SAME y — since both ends of that
// segment share one y value, the line between them is flat regardless of the
// spline's shape elsewhere, giving the "straight line to the border" clip look.
function curveForEval() {
  const pts = curvePoints.map((p) => [...p]);
  if (pts[0][0] > 0) pts.unshift([0, pts[0][1]]);
  if (pts[pts.length - 1][0] < 1) pts.push([1, pts[pts.length - 1][1]]);
  return pts;
}
function findCurvePointNear(cx, cy) {
  for (let i = 0; i < curvePoints.length; i++) {
    const [px, py] = curveToCanvas(curvePoints[i]);
    if (Math.hypot(px - cx, py - cy) <= CURVE_HIT_R) return i;
  }
  return null;
}
function drawCurve() {
  curveCtx.clearRect(0, 0, CURVE_W, CURVE_H);

  // draw with the exact same spline the GPU shader evaluates (filterCurves uses this
  // same Spline class internally, fed the same border-augmented points), so the
  // preview line matches the real result.
  const spline = new Spline(curveForEval());
  curveCtx.strokeStyle = '#8ec9ff';
  curveCtx.lineWidth = 2;
  curveCtx.beginPath();
  for (let i = 0; i <= CURVE_W; i++) {
    const x = i / CURVE_W;
    const y = clamp01(spline.at(x));
    const [cx, cy] = curveToCanvas([x, y]);
    if (i === 0) curveCtx.moveTo(cx, cy); else curveCtx.lineTo(cx, cy);
  }
  curveCtx.stroke();

  curveCtx.fillStyle = '#fff';
  for (const p of curvePoints) {
    const [cx, cy] = curveToCanvas(p);
    curveCtx.beginPath();
    curveCtx.arc(cx, cy, CURVE_POINT_R, 0, Math.PI * 2);
    curveCtx.fill();
  }
}

let curveDragIndex = null;
curveCanvas.addEventListener('pointerdown', (e) => {
  const rect = curveCanvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  let idx = findCurvePointNear(cx, cy);
  if (idx === null) {
    const point = canvasToCurve(cx, cy);
    curvePoints.push(point);
    curvePoints.sort((a, b) => a[0] - b[0]);
    idx = curvePoints.indexOf(point);
  }
  curveDragIndex = idx;
  curveCanvas.setPointerCapture(e.pointerId);
  drawCurve();
});
curveCanvas.addEventListener('pointermove', (e) => {
  if (curveDragIndex === null) return;
  const rect = curveCanvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  let [x, y] = canvasToCurve(cx, cy);

  const isFirst = curveDragIndex === 0;
  const isLast = curveDragIndex === curvePoints.length - 1;
  if (isFirst) {
    // can detach anywhere from the left border up to just short of the next point
    const maxX = curvePoints.length > 1 ? curvePoints[1][0] - 0.02 : 1;
    x = Math.min(maxX, Math.max(0, x));
  } else if (isLast) {
    // can detach anywhere from the right border down to just past the previous point
    const minX = curvePoints.length > 1 ? curvePoints[curvePoints.length - 2][0] + 0.02 : 0;
    x = Math.max(minX, Math.min(1, x));
  } else {
    const minX = curvePoints[curveDragIndex - 1][0] + 0.02;
    const maxX = curvePoints[curveDragIndex + 1][0] - 0.02;
    x = Math.min(maxX, Math.max(minX, x));
  }
  curvePoints[curveDragIndex] = [x, y];
  drawCurve();
  scheduleRender();
});
curveCanvas.addEventListener('pointerup', (e) => {
  curveDragIndex = null;
  curveCanvas.releasePointerCapture(e.pointerId);
});
curveCanvas.addEventListener('dblclick', (e) => {
  const rect = curveCanvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const idx = findCurvePointNear(cx, cy);
  if (idx !== null && idx !== 0 && idx !== curvePoints.length - 1) {
    curvePoints.splice(idx, 1);
    drawCurve();
    scheduleRender();
  }
});
drawCurve();
// ---------------------------------------------------------------------------

const PREVIEW_MAX_DIM = 1800; // interactive edits run against a downscaled proxy; export re-renders at full res

let wgl = null;
let canvas = null;
let currentName = 'edited';
let fullResRaw = null; // { data: Uint16Array (RGB triplets), width, height } — kept only for the final export render

function resetSliders() {
  for (const key of SLIDER_KEYS) {
    state[key] = 0;
    const input = document.getElementById(key);
    input.value = 0;
    document.getElementById(key + 'Val').textContent = '0.00';
  }
}

// mini-gl's built-in "contrast" is a flat linear stretch around the midpoint
// (output = contrast*(input-0.5)+0.5) — simple, but it's the "crunchy" look
// that clips shadows/highlights symmetrically. Lightroom's Contrast slider is
// a parametric tone curve instead: a gentle S-shape that lifts the midtones
// while easing off near the extremes, so you get punch without losing shadow/
// highlight detail. mini-gl exposes a real curves engine (filterCurves), so we
// drive it with that same S-curve shape rather than using the linear version.
function contrastCurvePoints(strength) {
  const k = 0.18 * strength; // amplitude at full slider deflection
  return [
    [0, 0],
    [0.25, clamp01(0.25 - k)],
    [0.5, 0.5],
    [0.75, clamp01(0.75 + k)],
    [1, 1],
  ];
}

function applyFilters(wglInstance) {
  // mini-gl chains each filter call from wherever its internal buffer pointer
  // last landed, so every render pass must reset back to the loaded base
  // texture first, then reapply the *entire* current filter stack — otherwise
  // edits compound on top of the previous frame's output instead of the base image.
  wglInstance.loadImage();

  // Order matters, and this mirrors how Lightroom/ACR structure it:
  //
  // 1. Geometry first — straighten (rotate) with an auto-zoom so the frame stays
  //    fully filled (no empty corners), exactly like Lightroom/Photoshop's
  //    straighten tool: scale up by however much the rotated frame's bounding box
  //    exceeds the original, so the crop always shows the maximum content that
  //    still fills the canvas.
  if (state.straighten) {
    const rad = (Math.abs(state.straighten) * Math.PI) / 180;
    const w = wglInstance.width, h = wglInstance.height;
    const boundingW = w * Math.cos(rad) + h * Math.sin(rad);
    const boundingH = w * Math.sin(rad) + h * Math.cos(rad);
    const zoom = Math.max(boundingW / w - 1, boundingH / h - 1);
    // filterMatrix's own defaults only kick in when the whole params object is
    // omitted, not per-key — translateX/Y etc must be passed explicitly or they
    // come through as undefined and NaN out the entire transform matrix.
    wglInstance.filterMatrix({ angle: state.straighten, scale: zoom, translateX: 0, translateY: 0, flipv: 0, fliph: 0 });
  }

  // 2. Anti-aberration cleanup next, on data as close to the original as possible —
  //    it's detecting a lens/optical artifact (purple/green fringing at high-contrast
  //    edges), which is easiest to identify before tone-mapping reshapes contrast.
  if (state.defringe) {
    wglInstance.filterDefringe(state.defringe);
  }

  // 3. Exposure, in linear light (mathematically what "stops" means), with a
  //    soft highlight roll-off instead of a hard clamp — mini-gl's own filterAdjustments
  //    bakes exposure into the same color-matrix pass that ends with clamp(0,1), so
  //    pushing exposure there clips highlights to flat white *before* highlight/shadow
  //    recovery ever runs, making them structurally unrecoverable. Doing exposure as
  //    its own pass first, with a smooth compression above a knee, avoids that.
  wglInstance.filterExposure(state.exposure);

  // 4. Highlight/shadow recovery next, while the signal is still well-behaved.
  //    Skip the pass entirely when both are untouched — at full export resolution
  //    each of these is a real, non-free full-frame render, not worth paying for
  //    when it would just be an identity transform.
  if (state.highlights || state.shadows) {
    // Both args are negated relative to mini-photo-editor's own reference call,
    // which I originally copied assuming its slider convention matched ours —
    // it didn't, on either one. Verified by directly measuring output brightness:
    // positive Shadows must lift (brighten) shadows and positive Highlights must
    // recover (darken) highlights, matching Lightroom's convention.
    wglInstance.filterHighlightsShadows(-state.highlights, state.shadows);
  }

  // 5. Remaining "basic" adjustments (still linear light) — note: no exposure here,
  //    it's handled above. Same reasoning: skip the pass if every param is neutral.
  if (state.saturation || state.temperature || state.tint || state.vibrance || state.clarity || state.vignette) {
    wglInstance.filterAdjustments({
      saturation: state.saturation,
      temperature: state.temperature,
      tint: state.tint,
      vibrance: state.vibrance,
      clarity: state.clarity,
      vignette: state.vignette,
    });
  }

  // 6. Everything below is conventionally designed against display-referred
  //    (gamma-encoded) values — Whites/Blacks' clip-point thresholds, Dehaze's
  //    airlight-color estimate, and the tone curves (base "look", parametric
  //    contrast, the custom curve editor) all assume numbers like "0.92" mean
  //    "near white" the way a viewer actually perceives it. Applying them to
  //    our linear pipeline data instead is the same mistake as before with the
  //    curves (a value like 0.2 in linear light is a lot brighter than it looks
  //    gamma-encoded) — first attempt at Whites/Blacks/Dehaze in linear light
  //    crushed most of the frame to black. So: bracket the whole group.
  const curveActive = !isCurveIdentity();
  if (state.whites || state.blacks || state.dehaze || state.sonyLook || state.contrast || curveActive) {
    wglInstance.filterToGamma();
    // Whites/Blacks: distinct from Highlights/Shadows above — those do a regional
    // tone-compression recovery, these set the actual clip points (a plain levels remap).
    wglInstance.filterLevels(state.blacks, state.whites);
    // Dehaze: a real, working simplified haze-removal model (see filterDehaze.js for
    // the honest caveat vs. Adobe's per-pixel version).
    wglInstance.filterDehaze(state.dehaze);
    if (state.sonyLook) {
      wglInstance.filterCurves([SONY_ALPHA_LIKE_CURVE, null, null, null]);
    }
    if (state.contrast) {
      wglInstance.filterCurves([contrastCurvePoints(state.contrast), null, null, null]);
    }
    if (curveActive) {
      wglInstance.filterCurves([curveForEval(), null, null, null]);
    }
    wglInstance.filterToLinear();
  }

  // 7. Creative/cosmetic effects last, back in linear light.
  if (state.bloom) {
    wglInstance.filterBloom(state.bloom);
  }
}

let raf = null;
function render() {
  if (!wgl) return;
  applyFilters(wgl);
  wgl.paintCanvas();
  raf = null;
  saveSettings();
  savePerImageLook(activeFileKey);
}
function scheduleRender() {
  if (raf == null) raf = requestAnimationFrame(render);
}

// Converts LibRaw's 16-bit RGB output (Uint16Array, 3 channels, values 0..65535) into
// the RGBA Float32Array (0..1) our patched mini-gl fork uploads directly as a float
// texture — this is what keeps the full decode precision instead of quantizing to
// 8-bit through a canvas/<img> roundtrip. Note: the values here are still sRGB-encoded
// (LibRaw's outputColor:1), not linear — mini-gl's loadImage() does that conversion.
function uint16RGBToFloatRGBA(data, width, height) {
  const out = new Float32Array(width * height * 4);
  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
    out[j] = data[i] / 65535;
    out[j + 1] = data[i + 1] / 65535;
    out[j + 2] = data[i + 2] / 65535;
    out[j + 3] = 1;
  }
  return out;
}

// simple box-average downsample of 16-bit RGB data, capped to maxDim on the longest
// side — used to build the interactive preview without a second raw decode. Keeps
// full 16-bit precision (unlike the old canvas/<img>-based downscale).
function downsampleUint16RGB(data, srcWidth, srcHeight, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(srcWidth, srcHeight));
  if (scale === 1) return { data, width: srcWidth, height: srcHeight };

  const dstWidth = Math.round(srcWidth * scale);
  const dstHeight = Math.round(srcHeight * scale);
  const out = new Uint16Array(dstWidth * dstHeight * 3);

  for (let dy = 0; dy < dstHeight; dy++) {
    const sy0 = Math.floor((dy / dstHeight) * srcHeight);
    const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) / dstHeight) * srcHeight));
    for (let dx = 0; dx < dstWidth; dx++) {
      const sx0 = Math.floor((dx / dstWidth) * srcWidth);
      const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) / dstWidth) * srcWidth));

      let r = 0, g = 0, b = 0, count = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let srcIdx = (sy * srcWidth + sx0) * 3;
        for (let sx = sx0; sx < sx1; sx++, srcIdx += 3) {
          r += data[srcIdx];
          g += data[srcIdx + 1];
          b += data[srcIdx + 2];
          count++;
        }
      }
      const dstIdx = (dy * dstWidth + dx) * 3;
      out[dstIdx] = r / count;
      out[dstIdx + 1] = g / count;
      out[dstIdx + 2] = b / count;
    }
  }

  return { data: out, width: dstWidth, height: dstHeight };
}

// Lossless 90°-clockwise pixel transpose (no resampling, unlike the continuous
// Straighten slider) — repeated for 180°/270°. Swaps width/height for 90°/270°.
function rotate90CW(data, width, height) {
  const out = new Uint16Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 3;
      const nx = height - 1 - y;
      const ny = x;
      const dstIdx = (ny * height + nx) * 3;
      out[dstIdx] = data[srcIdx];
      out[dstIdx + 1] = data[srcIdx + 1];
      out[dstIdx + 2] = data[srcIdx + 2];
    }
  }
  return { data: out, width: height, height: width };
}

for (const key of SLIDER_KEYS) {
  const input = document.getElementById(key);
  const label = document.getElementById(key + 'Val');
  input.addEventListener('input', () => {
    state[key] = parseFloat(input.value);
    label.textContent = state[key].toFixed(2);
    scheduleRender();
  });
  input.addEventListener('dblclick', () => {
    input.value = 0;
    state[key] = 0;
    label.textContent = '0.00';
    scheduleRender();
  });
}

async function decodeArwToRaw(bytes) {
  setStatus('decoding raw…');
  const t0 = performance.now();
  const raw = new LibRaw();
  await raw.open(bytes, {
    useCameraWb: true,
    outputColor: 1,
    outputBps: 16, // keep the full 16-bit headroom — outputBps:8 would throw away
                    // sensor precision before any editing even happens
    userQual: 3,
  });
  const meta = await raw.metadata(false);
  const img = await raw.imageData();
  raw.dispose();
  const t1 = performance.now();

  // img.data is a Uint16Array here (3 channels, 0..65535) since outputBps:16 — no
  // canvas/<img> roundtrip, which would silently clamp everything back to 8-bit.
  return { data: img.data, meta, width: img.width, height: img.height, decodeMs: t1 - t0 };
}

function openFile() {
  fileInput.click();
}

fileInput.addEventListener('change', () => {
  for (const file of fileInput.files) addImageEntry(file);
  fileInput.value = '';
});

// --- Sidebar: multiple images, lazy-loaded ---------------------------------
// Adding a file to the sidebar only extracts its embedded preview JPEG
// (thumbnailData() — cheap, no demosaic) so the list populates fast regardless
// of how many files you drop in. The full 16-bit raw decode only happens when
// you actually click an entry.
const sidebarEl = document.getElementById('sidebar');
const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
toggleSidebarBtn.addEventListener('click', () => sidebarEl.classList.toggle('hidden'));

let imageEntries = [];
let activeEntryId = null;
let nextEntryId = 1;

function renderSidebar() {
  sidebarEl.innerHTML = '';
  for (const entry of imageEntries) {
    const item = document.createElement('div');
    item.className = 'thumb-item' + (entry.id === activeEntryId ? ' active' : '');
    item.addEventListener('click', () => selectImage(entry.id));

    if (entry.thumbUrl) {
      const wrap = document.createElement('div');
      wrap.className = 'thumb-img';
      const img = document.createElement('img');
      img.src = entry.thumbUrl;
      wrap.appendChild(img);
      item.appendChild(wrap);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'thumb-placeholder';
      placeholder.textContent = entry.thumbFailed ? 'no preview' : 'loading…';
      item.appendChild(placeholder);
    }

    const name = document.createElement('div');
    name.className = 'thumb-name';
    name.textContent = entry.name;
    item.appendChild(name);

    sidebarEl.appendChild(item);
  }
}

async function loadThumbnail(entry) {
  try {
    const bytes = new Uint8Array(await entry.file.arrayBuffer());
    const raw = new LibRaw();
    await raw.open(bytes);
    const thumb = await raw.thumbnailData();
    raw.dispose();
    if (thumb && thumb.format === 'jpeg') {
      entry.thumbUrl = URL.createObjectURL(new Blob([thumb.data], { type: 'image/jpeg' }));
    } else {
      entry.thumbFailed = true;
    }
  } catch (err) {
    console.warn('thumbnail failed for', entry.name, err);
    entry.thumbFailed = true;
  }
  renderSidebar();
}

function addImageEntry(file) {
  const entry = { id: nextEntryId++, file, name: file.name, thumbUrl: null, thumbFailed: false };
  imageEntries.push(entry);
  renderSidebar();
  loadThumbnail(entry);
  if (activeEntryId === null) selectImage(entry.id);
}

async function selectImage(id) {
  const entry = imageEntries.find((e) => e.id === id);
  if (!entry) return;
  activeEntryId = id;
  renderSidebar();
  const data = new Uint8Array(await entry.file.arrayBuffer());
  await processFile({ name: entry.name, data, fileKey: fileFingerprint(entry.file) });
}
// ---------------------------------------------------------------------------

// (Re)builds the interactive preview canvas/mini-gl instance from whatever is
// currently in fullResRaw. Used both right after decoding a file and after a
// 90° rotation (which changes fullResRaw's dimensions in place).
function rebuildPreview(keepEdits) {
  const preview = downsampleUint16RGB(fullResRaw.data, fullResRaw.width, fullResRaw.height, PREVIEW_MAX_DIM);
  const previewFloatRGBA = uint16RGBToFloatRGBA(preview.data, preview.width, preview.height);
  const previewImg = { naturalWidth: preview.width, naturalHeight: preview.height, floatData: previewFloatRGBA };

  canvasWrap.innerHTML = '';
  canvas = document.createElement('canvas');
  canvas.width = preview.width;
  canvas.height = preview.height;
  canvasWrap.appendChild(canvas);

  if (wgl) wgl.destroy();
  wgl = minigl(canvas, previewImg, 'srgb');
  wgl.loadImage();
  if (!keepEdits) {
    // new image: this exact file's own remembered edit if we've seen it before
    // (by fingerprint — switching back to an already-edited sidebar image, or
    // reopening the same file in a future session), else the global last-used
    // default. Straighten always resets for a genuinely new image, regardless.
    resetStraighten();
    applyLook(loadPerImageLook(activeFileKey) || loadSavedSettings());
  }
  render();
}

async function processFile(file) {
  openBtn.disabled = true;
  setStatus(`opening ${file.name}…`);
  currentName = file.name.replace(/\.arw$/i, '') || 'edited';
  activeFileKey = file.fileKey || null;

  try {
    const { data, meta, width, height, decodeMs } = await decodeArwToRaw(file.data);
    fullResRaw = { data, width, height };

    rebuildPreview(false);

    exportBtn.disabled = false;
    resetBtn.disabled = false;
    rotate90Btn.disabled = false;
    setStatus(`${meta.camera_model} · ${width}x${height} (editing at ${canvas.width}x${canvas.height}, 16-bit) · decoded in ${decodeMs.toFixed(0)}ms`);
  } catch (err) {
    console.error(err);
    setStatus('failed to decode: ' + err.message);
  } finally {
    openBtn.disabled = false;
  }
}

function rotate90() {
  if (!fullResRaw) return;
  fullResRaw = rotate90CW(fullResRaw.data, fullResRaw.width, fullResRaw.height);
  rebuildPreview(true); // keep current edits — rotation is a geometry change, not an edit reset
  setStatus(`rotated to ${fullResRaw.width}x${fullResRaw.height}`);
}

function exportFile() {
  if (!wgl || !fullResRaw) return;
  setStatus('rendering full-resolution export…');

  console.time('export: uint16->float RGBA');
  const fullResFloatRGBA = uint16RGBToFloatRGBA(fullResRaw.data, fullResRaw.width, fullResRaw.height);
  console.timeEnd('export: uint16->float RGBA');
  const fullResImg = { naturalWidth: fullResRaw.width, naturalHeight: fullResRaw.height, floatData: fullResFloatRGBA };

  console.time('export: minigl create + upload');
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = fullResRaw.width;
  exportCanvas.height = fullResRaw.height;
  const exportWgl = minigl(exportCanvas, fullResImg, 'srgb');
  console.timeEnd('export: minigl create + upload');

  console.time('export: applyFilters + paint');
  applyFilters(exportWgl);
  exportWgl.paintCanvas();
  console.timeEnd('export: applyFilters + paint');

  console.time('export: captureImage (readback+encode)');
  const dataUrl = exportWgl.captureImage('image/jpeg', 0.92).src;
  console.timeEnd('export: captureImage (readback+encode)');
  exportWgl.destroy();

  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `${currentName}.jpg`;
  a.click();
  setStatus(`exported ${currentName}.jpg (${exportCanvas.width}x${exportCanvas.height})`);
}

openBtn.addEventListener('click', openFile);
exportBtn.addEventListener('click', exportFile);
resetBtn.addEventListener('click', () => { resetSliders(); resetCurve(); render(); });
rotate90Btn.addEventListener('click', rotate90);
sonyLookCheckbox.addEventListener('change', () => {
  state.sonyLook = sonyLookCheckbox.checked;
  scheduleRender();
});

window.__testOpenBytes = async (bytes) => {
  await processFile({ name: 'test.arw', data: bytes });
};
window.__testSetSlider = (key, val) => {
  const input = document.getElementById(key);
  input.value = val;
  input.dispatchEvent(new Event('input'));
};
window.__testCapture = () => wgl ? wgl.captureImage('image/jpeg', 0.9).src : null;
window.__testCurvePoints = () => curvePoints;
