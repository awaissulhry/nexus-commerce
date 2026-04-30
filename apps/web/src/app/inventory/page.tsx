import type { InventoryItem } from "@/types/inventory";
import ManageInventoryClient from "./manage/ManageInventoryClient";
import PageHeader from "@/components/layout/PageHeader";
import { getBackendUrl } from "@/lib/backend-url";

export const dynamic = "force-dynamic";

interface ApiProduct {
  id: string;
  sku: string;
  name: string;
  amazonAsin: string | null;
  ebayItemId: string | null;
  basePrice: string | number;
  totalStock: number;
  isParent: boolean;
  parentId: string | null;
  variationTheme: string | null;
  fulfillmentChannel: string | null;
  fulfillmentMethod: string | null;
  shippingTemplate: string | null;
  brand: string | null;
  createdAt: string;
}

async function getInventoryData(): Promise<InventoryItem[]> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/amazon/products/list`, {
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(`[Inventory] API returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    const raw: ApiProduct[] = data.products ?? [];

    console.log(`[Inventory] ${raw.length} total products from API`);

    // Count children per parent for the childCount badge
    const childCountMap = new Map<string, number>();
    for (const p of raw) {
      if (p.parentId) {
        childCountMap.set(p.parentId, (childCountMap.get(p.parentId) ?? 0) + 1);
      }
    }

    const deriveStatus = (stock: number): InventoryItem["status"] =>
      stock <= 0 ? "Out of Stock" : "Active";

    // Return ONLY top-level products — children are lazy-loaded on expand
    return raw
      .filter((p) => !p.parentId)
      .map((p): InventoryItem => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        asin: p.amazonAsin || null,
        ebayItemId: p.ebayItemId || null,
        imageUrl: null,
        price: Number(p.basePrice),
        stock: p.totalStock,
        status: deriveStatus(p.totalStock),
        isParent: p.isParent === true,
        childCount: childCountMap.get(p.id) ?? 0,
        variationTheme: p.variationTheme || null,
        parentId: null,
        variationName: null,
        variationValue: null,
        brand: p.brand || null,
        fulfillment: p.fulfillmentChannel || p.fulfillmentMethod || null,
        fulfillmentChannel: (p.fulfillmentChannel as "FBA" | "FBM" | null) || null,
        shippingTemplate: p.shippingTemplate || null,
        createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
        condition: "New",
        // No subRows — children are fetched on-demand by InventoryTable
      }));
  } catch (error) {
    console.error("[Inventory] Failed to fetch inventory data:", error);
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
