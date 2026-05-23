#!/usr/bin/env node
/**
 * IE.2.1 — Backfill contentHash + perceptualHash on every existing
 * ProductImage row.
 *
 * Fetches each row's URL once and computes both hashes in one pass:
 *   • contentHash: SHA-256 hex of the raw bytes. Catches exact
 *     re-uploads (same JPEG submitted twice).
 *   • perceptualHash: local aHash via sharp (8×8 grayscale →
 *     64-bit fingerprint, 16 hex chars). Catches resolution /
 *     quality variants — the actual shape of the Amazon-synced
 *     "same image at 2250 / 500 / 75 px" duplication.
 *
 * Same algorithm the IE.1 upload route uses → backfilled rows are
 * directly comparable to future uploads via the dedup gate.
 *
 * Idempotent: rows with both hashes populated are skipped.
 * Resumable: SIGINT mid-run leaves partial state; next run picks up
 *   where it left off because the filter checks the NULL columns.
 *
 * Usage:
 *   node scripts/ie2-backfill-image-hashes.mjs [--limit=N] [--product=ID]
 *
 *   --limit=N        cap rows processed in this run (default: all)
 *   --product=ID     scope to one product (handy for spot-check)
 *   --skip-phash     only backfill contentHash (faster, no sharp decode)
 *   --concurrency=N  parallel workers (default 8). Bound by Amazon
 *                    image CDN rate limit + sharp decode CPU.
 *
 * Reads DATABASE_URL from .env at repo root. Strips -pooler to mirror
 * the migrate-deploy convention.
 */

import { PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'
import sharp from 'sharp'

const args = process.argv.slice(2)
const limit = (() => {
  const a = args.find((x) => x.startsWith('--limit='))
  return a ? parseInt(a.slice('--limit='.length), 10) : null
})()
const productId = (() => {
  const a = args.find((x) => x.startsWith('--product='))
  return a ? a.slice('--product='.length) : null
})()
const skipPhash = args.includes('--skip-phash')
const concurrency = (() => {
  const a = args.find((x) => x.startsWith('--concurrency='))
  return a ? Math.max(1, parseInt(a.slice('--concurrency='.length), 10)) : 8
})()

// Neon pooler URL breaks prisma migrate; the runtime client tolerates
// pooler but mirroring the migrate behaviour keeps the env single-source.
const dbUrl = (process.env.DATABASE_URL || '').replace('-pooler', '')
if (!dbUrl) {
  console.error('DATABASE_URL not set in .env')
  process.exit(1)
}

const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

async function fetchBytes(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

// Same algorithm as apps/api/src/services/images/image-hash.service.ts
// aHashBuffer(). Duplicated here so this script runs without the
// API workspace's TS build step; behavior must stay in sync (any
// change requires updating both).
async function aHash(buf) {
  const pixels = await sharp(buf).resize(8, 8, { fit: 'fill' }).grayscale().raw().toBuffer()
  if (pixels.length !== 64) throw new Error(`aHash: expected 64 pixels, got ${pixels.length}`)
  let sum = 0
  for (let i = 0; i < 64; i++) sum += pixels[i]
  const mean = sum / 64
  let hex = ''
  for (let nibble = 0; nibble < 16; nibble++) {
    let v = 0
    for (let bit = 0; bit < 4; bit++) {
      const pi = nibble * 4 + bit
      if (pixels[pi] > mean) v |= 1 << (3 - bit)
    }
    hex += v.toString(16)
  }
  return hex
}

async function main() {
  const where = {
    OR: [
      { contentHash: null },
      ...(skipPhash ? [] : [{ perceptualHash: null }]),
    ],
    ...(productId ? { productId } : {}),
  }

  const total = await prisma.productImage.count({ where })
  console.log(`Found ${total} ProductImage row(s) needing backfill${productId ? ` (product ${productId})` : ''}`)
  if (total === 0) {
    await prisma.$disconnect()
    return
  }

  const cap = limit ?? total
  const rows = await prisma.productImage.findMany({
    where,
    select: { id: true, url: true, contentHash: true, perceptualHash: true },
    orderBy: { createdAt: 'asc' },
    take: cap,
  })

  let ok = 0
  let failed = 0
  let done = 0
  // Simple worker pool: N parallel processRow() chains pulling from a
  // shared cursor. Bounded by `concurrency` so we don't flood Amazon's
  // image CDN or pin all cores on sharp decode.
  let cursor = 0
  async function processRow(row, n) {
    const tag = `[${n}/${rows.length}] ${row.id}`
    try {
      const buf = await fetchBytes(row.url)
      const patch = {}
      if (!row.contentHash) patch.contentHash = sha256(buf)
      if (!skipPhash && !row.perceptualHash) {
        try {
          patch.perceptualHash = await aHash(buf)
        } catch (e) {
          console.warn(`${tag} pHash skipped: ${e?.message ?? e}`)
        }
      }
      if (Object.keys(patch).length > 0) {
        await prisma.productImage.update({ where: { id: row.id }, data: patch })
        ok++
        const parts = Object.keys(patch).join('+')
        if (n % 50 === 0 || n === rows.length) {
          console.log(`${tag} ✓ ${parts}`)
        }
      }
    } catch (e) {
      failed++
      console.error(`${tag} ✗ ${e?.message ?? e}`)
    } finally {
      done++
    }
  }
  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= rows.length) return
      await processRow(rows[i], i + 1)
    }
  }
  console.log(`Processing with concurrency=${concurrency}…`)
  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  console.log(`\nBackfill complete: ${ok} updated, ${failed} failed, ${rows.length - ok - failed} unchanged`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('Fatal:', e)
  await prisma.$disconnect()
  process.exit(1)
})
