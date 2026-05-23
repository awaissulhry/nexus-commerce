#!/usr/bin/env node
/**
 * IE.2.3 — Collapse near-duplicate ProductImage rows per product.
 *
 * Two grouping passes:
 *   1. Exact: rows sharing the same contentHash collapse together.
 *   2. Near : rows whose perceptualHash is within Hamming ≤ 6 of an
 *      already-kept row collapse together. Greedy single-pass — first
 *      kept row in a cluster becomes the canonical anchor.
 *
 * For each cluster the canonical is the row with the largest
 * (width × height). Ties broken by oldest createdAt.
 *
 * Repointing before delete:
 *   - ListingImage.sourceProductImageId loser → canonical
 *   - ProductImage.derivedFromImageId   loser → canonical
 *
 * Loser rows are deleted. publicId on losers is best-effort-deleted
 * from Cloudinary (rows from Amazon sync have publicId=NULL, nothing
 * to GC there).
 *
 * Dry-run is the default. Pass --commit to actually apply.
 *
 * Usage:
 *   node scripts/ie2-collapse-image-duplicates.mjs [--commit]
 *                                                   [--product=ID]
 *                                                   [--threshold=N]
 *                                                   [--exact-only]
 *                                                   [--skip-mixed-type]
 *
 *   --skip-mixed-type  drop clusters that mix ProductImage.type values
 *                      (e.g. MAIN + LIFESTYLE in one cluster). These are
 *                      usually operator-tagged duplicates but occasionally
 *                      a false positive — left alone here, triaged in
 *                      a UI surface later.
 */

import { PrismaClient } from '@prisma/client'
import { v2 as cloudinary } from 'cloudinary'

const args = process.argv.slice(2)
const commit = args.includes('--commit')
const exactOnly = args.includes('--exact-only')
const skipMixedType = args.includes('--skip-mixed-type')
const productId = (() => {
  const a = args.find((x) => x.startsWith('--product='))
  return a ? a.slice('--product='.length) : null
})()
const threshold = (() => {
  const a = args.find((x) => x.startsWith('--threshold='))
  return a ? parseInt(a.slice('--threshold='.length), 10) : 6
})()

const dbUrl = (process.env.DATABASE_URL || '').replace('-pooler', '')
const cloudinaryReady = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)
if (cloudinaryReady) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  })
}

const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) { d += x & 1; x >>>= 1 }
  }
  return d
}

// canonical = largest dimensions, oldest as tiebreak. NULL dims sort
// last so a row with measured dimensions always wins over a row
// missing them.
function pickCanonical(rows) {
  return [...rows].sort((a, b) => {
    const sa = (a.width ?? 0) * (a.height ?? 0)
    const sb = (b.width ?? 0) * (b.height ?? 0)
    if (sb !== sa) return sb - sa
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  })[0]
}

function clusterByContentHash(rows) {
  const groups = new Map()
  const single = []
  for (const r of rows) {
    if (!r.contentHash) { single.push(r); continue }
    const list = groups.get(r.contentHash) ?? []
    list.push(r)
    groups.set(r.contentHash, list)
  }
  const clusters = []
  for (const list of groups.values()) {
    if (list.length > 1) clusters.push(list)
    else single.push(list[0])
  }
  return { exactClusters: clusters, leftovers: single }
}

function clusterByPHash(rows, thr) {
  // Greedy single-pass over rows ordered by createdAt. Each row
  // either joins an existing cluster (Hamming ≤ thr against its
  // current canonical) or seeds a new cluster.
  const ordered = [...rows].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  const clusters = []
  for (const r of ordered) {
    if (!r.perceptualHash) { clusters.push([r]); continue }
    let placed = false
    for (const cluster of clusters) {
      const anchor = cluster[0]
      if (!anchor.perceptualHash) continue
      if (hammingHex(anchor.perceptualHash, r.perceptualHash) <= thr) {
        cluster.push(r)
        placed = true
        break
      }
    }
    if (!placed) clusters.push([r])
  }
  return clusters.filter((c) => c.length > 1)
}

async function processProduct(p) {
  const rows = await prisma.productImage.findMany({
    where: { productId: p.id },
    select: {
      id: true, productId: true, url: true, type: true, publicId: true,
      width: true, height: true, contentHash: true, perceptualHash: true,
      createdAt: true,
    },
  })
  if (rows.length === 0) return null

  // Pass 1 — exact contentHash collisions.
  const { exactClusters, leftovers } = clusterByContentHash(rows)

  // Pass 2 — pHash near-duplicates among the leftovers.
  const nearClusters = exactOnly ? [] : clusterByPHash(leftovers, threshold)

  let clusters = [...exactClusters, ...nearClusters]

  // --skip-mixed-type: leave clusters where ProductImage.type isn't
  // uniform across members. These are usually operator-tagged dupes
  // (same shot uploaded as both MAIN and LIFESTYLE), but a small
  // fraction are false-positive collisions where a white-bg LIFESTYLE
  // shares an aHash with a white-bg MAIN. Spot-checking each one
  // belongs in a UI surface, not a one-shot script.
  if (skipMixedType) {
    clusters = clusters.filter((cluster) => {
      const types = new Set(cluster.map((r) => r.type))
      return types.size === 1
    })
  }

  if (clusters.length === 0) return null

  const plan = []
  for (const cluster of clusters) {
    const canonical = pickCanonical(cluster)
    const losers = cluster.filter((r) => r.id !== canonical.id)
    plan.push({ canonical, losers })
  }
  return { product: p, plan }
}

async function applyPlan(productPlan) {
  let imagesDeleted = 0
  let listingRepointed = 0
  let derivedRepointed = 0
  let cloudinaryDeleted = 0
  for (const { canonical, losers } of productPlan.plan) {
    const loserIds = losers.map((l) => l.id)
    // ListingImage.sourceProductImageId is plain TEXT (no FK), so
    // updates don't cascade. Repoint losers → canonical so existing
    // channel listings keep their master link.
    const li = await prisma.listingImage.updateMany({
      where: { sourceProductImageId: { in: loserIds } },
      data: { sourceProductImageId: canonical.id },
    })
    listingRepointed += li.count
    // ProductImage.derivedFromImageId IS a FK (SetNull on delete).
    // Pre-repointing keeps the derivation chain intact; otherwise
    // derivatives would have their parent silently nulled.
    const di = await prisma.productImage.updateMany({
      where: { derivedFromImageId: { in: loserIds } },
      data: { derivedFromImageId: canonical.id },
    })
    derivedRepointed += di.count
    // Delete losers.
    const del = await prisma.productImage.deleteMany({ where: { id: { in: loserIds } } })
    imagesDeleted += del.count
    // Cloudinary GC — best-effort, never block.
    if (cloudinaryReady) {
      for (const l of losers) {
        if (!l.publicId) continue
        try {
          await cloudinary.uploader.destroy(l.publicId)
          cloudinaryDeleted++
        } catch (e) { /* orphan; manual gc later */ }
      }
    }
  }
  return { imagesDeleted, listingRepointed, derivedRepointed, cloudinaryDeleted }
}

async function main() {
  console.log(`Mode: ${commit ? 'COMMIT' : 'DRY RUN'} | threshold=${threshold} | ${exactOnly ? 'exact-only' : 'exact + near'}${skipMixedType ? ' | skip-mixed-type' : ''}\n`)

  const products = await prisma.product.findMany({
    where: productId ? { id: productId } : undefined,
    select: { id: true, sku: true, name: true },
    orderBy: { sku: 'asc' },
  })

  let touchedProducts = 0
  let totalClusters = 0
  let totalLosers = 0
  let totalLI = 0
  let totalDeriv = 0
  let totalCloud = 0

  for (const p of products) {
    const r = await processProduct(p)
    if (!r) continue
    touchedProducts++
    const losers = r.plan.reduce((acc, c) => acc + c.losers.length, 0)
    totalClusters += r.plan.length
    totalLosers += losers
    console.log(`${p.sku} (${p.id}) — ${r.plan.length} cluster(s), ${losers} loser(s)`)
    for (const cl of r.plan) {
      const c = cl.canonical
      console.log(`  canonical ${c.id} ${c.type} ${c.width ?? '?'}×${c.height ?? '?'} ← keeps`)
      for (const l of cl.losers) {
        console.log(`  loser     ${l.id} ${l.type} ${l.width ?? '?'}×${l.height ?? '?'} ${commit ? '✗ DELETE' : '(would delete)'}`)
      }
    }
    if (commit) {
      const r2 = await applyPlan(r)
      totalLI += r2.listingRepointed
      totalDeriv += r2.derivedRepointed
      totalCloud += r2.cloudinaryDeleted
      console.log(`  applied: ${r2.imagesDeleted} deleted, ${r2.listingRepointed} listing repointed, ${r2.derivedRepointed} derived repointed, ${r2.cloudinaryDeleted} Cloudinary GC`)
    }
  }

  console.log(`\nSummary:`)
  console.log(`  Products touched: ${touchedProducts}`)
  console.log(`  Clusters:         ${totalClusters}`)
  console.log(`  Losers ${commit ? 'deleted' : '(would delete)'}: ${totalLosers}`)
  if (commit) {
    console.log(`  ListingImage rows repointed: ${totalLI}`)
    console.log(`  ProductImage derivations repointed: ${totalDeriv}`)
    console.log(`  Cloudinary assets GC'd: ${totalCloud}`)
  } else {
    console.log(`\n  Add --commit to apply.`)
  }

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('Fatal:', e)
  await prisma.$disconnect()
  process.exit(1)
})
