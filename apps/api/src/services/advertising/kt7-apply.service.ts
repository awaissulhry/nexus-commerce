/**
 * KT.7 — turn a `KeywordBidProposal` into real bid writes.
 *
 * This is the first thing on the Keyword Tracker that spends money, so the shape is deliberately
 * conservative: re-decide everything from current state, refuse rather than adapt, write through the
 * one chokepoint, and tag the whole set so a single undo reverses all of it.
 *
 * ── Five re-checks at apply time, not proposal time ───────────────────────────────────────────
 *
 * A proposal is a photograph. Bids in this account move constantly — measured over 7 days, 6,094
 * `AD_BID_UPDATE` rows on keyword targets, of which 3,146 dropped a bid to 2¢ and 2,271 raised one
 * back — so a proposal made an hour ago may describe targets that no longer exist, are no longer
 * writable, or have already moved. Every guard is therefore re-evaluated here:
 *
 *   1. **The blast radius**, recomputed from current bids, current allowlist, current ceilings.
 *   2. **The spend ceiling**, against the ledger as it stands now.
 *   3. **The suppression exclusion** (see below).
 *   4. **The target set is unchanged** — if it is not, refuse the whole apply rather than writing a
 *      subset nobody approved.
 *   5. 🔴 **The campaign is not currently bid-suppressed.** Not in the brief, and found by reading
 *      `ads-bid-suppression.service.ts`: if `Campaign.bidsSuppressedAt` is set, the next resume
 *      restores every target from `suppressedFromBidCents` and would silently overwrite whatever we
 *      wrote, with the engine's actor on the row. Writing into a suppressed campaign is not a write,
 *      it is a write with a delayed undo attached.
 *
 * ── The suppression decision, and why it needs no new storage ─────────────────────────────────
 *
 * The house rule is *no pause — suppress with a ~2¢ bid*, so a low bid is often an off-switch. KT.6
 * excluded those targets from the radius; KT.7 is what would actually destroy something, so the rule
 * is stated here in full:
 *
 * **Refuse by default. On explicit opt-in, proceed. Never write `suppressedFromBidCents`.**
 *
 * 🔴 The brief offered a second option — record the current bid into `suppressedFromBidCents` before
 * raising — and it is unsafe. That column is the no-pause state machine's memory, not a spare field:
 * `restoreCampaignBids` selects **every** row where it is non-null and writes the value back as the
 * bid, so anything stored there becomes a standing instruction executed later by an engine that never
 * suppressed the target. Two more consumers compute `maxBaseBid = MAX(bidCents,
 * suppressedFromBidCents)` (`ad-rank-defend.job.ts:548`, `rank-runtime.service.ts:133`), so writing it
 * would also inflate the ceiling the CPC cap derives from.
 *
 * No new storage is needed because the recovery already exists: every bid write records
 * `payloadBefore {"status":"ENABLED","bidCents":2}` — all 6,094 of them in 7 days — and the existing
 * per-change undo reads exactly that. The pre-bid is already durable, in the right place.
 *
 * ── One change set, so one undo reverses everything ──────────────────────────────────────────
 *
 * Every write in an apply carries the same `changeSetId`, which the mutation service stores as
 * `AdvertisingActionLog.executionId`. `rollbackByActionLogId` sees that and delegates to
 * `rollbackByChangeSetId`, reversing the whole set on a flat **24-hour** window — *"one operation that
 * wrote four fields is one thing the operator did, and unpicking a quarter of it would leave the
 * entity in a state that never existed."* So KT.7 builds **no rollback path of its own**: it tags its
 * writes and the existing undo does the rest. A synthetic `AutomationRuleExecution` row (which
 * `rollbackByExecutionId` would have required) is not created either.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { updateAdTargetWithSync, type AdsActor } from './ads-mutation.service.js'
import { computeBlastRadius, blastRadiusSentence, KT6_SUPPRESSION_CENTS, type Kt6Target } from './kt6-bid-action.js'
import { resolveCeiling, checkCeiling, commitmentCents } from './kt6-spend-ceiling.js'
import { loadRow, ceilingsFor, committedToday, shareAge } from './kt6-proposal.service.js'

/** The flat window the change-set rollback honours. Stated so the UI cannot invent a different one. */
export const KT7_UNDO_WINDOW_HOURS = 24

export type Kt7RefusalCode =
  | 'not_proposed'
  | 'stale_target_set'
  | 'ceiling_refused'
  | 'campaign_suppressed'
  | 'nothing_actionable'
  | 'suppressed_target'
  | 'write_failed'

export interface Kt7RowOutcome {
  adTargetId: string
  campaignName: string
  fromCents: number | null
  toCents: number
  outcome: 'APPLIED' | 'REFUSED' | 'SKIPPED'
  code?: Kt7RefusalCode
  reason?: string
  actionLogId?: string | null
}

export interface Kt7ApplyResult {
  ok: boolean
  proposalId: string
  changeSetId: string | null
  /** the three numbers §4.1 requires, and they must always sum to the set considered */
  applied: number
  refused: number
  skipped: number
  rows: Kt7RowOutcome[]
  /** operator-facing, full sentences */
  summary: string
  refusalCode?: Kt7RefusalCode
  undoWindowHours: number
  /** an actionLogId from the set — undoing any one of them reverses all of them */
  undoHandleActionLogId: string | null
}

/**
 * Apply one proposal.
 *
 * `maxTargets` exists for §6's gate: the first real write is deliberately the smallest reversible
 * change that can be constructed, so the caller can cap the set to one target without inventing a
 * different code path for it.
 */
export async function applyProposal(args: {
  proposalId: string
  actorEmail?: string | null
  /** cap the number of targets written — §6's one-target first write */
  maxTargets?: number
  /** the operator explicitly accepts raising deliberately-suppressed targets */
  includeSuppressed?: boolean
  reason?: string
}): Promise<Kt7ApplyResult> {
  const p = await prisma.keywordBidProposal.findUnique({ where: { id: args.proposalId } })
  const base = {
    proposalId: args.proposalId, changeSetId: null as string | null,
    applied: 0, refused: 0, skipped: 0, rows: [] as Kt7RowOutcome[],
    undoWindowHours: KT7_UNDO_WINDOW_HOURS, undoHandleActionLogId: null as string | null,
  }
  if (!p) {
    return { ...base, ok: false, refusalCode: 'not_proposed', summary: 'That proposal no longer exists.' }
  }
  if (p.status !== 'PROPOSED') {
    return {
      ...base, ok: false, refusalCode: 'not_proposed',
      summary: `This proposal is already ${p.status.toLowerCase()}, so there is nothing to apply. A proposal can only be applied once — that is what makes the change log's count trustworthy.`,
    }
  }

  // ── 1 · recompute the radius from CURRENT state ──────────────────────────────────────────────
  const row = await loadRow(p.term, p.marketplace)
  const radius = computeBlastRadius(row.targets, p.requestedBidCents, {
    includeSuppressed: args.includeSuppressed ?? false,
  })

  // ── 4 · has the target set moved since the proposal? ─────────────────────────────────────────
  const proposed = new Set((p.targetIds as string[]) ?? [])
  const nowSet = new Set(radius.actionable.map((t) => t.id))
  const gone = [...proposed].filter((id) => !nowSet.has(id))
  const added = [...nowSet].filter((id) => !proposed.has(id))
  if (gone.length > 0 || added.length > 0) {
    await prisma.keywordBidProposal.update({
      where: { id: p.id },
      data: { status: 'REFUSED', decidedAt: new Date(), decidedBy: args.actorEmail ?? null },
    }).catch(() => {})
    return {
      ...base, ok: false, refusalCode: 'stale_target_set',
      summary: `Refused — this proposal describes ${proposed.size} target${proposed.size === 1 ? '' : 's'} and the row now resolves to ${nowSet.size}. ${gone.length ? `${gone.length} of the original ${gone.length === 1 ? 'target is' : 'targets are'} no longer eligible` : ''}${gone.length && added.length ? ' and ' : ''}${added.length ? `${added.length} new ${added.length === 1 ? 'target is' : 'targets are'} now eligible` : ''}. Bids in this account move constantly — 6,094 keyword bid writes in the last seven days — so rather than apply a set nobody approved, the proposal is closed. Raise a new one against what the row looks like now.`,
    }
  }
  if (radius.actionable.length === 0) {
    return {
      ...base, ok: false, refusalCode: 'nothing_actionable',
      summary: blastRadiusSentence(radius, {
        term: p.term, marketplace: p.marketplace, shareAgeDays: p.shareAgeDays,
        undoWindowHours: KT7_UNDO_WINDOW_HOURS, proposeOnly: false,
      }),
    }
  }

  // ── 2 · the ceiling, against the ledger as it stands NOW ─────────────────────────────────────
  const campaignIds = [...new Set(row.targets.map((t) => t.campaignId))]
  const ceilings = await ceilingsFor(row, campaignIds)
  const committed = await committedToday(p.marketplace)
  const commitment = commitmentCents(radius.actionable.length, p.requestedBidCents)
  const ceiling = checkCeiling(
    resolveCeiling({
      campaignId: campaignIds.length === 1 ? campaignIds[0] : null,
      portfolioId: row.portfolioIds.length === 1 ? row.portfolioIds[0] : null,
      lineId: row.lineIds.length === 1 ? row.lineIds[0] : null,
      marketplace: p.marketplace,
    }, ceilings),
    committed,
    commitment,
  )
  if (ceiling.verdict === 'REFUSED') {
    return { ...base, ok: false, refusalCode: 'ceiling_refused', summary: ceiling.message }
  }

  // ── 5 · is any target's campaign currently bid-suppressed? ───────────────────────────────────
  const suppressedCampaigns = await prisma.campaign.findMany({
    where: { id: { in: campaignIds }, bidsSuppressedAt: { not: null } },
    select: { id: true, name: true, bidsSuppressedAt: true },
  })
  const suppressedIds = new Set(suppressedCampaigns.map((c) => c.id))

  // ── the write ────────────────────────────────────────────────────────────────────────────────
  // One id for the whole apply. The mutation service stores it as AdvertisingActionLog.executionId,
  // and the existing per-change undo reverses the entire set when it sees one.
  const changeSetId = `kt7-${p.id}`
  const actor: AdsActor = `user:${args.actorEmail ?? 'operator'}`
  const reason = args.reason ?? `Keyword Tracker: set "${p.term}" to ${(p.requestedBidCents / 100).toFixed(2)} EUR`

  const targets = args.maxTargets != null ? radius.actionable.slice(0, args.maxTargets) : radius.actionable
  const capped = args.maxTargets != null && radius.actionable.length > args.maxTargets

  const rows: Kt7RowOutcome[] = []
  let applied = 0, refused = 0, skipped = 0
  let undoHandle: string | null = null

  for (const t of targets) {
    const rowBase = { adTargetId: t.id, campaignName: t.campaignName, fromCents: t.bidCents, toCents: p.requestedBidCents }

    if (suppressedIds.has(t.campaignId)) {
      rows.push({ ...rowBase, outcome: 'REFUSED', code: 'campaign_suppressed', reason: `${t.campaignName} is currently bid-suppressed — the next resume would restore this target from its remembered bid and overwrite this change` })
      refused++
      continue
    }
    // Belt and braces: the radius already excluded these unless opted in, but this is the write, and
    // a raise on a suppressed target destroys the only evidence of what it was.
    if (!args.includeSuppressed && t.bidCents != null && t.bidCents <= KT6_SUPPRESSION_CENTS) {
      rows.push({ ...rowBase, outcome: 'REFUSED', code: 'suppressed_target', reason: `bids ${(t.bidCents / 100).toFixed(2)} EUR, at or under the suppression convention — raising it would switch delivery back on` })
      refused++
      continue
    }

    try {
      const r = await updateAdTargetWithSync({
        adTargetId: t.id,
        patch: { bidCents: p.requestedBidCents },
        actor,
        reason,
        applyImmediately: true,
        changeSetId,
        // 🔴 no `force`. force bypasses the 5¢ floor and the change-clamp, and exists for the
        // suppression path's deliberate 2¢ writes. An operator bid change is an ordinary write and
        // must be bound by the same clamps every other engine is.
      })
      if (r.ok) {
        applied++
        undoHandle = undoHandle ?? r.actionLogId
        rows.push({ ...rowBase, outcome: 'APPLIED', actionLogId: r.actionLogId })
      } else {
        // The write gate lives downstream in ads-sync.worker.ts; a refusal there surfaces as an
        // error here rather than a silent success, which is why this is REFUSED and not SKIPPED.
        refused++
        rows.push({ ...rowBase, outcome: 'REFUSED', code: 'write_failed', reason: r.error ?? 'the write was not accepted' })
      }
    } catch (e) {
      refused++
      rows.push({ ...rowBase, outcome: 'REFUSED', code: 'write_failed', reason: (e as Error).message })
      logger.warn('[kt7] apply threw for one target', { adTargetId: t.id, error: (e as Error).message })
    }
  }

  // Everything the radius excluded is SKIPPED — counted, named, never hidden.
  skipped = radius.excluded.length + (capped ? radius.actionable.length - targets.length : 0)

  await prisma.keywordBidProposal.update({
    where: { id: p.id },
    data: {
      status: applied > 0 ? 'APPLIED' : 'REFUSED',
      decidedAt: new Date(),
      decidedBy: args.actorEmail ?? null,
      executionId: changeSetId,
      // The ledger's "committed today" counts APPLIED rows, so it must reflect what actually landed
      // rather than what was proposed — otherwise a partly-refused apply overstates the commitment.
      commitmentCents: commitmentCents(applied, p.requestedBidCents),
    },
  }).catch(() => {})

  const age = await shareAge(p.marketplace)
  return {
    ...base,
    ok: applied > 0,
    changeSetId,
    applied, refused, skipped,
    rows,
    undoHandleActionLogId: undoHandle,
    summary: applySummary({
      term: p.term, marketplace: p.marketplace, bidCents: p.requestedBidCents,
      applied, refused, skipped, capped, cappedTo: targets.length,
      radiusExcluded: radius.byReason, suppressedCampaigns: suppressedCampaigns.length,
      shareAgeDays: age.days, shareWeekLabel: age.label, ceilingMessage: ceiling.message,
      ceilingVerdict: ceiling.verdict,
    }),
  }
}

/**
 * The sentence after the write. D4: what it DID, to how many, what it did not do and why, how old the
 * evidence was, and how long it can be undone.
 *
 * Past tense throughout, and deliberately different wording from the pre-write confirmation — an
 * operator who cannot tell "this is what will happen" from "this is what happened" cannot tell whether
 * they have already spent the money.
 */
export function applySummary(a: {
  term: string
  marketplace: string
  bidCents: number
  applied: number
  refused: number
  skipped: number
  capped: boolean
  cappedTo: number
  radiusExcluded: Record<string, number>
  suppressedCampaigns: number
  shareAgeDays: number | null
  shareWeekLabel: string | null
  ceilingMessage: string
  ceilingVerdict: string
}): string {
  const eur = (c: number) => `€${(c / 100).toFixed(2)}`
  const parts: string[] = []

  if (a.applied === 0) {
    parts.push(`Nothing was changed for “${a.term}” in ${a.marketplace}. ${a.refused} write${a.refused === 1 ? '' : 's'} ${a.refused === 1 ? 'was' : 'were'} refused.`)
  } else {
    parts.push(`Set the bid to ${eur(a.bidCents)} on ${a.applied} target${a.applied === 1 ? '' : 's'} for “${a.term}” in ${a.marketplace}.`)
  }

  if (a.capped) {
    parts.push(`This was deliberately limited to ${a.cappedTo} target${a.cappedTo === 1 ? '' : 's'} — the smallest reversible change that proves the path works before it is used at full width.`)
  }
  if (a.refused > 0) {
    parts.push(`${a.refused} ${a.refused === 1 ? 'was' : 'were'} refused, each with its own reason listed below.`)
  }
  if (a.suppressedCampaigns > 0) {
    parts.push(`${a.suppressedCampaigns} campaign${a.suppressedCampaigns === 1 ? ' is' : 's are'} currently bid-suppressed, so ${a.suppressedCampaigns === 1 ? 'its' : 'their'} targets were left alone — the next resume would restore them from their remembered bids and overwrite anything written now.`)
  }
  const nw = a.radiusExcluded.not_write_enabled ?? 0
  if (nw > 0) {
    parts.push(`${nw} target${nw === 1 ? '' : 's'} in campaigns that are not write-enabled ${nw === 1 ? 'was' : 'were'} never eligible — that is the account's default-deny allowlist, not a failure here.`)
  }
  const sup = (a.radiusExcluded.suppressed_flag ?? 0) + (a.radiusExcluded.suppressed_by_bid ?? 0)
  if (sup > 0) {
    parts.push(`${sup} suppressed target${sup === 1 ? '' : 's'} ${sup === 1 ? 'was' : 'were'} left at ${eur(2)}-ish on purpose; raising one would switch delivery back on and this page will not do that without being asked.`)
  }
  if (a.ceilingVerdict !== 'NO_CEILING') parts.push(a.ceilingMessage)
  if (a.shareAgeDays != null) {
    const week = a.shareWeekLabel ? `the Brand Analytics week of ${a.shareWeekLabel}, which ended` : 'a Brand Analytics week that ended'
    parts.push(`The share figure behind this decision came from ${week} ${a.shareAgeDays} days ago.`)
  }
  if (a.applied > 0) {
    parts.push(`All ${a.applied} change${a.applied === 1 ? '' : 's'} can be undone together in one action for the next ${KT7_UNDO_WINDOW_HOURS} hours.`)
  }
  return parts.join(' ')
}
