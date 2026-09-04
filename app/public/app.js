import LibRaw from '/node_modules/libraw-wasm/dist/index.js';
import { minigl } from '/vendor/mini-gl/minigl.js';

const statusEl = document.getElementById('status');
const setStatus = (s) => { statusEl.textContent = s; };

const openBtn = document.getElementById('openBtn');
const fileInput = document.getElementById('fileInput');
const exportBtn = document.getElementById('exportBtn');
const resetBtn = document.getElementById('resetBtn');
const canvasWrap = document.getElementById('canvasWrap');

const SLIDER_KEYS = ['exposure', 'contrast', 'saturation', 'temperature', 'vibrance', 'highlights', 'shadows', 'clarity', 'vignette', 'bloom'];
const state = Object.fromEntries(SLIDER_KEYS.map((k) => [k, 0]));
state.sonyLook = false;

const sonyLookCheckbox = document.getElementById('sonyLook');

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
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
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
  if (state.sonyLook) {
    wglInstance.filterCurves([SONY_ALPHA_LIKE_CURVE, null, null, null]);
  }
  wglInstance.filterAdjustments({
    exposure: state.exposure,
    saturation: state.saturation,
    temperature: state.temperature,
    vibrance: state.vibrance,
    clarity: state.clarity,
    vignette: state.vignette,
  });
  wglInstance.filterHighlightsShadows(state.highlights, -state.shadows);
  if (state.contrast) {
    wglInstance.filterCurves([contrastCurvePoints(state.contrast), null, null, null]);
  }
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

fileInput.addEventListener('change', async () => {
  const f = fileInput.files[0];
  if (!f) return;
  const data = new Uint8Array(await f.arrayBuffer());
  await processFile({ name: f.name, data });
  fileInput.value = '';
});

async function processFile(file) {
  openBtn.disabled = true;
  setStatus(`opening ${file.name}…`);
  currentName = file.name.replace(/\.arw$/i, '') || 'edited';

  try {
    const { data, meta, width, height, decodeMs } = await decodeArwToRaw(file.data);
    fullResRaw = { data, width, height };

    const preview = downsampleUint16RGB(data, width, height, PREVIEW_MAX_DIM);
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
    resetSliders();
    render();

    exportBtn.disabled = false;
    resetBtn.disabled = false;
    setStatus(`${meta.camera_model} · ${width}x${height} (editing at ${canvas.width}x${canvas.height}, 16-bit) · decoded in ${decodeMs.toFixed(0)}ms`);
  } catch (err) {
    console.error(err);
    setStatus('failed to decode: ' + err.message);
  } finally {
    openBtn.disabled = false;
  }
}

function exportFile() {
  if (!wgl || !fullResRaw) return;
  setStatus('rendering full-resolution export…');

  // re-render the whole filter stack against the original full-res 16-bit decode,
  // not the downscaled preview, so export quality (and radius-based filters like
  // clarity) isn't limited by the interactive preview's resolution.
  const fullResFloatRGBA = uint16RGBToFloatRGBA(fullResRaw.data, fullResRaw.width, fullResRaw.height);
  const fullResImg = { naturalWidth: fullResRaw.width, naturalHeight: fullResRaw.height, floatData: fullResFloatRGBA };

  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = fullResRaw.width;
  exportCanvas.height = fullResRaw.height;
  const exportWgl = minigl(exportCanvas, fullResImg, 'srgb');
  applyFilters(exportWgl);
  exportWgl.paintCanvas();

  const dataUrl = exportWgl.captureImage('image/jpeg', 0.92).src;
  exportWgl.destroy();

  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `${currentName}.jpg`;
  a.click();
  setStatus(`exported ${currentName}.jpg (${exportCanvas.width}x${exportCanvas.height})`);
}

openBtn.addEventListener('click', openFile);
exportBtn.addEventListener('click', exportFile);
resetBtn.addEventListener('click', () => { resetSliders(); render(); });
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
