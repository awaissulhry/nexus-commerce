import type { InventoryItem } from "@/types/inventory";
import ManageInventoryClient from "./ManageInventoryClient";
import { getBackendUrl } from "@/lib/backend-url";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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
      console.error(`[Inventory/Manage] API returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    const raw: ApiProduct[] = data.products ?? [];

    const childCountMap = new Map<string, number>();
    for (const p of raw) {
      if (p.parentId) {
        childCountMap.set(p.parentId, (childCountMap.get(p.parentId) ?? 0) + 1);
      }
    }

    const deriveStatus = (stock: number): InventoryItem["status"] =>
      stock <= 0 ? "Out of Stock" : "Active";

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
    console.error("[Inventory/Manage] Failed to fetch:", error);
    return [];
  }
}

export default async function ManageInventoryPage() {
  const data = await getInventoryData();
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Master Catalog</h1>
          <p className="text-xs text-slate-500 mt-1 tracking-tight">Amazon Seller Central 1:1 Replication</p>
        </div>
        <div className="flex items-center gap-3">
          <a href="/inventory/upload" className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors tracking-tight">
            📤 Bulk Upload
          </a>
          <button className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors tracking-tight">
            ➕ Add Product
          </button>
        </div>
      </div>
      <ManageInventoryClient data={data} />
    </div>
  );
}
