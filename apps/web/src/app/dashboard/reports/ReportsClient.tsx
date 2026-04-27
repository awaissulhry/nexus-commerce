"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { generateReport, type ReportDefinition } from "./actions";

export default function ReportsClient({ reports }: { reports: ReportDefinition[] }) {
  const [isPending, startTransition] = useTransition();
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [filter, setFilter] = useState<string>("all");

  const categories = ["all", ...Array.from(new Set(reports.map((r) => r.category)))];

  const filtered = filter === "all" ? reports : reports.filter((r) => r.category === filter);

  const handleGenerate = (reportId: string) => {
    setGeneratingId(reportId);
    setMessage(null);
    startTransition(async () => {
      const result = await generateReport(reportId);
      if (result.success) {
        setMessage({ type: "success", text: "Report generated successfully!" });
        setTimeout(() => setMessage(null), 3000);
      } else {
        setMessage({ type: "error", text: result.error || "Generation failed" });
      }
      setGeneratingId(null);
    });
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return "Never";
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="space-y-6">
      {/* Message */}
      {message && (
        <div
          className={`px-4 py-3 rounded-lg text-sm ${
            message.type === "success"
              ? "bg-green-50 text-green-700 border border-green-200"
              : "bg-red-50 text-red-700 border border-red-200"
          }`}
        >
          {message.type === "success" ? "✅" : "❌"} {message.text}
        </div>
      )}

      {/* Category Filter */}
      <div className="flex items-center gap-2 flex-wrap">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setFilter(cat)}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
              filter === cat
                ? "bg-blue-600 text-white"
                : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50"
            }`}
          >
            {cat === "all" ? "All Reports" : cat}
          </button>
        ))}
      </div>

      {/* Reports Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((report) => (
          <div
            key={report.id}
            className="bg-white rounded-lg shadow border border-gray-200 p-5 hover:shadow-md transition-shadow"
          >
            <div className="flex items-start gap-3 mb-3">
              <span className="text-2xl">{report.icon}</span>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-gray-900">{report.name}</h3>
                <span className="inline-block px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600 mt-1">
                  {report.category}
                </span>
              </div>
            </div>
            <p className="text-xs text-gray-500 mb-4 line-clamp-2">{report.description}</p>
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-400">
                Generated: {formatDate(report.lastGenerated)}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleGenerate(report.id)}
                  disabled={isPending && generatingId === report.id}
                  className="px-3 py-1.5 text-xs font-medium bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 disabled:opacity-50 transition-colors"
                >
                  {isPending && generatingId === report.id ? "⏳" : "🔄"} Generate
                </button>
                <Link
                  href={`/dashboard/reports/${report.id}`}
                  className="px-3 py-1.5 text-xs font-medium bg-gray-50 text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  View →
                </Link>
              </div>
            </div>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-12 text-center">
          <span className="text-3xl">📊</span>
          <p className="text-sm text-gray-500 mt-3">No reports found in this category</p>
        </div>
      )}
    </div>
  );
}
