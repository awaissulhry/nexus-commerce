"use client";

import { useState, useRef, useEffect } from "react";
import { type Table } from "@tanstack/react-table";

interface ColumnVisibilityToggleProps<T> {
  table: Table<T>;
}

/**
 * Dropdown button that lets users toggle column visibility.
 * Excludes utility columns (expander, select, actions) from the list.
 */
export default function ColumnVisibilityToggle<T>({
  table,
}: ColumnVisibilityToggleProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const HIDDEN_IDS = new Set(["expander", "select", "actions"]);

  const toggleableColumns = table
    .getAllLeafColumns()
    .filter((col) => !HIDDEN_IDS.has(col.id));

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7"
          />
        </svg>
        Columns
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-2 z-50">
          <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Toggle Columns
          </div>
          <div className="border-t border-gray-100 mt-1 pt-1">
            {toggleableColumns.map((column) => (
              <label
                key={column.id}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer transition-colors"
              >
                <input
                  type="checkbox"
                  checked={column.getIsVisible()}
                  onChange={column.getToggleVisibilityHandler()}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">
                  {typeof column.columnDef.header === "string"
                    ? column.columnDef.header
                    : column.id}
                </span>
              </label>
            ))}
          </div>
          <div className="border-t border-gray-100 mt-1 pt-1 px-3 py-1.5">
            <button
              onClick={() => table.toggleAllColumnsVisible(true)}
              className="text-xs text-blue-600 hover:text-blue-800 font-medium"
            >
              Show All
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
