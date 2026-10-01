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
    amount.toLocaleString("en-IE", { style: "currency", currency: "EUR" });

  const changeIndicator = (change: number) => {
    if (change > 0) return <span className="text-success-strong text-xs font-bold">▲ {change}%</span>;
    if (change < 0) return <span className="text-danger-strong text-xs font-bold">▼ {Math.abs(change)}%</span>;
    return <span className="text-tertiary text-xs">— 0%</span>;
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
                : "bg-card text-secondary border border-strong hover:bg-sunken"
            }`}
          >
            {p === "7d" ? "7 Days" : p === "30d" ? "30 Days" : p === "90d" ? "90 Days" : "1 Year"}
          </button>
        ))}
        {isPending && <span className="text-sm text-tertiary ml-2">Loading…</span>}
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-card rounded-lg shadow border border-default p-5">
          <p className="text-xs font-medium text-tertiary uppercase">Total Revenue</p>
          <p className="text-2xl font-bold text-primary mt-1">{formatCurrency(data.totalRevenue)}</p>
          <div className="mt-2">{changeIndicator(data.revenueChange)}</div>
        </div>
        <div className="bg-card rounded-lg shadow border border-default p-5">
          <p className="text-xs font-medium text-tertiary uppercase">Total Orders</p>
          <p className="text-2xl font-bold text-primary mt-1">{data.totalOrders.toLocaleString()}</p>
          <div className="mt-2">{changeIndicator(data.ordersChange)}</div>
        </div>
        <div className="bg-card rounded-lg shadow border border-default p-5">
          <p className="text-xs font-medium text-tertiary uppercase">Avg Order Value</p>
          <p className="text-2xl font-bold text-primary mt-1">{formatCurrency(data.avgOrderValue)}</p>
        </div>
        <div className="bg-card rounded-lg shadow border border-default p-5">
          <p className="text-xs font-medium text-tertiary uppercase">Previous Period</p>
          <p className="text-2xl font-bold text-primary mt-1">{formatCurrency(data.previousRevenue)}</p>
          <p className="text-xs text-tertiary mt-2">{data.previousOrders} orders</p>
        </div>
      </div>

      {/* Revenue Chart Placeholder */}
      <div className="bg-card rounded-lg shadow border border-default p-6">
        <h3 className="text-sm font-semibold text-primary mb-4">📈 Daily Revenue Trend</h3>
        <div className="h-[280px] bg-gradient-to-r from-success-soft to-info-soft rounded-lg flex items-center justify-center border border-dashed border-strong">
          <div className="text-center">
            <p className="text-sm font-medium text-secondary">Revenue Area Chart</p>
            <p className="text-xs text-tertiary mt-1">
              {data.revenueByDay.length} days · Total: {formatCurrency(data.totalRevenue)}
            </p>
            <p className="text-xs text-tertiary mt-1">Recharts AreaChart renders here</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenue by Status */}
        <div className="bg-card rounded-lg shadow border border-default p-6">
          <h3 className="text-sm font-semibold text-primary mb-4">💳 Revenue by Order Status</h3>
          {data.revenueByStatus.length === 0 ? (
            <p className="text-sm text-tertiary">No revenue data in this period</p>
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
                        <span className="font-medium text-secondary">{s.status}</span>
                        <span className="text-tertiary">
                          {formatCurrency(s.amount)} ({pct}%)
                        </span>
                      </div>
                      <div className="w-full bg-sunken rounded-full h-2">
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
        <div className="bg-card rounded-lg shadow border border-default p-6">
          <h3 className="text-sm font-semibold text-primary mb-4">🏆 Top Revenue Products</h3>
          {data.topRevenueProducts.length === 0 ? (
            <p className="text-sm text-tertiary">No product revenue data</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-sunken border-b border-default">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-tertiary uppercase">#</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-tertiary uppercase">SKU</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-tertiary uppercase">Revenue</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-tertiary uppercase">Units</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-subtle">
                  {data.topRevenueProducts.map((p, i) => (
                    <tr key={p.sku} className="hover:bg-sunken">
                      <td className="px-3 py-2 text-sm text-tertiary">{i + 1}</td>
                      <td className="px-3 py-2 text-sm font-mono text-primary">{p.sku}</td>
                      <td className="px-3 py-2 text-sm text-right font-medium text-primary">
                        {formatCurrency(p.totalRevenue)}
                      </td>
                      <td className="px-3 py-2 text-sm text-right text-secondary">{p.totalQuantity}</td>
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
