"use client";

import { useState } from "react";
import SalesChart from "@/components/shared/SalesChart";
import type { SalesDataPoint } from "@/components/shared/SalesChart";

interface DashboardClientProps {
  salesData: SalesDataPoint[];
}

export default function DashboardClient({ salesData }: DashboardClientProps) {
  const [metric, setMetric] = useState<"revenue" | "orders" | "units">("revenue");

  return (
    <div>
      {/* Metric selector */}
      <div className="flex items-center gap-2 mb-2">
        {(["revenue", "orders", "units"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMetric(m)}
            className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              metric === m
                ? "bg-blue-50 text-blue-700"
                : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
            }`}
          >
            {m === "revenue" ? "Revenue" : m === "orders" ? "Orders" : "Units Sold"}
          </button>
        ))}
      </div>

      <SalesChart
        data={salesData}
        metric={metric}
        title={`${metric === "revenue" ? "Revenue" : metric === "orders" ? "Orders" : "Units Sold"} — Last 30 Days`}
      />
    </div>
  );
}
