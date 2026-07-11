/**
 * FS3 — WindowedList: the generic vertical virtualizer for NON-tabular lists
 * (conversation lists, kanban lane cards, notification feeds — the FS1
 * Load-more accumulators). Items render absolutely positioned inside a
 * relative rail sized to the virtualizer's total, so 50 Load-mores keep the
 * DOM bounded. Measured rows (ResizeObserver) — estimateSize is only the
 * first-paint guess. Styling is the caller's: this component owns geometry only.
 */
"use client";

import { useRef, type CSSProperties, type ReactNode } from "react";
import { useVirtualizer, type Range } from "@tanstack/react-virtual";
import { extractRange } from "@/lib/virtual/window-math";

export interface WindowedListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  /** stable key per item (falls back to the index) */
  itemKey?: (item: T, index: number) => string;
  /** estimated row height in px, or a per-index estimator (default 44) */
  estimateSize?: number | ((index: number) => number);
  /** extra rows rendered above/below the window (default 8) */
  overscan?: number;
  /** REQUIRED scroll bound — number (px) or any CSS length; the list scrolls inside it */
  height: number | string;
  className?: string;
  style?: CSSProperties;
  emptyState?: ReactNode;
  /** fires when the LAST item enters the window — wire Load-more here */
  onEndReached?: () => void;
}

export function WindowedList<T>({
  items,
  renderItem,
  itemKey,
  estimateSize = 44,
  overscan = 8,
  height,
  className,
  style,
  emptyState,
  onEndReached,
}: WindowedListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endFiredAt = useRef(-1);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: typeof estimateSize === "number" ? () => estimateSize : estimateSize,
    overscan: 0, // overscan is applied by our tested rangeExtractor below
    rangeExtractor: (range: Range) => extractRange({ ...range, overscan, count: items.length }),
    measureElement: (el) => (el as HTMLElement).getBoundingClientRect().height,
  });
  const virtualItems = virtualizer.getVirtualItems();

  // end-reached: the final index entered the rendered window (fire once per length)
  if (onEndReached && items.length > 0 && virtualItems.some((vi) => vi.index === items.length - 1) && endFiredAt.current !== items.length) {
    endFiredAt.current = items.length;
    onEndReached();
  }

  return (
    <div ref={scrollRef} className={className} style={{ overflowY: "auto", maxHeight: height, ...style }}>
      {items.length === 0 ? (
        emptyState ?? null
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
          {virtualItems.map((vi) => {
            const item = items[vi.index];
            return (
              <div
                key={itemKey ? itemKey(item, vi.index) : vi.index}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}
              >
                {renderItem(item, vi.index)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
