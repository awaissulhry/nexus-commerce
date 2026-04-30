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
  fulfillmentChannel: string | null;
  fulfillmentMethod: string | null;
  shippingTemplate: string | null;
  brand: string | null;
  createdAt: string;
  updatedAt: string;
}

async function getInventoryData(): Promise<InventoryItem[]> {
  try {
    const res = await fetch(
      `${getBackendUrl()}/api/amazon/products/list`,
      { cache: "no-store" }
    );

    if (!res.ok) {
      console.error(`[Inventory/Manage] API returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    const raw: ApiProduct[] = data.products ?? [];

    console.log(`[Inventory/Manage] API returned ${raw.length} products`);

    const deriveStatus = (stock: number): InventoryItem["status"] => {
      if (stock <= 0) return "Out of Stock";
      return "Active";
    };

    const childMap = new Map<string, ApiProduct[]>();
    for (const p of raw) {
      if (p.parentId) {
        const arr = childMap.get(p.parentId) ?? [];
        arr.push(p);
        childMap.set(p.parentId, arr);
      }
    }

    const topLevel = raw.filter((p) => !p.parentId);

    return topLevel.map((product): InventoryItem => {
      const children = childMap.get(product.id) ?? [];

      const subRows: InventoryItem[] = children.map((child): InventoryItem => ({
        id: child.id,
        sku: child.sku,
        name: child.name,
        asin: child.amazonAsin || null,
        ebayItemId: child.ebayItemId || null,
        imageUrl: null,
        price: Number(child.basePrice),
        stock: child.totalStock,
        status: deriveStatus(child.totalStock),
        isParent: false,
        variationName: child.name || null,
        variationValue: null,
        brand: product.brand || null,
        fulfillment: child.fulfillmentMethod || product.fulfillmentMethod || null,
        fulfillmentChannel: (child.fulfillmentChannel as "FBA" | "FBM" | null) || null,
        shippingTemplate: child.shippingTemplate || null,
        createdAt: child.createdAt ? new Date(child.createdAt).toISOString() : null,
        condition: "New",
        channels: undefined,
        channelData: undefined,
      }));

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
        variationName: null,
        variationValue: null,
        brand: product.brand || null,
        fulfillment: product.fulfillmentChannel || product.fulfillmentMethod || null,
        fulfillmentChannel: (product.fulfillmentChannel as "FBA" | "FBM" | null) || null,
        shippingTemplate: product.shippingTemplate || null,
        createdAt: product.createdAt ? new Date(product.createdAt).toISOString() : null,
        condition: "New",
        channels: undefined,
        subRows: product.isParent === true && subRows.length > 0 ? subRows : undefined,
      };
    });
  } catch (error) {
    console.error("[Inventory/Manage] Failed to fetch inventory data:", error);
    return [];
  }
}

export default async function ManageInventoryPage() {
  const data = await getInventoryData();

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Master Catalog
          </h1>
          <p className="text-xs text-slate-500 mt-1 tracking-tight">
            Amazon Seller Central 1:1 Replication
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/inventory/upload"
            className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors tracking-tight"
          >
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
