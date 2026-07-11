/**
 * FS3 — VirtualDataGrid: the DS DataGrid's exact prop surface + markup/classes
 * (`.h10-ds-grid-wrap` / `.h10-ds-grid` — visual parity by construction) with
 * WINDOWED rows via @tanstack/react-virtual, so a 10k-row feed keeps a bounded
 * DOM. `height` is required and acts as the scroll bound (maxHeight semantics:
 * short data collapses to content exactly like the DS grid). Sort is memoized;
 * sticky header/columns/totals and selection behave identically. The DS tree
 * is read-only (PROVENANCE rule 2) — this is a factory-local sibling, not a fork.
 */
"use client";

import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronsUpDown, ChevronUp, ChevronDown } from "lucide-react";
import { useVirtualizer, type Range } from "@tanstack/react-virtual";
import { extractRange, spacerHeights } from "@/lib/virtual/window-math";

export interface VirtualColumn<T> {
  key: string;
  label: ReactNode;
  render: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  sortable?: boolean;
  sortValue?: (row: T) => number | string;
  /** pin this column to the left (sticky); give a numeric `width` so offsets stack */
  sticky?: boolean;
  /** pin this column to the right (sticky); give a numeric `width` so offsets stack */
  stickyRight?: boolean;
  width?: number;
  /** value rendered in the totals row */
  total?: ReactNode;
}

export interface VirtualDataGridProps<T> {
  columns: Array<VirtualColumn<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  selectable?: boolean;
  selected?: Set<string>;
  onSelectedChange?: (next: Set<string>) => void;
  showTotals?: boolean;
  emptyState?: ReactNode;
  initialSort?: { key: string; dir: "asc" | "desc" };
  /** cap height + scroll (kept for DS-prop parity; wins over `height` when set) */
  maxHeight?: number | string;
  className?: string;
  /** REQUIRED scroll bound — number (px) or any CSS length (e.g. "calc(100dvh - 300px)") */
  height: number | string;
  /** estimated row height in px before measurement (DS rows ≈ 40) */
  estimateRowHeight?: number;
  /** extra rows rendered above/below the window (default 12) */
  overscan?: number;
}

const ESTIMATE = 40; // 11px padding ×2 + one 13px line ≈ the DS grid row

export function VirtualDataGrid<T>({
  columns,
  rows,
  rowKey,
  selectable,
  selected,
  onSelectedChange,
  showTotals,
  emptyState,
  initialSort,
  maxHeight,
  className,
  height,
  estimateRowHeight = ESTIMATE,
  overscan = 12,
}: VirtualDataGridProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(initialSort ?? null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const sv = col.sortValue;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = sv(a);
      const bv = sv(b);
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }, [rows, sort, columns]);

  const virtualizer = useVirtualizer({
    count: sortedRows.length,
    getScrollElement: () => wrapRef.current,
    estimateSize: () => estimateRowHeight,
    overscan: 0, // overscan is applied by our tested rangeExtractor below
    rangeExtractor: (range: Range) => extractRange({ ...range, overscan, count: sortedRows.length }),
    measureElement: (el) => (el as HTMLElement).getBoundingClientRect().height,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const { top: padTop, bottom: padBottom } = spacerHeights(virtualItems, virtualizer.getTotalSize());

  const toggleSort = (key: string) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));

  const allKeys = rows.map(rowKey);
  const selCount = selected?.size ?? 0;
  const allSelected = !!selectable && selCount > 0 && allKeys.every((k) => selected!.has(k));
  const someSelected = !!selectable && selCount > 0 && !allSelected;

  const toggleAll = () => onSelectedChange?.(allSelected ? new Set() : new Set(allKeys));
  const toggleRow = (k: string) => {
    if (!selected) return onSelectedChange?.(new Set([k]));
    const next = new Set(selected);
    next.has(k) ? next.delete(k) : next.add(k);
    onSelectedChange?.(next);
  };

  // accumulate sticky-left offsets (checkbox is 40px wide and pinned at 0)
  const CK = 40;
  let acc = selectable ? CK : 0;
  const leftOf: Record<string, number> = {};
  for (const c of columns) {
    if (c.sticky) {
      leftOf[c.key] = acc;
      acc += c.width ?? 0;
    }
  }
  // accumulate sticky-right offsets (right-pinned columns stack from the edge in)
  let accR = 0;
  const rightOf: Record<string, number> = {};
  for (let i = columns.length - 1; i >= 0; i--) {
    const c = columns[i];
    if (c.stickyRight) {
      rightOf[c.key] = accR;
      accR += c.width ?? 0;
    }
  }
  const stickyStyle = (c: VirtualColumn<T>): CSSProperties | undefined =>
    c.sticky ? { left: leftOf[c.key], width: c.width }
    : c.stickyRight ? { right: rightOf[c.key], width: c.width }
    : c.width != null ? { width: c.width }
    : undefined;
  const stickyCls = (c: VirtualColumn<T>) => (c.sticky ? "sticky" : c.stickyRight ? "sticky-right" : "");

  const alignClass = (a?: "left" | "right" | "center") => (a === "right" ? "r" : a === "center" ? "c" : "");
  const sortIcon = (key: string) =>
    sort?.key === key ? sort.dir === "asc" ? <ChevronUp size={13} /> : <ChevronDown size={13} /> : <ChevronsUpDown size={13} />;

  const colSpan = columns.length + (selectable ? 1 : 0);
  const spacerTd: CSSProperties = { padding: 0, border: "none", background: "transparent" };

  return (
    <div
      ref={wrapRef}
      className={`h10-ds-grid-wrap${className ? ` ${className}` : ""}`}
      style={{ maxHeight: maxHeight ?? height }}
    >
      <table className="h10-ds-grid">
        <thead>
          <tr>
            {selectable && (
              <th className="ck sticky" style={{ left: 0 }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleAll}
                  aria-label="Select all rows"
                />
              </th>
            )}
            {columns.map((c) => {
              const sorted = sort?.key === c.key;
              const cls = [alignClass(c.align), stickyCls(c), sorted ? "sorted" : ""].filter(Boolean).join(" ");
              return (
                <th key={c.key} className={cls} style={stickyStyle(c)}>
                  {c.sortable ? (
                    <button type="button" className="sortbtn" onClick={() => toggleSort(c.key)}>
                      {c.label}
                      {sortIcon(c.key)}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 ? (
            <tr>
              <td className="h10-ds-grid-empty" colSpan={colSpan}>
                {emptyState ?? "No rows."}
              </td>
            </tr>
          ) : (
            <>
              {padTop > 0 && (
                <tr aria-hidden style={{ height: padTop }}>
                  <td colSpan={colSpan} style={spacerTd} />
                </tr>
              )}
              {virtualItems.map((vi) => {
                const row = sortedRows[vi.index];
                const k = rowKey(row);
                const isSel = !!selected?.has(k);
                return (
                  <tr key={k} data-index={vi.index} ref={virtualizer.measureElement} className={isSel ? "sel" : undefined}>
                    {selectable && (
                      <td className="ck sticky" style={{ left: 0 }}>
                        <input type="checkbox" checked={isSel} onChange={() => toggleRow(k)} aria-label="Select row" />
                      </td>
                    )}
                    {columns.map((c) => (
                      <td key={c.key} className={[alignClass(c.align), stickyCls(c)].filter(Boolean).join(" ")} style={stickyStyle(c)}>
                        {c.render(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
              {padBottom > 0 && (
                <tr aria-hidden style={{ height: padBottom }}>
                  <td colSpan={colSpan} style={spacerTd} />
                </tr>
              )}
            </>
          )}
        </tbody>
        {showTotals && sortedRows.length > 0 && (
          <tfoot>
            <tr className="totals">
              {selectable && <td className="ck sticky" style={{ left: 0 }} />}
              {columns.map((c) => (
                <td key={c.key} className={[alignClass(c.align), stickyCls(c)].filter(Boolean).join(" ")} style={stickyStyle(c)}>
                  {c.total}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
