// The web scanner's decoding (src/lib/webBarcode.ts) against ZXing itself: the same zxing-wasm
// reader and options the app loads, on barcodes drawn by ZXing's writer. Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isUpcE, upcEToUpcA } from '../src/lib/barcodeApi.ts';
import { cameraProblem, firstRead, frameSize, MAX_FRAME_SIDE, READER_OPTIONS } from '../src/lib/webBarcode.ts';
import { barcodeFrame, rgba, zxingFull } from './barcodeImage.mjs';

/** What scan-food.tsx looks up for a frame: the read, a UPC-E as its UPC-A. */
const scan = async (frame) => {
  const zx = await zxingFull();
  const hit = firstRead(await zx.readBarcodes(rgba(frame), READER_OPTIONS));
  return hit && { ...hit, code: isUpcE(hit.type) ? upcEToUpcA(hit.data) : hit.data };
};

test('EAN-13 and EAN-8 are read as their digits', async () => {
  assert.deepEqual(await scan(await barcodeFrame('0737628064502', 'EAN13')), { type: 'EAN13', data: '0737628064502', code: '0737628064502' });
  assert.deepEqual(await scan(await barcodeFrame('96385074', 'EAN8')), { type: 'EAN8', data: '96385074', code: '96385074' });
});

// ZXing C++ reports a UPC-A as the EAN-13 it is part of (a leading 0), as iOS's own scanner does;
// the server takes both spellings as one product (backend/app/services/barcodes.py normalize).
test('a UPC-A is read as its EAN-13 spelling', async () => {
  assert.deepEqual(await scan(await barcodeFrame('036000291452', 'UPCA')), { type: 'EAN13', data: '0036000291452', code: '0036000291452' });
});

// ZXing C++ already expands a UPC-E to the 13 digits of its UPC-A, so it is never taken for an
// EAN-8; upcEToUpcA leaves 13 digits as they are (it only expands 8), so the two never disagree.
test('a UPC-E is looked up as its UPC-A, never as 8 digits', async () => {
  const hit = await scan(await barcodeFrame('01234565', 'UPCE'));
  assert.equal(hit.type, 'UPCE');
  assert.equal(hit.code, '0' + upcEToUpcA('01234565'));
});

test('a frame without a barcode, or with one the scanner does not read (Code 128), gives nothing', async () => {
  assert.equal(await scan({ width: 640, height: 480, gray: new Uint8Array(640 * 480).fill(255) }), null);
  assert.equal(await scan(await barcodeFrame('KALO-12345', 'Code128')), null);
});

test('a small, upside-down barcode in a big frame is still read', async () => {
  const frame = await barcodeFrame('0737628064502', 'EAN13', { width: MAX_FRAME_SIDE, height: 540, module: 2 });
  const flipped = { ...frame, gray: frame.gray.slice().reverse() };
  assert.equal((await scan(flipped))?.code, '0737628064502');
});

test('firstRead skips invalid reads', () => {
  assert.equal(firstRead([{ isValid: false, text: '123', format: 'EAN8' }]), null);
  assert.deepEqual(firstRead([{ isValid: false, text: '1', format: 'EAN8' }, { isValid: true, text: '96385074', format: 'EAN8' }]), { type: 'EAN8', data: '96385074' });
});

test('frames are scaled down to MAX_FRAME_SIDE, never up', () => {
  assert.deepEqual(frameSize(1920, 1080), { width: MAX_FRAME_SIDE, height: 540 });
  assert.deepEqual(frameSize(1080, 1920), { width: 540, height: MAX_FRAME_SIDE });
  assert.deepEqual(frameSize(640, 480), { width: 640, height: 480 });
});

test('getUserMedia errors: denied, no camera, or anything else', () => {
  assert.equal(cameraProblem(Object.assign(new Error('x'), { name: 'NotAllowedError' })), 'denied');
  assert.equal(cameraProblem({ name: 'SecurityError' }), 'denied');
  assert.equal(cameraProblem({ name: 'NotFoundError' }), 'no_camera');
  assert.equal(cameraProblem({ name: 'OverconstrainedError' }), 'no_camera');
  assert.equal(cameraProblem({ name: 'NotReadableError' }), 'failed');
  assert.equal(cameraProblem(undefined), 'failed');
});
