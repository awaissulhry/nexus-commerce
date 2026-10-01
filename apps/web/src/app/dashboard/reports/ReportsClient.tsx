"use client";

import { useState, useTransition } from "react";
import Link from '@/lib/workspaces/Link';
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
              ? "bg-success-soft text-success-strong border border-green-200"
              : "bg-danger-soft text-danger-strong border border-red-200"
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
                : "bg-card text-secondary border border-strong hover:bg-sunken"
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
            className="bg-card rounded-lg shadow border border-default p-5 hover:shadow-md transition-shadow"
          >
            <div className="flex items-start gap-3 mb-3">
              <span className="text-2xl">{report.icon}</span>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-primary">{report.name}</h3>
                <span className="inline-block px-2 py-0.5 rounded text-xs bg-sunken text-secondary mt-1">
                  {report.category}
                </span>
              </div>
            </div>
            <p className="text-xs text-tertiary mb-4 line-clamp-2">{report.description}</p>
            <div className="flex items-center justify-between">
              <p className="text-xs text-tertiary">
                Generated: {formatDate(report.lastGenerated)}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleGenerate(report.id)}
                  disabled={isPending && generatingId === report.id}
                  className="px-3 py-1.5 text-xs font-medium bg-info-soft text-info-strong rounded-lg hover:opacity-80 disabled:opacity-50 transition"
                >
                  {isPending && generatingId === report.id ? "⏳" : "🔄"} Generate
                </button>
                <Link
                  href={`/dashboard/reports/${report.id}`}
                  className="px-3 py-1.5 text-xs font-medium bg-sunken text-secondary rounded-lg hover:opacity-80 transition"
                >
                  View →
                </Link>
              </div>
            </div>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="bg-card rounded-lg shadow border border-default p-12 text-center">
          <span className="text-3xl">📊</span>
          <p className="text-sm text-tertiary mt-3">No reports found in this category</p>
        </div>
      )}
    </div>
  );
}
