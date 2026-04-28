"use client";

import { useState, useEffect } from "react";
import {
  ChevronDown,
  AlertCircle,
  Package,
  Globe,
  TrendingDown,
} from "lucide-react";

interface MarketplacePresence {
  channel: "amazon" | "ebay" | "shopify" | "etsy" | "woocommerce";
  name: string;
  icon: string;
  isActive: boolean;
  listingCount: number;
  syncStatus: "synced" | "pending" | "failed";
}

interface StockAlert {
  productId: string;
  productName: string;
  channel: string;
  currentStock: number;
  threshold: number;
  status: "low" | "out-of-stock";
}

interface MasterCatalogSidebarProps {
  onFilterChange?: (filters: FilterState) => void;
}

interface FilterState {
  marketplaces: string[];
  stockAlerts: ("low" | "out-of-stock")[];
  searchTerm: string;
}


export default function MasterCatalogSidebar({
  onFilterChange,
}: MasterCatalogSidebarProps) {
  const [marketplaces, setMarketplaces] = useState<MarketplacePresence[]>([]);
  const [stockAlerts, setStockAlerts] = useState<StockAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSections, setExpandedSections] = useState<
    Record<string, boolean>
  >({
    marketplace: true,
    stockAlerts: true,
  });
  const [filters, setFilters] = useState<FilterState>({
    marketplaces: [],
    stockAlerts: [],
    searchTerm: "",
  });

  useEffect(() => {
    fetchSidebarData();
  }, []);

  useEffect(() => {
    onFilterChange?.(filters);
  }, [filters, onFilterChange]);

  const fetchSidebarData = async () => {
    try {
      setLoading(true);

      // Fetch marketplace presence
      const mpRes = await fetch("/api/catalog/marketplace-presence");
      if (mpRes.ok) {
        const mpData = await mpRes.json();
        setMarketplaces(mpData.data.marketplaces || []);
      }

      // Fetch stock alerts
      const alertsRes = await fetch("/api/catalog/stock-alerts");
      if (alertsRes.ok) {
        const alertsData = await alertsRes.json();
        setStockAlerts(alertsData.data.alerts || []);
      }
    } catch (err) {
      console.error("Error fetching sidebar data:", err);
    } finally {
      setLoading(false);
    }
  };

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  const toggleMarketplace = (channel: string) => {
    setFilters((prev) => ({
      ...prev,
      marketplaces: prev.marketplaces.includes(channel)
        ? prev.marketplaces.filter((m) => m !== channel)
        : [...prev.marketplaces, channel],
    }));
  };

  const toggleStockAlert = (status: "low" | "out-of-stock") => {
    setFilters((prev) => ({
      ...prev,
      stockAlerts: prev.stockAlerts.includes(status)
        ? prev.stockAlerts.filter((s) => s !== status)
        : [...prev.stockAlerts, status],
    }));
  };

  const clearFilters = () => {
    setFilters({
      marketplaces: [],
      stockAlerts: [],
      searchTerm: "",
    });
  };

  const activeFilterCount =
    filters.marketplaces.length + filters.stockAlerts.length;

  const lowStockCount = stockAlerts.filter((a) => a.status === "low").length;
  const outOfStockCount = stockAlerts.filter(
    (a) => a.status === "out-of-stock"
  ).length;

  return (
    <div className="w-80 bg-white border-r border-slate-200 flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-slate-200">
        <h2 className="text-lg font-bold text-slate-900">Master Catalog</h2>
        <p className="text-xs text-slate-600 mt-1">
          Multi-channel inventory management
        </p>
      </div>

      {/* Search Bar */}
      <div className="p-4 border-b border-slate-200">
        <input
          type="text"
          placeholder="Search products..."
          value={filters.searchTerm}
          onChange={(e) =>
            setFilters((prev) => ({ ...prev, searchTerm: e.target.value }))
          }
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Active Filters Badge */}
      {activeFilterCount > 0 && (
        <div className="px-4 pt-3 pb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-slate-600">
            {activeFilterCount} filter{activeFilterCount !== 1 ? "s" : ""} active
          </span>
          <button
            onClick={clearFilters}
            className="text-xs text-blue-600 hover:text-blue-700 font-medium"
          >
            Clear
          </button>
        </div>
      )}

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Marketplace Presence Section */}
        <div className="border-b border-slate-200">
          <button
            onClick={() => toggleSection("marketplace")}
            className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-slate-600" />
              <span className="font-semibold text-slate-900">
                Marketplace Presence
              </span>
              <span className="ml-1 px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full font-medium">
                {marketplaces.filter((m) => m.isActive).length}
              </span>
            </div>
            <ChevronDown
              className={`w-4 h-4 text-slate-600 transition-transform ${
                expandedSections.marketplace ? "rotate-180" : ""
              }`}
            />
          </button>

          {expandedSections.marketplace && (
            <div className="px-4 py-3 space-y-2 bg-slate-50">
              {loading ? (
                <p className="text-sm text-slate-600">Loading...</p>
              ) : marketplaces.length > 0 ? (
                marketplaces.map((mp) => (
                  <label
                    key={mp.channel}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                      filters.marketplaces.includes(mp.channel)
                        ? "bg-blue-50 border-blue-300"
                        : "bg-white border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={filters.marketplaces.includes(mp.channel)}
                      onChange={() => toggleMarketplace(mp.channel)}
                      className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">{mp.icon}</span>
                        <span className="font-medium text-sm text-slate-900">
                          {mp.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            mp.isActive
                              ? "bg-green-100 text-green-700"
                              : "bg-slate-200 text-slate-700"
                          }`}
                        >
                          {mp.isActive ? "Active" : "Inactive"}
                        </span>
                        <span className="text-xs text-slate-600">
                          {mp.listingCount} listings
                        </span>
                      </div>
                      {mp.syncStatus !== "synced" && (
                        <div className="flex items-center gap-1 mt-1 text-xs">
                          <AlertCircle className="w-3 h-3 text-yellow-600" />
                          <span className="text-yellow-700">
                            {mp.syncStatus === "pending"
                              ? "Sync pending"
                              : "Sync failed"}
                          </span>
                        </div>
                      )}
                    </div>
                  </label>
                ))
              ) : (
                <p className="text-sm text-slate-600">
                  No marketplaces connected
                </p>
              )}
            </div>
          )}
        </div>

        {/* Stock Alerts Section */}
        <div className="border-b border-slate-200">
          <button
            onClick={() => toggleSection("stockAlerts")}
            className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <TrendingDown className="w-4 h-4 text-slate-600" />
              <span className="font-semibold text-slate-900">Stock Alerts</span>
              {(lowStockCount > 0 || outOfStockCount > 0) && (
                <span className="ml-1 px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded-full font-medium">
                  {lowStockCount + outOfStockCount}
                </span>
              )}
            </div>
            <ChevronDown
              className={`w-4 h-4 text-slate-600 transition-transform ${
                expandedSections.stockAlerts ? "rotate-180" : ""
              }`}
            />
          </button>

          {expandedSections.stockAlerts && (
            <div className="px-4 py-3 space-y-2 bg-slate-50">
              {/* Low Stock Filter */}
              <label className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 hover:border-slate-300 cursor-pointer transition-all">
                <input
                  type="checkbox"
                  checked={filters.stockAlerts.includes("low")}
                  onChange={() => toggleStockAlert("low")}
                  className="w-4 h-4 rounded border-slate-300 text-yellow-600 focus:ring-yellow-500"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Package className="w-4 h-4 text-yellow-600" />
                    <span className="font-medium text-sm text-slate-900">
                      Low Stock
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 mt-1">
                    {lowStockCount} product{lowStockCount !== 1 ? "s" : ""}
                  </p>
                </div>
              </label>

              {/* Out of Stock Filter */}
              <label className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 hover:border-slate-300 cursor-pointer transition-all">
                <input
                  type="checkbox"
                  checked={filters.stockAlerts.includes("out-of-stock")}
                  onChange={() => toggleStockAlert("out-of-stock")}
                  className="w-4 h-4 rounded border-slate-300 text-red-600 focus:ring-red-500"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-red-600" />
                    <span className="font-medium text-sm text-slate-900">
                      Out of Stock
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 mt-1">
                    {outOfStockCount} product{outOfStockCount !== 1 ? "s" : ""}
                  </p>
                </div>
              </label>

              {/* Alert Details */}
              {stockAlerts.length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-300 space-y-2 max-h-48 overflow-y-auto">
                  {stockAlerts.slice(0, 5).map((alert) => (
                    <div
                      key={`${alert.productId}-${alert.channel}`}
                      className={`p-2 rounded text-xs ${
                        alert.status === "out-of-stock"
                          ? "bg-red-100 text-red-700"
                          : "bg-yellow-100 text-yellow-700"
                      }`}
                    >
                      <p className="font-medium truncate">
                        {alert.productName}
                      </p>
                      <p className="mt-1">
                        Stock: {alert.currentStock} (threshold:{" "}
                        {alert.threshold})
                      </p>
                    </div>
                  ))}
                  {stockAlerts.length > 5 && (
                    <p className="text-xs text-slate-600 text-center py-2">
                      +{stockAlerts.length - 5} more alerts
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Quick Actions Section */}
        <div className="p-4 space-y-2">
          <h3 className="text-xs font-semibold text-slate-900 uppercase tracking-wide">
            Quick Actions
          </h3>
          <button className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors">
            Sync All Channels
          </button>
          <button className="w-full px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-sm font-medium transition-colors">
            Update Master Data
          </button>
          <button className="w-full px-4 py-2 border border-slate-300 hover:bg-slate-50 text-slate-900 rounded-lg text-sm font-medium transition-colors">
            View Sync Logs
          </button>
        </div>
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-slate-200 text-xs text-slate-600">
        <p>Last updated: {new Date().toLocaleTimeString()}</p>
      </div>
    </div>
  );
}
