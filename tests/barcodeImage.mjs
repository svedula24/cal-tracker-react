// Barcode pictures for the web scanner's checks: ZXing's own writer (zxing-wasm/full, Node only)
// draws the symbol, which is centred on a white frame like a product held up to the camera.
// Used by tests/webBarcode.test.mjs and the fake camera of e2e/pwa.mjs.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

let ready;
/** zxing-wasm's full build (reader and writer), its .wasm read from node_modules (no CDN). */
export function zxingFull() {
  ready ??= import('zxing-wasm/full').then(async (zx) => {
    const wasm = fs.readFileSync(fileURLToPath(import.meta.resolve('zxing-wasm/full/zxing_full.wasm')));
    await zx.prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) }, fireImmediately: true });
    return zx;
  });
  return ready;
}

/**
 * A `width` x `height` greyscale frame (one byte a pixel, 255 white) with the barcode `text` in
 * `format` (ZXing's names: EAN13, EAN8, UPCA, UPCE) in the middle, `module` pixels a bar unit.
 */
export async function barcodeFrame(text, format, { width = 640, height = 480, module = 3 } = {}) {
  const zx = await zxingFull();
  const written = await zx.writeBarcode(text, { format });
  if (written.error) throw new Error(`${format} ${text}: ${written.error}`);
  const { symbol } = written; // one byte a module: 0 bar, 255 space
  const gray = new Uint8Array(width * height).fill(255);
  const w = symbol.width * module;
  const h = Math.min(symbol.height * module, Math.round(height * 0.5));
  const left = Math.round((width - w) / 2);
  const top = Math.round((height - h) / 2);
  if (left < 10) throw new Error(`${format} ${text} is too wide for a ${width}px frame`);
  for (let y = 0; y < h; y++) {
    const row = Math.min(symbol.height - 1, Math.floor(y / module));
    for (let x = 0; x < w; x++) gray[(top + y) * width + left + x] = symbol.data[row * symbol.width + Math.floor(x / module)];
  }
  return { width, height, gray };
}

/** A greyscale frame as RGBA ImageData-like pixels, what the scanner hands the reader. */
export const rgba = ({ width, height, gray }) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < gray.length; i++) data.set([gray[i], gray[i], gray[i], 255], i * 4);
  return { width, height, data };
};

/**
 * A Y4M video of greyscale frames, for Chromium's fake camera
 * (--use-file-for-fake-video-capture). Each frame is shown `repeat` times at 10 fps; the video loops.
 */
export function y4m(frames, repeat = 10) {
  const { width, height } = frames[0];
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128); // no colour
  const parts = [Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\n`)];
  for (const f of frames) for (let i = 0; i < repeat; i++) parts.push(Buffer.from('FRAME\n'), Buffer.from(f.gray), chroma);
  return Buffer.concat(parts);
}
