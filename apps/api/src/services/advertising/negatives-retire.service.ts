/**
 * NEG.3 — how a block ends, and the record it leaves.
 *
 * `ads-graduation.ts` refuses to let a negation rule reach AUTO because *"each needs a retirement
 * path designed alongside it, and none has one yet"*. This is that path.
 *
 * 🔴 EVERY WRITE HERE IS IRREVERSIBLE AT AMAZON. Archive is the only removal Amazon offers for a
 * negative keyword and archive is terminal — an archived negative cannot be un-archived, only
 * re-created as a new one. Two independent confirmations: our own `rollback.service.ts:151-156`
 * ("archive IS the delete on Amazon for these entities … and archive is terminal"), and Amazon's
 * own guidance that archived keywords cannot be accessed again. There is no un-archive in this
 * file and there must never be one.
 *
 * ── Three paths, and they are three because they leave three different records ────────────────
 *
 *   (a) AT AMAZON, ad-group scope — 2,017 rows. `updateAdTargetWithSync` → OutboundSyncQueue →
 *       the worker → `PUT /sp/negativeKeywords` on NEG.3's corrected routing. Gets the write gate,
 *       the audit row, the grace window and the outbound record for free.
 *   (b) AT AMAZON, campaign scope — measured 2026-08-12: **0 rows**. Every one of the 22
 *       campaign-level negatives in this account is local-only, so path (b) is implemented (the
 *       routing exists) and has no subject. It is not dead code; it is code with an empty domain.
 *   (c) LOCAL-ONLY — 42 rows with no `externalTargetId` (22 campaign-level + 20 ad-group). There
 *       is nothing at Amazon to archive. Removing one is a local delete plus an audit row, and the
 *       result says so: `delivery: 'not_applicable'`. Conflating "retired at Amazon" with "deleted a row
 *       Amazon never had" is how a split-brain becomes invisible.
 *
 * 🔴 The 62 already-ARCHIVED rows are not ours to retire. They were archived ON AMAZON and
 * mirrored in by `ads-v1-sync.service.ts` — zero of our action logs and zero outbound rows touch
 * them. This service refuses them rather than issuing a no-op that would log as a retirement.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { updateAdTargetWithSync, writeAdvertisingActionLog, type AdsActor } from './ads-mutation.service.js'
import { packEvidence, type AdWriteEvidence } from './ads-evidence.js'
import { getTermContext, normaliseNegTerm } from './negatives.service.js'

/** The ledger's name for a retirement. Distinct from `AD_ENTITY_STATE_UPDATE` on purpose. */
export const RETIRE_ACTION_TYPE = 'retire_negative'

export type RetireOutcomeKind =
  /** archived at Amazon (or enqueued for it) — path (a)/(b) */
  | 'retired'
  /** the row existed only here; deleted locally, nothing sent — path (c) */
  | 'removed_local'
  /** nothing to do: already archived, or already retired by us */
  | 'skipped'
  /** the write gate said no. A refusal is a fact, not an error. */
  | 'refused'
  /** something went wrong */
  | 'failed'

/**
 * 🔴 Delivery is a SEPARATE question from acceptance, and conflating them is the defect this whole
 * page exists to stop.
 *
 * `updateAdTargetWithSync` returns `ok: true` when the write is ENQUEUED, not when it lands. The
 * write gate runs later, in the worker. Measured on prod 2026-08-12 during stage 2: a pause on a
 * negative in a paused campaign was accepted locally (`ok: true`, the local row moved to PAUSED),
 * and the worker then SKIPPED it with
 * `[ADS-WRITE-GATE-DENY] campaign_allowlist: … (Campaign.liveBidWritesEnabled=false)`. Amazon was
 * never contacted, and the next v1 ingest quietly healed the local row back to ENABLED.
 *
 * So an outcome reports `delivery`, never a bare boolean:
 *   'not_applicable' — path (c); there was nothing at Amazon to reach
 *   'enqueued'       — accepted and queued; the gate has NOT run yet and may still refuse
 *   'refused'        — the gate said no, before any HTTP call
 *   'failed'         — attempted and rejected
 */
export type RetireDelivery = 'not_applicable' | 'enqueued' | 'refused' | 'failed'

export interface RetireOutcome {
  adTargetId: string
  term: string
  kind: RetireOutcomeKind
  /**
   * 🔴 Never `true` at enqueue time. `enqueued` means the gate has not run yet — poll
   * `outboundQueueId` for `syncStatus`/`errorMessage` to learn what actually happened.
   */
  delivery: RetireDelivery
  outboundQueueId: string | null
  actionLogId: string | null
  /** the gate's own words, verbatim, when it refused */
  reason: string | null
  scope: { campaignName: string; adGroupName: string; level: string } | null
}

export interface RetireRequest {
  adTargetIds: string[]
  actor: AdsActor
  /** the operator's own words, stored on the row */
  retireReason?: string | null
  /** optional evidence override; by default the term's numbers at the moment of removal */
  evidence?: AdWriteEvidence | null
}

export interface RetireResult {
  outcomes: RetireOutcome[]
  summary: { retired: number; removedLocal: number; skipped: number; refused: number; failed: number; attempted: number }
}

/**
 * The term's numbers AT THE MOMENT OF REMOVAL, stamped onto the audit row.
 *
 * 0 of the 856 existing create-logs carry evidence, so "why does this negative exist" is
 * unanswerable for the whole base. This is the half that makes "did removing it help?" answerable
 * in a month without reconstructing history — and it is deliberately taken from `getTermContext`,
 * the single owner of that derivation, rather than re-derived here.
 */
async function evidenceForTerm(term: string, market: string): Promise<AdWriteEvidence | null> {
  try {
    const ctx = await getTermContext({ term, market })
    if (!ctx) return null
    return packEvidence({
      metric: 'searchTermOrders',
      observed: ctx.performance.orders,
      threshold: null,
      windowDays: ctx.window.days,
      sampleSize: ctx.performance.impressions,
      sampleUnit: 'impressions',
      note:
        `at retirement: ${ctx.performance.orders} orders / €${(ctx.performance.salesCents / 100).toFixed(2)} on ` +
        `€${(ctx.performance.spendCents / 100).toFixed(2)} in ${ctx.window.days}d; ` +
        `${ctx.history.orders} orders / €${(ctx.history.salesCents / 100).toFixed(2)} in ${ctx.history.days}d; ` +
        `negated in ${ctx.comparable.negatedAdGroups} ad groups, runs in ${ctx.runsIn.length}, ` +
        `overlap ${ctx.overlap.length} (${ctx.overlapRows} rows); ` +
        `${ctx.spread.rows - 1} other negations of this term remain`,
    })
  } catch (e) {
    // 🔴 An evidence failure must never block or silently succeed a retirement. It is recorded as
    // an absence, not swallowed into a `{}` that would read as "measured, and there was nothing".
    logger.warn('[neg-retire] evidence derivation failed — retiring WITHOUT evidence', { term, error: (e as Error).message })
    return null
  }
}

/**
 * Retire one or more negatives.
 *
 * 🔴 Per-row outcomes, always. 72 writes have 72 independent failure modes, and a single "done"
 * over 72 attempts is exactly how the 42 unconfirmed rows became invisible in the first place.
 * Five outcome classes, counted separately, with the untouched ids named.
 *
 * 🔴 Stops on a gate refusal for the REMAINING rows of that batch rather than retrying silently:
 * a gate that refuses one row of a term will refuse the rest for the same reason, and an operator
 * needs to see what did not happen more than they need the loop to finish.
 */
export async function retireNegatives(req: RetireRequest): Promise<RetireResult> {
  const outcomes: RetireOutcome[] = []
  const rows = await prisma.adTarget.findMany({
    where: { id: { in: req.adTargetIds }, isNegative: true },
    select: {
      id: true, expressionValue: true, status: true, externalTargetId: true, negativeLevel: true,
      retiredAt: true,
      adGroup: { select: { name: true, campaign: { select: { name: true, marketplace: true } } } },
    },
  })
  const found = new Set(rows.map((r) => r.id))
  for (const missing of req.adTargetIds.filter((id) => !found.has(id))) {
    outcomes.push({
      adTargetId: missing, term: '—', kind: 'failed', delivery: 'failed',
      outboundQueueId: null, actionLogId: null,
      reason: 'no negative with that id (it may have been removed already, or it is not a negative)',
      scope: null,
    })
  }

  // One evidence derivation per distinct term, not per row: bulk-retiring 72 rows of one term must
  // not run the term-context read 72 times.
  const evidenceByTerm = new Map<string, AdWriteEvidence | null>()
  let gateRefused: string | null = null

  for (const row of rows) {
    const term = row.expressionValue
    const scope = {
      campaignName: row.adGroup?.campaign?.name ?? '—',
      adGroupName: row.adGroup?.name ?? '—',
      level: row.negativeLevel === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP',
    }
    const base = { adTargetId: row.id, term, outboundQueueId: null, actionLogId: null, scope }

    // Once the gate has refused in this batch, do not keep asking. Name the rest as untouched.
    if (gateRefused) {
      outcomes.push({ ...base, kind: 'refused', delivery: 'refused', reason: `not attempted — the write gate refused earlier in this batch: ${gateRefused}` })
      continue
    }

    // 🔴 Already archived — on Amazon, by someone else, mirrored in. Not ours to retire, and a
    // no-op that logged as a retirement would be a false record.
    if (String(row.status) === 'ARCHIVED') {
      outcomes.push({ ...base, kind: 'skipped', delivery: 'not_applicable', reason: 'already archived at Amazon — mirrored in by the sync, not retired through this product' })
      continue
    }
    if (row.retiredAt) {
      outcomes.push({ ...base, kind: 'skipped', delivery: 'not_applicable', reason: `already retired here on ${row.retiredAt.toISOString().slice(0, 10)}` })
      continue
    }

    const market = row.adGroup?.campaign?.marketplace ?? 'all'
    const key = normaliseNegTerm(term)
    if (!evidenceByTerm.has(key)) evidenceByTerm.set(key, req.evidence ?? (await evidenceForTerm(term, market)))
    const evidence = evidenceByTerm.get(key) ?? null

    // ── path (c): local-only ────────────────────────────────────────────────────────────────
    if (!row.externalTargetId) {
      try {
        // The audit row is written BEFORE the delete, so the record survives even if the delete
        // fails — the opposite order would lose the fact that we tried.
        const actionLogId = await writeAdvertisingActionLog({
          actor: req.actor,
          actionType: RETIRE_ACTION_TYPE,
          entityType: 'AD_TARGET',
          entityId: row.id,
          evidence,
          payloadBefore: { status: row.status, externalTargetId: null, negativeLevel: row.negativeLevel, expressionValue: term },
          payloadAfter: { removed: 'local-only', delivery: 'not_applicable', reachedAmazon: false, retireReason: req.retireReason ?? null },
          outboundQueueId: null,
        })
        await prisma.adTarget.delete({ where: { id: row.id } })
        logger.info('[neg-retire] local-only negative removed — nothing was sent to Amazon', { adTargetId: row.id, term })
        outcomes.push({
          ...base, kind: 'removed_local', delivery: 'not_applicable', actionLogId,
          reason: 'Amazon never confirmed this negative, so there was nothing there to archive. Our record is gone; nothing changed at Amazon.',
        })
      } catch (e) {
        outcomes.push({ ...base, kind: 'failed', delivery: 'failed', reason: (e as Error).message })
      }
      continue
    }

    // ── paths (a) and (b): at Amazon ────────────────────────────────────────────────────────
    try {
      const res = await updateAdTargetWithSync({
        adTargetId: row.id,
        patch: { status: 'ARCHIVED' },
        actor: req.actor,
        reason: req.retireReason ?? 'retired through Negative Targeting',
        evidence,
        actionType: RETIRE_ACTION_TYPE,
        applyImmediately: true,
      })
      if (!res.ok) {
        // `no_changes` is a genuine skip, not a failure; everything else is refused or failed.
        if (res.error === 'no_changes') {
          outcomes.push({ ...base, kind: 'skipped', delivery: 'not_applicable', reason: 'already in that state' })
          continue
        }
        const refusedByGate = res.error === 'entity_orphaned' || String(res.error ?? '').startsWith('gate')
        if (refusedByGate) gateRefused = String(res.error)
        outcomes.push({ ...base, kind: refusedByGate ? 'refused' : 'failed', delivery: 'refused', reason: String(res.error ?? 'unknown') })
        continue
      }
      // 🔴 `retiredAt` records that WE decided, not that Amazon agreed. The outbound row carries
      // the delivery question and `syncStatus`/`errorMessage` answer it — the gate can still refuse
      // this, in the worker, minutes from now.
      await prisma.adTarget.update({
        where: { id: row.id },
        data: { retiredAt: new Date(), retireReason: req.retireReason ?? null },
      })
      outcomes.push({
        ...base, kind: 'retired', delivery: 'enqueued',
        outboundQueueId: res.outboundQueueId, actionLogId: res.actionLogId,
        reason: 'archived locally and queued for Amazon — the write gate has not run yet; poll the outbound row for the outcome',
      })
    } catch (e) {
      outcomes.push({ ...base, kind: 'failed', delivery: 'failed', reason: (e as Error).message })
    }
  }

  const count = (k: RetireOutcomeKind) => outcomes.filter((o) => o.kind === k).length
  const summary = {
    retired: count('retired'),
    removedLocal: count('removed_local'),
    skipped: count('skipped'),
    refused: count('refused'),
    failed: count('failed'),
    attempted: outcomes.length,
  }
  logger.info('[neg-retire] batch complete', summary)
  return { outcomes, summary }
}
