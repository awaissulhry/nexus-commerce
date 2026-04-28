"use client";

import { useState, useEffect } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
  SortingState,
} from "@tanstack/react-table";

interface QueueItem {
  id: string;
  productId: string;
  targetChannel: string;
  syncStatus: string;
  syncType: string;
  retryCount: number;
  nextRetryAt: string | null;
  createdAt: string;
  // ── PHASE 12a: Grace Period (Undo Sync) ─────────────────────────
  holdUntil: string | null;
  product: {
    id: string;
    sku: string;
    name: string;
    basePrice: number;
    totalStock: number;
  };
}

interface SyncQueueTableProps {
  initialItems: QueueItem[];
}

const columnHelper = createColumnHelper<QueueItem>();

function getChannelBadgeColor(channel: string) {
  switch (channel) {
    case "AMAZON":
      return "bg-orange-100 text-orange-800";
    case "EBAY":
      return "bg-red-100 text-red-800";
    case "SHOPIFY":
      return "bg-green-100 text-green-800";
    case "WOOCOMMERCE":
      return "bg-purple-100 text-purple-800";
    default:
      return "bg-slate-100 text-slate-800";
  }
}

function getStatusBadgeColor(status: string) {
  switch (status) {
    case "PENDING":
      return "bg-yellow-100 text-yellow-800";
    case "IN_PROGRESS":
      return "bg-blue-100 text-blue-800";
    case "SUCCESS":
      return "bg-green-100 text-green-800";
    case "FAILED":
      return "bg-red-100 text-red-800";
    case "SKIPPED":
      return "bg-slate-100 text-slate-800";
    default:
      return "bg-slate-100 text-slate-800";
  }
}

function formatDate(dateString: string) {
  const date = new Date(dateString);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SyncQueueTable({ initialItems }: SyncQueueTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [items, setItems] = useState(initialItems);
  // ── PHASE 12a: Grace Period (Undo Sync) ─────────────────────────
  // Track countdown timers for items in grace period
  const [countdowns, setCountdowns] = useState<Record<string, number>>({});

  // Update countdown timers every second
  useEffect(() => {
    const interval = setInterval(() => {
      setCountdowns((prev) => {
        const updated = { ...prev };
        items.forEach((item) => {
          if (item.holdUntil && item.syncStatus === "PENDING") {
            const holdUntilTime = new Date(item.holdUntil).getTime();
            const nowTime = Date.now();
            const remainingMs = holdUntilTime - nowTime;
            
            if (remainingMs > 0) {
              updated[item.id] = Math.ceil(remainingMs / 1000);
            } else {
              delete updated[item.id];
            }
          }
        });
        return updated;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [items]);

  const columns = [
    columnHelper.accessor("product.name", {
      header: "Product",
      cell: (info) => (
        <div className="min-w-0">
          <p className="font-medium text-slate-900 truncate">
            {info.row.original.product.name}
          </p>
          <p className="text-xs text-slate-500">{info.row.original.product.sku}</p>
        </div>
      ),
    }),
    columnHelper.accessor("targetChannel", {
      header: "Channel",
      cell: (info) => (
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getChannelBadgeColor(
            info.getValue()
          )}`}
        >
          {info.getValue()}
        </span>
      ),
    }),
    columnHelper.accessor("syncType", {
      header: "Sync Type",
      cell: (info) => (
        <span className="text-sm text-slate-700">{info.getValue()}</span>
      ),
    }),
    columnHelper.accessor("syncStatus", {
      header: "Status",
      cell: (info) => (
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusBadgeColor(
            info.getValue()
          )}`}
        >
          {info.getValue()}
        </span>
      ),
    }),
    columnHelper.accessor("retryCount", {
      header: "Retries",
      cell: (info) => (
        <span className="text-sm text-slate-700">
          {info.getValue()} / 3
        </span>
      ),
    }),
    columnHelper.accessor("nextRetryAt", {
      header: "Next Retry",
      cell: (info) => {
        const value = info.getValue();
        return (
          <span className="text-sm text-slate-700">
            {value ? formatDate(value) : "—"}
          </span>
        );
      },
    }),
    columnHelper.accessor("createdAt", {
      header: "Created",
      cell: (info) => (
        <span className="text-sm text-slate-700">
          {formatDate(info.getValue())}
        </span>
      ),
    }),
    // ── PHASE 12a: Grace Period (Undo Sync) ─────────────────────────
    // Show countdown timer for items in grace period
    columnHelper.display({
      id: "graceperiod",
      header: "Grace Period",
      cell: (info) => {
        const item = info.row.original;
        const countdown = countdowns[item.id];
        
        if (!item.holdUntil || item.syncStatus !== "PENDING") {
          return <span className="text-sm text-slate-500">—</span>;
        }

        if (countdown === undefined || countdown <= 0) {
          return <span className="text-sm text-slate-500">Ready</span>;
        }

        const minutes = Math.floor(countdown / 60);
        const seconds = countdown % 60;
        
        return (
          <span className="text-sm font-medium text-orange-600">
            Syncs in {minutes}:{seconds.toString().padStart(2, "0")}
          </span>
        );
      },
    }),
    columnHelper.display({
      id: "actions",
      header: "Actions",
      cell: (info) => {
        const item = info.row.original;
        const isFailed = item.syncStatus === "FAILED";
        const isRetrying = retryingId === item.id;
        const isCancelling = cancellingId === item.id;
        // ── PHASE 12a: Grace Period (Undo Sync) ─────────────────────────
        // Show cancel button for PENDING items in grace period
        const isInGracePeriod = item.holdUntil && item.syncStatus === "PENDING" && (countdowns[item.id] ?? 0) > 0;

        return (
          <div className="flex items-center gap-2">
            {isInGracePeriod && (
              <button
                onClick={() => handleCancel(item.id)}
                disabled={isCancelling}
                className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                  !isCancelling
                    ? "bg-red-100 text-red-700 hover:bg-red-200"
                    : "bg-red-50 text-red-400 cursor-not-allowed"
                }`}
              >
                {isCancelling ? (
                  <span className="flex items-center gap-1">
                    <svg
                      className="w-3 h-3 animate-spin"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                      />
                    </svg>
                    Cancelling...
                  </span>
                ) : (
                  "🗑️ Cancel"
                )}
              </button>
            )}
            <button
              onClick={() => handleRetry(item.id)}
              disabled={!isFailed || isRetrying}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                isFailed && !isRetrying
                  ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                  : "bg-slate-100 text-slate-400 cursor-not-allowed"
              }`}
            >
              {isRetrying ? (
                <span className="flex items-center gap-1">
                  <svg
                    className="w-3 h-3 animate-spin"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                  Retrying...
                </span>
              ) : (
                "Retry"
              )}
            </button>
          </div>
        );
      },
    }),
  ];

  const handleRetry = async (queueId: string) => {
    setRetryingId(queueId);

    try {
      const response = await fetch(`/api/outbound/queue/${queueId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (response.ok) {
        // Update the item in the table
        setItems((prevItems) =>
          prevItems.map((item) =>
            item.id === queueId
              ? { ...item, syncStatus: "PENDING", retryCount: 0 }
              : item
          )
        );
      }
    } catch (error) {
      console.error("Error retrying queue item:", error);
    } finally {
      setRetryingId(null);
    }
  };

  // ── PHASE 12a: Grace Period (Undo Sync) ─────────────────────────
  // Cancel a pending sync during grace period
  const handleCancel = async (queueId: string) => {
    setCancellingId(queueId);

    try {
      const response = await fetch(`/api/outbound/queue/${queueId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      if (response.ok) {
        // Remove the item from the table
        setItems((prevItems) =>
          prevItems.filter((item) => item.id !== queueId)
        );
        // Remove countdown timer
        setCountdowns((prev) => {
          const updated = { ...prev };
          delete updated[queueId];
          return updated;
        });
      } else {
        const error = await response.json();
        console.error("Error cancelling sync:", error);
      }
    } catch (error) {
      console.error("Error cancelling queue item:", error);
    } finally {
      setCancellingId(null);
    }
  };

  const table = useReactTable({
    data: items,
    columns,
    state: {
      sorting,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full" style={{ fontSize: "13px" }}>
          <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-20">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="px-6 py-3 text-left font-semibold text-slate-900 cursor-pointer select-none hover:bg-slate-100"
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <div className="flex items-center gap-2">
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                      {header.column.getIsSorted() && (
                        <span className="text-slate-400">
                          {header.column.getIsSorted() === "desc" ? "↓" : "↑"}
                        </span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-6 py-12 text-center text-slate-500"
                >
                  <div className="flex flex-col items-center gap-2">
                    <svg
                      className="w-12 h-12 text-slate-300"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
                      />
                    </svg>
                    <p className="text-sm">No sync queue items</p>
                  </div>
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row, rowIdx) => (
                <tr
                  key={row.id}
                  className={`border-b border-slate-200 hover:bg-slate-50 transition-colors ${
                    rowIdx % 2 === 0 ? "bg-white" : "bg-slate-50"
                  }`}
                >
                  {row.getVisibleCells().map((cell, cellIdx) => (
                    <td
                      key={cell.id}
                      className={`px-6 py-4 text-sm ${
                        cellIdx === 0 ? "font-medium" : ""
                      }`}
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Footer with item count */}
      <div className="bg-slate-50 border-t border-slate-200 px-6 py-3 text-sm text-slate-600">
        Showing {table.getRowModel().rows.length} of {items.length} items
      </div>
    </div>
  );
}
