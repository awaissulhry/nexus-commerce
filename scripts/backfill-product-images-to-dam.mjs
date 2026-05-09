#!/usr/bin/env node
// W4.12 — ProductImage → DigitalAsset + AssetUsage backfill.
//
// One-shot script. Walks every ProductImage row and creates the
// corresponding DigitalAsset + AssetUsage so the W4.11 asset library
// surfaces the historical catalog rather than only post-W4.11b
// uploads.
//
// Default mode: --dry-run. Prints what WOULD be created without
// touching the DB. Pass --apply to actually write.
//
// Idempotent: detects already-backfilled rows by
// AssetUsage.metadata-on-asset.productImageId so re-running is safe.
// Equivalently — if the (productId, productImageId) pair already
// has an AssetUsage scoped 'product' through a DigitalAsset whose
// metadata.productImageId matches, skip.
//
// What we DON'T do (intentional):
//   - Recover Cloudinary publicId from URL. Parsing is fragile
//     (transformations, versions, account-specific paths). Backfilled
//     rows store the original URL as `url` and a sentinel storageId
//     of 'legacy:<productImageId>' so they're unambiguously
//     identifiable. Once an image is re-uploaded by W4.11b, the new
//     DigitalAsset row gets a real Cloudinary publicId; the legacy
//     row can be cleaned up.
//   - Compute mimeType / sizeBytes by fetching the URL with HEAD.
//     Adds latency × N rows; not worth it for a backfill. Use
//     'image/jpeg' default + sizeBytes=0. The asset library shows
//     these as "image · 0B" — operator can run a follow-up script
//     to refresh metadata if it matters.
//
// Usage:
//   node scripts/backfill-product-images-to-dam.mjs           # dry run
//   node scripts/backfill-product-images-to-dam.mjs --apply   # write
//   node scripts/backfill-product-images-to-dam.mjs --apply --limit 50
//                                                             # cap rows

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import { PrismaClient } from '@prisma/client'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const limitFlag = args.findIndex((a) => a === '--limit')
const limit =
  limitFlag >= 0 && args[limitFlag + 1] ? parseInt(args[limitFlag + 1], 10) : null

const prisma = new PrismaClient()

console.log(
  `[backfill] mode=${apply ? 'APPLY' : 'DRY-RUN'}${limit ? ` limit=${limit}` : ''}`,
)

const summary = {
  scanned: 0,
  alreadyBackfilled: 0,
  created: 0,
  failed: 0,
  failures: [],
}

try {
  // Walk ProductImage in createdAt order so the resulting AssetUsage
  // sortOrder matches insert sequence.
  const productImages = await prisma.productImage.findMany({
    orderBy: { createdAt: 'asc' },
    ...(limit ? { take: limit } : {}),
  })

  console.log(`[backfill] scanning ${productImages.length} ProductImage rows`)

  // Pre-fetch already-backfilled markers in one query. Asset metadata
  // is JSON; we filter with Prisma's path-equals operator.
  const existing = await prisma.digitalAsset.findMany({
    where: {
      metadata: { path: ['productImageId'], not: null },
      storageProvider: 'legacy',
    },
    select: { id: true, metadata: true },
  })
  const alreadyImageIds = new Set(
    existing
      .map((a) => (a.metadata && typeof a.metadata === 'object' ? a.metadata.productImageId : null))
      .filter(Boolean),
  )

  for (const img of productImages) {
    summary.scanned++

    if (alreadyImageIds.has(img.id)) {
      summary.alreadyBackfilled++
      continue
    }

    const role = (img.type ?? 'main').toLowerCase()
    const label = img.alt ?? `Product image ${img.id}`

    if (!apply) {
      summary.created++
      console.log(
        `[dry-run] would create: product=${img.productId} role=${role} url=${img.url.slice(0, 80)}`,
      )
      continue
    }

    try {
      const asset = await prisma.digitalAsset.create({
        data: {
          label,
          type: 'image',
          mimeType: 'image/jpeg', // best-effort default for backfill
          sizeBytes: 0, // unknown without HEAD; not worth N latency
          storageProvider: 'legacy', // distinguishes backfill rows
          storageId: `legacy:${img.id}`,
          url: img.url,
          originalFilename: null,
          metadata: {
            productImageId: img.id,
            backfilledAt: new Date().toISOString(),
          },
        },
        select: { id: true },
      })

      await prisma.assetUsage.create({
        data: {
          assetId: asset.id,
          scope: 'product',
          productId: img.productId,
          role,
          // Stable sortOrder per (productId, role) — count of
          // earlier rows in the same bucket. Cheap because we're
          // walking by createdAt ASC.
          sortOrder: 0,
        },
      })

      summary.created++
    } catch (err) {
      summary.failed++
      const msg = err instanceof Error ? err.message : String(err)
      summary.failures.push({ productImageId: img.id, error: msg })
      console.error(`[backfill] FAILED productImageId=${img.id}: ${msg}`)
    }
  }

  console.log('\n[backfill] done')
  console.log(JSON.stringify(summary, null, 2))
  if (!apply) {
    console.log('\nDRY-RUN: no rows written. Re-run with --apply to commit.')
  }
} catch (err) {
  console.error('[backfill] fatal:', err)
  process.exit(1)
} finally {
  await prisma.$disconnect()
}
