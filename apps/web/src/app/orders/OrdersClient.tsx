"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import FilterBar from "@/components/shared/FilterBar";
import ExportButton from "@/components/shared/ExportButton";

export interface OrderRow {
  id: string;
  amazonOrderId: string;
  channelName: string;
  status: string;
  totalAmount: number;
  itemCount: number;
  buyerName: string | null;
  trackingNumber: string | null;
  createdAt: string;
}

interface OrdersClientProps {
  orders: OrderRow[];
}

export default function OrdersClient({ orders }: OrdersClientProps) {
  const [activeTab, setActiveTab] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  const filtered = useMemo(() => {
    let items = orders;

    // Tab filter
    if (activeTab !== "all") {
      items = items.filter((o) => o.status === activeTab);
    }

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (o) =>
          o.amazonOrderId.toLowerCase().includes(q) ||
          o.id.toLowerCase().includes(q) ||
          (o.buyerName && o.buyerName.toLowerCase().includes(q)) ||
          (o.trackingNumber && o.trackingNumber.toLowerCase().includes(q))
      );
    }

    return items;
  }, [orders, activeTab, searchQuery]);

  const tabs = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const o of orders) {
      counts[o.status] = (counts[o.status] || 0) + 1;
    }
    return [
      { label: "All", value: "all", count: orders.length },
      { label: "Pending", value: "pending", count: counts["pending"] || 0 },
      { label: "Completed", value: "completed", count: counts["completed"] || 0 },
      { label: "Shipped", value: "shipped", count: counts["shipped"] || 0 },
      { label: "Cancelled", value: "cancelled", count: counts["cancelled"] || 0 },
    ];
  }, [orders]);

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(amount);

  const statusStyles: Record<string, string> = {
    completed: "bg-green-100 text-green-800",
    pending: "bg-yellow-100 text-yellow-800",
    shipped: "bg-blue-100 text-blue-800",
    cancelled: "bg-red-100 text-red-800",
  };

  const exportData = filtered.map((o) => ({
    orderId: o.id,
    amazonOrderId: o.amazonOrderId,
    channel: o.channelName,
    status: o.status,
    totalAmount: o.totalAmount,
    items: o.itemCount,
    buyer: o.buyerName || "",
    tracking: o.trackingNumber || "",
    date: o.createdAt,
  }));

  return (
    <div className="space-y-4">
      <FilterBar
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onSearch={setSearchQuery}
        searchPlaceholder="Search by order ID, buyer name, or tracking number..."
        actions={
          <div className="flex items-center gap-2">
            <ExportButton
              data={exportData}
              filename="orders-export"
              columns={{
                orderId: "Order ID",
                amazonOrderId: "Amazon Order ID",
                channel: "Channel",
                status: "Status",
                totalAmount: "Total",
                items: "Items",
                buyer: "Buyer",
                tracking: "Tracking",
                date: "Date",
              }}
            />
            <Link
              href="/orders/returns"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              ↩️ Returns
            </Link>
          </div>
        }
      />

      <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                Order ID
              </th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                Amazon Order ID
              </th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                Channel
              </th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                Total
              </th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                Items
              </th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                Buyer
              </th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                Date
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-6 py-12 text-center">
                  <div className="text-4xl mb-2">🛒</div>
                  <p className="text-gray-600 font-medium">No orders match your filters</p>
                  <p className="text-sm text-gray-500 mt-1">
                    Try adjusting your search or filter criteria.
                  </p>
                </td>
              </tr>
            ) : (
              filtered.map((order) => (
                <tr
                  key={order.id}
                  className="hover:bg-gray-50 transition-colors"
                >
                  <td className="px-6 py-4 text-sm text-gray-900 font-mono">
                    {order.id.slice(0, 8)}...
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-900">
                    {order.amazonOrderId}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-900">
                    {order.channelName}
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        statusStyles[order.status] || "bg-gray-100 text-gray-800"
                      }`}
                    >
                      {order.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm font-semibold text-gray-900">
                    {formatCurrency(order.totalAmount)}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-900">
                    {order.itemCount} item{order.itemCount !== 1 ? "s" : ""}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {order.buyerName || (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {formatDate(order.createdAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="text-sm text-gray-500">
        Showing {filtered.length} of {orders.length} orders
      </div>
    </div>
  );
}
