#!/usr/bin/env node
/**
 * PG.1a — backfill ProductReadCache.imageUrl + photoCount from live
 * ProductImage data.
 *
 * Why: after the 2026-05-20 wipe + reseed, images were attached to
 * Products without firing IMAGES_UPDATED ProductEvents, so the
 * readCacheQueue never refreshed and every cache row landed with
 * imageUrl=NULL. The /products grid reads from the cache (useCache
 * path in products.routes.ts), so every row shows the empty thumb.
 *
 * Matches the cache service's image-pick policy: first image by
 * createdAt ASC (consistent with product-read-cache.service.ts:54-58
 * and products.routes.ts:677-680). PG.3 will reconsider switching to
 * sortOrder ASC.
 *
 * Idempotent — safe to re-run.
 *
 * Usage: node scripts/pg-1-backfill-cache-images.mjs
 */

import { PrismaClient } from '@prisma/client'

const url = (process.env.DATABASE_URL ?? '').replace('-pooler', '')
if (!url) {
  console.error('DATABASE_URL not set')
  process.exit(1)
}

const prisma = new PrismaClient({ datasources: { db: { url } } })

async function main() {
  const products = await prisma.product.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      images: {
        take: 1,
        orderBy: { createdAt: 'asc' },
        select: { url: true },
      },
      _count: { select: { images: true } },
    },
  })

  let updated = 0
  let withImage = 0
  for (const p of products) {
    const imageUrl = p.images[0]?.url ?? null
    const photoCount = p._count.images
    try {
      await prisma.productReadCache.update({
        where: { id: p.id },
        data: { imageUrl, photoCount, cacheRefreshedAt: new Date() },
      })
      updated++
      if (imageUrl) withImage++
    } catch (err) {
      // Cache row may not exist yet for very new products; skip.
      if (!String(err).includes('Record to update not found')) throw err
    }
  }

  console.log(`Updated ${updated} cache rows (${withImage} now have imageUrl)`)
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  prisma.$disconnect().finally(() => process.exit(1))
})
