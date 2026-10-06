/**
 * R14 (MCP full control, part 06 §3) — tune-ad-engine: one setting of an ads engine, changed through the engine's own
 * writer (the route's code, moved into a service where it lived in a route), judged for spend.
 *
 *   setting               automation  writer                                   the row
 *   budget-pool           A9          patchBudgetPool                          a pool (subjectId)
 *   coverage-set          A12         updateCoverageSet                        a coverage set (subjectId)
 *   rank-target           A10         patchRankTarget                          a rank target (subjectId)
 *   budget-schedule       A7          patchBudgetSchedule (its windows)        a budget schedule (subjectId)
 *   harvest-policy        A14         saveHarvestPolicy / deleteHarvestPolicy  a scope (grain + id)
 *   ebay-campaign-policy  E1          setEbayCampaignPolicy                    an eBay campaign (subjectId)
 *   account-target-acos   A3          setDefaultTargetAcosPct                  the business's ads state
 *   breaker               A3          setGuardThresholds                       the business's ads state
 *
 * Every plan says whether the change can raise spend (part 06 §3: a higher target ACOS, budget, cap or breaker limit, a
 * pool shift, a looser harvest, a lowering window removed…) and why; those are outside tune-ad-engine's limits — a
 * person decides. Switching is not tuning: on / off and levels stay with turn-up / turn-down-automation. Not tunable here,
 * on purpose: dayparting windows (a closed window can hold a campaign paused — never pause), rank targets' pause /
 * lanes / base bid, a pool's on / dry-run flags. 2e — a rank target is tuned by what the hourly bid plan reads: its
 * Placement %, CPC ceiling and Min-bid floor (its goal, ACoS, step, ceiling and keep-climbing fields are not read).
 */
import prisma from '../../db.js'
import { workspaceKey } from '@nexus/database/workspace-context'
import { HV_ACCOUNT_SCOPE, HV_DEFAULT_CRITERIA, type HvPolicyGrain } from './harvest-policy.service.js'

export const ENGINE_SETTINGS = ['budget-pool', 'coverage-set', 'rank-target', 'budget-schedule', 'harvest-policy', 'ebay-campaign-policy', 'account-target-acos', 'breaker'] as const
export type EngineSetting = (typeof ENGINE_SETTINGS)[number]

export const POOL_STRATEGIES = ['STATIC', 'PROFIT_WEIGHTED', 'URGENCY_WEIGHTED'] as const
export const HARVEST_GRAINS = ['account', 'market', 'line', 'portfolio', 'campaign', 'adGroup'] as const
export const WINDOW_ADJ = ['set', 'incPct', 'decPct'] as const
// 2e — only what the hourly bid plan reads (rank-controller.ts): the goal / ACoS / step / ceiling / keep-climbing fields are not.
export const RANK_TARGET_TUNABLE = ['biasPct', 'maxCpcCents', 'floorBidCents'] as const

/** The breaker's limits when none is set (ads-anomaly-guard.service.ts). */
const BREAKER_DEFAULTS = { maxHourlySpendCentsEur: 50_000, maxActionsPerHour: 250 }

type State = Record<string, unknown>
type Values = Record<string, unknown>

export interface TuneInput {
  setting: EngineSetting
  subjectId?: string
  /** The setting's own fields (the tool's `budgetPool`, `coverageSet`, … object). */
  values: Values
}

/** What the change record stores (before / after) and undo puts back. */
export interface TuneRecord {
  setting: EngineSetting
  subjectId: string | null
  /** harvest-policy: the scope it binds. */
  key?: { scopeGrain: string; scopeId: string | null }
  name: string
  state: State
}

export interface TunePlan {
  action: 'tune-ad-engine'
  setting: EngineSetting
  automation: { id: string; name: string }
  subject: { id: string | null; name: string }
  changes: Record<string, { from: unknown; to: unknown }>
  /** Why this change can raise spend; empty when it cannot. Any reason puts it outside the limits. */
  raises: string[]
  spend: 'can-rise' | 'cannot-rise'
  basis: string | null
  effect: string
}

interface Loaded {
  id: string | null
  name: string
  key?: { scopeGrain: string; scopeId: string | null }
  state: State
  basis: string | null
  /** Shown in the effect (e.g. a built-in rank target every plan uses). */
  note?: string
  /** budget-schedule: its type (a multiplier schedule reads `value` as ×). */
  type?: string
}

interface Spec {
  automation: { id: string; name: string }
  label: string
  needsSubject: boolean
  load(input: TuneInput): Promise<Loaded | string>
  /** The state after the change, or why it is refused. */
  next(loaded: Loaded, values: Values): State | string
  raises(before: State, after: State, loaded: Loaded): string[]
  write(loaded: Loaded, before: State, after: State, actorUserId: string | null): Promise<string | null>
  effect(loaded: Loaded): string
}

const euro = (cents: unknown) => (cents == null ? 'none' : `€${(Number(cents) / 100).toFixed(2)}`)
const show = (value: unknown) => (value == null ? 'none' : String(value))
const round2 = (value: unknown) => (value == null ? null : Math.round(Number(value) * 100) / 100)
const actorOf = (actorUserId: string | null) => `user:${actorUserId ?? 'anonymous'}`

/** Merge the given fields over the current state (a field left out keeps its value; null clears where allowed). */
function merge(state: State, values: Values, fields: readonly string[]): State {
  const out = { ...state }
  for (const field of fields) if (values[field] !== undefined) out[field] = values[field]
  return out
}

/** A higher number, or a limit cleared (null = no limit): the usual way a cap is loosened. */
function capRaised(before: unknown, after: unknown): boolean {
  if (after == null) return before != null
  return before != null && Number(after) > Number(before)
}

/** An audit row of a setting Claude tuned, in the ads action log; it never fails the write it describes. */
async function auditTune(actorUserId: string | null, entityType: string, entityId: string, before: State, after: State): Promise<void> {
  await prisma.advertisingActionLog.create({
    data: {
      userId: actorOf(actorUserId), actionType: 'tune_engine_setting', entityType, entityId,
      payloadBefore: before as object, payloadAfter: after as object, amazonResponseStatus: 'SUCCESS',
    },
  }).catch(() => { /* an audit row must never fail the write it describes */ })
}

// ── budget-pool (A9) ─────────────────────────────────────────────────────────────────────────────────────

const POOL_FIELDS = ['totalDailyBudgetCents', 'strategy', 'coolDownMinutes', 'maxShiftPerRebalancePct'] as const

const budgetPool: Spec = {
  automation: { id: 'A9', name: 'Budget pools' },
  label: 'budget pool',
  needsSubject: true,
  async load(input) {
    const p = await prisma.budgetPool.findUnique({ where: { id: input.subjectId! } })
    if (!p) return `there is no budget pool ${input.subjectId} in this business (not found)`
    return { id: p.id, name: p.name, basis: p.updatedAt.toISOString(), state: { totalDailyBudgetCents: p.totalDailyBudgetCents, strategy: p.strategy, coolDownMinutes: p.coolDownMinutes, maxShiftPerRebalancePct: p.maxShiftPerRebalancePct } }
  },
  next(loaded, values) {
    return merge(loaded.state, values, POOL_FIELDS)
  },
  raises(b, a) {
    const out: string[] = []
    if (Number(a.totalDailyBudgetCents) > Number(b.totalDailyBudgetCents)) out.push(`the pool's daily budget rises from ${euro(b.totalDailyBudgetCents)} to ${euro(a.totalDailyBudgetCents)}`)
    if (a.strategy !== b.strategy) out.push(`a new strategy (${b.strategy} → ${a.strategy}) moves budget between the pool's campaigns`)
    if (Number(a.maxShiftPerRebalancePct) > Number(b.maxShiftPerRebalancePct)) out.push(`one rebalance may move more of the pool (${b.maxShiftPerRebalancePct}% → ${a.maxShiftPerRebalancePct}%)`)
    if (Number(a.coolDownMinutes) < Number(b.coolDownMinutes)) out.push(`the pool rebalances more often (every ${b.coolDownMinutes} → ${a.coolDownMinutes} minutes)`)
    return out
  },
  async write(loaded, before, after, actorUserId) {
    const { patchBudgetPool } = await import('./ads-engine-settings.service.js')
    const changed = Object.fromEntries(POOL_FIELDS.filter((f) => after[f] !== before[f]).map((f) => [f, after[f]]))
    if (!(await patchBudgetPool(loaded.id!, changed))) return 'not found'
    await auditTune(actorUserId, 'BUDGET_POOL', loaded.id!, before, after)
    return null
  },
  effect: (l) => `The pool "${l.name}" uses the new values from its next rebalance (if it is switched on).`,
}

// ── coverage-set (A12) ───────────────────────────────────────────────────────────────────────────────────

const coverageSet: Spec = {
  automation: { id: 'A12', name: 'Coverage engine' },
  label: 'coverage set',
  needsSubject: true,
  async load(input) {
    const s = await prisma.keywordCoverageSet.findUnique({ where: { id: input.subjectId! } })
    if (!s) return `there is no coverage set ${input.subjectId} in this business (not found)`
    return { id: s.id, name: s.name, basis: s.updatedAt.toISOString(), state: { dailySpendCapCents: s.dailySpendCapCents, acosCapPct: round2(s.acosCapPct) } }
  },
  next(loaded, values) {
    const out = merge(loaded.state, values, ['dailySpendCapCents', 'acosCapPct'])
    return { ...out, acosCapPct: round2(out.acosCapPct) }
  },
  raises(b, a) {
    const out: string[] = []
    if (capRaised(b.dailySpendCapCents, a.dailySpendCapCents)) out.push(a.dailySpendCapCents == null ? `the set's daily spend cap (${euro(b.dailySpendCapCents)}) is cleared` : `the set's daily spend cap rises from ${euro(b.dailySpendCapCents)} to ${euro(a.dailySpendCapCents)}`)
    if (capRaised(b.acosCapPct, a.acosCapPct)) out.push(a.acosCapPct == null ? `the set's ACOS cap (${b.acosCapPct}%) is cleared` : `the set's ACOS cap rises from ${b.acosCapPct}% to ${a.acosCapPct}%`)
    return out
  },
  async write(loaded, before, after, actorUserId) {
    const { updateCoverageSet } = await import('./ads-coverage-sets.service.js')
    await updateCoverageSet({ setId: loaded.id!, patch: { dailySpendCapCents: after.dailySpendCapCents as number | null, acosCapPct: after.acosCapPct as number | null } })
    await auditTune(actorUserId, 'COVERAGE_SET', loaded.id!, before, after)
    return null
  },
  effect: (l) => `The coverage set "${l.name}" holds its terms inside the new caps from the engine's next run (if it is switched on).`,
}

// ── rank-target (A10) ────────────────────────────────────────────────────────────────────────────────────

const rankTarget: Spec = {
  automation: { id: 'A10', name: 'Hourly bid plans (schedules and product plans)' },
  label: 'rank target',
  needsSubject: true,
  async load(input) {
    const t = await prisma.rankTarget.findUnique({ where: { id: input.subjectId! } })
    if (!t) return `there is no rank target ${input.subjectId} in this business (not found)`
    const state = Object.fromEntries(RANK_TARGET_TUNABLE.map((f) => [f, (t as unknown as Record<string, unknown>)[f] ?? null]))
    return { id: t.id, name: t.name, basis: t.updatedAt.toISOString(), state, note: t.builtIn ? 'a built-in target: every plan and schedule using it changes' : undefined }
  },
  next(loaded, values) {
    return merge(loaded.state, values, RANK_TARGET_TUNABLE)
  },
  raises(b, a) {
    const out: string[] = []
    const up = (field: string, words: string) => { if (Number(a[field] ?? 0) > Number(b[field] ?? 0)) out.push(`${words} rises (${show(b[field])} → ${show(a[field])})`) }
    const cleared = (field: string, words: string) => {
      if (a[field] == null && b[field] != null) out.push(`${words} (${show(b[field])}) is cleared`)
      else if (a[field] != null && b[field] != null && Number(a[field]) > Number(b[field])) out.push(`${words} rises (${show(b[field])} → ${show(a[field])})`)
    }
    up('biasPct', 'the placement percentage')
    cleared('maxCpcCents', 'the bid ceiling')
    up('floorBidCents', 'the floor bid')
    return out
  },
  async write(loaded, before, after, actorUserId) {
    const { patchRankTarget } = await import('./ads-engine-settings.service.js')
    const changed = Object.fromEntries(RANK_TARGET_TUNABLE.filter((f) => after[f] !== before[f]).map((f) => [f, after[f]]))
    if (!(await patchRankTarget(loaded.id!, changed))) return 'not found'
    await auditTune(actorUserId, 'RANK_TARGET', loaded.id!, before, after)
    return null
  },
  effect: (l) => `The rank target "${l.name}" applies from the hourly bid plans' next run${l.note ? ` — ${l.note}` : ''}.`,
}

// ── budget-schedule (A7) ─────────────────────────────────────────────────────────────────────────────────

interface BudgetWindow { day: number; start?: string; end?: string; adj?: string; value: number }
const fingerprint = (w: BudgetWindow) => `${Number(w.day)}|${w.start ?? ''}|${w.end ?? ''}|${w.adj ?? ''}|${w.value ?? ''}`
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const windowText = (w: BudgetWindow, type?: string) =>
  `${DAYS[Number(w.day)] ?? `day ${w.day}`} ${w.start && w.end ? `${w.start}–${w.end}` : 'all day'} ${type === 'budget-multiplier' ? `×${w.value}` : `${w.adj} ${w.value}`}`
/** Only lowers a budget: a decrease, or a multiplier of at most 1. `set` names an amount that may be above the base. */
const lowers = (w: BudgetWindow, type?: string) => (type === 'budget-multiplier' ? Number(w.value) > 0 && Number(w.value) <= 1 : w.adj === 'decPct')

const budgetSchedule: Spec = {
  automation: { id: 'A7', name: 'Budget schedules' },
  label: 'budget schedule',
  needsSubject: true,
  async load(input) {
    const s = await prisma.budgetSchedule.findFirst({ where: { id: input.subjectId!, kind: 'BUDGET' } })
    if (!s) return `there is no budget schedule ${input.subjectId} in this business (not found)`
    return { id: s.id, name: s.name, basis: s.updatedAt.toISOString(), type: s.type, state: { windows: Array.isArray(s.windows) ? s.windows : [] } }
  },
  next(loaded, values) {
    if (values.windows === undefined) return loaded.state
    const windows = values.windows as BudgetWindow[]
    for (const w of windows) {
      if ((w.start == null) !== (w.end == null)) return `a window needs both start and end, or neither (all day): ${JSON.stringify(w)}`
      if (loaded.type === 'budget-multiplier') {
        if (!(Number(w.value) > 0 && Number(w.value) <= 10)) return `a multiplier schedule's window value is × (above 0, at most 10): ${JSON.stringify(w)}`
      } else {
        if (!w.adj) return `a window needs adj (set, incPct or decPct): ${JSON.stringify(w)}`
        if (w.adj === 'decPct' && Number(w.value) > 100) return `decPct is at most 100: ${JSON.stringify(w)}`
        if (w.adj === 'set' && Number(w.value) < 1) return `set is a daily budget in euro, at least 1 (Amazon's floor): ${JSON.stringify(w)}`
      }
    }
    // As the builder writes them: the fields it knows, nothing else.
    return { windows: windows.map((w) => Object.fromEntries(Object.entries({ day: w.day, start: w.start, end: w.end, adj: w.adj, value: w.value }).filter(([, v]) => v !== undefined))) }
  },
  raises(b, a, loaded) {
    const before = (b.windows as BudgetWindow[]) ?? []
    const after = (a.windows as BudgetWindow[]) ?? []
    const had = new Set(before.map(fingerprint))
    const has = new Set(after.map(fingerprint))
    const out: string[] = []
    for (const w of after) if (!had.has(fingerprint(w)) && !lowers(w, loaded.type)) out.push(`window ${windowText(w, loaded.type)} can raise a budget`)
    for (const w of before) if (!has.has(fingerprint(w)) && lowers(w, loaded.type)) out.push(`the lowering window ${windowText(w, loaded.type)} goes: its budgets come back up`)
    return out
  },
  async write(loaded, _before, after, actorUserId) {
    const { patchBudgetSchedule } = await import('./ads-budget-schedule.service.js')
    // Its own audit row (budget_schedule_update), as the route writes it.
    const out = await patchBudgetSchedule(loaded.id!, { windows: after.windows }, actorOf(actorUserId) as `user:${string}`)
    return !out ? 'not found' : 'invalid' in out ? out.invalid.error : null // 4b — a value the save refuses is said, not reported as done
  },
  effect: (l) => `The schedule "${l.name}" uses the new windows from its next window entry (if it is switched on); a window it is in now is not re-applied.`,
}

// ── harvest-policy (A14) ─────────────────────────────────────────────────────────────────────────────────

const HARVEST_FIELDS = ['minOrders', 'minClicks', 'maxAcosPct', 'windowDays', 'excludeExactMatched'] as const

/** The criteria a scope with no policy of its own falls back to, as tune-ad-engine judges them: the account's, else the defaults. */
async function accountCriteria(): Promise<State> {
  const row = await prisma.adsHarvestPolicy.findUnique({ where: { scopeGrain_scopeId_kind: workspaceKey({ scopeGrain: 'account', scopeId: HV_ACCOUNT_SCOPE, kind: 'graduate' }) } })
  const c = row ?? HV_DEFAULT_CRITERIA
  return { minOrders: c.minOrders, minClicks: c.minClicks, maxAcosPct: c.maxAcosPct ?? null, windowDays: c.windowDays, excludeExactMatched: c.excludeExactMatched }
}

/** Is a harvest scope one of this business's? A campaign, an ad group, a product line or a portfolio must exist here. */
async function harvestScopeName(grain: string, scopeId: string | null): Promise<string | null> {
  if (grain === 'account') return 'the whole account'
  if (!scopeId) return null
  if (grain === 'market') return `market ${scopeId}`
  if (grain === 'campaign') return (await prisma.campaign.findUnique({ where: { id: scopeId }, select: { name: true } }))?.name ?? null
  if (grain === 'adGroup') return (await prisma.adGroup.findUnique({ where: { id: scopeId }, select: { name: true } }))?.name ?? null
  if (grain === 'line') return (await prisma.product.findUnique({ where: { id: scopeId }, select: { name: true } }))?.name ?? null
  if (grain === 'portfolio') return (await prisma.campaign.findFirst({ where: { portfolioId: scopeId }, select: { id: true } })) ? `portfolio ${scopeId}` : null
  return null
}

const harvestPolicy: Spec = {
  automation: { id: 'A14', name: 'Harvest policy and destinations' },
  label: 'harvest policy',
  needsSubject: false,
  async load(input) {
    const grain = String(input.values.scopeGrain ?? '') as HvPolicyGrain
    if (!(HARVEST_GRAINS as readonly string[]).includes(grain)) return `harvestPolicy.scopeGrain: one of ${HARVEST_GRAINS.join(', ')}`
    const scopeId = grain === 'account' ? null : String(input.values.scopeId ?? '').trim() || null
    if (grain === 'market' && scopeId?.toLowerCase() === 'all') return '"all" is not a market — use the account grain'
    const name = await harvestScopeName(grain, grain === 'market' ? scopeId?.toUpperCase() ?? null : scopeId)
    if (!name) return scopeId ? `there is no ${grain} ${scopeId} in this business (not found)` : `harvestPolicy.scopeId: a ${grain} policy needs its ${grain} id`
    const key = { scopeGrain: grain, scopeId: grain === 'market' ? scopeId!.toUpperCase() : scopeId }
    const row = await prisma.adsHarvestPolicy.findUnique({ where: { scopeGrain_scopeId_kind: workspaceKey({ scopeGrain: grain, scopeId: key.scopeId ?? HV_ACCOUNT_SCOPE, kind: 'graduate' }) } })
    const state = row
      ? { own: true, minOrders: row.minOrders, minClicks: row.minClicks, maxAcosPct: row.maxAcosPct, windowDays: row.windowDays, excludeExactMatched: row.excludeExactMatched }
      : { own: false, ...(grain === 'account' ? { ...HV_DEFAULT_CRITERIA, maxAcosPct: HV_DEFAULT_CRITERIA.maxAcosPct ?? null } : await accountCriteria()) }
    return { id: null, name: `harvest policy for ${name}`, key, basis: row?.updatedAt.toISOString() ?? null, state }
  },
  // (inherit: true — removing the scope's own policy — is planned in planTune, which reads what it falls back to.)
  next(loaded, values) {
    // The ranges are the tool's (and saveHarvestPolicy validates them again on write).
    return { ...merge(loaded.state, values, HARVEST_FIELDS), own: true }
  },
  raises(b, a) {
    const out: string[] = []
    if (Number(a.minOrders) < Number(b.minOrders)) out.push(`fewer orders qualify a term (${b.minOrders} → ${a.minOrders})`)
    if (Number(a.minClicks) < Number(b.minClicks)) out.push(`fewer clicks qualify a term (${b.minClicks} → ${a.minClicks})`)
    if (capRaised(b.maxAcosPct, a.maxAcosPct)) out.push(a.maxAcosPct == null ? `the ACOS ceiling (${b.maxAcosPct}%) is cleared` : `the ACOS ceiling rises (${b.maxAcosPct}% → ${a.maxAcosPct}%)`)
    if (Number(a.windowDays) > Number(b.windowDays)) out.push(`a longer window qualifies more terms (${b.windowDays} → ${a.windowDays} days)`)
    if (a.excludeExactMatched === false && b.excludeExactMatched !== false) out.push('terms already matched exactly qualify again')
    if (b.own && !a.own) out.push('the scope falls back to the policy above it, which may be looser')
    return out
  },
  async write(loaded, before, after, actorUserId) {
    const svc = await import('./harvest-policy.service.js')
    const grain = loaded.key!.scopeGrain as HvPolicyGrain
    try {
      if (!after.own) await svc.deleteHarvestPolicy(grain, loaded.key!.scopeId)
      else await svc.saveHarvestPolicy({ scopeGrain: grain, scopeId: loaded.key!.scopeId, criteria: { minOrders: Number(after.minOrders), minClicks: Number(after.minClicks), maxAcosPct: after.maxAcosPct as number | null, windowDays: Number(after.windowDays), excludeExactMatched: after.excludeExactMatched !== false }, updatedBy: actorOf(actorUserId) })
    } catch (e) {
      return (e as Error).message
    }
    await auditTune(actorUserId, 'HARVEST_POLICY', `${grain}:${loaded.key!.scopeId ?? HV_ACCOUNT_SCOPE}`, before, after)
    return null
  },
  effect: (l) => `The ${l.name} applies to the next harvest read and promotion; the terms already promoted stay.`,
}

// ── ebay-campaign-policy (E1) ────────────────────────────────────────────────────────────────────────────

const EBAY_FIELDS = ['posture', 'protected', 'rateCapPct', 'rateFloorPct', 'bidCapCents', 'bidFloorCents'] as const

const ebayCampaignPolicy: Spec = {
  automation: { id: 'E1', name: 'eBay ads rules' },
  label: 'eBay campaign policy',
  needsSubject: true,
  async load(input) {
    const c = await prisma.ebayCampaign.findUnique({ where: { id: input.subjectId! }, include: { automationPolicy: true } })
    if (!c) return `there is no eBay campaign ${input.subjectId} in this business (not found)`
    const { policyView } = await import('../marketing/ebay-campaign-policy.service.js')
    return { id: c.id, name: c.name, basis: c.automationPolicy?.updatedAt.toISOString() ?? null, state: { ...policyView(c.automationPolicy) } }
  },
  next(loaded, values) {
    const out = merge(loaded.state, values, EBAY_FIELDS)
    if (out.rateCapPct != null && out.rateFloorPct != null && Number(out.rateFloorPct) > Number(out.rateCapPct)) return 'ebayCampaignPolicy: the rate floor cannot exceed the rate cap'
    return { ...out, rateCapPct: round2(out.rateCapPct), rateFloorPct: round2(out.rateFloorPct) }
  },
  raises(b, a) {
    const out: string[] = []
    if (a.posture !== b.posture) out.push(`its posture changes (${b.posture} → ${a.posture}): which rules act on it changes, the rules that lower rates included`)
    if (a.protected !== b.protected) out.push(a.protected ? 'protected, no rule acts on it — the rules that lower rates included' : 'unprotected, rules act on it again')
    if (capRaised(b.rateCapPct, a.rateCapPct)) out.push(a.rateCapPct == null ? `its ad-rate cap (${b.rateCapPct}%) is cleared` : `its ad-rate cap rises (${b.rateCapPct}% → ${a.rateCapPct}%)`)
    if (Number(a.rateFloorPct ?? 0) > Number(b.rateFloorPct ?? 0)) out.push(`its ad-rate floor rises (${show(b.rateFloorPct)} → ${a.rateFloorPct}%), which holds rates up`)
    if (capRaised(b.bidCapCents, a.bidCapCents)) out.push(a.bidCapCents == null ? `its bid cap (${b.bidCapCents}¢) is cleared` : `its bid cap rises (${b.bidCapCents}¢ → ${a.bidCapCents}¢)`)
    if (Number(a.bidFloorCents ?? 0) > Number(b.bidFloorCents ?? 0)) out.push(`its bid floor rises (${show(b.bidFloorCents)} → ${a.bidFloorCents}¢), which holds bids up`)
    return out
  },
  async write(loaded, before, after, actorUserId) {
    const { setEbayCampaignPolicy } = await import('../marketing/ebay-campaign-policy.service.js')
    const changed = Object.fromEntries(EBAY_FIELDS.filter((f) => after[f] !== before[f]).map((f) => [f, after[f]]))
    // Its own audit row (set_automation_policy), as the route writes it.
    const out = await setEbayCampaignPolicy(loaded.id!, changed, actorUserId)
    return out.ok ? null : String((out as { body: { error?: string } }).body.error ?? 'refused')
  },
  effect: (l) => `The eBay rules read the campaign "${l.name}"'s policy at their next run. Local governance: nothing is sent to eBay.`,
}

// ── account-target-acos and breaker (A3) ─────────────────────────────────────────────────────────────────

async function adsStateRow() {
  return prisma.adsAutomationState.findUnique({ where: { id: 'singleton' } })
}

const accountTargetAcos: Spec = {
  automation: { id: 'A3', name: 'Ads dial, halt and anomaly breaker' },
  label: 'account target ACOS',
  needsSubject: false,
  async load() {
    const row = await adsStateRow()
    return { id: null, name: 'the account default target ACOS', basis: row?.updatedAt.toISOString() ?? null, state: { targetAcosPct: row?.defaultTargetAcosPct ?? null } }
  },
  next(loaded, values) {
    return values.targetAcosPct === undefined ? loaded.state : { targetAcosPct: values.targetAcosPct }
  },
  raises(b, a) {
    if (a.targetAcosPct == null) return []
    const out: string[] = []
    // W0 — the bid optimiser reads it too, for every campaign without a target of its own and no rule or plan target
    // (ads-target-acos-resolver.ts).
    if (b.targetAcosPct == null) {
      out.push(`the bid optimiser (auto-bid, autopilot plans, "Optimise bids to target ACOS" rules) moves every campaign without a target ACOS of its own toward ${a.targetAcosPct}% (unless a rule or plan sets its own), instead of profit data or a flat 30%`)
      out.push(`target-ACOS bid rules without a target of their own start bidding to ${a.targetAcosPct}%`)
    } else if (Number(a.targetAcosPct) > Number(b.targetAcosPct)) out.push(`a higher target ACOS lets bids rise (${b.targetAcosPct}% → ${a.targetAcosPct}%)`)
    return out
  },
  async write(_loaded, before, after, actorUserId) {
    const { setDefaultTargetAcosPct } = await import('./ads-automation-state.service.js')
    await setDefaultTargetAcosPct(after.targetAcosPct as number | null, actorOf(actorUserId))
    await auditTune(actorUserId, 'ADS_AUTOMATION_STATE', 'default-target-acos', before, after)
    return null
  },
  effect: () => 'From their next run, the bid optimiser (auto-bid, autopilot plans, "Optimise bids to target ACOS" rules) moves every campaign without a target ACOS of its own toward it (unless a rule or plan sets its own), and bid rules that set a bid from a target ACOS and carry no target of their own use it.',
}

const breaker: Spec = {
  automation: { id: 'A3', name: 'Ads dial, halt and anomaly breaker' },
  label: 'anomaly breaker',
  needsSubject: false,
  async load() {
    const row = await adsStateRow()
    return { id: null, name: 'the ads anomaly breaker', basis: row?.updatedAt.toISOString() ?? null, state: { maxHourlySpendCentsEur: row?.maxHourlySpendCentsEur ?? null, maxActionsPerHour: row?.maxActionsPerHour ?? null } }
  },
  next(loaded, values) {
    return merge(loaded.state, values, ['maxHourlySpendCentsEur', 'maxActionsPerHour'])
  },
  raises(b, a) {
    const out: string[] = []
    const spend = (s: State) => Number(s.maxHourlySpendCentsEur ?? BREAKER_DEFAULTS.maxHourlySpendCentsEur)
    const actions = (s: State) => Number(s.maxActionsPerHour ?? BREAKER_DEFAULTS.maxActionsPerHour)
    if (spend(a) > spend(b)) out.push(`the breaker trips later: hourly spend ${euro(spend(b))} → ${euro(spend(a))}`)
    if (actions(a) > actions(b)) out.push(`the breaker trips later: ${actions(b)} → ${actions(a)} actions an hour`)
    return out
  },
  async write(_loaded, before, after, actorUserId) {
    const { setGuardThresholds } = await import('./ads-automation-state.service.js')
    await setGuardThresholds({ maxHourlySpendCentsEur: after.maxHourlySpendCentsEur as number | null, maxActionsPerHour: after.maxActionsPerHour as number | null })
    await auditTune(actorUserId, 'ADS_AUTOMATION_STATE', 'breaker', before, after)
    return null
  },
  effect: () => `The breaker checks the new limits at its next check (a limit of none means the default: ${euro(BREAKER_DEFAULTS.maxHourlySpendCentsEur)} and ${BREAKER_DEFAULTS.maxActionsPerHour} actions an hour).`,
}

const SPECS: Record<EngineSetting, Spec> = {
  'budget-pool': budgetPool,
  'coverage-set': coverageSet,
  'rank-target': rankTarget,
  'budget-schedule': budgetSchedule,
  'harvest-policy': harvestPolicy,
  'ebay-campaign-policy': ebayCampaignPolicy,
  'account-target-acos': accountTargetAcos,
  breaker,
}

// ── plan / apply / read back ─────────────────────────────────────────────────────────────────────────────

type Planned = { ok: true; plan: TunePlan; loaded: Loaded; before: State; after: State } | { ok: false; error: string }

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export async function planTune(input: TuneInput): Promise<Planned> {
  const spec = SPECS[input.setting]
  if (!spec) return { ok: false, error: `setting: one of ${ENGINE_SETTINGS.join(', ')}` }
  if (spec.needsSubject && !input.subjectId) return { ok: false, error: `Name the ${spec.label} to tune (subjectId), from list-automations or automation-detail (${spec.automation.id}).` }
  const loaded = await spec.load(input)
  if (typeof loaded === 'string') return { ok: false, error: `${spec.automation.name}: ${loaded}.` }
  let after: State | string
  if (input.setting === 'harvest-policy' && input.values.inherit === true) {
    after = loaded.state.own ? { own: false, ...(loaded.key!.scopeGrain === 'account' ? { ...HV_DEFAULT_CRITERIA, maxAcosPct: HV_DEFAULT_CRITERIA.maxAcosPct ?? null } : await accountCriteria()) } : `${loaded.name} has no policy of its own to remove`
  } else {
    after = spec.next(loaded, input.values)
  }
  if (typeof after === 'string') return { ok: false, error: `${loaded.name}: ${after}.` }
  const before = loaded.state
  const changes: TunePlan['changes'] = {}
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) if (!same(before[field], after[field])) changes[field] = { from: before[field] ?? null, to: after[field] ?? null }
  // A harvest scope saved with the criteria it already inherits still gets its own policy: that is a change.
  if (Object.keys(changes).length === 0) return { ok: false, error: `${loaded.name}: nothing to change — give the ${spec.label}'s new values.` }
  const raises = spec.raises(before, after, loaded)
  return {
    ok: true, loaded, before, after,
    plan: {
      action: 'tune-ad-engine', setting: input.setting, automation: spec.automation, subject: { id: loaded.id, name: loaded.name },
      changes, raises, spend: raises.length ? 'can-rise' : 'cannot-rise', basis: loaded.basis,
      effect: spec.effect(loaded),
    },
  }
}

const recordOf = (input: TuneInput, loaded: Loaded, state: State): TuneRecord => ({
  setting: input.setting, subjectId: loaded.id, ...(loaded.key ? { key: loaded.key } : {}), name: loaded.name, state,
})

export async function applyTune(input: TuneInput, actorUserId: string | null): Promise<{ ok: true; plan: TunePlan; before: TuneRecord; after: TuneRecord } | { ok: false; error: string }> {
  const planned = await planTune(input)
  if ('error' in planned) return planned
  const error = await SPECS[input.setting].write(planned.loaded, planned.before, planned.after, actorUserId)
  if (error) return { ok: false, error: `${planned.loaded.name}: not changed — ${error}` }
  const now = await tuneStateNow(recordOf(input, planned.loaded, planned.after))
  return { ok: true, plan: planned.plan, before: recordOf(input, planned.loaded, planned.before), after: now ?? recordOf(input, planned.loaded, planned.after) }
}

/** The setting as it is now, in the shape the change record stores (undo compares it with `after`). */
export async function tuneStateNow(record: TuneRecord): Promise<TuneRecord | null> {
  const spec = SPECS[record.setting]
  const values: Values = record.key ? { scopeGrain: record.key.scopeGrain, scopeId: record.key.scopeId } : {}
  const loaded = await spec.load({ setting: record.setting, subjectId: record.subjectId ?? undefined, values })
  if (typeof loaded === 'string') return null
  return { setting: record.setting, subjectId: loaded.id, ...(loaded.key ? { key: loaded.key } : {}), name: loaded.name, state: loaded.state }
}

/** The tool's argument object for each setting (undo builds its request with it). */
export const SETTING_ARG: Record<EngineSetting, string> = {
  'budget-pool': 'budgetPool',
  'coverage-set': 'coverageSet',
  'rank-target': 'rankTarget',
  'budget-schedule': 'budgetSchedule',
  'harvest-policy': 'harvestPolicy',
  'ebay-campaign-policy': 'ebayCampaignPolicy',
  'account-target-acos': 'accountTargetAcos',
  breaker: 'breaker',
}

/** tune-ad-engine's arguments that put a setting back as `before` records it (its undo). */
export function restoreArgsOf(before: TuneRecord): Record<string, unknown> {
  const state = { ...before.state }
  const args: Record<string, unknown> = { setting: before.setting, ...(before.subjectId ? { subjectId: before.subjectId } : {}) }
  if (before.setting === 'harvest-policy') {
    const own = state.own
    delete state.own
    args.harvestPolicy = own ? { ...before.key, ...state } : { ...before.key, inherit: true }
    if (before.key?.scopeId == null) delete (args.harvestPolicy as Values).scopeId
    return args
  }
  args[SETTING_ARG[before.setting]] = state
  return args
}

