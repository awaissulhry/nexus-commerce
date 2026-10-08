/**
 * ONE BRAIN AB-18 — the rows of the off-Amazon lane (brain/off-amazon.ts), read only: it changes nothing, in Nexus or at
 * Amazon, and asks Amazon nothing. The `ads-brain` money view calls it (brain/budget-read.ts).
 *
 *   report   AmazonAdsPlacementReport — the daily placement report as ads-reports.service.ts ingests it, every label as
 *            Amazon sent it — by the campaigns' Amazon ids over the settled window (OFF_AMAZON_WINDOW_DAYS). One query.
 *   stream   AmazonAdsHourlyPlacement (BB-16) rows the Marketing Stream mapped to OFF_AMAZON on the summed campaigns, in the
 *            same window: a second witness, never judged (its conversions are deltas Amazon still restates). One query.
 *   market   every Sponsored Products campaign of the market (archived left out) with its owner (brain/ownership.ts), and
 *            each product's own campaigns' rows in one query: the share per product. Exclusions are not resolved here
 *            (read one product for the judgement).
 */
import prisma from '../../../db.js'
import { settledBounds } from '../ads-settled-window.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { OFF_AMAZON } from '../ams-grain.js'
import { resolveCampaignOwnership } from './ownership.js'
import {
  decideOffAmazon, OFF_AMAZON_WINDOW_DAYS,
  type LaneCampaign, type OffAmazonLane, type OffAmazonLever, type PlacementRow, type StreamWitness,
} from './off-amazon.js'

const dayKey = (d: Date) => d.toISOString().slice(0, 10)
const dayDate = (day: string) => new Date(`${day}T00:00:00.000Z`)
const cents = (micros: bigint | number | null | undefined) => Math.round(Number(micros ?? 0) / 10_000)

/** The settled window the lane is judged over (inclusive days). */
export function offAmazonWindow(now: Date): { from: string; to: string } {
  const w = settledBounds(OFF_AMAZON_WINDOW_DAYS, 'SPONSORED_PRODUCTS', { now })
  return { from: dayKey(w.since), to: dayKey(w.until) }
}

type CampaignRef = { id: string; externalCampaignId: string | null }

/** The daily placement report rows of these campaigns in the window, one per campaign × day × label as Amazon named it. */
export async function loadPlacementRows(campaigns: readonly CampaignRef[], window: { from: string; to: string }): Promise<PlacementRow[]> {
  const local = new Map(campaigns.filter((c) => c.externalCampaignId).map((c) => [c.externalCampaignId!, c.id]))
  if (!local.size) return []
  const rows = await prisma.amazonAdsPlacementReport.findMany({
    where: { adProduct: 'SPONSORED_PRODUCTS', campaignId: { in: [...local.keys()] }, date: { gte: dayDate(window.from), lte: dayDate(window.to) } },
    select: { campaignId: true, date: true, placement: true, costMicros: true, sales7dCents: true, orders7d: true, clicks: true },
  })
  return rows.map((r) => ({
    campaignId: local.get(r.campaignId)!, day: dayKey(r.date), label: r.placement,
    costCents: cents(r.costMicros), salesCents: r.sales7dCents ?? 0, orders: r.orders7d ?? 0, clicks: r.clicks,
  }))
}

/** What the Marketing Stream mapped to OFF_AMAZON on these campaigns in the window; null when it saw nothing. */
export async function loadStreamWitness(campaigns: readonly CampaignRef[], window: { from: string; to: string }): Promise<StreamWitness | null> {
  const ext = campaigns.map((c) => c.externalCampaignId).filter((x): x is string => !!x)
  if (!ext.length) return null
  const agg = await prisma.amazonAdsHourlyPlacement.aggregate({
    where: { campaignId: { in: ext }, placement: OFF_AMAZON, date: { gte: dayDate(window.from), lte: dayDate(window.to) } },
    _sum: { costMicros: true, sales7dCents: true, orders7d: true },
    _count: { _all: true },
  })
  if (!agg._count._all) return null
  // The stream's rows are sums of deltas: a transient negative is shown as 0 (ams-grain.ts).
  return { costCents: Math.max(0, cents(agg._sum.costMicros)), salesCents: Math.max(0, agg._sum.sales7dCents ?? 0), orders: Math.max(0, agg._sum.orders7d ?? 0), hours: agg._count._all }
}

const refsOf = async (ids: readonly string[]): Promise<CampaignRef[]> =>
  (ids.length ? await prisma.campaign.findMany({ where: { id: { in: [...ids] } }, select: { id: true, externalCampaignId: true } }) : [])

/**
 * One product's lane: its campaigns as the money facts list them (own and shared, each with its exclusion), its band top
 * and its offAmazon lever. Read only.
 */
export async function productOffAmazon(input: {
  productId: string; name: string | null; market: string; currency: string; now: Date
  campaigns: readonly LaneCampaign[]; bandTop: { hi: number; words: string } | null; lever: OffAmazonLever
}): Promise<OffAmazonLane> {
  const window = offAmazonWindow(input.now)
  const refs = await refsOf(input.campaigns.map((c) => c.campaignId))
  const summed = new Set(input.campaigns.filter((c) => c.owner === 'product' && !c.excluded).map((c) => c.campaignId))
  const [rows, stream] = await Promise.all([
    loadPlacementRows(refs, window),
    loadStreamWitness(refs.filter((r) => summed.has(r.id)), window),
  ])
  return decideOffAmazon({ ...input, window, rows, stream })
}

/** Each product's share of off-Amazon spend over its own campaigns in the market (no judgement). Read only. */
export async function marketOffAmazon(marketIn: string, productIds: readonly string[], now: Date, currency: string): Promise<Map<string, OffAmazonLane>> {
  const out = new Map<string, OffAmazonLane>()
  const market = strategyMarket(marketIn)
  if (!market || !productIds.length) return out
  const window = offAmazonWindow(now)
  const all = await prisma.campaign.findMany({
    where: { adProduct: 'SPONSORED_PRODUCTS', status: { not: 'ARCHIVED' } },
    select: { id: true, name: true, marketplace: true, externalCampaignId: true },
  })
  const campaigns = all.filter((c) => strategyMarket(c.marketplace) === market)
  const owners = await resolveCampaignOwnership(campaigns.map((c) => c.id))
  const wanted = new Set(productIds)
  const own = new Map<string, LaneCampaign[]>()
  for (const c of campaigns) {
    const o = owners.get(c.id)?.owner
    if (o?.kind !== 'product' || !wanted.has(o.productId)) continue
    own.set(o.productId, [...(own.get(o.productId) ?? []), { campaignId: c.id, name: c.name, owner: 'product', excluded: false }])
  }
  const ownIds = new Set([...own.values()].flat().map((x) => x.campaignId))
  const rows = await loadPlacementRows(campaigns.filter((c) => ownIds.has(c.id)), window)
  const byCampaign = new Map<string, PlacementRow[]>()
  for (const r of rows) byCampaign.set(r.campaignId, [...(byCampaign.get(r.campaignId) ?? []), r])
  for (const productId of productIds) {
    const list = own.get(productId) ?? []
    out.set(productId, decideOffAmazon({
      productId, name: null, market, currency, window, campaigns: list,
      rows: list.flatMap((c) => byCampaign.get(c.campaignId) ?? []), stream: null,
      bandTop: null, lever: { effective: 'OBSERVE', lock: null },
    }))
  }
  return out
}
