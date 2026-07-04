/**
 * E2 (eBay Ads) — listing discovery + the product-first resolver.
 *
 * Discovery: Trading GetMyeBaySelling (ActiveList, paginated) → upsert
 * EbayListingIndex; GetItem detail (site, category, SKUs, aspects) for new
 * items, capped per run. READ-ONLY Trading calls via direct authenticated
 * fetch — deliberately NOT callTradingApi, whose NEXUS_EBAY_REAL_API gate
 * exists for WRITES and would return DRYRUN fakes in dev (useless and
 * misleading for reads).
 *
 * Reconciliation (the E0-PRODUCT-LISTING-MAP gaps):
 *  - tracked-but-absent itemIds → EbayListingIndex.endedAt + soft
 *    SharedListingMembership.status='ENDED' (fetch-success gated + mass-end
 *    circuit breaker; ChannelListing.listingStatus is left to its own
 *    reconcile cron — we never fight it)
 *  - resolver getLiveEbayItemIds() = the UNION the E0 map called for.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { EbayAuthService } from '../ebay-auth.service.js'

const TRADING_URL = 'https://api.ebay.com/ws/api.dll'
const SITE_TO_MARKET: Record<string, string> = {
  Italy: 'IT', Germany: 'DE', France: 'FR', Spain: 'ES', UK: 'UK', US: 'US',
}

export interface DiscoveryReport {
  fetchedActive: number
  upserted: number
  detailFetched: number
  matched: number
  ended: number
  membershipsEnded: number
  skippedEndFlip: boolean
  errors: string[]
}

/** Pure guard shared shape with entity sync: implausible mass-end → skip. */
export function shouldSkipEndFlip(knownLive: number, seenNow: number, maxDropFraction = 0.4): boolean {
  if (knownLive === 0) return false
  const dropped = knownLive - seenNow
  if (dropped <= 0) return false
  return dropped / knownLive > maxDropFraction
}

async function tradingCall(callName: string, bodyXml: string, token: string, siteId = '101'): Promise<string> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
${bodyXml}
</${callName}Request>`
  const r = await fetch(TRADING_URL, {
    method: 'POST',
    headers: {
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': siteId,
      'X-EBAY-API-IAF-TOKEN': token,
      'Content-Type': 'text/xml',
    },
    body: xml,
  })
  const text = await r.text()
  const ack = text.match(/<Ack>(.*?)<\/Ack>/)?.[1]
  if (ack !== 'Success' && ack !== 'Warning') {
    const msg = text.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1] ?? `HTTP ${r.status}`
    throw new Error(`${callName} Ack=${ack ?? '?'}: ${msg.slice(0, 200)}`)
  }
  return text
}

export interface ActiveItem { itemId: string; title?: string; qty?: number; format?: string; priceValue?: number; priceCurrency?: string; galleryUrl?: string }

export function parseActiveList(xml: string): ActiveItem[] {
  return [...xml.matchAll(/<Item>([\s\S]*?)<\/Item>/g)].map((m) => {
    const g = (tag: string) => m[1]!.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]
    const price = m[1]!.match(/<(?:CurrentPrice|BuyItNowPrice) currencyID="(\w+)">([\d.]+)</)
    return {
      itemId: g('ItemID') ?? '',
      title: g('Title'),
      qty: g('QuantityAvailable') != null ? Number(g('QuantityAvailable')) : g('Quantity') != null ? Number(g('Quantity')) : undefined,
      format: g('ListingType'),
      priceValue: price ? Number(price[2]) : undefined,
      priceCurrency: price?.[1],
      galleryUrl: g('GalleryURL')?.replace(/&amp;/g, '&'), // EV2 — thumbnail, free in the sweep
    }
  }).filter((it) => it.itemId)
}

export interface ItemDetail {
  site?: string
  categoryId?: string
  quantity?: number
  quantitySold?: number
  variationSkus: string[]
  aspects: Record<string, string[]>
  pictureUrl?: string // EV2 — GetItem PictureDetails.PictureURL[0]
}

export function parseItemDetail(xml: string): ItemDetail {
  const g = (tag: string) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]
  const variationSkus = [...xml.matchAll(/<Variation>\s*<SKU>([^<]+)<\/SKU>/g)].map((m) => m[1]!)
  const topSku = xml.match(/<Item>[\s\S]*?<SKU>([^<]+)<\/SKU>/)?.[1]
  if (topSku && variationSkus.length === 0) variationSkus.push(topSku)
  const aspects: Record<string, string[]> = {}
  const specificsBlock = xml.match(/<ItemSpecifics>([\s\S]*?)<\/ItemSpecifics>/)?.[1] ?? ''
  for (const nv of specificsBlock.matchAll(/<NameValueList>\s*<Name>([^<]+)<\/Name>([\s\S]*?)<\/NameValueList>/g)) {
    const values = [...nv[2]!.matchAll(/<Value>([^<]*)<\/Value>/g)].map((v) => v[1]!)
    aspects[nv[1]!] = values
  }
  return {
    site: g('Site'),
    pictureUrl: xml.match(/<PictureDetails>[\s\S]*?<PictureURL>([^<]+)<\/PictureURL>/)?.[1]?.replace(/&amp;/g, '&'),
    categoryId: xml.match(/<PrimaryCategory>\s*<CategoryID>(\d+)<\/CategoryID>/)?.[1],
    quantity: g('Quantity') != null ? Number(g('Quantity')) : undefined,
    quantitySold: g('QuantitySold') != null ? Number(g('QuantitySold')) : undefined,
    variationSkus: [...new Set(variationSkus)],
    aspects,
  }
}

/** Resolve productIds for an index row from its SKUs + the two mapping stores. */
async function resolveProducts(marketplace: string, itemId: string, variationSkus: string[]): Promise<string[]> {
  const ids = new Set<string>()
  if (variationSkus.length) {
    const bySku = await prisma.product.findMany({
      where: { sku: { in: variationSkus }, deletedAt: null },
      select: { id: true },
    })
    for (const p of bySku) ids.add(p.id)
  }
  const memberships = await prisma.sharedListingMembership.findMany({
    where: { itemId, productId: { not: null } },
    select: { productId: true },
  })
  for (const m of memberships) if (m.productId) ids.add(m.productId)
  const cls = await prisma.channelListing.findMany({
    where: { channel: 'EBAY', externalListingId: itemId },
    select: { productId: true },
  })
  for (const cl of cls) ids.add(cl.productId)
  return [...ids]
}

const DETAIL_MAX = Number(process.env.NEXUS_EBAY_DISCOVERY_DETAIL_MAX ?? 50)

export async function discoverEbayListings(): Promise<DiscoveryReport> {
  const report: DiscoveryReport = {
    fetchedActive: 0, upserted: 0, detailFetched: 0, matched: 0, ended: 0,
    membershipsEnded: 0, skippedEndFlip: false, errors: [],
  }
  const conn = await prisma.channelConnection.findFirst({
    where: { channelType: 'EBAY', isActive: true, managedBy: 'oauth' },
    select: { id: true },
  })
  if (!conn) { report.errors.push('no active eBay connection'); return report }
  const token = await new EbayAuthService().getValidToken(conn.id)

  // 1. Active list (paginated, deduped)
  const items = new Map<string, ActiveItem>()
  try {
    for (let page = 1; page <= 25; page++) {
      const xml = await tradingCall('GetMyeBaySelling', `
  <ActiveList><Include>true</Include>
    <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
  </ActiveList>`, token)
      for (const it of parseActiveList(xml)) items.set(it.itemId, it)
      const totalPages = Number(xml.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1] ?? 1)
      if (page >= totalPages) break
    }
  } catch (e) {
    // fetch-success gating: no upserts, no end-flips on a failed sweep
    report.errors.push(`GetMyeBaySelling: ${(e as Error).message}`)
    return report
  }
  report.fetchedActive = items.size

  // 2. Upsert seen items (+ detail for new ones, capped)
  let detailBudget = DETAIL_MAX
  const now = new Date()
  for (const it of items.values()) {
    const existing = await prisma.ebayListingIndex.findFirst({ where: { itemId: it.itemId }, select: { id: true, marketplace: true, detailSyncAt: true, productIds: true, matchStatus: true, imageUrl: true } })
    let marketplace = existing?.marketplace ?? 'IT'
    let detail: ItemDetail | null = null
    if ((!existing || !existing.detailSyncAt || (!existing.imageUrl && !it.galleryUrl)) && detailBudget > 0) { // EV2 — also refetch when no image landed yet
      try {
        detail = parseItemDetail(await tradingCall('GetItem', `<ItemID>${it.itemId}</ItemID><IncludeItemSpecifics>true</IncludeItemSpecifics>`, token))
        detailBudget--
        report.detailFetched++
        if (detail.site && SITE_TO_MARKET[detail.site]) marketplace = SITE_TO_MARKET[detail.site]!
      } catch (e) {
        report.errors.push(`GetItem ${it.itemId}: ${(e as Error).message}`)
      }
    }
    const resolved = await resolveProducts(marketplace, it.itemId, detail?.variationSkus ?? [])
    // Operator-confirmed matches (matchStatus MANUAL, set from the ads console)
    // are sticky: sweeps union them in and never downgrade the status.
    const manual = existing?.matchStatus === 'MANUAL' ? existing.productIds : []
    const productIds = [...new Set([...manual, ...resolved])]
    if (productIds.length) report.matched++
    const img = it.galleryUrl ?? detail?.pictureUrl
    const base = {
      title: it.title ?? null,
      ...(img ? { imageUrl: img } : {}),
      price: it.priceValue != null ? it.priceValue.toFixed(2) : null,
      currency: it.priceCurrency ?? null,
      quantity: detail?.quantity ?? it.qty ?? null,
      quantitySold: detail?.quantitySold ?? null,
      format: it.format ?? null,
      lastSeenAt: now,
      endedAt: null as Date | null,
      ...(detail ? {
        categoryId: detail.categoryId ?? null,
        variationSkus: detail.variationSkus,
        aspects: detail.aspects as object,
        detailSyncAt: now,
      } : {}),
      ...(productIds.length ? { productIds, matchStatus: manual.length ? 'MANUAL' : 'MATCHED' } : {}),
    }
    await prisma.ebayListingIndex.upsert({
      where: { marketplace_itemId: { marketplace, itemId: it.itemId } },
      create: { marketplace, itemId: it.itemId, source: 'DISCOVERED', firstSeenAt: now, ...base },
      update: base,
    })
    report.upserted++
  }

  // 3. End-flip for tracked-but-absent (guarded)
  const live = await prisma.ebayListingIndex.findMany({ where: { endedAt: null }, select: { id: true, itemId: true } })
  const goneRows = live.filter((r) => !items.has(r.itemId))
  if (goneRows.length) {
    if (shouldSkipEndFlip(live.length, live.length - goneRows.length)) {
      report.skippedEndFlip = true
      logger.error(`[E2][ebay-ads] CIRCUIT BREAKER: ${goneRows.length}/${live.length} indexed listings vanished in one sweep — end flip SKIPPED`)
    } else {
      await prisma.ebayListingIndex.updateMany({ where: { id: { in: goneRows.map((r) => r.id) } }, data: { endedAt: now } })
      report.ended = goneRows.length
      const gone = goneRows.map((r) => r.itemId)
      const flipped = await prisma.sharedListingMembership.updateMany({
        where: { itemId: { in: gone }, status: 'ACTIVE' },
        data: { status: 'ENDED' },
      })
      report.membershipsEnded = flipped.count
      // Ads pointing at dead listings become STALE (soft)
      await prisma.ebayAd.updateMany({ where: { listingId: { in: gone }, status: { not: 'STALE' } }, data: { status: 'STALE' } })
    }
  }

  logger.info('[E2][ebay-ads] listing discovery complete', report as unknown as Record<string, unknown>)
  return report
}

/**
 * THE product-first resolver (E0-PRODUCT-LISTING-MAP §6): every LIVE eBay
 * itemId for a product, per marketplace — union of the discovery index,
 * SharedListingMembership (ACTIVE) and ChannelListing (ACTIVE), de-duped.
 */
export async function getLiveEbayItemIds(productId: string, marketplace?: string): Promise<{ itemId: string; marketplace: string; sources: string[] }[]> {
  const out = new Map<string, { itemId: string; marketplace: string; sources: string[] }>()
  const add = (itemId: string, mkt: string, source: string) => {
    const hit = out.get(itemId)
    if (hit) { if (!hit.sources.includes(source)) hit.sources.push(source); return }
    out.set(itemId, { itemId, marketplace: mkt, sources: [source] })
  }

  const idx = await prisma.ebayListingIndex.findMany({
    where: { endedAt: null, productIds: { has: productId }, ...(marketplace ? { marketplace } : {}) },
    select: { itemId: true, marketplace: true },
  })
  for (const r of idx) add(r.itemId, r.marketplace, 'INDEX')

  const mem = await prisma.sharedListingMembership.findMany({
    where: { productId, status: 'ACTIVE', ...(marketplace ? { marketplace } : {}) },
    select: { itemId: true, marketplace: true },
  })
  for (const r of mem) add(r.itemId, r.marketplace, 'SHARED_MEMBERSHIP')

  const cls = await prisma.channelListing.findMany({
    where: { productId, channel: 'EBAY', listingStatus: 'ACTIVE', externalListingId: { not: null }, ...(marketplace ? { marketplace } : {}) },
    select: { externalListingId: true, marketplace: true },
  })
  for (const r of cls) if (r.externalListingId) add(r.externalListingId, r.marketplace, 'CHANNEL_LISTING')

  return [...out.values()]
}
