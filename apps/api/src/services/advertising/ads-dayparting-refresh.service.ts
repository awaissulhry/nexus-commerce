/**
 * RC2.T6 — autonomous dayparting refresh.
 *
 * Conversion timing drifts (seasonality, range changes), so a schedule applied
 * once goes stale. This re-derives a product family's dayparting windows from
 * FRESH order demand and updates the family's AdSchedules — driven by a
 * `refresh_dayparting` automation rule (SCHEDULE-triggered) the cockpit creates.
 *
 * Also the single source of truth for the campaign → parent-family resolution:
 * GET /advertising/campaigns/:id/product-dayparting delegates to resolveProductFamily.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { ACTION_HANDLERS, type ActionResult } from '../automation-rule.service.js'
import { aggregateOrdersDayparting, type DaypartProfile } from './orders-dayparting.service.js'

// Shopper-local timezone per market (dayparting windows are enforced in this TZ).
const MARKET_TZ: Record<string, string> = { IT: 'Europe/Rome', DE: 'Europe/Berlin', FR: 'Europe/Paris', ES: 'Europe/Madrid', NL: 'Europe/Amsterdam', BE: 'Europe/Brussels', SE: 'Europe/Stockholm', PL: 'Europe/Warsaw', IE: 'Europe/Dublin', UK: 'Europe/London' }

export interface ProductFamily {
  marketplace?: string
  parentProductId: string | null
  parentName: string | null
  productIds: string[]
  asins: string[]
  skus: string[] // RD.10g — the family's SKUs; the RELIABLE order-match key (sales are SKU-keyed, OrderItem.productId is often null)
  campaigns: Array<{ id: string; name: string; status: string; marketplace: string | null }>
}

// Resolve a campaign (or a known parent) to its PARENT product family + the
// family's campaigns in this market. ASIN-centric: AdProductAd.productId is often
// null on prod, so we resolve products by Product.amazonAsin.
export async function resolveProductFamily(opts: { campaignId?: string; parentProductId?: string; marketplace?: string }): Promise<ProductFamily> {
  let parentProductId = opts.parentProductId ?? null
  let marketplace = opts.marketplace
  const empty: ProductFamily = { marketplace, parentProductId: null, parentName: null, productIds: [], asins: [], skus: [], campaigns: [] }

  if (!parentProductId) {
    if (!opts.campaignId) return empty
    const camp = await prisma.campaign.findUnique({ where: { id: opts.campaignId }, select: { marketplace: true } })
    if (!camp) return empty
    marketplace = marketplace || camp.marketplace || undefined
    const myAds = await prisma.adProductAd.findMany({ where: { adGroup: { campaignId: opts.campaignId } }, select: { asin: true, productId: true } })
    const myAsins = [...new Set(myAds.map((a) => a.asin).filter((x): x is string => !!x))]
    const directIds = [...new Set(myAds.map((a) => a.productId).filter((x): x is string => !!x))]
    if (myAsins.length === 0 && directIds.length === 0) return { ...empty, marketplace }
    const seed = await prisma.product.findMany({
      where: { OR: [...(myAsins.length ? [{ amazonAsin: { in: myAsins } }] : []), ...(directIds.length ? [{ id: { in: directIds } }] : [])] },
      select: { id: true, parentId: true },
    })
    if (seed.length === 0) return { ...empty, marketplace }
    const parentCount = new Map<string, number>()
    for (const p of seed) { const par = p.parentId ?? p.id; parentCount.set(par, (parentCount.get(par) ?? 0) + 1) }
    parentProductId = [...parentCount.entries()].sort((a, b) => b[1] - a[1])[0][0]
  }

  const family = await prisma.product.findMany({ where: { OR: [{ id: parentProductId }, { parentId: parentProductId }] }, select: { id: true, name: true, amazonAsin: true, sku: true } })
  if (family.length === 0) return { ...empty, marketplace }
  const familyIds = family.map((f) => f.id)
  const familyAsins = [...new Set(family.map((f) => f.amazonAsin).filter((x): x is string => !!x))]
  const familySkus = [...new Set(family.map((f) => f.sku).filter((x): x is string => !!x))]
  const parent = family.find((f) => f.id === parentProductId) ?? family[0]
  const famAds = familyAsins.length ? await prisma.adProductAd.findMany({
    where: { asin: { in: familyAsins }, ...(marketplace ? { adGroup: { campaign: { marketplace } } } : {}) },
    select: { adGroup: { select: { campaign: { select: { id: true, name: true, status: true, marketplace: true } } } } },
  }) : []
  const campMap = new Map<string, { id: string; name: string; status: string; marketplace: string | null }>()
  for (const a of famAds) { const c = a.adGroup?.campaign; if (c && (!marketplace || c.marketplace === marketplace)) campMap.set(c.id, c) }
  return {
    marketplace,
    parentProductId,
    parentName: parent?.name ?? null,
    productIds: familyIds,
    asins: familyAsins,
    skus: familySkus,
    campaigns: [...campMap.values()].sort((a, b) => (a.status === b.status ? 0 : a.status === 'ENABLED' ? -1 : 1)),
  }
}

export async function familyDemand(productIds: string[], marketplace?: string, windowDays = 90) {
  return aggregateOrdersDayparting({ channel: 'AMAZON', marketplace, productIds, windowDays, metric: 'revenue' })
}

// ── RC2.DD1 — accurate per-day×hour demand via market-prior shrinkage ──────
// A single product's day×hour grid is too sparse to trust (most cells empty), so
// we shrink its per-cell share toward the robust market-wide pattern, weighted by
// the family's own order count in each cell (K = prior pseudo-orders). Empty cells
// fall back to the market shape; cells with real family volume keep their signal.
export type Confidence = 'high' | 'med' | 'low'
export interface BlendedCell { orders: number; units: number; revenueCents: number; familyOrders: number; confidence: Confidence }
export interface BlendProfile { key: number; orders: number; units: number; revenueCents: number; index: number | null }
export interface RawDemand { grid: Array<Array<{ orders: number; units: number; revenueCents: number }>>; hourProfile: BlendProfile[]; weekdayProfile: BlendProfile[]; totals: { orders: number; units: number; revenueCents: number } }
export interface BlendedDemand {
  totals: { orders: number; units: number; revenueCents: number }
  grid: BlendedCell[][]
  hourProfile: BlendProfile[]
  weekdayProfile: BlendProfile[]
  hasData: boolean
  familyOrders: number
  blended: boolean
  // RD.10f — the RAW family demand (un-blended, actual orders/revenue per cell), so
  // the UI can show the product's TRUE data by default and offer smoothing as a toggle.
  raw: RawDemand
}

const SHRINK_K = 2 // a cell needs ~2+ family orders before it outweighs the market shape

// RC2.DD6 — pure per-cell shrinkage (regression-tested): blend the family's cell
// share toward the market share, weighted by the family's order count in the cell.
// 0 family orders → market share; many orders → the family's own share dominates.
export function shrinkShare(fShare: number, mShare: number, familyOrders: number, blended: boolean, k = SHRINK_K): number {
  return blended ? (familyOrders * fShare + k * mShare) / (familyOrders + k) : fShare
}

export async function blendedFamilyDemand(productIds: string[], marketplace: string | undefined, windowDays = 180, range?: { from?: Date; to?: Date }, skus?: string[]): Promise<BlendedDemand> {
  // RD.3 — optional explicit date range (from/to win over windowDays in
  // aggregateOrdersDayparting); both the family and the market prior use the same
  // window so the shrinkage stays apples-to-apples.
  // RD.10g — match the family by productId OR sku (the reliable, SKU-keyed sales path).
  const fam = await aggregateOrdersDayparting({ channel: 'AMAZON', marketplace, productIds, skus, windowDays, metric: 'revenue', from: range?.from, to: range?.to })
  const mkt = await aggregateOrdersDayparting({ channel: 'AMAZON', marketplace, windowDays, metric: 'revenue', from: range?.from, to: range?.to })
  const fTotRev = fam.totals.revenueCents, fTotOrders = fam.totals.orders, fTotUnits = fam.totals.units
  const mTotRev = mkt.totals.revenueCents
  const blended = mTotRev > 0 && fTotOrders > 0

  const rawShare: number[][] = []
  let shareSum = 0
  for (let d = 0; d < 7; d++) {
    rawShare[d] = []
    for (let h = 0; h < 24; h++) {
      const fShare = fTotRev > 0 ? (fam.grid[d]?.[h]?.revenueCents ?? 0) / fTotRev : 0
      const mShare = mTotRev > 0 ? (mkt.grid[d]?.[h]?.revenueCents ?? 0) / mTotRev : 0
      const w = fam.grid[d]?.[h]?.orders ?? 0
      const bShare = shrinkShare(fShare, mShare, w, blended)
      rawShare[d][h] = bShare; shareSum += bShare
    }
  }
  const grid: BlendedCell[][] = []
  for (let d = 0; d < 7; d++) {
    grid[d] = []
    for (let h = 0; h < 24; h++) {
      const share = shareSum > 0 ? rawShare[d][h] / shareSum : 0
      const fo = fam.grid[d]?.[h]?.orders ?? 0
      grid[d][h] = { revenueCents: Math.round(share * fTotRev), orders: Math.round(share * fTotOrders), units: Math.round(share * fTotUnits), familyOrders: fo, confidence: fo >= 5 ? 'high' : fo >= 2 ? 'med' : 'low' }
    }
  }
  const hourProfile: BlendProfile[] = Array.from({ length: 24 }, (_, h) => {
    let o = 0, u = 0, r = 0
    for (let d = 0; d < 7; d++) { o += grid[d][h].orders; u += grid[d][h].units; r += grid[d][h].revenueCents }
    return { key: h, orders: o, units: u, revenueCents: r, index: null }
  })
  const weekdayProfile: BlendProfile[] = Array.from({ length: 7 }, (_, d) => {
    let o = 0, u = 0, r = 0
    for (let h = 0; h < 24; h++) { o += grid[d][h].orders; u += grid[d][h].units; r += grid[d][h].revenueCents }
    return { key: d, orders: o, units: u, revenueCents: r, index: null }
  })
  const hMean = hourProfile.reduce((s, x) => s + x.revenueCents, 0) / 24
  for (const x of hourProfile) x.index = hMean > 0 ? x.revenueCents / hMean : null
  const wMean = weekdayProfile.reduce((s, x) => s + x.revenueCents, 0) / 7
  for (const x of weekdayProfile) x.index = wMean > 0 ? x.revenueCents / wMean : null
  return { totals: fam.totals, grid, hourProfile, weekdayProfile, hasData: fTotOrders > 0, familyOrders: fTotOrders, blended, raw: { grid: fam.grid, hourProfile: fam.hourProfile, weekdayProfile: fam.weekdayProfile, totals: fam.totals } }
}

interface GenParams { bidUpPct?: number; bidDownPct?: number; pauseOvernight?: boolean }
export interface DaypartWindow { days: number[]; startHour: number; endHour: number; bidMultiplierPct?: number }

// Demand → AdSchedule.windows. Mirrors the cockpit's preview generator exactly:
// bid-up high-demand days, bid-down low-demand, keep average, pause the dead
// overnight (hours under 5% of peak revenue). Weekday key = 0=Sun..6=Sat (cron-aligned).
export function generateDaypartingWindows(weekdayProfile: DaypartProfile[], hourProfile: DaypartProfile[], params: GenParams = {}): DaypartWindow[] {
  const bidUpPct = params.bidUpPct ?? 25
  const bidDownPct = params.bidDownPct ?? 40
  const pauseOvernight = params.pauseOvernight ?? true
  const peak = weekdayProfile.filter((w) => w.index != null && w.index >= 1.2).map((w) => w.key)
  const weak = weekdayProfile.filter((w) => w.index != null && w.index < 0.6).map((w) => w.key)
  const keep = weekdayProfile.filter((w) => !(w.index != null && (w.index >= 1.2 || w.index < 0.6))).map((w) => w.key)
  let activeStart = 0, activeEnd = 24
  if (pauseOvernight && hourProfile.length) {
    const max = Math.max(1, ...hourProfile.map((h) => h.revenueCents))
    const thr = max * 0.05
    const live = hourProfile.filter((h) => h.revenueCents >= thr).map((h) => h.key)
    if (live.length && live.length < 24) { activeStart = Math.min(...live); activeEnd = Math.max(...live) + 1 }
  }
  const windows: DaypartWindow[] = []
  if (peak.length) windows.push({ days: peak, startHour: activeStart, endHour: activeEnd, bidMultiplierPct: bidUpPct })
  if (weak.length) windows.push({ days: weak, startHour: activeStart, endHour: activeEnd, bidMultiplierPct: -bidDownPct })
  if (keep.length) windows.push({ days: keep, startHour: activeStart, endHour: activeEnd })
  return windows
}

// ── RD.3 — fused dayparting → RANK windows ─────────────────────────────────
// Turn a family's by-hour demand into a recommended rank PLAN: the hours the
// family actually sells get the "push" target (default own-top); everything else
// falls to the baseline (rest-of-search). This is the dayparting↔rank fusion the
// operator one-clicks before tuning. Weekday key 0=Sun..6=Sat (cron-aligned).
export interface RankWindow { days: number[]; startHour: number; endHour: number; targetKey: string }
export function recommendRankWindows(
  weekdayProfile: BlendProfile[],
  hourProfile: BlendProfile[],
  opts: { peakTargetKey?: string; baselineTargetKey?: string } = {},
): { windows: RankWindow[]; baselineTargetKey: string; peakHours: number[]; peakDays: number[] } {
  const peakTargetKey = opts.peakTargetKey ?? 'own-top'
  const baselineTargetKey = opts.baselineTargetKey ?? 'rest-of-search'
  const peakDays = weekdayProfile.filter((w) => w.index != null && w.index >= 1.2).map((w) => w.key)
  // No strong weekday signal (flat week) → push every day during peak hours.
  const days = peakDays.length ? peakDays : [0, 1, 2, 3, 4, 5, 6]
  const peakHours = hourProfile.filter((h) => h.index != null && h.index >= 1.2).map((h) => h.key)
  const windows: RankWindow[] = []
  if (peakHours.length) {
    windows.push({ days, startHour: Math.min(...peakHours), endHour: Math.max(...peakHours) + 1, targetKey: peakTargetKey })
  }
  return { windows, baselineTargetKey, peakHours, peakDays }
}

export interface RefreshResult { parentName: string | null; marketplace: string | null; campaigns: number; updated: number; created: number; windows: number; dryRun: boolean }

// Re-derive a family's windows from fresh demand and update its AdSchedules
// (update existing, preserving enabled; create disabled for newly-covered
// campaigns). The autonomous loop behind the `refresh_dayparting` rule.
export async function refreshFamilySchedules(opts: { campaignId?: string; parentProductId?: string; marketplace?: string } & GenParams & { windowDays?: number; dryRun?: boolean }): Promise<RefreshResult> {
  const fam = await resolveProductFamily({ campaignId: opts.campaignId, parentProductId: opts.parentProductId, marketplace: opts.marketplace })
  const base: RefreshResult = { parentName: fam.parentName, marketplace: fam.marketplace ?? null, campaigns: fam.campaigns.length, updated: 0, created: 0, windows: 0, dryRun: !!opts.dryRun }
  if (!fam.parentProductId || fam.campaigns.length === 0) return base
  const demand = await blendedFamilyDemand(fam.productIds, fam.marketplace, opts.windowDays ?? 180, undefined, fam.skus)
  const windows = generateDaypartingWindows(demand.weekdayProfile, demand.hourProfile, { bidUpPct: opts.bidUpPct, bidDownPct: opts.bidDownPct, pauseOvernight: opts.pauseOvernight })
  if (opts.dryRun) return { ...base, windows: windows.length }
  const timezone = MARKET_TZ[fam.marketplace ?? ''] ?? 'Europe/Rome'
  const existing = await prisma.adSchedule.findMany({ where: { campaignId: { in: fam.campaigns.map((c) => c.id) } }, select: { id: true, campaignId: true } })
  const byCampaign = new Map(existing.map((s) => [s.campaignId, s.id]))
  let updated = 0, created = 0
  for (const c of fam.campaigns) {
    const sid = byCampaign.get(c.id)
    if (sid) { await prisma.adSchedule.update({ where: { id: sid }, data: { windows: windows as never, timezone } }); updated++ }
    else { await prisma.adSchedule.create({ data: { campaignId: c.id, name: `Dayparting — ${fam.parentName ?? 'product'} (${fam.marketplace ?? ''})`, windows: windows as never, timezone, enabled: false } }); created++ }
  }
  logger.info('[T6] refreshFamilySchedules', { parent: fam.parentName, marketplace: fam.marketplace, campaigns: fam.campaigns.length, updated, created, windows: windows.length })
  return { ...base, updated, created, windows: windows.length }
}

// Rule action — re-derive + update the family schedules. Dry-run honored.
ACTION_HANDLERS.refresh_dayparting = async (action, _context, meta): Promise<ActionResult> => {
  const r = await refreshFamilySchedules({
    campaignId: typeof action.campaignId === 'string' ? action.campaignId : undefined,
    parentProductId: typeof action.parentProductId === 'string' ? action.parentProductId : undefined,
    marketplace: typeof action.marketplace === 'string' ? action.marketplace : undefined,
    bidUpPct: typeof action.bidUpPct === 'number' ? action.bidUpPct : undefined,
    bidDownPct: typeof action.bidDownPct === 'number' ? action.bidDownPct : undefined,
    pauseOvernight: typeof action.pauseOvernight === 'boolean' ? action.pauseOvernight : undefined,
    dryRun: meta.dryRun,
  })
  return { type: action.type, ok: true, output: r }
}

logger.debug('[T6] refresh_dayparting handler registered')
