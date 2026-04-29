"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import {
  Search,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ChevronsUpDown,
  Package,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  Trash2,
  CheckSquare,
  Square,
  Minus,
  ShoppingCart,
  Boxes,
  Clock,
  X,
  Layers,
} from "lucide-react";

/* ─────────────────────────────────────────────────────────────
   Types
───────────────────────────────────────────────────────────────*/
interface Product {
  id: string;
  sku: string;
  name: string;
  basePrice: string | number;
  totalStock: number;
  lowStockThreshold: number;
  amazonAsin: string | null;
  ebayItemId: string | null;
  syncChannels: string[];
  status: string;
  brand: string | null;
  isParent: boolean;
  parentId: string | null;
  variationTheme: string | null;
  categoryAttributes: Record<string, string> | null;
  marketplace?: string | null;
  images?: Array<{ url: string; type: string }>;
  createdAt: string;
  updatedAt: string;
}

interface GroupedProduct extends Product {
  children: Product[];
}

type Channel = "ALL" | "AMAZON" | "EBAY";
type StockFilter = "ALL" | "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";
type SortField = "name" | "sku" | "price" | "stock";
type SortDir = "asc" | "desc";

/* ─────────────────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────────────────────*/
function getAmazonUrl(asin: string, marketplace?: string | null): string {
  const domain = marketplace?.includes("DE")
    ? "amazon.de"
    : marketplace?.includes("UK")
    ? "amazon.co.uk"
    : marketplace?.includes("FR")
    ? "amazon.fr"
    : marketplace?.includes("ES")
    ? "amazon.es"
    : marketplace?.includes("US")
    ? "amazon.com"
    : "amazon.it";
  return `https://www.${domain}/dp/${asin}`;
}

function formatPrice(val: string | number): string {
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

function getStockStatus(stock: number, threshold: number) {
  if (stock <= 0) return "out";
  if (stock <= threshold) return "low";
  return "in";
}

function parseVariantAttributes(
  categoryAttributes: Record<string, string> | null,
  variationTheme: string | null
): Array<{ key: string; value: string }> {
  if (!categoryAttributes) return [];
  const themeKeys = variationTheme
    ? variationTheme.split(/(?=[A-Z])/).map((k) => k.trim())
    : null;
  const entries = Object.entries(categoryAttributes);
  if (!entries.length) return [];
  // Prefer theme keys if available, otherwise show all
  const relevant = themeKeys
    ? entries.filter(([k]) =>
        themeKeys.some((t) => k.toLowerCase().includes(t.toLowerCase()))
      )
    : entries.slice(0, 4);
  return (relevant.length ? relevant : entries.slice(0, 4)).map(
    ([key, value]) => ({ key, value: String(value) })
  );
}

/* ─────────────────────────────────────────────────────────────
   Sub-components
───────────────────────────────────────────────────────────────*/
function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ElementType;
  label: string;
  value: React.ReactNode;
  sub?: string;
  accent: "blue" | "green" | "amber" | "slate";
}) {
  const map = {
    blue:  { bg: "bg-blue-50",    icon: "bg-blue-100 text-blue-600",     text: "text-blue-700"    },
    green: { bg: "bg-emerald-50", icon: "bg-emerald-100 text-emerald-600", text: "text-emerald-700" },
    amber: { bg: "bg-amber-50",   icon: "bg-amber-100 text-amber-600",   text: "text-amber-700"   },
    slate: { bg: "bg-slate-50",   icon: "bg-slate-100 text-slate-600",   text: "text-slate-700"   },
  };
  const c = map[accent];
  return (
    <div className={`${c.bg} rounded-xl border border-white shadow-sm p-5 flex items-start gap-4`}>
      <div className={`${c.icon} rounded-lg p-2.5 flex-shrink-0`}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">{label}</p>
        <p className={`text-2xl font-bold ${c.text} leading-none`}>{value}</p>
        {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: "in" | "low" | "out" }) {
  if (status === "in")
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        In Stock
      </span>
    );
  if (status === "low")
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        Low Stock
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700 border border-red-200">
      <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
      Out of Stock
    </span>
  );
}

function ProductStatusBadge({ status }: { status: string }) {
  if (status === "ACTIVE")
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
        Active
      </span>
    );
  if (status === "DRAFT")
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
        Draft
      </span>
    );
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-400">
      {status}
    </span>
  );
}

function ImagePlaceholder({ small = false }: { small?: boolean }) {
  return (
    <div
      className={`${
        small ? "w-8 h-8" : "w-10 h-10"
      } rounded-lg bg-gray-100 border border-gray-200 flex items-center justify-center flex-shrink-0`}
    >
      <Package className={`${small ? "w-3 h-3" : "w-4 h-4"} text-gray-300`} />
    </div>
  );
}

function SkeletonRow() {
  return (
    <tr className="border-b border-gray-100">
      {[...Array(9)].map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-4 bg-gray-100 rounded animate-pulse w-full max-w-[120px]" />
        </td>
      ))}
    </tr>
  );
}

function SortIcon({ field, active, dir }: { field: SortField; active: SortField; dir: SortDir }) {
  if (field !== active)
    return <ChevronsUpDown className="w-3.5 h-3.5 text-gray-300 ml-1 inline" />;
  return dir === "asc" ? (
    <ChevronUp className="w-3.5 h-3.5 text-blue-500 ml-1 inline" />
  ) : (
    <ChevronDown className="w-3.5 h-3.5 text-blue-500 ml-1 inline" />
  );
}

function VariantAttributeChips({
  attrs,
}: {
  attrs: Array<{ key: string; value: string }>;
}) {
  if (!attrs.length) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-0.5">
      {attrs.map(({ key, value }) => (
        <span
          key={key}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-indigo-50 text-indigo-700 border border-indigo-100 rounded text-[10px] font-medium"
        >
          <span className="text-indigo-400">{key}:</span>
          {value}
        </span>
      ))}
    </div>
  );
}

function ActionsCell({
  product,
  compact = false,
}: {
  product: Product;
  compact?: boolean;
}) {
  return (
    <div className={`flex items-center justify-end gap-1.5 ${compact ? "opacity-0 group-hover:opacity-100 transition-opacity" : ""}`}>
      <button
        disabled
        title="eBay integration coming soon"
        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-400 bg-gray-100 border border-gray-200 rounded-lg cursor-not-allowed opacity-70"
      >
        <ShoppingCart className="w-3 h-3" />
        eBay
      </button>
      {product.amazonAsin ? (
        <a
          href={getAmazonUrl(product.amazonAsin, product.marketplace)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
        >
          <ExternalLink className="w-3 h-3" />
          Amazon
        </a>
      ) : (
        <span className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-300 bg-gray-50 border border-gray-100 rounded-lg cursor-not-allowed">
          <ExternalLink className="w-3 h-3" />
          Amazon
        </span>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Main Page
───────────────────────────────────────────────────────────────*/
export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  // Filter / sort
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState<Channel>("ALL");
  const [stockFilter, setStockFilter] = useState<StockFilter>("ALL");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Selection + expand
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  /* ── Fetch ────────────────────────────────────────────────── */
  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        "https://nexusapi-production-b7bb.up.railway.app/api/amazon/products/list",
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setProducts(data.products ?? []);
      setLastFetch(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load products");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  /* ── Derived stats ────────────────────────────────────────── */
  const stats = useMemo(() => {
    const total = products.length;
    const ebayCount = products.filter((p) => p.syncChannels?.includes("EBAY")).length;
    const lowStockCount = products.filter((p) => {
      const s = getStockStatus(p.totalStock, p.lowStockThreshold ?? 10);
      return s === "low" || s === "out";
    }).length;
    const parentCount = products.filter((p) => p.isParent).length;
    return { total, ebayCount, lowStockCount, parentCount };
  }, [products]);

  /* ── Group + filter + sort ────────────────────────────────── */
  const { filteredGroups, autoExpanded } = useMemo(() => {
    // Build child map
    const childMap = new Map<string, Product[]>();
    for (const p of products) {
      if (p.parentId) {
        const arr = childMap.get(p.parentId) ?? [];
        arr.push(p);
        childMap.set(p.parentId, arr);
      }
    }

    // Top-level: products without a parentId
    const topLevel = products.filter((p) => !p.parentId);

    // Attach children
    const groups: GroupedProduct[] = topLevel.map((p) => ({
      ...p,
      children: childMap.get(p.id) ?? [],
    }));

    // Filter predicate
    const matchesFilters = (p: Product): boolean => {
      if (search.trim()) {
        const q = search.toLowerCase();
        const hit =
          p.sku?.toLowerCase().includes(q) ||
          p.name?.toLowerCase().includes(q) ||
          (p.amazonAsin?.toLowerCase().includes(q) ?? false);
        if (!hit) return false;
      }
      if (channel !== "ALL" && !p.syncChannels?.includes(channel)) return false;
      if (stockFilter !== "ALL") {
        const s = getStockStatus(p.totalStock, p.lowStockThreshold ?? 10);
        if (stockFilter === "IN_STOCK" && s !== "in") return false;
        if (stockFilter === "LOW_STOCK" && s !== "low") return false;
        if (stockFilter === "OUT_OF_STOCK" && s !== "out") return false;
      }
      return true;
    };

    // Track which groups should auto-expand (child matched but parent didn't)
    const autoExpanded = new Set<string>();

    const result = groups
      .filter((g) => {
        const parentMatches = matchesFilters(g);
        const matchingChildren = g.children.filter(matchesFilters);
        if (!parentMatches && matchingChildren.length === 0) return false;
        if (!parentMatches && matchingChildren.length > 0) {
          autoExpanded.add(g.id);
        }
        return true;
      })
      .sort((a, b) => {
        let av: string | number = "";
        let bv: string | number = "";
        if (sortField === "name") { av = a.name?.toLowerCase() ?? ""; bv = b.name?.toLowerCase() ?? ""; }
        else if (sortField === "sku") { av = a.sku?.toLowerCase() ?? ""; bv = b.sku?.toLowerCase() ?? ""; }
        else if (sortField === "price") { av = parseFloat(String(a.basePrice)) || 0; bv = parseFloat(String(b.basePrice)) || 0; }
        else if (sortField === "stock") { av = a.totalStock; bv = b.totalStock; }
        if (av < bv) return sortDir === "asc" ? -1 : 1;
        if (av > bv) return sortDir === "asc" ? 1 : -1;
        return 0;
      });

    return { filteredGroups: result, autoExpanded };
  }, [products, search, channel, stockFilter, sortField, sortDir]);

  /* ── Expand helpers ────────────────────────────────────────── */
  const isExpanded = (id: string) => expandedIds.has(id) || autoExpanded.has(id);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      // If auto-expanded, collapsing means explicitly adding to "collapsed" set
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /* ── Selection helpers ─────────────────────────────────────── */
  const allTopIds = filteredGroups.map((g) => g.id);
  const allSelected =
    allTopIds.length > 0 && allTopIds.every((id) => selected.has(id));
  const someSelected =
    allTopIds.some((id) => selected.has(id)) && !allSelected;

  const toggleAll = () => {
    if (allSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        allTopIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        allTopIds.forEach((id) => next.add(id));
        return next;
      });
    }
  };

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  /* ── Sort handler ──────────────────────────────────────────── */
  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("asc"); }
  };

  const selectedCount = selected.size;

  /* ── Expand all / collapse all ─────────────────────────────── */
  const hasAnyParent = filteredGroups.some((g) => g.children.length > 0);
  const allExpanded = filteredGroups
    .filter((g) => g.children.length > 0)
    .every((g) => isExpanded(g.id));

  const toggleAllExpanded = () => {
    if (allExpanded) {
      setExpandedIds(new Set());
    } else {
      setExpandedIds(
        new Set(
          filteredGroups.filter((g) => g.children.length > 0).map((g) => g.id)
        )
      );
    }
  };

  /* ─────────────────────────────────────────────────────────── */
  return (
    <div className="space-y-6">
      {/* ── Page header ───────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Products</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Manage your catalog across all channels
          </p>
        </div>
        <button
          onClick={fetchProducts}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-white border border-gray-300 text-gray-700 rounded-lg shadow-sm hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* ── Hero metrics ──────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          icon={Boxes}
          label="Total Products"
          value={loading ? "—" : stats.total.toLocaleString()}
          sub={loading ? "" : `${stats.parentCount} parent${stats.parentCount !== 1 ? "s" : ""} with variants`}
          accent="blue"
        />
        <MetricCard
          icon={ShoppingCart}
          label="Synced to eBay"
          value={loading ? "—" : stats.ebayCount.toLocaleString()}
          sub="Active listings"
          accent="green"
        />
        <MetricCard
          icon={AlertTriangle}
          label="Low / Out of Stock"
          value={loading ? "—" : stats.lowStockCount.toLocaleString()}
          sub="Needs attention"
          accent="amber"
        />
        <MetricCard
          icon={Clock}
          label="Last Sync"
          value={
            lastFetch
              ? lastFetch.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : "—"
          }
          sub={lastFetch ? lastFetch.toLocaleDateString() : "Never"}
          accent="slate"
        />
      </div>

      {/* ── Filter bar ────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by SKU, name, or ASIN…"
              className="w-full pl-9 pr-8 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50 placeholder:text-gray-400 transition"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as Channel)}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50 text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
            >
              <option value="ALL">All Channels</option>
              <option value="AMAZON">Amazon</option>
              <option value="EBAY">eBay</option>
            </select>
            <select
              value={stockFilter}
              onChange={(e) => setStockFilter(e.target.value as StockFilter)}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50 text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
            >
              <option value="ALL">All Stock</option>
              <option value="IN_STOCK">In Stock</option>
              <option value="LOW_STOCK">Low Stock</option>
              <option value="OUT_OF_STOCK">Out of Stock</option>
            </select>
            <select
              value={`${sortField}-${sortDir}`}
              onChange={(e) => {
                const [f, d] = e.target.value.split("-");
                setSortField(f as SortField);
                setSortDir(d as SortDir);
              }}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50 text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
            >
              <option value="name-asc">Name A→Z</option>
              <option value="name-desc">Name Z→A</option>
              <option value="price-desc">Price ↓</option>
              <option value="price-asc">Price ↑</option>
              <option value="stock-desc">Stock ↓</option>
              <option value="stock-asc">Stock ↑</option>
              <option value="sku-asc">SKU A→Z</option>
            </select>
          </div>
        </div>

        {(search || channel !== "ALL" || stockFilter !== "ALL") && (
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
            <span className="text-xs text-gray-400">Filters:</span>
            {search && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-full border border-blue-100">
                "{search}"
                <button onClick={() => setSearch("")}><X className="w-3 h-3" /></button>
              </span>
            )}
            {channel !== "ALL" && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-full border border-blue-100">
                {channel}
                <button onClick={() => setChannel("ALL")}><X className="w-3 h-3" /></button>
              </span>
            )}
            {stockFilter !== "ALL" && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-full border border-blue-100">
                {stockFilter.replace(/_/g, " ")}
                <button onClick={() => setStockFilter("ALL")}><X className="w-3 h-3" /></button>
              </span>
            )}
            <span className="text-xs text-gray-400 ml-auto">
              {filteredGroups.length} result{filteredGroups.length !== 1 ? "s" : ""}
            </span>
          </div>
        )}
      </div>

      {/* ── Bulk actions ──────────────────────────────────────── */}
      {selectedCount > 0 && (
        <div className="bg-blue-600 text-white rounded-xl px-5 py-3 flex items-center gap-4 shadow-lg shadow-blue-200">
          <span className="text-sm font-medium">
            {selectedCount} product{selectedCount !== 1 ? "s" : ""} selected
          </span>
          <div className="flex items-center gap-2 ml-auto">
            <button
              disabled
              title="eBay integration coming soon"
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-white/20 rounded-lg opacity-60 cursor-not-allowed"
            >
              <ShoppingCart className="w-3.5 h-3.5" />
              List on eBay
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-red-500 hover:bg-red-600 rounded-lg transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete selected
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="ml-2 text-white/70 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ── Error state ───────────────────────────────────────── */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-red-800">Failed to load products</p>
            <p className="text-xs text-red-600 mt-0.5">{error}</p>
            <button
              onClick={fetchProducts}
              className="mt-2 text-xs font-medium text-red-700 underline hover:no-underline"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {/* ── Table ─────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {/* Toolbar */}
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between gap-4">
          <span className="text-sm text-gray-500">
            {loading ? (
              <span className="inline-block w-20 h-4 bg-gray-100 rounded animate-pulse" />
            ) : (
              <>
                <span className="font-semibold text-gray-900">
                  {filteredGroups.length.toLocaleString()}
                </span>{" "}
                product{filteredGroups.length !== 1 ? "s" : ""}
                {products.length !== filteredGroups.length && (
                  <span className="text-gray-400">
                    {" "}of {products.length.toLocaleString()} total
                  </span>
                )}
              </>
            )}
          </span>
          <div className="flex items-center gap-3">
            {selectedCount > 0 && (
              <span className="text-xs text-blue-600 font-medium">
                {selectedCount} selected
              </span>
            )}
            {!loading && hasAnyParent && (
              <button
                onClick={toggleAllExpanded}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-500 hover:text-gray-800 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg transition-colors"
              >
                <Layers className="w-3.5 h-3.5" />
                {allExpanded ? "Collapse all" : "Expand all"}
              </button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="px-4 py-3 w-10">
                  <button
                    onClick={toggleAll}
                    className="flex items-center justify-center text-gray-400 hover:text-gray-600"
                  >
                    {allSelected ? (
                      <CheckSquare className="w-4 h-4 text-blue-600" />
                    ) : someSelected ? (
                      <Minus className="w-4 h-4 text-blue-600" />
                    ) : (
                      <Square className="w-4 h-4" />
                    )}
                  </button>
                </th>
                {/* Expand chevron column */}
                <th className="px-2 py-3 w-8" />
                <th className="px-4 py-3 w-14 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Img
                </th>
                <th
                  className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:text-gray-900 whitespace-nowrap"
                  onClick={() => handleSort("sku")}
                >
                  SKU
                  <SortIcon field="sku" active={sortField} dir={sortDir} />
                </th>
                <th
                  className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:text-gray-900 min-w-[200px]"
                  onClick={() => handleSort("name")}
                >
                  Name
                  <SortIcon field="name" active={sortField} dir={sortDir} />
                </th>
                <th
                  className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:text-gray-900 whitespace-nowrap"
                  onClick={() => handleSort("price")}
                >
                  Price
                  <SortIcon field="price" active={sortField} dir={sortDir} />
                </th>
                <th
                  className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:text-gray-900 whitespace-nowrap"
                  onClick={() => handleSort("stock")}
                >
                  Stock
                  <SortIcon field="stock" active={sortField} dir={sortDir} />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                  ASIN
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>

            <tbody>
              {loading ? (
                [...Array(8)].map((_, i) => <SkeletonRow key={i} />)
              ) : filteredGroups.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-16 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
                        <Package className="w-6 h-6 text-gray-300" />
                      </div>
                      <p className="text-sm font-medium text-gray-500">No products found</p>
                      <p className="text-xs text-gray-400">Try adjusting your filters</p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredGroups.map((group) => {
                  const hasChildren = group.children.length > 0;
                  const expanded = isExpanded(group.id);
                  const isSelected = selected.has(group.id);
                  const stockStatus = getStockStatus(
                    group.totalStock,
                    group.lowStockThreshold ?? 10
                  );

                  return (
                    <>
                      {/* ── Parent / standalone row ─────────────── */}
                      <tr
                        key={group.id}
                        className={`group border-b transition-colors ${
                          isSelected
                            ? "bg-blue-50 border-blue-100"
                            : expanded && hasChildren
                            ? "bg-gray-50/80 border-gray-100"
                            : "border-gray-50 hover:bg-gray-50/60"
                        }`}
                      >
                        {/* Checkbox */}
                        <td className="px-4 py-3">
                          <button
                            onClick={() => toggleRow(group.id)}
                            className="flex items-center justify-center text-gray-300 hover:text-gray-500"
                          >
                            {isSelected ? (
                              <CheckSquare className="w-4 h-4 text-blue-600" />
                            ) : (
                              <Square className="w-4 h-4" />
                            )}
                          </button>
                        </td>

                        {/* Expand chevron */}
                        <td className="px-2 py-3 w-8">
                          {hasChildren ? (
                            <button
                              onClick={() => toggleExpand(group.id)}
                              className="flex items-center justify-center w-6 h-6 rounded hover:bg-gray-200 transition-colors text-gray-400 hover:text-gray-700"
                              title={expanded ? "Collapse variants" : "Expand variants"}
                            >
                              <ChevronRight
                                className={`w-4 h-4 transition-transform duration-200 ${
                                  expanded ? "rotate-90" : ""
                                }`}
                              />
                            </button>
                          ) : (
                            <div className="w-6" />
                          )}
                        </td>

                        {/* Image */}
                        <td className="px-4 py-3">
                          <ImagePlaceholder />
                        </td>

                        {/* SKU */}
                        <td className="px-4 py-3">
                          <span className="font-mono text-xs text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">
                            {group.sku}
                          </span>
                        </td>

                        {/* Name */}
                        <td className="px-4 py-3">
                          <Link
                            href={`/products/${group.id}`}
                            className={`${
                              hasChildren ? "font-semibold" : "font-medium"
                            } text-gray-900 hover:text-blue-600 transition-colors line-clamp-2`}
                          >
                            {group.name}
                          </Link>
                          <div className="flex items-center gap-2 mt-0.5">
                            {group.brand && (
                              <span className="text-xs text-gray-400">{group.brand}</span>
                            )}
                            {hasChildren && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-indigo-50 text-indigo-600 border border-indigo-100 rounded text-[10px] font-semibold">
                                <Layers className="w-2.5 h-2.5" />
                                {group.children.length} variant{group.children.length !== 1 ? "s" : ""}
                              </span>
                            )}
                            {group.variationTheme && (
                              <span className="text-[10px] text-gray-400">
                                by {group.variationTheme}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Price */}
                        <td className="px-4 py-3 text-right">
                          {hasChildren ? (
                            <span className="text-xs text-gray-400 italic">varies</span>
                          ) : (
                            <span className="font-semibold text-gray-900 tabular-nums">
                              {formatPrice(group.basePrice)}
                            </span>
                          )}
                        </td>

                        {/* Stock */}
                        <td className="px-4 py-3 text-right">
                          {hasChildren ? (
                            <div className="text-right">
                              <span className="font-semibold text-gray-900 tabular-nums">
                                {group.totalStock.toLocaleString()}
                              </span>
                              <p className="text-[10px] text-gray-400">total</p>
                            </div>
                          ) : (
                            <span
                              className={`font-semibold tabular-nums ${
                                stockStatus === "out"
                                  ? "text-red-600"
                                  : stockStatus === "low"
                                  ? "text-amber-600"
                                  : "text-gray-900"
                              }`}
                            >
                              {group.totalStock.toLocaleString()}
                            </span>
                          )}
                        </td>

                        {/* ASIN */}
                        <td className="px-4 py-3">
                          {group.amazonAsin ? (
                            <span className="font-mono text-xs text-gray-600">
                              {group.amazonAsin}
                            </span>
                          ) : (
                            <span className="text-gray-300 text-xs">—</span>
                          )}
                        </td>

                        {/* Status */}
                        <td className="px-4 py-3">
                          <div className="flex flex-col gap-1">
                            <ProductStatusBadge status={group.status} />
                            {!hasChildren && <StatusBadge status={stockStatus} />}
                          </div>
                        </td>

                        {/* Actions */}
                        <td className="px-4 py-3">
                          <ActionsCell product={group} />
                        </td>
                      </tr>

                      {/* ── Child rows ─────────────────────────────── */}
                      {hasChildren &&
                        expanded &&
                        group.children.map((child, idx) => {
                          const childStockStatus = getStockStatus(
                            child.totalStock,
                            child.lowStockThreshold ?? 10
                          );
                          const attrs = parseVariantAttributes(
                            child.categoryAttributes,
                            group.variationTheme
                          );
                          const isLast = idx === group.children.length - 1;

                          return (
                            <tr
                              key={child.id}
                              className={`group bg-slate-50/60 hover:bg-slate-50 transition-colors ${
                                isLast ? "border-b-2 border-indigo-100" : "border-b border-slate-100"
                              }`}
                            >
                              {/* Checkbox (child) */}
                              <td className="px-4 py-2.5" />

                              {/* Indent indicator */}
                              <td className="px-2 py-2.5">
                                <div className="flex items-center justify-center">
                                  <div className="w-px h-4 bg-indigo-200 mx-auto" />
                                </div>
                              </td>

                              {/* Image */}
                              <td className="px-4 py-2.5">
                                <div className="ml-2">
                                  <ImagePlaceholder small />
                                </div>
                              </td>

                              {/* SKU */}
                              <td className="px-4 py-2.5 pl-6">
                                <span className="font-mono text-xs text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-100">
                                  {child.sku}
                                </span>
                              </td>

                              {/* Name + attributes */}
                              <td className="px-4 py-2.5 pl-6">
                                <Link
                                  href={`/products/${child.id}`}
                                  className="text-sm text-gray-700 hover:text-blue-600 transition-colors"
                                >
                                  {child.name}
                                </Link>
                                {attrs.length > 0 ? (
                                  <VariantAttributeChips attrs={attrs} />
                                ) : null}
                              </td>

                              {/* Price */}
                              <td className="px-4 py-2.5 text-right">
                                <span className="font-medium text-gray-800 tabular-nums text-sm">
                                  {formatPrice(child.basePrice)}
                                </span>
                              </td>

                              {/* Stock */}
                              <td className="px-4 py-2.5 text-right">
                                <span
                                  className={`font-medium tabular-nums text-sm ${
                                    childStockStatus === "out"
                                      ? "text-red-600"
                                      : childStockStatus === "low"
                                      ? "text-amber-600"
                                      : "text-gray-800"
                                  }`}
                                >
                                  {child.totalStock.toLocaleString()}
                                </span>
                              </td>

                              {/* ASIN */}
                              <td className="px-4 py-2.5">
                                {child.amazonAsin ? (
                                  <span className="font-mono text-xs text-gray-500">
                                    {child.amazonAsin}
                                  </span>
                                ) : (
                                  <span className="text-gray-300 text-xs">—</span>
                                )}
                              </td>

                              {/* Status */}
                              <td className="px-4 py-2.5">
                                <StatusBadge status={childStockStatus} />
                              </td>

                              {/* Actions */}
                              <td className="px-4 py-2.5">
                                <ActionsCell product={child} compact />
                              </td>
                            </tr>
                          );
                        })}
                    </>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        {!loading && filteredGroups.length > 0 && (
          <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between bg-gray-50/50">
            <span className="text-xs text-gray-400">
              Showing {filteredGroups.length.toLocaleString()} of{" "}
              {products.length.toLocaleString()} products
            </span>
            <span className="text-xs text-gray-400">
              {lastFetch
                ? `Updated ${lastFetch.toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}`
                : ""}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
