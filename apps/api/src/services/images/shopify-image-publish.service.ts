/** Legacy image-only publication cannot represent current native families and scoped content. */
export interface ShopifyPublishResult {
  success: boolean; message: string; poolImagesPublished: number; variantsAssigned: number; error?: string; jobId?: string
}
export async function publishShopifyImages(_productId: string, _activeAxis?: string): Promise<ShopifyPublishResult> {
  const message = 'Review and synchronise the family from Product editor → Shopify → Media. The old single-axis image publisher cannot publish scoped galleries safely.'
  return { success: false, message, poolImagesPublished: 0, variantsAssigned: 0, error: message }
}
