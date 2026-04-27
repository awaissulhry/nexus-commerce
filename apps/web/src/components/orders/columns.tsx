"use client";

import { ColumnDef } from "@tanstack/react-table";
import { OrderWithDetails } from "@/app/orders/manage/page";

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(date));
}

function getStatusBadgeColor(status: string): string {
  switch (status.toLowerCase()) {
    case "shipped":
      return "bg-green-100 text-green-800";
    case "pending":
      return "bg-yellow-100 text-yellow-800";
    case "cancelled":
      return "bg-red-100 text-red-800";
    case "unshipped":
      return "bg-blue-100 text-blue-800";
    default:
      return "bg-gray-100 text-gray-800";
  }
}

function getFulfillmentBadgeColor(channel: string): string {
  return channel === "AFN"
    ? "bg-purple-100 text-purple-800"
    : "bg-orange-100 text-orange-800";
}

function getSalesChannelBadgeColor(channel: string): string {
  switch (channel.toUpperCase()) {
    case "AMAZON":
      return "bg-blue-100 text-blue-800";
    case "EBAY":
      return "bg-green-100 text-green-800";
    default:
      return "bg-gray-100 text-gray-800";
  }
}

function getSalesChannelLabel(channel: string): string {
  switch (channel.toUpperCase()) {
    case "AMAZON":
      return "Amazon";
    case "EBAY":
      return "eBay";
    default:
      return channel;
  }
}

export const columns: ColumnDef<OrderWithDetails>[] = [
  {
    id: "expander",
    header: () => null,
    cell: ({ row }) => (
      <button
        onClick={() => row.toggleExpanded()}
        className="cursor-pointer text-slate-600 hover:text-slate-900 w-6 h-6 flex items-center justify-center"
      >
        {row.getIsExpanded() ? (
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        ) : (
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5l7 7-7 7"
            />
          </svg>
        )}
      </button>
    ),
    size: 40,
  },

  {
    accessorKey: "amazonOrderId",
    header: "Order ID",
    cell: ({ row }) => {
      const orderId = row.original.salesChannel === "EBAY"
        ? row.original.ebayOrderId
        : row.original.amazonOrderId;
      return (
        <div className="font-mono text-sm font-semibold text-slate-900">
          {orderId}
        </div>
      );
    },
  },

  {
    accessorKey: "salesChannel",
    header: "Sales Channel",
    cell: ({ row }) => (
      <span
        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getSalesChannelBadgeColor(
          row.original.salesChannel
        )}`}
      >
        {getSalesChannelLabel(row.original.salesChannel)}
      </span>
    ),
  },

  {
    accessorKey: "purchaseDate",
    header: "Purchase Date",
    cell: ({ row }) => (
      <div className="text-sm text-slate-600">
        {formatDate(row.original.purchaseDate)}
      </div>
    ),
  },

  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <span
        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusBadgeColor(
          row.original.status
        )}`}
      >
        {row.original.status}
      </span>
    ),
  },

  {
    accessorKey: "fulfillmentChannel",
    header: "Fulfillment",
    cell: ({ row }) => (
      <span
        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getFulfillmentBadgeColor(
          row.original.fulfillmentChannel
        )}`}
      >
        {row.original.fulfillmentChannel === "AFN" ? "FBA" : "FBM"}
      </span>
    ),
  },

  {
    accessorKey: "items",
    header: "Items",
    cell: ({ row }) => {
      const items = row.original.items;
      if (items.length === 0) return <span className="text-slate-500">—</span>;

      const itemSummary = items
        .slice(0, 2)
        .map((item) => `${item.quantity}x ${item.title.substring(0, 20)}...`)
        .join(", ");

      return (
        <div className="text-sm text-slate-600">
          {itemSummary}
          {items.length > 2 && ` +${items.length - 2} more`}
        </div>
      );
    },
  },

  {
    accessorKey: "totalAmount",
    header: "Order Total",
    cell: ({ row }) => (
      <div className="font-semibold text-slate-900">
        {formatCurrency(row.original.totalAmount)}
      </div>
    ),
  },

  {
    accessorKey: "buyerName",
    header: "Buyer",
    cell: ({ row }) => (
      <div className="text-sm text-slate-600">{row.original.buyerName}</div>
    ),
  },
];
