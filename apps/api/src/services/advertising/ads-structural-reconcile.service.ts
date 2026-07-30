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
import type { LaunchEntityResult } from '../ads-core/launch-verify.js'

/** Local entity kind → the entityType string AdDrift already uses elsewhere. */
const DRIFT_ENTITY_TYPE: Record<LaunchEntityResult['entityType'], string> = {
  CAMPAIGN: 'CAMPAIGN', AD_GROUP: 'AD_GROUP',
  KEYWORD: 'AD_TARGET', TARGET: 'AD_TARGET', PRODUCT_AD: 'PRODUCT_AD',
}

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
    driftRowsOpened: 0, driftRowsResolved: 0, portfoliosRepaired: 0, errors: [],
  }
  const limit = opts.limit ?? 400

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

  const seenKeys = new Set<string>()

  for (let i = 0; i < campaigns.length; i += BATCH) {
    const batch = campaigns.slice(i, i + BATCH).map((c) => c.id)
    let v
    try {
      v = await verifyLaunch(batch)
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

    for (const e of v.entities) {
      if (e.verdict === 'VERIFIED') continue
      const entityType = DRIFT_ENTITY_TYPE[e.entityType]
      // A verdict with no per-field delta (NOT_PUSHED / MISSING_ON_AMAZON) is recorded against a
      // synthetic `existence` field so it gets a row of its own rather than being invisible.
      const deltas = e.deltas.length ? e.deltas : [{ field: 'existence', intended: 'on Amazon', observed: e.verdict === 'NOT_PUSHED' ? 'never sent' : 'not returned' }]
      for (const d of deltas) {
        try {
          out.driftRowsOpened += await openDrift(entityType, e, d.field, d.intended, d.observed)
          seenKeys.add(`${entityType}|${e.localId}|${d.field}`)
        } catch (err) {
          out.errors.push(`drift ${e.label}/${d.field}: ${(err as Error).message.slice(0, 90)}`)
        }
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

  // Close rows for entities this run found to agree again. Scoped to the entities actually checked
  // — a truncated run must not resolve drift for a campaign it never looked at.
  //
  // Only closed when the run was otherwise clean: if a read failed we do not know the values agree,
  // and resolving on ignorance is how a drift list quietly empties itself while the problem stands.
  if (out.ok) {
    try {
      const checkedIds = campaigns.map((c) => c.id)
      const open = await prisma.adDrift.findMany({
        where: { resolvedAt: null, entityType: 'CAMPAIGN', entityId: { in: checkedIds } },
        select: { id: true, entityType: true, entityId: true, field: true },
      })
      const stale = open.filter((r) => !seenKeys.has(`${r.entityType}|${r.entityId}|${r.field}`)).map((r) => r.id)
      if (stale.length) {
        const res = await prisma.adDrift.updateMany({ where: { id: { in: stale } }, data: { resolvedAt: new Date() } })
        out.driftRowsResolved = res.count
      }
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

async function openDrift(
  entityType: string,
  e: LaunchEntityResult,
  field: string,
  intended: string | null,
  observed: string | null,
): Promise<number> {
  const { classifyDrift } = await import('../ads-core/drift.js')
  // Local write history lives on Campaign; for child entities we have no per-entity stamp, so the
  // classification falls back to EXTERNAL_CHANGE rather than inventing a write time.
  const camp = entityType === 'CAMPAIGN'
    ? await prisma.campaign.findUnique({ where: { id: e.localId }, select: { marketplace: true, lastSyncedAt: true, lastSyncStatus: true } })
    : null
  const classification = classifyDrift({
    ours: intended, theirs: observed,
    lastWriteAt: camp?.lastSyncedAt ?? null,
    lastWriteStatus: camp?.lastSyncStatus ?? null,
  })
  const now = new Date()
  const existing = await prisma.adDrift.findUnique({
    where: { entityType_entityId_field: { entityType, entityId: e.localId, field } },
    select: { id: true, resolvedAt: true },
  })
  await prisma.adDrift.upsert({
    where: { entityType_entityId_field: { entityType, entityId: e.localId, field } },
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
