/**
 * One-off backfill: rewrite any ProductImage row whose Amazon URL carries a
 * size modifier (e.g. `_SL75_`) to the base full-resolution URL, across ALL
 * products. Clears the now-stale width/height (they described the thumbnail).
 * Dedupes: if the product already has the full-res row, the thumbnail row is
 * deleted instead of duplicated. dryRun reports counts + samples without
 * writing. See normalize-amazon-image-url.ts.
 */

import prisma from '../../db.js'
import { normalizeAmazonImageUrl } from './normalize-amazon-image-url.js'

export async function backfillNormalizeProductImageUrls(opts: { dryRun: boolean }): Promise<{
  dryRun: boolean
  scanned: number
  candidates: number
  updated: number
  deletedDup: number
  samples: { from: string; to: string }[]
}> {
  const rows = await prisma.productImage.findMany({
    where: { url: { contains: '/images/I/' } },
    select: { id: true, productId: true, url: true },
  })

  let candidates = 0
  let updated = 0
  let deletedDup = 0
  const samples: { from: string; to: string }[] = []

  for (const r of rows) {
    const norm = normalizeAmazonImageUrl(r.url)
    if (norm === r.url) continue
    candidates++
    if (samples.length < 20) samples.push({ from: r.url, to: norm })
    if (opts.dryRun) continue

    // If the product already has a row at the full-res URL, drop this
    // (thumbnail) row rather than create a duplicate.
    const dup = await prisma.productImage.findFirst({
      where: { productId: r.productId, url: norm, id: { not: r.id } },
      select: { id: true },
    })
    if (dup) {
      await prisma.productImage.delete({ where: { id: r.id } })
      deletedDup++
    } else {
      await prisma.productImage.update({
        where: { id: r.id },
        data: { url: norm, width: null, height: null },
      })
      updated++
    }
  }

  return { dryRun: opts.dryRun, scanned: rows.length, candidates, updated, deletedDup, samples }
}
