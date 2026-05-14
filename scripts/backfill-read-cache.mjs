#!/usr/bin/env node
/**
 * ES.3 — One-shot backfill for ProductReadCache.
 *
 * Iterates every Product in the DB (cursor-paginated, 100 at a time)
 * and upserts a ProductReadCache row for each one.
 *
 * Run: node scripts/backfill-read-cache.mjs
 */

import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const prisma = new PrismaClient()

async function refreshOne(product) {
  const [listings, countRows] = await Promise.all([
    prisma.channelListing.findMany({
      where: { productId: product.id },
      select: {
        channel: true,
        marketplace: true,
        region: true,
        listingStatus: true,
        lastSyncStatus: true,
        isPublished: true,
      },
    }),
    prisma.product.findUnique({
      where: { id: product.id },
      select: {
        _count: {
          select: {
            images: true,
            channelListings: true,
            variations: true,
            children: true,
          },
        },
        images: {
          take: 1,
          orderBy: { createdAt: 'asc' },
          select: { url: true },
        },
        family: { select: { id: true, code: true, label: true } },
        workflowStage: {
          select: {
            id: true,
            code: true,
            label: true,
            isPublishable: true,
            isTerminal: true,
            workflow: { select: { id: true, code: true, label: true } },
          },
        },
      },
    }),
  ])

  if (!countRows) return

  const channelKeys = []
  const coverageMap = {}

  for (const l of listings) {
    const key = `${l.channel}_${l.marketplace ?? l.region ?? 'MAIN'}`
    if (!channelKeys.includes(key)) channelKeys.push(key)
    if (!coverageMap[l.channel]) {
      coverageMap[l.channel] = { live: 0, draft: 0, error: 0, total: 0 }
    }
    coverageMap[l.channel].total++
    if (l.isPublished && l.listingStatus === 'ACTIVE') {
      coverageMap[l.channel].live++
    } else if (l.lastSyncStatus === 'FAILED' || l.listingStatus === 'ERROR') {
      coverageMap[l.channel].error++
    } else {
      coverageMap[l.channel].draft++
    }
  }

  const data = {
    sku: product.sku,
    name: product.name,
    brand: product.brand ?? null,
    basePrice: product.basePrice ?? null,
    totalStock: product.totalStock ?? 0,
    lowStockThreshold: product.lowStockThreshold ?? null,
    status: product.status,
    syncChannels: product.syncChannels ?? [],
    productType: product.productType ?? null,
    fulfillmentMethod: product.fulfillmentMethod ?? null,
    isParent: product.isParent ?? false,
    parentId: product.parentId ?? null,
    version: product.version ?? 0,
    familyId: product.familyId ?? null,
    familyJson: countRows.family ?? null,
    workflowStageId: product.workflowStageId ?? null,
    workflowStageJson: countRows.workflowStage ?? null,
    imageUrl: countRows.images[0]?.url ?? null,
    photoCount: countRows._count.images,
    channelCount: countRows._count.channelListings,
    variantCount: countRows._count.variations,
    childCount: countRows._count.children,
    hasDescription: !!(product.description && product.description.trim().length > 0),
    hasBrand: !!(product.brand && product.brand.trim().length > 0),
    hasGtin: !!(product.gtin && product.gtin.trim().length > 0),
    hasPhotos: countRows._count.images > 0,
    channelKeys,
    coverageJson: Object.keys(coverageMap).length > 0 ? coverageMap : null,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    deletedAt: product.deletedAt ?? null,
    cacheRefreshedAt: new Date(),
  }

  await prisma.productReadCache.upsert({
    where: { id: product.id },
    create: { id: product.id, ...data },
    update: data,
  })
}

async function run() {
  console.log('Starting ProductReadCache backfill…')
  let cursor = undefined
  let total = 0
  let batch = 0

  while (true) {
    const products = await prisma.product.findMany({
      take: 100,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        sku: true,
        name: true,
        brand: true,
        basePrice: true,
        totalStock: true,
        lowStockThreshold: true,
        status: true,
        syncChannels: true,
        productType: true,
        fulfillmentMethod: true,
        isParent: true,
        parentId: true,
        version: true,
        description: true,
        gtin: true,
        familyId: true,
        workflowStageId: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
      },
    })

    if (products.length === 0) break

    batch++
    process.stdout.write(`  Batch ${batch}: ${products.length} products… `)
    await Promise.all(products.map(refreshOne))
    total += products.length
    console.log(`✓ (${total} total)`)

    cursor = products[products.length - 1].id
  }

  console.log(`\nDone. ${total} ProductReadCache rows upserted.`)
}

run()
  .catch((err) => {
    console.error('Backfill failed:', err.message)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
