/**
 * APS.3 — "will Amazon actually serve an ad for this product?"
 *
 * APS.2b scoped the campaign-builder product picker to what is LISTED on a
 * marketplace. That removes eBay-only products, but a listed product can still
 * be unservable: out of stock, buy box lost, listing suppressed, no image. Those
 * launches succeed and then deliver nothing, which the operator discovers days
 * later in Amazon's console — the exact failure mode that motivated AX-VT.
 *
 * Amazon answers this directly via POST /eligibility/product/list, and considers
 * it important enough to have added the same statuses to bulksheets.
 *
 * Two deliberate choices:
 *
 *  · UNKNOWN IS NOT ELIGIBLE, AND IT IS NOT INELIGIBLE. When the call fails, the
 *    profile is missing, or Amazon returns nothing for an ASIN, the status is
 *    UNKNOWN. Rendering an unchecked product as "Eligible" would be a lie the
 *    operator acts on; rendering it "Ineligible" would block a launch Amazon
 *    would have accepted. The UI must show uncertainty as uncertainty.
 *
 *  · CACHED SHORT. Eligibility tracks stock and buy box, both of which move
 *    hourly. A long TTL would turn this from a safeguard into stale reassurance.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { peekCached, putCached } from './ads-cache.js'
import {
  listProductEligibility,
  type AdsEligibilityAdType,
  type AdsEligibilityStatus,
  type AdsRegion,
} from './ads-api-client.js'

/** Long enough to spare Amazon a call per keystroke, short enough to still be true. */
const TTL_SEC = 600

export type EligibilityVerdict = 'ELIGIBLE' | 'ELIGIBLE_WITH_WARNING' | 'INELIGIBLE' | 'UNKNOWN'

export interface EligibilityResult {
  asin: string
  status: EligibilityVerdict
  reasons: Array<{ name: string; severity: string; message: string | null; helpUrl: string | null }>
  /** Set when status is UNKNOWN, so the UI can say WHY it does not know. */
  unknownReason?: string
}

export interface EligibilityReport {
  marketplace: string
  adType: AdsEligibilityAdType
  /** Keyed by ASIN (uppercased). */
  items: Record<string, EligibilityResult>
  /** True when no live answer could be obtained at all (no profile, call failed). */
  degraded: boolean
  degradedReason?: string
}

async function resolveCtx(marketplace: string): Promise<{ profileId: string; region: AdsRegion } | null> {
  const conn = await prisma.amazonAdsConnection.findFirst({
    where: { marketplace, isActive: true },
    select: { profileId: true, region: true },
  })
  return conn ? { profileId: conn.profileId, region: (conn.region as AdsRegion) ?? 'EU' } : null
}

const unknown = (asin: string, why: string): EligibilityResult => ({
  asin, status: 'UNKNOWN', reasons: [], unknownReason: why,
})

/**
 * Look up eligibility for a set of ASINs on one marketplace.
 * Never throws — a failed lookup degrades to UNKNOWN so the picker keeps working.
 */
export async function getProductEligibility(input: {
  marketplace: string
  asins: string[]
  adType?: AdsEligibilityAdType
}): Promise<EligibilityReport> {
  const adType = input.adType ?? 'sp'
  const marketplace = input.marketplace.toUpperCase()
  const asins = Array.from(new Set(input.asins.map((a) => a.trim().toUpperCase()).filter(Boolean)))

  const empty: EligibilityReport = { marketplace, adType, items: {}, degraded: false }
  if (asins.length === 0) return empty

  const ctx = await resolveCtx(marketplace)
  if (!ctx) {
    return {
      ...empty,
      items: Object.fromEntries(asins.map((a) => [a, unknown(a, 'no active ads connection for this marketplace')])),
      degraded: true,
      degradedReason: `No active Amazon Ads connection for ${marketplace}.`,
    }
  }

  // Cached per (profile, adType, asin) so overlapping pages reuse each other's
  // answers instead of re-asking about the same ASIN on every page turn. Peek
  // first, then batch ONLY the misses into one Amazon call — which is why this
  // uses peek/put rather than cached(): cached() would store the probe.
  const key = (asin: string) => `elig:${ctx.profileId}:${adType}:${asin}`
  const items: Record<string, EligibilityResult> = {}
  const misses: string[] = []
  await Promise.all(asins.map(async (asin) => {
    const hit = await peekCached<EligibilityResult>(key(asin))
    if (hit) items[asin] = hit
    else misses.push(asin)
  }))

  if (misses.length === 0) return { ...empty, items }

  try {
    const res = await listProductEligibility(ctx, {
      products: misses.map((asin) => ({ asin })),
      adType,
    })
    const byAsin = new Map<string, typeof res[number]>()
    for (const r of res) if (r.asin) byAsin.set(String(r.asin).toUpperCase(), r)

    /**
     * Amazon's docs state that a request made of ASINs may come back describing
     * SKUs — "multiple SKUs may be returned for a single ASIN" — so a record can
     * legitimately arrive with no asin on it. Prod confirms rows come back that
     * key on nothing we asked for.
     *
     * Rather than trust one shape, correlate the leftovers through OUR catalogue:
     * ProductReadCache already maps sku → asin (APS.1). A SKU-shaped answer is
     * therefore still attributable to the ASIN the caller asked about.
     *
     * If several SKUs map to one ASIN, take the WORST status. An ASIN with one
     * blocked offer is not safely advertisable just because another offer is fine.
     */
    const unkeyed = res.filter((r) => !r.asin && r.sku)
    if (unkeyed.length > 0) {
      const skus = unkeyed.map((r) => String(r.sku))
      const rows = await prisma.productReadCache.findMany({
        where: { sku: { in: skus }, asin: { not: null } },
        select: { sku: true, asin: true },
      })
      const skuToAsin = new Map(rows.map((x) => [x.sku, String(x.asin).toUpperCase()]))
      const RANK: Record<string, number> = { ELIGIBLE: 0, ELIGIBLE_WITH_WARNING: 1, INELIGIBLE: 2 }
      for (const r of unkeyed) {
        const asin = skuToAsin.get(String(r.sku))
        if (!asin) continue
        const prev = byAsin.get(asin)
        if (!prev || (RANK[String(r.overallStatus)] ?? 0) > (RANK[String(prev.overallStatus)] ?? 0)) {
          byAsin.set(asin, r)
        }
      }
    }

    // Still nothing keyable — log the real field names once, otherwise this
    // degrades to a silent wall of UNKNOWN that reads like an empty catalogue.
    if (res.length > 0 && byAsin.size === 0) {
      logger.warn('[aps3-eligibility] rows returned but none keyed by asin or sku', {
        rows: res.length,
        firstRowKeys: Object.keys((res[0] ?? {}) as Record<string, unknown>).slice(0, 15),
        firstRow: JSON.stringify(res[0] ?? {}).slice(0, 700),
        requestedSample: misses.slice(0, 3),
      })
    }

    for (const asin of misses) {
      const r = byAsin.get(asin)
      if (!r) {
        // Amazon answered, but not about this ASIN. Silence is not consent.
        items[asin] = unknown(asin, 'Amazon returned no eligibility record for this ASIN')
        continue
      }
      const reasons = (r.eligibilityStatusList ?? []).map((s: AdsEligibilityStatus) => ({
        name: s.name,
        severity: s.severity,
        message: s.message ?? null,
        helpUrl: s.helpUrl ?? null,
      }))
      const out: EligibilityResult = { asin, status: r.overallStatus ?? 'UNKNOWN', reasons }
      items[asin] = out
      putCached(key(asin), out, TTL_SEC)
    }
    return { ...empty, items }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn('[aps3-eligibility] lookup failed', { marketplace, adType, count: misses.length, error: msg.slice(0, 200) })
    for (const asin of misses) items[asin] = unknown(asin, 'the eligibility lookup failed')
    return {
      ...empty,
      items,
      degraded: true,
      degradedReason: 'Amazon did not answer the eligibility check; statuses are unknown.',
    }
  }
}
