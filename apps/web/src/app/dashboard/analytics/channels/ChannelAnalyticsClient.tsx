"use client";

import { useState, useTransition } from "react";
import { getChannelAnalytics } from "./actions";

interface ChannelInfo {
  id: string;
  name: string;
  type: string;
  listingsCount: number;
  ordersCount: number;
  totalRevenue: number;
  syncStatus: string | null;
  lastSyncAt: string | null;
  listingStatuses: { status: string; count: number }[];
}

interface ChannelData {
  channels: ChannelInfo[];
  totals: {
    totalRevenue: number;
    totalListings: number;
    totalOrders: number;
    channelCount: number;
  };
}

export default function ChannelAnalyticsClient({ initialData }: { initialData: ChannelData }) {
  const [data, setData] = useState<ChannelData>(initialData);
  const [isPending, startTransition] = useTransition();

  const handleRefresh = () => {
    startTransition(async () => {
      const result = await getChannelAnalytics();
      if (result.success && result.data) {
        setData(result.data);
      }
    });
  };

  const formatCurrency = (amount: number) =>
    amount.toLocaleString("en-US", { style: "currency", currency: "USD" });

  const formatDate = (iso: string | null) => {
    if (!iso) return "Never";
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const syncBadge = (status: string | null) => {
    if (!status) return <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600">No Sync</span>;
    if (status === "SUCCESS")
      return <span className="px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700 font-bold">Healthy</span>;
    if (status === "FAILED")
      return <span className="px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700 font-bold">Failed</span>;
    return <span className="px-2 py-0.5 rounded-full text-xs bg-yellow-100 text-yellow-700 font-bold">{status}</span>;
  };

  const { totals } = data;

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

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase">Connected Channels</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{totals.channelCount}</p>
        </div>
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase">Total Listings</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{totals.totalListings.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase">Total Orders</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{totals.totalOrders.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase">Total Revenue</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(totals.totalRevenue)}</p>
        </div>
      </div>

      {/* Revenue Comparison Chart Placeholder */}
      <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">📊 Revenue by Channel</h3>
        <div className="h-[250px] bg-gradient-to-r from-purple-50 to-blue-50 rounded-lg flex items-center justify-center border border-dashed border-gray-300">
          <div className="text-center">
            <p className="text-sm font-medium text-gray-600">Channel Revenue Comparison</p>
            <p className="text-xs text-gray-400 mt-1">
              {data.channels.length} channels · Total: {formatCurrency(totals.totalRevenue)}
            </p>
            <p className="text-xs text-gray-400 mt-1">Recharts BarChart renders here</p>
          </div>
        </div>
      </div>

      {/* Channel Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {data.channels.length === 0 ? (
          <div className="lg:col-span-2 bg-white rounded-lg shadow border border-gray-200 p-12 text-center">
            <span className="text-3xl">🔗</span>
            <p className="text-sm text-gray-500 mt-3">No channels connected yet</p>
          </div>
        ) : (
          data.channels.map((ch) => (
            <div key={ch.id} className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">{ch.name}</h3>
                  <p className="text-xs text-gray-500">{ch.type}</p>
                </div>
                {syncBadge(ch.syncStatus)}
              </div>
              <div className="p-5">
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <div>
                    <p className="text-xs text-gray-500">Listings</p>
                    <p className="text-lg font-bold text-gray-900">{ch.listingsCount}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Orders</p>
                    <p className="text-lg font-bold text-gray-900">{ch.ordersCount}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Revenue</p>
                    <p className="text-lg font-bold text-gray-900">{formatCurrency(ch.totalRevenue)}</p>
                  </div>
                </div>

                {/* Listing Status Breakdown */}
                {ch.listingStatuses.length > 0 && (
                  <div className="mb-3">
                    <p className="text-xs font-medium text-gray-500 mb-2">Listing Status</p>
                    <div className="flex flex-wrap gap-2">
                      {ch.listingStatuses.map((ls) => (
                        <span
                          key={ls.status}
                          className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-700"
                        >
                          {ls.status}: {ls.count}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <p className="text-xs text-gray-400">Last sync: {formatDate(ch.lastSyncAt)}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
