// Native builds never show the web camera (scan-food.tsx uses expo-camera there); this stub keeps
// the browser-only code and its decoder out of the native bundle. The web version: WebCamera.web.tsx.
import type { WebCameraProps } from './WebCamera.web';

export type { WebCameraProps } from './WebCamera.web';

export function WebCamera(_: WebCameraProps): null {
  return null;
}
