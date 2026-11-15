// The web scanner's decoding rules (src/components/scan/WebCamera.web.tsx), kept free of the
// decoder itself so Node can test them against real ZXing output (tests/webBarcode.test.mjs).
//
// The decoder is zxing-wasm's reader (ZXing C++ compiled to WebAssembly): iOS Safari has no
// BarcodeDetector, so the app brings its own. It is loaded only on the scan screen.

/** The retail formats the native scanner reads (scan-food.tsx BARCODE_TYPES), in ZXing's names. */
export const RETAIL_FORMATS = ['EAN13', 'EAN8', 'UPCA', 'UPCE'] as const;

/** ZXing reader options for a camera frame: retail codes only, one per frame, the thorough search. */
export const READER_OPTIONS = {
  formats: [...RETAIL_FORMATS],
  tryHarder: true,
  tryRotate: true,
  maxNumberOfSymbols: 1,
} as const;

/** The longest side a frame is scaled down to before decoding: about 2.5 px a bar unit for a barcode
 *  a quarter of the picture wide, and quick on a phone. */
export const MAX_FRAME_SIDE = 960;

/** The part of a ZXing read result the scanner uses. */
export type Read = { isValid: boolean; text: string; format: string };

/**
 * The first valid read of a frame as the native scanner reports one ({ type, data }), or null.
 * scan-food.tsx then turns a UPC-E into its UPC-A and checks the digits, for both scanners alike.
 */
export function firstRead(results: readonly Read[]): { type: string; data: string } | null {
  const hit = results.find((r) => r.isValid && r.text);
  return hit ? { type: hit.format, data: hit.text } : null;
}

/** The width and height a video frame is drawn at: scaled down to MAX_FRAME_SIDE, never up. */
export function frameSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(width, height, 1));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Why the camera can't be used, from a getUserMedia error: the typed field takes its place. */
export type CameraProblem = 'unsupported' | 'denied' | 'no_camera' | 'failed';

export function cameraProblem(error: unknown): CameraProblem {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'no_camera';
  return 'failed'; // NotReadableError (in use elsewhere), AbortError, anything else
}
