/**
 * MOB-002 — the platform shim that feeds camera frames to the detector.
 *
 * VisionCamera frame processors are worklets, and the worklet runtime comes from
 * `react-native-worklets-core`. Neither can run in this repository's test environment, so this
 * module degrades honestly:
 *
 *   - with both native modules present, it builds a frame processor that copies the luminance plane
 *     and hands it to the bridge on the JS thread (throttled by the bridge itself);
 *   - without them, it renders nothing and the capture screen simply has no auto-detected outline.
 *
 * The detection, ordering, plausibility and smoothing logic lives in `edgeDetection.ts` and is
 * covered by tests that do not need a camera.
 */
import React, { useEffect, useMemo } from 'react';
import type { FrameBridge } from './useDocumentDetector';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
function optionalRequire<T>(name: string): T | null {
  try {
    return require(name) as T;
  } catch {
    return null;
  }
}

interface VisionModule {
  useFrameProcessor: (processor: (frame: any) => void, deps: unknown[]) => unknown;
}
interface WorkletsModule {
  useRunOnJS: <T extends (...args: never[]) => unknown>(fn: T, deps: unknown[]) => T;
}

const vision = optionalRequire<VisionModule>('react-native-vision-camera');
const worklets = optionalRequire<WorkletsModule>('react-native-worklets-core');

/** Whether this build can process frames at all. */
export function frameProcessorAvailable(): boolean {
  return Boolean(vision?.useFrameProcessor && worklets?.useRunOnJS);
}

/**
 * Reports the frame processor once it exists. The camera screen passes the result to `<Camera
 * frameProcessor={...}>`; until then it captures without an overlay.
 */
function ProcessorBridge({
  bridge,
  onProcessor,
}: {
  bridge: FrameBridge;
  onProcessor: (processor: unknown) => void;
}): null {
  const modules = vision!;
  const worklet = worklets!;

  const pushFrame = useMemo(
    () => (data: Uint8Array, width: number, height: number) => bridge.push({ data, width, height }),
    [bridge],
  );
  const onFrame = worklet.useRunOnJS(pushFrame, [pushFrame]);

  const processor = modules.useFrameProcessor(
    (frame: any) => {
      'worklet';
      try {
        // The Y plane of a YUV frame is exactly the luminance the detector wants.
        const buffer = frame.toArrayBuffer() as ArrayBuffer;
        const luma = new Uint8Array(
          buffer,
          0,
          Math.min(buffer.byteLength, frame.width * frame.height),
        );
        onFrame(luma, frame.width, frame.height);
      } catch {
        // A frame that cannot be read is simply skipped; the last good outline stays.
      }
    },
    [onFrame],
  );

  useEffect(() => {
    onProcessor(processor);
  }, [onProcessor, processor]);

  return null;
}

/** Mount inside the capture screen when a bridge exists; it renders nothing. */
export function DocumentFrameProcessor({
  bridge,
  onProcessor,
}: {
  bridge: FrameBridge;
  onProcessor: (processor: unknown) => void;
}): React.JSX.Element | null {
  if (!frameProcessorAvailable()) return null;
  return <ProcessorBridge bridge={bridge} onProcessor={onProcessor} />;
}
