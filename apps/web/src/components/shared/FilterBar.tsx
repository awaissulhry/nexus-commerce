"use client";

import { useState, useCallback } from "react";

export interface FilterOption {
  label: string;
  value: string;
  count?: number;
}

export interface FilterBarProps {
  /** Tab-style filter options (e.g., All / Active / Inactive) */
  tabs?: FilterOption[];
  /** Currently selected tab value */
  activeTab?: string;
  /** Callback when a tab is selected */
  onTabChange?: (value: string) => void;
  /** Whether to show the search input */
  showSearch?: boolean;
  /** Search placeholder text */
  searchPlaceholder?: string;
  /** Callback when search value changes (debounced) */
  onSearch?: (query: string) => void;
  /** Additional action buttons rendered on the right */
  actions?: React.ReactNode;
}

export default function FilterBar({
  tabs,
  activeTab,
  onTabChange,
  showSearch = true,
  searchPlaceholder = "Search by SKU, ASIN, or product name...",
  onSearch,
  actions,
}: FilterBarProps) {
  const [searchValue, setSearchValue] = useState("");

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setSearchValue(value);
      onSearch?.(value);
    },
    [onSearch]
  );

  return (
    <div className="bg-white rounded-lg shadow border border-gray-200 p-4 space-y-3">
      {/* ── Tabs ──────────────────────────────────────────────── */}
      {tabs && tabs.length > 0 && (
        <div className="flex items-center gap-1 border-b border-gray-200 -mx-4 px-4 pb-3">
          {tabs.map((tab) => {
            const isActive = tab.value === activeTab;
            return (
              <button
                key={tab.value}
                onClick={() => onTabChange?.(tab.value)}
                className={`
                  px-3 py-1.5 text-sm font-medium rounded-md transition-colors
                  ${
                    isActive
                      ? "bg-blue-50 text-blue-700"
                      : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                  }
                `}
              >
                {tab.label}
                {tab.count !== undefined && (
                  <span
                    className={`ml-1.5 text-xs ${
                      isActive ? "text-blue-500" : "text-gray-400"
                    }`}
                  >
                    ({tab.count})
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Search + Actions row ──────────────────────────────── */}
      <div className="flex items-center gap-3">
        {showSearch && (
          <div className="relative flex-1">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              type="text"
              value={searchValue}
              onChange={handleSearchChange}
              placeholder={searchPlaceholder}
              className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
            />
            {searchValue && (
              <button
                onClick={() => {
                  setSearchValue("");
                  onSearch?.("");
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        )}
        {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
