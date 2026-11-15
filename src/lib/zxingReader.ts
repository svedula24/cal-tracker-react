// The barcode decoder for the web scanner, loaded with import() from WebCamera.web.tsx only: Metro
// puts it, and the .wasm it fetches, in their own chunk, so the app's main bundle stays as it was.
//
// zxing-wasm fetches its .wasm from jsDelivr unless told otherwise; Kalo serves its own copy (a
// Metro asset, metro.config.js), so scanning needs no third-party host and the decoder's version is
// the one in package-lock.json.
import { Asset } from 'expo-asset';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

import { READER_OPTIONS, type Read } from '@/lib/webBarcode';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const wasmUrl = Asset.fromModule(require('zxing-wasm/reader/zxing_reader.wasm')).uri;

prepareZXingModule({
  overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
});

/** The retail barcodes ZXing finds in one camera frame. */
export const readFrame = (frame: ImageData): Promise<Read[]> => readBarcodes(frame, READER_OPTIONS as never);
