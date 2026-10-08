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
 *                 campaign, whose product's terms the brain's ledger decides), placements (set_placement_multiplier,
 *                 placement_apply) and ad-group default bids (bid_down / bid_up on an ad group). Keyword bids stay BB-9's
 *                 (bid-brain/rule-directives.ts: a bid brain campaign's bid action becomes its input).
 *   many          an action that writes several campaigns skips inside its handler, campaign by campaign, with the same
 *                 reader (sync_negatives_across_campaigns, harvest_and_negate, isolate_product_terms, pace_budget,
 *                 liquidate_aged_stock, dayparting_apply, a pool's rebalance, promote_to_exact's destinations, a mapped
 *                 negative's), and reports `brainSkips` (per holder and lever) in its output.
 *   counted       ruleResultLeverSkips reads both shapes back, per holder and lever, for the evaluator's summary line and
 *                 the rule's refusal record (BRAIN_OWNED / OWNER_LOCKED / BID_BRAIN :<lever>, automation-activity).
 *   one pass      withRulePass (follow-up of #527): an evaluator pass reads the campaign of everything its contexts name and
 *                 who holds those campaigns' levers ONCE, before its contexts run, and keeps both for the whole pass — a
 *                 rule's action then looks nothing up (the 15 s memory of lever-owners.ts cannot run out mid-pass), and a
 *                 campaign no context named is read once and kept. Outside a pass (an approved card, a preview) each call
 *                 reads for itself, as before.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { brainLiveCeiling } from '../bid-brain/live.js'
import { addLeverHeld, isLeverHolder, leverSkipOf, type LeverHeld, type LeverSkip } from './engine-skips.js'
import { anyBrainEnrolled, campaignLeverOwners, type CampaignLeverOwners } from './lever-owners.js'
import { isLever, type BrainLever } from './levers.js'

export { brainSkipsOutput } from './engine-skips.js'

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

// ── One evaluator pass ───────────────────────────────────────────────────────────────────────────────────────────

/** What one evaluator pass keeps: the campaign of each thing its rules name, and who holds each campaign's levers. */
interface RulePass {
  /** Not under a live ceiling, or nothing enrolled in the business: no rule looks anything up. */
  inert: boolean
  /** The campaign of an ad group or keyword (Nexus's id 'ag:' / 't:') or of Amazon's ad group or campaign id ('xg:' / 'xc:'). */
  campaignOf: Map<string, string | null>
  /** Who holds each campaign's levers (null: nobody holds one). */
  owners: Map<string, CampaignLeverOwners | null>
}
const passes = new AsyncLocalStorage<RulePass>()

/** The ids a context names, by kind (Nexus's campaign ids directly; the rest to resolve). */
function idsOf(contexts: readonly unknown[]) {
  const ids = { campaigns: new Set<string>(), adGroups: new Set<string>(), targets: new Set<string>(), extGroups: new Set<string>(), extCampaigns: new Set<string>() }
  for (const raw of contexts) {
    const c = (raw ?? {}) as Ctx
    const direct = str(c.campaign?.id) ?? str(c.adGroup?.campaignId) ?? str(c.adTarget?.campaignId)
    if (direct) ids.campaigns.add(direct)
    else if (str(c.adGroup?.id) ?? str(c.adTarget?.adGroupId)) ids.adGroups.add((str(c.adGroup?.id) ?? str(c.adTarget?.adGroupId))!)
    else if (str(c.adTarget?.id)) ids.targets.add(str(c.adTarget?.id)!)
    for (const id of [str(c.searchTerm?.externalAdGroupId)]) if (id) ids.extGroups.add(id)
    for (const id of [str(c.searchTerm?.externalCampaignId), str(c.campaign?.externalCampaignId)]) if (id) ids.extCampaigns.add(id)
  }
  return ids
}

/**
 * Open one pass: resolve every campaign the contexts name (one query per kind of id) and read who holds their levers once
 * (campaignLeverOwners). Not live, or nothing enrolled: inert, nothing more read. A failed read is logged and leaves the
 * pass empty: each rule then reads for itself, and a holder that cannot be read is no skip (the write gate decides).
 */
async function openRulePass(contexts: readonly unknown[]): Promise<RulePass> {
  const pass: RulePass = { inert: true, campaignOf: new Map(), owners: new Map() }
  if (!contexts.length || !brainLiveCeiling()) return pass
  try {
    if (!(await anyBrainEnrolled())) return pass
    pass.inert = false
    const ids = idsOf(contexts)
    const [groups, targets, campaigns] = await Promise.all([
      ids.adGroups.size || ids.extGroups.size
        ? prisma.adGroup.findMany({
          where: { OR: [...(ids.adGroups.size ? [{ id: { in: [...ids.adGroups] } }] : []), ...(ids.extGroups.size ? [{ externalAdGroupId: { in: [...ids.extGroups] } }] : [])] },
          select: { id: true, externalAdGroupId: true, campaignId: true },
        })
        : Promise.resolve([]),
      ids.targets.size ? prisma.adTarget.findMany({ where: { id: { in: [...ids.targets] } }, select: { id: true, adGroup: { select: { campaignId: true } } } }) : Promise.resolve([]),
      ids.extCampaigns.size ? prisma.campaign.findMany({ where: { externalCampaignId: { in: [...ids.extCampaigns] } }, select: { id: true, externalCampaignId: true } }) : Promise.resolve([]),
    ])
    for (const id of ids.adGroups) pass.campaignOf.set(`ag:${id}`, null)
    for (const id of ids.extGroups) pass.campaignOf.set(`xg:${id}`, null)
    for (const id of ids.targets) pass.campaignOf.set(`t:${id}`, null)
    for (const id of ids.extCampaigns) pass.campaignOf.set(`xc:${id}`, null)
    for (const g of groups) {
      if (ids.adGroups.has(g.id)) pass.campaignOf.set(`ag:${g.id}`, g.campaignId)
      if (g.externalAdGroupId && ids.extGroups.has(g.externalAdGroupId)) pass.campaignOf.set(`xg:${g.externalAdGroupId}`, g.campaignId)
    }
    for (const t of targets) pass.campaignOf.set(`t:${t.id}`, t.adGroup?.campaignId ?? null)
    for (const c of campaigns) if (c.externalCampaignId) pass.campaignOf.set(`xc:${c.externalCampaignId}`, c.id)
    const all = [...new Set([...ids.campaigns, ...[...pass.campaignOf.values()].filter((v): v is string => !!v)])]
    if (all.length) {
      const owners = await campaignLeverOwners(all)
      for (const id of all) pass.owners.set(id, owners.get(id) ?? null)
    }
  } catch (err) {
    logger.warn('[ads-brain] could not read the campaigns or their holders before a rule pass — each rule asks for its own campaign', { error: err instanceof Error ? err.message : String(err) })
    pass.campaignOf.clear()
    pass.owners.clear()
  }
  return pass
}

/**
 * Run one evaluator pass with its memory (the rule evaluator's applyMarketplaceScope): every rule's lever check inside
 * `work` reads its campaign and holders from it. Never throws on its own reads.
 */
export async function withRulePass<T>(contexts: readonly unknown[], work: () => Promise<T>): Promise<T> {
  return passes.run(await openRulePass(contexts), work)
}

/** A campaign looked up once per pass (outside a pass: every time). */
async function remembered(key: string, read: () => Promise<string | null>): Promise<string | null> {
  const pass = passes.getStore()
  if (pass?.campaignOf.has(key)) return pass.campaignOf.get(key)!
  const value = await read()
  pass?.campaignOf.set(key, value)
  return value
}

/**
 * The campaign a rule action writes (Nexus's id), in the bid brain's order (bid-brain/rule-directives.ts
 * directiveCampaignId: its campaign, then its ad group, else its keyword) and then, for a search-term action, the term's
 * ad group or campaign by Amazon's id. Null when it names none. Inside a pass each lookup happens once.
 */
export async function ruleActionCampaignId(action: RuleAction, context: unknown): Promise<string | null> {
  const c = (context ?? {}) as Ctx
  // promote_to_exact's `adGroupId` is Amazon's id of the term's source ad group, not Nexus's.
  if (action.type !== 'promote_to_exact') {
    const direct = str(action.campaignId) ?? str(c.campaign?.id) ?? str(c.adGroup?.campaignId) ?? str(c.adTarget?.campaignId)
    if (direct) return direct
    const groupId = str(action.adGroupId) ?? str(c.adGroup?.id) ?? str(c.adTarget?.adGroupId)
    const targetId = str(action.adTargetId) ?? str(c.adTarget?.id)
    const local = groupId
      ? await remembered(`ag:${groupId}`, async () => (await prisma.adGroup.findUnique({ where: { id: groupId }, select: { campaignId: true } }))?.campaignId ?? null)
      : targetId
        ? await remembered(`t:${targetId}`, async () => (await prisma.adTarget.findUnique({ where: { id: targetId }, select: { adGroup: { select: { campaignId: true } } } }))?.adGroup.campaignId ?? null)
        : null
    if (local) return local
  }
  const extGroup = (action.type === 'promote_to_exact' ? str(action.adGroupId) : null) ?? str(action.externalAdGroupId) ?? str(c.searchTerm?.externalAdGroupId)
  if (extGroup) {
    const byGroup = await remembered(`xg:${extGroup}`, async () => (await prisma.adGroup.findFirst({ where: { externalAdGroupId: extGroup }, select: { campaignId: true } }))?.campaignId ?? null)
    if (byGroup) return byGroup
  }
  const extCampaign = str(action.externalCampaignId) ?? str(c.searchTerm?.externalCampaignId) ?? str(c.campaign?.externalCampaignId)
  if (extCampaign) return remembered(`xc:${extCampaign}`, async () => (await prisma.campaign.findFirst({ where: { externalCampaignId: extCampaign }, select: { id: true } }))?.id ?? null)
  return null
}

/** Who holds a campaign's levers: kept for the whole pass (read once if the pass did not know it), else read now. */
async function ownersOf(campaignId: string): Promise<CampaignLeverOwners | undefined> {
  const pass = passes.getStore()
  if (pass?.owners.has(campaignId)) return pass.owners.get(campaignId) ?? undefined
  const owners = (await campaignLeverOwners([campaignId])).get(campaignId)
  pass?.owners.set(campaignId, owners ?? null)
  return owners
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
      brainSkip: { lever: skip.lever, holder: skip.holder, campaignId: skip.campaignId, productId: skip.productId, market: skip.market, reason: skip.reason },
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
  const pass = passes.getStore()
  if (pass?.inert) return null
  try {
    // Nothing enrolled in the business (production today): one remembered query, and the campaign is never even looked up.
    if (!pass && !(await anyBrainEnrolled())) return null
    const campaignId = await ruleActionCampaignId(action, context)
    if (!campaignId) return null
    const picker = Array.isArray(action.campaignIds) ? (action.campaignIds as unknown[]).filter((v): v is string => typeof v === 'string') : []
    if (picker.length && !picker.includes(campaignId)) return null
    const skip = leverSkipOf(await ownersOf(campaignId), lever, { actor: `automation:${meta.ruleId}` })
    return skip ? leverSkipResult(action.type, skip) : null
  } catch (err) {
    logger.warn('[ads-brain] a rule could not tell whether a product\'s brain holds its campaign — it runs, and the write gate decides', {
      ruleId: meta.ruleId, action: action.type, error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** The skips one action result reports, per holder and lever: its own one-campaign skip, or its handler's tally. Pure. */
export function ruleResultLeverSkips(result: { output?: unknown } | null | undefined): LeverHeld {
  const out = (result?.output ?? null) as { brainSkip?: { lever?: unknown; holder?: unknown }; brainSkips?: { counts?: unknown } } | null
  const held: LeverHeld = {}
  if (out?.brainSkip && isLever(out.brainSkip.lever) && isLeverHolder(out.brainSkip.holder)) held[out.brainSkip.holder] = { [out.brainSkip.lever]: 1 }
  const counts = out?.brainSkips?.counts
  if (counts && typeof counts === 'object') {
    const valid: LeverHeld = {}
    for (const [holder, byLever] of Object.entries(counts as Record<string, unknown>)) {
      if (!isLeverHolder(holder) || !byLever || typeof byLever !== 'object') continue
      valid[holder] = Object.fromEntries(Object.entries(byLever as Record<string, unknown>).filter(([lever, n]) => isLever(lever) && typeof n === 'number' && n > 0))
    }
    addLeverHeld(held, valid)
  }
  return held
}
