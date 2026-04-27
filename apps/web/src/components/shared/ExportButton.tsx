"use client";

import { useState } from "react";

interface ExportButtonProps {
  /** Data to export — array of objects */
  data: Record<string, unknown>[];
  /** Filename without extension */
  filename?: string;
  /** Column headers mapping: { key: "Display Label" } */
  columns?: Record<string, string>;
  /** Button label */
  label?: string;
}

export default function ExportButton({
  data,
  filename = "export",
  columns,
  label = "Export CSV",
}: ExportButtonProps) {
  const [exporting, setExporting] = useState(false);

  const handleExport = () => {
    if (data.length === 0) return;
    setExporting(true);

    try {
      // Determine column keys and headers
      const keys = columns ? Object.keys(columns) : Object.keys(data[0]);
      const headers = columns
        ? keys.map((k) => columns[k])
        : keys;

      // Build CSV content
      const escapeCSV = (val: unknown): string => {
        const str = val === null || val === undefined ? "" : String(val);
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const rows = [
        headers.map(escapeCSV).join(","),
        ...data.map((row) =>
          keys.map((key) => escapeCSV(row[key])).join(",")
        ),
      ];

      const csvContent = rows.join("\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);

      const link = document.createElement("a");
      link.href = url;
      link.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();

      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <button
      onClick={handleExport}
      disabled={exporting || data.length === 0}
      className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>
      {exporting ? "Exporting..." : label}
    </button>
  );
}
