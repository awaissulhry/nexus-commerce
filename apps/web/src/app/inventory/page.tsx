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
    const res = await fetch(
      `${getBackendUrl()}/api/amazon/products/list?topLevelOnly=1&limit=50`,
      { cache: "no-store" }
    );
    if (!res.ok) {
      console.error(`[Inventory] API returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    // Backend returns top-level products only with childCount already computed
    const raw: (ApiProduct & { childCount?: number })[] = data.products ?? [];

    console.log(`[Inventory] ${raw.length} top-level products (total: ${data.total})`);

    const deriveStatus = (stock: number): InventoryItem["status"] =>
      stock <= 0 ? "Out of Stock" : "Active";

    return raw.map((p): InventoryItem => ({
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
      childCount: p.childCount ?? 0,
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
