"use client";

import React from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { ChevronRight, ChevronDown } from "lucide-react";
import type { InventoryItem } from "@/types/inventory";
import Link from "next/link";

const col = createColumnHelper<InventoryItem>();

/* ================================================================== */
/*  Helper: Format Currency (EUR)                                     */
/* ================================================================== */
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(amount);
}

/* ================================================================== */
/*  Helper: Actions Dropdown Button                                   */
/* ================================================================== */
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

/* ================================================================== */
/*  Column Definitions — Amazon Seller Central 1:1 Exact Replication  */
/* ================================================================== */

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
        ref={(el) => {
          if (el) el.indeterminate = table.getIsSomePageRowsSelected();
        }}
        onChange={table.getToggleAllPageRowsSelectedHandler()}
        aria-label="Select all"
      />
    ),
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
          checked={row.getIsSelected()}
          disabled={!row.getCanSelect()}
          onChange={row.getToggleSelectedHandler()}
          aria-label={`Select ${row.original.sku}`}
        />
        {row.original.isParent === true ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              row.toggleExpanded();
            }}
            className="p-0.5 rounded hover:bg-slate-200 transition-colors text-slate-400 hover:text-slate-700"
          >
            {row.getIsExpanded() ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </button>
        ) : null}
      </div>
    ),
  }),

  // ── 2. Product (ASIN | SKU) ─────────────────────────────────────
  col.accessor("name", {
    id: "product",
    header: "Product",
    size: 380,
    cell: ({ row }) => {
      const item = row.original;
      const isParent = item.isParent;
      const variationCount = item.subRows?.length || 0;

      return (
        <div className="min-w-0">
          {/* Product Name */}
          <p className="text-[13px] font-bold text-[#007185] line-clamp-2 leading-snug">
            {item.name}
          </p>

          {/* ASIN | SKU */}
          <div className="mt-1 flex items-center gap-1 text-[13px] text-gray-600">
            {item.asin ? (
              <>
                <span className="font-semibold">{item.asin}</span>
                <span>|</span>
              </>
            ) : null}
            <span>{item.sku}</span>
          </div>

          {/* TRUE Parent: Show Variations count only if isParent === true */}
          {isParent === true && variationCount > 0 && (
            <p className="text-[11px] text-gray-500 mt-1">
              {variationCount} Variations
            </p>
          )}

          {/* Standalone: Show Variation details link only if NOT a parent */}
          {isParent === false && item.variationName && (
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

  // ── 3. Listing Status (Next steps) ──────────────────────────────
  col.accessor("status", {
    id: "listingStatus",
    header: "Listing status",
    size: 140,
    cell: ({ row }) => {
      const item = row.original;

      // Parent rows: render empty
      if (item.isParent) {
        return null;
      }

      const status = item.status;
      const isOutOfStock = status === "Out of Stock";
      const textColor = isOutOfStock ? "text-red-600" : "text-emerald-600";

      return (
        <div className="min-w-0">
          <p className={`text-[13px] font-medium ${textColor}`}>
            {status}
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

  // ── 4. Sales (Last 30 days) ─────────────────────────────────────
  col.display({
    id: "sales",
    header: "Sales (Last 30 days)",
    size: 140,
    cell: ({ row }) => {
      const item = row.original;

      // Parent rows: render empty
      if (item.isParent) {
        return null;
      }

      // Mock sales data — in production, fetch from analytics
      const sales = 0;

      return (
        <p className="text-[13px] font-semibold text-slate-900 tabular-nums">
          {formatCurrency(sales)}
        </p>
      );
    },
  }),

  // ── 5. Inventory (Available units) ──────────────────────────────
  col.accessor("stock", {
    id: "inventory",
    header: "Inventory",
    size: 160,
    cell: ({ row }) => {
      const item = row.original;

      // Parent rows: render empty
      if (item.isParent) {
        return null;
      }

      // Use fulfillmentChannel field directly from database
      const fulfillmentChannel = item.fulfillmentChannel || "FBM";
      const isFBA = fulfillmentChannel === "FBA";

      return (
        <div className="min-w-0">
          {/* Stock number */}
          <p className="text-[13px] font-semibold text-slate-900 tabular-nums">
            {item.stock}
          </p>

          {/* Fulfillment type and sub-label */}
          <div className="text-[11px] text-gray-500 mt-1">
            {isFBA ? (
              <>
                <p>Available (Fulfilment by Amazon)</p>
                <Link
                  href="#"
                  className="text-[#007185] hover:text-[#0066a1] font-medium"
                >
                  View inventory
                </Link>
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

  // ── 6. Price + shipping (Featured Offer) ────────────────────────
  col.accessor("price", {
    id: "price",
    header: "Price + shipping",
    size: 180,
    cell: ({ row }) => {
      const item = row.original;

      // Parent rows: render empty
      if (item.isParent) {
        return null;
      }

      const shippingCost = 0; // Mock shipping cost
      const formattedPrice = formatCurrency(item.price);
      const formattedShipping = formatCurrency(shippingCost);

      return (
        <div className="min-w-0">
          {/* Base price */}
          <p className="text-[13px] font-semibold text-slate-900">
            {formattedPrice}
          </p>

          {/* Price + shipping breakdown */}
          <p className="text-[11px] text-gray-500 mt-1">
            {formattedPrice} + {formattedShipping}
          </p>

          {/* Action Link: Edit prices */}
          <Link
            href={`/catalog/${item.id}/edit`}
            className="text-[11px] text-[#007185] hover:text-[#0066a1] font-medium mt-1 inline-block"
          >
            Edit prices
          </Link>
        </div>
      );
    },
  }),

  // ── 7. Estimated fees (Per unit) ────────────────────────────────
  col.display({
    id: "fees",
    header: "Estimated fees",
    size: 140,
    cell: ({ row }) => {
      const item = row.original;

      // Parent rows: render empty
      if (item.isParent) {
        return null;
      }

      // Mock fee calculation — in production, calculate based on category/price
      const estimatedFee = item.price * 0.15; // 15% placeholder

      return (
        <div className="min-w-0">
          {/* Fee amount */}
          <p className="text-[13px] font-semibold text-slate-900">
            {formatCurrency(estimatedFee)}
          </p>

          {/* Action Link: Calculate revenue */}
          <button className="text-[11px] text-[#007185] hover:text-[#0066a1] font-medium mt-1">
            Calculate revenue
          </button>
        </div>
      );
    },
  }),

  // ── 8. Actions ──────────────────────────────────────────────────
  col.display({
    id: "actions",
    header: "Actions",
    size: 120,
    cell: ({ row }) => {
      const item = row.original;

      // Both parent and child rows show the Edit button
      return <ActionsButton item={item} />;
    },
  }),
];
