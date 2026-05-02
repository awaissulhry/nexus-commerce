import { prisma } from "@nexus/database";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

/**
 * Stranded Inventory — products that exist in the catalog but have
 * no active listing on any sales channel.
 */
export default async function StrandedInventoryPage() {
  // Find products that have zero listings
  const products = await prisma.product.findMany({
    include: {
      listings: true,
      images: { take: 1, orderBy: { type: "asc" } },
    },
    orderBy: { updatedAt: "desc" },
  });

  const stranded = products.filter(
    (p: any) => !p.listings || p.listings.length === 0
  );

  const formatCurrency = (amount: any) => {
    const num =
      typeof amount === "string"
        ? parseFloat(amount)
        : typeof amount === "number"
        ? amount
        : parseFloat(amount.toString());
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(num);
  };

  return (
    <div>
      <PageHeader
        title="Stranded Inventory"
        subtitle={`${stranded.length} product${stranded.length !== 1 ? "s" : ""} without active listings`}
        breadcrumbs={[
          { label: "Products", href: "/products" },
          { label: "Stranded Inventory" },
        ]}
      />

      {stranded.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <div className="text-5xl mb-4">✅</div>
          <p className="text-lg font-medium text-gray-900 mb-2">
            No stranded inventory
          </p>
          <p className="text-sm text-gray-500">
            All products have at least one active listing.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          {/* Alert banner */}
          <div className="bg-yellow-50 border-b border-yellow-200 px-6 py-4">
            <div className="flex items-center gap-2">
              <span className="text-yellow-600 text-lg">⚠️</span>
              <p className="text-sm text-yellow-800">
                These products are not listed on any sales channel. Create a
                listing to start selling.
              </p>
            </div>
          </div>

          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Product
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  SKU
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Price
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Stock
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  ASIN
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Days Stranded
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Action
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {stranded.map((product: any) => {
                const mainImage = product.images?.[0];
                const daysStranded = Math.floor(
                  (Date.now() - new Date(product.createdAt).getTime()) /
                    (1000 * 60 * 60 * 24)
                );

                return (
                  <tr
                    key={product.id}
                    className="hover:bg-gray-50 transition-colors"
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded bg-gray-100 flex items-center justify-center overflow-hidden flex-shrink-0">
                          {mainImage ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={mainImage.url}
                              alt={product.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <span className="text-gray-400 text-xs">📷</span>
                          )}
                        </div>
                        <span className="text-sm font-medium text-gray-900 truncate max-w-xs">
                          {product.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm font-mono text-gray-600">
                      {product.sku}
                    </td>
                    <td className="px-6 py-4 text-sm font-semibold text-gray-900">
                      {formatCurrency(product.basePrice)}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900">
                      <span
                        className={
                          product.totalStock > 0
                            ? "text-green-700"
                            : "text-red-600 font-medium"
                        }
                      >
                        {product.totalStock}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm font-mono text-gray-600">
                      {product.amazonAsin || (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          daysStranded > 30
                            ? "bg-red-100 text-red-800"
                            : daysStranded > 7
                            ? "bg-yellow-100 text-yellow-800"
                            : "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {daysStranded}d
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/catalog/${product.id}/edit`}
                          className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                        >
                          Edit
                        </Link>
                        <span className="text-gray-300">|</span>
                        <Link
                          href="/listings"
                          className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                        >
                          Create Listing
                        </Link>
                      </div>
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
