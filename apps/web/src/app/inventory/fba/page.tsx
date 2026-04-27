import { prisma } from "@nexus/database";
import type { InventoryItem } from "@/types/inventory";
import ManageInventoryClient from "../manage/ManageInventoryClient";
import PageHeader from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

/**
 * Manage FBA Inventory — filtered to FBA-only products.
 */
async function getFBAInventoryData(): Promise<InventoryItem[]> {
  const products = await prisma.product.findMany({
    where: { fulfillmentMethod: "FBA" },
    include: {
      variations: true,
      images: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  return products.map((product: any): InventoryItem => {
    const mainImage =
      product.images?.find((img: any) => img.type === "MAIN") ??
      product.images?.[0];

    const deriveStatus = (stock: number): InventoryItem["status"] => {
      if (stock <= 0) return "Out of Stock";
      return "Active";
    };

    const subRows: InventoryItem[] = (product.variations ?? []).map(
      (v: any): InventoryItem => ({
        id: v.id,
        sku: v.sku,
        name: product.name,
        asin: null,
        ebayItemId: null,
        imageUrl: mainImage?.url ?? null,
        price: Number(v.price),
        stock: v.stock,
        status: deriveStatus(v.stock),
        isParent: false,
        variationName: v.name,
        variationValue: v.value,
        brand: null,
        fulfillment: "FBA",
        createdAt: v.createdAt ? new Date(v.createdAt).toISOString() : null,
        condition: "New",
      })
    );

    return {
      id: product.id,
      sku: product.sku,
      name: product.name,
      asin: product.amazonAsin ?? null,
      ebayItemId: product.ebayItemId ?? null,
      imageUrl: mainImage?.url ?? null,
      price: Number(product.basePrice),
      stock: product.totalStock,
      status: deriveStatus(product.totalStock),
      isParent: true,
      variationName: null,
      variationValue: null,
      brand: product.brand ?? null,
      fulfillment: "FBA",
      createdAt: product.createdAt
        ? new Date(product.createdAt).toISOString()
        : null,
      condition: "New",
      subRows: subRows.length > 0 ? subRows : undefined,
    };
  });
}

export default async function FBAInventoryPage() {
  const data = await getFBAInventoryData();

  return (
    <div>
      <PageHeader
        title="Manage FBA Inventory"
        subtitle={`${data.length} FBA product${data.length !== 1 ? "s" : ""}`}
        breadcrumbs={[
          { label: "Inventory", href: "/inventory" },
          { label: "Manage FBA Inventory" },
        ]}
      />

      {data.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <div className="text-5xl mb-4">🏭</div>
          <p className="text-lg font-medium text-gray-900 mb-2">
            No FBA inventory found
          </p>
          <p className="text-sm text-gray-500">
            Products with fulfillment method set to FBA will appear here.
          </p>
        </div>
      ) : (
        <ManageInventoryClient data={data} />
      )}
    </div>
  );
}
