/**
 * HARVEST ENGINE — the harvest rules for the Keyword Harvest page's Rules view (GET /api/advertising/harvest/rules …), in
 * the Bid page's row shape (bid-rules/read.ts BidRuleRow) so one rules table and one rule editor serve both pages:
 *
 *   rows     every harvest rule (harvest_and_negate, promote_to_exact, the builder's keyword-harvesting) of the business,
 *            the brain first as the pseudo-row `id: 'brain'`; its honest mode (what the Owner set, what really acts and
 *            what holds it), its scope (the evaluator's own matcher), what it harvested in 7 days, its runs and asks.
 *   D2       (Owner 2026-10-10) a harvest rule may run on Auto, inside its caps (ads-graduation.ts: the harvest family's
 *            ceiling is Auto; HARVEST_RULE_CAPS: new keywords a day, only the product's own campaigns, never a new
 *            campaign): `mode.autoLocked` says why Auto cannot be picked yet (the graduation gate's days and runs), and
 *            `mode.heldBy` the cap of the day once it is used.
 *   writes   archive / unarchive (inert and out of every list, reversible), the mode of many rules at once (the level
 *            dial's own path: setAdsRuleLevel, its ceiling and gate). The brain's harvest level is set per product.
 */
import prisma from '../../../db.js'
import { notCapRefusal } from '../../automation-cap-predicate.js'
import { resolveAutonomy, type AutonomyLevel } from '../ads-autonomy.js'
import { graduationCeiling, HARVEST_RULE_CAPS } from '../ads-graduation.js'
import { producedActionTypes } from '../ads-rule-adapter.service.js'
import type { ReachRule } from '../ads-rule-reach.service.js'
import { ruleStoredSchedule } from '../ads-rule-schedule.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import type { AdsActor } from '../ads-mutation.service.js'
import { gateFacts, RefBook, splitCampaigns, type BidRuleRow, type BidRulesTotals } from '../bid-rules/read.js'
import { autoGateHold, HOLDS, MODE_OF_LEVEL, modeActs, ruleMode, ruleRunTimes, scheduleWords, utcDay, type AccountPosture, type BidRuleMode, type Hold } from '../bid-rules/pure.js'
import { harvestCeiling } from '../brain/harvest-load.js'
import { GRADUATION_GATE } from '../ads-rule-crud.service.js'
import { ARCHIVED_ADS_DOMAIN, harvestAutoConfirmed, harvestRulesReach, isHarvestRule, PICK_AUTO_AGAIN } from './rule-reach.js'
import { settledBounds } from '../ads-settled-window.js'
import { termKey } from '../brain/terms.js'
import { harvestHistory, type HistoryRow } from './history.js'
import type { Hold as PlanHold } from './plan.js'
import { productRef, type Ref } from './ids.js'

export const BRAIN_ROW_ID = 'brain'
const DAY = 86_400_000
const WEEK_DAYS = 7
const OPEN = ['pending', 'scheduled', 'approved', 'executing']

/** S11 — the brain row's scope also names the products it runs (`scope.products`). */
export type HarvestRuleRow = BidRuleRow & { scope: BidRuleRow['scope'] & { products?: Ref[] } }

/**
 * The rule's OWN numbers (they may only narrow the ONE bar, never loosen it): an engine rule's `minOrders` over its
 * `windowDays` (its `minSpendCents` is the waste threshold of its blocking half, not a harvest number); a builder rule's
 * Orders ≥ and ACoS ≤ over its lookback. Null: the rule sets none (the bar alone). Pure.
 */
export function ownNumbersOf(actions: unknown, conditions: unknown): { minOrders: number | null; maxAcosPct: number | null; windowDays: number } | null {
  const a0 = (Array.isArray(actions) ? actions[0] : null) as Record<string, unknown> | null
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null)
  if (a0?.type === 'harvest_and_negate') {
    const own = ['minOrders', 'minSpendCents', 'windowDays'].some((k) => typeof a0[k] === 'number')
    return own ? { minOrders: n(a0.minOrders), maxAcosPct: null, windowDays: n(a0.windowDays) ?? 60 } : null
  }
  if (a0?.type === 'keyword-harvesting') {
    const g = (Array.isArray(conditions) ? conditions[0] : null) as { lookback?: unknown; conditions?: Array<{ metric?: unknown; op?: unknown; value?: unknown }> } | null
    const conds = g?.conditions ?? []
    const orders = conds.find((c) => (c.metric === 'PPC Orders' || c.metric === 'Orders') && c.op === 'gte')
    const acos = conds.find((c) => c.metric === 'ACOS' && c.op === 'lte')
    if (!orders && !acos) return null
    const days = /(\d+)/.exec(String(g?.lookback ?? ''))
    return { minOrders: n(orders?.value), maxAcosPct: n(acos?.value), windowDays: days ? Number(days[1]) : 30 }
  }
  return null
}
/**
 * M6 — counted like the Bid page: the rules only; the brain (listed first) has its own field. acting / auto / asking /
 * held are the harvest list's own (Claude's harvest-rules read; `held` = the Rules view's Held back tile).
 */
export type HarvestRulesTotals = BidRulesTotals & {
  acting: number; auto: number; asking: number; held: number
  brain: { set: string; acts: string; waiting: number }
}

const RULE_SELECT = {
  id: true, name: true, domain: true, trigger: true, enabled: true, dryRun: true, autonomyLevel: true, conditions: true, actions: true,
  maxExecutionsPerDay: true, maxWritesPerDay: true, maxValueCentsEur: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
  evaluationCount: true, matchCount: true, lastEvaluatedAt: true, createdAt: true,
} as const
type RuleRecord = Awaited<ReturnType<typeof loadRules>>[number]

async function loadRules() {
  return (await prisma.automationRule.findMany({ where: { domain: { in: ['advertising', ARCHIVED_ADS_DOMAIN] } }, select: RULE_SELECT, orderBy: [{ name: 'asc' }] })).filter((r) => isHarvestRule(r.actions))
}

const normMarket = (m: string | null | undefined) => {
  const raw = (m ?? '').trim()
  return !raw || raw.toLowerCase() === 'all' ? null : strategyMarket(raw)
}

async function accountPosture(): Promise<AccountPosture> {
  const { getAutomationState } = await import('../ads-automation-state.service.js')
  const s = await getAutomationState()
  return { autonomy: s.autonomy, halted: s.halted, killed: process.env.NEXUS_ADS_AUTOMATION_KILL === '1', degraded: s.degraded }
}
const adsLive = () => (process.env.NEXUS_AMAZON_ADS_MODE ?? 'sandbox') === 'live'

/** The rule in one line: "If orders ≥ 2 over 60 d → exact keyword, block the source". Pure. */
export function harvestSentence(r: { actions?: unknown; conditions?: unknown }): string {
  const actions = (Array.isArray(r.actions) ? r.actions : []) as Array<Record<string, unknown>>
  const a = actions.find((x) => isHarvestRule([x])) ?? actions[0] ?? {}
  const type = String(a.type ?? '')
  const n = (k: string) => (a[k] != null && Number.isFinite(Number(a[k])) ? Number(a[k]) : null)
  const orders = n('minOrders') ?? n('orders')
  const days = n('lookbackDays') ?? n('windowDays')
  const when = orders != null ? `If orders ≥ ${orders}${days ? ` over ${days} d` : ''}` : 'If a term converts'
  const then = type === 'harvest_and_negate' ? 'keyword + block the source' : type === 'promote_to_exact' ? 'exact keyword' : 'harvest by its mapping'
  return `${when} → ${then}`
}

/** Today's (UTC) keywords a rule created: its harvest records (the engine) and its keyword creates (its actor). */
async function harvestedToday(ruleIds: string[], now: Date): Promise<Map<string, number>> {
  if (!ruleIds.length) return new Map()
  const since = utcDay(now)
  const rows = await prisma.advertisingActionLog.groupBy({
    by: ['userId'],
    where: { userId: { in: ruleIds.flatMap((id) => [`automation:${id}`, `automation:automation:${id}`]) }, entityType: 'AD_TARGET', actionType: { in: ['create_keyword', 'AD_TARGET_CREATE', 'create_target'] }, createdAt: { gte: since } },
    _count: { _all: true },
  })
  const out = new Map<string, number>()
  for (const r of rows) {
    const id = String(r.userId).replace(/^(automation:)+/, '')
    out.set(id, (out.get(id) ?? 0) + r._count._all)
  }
  return out
}

/** GET /rules — every harvest rule (the brain first), its honest mode, scope and week. */
export async function listHarvestRules(q: { market?: string | null }, opts: { now?: Date } = {}): Promise<{ market: string | null; rules: HarvestRuleRow[]; totals: HarvestRulesTotals }> {
  const now = opts.now ?? new Date()
  const market = normMarket(q.market)
  const weekAgo = new Date(now.getTime() - WEEK_DAYS * DAY)
  const all = await loadRules()
  const inMarket = (r: RuleRecord) => !market || !r.scopeMarketplace || normMarket(r.scopeMarketplace) === market
  const rules = all.filter(inMarket)
  const otherMarkets = all.filter((r) => !inMarket(r) && r.domain !== ARCHIVED_ADS_DOMAIN).length
  const ids = rules.map((r) => r.id)
  const [posture, reached, runs, asks, applied, waiting, today, writes, protections] = await Promise.all([
    accountPosture(),
    harvestRulesReach(rules as unknown as ReachRule[]),
    ids.length ? prisma.automationRuleExecution.findMany({ where: { ruleId: { in: ids }, startedAt: { gte: weekAgo }, ...notCapRefusal() }, select: { ruleId: true, startedAt: true } }) : Promise.resolve([]),
    ids.length ? prisma.adsRuleSuggestion.groupBy({ by: ['ruleId'], where: { ruleId: { in: ids }, createdAt: { gte: weekAgo } }, _count: { _all: true } }) : Promise.resolve([]),
    ids.length ? prisma.adsRuleSuggestion.groupBy({ by: ['ruleId'], where: { ruleId: { in: ids }, status: 'applied', decidedAt: { gte: weekAgo } }, _count: { _all: true } }) : Promise.resolve([]),
    ids.length ? prisma.adsRuleSuggestion.groupBy({ by: ['ruleId'], where: { ruleId: { in: ids }, status: 'pending' }, _count: { _all: true } }) : Promise.resolve([]),
    harvestedToday(ids, now),
    ids.length ? prisma.advertisingActionLog.findMany({ where: { userId: { in: ids.flatMap((id) => [`automation:${id}`, `automation:automation:${id}`]) }, createdAt: { gte: weekAgo } }, select: { userId: true, entityType: true, entityId: true, amazonResponseStatus: true } }) : Promise.resolve([]),
    prisma.adKeywordProtection.count({ where: { mode: 'WHITELIST' } }),
  ])
  const count = (rows: Array<{ ruleId: string; _count: { _all: number } }>) => new Map(rows.map((r) => [r.ruleId, r._count._all]))
  const asksBy = count(asks as never)
  const appliedBy = count(applied as never)
  const waitingBy = count(waiting as never)
  const ticks = new Map<string, Set<number>>()
  for (const r of runs) ticks.set(r.ruleId, (ticks.get(r.ruleId) ?? new Set()).add(Math.floor(r.startedAt.getTime() / (15 * 60_000))))
  // A builder rule bound by its mapping reaches the campaigns of the ad groups it names, never the whole market.
  const reachOf = new Map<string, string[]>()
  const groupsOf = new Map<string, string[] | null>()
  for (const r of rules) {
    const got = reached.get(r.id)
    const ids = (got?.campaigns ?? []).filter((c) => c.status !== 'ARCHIVED' && (!market || strategyMarket(c.marketplace) === market)).map((c) => c.id)
    reachOf.set(r.id, ids)
    const keep = new Set(ids)
    groupsOf.set(r.id, got?.adGroups ? got.adGroups.filter((g) => keep.has(got.campaignOf.get(g) ?? '')) : null)
  }
  const book = new RefBook()
  await book.load({ campaigns: [...reachOf.values()].flat(), adGroups: [...groupsOf.values()].flatMap((g) => g ?? []), targets: writes.filter((w) => w.entityType === 'AD_TARGET').map((w) => w.entityId), portfolios: rules.map((r) => r.scopePortfolioId ?? '') })
  const gate = await gateFacts(book)
  const { adsRuleLevelRefusal } = await import('../ads-rule-crud.service.js')
  const { isRefused } = await import('../../automation/service-outcome.js')

  const rows: HarvestRuleRow[] = []
  for (const r of rules) {
    const archived = r.domain === ARCHIVED_ADS_DOMAIN
    const level = resolveAutonomy(r) as AutonomyLevel
    const reach = reachOf.get(r.id) ?? []
    // Re-review (Low) — the ceiling read from the rule's own actions too (a rule that also blocks waste asks), as at run time.
    const ceiling = graduationCeiling({ actionTypes: producedActionTypes(r), hasKeywordProtections: protections > 0, actions: r.actions })
    let autoGate: Hold | null = null
    if (!archived && level !== 'AUTO') {
      const ageDays = Math.floor((now.getTime() - r.createdAt.getTime()) / DAY)
      const local = ceiling.maxLevel !== 'AUTO' ? { error: 'above_ceiling', blockedBy: ceiling.blockedBy }
        : !r.enabled ? { error: 'gate_not_open', failures: ['RULE_ENABLED'] }
          : ageDays < GRADUATION_GATE.observationDays ? { error: 'gate_not_open', failures: ['OBSERVATION_WINDOW'] }
            : r.evaluationCount < GRADUATION_GATE.evaluations ? { error: 'gate_not_open', failures: ['HAS_EVALUATIONS'] }
              : r.matchCount < GRADUATION_GATE.matches ? { error: 'gate_not_open', failures: ['HAS_MATCHES'] } : null
      let refusal: { error?: unknown; failures?: unknown; blockedBy?: unknown } | null = local
      if (!refusal) { const asked = await adsRuleLevelRefusal(r.id, 'AUTO'); refusal = isRefused(asked) ? asked.body as typeof refusal : null }
      autoGate = autoHoldOf(refusal, r)
      // The negation precondition (a whitelist first) reads as its own words, not "always asks".
      if (autoGate && ceiling.maxLevel !== 'AUTO' && /whitelist/.test(ceiling.reason)) autoGate = { kind: 'graduation', label: 'Protected terms first', reason: 'Add protected terms first: a harvest blocks its source, and nothing may ever block a protected term.' }
    }
    const capHit = (today.get(r.id) ?? 0) >= HARVEST_RULE_CAPS.keywordsPerDay
    const mode: BidRuleMode = ruleMode({
      level, archived, account: posture, adsLive: adsLive(), ceiling: ceiling.maxLevel, ceilingBlockedBy: ceiling.blockedBy, manualBelt: (Array.isArray(r.actions) ? (r.actions[0] as { control?: unknown } | undefined) : undefined)?.control === 'manual',
      matchesCapHit: false, writeCapHit: capHit, valueCapZero: false, caps: { writesPerDay: HARVEST_RULE_CAPS.keywordsPerDay },
      campaigns: splitCampaigns(reach, book, gate), autoGate,
    })
    // The cap's words are about keywords (a harvest rule's day), not changes.
    if (mode.heldBy?.label === 'Change limit reached') mode.heldBy = HOLDS.dailyCap(HARVEST_RULE_CAPS.keywordsPerDay)
    // L1 (HCORE review) — set to Auto with no protected terms: say the real reason (D2's precondition), not "always asks".
    if (mode.heldBy?.label === 'Always asks' && ceiling.maxLevel !== 'AUTO' && /whitelist|protected terms/i.test(ceiling.reason)) {
      mode.heldBy = { kind: 'graduation', label: 'Protected terms first', reason: 'Add protected terms first: a harvest blocks its source, and nothing may ever block a protected term. Until then it asks.' }
    }
    // Release safety — at Auto only through the harvest path's own pick: a harvest rule whose Auto was saved any other way
    // (every rule saved before this release) asks, and says how to let it act.
    if (!archived && level === 'AUTO' && ceiling.maxLevel === 'AUTO' && !harvestAutoConfirmed(r.actions)
      && graduationCeiling({ actionTypes: producedActionTypes(r), hasKeywordProtections: false, actions: r.actions }).maxLevel !== 'AUTO') {
      if (mode.acts === 'AUTO') mode.acts = 'ASK'
      // What a new pick of Auto would meet: the same gate as a fresh Auto pick — said up front when it would refuse.
      const gate = await markGateRefusal(r.id)
      const blocked = gate ? autoHoldOf(gate, r) : null
      const hold = blocked ?? { ...PICK_AUTO_AGAIN, reason: `Pick Auto again to let it act: until then it ${mode.acts === 'WATCH' ? 'only watches' : mode.acts === 'OFF' ? 'does nothing' : 'asks'}.` }
      if (mode.heldBy && mode.heldBy.label !== hold.label) mode.also = [mode.heldBy, ...(mode.also ?? [])]
      mode.heldBy = hold
      if (blocked) mode.autoLocked = blocked
    }
    // Functional walk — Auto that cannot be picked is said before the click, from Off too (the Bid rows leave it out at Off).
    if (!archived && mode.set === 'OFF' && autoGate) mode.autoLocked = autoGate
    const mapped = groupsOf.get(r.id) ?? null
    const scope = book.refSet(reach, mapped ?? [])
    const schedule = ruleStoredSchedule(r.actions)
    const runsAt = modeActs(mode) ? ruleRunTimes(schedule, r.lastEvaluatedAt, now) : { nextRunAt: null, firstRunAt: null, thenRunAt: null }
    const mine = writes.filter((w) => String(w.userId).replace(/^(automation:)+/, '') === r.id)
    const landed = mine.filter((w) => !['FAILED', 'SKIPPED', 'CANCELLED', 'SUPERSEDED'].includes(String(w.amazonResponseStatus ?? '')))
    const keywordIds = landed.filter((w) => w.entityType === 'AD_TARGET').map((w) => w.entityId)
    const changed = book.refSet(keywordIds.map((id) => book.campaignOfTarget(id)).filter((x): x is string => !!x), keywordIds.map((id) => book.targets.get(id)?.adGroupId).filter((x): x is string => !!x))
    rows.push({
      id: r.id, kind: 'rule', name: r.name, sentence: harvestSentence(r), market: normMarket(r.scopeMarketplace), mode,
      scope: { ...scope, all: !r.scopeCampaignId && !r.scopePortfolioId && !mapped && !r.scopeProductId, product: r.scopeProductId ? { id: r.scopeProductId, name: r.scopeProductId, href: `/products/${encodeURIComponent(r.scopeProductId)}` } : null },
      changed7d: { ...changed, bids: 0, keywords: new Set(keywordIds).size },
      last7d: { runs: ticks.get(r.id)?.size ?? 0, asks: asksBy.get(r.id) ?? 0, applied: appliedBy.get(r.id) ?? 0, written: landed.length, brainInputs: 0, refused: mine.length - landed.length },
      waiting: archived ? 0 : waitingBy.get(r.id) ?? 0,
      lastRunAt: r.lastEvaluatedAt?.toISOString() ?? null,
      nextRunAt: runsAt.nextRunAt?.toISOString() ?? null, firstRunAt: runsAt.firstRunAt?.toISOString() ?? null, thenRunAt: runsAt.thenRunAt?.toISOString() ?? null,
      schedule: scheduleWords(schedule), effect: null, archived,
    })
  }
  const productIds = [...new Set(rows.map((r) => r.scope.product?.id).filter((x): x is string => !!x))]
  if (productIds.length) {
    const named = new Map((await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true, name: true } })).map((p) => [p.id, p.sku || p.name || p.id]))
    for (const row of rows) if (row.scope.product) row.scope.product.name = named.get(row.scope.product.id) ?? row.scope.product.id
  }
  const brain = await brainRow({ market, now, posture, book })
  const active = rows.filter((r) => !r.archived)
  // M6 — the Bid page's convention: the counts are the rules'; the brain row is shown first, counted in its own field.
  const totals: HarvestRulesTotals = {
    rules: active.length, on: active.filter((r) => r.mode.set !== 'OFF').length, acting: active.filter((r) => modeActs(r.mode)).length,
    auto: active.filter((r) => r.mode.acts === 'AUTO').length, asking: active.filter((r) => r.mode.acts === 'ASK').length,
    held: active.filter((r) => r.mode.heldBy != null).length, waiting: active.reduce((n, r) => n + r.waiting, 0),
    bidsChanged7d: 0, clashes: 0, archived: rows.length - active.length, otherMarkets,
    brain: { set: brain.mode.set, acts: brain.mode.acts, waiting: brain.waiting },
  }
  const order = (r: HarvestRuleRow) => (r.archived ? 2 : r.mode.set === 'OFF' ? 1 : 0)
  return { market, rules: [brain, ...rows.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))], totals }
}

/** The brain's harvest mode in a market (all markets: null): the highest harvest lever of its enrolled products, held by
 *  the server switch and the account's posture — and the products whose harvest it runs. */
async function brainMode(market: string | null, posture: AccountPosture) {
  const where = market ? { marketplace: market } : {}
  const [enrollments, overrides] = await Promise.all([
    prisma.adsBrainEnrollment.findMany({ where, select: { productId: true, marketplace: true } }),
    prisma.adsBrainOverride.findMany({ where: { endedAt: null, scope: 'PRODUCT', ...(market ? { marketplace: market } : {}) }, select: { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } }),
  ])
  const { resolveBrainSettings } = await import('../brain/settings.js')
  const perProduct = enrollments.map((e) => ({ ...e, level: resolveBrainSettings({ productId: e.productId, market: e.marketplace, campaignId: null, enrolled: true, overrides: overrides as never }).levers.harvest.effective }))
  const levels = perProduct.map((e) => e.level)
  const top = levels.includes('AUTO') ? 'AUTO' : levels.includes('PROPOSE') ? 'PROPOSE' : levels.includes('OBSERVE') ? 'OBSERVE' : 'OFF'
  const set = MODE_OF_LEVEL[top as AutonomyLevel]
  let acts = set
  let heldBy: Hold | null = null
  const also: Hold[] = []
  const hold = (h: Hold, mode?: typeof set) => { if (mode && mode !== acts) acts = mode; if (!heldBy) heldBy = h; else also.push(h) }
  if (set !== 'OFF') {
    if (posture.killed) hold(HOLDS.serverKill(), 'OFF')
    else if (posture.halted) hold(HOLDS.halted(), 'OFF')
    else if (posture.autonomy === 'OFF') hold(HOLDS.accountOff(), 'OFF')
    const ceiling = harvestCeiling()
    if (acts !== 'OFF' && (set === 'AUTO' || set === 'ASK') && !ceiling.live) hold(HOLDS.serverNoWrites(), 'WATCH')
    if (acts === 'AUTO' && !adsLive()) hold(HOLDS.testMode(), 'WATCH')
  }
  // The products it runs: enrolled, their harvest lever not OFF.
  const runs = perProduct.filter((e) => e.level !== 'OFF')
  return { set, acts, heldBy: heldBy as Hold | null, also, runs }
}

/** S10 — "Daily · 07:25": the brain's daily harvest run in Rome time (the page's own clock), never UTC. Pure. */
export function brainScheduleWords(nextRunAt: Date): string {
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).format(nextRunAt)
  return `Daily · ${hhmm}`
}

/** The brain's pseudo-row: its harvest lever over the enrolled products of the market, held by the server switch. */
async function brainRow(a: { market: string | null; now: Date; posture: AccountPosture; book: RefBook }): Promise<HarvestRuleRow> {
  const weekAgo = new Date(a.now.getTime() - WEEK_DAYS * DAY)
  const where = a.market ? { marketplace: a.market } : {}
  const [mode, records, lastRun] = await Promise.all([
    brainMode(a.market, a.posture),
    prisma.adsBrainHarvest.findMany({ where: { ...where, actorKind: 'BRAIN', changedAt: { gte: weekAgo } }, select: { status: true, destCampaignId: true, destAdGroupId: true, keywordTargetId: true, approvalId: true } }),
    prisma.adsBrainHarvest.aggregate({ where: { ...where, actorKind: 'BRAIN' }, _max: { checkedAt: true } }),
  ])
  const { set, acts, heldBy, also } = mode
  const campaignIds = [...new Set(records.map((r) => r.destCampaignId).filter((x): x is string => !!x))]
  // S11 — its scope is the products it runs and their SOURCE ad groups (the Sources view's own rows), never the places
  // it harvests into.
  const productIds = [...new Set(mode.runs.map((e) => e.productId))]
  const sourceRows: Array<{ adGroup: Ref; campaign: Ref }> = []
  if (productIds.length) {
    const { harvestSources } = await import('./sources.js')
    for (const m of [...new Set(mode.runs.map((e) => e.marketplace))]) {
      const got = await harvestSources({ market: m }, { now: a.now })
      if ('data' in got) for (const r of got.data.rows) if (r.product && productIds.includes(r.product.id)) sourceRows.push({ adGroup: r.adGroup, campaign: r.campaign })
    }
  }
  await a.book.load({ campaigns: [...campaignIds, ...sourceRows.map((r) => r.campaign.id)], adGroups: sourceRows.map((r) => r.adGroup.id) })
  // Re-audit — by the product's NAME, as everywhere else on the page (its SKU only when it has none).
  const named = new Map((productIds.length ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true, name: true } }) : []).map((p) => [p.id, p.name || p.sku || p.id]))
  const written = records.filter((r) => r.status === 'DONE' || r.status === 'HALF_DONE')
  const waitingIds = records.filter((r) => ['PROPOSED', 'CAMPAIGN_PROPOSED', 'UNDO_PROPOSED'].includes(r.status) && r.approvalId).map((r) => r.approvalId!)
  const waiting = waitingIds.length ? await prisma.agentApproval.count({ where: { id: { in: waitingIds }, status: { in: OPEN } } }) : 0
  const next = new Date(Date.UTC(a.now.getUTCFullYear(), a.now.getUTCMonth(), a.now.getUTCDate(), 5, 25))
  if (next <= a.now) next.setUTCDate(next.getUTCDate() + 1)
  const changed = a.book.refSet(written.map((r) => r.destCampaignId).filter((x): x is string => !!x), written.map((r) => r.destAdGroupId).filter((x): x is string => !!x))
  return {
    id: BRAIN_ROW_ID, kind: 'brain', name: 'Brain', sentence: 'Harvests each product it runs', market: a.market,
    mode: { set, acts, heldBy, also, autoLocked: null },
    scope: { ...a.book.refSet(sourceRows.map((r) => r.campaign.id), sourceRows.map((r) => r.adGroup.id)), all: false, product: null, products: productIds.map((id) => productRef(id, named.get(id) ?? id)) },
    changed7d: { ...changed, bids: 0, keywords: written.filter((r) => r.keywordTargetId).length },
    last7d: { runs: Math.min(WEEK_DAYS, records.length ? WEEK_DAYS : 0), asks: records.filter((r) => r.approvalId).length, applied: 0, written: written.length, brainInputs: 0, refused: records.filter((r) => r.status === 'REFUSED' || r.status === 'FAILED').length },
    waiting, lastRunAt: lastRun._max.checkedAt?.toISOString() ?? null, nextRunAt: set === 'OFF' ? null : next.toISOString(), firstRunAt: null, thenRunAt: null,
    schedule: brainScheduleWords(next), effect: null, archived: false,
  }
}

/** GET /rules/:id/history — the harvests a rule (or the brain) made, newest first. */
export async function harvestRuleHistory(id: string, q: { days?: number; market?: string | null; limit?: number }, opts: { now?: Date } = {}): Promise<{ data: { id: string; name: string; days: number; harvests: HistoryRow[] } } | { error: string; status: 400 | 404 }> {
  let name = 'Brain'
  if (id !== BRAIN_ROW_ID) {
    const rule = await prisma.automationRule.findUnique({ where: { id }, select: { name: true, domain: true, actions: true } })
    if (!rule || (rule.domain !== 'advertising' && rule.domain !== ARCHIVED_ADS_DOMAIN) || !isHarvestRule(rule.actions)) return { error: `No harvest rule ${id} in this business.`, status: 404 }
    name = rule.name
  }
  const market = normMarket(q.market)
  const markets = market ? [market] : (await prisma.adsBrainHarvest.findMany({ distinct: ['marketplace'], select: { marketplace: true } })).map((m) => m.marketplace)
  if (!markets.length) return { data: { id, name, days: q.days ?? WEEK_DAYS, harvests: [] } }
  const got = await harvestHistory({ market: markets, days: q.days ?? WEEK_DAYS, actor: id === BRAIN_ROW_ID ? 'BRAIN' : 'RULE', limit: q.limit ?? 200 }, opts)
  if ('error' in got) return got
  return { data: { id, name, days: q.days ?? WEEK_DAYS, harvests: got.data.rows.filter((r) => id === BRAIN_ROW_ID || r.by.id === id) } }
}

/** POST /rules/:id/archive and /unarchive — the Bid page's archive, for a harvest rule (inert, reversible, audited). */
export async function setHarvestRuleArchived(id: string, archived: boolean, actor: AdsActor): Promise<{ data: { id: string; name: string; archived: boolean; level: 'OFF'; already: boolean; expiredAsks: number; before: ModeBefore } } | { error: string; status: 400 | 404 }> {
  if (id === BRAIN_ROW_ID) return { error: 'The brain is not a rule: it cannot be archived.', status: 400 }
  const rule = await prisma.automationRule.findUnique({ where: { id }, select: { id: true, name: true, domain: true, actions: true, enabled: true, dryRun: true, autonomyLevel: true } })
  if (!rule || (rule.domain !== 'advertising' && rule.domain !== ARCHIVED_ADS_DOMAIN) || !isHarvestRule(rule.actions)) return { error: `No harvest rule ${id} in this business.`, status: 404 }
  // Delta review D1 — what it was (its mode, Manual/Automate, harvest Auto mark): the Undo of an archive sends it to
  // POST /rules/mode after the unarchive, so a rule comes back at Auto with its mark only if it had one.
  const builder = (Array.isArray(rule.actions) ? (rule.actions[0] as { type?: unknown } | undefined) : undefined)?.type === 'keyword-harvesting'
  const was: ModeBefore = { mode: rule.domain === ARCHIVED_ADS_DOMAIN ? 'OFF' : MODE_OF_LEVEL[resolveAutonomy(rule) as AutonomyLevel], belt: builder ? storedBelt(rule.actions) : null, marked: harvestAutoConfirmed(rule.actions) }
  const base = { id: rule.id, name: rule.name, archived, level: 'OFF' as const, expiredAsks: 0, before: was }
  if ((rule.domain === ARCHIVED_ADS_DOMAIN) === archived) return { data: { ...base, already: true } }
  const before = { domain: rule.domain, enabled: rule.enabled, dryRun: rule.dryRun, autonomyLevel: rule.autonomyLevel }
  const after = { domain: archived ? ARCHIVED_ADS_DOMAIN : 'advertising', enabled: false, dryRun: true, autonomyLevel: 'OFF' }
  const now = new Date()
  const expiredAsks = await prisma.$transaction(async (tx) => {
    await tx.automationRule.update({ where: { id }, data: after })
    const n = archived ? (await tx.adsRuleSuggestion.updateMany({ where: { ruleId: id, status: 'pending' }, data: { status: 'expired', decidedAt: now, decidedBy: 'system:archived' } })).count : 0
    await tx.advertisingActionLog.create({
      data: {
        userId: actor, actionType: archived ? 'archive_rule' : 'restore_rule', entityType: 'RULE', entityId: id, payloadBefore: before, payloadAfter: after, amazonResponseStatus: 'SUCCESS',
        evidence: { metric: 'operator_rule_edit', note: archived ? `${rule.name} archived (runs and harvests kept; ${n} waiting asks expired)` : `${rule.name} restored at Off` },
      },
    })
    return n
  })
  return { data: { ...base, already: false, expiredAsks } }
}

const LEVEL_OF_MODE: Record<string, AutonomyLevel> = { OFF: 'OFF', WATCH: 'OBSERVE', ASK: 'PROPOSE', AUTO: 'AUTO' }

type Belt = 'manual' | 'automate'

/** Why Auto cannot be picked, in plain words (never a server variable name): the graduation gate's own hold. Pure. */
export function autoHoldOf(refusal: { error?: unknown; failures?: unknown; blockedBy?: unknown } | null, r: { createdAt: Date; evaluationCount: number }): Hold | null {
  const failures = (Array.isArray(refusal?.failures) ? refusal!.failures : []).map(String)
  // Amazon's test mode is the server's: said as what it means for this rule.
  if (refusal?.error === 'gate_not_open' && failures.length && failures.every((f) => f.startsWith('LIVE_MODE_ENV'))) return { kind: 'gate', label: 'Amazon test mode', reason: 'Auto is off while Amazon runs in test mode.' }
  return autoGateHold(refusal, r.createdAt, { observationDays: GRADUATION_GATE.observationDays, evaluations: { have: r.evaluationCount, need: GRADUATION_GATE.evaluations } })
}

/**
 * The graduation gate for a rule already at Auto that has no harvest Auto mark (saved before the release): the same checks
 * as a fresh Auto pick, less "still in its dry run" (it is not: it was set to Auto another way). Null: it may be marked.
 */
async function markGateRefusal(id: string): Promise<{ error: string; failures: string[] } | null> {
  const { adsRuleGateStatus } = await import('../ads-rule-crud.service.js')
  const { isRefused } = await import('../../automation/service-outcome.js')
  const gate = await adsRuleGateStatus(id)
  if (isRefused(gate)) return { error: 'not_found', failures: [] }
  const failures = gate.value.checks.filter((c) => !c.passed && c.id !== 'RULE_DRY_RUN').map((c) => c.id)
  return failures.length ? { error: 'gate_not_open', failures } : null
}

/** The harvest path's Auto mark on a rule (`actions[0].harvestAuto`), set when a person picks Auto here, cleared otherwise. Audited. */
async function markHarvestAuto(id: string, on: boolean, actor: AdsActor): Promise<void> {
  const r = await prisma.automationRule.findUnique({ where: { id }, select: { name: true, actions: true } })
  const actions = (Array.isArray(r?.actions) ? JSON.parse(JSON.stringify(r!.actions)) : []) as Array<Record<string, unknown>>
  if (!r || !actions[0]) return
  const had = !!actions[0].harvestAuto
  if (!on && !had) return
  if (on) actions[0].harvestAuto = { confirmedAt: new Date().toISOString(), by: actor }
  else delete actions[0].harvestAuto
  await prisma.automationRule.update({ where: { id }, data: { actions: actions as never } })
  await prisma.advertisingActionLog.create({
    data: {
      userId: actor, actionType: on ? 'confirm_harvest_auto' : 'clear_harvest_auto', entityType: 'RULE', entityId: id,
      payloadBefore: { harvestAuto: had }, payloadAfter: { harvestAuto: on }, amazonResponseStatus: 'SUCCESS',
      evidence: { metric: 'operator_rule_edit', note: on ? `${r.name}: Auto picked on the Keyword Harvest page — it may now add keywords alone, inside its caps` : `${r.name}: no longer at Auto — its Auto pick is cleared` },
    },
  })
}
/** The belt a mode needs on a builder harvest rule (`actions[0].control`), or null when the stored one may stay (Off). */
export function beltFor(mode: 'OFF' | 'WATCH' | 'ASK' | 'AUTO'): Belt | null {
  return mode === 'WATCH' || mode === 'AUTO' ? 'automate' : mode === 'ASK' ? 'manual' : null
}
const storedBelt = (actions: unknown): Belt | null => {
  const c = (Array.isArray(actions) ? (actions[0] as { control?: unknown } | undefined) : undefined)?.control
  return c === 'manual' || c === 'automate' ? c : null
}
const withBelt = (actions: unknown, control: Belt): object[] => (Array.isArray(actions) ? actions : []).map((a, i) => (i === 0 && a && typeof a === 'object' ? { ...(a as object), control } : a) as object)

/**
 * POST /rules/mode — the mode of many harvest rules at once, each through the level dial (its ceiling and gate). A rule
 * made in the builder for Keyword Harvest (`keyword-harvesting`) also carries its own Manual/Automate setting
 * (`actions[0].control`: 'manual' makes it ask at any level). It is set here too, in one place, as the Bid page orders it:
 * 'automate' for Watch and Auto FIRST (so it never acts lower than asked; put back when the level is refused), 'manual'
 * for Ask me AFTER the level; Off keeps what it has. Both through the rule's own edit path (updateAdsRule: checked, audited).
 */
/** What a harvest rule was before a mode change or an archive: its mode, its own Manual/Automate, its harvest Auto mark. */
export interface ModeBefore { mode: string; belt: Belt | null; marked: boolean }

export async function setHarvestRulesMode(ids: readonly string[], mode: 'OFF' | 'WATCH' | 'ASK' | 'AUTO', actor: AdsActor, opts: { belt?: Belt | null; marked?: boolean } = {}) {
  const { setAdsRuleLevel, updateAdsRule } = await import('../ads-rule-crud.service.js')
  const { isRefused } = await import('../../automation/service-outcome.js')
  const why = (out: { body: unknown }) => { const b = out.body as { error?: unknown; reason?: unknown; message?: unknown }; return String(b.reason ?? b.message ?? b.error ?? 'refused') }
  // RS4 (release review) — each result says what the rule was before (its mode and its own Manual/Automate), so an Undo
  // puts back exactly that (POST /rules/mode with `belt`), also for a rule that acted above its set mode.
  // Delta review D1 — and its harvest Auto mark (`marked`): an Undo sends `before` back as it came (mode, belt, marked), so
  // a rule is put back at Auto WITH its mark only if it had one — never a mark it did not have.
  const results: Array<{ id: string; ok: boolean; mode?: string; belt?: Belt | null; marked?: boolean; before?: ModeBefore; error?: string }> = []
  for (const id of [...new Set(ids)]) {
    if (id === BRAIN_ROW_ID) { results.push({ id, ok: false, error: 'The brain\'s harvest level is set per product (the brain\'s product settings, set-ads-brain).' }); continue }
    const rule = await prisma.automationRule.findUnique({ where: { id }, select: { domain: true, actions: true, enabled: true, dryRun: true, autonomyLevel: true, createdAt: true, evaluationCount: true } })
    if (!rule || rule.domain !== 'advertising' || !isHarvestRule(rule.actions)) { results.push({ id, ok: false, error: rule?.domain === ARCHIVED_ADS_DOMAIN ? 'It is archived: unarchive it first.' : `No harvest rule ${id} in this business.` }); continue }
    const builder = (Array.isArray(rule.actions) ? (rule.actions[0] as { type?: unknown } | undefined) : undefined)?.type === 'keyword-harvesting'
    const have = storedBelt(rule.actions)
    const before: ModeBefore = { mode: MODE_OF_LEVEL[resolveAutonomy(rule) as AutonomyLevel], belt: builder ? have : null, marked: harvestAutoConfirmed(rule.actions) }
    // An Undo names the belt to put back (null: the rule had none); a plain mode change takes the mode's own.
    const want = builder ? (opts.belt !== undefined ? opts.belt : beltFor(mode)) : null
    const change = want && want !== have ? want : null
    const clear = builder && opts.belt === null && have !== null
    let belt: Belt | null = builder ? have : null
    // Functional walk (MUST) — Auto picked again on a rule already at Auto that has no harvest Auto mark (every rule saved
    // before the release): not "no change" — it is the person's pick, under the same gate as a fresh Auto pick.
    if (mode === 'AUTO' && before.mode === 'AUTO' && !before.marked && opts.marked !== false) {
      const gate = await markGateRefusal(id)
      if (gate) { results.push({ id, ok: false, before, error: autoHoldOf(gate, rule)?.reason ?? 'Auto cannot be picked for it now.' }); continue }
    }
    if (change === 'automate') {
      const set = await updateAdsRule(id, { actions: withBelt(rule.actions, 'automate') }, actor, { note: `harvest mode ${mode}: Automate` })
      if (isRefused(set)) { results.push({ id, ok: false, before, error: `Its Automate setting was not changed: ${why(set)}` }); continue }
      belt = 'automate'
    }
    const out = await setAdsRuleLevel(id, LEVEL_OF_MODE[mode], actor)
    if (isRefused(out)) {
      // The level was refused: the Automate setting set first goes back to what it was.
      if (change === 'automate') await updateAdsRule(id, { actions: (Array.isArray(rule.actions) ? rule.actions : []) as object[] }, actor, { note: `harvest mode ${mode} refused: put back` })
      // In plain words: a gate's hold says what it waits for (never a server variable or a deploy step).
      const b = out.body as { error?: unknown; failures?: unknown; blockedBy?: unknown }
      const plain = mode === 'AUTO' && ['gate_not_open', 'above_ceiling', 'contested_by_rank_engine'].includes(String(b.error ?? '')) ? autoHoldOf(b, rule)?.reason : null
      results.push({ id, ok: false, before, error: plain ?? why(out) })
      continue
    }
    if (change === 'manual') {
      const set = await updateAdsRule(id, { actions: withBelt(rule.actions, 'manual') }, actor, { note: `harvest mode ${mode}: Manual` })
      if (isRefused(set)) { results.push({ id, ok: false, mode, belt, before, error: `Its mode is ${mode}, but its Manual setting was not changed: ${why(set)}` }); continue }
      belt = 'manual'
    }
    if (clear) {
      // An Undo back to a rule that held no Manual/Automate of its own: the key goes, as it was.
      const actions = (Array.isArray(rule.actions) ? JSON.parse(JSON.stringify(rule.actions)) : []) as Array<Record<string, unknown>>
      if (actions[0]) delete actions[0].control
      const set = await updateAdsRule(id, { actions }, actor, { note: `harvest mode ${mode}: its own setting put back` })
      if (isRefused(set)) { results.push({ id, ok: false, mode, belt, before, error: `Its mode is ${mode}, but its own setting was not put back: ${why(set)}` }); continue }
      belt = null
    }
    // Release safety — Auto picked here is the person's own Auto (the run lets the rule act alone, inside its caps); any
    // other mode takes the mark away again. An Undo (`marked` from `before`) puts the mark back only as it was.
    const marked = mode === 'AUTO' && opts.marked !== false
    await markHarvestAuto(id, marked, actor)
    results.push({ id, ok: true, mode, marked, before, ...(builder ? { belt } : {}) })
  }
  return { results }
}

/**
 * POST /rules/preview — what a harvest rule (saved: `ruleId`, or a body not saved yet) would harvest now, as a rule harvests
 * (harvest/plan.ts, actor RULE: the brain's campaigns left to the brain, its source and funnel blocks, inside its day's
 * cap). Writes nothing.
 */
export async function previewHarvestRule(body: {
  ruleId?: string; actions?: unknown[]; scopeMarketplace?: string | null; scopePortfolioId?: string | null; scopeCampaignId?: string | null; scopeProductId?: string | null; limit?: number
}, opts: { now?: Date } = {}): Promise<{ data: { market: string | null; campaigns: number; wouldHarvest: number; held: number; capPerDay: number; sample: Array<{ candidateId: string; term: string; product: { id: string; name: string }; destination: unknown; startBidCents: number | null; heldBy: PlanHold | null }>; brainOwned?: { terms: number; mode: string; words: string } | null; own?: { minOrders: number | null; maxAcosPct: number | null; windowDays: number; belowOwn: number } | null } } | { error: string; status: 400 | 404 }> {
  let rule: { id: string; actions: unknown; conditions: unknown; scopeMarketplace: string | null; scopePortfolioId: string | null; scopeCampaignId: string | null; scopeProductId: string | null }
  if (body.ruleId) {
    const r = await prisma.automationRule.findUnique({ where: { id: body.ruleId }, select: { id: true, domain: true, actions: true, conditions: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true } })
    if (!r || r.domain !== 'advertising' || !isHarvestRule(r.actions)) return { error: `No harvest rule ${body.ruleId} in this business.`, status: 404 }
    rule = { ...r, ...(body.actions ? { actions: body.actions } : {}), ...(body.scopeMarketplace !== undefined ? { scopeMarketplace: body.scopeMarketplace } : {}), ...(body.scopePortfolioId !== undefined ? { scopePortfolioId: body.scopePortfolioId } : {}) }
  } else {
    if (!body.actions || !isHarvestRule(body.actions)) return { error: 'actions: a harvest rule body (harvest_and_negate, promote_to_exact or keyword-harvesting) or a ruleId', status: 400 }
    rule = { id: 'preview', actions: body.actions, conditions: [], scopeMarketplace: body.scopeMarketplace ?? null, scopePortfolioId: body.scopePortfolioId ?? null, scopeCampaignId: body.scopeCampaignId ?? null, scopeProductId: body.scopeProductId ?? null }
  }
  const own = ownNumbersOf(rule.actions, rule.conditions)
  const reached = (await harvestRulesReach([rule as unknown as ReachRule])).get(rule.id)
  const campaigns = (reached?.campaigns ?? []).filter((c) => c.status !== 'ARCHIVED')
  // A builder rule bound by its mapping takes terms only from the ad groups its mapping reads.
  const look = reached?.look ? new Set(reached.look) : null
  const market = normMarket(rule.scopeMarketplace) ?? (campaigns[0] ? strategyMarket(campaigns[0].marketplace) : null)
  if (!market) return { data: { market: null, campaigns: 0, wouldHarvest: 0, held: 0, capPerDay: HARVEST_RULE_CAPS.keywordsPerDay, sample: [], brainOwned: null } }
  const inScope = new Set(campaigns.filter((c) => strategyMarket(c.marketplace) === market).map((c) => c.id))
  const { marketRows, planProductOf, planTermOf } = await import('./candidates.js')
  const { planItem } = await import('./plan.js')
  const { landingLookup } = await import('./facts.js')
  const got = await marketRows(market, { now: opts.now })
  if ('error' in got) return got
  const rows = got.rows.filter((r) => (r.state === 'READY' || r.state === 'NEEDS_DESTINATION' || r.state === 'NEEDS_CAMPAIGN') && r.sources.some((s) => inScope.has(s.campaign.id) && (!look || look.has(s.adGroup.id))))
  const landing = await landingLookup(rows.flatMap((r) => [...(got.facts.products.get(r.product.id)?.facts.groups.keys() ?? [])].map((adGroupId) => ({ adGroupId, term: r.term, match: 'EXACT' as const, isAsin: r.kind === 'asin' }))))
  // The rule's own numbers over its own window, from its sources in scope (they only narrow the bar).
  const ownOf = own ? await ownEvidence(rows.map((r) => ({ id: r.id, term: r.term, groups: r.sources.filter((x) => !look || look.has(x.adGroup.id)).map((x) => x.adGroup.id) })), own.windowDays, opts.now ?? new Date()) : null
  let belowOwn = 0
  const sample: Array<{ candidateId: string; term: string; product: { id: string; name: string }; destination: unknown; startBidCents: number | null; heldBy: PlanHold | null }> = []
  let would = 0
  let held = 0
  // S12 — terms the brain runs are one summary line, not N sample rows (what the brain really does with them, in words).
  let brainTerms = 0
  for (const r of rows) {
    const p = got.facts.products.get(r.product.id)
    if (!p) continue
    const t = planTermOf(p, r.term, p.decisions.get(r.term) ?? null)
    const item = planItem({ req: { candidateId: r.id }, actor: 'RULE', product: planProductOf(p, got.facts), term: t, record: null, waiting: !!r.waiting, newCampaign: null, landing: (gid) => landing(gid, r.term, 'EXACT', t.isAsin) })
    let hold: PlanHold | null = item.hold
    if (hold?.kind === 'lever' && hold.label === 'Brain decides') { brainTerms++; continue }
    if (!hold && own && ownOf) {
      const e = ownOf.get(r.id) ?? { orders: 0, spendCents: 0, salesCents: 0 }
      const acos = e.salesCents > 0 ? (e.spendCents / e.salesCents) * 100 : null
      const short = (own.minOrders != null && e.orders < own.minOrders) || (own.maxAcosPct != null && (acos == null || acos > own.maxAcosPct))
      if (short) { belowOwn++; continue }
    }
    if (!item.refusal && would >= HARVEST_RULE_CAPS.keywordsPerDay) hold = { kind: 'cap', label: 'Daily limit reached', reason: `A harvest rule creates at most ${HARVEST_RULE_CAPS.keywordsPerDay} keywords a day; the rest wait for tomorrow.` }
    if (hold) held++
    else would++
    if (sample.length < Math.max(1, Math.min(100, body.limit ?? 25))) sample.push({ candidateId: r.id, term: r.term, product: r.product, destination: item.destination, startBidCents: item.bid?.cents ?? null, heldBy: hold })
  }
  let brainOwned: { terms: number; mode: string; words: string } | null = null
  if (brainTerms) {
    const m = await brainMode(market, await accountPosture())
    const what = m.acts === 'AUTO' ? 'Auto: it adds them itself' : m.acts === 'ASK' ? 'Ask me: it asks you for each' : m.acts === 'WATCH' ? 'Watch: it adds nothing' : 'Off: it adds nothing'
    brainOwned = { terms: brainTerms, mode: m.acts, words: `${brainTerms} term${brainTerms === 1 ? '' : 's'} belong${brainTerms === 1 ? 's' : ''} to the brain (${what})` }
  }
  return {
    data: {
      market, campaigns: inScope.size, wouldHarvest: would, held, capPerDay: HARVEST_RULE_CAPS.keywordsPerDay, sample, brainOwned,
      // The rule's own numbers, and how many terms that pass the bar they leave out.
      own: own ? { ...own, belowOwn } : null,
    },
  }
}

/** Orders, spend and sales of each term over the rule's own window (settled days), from its own source ad groups. */
async function ownEvidence(rows: ReadonlyArray<{ id: string; term: string; groups: string[] }>, windowDays: number, now: Date): Promise<Map<string, { orders: number; spendCents: number; salesCents: number }>> {
  const out = new Map<string, { orders: number; spendCents: number; salesCents: number }>()
  const ids = [...new Set(rows.flatMap((r) => r.groups))]
  if (!ids.length) return out
  const groups = await prisma.adGroup.findMany({ where: { id: { in: ids } }, select: { id: true, externalAdGroupId: true } })
  const extOf = new Map(groups.map((g) => [g.id, g.externalAdGroupId]))
  const window = settledBounds(windowDays, 'SPONSORED_PRODUCTS', { now })
  const exts = [...new Set(groups.map((g) => g.externalAdGroupId).filter((x): x is string => !!x))]
  const sums = exts.length ? await prisma.amazonAdsSearchTerm.groupBy({ by: ['adGroupId', 'query'], where: { adGroupId: { in: exts }, date: { gte: window.since, lte: window.until } }, _sum: { orders7d: true, costMicros: true, sales7dCents: true } }) : []
  const byKey = new Map<string, { orders: number; spendCents: number; salesCents: number }>()
  for (const s of sums) {
    const k = `${s.adGroupId}|${termKey(s.query)}`
    const cur = byKey.get(k) ?? { orders: 0, spendCents: 0, salesCents: 0 }
    cur.orders += s._sum.orders7d ?? 0
    cur.spendCents += Math.round(Number(s._sum.costMicros ?? 0n) / 10_000)
    cur.salesCents += s._sum.sales7dCents ?? 0
    byKey.set(k, cur)
  }
  for (const r of rows) {
    const t = { orders: 0, spendCents: 0, salesCents: 0 }
    for (const g of r.groups) {
      const e = byKey.get(`${extOf.get(g) ?? ''}|${termKey(r.term)}`)
      if (e) { t.orders += e.orders; t.spendCents += e.spendCents; t.salesCents += e.salesCents }
    }
    out.set(r.id, t)
  }
  return out
}
