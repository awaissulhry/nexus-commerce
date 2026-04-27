import { prisma } from "@nexus/database";
import type { InventoryItem } from "@/types/inventory";
import ManageInventoryClient from "./manage/ManageInventoryClient";
import PageHeader from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

/**
 * Primary "Manage All Inventory" page — mirrors Amazon SC's main inventory view.
 * Reuses the existing ManageInventoryClient with TanStack Table.
 */
async function getInventoryData(): Promise<InventoryItem[]> {
  try {
    // Fetch ONLY top-level products (Master Parents and True Standalones)
    // Use raw SQL to bypass Prisma client type issues
    const products = (await (prisma as any).$queryRaw`
      SELECT 
        p.id, p.sku, p.name, p."amazonAsin", p."ebayItemId", 
        p."basePrice", p."totalStock", p."isParent", p."fulfillmentChannel",
        p."fulfillmentMethod", p.brand, p."createdAt", p."updatedAt",
        COALESCE(json_agg(
          json_build_object(
            'id', c.id,
            'sku', c.sku,
            'name', c.name,
            'amazonAsin', c."amazonAsin",
            'ebayVariationId', c."ebayItemId",
            'price', c."basePrice",
            'stock', c."totalStock",
            'fulfillmentMethod', c."fulfillmentMethod",
            'value', c.name
          ) ORDER BY c.sku
        ) FILTER (WHERE c.id IS NOT NULL), '[]'::json) as children
      FROM "Product" p
      LEFT JOIN "Product" c ON c."parentId" = p.id
      WHERE p."parentId" IS NULL
      GROUP BY p.id, p.sku, p.name, p."amazonAsin", p."ebayItemId", 
               p."basePrice", p."totalStock", p."isParent", p."fulfillmentChannel",
               p."fulfillmentMethod", p.brand, p."createdAt", p."updatedAt"
      ORDER BY p."updatedAt" DESC
    `) as any[];

    const deriveStatus = (stock: number): InventoryItem["status"] => {
      if (stock <= 0) return "Out of Stock";
      return "Active";
    };

    // Map each Product into an InventoryItem with nested subRows
    return products.map((product): InventoryItem => {
      // Handle children from raw SQL result (array of objects)
      const children = (product.children && Array.isArray(product.children) && product.children.length > 0)
        ? product.children.filter((c: any) => c && c.id)
        : [];

      // Build child rows from the children relation
      const subRows: InventoryItem[] = children.map((child: any): InventoryItem => {
        return {
          id: child.id,
          sku: child.sku,
          name: child.name,
          asin: child.amazonAsin || null,
          ebayItemId: child.ebayVariationId || null,
          imageUrl: null,
          price: Number(child.price),
          stock: child.stock,
          status: deriveStatus(child.stock),
          isParent: false,
          variationName: child.name || null,
          variationValue: child.value || null,
          brand: product.brand || null,
          fulfillment: child.fulfillmentMethod || product.fulfillmentMethod || null,
          createdAt: child.createdAt
            ? new Date(child.createdAt).toISOString()
            : null,
          condition: "New",
          channels: undefined,
          channelData: undefined,
        };
      });

      return {
        id: product.id,
        sku: product.sku,
        name: product.name,
        asin: product.amazonAsin || null,
        ebayItemId: product.ebayItemId || null,
        imageUrl: null,
        price: Number(product.basePrice),
        stock: product.totalStock,
        status: deriveStatus(product.totalStock),
        isParent: product.isParent === true,
        parentId: null, // Top-level products have no parent
        variationName: null,
        variationValue: null,
        brand: product.brand || null,
        fulfillment: product.fulfillmentChannel || product.fulfillmentMethod || null,
        createdAt: product.createdAt
          ? new Date(product.createdAt).toISOString()
          : null,
        condition: "New",
        channels: undefined,
        subRows: product.isParent === true ? subRows : undefined,
      };
    });
  } catch (error) {
    console.error("Failed to fetch inventory data:", error);
    return [];
  }
}

export default async function ManageAllInventoryPage() {
  const data = await getInventoryData();

  return (
    <div>
      <PageHeader
        title="Master Catalog"
        subtitle="Amazon Seller Central 1:1 Replication"
      />
      <ManageInventoryClient data={data} />
    </div>
  );
}
