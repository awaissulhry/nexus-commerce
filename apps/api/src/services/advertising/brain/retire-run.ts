/**
 * ONE BRAIN AB-20 — the duplicate writers of a product, retired and given back (design 2026-10-08-ads-one-brain/DESIGN.md §3,
 * §8 row AB-20). The rules are brain/retire.ts (pure); this reads the facts, switches rows off and on, and keeps the record
 * (AdsBrainRetirement). Nothing here writes to Amazon: a retirement switches Nexus configuration rows off, a give-back on.
 *
 *   facts       the product's own campaigns in the market (brain/ownership.ts), its settings per campaign with the Owner's
 *               overrides, the kill switches, which campaigns the bid brain runs (BB-6), and every enabled configuration
 *               row of the six writers that reaches one of its campaigns (own or shared) — a fixed number of queries.
 *   retire      only as a person's approval (retire-ads-writers op retire): the product ready, the plan the approval stands
 *               on (its basis) unchanged, then in ONE transaction each planned row checked again (its configuration the one
 *               planned, still on) and switched off, with its record. A row that moved since stops the whole run: nothing
 *               is switched off ("preview it again").
 *   give back   op give-back (a person's approval); or by itself — every row when the product is no longer ready (it left
 *               the brain, a lever went back to the brain's default, the server switch no longer live), and each row whose
 *               own reach no longer holds (a lever the brain no longer holds on its campaigns: back from AUTO to a level the
 *               Owner chose, or stopped by a kill switch; a campaign shared or excluded since): each switched on again only
 *               when nobody changed it since — else LEFT as the person made it, and said so.
 *   tick        jobs/ads-brain-retire.job.ts every 15 minutes: the give-back above for every product with a retired row (no
 *               retired row in the business: one cheap query, nothing more), and — only under NEXUS_ADS_BRAIN_RETIRE=ask —
 *               once an hour one request per ready product with rows to retire (never while one waits, never within 14 days
 *               of a request a person declined). Off (the default) the brain asks nothing by itself: a person or Claude asks
 *               with the tool.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { inDatabaseTransaction } from '../../../lib/database-context.js'
import { logger } from '../../../utils/logger.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { brainLiveCeiling, brainOwnedCampaignIds } from '../bid-brain/live.js'
import { bidBrainMode } from '../bid-brain/shadow.js'
import { killWords, productKills } from './kill-switch.js'
import { BRAIN_LEVERS, type BrainLever } from './levers.js'
import { productCampaigns, productFamily } from './ownership.js'
import { leversOfRuleAction } from './read-map.js'
import {
  ABSORBED_ACTIONS, classifyRuleAction, DIRECTIVE_ACTIONS, giveBackDecision, isRetireWriter, planRetirement, retireFingerprint, retireReadiness, RETIRE_TOOL, ruleActionLevers,
  WRITER_WORDS, type CampaignHold, type GiveBackAct, type PlannedRow, type Readiness, type RetireCandidate, type RetirePlan, type RetireWriter, type RuleAction,
} from './retire.js'
import { resolveBrainSettings, type OverrideRow } from './settings.js'

/** The actor of the brain's own give-backs, and the asker of its own requests. */
export const RETIRE_ACTOR = 'automation:brain-retire'
export const RETIRE_ASKER = 'Nexus ads brain'
/** After a person declined (or let expire) a retirement request, the brain asks again only after this many days. */
export const ASK_AGAIN_AFTER_DAYS = 14
const DAY_MS = 86_400_000
const OPEN_APPROVAL = ['pending', 'scheduled', 'executing']

/** The brain's own asking: off (the default — only a person or Claude asks, with the tool) | ask (once a ready product has rows). */
export type RetireAskMode = 'off' | 'ask'
export function retireAskMode(env: string | undefined = process.env.NEXUS_ADS_BRAIN_RETIRE): RetireAskMode {
  return (env ?? '').trim().toLowerCase() === 'ask' ? 'ask' : 'off'
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err))
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const ids = (v: unknown): string[] => (Array.isArray(v) ? v : []).map((x) => (x && typeof x === 'object' ? str((x as { id?: unknown }).id) : str(x))).filter((x): x is string => !!x)
const num = (v: unknown): string | null => (v == null ? null : String(v))

// ── The six writers' tables ──────────────────────────────────────────────────────────────────────────────────────

/** One row as a writer's table holds it: on or off, its name, and its configuration (what a person sets). */
interface RowNow { enabled: boolean; name: string; config: Record<string, unknown> }

interface WriterTable {
  /** The rows by id (a missing id is gone). */
  load(ids: readonly string[]): Promise<Map<string, RowNow>>
  /** Compare-and-set: switch it off only while it is on; on only while it is off. The number of rows changed. */
  set(id: string, enabled: boolean): Promise<number>
}

const RULE_CONFIG = {
  id: true, name: true, enabled: true, autonomyLevel: true, dryRun: true, trigger: true, conditions: true, actions: true, domain: true, priority: true,
  maxExecutionsPerDay: true, maxWritesPerDay: true, maxValueCentsEur: true, maxDailyAdSpendCentsEur: true,
  scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
} as const
type RuleRow = Prisma.AutomationRuleGetPayload<{ select: typeof RULE_CONFIG }>

/** A rule's campaigns by assignment or its own picker (null: its scope columns decide) — ads-rule-scope-resolver.ts. */
async function assignedOf(rules: ReadonlyArray<{ id: string; actions: unknown }>): Promise<Map<string, string[]>> {
  if (!rules.length) return new Map()
  const { resolveAssignedCampaignIds } = await import('../ads-rule-scope-resolver.js')
  return resolveAssignedCampaignIds(rules)
}

function ruleConfig(r: RuleRow, assigned: readonly string[] | undefined): Record<string, unknown> {
  const { id: _id, ...rest } = r
  return { ...rest, assigned: assigned ? [...assigned].sort() : null }
}

const BUDGET_SCHEDULE_CONFIG = { id: true, name: true, kind: true, type: true, campaigns: true, windows: true, timezone: true, startDate: true, endDate: true, neverExpire: true, excludeDates: true, autoRefill: true, enabled: true } as const
const POOL_CONFIG = {
  id: true, name: true, currency: true, totalDailyBudgetCents: true, strategy: true, coolDownMinutes: true, maxShiftPerRebalancePct: true, enabled: true, dryRun: true,
  allocations: { select: { campaignId: true, marketplace: true, targetSharePct: true, minDailyBudgetCents: true, maxDailyBudgetCents: true } },
} as const
type PoolRow = Prisma.BudgetPoolGetPayload<{ select: typeof POOL_CONFIG }>
const poolConfig = (p: PoolRow): Record<string, unknown> => {
  const { id: _id, allocations, ...rest } = p
  return {
    ...rest,
    allocations: allocations.map((a) => ({ ...a, targetSharePct: num(a.targetSharePct) }))
      .sort((a, b) => String(a.campaignId).localeCompare(String(b.campaignId)) || a.marketplace.localeCompare(b.marketplace)),
  }
}
const SCHEDULE_CONFIG = { id: true, campaignId: true, name: true, windows: true, timezone: true, enabled: true, defaultTargetKey: true, targetOverrides: true } as const
const COVERAGE_CONFIG = { id: true, name: true, portfolioId: true, marketplace: true, enabled: true, dailySpendCapCents: true, acosCapPct: true } as const
const AUTOPILOT_CONFIG = { id: true, name: true, marketplace: true, productGroupName: true, campaignIds: true, goal: true, autonomy: true, guardrails: true, modules: true, linkedRuleIds: true, enabled: true } as const

const without = <T extends { id: string }>(r: T): Omit<T, 'id'> => { const { id: _id, ...rest } = r; return rest }
const asMap = <T extends { id: string; name: string; enabled: boolean }>(rows: readonly T[], config: (r: T) => Record<string, unknown>) =>
  new Map(rows.map((r) => [r.id, { enabled: r.enabled, name: r.name, config: config(r) }]))

const TABLES: Record<RetireWriter, WriterTable> = {
  rule: {
    async load(list) {
      const rows = await prisma.automationRule.findMany({ where: { id: { in: [...list] } }, select: RULE_CONFIG })
      const assigned = await assignedOf(rows)
      return asMap(rows, (r) => ruleConfig(r, assigned.get(r.id)))
    },
    async set(id, enabled) { return (await prisma.automationRule.updateMany({ where: { id, enabled: !enabled }, data: { enabled } })).count },
  },
  budgetSchedule: {
    async load(list) { return asMap(await prisma.budgetSchedule.findMany({ where: { id: { in: [...list] } }, select: BUDGET_SCHEDULE_CONFIG }), without) },
    async set(id, enabled) { return (await prisma.budgetSchedule.updateMany({ where: { id, enabled: !enabled }, data: { enabled } })).count },
  },
  budgetPool: {
    async load(list) { return asMap(await prisma.budgetPool.findMany({ where: { id: { in: [...list] } }, select: POOL_CONFIG }), poolConfig) },
    async set(id, enabled) { return (await prisma.budgetPool.updateMany({ where: { id, enabled: !enabled }, data: { enabled } })).count },
  },
  dayparting: {
    async load(list) { return asMap(await prisma.adSchedule.findMany({ where: { id: { in: [...list] } }, select: SCHEDULE_CONFIG }), without) },
    async set(id, enabled) { return (await prisma.adSchedule.updateMany({ where: { id, enabled: !enabled }, data: { enabled } })).count },
  },
  coverageSet: {
    async load(list) {
      return asMap(await prisma.keywordCoverageSet.findMany({ where: { id: { in: [...list] } }, select: COVERAGE_CONFIG }), (r) => ({ ...without(r), acosCapPct: num(r.acosCapPct) }))
    },
    async set(id, enabled) { return (await prisma.keywordCoverageSet.updateMany({ where: { id, enabled: !enabled }, data: { enabled } })).count },
  },
  autopilotPlan: {
    async load(list) { return asMap(await prisma.autopilotPlan.findMany({ where: { id: { in: [...list] } }, select: AUTOPILOT_CONFIG }), without) },
    async set(id, enabled) { return (await prisma.autopilotPlan.updateMany({ where: { id, enabled: !enabled }, data: { enabled } })).count },
  },
}

/** The fingerprint of a row as it is now, or null when it is gone. */
async function rowsNow(writer: RetireWriter, list: readonly string[]): Promise<Map<string, RowNow & { fingerprint: string }>> {
  const rows = await TABLES[writer].load(list)
  return new Map([...rows].map(([id, r]) => [id, { ...r, fingerprint: retireFingerprint(r.config) }]))
}

// ── The candidates ───────────────────────────────────────────────────────────────────────────────────────────────

/** The levers an autopilot plan's own modules write (its harvest and negate run as rules of their own). */
export function autopilotLevers(modules: unknown): BrainLever[] {
  const m = (modules && typeof modules === 'object' && !Array.isArray(modules) ? modules : {}) as Record<string, { on?: unknown } | undefined>
  const map: Record<string, BrainLever[]> = { bid: ['bids'], budget: ['budgets'], dayparting: ['bids', 'hours'], rank: ['hours', 'placements'], placement: ['placements'] }
  const on = Object.keys(map).filter((k) => m[k]?.on === true)
  // A plan that names no module of its own may run any of them: every lever they write counts.
  return [...new Set((on.length ? on : Object.keys(map)).flatMap((k) => map[k]))].sort() as BrainLever[]
}

const ruleActions = (actions: unknown): RuleAction[] =>
  (Array.isArray(actions) ? actions : []).map((a) => {
    const o = (a ?? {}) as { type?: unknown; target?: unknown }
    const type = String(o.type ?? '')
    return { type, target: str(o.target), levers: leversOfRuleAction(type) }
  }).filter((a) => a.type)

/** A rule writes an ad lever (or asks a bid input) at all: only those are this product's writers. */
const isAdRule = (actions: RuleAction[]) => actions.some((a) => a.levers.length || DIRECTIVE_ACTIONS.includes(a.type) || ABSORBED_ACTIONS.includes(a.type))

interface Scope { market: string; root: string; family: ReadonlySet<string>; own: ReadonlySet<string>; shared: ReadonlySet<string> }

/** Every enabled row of the six writers that reaches one of the product's campaigns (own or shared). */
async function loadCandidates(s: Scope): Promise<RetireCandidate[]> {
  const all = [...s.own, ...s.shared]
  if (!all.length) return []
  const touches = (list: readonly string[]) => list.some((id) => s.own.has(id) || s.shared.has(id))
  const [{ RUNNING_AUTOPILOT_PLANS }, { isGoalMode }, { readSnapshot }, { giveBackCheck }] = await Promise.all([
    import('../../../jobs/ad-autopilot.job.js'), import('../../../jobs/ad-rank-defend.job.js'), import('../../../jobs/ad-dayparting.job.js'), import('../../../jobs/ad-budget-schedule.job.js'),
  ])
  const [rules, schedules, pools, dayparting, autopilots, campaignRows] = await Promise.all([
    prisma.automationRule.findMany({ where: { enabled: true, autonomyLevel: { not: 'OFF' } }, select: RULE_CONFIG }),
    prisma.budgetSchedule.findMany({ where: { enabled: true, kind: 'BUDGET' }, select: { ...BUDGET_SCHEDULE_CONFIG, lastApplied: true } }),
    prisma.budgetPool.findMany({ where: { enabled: true, allocations: { some: { campaignId: { in: all } } } }, select: POOL_CONFIG }),
    prisma.adSchedule.findMany({ where: { campaignId: { in: all }, enabled: true }, select: { ...SCHEDULE_CONFIG, originalBids: true } }),
    prisma.autopilotPlan.findMany({ where: RUNNING_AUTOPILOT_PLANS, select: AUTOPILOT_CONFIG }),
    prisma.campaign.findMany({ where: { id: { in: all } }, select: { id: true, name: true, portfolioId: true, dailyBudget: true } }),
  ])
  const out: RetireCandidate[] = []

  // Rules: their reach by assignment or picker, else by their scope columns (an AND of dimensions).
  const adRules = rules.map((r) => ({ r, actions: ruleActions(r.actions) })).filter((x) => isAdRule(x.actions))
  const assigned = await assignedOf(adRules.map((x) => x.r))
  const scopeProducts = [...new Set(adRules.map((x) => x.r.scopeProductId).filter((v): v is string => !!v))]
  const rootOf = new Map((scopeProducts.length ? await prisma.product.findMany({ where: { id: { in: scopeProducts } }, select: { id: true, parentId: true } }) : []).map((p) => [p.id, p.parentId ?? p.id]))
  const portfolios = [...new Set([
    ...adRules.map((x) => x.r.scopePortfolioId),
    ...campaignRows.map((c) => c.portfolioId),
  ].filter((v): v is string => !!v))]
  const inPortfolio = new Map<string, Array<{ id: string; marketplace: string | null }>>()
  if (portfolios.length) {
    for (const c of await prisma.campaign.findMany({ where: { portfolioId: { in: portfolios }, status: { not: 'ARCHIVED' } }, select: { id: true, portfolioId: true, marketplace: true } })) {
      inPortfolio.set(c.portfolioId!, [...(inPortfolio.get(c.portfolioId!) ?? []), { id: c.id, marketplace: c.marketplace }])
    }
  }
  for (const { r, actions } of adRules) {
    if (r.scopeMarketplace && strategyMarket(r.scopeMarketplace) !== s.market) continue
    const bound = assigned.get(r.id)
    let reach: RetireCandidate['reach'] | null = null
    let scope: string
    if (bound !== undefined) {
      reach = touches(bound) ? { campaignIds: bound } : null
      scope = `its own list of ${bound.length} campaign${bound.length === 1 ? '' : 's'}`
    } else if (r.scopeCampaignId) {
      reach = touches([r.scopeCampaignId]) ? { campaignIds: [r.scopeCampaignId] } : null
      scope = 'one campaign'
    } else if (r.scopeProductId) {
      const root = rootOf.get(r.scopeProductId) ?? r.scopeProductId
      const ofFamily = root === s.root || s.family.has(r.scopeProductId)
      const list = all.filter((id) => !r.scopePortfolioId || (inPortfolio.get(r.scopePortfolioId) ?? []).some((c) => c.id === id))
      reach = !ofFamily || !list.length ? null : r.scopeMarketplace ? { campaignIds: list } : { beyond: 'the product in every market, not only this one' }
      scope = `the product${r.scopeMarketplace ? ` in ${s.market}` : ' in every market'}${r.scopePortfolioId ? ' in one portfolio' : ''}`
    } else if (r.scopePortfolioId) {
      const list = (inPortfolio.get(r.scopePortfolioId) ?? []).filter((c) => !r.scopeMarketplace || strategyMarket(c.marketplace) === s.market).map((c) => c.id)
      reach = touches(list) ? { campaignIds: list } : null
      scope = 'one portfolio'
    } else {
      reach = r.scopeMarketplace ? { beyond: `every campaign in ${s.market}` } : { beyond: 'every campaign of the business' }
      scope = r.scopeMarketplace ? `every ${s.market} campaign` : 'the whole business'
    }
    if (!reach) continue
    out.push({
      writer: 'rule', id: r.id, name: r.name, fingerprint: retireFingerprint(ruleConfig(r, bound)), reach,
      // A directive is an input of the bid brain, not a lever it writes (planRetirement keeps the rule for it).
      levers: [...new Set(actions.filter((a) => classifyRuleAction(a) !== 'directive').flatMap(ruleActionLevers))],
      actions, scope: `${r.autonomyLevel}${r.dryRun ? ', dry run' : ''}; ${scope}`,
    })
  }

  // Budget schedules: their campaign list; one still holding the budget it set owes its give-back first.
  const budgetNow = new Map(campaignRows.map((c) => [c.id, Math.round(Number(c.dailyBudget ?? 0) * 100)]))
  const nameOf = new Map(campaignRows.map((c) => [c.id, c.name]))
  for (const sch of schedules) {
    const list = ids(sch.campaigns)
    if (!touches(list)) continue
    const legacy = new Map((Array.isArray(sch.campaigns) ? sch.campaigns as Array<{ id?: unknown; dailyBudget?: unknown }> : []).map((c) => [String(c?.id), c?.dailyBudget != null ? Math.round(Number(c.dailyBudget) * 100) : null]))
    const last = (sch.lastApplied ?? {}) as unknown as Record<string, Parameters<typeof giveBackCheck>[0]>
    const owed = list.filter((id) => s.own.has(id) && budgetNow.has(id) && giveBackCheck(last[id], budgetNow.get(id)!, legacy.get(id) ?? null).act === 'giveBack')
    const { lastApplied: _memo, ...config } = sch
    out.push({
      writer: 'budgetSchedule', id: sch.id, name: sch.name, fingerprint: retireFingerprint(without(config)), reach: { campaignIds: list }, levers: ['budgets'],
      owes: owed.length ? `the budget it set on ${owed.map((id) => `"${nameOf.get(id) ?? id}"`).join(', ')}` : null,
      scope: `${list.length} campaign${list.length === 1 ? '' : 's'}`,
    })
  }

  // Budget pools: their members; a share that names no campaign reaches beyond any list.
  for (const p of pools) {
    const list = p.allocations.map((a) => a.campaignId).filter((v): v is string => !!v)
    const loose = p.allocations.some((a) => !a.campaignId)
    out.push({
      writer: 'budgetPool', id: p.id, name: p.name, fingerprint: retireFingerprint(poolConfig(p)),
      reach: loose ? { beyond: 'a share of the pool that names no campaign' } : { campaignIds: list }, levers: ['budgets'],
      scope: `${p.allocations.length} member${p.allocations.length === 1 ? '' : 's'}${p.dryRun ? ', dry run' : ''}`,
    })
  }

  // Classic dayparting (an hourly bid plan's goal-mode row is the brain's input: never a candidate).
  for (const d of dayparting) {
    if (isGoalMode(d.windows, d.defaultTargetKey)) continue
    const raised = Object.keys(readSnapshot(d.originalBids).base).length
    const { originalBids: _memo, ...config } = d
    out.push({
      writer: 'dayparting', id: d.id, name: d.name, fingerprint: retireFingerprint(without(config)), reach: { campaignIds: [d.campaignId] }, levers: ['bids', 'hours'],
      owes: raised ? `the bids its window raised on ${raised} keyword${raised === 1 ? '' : 's'}` : null, scope: 'one campaign',
    })
  }

  // Coverage sets: every campaign of their portfolio.
  const ourPortfolios = [...new Set(campaignRows.map((c) => c.portfolioId).filter((v): v is string => !!v))]
  if (ourPortfolios.length) {
    for (const set of await prisma.keywordCoverageSet.findMany({ where: { enabled: true, portfolioId: { in: ourPortfolios } }, select: COVERAGE_CONFIG })) {
      const list = (inPortfolio.get(set.portfolioId) ?? []).map((c) => c.id)
      if (!touches(list)) continue
      out.push({
        writer: 'coverageSet', id: set.id, name: set.name, fingerprint: retireFingerprint({ ...without(set), acosCapPct: num(set.acosCapPct) }), reach: { campaignIds: list }, levers: ['bids'],
        scope: `the ${list.length} campaign${list.length === 1 ? '' : 's'} of one portfolio`,
      })
    }
  }

  // Autopilot plans: their campaign list and the levers of their own modules.
  for (const a of autopilots) {
    const list = ids(a.campaignIds)
    if (!touches(list)) continue
    out.push({
      writer: 'autopilotPlan', id: a.id, name: a.name, fingerprint: retireFingerprint(without(a)), reach: { campaignIds: list }, levers: autopilotLevers(a.modules),
      scope: `${a.autonomy}; ${list.length} campaign${list.length === 1 ? '' : 's'}`,
    })
  }
  return out
}

// ── The facts of one product ─────────────────────────────────────────────────────────────────────────────────────

export interface RetirementRecord {
  id: string
  writer: string
  targetId: string
  targetName: string
  campaignIds: string[]
  levers: string[]
  why: string
  status: string
  approvalId: string | null
  retiredBy: string
  retiredAt: string
  givenBackAt: string | null
  givenBackBy: string | null
  givenBackWhy: string | null
  /** The fingerprint retirement left (what a give-back checks). */
  left: string
}

const RECORD_SELECT = {
  id: true, writer: true, targetId: true, targetName: true, campaignIds: true, levers: true, why: true, status: true, approvalId: true, retiredBy: true, retiredAt: true,
  givenBackAt: true, givenBackBy: true, givenBackWhy: true, after: true,
} as const
type RecordRow = Prisma.AdsBrainRetirementGetPayload<{ select: typeof RECORD_SELECT }>
const recordOf = (r: RecordRow): RetirementRecord => ({
  id: r.id, writer: r.writer, targetId: r.targetId, targetName: r.targetName, campaignIds: r.campaignIds, levers: r.levers, why: r.why, status: r.status,
  approvalId: r.approvalId, retiredBy: r.retiredBy, retiredAt: r.retiredAt.toISOString(), givenBackAt: r.givenBackAt?.toISOString() ?? null,
  givenBackBy: r.givenBackBy, givenBackWhy: r.givenBackWhy, left: String((r.after as { fingerprint?: unknown } | null)?.fingerprint ?? ''),
})

export interface RetireFacts {
  productId: string
  name: string | null
  market: string
  enrolled: boolean
  readiness: Readiness
  own: Map<string, CampaignHold>
  shared: Array<{ campaignId: string; name: string }>
  plan: RetirePlan
  /** Rows this product's brain holds switched off now. */
  retired: RetirementRecord[]
}

const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const

/** Everything a retirement of one product × market decides on. A refusal when the product or the market is unknown here. */
export async function loadRetireFacts(productId: string, market: string): Promise<RetireFacts | { refusal: string }> {
  const m = strategyMarket(market)
  if (!m) return { refusal: `${market} is not an Amazon market code (business-overview lists them)` }
  const family = await productFamily(productId)
  if (!family) return { refusal: 'Product not found' }
  const root = family.root
  const [product, enrollment, campaigns, kills] = await Promise.all([
    prisma.product.findFirst({ where: { id: root }, select: { name: true } }),
    prisma.adsBrainEnrollment.findFirst({ where: { productId: root, marketplace: m }, select: { id: true } }),
    productCampaigns(root, m),
    productKills(root, m),
  ])
  const owned = campaigns?.owned ?? []
  const ownIds = owned.map((c) => c.campaignId)
  const [overrides, bidRows, brainOwned, retiredRows] = await Promise.all([
    prisma.adsBrainOverride.findMany({ where: { endedAt: null, OR: [{ scope: 'PRODUCT', productId: root, marketplace: m }, ...(ownIds.length ? [{ scope: 'CAMPAIGN', campaignId: { in: ownIds } }] : [])] }, select: OVERRIDE_SELECT }) as Promise<OverrideRow[]>,
    ownIds.length ? prisma.bidBrainEnrollment.findMany({ where: { campaignId: { in: ownIds } }, select: { campaignId: true, mode: true } }) : Promise.resolve([]),
    brainOwnedCampaignIds(ownIds),
    prisma.adsBrainRetirement.findMany({ where: { productId: root, marketplace: m, status: 'RETIRED' }, select: RECORD_SELECT, orderBy: [{ retiredAt: 'asc' }, { id: 'asc' }] }),
  ])
  const enrolled = !!enrollment
  const ceilingLive = brainLiveCeiling()
  const killWordsOf = Object.fromEntries(Object.entries(kills).map(([lever, k]) => [lever, killWords(k!)])) as Partial<Record<BrainLever, string>>
  const settings = enrolled ? resolveBrainSettings({ productId: root, market: m, campaignId: null, enrolled: true, overrides }) : null
  const readiness = retireReadiness({ enrolled, ceilingLive, ceiling: bidBrainMode(), settings, kills: killWordsOf, ownCampaigns: owned.length })
  const modeOf = new Map(bidRows.map((r) => [r.campaignId, r.mode]))
  const own = new Map<string, CampaignHold>()
  for (const c of owned) {
    const cs = enrolled ? resolveBrainSettings({ productId: root, market: m, campaignId: c.campaignId, enrolled: true, overrides }) : null
    const levers: CampaignHold['levers'] = {}
    for (const lever of BRAIN_LEVERS) {
      const l = cs?.levers[lever]
      if (!cs || !l) { levers[lever] = { held: false, why: 'the product is not enrolled in the brain' }; continue }
      if (killWordsOf[lever]) { levers[lever] = { held: false, why: `stopped by a kill switch (${killWordsOf[lever]})` }; continue }
      // Under the live switch the gate refuses every automatic writer on a lock (AB-5); in shadow nothing enforces it.
      if (l.effective === 'LOCKED') { levers[lever] = { held: ceilingLive, why: ceilingLive ? l.why : `${l.why}, but NEXUS_BID_BRAIN_MODE is ${bidBrainMode()}: nothing refuses another writer there` }; continue }
      if (lever === 'bids') {
        levers[lever] = brainOwned.has(c.campaignId)
          ? { held: true, why: `the bid brain runs it (${modeOf.get(c.campaignId) ?? 'LIVE'})` }
          : { held: false, why: `the bid brain does not run it (${ceilingLive ? modeOf.get(c.campaignId) ?? 'not enrolled' : `NEXUS_BID_BRAIN_MODE is ${bidBrainMode()}`})` }
        continue
      }
      levers[lever] = { held: l.owned && ceilingLive, why: l.owned && !ceilingLive ? `${l.why}, but NEXUS_BID_BRAIN_MODE is ${bidBrainMode()}: the brain only plans` : l.why }
    }
    own.set(c.campaignId, { campaignId: c.campaignId, name: c.name, excluded: cs?.excluded.value ? `excluded by the Owner${cs.excluded.reason ? `: "${cs.excluded.reason}"` : ''}` : null, levers })
  }
  const shared = (campaigns?.shared ?? []).map((c) => ({ campaignId: c.campaignId, name: c.name }))
  const candidates = await loadCandidates({ market: m, root, family: new Set(family.members.map((x) => x.id)), own: new Set(ownIds), shared: new Set(shared.map((c) => c.campaignId)) })
  return { productId: root, name: product?.name ?? null, market: m, enrolled, readiness, own, shared, plan: planRetirement({ own, candidates }), retired: retiredRows.map(recordOf) }
}

// ── Retire ───────────────────────────────────────────────────────────────────────────────────────────────────────

export class RetireRefusal extends Error {}

export interface RetireRun { retired: Array<{ recordId: string; writer: RetireWriter; targetId: string; name: string; campaignIds: string[]; levers: string[] }> }

/**
 * Switch the planned rows off, as an approved request: the product ready, the plan the same as approved (`expectBasis`),
 * every row checked again in ONE transaction (still on, its configuration the one planned) — a row that moved stops the
 * whole run and nothing is switched off.
 */
export async function runRetirement(args: { productId: string; market: string; by: string; approvalId: string | null; expectBasis?: string | null }): Promise<RetireRun | { refusal: string }> {
  const facts = await loadRetireFacts(args.productId, args.market)
  if ('refusal' in facts) return facts
  if (!facts.readiness.ready) return { refusal: `the product is not ready for its writers to retire — ${facts.readiness.why}` }
  if (!facts.plan.retire.length) return { refusal: 'nothing to retire: no writer the brain replaces has a row of its own on this product\'s campaigns (ads-brain view retire lists what stays and why)' }
  if (args.expectBasis && args.expectBasis !== facts.plan.basis) return { refusal: 'what you approved changed since (a row the retirement switches off, or what it reaches, moved). Nothing changed: preview it again.' }
  try {
    const retired = await inDatabaseTransaction(prisma, async () => {
      const out: RetireRun['retired'] = []
      const byWriter = new Map<RetireWriter, PlannedRow[]>()
      for (const row of facts.plan.retire) byWriter.set(row.writer, [...(byWriter.get(row.writer) ?? []), row])
      for (const [writer, rows] of byWriter) {
        const now = await rowsNow(writer, rows.map((r) => r.id))
        for (const row of rows) {
          const n = now.get(row.id)
          if (!n || !n.enabled || n.fingerprint !== row.fingerprint) throw new RetireRefusal(`the ${WRITER_WORDS[writer]} "${row.name}" changed since it was planned. Nothing changed: preview it again.`)
          if ((await TABLES[writer].set(row.id, false)) !== 1) throw new RetireRefusal(`the ${WRITER_WORDS[writer]} "${row.name}" was switched off by someone else meanwhile. Nothing changed: preview it again.`)
          const after = (await rowsNow(writer, [row.id])).get(row.id)!
          const rec = await prisma.adsBrainRetirement.create({
            data: {
              productId: facts.productId, marketplace: facts.market, writer, targetId: row.id, targetName: row.name, campaignIds: row.campaignIds, levers: row.levers,
              before: { field: 'enabled', value: true, fingerprint: row.fingerprint }, after: { field: 'enabled', value: false, fingerprint: after.fingerprint },
              why: row.why.slice(0, 2_000), status: 'RETIRED', approvalId: args.approvalId, retiredBy: args.by,
            },
            select: { id: true },
          })
          out.push({ recordId: rec.id, writer, targetId: row.id, name: row.name, campaignIds: row.campaignIds, levers: row.levers })
        }
      }
      return out
    })
    logger.info('[ads-brain] retired the duplicate writers of a product', { productId: facts.productId, market: facts.market, rows: retired.length, by: args.by })
    return { retired }
  } catch (err) {
    if (err instanceof RetireRefusal) return { refusal: err.message }
    throw err
  }
}

// ── Give back ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface GiveBackResult { recordId: string; writer: string; targetId: string; name: string; act: GiveBackAct; why: string }

const STATUS_OF: Record<GiveBackAct, 'GIVEN_BACK' | 'LEFT' | 'GONE'> = { switchOn: 'GIVEN_BACK', already: 'GIVEN_BACK', left: 'LEFT', gone: 'GONE' }

/** What a give-back of these records would do now (a preview), without changing anything. */
export async function giveBackPreview(records: readonly RetirementRecord[]): Promise<GiveBackResult[]> {
  const out: GiveBackResult[] = []
  for (const writer of new Set(records.map((r) => r.writer))) {
    const mine = records.filter((r) => r.writer === writer)
    const now = isRetireWriter(writer) ? await rowsNow(writer, mine.map((r) => r.targetId)) : new Map()
    for (const r of mine) {
      const n = now.get(r.targetId)
      const d = giveBackDecision(r.retiredAt, r.left, n ? { enabled: n.enabled, fingerprint: n.fingerprint } : null)
      out.push({ recordId: r.id, writer: r.writer, targetId: r.targetId, name: r.targetName, ...d })
    }
  }
  return out
}

/**
 * Switch the retired rows of a product back on (all of them, or `recordIds`): each only while nobody changed it since (else
 * LEFT, his edit wins); each record closed with who, when and why. One transaction per row: one that fails leaves the others.
 */
export async function giveBackRetirements(args: { productId: string; market: string; by: string; why: string; recordIds?: readonly string[] | null }): Promise<GiveBackResult[]> {
  const m = strategyMarket(args.market) ?? args.market
  const rows = await prisma.adsBrainRetirement.findMany({
    where: { productId: args.productId, marketplace: m, status: 'RETIRED', ...(args.recordIds?.length ? { id: { in: [...args.recordIds] } } : {}) },
    select: RECORD_SELECT, orderBy: [{ retiredAt: 'asc' }, { id: 'asc' }],
  })
  const out: GiveBackResult[] = []
  for (const rec of rows.map(recordOf)) {
    try {
      const result = await inDatabaseTransaction(prisma, async () => {
        const now = isRetireWriter(rec.writer) ? (await rowsNow(rec.writer, [rec.targetId])).get(rec.targetId) ?? null : null
        let d = giveBackDecision(rec.retiredAt, rec.left, now ? { enabled: now.enabled, fingerprint: now.fingerprint } : null)
        if (d.act === 'switchOn' && (await TABLES[rec.writer as RetireWriter].set(rec.targetId, true)) !== 1) d = { act: 'already', why: 'it was on again already' }
        // Only a record still RETIRED is closed: two give-backs at once close it once.
        const closed = await prisma.adsBrainRetirement.updateMany({
          where: { id: rec.id, status: 'RETIRED' },
          data: { status: STATUS_OF[d.act], givenBackAt: new Date(), givenBackBy: args.by, givenBackWhy: `${args.why} — ${d.why}`.slice(0, 2_000) },
        })
        return closed.count ? { recordId: rec.id, writer: rec.writer, targetId: rec.targetId, name: rec.targetName, ...d } : null
      })
      if (result) out.push(result)
    } catch (err) {
      logger.error('[ads-brain] a retired row could not be given back — tried again at the next tick', { recordId: rec.id, writer: rec.writer, targetId: rec.targetId, error: msg(err) })
    }
  }
  if (out.length) logger.info('[ads-brain] gave back retired writers of a product', { productId: args.productId, market: m, by: args.by, rows: out.map((r) => `${r.writer}:${r.targetId}:${r.act}`) })
  return out
}

/**
 * The records whose retirement no longer holds, with why: every one when the product is not ready, else each whose own
 * reach broke (a campaign no longer the product's own, a lever the brain no longer holds there, a campaign excluded). Pure.
 */
export function brokenRetirements(facts: Pick<RetireFacts, 'readiness' | 'own' | 'retired'>): Array<{ record: RetirementRecord; why: string }> {
  if (!facts.readiness.ready) return facts.retired.map((record) => ({ record, why: `the product is no longer ready: ${facts.readiness.blockers[0] ?? facts.readiness.why}` }))
  const out: Array<{ record: RetirementRecord; why: string }> = []
  for (const record of facts.retired) {
    const gone = record.campaignIds.filter((id) => !facts.own.has(id))
    if (gone.length) { out.push({ record, why: `campaign ${gone[0]} is no longer this product's own` }); continue }
    const excluded = record.campaignIds.map((id) => facts.own.get(id)!).find((c) => c.excluded)
    if (excluded) { out.push({ record, why: `campaign "${excluded.name}" is out of the brain now (${excluded.excluded})` }); continue }
    let why: string | null = null
    for (const id of record.campaignIds) {
      const c = facts.own.get(id)!
      const lever = record.levers.find((l) => !c.levers[l as BrainLever]?.held)
      if (lever) { why = `the brain no longer holds the ${lever} lever of "${c.name}" (${c.levers[lever as BrainLever]?.why ?? 'not read'})`; break }
    }
    if (why) out.push({ record, why })
  }
  return out
}

/** Give back what no longer holds for one product (after a change of the Owner's, and at every tick). */
export async function giveBackWhatBroke(productId: string, market: string, by: string): Promise<GiveBackResult[]> {
  const m = strategyMarket(market) ?? market
  // Cheap first: nothing retired for the product, nothing to read.
  if (!(await prisma.adsBrainRetirement.count({ where: { productId, marketplace: m, status: 'RETIRED' } }))) return []
  const facts = await loadRetireFacts(productId, m)
  if ('refusal' in facts) {
    // The product is gone (or has no single family): nothing can be checked, every row goes back.
    return giveBackRetirements({ productId, market: m, by, why: `the product can no longer be read (${facts.refusal})` })
  }
  const broken = brokenRetirements(facts)
  const out: GiveBackResult[] = []
  for (const why of new Set(broken.map((b) => b.why))) {
    out.push(...await giveBackRetirements({ productId: facts.productId, market: m, by, why, recordIds: broken.filter((b) => b.why === why).map((b) => b.record.id) }))
  }
  return out
}

// ── The brain's own request ──────────────────────────────────────────────────────────────────────────────────────

/** A retirement request for this product × market that still waits, else the newest one a person declined recently. */
async function requestsOf(productId: string, market: string, now: Date) {
  const where = (status: string[]) => ({
    toolName: RETIRE_TOOL, status: { in: status },
    AND: [{ args: { path: ['op'], equals: 'retire' } }, { args: { path: ['productId'], equals: productId } }, { args: { path: ['market'], equals: market } }],
  })
  const [open, declined] = await Promise.all([
    prisma.agentApproval.findFirst({ where: where(OPEN_APPROVAL), select: { id: true, status: true, requestedAt: true }, orderBy: { requestedAt: 'desc' } }),
    prisma.agentApproval.findFirst({ where: { ...where(['rejected', 'expired']), requestedAt: { gte: new Date(now.getTime() - ASK_AGAIN_AFTER_DAYS * DAY_MS) } }, select: { id: true, status: true, requestedAt: true, decidedAt: true }, orderBy: { requestedAt: 'desc' } }),
  ])
  return { open, declined }
}

/** Ask a person to approve the retirement of one product's duplicate writers (through the normal gate, never by rule). */
async function askRetirement(productId: string, market: string, why: string): Promise<{ approvalId: string } | { error: string }> {
  const { runOrQueueTool } = await import('../../agents/approval-gate.service.js')
  const { systemPrincipal } = await import('../../agents/call-tool.js')
  const args = { op: 'retire', productId, market, why: why.slice(0, 300) }
  const run = await prisma.agentRun.create({ data: { agentKey: 'ads-brain-retire', trigger: 'schedule', status: 'running', input: { tool: RETIRE_TOOL, args } as Prisma.InputJsonValue } })
  const asked = await runOrQueueTool(RETIRE_TOOL, args, systemPrincipal(RETIRE_ASKER), run.id, { forceAsk: true })
  const queued = asked.mode === 'queued' && !!asked.approvalId
  await prisma.agentRun.update({
    where: { id: run.id },
    data: queued ? { status: 'done', ok: true, endedAt: new Date(), output: { mode: 'queued', approvalId: asked.approvalId ?? null } } : { status: 'failed', ok: false, endedAt: new Date(), errorMessage: asked.error ?? null },
  })
  return queued ? { approvalId: asked.approvalId! } : { error: asked.error ?? 'the request was not queued' }
}

// ── The tick ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RetireTickSummary {
  /** Product × markets with a retired row, checked. */
  checked: number
  gaveBack: Array<{ productId: string; market: string; rows: Array<{ writer: string; targetId: string; act: GiveBackAct }> }>
  asked: Array<{ productId: string; market: string; approvalId: string | null; rows: number; error?: string }>
  /** Ready products with rows to retire the brain did not ask for, and why (the switch off, a request waits, declined). */
  wouldAsk: Array<{ productId: string; market: string; rows: number; why: string }>
  failed: Array<{ productId: string; market: string; why: string }>
}

/**
 * One tick in the business the caller is in: give back what no longer holds for every product with a retired row; and,
 * when `scan` (once an hour), find the ready products with rows to retire — asked for under NEXUS_ADS_BRAIN_RETIRE=ask,
 * else only counted. Nothing retired and nothing enrolled: one or two cheap queries.
 */
export async function runRetireTick(opts: { now?: Date; scan?: boolean; by?: string } = {}): Promise<RetireTickSummary> {
  const now = opts.now ?? new Date()
  const out: RetireTickSummary = { checked: 0, gaveBack: [], asked: [], wouldAsk: [], failed: [] }
  const groups = await prisma.adsBrainRetirement.groupBy({ by: ['productId', 'marketplace'], where: { status: 'RETIRED' } })
  for (const g of groups) {
    out.checked++
    try {
      const rows = await giveBackWhatBroke(g.productId, g.marketplace, opts.by ?? RETIRE_ACTOR)
      if (rows.length) out.gaveBack.push({ productId: g.productId, market: g.marketplace, rows: rows.map((r) => ({ writer: r.writer, targetId: r.targetId, act: r.act })) })
    } catch (err) {
      logger.error('[ads-brain] the retirement check of a product failed — tried again at the next tick', { productId: g.productId, market: g.marketplace, error: msg(err) })
      out.failed.push({ productId: g.productId, market: g.marketplace, why: msg(err) })
    }
  }
  if (!opts.scan) return out
  const mode = retireAskMode()
  const enrollments = await prisma.adsBrainEnrollment.findMany({ select: { productId: true, marketplace: true }, orderBy: [{ marketplace: 'asc' }, { productId: 'asc' }] })
  for (const e of enrollments) {
    try {
      const facts = await loadRetireFacts(e.productId, e.marketplace)
      if ('refusal' in facts || !facts.readiness.ready || !facts.plan.retire.length) continue
      const rows = facts.plan.retire.length
      const { open, declined } = await requestsOf(facts.productId, facts.market, now)
      if (open) { out.wouldAsk.push({ productId: facts.productId, market: facts.market, rows, why: `a request waits for a person (${open.id})` }); continue }
      if (declined) { out.wouldAsk.push({ productId: facts.productId, market: facts.market, rows, why: `a person ${declined.status === 'expired' ? 'let the last request expire' : 'declined the last request'} (${declined.requestedAt.toISOString().slice(0, 10)}): asked again after ${ASK_AGAIN_AFTER_DAYS} days` }); continue }
      if (mode !== 'ask') { out.wouldAsk.push({ productId: facts.productId, market: facts.market, rows, why: 'NEXUS_ADS_BRAIN_RETIRE is off: the brain asks nothing by itself (retire-ads-writers asks for it)' }); continue }
      const why = `Every lever of ${facts.name ?? facts.productId} in ${facts.market} is AUTO or your own choice: ${rows} configuration row${rows === 1 ? '' : 's'} of writers the brain replaces on its own campaigns can be switched off (never deleted; given back if the product leaves the brain or a lever goes back from AUTO).`
      const asked = await askRetirement(facts.productId, facts.market, why)
      out.asked.push({ productId: facts.productId, market: facts.market, rows, approvalId: 'approvalId' in asked ? asked.approvalId : null, ...('error' in asked ? { error: asked.error } : {}) })
    } catch (err) {
      logger.error('[ads-brain] the retirement scan of a product failed', { productId: e.productId, market: e.marketplace, error: msg(err) })
      out.failed.push({ productId: e.productId, market: e.marketplace, why: msg(err) })
    }
  }
  return out
}

/** The tick in one line (the cron's record). */
export function retireTickLine(s: RetireTickSummary): string {
  const back = s.gaveBack.map((g) => `${g.market} ${g.productId} gave back ${g.rows.map((r) => `${r.writer}:${r.act}`).join(',')}`)
  const asked = s.asked.map((a) => `${a.market} ${a.productId} asked (${a.rows} rows${a.approvalId ? `, ${a.approvalId}` : `: ${a.error}`})`)
  const would = s.wouldAsk.map((w) => `${w.market} ${w.productId} ready (${w.rows} rows): ${w.why}`)
  const failed = s.failed.map((f) => `${f.market} ${f.productId} failed: ${f.why}`)
  return `RETIRE checked=${s.checked}${[...back, ...asked, ...would, ...failed].length ? ` · ${[...back, ...asked, ...would, ...failed].join(' · ')}` : ''}`
}

// ── The view ─────────────────────────────────────────────────────────────────────────────────────────────────────

const rowView = (r: PlannedRow) => ({ writer: r.writer, what: WRITER_WORDS[r.writer], id: r.id, name: r.name, setUp: r.scope, levers: r.levers, campaigns: r.campaignIds, why: r.why })

/**
 * View retire (ads-brain): with productId, whether the product is ready, exactly which rows a retirement switches off and
 * which stay (each with why), the writers with no row of their own, what is retired now (and what a give-back would do with
 * each), the history of 30 days and the request that waits. With market alone, every enrolled product there in one line.
 */
export async function brainRetire(args: { market?: string; productId?: string }): Promise<{ data: unknown } | { error: string }> {
  const m = args.market ? strategyMarket(args.market) : null
  if (!m) return { error: 'view retire needs market (one Amazon market code, business-overview)' }
  const now = new Date()
  if (!args.productId) {
    const enrollments = await prisma.adsBrainEnrollment.findMany({ where: { marketplace: m }, select: { productId: true }, orderBy: { productId: 'asc' }, take: 100 })
    const products = []
    for (const e of enrollments) {
      const facts = await loadRetireFacts(e.productId, m)
      if ('refusal' in facts) { products.push({ productId: e.productId, error: facts.refusal }); continue }
      products.push({ productId: facts.productId, name: facts.name, ready: facts.readiness.ready, why: facts.readiness.why, toRetire: facts.plan.retire.length, stays: facts.plan.keep.length, retiredNow: facts.retired.length })
    }
    return { data: { market: m, products, note: products.length ? 'Name one productId for the rows and the request.' : 'No product is enrolled in the brain in this market: nothing retires.' } }
  }
  const facts = await loadRetireFacts(args.productId, m)
  if ('refusal' in facts) return { error: facts.refusal }
  const [history, requests, giveBack] = await Promise.all([
    prisma.adsBrainRetirement.findMany({ where: { productId: facts.productId, marketplace: m, status: { not: 'RETIRED' }, givenBackAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } }, select: RECORD_SELECT, orderBy: { givenBackAt: 'desc' }, take: 50 }),
    requestsOf(facts.productId, m, now),
    giveBackPreview(facts.retired),
  ])
  const back = new Map(giveBack.map((g) => [g.recordId, g]))
  return {
    data: {
      productId: facts.productId, name: facts.name, market: m, enrolled: facts.enrolled,
      ready: facts.readiness.ready, why: facts.readiness.why, blockers: facts.readiness.blockers, levers: facts.readiness.levers,
      // Exactly what op retire switches off — only once the product is ready; before that, what it would switch off then.
      ...(facts.readiness.ready ? { switchesOff: facts.plan.retire.map(rowView) } : { wouldSwitchOffOnceReady: facts.plan.retire.map(rowView) }),
      stays: facts.plan.keep.map(rowView),
      noRowOfTheirOwn: facts.plan.rowless.map((w) => ({ writer: w.writer, levers: w.levers, why: w.why })),
      basis: facts.plan.basis,
      retiredNow: facts.retired.map((r) => ({ recordId: r.id, writer: r.writer, id: r.targetId, name: r.targetName, campaigns: r.campaignIds, levers: r.levers, why: r.why, retiredAt: r.retiredAt, retiredBy: r.retiredBy, approvalId: r.approvalId, giveBackWould: back.get(r.id) ? { act: back.get(r.id)!.act, why: back.get(r.id)!.why } : null })),
      history: history.map(recordOf).map((r) => ({ recordId: r.id, writer: r.writer, id: r.targetId, name: r.targetName, status: r.status, retiredAt: r.retiredAt, givenBackAt: r.givenBackAt, givenBackBy: r.givenBackBy, why: r.givenBackWhy })),
      request: requests.open ? { approvalId: requests.open.id, status: requests.open.status, requestedAt: requests.open.requestedAt.toISOString() } : null,
      ...(requests.declined ? { lastDeclined: { approvalId: requests.declined.id, status: requests.declined.status, requestedAt: requests.declined.requestedAt.toISOString() } } : {}),
      sharedCampaigns: facts.shared,
      how: 'retire-ads-writers op retire asks a person to switch the rows above off (never deleted); op give-back switches them on again. Leaving the brain, a lever going back from AUTO (the rows that write it), a kill switch (the rows of its lever) or the server switch leaving live gives them back by itself — at once after set-ads-brain or set-brain-kill-switch, else within 15 minutes.',
      brainAsks: retireAskMode() === 'ask' ? 'the brain asks once by itself when the product is ready (NEXUS_ADS_BRAIN_RETIRE=ask)' : 'the brain asks nothing by itself (NEXUS_ADS_BRAIN_RETIRE is off): a person or Claude asks with the tool',
    },
  }
}
