/**
 * AIAD.1/.4 — AI Advertising goal materialization. Turns an AdProductGoal (the operator-facing
 * goal from the AI Goal builder) into the campaign scaffold the AI actually drives:
 *
 *   AUTO (discovery) → RESEARCH (broad seeds) → PERF (exact seeds, harvest destination)
 *   [+ PAT (product targeting) when the goal carries product targets]
 *
 * AIAD.4 split this into a PURE PLANNER + an executor. `planGoalScaffold` computes every
 * campaign, keyword, negative, rule and guardrail the launch would create — the builder's
 * "what will be built" preview renders exactly this plan, and `materializeProductGoal`
 * executes exactly this plan, so the preview cannot drift from reality.
 *
 * Strict Control mode builds one scaffold per product (independent budgets); Shared Budget
 * builds one scaffold for the whole product set. Rides the same gated local-first create path
 * as the SP Super Wizard launch (ads-create.service), including the instant per-campaign
 * allowlist so sub-entities can push. Alongside the campaigns it creates:
 *   - one Harvest & Negate + one Negative Targeting AutomationRule per scaffold, in the
 *     SPW-proven `harvest_and_negate` shape (propose-first: enabled + dryRun + control:manual);
 *   - one AutopilotPlan (autonomy SUGGEST — the ad-autopilot cron proposes, never writes,
 *     until the operator graduates it), linked back onto the goal.
 *
 * Governed transparency (AIAD decision Q2): campaigns stay visible and editable everywhere —
 * ownership is carried by the "[AI]" name prefix and the goal linkage, never by a lockout.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { GOAL_PRESETS, DEFAULT_GUARDRAILS, type Goal } from './autopilot/presets.js'
import type { GoalProduct } from './ai-product-goal.service.js'

export class MaterializeError extends Error {
  constructor(message: string, public statusCode = 400) { super(message) }
}

export type ScaffoldRole = 'AUTO' | 'RESEARCH' | 'PERF' | 'PAT'
export interface GoalCampaignRef { id: string; role: ScaffoldRole; label: string }

// aiTarget (builder vocabulary) → Conductor goal preset. The five-strategy superset:
// IMPRESSION (launch traffic) · SALES (balanced) · ROAS (profit) · LIQUIDATE · RANK (defend).
const AI_TARGET_GOAL: Record<string, Goal> = {
  IMPRESSION: 'LAUNCH', SALES: 'BALANCED', ROAS: 'PROFIT', LIQUIDATE: 'LIQUIDATE', RANK: 'DEFEND_RANK',
}
const ROLE_LABEL: Record<ScaffoldRole, string> = { AUTO: 'Auto', RESEARCH: 'Research', PERF: 'Performance', PAT: 'Products' }
const BASE_BID_EUR = 0.75
// AT.2 smart defaults (mirrors the SPW auto-group multipliers).
const AUTO_GROUPS: Array<{ key: string; mult: number }> = [
  { key: 'CLOSE_MATCH', mult: 1.0 }, { key: 'SUBSTITUTES', mult: 1.1 },
  { key: 'LOOSE_MATCH', mult: 0.65 }, { key: 'COMPLEMENTS', mult: 0.6 },
]

/** Budget split across the scaffold roles that will actually exist. */
function roleShares(hasResearch: boolean, hasPat: boolean): Array<[ScaffoldRole, number]> {
  if (hasResearch && hasPat) return [['AUTO', 0.25], ['RESEARCH', 0.25], ['PERF', 0.3], ['PAT', 0.2]]
  if (hasResearch) return [['AUTO', 0.3], ['RESEARCH', 0.3], ['PERF', 0.4]]
  if (hasPat) return [['AUTO', 0.35], ['PERF', 0.35], ['PAT', 0.3]]
  return [['AUTO', 0.5], ['PERF', 0.5]]
}

// Harvest aggressiveness → thresholds (same ladder as autopilot/coordination.ts).
function harvestThresholds(goal: Goal) {
  const h = GOAL_PRESETS[goal].harvest
  const minOrders = h === 'aggressive' ? 1 : h === 'medium' ? 2 : 3
  const minNegSpendEur = h === 'aggressive' ? 10 : h === 'medium' ? 20 : 30
  return { minOrders, minNegSpendEur }
}

// ── The pure planner ──────────────────────────────────────────────────────────

export interface GoalLike {
  name: string; aiTarget: string; budgetMode: string
  totalBudgetCents?: number | null
  products: GoalProduct[]
  seedKeywords?: string[]; excludeKeywords?: string[]
  productTargets?: string[]; excludeAsins?: string[]
  marketplace?: string | null; portfolioId?: string | null
  targetAcosPct?: number | null; bidMinCents?: number | null; bidMaxCents?: number | null
}

export interface PlannedCampaign {
  setLabel: string; role: ScaffoldRole; name: string
  targetingType: 'AUTO' | 'MANUAL'
  budgetCents: number
  products: GoalProduct[]
  seeds: Array<{ text: string; matchType: 'BROAD' | 'EXACT'; bidCents: number }>
  autoGroups: Array<{ key: string; bidEur: number }>
  productTargets: string[]
  negativeKeywords: Array<{ text: string; matchType: 'EXACT' | 'PHRASE' }>
  negativeAsins: string[]
}
/** Bid evidence (ai-goal-suggest resolveGoalBids) — passed at BOTH preview and launch. */
export interface ScaffoldBidOpts { bidCentsByKeyword?: Record<string, number>; autoBaseCents?: number }
export interface PlannedRule { kind: 'harvest' | 'negative'; name: string; setLabel: string; minOrders: number; minNegSpendEur: number }
export interface GoalScaffold {
  marketplace: string
  planGoal: Goal
  autonomy: 'SUGGEST'
  campaigns: PlannedCampaign[]
  rules: PlannedRule[]
  guardrails: { targetAcosPct: number; bidMinCents: number; bidMaxCents: number; maxDailySpendCents: number; budgetMaxCents: number; rampPct: number; neverPause: true }
  totalDailyBudgetCents: number
  warnings: string[]
}

/** Compute the exact scaffold a launch would create. Pure — no I/O, no writes. */
export function planGoalScaffold(goal: GoalLike, bidOpts?: ScaffoldBidOpts): GoalScaffold {
  const bidOf = (text: string) => bidOpts?.bidCentsByKeyword?.[text.toLowerCase()] ?? Math.round(BASE_BID_EUR * 100)
  const autoBase = (bidOpts?.autoBaseCents ?? Math.round(BASE_BID_EUR * 100)) / 100
  const products = Array.isArray(goal.products) ? goal.products : []
  if (!products.length) throw new MaterializeError('goal has no products', 400)
  const warnings: string[] = []
  const marketplace = (goal.marketplace ?? '').trim() || 'IT'
  if (!(goal.marketplace ?? '').trim()) warnings.push('No marketplace on the goal — defaulting to IT.')
  const seeds = (goal.seedKeywords ?? []).filter(Boolean)
  const excludeKw = (goal.excludeKeywords ?? []).filter(Boolean)
  const productTargets = (goal.productTargets ?? []).filter(Boolean)
  const excludeAsins = (goal.excludeAsins ?? []).filter(Boolean)
  const planGoal = AI_TARGET_GOAL[goal.aiTarget] ?? 'BALANCED'
  const preset = GOAL_PRESETS[planGoal]

  const sets = goal.budgetMode === 'STRICT'
    ? products.map((p) => ({ label: p.asin || p.sku || p.name || 'Product', products: [p], budgetCents: Math.round(Number(p.budgetCents) || 0) }))
    : [{ label: 'Shared', products, budgetCents: Math.round(Number(goal.totalBudgetCents) || 0) }]
  const multiSet = sets.length > 1
  const shares = roleShares(seeds.length > 0, productTargets.length > 0)

  if (!seeds.length) warnings.push('No seed keywords — the Research campaign is skipped and Performance starts empty until the harvest promotes its first winners from Auto.')

  const negativeKeywords = excludeKw.flatMap((text) => (['EXACT', 'PHRASE'] as const).map((matchType) => ({ text, matchType })))
  const campaigns: PlannedCampaign[] = []
  let maxCampaignBudgetCents = 0
  let clamped = 0
  for (const set of sets) {
    for (const [role, share] of shares) {
      const raw = Math.round(set.budgetCents * share)
      const budgetCents = Math.max(100, raw)
      if (raw < 100) clamped += 1
      maxCampaignBudgetCents = Math.max(maxCampaignBudgetCents, budgetCents)
      campaigns.push({
        setLabel: set.label, role,
        name: `[AI] ${goal.name}${multiSet ? ` · ${set.label}` : ''} · ${ROLE_LABEL[role]}`.slice(0, 128),
        targetingType: role === 'AUTO' ? 'AUTO' : 'MANUAL',
        budgetCents,
        products: set.products,
        seeds: role === 'RESEARCH' ? seeds.map((text) => ({ text, matchType: 'BROAD' as const, bidCents: bidOf(text) }))
          : role === 'PERF' ? seeds.map((text) => ({ text, matchType: 'EXACT' as const, bidCents: bidOf(text) })) : [],
        autoGroups: role === 'AUTO' ? AUTO_GROUPS.map((g) => ({ key: g.key, bidEur: Math.round(autoBase * g.mult * 100) / 100 })) : [],
        productTargets: role === 'PAT' ? productTargets : [],
        negativeKeywords: role === 'AUTO' || role === 'RESEARCH' ? negativeKeywords : [],
        negativeAsins: role === 'AUTO' ? excludeAsins : [],
      })
    }
  }
  if (clamped > 0) warnings.push(`${clamped} campaign budget${clamped === 1 ? '' : 's'} fell below Amazon's €1/day floor and clamp${clamped === 1 ? 's' : ''} up to €1.00 — the total will slightly exceed the goal budget.`)

  const { minOrders, minNegSpendEur } = harvestThresholds(planGoal)
  const rules: PlannedRule[] = sets.flatMap((set) => {
    const tag = multiSet ? ` (${set.label})` : ''
    return [
      { kind: 'harvest' as const, name: `[AI] ${goal.name}${tag} — Harvest & Negate`.slice(0, 120), setLabel: set.label, minOrders, minNegSpendEur },
      { kind: 'negative' as const, name: `[AI] ${goal.name}${tag} — Negative Targeting`.slice(0, 120), setLabel: set.label, minOrders, minNegSpendEur },
    ]
  })

  const totalDailyBudgetCents = campaigns.reduce((n, c) => n + c.budgetCents, 0)
  const targetAcosPct = goal.targetAcosPct != null && goal.targetAcosPct >= 5 && goal.targetAcosPct <= 300
    ? Math.round(goal.targetAcosPct) : DEFAULT_GUARDRAILS.targetAcosPct
  const bidMinCents = goal.bidMinCents != null && goal.bidMinCents >= 5 ? Math.round(goal.bidMinCents) : DEFAULT_GUARDRAILS.bidMinCents
  const bidMaxCents = goal.bidMaxCents != null && goal.bidMaxCents > bidMinCents ? Math.round(goal.bidMaxCents) : DEFAULT_GUARDRAILS.bidMaxCents

  return {
    marketplace, planGoal, autonomy: 'SUGGEST', campaigns, rules,
    guardrails: {
      targetAcosPct, bidMinCents, bidMaxCents,
      maxDailySpendCents: totalDailyBudgetCents,
      budgetMaxCents: Math.max(maxCampaignBudgetCents * 2, 1000),
      rampPct: preset.rampPct, neverPause: true,
    },
    totalDailyBudgetCents, warnings,
  }
}

// ── The executor ──────────────────────────────────────────────────────────────

export async function materializeProductGoal(goalId: string, userId?: string) {
  const goal = await prisma.adProductGoal.findUnique({ where: { id: goalId } })
  if (!goal) throw new MaterializeError('goal not found', 404)
  if (goal.status === 'ARCHIVED') throw new MaterializeError('goal is archived', 400)
  if (goal.materializedAt) throw new MaterializeError('goal is already materialized', 409)

  // Same bid evidence the preview showed — resolveGoalBids at both ends, so they cannot differ.
  const { resolveGoalBids } = await import('./ai-goal-suggest.service.js')
  const bidOpts = await resolveGoalBids(goal.seedKeywords ?? [], goal.marketplace)
  const scaffold = planGoalScaffold({
    name: goal.name, aiTarget: goal.aiTarget, budgetMode: goal.budgetMode,
    totalBudgetCents: goal.totalBudgetCents,
    products: (Array.isArray(goal.products) ? goal.products : []) as GoalProduct[],
    seedKeywords: goal.seedKeywords, excludeKeywords: goal.excludeKeywords,
    productTargets: goal.productTargets, excludeAsins: goal.excludeAsins,
    marketplace: goal.marketplace, portfolioId: goal.portfolioId,
    targetAcosPct: goal.targetAcosPct, bidMinCents: goal.bidMinCents, bidMaxCents: goal.bidMaxCents,
  }, bidOpts)

  const {
    createCampaignLocal, createAdGroupLocal, createKeywordLocal, createProductAdLocal,
    createTargetLocal, createNegativeKeywordLocal, createNegativeProductTargetLocal,
    settleLaunchPortfolios,
  } = await import('./ads-create.service.js')

  const refs: GoalCampaignRef[] = []
  const errors: string[] = [...scaffold.warnings]
  // setLabel → role → created ids (for the harvest rules' sources/destinations).
  const agBySet = new Map<string, Partial<Record<ScaffoldRole, { campaignId: string; adGroupId: string }>>>()

  for (const pc of scaffold.campaigns) {
    try {
      const camp = await createCampaignLocal({
        name: pc.name, type: 'SP', marketplace: scaffold.marketplace,
        targetingType: pc.targetingType,
        dailyBudgetEur: pc.budgetCents / 100, biddingStrategy: 'legacyForSales',
        portfolioId: goal.portfolioId ?? undefined, userId,
      })
      // Same launch repair as SPW: allowlist BEFORE sub-entities, or the per-campaign gate
      // skips every keyword/product-ad and the campaign lands empty on Amazon.
      try { await prisma.campaign.update({ where: { id: camp.id }, data: { liveBidWritesEnabled: true } }) } catch (e) { logger.warn('[AIAD] allowlist failed', { error: (e as Error).message }) }
      const ag = await createAdGroupLocal({ campaignId: camp.id, name: `${ROLE_LABEL[pc.role]} Ad Group`, defaultBidEur: BASE_BID_EUR, userId })
      const set = agBySet.get(pc.setLabel) ?? {}
      set[pc.role] = { campaignId: camp.id, adGroupId: ag.id }
      agBySet.set(pc.setLabel, set)

      for (const p of pc.products) {
        try { await createProductAdLocal({ adGroupId: ag.id, asin: p.asin, sku: p.sku, productId: p.productId, userId }) }
        catch (e) { errors.push(`product ad ${p.asin ?? p.sku}: ${(e as Error).message}`) }
      }
      for (const g of pc.autoGroups) {
        try { await createTargetLocal({ adGroupId: ag.id, kind: 'AUTO', value: g.key, bidEur: g.bidEur, userId }) }
        catch (e) { errors.push(`auto group ${g.key}: ${(e as Error).message}`) }
      }
      for (const kw of pc.seeds) {
        try { await createKeywordLocal({ adGroupId: ag.id, keywordText: kw.text, matchType: kw.matchType, bidEur: kw.bidCents / 100, userId }) }
        catch (e) { errors.push(`${kw.matchType.toLowerCase()} "${kw.text}": ${(e as Error).message}`) }
      }
      for (const asin of pc.productTargets) {
        try { await createTargetLocal({ adGroupId: ag.id, kind: 'PRODUCT', value: asin, bidEur: BASE_BID_EUR, userId }) }
        catch (e) { errors.push(`product target ${asin}: ${(e as Error).message}`) }
      }
      for (const nk of pc.negativeKeywords) {
        try { await createNegativeKeywordLocal({ adGroupId: ag.id, keywordText: nk.text, matchType: nk.matchType, userId }) }
        catch (e) { errors.push(`neg "${nk.text}": ${(e as Error).message}`) }
      }
      for (const asin of pc.negativeAsins) {
        try { await createNegativeProductTargetLocal({ adGroupId: ag.id, asin, userId }) }
        catch (e) { errors.push(`neg ASIN ${asin}: ${(e as Error).message}`) }
      }
      refs.push({ id: camp.id, role: pc.role, label: pc.name })
    } catch (e) {
      errors.push(`campaign ${pc.name}: ${(e as Error).message}`)
      logger.error('[AIAD] campaign create failed', { goalId, name: pc.name, error: (e as Error).message })
    }
  }
  if (!refs.length) throw new MaterializeError(`no campaigns could be created: ${errors[0] ?? 'unknown error'}`, 500)

  // ── Harvest & Negate + Negative Targeting rules per scaffold (SPW-proven shape, propose-first) ──
  const linkedRuleIds: Array<{ module: 'harvest' | 'negate'; ruleId: string }> = []
  for (const pr of scaffold.rules) {
    const set = agBySet.get(pr.setLabel) ?? {}
    const srcRoles: ScaffoldRole[] = ['AUTO', 'RESEARCH']
    const sources = srcRoles
      .map((r) => set[r])
      .filter((x): x is { campaignId: string; adGroupId: string } => !!x)
      .map((x) => ({
        adGroupId: x.adGroupId, campaignId: x.campaignId, harvestFrom: true,
        graduate: pr.kind === 'harvest' ? ['EXACT'] : [], negate: pr.kind === 'negative' ? ['EXACT'] : [],
        graduateProduct: false, negateProduct: pr.kind === 'negative' ? !!set.PAT : false,
      }))
    const destinations: Record<string, string> = {}
    if (set.PERF) destinations.EXACT = set.PERF.adGroupId
    if (set.PAT) destinations.PRODUCT = set.PAT.adGroupId
    if (!sources.length || !set.PERF) continue
    try {
      const rule = await prisma.automationRule.create({ data: {
        name: pr.name, description: 'Created by AI Advertising goal', domain: 'advertising', trigger: 'SCHEDULE',
        conditions: [] as never,
        actions: [{
          type: 'harvest_and_negate', control: 'manual', windowDays: 60,
          minSpendCents: pr.kind === 'harvest' ? 1000 : pr.minNegSpendEur * 100,
          minOrders: pr.minOrders, graduationBidEur: 0.5, sources, destinations,
          mode: pr.kind === 'harvest' ? 'harvest' : 'negative',
        }] as never,
        enabled: true, dryRun: true, maxExecutionsPerDay: 3, createdBy: userId ?? 'ai-goal',
      } })
      linkedRuleIds.push({ module: pr.kind === 'harvest' ? 'harvest' : 'negate', ruleId: rule.id })
    } catch (e) { errors.push(`rule ${pr.name}: ${(e as Error).message}`) }
  }

  // ── Portfolio settle + launch receipt (same post-launch checks as SPW) ──
  const createdIds = refs.map((r) => r.id)
  let portfolioCheck: unknown = null
  try { portfolioCheck = await settleLaunchPortfolios(createdIds) } catch { /* non-fatal */ }
  let verification: unknown = null
  try {
    const { verifyLaunch } = await import('./ads-launch-verify.service.js')
    verification = await verifyLaunch(createdIds)
  } catch { /* non-fatal */ }

  // ── The AutopilotPlan the ad-autopilot cron drives (SUGGEST: propose-only until graduated) ──
  const plan = await prisma.autopilotPlan.create({ data: {
    name: goal.name, marketplace: scaffold.marketplace, productGroupName: goal.name,
    campaignIds: createdIds as never,
    goal: scaffold.planGoal, autonomy: scaffold.autonomy,
    guardrails: scaffold.guardrails as never,
    modules: {
      bid: { on: true }, budget: { on: true }, placement: { on: true },
      rank: { on: false }, dayparting: { on: false },
      harvest: { on: true }, negate: { on: true },
    } as never,
    linkedRuleIds: linkedRuleIds as never,
    createdBy: userId ?? 'ai-goal',
  } })

  const updated = await prisma.adProductGoal.update({
    where: { id: goal.id },
    data: { campaignIds: refs as never, planId: plan.id, materializedAt: new Date() },
  })
  logger.info('[AIAD] goal materialized', { goalId: goal.id, planId: plan.id, campaigns: refs.length, rules: linkedRuleIds.length, errors: errors.length })
  return { goal: updated, planId: plan.id, campaigns: refs, rules: linkedRuleIds, portfolioCheck, verification, errors }
}
