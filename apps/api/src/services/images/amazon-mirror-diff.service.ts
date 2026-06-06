/**
 * M4 — Pre-publish mirror diff.
 *
 * Computes exactly what an exact-mirror publish WOULD do to Amazon, per ASIN,
 * by comparing Nexus's desired state (computeExactMirror) against Amazon's
 * current live state (ChannelLiveImage):
 *   - adds     — a slot Nexus fills that Amazon doesn't have
 *   - replaces — a slot both have, different image
 *   - deletes  — a slot Amazon has that Nexus does NOT fill (will be REMOVED)
 *   - skipped  — ASIN has no MAIN in Nexus → left untouched (never wiped)
 *
 * `deletes` only lists slots that are actually live (so the "will remove N"
 * count is real, not theoretical). This is the safety surface the operator
 * sees before publishing.
 */

// deploy-sync(image-mirror): touches apps/api so Railway redeploys the API
// alongside the Vercel web build. Safe no-op marker.
import prisma from '../../db.js'
import { resolveAmazonImages } from './amazon-image-feed.service.js'
import { resolveSlotTaxonomy } from './amazon-slot-taxonomy.service.js'
import { computeExactMirror } from './amazon-exact-mirror.js'
import { normalizeAmazonImageUrl } from './normalize-amazon-image-url.js'

export interface AsinDiff {
  adds: { slot: string; url: string }[]
  replaces: { slot: string; live: string; next: string }[]
  deletes: { slot: string; url: string }[]
  unchanged: number
}

/** PURE — categorize one ASIN's exact-mirror plan against its live state. */
export function categorizeAsinDiff(
  planSlots: { slot: string; url: string }[],
  deleteSlots: string[],
  live: Record<string, string>,
): AsinDiff {
  const norm = (u: string) => normalizeAmazonImageUrl(u)
  const adds: AsinDiff['adds'] = []
  const replaces: AsinDiff['replaces'] = []
  let unchanged = 0
  for (const s of planSlots) {
    const cur = live[s.slot]
    if (cur === undefined) adds.push({ slot: s.slot, url: s.url })
    else if (norm(cur) !== norm(s.url)) replaces.push({ slot: s.slot, live: cur, next: s.url })
    else unchanged += 1
  }
  const deletes: AsinDiff['deletes'] = []
  for (const slot of deleteSlots) {
    const cur = live[slot]
    if (cur !== undefined) deletes.push({ slot, url: cur }) // only real removals
  }
  return { adds, replaces, deletes, unchanged }
}

export interface MirrorDiffAsin extends AsinDiff {
  sku: string
  asin: string | null
  skipped: boolean
}

export interface MirrorDiff {
  productId: string
  marketplace: string
  perAsin: MirrorDiffAsin[]
  totals: { adds: number; replaces: number; deletes: number; asins: number; skipped: number }
}

export async function buildMirrorDiff(opts: {
  productId: string
  marketplace: string
  variantIds?: string[]
  activeAxis?: string
  refresh?: boolean
}): Promise<MirrorDiff> {
  const mkt = opts.marketplace.toUpperCase()
  const product = await prisma.product.findUnique({
    where: { id: opts.productId },
    select: { productType: true, imageAxisPreference: true },
  })
  const productType = product?.productType ?? 'PRODUCT'
  const axis = opts.activeAxis ?? product?.imageAxisPreference ?? undefined

  const taxonomy = await resolveSlotTaxonomy(mkt, productType)
  const taxLite = taxonomy.slots.map((s) => ({ slot: s.slot, kind: s.kind, writable: s.writable }))
  const resolved = await resolveAmazonImages(opts.productId, mkt, opts.variantIds, axis, taxonomy.slots.map((s) => s.slot))

  const liveRows = await prisma.channelLiveImage.findMany({
    where: { productId: opts.productId, channel: 'AMAZON', marketplace: mkt },
    select: { externalSku: true, slot: true, url: true },
  })
  const liveBySku = new Map<string, Record<string, string>>()
  for (const r of liveRows) {
    const m = liveBySku.get(r.externalSku) ?? {}
    m[r.slot] = r.url
    liveBySku.set(r.externalSku, m)
  }

  const perAsin: MirrorDiffAsin[] = []
  let tAdds = 0
  let tReplaces = 0
  let tDeletes = 0
  let tSkipped = 0

  for (const v of resolved) {
    const plan = computeExactMirror(v.slots.map((s) => ({ slot: s.slot, url: s.url })), taxLite)
    if (plan.skip) {
      perAsin.push({ sku: v.sku, asin: v.amazonAsin, adds: [], replaces: [], deletes: [], unchanged: 0, skipped: true })
      tSkipped += 1
      continue
    }
    const diff = categorizeAsinDiff(plan.slots, plan.deleteSlots, liveBySku.get(v.sku) ?? {})
    tAdds += diff.adds.length
    tReplaces += diff.replaces.length
    tDeletes += diff.deletes.length
    perAsin.push({ sku: v.sku, asin: v.amazonAsin, ...diff, skipped: false })
  }

  return {
    productId: opts.productId,
    marketplace: mkt,
    perAsin,
    totals: { adds: tAdds, replaces: tReplaces, deletes: tDeletes, asins: perAsin.length, skipped: tSkipped },
  }
}
