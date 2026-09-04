import { readFile, writeFile } from 'node:fs/promises';
import Worker from 'web-worker';
import LibRaw from 'libraw-wasm';
import sharp from 'sharp';

globalThis.Worker = Worker;

const inputPath = process.argv[2] ?? '../DSC03245.ARW';

console.time('total');

const buf = await readFile(inputPath);

console.time('open+decode');
const raw = new LibRaw();
await raw.open(new Uint8Array(buf), {
  useCameraWb: true,
  outputColor: 1, // sRGB
  outputBps: 16,
  userQual: 3, // AHD demosaic
});

const meta = await raw.metadata(true);
console.log('--- metadata ---');
console.log({
  make: meta.camera_make,
  model: meta.camera_model,
  width: meta.width,
  height: meta.height,
  iso: meta.iso_speed,
  shutter: meta.shutter,
  aperture: meta.aperture,
  focal_len: meta.focal_len,
  timestamp: meta.timestamp,
});

const img = await raw.imageData();
console.timeEnd('open+decode');
console.log('--- imageData ---');
console.log({
  width: img.width,
  height: img.height,
  colors: img.colors,
  bits: img.bits,
  dataSize: img.dataSize,
  dataLength: img.data.length,
});

raw.dispose();

console.time('encode preview jpeg');
// img.data is interleaved RGB, 16-bit big-endian? need to check; sharp expects raw buffer + description
const jpegBuf = await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
  raw: { width: img.width, height: img.height, channels: img.colors, premultiplied: false },
})
  .toColourspace('srgb')
  .jpeg({ quality: 92 })
  .toBuffer();
console.timeEnd('encode preview jpeg');

await writeFile('./preview.jpg', jpegBuf);
console.log('wrote preview.jpg', jpegBuf.length, 'bytes');

console.timeEnd('total');
