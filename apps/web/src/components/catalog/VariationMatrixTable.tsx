"use client";

import { useState, useMemo } from "react";
import {
  ChevronDown,
  ChevronUp,
  Edit2,
  Trash2,
  Copy,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import StatusPill from "@/components/shared/StatusPill";
import ActionButton from "@/components/shared/ActionButton";

interface Variation {
  id: string;
  sku: string;
  attributes: Record<string, string>;
  price: number;
  stock: number;
  status: "active" | "inactive" | "draft";
  syncStatus: "synced" | "pending" | "failed";
  lastSynced?: Date;
  channels: {
    amazon?: { listingId: string; status: string };
    ebay?: { listingId: string; status: string };
    shopify?: { listingId: string; status: string };
  };
}

interface VariationMatrixTableProps {
  variations: Variation[];
  onEdit?: (variation: Variation) => void;
  onDelete?: (variationId: string) => void;
  onDuplicate?: (variation: Variation) => void;
  onSync?: (variationId: string) => void;
  loading?: boolean;
}

type SortField = keyof Variation | "channels";
type SortOrder = "asc" | "desc";

export default function VariationMatrixTable({
  variations,
  onEdit,
  onDelete,
  onDuplicate,
  onSync,
  loading = false,
}: VariationMatrixTableProps) {
  const [sortField, setSortField] = useState<SortField>("sku");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());

  const sortedVariations = useMemo(() => {
    const sorted = [...variations].sort((a, b) => {
      let aVal: any = a[sortField as keyof Variation];
      let bVal: any = b[sortField as keyof Variation];

      if (sortField === "channels") {
        aVal = Object.keys(a.channels).length;
        bVal = Object.keys(b.channels).length;
      }

      if (typeof aVal === "string") {
        aVal = aVal.toLowerCase();
        bVal = (bVal as string).toLowerCase();
      }

      if (aVal < bVal) return sortOrder === "asc" ? -1 : 1;
      if (aVal > bVal) return sortOrder === "asc" ? 1 : -1;
      return 0;
    });

    return sorted;
  }, [variations, sortField, sortOrder]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  const toggleRowSelection = (variationId: string) => {
    const newSelected = new Set(selectedRows);
    if (newSelected.has(variationId)) {
      newSelected.delete(variationId);
    } else {
      newSelected.add(variationId);
    }
    setSelectedRows(newSelected);
  };

  const toggleAllSelection = () => {
    if (selectedRows.size === variations.length) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(variations.map((v) => v.id)));
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <div className="w-4 h-4 opacity-0" />;
    }
    return sortOrder === "asc" ? (
      <ChevronUp className="w-4 h-4" />
    ) : (
      <ChevronDown className="w-4 h-4" />
    );
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active":
        return "success";
      case "inactive":
        return "pending";
      case "draft":
        return "info";
      default:
        return "info";
    }
  };

  const getSyncStatusColor = (status: string) => {
    switch (status) {
      case "synced":
        return "success";
      case "pending":
        return "warning";
      case "failed":
        return "error";
      default:
        return "info";
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg border border-slate-200 p-8 text-center">
        <div className="inline-flex items-center gap-2 text-slate-600">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          Loading variations...
        </div>
      </div>
    );
  }

  if (variations.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-slate-200 p-8 text-center">
        <AlertCircle className="w-12 h-12 text-slate-400 mx-auto mb-3" />
        <p className="text-slate-600">No variations found</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
      {/* Table Header with Selection */}
      {selectedRows.size > 0 && (
        <div className="bg-blue-50 border-b border-blue-200 px-6 py-3 flex items-center justify-between">
          <span className="text-sm font-medium text-blue-900">
            {selectedRows.size} variation{selectedRows.size !== 1 ? "s" : ""}{" "}
            selected
          </span>
          <div className="flex gap-2">
            <ActionButton
              variant="sync"
              size="sm"
              onClick={() => {
                selectedRows.forEach((id) => onSync?.(id));
              }}
            >
              Sync Selected
            </ActionButton>
            <ActionButton
              variant="danger"
              size="sm"
              onClick={() => {
                selectedRows.forEach((id) => onDelete?.(id));
                setSelectedRows(new Set());
              }}
            >
              Delete Selected
            </ActionButton>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          {/* Table Head */}
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="px-6 py-3 text-left">
                <input
                  type="checkbox"
                  checked={selectedRows.size === variations.length}
                  onChange={toggleAllSelection}
                  className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
              </th>
              <th className="px-6 py-3 text-left">
                <button
                  onClick={() => handleSort("sku")}
                  className="flex items-center gap-2 font-semibold text-slate-900 hover:text-slate-700 transition-colors"
                >
                  SKU
                  <SortIcon field="sku" />
                </button>
              </th>
              <th className="px-6 py-3 text-left">
                <span className="font-semibold text-slate-900">Attributes</span>
              </th>
              <th className="px-6 py-3 text-right">
                <button
                  onClick={() => handleSort("price")}
                  className="flex items-center justify-end gap-2 font-semibold text-slate-900 hover:text-slate-700 transition-colors w-full"
                >
                  Price
                  <SortIcon field="price" />
                </button>
              </th>
              <th className="px-6 py-3 text-right">
                <button
                  onClick={() => handleSort("stock")}
                  className="flex items-center justify-end gap-2 font-semibold text-slate-900 hover:text-slate-700 transition-colors w-full"
                >
                  Stock
                  <SortIcon field="stock" />
                </button>
              </th>
              <th className="px-6 py-3 text-left">
                <span className="font-semibold text-slate-900">Status</span>
              </th>
              <th className="px-6 py-3 text-left">
                <button
                  onClick={() => handleSort("syncStatus")}
                  className="flex items-center gap-2 font-semibold text-slate-900 hover:text-slate-700 transition-colors"
                >
                  Sync
                  <SortIcon field="syncStatus" />
                </button>
              </th>
              <th className="px-6 py-3 text-left">
                <button
                  onClick={() => handleSort("channels")}
                  className="flex items-center gap-2 font-semibold text-slate-900 hover:text-slate-700 transition-colors"
                >
                  Channels
                  <SortIcon field="channels" />
                </button>
              </th>
              <th className="px-6 py-3 text-right">
                <span className="font-semibold text-slate-900">Actions</span>
              </th>
            </tr>
          </thead>

          {/* Table Body */}
          <tbody className="divide-y divide-slate-200">
            {sortedVariations.map((variation) => (
              <tr
                key={variation.id}
                className={`hover:bg-slate-50 transition-colors ${
                  selectedRows.has(variation.id) ? "bg-blue-50" : ""
                }`}
              >
                <td className="px-6 py-4">
                  <input
                    type="checkbox"
                    checked={selectedRows.has(variation.id)}
                    onChange={() => toggleRowSelection(variation.id)}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                </td>
                <td className="px-6 py-4">
                  <button
                    onClick={() =>
                      setExpandedRow(
                        expandedRow === variation.id ? null : variation.id
                      )
                    }
                    className="flex items-center gap-2 font-mono text-sm font-semibold text-slate-900 hover:text-blue-600 transition-colors"
                  >
                    {expandedRow === variation.id ? (
                      <ChevronUp className="w-4 h-4" />
                    ) : (
                      <ChevronDown className="w-4 h-4" />
                    )}
                    {variation.sku}
                  </button>
                </td>
                <td className="px-6 py-4">
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(variation.attributes).map(([key, value]) => (
                      <span
                        key={key}
                        className="px-2 py-1 bg-slate-100 text-slate-700 text-xs rounded font-medium"
                      >
                        {key}: {value}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-6 py-4 text-right">
                  <span className="font-semibold text-slate-900">
                    ${variation.price.toFixed(2)}
                  </span>
                </td>
                <td className="px-6 py-4 text-right">
                  <span
                    className={`font-semibold ${
                      variation.stock > 0
                        ? "text-green-600"
                        : "text-red-600"
                    }`}
                  >
                    {variation.stock}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <StatusPill
                    status={getStatusColor(variation.status)}
                    label={variation.status}
                    size="sm"
                  />
                </td>
                <td className="px-6 py-4">
                  <StatusPill
                    status={getSyncStatusColor(variation.syncStatus)}
                    label={variation.syncStatus}
                    size="sm"
                  />
                </td>
                <td className="px-6 py-4">
                  <div className="flex gap-1">
                    {Object.keys(variation.channels).map((channel) => (
                      <span
                        key={channel}
                        className="px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded font-medium"
                      >
                        {channel}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-6 py-4 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => onEdit?.(variation)}
                      className="p-2 hover:bg-slate-100 rounded transition-colors"
                      title="Edit"
                    >
                      <Edit2 className="w-4 h-4 text-slate-600" />
                    </button>
                    <button
                      onClick={() => onDuplicate?.(variation)}
                      className="p-2 hover:bg-slate-100 rounded transition-colors"
                      title="Duplicate"
                    >
                      <Copy className="w-4 h-4 text-slate-600" />
                    </button>
                    <button
                      onClick={() => onDelete?.(variation.id)}
                      className="p-2 hover:bg-red-50 rounded transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4 text-red-600" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Expanded Row Details */}
      {expandedRow && (
        <div className="bg-slate-50 border-t border-slate-200 p-6">
          {sortedVariations.find((v) => v.id === expandedRow) && (
            <div className="space-y-4">
              <div>
                <h4 className="font-semibold text-slate-900 mb-3">
                  Channel Details
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {Object.entries(
                    sortedVariations.find((v) => v.id === expandedRow)
                      ?.channels || {}
                  ).map(([channel, details]) => (
                    <div
                      key={channel}
                      className="p-3 bg-white rounded border border-slate-200"
                    >
                      <p className="font-medium text-slate-900 capitalize mb-2">
                        {channel}
                      </p>
                      <div className="space-y-1 text-sm text-slate-600">
                        <p>
                          <span className="font-medium">Listing ID:</span>{" "}
                          {details.listingId}
                        </p>
                        <p>
                          <span className="font-medium">Status:</span>{" "}
                          {details.status}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {sortedVariations.find((v) => v.id === expandedRow)
                ?.lastSynced && (
                <div className="text-sm text-slate-600">
                  <span className="font-medium">Last Synced:</span>{" "}
                  {new Date(
                    sortedVariations.find((v) => v.id === expandedRow)
                      ?.lastSynced || ""
                  ).toLocaleString()}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
