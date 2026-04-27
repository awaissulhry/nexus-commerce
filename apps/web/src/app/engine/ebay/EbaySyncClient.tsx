"use client";

import { useState, useMemo } from "react";
import { triggerFullSync, triggerAmazonCatalogSync } from "./actions";
import FilterBar from "@/components/shared/FilterBar";
import ExportButton from "@/components/shared/ExportButton";
import type { EbaySyncProduct } from "./page";

interface EbaySyncClientProps {
  products: EbaySyncProduct[];
  stats: {
    totalProducts: number;
    linkedToEbay: number;
    pendingSync: number;
    failedSync: number;
  };
}

type TabKey = "all" | "linked" | "pending" | "failed";

export default function EbaySyncClient({ products, stats }: EbaySyncClientProps) {
  const [tab, setTab] = useState<TabKey>("all");
  const [search, setSearch] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [catalogSyncing, setCatalogSyncing] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const tabs = [
    { value: "all", label: "All Products", count: stats.totalProducts },
    { value: "linked", label: "Linked to eBay", count: stats.linkedToEbay },
    { value: "pending", label: "Pending Sync", count: stats.pendingSync },
    { value: "failed", label: "Failed", count: stats.failedSync },
  ];

  const filtered = useMemo(() => {
    let items = products;

    if (tab === "linked") items = items.filter((p) => p.ebayItemId);
    else if (tab === "pending") items = items.filter((p) => !p.ebayItemId && p.amazonAsin);
    else if (tab === "failed") items = items.filter((p) => p.lastSyncStatus === "FAILED");

    if (search) {
      const q = search.toLowerCase();
      items = items.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q) ||
          p.amazonAsin?.toLowerCase().includes(q) ||
          p.ebayItemId?.toLowerCase().includes(q)
      );
    }

    return items;
  }, [products, tab, search]);

  const handleFullSync = async () => {
    setSyncing(true);
    setMessage(null);
    try {
      const result = await triggerFullSync();
      if (result.success) {
        setMessage({ type: "success", text: result.message || "Sync completed successfully" });
      } else {
        setMessage({ type: "error", text: result.error || "Sync failed" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to trigger sync" });
    } finally {
      setSyncing(false);
    }
  };

  const handleCatalogSync = async () => {
    setCatalogSyncing(true);
    setMessage(null);
    try {
      const result = await triggerAmazonCatalogSync();
      if (result.success) {
        const d = result.details;
        const detail = d ? ` (${d.created} created, ${d.updated} updated, ${d.enriched} enriched)` : "";
        setMessage({ type: "success", text: (result.message || "Catalog synced") + detail });
      } else {
        setMessage({ type: "error", text: result.error || "Catalog sync failed" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to trigger catalog sync" });
    } finally {
      setCatalogSyncing(false);
    }
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div>
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Total Products</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{stats.totalProducts}</p>
        </div>
        <div className="bg-white rounded-lg shadow border border-green-200 p-5">
          <p className="text-xs font-medium text-green-600 uppercase tracking-wide">Linked to eBay</p>
          <p className="text-2xl font-bold text-green-700 mt-1">{stats.linkedToEbay}</p>
        </div>
        <div className="bg-white rounded-lg shadow border border-yellow-200 p-5">
          <p className="text-xs font-medium text-yellow-600 uppercase tracking-wide">Pending Sync</p>
          <p className="text-2xl font-bold text-yellow-700 mt-1">{stats.pendingSync}</p>
        </div>
        <div className="bg-white rounded-lg shadow border border-red-200 p-5">
          <p className="text-xs font-medium text-red-600 uppercase tracking-wide">Failed</p>
          <p className="text-2xl font-bold text-red-700 mt-1">{stats.failedSync}</p>
        </div>
      </div>

      {/* Sync Actions */}
      <div className="bg-white rounded-lg shadow border border-gray-200 p-5 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Sync Actions</h3>
            <p className="text-xs text-gray-500 mt-1">
              Trigger manual sync operations. The automatic sync runs every 30 minutes.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleCatalogSync}
              disabled={catalogSyncing}
              className="px-4 py-2 text-sm font-medium bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {catalogSyncing ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Syncing Catalog…
                </span>
              ) : (
                "📥 Sync Amazon Catalog"
              )}
            </button>
            <button
              onClick={handleFullSync}
              disabled={syncing}
              className="px-4 py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {syncing ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Running Full Sync…
                </span>
              ) : (
                "🔄 Force eBay Sync"
              )}
            </button>
          </div>
        </div>

        {message && (
          <div
            className={`mt-4 px-4 py-3 rounded-lg text-sm ${
              message.type === "success"
                ? "bg-green-50 text-green-800 border border-green-200"
                : "bg-red-50 text-red-800 border border-red-200"
            }`}
          >
            {message.type === "success" ? "✅" : "❌"} {message.text}
          </div>
        )}
      </div>

      {/* Product Table */}
      <FilterBar
        tabs={tabs}
        activeTab={tab}
        onTabChange={(t) => setTab(t as TabKey)}
        onSearch={setSearch}
        searchPlaceholder="Search by name, SKU, ASIN, or eBay ID…"
        actions={
          <ExportButton
            data={filtered as unknown as Record<string, unknown>[]}
            columns={{
              sku: "SKU",
              name: "Product",
              amazonAsin: "ASIN",
              ebayItemId: "eBay ID",
              ebayTitle: "eBay Title",
              basePrice: "Price",
              totalStock: "Stock",
              lastSyncStatus: "Sync Status",
              lastSyncAt: "Last Sync",
            }}
            filename="ebay-sync-products"
          />
        }
      />

      <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden mt-4">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Product</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">SKU</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ASIN</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">eBay ID</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Price</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Stock</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Sync Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Last Sync</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-sm text-gray-500">
                    No products match the current filter.
                  </td>
                </tr>
              ) : (
                filtered.map((product) => (
                  <tr key={product.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4 text-sm font-medium text-gray-900 max-w-xs truncate">
                      {product.name}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600 font-mono">{product.sku}</td>
                    <td className="px-6 py-4 text-sm text-gray-600 font-mono">
                      {product.amazonAsin || <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-6 py-4 text-sm">
                      {product.ebayItemId ? (
                        <span className="font-mono text-green-700">{product.ebayItemId}</span>
                      ) : (
                        <span className="text-gray-400 italic">Not linked</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900 text-right font-medium">
                      ${product.basePrice.toFixed(2)}
                    </td>
                    <td className="px-6 py-4 text-sm text-right">
                      <span
                        className={
                          product.totalStock === 0
                            ? "text-red-600 font-bold"
                            : product.totalStock <= 5
                              ? "text-yellow-600 font-medium"
                              : "text-gray-700"
                        }
                      >
                        {product.totalStock}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm">
                      {product.lastSyncStatus ? (
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                            product.lastSyncStatus === "SUCCESS"
                              ? "bg-green-100 text-green-700"
                              : product.lastSyncStatus === "FAILED"
                                ? "bg-red-100 text-red-700"
                                : "bg-yellow-100 text-yellow-700"
                          }`}
                        >
                          {product.lastSyncStatus}
                        </span>
                      ) : (
                        <span className="text-gray-400 text-xs">Never synced</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-xs text-gray-500">
                      {formatDate(product.lastSyncAt)}
                    </td>
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
