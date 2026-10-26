import type { StatsTimelinePoint } from '@idcp/shared';

/**
 * DASH-001 — chart geometry.
 *
 * Kept as pure functions with no charting dependency: the numbers are computed and asserted in
 * tests, and the SVG only draws what these return. A chart library would add a dependency for the
 * sake of a bar chart, and would still need this rounding logic to be correct.
 */

export interface Bar {
  /** ISO date for the bucket. */
  date: string;
  label: string;
  value: number;
  /** Pixels, already y-flipped for SVG (origin is top-left). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BarChart {
  bars: Bar[];
  width: number;
  height: number;
  max: number;
  /** Y position of the baseline, so callers can draw the axis without recomputing. */
  baseline: number;
  /** Value at a quarter, half and three quarters of the plot height: labelled gridlines. */
  gridlines: Array<{ y: number; value: number }>;
}

export interface BarChartOptions {
  width?: number;
  height?: number;
  /** Space between bars, in pixels. */
  gap?: number;
  /** Label formatter for the x axis; defaults to the day of the month. */
  formatLabel?: (date: string) => string;
}

/**
 * Builds a vertical bar chart for one metric.
 *
 * An all-zero series produces zero-height bars rather than dividing by zero: an empty week should
 * look empty, not broken.
 */
export function buildBarChart(
  points: StatsTimelinePoint[],
  metric: 'uploaded' | 'approved' | 'failed' = 'uploaded',
  options: BarChartOptions = {},
): BarChart {
  const width = options.width ?? 640;
  const height = options.height ?? 160;
  const gap = options.gap ?? 4;
  const formatLabel = options.formatLabel ?? defaultLabel;

  const values = points.map((point) => Math.max(0, point[metric]));
  const max = Math.max(1, ...values);
  const slot = points.length > 0 ? width / points.length : width;
  const barWidth = Math.max(1, slot - gap);

  const bars = points.map((point, index) => {
    const value = Math.max(0, point[metric]);
    const barHeight = (value / max) * height;
    return {
      date: point.date,
      label: formatLabel(point.date),
      value,
      x: round(index * slot + gap / 2),
      y: round(height - barHeight),
      width: round(barWidth),
      height: round(barHeight),
    };
  });

  const gridlines = [0.25, 0.5, 0.75].map((fraction) => ({
    y: round(height - fraction * height),
    value: Math.round(max * fraction),
  }));

  return { bars, width, height, max, baseline: height, gridlines };
}

/** Percentages that sum to 100 (largest remainder), so a stacked bar never over- or under-fills. */
export function shares(
  counts: Record<string, number>,
): Array<{ key: string; value: number; percent: number }> {
  const entries = Object.entries(counts)
    .map(([key, value]) => ({ key, value: Math.max(0, Number(value) || 0) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value);

  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  if (total === 0) return [];

  const exact = entries.map((entry) => ({ ...entry, exact: (entry.value / total) * 100 }));
  const floored = exact.map((entry) => ({ ...entry, percent: Math.floor(entry.exact) }));
  let remainder = 100 - floored.reduce((sum, entry) => sum + entry.percent, 0);
  // Hand the leftover points to the largest fractional parts first.
  const order = [...floored].sort((a, b) => (b.exact % 1) - (a.exact % 1));
  for (const entry of order) {
    if (remainder <= 0) break;
    entry.percent += 1;
    remainder -= 1;
  }

  return floored.map(({ key, value, percent }) => ({ key, value, percent }));
}

/** One concise sentence for a screen reader, because a chart alone is not accessible. */
export function describeChart(chart: BarChart, metric: string): string {
  const total = chart.bars.reduce((sum, bar) => sum + bar.value, 0);
  if (chart.bars.length === 0) return `No ${metric} data yet.`;
  const busiest = [...chart.bars].sort((a, b) => b.value - a.value)[0];
  return `${total} ${metric} over the last ${chart.bars.length} days; the highest day is ${busiest?.label} with ${busiest?.value}.`;
}

function defaultLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return String(parsed.getUTCDate());
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
