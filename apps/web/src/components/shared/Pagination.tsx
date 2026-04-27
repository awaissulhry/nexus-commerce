"use client";

import { type Table } from "@tanstack/react-table";

interface PaginationProps<T> {
  table: Table<T>;
  pageSizeOptions?: number[];
}

/**
 * Reusable pagination bar for TanStack Table.
 * Shows page size selector, page navigation, and row count.
 */
export default function Pagination<T>({
  table,
  pageSizeOptions = [25, 50, 100, 250],
}: PaginationProps<T>) {
  return (
    <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-t border-gray-200 text-sm">
      {/* Left: page size selector */}
      <div className="flex items-center gap-2">
        <span className="text-gray-600">Show</span>
        <select
          value={table.getState().pagination.pageSize}
          onChange={(e) => table.setPageSize(Number(e.target.value))}
          className="px-2 py-1 border border-gray-300 rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {pageSizeOptions.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        <span className="text-gray-600">per page</span>
      </div>

      {/* Center: page info */}
      <span className="text-gray-600">
        Page{" "}
        <span className="font-medium text-gray-900">
          {table.getState().pagination.pageIndex + 1}
        </span>{" "}
        of{" "}
        <span className="font-medium text-gray-900">
          {table.getPageCount()}
        </span>
        {" · "}
        <span className="font-medium text-gray-900">
          {table.getFilteredRowModel().rows.length}
        </span>{" "}
        total rows
      </span>

      {/* Right: navigation buttons */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => table.setPageIndex(0)}
          disabled={!table.getCanPreviousPage()}
          className="px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="First page"
        >
          ««
        </button>
        <button
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage()}
          className="px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="Previous page"
        >
          «
        </button>
        <button
          onClick={() => table.nextPage()}
          disabled={!table.getCanNextPage()}
          className="px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="Next page"
        >
          »
        </button>
        <button
          onClick={() => table.setPageIndex(table.getPageCount() - 1)}
          disabled={!table.getCanNextPage()}
          className="px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="Last page"
        >
          »»
        </button>
      </div>
    </div>
  );
}
