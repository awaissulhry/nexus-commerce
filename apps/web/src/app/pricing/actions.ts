"use server";

import { prisma } from "@nexus/database";
import { revalidatePath } from "next/cache";

export async function updateProductPrice(
  productId: string,
  field: "basePrice" | "costPrice" | "minPrice" | "maxPrice",
  value: number
): Promise<{ success: boolean; error?: string }> {
  try {
    await prisma.product.update({
      where: { id: productId },
      data: { [field]: value },
    });

    revalidatePath("/pricing");
    revalidatePath("/inventory");
    revalidatePath("/products");
    return { success: true };
  } catch (error) {
    console.error("Error updating price:", error);
    return { success: false, error: "Failed to update price" };
  }
}
