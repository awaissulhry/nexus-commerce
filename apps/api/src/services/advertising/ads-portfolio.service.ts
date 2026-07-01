/**
 * Portfolios P1 — sync Amazon Ads portfolios into the DB + a read model enriched with
 * campaign counts and spend/sales rolled up from our own Campaign rows.
 *
 * Why this exists: the GET /advertising/portfolios picker fetches Amazon per-request,
 * name-only, and persists nothing — so the cockpit could never SHOW portfolios with their
 * campaign membership or spend. This service:
 *   1. syncPortfolios()      — pull listPortfolios per active connection, upsert AmazonAdsPortfolio
 *                              (name/state/lastSyncedAt). Idempotent; keyed (profileId, externalPortfolioId).
 *   2. getPortfolioOverview() — read the synced rows + roll up Campaign.{count,spend,sales} by
 *                              portfolioId (= externalPortfolioId), attach marketplaces, compute ACoS.
 *
 * Budgets (Decimal columns on the model) are intentionally NOT synced here — that needs the
 * Amazon v3 portfolios API and lands in P3. P1 delivers see + counts + spend.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { adsMode, listPortfolios, listCampaignsV3, type AdsRegion, type AdsPortfolioDTO } from './ads-api-client.js'

const regionOf = (r: string | null): AdsRegion => (r === 'NA' || r === 'FE' ? r : 'EU')

async function upsertSynced(profileId: string, pf: AdsPortfolioDTO): Promise<void> {
  const state = pf.state ? pf.state.toUpperCase() : null
  // v3 returns the budget object; persist it (read-only display). Budget WRITES land in P3.
  const budget = {
    budgetAmount: pf.budgetAmount ?? null,
    budgetCurrencyCode: pf.budgetCurrencyCode ?? null,
    budgetPolicy: pf.budgetPolicy ? pf.budgetPolicy.toUpperCase() : null,
    startDate: pf.startDate ? new Date(pf.startDate) : null,
    endDate: pf.endDate ? new Date(pf.endDate) : null,
    inBudget: pf.inBudget ?? true,
  }
  await prisma.amazonAdsPortfolio.upsert({
    where: { profileId_externalPortfolioId: { profileId, externalPortfolioId: pf.portfolioId } },
    update: { name: pf.name, ...(state ? { state } : {}), ...budget, lastSyncedAt: new Date() },
    create: { profileId, externalPortfolioId: pf.portfolioId, name: pf.name, state, ...budget, lastSyncedAt: new Date() },
  })
}

export interface SyncResult {
  synced: number
  errors: number
  /** P2 — campaigns linked to a portfolio from Amazon's authoritative v3 membership. */
  campaignsLinked: number
  /** Per-connection failure detail so the page can show WHY a sync didn't return anything. */
  errorDetail: Array<{ marketplace: string | null; error: string }>
}

/**
 * P2 — pull Amazon's authoritative campaign→portfolio membership (v3 /sp/campaigns/list) and
 * write it onto local Campaign.portfolioId so the overview shows real counts + spend. Amazon is
 * source-of-truth here (assignments made via the campaign PATCH also push to Amazon), so setting
 * portfolioId=null for campaigns Amazon reports as unportfolio'd is correct, not destructive.
 * Grouped updateMany by portfolioId to keep round-trips low. Returns campaigns actually linked.
 */
async function linkCampaignMembership(profileId: string, region: AdsRegion): Promise<number> {
  const camps = await listCampaignsV3({ profileId, region })
  const byPid = new Map<string | null, string[]>()
  for (const cam of camps) {
    const pid = cam.portfolioId ?? null
    const arr = byPid.get(pid) ?? []
    arr.push(cam.campaignId)
    byPid.set(pid, arr)
  }
  let linked = 0
  for (const [pid, ids] of byPid) {
    if (!ids.length) continue
    const res = await prisma.campaign.updateMany({ where: { externalCampaignId: { in: ids } }, data: { portfolioId: pid } })
    if (pid) linked += res.count
  }
  return linked
}

/** Pull portfolios from Amazon for every active connection (or sandbox) and upsert them locally. */
export async function syncPortfolios(opts: { marketplace?: string | null } = {}): Promise<SyncResult> {
  const mk = opts.marketplace && opts.marketplace !== 'all' ? opts.marketplace : null
  let synced = 0
  let campaignsLinked = 0
  const errorDetail: SyncResult['errorDetail'] = []
  if (adsMode() === 'sandbox') {
    const list = await listPortfolios({ profileId: 'SANDBOX-PROFILE-IT-001', region: 'EU' })
    for (const pf of list) { await upsertSynced('SANDBOX-PROFILE-IT-001', pf); synced++ }
    return { synced, errors: 0, campaignsLinked, errorDetail }
  }
  const conns = await prisma.amazonAdsConnection.findMany({
    where: { isActive: true, ...(mk ? { marketplace: mk } : {}) },
    select: { profileId: true, region: true, marketplace: true },
  })
  for (const c of conns) {
    try {
      const list = await listPortfolios({ profileId: c.profileId, region: regionOf(c.region) })
      for (const pf of list) { await upsertSynced(c.profileId, pf); synced++ }
    } catch (e) {
      const error = (e as Error)?.message ?? String(e)
      errorDetail.push({ marketplace: c.marketplace, error })
      logger.warn('[ADS-PORTFOLIO-SYNC] connection fetch failed', { profileId: c.profileId, error })
    }
    // Campaign membership is a separate best-effort pass — a failure here must not
    // block the portfolio sync (or vice-versa).
    try {
      campaignsLinked += await linkCampaignMembership(c.profileId, regionOf(c.region))
    } catch (e) {
      logger.warn('[ADS-PORTFOLIO-SYNC] campaign link pass failed', { profileId: c.profileId, error: (e as Error)?.message })
    }
  }
  return { synced, errors: errorDetail.length, campaignsLinked, errorDetail }
}

export interface PortfolioOverview {
  portfolioId: string // externalPortfolioId
  name: string
  state: string | null
  marketplaces: string[]
  campaignCount: number
  activeCampaignCount: number
  spendCents: number
  salesCents: number
  acos: number | null // fraction (spend / sales)
  source: 'amazon' | 'local'
  lastSyncedAt: string | null
}

/** Synced portfolio rows enriched with campaign membership + spend/sales rollup. */
export async function getPortfolioOverview(opts: { marketplace?: string | null } = {}): Promise<{ portfolios: PortfolioOverview[]; lastSyncedAt: string | null }> {
  const mk = opts.marketplace && opts.marketplace !== 'all' ? opts.marketplace : null

  // profileId -> marketplace (so a portfolio with no campaigns still shows its market)
  const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { profileId: true, marketplace: true } })
  const profMarket = new Map(conns.map((c) => [c.profileId, c.marketplace]))
  const scopedProfileIds = mk ? conns.filter((c) => c.marketplace === mk).map((c) => c.profileId) : null

  const rows = await prisma.amazonAdsPortfolio.findMany({
    where: scopedProfileIds ? { profileId: { in: scopedProfileIds } } : {},
    orderBy: { name: 'asc' },
  })

  // Roll up campaigns by portfolioId (= externalPortfolioId). ~hundreds of rows → reduce in JS.
  const camps = await prisma.campaign.findMany({
    where: { portfolioId: { not: null }, ...(mk ? { marketplace: mk } : {}) },
    select: { portfolioId: true, marketplace: true, status: true, spend: true, sales: true },
  })
  const roll = new Map<string, { count: number; active: number; spend: number; sales: number; markets: Set<string> }>()
  for (const c of camps) {
    const k = c.portfolioId as string
    const r = roll.get(k) ?? { count: 0, active: 0, spend: 0, sales: 0, markets: new Set<string>() }
    r.count++
    if (c.status === 'ENABLED') r.active++
    r.spend += Number(c.spend)
    r.sales += Number(c.sales)
    if (c.marketplace) r.markets.add(c.marketplace)
    roll.set(k, r)
  }

  let last: number | null = null
  const portfolios: PortfolioOverview[] = rows.map((p) => {
    const r = roll.get(p.externalPortfolioId)
    const spendCents = Math.round((r?.spend ?? 0) * 100)
    const salesCents = Math.round((r?.sales ?? 0) * 100)
    const fromCampaigns = r && r.markets.size ? [...r.markets].sort() : null
    const fromConn = profMarket.get(p.profileId)
    if (p.lastSyncedAt) { const t = p.lastSyncedAt.getTime(); if (last == null || t > last) last = t }
    return {
      portfolioId: p.externalPortfolioId,
      name: p.name,
      state: p.state ?? null,
      marketplaces: fromCampaigns ?? (fromConn ? [fromConn] : []),
      campaignCount: r?.count ?? 0,
      activeCampaignCount: r?.active ?? 0,
      spendCents,
      salesCents,
      acos: salesCents > 0 ? spendCents / salesCents : null,
      source: p.externalPortfolioId.startsWith('local-pf-') ? 'local' : 'amazon',
      lastSyncedAt: p.lastSyncedAt ? p.lastSyncedAt.toISOString() : null,
    }
  })
  return { portfolios, lastSyncedAt: last != null ? new Date(last).toISOString() : null }
}
