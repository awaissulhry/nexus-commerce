/**
 * AIAD.1 — AI Advertising goal materialization. Turns an AdProductGoal (the operator-facing
 * goal from the AI Goal builder) into the campaign scaffold the AI actually drives:
 *
 *   AUTO (discovery) → RESEARCH (broad seeds) → PERF (exact seeds, harvest destination)
 *   [+ PAT (product targeting) when the goal carries product targets]
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
import { GOAL_PRESETS, type Goal } from './autopilot/presets.js'
import type { GoalProduct } from './ai-product-goal.service.js'

export class MaterializeError extends Error {
  constructor(message: string, public statusCode = 400) { super(message) }
}

export type ScaffoldRole = 'AUTO' | 'RESEARCH' | 'PERF' | 'PAT'
export interface GoalCampaignRef { id: string; role: ScaffoldRole; label: string }

// aiTarget (builder vocabulary) → Conductor goal preset.
const AI_TARGET_GOAL: Record<string, Goal> = { IMPRESSION: 'LAUNCH', SALES: 'BALANCED', ROAS: 'PROFIT' }
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

interface ScaffoldSet {
  label: string
  products: GoalProduct[]
  budgetCents: number
  ags: Partial<Record<ScaffoldRole, { campaignId: string; adGroupId: string }>>
}

export async function materializeProductGoal(goalId: string, userId?: string) {
  const goal = await prisma.adProductGoal.findUnique({ where: { id: goalId } })
  if (!goal) throw new MaterializeError('goal not found', 404)
  if (goal.status === 'ARCHIVED') throw new MaterializeError('goal is archived', 400)
  if (goal.materializedAt) throw new MaterializeError('goal is already materialized', 409)
  const products = (Array.isArray(goal.products) ? goal.products : []) as GoalProduct[]
  if (!products.length) throw new MaterializeError('goal has no products', 400)

  const marketplace = goal.marketplace || 'IT'
  const seeds = (goal.seedKeywords ?? []).filter(Boolean)
  const excludeKw = (goal.excludeKeywords ?? []).filter(Boolean)
  const productTargets = (goal.productTargets ?? []).filter(Boolean)
  const excludeAsins = (goal.excludeAsins ?? []).filter(Boolean)
  const planGoal = AI_TARGET_GOAL[goal.aiTarget] ?? 'BALANCED'
  const preset = GOAL_PRESETS[planGoal]

  const {
    createCampaignLocal, createAdGroupLocal, createKeywordLocal, createProductAdLocal,
    createTargetLocal, createNegativeKeywordLocal, createNegativeProductTargetLocal,
    settleLaunchPortfolios,
  } = await import('./ads-create.service.js')

  // Strict Control → one scaffold per product; Shared Budget → one scaffold for the set.
  const sets: ScaffoldSet[] = goal.budgetMode === 'STRICT'
    ? products.map((p) => ({ label: p.asin || p.sku || p.name || 'Product', products: [p], budgetCents: Math.round(Number(p.budgetCents) || 0), ags: {} }))
    : [{ label: 'Shared', products, budgetCents: Math.round(Number(goal.totalBudgetCents) || 0), ags: {} }]
  const multiSet = sets.length > 1
  const shares = roleShares(seeds.length > 0, productTargets.length > 0)

  const refs: GoalCampaignRef[] = []
  const errors: string[] = []
  let maxCampaignBudgetCents = 0

  for (const set of sets) {
    for (const [role, share] of shares) {
      // Amazon's €1/day floor per campaign; tiny budgets clamp up rather than dropping a role.
      const budgetCents = Math.max(100, Math.round(set.budgetCents * share))
      maxCampaignBudgetCents = Math.max(maxCampaignBudgetCents, budgetCents)
      const name = `[AI] ${goal.name}${multiSet ? ` · ${set.label}` : ''} · ${ROLE_LABEL[role]}`.slice(0, 128)
      try {
        const camp = await createCampaignLocal({
          name, type: 'SP', marketplace,
          targetingType: role === 'AUTO' ? 'AUTO' : 'MANUAL',
          dailyBudgetEur: budgetCents / 100, biddingStrategy: 'legacyForSales',
          portfolioId: goal.portfolioId ?? undefined, userId,
        })
        // Same launch repair as SPW: allowlist BEFORE sub-entities, or the per-campaign gate
        // skips every keyword/product-ad and the campaign lands empty on Amazon.
        try { await prisma.campaign.update({ where: { id: camp.id }, data: { liveBidWritesEnabled: true } }) } catch (e) { logger.warn('[AIAD] allowlist failed', { error: (e as Error).message }) }
        const ag = await createAdGroupLocal({ campaignId: camp.id, name: `${ROLE_LABEL[role]} Ad Group`, defaultBidEur: BASE_BID_EUR, userId })
        set.ags[role] = { campaignId: camp.id, adGroupId: ag.id }

        for (const p of set.products) {
          try { await createProductAdLocal({ adGroupId: ag.id, asin: p.asin, sku: p.sku, productId: p.productId, userId }) }
          catch (e) { errors.push(`product ad ${p.asin ?? p.sku}: ${(e as Error).message}`) }
        }

        if (role === 'AUTO') {
          for (const g of AUTO_GROUPS) {
            try { await createTargetLocal({ adGroupId: ag.id, kind: 'AUTO', value: g.key, bidEur: Math.round(BASE_BID_EUR * g.mult * 100) / 100, userId }) }
            catch (e) { errors.push(`auto group ${g.key}: ${(e as Error).message}`) }
          }
        } else if (role === 'RESEARCH') {
          for (const kw of seeds) {
            try { await createKeywordLocal({ adGroupId: ag.id, keywordText: kw, matchType: 'BROAD', bidEur: BASE_BID_EUR, userId }) }
            catch (e) { errors.push(`broad "${kw}": ${(e as Error).message}`) }
          }
        } else if (role === 'PERF') {
          for (const kw of seeds) {
            try { await createKeywordLocal({ adGroupId: ag.id, keywordText: kw, matchType: 'EXACT', bidEur: BASE_BID_EUR, userId }) }
            catch (e) { errors.push(`exact "${kw}": ${(e as Error).message}`) }
          }
        } else if (role === 'PAT') {
          for (const asin of productTargets) {
            try { await createTargetLocal({ adGroupId: ag.id, kind: 'PRODUCT', value: asin, bidEur: BASE_BID_EUR, userId }) }
            catch (e) { errors.push(`product target ${asin}: ${(e as Error).message}`) }
          }
        }

        // Excluded keywords bind where discovery happens (AUTO + RESEARCH), both negative match types.
        if (role === 'AUTO' || role === 'RESEARCH') {
          for (const kw of excludeKw) {
            for (const mt of ['EXACT', 'PHRASE'] as const) {
              try { await createNegativeKeywordLocal({ adGroupId: ag.id, keywordText: kw, matchType: mt, userId }) }
              catch (e) { errors.push(`neg "${kw}": ${(e as Error).message}`) }
            }
          }
        }
        // Excluded ASINs bind on the auto campaign (where product-page placements originate).
        if (role === 'AUTO') {
          for (const asin of excludeAsins) {
            try { await createNegativeProductTargetLocal({ adGroupId: ag.id, asin, userId }) }
            catch (e) { errors.push(`neg ASIN ${asin}: ${(e as Error).message}`) }
          }
        }
        refs.push({ id: camp.id, role, label: name })
      } catch (e) {
        errors.push(`campaign ${name}: ${(e as Error).message}`)
        logger.error('[AIAD] campaign create failed', { goalId, name, error: (e as Error).message })
      }
    }
  }
  if (!refs.length) throw new MaterializeError(`no campaigns could be created: ${errors[0] ?? 'unknown error'}`, 500)

  // ── Harvest & Negate + Negative Targeting rules per scaffold (SPW-proven shape, propose-first) ──
  const { minOrders, minNegSpendEur } = harvestThresholds(planGoal)
  const linkedRuleIds: Array<{ module: 'harvest' | 'negate'; ruleId: string }> = []
  for (const set of sets) {
    const sources = (['AUTO', 'RESEARCH'] as const)
      .map((r) => set.ags[r])
      .filter((x): x is { campaignId: string; adGroupId: string } => !!x)
      .map((x) => ({ adGroupId: x.adGroupId, campaignId: x.campaignId, harvestFrom: true, graduate: ['EXACT'], negate: [] as string[], graduateProduct: false, negateProduct: !!set.ags.PAT }))
    const destinations: Record<string, string> = {}
    if (set.ags.PERF) destinations.EXACT = set.ags.PERF.adGroupId
    if (set.ags.PAT) destinations.PRODUCT = set.ags.PAT.adGroupId
    if (!sources.length || !set.ags.PERF) continue
    const tag = multiSet ? ` (${set.label})` : ''
    try {
      const harvestRule = await prisma.automationRule.create({ data: {
        name: `[AI] ${goal.name}${tag} — Harvest & Negate`.slice(0, 120),
        description: 'Created by AI Advertising goal', domain: 'advertising', trigger: 'SCHEDULE',
        conditions: [] as never,
        actions: [{ type: 'harvest_and_negate', control: 'manual', windowDays: 60, minSpendCents: 1000, minOrders, graduationBidEur: 0.5, sources, destinations, mode: 'harvest' }] as never,
        enabled: true, dryRun: true, maxExecutionsPerDay: 3, createdBy: userId ?? 'ai-goal',
      } })
      linkedRuleIds.push({ module: 'harvest', ruleId: harvestRule.id })
      const negSources = sources.map((s) => ({ ...s, graduate: [] as string[], negate: ['EXACT'] }))
      const negRule = await prisma.automationRule.create({ data: {
        name: `[AI] ${goal.name}${tag} — Negative Targeting`.slice(0, 120),
        description: 'Created by AI Advertising goal', domain: 'advertising', trigger: 'SCHEDULE',
        conditions: [] as never,
        actions: [{ type: 'harvest_and_negate', control: 'manual', windowDays: 60, minSpendCents: minNegSpendEur * 100, minOrders, graduationBidEur: 0.5, sources: negSources, destinations, mode: 'negative' }] as never,
        enabled: true, dryRun: true, maxExecutionsPerDay: 3, createdBy: userId ?? 'ai-goal',
      } })
      linkedRuleIds.push({ module: 'negate', ruleId: negRule.id })
    } catch (e) { errors.push(`rules${tag}: ${(e as Error).message}`) }
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
  const totalBudgetCents = sets.reduce((n, s) => n + Math.max(100 * shares.length, s.budgetCents), 0)
  const plan = await prisma.autopilotPlan.create({ data: {
    name: goal.name, marketplace, productGroupName: goal.name,
    campaignIds: createdIds as never,
    goal: planGoal, autonomy: 'SUGGEST',
    guardrails: {
      targetAcosPct: 30,
      maxDailySpendCents: totalBudgetCents,
      budgetMaxCents: Math.max(maxCampaignBudgetCents * 2, 1000),
      rampPct: preset.rampPct,
    } as never,
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
