import { prisma } from "@nexus/database";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

interface PriceAlert {
  id: string;
  sku: string;
  name: string;
  asin: string | null;
  basePrice: number;
  minPrice: number | null;
  maxPrice: number | null;
  buyBoxPrice: number | null;
  competitorPrice: number | null;
  alertType: "below_min" | "above_max" | "buybox_lost" | "competitor_undercut";
  alertMessage: string;
}

export default async function PriceAlertsPage() {
  const products = await prisma.product.findMany({
    orderBy: { updatedAt: "desc" },
  });

  // Derive price alerts from product data
  const alerts: PriceAlert[] = [];

  for (const p of products as any[]) {
    const basePrice = Number(p.basePrice);
    const minPrice = p.minPrice ? Number(p.minPrice) : null;
    const maxPrice = p.maxPrice ? Number(p.maxPrice) : null;
    const buyBoxPrice = p.buyBoxPrice ? Number(p.buyBoxPrice) : null;
    const competitorPrice = p.competitorPrice
      ? Number(p.competitorPrice)
      : null;

    if (minPrice !== null && basePrice < minPrice) {
      alerts.push({
        id: p.id,
        sku: p.sku,
        name: p.name,
        asin: p.amazonAsin ?? null,
        basePrice,
        minPrice,
        maxPrice,
        buyBoxPrice,
        competitorPrice,
        alertType: "below_min",
        alertMessage: `Price $${basePrice.toFixed(2)} is below minimum $${minPrice.toFixed(2)}`,
      });
    }

    if (maxPrice !== null && basePrice > maxPrice) {
      alerts.push({
        id: p.id,
        sku: p.sku,
        name: p.name,
        asin: p.amazonAsin ?? null,
        basePrice,
        minPrice,
        maxPrice,
        buyBoxPrice,
        competitorPrice,
        alertType: "above_max",
        alertMessage: `Price $${basePrice.toFixed(2)} exceeds maximum $${maxPrice.toFixed(2)}`,
      });
    }

    if (buyBoxPrice !== null && basePrice > buyBoxPrice) {
      alerts.push({
        id: p.id,
        sku: p.sku,
        name: p.name,
        asin: p.amazonAsin ?? null,
        basePrice,
        minPrice,
        maxPrice,
        buyBoxPrice,
        competitorPrice,
        alertType: "buybox_lost",
        alertMessage: `Your price $${basePrice.toFixed(2)} > Buy Box $${buyBoxPrice.toFixed(2)}`,
      });
    }

    if (
      competitorPrice !== null &&
      competitorPrice < basePrice &&
      (buyBoxPrice === null || competitorPrice < buyBoxPrice)
    ) {
      alerts.push({
        id: p.id,
        sku: p.sku,
        name: p.name,
        asin: p.amazonAsin ?? null,
        basePrice,
        minPrice,
        maxPrice,
        buyBoxPrice,
        competitorPrice,
        alertType: "competitor_undercut",
        alertMessage: `Competitor at $${competitorPrice.toFixed(2)} vs your $${basePrice.toFixed(2)}`,
      });
    }
  }

  const alertTypeStyles: Record<string, { bg: string; text: string; label: string }> = {
    below_min: { bg: "bg-red-100", text: "text-red-800", label: "Below Min" },
    above_max: { bg: "bg-orange-100", text: "text-orange-800", label: "Above Max" },
    buybox_lost: { bg: "bg-yellow-100", text: "text-yellow-800", label: "Buy Box Lost" },
    competitor_undercut: { bg: "bg-purple-100", text: "text-purple-800", label: "Undercut" },
  };

  const formatCurrency = (val: number | null) => {
    if (val === null) return "—";
    return `$${val.toFixed(2)}`;
  };

  return (
    <div>
      <PageHeader
        title="Fix Price Alerts"
        subtitle={`${alerts.length} alert${alerts.length !== 1 ? "s" : ""} require attention`}
        breadcrumbs={[
          { label: "Pricing", href: "/pricing" },
          { label: "Fix Price Alerts" },
        ]}
      />

      {alerts.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <div className="text-5xl mb-4">✅</div>
          <p className="text-lg font-medium text-gray-900 mb-2">
            No price alerts
          </p>
          <p className="text-sm text-gray-500">
            All products are within their pricing boundaries.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          {/* Summary banner */}
          <div className="bg-red-50 border-b border-red-200 px-6 py-4">
            <div className="flex items-center gap-4 text-sm">
              <span className="text-red-700 font-medium">
                🚨 {alerts.length} pricing issue{alerts.length !== 1 ? "s" : ""} detected
              </span>
              <span className="text-red-600">
                {alerts.filter((a) => a.alertType === "buybox_lost").length} Buy Box lost ·{" "}
                {alerts.filter((a) => a.alertType === "below_min").length} below min ·{" "}
                {alerts.filter((a) => a.alertType === "above_max").length} above max
              </span>
            </div>
          </div>

          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Alert
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Product
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  SKU
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Your Price
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Buy Box
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Min / Max
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Issue
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Action
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {alerts.map((alert, idx) => {
                const style = alertTypeStyles[alert.alertType];
                return (
                  <tr
                    key={`${alert.id}-${alert.alertType}-${idx}`}
                    className="hover:bg-gray-50 transition-colors"
                  >
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${style.bg} ${style.text}`}
                      >
                        {style.label}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900 truncate max-w-[200px]">
                      {alert.name}
                    </td>
                    <td className="px-6 py-4 text-xs font-mono text-gray-600">
                      {alert.sku}
                      {alert.asin && (
                        <span className="block text-[10px] text-gray-400">
                          {alert.asin}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-sm font-semibold text-gray-900">
                      {formatCurrency(alert.basePrice)}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">
                      {formatCurrency(alert.buyBoxPrice)}
                    </td>
                    <td className="px-6 py-4 text-xs text-gray-600">
                      {formatCurrency(alert.minPrice)} / {formatCurrency(alert.maxPrice)}
                    </td>
                    <td className="px-6 py-4 text-xs text-gray-700">
                      {alert.alertMessage}
                    </td>
                    <td className="px-6 py-4">
                      <Link
                        href={`/pricing`}
                        className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                      >
                        Fix Price →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
