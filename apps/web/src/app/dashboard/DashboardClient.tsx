"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { refreshDashboardData } from "./actions";
import { getBackendUrl } from "@/lib/backend-url";

interface DashboardClientProps {
  recentOrders: {
    id: string;
    channelOrderId: string;
    status: string;
    totalPrice: number;
    customerName: string;
    createdAt: string;
  }[];
  lowStockProducts: {
    id: string;
    sku: string;
    name: string;
    totalStock: number;
  }[];
  channelHealth: {
    id: string;
    name: string;
    type: string;
    listingsCount: number;
    lastSyncStatus: string | null;
  }[];
}

export default function DashboardClient({
  recentOrders,
  lowStockProducts,
  channelHealth,
}: DashboardClientProps) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const handleRefresh = () => {
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await refreshDashboardData();
        if (result.success) {
          setMessage({ type: "success", text: "Dashboard data refreshed!" });
          setTimeout(() => setMessage(null), 3000);
        } else {
          setMessage({ type: "error", text: result.error || "Refresh failed" });
        }
      } catch {
        setMessage({ type: "error", text: "Failed to refresh" });
      }
    });
  };

  const formatCurrency = (amount: number) =>
    amount.toLocaleString("en-US", { style: "currency", currency: "USD" });

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <div className="space-y-6">
      {/* Refresh Bar */}
      <div className="flex items-center justify-between">
        <div>
          {message && (
            <span
              className={`text-sm ${
                message.type === "success" ? "text-green-600" : "text-red-600"
              }`}
            >
              {message.type === "success" ? "✅" : "❌"} {message.text}
            </span>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={isPending}
          className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {isPending ? "Refreshing…" : "🔄 Refresh Data"}
        </button>
      </div>

      {/* AU.7 — Amazon Account Health (LSR/VTR) widget */}
      <AccountHealthWidget />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Orders */}
        <div className="lg:col-span-2 bg-white rounded-lg shadow border border-gray-200">
          <div className="px-5 py-4 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-900">Recent Orders</h3>
          </div>
          {recentOrders.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-500">No orders yet</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Order ID</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Buyer</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {recentOrders.map((order) => (
                    <tr key={order.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-mono text-gray-900">{order.channelOrderId.slice(0, 12)}…</td>
                      <td className="px-4 py-3 text-sm text-gray-700">{order.customerName || "—"}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                            order.status === "SHIPPED"
                              ? "bg-green-100 text-green-700"
                              : order.status === "PENDING"
                                ? "bg-yellow-100 text-yellow-700"
                                : "bg-gray-100 text-gray-700"
                          }`}
                        >
                          {order.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-medium text-gray-900">
                        {formatCurrency(order.totalPrice)}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{formatDate(order.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Low Stock Alerts */}
        <div className="bg-white rounded-lg shadow border border-gray-200">
          <div className="px-5 py-4 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-900">⚠️ Low Stock Alerts</h3>
          </div>
          {lowStockProducts.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-500">
              <span className="text-2xl block mb-2">✅</span>
              All products are well-stocked
            </div>
          ) : (
            <div className="divide-y divide-gray-100 max-h-[400px] overflow-y-auto">
              {lowStockProducts.map((product) => (
                <div key={product.id} className="px-5 py-3 hover:bg-gray-50">
                  <p className="text-sm font-medium text-gray-900 truncate">{product.name}</p>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-gray-500 font-mono">{product.sku}</span>
                    <span
                      className={`text-xs font-bold ${
                        product.totalStock === 0 ? "text-red-600" : "text-yellow-600"
                      }`}
                    >
                      {product.totalStock === 0 ? "OUT OF STOCK" : `${product.totalStock} left`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Channel Health */}
      <div className="bg-white rounded-lg shadow border border-gray-200">
        <div className="px-5 py-4 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-gray-900">Channel Health</h3>
        </div>
        {channelHealth.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">No channels connected</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 p-5">
            {channelHealth.map((ch) => (
              <div key={ch.id} className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-gray-900">{ch.name}</span>
                  <span
                    className={`w-2.5 h-2.5 rounded-full ${
                      ch.lastSyncStatus === "SUCCESS"
                        ? "bg-green-500"
                        : ch.lastSyncStatus === "FAILED"
                          ? "bg-red-500"
                          : "bg-yellow-500"
                    }`}
                  />
                </div>
                <div className="grid grid-cols-1 gap-2 text-xs">
                  <div>
                    <p className="text-gray-500">Listings</p>
                    <p className="font-bold text-gray-900">{ch.listingsCount}</p>
                  </div>
                </div>
                <p className="text-xs text-gray-400 mt-2">
                  Sync: {ch.lastSyncStatus || "Never"}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── AU.7: Amazon Account Health widget ────────────────────────────────
// Surfaces rolling-30d LSR + VTR at the top of /dashboard so an
// operator sees the brand's seller-account standing the moment they
// log in. Numbers come from O.16a (computeAmazonAccountHealth) — we
// don't refetch from SP-API here; the API computes from local FBM
// Order data, which is what the on-page "ship-by impact" badges
// elsewhere already reflect.
//
// Thresholds match the service constants:
//   LSR ≥ 10% → red (Amazon ACTION threshold)
//   LSR ≥  4% → yellow (Amazon WARNING)
//   VTR < 95% → red (Amazon REQUIREMENT)
type AccountHealth = {
  windowStart: string
  windowEnd: string
  shippedOrders: number
  lateShipments: number
  lsr: number
  lsrTier: 'green' | 'yellow' | 'red'
  ordersWithTracking: number
  vtr: number
  vtrTier: 'green' | 'red'
}
function AccountHealthWidget() {
  const [data, setData] = useState<AccountHealth | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/amazon/account-health`,
          { cache: 'no-store' },
        )
        if (!res.ok) throw new Error(await res.text())
        const json = (await res.json()) as AccountHealth
        if (!cancelled) setData(json)
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? 'failed')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const tierBg = (tier: 'green' | 'yellow' | 'red') =>
    tier === 'green'
      ? 'bg-emerald-50 border-emerald-200'
      : tier === 'yellow'
        ? 'bg-amber-50 border-amber-200'
        : 'bg-rose-50 border-rose-200'
  const tierText = (tier: 'green' | 'yellow' | 'red') =>
    tier === 'green'
      ? 'text-emerald-700'
      : tier === 'yellow'
        ? 'text-amber-700'
        : 'text-rose-700'

  return (
    <div className="bg-white rounded-lg shadow border border-gray-200">
      <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">
          🇮🇹 Amazon Account Health (rolling 30d)
        </h3>
        <Link
          href="/orders?lens=ship-by"
          className="text-xs text-blue-600 hover:underline"
        >
          See orders at risk →
        </Link>
      </div>
      {loading ? (
        <div className="p-5 text-sm text-gray-500">Loading…</div>
      ) : error ? (
        <div className="p-5 text-sm text-rose-600">
          Failed to load: {error}
        </div>
      ) : !data ? null : (
        <div className="p-5 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div
            className={`border rounded-lg p-3 ${tierBg(data.lsrTier)}`}
            title="Late Shipment Rate. Amazon action threshold ≥10%, warning ≥4%."
          >
            <div className="text-xs text-gray-600">LSR (Late Shipment Rate)</div>
            <div className={`text-2xl font-semibold ${tierText(data.lsrTier)}`}>
              {(data.lsr * 100).toFixed(2)}%
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {data.lateShipments} late / {data.shippedOrders} shipped
            </div>
          </div>
          <div
            className={`border rounded-lg p-3 ${tierBg(data.vtrTier)}`}
            title="Valid Tracking Rate. Amazon requires ≥95%."
          >
            <div className="text-xs text-gray-600">VTR (Valid Tracking Rate)</div>
            <div className={`text-2xl font-semibold ${tierText(data.vtrTier)}`}>
              {(data.vtr * 100).toFixed(2)}%
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {data.ordersWithTracking} tracked / {data.shippedOrders} shipped
            </div>
          </div>
          <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
            <div className="text-xs text-gray-600">Window</div>
            <div className="text-sm font-medium text-gray-900 mt-1">
              {new Date(data.windowStart).toLocaleDateString()} →{' '}
              {new Date(data.windowEnd).toLocaleDateString()}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              Buy Shipping auto-credits VTR.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
