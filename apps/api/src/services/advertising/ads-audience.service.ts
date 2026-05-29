/**
 * AX3.4 — AMC-style no-SQL audiences.
 *
 * Pacvue/Intentwise's headline AMC feature is building audiences without SQL.
 * This lets operators compose an audience from a template (cart abandoners,
 * product viewers, past purchasers, lookalike, suppression, competitor
 * viewers) by filling in a lookback + ASINs — no query language. The
 * definition is stored as AdAudience; "activate" materialises it (sandbox
 * returns a stub id; live creates the AMC/DSP audience behind the write gate).
 *
 * Reach: browsing-signal audiences (viewers/abandoners) genuinely need AMC to
 * size, so we label those honestly rather than inventing a number.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export interface AudienceTemplate { type: string; label: string; blurb: string; defaultLookbackDays: number; needsAsins: boolean; funnel: 'awareness' | 'consideration' | 'conversion' | 'retention' }
export const AUDIENCE_TEMPLATES: AudienceTemplate[] = [
  { type: 'PRODUCT_VIEWERS', label: 'Product viewers (no purchase)', blurb: 'Shoppers who viewed your detail pages but didn’t buy — prime retargeting.', defaultLookbackDays: 30, needsAsins: true, funnel: 'consideration' },
  { type: 'CART_ABANDONERS', label: 'Cart abandoners', blurb: 'Added to cart, didn’t check out — the closest-to-convert segment.', defaultLookbackDays: 14, needsAsins: true, funnel: 'conversion' },
  { type: 'PAST_PURCHASERS', label: 'Past purchasers', blurb: 'Existing customers — cross-sell, Subscribe & Save, loyalty.', defaultLookbackDays: 90, needsAsins: true, funnel: 'retention' },
  { type: 'LOOKALIKE', label: 'Lookalike of best customers', blurb: 'Net-new shoppers modeled on your highest-value buyers.', defaultLookbackDays: 90, needsAsins: false, funnel: 'awareness' },
  { type: 'SUPPRESSION', label: 'Suppress recent purchasers', blurb: 'Exclude people who just bought — stop wasting impressions.', defaultLookbackDays: 30, needsAsins: true, funnel: 'conversion' },
  { type: 'COMPETITOR_VIEWERS', label: 'Competitor viewers', blurb: 'Shoppers browsing rival ASINs — conquest targeting.', defaultLookbackDays: 30, needsAsins: true, funnel: 'consideration' },
]

export interface NewAudience { name: string; audienceType: string; marketplace?: string; lookbackDays?: number; asins?: string[]; params?: Record<string, unknown>; createdBy?: string }

export async function createAudience(input: NewAudience) {
  const tpl = AUDIENCE_TEMPLATES.find((t) => t.type === input.audienceType)
  const lookbackDays = input.lookbackDays ?? tpl?.defaultLookbackDays ?? 30
  const asins = (input.asins ?? []).map((a) => a.trim()).filter(Boolean)
  const { reach, basis } = await estimateReach(input.audienceType, asins, lookbackDays, input.marketplace)
  const row = await prisma.adAudience.create({
    data: { name: input.name, audienceType: input.audienceType, marketplace: input.marketplace ?? null, lookbackDays, asins, params: (input.params ?? {}) as never, estimatedReach: reach, reachBasis: basis, status: 'DRAFT', createdBy: input.createdBy ?? null },
  })
  logger.info('[AX3.4] createAudience', { id: row.id, type: input.audienceType, reach, basis })
  return row
}

export async function listAudiences() {
  const items = await prisma.adAudience.findMany({ orderBy: { createdAt: 'desc' }, take: 500 })
  return { items, count: items.length }
}

export async function activateAudience(id: string) {
  const a = await prisma.adAudience.findUnique({ where: { id } })
  if (!a) throw new Error('audience not found')
  // Sandbox: stub an external id. Live AMC/DSP audience creation plugs in here
  // behind the write gate once the AMC instance + DSP entitlement are set up.
  const externalAudienceId = a.externalAudienceId ?? `sb-aud-${id.slice(0, 8)}`
  const row = await prisma.adAudience.update({ where: { id }, data: { status: 'ACTIVE', externalAudienceId } })
  logger.info('[AX3.4] activateAudience', { id, externalAudienceId })
  return row
}

export async function archiveAudience(id: string) {
  return prisma.adAudience.update({ where: { id }, data: { status: 'ARCHIVED' } }).catch(() => null)
}

/** Best-effort reach. PAST_PURCHASERS / SUPPRESSION can be sized from our own
 *  order history; browsing-signal types need AMC and are labelled as such. */
async function estimateReach(type: string, asins: string[], lookbackDays: number, marketplace?: string): Promise<{ reach: number | null; basis: string }> {
  if (type === 'PAST_PURCHASERS' || type === 'SUPPRESSION') {
    try {
      const since = new Date(Date.now() - lookbackDays * 86_400_000)
      // Count distinct orders in window touching the ASINs (proxy for buyers).
      const where: Record<string, unknown> = { createdAt: { gte: since } }
      if (marketplace) where.marketplace = marketplace
      if (asins.length) where.items = { some: { asin: { in: asins } } }
      const n = await prisma.order.count({ where: where as never }).catch(() => null)
      if (n != null) return { reach: n, basis: 'computed' }
    } catch { /* fall through */ }
    return { reach: null, basis: 'amc-estimate' }
  }
  // Viewers / cart / lookalike / competitor → require AMC browsing signals.
  return { reach: null, basis: 'amc-estimate' }
}
