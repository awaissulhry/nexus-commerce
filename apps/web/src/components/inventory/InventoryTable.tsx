"use client";

import {
  useReactTable,
  getCoreRowModel,
  getExpandedRowModel,
  flexRender,
  type ExpandedState,
  type RowSelectionState,
  type VisibilityState,
} from "@tanstack/react-table";
import { useState } from "react";
import type { InventoryItem } from "@/types/inventory";
import { inventoryColumns } from "./columns";
import BulkActionBar from "./BulkActionBar";
import ColumnVisibilityToggle from "@/components/shared/ColumnVisibilityToggle";

interface InventoryTableProps {
  data: InventoryItem[];
  onEditItem?: (item: InventoryItem) => void;
}

export default function InventoryTable({ data, onEditItem }: InventoryTableProps) {
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  const table = useReactTable({
    data,
    columns: inventoryColumns,
    state: { expanded, rowSelection, columnVisibility },
    onExpandedChange: setExpanded,
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    enableRowSelection: true,
    getSubRows: (row) => row.subRows,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowId: (row) => row.id,
    meta: { onEditItem },
    enableExpanding: true,
    enableSubRowSelection: true,
  });

  return (
    <div className="space-y-3">
      {/* ── Toolbar ────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-slate-500 font-medium tracking-tight">
          {table.getRowModel().rows.length} total rows
        </div>
        <ColumnVisibilityToggle table={table} />
      </div>

      {/* ── Bulk Action Bar ────────────────────────────────────────── */}
      <BulkActionBar table={table} />

      {/* ── Table ──────────────────────────────────────────────────── */}
      <div className="bg-white rounded-md border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" style={{ fontSize: "13px" }}>
            {/* ── Header ─────────────────────────────────────────── */}
            <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-20">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className="px-3 py-2 text-left text-[11px] font-semibold text-slate-900 uppercase tracking-tight border-r border-slate-200 last:border-r-0"
                      style={{
                        width: header.getSize(),
                      }}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>

            {/* ── Body ───────────────────────────────────────────── */}
            <tbody>
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={table.getVisibleLeafColumns().length}
                    className="px-3 py-12 text-center text-slate-500"
                  >
                    <div className="flex flex-col items-center gap-2">
                      <svg
                        className="w-10 h-10 text-slate-200"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                        />
                      </svg>
                      <p className="text-sm font-medium text-slate-900">
                        No inventory items
                      </p>
                      <p className="text-xs text-slate-500">
                        Sync your Amazon catalog or upload inventory to get
                        started.
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row, rowIdx, allRows) => {
                  const isChild = row.depth > 0;
                  const isParent = row.original.isParent;
                  const isSelected = row.getIsSelected();

                  // Next row is a child of this parent → no border between them
                  const nextRow = allRows[rowIdx + 1];
                  const nextIsChild = nextRow ? nextRow.depth > 0 : false;
                  const showBottomBorder =
                    !(isParent && nextIsChild) && !(isChild && nextIsChild);

                  return (
                    <tr
                      key={row.id}
                      className={`
                        transition-colors border-b group
                        ${
                          isChild
                            ? "bg-slate-50/80 hover:bg-slate-100 border-l-[3px] border-l-blue-500"
                            : "bg-white hover:bg-slate-50"
                        }
                        ${isSelected ? "bg-blue-50" : ""}
                        ${showBottomBorder ? "border-b-slate-200" : "border-b-slate-100"}
                      `}
                    >
                      {row.getVisibleCells().map((cell, cellIdx) => (
                        <td
                          key={cell.id}
                          className={`
                            px-3 py-1.5 relative tracking-tight border-r border-slate-100 last:border-r-0
                            ${isChild && cellIdx > 1 ? "pl-10" : ""}
                          `}
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext()
                          )}
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
