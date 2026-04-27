"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type { PricingRow } from "./page";
import { updateProductPrice } from "./actions";
import InlineInput from "@/components/shared/InlineInput";
import FilterBar from "@/components/shared/FilterBar";
import ExportButton from "@/components/shared/ExportButton";

interface PricingClientProps {
  data: PricingRow[];
}

export default function PricingClient({ data }: PricingClientProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState("all");

  const filtered = useMemo(() => {
    let items = data;

    // Tab filter
    if (activeTab === "buybox_lost") {
      items = items.filter(
        (p) =>
          p.buyBoxPrice !== null &&
          p.basePrice > p.buyBoxPrice
      );
    } else if (activeTab === "below_min") {
      items = items.filter(
        (p) => p.minPrice !== null && p.basePrice < p.minPrice
      );
    } else if (activeTab === "above_max") {
      items = items.filter(
        (p) => p.maxPrice !== null && p.basePrice > p.maxPrice
      );
    } else if (activeTab === "no_cost") {
      items = items.filter((p) => p.costPrice === null);
    }

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (p) =>
          p.sku.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          (p.asin && p.asin.toLowerCase().includes(q))
      );
    }

    return items;
  }, [data, activeTab, searchQuery]);

  const tabs = useMemo(() => {
    const buyboxLost = data.filter(
      (p) => p.buyBoxPrice !== null && p.basePrice > p.buyBoxPrice
    ).length;
    const belowMin = data.filter(
      (p) => p.minPrice !== null && p.basePrice < p.minPrice
    ).length;
    const aboveMax = data.filter(
      (p) => p.maxPrice !== null && p.basePrice > p.maxPrice
    ).length;
    const noCost = data.filter((p) => p.costPrice === null).length;

    return [
      { label: "All", value: "all", count: data.length },
      { label: "Buy Box Lost", value: "buybox_lost", count: buyboxLost },
      { label: "Below Min", value: "below_min", count: belowMin },
      { label: "Above Max", value: "above_max", count: aboveMax },
      { label: "No Cost Set", value: "no_cost", count: noCost },
    ];
  }, [data]);

  const formatCurrency = (val: number | null) => {
    if (val === null) return "—";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(val);
  };

  const exportData = filtered.map((p) => ({
    sku: p.sku,
    name: p.name,
    asin: p.asin || "",
    basePrice: p.basePrice,
    costPrice: p.costPrice ?? "",
    minPrice: p.minPrice ?? "",
    maxPrice: p.maxPrice ?? "",
    buyBoxPrice: p.buyBoxPrice ?? "",
    competitorPrice: p.competitorPrice ?? "",
    margin: p.margin !== null ? `${p.margin.toFixed(1)}%` : "",
    stock: p.stock,
  }));

  return (
    <div className="space-y-4">
      <FilterBar
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onSearch={setSearchQuery}
        searchPlaceholder="Search by SKU, ASIN, or product name..."
        actions={
          <ExportButton
            data={exportData}
            filename="pricing-export"
            columns={{
              sku: "SKU",
              name: "Product Name",
              asin: "ASIN",
              basePrice: "Price",
              costPrice: "Cost",
              minPrice: "Min Price",
              maxPrice: "Max Price",
              buyBoxPrice: "Buy Box",
              competitorPrice: "Competitor",
              margin: "Margin",
              stock: "Stock",
            }}
          />
        }
      />

      <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Product
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  SKU
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Your Price
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Cost
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Margin
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Min
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Max
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Buy Box
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Competitor
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Stock
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={10}
                    className="px-4 py-12 text-center text-gray-500"
                  >
                    <div className="text-4xl mb-2">💰</div>
                    <p className="font-medium">No products match your filters</p>
                  </td>
                </tr>
              ) : (
                filtered.map((product) => {
                  const hasBuyBoxIssue =
                    product.buyBoxPrice !== null &&
                    product.basePrice > product.buyBoxPrice;
                  const isBelowMin =
                    product.minPrice !== null &&
                    product.basePrice < product.minPrice;
                  const isAboveMax =
                    product.maxPrice !== null &&
                    product.basePrice > product.maxPrice;

                  return (
                    <tr
                      key={product.id}
                      className={`hover:bg-gray-50 transition-colors ${
                        hasBuyBoxIssue || isBelowMin || isAboveMax
                          ? "bg-red-50/30"
                          : ""
                      }`}
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/catalog/${product.id}`}
                          className="flex items-center gap-2 group"
                        >
                          <div className="w-8 h-8 rounded bg-gray-100 flex items-center justify-center overflow-hidden flex-shrink-0">
                            {product.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={product.imageUrl}
                                alt=""
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <span className="text-gray-400 text-[10px]">
                                📷
                              </span>
                            )}
                          </div>
                          <span className="text-sm text-gray-900 group-hover:text-blue-600 truncate max-w-[200px]">
                            {product.name}
                          </span>
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-xs font-mono text-gray-600">
                        {product.sku}
                        {product.asin && (
                          <span className="block text-[10px] text-gray-400 mt-0.5">
                            {product.asin}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <InlineInput
                          initialValue={product.basePrice}
                          field="price"
                          prefix="$"
                          onSave={(value) =>
                            updateProductPrice(product.id, "basePrice", value)
                          }
                        />
                      </td>
                      <td className="px-4 py-3">
                        {product.costPrice !== null ? (
                          <InlineInput
                            initialValue={product.costPrice}
                            field="price"
                            prefix="$"
                            onSave={(value) =>
                              updateProductPrice(product.id, "costPrice", value)
                            }
                          />
                        ) : (
                          <span className="text-xs text-gray-400 italic">
                            Not set
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {product.margin !== null ? (
                          <span
                            className={`text-sm font-medium ${
                              product.margin >= 30
                                ? "text-green-700"
                                : product.margin >= 15
                                ? "text-yellow-700"
                                : "text-red-700"
                            }`}
                          >
                            {product.margin.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {product.minPrice !== null ? (
                          <span
                            className={
                              isBelowMin ? "text-red-600 font-medium" : ""
                            }
                          >
                            {formatCurrency(product.minPrice)}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {product.maxPrice !== null ? (
                          <span
                            className={
                              isAboveMax ? "text-red-600 font-medium" : ""
                            }
                          >
                            {formatCurrency(product.maxPrice)}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {product.buyBoxPrice !== null ? (
                          <span
                            className={
                              hasBuyBoxIssue
                                ? "text-red-600 font-medium"
                                : "text-green-700"
                            }
                          >
                            {formatCurrency(product.buyBoxPrice)}
                            {hasBuyBoxIssue && (
                              <span className="block text-[10px] text-red-500">
                                Lost
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {formatCurrency(product.competitorPrice)}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <span
                          className={
                            product.stock > 0
                              ? "text-gray-900"
                              : "text-red-600 font-medium"
                          }
                        >
                          {product.stock}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
