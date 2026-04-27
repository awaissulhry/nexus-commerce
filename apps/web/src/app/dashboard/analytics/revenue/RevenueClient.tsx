"use client";

import { useState, useTransition } from "react";
import { getRevenueAnalytics } from "./actions";

type Period = "7d" | "30d" | "90d" | "1y";

interface RevenueData {
  totalRevenue: number;
  previousRevenue: number;
  revenueChange: number;
  totalOrders: number;
  previousOrders: number;
  ordersChange: number;
  avgOrderValue: number;
  revenueByDay: { date: string; revenue: number; orders: number }[];
  revenueByStatus: { status: string; amount: number }[];
  topRevenueProducts: { sku: string; totalRevenue: number; totalQuantity: number }[];
}

export default function RevenueClient({ initialData }: { initialData: RevenueData }) {
  const [period, setPeriod] = useState<Period>("30d");
  const [data, setData] = useState<RevenueData>(initialData);
  const [isPending, startTransition] = useTransition();

  const handlePeriodChange = (p: Period) => {
    setPeriod(p);
    startTransition(async () => {
      const result = await getRevenueAnalytics(p);
      if (result.success && result.data) {
        setData(result.data);
      }
    });
  };

  const formatCurrency = (amount: number) =>
    amount.toLocaleString("en-US", { style: "currency", currency: "USD" });

  const changeIndicator = (change: number) => {
    if (change > 0) return <span className="text-green-600 text-xs font-bold">▲ {change}%</span>;
    if (change < 0) return <span className="text-red-600 text-xs font-bold">▼ {Math.abs(change)}%</span>;
    return <span className="text-gray-500 text-xs">— 0%</span>;
  };

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

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase">Total Revenue</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(data.totalRevenue)}</p>
          <div className="mt-2">{changeIndicator(data.revenueChange)}</div>
        </div>
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase">Total Orders</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{data.totalOrders.toLocaleString()}</p>
          <div className="mt-2">{changeIndicator(data.ordersChange)}</div>
        </div>
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase">Avg Order Value</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(data.avgOrderValue)}</p>
        </div>
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase">Previous Period</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(data.previousRevenue)}</p>
          <p className="text-xs text-gray-400 mt-2">{data.previousOrders} orders</p>
        </div>
      </div>

      {/* Revenue Chart Placeholder */}
      <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">📈 Daily Revenue Trend</h3>
        <div className="h-[280px] bg-gradient-to-r from-green-50 to-blue-50 rounded-lg flex items-center justify-center border border-dashed border-gray-300">
          <div className="text-center">
            <p className="text-sm font-medium text-gray-600">Revenue Area Chart</p>
            <p className="text-xs text-gray-400 mt-1">
              {data.revenueByDay.length} days · Total: {formatCurrency(data.totalRevenue)}
            </p>
            <p className="text-xs text-gray-400 mt-1">Recharts AreaChart renders here</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenue by Status */}
        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">💳 Revenue by Order Status</h3>
          {data.revenueByStatus.length === 0 ? (
            <p className="text-sm text-gray-500">No revenue data in this period</p>
          ) : (
            <div className="space-y-3">
              {data.revenueByStatus
                .sort((a, b) => b.amount - a.amount)
                .map((s) => {
                  const total = data.totalRevenue || 1;
                  const pct = Math.round((s.amount / total) * 100);
                  return (
                    <div key={s.status}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="font-medium text-gray-700">{s.status}</span>
                        <span className="text-gray-500">
                          {formatCurrency(s.amount)} ({pct}%)
                        </span>
                      </div>
                      <div className="w-full bg-gray-100 rounded-full h-2">
                        <div
                          className="bg-green-500 h-2 rounded-full transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        {/* Top Revenue Products */}
        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">🏆 Top Revenue Products</h3>
          {data.topRevenueProducts.length === 0 ? (
            <p className="text-sm text-gray-500">No product revenue data</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">#</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">SKU</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Revenue</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Units</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.topRevenueProducts.map((p, i) => (
                    <tr key={p.sku} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-sm text-gray-500">{i + 1}</td>
                      <td className="px-3 py-2 text-sm font-mono text-gray-900">{p.sku}</td>
                      <td className="px-3 py-2 text-sm text-right font-medium text-gray-900">
                        {formatCurrency(p.totalRevenue)}
                      </td>
                      <td className="px-3 py-2 text-sm text-right text-gray-600">{p.totalQuantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
