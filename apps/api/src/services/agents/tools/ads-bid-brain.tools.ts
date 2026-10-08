/**
 * BID BRAIN BB-4 — `bid-brain`: Claude reads what the (shadow) bid brain decides. Read only: it changes nothing, in
 * Nexus or at Amazon. Today the brain runs in shadow (NEXUS_BID_BRAIN_MODE), so every answer is what it WOULD set.
 *
 *   why      why this bid: each keyword's newest decision with its one-line why (the deciding layer, the aim and band,
 *            the pooled conversion rate with its clicks, the order value, the step and the limit that held it)
 *   what-if  the same keywords decided again now with another target ACoS (and band) — not stored, nothing sent
 *   diff     per day, the brain against what today's writers set, and conflicts and churn from the action log
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { BRAIN_VIEWS, readBidBrain, type BrainReadArgs } from '../../advertising/bid-brain/read.js'
import type { AgentTool, FieldPermission } from '../tool-types.js'

const ID = z.string().trim().min(1).max(64)
const PCT = z.coerce.number().min(1).max(500)

/** Bids, targets and the why (which names bids and the order value) are ad-spend money. */
const BRAIN_MONEY: Readonly<Record<string, FieldPermission>> = Object.fromEntries(
  ['currentCents', 'decidedCents', 'goalBidCents', 'whatIfCents', 'aimPct', 'bandLoPct', 'bandHiPct', 'expectedAcosPct', 'targetAcosPct', 'why']
    .map((key) => [key, FIELDS.financialsAdspendView]),
)

const bidBrain: AgentTool = {
  name: 'bid-brain',
  title: 'Bid brain (shadow)',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: BRAIN_MONEY,
  input: z.object({
    view: z.enum(BRAIN_VIEWS).default('why')
      .describe('why (default): each keyword\'s newest decision and why; what-if: decided again now with targetAcosPct (and a band); diff: per day, the brain against what today\'s writers set, with conflicts and churn'),
    market: z.string().trim().toUpperCase().min(2).max(20).optional()
      .describe('one Amazon market code (the shadow runs on IT and DE); omit with no campaign, keyword or product for both'),
    campaignId: ID.optional().describe('one Amazon campaign, its Nexus id (ad-campaigns)'),
    targetId: ID.optional().describe('one keyword or target, its Nexus id (ad-targets)'),
    productId: ID.optional().describe('one product (a parent covers its variations), its Nexus id: every keyword of the ad groups advertising it'),
    targetAcosPct: PCT.optional().describe('what-if: the target ACoS to decide with, a percent (20 = 20 %)'),
    bandLoPct: PCT.optional().describe('what-if: the bottom of the ACoS band, a percent (the brain leaves a bid alone inside the band)'),
    bandHiPct: PCT.optional().describe('what-if: the top of the ACoS band, a percent'),
    days: z.coerce.number().int().min(1).max(30).default(7).describe('diff: how many days back (default 7, max 30)'),
    limit: z.coerce.number().int().min(1).max(200).default(50).describe('why and what-if: how many keywords, the biggest moves first (default 50, max 200)'),
  }),
  description:
    "Read the bid brain: the one engine that will decide every Amazon Sponsored Products keyword bid from the business's "
    + 'goal (goal bid × hour factor, then placements, inside the limits, unless a stop, a pin or stock says otherwise). It '
    + 'runs in SHADOW now: every 6 hours it decides the keywords of the allowlisted campaigns in IT and DE and logs what it '
    + 'would set next to what today\'s writers set; it writes nothing. view why (default): each keyword\'s newest decision — '
    + 'write, hold or brake, the deciding layer (brake, stop, pin, stock, freeze, phase, min_bid_hour, restore — the bids going back after a stop lifted —, goal, band, limit, '
    + 'no_goal), today\'s bid and the brain\'s, the goal bid, the aim and band, the expected ACoS at today\'s bid, how much '
    + 'of the estimate rests on data — and a one-line why. view what-if: the same keywords decided again now with '
    + 'targetAcosPct (and bandLoPct / bandHiPct): what the brain would set, not stored and not sent (set-ads-strategy '
    + 'changes the real target). view diff: per day, agree / higher / lower / hold / brake against today\'s bids, conflicts '
    + '(keywords two different automatic writers changed within 24 hours) and churn (bid writes per keyword). Scope: a '
    + 'keyword (targetId), a campaign, a product, or a market. Bids, targets and the why are ad-spend money: hidden from a '
    + 'person without permission to see ad spend. Nexus only; reads nothing from Amazon.',
  handler: async (args) => {
    const out = await readBidBrain(args as BrainReadArgs)
    return 'error' in out ? { ok: false, error: out.error } : { ok: true, data: out.data }
  },
}

export const ADS_BID_BRAIN_TOOLS: AgentTool[] = [bidBrain]
