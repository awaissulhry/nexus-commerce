import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * Portfolios P1 — sync Amazon Ads portfolios into the DB + a read model enriched with
 * campaign counts and spend/sales rolled up from our own Campaign rows.
 *
 * Why this exists: the GET /advertising/portfolios picker fetches Amazon per-request,
 * name-only, and persists nothing — so the cockpit could never SHOW portfolios with their
 * campaign membership or spend. This service:
 *   1. syncPortfolios()      — pull listPortfolios per active connection, upsert AmazonAdsPortfolio
 *                              (name/state/lastSyncedAt). Idempotent; keyed (profileId, externalPortfolioId).
 *   2. getPortfolioOverview() — read the synced rows + roll up campaign counts by portfolioId
 *                              (= externalPortfolioId), attach marketplaces, and sum spend/sales from
 *                              the daily reports for the picked window (AM-6), computing ACoS.
 *
 * Budgets (Decimal columns on the model) are intentionally NOT synced here — that needs the
 * Amazon v3 portfolios API and lands in P3. P1 delivers see + counts + spend.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { resolveRange } from '../ads-core/date-range.js'
import { campaignWindowMoney } from './ads-campaign-window.js'
import { adsMode, createPortfolio as createAmazonPortfolio, listPortfolios, listCampaignsV3, updatePortfolio, type AdsRegion, type AdsPortfolioDTO, type PortfolioBudgetInput } from './ads-api-client.js'

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
    where: { profileId_externalPortfolioId: workspaceKey({ profileId, externalPortfolioId: pf.portfolioId }) },
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
    // AX-VT.3 — record before converging, when convergence would DESTROY a local value.
    //
    // The docstring above is right that Amazon owns membership, and this still converges to
    // it. What it got wrong is the word "not destructive": that holds only while our writes
    // actually reach Amazon. They did not — the create path never sent portfolioId at all —
    // so this sweep quietly emptied the portfolio in Nexus too, and the operator who
    // reported "my campaigns aren't in the portfolio on Amazon" could no longer show that
    // Nexus had ever disagreed. The bug erased its own evidence.
    //
    // So: when Amazon reports no portfolio for a campaign we hold one for, open a drift row
    // first. Convergence is unchanged; it is simply no longer silent. Best-effort — drift
    // bookkeeping must never break the sync it rides on.
    if (pid === null) {
      try { await recordMembershipLoss(ids) }
      catch (e) { logger.warn('[ADS-PORTFOLIO-SYNC] membership-loss drift record failed', { error: (e as Error).message.slice(0, 140) }) }
    }
    const res = await prisma.campaign.updateMany({ where: { externalCampaignId: { in: ids } }, data: { portfolioId: pid } })
    if (pid) linked += res.count
  }
  return linked
}

/**
 * AX-VT.3 — open a drift row for every campaign about to lose a local portfolio.
 *
 * Classified through the same `classifyDrift` the settings sync uses, so a membership loss
 * reads consistently with every other drift: WRITE_FAILED if our last write failed,
 * WRITE_LAG if we wrote moments ago, EXTERNAL_CHANGE if somebody unassigned it in Seller
 * Central. Keyed (entityType, entityId, field) like all drift, so a campaign wrong for three
 * days is one row with a high occurrence count, not one row per sync.
 */
async function recordMembershipLoss(externalCampaignIds: string[]): Promise<void> {
  const losing = await prisma.campaign.findMany({
    where: { externalCampaignId: { in: externalCampaignIds }, portfolioId: { not: null } },
    select: { id: true, name: true, marketplace: true, portfolioId: true, externalCampaignId: true, lastSyncedAt: true, lastSyncStatus: true },
  })
  if (!losing.length) return
  const { classifyDrift } = await import('../ads-core/drift.js')
  const now = new Date()
  for (const c of losing) {
    const classification = classifyDrift({
      ours: c.portfolioId, theirs: null,
      lastWriteAt: c.lastSyncedAt, lastWriteStatus: c.lastSyncStatus, now,
    })
    await prisma.adDrift.upsert({
      where: { entityType_entityId_field: workspaceKey({ entityType: 'CAMPAIGN', entityId: c.id, field: 'portfolioId' }) },
      create: {
        entityType: 'CAMPAIGN', entityId: c.id, externalId: c.externalCampaignId,
        marketplace: c.marketplace, entityName: c.name,
        field: 'portfolioId', ourValue: c.portfolioId, amazonValue: null, classification,
      },
      update: { ourValue: c.portfolioId, amazonValue: null, classification, lastDetectedAt: now, occurrences: { increment: 1 }, resolvedAt: null },
    })
  }
  logger.warn('[AX-VT.3] campaigns losing local portfolio membership to Amazon', {
    count: losing.length, campaigns: losing.slice(0, 10).map((c) => c.name),
  })
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

/**
 * AM-35 — the campaigns a portfolio row COUNTS, and whose spend it sums: the Ad Manager's default
 * status filter (Enabled + Paused; Archived hidden until opted in). The Dashboard's campaign count
 * uses the same two states. Archived members are reported separately, never silently dropped.
 */
export const PORTFOLIO_COUNTED_STATUSES = ['ENABLED', 'PAUSED'] as const

export interface PortfolioOverview {
  portfolioId: string // externalPortfolioId
  name: string
  state: string | null
  marketplaces: string[]
  /** Enabled + paused member campaigns (`PORTFOLIO_COUNTED_STATUSES`). */
  campaignCount: number
  /** Enabled member campaigns. */
  activeCampaignCount: number
  /** Archived member campaigns — NOT in `campaignCount`, spend or sales. */
  archivedCampaignCount: number
  /** CENTS, summed from the daily reports over `range` for the counted campaigns (AM-6). */
  spendCents: number
  /** CENTS, ad-attributed sales over `range` for the counted campaigns. */
  salesCents: number
  acos: number | null // FRACTION (spend / sales, 0.38 = 38 %); null when nothing sold
  // P3 — budget cap (read from Amazon v3; null policy/amount = no cap)
  budgetAmountCents: number | null
  budgetCurrencyCode: string | null
  budgetPolicy: string | null // NO_CAP | MONTHLY_RECURRING | DATE_RANGE
  inBudget: boolean | null
  source: 'amazon' | 'local'
  lastSyncedAt: string | null
}

/** The window the overview's money covers, as the page prints it. */
export interface PortfolioOverviewRange { startDate: string; endDate: string; preset: string; includesToday: boolean }

/**
 * Synced portfolio rows enriched with campaign membership + spend/sales for a date window.
 *
 * 🔴 AM-6 — spend and sales used to be the stored `Campaign.spend/sales`: an unlabelled ~30-day
 * window, refreshed nightly, and never reset for a campaign that went idle (the nightly heal only
 * visits campaigns with rows in its window), so a campaign idle for a month kept its last figure
 * forever. They are now summed from `AmazonAdsDailyPerformance` with the Ad Manager list's own
 * buckets (`campaignWindowMoney`) for the window the page picked — same params as
 * `GET /advertising/campaigns` (`startDate`/`endDate`, or `preset`, or `windowDays`; default the
 * last 7 days, as the Ad Manager opens) — and the window is returned so the page can print it.
 */
export async function getPortfolioOverview(opts: {
  marketplace?: string | null
  preset?: string
  startDate?: string
  endDate?: string
  windowDays?: string
} = {}): Promise<{ portfolios: PortfolioOverview[]; lastSyncedAt: string | null; range: PortfolioOverviewRange; countedStatuses: string[] }> {
  const mk = opts.marketplace && opts.marketplace !== 'all' ? opts.marketplace : null
  const range = resolveRange({ preset: opts.preset, startDate: opts.startDate, endDate: opts.endDate, windowDays: opts.windowDays })

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
    select: { id: true, externalCampaignId: true, portfolioId: true, marketplace: true, status: true },
  })
  const counted = new Set<string>(PORTFOLIO_COUNTED_STATUSES)
  const money = await campaignWindowMoney(camps.filter((c) => counted.has(c.status)), { gte: range.since, lte: range.until })
  const roll = new Map<string, { count: number; active: number; archived: number; spendCents: number; salesCents: number; markets: Set<string> }>()
  for (const c of camps) {
    const k = c.portfolioId as string
    const r = roll.get(k) ?? { count: 0, active: 0, archived: 0, spendCents: 0, salesCents: 0, markets: new Set<string>() }
    if (c.marketplace) r.markets.add(c.marketplace)
    if (c.status === 'ARCHIVED') r.archived++
    if (counted.has(c.status)) {
      r.count++
      if (c.status === 'ENABLED') r.active++
      const m = money.get(c.id)
      r.spendCents += m?.spendCents ?? 0
      r.salesCents += m?.salesCents ?? 0
    }
    roll.set(k, r)
  }

  let last: number | null = null
  const portfolios: PortfolioOverview[] = rows.map((p) => {
    const r = roll.get(p.externalPortfolioId)
    const spendCents = r?.spendCents ?? 0
    const salesCents = r?.salesCents ?? 0
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
      archivedCampaignCount: r?.archived ?? 0,
      spendCents,
      salesCents,
      acos: salesCents > 0 ? spendCents / salesCents : null,
      budgetAmountCents: p.budgetAmount != null ? Math.round(Number(p.budgetAmount) * 100) : null,
      budgetCurrencyCode: p.budgetCurrencyCode ?? null,
      budgetPolicy: p.budgetPolicy ?? null,
      inBudget: p.inBudget ?? null,
      source: p.externalPortfolioId.startsWith('local-pf-') ? 'local' : 'amazon',
      lastSyncedAt: p.lastSyncedAt ? p.lastSyncedAt.toISOString() : null,
    }
  })
  return {
    portfolios,
    lastSyncedAt: last != null ? new Date(last).toISOString() : null,
    range: { startDate: range.sinceStr, endDate: range.untilStr, preset: range.preset, includesToday: range.includesToday },
    countedStatuses: [...PORTFOLIO_COUNTED_STATUSES],
  }
}

const POLICY_TO_DB: Record<string, string> = { monthlyRecurring: 'MONTHLY_RECURRING', dateRange: 'DATE_RANGE' }

/** What PATCH /advertising/portfolios/:id may ask: a rename, a state, a budget cap (the Portfolios page's three actions). */
export interface PortfolioUpdateBody {
  name?: string
  state?: 'enabled' | 'paused' | 'archived'
  budget?: { amount?: number; currencyCode?: string; policy?: 'monthlyRecurring' | 'dateRange'; startDate?: string; endDate?: string }
}

/**
 * W4-3 — the portfolio update's body check, the one place it is done (moved here from PATCH /advertising/portfolios/:id,
 * answers unchanged; set-portfolio uses it too): a name is trimmed (blank = none); a cap needs an amount above 0 and a
 * policy (monthlyRecurring or dateRange), a dateRange both dates; the currency defaults to EUR; at least one of the three.
 */
export function portfolioUpdateOf(body: PortfolioUpdateBody): { ok: true; value: { name?: string; state?: PortfolioUpdateBody['state']; budget?: PortfolioBudgetInput } } | { ok: false; error: string } {
  const name = body.name?.trim() || undefined
  let budget: PortfolioBudgetInput | undefined
  if (body.budget) {
    const b = body.budget
    if (!(typeof b.amount === 'number' && b.amount > 0) || (b.policy !== 'monthlyRecurring' && b.policy !== 'dateRange')) {
      return { ok: false, error: 'budget requires amount > 0 and policy monthlyRecurring|dateRange' }
    }
    if (b.policy === 'dateRange' && (!b.startDate || !b.endDate)) return { ok: false, error: 'dateRange budget requires startDate + endDate' }
    budget = { amount: b.amount, currencyCode: b.currencyCode || 'EUR', policy: b.policy, startDate: b.startDate, endDate: b.endDate }
  }
  if (name == null && body.state == null && !budget) return { ok: false, error: 'name, state or budget required' }
  return { ok: true, value: { name, state: body.state, budget } }
}

/** P2/P3 — rename / archive / set budget on a portfolio. Pushes to Amazon when the write gate is
 *  open (v3 PUT /portfolios), then mirrors the change locally. Keyed by externalPortfolioId.
 *  A budget cap can throttle delivery (it's the one field with spend impact) — hence gated. */
export async function updatePortfolioById(args: { portfolioId: string; name?: string; state?: 'enabled' | 'paused' | 'archived'; budget?: PortfolioBudgetInput }): Promise<{ ok: boolean; mode: string; error?: string }> {
  const row = await prisma.amazonAdsPortfolio.findFirst({ where: { externalPortfolioId: args.portfolioId } })
  if (!row) return { ok: false, mode: 'local', error: 'portfolio not found' }
  let mode = 'local'
  const conn = await prisma.amazonAdsConnection.findFirst({ where: { profileId: row.profileId, isActive: true }, select: { region: true, marketplace: true } })
  if (conn && !row.externalPortfolioId.startsWith('local-pf-')) {
    const { checkAdsWriteGate } = await import('./ads-write-gate.js')
    // The budget amount is the write's blast-radius value for the gate's value cap.
    const payloadValueCents = args.budget ? Math.round(args.budget.amount * 100) : 0
    const gate = await checkAdsWriteGate({ marketplace: conn.marketplace, payloadValueCents })
    if (gate.allowed) {
      const r = await updatePortfolio({ profileId: row.profileId, region: regionOf(conn.region) }, { portfolioId: args.portfolioId, name: args.name, state: args.state, budget: args.budget })
      mode = r.mode
      // 1a (CM-23) — Amazon refused it: nothing changes in Nexus, and the caller gets Amazon's reason.
      if (!r.ok) return { ok: false, mode, error: r.error ?? 'Amazon refused the portfolio change' }
    } else if (args.budget) {
      // Budget caps are spend-affecting — never record a cap we couldn't actually push to Amazon.
      return { ok: false, mode: 'gated', error: (gate as { reason?: string }).reason || 'write gate closed' }
    }
    // name/state are harmless metadata — they still mirror locally even if the gate is closed.
  }
  await prisma.amazonAdsPortfolio.update({
    where: { id: row.id },
    data: {
      ...(args.name != null ? { name: args.name } : {}),
      ...(args.state != null ? { state: args.state.toUpperCase() } : {}),
      ...(args.budget ? {
        budgetAmount: args.budget.amount,
        budgetCurrencyCode: args.budget.currencyCode,
        budgetPolicy: POLICY_TO_DB[args.budget.policy] ?? args.budget.policy,
        startDate: args.budget.startDate ? new Date(args.budget.startDate) : null,
        endDate: args.budget.endDate ? new Date(args.budget.endDate) : null,
      } : {}),
    },
  })
  return { ok: true, mode }
}

/**
 * PA.2 — create a portfolio, the one place it is done (ADS PLAYBOOK PB-4 moved it here from POST /advertising/portfolios,
 * behaviour unchanged; a playbook build reuses it). Gated-local: the portfolio is made at Amazon only when the write gate
 * for its market is open, in the profile the gate approves (CM-29: the gate's own resolver), and is stored as an
 * AmazonAdsPortfolio row either way — a local id (`local-pf-…`) when Amazon was not reached. A portfolio belongs to one
 * market's profile (CC-5).
 */
export async function createPortfolio(input: { name: string; marketplace: string }): Promise<{ portfolio: { portfolioId: string; name: string }; mode: string }> {
  const { name, marketplace } = input
  let externalId: string | null = null, mode = 'local', profileId = `local-${marketplace}`
  const { adsClientContextFor } = await import('./ads-profile-resolver.js')
  const conn = await adsClientContextFor(marketplace)
  if (conn) {
    profileId = conn.profileId
    const region: AdsRegion = conn.region
    const { checkAdsWriteGate } = await import('./ads-write-gate.js')
    const gate = await checkAdsWriteGate({ marketplace, payloadValueCents: 0 })
    if (gate.allowed) { const r = await createAmazonPortfolio({ profileId, region }, { name, state: 'enabled' }); externalId = r.externalId; mode = r.mode }
  }
  if (!externalId) externalId = `local-pf-${profileId}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`
  const pf = await prisma.amazonAdsPortfolio.upsert({
    where: { profileId_externalPortfolioId: workspaceKey({ profileId, externalPortfolioId: externalId }) },
    update: { name }, create: { profileId, externalPortfolioId: externalId, name, state: 'ENABLED' },
  })
  logger.warn('[ADS-PORTFOLIOS] created portfolio', { externalId, name, mode })
  return { portfolio: { portfolioId: pf.externalPortfolioId, name: pf.name }, mode }
}
