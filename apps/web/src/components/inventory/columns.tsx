"use client";

import React from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { ChevronRight, ChevronDown, Loader2 } from "lucide-react";
import type { InventoryItem } from "@/types/inventory";
import Link from "next/link";

const col = createColumnHelper<InventoryItem>();

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(amount);
}

function ActionsButton({ item }: { item: InventoryItem }) {
  const [isOpen, setIsOpen] = React.useState(false);
  return (
    <div className="relative inline-block">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="inline-flex items-center gap-1 px-3 py-1.5 bg-slate-900 text-white text-[13px] font-medium rounded hover:bg-slate-800 transition-colors"
      >
        Edit
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {isOpen && (
        <div className="absolute right-0 mt-1 w-48 bg-white border border-slate-200 rounded shadow-lg z-10">
          <Link
            href={`/catalog/${item.id}/edit`}
            className="block px-4 py-2 text-[13px] text-slate-700 hover:bg-slate-50 border-b border-slate-100"
          >
            Edit Listing
          </Link>
          <Link
            href={`/products/${item.id}/edit`}
            className="block px-4 py-2 text-[13px] text-slate-700 hover:bg-slate-50 border-b border-slate-100"
          >
            Edit (Multi-channel)
          </Link>
          <button className="w-full text-left px-4 py-2 text-[13px] text-slate-700 hover:bg-slate-50 border-b border-slate-100">
            View on Amazon
          </button>
          <button className="w-full text-left px-4 py-2 text-[13px] text-slate-700 hover:bg-slate-50">
            Sync Now
          </button>
        </div>
      )}
    </div>
  );
}

export const inventoryColumns = [
  // ── 1. Select & Expand ──────────────────────────────────────────
  col.display({
    id: "selectExpand",
    size: 60,
    header: ({ table }) => (
      <input
        type="checkbox"
        className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
        checked={table.getIsAllPageRowsSelected()}
        ref={(el) => { if (el) el.indeterminate = table.getIsSomePageRowsSelected(); }}
        onChange={table.getToggleAllPageRowsSelectedHandler()}
        aria-label="Select all"
      />
    ),
    cell: ({ row, table }) => {
      const item = row.original;
      const meta = table.options.meta as any;
      const isLoading = meta?.loadingIds?.has(item.id);
      const isExpanded = meta?.expandedIds?.has(item.id);
      const hasChildren = (item.childCount ?? 0) > 0;

      return (
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
            checked={row.getIsSelected()}
            disabled={!row.getCanSelect()}
            onChange={row.getToggleSelectedHandler()}
            aria-label={`Select ${item.sku}`}
          />
          {hasChildren ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                meta?.onExpandRow?.(item.id);
              }}
              className="p-0.5 rounded hover:bg-slate-200 transition-colors text-slate-400 hover:text-slate-700"
              title={isExpanded ? "Collapse variants" : "Expand variants"}
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
              ) : isExpanded ? (
                <ChevronDown className="w-4 h-4 text-blue-600" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>
          ) : null}
        </div>
      );
    },
  }),

  // ── 2. Product (ASIN | SKU | childCount | variationTheme) ────────
  col.accessor("name", {
    id: "product",
    header: "Product",
    size: 380,
    cell: ({ row }) => {
      const item = row.original;
      const isChild = !!item.parentId;
      const hasChildren = (item.childCount ?? 0) > 0;

      return (
        <div className="min-w-0">
          <p className="text-[13px] font-bold text-[#007185] line-clamp-2 leading-snug">
            {item.name}
          </p>

          <div className="mt-1 flex items-center gap-1 text-[13px] text-gray-600 flex-wrap">
            {item.asin && (
              <>
                <span className="font-semibold">{item.asin}</span>
                <span>|</span>
              </>
            )}
            <span>{item.sku}</span>
          </div>

          {/* Parent: show variation count + theme */}
          {hasChildren && (
            <div className="mt-1 flex items-center gap-2">
              <span className="text-[11px] text-gray-500">
                {item.childCount} variation{item.childCount !== 1 ? "s" : ""}
              </span>
              {item.variationTheme && (
                <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded font-medium">
                  by {item.variationTheme}
                </span>
              )}
            </div>
          )}

          {/* Child: show variation attributes as badges (Body Type, Color, Size, …) */}
          {isChild && item.variations && Object.keys(item.variations).length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {Object.entries(item.variations).map(([attrName, attrValue]) => (
                <span
                  key={attrName}
                  className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-700 rounded font-medium"
                >
                  <span className="text-slate-500">{attrName}:</span>{" "}
                  <span>{attrValue}</span>
                </span>
              ))}
            </div>
          )}

          {/* Child fallback: show legacy single variationName when structured variations are absent */}
          {isChild &&
            (!item.variations || Object.keys(item.variations).length === 0) &&
            item.variationName && (
              <p className="text-[11px] text-slate-400 mt-0.5">{item.variationName}</p>
            )}

          {/* Standalone (non-parent, non-child): variation details link */}
          {!hasChildren && !isChild && item.variationName && (
            <Link
              href={`/catalog/${item.id}/edit`}
              className="text-[11px] text-[#007185] hover:text-[#0066a1] font-medium mt-1 inline-block"
            >
              Variation details
            </Link>
          )}
        </div>
      );
    },
  }),

  // ── 3. Listing Status ────────────────────────────────────────────
  col.accessor("status", {
    id: "listingStatus",
    header: "Listing status",
    size: 140,
    cell: ({ row }) => {
      const item = row.original;
      if ((item.childCount ?? 0) > 0) return null; // Parent row: empty

      const isOutOfStock = item.status === "Out of Stock";
      return (
        <div className="min-w-0">
          <p className={`text-[13px] font-medium ${isOutOfStock ? "text-red-600" : "text-emerald-600"}`}>
            {item.status}
          </p>
          {isOutOfStock && (
            <Link
              href={`/catalog/${item.id}/edit`}
              className="text-[11px] text-[#007185] hover:text-[#0066a1] font-medium mt-1 inline-block"
            >
              Replenish inventory
            </Link>
          )}
        </div>
      );
    },
  }),

  // ── 4. Sales (Last 30 days) ──────────────────────────────────────
  col.display({
    id: "sales",
    header: "Sales (Last 30 days)",
    size: 140,
    cell: ({ row }) => {
      if ((row.original.childCount ?? 0) > 0) return null;
      return (
        <p className="text-[13px] font-semibold text-slate-900 tabular-nums">
          {formatCurrency(0)}
        </p>
      );
    },
  }),

  // ── 5. Inventory ─────────────────────────────────────────────────
  col.accessor("stock", {
    id: "inventory",
    header: "Inventory",
    size: 160,
    cell: ({ row }) => {
      const item = row.original;
      if ((item.childCount ?? 0) > 0) return null;

      const isFBA = (item.fulfillmentChannel || "FBM") === "FBA";
      return (
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-slate-900 tabular-nums">{item.stock}</p>
          <div className="text-[11px] text-gray-500 mt-1">
            {isFBA ? (
              <>
                <p>Available (Fulfilment by Amazon)</p>
                <Link href="#" className="text-[#007185] hover:text-[#0066a1] font-medium">View inventory</Link>
              </>
            ) : (
              <>
                <p>(FBM)</p>
                <p>{item.shippingTemplate || "Default FBM Shipping Template"}</p>
              </>
            )}
          </div>
        </div>
      );
    },
  }),

  // ── 6. Price + shipping ──────────────────────────────────────────
  col.accessor("price", {
    id: "price",
    header: "Price + shipping",
    size: 180,
    cell: ({ row }) => {
      const item = row.original;
      if ((item.childCount ?? 0) > 0) return null;

      const formatted = formatCurrency(item.price);
      return (
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-slate-900">{formatted}</p>
          <p className="text-[11px] text-gray-500 mt-1">{formatted} + {formatCurrency(0)}</p>
          <Link href={`/catalog/${item.id}/edit`} className="text-[11px] text-[#007185] hover:text-[#0066a1] font-medium mt-1 inline-block">
            Edit prices
          </Link>
        </div>
      );
    },
  }),

  // ── 7. Estimated fees ────────────────────────────────────────────
  col.display({
    id: "fees",
    header: "Estimated fees",
    size: 140,
    cell: ({ row }) => {
      const item = row.original;
      if ((item.childCount ?? 0) > 0) return null;

      return (
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-slate-900">{formatCurrency(item.price * 0.15)}</p>
          <button className="text-[11px] text-[#007185] hover:text-[#0066a1] font-medium mt-1">
            Calculate revenue
          </button>
        </div>
      );
    },
  }),

  // ── 8. Actions ───────────────────────────────────────────────────
  col.display({
    id: "actions",
    header: "Actions",
    size: 120,
    cell: ({ row }) => <ActionsButton item={row.original} />,
  }),
];
