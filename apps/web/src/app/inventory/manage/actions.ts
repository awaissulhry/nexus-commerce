"use server";

import { prisma } from "@nexus/database";
import { revalidatePath } from "next/cache";

/**
 * Quick-save a single field (price or stock) for a product or variation.
 *
 * @param sku      - The SKU of the product or variation to update
 * @param isParent - `true` → update the Product table; `false` → update ProductVariation
 * @param field    - Which field to update: `"price"` or `"stock"`
 * @param value    - The new numeric value
 */
export async function quickUpdateItem(
  sku: string,
  isParent: boolean,
  field: "price" | "stock",
  value: number
): Promise<{ success: boolean; error?: string }> {
  try {
    if (isParent) {
      // Update the Product record
      const data: Record<string, any> = {};
      if (field === "price") data.basePrice = value;
      if (field === "stock") data.totalStock = value;

      await prisma.product.update({
        where: { sku },
        data,
      });
    } else {
      // Update the ProductVariation record
      const data: Record<string, any> = {};
      if (field === "price") data.price = value;
      if (field === "stock") data.stock = value;

      await prisma.productVariation.update({
        where: { sku },
        data,
      });
    }

    revalidatePath("/inventory/manage");
    revalidatePath("/inventory");
    revalidatePath("/products");

    return { success: true };
  } catch (error: any) {
    console.error(
      `[quickUpdateItem] Failed to update ${field} for SKU "${sku}":`,
      error?.message ?? error
    );
    return {
      success: false,
      error: error?.message ?? "Unknown error",
    };
  }
}

/**
 * Bulk action on multiple products at once.
 *
 * @param skus   - Array of product SKUs to act on
 * @param action - `"pause"` sets totalStock to 0; `"delete"` removes the products
 */
export async function bulkUpdateItems(
  skus: string[],
  action: "pause" | "delete"
): Promise<{ success: boolean; affected: number; error?: string }> {
  try {
    let affected = 0;

    if (action === "pause") {
      // Set stock to 0 for all selected products (effectively pausing them)
      const result = await prisma.product.updateMany({
        where: { sku: { in: skus } },
        data: { totalStock: 0 },
      });
      affected = result.count;

      // Also pause any variations under these products
      const products = await prisma.product.findMany({
        where: { sku: { in: skus } },
        select: { id: true },
      });
      const productIds = products.map((p: any) => p.id);

      if (productIds.length > 0) {
        await prisma.productVariation.updateMany({
          where: { productId: { in: productIds } },
          data: { stock: 0 },
        });
      }
    } else if (action === "delete") {
      // Find product IDs first to cascade-delete relations
      const products = await prisma.product.findMany({
        where: { sku: { in: skus } },
        select: { id: true },
      });
      const productIds = products.map((p: any) => p.id);

      if (productIds.length > 0) {
        // Delete related records first (variations, images, syncs, stock logs)
        await prisma.productVariation.deleteMany({
          where: { productId: { in: productIds } },
        });
        await prisma.productImage.deleteMany({
          where: { productId: { in: productIds } },
        });
        await prisma.marketplaceSync.deleteMany({
          where: { productId: { in: productIds } },
        });
        await prisma.stockLog.deleteMany({
          where: { productId: { in: productIds } },
        });
        await prisma.listing.deleteMany({
          where: { productId: { in: productIds } },
        });

        // Delete the products themselves
        const result = await prisma.product.deleteMany({
          where: { id: { in: productIds } },
        });
        affected = result.count;
      }
    }

    revalidatePath("/inventory/manage");
    revalidatePath("/inventory");
    revalidatePath("/products");

    return { success: true, affected };
  } catch (error: any) {
    console.error(
      `[bulkUpdateItems] Failed to ${action} ${skus.length} item(s):`,
      error?.message ?? error
    );
    return {
      success: false,
      affected: 0,
      error: error?.message ?? "Unknown error",
    };
  }
}
