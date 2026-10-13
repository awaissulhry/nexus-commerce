/**
 * Amazon Business step 3b (Owner's pick 3B, 2026-10-12) — copy the business offers Amazon already holds into Nexus, as
 * exact prices, on every listing where Nexus manages none yet.
 *
 * Per own Amazon account, per market where Amazon lists the B2B audience for it (step 1's kept answers), the account's
 * listings are read page by page (`searchListingsItems`, attributes, through the channel gateway). A listing whose
 * `purchasable_offer` has a REAL B2B instance for that market (audience `B2B` with a price) is matched to its Nexus
 * listing by SKU (`productForChannelSku`, one account, one market) and written through the business price door with the
 * named reason `amazon-business-offer-adopt`: never over a setting Nexus manages, recorded as Amazon holds it.
 *
 * Amazon's `offers` view can also show a B2B entry that only mirrors the normal price (GALE, 2026-10-12): it is not a
 * business price anyone set, it is not in `attributes`, and it is never copied.
 *
 * Copied only where Nexus has NEVER kept a business price for the listing (no business audit row at all): once a person
 * or this job has set one, Nexus is where it lives — a person's removal is not undone by a copy of what Amazon still
 * shows while the removal is on its way.
 *
 * The same scan VERIFIES what Nexus keeps: for each listing with a business setting, Amazon's business offer against
 * the one Nexus sends (`amazonBusinessLive` on the listing: MATCH, DIFFERS or MISSING, with Amazon's price) — the
 * read-back of the step 4 sends, a day at most after them. Nexus is where the business price lives (Owner 10-01: Nexus
 * is the PIM): a business offer Amazon holds differently (a Seller Central edit, an older page's feed that dropped it),
 * or still holds after a person removed it in Nexus, gets ONE business send queued, which puts Nexus's back (or says
 * why it cannot). A send Amazon refused is not queued again until the setting or the normal price changes.
 *
 * Reads Amazon, writes Nexus only. Run nightly after the schema refresh (`jobs/amazon-business-offer-adopt.job.ts`).
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { getAmazonSellerId, getAmazonSpClient } from '../../lib/amazon-sp-client.js'
import { businessPriceOf, type BusinessPriceSetting, type BusinessTiers } from '@nexus/shared/business-price'
import { isOwnConnection, listActiveConnections } from '../connection-resolver.service.js'
import { amazonMarketplaceId } from '../categories/marketplace-ids.js'
import { OFFER_AUDIENCE_FIELD_KEY } from '../categories/seller-offer-audience.service.js'
import { CHANNEL_SKU_LISTING_SELECT, productForChannelSku, type ChannelSkuProductMatch } from '../listings/channel-sku.js'
import { listingSendSku } from '../listings/listing-send-sku.js'
import { queueBusinessSends, writeBusinessPrices, type BusinessPriceWriteTarget } from '../pim/business-price-write.service.js'
import { readAmazonOfferFacts } from './offer-facts.js'
import { amazonBusinessElement, businessNormalPrice, liveBusinessInstance, liveNormalInstance, sameBusinessOffer, storedBusinessSetting } from './business-offer.js'
import { marketCurrency } from '../pim/market-currency.js'
import { businessSendSignature } from './business-offer-send.js'

const record = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null)
const first = (v: unknown): Record<string, any> | null => (Array.isArray(v) ? record(v[0]) : null)
const amount = (schedule: Record<string, any> | null): number | null => {
  const v = schedule?.value_with_tax ?? schedule?.value
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/**
 * A B2B `purchasable_offer` instance as Nexus keeps it: an exact price and its tiers; `null` when it carries no price, or a
 * quantity discount plan Nexus cannot read whole (copying it as "no tiers" would let a later send delete Amazon's tiers).
 */
export function businessSettingFromAmazon(instance: unknown): BusinessPriceSetting | null {
  const offer = record(instance)
  const price = amount(first(first(offer?.our_price)?.schedule))
  if (price == null) return null
  const plan = first(first(offer?.quantity_discount_plan)?.schedule)
  const type = plan?.discount_type === 'percent' || plan?.discount_type === 'fixed' ? plan.discount_type as BusinessTiers['type'] : null
  const rawLevels: unknown[] = Array.isArray(plan?.levels) ? plan!.levels : []
  const levels = rawLevels.flatMap((l) => {
    const level = record(l)
    return typeof level?.lower_bound === 'number' && typeof level?.value === 'number' ? [{ minQty: level.lower_bound, value: level.value }] : []
  })
  if (offer?.quantity_discount_plan != null && (!type || !levels.length || levels.length !== rawLevels.length)) return null
  return { rule: 'FIXED', percent: null, price, tiers: type && levels.length ? { type, levels } : null }
}

/** The market's business offer in a listing's attributes (audience B2B, this marketplace), or null. */
export function amazonBusinessInstance(attributes: unknown, marketplaceId: string): Record<string, any> | null {
  const offers = record(attributes)?.purchasable_offer
  if (!Array.isArray(offers)) return null
  return liveBusinessInstance(offers.map(record).filter((o): o is Record<string, any> => !!o), marketplaceId)
}

export interface AdoptCounts {
  markets: number; scanned: number; found: number; adopted: number; managed: number; noListing: number; unreadable: number; refused: number
  /** The verification of what Nexus keeps: Amazon agrees, differs, or holds no business offer. */
  verified: number; differs: number; missing: number
  /** Business sends queued to put Nexus's business price back where Amazon differs or holds none. */
  resent: number
  /** Differences not queued again: Amazon refused this same send before (same setting, same normal price). */
  stillRefused: number
  failedPages: number
}

type LiveStatus = 'MATCH' | 'DIFFERS' | 'MISSING'
/**
 * Keep what Amazon holds against what Nexus sends, on the listing (`platformAttributes.amazonBusinessLive`). `normal`: the
 * shopper price, when Amazon's is not Nexus's — a business price follows Nexus's, and a first one would send it.
 */
async function recordAmazonBusinessLive(listingId: string, entry: { status: LiveStatus; amazonPrice: number | null; nexusPrice: number | null; normal?: { amazon: number; nexus: number } | null }) {
  const value = JSON.stringify({ ...entry, at: new Date().toISOString() })
  await prisma.$executeRaw`UPDATE "ChannelListing" SET "platformAttributes" = jsonb_set(COALESCE("platformAttributes", '{}'::jsonb), '{amazonBusinessLive}', ${value}::jsonb, true) WHERE id = ${listingId}`
}
const priceOfInstance = (i: Record<string, any> | null) => {
  const v = first(first(i?.our_price)?.schedule)?.value_with_tax ?? first(first(i?.our_price)?.schedule)?.value
  return typeof v === 'number' ? v : null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const MAX_PAGES = 500

export async function adoptAmazonBusinessOffers(opts: { throttleMs?: number; label?: string } = {}): Promise<AdoptCounts> {
  const throttleMs = opts.throttleMs ?? 300
  const label = opts.label ?? 'amazon-business-offer-adopt'
  const counts: AdoptCounts = { markets: 0, scanned: 0, found: 0, adopted: 0, managed: 0, noListing: 0, unreadable: 0, refused: 0, verified: 0, differs: 0, missing: 0, resent: 0, stillRefused: 0, failedPages: 0 }
  for (const connection of (await listActiveConnections('AMAZON')).filter(isOwnConnection)) {
    const kept = await prisma.sellerReferenceLabel.findMany({ where: { channel: 'AMAZON', connectionId: connection.id, fieldKey: OFFER_AUDIENCE_FIELD_KEY }, select: { marketplace: true, labels: true } })
    const markets = [...new Set(kept.filter((r) => record(r.labels) && 'B2B' in (r.labels as object)).map((r) => r.marketplace.toUpperCase()))].sort()
    if (!markets.length) continue
    let sellerId: string | null = null
    let sp: Awaited<ReturnType<typeof getAmazonSpClient>>
    try {
      sellerId = await getAmazonSellerId(connection.id)
      if (!sellerId) throw new Error('no verified seller identity')
      sp = await getAmazonSpClient(connection.id)
    } catch (err) {
      logger.warn(`${label}: account skipped`, { connectionId: connection.id, error: err instanceof Error ? err.message : String(err) })
      continue
    }
    for (const market of markets) {
      counts.markets++
      const marketplaceId = amazonMarketplaceId(market)
      const targets: BusinessPriceWriteTarget[] = []
      // The listings whose business price Nexus keeps here — a setting now, or one a person removed (an audit row) — by
      // the SKU Amazon holds for them: verified, never copied over.
      const managedRows = await prisma.channelListing.findMany({
        where: { channel: 'AMAZON', marketplace: market, channelConnectionId: connection.id, OR: [{ businessPriceRule: { not: null } }, { overrideHistory: { some: { fieldName: 'businessPrice' } } }] },
        select: { ...CHANNEL_SKU_LISTING_SELECT, businessPriceRule: true, businessPricePercent: true, businessPrice: true, businessTiers: true, price: true, priceOverride: true, followMasterPrice: true, salePrice: true,
          pricingRule: true, priceAdjustmentPercent: true, product: { select: { sku: true, deletedAt: true, basePrice: true } } },
      })
      let currency: string | null = null
      try { currency = await marketCurrency('AMAZON', market) } catch { currency = null }
      /** The normal price a business price follows here (the one rule: `businessNormalPrice`). */
      const normalOf = (l: typeof managedRows[number]) =>
        businessNormalPrice(l, readAmazonOfferFacts({ ...l, marketplace: market }, 'job').values.our_price.price, { masterPrice: l.product?.basePrice, marketCurrency: currency })
      const managed = new Map(managedRows.flatMap((l) => {
        const sku = listingSendSku(l as never, l.product?.sku, '').sku
        return sku ? [[sku, l] as const] : []
      }))
      const seenManaged = new Set<string>()
      const resend: string[] = []
      /** Queue a send for a difference — unless Amazon refused this very send before (same setting, same normal price). */
      const differs = (l: typeof managedRows[number], setting: ReturnType<typeof storedBusinessSetting>, normal: number | null) => {
        const last = record(record(l.platformAttributes)?.amazonBusinessSend)
        if (last?.status === 'REFUSED' && last.signature === businessSendSignature(setting, normal)) { counts.stillRefused++; return }
        resend.push(l.id)
      }
      let pageToken: string | undefined
      let page = 0
      let complete = true
      for (; page < MAX_PAGES; page++) {
        let answer: Record<string, any>
        try {
          answer = await sp.callAPI({
            operation: 'searchListingsItems', endpoint: 'listingsItems', path: { sellerId },
            query: { marketplaceIds: [marketplaceId], includedData: ['attributes'], pageSize: 20, ...(pageToken ? { pageToken } : {}) },
          })
        } catch (err) {
          counts.failedPages++
          complete = false
          logger.warn(`${label}: listings page failed`, { connectionId: connection.id, market, error: err instanceof Error ? err.message : String(err) })
          break
        }
        for (const item of Array.isArray(answer?.items) ? answer.items : []) {
          counts.scanned++
          if (typeof item?.sku !== 'string') continue
          const instance = amazonBusinessInstance(item?.attributes, marketplaceId)
          // A listing whose business price Nexus keeps: verify it, never copy over it.
          const kept = managed.get(item.sku)
          if (kept) {
            seenManaged.add(kept.id)
            const setting = storedBusinessSetting(kept)
            const normal = normalOf(kept)
            const offers = Array.isArray(record(item?.attributes)?.purchasable_offer) ? (record(item.attributes)!.purchasable_offer as unknown[]).map(record).filter((o): o is Record<string, any> => !!o) : []
            const amazonNormal = priceOfInstance(liveNormalInstance(offers, marketplaceId))
            const normalDiffers = setting && amazonNormal != null && normal != null && Math.abs(amazonNormal - normal) >= 0.005 ? { amazon: amazonNormal, nexus: normal } : null
            const price = setting ? businessPriceOf(setting, normal) : null
            const expected = setting && price != null ? amazonBusinessElement({ marketplaceId, currency: String(instance?.currency ?? ''), price, tiers: setting.tiers }) : null
            // Nexus keeps none (a person removed it): Amazon should hold none either.
            const status: LiveStatus = !setting ? (instance ? 'DIFFERS' : 'MATCH')
              : !instance ? 'MISSING' : expected && sameBusinessOffer(instance, expected) ? 'MATCH' : 'DIFFERS'
            if (status === 'MATCH') counts.verified++; else if (status === 'DIFFERS') counts.differs++; else counts.missing++
            await recordAmazonBusinessLive(kept.id, { status, amazonPrice: priceOfInstance(instance), nexusPrice: price, normal: normalDiffers })
            if (status !== 'MATCH') differs(kept, setting, normal)
            continue
          }
          if (!instance) continue
          counts.found++
          const setting = businessSettingFromAmazon(instance)
          if (!setting) { counts.unreadable++; logger.warn(`${label}: Amazon's business offer is not copied — Nexus cannot read it whole`, { sku: item.sku, market }); continue }
          const match = await productForChannelSku(prisma, { channel: 'AMAZON', channelConnectionId: connection.id, marketplace: market, sku: item.sku })
          const listingId = match && match.ambiguous !== true ? (match as ChannelSkuProductMatch).listingId : null
          if (!listingId) { counts.noListing++; continue }
          // Two Amazon SKUs that match one listing: the first wins (the second would only be a conflict).
          if (!targets.some((t) => t.listingId === listingId)) targets.push({ listingId, unguardedReason: 'amazon-business-offer-adopt', setting })
        }
        pageToken = typeof answer?.pagination?.nextToken === 'string' ? answer.pagination.nextToken : undefined
        if (throttleMs > 0) await sleep(throttleMs) // the Listings Items API is rate-limited
        if (!pageToken) break
      }
      if (page >= MAX_PAGES) { complete = false; logger.warn(`${label}: stopped at ${MAX_PAGES} pages; the rest of the market is read next time`, { connectionId: connection.id, market }) }
      // A kept business price whose SKU Amazon did not list at all (a complete scan only): Amazon holds no offer for it.
      if (complete) {
        for (const l of managedRows) {
          // Unseen: Amazon lists no offer for this SKU here. Nothing to remove for a removed one; missing for a kept one.
          if (seenManaged.has(l.id) || !storedBusinessSetting(l)) continue
          counts.missing++
          await recordAmazonBusinessLive(l.id, { status: 'MISSING', amazonPrice: null, nexusPrice: null })
          differs(l, storedBusinessSetting(l), normalOf(l))
        }
      }
      if (resend.length) counts.resent += (await queueBusinessSends({ listingIds: resend, actor: 'amazon-business-offer-verify', source: 'BUSINESS_PRICE_VERIFY', staggerMs: 5_000 })).length
      if (!targets.length) continue
      // Nexus has kept a business price for these before (a person's audit row, or an earlier copy): never copied again.
      const touched = new Set((await prisma.channelListingOverride.findMany({
        where: { channelListingId: { in: targets.map((t) => t.listingId) }, fieldName: 'businessPrice' }, select: { channelListingId: true },
      })).map((r) => r.channelListingId))
      const fresh = targets.filter((t) => !touched.has(t.listingId))
      counts.managed += targets.length - fresh.length
      if (!fresh.length) continue
      const written = await writeBusinessPrices({ targets: fresh, actor: 'amazon-business-offer-adopt', reason: 'Copied from the business offer Amazon holds' })
      counts.adopted += written.applied
      counts.managed += written.noop
      counts.refused += written.refused + written.conflict
      for (const r of written.results) {
        if (r.outcome === 'refused' || r.outcome === 'conflict') logger.warn(`${label}: not copied`, { listingId: r.listingId, market, reason: r.reason })
        else if (r.outcome === 'applied' && r.warnings.length) logger.warn(`${label}: copied with a warning`, { listingId: r.listingId, market, warnings: r.warnings })
      }
    }
  }
  return counts
}

/** The run's one line: `markets=2 scanned=568 found=5 adopted=5 … resent=0 stillRefused=0 failedPages=0`, one key per count. */
export const adoptSummary = (c: AdoptCounts) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ')
