/**
 * AF.1d — de-duplicate campaigns split by marketplace representation.
 *
 * Every Amazon campaign exists TWICE in our DB: one row with the Amazon
 * marketplace id (A1PA6795UKMFR9 — carries the ad-spend metrics), one with the
 * short code (DE — carries the keywords the v1 structure sync wrote). The data
 * is split across the pair, so the campaign the operator views looks wrong.
 *
 * Fix: per externalCampaignId, keep the SURVIVOR (the copy referenced by the
 * daily-performance metrics — tie-break to the Amazon-id row), MOVE the other
 * copies' ad groups / targets / product-ads into it (dedupe by external id),
 * delete the duplicates, and normalise the survivor's marketplace to the short
 * code so the sync reuses it instead of re-creating a duplicate. Idempotent;
 * supports dryRun.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export interface DedupeResult {
  dryRun: boolean
  duplicateGroups: number
  campaignsDeleted: number
  adGroupsReparented: number
  targetsMoved: number
  productAdsMoved: number
  marketplacesNormalised: number
}

function isAmazonId(mp: string | null | undefined): boolean {
  return !!mp && mp.length > 6 && /^A[A-Z0-9]+$/.test(mp)
}

export async function dedupeCampaigns(opts: { dryRun?: boolean } = {}): Promise<DedupeResult> {
  const dryRun = opts.dryRun ?? true
  const res: DedupeResult = { dryRun, duplicateGroups: 0, campaignsDeleted: 0, adGroupsReparented: 0, targetsMoved: 0, productAdsMoved: 0, marketplacesNormalised: 0 }
  const { normalizeMarketplaceCode } = await import('../../utils/marketplace-code.js')

  const campaigns = await prisma.campaign.findMany({ where: { externalCampaignId: { not: null } }, select: { id: true, externalCampaignId: true, marketplace: true } })
  const byExt = new Map<string, typeof campaigns>()
  for (const c of campaigns) { const k = c.externalCampaignId!; const arr = byExt.get(k) ?? []; arr.push(c); byExt.set(k, arr) }

  // daily-perf row counts per campaign localEntityId → pick the metrics-bearing survivor.
  const perf = await prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId'], where: { entityType: 'CAMPAIGN', localEntityId: { not: null } }, _count: { _all: true } })
  const perfByCamp = new Map(perf.map((p) => [p.localEntityId!, p._count._all]))

  for (const [, copies] of byExt) {
    if (copies.length < 2) continue
    res.duplicateGroups += 1
    // Survivor: most metrics rows; tie-break the Amazon-id row; then first.
    const survivor = [...copies].sort((a, b) =>
      (perfByCamp.get(b.id) ?? 0) - (perfByCamp.get(a.id) ?? 0)
      || (isAmazonId(b.marketplace) ? 1 : 0) - (isAmazonId(a.marketplace) ? 1 : 0),
    )[0]
    const dups = copies.filter((c) => c.id !== survivor.id)

    const survAgs = await prisma.adGroup.findMany({ where: { campaignId: survivor.id }, select: { id: true, externalAdGroupId: true, targets: { select: { externalTargetId: true } }, productAds: { select: { asin: true } } } })
    const survAgByExt = new Map(survAgs.map((g) => [g.externalAdGroupId ?? '', g]))

    for (const dup of dups) {
      const dupAgs = await prisma.adGroup.findMany({ where: { campaignId: dup.id }, select: { id: true, externalAdGroupId: true, targets: { select: { id: true, externalTargetId: true } }, productAds: { select: { id: true, asin: true } } } })
      for (const dupAg of dupAgs) {
        const survAg = survAgByExt.get(dupAg.externalAdGroupId ?? '')
        if (!survAg) {
          // Survivor lacks this ad group — re-parent the whole ad group.
          if (!dryRun) await prisma.adGroup.update({ where: { id: dupAg.id }, data: { campaignId: survivor.id } })
          res.adGroupsReparented += 1
          continue
        }
        const survTargets = new Set(survAg.targets.map((t) => t.externalTargetId))
        const moveTargets = dupAg.targets.filter((t) => t.externalTargetId && !survTargets.has(t.externalTargetId)).map((t) => t.id)
        if (moveTargets.length) { if (!dryRun) await prisma.adTarget.updateMany({ where: { id: { in: moveTargets } }, data: { adGroupId: survAg.id } }); res.targetsMoved += moveTargets.length }
        const survAds = new Set(survAg.productAds.map((a) => a.asin))
        const moveAds = dupAg.productAds.filter((a) => a.asin && !survAds.has(a.asin)).map((a) => a.id)
        if (moveAds.length) { if (!dryRun) await prisma.adProductAd.updateMany({ where: { id: { in: moveAds } }, data: { adGroupId: survAg.id } }); res.productAdsMoved += moveAds.length }
      }
      // Delete the duplicate campaign (cascades its now-redundant ad groups/targets).
      if (!dryRun) await prisma.campaign.delete({ where: { id: dup.id } }).catch((e) => logger.warn('[dedupe] delete failed', { id: dup.id, error: String(e).slice(0, 120) }))
      res.campaignsDeleted += 1
    }
    const code = normalizeMarketplaceCode(survivor.marketplace)
    if (code && code !== 'UNKNOWN' && code !== survivor.marketplace) {
      if (!dryRun) await prisma.campaign.update({ where: { id: survivor.id }, data: { marketplace: code } })
      res.marketplacesNormalised += 1
    }
  }
  logger.info('[ads-dedupe] complete', { ...res })
  return res
}
