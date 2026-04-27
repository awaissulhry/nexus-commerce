"use client";

import { useState, useTransition } from "react";
import { getReportDetail } from "./actions";

interface ReportSection {
  title: string;
  type: "table" | "stat" | "chart" | "text";
  data: any;
}

interface ReportData {
  reportId: string;
  name: string;
  generatedAt: string;
  sections: ReportSection[];
}

export default function ReportDetailClient({ initialData }: { initialData: ReportData }) {
  const [data, setData] = useState<ReportData>(initialData);
  const [isPending, startTransition] = useTransition();

  const handleRegenerate = () => {
    startTransition(async () => {
      const result = await getReportDetail(data.reportId);
      if (result.success && result.data) {
        setData(result.data);
      }
    });
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const formatCurrency = (amount: number) =>
    amount.toLocaleString("en-US", { style: "currency", currency: "USD" });

  const renderSection = (section: ReportSection, index: number) => {
    switch (section.type) {
      case "stat":
        return (
          <div key={index} className="bg-white rounded-lg shadow border border-gray-200 p-6">
            <h3 className="text-sm font-semibold text-gray-900 mb-4">{section.title}</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {Object.entries(section.data).map(([key, value]) => (
                <div key={key} className="text-center">
                  <p className="text-xs font-medium text-gray-500 uppercase">
                    {key.replace(/([A-Z])/g, " $1").trim()}
                  </p>
                  <p className="text-xl font-bold text-gray-900 mt-1">
                    {typeof value === "number"
                      ? key.toLowerCase().includes("revenue") || key.toLowerCase().includes("value")
                        ? formatCurrency(value)
                        : value.toLocaleString()
                      : String(value)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        );

      case "table":
        return (
          <div key={index} className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200">
              <h3 className="text-sm font-semibold text-gray-900">{section.title}</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {section.data.columns.map((col: string) => (
                      <th
                        key={col}
                        className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {section.data.rows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={section.data.columns.length}
                        className="px-4 py-8 text-center text-sm text-gray-500"
                      >
                        No data available
                      </td>
                    </tr>
                  ) : (
                    section.data.rows.map((row: string[], rowIdx: number) => (
                      <tr key={rowIdx} className="hover:bg-gray-50">
                        {row.map((cell: string, cellIdx: number) => (
                          <td key={cellIdx} className="px-4 py-3 text-sm text-gray-700">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 text-xs text-gray-500">
              {section.data.rows.length} rows
            </div>
          </div>
        );

      case "chart":
        return (
          <div key={index} className="bg-white rounded-lg shadow border border-gray-200 p-6">
            <h3 className="text-sm font-semibold text-gray-900 mb-4">{section.title}</h3>
            <div className="h-[250px] bg-gradient-to-r from-blue-50 to-green-50 rounded-lg flex items-center justify-center border border-dashed border-gray-300">
              <p className="text-sm text-gray-500">Chart placeholder</p>
            </div>
          </div>
        );

      case "text":
        return (
          <div key={index} className="bg-white rounded-lg shadow border border-gray-200 p-6">
            <h3 className="text-sm font-semibold text-gray-900 mb-2">{section.title}</h3>
            <p className="text-sm text-gray-600">{section.data.message}</p>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* Report Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-500">
            Generated: {formatDate(data.generatedAt)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => window.print()}
            className="px-4 py-2 text-sm font-medium bg-white text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            🖨️ Print
          </button>
          <button
            onClick={handleRegenerate}
            disabled={isPending}
            className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {isPending ? "Generating…" : "🔄 Regenerate"}
          </button>
        </div>
      </div>

      {/* Report Sections */}
      {data.sections.map((section, index) => renderSection(section, index))}
    </div>
  );
}
