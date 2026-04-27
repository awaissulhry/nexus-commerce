"use client";

import { useState } from "react";
import SalesChart from "@/components/shared/SalesChart";
import ExportButton from "@/components/shared/ExportButton";
import type { SalesDataPoint } from "@/components/shared/SalesChart";

interface TopProduct {
  rank: number;
  title: string;
  sku: string;
  revenue: number;
  units: number;
  orders: number;
}

interface BusinessReportsClientProps {
  salesData: SalesDataPoint[];
  topProducts: TopProduct[];
  summary: {
    totalRevenue: number;
    totalOrders: number;
    totalUnits: number;
    avgOrderValue: number;
  };
}

const fmt = (v: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(v);

export default function BusinessReportsClient({
  salesData,
  topProducts,
  summary,
}: BusinessReportsClientProps) {
  const [metric, setMetric] = useState<"revenue" | "orders" | "units">("revenue");

  return (
    <div>
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Total Revenue</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{fmt(summary.totalRevenue)}</p>
        </div>
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Total Orders</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{summary.totalOrders.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Units Sold</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{summary.totalUnits.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Avg Order Value</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{fmt(summary.avgOrderValue)}</p>
        </div>
      </div>

      {/* Sales Chart */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
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
          <ExportButton
            data={salesData as unknown as Record<string, unknown>[]}
            columns={{ date: "Date", revenue: "Revenue", orders: "Orders", units: "Units" }}
            filename="business-report-sales"
          />
        </div>
        <SalesChart
          data={salesData}
          metric={metric}
          title={`${metric === "revenue" ? "Revenue" : metric === "orders" ? "Orders" : "Units Sold"} — Last 30 Days`}
        />
      </div>

      {/* Top Products Table */}
      <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-gray-900">Top Products by Revenue</h3>
          <ExportButton
            data={topProducts as unknown as Record<string, unknown>[]}
            columns={{ rank: "Rank", sku: "SKU", title: "Product", revenue: "Revenue", units: "Units", orders: "Orders" }}
            filename="top-products"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">#</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Product</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">SKU</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Revenue</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Units</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Orders</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {topProducts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-sm text-gray-500">
                    No sales data available for the last 30 days.
                  </td>
                </tr>
              ) : (
                topProducts.map((product) => (
                  <tr key={product.sku} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4 text-sm font-medium text-gray-500">{product.rank}</td>
                    <td className="px-6 py-4 text-sm font-medium text-gray-900 max-w-xs truncate">
                      {product.title || '—'}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600 font-mono">{product.sku}</td>
                    <td className="px-6 py-4 text-sm font-semibold text-gray-900 text-right">{fmt(product.revenue)}</td>
                    <td className="px-6 py-4 text-sm text-gray-700 text-right">{product.units.toLocaleString()}</td>
                    <td className="px-6 py-4 text-sm text-gray-700 text-right">{product.orders.toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
