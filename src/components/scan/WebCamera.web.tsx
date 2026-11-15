import { useEffect, useRef, useState } from 'react';

import { cameraProblem, firstRead, frameSize, type CameraProblem } from '@/lib/webBarcode';

// The web scanner's camera: the back camera (getUserMedia) in a <video> filling its parent, and a
// loop decoding its frames with ZXing (src/lib/zxingReader.ts, loaded on first use). iOS Safari has
// no BarcodeDetector, so the decoding is ZXing's on every browser alike.

export type WebCameraProps = {
  /** The camera runs: false while another screen covers this one or once a code is found. */
  active: boolean;
  /** Frames are decoded: false during a lookup and while its result is shown. */
  scanning: boolean;
  /** A barcode read, as the native scanner reports one. */
  onRead: (read: { type: string; data: string }) => void;
  /** The camera is running (the spinner goes), or the reason it can't (the typed field takes over). */
  onState: (state: 'live' | CameraProblem) => void;
};

/** How long the loop waits after a frame without a barcode: about 8 frames a second at most. */
const FRAME_GAP_MS = 120;

type Reader = typeof import('@/lib/zxingReader');
let reader: Promise<Reader> | null = null;
const loadReader = (): Promise<Reader> => {
  reader ??= import('@/lib/zxingReader').catch((e) => {
    reader = null; // a failed chunk download is tried again next time
    throw e;
  });
  return reader;
};

/** True while the page is shown: the camera stops when the app goes to the background. */
function usePageVisible() {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

export function WebCamera({ active, scanning, onRead, onState }: WebCameraProps) {
  const video = useRef<HTMLVideoElement>(null);
  const visible = usePageVisible();
  const [live, setLive] = useState(false);
  // The latest callbacks, for the effects below without restarting the camera when they change.
  const callbacks = useRef({ onRead, onState });
  callbacks.current = { onRead, onState };

  const on = active && visible;

  // The camera: started while `on`, every track stopped as soon as it isn't (or the screen goes).
  useEffect(() => {
    if (!on) return;
    const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    if (!media?.getUserMedia) {
      callbacks.current.onState('unsupported'); // no camera API (an old browser, or not https)
      return;
    }
    let stream: MediaStream | null = null;
    let stopped = false;
    media
      .getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } })
      .then(async (s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        // The camera taken away (another app, unplugged, iOS revoking it): the typed field.
        for (const track of s.getVideoTracks()) track.addEventListener('ended', () => !stopped && callbacks.current.onState('failed'));
        const el = video.current;
        if (!el) return;
        el.srcObject = s;
        try {
          await el.play(); // muted + playsInline: iOS allows it without a tap
        } catch {
          if (!stopped) callbacks.current.onState('failed'); // the tracks stop as the screen swaps
          return;
        }
        if (stopped) return;
        setLive(true);
        callbacks.current.onState('live');
      })
      .catch((e: unknown) => {
        if (!stopped) callbacks.current.onState(cameraProblem(e));
      });
    return () => {
      stopped = true;
      setLive(false);
      stream?.getTracks().forEach((t) => t.stop());
      if (video.current) video.current.srcObject = null;
    };
  }, [on]);

  // The decoding loop: one frame at a time, scaled down, until a code is read.
  useEffect(() => {
    if (!live || !scanning) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = async (read: Reader['readFrame']) => {
      if (cancelled) return;
      const el = video.current;
      if (ctx && el && el.readyState >= el.HAVE_CURRENT_DATA && el.videoWidth > 0) {
        const { width, height } = frameSize(el.videoWidth, el.videoHeight);
        if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
        ctx.drawImage(el, 0, 0, width, height);
        const hit = firstRead(await read(ctx.getImageData(0, 0, width, height)).catch(() => []));
        if (cancelled) return;
        if (hit) return callbacks.current.onRead(hit); // scanning turns false: this loop ends
      }
      timer = setTimeout(() => void tick(read), FRAME_GAP_MS);
    };
    loadReader().then(
      (r) => void tick(r.readFrame),
      () => !cancelled && callbacks.current.onState('failed'),
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [live, scanning]);

  return (
    <video
      ref={video}
      autoPlay
      muted
      playsInline
      aria-label="Camera"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', backgroundColor: 'black' }}
    />
  );
}
