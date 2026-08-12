/**
 * KT.6 — the Keyword Tracker's action endpoints.
 *
 * 🔴 **A NEW FILE, and not `advertising-intel.routes.ts`, on purpose.** KT.1's own header explains why
 * that file rather than `advertising.routes.ts`: a duplicate route registration is a boot crash, not a
 * warning. The reason for a third file is narrower and is about this hour specifically — another
 * session had 13 uncommitted lines in `advertising-intel.routes.ts` when this was written, and
 * `git commit --only <that path>` commits the file's working state, so adding a route there would have
 * swept their work into this commit. That has happened four times in this programme. A new file has no
 * such hazard and no duplicate-route risk.
 *
 * Everything here is a READ except `POST /propose`, which records a `KeywordBidProposal` row. **No
 * endpoint writes to Amazon or queues a mutation.** Applying a proposal is not implemented: it is a
 * live bid write and must go through `checkAdsWriteGate`, and the operator's approval for this session
 * covers shipping the controls in PROPOSE.
 */

import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import {
  previewBidChange, proposeBidChange, proposalsFor, committedToday,
} from '../services/advertising/kt6-proposal.service.js'
import { KT6_BID_FLOOR_CENTS } from '../services/advertising/kt6-bid-action.js'
import { KT6_CEILING_GRAINS } from '../services/advertising/kt6-spend-ceiling.js'

const KT_MARKETS = ['IT', 'DE', 'ES', 'FR'] as const

/** Shared validation. Returns an error object to send, or null when the input is good. */
function badRequest(q: Record<string, string | undefined>): { error: string; code: string } | null {
  const market = (q.market ?? '').toUpperCase()
  if (!KT_MARKETS.includes(market as (typeof KT_MARKETS)[number])) {
    return { error: `market is required and must be one of ${KT_MARKETS.join('/')}`, code: 'market_required' }
  }
  if (!q.term || !q.term.trim()) return { error: 'term is required', code: 'term_required' }
  return null
}

/**
 * A bid is validated here as well as in the blast radius, because the two answer different questions.
 * This rejects input that is not a bid at all; `computeBlastRadius` decides whether a real bid is
 * allowed on each target. Conflating them would let `?bid=abc` reach the arithmetic as NaN.
 */
function parseBid(raw: string | undefined): { cents: number } | { error: string; code: string } {
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { error: 'bidCents must be a whole number of cents', code: 'bid_invalid' }
  if (n <= 0) return { error: 'bidCents must be greater than zero', code: 'bid_invalid' }
  if (n > 10_000) return { error: 'bidCents above €100.00 is refused here — set a campaign ceiling instead', code: 'bid_absurd' }
  return { cents: n }
}

const keywordActionsRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * The preview. Read-only, and the same code path `POST /propose` re-runs, so the sentence the
   * operator reads and the sentence the proposal records cannot diverge.
   */
  fastify.get('/advertising/keyword-actions/preview', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const bad = badRequest(q)
    if (bad) { reply.status(400); return bad }
    const bid = parseBid(q.bidCents)
    if ('error' in bid) { reply.status(400); return bid }

    const preview = await previewBidChange({
      term: q.term!.trim(),
      marketplace: (q.market ?? '').toUpperCase(),
      requestedBidCents: bid.cents,
      includeSuppressed: q.includeSuppressed === '1',
    })

    // The radius carries full target rows; the wire only needs what the drawer renders.
    return {
      term: preview.term,
      marketplace: preview.marketplace,
      requestedBidCents: preview.requestedBidCents,
      floorCents: preview.floorCents,
      matched: { targets: preview.radius.matchedTargets, campaigns: preview.radius.matchedCampaigns },
      changing: { targets: preview.radius.actionable.length, campaigns: preview.radius.actionableCampaigns },
      excludedByReason: preview.radius.byReason,
      blockedCampaignNames: preview.radius.blockedCampaignNames,
      highestUniformAllowedCents: preview.radius.highestUniformAllowed,
      commitmentCents: preview.commitmentCents,
      ceiling: {
        verdict: preview.ceiling.verdict,
        message: preview.ceiling.message,
        grain: preview.ceiling.bound?.grain ?? null,
        label: preview.ceiling.bound?.label ?? null,
        capCents: preview.ceiling.bound?.dailyCapCents ?? null,
        remainingCents: preview.ceiling.remainingCents,
      },
      committed: preview.committed,
      shareAgeDays: preview.shareAgeDays,
      confirmationText: preview.confirmationText,
      canPropose: preview.canPropose,
      byCampaign: preview.byCampaign,
      /** the per-target detail, capped — a 100-target row must not ship 100 rows to render a count */
      sampleTargets: preview.radius.actionable.slice(0, 25).map((t) => ({
        id: t.id, campaignName: t.campaignName, matchType: t.matchType,
        fromCents: t.bidCents, toCents: preview.requestedBidCents, maxBidCents: t.maxBidCents,
      })),
      sampleTargetsTruncated: preview.radius.actionable.length > 25,
    }
  })

  /**
   * Raise the proposal. Records a row; nothing reaches Amazon.
   *
   * 🔴 Recomputes the radius server-side rather than trusting the body. A browser's numbers are
   * minutes old at best and bids move hourly, so a proposal recording what the client believed
   * instead of what the database holds could not be audited later.
   */
  fastify.post('/advertising/keyword-actions/propose', async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, unknown>
    const q = { market: String(b.market ?? ''), term: String(b.term ?? '') }
    const bad = badRequest(q)
    if (bad) { reply.status(400); return bad }
    const bid = parseBid(String(b.bidCents ?? ''))
    if ('error' in bid) { reply.status(400); return bid }

    const actor = (request as { user?: { id?: string; email?: string } }).user
    const result = await proposeBidChange({
      term: q.term.trim(),
      marketplace: q.market.toUpperCase(),
      requestedBidCents: bid.cents,
      includeSuppressed: b.includeSuppressed === true,
      proposedBy: actor?.email ?? actor?.id ?? null,
    })

    if (!result.ok) {
      // 409, not 400: the request was well formed and was REFUSED. A 400 would read as "you typed
      // it wrong", and D4 requires the refusal to say what actually stopped it.
      reply.status(409)
      return {
        error: result.reason,
        code: result.preview.ceiling.verdict === 'REFUSED' ? 'ceiling_refused' : 'nothing_to_do',
        ceiling: { verdict: result.preview.ceiling.verdict, message: result.preview.ceiling.message },
        changing: { targets: 0, campaigns: 0 },
      }
    }
    reply.status(201)
    return {
      id: result.id,
      status: 'PROPOSED',
      changing: { targets: result.preview.radius.actionable.length, campaigns: result.preview.radius.actionableCampaigns },
      commitmentCents: result.preview.commitmentCents,
      confirmationText: result.preview.confirmationText,
      ceiling: { verdict: result.preview.ceiling.verdict, message: result.preview.ceiling.message },
    }
  })

  /** The proposals raised for one row, newest first. */
  fastify.get('/advertising/keyword-actions/proposals', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const bad = badRequest(q)
    if (bad) { reply.status(400); return bad }
    const market = (q.market ?? '').toUpperCase()
    return {
      proposals: await proposalsFor(q.term!.trim(), market),
      committed: await committedToday(market),
    }
  })

  /**
   * The ceilings, for the operator to see what exists. Deliberately a READ only in this session:
   * setting a ceiling changes what refuses a write, and that is its own approval.
   */
  fastify.get('/advertising/keyword-actions/ceilings', async (request) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const rows = await prisma.adSpendCeiling.findMany({ orderBy: [{ grain: 'asc' }, { label: 'asc' }] })
    const market = (q.market ?? '').toUpperCase()
    return {
      grains: KT6_CEILING_GRAINS,
      floorCents: KT6_BID_FLOOR_CENTS,
      ceilings: rows.map((r) => ({
        id: r.id, grain: r.grain, scopeId: r.scopeId, label: r.label,
        dailyCapCents: r.dailyCapCents, enabled: r.enabled, note: r.note,
        /** stated explicitly, because a null cap is not an unlimited one */
        isCeiling: r.dailyCapCents != null,
      })),
      /** the honest empty state: no ceiling anywhere means nothing is capped */
      anyCeilingSet: rows.some((r) => r.enabled && r.dailyCapCents != null),
      committed: KT_MARKETS.includes(market as (typeof KT_MARKETS)[number]) ? await committedToday(market) : null,
    }
  })
}

export default keywordActionsRoutes
