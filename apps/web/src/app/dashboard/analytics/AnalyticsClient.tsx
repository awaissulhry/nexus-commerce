"use client";

import { useState, useTransition } from "react";
import { getAnalyticsData } from "./actions";

type Period = "7d" | "30d" | "90d" | "1y";

interface AnalyticsData {
  ordersByStatus: { status: string; count: number }[];
  totalRevenue: number;
  totalOrders: number;
  revenueByDay: { date: string; amount: number }[];
  topProducts: { sku: string; totalQuantity: number; orderCount: number }[];
}

export default function AnalyticsClient({ initialData }: { initialData: AnalyticsData }) {
  const [period, setPeriod] = useState<Period>("30d");
  const [data, setData] = useState<AnalyticsData>(initialData);
  const [isPending, startTransition] = useTransition();

  const handlePeriodChange = (p: Period) => {
    setPeriod(p);
    startTransition(async () => {
      const result = await getAnalyticsData(p);
      if (result.success && result.data) {
        setData(result.data);
      }
    });
  };

  const formatCurrency = (amount: number) =>
    amount.toLocaleString("en-US", { style: "currency", currency: "USD" });

  return (
    <div className="space-y-6">
      {/* Period Selector */}
      <div className="flex items-center gap-2">
        {(["7d", "30d", "90d", "1y"] as Period[]).map((p) => (
          <button
            key={p}
            onClick={() => handlePeriodChange(p)}
            disabled={isPending}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              period === p
                ? "bg-blue-600 text-white"
                : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50"
            }`}
          >
            {p === "7d" ? "7 Days" : p === "30d" ? "30 Days" : p === "90d" ? "90 Days" : "1 Year"}
          </button>
        ))}
        {isPending && <span className="text-sm text-gray-500 ml-2">Loading…</span>}
      </div>

      {/* Revenue Over Time Chart Placeholder */}
      <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">📈 Revenue Over Time</h3>
        <div className="h-[250px] bg-gradient-to-r from-blue-50 to-green-50 rounded-lg flex items-center justify-center border border-dashed border-gray-300">
          <div className="text-center">
            <p className="text-sm font-medium text-gray-600">Revenue Chart</p>
            <p className="text-xs text-gray-400 mt-1">
              {data.revenueByDay.length} data points · Total: {formatCurrency(data.totalRevenue)}
            </p>
            <p className="text-xs text-gray-400 mt-1">Recharts AreaChart renders here</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Orders by Status */}
        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">📊 Orders by Status</h3>
          {data.ordersByStatus.length === 0 ? (
            <p className="text-sm text-gray-500">No orders in this period</p>
          ) : (
            <div className="space-y-3">
              {data.ordersByStatus.map((s) => {
                const total = data.totalOrders || 1;
                const pct = Math.round((s.count / total) * 100);
                return (
                  <div key={s.status}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="font-medium text-gray-700">{s.status}</span>
                      <span className="text-gray-500">{s.count} ({pct}%)</span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-2">
                      <div
                        className="bg-blue-500 h-2 rounded-full transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Top Products */}
        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">🏆 Top 5 Selling Products</h3>
          {data.topProducts.length === 0 ? (
            <p className="text-sm text-gray-500">No sales in this period</p>
          ) : (
            <div className="space-y-3">
              {data.topProducts.map((p, i) => (
                <div key={p.sku} className="flex items-center gap-3">
                  <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center">
                    {i + 1}
                  </span>
                  <div className="flex-1">
                    <p className="text-sm font-mono text-gray-900">{p.sku}</p>
                    <p className="text-xs text-gray-500">
                      {p.totalQuantity} units · {p.orderCount} orders
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Channel Performance Placeholder */}
      <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">🔗 Channel Performance Comparison</h3>
        <div className="h-[200px] bg-gradient-to-r from-purple-50 to-blue-50 rounded-lg flex items-center justify-center border border-dashed border-gray-300">
          <div className="text-center">
            <p className="text-sm font-medium text-gray-600">Channel Comparison Chart</p>
            <p className="text-xs text-gray-400 mt-1">Recharts BarChart renders here</p>
          </div>
        </div>
      </div>
    </div>
  );
}
