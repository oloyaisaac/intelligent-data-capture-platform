/**
 * MOB-002 — the bridge between the camera frame stream and the detector.
 *
 * VisionCamera hands frames to a worklet; a worklet may not touch React state. The app's frame
 * processor therefore calls `bridge.push(frame)` through `runOnJS`, and React subscribes to the
 * bridge. Keeping the bridge pure means the whole path can be tested in Node, and the app only has
 * to wire the platform callback.
 *
 * ```ts
 * const processor = useFrameProcessor((frame) => {
 *   'worklet';
 *   runOnJS(bridge.push)({ data: frame.toArrayBuffer(), width: frame.width, height: frame.height });
 * }, [bridge]);
 * ```
 */
import { useEffect, useState } from 'react';
import {
  detectDocumentQuad,
  smoothQuad,
  type Detection,
  type DetectionOptions,
  type LumaFrame,
} from './edgeDetection';
import type { Quad, Size } from './imagePipeline';

export interface FrameBridge {
  push(frame: LumaFrame): void;
  current(): Detection | null;
  subscribe(listener: (detection: Detection | null) => void): () => void;
  reset(): void;
}

export interface FrameBridgeOptions extends DetectionOptions {
  /** Frames are only evaluated this often (milliseconds); the camera runs much faster. */
  throttleMs?: number;
  /** Frames below this confidence keep the previous outline instead of flickering. */
  minConfidence?: number;
  now?: () => number;
}

export function createFrameBridge(options: FrameBridgeOptions = {}): FrameBridge {
  const throttleMs = options.throttleMs ?? 120;
  const minConfidence = options.minConfidence ?? 0.35;
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<(detection: Detection | null) => void>();
  // Start in the past so the very first frame is evaluated, whatever the clock says.
  let last = Number.NEGATIVE_INFINITY;
  let latest: Detection | null = null;

  const publish = (detection: Detection | null) => {
    latest = detection;
    for (const listener of listeners) listener(detection);
  };

  return {
    push(frame) {
      const stamp = now();
      if (stamp - last < throttleMs) return;
      last = stamp;

      const detection = detectDocumentQuad(frame, options);
      if (!detection) {
        // No page this frame: keep the last good outline rather than emptying the overlay.
        return;
      }
      if (detection.confidence < minConfidence) return;

      const size: Size = { width: frame.width, height: frame.height };
      const quad: Quad = latest ? smoothQuad(latest.quad, detection.quad, size) : detection.quad;
      publish({ ...detection, quad });
    },
    current: () => latest,
    subscribe(listener) {
      listeners.add(listener);
      listener(latest);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      latest = null;
      publish(null);
    },
  };
}

/** React binding: the latest detection (and its smoothed quad) for the overlay and the capture. */
export function useDocumentDetector(bridge: FrameBridge): Detection | null {
  const [detection, setDetection] = useState<Detection | null>(() => bridge.current());
  useEffect(() => bridge.subscribe(setDetection), [bridge]);
  return detection;
}
