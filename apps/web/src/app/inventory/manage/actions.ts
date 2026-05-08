"use server";

import { prisma } from "@nexus/database";
import { revalidatePath } from "next/cache";

/**
 * Quick-save a single field (price or stock) for a product (parent or
 * variant child — both live in the Product table; child variants are
 * Products with parentId set, per TECH_DEBT #43).
 *
 * @param sku      - The SKU of the product to update
 * @param isParent - Retained for caller-API compat; the Product update path
 *                   handles parents and children identically since SKUs are
 *                   unique across the Product table.
 * @param field    - Which field to update: `"price"` or `"stock"`
 * @param value    - The new numeric value
 */
export async function quickUpdateItem(
  sku: string,
  _isParent: boolean,
  field: "price" | "stock",
  value: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const data: Record<string, any> = {};
    if (field === "price") data.basePrice = value;
    if (field === "stock") data.totalStock = value;

    await prisma.product.update({
      where: { sku },
      data,
    });

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
      // Set stock to 0 for all selected products. Variant children
      // (parentId set) are also Product rows, so the bulk update
      // catches them through the SKU `in` clause too if their SKUs
      // are passed in.
      const result = await prisma.product.updateMany({
        where: { sku: { in: skus } },
        data: { totalStock: 0 },
      });
      affected = result.count;

      // TECH_DEBT #43.5 — variants now live as Product children with
      // parentId set. To also pause their stock, pause every Product
      // whose parentId matches a paused product.
      const products = await prisma.product.findMany({
        where: { sku: { in: skus } },
        select: { id: true },
      });
      const productIds = products.map((p: any) => p.id);

      if (productIds.length > 0) {
        await prisma.product.updateMany({
          where: { parentId: { in: productIds } },
          data: { totalStock: 0 },
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
        // Delete related records first. Variant children come along
        // for free via the parentId onDelete: Cascade defined on the
        // ProductHierarchy self-relation.
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

        // Delete the products themselves (cascades to children).
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
