#!/usr/bin/env node
/**
 * PG.2 — re-backfill ProductReadCache.imageUrl using the new picker:
 *   1. type='MAIN' with lowest sortOrder
 *   2. lowest sortOrder regardless of type
 *   3. lowest createdAt
 *   PLUS: parent → first-child-with-images fallback (child ordered by
 *   sku ASC for stability).
 *
 * Supersedes scripts/pg-1-backfill-cache-images.mjs which used the
 * createdAt-only picker. Idempotent.
 *
 * Usage: node scripts/pg-2-backfill-cache-images.mjs
 */

import { PrismaClient } from '@prisma/client'

const url = (process.env.DATABASE_URL ?? '').replace('-pooler', '')
if (!url) {
  console.error('DATABASE_URL not set')
  process.exit(1)
}

const prisma = new PrismaClient({ datasources: { db: { url } } })

const FACE_ORDER = [{ sortOrder: 'asc' }, { createdAt: 'asc' }]

function pickFaceImage(images) {
  if (!images || images.length === 0) return null
  const main = images.find((i) => i.type === 'MAIN')
  return main?.url ?? images[0]?.url ?? null
}

async function main() {
  const products = await prisma.product.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      sku: true,
      isParent: true,
      images: {
        take: 12,
        orderBy: FACE_ORDER,
        select: { url: true, type: true, sortOrder: true, createdAt: true },
      },
      _count: { select: { images: true } },
    },
  })

  let updated = 0
  let withImage = 0
  let parentFromChild = 0

  for (const p of products) {
    let imageUrl = pickFaceImage(p.images)

    if (!imageUrl && p.isParent) {
      const firstChild = await prisma.product.findFirst({
        where: {
          parentId: p.id,
          deletedAt: null,
          images: { some: {} },
        },
        orderBy: { sku: 'asc' },
        select: {
          images: {
            take: 12,
            orderBy: FACE_ORDER,
            select: { url: true, type: true, sortOrder: true, createdAt: true },
          },
        },
      })
      if (firstChild) {
        imageUrl = pickFaceImage(firstChild.images)
        if (imageUrl) parentFromChild++
      }
    }

    const photoCount = p._count.images
    try {
      await prisma.productReadCache.update({
        where: { id: p.id },
        data: { imageUrl, photoCount, cacheRefreshedAt: new Date() },
      })
      updated++
      if (imageUrl) withImage++
    } catch (err) {
      if (!String(err).includes('Record to update not found')) throw err
    }
  }

  console.log(
    `Updated ${updated} cache rows (${withImage} have imageUrl; ${parentFromChild} parents now borrow a child's image)`,
  )
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  prisma.$disconnect().finally(() => process.exit(1))
})
