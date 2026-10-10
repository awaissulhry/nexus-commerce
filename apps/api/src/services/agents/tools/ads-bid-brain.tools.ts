/**
 * BID BRAIN BB-4 — `bid-brain`: Claude reads what the bid brain decides. Read only: it changes nothing, in Nexus or at
 * Amazon. BB-6 — a campaign enrolled LIVE (while NEXUS_BID_BRAIN_MODE is live) is written by the brain; every other
 * answer is what it WOULD set (shadow).
 *
 *   why      why this bid: each keyword's newest decision with its one-line why (the deciding layer, the aim and band,
 *            the pooled conversion rate with its clicks, the order value, the step and the limit that held it)
 *   what-if  the same keywords decided again now with another target ACoS (and band) — not stored, nothing sent
 *   diff     per day, the brain against what today's writers set, and conflicts and churn from the action log
 *   calibration  BB-15 — the attribution lag curve per market (and product): how much of a day's final orders a young copy
 *            holds at each age, what the curve rests on, and the nowcast's mean absolute error on the newest settled days
 *   hour-factors  BB-22 — per product and market, the learned hour factor of each hour of the week against the approved
 *            plan's, with its confidence, and what it would apply inside each cell's limits
 *   probes   BB-21 — the switchback probes that measure each keyword's bid elasticity ε, and ε per product from them
 */
import { FEATURES as F } from '@nexus/shared/permissions'
import type { BrainReadArgs } from '../../advertising/bid-brain/read.js'
import { BID_BRAIN_MONEY, BID_BRAIN_VIEW_INPUT, readBidBrainView } from '../../advertising/brain/read-view.js'
import type { AgentTool } from '../tool-types.js'

const bidBrain: AgentTool = {
  name: 'bid-brain',
  title: 'Bid brain',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  // The money keys, the input and the settled-window read live in advertising/brain/read-view.ts: the brain page's
  // routes read the same views through the same code (ads brain page A1).
  restrictedFields: BID_BRAIN_MONEY,
  input: BID_BRAIN_VIEW_INPUT,
  description:
    "Read the bid brain: the one engine that will decide every Amazon Sponsored Products keyword bid from the business's "
    + 'goal (goal bid × hour factor, then placements, inside the limits, unless a stop, a pin or stock says otherwise). It '
    + 'decides every 6 hours the keywords of the allowlisted campaigns in IT and DE: in SHADOW it logs what it would set '
    + 'next to what today\'s writers set and writes nothing; for a campaign set-bid-brain-enrollment put LIVE (while the '
    + 'server switch is live) it is the one bid writer and its decisions are sent (mode LIVE, and sent: what became of each; '
    + 'owned lists those campaigns). view why (default): each keyword\'s newest decision — '
    + 'write, hold or brake, the deciding layer (brake, stop, pin, stock, freeze, phase, min_bid_hour, money — the money brain\'s step down above its pace —, intraday — a brake on today\'s spend, a lane\'s CPC spike or a budget that runs out early (NEXUS_BID_BRAIN_INTRADAY: shadow by default, the why names what it would do) —, restore — the bids going back after a stop or a brake lifted —, goal, band, limit, '
    + 'no_goal), today\'s bid and the brain\'s, the goal bid, the aim and band, the expected ACoS at today\'s bid, how much '
    + 'of the estimate rests on data — and a one-line why. view what-if: the same keywords decided again now with '
    + 'targetAcosPct (and bandLoPct / bandHiPct): what the brain would set, not stored and not sent (set-ads-strategy '
    + 'changes the real target). view diff: per day, agree / higher / lower / hold / brake against today\'s bids, conflicts '
    + '(keywords two different automatic writers changed within 24 hours), churn (bid writes per keyword) and the brain\'s own '
    + 'writes. view calibration: the attribution lag curve L(a) per market (and per product with enough orders of its own) — '
    + 'the share of a day\'s final 7-day orders and sales a copy pulled a days after the day already holds, what it rests on '
    + '(vintage days, the 1d/7d seed), and how well a curve fitted without the newest settled days nowcast them (mean '
    + 'absolute error per age, against reading the young copy as final); the brain\'s nowcast weights young days by it '
    + '(NEXUS_BID_BRAIN_NOWCAST: shadow by default — the decisions stay on settled days and the why names any difference). '
    + 'view hour-factors: per product and market, the hour factor learned from the hourly feed for each hour of the week (the '
    + 'product\'s conversion pooled with its category and market, ÷ what a click costs per unit of bid there) against the factor '
    + 'the approved hourly plan paints there, its 90 % interval and confidence, the move it asks of each cell and what it would '
    + 'apply inside the cell\'s limits (never above the approved cell, at most hourCellMovePct below it, the Owner\'s locked hours '
    + 'and Min-bid hours untouched), and top of search\'s conversion cap; NEXUS_BID_BRAIN_HOUR_FACTORS: shadow by default — the '
    + 'plan runs as approved and the why names the move; a product with nothing learned yet, asked by productId, is learned '
    + 'now and stored nowhere. '
    + 'view probes: the switchback probes that measure how a keyword\'s clicks answer its bid (ε, which the profit-best bid '
    + 'needs): 12 days of two bids around the brain\'s own (±15 %, ±5 % on a protected, brand or winner term), 6 days each so '
    + 'the average is the brain\'s bid, each probe\'s days, what each side got (clicks, cost, orders), its reading of ε and '
    + 'its product\'s ε before and after; pools: ε per product from the probes (NEXUS_BID_BRAIN_PROBES: shadow by default — '
    + 'planned and measured, no bid changes, a shadow probe\'s measurement is a placebo; on — the bids of a campaign the brain '
    + 'owns follow the probe). Scope: a '
    + 'keyword (targetId), a campaign, a product, or a market. Bids, targets and the why are ad-spend money: hidden from a '
    + 'person without permission to see ad spend. Nexus only; reads nothing from Amazon.',
  handler: async (args) => {
    const out = await readBidBrainView(args as BrainReadArgs) // BB-14 — on the scheduler's settled window
    return 'error' in out ? { ok: false, error: out.error } : { ok: true, data: out.data }
  },
}

export const ADS_BID_BRAIN_TOOLS: AgentTool[] = [bidBrain]
