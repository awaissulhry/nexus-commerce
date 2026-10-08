/**
 * BID BRAIN BB-15 — the lag curves of a business: fitted each night from the vintages and stored (AdsLagCurve), read by the
 * nowcast and by the `bid-brain` read tool's calibration view. The maths is lag-curve.ts (pure); this file reads and writes.
 * Called inside a business (the cron runs once per business; RLS keeps each to its own rows).
 *
 *   fit     per market of the business's Sponsored Products vintages (campaign grain, the last VINTAGE_FIT_DAYS days):
 *           the copies and every age a pull was asked at (the ingested campaign report jobs), the 1d/7d seed from the
 *           settled campaign rows, the market's curve, its calibration on the newest CALIBRATION_DAYS settled days, and a
 *           curve for each product family with PRODUCT_MIN_ORDERS final orders of its own (campaigns advertising one family
 *           only). One row per market and per such product, replaced; a product that no longer qualifies loses its row.
 *   read    the market's curve and its products' curves — only a usable curve, fitted within CURVE_MAX_AGE_DAYS: a fit that
 *           stopped running is not trusted for long (the nowcast then reads the settled window, as before BB-15).
 *
 * Idempotent: the same rows give the same curves; a rerun rewrites the same row.
 */
import { Prisma } from '@prisma/client'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../../db.js'
import { attributionWindowDays } from '@nexus/shared/data-vintage'
import { strategyMarket } from '../ads-strategy/bids.js'
import {
  calibrate, dayCopiesOf, fitLagCurve, fitProductCurve, lagPoints, marketPrior, parseShares,
  type Calibration, type LagCurve, type LagSeed, type LagShares, type LagSource,
} from './lag-curve.js'

/** The ad product whose curves are fitted (the bid brain's). */
export const LAG_AD_PRODUCT = 'SPONSORED_PRODUCTS'
export const MARKET_SCOPE = '*'
/** Days of vintages (and of settled rows for the seed) a fit reads. */
export const VINTAGE_FIT_DAYS = 90
/** The newest settled days a calibration holds out and nowcasts. */
export const CALIBRATION_DAYS = 14
/** A stored curve older than this is not used by the nowcast (the nightly fit has stopped). */
export const CURVE_MAX_AGE_DAYS = 14
/** CAMPAIGN_REPORT_TYPE_ID.SPONSORED_PRODUCTS (ads-reports.service.ts; pinned by a test — that module is not loaded here). */
export const SP_CAMPAIGN_REPORT = 'spCampaigns'

const DAY = 86_400_000
const isoDay = (d: Date) => d.toISOString().slice(0, 10)

export interface StoredCurve {
  market: string
  scopeId: string
  source: LagSource
  usable: boolean
  shares: LagShares
  basis: LagCurve['basis']
  calibration: Calibration | null
  fittedAt: Date
}

function toStored(r: { marketplace: string; scopeId: string; source: string; usable: boolean; shares: unknown; basis: unknown; calibration: unknown; fittedAt: Date }): StoredCurve | null {
  const shares = parseShares(r.shares)
  if (!shares) return null
  const source: LagSource = r.source === 'vintages' || r.source === 'seed' ? r.source : 'prior'
  return { market: r.marketplace, scopeId: r.scopeId, source, usable: r.usable, shares, basis: r.basis as LagCurve['basis'], calibration: (r.calibration ?? null) as Calibration | null, fittedAt: r.fittedAt }
}

/** Every stored curve of these markets (any age, usable or not): the read view's rows. */
export async function storedCurves(markets: readonly string[]): Promise<StoredCurve[]> {
  if (!markets.length) return []
  const rows = await prisma.adsLagCurve.findMany({
    where: { marketplace: { in: [...markets] }, adProduct: LAG_AD_PRODUCT },
    select: { marketplace: true, scopeId: true, source: true, usable: true, shares: true, basis: true, calibration: true, fittedAt: true },
    orderBy: [{ marketplace: 'asc' }, { scopeId: 'asc' }],
  })
  return rows.flatMap((r) => toStored(r) ?? [])
}

/** The curves the nowcast may use for one market: null when its market curve is missing, not usable or stale. */
export async function nowcastCurves(market: string, now: Date): Promise<{ market: StoredCurve; products: Map<string, StoredCurve> } | null> {
  const fresh = (c: StoredCurve) => c.usable && now.getTime() - c.fittedAt.getTime() <= CURVE_MAX_AGE_DAYS * DAY
  const all = (await storedCurves([market])).filter(fresh)
  const own = all.find((c) => c.scopeId === MARKET_SCOPE)
  if (!own) return null
  return { market: own, products: new Map(all.filter((c) => c.scopeId !== MARKET_SCOPE).map((c) => [c.scopeId, c])) }
}

/** Curve words for a why or a line: "IT market curve (vintages, 40 days, L(0) 82 %)". */
export function curveWords(c: StoredCurve): string {
  const what = c.scopeId === MARKET_SCOPE ? `${c.market} market curve` : `product ${c.scopeId} curve`
  const rest = c.source === 'vintages' ? `vintages, ${c.basis?.vintageDays ?? 0} days` : c.source === 'seed' ? `1d/7d seed${c.basis?.vintageDays ? ` + ${c.basis.vintageDays} days of vintages` : ''}` : 'prior'
  return `${what} (${rest}, L(0) ${Math.round(c.shares.orders[0] * 100)} %)`
}

// ── The nightly fit ─────────────────────────────────────────────────────────────────────────────────

export interface MarketFit {
  market: string
  source: LagSource
  usable: boolean
  firstSharePct: number
  vintageDays: number
  finalOrders: number
  seeded: boolean
  products: number
  calibration: { days: number; maeOrders: number; maeOrdersRaw: number } | null
}
export interface LagFitSummary { markets: MarketFit[]; removed: number }

/** The settled campaign rows' 1d/7d sums per market (rows that asked the 1-day columns: orders1d not null). */
async function loadSeeds(since: Date): Promise<Map<string, LagSeed>> {
  const w = attributionWindowDays(LAG_AD_PRODUCT)
  const rows = await prisma.$queryRaw<Array<{ marketplace: string; o1: number; o7: number; s1: number; s7: number; days: number }>>(Prisma.sql`
    SELECT p.marketplace, SUM(p."orders1d")::float8 AS o1, SUM(COALESCE(p."orders7d", 0))::float8 AS o7,
           SUM(COALESCE(p."sales1dCents", 0))::float8 AS s1, SUM(COALESCE(p."sales7dCents", 0))::float8 AS s7,
           COUNT(DISTINCT p.date)::int AS days
      FROM "AmazonAdsDailyPerformance" p
     WHERE p."entityType" = 'CAMPAIGN' AND p."adProduct" = ${LAG_AD_PRODUCT} AND p."orders1d" IS NOT NULL
       AND p.date >= ${isoDay(since)}::date AND (p."reportedAt"::date - p.date - 1) >= ${w}
     GROUP BY p.marketplace`)
  const out = new Map<string, LagSeed>()
  for (const r of rows) {
    const market = strategyMarket(r.marketplace)
    if (!market) continue
    const had = out.get(market) ?? { orders1d: 0, orders7d: 0, sales1dCents: 0, sales7dCents: 0, days: 0 }
    out.set(market, { orders1d: had.orders1d + Number(r.o1), orders7d: had.orders7d + Number(r.o7), sales1dCents: had.sales1dCents + Number(r.s1), sales7dCents: had.sales7dCents + Number(r.s7), days: Math.max(had.days, Number(r.days)) })
  }
  return out
}

/** Each Amazon campaign id → the product families it advertises. */
async function familiesOf(externalCampaignIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  if (!externalCampaignIds.length) return out
  const ads = await prisma.adProductAd.findMany({
    where: { productId: { not: null }, adGroup: { campaign: { externalCampaignId: { in: [...externalCampaignIds] } } } },
    select: { productId: true, product: { select: { parentId: true } }, adGroup: { select: { campaign: { select: { externalCampaignId: true } } } } },
  })
  for (const a of ads) {
    const id = a.adGroup.campaign.externalCampaignId
    if (!id) continue
    ;(out.get(id) ?? out.set(id, new Set()).get(id)!).add(a.product?.parentId ?? a.productId!)
  }
  return out
}

/** Fit and store every market's curve (and its products') for the business in context. */
export async function fitLagCurves(opts: { now?: Date } = {}): Promise<LagFitSummary> {
  const now = opts.now ?? new Date()
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - VINTAGE_FIT_DAYS * DAY)
  const windowDays = attributionWindowDays(LAG_AD_PRODUCT)
  const vintages = await prisma.adsDailyVintage.findMany({
    where: { adProduct: LAG_AD_PRODUCT, entityType: 'CAMPAIGN', date: { gte: since } },
    select: { profileId: true, marketplace: true, entityId: true, date: true, pulledAt: true, ageDays: true, orders7d: true, sales7dCents: true },
  })
  const profileIds = [...new Set(vintages.map((v) => v.profileId))]
  const [pulls, seeds, families] = await Promise.all([
    profileIds.length
      ? prisma.amazonAdsReportJob.findMany({
          where: { profileId: { in: profileIds }, reportTypeId: SP_CAMPAIGN_REPORT, status: 'COMPLETED', ingestedAt: { not: null }, endDate: { gte: since } },
          select: { profileId: true, startDate: true, endDate: true, createdAt: true },
        })
      : Promise.resolve([]),
    loadSeeds(since),
    familiesOf([...new Set(vintages.map((v) => v.entityId))]),
  ])
  const byMarket = dayCopiesOf(
    vintages.flatMap((v) => { const market = strategyMarket(v.marketplace); return market ? [{ ...v, market }] : [] }),
    pulls,
  )
  const markets = [...new Set([...byMarket.keys(), ...seeds.keys()])].sort()
  const summary: LagFitSummary = { markets: [], removed: 0 }
  for (const market of markets) {
    const days = byMarket.get(market) ?? []
    const seed = seeds.get(market) ?? null
    const prior = marketPrior(seed, LAG_AD_PRODUCT)
    const curve = fitLagCurve(lagPoints(days, windowDays), prior, { seed, windowDays })
    const calibration = calibrate(days, prior, { evalDays: CALIBRATION_DAYS, windowDays, seed })
    // A product's own curve: the campaign days of campaigns that advertise that one family only.
    const byFamily = new Map<string, typeof days>()
    for (const d of days) {
      const fams = families.get(d.entityId)
      if (fams?.size !== 1) continue
      const [fam] = fams
      ;(byFamily.get(fam) ?? byFamily.set(fam, []).get(fam)!).push(d)
    }
    const products = [...byFamily].flatMap(([fam, list]) => {
      const c = fitProductCurve(lagPoints(list, windowDays), curve, windowDays)
      return c ? [{ fam, curve: c }] : []
    })
    await store(market, MARKET_SCOPE, curve, calibration, now)
    for (const p of products) await store(market, p.fam, p.curve, null, now)
    const gone = await prisma.adsLagCurve.deleteMany({ where: { marketplace: market, adProduct: LAG_AD_PRODUCT, scopeId: { notIn: [MARKET_SCOPE, ...products.map((p) => p.fam)] } } })
    summary.removed += gone.count
    summary.markets.push({
      market, source: curve.source, usable: curve.usable, firstSharePct: Math.round(curve.shares.orders[0] * 1000) / 10,
      vintageDays: curve.basis.vintageDays, finalOrders: curve.basis.finalOrders, seeded: !!curve.basis.seed, products: products.length,
      calibration: calibration ? { days: calibration.overall.days, maeOrders: calibration.overall.maeOrders, maeOrdersRaw: calibration.overall.maeOrdersRaw } : null,
    })
  }
  return summary
}

async function store(market: string, scopeId: string, curve: LagCurve, calibration: Calibration | null, now: Date): Promise<void> {
  const data = {
    source: curve.source,
    usable: curve.usable,
    shares: curve.shares as unknown as Prisma.InputJsonObject,
    basis: curve.basis as unknown as Prisma.InputJsonObject,
    calibration: calibration ? (calibration as unknown as Prisma.InputJsonObject) : Prisma.DbNull,
    fittedAt: now,
  }
  await prisma.adsLagCurve.upsert({
    where: { lag_curve_scope: workspaceKey({ marketplace: market, adProduct: LAG_AD_PRODUCT, scopeId }) },
    create: { marketplace: market, adProduct: LAG_AD_PRODUCT, scopeId, ...data },
    update: data,
  })
}

/** The cron's one line: "IT vintages L(0) 82% 40d usable products=1 cal MAE 0.4 vs 0.9 · DE seed …". */
export function lagFitSummaryLine(s: LagFitSummary): string {
  if (!s.markets.length) return 'no Sponsored Products vintages or settled rows: nothing fitted'
  const parts = s.markets.map((m) => `${m.market} ${m.source} L(0) ${m.firstSharePct}% ${m.vintageDays}d${m.usable ? ' usable' : ' not usable (young days ignored)'}${m.products ? ` products=${m.products}` : ''}${m.calibration ? ` cal ${m.calibration.days} MAE ${m.calibration.maeOrders} vs ${m.calibration.maeOrdersRaw} raw` : ''}`)
  return `${parts.join(' · ')}${s.removed ? ` removed=${s.removed}` : ''}`
}
