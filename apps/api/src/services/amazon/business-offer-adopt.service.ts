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
 * Reads Amazon, writes Nexus only. Run nightly after the schema refresh (`jobs/amazon-business-offer-adopt.job.ts`).
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { getAmazonSellerId, getAmazonSpClient } from '../../lib/amazon-sp-client.js'
import type { BusinessPriceSetting, BusinessTiers } from '@nexus/shared/business-price'
import { isOwnConnection, listActiveConnections } from '../connection-resolver.service.js'
import { amazonMarketplaceId } from '../categories/marketplace-ids.js'
import { OFFER_AUDIENCE_FIELD_KEY } from '../categories/seller-offer-audience.service.js'
import { productForChannelSku, type ChannelSkuProductMatch } from '../listings/channel-sku.js'
import { writeBusinessPrices, type BusinessPriceWriteTarget } from '../pim/business-price-write.service.js'

const record = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null)
const first = (v: unknown): Record<string, any> | null => (Array.isArray(v) ? record(v[0]) : null)
const amount = (schedule: Record<string, any> | null): number | null => {
  const v = schedule?.value_with_tax ?? schedule?.value
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/** A B2B `purchasable_offer` instance as Nexus keeps it: an exact price and its tiers; `null` when it carries no price. */
export function businessSettingFromAmazon(instance: unknown): BusinessPriceSetting | null {
  const offer = record(instance)
  const price = amount(first(first(offer?.our_price)?.schedule))
  if (price == null) return null
  const plan = first(first(offer?.quantity_discount_plan)?.schedule)
  const type = plan?.discount_type === 'percent' || plan?.discount_type === 'fixed' ? plan.discount_type as BusinessTiers['type'] : null
  const levels = Array.isArray(plan?.levels)
    ? plan!.levels.flatMap((l: unknown) => {
      const level = record(l)
      return typeof level?.lower_bound === 'number' && typeof level?.value === 'number' ? [{ minQty: level.lower_bound, value: level.value }] : []
    })
    : []
  return { rule: 'FIXED', percent: null, price, tiers: type && levels.length ? { type, levels } : null }
}

/** The market's REAL business offer in a listing's attributes: audience B2B, this marketplace, with a price. */
export function amazonBusinessInstance(attributes: unknown, marketplaceId: string): Record<string, any> | null {
  const offers = record(attributes)?.purchasable_offer
  if (!Array.isArray(offers)) return null
  return offers.map(record).find((o) => o?.audience === 'B2B' && o?.marketplace_id === marketplaceId && businessSettingFromAmazon(o)) ?? null
}

export interface AdoptCounts { markets: number; scanned: number; found: number; adopted: number; managed: number; noListing: number; refused: number; failedPages: number }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const MAX_PAGES = 500

export async function adoptAmazonBusinessOffers(opts: { throttleMs?: number; label?: string } = {}): Promise<AdoptCounts> {
  const throttleMs = opts.throttleMs ?? 300
  const label = opts.label ?? 'amazon-business-offer-adopt'
  const counts: AdoptCounts = { markets: 0, scanned: 0, found: 0, adopted: 0, managed: 0, noListing: 0, refused: 0, failedPages: 0 }
  for (const connection of (await listActiveConnections('AMAZON')).filter(isOwnConnection)) {
    const kept = await prisma.sellerReferenceLabel.findMany({ where: { channel: 'AMAZON', connectionId: connection.id, fieldKey: OFFER_AUDIENCE_FIELD_KEY }, select: { marketplace: true, labels: true } })
    const markets = [...new Set(kept.filter((r) => record(r.labels) && 'B2B' in (r.labels as object)).map((r) => r.marketplace.toUpperCase()))].sort()
    if (!markets.length) continue
    const sellerId = await getAmazonSellerId(connection.id)
    if (!sellerId) { logger.warn(`${label}: account has no verified seller identity`, { connectionId: connection.id }); continue }
    const sp = await getAmazonSpClient(connection.id)
    for (const market of markets) {
      counts.markets++
      const marketplaceId = amazonMarketplaceId(market)
      const targets: BusinessPriceWriteTarget[] = []
      let pageToken: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        let answer: Record<string, any>
        try {
          answer = await sp.callAPI({
            operation: 'searchListingsItems', endpoint: 'listingsItems', path: { sellerId },
            query: { marketplaceIds: [marketplaceId], includedData: ['attributes'], pageSize: 20, ...(pageToken ? { pageToken } : {}) },
          })
        } catch (err) {
          counts.failedPages++
          logger.warn(`${label}: listings page failed`, { connectionId: connection.id, market, error: err instanceof Error ? err.message : String(err) })
          break
        }
        for (const item of Array.isArray(answer?.items) ? answer.items : []) {
          counts.scanned++
          const instance = amazonBusinessInstance(item?.attributes, marketplaceId)
          if (!instance || typeof item?.sku !== 'string') continue
          counts.found++
          const match = await productForChannelSku(prisma, { channel: 'AMAZON', channelConnectionId: connection.id, marketplace: market, sku: item.sku })
          const listingId = match && match.ambiguous !== true ? (match as ChannelSkuProductMatch).listingId : null
          if (!listingId) { counts.noListing++; continue }
          targets.push({ listingId, unguardedReason: 'amazon-business-offer-adopt', setting: businessSettingFromAmazon(instance) })
        }
        pageToken = typeof answer?.pagination?.nextToken === 'string' ? answer.pagination.nextToken : undefined
        if (throttleMs > 0) await sleep(throttleMs) // the Listings Items API is rate-limited
        if (!pageToken) break
      }
      if (!targets.length) continue
      const written = await writeBusinessPrices({ targets, actor: 'amazon-business-offer-adopt', reason: 'Copied from the business offer Amazon holds' })
      counts.adopted += written.applied
      counts.managed += written.noop
      counts.refused += written.refused + written.conflict
      for (const r of written.results.filter((x) => x.outcome === 'refused' || x.outcome === 'conflict')) {
        logger.warn(`${label}: not copied`, { listingId: r.listingId, market, reason: r.reason })
      }
    }
  }
  return counts
}

/** The run's one line: `markets=2 scanned=568 found=5 adopted=5 managed=0 noListing=0 refused=0 failedPages=0`. */
export const adoptSummary = (c: AdoptCounts) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ')
