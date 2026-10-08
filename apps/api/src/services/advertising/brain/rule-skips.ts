/**
 * ONE BRAIN AB-6 — an ads rule leaves a lever a product's brain owns (or the Owner locked) before it asks to write
 * (design 2026-10-08-ads-one-brain/DESIGN.md §3 target 4 and its lever × writer table): the rule's action is recorded as a
 * named skip in place of the write, in a dry run too, so a PROPOSE rule never offers a change the brain owns and an AUTO
 * rule never counts a write the gate would refuse. Same answer as the write gate (brain/engine-skips.ts): under the live
 * ceiling only, for the levers brain/lever-owners.ts holds, for the rule's own actor.
 *
 *   one campaign  ruleActionLever: the lever an action writes on the campaign it names (its context's campaign, ad group,
 *                 keyword or search term) — budgets (adjust_ad_budget, set_daily_budget, budget_apply), state
 *                 (enable_campaign, resume_campaign, pause_target, enable_target, archive_keyword), negatives
 *                 (add_negative_exact / _phrase without a mapping), harvest (promote_to_exact: the term's source
                 campaign, whose product's terms the brain's ledger decides), placements
 *                 (set_placement_multiplier, placement_apply) and ad-group default bids (bid_down / bid_up on an ad group).
 *                 Keyword bids stay BB-9's (bid-brain/rule-directives.ts: a bid brain campaign's bid action becomes its input).
 *   many          an action that writes several campaigns skips inside its handler, campaign by campaign, with the same
 *                 reader (sync_negatives_across_campaigns, harvest_and_negate, isolate_product_terms, pace_budget,
 *                 liquidate_aged_stock, a pool's rebalance, promote_to_exact's destinations, a mapped negative's), and
 *                 reports `brainSkips` counts in its output.
 *   counted       ruleResultLeverSkips reads both shapes back, for the evaluator's summary line and the rule's refusal
 *                 record (LEVER_HELD:<lever>, automation-activity).
 *   batched       warmRuleLeverOwners reads the holders of every campaign of one evaluator pass at once, before its
 *                 contexts run (each answer is remembered 15 s): one rule match then reads nothing more.
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { brainLiveCeiling } from '../bid-brain/live.js'
import { directiveCampaignId } from '../bid-brain/rule-directives.js'
import { readLeverHolds, type LeverSkip, type LeverSkipCounts } from './engine-skips.js'

export { brainSkipsOutput } from './engine-skips.js'
import { anyBrainEnrolled, campaignLeverOwners } from './lever-owners.js'
import { isLever, type BrainLever } from './levers.js'

type RuleAction = { type: string } & Record<string, unknown>
type Ctx = Record<string, Record<string, unknown> | undefined>
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** The lever a rule action writes on the one campaign it names; null when it writes none, or several (inside its handler). Pure. */
export function ruleActionLever(action: RuleAction): BrainLever | null {
  switch (action.type) {
    case 'adjust_ad_budget':
    case 'set_daily_budget':
    case 'budget_apply':
      return 'budgets'
    case 'enable_campaign':
    case 'resume_campaign':
    case 'pause_target':
    case 'enable_target':
    case 'archive_keyword':
      return 'state'
    case 'add_negative_exact':
    case 'add_negative_phrase':
      // A mapped (builder) negative writes into its mapped destinations, which may be other campaigns: its handler asks
      // per destination. The legacy one writes into the term's own campaign.
      return action.negative ? null : 'negatives'
    case 'promote_to_exact':
      return 'harvest'
    case 'set_placement_multiplier':
    case 'placement_apply':
      return 'placements'
    case 'bid_down':
    case 'bid_up':
      return String(action.target ?? 'ad_target') === 'ad_group' ? 'adGroupBids' : null
    default:
      return null
  }
}

/**
 * The campaign a rule action writes (Nexus's id): the bid brain's resolver (its campaign, ad group or keyword) and, for a
 * search-term action, the term's ad group or campaign by Amazon's id. Null when it names none.
 */
export async function ruleActionCampaignId(action: RuleAction, context: unknown): Promise<string | null> {
  const c = (context ?? {}) as Ctx
  // promote_to_exact's `adGroupId` is Amazon's id of the term's source ad group, not Nexus's.
  if (action.type !== 'promote_to_exact') {
    const local = await directiveCampaignId(action, context)
    if (local) return local
  }
  const extGroup = (action.type === 'promote_to_exact' ? str(action.adGroupId) : null) ?? str(action.externalAdGroupId) ?? str(c.searchTerm?.externalAdGroupId)
  if (extGroup) {
    const g = await prisma.adGroup.findFirst({ where: { externalAdGroupId: extGroup }, select: { campaignId: true } })
    if (g) return g.campaignId
  }
  const extCampaign = str(action.externalCampaignId) ?? str(c.searchTerm?.externalCampaignId) ?? str(c.campaign?.externalCampaignId)
  if (extCampaign) return (await prisma.campaign.findFirst({ where: { externalCampaignId: extCampaign }, select: { id: true } }))?.id ?? null
  return null
}

/** The output a skipped action records (one shape for the one-campaign hook and the summary readers). */
export function leverSkipResult(type: string, skip: LeverSkip): { type: string; ok: true; output: Record<string, unknown> } {
  return {
    type,
    ok: true,
    output: {
      skipped: 'brain-lever',
      campaignId: skip.campaignId,
      why: `left alone: ${skip.reason} (one owner per lever); a person's own edit still passes`,
      brainSkip: { lever: skip.lever, kind: skip.kind, campaignId: skip.campaignId, productId: skip.productId, market: skip.market, reason: skip.reason },
    },
  }
}

/**
 * ONE BRAIN AB-6 — the skip a rule records in place of this action, or null when the action runs as before: not under a
 * live ceiling, an action that writes no one campaign's lever, nothing enrolled in the business (no campaign lookup at
 * all), a campaign it does not name or its picker leaves out (the handler says that), nothing holding the lever, or
 * holders that cannot be read (the write gate decides). Never throws.
 */
export async function ruleLeverSkip(action: RuleAction, context: unknown, meta: { ruleId: string }): Promise<ReturnType<typeof leverSkipResult> | null> {
  if (!brainLiveCeiling()) return null
  const lever = ruleActionLever(action)
  if (!lever) return null
  try {
    // Nothing enrolled in the business (production today): one remembered query, and the campaign is never even looked up.
    if (!(await anyBrainEnrolled())) return null
    const campaignId = await ruleActionCampaignId(action, context)
    if (!campaignId) return null
    const picker = Array.isArray(action.campaignIds) ? (action.campaignIds as unknown[]).filter((v): v is string => typeof v === 'string') : []
    if (picker.length && !picker.includes(campaignId)) return null
    const holds = await readLeverHolds([campaignId], { actor: `automation:${meta.ruleId}` }, `rule ${meta.ruleId}`)
    const skip = holds.skip(campaignId, lever)
    return skip ? leverSkipResult(action.type, skip) : null
  } catch (err) {
    logger.warn('[ads-brain] a rule could not tell whether a product\'s brain holds its campaign — it runs, and the write gate decides', {
      ruleId: meta.ruleId, action: action.type, error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** The skips one action result reports: its own one-campaign skip, or the per-lever counts its handler made. Pure. */
export function ruleResultLeverSkips(result: { output?: unknown } | null | undefined): LeverSkipCounts {
  const out = (result?.output ?? null) as { brainSkip?: { lever?: unknown }; brainSkips?: { counts?: Record<string, unknown> } } | null
  const counts: LeverSkipCounts = {}
  if (out?.brainSkip && isLever(out.brainSkip.lever)) counts[out.brainSkip.lever] = 1
  for (const [lever, n] of Object.entries(out?.brainSkips?.counts ?? {})) {
    if (isLever(lever) && typeof n === 'number' && n > 0) counts[lever] = (counts[lever] ?? 0) + n
  }
  return counts
}

/**
 * Read once, before an evaluator pass runs its contexts, who holds the levers of every campaign they name (Nexus's ids,
 * and Amazon's campaign ids of search terms in one query): each campaign's answer is then remembered for the pass. Not
 * under a live ceiling, or nothing enrolled: one remembered query at most. Never throws (a rule's own check reads again).
 */
export async function warmRuleLeverOwners(contexts: readonly unknown[]): Promise<void> {
  if (!contexts.length || !brainLiveCeiling()) return
  try {
    if (!(await anyBrainEnrolled())) return
    const local = new Set<string>()
    const ext = new Set<string>()
    for (const raw of contexts) {
      const c = (raw ?? {}) as Ctx
      for (const id of [str(c.campaign?.id), str(c.adGroup?.campaignId), str(c.adTarget?.campaignId)]) if (id) local.add(id)
      for (const id of [str(c.searchTerm?.externalCampaignId), str(c.campaign?.externalCampaignId)]) if (id) ext.add(id)
    }
    if (ext.size) {
      const rows = await prisma.campaign.findMany({ where: { externalCampaignId: { in: [...ext] } }, select: { id: true } })
      for (const r of rows) local.add(r.id)
    }
    if (local.size) await campaignLeverOwners([...local])
  } catch (err) {
    logger.warn('[ads-brain] could not read who holds the levers before a rule pass — each rule asks for its own campaign', { error: err instanceof Error ? err.message : String(err) })
  }
}
