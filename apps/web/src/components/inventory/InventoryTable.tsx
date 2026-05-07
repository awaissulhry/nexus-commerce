"use client";

import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type RowSelectionState,
  type VisibilityState,
} from "@tanstack/react-table";
import { useState, useMemo, useCallback } from "react";
import type { InventoryItem } from "@/types/inventory";
import { inventoryColumns } from "./columns";
import BulkActionBar from "./BulkActionBar";
import ColumnVisibilityToggle from "@/components/shared/ColumnVisibilityToggle";

interface InventoryTableProps {
  data: InventoryItem[];
  onEditItem?: (item: InventoryItem) => void;
}

export default function InventoryTable({ data, onEditItem }: InventoryTableProps) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  // Lazy-loading state
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [childrenCache, setChildrenCache] = useState<Map<string, InventoryItem[]>>(new Map());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());

  const handleExpandRow = useCallback(async (productId: string) => {
    // Collapse if already expanded
    if (expandedIds.has(productId)) {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        next.delete(productId);
        return next;
      });
      return;
    }

    // Expand from cache if already fetched
    if (childrenCache.has(productId)) {
      setExpandedIds((prev) => new Set(prev).add(productId));
      return;
    }

    // Fetch children
    setLoadingIds((prev) => new Set(prev).add(productId));
    try {
      const res = await fetch(`/api/inventory/${productId}/children`);
      const json = await res.json();
      setChildrenCache((prev) => new Map(prev).set(productId, json.children ?? []));
      setExpandedIds((prev) => new Set(prev).add(productId));
    } catch (err) {
      console.error("[InventoryTable] Failed to fetch children:", err);
    } finally {
      setLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(productId);
        return next;
      });
    }
  }, [expandedIds, childrenCache]);

  // Build the flat visible row list: top-level products + inline children when expanded
  const visibleData = useMemo(() => {
    const rows: InventoryItem[] = [];
    for (const item of data) {
      rows.push(item);
      if (expandedIds.has(item.id)) {
        const children = childrenCache.get(item.id) ?? [];
        rows.push(...children);
      }
    }
    return rows;
  }, [data, expandedIds, childrenCache]);

  const table = useReactTable({
    data: visibleData,
    columns: inventoryColumns,
    state: { rowSelection, columnVisibility },
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    enableRowSelection: true,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
    meta: { onEditItem, onExpandRow: handleExpandRow, loadingIds, expandedIds },
  });

  return (
    <div className="space-y-3">
      {/* ── Toolbar ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-500 font-medium tracking-tight">
          {data.length} products
          {expandedIds.size > 0 && (
            <span className="text-slate-400 ml-1">
              · {[...expandedIds].reduce((n, id) => n + (childrenCache.get(id)?.length ?? 0), 0)} variants shown
            </span>
          )}
        </div>
        <ColumnVisibilityToggle table={table} />
      </div>

      {/* ── Bulk Action Bar ──────────────────────────────────────────── */}
      <BulkActionBar table={table} />

      {/* ── Table ────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-md border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" style={{ fontSize: "13px" }}>
            {/* Header */}
            <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-20">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className="px-3 py-2 text-left text-sm font-semibold text-slate-900 uppercase tracking-tight border-r border-slate-200 last:border-r-0"
                      style={{ width: header.getSize() }}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>

            {/* Body */}
            <tbody>
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={table.getVisibleLeafColumns().length}
                    className="px-3 py-12 text-center text-slate-500"
                  >
                    <div className="flex flex-col items-center gap-2">
                      <svg className="w-10 h-10 text-slate-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                      </svg>
                      <p className="text-sm font-medium text-slate-900">No inventory items</p>
                      <p className="text-xs text-slate-500">Sync your Amazon catalog or upload inventory to get started.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row, rowIdx, allRows) => {
                  const item = row.original;
                  const isChild = !!item.parentId;
                  const isSelected = row.getIsSelected();

                  const nextRow = allRows[rowIdx + 1];
                  const nextIsChild = nextRow ? !!nextRow.original.parentId : false;
                  const showSeparator = !isChild && !nextIsChild;

                  return (
                    <tr
                      key={row.id}
                      className={[
                        "transition-colors border-b group",
                        isChild
                          ? "bg-slate-50/80 hover:bg-slate-100 border-l-[3px] border-l-blue-500"
                          : "bg-white hover:bg-slate-50",
                        isSelected ? "bg-blue-50" : "",
                        showSeparator ? "border-b-slate-200" : "border-b-slate-100",
                      ].join(" ")}
                    >
                      {row.getVisibleCells().map((cell, cellIdx) => (
                        <td
                          key={cell.id}
                          className={[
                            "px-3 py-1.5 relative tracking-tight border-r border-slate-100 last:border-r-0",
                            isChild && cellIdx > 1 ? "pl-10" : "",
                          ].join(" ")}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
