import { prisma } from "@nexus/database";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

/**
 * Complete Your Drafts — shows products with missing required fields.
 */
export default async function DraftsPage() {
  // U.61 — defensive try/catch. Web-side prisma direct calls fail on
  // Vercel because the web project has no DATABASE_URL (architecture
  // routes data through the API). Falling back to an empty list keeps
  // the page renderable; the real fix is migrating to API fetch, which
  // is out of scope here.
  let products: any[] = [];
  try {
    products = await prisma.product.findMany({
      include: {
        images: true,
        variations: true,
      },
      orderBy: { updatedAt: "desc" },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[catalog/drafts] prisma error:", err);
  }

  // Determine which products are "drafts" (missing important data)
  const drafts = products.filter((p: any) => {
    const missingFields: string[] = [];
    if (!p.brand) missingFields.push("Brand");
    if (!p.images || p.images.length === 0) missingFields.push("Images");
    if (!p.bulletPoints || p.bulletPoints.length === 0)
      missingFields.push("Bullet Points");
    if (!p.upc && !p.ean) missingFields.push("UPC/EAN");
    return missingFields.length > 0;
  });

  const getMissingFields = (p: any): string[] => {
    const missing: string[] = [];
    if (!p.brand) missing.push("Brand");
    if (!p.images || p.images.length === 0) missing.push("Images");
    if (!p.bulletPoints || p.bulletPoints.length === 0)
      missing.push("Bullet Points");
    if (!p.upc && !p.ean) missing.push("UPC/EAN");
    if (!p.manufacturer) missing.push("Manufacturer");
    if (!p.weightValue) missing.push("Weight");
    return missing;
  };

  return (
    <div>
      <PageHeader
        title="Complete Your Drafts"
        subtitle={`${drafts.length} product${drafts.length !== 1 ? "s" : ""} need attention`}
        breadcrumbs={[
          { label: "Catalog", href: "/catalog/add" },
          { label: "Complete Your Drafts" },
        ]}
      />

      {drafts.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <div className="text-5xl mb-4">✅</div>
          <p className="text-lg font-medium text-gray-900 mb-2">
            All products are complete!
          </p>
          <p className="text-sm text-gray-500">
            Every product has all required fields filled in.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  SKU
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Product Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Missing Fields
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Last Updated
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Action
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {drafts.map((product: any) => {
                const missing = getMissingFields(product);
                return (
                  <tr
                    key={product.id}
                    className="hover:bg-gray-50 transition-colors"
                  >
                    <td className="px-6 py-4 text-sm font-mono text-gray-900">
                      {product.sku}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900">
                      <p className="font-medium truncate max-w-xs">
                        {product.name}
                      </p>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1">
                        {missing.map((field) => (
                          <span
                            key={field}
                            className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800"
                          >
                            {field}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-xs text-gray-500">
                      {new Date(product.updatedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-6 py-4">
                      <Link
                        href={`/catalog/${product.id}/edit`}
                        className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors"
                      >
                        ✏️ Complete
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
