/**
 * BID BRAIN BB-6 — an ads rule's bid or placement action on a campaign the brain owns is skipped, with its reason, before
 * it runs (one writer per campaign). The write gate refuses such a write too; skipping first keeps the rule's run honest
 * ("left to the bid brain", not a failed write) and spends no queue row. BB-9 turns these actions into the brain's
 * inputs (BidDirective) instead.
 *
 * The rule's context names its campaign directly, or through its ad group or keyword (one indexed read). Inert — no
 * read at all — while the env ceiling is not `live`.
 */
import prisma from '../../../db.js'
import { brainLiveCeiling, brainOwnedCampaignIds } from './live.js'

/** The rule actions that write a bid or a placement. */
export const BRAIN_RULE_ACTIONS: ReadonlySet<string> = new Set([
  'bid_down', 'bid_up', 'bid_apply', 'bid_to_target_acos', 'lower_bid_to_floor', 'raise_bids_for_rank_defense',
  'scale_bids_for_price_change', 'set_placement_multiplier', 'placement_apply', 'dayparting_apply', 'defend_top_of_search',
])

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** The campaign a rule's context (and the action's own campaignId) points at, or null. */
export async function ruleCampaignId(action: Record<string, unknown>, context: unknown): Promise<string | null> {
  const c = (context ?? {}) as Record<string, Record<string, unknown> | undefined>
  const direct = str(action.campaignId) ?? str(c.campaign?.id) ?? str(c.adGroup?.campaignId) ?? str(c.adTarget?.campaignId)
  if (direct) return direct
  const groupId = str(c.adGroup?.id) ?? str(c.adTarget?.adGroupId)
  if (groupId) return (await prisma.adGroup.findUnique({ where: { id: groupId }, select: { campaignId: true } }))?.campaignId ?? null
  const targetId = str(c.adTarget?.id)
  if (targetId) return (await prisma.adTarget.findUnique({ where: { id: targetId }, select: { adGroup: { select: { campaignId: true } } } }))?.adGroup.campaignId ?? null
  return null
}

/** Why this rule action is left to the bid brain, or null when it runs as before. */
export async function ruleBrainSkip(action: { type: string } & Record<string, unknown>, context: unknown): Promise<string | null> {
  if (!brainLiveCeiling() || !BRAIN_RULE_ACTIONS.has(action.type)) return null
  const campaignId = await ruleCampaignId(action, context)
  if (!campaignId) return null
  const owned = await brainOwnedCampaignIds([campaignId])
  return owned.has(campaignId) ? `left to the bid brain: it runs campaign ${campaignId} (one writer per campaign)` : null
}
