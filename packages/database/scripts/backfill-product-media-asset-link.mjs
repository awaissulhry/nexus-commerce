// MM.8 — backfill ProductImage.sourceAssetId from the DAM, completing the
// bidirectional link. Matches on the Cloudinary publicId↔storageId pair the
// upload tee already shares. Idempotent + safe (only sets a reference; never
// deletes). Run: DATABASE_URL=<prod> node scripts/backfill-product-media-asset-link.mjs
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const imgs = await prisma.productImage.findMany({
  where: { sourceAssetId: null, publicId: { not: null } },
  select: { id: true, publicId: true },
})
const publicIds = [...new Set(imgs.map((i) => i.publicId).filter(Boolean))]

const assets = publicIds.length
  ? await prisma.digitalAsset.findMany({
      where: { storageProvider: 'cloudinary', storageId: { in: publicIds } },
      select: { id: true, storageId: true },
    })
  : []
const byStorageId = new Map(assets.map((a) => [a.storageId, a.id]))

let linked = 0
for (const img of imgs) {
  const assetId = byStorageId.get(img.publicId)
  if (assetId) {
    await prisma.productImage.update({ where: { id: img.id }, data: { sourceAssetId: assetId } })
    linked += 1
  }
}

console.log(`Linked ${linked} of ${imgs.length} unlinked ProductImage rows to DAM assets.`)
await prisma.$disconnect()
