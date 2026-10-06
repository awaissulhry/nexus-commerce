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
 *
 * ADS AUTONOMY B-2 — Claude's AI goal (create-ai-goal-campaigns) runs this same launch with `GoalLaunchOptions`: born
 * at the floor, off the live-write allowlist, its rules and AutopilotPlan switched off, every write in its change set.
 * Without options the launch is the screen's, unchanged.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { GOAL_PRESETS, DEFAULT_GUARDRAILS, type Goal } from './autopilot/presets.js'
import { safeCampaignName } from '@nexus/shared/ads-campaign-name'
import type { GoalProduct } from './ai-product-goal.service.js'
import type { AdsActor } from './ads-mutation.service.js'
import { normaliseFloorCents } from './ads-bid-suppression.service.js'
import { CampaignLaunch, summariseLaunch, describeLaunch, type LaunchCampaignResult, type LaunchResult } from './launch-outcome.js'

export class MaterializeError extends Error {
  /** CC-24 — true when nothing was created, so the goal's launch claim is let go and the goal can be launched again. */
  constructor(
    message: string, public statusCode = 400, public releaseClaim = false,
    /** W2-A — set when campaigns were attempted: what each one did (launch-outcome.ts). */
    public launch?: LaunchResult,
  ) { super(message) }
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
/** CC-14 — the ad group default bid every scaffold campaign is created with, for the launch checks. */
export const GOAL_AD_GROUP_BID_CENTS = Math.round(BASE_BID_EUR * 100)
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
  // CC-29 — refused, never guessed: a goal with no marketplace used to launch in Italy with a warning.
  const marketplace = (goal.marketplace ?? '').trim()
  if (!marketplace) throw new MaterializeError('This goal has no Amazon marketplace. Nexus does not guess one: set the marketplace on the goal first.', 400)
  // CC-5 — a Nexus-only portfolio (created while Amazon writes were closed) would make Amazon refuse every campaign.
  if ((goal.portfolioId ?? '').startsWith('local-pf-')) throw new MaterializeError('This goal\'s portfolio exists only in Nexus, so Amazon would refuse the campaigns. Pick a portfolio that exists on Amazon, or no portfolio.', 400)
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
        // CC-13 — " - ", not " · ": Amazon refuses the middle dot in names (safeCampaignName, also for one in the goal name).
        name: safeCampaignName(`[AI] ${goal.name}${multiSet ? ` - ${set.label}` : ''} - ${ROLE_LABEL[role]}`),
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

/** B-2 — Claude's AI goal (create-ai-goal-campaigns). Absent: the screen's launch, unchanged. */
export interface GoalLaunchOptions {
  /**
   * CC-7 — default TRUE (the screen): each campaign goes on the live-write allowlist the moment it exists. false = born
   * off it: its parts still reach Amazon (every create of the launch passes `creationFlow`, its negatives too), but no
   * engine, rule or later edit writes to it until a person puts it on the list (set-campaign-live-writes).
   */
  allowlistAtBirth?: boolean
  /**
   * The A11 pattern (ads-single-launch.service.ts): a bid above `floorCents` is created AT it, with the planned bid kept
   * in `suppressedFromBidCents` (the ad group default, each keyword, product target and Auto group); each campaign is
   * flagged `bidsSuppressedAt` / `bidsSuppressedFloorCents` / `bidsSuppressedBy = by` right after it is created. Born
   * ENABLED, never paused: the floor is what keeps it from spending; restore-campaign puts the planned bids back.
   */
  bornSuppressed?: { floorCents: number; by: AdsActor }
  /** The approval it runs for: every AdvertisingActionLog row it writes carries it (executionId). */
  changeSetId?: string | null
  /**
   * The goal's two rules are created switched off (still dry run, propose-first) and its AutopilotPlan disabled: nothing
   * proposes or acts until a person switches the plan on, which hands the rules to the plan (`syncedEnabled: false`).
   */
  automationOff?: boolean
  /** The bid evidence the approved preview showed (frozen): the launch builds those bids, not today's evidence. */
  bidOpts?: ScaffoldBidOpts
  /**
   * The goal names each campaign the moment it exists (the screen names them all at the end): a run that stops part-way
   * — even a process that dies — leaves the goal naming what it made, for a person to read and archive.
   */
  nameAsMade?: boolean
}

export async function materializeProductGoal(goalId: string, userId?: string, opts: GoalLaunchOptions = {}) {
  const goal = await prisma.adProductGoal.findUnique({ where: { id: goalId } })
  if (!goal) throw new MaterializeError('goal not found', 404)
  if (goal.status === 'ARCHIVED') throw new MaterializeError('goal is archived', 400)
  if (goal.materializedAt) throw new MaterializeError('goal is already materialized', 409)
  // CC-24 — claim the goal BEFORE anything is sent. `materializedAt` used to be set only at the end, so a retry during a
  // run (a timeout, a second tab, the dashboard's Launch) or after one that stopped part-way built a second scaffold.
  // The claim is the same column, set atomically; it is let go only when nothing was created.
  const claimed = await prisma.adProductGoal.updateMany({ where: { id: goal.id, materializedAt: null, status: { not: 'ARCHIVED' } }, data: { materializedAt: new Date() } })
  if (claimed.count !== 1) throw new MaterializeError('this goal is already being launched or was launched: its campaigns are not built twice', 409)
  const release = () => prisma.adProductGoal.updateMany({ where: { id: goal.id }, data: { materializedAt: null } }).catch((e: unknown) => {
    logger.error('[AIAD] goal claim not released', { goalId: goal.id, error: (e as Error).message })
  })
  try {
    return await materializeClaimed(goal, userId, opts)
  } catch (e) {
    if (e instanceof MaterializeError && e.releaseClaim) await release()
    throw e
  }
}

type GoalRow = NonNullable<Awaited<ReturnType<typeof prisma.adProductGoal.findUnique>>>

async function materializeClaimed(goal: GoalRow, userId: string | undefined, opts: GoalLaunchOptions) {
  const goalId = goal.id

  // Same bid evidence the preview showed — resolveGoalBids at both ends, so they cannot differ. B-2: Claude's preview
  // hands over the evidence it showed (frozen in the approval).
  const { resolveGoalBids } = await import('./ai-goal-suggest.service.js')
  const bidOpts = opts.bidOpts ?? await resolveGoalBids(goal.seedKeywords ?? [], goal.marketplace)
  const scaffold = planGoalScaffold({
    name: goal.name, aiTarget: goal.aiTarget, budgetMode: goal.budgetMode,
    totalBudgetCents: goal.totalBudgetCents,
    products: (Array.isArray(goal.products) ? goal.products : []) as GoalProduct[],
    seedKeywords: goal.seedKeywords, excludeKeywords: goal.excludeKeywords,
    productTargets: goal.productTargets, excludeAsins: goal.excludeAsins,
    marketplace: goal.marketplace, portfolioId: goal.portfolioId,
    targetAcosPct: goal.targetAcosPct, bidMinCents: goal.bidMinCents, bidMaxCents: goal.bidMaxCents,
  }, bidOpts)

  // CC-13 / CC-14 — the checks the builder's preview showed, run again before anything is sent: a name this market
  // already uses, or a bid or budget outside Amazon's range, refuses the launch (and lets the claim go).
  const { goalLaunchPlan, launchChecks } = await import('./ads-launch-checks.service.js')
  const checks = await launchChecks(goalLaunchPlan(scaffold, goal.portfolioId, GOAL_AD_GROUP_BID_CENTS))
  if (checks.refusals.length) throw new MaterializeError(checks.refusals.join(' '), 400, true)

  const {
    createCampaignLocal, createAdGroupLocal, createKeywordLocal, createProductAdLocal,
    createTargetLocal, createNegativeKeywordLocal, createNegativeProductTargetLocal, linkAutoTargeting,
  } = await import('./ads-create.service.js')

  const refs: GoalCampaignRef[] = []
  const errors: string[] = [...scaffold.warnings]
  // setLabel → role → created ids (for the harvest rules' sources/destinations).
  const agBySet = new Map<string, Partial<Record<ScaffoldRole, { campaignId: string; adGroupId: string }>>>()
  // W2-A (CC-2) — what each campaign made on Amazon, part by part (launch-outcome.ts). `errors` keeps its lines.
  const outcomes: LaunchCampaignResult[] = []

  // B-2 — the options. Absent, every helper below is the identity and the launch is the screen's.
  const allowlistAtBirth = opts.allowlistAtBirth !== false
  const cs = opts.changeSetId ? { changeSetId: opts.changeSetId } : {}
  // Born off the allowlist, the negatives are part of the launch as its keywords are (`creationFlow`, as SPW's and
  // Single's): the allowlist binds every other negative. The screen's launch allowlists first and sends them as before.
  const negFlow = allowlistAtBirth ? {} : { creationFlow: true }
  const floor = opts.bornSuppressed ? normaliseFloorCents(opts.bornSuppressed.floorCents) : null
  const cents = (eur: number) => Math.round(eur * 100)
  const floored = (eur: number) => floor != null && cents(eur) > floor
  const startEur = (eur: number) => (floored(eur) ? (floor as number) / 100 : eur)
  const remember = (adTargetId: string, eur: number) => prisma.adTarget.update({ where: { id: adTargetId }, data: { suppressedFromBidCents: cents(eur) } })

  for (const pc of scaffold.campaigns) {
    const rec = new CampaignLaunch(pc.name)
    try {
      const camp = await createCampaignLocal({
        name: pc.name, type: 'SP', marketplace: scaffold.marketplace,
        targetingType: pc.targetingType,
        dailyBudgetEur: pc.budgetCents / 100, biddingStrategy: 'legacyForSales',
        portfolioId: goal.portfolioId ?? undefined, userId, ...cs,
      }).catch((e: unknown) => { rec.campaignThrew(e); throw e })
      rec.campaign(camp)
      // The campaign exists in Nexus: from here it is in the goal, whatever its parts do (it was dropped when its ad
      // group threw).
      refs.push({ id: camp.id, role: pc.role, label: pc.name })
      if (opts.nameAsMade) await prisma.adProductGoal.update({ where: { id: goalId }, data: { campaignIds: refs as never } }).catch((e: unknown) => logger.warn('[AIAD] goal campaigns not named', { goalId, error: (e as Error).message }))
      // W2-A (CC-3) — not on Amazon: a FAILED record with the reason, and nothing built under it.
      if (!camp.externalCampaignId) { errors.push(`campaign ${pc.name}: ${camp.reason ?? 'not on Amazon'}`); outcomes.push(rec.result()); continue }
      // Same launch repair as SPW: allowlist BEFORE sub-entities, or the per-campaign gate
      // skips every keyword/product-ad and the campaign lands empty on Amazon.
      // B-2 — off it for Claude's goal (`allowlistAtBirth: false`): every create below passes `creationFlow`.
      if (allowlistAtBirth) { try { await prisma.campaign.update({ where: { id: camp.id }, data: { liveBidWritesEnabled: true } }) } catch (e) { logger.warn('[AIAD] allowlist failed', { error: (e as Error).message }) } }
      // B-2 — born at the floor: flagged as suppressed by the person who asked, from the moment it exists.
      if (floor != null) {
        try { await prisma.campaign.update({ where: { id: camp.id }, data: { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: floor, bidsSuppressedBy: opts.bornSuppressed!.by } }) }
        catch (e) { rec.threw('campaign', 'Born at the floor', e); errors.push(`campaign ${pc.name}: born at the floor: ${(e as Error).message}`) }
      }
      // CM-20 — `creationFlow`: everything below belongs to the campaign created a moment ago.
      const agName = `${ROLE_LABEL[pc.role]} Ad Group`
      const ag = await createAdGroupLocal({ campaignId: camp.id, name: agName, defaultBidEur: startEur(BASE_BID_EUR), userId, creationFlow: true, ...cs })
        .catch((e: unknown) => { rec.adGroup(agName, null, e); throw e })
      rec.adGroup(agName, ag)
      const agId = ag.id as string
      const set = agBySet.get(pc.setLabel) ?? {}
      set[pc.role] = { campaignId: camp.id, adGroupId: agId }
      agBySet.set(pc.setLabel, set)
      if (floored(BASE_BID_EUR)) { try { await prisma.adGroup.update({ where: { id: agId }, data: { suppressedFromBidCents: cents(BASE_BID_EUR) } }) } catch (e) { rec.threw('ad_group', 'Remember the planned default bid', e) } }

      // W2-A (CC-17) — negatives FIRST, as Replicate does: a launch that fails part-way is then narrower, never wider.
      for (const nk of pc.negativeKeywords) {
        try { rec.negative('negative_keyword', `${nk.text} (${nk.matchType.toLowerCase()})`, await createNegativeKeywordLocal({ adGroupId: agId, keywordText: nk.text, matchType: nk.matchType, userId, ...negFlow, ...cs })) }
        catch (e) { rec.threw('negative_keyword', nk.text, e); errors.push(`neg "${nk.text}": ${(e as Error).message}`) }
      }
      for (const asin of pc.negativeAsins) {
        try { rec.negative('negative_product', asin, await createNegativeProductTargetLocal({ adGroupId: agId, asin, userId, ...negFlow, ...cs })) }
        catch (e) { rec.threw('negative_product', asin, e); errors.push(`neg ASIN ${asin}: ${(e as Error).message}`) }
      }
      for (const p of pc.products) {
        const item = p.sku ?? p.asin ?? '?'
        try { rec.productAd(item, await createProductAdLocal({ adGroupId: agId, asin: p.asin, sku: p.sku, productId: p.productId, userId, launch: true, creationFlow: true, ...cs })) }
        catch (e) { rec.threw('product_ad', item, e); errors.push(`product ad ${p.asin ?? p.sku}: ${(e as Error).message}`) }
      }
      // W2-A (CC-1) — Amazon makes the four auto groups itself: link them and set each one's bid (the bid evidence).
      if (pc.autoGroups.length) {
        try {
          const linked = await linkAutoTargeting({ adGroupId: agId, groups: pc.autoGroups.map((g) => ({ key: g.key, enabled: true, bidEur: startEur(g.bidEur) })), userId, creationFlow: true, ...cs })
          rec.autoGroups(linked)
          // B-2 — each linked group remembers the bid planned for it.
          if (floor != null) {
            const planned = new Map(pc.autoGroups.map((g) => [g.key, g.bidEur]))
            for (const l of linked.links) { const eur = planned.get(l.key); if (l.adTargetId && eur != null && floored(eur)) await remember(l.adTargetId, eur) }
          }
        } catch (e) { rec.threw('auto_targeting', 'Auto groups', e); errors.push(`auto groups: ${(e as Error).message}`) }
      }
      for (const kw of pc.seeds) {
        try {
          const eur = kw.bidCents / 100
          const k = await createKeywordLocal({ adGroupId: agId, keywordText: kw.text, matchType: kw.matchType, bidEur: startEur(eur), userId, creationFlow: true, ...cs })
          rec.keyword(`${kw.text} (${kw.matchType.toLowerCase()})`, k)
          if (floored(eur) && !k.existed && k.id) await remember(k.id, eur)
        } catch (e) { rec.threw('keyword', kw.text, e); errors.push(`${kw.matchType.toLowerCase()} "${kw.text}": ${(e as Error).message}`) }
      }
      for (const asin of pc.productTargets) {
        try {
          const t = await createTargetLocal({ adGroupId: agId, kind: 'PRODUCT', value: asin, bidEur: startEur(BASE_BID_EUR), userId, creationFlow: true, ...cs })
          rec.productTarget(asin, t)
          if (floored(BASE_BID_EUR) && t.id) await remember(t.id, BASE_BID_EUR)
        } catch (e) { rec.threw('product_target', asin, e); errors.push(`product target ${asin}: ${(e as Error).message}`) }
      }
    } catch (e) {
      errors.push(`campaign ${pc.name}: ${(e as Error).message}`)
      logger.error('[AIAD] campaign create failed', { goalId, name: pc.name, error: (e as Error).message })
    }
    outcomes.push(rec.result())
  }
  const launch = summariseLaunch(outcomes)
  if (!refs.length) throw new MaterializeError(`no campaigns could be created: ${errors[0] ?? 'unknown error'}`, 500, true, launch)
  if (!launch.ok) logger.warn('[AIAD] launch did not fully reach Amazon', { goalId, summary: describeLaunch(launch) })
  // CC-24 — from here campaigns exist: whatever happens next, the goal keeps its claim and names them, so a retry never
  // builds a second scaffold beside them.
  try {
    return await finishMaterialize(goal, userId, scaffold, refs, agBySet, errors, launch, opts)
  } catch (e) {
    await prisma.adProductGoal.update({ where: { id: goal.id }, data: { campaignIds: refs as never } }).catch(() => {})
    throw e
  }
}

async function finishMaterialize(
  goal: GoalRow, userId: string | undefined, scaffold: GoalScaffold, refs: GoalCampaignRef[],
  agBySet: Map<string, Partial<Record<ScaffoldRole, { campaignId: string; adGroupId: string }>>>, errors: string[],
  launch: LaunchResult, opts: GoalLaunchOptions,
) {
  const goalId = goal.id
  // B-2 — Claude's goal: its rules and plan are born switched off (absent: the screen's, on and proposing).
  const off = opts.automationOff === true
  const { settleLaunchPortfolios } = await import('./ads-create.service.js')

  // ── Harvest & Negate + Negative Targeting rules per scaffold (SPW-proven shape, propose-first) ──
  const linkedRuleIds: Array<{ module: 'harvest' | 'negate'; ruleId: string; syncedEnabled?: boolean }> = []
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
        enabled: !off, dryRun: true, maxExecutionsPerDay: 3, createdBy: userId ?? 'ai-goal',
      } })
      // B-2 — a rule born off is the plan's own off (coordination.ts CC-15 reads `syncedEnabled`), not a person's: the
      // plan switched on later switches it on with it.
      linkedRuleIds.push({ module: pr.kind === 'harvest' ? 'harvest' : 'negate', ruleId: rule.id, ...(off ? { syncedEnabled: false } : {}) })
    } catch (e) { errors.push(`rule ${pr.name}: ${(e as Error).message}`) }
  }

  // ── Portfolio settle + launch receipt (same post-launch checks as SPW) ──
  const createdIds = refs.map((r) => r.id)
  let portfolioCheck: unknown = null
  try { portfolioCheck = await settleLaunchPortfolios(createdIds) } catch { /* non-fatal */ }
  let verification: unknown = null
  // W2-A — the campaigns on Amazon; one that is not is already answered in `launch` with its reason.
  const onAmazonIds = launch.campaigns.filter((o) => o.campaignId && o.externalCampaignId).map((o) => o.campaignId as string)
  try {
    const { verifyLaunch } = await import('./ads-launch-verify.service.js')
    if (onAmazonIds.length) verification = await verifyLaunch(onAmazonIds)
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
    ...(off ? { enabled: false } : {}),
    createdBy: userId ?? 'ai-goal',
  } })

  const updated = await prisma.adProductGoal.update({
    where: { id: goal.id },
    data: { campaignIds: refs as never, planId: plan.id, materializedAt: new Date() },
  })
  logger.info('[AIAD] goal materialized', { goalId: goal.id, planId: plan.id, campaigns: refs.length, rules: linkedRuleIds.length, errors: errors.length })
  return { goal: updated, planId: plan.id, campaigns: refs, rules: linkedRuleIds, portfolioCheck, verification, errors, launch }
}
