/**
 * M2 — Adopt-first lossless import.
 *
 * Before Nexus can become the authoritative hub (exact-mirror publish that
 * DELETES Amazon images not present in Nexus, M3), we must first pull every
 * image currently live on Amazon — across all configured EU markets and all
 * slots, including manually-uploaded country-specific ones — into Nexus as a
 * per-market `ListingImage` baseline. Otherwise the first mirror would wipe
 * images that only ever lived in Seller Central.
 *
 *   adoptAmazonImages   — refresh live (reuses refreshAmazonLiveImages) →
 *                         gap-only upsert a per-market ListingImage baseline.
 *   reconcileAmazonImages — read-only diff (onlyOnAmazon / onlyInNexus /
 *                         urlMismatch) proving the baseline captured everything.
 *
 * Gap-only: never overwrites an existing ListingImage (esp. operator DRAFTs or
 * master-linked rows) — adoption only fills slots Nexus has nothing for.
 */

import prisma from '../../db.js'
import { refreshAmazonLiveImages } from './amazon-live-images.service.js'
import { normalizeAmazonImageUrl } from './normalize-amazon-image-url.js'

const FALLBACK_EU_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK']

/** Active Amazon EU marketplace codes, or the known fallback set. */
export async function getConfiguredAmazonEuMarkets(): Promise<string[]> {
  try {
    const rows = await prisma.marketplace.findMany({
      where: { channel: 'AMAZON', isActive: true, region: 'EU' },
      select: { code: true },
    })
    const codes = rows.map((r) => r.code).filter((c) => c && c !== 'GLOBAL')
    return codes.length > 0 ? codes : [...FALLBACK_EU_MARKETS]
  } catch {
    return [...FALLBACK_EU_MARKETS]
  }
}

/** Map an Amazon image variant/slot code to the closest ListingImage role. */
export function slotToRole(slot: string): 'MAIN' | 'GALLERY' | 'SWATCH' | 'INFOGRAPHIC' {
  if (slot === 'MAIN') return 'MAIN'
  if (slot === 'SWCH') return 'SWATCH'
  if (/^PS\d+$/i.test(slot)) return 'INFOGRAPHIC' // product-safety / GPSR
  return 'GALLERY'
}

export interface ImgRef {
  sku: string
  slot: string
  url: string
}

export interface ReconcileResult {
  onlyOnAmazon: ImgRef[]
  onlyInNexus: ImgRef[]
  urlMismatch: Array<{ sku: string; slot: string; live: string; nexus: string }>
  inSync: number
}

/**
 * PURE — categorize live (Amazon) vs nexus (desired) images by (sku, slot).
 * URLs are normalized (size modifiers stripped) so a thumbnail/full-res
 * difference doesn't read as a mismatch. Exported for tests.
 */
export function categorizeReconcile(live: ImgRef[], nexus: ImgRef[]): ReconcileResult {
  const k = (r: ImgRef) => `${r.sku}::${r.slot}`
  const norm = (u: string) => normalizeAmazonImageUrl(u)
  const nexusMap = new Map(nexus.map((r) => [k(r), r.url]))
  const liveMap = new Map(live.map((r) => [k(r), r.url]))

  const onlyOnAmazon: ImgRef[] = []
  const urlMismatch: ReconcileResult['urlMismatch'] = []
  for (const r of live) {
    const n = nexusMap.get(k(r))
    if (n === undefined) onlyOnAmazon.push(r)
    else if (norm(n) !== norm(r.url)) urlMismatch.push({ sku: r.sku, slot: r.slot, live: r.url, nexus: n })
  }
  const onlyInNexus = nexus.filter((r) => !liveMap.has(k(r)))
  return { onlyOnAmazon, onlyInNexus, urlMismatch, inSync: live.length - onlyOnAmazon.length - urlMismatch.length }
}

async function resolveVariationId(externalSku: string): Promise<string | null> {
  const v = await prisma.productVariation.findUnique({ where: { sku: externalSku }, select: { id: true } })
  return v?.id ?? null
}

export interface AdoptMarketResult {
  marketplace: string
  liveRows: number
  created: number
  skippedExisting: number
  skusOk: number
  skusFailed: number
  errors: Array<{ sku: string; message: string }>
}

export interface AdoptResult {
  dryRun: boolean
  productId: string
  perMarket: AdoptMarketResult[]
}

/**
 * Pull all live Amazon images into a per-market ListingImage baseline
 * (gap-only). Refreshes the live read-replica first so the baseline reflects
 * Amazon's current state.
 */
export async function adoptAmazonImages(opts: {
  productId: string
  marketplaces?: string[]
  dryRun?: boolean
}): Promise<AdoptResult> {
  const dryRun = opts.dryRun ?? false
  const markets = opts.marketplaces && opts.marketplaces.length > 0
    ? opts.marketplaces.map((m) => m.toUpperCase())
    : await getConfiguredAmazonEuMarkets()

  const perMarket: AdoptMarketResult[] = []

  for (const marketplace of markets) {
    let skusOk = 0
    let skusFailed = 0
    let errors: Array<{ sku: string; message: string }> = []
    try {
      const refresh = await refreshAmazonLiveImages({ productId: opts.productId, marketplaceCode: marketplace })
      skusOk = refresh.skusOk
      skusFailed = refresh.skusFailed
      errors = refresh.errors
    } catch (e) {
      perMarket.push({
        marketplace, liveRows: 0, created: 0, skippedExisting: 0, skusOk: 0, skusFailed: 0,
        errors: [{ sku: '*', message: e instanceof Error ? e.message : String(e) }],
      })
      continue
    }

    const liveRows = await prisma.channelLiveImage.findMany({
      where: { productId: opts.productId, channel: 'AMAZON', marketplace },
      select: { externalSku: true, slot: true, url: true, width: true, height: true, sortOrder: true },
      orderBy: [{ externalSku: 'asc' }, { sortOrder: 'asc' }],
    })

    let created = 0
    let skippedExisting = 0
    for (const row of liveRows) {
      if (!row.url || !row.slot) continue
      const variationId = await resolveVariationId(row.externalSku)
      const existing = await prisma.listingImage.findFirst({
        where: {
          productId: opts.productId,
          variationId,
          scope: 'MARKETPLACE',
          platform: 'AMAZON',
          marketplace,
          amazonSlot: row.slot,
        },
        select: { id: true },
      })
      if (existing) {
        skippedExisting += 1
        continue
      }
      if (!dryRun) {
        await prisma.listingImage.create({
          data: {
            productId: opts.productId,
            variationId,
            scope: 'MARKETPLACE',
            platform: 'AMAZON',
            marketplace,
            amazonSlot: row.slot,
            url: row.url,
            position: row.sortOrder ?? 0,
            role: slotToRole(row.slot),
            width: row.width ?? null,
            height: row.height ?? null,
            publishStatus: 'PUBLISHED',
            publishedAt: new Date(),
          },
        })
      }
      created += 1
    }

    perMarket.push({ marketplace, liveRows: liveRows.length, created, skippedExisting, skusOk, skusFailed, errors })
  }

  return { dryRun, productId: opts.productId, perMarket }
}

export interface ReconcileMarketResult extends ReconcileResult {
  marketplace: string
}

/**
 * Read-only: per market, diff Amazon's live image set (ChannelLiveImage) vs
 * the Nexus per-market baseline (MARKETPLACE-scope ListingImage). After a
 * clean adopt, onlyOnAmazon should be empty.
 */
export async function reconcileAmazonImages(opts: {
  productId: string
  marketplaces?: string[]
  refresh?: boolean
}): Promise<{ productId: string; perMarket: ReconcileMarketResult[] }> {
  const markets = opts.marketplaces && opts.marketplaces.length > 0
    ? opts.marketplaces.map((m) => m.toUpperCase())
    : await getConfiguredAmazonEuMarkets()

  const perMarket: ReconcileMarketResult[] = []
  for (const marketplace of markets) {
    if (opts.refresh) {
      try {
        await refreshAmazonLiveImages({ productId: opts.productId, marketplaceCode: marketplace })
      } catch {
        /* fail-soft — reconcile against whatever's cached */
      }
    }

    const liveRows = await prisma.channelLiveImage.findMany({
      where: { productId: opts.productId, channel: 'AMAZON', marketplace },
      select: { externalSku: true, slot: true, url: true },
    })
    const nexusRows = await prisma.listingImage.findMany({
      where: { productId: opts.productId, scope: 'MARKETPLACE', platform: 'AMAZON', marketplace },
      select: { variationId: true, amazonSlot: true, url: true },
    })

    // Map nexus rows back to the externalSku Amazon keys via variationId.sku.
    const variationIds = [...new Set(nexusRows.map((r) => r.variationId).filter((x): x is string => !!x))]
    const variations = variationIds.length
      ? await prisma.productVariation.findMany({ where: { id: { in: variationIds } }, select: { id: true, sku: true } })
      : []
    const vidToSku = new Map(variations.map((v) => [v.id, v.sku]))
    // Product-level (variationId null) nexus rows apply to every live sku.
    const liveSkus = [...new Set(liveRows.map((r) => r.externalSku))]

    const live: ImgRef[] = liveRows.map((r) => ({ sku: r.externalSku, slot: r.slot, url: r.url }))
    const nexus: ImgRef[] = []
    for (const r of nexusRows) {
      if (!r.amazonSlot || !r.url) continue
      if (r.variationId) {
        const sku = vidToSku.get(r.variationId)
        if (sku) nexus.push({ sku, slot: r.amazonSlot, url: r.url })
      } else {
        for (const sku of liveSkus) nexus.push({ sku, slot: r.amazonSlot, url: r.url })
      }
    }

    perMarket.push({ marketplace, ...categorizeReconcile(live, nexus) })
  }
  return { productId: opts.productId, perMarket }
}
