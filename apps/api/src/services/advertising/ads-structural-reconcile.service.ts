import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * AX-VT.5 — structural reconcile, on a schedule.
 *
 * AX-VT.4 verifies a launch at the moment it happens. That catches the launch that lands wrong; it
 * cannot catch the account that DRIFTS afterwards, and every defect this engagement found was
 * found by hand:
 *
 *   · 62 campaigns holding a portfolio Amazon knew nothing about — weeks
 *   · 19 SD/SB campaigns archived locally while alive on Amazon — months
 *   · 169 AdDrift rows for biddingStrategy that nobody had read
 *
 * So this runs the same comparison across the whole account, on a cron, and reports into the
 * integrity snapshot that already surfaces on /api/health — where somebody is already looking.
 *
 * ── What it repairs, and what it deliberately does not ──────────────────────────────────────
 *
 * ONLY portfolio membership is auto-repaired, and only in the MISSING_ON_AMAZON direction
 * (we hold a portfolio, Amazon holds none). That case has exactly one correct resolution: the
 * operator asked for it in Nexus and the write never landed, so pushing restores their intent.
 *
 * Everything else is RECORDED, not fixed. A bid of 0.50 locally and 0.32 on Amazon could be
 * Amazon's optimiser, a failed write, or a human in Seller Central, and auto-pushing would pick a
 * fight with whichever of those is right. A reconciler that guesses on ambiguous state is worse
 * than one that reports it — it manufactures churn and hides the real question.
 *
 * Findings land in `AdDrift`, keyed (entityType, entityId, field) like every other drift row, so a
 * campaign wrong for three days is one row with a high occurrence count rather than one per run.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { verifyLaunch } from './ads-launch-verify.service.js'
import { verifyCampaignPortfolios } from './ads-create.service.js'
import { assessEntities, emptyEvidence, neverSent, rowsToClose, type DriftEvidence, type DriftFinding } from '../ads-core/drift-resolution.js'

/**
 * Fields this reconcile opens drift rows for. STRUCTURE — not bids (`BID_FIELDS` in drift-resolution).
 *
 * Measured on the first prod run over 5 legacy campaigns: 198 entities produced 107 mismatches, and
 * 102 of them were `bid` (local €0.50 against Amazon's real €2.00 on 2024-era campaigns whose bids
 * were set in Seller Central). Every one is genuine drift, correctly classified EXTERNAL_CHANGE —
 * and recording them would have buried the two findings that actually mattered: keywords saved
 * locally that never reached Amazon.
 *
 * Bids already have an owner. `ads-write-reconcile.service.ts` sweeps them, the rank engine
 * re-evaluates hourly, and this service explicitly refuses to auto-repair them because the correct
 * resolution is ambiguous. Opening hundreds of rows nobody will act on is how a drift list becomes
 * a graveyard — the same lesson as the 135 false targetingType rows on ZD.4's first run.
 *
 * Bid deltas are still COMPARED and still counted in the returned summary, so the number is visible;
 * they just don't become tracked rows. Suppression is reported, never silent.
 */
const DRIFT_RECORD_FIELDS = new Set([
  'existence', 'state', 'name', 'dailyBudget', 'portfolioId',
  'targetingType', 'biddingStrategy', 'matchType', 'keywordText', 'value', 'sku',
])

/** Open drift rows read per query in the resolve pass; the id list goes into one `IN`. */
const RESOLVE_CHUNK = 1000

/**
 * Campaigns per verification batch.
 *
 * Not a rate-limit concern — each batch is a fixed handful of list calls whatever its size — but a
 * page-count one: one batch of 200 campaigns can drag ~14 pages of product ads through a single
 * call chain, and a failure anywhere loses the whole batch. Forty keeps a failure cheap.
 */
const BATCH = 40

export interface StructuralReconcileResult {
  ok: boolean
  campaignsChecked: number
  campaignsTruncated: number
  entitiesChecked: number
  verified: number
  mismatch: number
  missingOnAmazon: number
  notPushed: number
  uncovered: number
  driftRowsOpened: number
  driftRowsResolved: number
  /**
   * Bid/defaultBid disagreements seen but deliberately not turned into drift rows — the bid path
   * owns those. Surfaced so the suppression is a reported number rather than a silent policy.
   */
  bidDeltasNotRecorded: number
  /**
   * S3 — entities archived here that never reached Amazon. Counted in `notPushed` (the launch verifier's number) but
   * treated as agreement: no drift row, and an open `existence` row for them closes. Reported, not silent.
   */
  archivedNeverSent: number
  portfoliosRepaired: number
  errors: string[]
}

export async function runStructuralReconcileOnce(opts: {
  marketplace?: string
  /** Auto-repair portfolio membership. Default true — it is the one unambiguous case. */
  repairPortfolios?: boolean
  /** Hard ceiling on campaigns per run. Truncation is REPORTED, never silent. */
  limit?: number
} = {}): Promise<StructuralReconcileResult> {
  const out: StructuralReconcileResult = {
    ok: true, campaignsChecked: 0, campaignsTruncated: 0, entitiesChecked: 0,
    verified: 0, mismatch: 0, missingOnAmazon: 0, notPushed: 0, uncovered: 0,
    driftRowsOpened: 0, driftRowsResolved: 0, bidDeltasNotRecorded: 0, archivedNeverSent: 0, portfoliosRepaired: 0, errors: [],
  }
  const limit = opts.limit ?? 400
  // Before the first Amazon read. A row another writer re-detects after this is newer evidence than anything this run
  // read, so the run may not close it (closeAgreeingRows).
  const runStart = new Date()

  const where = {
    externalCampaignId: { not: null },
    status: { not: 'ARCHIVED' as const },
    ...(opts.marketplace ? { marketplace: opts.marketplace } : {}),
  }
  const total = await prisma.campaign.count({ where })
  const campaigns = await prisma.campaign.findMany({
    where, select: { id: true },
    // Oldest-verified first, so a truncated run rotates through the account across runs instead of
    // re-checking the same head every time and never reaching the tail.
    orderBy: { settingsSyncedAt: { sort: 'asc', nulls: 'first' } },
    take: limit,
  })
  out.campaignsChecked = campaigns.length
  out.campaignsTruncated = Math.max(0, total - campaigns.length)
  if (out.campaignsTruncated > 0) {
    logger.warn('[AX-VT.5] run truncated — some campaigns not checked this pass', {
      checked: campaigns.length, skipped: out.campaignsTruncated, limit,
    })
  }
  if (!campaigns.length) return out

  // What this run compared and what it saw differ, across all its batches — the only grounds for closing a row.
  const evidence = emptyEvidence()

  for (let i = 0; i < campaigns.length; i += BATCH) {
    const batch = campaigns.slice(i, i + BATCH).map((c) => c.id)
    let v
    try {
      // 'RECONCILE' so the audit row is not mistaken for an operator's launch — see VerifySource.
      v = await verifyLaunch(batch, 'RECONCILE')
    } catch (e) {
      out.ok = false
      out.errors.push(`batch ${i / BATCH}: ${(e as Error).message.slice(0, 140)}`)
      continue
    }
    out.entitiesChecked += v.total
    out.verified += v.verified
    out.mismatch += v.mismatch
    out.missingOnAmazon += v.missingOnAmazon
    out.notPushed += v.notPushed
    out.uncovered += v.uncovered
    if (v.errors.length) { out.ok = false; out.errors.push(...v.errors.slice(0, 5)) }

    // Every difference is folded into `evidence` before any row is written, so a bid delta (never recorded) and a
    // row whose save throws both keep their key out of the resolve pass below.
    const { record, bidDeltas, archivedNeverSent } = assessEntities(v.entities, evidence)
    out.bidDeltasNotRecorded += bidDeltas
    out.archivedNeverSent += archivedNeverSent
    for (const d of record) {
      // An unrecognised field is recorded rather than dropped: a new comparison added later
      // should default to visible, not silently ignored.
      if (!DRIFT_RECORD_FIELDS.has(d.field)) {
        logger.info('[AX-VT.5] recording drift for an unlisted field', { field: d.field })
      }
      try {
        out.driftRowsOpened += await openDrift(d)
      } catch (err) {
        out.errors.push(`drift ${d.entity.label}/${d.field}: ${(err as Error).message.slice(0, 90)}`)
      }
    }

    // Repair the one unambiguous class, scoped to this batch.
    if (opts.repairPortfolios !== false && v.entities.some((e) => e.entityType === 'CAMPAIGN' && e.deltas.some((d) => d.field === 'portfolioId'))) {
      try {
        const r = await verifyCampaignPortfolios({ campaignIds: batch, dryRun: false })
        out.portfoliosRepaired += r.repaired
        if (r.repairFailed) out.errors.push(`portfolio repair failed for ${r.repairFailed} campaign(s)`)
      } catch (e) {
        out.errors.push(`portfolio repair: ${(e as Error).message.slice(0, 120)}`)
      }
    }
  }

  // Close rows this run found to agree again: every entity type it compared, not only campaigns, and only the
  // fields it actually compared (drift-resolution.ts). An entity or field it never looked at keeps its row.
  //
  // Only closed when the run was otherwise clean: if a read failed we do not know the values agree,
  // and resolving on ignorance is how a drift list quietly empties itself while the problem stands.
  if (out.ok) {
    try {
      out.driftRowsResolved = await closeAgreeingRows(evidence, out.ok, runStart)
    } catch (e) {
      out.errors.push(`resolve pass: ${(e as Error).message.slice(0, 120)}`)
    }
  }

  logger.info('[AX-VT.5] structural reconcile', { ...out, errors: out.errors.length })
  if (out.mismatch || out.missingOnAmazon || out.notPushed) {
    logger.warn('[AX-VT.5] account does not match our records', {
      mismatch: out.mismatch, missingOnAmazon: out.missingOnAmazon, notPushed: out.notPushed,
      portfoliosRepaired: out.portfoliosRepaired,
    })
  }
  return out
}

/**
 * Reads this profile's open rows for the compared entities, a chunk at a time, and closes the ones the evidence allows.
 *
 * Only rows last detected before the run started: the 20-minute settings sync (or the portfolio sync) may re-detect a
 * row with a fresh delta while this run is still going, and this run's earlier read must not close it. The guard sits
 * in the UPDATE itself, so it also covers a re-detection between the read of the open rows and the close.
 */
async function closeAgreeingRows(evidence: DriftEvidence, runOk: boolean, runStart: Date): Promise<number> {
  let closed = 0
  for (const [entityType, byId] of evidence.compared) {
    const ids = [...byId.keys()]
    for (let i = 0; i < ids.length; i += RESOLVE_CHUNK) {
      const open = await prisma.adDrift.findMany({
        where: { resolvedAt: null, entityType, entityId: { in: ids.slice(i, i + RESOLVE_CHUNK) } },
        select: { id: true, entityType: true, entityId: true, field: true },
      })
      const agree = rowsToClose(runOk, evidence, open)
      if (!agree.length) continue
      const res = await prisma.adDrift.updateMany({
        where: { id: { in: agree }, resolvedAt: null, lastDetectedAt: { lt: runStart } },
        data: { resolvedAt: new Date() },
      })
      closed += res.count
    }
  }
  return closed
}

async function openDrift(d: DriftFinding): Promise<number> {
  const { entityType, entity: e, field, intended, observed } = d
  const { classifyDrift } = await import('../ads-core/drift.js')
  // Local write history lives on Campaign; for child entities we have no per-entity stamp, so the
  // classification falls back to EXTERNAL_CHANGE rather than inventing a write time.
  const camp = entityType === 'CAMPAIGN'
    ? await prisma.campaign.findUnique({ where: { id: e.localId }, select: { marketplace: true, lastSyncedAt: true, lastSyncStatus: true } })
    : null
  // S3 — except a live entity we never sent: that is our write that never landed, whatever the timestamps say.
  const classification = neverSent(d) ? 'WRITE_FAILED' : classifyDrift({
    ours: intended, theirs: observed,
    lastWriteAt: camp?.lastSyncedAt ?? null,
    lastWriteStatus: camp?.lastSyncStatus ?? null,
  })
  const now = new Date()
  const existing = await prisma.adDrift.findUnique({
    where: { entityType_entityId_field: workspaceKey({ entityType, entityId: e.localId, field }) },
    select: { id: true, resolvedAt: true },
  })
  await prisma.adDrift.upsert({
    where: { entityType_entityId_field: workspaceKey({ entityType, entityId: e.localId, field }) },
    create: {
      entityType, entityId: e.localId, externalId: e.externalId,
      marketplace: camp?.marketplace ?? null, entityName: e.label,
      field, ourValue: intended, amazonValue: observed, classification,
    },
    update: {
      ourValue: intended, amazonValue: observed, classification,
      lastDetectedAt: now, occurrences: { increment: 1 }, resolvedAt: null,
    },
  })
  // "Opened" counts genuinely new or re-opened rows, so the number means something.
  return !existing || existing.resolvedAt ? 1 : 0
}
