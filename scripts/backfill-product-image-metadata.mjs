#!/usr/bin/env node
// IR.2.4 — ProductImage asset metadata backfill.
//
// Walks every ProductImage with NULL width and populates width/height/
// mimeType/fileSize. Pre-IR.2 uploads stored none of this; IR.2.2 wires
// new uploads to capture it, this script covers the historical catalog
// in one pass.
//
// Default mode: --dry-run. Prints what WOULD be updated, no DB writes.
// Pass --apply to actually update.
//
// Idempotent: only touches rows where width IS NULL. Re-running picks
// up new NULL rows (e.g. rows imported from a sync that didn't capture
// metadata) without disturbing already-filled rows.
//
// Lookup strategy:
//   - publicId present  → Cloudinary admin API resources.resource(publicId)
//                          gives width/height/format/bytes — full set.
//   - publicId NULL     → HTTP HEAD on the URL for content-type +
//                          content-length. No dimensions (would need a
//                          full image fetch + sharp). Better than NULL
//                          for filtering; IR.6 vision pass will fill
//                          dimensions later.
//
// Usage:
//   node scripts/backfill-product-image-metadata.mjs              # dry run
//   node scripts/backfill-product-image-metadata.mjs --apply      # write
//   node scripts/backfill-product-image-metadata.mjs --apply --limit 50
//                                                                 # cap rows
//   node scripts/backfill-product-image-metadata.mjs --apply --batch 50
//                                                                 # smaller batches
//   node scripts/backfill-product-image-metadata.mjs --apply --cloudinary-only
//                                                                 # skip rows w/o publicId

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import { v2 as cloudinary } from 'cloudinary'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
dotenv.config({ path: path.join(here, '..', 'apps', 'api', '.env') })

const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()

const APPLY = process.argv.includes('--apply')
const CLOUDINARY_ONLY = process.argv.includes('--cloudinary-only')
const LIMIT = parseIntArg('--limit', null)
const BATCH = parseIntArg('--batch', 100)

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

if (!process.env.CLOUDINARY_CLOUD_NAME) {
  console.error('❌ CLOUDINARY_CLOUD_NAME missing — set it in .env or apps/api/.env')
  process.exit(1)
}

function parseIntArg(flag, fallback) {
  const idx = process.argv.indexOf(flag)
  if (idx === -1 || idx === process.argv.length - 1) return fallback
  const v = parseInt(process.argv[idx + 1], 10)
  return Number.isFinite(v) ? v : fallback
}

function formatToMimeType(format) {
  if (!format) return null
  const f = format.toLowerCase()
  if (f === 'jpg' || f === 'jpeg') return 'image/jpeg'
  if (f === 'png')  return 'image/png'
  if (f === 'webp') return 'image/webp'
  if (f === 'gif')  return 'image/gif'
  if (f === 'svg')  return 'image/svg+xml'
  if (f === 'avif') return 'image/avif'
  if (f === 'heic' || f === 'heif') return 'image/heic'
  return `image/${f}`
}

async function lookupCloudinary(publicId) {
  try {
    const r = await cloudinary.api.resource(publicId, { resource_type: 'image' })
    return {
      width: r.width,
      height: r.height,
      fileSize: r.bytes,
      mimeType: formatToMimeType(r.format),
      source: 'cloudinary',
    }
  } catch (err) {
    return { error: err?.error?.message ?? err?.message ?? 'cloudinary lookup failed', source: 'cloudinary' }
  }
}

async function lookupHttp(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' })
    if (!res.ok) return { error: `HEAD ${res.status}`, source: 'http' }
    const contentType = res.headers.get('content-type')
    const contentLength = res.headers.get('content-length')
    return {
      width: null,
      height: null,
      mimeType: contentType ? contentType.split(';')[0].trim() : null,
      fileSize: contentLength ? parseInt(contentLength, 10) : null,
      source: 'http',
    }
  } catch (err) {
    return { error: err?.message ?? 'fetch failed', source: 'http' }
  }
}

async function main() {
  const where = { width: null }
  const total = await prisma.productImage.count({ where })
  console.log(`→ ${total} ProductImage row(s) have NULL width`)
  if (total === 0) {
    console.log('✓ Nothing to backfill.')
    await prisma.$disconnect()
    return
  }

  const take = LIMIT ?? total
  const stats = { cloudinary: 0, http: 0, skipped: 0, errors: 0, updated: 0 }
  let cursor = null
  let processed = 0

  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'} · batch=${BATCH} · limit=${LIMIT ?? 'none'} · cloudinaryOnly=${CLOUDINARY_ONLY}`)
  console.log('')

  while (processed < take) {
    const batchSize = Math.min(BATCH, take - processed)
    const rows = await prisma.productImage.findMany({
      where,
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, url: true, publicId: true, type: true, productId: true },
    })
    if (rows.length === 0) break

    for (const row of rows) {
      let result
      if (row.publicId) {
        result = await lookupCloudinary(row.publicId)
      } else if (CLOUDINARY_ONLY) {
        stats.skipped++
        continue
      } else {
        result = await lookupHttp(row.url)
      }

      if (result.error) {
        stats.errors++
        console.log(`  ✗ ${row.id} (${row.type}) [${result.source}] — ${result.error}`)
        continue
      }

      stats[result.source]++
      const summary = `${result.width ?? '?'}×${result.height ?? '?'} ${result.mimeType ?? '?'} ${result.fileSize ?? '?'}B`
      if (APPLY) {
        await prisma.productImage.update({
          where: { id: row.id },
          data: {
            width: result.width ?? undefined,
            height: result.height ?? undefined,
            mimeType: result.mimeType ?? undefined,
            fileSize: result.fileSize ?? undefined,
          },
        })
        stats.updated++
      }
      if (processed < 5 || processed % 25 === 0) {
        console.log(`  ${APPLY ? '✓' : '·'} ${row.id} (${row.type}) → ${summary}`)
      }
      processed++
    }

    cursor = rows[rows.length - 1].id
    if (rows.length < batchSize) break
  }

  console.log('')
  console.log('── Summary ───────────────────────────────────────────')
  console.log(`  Cloudinary lookups:  ${stats.cloudinary}`)
  console.log(`  HTTP HEAD lookups:   ${stats.http}`)
  console.log(`  Skipped (no publicId): ${stats.skipped}`)
  console.log(`  Errors:              ${stats.errors}`)
  console.log(`  ${APPLY ? 'Updated' : 'Would update'}: ${APPLY ? stats.updated : (stats.cloudinary + stats.http)}`)
  console.log('')
  if (!APPLY) console.log('Dry-run only. Re-run with --apply to write.')

  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error('Backfill failed:', err)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
