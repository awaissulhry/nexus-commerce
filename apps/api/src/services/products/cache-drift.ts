type ProductTruth = { id: string; totalStock: number; status: string; name: string; sku: string; basePrice: unknown; isParent: boolean; parentId: string | null; productType: string | null; version: number; updatedAt: Date; _count: { children: number; channelListings: number } }
type CachedTruth = Omit<ProductTruth, '_count'> & { childCount: number; channelCount: number; cacheRefreshedAt: Date }

/** Compare source timestamps too: a reference/alias edit may leave name, price and stock unchanged. */
export function productCacheDrifted(product: ProductTruth, cache: CachedTruth, latestListingAt?: Date) {
  return cache.totalStock !== product.totalStock || cache.status !== product.status || cache.name !== product.name ||
    cache.sku !== product.sku || String(cache.basePrice ?? '') !== String(product.basePrice ?? '') ||
    cache.isParent !== (!product.parentId && (product.isParent || product._count.children > 0)) ||
    cache.parentId !== product.parentId || cache.productType !== product.productType ||
    cache.version !== product.version || cache.updatedAt.getTime() !== product.updatedAt.getTime() ||
    cache.childCount !== product._count.children || cache.channelCount !== product._count.channelListings ||
    !!latestListingAt && latestListingAt > cache.cacheRefreshedAt
}
