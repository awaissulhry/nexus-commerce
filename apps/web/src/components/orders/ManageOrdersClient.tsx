"use client";

import { useState, useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getExpandedRowModel,
  ColumnDef,
  flexRender,
} from "@tanstack/react-table";
import { OrderWithDetails } from "@/app/orders/manage/page";
import { columns } from "./columns";

interface ManageOrdersClientProps {
  initialOrders: OrderWithDetails[];
}

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
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

export default function ManageOrdersClient({
  initialOrders,
}: ManageOrdersClientProps) {
  const [expanded, setExpanded] = useState({});
  const [fulfillmentFilter, setFulfillmentFilter] = useState<string | null>(
    null
  );
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [channelFilter, setChannelFilter] = useState<string | null>(null);

  // Filter orders based on selected filters
  const filteredOrders = useMemo(() => {
    return initialOrders.filter((order) => {
      if (
        fulfillmentFilter &&
        order.fulfillmentChannel !== fulfillmentFilter
      ) {
        return false;
      }
      if (statusFilter && order.status !== statusFilter) {
        return false;
      }
      if (channelFilter && order.salesChannel !== channelFilter) {
        return false;
      }
      return true;
    });
  }, [initialOrders, fulfillmentFilter, statusFilter, channelFilter]);

  const table = useReactTable({
    data: filteredOrders,
    columns,
    state: {
      expanded,
    },
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  const uniqueStatuses = Array.from(
    new Set(initialOrders.map((o) => o.status))
  ).sort();

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex items-center gap-4 bg-white rounded-lg border border-slate-200 p-4">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-slate-700">
            Channel:
          </label>
          <select
            value={channelFilter || ""}
            onChange={(e) =>
              setChannelFilter(e.target.value || null)
            }
            className="px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Channels</option>
            <option value="AMAZON">Amazon</option>
            <option value="EBAY">eBay</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-slate-700">
            Fulfillment:
          </label>
          <select
            value={fulfillmentFilter || ""}
            onChange={(e) =>
              setFulfillmentFilter(e.target.value || null)
            }
            className="px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All</option>
            <option value="AFN">FBA</option>
            <option value="MFN">FBM</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-slate-700">Status:</label>
          <select
            value={statusFilter || ""}
            onChange={(e) => setStatusFilter(e.target.value || null)}
            className="px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All</option>
            {uniqueStatuses.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>

        <div className="ml-auto text-sm text-slate-600">
          Showing {filteredOrders.length} of {initialOrders.length} orders
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" style={{ fontSize: "13px" }}>
            <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-20">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className="px-4 py-3 text-left font-semibold text-slate-700"
                      style={{
                        width:
                          header.getSize() !== 150
                            ? header.getSize()
                            : undefined,
                      }}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length}
                    className="px-4 py-12 text-center text-slate-500"
                  >
                    <div className="flex flex-col items-center gap-2">
                      <svg
                        className="w-12 h-12 text-slate-300"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
                        />
                      </svg>
                      <p>No orders found</p>
                    </div>
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row, rowIdx) => {
                  const isExpanded = row.getIsExpanded();
                  return (
                    <tr
                      key={row.id}
                      className={`border-b border-slate-200 hover:bg-slate-50 transition-colors ${
                        isExpanded ? "bg-blue-50" : ""
                      }`}
                    >
                      {row.getVisibleCells().map((cell, cellIdx) => (
                        <td
                          key={cell.id}
                          className="px-4 py-3"
                          style={{
                            width:
                              cell.column.getSize() !== 150
                                ? cell.column.getSize()
                                : undefined,
                          }}
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext()
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Expanded Row Details */}
        {table.getRowModel().rows.map((row) => {
          if (!row.getIsExpanded()) return null;

          const order = row.original;

          return (
            <div
              key={`expanded-${row.id}`}
              className="bg-blue-50 border-t border-blue-200 px-4 py-4"
            >
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Order Items Section */}
                <div>
                  <h3 className="font-semibold text-slate-900 mb-3">
                    Order Items ({order.items.length})
                  </h3>
                  <div className="space-y-3">
                    {order.items.map((item) => (
                      <div
                        key={item.id}
                        className="bg-white rounded border border-slate-200 p-3"
                      >
                        <div className="flex justify-between items-start mb-2">
                          <div>
                            <p className="font-medium text-slate-900 text-sm">
                              {item.title}
                            </p>
                            <p className="text-xs text-slate-600 mt-1">
                              Qty: {item.quantity}
                            </p>
                          </div>
                          <span className="font-semibold text-slate-900">
                            {formatCurrency(item.totalWithShipping)}
                          </span>
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-xs text-slate-600 mb-2">
                          <div>
                            <span className="text-slate-500">Item Price:</span>{" "}
                            {formatCurrency(item.itemPrice)}
                          </div>
                          <div>
                            <span className="text-slate-500">Tax:</span>{" "}
                            {formatCurrency(item.itemTax)}
                          </div>
                          <div>
                            <span className="text-slate-500">Shipping:</span>{" "}
                            {formatCurrency(item.shippingPrice)}
                          </div>
                          <div>
                            <span className="text-slate-500">Status:</span>{" "}
                            {item.fulfillmentStatus}
                          </div>
                        </div>

                        {item.product && (
                          <div className="bg-slate-50 rounded p-2 text-xs">
                            <p className="text-slate-600">
                              <span className="font-medium">Linked Product:</span>{" "}
                              {item.product.name}
                            </p>
                            <p className="text-slate-600">
                              <span className="font-medium">SKU:</span>{" "}
                              <code className="bg-white px-1 rounded">
                                {item.product.sku}
                              </code>
                            </p>
                          </div>
                        )}

                        {!item.product && (
                          <div className="bg-yellow-50 rounded p-2 text-xs text-yellow-800">
                            ⚠️ No linked product - requires manual review
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Financial Summary Section */}
                <div>
                  <h3 className="font-semibold text-slate-900 mb-3">
                    Financial Summary
                  </h3>
                  <div className="bg-white rounded border border-slate-200 p-4 space-y-3">
                    {order.financialTransactions.length > 0 ? (
                      <>
                        {order.financialTransactions.map((txn) => (
                          <div key={txn.id} className="border-b border-slate-200 pb-3 last:border-0">
                            <div className="flex justify-between items-center mb-2">
                              <span className="text-sm font-medium text-slate-700">
                                {txn.transactionType}
                              </span>
                              <span className="text-sm font-semibold text-slate-900">
                                {formatCurrency(txn.amount)}
                              </span>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
                              <div>
                                <span className="text-slate-500">
                                  Gross Revenue:
                                </span>{" "}
                                {formatCurrency(txn.grossRevenue)}
                              </div>
                              <div>
                                <span className="text-slate-500">
                                  Net Revenue:
                                </span>{" "}
                                {formatCurrency(txn.netRevenue)}
                              </div>
                              
                              {order.salesChannel === "EBAY" ? (
                                <>
                                  <div>
                                    <span className="text-slate-500">
                                      eBay Fee:
                                    </span>{" "}
                                    {formatCurrency(txn.ebayFee || 0)}
                                  </div>
                                  <div>
                                    <span className="text-slate-500">PayPal Fee:</span>{" "}
                                    {formatCurrency(txn.paypalFee || 0)}
                                  </div>
                                </>
                              ) : (
                                <>
                                  <div>
                                    <span className="text-slate-500">
                                      Amazon Fee:
                                    </span>{" "}
                                    {formatCurrency(txn.amazonFee)}
                                  </div>
                                  <div>
                                    <span className="text-slate-500">FBA Fee:</span>{" "}
                                    {formatCurrency(txn.fbaFee)}
                                  </div>
                                </>
                              )}
                              
                              <div>
                                <span className="text-slate-500">
                                  Payment Services:
                                </span>{" "}
                                {formatCurrency(txn.paymentServicesFee)}
                              </div>
                              <div>
                                <span className="text-slate-500">
                                  Other Fees:
                                </span>{" "}
                                {formatCurrency(txn.otherFees)}
                              </div>
                            </div>
                            <p className="text-xs text-slate-500 mt-2">
                              {formatDate(txn.transactionDate)}
                            </p>
                          </div>
                        ))}
                      </>
                    ) : (
                      <p className="text-sm text-slate-500">
                        No financial transactions recorded
                      </p>
                    )}

                    {/* Order Summary */}
                    <div className="bg-slate-50 rounded p-3 mt-4">
                      <div className="flex justify-between items-center mb-2">
                        <span className="font-medium text-slate-700">
                          Order Total:
                        </span>
                        <span className="font-bold text-lg text-slate-900">
                          {formatCurrency(order.totalAmount)}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600">
                        <span className="font-medium">Buyer:</span>{" "}
                        {order.buyerName}
                        {order.buyerEmail && ` (${order.buyerEmail})`}
                      </p>
                      {order.trackingNumber && (
                        <p className="text-xs text-slate-600 mt-1">
                          <span className="font-medium">Tracking:</span>{" "}
                          {order.trackingNumber}
                          {order.carrier && ` via ${order.carrier}`}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
