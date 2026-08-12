/**
 * BUD.1 — the Budget Rules page's one read.
 *
 * The page asks: **what is allowed to change a campaign's budget, by how much, and was it right?**
 * BUD.1 answers the first two thirds over the whole account, at two grains, for four markets.
 * Guardrails, baselines, the rule record, proposals and reallocation are BUD.2–BUD.7 and every one
 * of them is a slot on the page, not a change to this file.
 *
 * Read-only. It moves no budget, stages nothing, and changes nothing at Amazon.
 *
 * ── 🔴 Four things measured on prod 2026-08-12 that this file refuses to blur ────────────────────
 *
 * **1 · The action log's budgets are EUROS, and nothing else nearby is.**
 * `payloadBefore.dailyBudget` / `payloadAfter.dailyBudget` are `{"dailyBudget": 4.42}` — euros, as
 * plain numbers — while `monthlyBudgetCents`, `costMicros`, `sales7dCents` and `targetDailyCents`
 * on neighbouring models are all minor units. Re-verified here: of the newest log row per campaign,
 * the value matches `Campaign.dailyBudget` as euros and matches **zero** times after dividing by
 * 100. Assuming cents produced a "12,000% of budget" finding in the study that looked entirely
 * plausible. So this file converts ONCE, at the boundary, in `eurosToCents`, and every field it
 * exports is named `…Cents` and is an integer. A caller that never sees a bare euro cannot make
 * that mistake again.
 *
 * **2 · The write gate does NOT stop a budget cut. It stops the cut from reaching Amazon.**
 * `updateCampaignWithSync` writes the local `Campaign.dailyBudget` with no gate call; the gate runs
 * later, in `ads-sync.worker.ts:356`, at dispatch, and marks the queue row SKIPPED. So a
 * gate-closed campaign is still cut locally and still gets an `AD_BUDGET_UPDATE` row — it simply
 * diverges from Amazon instead. Measured: 28 ENABLED campaigns sit above €1; 24 have the gate open;
 * the other 4 have absorbed **488 identical €10.00 → €1.00 cuts** (122 each) that all ended
 * `SKIPPED / WRITE_GATE_DENIED`, and all 488 still read `amazonResponseStatus = 'PENDING'` because
 * that field is stamped at enqueue and never corrected when the worker skips the row. That is why
 * `reachableCents` and `cuttable` are two different numbers on this page: **cuttable is 28, reaches
 * Amazon is 24**, and calling the 4 "protected" would be exactly backwards.
 *
 * **3 · `budgetUtilization` is a 7-day AVERAGE and it cannot see the thing it is named after.**
 * A campaign that exhausts its budget by 10am and one that spends evenly across 24 hours produce
 * the same ratio. Worse, after a cut the average still carries the pre-cut days, which is how a
 * €1.00 campaign reads as 392% utilised. Amazon's actual out-of-budget hours are not ingested
 * anywhere. So the field is `spendPerDayCents` / `utilization7d`, both labelled "7-day average" at
 * the point of use, and the page never calls a campaign "budget-capped".
 *
 * **4 · The log is not a complete history.** 933 of 2,365 rows in 7 days have `payloadBefore` ≠ the
 * previous row's `payloadAfter`, because the pacer and the rules overwrite each other holding stale
 * reads. `lastMoved*` is therefore reported as "the newest audited write", never as "what this
 * budget was before".
 *
 * ── Scope resolves the way the GATE resolves it ─────────────────────────────────────────────────
 *
 * `resolveScopeReach` is what the rule evaluator enforces with, so this page calls it rather than
 * cascading its own grains — and calls it a second time, per rule, to answer "which rules can reach
 * this campaign". "The campaigns this view shows" and "the campaigns a rule scoped this way
 * reaches" are then the same set by construction, which is the whole point on a page about which
 * rule is allowed to touch what.
 */

import prisma from '../../db.js'
import { resolveScopeReach } from './ads-scope-reach.js'
import { resolveAutonomy, type AutonomyLevel } from './ads-autonomy.js'
import { microsToCents } from '../ads-core/metrics-math.js'

/** Markets with production Amazon Ads connections. IE/NL/PL/SE/UK are sandbox — no listings. */
export const BUD_MARKETS = ['IT', 'DE', 'FR', 'ES'] as const
export const BUD_MARKET_ALL = 'all'

export type BudView = 'campaigns' | 'rules'
export type BudStatusFilter = 'enabled' | 'paused' | 'archived' | 'all'
/** The chips over the campaign grid. Each is a claim the census makes and must reproduce. */
export type BudState = 'at-floor' | 'cuttable' | 'gate-denied' | 'moved-24h' | 'only-cuts' | 'unreachable'

export const BUD_STATES: readonly BudState[] = ['at-floor', 'cuttable', 'gate-denied', 'moved-24h', 'only-cuts', 'unreachable'] as const

/**
 * Amazon's hard minimum daily budget. Also the handler's floor
 * (`automation-action-handlers.ts:397`, `Math.max(1, …)`), which is what makes a −15% or −20% trim
 * a no-op on every campaign already sitting here — 58 of 86 ENABLED campaigns as of 2026-08-12.
 */
export const BUDGET_FLOOR_CENTS = 100

/** The one boundary where euros become cents. See header note 1. */
const eurosToCents = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.round(n * 100) : null
}
/** `payloadBefore` / `payloadAfter` are `{ dailyBudget: <euros> }`. Never `beforeValue`/`afterValue` —
 *  those are not fields on this model, and selecting them returns [] inside a .catch, which reads
 *  exactly like a measurement of zero. That mistake produced the study's first, wrong answer. */
const budgetCentsOf = (payload: unknown): number | null =>
  eurosToCents((payload as Record<string, unknown> | null)?.dailyBudget)

export interface BudCampaignRow {
  id: string
  name: string
  market: string
  status: string
  dailyBudgetCents: number
  currency: string
  /** at or below Amazon's €1 minimum — where every trim rule becomes a no-op */
  atFloor: boolean
  /** 🔴 `Campaign.liveBidWritesEnabled`. Gates DISPATCH, not the local cut. See header note 2. */
  gateOpen: boolean
  /** 7-day totals from AmazonAdsDailyPerformance, entityType CAMPAIGN. Never a denormalised column. */
  measured: boolean
  spend7dCents: number
  sales7dCents: number
  /** spend7d ÷ 7. The numerator of the ratio below, exposed so the page can show the average itself. */
  spendPerDayCents: number
  /** 🔴 a 7-DAY AVERAGE ÷ today's budget. Null when the budget is 0. See header note 3. */
  utilization7d: number | null
  /** the newest AUDITED write. Not "what this budget was before" — see header note 4. */
  lastMovedAt: string | null
  lastMovedFromCents: number | null
  lastMovedToCents: number | null
  /** resolved to the rule's NAME where the actor is `automation:<ruleId>`; the raw actor otherwise */
  lastMovedBy: string | null
  lastMovedByKind: 'rule' | 'pacer' | 'user' | null
  /** whether the newest write ever reached Amazon, or was skipped at dispatch */
  lastMovedDelivered: boolean | null
  delta24hCents: number
  delta24hPct: number | null
  delta7dCents: number
  delta7dPct: number | null
  writes24h: number
  writes7d: number
  /** budget rules whose SCOPE permits them to act here. Not "will act" — conditions decide that. */
  reachedByRuleIds: string[]
}

export interface BudRuleRow {
  id: string
  name: string
  enabled: boolean
  /** 🔴 `resolveAutonomy(rule)`, never `dryRun` — that field is dead, and `enabled=false` ⇒ OFF
   *  regardless of what the dial stores. Two of the six rules differ between the two readings. */
  level: AutonomyLevel
  acts: boolean
  trigger: string
  /** the adjust_ad_budget percent, when the action carries one */
  percent: number | null
  /** every action type on the rule, in order — a "cut + scale" rule that only cuts shows it here */
  actionTypes: string[]
  conditionsText: string
  /** 'Account-wide' when all four scope columns are null, which is all six rules today */
  scopeText: string
  maxExecutionsPerDay: number | null
  maxValueCentsEur: number | null
  /**
   * 🔴 Executions in the window — NOT evaluations, and there is no windowed evaluation count.
   *
   * `AutomationRuleExecution` has no `matched` column: a row exists *because* the rule matched, so
   * "executions" and "matches" are the same number here and pretending otherwise would invent a
   * funnel the data cannot support. Evaluations live only as the lifetime counters below.
   */
  executions7d: number
  succeeded7d: number
  /** rehearsals — the level was below AUTO, so nothing was written */
  dryRun7d: number
  /** AdvertisingActionLog rows this rule wrote in the window — a real budget change */
  wrote7d: number
  /** 🔴 DAILY_CAP_EXCEEDED executions. A REFUSAL, never a failure. */
  refused7d: number
  /** anything else that ended FAILED — a genuine error */
  failed7d: number
  /** lifetime counters off the rule row, labelled as such because they are not windowed */
  evaluationsLifetime: number
  matchesLifetime: number
  lastActedAt: string | null
  /** campaigns its scope reaches that are still above the floor */
  canStillMove: number
  /** campaigns its scope reaches that are already at the floor — where it is a no-op */
  alreadyAtFloor: number
}

export interface BudFacet { value: string; count: number }

/**
 * 🔴 The cursor is VIEW-SHAPED, and it does not use `Campaign.updatedAt`.
 *
 * Bid's load-bearing field is `max(AdTarget.updatedAt)`. The equivalent here fails, measured
 * 2026-08-12: `Campaign.updatedAt` moved in **7 distinct minutes in 24 hours** (219 rows, one burst
 * of 200 at 01:00–01:02, the campaign-settings resync) against **6 `AD_BUDGET_UPDATE` writes in 48
 * hours**. A cursor on it would raise the "changed" banner more often wrongly than rightly, and a
 * banner that is usually wrong is one the operator learns to ignore. There is no `budgetUpdatedAt`
 * column to use instead.
 *
 * So the fingerprint is **the value**: `budgetCents` = Σ `Campaign.dailyBudget` over the scope. It
 * moves if and only if a budget in scope moves — including the case `loggedAt` cannot see, where a
 * value is restored with no audit row (the mechanism behind those 4 campaigns whose local value
 * returns to €10.00 between ticks). `loggedAt` is here for the case the sum cannot see: a
 * compensating pair inside one poll window, which the log records twice.
 *
 * Shaped per view so the payload's cursor and the poll's cursor always carry identical key sets and
 * `useCursorPoll`'s structural equality works unchanged. A rules-view cursor watching `budgetCents`
 * would never move; a campaigns-view cursor watching `execAt` would move every 15 minutes over
 * numbers that view does not render.
 */
export interface BudCursor {
  view: BudView
  /** campaigns view: Σ dailyBudget in cents over the scope */
  budgetCents?: number
  /** campaigns view: rows in scope — a create or delete need not change the sum */
  n?: number
  /** both views: max(AdvertisingActionLog.createdAt) for AD_BUDGET_UPDATE */
  loggedAt?: string | null
  /** rules view: max(AutomationRuleExecution.startedAt) over the budget rules */
  execAt?: string | null
  /** rules view: executions in the window — the number the rules grid actually renders */
  execN?: number
}

export interface BudGridRequest {
  market: string
  product: string | null
  portfolio: string | null
  campaign: string | null
  view: BudView
  status: BudStatusFilter
  state: BudState | null
  q: string | null
  windowDays: number
  sort: string | null
  dir: 'asc' | 'desc'
  limit: number
}

export interface BudGridResult {
  scope: {
    market: string
    campaigns: number | null
    total: number
    applied: string[]
    notes: string[]
    contradiction: string | null
  }
  view: BudView
  window: { days: number; since: string }
  census: {
    campaigns: number
    /** Σ dailyBudget over the campaigns in scope at the current status filter */
    totalBudgetCents: number
    atFloor: number
    /** above the floor — what a trim can still CUT (locally, which is where the cut happens) */
    cuttable: number
    /** of `cuttable`, how many would also reach Amazon. The rest diverge instead. */
    reachesAmazon: number
    gateDenied: number
    moved24h: number
    moved24hByPacer: number
    moved24hByRule: number
    moved24hByUser: number
    rules: number
    rulesActing: number
    rulesCutOnly: number
  }
  facets: {
    market: BudFacet[]
    state: BudFacet[]
  }
  rows: BudCampaignRow[] | BudRuleRow[]
  total: number
  truncated: boolean
  cursor: BudCursor
  freshness: {
    newestBudgetLogAt: string | null
    newestExecutionAt: string | null
    newestPerfDate: string | null
  }
}

const HARD_CAP = 5000

const STATUS_ENUM: Record<Exclude<BudStatusFilter, 'all'>, 'ENABLED' | 'PAUSED' | 'ARCHIVED'> = {
  enabled: 'ENABLED', paused: 'PAUSED', archived: 'ARCHIVED',
}

/** The action that makes a rule a BUDGET rule. Matched on ANY action, never `actions[0]` — rules
 *  routinely pair a change with a `notify` and the order inside the array is incidental. */
const BUDGET_ACTION = 'adjust_ad_budget'

const actionList = (actions: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(actions) ? actions : []) as Array<Record<string, unknown>>

/**
 * The campaign ids this request is about, or `null` for "the whole account".
 *
 * `null` and "every campaign id" are the same answer and a very different query — see the identical
 * note in `bid-grid.service.ts`, which this mirrors deliberately so the two pages cannot drift on
 * what a scope means.
 */
async function resolveScope(req: Pick<BudGridRequest, 'market' | 'product' | 'portfolio' | 'campaign'>) {
  // 🔴 Portfolio and campaign are mutually exclusive and CAMPAIGN WINS. Enforced here, in the one
  // function both the grid and the cursor call, rather than only in the route: `resolveScopeReach`
  // ANDs its dimensions and refuses a pair with no campaign in common, so a link carrying both —
  // a bookmark from before a campaign was picked, a hand-edited URL, a curl — would resolve to
  // ZERO and render as "no data" instead of as the narrower answer the operator plainly meant.
  // The client also deletes the param from the address bar; that is for the URL, this is for the
  // answer, and the two must not be the same layer.
  const portfolio = req.campaign ? null : req.portfolio
  const unscoped = req.market === BUD_MARKET_ALL && !req.product && !portfolio && !req.campaign
  if (unscoped) {
    const total = await prisma.campaign.count()
    return { campaignIds: null as string[] | null, total, applied: [] as string[], notes: [] as string[], contradiction: null as string | null }
  }
  const reach = await resolveScopeReach({
    marketplace: req.market === BUD_MARKET_ALL ? null : req.market,
    portfolioId: portfolio,
    campaignId: req.campaign,
    productId: req.product,
  })
  return {
    campaignIds: reach.campaignIds,
    total: reach.total,
    applied: reach.applied,
    notes: reach.notes,
    contradiction: reach.contradiction ?? null,
  }
}

function facet<T>(rows: T[], key: (r: T) => string): BudFacet[] {
  const m = new Map<string, number>()
  for (const r of rows) { const k = key(r); m.set(k, (m.get(k) ?? 0) + 1) }
  return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/**
 * Compare, with the direction applied INSIDE and the null rule outside it.
 *
 * Lifted from `bid-grid.service.ts`, including the reason: a null metric must sort last in BOTH
 * directions, so `sign` cannot be applied to the comparator's result from outside. On this page the
 * common null is `utilization7d` on a campaign with no spend, and "unknown" is not "lowest".
 */
const cmp = (a: number | string | null, b: number | string | null, sign: number): number => {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  return sign * (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)))
}

/** Every rule carrying an `adjust_ad_budget` action, with the fields both views need. */
async function loadBudgetRules() {
  const rules = await prisma.automationRule.findMany({
    where: { domain: 'advertising' },
    select: {
      id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true, trigger: true,
      conditions: true, actions: true, maxExecutionsPerDay: true, maxValueCentsEur: true,
      scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
      lastExecutedAt: true, evaluationCount: true, matchCount: true,
    },
  })
  return rules.filter((r) => actionList(r.actions).some((a) => String(a.type ?? '') === BUDGET_ACTION))
}

/**
 * Which campaigns each rule's SCOPE permits it to act on.
 *
 * Resolved with the same `resolveScopeReach` the evaluator enforces with, once per rule. All six
 * rules are account-wide today — no market, portfolio, campaign or product on any of them — which
 * is a finding the page states rather than a shortcut this function takes: an unscoped rule skips
 * the call and returns `null`, meaning "every campaign", and the moment somebody scopes one the
 * number changes without a code change.
 */
async function ruleReach(rules: Awaited<ReturnType<typeof loadBudgetRules>>): Promise<Map<string, string[] | null>> {
  const out = new Map<string, string[] | null>()
  for (const r of rules) {
    const unscoped = !r.scopeMarketplace && !r.scopePortfolioId && !r.scopeCampaignId && !r.scopeProductId
    if (unscoped) { out.set(r.id, null); continue }
    const reach = await resolveScopeReach({
      marketplace: r.scopeMarketplace,
      portfolioId: r.scopePortfolioId,
      campaignId: r.scopeCampaignId,
      productId: r.scopeProductId,
    })
    out.set(r.id, reach.campaignIds)
  }
  return out
}

const scopeTextOf = (r: { scopeMarketplace: string | null; scopePortfolioId: string | null; scopeCampaignId: string | null; scopeProductId: string | null }): string => {
  const bits = [
    r.scopeMarketplace && `market ${r.scopeMarketplace}`,
    r.scopePortfolioId && 'one portfolio',
    r.scopeCampaignId && 'one campaign',
    r.scopeProductId && 'one product line',
  ].filter(Boolean) as string[]
  return bits.length ? bits.join(' + ') : 'Account-wide'
}

/** A readable one-liner for the conditions column. The full DSL is BUD.3's drawer. */
const conditionsTextOf = (conditions: unknown): string => {
  const list = (Array.isArray(conditions) ? conditions : []) as Array<Record<string, unknown>>
  if (!list.length) return 'No conditions — matches every context'
  return list.map((c) => {
    const field = String(c.field ?? c.metric ?? '?')
    const op = String(c.operator ?? c.op ?? '?')
    const value = c.value ?? c.threshold
    const sym = op === 'gte' ? '≥' : op === 'lte' ? '≤' : op === 'gt' ? '>' : op === 'lt' ? '<' : op === 'eq' ? '=' : op
    return `${field} ${sym} ${String(value)}`
  }).join(' AND ')
}

export async function getBudgetGrid(req: BudGridRequest): Promise<BudGridResult> {
  const since = new Date(Date.now() - req.windowDays * 86400_000)
  const since24h = new Date(Date.now() - 86400_000)
  const scope = await resolveScope(req)
  const noCampaigns = scope.campaignIds != null && scope.campaignIds.length === 0

  const campaigns = noCampaigns ? [] : await prisma.campaign.findMany({
    where: {
      ...(req.status !== 'all' ? { status: STATUS_ENUM[req.status] } : {}),
      ...(scope.campaignIds ? { id: { in: scope.campaignIds } } : {}),
    },
    select: {
      id: true, name: true, marketplace: true, status: true,
      dailyBudget: true, dailyBudgetCurrency: true, liveBidWritesEnabled: true,
    },
    // An explicit order, so the cap is a result set rather than a random sample.
    orderBy: [{ dailyBudget: 'desc' }, { id: 'asc' }],
    take: HARD_CAP + 1,
  })
  const truncated = campaigns.length > HARD_CAP
  const capped = truncated ? campaigns.slice(0, HARD_CAP) : campaigns
  const ids = capped.map((c) => c.id)

  const rules = await loadBudgetRules()
  const reach = await ruleReach(rules)

  // ── the audit spine, over the window ─────────────────────────────────────────────────────────
  // Selected by the REAL field names. `actor` / `beforeValue` / `afterValue` are not fields on this
  // model; selecting them throws, and a `.catch(() => [])` upstream turns that into a confident
  // zero. That is exactly how the study first reported "0 budget writes in 60 days".
  const logs = ids.length ? await prisma.advertisingActionLog.findMany({
    where: { actionType: 'AD_BUDGET_UPDATE', entityId: { in: ids }, createdAt: { gte: since } },
    select: {
      entityId: true, createdAt: true, userId: true, payloadBefore: true, payloadAfter: true,
      amazonResponseStatus: true, outboundQueueId: true,
    },
    orderBy: { createdAt: 'desc' },
  }) : []

  // Which of those writes actually reached Amazon. `amazonResponseStatus` cannot answer this: it is
  // stamped PENDING at enqueue and never corrected when the worker skips the row, which is why all
  // 488 gate-denied writes still read PENDING. The queue row is the truth.
  const queueIds = [...new Set(logs.map((l) => l.outboundQueueId).filter((x): x is string => !!x))]
  const queueRows = queueIds.length ? await prisma.outboundSyncQueue.findMany({
    where: { id: { in: queueIds } },
    select: { id: true, syncStatus: true, errorCode: true },
  }) : []
  const queueById = new Map(queueRows.map((q) => [q.id, q]))

  const ruleNameById = new Map(rules.map((r) => [r.id, r.name]))
  /** `automation:<ruleId>` → the rule's name; `automation:budget-manager-cron` → the pacer. */
  const describeActor = (userId: string | null): { label: string; kind: 'rule' | 'pacer' | 'user' | null } => {
    if (!userId) return { label: 'unknown', kind: null }
    if (userId.startsWith('automation:')) {
      const who = userId.slice('automation:'.length)
      const name = ruleNameById.get(who)
      if (name) return { label: name, kind: 'rule' }
      return { label: who === 'budget-manager-cron' ? 'Budget pacing engine' : who, kind: 'pacer' }
    }
    if (userId.startsWith('user:')) return { label: userId.slice('user:'.length), kind: 'user' }
    return { label: userId, kind: null }
  }

  const logsByCampaign = new Map<string, typeof logs>()
  for (const l of logs) {
    const arr = logsByCampaign.get(l.entityId) ?? []
    arr.push(l)
    logsByCampaign.set(l.entityId, arr)
  }

  // ── metrics: AmazonAdsDailyPerformance, entityType CAMPAIGN ───────────────────────────────────
  const perf = ids.length ? await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId'],
    where: { entityType: 'CAMPAIGN', localEntityId: { in: ids }, date: { gte: since } },
    _sum: { costMicros: true, sales7dCents: true },
  }) : []
  const pmap = new Map(perf.map((p) => [p.localEntityId, p]))

  const campaignRows: BudCampaignRow[] = capped.map((c) => {
    const p = pmap.get(c.id)
    const spend7dCents = p ? microsToCents(p._sum.costMicros) : 0
    const sales7dCents = p ? (p._sum.sales7dCents ?? 0) : 0
    const dailyBudgetCents = Math.round(Number(c.dailyBudget) * 100)
    const mine = logsByCampaign.get(c.id) ?? []
    const newest = mine[0] ?? null
    const actor = newest ? describeActor(newest.userId) : { label: null, kind: null }
    const q = newest?.outboundQueueId ? queueById.get(newest.outboundQueueId) : null

    // Movement is measured from the OLDEST audited `payloadBefore` in the window to today's live
    // value, not by summing deltas: 39% of consecutive rows have a broken before→after chain, so a
    // sum of deltas would be a confident number built on a chain that does not join up.
    const inWindow = (from: Date) => mine.filter((l) => l.createdAt >= from)
    const movement = (from: Date): { cents: number; pct: number | null; n: number } => {
      const rows = inWindow(from)
      if (!rows.length) return { cents: 0, pct: null, n: 0 }
      const oldestBefore = budgetCentsOf(rows[rows.length - 1].payloadBefore)
      if (oldestBefore == null) return { cents: 0, pct: null, n: rows.length }
      const delta = dailyBudgetCents - oldestBefore
      return { cents: delta, pct: oldestBefore > 0 ? delta / oldestBefore : null, n: rows.length }
    }
    const m24 = movement(since24h)
    const m7 = movement(since)

    // spend ÷ budget, where spend is a 7-day AVERAGE per day. Named so the caller cannot forget.
    const days = Math.max(1, req.windowDays)
    const spendPerDayCents = Math.round(spend7dCents / days)

    const reachedByRuleIds = rules
      .filter((r) => { const set = reach.get(r.id); return set == null || set.includes(c.id) })
      .map((r) => r.id)

    return {
      id: c.id,
      name: c.name,
      market: c.marketplace ?? '—',
      status: c.status,
      dailyBudgetCents,
      currency: c.dailyBudgetCurrency,
      atFloor: dailyBudgetCents <= BUDGET_FLOOR_CENTS,
      gateOpen: c.liveBidWritesEnabled,
      measured: !!p,
      spend7dCents,
      sales7dCents,
      spendPerDayCents,
      utilization7d: dailyBudgetCents > 0 ? spendPerDayCents / dailyBudgetCents : null,
      lastMovedAt: newest?.createdAt?.toISOString() ?? null,
      lastMovedFromCents: newest ? budgetCentsOf(newest.payloadBefore) : null,
      lastMovedToCents: newest ? budgetCentsOf(newest.payloadAfter) : null,
      lastMovedBy: actor.label,
      lastMovedByKind: actor.kind,
      lastMovedDelivered: newest ? (q ? q.syncStatus === 'SUCCESS' : null) : null,
      delta24hCents: m24.cents,
      delta24hPct: m24.pct,
      delta7dCents: m7.cents,
      delta7dPct: m7.pct,
      writes24h: m24.n,
      writes7d: m7.n,
      reachedByRuleIds,
    }
  })

  // ── the rules view ───────────────────────────────────────────────────────────────────────────
  const execs = rules.length ? await prisma.automationRuleExecution.findMany({
    where: { ruleId: { in: rules.map((r) => r.id) }, startedAt: { gte: since } },
    select: { ruleId: true, status: true, errorMessage: true, startedAt: true },
  }) : []

  // Writes are counted from the audit log by actor, over the campaigns IN SCOPE, so the number a
  // rule row shows is a number this page's campaign grid could reproduce.
  const wroteByRule = new Map<string, number>()
  for (const l of logs) {
    const u = l.userId ?? ''
    if (!u.startsWith('automation:')) continue
    const rid = u.slice('automation:'.length)
    if (!ruleNameById.has(rid)) continue
    wroteByRule.set(rid, (wroteByRule.get(rid) ?? 0) + 1)
  }

  const atFloorIds = new Set(campaignRows.filter((c) => c.atFloor).map((c) => c.id))
  const ruleRows: BudRuleRow[] = rules.map((r) => {
    const mine = execs.filter((e) => e.ruleId === r.id)
    const level = resolveAutonomy({ enabled: r.enabled, dryRun: r.dryRun, autonomyLevel: r.autonomyLevel })
    const budgetAction = actionList(r.actions).find((a) => String(a.type ?? '') === BUDGET_ACTION)
    const pct = budgetAction?.percent
    const set = reach.get(r.id)
    const reachable = set == null ? campaignRows : campaignRows.filter((c) => set.includes(c.id))
    const lastActed = mine.reduce<Date | null>((acc, e) => (!acc || e.startedAt > acc ? e.startedAt : acc), null)

    return {
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      level,
      acts: level === 'AUTO',
      trigger: r.trigger,
      percent: typeof pct === 'number' ? pct : null,
      actionTypes: actionList(r.actions).map((a) => String(a.type ?? '')),
      conditionsText: conditionsTextOf(r.conditions),
      scopeText: scopeTextOf(r),
      maxExecutionsPerDay: r.maxExecutionsPerDay,
      maxValueCentsEur: r.maxValueCentsEur,
      executions7d: mine.length,
      succeeded7d: mine.filter((e) => e.status === 'SUCCESS').length,
      dryRun7d: mine.filter((e) => e.status === 'DRY_RUN').length,
      wrote7d: wroteByRule.get(r.id) ?? 0,
      // 🔴 Spelled as an explicit OR over a nullable column. `NOT: { errorMessage: 'X' }` compiles
      // to `NOT (col = 'X')`, which is NULL — not TRUE — for the null every SUCCESS row carries.
      // That exact predicate is what silently disabled `maxExecutionsPerDay` in production
      // (`automation-rule.service.ts:566`). This page must not repeat it while reporting on it.
      refused7d: mine.filter((e) => e.errorMessage === 'DAILY_CAP_EXCEEDED').length,
      failed7d: mine.filter((e) => e.status === 'FAILED' && e.errorMessage !== 'DAILY_CAP_EXCEEDED').length,
      evaluationsLifetime: r.evaluationCount,
      matchesLifetime: r.matchCount,
      lastActedAt: lastActed?.toISOString() ?? r.lastExecutedAt?.toISOString() ?? null,
      canStillMove: reachable.filter((c) => !c.atFloor).length,
      alreadyAtFloor: reachable.filter((c) => atFloorIds.has(c.id)).length,
    }
  })

  // ── census, over the FULL scope, never a page of rows ─────────────────────────────────────────
  const moved24 = campaignRows.filter((c) => c.writes24h > 0)
  const logs24 = logs.filter((l) => l.createdAt >= since24h)
  const kindOf = (userId: string | null) => describeActor(userId).kind
  const cuttable = campaignRows.filter((c) => !c.atFloor)

  const census = {
    campaigns: campaignRows.length,
    totalBudgetCents: campaignRows.reduce((s, c) => s + c.dailyBudgetCents, 0),
    atFloor: campaignRows.filter((c) => c.atFloor).length,
    cuttable: cuttable.length,
    reachesAmazon: cuttable.filter((c) => c.gateOpen).length,
    gateDenied: cuttable.filter((c) => !c.gateOpen).length,
    moved24h: moved24.length,
    moved24hByPacer: logs24.filter((l) => kindOf(l.userId) === 'pacer').length,
    moved24hByRule: logs24.filter((l) => kindOf(l.userId) === 'rule').length,
    moved24hByUser: logs24.filter((l) => kindOf(l.userId) === 'user').length,
    rules: ruleRows.length,
    rulesActing: ruleRows.filter((r) => r.acts).length,
    // A rule whose only budget action is a decrease. The account's two AUTO rules are both this,
    // including the one named "cut + scale".
    rulesCutOnly: ruleRows.filter((r) => r.acts && r.percent != null && r.percent < 0).length,
  }

  // ── state filter, applied AFTER the census so a chip can never advertise rows it won't return ──
  const matchesState = (c: BudCampaignRow, s: BudState): boolean => {
    switch (s) {
      case 'at-floor': return c.atFloor
      case 'cuttable': return !c.atFloor
      case 'gate-denied': return !c.atFloor && !c.gateOpen
      case 'moved-24h': return c.writes24h > 0
      case 'only-cuts': return c.delta7dCents < 0
      case 'unreachable': return c.reachedByRuleIds.length === 0
      default: return true
    }
  }

  let visibleCampaigns = req.state ? campaignRows.filter((c) => matchesState(c, req.state as BudState)) : campaignRows
  if (req.q) {
    const needle = req.q.toLowerCase()
    visibleCampaigns = visibleCampaigns.filter((c) => c.name.toLowerCase().includes(needle))
  }
  let visibleRules = ruleRows
  if (req.q) {
    const needle = req.q.toLowerCase()
    visibleRules = visibleRules.filter((r) => r.name.toLowerCase().includes(needle) || r.trigger.toLowerCase().includes(needle))
  }

  // ── sort ─────────────────────────────────────────────────────────────────────────────────────
  const sign = req.dir === 'asc' ? 1 : -1
  if (req.view === 'campaigns') {
    const key = req.sort ?? 'budget'
    const pick = (c: BudCampaignRow): number | string | null => {
      switch (key) {
        case 'name': return c.name.toLowerCase()
        case 'market': return c.market
        case 'budget': return c.dailyBudgetCents
        case 'spend': return c.spend7dCents
        case 'utilization': return c.utilization7d
        case 'lastMoved': return c.lastMovedAt
        case 'delta24h': return c.delta24hCents
        case 'delta7d': return c.delta7dCents
        case 'writes7d': return c.writes7d
        case 'rules': return c.reachedByRuleIds.length
        default: return c.dailyBudgetCents
      }
    }
    visibleCampaigns = [...visibleCampaigns].sort((a, b) => cmp(pick(a), pick(b), sign) || a.id.localeCompare(b.id))
  } else {
    const key = req.sort ?? 'level'
    const LEVEL_ORDER: Record<AutonomyLevel, number> = { OFF: 0, OBSERVE: 1, PROPOSE: 2, AUTO: 3 }
    const pick = (r: BudRuleRow): number | string | null => {
      switch (key) {
        case 'name': return r.name.toLowerCase()
        case 'level': return LEVEL_ORDER[r.level]
        case 'trigger': return r.trigger
        case 'percent': return r.percent
        case 'executions7d': return r.executions7d
        case 'succeeded7d': return r.succeeded7d
        case 'wrote7d': return r.wrote7d
        case 'refused7d': return r.refused7d
        case 'lastActed': return r.lastActedAt
        case 'canStillMove': return r.canStillMove
        default: return LEVEL_ORDER[r.level]
      }
    }
    visibleRules = [...visibleRules].sort((a, b) => cmp(pick(a), pick(b), sign) || a.id.localeCompare(b.id))
  }

  const rows = req.view === 'campaigns' ? visibleCampaigns.slice(0, req.limit) : visibleRules.slice(0, req.limit)

  const newestPerf = await prisma.amazonAdsDailyPerformance.findFirst({
    where: { entityType: 'CAMPAIGN' }, orderBy: { date: 'desc' }, select: { date: true },
  })

  return {
    scope: {
      market: req.market,
      campaigns: scope.campaignIds ? scope.campaignIds.length : null,
      total: scope.total,
      applied: scope.applied,
      notes: scope.notes,
      contradiction: scope.contradiction,
    },
    view: req.view,
    window: { days: req.windowDays, since: since.toISOString() },
    census,
    facets: {
      market: facet(campaignRows, (c) => c.market),
      state: BUD_STATES.map((s) => ({ value: s, count: campaignRows.filter((c) => matchesState(c, s)).length })),
    },
    rows,
    total: req.view === 'campaigns' ? visibleCampaigns.length : visibleRules.length,
    truncated,
    cursor: await getBudgetCursor(scope.campaignIds, req.view, noCampaigns, req.status),
    freshness: {
      newestBudgetLogAt: logs[0]?.createdAt?.toISOString() ?? null,
      newestExecutionAt: execs.reduce<Date | null>((acc, e) => (!acc || e.startedAt > acc ? e.startedAt : acc), null)?.toISOString() ?? null,
      newestPerfDate: newestPerf?.date?.toISOString() ?? null,
    },
  }
}

/**
 * The poll cursor. Cheap by construction — two aggregates for the campaigns view, two counts for
 * the rules view — because every open tab hits it every 45 s and the grid read above is not cheap.
 *
 * See the `BudCursor` doc comment for why `Campaign.updatedAt` is absent.
 */
export async function getBudgetCursor(
  campaignIds: string[] | null,
  view: BudView,
  noCampaigns = false,
  status: BudStatusFilter = 'enabled',
): Promise<BudCursor> {
  if (noCampaigns) {
    return view === 'campaigns'
      ? { view, budgetCents: 0, n: 0, loggedAt: null }
      : { view, execAt: null, execN: 0, loggedAt: null }
  }
  // 🔴 The status filter belongs in the cursor, not just in the grid. Without it the cursor summed
  // all 220 campaigns (€8,768.57) while the page showed the 86 ENABLED ones (€318.57) — a cursor
  // describing a different row set from the one on screen, which is Bid's first rule broken. It
  // would also have gone stale on a PAUSED campaign's budget moving, which this page is not showing.
  // The exact ids the grid would render, so `loggedAt` cannot move on a campaign this page is not
  // showing. One indexed read over at most a few hundred rows; the cursor stays cheap.
  const scoped = await prisma.campaign.findMany({
    where: {
      ...(status !== 'all' ? { status: STATUS_ENUM[status] } : {}),
      ...(campaignIds ? { id: { in: campaignIds } } : {}),
    },
    select: { id: true, dailyBudget: true },
  })
  const scopedIds = scoped.map((c) => c.id)
  const newestBudgetLog = () => prisma.advertisingActionLog.findFirst({
    where: { actionType: 'AD_BUDGET_UPDATE', entityId: { in: scopedIds } },
    orderBy: { createdAt: 'desc' }, select: { createdAt: true },
  })

  if (view === 'campaigns') {
    const log = scopedIds.length ? await newestBudgetLog() : null
    return {
      view,
      // Summed in cents from the Decimal, not by aggregating a float: Σ then round, once.
      budgetCents: scoped.reduce((s, c) => s + Math.round(Number(c.dailyBudget) * 100), 0),
      n: scoped.length,
      loggedAt: log?.createdAt?.toISOString() ?? null,
    }
  }

  const rules = await loadBudgetRules()
  const ruleIds = rules.map((r) => r.id)
  const since = new Date(Date.now() - 7 * 86400_000)
  const [newest, n, log] = await Promise.all([
    ruleIds.length
      ? prisma.automationRuleExecution.findFirst({ where: { ruleId: { in: ruleIds } }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } })
      : Promise.resolve(null),
    ruleIds.length
      ? prisma.automationRuleExecution.count({ where: { ruleId: { in: ruleIds }, startedAt: { gte: since } } })
      : Promise.resolve(0),
    scopedIds.length ? newestBudgetLog() : Promise.resolve(null),
  ])
  return { view, execAt: newest?.startedAt?.toISOString() ?? null, execN: n, loggedAt: log?.createdAt?.toISOString() ?? null }
}

/** The cursor endpoint's own scope resolution, so the poll and the grid agree about the row set. */
export async function getBudgetCursorForRequest(
  req: Pick<BudGridRequest, 'market' | 'product' | 'portfolio' | 'campaign' | 'view'> & { status?: BudStatusFilter },
): Promise<BudCursor> {
  const scope = await resolveScope(req)
  return getBudgetCursor(
    scope.campaignIds,
    req.view,
    scope.campaignIds != null && scope.campaignIds.length === 0,
    req.status ?? 'enabled',
  )
}
