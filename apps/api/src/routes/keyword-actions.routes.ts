/**
 * KT.6 / KT.7 — the Keyword Tracker's action endpoints.
 *
 * 🔴 **A NEW FILE, and not `advertising-intel.routes.ts`, on purpose.** KT.1's own header explains why
 * that file rather than `advertising.routes.ts`: a duplicate route registration is a boot crash, not a
 * warning. The reason for a third file is narrower and is about this hour specifically — another
 * session had 13 uncommitted lines in `advertising-intel.routes.ts` when this was written, and
 * `git commit --only <that path>` commits the file's working state, so adding a route there would have
 * swept their work into this commit. That has happened four times in this programme. A new file has no
 * such hazard and no duplicate-route risk.
 *
 * 🔴 **KT.7 changed what this file can do, and this header used to say the opposite.** `POST /apply`
 * writes real bids to Amazon, through `updateAdTargetWithSync` → `OutboundSyncQueue` →
 * `ads-sync.worker.ts:366` → `checkAdsWriteGate`. Nothing here bypasses that chokepoint and nothing
 * here calls the Ads client directly.
 *
 * The rest are reads: `/preview` (what a change would do), `/proposals`, `/ceilings`, `/changes` (the
 * scoped change log). `POST /propose` records a `KeywordBidProposal` and reaches no further.
 * `POST /undo` is a pass-through to the existing `rollbackByActionLogId`, which reverses a whole
 * change set — **KT.7 builds no rollback of its own.**
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

    const result = await proposeBidChange({
      term: q.term.trim(),
      marketplace: q.market.toUpperCase(),
      requestedBidCents: bid.cents,
      includeSuppressed: b.includeSuppressed === true,
      proposedBy: typeof b.userId === 'string' && b.userId.trim() ? b.userId.trim() : null,
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
   * KT.7 — APPLY. 🔴 The one endpoint on this page that writes to Amazon.
   *
   * Every guard is re-evaluated from current state inside `applyProposal`; this handler only
   * validates input and shapes the answer. `maxTargets` exists for §6's gate: the first real write is
   * capped to one target, using the same code path as a full apply rather than a special case.
   *
   * A refusal is 409 — the request was well formed and was declined — and its message is already
   * operator-ready, because refusals must never be silent.
   */
  fastify.post('/advertising/keyword-actions/apply', async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, unknown>
    const proposalId = String(b.proposalId ?? '')
    if (!proposalId) { reply.status(400); return { error: 'proposalId is required', code: 'proposal_required' } }
    const maxTargets = b.maxTargets == null ? undefined : Number(b.maxTargets)
    if (maxTargets != null && (!Number.isInteger(maxTargets) || maxTargets < 1)) {
      reply.status(400); return { error: 'maxTargets must be a whole number of at least 1', code: 'max_targets_invalid' }
    }
    // 🔴 The actor comes from the BODY, following `/advertising/changes/:actionLogId/undo`'s own
    // convention (`b.userId ? \`user:${b.userId}\` : 'user:console'`). These routes have no server-side
    // session: `request.user` is undefined here, which is why a UI apply first recorded the generic
    // `user:operator`. It is client-supplied and therefore not proof of identity — `ads-write-gate.ts`
    // says so plainly, "the gate cannot reliably tell a person from an engine: actor is free text" —
    // but it is what makes an operator row distinguishable from an engine row, which is what D3 needs.
    const { applyProposal } = await import('../services/advertising/kt7-apply.service.js')
    const r = await applyProposal({
      proposalId,
      actorEmail: typeof b.userId === 'string' && b.userId.trim() ? b.userId.trim() : null,
      maxTargets,
      includeSuppressed: b.includeSuppressed === true,
    })
    if (!r.ok) {
      reply.status(409)
      return { error: r.summary, code: r.refusalCode ?? 'refused', applied: r.applied, refused: r.refused, skipped: r.skipped, rows: r.rows }
    }
    return r
  })

  /**
   * KT.7 — the scoped change log: every change to any keyword target behind THIS term, whoever made
   * it. Not a live account feed — measured, `AD_BID_UPDATE` alone is 925 rows in 24h and the
   * suppress/restore cycle accounts for most of it, so an unscoped log on this page would be noise.
   *
   * Reuses `listChanges`, which already resolves an actor string into a source and origin, so an
   * engine row and an operator row are distinguishable without this endpoint re-deriving it.
   */
  fastify.get('/advertising/keyword-actions/changes', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const bad = badRequest(q)
    if (bad) { reply.status(400); return bad }
    const market = (q.market ?? '').toUpperCase()
    const { loadRow } = await import('../services/advertising/kt6-proposal.service.js')
    const { listChanges } = await import('../services/advertising/ads-changes.service.js')
    const { previewRollbackOfAction } = await import('../services/advertising/rollback.service.js')

    const row = await loadRow(q.term!.trim(), market)
    const targetIds = row.targets.map((t) => t.id)
    if (targetIds.length === 0) {
      // 🔴 "no changes" and "nothing we could have recorded a change for" are different facts.
      return {
        items: [], count: 0, targetsInScope: 0,
        emptyReason: 'no_targets',
        emptyText: `No campaign bids “${q.term}” in ${market}, so there are no keyword targets whose changes could be recorded. This is not an empty log — there is nothing for a log to be about.`,
      }
    }
    const days = Math.max(1, Math.min(90, Number(q.days) || 14))
    const res = await listChanges({
      entityIds: targetIds,
      entityType: 'AD_TARGET',
      from: new Date(Date.now() - days * 86_400_000),
      limit: Math.max(1, Math.min(200, Number(q.limit) || 60)),
    })

    // ── the undo offer, and 🔴 why `it.id` is NOT the handle ──────────────────────────────────
    //
    // `listChanges` merges two tables and prefixes its display ids: `h:<CampaignBidHistory.id>` and
    // `a:<AdvertisingActionLog.id>`. It also computes `undoable` + `undoActionLogId` using the same
    // rule object the rollback service uses — but for an AD_TARGET **bid** row it deliberately leaves
    // the handle null, because that undo historically ran through the per-campaign history path.
    //
    // KT.7's writes DO have an action-log row (with a change set, proven by the §6 gate), so the
    // handle exists; it just is not on the display row. Passing `it.id` to the rollback service asked
    // it to look up "h:cmsr…" in AdvertisingActionLog and got "That change no longer exists" for a
    // change that very much existed — which is what this looked like on the first run.
    //
    // So the handles are resolved from the log itself and matched on (entityId, second).
    const logRows = await prisma.advertisingActionLog.findMany({
      where: {
        entityType: 'AD_TARGET', entityId: { in: targetIds },
        createdAt: { gte: new Date(Date.now() - days * 86_400_000) },
      },
      select: { id: true, entityId: true, createdAt: true, executionId: true, rolledBackAt: true },
    })
    // 🔴 NOT an exact-second key. The two tables are written microseconds apart, so a change at
    // 12:16:59.8 lands in one at :59 and the other at :60 — and a missed handle makes the row claim no
    // undo is offered for a change that is perfectly reversible. Observed on production. Matched to the
    // nearest log row for the same entity within a few seconds instead.
    const MATCH_WINDOW_MS = 4000
    const byEntity = new Map<string, typeof logRows>()
    for (const l of logRows) {
      const arr = byEntity.get(l.entityId) ?? []
      arr.push(l); byEntity.set(l.entityId, arr)
    }
    const findHandle = (entityId: string, at: number) => {
      const arr = byEntity.get(entityId)
      if (!arr?.length) return null
      let best: (typeof logRows)[number] | null = null
      let bestGap = Infinity
      for (const l of arr) {
        const gap = Math.abs(l.createdAt.getTime() - at)
        if (gap < bestGap) { bestGap = gap; best = l }
      }
      if (!best || bestGap > MATCH_WINDOW_MS) return null
      return { id: best.id, changeSetId: best.executionId, rolledBack: best.rolledBackAt != null }
    }

    const items = await Promise.all(res.items.map(async (it) => {
      const handle = findHandle(it.entity.id, new Date(it.at).getTime())
        ?? (it.undoActionLogId ? { id: it.undoActionLogId, changeSetId: null, rolledBack: false } : null)
      const undo = handle ? await previewRollbackOfAction(handle.id).catch(() => null) : null
      return {
        undoActionLogId: handle?.id ?? null,
        id: it.id, at: it.at, actor: it.actor, source: it.source, origin: it.origin,
        entity: it.entity, campaign: it.campaign, field: it.field,
        oldValue: it.oldValue, newValue: it.newValue, reason: it.reason,
        undo: undo
          ? {
              eligible: undo.eligible, reason: undo.reason ?? null,
              groupedWith: undo.groupedWith ?? 1, changeSetId: undo.changeSetId ?? null,
            }
          // 🔴 no handle is NOT "not undoable" — it is "this row's undo is not offered here".
          // Saying the wrong one would tell an operator a reversible change cannot be reversed.
          : { eligible: false, reason: 'No undo is offered for this row from this page.', groupedWith: 1, changeSetId: null },
      }
    }))
    return {
      items, count: res.count, targetsInScope: targetIds.length,
      windowDays: days,
      emptyReason: items.length === 0 ? 'no_changes_in_window' : null,
      emptyText: items.length === 0
        ? `No change to any of the ${targetIds.length} keyword target${targetIds.length === 1 ? '' : 's'} behind “${q.term}” in the last ${days} days. The targets exist and are being watched — nothing has moved them.`
        : null,
      /** the existing exporter, not a second one */
      csvHref: `/api/advertising/changes.csv?entityType=AD_TARGET&limit=5000`,
    }
  })

  /**
   * KT.7 — undo. A thin pass-through to `rollbackByActionLogId`, which reverses the WHOLE change set
   * when the row belongs to one. **No third rollback path is built here**; this endpoint exists only
   * so the drawer does not have to reach into `advertising.routes.ts`.
   */
  fastify.post('/advertising/keyword-actions/undo', async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, unknown>
    const actionLogId = String(b.actionLogId ?? '')
    if (!actionLogId) { reply.status(400); return { error: 'actionLogId is required', code: 'action_log_required' } }
    // Same convention as the apply route above, and as the existing undo route.
    const who = typeof b.userId === 'string' && b.userId.trim() ? b.userId.trim() : 'operator'
    const { rollbackByActionLogId } = await import('../services/advertising/rollback.service.js')
    const r = await rollbackByActionLogId({
      actionLogId,
      actor: `user:${who}`,
      reason: 'Keyword Tracker: undone by the operator',
    })
    if (!r.ok || r.reversed === 0) {
      reply.status(409)
      return {
        error: r.reason ?? (r.expired
          ? `The ${r.windowHours ?? 24}-hour undo window for this change has closed. It can no longer be reversed in one action; the values before the change are in the change log.`
          : 'Nothing was reversed.'),
        code: r.expired ? 'undo_window_closed' : 'undo_failed',
        reversed: r.reversed, skipped: r.skipped, failed: r.failed,
      }
    }
    return { reversed: r.reversed, skipped: r.skipped, failed: r.failed, details: r.details }
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
