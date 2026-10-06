/**
 * AX3.1 — Retail-readiness guard ("don't advertise what you can't sell").
 *
 * Pacvue/Perpetua sell this as a retail-data *integration*; we own stock,
 * Buy Box, and pricing in the same database, so it's native and real-time.
 * For every enabled campaign we resolve its advertised products and check:
 *   - in stock      → StockLevel.available (fallback Product.totalStock)
 *   - Buy Box       → latest BuyBoxHistory.isOurOffer (channel+marketplace)
 *   - price-compet. → ChannelListing.price ≤ lowestCompetitorPrice
 * A campaign whose *every* advertised product is out of stock (or has lost
 * the Buy Box) is burning spend → recommend/auto-pause. Partial issues are
 * surfaced as "watch". Apply pauses via the gated, audited write path.
 */

import prisma from '../../db.js'
import { suppressCampaignBids } from './ads-bid-suppression.service.js'
import { adsActorOf } from './ads-actor.js'
import { logger } from '../../utils/logger.js'
import { loadSyncLedgers, type ProductLedger } from '../stock-pool/sync-ledgers.js'
import { stopBidsFor, strategySourceWords } from './ads-strategy/effective.js'

export type Verdict = 'pause' | 'watch' | 'ok'
export interface ProductReadiness {
  productId: string | null; sku: string | null; asin: string | null; name: string | null; inStock: boolean; availableQty: number; hasBuyBox: boolean | null; priceCompetitive: boolean | null
  /** ADS AUTONOMY W3-3 — the parts of `availableQty`: units at Amazon FBA (Amazon's number, read only) and in the ledger the product sells from (its own warehouses, or the pool it borrows from). */
  amazonFbaQty?: number
  warehouseQty?: number
  /** W3-3 — its warehouse units are another business's shared pool (lent stock), which that business sells from too. */
  pooled?: boolean
}
export interface CampaignReadiness {
  campaignId: string; name: string; marketplace: string | null; status: string
  products: number; outOfStock: number; lostBuyBox: number; uncompetitive: number; unknown: number
  verdict: Verdict; reason: string
}
export interface ReadinessResult {
  generatedAt: string
  campaigns: CampaignReadiness[]
  summary: { pause: number; watch: number; ok: number; atRiskSpendNote: string }
}

/**
 * Each product's stock, Buy Box and price as the guard judges them, read once for a set of products. ADS AUTONOMY
 * W3-3 — shared with the stock-aware bids (ads-stock-risk.service.ts), so both count a product's units the same way.
 * Read only: nothing here writes stock, and Amazon's FBA number is only read.
 */
export async function productReadinessReader(productIds: readonly string[]): Promise<(productId: string, marketplace: string | null) => ProductReadiness> {
  const ids = [...new Set(productIds)]
  const products = ids.length
    ? await prisma.product.findMany({
        where: { id: { in: ids } },
        select: {
          id: true, sku: true, name: true, totalStock: true,
          stockLevels: { select: { available: true, location: { select: { type: true } } } },
          channelListings: { select: { marketplace: true, channel: true, price: true, lowestCompetitorPrice: true } },
          buyBoxHistory: { orderBy: { observedAt: 'desc' }, take: 5, select: { channel: true, marketplace: true, isOurOffer: true } },
        },
      })
    : []
  const pMap = new Map(products.map((p) => [p.id, p]))
  // Shared stock — warehouse units come from the product's ledger (its own warehouses, or the pool it
  // sells from); Amazon-held units stay its own. A pooled product is not "out of stock" here.
  // (W3-3: the ledgers themselves — sellableAvailable's numbers — so the stock-aware bids can tell a pooled product.)
  const ledgers = products.length ? await loadSyncLedgers(prisma, products.map((p) => p.id)) : new Map<string, ProductLedger>()

  return function readiness(productId: string, marketplace: string | null): ProductReadiness {
    const p = pMap.get(productId)
    if (!p) return { productId, sku: null, asin: null, name: null, inStock: true, availableQty: 0, hasBuyBox: null, priceCompetitive: null }
    const held = p.stockLevels.filter((sl) => sl.location?.type !== 'WAREHOUSE')
    const ledger = ledgers.get(p.id)
    const warehouse = ledger?.available ?? 0
    const available = held.reduce((s, sl) => s + (sl.available ?? 0), 0) + warehouse
    const inStock = available > 0 || (p.totalStock ?? 0) > 0
    const cl = p.channelListings.find((x) => x.channel === 'AMAZON' && (!marketplace || x.marketplace === marketplace)) ?? p.channelListings.find((x) => x.channel === 'AMAZON')
    const priceCompetitive = cl?.price != null && cl?.lowestCompetitorPrice != null ? Number(cl.price) <= Number(cl.lowestCompetitorPrice) * 1.02 : null
    const bb = p.buyBoxHistory.find((x) => x.channel === 'AMAZON' && (!marketplace || x.marketplace === marketplace)) ?? p.buyBoxHistory[0]
    const hasBuyBox = bb ? bb.isOurOffer : null
    const amazonFbaQty = held.filter((sl) => sl.location?.type === 'AMAZON_FBA').reduce((s, sl) => s + (sl.available ?? 0), 0)
    return { productId, sku: p.sku, asin: null, name: p.name, inStock, availableQty: available || (p.totalStock ?? 0), hasBuyBox, priceCompetitive, amazonFbaQty, warehouseQty: warehouse, pooled: ledger?.source.kind === 'pool' }
  }
}

export async function analyzeRetailReadiness(opts: { marketplace?: string; campaignId?: string } = {}): Promise<ReadinessResult> {
  const where: Record<string, unknown> = { status: 'ENABLED' }
  if (opts.marketplace) where.marketplace = opts.marketplace
  if (opts.campaignId) where.id = opts.campaignId
  const campaigns = await prisma.campaign.findMany({
    where, take: 1000,
    select: { id: true, name: true, marketplace: true, status: true, adGroups: { select: { productAds: { select: { productId: true, asin: true, sku: true } } } } },
  })

  // Collect all advertised product ids across campaigns.
  const productIds = new Set<string>()
  for (const c of campaigns) for (const g of c.adGroups) for (const pa of g.productAds) if (pa.productId) productIds.add(pa.productId)
  const readiness = await productReadinessReader([...productIds])

  const out: CampaignReadiness[] = []
  for (const c of campaigns) {
    const seen = new Set<string>()
    const rs: ProductReadiness[] = []
    for (const g of c.adGroups) for (const pa of g.productAds) {
      if (pa.productId && !seen.has(pa.productId)) { seen.add(pa.productId); rs.push(readiness(pa.productId, c.marketplace)) }
    }
    const productsN = rs.length
    const outOfStock = rs.filter((r) => !r.inStock).length
    const lostBuyBox = rs.filter((r) => r.hasBuyBox === false).length
    const uncompetitive = rs.filter((r) => r.priceCompetitive === false).length
    const unknown = rs.filter((r) => r.hasBuyBox === null && r.priceCompetitive === null).length
    let verdict: Verdict = 'ok', reason = 'All advertised products sellable.'
    if (productsN === 0) { verdict = 'ok'; reason = 'No locally-linked products to check.' }
    else if (outOfStock === productsN) { verdict = 'pause'; reason = `All ${productsN} advertised product(s) out of stock — spend is wasted.` }
    else if (lostBuyBox === productsN && productsN > 0) { verdict = 'pause'; reason = `Lost the Buy Box on all ${productsN} advertised product(s) — clicks won't convert to your offer.` }
    else if (outOfStock > 0 || lostBuyBox > 0 || uncompetitive > 0) {
      verdict = 'watch'
      const bits = [outOfStock && `${outOfStock} out of stock`, lostBuyBox && `${lostBuyBox} lost Buy Box`, uncompetitive && `${uncompetitive} uncompetitive`].filter(Boolean)
      reason = `Partial: ${bits.join(', ')} of ${productsN}.`
    }
    out.push({ campaignId: c.id, name: c.name, marketplace: c.marketplace, status: c.status, products: productsN, outOfStock, lostBuyBox, uncompetitive, unknown, verdict, reason })
  }

  const order: Record<Verdict, number> = { pause: 0, watch: 1, ok: 2 }
  out.sort((a, b) => order[a.verdict] - order[b.verdict] || b.outOfStock - a.outOfStock)
  const pause = out.filter((c) => c.verdict === 'pause').length
  return {
    generatedAt: new Date().toISOString(),
    campaigns: out,
    summary: { pause, watch: out.filter((c) => c.verdict === 'watch').length, ok: out.filter((c) => c.verdict === 'ok').length, atRiskSpendNote: `${pause} campaign(s) advertising only unsellable products.` },
  }
}

/** Guard the campaigns the analysis flags as 'pause' (or an explicit list) by
 *  flooring their bids to ~2¢ — NO-PAUSE policy (pausing disrupts Amazon's algo).
 *  Bids are remembered and restored when the products become sellable again.
 *  Goes through the gated, audited write path. (`paused` = guarded count, kept for
 *  the existing intel-routes display.)
 *  ADS AUTONOMY W1-6 — the floor is the ads strategy's stop bid for the campaign (its market, the lower across its
 *  products) when one is set, else the 2¢ floor. */
export async function applyRetailGuard(args: {
  campaignIds?: string[]; actor?: string; marketplace?: string
  /** AA-W2-10 (D7) — the change set every floored bid joins (an approval that carries a rule suggestion out); optional. */
  changeSetId?: string | null
}): Promise<{ paused: string[]; skipped: number }> {
  let ids = args.campaignIds
  if (!ids) {
    const analysis = await analyzeRetailReadiness({ marketplace: args.marketplace })
    ids = analysis.campaigns.filter((c) => c.verdict === 'pause').map((c) => c.campaignId)
  }
  const paused: string[] = []
  let skipped = 0
  // A stop bid that cannot be read: the 2¢ floor, the lowest stop bid there is (a stop never lands higher by accident).
  const stops = await (async () => stopBidsFor(ids.length ? await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, marketplace: true } }) : []))()
    .catch((err) => {
      logger.warn('[AX3.1] ads strategy stop bids unreadable — retail guard floors at 2¢', { error: String(err) })
      return new Map<string, { cents: number; source: null }>()
    })
  for (const id of ids) {
    // NP — never pause: floor the campaign's bids to ~2¢, or the strategy's stop bid (restorable) instead.
    const stop = stops.get(id)
    const named = stop?.source ? ` at ${stop.cents}¢ (${strategySourceWords(stop.source)})` : ''
    try { await suppressCampaignBids(id, { actor: adsActorOf(args.actor, 'retail-guard'), floorCents: stop?.cents ?? null, reason: `Retail-readiness guard: products unsellable → bids floored${named} (no-pause)`, ...(args.changeSetId ? { changeSetId: args.changeSetId } : {}) }); paused.push(id) } catch { skipped++ }
  }
  logger.info('[AX3.1] applyRetailGuard', { paused: paused.length, skipped })
  return { paused, skipped }
}

/** Cron entry: analyse + (optionally) auto-pause. Auto-apply is opt-in via
 *  NEXUS_ADS_RETAIL_GUARD_APPLY=1; otherwise it only logs what it would do. */
export async function runRetailGuardOnce(): Promise<{ flagged: number; paused: number; applied: boolean }> {
  const analysis = await analyzeRetailReadiness({})
  const flagged = analysis.campaigns.filter((c) => c.verdict === 'pause').map((c) => c.campaignId)
  const apply = process.env.NEXUS_ADS_RETAIL_GUARD_APPLY === '1'
  let paused = 0
  if (apply && flagged.length) { const r = await applyRetailGuard({ campaignIds: flagged, actor: 'retail-guard-cron' }); paused = r.paused.length }
  logger.info('[AX3.1] runRetailGuardOnce', { flagged: flagged.length, paused, applied: apply })
  return { flagged: flagged.length, paused, applied: apply }
}
