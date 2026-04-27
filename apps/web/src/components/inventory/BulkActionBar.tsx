"use client";

import { useState } from "react";
import type { Table } from "@tanstack/react-table";
import type { InventoryItem } from "@/types/inventory";
import { bulkUpdateItems } from "@/app/inventory/manage/actions";

interface BulkActionBarProps {
  table: Table<InventoryItem>;
}

interface Toast {
  id: string;
  type: "success" | "error" | "info";
  message: string;
}

export default function BulkActionBar({ table }: BulkActionBarProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const selectedRows = table.getFilteredSelectedRowModel().rows;
  const count = selectedRows.length;

  if (count === 0) return null;

  // Collect product IDs from selected rows (all rows, not just parents)
  const selectedIds = selectedRows.map((row) => row.original.id);
  const selectedSkus = selectedRows.map((row) => row.original.sku);

  // Toast helper
  const showToast = (type: "success" | "error" | "info", message: string) => {
    const id = Date.now().toString();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  };

  const handlePause = async () => {
    if (selectedSkus.length === 0) return;
    setLoading(true);
    setDropdownOpen(false);

    try {
      const result = await bulkUpdateItems(selectedSkus, "pause");
      if (result.success) {
        showToast("success", `✓ Successfully paused ${result.affected} listing${result.affected !== 1 ? "s" : ""}`);
        table.resetRowSelection();
      } else {
        showToast("error", `✗ Failed to pause listings: ${result.error || "Unknown error"}`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error occurred";
      showToast("error", `✗ Pause failed: ${errorMsg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (selectedIds.length === 0) return;
    setLoading(true);
    setConfirmDelete(false);
    setDropdownOpen(false);

    try {
      let successCount = 0;
      let failedCount = 0;
      const errors: string[] = [];

      // Delete each product via Fastify API
      for (const productId of selectedIds) {
        try {
          const response = await fetch(`/api/catalog/products/${productId}`, {
            method: "DELETE",
          });

          if (!response.ok) {
            const errorData = await response.json();
            failedCount++;
            errors.push(`${productId}: ${errorData.error?.message || "Unknown error"}`);
          } else {
            successCount++;
          }
        } catch (err) {
          failedCount++;
          errors.push(`${productId}: ${err instanceof Error ? err.message : "Network error"}`);
        }
      }

      // Show appropriate toast message
      if (successCount > 0) {
        showToast("success", `✓ Successfully deleted ${successCount} product${successCount !== 1 ? "s" : ""} and all associated variations`);
      }

      if (failedCount > 0) {
        showToast("error", `✗ Failed to delete ${failedCount} product${failedCount !== 1 ? "s" : ""}: ${errors.join("; ")}`);
      }

      // Clear selection if any succeeded
      if (successCount > 0) {
        table.resetRowSelection();
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error occurred";
      showToast("error", `✗ Delete failed: ${errorMsg}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* ── Action Bar ──────────────────────────────────────────── */}
      <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5">
        {/* Selection count */}
        <span className="text-sm font-medium text-blue-800">
          {count} item{count !== 1 ? "s" : ""} selected
        </span>

        {/* Divider */}
        <div className="w-px h-5 bg-blue-200" />

        {/* Actions dropdown */}
        <div className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-blue-700 bg-white border border-blue-300 rounded-md hover:bg-blue-50 transition-colors disabled:opacity-50"
          >
            {loading ? (
              <>
                <svg
                  className="w-4 h-4 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Processing…
              </>
            ) : (
              <>
                Actions
                <svg
                  className={`w-4 h-4 transition-transform ${dropdownOpen ? "rotate-180" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </>
            )}
          </button>

          {dropdownOpen && !loading && (
            <div className="absolute left-0 top-full mt-1 w-52 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
              <button
                className="w-full text-left px-4 py-2 text-sm text-gray-500 cursor-not-allowed"
                disabled
              >
                💰 Match Low Price
                <span className="ml-1 text-xs text-gray-400">(coming soon)</span>
              </button>
              <button
                onClick={handlePause}
                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              >
                ⏸️ Pause Listings
              </button>
              <div className="border-t border-gray-100 my-1" />
              <button
                onClick={() => {
                  setConfirmDelete(true);
                  setDropdownOpen(false);
                }}
                className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
              >
                🗑️ Delete Listings
              </button>
            </div>
          )}
        </div>

        {/* Deselect all */}
        <button
          onClick={() => table.resetRowSelection()}
          className="text-sm text-blue-600 hover:text-blue-800 hover:underline transition-colors"
        >
          Clear selection
        </button>
      </div>

      {/* ── Delete Confirmation Modal ───────────────────────────── */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                <svg
                  className="w-5 h-5 text-red-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                  />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">
                  Delete {selectedSkus.length} listing
                  {selectedSkus.length !== 1 ? "s" : ""}?
                </h3>
                <p className="text-sm text-gray-500">
                  This action cannot be undone.
                </p>
              </div>
            </div>

            <p className="text-sm text-gray-600 mb-6">
              This will permanently delete the selected product
              {selectedSkus.length !== 1 ? "s" : ""}, including all
              variations, images, and sync records.
            </p>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={loading}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {loading ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast Notifications ─────────────────────────────────── */}
      <div className="fixed bottom-4 right-4 z-50 space-y-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`px-4 py-3 rounded-lg shadow-lg text-sm font-medium animate-in fade-in slide-in-from-bottom-2 ${
              toast.type === "success"
                ? "bg-green-50 text-green-800 border border-green-200"
                : toast.type === "error"
                  ? "bg-red-50 text-red-800 border border-red-200"
                  : "bg-blue-50 text-blue-800 border border-blue-200"
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </>
  );
}
