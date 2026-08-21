/**
 * RT.2 — the five page cursors, and the one page that deliberately gets none.
 *
 * A cursor is a small flat object of scalars. The client (`_shared/useCursorPoll.ts`) compares it
 * field-by-field against the cursor its rendered payload carried; any difference sets `stale` and
 * offers a Refresh button. It never refetches on its own — an engine's write must not reorder the
 * grid someone is reading.
 *
 * ── 🔴 The measurement that shaped every shape here (prod, 2026-08-15) ──────────────────────────
 *
 * The obvious field on four of these pages is a METRONOME — a column a cron re-stamps whether or
 * not anything happened. `scripts/_rt-cursor-probe.mts` measured it:
 *
 *     Campaign.updatedAt        200 of 220 rows in 25 minutes   (ads-campaign-settings-sync, every 20 min)
 *     AdSchedule.updatedAt       33 of  33 rows in 20 minutes   (ad-rank-defend + ad-dayparting, every 15 min)
 *     AdTarget.updatedAt      2,937 of 3,155 rows in 3 hours    (ads-v1-sync, ~2h)
 *     AutomationRule.updatedAt   19 of  51 rows in 20 minutes   (advertising-rule-evaluator, every 15 min)
 *
 * A cursor over any of those fires forever, and a banner that always cries wolf is worse than no
 * banner: it trains the operator to ignore the one that matters. So four of the five below are
 * VALUE FINGERPRINTS (BUD.1's shape), not row timestamps (BID.S0's). The two callers that shipped
 * first reached opposite conclusions from this same question, which is why the contract requires
 * each page to measure rather than copy a sibling.
 *
 * ── Why these functions live together ───────────────────────────────────────────────────────────
 *
 * Each one calls THE PAGE'S OWN scope resolver — never a reimplementation — so a cursor can never
 * describe a different row set from the grid it is polling for. Keeping the five in one file is
 * what makes them comparable: the next person adding a sixth can see, in one screen, that the
 * house style is a fingerprint and why.
 */
import prisma from '../../db.js'

/**
 * Hash the fold to a short hex string.
 *
 * 🔴 Not cosmetic. The raw folds are multi-kilobyte — dayparting's `plan` is 33 schedules × a
 * 7×24 window list — and this payload is fetched every 45 seconds by every open tab. Measured on
 * the first deploy: `plan` and `applied` were ~4 KB each. The cursor only ever needs to answer
 * "same or different", which a hash answers in 8 characters.
 *
 * FNV-1a, 32-bit. Collisions are theoretically possible and the consequence is a missed banner on
 * one refresh, not a wrong number on screen — the same failure class as the poll interval itself.
 */
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Fold an object to a stable string, dropping keys whose value is a wall-clock stamp. */
function digest(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v)) return v.map(digest).join('|')
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      // 🔴 `at`/`*At` inside these JSON blobs is written on every tick even by a no-op branch —
      // `ad-budget-schedule` stamps `at: new Date()` in BOTH of its skip paths. Folding it raw
      // would make the digest differ every 15 minutes by the timestamp alone.
      .filter(([k]) => k !== 'at' && !/At$/.test(k))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, val]) => `${k}=${digest(val)}`)
      .join(',')
  }
  return String(v)
}

// ── 1 · Apply Rules ─────────────────────────────────────────────────────────────────────────────
export interface ArCursor {
  /** campaigns in scope — a create or an archive moves nothing else here */
  n: number
  /** the write gate. 🔴 NO timestamp anywhere records a gate flip: `PATCH /live-writes` logs to
   *  `logger.warn` and writes no AdvertisingActionLog row, so this count is the only witness. */
  managed: number
  /** campaigns declaring a floor or a ceiling — the bounds column */
  bounded: number
  /** per-dimension authority pins */
  pinned: number
  /** who is floored right now */
  suppressed: number
  /** Σ daily budget over ENABLED, in cents. BUD.1 proved Σ-value beats the row timestamp here. */
  liveBudgetCents: number
  /** the audited governance actions — the only field that catches a bound EDITED IN PLACE
   *  (30¢ → 40¢ moves no count) */
  loggedAt: string | null
}

export async function getApplyRulesCursor(scope: {
  market: string; line?: string | null; portfolio?: string | null; campaign?: string | null
}): Promise<ArCursor> {
  // 🔴 Apply Rules ANDs its four grains (every other page in the section is most-specific-wins).
  // Resolving it any other way gives a different row set from the grid whenever two grains are set.
  const where: Record<string, unknown> = {}
  if (scope.market && scope.market !== 'all') where.marketplace = scope.market.toUpperCase()
  if (scope.portfolio) where.portfolioId = scope.portfolio
  if (scope.campaign) where.id = scope.campaign

  const rows = await prisma.campaign.findMany({
    where,
    select: {
      id: true, status: true, dailyBudget: true, liveBidWritesEnabled: true,
      minBidCents: true, maxBidCents: true, pinPlacement: true, pinBids: true, pinBudget: true,
      bidsSuppressedAt: true,
    },
  })
  // One read folded in JS beats seven count() round-trips, and it is BUD.1's shape exactly.
  let managed = 0, bounded = 0, pinned = 0, suppressed = 0, liveBudgetCents = 0
  for (const c of rows) {
    if (c.liveBidWritesEnabled) managed++
    if (c.minBidCents != null || c.maxBidCents != null) bounded++
    if (c.pinPlacement || c.pinBids || c.pinBudget) pinned++
    if (c.bidsSuppressedAt != null) suppressed++
    if (c.status === 'ENABLED') liveBudgetCents += Math.round(Number(c.dailyBudget ?? 0) * 100)
  }
  const log = rows.length
    ? await prisma.advertisingActionLog.findFirst({
      where: {
        entityId: { in: rows.map((r) => r.id) },
        actionType: { in: ['set_campaign_bid_bounds', 'set_campaign_budget_bounds', 'set_campaign_authority_pins'] },
      },
      orderBy: { createdAt: 'desc' }, select: { createdAt: true },
    })
    : null
  return { n: rows.length, managed, bounded, pinned, suppressed, liveBudgetCents, loggedAt: log?.createdAt.toISOString() ?? null }
}

// ── 2 · Automations ─────────────────────────────────────────────────────────────────────────────
export interface AutoCursor {
  n: number
  /** a fold over every rule's CONFIG, excluding the metronome columns on the same row */
  cfg: string
  /** pending suggestions. Non-metronomic by construction: `@@unique([ruleId, entityId, proposedKey])`
   *  means a rule re-proposing the same change every tick creates no new row. */
  pending: number
  /**
   * 🔴 Only present on the ledger view. Measured: four rank-defend actors write ~290 audit rows a
   * day between them — one every five minutes — so on the actors view this would pop a banner
   * every few minutes about placement pushes nobody is looking at. The ledger view IS those rows,
   * so there it is the point.
   */
  actedAt?: string | null
}

export async function getAutomationsCursor(view: string): Promise<AutoCursor> {
  const rules = await prisma.automationRule.findMany({
    where: { domain: 'advertising' },
    select: {
      id: true, enabled: true, autonomyLevel: true,
      maxExecutionsPerDay: true, maxWritesPerDay: true, maxValueCentsEur: true,
      scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
      // NOT evaluationCount / matchCount / lastEvaluatedAt / updatedAt — those are the metronome.
      conditions: true, actions: true,
    },
    orderBy: { id: 'asc' },
  })
  const pending = await prisma.adsRuleSuggestion.count({ where: { status: 'pending' } })
  const out: AutoCursor = { n: rules.length, cfg: hash(digest(rules)), pending }
  if (view === 'ledger') {
    const log = await prisma.advertisingActionLog.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
    out.actedAt = log?.createdAt.toISOString() ?? null
  }
  return out
}

// ── 3 · Rank & Dayparting ───────────────────────────────────────────────────────────────────────
export interface DpCursor {
  /** enabled schedules in scope */
  n: number
  /** the PLAN: windows + default target + per-campaign overrides. Catches an operator edit. */
  plan: string
  /** what the engine has actually APPLIED, timestamps stripped. Catches the engine acting. */
  applied: string
  /** the target library — a bias or ceiling edited there changes every row holding that key */
  targetsAt: string | null
  /** written ONLY on a meaningful change (`saveRankScheduleGroup` compares first) — an anti-metronome */
  planAt: string | null
}

export async function getDaypartingCursor(scope: { market: string; portfolio?: string | null; campaign?: string | null }): Promise<DpCursor> {
  const campWhere: Record<string, unknown> = {}
  if (scope.market && scope.market !== 'all') campWhere.marketplace = scope.market.toUpperCase()
  if (scope.portfolio) campWhere.portfolioId = scope.portfolio
  if (scope.campaign) campWhere.id = scope.campaign
  const narrowed = Object.keys(campWhere).length > 0
  const ids = narrowed
    ? (await prisma.campaign.findMany({ where: campWhere, select: { id: true } })).map((c) => c.id)
    : null

  const scheds = await prisma.adSchedule.findMany({
    where: { enabled: true, ...(ids ? { campaignId: { in: ids } } : {}) },
    select: { id: true, campaignId: true, windows: true, defaultTargetKey: true, targetOverrides: true, lastApplied: true },
    orderBy: { id: 'asc' },
  })
  const [targets, version] = await Promise.all([
    prisma.rankTarget.aggregate({ _max: { updatedAt: true } }),
    prisma.rankScheduleVersion.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ])
  return {
    n: scheds.length,
    plan: hash(digest(scheds.map((s) => [s.id, s.windows, s.defaultTargetKey, s.targetOverrides]))),
    /**
     * 🔴 The hour is deliberately NOT in this cursor. The page's mode/capped/min-bid values are
     * hour-derived, so carrying the clock would fire 24×/day — the exact ratio Budget rejected
     * `Campaign.updatedAt` on. `applied` fires instead when the engine acts on the new hour, which
     * is ≤15 minutes later and is the moment the stored data actually changes. The cost is a
     * boundary the page renders differently before the engine catches up; the alternative is two
     * banners per boundary, every day, forever.
     */
    applied: hash(digest(scheds.map((s) => [s.id, s.lastApplied]))),
    targetsAt: targets._max.updatedAt?.toISOString() ?? null,
    planAt: version?.createdAt.toISOString() ?? null,
  }
}

// ── 4 · Keyword Harvest ─────────────────────────────────────────────────────────────────────────
export interface HvCursor {
  /** the feed's newest DAY — "a new day landed" */
  feedDay: string | null
  /** the feed's newest WRITE — catches a RE-ingest of a day already on screen, which changes every
   *  number in the grid while `feedDay` holds still */
  feedAt: string | null
  /** rows in the last 90 days. Bounded deliberately: the Sunday 90-day purge would otherwise drop
   *  this count every week over rows no window on the page can show. */
  feedN: number
  /** positive keywords in scope — harvest's subject is EXISTENCE, so a count, never `updatedAt` */
  kwN: number
  /** of those, how many reached Amazon — `local-only` is a first-class status here and it flips
   *  with no create and no delete */
  kwAtAmazon: number
  /** a threshold change re-decides every row, and moves nothing else in this cursor */
  policyAt: string | null
}

export async function getHarvestCursor(scope: { market: string; campaign?: string | null }): Promise<HvCursor> {
  const market = scope.market && scope.market !== 'all' ? scope.market.toUpperCase() : null
  const since90 = new Date(Date.now() - 90 * 86_400_000)
  const [feed, kwN, kwAtAmazon, policy] = await Promise.all([
    prisma.amazonAdsSearchTerm.aggregate({
      where: { ...(market ? { marketplace: market } : {}), date: { gte: since90 } },
      _max: { date: true, createdAt: true }, _count: { _all: true },
    }),
    prisma.adTarget.count({
      where: {
        isNegative: false,
        ...(market || scope.campaign
          ? { adGroup: { campaign: { ...(market ? { marketplace: market } : {}), ...(scope.campaign ? { id: scope.campaign } : {}) } } }
          : {}),
      },
    }),
    prisma.adTarget.count({
      where: {
        isNegative: false, NOT: { externalTargetId: null },
        ...(market || scope.campaign
          ? { adGroup: { campaign: { ...(market ? { marketplace: market } : {}), ...(scope.campaign ? { id: scope.campaign } : {}) } } }
          : {}),
      },
    }),
    prisma.adsHarvestPolicy.aggregate({ _max: { updatedAt: true } }).catch(() => ({ _max: { updatedAt: null } })),
  ])
  return {
    feedDay: feed._max.date?.toISOString().slice(0, 10) ?? null,
    feedAt: feed._max.createdAt?.toISOString() ?? null,
    feedN: feed._count._all,
    kwN,
    kwAtAmazon,
    policyAt: policy._max.updatedAt?.toISOString() ?? null,
  }
}

// ── 5 · Negative Targeting ──────────────────────────────────────────────────────────────────────
export interface NegCursor {
  /** 🔴 First, not third. On Bid, `n` guards against creates and deletes the timestamps miss; here
   *  creates and deletes ARE the page's main event, and the ingest re-stamp makes every timestamp
   *  on this table a liar. */
  n: number
  atAmazon: number
  /** archived / paused — a retire is a state, not a deletion */
  inert: number
  /** the only honest timestamp on AdTarget for this page: OUR decision, never the ingest's.
   *  `updatedAt` is disqualified by the schema's own comment. */
  retiredAt: string | null
  protN: number
  protAt: string | null
}

export async function getNegativesCursor(scope: { market: string; campaign?: string | null }): Promise<NegCursor> {
  const market = scope.market && scope.market !== 'all' ? scope.market.toUpperCase() : null
  const campFilter = market || scope.campaign
    ? { adGroup: { campaign: { ...(market ? { marketplace: market } : {}), ...(scope.campaign ? { id: scope.campaign } : {}) } } }
    : {}
  const [byStatus, atAmazon, retired, prot] = await Promise.all([
    prisma.adTarget.groupBy({ by: ['status'], where: { isNegative: true, ...campFilter }, _count: { _all: true } }),
    prisma.adTarget.count({ where: { isNegative: true, NOT: { externalTargetId: null }, ...campFilter } }),
    prisma.adTarget.aggregate({ where: { isNegative: true, ...campFilter }, _max: { retiredAt: true } }),
    prisma.adKeywordProtection.aggregate({ _max: { updatedAt: true }, _count: { _all: true } }),
  ])
  const n = byStatus.reduce((s, g) => s + g._count._all, 0)
  const inert = byStatus.filter((g) => g.status !== 'ENABLED').reduce((s, g) => s + g._count._all, 0)
  return {
    n, atAmazon, inert,
    retiredAt: retired._max.retiredAt?.toISOString() ?? null,
    protN: prot._count._all,
    protAt: prot._max.updatedAt?.toISOString() ?? null,
  }
}

/**
 * ── 6 · Budget Pacing & Schedules — NO CURSOR, deliberately ─────────────────────────────────────
 *
 * Measured 2026-08-15: `BudgetSchedule` holds **0 rows** — the executor has ticked over nothing for
 * its whole life. Five of the six candidate fields describe that table. What is left:
 *
 *   · the monthly plan (`AdBudgetPlan`) is operator-only — no cron writes it — and a thing that
 *     changes only when its own operator changes it is already covered by the cross-tab rail;
 *   · the pacing band is a continuously-moving Σ of spend, re-ingested four times an hour. No
 *     honest cursor can watch that without firing forever;
 *   · what survives moves once a day, which does not justify a 45-second poll on every open tab.
 *
 * So this page keeps the cross-tab rail and its own "as of" line, and polls nothing. Revisit the
 * moment `BudgetSchedule.count() > 0`. Shipping an empty-but-armed cursor here would have been the
 * "feels live and is lying" failure the contract exists to prevent.
 */

// ── 7 · Suggestions ─────────────────────────────────────────────────────────────────────────────
export interface SugCursor {
  /** pending rows */
  pending: number
  /**
   * Fingerprint over the queue's MEMBERSHIP: the sorted pending ids + the per-status counts.
   * 🔴 NOT the payloads — the evaluator's upsert refreshes `proposedAction` (with fresh live
   * numbers inside `wouldChange`) on every 15-minute tick, so a payload fold would be a
   * metronome: a banner every tick about a queue whose row set never moved. The row SET changes
   * only when a suggestion is created, decided, expired or re-proposed — exactly the events the
   * page should refresh for.
   */
  fp: string
}

export async function getSuggestionsCursor(): Promise<SugCursor> {
  const [pendingIds, byStatus] = await Promise.all([
    prisma.adsRuleSuggestion.findMany({ where: { status: 'pending' }, select: { id: true }, orderBy: { id: 'asc' } }),
    prisma.adsRuleSuggestion.groupBy({ by: ['status'], _count: { _all: true } }),
  ])
  const counts = byStatus
    .map((g) => `${g.status}:${g._count._all}`)
    .sort()
    .join(',')
  return { pending: pendingIds.length, fp: hash(`${pendingIds.map((r) => r.id).join('|')}#${counts}`) }
}
