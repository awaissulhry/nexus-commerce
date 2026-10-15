import type { Prisma } from '@prisma/client'

type Db = Pick<Prisma.TransactionClient, 'productImage' | 'digitalAsset'>
const MEDIA_FILE = /^gid:\/\/shopify\/(MediaImage|Video|Model3d)\/\d+$/
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/**
 * The library photos that already are files of one Shopify store — linked from its Files, or uploaded there by Nexus
 * (`media-library.service.ts`): library row id → that store's file id. A send reuses the file instead of uploading a copy
 * (`publishContentImages`). A photo of another store, or any other photo, is not in the map and is uploaded as before.
 */
export async function shopifyStoreFiles(db: Db, accountId: string, imageIds: readonly string[]): Promise<Record<string, string>> {
  const ids = [...new Set(imageIds)]
  if (!ids.length) return {}
  const images = await db.productImage.findMany({ where: { id: { in: ids }, sourceAssetId: { not: null } }, select: { id: true, sourceAssetId: true } })
  if (!images.length) return {}
  const assets = await db.digitalAsset.findMany({ where: { id: { in: [...new Set(images.map(image => image.sourceAssetId!))] }, storageProvider: 'shopify' },
    select: { id: true, storageId: true, metadata: true } })
  const fileOf = new Map(assets.filter(asset => record(asset.metadata).shopifyAccountId === accountId && MEDIA_FILE.test(asset.storageId)).map(asset => [asset.id, asset.storageId]))
  return Object.fromEntries(images.flatMap(image => fileOf.has(image.sourceAssetId!) ? [[image.id, fileOf.get(image.sourceAssetId!)!]] : []))
}
