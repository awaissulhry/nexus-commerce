"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { getBackendUrl } from "@/lib/backend-url";

const BACKEND_URL = getBackendUrl();
import type { InventoryItem } from "@/types/inventory";
import InventoryTable from "@/components/inventory/InventoryTable";
import InventoryDrawer from "@/components/inventory/InventoryDrawer";
import { SyncTriggerButton } from "@/components/inventory/SyncTriggerButton";
import { SyncStatusModal } from "@/components/inventory/SyncStatusModal";
import { MarketplaceActionsDropdown } from "@/components/catalog/MarketplaceActionsDropdown";

type FilterTab = "All" | "Fix" | "Optimise";

const TABS: FilterTab[] = ["All", "Fix", "Optimise"];

interface ManageInventoryClientProps {
  data: InventoryItem[];
}

export default function ManageInventoryClient({
  data,
}: ManageInventoryClientProps) {
  const [activeTab, setActiveTab] = useState<FilterTab>("All");
  const [search, setSearch] = useState("");
  const [drawerItem, setDrawerItem] = useState<InventoryItem | null>(null);
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [currentSyncId, setCurrentSyncId] = useState<string | null>(null);

  // ── Filter to only top-level products (parents and standalones) ──
  // Children are nested in subRows, not rendered as separate rows
  const hierarchicalData = data.filter(p => p.parentId === null || p.parentId === undefined);

  // Compute counts per tab (based on top-level items only)
  const counts = useMemo(() => {
    const c: Record<FilterTab, number> = {
      All: hierarchicalData.length,
      Fix: 0,
      Optimise: 0,
    };

    for (const item of hierarchicalData) {
      // Fix: items with status === 'Out of Stock' or missing critical data
      if (item.status === "Out of Stock" || !item.asin || item.stock === 0) {
        c.Fix++;
      }
      // Optimise: items with potential (inverse of Fix)
      else {
        c.Optimise++;
      }
    }

    return c;
  }, [hierarchicalData]);

  // Filter data by tab + search
  const filtered = useMemo(() => {
    let items = hierarchicalData;

    // Tab filter
    if (activeTab === "Fix") {
      items = items.filter(
        (item) =>
          item.status === "Out of Stock" ||
          !item.asin ||
          item.stock === 0
      );
    } else if (activeTab === "Optimise") {
      items = items.filter(
        (item) =>
          item.status !== "Out of Stock" &&
          item.asin &&
          item.stock > 0
      );
    }

    // Search filter (matches SKU, name, or ASIN)
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(
        (item) =>
          item.sku.toLowerCase().includes(q) ||
          item.name.toLowerCase().includes(q) ||
          (item.asin && item.asin.toLowerCase().includes(q))
      );
    }

    return items;
  }, [hierarchicalData, activeTab, search]);

  return (
    <div className="space-y-4">
      {/* ── Amazon Top Links ────────────────────────────────────────── */}
      <div className="flex items-center gap-4 text-[13px] text-[#007185] font-medium">
        <button className="hover:text-[#0066a1] transition-colors">
          Manage products
        </button>
        <span className="text-gray-300">|</span>
        <button className="hover:text-[#0066a1] transition-colors">
          Manage compliance
        </button>
        <span className="text-gray-300">|</span>
        <button className="hover:text-[#0066a1] transition-colors">
          View selling applications
        </button>
        <span className="text-gray-300">|</span>
        <Link
          href="/catalog/add"
          className="hover:text-[#0066a1] transition-colors"
        >
          Add product
        </Link>
        <span className="text-gray-300">|</span>
        <Link
          href="/catalog/drafts"
          className="hover:text-[#0066a1] transition-colors"
        >
          📝 Complete Your Drafts
        </Link>
      </div>

      {/* ── Search & Filter Toolbar ─────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 bg-white rounded-md border border-slate-200 p-3">
        {/* Search Input */}
        <div className="flex-1 relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search SKU, name, or ASIN…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-1.5 text-xs border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent tracking-tight"
          />
        </div>

        {/* Stats */}
        <div className="text-xs text-slate-500 font-medium tracking-tight">
          {filtered.length} of {hierarchicalData.length} products
        </div>

        {/* Marketplace Actions Dropdown */}
        <MarketplaceActionsDropdown
          onImportAmazon={async () => {
            try {
              const response = await fetch(`${BACKEND_URL}/api/catalog/amazon/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              });
              
              const text = await response.text();
              
              if (response.ok) {
                const data = JSON.parse(text);
                alert(`✅ Successfully imported ${data.data.total} products from Amazon!`);
                window.location.reload();
              } else {
                const error = JSON.parse(text);
                alert(`❌ Import failed: ${error.error?.message || error.message || 'Unknown error'}`);
              }
            } catch (error) {
              console.error('Import error:', error);
              alert(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
          }}
          onImportEbay={async () => {
            try {
              const response = await fetch(`${BACKEND_URL}/api/catalog/ebay/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              });
              
              const text = await response.text();
              
              if (response.ok) {
                const data = JSON.parse(text);
                alert(`✅ Successfully imported ${data.data.total} products from eBay!`);
                window.location.reload();
              } else {
                const error = JSON.parse(text);
                alert(`❌ Import failed: ${error.error?.message || error.message || 'Unknown error'}`);
              }
            } catch (error) {
              console.error('Import error:', error);
              alert(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
          }}
          onSyncAll={async () => {
            try {
              const response = await fetch(`${BACKEND_URL}/api/catalog/sync/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetChannel: 'ALL' }),
              });
              
              const text = await response.text();
              
              if (response.ok) {
                const data = JSON.parse(text);
                alert(`✅ Sync initiated! ${data.data.queued} products queued for sync.`);
                window.location.reload();
              } else {
                const error = JSON.parse(text);
                alert(`❌ Sync failed: ${error.error?.message || error.message || 'Unknown error'}`);
              }
            } catch (error) {
              console.error('Sync error:', error);
              alert(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
          }}
        />

        {/* Sync Button */}
        <SyncTriggerButton
          onSyncStart={(syncId) => {
            setCurrentSyncId(syncId);
            setSyncModalOpen(true);
          }}
          onSyncComplete={() => {
            // Sync completed, modal will show the results
          }}
        />
      </div>

      {/* ── Amazon Filter Tabs (All | Fix | Optimise) ────────────────── */}
      <div className="flex items-center gap-6 border-b border-slate-200 bg-white px-3">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-0 py-3 text-[13px] font-medium border-b-2 transition-colors tracking-tight ${
              activeTab === tab
                ? "border-[#FF9900] text-slate-900"
                : "border-transparent text-slate-600 hover:text-slate-900"
            }`}
          >
            {tab}
            <span className="ml-2 text-[11px] text-slate-500">
              ({counts[tab]})
            </span>
          </button>
        ))}
      </div>

      {/* ── Table ─────────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 bg-white rounded-md border border-slate-200">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <svg
              className="w-7 h-7 text-slate-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
              />
            </svg>
          </div>
          <h3 className="text-sm font-semibold text-slate-900 mb-1 tracking-tight">
            No products found
          </h3>
          <p className="text-xs text-slate-500 mb-6">
            {search
              ? "Try adjusting your search criteria"
              : "Get started by adding your first product"}
          </p>
          <button className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors tracking-tight">
            ➕ Add Product
          </button>
        </div>
      ) : (
        <InventoryTable data={filtered} onEditItem={setDrawerItem} />
      )}

      {/* ── Fly-out Editor Drawer ─────────────────────────────────── */}
      <InventoryDrawer
        item={drawerItem}
        onClose={() => setDrawerItem(null)}
      />

      {/* ── Sync Status Modal ─────────────────────────────────────── */}
      <SyncStatusModal
        isOpen={syncModalOpen}
        syncId={currentSyncId || undefined}
        onClose={() => {
          setSyncModalOpen(false);
          setCurrentSyncId(null);
        }}
        onRetry={(syncId) => {
          // Handle retry logic
          console.log('Retrying sync:', syncId);
        }}
      />
    </div>
  );
}
