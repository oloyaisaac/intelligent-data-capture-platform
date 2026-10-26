/**
 * MOB-002 — find the page in the camera frame.
 *
 * The detector works on a single luminance plane, which is exactly what VisionCamera hands a frame
 * processor for the YUV output (plane 0 is Y). It is deliberately pure and small: downscale, Sobel,
 * threshold, then take the four extreme points of the strongest edges. That finds the outline of a
 * page held against a desk without shipping a machine-learning model, and it is fast enough to run
 * on every frame.
 *
 * The output is a quad in *frame* coordinates. `scaleQuad` maps it to the captured photo before the
 * crop is applied, because a preview frame and a still photo rarely share a resolution.
 */
import type { Point, Quad, Size } from './imagePipeline';

export interface LumaFrame {
  /** One luminance byte per pixel, row-major. */
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  /** Optional padding between rows, as VisionCamera reports it. */
  bytesPerRow?: number;
}

export interface DetectionOptions {
  /** Longest edge of the working image. 200 px is enough to find a page outline. */
  workingSize?: number;
  /** Minimum share of the frame the page must cover to be believed. */
  minAreaRatio?: number;
  /** Absolute floor for an edge pixel; below this the frame is probably blank. */
  minGradient?: number;
}

const DEFAULTS: Required<DetectionOptions> = {
  workingSize: 200,
  minAreaRatio: 0.15,
  minGradient: 28,
};

export interface Detection {
  quad: Quad;
  /** 0–1: how page-like the outline is (area share, edge density, corner spread). */
  confidence: number;
  areaRatio: number;
  /** Mean brightness inside the detected page, 0–255. */
  meanLuma: number;
  /** Standard deviation inside the page: low means a flat, washed-out capture. */
  contrast: number;
}

/** Reads a luminance frame from a VisionCamera-style plane without copying the whole buffer. */
export function lumaFromPlane(plane: {
  width: number;
  height: number;
  bytesPerRow: number;
  data: Uint8Array;
}): LumaFrame {
  return {
    data: plane.data,
    width: plane.width,
    height: plane.height,
    bytesPerRow: plane.bytesPerRow,
  };
}

/**
 * Averages the frame down to a small working image.
 *
 * Averaging (not sampling) matters: a single sampled pixel can be a specular highlight, while the
 * mean of a block is closer to the paper's brightness.
 */
export function downsample(frame: LumaFrame, workingSize = DEFAULTS.workingSize): LumaFrame {
  const longest = Math.max(frame.width, frame.height);
  if (longest <= workingSize) return frame;

  const scale = workingSize / longest;
  const width = Math.max(2, Math.round(frame.width * scale));
  const height = Math.max(2, Math.round(frame.height * scale));
  const rowStride = frame.bytesPerRow ?? frame.width;
  const out = new Uint8ClampedArray(width * height);

  const blockW = frame.width / width;
  const blockH = frame.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * blockH);
    const y1 = Math.min(frame.height, Math.max(y0 + 1, Math.floor((y + 1) * blockH)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * blockW);
      const x1 = Math.min(frame.width, Math.max(x0 + 1, Math.floor((x + 1) * blockW)));
      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        const rowOffset = sy * rowStride;
        for (let sx = x0; sx < x1; sx += 1) {
          sum += frame.data[rowOffset + sx] ?? 0;
          count += 1;
        }
      }
      out[y * width + x] = count === 0 ? 0 : sum / count;
    }
  }

  return { data: out, width, height };
}

/** Sobel gradient magnitude, one value per pixel. */
export function sobelMagnitude(frame: LumaFrame): Float32Array {
  const { width, height, data } = frame;
  const stride = frame.bytesPerRow ?? width;
  const magnitude = new Float32Array(width * height);

  const at = (x: number, y: number): number => {
    const cx = Math.min(width - 1, Math.max(0, x));
    const cy = Math.min(height - 1, Math.max(0, y));
    return data[cy * stride + cx] ?? 0;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const gx =
        -at(x - 1, y - 1) -
        2 * at(x - 1, y) -
        at(x - 1, y + 1) +
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1);
      const gy =
        -at(x - 1, y - 1) -
        2 * at(x, y - 1) -
        at(x + 1, y - 1) +
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1);
      magnitude[y * width + x] = Math.hypot(gx, gy) / 8;
    }
  }

  return magnitude;
}

/** Otsu's threshold over the gradient magnitudes, clamped by `minGradient`. */
export function otsuThreshold(values: Float32Array, bins = 64): number {
  if (values.length === 0) return 0;
  let max = 0;
  for (const value of values) max = Math.max(max, value);
  if (max <= 0) return 0;

  const histogram = new Array<number>(bins).fill(0);
  for (const value of values) {
    const index = Math.min(bins - 1, Math.floor((value / max) * (bins - 1)));
    histogram[index] = (histogram[index] ?? 0) + 1;
  }

  const total = values.length;
  let sum = 0;
  for (let i = 0; i < bins; i += 1) sum += i * (histogram[i] ?? 0);

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let bestVariance = -1;

  for (let i = 0; i < bins; i += 1) {
    weightBackground += histogram[i] ?? 0;
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += i * (histogram[i] ?? 0);
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (variance > bestVariance) {
      bestVariance = variance;
      best = i;
    }
  }

  return (best / (bins - 1)) * max;
}

/** Shoelace area, in pixels². */
export function quadArea(quad: Quad): number {
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i]!;
    const next = points[(i + 1) % points.length]!;
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * Orders four arbitrary points clockwise from the top-left, so the rest of the pipeline can rely on
 * the corner meaning rather than on the detector's ordering.
 */
export function orderQuad(points: Point[]): Quad | null {
  if (points.length !== 4) return null;
  const centre = points.reduce(
    (acc, point) => ({ x: acc.x + point.x / 4, y: acc.y + point.y / 4 }),
    { x: 0, y: 0 },
  );

  const sorted = [...points].sort(
    (a, b) =>
      Math.atan2(a.y - centre.y, a.x - centre.x) - Math.atan2(b.y - centre.y, b.x - centre.x),
  );

  // atan2 starts at "3 o'clock" and grows clockwise in screen coordinates; rotate so the first
  // point is the one furthest up-left.
  let bestIndex = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  sorted.forEach((point, index) => {
    const score = point.x + point.y;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  const rotated = [...sorted.slice(bestIndex), ...sorted.slice(0, bestIndex)];
  const [topLeft, topRight, bottomRight, bottomLeft] = rotated as [Point, Point, Point, Point];
  return { topLeft, topRight, bottomRight, bottomLeft };
}

/** Rejects outlines that are too small, too large, or degenerate. */
export function isPlausibleQuad(
  quad: Quad,
  frame: Size,
  minAreaRatio = DEFAULTS.minAreaRatio,
): boolean {
  const areaRatio = quadArea(quad) / Math.max(1, frame.width * frame.height);
  if (areaRatio < minAreaRatio || areaRatio > 1.05) return false;

  const sides: Array<[Point, Point]> = [
    [quad.topLeft, quad.topRight],
    [quad.topRight, quad.bottomRight],
    [quad.bottomRight, quad.bottomLeft],
    [quad.bottomLeft, quad.topLeft],
  ];
  const shortestAllowed = Math.min(frame.width, frame.height) * 0.12;
  return sides.every(([a, b]) => Math.hypot(a.x - b.x, a.y - b.y) >= shortestAllowed);
}

/**
 * The detector. Returns `null` when the frame has no convincing page in it (blank desk, a tap on the
 * lens, a frame of pure noise), so the UI can simply keep the last good outline.
 */
export function detectDocumentQuad(
  frame: LumaFrame,
  options: DetectionOptions = {},
): Detection | null {
  if (frame.width < 8 || frame.height < 8) return null;

  const working = downsample(frame, options.workingSize ?? DEFAULTS.workingSize);
  const magnitude = sobelMagnitude(working);
  const threshold = Math.max(options.minGradient ?? DEFAULTS.minGradient, otsuThreshold(magnitude));

  let strong = 0;
  let minSum = Number.POSITIVE_INFINITY;
  let maxSum = Number.NEGATIVE_INFINITY;
  let minDiff = Number.POSITIVE_INFINITY;
  let maxDiff = Number.NEGATIVE_INFINITY;
  let topLeft: Point = { x: 0, y: 0 };
  let bottomRight: Point = { x: 0, y: 0 };
  let topRight: Point = { x: 0, y: 0 };
  let bottomLeft: Point = { x: 0, y: 0 };

  for (let y = 0; y < working.height; y += 1) {
    for (let x = 0; x < working.width; x += 1) {
      if ((magnitude[y * working.width + x] ?? 0) < threshold) continue;
      strong += 1;
      const sum = x + y;
      const diff = x - y;
      if (sum < minSum) {
        minSum = sum;
        topLeft = { x, y };
      }
      if (sum > maxSum) {
        maxSum = sum;
        bottomRight = { x, y };
      }
      if (diff > maxDiff) {
        maxDiff = diff;
        topRight = { x, y };
      }
      if (diff < minDiff) {
        minDiff = diff;
        bottomLeft = { x, y };
      }
    }
  }

  // A page outline is a few hundred pixels long; a handful of strong points is noise.
  const minimumPoints = Math.max(12, working.width * working.height * 0.004);
  if (strong < minimumPoints) return null;

  const quad = orderQuad([topLeft, topRight, bottomRight, bottomLeft]);
  if (!quad) return null;
  if (!isPlausibleQuad(quad, working, options.minAreaRatio ?? DEFAULTS.minAreaRatio)) return null;

  const areaRatio = quadArea(quad) / (working.width * working.height);
  // An outline that hugs the frame is not a found page: either the page fills the view (a crop
  // would do nothing) or the "edges" are noise. Treat it as no detection.
  if (areaRatio > 0.92) return null;
  const density = Math.min(1, strong / (working.width * working.height) / 0.25);
  const confidence = Math.max(0, Math.min(1, 0.45 + Math.min(areaRatio, 1) * 0.35 + density * 0.2));

  const scaleX = frame.width / working.width;
  const scaleY = frame.height / working.height;
  const scale = (point: Point): Point => ({
    x: Math.round(point.x * scaleX),
    y: Math.round(point.y * scaleY),
  });

  const { meanLuma, contrast } = interiorStats(working, quad);

  return {
    quad: {
      topLeft: scale(quad.topLeft),
      topRight: scale(quad.topRight),
      bottomRight: scale(quad.bottomRight),
      bottomLeft: scale(quad.bottomLeft),
    },
    confidence,
    areaRatio,
    meanLuma,
    contrast,
  };
}

function pointInQuad(point: Point, quad: Quad): boolean {
  const corners = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i, i += 1) {
    const a = corners[i]!;
    const b = corners[j]!;
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Brightness and spread *inside* the page.
 *
 * Measuring the whole frame would call a dark desk a "high-contrast" scene even when the paper
 * itself is flat grey, which is exactly the capture that needs an enhancement pass.
 */
function interiorStats(frame: LumaFrame, quad: Quad): { meanLuma: number; contrast: number } {
  const stride = frame.bytesPerRow ?? frame.width;
  let sum = 0;
  let count = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      if (!pointInQuad({ x, y }, quad)) continue;
      sum += frame.data[y * stride + x] ?? 0;
      count += 1;
    }
  }
  if (count === 0) return { meanLuma: 0, contrast: 0 };

  const meanLuma = sum / count;
  let variance = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      if (!pointInQuad({ x, y }, quad)) continue;
      variance += ((frame.data[y * stride + x] ?? 0) - meanLuma) ** 2;
    }
  }
  return { meanLuma, contrast: Math.sqrt(variance / count) };
}

/** Maps a quad from preview coordinates onto the captured photo. */
export function scaleQuad(quad: Quad, from: Size, to: Size): Quad {
  const sx = to.width / Math.max(1, from.width);
  const sy = to.height / Math.max(1, from.height);
  const point = (value: Point): Point => ({ x: value.x * sx, y: value.y * sy });
  return {
    topLeft: point(quad.topLeft),
    topRight: point(quad.topRight),
    bottomRight: point(quad.bottomRight),
    bottomLeft: point(quad.bottomLeft),
  };
}

/**
 * Smooths the outline across frames so the overlay does not jitter.
 *
 * A new detection is blended with the previous one; a detection that disagrees strongly (a jump of
 * more than a third of the frame) replaces it outright, because that is a different page.
 */
export function smoothQuad(previous: Quad | null, next: Quad, frame: Size, alpha = 0.35): Quad {
  if (!previous) return next;
  const corners: Array<keyof Quad> = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
  const jump = Math.max(
    ...corners.map((corner) =>
      Math.hypot(next[corner].x - previous[corner].x, next[corner].y - previous[corner].y),
    ),
  );
  if (jump > Math.max(frame.width, frame.height) / 3) return next;

  const blend = (a: Point, b: Point): Point => ({
    x: Math.round(a.x * (1 - alpha) + b.x * alpha),
    y: Math.round(a.y * (1 - alpha) + b.y * alpha),
  });

  return {
    topLeft: blend(previous.topLeft, next.topLeft),
    topRight: blend(previous.topRight, next.topRight),
    bottomRight: blend(previous.bottomRight, next.bottomRight),
    bottomLeft: blend(previous.bottomLeft, next.bottomLeft),
  };
}
