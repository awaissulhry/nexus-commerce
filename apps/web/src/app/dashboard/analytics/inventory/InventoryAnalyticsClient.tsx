"use client";

import { useState, useTransition } from "react";
import { getInventoryAnalytics } from "./actions";

interface InventoryData {
  totalProducts: number;
  totalUnits: number;
  totalStockValue: number;
  stockDistribution: {
    outOfStock: number;
    lowStock: number;
    healthyStock: number;
    overStock: number;
  };
  topStocked: {
    id: string;
    sku: string;
    name: string;
    totalStock: number;
    stockValue: number;
    variationCount: number;
  }[];
  lowStockProducts: { id: string; sku: string; name: string; totalStock: number }[];
  outOfStockProducts: { id: string; sku: string; name: string }[];
  priceTiers: { label: string; count: number; value: number }[];
}

export default function InventoryAnalyticsClient({ initialData }: { initialData: InventoryData }) {
  const [data, setData] = useState<InventoryData>(initialData);
  const [isPending, startTransition] = useTransition();

  const handleRefresh = () => {
    startTransition(async () => {
      const result = await getInventoryAnalytics();
      if (result.success && result.data) {
        setData(result.data);
      }
    });
  };

  const formatCurrency = (amount: number) =>
    amount.toLocaleString("en-US", { style: "currency", currency: "USD" });

  const dist = data.stockDistribution;
  const total = dist.outOfStock + dist.lowStock + dist.healthyStock + dist.overStock || 1;

  const distBars = [
    { label: "Out of Stock", count: dist.outOfStock, color: "bg-red-500" },
    { label: "Low Stock (<10)", count: dist.lowStock, color: "bg-yellow-500" },
    { label: "Healthy", count: dist.healthyStock, color: "bg-green-500" },
    { label: "Overstock (>500)", count: dist.overStock, color: "bg-blue-500" },
  ];

  return (
    <div className="space-y-6">
      {/* Refresh */}
      <div className="flex justify-end">
        <button
          onClick={handleRefresh}
          disabled={isPending}
          className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {isPending ? "Refreshing…" : "🔄 Refresh"}
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase">Total Products</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{data.totalProducts.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase">Total Units</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{data.totalUnits.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase">Stock Value</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(data.totalStockValue)}</p>
        </div>
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase">Out of Stock</p>
          <p className="text-2xl font-bold text-red-600 mt-1">{dist.outOfStock}</p>
          <p className="text-xs text-gray-400 mt-1">
            {Math.round((dist.outOfStock / total) * 100)}% of catalog
          </p>
        </div>
      </div>

      {/* Stock Distribution */}
      <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">📊 Stock Distribution</h3>
        <div className="space-y-3">
          {distBars.map((bar) => {
            const pct = Math.round((bar.count / total) * 100);
            return (
              <div key={bar.label}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="font-medium text-gray-700">{bar.label}</span>
                  <span className="text-gray-500">
                    {bar.count} products ({pct}%)
                  </span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-2.5">
                  <div
                    className={`${bar.color} h-2.5 rounded-full transition-all`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Price Tier Breakdown */}
        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">💰 Stock Value by Price Tier</h3>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Tier</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Products</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Stock Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.priceTiers.map((tier) => (
                  <tr key={tier.label} className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-sm font-medium text-gray-900">{tier.label}</td>
                    <td className="px-3 py-2 text-sm text-right text-gray-600">{tier.count}</td>
                    <td className="px-3 py-2 text-sm text-right font-medium text-gray-900">
                      {formatCurrency(tier.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Top Stocked Products */}
        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">📦 Top Stocked Products</h3>
          {data.topStocked.length === 0 ? (
            <p className="text-sm text-gray-500">No products found</p>
          ) : (
            <div className="space-y-3 max-h-[400px] overflow-y-auto">
              {data.topStocked.map((p, i) => (
                <div key={p.id} className="flex items-center gap-3 py-1">
                  <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center flex-shrink-0">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{p.name}</p>
                    <p className="text-xs text-gray-500">
                      {p.sku} · {p.variationCount} variations
                    </p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-bold text-gray-900">{p.totalStock.toLocaleString()}</p>
                    <p className="text-xs text-gray-400">{formatCurrency(p.stockValue)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Low Stock Alerts */}
        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">⚠️ Low Stock Alerts</h3>
          {data.lowStockProducts.length === 0 ? (
            <div className="text-center py-6">
              <span className="text-2xl">✅</span>
              <p className="text-sm text-gray-500 mt-2">All products are well-stocked</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100 max-h-[300px] overflow-y-auto">
              {data.lowStockProducts.map((p) => (
                <div key={p.id} className="py-2 flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-900 truncate">{p.name}</p>
                    <p className="text-xs text-gray-500 font-mono">{p.sku}</p>
                  </div>
                  <span className="text-xs font-bold text-yellow-600 ml-3">{p.totalStock} left</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Out of Stock */}
        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">🚫 Out of Stock</h3>
          {data.outOfStockProducts.length === 0 ? (
            <div className="text-center py-6">
              <span className="text-2xl">🎉</span>
              <p className="text-sm text-gray-500 mt-2">No products are out of stock</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100 max-h-[300px] overflow-y-auto">
              {data.outOfStockProducts.map((p) => (
                <div key={p.id} className="py-2">
                  <p className="text-sm text-gray-900 truncate">{p.name}</p>
                  <p className="text-xs text-gray-500 font-mono">{p.sku}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
