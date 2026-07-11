/**
 * FS3 — pure windowing math shared by VirtualDataGrid and WindowedList.
 * `extractRange` is passed to @tanstack/react-virtual as the rangeExtractor
 * (overscan + clamping live HERE so they are unit-testable in node);
 * `spacerHeights` turns the virtualizer's visible window into the top/bottom
 * filler heights that keep the scrollbar honest.
 */

export interface WindowRange {
  startIndex: number;
  endIndex: number;
  overscan: number;
  count: number;
}

/**
 * The contiguous list of indexes to render for a visible [start..end] window:
 * the window widened by `overscan` on each side, clamped to [0, count-1].
 * Empty list ⇒ empty range.
 */
export function extractRange({ startIndex, endIndex, overscan, count }: WindowRange): number[] {
  if (count <= 0) return [];
  const first = Math.max(0, Math.min(startIndex, count - 1) - Math.max(0, overscan));
  const last = Math.min(count - 1, Math.max(endIndex, startIndex) + Math.max(0, overscan));
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}

export interface MeasuredItem {
  start: number;
  end: number;
}

/**
 * Filler heights above/below the rendered window so total scroll height stays
 * `totalSize` while only the windowed rows exist in the DOM. No window ⇒ 0/0.
 */
export function spacerHeights(items: MeasuredItem[], totalSize: number): { top: number; bottom: number } {
  if (items.length === 0) return { top: 0, bottom: 0 };
  const top = Math.max(0, items[0].start);
  const bottom = Math.max(0, totalSize - items[items.length - 1].end);
  return { top, bottom };
}
