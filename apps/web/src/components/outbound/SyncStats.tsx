"use client";

import { useState } from "react";

interface SyncStatsProps {
  stats: {
    queued: number;
    processed: number;
    succeeded: number;
    failed: number;
    queueStatus?: Record<string, number>;
    queueByChannel?: Record<string, number>;
    totalQueued?: number;
  };
}

export default function SyncStats({ stats }: SyncStatsProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [processMessage, setProcessMessage] = useState("");

  const handleProcessQueue = async () => {
    setIsProcessing(true);
    setProcessMessage("");

    try {
      const response = await fetch("/api/outbound/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: false }),
      });

      const data = await response.json();

      if (data.success) {
        setProcessMessage(
          `✅ Processed ${data.stats.processed} items: ${data.stats.succeeded} succeeded, ${data.stats.failed} failed`
        );
        // Refresh page after 2 seconds
        setTimeout(() => window.location.reload(), 2000);
      } else {
        setProcessMessage("❌ Failed to process queue");
      }
    } catch (error) {
      setProcessMessage("❌ Error processing queue");
      console.error("Error:", error);
    } finally {
      setIsProcessing(false);
    }
  };

  const pendingCount = stats.queueStatus?.PENDING || 0;
  const successCount = stats.succeeded || 0;
  const failedCount = stats.failed || 0;
  const processedCount = stats.processed || 0;

  return (
    <div className="space-y-4">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Pending Syncs */}
        <div className="bg-white rounded-lg border border-slate-200 p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600">Pending Syncs</p>
              <p className="text-3xl font-bold text-slate-900 mt-2">
                {pendingCount}
              </p>
            </div>
            <div className="w-12 h-12 bg-yellow-100 rounded-lg flex items-center justify-center">
              <svg
                className="w-6 h-6 text-yellow-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
          </div>
          <p className="text-xs text-slate-500 mt-4">Waiting to be processed</p>
        </div>

        {/* Successful Syncs */}
        <div className="bg-white rounded-lg border border-slate-200 p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600">
                Successful Syncs
              </p>
              <p className="text-3xl font-bold text-slate-900 mt-2">
                {successCount}
              </p>
            </div>
            <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
              <svg
                className="w-6 h-6 text-green-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
          </div>
          <p className="text-xs text-slate-500 mt-4">Successfully synced</p>
        </div>

        {/* Failed Syncs */}
        <div className="bg-white rounded-lg border border-slate-200 p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600">Failed Syncs</p>
              <p className="text-3xl font-bold text-slate-900 mt-2">
                {failedCount}
              </p>
            </div>
            <div className="w-12 h-12 bg-red-100 rounded-lg flex items-center justify-center">
              <svg
                className="w-6 h-6 text-red-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4m0 4v.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
          </div>
          <p className="text-xs text-slate-500 mt-4">Need attention</p>
        </div>

        {/* Total Processed */}
        <div className="bg-white rounded-lg border border-slate-200 p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600">
                Total Processed
              </p>
              <p className="text-3xl font-bold text-slate-900 mt-2">
                {processedCount}
              </p>
            </div>
            <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
              <svg
                className="w-6 h-6 text-blue-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
            </div>
          </div>
          <p className="text-xs text-slate-500 mt-4">All time</p>
        </div>
      </div>

      {/* Process Queue Button */}
      <div className="bg-white rounded-lg border border-slate-200 p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">
              Process Queue
            </h3>
            <p className="text-sm text-slate-600 mt-1">
              Manually trigger processing of all pending syncs
            </p>
          </div>
          <button
            onClick={handleProcessQueue}
            disabled={isProcessing || pendingCount === 0}
            className={`px-6 py-2 rounded-lg font-medium transition-colors ${
              isProcessing || pendingCount === 0
                ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                : "bg-blue-600 text-white hover:bg-blue-700"
            }`}
          >
            {isProcessing ? (
              <span className="flex items-center gap-2">
                <svg
                  className="w-4 h-4 animate-spin"
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
                Processing...
              </span>
            ) : (
              "Process Now"
            )}
          </button>
        </div>

        {processMessage && (
          <div className="mt-4 p-3 bg-slate-50 rounded border border-slate-200 text-sm">
            {processMessage}
          </div>
        )}
      </div>
    </div>
  );
}
