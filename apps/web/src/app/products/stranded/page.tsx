import { prisma } from "@nexus/database";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

/**
 * Stranded Inventory — products that exist in the catalog but have no active
 * listing on any sales channel. Filtered at the DB level (was: load the whole
 * catalog then filter in JS) and capped, so it scales. Oldest-stranded first.
 */
const MAX_ROWS = 500;

const eur = (amount: unknown) => {
  const n = typeof amount === "number" ? amount : parseFloat(String(amount ?? 0));
  return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(
    Number.isFinite(n) ? n : 0,
  );
};

export default async function StrandedInventoryPage() {
  // DB-level: products with zero listings, longest-stranded first.
  const stranded = await prisma.product.findMany({
    where: { listings: { none: {} } },
    include: { images: { take: 1, orderBy: { type: "asc" } } },
    orderBy: { createdAt: "asc" },
    take: MAX_ROWS,
  });

  const now = Date.now();
  const daysStrandedOf = (createdAt: Date) =>
    Math.floor((now - new Date(createdAt).getTime()) / 86_400_000);
  const critical = stranded.filter((p) => daysStrandedOf(p.createdAt) > 30).length;
  const capped = stranded.length >= MAX_ROWS;

  return (
    <div>
      <PageHeader
        title="Stranded Inventory"
        subtitle={`${stranded.length}${capped ? "+" : ""} product${stranded.length !== 1 ? "s" : ""} without active listings`}
        breadcrumbs={[
          { label: "Products", href: "/products" },
          { label: "Stranded Inventory" },
        ]}
      />

      {stranded.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 rounded-lg shadow p-12 text-center">
          <div className="text-5xl mb-4">✅</div>
          <p className="text-lg font-medium text-gray-900 dark:text-slate-100 mb-2">No stranded inventory</p>
          <p className="text-sm text-gray-500">All products have at least one active listing.</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-slate-900 rounded-lg shadow overflow-hidden">
          {/* Summary + alert */}
          <div className="bg-yellow-50 dark:bg-yellow-950/30 border-b border-yellow-200 dark:border-yellow-900/50 px-6 py-4 flex flex-wrap items-center gap-x-6 gap-y-1">
            <span className="text-sm text-yellow-800 dark:text-yellow-300">
              ⚠️ Not listed on any channel — create a listing to start selling.
            </span>
            {critical > 0 && (
              <span className="text-sm font-medium text-red-700 dark:text-red-400">
                {critical} stranded &gt; 30 days
              </span>
            )}
            {capped && (
              <span className="text-xs text-gray-500">Showing the {MAX_ROWS} oldest.</span>
            )}
          </div>

          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-slate-800/60 border-b border-gray-200 dark:border-slate-700 text-xs font-semibold text-gray-600 dark:text-slate-400 uppercase">
              <tr>
                <th className="px-6 py-3 text-left">Product</th>
                <th className="px-6 py-3 text-left">SKU</th>
                <th className="px-6 py-3 text-right">Price</th>
                <th className="px-6 py-3 text-right">Stock</th>
                <th className="px-6 py-3 text-left">ASIN</th>
                <th className="px-6 py-3 text-left">Days Stranded</th>
                <th className="px-6 py-3 text-left">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
              {stranded.map((product) => {
                const mainImage = product.images?.[0];
                const daysStranded = daysStrandedOf(product.createdAt);
                return (
                  <tr key={product.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded bg-gray-100 dark:bg-slate-800 flex items-center justify-center overflow-hidden flex-shrink-0">
                          {mainImage ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={mainImage.url} alt={product.name} className="w-full h-full object-cover" />
                          ) : (
                            <span className="text-gray-400 text-xs">📷</span>
                          )}
                        </div>
                        <span className="font-medium text-gray-900 dark:text-slate-100 truncate max-w-xs">{product.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 font-mono text-gray-600 dark:text-slate-400">{product.sku}</td>
                    <td className="px-6 py-4 text-right font-semibold tabular-nums text-gray-900 dark:text-slate-100">{eur(product.basePrice)}</td>
                    <td className="px-6 py-4 text-right tabular-nums">
                      <span className={product.totalStock > 0 ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400 font-medium"}>
                        {product.totalStock}
                      </span>
                    </td>
                    <td className="px-6 py-4 font-mono text-gray-600 dark:text-slate-400">
                      {product.amazonAsin || <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        daysStranded > 30 ? "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300"
                        : daysStranded > 7 ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-300"
                        : "bg-gray-100 text-gray-700 dark:bg-slate-800 dark:text-slate-300"}`}>
                        {daysStranded}d
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <Link href={`/products/${product.id}/edit`} className="text-xs text-blue-600 hover:text-blue-700 font-medium">Edit</Link>
                        <span className="text-gray-300 dark:text-slate-600">|</span>
                        <Link href={`/products/${product.id}/list-wizard`} className="text-xs text-blue-600 hover:text-blue-700 font-medium">Create Listing</Link>
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
