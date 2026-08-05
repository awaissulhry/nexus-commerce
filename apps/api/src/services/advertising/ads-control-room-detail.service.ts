/**
 * ACR.1.2b / 1.3b — the two read models the Control Room's deferred surfaces need:
 * an engine's own history (the Levers row-expand drawer) and the per-campaign
 * guardrail grid (the Guardrails tab, which until now rendered only counts).
 *
 * Read-only, like `ads-control-room.service.ts` beside it. The one write path either
 * surface uses is an endpoint that already existed.
 *
 * ── The actor map is MEASURED, not guessed ──
 *
 * The drawer promises evidence samples per engine, and the only link between an engine
 * and the rows it produced is the actor string. `scripts/_acr12-engine-evidence.mts`
 * counted them on prod 2026-08-05 rather than reading them out of the code, because the
 * code contains actor strings that no longer appear in the data and the data contains
 * one the code does not obviously explain:
 *
 *   automation:rank-defend-<scheduleId>   17,183 action-log · 19,338 bid-history rows
 *   automation:budget-manager-cron           105
 *   automation:auto-harvest                   10  (last 2026-07-27)
 *   automation:auto-bid                        0  (runs, proposes nothing today)
 *   automation:tos-optimizer                   0  (its cron has never been armed)
 *   (null)                                 6,203  the legacy null-actor placement writes
 *
 * So an engine with zero rows is the NORMAL case here, not a bug, and the drawer has to
 * say which of the two it is looking at — "this engine writes no per-entity rows" and
 * "this engine wrote nothing in the window" are different facts, and a drawer that
 * rendered both as an empty list would be the same confident-blank this programme keeps
 * removing.
 */
import prisma from '../../db.js'
import { pinnedDimensions, type AuthorityDimension } from './ads-authority-pins.js'

const DAY = 86_400_000

/**
 * Engine key → how to find what it did.
 *
 * `actorPrefix` matches with a trailing wildcard (rank-defend carries a schedule id);
 * `actors` are exact. `writesEntities: false` marks the engines that legitimately produce
 * no per-entity rows — ingests, the drain, the breaker — so the drawer can say so instead
 * of showing an empty list that reads like a failure.
 */
interface EvidenceSource {
  actors?: string[]
  actorPrefix?: string
  writesEntities: boolean
  /** Said out loud in the drawer when there is nothing to show. */
  emptyNote: string
}

const EVIDENCE: Record<string, EvidenceSource> = {
  'rank-defend': {
    actorPrefix: 'automation:rank-defend-',
    writesEntities: true,
    emptyNote: 'No bid or placement writes in this window.',
  },
  dayparting: {
    actorPrefix: 'automation:dayparting-',
    writesEntities: true,
    emptyNote: 'Nothing evaluated — every live schedule is rank-goal mode, which this engine does not own.',
  },
  'budget-enforce': {
    actors: ['automation:budget-manager-cron'],
    writesEntities: true,
    emptyNote: 'No budget changes or suppressions in this window.',
  },
  'budget-pools': {
    actors: ['automation:budget-pool-rebalance'],
    writesEntities: true,
    emptyNote: 'No pools are configured, so there is nothing to rebalance.',
  },
  'auto-bid': {
    actors: ['automation:auto-bid'],
    writesEntities: true,
    emptyNote: 'Runs on schedule and has proposed nothing in this window.',
  },
  'auto-harvest': {
    actors: ['automation:auto-harvest'],
    writesEntities: true,
    emptyNote: 'No terms promoted or negated in this window.',
  },
  'tos-defense': {
    actors: ['automation:tos-optimizer'],
    writesEntities: true,
    emptyNote: 'Its cron has never been armed, so it has never written anything.',
  },
  'anomaly-guard': {
    writesEntities: false,
    emptyNote: 'The breaker halts the account; it never writes to an entity. Its record is the run history above.',
  },
  'write-delivery': {
    writesEntities: false,
    emptyNote: 'The drain carries other engines\' writes — the rows belong to whichever engine asked for them.',
  },
  'structural-reconcile': {
    writesEntities: false,
    emptyNote: 'Read-only by design: it records drift and never repairs a bid.',
  },
}

export interface EngineRun {
  id: string
  startedAt: Date
  finishedAt: Date | null
  status: string
  triggeredBy: string | null
  summary: string | null
  durationMs: number | null
}

export interface EngineEvidenceRow {
  id: string
  at: Date
  actionType: string
  entityType: string | null
  entityId: string | null
  campaignName: string | null
  status: string | null
  /** The structured evidence the ADX A2 column carries: metric, observed vs threshold. */
  evidence: unknown
  reason: string | null
}

export interface EngineDetail {
  key: string
  cron: string | null
  /** Whether the operator can fire it by hand, and the job name to fire. */
  run: { available: boolean; jobName: string | null; why: string | null }
  runs: EngineRun[]
  /** Run counts over 14 days — a longer lens than the Levers row's 7. */
  health: { runs14d: number; failures14d: number; manual14d: number }
  lastSummary: string | null
  evidence: EngineEvidenceRow[]
  evidenceNote: string | null
  writesEntities: boolean
}

/** Levers engine key → the CronRun jobName it reports under. Mirrors ads-control-room.service. */
const ENGINE_CRON: Record<string, string | null> = {
  'rank-defend': 'ad-rank-defend',
  dayparting: 'ad-dayparting',
  'budget-enforce': 'ad-budget-enforce',
  'budget-pools': 'budget-pool-rebalance',
  'auto-bid': 'ads-auto-bid',
  'auto-harvest': 'ads-auto-harvest',
  'anomaly-guard': 'ads-anomaly-guard',
  'tos-defense': 'top-of-search-defense',
  'write-delivery': 'drain-ads-sync',
  'structural-reconcile': 'ads-structural-reconcile',
}

export async function getEngineDetail(key: string, opts: { days?: number } = {}): Promise<EngineDetail | null> {
  const cron = ENGINE_CRON[key]
  if (cron === undefined) return null
  const days = Math.min(Math.max(opts.days ?? 14, 1), 60)
  const since = new Date(Date.now() - days * DAY)
  const src = EVIDENCE[key]

  /**
   * Whether "Run now" is offered is decided by the SAME registry the trigger route
   * validates against — not by a list kept here. A button that offers to fire a job the
   * route will answer 404 for is worse than no button, and a second list is how the two
   * drift apart.
   */
  // Imported lazily: `cron-registry` statically pulls in every job module in the platform,
  // and a read-only detail endpoint has no business dragging that graph in at module load.
  const { CRON_REGISTRY } = await import('../../jobs/cron-registry.js')
  const runnable = !!cron && Object.prototype.hasOwnProperty.call(CRON_REGISTRY, cron)

  const [runRows, grouped] = await Promise.all([
    cron
      ? prisma.cronRun.findMany({
        where: { jobName: cron },
        orderBy: { startedAt: 'desc' },
        take: 25,
        select: { id: true, startedAt: true, finishedAt: true, status: true, triggeredBy: true, outputSummary: true, errorMessage: true },
      })
      : Promise.resolve([]),
    cron
      ? prisma.cronRun.groupBy({
        by: ['status'],
        where: { jobName: cron, startedAt: { gte: since } },
        _count: { _all: true },
      })
      : Promise.resolve([] as Array<{ status: string; _count: { _all: number } }>),
  ])

  const manual14d = cron
    ? await prisma.cronRun.count({ where: { jobName: cron, startedAt: { gte: since }, triggeredBy: 'manual' } })
    : 0

  let runs14d = 0
  let failures14d = 0
  for (const g of grouped) {
    runs14d += g._count._all
    if (g.status === 'FAILED') failures14d += g._count._all
  }

  const runs: EngineRun[] = runRows.map((r) => ({
    id: r.id,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    status: r.status,
    triggeredBy: r.triggeredBy,
    // The error is as much "what happened" as the summary is. A FAILED run whose drawer
    // shows a blank output line is the failure being hidden a second time.
    summary: r.outputSummary ?? r.errorMessage ?? null,
    durationMs: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
  }))

  let evidence: EngineEvidenceRow[] = []
  let evidenceNote: string | null = null
  if (src?.writesEntities) {
    const actorWhere = src.actorPrefix
      ? { userId: { startsWith: src.actorPrefix } }
      : { userId: { in: src.actors ?? [] } }
    const rows = await prisma.advertisingActionLog.findMany({
      where: { ...actorWhere, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: {
        id: true, createdAt: true, actionType: true, entityType: true, entityId: true,
        amazonResponseStatus: true, evidence: true, payloadAfter: true,
      },
    })
    // Resolve campaign names in one query — an evidence sample that names a cuid is not
    // evidence anyone can read.
    const campaignIds = rows.filter((r) => r.entityType === 'CAMPAIGN' && r.entityId).map((r) => r.entityId as string)
    const names = campaignIds.length
      ? new Map((await prisma.campaign.findMany({
        where: { id: { in: campaignIds } }, select: { id: true, name: true },
      })).map((c) => [c.id, c.name]))
      : new Map<string, string>()
    evidence = rows.map((r) => ({
      id: r.id,
      at: r.createdAt,
      actionType: r.actionType,
      entityType: r.entityType,
      entityId: r.entityId,
      campaignName: r.entityId ? names.get(r.entityId) ?? null : null,
      status: r.amazonResponseStatus,
      evidence: r.evidence ?? null,
      reason: readReason(r.evidence) ?? readReason(r.payloadAfter),
    }))
    if (!evidence.length) evidenceNote = src.emptyNote
  } else {
    evidenceNote = src?.emptyNote ?? 'This engine writes no per-entity rows.'
  }

  return {
    key,
    cron: cron ?? null,
    run: {
      available: runnable,
      jobName: runnable ? cron : null,
      why: runnable ? null : 'No manual trigger is registered for this job.',
    },
    runs,
    health: { runs14d, failures14d, manual14d },
    lastSummary: runs[0]?.summary ?? null,
    evidence,
    evidenceNote,
    writesEntities: src?.writesEntities ?? false,
  }
}

/** Pull a human sentence out of the evidence/payload JSON without trusting its shape. */
function readReason(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  for (const k of ['note', 'reason', 'metric']) {
    const s = o[k]
    if (typeof s === 'string' && s.trim()) return s
  }
  return null
}

// ── ACR.1.3b — the per-campaign guardrail grid ──────────────────────────────────────

export interface GuardrailRow {
  id: string
  name: string
  marketplace: string | null
  status: string
  portfolioId: string | null
  portfolioName: string | null
  managed: boolean
  minBidCents: number | null
  maxBidCents: number | null
  dailyBudgetCents: number | null
  targetAcosPct: number | null
  cpcCeiling: { enabled: boolean; multiple: number } | null
  /** NP / ADX A3 — suppressed, and by which engine. null owner = suppressed before A3. */
  suppressedAt: Date | null
  suppressedBy: string | null
  suppressedFloorCents: number | null
  pins: { placement: boolean; bids: boolean; budget: boolean }
  pinnedDimensions: AuthorityDimension[]
  pinNote: string | null
  pinnedBy: string | null
  pinnedAt: Date | null
  /** Rules bound to THIS campaign (ACR.7 drag-to-scope). */
  boundRules: Array<{ id: string; name: string; level: string; enabled: boolean }>
}

export interface GuardrailGrid {
  rows: GuardrailRow[]
  /**
   * Rules that govern every campaign because nothing narrows them. Reported separately
   * and NOT folded into each row's count: measured 2026-08-05, all 22 enabled advertising
   * rules are account-wide, so a per-row total would read "22 rules" on all 216 campaigns
   * and say nothing about any of them.
   */
  accountWideRules: number
  totals: {
    campaigns: number
    managed: number
    withMinBid: number
    withMaxBid: number
    pinned: number
    suppressed: number
  }
}

export async function getGuardrailGrid(opts: {
  marketplace?: string | null
  managedOnly?: boolean
  search?: string | null
  limit?: number
} = {}): Promise<GuardrailGrid> {
  const where: Record<string, unknown> = {}
  if (opts.marketplace) where.marketplace = opts.marketplace
  if (opts.managedOnly) where.liveBidWritesEnabled = true
  if (opts.search) where.name = { contains: opts.search, mode: 'insensitive' }
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 500)

  const [campaigns, rules, accountWideRules, totals] = await Promise.all([
    prisma.campaign.findMany({
      where,
      // Managed first: the campaigns automation can actually touch are the ones whose
      // bounds matter, and they are 82 of 216.
      orderBy: [{ liveBidWritesEnabled: 'desc' }, { marketplace: 'asc' }, { name: 'asc' }],
      take: limit,
      select: {
        id: true, name: true, marketplace: true, status: true, portfolioId: true,
        liveBidWritesEnabled: true, minBidCents: true, maxBidCents: true, targetAcosPct: true,
        dailyBudget: true, dynamicBidding: true,
        bidsSuppressedAt: true, bidsSuppressedBy: true, bidsSuppressedFloorCents: true,
        pinPlacement: true, pinBids: true, pinBudget: true,
        pinNote: true, pinnedBy: true, pinnedAt: true,
      },
    }),
    prisma.automationRule.findMany({
      where: { domain: 'advertising', scopeCampaignId: { not: null } },
      select: { id: true, name: true, autonomyLevel: true, enabled: true, scopeCampaignId: true },
    }),
    prisma.automationRule.count({
      where: { domain: 'advertising', enabled: true, scopeCampaignId: null, scopePortfolioId: null },
    }),
    prisma.campaign.aggregate({ _count: { _all: true } }),
  ])

  const rulesByCampaign = new Map<string, GuardrailRow['boundRules']>()
  for (const r of rules) {
    if (!r.scopeCampaignId) continue
    const list = rulesByCampaign.get(r.scopeCampaignId) ?? []
    list.push({ id: r.id, name: r.name, level: r.autonomyLevel ?? 'OFF', enabled: r.enabled })
    rulesByCampaign.set(r.scopeCampaignId, list)
  }

  // Portfolio names, resolved in one query. Campaign.portfolioId holds Amazon's EXTERNAL
  // id (see the ACR reference note), so this joins on externalPortfolioId, not the pk.
  const pfIds = [...new Set(campaigns.map((c) => c.portfolioId).filter(Boolean) as string[])]
  const pfNames = pfIds.length
    ? new Map((await prisma.amazonAdsPortfolio.findMany({
      where: { externalPortfolioId: { in: pfIds } },
      select: { externalPortfolioId: true, name: true },
    })).map((p) => [p.externalPortfolioId, p.name]))
    : new Map<string, string>()

  const rows: GuardrailRow[] = campaigns.map((c) => {
    const db = (c.dynamicBidding ?? {}) as { cpcCeiling?: { enabled?: boolean; multiple?: number }; targetAcos?: number }
    const pins = { placement: c.pinPlacement, bids: c.pinBids, budget: c.pinBudget }
    return {
      id: c.id,
      name: c.name,
      marketplace: c.marketplace,
      status: c.status,
      portfolioId: c.portfolioId,
      portfolioName: c.portfolioId ? pfNames.get(c.portfolioId) ?? null : null,
      managed: c.liveBidWritesEnabled,
      minBidCents: c.minBidCents,
      maxBidCents: c.maxBidCents,
      dailyBudgetCents: c.dailyBudget != null ? Math.round(Number(c.dailyBudget) * 100) : null,
      // dynamicBidding.targetAcos is the fraction five services actually read;
      // Campaign.targetAcosPct is the deliberately-unused duplicate column (see
      // ads-guardrails.ts). Prefer the one the engines use.
      targetAcosPct: db.targetAcos != null ? Math.round(db.targetAcos * 100) : c.targetAcosPct,
      cpcCeiling: db.cpcCeiling?.enabled ? { enabled: true, multiple: Number(db.cpcCeiling.multiple ?? 1.5) } : null,
      suppressedAt: c.bidsSuppressedAt,
      suppressedBy: c.bidsSuppressedBy,
      suppressedFloorCents: c.bidsSuppressedFloorCents,
      pins,
      pinnedDimensions: pinnedDimensions({ pinPlacement: pins.placement, pinBids: pins.bids, pinBudget: pins.budget }),
      pinNote: c.pinNote,
      pinnedBy: c.pinnedBy,
      pinnedAt: c.pinnedAt,
      boundRules: rulesByCampaign.get(c.id) ?? [],
    }
  })

  // Totals over the WHOLE account, not the filtered page — a coverage number that moves
  // when you type in a search box is not a coverage number.
  const [managed, withMinBid, withMaxBid, pinned, suppressed] = await Promise.all([
    prisma.campaign.count({ where: { liveBidWritesEnabled: true } }),
    prisma.campaign.count({ where: { minBidCents: { not: null } } }),
    prisma.campaign.count({ where: { maxBidCents: { not: null } } }),
    prisma.campaign.count({ where: { OR: [{ pinPlacement: true }, { pinBids: true }, { pinBudget: true }] } }),
    prisma.campaign.count({ where: { bidsSuppressedAt: { not: null } } }),
  ])

  return {
    rows,
    accountWideRules,
    totals: { campaigns: totals._count._all, managed, withMinBid, withMaxBid, pinned, suppressed },
  }
}
