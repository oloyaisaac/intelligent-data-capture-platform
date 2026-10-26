/**
 * MOB-002 — crop, enhance and compress a capture before it is queued.
 *
 * The phone's raw photo is the wrong shape for the pipeline: a 12 MP frame at quality 1.0 is
 * several megabytes over a mobile connection, and most of the frame is desk, not document. This
 * module decides *what* to do from the numbers alone, so the decisions are testable in Node without
 * a camera, and the actual pixel work is delegated to a transformer the app injects
 * (react-native-image-manipulator in the app; a fake in tests).
 */

export interface Size {
  width: number;
  height: number;
}

/** A document's four corners in the camera frame, as found by the capture preview's edge overlay. */
export interface Quad {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}

export interface Point {
  x: number;
  y: number;
}

export interface CropRect extends Size {
  originX: number;
  originY: number;
}

export interface ProcessingOptions {
  /** Longest edge after downscaling. 1600 px keeps A4 text readable for OCR. */
  targetLongEdge?: number;
  /** Bytes we are willing to upload; the server's limit is 20 MB, but data costs are real. */
  maxBytes?: number;
  /** JPEG quality floor: below this, text starts to smear and OCR accuracy drops. */
  minQuality?: number;
  /** Padding around the detected document, as a fraction of its size. */
  padding?: number;
}

export interface ProcessingPlan {
  crop: CropRect | null;
  /** Degrees to rotate so the document reads upright (EXIF orientation, MOB-002). */
  rotate: 0 | 90 | 180 | 270;
  resize: Size | null;
  quality: number;
  /** Whether a mild contrast/sharpen pass is worth it (only for flat or low-contrast scans). */
  enhance: boolean;
  /** Human-readable reasons, surfaced in the UI so a rejected photo is explainable. */
  steps: string[];
}

const DEFAULTS: Required<ProcessingOptions> = {
  targetLongEdge: 1600,
  maxBytes: 2 * 1024 * 1024,
  minQuality: 0.6,
  padding: 0.02,
};

/**
 * The crop rectangle for a detected quad, clamped to the frame.
 *
 * A quad that is degenerate (a tap on the screen, a false positive from the detector) is rejected:
 * cropping to a two-pixel box would throw the document away rather than frame it.
 */
export function cropRectForQuad(
  quad: Quad | null,
  frame: Size,
  padding = DEFAULTS.padding,
): CropRect | null {
  if (!quad || frame.width <= 0 || frame.height <= 0) return null;

  const xs = [quad.topLeft.x, quad.topRight.x, quad.bottomRight.x, quad.bottomLeft.x];
  const ys = [quad.topLeft.y, quad.topRight.y, quad.bottomRight.y, quad.bottomLeft.y];
  if (xs.some((value) => !Number.isFinite(value)) || ys.some((value) => !Number.isFinite(value))) {
    return null;
  }

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  // A document that covers less than a tenth of the frame is almost certainly a misdetection.
  const area = (maxX - minX) * (maxY - minY);
  if (area < frame.width * frame.height * 0.1) return null;

  const padX = (maxX - minX) * padding;
  const padY = (maxY - minY) * padding;

  const originX = clamp(Math.round(minX - padX), 0, frame.width - 1);
  const originY = clamp(Math.round(minY - padY), 0, frame.height - 1);
  const width = clamp(Math.round(maxX + padX) - originX, 1, frame.width - originX);
  const height = clamp(Math.round(maxY + padY) - originY, 1, frame.height - originY);

  return { originX, originY, width, height };
}

/** Downscale so the longest edge is `targetLongEdge`, never upscale. */
export function resizeFor(size: Size, targetLongEdge = DEFAULTS.targetLongEdge): Size | null {
  const longEdge = Math.max(size.width, size.height);
  if (!Number.isFinite(longEdge) || longEdge <= 0) return null;
  if (longEdge <= targetLongEdge) return null;
  const scale = targetLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/**
 * Choose a JPEG quality that fits the byte budget.
 *
 * Compression is roughly linear in quality for photographic content, so one estimate plus a
 * bounded refinement loop is enough; the floor stops the loop from returning an unreadable image
 * just to hit a byte target.
 */
export function chooseJpegQuality(
  estimatedBytes: number,
  options: ProcessingOptions = {},
): { quality: number; fits: boolean } {
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const minQuality = options.minQuality ?? DEFAULTS.minQuality;

  if (!Number.isFinite(estimatedBytes) || estimatedBytes <= 0) {
    return { quality: 0.85, fits: true };
  }
  if (estimatedBytes <= maxBytes) return { quality: 0.85, fits: true };

  let quality = 0.85;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const projected = estimatedBytes * (quality / 0.85);
    if (projected <= maxBytes) return { quality: round2(quality), fits: true };
    const next = quality - 0.1;
    if (next < minQuality) break;
    quality = next;
  }

  return { quality: round2(minQuality), fits: estimatedBytes * (minQuality / 0.85) <= maxBytes };
}

/** Everything decided before a single pixel moves. */
/**
 * EXIF orientation → the rotation needed to make the pixels upright.
 *
 * Cameras store the sensor image as-is and rely on the tag; most image toolkits honour it, but the
 * ones that do not produce a sideways page that OCR reads badly. 5–8 are the mirrored variants and
 * need a quarter turn as well.
 */
export function orientationFix(orientation: number): 0 | 90 | 180 | 270 {
  switch (orientation) {
    case 3:
    case 4:
      return 180;
    case 5:
    case 6:
      return 90;
    case 7:
    case 8:
      return 270;
    default:
      return 0;
  }
}

export function planProcessing(input: {
  frame: Size;
  quad?: Quad | null;
  estimatedBytes?: number;
  washedOut?: boolean;
  /** EXIF orientation of the captured photo; 1 means already upright. */
  orientation?: number;
  options?: ProcessingOptions;
}): ProcessingPlan {
  const options = input.options ?? {};
  const crop = cropRectForQuad(input.quad ?? null, input.frame, options.padding);
  const croppedSize = crop ? { width: crop.width, height: crop.height } : input.frame;
  const resize = resizeFor(croppedSize, options.targetLongEdge);
  const { quality, fits } = chooseJpegQuality(input.estimatedBytes ?? 0, options);
  const rotate = orientationFix(input.orientation ?? 1);

  const steps: string[] = [];
  if (rotate !== 0) steps.push(`rotate ${rotate}°`);
  if (crop)
    steps.push(`crop ${crop.width}×${crop.height} from ${input.frame.width}×${input.frame.height}`);
  if (resize) steps.push(`resize to ${resize.width}×${resize.height}`);
  if (quality < 0.85) steps.push(`compress to quality ${quality}`);
  if (input.washedOut) steps.push('boost contrast');
  if (!fits) steps.push('still above the byte budget after compression');

  return {
    crop,
    rotate,
    resize,
    quality,
    enhance: Boolean(input.washedOut),
    steps,
  };
}

/** The port the app implements with the platform image toolkit. */
export interface ImageTransformer {
  /** Optional: a toolkit without rotation leaves the EXIF tag for the server to honour. */
  rotate?(uri: string, degrees: 0 | 90 | 180 | 270): Promise<string>;
  crop(uri: string, rect: CropRect): Promise<string>;
  resize(uri: string, size: Size): Promise<string>;
  enhance(uri: string): Promise<string>;
  compress(uri: string, quality: number): Promise<string>;
}

export interface ProcessedCapture {
  uri: string;
  plan: ProcessingPlan;
  bytes?: number;
}

/**
 * Applies the plan, in the order that wastes the least work: crop first (fewer pixels to move
 * afterwards), then enhance, then resize, then compress.
 *
 * Every step is best-effort: if the platform toolkit fails to crop, the uncropped capture is still
 * uploaded. Losing the document would be worse than uploading it unframed.
 */
export async function processCapture(
  transformer: ImageTransformer,
  uri: string,
  input: Parameters<typeof planProcessing>[0],
): Promise<ProcessedCapture> {
  const plan = planProcessing(input);
  let current = uri;

  if (plan.rotate !== 0 && transformer.rotate) {
    try {
      current = await transformer.rotate(current, plan.rotate);
    } catch {
      plan.steps.push('rotate unavailable, leaving the EXIF orientation in place');
    }
  }
  if (plan.crop) {
    try {
      current = await transformer.crop(current, plan.crop);
    } catch {
      plan.steps.push('crop unavailable, uploading the full frame');
    }
  }
  if (plan.enhance) {
    try {
      current = await transformer.enhance(current);
    } catch {
      plan.steps.push('enhance unavailable');
    }
  }
  if (plan.resize) {
    try {
      current = await transformer.resize(current, plan.resize);
    } catch {
      plan.steps.push('resize unavailable');
    }
  }
  if (plan.quality < 0.85) {
    try {
      current = await transformer.compress(current, plan.quality);
    } catch {
      plan.steps.push('compress unavailable, uploading at the camera quality');
    }
  }

  return { uri: current, plan };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
