/**
 * KAPI-B (2026-10-10, Bid page "keyword Auto + goal + max bid") — one keyword's Auto / Manual, the service of
 * POST /api/advertising/bids/:targetId/mode (routes/advertising-bid-mode.routes.ts).
 *
 *   MANUAL   a PERSON hold with no end on the keyword (bid-brain/brain-holds.ts holdKeywordManual): the bid brain leaves it
 *            (its pin layer) until he switches it back; his own bids on it keep it Manual
 *   AUTO     hand back (handBackKeyword): the keyword's open PIN / PERSON / CLAUDE holds end and a hand-back mark is stored,
 *            so his bid of the last 60 days from before it no longer holds the keyword for the brain
 *   where    only on a campaign the bid brain owns now (bid-brain/live.ts): elsewhere no engine runs the keyword for him,
 *            so there is no Auto to switch to (409, said plainly). Auto is refused while something wider than this
 *            keyword holds it — the campaign's pinned bids, a person's hold on the whole campaign, the Owner's lock of the
 *            keyword's or its ad group's bid (set-ads-brain lock) — each named with what lifts it
 *   undo     the answer carries `before` (the mode it had) and `undo: { mode }`: the same route with that mode puts it back;
 *            the holds it ended are listed (id, kind, end)
 *
 * Nothing is sent to Amazon: the bid stays where it is; the brain acts on it (or leaves it) at its next tick.
 */
import prisma from '../../db.js'
import { personBidTargetIds } from './bid-grid.service.js'
import { handBackKeyword, holdKeywordManual, PERSON_HOLD_KINDS } from './bid-brain/brain-holds.js'
import { brainOwnedCampaignIds } from './bid-brain/live.js'
import { loadKeywordOwn } from './bid-brain/load.js'
import { strategyMarket } from './ads-strategy/bids.js'

export const BID_MODES = ['AUTO', 'MANUAL'] as const
export type BidMode = (typeof BID_MODES)[number]

export interface BidModeAnswer {
  targetId: string
  campaignId: string
  mode: BidMode
  /** The mode the keyword had before this request. */
  before: BidMode
  /** False when it already was in the mode asked (nothing written). */
  changed: boolean
  /** MANUAL: the no-end PERSON hold that holds it. */
  holdId: string | null
  /** The holds this request ended (MANUAL: a 60-day hold the no-end one replaced; AUTO: every person's hold of the keyword). */
  ended: Array<{ id: string; kind: string; until: string | null }>
  /** The same route with this body puts it back. */
  undo: { mode: BidMode }
  /** One plain line: what the brain does with the keyword now. */
  words: string
}

/** The api tsconfig is not strict (a boolean discriminant does not narrow): the caller asks `'error' in out`. */
export type BidModeOutcome = { data: BidModeAnswer } | { status: 404 | 409; error: string }

const no = (status: 404 | 409, error: string): BidModeOutcome => ({ status, error })

/** Set one keyword to Auto (the bid brain runs it) or Manual (the person bids it), as `actor` (`user:<id>`). */
export async function setBidMode(targetId: string, mode: BidMode, actor: string, now: Date = new Date()): Promise<BidModeOutcome> {
  const t = await prisma.adTarget.findFirst({
    where: { id: targetId, isNegative: false, status: { not: 'ARCHIVED' } },
    select: { id: true, adGroupId: true, adGroup: { select: { campaignId: true, campaign: { select: { pinBids: true, pinnedBy: true, marketplace: true, liveBidWritesEnabled: true } } } } },
  })
  if (!t) return no(404, `No keyword or target ${targetId} in this business.`)
  const campaignId = t.adGroup.campaignId
  const campaign = t.adGroup.campaign
  // The bid brain decides only for a campaign on the live-write allowlist that it owns (facts.ts, live.ts).
  const notRun = !campaign.liveBidWritesEnabled
    ? 'Live bid writes are off for this campaign: no engine changes its bids, so this keyword has no Auto.'
    : !(await brainOwnedCampaignIds([campaignId])).has(campaignId)
      ? 'No engine runs this campaign: the bid brain does not run it, so this keyword has no Auto — its bid is yours to set.'
      : null

  const [targetHolds, campaignHold, held, own] = await Promise.all([
    prisma.bidHold.findMany({ where: { campaignId, targetId, endedAt: null, kind: { in: [...PERSON_HOLD_KINDS] }, OR: [{ until: null }, { until: { gt: now } }] }, select: { id: true } }),
    prisma.bidHold.findFirst({ where: { campaignId, targetId: null, endedAt: null, kind: { in: [...PERSON_HOLD_KINDS] }, OR: [{ until: null }, { until: { gt: now } }] }, select: { kind: true, by: true } }),
    personBidTargetIds({ targetIds: [targetId], now }),
    loadKeywordOwn([{ id: targetId, adGroupId: t.adGroupId, campaignId, market: strategyMarket(campaign.marketplace) }]),
  ])
  const lock = own.get(targetId)?.lock ?? null
  const before: BidMode = campaign.pinBids || campaignHold || lock || targetHolds.length || held.has(targetId) ? 'MANUAL' : 'AUTO'

  if (notRun) {
    // A Manual hold made while the brain ran outlives it (the campaign back in shadow, off the allowlist): it still keeps
    // auto-bid away (bid-grid personBidTargetIds), so Auto must always be able to end the keyword's own hold.
    if (mode === 'AUTO' && targetHolds.length) {
      const back = await handBackKeyword({ campaignId, targetId, actor, now })
      return {
        data: {
          targetId, campaignId, mode, before, changed: true, holdId: null, ended: back.ended, undo: { mode: before },
          words: 'Your hold on this keyword ended. No engine runs this campaign now, so its bid stays where it is.',
        },
      }
    }
    return no(409, notRun)
  }

  if (mode === 'MANUAL') {
    const h = await holdKeywordManual({ campaignId, targetId, actor, now })
    return {
      data: {
        targetId, campaignId, mode, before, changed: !h.already, holdId: h.holdId, ended: h.ended.map((id) => ({ id, kind: 'PERSON', until: null })), undo: { mode: before },
        words: 'Manual: the bid brain leaves this keyword until you switch it back to Auto.',
      },
    }
  }

  // AUTO — refused while something wider than this keyword's own hold keeps it Manual (said with what lifts it).
  if (campaign.pinBids) return no(409, `Every bid of this campaign is locked (pinned bids${campaign.pinnedBy ? ` by ${campaign.pinnedBy}` : ''}): unlock the campaign's bids to hand this keyword back to the brain.`)
  if (campaignHold) return no(409, `A ${campaignHold.kind.toLowerCase()} hold on the whole campaign (by ${campaignHold.by}) keeps every keyword there Manual: give the campaign's bids back to hand this keyword back to the brain.`)
  if (lock) return no(409, `${lock.by[0].toUpperCase()}${lock.by.slice(1)}: unlock it (the brain's lock of the bids) to hand this keyword back to the brain.`)
  if (before === 'AUTO') {
    return { data: { targetId, campaignId, mode, before, changed: false, holdId: null, ended: [], undo: { mode: before }, words: 'Auto: the bid brain runs this keyword.' } }
  }
  const back = await handBackKeyword({ campaignId, targetId, actor, now })
  return {
    data: {
      targetId, campaignId, mode, before, changed: true, holdId: null, ended: back.ended, undo: { mode: before },
      words: 'Auto: the bid brain runs this keyword again from its next tick (the bid stays where it is until then).',
    },
  }
}
